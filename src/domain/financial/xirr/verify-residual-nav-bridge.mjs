// XIRR-R1C1 verification (pure bridge: approved residual valuations -> portfolio Net XIRR).
// Run: node src/domain/financial/xirr/verify-residual-nav-bridge.mjs
// The bridge adds NO new financial rule: it forces eligibility, pins the calculation day, and refuses to hand the solver anything
// but a complete, consistent, approved valuation. These tests pin that, and that nothing else changes.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeResidualBackedNetXirr as bridge, BRIDGE_VERSION } from './residual-nav-bridge.js';
import { selectResidualValuation, NAV_BASIS, NAV_SOURCE_LABEL } from './residual-valuation.js';
import { computePortfolioNetXirr } from './portfolio-xirr.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); }
}
const AS = '2026-03-31';
const NOW = new Date('2026-03-31T09:00:00Z');   // 12:00 in Riyadh, same calendar day as AS
const clone = (o) => JSON.parse(JSON.stringify(o));
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

/* ---------- fixtures (same shape as verify-residual-valuation.mjs) ---------- */
const val = (fundId, id, o = {}) => clone({
  valuationId: id, fundId, valuationDate: AS, currency: 'SAR', basis: NAV_BASIS,
  components: fundId === 'f1'
    ? { assetsValue: 1000000, cashRetained: 50000, otherAssets: 20000, otherAssetsItems: [{ description: 'receivable', amount: 20000 }], liabilities: 70000, distributionsPayable: 0 }
    : { assetsValue: 500000, cashRetained: 0, otherAssets: 0, otherAssetsItems: [], liabilities: 0, distributionsPayable: 0 },
  residualValue: fundId === 'f1' ? 1000000 : 500000,
  method: 'appraisal', source: { ref: 'DOC-' + id, provider: 'Valuer Co' },
  nonOverlap: { cashNotInAssets: true, otherAssetsNotInAssets: true, assetsStatedGrossOfLiabilities: true },
  coverage: { linkedAssets: fundId === 'f1' ? ['a1', 'a2'] : [], unlinkedHoldings: { declared: 'none' } },
  version: 1, supersedes: null, status: 'approved', enteredBy: 'prep@x.sa', approvedBy: 'appr@x.sa', ...o,
});
const call = (id, date, amount, extra = {}) => ({ kind: 'capitalCall', id, fundId: 'f1', date, amount, status: 'paid', reversalOfId: null, ...extra });
const dist = (id, date, amount, extra = {}) => ({ kind: 'distribution', id, fundId: 'f1', date, amount, status: 'paid', reversalOfId: null, ...extra });
const ELIG = () => ({ f1: { headId: 'v-f1', state: 'ELIGIBLE' }, f2: { headId: 'v-f2', state: 'ELIGIBLE' } });
const mk = (o = {}) => clone({
  asOfDate: AS,
  scope: { snapshotDate: AS, funds: ['f1', 'f2'], linksByFund: { f1: ['a1', 'a2'], f2: [] } },
  valuations: [val('f1', 'v-f1'), val('f2', 'v-f2')],
  records: [call('c1', '2025-03-31', 1000000)],
  eligibility: ELIG(),
  ...o,
});
const run = (o, opts = { now: NOW }) => bridge(mk(o), opts);
const codes = (r) => (r.reasonCodes || []);
const noRate = (r) => { assert.ok(!('rate' in r), 'a blocked result must not carry a rate key'); assert.notEqual(r.status, 'OK'); };
const blockedWith = (r, code) => { assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA'); noRate(r); assert.ok(codes(r).includes(code), `expected ${code}, got ${codes(r)}`); assert.ok(r.issues.some((i) => i.code === code), `issues must carry ${code}`); };

/* independent reference: Act/365 XIRR by plain bisection (does not use the shared solver) */
function refXirr(flows) {
  const t0 = Date.parse(flows[0].date);
  const npv = (r) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, (Date.parse(f.date) - t0) / 86400000 / 365), 0);
  let lo = -0.9, hi = 10; if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 300; i++) { const mid = (lo + hi) / 2; if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}

/* ---------- success path ---------- */
t('valid input: OK, terminal value = Σ approved residual (1,500,000), rate = closed form 50%', () => {
  const r = run();
  assert.equal(r.status, 'OK'); assert.ok(Number.isFinite(r.rate));
  assert.ok(Math.abs(r.rate - 0.5) < 1e-9, String(r.rate));
  assert.equal(r.navValue, 1500000); assert.equal(r.navSource, NAV_SOURCE_LABEL); assert.equal(r.navValuationDate, AS);
  assert.equal(r.asOfDate, AS); assert.equal(r.asOfDateSource, 'calculation-date');
  assert.equal(r.valuation.status, 'OK'); assert.equal(r.valuation.complete, true); assert.equal(r.valuation.value, 1500000);
  assert.deepEqual(r.valuation.perFund.map((p) => p.fundId), ['f1', 'f2']);
  assert.deepEqual(r.bridge, { version: BRIDGE_VERSION, calculationDay: AS, eligibilityRequired: true, scopeFunds: ['f1', 'f2'] });
});
t('success carries every standing warning in ONE place (sourceWarnings): ledger dates, valuation not verified, approval not verified, snapshot authenticity, calculation date', () => {
  const c = run().sourceWarnings.map((w) => w.code);
  for (const k of ['LEDGER_DATES_ARE_RECORD_DATES', 'VALUATION_NOT_VERIFIED_BY_VALIDATOR', 'APPROVAL_NOT_VERIFIED_BY_VALIDATOR', 'COVERAGE_SNAPSHOT_AUTHENTICITY_NOT_VERIFIED', 'ASOF_DATE_IS_CALCULATION_DATE', 'NAV_SOURCE_DECLARED']) assert.ok(c.includes(k), k);
  assert.ok(!c.includes('NAV_IS_UNDERWRITING_ESTIMATE')); assert.ok(!c.includes('NAV_VALUATION_DATE_UNKNOWN'));
  assert.equal(new Set(c).size, c.length, 'no duplicate warning codes');
});
t('rate agrees with an independent bisection on a multi-flow case (calls, distribution, terminal value)', () => {
  const records = [call('c1', '2024-03-31', 400000), call('c2', '2024-09-30', 600000), dist('d1', '2025-06-30', 150000)];
  const r = run({ records });
  assert.equal(r.status, 'OK');
  const ref = refXirr([{ date: '2024-03-31', amount: -400000 }, { date: '2024-09-30', amount: -600000 }, { date: '2025-06-30', amount: 150000 }, { date: AS, amount: 1500000 }]);
  assert.ok(Math.abs(r.rate - ref) < 1e-7, `${r.rate} vs ${ref}`);
});
t('the bridge result equals computePortfolioNetXirr fed the selector value directly (no hidden adjustment)', () => {
  const i = mk(); const sel = selectResidualValuation(i);
  const direct = computePortfolioNetXirr({ asOfDate: AS, asOfDateSource: 'calculation-date', records: i.records, nav: { value: sel.value, complete: true, basis: sel.basis, source: sel.source, valuationDate: sel.valuationDate } });
  const r = bridge(i, { now: NOW });
  assert.equal(r.rate, direct.rate); assert.equal(r.navValue, direct.navValue); assert.equal(r.cashflowCount, direct.cashflowCount); assert.equal(r.status, direct.status);
});

/* ---------- eligibility is mandatory ---------- */
t('eligibility omitted / null / array / string -> ELIGIBILITY_REQUIRED, no rate, selector not used (valuation null) — even though the selector alone would return OK', () => {
  assert.equal(selectResidualValuation({ ...mk(), eligibility: undefined }).status, 'OK', 'premise: the selector alone accepts a missing eligibility');
  for (const bad of [undefined, null, [], 'x', 5, true]) {
    const i = mk(); if (bad === undefined) delete i.eligibility; else i.eligibility = bad;
    const r = bridge(i, { now: NOW });
    blockedWith(r, 'ELIGIBILITY_REQUIRED'); assert.equal(r.valuation, null); assert.ok(!('navValue' in r));
  }
});
t('empty eligibility object {} -> the selector flags ELIGIBILITY_INVALID for the funds (not silently accepted)', () => {
  const r = run({ eligibility: {} }); blockedWith(r, 'ELIGIBILITY_INVALID'); assert.equal(r.valuation.status, 'BLOCKED');
});
t('one fund missing from eligibility -> ELIGIBILITY_INVALID, whole result blocked', () => {
  const e = ELIG(); delete e.f2; blockedWith(run({ eligibility: e }), 'ELIGIBILITY_INVALID');
});
t('malformed entries (bad state, no headId) -> ELIGIBILITY_INVALID', () => {
  for (const mut of [(e) => { e.f1.state = 'eligible'; }, (e) => { e.f1.state = 'PENDING'; }, (e) => { delete e.f1.headId; }, (e) => { e.f1 = null; }, (e) => { e.f1 = 'ELIGIBLE'; }]) {
    const e = ELIG(); mut(e); blockedWith(run({ eligibility: e }), 'ELIGIBILITY_INVALID');
  }
});
t('suspended head -> VALUATION_SUSPENDED, no rate, no value, and NO fallback to an older approved version', () => {
  const v1 = val('f1', 'v-f1-1'), v2 = val('f1', 'v-f1-2', { version: 2, supersedes: 'v-f1-1', components: { ...val('f1', 'x').components, assetsValue: 3000000 }, residualValue: 3000000 - 0 });
  v2.residualValue = v2.components.assetsValue + v2.components.cashRetained + v2.components.otherAssets - v2.components.liabilities;
  const e = ELIG(); e.f1 = { headId: 'v-f1-2', state: 'SUSPENDED' };
  const r = run({ valuations: [v1, v2, val('f2', 'v-f2')], eligibility: e });
  blockedWith(r, 'VALUATION_SUSPENDED');
  assert.ok(codes(r).includes('NAV_INVALID') && codes(r).includes('NAV_INCOMPLETE'), 'the solver must receive NO value and an incomplete NAV');
  assert.equal(r.valuation.value, null); assert.deepEqual(r.valuation.perFund, []); assert.ok(!('navValue' in r));
  // sanity: with the head ELIGIBLE the SAME data is OK and uses the v2 head, so the block above is due to the suspension alone
  const ok = run({ valuations: [v1, v2, val('f2', 'v-f2')], eligibility: { ...ELIG(), f1: { headId: 'v-f1-2', state: 'ELIGIBLE' } } });
  assert.equal(ok.status, 'OK'); assert.equal(ok.valuation.perFund[0].valuationId, 'v-f1-2');
});
t('one suspended fund blocks the WHOLE portfolio (no partial value for the other fund)', () => {
  const e = ELIG(); e.f2.state = 'SUSPENDED'; const r = run({ eligibility: e });
  blockedWith(r, 'VALUATION_SUSPENDED'); assert.ok(!('navValue' in r)); assert.equal(r.valuation.value, null);
});
t('eligibility headId that is not the selected head -> ELIGIBILITY_HEAD_MISMATCH', () => {
  const e = ELIG(); e.f1.headId = 'some-other-head'; blockedWith(run({ eligibility: e }), 'ELIGIBILITY_HEAD_MISMATCH');
});

/* ---------- D-C2: the current Riyadh day only ---------- */
t('no instant supplied / invalid Date / non-Date -> CALCULATION_DAY_UNKNOWN (the bridge has no clock of its own)', () => {
  for (const opts of [undefined, {}, { now: undefined }, { now: null }, { now: 'today' }, { now: 1774947600000 }, { now: new Date('nope') }, null]) blockedWith(bridge(mk(), opts), 'CALCULATION_DAY_UNKNOWN');
});
t('asOfDate that is not today in Riyadh (yesterday / tomorrow / far past) -> ASOF_NOT_CURRENT_RIYADH_DAY, valuation not consulted, no calculation-date warning', () => {
  for (const now of [new Date('2026-04-01T09:00:00Z'), new Date('2026-03-30T09:00:00Z'), new Date('2025-01-01T09:00:00Z')]) {
    const r = bridge(mk(), { now }); blockedWith(r, 'ASOF_NOT_CURRENT_RIYADH_DAY'); assert.equal(r.valuation, null);
    assert.ok(!r.sourceWarnings.some((w) => w.code === 'ASOF_DATE_IS_CALCULATION_DATE')); assert.equal(r.asOfDateSource, 'explicit');
  }
});
t('Riyadh day boundary: 20:59:59Z is still 2026-03-31; 21:00:00Z is already 2026-04-01', () => {
  assert.equal(bridge(mk(), { now: new Date('2026-03-31T20:59:59.999Z') }).status, 'OK');
  blockedWith(bridge(mk(), { now: new Date('2026-03-31T21:00:00.000Z') }), 'ASOF_NOT_CURRENT_RIYADH_DAY');
  const next = clone(mk()); const swap = (o) => JSON.parse(JSON.stringify(o).split(AS).join('2026-04-01'));
  assert.equal(bridge(swap(next), { now: new Date('2026-03-31T21:00:00.000Z') }).status, 'OK');
});
t('yesterday-dated valuations on a new day -> blocked (VALUATION_DATE_MISMATCH / coverage), never reused as today\'s', () => {
  const swapDay = (o) => JSON.parse(JSON.stringify(o).split(AS).join('2026-04-01'));
  const i = swapDay(mk()); i.valuations = mk().valuations;             // asOf/scope = 04-01, valuations still 03-31
  const r = bridge(i, { now: new Date('2026-04-01T09:00:00Z') });
  assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA'); noRate(r); assert.ok(codes(r).includes('VALUATION_DATE_MISMATCH') || codes(r).includes('COVERAGE_FUND_MISSING'), String(codes(r)));
});

/* ---------- selector blocks pass through, whole-portfolio, named ---------- */
t('selector reasons surface at the top level and in issues, with the standing warnings still present', () => {
  const cases = [
    [{ valuations: [val('f1', 'v-f1')] }, 'COVERAGE_FUND_MISSING'],
    [{ valuations: [val('f1', 'v-f1'), val('f2', 'v-f2', { valuationDate: '2026-03-30' })] }, 'VALUATION_DATE_MISMATCH'],
    [{ valuations: [val('f1', 'v-f1'), val('f2', 'v-f2'), val('f3', 'v-f3')] }, 'COVERAGE_FUND_UNKNOWN'],
    [{ valuations: [val('f1', 'v-f1', { coverage: { linkedAssets: ['a1'], unlinkedHoldings: { declared: 'none' } } }), val('f2', 'v-f2')] }, 'COVERAGE_ASSET_MISSING'],
    [{ valuations: [val('f1', 'v-f1'), val('f1', 'v-f1b'), val('f2', 'v-f2')] }, 'AMBIGUOUS_VALUATION_VERSIONS'],      // two heads for one fund/date
    [{ valuations: [val('f1', 'v-f1', { version: 2, supersedes: null }), val('f2', 'v-f2')] }, 'VERSION_CHAIN_INCOMPLETE'],   // v2 without its v1
    [{ valuations: [val('f1', 'v-f1', { version: 2, supersedes: 'v-missing' }), val('f2', 'v-f2')] }, 'VERSION_CHAIN_INCOMPLETE'],
    [{ valuations: [val('f1', 'v-f1', { approvedBy: 'prep@x.sa' }), val('f2', 'v-f2')] }, 'APPROVAL_DATA_INVALID'],
    [{ records: [call('c1', '2025-03-31', 1000000), dist('d1', '2026-01-31', 5, { status: 'declared' })] }, 'DISTRIBUTIONS_PAYABLE_UNRESOLVED'],
    [{ records: [call('c1', '2025-03-31', 1000000), dist('d1', '2026-01-31', 5, { status: 'waived' })] }, 'DISTRIBUTION_STATUS_UNKNOWN'],
  ];
  for (const [o, code] of cases) {
    const r = run(o); blockedWith(r, code);
    assert.ok(r.sourceWarnings.some((w) => w.code === 'VALUATION_NOT_VERIFIED_BY_VALIDATOR'), 'warnings kept on a block');
    assert.equal(r.valuation.value, null); assert.deepEqual(r.valuation.perFund, []);
  }
});
t('distributionsPayable: undeclared / positive amount block', () => {
  const f = (fn) => { const v = val('f1', 'v-f1'); fn(v); return run({ valuations: [v, val('f2', 'v-f2')] }); };
  blockedWith(f((v) => { delete v.components.distributionsPayable; }), 'DISTRIBUTIONS_PAYABLE_UNDECLARED');
  blockedWith(f((v) => { v.components.distributionsPayable = 10; }), 'DISTRIBUTIONS_PAYABLE_UNRESOLVED');
});
t('valuation content problems block (negative residual, formula mismatch, overflow, bad basis, non-numeric)', () => {
  const f = (fn) => { const v = val('f1', 'v-f1'); fn(v); return run({ valuations: [v, val('f2', 'v-f2')] }); };
  blockedWith(f((v) => { v.residualValue = 1000000.5; }), 'RESIDUAL_FORMULA_MISMATCH');
  blockedWith(f((v) => { v.basis = 'UNDERWRITING_TOTAL_PROJECTED_EQUITY_PROCEEDS'; }), 'NAV_BASIS_UNRESOLVED');
  blockedWith(f((v) => { v.components.assetsValue = '1000000'; }), 'INVALID_AMOUNT');
  blockedWith(f((v) => { v.components.assetsValue = Number.MAX_VALUE; v.components.cashRetained = Number.MAX_VALUE; v.residualValue = 1; }), 'NUMERIC_OVERFLOW');
});
t('empty scope is refused (COVERAGE_SCOPE_INVALID), never an OK with value 0', () => {
  const r = run({ scope: { snapshotDate: AS, funds: [], linksByFund: {} }, valuations: [], eligibility: {} }); blockedWith(r, 'COVERAGE_SCOPE_INVALID');
});

/* ---------- flow problems still block, independent of the valuation ---------- */
t('valid valuation but unusable flows -> INSUFFICIENT_SOURCE_DATA with the XIRR-P reason, valuation block shows OK, no rate', () => {
  const cases = [
    [[call('c1', 'not-a-date', 100)], 'INVALID_DATE'],
    [[call('c1', '2025-03-31', 'x')], 'INVALID_AMOUNT'],
    [[call('c1', '2025-03-31', 100, { inKindAssetId: 'a1' })], 'IN_KIND_VALUE_BASIS_UNRESOLVED'],
    [[call('c1', '2025-03-31', 100), call('c1', '2025-04-30', 50)], 'DUPLICATE_RECORD_ID'],
    [[call('c1', '2025-03-31', 100), call('r1', '2025-04-30', -100, { reversalOfId: 'c1' })], 'REVERSAL_MEANING_UNRESOLVED'],
  ];
  for (const [records, code] of cases) { const r = run({ records }); blockedWith(r, code); assert.equal(r.valuation.status, 'OK'); assert.equal(r.valuation.value, 1500000); }
});
t('a valid same-date reversal pair cancels (result equals the ledger without the pair) and flows after asOfDate are excluded with the warning', () => {
  const base = run({ records: [call('c1', '2025-03-31', 1000000)] });
  const withPair = run({ records: [call('c1', '2025-03-31', 1000000), call('c2', '2025-06-30', 7), call('r2', '2025-06-30', -7, { reversalOfId: 'c2' })] });
  assert.equal(withPair.rate, base.rate); assert.equal(withPair.cashflowCount, base.cashflowCount);
  const late = run({ records: [call('c1', '2025-03-31', 1000000), dist('d9', '2026-04-15', 999)] });
  assert.equal(late.rate, base.rate); assert.ok(late.sourceWarnings.some((w) => w.code === 'FLOWS_AFTER_ASOF_EXCLUDED'));
});
t('combined failures are all reported (bridge + selector + flows), de-duplicated', () => {
  const e = ELIG(); e.f1.state = 'SUSPENDED';
  const r = run({ eligibility: e, records: [call('c1', 'bad', 1)] });
  assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA'); noRate(r);
  for (const k of ['VALUATION_SUSPENDED', 'INVALID_DATE', 'NAV_INCOMPLETE']) assert.ok(codes(r).includes(k), k);
  assert.equal(new Set(codes(r)).size, codes(r).length);
  const r2 = bridge(mk({ eligibility: undefined, records: [call('c1', 'bad', 1)] }), { now: new Date('2026-04-05T00:00:00Z') });
  for (const k of ['CALCULATION_DAY_UNKNOWN', 'ASOF_NOT_CURRENT_RIYADH_DAY', 'ELIGIBILITY_REQUIRED', 'INVALID_DATE'].filter((k) => k !== 'CALCULATION_DAY_UNKNOWN')) assert.ok(codes(r2).includes(k), k);
});

/* ---------- structure, purity, invariants ---------- */
t('invalid structural input -> INVALID_INPUT without a rate and without throwing', () => {
  for (const bad of [null, undefined, 5, 'x', [], { asOfDate: 'nope', records: [] }, { asOfDate: '2026-02-30', records: [] }, { asOfDate: AS, records: 'x' }, { asOfDate: AS }]) {
    const r = bridge(bad, { now: NOW }); assert.equal(r.status, 'INVALID_INPUT'); noRate(r);
  }
  // valuations not an array: reaches the selector, which rejects; the bridge must block, not throw and not rate
  const r = bridge({ ...mk(), valuations: 'x' }, { now: NOW }); noRate(r); assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA');
});
t('pure: deep-frozen input does not throw and is not mutated; two runs are deeply equal', () => {
  const i = deepFreeze(mk()); const before = JSON.stringify(i);
  const a = bridge(i, { now: NOW }), b = bridge(i, { now: NOW });
  assert.equal(JSON.stringify(i), before); assert.deepEqual(a, b); assert.equal(a.status, 'OK');
  const e = deepFreeze(mk({ eligibility: { f1: { headId: 'v-f1', state: 'SUSPENDED' }, f2: { headId: 'v-f2', state: 'ELIGIBLE' } } }));
  assert.doesNotThrow(() => bridge(e, { now: NOW }));
});
t('invariant sweep: across 400 deterministic corruptions, a `rate` key exists ONLY when status is OK, the valuation block is OK, and no issues remain', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const muts = [
    (i) => { delete i.eligibility; }, (i) => { i.eligibility.f1.state = 'SUSPENDED'; }, (i) => { i.eligibility.f2.headId = 'zz'; },
    (i) => { i.valuations.pop(); }, (i) => { i.valuations[0].valuationDate = '2026-03-30'; }, (i) => { i.valuations[1].status = 'draft'; },
    (i) => { i.valuations[0].residualValue = 1; }, (i) => { i.records.push(call('cx', 'bad', 1)); }, (i) => { i.records.push(dist('dx', AS, 1, { status: 'approved' })); },
    (i) => { i.scope.funds = ['f1']; }, (i) => { i.scope.snapshotDate = '2026-03-30'; }, (i) => { i.valuations[0].coverage.linkedAssets = []; },
    (i) => { i.valuations[0].components.distributionsPayable = 5; }, (i) => { i.asOfDate = '2026-03-30'; }, (i) => { i.valuations[0].version = 2; },
  ];
  let oks = 0, blocks = 0;
  for (let n = 0; n < 400; n++) {
    const i = mk(); const k = Math.floor(rnd() * 3);
    for (let j = 0; j < k; j++) muts[Math.floor(rnd() * muts.length)](i);
    const r = bridge(i, { now: rnd() < 0.1 ? undefined : NOW });
    if ('rate' in r) { oks++; assert.equal(r.status, 'OK'); assert.equal(r.valuation.status, 'OK'); assert.equal(r.valuation.issues.length, 0); assert.ok(Number.isFinite(r.rate)); assert.equal(r.bridge.eligibilityRequired, true); }
    else { blocks++; assert.notEqual(r.status, 'OK'); }
  }
  assert.ok(oks > 0 && blocks > 0, `sweep must exercise both branches (ok=${oks}, blocked=${blocks})`);
});

/* ---------- static guarantees ---------- */
const SRC = readFileSync(fileURLToPath(new URL('./residual-nav-bridge.js', import.meta.url)), 'utf8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/* ---------- defensive acceptance rules, exercised through a stubbed selector ----------
   The real selector can never return these shapes today (its own tests pin that). The bridge re-checks them anyway so a future
   selector regression cannot reach the solver. The bridge source is re-loaded with ONLY its selector import pointed at a stub
   file in the OS temp dir; nothing in the product is changed or injectable. */
const tmp = mkdtempSync(join(tmpdir(), 'r1c1-bridge-'));
writeFileSync(join(tmp, 'sel.mjs'), `export const NAV_BASIS = 'RESIDUAL_VALUE_AS_OF_DATE'; export const NAV_SOURCE_LABEL = 'FUND_VALUATIONS_APPROVED';\nexport function selectResidualValuation(i) { return globalThis.__fakeSel(i); }\n`);
const xirrUrl = pathToFileURL(fileURLToPath(new URL('./portfolio-xirr.js', import.meta.url))).href;
writeFileSync(join(tmp, 'bridge.mjs'), SRC.replace("'./residual-valuation.js'", "'./sel.mjs'").replace("'./portfolio-xirr.js'", JSON.stringify(xirrUrl)));
const stubbed = await import(pathToFileURL(join(tmp, 'bridge.mjs')).href);
const fakeOk = () => ({ status: 'OK', complete: true, value: 1500000, basis: NAV_BASIS, source: NAV_SOURCE_LABEL, valuationDate: AS, issues: [], reasonCodes: [], warnings: [{ code: 'VALUATION_NOT_VERIFIED_BY_VALIDATOR', message: 'x' }], perFund: [{ fundId: 'f1' }, { fundId: 'f2' }] });
const viaFake = (patch) => { globalThis.__fakeSel = () => ({ ...fakeOk(), ...patch }); return stubbed.computeResidualBackedNetXirr(mk(), { now: NOW }); };
t('stub sanity: a well-formed OK selector result is accepted (so the rejections below are due to the single altered field)', () => {
  const r = viaFake({}); assert.equal(r.status, 'OK'); assert.ok(Math.abs(r.rate - 0.5) < 1e-9);
});
t('a selector result that claims OK but is inconsistent is refused with VALUATION_RESULT_INCONSISTENT and never reaches the solver', () => {
  const patches = [
    { valuationDate: '2026-03-30' }, { basis: 'UNDERWRITING_TOTAL_PROJECTED_EQUITY_PROCEEDS' }, { source: 'UNDERWRITING_EQUITY_X_MOIC' },
    { perFund: [{ fundId: 'f1' }] }, { perFund: [] }, { issues: [{ code: 'X', ids: [] }] }, { complete: false },
    { value: -1 }, { value: NaN }, { value: Infinity }, { value: '1500000' }, { value: null },
  ];
  for (const p of patches) { const r = viaFake(p); assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA', JSON.stringify(p)); noRate(r); assert.ok(codes(r).includes('VALUATION_RESULT_INCONSISTENT'), JSON.stringify(p)); assert.ok(!('navValue' in r)); }
});
t('a blocked selector result never leaks its value to the solver and shares no duplicate reason codes with XIRR-P', () => {
  const r = viaFake({ status: 'BLOCKED', complete: false, value: 999, perFund: [], reasonCodes: ['NAV_INCOMPLETE', 'COVERAGE_FUND_MISSING'], issues: [{ code: 'COVERAGE_FUND_MISSING', ids: ['fund:f2'] }] });
  assert.equal(r.status, 'INSUFFICIENT_SOURCE_DATA'); noRate(r);
  assert.ok(codes(r).includes('NAV_INVALID'), 'value passed down must be null');
  assert.equal(new Set(codes(r)).size, codes(r).length, JSON.stringify(codes(r)));
  assert.ok(r.issues.some((i) => i.code === 'COVERAGE_FUND_MISSING'));
});

t('static: imports only the selector and the XIRR-P module; no clock, DOM, Firebase, I/O', () => {
  const imports = [...code.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./portfolio-xirr.js', './residual-valuation.js']);
  for (const bad of ['Date.now', 'new Date(', 'document', 'window', 'firebase', 'localStorage', 'fetch(', 'require(', 'process.', 'Math.random']) assert.ok(!code.includes(bad), bad);
});
t('static: nothing from the underwriting NAV path (no equity x MOIC, no UNDERWRITING source)', () => {
  for (const bad of ['UNDERWRITING', 'MOIC', 'moic', 'equity', 'fundLedgerSummary', 'totalValue']) assert.ok(!code.includes(bad), bad);
});
t('static: the selector and XIRR-P modules shipped to the server bundle are unchanged by this package (generated copies are byte-equal modulo CRLF)', () => {
  for (const f of ['residual-valuation.js', 'portfolio-xirr.js', 'xirr-opportunity.js']) {
    const a = readFileSync(fileURLToPath(new URL('./' + f, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    const b = readFileSync(fileURLToPath(new URL('../../../../functions/generated/src/domain/financial/xirr/' + f, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(a, b, f);
  }
});
t('static: the bridge is NOT part of the server bundle list (so no engineVersion change)', () => {
  const b = readFileSync(fileURLToPath(new URL('../../../../functions/scripts/build-domain.cjs', import.meta.url)), 'utf8');
  assert.ok(!b.includes('residual-nav-bridge'));
});
t('static: no view imports the bridge yet (R1-C1 does not activate any rate)', () => {
  for (const f of ['src/features/portfolio.js', 'src/features/command-center.js', 'src/core.js']) {
    const s = readFileSync(fileURLToPath(new URL('../../../../' + f, import.meta.url)), 'utf8');
    assert.ok(!s.includes('residual-nav-bridge'), f);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
