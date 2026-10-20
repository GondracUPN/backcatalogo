import 'reflect-metadata';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { ProductPhotoSafety1792454400000 } from '../migrations/1792454400000-ProductPhotoSafety';
import { ProductPhotosService } from '../modules/catalog-admin/product-photos.service';
import { auditPhotoUrls } from '../scripts/audit-photo-urls';

async function main() {
  const pg = new PGlite();
  const query = async (sql: string, parameters: unknown[] = []) => {
    if (sql.includes('pg_try_advisory_lock')) return [{ locked: true }];
    if (sql.includes('pg_advisory_unlock')) return [];
    return (await pg.query(sql, parameters)).rows as any[];
  };
  const manager = { query };
  const db = {
    query,
    manager,
    transaction: async (fn: any) => {
      await query('BEGIN');
      try {
        const result = await fn(manager);
        await query('COMMIT');
        return result;
      } catch (error) {
        await query('ROLLBACK');
        throw error;
      }
    },
    createQueryRunner: () => ({
      query,
      connect: async () => {},
      release: async () => {},
    }),
  };
  await pg.exec(`CREATE TABLE products(id uuid PRIMARY KEY,sku text,status text,stock int,presentation text,updated_at timestamptz DEFAULT now());
    CREATE TABLE staged_products(id uuid PRIMARY KEY,source_id uuid,sku text,status text,stock int,presentation text,owner_user_id int,images jsonb,notes text,updated_at timestamptz DEFAULT now());
    CREATE TABLE catalog_public(id uuid PRIMARY KEY,product_id uuid,images jsonb,updated_at timestamptz DEFAULT now());
    CREATE TABLE sold_records(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_id uuid,sku text,sold_at timestamptz,product_image_url text);
    CREATE TABLE sale_sync_events(id uuid DEFAULT gen_random_uuid(),sale_id uuid,remote_status text,status text,created_at timestamptz DEFAULT now());`);
  await new ProductPhotoSafety1792454400000().up({ query } as any);
  const id = 'aaaaaaaa-1111-4111-8111-111111111111',
    source = 'bbbbbbbb-1111-4111-8111-111111111111';
  const old = '/uploads/wm-reviewold.png',
    next = '/uploads/wm-reviewnew.png',
    cover = '/uploads/wm-cover.png';
  const service = new ProductPhotosService(db as any);
  const deleted: string[] = [];
  (service as any).internal = async (route: string, body: { url?: string }) => {
    if (route.endsWith('delete-file')) deleted.push(body.url!);
  };
  await query(
    `INSERT INTO staged_products(id,source_id,sku,status,stock,images,notes) VALUES($1,$2,'STAGE','draft',1,$3,$4)`,
    [id, source, JSON.stringify([old]), ' { "z" : 5,\n "a" : "intacto" } '],
  );
  await service.replace(source, old, next, { role: 'ADMIN', sub: 1 } as any);
  assert.deepEqual(
    deleted,
    [old],
    'staged replacement deletes immediately even when passed source_id',
  );
  const [log] = await query('SELECT * FROM photo_change_log');
  assert.equal(log.staged_id, id);
  assert.equal(log.product_id, null);
  assert.equal(log.pending, false);
  assert.equal(
    (await query('SELECT notes FROM staged_products'))[0].notes,
    ' { "z" : 5,\n "a" : "intacto" } ',
    'notes unchanged byte for byte',
  );
  assert.equal(
    service.canReplaceUrl(
      'https://res.cloudinary.com/own/image/upload/v1/legacy/a.png',
      'https://res.cloudinary.com/own/image/upload/macsomenos/productos/b.png',
    ),
    true,
  );
  assert.equal(
    service.canReplaceUrl(
      'https://res.cloudinary.com/other/image/upload/v1/legacy/a.png',
      'https://res.cloudinary.com/own/image/upload/macsomenos/productos/b.png',
    ),
    false,
  );
  assert.equal(
    service.canReplaceUrl(
      'https://res.cloudinary.com/other/image/upload/macsomenos/productos/a.png',
      'https://res.cloudinary.com/own/image/upload/macsomenos/productos/b.png',
    ),
    false,
    'known folders must also belong to the same Cloudinary account',
  );
  const soldProductId = 'cccccccc-1111-4111-8111-111111111111';
  await query(
    `INSERT INTO products(id,sku,status,stock,presentation) VALUES($1,'SOLD','sold',0,'abierto')`,
    [soldProductId],
  );
  await query(
    `INSERT INTO catalog_public(id,product_id,images) VALUES($1,$1,$2)`,
    [soldProductId, JSON.stringify([cover, next])],
  );
  const [sale] = await query(
    `INSERT INTO sold_records(product_id,sku,sold_at) VALUES($1,'SOLD',now()-interval '61 days') RETURNING id`,
    [soldProductId],
  );
  for (const status of [
    'pending_confirmation',
    'pending_cancellation_confirmation',
    'rejected',
  ]) {
    await query('DELETE FROM sale_sync_events');
    await query(
      `INSERT INTO sale_sync_events(sale_id,remote_status,status) VALUES($1,$2,'sent')`,
      [sale.id, status],
    );
    assert.equal(
      (await service.cleanup(soldProductId, false, 'system')).skipped,
      'skip_sale_pending',
    );
    assert.equal(
      (await query('SELECT images FROM catalog_public'))[0].images.length,
      2,
    );
  }
  await service.cleanup(soldProductId, false, 'system');
  assert.equal(
    (
      await query(
        "SELECT * FROM photo_change_log WHERE action='skip_sale_pending'",
      )
    ).length,
    1,
    'same skipped status logged once',
  );
  await query("UPDATE sale_sync_events SET remote_status='confirmed'");
  const previousEnv = { ...process.env };
  try {
    process.env.SOLD_PHOTO_CLEANUP_ENABLED = 'true';
    process.env.SOLD_PHOTO_CLEANUP_DRY_RUN = 'false';
    await service.daily(false);
    assert.equal(
      (await query('SELECT images FROM catalog_public'))[0].images.length,
      1,
    );
    await query('DELETE FROM photo_url_rules WHERE sku=$1', ['SOLD']);
    await query('UPDATE catalog_public SET images=$1', [
      JSON.stringify([cover, next]),
    ]);
    const restarted = new ProductPhotosService(db as any);
    (restarted as any).internal = (service as any).internal;
    await restarted.daily(false);
    assert.equal(
      (await query('SELECT images FROM catalog_public'))[0].images.length,
      2,
      'restart respects persisted last daily run',
    );
    await query(
      "UPDATE photo_jobs SET last_completed_at=now()-interval '25 hours'",
    );
    await restarted.daily(false);
    assert.equal(
      (await query('SELECT images FROM catalog_public'))[0].images.length,
      1,
    );
    await query(
      "INSERT INTO photo_change_log(action,actor,created_at) VALUES('skip_hold','system',now()-interval '181 days')",
    );
    await restarted.daily(false);
    assert.equal(
      (
        await query(
          "SELECT 1 FROM photo_change_log WHERE created_at<now()-interval '180 days'",
        )
      ).length,
      0,
    );
  } finally {
    process.env = previousEnv;
  }
  await query('UPDATE staged_products SET images=$1', [
    JSON.stringify([
      'https://res.cloudinary.com/own/image/upload/v1/legacy/a.png',
    ]),
  ]);
  const audit = await auditPhotoUrls({ query } as any);
  assert.equal(audit.staged_products.unsupported, 1);
  assert.equal(audit.catalog_public.unsupported, 0);
  await pg.exec(
    `INSERT INTO staged_products(id,source_id,sku,images,notes) SELECT gen_random_uuid(),gen_random_uuid(),'PERF-'||n,'["/uploads/wm-perf.png"]',' { "z": 3, "a": [1, 2, 3] } ' FROM generate_series(1,500)n;`,
  );
  const syncRows = await query(
    "SELECT id,source_id,sku,images,notes FROM staged_products WHERE sku LIKE 'PERF-%' ORDER BY sku",
  );
  const measure = async (enabled: boolean) => {
    await query(
      `ALTER TABLE staged_products ${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER photo_guard_staged`,
    );
    const times: number[] = [];
    for (let repeat = 0; repeat < 7; repeat++) {
      const start = performance.now();
      for (const row of syncRows) {
        await query(
          `INSERT INTO staged_products(id,source_id,sku,images,notes) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(id) DO UPDATE SET images=EXCLUDED.images,notes=EXCLUDED.notes`,
          [
            row.id,
            row.source_id,
            row.sku,
            JSON.stringify(row.images),
            row.notes,
          ],
        );
      }
      if (repeat > 1) times.push(performance.now() - start);
    }
    return Number(times.sort((a, b) => a - b)[2].toFixed(2));
  };
  const before = await measure(false),
    after = await measure(true);
  const evidence = path.resolve(
    __dirname,
    '../../../docs/evidencias/ventas-vendedores-2026-10-20',
  );
  mkdirSync(evidence, { recursive: true });
  writeFileSync(
    path.join(evidence, 'photo-trigger-performance.json'),
    JSON.stringify(
      {
        products: 500,
        workload: '500 SQL upserts per run, without upstream HTTP',
        baselineMs: before,
        withTriggerMs: after,
        engine: 'PGlite',
        statistic: 'median of 5, after 2 warmups',
      },
      null,
      2,
    ),
  );
  console.log(
    'photo-review.test.ts ok',
    JSON.stringify({ beforeMs: before, afterMs: after }),
  );
  await pg.close();
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
