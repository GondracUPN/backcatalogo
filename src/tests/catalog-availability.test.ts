import { strict as assert } from 'assert';
import { CatalogController } from '../modules/catalog/catalog.controller';
import { familyKey, isSellable, publicAvailability } from '../utils/catalog-family';
import { CartController } from '../modules/cart/cart.controller';

const controller = new CatalogController({} as any, {} as any, {} as any, {} as any);
const compact = (controller as any).compactRow.bind(controller);
const pub = { id: 'pub-1', product_id: 'prod-1', slug: 'macbook-test', category: 'macbook', is_published: true, images: [] } as any;
const product = { id: 'prod-1', sku: 'MS-1', title: 'MacBook Test', price: 1000, status: 'listed', stock: 1, sale_type: 'VENTA_SIMPLE' } as any;

// Etiquetas de la tarjeta.
assert.equal(compact(pub, product, undefined).availabilityLabel, 'Disponible');
assert.equal(compact(pub, { ...product, sale_type: 'PREVENTA' }, undefined).availabilityLabel, 'En camino');
assert.equal(compact(pub, { ...product, stock: 0 }, undefined).availabilityLabel, 'Vendido');
assert.equal(compact(pub, { ...product, status: 'sold' }, undefined).availabilityLabel, 'Vendido');
assert.equal(compact(pub, product, { status: 'sold', stock: 0, notes: {} } as any).availabilityLabel, 'Vendido');
assert.equal(compact(pub, { ...product, sale_type: 'PREVENTA' }, undefined).available, true);
assert.equal(compact(pub, product, undefined, 'reserved').available, false);

// Disponibilidad: la condición (usado) no influye; el estado de inventario sí.
const usado = { ...product, product_condition: 'Usado' };
assert.equal(publicAvailability(usado, null), 'available');
assert.equal(publicAvailability({ ...usado, status: 'sold', stock: 1 }, null), 'sold', 'vendido aunque quede stock por error');
assert.equal(publicAvailability(product, { status: 'sold', stock: 0 }), 'sold', 'vendido en inventario');
assert.equal(publicAvailability({ ...product, stock: 0 }, null), 'sold', 'sin stock');
assert.equal(publicAvailability(product, null, 1), 'reserved', 'todo el stock retenido por una solicitud');
assert.equal(publicAvailability({ ...product, stock: 3 }, null, 1), 'available', 'quedan unidades libres');
assert.equal(publicAvailability({ ...product, sale_type: 'PREVENTA' }, null), 'preorder');
assert.equal(publicAvailability({ ...product, sale_type: 'PREVENTA', status: 'sold' }, null), 'sold');
assert.equal(publicAvailability({ ...product, sale_type: 'PREVENTA', stock: 0 }, null), 'preorder', 'preventa publicada sin cupo cargado');
assert.equal(publicAvailability({ ...product, sale_type: 'PREVENTA', stock: 1 }, null, 1), 'reserved', 'preventa con todo el cupo retenido');
assert.deepEqual(['available', 'preorder', 'reserved', 'sold'].map((a) => isSellable(a as any)), [true, true, false, false]);

// Familias: datos reales del inventario (octubre 2026).
const watch = (title: string, notes: any) => familyKey('watch', { title }, { notes: JSON.stringify(notes) });
const ultra3a = watch('Apple Watch Ultra 49 mm', { watchType: 'Ultra', watchVersion: '3', watchSize: '49', watchConnection: 'GPS + Cellular' });
const ultra3b = watch('Apple Watch Ultra 49 mm', { watchType: 'Ultra', watchVersion: '3', watchConnection: 'GPS + Cellular', specs: { detalle: { 'tamaño': '49 mm' } } });
const ultra3c = watch('Apple Watch Ultra 3 49 mm GPS + Cellular', { watchType: 'Ultra', watchVersion: '3', watchSize: '49', watchConnection: 'GPS + Cellular' });
const ultra2 = watch('Apple Watch Ultra 49 mm', { watchType: 'Ultra', watchVersion: '2', watchSize: '49', watchConnection: 'GPS + Cellular' });
assert.equal(ultra3a, ultra3b, 'mismo Ultra 3 con el tamaño en otro campo');
assert.equal(ultra3a, ultra3c, 'mismo Ultra 3 con otro título');
assert.notEqual(ultra3a, ultra2, 'Ultra 2 no se mezcla con Ultra 3 aunque el título sea igual');
const s11gps = watch('Apple Watch Series 11 42 mm GPS', { watchType: 'Normal', watchSeries: '11', watchSize: '42', watchConnection: 'GPS' });
const s11cell = watch('Apple Watch Series 11 46 mm GPS + Cellular', { watchType: 'Normal', watchSeries: '11', watchSize: '46', watchConnection: 'GPS + Cellular' });
const s11cell2 = watch('Apple Watch Series 46 mm', { watchType: 'Normal', watchSeries: '11', watchConnection: 'GPS + Cellular', specs: { detalle: { 'tamaño': '46 mm' } } });
assert.notEqual(s11gps, s11cell, '42 mm GPS ≠ 46 mm celular');
assert.equal(s11cell, s11cell2);

const mac = (title: string, gama: string, chip: string, size: string) =>
  familyKey('macbook', { title }, { notes: JSON.stringify({ specs: { detalle: { gama, procesador: chip, 'tamaño': size } } }) });
assert.equal(mac('MacBook Air M2 13', 'Air', 'M2', '13'), mac('MacBook Air M2 13', 'Air', 'M2', '13'));
assert.notEqual(mac('MacBook Air M2 13', 'Air', 'M2', '13'), mac('MacBook Air M2 15', 'Air', 'M2', '15'), 'tamaño');
assert.notEqual(mac('MacBook Air M2 13', 'Air', 'M2', '13'), mac('MacBook Air M3 13', 'Air', 'M3', '13'), 'chip');
assert.notEqual(mac('MacBook Air M4 13', 'Air', 'M4', '13'), mac('MacBook Pro M4 14', 'Pro', 'M4', '14'), 'gama');

const iphone = (number: string, model: string) => familyKey('iphone', { title: `iPhone ${number} ${model}`, iphone_number: number, iphone_model: model }, { notes: '{}' });
assert.notEqual(iphone('15', 'Pro'), iphone('15', 'Pro Max'));
assert.notEqual(iphone('15', 'Pro'), iphone('16', 'Pro'));
assert.equal(familyKey('iphone', { title: 'iPhone 15', iphone_number: 15 }, { notes: '{}' }), familyKey('iphone', { title: 'iPhone 15 128GB', iphone_number: 15 }, { notes: '{}' }), 'el iPhone base agrupa por número');
assert.notEqual(familyKey('iphone', { title: 'iPhone 15', iphone_number: 15 }, { notes: '{}' }), iphone('15', 'Pro'));

const ipad = (title: string, notes: any) => familyKey('ipad', { title }, { notes: JSON.stringify(notes) });
const ipadCell = ipad('IPad Pro M5 13 WiFi + Celular', { specs: { detalle: { gama: 'Pro', procesador: 'M5', 'tamaño': '13' } }, watchConnection: 'GPS + Cellular' });
const ipadCellNoConn = ipad('IPad Pro M5 13 WiFi + Celular', { specs: { detalle: { gama: 'Pro', procesador: 'M5', 'tamaño': '13' } } });
const ipadWifi = ipad('IPad Pro M5 13 WiFi', { specs: { detalle: { gama: 'Pro', procesador: 'M5', 'tamaño': '13' } } });
assert.equal(ipadCell, ipadCellNoConn, 'conectividad desde el título si falta el dato');
assert.notEqual(ipadCell, ipadWifi);

// Sin datos estructurados: solo el grupo del panel o el título exacto.
const otro = (title: string, group?: string) => familyKey('otros', { title, variant_group: group }, { notes: '{}' });
assert.equal(otro('AirPods Max 2'), otro('AirPods Max 2'));
assert.notEqual(otro('AirPods Max 2'), otro('AirPods Max'));
assert.equal(otro('AirPods Pro 3', 'airpods pro 3'), otro('AirPods Pro 3 USB-C', 'AirPods Pro 3'), 'grupo explícito del panel');
const macIncomplete = familyKey('macbook', { title: 'MacBook Air M2 13' }, { notes: '{}' });
assert.equal(macIncomplete, 'macbook:g:macbook air m2 13', 'sin chip ni tamaño se usa el título exacto');

console.log('catalog-availability.test.ts ok');

// El carrito vuelve a comprobar la unidad al agregarla: una vendida o sin
// unidades libres no entra en una solicitud nueva.
const cart = Object.create(CartController.prototype) as any;
assert.throws(() => cart.assertAvailableQuantity({ status: 'sold', stock: 1 }, 1), /ya se vendió/);
assert.throws(() => cart.assertAvailableQuantity({ status: 'listed', stock: 0 }, 1), /agotado o reservado/);
assert.doesNotThrow(() => cart.assertAvailableQuantity({ status: 'listed', stock: 1, product_condition: 'Usado' }, 1));
console.log('cart re-check ok');
