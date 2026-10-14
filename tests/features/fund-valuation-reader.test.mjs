// R1-B2 / B2-1 — اختبارات قارئ التقييمات (منطقية: اشتراك مزيَّف قابل للعدّ + بصمات حقيقية؛ بلا DOM ولا Firebase ولا متصفح).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFundValuationReader, SOURCES, EVENTS_DISPLAY_LIMIT } from '../../src/features/fund-valuation-reader.js';
import { makeFakeSubscribe, sessionBox, approvedPair, draftDoc, headOnlyDraft, event, tick, SESSION_FM } from '../helpers/fund-valuation-fakes.mjs';

let passed = 0;
let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}`); if (!process.env.CONTINUE_ON_FAIL) throw e; console.error(`      ${String(e.message).split('\n')[0]}`); } }

function mk({ session, verify } = {}) {
  const fake = makeFakeSubscribe(); const box = sessionBox(session || SESSION_FM); let changes = 0;
  const r = createFundValuationReader({ subscribe: fake.subscribe, getSession: box.get, onChange: () => { changes += 1; }, verify });
  return { fake, box, r, changes: () => changes };
}
function gated() {
  const pend = [];
  return { pend, fn: (head, doc) => new Promise((res) => pend.push({ head, doc, res })), release: (i, ok = true, reason = null) => pend[i].res(ok ? { ok: true, reason: null } : { ok: false, reason }) };
}
const ready = async (m, fund, payload) => { m.r.open(fund); m.fake.emitAll(fund, payload); await tick(); return m.r.getView(); };

console.log('— B2-1 reader —');

/* 1. الدور */
await t('1. محلل محسوم ⇒ صفر اشتراكات وصفر استعلامات، ولا لوحة (forbidden)', async () => {
  const m = mk({ session: { uid: 'u', email: 'a@x.com', role: 'analyst', roleResolved: true } });
  m.r.open('F1'); m.r.sync();
  assert.equal(m.fake.subs.length, 0); assert.equal(m.r.stats().subscribed, 0);
  assert.equal(m.r.getView().status, 'forbidden');
});
await t('1ب. دور غير محسوم (حتى لو كانت قيمة مخبَّأة تبدو قارئة) ⇒ صفر اشتراكات؛ ثم يُحسم ⇒ ثلاثة بالضبط', async () => {
  const m = mk({ session: { uid: 'u', email: 'a@x.com', role: 'fund_manager', roleResolved: false } });
  m.r.open('F1'); m.r.sync(); m.r.sync();
  assert.equal(m.fake.subs.length, 0); assert.equal(m.r.getView().status, 'unresolved');
  m.box.set({ roleResolved: true }); m.r.sync();
  assert.equal(m.fake.live().length, 3);
});
await t('1ج. دور غير معروف/فارغ ⇒ صفر', async () => {
  for (const role of ['weird', '', null, undefined, 'Admin ']) {
    const m = mk({ session: { uid: 'u', email: 'a@x.com', role, roleResolved: true } });
    m.r.open('F1'); assert.equal(m.fake.subs.length, 0, String(role));
  }
});
await t('1د. fund_manager/senior_ic/admin ⇒ ثلاثة مستمعات بالمصادر الثلاثة وبمعرّف الصندوق', async () => {
  for (const role of ['fund_manager', 'senior_ic', 'admin']) {
    const m = mk({ session: { uid: 'u', email: 'a@x.com', role, roleResolved: true } });
    m.r.open('F9');
    assert.deepEqual(m.fake.live().map((s) => s.source).sort(), [...SOURCES].sort(), role);
    assert.ok(m.fake.live().every((s) => s.fundId === 'F9'));
  }
});

/* 2. دورة الحياة */
await t('2. صندوق ثانٍ ⇒ يُلغى الأول قبل اشتراك الثاني؛ فتح متكرر لنفس الصندوق (إعادة رسم) لا يضاعف الاشتراكات', async () => {
  const m = mk();
  for (let i = 0; i < 10; i += 1) m.r.open('F1');
  assert.equal(m.r.stats().subscribed, 3); assert.equal(m.fake.live().length, 3);
  m.r.open('F2');
  const firstSubF2 = m.fake.log.findIndex((x) => x.startsWith('sub:') && x.endsWith(':F2'));
  const unsubsF1 = m.fake.log.map((x, i) => [x, i]).filter(([x]) => x.startsWith('unsub:') && x.endsWith(':F1')).map(([, i]) => i);
  assert.equal(unsubsF1.length, 3); assert.ok(unsubsF1.every((i) => i < firstSubF2));
  assert.equal(m.fake.live().length, 3); assert.ok(m.fake.live().every((s) => s.fundId === 'F2'));
});
await t('2ب. إغلاق الصندوق ⇒ صفر مفتوح؛ إغلاق مكرر لا أثر له', async () => {
  const m = mk(); m.r.open('F1'); m.r.close(); m.r.close();
  assert.equal(m.fake.live().length, 0); assert.equal(m.r.stats().live, 0); assert.equal(m.r.stats().unsubscribed, 3);
});

/* 3. الجلسة */
await t('3. تبديل مستخدم مباشر (uid→uid): إلغاء + مسح فوري، ولا تظهر بيانات الأول للثاني، ورد متأخر من القديم يُهمَل', async () => {
  const m = mk(); const p = await approvedPair({});
  const v1 = await ready(m, 'F1', { heads: [p.head], valuations: [p.doc] });
  assert.equal(v1.status, 'ready'); assert.equal(v1.approved.kind, 'effective');
  const old = m.fake.subs.slice(0, 3);
  m.box.set({ uid: 'u2', email: 'other@example.com' }); m.r.sync();
  assert.ok(old.every((s) => !s.active));
  const v2 = m.r.getView();
  assert.equal(v2.status, 'loading'); assert.deepEqual(v2.dates, []); assert.equal(v2.approved.kind, 'none');
  old[0].onNext({ docs: [p.head], fromCache: false }); old[1].onNext({ docs: [p.doc], fromCache: false }); old[2].onNext({ docs: [], fromCache: false }); await tick();
  assert.equal(m.r.getView().status, 'loading', 'رد متأخر من الجلسة السابقة لا أثر له'); assert.deepEqual(m.r.getView().dates, []); assert.equal(m.r.stats().heldDocs, 0);
  assert.equal(m.fake.live().length, 3);
});
await t('3ب. فقد دور القراءة ⇒ إلغاء ومسح فوريان وبلا لوحة', async () => {
  const m = mk(); const p = await approvedPair({});
  await ready(m, 'F1', { heads: [p.head], valuations: [p.doc] });
  m.box.set({ role: 'analyst' }); m.r.sync();
  assert.equal(m.fake.live().length, 0); assert.equal(m.r.getView().status, 'forbidden'); assert.deepEqual(m.r.getView().dates, []);
  assert.equal(m.r.stats().heldDocs, 0, 'الذاكرة ممسوحة وليس مخفية فقط'); assert.equal(m.r.stats().heldVerifications, 0);
});
await t('3ج. قارئ→قارئ آخر (fund_manager→senior_ic): جلسة جديدة، مسح، إعادة اشتراك', async () => {
  const m = mk(); const p = await approvedPair({});
  await ready(m, 'F1', { heads: [p.head], valuations: [p.doc] });
  m.box.set({ role: 'senior_ic' }); m.r.sync();
  assert.equal(m.r.getView().status, 'loading'); assert.equal(m.r.stats().subscribed, 6); assert.equal(m.fake.live().length, 3);
});
await t('3د. reset() (نهاية الجلسة): إلغاء ومسح وإلغاء الصندوق المطلوب فلا إعادة اشتراك تلقائية', async () => {
  const m = mk(); m.r.open('F1'); m.r.reset(); m.r.sync();
  assert.equal(m.fake.live().length, 0); assert.equal(m.r.wanted(), null); assert.equal(m.r.stats().heldDocs, 0);
});
await t('3هـ. تسجيل الخروج (لا جلسة) بعد بيانات ⇒ مسح كامل', async () => {
  const m = mk(); const p = await approvedPair({});
  await ready(m, 'F1', { heads: [p.head], valuations: [p.doc] });
  m.box.set({ uid: null, email: null, roleResolved: false }); m.r.sync();
  assert.equal(m.fake.live().length, 0); assert.deepEqual(m.r.getView().dates, []); assert.equal(m.r.stats().heldDocs, 0);
});

/* 4. التحميل والتأكيد */
await t('4. التحميل لا ينتهي بلقطة ذاكرة محلية ولا بلقطة مؤكدة واحدة من ثلاث', async () => {
  const m = mk(); m.r.open('F1');
  m.fake.emitAll('F1', {}, true); assert.equal(m.r.getView().status, 'loading');
  m.fake.emit('heads', 'F1', [], false); assert.equal(m.r.getView().status, 'loading');
  m.fake.emit('valuations', 'F1', [], false); assert.equal(m.r.getView().status, 'loading');
  m.fake.emit('events', 'F1', [], false); assert.equal(m.r.getView().status, 'empty');
});
await t('4ب. عودة مصدر مؤكَّد إلى fromCache ⇒ قديم فورًا (دون انتظار)، ويُمسح عند التأكيد من جديد', async () => {
  const m = mk(); const p = await approvedPair({});
  await ready(m, 'F1', { heads: [p.head], valuations: [p.doc] });
  assert.equal(m.r.getView().stale, false);
  m.fake.emit('heads', 'F1', [p.head], true);
  const v = m.r.getView(); assert.equal(v.stale, true); assert.equal(v.sources.heads, 'stale'); assert.equal(v.status, 'ready');
  m.fake.emit('heads', 'F1', [p.head], false); assert.equal(m.r.getView().stale, false);
});
await t('4ج. empty ≠ ready ≠ loading', async () => {
  const m = mk(); m.r.open('F1'); m.fake.emitAll('F1', {});
  assert.equal(m.r.getView().status, 'empty');
  const p = await approvedPair({}); m.fake.emitAll('F1', { heads: [p.head], valuations: [p.doc] }); assert.equal(m.r.getView().status, 'ready');
});

/* 5. الأخطاء */
await t('5. permission-denied ⇒ denied: إيقاف كل المستمعات ومسح البيانات وبلا إعادة اشتراك تلقائية؛ retry = مجموعة واحدة', async () => {
  const m = mk(); const p = await approvedPair({});
  await ready(m, 'F1', { heads: [p.head], valuations: [p.doc] });
  m.fake.fail('valuations', 'F1', { code: 'permission-denied' });
  assert.equal(m.r.getView().status, 'denied'); assert.equal(m.fake.live().length, 0); assert.deepEqual(m.r.getView().dates, []); assert.equal(m.r.stats().heldDocs, 0);
  for (let i = 0; i < 5; i += 1) { m.r.open('F1'); m.r.sync(); }
  assert.equal(m.r.stats().subscribed, 3, 'لا إعادة اشتراك تلقائية');
  m.r.retry(); assert.equal(m.fake.live().length, 3); assert.equal(m.r.stats().subscribed, 6);
  m.r.retry(); assert.equal(m.r.stats().subscribed, 9); assert.equal(m.fake.live().length, 3);
});
await t('5ب. خطأ قبل أي تأكيد ⇒ error؛ خطأ بعد تأكيد ⇒ بيانات قديمة مُعلَّمة', async () => {
  const m = mk(); m.r.open('F1'); m.fake.fail('heads', 'F1', { code: 'unavailable' });
  assert.equal(m.r.getView().status, 'error'); assert.equal(m.r.getView().errors[0].code, 'unavailable');
  const m2 = mk(); const p = await approvedPair({});
  await ready(m2, 'F1', { heads: [p.head], valuations: [p.doc] });
  m2.fake.fail('events', 'F1', { code: 'unavailable' });
  const v = m2.r.getView(); assert.equal(v.status, 'ready'); assert.equal(v.stale, true);
});
await t('5ج. اشتراك يرمي استثناءً ⇒ حالة خطأ لا انهيار', async () => {
  const r = createFundValuationReader({ subscribe: () => { throw new Error('boom'); }, getSession: () => SESSION_FM });
  r.open('F1'); assert.equal(r.getView().status, 'error');
});

/* 6. التاريخ */
await t('6. الافتراضي: أحدث رأس معتمد حتى لو معلّق، دون الرجوع لأقدم ساري', async () => {
  const m = mk();
  const old = await approvedPair({ date: '2026-09-01', valuationId: 'V0' });
  const susp = await approvedPair({ date: '2026-10-01', valuationId: 'V1', eligibility: { state: 'SUSPENDED', changedBy: 'x@x.com', changedAt: '2026-10-02T00:00:00Z', reasonCode: 'SUSPENDED', reason: 'review' } });
  const v = await ready(m, 'F1', { heads: [old.head, susp.head], valuations: [old.doc, susp.doc] });
  assert.equal(v.selectedDate, '2026-10-01'); assert.equal(v.selection, 'default-head');
  assert.equal(v.approved.kind, 'suspended'); assert.equal(v.approved.doc, undefined);
});
await t('6ب. لا رأس معتمد ⇒ أحدث تقييم وحالته صريحة (latestValuation) دون ادعاء أنه ساري', async () => {
  const m = mk(); const d1 = draftDoc({ date: '2026-10-02', valuationId: 'D1', state: 'submitted' });
  const v = await ready(m, 'F1', { heads: [headOnlyDraft({ activeDraftId: 'D1' })], valuations: [d1] });
  assert.equal(v.selection, 'default-valuation'); assert.equal(v.selectedDate, '2026-10-02'); assert.equal(v.approved.kind, 'none');
  assert.equal(v.draft.doc.state, 'submitted');
  const m2 = mk(); const v2 = await ready(m2, 'F1', { valuations: [draftDoc({ date: '2026-10-03', valuationId: 'X', state: 'returned' })] });
  assert.equal(v2.latestValuation.doc.state, 'returned'); assert.equal(v2.approved.kind, 'none');
});
await t('6ج. اختيار المستخدم لا يتغير عند وصول تحديثات (ولو ظهر تاريخ أحدث)، ويُرفض تاريخ غير موجود/غير صالح', async () => {
  const m = mk(); const a = await approvedPair({ date: '2026-09-01', valuationId: 'V0' }); const b = await approvedPair({ date: '2026-10-01', valuationId: 'V1' });
  await ready(m, 'F1', { heads: [a.head, b.head], valuations: [a.doc, b.doc] });
  assert.equal(m.r.selectDate('2026-09-01'), true); await tick();
  assert.equal(m.r.getView().selectedDate, '2026-09-01');
  const c = await approvedPair({ date: '2026-10-05', valuationId: 'V2' });
  m.fake.emitAll('F1', { heads: [a.head, b.head, c.head], valuations: [a.doc, b.doc, c.doc] }); await tick();
  const v = m.r.getView(); assert.equal(v.selectedDate, '2026-09-01'); assert.equal(v.selection, 'user'); assert.equal(v.dates[0], '2026-10-05');
  assert.equal(m.r.selectDate('2030-01-01'), false); assert.equal(m.r.selectDate('<x>'), false); assert.equal(m.r.selectDate('2026-02-30'), false);
  assert.equal(m.r.getView().selectedDate, '2026-09-01');
  m.r.open('F2'); m.fake.emitAll('F2', { heads: [], valuations: [] }); assert.equal(m.r.getView().selection, 'none', 'الاختيار لا يمتد إلى صندوق آخر');
});

/* 7. التحقق من البصمة */
await t('7. اتساق + ELIGIBLE ⇒ effective بقيمة؛ أثناء التحقق لا قيمة', async () => {
  const g = gated(); const m = mk({ verify: g.fn }); const p = await approvedPair({});
  m.r.open('F1'); m.fake.emitAll('F1', { heads: [p.head], valuations: [p.doc] }); await tick();
  assert.equal(m.r.getView().approved.kind, 'verifying'); assert.equal(m.r.getView().approved.doc, undefined);
  g.release(0); await tick(); const v = m.r.getView();
  assert.equal(v.approved.kind, 'effective'); assert.equal(v.approved.doc.residualValue, 1000);
});
await t('7ب. تعديل أي حقل من الأربعة ⇒ inconsistent بلا قيمة (بصمة حقيقية)', async () => {
  const cases = {
    contentHash: (p) => { p.doc.data.contentHash = 'TAMPERED'; }, approvedBy: (p) => { p.doc.data.approvedBy = 'evil@x.com'; },
    version: (p) => { p.doc.data.version = 2; p.head.data.version = 2; }, headId: (p) => { p.head.data.headId = 'V9'; p.doc.data.valuationId = 'V9'; p.doc.id = 'V9'; },
  };
  for (const [k, tamper] of Object.entries(cases)) {
    const m = mk(); const p = await approvedPair({}); tamper(p);
    const v = await ready(m, 'F1', { heads: [p.head], valuations: [p.doc] });
    assert.equal(v.approved.kind, 'inconsistent', k); assert.equal(v.approved.doc, undefined, k);
  }
});
await t('7ج. وثيقة المعتمد مفقودة ⇒ inconsistent (HEAD_DOC_MISSING) ولا رجوع لإصدار أقدم ولو موجود', async () => {
  const m = mk(); const old = await approvedPair({ date: '2026-09-01', valuationId: 'V0' }); const cur = await approvedPair({ date: '2026-10-01', valuationId: 'V1' });
  const v = await ready(m, 'F1', { heads: [old.head, cur.head], valuations: [old.doc] });
  assert.equal(v.selectedDate, '2026-10-01'); assert.equal(v.approved.kind, 'inconsistent'); assert.equal(v.approved.reason, 'HEAD_DOC_MISSING'); assert.equal(v.approved.doc, undefined);
});
await t('7د. معلّق ⇒ لا قيمة؛ أهلية مفقودة ⇒ eligibility-unknown؛ verify يرمي ⇒ HEAD_UNVERIFIABLE', async () => {
  const m = mk(); const s = await approvedPair({ eligibility: { state: 'SUSPENDED', changedBy: 'x@x.com', changedAt: 't', reasonCode: 'SUSPENDED', reason: 'r' } });
  assert.equal((await ready(m, 'F1', { heads: [s.head], valuations: [s.doc] })).approved.kind, 'suspended');
  const m2 = mk(); const u = await approvedPair({ eligibility: null });
  assert.equal((await ready(m2, 'F1', { heads: [u.head], valuations: [u.doc] })).approved.kind, 'eligibility-unknown');
  const m3 = mk({ verify: async () => { throw new Error('no crypto'); } }); const p = await approvedPair({});
  const v3 = await ready(m3, 'F1', { heads: [p.head], valuations: [p.doc] });
  assert.equal(v3.approved.kind, 'inconsistent'); assert.equal(v3.approved.reason, 'HEAD_UNVERIFIABLE');
});
await t('7هـ. تحديث مؤقت لمصدر واحد (الرأس يسبق التقييمات) ⇒ لا نجاح تحقق ولا قيمة؛ ثم عند وصول الوثيقة يُعاد التحقق', async () => {
  const g = gated(); const m = mk({ verify: g.fn }); const v1p = await approvedPair({ valuationId: 'V1' }); const v2p = await approvedPair({ valuationId: 'V2', version: 2, contentHash: 'CH-2' });
  m.r.open('F1'); m.fake.emitAll('F1', { heads: [v1p.head], valuations: [v1p.doc] }); await tick(); g.release(0); await tick();
  assert.equal(m.r.getView().approved.kind, 'effective');
  m.fake.emit('heads', 'F1', [v2p.head]); await tick();           // الرأس الجديد وصل قبل وثيقته
  const mid = m.r.getView(); assert.equal(mid.approved.kind, 'inconsistent'); assert.equal(mid.approved.reason, 'HEAD_DOC_MISSING'); assert.equal(g.pend.length, 1);
  m.fake.emit('valuations', 'F1', [v1p.doc, v2p.doc]); await tick();
  assert.equal(g.pend.length, 2); assert.equal(m.r.getView().approved.kind, 'verifying');
  g.release(1); await tick(); assert.equal(m.r.getView().approved.doc.residualValue, 1000); assert.equal(m.r.getView().approved.version, 2);
});

/* 8. تبدّل السياق أثناء انتظار التجزئة */
await t('8أ. تبديل الصندوق أثناء التجزئة ⇒ نتيجة الأول لا تظهر للثاني ولا تُطلق إعادة رسم', async () => {
  const g = gated(); const m = mk({ verify: g.fn }); const a = await approvedPair({ fundId: 'F1', valuationId: 'VA' }); const b = await approvedPair({ fundId: 'F2', valuationId: 'VB' });
  m.r.open('F1'); m.fake.emitAll('F1', { heads: [a.head], valuations: [a.doc] }); await tick();
  m.r.open('F2'); m.fake.emitAll('F2', { heads: [b.head], valuations: [b.doc] }); await tick();
  assert.equal(g.pend.length, 2); const before = m.changes();
  g.release(0); await tick();
  assert.equal(m.r.getView().fundId, 'F2'); assert.equal(m.r.getView().approved.kind, 'verifying'); assert.equal(m.changes(), before);
  g.release(1); await tick(); assert.equal(m.r.getView().approved.kind, 'effective');
});
await t('8ب. تغيير التاريخ أثناء التجزئة ⇒ نتيجة التاريخ السابق لا تُعرض للتاريخ الجديد', async () => {
  const g = gated(); const m = mk({ verify: g.fn }); const a = await approvedPair({ date: '2026-09-01', valuationId: 'V0' }); const b = await approvedPair({ date: '2026-10-01', valuationId: 'V1' });
  m.r.open('F1'); m.fake.emitAll('F1', { heads: [a.head, b.head], valuations: [a.doc, b.doc] }); await tick();
  m.r.selectDate('2026-09-01'); await tick(); assert.equal(g.pend.length, 2);
  g.release(0); await tick();                                       // نتيجة 2026-10-01 تصل أولًا
  assert.equal(m.r.getView().selectedDate, '2026-09-01'); assert.equal(m.r.getView().approved.kind, 'verifying');
  g.release(1); await tick(); assert.equal(m.r.getView().approved.kind, 'effective');
});
await t('8ج. تبديل المستخدم أثناء التجزئة ⇒ لا تظهر نتيجة المستخدم السابق', async () => {
  const g = gated(); const m = mk({ verify: g.fn }); const a = await approvedPair({});
  m.r.open('F1'); m.fake.emitAll('F1', { heads: [a.head], valuations: [a.doc] }); await tick();
  m.box.set({ uid: 'u2', email: 'other@example.com' }); m.r.sync(); await tick(); const before = m.changes();
  g.release(0); await tick();
  assert.equal(m.r.getView().status, 'loading'); assert.deepEqual(m.r.getView().dates, []); assert.equal(m.changes(), before);
});
await t('8د. إغلاق الصندوق ثم إعادة فتحه أثناء التجزئة ⇒ نتيجة الجلسة المغلقة تُهمَل', async () => {
  const g = gated(); const m = mk({ verify: g.fn }); const a = await approvedPair({});
  m.r.open('F1'); m.fake.emitAll('F1', { heads: [a.head], valuations: [a.doc] }); await tick();
  m.r.close(); m.r.open('F1'); m.fake.emitAll('F1', { heads: [a.head], valuations: [a.doc] }); await tick(); assert.equal(g.pend.length, 2);
  g.release(0); await tick(); assert.equal(m.r.getView().approved.kind, 'verifying');
  g.release(1); await tick(); assert.equal(m.r.getView().approved.kind, 'effective');
});
await t('8هـ. استبدال الرأس أثناء التجزئة (بصمة جديدة) ⇒ النتيجة القديمة لا تُمرّر البيانات الجديدة', async () => {
  const g = gated(); const m = mk({ verify: g.fn }); const a = await approvedPair({}); const a2 = await approvedPair({ contentHash: 'CH-NEW' });
  m.r.open('F1'); m.fake.emitAll('F1', { heads: [a.head], valuations: [a.doc] }); await tick();
  m.fake.emitAll('F1', { heads: [a2.head], valuations: [a2.doc] }); await tick();
  assert.equal(g.pend.length, 3, 'رأس جديد+وثيقة قديمة (مؤقت) ثم رأس جديد+وثيقة جديدة');
  g.release(0, true); await tick(); assert.equal(m.r.getView().approved.kind, 'verifying', 'نجاح البيانات القديمة لا يُعرض للجديدة');
  g.release(1, false, 'HEAD_HASH_MISMATCH'); await tick(); assert.equal(m.r.getView().approved.kind, 'verifying', 'نتيجة المزيج المؤقت لا تُعرض للبيانات النهائية');
  g.release(2, false, 'HEAD_HASH_MISMATCH'); await tick(); assert.equal(m.r.getView().approved.kind, 'inconsistent');
});
await t('8و. رفض الصلاحية أثناء التجزئة ⇒ لا تظهر نتيجة بعد denied', async () => {
  const g = gated(); const m = mk({ verify: g.fn }); const a = await approvedPair({});
  m.r.open('F1'); m.fake.emitAll('F1', { heads: [a.head], valuations: [a.doc] }); await tick();
  m.fake.fail('heads', 'F1', { code: 'permission-denied' }); g.release(0); await tick();
  assert.equal(m.r.getView().status, 'denied'); assert.equal(m.r.getView().approved.kind, 'none');
});

/* 9. السجل */
await t('9. السجل: آخر 50 للعرض فقط والإجمالي كامل؛ «عرض الكل» يعرض كل شيء؛ الاستعلام لا يحمل limit', async () => {
  const m = mk(); const evs = Array.from({ length: 120 }, (_, i) => event(i + 1));
  const p = await approvedPair({});
  m.r.open('F1'); m.fake.emitAll('F1', { heads: [p.head], valuations: [p.doc], events: evs.slice().reverse() }); await tick();
  let e = m.r.getView().events; assert.equal(EVENTS_DISPLAY_LIMIT, 50);
  assert.equal(e.total, 120); assert.equal(e.shown, 50); assert.equal(e.rows[0].id, 'E0120'); assert.equal(e.rows[49].id, 'E0071'); assert.equal(e.open, false);
  m.r.toggleLog(); m.r.toggleShowAll(); e = m.r.getView().events; assert.equal(e.shown, 120); assert.equal(e.open, true);
  assert.ok(m.fake.subs.every((s) => s.fundId === 'F1'));
});
await t('9ب. أحداث صندوق آخر أو بلا fundId لا تظهر', async () => {
  const m = mk(); const p = await approvedPair({});
  m.r.open('F1'); m.fake.emitAll('F1', { heads: [p.head], valuations: [p.doc], events: [event(1), event(2, { fundId: 'OTHER' }), { id: 'Z', data: { at: 'x' } }] });
  assert.equal(m.r.getView().events.total, 1);
});

/* 10. حدود القارئ */
await t('10. القارئ لا يعرض أي واجهة كتابة، وبياناته المعادة نسخ مستقلة', async () => {
  const m = mk(); assert.deepEqual(Object.keys(m.r).sort(), ['close', 'contextFor', 'getView', 'open', 'refresh', 'reset', 'retry', 'selectDate', 'stats', 'sync', 'toggleLog', 'toggleShowAll', 'wanted']);
  const p = await approvedPair({}); const v = await ready(m, 'F1', { heads: [p.head], valuations: [p.doc] });
  v.approved.doc.residualValue = 1; v.approved.doc.components.assetsValue = 1;
  assert.equal(m.r.getView().approved.doc.residualValue, 1000); assert.equal(m.r.getView().approved.doc.components.assetsValue, 900);
  p.doc.data.residualValue = 7; await tick(); assert.equal(m.r.getView().approved.doc.residualValue, 1000, 'نسخة مستقلة عن لقطة المستمع');
});
await t('10ب. وثائق غير متسقة المعرّف/التاريخ تُستبعد وتُحصى', async () => {
  const m = mk(); const p = await approvedPair({}); const bad = { id: 'BAD', data: { ...p.doc.data, valuationId: 'OTHER' } };
  const badDate = { id: 'BD', data: { ...p.doc.data, valuationId: 'BD', valuationDate: '2026-13-45' } };
  const v = await ready(m, 'F1', { heads: [p.head], valuations: [p.doc, bad, badDate] });
  assert.equal(v.excluded, 2); assert.deepEqual(v.dates, ['2026-10-01']);
});
await t('10ج. القارئ والمنفذ لا يستوردان requests ولا XIRR ولا Firebase', async () => {
  const src = fs.readFileSync(new URL('../../src/features/fund-valuation-reader.js', import.meta.url), 'utf8');
  const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
  assert.ok(!/requests|xirr|firebase|portfolio/i.test(imports), imports);
  assert.ok(!/httpsCallable|localStorage|indexedDB|\.collection\(/.test(src));
});

/* 11. اللقطات القديمة: آخر لقطة مؤكدة محفوظة منفصلة عن لقطات الذاكرة */
await t('11أ. قيمة مؤكدة 1000 ثم لقطة ذاكرة بـ9999 ⇒ تبقى 1000 مع علامة قِدَم؛ وعند عودة تأكيد الخادم تتحدّث وتزول العلامة', async () => {
  const m = mk(); const p = await approvedPair({});
  let v = await ready(m, 'F1', { heads: [p.head], valuations: [p.doc] });
  assert.equal(v.approved.doc.residualValue, 1000); assert.equal(v.stale, false);
  const cached = { id: p.doc.id, data: { ...p.doc.data, residualValue: 9999 } };
  m.fake.emit('valuations', 'F1', [cached], true); await tick();
  v = m.r.getView(); assert.equal(v.stale, true); assert.equal(v.sources.valuations, 'stale');
  assert.equal(v.approved.doc.residualValue, 1000, 'محتوى الذاكرة لا يستبدل المؤكَّد');
  const fresh = { id: p.doc.id, data: { ...p.doc.data, residualValue: 2000 } };
  m.fake.emit('valuations', 'F1', [fresh], false); await tick();
  v = m.r.getView(); assert.equal(v.stale, false); assert.equal(v.approved.doc.residualValue, 2000);
});
await t('11ب. لقطة ذاكرة فارغة بعد بيانات مؤكدة ⇒ البيانات تبقى (ready) مع قِدَم، لا تتحول إلى empty', async () => {
  const m = mk(); const p = await approvedPair({});
  await ready(m, 'F1', { heads: [p.head], valuations: [p.doc], events: [event(1)] });
  m.fake.emitAll('F1', {}, true); await tick();
  let v = m.r.getView(); assert.equal(v.status, 'ready'); assert.equal(v.stale, true); assert.deepEqual(v.dates, ['2026-10-01']); assert.equal(v.approved.kind, 'effective'); assert.equal(v.events.total, 1);
  m.fake.emitAll('F1', { heads: [p.head], valuations: [p.doc], events: [event(1)] }, false); await tick();
  v = m.r.getView(); assert.equal(v.stale, false); assert.equal(v.status, 'ready');
});
await t('11ج. حالة فارغة مؤكدة ثم فقد الاتصال (fromCache/خطأ مستمع) ⇒ تبقى فارغة لكن بقِدَم؛ ولقطة ذاكرة بوثيقة لا تُظهرها؛ عودة التأكيد تحدّث وتزيل التحذير', async () => {
  const m = mk(); m.r.open('F1'); m.fake.emitAll('F1', {});
  let v = m.r.getView(); assert.equal(v.status, 'empty'); assert.equal(v.stale, false);
  const p = await approvedPair({});
  m.fake.emit('heads', 'F1', [p.head], true); m.fake.emit('valuations', 'F1', [p.doc], true); await tick();
  v = m.r.getView(); assert.equal(v.status, 'empty', 'لقطة الذاكرة لا تغيّر ما أُكِّد'); assert.equal(v.stale, true); assert.deepEqual(v.dates, []);
  m.fake.emit('heads', 'F1', [], false); m.fake.emit('valuations', 'F1', [], false); assert.equal(m.r.getView().stale, false);
  m.fake.fail('events', 'F1', { code: 'unavailable' });
  v = m.r.getView(); assert.equal(v.status, 'empty'); assert.equal(v.stale, true);
  m.r.retry(); m.fake.emitAll('F1', { heads: [p.head], valuations: [p.doc] }); await tick();
  v = m.r.getView(); assert.equal(v.status, 'ready'); assert.equal(v.stale, false);
});
await t('11د. قبل أول تأكيد: لقطة ذاكرة بوثائق تبقى «تحميل» بلا أي قيم أو تواريخ أو وثائق محتفَظ بها', async () => {
  const m = mk(); const p = await approvedPair({}); m.r.open('F1');
  m.fake.emitAll('F1', { heads: [p.head], valuations: [p.doc], events: [event(1)] }, true); await tick();
  const v = m.r.getView(); assert.equal(v.status, 'loading'); assert.deepEqual(v.dates, []); assert.equal(v.approved.kind, 'none'); assert.equal(m.r.stats().heldDocs, 0);
});

if (failed) { console.error(`reader tests: ${passed} passed, ${failed} FAILED`); process.exit(1); }
console.log(`reader tests: ${passed} passed`);
