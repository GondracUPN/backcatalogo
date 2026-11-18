import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** La cola vive en metadata de la solicitud: se confirma o revierte con ella. */
@Injectable()
export class TelegramAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramAlertsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;

  constructor(private readonly db: DataSource) {}

  private config() {
    const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
    const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
    // Solo chats privados; las pruebas con base aislada no contactan servicios.
    if (process.env.MACSO_TEST_DATABASE_URL || !/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^[1-9]\d*$/.test(chatId)) return null;
    return { token, chatId };
  }

  pendingMetadata() {
    const config = this.config();
    return config ? {
      telegram_alert: { state: 'pending', chatId: config.chatId, attempts: 0, dueAt: new Date().toISOString() },
    } : {};
  }

  onModuleInit() {
    if (!this.config()) return;
    this.timer = setInterval(() => this.kick(), 15000);
    this.timer.unref();
    this.kick();
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  kick() {
    // Nunca propagar al checkout errores de Telegram, SQL ni URLs con el token.
    void this.drain().catch(() => this.logger.warn('No se pudieron procesar las alertas de Telegram; se reintentará.'));
  }

  async drain() {
    const config = this.config();
    if (!config || this.running || this.stopped) return;
    this.running = true;
    try {
      const table = await this.db.query(`SELECT to_regclass('public.contact_requests') AS name`);
      if (!table[0]?.name) return;
      for (let i = 0; i < 10 && !this.stopped; i += 1) {
        // Reclamo atómico y lease: evita envíos simultáneos entre instancias y
        // recupera el aviso si un proceso muere durante la petición HTTP.
        const result = await this.db.query(`WITH next_alert AS (
          SELECT id FROM contact_requests
          WHERE metadata->'telegram_alert'->>'state' IN ('pending', 'processing')
            AND metadata->'telegram_alert'->>'chatId' = $1
            AND (metadata->'telegram_alert'->>'dueAt')::timestamptz <= now()
          ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE contact_requests c SET metadata = jsonb_set(c.metadata, '{telegram_alert}',
          (c.metadata->'telegram_alert') || jsonb_build_object(
            'state', 'processing',
            'attempts', COALESCE((c.metadata->'telegram_alert'->>'attempts')::integer, 0) + 1,
            'dueAt', now() + interval '90 seconds'))
        FROM next_alert n WHERE c.id = n.id RETURNING c.id, c.metadata->'telegram_alert' AS alert`, [config.chatId]);
        // TypeORM/Postgres devuelve [filas, cantidad] para UPDATE RETURNING.
        const rows = Array.isArray(result[0]) ? result[0] : result;
        const row = rows[0];
        if (!row) break;
        let failure: string | null = null;
        let retryAfter = 0;
        try {
          const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chat_id: config.chatId,
              text: `🔔 Nueva solicitud en Macsomenos.\nReferencia: ${String(row.id).slice(0, 8)}\nEntra al panel para atenderla.`,
              reply_markup: { inline_keyboard: [[{ text: 'Ver solicitudes', url: this.panelUrl() }]] },
            }),
            signal: AbortSignal.timeout(8000),
          });
          const body: any = await response.json();
          if (!response.ok || body?.ok !== true) {
            failure = `Telegram HTTP ${response.status}`;
            const seconds = Number(body?.parameters?.retry_after);
            if (Number.isFinite(seconds) && seconds > 0) retryAfter = seconds;
          }
        } catch {
          failure = 'Telegram no respondió correctamente';
        }
        const attempts = Number(row.alert.attempts);
        const delay = Math.max(retryAfter, Math.min(3600, 15 * 2 ** Math.min(attempts, 8)));
        // No se almacena la respuesta remota ni el error de fetch: pueden
        // contener datos sensibles. El token nunca entra en la base de datos.
        await this.db.query(`UPDATE contact_requests SET metadata = jsonb_set(metadata, '{telegram_alert}',
          (metadata->'telegram_alert') || $2::jsonb)
          WHERE id = $1 AND metadata->'telegram_alert'->>'state' = 'processing'
            AND (metadata->'telegram_alert'->>'attempts')::integer = $3`, [row.id, JSON.stringify(failure ? {
          state: 'pending', lastError: failure, dueAt: new Date(Date.now() + delay * 1000).toISOString(),
        } : { state: 'sent', lastError: null, sentAt: new Date().toISOString() }), attempts]);
        if (failure) {
          this.logger.warn('Alerta de Telegram pendiente; se reintentará automáticamente.');
          // No enviar el resto de este lote tras una respuesta de límite.
          if (retryAfter) break;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private panelUrl() {
    try {
      const url = new URL(process.env.TELEGRAM_PANEL_URL || 'https://www.macsomenos.com/servmacso10/solicitudes');
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* usar el panel público por defecto */ }
    return 'https://www.macsomenos.com/servmacso10/solicitudes';
  }
}
