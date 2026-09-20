# Phase 3B-7 — Phased-Sale Financing Completeness and Phase 3B Closure

## Why this slice exists

The Phase 3B-5A phased-sale adapter originally rejected the valid combination
`interestDuringConstruction = "capitalized"`. That combination is supported by
`src/core.js` and is user-configurable for development opportunities, so leaving
it unsupported would make the dated model incomplete.

This slice removes that closure blocker while preserving legacy parity.

## Phased-sale financing semantics

`generateLegacyPhasedSaleEvents()` now reconstructs, year by year:

- principal debt draws using the existing legacy draw convention;
- cash-pay construction interest as `INTEREST_PAYMENT`;
- capitalized construction interest as `INTEREST_CAPITALIZED`;
- phased sale proceeds and disposition costs;
- proportional principal releases before the terminal year;
- terminal repayment of the remaining original principal; and
- terminal repayment of all accumulated capitalized interest.

The final repayment is reconciled to the authoritative legacy
`pnlRows[].debtPayoffAtExit`. The event ledger must close to zero for phased-sale
fixtures.

## New frozen fixture

`T20-offplan-capitalized-interest` adds a two-year off-plan development with
capitalized construction interest. It proves that:

- annual interest matches legacy P&L year by year;
- capitalized interest increases the debt ledger rather than investor cash in
  the construction years;
- all capitalized interest is repaid at the final phased close;
- the final canonical repayment equals legacy `debtPayoffAtExit`; and
- both project cash and investor cash still reconcile period by period.

The recovery timing baseline now contains **20 fixtures** and the verifier
rejects any fixture classified as `BASELINE_ONLY`.

## Phase 3B closure scope

With this slice plus 3B-6, Phase 3B is closed for the intended scope:

1. deterministic `FinancialEvent` contract and explicit dates;
2. frozen legacy timing baseline;
3. legacy project-cost decomposition;
4. equity contribution and blended-debt principal events;
5. actual-balance legacy interest reconciliation;
6. VAT, off-plan, subdivision, refinance, direct-sale and operating/exit timing;
7. investor contribution/distribution dated cash views;
8. explicit transaction-grade construction spend schedule contract with no
   fabricated S-curve; and
9. phased-sale capitalized-interest financing parity.

## Known findings retained intentionally

Closure does **not** silently repair the following legacy behaviors:

- `LEGACY_FINAL_PERIOD_CAP_INTEREST_NOT_PAID` for the normal non-phased final
  construction-period capitalization defect;
- `LEGACY_REFINANCE_CLOSE_TERMINAL_DEBT_REPORTS_PRE_REFI_BALANCE`;
- `LEGACY_PERPETUAL_HOLD_HORIZON_RUNS_DEEMED_EXIT`;
- `LEGACY_PERPETUAL_HOLD_RESIDUAL_VALUE_DOUBLE_COUNT`.

They remain explicit reconciliation findings until a later deliberate economic
model change is approved.

## Explicitly deferred enhancements, not Phase 3B gaps

- true independent senior/mezzanine facility ledgers;
- outstanding-balance facility commitments that cap capitalized interest;
- migration of `src/core.js` itself onto the dated event engine;
- portfolio-level Gross XIRR / advanced analytics (Phase 4).

The `UNSUPPORTED_3B*` guards that remain in specialized legacy modules are
routing guards: normal principal/interest generators reject phased-sale or
refinance cases because those cases are owned by their dedicated phased-sale or
refinance adapters. They are not frozen-fixture coverage gaps.

## Closure verification

```bash
node tests/domain/verify-financial-event-model.mjs
node tests/domain/verify-timing-baseline.mjs
node tests/domain/verify-project-event-generators.mjs
node tests/domain/verify-financing-baseline.mjs
node tests/domain/verify-legacy-financing-events.mjs
node tests/domain/verify-legacy-cash-timing-events.mjs
node tests/domain/verify-legacy-refinance-events.mjs
node tests/domain/verify-legacy-direct-sale-events.mjs
node tests/domain/verify-legacy-dated-cashflow.mjs
node tests/domain/verify-construction-spend-schedule.mjs
npm run test:financial
npm run check:js
```
