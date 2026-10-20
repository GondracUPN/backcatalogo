import 'reflect-metadata';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { ProductPhotoSafety1792454400000 } from '../migrations/1792454400000-ProductPhotoSafety';
import { ProductPhotosService, cloudImageId } from '../modules/catalog-admin/product-photos.service';
import { ProductPhotosController } from '../modules/catalog-admin/product-photos.controller';

async function main() {
  // Real PostgreSQL SQL/PLpgSQL in isolated WASM memory. No .env, network, CDN
  // or production data. Advisory locks and file transport alone are mocked.
  const pg = new PGlite();
  const events: string[] = [];
  let failUpdate = false, failDelete = false, lockAvailable = true;
  const query = async (sql: string, params: any[] = []) => {
    if (sql.includes('pg_try_advisory_lock')) return [{locked:lockAvailable}];
    if (sql.includes('pg_advisory_unlock')) return [];
    if (failUpdate && sql.startsWith('UPDATE catalog_public')) throw new Error('simulated database failure');
    return (await pg.query(sql,params)).rows as any[];
  };
  const manager = {query};
  const db = {manager,query, transaction:async (fn: any) => {
    await query('BEGIN');
    try {const result=await fn(manager);await query('COMMIT');events.push('commit');return result;}
    catch(e){await query('ROLLBACK');events.push('rollback');throw e;}
  },createQueryRunner:()=>({connect:async()=>{},release:async()=>{},query})};
  const service = new ProductPhotosService(db as any);
  (service as any).internal = async (path: string) => {
    if (path.includes('delete-file')) {events.push('delete');if(failDelete)throw new Error('simulated file failure');}
    else events.push('revalidate');
  };
  await pg.exec(`
    CREATE TABLE products(id uuid PRIMARY KEY,sku text,status text,stock int,presentation text,updated_at timestamptz DEFAULT now());
    CREATE TABLE staged_products(id uuid PRIMARY KEY,source_id uuid,sku text,images jsonb,notes text,variant_group text,status text,stock int,presentation text,owner_user_id int,updated_at timestamptz DEFAULT now());
    CREATE TABLE catalog_public(id uuid PRIMARY KEY,product_id uuid,images jsonb,updated_at timestamptz DEFAULT now());
    CREATE TABLE sold_records(id uuid DEFAULT gen_random_uuid(),product_id uuid,sku text,sold_at timestamptz,client_photo_url text,product_image_url text);
    CREATE TABLE possible_clients(product_id uuid,product_image_url text,client_photo_url text);
    CREATE TABLE site_themes(banner jsonb);
    CREATE TABLE catalog_settings(value jsonb);
  `);
  const migration = new ProductPhotoSafety1792454400000();
  await migration.up({query} as any);
  const id='aaaaaaaa-1111-4111-8111-111111111111', other='bbbbbbbb-1111-4111-8111-111111111111';
  const cover='/uploads/wm-cover.png', second='/uploads/wm-second.png', third='/uploads/wm-third.png', next='/uploads/wm-new.png';
  const staff={role:'ADMIN',sub:1} as any;
  async function reset(age=61) {
    failUpdate=false;failDelete=false;events.length=0;
    await pg.exec('TRUNCATE products,staged_products,catalog_public,sold_records,possible_clients,site_themes,catalog_settings,photo_change_log,photo_url_rules');
    await query(`INSERT INTO products(id,sku,status,stock,presentation) VALUES($1,'MS-test','sold',0,'abierto')`,[id]);
    await query(`INSERT INTO staged_products(id,source_id,sku,images,status,stock,presentation) VALUES($1,$1,'MS-test',$2,'sold',0,'abierto')`,[id,JSON.stringify([cover,second,third])]);
    await query(`INSERT INTO catalog_public(id,product_id,images) VALUES($1,$1,$2)`,[id,JSON.stringify([cover,second,third])]);
    await query(`INSERT INTO sold_records(product_id,sku,sold_at,product_image_url) VALUES($1,'MS-test',now()-($2::int*interval '1 day'),$3)`,[id,age,cover]);
  }
  const images=async()=> (await query('SELECT images FROM catalog_public'))[0].images;
  await reset();
  const cleaned=await service.cleanup(id,false,'system');assert.equal(cleaned.removed,2);assert.deepEqual(await images(),[cover]);
  assert.ok(events.indexOf('commit')<events.indexOf('delete'));assert.ok(events.indexOf('delete')<events.indexOf('revalidate'));
  events.length=0;await service.cleanup(id,false,'system');assert.ok(!events.includes('delete'),'second run idempotent');
  await reset(59);await service.cleanup(id,false,'system');assert.equal((await images()).length,3);
  await reset();await query('DELETE FROM sold_records');await service.cleanup(id,false,'system');assert.equal((await images()).length,3,'no reliable sale date');
  await service.cleanup(id,true,'1');assert.equal((await images()).length,3,'manual also requires a reliable date');
  await reset();await query("UPDATE products SET status='hidden'");await service.cleanup(id,false,'system');assert.deepEqual(await images(),[cover],'hidden sold item retains cover');
  await reset();await query("UPDATE staged_products SET presentation='sellado'");
  await service.cleanup(id,false,'system');await service.cleanup(id,true,'1');assert.equal((await images()).length,3,'sealed even manually');
  await reset();await service.hold(id,true,'Reclamación de prueba',staff);await service.cleanup(id,false,'system');
  await assert.rejects(()=>service.cleanup(id,true,'1'),/retención/);assert.equal((await images()).length,3);
  assert.ok((await query("SELECT 1 FROM photo_change_log WHERE action='skip_hold'")).length);
  await service.hold(id,false,'',staff);await service.cleanup(id,true,'1');assert.deepEqual(await images(),[cover]);
  await reset();await service.cleanup(id,false,'system',true);assert.equal((await images()).length,3);assert.equal((await query('SELECT * FROM photo_change_log WHERE dry_run=true')).length,2);assert.ok(!events.includes('delete'));
  await reset();
  await query(`INSERT INTO staged_products(id,source_id,sku,images) VALUES($1,$1,'other',$2)`,[other,JSON.stringify([second])]);
  await service.cleanup(id,true,'1');assert.deepEqual(await images(),[cover]);assert.equal(events.filter(e=>e==='delete').length,1,'shared second image retained');
  assert.equal((await query("SELECT action FROM photo_change_log WHERE url_old=$1",[second]))[0].action,'skip_shared');
  await reset();await service.replace(id,second,next,staff);assert.deepEqual(await images(),[cover,next,third]);
  await query('UPDATE staged_products SET images=$1,notes=$2',[JSON.stringify([cover,second,third]),JSON.stringify({photo:second,serial:'SYNTHETIC-123'})]);
  const [synced]=await query('SELECT images,notes FROM staged_products');assert.deepEqual(synced.images,[cover,next,third]);assert.equal(JSON.parse(synced.notes).photo,next);assert.equal(JSON.parse(synced.notes).serial,'SYNTHETIC-123');
  await service.replace(id,cover,'/uploads/wm-newcover.png',staff);assert.equal((await images())[0],'/uploads/wm-newcover.png');assert.equal((await query('SELECT product_image_url FROM sold_records'))[0].product_image_url,'/uploads/wm-newcover.png');
  await reset();failUpdate=true;await assert.rejects(()=>service.replace(id,second,next,staff),/database failure/);failUpdate=false;assert.deepEqual(await images(),[cover,second,third]);assert.ok(!events.includes('delete'));assert.equal((await query('SELECT * FROM photo_url_rules')).length,0);
  await reset();failDelete=true;await service.replace(id,second,next,staff);assert.deepEqual(await images(),[cover,next,third]);assert.equal((await query('SELECT pending FROM photo_change_log'))[0].pending,true);failDelete=false;await service.drain();assert.equal((await query('SELECT pending FROM photo_change_log'))[0].pending,false);
  await reset();
  const controller=new ProductPhotosController({verifyToken:()=>({role:'VENDEDOR',sub:7})} as any,service);
  assert.throws(()=>controller.cleanup('',id),(e:any)=>e.getStatus()===401);
  assert.throws(()=>controller.cleanup('Bearer test',id),(e:any)=>e.getStatus()===403);
  assert.throws(()=>controller.hold('Bearer test',id,{hold:true,reason:'test'}),(e:any)=>e.getStatus()===403);
  await assert.rejects(()=>service.replace(id,second,next,{role:'VENDEDOR',sub:7} as any),(e:any)=>e.getStatus()===403);
  const cloud='https://res.cloudinary.com/test/image/upload/c_fill,w_800/v123/macsomenos/productos/test.png';
  assert.equal(cloudImageId(cloud),'macsomenos/productos/test');
  await query('INSERT INTO site_themes(banner) VALUES($1)',[JSON.stringify({image:cloud})]);
  assert.equal(await service.isImageReferencedElsewhere(cloud.replace('c_fill,w_800/','')),true,'public_id detects transformed shared images');
  const env={...process.env};
  try {
    await reset();process.env.SOLD_PHOTO_CLEANUP_ENABLED='false';await service.daily();assert.equal((await images()).length,3);
    process.env.SOLD_PHOTO_CLEANUP_ENABLED='true';process.env.SOLD_PHOTO_CLEANUP_DRY_RUN='true';await service.daily();assert.equal((await images()).length,3);assert.ok((await query('SELECT * FROM photo_change_log WHERE dry_run')).length);
    process.env.SOLD_PHOTO_CLEANUP_DRY_RUN='false';lockAvailable=false;await service.daily();assert.equal((await images()).length,3,'another instance owns advisory lock');lockAvailable=true;
    await service.daily();assert.deepEqual(await images(),[cover]);
    // Two real keyset pages; batch 2 cannot be starved by skipped rows in batch 1.
    for(let n=1;n<=51;n++){
      const pid=`cccccccc-1111-4111-8111-${String(n).padStart(12,'0')}`;
      await query("INSERT INTO products(id,sku,status,stock,presentation) VALUES($1,$2,'sold',0,'abierto')",[pid,`BATCH-${n}`]);
      await query('INSERT INTO catalog_public(id,product_id,images) VALUES($1,$1,$2)',[pid,JSON.stringify([`/uploads/wm-cover${n}.png`,`/uploads/wm-secondary${n}.png`])]);
      await query("INSERT INTO sold_records(product_id,sku,sold_at) VALUES($1,$2,now()-interval '61 days')",[pid,`BATCH-${n}`]);
    }
    await service.daily();assert.equal((await query('SELECT 1 FROM catalog_public WHERE jsonb_array_length(images)>1')).length,0,'all 51 items processed across batches');
  } finally {process.env=env;}
  await migration.down({query} as any);
  assert.equal((await query("SELECT to_regclass('public.photo_change_log') AS name"))[0].name,null);
  await pg.close();
  console.log('product-photos.test.ts ok (PostgreSQL WASM; 61/59 days, no date, sealed, hold, shared, dry-run, idempotency, replace, sync trigger, rollback, retry, auth)');
}
main().catch(e=>{console.error(e);process.exit(1);});
