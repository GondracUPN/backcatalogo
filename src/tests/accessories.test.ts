import { strict as assert } from 'assert';
import { withdrawAccessoryFromServices } from '../utils/accessory-withdrawal';
import { accessoryFields } from '../utils/accessory-fields';
import { publicStaged, publicNotes } from '../utils/public-catalog';
import { validateProductBeforePublish } from '../utils/product-validation';
import { AdminController } from '../modules/catalog-admin/admin.controller';
import { MarketplaceBridgeController } from '../modules/marketplace-bridge/marketplace-bridge.controller';

async function main() {
  const fields = accessoryFields({ accessoryState: 'Sellado', accessoryCosts: { purchase: 35.1, shipping: 5.2 } });
  assert.equal(fields.product_condition, 'Nuevo');
  assert.equal(fields.presentation, 'sellado');
  assert.deepEqual(JSON.parse(fields.notes!).valor, { costoProducto: 35.1, costoEnvio: 5.2, costoTotal: 40.3, moneda: 'PEN' });
  for (const invalid of [-1, 'abc', null, '', Infinity, {}]) {
    assert.throws(() => accessoryFields({ accessoryCosts: { purchase: invalid, shipping: 0 } }));
  }
  assert.throws(() => accessoryFields({ accessoryState: 'Arreglado' }));

  let saved: any;
  const writes: any[] = [];
  let role = 'ADMIN';
  let publishedProduct: any;
  let publication: any;
  const controller = new AdminController(
    { verifyToken: () => ({ role, sub: 7, canViewServiceInventory: true }) } as any,
    { findOne: async () => saved || null, create: (row: any) => row,
      save: async (row: any) => (saved = { ...row, id: 'staged-acc' }),
      update: async (_: any, patch: any) => { writes.push(patch); saved = { ...saved, ...patch }; },
    } as any,
    { findOne: async () => null, update: async (_: any, patch: any) => Object.assign(publication, patch), upsert: async (row: any) => { publication = row; return { identifiers: [{ id: 'public-acc' }] }; } } as any,
    { findOne: async () => publishedProduct || null, update: async (_: any, patch: any) => Object.assign(publishedProduct, patch), upsert: async (row: any) => { publishedProduct = { ...row, id: 'product-acc' }; } } as any,
    {} as any, {} as any, {} as any,
  );
  const created = await controller.createManualStaged('Bearer ok', {
    category: 'accesorios', saleType: 'VENTA_SIMPLE', title: 'Cargador MagSafe Apple', price: 65.50,
    accessoryState: 'Sellado', accessoryCosts: { purchase: 35, shipping: 5 },
    images: ['/uploads/wm-charger.jpg'],
  });
  assert.equal(created.item.stock, 1);
  assert.equal(created.item.product_condition, 'Nuevo');
  assert.equal(created.item.presentation, 'sellado');
  assert.equal(validateProductBeforePublish(saved).ok, true);
  assert.doesNotMatch(JSON.stringify(publicStaged(saved)), /costo|valor|moneda/);
  assert.doesNotMatch(JSON.stringify(publicNotes(saved)), /costo|valor|moneda/);
  assert.equal(publicStaged(saved)?.presentation, 'sellado');
  (controller as any).loadProductVersionConfig = async () => ({});
  await controller.updateStaged('Bearer ok', saved.id, { accessoryState: 'Open Box', accessoryCosts: { purchase: 40, shipping: 2 } });
  assert.equal(writes.at(-1).product_condition, 'Open Box');
  assert.equal(writes.at(-1).presentation, null);
  assert.equal(JSON.parse(saved.notes).valor.costoTotal, 42);
  assert.equal(validateProductBeforePublish(saved).ok, true);
  assert.equal(validateProductBeforePublish({ ...saved, images: [] }).ok, false);
  for (const condition of ['Nuevo', 'Usado', 'Open Box']) {
    assert.equal(validateProductBeforePublish({ ...saved, product_condition: condition, stock: 6 }).ok, true);
    await controller.updateStaged('Bearer ok', saved.id, { productCondition: condition, stock: 6 });
    assert.equal(saved.stock, 6);
  }
  for (const stock of [-1, 1.5, NaN]) await assert.rejects(() => controller.updateStaged('Bearer ok', saved.id, { stock }), /stock/);
  assert.equal(validateProductBeforePublish({ ...saved, stock: 0 }).ok, false);
  assert.equal(validateProductBeforePublish({ ...saved, category: 'otros', stock: 6 }).ok, false);
  (controller as any).ensureCartAvailable = async () => undefined;
  await controller.publish('Bearer ok', saved.id, {});
  assert.equal(saved.status, 'published');
  assert.equal(publishedProduct.price, '65.5');
  assert.equal(publishedProduct.stock, 6);
  assert.equal(publishedProduct.product_condition, 'Open Box');
  assert.equal(publication.category, 'accesorios');
  assert.equal(publication.product_id, 'product-acc');
  assert.equal(publication.is_published, true);
  assert.doesNotMatch(JSON.stringify(publication), /costo|valor/);
  assert.doesNotMatch(JSON.stringify(publishedProduct), /costo|valor/);
  role = 'VENDEDOR';
  await assert.rejects(() => controller.updateStaged('Bearer ok', saved.id, { accessoryCosts: { purchase: 1, shipping: 1 } }), /permiso/);

  const originalFetch = global.fetch;
  const originalSyncUrl = process.env.SERVICES_SALES_SYNC_URL;
  const originalSecret = process.env.CATALOG_SYNC_SECRET;
  process.env.SERVICES_SALES_SYNC_URL = 'https://services.test/integrations/catalog-sales/events';
  process.env.CATALOG_SYNC_SECRET = 'withdraw-test';
  const requests: any[] = [];
  global.fetch = (async (url: any, options: any) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ ok: true, seleccionado: false }) };
  }) as any;
  try {
    role = 'ADMIN'; saved.status = 'draft'; saved.sku = 'acc-lot-509';
    await controller.deleteStaged('Bearer ok', saved.id);
    assert.equal(saved.status, 'hidden'); assert.equal(saved.stock, 0);
    assert.equal(requests[0].url, 'https://services.test/integrations/catalog-accessories/withdraw');
    assert.equal(requests[0].options.headers['x-sync-secret'], 'withdraw-test');
    assert.deepEqual(JSON.parse(requests[0].options.body), { sku: 'acc-lot-509' });
    saved.status = 'draft'; saved.stock = 4;
    global.fetch = (async () => { throw new Error('offline'); }) as any;
    await assert.rejects(controller.deleteStaged('Bearer ok', saved.id), /Servicios/);
    assert.equal(saved.status, 'draft'); assert.equal(saved.stock, 4);
    await assert.doesNotReject(withdrawAccessoryFromServices('MS-123'));
  } finally {
    global.fetch = originalFetch;
    if (originalSyncUrl === undefined) delete process.env.SERVICES_SALES_SYNC_URL; else process.env.SERVICES_SALES_SYNC_URL = originalSyncUrl;
    if (originalSecret === undefined) delete process.env.CATALOG_SYNC_SECRET; else process.env.CATALOG_SYNC_SECRET = originalSecret;
  }

  const bridge = new MarketplaceBridgeController({ verifyToken: () => ({ role: 'ADMIN', sub: 7 }) } as any, {
    manager: { query: async (sql: string) => /RETURNING/.test(sql) ? [{ token: 'test', expires_at: 'later' }] : [] },
  } as any);
  const response = await bridge.prepare('Bearer ok', { sku: 'MS-ACC', titulo: 'REMATO - Cargador', precio: '65.50', descripcion: 'Se remata Cargador\n\nEstado: Sellado', categoriaMarketplace: 'Electrónica e informática', estadoMarketplace: 'Nuevo', images: [] });
  assert.equal(response.token, 'test');
  for (const condition of ['Nuevo', 'Usado', 'Open Box']) {
    const unit: any = { id: 'multi', sku: 'acc-lot-99', title: 'Cable', price: '25', stock: 3, status: 'listed', product_condition: condition };
    const staged: any = { id: 'st-multi', sku: unit.sku, category: 'accesorios', stock: 3, status: 'published', product_condition: condition };
    let unpublished = false;
    const manager = { query: async (sql: string) => /INSERT INTO sold_records/.test(sql) ? [{ id: 'sale-multi' }] : [] };
    const seller = new AdminController(
      { verifyToken: () => ({ role: 'ADMIN' }) } as any,
      { findOne: async () => staged, find: async () => [], update: async (_: any, patch: any) => Object.assign(staged, patch) } as any,
      { findOne: async () => ({ images: [] }), update: async () => { unpublished = true; } } as any,
      { manager, findOne: async () => unit, update: async (_: any, patch: any) => Object.assign(unit, patch) } as any,
      {} as any, {} as any, { enqueueAndDispatch: async () => undefined } as any,
    );
    await seller.markSold('Bearer ok', unit.id, { customerName: 'Cliente', customerPhone: '999111222', salePrice: 25 });
    assert.equal(unit.stock, 2); assert.equal(staged.stock, 2);
    assert.equal(staged.status, 'published'); assert.equal(unpublished, false);
  }
  console.log('Accesorios: registro, edición, costos, permisos, privacidad, publicación y puente OK');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
