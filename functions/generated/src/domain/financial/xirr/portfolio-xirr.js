/* =========================================================================
   Portfolio Net XIRR (XIRR-P) — pure function, no DOM, no core, no I/O.
   Contract: docs/XIRR_PORTFOLIO_COMPUTATION_CONTRACT.md
   Status: indicative / comparison only. No IC gate, report or server reads it.

   The solver is the SAME shared solver used for opportunities
   (computeOpportunityXirr). Nothing here re-implements root finding.
   This module only (a) decides which ledger records are admissible cashflows,
   (b) refuses to produce a rate when the source data cannot support one,
   (c) passes the solver's full result through (status, proof, roots, candidates).

   It never substitutes a missing/invalid amount with 0 or a bad date with a
   default date, and it never claims a main rate when the source is incomplete.
   ========================================================================= */
import { computeOpportunityXirr } from './xirr-opportunity.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar date in strict YYYY-MM-DD form. */
export function isRealIsoDate(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Finite number, or numeric string; anything else (null, '', NaN, objects) -> null. Never 0. */
export function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  return null;
}

/**
 * Mirror of core.js isInKindCapitalCall (same logic; parity is asserted by
 * tests/features/portfolio-net-xirr.test.mjs against the real core function).
 * byId is the map of PAID capital calls by id, as in core.
 */
export function isInKindCall(rec, byId, seen) {
  const d = (rec && rec.data) || rec || {};
  if (d.inKindAssetId || d.linkedCommitmentId) return true;
  if (d.reversalOfId) {
    seen = seen || new Set();
    if (seen.has(d.reversalOfId)) return true;
    const orig = byId.get(d.reversalOfId);
    if (!orig) return true;
    seen.add(d.reversalOfId);
    return isInKindCall(orig, byId, seen);
  }
  return false;
}

/** Calendar date in Asia/Riyadh (fixed UTC+3, no DST) for an instant; `now` is injectable so the day boundary is testable. */
export function riyadhDateStr(now = new Date()) {
  const ms = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(ms)) throw new Error('riyadhDateStr: invalid instant');
  return new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

// Only a stated remaining value at asOfDate is accepted. The absence of linked assets is NOT accepted as proof that the
// residual value is zero (the portfolio may hold unlinked holdings), and equity x MOIC is total projected proceeds.
export const NAV_BASES_ACCEPTED = ['RESIDUAL_VALUE_AS_OF_DATE'];
export const NAV_SOURCE_UNDERWRITING = 'UNDERWRITING_EQUITY_X_MOIC';

const KINDS = new Set(['capitalCall', 'distribution']);
export const IN_KIND_POLICIES = ['REFUSE', 'INCLUDE_AT_LEDGER_AMOUNT'];

/**
 * @param {object} input
 * @param {string} input.asOfDate  REQUIRED real ISO date. Terminal NAV is dated here and no flow after it is used.
 * @param {'explicit'|'calculation-date'} [input.asOfDateSource='explicit']
 * @param {Array<{kind:'capitalCall'|'distribution', id:string, fundId:string, date:string, amount:any,
 *   status:string, reversalOfId?:string|null, inKindAssetId?:string|null, linkedCommitmentId?:string|null}>} input.records
 *   ALL ledger records of the funds in scope (not only paid ones: originals of reversals must be visible).
 *   date = callDate for capital calls, distDate for distributions: the ledger's record dates. The code does not establish
 *   that they are actual payment/settlement dates, and results say so (LEDGER_DATES_ARE_RECORD_DATES).
 * @param {{value:any, complete:boolean, basis:string, source?:string, valuationDate?:string, issues?:Array}} input.nav
 *   terminal value, its completeness, its BASIS, its SOURCE and (optionally) the date it was valued.
 *   basis must be RESIDUAL_VALUE_AS_OF_DATE (a remaining value at asOfDate). Anything else is refused: total projected
 *   lifetime proceeds (equity x MOIC), and also "no linked assets" (absence of a link does not prove a zero residual).
 *   source drives the NAV warnings; valuationDate (real ISO date) removes NAV_VALUATION_DATE_UNKNOWN when supplied.
 * @param {object} [options]
 * @param {'REFUSE'|'INCLUDE_AT_LEDGER_AMOUNT'} [options.inKindPolicy='REFUSE']
 */
export function computePortfolioNetXirr(input, options = {}) {
  const { asOfDate, records, nav } = input || {};
  const asOfDateSource = (input && input.asOfDateSource) || 'explicit';
  const inKindPolicy = options.inKindPolicy || 'REFUSE';

  if (!isRealIsoDate(asOfDate)) {
    return { status: 'INVALID_INPUT', reason: 'asOfDate is required and must be a real calendar date (YYYY-MM-DD); it is never defaulted here.' };
  }
  if (!Array.isArray(records)) return { status: 'INVALID_INPUT', reason: 'records must be an array.' };
  if (!IN_KIND_POLICIES.includes(inKindPolicy)) return { status: 'INVALID_INPUT', reason: `Unknown inKindPolicy: ${String(inKindPolicy)}.` };

  const issues = [];      // each => no main rate
  const warnings = [];    // source-quality notes that accompany every result
  const addIssue = (code, ids, detail) => {
    let e = issues.find((x) => x.code === code && x.detail === detail);
    if (!e) { e = { code, ids: [], ...(detail ? { detail } : {}) }; issues.push(e); }
    e.ids.push(...ids);
  };

  /* ---- 1. paid records only; strict per-record validation (no substitution by 0 / today) ---- */
  // Ids are unique per collection only: a capital call and a distribution may share an id. Everything below is therefore
  // keyed by kind + id (refKey), and a repeated id inside one kind is ambiguous for reversal matching -> blocked.
  const refKey = (r) => `${r.kind}:${r.id}`;
  const byKindId = { capitalCall: new Map(), distribution: new Map() };
  const seenIds = new Map();
  for (const r of records) {
    if (r && KINDS.has(r.kind) && r.id != null) {
      byKindId[r.kind].set(r.id, r);
      seenIds.set(refKey(r), (seenIds.get(refKey(r)) || 0) + 1);
    }
  }
  for (const [k, n] of seenIds) if (n > 1) addIssue('DUPLICATE_RECORD_ID', [k]);
  const paidCallsById = new Map(); // capital calls only (a distribution with the same id can never be looked up here)
  for (const r of records) if (r && r.kind === 'capitalCall' && r.status === 'paid' && r.id != null) paidCallsById.set(r.id, r);

  const admissible = []; // {rec, amount}
  const lateReversals = []; // valid reversals dated after asOfDate
  const revCount = new Map(); // `${kind}|${originalId}` -> number of paid reversal records pointing at it
  let excludedAfterAsOf = 0;
  for (const r of records) {
    if (!r || r.status !== 'paid') continue;
    const ref = KINDS.has(r.kind) ? (r.id != null ? refKey(r) : `${r.kind}:(no id)`) : String(r.id);
    if (!KINDS.has(r.kind)) { addIssue('UNKNOWN_RECORD_KIND', [ref]); continue; }
    let bad = false;
    if (!isRealIsoDate(r.date)) { addIssue('INVALID_DATE', [ref]); bad = true; }
    const amt = parseAmount(r.amount);
    if (amt === null) { addIssue('INVALID_AMOUNT', [ref]); bad = true; }
    else if (amt < 0 && !r.reversalOfId) { addIssue('NEGATIVE_AMOUNT_WITHOUT_REVERSAL', [ref]); bad = true; }
    if (bad) continue;
    if (r.reversalOfId) { const k = `${r.kind}|${r.reversalOfId}`; revCount.set(k, (revCount.get(k) || 0) + 1); }
    if (r.date > asOfDate) { excludedAfterAsOf += 1; if (r.reversalOfId) lateReversals.push(r); continue; }
    admissible.push({ rec: r, amount: amt });
  }

  /* ---- 2. reversal entries: only a same-date, exact-negation correction of a paid original is admissible ----
     What the ledger stores (functions/index.js reverseTransaction): the reversal is a copy of the original with
     reversalOfId set, amount = -original amount, same status and the SAME date field (callDate / distDate).
     There is no separate "cash refund" record type and no field holding the date a reversal was actually made.
     Admissible: same record kind, same fund, original paid and not itself a reversal, exact negation, same date,
     and the original is used by exactly one reversal. Everything else cannot be classified as a correction or as a
     real later cash return -> source data insufficient, no rate. Valid pairs cancel exactly and are removed from
     the flows (the result equals the ledger without the pair). */
  const cancelled = new Set(); // record ids (both halves of valid pairs)
  const otherKind = { capitalCall: 'distribution', distribution: 'capitalCall' };
  for (const { rec: r, amount } of admissible) {
    if (!r.reversalOfId) continue;
    const ref = refKey(r);
    const orig = byKindId[r.kind].get(r.reversalOfId);
    const origAmt = orig ? parseAmount(orig.amount) : null;
    let why = null;
    if (!orig) why = byKindId[otherKind[r.kind]].has(r.reversalOfId) ? 'original-of-other-record-kind' : 'original-not-found';
    else if (orig.fundId !== r.fundId) why = 'original-in-other-fund';
    else if (orig.status !== 'paid') why = 'original-not-paid';
    else if (orig.reversalOfId) why = 'original-is-itself-a-reversal';
    else if (origAmt === null || origAmt <= 0 || amount !== -origAmt) why = 'amount-is-not-exact-negation';
    else if (orig.date !== r.date) why = 'date-differs-from-original';
    else if ((revCount.get(`${r.kind}|${r.reversalOfId}`) || 0) > 1) why = 'original-reversed-more-than-once';
    if (why) addIssue('REVERSAL_MEANING_UNRESOLVED', [ref], why);
    else { cancelled.add(refKey(r)); cancelled.add(refKey(orig)); }
  }
  // a reversal dated after asOfDate whose original is inside the window would be silently ignored -> unresolved
  for (const r of lateReversals) {
    const orig = byKindId[r.kind].get(r.reversalOfId);
    if (orig && orig.status === 'paid' && isRealIsoDate(orig.date) && orig.date <= asOfDate) addIssue('REVERSAL_MEANING_UNRESOLVED', [refKey(r)], 'reversal-dated-after-asof-original-inside-window');
  }

  const live = admissible.filter(({ rec }) => !cancelled.has(refKey(rec)));

  /* ---- 3. in-kind capital calls: the ledger gives no valuation basis for the amount.
         A cancelled pair (original in-kind call + its valid reversal) no longer contributes and does not block. ---- */
  const inKindIds = live
    .filter(({ rec }) => rec.kind === 'capitalCall' && isInKindCall(rec, paidCallsById))
    .map(({ rec }) => refKey(rec));
  if (inKindIds.length) {
    if (inKindPolicy === 'REFUSE') addIssue('IN_KIND_VALUE_BASIS_UNRESOLVED', inKindIds);
    else warnings.push({ code: 'IN_KIND_CALLS_INCLUDED_AT_LEDGER_AMOUNT', message: 'In-kind capital calls are included as outflows at their ledger amount; the ledger does not state the valuation basis of that amount.', ids: inKindIds });
  }

  /* ---- 4. NAV: must be complete and a finite non-negative number ---- */
  const navValue = nav ? parseAmount(nav.value) : null;
  if (!nav || navValue === null || navValue < 0) addIssue('NAV_INVALID', ['portfolio']);
  if (!nav || nav.complete !== true) addIssue('NAV_INCOMPLETE', ['portfolio']);
  // The NAV must be a remaining value at asOfDate. equity x MOIC in this codebase is the TOTAL projected proceeds over the
  // whole investment life (undiscounted, undated, may include distributions already in the ledger) -> basis unresolved.
  if (!nav || !NAV_BASES_ACCEPTED.includes(nav.basis)) addIssue('NAV_BASIS_UNRESOLVED', ['portfolio'], nav && nav.basis ? String(nav.basis) : 'missing');

  /* ---- 5. source warnings: attached to EVERY result (computed or blocked) so the views can always show them ---- */
  warnings.push({ code: 'LEDGER_DATES_ARE_RECORD_DATES', message: 'Flow dates are the ledger records\' callDate / distDate fields. The code does not establish that they are actual payment or settlement dates.' });
  const navSource = nav && typeof nav.source === 'string' && nav.source ? nav.source : null;
  if (navSource === NAV_SOURCE_UNDERWRITING) warnings.push({ code: 'NAV_IS_UNDERWRITING_ESTIMATE', message: 'The NAV supplied here is equity x MOIC of the underwriting model of the linked assets: total projected proceeds over the investment life, not a remaining value and not an independent valuation.' });
  else if (navSource) warnings.push({ code: 'NAV_SOURCE_DECLARED', message: `NAV source declared by the caller: ${navSource}.`, source: navSource });
  else warnings.push({ code: 'NAV_SOURCE_UNDECLARED', message: 'The NAV carries no declared source.' });
  const navValuationDate = nav && isRealIsoDate(nav.valuationDate) ? nav.valuationDate : null;
  if (!navValuationDate) warnings.push({ code: 'NAV_VALUATION_DATE_UNKNOWN', message: 'The NAV carries no valuation date. asOfDate is only the date the terminal value is placed at; it is not evidence that the NAV is current.' });
  if (asOfDateSource === 'calculation-date') warnings.push({ code: 'ASOF_DATE_IS_CALCULATION_DATE', message: 'asOfDate is the calculation date (Asia/Riyadh calendar day), not a reporting or valuation date.' });
  if (excludedAfterAsOf > 0) warnings.push({ code: 'FLOWS_AFTER_ASOF_EXCLUDED', message: `${excludedAfterAsOf} paid record(s) dated after asOfDate were not used.`, count: excludedAfterAsOf });

  if (issues.length) {
    return {
      status: 'INSUFFICIENT_SOURCE_DATA',
      reasonCodes: [...new Set(issues.map((i) => i.code))],
      issues,
      ...(nav && Array.isArray(nav.issues) && nav.issues.length ? { navIssues: nav.issues } : {}),
      asOfDate, asOfDateSource, excludedAfterAsOf,
      sourceWarnings: warnings,
      reason: 'The source data cannot support a portfolio Net XIRR; no rate is claimed.',
    };
  }

  /* ---- 6. cashflows -> shared solver. Sign from the record: call => outflow -amount, distribution => +amount.
         A reversal keeps its own (negative) amount, so it offsets its original exactly at the same date. ---- */
  const flows = live.map(({ rec, amount }) => ({ date: rec.date, amount: rec.kind === 'capitalCall' ? -amount : amount }));
  flows.push({ date: asOfDate, amount: navValue });

  const solver = computeOpportunityXirr(flows);
  return {
    ...solver,                       // status, rate, proof, method, roots / crossingRates / tangentCandidates / candidateRates, reason ...
    asOfDate, asOfDateSource,
    cashflowCount: flows.length, navValue, navSource, navValuationDate, excludedAfterAsOf,
    sourceWarnings: warnings,
  };
}
