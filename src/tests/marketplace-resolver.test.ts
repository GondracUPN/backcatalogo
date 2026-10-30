import 'reflect-metadata';
import assert from 'node:assert/strict';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PGlite } from '@electric-sql/pglite';
import { performance } from 'node:perf_hooks';
import { CatalogProduct } from '../entities/catalog-product.entity';
import { AuthService } from '../modules/auth/auth.service';
import { MarketplaceResolverController, skuCandidates } from '../modules/marketplace-bridge/marketplace-resolver.controller';

async function main() {
  // Base PostgreSQL embebida y JWT de prueba: no carga .env ni conecta a Neon.
  const pg = new PGlite();
  const query = async (sql: string, params: unknown[] = []) => (await pg.query(sql, params)).rows as any[];
  await pg.exec(`
    CREATE TABLE products(id uuid PRIMARY KEY, sku text UNIQUE, title text, price numeric, final_price numeric, status text, stock int, sale_type text, storage_gb int, color text, iphone_model text, iphone_number int);
    CREATE TABLE catalog_public(product_id uuid UNIQUE, slug text UNIQUE, is_published boolean);
    CREATE TABLE staged_products(id uuid PRIMARY KEY, source_id uuid, sku text, status text, sale_type text, final_price numeric, notes text, owner_user_id int);
    CREATE INDEX staged_products_sku_idx ON staged_products(sku);
    CREATE TABLE stock_reservations(product_id uuid, qty int, released_at timestamptz, expires_at timestamptz);
    INSERT INTO products VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 'MS-476', 'iPhone 15 Normal 128GB Black', 1800, NULL, 'listed', 1, 'VENTA_SIMPLE',128,'Black','Normal',15);
    INSERT INTO catalog_public VALUES ('aaaaaaaa-1111-4111-8111-111111111111', 'iphone-15-normal-128gb-black-2', true);
    INSERT INTO staged_products VALUES ('bbbbbbbb-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-111111111111', 'MS-476', 'published', 'VENTA_SIMPLE', NULL, '{"cost":999,"supplier":"private"}', NULL);
  `);
  process.env.JWT_SECRET = 'marketplace-resolver-isolated-test-secret';
  const auth = new AuthService({} as any);
  const token = auth.signToken({ sub: 1, username: 'admin_test', role: 'ADMIN' });
  const seller = auth.signToken({ sub: 2, username: 'seller_test', role: 'VENDEDOR', canViewServiceInventory: true });
  @Module({ controllers: [MarketplaceResolverController], providers: [
    { provide: AuthService, useValue: auth },
    { provide: getRepositoryToken(CatalogProduct), useValue: { manager: { query } } },
  ] })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const base = `http://127.0.0.1:${address.port}/admin/marketplace/resolve`;
  const get = (params: Record<string, string>, jwt = token) => fetch(`${base}?${new URLSearchParams(params)}`, {
    headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
  });
  const failure = async (params: Record<string, string>, status: number, jwt = token) => assert.equal((await get(params, jwt)).status, status);
  try {
    await failure({ sku: '476' }, 401, '');
    await failure({ sku: '476' }, 401, 'invalid');
    await failure({ sku: '476' }, 403, seller);
    const start = performance.now();
    const first = await get({ sku: '476' });
    const cold = performance.now() - start;
    assert.equal(first.status, 200);
    assert.match(first.headers.get('cache-control') || '', /no-store/);
    const expected = await first.json();
    assert.deepEqual(expected, { found: true, product: {
      sku: '476', title: 'iPhone 15 Normal 128GB Black',
      url: 'https://www.macsomenos.com/product/iphone-15-normal-128gb-black-2', available: true, availability: 'available',
    } });
    for (const sku of ['MS-476', 'ms-476', 'SKU 476', ' 476 ']) assert.deepEqual(await (await get({ sku })).json(), expected);
    await query(`UPDATE staged_products SET status = 'listed'`);
    assert.deepEqual(await (await get({ sku: '476' })).json(), expected, 'also accepts legacy listed inventory');
    await query(`UPDATE staged_products SET status = 'hidden'`);
    await failure({ sku: '476' }, 404);
    await query(`UPDATE staged_products SET status = 'draft'`);
    await failure({ sku: '476' }, 404);
    await query(`UPDATE staged_products SET status = 'published'`);
    assert.deepEqual(skuCandidates('MS-00476'), ['00476', 'MS-00476', 'ms-00476']);
    assert.deepEqual(skuCandidates('OTHER-476'), ['OTHER-476']);
    assert.deepEqual(skuCandidates('SKU OTHER-476'), ['SKU OTHER-476']);
    await failure({ sku: '999999' }, 404);
    await failure({ sku: "' OR 1=1 --" }, 404);
    await failure({}, 400);
    await failure({ title: 'iPhone', price: 'NaN' }, 400);
    await failure({ title: 'iPhone', price: '-1' }, 400);
    await failure({ sku: '476', secret: '1' }, 400);
    const byTitle = { title: 'Remato IPHONE 15 Normal 128 GB Black', price: '1800' };
    assert.deepEqual(await (await get(byTitle)).json(), expected);
    await pg.exec(`UPDATE products SET price = 2100; UPDATE staged_products SET notes = '{"finalPrice":1800.99,"cost":999}';`);
    assert.equal((await get(byTitle)).status, 200, 'uses truncated Marketplace notes.finalPrice');
    await pg.exec(`UPDATE products SET final_price = 1700;`);
    await failure(byTitle, 404);
    assert.equal((await get({ ...byTitle, price: '1700' })).status, 200, 'final price takes precedence over notes');
    await pg.exec(`UPDATE products SET price = 1800, final_price = NULL; UPDATE staged_products SET notes = '{"cost":999,"supplier":"private"}';`);
    await failure({ title: 'iPhone 15 Pro 128GB Black', price: '1800' }, 404);
    await failure({ title: 'iPhone 15 Normal 256GB Black', price: '1800' }, 404);
    await failure({ title: 'iPhone 15 Normal 128GB White', price: '1800' }, 404);
    await failure({ title: 'iPhone 15', price: '1800' }, 404);
    await pg.exec(`UPDATE products SET title = 'iPhone 15';`);
    await failure({ title: 'iPhone 15', price: '1800' }, 404, token);
    await pg.exec(`UPDATE products SET title = 'iPhone 15 Normal 128GB Black';`);
    await failure({ ...byTitle, price: '1799' }, 404);
    await query(`INSERT INTO products SELECT 'cccccccc-1111-4111-8111-111111111111', '476', title, price, final_price, status, stock, sale_type, storage_gb, color, iphone_model, iphone_number FROM products LIMIT 1`);
    await query(`INSERT INTO catalog_public VALUES ('cccccccc-1111-4111-8111-111111111111','second-unit', true)`);
    await failure({ sku: '476' }, 409);
    await failure(byTitle, 409);
    assert.equal((await get({ productId: 'aaaaaaaa-1111-4111-8111-111111111111' })).status, 200);
    await pg.exec(`DELETE FROM catalog_public WHERE slug = 'second-unit'; DELETE FROM products WHERE sku = '476';`);
    await query(`UPDATE catalog_public SET slug = 'new-current-slug'`);
    assert.equal(((await (await get({ sku: '476' })).json()) as any).product.url, 'https://www.macsomenos.com/product/new-current-slug');
    await query(`UPDATE products SET status = 'sold'`);
    assert.equal(((await (await get({ sku: '476' })).json()) as any).product.availability, 'sold');
    assert.equal(((await (await get({ sku: '476' })).json()) as any).product.available, false);
    await failure(byTitle, 404);
    await pg.exec(`UPDATE products SET status = 'listed'; INSERT INTO stock_reservations VALUES ('aaaaaaaa-1111-4111-8111-111111111111',1,NULL,now() + interval '1 hour');`);
    assert.equal(((await (await get({ sku: '476' })).json()) as any).product.availability, 'reserved');
    await query(`UPDATE stock_reservations SET expires_at = now() - interval '1 second'`);
    assert.equal(((await (await get({ sku: '476' })).json()) as any).product.available, true);
    await pg.exec(`UPDATE products SET sale_type = 'PREVENTA', stock = 0;`);
    assert.equal(((await (await get({ sku: '476' })).json()) as any).product.availability, 'preorder');
    await pg.exec(`UPDATE products SET sale_type = 'VENTA_SIMPLE', stock = 1; UPDATE staged_products SET owner_user_id = 9;`);
    await failure({ sku: '476' }, 404);
    await pg.exec(`UPDATE staged_products SET owner_user_id = NULL; UPDATE products SET status = 'hidden';`);
    await failure({ sku: '476' }, 404);
    await pg.exec(`UPDATE products SET status = 'draft';`);
    await failure({ sku: '476' }, 404);
    await pg.exec(`UPDATE products SET status = 'listed'; UPDATE catalog_public SET is_published = false;`);
    await failure({ sku: '476' }, 404);
    await query(`UPDATE catalog_public SET is_published = true`);
    const linkToken = auth.signToken({ sub: 5, username: 'link_admin', role: 'ADMIN' });
    const linksBase = base.replace('/resolve', '/listings');
    const postLink = (body: any, jwt = linkToken) => fetch(linksBase, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    }, body: JSON.stringify(body) });
    const linkBody = { listingId: '1111100001', sku: '476', url: 'https://www.macsomenos.com/product/new-current-slug', title: 'iPhone 15 Normal 128GB Black', price: '1800' };
    const getLink = (id: string, params: Record<string,string> = { title: linkBody.title, price: linkBody.price }, jwt = linkToken) => fetch(`${linksBase}/${id}?${new URLSearchParams(params)}`, { headers: jwt ? { Authorization: `Bearer ${jwt}` } : {} });
    assert.equal((await getLink(linkBody.listingId)).status, 404, 'unlinked read does not create the table');
    assert.equal((await query(`SELECT to_regclass('marketplace_listing_links') AS name`))[0].name, null);
    assert.equal((await postLink(linkBody, '')).status, 401);
    assert.equal((await postLink(linkBody, seller)).status, 403);
    assert.equal((await postLink({ ...linkBody, listingId: "' OR 1=1" })).status, 400);
    assert.equal((await postLink({ ...linkBody, url: 'https://evil.invalid/product/x' })).status, 400);
    assert.equal((await postLink({ ...linkBody, sku: '477' })).status, 409);
    for (const listingId of ['1111100001', '2222200002', '3333300003']) {
      assert.equal((await postLink({ ...linkBody, listingId })).status, 201, 'three Facebook accounts can link distinct ads to one SKU');
      const response = await getLink(listingId);
      assert.equal(response.status, 200);
      const body = await response.json() as any;
      assert.equal(body.linked, true); assert.equal(body.product.sku, '476');
      assert.equal(body.product.url, linkBody.url);
    }
    assert.equal((await postLink(linkBody)).status, 201, 'link creation is idempotent');
    assert.equal((await query(`SELECT count(*)::int AS n FROM marketplace_listing_links`))[0].n, 3);
    assert.equal((await getLink(linkBody.listingId, { sku: 'MS-476' })).status, 200);
    assert.equal((await getLink(linkBody.listingId, undefined, seller)).status, 403);
    const changed = await getLink(linkBody.listingId, { title: 'Another product', price: '1800' });
    assert.equal(changed.status, 409);
    assert.equal(((await changed.json()) as any).code, 'LISTING_EVIDENCE_CHANGED');
    await query(`UPDATE products SET status = 'sold'`);
    assert.equal(((await (await getLink(linkBody.listingId)).json()) as any).product.available, false, 'linked ads never bypass real availability');
    assert.equal((await postLink(linkBody)).status, 409);
    await query(`UPDATE products SET status = 'listed'`);
    await query(`UPDATE catalog_public SET slug = 'changed-after-link'`);
    assert.equal(((await (await getLink(linkBody.listingId)).json()) as any).product.url, 'https://www.macsomenos.com/product/changed-after-link');
    await query(`INSERT INTO products SELECT 'dddddddd-1111-4111-8111-111111111111', 'MS-477', title, price, final_price, status, stock, sale_type, storage_gb, color, iphone_model, iphone_number FROM products LIMIT 1`);
    await query(`INSERT INTO catalog_public VALUES ('dddddddd-1111-4111-8111-111111111111','other-product', true)`);
    assert.equal((await postLink({ ...linkBody, sku: '477', url: 'https://www.macsomenos.com/product/other-product' })).status, 409, 'cannot repoint an existing ad to another physical unit');
    assert.equal(((await (await getLink(linkBody.listingId)).json()) as any).product.sku, '476');
    assert.equal((await postLink({ ...linkBody, listingId: '4444400004', sku: '477', url: 'https://www.macsomenos.com/product/other-product' })).status, 201);
    await query(`DELETE FROM catalog_public WHERE slug = 'other-product'`);
    await query(`DELETE FROM products WHERE sku = 'MS-477'`);
    const removedLink = await getLink('4444400004');
    assert.equal(removedLink.status, 409, 'deleting a product preserves an association tombstone');
    assert.equal(((await removedLink.json()) as any).code, 'LISTING_PRODUCT_REMOVED');
    const benchmarkToken = auth.signToken({ sub: 3, username: 'benchmark_admin', role: 'ADMIN' });
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      const response = await get({ sku: '476' }, benchmarkToken);
      assert.equal(response.status, 200);
      await response.json();
      samples.push(performance.now() - t);
    }
    for (let i = 20; i < 60; i++) assert.equal((await get({ sku: '476' }, benchmarkToken)).status, 200);
    await failure({ sku: '476' }, 429, benchmarkToken);
    console.log(`marketplace-resolver: HTTP + PostgreSQL checks passed. Local embedded DB: first=${cold.toFixed(2)}ms; repeated mean=${(samples.reduce((a,b) => a+b,0)/samples.length).toFixed(2)}ms (n=20). Not production latency.`);
  } finally { await app.close(); await pg.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
