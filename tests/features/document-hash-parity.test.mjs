/* 3A-3 — document fingerprint: (1) the browser hash (WebCrypto) equals the server hash for every value a stored
   opportunity can hold; (2) the encoding is UNAMBIGUOUS: values that merely look alike (a special value and a plain object
   shaped like its marker) get different fingerprints on both sides; (3) documents without "$"-keys keep exactly the hash
   they had before the fix. The real Client-SDK / Admin-SDK round trip is tests/rules/document-hash-parity.emulator.test.mjs.
   Run: node tests/features/document-hash-parity.test.mjs */
import assert from 'assert/strict';
import vm from 'vm';
import { createRequire } from 'module';
import { documentHashHex, canonicalDocJson } from '../../src/domain/validation/document-hash.js';
const require = createRequire(import.meta.url);
const { documentHash, canonicalDocValue } = require('../../functions/trusted-ic.cjs');
const { legacyDocumentHash } = require('../../functions/test/helpers/legacy-canonical.cjs');

// Class instances, like the Firestore SDK's own Timestamp / DocumentReference (special types are recognised only on these).
class Timestamp { constructor(s, n) { this.seconds = s; this.nanoseconds = n; } toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); } }
class DocumentReference { constructor(path) { this.path = path; this.id = path.split('/').pop(); this.firestore = { app: 'x' }; } }
class Unknown { constructor() { this.a = 1; } }

let passed = 0;
const ok = (name) => { passed++; console.log('PASS  ' + name); };
const both = async (doc) => { const c = await documentHashHex(doc); const s = documentHash(doc); assert.equal(c, s, 'client and server hashes differ for ' + canonicalDocJson(doc).slice(0, 80)); return c; };

/* ---- 1. client == server -------------------------------------------------------------------------------------------- */
const corpus = {
  empty: {},
  scalars: { a: 1, b: 'x', c: true, d: null, e: 0.1 + 0.2, f: 123456789012345680000, g: -1.5e-7 },
  negativeZero: { z: -0, arr: [-0, 0] },
  nonFinite: { n: NaN, p: Infinity, m: -Infinity, nested: { n: [NaN] } },
  undefinedHandling: { u: undefined, arr: [undefined, 1, null], deep: { k: undefined, j: 2 } },
  unicode: { 'مفتاح': 'قيمة عربية ✓', 'é': 'é', '😀': 1, a: 'line\nbreak\t"quote"' },
  keyOrder: { b: 1, a: 2, B: 3, 10: 4, 2: 5, _: 6 },
  deep: { l1: { l2: { l3: { l4: [{ l5: [1, [2, 3]] }] } } } },
  date: { d: new Date('2026-10-07T12:34:56.789Z'), bad: new Date('nope') },
  bytes: { b: new Uint8Array([0, 1, 2, 250, 255]) },
  bigint: { b: 12345678901234567890n },
  timestamp: { t: new Timestamp(1790000000, 123456789), arr: [new Timestamp(1, 2)] },
  reference: { r: new DocumentReference('opportunities/O1') },
  dollarKeys: { $a: 1, $$b: { $number: 'NaN' }, $number: 'NaN', nested: { $ts: [1, 2], $ref: 'x', $bytes: 'AA==', $date: 'z', $bigint: '1' } },
  opportunity: { meta: { name: 'مشروع', city: 'الرياض', tier: 'متوسط' }, land: { area: 5000, price: 2000 }, ic: { decisions: [] }, dd: { items: { a: { status: 'completed' } } } },
};
for (const [name, doc] of Object.entries(corpus)) { await both(doc); assert.equal(canonicalDocJson(doc), JSON.stringify(canonicalDocValue(doc))); ok('client == server: ' + name); }

/* ---- 2. look-alikes must NOT collide (on either side) ---------------------------------------------------------------- */
const marker = (k, v) => ({ notes: { [k]: v } });
const PAIRS = [
  ['NaN vs {$number:"NaN"}', { notes: NaN }, marker('$number', 'NaN')],
  ['Infinity vs {$number:"Infinity"}', { notes: Infinity }, marker('$number', 'Infinity')],
  ['-Infinity vs {$number:"-Infinity"}', { notes: -Infinity }, marker('$number', '-Infinity')],
  ['NaN vs Infinity', { notes: NaN }, { notes: Infinity }],
  ['bigint 1n vs {$bigint:"1"}', { notes: 1n }, marker('$bigint', '1')],
  ['Date vs {$date:iso}', { notes: new Date('2026-01-01T00:00:00.000Z') }, marker('$date', '2026-01-01T00:00:00.000Z')],
  ['bytes vs {$bytes:b64}', { notes: new Uint8Array([1, 2, 3]) }, marker('$bytes', 'AQID')],
  ['Timestamp vs {$ts:[1,2]}', { notes: new Timestamp(1, 2) }, marker('$ts', [1, 2])],
  ['Reference vs {$ref:path}', { notes: new DocumentReference('a/b') }, marker('$ref', 'a/b')],
  ['Timestamp vs plain {seconds,nanoseconds}', { notes: new Timestamp(1, 2) }, { notes: { seconds: 1, nanoseconds: 2 } }],
  ['Reference vs plain {path,id,firestore}', { notes: new DocumentReference('a/b') }, { notes: { path: 'a/b', id: 'b', firestore: true } }],
  ['plain map {path,id,firestore} with different ids', { notes: { path: 'x', id: 'y1', firestore: true } }, { notes: { path: 'x', id: 'y2', firestore: true } }],
  ['plain {seconds,nanoseconds} with different values', { notes: { seconds: 1, nanoseconds: 2, toMillis: undefined } }, { notes: { seconds: 1, nanoseconds: 3 } }],
  ['key $a vs $$a vs $$$a (escape is injective)', { $a: 1 }, { $$a: 1 }],
  ['key $$a vs $$$a', { $$a: 1 }, { $$$a: 1 }],
  ['{$number:"NaN"} vs {$$number:"NaN"}', marker('$number', 'NaN'), marker('$$number', 'NaN')],
  ['array [NaN] vs [{$number:"NaN"}]', { a: [NaN] }, { a: [{ $number: 'NaN' }] }],
  ['string "NaN" vs NaN', { notes: 'NaN' }, { notes: NaN }],
  ['null vs NaN', { notes: null }, { notes: NaN }],
];
for (const [name, a, b] of PAIRS) {
  const [ha, hb] = [await both(a), await both(b)];
  assert.notEqual(ha, hb, 'FINGERPRINT COLLISION: ' + name);
  assert.notEqual(canonicalDocJson(a), canonicalDocJson(b), 'canonical text collision: ' + name);
  ok('distinct fingerprints: ' + name);
}
// the two cases named in review, spelled out
assert.notEqual(await both({ notes: NaN }), await both({ notes: { $number: 'NaN' } })); ok('review case: {notes:NaN} != {notes:{$number:"NaN"}}');

/* ---- 3. unknown / unsafe shapes fail closed on both sides ------------------------------------------------------------- */
const cyc = {}; cyc.self = cyc;
let deep = {}; const root = deep; for (let i = 0; i < 70; i++) { deep.n = {}; deep = deep.n; }
for (const [name, bad] of [['cycle', cyc], ['function', { f() {} }], ['too deep', root], ['unknown class instance', { u: new Unknown() }], ['symbol', { s: Symbol('x') }]]) {
  assert.throws(() => canonicalDocValue(bad), (e) => typeof e.rejectionCode === 'string', name);
  await assert.rejects(documentHashHex(bad), (e) => typeof e.rejectionCode === 'string', name); ok('fails closed: ' + name);
}
// a plain object from another realm (vm context) is still a plain map
const foreign = vm.runInNewContext('({a:1,b:{c:[2,3]},$d:4})');
assert.equal(await both(foreign), await both({ a: 1, b: { c: [2, 3] }, $d: 4 })); ok('cross-realm plain objects are plain maps');

/* ---- 4. compatibility with the previous format -------------------------------------------------------------------------- */
// (a) ordinary documents (and ones carrying NaN / Date / bytes / bigint / Timestamp / reference) keep EXACTLY the old hash.
let seed = 356473699; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const words = ['land', 'price', 'meta', 'notes', 'مفتاح', 'ic', 'dd', 'x', 'seconds', 'path', 'id', 'firestore', 'toMillis'];
function gen(d = 0) {
  const r = rnd();
  if (d > 4 || r < 0.3) return [1, -2.5, 0, 1e21, 'text', 'نص', true, false, null, NaN, Infinity, -0][Math.floor(rnd() * 12)];
  if (r < 0.4) return new Date(1.7e12 + Math.floor(rnd() * 1e9));
  if (r < 0.45) return new Uint8Array([Math.floor(rnd() * 256), 7]);
  if (r < 0.5) return new Timestamp(Math.floor(rnd() * 2e9), Math.floor(rnd() * 1e9));
  if (r < 0.52) return new DocumentReference('opportunities/' + Math.floor(rnd() * 99));
  if (r < 0.54) return BigInt(Math.floor(rnd() * 1e9));
  if (r < 0.7) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(d + 1));
  const o = {}; for (let i = 0, n = Math.floor(rnd() * 5); i < n; i++) o[words[Math.floor(rnd() * words.length)]] = gen(d + 1); return o;
}
let compared = 0;
for (let i = 0; i < 600; i++) {
  const doc = { meta: gen(), land: gen(), x: gen() };
  const s = documentHash(doc);
  assert.equal(s, legacyDocumentHash(doc), 'a document without "$"-keys must keep its previous fingerprint'); compared++;
  assert.equal(await documentHashHex(doc), s);
}
ok(`${compared} random documents (finite/non-finite numbers, Date, bytes, bigint, Timestamp, reference, nested, Arabic) keep their previous hash and still match client == server`);
// (b) the only documents whose fingerprint changes are the ambiguous ones: a plain key starting with "$", or a plain map
//     shaped like a reference ({path:string, id:string, firestore:truthy}), which used to be mistaken for one.
for (const doc of [{ $a: 1 }, { m: { $number: 'NaN' } }, { m: { $ts: [1, 2] } }, { m: { path: 'a', id: 'b', firestore: true } }]) assert.notEqual(documentHash(doc), legacyDocumentHash(doc));
ok('only documents with a plain "$"-prefixed key or a reference-shaped plain map changed fingerprint');

/* ---- 5. sensitivity ------------------------------------------------------------------------------------------------------- */
assert.equal(await documentHashHex({ a: 1, b: 2 }), await documentHashHex({ b: 2, a: 1 })); ok('key order does not matter');
assert.notEqual(await documentHashHex({ a: 1 }), await documentHashHex({ a: 1, notes: 'x' })); ok('any added field changes the hash');
const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
try { await assert.rejects(documentHashHex({ a: 1 }), (e) => e.rejectionCode === 'NO_WEBCRYPTO'); ok('fails closed without WebCrypto'); }
finally { if (saved) Object.defineProperty(globalThis, 'crypto', saved); else delete globalThis.crypto; }
console.log(`\n${passed} passed, 0 failed`);
