// Validación y normalización de los eventos que envía la web (funciones puras).

export const EVENT_TYPES = [
  'page_view',
  'view_home',
  'view_category',
  'view_product',
  'product_leave',
  'search_product',
  'apply_filter',
  'select_variant',
  'compare_product',
  'add_to_cart',
  'click_whatsapp',
  'start_order_request',
  'complete_order_request',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

const ID = /^[A-Za-z0-9-]{8,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SEARCH_HOSTS = /(^|\.)(google|bing|yahoo|duckduckgo|ecosia|yandex|baidu)\./i;
const SOCIAL_HOSTS = /(^|\.)(facebook|fb|instagram|tiktok|whatsapp|wa\.me|t\.co|twitter|x\.com|youtube|youtu\.be|linkedin|pinterest|threads|messenger)/i;

function text(value: unknown, max: number) {
  const result = String(value ?? '').trim();
  return result ? result.slice(0, max) : null;
}

/** Clasifica la procedencia de una visita a partir de UTM, gclid y referente. */
export function classifySource(input: { utmSource?: string | null; utmMedium?: string | null; gclid?: boolean; referrerHost?: string | null; ownHost?: string }) {
  const medium = String(input.utmMedium || '').toLowerCase();
  if (input.gclid || /^(cpc|ppc|paid|ads|display|paidsocial|paid_social)$/.test(medium)) return 'campaign';
  if (input.utmSource) {
    if (/social/.test(medium)) return 'social';
    return 'campaign';
  }
  const host = String(input.referrerHost || '').toLowerCase();
  if (!host || (input.ownHost && host.endsWith(input.ownHost))) return 'direct';
  if (SEARCH_HOSTS.test(host)) return 'search';
  if (SOCIAL_HOSTS.test(host)) return 'social';
  return 'referral';
}

export type CleanEvent = {
  occurred_at: Date;
  event_type: EventType;
  consent: boolean;
  session_id: string | null;
  visitor_id: string | null;
  path: string | null;
  product_id: string | null;
  product_slug: string | null;
  category: string | null;
  query: string | null;
  results: number | null;
  filters: string[] | null;
  duration_ms: number | null;
  source: string | null;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  device: string | null;
  metadata: Record<string, unknown> | null;
};

/**
 * Devuelve el evento limpio o null si no es válido. Sin consentimiento se
 * descartan los identificadores: el evento solo cuenta de forma agregada.
 */
export function cleanEvent(raw: any, context: { consent: boolean; sessionId?: unknown; visitorId?: unknown; now?: Date; ownHost?: string }): CleanEvent | null {
  const type = String(raw?.type || '');
  if (!(EVENT_TYPES as readonly string[]).includes(type)) return null;
  const now = context.now || new Date();
  // Hora del cliente solo si es razonable (hasta 1 h atrás); si no, la del servidor.
  const clientTime = raw?.at ? new Date(String(raw.at)) : null;
  const occurred = clientTime && !Number.isNaN(clientTime.getTime()) && clientTime <= now && now.getTime() - clientTime.getTime() < 3600_000 ? clientTime : now;
  const consent = Boolean(context.consent);
  const sessionId = consent && ID.test(String(context.sessionId || '')) ? String(context.sessionId) : null;
  const visitorId = consent && ID.test(String(context.visitorId || '')) ? String(context.visitorId) : null;
  const productId = UUID.test(String(raw?.productId || '')) ? String(raw.productId) : null;
  const referrerHost = text(raw?.referrerHost, 120)?.toLowerCase() || null;
  const utmSource = text(raw?.utmSource, 80)?.toLowerCase() || null;
  const utmMedium = text(raw?.utmMedium, 80)?.toLowerCase() || null;
  const utmCampaign = text(raw?.utmCampaign, 120) || null;
  const isLanding = type === 'page_view' && Boolean(raw?.landing);
  const results = Number(raw?.results);
  const duration = Number(raw?.durationMs);
  const filters = Array.isArray(raw?.filters)
    ? raw.filters.map((value: unknown) => text(value, 60)).filter(Boolean).slice(0, 20) as string[]
    : null;
  const device = ['mobile', 'tablet', 'desktop'].includes(String(raw?.device)) ? String(raw.device) : null;
  const query = type === 'search_product' ? text(String(raw?.query || '').toLowerCase().replace(/\s+/g, ' '), 80) : null;
  return {
    occurred_at: occurred,
    event_type: type as EventType,
    consent,
    session_id: sessionId,
    visitor_id: visitorId,
    path: text(raw?.path, 200),
    product_id: productId,
    product_slug: text(raw?.productSlug, 160),
    category: text(raw?.category, 40)?.toLowerCase() || null,
    query,
    results: type === 'search_product' && Number.isFinite(results) && results >= 0 ? Math.min(100000, Math.round(results)) : null,
    filters: filters && filters.length ? filters : null,
    duration_ms: type === 'product_leave' && Number.isFinite(duration) && duration > 0 ? Math.min(30 * 60_000, Math.round(duration)) : null,
    // La procedencia solo se calcula en la página de entrada.
    source: isLanding ? classifySource({ utmSource, utmMedium, gclid: Boolean(raw?.gclid), referrerHost, ownHost: context.ownHost }) : null,
    referrer_host: isLanding ? referrerHost : null,
    utm_source: isLanding ? utmSource : null,
    utm_medium: isLanding ? utmMedium : null,
    utm_campaign: isLanding ? utmCampaign : null,
    device,
    metadata: null,
  };
}
