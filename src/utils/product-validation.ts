import { CatalogProduct } from '../entities/catalog-product.entity';
import { StagedProduct } from '../entities/staged-product.entity';

const SALE_TYPES = new Set(['PREVENTA', 'VENTA_SIMPLE', 'PROMOCION', 'OFERTA']);
const IPHONE_MODELS = new Set(['Normal', 'Plus', 'Pro', 'Pro Max', 'Mini', 'E']);
const IPHONE_NUMBERS = new Set(['11', '12', '13', '14', '15', '16', '17']);
const SCREEN_SIZES: Record<string, string[]> = {
  macbook: ['13', '14', '15', '16'],
  ipad: ['10.2', '10.9', '11', '12.9', '13'],
};
const IPAD_CONNECTIVITY = new Set(['WiFi', 'WiFi + Celular', 'WiFi+Celular']);
const PRODUCT_CONDITIONS = new Set(['Nuevo', 'Usado', 'Open Box', 'Arreglado']);
const WATCH_TYPES = new Set(['Normal', 'Ultra']);
const WATCH_SERIES = new Set(['5', '6', '7', '8', '9', '10', '11']);
const WATCH_CONNECTIONS = new Set(['GPS', 'GPS+Cellular', 'GPS + Cellular']);
const WATCH_ULTRA = new Set(['1', '2', '3']);
const IPHONE_INCLUDES_VALUES = new Set(['Caja + Cable', 'Caja sola', 'Cable solo', 'Otros', 'Ninguno']);

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  autoTitle?: string;
};

export function parseNotes(notesRaw: any) {
  try {
    if (!notesRaw) return {};
    if (typeof notesRaw === 'string') return JSON.parse(notesRaw);
    return notesRaw || {};
  } catch {
    return {};
  }
}

function normalizeSpaces(value: string) {
  return value.toLowerCase().trim().replace(/\s+/g, ' ');
}

function screenSizeCandidates(value: unknown) {
  const raw = String(value ?? '').trim().toLowerCase().replace(',', '.');
  if (!raw) return [];
  const numeric = raw.match(/\d+(?:\.\d+)?/)?.[0] || raw;
  const candidates = new Set([raw, numeric]);
  const asNumber = Number(numeric);
  if (Number.isFinite(asNumber)) candidates.add(String(Math.floor(asNumber)));
  return Array.from(candidates);
}

function isAllowedScreenSize(value: unknown, category: 'macbook' | 'ipad') {
  const allowed = SCREEN_SIZES[category];
  return screenSizeCandidates(value).some((candidate) => allowed.includes(candidate));
}

function getAllowedIphoneModelsByNumber(numberRaw: unknown) {
  const map: Record<string, string[]> = {
    '11': ['Normal', 'Pro', 'Pro Max'],
    '12': ['Mini', 'Normal', 'Pro', 'Pro Max'],
    '13': ['Mini', 'Normal', 'Pro', 'Pro Max'],
    '14': ['Normal', 'Plus', 'Pro', 'Pro Max'],
    '15': ['Normal', 'Plus', 'Pro', 'Pro Max'],
    '16': ['Normal', 'Plus', 'Pro', 'Pro Max', 'E'],
    '17': ['Normal', 'Plus', 'Pro', 'Pro Max', 'E'],
  };
  return map[String(numberRaw ?? '')] || [];
}

export function buildIphoneTitle(number?: number | string | null, model?: string | null, storageGb?: number | string | null, color?: string | null) {
  const n = number ? String(number).trim() : '';
  const m = model ? String(model).trim() : '';
  const s = storageGb ? String(storageGb).trim() : '';
  const c = color ? String(color).trim() : '';
  if (!n || !m || !s || !c) return '';
  const colorCap = c.charAt(0).toUpperCase() + c.slice(1);
  return `iPhone ${n} ${m} ${s}GB ${colorCap}`.trim();
}

function hasWatermark(url: string) {
  const u = String(url || '').toLowerCase();
  if (!u) return false;
  if (!u.includes('/uploads/')) return true;
  return u.includes('/uploads/wm-') || u.includes('/uploads/watermarked/') || u.includes('/uploads/wm/');
}

export function validateProductBeforePublish(staged: StagedProduct, product?: CatalogProduct): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes = parseNotes(staged.notes);
  const specs = (notes?.specs || notes) as any;
  const detalle = (specs?.detalle || notes?.detalle || {}) as any;

  const category = String(staged.category || specs?.tipo || '').toLowerCase();
  const saleType = String(staged.sale_type || '').toUpperCase();
  const isPreventa = saleType === 'PREVENTA';
  const salePrice = Number(staged.price || 0);
  const discount = Number(staged.discount || 0);
  const discountMode = String(notes?.discountMode || notes?.discountType || 'percent').toLowerCase();
  const minOffer = Number(staged.min_offer_price || 0);
  const preventaFrom = String(notes?.preventaDateFrom || notes?.preventa?.from || '').trim();
  const preventaTo = String(notes?.preventaDateTo || notes?.preventa?.to || '').trim();
  const productCondition = staged.product_condition ?? notes?.productCondition ?? specs?.estado ?? notes?.estado ?? null;

  if (!String(staged.title || '').trim()) errors.push('titulo requerido');
  if (!saleType || !SALE_TYPES.has(saleType)) errors.push('sale_type requerido');
  if (!salePrice || salePrice <= 0) errors.push('precio de venta requerido');
  if (saleType === 'PROMOCION') {
    if (!discount || discount <= 0) errors.push('descuento requerido');
    if (discountMode !== 'amount' && discount > 100) errors.push('descuento porcentaje invalido');
    if (discountMode === 'amount' && discount > salePrice) errors.push('descuento mayor a precio');
  }
  if (saleType === 'OFERTA') {
    if (!minOffer || minOffer <= 0) errors.push('min_offer_price requerido');
    if (minOffer && salePrice && minOffer > salePrice) errors.push('min_offer_price mayor a precio');
  }
  if (saleType === 'PREVENTA') {
    if (!preventaFrom || !preventaTo) errors.push('rango de llegada preventa requerido');
    if (preventaFrom && preventaTo && preventaFrom > preventaTo) {
      errors.push('rango de llegada preventa invalido');
    }
  }

  if (!productCondition) errors.push('product_condition requerido');
  if (productCondition && !PRODUCT_CONDITIONS.has(String(productCondition))) errors.push('product_condition invalido');
  if (productCondition && productCondition !== 'Nuevo') {
    const stockNum = Number(staged.stock ?? 0);
    if (stockNum !== 1) errors.push('stock debe ser 1 para estado usado/open box/arreglado');
  }

  const includesValue = staged.includes || notes?.includes || '';
  const includesExtra = staged.includes_extra || notes?.includesExtra || '';
  const isNew = String(productCondition || '') === 'Nuevo';
  if (!isNew && includesValue === 'Otros' && !includesExtra) errors.push('includes_extra requerido');

  const images = Array.isArray(staged.images) ? staged.images : [];
  if (!images.length) errors.push('imagenes requeridas');
  if (images.some((u: any) => !hasWatermark(String(u || '')))) errors.push('imagenes sin watermark');

  if (category === 'macbook') {
    const screen = String(detalle?.['tamaño'] || detalle?.tamanio || detalle?.tamano || '').trim();
    if (!screen) errors.push('tamano de pantalla requerido');
    if (screen && !isAllowedScreenSize(screen, 'macbook')) errors.push('tamano de pantalla invalido');
    if (!String(detalle?.procesador || '').trim()) errors.push('procesador requerido');
    if (!String(detalle?.ram || '').trim()) errors.push('ram requerida');
    if (!String(detalle?.almacenamiento || '').trim()) errors.push('ssd requerido');
    const ciclos = notes?.bateria?.ciclos ?? '';
    const salud = notes?.bateria?.salud ?? '';
    if (!isPreventa && productCondition !== 'Nuevo') {
      if (ciclos === '' || ciclos === null) errors.push('ciclos de bateria requeridos');
      if (salud === '' || salud === null) errors.push('salud de bateria requerida');
    }
    if (!String(notes?.color || staged.color || '').trim()) errors.push('color requerido');
    if (!isNew && !includesValue) errors.push('incluye requerido');
  }

  if (category === 'ipad') {
    const screen = String(detalle?.['tamaño'] || detalle?.tamanio || detalle?.tamano || '').trim();
    const conn = String(detalle?.conectividad || '').trim();
    const gama = String(detalle?.gama || '').trim();
    const generacion = String(detalle?.generacion || '').trim();
    const procesador = String(detalle?.procesador || '').trim();
    if (!screen) errors.push('tamano de pantalla requerido');
    if (screen && !isAllowedScreenSize(screen, 'ipad')) errors.push('tamano de pantalla invalido');
    if (!gama) errors.push('gama requerida');
    if ((gama === 'Air' || gama === 'Pro') && !procesador) errors.push('procesador requerido');
    if ((gama === 'Normal' || gama === 'Mini') && !generacion) errors.push('generacion requerida');
    if (!String(detalle?.almacenamiento || '').trim()) errors.push('almacenamiento requerido');
    if (!conn) errors.push('conectividad requerida');
    if (conn && !IPAD_CONNECTIVITY.has(conn)) errors.push('conectividad invalida');
    const ciclos = notes?.bateria?.ciclos ?? '';
    const salud = notes?.bateria?.salud ?? '';
    if (!isPreventa && productCondition !== 'Nuevo') {
      if (ciclos === '' || ciclos === null) errors.push('ciclos de bateria requeridos');
      if (salud === '' || salud === null) errors.push('salud de bateria requerida');
    }
    if (!String(notes?.color || staged.color || '').trim()) errors.push('color requerido');
    if (!isNew && !includesValue) errors.push('incluye requerido');
  }

  if (category === 'iphone') {
    const iphoneModel = staged.iphone_model || notes?.iphoneModel;
    const iphoneNumber = staged.iphone_number ?? notes?.iphoneNumber;
    const storageGb = staged.storage_gb ?? notes?.storageGb ?? notes?.storage;
    const batteryCycles = staged.battery_cycles ?? notes?.batteryCycles ?? notes?.bateria?.ciclos;
    const batteryHealth = staged.battery_health ?? notes?.batteryHealth ?? notes?.bateria?.salud;
    const color = staged.color || notes?.color;

    if (!iphoneModel || !IPHONE_MODELS.has(String(iphoneModel))) errors.push('iphone_model requerido');
    if (!iphoneNumber) errors.push('iphone_number requerido');
    if (!storageGb) errors.push('storage requerido');
    if (!Number.isFinite(Number(storageGb)) || Number(storageGb) <= 0) {
      errors.push('storage invalido');
    }
    if (!isPreventa && productCondition !== 'Nuevo' && !batteryHealth && batteryHealth !== 0) errors.push('battery_health requerido');
    if (!color) errors.push('color requerido');
    if (!isNew && !includesValue) errors.push('incluye requerido');
    if (!isNew && includesValue && !IPHONE_INCLUDES_VALUES.has(String(includesValue))) {
      errors.push('incluye invalido para iphone');
    }
    if (!Number.isFinite(Number(iphoneNumber)) || Number(iphoneNumber) <= 0) {
      errors.push('iphone_number invalido');
    }
    if (iphoneNumber && !IPHONE_NUMBERS.has(String(iphoneNumber))) {
      errors.push('iphone_number invalido');
    }
    if (iphoneModel && iphoneNumber) {
      const allowedModels = getAllowedIphoneModelsByNumber(iphoneNumber);
      if (allowedModels.length && !allowedModels.includes(String(iphoneModel))) {
        errors.push('iphone_model invalido para iphone_number');
      }
    }
    if (!isPreventa && productCondition !== 'Nuevo' && iphoneNumber && Number(iphoneNumber) >= 15) {
      if (batteryCycles === '' || batteryCycles === null || batteryCycles === undefined) {
        errors.push('battery_cycles requerido');
      }
    }
    if (productCondition !== 'Nuevo' && batteryHealth && (Number(batteryHealth) < 1 || Number(batteryHealth) > 100)) {
      errors.push('battery_health invalido');
    }
    const autoTitle = buildIphoneTitle(iphoneNumber, String(iphoneModel), storageGb, String(color));
    if (!autoTitle && normalizeSpaces(String(staged.title || '')) === 'iphone') {
      errors.push('titulo iphone invalido');
    }
    if (autoTitle) {
      if (normalizeSpaces(String(staged.title || '')) !== normalizeSpaces(autoTitle)) {
        warnings.push('titulo iphone ajustado');
      }
      return { ok: errors.length === 0, errors, warnings, autoTitle };
    }
  }

  if (category === 'watch') {
    const watchType = String(notes?.watchType || '').trim();
    const color = String(notes?.color || staged.color || '').trim();
    if (!watchType || !WATCH_TYPES.has(watchType)) errors.push('watchType requerido');
    if (!color) errors.push('color requerido');
    if (watchType === 'Normal') {
      const series = String(notes?.watchSeries || '').trim();
      const conn = String(notes?.watchConnection || '').trim();
      if (!series || !WATCH_SERIES.has(series)) errors.push('watchSeries requerido');
      if (!conn || !WATCH_CONNECTIONS.has(conn)) errors.push('watchConnection requerido');
    }
    if (watchType === 'Ultra') {
      const version = String(notes?.watchVersion || '').trim();
      if (!version || !WATCH_ULTRA.has(version)) errors.push('watchVersion requerido');
    }
  }

  if (category === 'otros') {
    const desc = String(detalle?.descripcionOtro || notes?.descripcionOtro || '').trim();
    if (!desc) errors.push('descripcion requerida');
    if (!String(notes?.color || staged.color || '').trim()) errors.push('color requerido');
    if (!isNew && !includesValue) errors.push('incluye requerido');
  }

  return { ok: errors.length === 0, errors, warnings };
}


