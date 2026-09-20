# Phase 3B-5B Recovery — Refinance Timing and Debt Replacement

## Purpose

Move the two refinance timing fixtures from `BASELINE_ONLY` to a dated shadow implementation against the authoritative `src/core.js`:

- **T16** — refinance-close at the terminal year;
- **T17** — perpetual hold with periodic refinance.

`src/core.js` remains unchanged. The shadow layer reproduces legacy refinance calculations while maintaining an economically coherent debt ledger so terminal inconsistencies are visible instead of silently normalized.

## Event semantics

This slice adds a financing-only event type:

- `REFINANCE_FEE` — no project cash effect, no direct equity-event effect, no debt-balance effect, financing cash outflow only.

Refinance cycles are decomposed into:

- `REFINANCE_REPAYMENT` — repay the old facility balance;
- `REFINANCE_DRAW` — draw the replacement loan;
- `REFINANCE_FEE` — transaction fee on the new loan;
- `DISTRIBUTION` — positive net refinance proceeds available to equity.

The replacement debt remains outstanding in the canonical dated ledger after a refinance. This is intentional: an analysis boundary is not itself a debt-extinguishment event.

## Legacy calculations preserved

- Collateral value uses the same stabilized NOI, growth exponent, scenario-adjusted market cap rate, refinance LTV, and refinance cost percentage as `core.js`.
- Periodic refinance years use the same `yearsIntoOperation % intervalYears === 0` convention and exclude the terminal analysis year.
- Interest is independently recomputed from the legacy balance path and reconciled to `pnlRows.interestExpense` year by year.
- The shadow model mirrors the legacy rule that periodic debt is updated to the new refinance balance only when the computed refinance distribution is positive; if a future fixture produces a non-positive distribution and a different replacement balance, the inconsistency is surfaced as `LEGACY_REFINANCE_SHORTFALL_DOES_NOT_RESET_DEBT_TO_NEW_LOAN`.

## Findings surfaced

### T16 — terminal refinance-close

The legacy refinance calculation repays the old debt and sizes a new refinance loan, but `balloonBalanceAtExit` continues to report the **pre-refinance** debt payoff rather than the replacement loan. The canonical event ledger retains the replacement debt after the transaction.

Finding:

`LEGACY_REFINANCE_CLOSE_TERMINAL_DEBT_REPORTS_PRE_REFI_BALANCE`

### T17 — perpetual hold

The current `core.js` terminal analysis year executes the ordinary exit/payoff path even though the strategy is `perpetual_hold`. It then zeros the debt balance and subsequently adds a residual property-value mark to the book equity series.

This produces two explicit findings:

- `LEGACY_PERPETUAL_HOLD_HORIZON_RUNS_DEEMED_EXIT`
- `LEGACY_PERPETUAL_HOLD_RESIDUAL_VALUE_DOUBLE_COUNT`

The canonical shadow ledger does not create a terminal sale/payoff for perpetual hold. It retains the last refinance debt at the measurement horizon. The resulting residual equity (`property value - outstanding debt`) reconciles to the current legacy `NAV`, while the legacy book equity series adds the full property value after the deemed exit.

## Verification

Run:

```bash
node tests/domain/verify-legacy-refinance-events.mjs
node tests/domain/verify-financial-event-model.mjs
node tests/domain/verify-timing-baseline.mjs
npm run test:financial
npm run check:js
```

Expected coverage after this slice:

- T16: `IMPLEMENTED_WITH_FINDINGS`
- T17: `IMPLEMENTED_WITH_FINDINGS`

## Still not transaction-grade / remaining Phase 3B work

- direct-sale deferred buyer-bank collection timing is not yet represented as dated events;
- construction remains a legacy t0 cost decomposition because `core.js` still has no explicit canonical construction spend schedule;
- the surfaced refinance/perpetual-hold findings are not silently corrected in `core.js` by this recovery slice.
