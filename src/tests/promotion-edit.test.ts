import { strict as assert } from 'assert';
import { AdminController } from '../modules/catalog-admin/admin.controller';

// Edición rápida de promociones: cálculo en el servidor, permisos y quitar promoción.
const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';

function build(role: string, ownerOfStaged: number | null, sub = 7) {
  const updates: Array<{ entity: string; where: any; patch: any }> = [];
  const product = { id: PRODUCT_ID, sku: 'MS-314', price: '2899.99' };
  const staged = { id: 'st-1', sku: 'MS-314', owner_user_id: ownerOfStaged, notes: JSON.stringify({ color: 'Natural' }) };
  const mgr = { update: async (entity: any, where: any, patch: any) => { updates.push({ entity: entity.name, where, patch }); } };
  const controller = new AdminController(
    { verifyToken: () => ({ role, sub, canViewServiceInventory: false }) } as any,
    { find: async ({ where }: any) => (where.sku ? [staged] : []) } as any,
    {} as any,
    { findOne: async () => product, manager: { transaction: async (fn: any) => fn(mgr) } } as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { controller, updates };
}

(async () => {
  // Porcentaje: 10% de 2899.99 → 2609.99
  {
    const { controller, updates } = build('ADMIN', null);
    const result: any = await controller.updatePromotion('Bearer x', PRODUCT_ID, { discount: 10, mode: 'percent' });
    assert.equal(result.finalPrice, 2609.99);
    assert.equal(result.finalPriceWithIgv, 3079.79);
    assert.equal(updates.find((u) => u.entity === 'CatalogProduct')?.patch.final_price, '2609.99');
    assert.ok(String(updates.find((u) => u.entity === 'StagedProduct')?.patch.notes).includes('"discountMode":"percent"'));
  }
  // Monto: S/ 200 → 2699.99
  {
    const { controller } = build('ADMIN', null);
    const result: any = await controller.updatePromotion('Bearer x', PRODUCT_ID, { discount: 200, mode: 'amount' });
    assert.equal(result.finalPrice, 2699.99);
  }
  // Validaciones
  {
    const { controller } = build('ADMIN', null);
    await assert.rejects(() => controller.updatePromotion('Bearer x', PRODUCT_ID, { discount: 100, mode: 'percent' }), /menor que 100/);
    await assert.rejects(() => controller.updatePromotion('Bearer x', PRODUCT_ID, { discount: 5000, mode: 'amount' }), /menor que el precio/);
    await assert.rejects(() => controller.updatePromotion('Bearer x', PRODUCT_ID, { discount: 0 }), /mayor que 0/);
  }
  // Quitar promoción
  {
    const { controller, updates } = build('ADMIN', null);
    const result: any = await controller.updatePromotion('Bearer x', PRODUCT_ID, { remove: true });
    assert.equal(result.saleType, 'VENTA_SIMPLE');
    assert.equal(updates.find((u) => u.entity === 'CatalogProduct')?.patch.final_price, null);
  }
  // Un vendedor independiente no puede tocar productos de Macsomenos ni de otro vendedor
  {
    const { controller } = build('VENDEDOR', null, 7);
    await assert.rejects(() => controller.updatePromotion('Bearer x', PRODUCT_ID, { discount: 5 }));
    const other = build('VENDEDOR', 99, 7);
    await assert.rejects(() => other.controller.updatePromotion('Bearer x', PRODUCT_ID, { discount: 5 }));
    const own = build('VENDEDOR', 7, 7);
    const result: any = await own.controller.updatePromotion('Bearer x', PRODUCT_ID, { discount: 5 });
    assert.equal(result.saleType, 'PROMOCION');
  }
  console.log('promotion-edit.test.ts ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
