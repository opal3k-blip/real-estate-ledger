# XIRR opportunity computation — contract (shadow mode)

Module: `src/domain/financial/xirr/xirr-opportunity.js` (`computeOpportunityXirr`).
Status: **shadow / comparison only.** Not wired to any UI, server, IC gate or Golden Master. No production decision reads it.

## 1. Input and normalization
- Input: array of `{ date: 'YYYY-MM-DD', amount: finite number }`. Invalid dates / non-finite amounts → `INVALID_INPUT`.
- Day count: Act/365 fixed denominator, `t = days since earliest date / 365`.
- Same-date entries are combined by plain floating-point summation. **No cashflow is ever dropped for being small**; an entry that nets to exactly 0 is inert.
- Needs ≥2 distinct dates and both a positive and a negative net amount, otherwise `INSUFFICIENT_INPUT`, `DEGENERATE_NO_TIME_SPREAD` or `NO_SIGN_CHANGE`.
- Equation: `NPV(r) = Σ aᵢ(1+r)^(−tᵢ) = 0`, domain `r > −1`. Practical search window `[-0.999999, 1e6]`.

## 2. Result statuses
| status | meaning | claims a rate? |
|---|---|---|
| `OK` | a root was located; `proof` says what (if anything) establishes uniqueness | yes |
| `POSSIBLE_MULTIPLE_ROOTS` | more than one root found/indicated | no single rate |
| `NO_REAL_ROOT` | proven absence (Descartes 0 sign changes, reliably negative discriminant, or Sturm over the whole domain) | no |
| `ROOT_PROVEN_OUTSIDE_SEARCH_RANGE` | a root exists globally and an exact Sturm count over the search window proves none is inside it | no |
| `NO_ROOT_FOUND_IN_SEARCH_RANGE` | scan found nothing; **not** a proof of absence or of location | no |
| `NUMERICALLY_AMBIGUOUS` | the computation cannot separate the cases (see §4); no proof is claimed; any listed candidates are unverified | no |
| `INSUFFICIENT_INPUT` / `INVALID_INPUT` / `DEGENERATE_NO_TIME_SPREAD` / `NO_SIGN_CHANGE` | input cannot define a rate | no |
| `INTERNAL_INCONSISTENCY` | two internal methods disagreed; refused rather than guessed | no |

The module never returns 0 or any plausible-looking number when a rate cannot be established.

## 3. What each method proves
Whole-year-aligned dates (every `t` within 1e-9 of an integer) → polynomial in `x = 1/(1+r)`, coefficients per year:
- **Descartes, 0 sign changes** ⇒ no root for `r > −1` (global).
- **Descartes, 1 sign change** ⇒ exactly one simple root for `r > −1` (global). It is then located by a scan + bisection/Newton. If the scan does not find it, an exact Sturm count restricted to the search window decides "outside the window" versus "inside but unfound"; the scan's silence alone is never read as "outside".
- **Consecutive three-year quadratic**: exact discriminant with a floating-point error bound `64·ε·(b²+4|a||c|)`. Reliably negative ⇒ `NO_REAL_ROOT`; reliably ≥0 ⇒ exact roots; inside the bound ⇒ `NUMERICALLY_AMBIGUOUS`.
- **Sturm fallback** (≥2 sign changes / other patterns): global root count over `(0,∞)` by sign-at-the-limits. A rescaled re-run is a *consistency check only*; it shares the same conditioning and is not independent evidence.
- Coefficient classification (real vs cancellation residue) is **local per year**, never relative to another year's magnitude.

Irregular (non-whole-year) dates: **no exact proof is available.** Result comes from a log-spaced scan; `proof` is `numeric-scan-only-not-exhaustive-proof`. A critical point where NPV is merely near zero is **not** certified as a tangent root → `NUMERICALLY_AMBIGUOUS`.

## 4. Numerical-solution limits (read before using a result)
1. **Search window** `[-0.999999, 1e6]`; roots outside are only reported when proven (whole-year path).
2. **Scan resolution**: log-spaced in `x`, 20 000 steps (40 000 on the fallback/irregular paths). Two roots inside one grid cell cancel the sign change and can be missed on the scan paths; the whole-year proofs are not affected by this.
3. **Solver tolerance** is scale-relative (`max|amount| × 1e-12`, tangent test `× 1e-9`) so results do not depend on the currency unit. At extreme rates (close to −100 % or very large) the *absolute* rate accuracy is limited (~1e-6).
4. **Sturm arithmetic** uses fixed 1e-9 thresholds on max-normalized coefficients (degree trimming, sign). Tested on well-separated roots up to degree 20; **not guaranteed** for clustered/near-repeated roots or high degree — which is why ambiguity is reported, not resolved.
5. **Ambiguity is propagated**: when the discriminant is inside its error bound, Sturm is not consulted and no "proven/confirmed/exact" wording is produced.
6. `ambiguousZero` (year-coefficient classification near its own noise floor) **cannot be reached from current public inputs**: whole-year dates are ≥1 day (1/365 yr) apart and same-date duplicates are summed before the polynomial is built, so each year bucket holds at most one entry and its ratio to its noise floor is the constant ≈4.5e11. Verified by `verify-ambiguouszero-reachability.mjs` (structural check + instrumented run). The guard is kept as defence in depth; if the check ever fails, a reachable ambiguity needs its own test.
7. Same-date near-cancelling entries are summed first; the module therefore treats their net as a real amount (information about the gross sizes is not retained).
8. IEEE-754 doubles throughout.

## 5. Opportunity wrapper (`opportunity-xirr.js`)
- Two independent views: **PROJECT** (unlevered, from `generateLegacyProjectCashEvents`) and **EQUITY** (from `computation.equityCF`, same series the annual engine uses). Debt events are excluded from both by design (closed-cash-system check in `verify-equity-reconciliation.mjs`).
- `acquisitionDate` is required and never defaulted; `acquisitionDateIsAssumed` defaults to true.
- **PROJECT cost guard**: `landCost` and `hardCostBase` must *both* be finite numbers (explicit `0` accepted; missing, `null`, `NaN`, non-number rejected) → otherwise `INSUFFICIENT_SOURCE_DATA`, never a computed rate.
- Solver soundness (`status`/`proof`) is reported separately from source-data quality (`sourceWarnings`). A clean `OK` does not mean the cashflows are free of legacy defects.
