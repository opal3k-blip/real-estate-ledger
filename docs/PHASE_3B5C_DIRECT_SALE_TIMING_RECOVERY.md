# Phase 3B-5C Recovery — Direct-Sale Buyer-Bank Collection Timing

## Purpose

Move the remaining legacy direct-sale buyer-financing timing behavior into the dated shadow model without changing `src/core.js`.

The current legacy engine does **not** defer gross sale proceeds. Instead, after calculating terminal equity cash after exit costs and debt payoff, it defers a proportional share of that **net terminal cash** according to `strategy.directSale.bankFinancedPct`, then collects the same amount after `collectionLagYears`.

The dated shadow model preserves that exact convention rather than inventing a gross buyer receivable or bridge-financing model.

## Event semantics

Two timing-only event types are added:

- `DIRECT_SALE_DEFERRAL` — removes the deferred net cash share from both project and equity cash at the exit date;
- `DIRECT_SALE_COLLECTION` — restores the same amount to both project and equity cash at the buyer-bank collection date.

The pair is net-zero over the full life of the investment; only timing changes.

## Frozen timing coverage

The recovery timing baseline now contains 19 fixtures. New fixture:

- **T19** — 60% bank-financed direct-sale buyers with a two-year collection lag.

T19 explicitly proves that the cash-flow arrays may extend beyond `totalYears` when buyer-bank collection occurs after the operating/exit horizon. The baseline verifier therefore uses:

`cash horizon = max(totalYears, directSaleDeferredYear)`

while P&L remains bounded by `totalYears`.

The dated-coverage classifications for T04/T08/T09/T10/T11/T12 are also updated from stale `BASELINE_ONLY` labels to `IMPLEMENTED`, reflecting the already verified 3B-5A implementation.

## Verification

```bash
node tests/domain/verify-legacy-direct-sale-events.mjs
node tests/domain/verify-financial-event-model.mjs
node tests/domain/verify-timing-baseline.mjs
npm run test:financial
npm run check:js
```

## Remaining Phase 3B structural gap

Direct-sale deferred timing is no longer a gap after this slice.

The remaining material timing gap is construction cash timing: the authoritative legacy core still books the entire project cost at `t0` and exposes no canonical construction spend schedule. Transaction-grade construction timing therefore requires an explicit new input contract and governance decision; it must not be inferred from the legacy annual engine or fabricated as an S-curve.
