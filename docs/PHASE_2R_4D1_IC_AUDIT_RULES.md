# Phase 2R-4D1 — protect IC audit creation

Baseline: afc9405b34ce8fbb30c3dbeedfd7b7ba1385af5f, plus the user's existing
uncommitted comments in firestore.rules and tests/rules/rules.test.mjs.
Those comments and all unrelated changes are preserved.

## Change

`icDecisions` client create/update/delete are now denied for every role, including
admin. Authorized team reads remain allowed. The trusted approveOpportunity callable
writes through Admin SDK; this change does not alter its calculation or transaction.

The emulator tests now reject fabricated audit records from Analyst, Senior IC,
Fund Manager and admin, verify the rejected document does not exist, and reject an
approved underwriting version using that nonexistent decision as its source.
Existing audit update/delete denials and authorized reads are checked for all four
roles; outsider and anonymous reads/creates are denied. The earlier positive test
for a version linked to a rules-disabled seeded decision remains in the suite.

Rules-disabled fixture setup is not evidence of callable integration or concurrency.
The earlier 53 Functions tests checked callable logic with fakes separately.

## Verification status

The user successfully ran the corrected pre-hardening Rules suite on the real
Firestore emulator on 2026-09-22 (exit 0). That run characterized the old permissions.
This new patch has been checked locally for JavaScript syntax and patch application.
Its new Rules expectations still require a Windows emulator run before commit.
No production deployment has been performed by this patch.

## Remaining scope

The historical review in PHASE_2R_4C_RULES_REVIEW.md remains the record of findings.
Its first item is addressed by this code change, pending emulator validation and
deployment. Opportunity creation with prefilled IC, the explicitly deferred admin
opportunity-IC bypass, fund creation with assetIds and ledger creation exceptions
remain open. Existing client-created IC audit records are not retroactively validated
or removed; any historical-data review requires a separate scoped task.

This patch does not make client-created underwriting metrics server-authored. It
closes fabrication of their source decision through the icDecisions create rule.
