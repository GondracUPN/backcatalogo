import { validateProductBeforePublish } from '../utils/product-validation';
import { StagedProduct } from '../entities/staged-product.entity';

function makeBase(): StagedProduct {
  return {
    id: 'x',
    source_id: 'y',
    sku: 'sku',
    title: 'iPhone 15 Pro 256GB Silver',
    price: '1000',
    iphone_model: 'Pro',
    iphone_number: 15,
    storage_gb: 256,
    battery_cycles: 10,
    battery_health: 95,
    color: 'Silver',
    includes: 'Caja + Cable',
    includes_extra: null,
    keyboard_layout: null,
    sale_type: 'OFERTA',
    discount: null,
    final_price: null,
    min_offer_price: '800',
    stock: 1,
    status: 'draft',
    product_condition: 'Nuevo',
    category: 'iphone',
    tags: null,
    images: ['/uploads/wm-test.jpg'],
    notes: JSON.stringify({ color: 'Silver', bateria: { ciclos: 10, salud: 95 }, iphoneNumber: 15, storageGb: 256, includes: 'Caja + Cable' }),
    updated_at: new Date(),
    created_at: new Date(),
  } as StagedProduct;
}

function assert(cond: any, message: string) {
  if (!cond) throw new Error(message);
}

const base = makeBase();
const res = validateProductBeforePublish(base);
assert(res.ok, `expected ok, got errors: ${res.errors.join(', ')}`);

const noCycles = makeBase();
noCycles.battery_cycles = null as any;
noCycles.battery_health = 95;
noCycles.product_condition = 'Usado';
noCycles.notes = JSON.stringify({ color: 'Silver', bateria: { salud: 95 }, iphoneNumber: 15, storageGb: 256, includes: 'Caja + Cable' });
const resNoCycles = validateProductBeforePublish(noCycles);
assert(!resNoCycles.ok, `expected fail without battery_cycles for iPhone 15, got errors: ${resNoCycles.errors.join(', ')}`);

const iphone14 = makeBase();
iphone14.iphone_number = 14;
iphone14.battery_cycles = null as any;
iphone14.battery_health = 95;
iphone14.product_condition = 'Usado';
iphone14.notes = JSON.stringify({ color: 'Silver', bateria: { salud: 95 }, iphoneNumber: 14, storageGb: 256, includes: 'Caja + Cable' });
const res14 = validateProductBeforePublish(iphone14);
assert(res14.ok, `expected ok without battery_cycles for iPhone 14, got errors: ${res14.errors.join(', ')}`);

const broken = makeBase();
broken.battery_health = null as any;
broken.product_condition = 'Usado';
broken.notes = JSON.stringify({ color: 'Silver', bateria: { ciclos: 10 }, iphoneNumber: 15, storageGb: 256, includes: 'Caja + Cable' });
const res2 = validateProductBeforePublish(broken);
assert(!res2.ok, 'expected validation to fail without battery health');

const macbookDecimalScreen = {
  ...makeBase(),
  title: 'MacBook Air M2 13.6',
  category: 'macbook',
  iphone_model: null,
  iphone_number: null,
  storage_gb: null,
  battery_cycles: null,
  battery_health: null,
  includes: 'Caja + Cable',
  product_condition: 'Nuevo',
  sale_type: 'VENTA_SIMPLE',
  min_offer_price: null,
  notes: JSON.stringify({
    color: 'Silver',
    includes: 'Caja + Cable',
    specs: {
      detalle: {
        tamaño: '13.6 pulgadas',
        procesador: 'M2',
        ram: '8 GB',
        almacenamiento: '256 GB',
      },
    },
  }),
} as StagedProduct;
const resMacbookDecimalScreen = validateProductBeforePublish(macbookDecimalScreen);
assert(resMacbookDecimalScreen.ok, `expected ok with decimal MacBook screen, got errors: ${resMacbookDecimalScreen.errors.join(', ')}`);

const ipad13Screen = {
  ...makeBase(),
  title: 'iPad Pro M4 13',
  category: 'ipad',
  iphone_model: null,
  iphone_number: null,
  storage_gb: null,
  battery_cycles: null,
  battery_health: null,
  includes: 'Caja + Cable',
  product_condition: 'Nuevo',
  sale_type: 'VENTA_SIMPLE',
  min_offer_price: null,
  notes: JSON.stringify({
    color: 'Silver',
    includes: 'Caja + Cable',
    specs: {
      detalle: {
        tamaño: '13',
        procesador: 'M4',
        gama: 'Pro',
        almacenamiento: '256 GB',
        conectividad: 'WiFi',
      },
    },
  }),
} as StagedProduct;
const resIpad13Screen = validateProductBeforePublish(ipad13Screen);
assert(resIpad13Screen.ok, `expected ok with iPad 13 screen, got errors: ${resIpad13Screen.errors.join(', ')}`);

// eslint-disable-next-line no-console
console.log('validate-product.test.ts ok');
