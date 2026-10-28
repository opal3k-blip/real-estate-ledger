# Phase 2R-1 — Financial Golden Master Recovery

## Purpose

The historical Phase 2 extraction commits are not present in the recovered repository history. The surviving authoritative financial implementation is still `src/core.js`, while Phase 3B has now been reconstructed as dated/shadow event layers under `src/domain/financial/dated/`.

This recovery step freezes the current `src/core.js` economics **before** extracting a shared canonical financial engine again. It is deliberately add-only: it does not modify `src/core.js`, UI consumers, pricing, IC, Cloud Functions, or Firestore rules.

## Contract

`tests/domain/financial-golden-master.json` freezes 20 representative opportunity fixtures and a deterministic projection of the financial outputs that downstream consumers depend on, including:

- TPC / debt / equity / contributed equity
- interest / WACC / IRR / NPV / MOIC / PIC / payback
- DSCR / yield on cost / NAV / ROI
- fees and waterfall outputs
- project / equity cash-flow arrays
- selected P&L rows and IC financial checks
- draw, absorption, off-plan, VAT, refinance, and direct-sale timing-sensitive outputs

The verifier uses exact structural equality for strings, booleans, nulls, array lengths, and object keys, while finite numbers are compared with absolute and relative tolerances of `1e-12`. This removes non-economic IEEE-754 / JavaScript-runtime last-bit noise across supported Node runtimes without weakening economically meaningful drift detection. At a SAR 50 million output, the relative tolerance is SAR 0.00005 (far below one halala). Any extraction in later Phase 2R steps must preserve this baseline unless an intentional economics change is separately approved and versioned.

## Commands

```bash
node tests/domain/verify-financial-golden-master.mjs
npm run test:financial
npm run check:js
```

The capture script is intentionally separate and must **not** be run merely to make a failing verifier green:

```bash
node tests/domain/capture-financial-golden-master.mjs
```

Regenerating the baseline requires an explicit, reviewed economics decision.

## Recovery status after this step

- Phase 3B dated/shadow layer: preserved.
- Current financial economics: frozen from real `src/core.js`.
- Shared canonical financial extraction: **not yet complete**; next recovery step.
- Universal validation / server-side trusted IC recomputation: **not yet complete**; must follow the shared engine.
