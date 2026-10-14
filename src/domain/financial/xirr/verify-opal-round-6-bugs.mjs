/* =========================================================================
   Direct regression tests for the SIX concrete bugs reported by Opal's
   adversarial reviewer in this round, reproduced with the EXACT inputs from
   the bug report (not restated or "improved" cases). Each check asserts the
   specific expected status/behavior named in the report's "المطلوب" line.

   Bugs 1-4 are against xirr-opportunity.js directly (fully testable without
   the device/repo). Bugs 5-6 are against opportunity-xirr.js and the
   verify-financing-fixtures-full-xirr.mjs test script respectively, and are
   checked here only to the extent possible without the real financial
   engine / fixture files (see inline notes on each).

   Run: node src/domain/financial/xirr/verify-opal-round-6-bugs.mjs
   ========================================================================= */
import { computeOpportunityXirr } from './xirr-opportunity.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}

/* --- Bug 1: small decisive cashflow silently dropped at classification time --- */
// 2026-01-01 -500,000,000 ; 2035-12-30 +0.005 (3650 days = exactly 10 years).
// Expected real root: r = (0.005/500000000)^(1/10) - 1
const bug1Result = computeOpportunityXirr([
  { date: '2026-01-01', amount: -500000000 },
  { date: '2035-12-30', amount: 0.005 },
]);
const bug1ExpectedRate = Math.pow(0.005 / 500000000, 1 / 10) - 1;
console.log('bug1:', bug1Result, 'expectedRate~', bug1ExpectedRate);
check(
  'Bug 1: tiny decisive cashflow (SAR 0.005 vs SAR 500M) is no longer dropped; root is found',
  bug1Result.status === 'OK' && Math.abs(bug1Result.rate - bug1ExpectedRate) < 1e-6,
  bug1Result,
);

/* --- Bug 2: negative discriminant clamped to a false confirmed root --- */
// 2026-01-01 -100 ; 2027-01-01 +200 ; 2028-01-01 -100.00000001
const bug2Result = computeOpportunityXirr([
  { date: '2026-01-01', amount: -100 },
  { date: '2027-01-01', amount: 200 },
  { date: '2028-01-01', amount: -100.00000001 },
]);
console.log('bug2:', bug2Result);
check(
  'Bug 2: reliably-negative-but-tiny discriminant is NOT clamped to a false confirmed root',
  bug2Result.status === 'NO_REAL_ROOT',
  bug2Result,
);
check(
  'Bug 2 (no false OK/quadratic-discriminant proof survives)',
  !(bug2Result.status === 'OK' && bug2Result.proof === 'quadratic-discriminant'),
  bug2Result,
);

/* --- Bug 3: scan non-find mislabeled as "proven outside the search range" --- */
// 2026-01-01 -100 ; 2085-12-17 +110 (60*365 days later). True root r = 1.1^(1/60)-1,
// small and positive, clearly inside [SEARCH_R_MIN, SEARCH_R_MAX].
const bug3Date2 = new Date(Date.UTC(2026, 0, 1) + 60 * 365 * 86400000);
const bug3Date2Str = bug3Date2.toISOString().slice(0, 10);
console.log('bug3 second date (60*365 days after 2026-01-01):', bug3Date2Str);
const bug3Result = computeOpportunityXirr([
  { date: '2026-01-01', amount: -100 },
  { date: bug3Date2Str, amount: 110 },
]);
const bug3ExpectedRate = Math.pow(1.1, 1 / 60) - 1;
console.log('bug3:', bug3Result, 'expectedRate~', bug3ExpectedRate);
check(
  'Bug 3: a genuinely in-window root is found as OK, not ROOT_PROVEN_OUTSIDE_SEARCH_RANGE',
  bug3Result.status === 'OK' && Math.abs(bug3Result.rate - bug3ExpectedRate) < 1e-4,
  bug3Result,
);
check(
  'Bug 3 (ROOT_PROVEN_OUTSIDE_SEARCH_RANGE must not fire on this input)',
  bug3Result.status !== 'ROOT_PROVEN_OUTSIDE_SEARCH_RANGE',
  bug3Result,
);

/* --- Bug 4: irregular-date path fabricates a tangent root under rescaling --- */
// Dates 2026-01-01/2026-07-02/2026-12-31, amounts -100/+300/-250, then all x1e-10.
const bug4Dates = ['2026-01-01', '2026-07-02', '2026-12-31'];
const bug4AmountsUnscaled = [-100, 300, -250];
const bug4AmountsScaled = bug4AmountsUnscaled.map((a) => a * 1e-10);
const bug4ResultUnscaled = computeOpportunityXirr(bug4Dates.map((d, i) => ({ date: d, amount: bug4AmountsUnscaled[i] })));
const bug4ResultScaled = computeOpportunityXirr(bug4Dates.map((d, i) => ({ date: d, amount: bug4AmountsScaled[i] })));
console.log('bug4 unscaled:', bug4ResultUnscaled);
console.log('bug4 scaled (x1e-10):', bug4ResultScaled);
check(
  'Bug 4: unscaled case correctly finds no root',
  bug4ResultUnscaled.status !== 'OK',
  bug4ResultUnscaled,
);
check(
  'Bug 4: rescaling the SAME cashflow pattern by 1e-10 must NOT fabricate an OK/~2400% tangent root (scale invariance)',
  bug4ResultScaled.status !== 'OK',
  bug4ResultScaled,
);
check(
  'Bug 4: both scales agree on status (true scale invariance, not just "scaled happens to also fail")',
  bug4ResultUnscaled.status === bug4ResultScaled.status,
  { unscaled: bug4ResultUnscaled.status, scaled: bug4ResultScaled.status },
);

/* --- Bugs 5 & 6: cannot be run end-to-end here --------------------------
   Bug 5 lives in opportunity-xirr.js, which calls the real financial engine
   (createFinancialEngine) and needs the actual opportunity input shape; bug
   6 lives in verify-financing-fixtures-full-xirr.mjs, which reads the real
   tests/domain/financing-baseline.json fixture file and also calls the real
   engine. Neither the engine nor the fixture file is meaningfully
   reproducible here without Opal's actual repo/device, so they are NOT
   asserted in this script -- see opportunity-xirr.js and
   verify-financing-fixtures-full-xirr.mjs themselves for the applied code
   fixes, and the delivery report for an explicit disclosure that these two
   fixes are code-complete but NOT yet re-verified end-to-end pending device
   reconnection.
   ------------------------------------------------------------------------- */

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
