# XIRR-P — portfolio Net XIRR computation contract (indicative)

Module: `src/domain/financial/xirr/portfolio-xirr.js` (`computePortfolioNetXirr`). Solver: the **shared** `computeOpportunityXirr` (see `XIRR_OPPORTUNITY_COMPUTATION_CONTRACT.md`); nothing here re-implements root finding.
Status: **indicative.** Shown in Portfolio Intelligence and the Command Center. No IC gate, report, server function or alert reads it. Gross IRR, TVPI and every other portfolio figure are unchanged.

## 1. Inputs
| input | source in the ledger | rule |
|---|---|---|
| `asOfDate` | explicit input of the pure function. The UI passes the calendar day in **Asia/Riyadh** (fixed UTC+3; injectable clock, tested around the 21:00Z day boundary) and says so with `ASOF_DATE_IS_CALCULATION_DATE`. | required real `YYYY-MM-DD`; never defaulted inside the module. Terminal NAV is placed here. |
| capital calls | `capitalCalls[].callDate`, `.amount`, `.status` | only `status === 'paid'` |
| distributions | `distributions[].distDate`, `.amount`, `.status` | only `status === 'paid'` |
| terminal NAV | `Σ fundLedgerSummary(f).totalValue` = Σ `equity × MOIC` of linked, non-blocked assets; declared source `UNDERWRITING_EQUITY_X_MOIC`, no valuation date | finite ≥ 0, complete, **and with an accepted basis (§6)** |

`callDate` / `distDate` are the ledger **record dates** used here. The code does not establish that they are the actual payment or settlement dates (there is no separate paid-on field), and every computed result says so (`LEDGER_DATES_ARE_RECORD_DATES`). Pending, approved, declared and waived records are ignored entirely (their fields are not even validated).
**Ids are unique per collection only.** A capital call and a distribution may share an id, so every matching, cancellation and issue reference is keyed by kind + id (`capitalCall:X`, `distribution:X`); a repeated id inside one collection is ambiguous for reversal matching and blocks (`DUPLICATE_RECORD_ID`).

## 2. Flows
Call ⇒ outflow `−amount`; distribution ⇒ inflow `+amount`; terminal NAV ⇒ inflow at `asOfDate`. The sign comes from the stored amount — **no `abs()`**. Paid records dated after `asOfDate` are not used (counted in `excludedAfterAsOf`, warning `FLOWS_AFTER_ASOF_EXCLUDED`).

## 3. No substitution
A paid record whose amount is missing / non-numeric (`INVALID_AMOUNT`) or whose date is missing / not a real calendar date (`INVALID_DATE`) makes the result `INSUFFICIENT_SOURCE_DATA`. A missing amount is never read as 0 and a bad date is never replaced by a default or today. A negative amount without `reversalOfId` is rejected (`NEGATIVE_AMOUNT_WITHOUT_REVERSAL`). An explicit `0` is accepted.

## 4. Reversal entries (what the ledger actually stores)
`reverseTransaction` (functions/index.js) writes a **copy of the original** with `reversalOfId`, `amount = −original amount`, the **same status** and the **same `callDate`/`distDate`**; `linkedCommitmentId` is cleared, `inKindAssetId` is kept. There is no cash-refund record type and no field holding the date a reversal was made.
- Admissible: reversal of a paid, non-reversal original of the **same record kind and fund**, exact negation, **same date**, and the original is used by **exactly one** reversal. It is a correction of a wrong entry: the pair is removed from the flows (identical result and `cashflowCount` to the ledger without the pair, verified by test).
- Anything else (original missing or of another record kind, other fund, not paid, itself a reversal, not an exact negation, **different date**, original reversed more than once, or a reversal dated after `asOfDate` whose original is inside the window) ⇒ `INSUFFICIENT_SOURCE_DATA` / `REVERSAL_MEANING_UNRESOLVED` with the specific cause in `issues[].detail`. The module does **not** guess whether that is a correction or an actual later cash return, and it chooses no policy for it.

## 5. In-kind capital calls
A correctly cancelled in-kind pair (original + valid reversal, §4) no longer contributes and does **not** block the remaining flows. Calls with `inKindAssetId` or `linkedCommitmentId` (or reversals of such, resolved through the original, mirroring `core.isInKindCapitalCall`) are in the ledger's `paidIn` but are not cash, and the ledger states no valuation basis for their amount. Default policy `REFUSE`: `INSUFFICIENT_SOURCE_DATA` / `IN_KIND_VALUE_BASIS_UNRESOLVED`. The option `inKindPolicy: 'INCLUDE_AT_LEDGER_AMOUNT'` exists for a later decision; the UI does not pass it.

## 6. NAV completeness
If any asset linked to any fund is excluded from the NAV — blocked by `oppMetricGuard` (`ASSET_BLOCKED`), no opportunity record (`ASSET_RECORD_MISSING`), compute failure (`ASSET_COMPUTE_FAILED`) or non-finite MOIC (`ASSET_VALUE_NOT_COMPUTABLE`, which `core` silently values at 0) — the fund contributions remain in the flows while the NAV is understated, so **no portfolio rate is shown** (`NAV_INCOMPLETE`, assets in `navIssues`). No partial-portfolio rate is computed.
### NAV basis (`NAV_BASIS_UNRESOLVED`)
`equity × MOIC` is **not** a remaining/current value. `MOIC = Σ positive equity cash flows of years 1..N ÷ cash invested` (financial-engine.js), i.e. total projected proceeds over the whole life of the investment — undiscounted, undated, including operating distributions and the exit — and `equity` is the initial equity. The code itself calls it “القيمة الإجمالية المُتوقَّعة … وليس تقييماً مستقلاً”. Used as a terminal value dated `asOfDate` it would double-count distributions already in the ledger and would treat a future exit as a present value. The code gives no reliable definition of a residual value, and no subtraction is guessed.
The module therefore accepts only `nav.basis === 'RESIDUAL_VALUE_AS_OF_DATE'`. **The absence of linked assets is not accepted as proof of a zero residual value** (the portfolio may hold unlinked holdings). Portfolio Intelligence passes `UNDERWRITING_TOTAL_PROJECTED_EQUITY_PROCEEDS` (assets linked) or `NO_LINKED_ASSETS_RESIDUAL_VALUE_UNKNOWN` (none linked) — both unresolved ⇒ no rate.
**Consequence: the current UI shows no Net XIRR rate for any portfolio.** The calculation is protected and tested (the tests declare a residual basis through `netXirrInput` to verify the numeric wiring); enabling a rate needs valuation data later (a remaining value at a stated date), supplied with `basis: 'RESIDUAL_VALUE_AS_OF_DATE'`, a `source` and ideally a `valuationDate`.
### Warnings tied to their source
Source warnings are attached to **every** result, computed or blocked, so both views can always show them with the as-of date: `LEDGER_DATES_ARE_RECORD_DATES`; by NAV source — `NAV_IS_UNDERWRITING_ESTIMATE` only when the declared source is `UNDERWRITING_EQUITY_X_MOIC`, `NAV_SOURCE_DECLARED` for any other declared source, `NAV_SOURCE_UNDECLARED` if none; `NAV_VALUATION_DATE_UNKNOWN` unless a real `valuationDate` is supplied (then it is echoed as `navValuationDate`); `ASOF_DATE_IS_CALCULATION_DATE` when the day was taken from the clock; `FLOWS_AFTER_ASOF_EXCLUDED` when applicable. `asOfDate` is not evidence that a NAV is current.

## 7. Output
The solver's full result is spread into the output (`status`, `rate`, `proof`, `method`, `roots`, `crossingRates`, `tangentCandidates`, `candidateRates`, `reason`, …) plus `asOfDate`, `asOfDateSource`, `cashflowCount`, `navValue`, `navSource`, `navValuationDate`, `excludedAfterAsOf`, `sourceWarnings`. For source-data failures: `status: 'INSUFFICIENT_SOURCE_DATA'`, `reasonCodes`, `issues[]` (ids are kind-qualified), optional `navIssues`, plus `asOfDate`/`sourceWarnings`; **no `rate` key**.
UI (Portfolio Intelligence **and** Command Center, same helper): a percentage appears only when `status === 'OK'`; every status shows the as-of date and the source warnings; non-OK statuses show their name with reasons and any roots/candidates ("not an approved return") in a collapsed block. `netIRR` (kept for compatibility) is the rate when OK and `null` otherwise.

## 8. Intended differences from the previous portfolio solver
| item | previous | now |
|---|---|---|
| reversal sign | `±Math.abs(amount)` turned a reversal into a second outflow / inflow | sign from the record; same-date reversal cancels its original |
| multiple roots | silently returned one | `POSSIBLE_MULTIPLE_ROOTS`, no main rate, roots kept |
| bad date / amount | skipped / read as 0 | `INSUFFICIENT_SOURCE_DATA` |
| tolerance | absolute `|NPV| < 1` | scale-relative (shared solver) |
| incomplete NAV | rate shown | no rate |
| in-kind calls | counted as outflow | refused (policy pending); a fully cancelled pair does not block |
| NAV used as terminal value | `equity × MOIC` (total projected proceeds) | refused until a residual-value definition exists |
| calculation date | `todayStr()` (UTC) | Asia/Riyadh calendar day, explicit `asOfDate` input |
| failure reasons | all `null` | named status + reasons |
Agreement with the previous solver is **not** a correctness criterion; correctness rests on closed forms, an independent bisection and the shared solver (`verify-portfolio-xirr.mjs`).
