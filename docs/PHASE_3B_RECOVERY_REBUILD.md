# Phase 3B Recovery Rebuild — Dated Financial Events / Financing Shadow Model

## Status

This recovery work is additive and leaves `src/core.js` unchanged. It rebuilds the missing Phase 3B prerequisites directly against the repository snapshot whose financial baseline is frozen in `tests/domain/financing-baseline.json`.

### Rebuilt components

- **3B-2 FinancialEvent contract**: deterministic IDs, strict `YYYY-MM-DD`, non-negative event magnitudes, semantic sign metadata, debt-ledger replay.
- **3B timeline primitives**: mandatory `acquisitionDate`; deterministic clamped year/month arithmetic; no hidden current date.
- **3B-3 legacy project-cost generator**: semantic decomposition of the legacy t0 TPC cost. It deliberately does **not** invent a construction S-curve because `core.js` has no canonical spend schedule.
- **3B-4B financing funding/principal shadow model**:
  - one `LEGACY_BLENDED_DEBT` facility;
  - senior/mezz are sizing metadata only;
  - `limitScope = PRINCIPAL_DRAWS_ONLY`;
  - debt draws reconcile to legacy `debt`;
  - every negative legacy `equityCF` creates an `EQUITY_CONTRIBUTION` event;
  - therefore `Σ EQUITY_CONTRIBUTION = contributedEquity`, not `equity`;
  - interest is deliberately excluded from 4B.
- **3B-4C interest shadow model**: interest is recomputed from debt balances / draw schedule / rate and reconciled year-by-year to `pnlRows.interestExpense`.

## Governance preserved

### GOV-DEBT-001

Legacy senior/mezz are sizing labels, not separate facility ledgers. No fictional senior/mezz closing balances are produced.

### GOV-DEBT-002

Legacy debt limit means principal draw limit only. Capitalized interest may raise outstanding debt above that amount. A future `OUTSTANDING_BALANCE` commitment is a separate economic model and is not introduced here.

### Equity sizing vs funded equity

`equity` remains initial/base sizing metadata. `contributedEquity` is cumulative actual equity funding represented by every negative `equityCF` period. F04/F05 therefore create multiple dated contribution events.

## Newly surfaced legacy defect: final-period capitalized interest

The shadow event ledger confirms a defect in the current `core.js` normal exit path: when construction interest is capitalized in the final project year, `interestExpense` is calculated but `debtPayoffAtExit` excludes that same year's capitalization; the loop then sets `remainingDebt` to zero because it is the final year.

The dated shadow model does **not** erase this amount. It leaves a residual debt balance and emits finding:

`LEGACY_FINAL_PERIOD_CAP_INTEREST_NOT_PAID`

For fixture `T06-capitalized-interest`, the residual equals the final-period capitalized interest. This is intentionally a surfaced reconciliation finding, not a silent rewrite of the authoritative legacy engine.

## Explicit exclusions

This recovery slice does not yet implement:

- refinance events;
- phased-subdivision debt releases;
- VAT timing events;
- distributions;
- true multi-facility senior/mezz ledgers;
- a canonical construction spend schedule.

Those must be deliberate later steps, not inferred from missing legacy data.

## Verification commands

```bash
node tests/domain/verify-financial-event-model.mjs
node tests/domain/verify-project-event-generators.mjs
node tests/domain/verify-financing-baseline.mjs
node tests/domain/verify-legacy-financing-events.mjs
npm run test:financial
```
