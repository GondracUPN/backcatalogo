import { EntityManager } from 'typeorm';

/** Condición SQL de una reserva vigente (sin liberar y sin vencer). */
export const ACTIVE_RESERVATION_SQL = `released_at IS NULL AND (expires_at IS NULL OR expires_at > now())`;

/**
 * Unidades reservadas por producto (reservas vigentes). Si la tabla aún no
 * existe (migración pendiente) devuelve un mapa vacío en lugar de fallar.
 */
export async function reservedQtyByProduct(
  mgr: EntityManager,
  productIds: string[],
  opts: { excludeRequestId?: string } = {},
): Promise<Map<string, number>> {
  const ids = Array.from(new Set(productIds.filter(Boolean)));
  if (!ids.length) return new Map();
  try {
    const params: any[] = [ids];
    let extra = '';
    if (opts.excludeRequestId) {
      params.push(opts.excludeRequestId);
      extra = ' AND request_id <> $2';
    }
    const rows = await mgr.query(
      `SELECT product_id, COALESCE(sum(qty),0)::int AS qty FROM stock_reservations
        WHERE product_id = ANY($1::uuid[]) AND ${ACTIVE_RESERVATION_SQL}${extra}
        GROUP BY product_id`,
      params,
    );
    return new Map(rows.map((row: any) => [String(row.product_id), Number(row.qty) || 0]));
  } catch (error: any) {
    if (error?.code === '42P01') return new Map();
    throw error;
  }
}

/**
 * Descuenta en memoria las unidades reservadas del stock de cada producto, para
 * que el catálogo y el carrito muestren lo realmente disponible. No guarda nada.
 */
export async function applyReservedStock<T extends { id: string; stock?: any }>(mgr: EntityManager, products: T[]) {
  const reserved = await reservedQtyByProduct(mgr, products.map((product) => product.id));
  return applyReservedQty(products, reserved);
}

/**
 * Igual que applyReservedStock, pero con las reservas ya leídas. Permite pedir
 * las reservas en paralelo con los productos (solo dependen de los ids).
 */
export function applyReservedQty<T extends { id: string; stock?: any }>(products: T[], reserved: Map<string, number>) {
  if (!reserved.size) return products;
  for (const product of products) {
    const held = reserved.get(product.id) || 0;
    if (held > 0) product.stock = Math.max(0, Number(product.stock ?? 0) - held) as any;
  }
  return products;
}
