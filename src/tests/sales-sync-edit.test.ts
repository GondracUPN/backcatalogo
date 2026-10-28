import assert from 'node:assert/strict';
import { SalesSyncService } from '../modules/catalog-admin/sales-sync.service';

// Base falsa: solo guarda lo necesario para seguir el flujo de syncSaleEdit.
function fakeDb(createdStatus: string | null) {
  const events = new Map<string, any>();
  if (createdStatus) events.set('created', { id: 'created', event_type: 'sale.created', status: createdStatus, payload: { amount: 2200 } });
  const queries: string[] = [];
  const db: any = {
    query: async (sql: string, params: any[] = []) => {
      queries.push(sql);
      if (sql.startsWith('CREATE')) return [];
      if (sql.includes("event_type = 'sale.created'") && sql.includes('RETURNING id, status')) {
        const row = events.get('created');
        if (!row) return [[], 0];
        row.payload = { ...row.payload, amount: params[1], soldAt: params[2] };
        return [[{ id: row.id, status: row.status }], 1];
      }
      if (sql.includes('INSERT INTO sale_sync_events')) {
        const id = `${params[1]}-event`;
        events.set(id, { id, event_type: params[1], status: 'pending', payload: JSON.parse(params[2]) });
        return [{ id }];
      }
      if (sql.includes('SELECT * FROM sale_sync_events WHERE id = $1')) return [events.get(params[0])].filter(Boolean);
      if (sql.includes("SET status = 'sent'")) events.get(params[0]).status = 'sent';
      return [];
    },
  };
  return { db, events, queries };
}

async function main() {
  const sent: any[] = [];
  process.env.SERVICES_SALES_SYNC_URL = 'http://servicios.test/integrations/catalog-sales/events';
  (globalThis as any).fetch = async (_url: string, init: any) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ ok: true, status: 'update_applied' }) };
  };
  const sale = { id: 'sale-1', product_id: 'p1', sku: 'MS-366', sale_price: 2350, sold_at: '2026-09-03T17:00:00.000Z' };

  // Alta ya recibida por Servicios: se manda sale.updated y se corrige el alta guardada.
  {
    const { db, events } = fakeDb('sent');
    const result: any = await new SalesSyncService(db).syncSaleEdit(sale);
    assert.equal(result.ok, true);
    assert.equal(sent.at(-1).eventType, 'sale.updated');
    assert.equal(sent.at(-1).amount, 2350);
    assert.equal(events.get('created').payload.amount, 2350, 'un reenvío del alta lleva el precio nuevo');
    assert.equal(events.get('created').status, 'sent', 'el alta no vuelve a pendiente');
  }

  // Alta que aún no llegó: se reenvía el alta con el precio nuevo, sin sale.updated.
  {
    const { db, events } = fakeDb('failed');
    sent.length = 0;
    await new SalesSyncService(db).syncSaleEdit(sale);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].amount, 2350);
    assert.ok(![...events.values()].some((row) => row.event_type === 'sale.updated'));
  }

  // Venta anterior a la sincronización: no se envía nada.
  {
    const { db } = fakeDb(null);
    sent.length = 0;
    assert.equal(await new SalesSyncService(db).syncSaleEdit(sale), null);
    assert.equal(sent.length, 0);
  }

  console.log('sales-sync-edit: venta editada se sincroniza con Servicios');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
