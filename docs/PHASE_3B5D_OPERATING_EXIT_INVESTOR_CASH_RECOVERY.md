# Phase 3B-5D Recovery — Operating, Exit, and Investor Cash Views

## Why this slice exists

After 3B-5C, the dated model had project-cost, VAT, phased-sale, refinance,
direct-sale timing, debt, and interest adapters, but it still did **not** have a
single dated representation of ordinary annual operating cash, ordinary exit
cash, or positive investor distributions. That meant Phase 3B was not yet
eligible for closure even though the timing edge cases were individually
covered.

This slice closes that event-coverage gap without modifying `src/core.js`.

## Project cash semantics

`legacy-operating-exit-events.js` converts each legacy annual `pnlRows` entry
into deterministic year-end events:

- positive annual NOI -> `OPERATING_INCOME`;
- negative annual NOI -> `OPERATING_EXPENSE`;
- ordinary terminal/deemed exit value -> `EXIT_PROCEEDS`;
- ordinary exit/disposition costs -> `FEE` with `LEGACY_EXIT_COST` metadata.

The operating events deliberately use **net NOI cash**, rather than recreating
every P&L line item, because legacy formulas differ by asset class and a naïve
line-item reconstruction could double-count vacancy, property-management fees,
VAT operating leakage, Ejar fees, insurance, or NNN/hospitality mechanics.
Detailed accounting disclosure remains in `pnlRows`.

Phased sale cash is excluded here because 3B-5A already owns it.

## Investor cash semantics

`legacy-investor-cash-events.js` converts the authoritative legacy investor cash
series into dated events:

- negative period cash -> `EQUITY_CONTRIBUTION`;
- positive period cash -> `DISTRIBUTION`.

For `perpetual_hold`, the cash-only series (`equityCFCashOnly`) is used. The
unrealized terminal mark contained in legacy `equityCF` is **not** invented into
a cash distribution. 3B-5B separately surfaces the perpetual-hold terminal
legacy inconsistencies.

## Composed reconciliation

`legacy-dated-cashflow.js` provides one composition point for:

1. unlevered project cash; and
2. investor/equity cash.

`verify-legacy-dated-cashflow.mjs` runs all 19 frozen timing fixtures and proves
period-by-period reconciliation to current `src/core.js`.

This is still legacy shadow/parity logic. It does not solve the final material
transaction-grade timing gap: construction spend remains booked at `t0` in the
legacy core and requires an explicit new construction-spend schedule contract.
