# Phase 3B-1 Recovery — Annual Timing Baseline

## Purpose

The historical Phase 3B-1 commit was not recoverable from the repository. This document records a fresh baseline rebuilt directly against the authoritative `src/core.js` present in the recovered repository.

This baseline is **not represented as the lost historical artifact**. It is a new frozen reference (`3B1-RECOVERY-V1`) used to protect current legacy timing while transaction-grade dated events are rebuilt.

## Frozen scope

`tests/domain/timing-baseline.json` freezes 20 timing fixtures. For each fixture it records:

- total / construction / operation horizon;
- t0 plus deterministic annual and half-year date mapping from an explicit `2026-01-01` acquisition date;
- project and equity cash-flow arrays;
- annual P&L phase / exit markers;
- debt draw schedule;
- off-plan collection schedule;
- phased-subdivision absorption schedule;
- VAT refund lag metadata;
- direct-sale deferred timing metadata.

The capture is deterministic: there is no generated timestamp and no use of the current date.

## Coverage status

The recovered dated model now covers every frozen fixture family used for Phase 3B closure. No fixture remains `BASELINE_ONLY`.

Implemented coverage includes:

- ordinary development horizons;
- construction draw schedules;
- cash and capitalized interest, including the explicit normal-exit final-period finding;
- landbank annual debt timing;
- follow-on equity contributions;
- legacy blended debt principal behavior;
- off-plan tranche / escrow timing;
- phased subdivision releases;
- VAT recovery timing;
- refinance-close and periodic refinance, with legacy terminal findings surfaced;
- direct-sale buyer-bank deferred collection;
- off-plan phased sale with capitalized construction interest and final payoff reconciliation.

The legacy core still keeps project cost at `t0`. Phase 3B-6 therefore adds a separate explicit `CONSTRUCTION_SPEND_V1` contract for transaction-grade construction timing without fabricating an S-curve.

## Verification

```bash
node tests/domain/verify-timing-baseline.mjs
```

The verifier requires literal deep equality against the frozen artifact and also asserts horizon consistency (`CF length = totalYears + 1`, `P&L rows = totalYears`).
