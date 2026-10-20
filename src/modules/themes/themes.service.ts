import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SiteTheme, ThemeMode } from '../../entities/site-theme.entity';
import { PRESET_KEYS, THEME_EFFECTS } from './theme-presets';

// Diseño del bloque principal. Vacío = el diseño propio de la campaña (frontend).
export const THEME_LAYOUTS = ['split', 'typographic', 'arch', 'spotlight', 'banded', 'deals', 'bento', 'brand', 'desk', 'horizon', 'immersive'] as const;
export const THEME_FONTS = ['sans', 'serif', 'heavy', 'mono'] as const;
export const THEME_TONES = ['light', 'dark'] as const;
export const THEME_MOTIFS = ['none', 'ribbon', 'gold', 'heart', 'moon', 'andean', 'petal', 'lines', 'grid', 'leaf', 'notebook', 'sun'] as const;

export type ThemeDesign = {
  layout: string; font: string; tone: string; motif: string;
  customColors: boolean; surface: string; ink: string;
  imageUrl: string; mobileImageUrl: string; imageX: number; imageY: number;
  eyebrow: string; headline: string; subtitle: string; ctaLabel: string; ctaUrl: string;
};

const COLOR_KEYS = ['accent', 'accentStrong', 'accentSoft', 'bannerBg', 'bannerText'] as const;
const HEX = /^#[0-9a-f]{6}$/i;
const LIMA_OFFSET_MS = -5 * 60 * 60 * 1000;

export type PublicTheme = {
  id: string;
  name: string;
  preset: string;
  colors: Record<string, string>;
  banner: { enabled: boolean; title: string; text: string; linkUrl: string; linkLabel: string; imageUrl: string; design: ThemeDesign };
  effect: string;
};

function text(value: unknown, max: number, field: string) {
  const result = String(value ?? '').trim();
  if (result.length > max) throw new BadRequestException(`${field}: máximo ${max} caracteres`);
  return result;
}

// Solo rutas internas o https: el valor termina en atributos HTML.
function safeLink(value: unknown, field: string) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\')) return raw;
  if (/^https:\/\/[^\s"'<>]+$/i.test(raw)) return raw;
  throw new BadRequestException(`${field}: usa una ruta interna (/...) o un enlace https`);
}

function safeImage(value: unknown, field = 'banner.imageUrl') {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^\/uploads\/[\w./-]+$/i.test(raw) || /^https:\/\/[^\s"'<>()]+$/i.test(raw)) return raw;
  throw new BadRequestException(`${field}: usa una imagen subida o un enlace https`);
}

function oneOf(value: unknown, allowed: readonly string[], field: string) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!allowed.includes(raw)) throw new BadRequestException(`${field} inválido`);
  return raw;
}

function percent(value: unknown) {
  const number = Math.round(Number(value ?? 50));
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : 50;
}

function hexOrEmpty(value: unknown, field: string) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!HEX.test(raw)) throw new BadRequestException(`${field}: usa un color #RRGGBB`);
  return raw.toLowerCase();
}

/** Opciones de diseño validadas. Se guardan dentro de `banner` (jsonb) para no migrar la tabla. */
export function validateDesign(input: any): ThemeDesign {
  const d = input && typeof input === 'object' ? input : {};
  return {
    layout: oneOf(d.layout, THEME_LAYOUTS, 'design.layout'),
    font: oneOf(d.font, THEME_FONTS, 'design.font'),
    tone: oneOf(d.tone, THEME_TONES, 'design.tone'),
    motif: oneOf(d.motif, THEME_MOTIFS, 'design.motif'),
    customColors: Boolean(d.customColors),
    surface: hexOrEmpty(d.surface, 'design.surface'),
    ink: hexOrEmpty(d.ink, 'design.ink'),
    imageUrl: safeImage(d.imageUrl, 'design.imageUrl'),
    mobileImageUrl: safeImage(d.mobileImageUrl, 'design.mobileImageUrl'),
    imageX: percent(d.imageX),
    imageY: percent(d.imageY),
    eyebrow: text(d.eyebrow, 40, 'design.eyebrow'),
    headline: text(d.headline, 90, 'design.headline'),
    subtitle: text(d.subtitle, 200, 'design.subtitle'),
    ctaLabel: text(d.ctaLabel, 30, 'design.ctaLabel'),
    ctaUrl: safeLink(d.ctaUrl, 'design.ctaUrl'),
  };
}

function dateOrNull(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${field}: fecha inválida`);
  return date;
}

export function validateThemeInput(body: any, current?: SiteTheme) {
  const name = text(body?.name ?? current?.name, 80, 'name');
  if (!name) throw new BadRequestException('name: obligatorio');
  const preset = String(body?.preset ?? current?.preset ?? 'custom');
  if (!PRESET_KEYS.has(preset)) throw new BadRequestException('preset inválido');
  const mode = String(body?.mode ?? current?.mode ?? 'scheduled') as ThemeMode;
  if (!['scheduled', 'on', 'off'].includes(mode)) throw new BadRequestException('mode inválido');
  const startsAt = 'startsAt' in (body || {}) ? dateOrNull(body.startsAt, 'startsAt') : current?.starts_at ?? null;
  const endsAt = 'endsAt' in (body || {}) ? dateOrNull(body.endsAt, 'endsAt') : current?.ends_at ?? null;
  const recurringYearly = Boolean(body?.recurringYearly ?? current?.recurring_yearly ?? false);
  if (startsAt && endsAt && !recurringYearly && startsAt >= endsAt) throw new BadRequestException('La fecha de fin debe ser posterior al inicio');
  if (mode === 'scheduled' && (!startsAt || !endsAt)) throw new BadRequestException('Para programarla indica inicio y fin');
  const priority = Number(body?.priority ?? current?.priority ?? 0);
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new BadRequestException('priority: entero entre -100 y 100');
  const effect = String(body?.effect ?? current?.effect ?? 'none');
  if (!(THEME_EFFECTS as readonly string[]).includes(effect)) throw new BadRequestException('effect inválido');

  const colorsInput = body?.colors ?? current?.colors ?? {};
  const colors: Record<string, string> = {};
  for (const key of COLOR_KEYS) {
    const value = String(colorsInput?.[key] ?? '').trim();
    if (!value) continue;
    if (!HEX.test(value)) throw new BadRequestException(`colors.${key}: usa un color #RRGGBB`);
    colors[key] = value.toLowerCase();
  }

  const bannerInput = body?.banner ?? current?.banner ?? {};
  const banner = {
    enabled: Boolean(bannerInput?.enabled),
    title: text(bannerInput?.title, 80, 'banner.title'),
    text: text(bannerInput?.text, 200, 'banner.text'),
    linkUrl: safeLink(bannerInput?.linkUrl, 'banner.linkUrl'),
    linkLabel: text(bannerInput?.linkLabel, 30, 'banner.linkLabel'),
    imageUrl: safeImage(bannerInput?.imageUrl),
    design: validateDesign(bannerInput?.design),
  };

  return { name, preset, mode, starts_at: startsAt, ends_at: endsAt, recurring_yearly: recurringYearly, priority, effect, colors, banner };
}

/** Clave MMDDHHmm en hora de Lima para comparar fechas que se repiten cada año. */
function limaYearKey(date: Date) {
  const lima = new Date(date.getTime() + LIMA_OFFSET_MS);
  return lima.getUTCMonth() * 1e6 + lima.getUTCDate() * 1e4 + lima.getUTCHours() * 100 + lima.getUTCMinutes();
}

export function isThemeActive(theme: Pick<SiteTheme, 'mode' | 'starts_at' | 'ends_at' | 'recurring_yearly'>, now: Date) {
  if (theme.mode === 'off') return false;
  if (theme.mode === 'on') return true;
  if (!theme.starts_at || !theme.ends_at) return false;
  const start = new Date(theme.starts_at);
  const end = new Date(theme.ends_at);
  if (!theme.recurring_yearly) return start <= now && now <= end;
  const [s, e, n] = [limaYearKey(start), limaYearKey(end), limaYearKey(now)];
  // Si cruza el fin de año (p. ej. 27 dic → 2 ene) el intervalo da la vuelta.
  return s <= e ? s <= n && n <= e : n >= s || n <= e;
}

export function pickActiveTheme<T extends Pick<SiteTheme, 'mode' | 'starts_at' | 'ends_at' | 'recurring_yearly' | 'priority' | 'updated_at'>>(themes: T[], now: Date): T | null {
  const active = themes.filter((theme) => isThemeActive(theme, now));
  active.sort((a, b) =>
    b.priority - a.priority
    || Number(b.mode === 'on') - Number(a.mode === 'on')
    || new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  return active[0] || null;
}

export function toPublicTheme(theme: SiteTheme): PublicTheme {
  const banner: any = theme.banner || {};
  return {
    id: theme.id,
    name: theme.name,
    preset: theme.preset,
    colors: theme.colors || {},
    banner: {
      enabled: Boolean(banner.enabled),
      title: String(banner.title || ''),
      text: String(banner.text || ''),
      linkUrl: String(banner.linkUrl || ''),
      linkLabel: String(banner.linkLabel || ''),
      imageUrl: String(banner.imageUrl || ''),
      // Datos ya validados al guardar; se normalizan otra vez por si hay filas antiguas.
      design: (() => { try { return validateDesign(banner.design); } catch { return validateDesign({}); } })(),
    },
    effect: theme.effect,
  };
}

@Injectable()
export class ThemesService {
  constructor(@InjectRepository(SiteTheme) private repo: Repository<SiteTheme>) {}

  list() {
    return this.repo.find({ order: { priority: 'DESC', updated_at: 'DESC' } });
  }

  async active(now = new Date()) {
    const candidates = await this.repo.createQueryBuilder('t').where(`t.mode <> 'off'`).getMany();
    const theme = pickActiveTheme(candidates, now);
    return theme ? toPublicTheme(theme) : null;
  }

  async byId(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException();
    const theme = await this.repo.findOne({ where: { id } });
    if (!theme) throw new NotFoundException();
    return theme;
  }

  create(body: any, username: string) {
    return this.repo.save(this.repo.create({ ...validateThemeInput(body), updated_by: username }));
  }

  async update(id: string, body: any, username: string) {
    const current = await this.byId(id);
    await this.repo.update({ id }, { ...validateThemeInput(body, current), updated_by: username });
    return this.byId(id);
  }

  async remove(id: string) {
    await this.byId(id);
    await this.repo.delete({ id });
    return { ok: true };
  }
}
