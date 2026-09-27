# Phase 2R-4D3 — fund asset-link protection

Baseline: 5570b15a4d9545d5709a10f064d7022f4cf7f402, uploaded HEAD archive.

## Scope
Fund creation requires missing or empty-list assetIds. Populated lists and malformed values are denied even for admin. Fund deletion requires the same empty-asset condition. Existing update protection remains unchanged: clients cannot change assetIds. Normal edits and full saves preserving links remain allowed for manager/admin. blankFund already creates assetIds:[]; no schema or economic changes are needed.

linkAssetToFund remains the server path for linking/unlinking. This patch does not change its business rules. Existing linked funds are retained. No production data is changed or migrated.

## Verification
Tests cover manager/admin empty and legacy creation/deletion; forged/malformed creation; linked-fund edits, field removal, overwrite, deletion and batch delete/recreate; malformed historical records; lower-role and anonymous denials; authorized reads.
Local JavaScript syntax and patch application checks pass. Real Firestore emulator execution on the user's machine is still required before commit. Fixture writes with rules disabled do not certify callable integration/concurrency.

## Remaining boundaries
An empty asset list does not prove the fund has no commitments or ledger history. Full fund lifecycle protection/archival needs a separate server workflow. Server unlink currently permits removal without the broader lifecycle review; this patch does not certify that workflow. Direct transaction creation, ledger creation exceptions and underwriting metric authority remain open.

Review also found that the current in-kind commitment UI auto-creates a paid capital call on commitment save, and server linking sums paid calls as deployable cash. Before Madinah launch, separate promised versus transferred in-kind contributions and cash liquidity from asset value. This is a documented implementation finding, not a change in this patch.

No Monday integration files, local loader changes, financial formulas, or source model files are changed. Existing local comments are kept outside this commit.
