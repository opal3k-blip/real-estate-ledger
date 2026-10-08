// XIRR-R1A verification (pure selector/validator). Run: node src/domain/financial/xirr/verify-residual-valuation.mjs
// The selector checks completeness and consistency only. These tests also pin what it deliberately does NOT claim.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { selectResidualValuation, NAV_BASIS, NAV_SOURCE_LABEL } from './residual-valuation.js';
import { computePortfolioNetXirr } from './portfolio-xirr.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); }
}
const AS = '2026-03-31';
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ---------- fixtures ---------- */
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
const mk = (o = {}) => clone({
  asOfDate: AS,
  scope: { snapshotDate: AS, funds: ['f1', 'f2'], linksByFund: { f1: ['a1', 'a2'], f2: [] } },
  valuations: [val('f1', 'v-f1'), val('f2', 'v-f2')],
  records: [call('c1', '2025-03-31', 1000000)],
  ...o,
});
const codes = (out) => out.issues.map((i) => i.code);
const has = (out, code) => codes(out).includes(code);
const sel = (o) => selectResidualValuation(mk(o));
const withV = (fn) => { const i = mk(); fn(i.valuations[0], i); return selectResidualValuation(i); };
const blocked = (out, code) => { assert.equal(out.status, 'BLOCKED'); assert.equal(out.value, null); assert.equal(out.complete, false); assert.deepEqual(out.perFund, []); if (code) assert.ok(has(out, code), `expected ${code}, got ${codes(out)}`); };

/* ---------- success path and output shape ---------- */
t('valid input: OK, value = sum of both funds, shape complete', () => {
  const o = sel();
  assert.equal(o.status, 'OK'); assert.equal(o.complete, true); assert.equal(o.value, 1500000);
  assert.equal(o.basis, NAV_BASIS); assert.equal(o.source, NAV_SOURCE_LABEL); assert.equal(o.valuationDate, AS);
  assert.deepEqual(o.issues, []); assert.deepEqual(o.reasonCodes, []);
  assert.deepEqual(o.perFund.map((p) => p.fundId), ['f1', 'f2']);
  const p = o.perFund[0];
  for (const k of ['fundId', 'valuationId', 'version', 'residualValue', 'components', 'method', 'sourceRef', 'provider']) assert.ok(k in p, k);
  assert.equal(p.sourceRef, 'DOC-v-f1'); assert.equal(p.provider, 'Valuer Co'); assert.equal(p.components.distributionsPayable, 0);
});
t('warnings[] present on success and on block, always including VALUATION_NOT_VERIFIED_BY_VALIDATOR', () => {
  const ok = sel(), bad = withV((v) => { v.currency = 'USD'; });
  for (const o of [ok, bad]) {
    assert.ok(Array.isArray(o.warnings));
    const c = o.warnings.map((w) => w.code);
    for (const k of ['VALUATION_NOT_VERIFIED_BY_VALIDATOR', 'APPROVAL_NOT_VERIFIED_BY_VALIDATOR', 'COVERAGE_SNAPSHOT_AUTHENTICITY_NOT_VERIFIED']) assert.ok(c.includes(k), k);
  }
});
t('a complete, consistent valuation with WRONG amounts still passes and carries the not-verified warning', () => {
  const o = withV((v) => { v.components.assetsValue = 9; v.residualValue = 9 + 50000 + 20000 - 70000; });
  assert.equal(o.status, 'OK'); assert.equal(o.value, 9 + 500000);
  assert.ok(o.warnings.some((w) => w.code === 'VALUATION_NOT_VERIFIED_BY_VALIDATOR'));
});
t('invalid structural input -> INVALID_INPUT with warnings, no throw', () => {
  for (const bad of [null, undefined, 5, [], { asOfDate: 'nope', valuations: [], records: [] }, { asOfDate: AS, valuations: {}, records: [] }, { asOfDate: AS, valuations: [], records: 'x' }]) {
    const o = selectResidualValuation(bad);
    assert.equal(o.status, 'INVALID_INPUT'); assert.equal(o.value, null); assert.equal(o.complete, false); assert.ok(o.warnings.length >= 1);
  }
});

/* ---------- formula and components ---------- */
t('formula identity: each component alone and combined (closed forms)', () => {
  const cases = [[100, 0, 0, 0], [0, 100, 0, 0], [0, 0, 100, 0], [200, 0, 0, 50], [100, 20, 30, 40]];
  for (const [a, c, o, l] of cases) {
    const out = withV((v) => { v.components = { assetsValue: a, cashRetained: c, otherAssets: o, otherAssetsItems: o ? [{ description: 'x', amount: o }] : [], liabilities: l, distributionsPayable: 0 }; v.residualValue = a + c + o - l; });
    assert.equal(out.status, 'OK', JSON.stringify([a, c, o, l]));
    assert.equal(out.perFund[0].residualValue, a + c + o - l);
  }
});
t('stated residual that disagrees with the formula (beyond 0.01) is blocked; within 0.01 passes', () => {
  blocked(withV((v) => { v.residualValue = 1000000.02; }), 'RESIDUAL_FORMULA_MISMATCH');
  assert.equal(withV((v) => { v.residualValue = 1000000.005; }).status, 'OK');
});
t('negative residual is blocked', () => {
  blocked(withV((v) => { v.components.assetsValue = 0; v.components.cashRetained = 0; v.components.otherAssets = 0; v.components.otherAssetsItems = []; v.components.liabilities = 100; v.residualValue = -100; }), 'RESIDUAL_NEGATIVE');
});
t('otherAssets must be itemised and items must add up', () => {
  blocked(withV((v) => { v.components.otherAssetsItems = [{ description: 'x', amount: 5 }]; }), 'OTHER_ASSETS_ITEMS_INVALID');
  blocked(withV((v) => { delete v.components.otherAssetsItems; }), 'OTHER_ASSETS_ITEMS_INVALID');
  blocked(withV((v) => { v.components.otherAssetsItems = [{ description: '', amount: 20000 }]; }), 'OTHER_ASSETS_ITEMS_INVALID');
});
t('non-overlap declaration: missing / false in any of the three blocks', () => {
  for (const k of ['cashNotInAssets', 'otherAssetsNotInAssets', 'assetsStatedGrossOfLiabilities']) {
    blocked(withV((v) => { v.nonOverlap[k] = false; }), 'NON_OVERLAP_UNDECLARED');
    blocked(withV((v) => { delete v.nonOverlap[k]; }), 'NON_OVERLAP_UNDECLARED');
  }
  blocked(withV((v) => { delete v.nonOverlap; }), 'NON_OVERLAP_UNDECLARED');
});
t('amounts: strings, NaN, Infinity, negatives, null are rejected without coercion or default 0', () => {
  for (const bad of ['1000000', NaN, Infinity, -1, null, undefined]) {
    blocked(withV((v) => { v.components.assetsValue = bad; }), 'INVALID_AMOUNT');
    blocked(withV((v) => { v.components.cashRetained = bad; }), 'INVALID_AMOUNT');
    blocked(withV((v) => { v.components.liabilities = bad; }), 'INVALID_AMOUNT');
  }
  blocked(withV((v) => { v.residualValue = '1000000'; }), 'INVALID_AMOUNT');
  blocked(withV((v) => { delete v.residualValue; }), 'INVALID_AMOUNT');
  blocked(withV((v) => { delete v.components; }), 'INVALID_AMOUNT');
});
t('currency, basis, method, source: wrong or missing values are rejected', () => {
  blocked(withV((v) => { v.currency = 'USD'; }), 'INVALID_CURRENCY');
  blocked(withV((v) => { v.basis = 'UNDERWRITING_TOTAL_PROJECTED_EQUITY_PROCEEDS'; }), 'NAV_BASIS_UNRESOLVED');
  blocked(withV((v) => { delete v.basis; }), 'NAV_BASIS_UNRESOLVED');
  blocked(withV((v) => { v.method = 'guess'; }), 'INVALID_METHOD');
  blocked(withV((v) => { v.method = 'other'; }), 'INVALID_METHOD');
  assert.equal(withV((v) => { v.method = 'other'; v.methodNote = 'board resolution'; }).status, 'OK');
  blocked(withV((v) => { delete v.source; }), 'SOURCE_MISSING');
  blocked(withV((v) => { v.source.ref = ''; }), 'SOURCE_MISSING');
  blocked(withV((v) => { v.source.provider = '  '; }), 'SOURCE_MISSING');
});

/* ---------- unpaid distributions (temporary block) ---------- */
t('distributionsPayable is a required explicit amount: missing blocks', () => {
  blocked(withV((v) => { delete v.components.distributionsPayable; }), 'DISTRIBUTIONS_PAYABLE_UNDECLARED');
  blocked(withV((v) => { v.components.distributionsPayable = null; }), 'DISTRIBUTIONS_PAYABLE_UNDECLARED');
  blocked(withV((v) => { v.components.distributionsPayable = '0'; }), 'INVALID_AMOUNT');
});
t('distributionsPayable > 0 blocks (temporary)', () => {
  const o = withV((v) => { v.components.distributionsPayable = 1; });
  blocked(o, 'DISTRIBUTIONS_PAYABLE_UNRESOLVED');
  assert.equal(o.issues.find((i) => i.code === 'DISTRIBUTIONS_PAYABLE_UNRESOLVED').detail, 'declared-positive-amount');
});
t('declared 0 is not enough when the ledger shows an unpaid distribution (declared or approved)', () => {
  for (const status of ['declared', 'approved']) {
    const o = sel({ records: [call('c1', '2025-03-31', 1000000), dist('d1', '2025-09-30', 10, { status })] });
    blocked(o, 'DISTRIBUTIONS_PAYABLE_UNRESOLVED');
    assert.equal(o.issues.find((i) => i.code === 'DISTRIBUTIONS_PAYABLE_UNRESOLVED').detail, 'ledger-shows-unpaid-distribution');
  }
});
t('a FUTURE distDate does not exempt an unpaid distribution (no declaration date exists in the model)', () => {
  blocked(sel({ records: [call('c1', '2025-03-31', 1000000), dist('d1', '2027-01-01', 10, { status: 'declared' })] }), 'DISTRIBUTIONS_PAYABLE_UNRESOLVED');
  blocked(sel({ records: [call('c1', '2025-03-31', 1000000), dist('d1', '2027-01-01', 10, { status: 'approved' })] }), 'DISTRIBUTIONS_PAYABLE_UNRESOLVED');
});
t('an unpaid distribution is not cancelled by a "reversal pair" (no legitimate unpaid pair exists)', () => {
  blocked(sel({ records: [call('c1', '2025-03-31', 1000000), dist('d1', '2025-09-30', 10, { status: 'declared' }), dist('d2', '2025-09-30', -10, { status: 'declared', reversalOfId: 'd1' })] }), 'DISTRIBUTIONS_PAYABLE_UNRESOLVED');
});
t("distribution status 'waived' (capital calls only), missing or unknown statuses are blocked, never safe", () => {
  for (const status of ['waived', 'pending', 'cancelled', '', undefined, null, 5]) {
    blocked(sel({ records: [call('c1', '2025-03-31', 1000000), dist('d1', '2025-09-30', 10, { status })] }), 'DISTRIBUTION_STATUS_UNKNOWN');
  }
});
t('corrupt or missing distribution date is blocked (any status)', () => {
  for (const date of ['2025-02-30', '', undefined, null, '31/03/2026']) {
    blocked(sel({ records: [call('c1', '2025-03-31', 1000000), dist('d1', date, 10)] }), 'DISTRIBUTION_DATE_INVALID');
  }
});
t('paid distributions (including a paid correction pair) do not block and do not change the residual', () => {
  const plain = sel();
  const withPaid = sel({ records: [call('c1', '2025-03-31', 1000000), dist('d1', '2025-09-30', 300000), dist('d2', '2025-10-01', 1), dist('d3', '2025-10-01', -1, { reversalOfId: 'd2' })] });
  assert.equal(withPaid.status, 'OK'); assert.equal(withPaid.value, plain.value);
});
t('unpaid capital calls (pending/approved) neither block nor change the residual', () => {
  const o = sel({ records: [call('c1', '2025-03-31', 1000000), call('c2', '2026-01-01', 5, { status: 'approved' }), call('c3', '2026-01-01', 5, { status: 'pending' })] });
  assert.equal(o.status, 'OK'); assert.equal(o.value, 1500000);
});
t('unpaid distributions of a fund outside the scope are reported as a coverage gap, not silently ignored', () => {
  blocked(sel({ records: [call('c1', '2025-03-31', 1000000), dist('d9', '2025-09-30', 1, { fundId: 'f9', status: 'declared' })] }), 'COVERAGE_FUND_MISSING');
});

/* ---------- date and scope ---------- */
t('valuationDate must equal asOfDate: older / newer valuation is not selected (VALUATION_DATE_MISMATCH)', () => {
  for (const d of ['2026-03-30', '2026-04-01']) {
    const i = mk(); i.valuations[0].valuationDate = d;
    blocked(selectResidualValuation(i), 'VALUATION_DATE_MISMATCH');
  }
});
t('a valuation that is not a real calendar date is blocked', () => {
  for (const d of ['2026-02-30', '', undefined, '31/03/2026']) {
    const i = mk(); i.valuations[0].valuationDate = d;
    blocked(selectResidualValuation(i), 'INVALID_VALUATION_DATE');
  }
});
t('one common date for all funds (two funds, two dates -> second fund blocked)', () => {
  const i = mk(); i.valuations[1].valuationDate = '2026-03-30';
  const o = selectResidualValuation(i); blocked(o, 'VALUATION_DATE_MISMATCH');
  assert.ok(o.issues.find((x) => x.code === 'VALUATION_DATE_MISMATCH').ids.includes('fund:f2'));
});
t('scope snapshot date must equal the valuation date; explicit dates only (no clock)', () => {
  for (const d of ['2026-03-30', undefined, 'bad']) { const i = mk(); i.scope.snapshotDate = d; blocked(selectResidualValuation(i), 'COVERAGE_SNAPSHOT_DATE_MISMATCH'); }
  assert.ok(!/new Date\(\s*\)|Date\.now/.test(readFileSync(fileURLToPath(new URL('./residual-valuation.js', import.meta.url)), 'utf8')));
});
t('scope: malformed scope blocks with COVERAGE_SCOPE_INVALID', () => {
  for (const mutate of [(i) => { delete i.scope; }, (i) => { i.scope.funds = []; }, (i) => { i.scope.funds = ['f1', 'f1']; }, (i) => { i.scope.funds = ['f1', 5]; }, (i) => { delete i.scope.linksByFund.f2; }, (i) => { i.scope.linksByFund.f1 = ['a1', 'a1']; }]) {
    const i = mk(); mutate(i); blocked(selectResidualValuation(i), 'COVERAGE_SCOPE_INVALID');
  }
});
t('a fund with ledger records dated <= valuation date (or undated) but outside the scope blocks', () => {
  blocked(sel({ records: [call('c1', '2025-03-31', 1000000), call('c9', '2025-01-01', 5, { fundId: 'f9' })] }), 'COVERAGE_FUND_MISSING');
  blocked(sel({ records: [call('c1', '2025-03-31', 1000000), call('c9', 'bad', 5, { fundId: 'f9' })] }), 'COVERAGE_FUND_MISSING');
  blocked(sel({ records: [call('c1', '2025-03-31', 1000000), call('c9', '2025-01-01', 5, { fundId: undefined })] }), 'COVERAGE_FUND_MISSING');
  assert.equal(sel({ records: [call('c1', '2025-03-31', 1000000), call('c9', '2027-01-01', 5, { fundId: 'f9' })] }).status, 'OK'); // later than the valuation date
});
t('a scope fund without any valuation blocks the whole result (no partial-portfolio value)', () => {
  const i = mk(); i.valuations = [i.valuations[0]];
  const o = selectResidualValuation(i); blocked(o, 'COVERAGE_FUND_MISSING');
});
t('a valuation for a fund outside the scope is COVERAGE_FUND_UNKNOWN', () => {
  const i = mk(); i.valuations.push(val('f9', 'v-f9'));
  blocked(selectResidualValuation(i), 'COVERAGE_FUND_UNKNOWN');
});

/* ---------- coverage statement ---------- */
t('linked assets: missing, extra and duplicate entries are named; order is irrelevant', () => {
  const miss = withV((v) => { v.coverage.linkedAssets = ['a1']; }); blocked(miss, 'COVERAGE_ASSET_MISSING');
  assert.deepEqual(miss.issues.find((i) => i.code === 'COVERAGE_ASSET_MISSING').ids, ['asset:a2']);
  const extra = withV((v) => { v.coverage.linkedAssets = ['a1', 'a2', 'a3']; }); blocked(extra, 'COVERAGE_ASSET_UNKNOWN');
  assert.deepEqual(extra.issues.find((i) => i.code === 'COVERAGE_ASSET_UNKNOWN').ids, ['asset:a3']);
  blocked(withV((v) => { v.coverage.linkedAssets = ['a1', 'a2', 'a2']; }), 'COVERAGE_ASSET_DUPLICATE');
  assert.equal(withV((v) => { v.coverage.linkedAssets = ['a2', 'a1']; }).status, 'OK');
  blocked(withV((v) => { delete v.coverage; }), 'COVERAGE_ASSET_MISSING');
});
t('coverage is compared with the SNAPSHOT links (not with anything current)', () => {
  const i = mk(); i.scope.linksByFund.f1 = ['a1', 'a2', 'a3'];
  blocked(selectResidualValuation(i), 'COVERAGE_ASSET_MISSING');
});
t('unlinkedHoldings statement is mandatory; absence is never read as none', () => {
  blocked(withV((v) => { delete v.coverage.unlinkedHoldings; }), 'COVERAGE_UNLINKED_UNSTATED');
  blocked(withV((v) => { v.coverage.unlinkedHoldings = {}; }), 'COVERAGE_UNLINKED_UNSTATED');
  blocked(withV((v) => { v.coverage.unlinkedHoldings = { declared: 'maybe' }; }), 'COVERAGE_UNLINKED_UNSTATED');
});
t('unlinkedHoldings included: needs items, items are part of assetsValue (not an addition) and may not exceed it', () => {
  const ok = withV((v) => { v.coverage.unlinkedHoldings = { declared: 'included', items: [{ description: 'plot', amount: 300000 }] }; });
  assert.equal(ok.status, 'OK'); assert.equal(ok.perFund[0].residualValue, 1000000); // unchanged: included, not added
  blocked(withV((v) => { v.coverage.unlinkedHoldings = { declared: 'included', items: [{ description: 'plot', amount: 1000001 }] }; }), 'UNLINKED_ITEMS_EXCEED_ASSETS');
  blocked(withV((v) => { v.coverage.unlinkedHoldings = { declared: 'included', items: [] }; }), 'COVERAGE_UNLINKED_INVALID');
  blocked(withV((v) => { v.coverage.unlinkedHoldings = { declared: 'included' }; }), 'COVERAGE_UNLINKED_INVALID');
  blocked(withV((v) => { v.coverage.unlinkedHoldings = { declared: 'none', items: [{ description: 'x', amount: 1 }] }; }), 'COVERAGE_UNLINKED_INVALID');
});

/* ---------- versions ---------- */
const chain = () => {
  const i = mk();
  i.valuations = [val('f1', 'v1'), val('f1', 'v2', { version: 2, supersedes: 'v1', components: { assetsValue: 1100000, cashRetained: 50000, otherAssets: 20000, otherAssetsItems: [{ description: 'receivable', amount: 20000 }], liabilities: 70000, distributionsPayable: 0 }, residualValue: 1100000 }), val('f2', 'v-f2')];
  return i;
};
t('v1 + correction v2: exactly one effective valuation (v2), v1 is not summed', () => {
  const o = selectResidualValuation(chain());
  assert.equal(o.status, 'OK'); assert.equal(o.value, 1100000 + 500000);
  assert.equal(o.perFund.find((p) => p.fundId === 'f1').valuationId, 'v2');
});
t('record order does not matter', () => {
  const i = chain(); i.valuations.reverse();
  assert.equal(selectResidualValuation(i).value, 1600000);
});
t('three-step chain resolves to v3', () => {
  const i = chain(); i.valuations.push(val('f1', 'v3', { version: 3, supersedes: 'v2', residualValue: 1000000 }));
  const o = selectResidualValuation(i); assert.equal(o.status, 'OK'); assert.equal(o.perFund.find((p) => p.fundId === 'f1').valuationId, 'v3');
});
t('a draft correction on top of an approved v1 is ignored (v1 stays effective)', () => {
  const i = chain(); i.valuations[1].status = 'draft';
  const o = selectResidualValuation(i); assert.equal(o.status, 'OK'); assert.equal(o.perFund.find((p) => p.fundId === 'f1').valuationId, 'v1');
});
t('an approved version whose predecessor is a draft is reported (VERSION_PREDECESSOR_NOT_APPROVED)', () => {
  const i = chain(); i.valuations.push(val('f1', 'v3', { version: 3, supersedes: 'v2' })); i.valuations[1].status = 'draft';
  blocked(selectResidualValuation(i), 'VERSION_PREDECESSOR_NOT_APPROVED');
});
t('missing predecessor: VERSION_CHAIN_INCOMPLETE (input-completeness reason, not a claim of corrupt data)', () => {
  const i = chain(); i.valuations.splice(0, 1);
  const o = selectResidualValuation(i); blocked(o, 'VERSION_CHAIN_INCOMPLETE');
  assert.equal(o.issues.find((x) => x.code === 'VERSION_CHAIN_INCOMPLETE').detail, 'predecessor-not-present-in-the-input');
  assert.ok(!codes(o).includes('AMBIGUOUS_VALUATION_VERSIONS'));
  const j = mk(); j.valuations[0].version = 2; j.valuations[0].supersedes = null; blocked(selectResidualValuation(j), 'VERSION_CHAIN_INCOMPLETE');
});
t('two heads, version gap, self-supersede, cross-fund / cross-date predecessor, duplicate id, two successors: AMBIGUOUS_VALUATION_VERSIONS', () => {
  const twoHeads = mk(); twoHeads.valuations.push(val('f1', 'v1b')); blocked(selectResidualValuation(twoHeads), 'AMBIGUOUS_VALUATION_VERSIONS');
  const gap = chain(); gap.valuations[1].version = 3; blocked(selectResidualValuation(gap), 'AMBIGUOUS_VALUATION_VERSIONS');
  const selfSup = chain(); selfSup.valuations[1].supersedes = 'v2'; blocked(selectResidualValuation(selfSup), 'AMBIGUOUS_VALUATION_VERSIONS');
  const crossFund = chain(); crossFund.valuations[1].supersedes = 'v-f2'; blocked(selectResidualValuation(crossFund), 'AMBIGUOUS_VALUATION_VERSIONS');
  const crossDate = chain(); crossDate.valuations[0].valuationDate = '2026-03-30'; crossDate.valuations.push(val('f1', 'v-other-head', { version: 1 }));
  blocked(selectResidualValuation(crossDate), 'AMBIGUOUS_VALUATION_VERSIONS');
  const dup = chain(); dup.valuations.push(clone(dup.valuations[0])); blocked(selectResidualValuation(dup), 'AMBIGUOUS_VALUATION_VERSIONS');
  const twoSucc = chain(); twoSucc.valuations.push(val('f1', 'v2b', { version: 2, supersedes: 'v1' })); blocked(selectResidualValuation(twoSucc), 'AMBIGUOUS_VALUATION_VERSIONS');
  const v1sup = mk(); v1sup.valuations[0].supersedes = 'x'; blocked(selectResidualValuation(v1sup), 'AMBIGUOUS_VALUATION_VERSIONS');
  const badVer = mk(); badVer.valuations[0].version = 0; blocked(selectResidualValuation(badVer), 'AMBIGUOUS_VALUATION_VERSIONS');
});
t('draft-only fund is not covered; unknown status is named', () => {
  const i = mk(); i.valuations[0].status = 'draft'; blocked(selectResidualValuation(i), 'COVERAGE_FUND_MISSING');
  const j = mk(); j.valuations[0].status = 'pending'; blocked(selectResidualValuation(j), 'INVALID_STATUS');
});
t('approval data: missing approvedBy / enteredBy, or approvedBy == enteredBy (case/space-insensitive), is rejected', () => {
  blocked(withV((v) => { delete v.approvedBy; }), 'APPROVAL_DATA_INVALID');
  blocked(withV((v) => { delete v.enteredBy; }), 'APPROVAL_DATA_INVALID');
  blocked(withV((v) => { v.approvedBy = ' PREP@x.sa '; }), 'APPROVAL_DATA_INVALID');
});
t('a flawed superseded version does not affect the effective one', () => {
  const i = chain(); i.valuations[0].currency = 'USD';
  assert.equal(selectResidualValuation(i).status, 'OK');
});
t('all reasons are listed together, ids are kind-qualified, not only the first', () => {
  const o = withV((v) => { v.currency = 'USD'; delete v.source; v.coverage.linkedAssets = ['a1']; });
  assert.ok(['INVALID_CURRENCY', 'SOURCE_MISSING', 'COVERAGE_ASSET_MISSING'].every((c) => has(o, c)));
  for (const i of o.issues) for (const id of i.ids) assert.match(id, /^(fund|fundValuation|asset|distribution|capitalCall|scope):/);
});

/* ---------- integration through an explicit TEST-ONLY wrapper ---------- */
// computePortfolioNetXirr does not forward extra NAV fields (perFund, warnings) by design; the production UI is not
// touched in R1-A. This wrapper maps the selector output to `nav` and keeps the residual detail next to the result.
function integrate(input) {
  const s = selectResidualValuation(input);
  const nav = { value: s.value, complete: s.complete, basis: s.basis, source: s.source, valuationDate: s.valuationDate, issues: s.issues };
  const result = computePortfolioNetXirr({ asOfDate: input.asOfDate, records: input.records, nav });
  return { selection: s, result, residual: { perFund: s.perFund, warnings: s.warnings, issues: s.issues } };
}
t('integration: valid valuation -> shared solver returns the closed-form rate; residual detail and warning retained by the wrapper', () => {
  // call -1,000,000 on 2025-03-31 (365 days), residual 1,500,000 on 2026-03-31 -> exactly 50 %
  const r = integrate(mk());
  assert.equal(r.result.status, 'OK'); assert.ok(Math.abs(r.result.rate - 0.5) < 1e-9, String(r.result.rate));
  assert.equal(r.result.navSource, NAV_SOURCE_LABEL); assert.equal(r.result.navValuationDate, AS);
  assert.equal(r.result.perFund, undefined); // the production result does not carry the detail: that is why the wrapper exists
  assert.equal(r.residual.perFund.length, 2);
  assert.ok(r.residual.warnings.some((w) => w.code === 'VALUATION_NOT_VERIFIED_BY_VALIDATOR'));
  assert.ok(r.result.sourceWarnings.some((w) => w.code === 'LEDGER_DATES_ARE_RECORD_DATES'));
  assert.ok(!r.result.sourceWarnings.some((w) => w.code === 'NAV_VALUATION_DATE_UNKNOWN'));
});
t('integration: a blocked selection leaves the rate blocked and the wrapper keeps issues + warnings', () => {
  const i = mk(); i.valuations[1].status = 'draft';
  const r = integrate(i);
  assert.equal(r.result.status, 'INSUFFICIENT_SOURCE_DATA'); assert.ok(r.result.reasonCodes.includes('NAV_INVALID')); assert.ok(r.result.reasonCodes.includes('NAV_INCOMPLETE'));
  assert.equal(r.result.rate, undefined);
  assert.ok(r.residual.issues.some((x) => x.code === 'COVERAGE_FUND_MISSING'));
  assert.ok(r.residual.warnings.some((w) => w.code === 'VALUATION_NOT_VERIFIED_BY_VALIDATOR'));
});
t('integration: an in-kind call stays blocked even with a valid valuation', () => {
  const r = integrate(mk({ records: [call('c1', '2025-03-31', 1000000, { inKindAssetId: 'a1' })] }));
  assert.equal(r.selection.status, 'OK');
  assert.equal(r.result.status, 'INSUFFICIENT_SOURCE_DATA'); assert.ok(r.result.reasonCodes.includes('IN_KIND_VALUE_BASIS_UNRESOLVED'));
});
t('integration: paid distributions in the ledger lower no residual and enter the flows once (closed form)', () => {
  // -1,000,000 @2025-03-31 ; +300,000 @2025-09-30 (paid) ; +1,500,000 @2026-03-31 residual
  const r = integrate(mk({ records: [call('c1', '2025-03-31', 1000000), dist('d1', '2025-09-30', 300000)] }));
  assert.equal(r.selection.value, 1500000); assert.equal(r.result.status, 'OK');
  const t0 = Date.parse('2025-03-31T00:00:00Z'), d = (s) => (Date.parse(s + 'T00:00:00Z') - t0) / 86400000 / 365;
  const npv = (x) => -1000000 + 300000 / Math.pow(1 + x, d('2025-09-30')) + 1500000 / Math.pow(1 + x, d('2026-03-31'));
  assert.ok(Math.abs(npv(r.result.rate)) < 1e-3, String(npv(r.result.rate)));
});

/* ---------- regression: unpaid / unknown-status distributions of a fund OUTSIDE the scope ---------- */
t('out-of-scope fund + FUTURE approved distribution: blocked as coverage gap AND unresolved due-ness (date never exempts)', () => {
  for (const status of ['approved', 'declared']) {
    const o = sel({ records: [call('c1', '2025-03-31', 1000000), dist('d9', '2027-01-01', 10, { fundId: 'f9', status })] });
    blocked(o, 'COVERAGE_FUND_MISSING'); assert.ok(has(o, 'DISTRIBUTIONS_PAYABLE_UNRESOLVED'));
    assert.equal(o.issues.find((i) => i.code === 'COVERAGE_FUND_MISSING').detail, 'fund-has-unpaid-or-unknown-status-distribution-but-is-not-in-scope');
    assert.ok(o.issues.find((i) => i.code === 'COVERAGE_FUND_MISSING').ids.includes('fund:f9'));
    assert.ok(o.issues.find((i) => i.code === 'DISTRIBUTIONS_PAYABLE_UNRESOLVED').ids.includes('distribution:d9'));
  }
});
t('out-of-scope fund + unknown / missing distribution status (future or past): blocked, coverage gap + status not settled', () => {
  for (const status of ['waived', 'pending', 'cancelled', '', undefined, null]) {
    for (const date of ['2027-01-01', '2025-01-01']) {
      const o = sel({ records: [call('c1', '2025-03-31', 1000000), dist('d9', date, 10, { fundId: 'f9', status })] });
      blocked(o, 'COVERAGE_FUND_MISSING'); assert.ok(has(o, 'DISTRIBUTION_STATUS_UNKNOWN'), String(status));
    }
  }
});
t('out-of-scope fund + corrupt distribution date is blocked too', () => {
  const o = sel({ records: [call('c1', '2025-03-31', 1000000), dist('d9', '2025-02-30', 10, { fundId: 'f9' })] });
  blocked(o, 'COVERAGE_FUND_MISSING'); assert.ok(has(o, 'DISTRIBUTION_DATE_INVALID'));
});
t('unchanged: a PAID record (or a non-distribution record) dated after the valuation date in an out-of-scope fund does not block', () => {
  assert.equal(sel({ records: [call('c1', '2025-03-31', 1000000), dist('d9', '2027-01-01', 10, { fundId: 'f9', status: 'paid' })] }).status, 'OK');
  assert.equal(sel({ records: [call('c1', '2025-03-31', 1000000), call('c9', '2027-01-01', 5, { fundId: 'f9', status: 'approved' })] }).status, 'OK');
});

/* ---------- regression: every sum and computed result must stay finite ---------- */
const big = 1e308, half = 5e307;
const only = (assets, extra = {}) => ({ components: { assetsValue: assets, cashRetained: 0, otherAssets: 0, otherAssetsItems: [], liabilities: 0, distributionsPayable: 0 }, residualValue: assets, ...extra });
t('portfolio total overflow: two finite fund residuals whose sum is not finite -> NUMERIC_OVERFLOW, complete=false, value=null (not success)', () => {
  const i = mk(); i.valuations = [val('f1', 'v-f1', only(big)), val('f2', 'v-f2', only(big))];
  const o = selectResidualValuation(i);
  blocked(o, 'NUMERIC_OVERFLOW');
  assert.deepEqual(o.issues.find((x) => x.code === 'NUMERIC_OVERFLOW').ids, ['portfolio']);
  assert.notEqual(o.status, 'OK'); assert.ok(!Object.values(o).some((v) => v === Infinity));
});
t('portfolio total just below the limit is still computed (boundary)', () => {
  const i = mk(); i.valuations = [val('f1', 'v-f1', only(big)), val('f2', 'v-f2', only(half))];
  const o = selectResidualValuation(i);
  assert.equal(o.status, 'OK'); assert.equal(o.value, 1.5e308); assert.ok(Number.isFinite(o.value));
});
t('formula step overflow (assets + cash) is a named block, not a mismatch or success', () => {
  blocked(withV((v) => { v.components.assetsValue = 1.7e308; v.components.cashRetained = 1.7e308; v.residualValue = 1.7e308; }), 'NUMERIC_OVERFLOW');
  const o = withV((v) => { v.components.assetsValue = 1.7e308; v.components.cashRetained = 1.7e308; v.components.liabilities = 1.7e308; v.residualValue = 1.7e308; });
  blocked(o, 'NUMERIC_OVERFLOW'); // an overflowing intermediate step is refused even if the exact result would be representable
  assert.ok(!has(o, 'RESIDUAL_FORMULA_MISMATCH'));
});
t('otherAssetsItems sum overflow and unlinked-items sum overflow are named blocks', () => {
  blocked(withV((v) => { v.components.assetsValue = 0; v.components.cashRetained = 0; v.components.liabilities = 0; v.components.otherAssets = 1.7e308; v.components.otherAssetsItems = [{ description: 'a', amount: 1.7e308 }, { description: 'b', amount: 1.7e308 }]; v.residualValue = 1.7e308; }), 'NUMERIC_OVERFLOW');
  blocked(withV((v) => { v.components.assetsValue = 1.7e308; v.components.cashRetained = 0; v.components.otherAssets = 0; v.components.otherAssetsItems = []; v.components.liabilities = 0; v.residualValue = 1.7e308; v.coverage.unlinkedHoldings = { declared: 'included', items: [{ description: 'a', amount: 1.7e308 }, { description: 'b', amount: 1.7e308 }] }; }), 'NUMERIC_OVERFLOW');
});
t('integration: an overflowing selection never reaches the solver as a value (wrapper result stays blocked)', () => {
  const i = mk(); i.valuations = [val('f1', 'v-f1', only(big)), val('f2', 'v-f2', only(big))];
  const r = integrate(i);
  assert.equal(r.selection.value, null); assert.equal(r.selection.complete, false);
  assert.equal(r.result.status, 'INSUFFICIENT_SOURCE_DATA'); assert.ok(r.result.reasonCodes.includes('NAV_INVALID')); assert.equal(r.result.rate, undefined);
  assert.ok(r.residual.issues.some((x) => x.code === 'NUMERIC_OVERFLOW'));
});

/* ---------- structural guarantees ---------- */
t('no code path reads equity or MOIC (static check on the module source, comments stripped)', () => {
  const src = readFileSync(fileURLToPath(new URL('./residual-valuation.js', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/equity|moic/i.test(src));
  assert.deepEqual([...src.matchAll(/^import .* from '(.*)';/gm)].map((m) => m[1]), ['./portfolio-xirr.js']);
});
t('pure and deterministic: same input twice gives the same output and the input is not mutated', () => {
  const i = chain(), snap = JSON.stringify(i);
  assert.deepEqual(selectResidualValuation(i), selectResidualValuation(i));
  assert.equal(JSON.stringify(i), snap);
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
