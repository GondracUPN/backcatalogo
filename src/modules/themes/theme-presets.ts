// Temáticas predefinidas. Las fechas se expresan en hora de Lima (UTC-5, sin
// horario de verano). Las fechas móviles se calculan; las que dependen de
// organizadores externos (Cyber Days, aniversario) se dejan para completar a mano.

export const THEME_EFFECTS = ['none', 'snow', 'hearts', 'confetti', 'pumpkins', 'stars', 'flags', 'flowers', 'sun'] as const;
export type ThemeEffect = (typeof THEME_EFFECTS)[number];

export type ThemePreset = {
  preset: string;
  name: string;
  effect: ThemeEffect;
  colors: Record<string, string>;
  banner: { enabled: boolean; title: string; text: string; linkUrl: string; linkLabel: string; imageUrl: string };
  recurringYearly: boolean;
  /** Fechas sugeridas para el año pedido (ISO con -05:00) o null si dependen de terceros. */
  startsAt: string | null;
  endsAt: string | null;
  datesNote: string;
};

const pad = (value: number) => String(value).padStart(2, '0');
const limaIso = (year: number, month: number, day: number, end = false) =>
  `${year}-${pad(month)}-${pad(day)}T${end ? '23:59:00' : '00:00:00'}-05:00`;

/** Día del mes del n-ésimo `weekday` (0 = domingo) de un mes. */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number) {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
}

function shiftDays(year: number, month: number, day: number, delta: number) {
  const date = new Date(Date.UTC(year, month - 1, day + delta));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function banner(title: string, text: string) {
  return { enabled: true, title, text, linkUrl: '/ofertas', linkLabel: 'Ver ofertas', imageUrl: '' };
}

export function themePresets(year: number): ThemePreset[] {
  const mothersDay = nthWeekdayOfMonth(year, 5, 0, 2); // 2.º domingo de mayo (Perú)
  const fathersDay = nthWeekdayOfMonth(year, 6, 0, 3); // 3.er domingo de junio (Perú)
  const thanksgiving = nthWeekdayOfMonth(year, 11, 4, 4); // 4.º jueves de noviembre
  const blackFriday = shiftDays(year, 11, thanksgiving, 1);
  const cyberMonday = shiftDays(year, 11, thanksgiving, 4);
  const mothersStart = shiftDays(year, 5, mothersDay, -7);
  const fathersStart = shiftDays(year, 6, fathersDay, -7);

  return [
    {
      preset: 'navidad', name: 'Navidad', effect: 'snow', recurringYearly: true,
      colors: { accent: '#b91c1c', accentStrong: '#991b1b', accentSoft: '#fee2e2', bannerBg: '#14532d', bannerText: '#ffffff' },
      banner: banner('Navidad en Macsomenos', 'Encuentra el regalo Apple ideal.'),
      startsAt: limaIso(year, 12, 1), endsAt: limaIso(year, 12, 26, true), datesNote: '1 al 26 de diciembre',
    },
    {
      preset: 'ano_nuevo', name: 'Año Nuevo', effect: 'none', recurringYearly: true,
      colors: { accent: '#b45309', accentStrong: '#92400e', accentSoft: '#fef3c7', bannerBg: '#111827', bannerText: '#fde68a' },
      banner: banner('Feliz Año Nuevo', 'Empieza el año con un equipo nuevo.'),
      startsAt: limaIso(year, 12, 27), endsAt: limaIso(year + 1, 1, 2, true), datesNote: '27 de diciembre al 2 de enero',
    },
    {
      preset: 'san_valentin', name: 'San Valentín', effect: 'none', recurringYearly: true,
      colors: { accent: '#be185d', accentStrong: '#9d174d', accentSoft: '#fce7f3', bannerBg: '#9d174d', bannerText: '#ffffff' },
      banner: banner('San Valentín', 'Sorprende con un regalo Apple.'),
      startsAt: limaIso(year, 2, 7), endsAt: limaIso(year, 2, 14, true), datesNote: '7 al 14 de febrero',
    },
    {
      preset: 'halloween', name: 'Halloween', effect: 'none', recurringYearly: true,
      colors: { accent: '#c2410c', accentStrong: '#9a3412', accentSoft: '#ffedd5', bannerBg: '#1c1917', bannerText: '#fdba74' },
      banner: banner('Halloween', 'Ofertas de miedo en equipos Apple.'),
      startsAt: limaIso(year, 10, 24), endsAt: limaIso(year, 10, 31, true), datesNote: '24 al 31 de octubre',
    },
    {
      preset: 'fiestas_patrias', name: 'Fiestas Patrias', effect: 'none', recurringYearly: true,
      colors: { accent: '#dc2626', accentStrong: '#b91c1c', accentSoft: '#fee2e2', bannerBg: '#dc2626', bannerText: '#ffffff' },
      banner: banner('Felices Fiestas Patrias', 'Celebra con Macsomenos.'),
      startsAt: limaIso(year, 7, 20), endsAt: limaIso(year, 7, 29, true), datesNote: '20 al 29 de julio',
    },
    {
      preset: 'dia_madre', name: 'Día de la Madre', effect: 'none', recurringYearly: false,
      colors: { accent: '#db2777', accentStrong: '#be185d', accentSoft: '#fce7f3', bannerBg: '#fdf2f8', bannerText: '#831843' },
      banner: banner('Día de la Madre', 'Un regalo que ella usará todos los días.'),
      startsAt: limaIso(mothersStart.year, mothersStart.month, mothersStart.day), endsAt: limaIso(year, 5, mothersDay, true),
      datesNote: `Semana previa al 2.º domingo de mayo (${mothersDay}/05/${year})`,
    },
    {
      preset: 'dia_padre', name: 'Día del Padre', effect: 'none', recurringYearly: false,
      colors: { accent: '#1d4ed8', accentStrong: '#1e40af', accentSoft: '#dbeafe', bannerBg: '#1e3a8a', bannerText: '#ffffff' },
      banner: banner('Día del Padre', 'Tecnología para papá.'),
      startsAt: limaIso(fathersStart.year, fathersStart.month, fathersStart.day), endsAt: limaIso(year, 6, fathersDay, true),
      datesNote: `Semana previa al 3.er domingo de junio (${fathersDay}/06/${year})`,
    },
    {
      preset: 'black_friday', name: 'Black Friday', effect: 'none', recurringYearly: false,
      colors: { accent: '#111827', accentStrong: '#000000', accentSoft: '#e5e7eb', bannerBg: '#000000', bannerText: '#facc15' },
      banner: banner('Black Friday', 'Precios especiales por tiempo limitado.'),
      startsAt: limaIso(blackFriday.year, blackFriday.month, blackFriday.day), endsAt: limaIso(cyberMonday.year, cyberMonday.month, cyberMonday.day, true),
      datesNote: 'Viernes después del 4.º jueves de noviembre hasta el Cyber Monday',
    },
    {
      preset: 'cyber_days', name: 'Cyber Days', effect: 'none', recurringYearly: false,
      colors: { accent: '#7c3aed', accentStrong: '#6d28d9', accentSoft: '#ede9fe', bannerBg: '#4c1d95', bannerText: '#ffffff' },
      banner: banner('Cyber Days', 'Solicita en línea y confirmamos por WhatsApp.'),
      startsAt: null, endsAt: null, datesNote: 'Las fechas las define el organizador (CCL / IAB Perú): complétalas a mano.',
    },
    {
      preset: 'aniversario', name: 'Aniversario Macsomenos', effect: 'none', recurringYearly: true,
      colors: { accent: '#2563eb', accentStrong: '#1d4ed8', accentSoft: '#dbeafe', bannerBg: '#1d4ed8', bannerText: '#ffffff' },
      banner: banner('Aniversario Macsomenos', 'Gracias por elegirnos.'),
      startsAt: null, endsAt: null, datesNote: 'Completa la fecha de aniversario de tu negocio.',
    },
    {
      preset: 'escolar', name: 'Campaña escolar', effect: 'none', recurringYearly: true,
      colors: { accent: '#0891b2', accentStrong: '#0e7490', accentSoft: '#cffafe', bannerBg: '#0e7490', bannerText: '#ffffff' },
      banner: banner('Vuelta a clases', 'MacBook e iPad para estudiar.'),
      startsAt: limaIso(year, 2, 1), endsAt: limaIso(year, 3, 31, true), datesNote: '1 de febrero al 31 de marzo',
    },
    {
      preset: 'verano', name: 'Temporada de verano', effect: 'none', recurringYearly: true,
      colors: { accent: '#ea580c', accentStrong: '#c2410c', accentSoft: '#ffedd5', bannerBg: '#fb923c', bannerText: '#431407' },
      banner: banner('Verano Macsomenos', 'Equipos listos para la temporada.'),
      startsAt: limaIso(year, 1, 3), endsAt: limaIso(year, 3, 20, true), datesNote: '3 de enero al 20 de marzo',
    },
    {
      preset: 'custom', name: 'Campaña personalizada', effect: 'none', recurringYearly: false,
      colors: { accent: '#2563eb', accentStrong: '#1d4ed8', accentSoft: '#dbeafe', bannerBg: '#111827', bannerText: '#ffffff' },
      banner: { enabled: false, title: '', text: '', linkUrl: '', linkLabel: '', imageUrl: '' },
      startsAt: null, endsAt: null, datesNote: 'Define tus propias fechas.',
    },
  ];
}

export const PRESET_KEYS = new Set(themePresets(2026).map((preset) => preset.preset));
