/* =========================================================================
   Bug #5 (Opal's report, item 5): the project-cost-fields guard in
   opportunity-xirr.js must REJECT incomplete/invalid cost data instead of
   accepting it.

   IMPORTANT SCOPE NOTE: the guard function itself (isValidFiniteCost +
   AND-logic over computation.landCost/hardCostBase) is a small, local,
   non-exported function inside computeOpportunityProjectAndEquityXirr. The
   wrapper function it lives in cannot be run end-to-end here, because doing
   so needs the REAL createFinancialEngine()/financial-context.js (to
   produce a real `computation` object from an opportunity input) -- the
   same dependency verify-financing-fixtures-full-xirr.mjs has, and which is
   only fully exercisable on Opal's actual repo/device (currently
   unreachable -- see delivery report).

   This script therefore verifies the GUARD'S LOGIC DIRECTLY, as a faithful,
   literal copy of exactly what was changed in opportunity-xirr.js (same
   predicate, same AND-combination), against Opal's own three T01 scenarios
   (full data / landCost deleted / landCost=null) plus the explicit-zero
   case her report calls out as a case that MUST be accepted. It does NOT
   replace re-running opportunity-xirr.js itself against the real engine
   once the device is reachable again -- that end-to-end re-verification is
   still pending and is disclosed as such.

   Run: node src/domain/financial/xirr/verify-opal-bug5-guard-logic.mjs
   ========================================================================= */

// Exact copy of the fixed guard from opportunity-xirr.js.
function isValidFiniteCost(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function projectCostFieldsPresent(computation) {
  return computation != null
    && isValidFiniteCost(computation.landCost)
    && isValidFiniteCost(computation.hardCostBase);
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}

// Opal's T01 scenario 1: complete, valid cost data -> must be ACCEPTED.
check(
  '1. complete cost data (landCost and hardCostBase both finite numbers) is accepted',
  projectCostFieldsPresent({ landCost: 1000000, hardCostBase: 2000000 }) === true,
);

// Opal's T01 scenario 2: landCost deleted (field absent entirely) -> must be REJECTED.
// (The old OR-guard wrongly accepted this because hardCostBase alone satisfied `!== undefined`.)
check(
  '2. landCost deleted (absent) is REJECTED even though hardCostBase is present',
  projectCostFieldsPresent({ hardCostBase: 2000000 }) === false,
);

// Opal's T01 scenario 3: landCost explicitly set to null -> must be REJECTED.
// (The old guard's `!== undefined` check wrongly treated null as "present".)
check(
  '3. landCost = null is REJECTED (null is not a valid finite cost)',
  projectCostFieldsPresent({ landCost: null, hardCostBase: 2000000 }) === false,
);

// Symmetric case not in Opal's report but the same class of bug: hardCostBase
// deleted/null while landCost is present -- must also be rejected (the old
// OR-guard had the identical defect in the other direction).
check(
  '4. hardCostBase deleted (absent) is REJECTED even though landCost is present',
  projectCostFieldsPresent({ landCost: 1000000 }) === false,
);
check(
  '5. hardCostBase = null is REJECTED',
  projectCostFieldsPresent({ landCost: 1000000, hardCostBase: null }) === false,
);

// Explicit, finite ZERO must be ACCEPTED as valid data (per the "المطلوب" line:
// "قبول الصفر الصريح الصحيح" -- accept a valid explicit zero).
check(
  '6. landCost = 0 (explicit, finite zero) is ACCEPTED, not rejected as falsy/missing',
  projectCostFieldsPresent({ landCost: 0, hardCostBase: 2000000 }) === true,
);
check(
  '7. both landCost = 0 and hardCostBase = 0 (both explicit zero) are ACCEPTED',
  projectCostFieldsPresent({ landCost: 0, hardCostBase: 0 }) === true,
);

// NaN/non-numeric must be rejected (not merely "undefined/null" handling).
check(
  '8. landCost = NaN is REJECTED',
  projectCostFieldsPresent({ landCost: NaN, hardCostBase: 2000000 }) === false,
);
check(
  '9. landCost = "1000000" (string, not number) is REJECTED',
  projectCostFieldsPresent({ landCost: '1000000', hardCostBase: 2000000 }) === false,
);
check(
  '10. computation itself null/undefined is REJECTED',
  projectCostFieldsPresent(null) === false && projectCostFieldsPresent(undefined) === false,
);

console.log(`\n${pass} passed, ${fail} failed.`);
console.log('\nNOTE: this verifies the guard logic in isolation only. End-to-end re-verification');
console.log('of opportunity-xirr.js against the real financial engine and Opal\'s actual T01 fixture');
console.log('is still pending device reconnection -- see delivery report.');
process.exit(fail === 0 ? 0 : 1);
