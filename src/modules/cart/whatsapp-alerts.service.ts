import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

export function whatsappAlertsConfig() {
  if (process.env.MACSO_TEST_DATABASE_URL) return null;
  const instanceId = String(process.env.GREEN_API_INSTANCE_ID || '').trim();
  const token = String(process.env.GREEN_API_TOKEN || '').trim();
  const rawPhone = String(process.env.WHATSAPP_ALERT_PHONE || '').trim();
  const phone = rawPhone.replace(/[+\s()-]/g, '');
  if (!/^\d+$/.test(instanceId) || !/^[A-Za-z0-9_-]+$/.test(token) || !/^[1-9]\d{7,14}$/.test(phone)) return null;
  try {
    const url = new URL(String(process.env.GREEN_API_URL || '').trim());
    // El token solo puede salir hacia los hosts del proveedor configurado.
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) return null;
    if (!['green-api.com', 'greenapi.com'].some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
    return { origin: url.origin, instanceId, token, phone };
  } catch { return null; }
}

/** GREEN-API alojado: no abre sesiones de WhatsApp en el servidor de Macsomenos. */
@Injectable()
export class WhatsAppAlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppAlertsService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  private pausedUntil = 0;

  constructor(private readonly db: DataSource) {}

  pendingMetadata() {
    const config = whatsappAlertsConfig();
    return config ? { whatsapp_alert: {
      event: 'request.created', state: 'pending', phone: config.phone,
      origin: config.origin, instanceId: config.instanceId,
      attempts: 0, dueAt: new Date().toISOString(),
    } } : {};
  }

  onModuleInit() {
    if (!whatsappAlertsConfig()) return;
    this.logger.log('Avisos privados de solicitudes por WhatsApp habilitados.');
    this.timer = setInterval(() => this.kick(), 15000);
    this.timer.unref();
    this.kick();
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  kick() {
    void this.drain().catch(() => this.logger.warn('No se pudieron procesar los avisos de WhatsApp; se reintentará.'));
  }

  async drain() {
    const config = whatsappAlertsConfig();
    if (!config || this.running || this.stopped || Date.now() < this.pausedUntil) return;
    this.running = true;
    try {
      const table = await this.db.query(`SELECT to_regclass('public.contact_requests') AS name`);
      if (!table[0]?.name) return;
      for (let i = 0; i < 10 && !this.stopped; i += 1) {
        const result = await this.db.query(`WITH next_whatsapp_alert AS (
          SELECT id FROM contact_requests
          WHERE metadata->'whatsapp_alert'->>'state' IN ('pending', 'processing')
            AND metadata->'whatsapp_alert'->>'phone' = $1
            AND metadata->'whatsapp_alert'->>'origin' = $2
            AND metadata->'whatsapp_alert'->>'instanceId' = $3
            AND (metadata->'whatsapp_alert'->>'dueAt')::timestamptz <= now()
          ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
        ) UPDATE contact_requests c SET metadata = jsonb_set(c.metadata, '{whatsapp_alert}',
          (c.metadata->'whatsapp_alert') || jsonb_build_object(
            'state', 'processing',
            'attempts', COALESCE((c.metadata->'whatsapp_alert'->>'attempts')::integer, 0) + 1,
            'dueAt', now() + interval '90 seconds'))
        FROM next_whatsapp_alert n WHERE c.id = n.id
        RETURNING c.id, c.metadata->'whatsapp_alert' AS alert`, [config.phone, config.origin, config.instanceId]);
        const rows = Array.isArray(result[0]) ? result[0] : result;
        const row = rows[0];
        if (!row) break;
        let failure: string | null = null;
        let providerMessageId: string | null = null;
        let retryAfter = 0;
        try {
          const response = await fetch(`${config.origin}/waInstance${config.instanceId}/sendMessage/${config.token}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              chatId: `${config.phone}@c.us`,
              message: `🔔 Hay una nueva solicitud en Macsomenos.\nReferencia: ${String(row.id).slice(0, 8)}\nRevísala para atender al cliente:\n${this.panelUrl()}`,
              linkPreview: false,
            }),
            redirect: 'error',
            signal: AbortSignal.timeout(8000),
          });
          const body: any = await response.json();
          if (response.ok && typeof body?.idMessage === 'string' && body.idMessage.trim()) {
            providerMessageId = body.idMessage.slice(0, 200);
          } else {
            failure = `WhatsApp proveedor HTTP ${response.status}`;
            const seconds = Number(response.headers.get('retry-after'));
            if (Number.isFinite(seconds) && seconds > 0) retryAfter = seconds;
          }
        } catch {
          // Las excepciones de fetch pueden incluir la URL con la clave privada.
          failure = 'No se pudo confirmar la aceptación del aviso';
        }
        const attempts = Number(row.alert.attempts);
        const delay = Math.max(retryAfter, Math.min(3600, 15 * 2 ** Math.min(attempts, 8)));
        await this.db.query(`UPDATE contact_requests SET metadata = jsonb_set(metadata, '{whatsapp_alert}',
          (metadata->'whatsapp_alert') || $2::jsonb)
          WHERE id = $1 AND metadata->'whatsapp_alert'->>'state' = 'processing'
            AND (metadata->'whatsapp_alert'->>'attempts')::integer = $3`, [row.id, JSON.stringify(failure ? {
          state: 'pending', lastError: failure, dueAt: new Date(Date.now() + delay * 1000).toISOString(),
        } : {
          // idMessage confirma aceptación por GREEN-API, no entrega al teléfono.
          state: 'accepted', lastError: null, providerMessageId, acceptedAt: new Date().toISOString(),
        }), attempts]);
        if (failure) {
          this.logger.warn('Aviso de WhatsApp pendiente; se reintentará automáticamente.');
          if (retryAfter) this.pausedUntil = Date.now() + retryAfter * 1000;
          break;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private panelUrl() {
    try {
      const url = new URL(process.env.WHATSAPP_PANEL_URL || 'https://www.macsomenos.com/servmacso10/solicitudes');
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* usar el panel por defecto */ }
    return 'https://www.macsomenos.com/servmacso10/solicitudes';
  }
}
