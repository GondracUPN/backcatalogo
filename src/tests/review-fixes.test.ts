import { strict as assert } from 'assert';
import { ConflictException } from '@nestjs/common';
import { PurchaseRequestsService } from '../modules/purchase-requests/purchase-requests.service';
import { CartController } from '../modules/cart/cart.controller';
import { normalizeAppleTitle, normalizeColorName } from '../utils/display-names';
import { reservedQtyByProduct } from '../utils/stock-reservations';

// Correcciones de la revisión: carrito público sin datos internos, reservas en
// todos los estados que retienen stock, revalidación al enviar y nombres.

const PID = '11111111-1111-1111-1111-111111111111';

function fakeDb(state: { request: any; items?: any[]; products?: any[]; reserved?: any[]; active?: boolean }) {
  const log: string[] = [];
  const query = async (sql: string, params: any[] = []) => {
    log.push(sql.replace(/\s+/g, ' ').trim().slice(0, 80));
    if (/to_regclass/.test(sql)) return [{ name: 'purchase_requests' }];
    if (/FROM purchase_requests pr LEFT JOIN delivery_points/.test(sql)) return [{ ...state.request }];
    if (/FROM purchase_request_items/.test(sql)) return state.items || [];
    if (/FROM purchase_request_events/.test(sql)) return [];
    if (/SELECT 1 FROM stock_reservations WHERE request_id/.test(sql)) return state.active ? [{ '?column?': 1 }] : [];
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
  return { db: { query, transaction: async (fn: any) => fn({ query }) } as any, log };
}

const admin = { sub: 1, username: 'admin', role: 'ADMIN', canViewServiceInventory: false };
const baseRequest = { id: '22222222-2222-2222-2222-222222222222', owner_user_id: null };

function reservationsManager(reserved: Array<{ product_id: string; qty: number }>) {
  return { query: async (sql: string) => (/stock_reservations/.test(sql) ? reserved : []) };
}

(async () => {
  // 1) GET /cart: solo campos públicos (sin precio mínimo ni costo en notas).
  {
    const product = { id: PID, sku: 'MS-1', title: 'IPhone 17 Pro Max', price: '5000', min_offer_price: '4200', stock: 1, status: 'listed', color: 'Space blacke' };
    const staged = { sku: 'MS-1', title: 'IPhone 17 Pro Max', price: '5000', notes: JSON.stringify({ color: 'Space blacke', valor: { costoTotal: 3900 }, proveedor: 'X', discount: 5 }) };
    const cart = new CartController(
      { find: async () => [{ id: 'c1', cart_id: 'cart-1', product_id: PID, qty: 1, offer_price: null, created_at: new Date() }] } as any,
      { findBy: async () => [product], manager: reservationsManager([]) } as any,
      { findBy: async () => [{ product_id: PID, slug: 'iphone-17' }] } as any,
      { findBy: async () => [staged] } as any,
    );
    const result: any = await cart.list({ session: {} }, { cartId: 'cart-1' }, '');
    const json = JSON.stringify(result);
    assert.ok(!json.includes('min_offer_price'), 'no expone el precio mínimo de oferta');
    assert.ok(!json.includes('costoTotal') && !json.includes('3900'), 'no expone el costo');
    assert.ok(!json.includes('proveedor'), 'no expone datos internos de las notas');
    assert.equal(result.items[0].product.title, 'iPhone 17 Pro Max');
    assert.equal(result.items[0].product.color, 'Space Black');
    assert.equal(result.items[0].staged.notes.discount, 5, 'mantiene lo que el carrito necesita para el precio');
    assert.equal(result.items[0].slug, 'iphone-17');
  }

  // 2a) Pasar a «pagada» sin reserva previa reserva ahora (con control de stock).
  {
    const { db, log } = fakeDb({
      request: { ...baseRequest, status: 'confirmada' },
      items: [{ product_id: PID, qty: 1 }],
      products: [{ id: PID, title: 'iPhone 15', stock: 1, status: 'listed' }],
    });
    await new PurchaseRequestsService(db).changeStatus(admin as any, baseRequest.id, { to: 'pagada', paymentMethod: 'yape' });
    assert.ok(log.some((line) => line.startsWith('INSERT INTO stock_reservations')), 'reserva al pagar');
    assert.ok(log.some((line) => line.includes('SET expires_at = NULL')), 'la reserva pagada no vence');
  }
  // 2b) Sin stock libre no deja marcarla como en preparación.
  {
    const { db } = fakeDb({
      request: { ...baseRequest, status: 'confirmada' },
      items: [{ product_id: PID, qty: 1 }],
      products: [{ id: PID, title: 'iPhone 15', stock: 1, status: 'listed' }],
      reserved: [{ product_id: PID, qty: 1 }],
    });
    await assert.rejects(
      () => new PurchaseRequestsService(db).changeStatus(admin as any, baseRequest.id, { to: 'en_preparacion' }),
      /Stock insuficiente/,
    );
  }
  // 2c) Si ya tiene reserva vigente, no reserva dos veces.
  {
    const { db, log } = fakeDb({
      request: { ...baseRequest, status: 'reservada' },
      items: [{ product_id: PID, qty: 1 }],
      products: [{ id: PID, title: 'iPhone 15', stock: 1, status: 'listed' }],
      active: true,
    });
    await new PurchaseRequestsService(db).changeStatus(admin as any, baseRequest.id, { to: 'pagada', paymentMethod: 'efectivo' });
    assert.ok(!log.some((line) => line.startsWith('INSERT INTO stock_reservations')), 'no duplica la reserva');
  }

  // 2d) Catálogo y carrito descuentan reservas vigentes.
  {
    const reserved = await reservedQtyByProduct(reservationsManager([{ product_id: PID, qty: 1 }]) as any, [PID]);
    assert.equal(reserved.get(PID), 1);
    const missing = await reservedQtyByProduct({ query: async () => { throw Object.assign(new Error('no table'), { code: '42P01' }); } } as any, [PID]);
    assert.equal(missing.size, 0, 'sin la tabla de reservas no falla');

    const product = { id: PID, stock: 1, status: 'listed', product_condition: 'Seminuevo', sale_type: 'VENTA_SIMPLE' };
    const cart = new CartController(
      { findOne: async () => null } as any,
      { findOne: async () => ({ ...product }), manager: reservationsManager([{ product_id: PID, qty: 1 }]) } as any,
      {} as any,
      {} as any,
    );
    await assert.rejects(() => cart.add({ session: {} }, { productId: PID, qty: 1 } as any, 'cart-1'), /agotado o reservado/);
  }

  // 3) Enviar un carrito antiguo con un equipo ya vendido devuelve un error claro.
  {
    let transactions = 0;
    const cart = new CartController(
      { find: async () => [{ id: 'c1', cart_id: 'cart-1', product_id: PID, qty: 1 }], manager: { transaction: async () => { transactions += 1; } } } as any,
      { findBy: async () => [{ id: PID, sku: 'MS-1', title: 'iPhone 15', stock: 1, status: 'sold' }], manager: reservationsManager([]) } as any,
      { findBy: async () => [{ product_id: PID }] } as any,
      { findBy: async () => [] } as any,
    );
    try {
      await cart.contactRequest({ session: {} }, { name: 'Ana', phone: '999888777', locationScope: 'almacen' }, 'cart-1');
      assert.fail('debió rechazar el envío');
    } catch (error: any) {
      assert.ok(error instanceof ConflictException);
      const body: any = error.getResponse();
      assert.equal(body.code, 'CART_ITEMS_UNAVAILABLE');
      assert.match(body.message, /iPhone 15.*ya se vendió/);
      assert.equal(body.unavailable[0].productId, PID);
    }
    assert.equal(transactions, 0, 'no crea solicitudes');
  }

  // 6) Nombres visibles.
  assert.equal(normalizeAppleTitle('IPhone 15 Plus 128GB'), 'iPhone 15 Plus 128GB');
  assert.equal(normalizeAppleTitle('IPad Pro M5 13 WiFi'), 'iPad Pro M5 13 pulgadas WiFi');
  assert.equal(normalizeAppleTitle('Macbook Air M2'), 'MacBook Air M2');
  assert.equal(normalizeAppleTitle('MacBook Air M4 15'), 'MacBook Air M4 15 pulgadas');
  assert.equal(normalizeAppleTitle('MacBook Pro M4 Pro 14'), 'MacBook Pro M4 Pro 14 pulgadas');
  assert.equal(normalizeAppleTitle('MacBook Air M2 13.6'), 'MacBook Air M2 13.6 pulgadas');
  assert.equal(normalizeAppleTitle('MacBook Pro 16 pulgadas'), 'MacBook Pro 16 pulgadas');
  assert.equal(normalizeAppleTitle('MacBook Pro 16"'), 'MacBook Pro 16 pulgadas');
  assert.equal(normalizeAppleTitle('iMac M4 24'), 'iMac M4 24 pulgadas');
  assert.equal(normalizeAppleTitle('iPad Air 11 WiFi'), 'iPad Air 11 pulgadas WiFi');
  assert.equal(normalizeAppleTitle('iPad mini 8.3'), 'iPad mini 8.3 pulgadas');
  assert.equal(normalizeAppleTitle('iPad 10 64GB'), 'iPad 10 64GB');
  assert.equal(normalizeAppleTitle('Apple Watch Series 11 46 mm'), 'Apple Watch Series 11 46 mm');
  assert.equal(normalizeAppleTitle('MacBook Air M4 16 GB RAM'), 'MacBook Air M4 16 GB RAM');
  assert.equal(normalizeColorName('Space blacke'), 'Space Black');
  assert.equal(normalizeColorName('Black Space'), 'Space Black');
  assert.equal(normalizeColorName('Skyblue'), 'Sky Blue');
  assert.equal(normalizeColorName(' Silver'), 'Silver');
  assert.equal(normalizeColorName('Blanco '), 'Blanco');
  assert.equal(normalizeColorName('Jet black'), 'Jet Black');
  assert.equal(normalizeColorName('Índigo'), 'Indigo');

  console.log('review-fixes: OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
