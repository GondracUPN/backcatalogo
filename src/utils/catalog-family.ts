// Reglas públicas de inventario del catálogo, en un solo lugar.
//
// 1) Disponibilidad: qué unidades se pueden ofrecer. La condición (nuevo,
//    open box, usado) no tiene nada que ver: un equipo usado puede estar
//    disponible y uno nuevo puede estar vendido.
// 2) Familia: qué unidades físicas son el mismo modelo comercial, para el
//    selector «Otras unidades disponibles». Se arma con datos estructurados
//    (gama, chip, tamaño, serie/versión, conectividad); el título solo se usa
//    cuando faltan esos datos, y nunca se agrupa por parecido de texto.
import { parseRowNotes } from './public-catalog';

export type PublicAvailability = 'available' | 'preorder' | 'reserved' | 'sold';

type Row = { status?: string | null; stock?: unknown; sale_type?: string | null } | null | undefined;

/**
 * - sold: marcado como vendido (en producto o en inventario), o sin stock propio
 *   (salvo preventa, que se publica antes de tener stock).
 * - reserved: tiene stock, pero todas sus unidades están retenidas por solicitudes vigentes.
 * - preorder: preventa (equipo en camino) con cupo.
 * - available: se puede solicitar para entrega.
 * `reservedQty` son las unidades retenidas; `stock` debe ser el stock real (sin descontar).
 */
export function publicAvailability(product: Row, staged: Row, reservedQty = 0, saleType = ''): PublicAvailability {
  const status = (value: unknown) => String(value || '').toLowerCase();
  if (status(product?.status) === 'sold' || status(staged?.status) === 'sold') return 'sold';
  const stock = Number(product?.stock ?? staged?.stock ?? 0);
  const held = Math.max(0, Number(reservedQty) || 0);
  const type = String(saleType || product?.sale_type || staged?.sale_type || '').toUpperCase();
  // La preventa publicada se sigue mostrando como hasta ahora aunque su cupo
  // figure en 0 (el equipo aún no llega); solo se oculta si se vendió o si
  // todo su cupo está retenido por solicitudes.
  if (type === 'PREVENTA') return Number.isFinite(stock) && stock > 0 && stock - held <= 0 ? 'reserved' : 'preorder';
  if (!Number.isFinite(stock) || stock <= 0) return 'sold';
  if (stock - held <= 0) return 'reserved';
  return 'available';
}

/** Solo estas unidades aparecen en listados, buscador, selector y recomendaciones. */
export function isSellable(availability: PublicAvailability) {
  return availability === 'available' || availability === 'preorder';
}

export const AVAILABILITY_LABEL: Record<PublicAvailability, string> = {
  available: 'Disponible',
  preorder: 'En camino',
  reserved: 'Reservado',
  sold: 'Vendido',
};

const norm = (value: unknown) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .replace(/\s+/g, ' ');

const digits = (value: unknown) => String(value ?? '').match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(',', '.') || '';

function detailOf(notes: any) {
  return notes?.specs?.detalle || notes?.detalle || {};
}

function sizeOf(notes: any, extra?: unknown) {
  const det = detailOf(notes);
  return digits(det?.['tamaño'] ?? det?.tamanio ?? det?.tamano ?? extra);
}

/** Wi-Fi o Wi-Fi + celular, desde los datos o el título del iPad. */
function ipadConnectivity(notes: any, title: string) {
  const text = norm([detailOf(notes)?.conectividad, notes?.conectividad, notes?.watchConnection, title].filter(Boolean).join(' '));
  if (/celular|cellular|5g|lte/.test(text)) return 'cell';
  if (/wi-?fi/.test(text)) return 'wifi';
  return '';
}

/**
 * Clave de familia. Dos unidades son «el mismo modelo» solo si sus claves son
 * idénticas. Varían libremente color, RAM, almacenamiento, condición y precio.
 * - MacBook: gama + chip + pantalla (Air M2 13 ≠ Air M2 15 ≠ Air M3 13).
 * - iPad: gama + chip + pantalla + conectividad.
 * - iPhone: número + modelo (15 ≠ 15 Pro ≠ 15 Pro Max).
 * - Apple Watch: tipo + serie/versión + tamaño + conexión (Ultra 2 ≠ Ultra 3).
 * Sin esos datos, la familia es el grupo de variantes del panel o, en su
 * defecto, el título exacto: es decir, solo se agrupa lo que el panel ya agrupó.
 */
export function familyKey(category: string, product: any, staged: any): string {
  const notes = parseRowNotes(staged);
  const det = detailOf(notes);
  const title = String(product?.title || staged?.title || '');
  const cat = norm(category);
  const gamaFromTitle = title.match(/\b(air|pro|neo|mini)\b/i)?.[1] || '';
  const chip = norm(det?.procesador).replace(/\s+/g, '');

  let parts: string[] = [];
  if (cat === 'macbook') {
    parts = [norm(det?.gama || gamaFromTitle), chip, sizeOf(notes)];
  } else if (cat === 'ipad') {
    // «iPad» a secas no tiene gama: se usa «base» para no confundirlo.
    parts = [norm(det?.gama || gamaFromTitle || 'base'), chip, sizeOf(notes), ipadConnectivity(notes, title)];
  } else if (cat === 'iphone') {
    const number = digits(product?.iphone_number ?? staged?.iphone_number ?? notes?.iphoneNumber ?? det?.numero);
    const model = norm(product?.iphone_model || staged?.iphone_model || notes?.iphoneModel || det?.modelo || 'base');
    parts = [number, model];
  } else if (cat === 'watch') {
    const type = norm(notes?.watchType || (/ultra/i.test(title) ? 'ultra' : /\bse\b/i.test(title) ? 'se' : ''));
    const generation = digits(type === 'ultra' ? notes?.watchVersion : notes?.watchSeries);
    parts = [type, generation, sizeOf(notes, notes?.watchSize), norm(notes?.watchConnection).replace(/\s+/g, '')];
  }
  if (parts.length && parts.every(Boolean)) return `${cat}:${parts.join('|')}`;

  const group = norm(product?.variant_group || staged?.variant_group || notes?.variantGroup || notes?.variant_group || title);
  return group ? `${cat}:g:${group}` : '';
}
