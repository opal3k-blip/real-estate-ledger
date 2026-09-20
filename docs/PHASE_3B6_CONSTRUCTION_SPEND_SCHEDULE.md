# Phase 3B-6 — Explicit Construction Spend Schedule Contract

## Purpose

The legacy `src/core.js` books project cost funding at `t0` and has no canonical construction-spend curve. Phase 3B must not infer an S-curve from debt draws, construction duration, VAT logic, or market convention. This slice therefore adds a strict, explicit transaction-grade construction-spend contract while keeping every legacy parity path unchanged.

## Contract

Version `CONSTRUCTION_SPEND_V1` uses absolute dated shares:

```js
{
  version: 'CONSTRUCTION_SPEND_V1',
  basis: 'HARD_COST_INCLUDING_CONTINGENCY',
  entries: [
    { date: '2026-04-15', share: 0.10 },
    { date: '2026-10-15', share: 0.25 },
    { date: '2027-04-15', share: 0.35 },
    { date: '2027-10-15', share: 0.30 },
  ]
}
```

Governance rules:

- no schedule is fabricated when the input is missing;
- shares are decimal fractions and must sum to 1 within tolerance;
- malformed shares are rejected rather than silently normalized;
- dates must be strict `YYYY-MM-DD` values;
- dates cannot precede acquisition or exceed modeled construction completion;
- duplicate dates are rejected because this is the aggregate construction-spend schedule, not a work-package register;
- land acquisition and legacy fixed/transaction fees remain at acquisition;
- hard cost and contingency follow only the supplied schedule;
- the same dates drive construction VAT payments, and recoverable VAT refunds are dated from the actual payment dates using the configured refund lag.

## One cost decomposition

`project-cost-components.js` is now the single decomposition used by the legacy t0 project-cost adapter and the scheduled construction adapter. This prevents the two paths from drifting on land, hard cost, contingency, fees, or VAT-excluded TPC reconciliation.

## Legacy parity remains intact

`generateLegacyProjectCostEvents()` still keeps all legacy project costs at `t0`. Existing 19-fixture dated-cash reconciliation and the 24-test financial suite therefore remain unchanged. The new schedule is opt-in and additive; it is the explicit transaction-grade path, not a rewrite of `src/core.js`.

## Transaction-grade construction view

`generateTransactionGradeConstructionEvents()` composes:

1. scheduled land / fee / hard-cost / contingency events; and
2. scheduled VAT input/refund events.

Gross project outflow (before VAT refunds) must reconcile to legacy `TPC`, while cost timing is controlled only by the explicit schedule.

## Verification

```bash
node tests/domain/verify-construction-spend-schedule.mjs
node tests/domain/verify-project-event-generators.mjs
node tests/domain/verify-legacy-dated-cashflow.mjs
npm run test:financial
npm run check:js
```

This closes the material Phase 3B construction-timing input gap without inventing an S-curve or changing the authoritative legacy engine.
