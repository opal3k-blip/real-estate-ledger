// اختبار لوحة XIRR المقارنة (src/features/xirr-comparison-panel.js).
// لا DOM ولا متصفح: core/storage/document مزيّفة، والحساب يُحقن في اختبارات الحالات
// ويُشغَّل بالمحرك الحقيقي في اختبار الـ14 fixture. لا يمسّ Golden Master ولا يكتب أي ملف.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFinancialEngine } from '../../src/domain/financial/financial-engine.js';
import { blankOpportunity, TIERS, USE_TYPES, SITE_FACTORS, DEV_REFI_STRATEGY_KEY, isResidentialUseType } from '../../src/domain/financial/financial-context.js';
import { computeOpportunityProjectAndEquityXirr } from '../../src/domain/financial/xirr/opportunity-xirr.js';
import { registerXirrComparisonPanel, parseBaseDate, formatRate, classifyXirr, storageKeyFor, userKeyOf, STORAGE_PREFIX } from '../../src/features/xirr-comparison-panel.js';

let pass = 0;
const results = [];
function t(name, fn) {
  try { fn(); pass++; results.push(`PASS  ${name}`); }
  catch (e) { results.push(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`); t.failed = (t.failed || 0) + 1; }
}

/* ---------- حقن ---------- */
function makeEnv({ compute, storageImpl, user = { uid: 'u1', email: 'a@x.com' }, oppId = 'opp1', inputValue = '' } = {}) {
  const hooks = { detail: [], action: [] };
  const mem = new Map();
  const storage = storageImpl || {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
  const core = {
    currentUser: user,
    openDetailId: oppId,
    T: (ar) => ar,
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    fmtPct: (v, d) => (v == null || !isFinite(v) ? '—' : '%' + (v * 100).toFixed(d == null ? 1 : d)),
    renders: 0,
    render() { this.renders++; },
    registerDetailSection: (fn) => hooks.detail.push(fn),
    registerActionHandler: (fn) => hooks.action.push(fn),
  };
  const input = { value: inputValue };
  const api = registerXirrComparisonPanel(core, { compute, storage, getDoc: () => ({ getElementById: (id) => (id === 'xirr-base-date' ? input : null) }) });
  const d = { meta: { name: 'x' }, v: 1 };
  const c = { equityIRR: 0.2351, projectIRR: 0.111 };
  return {
    core, api, mem, input, d, c, storage,
    html: (dd = d, cc = c) => hooks.detail[0](dd, cc),
    act: (action, el) => hooks.action[0](action, el || { getAttribute: () => core.openDetailId }),
    apply(text) { input.value = text; return this.act('xirr-apply'); },
  };
}
const okX = (rate) => ({ status: 'OK', rate, method: 'x' });
function fakeCompute(project, equity, warnings = []) {
  const fn = () => { fn.calls++; return { acquisitionDate: 'x', project: { xirr: project }, equity: { xirr: equity }, sourceWarnings: warnings }; };
  fn.calls = 0;
  return fn;
}
const has = (s, sub) => s.includes(sub);
const TITLE = 'XIRR وفق تدفقات النموذج وتاريخ أساس افتراضي — للمقارنة فقط';

/* ---------- أدوات نقية ---------- */
t('parseBaseDate accepts only real YYYY-MM-DD dates (incl. Arabic-Indic digits)', () => {
  assert.equal(parseBaseDate('2027-03-15'), '2027-03-15');
  assert.equal(parseBaseDate(' ٢٠٢٧-٠٣-١٥ '), '2027-03-15');
  for (const bad of ['', '   ', 'abc', '2027-13-01', '2027-02-30', '2027-2-3', '27-03-15', '2027/03/15', '1999-12-31', '2101-01-01', '2027-00-10', '2027-01-32', null, undefined, '2027-03-15x'])
    assert.equal(parseBaseDate(bad), null, String(bad));
  assert.equal(parseBaseDate('2028-02-29'), '2028-02-29');
  assert.equal(parseBaseDate('2027-02-29'), null);
});
t('formatRate: zero, negative-zero noise, normal, non-finite', () => {
  assert.equal(formatRate(0), '0.00%');
  assert.equal(formatRate(-0), '0.00%');
  assert.equal(formatRate(-2.4775670859232555e-16), '0.00%');
  assert.equal(formatRate(2e-16), '0.00%');
  assert.equal(formatRate(0.1234), '12.34%');
  assert.equal(formatRate(-0.05), '-5.00%');
  for (const v of [NaN, Infinity, -Infinity, null, undefined, '0.1']) assert.equal(formatRate(v), '—');
});
t('classifyXirr: only OK+finite is RATE; ambiguity never yields a rate', () => {
  assert.equal(classifyXirr(okX(0.1)).kind, 'RATE');
  assert.equal(classifyXirr(okX(0)).kind, 'RATE');
  assert.equal(classifyXirr({ status: 'OK', rate: NaN }).kind, 'NO_RATE');
  assert.equal(classifyXirr({ status: 'OK' }).kind, 'NO_RATE');
  assert.equal(classifyXirr({ status: 'POSSIBLE_MULTIPLE_ROOTS', rate: 0.5, roots: [0.1, 0.4] }).rate, null);
  assert.equal(classifyXirr({ status: 'NUMERICALLY_AMBIGUOUS', rate: 0.5 }).kind, 'UNDETERMINED');
  assert.equal(classifyXirr(null).kind, 'NO_RATE');
  assert.equal(classifyXirr({ status: 'WHATEVER' }).kind, 'NO_RATE');
});
t('storage key is separated per user and per opportunity', () => {
  assert.notEqual(storageKeyFor('u1', 'a'), storageKeyFor('u2', 'a'));
  assert.notEqual(storageKeyFor('u1', 'a'), storageKeyFor('u1', 'b'));
  assert.ok(storageKeyFor('u1', 'a').startsWith(STORAGE_PREFIX));
  assert.equal(userKeyOf(null), 'anonymous');
  assert.equal(userKeyOf({ email: 'A@X.com' }), 'a@x.com');
});

/* ---------- حالات العرض ---------- */
t('first use: empty input, no computation, no rate, required title and no-schedule note', () => {
  const cmp = fakeCompute(okX(0.1), okX(0.2));
  const e = makeEnv({ compute: cmp });
  const h = e.html();
  assert.ok(has(h, TITLE));
  assert.ok(has(h, 'لا ينشئ جدول تحصيل أو صرف تشغيلياً جديداً'));
  assert.ok(has(h, 'id="xirr-base-date"') && has(h, 'value=""'));
  assert.ok(has(h, 'لم يُحدَّد تاريخ أساس بعد'));
  assert.equal(cmp.calls, 0);
  assert.ok(!has(h, 'data-xirr-series'));
  assert.ok(!has(h, new Date().getFullYear() + '-'), 'no today date');
  assert.ok(!has(h, '2027-01'));
});
t('current IRR is shown unchanged via core.fmtPct', () => {
  const e = makeEnv({ compute: fakeCompute(okX(0.1), okX(0.2)) });
  const h = e.html();
  assert.ok(has(h, '%23.5') && has(h, '%11.1'));
});
t('missing date on apply → error, no computation', () => {
  const cmp = fakeCompute(okX(0.1), okX(0.2));
  const e = makeEnv({ compute: cmp });
  e.apply('   ');
  const h = e.html();
  assert.ok(has(h, 'أدخل تاريخاً بصيغة YYYY-MM-DD'));
  assert.equal(cmp.calls, 0);
  assert.ok(!has(h, 'data-xirr-series'));
  assert.equal(e.core.renders, 1);
});
t('invalid dates → error, no computation, input text preserved, nothing stored', () => {
  for (const bad of ['2027-02-30', '15/03/2027', 'abc', '2027-13-01', '1999-01-01']) {
    const cmp = fakeCompute(okX(0.1), okX(0.2));
    const e = makeEnv({ compute: cmp });
    e.apply(bad);
    const h = e.html();
    assert.ok(has(h, 'تاريخ غير صالح'), bad);
    assert.ok(has(h, `value="${bad}"`), bad);
    assert.equal(cmp.calls, 0, bad);
    assert.equal(e.mem.size, 0, bad);
    assert.ok(!has(h, 'data-xirr-series'));
  }
});
t('valid date + OK/OK → both headline rates, base date shown, assumed-date warning explained', () => {
  const cmp = fakeCompute(okX(0.1234), okX(0.2),
    [{ code: 'ASSUMED_DATE_NOT_OPERATIONAL', message: 'raw english msg' }]);
  const e = makeEnv({ compute: cmp });
  e.apply('2027-03-15');
  const h = e.html();
  assert.equal(cmp.calls, 1);
  assert.ok(has(h, '12.34%') && has(h, '20.00%'));
  assert.ok(has(h, '2027-03-15'));
  assert.ok(has(h, 'ليس تاريخاً تشغيلياً مؤكَّداً'));
  assert.ok(has(h, '<code>ASSUMED_DATE_NOT_OPERATIONAL</code>') && has(h, 'raw english msg'));
  assert.ok(has(h, 'XIRR وفق') );
  assert.ok(has(h, 'data-xirr-series="project"') && has(h, 'data-xirr-series="equity"'));
});
t('calculation uses acquisitionDateIsAssumed:true and the exact entered date', () => {
  let seen = null;
  const cmp = (d, c, o) => { seen = o; return { project: { xirr: okX(0.1) }, equity: { xirr: okX(0.1) }, sourceWarnings: [] }; };
  const e = makeEnv({ compute: cmp });
  e.apply('2027-03-15'); e.html();
  assert.deepEqual(seen, { acquisitionDate: '2027-03-15', acquisitionDateIsAssumed: true });
});
t('true zero and -2.4e-16 display 0.00% (never -0.00%)', () => {
  for (const r of [0, -2.4775670859232555e-16]) {
    const e = makeEnv({ compute: fakeCompute(okX(r), okX(r)) });
    e.apply('2027-03-15');
    const h = e.html();
    assert.ok(has(h, '0.00%'));
    assert.ok(!has(h, '-0.00'));
    assert.ok(!has(h, 'غير محدَّد'));
  }
});
t('POSSIBLE_MULTIPLE_ROOTS: no headline rate, roots only in separate "not an approved return" details', () => {
  const x = { status: 'POSSIBLE_MULTIPLE_ROOTS', roots: [0.05, 0.31], rate: 0.99 };
  const e = makeEnv({ compute: fakeCompute(x, okX(0.2)) });
  e.apply('2027-03-15');
  const h = e.html();
  const row = h.split('data-xirr-series="project"')[1].split('</tr>')[0];
  const beforeDetails = row.split('<details')[0];
  assert.ok(has(beforeDetails, 'غير محدَّد'));
  assert.ok(!/\d+\.\d\d%/.test(beforeDetails), 'no percentage outside details');
  assert.ok(!has(h, '99.00%'));
  assert.ok(has(row, '5.00%') && has(row, '31.00%'));
  assert.ok(has(row, 'ليست عائداً معتمداً'));
  assert.ok(has(row, 'POSSIBLE_MULTIPLE_ROOTS'));
});
t('NUMERICALLY_AMBIGUOUS: candidates unverified, no headline', () => {
  const x = { status: 'NUMERICALLY_AMBIGUOUS', crossingRates: [0.1], tangentCandidates: [0.2], candidateRates: [0.15], candidateRatesAreUnverified: true };
  const e = makeEnv({ compute: fakeCompute(okX(0.1), x) });
  e.apply('2027-03-15');
  const h = e.html();
  const row = h.split('data-xirr-series="equity"')[1].split('</tr>')[0];
  const before = row.split('<details')[0];
  assert.ok(has(before, 'غير محدَّد') && !/\d+\.\d\d%/.test(before));
  assert.ok(has(row, '10.00%') && has(row, '20.00%') && has(row, '15.00%'));
  assert.ok(has(row, 'غير مُتحقَّق منها'));
});
t('every NO_RATE status shows dash + Arabic explanation + status code; no percentage', () => {
  const codes = ['NO_REAL_ROOT', 'NO_SIGN_CHANGE', 'NO_ROOT_FOUND_IN_SEARCH_RANGE', 'ROOT_PROVEN_OUTSIDE_SEARCH_RANGE', 'DEGENERATE_NO_TIME_SPREAD', 'INSUFFICIENT_INPUT', 'INVALID_INPUT', 'INTERNAL_INCONSISTENCY', 'INSUFFICIENT_SOURCE_DATA', 'UPSTREAM_GENERATION_FAILED'];
  for (const code of codes) {
    const e = makeEnv({ compute: fakeCompute({ status: code, reason: 'why-' + code }, okX(0.2)) });
    e.apply('2027-03-15');
    const row = e.html().split('data-xirr-series="project"')[1].split('</tr>')[0];
    assert.ok(has(row, '<strong>—</strong>'), code);
    assert.ok(has(row, `>${code}<`), code);
    assert.ok(!has(row, 'حالة غير معروفة'), code);
    assert.ok(!/\d+\.\d\d%/.test(row), code);
    assert.ok(has(row, 'why-' + code), code);
  }
});
t('unknown status stays visible verbatim with generic explanation, no rate', () => {
  const e = makeEnv({ compute: fakeCompute({ status: 'BRAND_NEW_STATUS', rate: 0.5 }, okX(0.2)) });
  e.apply('2027-03-15');
  const row = e.html().split('data-xirr-series="project"')[1].split('</tr>')[0];
  assert.ok(has(row, '>BRAND_NEW_STATUS<') && has(row, 'حالة غير معروفة') && !has(row, '50.00%'));
});
t('OK without finite rate is not shown as a rate', () => {
  const e = makeEnv({ compute: fakeCompute({ status: 'OK', rate: NaN }, { status: 'OK' }) });
  e.apply('2027-03-15');
  const h = e.html();
  assert.ok(!/\d+\.\d\d%/.test(h.split('data-xirr-series="project"')[1].split('</table>')[0]));
  assert.ok(has(h, 'OK_WITHOUT_FINITE_RATE'));
});
t('all known warning codes are explained in Arabic with the code kept; unknown code stays visible', () => {
  const known = ['ASSUMED_DATE_NOT_OPERATIONAL', 'PERPETUAL_HOLD_DEEMED_EXIT_IN_EQUITY_SERIES', 'PHASED_SALE_MODE_DEBT_LEDGER_NOT_RECONCILED_HERE', 'DRAW_SCHEDULE_TIMING_NOT_ALIGNED_TO_PROJECT_COST_BOOKING', 'INSUFFICIENT_SOURCE_DATA_PROJECT_COST', 'PROJECT_CASH_GENERATION_FAILED', 'EQUITY_CASH_GENERATION_FAILED'];
  const warns = [...known, 'SOME_FUTURE_CODE'].map((code) => ({ code, message: 'msg-' + code }));
  const e = makeEnv({ compute: fakeCompute(okX(0.1), okX(0.1), warns) });
  e.apply('2027-03-15');
  const h = e.html();
  for (const code of known) {
    const li = h.split(`data-xirr-warning="${code}"`)[1].split('</li>')[0];
    assert.ok(has(li, `<code>${code}</code>`) && has(li, 'msg-' + code), code);
    assert.ok(!has(li.split('<details')[0], 'غير معروف'), code);
  }
  const u = h.split('data-xirr-warning="SOME_FUTURE_CODE"')[1].split('</li>')[0];
  assert.ok(has(u, '<code>SOME_FUTURE_CODE</code>') && has(u, 'msg-SOME_FUTURE_CODE') && has(u, 'رمز غير معروف'));
});
t('compute throwing → error box, no rate, panel still renders', () => {
  const cmp = () => { throw new Error('boom'); };
  const e = makeEnv({ compute: cmp });
  e.apply('2027-03-15');
  const h = e.html();
  assert.ok(has(h, 'PANEL_COMPUTE_ERROR') && has(h, 'boom') && has(h, TITLE));
  assert.ok(!has(h, 'data-xirr-series'));
});
t('HTML in opportunity id, warnings, reasons and date text is escaped', () => {
  const e = makeEnv({ oppId: '<img src=x onerror=1>', compute: fakeCompute({ status: 'NO_REAL_ROOT', reason: '<script>1</script>' }, okX(0.1), [{ code: '<b>c</b>', message: '<i>m</i>' }]) });
  e.apply('"><svg onload=1>');
  let h = e.html();
  assert.ok(!has(h, '<svg') && !has(h, '<img') && has(h, '&lt;svg'));
  e.apply('2027-03-15');
  h = e.html();
  assert.ok(!has(h, '<script>') && !has(h, '<b>c</b>') && !has(h, '<i>m</i>') && !has(h, '<img'));
});

/* ---------- حساب عند الطلب / تغيّر المدخلات فقط ---------- */
t('repaint does not recompute; changing opportunity inputs or date does', () => {
  const cmp = fakeCompute(okX(0.1), okX(0.2));
  const e = makeEnv({ compute: cmp });
  e.html(); e.html();
  assert.equal(cmp.calls, 0);
  e.apply('2027-03-15');
  e.html(); e.html(); e.html();
  assert.equal(cmp.calls, 1, 'repaints use cache');
  e.html({ ...e.d, v: 2 });
  assert.equal(cmp.calls, 2, 'input change recomputes');
  e.html({ ...e.d, v: 2 });
  assert.equal(cmp.calls, 2);
  e.apply('2027-04-01'); e.html({ ...e.d, v: 2 });
  assert.equal(cmp.calls, 3, 'date change recomputes');
  e.apply('2027-04-01'); e.html({ ...e.d, v: 2 });
  assert.equal(cmp.calls, 3, 'same date again is cached');
});
t('clear removes result, input value and stored date; no recompute', () => {
  const cmp = fakeCompute(okX(0.1), okX(0.2));
  const e = makeEnv({ compute: cmp });
  e.apply('2027-03-15'); e.html();
  assert.equal(e.mem.size, 1);
  e.act('xirr-clear');
  const h = e.html();
  assert.equal(e.mem.size, 0);
  assert.ok(has(h, 'value=""') && !has(h, 'data-xirr-series'));
  assert.equal(cmp.calls, 1);
});
t('unrelated actions are not handled; handler is click-driven only', () => {
  const e = makeEnv({ compute: fakeCompute(okX(0.1), okX(0.2)) });
  assert.equal(e.act('something-else'), false);
  assert.equal(e.core.renders, 0);
});

t('cache key includes the computation object c: a changed c recomputes, identical c does not', () => {
  const cmp = fakeCompute(okX(0.1), okX(0.2));
  const e = makeEnv({ compute: cmp });
  e.apply('2027-03-15'); e.html();
  assert.equal(cmp.calls, 1);
  e.html(e.d, { ...e.c }); assert.equal(cmp.calls, 1, 'equal c content is cached');
  e.html(e.d, { ...e.c, landCost: 5 }); assert.equal(cmp.calls, 2, 'changed c recomputes');
  e.html(e.d, { ...e.c, landCost: 5 }); assert.equal(cmp.calls, 2);
});
t('unserializable d or c (circular) is never cached: computed each time, no crash', () => {
  const cmp = fakeCompute(okX(0.1), okX(0.2));
  const e = makeEnv({ compute: cmp });
  e.apply('2027-03-15');
  const circ = {}; circ.self = circ;
  assert.doesNotThrow(() => e.html(circ, e.c));
  assert.doesNotThrow(() => e.html(e.d, circ));
  assert.equal(cmp.calls, 2);
  e.html(circ, e.c);
  assert.equal(cmp.calls, 3);
  assert.equal(e.api._cacheSize(), 0);
});

/* ---------- التخزين ---------- */
t('valid date is saved under the per-user/per-opportunity key and restored in a new registration', () => {
  const e = makeEnv({ compute: fakeCompute(okX(0.1), okX(0.2)) });
  e.apply('2027-03-15');
  assert.deepEqual([...e.mem.keys()], [storageKeyFor('u1', 'opp1')]);
  // "reload": new registration, same storage content
  const cmp2 = fakeCompute(okX(0.1), okX(0.2));
  const e2 = makeEnv({ compute: cmp2 });
  for (const [k, v] of e.mem) e2.mem.set(k, v);
  const h = e2.html();
  assert.ok(has(h, 'value="2027-03-15"') && has(h, 'data-xirr-series="project"'));
  assert.equal(cmp2.calls, 1);
});
t('corrupt stored value is ignored (empty panel, no compute)', () => {
  const cmp = fakeCompute(okX(0.1), okX(0.2));
  const e = makeEnv({ compute: cmp });
  e.mem.set(storageKeyFor('u1', 'opp1'), 'not-a-date');
  const h = e.html();
  assert.ok(has(h, 'لم يُحدَّد تاريخ أساس') && cmp.calls === 0);
});
t('storage failure (get and set throw) does not break display; date works in-memory and a note is shown', () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };
  const cmp = fakeCompute(okX(0.1), okX(0.2));
  const e = makeEnv({ compute: cmp, storageImpl: bad });
  assert.doesNotThrow(() => e.html());
  assert.doesNotThrow(() => e.apply('2027-03-15'));
  const h = e.html();
  assert.ok(has(h, '10.00%') && has(h, '20.00%') && has(h, 'تعذّر الحفظ المحلي'));
  assert.doesNotThrow(() => e.act('xirr-clear'));
  assert.ok(has(e.html(), TITLE));
});

/* ---------- تبديل المستخدم والفرصة ---------- */
t('switching opportunity never shows another opportunity\'s date or result', () => {
  const cmp = fakeCompute(okX(0.1), okX(0.2));
  const e = makeEnv({ compute: cmp });
  e.apply('2027-03-15');
  assert.ok(has(e.html(), '2027-03-15'));
  e.core.openDetailId = 'opp2';
  let h = e.html();
  assert.ok(!has(h, '2027-03-15') && has(h, 'لم يُحدَّد تاريخ أساس') && has(h, 'value=""'));
  const callsBefore = cmp.calls;
  e.apply('2027-06-01');
  h = e.html();
  assert.ok(has(h, '2027-06-01') && !has(h, '2027-03-15'));
  e.core.openDetailId = 'opp1';
  h = e.html();
  assert.ok(has(h, '2027-03-15') && !has(h, '2027-06-01'));
  assert.equal(cmp.calls, callsBefore + 1, 'returning to opp1 uses cache');
  assert.equal(e.mem.size, 2);
});
t('switching user separates dates and caches for the same opportunity', () => {
  const cmp = fakeCompute(okX(0.1), okX(0.2));
  const e = makeEnv({ compute: cmp });
  e.apply('2027-03-15');
  e.core.currentUser = { uid: 'u2', email: 'b@x.com' };
  let h = e.html();
  assert.ok(!has(h, '2027-03-15') && has(h, 'لم يُحدَّد'));
  e.apply('2028-01-01');
  assert.ok(has(e.html(), '2028-01-01'));
  e.core.currentUser = null;
  h = e.html();
  assert.ok(!has(h, '2028-01-01') && !has(h, '2027-03-15'));
  e.core.currentUser = { uid: 'u1', email: 'a@x.com' };
  assert.ok(has(e.html(), '2027-03-15'));
  assert.deepEqual([...e.mem.keys()].sort(), [storageKeyFor('u1', 'opp1'), storageKeyFor('u2', 'opp1')].sort());
});
t('action uses the opportunity id on the clicked element', () => {
  const e = makeEnv({ compute: fakeCompute(okX(0.1), okX(0.2)) });
  e.input.value = '2027-03-15';
  e.act('xirr-apply', { getAttribute: () => 'oppZ' });
  assert.ok(e.mem.has(storageKeyFor('u1', 'oppZ')));
});
t('no open opportunity → section renders nothing', () => {
  const e = makeEnv({ compute: fakeCompute(okX(0.1), okX(0.2)), oppId: null });
  assert.equal(e.html(), '');
});

/* ---------- Phase 3A-2: حارس المدخلات ---------- */
t('metric guard blocking → panel shows a blocked notice, no current IRR, and never computes', () => {
  let calls = 0;
  const e = makeEnv({ compute: () => { calls++; return fakeCompute(okX(0.1), okX(0.2))(); } });
  e.core.metricGuard = () => ({ blocked: true, status: 'INVALID' });
  const h = e.html();
  assert.ok(has(h, 'data-xirr-panel="blocked"'));
  assert.ok(!has(h, '23.5') && !has(h, '%11'), 'no IRR numbers');
  assert.equal(calls, 0, 'compute not called');
});
t('metric guard returning null → panel behaves exactly as before', () => {
  const e = makeEnv({ compute: fakeCompute(okX(0.1), okX(0.2)) });
  e.core.metricGuard = () => null;
  const h = e.html();
  assert.ok(!has(h, 'data-xirr-panel="blocked"'));
  assert.ok(has(h, 'xirr-base-date'));
});

/* ---------- المحرك الحقيقي: 14 fixture ---------- */
t('14 financing fixtures through the real engine render a headline rate for OK series (and equal the wrapper)', () => {
  const engine = createFinancialEngine({ blankOpportunity, TIERS, USE_TYPES, SITE_FACTORS, DEV_REFI_STRATEGY_KEY, isResidentialUseType });
  const data = JSON.parse(fs.readFileSync(new URL('../domain/financing-baseline.json', import.meta.url), 'utf8'));
  const entries = Object.entries(data.fixtures);
  assert.equal(entries.length, 14);
  for (const [key, fx] of entries) {
    const c = engine.compute(fx.input, fx.input.scenarioKey || 'base');
    const direct = computeOpportunityProjectAndEquityXirr(fx.input, c, { acquisitionDate: '2027-03-15', acquisitionDateIsAssumed: true });
    const e = makeEnv({ oppId: key, compute: computeOpportunityProjectAndEquityXirr });
    e.apply('2027-03-15');
    const h = e.html(fx.input, c);
    for (const [ser, res] of [['project', direct.project.xirr], ['equity', direct.equity.xirr]]) {
      const row = h.split(`data-xirr-series="${ser}"`)[1].split('</tr>')[0];
      const cl = classifyXirr(res);
      if (cl.kind === 'RATE') assert.ok(has(row, formatRate(res.rate)), `${key} ${ser}`);
      else assert.ok(!/<strong><bdi dir="ltr">-?\d/.test(row), `${key} ${ser} must not show a headline`);
    }
    assert.ok(has(h, 'ASSUMED_DATE_NOT_OPERATIONAL'), key);
    // engine IRR untouched by the panel
    const c2 = engine.compute(fx.input, fx.input.scenarioKey || 'base');
    assert.equal(c2.equityIRR, c.equityIRR, key);
  }
});

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${pass} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
