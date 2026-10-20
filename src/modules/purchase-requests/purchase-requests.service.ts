import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ownerUserIdForStaff, StaffPayload } from '../../utils/staff-auth';
import {
  canTransition,
  HOLDS_STOCK,
  isStatus,
  PAYMENT_METHODS,
  RequestStatus,
  STATUS_LABELS,
  TERMINAL,
  TRANSITIONS,
} from './request-status';

const isUuid = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
const RESERVATION_HOURS = () => Math.max(1, Number(process.env.RESERVATION_HOURS || 48) || 48);

export type NewRequestInput = {
  submissionKey: string | null;
  ownerGroup: string;
  ownerUserId: number | null;
  contactRequestId: string | null;
  customerName: string;
  customerPhone: string;
  deliveryOptionId: string | null;
  deliveryOptionName: string | null;
  deliveryKind: string | null;
  deliveryPointId: string | null;
  locationText: string | null;
  district: string | null;
  address: string | null;
  notes: string | null;
  deliveryCost: number;
  items: Array<{ productId: string | null; sku: string | null; title: string; color: string | null; qty: number; unitPrice: number }>;
};

@Injectable()
export class PurchaseRequestsService {
  constructor(private db: DataSource) {}

  async isReady() {
    const rows = await this.db.query(`SELECT to_regclass('public.purchase_requests') AS name`);
    return Boolean(rows?.[0]?.name);
  }

  /** Solicitudes ya creadas con esta clave (reintento o doble clic). */
  async findBySubmission(submissionKey: string | null) {
    if (!submissionKey || !(await this.isReady())) return [];
    return this.db.query(`SELECT id, number, contact_request_id FROM purchase_requests WHERE submission_key = $1 ORDER BY created_at`, [submissionKey]);
  }

  /** Crea la solicitud dentro de la transacción del carrito. */
  async createInTransaction(mgr: EntityManager, input: NewRequestInput) {
    const [{ seq }] = await mgr.query(`SELECT nextval('purchase_request_number_seq')::bigint AS seq`);
    const number = `SOL-${String(seq).padStart(6, '0')}`;
    const itemsTotal = input.items.reduce((sum, item) => sum + item.unitPrice * item.qty, 0);
    const [request] = await mgr.query(
      `INSERT INTO purchase_requests (
         number, status, submission_key, owner_group, contact_request_id, customer_name, customer_phone,
         delivery_option_id, delivery_option_name, delivery_kind, delivery_point_id, location_text, district, address,
         notes, delivery_cost, items_total, owner_user_id
       ) VALUES ($1,'nueva',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id, number`,
      [number, input.submissionKey, input.ownerGroup, input.contactRequestId, input.customerName, input.customerPhone,
        input.deliveryOptionId, input.deliveryOptionName, input.deliveryKind, input.deliveryPointId, input.locationText,
        input.district, input.address, input.notes, input.deliveryCost.toFixed(2), itemsTotal.toFixed(2), input.ownerUserId],
    );
    for (const item of input.items) {
      await mgr.query(
        `INSERT INTO purchase_request_items (request_id, product_id, sku, title, color, qty, unit_price, line_total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [request.id, item.productId, item.sku, item.title, item.color, item.qty, item.unitPrice.toFixed(2), (item.unitPrice * item.qty).toFixed(2)],
      );
    }
    await mgr.query(
      `INSERT INTO purchase_request_events (request_id, from_status, to_status, actor_username, note) VALUES ($1, NULL, 'nueva', 'cliente', 'Solicitud enviada desde la web')`,
      [request.id],
    );
    return request as { id: string; number: string };
  }

  private assertOwned(staff: StaffPayload, request: any) {
    const expected = ownerUserIdForStaff(staff);
    const actual = request.owner_user_id === null || request.owner_user_id === undefined ? null : Number(request.owner_user_id);
    if (actual !== expected) throw new ForbiddenException();
  }

  async list(staff: StaffPayload, query: { status?: string; q?: string; page?: string; pageSize?: string }) {
    if (!(await this.isReady())) return { items: [], total: 0, counts: {} };
    const params: unknown[] = [ownerUserIdForStaff(staff)];
    const where = ['pr.owner_user_id IS NOT DISTINCT FROM $1'];
    if (query.status && isStatus(query.status)) {
      params.push(query.status);
      where.push(`pr.status = $${params.length}`);
    } else if (query.status === 'activas') {
      where.push(`pr.status NOT IN ('entregada','cancelada')`);
    }
    const q = String(query.q || '').trim();
    if (q) {
      params.push(`%${q}%`);
      where.push(`(pr.number ILIKE $${params.length} OR pr.customer_name ILIKE $${params.length} OR pr.customer_phone ILIKE $${params.length}
        OR EXISTS (SELECT 1 FROM purchase_request_items i WHERE i.request_id = pr.id AND (i.title ILIKE $${params.length} OR i.sku ILIKE $${params.length})))`);
    }
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 30));
    const page = Math.max(1, Number(query.page) || 1);
    const whereSql = where.join(' AND ');
    const [rows, total, counts] = await Promise.all([
      this.db.query(
        `SELECT pr.*, dp.name AS delivery_point_name,
                (SELECT json_agg(json_build_object('title', i.title, 'qty', i.qty, 'color', i.color) ORDER BY i.title) FROM purchase_request_items i WHERE i.request_id = pr.id) AS items
           FROM purchase_requests pr LEFT JOIN delivery_points dp ON dp.id = pr.delivery_point_id
          WHERE ${whereSql}
          ORDER BY CASE WHEN pr.status IN ('entregada','cancelada') THEN 1 ELSE 0 END, pr.created_at DESC
          LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        params,
      ),
      this.db.query(`SELECT count(*)::int AS n FROM purchase_requests pr WHERE ${whereSql}`, params),
      this.db.query(`SELECT status, count(*)::int AS n FROM purchase_requests WHERE owner_user_id IS NOT DISTINCT FROM $1 GROUP BY status`, [params[0]]),
    ]);
    return {
      items: rows,
      total: total[0]?.n || 0,
      counts: Object.fromEntries(counts.map((row: any) => [row.status, row.n])),
    };
  }

  async detail(staff: StaffPayload, id: string) {
    if (!isUuid(id) || !(await this.isReady())) throw new NotFoundException('Solicitud no encontrada');
    const rows = await this.db.query(
      `SELECT pr.*, dp.name AS delivery_point_name FROM purchase_requests pr LEFT JOIN delivery_points dp ON dp.id = pr.delivery_point_id WHERE pr.id = $1`,
      [id],
    );
    const request = rows[0];
    if (!request) throw new NotFoundException('Solicitud no encontrada');
    this.assertOwned(staff, request);
    const [items, events, reservations] = await Promise.all([
      this.db.query(`SELECT * FROM purchase_request_items WHERE request_id = $1 ORDER BY title`, [id]),
      this.db.query(`SELECT * FROM purchase_request_events WHERE request_id = $1 ORDER BY created_at`, [id]),
      this.db.query(
        `SELECT *, (released_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS active FROM stock_reservations WHERE request_id = $1 ORDER BY created_at`,
        [id],
      ),
    ]);
    return { ...request, items, events, reservations, allowedTransitions: TRANSITIONS[request.status as RequestStatus] || [] };
  }

  /**
   * Cambia el estado con una actualización protegida (WHERE status = anterior),
   * registra quién y cuándo, y gestiona las reservas de stock.
   */
  async changeStatus(staff: StaffPayload, id: string, body: any) {
    const to = String(body?.to || '');
    if (!isStatus(to)) throw new BadRequestException('Estado de destino inválido');
    const note = String(body?.note || '').trim().slice(0, 500) || null;
    const cancelReason = String(body?.cancelReason || '').trim().slice(0, 300);
    const paymentMethod = String(body?.paymentMethod || '').trim();
    if (to === 'cancelada' && !cancelReason) throw new BadRequestException('Indica el motivo de la cancelación');
    if (to === 'pagada' && !(PAYMENT_METHODS as readonly string[]).includes(paymentMethod)) {
      throw new BadRequestException('Indica el método de pago para marcarla como pagada');
    }

    const current = await this.detail(staff, id);
    const from = current.status as RequestStatus;
    if (body?.expectedStatus && body.expectedStatus !== from) {
      throw new ConflictException(`La solicitud cambió a «${STATUS_LABELS[from]}». Recarga para ver el estado actual.`);
    }
    if (!canTransition(from, to)) {
      throw new BadRequestException(`No se puede pasar de «${STATUS_LABELS[from]}» a «${STATUS_LABELS[to]}»`);
    }

    await this.db.transaction(async (mgr) => {
      const updated = await mgr.query(
        `UPDATE purchase_requests
            SET status = $3,
                status_changed_at = now(),
                updated_at = now(),
                confirmed_at = CASE WHEN $3 = 'confirmada' AND confirmed_at IS NULL THEN now() ELSE confirmed_at END,
                paid_at = CASE WHEN $3 = 'pagada' THEN now() ELSE paid_at END,
                delivered_at = CASE WHEN $3 = 'entregada' THEN now() ELSE delivered_at END,
                cancelled_at = CASE WHEN $3 = 'cancelada' THEN now() ELSE cancelled_at END,
                cancel_reason = CASE WHEN $3 = 'cancelada' THEN $4 ELSE cancel_reason END
          WHERE id = $1 AND status = $2
          RETURNING id`,
        [id, from, to, cancelReason || null],
      );
      const changedRows = Array.isArray(updated?.[0]) ? updated[0] : updated;
      if (!changedRows?.length) throw new ConflictException('Otra persona cambió esta solicitud. Recarga e inténtalo de nuevo.');

      if (to === 'cancelada' || to === 'entregada' || (from === 'reservada' && !HOLDS_STOCK.includes(to))) {
        await mgr.query(`UPDATE stock_reservations SET released_at = now() WHERE request_id = $1 AND released_at IS NULL`, [id]);
      } else if (HOLDS_STOCK.includes(to)) {
        // Cualquier estado que retiene stock necesita una reserva vigente. Si la
        // solicitud llega a pagada / en preparación / enviada sin haber pasado por
        // «reservada» (o su reserva venció), se reserva ahora comprobando stock.
        const active = await mgr.query(
          `SELECT 1 FROM stock_reservations WHERE request_id = $1 AND released_at IS NULL AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`,
          [id],
        );
        if (!active.length) {
          await mgr.query(`UPDATE stock_reservations SET released_at = now() WHERE request_id = $1 AND released_at IS NULL`, [id]);
          await this.reserve(mgr, id, current.items, staff.username, to === 'reservada');
        }
        // Pagada / en preparación / enviada: la reserva ya no vence sola.
        if (to !== 'reservada') {
          await mgr.query(`UPDATE stock_reservations SET expires_at = NULL WHERE request_id = $1 AND released_at IS NULL`, [id]);
        }
      }

      await mgr.query(
        `INSERT INTO purchase_request_events (request_id, from_status, to_status, actor_user_id, actor_username, note, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [id, from, to, Number(staff.sub) || null, staff.username, to === 'cancelada' ? cancelReason : note,
          JSON.stringify(to === 'pagada' ? { paymentMethod } : {})],
      );
    });
    return this.detail(staff, id);
  }

  /** Reserva unidades bloqueando las filas de producto para evitar sobreventa simultánea. */
  private async reserve(mgr: EntityManager, requestId: string, items: any[], username: string, required = true) {
    const byProduct = new Map<string, number>();
    for (const item of items) {
      if (!item.product_id) continue;
      byProduct.set(item.product_id, (byProduct.get(item.product_id) || 0) + Number(item.qty || 1));
    }
    const productIds = Array.from(byProduct.keys()).sort();
    if (!productIds.length) {
      // Solicitudes antiguas sin productos del catálogo: solo «reservada» lo exige.
      if (required) throw new BadRequestException('La solicitud no tiene productos del catálogo para reservar');
      return;
    }
    const products = await mgr.query(`SELECT id, title, stock, status FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [productIds]);
    const reserved = await mgr.query(
      `SELECT product_id, COALESCE(sum(qty),0)::int AS qty FROM stock_reservations
        WHERE product_id = ANY($1::uuid[]) AND request_id <> $2 AND released_at IS NULL AND (expires_at IS NULL OR expires_at > now())
        GROUP BY product_id`,
      [productIds, requestId],
    );
    const reservedBy = new Map(reserved.map((row: any) => [row.product_id, Number(row.qty)]));
    for (const productId of productIds) {
      const product = products.find((row: any) => row.id === productId);
      const wanted = byProduct.get(productId) || 0;
      if (!product || product.status === 'sold') throw new ConflictException('Un producto de la solicitud ya no está disponible');
      const free = Number(product.stock || 0) - Number(reservedBy.get(productId) || 0);
      if (free < wanted) {
        throw new ConflictException(`Stock insuficiente para «${product.title}»: disponibles ${Math.max(0, free)}, pedidos ${wanted}`);
      }
    }
    const expiresAt = new Date(Date.now() + RESERVATION_HOURS() * 3600 * 1000);
    for (const productId of productIds) {
      await mgr.query(
        `INSERT INTO stock_reservations (request_id, product_id, qty, expires_at, created_by) VALUES ($1,$2,$3,$4,$5)`,
        [requestId, productId, byProduct.get(productId), expiresAt, username],
      );
    }
  }

  /**
   * El panel anterior (alertas y posibles clientes) sigue funcionando: sus
   * acciones actualizan la solicitud enlazada y quedan en el historial.
   */
  async syncFromLegacy(contactRequestId: string | null | undefined, to: RequestStatus, actor: string, note: string) {
    if (!contactRequestId || !(await this.isReady())) return;
    const rows = await this.db.query(`SELECT id, status FROM purchase_requests WHERE contact_request_id = $1`, [contactRequestId]);
    for (const row of rows) {
      const from = row.status as RequestStatus;
      if (TERMINAL.includes(from) || from === to) continue;
      // «Atendida» solo avanza solicitudes nuevas; no retrocede estados posteriores.
      if (to === 'pendiente_confirmacion' && from !== 'nueva') continue;
      await this.db.transaction(async (mgr) => {
        const updated = await mgr.query(
          `UPDATE purchase_requests SET status = $3, status_changed_at = now(), updated_at = now(),
             delivered_at = CASE WHEN $3 = 'entregada' THEN now() ELSE delivered_at END,
             cancelled_at = CASE WHEN $3 = 'cancelada' THEN now() ELSE cancelled_at END,
             cancel_reason = CASE WHEN $3 = 'cancelada' THEN $4 ELSE cancel_reason END
           WHERE id = $1 AND status = $2 RETURNING id`,
          [row.id, from, to, to === 'cancelada' ? note : null],
        );
        const changedRows = Array.isArray(updated?.[0]) ? updated[0] : updated;
        if (!changedRows?.length) return;
        if (TERMINAL.includes(to)) await mgr.query(`UPDATE stock_reservations SET released_at = now() WHERE request_id = $1 AND released_at IS NULL`, [row.id]);
        await mgr.query(
          `INSERT INTO purchase_request_events (request_id, from_status, to_status, actor_username, note) VALUES ($1,$2,$3,$4,$5)`,
          [row.id, from, to, actor, note],
        );
      });
    }
  }
}
