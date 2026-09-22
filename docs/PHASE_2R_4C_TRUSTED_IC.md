# Phase 2R-4C: trusted IC recomputation

The client preview remains advisory. `approveOpportunity` reads the saved opportunity
inside its Firestore transaction and evaluates the canonical financial and IC engines.
Submitted readiness, metrics, audit identity and gate reasons cannot authorize a decision.
Transaction retries rerun the evaluation against the newly read document.

## Shared code and deployment

`src/domain/financial/financial-context.js` is a literal extraction of the existing
financial defaults and classification tables. Browser schema extenders remain in
`core.js`. No financial equations, thresholds or legacy economic behaviors change.

`functions/scripts/build-domain.cjs` copies the canonical domain files and the IC
presentation adapter into `functions/generated/`. This committed deployment bundle
has its own ESM package boundary; the Functions entry point remains CommonJS.
There are no imports outside `functions/` at runtime. The manifest identifies the
normalized source bytes by SHA-256. The loader verifies bundle integrity before use.
`check:domain` detects source/bundle drift. Do not edit generated files manually.

Regenerate with `npm --prefix functions run build:domain`; verify with
`npm --prefix functions run check:domain`. The existing Functions deploy script now
builds and tests first. Direct Firebase CLI deployment bypasses that script: run the
build and checks explicitly before any such deployment. This patch does not deploy.
The protected `firebase.json`, Rules, Monday modules and fake loader are unchanged.

## Decision policy and audit contract

- Allowed decisions remain approve, approve_conditions, revise, hold and reject.
- Approval requires server readiness, or boolean `override: true` with nonblank
  string reasons. A ready approval is not marked overridden merely because the
  client checked the box. A calculation failure or undefined core return metric
  cannot be overridden. DSCR null remains valid where the engine says not applicable.
- Reasons and conditions are validated. New conditions begin pending. Only known
  decision fields are accepted; user-submitted audit fields are discarded.
- Version 2 `icDecisions` records include the server evaluation time, engine digest,
  normalized input JSON, its SHA-256 digest, metrics, structured readiness and any
  invalid-metric names. Non-finite audit values use explicit `{$number: "NaN"}` or
  equivalent tags rather than silently becoming null. Input snapshots omit prior
  `ic` decision history, which is not a calculation input.
- `opportunity.ic.decisions` retains the UI fields, bilingual override reasons and
  links to the authoritative audit by decision ID, input digest and engine version.
  New `readiness` records have `readinessSchema: canonical-ic-v1`; existing historical
  decisions are not rewritten. Structured financial checks differ from the old
  presentation-only check objects. Audit text uses fixed English numeric formatting.
- Snapshot size is limited to 350,000 UTF-8 bytes. Loop-driving year/level fields must
  be finite numeric values between 0 and 100. Unsupported inputs fail explicitly;
  they are never clamped. These are server execution bounds, not new model defaults.
- The client-generated underwriting-version record remains a separate record; the
  server evaluation attached to `icDecisions` is the authority for this decision.

## Verification and remaining release gates

Run the financial frozen golden verifier for the browser and packaged server, the
existing 17-case IC reconciliation, the 25-case financial validation suite, Functions
tests and JavaScript syntax check. The Functions suite includes forged readiness,
override validation, decision/audit forgery, authorization, input failures, replay,
transaction retry callback behavior and an isolated deployment-package check.

The in-memory Firestore fake does not implement rollback or concurrent transaction
isolation. Tests assert rejections occur before writes; retry tests simulate a discarded
attempt. They do not certify Security Rules. Run the real Firestore Rules/emulator
suite separately and verify Functions in a controlled environment before production
deployment. Passing these local tests does not close those release gates.

Financial golden comparisons retain the existing absolute/relative tolerance of
1e-12. Known legacy timing/refinancing semantics are deliberately preserved. This
phase does not establish that the XIRR or wider financial roadmap is complete.
