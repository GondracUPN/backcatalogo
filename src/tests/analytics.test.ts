import { strict as assert } from 'assert';
import { classifySource, cleanEvent } from '../modules/analytics/event-ingest';
import { extractModels, extractStorage, parseRange } from '../modules/analytics/analytics.service';

const now = new Date('2026-10-14T20:00:00Z');

// Sin consentimiento: se descartan identificadores (solo cuenta en totales)
const anon = cleanEvent({ type: 'page_view', landing: true, path: '/c/iphone', referrerHost: 'www.google.com' }, { consent: false, sessionId: 'abcdef12-3456', visitorId: 'zzzzzzzz-1111', now, ownHost: 'macsomenos.com' })!;
assert.equal(anon.session_id, null);
assert.equal(anon.visitor_id, null);
assert.equal(anon.source, 'search');

// Con consentimiento se guardan los identificadores aleatorios
const withConsent = cleanEvent({ type: 'view_product', productId: '11111111-1111-1111-1111-111111111111', category: 'IPHONE' }, { consent: true, sessionId: 'abcdef12-3456', visitorId: 'visitor-0001', now })!;
assert.equal(withConsent.session_id, 'abcdef12-3456');
assert.equal(withConsent.category, 'iphone');
assert.equal(withConsent.source, null, 'la procedencia solo se calcula en la página de entrada');

// Tipos desconocidos, ids mal formados y horas futuras
assert.equal(cleanEvent({ type: 'hack' }, { consent: true, now }), null);
assert.equal(cleanEvent({ type: 'view_product', productId: 'x; drop table' }, { consent: true, now })!.product_id, null);
assert.equal(cleanEvent({ type: 'page_view', at: '2030-01-01' }, { consent: false, now })!.occurred_at, now);
assert.equal(cleanEvent({ type: 'page_view' }, { consent: true, sessionId: '<script>', now })!.session_id, null);

// Búsquedas: texto normalizado y resultados; duración limitada
const search = cleanEvent({ type: 'search_product', query: '  iPhone   15 PRO  ', results: 0 }, { consent: false, now })!;
assert.equal(search.query, 'iphone 15 pro');
assert.equal(search.results, 0);
assert.equal(cleanEvent({ type: 'product_leave', durationMs: 99999999 }, { consent: false, now })!.duration_ms, 30 * 60_000);

// Procedencia
assert.equal(classifySource({ utmSource: 'facebook', utmMedium: 'cpc' }), 'campaign');
assert.equal(classifySource({ gclid: true }), 'campaign');
assert.equal(classifySource({ referrerHost: 'l.instagram.com' }), 'social');
assert.equal(classifySource({ referrerHost: 'www.macsomenos.com', ownHost: 'macsomenos.com' }), 'direct');
assert.equal(classifySource({ referrerHost: 'blog.ejemplo.pe' }), 'referral');
assert.equal(classifySource({}), 'direct');

// Periodos: anterior de la misma duración; límites de agrupación
const r = parseRange('2026-10-01T05:00:00Z', '2026-10-08T05:00:00Z', 'day');
assert.equal(r.prevFrom.toISOString(), '2026-09-24T05:00:00.000Z');
assert.equal(r.prevTo.toISOString(), '2026-10-01T05:00:00.000Z');
assert.throws(() => parseRange('2026-01-01T00:00:00Z', '2026-10-01T00:00:00Z', 'hour'), /Demasiados puntos/);
assert.throws(() => parseRange('2026-10-08T00:00:00Z', '2026-10-01T00:00:00Z', 'day'), /anterior/);

// Modelos y capacidades buscados
assert.deepEqual(extractModels('iphone 15 pro max 256gb'), ['iPhone 15 Pro Max']);
assert.deepEqual(extractModels('macbook air m2'), ['MacBook Air M2']);
assert.deepEqual(extractModels('ipad mini'), ['iPad Mini']);
assert.deepEqual(extractModels('watch ultra 2'), ['Apple Watch Ultra 2']);
assert.deepEqual(extractStorage('iphone 15 256gb y 1 tb'), ['256 GB', '1 TB']);

console.log('analytics.test.ts ok');
