# Phase 3B-1 Recovery — Annual Timing Baseline

## Purpose

The historical Phase 3B-1 commit was not recoverable from the repository. This document records a fresh baseline rebuilt directly against the authoritative `src/core.js` present in the recovered repository.

This baseline is **not represented as the lost historical artifact**. It is a new frozen reference (`3B1-RECOVERY-V1`) used to protect current legacy timing while transaction-grade dated events are rebuilt.

## Frozen scope

`tests/domain/timing-baseline.json` freezes 18 timing fixtures. For each fixture it records:

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

The baseline deliberately distinguishes current dated-event implementation from legacy behavior that is only frozen for later reconstruction.

Already covered by the rebuilt dated shadow model:

- ordinary development horizons;
- construction draw schedules;
- cash and capitalized interest (with the explicit final-period capitalization finding);
- landbank annual debt timing;
- follow-on equity contributions;
- legacy blended debt principal behavior.

Frozen here but still **BASELINE_ONLY** for later event implementation:

- off-plan tranche / escrow timing;
- VAT recovery timing;
- phased subdivision releases;
- refinance-close;
- periodic refinance in perpetual-hold mode.

No S-curve or intra-year construction spend schedule is invented. The legacy core still places project cost funding at t0; transaction-grade construction-spend timing requires a new explicit input model and separate governance decision.

## Verification

```bash
node tests/domain/verify-timing-baseline.mjs
```

The verifier requires literal deep equality against the frozen artifact and also asserts horizon consistency (`CF length = totalYears + 1`, `P&L rows = totalYears`).
