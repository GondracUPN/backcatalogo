// Normaliza textos que se muestran al público (no modifica la base de datos):
// marcas Apple bien escritas y nombres de color sin duplicados ni erratas.

const COLOR_ALIASES: Record<string, string> = {
  spaceblack: 'Space Black',
  spaceblacke: 'Space Black',
  blackspace: 'Space Black',
  spacegray: 'Space Gray',
  spacegrey: 'Space Gray',
  skyblue: 'Sky Blue',
  jetblack: 'Jet Black',
  rosegold: 'Rose Gold',
  indigo: 'Indigo',
};

const colorKey = (value: string) =>
  value.normalize('NFD').replace(/\p{Diacritic}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

export function normalizeColorName(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const alias = COLOR_ALIASES[colorKey(text)];
  if (alias) return alias;
  // "Jet black" → "Jet Black"; respeta letras ya mayúsculas o con tilde.
  return text
    .split(' ')
    .map((word) => (word ? word.charAt(0).toLocaleUpperCase('es') + word.slice(1) : word))
    .join(' ');
}

export function normalizeAppleTitle(value: unknown): string {
  const text = String(value ?? '');
  if (!text) return text;
  const normalized = text
    .replace(/\bi(phone|pad|mac|pod)\b/gi, (_, rest: string) => `i${rest.charAt(0).toUpperCase()}${rest.slice(1).toLowerCase()}`)
    .replace(/\bmacbook\b/gi, 'MacBook')
    .replace(/\bairpods\b/gi, 'AirPods');
  // Solo posiciones que representan pantallas: no el modelo de iPhone,
  // la generación de un iPad base, los mm de Watch ni la capacidad/RAM.
  // Admite la generación antes del tamaño: "iPad mini 7 8.3".
  return normalized.replace(
    /(\b(?:MacBook(?:\s+(?:Air|Pro|Neo))?|iPad\s+(?:Pro|Air|mini)|iMac|Studio Display|Pro Display XDR)(?:\s+(?:M\d+(?:\s+(?:Pro|Max|Ultra))?|Intel(?:\s+Core)?(?:\s+i[3579])?))?(?:\s+\d{1,2}(?:\.?ª)?(?:\s+gen(?:eraci[oó]n)?\.?)?(?=\s+\d{1,2}(?:[.,]\d+)?(?![\d.,])(?!\s*(?:GB|TB|RAM|mm)\b)))?\s+)(\d{1,2}(?:[.,]\d+)?)(?![\d.,])(?:\s*(?:pulgadas\b|["″]))?(?!\w|\s*(?:GB|TB|RAM|mm|generaci[oó]n)\b)/gi,
    (match, prefix: string, size: string) => {
      const inches = Number(size.replace(',', '.'));
      return inches >= 8 && inches <= 40 ? `${prefix}${size} pulgadas` : match;
    },
  );
}
