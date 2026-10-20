// Normalización y comparación de nombres de lugares de entrega.
// - `locationKey`: clave exacta. Solo ignora mayúsculas, tildes, signos y el
//   prefijo genérico "centro comercial"/"cc"/"mall", así que "CC Jockey Plaza"
//   y "Centro Comercial Jockey Plaza" coinciden automáticamente.
// - `similarity`: para sugerir coincidencias probables ("Jockey" ~ "Jockey Plaza")
//   que una persona debe confirmar. Nunca se fusionan solas.

const GENERIC_PREFIXES = [/^centro comercial\s+/, /^c\s*c\s+/, /^cc\s+/, /^mall\s+/, /^c\.?c\.?\s+/];
const STOPWORDS = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'en', 'y', 'centro', 'comercial', 'cc', 'mall', 'plaza', 'av', 'avenida', 'jr', 'jiron', 'calle']);

export function cleanText(value: unknown) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}+/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function locationKey(value: unknown) {
  let text = cleanText(value);
  for (const prefix of GENERIC_PREFIXES) text = text.replace(prefix, '');
  return text.trim();
}

function tokens(value: unknown) {
  return cleanText(value).split(' ').filter((token) => token && !STOPWORDS.has(token));
}

/** 0..1. 1 = mismas palabras significativas. */
export function similarity(a: unknown, b: unknown) {
  const ka = locationKey(a);
  const kb = locationKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared += 1;
  const jaccard = shared / (ta.size + tb.size - shared);
  // Si todas las palabras de uno están en el otro ("jockey" ⊂ "jockey plaza").
  const containment = shared / Math.min(ta.size, tb.size);
  return Math.max(jaccard, containment * 0.9);
}

export type PointLike = { id: string; name: string; aliases?: string[] | null; name_key?: string; alias_keys?: string[] | null; active?: boolean };

/** Coincidencia exacta por clave normalizada (nombre o alias). */
export function exactPointMatch<T extends PointLike>(text: unknown, points: T[]): T | null {
  const key = locationKey(text);
  if (!key) return null;
  return points.find((point) => (point.name_key || locationKey(point.name)) === key
    || (point.alias_keys || (point.aliases || []).map(locationKey)).includes(key)) || null;
}

/** Sugerencias ordenadas por parecido (sin la coincidencia exacta). */
export function suggestPoints<T extends PointLike>(text: unknown, points: T[], minScore = 0.5, limit = 3) {
  return points
    .map((point) => ({
      point,
      score: Math.max(similarity(text, point.name), ...(point.aliases || []).map((alias) => similarity(text, alias))),
    }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
