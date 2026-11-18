import 'reflect-metadata';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { TelegramAlertsService } from '../modules/cart/telegram-alerts.service';
import { CartController } from '../modules/cart/cart.controller';

async function main() {
  const pg = new PGlite();
  const originalFetch = globalThis.fetch;
  const keys = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_PANEL_URL', 'MACSO_TEST_DATABASE_URL'] as const;
  const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const calls: any[] = [];
  let reply: any = { ok: true };
  let status = 200;
  let networkFailure = false;
  globalThis.fetch = (async (url: string, init: any) => {
    assert.equal(url, 'https://api.telegram.org/bot123456:test-token/sendMessage');
    calls.push(JSON.parse(init.body));
    if (networkFailure) throw new Error('secret URL 123456:test-token');
    return { ok: status === 200, status, json: async () => reply };
  }) as any;
  const query = async (sql: string, params: any[] = []) => {
    const result = await pg.query(sql, params);
    return /^WITH next_alert/.test(sql) ? [result.rows, result.affectedRows] : result.rows;
  };
  const service = new TelegramAlertsService({ query } as any);
  const add = async () => {
    const [row]: any = await query(`INSERT INTO contact_requests(metadata) VALUES ($1::jsonb) RETURNING id`, [JSON.stringify({
      source: 'cart', customerExample: 'no enviar datos del cliente', ...service.pendingMetadata(),
    })]);
    return row.id;
  };
  const alert = async (id: string) => {
    const [row]: any = await query(`SELECT metadata->'telegram_alert' AS alert FROM contact_requests WHERE id = $1`, [id]);
    return row.alert;
  };
  const makeDue = async (id: string) => query(`UPDATE contact_requests SET metadata = jsonb_set(metadata,
    '{telegram_alert,dueAt}', to_jsonb((now() - interval '1 second')::text)) WHERE id = $1`, [id]);
  try {
    delete process.env.MACSO_TEST_DATABASE_URL;
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_CHAT_ID = '797262609';
    assert.deepEqual(service.pendingMetadata(), {});
    await service.drain();
    process.env.TELEGRAM_BOT_TOKEN = '123456:test-token';
    delete process.env.TELEGRAM_PANEL_URL;
    await service.drain(); // Primera instalación sin tabla aún.
    await pg.exec(`CREATE TABLE contact_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), metadata jsonb, created_at timestamptz DEFAULT now()
    )`);
    await query(`INSERT INTO contact_requests(metadata) VALUES ('{"source":"legacy"}')`);
    const first = await add();
    await Promise.all([service.drain(), service.drain(), new TelegramAlertsService({ query } as any).drain()]);
    assert.equal(calls.length, 1, 'cada fila solo tiene un trabajador activo');
    assert.equal(calls[0].chat_id, '797262609');
    assert.ok(!JSON.stringify(calls[0]).includes('datos del cliente'));
    assert.equal(calls[0].reply_markup.inline_keyboard[0][0].url, 'https://www.macsomenos.com/servmacso10/solicitudes');
    assert.equal((await alert(first)).state, 'sent');
    await new TelegramAlertsService({ query } as any).drain();
    assert.equal(calls.length, 1, 'reiniciar no reenvía alertas enviadas ni antiguas');

    const failed = await add();
    reply = { ok: false, description: 'respuesta remota sensible' };
    await service.drain();
    assert.equal((await alert(failed)).state, 'pending', 'HTTP 200 con ok:false también es un fallo');
    assert.ok(new Date((await alert(failed)).dueAt).getTime() > Date.now());
    await service.drain();
    assert.equal(calls.length, 2, 'el reintento espera su plazo');
    reply = { ok: true };
    await makeDue(failed);
    await service.drain();
    assert.equal((await alert(failed)).state, 'sent');
    assert.equal((await alert(failed)).attempts, 2);

    const limited = await add();
    status = 429;
    reply = { ok: false, parameters: { retry_after: 120 } };
    await service.drain();
    assert.ok(new Date((await alert(limited)).dueAt).getTime() >= Date.now() + 119000);
    status = 200;
    reply = { ok: true };
    await makeDue(limited);
    await service.drain();

    const network = await add();
    networkFailure = true;
    await service.drain();
    assert.equal((await alert(network)).state, 'pending');
    assert.ok(!JSON.stringify(await alert(network)).includes('test-token'), 'no persiste errores con el token');
    networkFailure = false;
    await query(`UPDATE contact_requests SET metadata = jsonb_set(metadata,
      '{telegram_alert,state}', '"processing"') WHERE id = $1`, [network]);
    await makeDue(network);
    await service.drain();
    assert.equal((await alert(network)).state, 'sent', 'recupera trabajos tras vencer el lease');

    const beforeRollback = calls.length;
    await pg.exec('BEGIN');
    await add();
    await pg.exec('ROLLBACK');
    await service.drain();
    assert.equal(calls.length, beforeRollback, 'un rollback elimina también el aviso');

    // Recorrido real del controlador: guarda el aviso dentro de la transacción,
    // despierta el trabajador después del commit y no avisa en el doble envío.
    {
      let committed = false;
      let empty = false;
      let kicks = 0;
      let savedMetadata: any;
      const manager: any = {
        query: async (sql: string, params: any[] = []) => {
          if (sql.includes('INSERT INTO contact_requests')) {
            savedMetadata = JSON.parse(params[10]);
            assert.equal(committed, false);
            return [{ id: first }];
          }
          return [];
        },
        delete: async () => { empty = true; },
        transaction: async (fn: any) => { await fn(manager); committed = true; },
      };
      const cart = new CartController(
        { manager, find: async () => empty ? [] : [{ product_id: first, qty: 1 }] } as any,
        { manager, findBy: async () => [{ id: first, sku: 'MS-TEST', title: 'iPhone', status: 'listed', stock: 1, price: 100 }] } as any,
        { findBy: async () => [{ product_id: first }] } as any,
        { findBy: async () => [] } as any,
        undefined,
        {
          isReady: async () => true,
          findBySubmission: async () => committed ? [{ number: 'SOL-TEST', contact_request_id: first }] : [],
          createInTransaction: async () => ({ number: 'SOL-TEST' }),
        } as any,
        {
          pendingMetadata: () => service.pendingMetadata(),
          kick: () => { assert.equal(committed, true); kicks += 1; },
        } as any,
      );
      const body = { name: 'Prueba', phone: '999888777', locationScope: 'almacen', submissionKey: 'test-telegram-123' };
      await cart.contactRequest({ session: {} }, body, 'test-cart');
      assert.equal(savedMetadata.telegram_alert.state, 'pending');
      assert.equal(savedMetadata.telegram_alert.chatId, '797262609');
      const repeated: any = await cart.contactRequest({ session: {} }, body, 'test-cart');
      assert.equal(repeated.idempotent, true);
      assert.equal(kicks, 1);
    }

    const privateOnly = await add();
    process.env.TELEGRAM_CHAT_ID = '-123456';
    assert.deepEqual(service.pendingMetadata(), {}, 'no habilitar grupos');
    await service.drain();
    assert.equal((await alert(privateOnly)).state, 'pending');
    process.env.TELEGRAM_CHAT_ID = '123456789';
    await service.drain();
    assert.equal(calls.length, beforeRollback, 'no redirigir pendientes a otro destinatario');
    process.env.TELEGRAM_CHAT_ID = '797262609';
    process.env.MACSO_TEST_DATABASE_URL = 'postgres://test@localhost/test';
    await service.drain();
    assert.equal(calls.length, beforeRollback, 'pruebas aisladas desactivan integraciones');
    console.log('telegram-alerts.test.ts ok');
  } finally {
    globalThis.fetch = originalFetch;
    service.onModuleDestroy();
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    await pg.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
