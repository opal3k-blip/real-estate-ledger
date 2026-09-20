# Phase 3B-5A Recovery — VAT and Phased-Sale Cash Timing

## Purpose

Advance the `3B1-RECOVERY-V1` timing baseline from **BASELINE_ONLY** to an implemented dated shadow model for two legacy timing families:

- recoverable VAT working-capital timing;
- phased sale timing (off-plan escrow collection and serviced-land phased absorption), including proportional principal releases.

`src/core.js` remains authoritative and unchanged. This slice is parity/shadow logic, not a redesign of economics.

## VAT legacy semantics preserved

- Gross input VAT is funded in TPC at `t0` as `VAT_INPUT_PAYMENT`.
- Recoverable VAT is returned as `VAT_REFUND` at deterministic year-end dates using the exact legacy lag rules.
- No construction S-curve is invented. The refund source-spend convention mirrors the annual legacy formula.
- If the legacy horizon/formula fails to return all modeled recoverable VAT, the shadow layer leaves the difference visible as `LEGACY_VAT_RECOVERY_NOT_FULLY_RETURNED_WITHIN_HORIZON` rather than silently correcting it.

## Phased-sale legacy semantics preserved

For both off-plan and phased subdivision:

- tranche revenue -> `SALE_PROCEEDS` at the legacy collection/sale year-end;
- tranche exit/disposition cost -> `FEE` at the same date;
- tranche debt release -> `DEBT_REPAYMENT` with `repaymentKind=PROPORTIONAL_RELEASE`;
- legacy debt remains one `LEGACY_BLENDED_DEBT` facility;
- principal draws retain the same t0/mid-year conventions as the recovered financing shadow model.

Capitalized-interest phased sale is intentionally not generalized in this slice; it remains an explicit unsupported combination until its final-period payoff semantics are separately frozen and tested.

## Verification coverage

- T04 off-plan, no lag
- T08 off-plan, 1-year escrow lag
- T09 off-plan, 2-year lag/back-loaded
- T12 phased subdivision
- T10 VAT refund lag 0
- T11 VAT refund lag 2

Run:

```bash
node tests/domain/verify-legacy-cash-timing-events.mjs
```

The verifier reconciles tranche cash timing, principal releases, VAT t0 funding, VAT refunds, and current `projectCF` timing against the authoritative `src/core.js`.

## Still BASELINE_ONLY after this slice

- refinance-close;
- periodic refinance in perpetual-hold mode;
- direct-sale deferred buyer-bank timing (when applicable);
- a new transaction-grade construction spend schedule.
