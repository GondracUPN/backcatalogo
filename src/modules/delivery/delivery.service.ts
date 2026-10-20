import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { exactPointMatch, locationKey, suggestPoints } from './location-matching';

export const DELIVERY_KINDS = ['pickup', 'cash_on_delivery', 'meeting_point', 'delivery', 'province', 'other'] as const;
export const POINT_KINDS = ['warehouse', 'mall', 'meeting_point', 'other'] as const;

export type DeliveryOption = {
  id: string; code: string; name: string; kind: string; description: string | null; cost: string; cost_note: string | null;
  schedule: string | null; conditions: string | null; requires_point: boolean; requires_district: boolean;
  requires_address: boolean; active: boolean; sort_order: number;
};

export type DeliveryPoint = {
  id: string; name: string; name_key: string; aliases: string[]; alias_keys: string[]; kind: string;
  district: string | null; address: string | null; active: boolean;
};

function str(value: unknown, max: number, field: string, required = false) {
  const result = String(value ?? '').trim();
  if (required && !result) throw new BadRequestException(`${field}: obligatorio`);
  if (result.length > max) throw new BadRequestException(`${field}: máximo ${max} caracteres`);
  return result || null;
}

const isUuid = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));

export function validateOption(body: any, current?: DeliveryOption) {
  const pick = (key: string, snake: string) => (key in (body || {}) ? body[key] : snake in (body || {}) ? body[snake] : (current as any)?.[snake]);
  const code = String(pick('code', 'code') ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,40}$/.test(code)) throw new BadRequestException('code: usa letras minúsculas, números o _ (2 a 40)');
  const kind = String(pick('kind', 'kind') ?? '');
  if (!(DELIVERY_KINDS as readonly string[]).includes(kind)) throw new BadRequestException('kind inválido');
  const cost = Number(pick('cost', 'cost') ?? 0);
  if (!Number.isFinite(cost) || cost < 0 || cost > 100000) throw new BadRequestException('cost: número entre 0 y 100000');
  const sortOrder = Number(pick('sortOrder', 'sort_order') ?? 0);
  if (!Number.isInteger(sortOrder)) throw new BadRequestException('sortOrder: entero');
  return {
    code,
    name: str(pick('name', 'name'), 60, 'name', true)!,
    kind,
    description: str(pick('description', 'description'), 300, 'description'),
    cost: cost.toFixed(2),
    cost_note: str(pick('costNote', 'cost_note'), 100, 'costNote'),
    schedule: str(pick('schedule', 'schedule'), 200, 'schedule'),
    conditions: str(pick('conditions', 'conditions'), 500, 'conditions'),
    requires_point: Boolean(pick('requiresPoint', 'requires_point')),
    requires_district: Boolean(pick('requiresDistrict', 'requires_district')),
    requires_address: Boolean(pick('requiresAddress', 'requires_address')),
    active: pick('active', 'active') === undefined ? true : Boolean(pick('active', 'active')),
    sort_order: sortOrder,
  };
}

export function validatePoint(body: any, current?: DeliveryPoint) {
  const pick = (key: string) => (key in (body || {}) ? body[key] : (current as any)?.[key]);
  const name = str(pick('name'), 80, 'name', true)!;
  const nameKey = locationKey(name);
  if (!nameKey) throw new BadRequestException('name: escribe un nombre válido');
  const kind = String(pick('kind') ?? 'meeting_point');
  if (!(POINT_KINDS as readonly string[]).includes(kind)) throw new BadRequestException('kind inválido');
  const rawAliases = Array.isArray(pick('aliases')) ? pick('aliases') : [];
  if (rawAliases.length > 30) throw new BadRequestException('aliases: máximo 30');
  const aliases = Array.from(new Set(rawAliases.map((alias: unknown) => str(alias, 80, 'alias')).filter(Boolean))) as string[];
  const aliasKeys = Array.from(new Set(aliases.map(locationKey).filter((key) => key && key !== nameKey)));
  return {
    name,
    name_key: nameKey,
    aliases,
    alias_keys: aliasKeys,
    kind,
    district: str(pick('district'), 60, 'district'),
    address: str(pick('address'), 200, 'address'),
    active: pick('active') === undefined ? true : Boolean(pick('active')),
  };
}

@Injectable()
export class DeliveryService {
  constructor(private db: DataSource) {}

  private async tableExists(name: string) {
    const rows = await this.db.query(`SELECT to_regclass($1) AS name`, [`public.${name}`]);
    return Boolean(rows?.[0]?.name);
  }

  // ----- Opciones -----
  listOptions(onlyActive = false) {
    return this.db.query(
      `SELECT * FROM delivery_options ${onlyActive ? 'WHERE active' : ''} ORDER BY sort_order, name`,
    ) as Promise<DeliveryOption[]>;
  }

  async getOption(id: string) {
    if (!isUuid(id)) throw new NotFoundException('Opción de entrega no encontrada');
    const rows = await this.db.query(`SELECT * FROM delivery_options WHERE id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException('Opción de entrega no encontrada');
    return rows[0] as DeliveryOption;
  }

  async saveOption(id: string | null, body: any) {
    const current = id ? await this.getOption(id) : undefined;
    const v = validateOption(body, current);
    try {
      const rows = id
        ? await this.db.query(
            `UPDATE delivery_options SET code=$2, name=$3, kind=$4, description=$5, cost=$6, cost_note=$7, schedule=$8, conditions=$9,
               requires_point=$10, requires_district=$11, requires_address=$12, active=$13, sort_order=$14, updated_at=now()
             WHERE id=$1 RETURNING *`,
            [id, v.code, v.name, v.kind, v.description, v.cost, v.cost_note, v.schedule, v.conditions, v.requires_point, v.requires_district, v.requires_address, v.active, v.sort_order],
          )
        : await this.db.query(
            `INSERT INTO delivery_options (code, name, kind, description, cost, cost_note, schedule, conditions, requires_point, requires_district, requires_address, active, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
            [v.code, v.name, v.kind, v.description, v.cost, v.cost_note, v.schedule, v.conditions, v.requires_point, v.requires_district, v.requires_address, v.active, v.sort_order],
          );
      return (Array.isArray(rows[0]) ? rows[0][0] : rows[0]) as DeliveryOption;
    } catch (error: any) {
      if (error?.code === '23505') throw new ConflictException('Ya existe una opción con ese código');
      throw error;
    }
  }

  // ----- Puntos -----
  listPoints(onlyActive = false) {
    return this.db.query(`SELECT * FROM delivery_points ${onlyActive ? 'WHERE active' : ''} ORDER BY name`) as Promise<DeliveryPoint[]>;
  }

  async getPoint(id: string) {
    if (!isUuid(id)) throw new NotFoundException('Punto no encontrado');
    const rows = await this.db.query(`SELECT * FROM delivery_points WHERE id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException('Punto no encontrado');
    return rows[0] as DeliveryPoint;
  }

  /**
   * Crea o edita un punto. Si el nombre se parece a otro existente y no se
   * confirmó (`force`), devuelve sugerencias en lugar de crear un duplicado.
   */
  async savePoint(id: string | null, body: any) {
    const current = id ? await this.getPoint(id) : undefined;
    const v = validatePoint(body, current);
    // Mismo nombre normalizado ("CC Jockey Plaza" = "Jockey Plaza"): es el mismo lugar.
    const sameKey = await this.db.query(
      `SELECT name FROM delivery_points WHERE ($1::uuid IS NULL OR id <> $1::uuid) AND (name_key = $2 OR $2 = ANY(alias_keys)) LIMIT 1`,
      [id, v.name_key],
    );
    if (sameKey[0]) throw new ConflictException(`Ya existe «${sameKey[0].name}» con ese nombre`);
    if (!id && !body?.force) {
      const others = await this.listPoints();
      const similar = suggestPoints(v.name, others, 0.8);
      if (similar.length) {
        return { ok: false as const, needsConfirmation: true, suggestions: similar.map((entry) => ({ id: entry.point.id, name: entry.point.name, score: +entry.score.toFixed(2) })) };
      }
    }
    try {
      const rows = id
        ? await this.db.query(
            `UPDATE delivery_points SET name=$2, name_key=$3, aliases=$4, alias_keys=$5, kind=$6, district=$7, address=$8, active=$9, updated_at=now() WHERE id=$1 RETURNING *`,
            [id, v.name, v.name_key, v.aliases, v.alias_keys, v.kind, v.district, v.address, v.active],
          )
        : await this.db.query(
            `INSERT INTO delivery_points (name, name_key, aliases, alias_keys, kind, district, address, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [v.name, v.name_key, v.aliases, v.alias_keys, v.kind, v.district, v.address, v.active],
          );
      const point = (Array.isArray(rows[0]) ? rows[0][0] : rows[0]) as DeliveryPoint;
      await this.linkUnmatchedRequests(point);
      return { ok: true as const, item: point };
    } catch (error: any) {
      if (error?.code === '23505') throw new ConflictException('Ya existe un punto con ese nombre');
      throw error;
    }
  }

  /** Confirma que un texto escrito por clientes corresponde a un punto: lo guarda como alias. */
  async addAlias(id: string, alias: unknown) {
    const point = await this.getPoint(id);
    const text = str(alias, 80, 'alias', true)!;
    const key = locationKey(text);
    if (!key) throw new BadRequestException('alias inválido');
    const owner = await this.db.query(`SELECT id, name FROM delivery_points WHERE id <> $1 AND (name_key = $2 OR $2 = ANY(alias_keys))`, [id, key]);
    if (owner[0]) throw new ConflictException(`Ese nombre ya pertenece a «${owner[0].name}»`);
    const aliases = Array.from(new Set([...(point.aliases || []), text]));
    return this.savePoint(id, { ...point, aliases, force: true });
  }

  /** Enlaza solicitudes sin punto cuyo texto coincide exactamente (clave normalizada). */
  private async linkUnmatchedRequests(point: DeliveryPoint) {
    if (!(await this.tableExists('purchase_requests'))) return;
    const rows = await this.db.query(`SELECT id, location_text FROM purchase_requests WHERE delivery_point_id IS NULL AND location_text IS NOT NULL`);
    const ids = rows.filter((row: any) => exactPointMatch(row.location_text, [point])).map((row: any) => row.id);
    if (ids.length) await this.db.query(`UPDATE purchase_requests SET delivery_point_id = $1, updated_at = now() WHERE id = ANY($2::uuid[])`, [point.id, ids]);
  }

  /** Resuelve el punto para un texto libre: solo coincidencias exactas. */
  async resolvePointForText(text: unknown) {
    if (!locationKey(text)) return null;
    return exactPointMatch(text, await this.listPoints());
  }

  /** Textos escritos a mano que aún no corresponden a ningún punto, con sugerencias. */
  async unmatched() {
    const points = await this.listPoints();
    const sources: Array<{ sql: string; table: string }> = [
      { table: 'purchase_requests', sql: `SELECT location_text AS text, count(*)::int AS n FROM purchase_requests WHERE delivery_point_id IS NULL AND COALESCE(location_text,'') <> '' AND owner_user_id IS NULL GROUP BY 1` },
      { table: 'sold_records', sql: `SELECT sale_location AS text, count(*)::int AS n FROM sold_records WHERE COALESCE(sale_location,'') <> '' AND owner_user_id IS NULL GROUP BY 1` },
      { table: 'possible_clients', sql: `SELECT sale_location AS text, count(*)::int AS n FROM possible_clients WHERE COALESCE(sale_location,'') <> '' AND owner_user_id IS NULL GROUP BY 1` },
    ];
    const counts = new Map<string, { text: string; count: number }>();
    for (const source of sources) {
      if (!(await this.tableExists(source.table))) continue;
      for (const row of await this.db.query(source.sql)) {
        const key = locationKey(row.text);
        if (!key || exactPointMatch(row.text, points)) continue;
        const entry = counts.get(key) || { text: String(row.text).trim(), count: 0 };
        entry.count += Number(row.n || 0);
        counts.set(key, entry);
      }
    }
    return Array.from(counts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 100)
      .map((entry) => ({
        ...entry,
        suggestions: suggestPoints(entry.text, points).map((s) => ({ id: s.point.id, name: s.point.name, score: +s.score.toFixed(2) })),
      }));
  }

  /**
   * Estadísticas por punto (solo datos de Macsomenos). Separa:
   * elegidos (cualquier estado), programados (confirmados y en curso) y
   * entregados (estado «entregada»). Incluye las ventas históricas registradas
   * en sold_records cuyo lugar coincide con un punto.
   */
  async stats(fromRaw?: string, toRaw?: string) {
    const from = fromRaw && !Number.isNaN(Date.parse(fromRaw)) ? new Date(fromRaw) : new Date(Date.now() - 90 * 864e5);
    const to = toRaw && !Number.isNaN(Date.parse(toRaw)) ? new Date(toRaw) : new Date();
    const points = await this.listPoints();
    const byPoint = new Map<string, any>();
    const ensure = (id: string, name: string) => {
      if (!byPoint.has(id)) {
        byPoint.set(id, { pointId: id, name, chosen: 0, scheduled: 0, delivered: 0, deliveredRevenue: 0, deliveryCosts: 0, historicalSales: 0, historicalRevenue: 0, topProducts: [] as Array<{ title: string; qty: number }>, monthly: {} as Record<string, number>, weekdays: [0, 0, 0, 0, 0, 0, 0] });
      }
      return byPoint.get(id);
    };
    for (const point of points) ensure(point.id, point.name);

    if (await this.tableExists('purchase_requests')) {
      const rows = await this.db.query(
        `SELECT COALESCE(delivery_point_id::text, 'sin_punto') AS point_id,
                count(*)::int AS chosen,
                count(*) FILTER (WHERE status IN ('confirmada','reservada','pagada','en_preparacion','enviada'))::int AS scheduled,
                count(*) FILTER (WHERE status = 'entregada')::int AS delivered,
                COALESCE(sum(items_total) FILTER (WHERE status = 'entregada'), 0)::float AS revenue,
                COALESCE(sum(delivery_cost) FILTER (WHERE status = 'entregada'), 0)::float AS delivery_costs
           FROM purchase_requests
          WHERE owner_user_id IS NULL AND created_at BETWEEN $1 AND $2
          GROUP BY 1`,
        [from, to],
      );
      for (const row of rows) {
        const entry = ensure(row.point_id, row.point_id === 'sin_punto' ? 'Sin punto asignado' : 'Punto eliminado');
        Object.assign(entry, { chosen: row.chosen, scheduled: row.scheduled, delivered: row.delivered, deliveredRevenue: row.revenue, deliveryCosts: row.delivery_costs });
      }
      const delivered = await this.db.query(
        `SELECT COALESCE(delivery_point_id::text, 'sin_punto') AS point_id,
                to_char(delivered_at AT TIME ZONE 'America/Lima', 'YYYY-MM') AS month,
                extract(dow FROM delivered_at AT TIME ZONE 'America/Lima')::int AS dow,
                count(*)::int AS n
           FROM purchase_requests
          WHERE owner_user_id IS NULL AND status = 'entregada' AND delivered_at BETWEEN $1 AND $2
          GROUP BY 1, 2, 3`,
        [from, to],
      );
      for (const row of delivered) {
        const entry = ensure(row.point_id, 'Sin punto asignado');
        entry.monthly[row.month] = (entry.monthly[row.month] || 0) + row.n;
        entry.weekdays[row.dow] += row.n;
      }
      const products = await this.db.query(
        `SELECT COALESCE(pr.delivery_point_id::text, 'sin_punto') AS point_id, i.title, sum(i.qty)::int AS qty
           FROM purchase_request_items i JOIN purchase_requests pr ON pr.id = i.request_id
          WHERE pr.owner_user_id IS NULL AND pr.status = 'entregada' AND pr.delivered_at BETWEEN $1 AND $2
          GROUP BY 1, 2 ORDER BY 3 DESC`,
        [from, to],
      );
      for (const row of products) {
        const entry = ensure(row.point_id, 'Sin punto asignado');
        if (entry.topProducts.length < 3) entry.topProducts.push({ title: row.title, qty: row.qty });
      }
    }

    // Historial: ventas registradas antes de este módulo (sold_records).
    if (await this.tableExists('sold_records')) {
      const warehouse = points.find((point) => point.kind === 'warehouse');
      const sales = await this.db.query(
        `SELECT sale_place_type, sale_location, count(*)::int AS n, COALESCE(sum(sale_price),0)::float AS total
           FROM sold_records WHERE owner_user_id IS NULL AND sold_at BETWEEN $1 AND $2 GROUP BY 1, 2`,
        [from, to],
      );
      for (const row of sales) {
        const point = row.sale_place_type === 'almacen' ? warehouse : exactPointMatch(row.sale_location, points);
        const entry = point ? ensure(point.id, point.name) : ensure('sin_punto', 'Sin punto asignado');
        entry.historicalSales += row.n;
        entry.historicalRevenue += row.total;
      }
    }

    const items = Array.from(byPoint.values());
    const totalDelivered = items.reduce((sum, item) => sum + item.delivered, 0);
    const totalChosen = items.reduce((sum, item) => sum + item.chosen, 0);
    for (const item of items) {
      item.deliveredShare = totalDelivered ? +(item.delivered / totalDelivered * 100).toFixed(1) : 0;
      item.chosenShare = totalChosen ? +(item.chosen / totalChosen * 100).toFixed(1) : 0;
      // Margen de entregas solo si hay costos registrados; si no, se deja vacío.
      item.deliveryMargin = item.deliveryCosts > 0 ? +(item.deliveredRevenue - item.deliveryCosts).toFixed(2) : null;
    }
    items.sort((a, b) => b.delivered - a.delivered || b.chosen - a.chosen || b.historicalSales - a.historicalSales);
    return { from: from.toISOString(), to: to.toISOString(), totals: { chosen: totalChosen, delivered: totalDelivered }, items };
  }
}
