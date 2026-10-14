/* XIRR-P display & consumer tests — Portfolio Net XIRR in the real core + real feature modules.
   Run: node tests/features/portfolio-net-xirr.test.mjs   (exit 0 only if all pass)
   Covers: wiring (ledger -> shared solver), NAV completeness (blocked / missing / uncomputable assets), reversal and
   in-kind handling through the real ledger shapes, the Net XIRR cell (no percent unless status OK, solver roots kept),
   and the other consumers of portfolioIntelligenceStats (alert-center, concentration-risk, command-center,
   institutional-investment-intelligence): netIRR=null must not become 0 nor create a performance alert. */
import assert from 'assert/strict';
import { loadCore } from '../domain/core-vm-harness.mjs';
import { netXirrHtml, netXirrInput, portfolioIntelligenceStats } from '../../src/features/portfolio.js';
import { isInKindCall, computePortfolioNetXirr } from '../../src/domain/financial/xirr/portfolio-xirr.js';
import { buildAlertModel } from '../../src/features/alert-center.js';

globalThis.document ??= { addEventListener() {}, querySelector() { return null; }, getElementById() { return null; }, querySelectorAll() { return []; }, documentElement: { lang: 'ar' }, body: {}, createElement() { return {}; } };
globalThis.window ??= globalThis;

let passed = 0, failed = 0;
const pending = [];
function check(name, fn) {
  const ok = () => { passed += 1; console.log('PASS  ' + name); };
  const bad = (e) => { failed += 1; console.log('FAIL  ' + name + '\n      ' + String(e && e.message || e).split('\n')[0]); };
  try { const r = fn(); if (r && typeof r.then === 'function') pending.push(r.then(ok, bad)); else ok(); } catch (e) { bad(e); }
}
const clone = (o) => JSON.parse(JSON.stringify(o));
function set(o, p, v) { const a = p.split('.'); let x = o; for (let i = 0; i < a.length - 1; i++) x = x[a[i]]; x[a.at(-1)] = v; }

const FEATURES = ['automated-ic-memo', 'audit-trail', 'pipeline', 'due-diligence', 'data-quality', 'risk-engine', 'investment-score', 'ic-workflow', 'max-acquisition-price', 'xirr-comparison-panel', 'input-validation-panel', 'negotiation', 'scenario-manager', 'comparables', 'valuation-engine', 'evidence-tracking', 'portfolio', 'concentration-risk', 'benchmark-engine', 'alerts', 'command-center', 'ai-analyst', 'data-room', 'ic-book-print', 'excel-workbook', 'ic-presentation', 'roles-permissions', 'space-efficiency-library', 'exit-channels', 'feasibility-levers', 'cost-distribution-library', 'fund-fees-opex-library', 'opportunities-map', 'saudi-regulatory-library', 'rent-roll', 'macro-context', 'sustainability-mostadam', 'ic-decision-gate', 'underwriting-versions', 'cash-flow-timing', 'institutional-hardening', 'capital-allocation-engine', 'monday-integration', 'institutional-investment-intelligence'];
const EXPORTS = ['opportunities', '_bodyViewHooks', '_mainViews', 'STORE', 'oppMetricGuard', 'setCoreState', 'isInKindCapitalCall', 'renderDetail', '_detailSectionHooks'];

async function makeCore() {
  const C = loadCore(EXPORTS);
  for (const f of FEATURES) {
    const m = await import('../../src/features/' + f + '.js');
    const fn = Object.entries(m).find(([k, v]) => typeof v === 'function' && k.startsWith('register'));
    assert.ok(fn, 'no register fn in ' + f);
    fn[1](C);
  }
  return C;
}
function sane(C, type, over) {
  const o = clone(C.blankOpportunity());
  const S = { 'meta.oppType': type, 'meta.tier': 'متوسط', 'meta.useType': '__neutral__', 'meta.city': 'الرياض', 'land.floorHeight': 3.6, 'land.area': 5000, 'land.price': 2000, 'land.far': 2, 'land.bar': 0.5, 'land.basements': 0, 'development.buildCost': 3000, 'development.salePrice': 9000, 'development.efficiency': 0.85, 'development.contingency': 0.05, 'development.constructionYears': 2, 'development.operationYears': 0, 'development.scopeType': 'both', 'strategy.salePct': 1, 'financing.ltc': 0.6, 'financing.saibor': 0.055, 'financing.margin': 0.025, 'financing.interestDuringConstruction': 'cash', ...over };
  for (const k of ['soil', 'water', 'tower', 'topo', 'infra']) set(o, 'site.' + k, 1);
  for (const [k, v] of Object.entries(S)) set(o, k, v);
  return o;
}
const call = (id, date, amount, extra = {}) => ({ id, data: { fundId: 'f1', investorId: 'i1', callNumber: 1, callDate: date, amount, status: 'paid', linkedCommitmentId: null, reversalOfId: null, ...extra } });
const dist = (id, date, amount, extra = {}) => ({ id, data: { fundId: 'f1', investorId: 'i1', distDate: date, amount, status: 'paid', reversalOfId: null, ...extra } });

/* world: two sane assets linked to f1; ledger configurable. */
async function world({ calls = [], dists = [], assetIds = [], extraOpps = [] } = {}) {
  const C = await makeCore();
  C.opportunities.push(
    { id: 's1', data: sane(C, 'development', { 'meta.name': 'S1' }) },
    { id: 's2', data: sane(C, 'development', { 'meta.name': 'S2', 'land.price': 2600, 'development.buildCost': 3300, 'financing.ltc': 0.5 }) },
    ...extraOpps.map((fn) => fn(C)),
  );
  C.STORE.funds.push({ id: 'f1', data: { name: 'F1', assetIds } });
  C.STORE.capitalCalls.push(...calls);
  C.STORE.distributions.push(...dists);
  return C;
}
const GOOD_CALLS = () => [call('c1', '2024-03-10', 5000000), call('c2', '2024-09-20', 3000000)];
const GOOD_DISTS = () => [dist('d1', '2025-06-30', 9000000), dist('d2', '2026-03-01', 1500000)];
const ASSETS = ['s1', 's2'];
const stats = (C, o) => portfolioIntelligenceStats(C, o);
const RIYADH_EDGE = new Date('2026-10-07T21:30:00Z'); // 00:30 on 2026-10-08 in Riyadh, still 2026-10-07 in UTC
const html = (C, key) => C._mainViews[key]();
// TEST-ONLY override: identical ledger->records->solver wiring as production, but declares a residual-value basis, which the UI
// never does (the system has no residual-value source). It lets the numeric wiring be verified while the UI stays blocked.
const viaResidual = (C, o) => { const s = stats(C, o); const input = netXirrInput(C, C.STORE.funds, s.nav, o); input.nav = { ...input.nav, basis: 'RESIDUAL_VALUE_AS_OF_DATE' }; return computePortfolioNetXirr(input); };
const ONLY_BASIS = ['NAV_BASIS_UNRESOLVED'];
const rowOf = (h) => (h.match(/data-netxirr-status="([^"]+)"/) || [])[1];
function refRate(flows) {
  const t0 = Math.min(...flows.map((f) => Date.parse(f.date + 'T00:00:00Z')));
  const npv = (r) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, (Date.parse(f.date + 'T00:00:00Z') - t0) / 86400000 / 365), 0);
  let lo = -0.99, hi = 1000, flo = npv(lo);
  for (let i = 0; i < 400; i++) { const mid = (lo + hi) / 2, fm = npv(mid); if (flo * fm <= 0) hi = mid; else { lo = mid; flo = fm; } }
  return (lo + hi) / 2;
}

const A = await world({ calls: GOOD_CALLS(), dists: GOOD_DISTS() });
const sA = stats(A, { asOfDate: '2026-06-30' });
const rA = viaResidual(A, { asOfDate: '2026-06-30' });

check('wiring (ledger -> records -> shared solver, residual basis declared by the test): matches an independent bisection; the UI stays blocked on NAV basis only', () => {
  assert.equal(rA.status, 'OK');
  assert.equal(sA.nav, 0); assert.equal(rA.navValue, 0);
  assert.equal(sA.netXirr.status, 'INSUFFICIENT_SOURCE_DATA'); assert.deepEqual(sA.netXirr.reasonCodes, ONLY_BASIS); assert.equal(sA.netIRR, null);
  const ref = refRate([{ date: '2024-03-10', amount: -5000000 }, { date: '2024-09-20', amount: -3000000 }, { date: '2025-06-30', amount: 9000000 }, { date: '2026-03-01', amount: 1500000 }, { date: '2026-06-30', amount: 0 }]);
  assert.ok(Math.abs(rA.rate - ref) < 1e-7, rA.rate + ' vs ' + ref);
});
check('asOfDate: explicit => no calculation-date warning; omitted => Riyadh calendar day and ASOF_DATE_IS_CALCULATION_DATE', () => {
  assert.ok(!sA.netXirr.sourceWarnings.some((w) => w.code === 'ASOF_DATE_IS_CALCULATION_DATE'));
  const s = stats(A, { now: RIYADH_EDGE });
  assert.equal(s.netXirr.asOfDate, '2026-10-08'); // UTC would say 2026-10-07
  assert.ok(s.netXirr.sourceWarnings.some((w) => w.code === 'ASOF_DATE_IS_CALCULATION_DATE'));
  assert.ok(s.netXirr.sourceWarnings.some((w) => w.code === 'NAV_VALUATION_DATE_UNKNOWN'));
});
check('only paid records count: pending/approved/waived/declared rows (even with bad fields) do not change the result', async () => {
  const B = await world({ calls: [...GOOD_CALLS(), call('p1', 'bad', null, { status: 'pending' }), call('p2', '2024-01-01', 999, { status: 'approved' }), call('w1', '2024-02-02', 5, { status: 'waived' })], dists: [...GOOD_DISTS(), dist('x', '2025-01-01', 77, { status: 'declared' })] });
  assert.equal(viaResidual(B, { asOfDate: '2026-06-30' }).rate, rA.rate);
});
check('same-date reversal pair through the ledger: identical result; legacy abs() would have changed it', async () => {
  const B = await world({ calls: [...GOOD_CALLS(), call('c3', '2024-12-01', 400000), call('c3r', '2024-12-01', -400000, { reversalOfId: 'c3' })], dists: GOOD_DISTS() });
  assert.equal(viaResidual(B, { asOfDate: '2026-06-30' }).rate, rA.rate);
  assert.deepEqual(stats(B, { asOfDate: '2026-06-30' }).netXirr.reasonCodes, ONLY_BASIS); // the pair raises no ledger issue
});
check('reversal dated later than its original => INSUFFICIENT_SOURCE_DATA (REVERSAL_MEANING_UNRESOLVED), netIRR null', async () => {
  const B = await world({ calls: [...GOOD_CALLS(), call('c3', '2024-12-01', 400000), call('c3r', '2025-03-01', -400000, { reversalOfId: 'c3' })], dists: GOOD_DISTS() });
  const s = stats(B, { asOfDate: '2026-06-30' });
  assert.equal(s.netXirr.status, 'INSUFFICIENT_SOURCE_DATA'); assert.ok(s.netXirr.reasonCodes.includes('REVERSAL_MEANING_UNRESOLVED')); assert.equal(s.netIRR, null);
});
check('paid in-kind call (linkedCommitmentId / inKindAssetId) => IN_KIND_VALUE_BASIS_UNRESOLVED, netIRR null', async () => {
  const B = await world({ calls: [...GOOD_CALLS(), call('k1', '2024-05-01', 2000000, { inKindAssetId: 's1', linkedCommitmentId: 'cm1' })], dists: GOOD_DISTS() });
  const s = stats(B, { asOfDate: '2026-06-30' });
  assert.equal(s.netXirr.status, 'INSUFFICIENT_SOURCE_DATA'); assert.ok(s.netXirr.reasonCodes.includes('IN_KIND_VALUE_BASIS_UNRESOLVED')); assert.equal(s.netIRR, null);
});
check('paid record with invalid date / missing amount => no rate (not 0, not today)', async () => {
  for (const [rec, code] of [[call('b1', '2024-02-31', 1000), 'INVALID_DATE'], [call('b2', '2024-05-01', null), 'INVALID_AMOUNT'], [dist('b3', '', 100), 'INVALID_DATE']]) {
    const B = await world({ calls: [...GOOD_CALLS(), rec], dists: GOOD_DISTS() });
    const s = stats(B, { asOfDate: '2026-06-30' });
    assert.equal(s.netXirr.status, 'INSUFFICIENT_SOURCE_DATA', code); assert.ok(s.netXirr.reasonCodes.includes(code), code); assert.equal(s.netIRR, null);
  }
});
check('flows dated after asOfDate are excluded from the calculation', async () => {
  const B = await world({ calls: GOOD_CALLS(), dists: [...GOOD_DISTS(), dist('late', '2027-01-01', 9e9)] });
  const r = viaResidual(B, { asOfDate: '2026-06-30' });
  assert.equal(r.rate, rA.rate); assert.equal(r.excludedAfterAsOf, 1);
});


check('Riyadh/UTC day boundary: at 21:30Z the as-of day is Riyadh 10-08 (UTC date 10-07); at 20:59Z it is 10-07; a flow on 10-08 flips accordingly', async () => {
  const W = await world({ calls: [call('c1', '2025-01-01', 1000)], dists: [dist('d1', '2026-10-08', 1100)] });
  const at = (iso) => stats(W, { now: new Date(iso) });
  const hi = at('2026-10-07T21:30:00Z'), lo = at('2026-10-07T20:59:59Z');
  assert.equal(hi.netXirr.asOfDate, '2026-10-08'); assert.equal(lo.netXirr.asOfDate, '2026-10-07');
  assert.equal(hi.netXirr.excludedAfterAsOf, 0); assert.equal(lo.netXirr.excludedAfterAsOf, 1);
  assert.equal(viaResidual(W, { now: new Date('2026-10-07T21:30:00Z') }).status, 'OK'); assert.notEqual(viaResidual(W, { now: new Date('2026-10-07T20:59:59Z') }).status, 'OK');
  assert.ok(hi.netXirr.sourceWarnings.some((w) => w.code === 'ASOF_DATE_IS_CALCULATION_DATE' && /Riyadh/.test(w.message)));
  // an explicit asOfDate always wins over the clock
  assert.equal(stats(W, { asOfDate: '2026-10-07', now: new Date('2026-10-07T23:59:00Z') }).netXirr.asOfDate, '2026-10-07');
});
check('NAV basis: any linked asset => NAV_BASIS_UNRESOLVED, no rate (equity x MOIC is total projected proceeds, not a remaining value)', async () => {
  const W = await world({ calls: GOOD_CALLS(), dists: GOOD_DISTS(), assetIds: ASSETS });
  const s = stats(W, { asOfDate: '2026-06-30' });
  assert.ok(s.nav > 0);
  assert.equal(s.netXirr.status, 'INSUFFICIENT_SOURCE_DATA'); assert.deepEqual(s.netXirr.reasonCodes, ['NAV_BASIS_UNRESOLVED']);
  assert.equal(s.netXirr.issues[0].detail, 'UNDERWRITING_TOTAL_PROJECTED_EQUITY_PROCEEDS'); assert.ok(!('rate' in s.netXirr)); assert.equal(s.netIRR, null);
  assert.equal(rowOf(html(W, 'portfolio')), 'INSUFFICIENT_SOURCE_DATA');
});
check('in-kind pair fully cancelled by a valid reversal (real ledger shapes) does not block the remaining flows', async () => {
  const W = await world({ calls: [...GOOD_CALLS(), call('k1', '2024-05-01', 2000000, { inKindAssetId: 's1', linkedCommitmentId: 'cm1' }), call('k1r', '2024-05-01', -2000000, { reversalOfId: 'k1', inKindAssetId: 's1', linkedCommitmentId: null })], dists: GOOD_DISTS() });
  const s = stats(W, { asOfDate: '2026-06-30' });
  assert.deepEqual(s.netXirr.reasonCodes, ONLY_BASIS); // the cancelled in-kind pair raises no in-kind issue
  const r = viaResidual(W, { asOfDate: '2026-06-30' });
  assert.equal(r.status, 'OK'); assert.equal(r.rate, rA.rate);
});
check('source warnings (record dates, NAV source, valuation date) are on blocked AND computed results and shown by BOTH views, with the as-of date', () => {
  for (const x of [sA.netXirr, rA]) for (const c of ['LEDGER_DATES_ARE_RECORD_DATES', 'NAV_IS_UNDERWRITING_ESTIMATE', 'NAV_VALUATION_DATE_UNKNOWN']) assert.ok(x.sourceWarnings.some((w) => w.code === c), c);
  const asOfNow = A.todayStr();
  for (const key of ['portfolio', 'commandCenter']) {
    const h = html(A, key);
    assert.equal(rowOf(h), 'INSUFFICIENT_SOURCE_DATA', key);
    assert.ok(/data-netxirr-asof="\d{4}-\d{2}-\d{2}"/.test(h), key + ': as-of date missing');
    for (const c of ['LEDGER_DATES_ARE_RECORD_DATES', 'NAV_IS_UNDERWRITING_ESTIMATE', 'NAV_VALUATION_DATE_UNKNOWN', 'ASOF_DATE_IS_CALCULATION_DATE', 'NAV_BASIS_UNRESOLVED']) assert.ok(h.includes(c), key + ' lacks ' + c);
  }
  const ok = netXirrHtml(A, { netXirr: rA });
  assert.equal(rowOf(ok), 'OK'); assert.ok(ok.includes('data-netxirr-asof="2026-06-30"') && ok.includes('LEDGER_DATES_ARE_RECORD_DATES') && ok.includes(A.fmtPct(rA.rate)));
});
check('regression — absence of links is NOT proof of a zero residual value: a fund with no linked assets is still blocked (NAV_BASIS_UNRESOLVED)', () => {
  assert.equal(sA.netXirr.issues[0].detail, 'NO_LINKED_ASSETS_RESIDUAL_VALUE_UNKNOWN');
  assert.equal(sA.netIRR, null);
});
check('regression — call/distribution id collision: same id in both collections never cancels or flags the wrong record', async () => {
  // call X + its valid reversal pair; distribution X (same id!) must stay in the flows and must not be dropped or flagged
  const W = await world({ calls: [...GOOD_CALLS(), call('X', '2024-12-01', 400000), call('Xr', '2024-12-01', -400000, { reversalOfId: 'X' })], dists: [...GOOD_DISTS(), dist('X', '2025-12-01', 123456)] });
  const ref = await world({ calls: GOOD_CALLS(), dists: [...GOOD_DISTS(), dist('X', '2025-12-01', 123456)] });
  const r = viaResidual(W, { asOfDate: '2026-06-30' }), q = viaResidual(ref, { asOfDate: '2026-06-30' });
  assert.equal(r.status, 'OK'); assert.equal(r.cashflowCount, q.cashflowCount); assert.equal(r.rate, q.rate);
  assert.notEqual(r.rate, rA.rate); // the distribution X really counted
  assert.deepEqual(stats(W, { asOfDate: '2026-06-30' }).netXirr.reasonCodes, ONLY_BASIS);
  // a distribution reversal 'Yr' -> 'X' pairs with the distribution X, never with the call X
  const V = await world({ calls: [...GOOD_CALLS(), call('X', '2024-12-01', 400000)], dists: [...GOOD_DISTS(), dist('X', '2025-12-01', 123456), dist('Yr', '2025-12-01', -123456, { reversalOfId: 'X' })] });
  const rv = viaResidual(V, { asOfDate: '2026-06-30' }), qv = viaResidual(await world({ calls: [...GOOD_CALLS(), call('X', '2024-12-01', 400000)], dists: GOOD_DISTS() }), { asOfDate: '2026-06-30' });
  assert.equal(rv.status, 'OK'); assert.equal(rv.rate, qv.rate);
});
check('reversal pairing through the ledger: one original reversed twice, or reversal in another fund => blocked', async () => {
  const dup = await world({ calls: [...GOOD_CALLS(), call('c3', '2024-12-01', 400000), call('r1', '2024-12-01', -400000, { reversalOfId: 'c3' }), call('r2', '2024-12-01', -400000, { reversalOfId: 'c3' })], dists: GOOD_DISTS() });
  const s = stats(dup, { asOfDate: '2026-06-30' });
  assert.equal(s.netIRR, null); assert.ok(s.netXirr.issues.some((i) => i.detail === 'original-reversed-more-than-once'));
});

/* ---- NAV completeness ---- */
const badOpp = (C) => ({ id: 'bad', data: sane(C, 'development', { 'meta.name': 'BAD', 'strategy.salePct': 7 }) });
check('blocked asset in a fund => NAV_INCOMPLETE, no main rate (flows still contain that fund\'s contributions)', async () => {
  const B = await world({ calls: GOOD_CALLS(), dists: GOOD_DISTS(), assetIds: ['s1', 's2', 'bad'], extraOpps: [badOpp] });
  const s = stats(B, { asOfDate: '2026-06-30' });
  assert.equal(s.blockedN, 1);
  assert.equal(s.netXirr.status, 'INSUFFICIENT_SOURCE_DATA'); assert.ok(s.netXirr.reasonCodes.includes('NAV_INCOMPLETE'));
  assert.ok(!('rate' in s.netXirr)); assert.equal(s.netIRR, null);
  assert.deepEqual(s.netXirr.navIssues, [{ code: 'ASSET_BLOCKED', fundId: 'f1', assetId: 'bad' }]);
});
check('linked asset id with no opportunity record => NAV_INCOMPLETE (ASSET_RECORD_MISSING)', async () => {
  const B = await world({ calls: GOOD_CALLS(), dists: GOOD_DISTS(), assetIds: ['s1', 's2', 'ghost'] });
  const s = stats(B, { asOfDate: '2026-06-30' });
  assert.equal(s.netIRR, null); assert.deepEqual(s.netXirr.navIssues, [{ code: 'ASSET_RECORD_MISSING', fundId: 'f1', assetId: 'ghost' }]);
});
check('fund without linked assets: NAV is complete (no NAV_INCOMPLETE) but its basis stays unresolved — no rate', async () => {
  const B = await world({ calls: [call('c1', '2024-03-10', 100)], dists: [dist('d1', '2025-03-10', 130)], assetIds: [] });
  const s = stats(B, { asOfDate: '2026-06-30' });
  assert.deepEqual(s.netXirr.reasonCodes, ONLY_BASIS); assert.equal(s.netIRR, null);
});

/* ---- display ---- */
check('portfolio view: blocked shows status text and NO percentage in the Net IRR cell; the helper shows a percentage for OK', async () => {
  const hOk = html(A, 'portfolio');
  assert.equal(rowOf(hOk), 'INSUFFICIENT_SOURCE_DATA');
  const B = await world({ calls: [...GOOD_CALLS(), call('b1', '2024-02-31', 1000)], dists: GOOD_DISTS() });
  const hBad = html(B, 'portfolio');
  assert.equal(rowOf(hBad), 'INSUFFICIENT_SOURCE_DATA');
  const cell = hBad.slice(hBad.indexOf('data-netxirr-status'), hBad.indexOf('data-netxirr-status') + 1400);
  assert.ok(!/\d+(\.\d+)?\s*%/.test(cell.split('</details>')[0].replace(/<code>[^<]*<\/code>/g, '')), 'no percentage expected in the cell: ' + cell.slice(0, 300));
  assert.ok(hBad.includes('INVALID_DATE'));
});
check('netXirrHtml: multiple roots => no main percentage, roots listed as "not an approved return"', () => {
  const C = A;
  const out = netXirrHtml(C, { netXirr: { status: 'POSSIBLE_MULTIPLE_ROOTS', roots: [0.1, 0.2], reason: 'x' } });
  assert.ok(out.includes('POSSIBLE_MULTIPLE_ROOTS') && out.includes('data-netxirr-status="POSSIBLE_MULTIPLE_ROOTS"'));
  assert.ok(out.includes(C.fmtPct(0.1)) && out.includes(C.fmtPct(0.2)));
  assert.ok(/ليست عائداً معتمداً/.test(out));
  const span = out.slice(0, out.indexOf('</span>'));
  assert.ok(!span.includes('%'), 'main span must not carry a percentage');
});
check('netXirrHtml: unknown status/issue codes stay literal and are HTML-escaped; missing result renders a dash', () => {
  const out = netXirrHtml(A, { netXirr: { status: 'WEIRD<script>', issues: [{ code: 'NEW<b>', ids: ['a<i>'] }] } });
  assert.ok(!out.includes('<script>') && !out.includes('<b>') && !out.includes('<i>'));
  assert.ok(out.includes('WEIRD&lt;script&gt;'));
  assert.equal(netXirrHtml(A, {}), '—'); assert.equal(netXirrHtml(A, null), '—');
});
check('netXirrHtml OK: carries the source warnings (NAV estimate, unknown NAV valuation date)', () => {
  const out = netXirrHtml(A, { netXirr: rA });
  assert.ok(out.includes('NAV_IS_UNDERWRITING_ESTIMATE') && out.includes('NAV_VALUATION_DATE_UNKNOWN'));
});

/* ---- other consumers: null/absent Net XIRR must not turn into 0 or into a performance alert ---- */
// bad record carries amount 0 so that every amount-based figure stays identical to world A; only the date is invalid
const withBadLedger = async () => world({ calls: [...GOOD_CALLS(), call('b1', '2024-02-31', 0)], dists: GOOD_DISTS() });
check('alert-center: model identical whether Net XIRR is OK, null (bad ledger) or absent; it never reads netIRR', async () => {
  const B = await withBadLedger(), N = await world({});
  const d = (C) => C.withDefaults(C.opportunities[0].data);
  const model = (C) => JSON.stringify(buildAlertModel(C, d(C), C.compute(d(C))));
  assert.equal(model(B), model(A)); assert.equal(model(N), model(A));
  assert.ok(!/netIRR|netXirr|Net IRR/.test(model(B)));
  assert.equal(stats(B).netIRR, null);
});
check('concentration-risk: body banner and detail section identical whether Net XIRR is OK or null', async () => {
  const B = await withBadLedger();
  const body = (C) => C._bodyViewHooks.map((fn) => { try { return fn(); } catch (e) { return 'ERR ' + e.message; } }).join('|');
  assert.equal(body(B), body(A));
  assert.ok(!/ERR /.test(body(B)));
  const detail = (C) => C.renderDetail('s1');
  assert.equal(detail(B), detail(A));
});
check('command-center: Net IRR cell shows the status (no 0%) when there is no rate', async () => {
  const B = await withBadLedger();
  const hb = html(B, 'commandCenter'), ha = html(A, 'commandCenter');
  assert.equal(rowOf(hb), 'INSUFFICIENT_SOURCE_DATA'); assert.equal(rowOf(ha), 'INSUFFICIENT_SOURCE_DATA');
  assert.ok(!hb.includes(B.fmtPct(0)) || !hb.slice(hb.indexOf('Net IRR') - 20, hb.indexOf('Net IRR') + 400).includes(B.fmtPct(0)));
});

/* consumers again, with assets actually linked to the fund (non-trivial concentration); Net XIRR is non-OK in both worlds
   (NAV basis unresolved), so this proves that consumers do not depend on it and that no consumer turns null into 0 */
check('asset-linked fund: alert-center, concentration-risk, institutional view, command-center and non-Net stats are identical for a good and a bad ledger', async () => {
  const G = await world({ calls: GOOD_CALLS(), dists: GOOD_DISTS(), assetIds: ASSETS });
  const Bd = await world({ calls: [...GOOD_CALLS(), call('b1', '2024-02-31', 0)], dists: GOOD_DISTS(), assetIds: ASSETS });
  const d = (C) => C.withDefaults(C.opportunities[0].data);
  assert.equal(JSON.stringify(buildAlertModel(G, d(G), G.compute(d(G)))), JSON.stringify(buildAlertModel(Bd, d(Bd), Bd.compute(d(Bd)))));
  const body = (C) => C._bodyViewHooks.map((fn) => fn()).join('|');
  assert.equal(body(G), body(Bd)); assert.ok(body(G).length > 0);
  assert.equal(G.renderDetail('s1'), Bd.renderDetail('s1'));
  assert.equal(G._mainViews['institutional-intelligence'](), Bd._mainViews['institutional-intelligence']());
  const sg = stats(G), sb = stats(Bd);
  assert.equal(sg.netIRR, null); assert.equal(sb.netIRR, null);
  assert.ok(sg.cityConc.length > 0 && JSON.stringify(sg.cityConc) === JSON.stringify(sb.cityConc));
  for (const C of [G, Bd]) { const h = html(C, 'commandCenter'); assert.equal(rowOf(h), 'INSUFFICIENT_SOURCE_DATA'); }
});
check('institutional-investment-intelligence: renders without error and does not depend on Net XIRR', async () => {
  const B = await withBadLedger();
  const keys = Object.keys(B._mainViews).filter((k) => /institutional|investment/i.test(k));
  for (const k of keys) {
    const a = (() => { try { return B._mainViews[k](); } catch (e) { return 'ERR ' + e.message; } })();
    const b = (() => { try { return A._mainViews[k](); } catch (e) { return 'ERR ' + e.message; } })();
    assert.ok(!/^ERR/.test(a), k + ': ' + a); assert.equal(a, b, k);
  }
});
check('unchanged outputs: AUM/NAV/Gross IRR/TVPI/LTV/DSCR/concentration are identical when only the Net XIRR input is bad', async () => {
  const B = await withBadLedger();
  const pick = (s) => JSON.stringify({ aum: s.aum, nav: s.nav, g: s.grossIRR, moic: s.portfolioMOIC, ltv: s.ltv, dscr: s.dscrAvg, city: s.cityConc, type: s.typeConc, fund: s.fundConc, inv: s.investedCapital, un: s.uninvestedCapital });
  const sb = stats(B), sa = stats(A);
  assert.equal(pick(sb), pick(sa));
  assert.equal(sb.netIRR, null); assert.equal(sa.netIRR, null);
  assert.deepEqual(sa.netXirr.reasonCodes, ONLY_BASIS); assert.ok(sb.netXirr.reasonCodes.includes('INVALID_DATE'));
});

/* ---- parity of the in-kind mirror with the real core classifier ---- */
check('isInKindCall mirrors core.isInKindCapitalCall on a matrix of ledger shapes', () => {
  const recs = [
    { id: 'a', data: { status: 'paid' } }, { id: 'b', data: { status: 'paid', linkedCommitmentId: 'cm' } }, { id: 'c', data: { status: 'paid', inKindAssetId: 'x' } },
    { id: 'd', data: { status: 'paid', reversalOfId: 'b' } }, { id: 'e', data: { status: 'paid', reversalOfId: 'a' } }, { id: 'f', data: { status: 'paid', reversalOfId: 'zzz' } },
    { id: 'g', data: { status: 'paid', reversalOfId: 'h' } }, { id: 'h', data: { status: 'paid', reversalOfId: 'g' } },
  ];
  const byId = new Map(recs.map((r) => [r.id, r]));
  for (const r of recs) assert.equal(isInKindCall(r, byId), A.isInKindCapitalCall(r, byId), r.id);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
