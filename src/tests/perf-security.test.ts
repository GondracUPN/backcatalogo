import { strict as assert } from 'assert';
import { AdminController } from '../modules/catalog-admin/admin.controller';
import { PullSyncService } from '../modules/sync/pull.service';
import { SyncController } from '../modules/sync/sync.controller';
import { CartController } from '../modules/cart/cart.controller';
import { isValidSyncSecret } from '../utils/shared-secret';
import { runOnce, resetRunOnceForTests } from '../utils/run-once';

// Pruebas sin base de datos: todos los repositorios son simulados.

function counter() {
  const calls: Record<string, number> = {};
  return {
    calls,
    hit(name: string) {
      calls[name] = (calls[name] || 0) + 1;
    },
  };
}

async function testAdminCatalogHasNoPerRowQueries() {
  const c = counter();
  const rows = 60;
  const staged = Array.from({ length: rows }, (_, i) => ({
    id: `st-${i}`,
    sku: `MS-${i}`,
    title: `MacBook ${i}`,
    status: 'published',
    product_condition: 'Usado',
    owner_user_id: null,
    notes: '{}',
    images: [],
  }));
  const products = staged.map((row, i) => ({ id: `p-${i}`, sku: row.sku, title: row.title, status: 'listed', product_condition: 'Usado' }));
  const publics = products.map((p, i) => ({ id: `pub-${i}`, product_id: p.id, is_published: true, slug: `s-${i}`, images: [] }));

  const productRepo = {
    findOne: async () => { c.hit('product.findOne'); return null; },
    findBy: async (where: any) => {
      c.hit('product.findBy');
      const ids = where?.id?._value || where?.id?.value;
      const skus = where?.sku?._value || where?.sku?.value;
      if (ids) return products.filter((p) => ids.includes(p.id));
      if (skus) return products.filter((p) => skus.includes(p.sku));
      return [];
    },
    manager: { query: async () => { c.hit('query'); return []; } },
  } as any;
  const publicRepo = {
    find: async () => { c.hit('public.find'); return publics; },
    findOne: async () => { c.hit('public.findOne'); return null; },
    findBy: async () => { c.hit('public.findBy'); return []; },
    update: async () => { c.hit('public.update'); return {}; },
  } as any;
  const stagedRepo = {
    findBy: async () => { c.hit('staged.findBy'); return staged; },
    find: async () => { c.hit('staged.find'); return staged; },
  } as any;

  const controller = new AdminController(
    { verifyToken: () => ({ role: 'ADMIN', sub: 1 }) } as any,
    stagedRepo,
    publicRepo,
    productRepo,
    { manager: { query: async () => [] } } as any,
    { triggerStagedSync: () => ({ started: false }) } as any,
    {} as any,
  );
  const result = await controller.listAdminCatalog('Bearer ok');
  assert.equal(result.items.length, rows);
  assert.equal(c.calls['product.findOne'] || 0, 0, 'no debe consultar producto por fila');
  assert.equal(c.calls['public.findOne'] || 0, 0, 'no debe consultar publicación por fila');
  assert.ok((c.calls['product.findBy'] || 0) <= 2);
}

async function testAdminCatalogRestoresHiddenPublicationsInOneUpdate() {
  let updated: any = null;
  let phase = 0;
  const staged = [{ id: 'st-1', sku: 'MS-1', title: 'iPhone', status: 'published', product_condition: 'Usado', owner_user_id: null, notes: '{}', images: [] }];
  const product = { id: 'p-1', sku: 'MS-1', title: 'iPhone', status: 'listed', product_condition: 'Usado' };
  const controller = new AdminController(
    { verifyToken: () => ({ role: 'ADMIN', sub: 1 }) } as any,
    { findBy: async () => staged, find: async () => staged } as any,
    {
      find: async () => (phase === 0
        ? [{ id: 'pub-0', product_id: 'p-0', is_published: true }]
        : [{ id: 'pub-0', product_id: 'p-0', is_published: true }, { id: 'pub-1', product_id: 'p-1', is_published: true }]),
      findBy: async () => (phase === 0 ? [{ id: 'pub-1', product_id: 'p-1', is_published: false }] : []),
      update: async (where: any, patch: any) => { updated = { where, patch }; phase = 1; return {}; },
    } as any,
    { findBy: async () => [product, { id: 'p-0', sku: 'MS-0', title: 'Otro', status: 'listed', product_condition: 'Nuevo' }], manager: { query: async () => [] } } as any,
    { manager: { query: async () => [] } } as any,
    {} as any,
    {} as any,
  );
  await controller.listAdminCatalog('Bearer ok');
  assert.ok(updated, 'debe reactivar la publicación oculta');
  assert.deepEqual(updated.patch, { is_published: true });
}

async function testListStagedDoesNotWaitForSync() {
  let triggered = 0;
  const neverEnding = new Promise(() => undefined);
  const controller = new AdminController(
    { verifyToken: () => ({ role: 'ADMIN', sub: 1 }) } as any,
    { findAndCount: async () => [[{ id: 'a' }], 1] } as any,
    {} as any,
    { manager: { query: async () => [] } } as any,
    {} as any,
    { syncStaged: () => neverEnding, triggerStagedSync: () => { triggered += 1; return { started: true }; } } as any,
    {} as any,
  );
  const result = await Promise.race([
    controller.listStaged('Bearer ok'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 500)),
  ]);
  assert.notEqual(result, 'timeout', 'el listado no debe esperar a la sincronización');
  assert.equal(triggered, 1);
}

function makePullService(fetchCount: { n: number }, queries: Record<string, number>) {
  const products = {
    findBy: async () => { queries.productFindBy = (queries.productFindBy || 0) + 1; return []; },
    findOne: async () => { queries.productFindOne = (queries.productFindOne || 0) + 1; return null; },
    upsert: async () => ({}),
  } as any;
  const staged = {
    findBy: async () => { queries.stagedFindBy = (queries.stagedFindBy || 0) + 1; return []; },
    findOne: async () => { queries.stagedFindOne = (queries.stagedFindOne || 0) + 1; return null; },
    upsert: async () => ({}),
  } as any;
  (globalThis as any).fetch = async () => {
    fetchCount.n += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      ok: true,
      json: async () => ({
        items: Array.from({ length: 30 }, (_, i) => ({ id: `src-${i}`, sku: `MS-${i}`, title: `Item ${i}`, price: 100 })),
        hasNext: false,
      }),
    };
  };
  return new PullSyncService(products, staged);
}

async function testSyncIsSingleFlightAndBatched() {
  const previous = { ...process.env };
  process.env.UPSTREAM_API_BASE = 'http://upstream.test';
  process.env.UPSTREAM_SYNC_ON_READ = '1';
  process.env.UPSTREAM_SYNC_MIN_INTERVAL_MS = '60000';
  const originalFetch = (globalThis as any).fetch;
  try {
    const fetchCount = { n: 0 };
    const queries: Record<string, number> = {};
    const service = makePullService(fetchCount, queries);
    const [a, b] = await Promise.all([service.syncStaged(), service.syncStaged()]);
    assert.deepEqual(a, b);
    assert.equal(fetchCount.n, 1, 'dos llamadas simultáneas comparten la misma sincronización');
    assert.equal(queries.productFindOne || 0, 0, 'sin consultas por producto');
    assert.equal(queries.stagedFindOne || 0, 0, 'sin consultas por producto');
    assert.equal(queries.productFindBy, 1);
    assert.equal(service.getStatus().lastError, null);

    const again = service.triggerStagedSync();
    assert.deepEqual(again, { started: false, reason: 'recent' });
  } finally {
    (globalThis as any).fetch = originalFetch;
    process.env = previous;
  }
}

async function testExtraSearchSyncIsNotSwallowedByPlainSync() {
  const previous = { ...process.env };
  process.env.UPSTREAM_API_BASE = 'http://upstream.test';
  process.env.UPSTREAM_SYNC_ON_READ = '1';
  process.env.UPSTREAM_SYNC_SEARCH_TERMS = 'pawn';
  process.env.UPSTREAM_SYNC_SEARCH_PARAMS = 'q';
  const originalFetch = (globalThis as any).fetch;
  try {
    const urls: string[] = [];
    const repo = { findBy: async () => [], findOne: async () => null, upsert: async () => ({}) } as any;
    (globalThis as any).fetch = async (url: string) => {
      urls.push(String(url));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, json: async () => ({ items: [], hasNext: false }) };
    };
    const service = new PullSyncService(repo, repo);
    const plain = service.syncStaged();
    const extra = service.syncStaged({ includeExtraSearches: true });
    await Promise.all([plain, extra]);
    assert.ok(urls.some((url) => url.includes('q=pawn')), 'la búsqueda pawn debe ejecutarse');
  } finally {
    (globalThis as any).fetch = originalFetch;
    process.env = previous;
  }
}

function testSyncSecret() {
  const previous = { ...process.env };
  try {
    delete process.env.CATALOG_SYNC_SECRET;
    delete process.env.CATALOG_SYNC_REQUIRE_SECRET;
    assert.equal(isValidSyncSecret({}), false, 'sin secreto siempre falla cerrado');
    process.env.CATALOG_SYNC_REQUIRE_SECRET = '1';
    assert.equal(isValidSyncSecret({}), false);
    process.env.CATALOG_SYNC_SECRET = 's3cret-value';
    assert.equal(isValidSyncSecret({}), false);
    assert.equal(isValidSyncSecret({ secret: 'wrong' }), false);
    assert.equal(isValidSyncSecret({ secret: 's3cret-value' }), true);
    assert.equal(isValidSyncSecret({ authorization: 'Bearer s3cret-value' }), true);
  } finally {
    process.env = previous;
  }
}

async function testSyncWebhookRejectsWithoutSecret() {
  const previous = { ...process.env };
  process.env.CATALOG_SYNC_SECRET = 'webhook-secret';
  try {
    let touched = false;
    const repo = { findOne: async () => { touched = true; return null; } } as any;
    const controller = new SyncController(repo, repo, repo, repo);
    await assert.rejects(() => controller.syncProduct('idem-1', { event: 'product.sold', product: { sku: 'MS-1' } }));
    await assert.rejects(() => controller.exists('MS-1', undefined, undefined, undefined));
    assert.equal(touched, false, 'no debe leer ni escribir sin autenticación');
  } finally {
    process.env = previous;
  }
}

async function testCartRejectsOfferProbing() {
  const product = { id: 'p-1', sale_type: 'OFERTA', price: '1000', min_offer_price: '800', stock: 1, status: 'listed', product_condition: 'Usado' };
  const controller = new CartController(
    { findOne: async () => null, save: async (x: any) => ({ id: 'c-1', ...x }), create: (x: any) => x, find: async () => [] } as any,
    { findOne: async () => product, manager: { query: async () => [] } } as any,
    {} as any,
    {} as any,
  );
  const req = { session: {} };
  await assert.rejects(
    () => controller.add(req, { productId: 'p-1', qty: 1, offerPrice: 850, cartId: 'cart-1' } as any, ''),
    /offers/,
  );
  const ok = await controller.add(req, { productId: 'p-1', qty: 1, offerPrice: 1000, cartId: 'cart-1' } as any, '');
  assert.equal(ok.ok, true);
}

async function testCostHiddenFromSellersAndPreservedOnSave() {
  const row = { id: 'st-1', sku: 'MS-1', title: 'iPhone', status: 'draft', stock: 1, owner_user_id: null, category: 'otros',
    notes: JSON.stringify({ color: 'Negro', valor: { costoTotal: 1500 }, specs: { tipo: 'otros', valor: { costoTotal: 1500 } } }) };
  let saved: any = null;
  const build = (role: string) => new AdminController(
    { verifyToken: () => ({ role, sub: 7, canViewServiceInventory: true }) } as any,
    {
      findAndCount: async () => [[row], 1],
      findOne: async () => row,
      update: async (_where: any, patch: any) => { saved = patch; return {}; },
    } as any,
    {} as any,
    { manager: { query: async () => [] } } as any,
    {} as any,
    { triggerStagedSync: () => ({ started: false }) } as any,
    {} as any,
  );
  const sellerView = await build('VENDEDOR').listStaged('Bearer ok');
  assert.ok(!String(sellerView.items[0].notes).includes('costoTotal'), 'el vendedor no ve el costo');
  assert.ok(String(row.notes).includes('costoTotal'), 'no se modifica el registro original');
  const adminView = await build('ADMIN').listStaged('Bearer ok');
  assert.ok(String(adminView.items[0].notes).includes('costoTotal'), 'el admin sí ve el costo');

  await build('VENDEDOR').updateStaged('Bearer ok', 'st-1', { notes: sellerView.items[0].notes, title: 'iPhone 15' });
  assert.ok(String(saved.notes).includes('"costoTotal":1500'), 'guardar como vendedor no borra el costo');
}

async function testRunOnce() {
  resetRunOnceForTests();
  let n = 0;
  await Promise.all([runOnce('k', async () => { n += 1; }), runOnce('k', async () => { n += 1; })]);
  await runOnce('k', async () => { n += 1; });
  assert.equal(n, 1);
  let failures = 0;
  await assert.rejects(() => runOnce('f', async () => { failures += 1; throw new Error('x'); }));
  await runOnce('f', async () => { failures += 1; });
  assert.equal(failures, 2, 'tras un fallo se reintenta');
}

(async () => {
  await testAdminCatalogHasNoPerRowQueries();
  await testAdminCatalogRestoresHiddenPublicationsInOneUpdate();
  await testListStagedDoesNotWaitForSync();
  await testSyncIsSingleFlightAndBatched();
  await testExtraSearchSyncIsNotSwallowedByPlainSync();
  testSyncSecret();
  await testSyncWebhookRejectsWithoutSecret();
  await testCartRejectsOfferProbing();
  await testCostHiddenFromSellersAndPreservedOnSave();
  await testRunOnce();
  // eslint-disable-next-line no-console
  console.log('perf-security.test.ts ok');
})().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
