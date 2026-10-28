# Project checkpoint — 2026-09-22

## Confirmed baseline

- Repository: https://github.com/opal3k-blip/real-estate-ledger
- Branch: p0-shared-domain-engine-extraction
- Latest confirmed pushed commit: eee1a43803447e905d1c88c23be0365d782fe31b.
- Phase 2R-4B client cutover is complete. Phase 2R-4C is prepared locally as a
  patch; it has NOT been applied, committed, pushed or deployed on the user's machine.
- Commit author and committer must both be Opal Development
  <opal3k-blip@users.noreply.github.com>.

## This patch

Server-side IC recomputation, deterministic packaged canonical modules, stored-input
audit snapshot and digest, explicit override validation, tests and documentation.
See PHASE_2R_4C_TRUSTED_IC.md for the contract and release limitations.

Local verification on Node 24.19.0:
- Existing Functions tests: 27/27.
- New trusted IC tests: 26/26.
- Financial frozen golden: 20/20 browser and 20/20 packaged server, tolerance 1e-12.
- IC reconciliation: 17/17.
- Financial validation: 25/25.
- Financial authority guard, Functions lint and bundle freshness: pass.
- JavaScript syntax: pass on the supplied partial repository.

The target Functions runtime is Node 20; repeat the relevant checks there before
release. Emulator Rules tests, real concurrency and production deployment remain
unverified. The XIRR roadmap is not declared complete by this patch.

## Next steps, one command per user response

1. Save phase2r4c-trusted-ic.patch beside the local repository and run git apply
   --check --ignore-space-change against it. Review any failure; do not force it.
2. Apply the checked patch, then review git diff --stat and status.
3. Run the targeted suites once. Investigate failures without repeating successful
   suites unless their inputs changed.
4. Stage only the explicit patch files, inspect the staged diff, commit and verify
   both author and committer identities before pushing.
5. Resolve emulator/release checks separately. A push is not a Firebase deployment.

## Protected user changes

Never use git add ., broad reset/restore/clean, or overwrite these existing changes:
firebase.json; firestore.rules; functions/monday-sync.js;
functions/test/load-index-with-fakes.js; tests/rules/rules.test.mjs;
.firebase/; Claude outputs/; functions/fix-webhook.js; functions/fix.js;
functions/monday-webhook.js; monday-sync.js; tests/domain/golden-fixtures.mjs;
tests/domain/golden-master.json; tests/domain/package.json; type;
unreachable-summary.txt.

Ignore MODULE_TYPELESS_PACKAGE_JSON warnings when tests pass. Do not change the
root package.json merely to suppress them. Monday runtime files and the protected
fake loader were used unchanged for local tests.

## Keeping future sessions small

Start the next session with this checkpoint, the latest short git status and the
last command output. Request only the changed files or failing output. Keep a
single active phase; update this checkpoint when a phase is actually verified.
Do not paste the full conversation or repeatedly dump entire source files.
