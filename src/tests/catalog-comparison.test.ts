import { strict as assert } from 'assert';
import { CatalogController } from '../modules/catalog/catalog.controller';

async function run() {
  const calls: string[] = [];
  const pubs = ['a', 'b', 'c'].map((slug, index) => ({ id: slug, product_id: `p${index}`, slug, is_published: true, category: 'macbook', images: [`/${slug}.jpg`, '/large-gallery.jpg'] }));
  const products = pubs.map((pub, index) => ({ id: pub.product_id, sku: `MS-${index}`, title: pub.slug, price: 1000, stock: 1, status: index === 2 ? 'sold' : 'listed', product_condition: 'Usado', battery_cycles: 0, min_offer_price: 5 }));
  const staged = pubs.map((pub, index) => ({ source_id: pub.product_id, sku: products[index].sku, images: ['/large.jpg'], notes: { costo: 99, proveedor: 'private', warrantyDate: '2100-01-01', specs: { detalle: { procesador: 'M4', detailImages: ['/scratch.jpg'] } } } }));
  const controller = new CatalogController({
    find: async ({ where }: any) => { calls.push('public'); assert.equal(where.is_published, true); return pubs; },
    findOne: async ({ where }: any) => pubs.find(pub => pub.slug === where.slug) || null,
  } as any, {
    findBy: async () => { calls.push('products'); return products.map(product => ({ ...product })); },
    manager: { query: async () => { calls.push('reservations'); return [{ product_id: 'p1', qty: 1 }]; } },
  } as any, {
    createQueryBuilder: () => ({ where() { return this; }, getMany: async () => { calls.push('staged-sku'); return staged; } }),
    findBy: async () => { calls.push('staged-source'); return staged; },
  } as any, {} as any);
  const result = await controller.compare('c,b,a,a,unpublished');
  assert.deepEqual(result.items.map(item => item.slug), ['c', 'b', 'a']);
  assert.deepEqual(result.items.map(item => item.availability), ['sold', 'reserved', 'available']);
  assert.equal(calls.length, 5, 'consultas constantes para tres productos; no se cargan variantes');
  assert.equal(result.items[2].product!.battery_cycles, 0);
  const json = JSON.stringify(result);
  for (const secret of ['min_offer_price', 'costo', 'proveedor', 'large-gallery', 'large.jpg', 'scratch.jpg']) assert.ok(!json.includes(secret), secret);
  calls.length = 0;
  await controller.compare('a');
  assert.equal(calls.length, 5, 'mismo número de consultas con uno o tres productos');
  calls.length = 0;
  const detail = await controller.getOne('a');
  assert.equal(detail.item.slug, 'a');
  assert.equal(calls.length, 5, 'la ficha ya no repite la hidratación para sus variantes');
  assert.equal((await controller.compare('')).items.length, 0);
  console.log('catalog-comparison.test.ts ok');
}
run().catch(error => { console.error(error); process.exit(1); });
