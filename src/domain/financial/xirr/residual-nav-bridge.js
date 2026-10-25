/* =========================================================================
   XIRR-R1C1 — pure bridge: approved residual valuations -> portfolio Net XIRR (indicative)
   -------------------------------------------------------------------------
   Pure and synchronous. No DOM, no Firebase, no clock of its own (the calculation instant is INJECTED as options.now),
   no I/O, no input mutation. It is NOT wired to any view in R1-C1: portfolio.js / command-center.js still pass the
   underwriting NAV and still show no rate.

   What it does, in this order (each step either passes or yields a blocked result with a named reason; no rate is
   produced by any blocked path, no partial-portfolio value, no fallback to an older valuation version):
     1. structural checks of the input (INVALID_INPUT, as XIRR-P);
     2. D-C2: asOfDate must be the CURRENT Asia/Riyadh calendar day taken from options.now
        (CALCULATION_DAY_UNKNOWN / ASOF_NOT_CURRENT_RIYADH_DAY). A "latest common date" is NOT offered: the contract ties
        the asset links and the portfolio scope to the valuation date, and today's links cannot prove a past portfolio;
     3. eligibility is MANDATORY (ELIGIBILITY_REQUIRED). The selector alone treats it as optional (R1-A behaviour);
        this bridge never calls it without eligibility;
     4. selectResidualValuation(...) is the only source of the terminal value; its result is accepted only when it is
        status OK, complete, finite and non-negative, dated asOfDate, with the expected basis and source and one perFund
        row per scope fund (otherwise VALUATION_RESULT_INCONSISTENT);
     5. computePortfolioNetXirr(...) is the only solver / flow validator, called with basis RESIDUAL_VALUE_AS_OF_DATE.
   Nothing here reads equity x MOIC or any underwriting figure.

   Output = the XIRR-P result (unchanged fields) plus:
     valuation  : the selector's status / reasonCodes / issues / warnings / perFund / value / complete / valuationDate
                  (null when the selector was not reached);
     bridge     : { version, calculationDay, eligibilityRequired:true, scopeFunds[] };
   and, for blocked results, reasonCodes / issues are the union (bridge, selector, XIRR-P) and sourceWarnings carries the
   selector's standing warnings too, so a view has ONE place to read from.
   ========================================================================= */
import { selectResidualValuation, NAV_BASIS, NAV_SOURCE_LABEL } from './residual-valuation.js';
import { computePortfolioNetXirr, isRealIsoDate, riyadhDateStr } from './portfolio-xirr.js';

export const BRIDGE_VERSION = 'R1-C1';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const uniq = (arr) => [...new Set(arr)];

export function computeResidualBackedNetXirr(input, options = {}) {
  if (!isPlain(input)) return { status: 'INVALID_INPUT', reason: 'input must be an object.' };
  const { asOfDate, scope, valuations, records, eligibility } = input;
  if (!isRealIsoDate(asOfDate)) return { status: 'INVALID_INPUT', reason: 'asOfDate is required and must be a real calendar date (YYYY-MM-DD); it is never defaulted here.' };
  if (!Array.isArray(records)) return { status: 'INVALID_INPUT', reason: 'records must be an array.' };

  const bridgeIssues = [];
  const addBridge = (code, ids, detail) => bridgeIssues.push({ code, ids, ...(detail ? { detail } : {}) });

  // ---- D-C2: the current Riyadh day, from the injected instant ----
  const now = isPlain(options) ? options.now : undefined;
  let today = null;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) addBridge('CALCULATION_DAY_UNKNOWN', ['portfolio']);
  else {
    today = riyadhDateStr(now);
    if (asOfDate !== today) addBridge('ASOF_NOT_CURRENT_RIYADH_DAY', ['portfolio'], `asOfDate=${asOfDate};today=${today}`);
  }

  // ---- eligibility is mandatory (the selector would otherwise fall back to its optional R1-A behaviour) ----
  if (!isPlain(eligibility)) addBridge('ELIGIBILITY_REQUIRED', ['portfolio']);

  // ---- the only source of the terminal value ----
  let valuation = null;
  let nav;
  if (bridgeIssues.length === 0) {
    valuation = selectResidualValuation({ asOfDate, scope, valuations, records, eligibility });
    const scopeFunds = isPlain(scope) && Array.isArray(scope.funds) ? scope.funds : [];
    const consistent = valuation.status === 'OK' && valuation.complete === true
      && typeof valuation.value === 'number' && Number.isFinite(valuation.value) && valuation.value >= 0
      && valuation.basis === NAV_BASIS && valuation.source === NAV_SOURCE_LABEL && valuation.valuationDate === asOfDate
      && Array.isArray(valuation.issues) && valuation.issues.length === 0
      && Array.isArray(valuation.perFund) && valuation.perFund.length > 0 && valuation.perFund.length === scopeFunds.length;
    if (consistent) {
      nav = { value: valuation.value, complete: true, basis: NAV_BASIS, source: NAV_SOURCE_LABEL, valuationDate: valuation.valuationDate };
    } else {
      if (valuation.status === 'OK') addBridge('VALUATION_RESULT_INCONSISTENT', ['portfolio']);
      nav = { value: null, complete: false, basis: NAV_BASIS, source: NAV_SOURCE_LABEL, issues: [...bridgeIssues, ...(Array.isArray(valuation.issues) ? valuation.issues : [])] };
    }
  } else {
    nav = { value: null, complete: false, basis: NAV_BASIS, source: NAV_SOURCE_LABEL, issues: bridgeIssues.slice() };
  }

  const out = computePortfolioNetXirr({
    asOfDate,
    asOfDateSource: today !== null && asOfDate === today ? 'calculation-date' : 'explicit',
    records,
    nav,
  });
  if (out.status === 'INVALID_INPUT') return out;

  const valuationBlock = valuation ? {
    status: valuation.status, complete: valuation.complete, value: valuation.value, valuationDate: valuation.valuationDate,
    reasonCodes: valuation.reasonCodes, issues: valuation.issues, warnings: valuation.warnings, perFund: valuation.perFund,
  } : null;

  const merged = { ...out };
  const seen = new Set((Array.isArray(out.sourceWarnings) ? out.sourceWarnings : []).map((w) => w.code));
  merged.sourceWarnings = [...(Array.isArray(out.sourceWarnings) ? out.sourceWarnings : [])];
  for (const w of (valuation && Array.isArray(valuation.warnings) ? valuation.warnings : [])) if (!seen.has(w.code)) { seen.add(w.code); merged.sourceWarnings.push(w); }

  if (out.status === 'INSUFFICIENT_SOURCE_DATA') {
    const selIssues = valuation && Array.isArray(valuation.issues) ? valuation.issues : [];
    const selCodes = valuation && Array.isArray(valuation.reasonCodes) ? valuation.reasonCodes : [];
    merged.issues = [...bridgeIssues, ...selIssues, ...(Array.isArray(out.issues) ? out.issues : [])];
    merged.reasonCodes = uniq([...bridgeIssues.map((i) => i.code), ...selCodes, ...(Array.isArray(out.reasonCodes) ? out.reasonCodes : [])]);
  }

  merged.valuation = valuationBlock;
  merged.bridge = { version: BRIDGE_VERSION, calculationDay: today, eligibilityRequired: true, scopeFunds: isPlain(scope) && Array.isArray(scope.funds) ? scope.funds.slice() : [] };
  return merged;
}
