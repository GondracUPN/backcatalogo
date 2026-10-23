// Campos de producto e inventario que se pueden mostrar al público. Nunca
// incluye el precio mínimo de oferta ni datos internos de las notas (costo,
// proveedor…). Lo usan el catálogo y el carrito.
import { CatalogProduct } from '../entities/catalog-product.entity';
import { StagedProduct } from '../entities/staged-product.entity';
import { normalizeAppleTitle, normalizeColorName } from './display-names';

export function parseRowNotes(row: any) {
  try {
    return row?.notes && typeof row.notes === 'string' ? JSON.parse(row.notes) : row?.notes || {};
  } catch {
    return {};
  }
}

export function publicNotes(staged: StagedProduct | null) {
  const notes = parseRowNotes(staged);
  const specs = notes?.specs || {};
  const sourceDetail = specs?.detalle || notes?.detalle || {};
  const detailKeys = [
    'gama', 'procesador', 'generacion', 'numero', 'modelo',
    'tamaño', 'tamanio', 'tamano', 'almacenamiento', 'ram',
    'conexion', 'conectividad', 'esim', 'sim', 'descripcionOtro',
    'detalles', 'productDetails', 'detailImages', 'modeloHardware',
  ];
  const detail = Object.fromEntries(
    detailKeys
      .filter((key) => sourceDetail?.[key] !== undefined)
      .map((key) => [key, sourceDetail[key]]),
  );
  const publicKeys = [
    'saleType', 'discount', 'discountMode', 'discountType', 'finalPrice',
    'precioLista', 'descuentoPorc', 'color', 'batteryHealth', 'batteryCycles',
    'bateria', 'iphoneModel', 'iphoneNumber', 'storageGb', 'storage',
    'iphoneSimType', 'simType', 'chipType', 'preventaDateFrom', 'preventaDateTo',
    'preventa', 'warrantyDate', 'warrantyEnabled', 'warrantyType', 'garantiaFecha', 'garantia',
    'garantiaActiva', 'garantiaTipo', 'conectividad', 'watchType', 'watchSeries', 'watchVersion',
    'watchConnection', 'watchAccessories', 'watchIncludes', 'productCondition',
    'watchSize', 'estado', 'includes', 'includesExtra', 'incluye', 'descripcionOtro',
    'cuboFake', 'cableFake', 'desktopVariant',
    'productDetails', 'detalles', 'detailImages', 'detailPhotos',
  ];
  const result = Object.fromEntries(
    publicKeys
      .filter((key) => notes?.[key] !== undefined)
      .map((key) => [key, notes[key]]),
  ) as any;
  if (result.color !== undefined) result.color = normalizeColorName(result.color) || null;
  result.detalle = detail;
  result.specs = {
    tipo: specs?.tipo ?? null,
    estado: specs?.estado ?? notes?.estado ?? null,
    sim: specs?.sim ?? detail?.sim ?? detail?.esim ?? null,
    conCaja: specs?.conCaja ?? null,
    detalle: detail,
  };
  return result;
}

export function publicProduct(product: CatalogProduct | null) {
  if (!product) return null;
  return {
    id: product.id,
    sku: product.sku,
    title: normalizeAppleTitle(product.title),
    price: product.price,
    iphone_model: product.iphone_model,
    iphone_number: product.iphone_number,
    storage_gb: product.storage_gb,
    battery_cycles: product.battery_cycles,
    battery_health: product.battery_health,
    color: normalizeColorName(product.color) || null,
    includes: product.includes,
    includes_extra: product.includes_extra,
    keyboard_layout: product.keyboard_layout,
    presentation: product.presentation ?? null,
    sale_type: product.sale_type,
    discount: product.discount,
    final_price: product.final_price,
    status: product.status,
    product_condition: product.product_condition,
    stock: product.stock,
  };
}

export function publicStaged(staged: StagedProduct | null) {
  if (!staged) return null;
  return {
    sku: staged.sku,
    title: normalizeAppleTitle(staged.title),
    price: staged.price,
    iphone_model: staged.iphone_model,
    iphone_number: staged.iphone_number,
    storage_gb: staged.storage_gb,
    battery_cycles: staged.battery_cycles,
    battery_health: staged.battery_health,
    color: normalizeColorName(staged.color) || null,
    includes: staged.includes,
    includes_extra: staged.includes_extra,
    keyboard_layout: staged.keyboard_layout,
    presentation: staged.presentation ?? null,
    sale_type: staged.sale_type,
    discount: staged.discount,
    final_price: staged.final_price,
    stock: staged.stock,
    status: staged.status,
    product_condition: staged.product_condition,
    category: staged.category,
    images: staged.images,
    notes: publicNotes(staged),
  };
}

