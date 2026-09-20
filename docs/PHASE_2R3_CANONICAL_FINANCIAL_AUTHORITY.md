# Phase 2R-3 — Canonical Financial Runtime Authority

## Objective

Promote the Phase 2R-2 shadow-equivalent shared financial engine to the actual client runtime authority without changing financial economics or the public `core.js` API.

## Runtime authority after this phase

- `src/domain/financial/financial-engine.js` owns the financial implementation (`irr`, `npvAt`, `withDefaults`, `compute`).
- `src/core.js` imports `createFinancialEngine(...)`, injects the existing legacy classification/default dependencies once, and exposes compatibility bindings with the historical names.
- The duplicate financial implementation is removed from `src/core.js`.
- Existing callers continue to use `core.compute(...)`, `core.withDefaults(...)`, `core.irr(...)`, and `core.npvAt(...)` unchanged.

## VM/CommonJS compatibility

Several regression and Phase 3B reconstruction tests intentionally execute `src/core.js` as source text inside `vm.runInContext`. Native static `import` syntax cannot execute in that script-mode VM. `tests/helpers/core-vm-source.cjs` therefore builds the test-only VM source by:

1. reading the canonical shared engine,
2. removing only its `export` keyword for VM execution,
3. removing only the canonical engine import from `core.js`,
4. concatenating the shared engine before `core.js`, and
5. replacing the `core.js` export block with the historical `globalThis.__C` test surface.

This is a loader compatibility shim only; it does not contain or copy financial formulas.

## Non-goals

- No financial formulas or economic semantics are intentionally changed.
- No defaults/schema redesign is included.
- No server-side trusted recomputation or IC authority change is included.
- No Phase 3A validation redesign is included.
- No UI redesign is included.

## Required acceptance

- `node tests/domain/verify-financial-authority-cutover.mjs`
- `node tests/domain/verify-shared-financial-engine.mjs` — 20/20
- `node tests/domain/verify-financial-golden-master.mjs` — 20/20
- `npm run test:financial` — 24/24
- Phase 3B timing/dated-cash-flow regression suites remain green.
- `npm run check:js` passes.

The Phase 2R-1 frozen golden master remains the economic baseline; this phase changes authority wiring, not economics.
