import { strict as assert } from 'assert';
import { isThemeActive, pickActiveTheme, toPublicTheme, validateThemeInput } from '../modules/themes/themes.service';
import { nthWeekdayOfMonth, themePresets } from '../modules/themes/theme-presets';

const lima = (iso: string) => new Date(`${iso}-05:00`);
const base = { priority: 0, updated_at: new Date('2026-01-01') } as any;

// Fechas móviles (Perú)
assert.equal(nthWeekdayOfMonth(2026, 5, 0, 2), 10, 'Día de la Madre 2026: 10 de mayo');
assert.equal(nthWeekdayOfMonth(2026, 6, 0, 3), 21, 'Día del Padre 2026: 21 de junio');
const bf = themePresets(2026).find((p) => p.preset === 'black_friday')!;
assert.ok(bf.startsAt!.startsWith('2026-11-27'), 'Black Friday 2026: 27 de noviembre');
assert.ok(bf.endsAt!.startsWith('2026-11-30'), 'Cyber Monday 2026: 30 de noviembre');
assert.equal(themePresets(2026).find((p) => p.preset === 'cyber_days')!.startsAt, null, 'Cyber Days se completa a mano');

// Programación simple con límites en hora de Lima
const navidad = { ...base, mode: 'scheduled', recurring_yearly: false, starts_at: lima('2026-12-01T00:00:00'), ends_at: lima('2026-12-26T23:59:00') };
assert.equal(isThemeActive(navidad, lima('2026-11-30T23:59:00')), false);
assert.equal(isThemeActive(navidad, lima('2026-12-01T00:00:00')), true);
assert.equal(isThemeActive(navidad, lima('2026-12-27T00:00:00')), false);

// Recurrente que cruza el año (27 dic → 2 ene) en años posteriores
const anoNuevo = { ...base, mode: 'scheduled', recurring_yearly: true, starts_at: lima('2026-12-27T00:00:00'), ends_at: lima('2027-01-02T23:59:00') };
assert.equal(isThemeActive(anoNuevo, lima('2028-12-31T12:00:00')), true);
assert.equal(isThemeActive(anoNuevo, lima('2029-01-02T20:00:00')), true);
assert.equal(isThemeActive(anoNuevo, lima('2029-01-03T00:01:00')), false);
assert.equal(isThemeActive(anoNuevo, lima('2028-12-26T23:00:00')), false);

// Manual y desactivada
assert.equal(isThemeActive({ ...navidad, mode: 'on' }, lima('2026-06-01T00:00:00')), true);
assert.equal(isThemeActive({ ...navidad, mode: 'off' }, lima('2026-12-10T00:00:00')), false);

// Prioridad cuando coinciden dos campañas; sin ninguna activa → diseño normal
const blackFriday = { ...base, id: 'bf', mode: 'scheduled', recurring_yearly: false, priority: 10, starts_at: lima('2026-11-27T00:00:00'), ends_at: lima('2026-12-02T23:59:00') };
const navidadLow = { ...navidad, id: 'nav', priority: 1 };
assert.equal(pickActiveTheme([navidadLow, blackFriday], lima('2026-12-01T10:00:00'))!.id, 'bf');
assert.equal(pickActiveTheme([navidadLow, blackFriday], lima('2026-12-05T10:00:00'))!.id, 'nav');
assert.equal(pickActiveTheme([navidadLow, blackFriday], lima('2026-06-05T10:00:00')), null);

// Validación: colores, enlaces e imágenes no pueden inyectar CSS/HTML
const ok = { name: 'Navidad', preset: 'navidad', mode: 'scheduled', startsAt: '2026-12-01T00:00:00-05:00', endsAt: '2026-12-26T23:59:00-05:00', effect: 'snow' };
assert.doesNotThrow(() => validateThemeInput({ ...ok, colors: { accent: '#B91C1C' }, banner: { linkUrl: '/categorias', imageUrl: 'https://res.cloudinary.com/x/a.jpg' } }));
assert.throws(() => validateThemeInput({ ...ok, colors: { accent: 'red;}body{display:none' } }));
assert.throws(() => validateThemeInput({ ...ok, banner: { linkUrl: 'javascript:alert(1)' } }));
assert.throws(() => validateThemeInput({ ...ok, banner: { linkUrl: '//evil.com' } }));
assert.throws(() => validateThemeInput({ ...ok, banner: { imageUrl: 'http://x.com/a.jpg' } }));
assert.throws(() => validateThemeInput({ ...ok, effect: 'fireworks3d' }));
assert.throws(() => validateThemeInput({ ...ok, startsAt: '', endsAt: '' }), 'programada sin fechas');
assert.throws(() => validateThemeInput({ ...ok, endsAt: '2026-11-01T00:00:00-05:00' }), 'fin antes del inicio');
assert.equal(validateThemeInput({ ...ok, colors: { accent: '#B91C1C' } }).colors.accent, '#b91c1c');

console.log('themes.test.ts ok');

// Diseño de campaña: se valida, se conserva al editar solo el modo y llega a la web pública.
const design = { layout: 'deals', font: 'heavy', tone: 'dark', motif: 'none', customColors: true, surface: '#0A0A0A', ink: '#ffffff', imageUrl: 'https://res.cloudinary.com/x/a.jpg', imageX: 140, imageY: -3, eyebrow: 'Solo online', ctaLabel: 'Ver ofertas', ctaUrl: '/ofertas' };
const saved = validateThemeInput({ ...ok, banner: { enabled: true, title: 'BF', design } });
assert.equal(saved.banner.design.layout, 'deals');
assert.equal(saved.banner.design.surface, '#0a0a0a', 'colores en minúscula');
assert.equal(saved.banner.design.imageX, 100, 'posición limitada a 0-100');
assert.equal(saved.banner.design.imageY, 0);
const onlyMode = validateThemeInput({ mode: 'off' }, { ...saved, starts_at: saved.starts_at, ends_at: saved.ends_at } as any);
assert.deepEqual(onlyMode.banner.design, saved.banner.design, 'cambiar solo el modo no borra el diseño');
assert.equal(toPublicTheme({ id: 'x', ...saved } as any).banner.design.ctaUrl, '/ofertas');
assert.equal(toPublicTheme({ id: 'x', ...saved, banner: { enabled: true } } as any).banner.design.layout, '', 'filas antiguas sin diseño');
assert.throws(() => validateThemeInput({ ...ok, banner: { design: { layout: 'carousel3d' } } }));
assert.throws(() => validateThemeInput({ ...ok, banner: { design: { ctaUrl: 'javascript:alert(1)' } } }));
assert.throws(() => validateThemeInput({ ...ok, banner: { design: { imageUrl: 'http://x.com/a.jpg' } } }));
assert.throws(() => validateThemeInput({ ...ok, banner: { design: { surface: 'red' } } }));
console.log('themes design ok');
