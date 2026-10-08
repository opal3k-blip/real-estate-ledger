/* =========================================================================
   Reference-case verification for computeOpportunityXirr — run manually:
     node src/domain/financial/xirr/verify-xirr-opportunity-reference-cases.mjs
   Not wired into CI; mirrors the existing tests/domain/verify-*.mjs convention.
   ========================================================================= */
import { computeOpportunityXirr } from './xirr-opportunity.js';

let pass = 0, fail = 0;
function check(name, actual, expectFn) {
  const ok = expectFn(actual);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ->  ${JSON.stringify(actual)}`);
  if (ok) pass++; else fail++;
}
function closeTo(a, b, tol = 1e-6) { return Math.abs(a - b) < tol; }

// 1. Simple 1-year, non-leap (2026 is not a leap year) -> 10.0000% exactly.
check('1: simple 1yr non-leap',
  computeOpportunityXirr([{ date: '2026-01-01', amount: -100 }, { date: '2027-01-01', amount: 110 }]),
  (r) => r.status === 'OK' && closeTo(r.rate, 0.10, 1e-6));

// 2. 1-year span crossing a leap day (2028 is leap) -> Act/365 fixed-denominator gives 9.97136%, not 10%.
check('2: leap-year span',
  computeOpportunityXirr([{ date: '2028-01-01', amount: -100 }, { date: '2029-01-01', amount: 110 }]),
  (r) => r.status === 'OK' && closeTo(r.rate, 0.0997136, 1e-5));

// 3. Microsoft's published XIRR documentation example -> 37.3362533518831% (independently verified via brentq).
check('3: MS doc example',
  computeOpportunityXirr([
    { date: '2008-01-01', amount: -10000 }, { date: '2008-03-01', amount: 2750 },
    { date: '2008-10-30', amount: 4250 }, { date: '2009-02-15', amount: 3250 },
    { date: '2009-04-01', amount: 2750 },
  ]),
  (r) => r.status === 'OK' && closeTo(r.rate, 0.373362533518831, 1e-6));

// 4. Irregular timing (399 days) -> closed form (1+r)^(399/365)=1.2.
check('4: irregular timing',
  computeOpportunityXirr([{ date: '2026-01-01', amount: -1000 }, { date: '2027-02-04', amount: 1200 }]),
  (r) => r.status === 'OK' && closeTo(r.rate, Math.pow(1.2, 365 / 399) - 1, 1e-6));

// 5. CORRECTED per Opal: -100,+300,-250 at whole years 0,1,2 -> quadratic has NEGATIVE discriminant -> NO_REAL_ROOT, proven.
check('5: no real root (quadratic discriminant<0)',
  computeOpportunityXirr([
    { date: '2026-01-01', amount: -100 }, { date: '2027-01-01', amount: 300 }, { date: '2028-01-01', amount: -250 },
  ]),
  (r) => r.status === 'NO_REAL_ROOT' && r.proof === 'quadratic-discriminant-negative' && r.discriminant < 0);

// 6. Classic multiple-real-root case: -1,+2.5,-1.5 at whole years 0,1,2 -> roots at r=0% and r=50%.
check('6: possible multiple roots (0% and 50%)',
  computeOpportunityXirr([
    { date: '2026-01-01', amount: -1 }, { date: '2027-01-01', amount: 2.5 }, { date: '2028-01-01', amount: -1.5 },
  ]),
  (r) => r.status === 'POSSIBLE_MULTIPLE_ROOTS' && r.roots.length === 2 && closeTo(r.roots[0], 0, 1e-6) && closeTo(r.roots[1], 0.5, 1e-6));

// 7. No sign change (all cashflows negative) -> rejected, not zero.
check('7: no sign change',
  computeOpportunityXirr([{ date: '2026-01-01', amount: -100 }, { date: '2026-06-01', amount: -50 }, { date: '2027-01-01', amount: -20 }]),
  (r) => r.status === 'NO_SIGN_CHANGE');

// 8. All cashflows on the same date (zero time spread) -> degenerate, rejected.
check('8: degenerate zero time spread',
  computeOpportunityXirr([{ date: '2026-01-01', amount: -100 }, { date: '2026-01-01', amount: 40 }, { date: '2026-01-01', amount: 60 }]),
  (r) => r.status === 'DEGENERATE_NO_TIME_SPREAD');

// 9. Single cashflow only -> insufficient input.
check('9: insufficient input (single cashflow)',
  computeOpportunityXirr([{ date: '2026-01-01', amount: -100 }]),
  (r) => r.status === 'INSUFFICIENT_INPUT');

// 10. Known negative return, clean: -100 -> +80 after 1 year -> exactly -20%.
check('10: known negative return',
  computeOpportunityXirr([{ date: '2026-01-01', amount: -100 }, { date: '2027-01-01', amount: 80 }]),
  (r) => r.status === 'OK' && closeTo(r.rate, -0.20, 1e-6));

// 11. Known zero return: -100 -> +100 after 1 year -> exactly 0%.
check('11: known zero return',
  computeOpportunityXirr([{ date: '2026-01-01', amount: -100 }, { date: '2027-01-01', amount: 100 }]),
  (r) => r.status === 'OK' && closeTo(r.rate, 0, 1e-6));

// 12. Aggregation of same-date cashflows: -60 and -40 both at t0 should sum to -100, reproducing case 1's 10%.
check('12: same-date aggregation',
  computeOpportunityXirr([{ date: '2026-01-01', amount: -60 }, { date: '2026-01-01', amount: -40 }, { date: '2027-01-01', amount: 110 }]),
  (r) => r.status === 'OK' && closeTo(r.rate, 0.10, 1e-6));

// 13. Unsorted input order must not change the result (still 10%).
check('13: unsorted input order',
  computeOpportunityXirr([{ date: '2027-01-01', amount: 110 }, { date: '2026-01-01', amount: -100 }]),
  (r) => r.status === 'OK' && closeTo(r.rate, 0.10, 1e-6));

// 14. Invalid date string -> rejected explicitly.
check('14: invalid date',
  computeOpportunityXirr([{ date: '2026-13-40', amount: -100 }, { date: '2027-01-01', amount: 110 }]),
  (r) => r.status === 'INVALID_INPUT');

// 15. Non-finite amount (NaN) -> rejected explicitly.
check('15: non-finite amount',
  computeOpportunityXirr([{ date: '2026-01-01', amount: NaN }, { date: '2027-01-01', amount: 110 }]),
  (r) => r.status === 'INVALID_INPUT');

// 16. Tangent root (double root, no sign change): -100,+200,-100 at whole years 0,1,2 -> exact root r=0%, NOT found by naive sign-change bisection alone.
check('16: tangent/repeated root at r=0',
  computeOpportunityXirr([
    { date: '2026-01-01', amount: -100 }, { date: '2027-01-01', amount: 200 }, { date: '2028-01-01', amount: -100 },
  ]),
  (r) => r.status === 'OK' && closeTo(r.rate, 0, 1e-6));

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
