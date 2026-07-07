import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { SyncController } from '../modules/sync/sync.controller';

async function main() {
  const productUpserts: any[] = [];
  const stagedUpserts: any[] = [];
  const products = {
    upsert: async (value: any) => { productUpserts.push(value); },
  };
  const logs = {
    findOne: async () => null,
    create: (value: any) => value,
    save: async (value: any) => value,
  };
  const staged = {
    upsert: async (value: any) => { stagedUpserts.push(value); },
  };
  const controller = new SyncController(products as any, logs as any, staged as any);
  const originalSecret = process.env.SYNC_SECRET;
  const originalFetch = globalThis.fetch;
  process.env.SYNC_SECRET = 'sync-test-secret';
  (globalThis as any).fetch = async () => ({ ok: true });

  const body = {
    event: 'product.listed',
    product: {
      id: 42,
      sku: 'svc-42',
      title: 'iPhone 15 Pro',
      price: '2500',
      status: 'listed',
      stock: 1,
      saleType: 'OFERTA',
      minOfferPrice: 2300,
      color: 'Space Black',
      batteryCycles: 5,
      batteryHealth: 100,
      productCondition: 'usado',
      specs: { tipo: 'iphone', estado: 'usado', detalle: { almacenamiento: '256 GB' } },
    },
  };
  const signature = crypto
    .createHmac('sha256', process.env.SYNC_SECRET || '')
    .update(JSON.stringify(body))
    .digest('hex');

  try {
    await controller.syncProduct(signature, 'sync-inventory-fields-42', body);
  } finally {
    if (originalSecret === undefined) delete process.env.SYNC_SECRET;
    else process.env.SYNC_SECRET = originalSecret;
    (globalThis as any).fetch = originalFetch;
  }

  assert.equal(productUpserts[0].price, '2500');
  assert.equal(productUpserts[0].min_offer_price, 2300);
  assert.equal(productUpserts[0].color, 'Space Black');
  assert.equal(productUpserts[0].battery_cycles, 5);
  assert.equal(productUpserts[0].battery_health, 100);
  assert.equal(stagedUpserts[0].sale_type, 'OFERTA');
  assert.equal(stagedUpserts[0].min_offer_price, 2300);
  assert.equal(stagedUpserts[0].color, 'Space Black');
  assert.equal(stagedUpserts[0].battery_cycles, 5);
  assert.equal(stagedUpserts[0].battery_health, 100);

  const notes = JSON.parse(stagedUpserts[0].notes);
  assert.equal(notes.precioLista, '2500');
  assert.equal(notes.minOfferPrice, 2300);
  assert.deepEqual(notes.bateria, { ciclos: 5, salud: 100 });
  console.log('sync inventory fields test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
