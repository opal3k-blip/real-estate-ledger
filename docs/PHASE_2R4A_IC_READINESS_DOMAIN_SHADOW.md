# Phase 2R-4A — IC Readiness Domain Extraction (Shadow Mode)

## Purpose

Reconstruct the deterministic IC-readiness dependency chain as shared domain code before any trusted server-side cutover.

This phase deliberately **does not** change runtime authority in `src/features/*` and **does not** change `functions/index.js`. The existing browser feature implementation remains authoritative while the new domain engines are executed in shadow verification.

## Extracted deterministic domain engines

- `src/domain/due-diligence/dd-engine.js`
  - canonical DD item definitions
  - default DD item dictionary
  - DD completion / critical-pending statistics
- `src/domain/data-quality/data-quality-engine.js`
  - field definitions
  - deterministic path reading and filled-value rules
  - data-quality statistics
- `src/domain/evidence/evidence-engine.js`
  - decision-relevant evidence field definitions
  - source / verification coverage
  - weak and stale evidence classification
- `src/domain/planning/planning-engine.js`
  - planning feasibility (floors, setbacks, footprint)
- `src/domain/financial/max-acquisition-price.js`
  - canonical reverse pricing search consuming the canonical financial `compute` function
  - IRR + DSCR constraint semantics preserved exactly
- `src/domain/ic/ic-readiness-engine.js`
  - deterministic Financial / DD / Governance / Planning / Pricing gates
  - structured reasons: `{ gate, code, params }`

The new domain engine does not format UI strings. Localization/presentation remains outside the domain boundary.

## Shadow equivalence proof

`tests/domain/verify-ic-readiness-shadow.mjs` compares the new domain chain against the current feature implementation across 17 targeted fixtures covering:

- fully ready opportunity
- Equity IRR, Project IRR, MOIC, and DSCR failures
- critical and incomplete DD
- critical-missing and low-completeness data quality
- unsourced, insufficiently covered, insufficiently verified, weak, and stale evidence
- planning infeasibility
- current price above maximum acquisition price
- pricing infeasible even at zero land cost

For each fixture the verifier reconciles:

- DD statistics
- Data Quality statistics
- Evidence coverage statistics
- Maximum Acquisition Price output
- IC ready/not-ready result
- all gate states and gate metrics
- reason ordering, gate assignment, and semantic reason codes

Numeric comparisons use deterministic absolute/relative tolerance `1e-12`; structural drift remains strict.

## Authority state after Phase 2R-4A

- Browser/runtime IC readiness authority: **unchanged** (`src/features/ic-decision-gate.js`).
- Trusted server recomputation: **not yet enabled**.
- New shared domain engines: **shadow-proven equivalents**, ready for a later client cutover and server packaging step.
- `approveOpportunity` must continue to be treated as having the temporary client-readiness trust gap until the later server cutover is complete.

## Acceptance

```bash
node tests/domain/verify-ic-readiness-shadow.mjs
npm run test:financial
npm run check:js
```
