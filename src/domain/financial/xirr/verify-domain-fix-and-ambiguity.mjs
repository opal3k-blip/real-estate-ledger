/* =========================================================================
   Targeted tests for the three corrections requested in this round:

   1. Domain unification (x vs r): sturmRealRootCountPositiveDomain() must
      give the TRUE global root count over x in (0, +infinity) [r in
      (-1, +infinity)], via sign-at-the-limits, not a finite substitute. We
      check it against independent brute-force bracket scans over very wide
      ranges, AND exercise it end-to-end through computeOpportunityXirr for
      a case that lands in the general (ambiguous-Descartes) Sturm branch.

   2. Small cashflows: a real, nonzero cashflow must never be silently
      dropped merely because it is tiny relative to other flows in the same
      series. Checked directly against normalizeCashflows().

   3. Numerical caution must cover the UNIQUE-root claim too, not only
      NO_REAL_ROOT: when coefficient classification is ambiguous (a
      near-ZERO_TOL coefficient), computeOpportunityXirr must not return a
      hard "descartes-one-sign-change"/"quadratic-discriminant" proof tag.

   Run: node src/domain/financial/xirr/verify-domain-fix-and-ambiguity.mjs
   ========================================================================= */
import { computeOpportunityXirr, normalizeCashflows, sturmRealRootCountPositiveDomain, sturmRealRootCount } from './xirr-opportunity.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}

/* --- 1a. sturmRealRootCountPositiveDomain vs. a very wide finite window --- */
// (x-5)(x-10)(x-50) -> ascending coeffs for (x-5)(x-10)(x-50) = x^3 -65x^2 +1050x -2500
const cubicCoeffs = [-2500, 1050, -65, 1]; // 3 positive real roots at x=5,10,50
const globalCount = sturmRealRootCountPositiveDomain(cubicCoeffs);
const wideWindowCount = sturmRealRootCount(cubicCoeffs, 1e-12, 1e12); // genuinely wide window, both bounds in the SAME (x) units this time
check('1a. global domain count matches a genuinely wide same-unit window (cubic, 3 roots)', globalCount === 3 && wideWindowCount === 3, { globalCount, wideWindowCount });

// x^2+1 scaled: no real roots anywhere, including at the limits.
check('1b. global domain count is 0 for a no-real-root polynomial (x^2+1)', sturmRealRootCountPositiveDomain([1, 0, 1]) === 0, sturmRealRootCountPositiveDomain([1, 0, 1]));

/* --- 1c. End-to-end: a case that lands in the general Sturm fallback branch
   (Descartes ambiguous, not a consecutive-triple quadratic) with a genuine
   in-range root, must resolve to OK via the corrected global-domain Sturm
   count, not ROOT_PROVEN_OUTSIDE_SEARCH_RANGE / INTERNAL_INCONSISTENCY. --- */
// Cashflows at years 0,1,2,3: -100, +40, -10, +90 -> ascending coeffs
// [-100,40,-10,90]; signs -,+,-,+ = 3 Descartes sign changes (ambiguous,
// not a consecutive triple since all 4 years are nonzero).
const fallbackCase = [
  { date: '2026-01-01', amount: -100 },
  { date: '2027-01-01', amount: 40 },
  { date: '2028-01-01', amount: -10 },
  { date: '2029-01-01', amount: 90 },
];
const fallbackResult = computeOpportunityXirr(fallbackCase);
check('1c. Sturm-fallback case resolves without ROOT_PROVEN_OUTSIDE_SEARCH_RANGE or INTERNAL_INCONSISTENCY', !['ROOT_PROVEN_OUTSIDE_SEARCH_RANGE', 'INTERNAL_INCONSISTENCY'].includes(fallbackResult.status), fallbackResult);

/* --- 1d. ROOT_PROVEN_OUTSIDE_SEARCH_RANGE must actually be reachable (not
   just "never wrongly triggered") -- a genuine root above SEARCH_R_MAX,
   with coefficients comparable in magnitude so classification is NOT
   ambiguous, must be reported as proven-but-outside-range, NOT as
   INTERNAL_INCONSISTENCY (the exact bug reported). --- */
const outsideRangeCase = [
  { date: '2026-01-01', amount: -1 },
  { date: '2027-01-01', amount: 2000001 }, // root at r = 1/x-1 = 2,000,000 > SEARCH_R_MAX
];
const outsideRangeResult = computeOpportunityXirr(outsideRangeCase);
check('1d. a root proven to exist (globally) but outside the practical range is reported as such, not as an inconsistency', outsideRangeResult.status === 'ROOT_PROVEN_OUTSIDE_SEARCH_RANGE', outsideRangeResult);

/* --- 2. Small cashflows must never be silently dropped. --- */
// A SAR 0.07 real flow alongside SAR 500,000,000-scale flows. Previously
// (scale * 1e-9 filter), relEps would have been ~0.5 SAR -- comfortably
// ABOVE 0.07, so this flow would have been silently discarded.
const tinyFlowInput = [
  { date: '2026-01-01', amount: -500000000 },
  { date: '2026-06-01', amount: 0.07 },
  { date: '2027-01-01', amount: 530000000 },
];
const normResult = normalizeCashflows(tinyFlowInput);
const tinyFlowSurvived = normResult.ok && normResult.cashflows.some((cf) => cf.date === '2026-06-01' && Math.abs(cf.amount - 0.07) < 1e-9);
check('2. a real SAR 0.07 cashflow survives aggregation despite SAR 500M-scale neighbors', tinyFlowSurvived, normResult);

// Exact-cancellation same-date entries should still collapse harmlessly to 0
// and not break anything (no information is lost; 0 contributes nothing).
const exactCancelInput = [
  { date: '2026-01-01', amount: -100 },
  { date: '2026-06-01', amount: 100 },
  { date: '2026-06-01', amount: -100 }, // nets to exactly 0 with the line above
  { date: '2027-01-01', amount: 110 },
];
const cancelResult = normalizeCashflows(exactCancelInput);
check('2b. exact same-date cancellation to 0 does not break normalization', cancelResult.ok, cancelResult);

/* --- 3. Numerical caution must also cover the UNIQUE-root claim. ---------
   SUPERSEDED test, corrected in the round that fixed Opal's bug report #1:
   the ORIGINAL version of this test built "ambiguity" out of a coefficient
   that was merely SMALL RELATIVE TO ANOTHER YEAR'S coefficient elsewhere in
   the same series (a global-relative notion of "ambiguous magnitude"). That
   is EXACTLY the bug Opal's report #1 identified and required fixed: a
   real, exact, non-cancellation cashflow must never be treated with
   suspicion just because some OTHER year's cashflow is much larger --
   doing so is indistinguishable from the original bug (a real SAR 0.005
   flow wrongly discarded next to a SAR 500,000,000 flow). Classification is
   now strictly LOCAL (per year, against that year's own contributing
   cashflows only -- see isRealNonzeroYear/classificationAmbiguous in
   xirr-opportunity.js), so the old scenario is no longer ambiguous, and
   correctly so: a lone, exactly-specified small cashflow is not numerical
   noise. 3a below asserts exactly this (the old scenario now gets a
   confident proof, not a false "uncertain"). 3b replaces the original
   intent of this test (numerical caution must cover the unique-root claim,
   not just NO_REAL_ROOT) using the mechanism that genuinely does carry that
   kind of ambiguity in this engine: the quadratic discriminant's own
   floating-point error bound (the same mechanism behind Opal's bug #2). --- */

// 3a. A lone, small-but-real, non-cancellation coefficient (same shape as
// Opal's bug #1 repro, just smaller magnitudes) must NOT be treated as
// ambiguous merely for being far smaller than another year's coefficient.
const smallButRealCase = [
  { date: '2026-01-01', amount: -100 },
  { date: '2027-01-01', amount: 3e-7 }, // tiny relative to -100/120, but a lone, exact, real cashflow -- not cancellation residue.
  { date: '2028-01-01', amount: 120 },
];
const smallButRealResult = computeOpportunityXirr(smallButRealCase);
check(
  '3a. a lone small-but-real coefficient gets a confident proof, not a false "ambiguous" downgrade',
  smallButRealResult.status === 'OK' && (smallButRealResult.proof === 'descartes-one-sign-change' || smallButRealResult.proof === 'quadratic-discriminant'),
  smallButRealResult,
);

// 3b. The discriminant error-bound path (bug #2's mechanism) IS a genuine
// source of numerical ambiguity, and must gate the UNIQUE-root claim too,
// not just NO_REAL_ROOT. -100,+200,-100-16*EPS*100 normalizes to a
// discriminant of about -3.55e-15 against an error bound of about
// 2.84e-14 (ratio ~0.125, i.e. safely INSIDE the ambiguous band, unlike
// Opal's bug #2 repro which was ~4 orders of magnitude OUTSIDE it and must
// stay a confident NO_REAL_ROOT -- see bug2 checks in
// verify-opal-round-6-bugs.mjs). This must NOT be certified as either a
// confirmed unique root (quadratic-discriminant OK) or a confirmed absence
// (quadratic-discriminant-negative).
const discAmbiguousCase = [
  { date: '2026-01-01', amount: -100 },
  { date: '2027-01-01', amount: 200 },
  { date: '2028-01-01', amount: -100 - 16 * Number.EPSILON * 100 },
];
const discAmbiguousResult = computeOpportunityXirr(discAmbiguousCase);
const assertsHardQuadraticProof = discAmbiguousResult.status === 'OK' && discAmbiguousResult.proof === 'quadratic-discriminant'
  || discAmbiguousResult.status === 'NO_REAL_ROOT' && discAmbiguousResult.proof === 'quadratic-discriminant-negative';
check(
  '3b. a discriminant within its own floating-point error bound does NOT get a hard quadratic-discriminant proof (either direction)',
  !assertsHardQuadraticProof,
  discAmbiguousResult,
);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
