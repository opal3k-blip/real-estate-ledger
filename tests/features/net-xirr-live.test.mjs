// R1-C3 — طبقة توصيل Net XIRR: دورة الحياة، منتصف ليل الرياض، عودة التبويب، الاستعادة بتراجع، مصدر واحد للشاشتين. (منطقية: مصدر R1-C2 الحقيقي + اشتراك مزيَّف + مؤقّتات مزيَّفة)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createNetXirrLive, msUntilRiyadhMidnight, viewSignature, BACKOFF_BASE_MS, BACKOFF_CAP_MS, getNetXirrLive, setNetXirrLive } from '../../src/features/net-xirr-live.js';
import { createPortfolioValuationSource } from '../../src/features/portfolio-valuation-source.js';
import { documentHashHex } from '../../src/domain/validation/document-hash.js';
import { makeFakeSubscribe, sessionBox, tick, SESSION_FM } from '../helpers/fund-valuation-fakes.mjs';
import { makeTimers, makeDoc, makeEmitter, makeObserver } from '../helpers/fake-env.mjs';

let passed = 0; let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); } }
const clone = (o) => JSON.parse(JSON.stringify(o));
const DAY = '2026-03-31';

async function pair(fundId, day = DAY) {
  const valuationId = `v-${fundId}`; const approvedBy = 'appr@x.sa'; const contentHash = `CH-${fundId}`;
  const c = fundId === 'f1'
    ? { components: { assetsValue: 1000000, cashRetained: 50000, otherAssets: 20000, otherAssetsItems: [{ description: 'receivable', amount: 20000 }], liabilities: 70000, distributionsPayable: 0 }, residualValue: 1000000, coverage: { linkedAssets: ['a1', 'a2'], unlinkedHoldings: { declared: 'none' } } }
    : { components: { assetsValue: 500000, cashRetained: 0, otherAssets: 0, otherAssetsItems: [], liabilities: 0, distributionsPayable: 0 }, residualValue: 500000, coverage: { linkedAssets: [], unlinkedHoldings: { declared: 'none' } } };
  const doc = { valuationId, fundId, valuationDate: day, state: 'approved', status: 'approved', currency: 'SAR', basis: 'RESIDUAL_VALUE_AS_OF_DATE', ...c, method: 'appraisal', source: { ref: `DOC-${fundId}`, provider: 'V' },
    nonOverlap: { cashNotInAssets: true, otherAssetsNotInAssets: true, assetsStatedGrossOfLiabilities: true }, version: 1, supersedes: null, enteredBy: 'prep@x.sa', approvedBy, contentHash };
  const head = { fundId, valuationDate: day, headId: valuationId, version: 1, headHash: await documentHashHex({ valuationId, version: 1, contentHash, approvedBy }), eligibility: { state: 'ELIGIBLE', changedBy: approvedBy, changedAt: 't', reasonCode: 'APPROVED', reason: null }, activeDraftId: null, rev: 1 };
  return { head: { id: `${fundId}__${day}`, data: head }, doc: { id: valuationId, data: doc } };
}

function setup({ session } = {}) {
  const fake = makeFakeSubscribe(); const box = sessionBox(session || SESSION_FM); const timers = makeTimers(); const doc = makeDoc(); const win = makeEmitter(); const obs = makeObserver();
  const st = { nowInstant: new Date('2026-03-31T09:00:00Z'), renders: 0, shown: true, records: [{ kind: 'capitalCall', id: 'c1', fundId: 'f1', date: '2025-03-31', amount: 1000000, status: 'paid', reversalOfId: null }] };
  let layer = null;
  const source = createPortfolioValuationSource({
    subscribe: (s, f, n, e) => fake.subscribe(s, f, (x) => n({ ...x, hasPendingWrites: false }), e), getSession: box.get, now: () => new Date(st.nowInstant.getTime() + timers.now()),
    getInputs: () => ({ scope: { snapshotDate: new Date(st.nowInstant.getTime() + timers.now() + 3 * 3600000).toISOString().slice(0, 10), funds: ['f1', 'f2'], linksByFund: { f1: ['a1', 'a2'], f2: [] } }, records: st.records }),
    onChange: () => { if (layer) layer.onSourceChange(); },
  });
  layer = createNetXirrLive({ source, now: () => new Date(st.nowInstant.getTime() + timers.now()), requestRender: () => { st.renders += 1; }, timers, doc, win, isShown: () => st.shown, observe: obs.observe });
  return { fake, box, st, source, layer, timers, doc, win, obs };
}
const feed = async (m) => { const p1 = await pair('f1'); const p2 = await pair('f2'); for (const [f, p] of [['f1', p1], ['f2', p2]]) { m.fake.emit('heads', f, [p.head]); m.fake.emit('valuations', f, [p.doc]); } await tick(); return { p1, p2 }; };

console.log('— R1-C3 net-xirr-live layer —');

await t('1. view() يبدأ القراءة مرة واحدة فقط، ويعيد العرض الحالي (لا شيء محفوظ)', async () => {
  const m = setup(); assert.equal(m.fake.subs.length, 0); const v = m.layer.view(); m.layer.view(); m.layer.view();
  assert.equal(v.status, 'loading'); assert.equal(m.fake.live().length, 4); assert.equal(m.layer.stats().acquires, 1); assert.equal(m.layer.isOn(), true);
  await feed(m); assert.equal(m.layer.view().status, 'ready');
});
await t('2. مغادرة العرض (اختفاء العلامة) ⇒ stop فوري: صفر مستمعات، لا مؤقّتات، لا مستمعات بيئة، والعرض stopped', async () => {
  const m = setup(); m.layer.view(); await feed(m); assert.ok(m.timers.count() >= 1); assert.ok(m.doc.count() + m.win.count() >= 3);
  m.st.shown = false; m.obs.cb();
  assert.equal(m.layer.isOn(), false); assert.equal(m.fake.live().length, 0); assert.equal(m.source.getView().status, 'stopped');
  assert.equal(m.timers.count(), 0); assert.equal(m.doc.count() + m.win.count(), 0); assert.equal(m.obs.live, 0);
});
await t('3. العلامة ما زالت ظاهرة ⇒ المراقِب لا يوقف شيئًا', async () => {
  const m = setup(); m.layer.view(); m.obs.cb(); assert.equal(m.layer.isOn(), true); assert.equal(m.fake.live().length, 4);
});
await t('4. العودة إلى العرض بعد المغادرة تبدأ قراءة جديدة بجيل جديد؛ لا بقايا من الجلسة السابقة', async () => {
  const m = setup(); m.layer.view(); await feed(m); const g0 = m.source.stats().generation; m.st.shown = false; m.obs.cb(); m.st.shown = true;
  const v = m.layer.view(); assert.equal(v.status, 'loading'); assert.ok(m.source.stats().generation > g0); assert.equal(m.fake.live().length, 4); assert.equal(m.source.stats().heldDocs, 0);
});
await t('5. pagehide يوقف القراءة', async () => {
  const m = setup(); m.layer.view(); m.win.fire('pagehide'); assert.equal(m.layer.isOn(), false); assert.equal(m.fake.live().length, 0);
});
await t('6. منتصف ليل الرياض: المؤقّت مضبوط على الحد التالي بدقة، ويُبطل العرض ويطلب إعادة رسم ويعيد الضبط', async () => {
  const m = setup(); m.layer.view(); await feed(m); assert.equal(m.layer.view().status, 'ready');
  const expected = msUntilRiyadhMidnight(m.st.nowInstant); assert.equal(expected, 12 * 3600000);        // 09:00Z = 12:00 الرياض ⇒ 12 ساعة
  const mt = m.timers.pending().find((p) => p.ms === expected + 50); assert.ok(mt, JSON.stringify(m.timers.pending()));
  const r0 = m.st.renders; m.st.nowInstant = new Date(Date.parse('2026-03-31T21:00:00Z') - (expected + 50)); m.timers.advance(expected + 60);   // الساعة الفعلية عند الإطلاق = 21:00Z تمامًا
  assert.notEqual(m.source.getView().status, 'ready'); assert.ok(m.st.renders > r0); assert.equal(m.layer.stats().midnightFires, 1);
  assert.ok(m.timers.pending().some((p) => p.ms === 86400000 + 50));   // أُعيد ضبطه لليوم التالي
});
await t('7. حدود msUntilRiyadhMidnight: 20:59:59.999Z ⇒ 1ms، و21:00:00Z ⇒ 24h', async () => {
  assert.equal(msUntilRiyadhMidnight(new Date('2026-03-31T20:59:59.999Z')), 1); assert.equal(msUntilRiyadhMidnight(new Date('2026-03-31T21:00:00Z')), 86400000);
});
await t('8. عودة التبويب (visible) أو التركيز أو الاتصال تُعيد المزامنة وتُبطل نتيجة تجاوزت منتصف الليل دون أن يطلق المؤقّت (تبويب مجمّد)', async () => {
  for (const fire of [(m) => m.doc.fire('visibilitychange'), (m) => m.win.fire('focus'), (m) => m.win.fire('online')]) {
    const m = setup(); m.layer.view(); await feed(m); assert.equal(m.layer.view().status, 'ready');
    m.st.nowInstant = new Date('2026-04-01T05:00:00Z'); const r0 = m.st.renders;   // المؤقّت لم يُطلق (تبويب مجمّد)
    fire(m); assert.notEqual(m.source.getView().status, 'ready'); assert.ok(m.st.renders > r0);
  }
});
await t('9. visibilitychange إلى hidden لا يفعل شيئًا (لا مزامنة ولا إعادة رسم)', async () => {
  const m = setup(); m.layer.view(); await feed(m); m.layer.view(); m.doc.visibilityState = 'hidden'; const r0 = m.st.renders; const g0 = m.source.stats().generation; m.doc.fire('visibilitychange');
  assert.equal(m.st.renders, r0); assert.equal(m.source.stats().generation, g0);
  m.st.nowInstant = new Date('2026-04-02T05:00:00Z'); m.doc.fire('visibilitychange');       // الوقت تجاوز المنتصف والتبويب مخفي: لا مزامنة حتى يعود ظاهرًا
  assert.equal(m.source.stats().generation, g0); assert.equal(m.st.renders, r0);
  m.doc.visibilityState = 'visible'; m.doc.fire('visibilitychange'); assert.ok(m.source.stats().generation > g0);
});
await t('10. تغيّر الجلسة أو الدور يُبطل العرض ويطلب إعادة رسم عبر إشعار المصدر', async () => {
  const m = setup(); m.layer.view(); await feed(m); m.layer.view(); const r0 = m.st.renders;
  m.box.set({ role: 'analyst' }); m.source.sync(); await tick();
  assert.ok(m.st.renders > r0); assert.equal(m.source.getView().status, 'hidden');
});
await t('11. إعادة الرسم فقط عند تغيّر بصمة العرض: إشعارات متكررة بلا تغيير لا تُنتج رسمًا', async () => {
  const m = setup(); m.layer.view(); await feed(m); m.layer.view(); const r0 = m.st.renders;
  for (let i = 0; i < 20; i += 1) m.layer.onSourceChange(); assert.equal(m.st.renders, r0);
});
await t('12. استعادة بعد خطأ: مؤقّت واحد معلّق بتراجع 2 ث ثم 4 ثم 8 … حتى 60 ث، ولا استدعاء مبكر مهما تكررت الأحداث', async () => {
  const m = setup(); m.layer.view(); await feed(m); m.layer.view();
  m.fake.fail('valuations', 'f1', { code: 'unavailable' }); m.layer.onSourceChange();
  assert.equal(m.layer.stats().retryArmed, true); const waits = [];
  for (let i = 0; i < 9; i += 1) {
    const n0 = m.layer.stats().recovers; const pend = m.timers.pending(); assert.equal(pend.filter((p) => p.ms !== 12 * 3600000 + 50 && p.ms < 80000).length >= 1, true);
    for (let k = 0; k < 10; k += 1) { m.win.fire('online'); m.win.fire('focus'); m.doc.fire('visibilitychange'); }   // عاصفة أحداث
    assert.equal(m.layer.stats().recovers, n0, 'no early recover'); assert.equal(m.timers.pending().filter((p) => p.ms <= BACKOFF_CAP_MS).length, 1, 'one retry timer');
    const retry = m.timers.pending().find((p) => p.ms <= BACKOFF_CAP_MS); waits.push(retry.ms);
    m.timers.advance(retry.ms + 1); assert.equal(m.layer.stats().recovers, n0 + 1);
    m.fake.fail('valuations', 'f1', { code: 'unavailable' }); m.layer.onSourceChange();     // الاشتراك الجديد يفشل مجددًا
  }
  assert.deepEqual(waits.slice(0, 6), [2000, 4000, 8000, 16000, 32000, 60000]); assert.ok(waits.every((w) => w <= BACKOFF_CAP_MS)); assert.equal(waits[8], 60000);
});
await t('13. نجاح القراءة (ready) يصفّر التراجع ويلغي المؤقّت المعلّق', async () => {
  const m = setup(); m.layer.view(); await feed(m); m.fake.fail('heads', 'f1', { code: 'unavailable' }); m.layer.onSourceChange();
  m.timers.advance(2001); assert.equal(m.layer.stats().recovers, 1); await feed(m); m.layer.view();
  assert.equal(m.source.getView().status, 'ready'); assert.equal(m.layer.stats().attempts, 0); assert.equal(m.layer.stats().retryArmed, false);
});
await t('13ب. استعادة النتيجة بلقطات جديدة (دون recover) تلغي مؤقّت إعادة المحاولة المعلّق', async () => {
  const m = setup(); m.layer.view(); const { p1 } = await feed(m); m.fake.fail('heads', 'f1', { code: 'unavailable' }); m.layer.onSourceChange(); assert.equal(m.layer.stats().retryArmed, true);
  m.fake.emit('heads', 'f1', [p1.head]); await tick(); m.layer.view(); assert.equal(m.source.getView().status, 'ready'); assert.equal(m.layer.stats().retryArmed, false); assert.equal(m.layer.stats().recovers, 0);
});
await t('14. رفض الصلاحية يُعاد بنفس التراجع (لا عاصفة)؛ READ_STALE وحدها لا تُعاد (المستمع الحي يعالجها)', async () => {
  const m = setup(); m.layer.view(); const { p1 } = await feed(m); m.layer.view();
  m.fake.emit('heads', 'f1', [p1.head], true); m.layer.onSourceChange(); assert.ok(m.source.getView().reasons.some((r) => r.startsWith('READ_STALE'))); assert.equal(m.layer.stats().retryArmed, false);
  m.fake.fail('heads', 'f2', { code: 'permission-denied' }); m.layer.onSourceChange(); assert.equal(m.layer.stats().retryArmed, true);
  for (let i = 0; i < 5; i += 1) { m.win.fire('online'); } assert.equal(m.layer.stats().recovers, 0);
  m.timers.advance(2001); assert.equal(m.layer.stats().recovers, 1);
});
await t('15. مغادرة العرض أثناء انتظار إعادة المحاولة تلغي المؤقّت ولا تستعيد شيئًا بعدها', async () => {
  const m = setup(); m.layer.view(); await feed(m); m.fake.fail('heads', 'f1', { code: 'unavailable' }); m.layer.onSourceChange(); assert.equal(m.layer.stats().retryArmed, true);
  m.st.shown = false; m.obs.cb(); m.timers.advance(120000); assert.equal(m.layer.stats().recovers, 0); assert.equal(m.fake.live().length, 0); assert.equal(m.timers.count(), 0);
});
await t('16. بعد المغادرة: أحداث البيئة والمؤقّتات القديمة لا تعيد فتح اشتراكات (sync لا تبدأ)', async () => {
  const m = setup(); m.layer.view(); await feed(m); m.st.shown = false; m.obs.cb();
  m.doc.fire('visibilitychange'); m.win.fire('online'); m.win.fire('focus'); m.layer.sync(); m.source.sync(); m.source.getView(); m.timers.advance(86400000 * 2);
  assert.equal(m.fake.live().length, 0); assert.equal(m.layer.stats().recovers, 0);
});
await t('17. الشاشتان تقرآن مثيلاً مشتركًا واحدًا: setNetXirrLive/getNetXirrLive، وview() من أي منهما يعيد البصمة نفسها', async () => {
  const m = setup(); setNetXirrLive(m.layer); assert.equal(getNetXirrLive(), m.layer); await feed(m);
  const a = m.layer.view(); const b = getNetXirrLive().view(); assert.equal(viewSignature(a), viewSignature(b)); assert.equal(m.fake.live().length, 4);   // لا اشتراكات مضاعفة
  setNetXirrLive(null);
});
await t('17ب. lazySession: core بلا DB أو بلا مستخدم ⇒ جلسة غير محسومة (لا قراءة)، ولا استثناء', async () => {
  const { lazySession } = await import('../../src/features/net-xirr-live-wiring.js'); const s = lazySession({}); const v = s(); assert.equal(v.roleResolved, false); assert.equal(v.uid, null);
});
await t('18. ساكن: لا Date.now ولا new Date() داخل الطبقة (الوقت مُحقَن)، وmain.js يثبّت المصدر بعد registerPortfolio', async () => {
  const f = fs.readFileSync(new URL('../../src/features/net-xirr-live.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const bad of ['Date.now', 'new Date(', 'firebase', 'localStorage']) assert.ok(!f.includes(bad), bad);
  const main = fs.readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  assert.ok(main.indexOf('registerPortfolio(core)') < main.indexOf('installNetXirrLive(core)'));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
