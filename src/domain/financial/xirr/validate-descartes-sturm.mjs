/* =========================================================================
   Isolated correctness/limits validation of the Descartes + Sturm machinery
   used internally by xirr-opportunity.js, run against KNOWN polynomials
   (not cashflow data) so the numerics can be judged on their own, separate
   from any opportunity data. This is a review artifact, not a feature --
   per instruction, the algebraic solver itself is NOT being expanded now.
   Run: node src/domain/financial/xirr/validate-descartes-sturm.mjs
   ========================================================================= */
import { sturmRealRootCount } from "./xirr-opportunity.js";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: sturmRealRootCount=${actual}  expected=${expected}`);
  if (ok) pass++; else fail++;
}

// P(x) = (x-1)(x-2)(x-3) = x^3 - 6x^2 + 11x - 6 ; 3 distinct real roots.
check("degree-3, 3 distinct roots in (0,10)", sturmRealRootCount([-6, 11, -6, 1], 0, 10), 3);
check("degree-3, 0 roots in (3.5,10) (all roots below 3.5)", sturmRealRootCount([-6, 11, -6, 1], 3.5, 10), 0);

// P(x) = (x-1)^2(x-2) = x^3 - 4x^2 + 5x - 2 ; Sturm counts DISTINCT roots -> 2 (1 is a double root).
check("degree-3 with a double root -> 2 DISTINCT roots counted", sturmRealRootCount([-2, 5, -4, 1], 0, 10), 2);

// P(x) = x^2 + 1 ; no real roots at all.
check("x^2+1, no real roots", sturmRealRootCount([1, 0, 1], -10, 10), 0);

// P(x) = (x-1)(x-2)(x-3)(x-4)(x-5) ; 5 distinct real roots -- moderate degree, still well separated.
function expandRoots(roots) {
  let coeffs = [1]; // ascending, starts as "1"
  for (const r of roots) {
    const next = new Array(coeffs.length + 1).fill(0);
    for (let i = 0; i < coeffs.length; i++) {
      next[i] += -r * coeffs[i];
      next[i + 1] += coeffs[i];
    }
    coeffs = next;
  }
  return coeffs;
}
const deg5 = expandRoots([1, 2, 3, 4, 5]);
check("degree-5, 5 distinct well-separated roots in (0,10)", sturmRealRootCount(deg5, 0, 10), 5);

// Stress test: scale the degree-3 case by 1e7 (typical cashflow-magnitude coefficients)
// to probe conditioning at realistic real-estate cashflow sizes.
const scaled = [-6e7, 11e7, -6e7, 1e7];
check("degree-3 SCALED by 1e7 (real-estate-magnitude coefficients)", sturmRealRootCount(scaled, 0, 10), 3);

// Known pathological case: Wilkinson-style polynomial (x-1)(x-2)...(x-10), 10 close-ish
// integer roots -- textbook example of numerical root-finding instability under
// coefficient expansion. Reported honestly regardless of outcome.
const wilkinson10 = expandRoots([1,2,3,4,5,6,7,8,9,10]);
const w10count = sturmRealRootCount(wilkinson10, 0, 11);
console.log(`INFO  Wilkinson-style degree-10 (roots 1..10): sturmRealRootCount(0,11) = ${w10count}  (expected 10; this is a KNOWN hard case for floating-point polynomial algebra)`);
if (w10count === 10) { console.log("PASS  Wilkinson-10 held up at this scale."); pass++; }
else { console.log("FAIL  Wilkinson-10 did NOT hold up -- documented as a numerical limit below, not silently hidden."); fail++; }

// Even harder: same roots but coefficients additionally scaled by 1e6 (cashflow magnitude).
const wilkinson10Scaled = wilkinson10.map((c) => c * 1e6);
const w10ScaledCount = sturmRealRootCount(wilkinson10Scaled, 0, 11);
console.log(`INFO  Wilkinson-style degree-10 SCALED by 1e6: sturmRealRootCount(0,11) = ${w10ScaledCount}  (expected 10)`);
if (w10ScaledCount === 10) { console.log("PASS  Wilkinson-10 scaled held up."); pass++; }
else { console.log("FAIL  Wilkinson-10 scaled did NOT hold up -- see numerical-limits note."); fail++; }

// Degree-20 stress test (roots 1..20) -- the upper end of a plausible real-estate
// holding horizon if the Sturm fallback were ever reached at that length. This is
// reported as an explicit boundary-of-trust probe, not assumed safe by extension
// from the degree-10 result above.
const roots20 = Array.from({ length: 20 }, (_, i) => i + 1);
const deg20 = expandRoots(roots20);
const deg20Scaled = deg20.map((c) => c * 1e6);
const c20 = sturmRealRootCount(deg20, 0, 21);
const c20s = sturmRealRootCount(deg20Scaled, 0, 21);
console.log(`INFO  degree-20 (roots 1..20), unscaled: sturmRealRootCount(0,21) = ${c20}  (expected 20)`);
console.log(`INFO  degree-20 (roots 1..20), scaled by 1e6: sturmRealRootCount(0,21) = ${c20s}  (expected 20)`);
if (c20 === 20) { pass++; } else { fail++; console.log("FAIL  degree-20 unscaled broke down -- documented limit, see report."); }
if (c20s === 20) { pass++; } else { fail++; console.log("FAIL  degree-20 scaled broke down -- documented limit, see report."); }

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(0); // informational run: exit 0 regardless, findings are reported above (not hidden by a failing exit code during review).
