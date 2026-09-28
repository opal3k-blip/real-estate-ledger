# Phase 2R-4D4-C — in-kind execution ordering, duplicate prevention, unlink/delete integrity

Baseline: 6a9ab9828bd69f65f11f55079b3f6ccd33285c94, branch p0-shared-domain-engine-extraction.
This patch is prepared and locally verified as described below; it has NOT been
staged, committed, pushed, or deployed as of this writing. Commit author and
committer must both be Opal Development <opal3k-blip@users.noreply.github.com>.

This version of the doc supersedes an earlier draft that used stale terminology
for the legacy-audit script, an incorrect usage path, no explicit credentials
section, an overclaiming land-first conclusion, and an overclaiming EOL-anomaly
statement. All five points were raised in review before this patch was staged;
this doc reflects the corrections, and item 4's scope grew during that review
(see "Files in this phase" below).

A second round of review, after this doc's land-first conclusion above had
already been revised once, asked two more specific, targeted verification
questions rather than accepting file-count and fakes-test success as closing
the phase: (1) whether linkAssetToFund's deployable-liquidity calculation
still let a linked asset's in-kind (land) value get double-counted against a
DIFFERENT asset's cash availability, proven with a real two-asset scenario, not
just reasoned about; (2) whether firestore.rules' `type=='assetLink'` exception
from the canonical-ID requirement was actually enforced as Admin-SDK-only, or
left a client-writable forgery/duplication gap. Both were real, empirically
confirmed gaps — see "Two-asset land-first correction (second review round)"
and "assetLink audit-trail hardening (second review round)" below — fixed in
this same round, not deferred.

## Scope

Five items were originally in scope for this phase; review of item 5 (below)
surfaced one additional, previously-unexamined file with a real gap, which was
fixed as part of closing this phase rather than deferred.

Land-entry ordering: an in-kind contribution can be executed (documented as
transferred, via executeInKind in src/core.js) before the resulting asset is
linked to any fund, without treating the land's value as generic deployable cash.
linkAssetToFund's deployable-liquidity calculation carries a narrow exception:
an executed in-kind capitalCall explicitly earmarked to one asset (inKindAssetId)
counts toward deployable liquidity only when linking that exact asset, never
toward any other asset's link. This handles the land-first sequencing case (an
in-kind contribution that creates the very asset it will later be linked to)
without inflating the fund's general cash pool. See "Land-first verification"
below for how this was actually checked, not just asserted, across the codebase.

Duplicate execution: capitalCalls documents created for an in-kind execution, and
transactions audit entries created for any ledger event, use deterministic
document IDs (CC-EXEC-<commitmentId>, and <type>-<action>-<relatedId> respectively)
rather than random IDs. firestore.rules requires these exact ID shapes
(linkedCommitmentOk, transactionCanonicalId) for the corresponding writes. Because
Firestore evaluates a second write to the same document ID as an update rather
than a create, and both collections deny client update, a resubmitted or
concurrent duplicate is rejected at the rules layer itself — verified under
genuine two-way concurrency (two simultaneous writes via Promise.allSettled
against the real Firestore emulator), not only sequential retries.

Unlink/delete integrity: linkAssetToFund's unlink path blocks removing an asset
from a fund when that asset carries an executed, earmarked in-kind contribution
(a paid capitalCall with inKindAssetId pointing at it) — unlinking would
otherwise orphan that transfer with no trace back to why. That check
(earmarkedInKindForAssetTx) runs a three-field equality query (capitalCalls
where fundId==, inKindAssetId==, status==) that needs a matching composite
index; firestore.indexes.json gained that exact index (capitalCalls:
fundId ASC, inKindAssetId ASC, status ASC) as part of this phase — without it,
this query would fail against real Firestore with a "query requires an index"
error the first time this code path runs, even though it works today against
the fakes-based test double, which has no concept of indexes at all (see
Verification). An admin may override
with a non-empty, explicitly documented correctionReason; the override is itself
audited as a distinct action (unlink-override), never folded silently into a
plain unlink. A plain unlink (no earmarked in-kind capital) is unaffected, and
now always logs its own transactions entry — closing a pre-existing asymmetry
where linking logged an audit entry and unlinking did not. Direct client deletion
of a fund is denied unconditionally in firestore.rules; the only remaining path
is the new archiveOrDeleteFund callable, which checks assetIds, commitments,
capitalCalls, distributions, and transactions (Admin SDK, cannot be done from
rules) and archives (status: archived) any fund with any history at all — true
hard deletion is reserved for a fund that has never had any history.

Legacy records: functions/scripts/legacy-inkind-audit.cjs is a new, read-only
script. It scans capitalCalls carrying linkedCommitmentId and reports, per
record, two distinct things that must not be conflated:

  - Classification (a structural fact, nothing more): "linkedToAsset" when
    inKindAssetId is present, "missingAssetLink" when it is absent. This says
    only whether the record carries an asset reference at all.
  - Verification (separate fields, never assumed from classification alone):
    whether the referenced asset actually exists (referencedAssetExists),
    whether the referenced commitment actually exists
    (referencedCommitmentExists), whether that commitment's own
    contributionType is genuinely 'in_kind' (commitmentContributionTypeIsInKind),
    whether the record itself is a reversal of an earlier entry rather than a
    fresh execution (isReversalEntry), and whether it carries notes (hasNotes).

Having inKindAssetId present does NOT by itself prove that the underlying asset
transfer was actually documented/executed — it only proves the record points at
an asset ID. The script also flags, as separate categories: duplicateGroups
(more than one non-reversal execution sharing the same linkedCommitmentId —
reversal entries are deliberately excluded from this check, since an original
execution plus its own correcting reversal legitimately share a
linkedCommitmentId and are not a duplicate), missingReferences (a record whose
linkedCommitmentId or inKindAssetId points at a document that does not exist),
and reversalEntries (negative-amount or reversalOfId-carrying records, listed
separately from ordinary duplicate-checking).

The script performs no writes, updates, deletes, or migrations of any kind —
legacy and ambiguous records require human review, not automated
reconciliation.

Usage (from the repository root):
  node functions/scripts/legacy-inkind-audit.cjs --project <PROJECT_ID>
  node functions/scripts/legacy-inkind-audit.cjs --project <PROJECT_ID> --out report.json
From inside functions/ (note the different relative path):
  node scripts/legacy-inkind-audit.cjs --project <PROJECT_ID>

--project is mandatory by design; the script refuses to run without it (or the
FIRESTORE_AUDIT_PROJECT_ID environment variable) rather than silently defaulting
to whichever project the environment happens to be configured for.

Credentials: running `firebase login` (used for `firebase deploy` and other
Firebase CLI operations) does NOT by itself provide the Admin SDK Application
Default Credentials (ADC) this standalone Node script needs — they are separate
credential stores. The script calls admin.initializeApp({ projectId, credential:
applicationDefault() }), which requires either the GOOGLE_APPLICATION_CREDENTIALS
environment variable pointing at a service-account JSON key, or having run
`gcloud auth application-default login` on this machine. (A deployed Cloud
Function, by contrast, gets its own runtime service-account credentials
automatically and never touches local credentials at all — that path is
unaffected by any of this.) This script has not been run against real
production data — only against seeded fake Firestore data in a throwaway smoke
test (see Verification) — and should not be, before this credentials section and
the --project requirement have been reviewed and the target project confirmed.

Audit duplication gap: this was flagged in an earlier session as needing to be
actually closed with real tests, not re-documented as open. It is closed by the
same canonical-ID mechanism described under duplicate execution above, applied
to the transactions collection generally (not only capitalCalls), and verified
to reject both a sequential resubmission and a genuine concurrent double-write
to the same canonical transaction ID under the real Firestore emulator.

Closing acceptance criterion (as given): commitments or assets cannot be hidden,
and no orphaned records can result from an unlink-then-delete or delete-then-
recreate sequence. Unlink is blocked while an earmarked in-kind transfer exists
(admin override only, with a documented reason); fund deletion is blocked
unconditionally at the rules layer and replaced by an Admin-SDK-checked archive/
delete callable that inspects all four ledger collections plus assetIds before
ever hard-deleting. Together these prevent the specific unlink-then-delete and
delete-then-recreate orphaning sequences named in the criterion.

Explicitly flagged, not fixed in this phase: meta.createdBy and capitalAllocation
permission gaps on the opportunities collection were reviewed and are recorded
here as findings for a future phase, not addressed by this patch. Review found no
change needed to how the client's canEditOpp/ownsOpp logic is mirrored server-
side for the functions touched this phase; a broader permission-model review of
those two fields is separate, undone work.

## Land-first verification (item 5)

The requirement: allowing an asset to be linked against an in-kind contribution
must never make that contribution's value into cash generally available to
spend on something else. This was checked by finding every place fund cash or
capital gets summed or labeled as available/deployable, not by re-asserting the
one gate already described under "Land-entry ordering" above.

Checked and confirmed correct, no change needed:

  - functions/index.js, linkAssetToFund's `deployable` calculation: excludes
    every capitalCall carrying linkedCommitmentId from paidIn, adding back only
    the amount earmarked (inKindAssetId) to the exact asset being linked in
    that one call — never persisted or reused elsewhere.
  - src/core.js, fundLedgerSummary(fundId): cashPaidIn excludes every
    linkedCommitmentId capitalCall and is the only input to deployableCash;
    paidIn (which includes them) is kept separate and used only for DPI/
    investor-level PIC/DPI/TVPI reporting — the documented, intentional
    Phase 2R-4D4-B design, unchanged here.
  - src/core.js, netPaidCallsForInvestor / validateIfDraft's over-call guard
    (rejecting a capitalCall that would post more than the investor's
    commitment): this deliberately compares paid-in-so-far (including in-kind)
    against committed (which also includes in-kind commitment amounts, by the
    CONTRIBUTION_TYPES design). It is a proportionality check, not a cash
    figure, and symmetric on both sides — not a land-first concern.
  - src/features/excel-workbook.js and src/features/portfolio.js: both consume
    fundLedgerSummary's paidIn for capital-account reporting (an Excel "Paid-in"
    row; a portfolio-level TVPI/MOIC multiple) and portfolio.js's own
    "Dry Powder" figure is committed-minus-called (uncalled LP commitment
    headroom, a different concept from spendable cash on hand) — none of these
    label in-kind value as available cash.

Found and fixed (not previously examined): src/features/
capital-allocation-engine.js's deployableCashForFund() — the gate consulted
before a fund manager can link/allocate a NEW, different asset into a fund —
used fundLedgerSummary(...).paidIn (includes in-kind) instead of .cashPaidIn
(excludes it). This is a distinct file from the five items above (the Capital
Allocation Engine, Phase 5) and predates the cash/in-kind split introduced in
Phase 2R-4D4-B, which never updated it. Consequence was mode-dependent: with a
real Firebase backend (the normal path), functions/index.js's own linkAssetToFund
independently re-enforces the correct exclusion server-side inside an Admin SDK
transaction, so no real ledger data could actually be corrupted by this bug —
a request that this client-side gate wrongly allowed would still be rejected by
the server, just with a less specific error. Without a real Firebase backend
(DEMO_MODE, or any Firebase initialization failure that falls back to local
STORE-only mode), there is no server-side recheck at all in that code path, and
this bug would have let in-kind (land) value count as spendable cash available
to allocate to a completely different asset. Fixed by using cashPaidIn instead
of paidIn in that one function; covered by a new regression test (see
Verification) that fails against the pre-fix code and passes against the fix.

This is the most thorough sweep performed for this item — every consumer of
fundLedgerSummary found via grep, plus every "paid"+reduce/sum pattern and every
"cash"/"deployable"-labeled quantity found by name in src/core.js and
functions/index.js — not a claim that no other file anywhere in the codebase
could possibly mishandle this; no such exhaustive proof was attempted.

## Two-asset land-first correction (second review round)

The sweep above checked only whether an asset's OWN in-kind earmark could leak
into cash spendable by another asset (it cannot). It did not check the reverse
direction: whether an already-linked asset's in-kind earmark gets wrongly
deducted from the shared cash pool a second time when evaluating a DIFFERENT
asset — an over-restrictive bug, not a leak, but a real correctness defect.
It does, empirically confirmed with a real two-asset scenario before any fix:
linking a fully land-funded asset A (targetEquity fully covered by an executed,
earmarked in-kind capitalCall) FIRST, then attempting to link a genuinely
cash-funded asset B (whose target fits easily inside real, untouched fund cash)
SECOND, was wrongly REJECTED with "Insufficient deployable fund cash" —
`allocatedElsewhereTx` (functions/index.js) and its client twin
`allocatedElsewhereInFund` (src/features/capital-allocation-engine.js) summed
A's FULL targetEquity against the shared cash pool once A was linked, with no
regard for the fact that A's own coverage never touched that pool. Linking B
first, then A, did not exhibit the bug (A's own earmarkedForThisAsset exception
covered its own check regardless of order) — the defect was order-dependent,
only surfacing when a land-funded asset was linked before a cash-funded one.

Fixed by deducting only each other asset's CASH portion — targetEquity minus its
own paid, eligible in-kind coverage (via the existing `earmarkedInKindForAssetTx`
helper, already used for the unlink guard), floored at zero so surplus in-kind
coverage beyond an asset's own target never manufactures spare cash for the sum
— in both `allocatedElsewhereTx` and `allocatedElsewhereInFund`. The floor
matters on its own: without it, an asset over-covered by in-kind value (e.g.
150,000 in-kind against a 100,000 target) would produce a NEGATIVE contribution
to the "elsewhere" sum, which subtracting a negative number would have wrongly
INCREASED apparent cash for a different asset — a distinct, second leak in the
same direction as the original Phase 5 capital-allocation-engine.js bug, caught
by the same fix.

While tracing this, a second, related defect was found in the SAME link branch:
`earmarkedForThisAsset` — the amount an asset's OWN executed in-kind coverage
contributes toward its own target — was computed inline by checking
`linkedCommitmentId` truthiness, but `reverseTransaction`'s reversal entries
explicitly null `linkedCommitmentId` while keeping `inKindAssetId` unchanged (by
design, so a reversal is not re-linked to the original commitment). A reversed
in-kind contribution's negative amount therefore fell into the general `paidIn`
cash figure instead of netting its own original contribution to zero — a fully
reversed 200,000 in-kind contribution still counted as full coverage for the
asset itself, while also manufacturing a phantom 200,000 of NEGATIVE general
cash. Fixed by keying both the `paidIn` exclusion and `earmarkedForThisAsset`
on `inKindAssetId` presence (via `earmarkedInKindForAssetTx` itself, which
already nets a reversal's negative amount against its original by summing on
`inKindAssetId` regardless of `linkedCommitmentId`) instead of on
`linkedCommitmentId` alone.

Finally, a server/UI parity gap was found and fixed while verifying these:
`deployableCashForFund` (the client-side pre-flight guard) never implemented
the "asset's own in-kind earmark satisfies its own target" exception that
`linkAssetToFund` (the server) already had — meaning a legitimate, fully
land-funded asset link would be blocked by the UI's own pre-check before the
request ever reached the server, even though the server would have allowed it.
Fixed by adding the same `earmarkedForThisAsset` exception to
`deployableCashForFund`, mirroring the server exactly.

All four fixes are covered by new regression tests: seven new scenarios (two
orderings of the two-asset case; a mixed cash+in-kind asset consuming only its
cash portion, checked at an exact boundary; excess in-kind coverage not
manufacturing spare cash; an unexecuted (pending) in-kind commitment granting no
coverage; a fully reversed in-kind contribution netting to zero) added to
functions/test/p0-trusted-transaction-layer.test.js, and a mirrored set (minus
the pending/reversal cases, which are server-only data shapes not modeled by
the client's in-memory STORE. the same scenarios plus the parity check) added
to tests/features/capital-allocation-engine.landfirst.test.mjs. Every one of
these tests demonstrably fails against the pre-fix source and passes against
the fix — not merely written to pass.

## assetLink audit-trail hardening (second review round)

firestore.rules' `/transactions/{id}` create rule carried an unconditional
exception for `type=='assetLink'`, commented as describing that in production
these writes come only from `linkAssetToFund` via the Admin SDK. That comment
was true of the application's own code paths, but the RULE ITSELF never
enforced it: an ordinary `fund_manager` client (proven, not assumed — this
file's own rules.test.mjs contained a passing `assertSucceeds` case for exactly
this, using a genuine authenticated client write, not an Admin SDK bypass)
could create an arbitrary `assetLink` transaction directly, with no
`transactionMatchesRecord` check and no canonical id — because a canonical id
of the same shape used for the other three ledger types (fixed to the
`relatedId`) cannot fit a type that legitimately recurs (link, unlink, re-link)
for the same asset. The fund's actual composition (`fund.assetIds`) stayed
protected throughout, by the separate, pre-existing `changesAssetIds` check on
the `funds` collection's own update rule — but its AUDIT TRAIL did not: a
fund-manager-role account could inject fabricated or duplicate "asset
linked/unlinked" audit records, unconnected to any real event, with no
mechanism to detect or reject them.

Closed by removing the exception entirely from firestore.rules — no client
create of `type=='assetLink'` is allowed at all, for any role including admin
(an "admin override" in this app is itself only ever exercised through
`linkAssetToFund`'s own Admin SDK path, never a direct client write) — since
duplicate-id collision was never the actual defense that mattered here; only
removing client write capability closes a forgery gap. rules.test.mjs's
`assertSucceeds` case was replaced with two `assertFails` cases (fund_manager
and admin, a client write each), proving the closure for both roles.

Duplicate/retry safety for the trusted path itself, now that a fixed-per-asset
id would be wrong (it would block a legitimate re-link after a real unlink),
lives in `linkAssetToFund`'s own document ids: each `assetLink` transaction now
gets `'assetLink-'+oppId+'-'+seq`, where `seq` is a running count of every prior
`assetLink` event recorded for that exact (fundId, relatedId) pair, read fresh
inside the same Firestore transaction that performs the write — link, unlink,
and re-link each get a new, correctly-ordered sequence number, while the
already-linked/already-unlinked no-op guards that predate this phase continue
to catch a plain retried request before this is ever reached. A new functions
test exercises this directly: link, retry the same link request (no-op, no
duplicate record), unlink, retry the same unlink request (no-op), then a
legitimate re-link (a new, third sequence number) — proving both dedup-on-retry
and correct handling of a legitimate recurring event in one flow.

`src/core.js`'s client-side fallback for linking/unlinking (used only when the
Cloud Functions SDK is unavailable) previously attempted a direct client write
of a `type:'assetLink'` transaction when a real Firestore backend was
configured — a path that was already broken (blocked by `changesAssetIds` on
the `funds` write, throwing an uncaught permission-denied error) and is now
also blocked at the transactions layer. That fallback now shows a clear message
and stops instead of throwing, for the case where a real backend is configured
without the Functions SDK; the local splice-and-log fallback still runs
unchanged for the pure local/demo case (no Firestore backend at all), where
neither rule applies.

## assetLink cross-fund id collision and stale-request protection (third review round)

Before approving the commit for the second review round's changes, the user
asked two further clarification questions. Both surfaced real, distinct
issues.

**Four previously-staged files (`firestore.indexes.json`, `package.json`,
`functions/test/fakes/firebase-admin-firestore.js`,
`functions/scripts/legacy-inkind-audit.cjs`)** — the user asked whether these
had drifted or were depended on by anything left outside the staged diff.
Re-checked: all four remained correctly staged from the first round with no
unstaged drift, and their staged content is consistent with what the
currently-staged code depends on. Clean, no action needed.

**Cross-fund assetLink id collision** — the second round's deterministic
transaction id, `'assetLink-' + oppId + '-' + seq`, embedded `oppId` and a
sequence number scoped by a query filtered on `fundId`, but the id string
itself did not include `fundId`. Nothing elsewhere in the codebase prevents
the same `oppId` from being linked to a *different* fund at a later point in
its lifetime (no ownership invariant exists), and every `tx.set()` call in
this file is a plain overwrite with no `{merge:true}`. So a second fund
linking an asset that a first fund had previously linked-then-unlinked could
land on the exact same document id as the first fund's own sequence-1 record,
silently destroying that fund's audit entry. Fixed by embedding `fundId` in
the id (`'assetLink-' + fundId + '-' + oppId + '-' + seq'`), and proven with a
new regression test that links the same asset to two different funds in
sequence and confirms both funds' records survive independently, with correct
`fundId` values, after the second fund's link.

**Stale/out-of-order request protection** — the pre-existing no-op guards
(`if(existing) return`, `if(!existing){...;return}`) correctly deduplicated an
*immediate* retry of the same undelivered request, but had no way to
distinguish a genuinely **stale** request — one superseded by a later, real
link/unlink that already changed the state — from a fresh, legitimate one
carrying identical parameters; both look the same on the wire, and a
state-only check can't tell them apart once the state has cycled back through
the same boolean value (link → unlink → link again leaves the boolean exactly
where it started). This was proven, not assumed: a test demonstrated the old
design's actual behavior — a stale "unlink" arriving after a real subsequent
unlink-then-relink would execute anyway, silently undoing the real relink.
This was presented to the user rather than fixed unilaterally, since closing
it meant changing the client/server call contract, beyond this phase's
originally stated scope.

The user then explicitly approved a specific fix design, with an explicit
caveat that approving the scope is not a certification that the
implementation is correct:

- **`expectedVersion`**: an incrementing version for a given (fundId, oppId)
  link-history pair, defined as the count of prior `assetLink` transaction
  events for that exact pair (`assetLinkEventCountTx`, replacing the prior
  round's `nextAssetLinkSeqTx`, same query, renamed since it now serves a
  second purpose). The client states which version it believes is current;
  the server re-derives the actual count fresh, inside the same transaction,
  and rejects outright (`HttpsError('aborted', ...)`) on any mismatch. This is
  what tells a stale request apart from a fresh one even when the boolean
  state has cycled back to the same value.
- **`requestId`**: a client-chosen, stable identifier for one specific logical
  action, tied to `{email, fundId, oppId, unlink, correctionReason,
  expectedVersion}` via `assetLinkRequestPayloadsMatch`, and recorded in a new
  Admin-SDK-only collection, `assetLinkRequests` (closed to every client role
  including admin in firestore.rules, exactly like `assetLink` transactions
  themselves — it is bookkeeping for replay, not part of the audit trail,
  which stays in `transactions`). A retry presenting the same id and the same
  payload returns the original cached `result` with no new read of business
  state and no new write — true idempotent replay. Reusing the same id with
  *any* different parameter — including just a different `correctionReason` —
  is rejected with `HttpsError('already-exists')`, never silently replayed
  and never silently re-executed with the new parameters.
- **Fail-closed for old/unpatched clients**: `expectedVersion` must be a
  non-negative integer and `requestId` a non-empty string, checked before
  anything else; either being missing or malformed throws
  `HttpsError('invalid-argument', ...)` immediately. An old client that never
  learned to send these fields gets a loud, clear rejection, not silent
  unprotected access — absence of a version is never treated as "skip the
  check".
- **Atomicity**: the idempotency-record lookup, the version check, the
  business-rule checks, the `fund.assetIds` mutation, the audit-trail write,
  and the `assetLinkRequests` write all happen inside the same
  `db.runTransaction`. A version mismatch or a business-rule rejection throws
  *before* any write, so nothing is persisted for a rejected request — the
  same `requestId` can be reused later with a correct version without being
  permanently blocked by its own earlier rejection.

Four new `functions/test/p0-trusted-transaction-layer.test.js` scenarios were
added for this, per the user's explicit list, plus one pre-existing test had
to be corrected (see Verification below for actual, executed results, not
just descriptions):

1. A request retried with the exact same `requestId` and payload returns the
   original cached result unchanged — no new transaction record.
2. An old request that never executed, carrying a superseded
   `expectedVersion` (built before a real intervening unlink-then-relink),
   is rejected (`aborted`) and changes nothing; a later request reusing the
   same `requestId` with the now-current version still succeeds afterward
   (the earlier rejection was never cached).
3. Two requests presenting the same (now-stale) `expectedVersion` — a
   sequential stand-in for a race, explicitly **not** a proof of real
   concurrent-transaction serialization (see caveat below) — resolve to
   exactly one winner; the loser is rejected (`aborted`), and a subsequent
   correctly-versioned request still succeeds, proving no permanent lockout.
4. A request missing `expectedVersion` entirely, or sending a negative,
   string, or otherwise malformed value, or missing `requestId` entirely, is
   rejected with `invalid-argument` before any state is touched.
5. Reusing a `requestId` with a different `correctionReason` than the
   original request is rejected with `already-exists` — the server compares
   the full `correctionReason` text, not a client-derived hash of it, so this
   holds regardless of the client's own id-construction scheme.

One further pre-existing test (`FNDU6`/`OPPU6`: a fresh, non-retried unlink
request against an asset that was never linked, at version 0) had to be
**rewritten**, not just converted: under the old state-only guards this was a
silent no-op, but under the new version-checked design it is now a caught
`failed-precondition` ("inconsistent state, refusing to guess") — deliberately
tightened behavior, not a regression, since a version of 0 with `existing ==
false` and a *fresh* (non-replay) `unlink` request is a logical contradiction
a correctly-behaving client should never construct. This was found by actually
running the suite in this session (see Verification), not by inspection.

**Client-side "don't guess an incomplete version" guard** — reviewed at the
user's explicit request: `STORE.transactions` is populated by
`subscribeIfCollections()`'s `onSnapshot` over the *entire* `transactions`
collection with no `.where()`/`.limit()`, so once synced it is genuinely
complete, not a partial or paginated view; the server's own
`assetLinkEventCountTx` never trusts this anyway; it always re-queries
Firestore fresh inside the transaction, so server-side correctness never
depended on client's view completeness in the first place. But nothing
tracked whether that first sync had actually happened, so a click issued in
the narrow window before the *first* snapshot arrived would silently compute
`expectedVersion: 0` from an empty `STORE.transactions` — not from a lie, but
also not a confirmed truth. Closed with an `ifCollSyncedOnce` tracking `Set`
in `src/core.js`; the `if-toggle-asset` handler now refuses the action with a
"still syncing, try again" message when the relevant collection has not
synced, instead of guessing.

That guard was then sharpened on a second, more specific concern the user
raised directly: a `onSnapshot` listener's *first* callback can legitimately
fire from the Firestore SDK's own **local cache** (an earlier write still
buffered in this same session) before the server round-trip completes — that
callback is real, but its data is not yet confirmed against the server, so it
must not be treated as "sync complete" either. `ifCollSyncedOnce` is now
gated on `!snap.metadata.fromCache`, not merely on any callback having fired;
the listener is also switched to `{ includeMetadataChanges: true }` so that
the from-cache→from-server transition still fires a callback even when the
underlying data did not itself change between the two (without this option,
Firestore suppresses a metadata-only-change callback by default, which could
otherwise leave `ifCollSyncedOnce` never set at all for a collection whose
cached and server data happened to match exactly). The flag is cleared by
`unsubscribeIfCollections()` (sign-out/user-switch, followed by a fresh
`subscribeIfCollections()` on the next sign-in) so a new session never
inherits a previous one's "already synced" state; a same-listener
network-drop-and-reconnect does not need a reset, since it already had a
genuine server-confirmed baseline before the drop.

**No automatic retry on a version rejection** — also confirmed at the user's
request: `handleStaleOrUnknown` in `src/core.js`, on an `aborted`/stale
error, shows a clear bilingual "this asset's link state changed — please
reload and try again" message, then calls `loadAll()` (a no-op when a real
Firestore backend is configured, since `onSnapshot` already keeps
`STORE.transactions` current — see its own comment) and `render()`. It does
**not** automatically re-invoke `linkAssetToFund` with a newer version; the
user must take a new action. This was true before this review pass and
remains true; nothing needed to change here, only confirming it under
scrutiny.

**Explicitly still open, not claimed anywhere in this document:**

- **Real concurrent-transaction serialization** — the fakes' `runTransaction`
  has no real isolation or retry between calls (documented in the fakes
  file's own header, pre-existing, unchanged); the "two conflicting requests"
  test above is sequential and proves only the rejection-of-stale-version
  logic, not genuine concurrent-write serialization. That requires the real
  Firestore emulator (or production), which this sandboxed environment cannot
  run for the same pre-existing reason documented under Real-emulator status
  below (and functions cannot be invoked from the rules emulator either way —
  a Cloud Function and the client-facing rules emulator are different
  surfaces).
- **The client-side sync-state/`fromCache` guard has not been exercised by
  any test, automated or manual** — only by reading `src/core.js` and
  reasoning about Firestore's documented `onSnapshot`/`metadata.fromCache`
  behavior. This repository has no browser-based or Firestore-SDK-driven test
  harness for `src/core.js`'s listener logic; confirming it requires either a
  manual browser exercise against a real or emulated Firestore backend, or
  building a new test harness for it, neither of which has been done.
- **The new `assetLinkRequests`-denial case added to
  `tests/rules/rules.test.mjs` this round has not been run against a real
  Firestore emulator** — see Verification and Real-emulator status below; it
  is syntax-checked only.

## Legacy in-kind cash-exclusion classification, stale-session write protection, and idempotent-replay-after-later-events (fourth review round)

Before staging the third round's changes, three further points were raised.

**Legacy in-kind records leaking into deployable cash** — the third round's
own fix (see "Two-asset land-first correction" above) switched the `paidIn`
exclusion inside `linkAssetToFund`'s link branch from checking
`linkedCommitmentId` to checking `inKindAssetId` alone, specifically to stop
a *new-style* in-kind reversal (which keeps `inKindAssetId` but has
`linkedCommitmentId` nulled by `reverseTransaction`) from leaking into cash.
That fix was correct for the case it targeted, but it silently regressed a
different, real case: a **legacy record written before Phase 2R-4D4-B**
introduced the `inKindAssetId` field at all — such a record carries only
`linkedCommitmentId` (exactly the `missingAssetLink` shape
`functions/scripts/legacy-inkind-audit.cjs` already classifies) — was no
longer excluded from `paidIn` at all, because it has neither marker under an
`inKindAssetId`-only check. Confirmed empirically before any fix: a fund with
a 200,000 legacy in-kind capitalCall (linkedCommitmentId only) and 100,000
real cash wrongly showed 300,000 of deployable cash, letting a 150,000
target-equity link succeed that should have been rejected for insufficient
real cash.

A second, related gap existed for the reversal of exactly this legacy shape:
`reverseTransaction` unconditionally nulls `linkedCommitmentId` on every
non-commitment reversal, and a legacy record never had `inKindAssetId` to
fall back on — so its reversal carries **neither** marker and is
indistinguishable from a plain cash reversal by looking at the reversal
document alone. A classification that checked both markers directly (a
"naive" fix, without a reversal fallback) would have let this reversal's
negative amount leak into `paidIn` as phantom negative cash, wrongly
*reducing* apparent deployable cash below its real value. This was also
confirmed empirically, against a temporary variant of the fix that checked
both markers but had no reversal fallback, before landing the real fix (see
Verification).

Fixed in `functions/index.js` by a new `isInKindCapitalCallRecord(data, byId,
seen)` helper: checks `inKindAssetId` or `linkedCommitmentId` directly first;
if neither is present and the record is itself a reversal (`reversalOfId`),
it recursively classifies the *original* record instead (looked up in the
same paid-capitalCalls snapshot the caller already holds, since the original
stays untouched and `'paid'` — see `isPostedForReversal`); a record whose
original cannot be resolved at all within that snapshot (a broken or missing
reference) is **not** assumed to be cash by default — it is excluded exactly
like a confirmed in-kind record, matching the closing acceptance criterion's
spirit of never silently trusting an unverifiable record. This does not
loosen `earmarkedInKindForAssetTx`'s own strict `inKindAssetId`-equality
query at all — an ambiguous or legacy record still gets zero coverage credit
toward any specific asset, exactly as before.

The identical classification gap existed client-side in `src/core.js`'s
`fundLedgerSummary(fundId)`: its `cashPaidIn` excluded only
`!c.data.linkedCommitmentId`, which correctly excluded a legacy original but
let a *new-style* in-kind reversal (linkedCommitmentId nulled, inKindAssetId
preserved) leak into cash — the mirror-image gap of the server's earlier
`inKindAssetId`-only bug. Fixed with an equivalent `isInKindCapitalCall(rec,
byId, seen)` helper (same logic, not merely the same outcome) in `src/core.js`,
used the same way. `paidIn` itself (the PIC/DPI/TVPI reporting figure) is
unchanged by any of this, per the existing, documented Phase 2R-4D4-B design.

Three new scenarios were added to
`functions/test/p0-trusted-transaction-layer.test.js` (FNDLEG1/FNDLEG2/FNDLEG3),
and a mirrored set to a new file,
`tests/features/fund-ledger-inkind-classification.test.mjs` (invoking the
real `fundLedgerSummary` via `tests/domain/core-vm-harness.mjs`'s `loadCore()`
— not a fake, unlike the neighboring `capital-allocation-engine.landfirst`
test, which injects a mocked `fundLedgerSummary`): a legacy in-kind record
grants no deployable cash; its reversal does not change the cash figure
(proven against both the original `inKindAssetId`-only bug and a "naive"
direct-markers-only variant with no reversal fallback — see Verification for
both failure modes actually reproduced); and an independent, genuine cash
capitalCall from the *same* investor as the legacy in-kind record remains
counted in full (classification is per-record, never per-investor). Wired
into `npm run test:features` (now two files, chained with `&&`) so it
actually runs, not only gets syntax-checked by `check:js`.

**Stale-session write to STORE after a user switch, mid-flight** —
`src/core.js`'s `if-toggle-asset` handler awaits an async
`linkAssetToFund` Cloud Function call; nothing tied that pending call's
eventual resolution to the browser session it was started in. If a user
signs out and a different user signs in (or a direct uid-to-uid switch —
already handled for `ifCollSyncedOnce`/`STORE` teardown by the third round's
`isDirectUserSwitch` fix, kept unchanged here) while that call is still in
flight, its `.then`/`catch` continuation would still run against the *now
current* `STORE` and DOM — writing the previous user's request outcome
(`STORE.transactions`, `STORE.funds`, an `alert()`, a `render()`) on top of
the new user's session.

Fixed with a new `authSessionSeq` counter (`src/core.js`, declared beside
`currentUser`), incremented inside `onAuthStateChanged` exactly when the uid
actually changes (`previousUid !== newUid` — covers sign-in, sign-out, and a
direct switch) and **not** on a same-uid callback (e.g. a token refresh),
so a legitimate in-flight request for the *same* user is never cancelled
without reason. `if-toggle-asset` captures `authSessionSeq` into
`__startAuthSessionSeq` at the very top of the handler (`sessionStillCurrent()`
closure); every point after an `await` that would otherwise touch `STORE`,
show an `alert`, or call `render()` — the success path, both failure
catches, the admin-override nested call, and `handleStaleOrUnknown`'s own
explicit server refetch — now checks `sessionStillCurrent()` first and
returns silently (no write, no alert, no render) if the session has moved on.

**Fund state confirmed via `fund.assetIds`, not only `transactions`** — two
related gaps were closed alongside the session guard. First,
`handleStaleOrUnknown` (triggered on an `aborted`/stale rejection) only ever
re-fetched `transactions` from the server, never the fund itself — so a
retry's `expectedVersion` became correct again, but the button's own
linked/unlinked state (read from `fund.data.assetIds`, per
`renderFundDetail`) could still lag until the passive `funds` `onSnapshot`
listener caught up. It now re-fetches this fund's own document from the
server (`source:'server'`) in the same `Promise.all` as the transactions
refetch, and replaces (or inserts) the corresponding `STORE.funds` entry —
gated by the same session check. Second, on a *successful* (non-stale) call,
the handler used to rely solely on `loadAll()` (a documented no-op once a
real backend is configured) and the passive `onSnapshot` listener to update
`fund.data.assetIds` — leaving a real window where `render()` could show the
stale pre-operation state. A new `applyConfirmedLinkChange(isUnlinkOp)`
closure now re-checks the asset's *current* membership in
`fund.data.assetIds` directly (not the `linking` boolean captured before the
`await`, and not a `transactions` count) and adds/removes it accordingly,
idempotently — so a delayed or already-arrived `onSnapshot` update can never
be double-applied or fought. On any failure that isn't a stale/version
rejection, the existing behavior is unchanged: a clear `alert()` and an
early `return` with no write to `STORE.funds` at all — the state is never
shown as having succeeded when it did not. No automatic retry with a newer
version was added or exists anywhere in this path, matching the user's
explicit prior instruction.

None of this client-side session-guard logic has been exercised by any
automated test, for the same reason the third round's `ifCollSyncedOnce`/
`fromCache` guard has not (see the bullet above, unchanged): this repository
has no browser-based or Firestore-SDK-driven test harness for
`src/core.js`'s `if-toggle-asset`/`onAuthStateChanged` listener logic. It was
verified only by reading the code and by `node --check`; confirming it by
execution requires either a manual browser exercise against a real or
emulated Firestore backend (sign in as one user, trigger a slow
`linkAssetToFund` call, switch users before it resolves, confirm nothing
from the first user's call reaches the second user's screen), or building a
new test harness for it — neither has been done this round.

**Replay of an already-executed request after later real events** — a fourth
point was raised: does resending an `assetLink` request that had *already
succeeded* (not a stale request that never ran) still correctly replay its
cached result, unaffected by real events that happened afterward? Reasoning
through `linkAssetToFund`'s own code (unchanged this round) says yes — the
`requestId`/payload-match lookup against `assetLinkRequests` happens first,
before the `expectedVersion` check is ever reached, so a matching replay
returns the cached `result` regardless of how far the real version has since
moved on. This was **not yet proven by any test** before this round, and is a
meaningfully different scenario from the pre-existing `FNDSTALE` test (a
request that carries a stale version but was **never actually executed** —
correctly rejected with `aborted`). A new scenario,
`FNDREPLAY` (`functions/test/p0-trusted-transaction-layer.test.js`), covers
exactly this: link → unlink (captures and reuses this exact request's
`requestId`+payload) → relink → resend the captured unlink request verbatim.
Confirmed: the original cached result (`newVersion: 2`) is returned; the
asset remains linked (the relink's outcome is untouched); and the
`transactions` count for this fund stays at 3 — no fourth, duplicate audit
record is created by the replay.

## Client-side asset-link display sync, update-failure visibility, and Firestore rules emulator confirmation (fifth review round)

Before staging the fourth round's changes, a review of the diff itself (not
just running the tests) surfaced two further defects in `src/core.js` that
no test in this repository had exercised, plus two documentation errors.

**`applyConfirmedLinkChange` guessed the outcome from the request's own
direction instead of from server truth.** The fourth round's session-guard
fix (`authSessionSeq`/`sessionStillCurrent`, see the third-round section
above — actually landed in the fourth round) added a helper that, on any
successful `linkAssetToFund` call, toggled `fund.data.assetIds` locally
based on `isUnlinkOp` (i.e., which direction *this specific call* requested).
That is exactly the assumption `functions/index.js`'s replay-cache path
disproves: a successful response can be a **cached result from an earlier
call**, not evidence that the requested direction was just executed. In the
precise `FNDREPLAY` scenario proven server-side in the fourth round (link →
unlink → relink → resend the original unlink request verbatim), the server
correctly no-ops and returns the original cached `{ ok:true, newVersion:2 }`
— but the old client code, seeing a "successful unlink" response, would have
called `applyConfirmedLinkChange(true)` and spliced the asset out of
`fund.data.assetIds` locally, showing "unlinked" in the UI even though the
fund is genuinely still linked (version 3) on the server. A second, separate
bug in the same function: it mutated the `fund` object captured by reference
*before* the first `await` in the handler — if a real-time `onSnapshot`
delivery replaced `STORE.funds[i]` with a new object while the server call
was in flight, the mutation landed on a detached, no-longer-displayed object.

The fix removes all local guessing. A new top-level, unit-testable function,
`applyFetchedFundSnapshot(fundId, fetchedData)` (`src/core.js`, defined next
to `STORE`, exported), replaces a fund's entire `STORE.funds[...]` entry with
whatever was just fetched — it takes no "direction" argument at all, by
design, so it cannot encode this class of bug. It is now the single place
both success paths in the `if-toggle-asset` handler go through
(`refreshFundFromServerAfterSuccess`, called after both the plain success
and the admin-override success, always re-fetching
`DB.collection('funds').doc(fundId).get({ source: 'server' })` — never
trusting the call's own direction), and `handleStaleOrUnknown`'s pre-existing
stale/aborted-rejection refresh (third/fourth round) was refactored to call
the same function instead of duplicating the replace-or-insert logic inline.
Both refresh sites remain guarded by `sessionStillCurrent()` before and
after their `await`, exactly as the fourth round's session-guard already
required elsewhere.

**Update-failure visibility, completed.** The original request (item 2)
asked that a failed update show a clear message and never present stale data
as if it had refreshed successfully. The fourth round's
`handleStaleOrUnknown` added a real server re-fetch on stale/aborted
rejections but only `console.error`'d if that re-fetch itself failed, then
still called `render()` — silently showing old `STORE` data with no
indication anything was wrong. Both refresh sites (`handleStaleOrUnknown`'s
existing one and the new `refreshFundFromServerAfterSuccess`) now `alert()`
the user explicitly when the confirmatory fetch itself fails, stating that
the displayed link status may not reflect the real state and recommending a
reload before any further action on that asset — in both cases gated by
`sessionStillCurrent()` so a failure belonging to an already-abandoned
session never surfaces to the current one.

**Client-side test added, with its scope stated explicitly.**
`tests/features/asset-link-fund-sync.test.mjs` (new, run via `loadCore()`
same as the other `tests/features/*.test.mjs` files) unit-tests
`applyFetchedFundSnapshot` directly: (أ) inserts a fund not yet present in
`STORE.funds`; (ب) reproduces the exact reported scenario as a sequence of
fetched-snapshot applications — unlinked → linked → unlinked → linked →
**apply the "still linked" snapshot one more time** (standing in for the
confirmatory fetch that follows a resent, already-executed unlink request)
— and asserts the fund stays linked, not flipped to unlinked by the resend;
(ج) confirms the replace is a full document swap, not a partial merge (an
unrelated stale field from a previous snapshot does not survive). Confirmed
to **fail** against a deliberately broken no-op variant of
`applyFetchedFundSnapshot` (`AssertionError` reproduced in full), then the
real fix was restored from a pre-edit backup and confirmed byte-for-byte
identical via `diff -q` before re-confirming all three scenarios pass.

This test's scope is deliberately narrow and stated here rather than implied:
it exercises the pure state-sync primitive that both success paths in the
real `if-toggle-asset` handler now call unconditionally — it does **not**
drive the handler itself end-to-end (real DOM `click` dispatch, a mocked
`firebase.functions().httpsCallable`, and `DB.collection(...).get(...)`
together). That remains outside what `tests/domain/core-vm-harness.mjs`'s
stubbed `document`/`window` can exercise, for the same reason the third
round's `ifCollSyncedOnce`/`fromCache` guard and the fourth round's
`authSessionSeq` guard are also not exercised by any automated test in this
repository (see those rounds' sections above) — manual testing against a
real Firebase project remains the only coverage for the handler's full
wiring.

**Functions test count, corrected.** The fourth round's own section above
originally stated "58/58 passed before this round's test additions... then
62/62 passed after" — that was a counting error, not a second run with a
genuinely different result. The actual, re-verified figures (re-run
independently in this fifth round, from a clean `git status` with no
uncommitted changes lost): **54/54** passed before the fourth round's four
additions, **58/58** passed after (54 + 4 = 58: `FNDLEG1`, `FNDLEG2`,
`FNDLEG3`, `FNDREPLAY`). This fifth round changed nothing in
`functions/index.js` or its test file, and a fresh `npm run test:functions`
run in this round reconfirms **58/58**, `check:domain` bundle hash unchanged
(`101bfeac04d9`), `trusted-ic.test.cjs` still **26/26**. `npm run check:js`
now reports **137 files** (136 plus this round's new test file). `npm run
test:features` was extended to chain a third file
(`tests/features/asset-link-fund-sync.test.mjs`) and passes all three files
end to end.

**Firestore rules emulator — actually run, by the user, on their own
machine (first real confirmation in this phase).** Every prior round's
attempt to run `npm --prefix tests/rules test` failed for environmental
reasons only (a `stream-json` module-resolution failure in the second/third
round's cloud sandbox; `Error: firebase-tools no longer supports Java
version before 21` in this round's own `device_bash` Linux VM, which only
has OpenJDK 11). The user ran it directly on their own Windows machine
(confirmed Java 21 installed at
`C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot`) via the single CMD
command provided (`npm --prefix tests/rules test`, equivalently `npm run
test:rules`). Result, as reported by the user: **all tests passed**,
ending in `Script exited successfully (code 0)`, including the newer test
cases that assert a plain client (non-Admin-SDK) request against the
`assetLinkRequests` collection is denied — the `PERMISSION_DENIED` lines
that appear in that run's output are the *expected* assertions inside those
denial tests, not failures. No `firestore.rules` or
`tests/rules/rules.test.mjs` content changed in this round or the fourth
round, so this result was not re-run again after this round's `src/core.js`
edits — it did not need to be, since those edits touch none of the rules
under test.

**This result's scope, stated explicitly (per the user's own correction):**
it proves the specific `firestore.rules` access-control cases the test file
covers — including, now, that a plain client cannot read or write
`assetLinkRequests` directly. It does **not** prove `linkAssetToFund`'s own
server-side transactional concurrency (the Admin-SDK `runTransaction` body
itself, under two genuinely simultaneous competing calls) — that remains
covered only against `functions/test/load-index-with-fakes.js`, whose
`runTransaction` fake has no real isolation between concurrent invocations,
exactly as the fourth round's own "طلبان متنافسان" test comment already
states in `functions/test/p0-trusted-transaction-layer.test.js`. A rules
emulator run, however successful, is not evidence about that separate
concern, and no test in this repository currently is.

## Files in this phase

Originally five files were expected. During item 5's review, one previously-
unexamined bug was found and fixed (per explicit instruction to settle, not
merely flag, the land-first question), adding two more changed files and one
new test file:

  - functions/index.js (modified — land-entry ordering, unlink/delete integrity)
  - src/core.js (modified — deterministic IDs, unlink admin-override UI flow,
    archived fund status label, fund-delete routing)
  - firestore.rules (modified — canonical ID rules, unconditional fund-delete
    denial)
  - firestore.indexes.json (modified — new composite index on capitalCalls
    (fundId, inKindAssetId, status) required by earmarkedInKindForAssetTx's
    query in functions/index.js; see Unlink/delete integrity above)
  - tests/rules/rules.test.mjs (modified — LEDGER_COLLECTIONS smoke-test fix,
    new Phase 2R-4D4-C cases: idempotent/duplicate-execution rejection and
    genuine two-way concurrency for both capitalCalls execution and
    transactions audit logging)
  - functions/test/p0-trusted-transaction-layer.test.js (modified — 14 + 6 new
    tests)
  - functions/test/fakes/firebase-admin-firestore.js (modified — tx.delete())
  - functions/scripts/legacy-inkind-audit.cjs (new — read-only legacy audit)
  - docs/PHASE_2R_4D4C_HANDOFF.md (new — this file)
  - src/features/capital-allocation-engine.js (new to this phase's changes —
    land-first fix: cashPaidIn instead of paidIn in deployableCashForFund)
  - tests/features/capital-allocation-engine.landfirst.test.mjs (new — land-
    first regression test for the fix above)
  - package.json (modified — added test:features script, wired into the
    aggregate test script, so the new test actually runs rather than only
    being syntax-checked by check:js)

A second round of review (see the two new sections above) found two further
real gaps in five of the files already listed above and added one more test
file, without changing which files are in scope:

  - functions/index.js — additionally: allocatedElsewhereTx now deducts only
    each other asset's cash portion (targetEquity minus its own executed
    in-kind coverage), floored at zero; a new nextAssetLinkSeqTx helper gives
    each assetLink transaction a sequence-numbered id (assetLink-<oppId>-<seq>)
    instead of a random one; the link branch's paidIn/earmarkedForThisAsset
    computation is now keyed on inKindAssetId presence so a reversed in-kind
    contribution nets to zero instead of leaking as phantom negative cash
  - firestore.rules — additionally: removed the type=='assetLink' client-
    create exception from the /transactions/{id} create rule entirely, for
    every role including admin
  - src/core.js — additionally: the if-toggle-asset local fallback now
    refuses cleanly with an alert when a real Firestore backend is configured
    but the Functions SDK is not, instead of attempting a client write that
    firestore.rules would reject
  - src/features/capital-allocation-engine.js — additionally:
    allocatedElsewhereInFund mirrors the same cash-only, floored-at-zero
    deduction as the server; deployableCashForFund gained the
    earmarkedForThisAsset self-exception the server already had (a server/UI
    parity gap found while testing the fix above)
  - functions/test/p0-trusted-transaction-layer.test.js — additionally: 7 new
    test blocks (49 total, up from 41)
  - tests/features/capital-allocation-engine.landfirst.test.mjs — rewritten
    from 2 to 7 scenarios (9 assertions)
  - tests/rules/rules.test.mjs — additionally: the single assertSucceeds case
    proving the assetLink client-write gap was replaced with two assertFails
    cases (fund_manager and admin)

A third review round (see the new section above) found and fixed a cross-fund
id collision and, at the user's explicit request, closed a pre-existing
stale-request architectural gap with an expectedVersion+requestId system,
touching four of the files already in scope and adding no new files:

  - functions/index.js — additionally: assetLink transaction ids now embed
    fundId (assetLink-<fundId>-<oppId>-<seq>, was assetLink-<oppId>-<seq>);
    nextAssetLinkSeqTx replaced by assetLinkEventCountTx (same query, returns
    the raw count, doubles as the version); linkAssetToFund rewritten to
    require and check expectedVersion + requestId inside the same transaction
    as the mutation, replacing the old existing-state-only no-op guards; new
    assetLinkRequestPayloadsMatch helper
  - firestore.rules — additionally: new assetLinkRequests/{id} — allow read,
    write: if false — match block (Admin-SDK-only bookkeeping for
    linkAssetToFund's idempotent replay); updated comment on the /transactions
    assetLink-exception-closure explaining the new protection
  - src/core.js — additionally: new hashStr() helper; if-toggle-asset's
    useServerFunction branch rewritten to compute expectedVersion from
    STORE.transactions and a deterministic requestId, refuse to guess a
    version before the transactions collection has synced from the server at
    least once (new ifCollSyncedOnce tracking, gated on
    !snap.metadata.fromCache, cleared on sign-out/switch), and handle an
    aborted/stale rejection with a clear reload message and no automatic retry
  - functions/test/p0-trusted-transaction-layer.test.js — additionally: new
    withLinkDefaults() test helper; 4 new scenarios (identical-retry replay,
    stale-version rejection, same-version race/rejection, missing/malformed
    version+requestId rejection, requestId-reuse-with-different-reason
    rejection — 5 scenarios in total, one test covers two of the four
    user-specified points); 1 pre-existing test corrected (FNDU6: a fresh
    unlink at version 0 against a never-linked asset is now a caught
    failed-precondition, not a silent no-op — a deliberate tightening found by
    actually running the suite, not by inspection); all ~33 pre-existing
    linkAssetToFund call sites converted to route through withLinkDefaults();
    54 total, up from 49 (see Verification for the actual run, not just this
    count)
  - tests/rules/rules.test.mjs — additionally: new assetLinkRequests-denial
    case (write and read, fund_manager and admin) — syntax-checked only, not
    yet run against a real emulator (see Verification)

A fourth review round (see "Legacy in-kind cash-exclusion classification,
stale-session write protection, and idempotent-replay-after-later-events"
above) fixed the legacy in-kind cash-classification gap, closed a
stale-session write-to-STORE gap, and added a replay-after-later-events
test, touching two of the files already in scope and adding two new files:

  - functions/index.js — additionally: new isInKindCapitalCallRecord(data,
    byId, seen) helper (checks inKindAssetId/linkedCommitmentId directly,
    falls back to the original record via reversalOfId, never assumes cash
    for an unresolvable reference); the link branch's paidIn loop now builds
    a paidCallsById map and classifies through this helper instead of
    checking inKindAssetId alone
  - src/core.js — additionally: new isInKindCapitalCall(rec, byId, seen)
    helper (same logic as functions/index.js's, for parity) used by
    fundLedgerSummary's cashPaidIn instead of checking linkedCommitmentId
    alone; new authSessionSeq counter (declared beside currentUser),
    incremented in onAuthStateChanged only on an actual uid change; if-toggle-
    asset captures it as __startAuthSessionSeq/sessionStillCurrent() and
    checks it before any STORE write, alert, or render past an await;
    handleStaleOrUnknown now also re-fetches this fund's own document from
    the server (not only transactions) and updates STORE.funds; a new
    applyConfirmedLinkChange(isUnlinkOp) closure reconciles fund.data.assetIds
    against its own current membership (not the pre-await linking flag or a
    transactions count) on a confirmed successful response
  - functions/test/p0-trusted-transaction-layer.test.js — additionally: 3 new
    legacy in-kind classification scenarios (FNDLEG1/FNDLEG2/FNDLEG3) and 1
    new replay-after-later-events scenario (FNDREPLAY); 58 total, up from 54
    (corrected in the fifth round below — this paragraph originally said 62
    total, up from 58, which was a counting error; see Verification for the
    actual, re-confirmed run)
  - tests/features/fund-ledger-inkind-classification.test.mjs (new — client-
    side parity test for fundLedgerSummary's cashPaidIn, invoking the real
    function via tests/domain/core-vm-harness.mjs, not a mock)
  - package.json (modified — test:features now chains both
    tests/features/*.test.mjs files with &&, so the new test actually runs)

A fifth review round (see "Client-side asset-link display sync, update-
failure visibility, and Firestore rules emulator confirmation" above) fixed
the client-side direction-guessing bug and the silent-refresh-failure gap,
and added one new test file, touching two of the files already in scope:

  - src/core.js — additionally: new top-level applyFetchedFundSnapshot(fundId,
    fetchedData) helper (exported) that wholesale-replaces a
    STORE.funds[...] entry with a freshly fetched document, taking no
    direction argument; the old applyConfirmedLinkChange(isUnlinkOp) closure
    removed entirely and both if-toggle-asset success paths now call a new
    refreshFundFromServerAfterSuccess() (always re-fetches
    DB.collection('funds').doc(fundId).get({source:'server'}) after any
    successful server response, cached-replay or fresh alike) instead;
    handleStaleOrUnknown's own pre-existing fund refresh was refactored to
    call the same applyFetchedFundSnapshot; both refresh paths now alert()
    the user explicitly (instead of only console.error) if the confirmatory
    fetch itself fails, so a failed refresh is never shown as a silent
    success
  - package.json (modified — test:features now chains a third file,
    tests/features/asset-link-fund-sync.test.mjs)
  - tests/features/asset-link-fund-sync.test.mjs (new — unit test for
    applyFetchedFundSnapshot; see the fifth-round section above for its
    three scenarios and its explicitly stated scope)
  - docs/PHASE_2R_4D4C_HANDOFF.md (this round's section, plus corrections to
    the fourth round's mis-stated test counts in this section and the one
    above)

This list, and the diffs behind it, are presented for review before any git
staging or commit — see the separate file-list/diff message for this phase.
Excluded from this list and from staging: temporary/scratch files (the
throwaway smoke-test harness used to exercise the audit script against fake
data; two tests/rules/hs_err_pid*.log crash-dump files and one
tests/rules/.fuse_hidden* temp file, all noticed in git status as debris
from earlier, environment-blocked attempts to run the rules emulator inside
a sandboxed shell — none of these three are referenced by any code or test
and none have been deleted or moved without the user's own action), the
~100 files affected by the repository-wide line-ending anomaly described
below, and the pre-existing protected modifications (firebase.json,
functions/monday-sync.js, functions/test/load-index-with-fakes.js) and
protected untracked files that are no part of this phase.

## Verification

tests/rules/rules.test.mjs, run against the real Firestore emulator
(`npm --prefix tests/rules test`) on the user's machine: full suite passed, exit
code 0, including the new Phase 2R-4D4-C cases (blocked/overridden/idempotent
unlink, the land-first earmark exception and its negative case, and the genuine
Promise.allSettled concurrency cases for both capitalCalls execution and
transactions audit logging). A pre-existing generic role-access smoke test
(the LEDGER_COLLECTIONS loop) was found broken by the new canonical-ID
requirement during this same run and fixed in the same file (a hardcoded literal
ID for the transactions collection could no longer satisfy transactionCanonicalId);
the fix was applied and the suite re-run to a full pass.

functions/ Functions-level suite (fakes-based, not a Rules or concurrency
certification on its own — see the file's own header), run on the user's machine
(`npm --prefix functions test`): check:domain unchanged (bundle hash
101bfeac04d9); p0-trusted-transaction-layer.test.js at 41/41, comprising the
existing 27 plus 14 new cases added this phase for linkAssetToFund's unlink-
blocking/admin-override/audit-write and the land-first bootstrap exception, and
for archiveOrDeleteFund's archive-vs-hard-delete branching (zero-history delete,
any-history archive including transactions-only history, already-archived
rejection, missing-fund not-found, non-fund_manager permission-denied); a
second review round (see the new sections above) added 7 more scenarios —
two-asset land-first ordering in both directions, a mixed-financing exact-
boundary pass, a mixed-financing one-over-boundary rejection, an excess-in-
kind floor case, an unexecuted-commitment exclusion case, a reversed-
contribution netting case, and an assetLink sequencing/dedup/relink case —
bringing this file to 49/49.
trusted-ic.test.cjs at 26/26, unchanged. The shared fakes harness
(functions/test/fakes/firebase-admin-firestore.js) needed one additive fix,
tx.delete(), for archiveOrDeleteFund's hard-delete branch, which no test had
exercised before this phase; this was verified in a temporary, automatically-
restored swap before being applied to the real file, and confirmed unchanged
afterward by a byte-for-byte comparison against the pre-edit original.

src/core.js's eleven UI-layer edits (asset-picker broadening, deterministic
capitalCalls/transactions IDs with duplicate-submission handling, the archived
fund-status label, the fund-delete button routing to archiveOrDeleteFund, and the
unlink admin-override retry flow) were syntax-checked (node --check) and
independently confirmed on the user's own machine: git status showing the
expected file as modified, git diff --stat showing 96 insertions/17 deletions,
and a passing node --check.

functions/scripts/legacy-inkind-audit.cjs was syntax-checked (node --check) and
its classification/verification/duplicate/missing-reference/reversal logic was
smoke-tested against seeded fake Firestore data (not production): a valid
linkedToAsset call, a missingAssetLink (legacy) call, an ordinary cash call
(correctly excluded entirely), a genuine duplicate pair sharing one
linkedCommitmentId, a call referencing a nonexistent commitment, a call
referencing a nonexistent asset, and a reversal entry correcting an earlier
execution were all correctly separated into their respective categories — and a
false positive found during this same smoke-testing (an execution and its own
reversal, sharing a linkedCommitmentId by design, was initially miscounted as a
duplicate) was fixed by excluding reversal entries from duplicate-grouping, then
re-verified. The script has not been run against real production data — that
requires Application Default Credentials on the actual target project, which
only the user can provide and confirm (see Credentials above), and has been
deferred pending that review.

src/features/capital-allocation-engine.js's land-first fix (cashPaidIn instead
of paidIn in deployableCashForFund) was verified with a new, purpose-built
regression test (tests/features/capital-allocation-engine.landfirst.test.mjs):
run directly with `node tests/features/capital-allocation-engine.landfirst.test.mjs`,
or via `npm run test:features` (now also part of the aggregate `npm test`). The
test invokes registerCapitalAllocationEngine's asset-link guard directly through
a minimal fake core object (no DOM, no Firestore) and asserts two things: (1) a
fund with SAR 500,000 total paid-in of which SAR 400,000 is in-kind value
earmarked to a different asset (real cash: SAR 100,000) correctly BLOCKS a
SAR 300,000 allocation request for an unrelated asset, citing the real cash-only
figure in its message; (2) the same request against a fund with SAR 300,000 of
genuine cash (no in-kind at all) is correctly ALLOWED, so the fix does not
over-block real cash. Confirmed to fail against the pre-fix source (asserting
the exact regression this fix closes) and pass against the fixed source, both
directly and via `npm run test:features`; `npm run check:js` (136 files) passes
with the new and modified files included.

During the second review round, this test file was rewritten from 2 to 7
scenarios (9 assertions) to also cover: two-asset land-first ordering in both
directions (the order-dependent double-deduction bug found and fixed this
round), a mixed-financing asset consuming only its cash portion at an exact
boundary, excess in-kind coverage not manufacturing spare cash (floored at
zero), and server/UI parity for the earmarkedForThisAsset self-exception in
deployableCashForFund (a gap found during this round's own testing, where the
client guard had never implemented the exception the server always had for an
asset's own in-kind coverage satisfying its own target). Confirmed passing via
node tests/features/capital-allocation-engine.landfirst.test.mjs run directly
from the real repo, and via npm run test:features.

The firestore.rules assetLink exception closure and functions/index.js's new
sequence-numbered assetLink ids (assetLink-<oppId>-<seq>) were verified
together: the two new tests/rules/rules.test.mjs cases (assertFails for both a
fund_manager and an admin client attempting to create a type=='assetLink'
transaction directly) were syntax-checked (node --check) at the time, then
later actually confirmed against a real Firestore emulator — see the PASS
recorded below. The retry/no-op and sequencing behavior (a retried request
produces no extra transaction; link, unlink, and re-link each produce exactly
one document with a correctly increasing sequence number) was verified
against the fakes-based p0-trusted-transaction-layer.test.js suite above,
which is not a substitute for real emulator concurrency or rules
certification.

**Real-emulator PASS (second review round content)**: the user independently
ran `npm --prefix tests/rules test` on their own machine (java -version
reporting openjdk 21.0.12.1, Microsoft-14941484 build 21.0.12.1+1-LTS,
resolving the earlier Java-version blocker) and reported a full pass, exit
code 0, including both new assetLink assertFails cases. This PASS covers the
rules.js content as it stood through the second review round. It does **not**
cover the third round's `assetLinkRequests` match block or its new
rules.test.mjs case below — both were added after this run.

**Third review round — functions test suite, actually executed**:
p0-trusted-transaction-layer.test.js was run for real in this session's cloud
sandbox (not the device-bash VM that hit the tool-availability and Java
blockers earlier — a separate, working Node environment), using the same
unmodified fakes harness (`functions/test/load-index-with-fakes.js`,
`functions/test/fakes/*`, both staged read-only, never edited) with
functions/index.js, the rewritten test file, and the small supporting files
it `require()`s (`trusted-ic.cjs`, `monday-sync.js`, `monday-webhook.js`, also
read-only, unmodified). First run: 53 passed, 1 failed — a genuine, real
failure, not a harness artifact — the `FNDU6`/`OPPU6` "duplicate unlink" test
(see the section above for why this was a correct tightening, not a
regression, and rewritten rather than the code being changed to accommodate
the old assertion). After correcting that one test: **54 passed, 0 failed**,
exit code 0. Full console output was captured and reviewed line by line, not
sampled.

`trusted-ic.test.cjs` was **not** re-run this round — it needs
`functions/generated/manifest.json`, produced by `npm run build:domain`,
which was not reproduced in this sandbox (this file, the domain engine it
depends on, and the build script were all untouched this round). Its
last-confirmed count remains 26/26 from a prior round; that count is not
re-verified here and should not be read as re-confirmed by this round's work.

**Third review round — rules test, not yet run against a real emulator**:
the new `assetLinkRequests`-denial case in tests/rules/rules.test.mjs
(read/write, fund_manager and admin) is syntax-checked (`node --check`) only.
This sandboxed cloud environment cannot run it against a real emulator for
the same reason documented at the top of that file — a version conflict
between firebase-tools and the `stream-json` override in
tests/rules/package.json (`Cannot find module '.../stream-json/src/filters/
Pick'`), unrelated to the earlier Java blocker and not resolved by it. Because
`tests/rules/package.json`'s `pretest` script copies the repository root's
firestore.rules into tests/rules/ fresh before every run, the user's next
`npm --prefix tests/rules test` will automatically pick up the new
`assetLinkRequests` rule and exercise the new case — no manual file sync
needed — but until that run happens, this specific rule and its test remain
**unverified against a real rules engine**, and the second-round PASS above
must not be read as covering them.

**Third review round — client-side sync-state guard, not exercised by any
test**: `src/core.js`'s `ifCollSyncedOnce`/`fromCache` guard (see the section
above) was verified only by reading the code and reasoning about Firestore's
documented `onSnapshot`/`metadata.fromCache` behavior — `node --check` passes,
but there is no browser-based or Firestore-SDK-driven test harness in this
repository for `src/core.js`'s listener logic, so this has not been exercised
by execution at all, automated or manual.

**Fourth review round — functions test suite, actually executed (count
corrected in the fifth round below — read this paragraph together with
that correction)**: this session's sandbox `device_bash` shell (a Linux VM
with this repository mounted from the user's machine, distinct from both
the user's own machine and the earlier cloud sandbox referenced in the
third round above) ran `node functions/test/p0-trusted-transaction-layer.test.js`
directly. Result: **54/54 passed** before this round's test additions
(the third round's baseline), then **58/58 passed** after adding the 3
legacy in-kind scenarios (FNDLEG1/FNDLEG2/FNDLEG3) and the 1
replay-after-later-events scenario (FNDREPLAY) — 54 + 4 = 58. (An earlier
draft of this paragraph mistakenly stated 58 before / 62 after; that was
a counting error, not a second run with a different result — see the
fifth round's correction, which re-ran the suite independently and
confirmed 58/58 as the actual, current total.) Each of the three new
legacy-classification tests was
also confirmed to **fail** against a deliberately reintroduced pre-fix
variant before being left in its passing, fixed state: FNDLEG1 was run
against the exact `inKindAssetId`-only check being replaced (failed, as
expected — the legacy record was wrongly treated as cash); FNDLEG2 was run
both against that same pre-fix variant (passed by coincidence, documented in
the test's own comment: original and reversal net to zero either way) and
against a "naive" intermediate variant that checks both markers directly but
has no `reversalOfId` fallback (failed, as expected — the legacy reversal's
negative amount leaked into `paidIn`, producing `-100000` and a wrong
rejection); the source was restored to the real fix after each check
(`diff -q` confirmed byte-for-byte identical to the pre-check state). `npm
run test:functions` (lint + `check:domain` + both functions test files) was
also run end to end: exit code 0, `check:domain` bundle hash unchanged
(`101bfeac04d9`), `trusted-ic.test.cjs` still 26/26.

**Fourth review round — client-side parity test, actually executed**: the
new `tests/features/fund-ledger-inkind-classification.test.mjs`, run
directly and via `npm run test:features` (now chains both
`tests/features/*.test.mjs` files), passed all 3 scenarios against the fixed
`fundLedgerSummary`. Confirmed to **fail** against the pre-fix
`!c.data.linkedCommitmentId`-only check specifically on the reversal
scenario (asserting `cashPaidIn` stayed at 100000; it actually computed
-100000 against the pre-fix code, an `AssertionError` reproduced and shown
in full, not just described), then restored and re-confirmed passing.
`npm run check:js` (136 files, including this new test file) and
`npm run test:financial` (25/25) and `npm run test:performance` were also
run end to end after these changes: all exit code 0, no regression.

**Fourth review round — rules test, attempted, still blocked in every
sandboxed environment tried so far, not a new blocker**: `npm --prefix
tests/rules test` was attempted from this same `device_bash` Linux VM.
Result: `Error: firebase-tools no longer supports Java version before 21.
Please install a JDK at version 21 or above` (this VM has OpenJDK 11) — a
different specific error than the third round's `stream-json` module-
resolution failure documented in the cloud sandbox, but the same underlying
fact: **no environment available to this session can run the real Firestore
emulator**, so the `assetLinkRequests`-denial case from the third round
remains unverified against real rules, exactly as documented then. This
round did not add or change any `firestore.rules` content — see "Files in
this phase" above — so there is nothing new for this specific run to cover;
it was attempted regardless, for completeness, and to record the actual
current blocker rather than assume the third round's blocker still applies
unchanged. Running this on the user's own machine (which the third round's
PASS confirms has a working Java 21 and a working `tests/rules`
installation) remains the only way to close this specific verification gap.

**Fifth review round — Firestore rules emulator, actually run by the user
on their own machine, this specific gap now closed**: with Java 21 confirmed
installed (`C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot`), the user
ran `npm --prefix tests/rules test` (equivalently `npm run test:rules`)
directly, using the single CMD command already provided above, and reported
back the actual output: all tests passed, ending in `Script exited
successfully (code 0)`, including the `assetLinkRequests`-denial cases
carried over unchanged from the third round (a plain client request, for
both `fund_manager` and `admin`, is denied both read and write access to
`assetLinkRequests/{id}` — the `PERMISSION_DENIED` lines visible in that
run's output are the expected assertions inside those denial tests, not
failures). This is the first time in this phase that a real Firestore
emulator has actually executed against this repository's `firestore.rules`
and `tests/rules/rules.test.mjs` — every earlier attempt (second, third, and
this round's own fourth-round attempt above) was blocked purely by the
environment (a `stream-json` resolution failure, then two different
too-old-Java errors), never by an actual rule failure. No `firestore.rules`
or `tests/rules/rules.test.mjs` content changed in the fourth or fifth
round, so this single run stands for both. **Scope, stated explicitly, per
the user's own correction during review:** this proves the `firestore.rules`
access-control cases the test file covers, including the `assetLinkRequests`
denial. It does **not** prove `linkAssetToFund`'s own server-side
transactional concurrency — the Admin-SDK `runTransaction` body itself,
under two genuinely simultaneous competing calls — which remains covered
only against the fakes harness's non-isolated `runTransaction`, exactly as
already stated in `functions/test/p0-trusted-transaction-layer.test.js`'s
own "طلبان متنافسان" test comment. A rules-emulator PASS is not evidence one
way or the other about that separate, still-open concern.

**Fourth review round — client-side session-guard, not exercised by any
test (superseded in part by the fifth round below)**: `src/core.js`'s
`authSessionSeq`/`sessionStillCurrent()` guard and the (now-removed)
`applyConfirmedLinkChange`/fund-refetch logic this paragraph originally
described were verified only by reading the code and by `node --check` —
for the same reason as the third round's `ifCollSyncedOnce`/`fromCache`
guard just above, this repository has no browser-based or Firestore-SDK-
driven test harness for `src/core.js`'s `if-toggle-asset`/`onAuthStateChanged`
interaction, so neither guard was exercised by execution, automated or
manual, as of the fourth round.

**Fifth review round — client-side fund-display sync, partially closed by a
new unit test; the full handler wiring remains unexercised**: the fifth
round's `applyFetchedFundSnapshot` (`src/core.js`, replacing the removed
`applyConfirmedLinkChange`) is, unlike everything else in this paragraph,
now actually exercised by an automated test —
`tests/features/asset-link-fund-sync.test.mjs`, run directly and via `npm
run test:features` (now chaining three files). All three scenarios passed;
the test was also confirmed to **fail** (an `AssertionError`, reproduced in
full) against a deliberately broken no-op version of
`applyFetchedFundSnapshot` before the real fix was restored from a pre-edit
backup, confirmed byte-for-byte identical via `diff -q`, and re-confirmed
passing. `npm run check:js` (137 files), `npm run test:functions` (58/58,
`check:domain` hash unchanged, `trusted-ic.test.cjs` 26/26), and the full
`npm run test:features` chain were all re-run end to end after these edits:
exit code 0 throughout, no regression. **What remains unexercised, stated
precisely**: this test covers only the pure `applyFetchedFundSnapshot`
function in isolation — it does not drive `if-toggle-asset`'s real `click`
dispatch, a mocked `firebase.functions().httpsCallable`, or
`DB.collection(...).get(...)` together in one run, and it does not exercise
`authSessionSeq`/`sessionStillCurrent()` at all (that guard, and the
handler's DOM/Firebase wiring as a whole, remain exactly as unexercised as
the paragraph above already states — this round narrows, but does not
close, that gap).

Not tested by any of the above, and not claimed here: an actual Firebase
Functions deployment of linkAssetToFund or archiveOrDeleteFund; manual
UI/browser exercise of the new in-kind execution, unlink-override, archive/
delete, or capital-allocation-linking flows inside the running app; concurrency
beyond the two simultaneous writes exercised per scenario; any real-data legacy-
record count (the audit script has only been exercised against fakes); any
interaction between the capital-allocation-engine.js fix and a real browser DOM
(the new test exercises only the pure guard-decision closure, not
registerDetailSection's or registerActionHandler's DOM-touching code, which is
unchanged by this fix); and, from the third review round, genuine concurrent-
transaction serialization for linkAssetToFund's expectedVersion check (the
fakes-based "two conflicting requests" test is sequential, proving only the
rejection logic — see its own section above) and any execution at all,
automated or manual, of src/core.js's ifCollSyncedOnce/fromCache sync-state
guard; and, from the fourth review round, any execution at all, automated or
manual, of the authSessionSeq/sessionStillCurrent session-guard against a
real browser DOM or a real Firestore backend (the fourth round's
applyConfirmedLinkChange itself no longer exists — removed in the fifth
round below, and its replacement is now partially covered; see that
paragraph). From the fifth review round: genuine concurrent-transaction
serialization for linkAssetToFund's own Admin-SDK runTransaction body — the
fifth round's real rules-emulator PASS (see above) certifies firestore.rules
access-control only, and explicitly does not speak to this; the full
if-toggle-asset click handler exercised end to end (real DOM dispatch, a
mocked firebase.functions().httpsCallable, and DB.collection(...).get(...)
together in one run) — only the extracted applyFetchedFundSnapshot function
is unit-tested, not the handler that calls it; and authSessionSeq/
sessionStillCurrent interacting with refreshFundFromServerAfterSuccess or
with handleStaleOrUnknown's new alert-on-refresh-failure under an actual
mid-flight user switch — this remains verified only by reading the code, as
it was in the fourth round.

Specifically on the new firestore.indexes.json composite index: the fakes-based
p0-trusted-transaction-layer.test.js confirms earmarkedInKindForAssetTx's three-
field filtering LOGIC is correct (FakeQuery supports chained where() calls with
in-memory filtering), but the fake has no concept of an index at all, so it
cannot and does not confirm whether real Firestore needs, or is satisfied by,
this composite index. tests/rules/rules.test.mjs does not cover this either — it
exercises client-facing firestore.rules against the real emulator, not this
Admin-SDK-only server function. Confirming the index is correct against a real
Firestore project (or the emulator with a real Admin SDK call) is deferred to
deployment, alongside the rest of this phase's undeployed Cloud Functions
changes; the index must be deployed together with (or before) functions/index.js
for this query not to fail the first time this code path executes for real.

## Remaining boundaries

The meta.createdBy/capitalAllocation permission-model review noted above remains
open — flagged, not fixed. Historical (pre-4D4-B) in-kind capitalCalls are not
retroactively modified, validated, or migrated by anything in this phase; the new
audit script only surfaces them for manual review. Standing phases from the
existing roadmap — 4E (audit/versioning integration), 4F-1 (complex opportunity
modeling), 4F-2 (returns engine/XIRR-MIRR audit), 4F-3 (AI analysis layer), Phase
5 (release/deployment readiness, requiring explicit approval before any
production deployment), and Phase 6 (historical data cleanup) — remain open and
outside this phase's scope.

Separately observed during this session, unrelated to this phase's files:
roughly 100 files across the repository (documentation, tests/domain baselines,
storage.rules, functions/generated, CI config, and others never touched by any
phase) show as modified in git status. A byte-level, EOL-normalized diff check
confirmed that the two specific files actually sampled (README.md and
tests/domain/financial-golden-master.json) have no content difference once line
endings are normalized — only a pure LF-to-CRLF flip on those two. That check
covers only those two files; it does not establish that all ~100 affected files
are free of real content changes, only that the two sampled ones are. The cause
of the flip is not established and is not addressed by this patch, per the
user's own decision to leave those files as-is for now; they remain modified-
but-unstaged and untouched by this commit. package.json, modified in this phase
to add the test:features script, was confirmed to already use CRLF line endings
at HEAD before this edit, and the edit preserves that convention exactly (one
added/changed line, no line-ending churn) — it is not part of the ~100-file
anomaly and was not affected by it.

src/core.js — one of this phase's own files — was found, while preparing this
phase's final diff for review, to have independently picked up the same
LF-to-CRLF flip since its last independent verification (git diff --stat showing
10,513 changed lines against HEAD, versus the previously-verified 96
insertions/17 deletions). Byte-level inspection confirmed every CR in the
working copy was part of a CRLF pair (no stray bare CR), and stripping them
reproduced exactly the previously-verified 96/17 diff with no other content
difference. The working copy was normalized back to LF (HEAD's own convention
for this file) before staging, specifically so this phase's commit carries only
its intended 96/17 change and does not silently re-encode the entire file's
line endings as a side effect. This does not explain the repo-wide anomaly — it
only confirms this one file's real content was unaffected by it, and keeps this
phase's diff clean of it.

No Monday integration files, the protected fakes loader
(functions/test/load-index-with-fakes.js), or any financial/domain engine file
were changed by this phase.
