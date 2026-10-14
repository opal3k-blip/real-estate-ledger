# Phase 2R-4E handoff — underwritingVersions v4 / approveOpportunity requestId contract

## Confirmed baseline

- Repository: opal3k-blip/real-estate-ledger
- Branch: p0-shared-domain-engine-extraction
- Latest confirmed pushed commit before this phase: cc7e69e5f78274f971244a58ce7f56f1c33ad8e9
  (Phase 2R-4D4-C, round 5).
- This phase (2R-4E) is prepared locally in the working tree. **It has NOT been
  committed, pushed, or deployed.** Diffs and test output are for review first,
  per explicit instruction.
- No change to economics, the financial domain engine, or Golden Master. No
  change to any role's permissions.

## What changed, and why

Before this phase, an IC-approved underwriting version (`stage: 'v4_ic_approved'`)
was written by the *client* (`ic-workflow.js`), as a **separate** Firestore write
after `approveOpportunity` returned — with `metrics`/`thesisSnapshot` recomputed
on the client, not copied from what the server actually computed at decision
time. Three real gaps followed from that:

1. **No `requestId` on `approveOpportunity` itself.** A resent identical request
   (double-click, retry after an ambiguous network timeout) created a *second*
   `icDecisions` record for a decision that had already succeeded once.
2. **The v4 version's content was not provably the server's own computation.**
   `firestore.rules` checked that a linked `icDecisions` record existed and was
   approved (`linkedDecisionValid`), but not that the version's `metrics` and
   `thesisSnapshot` were the *same values* the server used when deciding — they
   were separately recomputed on the client, after the decision, with no
   guaranteed correspondence.
3. **Two separate writes** (`icDecisions` here, `underwritingVersions` there)
   left a real window: a network failure between them could leave an approved
   decision with no version at all.

### The fix

`functions/index.js::approveOpportunity` now:

- **Requires `requestId`.** A new `icDecisionRequests/{requestId}` collection
  (Admin-SDK-only, deny-all to every client role — same pattern as
  `assetLinkRequests` from Phase 2R-4D4-C) caches `{payload, result}`. The
  payload binds the caller's email, the opportunity id, the decision type, the
  cleaned reasons, the cleaned conditions, and the override flag. Authentication
  and role authorization (`requireEmail`/`requireRole`) run unconditionally,
  **before** any cache lookup — a replay never skips identity/authorization
  checks. Resending the identical `requestId` with the identical payload
  returns the *original* result with **no second transaction executed at all**
  (not even a re-validation against the current opportunity state — the replay
  is frozen, deliberately, since it represents "the same request, already
  handled"). Reusing the same `requestId` with any different field — including
  a different caller — is rejected with `already-exists`.
- **Reads before writes, in one transaction.** `icDecisionRequests` and the
  opportunity are both read (via `Promise.all`) before any validation or write,
  matching Firestore's read-before-write transaction requirement. The request
  result, the `icDecisions` record, the `underwritingVersions` v4 record (only
  on an approving decision), and the opportunity's `ic.decisions` update are all
  written together, in that same transaction — all four succeed or none do.
- **Distinguishes a failed request from a recorded decision.** An unauthorized
  request, or an approval that fails the readiness/metrics check, throws before
  any write — nothing is recorded, not even the request-result cache (so a
  retry of a genuinely invalid request just re-validates from scratch; there is
  nothing to replay). A legitimate `reject`/`hold`/`revise` decision **is**
  recorded — the `icDecisions` entry and the cached request-result both get
  written — but it never creates a `v4_ic_approved` version.
- **Writes v4 from the server's own values.** On an approving decision, the
  `underwritingVersions/UWV-<decisionId>` document is written in the same
  transaction, with `metrics` copied directly from `evaluated.audit.metrics`
  (the same object already used to build the `icDecisions` record — no second,
  separate computation) and `thesisSnapshot` read from the *same* opportunity
  snapshot (`opp.thesis`) fetched inside this transaction. `price`/`oppType` are
  display-only fields read from that same `opp` snapshot (they do not feed the
  financial engine, so `trusted-ic.cjs` was not touched for them). The version
  id is deterministic (`UWV-` + the decision's id) — defense in depth once
  `requestId` already makes duplicate execution structurally impossible.

`firestore.rules` no longer has a `v4_ic_approved` branch in
`underwritingVersionCreateAllowed` at all — **no client role, including admin,
can create a v4 version directly**, regardless of how correctly it is formed.
Only `stage: 'manual'` remains client-creatable (unchanged: owner or admin,
honest `savedBy`). A new `icDecisionRequests/{id}` rule denies all client
read/write, identical in shape to `assetLinkRequests`.

`src/features/ic-workflow.js` no longer writes `underwritingVersions` at all on
the server-function path. It generates a `requestId` per pending decision
(keyed by opportunity id), reuses that same id if the user retries the *same*
payload, prevents a genuine double-click from firing a second call while one is
in flight, and — critically — does **not** mint a new id after an ambiguous
outcome (a network/timeout error where the server's actual state is unknown);
it only clears the pending id on a *definitive* server response (success, or a
specific rejection code). It also now gives a clear, distinct error when
running against a real, connected Firestore project that has no deployed
`approveOpportunity` function yet, instead of silently falling back to a
client-side write that `firestore.rules` would reject anyway.

## `inputHash`'s exact scope (as required, point 1)

`inputHash` is `sha256(inputJson)`, and `inputJson` is
`JSON.stringify(auditValue(engine.withDefaults(input)))`, where `input` is the
**entire** stored opportunity document minus only the `ic` field
(`functions/trusted-ic.cjs::recompute`, unchanged by this phase). This means
`inputHash` covers every other field on the document, including
`meta.updatedBy`/`meta.updatedAt` — two saves of the same opportunity with
identical economics but a different `meta.updatedAt` will produce a different
`inputHash`. This was already true before this phase; it is only documented
precisely here now.

The **actual inputs**, not just their hash, are preserved in full and
unmodifiable: `evaluated.audit.inputJson` (the complete canonicalized snapshot,
capped at 350KB) is stored on the linked, immutable `icDecisions/{sourceDecisionId}`
document (Admin-SDK-only; no client can create, update, or delete it). The v4
version document does not duplicate that potentially-large string — it carries
`sourceDecisionId` as the reference to it, plus `inputHash`/`engineVersion` for
a quick check without reading the full record.

## Policy decisions this phase does **not** make (left for a human to decide)

- **Editing an opportunity after IC approval never mutates the approved v4
  version** (immutable by rules) or the linked `icDecisions` record — both
  reflect the state at decision time, permanently. Whether a post-approval edit
  should *require* a fresh committee decision is a judgment call, not something
  this phase encodes or automates. If that policy is adopted, it should be
  documented and enforced deliberately (e.g., a UI prompt or a workflow rule),
  not inferred from `requestId` or from this transaction.
- **A stale request that arrives after the opportunity changed, or two
  genuinely different competing decisions on the same opportunity**, are
  explicitly **not** solved by `requestId` here (unlike `linkAssetToFund`'s
  `expectedVersion`, deliberately not replicated for this callable per
  instruction). `requestId` solves exactly one thing: the *same* logical
  request, resent, executes at most once. A second, different decision on the
  same opportunity — by the same or another committee member — is accepted
  normally today; deciding whether that should be blocked, warned about, or
  left as-is is a separate, unresolved policy question.
- **v1/v2/v3 underwriting stages remain backlog-only.** No code path creates
  them; this phase did not add one.

## Test results (fakes; this session's environment, Node v22.22.2)

All run against the actual modified `functions/index.js`:

- `functions/test/trusted-ic.test.cjs`: **39/39** passed (26 pre-existing +
  13 new — the full `requestId` contract: missing/invalid id, identical replay,
  replay after the opportunity was edited in between, same id with a different
  payload, same id reused by a different authorized user, `reject`/`hold`/`revise`
  recorded without a version, and the v4 record's field provenance).
- `functions/test/p0-trusted-transaction-layer.test.js`: **60/60** passed
  (58 pre-existing + 2 new regression checks for the same `requestId`
  requirement, from this file's own independent caller-review discipline).
- `node --check` passed on `functions/index.js`, `functions/trusted-ic.cjs`
  (unchanged), `src/features/ic-workflow.js`, `src/features/underwriting-versions.js`
  (comment-only change), `functions/scripts/underwriting-version-audit.cjs`,
  and `tests/rules/rules.test.mjs`.
- The new audit script's classification logic is unit-tested by
  `functions/scripts/underwriting-version-audit.unit-test.cjs` — a permanent
  file in the repository, not a temporary harness (an earlier draft of this
  document described it as a "temporary local harness, not part of the
  repository"; that line is corrected here because it is no longer true — the
  test was rewritten to import the real exported functions directly,
  `require('./underwriting-version-audit.cjs')`, rather than reimplementing
  their logic inline, specifically so it proves the actual script's behavior,
  not a copy of it). Re-run just now: **20/20 passed, exit 0**, covering
  missing decision reference, different-opportunity reference,
  unapproved-decision reference, a confirmed `inputHash` mismatch,
  explicit-`null`-vs-missing-field `dscrMin` handling on both sides, a legacy
  record with no `inputHash` on the version at all (correctly marked
  unverifiable, not mismatch), duplicate versions for one decision, and a
  decision missing `evaluation.metrics`.

## Verification item #6 — now closed (was open; see history below)

**Update, same session, after the diffs above were first prepared:** the
`firebase-tools`/`stream-json` toolchain conflict blocking the real Firestore
Emulator was root-caused and fixed, and the real concurrency proof point 6
requires has now actually been run and passes. This section originally
recorded this as an open, unresolved item; it is kept below (unchanged) as the
record of what was tried, followed by what actually closed it.

### The toolchain fix

Root cause, precisely: `firebase-tools@15.30.1` calls
`require("stream-json/filters/Pick")` (and three sibling paths — `filters/Filter`,
`streamers/StreamArray`, `streamers/StreamObject`), a pre-3.x, capitalized,
extension-less convention. `stream-json@3.6.0` (pinned via the `overrides` in
`tests/rules/package.json` — a deliberate *newer*-version security pin, not
something this fix touches or reverts) renamed those files to lowercase
(`pick.js`, `filter.js`, `stream-array.js`, `stream-object.js`) and ships a
package `"exports"` map (`"./*": "./src/*"`) that does no case-folding and no
implicit extension resolution. The two conventions are simply incompatible —
confirmed by reproducing the exact failure (`Error: Cannot find module
'.../stream-json/src/filters/Pick'`) via `Module._resolveFilename` tracing.

The fix is four one-line shim files inside `stream-json`'s own `src/` tree —
each is just `module.exports = require('./<real-lowercase-file>.js');` at the
exact legacy path `firebase-tools` requires — created by a new **postinstall**
script (`tests/rules/scripts/fix-stream-json-legacy-paths.cjs`, wired into
`tests/rules/package.json`'s `"postinstall"`), so `npm install` recreates them
automatically every time, including a completely clean `node_modules` on any
other machine. It does not change the `stream-json` version pin, does not
touch `firebase-tools`, and is idempotent (running it twice does nothing the
second time).

> **Correction, 2026-10-04 (independent re-verification):** the sentence above
> about a "from-scratch `rm -rf node_modules && npm install`" reproducing the
> shims was re-checked today and could not be confirmed against this
> repository's actual working `tests/rules/node_modules` — it currently has
> `stream-json@1.9.1` installed (the old, pre-override, already-capitalized
> layout), not the `3.6.0` that `package-lock.json` itself already resolves
> to under `node_modules/stream-json` (`"version": "3.6.0"`, confirmed by
> reading the lockfile directly). In other words: the lockfile is correct, but
> this real `node_modules` has simply never been reinstalled since the
> `overrides` pin was added, so the postinstall script currently has nothing
> to fix here and silently no-ops — tests still pass today only because 1.9.1
> happens to already match the old capitalized convention `firebase-tools`
> needs, not because the shim mechanism ran.
>
> The mechanism itself **was** independently re-verified today, in complete
> isolation (a copy of `tests/rules/package.json` + `package-lock.json` +
> `scripts/fix-stream-json-legacy-paths.cjs` in a scratch directory outside
> this repository's `node_modules` entirely — nothing here was touched): a
> clean `npm install` there installed `stream-json@3.6.0` exactly as pinned,
> the postinstall script logged `created 4 legacy-path shim(s)`, and
> `require('stream-json/filters/Pick')` / `Filter` / `streamers/StreamArray` /
> `streamers/StreamObject` — the exact subpaths `firebase-tools` requires —
> all resolved successfully afterward. So the fix is proven correct; it just
> has not yet been *applied* to this repository's real `node_modules`. A real
> `npm install`/`npm ci` here would need it — attempted once this session and
> aborted, because this connected folder is a FUSE mount that rejects the
> `rename` operations npm's package-moving step performs (`EACCES`); doing a
> full reinstall here would need either running `npm install` from the user's
> own native terminal (not through this bridged environment) or an explicit
> go-ahead to risk it anyway.

### What actually ran, against the real Firestore Emulator, this session

1. **`tests/rules/rules.test.mjs` — full suite, real emulator.** Output:
   `ALL PASSED (current-rules expectations; real Firestore emulator)`. This
   includes the updated Phase 2R-4E assertions: `v4_ic_approved` now denied to
   `senior_ic`/`fund_manager`/`admin` alike, `manual` still succeeds, and the
   new `icDecisionRequests` deny-all block (create/read/update/delete, for
   `senior_ic` and `admin`) — all confirmed against real rule evaluation, not
   the fakes' hand-written approximation.
2. **A new, separate real-emulator test**,
   `functions/test/p0-approve-opportunity-concurrency.emulator.test.js`, using
   a new loader, `functions/test/load-index-with-real-emulator.js` (keeps the
   real `firebase-admin` — talking to the actual emulator via
   `FIRESTORE_EMULATOR_HOST` — while still faking only the unrelated
   `firebase-functions` trigger/onCall plumbing, exactly as `load-index-with-fakes.js`
   does, so `approveOpportunity` is invoked directly with a real Firestore
   transaction underneath). Three tests, run three times total (to rule out
   flakiness in a genuine concurrency test) and once more from the clean
   reinstall above — **3/3 every time**:
   - Two genuinely concurrent (`Promise.all`, no `await` between them) calls
     with the identical `requestId` and payload on a fresh opportunity →
     exactly one `icDecisions` doc, exactly one `underwritingVersions` doc,
     both calls resolve with the identical result object.
   - Two genuinely concurrent calls with the *same* `requestId` but a
     *different* payload → exactly one succeeds, the other is rejected
     `already-exists` — never two silent successes.
   - A transaction that fails (unready opportunity, no override) leaves
     **zero** documents in `icDecisions`, `underwritingVersions`, and
     `icDecisionRequests`, and the opportunity document itself untouched —
     verified against the real emulator, not inferred.

This is the actual proof point 6 asked for — not the fakes' sequential-logic
approximation, and not Firestore's documented guarantees taken on faith. The
atomicity/replay guarantee now rests on real, repeated, real-Firestore
evidence, in addition to (a)–(c) as originally reasoned below.

To reproduce (from the repository root):

```
cd tests/rules
npm install                                    # postinstall fixes stream-json paths automatically
node -e "require('fs').copyFileSync('../../firestore.rules','./firestore.rules')"
npx firebase emulators:exec --only firestore --project demo-test "node rules.test.mjs"
npx firebase emulators:exec --only firestore --project demo-test "node ../../functions/test/p0-approve-opportunity-concurrency.emulator.test.js"
```

(`functions/node_modules` must have real `firebase-admin`/`firebase-functions`
installed for the second command — `npm install` inside `functions/` once;
this is exactly what the existing `functions/package.json` already declares as
dependencies, just not previously installed in this session's fresh container.)

> **Note, 2026-10-04:** on a Dropbox-synced/FUSE-mounted working copy, `npm
> install` here can fail with `EACCES: ... rename ...` — npm's package-moving
> step performs renames the mount rejects. This is unrelated to `stream-json`
> or this phase's changes; it only affects actually *running* `npm install`
> inside such a mounted folder (observed and reproduced this session). Run it
> from a native terminal on the machine instead, or outside the synced
> folder, if this happens.

### Isolated `npm ci` verification, final files and lock files (closes the clean-install request)

A separate, later check, specifically to confirm a genuinely clean install —
not a reused `node_modules`, and not `npm install` (which can silently update
a lock file) — against the *final* `package.json`/`package-lock.json` for
both `functions/` and `tests/rules/`. A scratch copy of the minimal runtime
files needed by each (never this repository's own `node_modules`, and never
inside this Dropbox-synced/FUSE-mounted folder — built on the verifying
machine's own local disk, confirmed via `df -h` to be a separate filesystem)
was assembled, and `npm ci` — which refuses to run at all if the lock file and
`package.json` disagree — was run against each as-is:

- `functions/`: `npm ci` — **exit 0**, no lock-file mismatch, nothing to
  report as a diff.
- `tests/rules/`: `npm ci` — **exit 0**, no lock-file mismatch. The
  `postinstall` shim ran automatically during this clean install and logged
  `created 4 legacy-path shim(s)`, confirming the fix applies on a genuine
  from-scratch install — not only in the earlier ad-hoc `npm install` check
  quoted above.

With those freshly-`npm ci`'d dependencies in place (not the stale, never-
reinstalled `node_modules` this repository's working copy currently has):

- `tests/rules/rules.test.mjs` — **212/212 passed**, real Firestore Emulator.
- `functions/test/p0-approve-opportunity-concurrency.emulator.test.js` —
  **3/3 passed**, run three separate times for stability — all three stable.

Dependency versions this `npm ci` actually resolved (the ones directly
relevant to the toolchain fix, plus the other top-level runtime dependencies):

| Package | Version |
|---|---|
| `firebase` | 12.19.0 |
| `firebase-tools` | 15.30.1 |
| `@firebase/rules-unit-testing` | 5.0.2 |
| `stream-json` | 3.6.0 |
| `uuid` | 11.1.1 |
| `qs` | 6.16.0 |
| `csv-parse` | 7.0.2 |
| `@opentelemetry/core` | 2.11.0 |
| `firebase-admin` | 12.7.0 |
| `firebase-functions` | 6.6.0 |
| `nodemailer` | 10.0.10 |

Environment this ran in: Node `v22.23.2`, npm `10.9.8`, OpenJDK
`21.0.12.1` (Temurin) — the Java runtime the Firestore Emulator itself
requires to start. (This differs slightly from the Node version quoted under
"Test results" above, `v22.22.2` — that was a separate, earlier run in this
session's environment, before this dedicated isolated-install check. Both
ran the same test files; the version difference is environment-only, not a
behavior difference.)

The scratch directory used for this check was deleted immediately after these
results were captured; nothing from it was left behind, and this repository's
real `node_modules` in either `functions/` or `tests/rules/` was never
touched by this check — it still has whatever was installed in it before
(see the correction above regarding `tests/rules/node_modules`'s current
`stream-json@1.9.1`). Actually reinstalling this repository's own
`node_modules` against the current lock files is a separate step, still not
done here, for the same FUSE-mount `EACCES` reason noted above.

---

*Original text of this section, before the fix above, kept verbatim for the
record:*

> **The real Firestore Emulator concurrency test was not run.** Point 6 requires
> proving, against the real emulator, that two simultaneous requests with the
> identical `requestId` and payload produce exactly one decision and one version,
> and that a failed transaction leaves no partial write. Fakes cannot prove this
> (no real transaction isolation — see `load-index-with-fakes.js`'s own header
> comment). `firebase-tools@15.30.1` requires `stream-json/filters/Pick`
> (capitalized, pre-3.x path convention); the `stream-json@3.6.0` override in
> `tests/rules/package.json` only ships lowercase paths (`filters/pick`). This
> was unrelated to this phase's changes — it reproduced on a completely fresh
> `npm install`.

## Files touched

- `functions/index.js` — `approveOpportunity` rewritten (requestId contract,
  `icDecisionRequests`, v4 written in-transaction); new
  `icDecisionRequestPayloadsMatch` helper.
- `firestore.rules` — `underwritingVersionCreateAllowed` (v4 branch removed);
  new `icDecisionRequests` deny-all match block.
- `src/features/ic-workflow.js` — client `requestId` generation/reuse/busy-guard;
  removed client-side v4 write on the server-function path; new explicit error
  for "real Firestore, no deployed function yet".
- `src/features/underwriting-versions.js` — comment-only note (no behavior
  change; `manual` path untouched).
- `functions/test/trusted-ic.test.cjs` — default `requestId` in the `req()`
  helper, a second `senior_ic` test user, an updated read-count assertion, and
  13 new tests.
- `functions/test/p0-trusted-transaction-layer.test.js` — `requestId` added to
  the existing `approveOpportunity` call, plus 2 new regression tests.
- `tests/rules/rules.test.mjs` — updated v4-creation tests (now denied for every
  role), a new "manual still works" test, and a new `icDecisionRequests`
  deny-all block — **now confirmed passing against the real Firestore Emulator**
  (see above).
- `functions/scripts/underwriting-version-audit.cjs` — new, read-only, requires
  `--project` explicitly, classifies evidence gaps as unverifiable rather than
  match/mismatch. **Not run against any real project.**
- `functions/scripts/underwriting-version-audit.unit-test.cjs` — new; the
  permanent unit test for the script above (20/20 passing, see "Test results"
  above — this list previously omitted this file).
- `tests/rules/scripts/fix-stream-json-legacy-paths.cjs` — new; postinstall
  shim generator for the `firebase-tools`/`stream-json` path conflict (see above).
- `tests/rules/package.json` — one line added: `"postinstall"` now runs the
  script above. Nothing else changed (the `overrides` security pins are
  untouched).
- `functions/test/load-index-with-real-emulator.js` — new; the real-`firebase-admin`
  counterpart to `load-index-with-fakes.js`, used only by the concurrency test
  below. Refuses to run without `FIRESTORE_EMULATOR_HOST` set, specifically so
  it can never be pointed at a real project by accident.
- `functions/test/p0-approve-opportunity-concurrency.emulator.test.js` — new;
  the real-emulator concurrency/atomicity proof described above.
- `functions/test/load-index-with-fakes.js` — comment-only correction (the
  header previously claimed `rules.test.mjs` "doesn't work in this
  environment" and that `stream-json@3.6.0` "is actually installed" — both
  now false, per the toolchain fix above; replaced with a dated correction
  pointing at the actual current state). No behavior change.
- `functions/README.md` — documents the new `requestId` contract on
  `approveOpportunity` for anyone reading this module's own docs, not just
  this handoff file.
- `src/features/__tests__/ic-workflow.pending-requests.test.mjs` — new;
  covers `pendingIcRequestKey`/`loadPendingIcRequestsFromStorage`/
  `persistPendingIcRequests`/`reservePendingIcRequest` directly.
- `src/features/__tests__/ic-workflow.error-codes.test.mjs` — new; covers
  `normalizeFunctionsErrorCode`'s definitive-vs-ambiguous classification.
- `src/features/__tests__/ic-workflow.handler-e2e.test.mjs` — new; end-to-end
  test of the UI `ic-decide` handler itself (fake `localStorage`/`document`/
  `httpsCallable`), including the two-different-users-identical-payload
  isolation scenario added this session (confirms each user gets their own
  `requestId`, keyed and persisted separately under
  `reop:pendingIcRequests:v1` by `email::oppId`, with the correct
  post-`splitLines()` signature for each) — **25/25 passing**, confirmed
  stable on repeat runs.
- `docs/SECURITY_RULES_REVIEW.md` — three Collections-matrix rows corrected
  to match `firestore.rules` ground truth (`opportunities.ic` cannot be
  written directly by any client role, `icDecisions` create is blocked for
  every role including Admin, `capitalCalls`/`distributions` updates are
  blocked for every role, not just non-Fund-Managers), and the CI test list's
  `v4_ic_approved` bullet corrected to describe server-side-only creation
  inside the approval transaction.
- `docs/PHASE_2R_4E_HANDOFF.md` — this file.

**Not part of this phase, for the avoidance of doubt:** `firebase.json` shows
as modified in this working copy, but its entire diff is an unrelated
Hosting `ignore`-pattern config change (listing artifacts like
`.tmp-phase8-chart-merge/**` and several Arabic-named planning documents) —
nothing to do with 2R-4E. It is **not** included in the 4E file list and
should not be staged as part of this phase's commit.

## Next steps

1. Review the diff for every file above.
2. Re-run the fakes suites yourself (`npm --prefix functions test`) to confirm
   the 39/39 and 60/60 results independently, and the two real-emulator
   commands above to confirm `ALL PASSED` and `3/3` yourself.
3. If satisfied, stage and commit yourself (no commit/push was made from here).
4. `underwriting-version-audit.cjs` is available whenever you want a read-only
   look at production data — only with `--project` named explicitly and your
   own go-ahead at that time; nothing here ran it against production.
