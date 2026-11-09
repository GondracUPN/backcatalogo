import { strict as assert } from 'assert';
import { accessoryPackTotal, readAccessoryPack } from '../utils/accessory-pack';
import { accessoryFields } from '../utils/accessory-fields';
import { publicNotes } from '../utils/public-catalog';
import { CartController } from '../modules/cart/cart.controller';
import { PurchaseRequestsService } from '../modules/purchase-requests/purchase-requests.service';

async function main() {
  const pack = { units: 6, price: 25.99, label: 'Caja' };
  assert.deepEqual(readAccessoryPack({ ...pack, cost: 1, supplier: 'privado' }), pack);
  for (const bad of [{ ...pack, units: 1 }, { ...pack, units: 4.5 }, { ...pack, price: -1 }, { ...pack, price: Infinity }, { ...pack, label: '' }]) {
    assert.equal(readAccessoryPack(bad), null);
    assert.throws(() => accessoryFields({ accessoryPack: bad }));
  }
  assert.equal(accessoryPackTotal(5, 5, pack), 25);
  assert.equal(accessoryPackTotal(5, 6, pack), 25.99);
  assert.equal(accessoryPackTotal(5, 13, pack), 56.98);
  assert.equal(accessoryPackTotal(5, 13, null), 65);
  assert.equal(accessoryPackTotal(3.5, 9, { units: 4, price: 10.99, label: 'Paquete' }), 25.48);
  const fields = accessoryFields({ accessoryPack: pack, accessoryCosts: { purchase: 10, shipping: 2 } }, { accessoryCode: 7 });
  assert.deepEqual(JSON.parse(fields.notes!).accessoryPack, pack);
  assert.equal(JSON.parse(fields.notes!).valor.costoTotal, 12);
  assert.equal(JSON.parse(accessoryFields({ accessoryPack: null }, JSON.parse(fields.notes!)).notes!).accessoryPack, null);
  const staged = { category: 'accesorios', notes: fields.notes } as any;
  assert.deepEqual(publicNotes(staged).accessoryPack, pack);
  assert.doesNotMatch(JSON.stringify(publicNotes(staged)), /costo|supplier/);
  assert.equal(publicNotes({ ...staged, category: 'macbook' }).accessoryPack, undefined);

  const cart = new CartController({} as any, {} as any, {} as any, {} as any) as any;
  const product = { id: 'acc', sku: 'acc-7', price: '5', product_condition: 'Usado', stock: 12, status: 'listed', sale_type: 'VENTA_SIMPLE' };
  assert.doesNotThrow(() => cart.assertAvailableQuantity(product, 12, staged));
  assert.throws(() => cart.assertAvailableQuantity(product, 13, staged), /unidades/);
  assert.throws(() => cart.assertAvailableQuantity(product, 2, { ...staged, category: 'macbook' }), /unidades/);
  assert.equal(cart.resolveRowTotal({ qty: 12 }, product, staged), 51.98);
  assert.equal(cart.resolveRowTotal({ qty: 12, offer_price: '4' }, product, staged), 48);
  assert.equal(cart.resolveRowTotal({ qty: 12 }, product, { ...staged, category: 'macbook' }), 60);
  // Una caja cuyo total no se divide exactamente entre sus piezas conserva el centavo.
  const calls: Array<{ sql: string; args: any[] }> = [];
  const mgr = { query: async (sql: string, args: any[] = []) => {
    calls.push({ sql, args });
    if (sql.includes('nextval')) return [{ seq: 1 }];
    if (sql.includes('INSERT INTO purchase_requests')) return [{ id: 'request', number: 'SOL-000001' }];
    return [];
  } };
  await new PurchaseRequestsService({} as any).createInTransaction(mgr as any, {
    submissionKey: null, ownerGroup: 'shared', ownerUserId: null, contactRequestId: null,
    customerName: 'Prueba', customerPhone: '000000000', deliveryOptionId: null, deliveryOptionName: null,
    deliveryKind: null, deliveryPointId: null, locationText: null, district: null, address: null, notes: null, deliveryCost: 0,
    items: [{ productId: 'acc', sku: 'acc-7', title: 'Cable', color: null, qty: 3, unitPrice: 100 / 3, lineTotal: 100 }],
  });
  assert.equal(calls.find((call) => call.sql.includes('INSERT INTO purchase_requests ('))!.args[15], '100.00');
  const line = calls.find((call) => call.sql.includes('INSERT INTO purchase_request_items'))!.args;
  assert.equal(line[5], 3, 'reserva piezas reales, no cajas');
  assert.equal(line[7], '100.00');
  console.log('accessory-packs: validación, precios exactos, stock, privacidad y solicitudes OK');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
