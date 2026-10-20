import { strict as assert } from 'assert';
import { exactPointMatch, locationKey, similarity, suggestPoints } from '../modules/delivery/location-matching';

const jockey = { id: 'j', name: 'Jockey Plaza', aliases: ['Jockey'] };
const points = [
  { id: 'j2', name: 'Jockey Plaza', aliases: [] as string[] },
  { id: 'r', name: 'Real Plaza Salaverry', aliases: [] as string[] },
  { id: 'a', name: 'Almacén Surco', aliases: [] as string[] },
];

assert.equal(locationKey('CC Jockey Plaza'), 'jockey plaza');
assert.equal(locationKey('Centro Comercial Jockey Plaza'), 'jockey plaza');
assert.equal(locationKey('  JOCKEY   plaza. '), 'jockey plaza');
assert.equal(locationKey('Almacén Surco'), locationKey('almacen surco'));

// Coincidencias exactas (se enlazan solas)
assert.equal(exactPointMatch('C.C. Jockey Plaza', points)?.id, 'j2');
assert.equal(exactPointMatch('Centro Comercial Jockey Plaza', points)?.id, 'j2');
assert.equal(exactPointMatch('Jockey', [jockey])?.id, 'j', 'alias confirmado');

// "Jockey" sin alias: NO se enlaza solo, pero se sugiere
assert.equal(exactPointMatch('Jockey', points), null);
const suggestions = suggestPoints('Jockey', points);
assert.equal(suggestions[0]?.point.id, 'j2');
assert.ok(suggestions[0].score >= 0.8);
assert.ok(!suggestions.some((entry) => entry.point.id === 'r'), 'Real Plaza no se confunde con Jockey Plaza');
assert.ok(similarity('Real Plaza', 'Jockey Plaza') < 0.5, '"plaza" sola no cuenta');
assert.equal(suggestPoints('Miraflores parque Kennedy', points).length, 0);

console.log('location-matching.test.ts ok');
