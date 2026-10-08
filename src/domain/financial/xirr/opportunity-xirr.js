/* =========================================================================
   Opportunity-level PROJECT + EQUITY XIRR wrapper (shadow/comparison mode).
   -------------------------------------------------------------------------
   Connects the existing Phase 3B dated-event generators (src/domain/financial/
   dated/*) to computeOpportunityXirr, WITHOUT touching core.js, the committee
   gate, the Golden Master, or any production call path. Pure function; no
   DOM, no Firestore, no UI, no network.

   Key design points (see docs/XIRR_OPPORTUNITY_COMPARISON_PACKAGE.md):
   - PROJECT cashflows: generateLegacyProjectCashEvents (unlevered; never
     includes DEBT_DRAW/REPAYMENT/INTEREST/REFINANCE_* by construction --
     those have projectCashSign 0 in financial-event.js's EVENT_TYPE_META).
   - EQUITY cashflows: generateLegacyInvestorCashEvents, sourced from
     computation.equityCF / equityCFCashOnly (the SAME series the current
     annual engine already produces) -- NOT re-derived from the dated debt
     ledger, and NOT re-adding DIRECT_SALE_DEFERRAL/COLLECTION (those belong
     to the project-level timing split only; equityCF already carries the
     deferred-collection timing where applicable -- see verify-t19-*.mjs).
   - Debt/financing events (draws, repayments, interest, refinance) are
     EXCLUDED from both views on purpose, proven safe (not merely assumed)
     by verify-equity-reconciliation.mjs's closed-cash-system check.
   - Equation-solving soundness (computeOpportunityXirr's status/proof) is
     reported SEPARATELY from source-data quality warnings below. A clean
     'OK' rate does NOT mean the underlying cashflows are free of known
     legacy defects or assumed/test dates -- callers must read both.
   ========================================================================= */
import { computeOpportunityXirr } from './xirr-opportunity.js';
import { eventEffects } from '../dated/financial-event.js';
import { generateLegacyProjectCashEvents } from '../dated/legacy-dated-cashflow.js';
import { generateLegacyInvestorCashEvents } from '../dated/legacy-investor-cash-events.js';

function eventsToDatedCashflows(events, signKey) {
  const byDate = new Map();
  for (const e of events) {
    const amt = eventEffects(e)[signKey];
    if (amt === 0) continue;
    byDate.set(e.date, (byDate.get(e.date) || 0) + amt);
  }
  return [...byDate.entries()].map(([date, amount]) => ({ date, amount }));
}

/**
 * computeOpportunityProjectAndEquityXirr
 * @param {object} opportunity - the opportunity input object (as passed to core.js/financial-engine.js).
 * @param {object} computation - the result of engine.compute(opportunity) -- the SAME object the
 *        frontend and approveOpportunity already produce. NOT recomputed here.
 * @param {object} options
 * @param {string} options.acquisitionDate - REQUIRED, explicit ISO date. This module never
 *        defaults or invents a date. Caller must label whether this date is confirmed/real or
 *        an assumed/model/test date; that label is echoed back in sourceWarnings for the report.
 * @param {boolean} [options.acquisitionDateIsAssumed=true] - if true (the default, deliberately
 *        conservative), a sourceWarning is attached stating the date is a model assumption, not
 *        a confirmed operational date -- per the explicit instruction never to silently treat
 *        3B's dates as real.
 */
export function computeOpportunityProjectAndEquityXirr(opportunity, computation, options = {}) {
  const { acquisitionDate, acquisitionDateIsAssumed = true } = options;
  if (!acquisitionDate) {
    throw new Error('computeOpportunityProjectAndEquityXirr: acquisitionDate is required and is never defaulted.');
  }

  const sourceWarnings = [];
  if (acquisitionDateIsAssumed) {
    sourceWarnings.push({
      code: 'ASSUMED_DATE_NOT_OPERATIONAL',
      message: `acquisitionDate=${acquisitionDate} is a model/test assumption, not a confirmed operational date. Any XIRR computed below is "model-implied equity/project return under this assumed schedule", not a proven real-world return.`,
    });
  }

  let project = { events: [] };
  let projectError = null;
  try {
    project = generateLegacyProjectCashEvents(opportunity, computation, { acquisitionDate });
  } catch (e) {
    projectError = e.message;
    sourceWarnings.push({ code: 'PROJECT_CASH_GENERATION_FAILED', message: e.message });
  }

  let investor = { events: [] };
  let investorError = null;
  try {
    investor = generateLegacyInvestorCashEvents(computation, { acquisitionDate });
  } catch (e) {
    investorError = e.message;
    sourceWarnings.push({ code: 'EQUITY_CASH_GENERATION_FAILED', message: e.message });
  }

  // Known-legacy-defect / timing-finding surfacing: carry forward whatever the
  // underlying generators already flagged, verbatim. Never silently drop them,
  // and never let a clean XIRR number imply these are resolved.
  if (computation?.holdStrategy === 'perpetual_hold') {
    sourceWarnings.push({
      code: 'PERPETUAL_HOLD_DEEMED_EXIT_IN_EQUITY_SERIES',
      message: 'equityCFCashOnly (used for the equity series here) still executes a deemed terminal exit at the analysis horizon (LEGACY_PERPETUAL_HOLD_HORIZON_RUNS_DEEMED_EXIT). Any resulting XIRR embeds that deemed exit as if it were a real sale; it is not evidence of a realized return.',
    });
  }
  if (computation?.isPhasedSaleMode) {
    sourceWarnings.push({
      code: 'PHASED_SALE_MODE_DEBT_LEDGER_NOT_RECONCILED_HERE',
      message: 'This wrapper does not reconcile the debt/financing ledger for phased-sale opportunities (generateLegacyPrincipalEvents/generateLegacyInterestEvents reject phased-sale mode). The PROJECT and EQUITY cash views themselves remain valid (they do not depend on the debt ledger), but no closed-cash-system proof has been run for this mode -- see verify-equity-reconciliation.mjs scope.',
    });
  }
  if (Array.isArray(computation?.drawSchedule) && computation.drawSchedule.some((s) => Number(s) > 0)) {
    sourceWarnings.push({
      code: 'DRAW_SCHEDULE_TIMING_NOT_ALIGNED_TO_PROJECT_COST_BOOKING',
      message: 'This opportunity uses a non-trivial drawSchedule. verify-equity-reconciliation.mjs shows the project cost (booked entirely at t0) and the phased debt draws do not align date-by-date (only in total). This does NOT affect the PROJECT or EQUITY series used for XIRR here (neither depends on the debt ledger), but is noted because it affects how "funding timing" should be read for this opportunity.',
    });
  }

  // Explicit missing/invalid-source-data gate (per instruction, corrected
  // this round -- see Opal's bug report #5): the project-cost fields this
  // generator needs must be CHECKED FOR VALIDITY, not merely "not
  // undefined", and BOTH fields are independently required (AND, not OR).
  // The previous guard, `landCost !== undefined || hardCostBase !== undefined`,
  // had two independent defects:
  //   1. `!== undefined` treats `null` as "present" -- extractProjectCostComponents()'s
  //      own `positive()` coercion would then silently turn a null/invalid
  //      field into 0, producing a PROJECT cashflow series that looks like
  //      "no cost, pure profit" (a plausible-looking but fabricated number),
  //      exactly as it did for the genuinely-undefined case this guard was
  //      built to catch.
  //   2. OR-logic let EITHER field alone satisfy the guard, so deleting
  //      landCost entirely while hardCostBase remained defined (or vice
  //      versa) passed as "present" even though ONE required cost component
  //      was still completely missing.
  // isValidFiniteCost requires a real, finite number -- explicit 0 is valid
  // (a true zero land cost, say, is a legitimate economic input and must be
  // ACCEPTED, not rejected merely for being falsy); undefined, null, NaN,
  // Infinity, and non-numeric types are all rejected. Both fields must
  // independently pass.
  function isValidFiniteCost(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }
  const projectCostFieldsPresent = computation != null
    && isValidFiniteCost(computation.landCost)
    && isValidFiniteCost(computation.hardCostBase);
  if (!projectCostFieldsPresent) {
    sourceWarnings.push({
      code: 'INSUFFICIENT_SOURCE_DATA_PROJECT_COST',
      message: `computation.landCost and/or computation.hardCostBase is missing, null, or not a finite number (landCost=${JSON.stringify(computation?.landCost)}, hardCostBase=${JSON.stringify(computation?.hardCostBase)}). The PROJECT cash view cannot be reconstructed without BOTH valid cost fields; it is intentionally NOT computed as if a missing or invalid cost were 0. An explicit, finite 0 for either field is accepted as valid.`,
    });
  }

  const projectCashflows = eventsToDatedCashflows(project.events || [], 'projectCash');
  const equityCashflows = eventsToDatedCashflows(investor.events || [], 'equityCash');

  const projectXirr = !projectCostFieldsPresent
    ? { status: 'INSUFFICIENT_SOURCE_DATA', reason: 'computation.landCost and/or computation.hardCostBase is missing, null, or not a finite number. Refusing to compute a PROJECT XIRR from an incomplete or invalid cost base rather than silently treating it as zero.' }
    : (projectError ? { status: 'UPSTREAM_GENERATION_FAILED', reason: projectError } : computeOpportunityXirr(projectCashflows));
  const equityXirr = investorError ? { status: 'UPSTREAM_GENERATION_FAILED', reason: investorError } : computeOpportunityXirr(equityCashflows);

  return Object.freeze({
    acquisitionDate,
    acquisitionDateIsAssumed,
    project: Object.freeze({ cashflows: projectCashflows, xirr: projectXirr }),
    equity: Object.freeze({ cashflows: equityCashflows, xirr: equityXirr }),
    sourceWarnings: Object.freeze(sourceWarnings),
  });
}
