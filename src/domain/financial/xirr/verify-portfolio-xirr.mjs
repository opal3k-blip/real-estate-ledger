// XIRR-P verification (pure domain function). Run: node src/domain/financial/xirr/verify-portfolio-xirr.mjs
// Correctness rests on independent references (closed forms, an independent bisection) and on the shared
// opportunity solver — NOT on agreement with the legacy portfolio solver. Where the legacy solver differs the
// difference is intentional and documented in the "intended differences" section below.
import assert from 'node:assert/strict';
import { computePortfolioNetXirr, isRealIsoDate, parseAmount, isInKindCall, riyadhDateStr } from './portfolio-xirr.js';
import { computeOpportunityXirr } from './xirr-opportunity.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); }
}
const days = (a, b) => (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000;

// independent reference: plain bisection on NPV (Act/365), written separately from the shared solver
function refRate(flows, lo = -0.99, hi = 1000) {
  const t0 = Math.min(...flows.map((f) => Date.parse(f.date + 'T00:00:00Z')));
  const npv = (r) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, (Date.parse(f.date + 'T00:00:00Z') - t0) / 86400000 / 365), 0);
  let flo = npv(lo);
  for (let i = 0; i < 400; i++) { const mid = (lo + hi) / 2, fm = npv(mid); if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; } }
  return (lo + hi) / 2;
}
// legacy portfolio solver as committed at 9fea983 (documentation of intended differences only)
function legacyXirr(cashflows) {
  if (!cashflows.length) return null;
  const t0 = new Date(cashflows[0].date + 'T00:00:00').getTime();
  if (isNaN(t0)) return null;
  const npv = (rate) => cashflows.reduce((s, cf) => { const tt = new Date(cf.date + 'T00:00:00').getTime(); if (isNaN(tt)) return s; return s + cf.amount / Math.pow(1 + rate, (tt - t0) / 86400000 / 365); }, 0);
  let r = 0.15;
  for (let i = 0; i < 80; i++) { const f = npv(r); const df = (npv(r + 1e-5) - f) / 1e-5; if (Math.abs(df) < 1e-9) break; const rn = r - f / df; if (!isFinite(rn)) break; if (Math.abs(rn - r) < 1e-7) { r = rn; break; } r = rn; }
  return isFinite(r) && Math.abs(npv(r)) < 1 ? r : null;
}

const NAV = (value, complete = true, issues = [], basis = 'RESIDUAL_VALUE_AS_OF_DATE', source = 'UNDERWRITING_EQUITY_X_MOIC') => ({ value, complete, issues, basis, source });
const call = (id, date, amount, extra = {}) => ({ kind: 'capitalCall', id, fundId: 'f1', date, amount, status: 'paid', reversalOfId: null, ...extra });
const dist = (id, date, amount, extra = {}) => ({ kind: 'distribution', id, fundId: 'f1', date, amount, status: 'paid', reversalOfId: null, ...extra });
const run = (records, nav, asOfDate = '2026-01-01', extra = {}, options) => computePortfolioNetXirr({ asOfDate, records, nav, ...extra }, options);

/* ---------- helpers ---------- */
t('isRealIsoDate: real calendar dates only', () => {
  assert.ok(isRealIsoDate('2024-02-29') && !isRealIsoDate('2025-02-29') && !isRealIsoDate('2026-02-30') && !isRealIsoDate('2026-1-5') && !isRealIsoDate('') && !isRealIsoDate(null) && !isRealIsoDate(20260101) && !isRealIsoDate('2026-01-01T00:00:00Z'));
});
t('parseAmount: finite numbers / numeric strings; never 0 for missing', () => {
  assert.equal(parseAmount(5), 5); assert.equal(parseAmount('12.5'), 12.5); assert.equal(parseAmount(0), 0);
  for (const v of [null, undefined, '', '  ', 'abc', NaN, Infinity, {}, []]) assert.equal(parseAmount(v), null, String(v));
});

/* ---------- independent references ---------- */
t('closed form: one call, NAV after n days => (NAV/call)^(365/n)-1', () => {
  const r = run([call('c1', '2025-01-01', 1000)], NAV(1210), '2027-01-01');
  assert.equal(r.status, 'OK');
  assert.ok(Math.abs(r.rate - (Math.pow(1.21, 365 / days('2025-01-01', '2027-01-01')) - 1)) < 1e-9, r.rate);
});
t('closed form: whole years 2025-01-01 -> 2026-01-01, 1000 -> 1100 = 10%', () => {
  const r = run([call('c1', '2025-01-01', 1000)], NAV(1100), '2026-01-01');
  assert.equal(r.status, 'OK'); assert.ok(Math.abs(r.rate - 0.1) < 1e-9);
});
t('multi-flow (2 calls, 1 distribution, NAV) agrees with an independent bisection', () => {
  const recs = [call('c1', '2024-03-10', 500000), call('c2', '2024-09-20', 300000), dist('d1', '2025-06-30', 150000)];
  const asOf = '2026-03-31';
  const r = run(recs, NAV(800000), asOf);
  assert.equal(r.status, 'OK');
  const ref = refRate([{ date: '2024-03-10', amount: -500000 }, { date: '2024-09-20', amount: -300000 }, { date: '2025-06-30', amount: 150000 }, { date: asOf, amount: 800000 }]);
  assert.ok(Math.abs(r.rate - ref) < 1e-7, `${r.rate} vs ${ref}`);
});
t('result equals the shared opportunity solver on the same flows (no second solver)', () => {
  const recs = [call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 150000)];
  const r = run(recs, NAV(450000), '2026-03-31');
  const s = computeOpportunityXirr([{ date: '2024-03-10', amount: -500000 }, { date: '2025-06-30', amount: 150000 }, { date: '2026-03-31', amount: 450000 }]);
  assert.equal(r.status, s.status); assert.equal(r.rate, s.rate); assert.equal(r.proof, s.proof);
});
t('scale invariance: x1e6 and x1e-3 give the same rate', () => {
  const base = (k) => run([call('c1', '2024-03-10', 5 * k), call('c2', '2024-09-20', 3 * k), dist('d1', '2025-06-30', 1.5 * k)], NAV(8 * k), '2026-03-31');
  const a = base(1), b = base(1e6), c = base(1e-3);
  assert.ok(a.status === 'OK' && b.status === 'OK' && c.status === 'OK');
  assert.ok(Math.abs(a.rate - b.rate) < 1e-9 && Math.abs(a.rate - c.rate) < 1e-9);
});
t('NAV 0 with distributions >= calls still yields a rate; calls only + NAV 0 => no sign change, no rate', () => {
  const a = run([call('c1', '2025-01-01', 100), dist('d1', '2026-01-01', 120)], NAV(0), '2026-06-30');
  assert.equal(a.status, 'OK'); assert.ok(Math.abs(a.rate - (Math.pow(1.2, 365 / days('2025-01-01', '2026-01-01')) - 1)) < 1e-9);
  const b = run([call('c1', '2025-01-01', 100)], NAV(0), '2026-06-30');
  assert.equal(b.status, 'NO_SIGN_CHANGE'); assert.ok(!('rate' in b));
});

/* ---------- reversal entries ---------- */
t('same-date reversal of a call cancels exactly: result identical to the ledger without both records', () => {
  const core = [call('c1', '2024-03-10', 500000), call('c2', '2024-09-20', 300000), dist('d1', '2025-06-30', 150000)];
  const withRev = core.concat([call('c3', '2024-12-01', 40000), call('c3r', '2024-12-01', -40000, { reversalOfId: 'c3' })]);
  const a = run(core, NAV(800000), '2026-03-31'), b = run(withRev, NAV(800000), '2026-03-31');
  assert.equal(b.status, 'OK'); assert.equal(a.rate, b.rate);
});
t('same-date reversal of a distribution cancels exactly', () => {
  const core = [call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 150000)];
  const withRev = core.concat([dist('d2', '2025-09-01', 70000), dist('d2r', '2025-09-01', -70000, { reversalOfId: 'd2' })]);
  assert.equal(run(core, NAV(450000), '2026-03-31').rate, run(withRev, NAV(450000), '2026-03-31').rate);
});
t('reversal dated differently from its original => INSUFFICIENT_SOURCE_DATA / REVERSAL_MEANING_UNRESOLVED (not a chosen policy)', () => {
  const r = run([call('c1', '2024-03-10', 500000), call('c3', '2024-12-01', 40000), call('c3r', '2025-02-01', -40000, { reversalOfId: 'c3' })], NAV(600000), '2026-03-31');
  assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA'); assert.ok(!('rate' in r));
  assert.ok(r.reasonCodes.includes('REVERSAL_MEANING_UNRESOLVED'));
  assert.equal(r.issues.find((i) => i.code === 'REVERSAL_MEANING_UNRESOLVED').detail, 'date-differs-from-original');
});
t('reversal with missing original / non-exact negation / original not paid / reversal of reversal => unresolved', () => {
  const mk = (extra, rev) => run([call('c1', '2024-03-10', 500000), ...extra, rev], NAV(600000), '2026-03-31');
  const cases = {
    'original-not-found': mk([], call('r', '2024-12-01', -40000, { reversalOfId: 'zzz' })),
    'amount-is-not-exact-negation': mk([call('c3', '2024-12-01', 40000)], call('r', '2024-12-01', -39000, { reversalOfId: 'c3' })),
    'original-not-paid': mk([call('c3', '2024-12-01', 40000, { status: 'approved' })], call('r', '2024-12-01', -40000, { reversalOfId: 'c3' })),
    'original-is-itself-a-reversal': mk([call('c3', '2024-12-01', -40000, { reversalOfId: 'c9' }), call('c9', '2024-12-01', 40000)], call('r', '2024-12-01', 40000, { reversalOfId: 'c3' })),
  };
  for (const [why, r] of Object.entries(cases)) {
    assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA', why); assert.ok(r.issues.some((i) => i.code === 'REVERSAL_MEANING_UNRESOLVED' && i.detail === why), why + ' ' + JSON.stringify(r.issues));
  }
});
t('negative amount without reversalOfId is rejected (no abs())', () => {
  const r = run([call('c1', '2024-03-10', 500000), call('bad', '2024-12-01', -40000)], NAV(600000));
  assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA'); assert.ok(r.reasonCodes.includes('NEGATIVE_AMOUNT_WITHOUT_REVERSAL'));
});
t('INTENDED DIFFERENCE (sign fix): legacy abs() mis-signs a reversal; new result equals the ledger without the pair', () => {
  const core = [call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 150000)];
  const asOf = '2026-03-31';
  const clean = run(core, NAV(450000), asOf).rate;
  // legacy construction: callDate-sorted, -Math.abs(call), +Math.abs(dist), NAV last
  const legacy = legacyXirr([{ date: '2024-03-10', amount: -500000 }, { date: '2024-12-01', amount: -40000 }, { date: '2024-12-01', amount: -Math.abs(-40000) }, { date: '2025-06-30', amount: 150000 }, { date: asOf, amount: 450000 }]);
  const fixed = run(core.concat([call('c3', '2024-12-01', 40000), call('c3r', '2024-12-01', -40000, { reversalOfId: 'c3' })]), NAV(450000), asOf).rate;
  assert.equal(fixed, clean); assert.ok(Math.abs(legacy - clean) > 1e-3, 'legacy should differ materially: ' + legacy + ' vs ' + clean);
});

/* ---------- source data: no substitution ---------- */
t('paid record with missing/invalid amount or date => no rate (never 0 / today)', () => {
  const bads = [
    [call('x', '2024-06-01', null), 'INVALID_AMOUNT'], [call('x', '2024-06-01', ''), 'INVALID_AMOUNT'], [call('x', '2024-06-01', 'abc'), 'INVALID_AMOUNT'], [call('x', '2024-06-01', NaN), 'INVALID_AMOUNT'],
    [call('x', '', 100), 'INVALID_DATE'], [call('x', undefined, 100), 'INVALID_DATE'], [call('x', '2024-02-30', 100), 'INVALID_DATE'], [dist('x', 'garbage', 100), 'INVALID_DATE'],
  ];
  for (const [rec, code] of bads) {
    const r = run([call('c1', '2024-03-10', 500000), rec], NAV(600000));
    assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA', code); assert.ok(!('rate' in r)); assert.ok(r.reasonCodes.includes(code), code);
  }
});
t('non-paid records (pending/approved/declared/waived/draft) are ignored, even with bad fields', () => {
  const base = run([call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 150000)], NAV(450000), '2026-03-31');
  const noisy = run([call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 150000),
    call('p1', 'bad', null, { status: 'pending' }), call('p2', '2024-01-01', 99999, { status: 'approved' }), call('w1', '2024-02-02', 5, { status: 'waived' }), dist('p3', '2024-05-05', 99999, { status: 'declared' })], NAV(450000), '2026-03-31');
  assert.equal(noisy.rate, base.rate);
});
t('flows dated after asOfDate are not used (and are reported)', () => {
  const base = run([call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 150000)], NAV(450000), '2026-03-31');
  const late = run([call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 150000), dist('f', '2026-04-01', 10 ** 7)], NAV(450000), '2026-03-31');
  assert.equal(late.rate, base.rate); assert.equal(late.excludedAfterAsOf, 1);
  assert.ok(late.sourceWarnings.some((w) => w.code === 'FLOWS_AFTER_ASOF_EXCLUDED'));
  assert.equal(base.excludedAfterAsOf, 0); assert.ok(!base.sourceWarnings.some((w) => w.code === 'FLOWS_AFTER_ASOF_EXCLUDED'));
});
t('a flow exactly on asOfDate is used', () => {
  const r = run([call('c1', '2025-01-01', 1000), dist('d1', '2026-01-01', 100)], NAV(1000), '2026-01-01');
  const ref = refRate([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }]);
  assert.ok(Math.abs(r.rate - ref) < 1e-9);
});
t('asOfDate is required and must be a real date; records must be an array; unknown policy rejected', () => {
  for (const a of [undefined, null, '', '2026-02-30', 'today', 20260101]) assert.equal(computePortfolioNetXirr({ asOfDate: a, records: [call('c', '2025-01-01', 1)], nav: NAV(2) }).status, 'INVALID_INPUT', String(a));
  assert.equal(computePortfolioNetXirr({ asOfDate: '2026-01-01', records: null, nav: NAV(1) }).status, 'INVALID_INPUT');
  assert.equal(run([call('c', '2025-01-01', 1)], NAV(2), '2026-01-01', {}, { inKindPolicy: 'GUESS' }).status, 'INVALID_INPUT');
  assert.equal(computePortfolioNetXirr(undefined).status, 'INVALID_INPUT');
});

/* ---------- NAV ---------- */
t('incomplete NAV => INSUFFICIENT_SOURCE_DATA with NAV_INCOMPLETE and NO rate key; NAV issues passed through', () => {
  const issues = [{ code: 'ASSET_BLOCKED', fundId: 'f1', assetId: 'bad' }];
  const r = run([call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 150000)], NAV(450000, false, issues), '2026-03-31');
  assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA'); assert.ok(!('rate' in r)); assert.ok(r.reasonCodes.includes('NAV_INCOMPLETE'));
  assert.deepEqual(r.navIssues, issues);
});
t('nav.complete must be strictly true; invalid NAV values rejected', () => {
  const recs = [call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 150000)];
  assert.equal(run(recs, { value: 1, complete: 'yes' }).status, 'INSUFFICIENT_SOURCE_DATA');
  assert.equal(run(recs, undefined).status, 'INSUFFICIENT_SOURCE_DATA');
  for (const v of [-1, NaN, null, '', 'x']) { const r = run(recs, NAV(v)); assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA'); assert.ok(r.reasonCodes.includes('NAV_INVALID'), String(v)); }
});
t('OK results always carry the NAV warnings; NAV valuation date is stated unknown; calc-date source adds its own warning', () => {
  const a = run([call('c1', '2025-01-01', 1000)], NAV(1100), '2026-01-01');
  const codes = a.sourceWarnings.map((w) => w.code);
  assert.ok(codes.includes('NAV_IS_UNDERWRITING_ESTIMATE') && codes.includes('NAV_VALUATION_DATE_UNKNOWN') && !codes.includes('ASOF_DATE_IS_CALCULATION_DATE'));
  const b = run([call('c1', '2025-01-01', 1000)], NAV(1100), '2026-01-01', { asOfDateSource: 'calculation-date' });
  assert.ok(b.sourceWarnings.some((w) => w.code === 'ASOF_DATE_IS_CALCULATION_DATE'));
  assert.equal(a.asOfDate, '2026-01-01');
});

/* ---------- in-kind ---------- */
t('in-kind call (inKindAssetId or linkedCommitmentId) => IN_KIND_VALUE_BASIS_UNRESOLVED by default, no rate', () => {
  for (const flag of [{ inKindAssetId: 'opp1' }, { linkedCommitmentId: 'cm1' }]) {
    const r = run([call('c1', '2024-03-10', 500000, flag), dist('d1', '2025-06-30', 150000)], NAV(450000), '2026-03-31');
    assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA'); assert.ok(r.reasonCodes.includes('IN_KIND_VALUE_BASIS_UNRESOLVED')); assert.ok(!('rate' in r));
  }
});
t('in-kind reversal (linkedCommitmentId cleared, inKindAssetId kept) is classified through its original', () => {
  const recs = [call('c0', '2024-01-01', 100), call('k1', '2024-03-10', 500000, { inKindAssetId: 'opp1', linkedCommitmentId: 'cm1' }), call('k1r', '2024-03-10', -500000, { reversalOfId: 'k1', inKindAssetId: 'opp1' })];
  const r = run(recs, NAV(200), '2026-03-31');
  assert.equal(r.status === 'OK' || r.status === 'NO_SIGN_CHANGE', true, r.status); // valid cancelled pair: nothing in-kind remains
  assert.ok(!(r.reasonCodes || []).includes('IN_KIND_VALUE_BASIS_UNRESOLVED'));
  const byId = new Map([['k1', recs[1]]]);
  assert.equal(isInKindCall({ reversalOfId: 'k1' }, byId), true); assert.equal(isInKindCall({ reversalOfId: 'nope' }, byId), true); assert.equal(isInKindCall({}, byId), false);
});
t('optional policy INCLUDE_AT_LEDGER_AMOUNT computes, with an explicit warning (not the default)', () => {
  const recs = [call('k1', '2024-03-10', 500000, { inKindAssetId: 'opp1' }), dist('d1', '2025-06-30', 150000)];
  const r = run(recs, NAV(450000), '2026-03-31', {}, { inKindPolicy: 'INCLUDE_AT_LEDGER_AMOUNT' });
  assert.equal(r.status, 'OK'); assert.ok(r.sourceWarnings.some((w) => w.code === 'IN_KIND_CALLS_INCLUDED_AT_LEDGER_AMOUNT'));
});

/* ---------- solver detail is preserved ---------- */
t('multiple roots: status POSSIBLE_MULTIPLE_ROOTS, no rate, roots kept in the result', () => {
  // -100 @2025-01-01, +230 @2026-01-01, -132 @2027-01-01 (NAV 0, so the last call is the final flow)
  const r = run([call('c1', '2025-01-01', 100), dist('d1', '2026-01-01', 230), call('c2', '2027-01-01', 132)], NAV(0), '2027-01-01');
  assert.equal(r.status, 'POSSIBLE_MULTIPLE_ROOTS'); assert.ok(!('rate' in r));
  assert.ok(Array.isArray(r.roots) && r.roots.length === 2, JSON.stringify(r.roots));
  assert.ok(r.roots.some((x) => Math.abs(x - 0.1) < 1e-6) && r.roots.some((x) => Math.abs(x - 0.2) < 1e-6));
});
t('no flows at all / only NAV => no rate, named status', () => {
  const r = run([], NAV(100), '2026-01-01');
  assert.ok(['INSUFFICIENT_INPUT', 'NO_SIGN_CHANGE', 'DEGENERATE_NO_TIME_SPREAD'].includes(r.status) && !('rate' in r), r.status);
});


/* ---------- Riyadh calendar day ---------- */
t('riyadhDateStr: day boundary differs from UTC between 21:00 and 24:00 UTC', () => {
  assert.equal(riyadhDateStr(new Date('2026-10-07T20:59:59Z')), '2026-10-07');
  assert.equal(riyadhDateStr(new Date('2026-10-07T21:00:00Z')), '2026-10-08'); // 00:00 in Riyadh
  assert.equal(riyadhDateStr(new Date('2026-10-07T23:30:00Z')), '2026-10-08'); // UTC date is still 10-07
  assert.equal(riyadhDateStr(new Date('2026-12-31T21:30:00Z')), '2027-01-01');  // year boundary
  assert.equal(riyadhDateStr(new Date('2028-02-28T22:00:00Z')), '2028-02-29');  // leap day
  for (const bad of [new Date('x'), 'now', null, 5]) assert.throws(() => riyadhDateStr(bad));
});
t('asOfDate stays an explicit input of the pure function: a flow dated on the Riyadh day is used or not depending only on asOfDate', () => {
  const recs = [call('c1', '2025-01-01', 1000), dist('d1', '2026-10-08', 100)];
  const a = run(recs, NAV(1000), '2026-10-07'), b = run(recs, NAV(1000), '2026-10-08');
  assert.equal(a.excludedAfterAsOf, 1); assert.equal(b.excludedAfterAsOf, 0);
  assert.notEqual(a.status === 'OK' ? a.rate : null, b.rate);
});

/* ---------- NAV basis ---------- */
t('NAV basis other than a residual value at asOfDate is refused (equity x MOIC = total projected proceeds)', () => {
  const recs = [call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 150000)];
  for (const basis of ['UNDERWRITING_TOTAL_PROJECTED_EQUITY_PROCEEDS', null, '', 'residual_value_as_of_date']) {
    const r = run(recs, NAV(450000, true, [], basis), '2026-03-31');
    assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA', String(basis)); assert.ok(!('rate' in r));
    assert.ok(r.reasonCodes.includes('NAV_BASIS_UNRESOLVED'), String(basis));
  }
  assert.equal(run(recs, NAV(450000, true, [], 'RESIDUAL_VALUE_AS_OF_DATE'), '2026-03-31').status, 'OK');
  // absence of linked assets is not proof of a zero residual value: neither old basis name is accepted
  for (const b of ['NONE_NO_LINKED_ASSETS', 'NO_LINKED_ASSETS_RESIDUAL_VALUE_UNKNOWN']) assert.ok(run([call('c1', '2024-03-10', 100), dist('d1', '2025-03-10', 130)], NAV(0, true, [], b), '2026-03-31').reasonCodes.includes('NAV_BASIS_UNRESOLVED'), b);
  assert.ok(run(recs, { value: 1, complete: true }, '2026-03-31').reasonCodes.includes('NAV_BASIS_UNRESOLVED'));
});

/* ---------- more reversal checks ---------- */
t('original used by more than one reversal => both reversals unresolved (original-reversed-more-than-once)', () => {
  const r = run([call('c1', '2024-03-10', 500000), call('c3', '2024-12-01', 40000), call('r1', '2024-12-01', -40000, { reversalOfId: 'c3' }), call('r2', '2024-12-01', -40000, { reversalOfId: 'c3' })], NAV(600000), '2026-03-31');
  assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA');
  const i = r.issues.find((x) => x.code === 'REVERSAL_MEANING_UNRESOLVED' && x.detail === 'original-reversed-more-than-once');
  assert.ok(i && i.ids.includes('capitalCall:r1') && i.ids.includes('capitalCall:r2'));
});
t('reversal must match record kind and fund of its original', () => {
  const rOther = run([call('c1', '2024-03-10', 500000), dist('x', '2024-12-01', 40000), call('r', '2024-12-01', -40000, { reversalOfId: 'x' })], NAV(600000), '2026-03-31');
  assert.ok(rOther.issues.some((i) => i.detail === 'original-of-other-record-kind'));
  const rFund = run([call('c1', '2024-03-10', 500000), call('c3', '2024-12-01', 40000, { fundId: 'f2' }), call('r', '2024-12-01', -40000, { reversalOfId: 'c3' })], NAV(600000), '2026-03-31');
  assert.ok(rFund.issues.some((i) => i.detail === 'original-in-other-fund'));
});
t('reversal dated after asOfDate whose original is inside the window is unresolved (not silently ignored)', () => {
  const r = run([call('c1', '2024-03-10', 500000), call('c3', '2024-12-01', 40000), call('r', '2026-05-01', -40000, { reversalOfId: 'c3' })], NAV(600000), '2026-03-31');
  assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA');
  assert.ok(r.issues.some((i) => i.detail === 'reversal-dated-after-asof-original-inside-window'));
});
t('valid cancelled pairs are removed from the flows: cashflowCount equals the ledger without the pair', () => {
  const core = [call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 150000)];
  const a = run(core, NAV(450000), '2026-03-31'), b = run([...core, call('c3', '2024-12-01', 40000), call('c3r', '2024-12-01', -40000, { reversalOfId: 'c3' })], NAV(450000), '2026-03-31');
  assert.equal(b.cashflowCount, a.cashflowCount); assert.equal(b.rate, a.rate);
});

/* ---------- in-kind: a correctly cancelled in-kind pair does not block the rest ---------- */
t('fully cancelled in-kind pair (original + valid same-date reversal) does not block; remaining flows are computed', () => {
  const core = [call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 700000)];
  const inkind = [call('k1', '2024-05-01', 2000000, { inKindAssetId: 'opp1', linkedCommitmentId: 'cm1' }), call('k1r', '2024-05-01', -2000000, { reversalOfId: 'k1', inKindAssetId: 'opp1', linkedCommitmentId: null })];
  const a = run(core, NAV(0), '2026-03-31'), b = run([...core, ...inkind], NAV(0), '2026-03-31');
  assert.equal(b.status, 'OK'); assert.equal(b.rate, a.rate);
  assert.ok(!b.issues);
});
t('in-kind original with an INVALID reversal (different date) stays blocked, with both reasons', () => {
  const core = [call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 700000)];
  const r = run([...core, call('k1', '2024-05-01', 2000000, { inKindAssetId: 'opp1' }), call('k1r', '2024-08-01', -2000000, { reversalOfId: 'k1', inKindAssetId: 'opp1' })], NAV(0), '2026-03-31');
  assert.ok(r.reasonCodes.includes('REVERSAL_MEANING_UNRESOLVED') && r.reasonCodes.includes('IN_KIND_VALUE_BASIS_UNRESOLVED'));
});
t('an in-kind call outside any cancelled pair still blocks even when another in-kind pair is cancelled', () => {
  const core = [call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 700000), call('k2', '2024-06-01', 100, { inKindAssetId: 'o2' })];
  const r = run([...core, call('k1', '2024-05-01', 2000000, { inKindAssetId: 'o1' }), call('k1r', '2024-05-01', -2000000, { reversalOfId: 'k1', inKindAssetId: 'o1' })], NAV(0), '2026-03-31');
  assert.deepEqual(r.issues.find((i) => i.code === 'IN_KIND_VALUE_BASIS_UNRESOLVED').ids, ['capitalCall:k2']);
});

/* ---------- ledger dates wording ---------- */
t('every computed result carries LEDGER_DATES_ARE_RECORD_DATES (record dates, not proven payment dates)', () => {
  const r = run([call('c1', '2025-01-01', 1000)], NAV(1100), '2026-01-01');
  const w = r.sourceWarnings.find((x) => x.code === 'LEDGER_DATES_ARE_RECORD_DATES');
  assert.ok(w && /callDate/.test(w.message) && /distDate/.test(w.message) && /not establish/.test(w.message));
  assert.ok(!/actual payment date\b(?! or)/.test(w.message.replace('actual payment or settlement dates', '')));
});

/* ---------- id collisions between collections (ids are unique per collection only) ---------- */
t('REGRESSION: a call and a distribution sharing an id — the cancelled call pair never removes or flags the distribution', () => {
  const base = [call('c1', '2024-03-10', 500000), dist('X', '2025-06-30', 150000)];
  const withPair = [...base, call('X', '2024-12-01', 40000), call('Xr', '2024-12-01', -40000, { reversalOfId: 'X' })];
  const a = run(base, NAV(450000), '2026-03-31'), b = run(withPair, NAV(450000), '2026-03-31');
  assert.equal(b.status, 'OK'); assert.equal(b.cashflowCount, a.cashflowCount); assert.equal(b.rate, a.rate);
  assert.ok(a.cashflowCount === 3); // call c1, distribution X, NAV
});
t('REGRESSION: a distribution reversal pairs with the distribution of that id, not with a call of the same id', () => {
  const calls = [call('c1', '2024-03-10', 500000), call('X', '2024-12-01', 40000)];
  const a = run([...calls, dist('d1', '2025-06-30', 150000)], NAV(450000), '2026-03-31');
  const b = run([...calls, dist('d1', '2025-06-30', 150000), dist('X', '2025-12-01', 777), dist('Yr', '2025-12-01', -777, { reversalOfId: 'X' })], NAV(450000), '2026-03-31');
  assert.equal(b.status, 'OK'); assert.equal(b.rate, a.rate);
});
t('REGRESSION: a reversal whose original id exists only in the other collection is unresolved (original-of-other-record-kind)', () => {
  const r = run([call('c1', '2024-03-10', 500000), dist('X', '2024-12-01', 40000), call('r', '2024-12-01', -40000, { reversalOfId: 'X' })], NAV(600000), '2026-03-31');
  assert.ok(r.issues.some((i) => i.detail === 'original-of-other-record-kind' && i.ids[0] === 'capitalCall:r'));
});
t('REGRESSION: an in-kind call does not flag a distribution with the same id; issue ids are kind-qualified', () => {
  const r = run([call('c1', '2024-03-10', 500000), call('X', '2024-05-01', 100, { inKindAssetId: 'o1' }), dist('X', '2025-06-30', 150000)], NAV(450000), '2026-03-31');
  assert.deepEqual(r.issues.find((i) => i.code === 'IN_KIND_VALUE_BASIS_UNRESOLVED').ids, ['capitalCall:X']);
});
t('the same id twice inside ONE collection is ambiguous for reversal matching => DUPLICATE_RECORD_ID, no rate', () => {
  const r = run([call('c1', '2024-03-10', 500000), call('dup', '2024-12-01', 40000), call('dup', '2024-12-02', 50000)], NAV(600000), '2026-03-31');
  assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA'); assert.deepEqual(r.issues.find((i) => i.code === 'DUPLICATE_RECORD_ID').ids, ['capitalCall:dup']);
  const ok = run([call('same', '2024-03-10', 500000), dist('same', '2025-06-30', 150000)], NAV(450000), '2026-03-31');
  assert.equal(ok.status, 'OK'); // same id across the two collections is normal
});

/* ---------- source warnings are tied to the NAV's actual source and appear on every result ---------- */
t('NAV warnings follow the declared NAV source: underwriting => NAV_IS_UNDERWRITING_ESTIMATE; other source => NAV_SOURCE_DECLARED only; none => NAV_SOURCE_UNDECLARED', () => {
  const recs = [call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 150000)];
  const codes = (nav) => run(recs, nav, '2026-03-31').sourceWarnings.map((w) => w.code);
  assert.ok(codes(NAV(450000)).includes('NAV_IS_UNDERWRITING_ESTIMATE'));
  const ind = codes(NAV(450000, true, [], 'RESIDUAL_VALUE_AS_OF_DATE', 'INDEPENDENT_VALUATION_2026Q1'));
  assert.ok(ind.includes('NAV_SOURCE_DECLARED') && !ind.includes('NAV_IS_UNDERWRITING_ESTIMATE'));
  const none = codes({ value: 450000, complete: true, basis: 'RESIDUAL_VALUE_AS_OF_DATE' });
  assert.ok(none.includes('NAV_SOURCE_UNDECLARED') && !none.includes('NAV_IS_UNDERWRITING_ESTIMATE'));
});
t('NAV valuation date: supplied real date removes NAV_VALUATION_DATE_UNKNOWN and is echoed; invalid date does not', () => {
  const recs = [call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 150000)];
  const withDate = run(recs, { ...NAV(450000), valuationDate: '2026-03-15' }, '2026-03-31');
  assert.equal(withDate.navValuationDate, '2026-03-15'); assert.ok(!withDate.sourceWarnings.some((w) => w.code === 'NAV_VALUATION_DATE_UNKNOWN'));
  for (const bad of ['2026-02-30', 'x', '', null]) assert.ok(run(recs, { ...NAV(450000), valuationDate: bad }, '2026-03-31').sourceWarnings.some((w) => w.code === 'NAV_VALUATION_DATE_UNKNOWN'), String(bad));
});
t('a BLOCKED result also carries sourceWarnings (record dates, NAV source, valuation date, calculation-date source) and the as-of date', () => {
  const r = run([call('c1', '2024-03-10', 500000)], NAV(1, true, [], 'UNDERWRITING_TOTAL_PROJECTED_EQUITY_PROCEEDS'), '2026-03-31', { asOfDateSource: 'calculation-date' });
  assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA'); assert.equal(r.asOfDate, '2026-03-31');
  const c = r.sourceWarnings.map((w) => w.code);
  for (const k of ['LEDGER_DATES_ARE_RECORD_DATES', 'NAV_IS_UNDERWRITING_ESTIMATE', 'NAV_VALUATION_DATE_UNKNOWN', 'ASOF_DATE_IS_CALCULATION_DATE']) assert.ok(c.includes(k), k);
});

/* ---------- purity ---------- */
t('deterministic and does not mutate its input', () => {
  const input = { asOfDate: '2026-03-31', records: [call('c1', '2024-03-10', 500000), dist('d1', '2025-06-30', 150000)], nav: NAV(450000) };
  const snap = JSON.stringify(input);
  const a = computePortfolioNetXirr(input), b = computePortfolioNetXirr(input);
  assert.deepEqual(a, b); assert.equal(JSON.stringify(input), snap);
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
