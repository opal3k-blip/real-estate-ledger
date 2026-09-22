# Rules review checkpoint — 2026-09-22

Baseline: user-supplied phase2r4c-rules-review.zip, including pre-existing uncommitted
changes. The server implementation commit 15cc447 is already pushed; no Firebase
deployment has been confirmed.

The emulator now starts on the user's Windows machine with Microsoft Java 21.
The original suite stopped after three successful cases because a historical test
expected a non-owner Senior IC to update opportunity.ic from the client. The current
rules deny that write. This patch changes tests only; firestore.rules is untouched.

## Test corrections

15 obsolete success expectations now require client rejection: the IC update,
commitment reversal, capital-call reversals, ledger draft edits and status transitions.
Approved and paid ledger states are explicitly seeded using rules-disabled fixture
setup before testing their protection. This setup is not evidence that a callable
or a real transaction succeeded. Existing unrelated tests, including Monday and
underwriting-version tests, remain in place.

Local verification: JavaScript syntax and patch application against the uploaded
test file. The complete emulator suite has NOT been run in this preparation
environment (Firebase dependencies are absent). Next: apply the patch on Windows
and rerun npm --prefix tests/rules test in the Java-enabled CMD window.

## Open security items — not a final security certificate

Static inspection of the supplied rules shows:

1. icDecisions allows client creation by Senior IC, Fund Manager and admin. It does
   not bind the submitted evaluation/identity fields to a server computation. This
   undermines the server-only audit boundary, despite update/delete protection.
2. opportunities creation checks authorization and attribution but does not prevent
   prepopulated IC decisions. Update protection alone cannot close that path.
3. Admin IC updates remain explicitly permitted, documented as a deferred user
   decision. This patch does not change that exception.
4. funds creation accepts assetIds; changesAssetIds only protects subsequent updates.
5. capitalCalls/distributions creation still permits reversalOfId with negative
   amounts when the status is pending/declared; in-kind calls accept an unverified
   linkedCommitmentId. The existing in-kind test uses a nonexistent commitment.

These are code-review findings; new emulator exploit reproductions and scoped
remediation are still needed. Existing tests of permitted behavior are retained as
characterization, not endorsed as the desired final policy. Passing this suite does
not close these items or certify callable concurrency/production deployment.

Do not stage all of the user's modified rules test file blindly. Before committing,
separate this patch's changes from pre-existing user edits. Keep the original upload
as the review baseline; never restore/reset the user's file to the repository version.
