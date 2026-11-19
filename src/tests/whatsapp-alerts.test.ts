import 'reflect-metadata';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { WhatsAppAlertsService, whatsappAlertsConfig } from '../modules/cart/whatsapp-alerts.service';
import { CartController } from '../modules/cart/cart.controller';

async function main() {
  const pg = new PGlite();
  const originalFetch = globalThis.fetch;
  const keys = ['GREEN_API_URL', 'GREEN_API_INSTANCE_ID', 'GREEN_API_TOKEN', 'WHATSAPP_ALERT_PHONE', 'WHATSAPP_PANEL_URL', 'MACSO_TEST_DATABASE_URL'] as const;
  const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const calls: any[] = [];
  let status = 200;
  let body: any = { idMessage: 'test-provider-id' };
  let retryAfter = '';
  let failNetwork = false;
  globalThis.fetch = (async (url: string, init: any) => {
    assert.equal(url, 'https://api.green-api.com/waInstance123456/sendMessage/test-secret');
    assert.equal(init.redirect, 'error');
    calls.push(JSON.parse(init.body));
    if (failNetwork) throw new Error('sensitive URL: test-secret');
    return { ok: status === 200, status, json: async () => body, headers: { get: () => retryAfter } };
  }) as any;
  const query = async (sql: string, params: any[] = []) => {
    const result = await pg.query(sql, params);
    return /^WITH next_whatsapp_alert/.test(sql) ? [result.rows, result.affectedRows] : result.rows;
  };
  const db = { query } as any;
  const service = new WhatsAppAlertsService(db);
  const add = async () => {
    const [row]: any = await query(`INSERT INTO contact_requests(metadata) VALUES ($1::jsonb) RETURNING id`, [JSON.stringify({
      customerName: 'NO ENVIAR', source: 'cart', telegram_alert: { state: 'sent' }, ...service.pendingMetadata(),
    })]);
    return row.id;
  };
  const alert = async (id: string) => (await query(`SELECT metadata->'whatsapp_alert' AS alert FROM contact_requests WHERE id = $1`, [id]) as any)[0].alert;
  const makeDue = async (id: string) => query(`UPDATE contact_requests SET metadata = jsonb_set(metadata,
    '{whatsapp_alert,dueAt}', to_jsonb((now() - interval '1 second')::text)) WHERE id = $1`, [id]);
  try {
    delete process.env.MACSO_TEST_DATABASE_URL;
    process.env.GREEN_API_URL = 'https://api.green-api.com';
    process.env.GREEN_API_INSTANCE_ID = '123456';
    process.env.WHATSAPP_ALERT_PHONE = '+51 976 283 856';
    delete process.env.WHATSAPP_PANEL_URL;
    delete process.env.GREEN_API_TOKEN;
    assert.deepEqual(service.pendingMetadata(), {});
    await service.drain();
    process.env.GREEN_API_TOKEN = 'test-secret';
    for (const bad of ['http://api.green-api.com', 'https://green-api.com.evil.test', 'https://api.green-api.com/token', 'https://localhost', 'https://user:pass@api.green-api.com']) {
      process.env.GREEN_API_URL = bad;
      assert.equal(whatsappAlertsConfig(), null, bad);
    }
    process.env.GREEN_API_URL = 'https://api.green-api.com';
    assert.equal(whatsappAlertsConfig()?.phone, '51976283856');
    await service.drain(); // Tabla aún no creada.
    await pg.exec(`CREATE TABLE contact_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), metadata jsonb, created_at timestamptz DEFAULT now())`);
    await query(`INSERT INTO contact_requests(metadata) VALUES ('{"source":"legacy"}')`);
    const first = await add();
    await Promise.all([service.drain(), service.drain(), new WhatsAppAlertsService(db).drain()]);
    assert.equal(calls.length, 1, 'reclamo exclusivo entre instancias');
    assert.equal(calls[0].chatId, '51976283856@c.us');
    assert.ok(calls[0].message.includes('nueva solicitud'));
    assert.ok(calls[0].message.includes('/servmacso10/solicitudes'));
    assert.ok(!calls[0].message.includes('NO ENVIAR'));
    assert.equal((await alert(first)).state, 'accepted', 'aceptado no significa entregado');
    assert.equal((await alert(first)).providerMessageId, 'test-provider-id');
    assert.equal((await query(`SELECT metadata->'telegram_alert'->>'state' AS state FROM contact_requests WHERE id=$1`, [first]) as any)[0].state, 'sent');
    await new WhatsAppAlertsService(db).drain();
    assert.equal(calls.length, 1, 'no repite ni envía registros anteriores');

    const invalidResponse = await add();
    body = {};
    await service.drain();
    assert.equal((await alert(invalidResponse)).state, 'pending');
    await service.drain();
    assert.equal(calls.length, 2, 'espera el backoff');
    body = { idMessage: 'retry-id' };
    await makeDue(invalidResponse);
    await service.drain();
    assert.equal((await alert(invalidResponse)).state, 'accepted');

    const network = await add();
    failNetwork = true;
    await service.drain();
    assert.equal((await alert(network)).state, 'pending');
    assert.ok(!JSON.stringify(await alert(network)).includes('test-secret'));
    failNetwork = false;
    await query(`UPDATE contact_requests SET metadata=jsonb_set(metadata,'{whatsapp_alert,state}','"processing"') WHERE id=$1`, [network]);
    await makeDue(network);
    await service.drain();
    assert.equal((await alert(network)).state, 'accepted', 'recupera proceso interrumpido');

    const limited = await add();
    status = 429; retryAfter = '120'; body = {};
    await service.drain();
    assert.ok(new Date((await alert(limited)).dueAt).getTime() >= Date.now() + 119000);
    const before = calls.length;
    await add();
    await service.drain();
    assert.equal(calls.length, before, 'pausa este trabajador tras rate limit');
    status = 200; retryAfter = ''; body = { idMessage: 'ok' };
    await makeDue(limited);
    await new WhatsAppAlertsService(db).drain();

    const after = calls.length;
    await pg.exec('BEGIN'); await add(); await pg.exec('ROLLBACK');
    await new WhatsAppAlertsService(db).drain();
    assert.equal(calls.length, after, 'rollback también descarta aviso');
    const changed = await add();
    process.env.WHATSAPP_ALERT_PHONE = '51911111111';
    await new WhatsAppAlertsService(db).drain();
    assert.equal(calls.length, after, 'no redirige pendientes a otro número');
    process.env.WHATSAPP_ALERT_PHONE = '51976283856';
    process.env.MACSO_TEST_DATABASE_URL = 'postgres://test@localhost/test';
    assert.deepEqual(service.pendingMetadata(), {});
    await new WhatsAppAlertsService(db).drain();
    assert.equal((await alert(changed)).state, 'pending');
    delete process.env.MACSO_TEST_DATABASE_URL;

    let committed = false, empty = false, kicks = 0;
    let metadata: any;
    const manager: any = {
      query: async (sql: string, params: any[] = []) => {
        if (sql.includes('INSERT INTO contact_requests')) { metadata = JSON.parse(params[10]); assert.equal(committed, false); return [{ id: first }]; }
        return [];
      },
      delete: async () => { empty = true; },
      transaction: async (fn: any) => { await fn(manager); committed = true; },
    };
    const cart = new CartController(
      { manager, find: async () => empty ? [] : [{ product_id: first, qty: 1 }] } as any,
      { manager, findBy: async () => [{ id: first, sku: 'TEST', title: 'Producto', status: 'listed', stock: 1, price: 100 }] } as any,
      { findBy: async () => [{ product_id: first }] } as any, { findBy: async () => [] } as any, undefined,
      { isReady: async () => true, findBySubmission: async () => committed ? [{ number: 'SOL-TEST', contact_request_id: first }] : [], createInTransaction: async () => ({ number: 'SOL-TEST' }) } as any,
      undefined,
      { pendingMetadata: () => service.pendingMetadata(), kick: () => { assert.equal(committed, true); kicks++; } } as any,
    );
    const request = { name: 'Prueba', phone: '999888777', locationScope: 'almacen', submissionKey: 'whatsapp-test-123' };
    await cart.contactRequest({ session: {} }, request, 'test-cart');
    assert.equal(metadata.whatsapp_alert.event, 'request.created');
    assert.equal((await cart.contactRequest({ session: {} }, request, 'test-cart') as any).idempotent, true);
    assert.equal(kicks, 1, 'envío inmediato tras commit; sin duplicar en doble clic');
    console.log('whatsapp-alerts.test.ts ok');
  } finally {
    globalThis.fetch = originalFetch;
    service.onModuleDestroy();
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
    await pg.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
