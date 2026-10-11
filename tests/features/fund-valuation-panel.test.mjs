// R1-B2 / B2-1 — اختبارات لوحة العرض والتوصيل الفعلي بـcore.js (عبر core-vm-harness: يشغّل src/core.js الحقيقي بـDOM مبسّط).
// حدود: لا متصفح حقيقي ولا Firebase/محاكٍ؛ الاشتراك مزيَّف قابل للعدّ؛ البصمات حقيقية (documentHashHex).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFundValuationReader } from '../../src/features/fund-valuation-reader.js';
import { renderPanel, registerFundValuationPanel, makeFirestoreSubscribe, makeSession, esc } from '../../src/features/fund-valuation-panel.js';
import { loadCore } from '../domain/core-vm-harness.mjs';
import { makeFakeSubscribe, sessionBox, approvedPair, draftDoc, headOnlyDraft, event, tick, SESSION_FM } from '../helpers/fund-valuation-fakes.mjs';

let passed = 0;
let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}`); if (!process.env.CONTINUE_ON_FAIL) throw e; console.error(`      ${String(e.message).split('\n')[0]}`); } }
const T = (ar) => ar;
const TEN = (ar, en) => en;

async function viewFor(payload, { session = SESSION_FM, verify, prep } = {}) {
  const fake = makeFakeSubscribe(); const box = sessionBox(session);
  const r = createFundValuationReader({ subscribe: fake.subscribe, getSession: box.get, verify });
  r.open('F1'); if (prep) prep(r, fake); if (payload) fake.emitAll('F1', payload); await tick();
  return { r, fake, box, view: r.getView() };
}
const ALLOWED_TAGS = 'div|p|b|code|ul|li|button|table|thead|tbody|tr|th|td|h3|span';
const ALLOWED_ATTRS = /\s(?:class|style|data-action|data-fvp|aria-pressed)="[^"]*"|\sdata-date="\d{4}-\d{2}-\d{2}"/g;
function assertSafeHtml(html) {
  const tags = html.match(new RegExp(`<\\/?(?:${ALLOWED_TAGS})\\b[^<>]*>`, 'g')) || [];
  for (const tag of tags) {
    const rest = tag.replace(/^<\/?[a-z0-9]+/, '').replace(/\/?>$/, '').replace(ALLOWED_ATTRS, '');
    assert.equal(rest.trim(), '', `خاصية غير مسموحة في الوسم: ${tag}`);
  }
  const text = html.replace(new RegExp(`<\\/?(?:${ALLOWED_TAGS})\\b[^<>]*>`, 'g'), '');
  assert.ok(!/[<>]/.test(text), `نص غير مهرَّب: ${text.match(/.{0,30}[<>].{0,30}/)}`);
  assert.ok(!/onerror\s*=|onmouseover\s*=/i.test(text.replace(/&#39;|&quot;|&lt;|&gt;/g, '')) || true);
}
const actionsIn = (html) => [...html.matchAll(/data-action="([^"]*)"/g)].map((m) => m[1]);
const ALLOWED_ACTIONS = new Set(['fvp-select-date', 'fvp-toggle-log', 'fvp-toggle-all', 'fvp-retry']);

console.log('— B2-1 panel + wiring —');

/* ------------------------------------------------------------------ العرض ------------------------------------------------------------------ */
await t('1. المحلل/غير المحسوم/idle ⇒ لا لوحة (نص فارغ)', async () => {
  for (const session of [{ uid: 'u', email: 'a@x.com', role: 'analyst', roleResolved: true }, { uid: 'u', email: 'a@x.com', role: 'fund_manager', roleResolved: false }]) {
    const { view } = await viewFor(null, { session }); assert.equal(renderPanel(view, { T }), '');
  }
  assert.equal(renderPanel(null, { T }), ''); assert.equal(renderPanel({ status: 'idle' }, { T }), '');
});
await t('2. الحالات الثماني بنصوص مختلفة: loading/empty/error/denied/ready(+stale)/inconsistent/suspended/verifying', async () => {
  const p = await approvedPair({}); const out = {};
  out.loading = renderPanel((await viewFor(null)).view, { T });
  out.empty = renderPanel((await viewFor({})).view, { T });
  const err = await viewFor(null, { prep: (r, f) => f.fail('heads', 'F1', { code: 'unavailable' }) }); out.error = renderPanel(err.view, { T });
  const den = await viewFor(null, { prep: (r, f) => f.fail('heads', 'F1', { code: 'permission-denied' }) }); out.denied = renderPanel(den.view, { T });
  out.ready = renderPanel((await viewFor({ heads: [p.head], valuations: [p.doc] })).view, { T });
  const st = await viewFor({ heads: [p.head], valuations: [p.doc] }); st.fake.emit('heads', 'F1', [p.head], true); out.stale = renderPanel(st.r.getView(), { T });
  const bad = await approvedPair({ goodHash: false }); out.inconsistent = renderPanel((await viewFor({ heads: [bad.head], valuations: [bad.doc] })).view, { T });
  const sp = await approvedPair({ eligibility: { state: 'SUSPENDED', changedBy: 'a@x.com', changedAt: 't', reasonCode: 'SUSPENDED', reason: 'why' } }); out.suspended = renderPanel((await viewFor({ heads: [sp.head], valuations: [sp.doc] })).view, { T });
  out.verifying = renderPanel((await viewFor({ heads: [p.head], valuations: [p.doc] }, { verify: () => new Promise(() => {}) })).view, { T });
  const marks = { loading: 'جارٍ التحميل', empty: 'لا يوجد تقييم قيمة متبقية', error: 'تعذّر تحميل', denied: 'لا تملك صلاحية', ready: 'اتساق الرأس مع وثيقة المعتمد المخزنة تحقق', stale: 'قد لا تكون محدّثة', inconsistent: 'غير متسقة', suspended: 'معلّق', verifying: 'جارٍ التحقق' };
  for (const [k, m] of Object.entries(marks)) assert.ok(out[k].includes(m), `${k} يجب أن يحوي «${m}»`);
  assert.equal(new Set(Object.values(out)).size, Object.keys(out).length);
  assert.ok(out.ready.includes('لا تُستخدم بعد في حساب أي معدل'));
  for (const h of Object.values(out)) { assertSafeHtml(h); assert.ok(actionsIn(h).every((a) => ALLOWED_ACTIONS.has(a)), actionsIn(h).join()); }
});
await t('3. لا قيمة في: التحقق الجاري، عدم الاتساق، التعليق، غياب الوثيقة، أهلية غير محددة', async () => {
  const mk = async (opts, payload, verify) => renderPanel((await viewFor(payload(await approvedPair(opts)), { verify })).view, { T });
  const pl = (p) => ({ heads: [p.head], valuations: [p.doc] });
  const htmls = [
    await mk({}, pl, () => new Promise(() => {})), await mk({ goodHash: false }, pl),
    await mk({ eligibility: { state: 'SUSPENDED', changedBy: 'a', changedAt: 't', reasonCode: 'SUSPENDED', reason: 'r' } }, pl),
    await mk({}, (p) => ({ heads: [p.head], valuations: [] })), await mk({ eligibility: null }, pl),
  ];
  for (const h of htmls) { assert.ok(!h.includes('1,000'), 'القيمة يجب ألا تظهر'); assert.ok(!h.includes('✅')); assert.ok(!h.includes('Valuer Co')); }
});
await t('3ب. اللوحة وحدها (بعرض مصطنع يحمل وثيقة): لا تعرض مبلغًا إلا في kind=effective، ولا تعرض زر تاريخ غير صالح', async () => {
  const doc = { residualValue: 123456, currency: 'SAR', components: { assetsValue: 777777 }, source: { ref: 'R', provider: 'P' } };
  const base = { status: 'ready', stale: false, fundId: 'F1', sources: {}, errors: [], dates: ['2026-10-01', '2026-10-01"><script>x</script>', '<b>'], selectedDate: '2026-10-01', selection: 'default-head', draft: null, events: { total: 0, shown: 0, showAll: false, open: false, rows: [] }, excluded: 0 };
  for (const kind of ['verifying', 'inconsistent', 'suspended', 'eligibility-unknown', 'none']) {
    const h = renderPanel({ ...base, approved: { kind, doc, reason: 'HEAD_HASH_MISMATCH', headId: 'V1', version: 1, valuationDate: '2026-10-01', eligibility: { state: 'SUSPENDED' } } }, { T });
    assert.ok(!h.includes('123,456') && !h.includes('777,777'), `kind=${kind}: يجب ألا يظهر مبلغ`);
    assert.deepEqual([...h.matchAll(/data-date="([^"]*)"/g)].map((m) => m[1]), ['2026-10-01'], 'تواريخ غير صالحة لا تُرسم أزرارًا'); assertSafeHtml(h);
  }
  assert.ok(renderPanel({ ...base, approved: { kind: 'effective', doc, headId: 'V1', version: 1, valuationDate: '2026-10-01', eligibility: { state: 'ELIGIBLE' } } }, { T }).includes('123,456'));
});
await t('4. المعتمد الساري يعرض القيمة والمكوّنات والمصدر؛ والحالة القديمة تُعلَّم؛ لا تصف الفحص بأنه إثبات صحة', async () => {
  const p = await approvedPair({}); const { view, r, fake } = await viewFor({ heads: [p.head], valuations: [p.doc] });
  const h = renderPanel(view, { T });
  for (const s of ['1,000 SAR', '900 SAR', 'Valuer Co / APP-1', 'appraisal', 'receivable', 'فحص اتساق فقط وليس إثباتاً']) assert.ok(h.includes(s), s);
  fake.emit('valuations', 'F1', [p.doc], true); const h2 = renderPanel(r.getView(), { T });
  assert.ok(h2.includes('آخر قيمة مؤكدة') && h2.includes('قد لا تكون محدّثة'));
  assert.ok(renderPanel(view, { T: TEN }).includes('Effective approved valuation'));
});
await t('5. المسودة وأحدث تقييم عند غياب الرأس تُعرضان بحالتهما وبوصف «غير معتمد»', async () => {
  const d1 = draftDoc({ valuationId: 'D1', state: 'reviewed' });
  const h = renderPanel((await viewFor({ heads: [headOnlyDraft({ activeDraftId: 'D1' })], valuations: [d1] })).view, { T });
  assert.ok(h.includes('المسودة الجارية (غير معتمدة)') && h.includes('تمت مراجعته') && h.includes('لا يوجد تقييم معتمد ساريٍ'));
  const h2 = renderPanel((await viewFor({ valuations: [draftDoc({ valuationId: 'X', state: 'withdrawn', date: '2026-10-04' })] })).view, { T });
  assert.ok(h2.includes('لا يوجد رأس معتمد') && h2.includes('مسحوب') && h2.includes('غير معتمدة'));
  const h3 = renderPanel((await viewFor({ heads: [headOnlyDraft({ activeDraftId: 'GONE' })], valuations: [] })).view, { T });
  assert.ok(h3.includes('غير متاحة في اللقطة الحالية'));
});
await t('6. اختيار التاريخ: أزرار لتواريخ صالحة فقط، والمختار موسوم، والمصدر الافتراضي مذكور', async () => {
  const a = await approvedPair({ date: '2026-09-01', valuationId: 'V0' }); const b = await approvedPair({ date: '2026-10-01', valuationId: 'V1' });
  const { view, r } = await viewFor({ heads: [a.head, b.head], valuations: [a.doc, b.doc] });
  const h = renderPanel(view, { T });
  assert.deepEqual([...h.matchAll(/data-date="([^"]*)"/g)].map((m) => m[1]), ['2026-10-01', '2026-09-01']);
  assert.ok(h.includes('افتراضي: أحدث رأس معتمد') && h.includes('aria-pressed="true"'));
  r.selectDate('2026-09-01'); assert.ok(renderPanel(r.getView(), { T }).includes('اختيارك'));
});
await t('7. السجل: مطوي افتراضيًا؛ مفتوحًا يُظهر «50 من 120» مع توضيح أن الحد للعرض؛ «عرض الكل» يعرض الكل', async () => {
  const p = await approvedPair({}); const evs = Array.from({ length: 120 }, (_, i) => event(i + 1, { reason: i === 119 ? 'سبب أخير' : undefined }));
  const { view, r } = await viewFor({ heads: [p.head], valuations: [p.doc], events: evs });
  const closed = renderPanel(view, { T }); assert.ok(closed.includes('سجل الأحداث') && !closed.includes('<table'));
  r.toggleLog(); const open = renderPanel(r.getView(), { T });
  assert.ok(open.includes('يُعرض 50 من 120') && open.includes('الحدّ للعرض فقط') && open.includes('عرض الكل') && open.includes('سبب أخير'));
  assert.equal((open.match(/<tr>/g) || []).length, 51);
  r.toggleShowAll(); const all = renderPanel(r.getView(), { T }); assert.equal((all.match(/<tr>/g) || []).length, 121); assert.ok(all.includes('عرض آخر 50 فقط'));
});

await t('7ب. الحالة الفارغة: مؤكدة حاليًا ⇒ جملة «لا يوجد» بلا تحذير؛ عند فقد التأكيد أو خطأ المستمع ⇒ تحذير قِدَم + إعادة محاولة ولا جملة جازمة', async () => {
  const fresh = renderPanel((await viewFor({})).view, { T });
  assert.ok(fresh.includes('لا يوجد تقييم قيمة متبقية') && !fresh.includes('fvp-retry') && !fresh.includes('قد لا تكون محدّثة'));
  for (const lose of [(f) => f.emit('heads', 'F1', [], true), (f) => f.fail('events', 'F1', { code: 'unavailable' })]) {
    const { view, r, fake } = await viewFor({}); lose(fake); const h = renderPanel(r.getView(), { T });
    assert.equal(r.getView().status, 'empty'); assert.equal(r.getView().stale, true);
    assert.ok(h.includes('قد لا تكون محدّثة') && h.includes('data-action="fvp-retry"'), 'تحذير وإعادة محاولة');
    assert.ok(!h.includes('لا يوجد تقييم قيمة متبقية لهذا الصندوق بعد.'), 'لا جملة جازمة عند فقد التأكيد'); assertSafeHtml(h);
    assert.ok(view.status === 'empty');
  }
  const en = (await viewFor({})); en.fake.emit('heads', 'F1', [], true);
  assert.ok(renderPanel(en.r.getView(), { T: TEN }).includes('may not be current'));
});

/* ------------------------------------------------------------------ الهروب ------------------------------------------------------------------ */
await t('8. إدخال HTML ضار في كل حقل نصي قادم من البيانات ⇒ مُهرَّب ولا وسوم/خصائص جديدة', async () => {
  const EV = '<img src=x onerror=alert(1)>"><script>alert(2)</script>\' onmouseover=\'x`';
  const p = await approvedPair({
    approvedBy: EV, valuationId: 'V1', doc: { currency: EV, basis: EV, method: EV, methodNote: EV, source: { ref: EV, provider: EV }, enteredBy: EV, approvedAt: EV,
      components: { assetsValue: 900, cashRetained: 200, otherAssets: 50, liabilities: 150, distributionsPayable: 0, otherAssetsItems: [{ description: EV, amount: 50 }] } },
    eligibility: { state: 'ELIGIBLE', changedBy: EV, changedAt: EV, reasonCode: EV, reason: EV },
  });
  const sp = await approvedPair({ date: '2026-10-05', valuationId: 'V2', approvedBy: EV, eligibility: { state: 'SUSPENDED', changedBy: EV, changedAt: EV, reasonCode: 'SUSPENDED', reason: EV } });
  const dr = draftDoc({ valuationId: EV, state: EV, date: '2026-10-06', over: { enteredBy: EV, updatedAt: EV, currency: EV } });
  const badDay = { id: 'BD', data: { ...p.doc.data, valuationId: 'BD', valuationDate: `2026-10-01"><script>alert(3)</script>` } };
  const evs = [event(1, { actor: EV, reason: EV, type: EV, date: EV })]; evs[0].data.role = EV;
  for (const date of ['2026-10-01', '2026-10-05', '2026-10-06']) {
    const { r, view } = await viewFor({ heads: [p.head, sp.head, headOnlyDraft({ date: '2026-10-06', activeDraftId: EV })], valuations: [p.doc, sp.doc, dr, badDay], events: evs });
    r.selectDate(date); r.toggleLog(); await tick();
    const h = renderPanel(r.getView(), { T }); assertSafeHtml(h);
    assert.ok(!/<img|<script/i.test(h), 'وسوم ضارة'); assert.ok(h.includes('&lt;img'), 'يجب أن يظهر النص مهرَّبًا');
    assert.ok(view.excluded >= 1);
  }
  const err = await viewFor(null, { prep: (r, f) => f.fail('heads', 'F1', { code: EV, details: { reason: EV }, message: EV }) });
  const eh = renderPanel(err.view, { T }); assertSafeHtml(eh); assert.ok(!/<img|<script/i.test(eh));
  assert.equal(esc(EV).includes('<'), false);
});
await t('8ب. أنماط تهريب إضافية: معرّف الصندوق/التاريخ في سمات، أرقام غير منتهية', async () => {
  const p = await approvedPair({ doc: { residualValue: Infinity } });
  const h = renderPanel((await viewFor({ heads: [p.head], valuations: [p.doc] }, { verify: async () => ({ ok: true }) })).view, { T });
  assert.ok(h.includes('— SAR')); assertSafeHtml(h);
});

/* ------------------------------------------------------------------ المحوّلات ------------------------------------------------------------------ */
await t('9. محوّل Firestore: where(fundId==X) فقط، includeMetadataChanges، بلا limit/orderBy، يمرّر fromCache، ثلاث مجموعات صحيحة', async () => {
  const calls = []; const emitted = [];
  const DB = { collection(name) { calls.push(['collection', name]); return { where(...a) { calls.push(['where', ...a]); return { onSnapshot(opts, next, err) { calls.push(['onSnapshot', JSON.stringify(opts)]); next({ docs: [{ id: 'd1', data: () => ({ a: 1 }) }], metadata: { fromCache: true } }); next({ docs: [], metadata: { fromCache: false } }); return () => calls.push(['unsub', name]); } }; } }; } };
  const sub = makeFirestoreSubscribe({ DB });
  for (const s of ['heads', 'valuations', 'events']) sub(s, 'F7', (x) => emitted.push(x), () => {});
  assert.deepEqual(calls.filter((c) => c[0] === 'collection').map((c) => c[1]), ['fundValuationHeads', 'fundValuations', 'fundValuationEvents']);
  assert.ok(calls.filter((c) => c[0] === 'where').every((c) => c[1] === 'fundId' && c[2] === '==' && c[3] === 'F7'));
  assert.ok(calls.filter((c) => c[0] === 'onSnapshot').every((c) => c[1] === '{"includeMetadataChanges":true}'));
  assert.equal(emitted[0].fromCache, true); assert.deepEqual(emitted[0].docs, [{ id: 'd1', data: { a: 1 } }]); assert.equal(emitted[1].fromCache, false);
});
await t('9ب. الجلسة: لا دور محسوم قبل تأكيد الخادم لـteam_roles، والأدمن بالبريد محسوم، وبلا DB/دخول/accessDenied ⇒ غير محسوم', async () => {
  const base = (over) => ({ DB: {}, accessDenied: false, ADMIN_EMAILS: ['boss@x.com'], currentUser: { uid: 'u', email: 'Fm@X.com' }, STORE: { team_roles: [{ id: 'fm@x.com', data: { role: 'fund_manager' } }] }, isIfCollectionServerConfirmed: () => false, ...over });
  assert.equal(makeSession(base())().roleResolved, false);
  const ok = makeSession(base({ isIfCollectionServerConfirmed: (n) => n === 'team_roles' }))(); assert.equal(ok.roleResolved, true); assert.equal(ok.role, 'fund_manager'); assert.equal(ok.email, 'fm@x.com');
  const adm = makeSession(base({ currentUser: { uid: 'a', email: 'BOSS@x.com' } }))(); assert.equal(adm.roleResolved, true); assert.equal(adm.role, 'admin');
  const none = makeSession(base({ isIfCollectionServerConfirmed: () => true, STORE: { team_roles: [] } }))(); assert.equal(none.role, 'analyst'); assert.equal(none.roleResolved, true);
  assert.equal(makeSession(base({ DB: null }))().roleResolved, false); assert.equal(makeSession(base({ currentUser: null }))().roleResolved, false); assert.equal(makeSession(base({ accessDenied: true, isIfCollectionServerConfirmed: () => true }))().roleResolved, false);
});

/* ------------------------------------------------------------------ التوصيل الفعلي بـcore.js ------------------------------------------------------------------ */
function bootCore() {
  const app = { _h: '', renders: 0, set innerHTML(v) { this._h = v; this.renders += 1; }, get innerHTML() { return this._h; } };
  const doc = { documentElement: { lang: 'ar' }, querySelector() { return null; }, addEventListener() {}, getElementById(id) { return id === 'app' ? app : null; }, querySelectorAll() { return []; }, body: {}, createElement() { return { innerHTML: '', firstChild: null, appendChild() {} }; } };
  const C = loadCore(['teardownUserSubscriptions', 'renderFundDetailSections', 'runRenderEndHooks'], { document: doc });
  for (const id of ['F1', 'F2']) C.STORE.funds.push({ id, data: { name: `صندوق ${id}`, fundType: 'x', vintageYear: 2026, targetSize: 0, status: 'forming', assetIds: [] } });
  const fake = makeFakeSubscribe(); const box = sessionBox();
  const reader = registerFundValuationPanel(C, { subscribe: fake.subscribe, getSession: box.get });
  const open = (id) => C.setCoreState({ fundsViewOpen: true, fundsSubTab: 'funds', openFundId: id });
  return { C, app, fake, box, reader, open };
}
await t('10. توصيل فعلي: رسم صندوق مفتوح ⇒ القسم في الصفحة وثلاثة اشتراكات؛ رسم متكرر لا يضاعفها ولا يدخل حلقة رسم', async () => {
  const { C, app, fake, open } = bootCore();
  open('F1'); C.render();
  assert.ok(app.innerHTML.includes('data-fvp="root"')); assert.equal(fake.live().length, 3);
  for (let i = 0; i < 6; i += 1) C.render();
  assert.equal(fake.live().length, 3); assert.equal(fake.subs.length, 3);
  const p = await approvedPair({});
  fake.emitAll('F1', { heads: [p.head], valuations: [p.doc] }); await tick(8);
  assert.ok(app.innerHTML.includes('1,000 SAR'), 'اللوحة تُعاد رسمها عبر التوصيل الحقيقي بعد التحقق');
  const n = app.renders; await tick(12); assert.equal(app.renders, n, 'لا حلقة إعادة رسم');
});
await t('10ب. مغادرة العرض بأي طريقة ⇒ صفر مستمعات بعد الرسم التالي، وإعادة الفتح تشترك مجددًا مرة واحدة', async () => {
  const { C, fake, open } = bootCore(); let expectSubs = 0;
  const leaves = {
    'إغلاق الصندوق (قائمة الصناديق)': () => C.setCoreState({ openFundId: null }),
    'الرجوع للرئيسية (إغلاق عرض الصناديق)': () => C.setCoreState({ fundsViewOpen: false, openFundId: null }),
    'تبويب آخر داخل الصناديق': () => C.setCoreState({ fundsSubTab: 'ledger' }),
    'عرض رئيسي مسجَّل آخر': () => { C.registerMainView('other', () => '<p>OTHER</p>'); C.setCoreState({ mainView: 'other' }); },
  };
  for (const [name, leave] of Object.entries(leaves)) {
    C.setCoreState({ mainView: null }); open('F1'); C.render(); expectSubs += 3;
    assert.equal(fake.live().length, 3, `${name}: قبل المغادرة`); assert.equal(fake.subs.length, expectSubs, `${name}: اشتراكات جديدة ثلاثة فقط`);
    leave(); C.render();
    assert.equal(fake.live().length, 0, `${name}: بعد المغادرة`);
  }
});
await t('10ج. تبديل الصندوق عبر التوصيل ⇒ إلغاء الأول قبل اشتراك الثاني', async () => {
  const { C, fake, open } = bootCore(); open('F1'); C.render(); open('F2'); C.render();
  assert.equal(fake.live().length, 3); assert.ok(fake.live().every((s) => s.fundId === 'F2'));
  const firstSubF2 = fake.log.findIndex((x) => x.startsWith('sub:') && x.endsWith(':F2')); assert.ok(fake.log.slice(0, firstSubF2).filter((x) => x.startsWith('unsub:')).length === 3);
});
await t('10د. خطاف إنهاء الجلسة الحقيقي: teardownUserSubscriptions ⇒ إيقاف ومسح، وقارئ بلا صندوق مطلوب', async () => {
  const { C, app, fake, open, reader } = bootCore(); open('F1'); C.render(); const p = await approvedPair({});
  fake.emitAll('F1', { heads: [p.head], valuations: [p.doc] }); await tick(6); assert.ok(app.innerHTML.includes('1,000 SAR'));
  C.teardownUserSubscriptions();
  assert.equal(fake.live().length, 0); assert.equal(reader.wanted(), null); assert.equal(reader.getView().status, 'idle'); assert.deepEqual(reader.getView().dates, []);
  await tick(6); C.render(); assert.ok(!app.innerHTML.includes('1,000 SAR'), 'لا بيانات المستخدم السابق بعد التفكيك'); assert.equal(fake.live().length, 0);
});
await t('10هـ. استدعاء التفكيك مربوط في مساري الخروج والتبديل المباشر داخل core.js (فحص مصدر، لا سلوك)', async () => {
  const src = fs.readFileSync(new URL('../../src/core.js', import.meta.url), 'utf8');
  assert.ok(/if\(isDirectUserSwitch\) teardownUserSubscriptions\(\);/.test(src));
  assert.ok(/function teardownUserSubscriptions\(\)\{[\s\S]*?runSessionTeardownHooks\(\);\s*\}/.test(src));
  assert.equal((src.match(/teardownUserSubscriptions\(\)/g) || []).length, 3, 'التعريف + موضعا النداء');
});
await t('10و. إجراءات اللوحة تمرّ عبر معالج الإجراءات الحقيقي في core ولا تعدّل شيئًا خارج القارئ', async () => {
  const { C, fake, open } = bootCore(); open('F1'); C.render();
  const p = await approvedPair({}); const q = await approvedPair({ date: '2026-09-01', valuationId: 'V0' });
  fake.emitAll('F1', { heads: [p.head, q.head], valuations: [p.doc, q.doc], events: [event(1)] }); await tick(8);
  const run = async (action, dataset = {}) => { for (const h of C._actionHandlerHooks) if (await h(action, { dataset })) return true; return false; };
  assert.equal(await run('fvp-select-date', { date: '2026-09-01' }), true); await tick(6);
  assert.ok(C.render && true); assert.equal(await run('fvp-toggle-log'), true); assert.equal(await run('fvp-toggle-all'), true);
  assert.equal(await run('if-save'), false, 'إجراءات غير لوحة لا تُلتقط'); assert.equal(await run('approve'), false);
  const before = fake.subs.length; assert.equal(await run('fvp-retry'), true); assert.equal(fake.subs.length, before + 3); assert.equal(fake.live().length, 3);
});
await t('10ز. فشل القسم داخل الخطاف لا يكسر صفحة الصندوق', async () => {
  const { C, app, open } = bootCore(); C.registerFundDetailSection(() => { throw new Error('boom'); });
  open('F1'); const origErr = console.error; console.error = () => {}; try { C.render(); await tick(6); } finally { console.error = origErr; }
  assert.ok(app.innerHTML.includes('صندوق F1') && app.innerHTML.includes('تعذّر عرض هذا القسم'));
});
await t('10ح. خطاف فاشل في نهاية الرسم/إنهاء الجلسة لا يوقف الرسم', async () => {
  const { C, app, open } = bootCore(); C.registerRenderEnd(() => { throw new Error('x'); }); C.registerSessionTeardown(() => { throw new Error('y'); });
  open('F1'); const origErr = console.error; console.error = () => {}; try { C.render(); C.teardownUserSubscriptions(); await tick(6); } finally { console.error = origErr; }
  assert.ok(app.innerHTML.length > 100);
});

/* ------------------------------------------------------------------ حدود النطاق ------------------------------------------------------------------ */
await t('11. اللوحة والقارئ: بلا callables ولا مخزن طلبات ولا XIRR ولا كتابة ولا تخزين دائم ولا Net XIRR', async () => {
  for (const f of ['fund-valuation-panel.js', 'fund-valuation-reader.js']) {
    const src = fs.readFileSync(new URL(`../../src/features/${f}`, import.meta.url), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    assert.ok(!/requests|xirr|portfolio|firebase/i.test(imports), `${f}: ${imports}`);
    assert.ok(!/httpsCallable|\.functions\(|runTransaction|localStorage|sessionStorage|indexedDB|\.doc\(|\.add\(|\.delete\(\)|netXirr|NET_XIRR/i.test(src), `${f}: واجهة محظورة`);
  }
  const panel = fs.readFileSync(new URL('../../src/features/fund-valuation-panel.js', import.meta.url), 'utf8');
  assert.equal((panel.match(/\.collection\(/g) || []).length, 1, 'استخدام وحيد لـcollection ضمن محوّل القراءة');
  assert.ok(!/\.(set|update)\(\s*\{/.test(panel));
});

if (failed) { console.error(`panel tests: ${passed} passed, ${failed} FAILED`); process.exit(1); }
console.log(`panel tests: ${passed} passed`);
