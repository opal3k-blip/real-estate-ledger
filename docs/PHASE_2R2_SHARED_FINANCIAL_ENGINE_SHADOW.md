# Phase 2R-2 — Shared Financial Engine Shadow Extraction

## Purpose

Recover the lost Phase 2 shared-domain financial extraction without changing current economics.

Phase 2R-1 froze the current `src/core.js` financial outputs across the 20 timing fixtures. Phase 2R-2 now extracts the same calculation body into:

`src/domain/financial/financial-engine.js`

This step is deliberately **shadow-only**. `src/core.js` remains the production/client authority in this commit. The extracted engine is not wired into application execution yet.

## Recovery contract

The shared engine is a literal extraction of the current `irr`, `npvAt`, `withDefaults`, and `compute` logic. It receives legacy context as explicit dependencies:

- `blankOpportunity`
- `TIERS`
- `USE_TYPES`
- `SITE_FACTORS`
- `DEV_REFI_STRATEGY_KEY`
- `isResidentialUseType`

This avoids inventing a second source of defaults or classification assumptions during recovery.

## Equivalence proof

`tests/domain/verify-shared-financial-engine.mjs` executes all 20 fixtures through both:

1. current `src/core.js` `compute()`
2. extracted shared-domain `createFinancialEngine(...).compute()`

It then requires the shared result to match both the current core result and the frozen Phase 2R-1 golden master with the same deterministic absolute/relative numeric tolerance (`1e-12`) used by the golden-master verifier.

Structural drift remains strict: object keys, array lengths, strings, booleans, nulls, and non-finite values must match exactly.

## Authority state

After this commit:

- `src/core.js` remains runtime authority.
- `src/domain/financial/financial-engine.js` is a proven shadow equivalent.
- No financial economics are intentionally changed.
- No UI redesign, validation redesign, IC authority change, or server cutover is included.

A later recovery step may cut consumers over to the shared engine only after this shadow equivalence remains green.

## Acceptance commands

```bash
node tests/domain/verify-shared-financial-engine.mjs
node tests/domain/verify-financial-golden-master.mjs
npm run test:financial
npm run check:js
```

Expected:
- Shared engine shadow reconciliation: 20/20
- Financial golden master: 20/20
- Financial regression suite: 24/24
- JavaScript syntax check: PASS
