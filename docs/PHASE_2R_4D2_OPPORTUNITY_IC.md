# Phase 2R-4D2 — protect opportunity IC history

Baseline: aee015b4270efdfc526ef3f5f6d2f9506b0594a9 plus existing local comments.
The user approved continuing this scope after discussing legacy opportunities.

## Behavior
- Client creation permits absent IC or an empty IC map with only an optional empty decisions list.
- All roles, including admin, must preserve existing IC on update. Empty legacy shapes may normalize without creating decisions.
- Ordinary owner/admin edits retain existing decisions; financial edits do not certify that a historical approval applies to new assumptions.
- Client deletion requires empty IC; malformed IC fails closed for deletion.
- approveOpportunity and updateIcConditionStatus continue using Admin SDK. No callable changes.
- Historical approval import will require a separate authenticated, audited server workflow. This patch does not create it or revalidate old decisions.

## Verification
Added real-emulator cases for four roles, prefilled/malformed IC creation, legacy normalization, full-document saves preserving history, clearing/removing IC, deletion, batch delete/recreate and unauthorized creation.
Local syntax and patch application checks are performed before delivery. Windows emulator execution remains required before commit. No production deployment.

## Follow-on product requirements
Madinah is the first future detailed-model reconciliation case. Its fund is not launched and the user reports no spending yet. The landowner will also provide approximately SAR 23.68m cash. Keep in-kind and cash commitments separate for the same investor. Reconcile the land cost versus landowner-equity difference before import. Preserve approved forecast, revised forecast and actuals separately. Detailed monthly scheduling, dated XIRR, periodic MIRR, financing and investor waterfall require implementation/verification; this security patch does not deliver them.

## Remaining gaps
Fund creation with assetIds, ledger creation exceptions, client-authored underwriting metrics, integration/concurrency, historical-data review and deployment remain separate work.
The historical admin-bypass comment is retained as prior context; the new Phase 4D2 note and executable rules supersede it.
