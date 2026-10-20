import { strict as assert } from 'assert';
import { canTransition, TRANSITIONS } from '../modules/purchase-requests/request-status';
import { PurchaseRequestsService } from '../modules/purchase-requests/purchase-requests.service';
import { CartController } from '../modules/cart/cart.controller';

// Base de datos simulada: responde según el SQL recibido.
function fakeDb(state: { request: any; items?: any[]; products?: any[]; reserved?: any[] }) {
  const log: string[] = [];
  const query = async (sql: string, params: any[] = []) => {
    log.push(sql.replace(/\s+/g, ' ').trim().slice(0, 60));
    if (/to_regclass/.test(sql)) return [{ name: 'purchase_requests' }];
    if (/FROM purchase_requests pr LEFT JOIN delivery_points/.test(sql)) return state.request ? [{ ...state.request }] : [];
    if (/FROM purchase_request_items/.test(sql)) return state.items || [];
    if (/FROM purchase_request_events/.test(sql)) return [];
    if (/FROM stock_reservations WHERE request_id/.test(sql)) return [];
    if (/^\s*UPDATE purchase_requests/.test(sql)) {
      if (state.request.status !== params[1]) return [[], 0];
      state.request.status = params[2];
      return [[{ id: state.request.id }], 1];
    }
    if (/FROM products WHERE id = ANY/.test(sql)) return state.products || [];
    if (/FROM stock_reservations\s+WHERE product_id = ANY/.test(sql)) return state.reserved || [];
    return [];
  };
  const db: any = { query, transaction: async (fn: any) => fn({ query }) };
  return { db, log };
}

const admin = { sub: 1, username: 'admin', role: 'ADMIN', canViewServiceInventory: false };
const sellerA = { sub: 7, username: 'vendedorA', role: 'VENDEDOR', canViewServiceInventory: false };
const baseRequest = { id: '11111111-1111-1111-1111-111111111111', status: 'nueva', owner_user_id: null };

(async () => {
  // Transiciones: nunca se llega a pagada/entregada desde «nueva» directamente.
  assert.equal(canTransition('nueva', 'confirmada'), true);
  assert.equal(canTransition('nueva', 'pagada'), false);
  assert.equal(canTransition('nueva', 'entregada'), false);
  assert.equal(canTransition('entregada', 'cancelada'), false);
  assert.deepEqual(TRANSITIONS.cancelada, []);

  // Cambio válido con historial
  {
    const { db, log } = fakeDb({ request: { ...baseRequest } });
    const service = new PurchaseRequestsService(db);
    await service.changeStatus(admin as any, baseRequest.id, { to: 'confirmada' });
    assert.ok(log.some((line) => line.startsWith('INSERT INTO purchase_request_events')), 'registra el historial');
  }

  // Transición no permitida
  {
    const { db } = fakeDb({ request: { ...baseRequest } });
    await assert.rejects(() => new PurchaseRequestsService(db).changeStatus(admin as any, baseRequest.id, { to: 'pagada', paymentMethod: 'yape' }), /No se puede pasar/);
  }

  // Pagada exige método de pago; cancelada exige motivo
  {
    const { db } = fakeDb({ request: { ...baseRequest, status: 'confirmada' } });
    const service = new PurchaseRequestsService(db);
    await assert.rejects(() => service.changeStatus(admin as any, baseRequest.id, { to: 'pagada' }), /método de pago/);
    await assert.rejects(() => service.changeStatus(admin as any, baseRequest.id, { to: 'cancelada' }), /motivo/);
  }

  // Otro usuario cambió el estado mientras tanto
  {
    const { db } = fakeDb({ request: { ...baseRequest } });
    await assert.rejects(() => new PurchaseRequestsService(db).changeStatus(admin as any, baseRequest.id, { to: 'confirmada', expectedStatus: 'pendiente_confirmacion' }), /cambió/);
  }

  // Aislamiento: un vendedor independiente no ve ni cambia solicitudes de Macsomenos ni de otro vendedor
  {
    const { db } = fakeDb({ request: { ...baseRequest, owner_user_id: null } });
    await assert.rejects(() => new PurchaseRequestsService(db).detail(sellerA as any, baseRequest.id));
    const other = fakeDb({ request: { ...baseRequest, owner_user_id: 99 } });
    await assert.rejects(() => new PurchaseRequestsService(other.db).changeStatus(sellerA as any, baseRequest.id, { to: 'confirmada' }));
    const own = fakeDb({ request: { ...baseRequest, owner_user_id: 7 } });
    await new PurchaseRequestsService(own.db).changeStatus(sellerA as any, baseRequest.id, { to: 'confirmada' });
  }

  // Reserva: no permite reservar más unidades de las libres
  {
    const { db } = fakeDb({
      request: { ...baseRequest, status: 'confirmada' },
      items: [{ product_id: 'p1', qty: 2, title: 'iPhone' }],
      products: [{ id: 'p1', title: 'iPhone 15', stock: 3, status: 'listed' }],
      reserved: [{ product_id: 'p1', qty: 2 }],
    });
    await assert.rejects(() => new PurchaseRequestsService(db).changeStatus(admin as any, baseRequest.id, { to: 'reservada' }), /Stock insuficiente/);
  }
  {
    const { db, log } = fakeDb({
      request: { ...baseRequest, status: 'confirmada' },
      items: [{ product_id: 'p1', qty: 1, title: 'iPhone' }],
      products: [{ id: 'p1', title: 'iPhone 15', stock: 3, status: 'listed' }],
      reserved: [{ product_id: 'p1', qty: 2 }],
    });
    await new PurchaseRequestsService(db).changeStatus(admin as any, baseRequest.id, { to: 'reservada' });
    assert.ok(log.some((line) => line.startsWith('INSERT INTO stock_reservations')));
    assert.ok(log.some((line) => /FOR UPDATE/.test(line) || line.startsWith('SELECT id, title, stock')), 'bloquea las filas de producto');
  }

  // Carrito: un segundo envío con la misma clave devuelve los números ya creados (sin duplicar)
  {
    let created = 0;
    const cart = new CartController(
      { find: async () => [], manager: { transaction: async () => { created += 1; } } } as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      {
        isReady: async () => true,
        findBySubmission: async () => [{ id: 'r1', number: 'SOL-000010', contact_request_id: 'c1' }],
      } as any,
    );
    const result: any = await cart.contactRequest({ session: {} }, { cartId: 'cart-1', name: 'Ana', phone: '987654321', submissionKey: 'abc-12345-xyz', locationScope: 'almacen' }, '');
    assert.equal(result.idempotent, true);
    assert.deepEqual(result.numbers, ['SOL-000010']);
    assert.equal(created, 0);
  }

  // Carrito: falta un dato → error claro, sin escribir nada
  {
    const cart = new CartController({ find: async () => [] } as any, {} as any, {} as any, {} as any);
    await assert.rejects(() => cart.contactRequest({ session: {} }, { cartId: 'c', name: '', phone: '987654321', locationScope: 'almacen' }, ''), /nombre/);
    await assert.rejects(() => cart.contactRequest({ session: {} }, { cartId: 'c', name: 'Ana', phone: '12', locationScope: 'almacen' }, ''), /WhatsApp/);
    await assert.rejects(() => cart.contactRequest({ session: {} }, { cartId: 'c', name: 'Ana', phone: '987654321', locationScope: 'otro' }, ''), /entrega/);
    await assert.rejects(() => cart.contactRequest({ session: {} }, { cartId: 'c', name: 'Ana', phone: '987654321', locationScope: 'shalom' }, ''), /lugar de entrega/);
    // El modo de respaldo admite Shalom con destino; llega a validar el carrito.
    await assert.rejects(() => cart.contactRequest({ session: {} }, { cartId: 'c', name: 'Ana', phone: '987654321', locationScope: 'shalom', locationValue: 'Arequipa, Cerro Colorado' }, ''), /carrito está vacío/);
  }

  console.log('purchase-requests.test.ts ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
