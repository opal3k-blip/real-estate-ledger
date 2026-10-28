// R1-C3 (إغلاق فجوة تأكيد الدفتر) — مصدر الدفتر المستقل عبر مسار التركيب الحقيقي installNetXirrLive:
// نتيجة جاهزة ⇒ كل حالة غير مؤكدة (cache، كتابة معلّقة، خطأ، رفض، علم غائب/غير منطقي، لقطة معطوبة، غياب الاتصال) ⇒ يختفي المعدّل فورًا
// حتى لو لم تتغير قيم الوثائق، ولا يعود إلا بعد لقطة مؤكدة جديدة لكل المجموعات الثلاث.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installNetXirrLive, makeGetInputs } from '../../src/features/net-xirr-live-wiring.js';
import { createLedgerSource, makeLedgerSubscribe, LEDGER_COLLECTIONS } from '../../src/features/portfolio-ledger-source.js';
import { setNetXirrLive } from '../../src/features/net-xirr-live.js';
import { documentHashHex } from '../../src/domain/validation/document-hash.js';
import { makeFakeSubscribe, sessionBox, tick, SESSION_FM } from '../helpers/fund-valuation-fakes.mjs';
import { makeTimers, makeDoc, makeEmitter, makeObserver } from '../helpers/fake-env.mjs';

let passed = 0; let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); } finally { setNetXirrLive(null); } }
const DAY = '2026-03-31';

async function pair(fundId) {
  const valuationId = `v-${fundId}`; const approvedBy = 'appr@x.sa'; const contentHash = `CH-${fundId}`;
  const c = fundId === 'f1'
    ? { components: { assetsValue: 1000000, cashRetained: 50000, otherAssets: 20000, otherAssetsItems: [{ description: 'receivable', amount: 20000 }], liabilities: 70000, distributionsPayable: 0 }, residualValue: 1000000, coverage: { linkedAssets: ['a1', 'a2'], unlinkedHoldings: { declared: 'none' } } }
    : { components: { assetsValue: 500000, cashRetained: 0, otherAssets: 0, otherAssetsItems: [], liabilities: 0, distributionsPayable: 0 }, residualValue: 500000, coverage: { linkedAssets: [], unlinkedHoldings: { declared: 'none' } } };
  const doc = { valuationId, fundId, valuationDate: DAY, state: 'approved', status: 'approved', currency: 'SAR', basis: 'RESIDUAL_VALUE_AS_OF_DATE', ...c, method: 'appraisal', source: { ref: `DOC-${fundId}`, provider: 'V' },
    nonOverlap: { cashNotInAssets: true, otherAssetsNotInAssets: true, assetsStatedGrossOfLiabilities: true }, version: 1, supersedes: null, enteredBy: 'prep@x.sa', approvedBy, contentHash };
  const head = { fundId, valuationDate: DAY, headId: valuationId, version: 1, headHash: await documentHashHex({ valuationId, version: 1, contentHash, approvedBy }), eligibility: { state: 'ELIGIBLE', changedBy: approvedBy, changedAt: 't', reasonCode: 'APPROVED', reason: null }, activeDraftId: null, rev: 1 };
  return { head: { id: `${fundId}__${DAY}`, data: head }, doc: { id: valuationId, data: doc } };
}

const LEDGER_DOCS = () => ({
  funds: [{ id: 'f1', data: { name: 'F1', assetIds: ['a1', 'a2'] } }, { id: 'f2', data: { name: 'F2', assetIds: [] } }],
  capitalCalls: [{ id: 'c1', data: { fundId: 'f1', callDate: '2025-03-31', amount: 1000000, status: 'paid' } }],
  distributions: [],
});
function makeFakeLedger() {
  const subs = [];
  return {
    subs, live: () => subs.filter((s) => !s.closed),
    subscribe: (name, onNext, onError) => { const s = { name, onNext, onError, closed: false }; subs.push(s); return () => { s.closed = true; }; },
    emit(name, docs, flags = { fromCache: false, hasPendingWrites: false }) { for (const s of subs.filter((x) => x.name === name && !x.closed)) s.onNext({ docs, ...flags }); },
    emitRaw(name, raw) { for (const s of subs.filter((x) => x.name === name && !x.closed)) s.onNext(raw); },
    emitAll(d = LEDGER_DOCS()) { for (const n of LEDGER_COLLECTIONS) this.emit(n, d[n]); },
    fail(name, err) { for (const s of subs.filter((x) => x.name === name && !x.closed)) s.onError(err); },
  };
}

function rig({ session } = {}) {
  const val = makeFakeSubscribe(); const led = makeFakeLedger(); const box = sessionBox(session || SESSION_FM);
  const timers = makeTimers(); const doc = makeDoc(); const win = makeEmitter(); const obs = makeObserver();
  const st = { renders: 0 };
  const now = () => new Date(new Date('2026-03-31T09:00:00Z').getTime() + timers.now());
  const core = { isIfCollectionServerConfirmed: () => true, STORE: { funds: [{ id: 'WRONG', data: {} }] }, capitalCallsFor: () => [], distributionsFor: () => [] };   // the OLD flag says "confirmed" and STORE is wrong: must be irrelevant
  const inst = installNetXirrLive(core, { now, timers, doc, win, isShown: () => true, observe: obs.observe, requestRender: () => { st.renders += 1; },
    getSession: box.get, subscribe: (s, f, n, e) => val.subscribe(s, f, (x) => n({ ...x, hasPendingWrites: false }), e), subscribeLedger: led.subscribe });
  return { val, led, box, timers, st, obs, inst, layer: inst.layer, source: inst.source };
}
async function feedVal(m) { const p1 = await pair('f1'); const p2 = await pair('f2'); for (const [f, p] of [['f1', p1], ['f2', p2]]) { m.val.emit('heads', f, [p.head]); m.val.emit('valuations', f, [p.doc]); } await tick(); }
async function ready() { const m = rig(); m.layer.view(); m.led.emitAll(); await feedVal(m); await tick(); assert.equal(m.source.getView().status, 'ready', JSON.stringify(m.source.getView().reasons)); return m; }
const gone = (m) => { const v = m.source.getView(); assert.notEqual(v.status, 'ready'); assert.equal(v.result, null); return v; };

console.log('— R1-C3 portfolio ledger source —');

await t('1. المسار الكامل: الدفتر من مصدره المستقل (لا من core.STORE ولا العلم القديم) ⇒ ready والمعدّل من وثائق الدفتر المؤكدة', async () => {
  const m = await ready(); const v = m.source.getView(); assert.ok(Math.abs(v.result.rate - 0.5) < 1e-9);
  assert.equal(m.led.live().length, 3); assert.deepEqual(m.led.subs.map((s) => s.name).sort(), [...LEDGER_COLLECTIONS].sort());
});
await t('2. قبل أي لقطة للدفتر ⇒ محجوب INPUTS_LEDGER_NOT_SERVER_CONFIRMED حتى لو العلم القديم يقول «مؤكد» وSTORE ممتلئ', async () => {
  const m = rig(); m.layer.view(); await feedVal(m); const v = m.source.getView(); assert.equal(v.status, 'blocked'); assert.ok(v.reasons[0].startsWith('INPUTS_LEDGER_NOT_SERVER_CONFIRMED'), JSON.stringify(v.reasons)); assert.equal(v.result, null);
});
const CASES = [
  ['fromCache:true بالوثائق نفسها', (m, c, d) => m.led.emit(c, d[c], { fromCache: true, hasPendingWrites: false }), 'INPUTS_LEDGER_NOT_SERVER_CONFIRMED'],
  ['hasPendingWrites:true بالوثائق نفسها', (m, c, d) => m.led.emit(c, d[c], { fromCache: false, hasPendingWrites: true }), 'INPUTS_LEDGER_NOT_SERVER_CONFIRMED'],
  ['علم fromCache غائب', (m, c, d) => m.led.emitRaw(c, { docs: d[c], hasPendingWrites: false }), 'INPUTS_LEDGER_CONFIRMATION_UNAVAILABLE'],
  ['علم hasPendingWrites غائب', (m, c, d) => m.led.emitRaw(c, { docs: d[c], fromCache: false }), 'INPUTS_LEDGER_CONFIRMATION_UNAVAILABLE'],
  ['علم غير منطقي (0 / "false")', (m, c, d) => m.led.emitRaw(c, { docs: d[c], fromCache: 0, hasPendingWrites: 'false' }), 'INPUTS_LEDGER_CONFIRMATION_UNAVAILABLE'],
  ['docs ليست مصفوفة', (m, c) => m.led.emitRaw(c, { docs: null, fromCache: false, hasPendingWrites: false }), 'INPUTS_LEDGER_CONFIRMATION_UNAVAILABLE'],
  ['لقطة ليست كائنًا', (m, c) => m.led.emitRaw(c, undefined), 'INPUTS_LEDGER_CONFIRMATION_UNAVAILABLE'],
  ['خطأ مستمع', (m, c) => m.led.fail(c, { code: 'unavailable' }), 'READ_ERROR'],
];
for (const c of LEDGER_COLLECTIONS) {
  for (const [label, act, code] of CASES) {
    await t(`3. ${c}: من ready ⇒ ${label} ⇒ يختفي المعدّل فورًا؛ لا يعود بتكرار غير المؤكد؛ ويعود فقط بلقطة مؤكدة جديدة`, async () => {
      const m = await ready(); const d = LEDGER_DOCS(); const g0 = m.source.stats().generation;
      act(m, c, d); const v = gone(m); assert.ok(v.reasons.some((r) => r.startsWith(code)), JSON.stringify(v.reasons)); assert.ok(v.reasons.some((r) => r.includes(c)) || code === 'READ_ERROR', JSON.stringify(v.reasons));
      assert.equal(m.source.stats().ledger.heldDocs, 3 - d[c].length);                                // الوثائق غير المؤكدة لا تُحتجز
      act(m, c, d); await tick(); gone(m);                                                       // التكرار لا يعيد شيئًا
      if (label === 'خطأ مستمع') { m.led.emit(c, d[c]); await tick(); gone(m); return; }         // مستمع منتهٍ لا يستقبل: لا عودة (الاستعادة اختبار 5)
      m.led.emit(c, d[c]);
      const v2 = m.source.getView(); assert.ok(v2.generation > g0, 'new generation after re-confirmation'); assert.notEqual(v2.status, 'ready', 'fresh valuation read + verification first');
      await feedVal(m); await tick(); assert.equal(m.source.getView().status, 'ready');
    });
  }
}
await t('4. تأكيد جديد يعيد المعدّل بجيل جديد وبعد تحقق جديد (لا إعادة نتيجة قديمة): cache ثم تأكيد ⇒ verifying/ready بجيل أعلى', async () => {
  const m = await ready(); const g0 = m.source.getView().generation; const d = LEDGER_DOCS();
  m.led.emit('capitalCalls', d.capitalCalls, { fromCache: true, hasPendingWrites: false }); gone(m); m.led.emit('capitalCalls', d.capitalCalls);
  const v = m.source.getView(); assert.ok(v.generation > g0); assert.notEqual(v.status, 'ready', 'a fresh verification pass is needed first'); await feedVal(m); await tick(); assert.equal(m.source.getView().status, 'ready');
});
await t('5. خطأ مستمع على الدفتر ⇒ حجب فوري؛ الطبقة تعيد القراءة بعد التراجع (2 ث) باشتراكات جديدة؛ ready فقط بعد تأكيد جديد للمجموعات الثلاث', async () => {
  const m = await ready(); const n0 = m.led.subs.length; m.led.fail('distributions', { code: 'unavailable' }); await tick(); gone(m); assert.ok(m.layer.stats().retryArmed);
  m.timers.advance(2100); await tick(); assert.ok(m.led.subs.length > n0, 'ledger resubscribed'); assert.ok(m.led.live().length === 3);
  assert.notEqual(m.source.getView().status, 'ready'); m.led.emitAll(); await feedVal(m); await tick(); assert.equal(m.source.getView().status, 'ready');
});
await t('6. رفض صلاحية على الدفتر ⇒ PERMISSION_DENIED وكل اشتراكات الدفتر تُغلق ولا وثائق محتجزة', async () => {
  const m = await ready(); m.led.fail('capitalCalls', { code: 'permission-denied' }); const v = gone(m); assert.ok(v.reasons.includes('PERMISSION_DENIED'), JSON.stringify(v.reasons)); assert.equal(m.led.live().length, 0); assert.equal(m.source.stats().ledger.heldDocs, 0);
});
await t('7. غياب معلومات التأكيد كليًا: بلا قاعدة بيانات (makeLedgerSubscribe بلا DB) ⇒ READ_ERROR محجوب، لا بيانات تمرّ؛ وكذلك بلا أي دالة تأكيد في core', async () => {
  const subscribe = makeLedgerSubscribe({}); const L = createLedgerSource({ subscribe, getSession: () => SESSION_FM }); L.start(); const r = L.getLedger(); assert.equal(r.ok, false); assert.ok(r.reason.startsWith('READ_ERROR:ledger:'), r.reason);
  const g = makeGetInputs(L, () => new Date('2026-03-31T09:00:00Z'))(); assert.ok(g.unavailable.startsWith('READ_ERROR')); assert.equal(g.scope, undefined);
  const stub = { sync() {}, getLedger: () => undefined }; assert.equal(makeGetInputs(stub, () => new Date())().unavailable, 'INPUTS_LEDGER_CONFIRMATION_UNAVAILABLE');
  const thrower = { sync() { throw new Error('x'); }, getLedger() {} }; assert.equal(makeGetInputs(thrower, () => new Date())().unavailable, 'INPUTS_LEDGER_CONFIRMATION_UNAVAILABLE');
});
await t('8. makeGetInputs من الوثائق المؤكدة: نطاق مرتّب بلا تكرار، أصول مرتبطة مرتّبة، يوم الرياض، والتدفقات من وثائق الدفتر نفسها', async () => {
  const L = createLedgerSource({ subscribe: (n, ok) => { ok({ docs: { funds: [{ id: 'fb', data: { assetIds: ['z', 'a', 'a'] } }, { id: 'fa', data: { assetIds: [] } }], capitalCalls: [{ id: 'c1', data: { fundId: 'fa', callDate: '2025-01-01', amount: 5, status: 'paid' } }], distributions: [] }[n], fromCache: false, hasPendingWrites: false }); return () => {}; }, getSession: () => SESSION_FM });
  L.start(); const r = makeGetInputs(L, () => new Date('2026-03-31T21:30:00Z'))();
  assert.deepEqual(r.scope.funds, ['fa', 'fb']); assert.equal(r.scope.snapshotDate, '2026-04-01'); assert.deepEqual(r.scope.linksByFund.fb, ['a', 'z']);
  assert.deepEqual(r.records.map((x) => [x.kind, x.id, x.fundId, x.date, x.amount]), [['capitalCall', 'c1', 'fa', '2025-01-01', 5]]);
});
await t('9. تغيّر الجلسة/فقدان الدور ⇒ تُسقَط وثائق الدفتر وتُغلق الاشتراكات؛ جلسة جديدة ⇒ اشتراكات جديدة وتأكيد جديد', async () => {
  const m = await ready(); m.box.set({ uid: null, email: null, role: null, roleResolved: false }); const v = gone(m); assert.equal(m.led.live().length, 0); assert.equal(m.source.stats().ledger.heldDocs, 0);
  m.box.set(SESSION_FM); m.source.getView(); assert.equal(m.led.live().length, 3); assert.notEqual(m.source.getView().status, 'ready');
});
await t('10. إيقاف الطبقة (مغادرة العرض) ⇒ كل اشتراكات الدفتر والتقييمات مغلقة، صفر وثائق، والعرض stopped', async () => {
  const m = await ready(); m.layer.release(); assert.equal(m.led.live().length, 0); assert.equal(m.val.live().length, 0); assert.equal(m.source.getView().status, 'stopped'); assert.equal(m.source.stats().ledger.heldDocs, 0);
});
await t('11. تغيّر العلامات وحدها: لقطة مؤكدة بوثائق مختلفة (دفعة جديدة) تغيّر النتيجة؛ ولقطة cache بالوثائق نفسها تخفيها — دون تعديل core.js', async () => {
  const m = await ready(); const d = LEDGER_DOCS(); d.capitalCalls = [{ id: 'c1', data: { fundId: 'f1', callDate: '2025-03-31', amount: 2000000, status: 'paid' } }];
  m.led.emit('capitalCalls', d.capitalCalls); await feedVal(m); await tick(); const v = m.source.getView(); assert.equal(v.status, 'ready'); assert.ok(v.result.rate < 0.5);
  const core = fs.readFileSync(new URL('../../src/features/net-xirr-live-wiring.js', import.meta.url), 'utf8'); assert.ok(!/isIfCollectionServerConfirmed|STORE/.test(core.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
});

await t('12. دور غير محسوم مع uid موجود ⇒ لا قراءة ولا وثائق (كاش الدور لا يكفي)', async () => {
  const m = await ready(); m.box.set({ roleResolved: false }); gone(m); assert.equal(m.led.live().length, 0); assert.equal(m.source.stats().ledger.heldDocs, 0);
});
await t('13. ردّ متأخر من اشتراك أُغلق (جيل سابق/بعد stop أو recover) لا يعيد وثائق ولا يفتح الدفتر', async () => {
  const m = await ready(); const old = m.led.live(); m.layer.release(); const d = LEDGER_DOCS();
  for (const s of old) s.onNext({ docs: d[s.name], fromCache: false, hasPendingWrites: false }); assert.equal(m.source.stats().ledger.heldDocs, 0); assert.equal(m.source.getView().status, 'stopped');
  const m2 = await ready(); const old2 = m2.led.live(); m2.led.fail('funds', { code: 'unavailable' }); await tick(); m2.timers.advance(2100); await tick();
  for (const s of old2) s.onNext({ docs: d[s.name], fromCache: false, hasPendingWrites: false }); assert.notEqual(m2.source.getView().status, 'ready'); assert.ok(m2.source.stats().ledger.heldDocs === 0, 'late replies from closed subscriptions are dropped');
});
/* ---- لا إسقاط صامت لقيود خارج النطاق: كل وثائق capitalCalls/distributions المؤكدة تصل كسجلات؛ المحرك المعتمد وحده يقرر الحجب ---- */
const confirmedLedger = (d) => createLedgerSource({ subscribe: (n, ok) => { ok({ docs: d[n], fromCache: false, hasPendingWrites: false }); return () => {}; }, getSession: () => SESSION_FM });
await t('14. makeGetInputs: نطاق F1 فقط + نداء F2 + توزيع F3 + قيد بلا fundId + قيد بإشارة سالبة ومرجع عكس ⇒ كلها تصل سجلات بحقولها كما هي (لا تصفية بقائمة الصناديق)', async () => {
  const L = confirmedLedger({ funds: [{ id: 'F1', data: {} }],
    capitalCalls: [{ id: 'c1', data: { fundId: 'F1', callDate: '2025-03-31', amount: 1000000, status: 'paid' } }, { id: 'c2', data: { fundId: 'F2', callDate: '2025-04-01', amount: 1000000, status: 'paid' } },
      { id: 'c3', data: { callDate: '2025-05-01', amount: 7, status: 'paid' } }, { id: 'c4', data: { fundId: 'F1', callDate: '2025-06-01', amount: -250, status: 'paid', reversalOfId: 'c1' } }],
    distributions: [{ id: 'd1', data: { fundId: 'F3', distDate: '2025-09-30', amount: 5, status: 'declared' } }] });
  L.start(); const r = makeGetInputs(L, () => new Date('2026-03-31T09:00:00Z'))();
  assert.deepEqual(r.scope.funds, ['F1']);
  assert.deepEqual(r.records.map((x) => [x.kind, x.id, x.fundId, x.date, x.amount, x.status, x.reversalOfId]),
    [['capitalCall', 'c1', 'F1', '2025-03-31', 1000000, 'paid', null], ['capitalCall', 'c2', 'F2', '2025-04-01', 1000000, 'paid', null], ['capitalCall', 'c3', undefined, '2025-05-01', 7, 'paid', null],
      ['capitalCall', 'c4', 'F1', '2025-06-01', -250, 'paid', 'c1'], ['distribution', 'd1', 'F3', '2025-09-30', 5, 'declared', null]]);
});
const blockedByEngine = (m, code) => { const v = m.source.getView(); assert.equal(v.status, 'blocked', JSON.stringify(v)); assert.ok(v.reasons.includes(code), JSON.stringify(v.reasons)); assert.ok(!v.result || typeof v.result.rate !== 'number'); return v; };
const baseLedger = () => { const d = LEDGER_DOCS(); return d; };
const STRAYS = [
  ['نداء رأس مال مسدّد بمليون لصندوق خارج النطاق (F9)', 'capitalCalls', { id: 'c9', data: { fundId: 'F9', callDate: '2025-04-01', amount: 1000000, status: 'paid' } }],
  ['توزيع مسدّد لصندوق خارج النطاق', 'distributions', { id: 'd9', data: { fundId: 'F9', distDate: '2025-09-30', amount: 5, status: 'paid' } }],
  ['قيد (نداء) بلا معرّف صندوق', 'capitalCalls', { id: 'c8', data: { callDate: '2025-04-01', amount: 1000000, status: 'paid' } }],
  ['قيد (توزيع) بلا معرّف صندوق', 'distributions', { id: 'd8', data: { distDate: '2025-09-30', amount: 5, status: 'paid' } }],
];
for (const [label, coll, doc] of STRAYS) {
  await t(`15. عبر التوصيل والجسر الحقيقيين: ${label} ⇒ يُحجب المعدّل بـ COVERAGE_FUND_MISSING (لا يُحسب بعد إسقاط القيد)؛ وعند اختفاء القيد المؤكد يعود`, async () => {
    const m = rig(); m.layer.view(); const d = baseLedger(); d[coll] = [...d[coll], doc]; m.led.emitAll(d); await feedVal(m); await tick();
    blockedByEngine(m, 'COVERAGE_FUND_MISSING');
    m.led.emitAll(baseLedger()); await feedVal(m); await tick(); assert.equal(m.source.getView().status, 'ready');
  });
}
await t('16. حذف صندوق من الدفتر المؤكد مع بقاء قيوده ⇒ من ready إلى محجوب COVERAGE_FUND_MISSING؛ ولا تختفي قيوده قبل التحقق', async () => {
  const m = await ready(); const d = baseLedger(); d.capitalCalls = [...d.capitalCalls, { id: 'c2', data: { fundId: 'f2', callDate: '2025-04-01', amount: 500000, status: 'paid' } }];
  m.led.emitAll(d); await feedVal(m); await tick(); assert.equal(m.source.getView().status, 'ready');          // f2 موجود ⇒ يُحسب
  const d2 = baseLedger(); d2.funds = d2.funds.filter((f) => f.id !== 'f2'); d2.capitalCalls = d.capitalCalls; m.led.emitAll(d2); await feedVal(m); await tick();
  blockedByEngine(m, 'COVERAGE_FUND_MISSING');
});
await t('17. مرجع: بلا قيد شاذ يبقى المعدّل (لا حجب زائد)', async () => { const m = await ready(); assert.ok(Math.abs(m.source.getView().result.rate - 0.5) < 1e-9); });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
