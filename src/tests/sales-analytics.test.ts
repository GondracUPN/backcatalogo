import 'reflect-metadata';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { SalesAnalyticsService } from '../modules/analytics/sales-analytics.service';
import { SalesAnalyticsController } from '../modules/analytics/sales-analytics.controller';
import { AnalyticsController } from '../modules/analytics/analytics.controller';
import { AdminController } from '../modules/catalog-admin/admin.controller';
import { parseRange } from '../modules/analytics/analytics.service';
import { scopeForStaff } from '../utils/sales-scope';
import { SellerSalesAnalytics1792454500000 } from '../migrations/1792454500000-SellerSalesAnalytics';

async function main() {
  const pg = new PGlite();
  const query = async (sql: string, values: unknown[] = []) =>
    (await pg.query(sql, values)).rows as any[];
  const db = { query };
  await pg.exec(`CREATE TABLE "User"(id int PRIMARY KEY,username text,role text,can_view_service_inventory boolean);
    CREATE TABLE products(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sku text UNIQUE,title text);
    CREATE TABLE staged_products(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sku text,source_id uuid,title text,category text,owner_user_id int,status text,stock int,created_at timestamptz DEFAULT now());
    CREATE TABLE catalog_public(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_id uuid,images jsonb,is_published boolean,created_at timestamptz DEFAULT now());
    CREATE TABLE sold_records(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_id uuid,sku text,product_title text,sale_price numeric,exchange_rate numeric,owner_user_id int,sold_at timestamptz,customer_kind text,sale_place_type text,sale_location text,customer_phone text);
    CREATE TABLE purchase_requests(id uuid DEFAULT gen_random_uuid(),owner_user_id int,status text,created_at timestamptz);
    INSERT INTO "User" VALUES(7,'Vendedor Ana','VENDEDOR',false),(8,'Vendedor Luis','VENDEDOR',false),(9,'Inventario compartido','VENDEDOR',true);
  `);
  await new SellerSalesAnalytics1792454500000().up({ query } as any);
  const fixtures = [
    [7, 100, '2026-10-19T12:00:00-05:00', null],
    [7, 200, '2026-10-20T04:59:59.999Z', null],
    [7, 1000, '2026-10-20T05:00:00Z', 4],
    [7, 500, '2026-10-21T04:59:59.999Z', null],
    [7, 9000, '2026-10-21T05:00:00Z', null],
    [8, 8000, '2026-10-20T15:00:00Z', 4],
    [null, 2000, '2026-10-20T15:00:00Z', 4],
  ];
  for (const [owner, amount, date, exchange] of fixtures) {
    await query(
      `INSERT INTO sold_records(sku,product_title,owner_user_id,sale_price,sold_at,exchange_rate,customer_kind,sale_place_type,sale_location,customer_phone)
      VALUES($1,$2,$3,$4,$5,$6,'tranquilo','otro',$7,'SYNTHETIC-NO-PHONE')`,
      [
        `SKU-${owner}`,
        `Modelo ${owner}`,
        owner,
        amount,
        date,
        exchange,
        owner === 7 ? 'OWN_CHANNEL' : 'OTHER_CHANNEL',
      ],
    );
  }
  await pg.exec(`INSERT INTO purchase_requests(owner_user_id,status,created_at) VALUES
    (7,'entregada','2026-10-20T10:00:00-05:00'),(7,'nueva','2026-10-20T11:00:00-05:00'),
    (7,'entregada','2026-10-19T10:00:00-05:00'),(8,'entregada','2026-10-20T10:00:00-05:00');
    INSERT INTO staged_products(sku,title,category,owner_user_id,status,stock,created_at) VALUES
    ('SKU-7','Modelo 7','iphone',7,'published',1,now()-interval '61 days'),
    ('SKU-8','Modelo 8','iphone',8,'published',1,now()-interval '31 days');
    INSERT INTO products(sku,title) VALUES('SKU-7','Modelo 7'),('SKU-8','Modelo 8');
    INSERT INTO catalog_public(product_id,is_published) SELECT id,true FROM products;
  `);
  const auth = {
    verifyToken: (token: string) => {
      const roles: Record<string, object> = {
        admin: { role: 'ADMIN', sub: 1 },
        seller: { role: 'VENDEDOR', sub: 7 },
        other: { role: 'VENDEDOR', sub: 8 },
        shared: { role: 'VENDEDOR', sub: 9, canViewServiceInventory: true },
      };
      if (!roles[token]) throw new Error('Invalid token');
      return roles[token];
    },
  } as any;
  const service = new SalesAnalyticsService(db as any);
  const controller = new SalesAnalyticsController(auth, service);
  const legacy = new AnalyticsController({} as any, auth);
  const from = '2026-10-20T05:00:00Z',
    to = '2026-10-21T05:00:00Z';
  const own = scopeForStaff(auth.verifyToken('seller'), 'all');
  assert.deepEqual(own, { owner: 7, all: false });
  assert.deepEqual(scopeForStaff(auth.verifyToken('shared'), '7'), {
    owner: null,
    all: false,
  });
  const summary = await controller.summary('Bearer seller', from, to, '8');
  assert.deepEqual(summary.sales, { current: 2, previous: 2, change: 0 });
  assert.deepEqual(summary.revenue, {
    current: 1500,
    previous: 300,
    change: 400,
  });
  assert.equal(summary.averageTicket.current, 750);
  assert.equal(summary.revenueUsd.current, 250);
  assert.equal(summary.exchangeRateCoverage.sales, 1);
  assert.equal(summary.conversion.current, 50);
  assert.equal(summary.conversion.previous, 100);
  assert.equal(summary.margin, null);
  assert.equal(
    (await controller.summary('Bearer shared', from, to, 'all')).revenue
      .current,
    2000,
  );
  assert.equal(
    (await controller.summary('Bearer admin', from, to, 'all')).revenue.current,
    11500,
  );
  assert.equal(
    (await controller.summary('Bearer admin', from, to, '8')).revenue.current,
    8000,
  );
  const timeline = await controller.timeline(
    'Bearer seller',
    from,
    to,
    'all',
    'day',
  );
  assert.deepEqual(timeline.items, [
    { bucket: '2026-10-20T00:00', sales: 2, revenue: 1500 },
  ]);
  const products = await controller.products('Bearer seller', from, to, '8');
  assert.equal(products.items[0].units, 2);
  assert.equal(products.items[0].category, 'iphone');
  const channels = await controller.channels('Bearer seller', from, to, '8');
  assert.equal(channels.items[0].location, 'OWN_CHANNEL');
  const stock = await controller.stock('Bearer seller', 'all');
  assert.equal(stock.active, 1);
  assert.equal(stock.over60, 1);
  for (const payload of [summary, timeline, products, channels, stock]) {
    const encoded = JSON.stringify(payload);
    assert.ok(!encoded.includes('customer_phone'));
    assert.ok(!encoded.includes('SYNTHETIC-NO-PHONE'));
    assert.ok(!encoded.includes('OTHER_CHANNEL'));
  }
  const status = (code: number) => (error: any) => error.getStatus() === code;
  for (const call of [
    () => controller.summary('', from, to),
    () => controller.timeline('', from, to),
    () => controller.products('', from, to),
    () => controller.channels('', from, to),
    () => controller.stock(''),
    () => controller.sellers('', from, to),
  ])
    assert.throws(call, status(401));
  assert.throws(
    () => controller.sellers('Bearer seller', from, to),
    status(403),
  );
  for (const call of [
    () => legacy.overview('Bearer seller'),
    () => legacy.sources('Bearer seller'),
    () => legacy.searches('Bearer seller'),
    () => legacy.funnel('Bearer seller'),
  ])
    assert.throws(call, status(403));
  const sellers = await controller.sellers('Bearer admin', from, to);
  assert.equal(sellers.items.length, 2);
  assert.equal(
    (sellers.items.find((item: any) => item.owner_id === 7) as any).revenue,
    1500,
  );
  let salesParams: unknown[] = [];
  const adminManager = {
    query: async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes('FROM sold_records sr')) {
        salesParams = parameters;
        return [
          {
            id: 'test-sale',
            customer_phone: 'SYNTHETIC',
            owner_user_id: parameters[0],
          },
        ];
      }
      return [];
    },
  };
  const adminController = new AdminController(
    auth,
    {} as any,
    {} as any,
    { manager: adminManager } as any,
    {} as any,
    {} as any,
    { ensureTable: async () => {} } as any,
  );
  const sellerSales = await adminController.listSales('Bearer seller', 'all');
  assert.equal(salesParams[0], 7);
  assert.equal(salesParams[2], false);
  assert.ok(!JSON.stringify(sellerSales).includes('customer_phone'));
  await adminController.listSales('Bearer admin', '8');
  assert.equal(salesParams[0], 8);
  await adminController.listSales('Bearer admin', 'all');
  assert.equal(salesParams[2], true);
  await query(
    `INSERT INTO sold_records(sku,product_title,sale_price,owner_user_id,sold_at,customer_kind,sale_place_type)
    SELECT 'PERF-'||n,'Modelo sintético',100,7,$1::timestamptz+(n%80000)*interval '1 second','tranquilo','almacen' FROM generate_series(1,5000)n`,
    [from],
  );
  const range = parseRange(from, to, 'day');
  const endpoints = {
    summary: () => service.summary(range, own),
    timeline: () => service.timeline(range, own),
    products: () => service.products(range, own),
    channels: () => service.channels(range, own),
    stock: () => service.stock(own),
    sellers: () => service.sellers(range),
  };
  const timings: Record<string, { medianMs: number; maxMs: number }> = {};
  for (const [name, call] of Object.entries(endpoints)) {
    await call();
    const samples: number[] = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      const start = performance.now();
      await call();
      samples.push(performance.now() - start);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    timings[name] = {
      medianMs: Number(sorted[2].toFixed(2)),
      maxMs: Number(Math.max(...samples).toFixed(2)),
    };
    assert.ok(
      timings[name].maxMs < 300,
      `${name} must take <300 ms: ${JSON.stringify(timings[name])}`,
    );
  }
  const folder = path.resolve(
    __dirname,
    '../../../docs/evidencias/ventas-vendedores-2026-10-20',
  );
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, 'sales-performance.json'),
    JSON.stringify(
      {
        engine: 'PGlite',
        sales: 5007,
        timings,
        range: { from, to },
        timezone: 'America/Lima',
      },
      null,
      2,
    ),
  );
  await new SellerSalesAnalytics1792454500000().down({ query } as any);
  await pg.close();
  console.log('sales-analytics.test.ts ok', JSON.stringify(timings));
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
