import { PullSyncService } from '../modules/sync/pull.service';
import assert from 'node:assert/strict';
import { SyncController } from '../modules/sync/sync.controller';
import { CatalogProduct } from '../entities/catalog-product.entity';
import { CatalogPublic } from '../entities/catalog-public.entity';
import { StagedProduct } from '../entities/staged-product.entity';
import { SyncLog } from '../entities/sync-log.entity';

async function main() {
  const stores = new Map<any, any[]>([CatalogProduct, CatalogPublic, StagedProduct, SyncLog].map((type) => [type, []]));
  const repo = (type: any) => ({
    findOne: async ({ where }: any) => stores.get(type)!.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)),
    create: (value: any) => value,
    save: async (value: any) => {
      const rows = stores.get(type)!; const old = rows.find((row) => type === CatalogPublic ? row.product_id === value.product_id : row.idem_key === value.idem_key);
      if (old) Object.assign(old, value); else rows.push(value); return value;
    },
    insert: async (value: any) => {
      const rows = stores.get(type)!;
      if (type === StagedProduct && rows.some((row) => row.source_id === value.source_id)) throw new Error('duplicate source_id');
      rows.push({ id: `staged-${rows.length + 1}`, ...value });
    },
    upsert: async (value: any, { conflictPaths }: any) => {
      const rows = stores.get(type)!; const old = rows.find((row) => conflictPaths.every((key: string) => row[key] === value[key]));
      if (old) Object.assign(old, value); else rows.push(value);
    },
    update: async (where: any, patch: any) => {
      stores.get(type)!.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)).forEach((row) => Object.assign(row, patch));
    },
  });
  let held = 0;
  const em = { getRepository: repo, query: async (sql: string) => sql.includes('to_regclass') ? [{ sales: 'sold_records', events: 'sale_sync_events' }] : sql.includes('count(*)') ? [{ qty: held }] : [] };
  const manager = { transaction: async (fn: any) => fn(em) };
  const controller = new SyncController({ ...repo(CatalogProduct), manager } as any, repo(SyncLog) as any, repo(StagedProduct) as any, repo(CatalogPublic) as any);
  const secret = process.env.CATALOG_SYNC_SECRET, testDb = process.env.MACSO_TEST_DATABASE_URL;
  process.env.CATALOG_SYNC_SECRET = 'accessory-test'; process.env.MACSO_TEST_DATABASE_URL = 'mock-only';
  const p: any = { sku: 'acc-ref-5-1234567890abcdef', title: 'Cable', accessoryCode: 374, price: '25', stock: 6, selected: true,
    images: ['https://img.test/cable.jpg'], costo: 999, specs: { valor: { costoTotal: 999 }, detalle: { descripcionOtro: 'USB-C' } } };
  try {
    await assert.rejects(controller.syncProduct('a', { event: 'accessory.snapshot', product: p }, 'incorrect'));
    const sync = (key: string) => controller.syncProduct(key, { event: 'accessory.snapshot', product: p }, 'accessory-test');
    const pull = new PullSyncService({} as any, {} as any);
    assert.equal((pull as any).stagedRowFromItem({ sku: 'MS-42', specs: { tipo: 'accesorios' } }), null);
    assert.equal((await controller.syncProduct('generic', { event: 'product.listed', product: { sku: 'MS-42', specs: { tipo: 'accesorios' } } }, 'accessory-test')).skipped, 'accessory_requires_explicit_selection');
    assert.equal((await sync('first')).accessorySnapshot, true);
    await sync('first'); await sync('repeat');
    assert.equal(stores.get(CatalogProduct)!.length, 1); assert.equal(stores.get(StagedProduct)!.length, 1);
    assert.equal(stores.get(CatalogPublic)!.length, 0, 'no publicación por sincronizar');
    const staged = stores.get(StagedProduct)![0];
    const product = stores.get(CatalogProduct)![0];
    assert.equal(JSON.parse(staged.notes).accessoryCode, 374);
    assert.equal(staged.status, 'draft'); assert.deepEqual(staged.images, []);
    assert.ok(!staged.notes.includes('999'));
    // Simula fotos y publicación explícitas hechas desde el panel del catálogo.
    staged.images = ['/uploads/wm-cable.jpg']; staged.status = 'published';
    staged.price = '40'; staged.sale_type = 'OFERTA'; staged.min_offer_price = '30';
    product.price = '40'; product.sale_type = 'OFERTA'; product.min_offer_price = '30';
    stores.get(CatalogPublic)!.push({ product_id: product.id, is_published: true, images: [...staged.images] });
    product.title = 'Accesorios'; staged.title = 'Accesorios';
    staged.notes = JSON.stringify({ ...JSON.parse(staged.notes), accessoryPack: { units: 6, price: 150, label: 'Caja' } });
    held = 2; p.price = '30'; await sync('price');
    assert.equal(product.title, 'Cable'); assert.equal(staged.title, 'Cable');
    assert.equal(product.stock, 4); assert.equal(product.price, '40');
    assert.equal(staged.sale_type, 'OFERTA'); assert.equal(staged.min_offer_price, '30');
    assert.deepEqual(JSON.parse(staged.notes).accessoryPack, { units: 6, price: 150, label: 'Caja' }, 'sincronizar stock conserva la presentación y su precio');
    assert.deepEqual(staged.images, ['/uploads/wm-cable.jpg']);
    assert.equal(stores.get(CatalogPublic)![0].is_published, true);
    staged.category = 'otros'; await sync('category');
    assert.equal(staged.category, 'otros', 'la sincronización respeta el Tipo elegido en publicar');
    staged.category = 'accesorios';
    p.stock = 0; await sync('empty'); assert.equal(product.stock, 0);
    p.selected = false; await sync('withdraw');
    assert.equal(stores.get(CatalogPublic)![0].is_published, false); assert.equal(staged.status, 'hidden');
    p.selected = true; p.stock = 8; held = 0; await sync('restore');
    assert.equal(product.stock, 8); assert.equal(staged.status, 'draft');
    assert.equal(stores.get(CatalogPublic)![0].is_published, false, 'volver a enviar no republica');
    // Una publicación automática antigua (status listed) se retira, sin borrar datos.
    stores.get(CatalogPublic)![0].is_published = true; staged.status = 'listed';
    await sync('old-auto'); assert.equal(stores.get(CatalogPublic)![0].is_published, false);
    stores.get(CatalogProduct)!.push({ id: 'old-lot', sku: 'MS-99', stock: 3, status: 'listed' });
    stores.get(StagedProduct)!.push({ id: 'old-stage', source_id: 'old-lot', sku: 'MS-99', notes: JSON.stringify({ tipo: 'accesorios', valor: { costoTotal: 99 } }) });
    stores.get(CatalogPublic)!.push({ product_id: 'old-lot', is_published: true });
    p.legacySkus = ['MS-99']; await sync('replace-old');
    assert.equal(stores.get(CatalogProduct)![1].stock, 0);
    assert.equal(stores.get(CatalogPublic)![1].is_published, false);
    assert.equal(stores.get(StagedProduct)![1].status, 'hidden');
    assert.equal(stores.get(CatalogProduct)!.length, 2);
    p.selected = false; p.sku = 'acc-lot-987'; await sync('never-selected');
    assert.equal(stores.get(CatalogProduct)!.length, 2, 'retirar uno no enviado no crea producto');
    // Caso de producción: la fila del SKU apunta a otro source_id. Debe actualizarse y revincularse, no insertarse.
    stores.get(StagedProduct)!.push({ id: 'desvinculada', source_id: 'otro-producto', sku: 'acc-lot-555', notes: null, images: [] });
    p.selected = true; p.stock = 2; p.sku = 'acc-lot-555'; await sync('relink');
    const relinked = stores.get(StagedProduct)!.filter((row) => row.sku === 'acc-lot-555');
    assert.equal(relinked.length, 1, 'no crea una segunda fila para el mismo SKU');
    assert.equal(relinked[0].id, 'desvinculada');
    assert.equal(relinked[0].source_id, stores.get(CatalogProduct)!.find((row) => row.sku === 'acc-lot-555').id, 'queda vinculada al producto');
    assert.equal(relinked[0].stock, 2);
    p.sku = 'svc-99'; await assert.rejects(sync('invalid'));
    console.log('accessory snapshots: auth, idempotency, stock, privacy, withdrawal and restore passed');
  } finally {
    if (secret == null) delete process.env.CATALOG_SYNC_SECRET; else process.env.CATALOG_SYNC_SECRET = secret;
    if (testDb == null) delete process.env.MACSO_TEST_DATABASE_URL; else process.env.MACSO_TEST_DATABASE_URL = testDb;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
