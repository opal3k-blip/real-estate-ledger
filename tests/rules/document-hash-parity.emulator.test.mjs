/* 3A-3 — REAL Client SDK vs REAL Admin SDK against the Firestore emulator.
   The same stored document, read by the browser SDK and by the Admin SDK, must hash identically with the browser
   module (WebCrypto) and the server module (Node crypto). Written once through each SDK, read through both.
   Run (from tests/rules): npm run test:emulator */
import assert from 'assert/strict';
import { createRequire } from 'module';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, Timestamp } from 'firebase/firestore';
import { documentHashHex } from '../../src/domain/validation/document-hash.js';

const require = createRequire(import.meta.url);
const { documentHash } = require('../../functions/trusted-ic.cjs');
const fnRequire = createRequire(new URL('../../functions/package.json', import.meta.url));
const admin = fnRequire('firebase-admin/app');
const adminFs = fnRequire('firebase-admin/firestore');

const PROJECT = 'demo-test';
const [host, port] = String(process.env.FIRESTORE_EMULATOR_HOST || '').split(':');
assert.ok(host && port, 'FIRESTORE_EMULATOR_HOST must be set (run through firebase emulators:exec)');
const testEnv = await initializeTestEnvironment({ projectId: PROJECT, firestore: { host, port: Number(port) } });
const adminDb = adminFs.getFirestore(admin.initializeApp({ projectId: PROJECT }, 'parity'));

const docs = {
  scalars: { a: 1, b: 'x', c: true, d: null, e: 0.1 + 0.2, f: 1.5e300, g: -1.5e-7, i: 9007199254740991 },
  unicode: { 'مفتاح': 'قيمة عربية ✓', 'é': 'é', 'k😀': 1, s: 'line\nbreak\t"quote"' },
  nonFinite: { n: NaN, p: Infinity, m: -Infinity, arr: [NaN, 1] },
  negativeZero: { z: -0 },
  structure: { empty: {}, emptyArr: [], nested: { a: { b: { c: [1, 'two', { d: null }] } } }, keys: { b: 1, a: 2, B: 3, 10: 4, 2: 5 } },
  dollarKeys: { $a: 1, $$b: { $number: 'NaN' }, $number: 'NaN', nested: { $ts: [1, 2], $ref: 'x', $bytes: 'AA==', $date: 'z', $bigint: '1' } },
  shapedLikeSpecial: { ts: { seconds: 1, nanoseconds: 2 }, ref: { path: 'a/b', id: 'b', firestore: true } },
  opportunity: { meta: { name: 'مشروع', city: 'الرياض', tier: 'متوسط', createdAt: '2026-10-07' }, land: { area: 5000, price: 2000 }, ic: { decisions: [{ decision: 'approve', reasons: ['r'], decidedAt: '2026-10-07T00:00:00.000Z' }] } },
};
const clientTs = { t: Timestamp.fromMillis(1790000000123), arr: [Timestamp.fromMillis(1, 0)] };
const adminTs = { t: adminFs.Timestamp.fromMillis(1790000000123), arr: [adminFs.Timestamp.fromMillis(1)] };

let passed = 0;
await testEnv.clearFirestore();
await testEnv.withSecurityRulesDisabled(async (ctx) => {
  const cdb = ctx.firestore();
  async function roundTrip(name, via, data) {
    const id = `${name}-${via}`;
    if (via === 'client') await setDoc(doc(cdb, 'parityDocs', id), data);
    else await adminDb.collection('parityDocs').doc(id).set(data);
    const clientData = (await getDoc(doc(cdb, 'parityDocs', id))).data();
    const adminData = (await adminDb.collection('parityDocs').doc(id).get()).data();
    const hClient = await documentHashHex(clientData);
    const hAdmin = documentHash(adminData);
    assert.equal(hClient, hAdmin, `${name} (written by ${via}): browser-side hash of the Client SDK read != server hash of the Admin SDK read`);
    assert.equal(await documentHashHex(adminData), hAdmin, `${name} (written by ${via}): browser module on Admin data differs`);
    assert.equal(documentHash(clientData), hAdmin, `${name} (written by ${via}): server module on Client data differs`);
    passed++; console.log(`OK ${name} (written by ${via})`);
  }
  for (const [name, d] of Object.entries(docs)) for (const via of ['client', 'admin']) await roundTrip(name, via, d);
  await roundTrip('timestamps', 'client', clientTs);
  await roundTrip('timestamps', 'admin', adminTs);
  // look-alikes stay distinct after a REAL round trip through each SDK (what the browser and the server actually read back)
  const readBoth = async (id, data, via) => {
    if (via === 'client') await setDoc(doc(cdb, 'parityDocs', id), data); else await adminDb.collection('parityDocs').doc(id).set(data);
    const c = (await getDoc(doc(cdb, 'parityDocs', id))).data();
    const a = (await adminDb.collection('parityDocs').doc(id).get()).data();
    const hc = await documentHashHex(c), ha = documentHash(a);
    assert.equal(hc, ha, `${id}: client-read hash != admin-read hash`);
    return hc;
  };
  const PAIRS = [
    ['NaN vs {$number:"NaN"}', { notes: NaN }, { notes: { $number: 'NaN' } }],
    ['Infinity vs {$number:"Infinity"}', { notes: Infinity }, { notes: { $number: 'Infinity' } }],
    ['Timestamp vs {$ts:[s,ns]}', { notes: Timestamp.fromMillis(1000) }, { notes: { $ts: [1, 0] } }],
    ['Timestamp vs plain {seconds,nanoseconds}', { notes: Timestamp.fromMillis(1000) }, { notes: { seconds: 1, nanoseconds: 0 } }],
    ['key $a vs $$a', { $a: 1 }, { $$a: 1 }],
  ];
  for (const via of ['client', 'admin']) {
    for (const [i, [name, a, b]] of PAIRS.entries()) {
      const aa = via === 'admin' && a.notes instanceof Timestamp ? { notes: adminFs.Timestamp.fromMillis(1000) } : a;
      const [ha, hb] = [await readBoth(`pairA${i}-${via}`, aa, via), await readBoth(`pairB${i}-${via}`, b, via)];
      assert.notEqual(ha, hb, `COLLISION after a real round trip (${via}): ${name}`);
      passed++; console.log(`OK distinct after round trip (written by ${via}): ${name}`);
    }
  }
  // a real DocumentReference value: same fingerprint from both SDKs, different from a look-alike plain map
  await setDoc(doc(cdb, 'parityDocs', 'ref-client'), { r: doc(cdb, 'targets', 'T1') });
  await adminDb.collection('parityDocs').doc('ref-admin').set({ r: adminDb.collection('targets').doc('T1') });
  const refHashes = [];
  for (const id of ['ref-client', 'ref-admin']) {
    const c = (await getDoc(doc(cdb, 'parityDocs', id))).data(); const a = (await adminDb.collection('parityDocs').doc(id).get()).data();
    assert.equal(await documentHashHex(c), documentHash(a), `${id}: reference hash differs between SDKs`); refHashes.push(documentHash(a));
  }
  assert.equal(refHashes[0], refHashes[1]);
  assert.notEqual(refHashes[0], documentHash({ r: { path: 'targets/T1', id: 'T1', firestore: true } }));
  passed++; console.log('OK DocumentReference: same fingerprint from both SDKs, distinct from a look-alike map');
  // a change in any field (even a note) changes the hash on both sides
  const base = { a: 1 }; await roundTrip('base', 'client', base);
  const h1 = await documentHashHex((await getDoc(doc(cdb, 'parityDocs', 'base-client'))).data());
  await setDoc(doc(cdb, 'parityDocs', 'base-client'), { a: 1, notes: 'x' });
  const h2 = await documentHashHex((await getDoc(doc(cdb, 'parityDocs', 'base-client'))).data());
  assert.notEqual(h1, h2); passed++; console.log('OK any field change changes the hash');
});
await testEnv.cleanup();
console.log(`\n${passed} passed`);
process.exit(0);
