# XIRR-R1B1 — residual valuation workflow (server, rules, tests)

Code: `functions/fund-valuations.cjs` (logic), `functions/index.js` (11 callables), `firestore.rules` (4 collections). Pure checks: `src/domain/financial/xirr/residual-valuation.js` (R1-A selector, plus the eligibility input and `validateValuationCandidate`, shipped to the server through `functions/generated` by `npm run build:domain`).
Scope of B1: **storage, review, approval and eligibility suspension only. No UI, no Net XIRR rate, no deployment.** The UI still shows no rate (`NAV_BASIS_UNRESOLVED`); `portfolio.js` / `command-center.js` are untouched. Rate enabling is R1-C.

## 1. Declared limitation: global roles, no per-fund entitlement
Roles are global (`team_roles/{email}.role`; an admin e-mail is always `admin`). The ledger has no user-to-fund binding (funds carry no manager / members / owner), and **B1 has no per-fund permission**: any holder of an allowed role may act on **any** fund, and any holder of a read role may read every fund's valuations. B1 does not simulate a per-fund permission. Reads are narrowed to the three roles in §4 (rule `canReadFundValuations()`); the generic `isAuthorized()` is no longer enough.

## 2. Collections (all written only by Admin SDK; no client write, admin included)
| collection | key | content |
|---|---|---|
| `fundValuations` | auto id | one version/draft: content (currency, basis, components, residualValue, method, methodNote, source, nonOverlap, coverage), `state`, `status` (`draft`\|`approved`, the R1-A field), `enteredBy`, `contributors[]`, `baseHeadId`, `scopeSnapshot` (+`scopeHash`), `contentHash`, `validation`, `review`, and at approval `approvedBy`, `approvedAt`, `version`, `supersedes` |
| `fundValuationHeads` | `{fundId}__{valuationDate}` | write-time guard only: `headId`, `version`, `headHash`, `eligibility{state,changedBy,changedAt,reasonCode,reason}`, `activeDraftId` (the one-draft slot) |
| `fundValuationEvents` | auto id | append-only audit (type, actor, role, at, details) written in the same transaction as the effect |
| `fundValuationRequests` | `sha256([actor, requestId])` | `{actor, action, targetId, payloadHash, result}`; closed to every role (read and write) |

The selector remains the truth for which valuation is effective; the head pointer is checked against the approved chain read in the same transaction and any disagreement blocks (`HEAD_POINTER_INCONSISTENT`), it is never silently repaired.

## 3. States and transitions
`draft → submitted → reviewed → approved`; `submitted|reviewed → returned → (edit) draft`; `submitted|reviewed|returned → rejected`; `draft|returned|submitted|reviewed → withdrawn`. Active states (draft, returned, submitted, reviewed) hold the slot; approved, rejected and withdrawn release it. `status` is `approved` only on an approved version.

## 4. Roles per action (explicit lists, evaluated at execution time from the CURRENT role)
**Decision of Opal, 2026-10-08 15:36 — this matrix replaces every earlier, broader approval (including the 10:41 one).** `fund_manager` prepares only; `senior_ic` and `admin` review and decide; `analyst` has no access at all.
| action (callable) | allowed roles | person conditions |
|---|---|---|
| createDraft / updateDraft | fund_manager, admin | the editor becomes a contributor |
| submit (`submitValuation`) | fund_manager, admin | **and** a contributor of the draft |
| withdraw | fund_manager, admin | **and** a contributor of the draft |
| review, return, reject | senior_ic, admin | **not** a contributor |
| approve | senior_ic, admin | not a contributor, not the preparer; admin is not exempt; the reviewer may approve if not a contributor |
| suspend | senior_ic, admin | reason required |
| reinstate | senior_ic, admin | not the suspender; not a contributor or approver of that version; the restoration controls (acknowledgement + reason) stay |
| preview (read-only callable) | fund_manager, senior_ic, admin | same audience as the client read rule |
| **client read** of `fundValuations`, `fundValuationHeads`, `fundValuationEvents` (Firestore rules) | fund_manager, senior_ic, admin | analyst and non-members cannot read |
| client read/write of `fundValuationRequests`; client create/update/delete of the other three | nobody (admin included) | server-only (Admin SDK) |

Separation of duties is unchanged. Because no non-admin role is in both the preparer list and the reviewer list, a person is a contributor and a reviewer only if their role changed in between (or they are `admin`); in both cases the contributor/preparer checks refuse review, return, reject, approve and reinstate (tested by changing the role after contributing). The reviewer may approve if not a contributor. Narrowing is the only change in this revision; nothing was added.

**Expectations are independent of the code.** `functions/test/helpers/valuation-approved-matrix.cjs` holds this table as a hand-written literal; the unit test and the table-driven emulator test compare the implementation against it (never against `ROLE_LISTS`), and the rules test carries its own literal for reads. Widening any role list or the read rule fails a test.

A past contribution never grants a permission: a contributor who lost the role (or the team membership) cannot update, submit or withdraw. A "contributor" is the creator or any editor of the draft.

## 5. Order of checks (same in every mutating action; tested)
Outside the transaction (early refusals, **not authoritative**): 1. caller identity; team membership and current role (cheap refusal); 2. request shape: a **per-action allow-list of top-level payload keys** (`ALLOWED_KEYS` in `fund-valuations.cjs`; any other key is refused with `PAYLOAD_UNKNOWN_FIELD`, never ignored), `requestId` 8–64 chars `[A-Za-z0-9_-]`, content whitelist, unsafe keys refused.
Inside **one transaction** (everything below is read in it): 3. **authorization re-read**: `team_members/{email}` must exist and not be expired at the transaction clock, `team_roles/{email}` gives the role, an admin e-mail is always authorized (`MEMBERSHIP_REQUIRED`, `MEMBERSHIP_EXPIRED`, `ROLE_NOT_ALLOWED`); this happens **before** the replay lookup, so a stored result is never returned to a caller who lost the permission, and before any effect; 4. replay lookup; 5. Riyadh day, head, state, separation of duties, binding, scope, chain, content validation; 6. **commit-time day re-check** (§11); 7. effect, request record and event written together. Failed requests are not recorded.

### Per-action payload keys (top level)
| action | allowed keys |
|---|---|
| createDraft | requestId, fundId, valuationDate, content, copyFromValuationId |
| updateDraft | requestId, valuationId, **expectedContentHash (required)**, content |
| submit / withdraw | requestId, valuationId |
| review | requestId, valuationId, expectedContentHash |
| returnDraft / reject | requestId, valuationId, reason |
| approve | requestId, valuationId, expectedContentHash, acknowledgeSuspended, reason |
| suspend / reinstate | requestId, fundId, valuationDate, expectedHeadId, reason |
| preview | valuationId |

### Optimistic concurrency on updateDraft
`updateValuationDraft` requires `expectedContentHash` (64 hex; `HASH_INVALID` otherwise). Inside the transaction the stored content is re-hashed (`CONTENT_HASH_MISMATCH` if it disagrees with the recorded hash) and compared with the caller's hash; a stale hash is refused with `CONTENT_CHANGED`, no write and no event. Two editors who started from the same version cannot both win: exactly one succeeds (tested with forced overlap).

## 6. Replay
A successful request is stored with `{actor, action, targetId, payloadHash, result}`. After steps 1–3, a repeat with the same actor, action, target and payload returns the stored result (`replayed:true`) **before** the date, head or state checks and writes nothing (no second event). A different payload or target under the same `requestId` is `REQUEST_ID_REUSED`. The key includes the actor, so another user's `requestId` never collides. Tested: replay the next day, replay after the head was replaced, replay by a caller who lost the role (refused at step 2).

## 7. Eligibility suspension
`suspend` / `reinstate` carry `expectedHeadId` and act only if it is the current head (`STALE_HEAD` otherwise, no effect). A suspended head makes the selector return no valuation and no rate (`VALUATION_SUSPENDED`), with no fallback to older versions. Replaying an old approval request never restores eligibility. Eligibility is restored only by (a) `reinstate` (not by the suspender, not by a contributor or the approver of that version) or (b) approval of a replacement version, which requires `acknowledgeSuspended:true` and a reason and is refused for the person who suspended. The selector's `eligibility` input is optional in R1-A/B1 and becomes mandatory when the rate is enabled (R1-C).

## 8. One active draft per fund and date
The create transaction reads the head document (which carries `activeDraftId`) and refuses with `ACTIVE_DRAFT_EXISTS` when it is set. Tested with 8 concurrent creates forced to overlap before their writes (exactly one succeeds), with concurrent identical requests (one effect) and with an approve/reject race (one consistent outcome).

## 9. Draft content validation without a forged approval
* Draft stages (create, update, submit, review): `validateValuationCandidate` runs the **same content checks** as the selector (`validateEffective`), the same scope and ledger helpers and the same chain function, and skips only the approval-data check, which has no meaning for a draft. It returns no value and no `complete` flag and cannot be mapped to `nav`. The stored `validation` is information; `submit` and `review` require it to pass.
* Approval: inside the approval transaction the **real** `selectResidualValuation` is run as a dry run on a shadow record (approved ancestors read in the transaction + the draft as `approved`, `version = head+1`, `supersedes = head`, `approvedBy` = the authenticated approver). The shadow is never stored; a refusal is `APPROVAL_VALIDATION_FAILED` with the selector's reason codes. The dry run is per fund (scope = that fund, ledger = that fund); portfolio-level coverage stays the selector's job at read time.

## 10. Chain and `baseHeadId`
`baseHeadId` is captured at draft creation and bound to the review (`reviewedBaseHeadId`, `reviewedContentHash`, `reviewedScopeHash`). `version` and `supersedes` are server-assigned at approval (head+1, head) and are not part of the content hash. The full chain is fetched by one query (fundId, valuationDate, status=approved) in the same transaction and is validated by the selector's own chain function. If the head moved (`STALE_HEAD`) or the scope changed (`SCOPE_CHANGED`), the approval writes nothing; a contributor with the role re-submits: `baseHeadId` and the scope snapshot are re-captured, the chain is re-validated, the old review is dropped (kept in the event) and a new review is required. With the one-draft slot a head cannot normally move while a draft is open, so `STALE_HEAD` is defence in depth, tested by moving the head out of band.

## 11. Riyadh day crossing
A valuation date must equal the current Asia/Riyadh day (server clock, injectable in tests) at create, update, submit, review and approve (`DATE_CROSSED` / `DATE_IN_FUTURE`, no effect). The scope snapshot is valid for its capture day, so a draft that crosses midnight can no longer be reviewed or approved; it can still be withdrawn or rejected (which release the slot), and `createValuationDraft` for the new day may copy the content of such a draft (`copyFromValuationId`; scope and validation are recaptured). Suspend and reinstate are allowed on any day. Tested at 23:59:59.999 and 00:00:00.000.

**Defined check instants.** The day is checked (i) once at the start of the transaction body, and (ii) again by `commitCheck` for create, update, submit, review and approve: it is the **last clock read, taken after all reads and checks and immediately before the writes are issued**. A request whose check (ii) sees a different Riyadh day than the valuation date is refused with `DATE_CROSSED` and writes nothing. The contract does **not** claim anything about the instant at which Firestore finally commits the transaction, which can be later than check (ii); it claims only that no write is issued after a clock read that showed the day had changed. Tested by moving the clock across 23:59:59.999 → 00:00:00.000 *inside* one request (after its reads, before its writes).

## 12. Binding of review and approval to the content
`contentHash` = canonical `documentHash` over the reviewable content plus the server-captured scope (fund, date, content fields, snapshotDate, funds, links) and excludes workflow metadata, `version` and `supersedes`. Review and approval carry `expectedContentHash`; the stored hash is recomputed (`CONTENT_HASH_MISMATCH` on tampering) and must equal the reviewed one (`CONTENT_CHANGED`).

## 13. Declared limits (not decided here)
Valuations exist only for the current day (past-dated valuations and corrections of past days are D6, deferred). Scope snapshot authenticity beyond the server read at that moment, the payables policy for unpaid distributions, asOfDate semantics (D7/R1-C), the read audience beyond the ledger scope, in-kind valuation and rate enabling are outside B1. Adding the xirr modules to `functions/generated` changes the bundle `engineVersion` (it labels IC audit snapshots from the next deployment).

## 14. Tests
* `functions/test/fund-valuations.emulator.test.js` — 36 real-emulator tests (incl. SLOT_INCONSISTENT on a corrupted slot, REVIEW-1 permission changed after the pre-check but before the transaction, REVIEW-2/2b stale and concurrent edits, REVIEW-3 midnight inside one request, REVIEW-4 payload allow-lists; replay, eligibility, one slot with forced overlap, roles table, binding, scope, chain, STALE_HEAD, day crossing, atomicity, validation inside the transaction, stored records accepted by the real selector).
* `functions/test/fund-valuations.unit.test.cjs` — 14 pure tests incl. the hand-written decided-matrix comparison (role lists, Riyadh boundaries, keys, whitelist, static checks).
* `tests/rules/rules.test.mjs` — the four collections (read only for fund_manager / senior_ic / admin; analyst and outsider refused; no client write for any role; requests closed to all).
* `src/domain/financial/xirr/verify-residual-valuation.mjs` — 77 tests (59 R1-A unchanged + eligibility + candidate parity with the selector).
