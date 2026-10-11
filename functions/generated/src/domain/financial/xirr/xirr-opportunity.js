/* =========================================================================
   XIRR (opportunity-level, shadow/comparison mode) — Phase 3B follow-on.
   -------------------------------------------------------------------------
   Pure, deterministic, DOM/Firestore-independent per-opportunity XIRR.
   See docs/XIRR_OPPORTUNITY_COMPUTATION_CONTRACT.md for the full contract
   (sign conventions, date basis, failure-mode semantics, search bounds).

   This module NEVER returns a numeric rate when one cannot be proven or
   found; every failure path returns a distinct, named status instead of a
   silent 0 or a value that merely looks plausible.
   ========================================================================= */

const DAY_MS = 86400000;
const YEAR_DAYS = 365; // Act/365 fixed-denominator convention (see contract doc).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SEARCH_R_MIN = -0.999999;
const SEARCH_R_MAX = 1e6;
const SCAN_STEPS = 20000;
const ZERO_TOL = 1e-9; // used only for internal Sturm/polynomial arithmetic (degree trimming, sign-at-a-point), never for cashflow-year classification -- see isRealNonzeroYear().

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function parseIsoDateUTC(value) {
  const [y, m, d] = value.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/* ---------------------------------------------------------------------
   Step 1: validate, aggregate by exact date, sort, basic classification.
   --------------------------------------------------------------------- */
export function normalizeCashflows(rawCashflows) {
  if (!Array.isArray(rawCashflows) || rawCashflows.length === 0) {
    return { ok: false, status: 'INSUFFICIENT_INPUT', reason: 'No cashflows provided.' };
  }
  for (const cf of rawCashflows) {
    if (!cf || typeof cf !== 'object') {
      return { ok: false, status: 'INVALID_INPUT', reason: 'Each cashflow must be an object with {date, amount}.' };
    }
    if (!isValidIsoDate(cf.date)) {
      return { ok: false, status: 'INVALID_INPUT', reason: `Invalid or non-ISO date: ${JSON.stringify(cf.date)}` };
    }
    if (typeof cf.amount !== 'number' || !Number.isFinite(cf.amount)) {
      return { ok: false, status: 'INVALID_INPUT', reason: `Non-finite or non-numeric amount at date ${cf.date}: ${cf.amount}` };
    }
  }

  if (rawCashflows.length < 2) {
    return { ok: false, status: 'INSUFFICIENT_INPUT', reason: 'Need at least two dated cashflows.' };
  }

  // Check raw (pre-aggregation) time spread FIRST: aggregating by date would
  // silently collapse an "all on one date" degenerate input into a single
  // point (or zero points, if the net happens to be 0), masking the true
  // cause. A single-date input is degenerate regardless of whether its net
  // amount is zero (NPV(r) constant at 0 for all r) or non-zero (NPV(r)
  // constant at that non-zero amount for all r, never crossing zero) --
  // either way no rate is defined, so both are reported the same way.
  const rawDates = rawCashflows.map((cf) => parseIsoDateUTC(cf.date));
  const rawSpanDays = Math.max(...rawDates) - Math.min(...rawDates);
  if (rawSpanDays === 0) {
    return { ok: false, status: 'DEGENERATE_NO_TIME_SPREAD', reason: 'All cashflows fall on the same date; the rate of return is undefined (NPV(r) is constant in r for every input, whether or not the net amount is zero).' };
  }

  const scale = Math.max(...rawCashflows.map((cf) => Math.abs(cf.amount)), 0) || 1;

  // No relative-to-scale drop here, by design: a real, nonzero cashflow is
  // NEVER discarded merely because it is small compared to OTHER flows
  // elsewhere in the series. Same-date entries are combined by plain
  // floating-point summation only. An aggregated amount that lands at
  // EXACTLY 0 (e.g. +100 and -100 on the same date) contributes nothing to
  // NPV either way and is harmless to keep as an inert entry. Any amount
  // that is merely SMALL but genuinely nonzero is kept as real data.
  const byDate = new Map();
  for (const cf of rawCashflows) byDate.set(cf.date, (byDate.get(cf.date) || 0) + cf.amount);
  const dates = [...byDate.keys()].sort();
  const aggregated = dates.map((date) => ({ date, amount: byDate.get(date) }));

  // Defensive invariant, not a live filter outcome: rawSpanDays > 0 (checked
  // above) already guarantees at least two distinct dates, so this can no
  // longer be reached in practice now that nothing is dropped here -- kept
  // only as a safety net against a future change to the aggregation above.
  if (aggregated.length < 2) {
    return { ok: false, status: 'INSUFFICIENT_INPUT', reason: 'Need at least two distinct dated cashflows.' };
  }

  const t0 = parseIsoDateUTC(aggregated[0].date);

  const hasPositive = aggregated.some((cf) => cf.amount > 0);
  const hasNegative = aggregated.some((cf) => cf.amount < 0);
  if (!hasPositive || !hasNegative) {
    return { ok: false, status: 'NO_SIGN_CHANGE', reason: 'All net cashflows (after aggregating by date) share the same sign; no finite rate can equate them.' };
  }

  const withT = aggregated.map((cf) => ({
    date: cf.date,
    amount: cf.amount,
    years: (parseIsoDateUTC(cf.date) - t0) / DAY_MS / YEAR_DAYS,
  }));

  return { ok: true, t0date: aggregated[0].date, cashflows: withT, scale };
}

function npvAt(cashflows, r) {
  const x = 1 / (1 + r);
  let total = 0;
  for (const cf of cashflows) total += cf.amount * Math.pow(x, cf.years);
  return total;
}
function dnpvAt(cashflows, r) {
  const x = 1 / (1 + r);
  let total = 0;
  for (const cf of cashflows) {
    if (cf.years === 0) continue;
    total += cf.amount * (-cf.years) * Math.pow(x, cf.years + 1);
  }
  return total;
}

const INTEGER_TOL = 1e-9;
function isWholeYearAligned(cashflows) {
  return cashflows.every((cf) => Math.abs(cf.years - Math.round(cf.years)) < INTEGER_TOL);
}

// Builds the ascending-power-of-x coefficient array indexed by year, AND a
// per-year "local absolute sum" (sum of |individual cashflow contributions|
// that landed in that year) used by isRealNonzeroYear()/classificationAmbiguous()
// below. The local sum is never compared against any OTHER year's magnitude.
function buildYearPolynomial(cashflows) {
  const maxYear = Math.round(Math.max(...cashflows.map((cf) => cf.years)));
  const coeffs = new Array(maxYear + 1).fill(0);
  const localAbsSum = new Array(maxYear + 1).fill(0);
  for (const cf of cashflows) {
    const y = Math.round(cf.years);
    coeffs[y] += cf.amount;
    localAbsSum[y] += Math.abs(cf.amount);
  }
  return { coeffs, localAbsSum };
}

// A year's coefficient is a REAL, economically meaningful nonzero term
// UNLESS its net amount is floating-point cancellation residue of the
// cashflows that were summed INTO THAT YEAR specifically (e.g. +100 and
// -100 landing in the same year nets to ~0 by construction). This is judged
// strictly LOCALLY: against the sum of |amounts| that fed that one year,
// NEVER against the magnitude of any OTHER year's coefficient elsewhere in
// the series.
//
// This replaces a prior bug: coefficients used to be classified zero/nonzero
// via Math.abs(normalizedCoeff) > ZERO_TOL, where normalizedCoeff was scaled
// by the GLOBAL max coefficient across the whole series. A real cashflow
// that is simply much smaller than some OTHER, unrelated cashflow elsewhere
// in the same series (e.g. SAR 0.005 at year 10, alongside SAR 500,000,000
// at year 0) would normalize to a value far below ZERO_TOL and be silently
// treated as if it were zero -- even though it is the ONLY term that gives
// the polynomial a sign change at all, so dropping it produced a false
// NO_REAL_ROOT proof for a cashflow series that does have a real, findable
// root. Classifying LOCALLY (per year, against that year's own inputs only)
// cannot make this mistake: a year's true economic magnitude relative to
// OTHER years is irrelevant to whether it is "real".
const LOCAL_FLOAT_NOISE_REL_EPS = Number.EPSILON * 1e4; // ~2.22e-12; a safety margin over plain double-precision summation rounding for a realistic handful of same-year entries.
const LOCAL_AMBIGUOUS_MARGIN = 10;
function isRealNonzeroYear(coeff, localAbsSum) {
  if (localAbsSum === 0) return false; // no cashflow landed here at all -- a true, exact zero, not a classification judgment call.
  return Math.abs(coeff) > localAbsSum * LOCAL_FLOAT_NOISE_REL_EPS;
}
// Flags when some year's net amount sits within one order of magnitude of
// its OWN local noise floor (localAbsSum * LOCAL_FLOAT_NOISE_REL_EPS) on
// either side -- i.e. whether that year is "real" or "cancellation residue"
// is itself too close to call. This is a review safeguard, not a new
// algorithm: it never changes which branch of computeOpportunityXirr runs
// (isRealNonzeroYear's own yes/no answer still picks the branch); it only
// gates whether a "no root exists" conclusion resting on that classification
// may be reported as a certified proof, versus an honest "uncertain" status.
function classificationAmbiguous(rawCoeffs, localAbsSum) {
  for (let i = 0; i < rawCoeffs.length; i++) {
    if (localAbsSum[i] === 0) continue;
    const noiseFloor = localAbsSum[i] * LOCAL_FLOAT_NOISE_REL_EPS;
    if (noiseFloor === 0) continue;
    const ratio = Math.abs(rawCoeffs[i]) / noiseFloor;
    if (ratio > 1 / LOCAL_AMBIGUOUS_MARGIN && ratio < LOCAL_AMBIGUOUS_MARGIN) return true;
  }
  return false;
}

// Dividing every coefficient of P(x) by a positive constant does not change
// the roots of P(x)=0 (cP(x)=0 <=> P(x)=0 for c!=0). Normalizing to a
// max-abs-coefficient of 1 makes every downstream absolute-epsilon test used
// for ARITHMETIC (discriminant error bound, Sturm sign test) meaningful
// regardless of whether the input cashflows are denominated in SAR,
// thousands of SAR, or millions. This is no longer used to decide zero vs
// nonzero classification (see isRealNonzeroYear above) -- only to condition
// the numeric arithmetic performed on already-classified real coefficients.
function normalizeCoefficients(coeffs) {
  const scale = Math.max(...coeffs.map((c) => Math.abs(c)), 0) || 1;
  return { normalized: coeffs.map((c) => c / scale), scale };
}
function descartesSignChanges(coeffsLowToHigh, isRealNonzero) {
  const nz = coeffsLowToHigh.filter((c, i) => isRealNonzero[i]);
  let changes = 0;
  for (let i = 1; i < nz.length; i++) if ((nz[i] > 0) !== (nz[i - 1] > 0)) changes++;
  return changes;
}

function solveQuadraticPositiveX(a, b, c) {
  const disc = b * b - 4 * a * c;
  // Bound how much floating-point rounding could plausibly have perturbed
  // this COMPUTED discriminant away from its true mathematical value, given
  // the magnitudes of a, b, c (first-order error analysis for the handful of
  // multiply/subtract operations involved, in double precision -- a generous
  // 64x machine-epsilon margin on the computation's own natural scale).
  const discScale = b * b + 4 * Math.abs(a) * Math.abs(c);
  const discErrorBound = discScale * 64 * Number.EPSILON;
  const isExactZero = disc === 0;
  if (!isExactZero && Math.abs(disc) <= discErrorBound) {
    // Too close to the computation's own floating-point error floor to
    // certify EITHER a confirmed (possibly repeated) real root OR a
    // confirmed absence of one. Previously this was silently resolved by
    // Math.max(0, disc), which clamped a slightly-negative-but-RELIABLE
    // discriminant (far outside this error band -- see below) to 0 and
    // reported a false "confirmed tangent root". That clamping is removed;
    // a genuinely ambiguous case is reported as such instead of guessed.
    return { roots: [], discriminant: disc, ambiguous: true };
  }
  if (disc < 0) return { roots: [], discriminant: disc, ambiguous: false };
  // disc is confirmed >= 0 here (exactly 0, or reliably positive and beyond
  // the error band) -- no clamping is needed or performed.
  const sq = Math.sqrt(disc);
  const x1 = (-b + sq) / (2 * a);
  const x2 = (-b - sq) / (2 * a);
  const roots = [...new Set([x1, x2].filter((x) => x > 1e-12).map((x) => Number(x.toFixed(12))))];
  return { roots, discriminant: disc, ambiguous: false };
}

/* ---------------------------------------------------------------------
   Sturm's sequence — exact distinct-real-root count in (lo,hi], used only
   as the rigorous fallback when Descartes is ambiguous (>=2 sign changes)
   on a whole-year polynomial that is NOT a simple consecutive quadratic.
   --------------------------------------------------------------------- */
function polyDerivative(c) { return c.length <= 1 ? [0] : c.slice(1).map((v, i) => v * (i + 1)); }
function polyDegree(c) { for (let i = c.length - 1; i >= 0; i--) if (Math.abs(c[i]) > 1e-9) return i; return -1; }
function polyTrim(c) { const d = polyDegree(c); return c.slice(0, d + 1); }
function polyRemainder(A, B) {
  let a = polyTrim(A.slice());
  const b = polyTrim(B.slice());
  const db = polyDegree(b);
  if (db < 0) throw new Error('STURM_DIVISION_BY_ZERO_POLYNOMIAL');
  let guard = 0;
  while (polyDegree(a) >= db) {
    const da = polyDegree(a);
    const coef = a[da] / b[db];
    const shift = da - db;
    for (let i = 0; i <= db; i++) a[i + shift] -= coef * b[i];
    a = polyTrim(a);
    guard++;
    if (guard > A.length + 5) break;
  }
  return a;
}
function buildSturmSequence(p) {
  const seq = [polyTrim(p), polyTrim(polyDerivative(p))];
  let guard = 0;
  while (polyDegree(seq[seq.length - 1]) >= 0) {
    const rem = polyRemainder(seq[seq.length - 2], seq[seq.length - 1]);
    const negated = rem.map((v) => -v);
    if (polyDegree(negated) < 0) break;
    seq.push(negated);
    guard++;
    if (guard > p.length + 5) break;
  }
  return seq;
}
function signAt(seq, x) {
  return seq.map((p) => {
    let v = 0, xp = 1;
    for (let i = 0; i < p.length; i++) { v += p[i] * xp; xp *= x; }
    if (Math.abs(v) < 1e-9) return 0;
    return v > 0 ? 1 : -1;
  });
}
function countSignChanges(signs) {
  const nz = signs.filter((s) => s !== 0);
  let c = 0;
  for (let i = 1; i < nz.length; i++) if (nz[i] !== nz[i - 1]) c++;
  return c;
}
export function sturmRealRootCount(coeffsLowToHigh, lo, hi) {
  const seq = buildSturmSequence(coeffsLowToHigh);
  return countSignChanges(signAt(seq, lo)) - countSignChanges(signAt(seq, hi));
}
function signOfLowestNonzeroTerm(poly) {
  for (let i = 0; i < poly.length; i++) if (Math.abs(poly[i]) > 1e-9) return poly[i] > 0 ? 1 : -1;
  return 0;
}
function signOfHighestNonzeroTerm(poly) {
  for (let i = poly.length - 1; i >= 0; i--) if (Math.abs(poly[i]) > 1e-9) return poly[i] > 0 ? 1 : -1;
  return 0;
}
// Counts real roots of P(x)=0 for x in the OPEN interval (0, +infinity) --
// i.e. for r in (-1, +infinity), the ENTIRE feasible rate domain -- using
// Sturm's theorem evaluated AT THE LIMITS x->0+ and x->+infinity (the sign
// of a polynomial's lowest/highest nonzero-coefficient term dominates at
// each limit respectively), rather than at an arbitrary finite substitute
// for "infinity".
export function sturmRealRootCountPositiveDomain(coeffsLowToHigh) {
  const seq = buildSturmSequence(coeffsLowToHigh);
  const signsAtZero = seq.map(signOfLowestNonzeroTerm);
  const signsAtInfinity = seq.map(signOfHighestNonzeroTerm);
  return countSignChanges(signsAtZero) - countSignChanges(signsAtInfinity);
}
// The x-interval that corresponds EXACTLY to the practical r-domain search
// window [SEARCH_R_MIN, SEARCH_R_MAX] (x=1/(1+r) is monotonically
// decreasing in r, so the window's two r-endpoints map to the x-interval's
// two endpoints in reverse order).
function searchWindowXBounds() {
  return { xLo: 1 / (1 + SEARCH_R_MAX), xHi: 1 / (1 + SEARCH_R_MIN) };
}
// Counts real roots EXACTLY within the practical search window (not the
// whole domain), cross-validated against a rescaled copy of the same
// polynomial for the same numerical-doubt reasons as sturmRealRootCountPositiveDomain's
// caller. Used ONLY to decide whether a root proven to exist (globally) can
// be confirmed OUTSIDE the practical window -- never inferred from a scan's
// empirical non-find, which is not proof of absence inside a window either.
function countRootsInSearchWindow(coeffs) {
  const { xLo, xHi } = searchWindowXBounds();
  let count = null;
  let countCrossScale = null;
  try { count = sturmRealRootCount(coeffs, xLo, xHi); } catch (e) { count = null; }
  try { countCrossScale = sturmRealRootCount(coeffs.map((v) => v * 1000), xLo, xHi); } catch (e) { countCrossScale = null; }
  const agrees = count !== null && countCrossScale !== null && count === countCrossScale;
  return { count, countCrossScale, agrees };
}

/* ---------------------------------------------------------------------
   Numeric fallback: bracket scan + Newton-with-bisection-guard.
   --------------------------------------------------------------------- */
function scanBrackets(fn, rMin, rMax, steps) {
  // Step through x = 1/(1+r) LOGARITHMICALLY rather than r linearly. A fixed
  // linear-in-r grid over a huge range (e.g. [-0.999999, 1e6]) gives a step
  // size on the order of tens near r=0 -- easily wide enough to step clean
  // over a real root that sits close to r=0, which is exactly where
  // realistic, long-dated cashflow roots live (a 60-year-horizon, ~0.16%
  // case exposed this: the old linear scan found nothing even though a real
  // root sat well inside the window). Log-in-x spacing concentrates
  // resolution exactly there, with coarser resolution only out at the
  // financially-meaningless extremes.
  //
  // This is a resolution fix for this best-effort, non-exhaustive bracket
  // scan; it does not change what any Descartes/quadratic/Sturm PROOF
  // establishes, and "this scan found nothing" must still never be read, on
  // its own, as proof that a root lies outside the window -- see
  // countRootsInSearchWindow(), used at call sites that make that claim.
  const xAtRMin = 1 / (1 + rMin); // r=rMin (closest to -1) -> LARGEST x
  const xAtRMax = 1 / (1 + rMax); // r=rMax (the largest r) -> SMALLEST x
  const logLo = Math.log(xAtRMax);
  const logHi = Math.log(xAtRMin);
  const brackets = [];
  let prevR = rMax;
  let prevV = fn(prevR);
  for (let i = 1; i <= steps; i++) {
    const x = Math.exp(logLo + (logHi - logLo) * (i / steps));
    const r = 1 / x - 1;
    const v = fn(r);
    if (Number.isFinite(prevV) && Number.isFinite(v) && prevV !== 0 && v !== 0 && (prevV > 0) !== (v > 0)) {
      brackets.push([Math.min(prevR, r), Math.max(prevR, r)]);
    }
    prevR = r; prevV = v;
  }
  return brackets;
}
function bisectNewtonSolve(npvFn, dnpvFn, lo, hi, tol = 1e-10, maxIter = 300) {
  let a = lo, b = hi, fa = npvFn(a), fb = npvFn(b);
  if (Math.abs(fa) < tol) return a;
  if (Math.abs(fb) < tol) return b;
  for (let i = 0; i < maxIter; i++) {
    const mid = (a + b) / 2;
    const fm = npvFn(mid);
    const dm = dnpvFn(mid);
    let candidate = mid;
    if (Number.isFinite(dm) && dm !== 0) {
      const step = mid - fm / dm;
      if (step > a && step < b) candidate = step;
    }
    const fc = npvFn(candidate);
    if (Math.abs(fc) < tol || Math.abs(b - a) < 1e-12) return candidate;
    if ((fc > 0) === (fa > 0)) { a = candidate; fa = fc; } else { b = candidate; fb = fc; }
  }
  return (a + b) / 2;
}

/* ---------------------------------------------------------------------
   Top-level entry point.
   --------------------------------------------------------------------- */
export function computeOpportunityXirr(rawCashflows) {
  const norm = normalizeCashflows(rawCashflows);
  if (!norm.ok) return { status: norm.status, reason: norm.reason };
  const cashflows = norm.cashflows;
  const npvFn = (r) => npvAt(cashflows, r);
  const dnpvFn = (r) => dnpvAt(cashflows, r);
  // NPV's natural magnitude scales linearly with the cashflow amounts
  // themselves. A fixed absolute convergence tolerance is meaningless noise
  // at real-estate scale (tens of millions) and far too loose at sub-unit
  // scale (cents) -- it must be relative to norm.scale so the SOLVED RATE,
  // not just the classification, is scale-invariant too.
  const solveTol = norm.scale * 1e-12;
  // Same reasoning applies to the "is this critical point actually touching
  // zero" tangent-confirmation check in the irregular-date branch below: an
  // absolute threshold there is defeated entirely once all cashflows are
  // scaled down (NPV values shrink below ANY fixed absolute epsilon,
  // falsely "confirming" a tangent root that does not exist).
  const tangentTol = norm.scale * 1e-9;

  if (isWholeYearAligned(cashflows)) {
    const { coeffs: rawCoeffs, localAbsSum } = buildYearPolynomial(cashflows);
    const realNonzeroYear = rawCoeffs.map((c, i) => isRealNonzeroYear(c, localAbsSum[i]));
    // Gate on classification confidence BEFORE even counting sign changes:
    // if some year's real/residue call is too close to its own local noise
    // floor, descartesSignChanges()'s COUNT ITSELF is not trustworthy -- so
    // this is a gate on BOTH a "no root exists" conclusion AND an "exactly
    // one root, proven unique" conclusion. When ambiguous, this skips the
    // Descartes/quadratic exact-proof branches entirely and falls through
    // to the general Sturm+numeric-scan fallback below, which never asserts
    // a hard "proven unique" label under this condition.
    const ambiguousZero = classificationAmbiguous(rawCoeffs, localAbsSum);
    // Normalize for ARITHMETIC conditioning only (Sturm/discriminant
    // numerics) -- classification above already happened on raw, local data.
    const { normalized: coeffs } = normalizeCoefficients(rawCoeffs);
    const signChanges = ambiguousZero ? null : descartesSignChanges(coeffs, realNonzeroYear);

    if (signChanges === 0) {
      // (Reaching this branch at all already means ambiguousZero is false.)
      return { status: 'NO_REAL_ROOT', proof: 'descartes-zero-sign-changes', reason: 'The aggregated coefficient sequence has zero sign changes; Descartes’ rule of signs proves there is no root with r > -1.' };
    }

    if (signChanges === 1) {
      // Descartes with exactly one sign change proves EXACTLY ONE real root
      // exists for r > -1 -- a GLOBAL statement over the entire domain, not
      // one bounded by whatever practical [SEARCH_R_MIN, SEARCH_R_MAX]
      // window the numeric scan happens to use. It also proves that root is
      // SIMPLE (multiplicity 1): if it had multiplicity 2 the true root
      // count would differ from the sign-change count by an even number,
      // which 1 vs 1 cannot satisfy -- so no tangency check is needed here.
      const brackets = scanBrackets(npvFn, SEARCH_R_MIN, SEARCH_R_MAX, SCAN_STEPS);
      if (brackets.length === 1) {
        const rate = bisectNewtonSolve(npvFn, dnpvFn, brackets[0][0], brackets[0][1], solveTol);
        return { status: 'OK', rate, method: 'descartes-proven-unique+bisection-newton', proof: 'descartes-one-sign-change' };
      }
      if (brackets.length === 0) {
        // An empirical "the scan found nothing" is NOT by itself proof that
        // the root lies outside the practical window -- a scan, however
        // improved, can still miss an in-window root. Decide in/out of
        // window EXACTLY via Sturm's sequence over the x-interval that
        // actually corresponds to this r-window, cross-validated, rather
        // than inferring "outside" from the scan's non-find.
        const win = countRootsInSearchWindow(coeffs);
        if (win.agrees && win.count === 0) {
          return { status: 'ROOT_PROVEN_OUTSIDE_SEARCH_RANGE', proof: 'descartes-one-sign-change+sturm-window-zero-count', scannedRange: [SEARCH_R_MIN, SEARCH_R_MAX], reason: 'Descartes’ rule proves exactly one real root exists for r > -1 (global); an independent Sturm count over the x-interval corresponding to [SEARCH_R_MIN, SEARCH_R_MAX] (cross-scale confirmed) proves zero roots fall inside that window -- so the root is confirmed outside the practical range, not merely unfound by the scan.' };
        }
        return { status: 'NO_ROOT_FOUND_IN_SEARCH_RANGE', scannedRange: [SEARCH_R_MIN, SEARCH_R_MAX], windowCount: win.count, windowCountCrossScale: win.countCrossScale, reason: 'Descartes’ rule proves exactly one real root exists for r > -1 (global), but neither the numeric scan nor an exact window-restricted Sturm count could confirm the root lies outside the practical search range. Not claimed as proven outside the range merely because the scan did not find it.' };
      }
      // More than one bracket while Descartes proved exactly one root
      // globally: this genuinely is a disagreement (e.g. floating-point
      // noise producing a spurious extra crossing near a near-tangent
      // point), and is still refused rather than guessed.
      return { status: 'INTERNAL_INCONSISTENCY', reason: `Descartes proved exactly one root (globally) but the numeric scan found ${brackets.length} bracket(s) in [${SEARCH_R_MIN}, ${SEARCH_R_MAX}]; refusing to guess.` };
    }

    let discAmbiguityInfo = null; // set when the quadratic discriminant is within its own floating-point error band; carried into the fallback so NO Sturm-based "proven/confirmed" wording can rest on it.
    const nonZeroYears = ambiguousZero ? [] : coeffs.map((c, i) => (realNonzeroYear[i] ? i : null)).filter((v) => v !== null);
    const isConsecutiveTriple = !ambiguousZero && nonZeroYears.length === 3 && nonZeroYears[2] - nonZeroYears[0] === 2;

    if (isConsecutiveTriple) {
      const [y0, , y2] = nonZeroYears;
      const a = coeffs[y2], b = coeffs[y0 + 1], c = coeffs[y0];
      const { roots, discriminant, ambiguous } = solveQuadraticPositiveX(a, b, c);
      if (!ambiguous) {
        if (discriminant < 0) {
          return { status: 'NO_REAL_ROOT', proof: 'quadratic-discriminant-negative', discriminant, reason: 'Exact quadratic discriminant (on normalized coefficients) is reliably negative, beyond its own floating-point error bound: NPV(r) never crosses zero for any real r > -1.' };
        }
        if (roots.length === 0) {
          return { status: 'NO_REAL_ROOT', proof: 'quadratic-roots-outside-domain', discriminant, reason: 'The quadratic has real roots, but none correspond to x = 1/(1+r) > 0 (r > -1).' };
        }
        const rates = roots.map((x) => 1 / x - 1).sort((p, q) => p - q);
        if (rates.length === 1) return { status: 'OK', rate: rates[0], method: 'quadratic-exact', proof: 'quadratic-discriminant', discriminant };
        return { status: 'POSSIBLE_MULTIPLE_ROOTS', roots: rates, proof: 'quadratic-exact-two-roots', discriminant, reason: 'Exact quadratic analysis proves two distinct real rates satisfy NPV = 0.' };
      }
      // ambiguous: the discriminant is too close to its own floating-point
      // error bound to certify a proof either way. The flag is KEPT and
      // carried forward (not discarded): Sturm on this same polynomial
      // cannot separate "double root" from "no root" either, and a second
      // run on a rescaled copy shares the same ill-conditioning, so its
      // agreement is not independent evidence.
      discAmbiguityInfo = { discriminant, discriminantErrorBound: (coeffs[y0 + 1] ** 2 + 4 * Math.abs(coeffs[y2]) * Math.abs(coeffs[y0])) * 64 * Number.EPSILON };
    }

    if (discAmbiguityInfo) {
      const sc = scanBrackets(npvFn, SEARCH_R_MIN, SEARCH_R_MAX, SCAN_STEPS * 2);
      const candidateRates = sc.map(([lo, hi]) => bisectNewtonSolve(npvFn, dnpvFn, lo, hi, solveTol)).sort((p, q) => p - q);
      return { status: 'NUMERICALLY_AMBIGUOUS', ...discAmbiguityInfo, candidateRates, candidateRatesAreUnverified: true, reason: 'The quadratic discriminant lies within its own floating-point error bound, so neither a repeated real root nor the absence of a real root can be established. Re-running Sturm (even on a rescaled copy) shares the same ill-conditioning and is not independent evidence, so it is not used. candidateRates come from a numeric scan only and are unverified.' };
    }

    // General Sturm fallback -- reached when Descartes' count is genuinely
    // ambiguous (>=2 sign changes), OR the coefficient classification itself
    // was too close to call (ambiguousZero), OR the nonzero-year pattern
    // isn't a simple consecutive-triple quadratic, OR that quadratic's own
    // discriminant was itself ambiguous. This is also the ONE branch where
    // polynomial pseudo-division can still lose precision even on
    // pre-normalized input (classic ill-conditioning of the Euclidean
    // algorithm for close/repeated roots).
    let sturmCount = null;
    let sturmCountCrossScale = null;
    try { sturmCount = sturmRealRootCountPositiveDomain(coeffs); } catch (e) { sturmCount = null; }
    try { sturmCountCrossScale = sturmRealRootCountPositiveDomain(coeffs.map((v) => v * 1000)); } catch (e) { sturmCountCrossScale = null; }
    const sturmAgreesAcrossScale = sturmCount !== null && sturmCountCrossScale !== null && sturmCount === sturmCountCrossScale;

    const brackets = scanBrackets(npvFn, SEARCH_R_MIN, SEARCH_R_MAX, SCAN_STEPS * 2);

    if (sturmCount === 0 && brackets.length === 0) {
      if (!sturmAgreesAcrossScale || ambiguousZero) {
        return { status: 'NO_ROOT_FOUND_IN_SEARCH_RANGE', scannedRange: [SEARCH_R_MIN, SEARCH_R_MAX], sturmCount, sturmCountCrossScale, ...(ambiguousZero ? { nearZeroEpsilonAmbiguous: true } : {}), reason: !sturmAgreesAcrossScale ? 'Sturm’s sequence (global domain) suggested zero real roots, but re-running it on a rescaled copy of the SAME polynomial gave a different count. Not treated as proof of absence; reported as uncertain instead.' : 'Sturm’s sequence suggested zero real roots, but coefficient classification was within the ambiguous zero-band; not certified as proof.' };
      }
      return { status: 'NO_REAL_ROOT', proof: 'sturm-sequence-zero-count-cross-scale-confirmed-global-domain', sturmCount, sturmCountCrossScale, reason: 'Sturm’s sequence, evaluated over the ENTIRE domain r > -1 via sign-at-the-limits (not a finite window), proves zero real roots; confirmed by an independent rescaling of the same polynomial (same count both times).' };
    }

    if (brackets.length === 0 && sturmCount !== null && sturmCount >= 1) {
      // Same principle as the Descartes-one-sign-change branch above: the
      // scan finding nothing is NOT proof the root(s) are outside the
      // window. Decide EXACTLY via a Sturm count restricted to the window.
      const win = countRootsInSearchWindow(coeffs);
      if (win.agrees && win.count === 0) {
        return { status: 'ROOT_PROVEN_OUTSIDE_SEARCH_RANGE', proof: sturmAgreesAcrossScale ? 'sturm-sequence-global-domain+window-zero-count-cross-scale-confirmed' : 'sturm-sequence-global-domain+window-zero-count-not-cross-scale-confirmed', sturmCount, sturmCountCrossScale, scannedRange: [SEARCH_R_MIN, SEARCH_R_MAX], reason: `Sturm’s sequence over the entire domain r > -1 proves ${sturmCount} real root(s) exist; an independent Sturm count restricted to the x-interval corresponding to [${SEARCH_R_MIN}, ${SEARCH_R_MAX}] (cross-scale confirmed) proves zero of them fall inside that window -- so they are confirmed outside it, not merely unfound by the scan.` };
      }
      return { status: 'NO_ROOT_FOUND_IN_SEARCH_RANGE', scannedRange: [SEARCH_R_MIN, SEARCH_R_MAX], sturmCount, sturmCountCrossScale, windowCount: win.count, windowCountCrossScale: win.countCrossScale, reason: 'Sturm’s sequence proves at least one real root exists globally, but neither the scan nor a window-restricted Sturm count could confirm it lies outside the practical search range. Not claimed as proven outside the range merely because the scan did not find it.' };
    }
    if (brackets.length === 0) {
      return { status: 'NO_ROOT_FOUND_IN_SEARCH_RANGE', scannedRange: [SEARCH_R_MIN, SEARCH_R_MAX], sturmCount, sturmCountCrossScale, reason: 'No sign-change bracket found; Sturm’s count was inconclusive or unavailable, so absence of a root elsewhere is NOT proven.' };
    }
    const rates = brackets.map(([lo, hi]) => bisectNewtonSolve(npvFn, dnpvFn, lo, hi, solveTol)).sort((p, q) => p - q);
    const sturmConfirmsUnique = sturmAgreesAcrossScale && sturmCount === 1 && !ambiguousZero;
    if (rates.length === 1 && (sturmCount === null || sturmConfirmsUnique || (sturmCount === 1 && sturmCountCrossScale === null))) {
      return { status: 'OK', rate: rates[0], method: 'bracket-scan+bisection-newton', proof: sturmConfirmsUnique ? 'sturm-sequence-confirmed-unique-global-domain' : 'numeric-scan-only-not-exhaustive-proof', ...(ambiguousZero ? { nearZeroEpsilonAmbiguous: true } : {}) };
    }
    const note = (sturmCount !== null && sturmCount !== rates.length)
      ? ` Sturm’s global-domain count (${sturmCount}) differs from the number of roots located within the practical search range (${rates.length}); some proven root(s) may lie outside [${SEARCH_R_MIN}, ${SEARCH_R_MAX}].`
      : '';
    return { status: 'POSSIBLE_MULTIPLE_ROOTS', roots: rates, sturmCount, sturmCountCrossScale, reason: `More than one sign-change bracket found, or Sturm’s global count exceeds one (or disagreed across scale); multiple real rates may satisfy NPV = 0.${note}` };
  }

  // Irregular (non-whole-year) dates: no exact polynomial proof is available.
  const brackets = scanBrackets(npvFn, SEARCH_R_MIN, SEARCH_R_MAX, SCAN_STEPS * 2);
  const critBrackets = scanBrackets(dnpvFn, SEARCH_R_MIN, SEARCH_R_MAX, SCAN_STEPS * 2);
  // The derivative's magnitude also scales linearly with the amounts, so ITS
  // root-solving tolerance must be scale-relative too (the default absolute
  // 1e-10 made the solver stop immediately once amounts were scaled down).
  const dSolveTol = norm.scale * 1e-12;
  const tangentCandidates = [];
  for (const [lo, hi] of critBrackets) {
    const d2 = (r) => (dnpvFn(r + 1e-6) - dnpvFn(r - 1e-6)) / 2e-6;
    const rCrit = bisectNewtonSolve(dnpvFn, d2, lo, hi, dSolveTol);
    // A critical point whose NPV is merely CLOSE to zero is NOT certified as
    // a tangent root: a minimum a hair below (or above) zero is
    // indistinguishable here from a true touch, and without an exact
    // polynomial proof the distinction cannot be made. It is reported as an
    // unresolved candidate, never as a confirmed root.
    if (Math.abs(npvFn(rCrit)) < tangentTol) tangentCandidates.push(rCrit);
  }

  if (brackets.length === 0 && tangentCandidates.length === 0) {
    return { status: 'NO_ROOT_FOUND_IN_SEARCH_RANGE', scannedRange: [SEARCH_R_MIN, SEARCH_R_MAX], reason: 'No sign-change bracket and no near-tangent critical point found. This does NOT prove no real root exists outside the range; an exact polynomial proof is unavailable because cashflow dates are not whole-year-aligned.' };
  }

  const crossingRates = brackets.map(([lo, hi]) => bisectNewtonSolve(npvFn, dnpvFn, lo, hi, solveTol)).sort((p, q) => p - q);
  if (tangentCandidates.length > 0) {
    return { status: 'NUMERICALLY_AMBIGUOUS', crossingRates, tangentCandidates: tangentCandidates.sort((p, q) => p - q), candidateRatesAreUnverified: true, reason: 'NPV comes within the scale-relative tolerance of zero at a critical point without a sign change. With non-whole-year dates there is no exact proof to tell a true tangent (repeated) root from a minimum just above/below zero, so no tangent root is confirmed and no rate is returned as OK.' };
  }
  const allRates = crossingRates;
  const distinctRates = allRates.filter((r, i) => i === 0 || Math.abs(r - allRates[i - 1]) > 1e-6);

  if (distinctRates.length === 1) {
    return { status: 'OK', rate: distinctRates[0], method: 'bracket-scan+bisection-newton', proof: 'numeric-scan-only-not-exhaustive-proof' };
  }
  return { status: 'POSSIBLE_MULTIPLE_ROOTS', roots: distinctRates, reason: 'More than one real rate found to satisfy NPV = 0 within the searched range.' };
}
