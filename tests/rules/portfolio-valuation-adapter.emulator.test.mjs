// R1-C3 — موصّل Firestore لمصدر تقييمات المحفظة على محاكي Firestore حقيقي (SDK الحقيقي، لا مزيَّف).
// يثبت عقد العلامات: fromCache وhasPendingWrites منطقيتان صريحتان في كل لقطة، وتغيّر العلامات وحدها (دون تغيّر الوثائق) يصل ويُبطل النتيجة فورًا.
// التشغيل: firebase emulators:exec --only firestore --project demo-test "node portfolio-valuation-adapter.emulator.test.mjs"   (غير مسجَّل في test:emulator؛ التسجيل قرار منفصل)
import assert from 'node:assert/strict';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import { makePortfolioSubscribe, snapshotForSource } from '../../src/features/portfolio-valuation-firestore.js';
import { createPortfolioValuationSource } from '../../src/features/portfolio-valuation-source.js';
import { installNetXirrLive } from '../../src/features/net-xirr-live-wiring.js';
import { setNetXirrLive } from '../../src/features/net-xirr-live.js';
import { makeLedgerSubscribe } from '../../src/features/portfolio-ledger-source.js';
import { makeTimers } from '../helpers/fake-env.mjs';
import { documentHashHex } from '../../src/domain/validation/document-hash.js';

const [host, port] = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
const app = firebase.initializeApp({ projectId: 'demo-test' }, `adapter-${Date.now()}`);
const db = app.firestore(); db.useEmulator(host, Number(port));
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await tick(40); } return false; };
let passed = 0; let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); } }
const DAY = '2026-03-31'; const NOW = () => new Date('2026-03-31T09:00:00Z');
const RUN = `r${Date.now().toString(36)}`;           // معرّفات فريدة لهذا التشغيل
const fid = (n) => `${n}-${RUN}`;

async function seedFund(fundId, over = {}) {
  const base = fundId.startsWith('f1') ? { components: { assetsValue: 1000000, cashRetained: 50000, otherAssets: 20000, otherAssetsItems: [{ description: 'receivable', amount: 20000 }], liabilities: 70000, distributionsPayable: 0 }, residualValue: 1000000, coverage: { linkedAssets: ['a1', 'a2'], unlinkedHoldings: { declared: 'none' } } }
    : { components: { assetsValue: 500000, cashRetained: 0, otherAssets: 0, otherAssetsItems: [], liabilities: 0, distributionsPayable: 0 }, residualValue: 500000, coverage: { linkedAssets: [], unlinkedHoldings: { declared: 'none' } } };
  const valuationId = `v-${fundId}`; const approvedBy = 'appr@x.sa'; const contentHash = `CH-${fundId}`;
  const doc = { valuationId, fundId, valuationDate: DAY, state: 'approved', status: 'approved', currency: 'SAR', basis: 'RESIDUAL_VALUE_AS_OF_DATE', ...base, method: 'appraisal', source: { ref: 'D', provider: 'V' }, nonOverlap: { cashNotInAssets: true, otherAssetsNotInAssets: true, assetsStatedGrossOfLiabilities: true }, version: 1, supersedes: null, enteredBy: 'prep@x.sa', approvedBy, contentHash };
  const head = { fundId, valuationDate: DAY, headId: valuationId, version: 1, headHash: await documentHashHex({ valuationId, version: 1, contentHash, approvedBy }), eligibility: { state: 'ELIGIBLE', changedBy: approvedBy, changedAt: 't', reasonCode: 'APPROVED', reason: null }, activeDraftId: null, rev: 1, ...over };
  await db.collection('fundValuations').doc(valuationId).set(doc); await db.collection('fundValuationHeads').doc(`${fundId}__${DAY}`).set(head);
}

console.log('— R1-C3 adapter on the Firestore emulator —');
const F1 = fid('f1'); const F2 = fid('f2');
await seedFund(F1); await seedFund(F2);

await t('1. كل لقطة تصل بعلامتين منطقيتين صريحتين ووثائق {id,data}؛ وتصل لقطة مؤكدة (false,false) بالوثائق الصحيحة فقط (فلتر fundId)', async () => {
  const sub = makePortfolioSubscribe({ DB: db }); const snaps = [];
  const un = sub('heads', F1, (s) => snaps.push(s), (e) => { throw e; });
  assert.ok(await until(() => snaps.some((s) => s.fromCache === false && s.hasPendingWrites === false)));
  un(); for (const s of snaps) { assert.equal(typeof s.fromCache, 'boolean'); assert.equal(typeof s.hasPendingWrites, 'boolean'); assert.ok(Array.isArray(s.docs)); }
  const conf = snaps.find((s) => s.fromCache === false && s.hasPendingWrites === false); assert.deepEqual(conf.docs.map((d) => d.id), [`${F1}__${DAY}`]); assert.equal(conf.docs[0].data.fundId, F1);
});
await t('2. snapshotForSource لا يحوّل العلامات: غياب metadata ⇒ undefined (ينتهك العقد فيحجب المصدر)', async () => {
  const s = snapshotForSource({ docs: [] }); assert.equal(s.fromCache, undefined); assert.equal(s.hasPendingWrites, undefined);
  const s2 = snapshotForSource({ docs: [], metadata: { fromCache: 0, hasPendingWrites: 'x' } }); assert.equal(s2.fromCache, 0); assert.equal(s2.hasPendingWrites, 'x');
});
await t('3. تغيّر العلامات دون تغيّر الوثائق يصل: قطع الشبكة ⇒ لقطة fromCache:true بالوثائق نفسها؛ عودتها ⇒ (false,false)', async () => {
  const sub = makePortfolioSubscribe({ DB: db }); const snaps = [];
  const un = sub('heads', F1, (s) => snaps.push(s), () => {});
  assert.ok(await until(() => snaps.some((s) => s.fromCache === false)));
  const n0 = snaps.length; await db.disableNetwork();
  assert.ok(await until(() => snaps.slice(n0).some((s) => s.fromCache === true)), 'offline snapshot must arrive');
  const off = snaps.slice(n0).find((s) => s.fromCache === true); assert.deepEqual(off.docs.map((d) => d.id), [`${F1}__${DAY}`]);
  const n1 = snaps.length; await db.enableNetwork();
  assert.ok(await until(() => snaps.slice(n1).some((s) => s.fromCache === false && s.hasPendingWrites === false)), 'confirmed again');
  un();
});
await t('4. كتابة معلّقة (دون اتصال) ⇒ لقطة hasPendingWrites:true؛ وبعد عودة الاتصال والتأكيد ⇒ false', async () => {
  const sub = makePortfolioSubscribe({ DB: db }); const snaps = [];
  const un = sub('heads', F1, (s) => snaps.push(s), () => {});
  assert.ok(await until(() => snaps.some((s) => s.fromCache === false))); await db.disableNetwork();
  const n0 = snaps.length; const w = db.collection('fundValuationHeads').doc(`${F1}__${DAY}`).update({ rev: 2 });
  assert.ok(await until(() => snaps.slice(n0).some((s) => s.hasPendingWrites === true)), 'pending-write snapshot');
  const n1 = snaps.length; await db.enableNetwork(); await w;
  assert.ok(await until(() => snaps.slice(n1).some((s) => s.fromCache === false && s.hasPendingWrites === false)));
  un();
});
await t('5. المصدر الحقيقي + الموصّل + الجسر: ready ثم قطع الشبكة يُبطل النتيجة فورًا (READ_STALE) وعودتها تعيدها', async () => {
  const src = createPortfolioValuationSource({ subscribe: makePortfolioSubscribe({ DB: db }), now: NOW,
    getSession: () => ({ uid: 'u1', email: 'fm@example.com', role: 'fund_manager', roleResolved: true }),
    getInputs: () => ({ scope: { snapshotDate: DAY, funds: [F1, F2], linksByFund: { [F1]: ['a1', 'a2'], [F2]: [] } }, records: [{ kind: 'capitalCall', id: 'c1', fundId: F1, date: '2025-03-31', amount: 1000000, status: 'paid', reversalOfId: null }] }) });
  src.start();
  assert.ok(await until(() => src.getView().status === 'ready'), JSON.stringify(src.getView().reasons)); assert.ok(Math.abs(src.getView().result.rate - 0.5) < 1e-9);
  await db.disableNetwork();
  assert.ok(await until(() => src.getView().status !== 'ready'), 'must leave ready once offline'); const v = src.getView(); assert.equal(v.status, 'blocked'); assert.ok(v.reasons.some((r) => r.startsWith('READ_STALE')), JSON.stringify(v.reasons)); assert.equal(v.result, null);
  await db.enableNetwork(); assert.ok(await until(() => src.getView().status === 'ready'));
  src.stop(); assert.equal(src.stats().live, 0);
});
await t('6. تغيّر وثيقة الرأس (تعليق الأهلية) على الخادم ⇒ يُبطل النتيجة ويحجب VALUATION_SUSPENDED', async () => {
  const src = createPortfolioValuationSource({ subscribe: makePortfolioSubscribe({ DB: db }), now: NOW,
    getSession: () => ({ uid: 'u1', email: 'fm@example.com', role: 'senior_ic', roleResolved: true }),
    getInputs: () => ({ scope: { snapshotDate: DAY, funds: [F1, F2], linksByFund: { [F1]: ['a1', 'a2'], [F2]: [] } }, records: [{ kind: 'capitalCall', id: 'c1', fundId: F1, date: '2025-03-31', amount: 1000000, status: 'paid', reversalOfId: null }] }) });
  src.start(); assert.ok(await until(() => src.getView().status === 'ready'));
  await db.collection('fundValuationHeads').doc(`${F1}__${DAY}`).update({ 'eligibility.state': 'SUSPENDED' });
  assert.ok(await until(() => src.getView().status === 'blocked' && src.getView().reasons.includes('VALUATION_SUSPENDED')), JSON.stringify(src.getView()));
  assert.equal(src.getView().result && 'rate' in src.getView().result, false); src.stop();
});

// ---- إغلاق فجوة تأكيد الدفتر: المسار الكامل (الموصّل الحقيقي للدفتر + مصدر التقييمات + الجسر) على المحاكي، لا بمحاكاة قيمة علم ----
await seedFund(F1);   // test 6 left F1 suspended
await db.collection('funds').doc(F1).set({ name: 'F1', assetIds: ['a1', 'a2'] }); await db.collection('funds').doc(F2).set({ name: 'F2', assetIds: [] });
await db.collection('capitalCalls').doc(`c1-${RUN}`).set({ fundId: F1, callDate: '2025-03-31', amount: 1000000, status: 'paid' });
function wire() {
  const timers = makeTimers(); const core = { DB: db };      // لا STORE ولا isIfCollectionServerConfirmed: لا شيء من core يُستعمل سوى DB
  const inst = installNetXirrLive(core, { now: NOW, timers, doc: null, win: null, isShown: () => true, observe: () => () => {}, requestRender: () => {},
    getSession: () => ({ uid: 'u1', email: 'fm@example.com', role: 'fund_manager', roleResolved: true }) });
  inst.layer.view(); return { ...inst, timers };
}
const view = (m) => m.source.getView();
await t('7. المسار الكامل على المحاكي: دفتر + تقييمات مؤكدة ⇒ ready (من وثائق الدفتر المقروءة)', async () => {
  const m = wire(); assert.ok(await until(() => view(m).status === 'ready'), JSON.stringify(view(m)));
  assert.ok(Math.abs(view(m).result.rate - 0.5) < 1e-9); assert.equal(m.source.stats().ledger.live, 3); m.layer.release(); setNetXirrLive(null); assert.equal(m.source.stats().ledger.live, 0);
});
await t('8. قطع الشبكة (fromCache:true بوثائق الدفتر نفسها) ⇒ يختفي المعدّل فورًا؛ وعودتها ⇒ لا ready إلا بعد تأكيد جديد', async () => {
  const m = wire(); assert.ok(await until(() => view(m).status === 'ready')); const g0 = view(m).generation;
  await db.disableNetwork(); assert.ok(await until(() => view(m).status !== 'ready'), 'rate must disappear offline'); assert.equal(view(m).result, null);
  assert.ok(view(m).reasons.some((r) => /^(INPUTS_LEDGER_NOT_SERVER_CONFIRMED|READ_STALE)/.test(r)), JSON.stringify(view(m).reasons));
  await db.enableNetwork(); assert.ok(await until(() => view(m).status === 'ready')); assert.ok(view(m).generation > g0); m.layer.release(); setNetXirrLive(null);
});
await t('9. كتابة معلّقة على الدفتر (دون اتصال: cache + معلّقة) ⇒ يختفي المعدّل مع INPUTS_LEDGER_NOT_SERVER_CONFIRMED؛ بعد التأكيد من الخادم يعود بنتيجة تشمل السجل الجديد', async () => {
  const m = wire(); assert.ok(await until(() => view(m).status === 'ready')); const r0 = view(m).result.rate;
  await db.disableNetwork(); const w = db.collection('capitalCalls').doc(`c2-${RUN}`).set({ fundId: F1, callDate: '2025-09-30', amount: 500000, status: 'paid' });
  assert.ok(await until(() => view(m).reasons.some((r) => r.startsWith('INPUTS_LEDGER_NOT_SERVER_CONFIRMED:'))), JSON.stringify(view(m)));
  assert.equal(view(m).result, null);
  await db.enableNetwork(); await w; assert.ok(await until(() => view(m).status === 'ready'), JSON.stringify(view(m))); assert.ok(view(m).result.rate < r0, 'new paid call lowers the rate');
  m.layer.release(); setNetXirrLive(null);
});
await t('10. تغيير وثيقة دفتر على الخادم (تعديل مؤكد) يعيد الحساب بجيل جديد؛ وحذف سجلّ التدفق يغيّر النتيجة', async () => {
  const m = wire(); assert.ok(await until(() => view(m).status === 'ready')); const r1 = view(m).result.rate; const g1 = view(m).generation;
  await db.collection('capitalCalls').doc(`c2-${RUN}`).delete();
  assert.ok(await until(() => view(m).status === 'ready' && view(m).result.rate > r1 && view(m).generation > g1), JSON.stringify(view(m))); m.layer.release(); setNetXirrLive(null);
});
await t('11. بلا قاعدة بيانات: makeLedgerSubscribe بلا DB ⇒ حجب READ_ERROR، لا معدّل', async () => {
  const timers = makeTimers(); const inst = installNetXirrLive({}, { now: NOW, timers, doc: null, win: null, isShown: () => true, observe: () => () => {}, requestRender: () => {},
    getSession: () => ({ uid: 'u1', email: 'fm@example.com', role: 'fund_manager', roleResolved: true }), subscribe: () => () => {} });
  inst.layer.view(); const v = inst.source.getView(); assert.equal(v.status, 'blocked'); assert.ok(v.reasons[0].startsWith('READ_ERROR:ledger:'), JSON.stringify(v.reasons)); assert.equal(v.result, null); inst.layer.release(); setNetXirrLive(null);
});
await t('12. كتابة معلّقة وحدها (الشبكة تعمل: hasPendingWrites:true وfromCache:false) ⇒ مصدر الدفتر يحجب لحظتها؛ ثم تأكيد الخادم يفتحه', async () => {
  const { createLedgerSource } = await import('../../src/features/portfolio-ledger-source.js'); const base = makeLedgerSubscribe({ DB: db }); const seen = []; let L;
  L = createLedgerSource({ getSession: () => ({ uid: 'u1', email: 'fm@example.com', role: 'fund_manager', roleResolved: true }),
    subscribe: (n, ok, err) => base(n, (snap) => { ok(snap); if (snap.hasPendingWrites === true && snap.fromCache === false) seen.push({ n, reason: L.getLedger().reason }); }, err) });
  L.start(); assert.ok(await until(() => L.getLedger().ok === true), JSON.stringify(L.getLedger()));
  await db.collection('capitalCalls').doc(`c3-${RUN}`).set({ fundId: F1, callDate: '2025-10-01', amount: 1, status: 'paid' });
  assert.ok(seen.some((x) => x.n === 'capitalCalls' && x.reason === 'INPUTS_LEDGER_NOT_SERVER_CONFIRMED:capitalCalls'), JSON.stringify(seen));
  assert.ok(await until(() => L.getLedger().ok === true)); await db.collection('capitalCalls').doc(`c3-${RUN}`).delete(); L.stop(); assert.equal(L.stats().live, 0);
});
await t('13. قيد مسدّد لصندوق خارج النطاق وقيد بلا معرّف صندوق (مؤكدان على الخادم) ⇒ يُحجب المعدّل بـ COVERAGE_FUND_MISSING عبر الموصّل والجسر الحقيقيين؛ وبحذفهما يعود', async () => {
  const m = wire(); assert.ok(await until(() => view(m).status === 'ready'), JSON.stringify(view(m)));
  for (const [id, data] of [[`stray-out-${RUN}`, { fundId: `OUT-${RUN}`, callDate: '2025-04-01', amount: 1000000, status: 'paid' }], [`stray-nofund-${RUN}`, { callDate: '2025-04-01', amount: 1000000, status: 'paid' }]]) {
    await db.collection('capitalCalls').doc(id).set(data);
    assert.ok(await until(() => view(m).status === 'blocked' && view(m).reasons.includes('COVERAGE_FUND_MISSING')), `${id}: ${JSON.stringify(view(m))}`); assert.equal(typeof (view(m).result && view(m).result.rate), 'undefined');
    await db.collection('capitalCalls').doc(id).delete(); assert.ok(await until(() => view(m).status === 'ready'), `${id} removed: ${JSON.stringify(view(m))}`);
  }
  m.layer.release(); setNetXirrLive(null);
});
await db.terminate(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
