/* =========================================================================
   Residual valuation selector (XIRR-R1A) — pure function, no DOM, no core, no I/O, no clock.
   Contract: docs/XIRR_RESIDUAL_VALUATION_CONTRACT.md
   Status: data contract + validator + selector ONLY. Not wired to any UI, store or rate.

   Output shape is ready to be mapped later to the `nav` input of computePortfolioNetXirr:
   { status, value, complete, basis, source, valuationDate, perFund, issues, warnings, reasonCodes }.

   WHAT THIS CHECKS: that the supplied valuation records, coverage statement, scope snapshot and ledger
   records are complete and consistent with each other (arithmetic, dates, versions, coverage).
   WHAT THIS CANNOT CHECK (and says so in `warnings`): that a valuation is correct, that an approval
   really happened, that the scope snapshot truly reflects the state on its date, or that the
   preparer's non-overlap declarations are true.

   The input is "approved valuation versions + scope snapshot + ledger records". The complete version
   chain of every fund/date is a precondition of the input; a missing predecessor is reported as an
   incomplete chain, never as proof that the original data is corrupt.
   ========================================================================= */
import { isRealIsoDate } from './portfolio-xirr.js';

export const NAV_BASIS = 'RESIDUAL_VALUE_AS_OF_DATE';
export const NAV_SOURCE_LABEL = 'FUND_VALUATIONS_APPROVED';
export const VALUATION_METHODS = ['appraisal', 'nav_statement', 'cost_basis', 'other'];
export const VALUATION_STATUSES = ['draft', 'approved'];
export const FORMULA_TOLERANCE = 0.01; // SAR
// Statuses that exist for distributions in the code base (core.js DISTRIBUTION_STATUS; functions/index.js
// LEDGER_INITIAL_STATUS / transitions). 'waived' exists for capital calls ONLY and is therefore unknown here.
export const DISTRIBUTION_UNPAID_STATUSES = ['declared', 'approved'];
export const DISTRIBUTION_KNOWN_STATUSES = ['declared', 'approved', 'paid'];

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v); // strings are NOT coerced
const isNonNeg = (v) => isNum(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function standardWarnings() {
  return [
    { code: 'VALUATION_NOT_VERIFIED_BY_VALIDATOR', message: 'The validator checks completeness and internal consistency only. It does not establish that the valuation, its amounts or its source are correct.' },
    { code: 'APPROVAL_NOT_VERIFIED_BY_VALIDATOR', message: 'status / approvedBy are data values supplied with the record. The validator does not establish that an approval actually took place or who may approve.' },
    { code: 'COVERAGE_SNAPSHOT_AUTHENTICITY_NOT_VERIFIED', message: 'The scope snapshot is compared with the valuation by its stated date only (no clock is used). That it truly reflects the state on that date is outside what this function can establish.' },
  ];
}

/**
 * @param {object} input
 * @param {string} input.asOfDate  real ISO date; every valuation must carry exactly this valuationDate
 * @param {{snapshotDate:string, funds:string[], linksByFund:Object<string,string[]>}} input.scope
 *        portfolio fund set and the assets linked to each fund, both as of snapshotDate (must equal asOfDate)
 * @param {Array<object>} input.valuations  all valuation versions of every fund for asOfDate (complete chains)
 * @param {Array<{kind:string,id:string,fundId:string,date:string,status:string}>} input.records
 *        ledger records, same shape as the XIRR-P input (only capitalCall / distribution kinds are read)
 */
export function selectResidualValuation(input) {
  const base = (extra) => ({
    value: null, complete: false, basis: NAV_BASIS, source: NAV_SOURCE_LABEL,
    valuationDate: null, perFund: [], issues: [], reasonCodes: [], warnings: standardWarnings(), ...extra,
  });

  if (!isPlainObject(input)) return base({ status: 'INVALID_INPUT', reason: 'input must be an object.' });
  const { asOfDate, scope, valuations, records } = input;
  if (!isRealIsoDate(asOfDate)) return base({ status: 'INVALID_INPUT', reason: 'asOfDate is required and must be a real calendar date (YYYY-MM-DD).' });
  if (!Array.isArray(valuations)) return base({ status: 'INVALID_INPUT', reason: 'valuations must be an array.', valuationDate: asOfDate });
  if (!Array.isArray(records)) return base({ status: 'INVALID_INPUT', reason: 'records must be an array.', valuationDate: asOfDate });

  const issues = [];
  const add = (code, ids, detail) => {
    let e = issues.find((x) => x.code === code && x.detail === detail);
    if (!e) { e = { code, ids: [], ...(detail ? { detail } : {}) }; issues.push(e); }
    for (const id of ids) if (!e.ids.includes(id)) e.ids.push(id);
  };
  const finish = (perFund, value) => {
    const blocked = issues.length > 0;
    return {
      status: blocked ? 'BLOCKED' : 'OK',
      value: blocked ? null : value,
      complete: !blocked,
      basis: NAV_BASIS, source: NAV_SOURCE_LABEL, valuationDate: asOfDate,
      perFund: blocked ? [] : perFund,
      issues,
      reasonCodes: [...new Set(issues.map((i) => i.code))],
      warnings: standardWarnings(),
    };
  };

  /* ---- 1. scope snapshot (explicit dates only; no clock) ---- */
  let scopeOk = isPlainObject(scope) && Array.isArray(scope.funds) && isPlainObject(scope.linksByFund);
  const scopeFunds = new Set();
  if (!scopeOk) add('COVERAGE_SCOPE_INVALID', ['scope'], 'scope must carry snapshotDate, funds[] and linksByFund{}');
  else {
    if (!isRealIsoDate(scope.snapshotDate)) add('COVERAGE_SNAPSHOT_DATE_MISMATCH', ['scope'], 'snapshotDate-missing-or-not-a-real-date');
    else if (scope.snapshotDate !== asOfDate) add('COVERAGE_SNAPSHOT_DATE_MISMATCH', ['scope'], `snapshotDate ${scope.snapshotDate} differs from valuation date ${asOfDate}`);
    for (const f of scope.funds) {
      if (!isStr(f)) { add('COVERAGE_SCOPE_INVALID', ['scope'], 'fund id is not a non-empty string'); scopeOk = false; continue; }
      if (scopeFunds.has(f)) { add('COVERAGE_SCOPE_INVALID', [`fund:${f}`], 'duplicate fund in scope'); scopeOk = false; }
      scopeFunds.add(f);
    }
    if (scopeFunds.size === 0) { add('COVERAGE_SCOPE_INVALID', ['scope'], 'scope has no funds'); scopeOk = false; }
    for (const f of scopeFunds) {
      const l = scope.linksByFund[f];
      if (!Array.isArray(l) || l.some((a) => !isStr(a)) || new Set(l).size !== l.length) { add('COVERAGE_SCOPE_INVALID', [`fund:${f}`], 'linksByFund entry missing, not an array of unique asset ids'); scopeOk = false; }
    }
  }
  if (!scopeOk) return finish([], null);

  /* ---- 2. ledger scan: unpaid distributions, unknown statuses, corrupt dates, funds outside the scope ---- */
  // Distribution statuses in the code are declared -> approved -> paid. There is no declaration date in the model,
  // so a distDate (past or future) is NOT evidence that an unpaid distribution was not yet declared / due at the
  // valuation date. Any unpaid distribution of a scope fund therefore blocks. A pair of unpaid records is not
  // cancelled either: reverseTransaction accepts only POSTED (paid) distributions, so no legitimate unpaid pair exists.
  for (const r of records) {
    if (!isPlainObject(r) || (r.kind !== 'capitalCall' && r.kind !== 'distribution')) continue;
    const ref = `${r.kind}:${r.id != null ? r.id : '(no id)'}`;
    if (!isStr(r.fundId)) { add('COVERAGE_FUND_MISSING', [ref], 'record-without-fund'); continue; }
    const inScope = scopeFunds.has(r.fundId);
    if (!inScope) {
      // A paid record dated after the valuation date of an out-of-scope fund is not part of the flows. An unpaid or
      // unknown-status DISTRIBUTION is different: its due-ness at the valuation date cannot be determined (no declaration
      // date in the model), so its date never exempts it, in scope or not. It is a coverage gap AND an unresolved case.
      const undetermined = r.kind === 'distribution' && !(r.status === 'paid');
      if (undetermined) {
        add('COVERAGE_FUND_MISSING', [`fund:${r.fundId}`], 'fund-has-unpaid-or-unknown-status-distribution-but-is-not-in-scope');
        if (DISTRIBUTION_UNPAID_STATUSES.includes(r.status)) add('DISTRIBUTIONS_PAYABLE_UNRESOLVED', [ref], 'ledger-shows-unpaid-distribution-in-fund-outside-scope');
        else add('DISTRIBUTION_STATUS_UNKNOWN', [ref], `${String(r.status)} (fund outside scope)`);
      } else if (!isRealIsoDate(r.date) || r.date <= asOfDate) add('COVERAGE_FUND_MISSING', [`fund:${r.fundId}`], 'fund-has-ledger-records-but-is-not-in-scope');
      if (r.kind === 'distribution' && !isRealIsoDate(r.date)) add('DISTRIBUTION_DATE_INVALID', [ref]);
      continue;
    }
    if (r.kind !== 'distribution') continue;
    if (!DISTRIBUTION_KNOWN_STATUSES.includes(r.status)) add('DISTRIBUTION_STATUS_UNKNOWN', [ref], String(r.status));
    else if (DISTRIBUTION_UNPAID_STATUSES.includes(r.status)) add('DISTRIBUTIONS_PAYABLE_UNRESOLVED', [ref], 'ledger-shows-unpaid-distribution');
    if (!isRealIsoDate(r.date)) add('DISTRIBUTION_DATE_INVALID', [ref]);
  }

  /* ---- 3. group valuation versions ---- */
  const byId = new Map();
  const dupIds = new Set();
  const forFund = new Map(); // fundId -> versions dated asOfDate
  const otherDates = new Map(); // fundId -> Set of other dates seen
  for (const v of valuations) {
    if (!isPlainObject(v) || !isStr(v.valuationId)) { add('VALUATION_RECORD_INVALID', ['fundValuation:(no id)'], 'valuationId missing'); continue; }
    if (byId.has(v.valuationId)) dupIds.add(v.valuationId);
    byId.set(v.valuationId, v);
    if (!isStr(v.fundId)) { add('VALUATION_RECORD_INVALID', [`fundValuation:${v.valuationId}`], 'fundId missing'); continue; }
    if (!isRealIsoDate(v.valuationDate)) { add('INVALID_VALUATION_DATE', [`fundValuation:${v.valuationId}`]); continue; }
    if (!scopeFunds.has(v.fundId)) { if (v.valuationDate === asOfDate) add('COVERAGE_FUND_UNKNOWN', [`fundValuation:${v.valuationId}`], v.fundId); continue; }
    if (v.valuationDate !== asOfDate) {
      if (!otherDates.has(v.fundId)) otherDates.set(v.fundId, new Set());
      otherDates.get(v.fundId).add(v.valuationDate);
      continue;
    }
    if (!forFund.has(v.fundId)) forFund.set(v.fundId, []);
    forFund.get(v.fundId).push(v);
  }
  for (const id of dupIds) add('AMBIGUOUS_VALUATION_VERSIONS', [`fundValuation:${id}`], 'duplicate-valuationId');

  const perFund = [];
  let total = 0;
  for (const fundId of scope.funds) {
    const fRef = `fund:${fundId}`;
    const versions = forFund.get(fundId) || [];
    if (versions.length === 0) {
      if (otherDates.has(fundId)) add('VALUATION_DATE_MISMATCH', [fRef], `valuations exist only for other dates: ${[...otherDates.get(fundId)].sort().join(',')}`);
      else add('COVERAGE_FUND_MISSING', [fRef], 'no-valuation-for-fund');
      continue;
    }
    const res = effectiveVersion(versions, byId, fRef, add);
    if (!res) continue;
    const rec = validateEffective(res, fundId, scope.linksByFund[fundId], add);
    if (rec) {
      perFund.push(rec);
      total += rec.residualValue;
      if (!Number.isFinite(total)) { add('NUMERIC_OVERFLOW', ['portfolio'], 'sum-of-residual-values-is-not-finite'); break; }
    }
  }
  return finish(perFund, total);
}

/* Version chain over APPROVED records only. Drafts are outside the chain (as record or as predecessor). */
function effectiveVersion(versions, byId, fRef, add) {
  const vRef = (v) => `fundValuation:${v.valuationId}`;
  for (const v of versions) {
    if (!VALUATION_STATUSES.includes(v.status)) add('INVALID_STATUS', [vRef(v)], String(v.status));
  }
  const approved = versions.filter((v) => v.status === 'approved');
  if (approved.length === 0) { add('COVERAGE_FUND_MISSING', [fRef], 'no-approved-valuation-for-fund'); return null; }
  let chainOk = true;
  const succ = new Map();
  for (const v of approved) {
    if (!Number.isInteger(v.version) || v.version < 1) { add('AMBIGUOUS_VALUATION_VERSIONS', [vRef(v)], 'version-not-a-positive-integer'); chainOk = false; continue; }
    if (v.version === 1) {
      if (v.supersedes != null) { add('AMBIGUOUS_VALUATION_VERSIONS', [vRef(v)], 'version-1-must-not-supersede'); chainOk = false; }
      continue;
    }
    if (!isStr(v.supersedes)) { add('VERSION_CHAIN_INCOMPLETE', [vRef(v)], 'version-above-1-names-no-predecessor'); chainOk = false; continue; }
    if (v.supersedes === v.valuationId) { add('AMBIGUOUS_VALUATION_VERSIONS', [vRef(v)], 'supersedes-itself'); chainOk = false; continue; }
    const pred = byId.get(v.supersedes);
    if (!pred) { add('VERSION_CHAIN_INCOMPLETE', [vRef(v)], 'predecessor-not-present-in-the-input'); chainOk = false; continue; }
    if (pred.fundId !== v.fundId || pred.valuationDate !== v.valuationDate) { add('AMBIGUOUS_VALUATION_VERSIONS', [vRef(v)], 'predecessor-belongs-to-another-fund-or-date'); chainOk = false; continue; }
    if (pred.status !== 'approved') { add('VERSION_PREDECESSOR_NOT_APPROVED', [vRef(v)], `predecessor ${pred.valuationId} has status ${String(pred.status)}`); chainOk = false; continue; }
    if (pred.version !== v.version - 1) { add('AMBIGUOUS_VALUATION_VERSIONS', [vRef(v)], 'version-is-not-predecessor-plus-one'); chainOk = false; continue; }
    succ.set(pred.valuationId, (succ.get(pred.valuationId) || 0) + 1);
  }
  for (const [id, n] of succ) if (n > 1) { add('AMBIGUOUS_VALUATION_VERSIONS', [`fundValuation:${id}`], 'more-than-one-successor'); chainOk = false; }
  if (!chainOk) return null;
  const heads = approved.filter((v) => !succ.has(v.valuationId));
  if (heads.length !== 1) { add('AMBIGUOUS_VALUATION_VERSIONS', heads.map(vRef), `${heads.length}-effective-versions`); return null; }
  return heads[0];
}

/* Validates the single effective record; returns the per-fund entry or null (issues recorded). */
function validateEffective(v, fundId, linkedNow, add) {
  const ref = `fundValuation:${v.valuationId}`;
  const before = new Set();
  const bad = (code, detail) => { add(code, [ref], detail); before.add(code); };

  if (v.currency !== 'SAR') bad('INVALID_CURRENCY', String(v.currency));
  if (v.basis !== NAV_BASIS) bad('NAV_BASIS_UNRESOLVED', String(v.basis));
  if (!VALUATION_METHODS.includes(v.method)) bad('INVALID_METHOD', String(v.method));
  else if (v.method === 'other' && !isStr(v.methodNote)) bad('INVALID_METHOD', 'method-other-requires-methodNote');
  if (!isPlainObject(v.source) || !isStr(v.source.ref) || !isStr(v.source.provider)) bad('SOURCE_MISSING', 'source.ref and source.provider are both required');

  // approval data (values only; their authenticity is not verifiable here)
  if (!isStr(v.approvedBy) || !isStr(v.enteredBy)) bad('APPROVAL_DATA_INVALID', 'enteredBy and approvedBy are required for an approved version');
  else if (v.approvedBy.trim().toLowerCase() === v.enteredBy.trim().toLowerCase()) bad('APPROVAL_DATA_INVALID', 'approvedBy-equals-enteredBy');

  // components
  const c = v.components;
  let comps = null;
  if (!isPlainObject(c)) bad('INVALID_AMOUNT', 'components missing');
  else {
    const names = ['assetsValue', 'cashRetained', 'otherAssets', 'liabilities'];
    const badNames = names.filter((k) => !isNonNeg(c[k]));
    if (badNames.length) bad('INVALID_AMOUNT', `not a finite non-negative number: ${badNames.join(',')}`);
    else comps = { assetsValue: c.assetsValue, cashRetained: c.cashRetained, otherAssets: c.otherAssets, liabilities: c.liabilities };
    // otherAssets must be itemised and the items must add up to the component (no hidden remainder)
    if (comps) {
      const items = c.otherAssetsItems;
      if (!Array.isArray(items) || items.some((i) => !isPlainObject(i) || !isStr(i.description) || !isNonNeg(i.amount))) bad('OTHER_ASSETS_ITEMS_INVALID', 'otherAssetsItems must be an array of {description, amount >= 0}');
      else {
        const itemsSum = items.reduce((a, i) => a + i.amount, 0);
        if (!Number.isFinite(itemsSum)) bad('NUMERIC_OVERFLOW', 'sum-of-otherAssetsItems-is-not-finite');
        else if (Math.abs(itemsSum - comps.otherAssets) > FORMULA_TOLERANCE) bad('OTHER_ASSETS_ITEMS_INVALID', 'items do not add up to otherAssets');
      }
    }
    // explicit declared amount for unpaid distributions: required; positive => temporary block; zero is not proof of absence
    if (c.distributionsPayable === undefined || c.distributionsPayable === null) bad('DISTRIBUTIONS_PAYABLE_UNDECLARED', 'distributionsPayable is a required explicit amount');
    else if (!isNonNeg(c.distributionsPayable)) bad('INVALID_AMOUNT', 'distributionsPayable is not a finite non-negative number');
    else if (c.distributionsPayable > 0) bad('DISTRIBUTIONS_PAYABLE_UNRESOLVED', 'declared-positive-amount');
  }

  // formula
  if (!isNum(v.residualValue)) bad('INVALID_AMOUNT', 'residualValue missing or not a finite number');
  else if (comps) {
    // every partial result must stay finite: an overflowing step is a named block, never a "mismatch" or a success
    const s1 = comps.assetsValue + comps.cashRetained;
    const s2 = s1 + comps.otherAssets;
    const f = s2 - comps.liabilities;
    if (![s1, s2, f].every(Number.isFinite)) bad('NUMERIC_OVERFLOW', 'residual-formula-step-is-not-finite');
    else {
      if (Math.abs(v.residualValue - f) > FORMULA_TOLERANCE) bad('RESIDUAL_FORMULA_MISMATCH', `stated ${v.residualValue}, formula ${f}`);
      if (v.residualValue < 0 || f < 0) bad('RESIDUAL_NEGATIVE', `stated ${v.residualValue}, formula ${f}`);
    }
  }

  // non-overlap declaration (declared, not verifiable)
  const n = v.nonOverlap;
  if (!isPlainObject(n) || n.cashNotInAssets !== true || n.otherAssetsNotInAssets !== true || n.assetsStatedGrossOfLiabilities !== true) bad('NON_OVERLAP_UNDECLARED', 'cashNotInAssets, otherAssetsNotInAssets and assetsStatedGrossOfLiabilities must all be true');

  // coverage statement
  const cov = v.coverage;
  if (!isPlainObject(cov)) bad('COVERAGE_ASSET_MISSING', 'coverage statement missing');
  else {
    const la = cov.linkedAssets;
    if (!Array.isArray(la) || la.some((a) => !isStr(a))) bad('COVERAGE_ASSET_MISSING', 'coverage.linkedAssets must be an array of asset ids');
    else {
      if (new Set(la).size !== la.length) bad('COVERAGE_ASSET_DUPLICATE', 'asset listed twice');
      const have = new Set(la);
      const want = new Set(linkedNow);
      const missing = [...want].filter((a) => !have.has(a));
      const extra = [...have].filter((a) => !want.has(a));
      if (missing.length) add('COVERAGE_ASSET_MISSING', missing.map((a) => `asset:${a}`), `fund ${fundId}`);
      if (extra.length) add('COVERAGE_ASSET_UNKNOWN', extra.map((a) => `asset:${a}`), `fund ${fundId}`);
      if (missing.length) before.add('COVERAGE_ASSET_MISSING');
      if (extra.length) before.add('COVERAGE_ASSET_UNKNOWN');
    }
    const u = cov.unlinkedHoldings;
    if (!isPlainObject(u) || (u.declared !== 'none' && u.declared !== 'included')) bad('COVERAGE_UNLINKED_UNSTATED', 'unlinkedHoldings.declared must be "none" or "included"; absence is never read as none');
    else if (u.declared === 'none') {
      if (u.items !== undefined && !(Array.isArray(u.items) && u.items.length === 0)) bad('COVERAGE_UNLINKED_INVALID', 'declared none but items present');
    } else if (!Array.isArray(u.items) || u.items.length === 0 || u.items.some((i) => !isPlainObject(i) || !isStr(i.description) || !isNonNeg(i.amount))) {
      bad('COVERAGE_UNLINKED_INVALID', 'declared included requires non-empty items of {description, amount >= 0}');
    } else if (comps) {
      const unlinkedSum = u.items.reduce((a, i) => a + i.amount, 0);
      if (!Number.isFinite(unlinkedSum)) bad('NUMERIC_OVERFLOW', 'sum-of-unlinked-items-is-not-finite');
      else if (unlinkedSum > comps.assetsValue + FORMULA_TOLERANCE) bad('UNLINKED_ITEMS_EXCEED_ASSETS', 'sum of unlinked items exceeds assetsValue (they are a part of it, not an addition)');
    }
  }

  if (before.size) return null;
  return {
    fundId, valuationId: v.valuationId, version: v.version, residualValue: v.residualValue,
    components: { ...comps, distributionsPayable: v.components.distributionsPayable },
    method: v.method, sourceRef: v.source.ref, provider: v.source.provider,
  };
}
