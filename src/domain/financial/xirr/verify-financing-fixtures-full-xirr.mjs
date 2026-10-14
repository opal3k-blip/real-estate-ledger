/* =========================================================================
   Runs computeOpportunityProjectAndEquityXirr ITSELF (the actual wrapper
   function used by any real caller), not a lower-level ledger-closure
   check, across all 14 financing-baseline.json fixtures. Reports PROJECT
   XIRR, EQUITY XIRR, and sourceWarnings for each fixture.

   This exists because verify-equity-reconciliation.mjs only proves the
   underlying cash-identity (projectCash + financingCash == 0); it never
   calls computeOpportunityXirr/computeOpportunityProjectAndEquityXirr at
   all, so it is NOT a test of the project XIRR computation itself -- only
   of the cashflow-ledger it would be computed from. This script closes
   that gap directly, per instruction.

   financing-baseline.json's fixtures carry a FULL opportunity `input`
   (including landCost/hardCostBase), unlike timing-baseline.json's 20
   fixtures (which structurally omit those fields -- see
   verify-20-fixtures-regression.mjs). So PROJECT XIRR is expected to be
   computable here, not INSUFFICIENT_SOURCE_DATA across the board; any
   fixture that still comes back INSUFFICIENT_SOURCE_DATA or
   UPSTREAM_GENERATION_FAILED is flagged explicitly below, not glossed over.

   Run: node src/domain/financial/xirr/verify-financing-fixtures-full-xirr.mjs
   ========================================================================= */
import fs from 'node:fs';
import { createFinancialEngine } from '../financial-engine.js';
import { blankOpportunity, TIERS, USE_TYPES, SITE_FACTORS, DEV_REFI_STRATEGY_KEY, isResidentialUseType } from '../financial-context.js';
import { computeOpportunityProjectAndEquityXirr } from './opportunity-xirr.js';

const engine = createFinancialEngine({ blankOpportunity, TIERS, USE_TYPES, SITE_FACTORS, DEV_REFI_STRATEGY_KEY, isResidentialUseType });

// TEST-ONLY assumed date -- not a real/approved opportunity date. Labeled as
// such via acquisitionDateIsAssumed:true (the wrapper's own default), which
// is echoed back into every fixture's sourceWarnings below, not stripped out.
const TEST_ACQUISITION_DATE = '2026-01-01';

function fmtXirr(x) {
  if (!x) return 'n/a';
  if (x.status === 'OK') return `OK rate=${(x.rate * 100).toFixed(4)}% [${x.proof || x.method}]`;
  if (x.status === 'POSSIBLE_MULTIPLE_ROOTS') return `POSSIBLE_MULTIPLE_ROOTS roots=[${(x.roots || []).map((r) => (r * 100).toFixed(2) + '%').join(',')}]`;
  return x.status + (x.discriminant !== undefined ? ` (discriminant=${x.discriminant})` : '');
}

const data = JSON.parse(fs.readFileSync(new URL('../../../../tests/domain/financing-baseline.json', import.meta.url)));
const fixtures = data.fixtures;

const rows = [];
let hardErrors = 0;
// Explicit per-fixture pass/fail (per instruction, corrected this round --
// see Opal's bug report #6): the previous exit code depended ONLY on
// `hardErrors` (uncaught exceptions), so a fixture whose computation
// returned a FAILURE STATUS (e.g. NO_REAL_ROOT, INSUFFICIENT_SOURCE_DATA,
// NO_ROOT_FOUND_IN_SEARCH_RANGE, INTERNAL_INCONSISTENCY, ...) without
// throwing would still leave the script reporting success. "Did not throw"
// is not a certificate that the computation succeeded. Every one of these
// 14 financing-baseline.json fixtures carries a full landCost/hardCostBase
// input (per this script's own header comment), so BOTH the project and
// equity XIRR are expected to resolve to status 'OK' for every fixture;
// any fixture where either does not is now an explicit, named failure, not
// a silently-passed row.
let failures = 0;
const failureDetails = [];

for (const [key, fx] of Object.entries(fixtures)) {
  let result = null;
  let threw = null;
  try {
    const computation = engine.compute(fx.input, fx.input.scenarioKey || 'base');
    result = computeOpportunityProjectAndEquityXirr(fx.input, computation, {
      acquisitionDate: TEST_ACQUISITION_DATE,
      acquisitionDateIsAssumed: true,
    });
  } catch (e) {
    threw = e.message;
    hardErrors++;
  }

  if (threw) {
    console.log(`[${key}] THREW: ${threw}`);
    rows.push({ key, threw });
    failures++;
    failureDetails.push({ key, reason: `threw: ${threw}` });
    continue;
  }

  const warnCodes = result.sourceWarnings.map((w) => w.code);
  console.log(`[${key}] project=${fmtXirr(result.project.xirr)} | equity=${fmtXirr(result.equity.xirr)} | warnings=[${warnCodes.join(',')}]`);
  rows.push({
    key,
    acquisitionDate: result.acquisitionDate,
    acquisitionDateIsAssumed: result.acquisitionDateIsAssumed,
    projectCashflows: result.project.cashflows,
    projectXirr: result.project.xirr,
    equityCashflows: result.equity.cashflows,
    equityXirr: result.equity.xirr,
    sourceWarnings: result.sourceWarnings,
  });

  if (result.project.xirr.status !== 'OK') {
    failures++;
    failureDetails.push({ key, reason: `project.xirr.status=${result.project.xirr.status} (expected OK; this fixture carries landCost/hardCostBase)` });
  }
  if (result.equity.xirr.status !== 'OK') {
    failures++;
    failureDetails.push({ key, reason: `equity.xirr.status=${result.equity.xirr.status} (expected OK)` });
  }
}

const projectOk = rows.filter((r) => r.projectXirr && r.projectXirr.status === 'OK').length;
const projectInsufficient = rows.filter((r) => r.projectXirr && (r.projectXirr.status === 'INSUFFICIENT_SOURCE_DATA' || r.projectXirr.status === 'UPSTREAM_GENERATION_FAILED')).length;
const equityOk = rows.filter((r) => r.equityXirr && r.equityXirr.status === 'OK').length;

console.log(`\n${rows.length - hardErrors}/${Object.keys(fixtures).length} fixtures ran without throwing (${hardErrors} threw).`);
console.log(`PROJECT XIRR: OK for ${projectOk}/${rows.length}; INSUFFICIENT_SOURCE_DATA/UPSTREAM_GENERATION_FAILED for ${projectInsufficient}/${rows.length} (these fixtures DO carry landCost/hardCostBase, so this count is expected to be 0 or explainable per-fixture, not glossed over).`);
console.log(`EQUITY XIRR: OK for ${equityOk}/${rows.length}.`);
console.log(`\n${failures === 0 ? 'ALL' : failures} explicit status-assertion failure(s) across ${Object.keys(fixtures).length} fixtures x 2 views (project+equity each asserted === 'OK').`);
if (failureDetails.length) {
  console.log('Failure detail:');
  for (const f of failureDetails) console.log(`  [${f.key}] ${f.reason}`);
}

fs.writeFileSync(
  new URL('./_financing-14-fixtures-full-xirr-output.json', import.meta.url),
  JSON.stringify({ generatedAt: new Date().toISOString(), acquisitionDateUsed: TEST_ACQUISITION_DATE, acquisitionDateIsAssumed: true, failures, failureDetails, rows }, null, 2),
);

// Exit code now reflects explicit per-fixture status assertions, not merely
// the absence of a thrown exception.
process.exit(hardErrors === 0 && failures === 0 ? 0 : 1);
