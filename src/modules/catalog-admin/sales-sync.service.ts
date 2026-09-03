import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

type SaleSyncEventType = 'sale.created' | 'sale.cancelled';

type SaleSyncSource = {
  id: string;
  product_id: string;
  sku?: string | null;
  product_title?: string | null;
  sale_price?: string | number | null;
  exchange_rate?: string | number | null;
  sold_at?: string | Date | null;
};

@Injectable()
export class SalesSyncService implements OnModuleInit {
  private ready: Promise<void> | null = null;

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit() {
    setTimeout(() => {
      this.retryPending().catch((error) => {
        console.error('[sales-sync] No se pudieron reenviar los eventos pendientes:', error);
      });
    }, 1200);
  }

  async ensureTable() {
    if (!this.ready) {
      this.ready = (async () => {
        await this.dataSource.query(`CREATE TABLE IF NOT EXISTS sale_sync_events (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          sale_id uuid NOT NULL,
          event_type text NOT NULL,
          payload jsonb NOT NULL,
          status text NOT NULL DEFAULT 'pending',
          attempts integer NOT NULL DEFAULT 0,
          last_error text NULL,
          remote_status text NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          sent_at timestamptz NULL,
          UNIQUE (sale_id, event_type)
        )`);
        await this.dataSource.query(
          `CREATE INDEX IF NOT EXISTS idx_sale_sync_events_status ON sale_sync_events (status, created_at)`,
        );
      })().catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  async enqueue(eventType: SaleSyncEventType, sale: SaleSyncSource) {
    await this.ensureTable();
    const payload = {
      eventType,
      catalogSaleId: String(sale.id),
      catalogProductId: String(sale.product_id),
      sku: String(sale.sku || '').trim(),
      title: String(sale.product_title || '').trim() || null,
      amount: Number(sale.sale_price || 0),
      // Las ventas anteriores a la sincronizacion no guardaban tipo de cambio.
      // El receptor antiguo lo exige aun para anulaciones, aunque no lo usa.
      exchangeRate: Number(sale.exchange_rate || (eventType === 'sale.cancelled' ? 1 : 0)),
      soldAt: sale.sold_at ? new Date(sale.sold_at).toISOString() : new Date().toISOString(),
    };
    const rows = await this.dataSource.query(
      `INSERT INTO sale_sync_events (sale_id, event_type, payload)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (sale_id, event_type) DO UPDATE
       SET payload = EXCLUDED.payload, status = 'pending', last_error = NULL, updated_at = now()
       RETURNING id`,
      [sale.id, eventType, JSON.stringify(payload)],
    );
    return String(rows[0].id);
  }

  async dispatch(eventId: string) {
    await this.ensureTable();
    const rows = await this.dataSource.query(`SELECT * FROM sale_sync_events WHERE id = $1 LIMIT 1`, [eventId]);
    const event = rows[0];
    if (!event) throw new Error('sync event not found');

    const url = String(process.env.SERVICES_SALES_SYNC_URL || '').trim();
    if (!url) {
      await this.dataSource.query(
        `UPDATE sale_sync_events SET status = 'configuration_required', last_error = $2, updated_at = now() WHERE id = $1`,
        [eventId, 'Configura SERVICES_SALES_SYNC_URL'],
      );
      return { ok: false, status: 'configuration_required' };
    }

    const payload = event.payload;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-macso-event-id': String(event.id),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      const result: any = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(result?.message || `HTTP ${response.status}`));
      await this.dataSource.query(
        `UPDATE sale_sync_events
         SET status = 'sent', attempts = attempts + 1, last_error = NULL,
             remote_status = $2, sent_at = now(), updated_at = now()
         WHERE id = $1`,
        [eventId, String(result?.status || 'pending_confirmation')],
      );
      return { ok: true, status: String(result?.status || 'pending_confirmation') };
    } catch (error) {
      const baseMessage = error instanceof Error ? error.message : 'No se pudo contactar a Servicios';
      const cause = (error as any)?.cause;
      const causeDetail = String(cause?.code || cause?.message || '').trim();
      const message = causeDetail && !baseMessage.includes(causeDetail)
        ? `${baseMessage}: ${causeDetail}`
        : baseMessage;
      await this.dataSource.query(
        `UPDATE sale_sync_events
         SET status = 'failed', attempts = attempts + 1, last_error = $2, updated_at = now()
         WHERE id = $1`,
        [eventId, message.slice(0, 1000)],
      );
      return { ok: false, status: 'failed', error: message };
    }
  }

  async enqueueAndDispatch(eventType: SaleSyncEventType, sale: SaleSyncSource) {
    const eventId = await this.enqueue(eventType, sale);
    return { eventId, ...(await this.dispatch(eventId)) };
  }

  async updateRemoteStatus(eventId: string, remoteStatus: string) {
    await this.ensureTable();
    const allowed = new Set(['pending_confirmation', 'confirmed', 'rejected', 'pending_cancellation_confirmation', 'cancelled']);
    if (!allowed.has(remoteStatus)) return { ok: false, status: 'invalid_status' };
    const rows = await this.dataSource.query(
      `UPDATE sale_sync_events
          SET status = 'sent', remote_status = $2, last_error = NULL, updated_at = now()
        WHERE id = $1
        RETURNING id`,
      [eventId, remoteStatus],
    );
    return { ok: rows.length > 0, status: remoteStatus };
  }

  async retryPending() {
    await this.ensureTable();
    const rows = await this.dataSource.query(
      `SELECT id FROM sale_sync_events
       WHERE status IN ('pending', 'failed', 'configuration_required')
       ORDER BY created_at ASC
       LIMIT 100`,
    );
    for (const row of rows) {
      await this.dispatch(String(row.id));
    }
    return { total: rows.length };
  }
}
