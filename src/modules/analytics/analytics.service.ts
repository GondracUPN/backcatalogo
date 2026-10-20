import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CleanEvent } from './event-ingest';

const TZ = 'America/Lima';
export const GROUPS = ['hour', 'day', 'week', 'month', 'year'] as const;
export type Group = (typeof GROUPS)[number];

// Límite de puntos por gráfico para que la consulta y el dibujo sean rápidos.
const MAX_BUCKETS: Record<Group, number> = { hour: 24 * 31, day: 800, week: 300, month: 120, year: 20 };
const BUCKET_MS: Record<Group, number> = { hour: 3600e3, day: 864e5, week: 7 * 864e5, month: 30 * 864e5, year: 365 * 864e5 };

export type Range = { from: Date; to: Date; prevFrom: Date; prevTo: Date; group: Group };

/** Valida el periodo y calcula el periodo anterior de la misma duración. */
export function parseRange(fromRaw?: string, toRaw?: string, groupRaw?: string): Range {
  const to = toRaw ? new Date(toRaw) : new Date();
  const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - 30 * 864e5);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestException('Fechas inválidas');
  if (from >= to) throw new BadRequestException('La fecha inicial debe ser anterior a la final');
  if (to.getTime() - from.getTime() > 3 * 366 * 864e5) throw new BadRequestException('El periodo máximo es de 3 años');
  const group = ((GROUPS as readonly string[]).includes(String(groupRaw)) ? groupRaw : 'day') as Group;
  if ((to.getTime() - from.getTime()) / BUCKET_MS[group] > MAX_BUCKETS[group]) {
    throw new BadRequestException(`Demasiados puntos para agrupar por ${group}: elige un periodo más corto o una agrupación mayor`);
  }
  const length = to.getTime() - from.getTime();
  return { from, to, prevFrom: new Date(from.getTime() - length), prevTo: from, group };
}

const pct = (part: number, total: number) => (total > 0 ? +((part / total) * 100).toFixed(1) : null);
const change = (current: number, previous: number) => (previous > 0 ? +(((current - previous) / previous) * 100).toFixed(1) : current > 0 ? null : 0);

@Injectable()
export class AnalyticsService {
  constructor(private db: DataSource) {}

  private async has(table: string) {
    const rows = await this.db.query(`SELECT to_regclass($1) AS name`, [`public.${table}`]);
    return Boolean(rows?.[0]?.name);
  }

  // ---------- Ingesta ----------
  async insert(events: CleanEvent[]) {
    if (!events.length) return 0;
    const cols = ['occurred_at', 'event_type', 'consent', 'session_id', 'visitor_id', 'path', 'product_id', 'product_slug', 'category', 'query', 'results', 'filters', 'duration_ms', 'source', 'referrer_host', 'utm_source', 'utm_medium', 'utm_campaign', 'device'] as const;
    const values: unknown[] = [];
    const rows = events.map((event, r) => `(${cols.map((col, c) => {
      values.push((event as any)[col]);
      return `$${r * cols.length + c + 1}`;
    }).join(',')})`);
    await this.db.query(`INSERT INTO analytics_events (${cols.join(',')}) VALUES ${rows.join(',')}`, values);
    // Conservación: de vez en cuando se borran eventos más antiguos que el plazo.
    if (Math.random() < 0.01) {
      const days = Math.max(30, Number(process.env.ANALYTICS_RETENTION_DAYS || 400) || 400);
      this.db.query(`DELETE FROM analytics_events WHERE occurred_at < now() - ($1 || ' days')::interval`, [String(days)]).catch(() => undefined);
    }
    return events.length;
  }

  // ---------- Totales de un periodo ----------
  private async totals(from: Date, to: Date) {
    const [ev] = await this.db.query(
      `SELECT
         count(*) FILTER (WHERE event_type = 'page_view')::int AS page_views,
         count(*) FILTER (WHERE event_type = 'view_product')::int AS product_views,
         count(DISTINCT session_id)::int AS sessions,
         count(DISTINCT visitor_id)::int AS visitors,
         count(*) FILTER (WHERE event_type = 'page_view' AND NOT consent)::int AS anonymous_page_views,
         count(*) FILTER (WHERE event_type = 'click_whatsapp')::int AS whatsapp,
         count(*) FILTER (WHERE event_type = 'add_to_cart')::int AS add_to_cart,
         count(*) FILTER (WHERE event_type = 'start_order_request')::int AS start_request,
         count(*) FILTER (WHERE event_type = 'search_product')::int AS searches
       FROM analytics_events WHERE occurred_at >= $1 AND occurred_at < $2`,
      [from, to],
    );
    let requests = 0;
    let confirmed = 0;
    let delivered = 0;
    if (await this.has('purchase_requests')) {
      const [pr] = await this.db.query(
        `SELECT count(*)::int AS requests,
                count(*) FILTER (WHERE confirmed_at IS NOT NULL)::int AS confirmed,
                count(*) FILTER (WHERE status = 'entregada')::int AS delivered
           FROM purchase_requests WHERE owner_user_id IS NULL AND created_at >= $1 AND created_at < $2`,
        [from, to],
      );
      ({ requests, confirmed, delivered } = pr);
    }
    let salesRecorded = 0;
    let salesAmount = 0;
    if (await this.has('sold_records')) {
      const [sr] = await this.db.query(
        `SELECT count(*)::int AS n, COALESCE(sum(sale_price),0)::float AS amount FROM sold_records WHERE owner_user_id IS NULL AND sold_at >= $1 AND sold_at < $2`,
        [from, to],
      );
      salesRecorded = sr.n;
      salesAmount = sr.amount;
    }
    return { ...ev, interest: ev.whatsapp + ev.add_to_cart, requests, confirmed, delivered, salesRecorded, salesAmount };
  }

  // ---------- Resumen temporal ----------
  async overview(range: Range) {
    const { from, to, prevFrom, prevTo, group } = range;
    const [current, previous, series, hours, weekdays, categories, devices] = await Promise.all([
      this.totals(from, to),
      this.totals(prevFrom, prevTo),
      this.db.query(
        `WITH buckets AS (
           SELECT generate_series(date_trunc($3, $1::timestamptz AT TIME ZONE '${TZ}'), date_trunc($3, ($2::timestamptz - interval '1 millisecond') AT TIME ZONE '${TZ}'), ('1 ' || $3)::interval) AS bucket
         ), ev AS (
           SELECT date_trunc($3, occurred_at AT TIME ZONE '${TZ}') AS bucket, event_type, session_id, visitor_id
             FROM analytics_events WHERE occurred_at >= $1 AND occurred_at < $2
         )
         SELECT to_char(b.bucket, 'YYYY-MM-DD"T"HH24:MI') AS bucket,
                count(ev.event_type) FILTER (WHERE ev.event_type = 'page_view')::int AS page_views,
                count(ev.event_type) FILTER (WHERE ev.event_type = 'view_product')::int AS product_views,
                count(DISTINCT ev.session_id)::int AS sessions,
                count(DISTINCT ev.visitor_id)::int AS visitors,
                count(ev.event_type) FILTER (WHERE ev.event_type IN ('click_whatsapp','add_to_cart'))::int AS interest
           FROM buckets b LEFT JOIN ev ON ev.bucket = b.bucket
          GROUP BY b.bucket ORDER BY b.bucket`,
        [from, to, group],
      ),
      this.db.query(
        `SELECT extract(hour FROM occurred_at AT TIME ZONE '${TZ}')::int AS hour, count(*)::int AS n
           FROM analytics_events WHERE event_type = 'page_view' AND occurred_at >= $1 AND occurred_at < $2 GROUP BY 1`,
        [from, to],
      ),
      this.db.query(
        `SELECT extract(isodow FROM occurred_at AT TIME ZONE '${TZ}')::int AS dow, count(*)::int AS n
           FROM analytics_events WHERE event_type = 'page_view' AND occurred_at >= $1 AND occurred_at < $2 GROUP BY 1`,
        [from, to],
      ),
      this.db.query(
        `SELECT COALESCE(category, 'sin categoría') AS category,
                count(*) FILTER (WHERE occurred_at >= $1)::int AS current,
                count(*) FILTER (WHERE occurred_at < $1)::int AS previous
           FROM analytics_events WHERE event_type = 'view_product' AND occurred_at >= $3 AND occurred_at < $2
          GROUP BY 1 ORDER BY 2 DESC`,
        [from, to, prevFrom],
      ),
      this.db.query(
        `SELECT COALESCE(device, 'desconocido') AS device, count(*)::int AS n
           FROM analytics_events WHERE event_type = 'page_view' AND occurred_at >= $1 AND occurred_at < $2 GROUP BY 1 ORDER BY 2 DESC`,
        [from, to],
      ),
    ]);

    const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, n: hours.find((h: any) => h.hour === hour)?.n || 0 }));
    const daily = Array.from({ length: 7 }, (_, i) => ({ dow: i + 1, n: weekdays.find((d: any) => d.dow === i + 1)?.n || 0 }));
    const keys = ['page_views', 'product_views', 'sessions', 'visitors', 'interest', 'requests', 'confirmed', 'delivered', 'salesRecorded', 'salesAmount', 'searches'] as const;
    const comparison = Object.fromEntries(keys.map((key) => [key, { current: current[key], previous: previous[key], change: change(current[key], previous[key]) }]));
    return {
      range: { from: from.toISOString(), to: to.toISOString(), prevFrom: prevFrom.toISOString(), prevTo: prevTo.toISOString(), group },
      comparison,
      anonymousShare: pct(current.anonymous_page_views, current.page_views),
      series,
      hours: hourly,
      weekdays: daily,
      peakHour: hourly.reduce((best, h) => (h.n > best.n ? h : best), { hour: -1, n: 0 }),
      peakWeekday: daily.reduce((best, d) => (d.n > best.n ? d : best), { dow: -1, n: 0 }),
      categories: categories.map((c: any) => ({ ...c, change: change(c.current, c.previous) })),
      devices,
    };
  }

  // ---------- Productos ----------
  async products(range: Range) {
    const { from, to } = range;
    const hasRequests = await this.has('purchase_requests');
    const hasSold = await this.has('sold_records');
    const rows = await this.db.query(
      `WITH ev AS (
         SELECT product_id,
                count(*) FILTER (WHERE event_type = 'view_product')::int AS views,
                count(DISTINCT session_id) FILTER (WHERE event_type = 'view_product')::int AS unique_sessions,
                count(*) FILTER (WHERE event_type = 'view_product' AND session_id IS NULL)::int AS anonymous_views,
                count(*) FILTER (WHERE event_type = 'click_whatsapp')::int AS whatsapp,
                count(*) FILTER (WHERE event_type = 'add_to_cart')::int AS add_to_cart,
                avg(duration_ms) FILTER (WHERE event_type = 'product_leave')::float AS avg_ms
           FROM analytics_events
          WHERE product_id IS NOT NULL AND occurred_at >= $1 AND occurred_at < $2
          GROUP BY product_id
       )
       ${hasRequests ? `, rq AS (
         SELECT i.product_id,
                count(DISTINCT pr.id)::int AS requests,
                count(DISTINCT pr.id) FILTER (WHERE pr.confirmed_at IS NOT NULL)::int AS confirmed,
                count(DISTINCT pr.id) FILTER (WHERE pr.status = 'entregada')::int AS delivered
           FROM purchase_request_items i JOIN purchase_requests pr ON pr.id = i.request_id
          WHERE pr.owner_user_id IS NULL AND pr.created_at >= $1 AND pr.created_at < $2 AND i.product_id IS NOT NULL
          GROUP BY i.product_id
       )` : ''}
       ${hasSold ? `, sd AS (
         SELECT lower(sku) AS sku, count(*)::int AS sales, COALESCE(sum(sale_price),0)::float AS amount
           FROM sold_records WHERE owner_user_id IS NULL AND sold_at >= $1 AND sold_at < $2 GROUP BY 1
       )` : ''}
       SELECT p.id, p.title, p.sku, p.stock, p.status, p.sale_type,
              COALESCE(cp.category, s.category) AS category, cp.slug, cp.is_published,
              s.owner_user_id,
              COALESCE(ev.views, 0) AS views, COALESCE(ev.unique_sessions, 0) AS unique_sessions,
              COALESCE(ev.anonymous_views, 0) AS anonymous_views,
              COALESCE(ev.whatsapp, 0) AS whatsapp, COALESCE(ev.add_to_cart, 0) AS add_to_cart,
              ev.avg_ms,
              ${hasRequests ? 'COALESCE(rq.requests,0) AS requests, COALESCE(rq.confirmed,0) AS confirmed, COALESCE(rq.delivered,0) AS delivered' : '0 AS requests, 0 AS confirmed, 0 AS delivered'},
              ${hasSold ? 'COALESCE(sd.sales,0) AS sales, COALESCE(sd.amount,0) AS sales_amount' : '0 AS sales, 0 AS sales_amount'}
         FROM products p
         LEFT JOIN catalog_public cp ON cp.product_id = p.id
         LEFT JOIN LATERAL (SELECT category, owner_user_id FROM staged_products WHERE sku = p.sku ORDER BY updated_at DESC LIMIT 1) s ON true
         LEFT JOIN ev ON ev.product_id = p.id
         ${hasRequests ? 'LEFT JOIN rq ON rq.product_id = p.id' : ''}
         ${hasSold ? 'LEFT JOIN sd ON sd.sku = lower(p.sku)' : ''}
        WHERE (s.owner_user_id IS NULL)
          AND (ev.product_id IS NOT NULL ${hasRequests ? 'OR rq.product_id IS NOT NULL' : ''} ${hasSold ? 'OR sd.sku IS NOT NULL' : ''})
        ORDER BY views DESC, requests DESC
        LIMIT 300`,
      [from, to],
    );
    const items = rows.map((row: any) => {
      const interest = row.whatsapp + row.add_to_cart;
      // Venta confirmada: la registrada en ventas o la solicitud entregada (la mayor de ambas, sin sumar dos veces).
      const sold = Math.max(row.sales, row.delivered);
      const available = Number(row.stock) > 0 && row.status !== 'sold';
      return {
        ...row,
        avgSeconds: row.avg_ms ? Math.round(row.avg_ms / 1000) : null,
        interest,
        sold,
        rates: {
          interestPerView: pct(interest, row.views),
          requestPerView: pct(row.requests, row.views),
          confirmedPerRequest: pct(row.confirmed, row.requests),
          salePerView: pct(sold, row.views),
        },
        available,
        interestWithoutStock: !available && (row.views > 0 || interest > 0),
      };
    });
    const groupBy = (key: (item: any) => string) => {
      const map = new Map<string, any>();
      for (const item of items) {
        const k = key(item);
        const agg = map.get(k) || { key: k, views: 0, interest: 0, requests: 0, confirmed: 0, sold: 0, salesAmount: 0, products: 0 };
        agg.views += item.views;
        agg.interest += item.interest;
        agg.requests += item.requests;
        agg.confirmed += item.confirmed;
        agg.sold += item.sold;
        agg.salesAmount += item.sales_amount;
        agg.products += 1;
        map.set(k, agg);
      }
      return Array.from(map.values())
        .map((agg) => ({ ...agg, requestPerView: pct(agg.requests, agg.views), salePerView: pct(agg.sold, agg.views) }))
        .sort((a, b) => b.views - a.views);
    };
    const promotionLabel: Record<string, string> = { PROMOCION: 'Promoción', OFERTA: 'Oferta', PREVENTA: 'Preventa', VENTA_SIMPLE: 'Precio normal' };
    return {
      items,
      byCategory: groupBy((item) => item.category || 'sin categoría'),
      byPromotion: groupBy((item) => promotionLabel[String(item.sale_type || '').toUpperCase()] || 'Sin tipo'),
      interestWithoutStock: items.filter((item: any) => item.interestWithoutStock).slice(0, 30),
      withoutMovement: await this.withoutMovement(from, to),
    };
  }

  /** Publicados con stock que no tuvieron vistas en el periodo. */
  private async withoutMovement(from: Date, to: Date) {
    return this.db.query(
      `SELECT p.id, p.title, p.sku, cp.category, cp.slug
         FROM catalog_public cp JOIN products p ON p.id = cp.product_id
         LEFT JOIN LATERAL (SELECT category, owner_user_id FROM staged_products WHERE sku = p.sku ORDER BY updated_at DESC LIMIT 1) s ON true
        WHERE cp.is_published AND p.stock > 0 AND p.status <> 'sold' AND s.owner_user_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM analytics_events e WHERE e.product_id = p.id AND e.event_type = 'view_product' AND e.occurred_at >= $1 AND e.occurred_at < $2)
        ORDER BY cp.created_at ASC LIMIT 30`,
      [from, to],
    );
  }

  // ---------- Búsquedas ----------
  async searches(range: Range) {
    const { from, to } = range;
    const [top, zero, filters] = await Promise.all([
      this.db.query(
        `SELECT query, count(*)::int AS n, round(avg(results))::int AS avg_results, count(*) FILTER (WHERE results = 0)::int AS zero
           FROM analytics_events WHERE event_type = 'search_product' AND query IS NOT NULL AND occurred_at >= $1 AND occurred_at < $2
          GROUP BY query ORDER BY n DESC LIMIT 50`,
        [from, to],
      ),
      this.db.query(
        `SELECT query, count(*)::int AS n, max(occurred_at) AS last_at
           FROM analytics_events WHERE event_type = 'search_product' AND results = 0 AND query IS NOT NULL AND occurred_at >= $1 AND occurred_at < $2
          GROUP BY query ORDER BY n DESC LIMIT 50`,
        [from, to],
      ),
      this.db.query(
        `SELECT f AS filter, count(*)::int AS n
           FROM analytics_events, unnest(filters) AS f
          WHERE event_type = 'apply_filter' AND occurred_at >= $1 AND occurred_at < $2
          GROUP BY f ORDER BY n DESC LIMIT 30`,
        [from, to],
      ),
    ]);
    // Modelos y capacidades que aparecen en lo que escriben los clientes.
    const models = new Map<string, number>();
    const storage = new Map<string, number>();
    for (const row of top) {
      for (const model of extractModels(row.query)) models.set(model, (models.get(model) || 0) + row.n);
      for (const size of extractStorage(row.query)) storage.set(size, (storage.get(size) || 0) + row.n);
    }
    const sorted = (map: Map<string, number>) => Array.from(map, ([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n).slice(0, 20);
    return { top, zero, filters, models: sorted(models), storage: sorted(storage) };
  }

  // ---------- Embudo ----------
  async funnel(range: Range) {
    const t = await this.totals(range.from, range.to);
    const sold = Math.max(t.delivered, 0);
    const stages = [
      { key: 'views', label: 'Visualización', n: t.product_views, note: 'Vistas de fichas de producto' },
      { key: 'interest', label: 'Interés', n: t.interest, note: 'Clics en WhatsApp y añadidos al carrito' },
      { key: 'requests', label: 'Solicitud', n: t.requests, note: 'Solicitudes de compra enviadas' },
      { key: 'confirmed', label: 'Confirmación', n: t.confirmed, note: 'Solicitudes confirmadas por el personal' },
      { key: 'sold', label: 'Venta', n: sold, note: 'Solicitudes entregadas' },
    ];
    const withRates = stages.map((stage, i) => ({
      ...stage,
      fromPrevious: i ? pct(stage.n, stages[i - 1].n) : null,
      fromStart: i ? pct(stage.n, stages[0].n) : null,
      lost: i ? Math.max(0, stages[i - 1].n - stage.n) : null,
    }));
    const biggestDrop = withRates.slice(1).reduce<any>((worst, stage) => (stage.fromPrevious !== null && (worst === null || stage.fromPrevious < worst.fromPrevious) ? stage : worst), null);
    return { stages: withRates, biggestDrop, salesRecorded: { n: t.salesRecorded, amount: t.salesAmount } };
  }

  // ---------- Procedencia ----------
  async sources(range: Range) {
    const { from, to } = range;
    const [sources, referrers, campaigns] = await Promise.all([
      this.db.query(
        `SELECT COALESCE(source, 'direct') AS source, count(*)::int AS visits
           FROM analytics_events WHERE event_type = 'page_view' AND source IS NOT NULL AND occurred_at >= $1 AND occurred_at < $2
          GROUP BY 1 ORDER BY 2 DESC`,
        [from, to],
      ),
      this.db.query(
        `SELECT referrer_host, count(*)::int AS visits
           FROM analytics_events WHERE event_type = 'page_view' AND referrer_host IS NOT NULL AND source IN ('referral','social','search') AND occurred_at >= $1 AND occurred_at < $2
          GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
        [from, to],
      ),
      // Rendimiento de campañas: lo que hicieron después las sesiones que entraron por cada una
      // (solo es posible con las sesiones que aceptaron analíticas).
      this.db.query(
        `WITH landings AS (
           SELECT session_id, COALESCE(utm_source, CASE WHEN source = 'campaign' THEN 'google ads' END) AS utm_source, utm_medium, utm_campaign
             FROM analytics_events
            WHERE event_type = 'page_view' AND source IN ('campaign','social') AND occurred_at >= $1 AND occurred_at < $2
         )
         SELECT l.utm_source, l.utm_medium, l.utm_campaign,
                count(*)::int AS visits,
                count(DISTINCT l.session_id)::int AS sessions,
                (SELECT count(*) FROM analytics_events e WHERE e.session_id = ANY(array_agg(l.session_id)) AND e.event_type = 'view_product' AND e.occurred_at >= $1 AND e.occurred_at < $2)::int AS product_views,
                (SELECT count(*) FROM analytics_events e WHERE e.session_id = ANY(array_agg(l.session_id)) AND e.event_type IN ('click_whatsapp','add_to_cart') AND e.occurred_at >= $1 AND e.occurred_at < $2)::int AS interest,
                (SELECT count(*) FROM analytics_events e WHERE e.session_id = ANY(array_agg(l.session_id)) AND e.event_type = 'complete_order_request' AND e.occurred_at >= $1 AND e.occurred_at < $2)::int AS requests
           FROM landings l
          GROUP BY 1, 2, 3 ORDER BY visits DESC LIMIT 30`,
        [from, to],
      ),
    ]);
    const total = sources.reduce((sum: number, row: any) => sum + row.visits, 0);
    return {
      sources: sources.map((row: any) => ({ ...row, share: pct(row.visits, total) })),
      referrers,
      campaigns: campaigns.map((row: any) => ({ ...row, requestRate: pct(row.requests, row.sessions) })),
    };
  }
}

/** Modelos Apple mencionados en una búsqueda (normalizados). */
export function extractModels(query: string): string[] {
  const q = ` ${String(query || '').toLowerCase()} `;
  const found: string[] = [];
  const iphone = q.match(/iphone\s*(\d{1,2}|se|x[rs]?)(\s*(pro max|pro|plus|mini|max|e))?/);
  if (iphone) found.push(`iPhone ${iphone[1].toUpperCase()}${iphone[3] ? ` ${iphone[3].replace(/\b\w/g, (c) => c.toUpperCase())}` : ''}`);
  const mac = q.match(/macbook\s*(air|pro)?(\s*m(\d))?/);
  if (mac) found.push(`MacBook${mac[1] ? ` ${mac[1][0].toUpperCase()}${mac[1].slice(1)}` : ''}${mac[3] ? ` M${mac[3]}` : ''}`);
  else {
    const chip = q.match(/\bm(\d)\s*(pro|max)?\b/);
    if (chip && !q.includes('iphone')) found.push(`Chip M${chip[1]}${chip[2] ? ` ${chip[2][0].toUpperCase()}${chip[2].slice(1)}` : ''}`);
  }
  const ipad = q.match(/ipad\s*(pro|air|mini)?/);
  if (ipad) found.push(`iPad${ipad[1] ? ` ${ipad[1][0].toUpperCase()}${ipad[1].slice(1)}` : ''}`);
  const watch = q.match(/(apple\s*)?watch\s*(series\s*(\d+)|ultra\s*(\d)?|se)?/);
  if (watch && (watch[2] || q.includes('watch'))) {
    const label = watch[3] ? `Series ${watch[3]}` : watch[2]?.startsWith('ultra') ? `Ultra${watch[4] ? ` ${watch[4]}` : ''}` : watch[2] === 'se' ? 'SE' : '';
    found.push(`Apple Watch${label ? ` ${label}` : ''}`);
  }
  if (/airpods/.test(q)) found.push('AirPods');
  return found;
}

/** Capacidades mencionadas: "256gb", "1 tb", "16 gb ram"… */
export function extractStorage(query: string): string[] {
  const out: string[] = [];
  for (const match of String(query || '').toLowerCase().matchAll(/(\d{1,4})\s*(gb|tb)\b/g)) {
    out.push(`${match[1]} ${match[2].toUpperCase()}`);
  }
  return out;
}
