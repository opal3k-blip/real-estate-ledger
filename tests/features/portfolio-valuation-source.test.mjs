// R1-C2 — اختبارات مصدر تقييمات المحفظة المتعدد الصناديق (منطقية: اشتراك مزيَّف + بصمات حقيقية + الجسر الحقيقي؛ بلا DOM ولا Firebase).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPortfolioValuationSource } from '../../src/features/portfolio-valuation-source.js';
import { documentHashHex } from '../../src/domain/validation/document-hash.js';
import { makeFakeSubscribe, sessionBox, tick, SESSION_FM } from '../helpers/fund-valuation-fakes.mjs';

let passed = 0; let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const DAY = '2026-03-31';
const NOW = () => new Date('2026-03-31T09:00:00Z');          // 12:00 Riyadh
const NEXT_DAY_INSTANT = new Date('2026-03-31T21:00:00Z');    // 00:00 Riyadh next day

const content = (fundId) => (fundId === 'f1'
  ? { components: { assetsValue: 1000000, cashRetained: 50000, otherAssets: 20000, otherAssetsItems: [{ description: 'receivable', amount: 20000 }], liabilities: 70000, distributionsPayable: 0 }, residualValue: 1000000, coverage: { linkedAssets: ['a1', 'a2'], unlinkedHoldings: { declared: 'none' } } }
  : { components: { assetsValue: 500000, cashRetained: 0, otherAssets: 0, otherAssetsItems: [], liabilities: 0, distributionsPayable: 0 }, residualValue: 500000, coverage: { linkedAssets: [], unlinkedHoldings: { declared: 'none' } } });

async function pair(fundId, { day = DAY, version = 1, goodHash = true, eligibility, docOver = {}, headOver = {} } = {}) {
  const valuationId = `v-${fundId}`; const approvedBy = 'appr@x.sa'; const contentHash = `CH-${fundId}`;
  const headHash = goodHash ? await documentHashHex({ valuationId, version, contentHash, approvedBy }) : 'bad-hash';
  const doc = { valuationId, fundId, valuationDate: day, state: 'approved', status: 'approved', currency: 'SAR', basis: 'RESIDUAL_VALUE_AS_OF_DATE', ...content(fundId),
    method: 'appraisal', source: { ref: `DOC-${fundId}`, provider: 'Valuer Co' }, nonOverlap: { cashNotInAssets: true, otherAssetsNotInAssets: true, assetsStatedGrossOfLiabilities: true },
    version, supersedes: null, enteredBy: 'prep@x.sa', approvedBy, contentHash, ...docOver };
  const elig = eligibility === undefined ? { state: 'ELIGIBLE', changedBy: approvedBy, changedAt: `${day}T08:00:00.000Z`, reasonCode: 'APPROVED', reason: null } : eligibility;
  const head = { fundId, valuationDate: day, headId: valuationId, version, headHash, eligibility: elig, activeDraftId: null, rev: 1, ...headOver };
  return { head: { id: `${fundId}__${day}`, data: head }, doc: { id: valuationId, data: doc } };
}

function setup({ session, gated = false, verify } = {}) {
  const fake = makeFakeSubscribe(); const box = sessionBox(session || SESSION_FM);
  const st = { nowInstant: NOW(), changes: 0, computeArgs: [], funds: ['f1', 'f2'], records: [{ kind: 'capitalCall', id: 'c1', fundId: 'f1', date: '2025-03-31', amount: 1000000, status: 'paid', reversalOfId: null }] };
  const pend = [];
  const vfy = verify || (gated ? (h, d) => new Promise((res) => pend.push({ h, d, res })) : undefined);
  const { computeResidualBackedNetXirr } = globalThis.__bridge;
  const src = createPortfolioValuationSource({
    subscribe: (source, fundId, onNext, onError) => fake.subscribe(source, fundId, (snap) => onNext(snap && typeof snap === 'object' && snap.hasPendingWrites === undefined && !st.raw ? { ...snap, hasPendingWrites: false } : snap), onError), getSession: box.get, now: () => st.nowInstant, onChange: () => { st.changes += 1; },
    getInputs: () => ({ scope: { snapshotDate: DAY, funds: st.funds, linksByFund: { f1: ['a1', 'a2'], f2: [] } }, records: st.records }),
    ...(vfy ? { verify: vfy } : {}),
    compute: (input, opts) => { st.computeArgs.push({ input: clone(input), opts }); return computeResidualBackedNetXirr(input, opts); },
  });
  return { fake, box, st, src, pend };
}
globalThis.__bridge = await import('../../src/domain/financial/xirr/residual-nav-bridge.js');
const feedFund = (m, fundId, p, fromCache = false) => { m.fake.emit('heads', fundId, p.head ? [p.head] : [], fromCache); m.fake.emit('valuations', fundId, p.doc ? [p.doc] : [], fromCache); };
async function feedBoth(m, over = {}) {
  const p1 = await pair('f1', over.f1); const p2 = await pair('f2', over.f2);
  feedFund(m, 'f1', p1); feedFund(m, 'f2', p2);
  return { p1, p2 };
}
async function ready(m, over) { m.src.start(); const ps = await feedBoth(m, over); await tick(); return ps; }
const notReady = (v) => { assert.notEqual(v.status, 'ready'); assert.equal(v.result === null || !('rate' in v.result), true); };

console.log('— R1-C2 portfolio valuation source —');

await t('1. دور غير قارئ أو جلسة غير محسومة ⇒ صفر اشتراكات وعرض مخفي', async () => {
  for (const s of [{ uid: 'u', email: 'a@x.com', role: 'analyst', roleResolved: true }, { uid: 'u', email: 'a@x.com', role: 'fund_manager', roleResolved: false }, { uid: '', email: '', role: '' }]) {
    const m = setup({ session: s }); m.src.start();
    assert.equal(m.fake.subs.length, 0); assert.equal(m.src.getView().status, 'hidden');
  }
});
await t('2. الاشتراك: مصدران (رؤوس، تقييمات) لكل صندوق في النطاق بالضبط، بلا تكرار عند مزامنات متكررة', async () => {
  const m = setup(); m.src.start(); m.src.sync(); m.src.getView(); m.src.getView();
  assert.equal(m.fake.live().length, 4);
  assert.deepEqual([...new Set(m.fake.subs.map((s) => s.fundId))].sort(), ['f1', 'f2']);
  assert.deepEqual([...new Set(m.fake.subs.map((s) => s.source))].sort(), ['heads', 'valuations']);
});
await t('3. المسار الكامل: كل الصناديق مقروءة ومؤكدة ومتحقَّق من headHash ⇒ ready والمعدّل 50% من الجسر الحقيقي', async () => {
  const m = setup(); await ready(m);
  const v = m.src.getView();
  assert.equal(v.status, 'ready'); assert.ok(Math.abs(v.result.rate - 0.5) < 1e-9);
  assert.equal(v.result.navValue, 1500000); assert.equal(m.src.stats().bridgeCalls, 1);
  assert.deepEqual(m.st.computeArgs[0].input.eligibility, { f1: { headId: 'v-f1', state: 'ELIGIBLE' }, f2: { headId: 'v-f2', state: 'ELIGIBLE' } });
  assert.equal(m.st.computeArgs[0].input.asOfDate, DAY); assert.ok(m.st.computeArgs[0].opts.now instanceof Date);
  assert.equal(m.src.getView().result, v.result);   // لا إعادة حساب عند المشاهدة المتكررة
  assert.equal(m.src.stats().bridgeCalls, 1);
});
await t('4. لا نتيجة جزئية: صندوق واحد لم يصل بعد ⇒ loading بلا معدّل ولا استدعاء للجسر', async () => {
  const m = setup(); m.src.start(); feedFund(m, 'f1', await pair('f1')); await tick();
  const v = m.src.getView(); assert.equal(v.status, 'loading'); notReady(v); assert.equal(m.src.stats().bridgeCalls, 0);
  assert.equal(m.src.stats().verifyStarted, 0);   // لا تحقق قبل اكتمال القراءة لكل الصناديق
});
await t('5. لقطة من الذاكرة المحلية لا تؤكد المصدر: بقاء loading', async () => {
  const m = setup(); m.src.start();
  feedFund(m, 'f1', await pair('f1'), true); feedFund(m, 'f2', await pair('f2'), true); await tick();
  assert.equal(m.src.getView().status, 'loading'); assert.equal(m.src.stats().bridgeCalls, 0);
});
await t('6. فشل قراءة أحد المصدرين لأحد الصناديق ⇒ blocked بلا معدّل حتى لو كانت البقية جاهزة', async () => {
  const m = setup(); m.src.start(); feedFund(m, 'f1', await pair('f1')); m.fake.emit('heads', 'f2', [(await pair('f2')).head]); m.fake.fail('valuations', 'f2', { code: 'unavailable' }); await tick();
  const v = m.src.getView(); assert.equal(v.status, 'blocked'); notReady(v); assert.ok(v.reasons.some((r) => r.includes('READ_ERROR:valuations:f2')));
  assert.equal(m.src.stats().bridgeCalls, 0);
});
await t('7. رفض الصلاحية ⇒ blocked وإيقاف كل المستمعات ومسح كل البيانات', async () => {
  const m = setup(); await ready(m); assert.equal(m.src.getView().status, 'ready');
  m.fake.fail('heads', 'f1', { code: 'permission-denied' });
  const v = m.src.getView(); assert.equal(v.status, 'blocked'); assert.deepEqual(v.reasons, ['PERMISSION_DENIED']); notReady(v);
  assert.equal(m.fake.live().length, 0);
  assert.equal(m.src.stats().heldDocs, 0); assert.equal(m.src.stats().holdsResult, false);
});
await t('8. بعد التأكيد: عودة مصدر إلى لقطة ذاكرة محلية ⇒ قديم ⇒ إخفاء فوري؛ لقطة خادم جديدة تعيد التحقق وتعيد النتيجة', async () => {
  const m = setup(); const { p1 } = await ready(m); assert.equal(m.src.getView().status, 'ready');
  m.fake.emit('heads', 'f1', [p1.head], true);
  const v = m.src.getView(); assert.equal(v.status, 'blocked'); assert.ok(v.reasons.some((r) => r.startsWith('READ_STALE'))); notReady(v);
  m.fake.emit('heads', 'f1', [p1.head], false); await tick();
  assert.equal(m.src.getView().status, 'ready');
});
await t('9. صندوق بلا رأس لليوم الحالي ⇒ blocked HEAD_MISSING (لا استعمال لرأس يوم آخر ولا «آخر تاريخ»)', async () => {
  const m = setup(); await ready(m, { f2: { day: '2026-03-30' } }); const v = m.src.getView();
  assert.equal(v.status, 'blocked'); assert.ok(v.reasons.includes('HEAD_MISSING:f2')); notReady(v); assert.equal(m.src.stats().bridgeCalls, 0);
});
await t('10. أهلية غائبة/null/حالة مجهولة في الرأس ⇒ blocked ولا يُفترض الرأس سارٍ', async () => {
  for (const eligibility of [null, undefined, {}, { state: 'ok' }, { state: 'eligible' }, 'ELIGIBLE', []]) {
    const m = setup(); m.src.start();
    const p1 = await pair('f1'); const p2 = await pair('f2');
    if (eligibility === undefined) delete p2.head.data.eligibility; else p2.head.data.eligibility = eligibility;
    feedFund(m, 'f1', p1); feedFund(m, 'f2', p2); await tick();
    const v = m.src.getView(); assert.equal(v.status, 'blocked', JSON.stringify(eligibility)); assert.ok(v.reasons.includes('ELIGIBILITY_MISSING:f2')); notReady(v);
    assert.equal(m.src.stats().bridgeCalls, 0);
  }
});
await t('11. رأس بلا وثيقة معتمدة مطابقة (أو وثيقة مسودة فقط) ⇒ blocked HEAD_DOC_MISSING', async () => {
  const m = setup(); m.src.start(); const p1 = await pair('f1'); const p2 = await pair('f2', { docOver: { state: 'draft', status: 'draft' } });
  feedFund(m, 'f1', p1); feedFund(m, 'f2', p2); await tick();
  const v = m.src.getView(); assert.equal(v.status, 'blocked'); assert.ok(v.reasons.includes('HEAD_DOC_MISSING:f2')); assert.equal(m.src.stats().bridgeCalls, 0);
});
await t('12. فشل التحقق من headHash لأحد الصناديق ⇒ blocked بسبب HEAD_HASH_MISMATCH ولا يُستدعى الجسر ولا معدّل', async () => {
  const m = setup(); await ready(m, { f2: { goodHash: false } }); const v = m.src.getView();
  assert.equal(v.status, 'blocked'); assert.ok(v.reasons.includes('HEAD_HASH_MISMATCH:f2')); notReady(v); assert.equal(m.src.stats().bridgeCalls, 0);
});
await t('13. عدم القدرة على التحقق (استثناء/رفض/نتيجة بلا ok) ⇒ blocked', async () => {
  for (const verify of [() => { throw new Error('no crypto'); }, () => Promise.reject(new Error('x')), () => Promise.resolve(undefined), () => Promise.resolve({ ok: 'true' }), () => Promise.resolve({ ok: false, reason: 'HEAD_UNVERIFIABLE' })]) {
    const m = setup({ verify }); await ready(m); const v = m.src.getView();
    assert.equal(v.status, 'blocked'); notReady(v); assert.equal(m.src.stats().bridgeCalls, 0);
  }
});
await t('14. رأس معلّق ⇒ يمرّ التحقق ثم يحجب الجسر (VALUATION_SUSPENDED) بلا معدّل ولا رجوع لإصدار أقدم', async () => {
  const m = setup(); await ready(m, { f1: { eligibility: { state: 'SUSPENDED', changedBy: 'x@x.sa', changedAt: 't', reasonCode: 'X', reason: 'r' } } });
  const v = m.src.getView(); assert.equal(v.status, 'blocked'); assert.ok(v.reasons.includes('VALUATION_SUSPENDED')); notReady(v);
});
await t('15. تقييم لا يمرّ منتقي R1-A (معادلة خاطئة) ⇒ blocked بلا معدّل', async () => {
  const m = setup(); await ready(m, { f1: { docOver: { residualValue: 1 } } }); const v = m.src.getView();
  assert.equal(v.status, 'blocked'); notReady(v); assert.ok(v.reasons.length > 0);
});

/* ---- شرط 1: الإخفاء الفوري (كلها متزامنة: بلا await بين التغيير والقراءة) ---- */
await t('16. تبدّل المستخدم ⇒ إخفاء فوري وإيقاف مستمعاته وبدء مستمعات جديدة بجيل جديد، ولا تظهر بياناته القديمة', async () => {
  const m = setup(); await ready(m); const g0 = m.src.getView().generation; assert.equal(m.src.getView().status, 'ready');
  m.box.set({ uid: 'u2', email: 'other@example.com' });
  const v = m.src.getView(); assert.notEqual(v.status, 'ready'); assert.ok(v.generation > g0); notReady(v);
  assert.equal(m.fake.subs.filter((s) => s.active).length, 4); assert.equal(m.fake.subs.filter((s) => !s.active).length, 4);
  assert.equal(v.status, 'loading');
});
await t('17. فقد دور القراءة ⇒ مخفي فورًا وصفر مستمعات حية', async () => {
  const m = setup(); await ready(m); m.box.set({ role: 'analyst' });
  assert.equal(m.src.getView().status, 'hidden'); assert.equal(m.fake.live().length, 0);
});
await t('18. تغيّر النطاق (صناديق) ⇒ إخفاء فوري وقراءة جديدة للنطاق الجديد فقط', async () => {
  const m = setup(); await ready(m); m.st.funds = ['f1'];
  const v = m.src.getView(); assert.equal(v.status, 'loading'); notReady(v);
  assert.deepEqual([...new Set(m.fake.live().map((s) => s.fundId))], ['f1']);
});
await t('19. تغيّر التدفقات ⇒ إخفاء فوري ولا يعود المعدّل القديم؛ ثم يُحسب من التدفقات الجديدة', async () => {
  const m = setup(); const { p1, p2 } = await ready(m); const old = m.src.getView().result.rate;
  m.st.records = [{ kind: 'capitalCall', id: 'c1', fundId: 'f1', date: '2025-09-30', amount: 1000000, status: 'paid', reversalOfId: null }];
  const v = m.src.getView(); notReady(v); assert.equal(v.status, 'loading');
  feedFund(m, 'f1', p1); feedFund(m, 'f2', p2); await tick();
  const v2 = m.src.getView(); assert.equal(v2.status, 'ready'); assert.notEqual(v2.result.rate, old);
});
await t('20. تغيّر الرأس أو الأهلية (لقطة جديدة) ⇒ الإخفاء قبل أي await، ثم إعادة تحقق جديدة', async () => {
  const m = setup(); const { p1 } = await ready(m); assert.equal(m.src.getView().status, 'ready');
  const susp = await pair('f1', { eligibility: { state: 'SUSPENDED', changedBy: 'x@x.sa', changedAt: 't', reasonCode: 'X', reason: 'r' } });
  m.fake.emit('heads', 'f1', [susp.head]);
  const v = m.src.getView(); notReady(v);                                   // بلا await: لا تظهر النتيجة السابقة
  await tick(); const v2 = m.src.getView(); assert.equal(v2.status, 'blocked'); assert.ok(v2.reasons.includes('VALUATION_SUSPENDED'));
  m.fake.emit('heads', 'f1', [p1.head]); notReady(m.src.getView()); await tick();
  assert.equal(m.src.getView().status, 'ready');
});
await t('21. تغيّر وثيقة تقييم معتمدة ⇒ إخفاء فوري', async () => {
  const m = setup(); const { p1 } = await ready(m); const d = clone(p1.doc); d.data.residualValue = 999;
  m.fake.emit('valuations', 'f1', [d]); notReady(m.src.getView());
});
await t('22. عبور يوم الرياض (20:59:59.999Z ثم 21:00:00Z) ⇒ إخفاء فوري ولا استعمال لرؤوس اليوم السابق', async () => {
  const m = setup(); await ready(m);
  m.st.nowInstant = new Date('2026-03-31T20:59:59.999Z'); assert.equal(m.src.getView().status, 'ready');
  m.st.nowInstant = NEXT_DAY_INSTANT; const v = m.src.getView(); notReady(v); assert.equal(v.day, '2026-04-01');
  assert.equal(v.status, 'loading');
  const p1 = await pair('f1'), p2 = await pair('f2'); feedFund(m, 'f1', p1); feedFund(m, 'f2', p2); await tick();   // بيانات 03-31 ليست رؤوس 04-01
  assert.equal(m.src.getView().status, 'blocked'); assert.ok(m.src.getView().reasons.includes('HEAD_MISSING:f1'));
});
await t('23. لا تغيير ⇒ لا إعادة اشتراك ولا إعادة حساب ولا تغيّر جيل', async () => {
  const m = setup(); await ready(m); const s0 = m.src.stats(); for (let i = 0; i < 5; i += 1) m.src.getView(); const s1 = m.src.stats();
  assert.equal(s1.generation, s0.generation); assert.equal(s1.subscribed, s0.subscribed); assert.equal(s1.bridgeCalls, s0.bridgeCalls);
});

/* ---- شرط 3: الردود المتأخرة ---- */
await t('24. رد تحقق متأخر لجيل سابق (تغيّرت التدفقات) لا يعيد نتيجة أُبطلت', async () => {
  const m = setup({ gated: true }); m.src.start(); const { p1, p2 } = await feedBoth(m); await tick();
  assert.equal(m.pend.length, 2); assert.equal(m.src.getView().status, 'verifying');
  m.st.records = [...m.st.records, { kind: 'capitalCall', id: 'c2', fundId: 'f1', date: '2025-06-30', amount: 1, status: 'paid', reversalOfId: null }];
  assert.equal(m.src.getView().status, 'loading');
  m.pend[0].res({ ok: true }); m.pend[1].res({ ok: true }); await tick();
  assert.equal(m.src.stats().bridgeCalls, 0); assert.ok(m.src.stats().verifyIgnored >= 1); notReady(m.src.getView());
  assert.ok(p1 && p2);
});
await t('25. رد متأخر لجيل سابق لا يطغى على نتيجة الجيل الجديد المكتملة', async () => {
  const m = setup({ gated: true }); m.src.start(); const { p1, p2 } = await feedBoth(m); await tick();
  const old = m.pend.splice(0, 2);
  m.st.records = [{ kind: 'capitalCall', id: 'c1', fundId: 'f1', date: '2025-09-30', amount: 1000000, status: 'paid', reversalOfId: null }];
  m.src.getView(); feedFund(m, 'f1', p1); feedFund(m, 'f2', p2); await tick();
  m.pend.forEach((p) => p.res({ ok: true })); await tick();
  const v = m.src.getView(); assert.equal(v.status, 'ready'); const rate = v.result.rate; const calls = m.src.stats().bridgeCalls;
  old.forEach((p) => p.res({ ok: true })); await tick();
  assert.equal(m.src.getView().result.rate, rate); assert.equal(m.src.stats().bridgeCalls, calls);
});
await t('26. رد تحقق متأخر لبيانات قديمة داخل الجيل نفسه (لقطة رأس جديدة) لا يُطبَّق', async () => {
  const m = setup({ gated: true }); m.src.start(); await feedBoth(m); await tick(); const old = m.pend.splice(0, 2);
  const susp = await pair('f1', { eligibility: { state: 'SUSPENDED', changedBy: 'x@x.sa', changedAt: 't', reasonCode: 'X', reason: 'r' } });
  m.fake.emit('heads', 'f1', [susp.head]); await tick(); assert.equal(m.pend.length, 2);
  old.forEach((p) => p.res({ ok: true })); await tick();
  assert.equal(m.src.stats().bridgeCalls, 0); notReady(m.src.getView());
  m.pend.forEach((p) => p.res({ ok: true })); await tick();
  const v = m.src.getView(); assert.equal(v.status, 'blocked'); assert.ok(v.reasons.includes('VALUATION_SUSPENDED'));
});
await t('27. رد متأخر بعد إيقاف المصدر أو رفض الصلاحية أو تبدّل المستخدم لا يعيد شيئًا', async () => {
  for (const kill of [(m) => m.src.stop(), (m) => m.fake.fail('heads', 'f1', { code: 'permission-denied' }), (m) => m.box.set({ uid: 'u9', email: 'z@example.com' })]) {
    const m = setup({ gated: true }); m.src.start(); await feedBoth(m); await tick(); kill(m);
    m.pend.forEach((p) => p.res({ ok: true })); await tick();
    assert.equal(m.src.stats().bridgeCalls, 0);
    if (m.src.getView) notReady(m.src.getView());
  }
});
await t('28. لقطات متأخرة من مستمع جيل سابق (بعد التبدّل) تُهمَل', async () => {
  const m = setup(); m.src.start(); const oldSubs = [...m.fake.subs]; m.box.set({ uid: 'u2', email: 'other@example.com' }); m.src.sync();
  const p1 = await pair('f1'); const p2 = await pair('f2');
  for (const s of oldSubs) s.onNext({ docs: s.source === 'heads' ? [(s.fundId === 'f1' ? p1 : p2).head] : [(s.fundId === 'f1' ? p1 : p2).doc], fromCache: false, hasPendingWrites: false });
  await tick(); const v = m.src.getView(); assert.equal(v.status, 'loading'); assert.equal(m.src.stats().verifyStarted, 0);
});

/* ---- متفرقات ---- */
await t('28ب. معرّف الوثيقة لا يطابق valuationId داخلها ⇒ blocked VALUATION_ID_MISMATCH', async () => {
  const m = setup(); m.src.start(); const p1 = await pair('f1'); const p2 = await pair('f2'); p2.doc.data.valuationId = 'other-id';
  feedFund(m, 'f1', p1); feedFund(m, 'f2', p2); await tick();
  const v = m.src.getView(); assert.equal(v.status, 'blocked'); assert.ok(v.reasons.includes('VALUATION_ID_MISMATCH:v-f2')); assert.equal(m.src.stats().bridgeCalls, 0);
});
await t('28ج. نتيجة جسر «OK» بلا معدّل رقمي منتهٍ لا تُعرض جاهزة (حاجز دفاعي مستقل عن الجسر)', async () => {
  for (const bad of [{ status: 'OK' }, { status: 'OK', rate: NaN }, { status: 'OK', rate: '0.5' }, { status: 'OK', rate: Infinity }]) {
    const fake = makeFakeSubscribe(); const box = sessionBox();
    const src = createPortfolioValuationSource({ subscribe: (a, b, n, e) => fake.subscribe(a, b, (x) => n({ ...x, hasPendingWrites: false }), e), getSession: box.get, now: NOW, compute: () => bad,
      getInputs: () => ({ scope: { snapshotDate: DAY, funds: ['f1'], linksByFund: { f1: [] } }, records: [] }) });
    src.start(); const p = await pair('f1'); fake.emit('heads', 'f1', [p.head]); fake.emit('valuations', 'f1', [p.doc]); await tick();
    const v = src.getView(); assert.notEqual(v.status, 'ready'); assert.equal(v.status, 'blocked');
  }
});
await t('29. إخفاق الاشتراك (استثناء) ⇒ blocked؛ مدخلات غير صالحة/غير متاحة ⇒ blocked بلا اشتراك', async () => {
  const m = setup(); m.st.funds = []; m.src.start(); assert.equal(m.src.getView().status, 'blocked'); assert.equal(m.fake.subs.length, 0);
  const fake = makeFakeSubscribe(); const box = sessionBox();
  const s1 = createPortfolioValuationSource({ subscribe: () => { throw new Error('boom'); }, getSession: box.get, now: NOW, getInputs: () => ({ scope: { snapshotDate: DAY, funds: ['f1'], linksByFund: { f1: [] } }, records: [] }) });
  s1.start(); assert.equal(s1.getView().status, 'blocked'); notReady(s1.getView());
  const s2 = createPortfolioValuationSource({ subscribe: fake.subscribe, getSession: box.get, now: NOW, getInputs: () => { throw new Error('x'); } });
  s2.start(); assert.equal(s2.getView().status, 'blocked'); assert.equal(fake.subs.length, 0);
  const s3 = createPortfolioValuationSource({ subscribe: fake.subscribe, getSession: box.get, now: () => 'not a date', getInputs: () => ({ scope: { snapshotDate: DAY, funds: ['f1'], linksByFund: { f1: [] } }, records: [] }) });
  s3.start(); assert.equal(s3.getView().status, 'blocked'); assert.equal(fake.subs.length, 0);
});
await t('30. المدخلات لا تُغيَّر (مجمَّدة عميقًا) ولا تُسرَّب مراجعها إلى الجسر', async () => {
  const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
  const m = setup(); m.st.records = deepFreeze(m.st.records); await ready(m);
  assert.equal(m.src.getView().status, 'ready');
});
await t('31. إشعار onChange عند كل تحول (تحميل، تحقق، جاهز، إخفاء) دون عاصفة', async () => {
  const m = setup(); const c0 = m.st.changes; await ready(m); assert.ok(m.st.changes > c0);
  const c1 = m.st.changes; m.box.set({ uid: 'u2', email: 'o@example.com' }); m.src.getView(); await tick(); assert.ok(m.st.changes > c1);
});
await t('32. stop يوقف كل المستمعات ويمنع أي نتيجة', async () => {
  const m = setup(); await ready(m); m.src.stop(); assert.equal(m.fake.live().length, 0); assert.equal(m.src.stats().live, 0);
});

/* ---- R1-C2 fix 1: عقد التأكيد الصريح مع موصّل Firestore ---- */
const rawFeed = (m, fundId, p, flags) => { for (const s of m.fake.subs.filter((x) => x.active && x.fundId === fundId)) s.onNext({ docs: [s.source === 'heads' ? p.head : p.doc], ...flags }); };
const rawSetup = () => { const m = setup(); m.st.raw = true; m.src.start(); return m; };
await t('34. لقطة بلا fromCache (أو بلا hasPendingWrites) ليست تأكيدًا: لا ready ولا معدّل، والسبب انتهاك العقد', async () => {
  for (const flags of [{}, { hasPendingWrites: false }, { fromCache: false }, { fromCache: 'false', hasPendingWrites: false }, { fromCache: false, hasPendingWrites: 0 }, { fromCache: null, hasPendingWrites: false }, { fromCache: false, hasPendingWrites: undefined }]) {
    const m = rawSetup(); rawFeed(m, 'f1', await pair('f1'), flags); rawFeed(m, 'f2', await pair('f2'), flags); await tick();
    const v = m.src.getView(); assert.notEqual(v.status, 'ready', JSON.stringify(flags)); assert.equal(v.status, 'blocked'); assert.ok(v.reasons.some((r) => r.includes('READ_ERROR')), JSON.stringify(v.reasons));
    assert.equal(m.src.stats().bridgeCalls, 0); assert.equal(m.src.stats().heldDocs, 0);
  }
});
await t('35. fromCache:false مع hasPendingWrites:true ليست تأكيدًا ⇒ لا ready (loading قبل أي تأكيد)', async () => {
  const m = rawSetup(); const flags = { fromCache: false, hasPendingWrites: true };
  rawFeed(m, 'f1', await pair('f1'), flags); rawFeed(m, 'f2', await pair('f2'), flags); await tick();
  const v = m.src.getView(); assert.equal(v.status, 'loading'); assert.equal(m.src.stats().heldDocs, 0); assert.equal(m.src.stats().bridgeCalls, 0);
});
await t('36. بعد نتيجة جاهزة: لقطة غير مؤكدة (مفقودة العلامات/pending/cache) تُبطلها فورًا قبل أي await، ولا تستبدل البيانات المؤكدة', async () => {
  for (const [flags, expect] of [[{}, 'READ_ERROR'], [{ fromCache: false }, 'READ_ERROR'], [{ fromCache: false, hasPendingWrites: true }, 'READ_STALE'], [{ fromCache: true, hasPendingWrites: false }, 'READ_STALE']]) {
    const m = setup(); const { p1 } = await ready(m); assert.equal(m.src.getView().status, 'ready');
    const changed = clone(p1.doc); changed.data.residualValue = 1;           // بيانات مختلفة تحمل علامة غير مؤكدة: يجب ألا تُخزَّن
    m.st.raw = true; for (const s of m.fake.subs.filter((x) => x.active && x.fundId === 'f1' && x.source === 'valuations')) s.onNext({ docs: [changed], ...flags });
    const v = m.src.getView(); assert.equal(v.status, 'blocked', JSON.stringify(flags)); assert.ok(v.reasons.some((r) => r.startsWith(expect)), JSON.stringify([flags, v.reasons])); notReady(v);
    assert.equal(m.src.stats().holdsResult, false);
  }
});
await t('37. استعادة: لقطة مؤكدة صحيحة بعد انتهاك العقد أو pending تمسح الحجب وتعيد التحقق والنتيجة', async () => {
  const m = setup(); const { p1 } = await ready(m); m.st.raw = true;
  for (const s of m.fake.subs.filter((x) => x.active && x.fundId === 'f1' && x.source === 'heads')) s.onNext({ docs: [p1.head] });
  assert.equal(m.src.getView().status, 'blocked');
  for (const s of m.fake.subs.filter((x) => x.active && x.fundId === 'f1' && x.source === 'heads')) s.onNext({ docs: [p1.head], fromCache: false, hasPendingWrites: false });
  await tick(); assert.equal(m.src.getView().status, 'ready');
});
await t('38. لقطات مشوّهة (null، بلا docs، docs ليست مصفوفة) ⇒ انتهاك عقد ⇒ blocked بلا استثناء', async () => {
  for (const bad of [null, undefined, 'x', 5, { fromCache: false, hasPendingWrites: false }, { docs: 'x', fromCache: false, hasPendingWrites: false }, { docs: {}, fromCache: false, hasPendingWrites: false }]) {
    const m = rawSetup(); for (const s of m.fake.subs.filter((x) => x.active)) s.onNext(bad);
    const v = m.src.getView(); assert.equal(v.status, 'blocked'); assert.equal(m.src.stats().heldDocs, 0);
  }
});

/* ---- R1-C2 fix 2: حالة توقف صريحة ---- */
await t('39. قبل start(): لا اشتراك ولا نتيجة (getView/sync لا تبدآن القراءة)', async () => {
  const m = setup(); m.src.sync(); const v = m.src.getView(); m.src.getView();
  assert.equal(v.status, 'stopped'); assert.equal(m.fake.subs.length, 0); assert.equal(m.src.stats().running, false);
});
await t('40. بعد stop(): getView() وsync() لا تعيدان فتح الاشتراكات ولا تُظهران نتيجة، حتى مع تغيّر المدخلات والجلسة واليوم', async () => {
  const m = setup(); await ready(m); assert.equal(m.src.getView().status, 'ready'); m.src.stop();
  const subsAfterStop = m.fake.subs.length; assert.equal(m.fake.live().length, 0);
  for (let i = 0; i < 3; i += 1) { const v = m.src.getView(); assert.equal(v.status, 'stopped'); assert.equal(v.result, null); m.src.sync(); }
  m.box.set({ uid: 'u2', email: 'o@example.com' }); m.st.records = []; m.st.nowInstant = NEXT_DAY_INSTANT; m.src.sync(); m.src.getView();
  await tick(); assert.equal(m.fake.subs.length, subsAfterStop); assert.equal(m.fake.live().length, 0); assert.equal(m.src.stats().live, 0); assert.equal(m.src.stats().heldDocs, 0);
  assert.equal(m.src.recover(), false); assert.equal(m.fake.subs.length, subsAfterStop);
});
await t('41. إشعار مؤجّل أو رد/لقطة بعد stop() لا يعيد شيئًا؛ ثم start() صراحةً يبدأ قراءة جديدة بجيل جديد', async () => {
  const m = setup({ gated: true }); m.src.start(); const { p1, p2 } = await feedBoth(m); await tick(); const g0 = m.src.stats().generation; const oldSubs = [...m.fake.subs];
  m.src.stop(); m.pend.forEach((p) => p.res({ ok: true })); for (const s of oldSubs) s.onNext({ docs: [], fromCache: false, hasPendingWrites: false }); await tick();
  assert.equal(m.src.stats().bridgeCalls, 0); assert.equal(m.src.getView().status, 'stopped');
  m.src.start(); assert.ok(m.src.stats().generation > g0); assert.equal(m.fake.live().length, 4); assert.equal(m.src.getView().status, 'loading');
  assert.ok(p1 && p2);
});
await t('42. start() مكررة لا تضاعف الاشتراكات؛ stop() مكررة آمنة', async () => {
  const m = setup(); m.src.start(); m.src.start(); m.src.start(); assert.equal(m.fake.live().length, 4); m.src.stop(); m.src.stop(); assert.equal(m.fake.live().length, 0); assert.equal(m.src.getView().status, 'stopped');
});

/* ---- استعادة القراءة بعد خطأ ينهي الاشتراك ---- */
await t('43. recover(): بعد خطأ ينهي المستمع (أو رفض) تُعيد قراءة نظيفة بجيل جديد؛ بدونها يبقى الحجب (المستمع الميت لا يعود وحده)', async () => {
  const m = setup(); await ready(m); m.fake.fail('valuations', 'f1', { code: 'unavailable' });
  assert.equal(m.src.getView().status, 'blocked'); const g0 = m.src.stats().generation; m.src.sync(); m.src.getView(); assert.equal(m.src.getView().status, 'blocked');
  assert.equal(m.src.recover(), true); assert.ok(m.src.stats().generation > g0); assert.equal(m.fake.live().length, 4); assert.equal(m.src.getView().status, 'loading');
  await feedBoth(m); await tick(); assert.equal(m.src.getView().status, 'ready');
  m.fake.fail('heads', 'f2', { code: 'permission-denied' }); assert.equal(m.src.getView().status, 'blocked'); assert.equal(m.src.recover(), true); assert.equal(m.src.getView().status, 'loading');
});
await t('33. ساكن: يستورد النموذج والجسر فقط؛ بلا DOM/Firebase/ساعة؛ لا واجهة تستورده؛ portfolioIntelligenceStats ما زالت متزامنة', async () => {
  const f = fs.readFileSync(new URL('../../src/features/portfolio-valuation-source.js', import.meta.url), 'utf8');
  const code = f.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.deepEqual([...code.matchAll(/^import .* from '([^']+)';/gm)].map((x) => x[1]).sort(), ['../domain/financial/xirr/residual-nav-bridge.js', './fund-valuation-model.js']);
  for (const bad of ['document.', 'window.', 'firebase', 'Date.now', 'new Date(', 'setTimeout', 'setInterval', 'localStorage', 'fetch(', 'httpsCallable', 'equity']) assert.ok(!code.includes(bad), bad);
  for (const v of ['portfolio.js', 'command-center.js', 'alert-center.js', 'concentration-risk.js', 'institutional-investment-intelligence.js']) {
    assert.ok(!fs.readFileSync(new URL(`../../src/features/${v}`, import.meta.url), 'utf8').includes('portfolio-valuation-source'), v);
  }
  assert.ok(!fs.readFileSync(new URL('../../src/core.js', import.meta.url), 'utf8').includes('portfolio-valuation-source'));
  const stats = fs.readFileSync(new URL('../../src/features/portfolio.js', import.meta.url), 'utf8');
  assert.ok(/function portfolioIntelligenceStats\(/.test(stats) && !/async\s+function portfolioIntelligenceStats/.test(stats));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
