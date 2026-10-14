# Phase 2R-4D4-B — separate in-kind pledge from execution; fix deployable-liquidity economics

Baseline: 833521fd299ae5af8c5e9f54a6efc178503b7197. Committed as f22859b3b96763890485dcc9a20a7cec808c636a, pushed to origin/p0-shared-domain-engine-extraction (833521f..f22859b). Direction confirmed by the user before implementation: pledge-only commitment save, a separate documented execution step, cash-only deployable liquidity, the landowner's cash contribution as an independent commitment, and no automatic conversion of legacy records.

## Scope
Saving an in-kind commitment now records only the pledge (`commitments` document) — it no longer auto-creates a `paid` capital call the moment the form is saved. A new explicit action ("Execute Transfer") on each unexecuted in-kind commitment opens a small form capturing the actual transfer date and the asset received for; on confirm it creates the linked `capitalCalls` record (`linkedCommitmentId`, `status:'paid'`, `amount` pinned to the commitment's agreed value — not independently editable, so there is no new channel for an unapproved value to enter the ledger). `firestore.rules`' `linkedCommitmentOk` now additionally requires a real `callDate` and an `inKindAssetId` that resolves to an existing `opportunities` document, so an in-kind transfer can no longer be claimed without a transfer date and a real receiving asset.

Deployable liquidity (both the `linkAssetToFund` Cloud Function and the client's `fundLedgerSummary` dashboard figure) now excludes any capital call carrying `linkedCommitmentId` — land value can no longer register as spendable cash. `paidIn`/`called`/`DPI` at both fund and investor level are unchanged and still include in-kind paid-in capital, preserving existing PIC/DPI/TVPI reporting. No data migration was needed: the exclusion is based on the pre-existing `linkedCommitmentId` field, which every historical in-kind transfer (old auto-created or new explicitly executed) already carries, so the fix applies to legacy records automatically without touching them.

Separately, `transactions` create now requires the `by` field to match the authenticated caller's email (`transactionAttributionHonest`, mirroring the existing `attributionHonest()` pattern for opportunities) — closing a gap where 2R-4D4-A's `transactionMatchesRecord` check verified the referenced ledger record was real but never verified who was claiming to have logged it.

The landowner's cash contribution (~SAR 23.68m) needs no code change: it is simply a second, independent `commitments` document (`contributionType:'cash'`) for the same investor, which the existing multi-commitment-per-investor data model already supports; it becomes `paid` only through the normal pending → approved → paid gate (`postCapitalCall` / approve / mark-paid), never auto-generated.

No change to `postCapitalCall`, `transitionLedgerRecord`, `reverseTransaction`, or `approveOpportunity`. Commitments remain fully immutable (`allow update, delete: if false`, unchanged from an earlier phase) — editing or deleting a commitment after save is not possible regardless of contribution type.

## Verification
`tests/rules/rules.test.mjs` extended: the in-kind success fixture now requires `inKindAssetId` and `callDate`, with new failing cases for a missing asset reference, a reference to a non-existent `opportunities` document, and a missing transfer date. Added `TXN-FORGED-BY` (a `transactions` create whose `by` doesn't match the caller — now denied) and, per the user's explicit flag, two tests (`TXN-DUPLICATE-1`/`-2`) that document — not fix — the pre-existing gap that `transactionMatchesRecord` does not prevent two different `transactions` documents both referencing the same real ledger record; both succeed on purpose, with the test comment stating exactly what this does and does not cover.

Full suite run against the real Firestore emulator on the user's machine: all tests passed, exit code 0. `node --check` passed on `functions/index.js` and `src/core.js` before commit.

## Remaining boundaries
The Cloud Function change to `linkAssetToFund` needs a Firebase Functions deployment to take effect in production — this phase is code-and-tests only, not deployed, matching Phase 5's own gate on deployment approval. Until deployed, production's deployable-cash check still includes in-kind capital.

The duplicate-`transactions`-record gap flagged above is deliberately left open: preventing two audit entries for the same event needs either a deterministic document ID (keyed by relatedId+action) or a dedicated uniqueness mechanism, which is a large enough change to warrant its own phase rather than folding into this one.

Execution amount is pinned to the commitment's original agreed value — there is no support here for a re-valued or partial in-kind transfer at execution time; any change to the agreed value requires reversing the original commitment, not editing the execution. The "Execute Transfer" UI requires the target asset to already be linked to the fund (via `linkAssetToFund`) before it can be selected; the ordering question of whether an asset can or should be linked before any capital exists is 4D4-C's territory (fund lifecycle and asset-link integrity), not addressed here. The vestigial commitment-delete-cascades-to-linked-capital-call code path in `core.js`'s `if-delete` handler is unreachable in production (commitments cannot be deleted per rules) and was left untouched.

No Monday integration files, source model files, or `approveOpportunity`/`transitionLedgerRecord`/`reverseTransaction` are changed.
