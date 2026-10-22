'use strict';
/* =========================================================================
   R1-B1 — fund residual-valuation workflow (server side only: storage, review, approval).
   Contract: docs/XIRR_RESIDUAL_VALUATION_WORKFLOW_CONTRACT.md

   Scope of B1: server callables, Firestore rules and tests. NO UI and NO Net XIRR rate. The selector
   (src/domain/financial/xirr/residual-valuation.js) stays the single truth for "which valuation is effective";
   the head pointer written here is only a write-time guard and the carrier of the eligibility state.

   Access model (declared limitation): roles are GLOBAL (team_roles). There is no per-fund entitlement in the
   ledger today, so any holder of a listed role may act on any fund. This module does not pretend otherwise.

   Order of checks in EVERY mutating action (the order is part of the contract and is tested):
     1. caller identity and team membership (requireEmail / requireAuthorized)
     2. the caller's CURRENT role is in the explicit role list of the action
     3. request shape (requestId charset / length, payload whitelist)
     4. inside ONE transaction:
        a. replay lookup  -> a stored successful result is returned as it was, BEFORE anything below
        b. today's date (Asia/Riyadh), head, state, separation of duties, scope, chain, content validation
        c. the effect, the request record and the audit event, written together
   Failed requests are never recorded, so a retry after a failure is a fresh attempt.
   ========================================================================= */
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/* ---------- explicit role lists (never "role and above") ---------- */
const ROLES = Object.freeze(['analyst', 'senior_ic', 'fund_manager', 'admin']);
const ROLE_LISTS = Object.freeze({
  // preparer actions (decision of Opal, 2026-10-08 15:36): fund_manager and admin only
  createDraft: ['fund_manager', 'admin'],
  updateDraft: ['fund_manager', 'admin'],
  submit: ['fund_manager', 'admin'],          // and must be a contributor of the draft
  withdraw: ['fund_manager', 'admin'],        // and must be a contributor of the draft
  // reviewer actions: senior_ic and admin ONLY (fund_manager is deliberately excluded)
  review: ['senior_ic', 'admin'],             // and must NOT be a contributor
  returnDraft: ['senior_ic', 'admin'],        // and must NOT be a contributor
  reject: ['senior_ic', 'admin'],             // and must NOT be a contributor
  approve: ['senior_ic', 'admin'],            // and must NOT be a contributor or the preparer; admin is not exempt
  suspend: ['senior_ic', 'admin'],
  reinstate: ['senior_ic', 'admin'],          // and not the suspender, not a contributor of the head version
  // read-only preview: the same audience as the client read rule (analyst excluded)
  preview: ['fund_manager', 'senior_ic', 'admin'],
});
for (const l of Object.values(ROLE_LISTS)) Object.freeze(l);

/* Top-level payload keys accepted per action. Anything else is refused (PAYLOAD_UNKNOWN_FIELD), never ignored. */
const ALLOWED_KEYS = Object.freeze({
  createDraft: ['requestId', 'fundId', 'valuationDate', 'content', 'copyFromValuationId'],
  updateDraft: ['requestId', 'valuationId', 'expectedContentHash', 'content'],
  submit: ['requestId', 'valuationId'],
  review: ['requestId', 'valuationId', 'expectedContentHash'],
  returnDraft: ['requestId', 'valuationId', 'reason'],
  reject: ['requestId', 'valuationId', 'reason'],
  withdraw: ['requestId', 'valuationId'],
  approve: ['requestId', 'valuationId', 'expectedContentHash', 'acknowledgeSuspended', 'reason'],
  suspend: ['requestId', 'fundId', 'valuationDate', 'expectedHeadId', 'reason'],
  reinstate: ['requestId', 'fundId', 'valuationDate', 'expectedHeadId', 'reason'],
  preview: ['valuationId'],
});
for (const l of Object.values(ALLOWED_KEYS)) Object.freeze(l);

const STATES = Object.freeze(['draft', 'returned', 'submitted', 'reviewed', 'approved', 'rejected', 'withdrawn']);
const ACTIVE_STATES = Object.freeze(['draft', 'returned', 'submitted', 'reviewed']); // hold the one-draft slot

const COLL = Object.freeze({
  valuations: 'fundValuations', heads: 'fundValuationHeads', requests: 'fundValuationRequests', events: 'fundValuationEvents',
});
const CONTENT_KEYS = Object.freeze(['currency', 'basis', 'components', 'residualValue', 'method', 'methodNote', 'source', 'nonOverlap', 'coverage']);
const RULE_VERSION = 'R1B1-candidate-v1';
const MAX_CONTENT_JSON = 50000;
const MAX_REASON = 1000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- pure helpers ---------- */
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

function roleAllowed(action, role) {
  return Object.prototype.hasOwnProperty.call(ROLE_LISTS, action) && ROLE_LISTS[action].includes(role);
}
function headKey(fundId, valuationDate) { return `${fundId}__${valuationDate}`; }
function replayKey(email, requestId) { return sha256(JSON.stringify([email, requestId])); } // unambiguous encoding: no (a,bc) vs (ab,c) collisions
/** Asia/Riyadh is fixed UTC+3 with no DST. `now` is injectable so the day boundary is testable. */
function riyadhDay(now) {
  const ms = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(ms)) throw new Error('riyadhDay: invalid instant');
  return new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function realIsoDay(s) {
  if (typeof s !== 'string' || !ISO_DAY_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
/** Ledger rows -> the XIRR-P record shape the selector reads (kind, id, fundId, date, status). */
function ledgerRecord(kind, id, data) {
  return { kind, id, fundId: data.fundId, date: kind === 'capitalCall' ? data.callDate : data.distDate, status: data.status };
}

function fail(HttpsError, code, reason, message, extra) {
  return new HttpsError(code, message || reason, { reason, ...(extra || {}) });
}

module.exports = { ROLES, ROLE_LISTS, ALLOWED_KEYS, STATES, ACTIVE_STATES, COLL, CONTENT_KEYS, RULE_VERSION, roleAllowed, headKey, replayKey, riyadhDay, realIsoDay, ledgerRecord, REQUEST_ID_RE, ID_RE };

/**
 * @param {object} deps
 *   db, FieldValue, HttpsError  — firebase-admin / firebase-functions
 *   documentHash(doc)           — canonical hash (trusted-ic.cjs)
 *   validateInput(value)        — structural guard (trusted-ic.cjs)
 *   requireAuthorized(email)    — team membership (index.js)
 *   roleForEmail(email)         — current global role (index.js)
 *   loadDomain()                — resolves { selectResidualValuation, validateValuationCandidate }
 *   clock                       — { now: () => Date }  (tests replace `now`; production uses the server clock)
 */
function createFundValuationService(deps) {
  const { db, FieldValue, HttpsError, documentHash, validateInput, requireAuthorized, roleForEmail, isAdminEmail, loadDomain } = deps;
  const clock = deps.clock || { now: () => new Date() };
  // Test seam only: an async hook awaited after a transaction's reads and before its writes, so a test can force real overlap.
  const hooks = deps.hooks || {};
  const beforeWrite = async (name) => { if (typeof hooks.beforeWrite === 'function') await hooks.beforeWrite(name); };
  const beforeTransaction = async (name) => { if (typeof hooks.beforeTransaction === 'function') await hooks.beforeTransaction(name); };
  const err = (code, reason, message, extra) => fail(HttpsError, code, reason, message, extra);

  /* ----- request shape ----- */
  function needPayload(action, data) {
    if (!isPlain(data)) throw err('invalid-argument', 'PAYLOAD_INVALID', 'The request payload must be an object.');
    const unknown = Object.keys(data).filter((k) => !ALLOWED_KEYS[action].includes(k));
    if (unknown.length) throw err('invalid-argument', 'PAYLOAD_UNKNOWN_FIELD', `Unknown payload field(s) for ${action}: ${unknown.join(', ')}.`);
    return data;
  }
  /* Authoritative authorization, read INSIDE the transaction (same rules as requireAuthorized / roleForEmail in index.js):
     an admin e-mail is always authorized; otherwise the team_members document must exist and not be expired at the
     transaction's clock; the role comes from team_roles (default analyst). The pre-transaction check is only an early refusal. */
  async function authorizeInTx(tx, email, nowMs) {
    if (isAdminEmail(email)) return 'admin';
    const [mem, roleSnap] = await Promise.all([tx.get(db.collection('team_members').doc(email)), tx.get(db.collection('team_roles').doc(email))]);
    if (!mem.exists) throw err('permission-denied', 'MEMBERSHIP_REQUIRED', 'Not an authorized team member.');
    const expiresAt = (mem.data() || {}).expiresAt;
    if (expiresAt) {
      const ms = typeof expiresAt.toMillis === 'function' ? expiresAt.toMillis() : new Date(expiresAt).getTime();
      if (Number.isFinite(ms) && ms <= nowMs) throw err('permission-denied', 'MEMBERSHIP_EXPIRED', 'Team access has expired.');
    }
    return roleSnap.exists ? ((roleSnap.data() || {}).role || 'analyst') : 'analyst';
  }
  function needRequestId(data) {
    const id = data && data.requestId;
    if (typeof id !== 'string' || !REQUEST_ID_RE.test(id)) throw err('invalid-argument', 'REQUEST_ID_INVALID', 'requestId must be 8-64 characters of A-Z a-z 0-9 _ -.');
    return id;
  }
  function needId(v, name) {
    if (typeof v !== 'string' || !ID_RE.test(v) || v.includes('__')) throw err('invalid-argument', 'ID_INVALID', `${name} is invalid.`);
    return v;
  }
  function needReason(v) {
    if (!isStr(v) || v.length > MAX_REASON) throw err('invalid-argument', 'REASON_REQUIRED', `reason is required (1-${MAX_REASON} characters).`);
    return v.trim();
  }
  function needHash(v, name) {
    if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) throw err('invalid-argument', 'HASH_INVALID', `${name} must be a 64-character hex digest.`);
    return v;
  }
  function needContent(content, { requireAll }) {
    if (!isPlain(content)) throw err('invalid-argument', 'CONTENT_INVALID', 'content must be an object.');
    const unknown = Object.keys(content).filter((k) => !CONTENT_KEYS.includes(k));
    if (unknown.length) throw err('invalid-argument', 'CONTENT_UNKNOWN_FIELD', `Unknown content field(s): ${unknown.join(', ')}.`);
    try { validateInput(content); } catch (e) { throw err('invalid-argument', 'CONTENT_UNSAFE', 'content has an unsafe structure.'); }
    if (JSON.stringify(content).length > MAX_CONTENT_JSON) throw err('invalid-argument', 'CONTENT_TOO_LARGE', 'content is too large.');
    if (requireAll && Object.keys(content).length === 0) throw err('invalid-argument', 'CONTENT_INVALID', 'content is empty.');
    return content;
  }

  /* ----- content / hashes ----- */
  const contentOf = (v) => {
    const out = { fundId: v.fundId, valuationDate: v.valuationDate, scope: v.scopeSnapshot ? scopeCore(v.scopeSnapshot) : null };
    for (const k of CONTENT_KEYS) if (v[k] !== undefined) out[k] = v[k];
    return out;
  };
  const scopeCore = (s) => ({ snapshotDate: s.snapshotDate, funds: s.funds, linksByFund: s.linksByFund });
  const hashContent = (v) => documentHash(contentOf(v));
  const hashScope = (s) => documentHash(scopeCore(s));

  /* ----- reads (all inside the transaction, before any write) ----- */
  async function readContext(tx, fundId, valuationDate) {
    const headRef = db.collection(COLL.heads).doc(headKey(fundId, valuationDate));
    const fundRef = db.collection('funds').doc(fundId);
    const [headSnap, fundSnap, ancSnap, callSnap, distSnap] = await Promise.all([
      tx.get(headRef), tx.get(fundRef),
      tx.get(db.collection(COLL.valuations).where('fundId', '==', fundId).where('valuationDate', '==', valuationDate).where('status', '==', 'approved')),
      tx.get(db.collection('capitalCalls').where('fundId', '==', fundId)),
      tx.get(db.collection('distributions').where('fundId', '==', fundId)),
    ]);
    const records = [];
    callSnap.forEach((d) => records.push(ledgerRecord('capitalCall', d.id, d.data() || {})));
    distSnap.forEach((d) => records.push(ledgerRecord('distribution', d.id, d.data() || {})));
    const ancestors = [];
    ancSnap.forEach((d) => ancestors.push({ ...d.data(), valuationId: d.id }));
    ancestors.sort((a, b) => (a.version || 0) - (b.version || 0));
    const head = headSnap.exists ? headSnap.data() : { headId: null, version: 0, headHash: null, eligibility: null, activeDraftId: null };
    return { headRef, headExists: headSnap.exists, head, fundExists: fundSnap.exists, fundData: fundSnap.exists ? fundSnap.data() : null, ancestors, records };
  }

  function captureScope(ctx, fundId, day) {
    const assets = Array.isArray(ctx.fundData && ctx.fundData.assetIds) ? ctx.fundData.assetIds.filter(isStr) : [];
    return { snapshotDate: day, funds: [fundId], linksByFund: { [fundId]: [...new Set(assets)].sort() } };
  }

  /* The head pointer is only a write-time guard; the approved versions read in this transaction are the truth.
     Any disagreement blocks the action (no write) instead of being repaired silently. */
  function assertHeadConsistent(ctx) {
    const headId = ctx.head.headId || null;
    const ids = new Set(ctx.ancestors.map((a) => a.valuationId));
    if (headId !== null && !ids.has(headId)) throw err('failed-precondition', 'HEAD_POINTER_INCONSISTENT', 'The head pointer names a version that is not approved.');
    const headVersion = headId === null ? 0 : (ctx.ancestors.find((a) => a.valuationId === headId) || {}).version;
    if (!Number.isInteger(headVersion) || headVersion !== (ctx.head.version || 0) || ctx.ancestors.length !== headVersion) throw err('failed-precondition', 'HEAD_POINTER_INCONSISTENT', 'The head pointer disagrees with the approved chain.');
  }
  /* lightweight read for actions that only move the slot (reject / withdraw) */
  async function readHeadOnly(tx, fundId, valuationDate) {
    const headRef = db.collection(COLL.heads).doc(headKey(fundId, valuationDate));
    const snap = await tx.get(headRef);
    return { headRef, head: snap.exists ? snap.data() : { headId: null, version: 0, eligibility: null, activeDraftId: null } };
  }

  function evaluateCandidate(domain, valuation, scope, ctx, day, baseHeadId) {
    return domain.validateValuationCandidate({
      asOfDate: day, scope, candidate: candidateOf(valuation), ancestors: ctx.ancestors, records: ctx.records, baseHeadValuationId: baseHeadId,
    });
  }
  /** The record handed to the validator: content only, status draft, no version / supersedes / approval. */
  function candidateOf(v) {
    const c = { valuationId: v.valuationId, fundId: v.fundId, valuationDate: v.valuationDate, status: 'draft', enteredBy: v.enteredBy };
    for (const k of CONTENT_KEYS) if (v[k] !== undefined) c[k] = v[k];
    return c;
  }
  const validationSummary = (res, contentHash, day) => ({ ok: res.ok, reasonCodes: res.reasonCodes, ruleVersion: RULE_VERSION, contentHash, validatedDay: day });

  function headIdOf(ctx) { return ctx.head.headId || null; }

  /* ----- the common envelope ----- */
  async function envelope(request, { action, requireEmail, parse, body }) {
    // ---- early refusals (outside the transaction; NOT authoritative) ----
    const email = requireEmail(request);                                   // 1. identity
    await requireAuthorized(email);                                        //    team membership / expiry
    const earlyRole = await roleForEmail(email);                           // 2. CURRENT role in the explicit list
    if (!roleAllowed(action, earlyRole)) throw err('permission-denied', 'ROLE_NOT_ALLOWED', `Role "${earlyRole}" may not perform ${action}.`);
    const data = needPayload(action, request.data);                        // 3. request shape: allow-listed keys only
    const requestId = needRequestId(data);
    const p = parse(data);
    const key = replayKey(email, requestId);
    const fullHash = documentHash({ action, targetId: p.targetId, payload: p.payload });
    await beforeTransaction(action);                                       // test seam: authorization can change right here
    // ---- the authoritative path: everything below is read and decided inside ONE transaction ----
    return db.runTransaction(async (tx) => {
      const now = clock.now();
      const role = await authorizeInTx(tx, email, now.getTime());          // 2'. membership, expiry and role re-read in the transaction
      if (!roleAllowed(action, role)) throw err('permission-denied', 'ROLE_NOT_ALLOWED', `Role "${role}" may not perform ${action}.`);
      const reqRef = db.collection(COLL.requests).doc(key);
      const reqSnap = await tx.get(reqRef);
      if (reqSnap.exists) {                                                // 4a. replay: after authorization, BEFORE date / head / state
        const r = reqSnap.data();
        if (r.actor === email && r.action === action && r.targetId === p.targetId && r.payloadHash === fullHash) return { ...r.result, replayed: true };
        throw err('already-exists', 'REQUEST_ID_REUSED', 'This requestId was already used for a different request.');
      }
      const at = now.toISOString();
      const today = riyadhDay(now);
      const out = await body(tx, { email, role, now, at, today }, p);      // 4b + 4c
      const eventRef = db.collection(COLL.events).doc();
      tx.set(eventRef, { ...out.event, actor: email, role, at, atDay: today, action, serverAt: FieldValue.serverTimestamp() });
      const result = { ok: true, action, ...out.result, eventId: eventRef.id };
      tx.set(reqRef, { key, actor: email, action, targetId: p.targetId, payloadHash: fullHash, result, createdAt: at });
      return result;
    });
  }

  const requireDay = (valuation, today) => {
    if (valuation.valuationDate < today) throw err('failed-precondition', 'DATE_CROSSED', 'The Riyadh calendar day changed since this valuation date. Withdraw or reject it and create a new draft for today.', { valuationDate: valuation.valuationDate, today });
    if (valuation.valuationDate > today) throw err('failed-precondition', 'DATE_IN_FUTURE', 'A valuation cannot be dated after today (Asia/Riyadh).', { valuationDate: valuation.valuationDate, today });
  };
  /* The day is checked twice: at the start (cheap refusal) and AGAIN here, as the last clock read after all reads and checks
     and immediately before the writes. This instant is what the contract promises; the commit itself may land later. */
  const commitCheck = async (name, valuationDate) => {
    await beforeWrite(name);
    requireDay({ valuationDate }, riyadhDay(clock.now()));
  };
  const isContributor = (v, email) => Array.isArray(v.contributors) && v.contributors.includes(email);
  const getValuation = async (tx, valuationId) => {
    const ref = db.collection(COLL.valuations).doc(valuationId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw err('not-found', 'VALUATION_NOT_FOUND', 'Valuation not found.');
    return { ref, v: { ...snap.data(), valuationId } };
  };
  const releaseSlot = (tx, ctx, valuationId, extra) => {
    if (ctx.head.activeDraftId === valuationId) tx.set(ctx.headRef, { ...ctx.head, ...extra, activeDraftId: null, updatedAt: clock.now().toISOString(), rev: (ctx.head.rev || 0) + 1 });
  };
  const brief = (v) => ({ valuationId: v.valuationId, fundId: v.fundId, valuationDate: v.valuationDate, state: v.state });

  /* =====================================================================
     createDraft — takes the one-draft slot of fund + date
     ===================================================================== */
  async function createDraft(request, requireEmail) {
    return envelope(request, {
      action: 'createDraft', requireEmail,
      parse: (d) => {
      const fundId = needId(d.fundId, 'fundId');
      if (!realIsoDay(d.valuationDate)) throw err('invalid-argument', 'DATE_INVALID', 'valuationDate must be a real calendar date (YYYY-MM-DD).');
      const copyFrom = d.copyFromValuationId === undefined ? null : needId(d.copyFromValuationId, 'copyFromValuationId');
      const content = copyFrom ? (d.content === undefined ? {} : needContent(d.content, { requireAll: false })) : needContent(d.content, { requireAll: true });

        return { targetId: headKey(fundId, d.valuationDate), payload: { content, copyFrom }, d, fundId, copyFrom, content };
      },
      body: async (tx, { email, at, today }, { d, fundId, copyFrom, content }) => {
        const domain = await loadDomain();
        if (d.valuationDate < today) throw err('failed-precondition', 'DATE_CROSSED', 'valuationDate is before today (Asia/Riyadh).', { valuationDate: d.valuationDate, today });
        if (d.valuationDate > today) throw err('failed-precondition', 'DATE_IN_FUTURE', 'A valuation cannot be dated after today (Asia/Riyadh).', { valuationDate: d.valuationDate, today });
        const ctx = await readContext(tx, fundId, d.valuationDate);
        let source = null;
        if (copyFrom) source = await getValuation(tx, copyFrom);
        if (!ctx.fundExists) throw err('failed-precondition', 'FUND_NOT_FOUND', 'Fund not found.');
        if (ctx.head.activeDraftId) throw err('already-exists', 'ACTIVE_DRAFT_EXISTS', 'An active draft already exists for this fund and date.', { activeDraftId: ctx.head.activeDraftId });
        assertHeadConsistent(ctx);
        let base = {};
        if (source) {
          if (source.v.fundId !== fundId) throw err('failed-precondition', 'COPY_SOURCE_MISMATCH', 'The copy source belongs to another fund.');
          if (!['rejected', 'withdrawn', 'draft', 'returned', 'submitted', 'reviewed'].includes(source.v.state)) throw err('failed-precondition', 'COPY_SOURCE_STATE', 'An approved valuation cannot be copied as a draft; create a replacement draft instead.');
          for (const k of CONTENT_KEYS) if (source.v[k] !== undefined) base[k] = source.v[k];
        }
        await commitCheck('createDraft', d.valuationDate);
        const valuationRef = db.collection(COLL.valuations).doc();
        const valuation = {
          valuationId: valuationRef.id, fundId, valuationDate: d.valuationDate, state: 'draft', status: 'draft',
          ...base, ...content, enteredBy: email, contributors: [email], baseHeadId: headIdOf(ctx),
          scopeSnapshot: { ...captureScope(ctx, fundId, today), capturedAt: at }, review: null,
          createdAt: at, updatedAt: at, rev: 1,
        };
        if (copyFrom) valuation.copiedFrom = copyFrom;
        valuation.scopeHash = hashScope(valuation.scopeSnapshot);
        valuation.contentHash = hashContent(valuation);
        const res = evaluateCandidate(domain, valuation, scopeCore(valuation.scopeSnapshot), ctx, today, headIdOf(ctx));
        valuation.validation = validationSummary(res, valuation.contentHash, today);
        tx.set(valuationRef, valuation);
        tx.set(ctx.headRef, { ...ctx.head, fundId, valuationDate: d.valuationDate, activeDraftId: valuationRef.id, updatedAt: at, rev: (ctx.head.rev || 0) + 1 });
        return { result: { ...brief(valuation), contentHash: valuation.contentHash, baseHeadId: valuation.baseHeadId, validation: valuation.validation }, event: { type: 'DRAFT_CREATED', ...brief(valuation), details: { baseHeadId: valuation.baseHeadId, copiedFrom: copyFrom } } };
      },
    });
  }

  /* =====================================================================
     updateDraft — content edits only in draft / returned; drops any review; the editor becomes a contributor
     ===================================================================== */
  async function updateDraft(request, requireEmail) {
    return envelope(request, {
      action: 'updateDraft', requireEmail,
      parse: (d) => {
      const valuationId = needId(d.valuationId, 'valuationId');
      const expectedContentHash = needHash(d.expectedContentHash, 'expectedContentHash');
      const content = needContent(d.content, { requireAll: true });

        return { targetId: valuationId, payload: { content, expectedContentHash }, d, valuationId, expectedContentHash, content };
      },
      body: async (tx, { email, at, today }, { d, valuationId, expectedContentHash, content }) => {
        const domain = await loadDomain();
        const { ref, v } = await getValuation(tx, valuationId);
        const ctx = await readContext(tx, v.fundId, v.valuationDate);
        requireDay(v, today);
        if (!['draft', 'returned'].includes(v.state)) throw err('failed-precondition', 'INVALID_STATE', `A valuation in state "${v.state}" cannot be edited.`);
        if (ctx.head.activeDraftId !== valuationId) throw err('failed-precondition', 'SLOT_INCONSISTENT', 'The draft slot does not name this draft.');
        // optimistic concurrency: the editor names the content he started from; the stored content is re-hashed in this transaction
        if (hashContent(v) !== v.contentHash) throw err('failed-precondition', 'CONTENT_HASH_MISMATCH', 'The stored content does not match its recorded hash.');
        if (expectedContentHash !== v.contentHash) throw err('failed-precondition', 'CONTENT_CHANGED', 'The draft changed since the caller read it. Re-read it and re-apply the edit.');
        const next = { ...v, ...content, state: 'draft', status: 'draft', review: null, updatedAt: at, rev: (v.rev || 1) + 1 };
        next.contributors = [...new Set([...(v.contributors || []), email])];
        next.contentHash = hashContent(next);
        const res = evaluateCandidate(domain, next, scopeCore(next.scopeSnapshot), ctx, today, next.baseHeadId);
        next.validation = validationSummary(res, next.contentHash, today);
        await commitCheck('updateDraft', v.valuationDate);
        tx.set(ref, next);
        return { result: { ...brief(next), contentHash: next.contentHash, validation: next.validation }, event: { type: 'DRAFT_UPDATED', ...brief(next), details: { fields: Object.keys(content).sort(), droppedReview: v.review || null } } };
      },
    });
  }

  /* =====================================================================
     submit — draft / returned -> submitted.  Also the ONLY way to refresh a stale submitted / reviewed draft:
     if its baseHeadId no longer equals the head (STALE_HEAD) or the scope changed, a contributor re-submits; the base
     and the scope snapshot are re-captured, the chain is re-validated, and the old review is dropped.
     ===================================================================== */
  async function submit(request, requireEmail) {
    return envelope(request, {
      action: 'submit', requireEmail,
      parse: (d) => {
      const valuationId = needId(d.valuationId, 'valuationId');

        return { targetId: valuationId, payload: {}, d, valuationId };
      },
      body: async (tx, { email, at, today }, { d, valuationId }) => {
        const domain = await loadDomain();
        const { ref, v } = await getValuation(tx, valuationId);
        const ctx = await readContext(tx, v.fundId, v.valuationDate);
        requireDay(v, today);
        if (!isContributor(v, email)) throw err('permission-denied', 'NOT_A_CONTRIBUTOR', 'Only a contributor of this draft may submit it (and only while holding an allowed role).');
        if (ctx.head.activeDraftId !== valuationId) throw err('failed-precondition', 'SLOT_INCONSISTENT', 'The draft slot does not name this draft.');
        assertHeadConsistent(ctx);
        const freshScope = captureScope(ctx, v.fundId, today);
        const staleBase = (v.baseHeadId || null) !== headIdOf(ctx);
        const scopeChanged = hashScope(freshScope) !== v.scopeHash;
        let type = 'SUBMITTED';
        if (v.state === 'submitted' || v.state === 'reviewed') {
          if (!staleBase && !scopeChanged) throw err('failed-precondition', 'ALREADY_SUBMITTED', 'The valuation is already submitted and is not stale.');
          type = 'RESUBMITTED_AFTER_STALE';
        } else if (!['draft', 'returned'].includes(v.state)) throw err('failed-precondition', 'INVALID_STATE', `A valuation in state "${v.state}" cannot be submitted.`);
        const next = { ...v, baseHeadId: headIdOf(ctx), scopeSnapshot: { ...freshScope, capturedAt: at }, state: 'submitted', status: 'draft', review: null, submittedBy: email, submittedAt: at, updatedAt: at, rev: (v.rev || 1) + 1 };
        next.scopeHash = hashScope(next.scopeSnapshot);
        next.contentHash = hashContent(next);
        const res = evaluateCandidate(domain, next, scopeCore(next.scopeSnapshot), ctx, today, next.baseHeadId);
        next.validation = validationSummary(res, next.contentHash, today);
        if (!res.ok) throw err('failed-precondition', 'VALIDATION_FAILED', 'The draft does not pass the content validation.', { reasonCodes: res.reasonCodes });
        await commitCheck('submit', v.valuationDate);
        tx.set(ref, next);
        return {
          result: { ...brief(next), contentHash: next.contentHash, baseHeadId: next.baseHeadId, scopeHash: next.scopeHash },
          event: { type, ...brief(next), details: { oldBaseHeadId: v.baseHeadId || null, newBaseHeadId: next.baseHeadId, staleBase, scopeChanged, droppedReview: v.review || null } },
        };
      },
    });
  }

  /* =====================================================================
     review — submitted -> reviewed. The reviewer states the content hash he reviewed; it is bound to the review.
     ===================================================================== */
  async function review(request, requireEmail) {
    return envelope(request, {
      action: 'review', requireEmail,
      parse: (d) => {
      const valuationId = needId(d.valuationId, 'valuationId');
      const expectedContentHash = needHash(d.expectedContentHash, 'expectedContentHash');

        return { targetId: valuationId, payload: { expectedContentHash }, d, valuationId, expectedContentHash };
      },
      body: async (tx, { email, at, today }, { d, valuationId, expectedContentHash }) => {
        const domain = await loadDomain();
        const { ref, v } = await getValuation(tx, valuationId);
        const ctx = await readContext(tx, v.fundId, v.valuationDate);
        requireDay(v, today);
        if (isContributor(v, email)) throw err('permission-denied', 'CONTRIBUTOR_CANNOT_REVIEW', 'A contributor of this draft may not review it.');
        if (v.state !== 'submitted') throw err('failed-precondition', 'INVALID_STATE', `Only a submitted valuation can be reviewed (state is "${v.state}").`);
        assertHeadConsistent(ctx);
        assertBound(v, ctx, expectedContentHash, captureScope(ctx, v.fundId, today));
        const res = evaluateCandidate(domain, v, scopeCore(v.scopeSnapshot), ctx, today, v.baseHeadId || null);
        if (!res.ok) throw err('failed-precondition', 'VALIDATION_FAILED', 'The draft no longer passes the content validation.', { reasonCodes: res.reasonCodes });
        await commitCheck('review', v.valuationDate);
        const next = { ...v, state: 'reviewed', review: { reviewedBy: email, reviewedAt: at, reviewedContentHash: v.contentHash, reviewedBaseHeadId: v.baseHeadId || null, reviewedScopeHash: v.scopeHash }, updatedAt: at, rev: (v.rev || 1) + 1 };
        tx.set(ref, next);
        return { result: { ...brief(next), contentHash: v.contentHash }, event: { type: 'REVIEWED', ...brief(next), details: { reviewedContentHash: v.contentHash, reviewedBaseHeadId: v.baseHeadId || null } } };
      },
    });
  }

  /* what the reviewer / approver saw must still be what is stored, on the same head, with the same scope */
  function assertBound(v, ctx, expectedContentHash, freshScope) {
    if (hashContent(v) !== v.contentHash) throw err('failed-precondition', 'CONTENT_HASH_MISMATCH', 'The stored content does not match its recorded hash.');
    if (expectedContentHash !== v.contentHash) throw err('failed-precondition', 'CONTENT_CHANGED', 'The content differs from what the caller reviewed.');
    if ((v.baseHeadId || null) !== headIdOf(ctx)) throw err('failed-precondition', 'STALE_HEAD', 'The effective head changed after this draft was based on it. A contributor must re-submit it.', { baseHeadId: v.baseHeadId || null, headId: headIdOf(ctx) });
    if (hashScope(freshScope) !== v.scopeHash) throw err('failed-precondition', 'SCOPE_CHANGED', 'The fund/asset scope changed since the snapshot. A contributor must re-submit it.');
  }

  /* =====================================================================
     returnDraft / reject / withdraw — release or reopen without touching the effective valuation
     ===================================================================== */
  async function returnDraft(request, requireEmail) {
    return envelope(request, {
      action: 'returnDraft', requireEmail,
      parse: (d) => {
      const valuationId = needId(d.valuationId, 'valuationId');
      const reason = needReason(d.reason);

        return { targetId: valuationId, payload: { reason }, d, valuationId, reason };
      },
      body: async (tx, { email, at }, { d, valuationId, reason }) => {
        const { ref, v } = await getValuation(tx, valuationId);
        if (isContributor(v, email)) throw err('permission-denied', 'CONTRIBUTOR_CANNOT_REVIEW', 'A contributor of this draft may not return it.');
        if (!['submitted', 'reviewed'].includes(v.state)) throw err('failed-precondition', 'INVALID_STATE', `Only a submitted or reviewed valuation can be returned (state is "${v.state}").`);
        const next = { ...v, state: 'returned', review: null, returnedBy: email, returnReason: reason, updatedAt: at, rev: (v.rev || 1) + 1 };
        tx.set(ref, next);
        return { result: brief(next), event: { type: 'RETURNED', ...brief(next), details: { reason, droppedReview: v.review || null } } };
      },
    });
  }

  async function reject(request, requireEmail) {
    return envelope(request, {
      action: 'reject', requireEmail,
      parse: (d) => {
      const valuationId = needId(d.valuationId, 'valuationId');
      const reason = needReason(d.reason);

        return { targetId: valuationId, payload: { reason }, d, valuationId, reason };
      },
      body: async (tx, { email, at }, { d, valuationId, reason }) => {
        const { ref, v } = await getValuation(tx, valuationId);
        const ctx = await readHeadOnly(tx, v.fundId, v.valuationDate);
        if (isContributor(v, email)) throw err('permission-denied', 'CONTRIBUTOR_CANNOT_REVIEW', 'A contributor of this draft may not reject it.');
        if (!['submitted', 'reviewed', 'returned'].includes(v.state)) throw err('failed-precondition', 'INVALID_STATE', `A valuation in state "${v.state}" cannot be rejected.`);
        await beforeWrite('reject');
        const next = { ...v, state: 'rejected', review: null, rejectedBy: email, rejectReason: reason, updatedAt: at, rev: (v.rev || 1) + 1 };
        tx.set(ref, next);
        releaseSlot(tx, ctx, valuationId, { updatedAt: at });
        return { result: brief(next), event: { type: 'REJECTED', ...brief(next), details: { reason } } };
      },
    });
  }

  async function withdraw(request, requireEmail) {
    return envelope(request, {
      action: 'withdraw', requireEmail,
      parse: (d) => {
      const valuationId = needId(d.valuationId, 'valuationId');

        return { targetId: valuationId, payload: {}, d, valuationId };
      },
      body: async (tx, { email, at }, { d, valuationId }) => {
        const { ref, v } = await getValuation(tx, valuationId);
        const ctx = await readHeadOnly(tx, v.fundId, v.valuationDate);
        if (!isContributor(v, email)) throw err('permission-denied', 'NOT_A_CONTRIBUTOR', 'Only a contributor of this draft may withdraw it (and only while holding an allowed role).');
        if (!ACTIVE_STATES.includes(v.state)) throw err('failed-precondition', 'INVALID_STATE', `A valuation in state "${v.state}" cannot be withdrawn.`);
        const next = { ...v, state: 'withdrawn', review: null, withdrawnBy: email, updatedAt: at, rev: (v.rev || 1) + 1 };
        tx.set(ref, next);
        releaseSlot(tx, ctx, valuationId, { updatedAt: at });
        return { result: brief(next), event: { type: 'WITHDRAWN', ...brief(next), details: {} } };
      },
    });
  }

  /* =====================================================================
     approve — one transaction: every check is re-read INSIDE it. The real selector is run as a dry run on a
     shadow record carrying the caller's real identity; the shadow is never stored.
     ===================================================================== */
  async function approve(request, requireEmail) {
    return envelope(request, {
      action: 'approve', requireEmail,
      parse: (d) => {
      const valuationId = needId(d.valuationId, 'valuationId');
      const expectedContentHash = needHash(d.expectedContentHash, 'expectedContentHash');
      if (d.acknowledgeSuspended !== undefined && typeof d.acknowledgeSuspended !== 'boolean') throw err('invalid-argument', 'ACK_INVALID', 'acknowledgeSuspended must be a boolean.');
    const acknowledgeSuspended = d.acknowledgeSuspended === true;
      const reason = d.reason === undefined ? null : needReason(d.reason);

        return { targetId: valuationId, payload: { expectedContentHash, acknowledgeSuspended, reason }, d, valuationId, expectedContentHash, acknowledgeSuspended, reason };
      },
      body: async (tx, { email, at, today }, { d, valuationId, expectedContentHash, acknowledgeSuspended, reason }) => {
        const domain = await loadDomain();
        const { ref, v } = await getValuation(tx, valuationId);
        const ctx = await readContext(tx, v.fundId, v.valuationDate);
        requireDay(v, today);
        if (isContributor(v, email) || (v.enteredBy || '').toLowerCase() === email) throw err('permission-denied', 'CONTRIBUTOR_CANNOT_APPROVE', 'A contributor or the preparer may not approve this valuation (admin is not exempt).');
        if (v.state === 'approved') throw err('failed-precondition', 'ALREADY_APPROVED', 'This valuation is already approved.');
        if (v.state !== 'reviewed') throw err('failed-precondition', 'INVALID_STATE', `Only a reviewed valuation can be approved (state is "${v.state}").`);
        if (ctx.head.activeDraftId !== valuationId) throw err('failed-precondition', 'SLOT_INCONSISTENT', 'The draft slot does not name this draft.');
        // 1. what was reviewed is what is stored, on the same head, with the same scope (scope re-captured NOW, in this transaction)
        assertBound(v, ctx, expectedContentHash, captureScope(ctx, v.fundId, today));
        const rv = v.review;
        if (!rv || rv.reviewedContentHash !== v.contentHash || rv.reviewedBaseHeadId !== (v.baseHeadId || null) || rv.reviewedScopeHash !== v.scopeHash) throw err('failed-precondition', 'REVIEW_NOT_CURRENT', 'The recorded review does not cover the current content, base or scope.');
        // 2. the head pointer must agree with the approved chain read in this transaction
        assertHeadConsistent(ctx);
        // 3. eligibility: replacing a suspended head needs an explicit acknowledgement and a different person than the suspender
        const wasSuspended = !!(ctx.head.eligibility && ctx.head.eligibility.state === 'SUSPENDED');
        if (wasSuspended) {
          if (!acknowledgeSuspended || !reason) throw err('failed-precondition', 'SUSPENDED_ACK_REQUIRED', 'The effective version is suspended: approving a replacement requires acknowledgeSuspended=true and a reason.');
          if (ctx.head.eligibility.changedBy === email) throw err('permission-denied', 'SUSPENDER_CANNOT_RESTORE', 'The person who suspended the version may not restore eligibility by approving its replacement.');
        }
        // 4. dry run of the REAL selector on a shadow approved record (never stored)
        const version = (ctx.head.version || 0) + 1;
        const shadow = { ...candidateOf(v), status: 'approved', version, supersedes: ctx.head.headId, approvedBy: email, enteredBy: (v.enteredBy || '').toLowerCase() };
        const sel = domain.selectResidualValuation({
          asOfDate: today, scope: scopeCore(captureScope(ctx, v.fundId, today)), valuations: [...ctx.ancestors, shadow], records: ctx.records,
        });
        if (sel.status !== 'OK') throw err('failed-precondition', 'APPROVAL_VALIDATION_FAILED', 'The selector refuses this valuation as the effective version.', { reasonCodes: sel.reasonCodes });
        await commitCheck('approve', v.valuationDate);
        // 5. effects
        const approved = { ...v, state: 'approved', status: 'approved', enteredBy: shadow.enteredBy, approvedBy: email, approvedAt: at, version, supersedes: ctx.head.headId, updatedAt: at, rev: (v.rev || 1) + 1 };
        tx.set(ref, approved);
        const eligibility = { state: 'ELIGIBLE', changedBy: email, changedAt: at, reasonCode: wasSuspended ? 'RESTORED_BY_REPLACEMENT' : 'APPROVED', reason: reason || null };
        tx.set(ctx.headRef, {
          ...ctx.head, fundId: v.fundId, valuationDate: v.valuationDate, headId: valuationId, version,
          headHash: documentHash({ valuationId, version, contentHash: v.contentHash, approvedBy: email }),
          eligibility, activeDraftId: null, updatedAt: at, rev: (ctx.head.rev || 0) + 1,
        });
        return {
          result: { ...brief(approved), version, supersedes: ctx.head.headId, contentHash: v.contentHash, eligibility: eligibility.state },
          event: { type: 'APPROVED', ...brief(approved), details: { version, supersedes: ctx.head.headId, contentHash: v.contentHash, reviewedBy: rv.reviewedBy, restoredFromSuspension: wasSuspended, reason: reason || null } },
        };
      },
    });
  }

  /* =====================================================================
     suspend / reinstate — act on ONE specific head (expectedHeadId); an old request can never touch a newer head
     ===================================================================== */
  async function eligibilityChange(request, requireEmail, kind) {
    const action = kind === 'suspend' ? 'suspend' : 'reinstate';
    return envelope(request, {
      action, requireEmail,
      parse: (d) => {
      const fundId = needId(d.fundId, 'fundId');
      if (!realIsoDay(d.valuationDate)) throw err('invalid-argument', 'DATE_INVALID', 'valuationDate must be a real calendar date.');
      const expectedHeadId = needId(d.expectedHeadId, 'expectedHeadId');
      const reason = needReason(d.reason);

        return { targetId: headKey(fundId, d.valuationDate), payload: { expectedHeadId, reason }, d, fundId, expectedHeadId, reason };
      },
      body: async (tx, { email, at }, { d, fundId, expectedHeadId, reason }) => {
        const headRef = db.collection(COLL.heads).doc(headKey(fundId, d.valuationDate));
        const headSnap = await tx.get(headRef);
        const head = headSnap.exists ? headSnap.data() : null;
        if (!head || !head.headId) throw err('failed-precondition', 'NO_HEAD', 'There is no approved valuation for this fund and date.');
        if (head.headId !== expectedHeadId) throw err('failed-precondition', 'STALE_HEAD', 'The effective head is not the one this request targets.', { headId: head.headId, expectedHeadId });
        const cur = head.eligibility && head.eligibility.state;
        if (kind === 'suspend') {
          if (cur === 'SUSPENDED') throw err('failed-precondition', 'ALREADY_SUSPENDED', 'The effective version is already suspended.');
        } else {
          if (cur !== 'SUSPENDED') throw err('failed-precondition', 'NOT_SUSPENDED', 'The effective version is not suspended.');
          if (head.eligibility.changedBy === email) throw err('permission-denied', 'SUSPENDER_CANNOT_RESTORE', 'The person who suspended the version may not reinstate it.');
          const hv = await getValuation(tx, head.headId);
          if (isContributor(hv.v, email) || (hv.v.approvedBy || '').toLowerCase() === email) throw err('permission-denied', 'CONTRIBUTOR_CANNOT_REINSTATE', 'A contributor or the approver of the version may not reinstate it.');
        }
        const eligibility = kind === 'suspend'
          ? { state: 'SUSPENDED', changedBy: email, changedAt: at, reasonCode: 'SUSPENDED', reason }
          : { state: 'ELIGIBLE', changedBy: email, changedAt: at, reasonCode: 'REINSTATED', reason };
        tx.set(headRef, { ...head, eligibility, updatedAt: at, rev: (head.rev || 0) + 1 });
        return {
          result: { fundId, valuationDate: d.valuationDate, headId: head.headId, eligibility: eligibility.state },
          event: { type: kind === 'suspend' ? 'ELIGIBILITY_SUSPENDED' : 'ELIGIBILITY_REINSTATED', fundId, valuationDate: d.valuationDate, valuationId: head.headId, details: { reason, expectedHeadId } },
        };
      },
    });
  }

  /* =====================================================================
     preview — read-only: what would happen to this draft now (no write, no request record)
     ===================================================================== */
  async function preview(request, requireEmail) {
    const email = requireEmail(request);
    await requireAuthorized(email);
    const role = await roleForEmail(email);
    if (!roleAllowed('preview', role)) throw err('permission-denied', 'ROLE_NOT_ALLOWED', `Role "${role}" may not perform preview.`);
    const valuationId = needId(needPayload('preview', request.data || {}).valuationId, 'valuationId');
    const domain = await loadDomain();
    return db.runTransaction(async (tx) => {
      const txRole = await authorizeInTx(tx, email, clock.now().getTime());
      if (!roleAllowed('preview', txRole)) throw err('permission-denied', 'ROLE_NOT_ALLOWED', `Role "${txRole}" may not perform preview.`);
      const { v } = await getValuation(tx, valuationId);
      const ctx = await readContext(tx, v.fundId, v.valuationDate);
      const today = riyadhDay(clock.now());
      const dateOk = v.valuationDate === today;
      const fresh = captureScope(ctx, v.fundId, today);
      const cand = v.state === 'approved' ? null : evaluateCandidate(domain, v, scopeCore(v.scopeSnapshot || fresh), ctx, today, v.baseHeadId || null);
      return {
        ok: true, ...brief(v), contentHash: v.contentHash || null, today, dateOk,
        baseHeadId: v.baseHeadId || null, currentHeadId: headIdOf(ctx), stale: (v.baseHeadId || null) !== headIdOf(ctx),
        scopeChanged: v.scopeHash ? hashScope(fresh) !== v.scopeHash : null,
        candidate: cand ? { status: cand.status, reasonCodes: cand.reasonCodes, issues: cand.issues } : null,
      };
    }, { readOnly: true });
  }

  return {
    createDraft, updateDraft, submit, review, returnDraft, reject, withdraw, approve,
    suspend: (r, e) => eligibilityChange(r, e, 'suspend'), reinstate: (r, e) => eligibilityChange(r, e, 'reinstate'), preview, clock, hooks,
  };
}

/** Loads the pure domain modules from the generated bundle (the same files the browser runs, copied by build-domain). */
function makeDomainLoader(baseDir) {
  let p;
  return () => {
    if (!p) p = (async () => {
      const dir = path.join(baseDir || __dirname, 'generated', 'src', 'domain', 'financial', 'xirr');
      const mod = await import(pathToFileURL(path.join(dir, 'residual-valuation.js')).href);
      return { selectResidualValuation: mod.selectResidualValuation, validateValuationCandidate: mod.validateValuationCandidate };
    })();
    return p;
  };
}

module.exports.createFundValuationService = createFundValuationService;
module.exports.makeDomainLoader = makeDomainLoader;
