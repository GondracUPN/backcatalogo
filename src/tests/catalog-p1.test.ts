import { strict as assert } from 'assert';
import { AdminController } from '../modules/catalog-admin/admin.controller';
import { CatalogController } from '../modules/catalog/catalog.controller';

type QueryCall = { sql: string; params?: unknown[] };

function createManager(calls: QueryCall[]) {
  return {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (/INSERT INTO sold_records/i.test(sql)) return [{ id: 'sale-1' }];
      return [];
    },
  };
}

async function testMarkSoldUsesExplicitSalePrice(clientPhotoUrl?: string) {
  const queries: QueryCall[] = [];
  const updates: Array<{ where: unknown; patch: unknown }> = [];

  const productRepo = {
    async findOne() {
      return { id: 'prod-1', sku: 'MBA-001', price: '4500.00', stock: 1, status: 'listed' };
    },
    async update(where: unknown, patch: unknown) {
      updates.push({ where, patch });
      return { affected: 1 };
    },
    manager: createManager(queries),
  } as any;

  const controller = new AdminController(
    { verifyToken: () => ({ role: 'ADMIN' }) } as any,
    { findOne: async () => null, find: async () => [] } as any,
    { update: async () => ({ affected: 1 }), findOne: async () => null } as any,
    productRepo,
    { manager: createManager([]), findOne: async () => null, find: async () => [] } as any,
    { syncStaged: async () => undefined } as any,
    { enqueueAndDispatch: async () => undefined } as any,
  );

  const result = await controller.markSold('Bearer ok', 'prod-1', {
    saleDate: '2026-04-08',
    salePrice: '3999.50',
    customerName: 'Cliente de prueba',
    customerPhone: '900000000',
    clientPhotoUrl,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(updates, [{ where: { id: 'prod-1' }, patch: { status: 'sold', stock: 0 } }]);
  const saleInsert = queries.find((query) => /INSERT INTO sold_records/i.test(query.sql));
  assert.ok(saleInsert);
  assert.deepEqual(saleInsert.params?.slice(0, 2), ['prod-1', 'MBA-001']);
  assert.equal(saleInsert.params?.[3], 3999.5);
  assert.equal(saleInsert.params?.[12], clientPhotoUrl || null);
}

async function testInventoryAndPossibleClientWithoutPhoto() {
  const queries: QueryCall[] = [];
  const manager = {
    ...createManager(queries),
    update: async () => ({ affected: 1 }),
    async transaction(work: (db: any) => Promise<void>) { await work(manager); },
  };
  const controller = new AdminController(
    { verifyToken: () => ({ role: 'ADMIN' }) } as any,
    { findOne: async () => ({ id: 'staged-1', sku: 'MBA-001', title: 'MacBook', status: 'draft', stock: 1, price: 4500 }) } as any,
    { findOne: async () => null } as any,
    { manager } as any,
    {} as any,
    {} as any,
    { enqueueAndDispatch: async () => ({ ok: true }) } as any,
  );
  const sale = await controller.markStagedSold('Bearer ok', 'staged-1', {
    saleDate: '2026-04-08', name: 'Cliente de prueba', phone: '900000000',
  });
  assert.equal(sale.ok, true);
  assert.equal(sale.remainingStock, 0);
  const insert = queries.find((call) => /INSERT INTO sold_records/i.test(call.sql));
  assert.ok(insert);
  assert.equal(insert.params?.[12], null);

  manager.query = async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (/SELECT \* FROM possible_clients/i.test(sql)) return [{ id: 'client-1' }];
    if (/UPDATE possible_clients/i.test(sql)) return [{ id: 'client-1', client_photo_url: params?.[4] }];
    return [];
  };
  const purchase = await controller.markPossibleClientPurchased('Bearer ok', 'client-1', {
    customerKind: 'tranquilo', salePlaceType: 'almacen',
  });
  assert.equal(purchase.ok, true);
  assert.equal(purchase.item.client_photo_url, null);
}

async function testMarkSoldFallsBackToCatalogPrice() {
  const queries: QueryCall[] = [];

  const controller = new AdminController(
    { verifyToken: () => ({ role: 'ADMIN' }) } as any,
    { findOne: async () => null, find: async () => [] } as any,
    { update: async () => ({ affected: 1 }), findOne: async () => null } as any,
    {
      async findOne() {
        return { id: 'prod-1', sku: 'MBA-001', price: '4500.00', stock: 1, status: 'listed' };
      },
      async update() {
        return { affected: 1 };
      },
      manager: createManager(queries),
    } as any,
    { manager: createManager([]), findOne: async () => null, find: async () => [] } as any,
    { syncStaged: async () => undefined } as any,
    { enqueueAndDispatch: async () => undefined } as any,
  );

  await controller.markSold('Bearer ok', 'prod-1', {
    saleDate: '2026-04-08',
    salePrice: '',
    customerName: 'Cliente de prueba',
    customerPhone: '900000000',
    clientPhotoUrl: '/clientes/test.jpg',
  });

  const saleInsert = queries.find((query) => /INSERT INTO sold_records/i.test(query.sql));
  assert.ok(saleInsert);
  assert.equal(saleInsert.params?.[3], 4500);
}

async function testTrackViewStoresCanonicalProductData() {
  const tableQueries: QueryCall[] = [];
  const inserted: any[] = [];

  const controller = new CatalogController(
    {
      async findOne({ where }: any) {
        if (where?.product_id === 'prod-1' && where?.slug === 'macbook-air-m3' && where?.is_published === true) {
          return {
            product_id: 'prod-1',
            slug: 'macbook-air-m3',
            category: 'macbook',
            is_published: true,
          };
        }
        return null;
      },
    } as any,
    {
      async findOne({ where }: any) {
        if (where?.id === 'prod-1') {
          return { id: 'prod-1', title: 'MacBook Air M3', status: 'listed' };
        }
        return null;
      },
    } as any,
    {} as any,
    {
      async insert(row: any) {
        inserted.push(row);
      },
      manager: createManager(tableQueries),
    } as any,
  );

  const result = await controller.trackView({
    productId: 'prod-1',
    productSlug: 'macbook-air-m3',
    productTitle: 'titulo falso',
    category: 'categoria-falsa',
    sessionId: 'session-1',
    path: '/product/macbook-air-m3',
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(inserted.length, 1);
  assert.deepEqual(inserted[0], {
    product_id: 'prod-1',
    product_slug: 'macbook-air-m3',
    product_title: 'MacBook Air M3',
    category: 'macbook',
    session_id: 'session-1',
    path: '/product/macbook-air-m3',
  });
  assert.equal(tableQueries.length, 5);
}

async function testTrackViewRejectsForgedSlug() {
  const inserted: any[] = [];

  const controller = new CatalogController(
    {
      async findOne() {
        return null;
      },
    } as any,
    {
      async findOne() {
        return { id: 'prod-1', title: 'MacBook Air M3', status: 'listed' };
      },
    } as any,
    {} as any,
    {
      async insert(row: any) {
        inserted.push(row);
      },
      manager: createManager([]),
    } as any,
  );

  const result = await controller.trackView({
    productId: 'prod-1',
    productSlug: 'slug-falso',
    sessionId: 'session-1',
    path: '/product/slug-falso',
  });

  assert.deepEqual(result, { ok: false });
  assert.equal(inserted.length, 0);
}

async function run() {
  await testMarkSoldUsesExplicitSalePrice();
  await testMarkSoldUsesExplicitSalePrice('/clientes/test.jpg');
  await testInventoryAndPossibleClientWithoutPhoto();
  await testMarkSoldFallsBackToCatalogPrice();
  await testTrackViewStoresCanonicalProductData();
  await testTrackViewRejectsForgedSlug();
  // eslint-disable-next-line no-console
  console.log('catalog-p1.test.ts ok');
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
