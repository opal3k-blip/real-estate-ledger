// R1-B2 / B2-2a — fake valuation SERVER + environment for the actions orchestrator tests.
// The fake follows B1's check order (identity -> authorization -> payload allow-list -> stored-result lookup -> date/state -> effect),
// counts EFFECTS (not calls), and publishes snapshots to the "view" only when the test says so (to model snapshot lag).
import { documentHashHex } from '../../src/domain/validation/document-hash.js';
import { CALLABLES, PAYLOAD_SPEC, roleCanDo, riyadhDay, createGenerationGuard } from '../../src/features/fund-valuation-model.js';
import { createRequestRunner } from '../../src/features/fund-valuation-requests.js';
import { createValuationActions } from '../../src/features/fund-valuation-actions.js';
import { CONTENT_KEYS } from '../../src/features/fund-valuation-editor.js';
import { ROLES_ALLOWED } from './fund-valuation-contract-expectations.mjs';   // hand-written roles for review / return / reject / approve (not the client model)

export const tick = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };
export function fbErr(code, reason) { const e = new Error(reason || code); e.code = 'functions/' + code; if (reason) e.details = { reason }; return e; }
const ACTION_OF = Object.fromEntries(Object.entries(CALLABLES).map(([a, c]) => [c, a]));
const clone = (v) => JSON.parse(JSON.stringify(v));

export function makeStorage({ failSet = false, failGet = false } = {}) {
  const m = new Map();
  const st = {
    m, failSet, failGet,
    getItem(k) { if (st.failGet) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (st.failSet) throw new Error('quota'); m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    key(i) { return [...m.keys()][i] ?? null; },
    get length() { return m.size; },
  };
  return st;
}
export class FakeLocks {
  constructor() { this.held = new Set(); }
  async request(name, opts, cb) {
    await Promise.resolve();
    if (this.held.has(name)) return cb(null);
    this.held.add(name);
    try { return await cb({ name }); } finally { this.held.delete(name); }
  }
}

export const FUND = 'F1';
export const FM = { uid: 'u1', email: 'fm@example.com', role: 'fund_manager', roleResolved: true };
export const FM2 = { uid: 'u2', email: 'fm2@example.com', role: 'fund_manager', roleResolved: true };
export const IC = { uid: 'u3', email: 'ic@example.com', role: 'senior_ic', roleResolved: true };
export const IC2 = { uid: 'u4', email: 'ic2@example.com', role: 'senior_ic', roleResolved: true };
export const ADMIN = { uid: 'u5', email: 'admin@example.com', role: 'admin', roleResolved: true };
export const ANALYST = { uid: 'u6', email: 'analyst@example.com', role: 'analyst', roleResolved: true };

export function goodContent(over = {}) {
  return {
    currency: 'SAR', basis: 'RESIDUAL_VALUE_AS_OF_DATE', residualValue: 1000,
    components: { assetsValue: 900, cashRetained: 200, otherAssets: 50, liabilities: 150, distributionsPayable: 0, otherAssetsItems: [{ description: 'receivable', amount: 50 }] },
    method: 'appraisal', methodNote: 'external appraisal', source: { ref: 'APP-1', provider: 'Valuer Co' },
    nonOverlap: { cashNotInAssets: true, otherAssetsNotInAssets: true, assetsStatedGrossOfLiabilities: true },
    coverage: { linkedAssets: ['A1', 'A2'], unlinkedHoldings: { declared: 'none' } },
    ...over,
  };
}

/** One fake server. `clock.now` is a Date; the server's "today" is the Riyadh day of it. */
export function makeServer({ clock }) {
  const S = {
    members: new Map([['fm@example.com', 'fund_manager'], ['fm2@example.com', 'fund_manager'], ['ic@example.com', 'senior_ic'], ['ic2@example.com', 'senior_ic'], ['admin@example.com', 'admin'], ['analyst@example.com', 'analyst'], ['hybrid@example.com', 'senior_ic']]),
    heads: new Map(),
    vals: new Map(), slot: new Map(), replay: new Map(), calls: [], effects: [],
    includeRev: false, omitValuationId: false, dropReplyOnce: false, hang: false, delay: 0, failBeforeOnce: null, seq: 0, previewDelay: 0, previewHook: null,
  };
  const today = () => riyadhDay(clock.now);
  const slotKey = (f, d) => `${f}::${d}`;
  const hashOf = (content) => documentHashHex(content);
  async function contentDoc(content) { return { contentHash: await hashOf(content) }; }
  const validate = (c) => {
    const issues = [];
    if (typeof c.residualValue !== 'number' || !Number.isFinite(c.residualValue)) issues.push('RESIDUAL_MISSING');
    if (!c.coverage || !c.coverage.linkedAssets) issues.push('COVERAGE_MISSING');
    return { ok: issues.length === 0, issues };
  };
  async function writeDoc(doc, content) {
    for (const k of CONTENT_KEYS) delete doc[k];
    Object.assign(doc, clone(content));
    doc.contentHash = (await contentDoc(content)).contentHash;
    doc.validation = validate(content); doc.rev = (doc.rev || 0) + 1;
  }
  S.docOf = (id) => clone(S.vals.get(id));
  S.headOf = (f, d) => { const h = S.heads.get(slotKey(f, d)); return h ? clone(h) : null; };
  /** an approved head for (fund, date): suspended = { by } makes it SUSPENDED by that person */
  S.seedHead = ({ fundId = FUND, valuationDate = today(), headId = 'H0', version = 1, suspended = null } = {}) => {
    S.heads.set(slotKey(fundId, valuationDate), { headId, version, eligibility: suspended ? { state: 'SUSPENDED', changedBy: suspended.by } : { state: 'ELIGIBLE', changedBy: 'ic@example.com' } });
  };
  S.slotId = (f, d) => S.slot.get(slotKey(f, d)) || null;
  S.effectsOf = (action) => S.effects.filter((e) => e.action === action).length;
  /** a change made by another person/tab, directly on the server */
  S.externalEdit = async (id, content) => { await writeDoc(S.vals.get(id), content); };
  S.seedDraft = async ({ valuationId = 'V0', fundId = FUND, valuationDate = today(), state = 'draft', content = goodContent(), enteredBy = 'fm@example.com', copiedFrom = null, scopeLinks = ['A1', 'A2'] } = {}) => {
    const doc = { valuationId, fundId, valuationDate, state, enteredBy, contributors: [enteredBy], copiedFrom, scopeHash: 'SH1', scopeSnapshot: { linksByFund: { [fundId]: scopeLinks } }, rev: 0 };
    await writeDoc(doc, content); S.vals.set(valuationId, doc);
    if (['draft', 'returned', 'submitted', 'reviewed'].includes(state)) S.slot.set(slotKey(fundId, valuationDate), valuationId);
    return doc;
  };

  async function handle(email, callable, payload) {
    S.calls.push({ callable, payload: clone(payload) });
    if (S.hang) return new Promise(() => {});
    if (S.delay) await new Promise((r) => setTimeout(r, S.delay));
    if (S.failBeforeOnce) { const c = S.failBeforeOnce; S.failBeforeOnce = null; throw fbErr(c); }
    const action = ACTION_OF[callable];
    if (!action) throw fbErr('not-found');
    const role = S.members.get(String(email).toLowerCase());
    if (!role) throw fbErr('permission-denied');   // not a team member: the real server gives no reason either
    if (!(ROLES_ALLOWED[action] ? ROLES_ALLOWED[action].includes(role) : roleCanDo(action, role))) throw fbErr('permission-denied', 'ROLE_NOT_ALLOWED'); // authorization BEFORE the lookup
    const spec = PAYLOAD_SPEC[action];
    const allowed = new Set([...spec.required, ...spec.optional, 'requestId']);
    for (const k of Object.keys(payload)) if (!allowed.has(k)) throw fbErr('invalid-argument', 'PAYLOAD_UNKNOWN_FIELD');
    for (const k of spec.required) if (payload[k] === undefined) throw fbErr('invalid-argument', k === 'reason' ? 'REASON_REQUIRED' : k === 'expectedContentHash' ? 'HASH_INVALID' : k === 'valuationId' ? 'ID_INVALID' : 'PAYLOAD_MISSING'); // the server's own codes for these three
    if (action === 'preview') return preview(email, payload);
    if (action === 'review' || action === 'approve') { if (typeof payload.expectedContentHash !== 'string' || !/^[0-9a-f]{64}$/.test(payload.expectedContentHash)) throw fbErr('invalid-argument', 'HASH_INVALID'); }
    if (action === 'returnDraft' || action === 'reject' || (action === 'approve' && payload.reason !== undefined)) { if (typeof payload.reason !== 'string' || payload.reason.trim() === '' || payload.reason.length > 1000) throw fbErr('invalid-argument', 'REASON_REQUIRED'); }
    if (action === 'approve' && payload.acknowledgeSuspended !== undefined && typeof payload.acknowledgeSuspended !== 'boolean') throw fbErr('invalid-argument', 'ACK_INVALID');
    const sig = JSON.stringify([callable, normalized(action, payload)]);
    const stored = S.replay.get(`${email}|${payload.requestId}`);
    if (stored) { if (stored.sig !== undefined && stored.sig !== sig) throw fbErr('already-exists', 'REQUEST_ID_REUSED'); return { ...clone(stored.result || stored), replayed: true }; }   // lookup BEFORE date/state
    let result;
    if (action === 'createDraft') result = await doCreate(email, payload);
    else if (action === 'updateDraft') result = await doUpdate(email, payload);
    else if (action === 'submit') result = doSubmit(email, payload);
    else if (action === 'withdraw') result = doWithdraw(email, payload);
    else if (action === 'review') result = doReview(email, payload);
    else if (action === 'returnDraft') result = doReturn(email, payload);
    else if (action === 'reject') result = doReject(email, payload);
    else if (action === 'approve') result = doApprove(email, payload);
    else throw fbErr('permission-denied');
    S.replay.set(`${email}|${payload.requestId}`, { sig, result: clone(result) });
    if (S.omitValuationId && action === 'createDraft') { const k = `${email}|${payload.requestId}`; S.effects.push({ action, requestId: payload.requestId, valuationId: result.valuationId }); const out = clone(result); delete out.valuationId; S.replay.set(k, out); return out; } // a malformed reply: the artifact is not named
    if (S.includeRev) { result.rev = S.vals.get(result.valuationId).rev; S.replay.set(`${email}|${payload.requestId}`, { sig, result: clone(result) }); } // optional: the reply carries the revision it produced
    S.effects.push({ action, requestId: payload.requestId, valuationId: result.valuationId });
    return S.dropReplyOnce ? (S.dropReplyOnce = false, (() => { throw fbErr('unavailable'); })()) : result;
  }
  async function doCreate(email, p) {
    const t = today();
    if (p.valuationDate < t) throw fbErr('failed-precondition', 'DATE_CROSSED');
    if (p.valuationDate > t) throw fbErr('failed-precondition', 'DATE_IN_FUTURE');
    if (S.slot.get(slotKey(p.fundId, p.valuationDate))) throw fbErr('failed-precondition', 'ACTIVE_DRAFT_EXISTS');
    let content = p.content; let copiedFrom = null;
    if (p.copyFromValuationId) {
      const src = S.vals.get(p.copyFromValuationId);
      if (!src) throw fbErr('not-found', 'VALUATION_NOT_FOUND');
      if (!['rejected', 'withdrawn', 'draft', 'returned', 'submitted', 'reviewed'].includes(src.state)) throw fbErr('failed-precondition', 'COPY_SOURCE_STATE');
      content = {}; for (const k of CONTENT_KEYS) if (src[k] !== undefined) content[k] = clone(src[k]); copiedFrom = src.valuationId;
    }
    for (const k of Object.keys(content)) if (!CONTENT_KEYS.includes(k)) throw fbErr('invalid-argument', 'CONTENT_UNKNOWN_FIELD');
    const id = `V${++S.seq}`;
    const doc = { valuationId: id, fundId: p.fundId, valuationDate: p.valuationDate, state: 'draft', enteredBy: email, contributors: [email], copiedFrom, scopeHash: 'SH1', scopeSnapshot: { linksByFund: { [p.fundId]: ['A1', 'A2'] } }, rev: 0 };
    await writeDoc(doc, content); S.vals.set(id, doc); S.slot.set(slotKey(p.fundId, p.valuationDate), id);
    return { valuationId: id, fundId: p.fundId, valuationDate: p.valuationDate, state: 'draft', contentHash: doc.contentHash, baseHeadId: null, validation: doc.validation };
  }
  async function doUpdate(email, p) {
    const doc = S.vals.get(p.valuationId);
    if (!doc) throw fbErr('not-found', 'VALUATION_NOT_FOUND');
    if (doc.valuationDate !== today()) throw fbErr('failed-precondition', 'DATE_CROSSED');
    if (!['draft', 'returned'].includes(doc.state)) throw fbErr('failed-precondition', 'INVALID_STATE');
    if (p.expectedContentHash !== doc.contentHash) throw fbErr('failed-precondition', 'CONTENT_CHANGED');
    for (const k of Object.keys(p.content)) if (!CONTENT_KEYS.includes(k)) throw fbErr('invalid-argument', 'CONTENT_UNKNOWN_FIELD');
    const next = {}; for (const k of CONTENT_KEYS) if (doc[k] !== undefined) next[k] = doc[k];
    Object.assign(next, clone(p.content)); // top-level replace, like the server
    await writeDoc(doc, next); if (!doc.contributors.includes(email)) doc.contributors.push(email);
    return { valuationId: doc.valuationId, fundId: doc.fundId, valuationDate: doc.valuationDate, state: doc.state, contentHash: doc.contentHash, validation: doc.validation };
  }
  function doSubmit(email, p) {
    const doc = S.vals.get(p.valuationId);
    if (!doc) throw fbErr('not-found', 'VALUATION_NOT_FOUND');
    if (doc.valuationDate !== today()) throw fbErr('failed-precondition', 'DATE_CROSSED');
    if (['submitted', 'reviewed'].includes(doc.state)) throw fbErr('failed-precondition', 'ALREADY_SUBMITTED');
    if (!['draft', 'returned'].includes(doc.state)) throw fbErr('failed-precondition', 'INVALID_STATE');
    if (!doc.validation.ok) throw fbErr('failed-precondition', 'VALIDATION_FAILED');
    doc.state = 'submitted'; doc.rev += 1;
    return { valuationId: doc.valuationId, fundId: doc.fundId, valuationDate: doc.valuationDate, state: 'submitted', contentHash: doc.contentHash };
  }
  function doWithdraw(email, p) {
    const doc = S.vals.get(p.valuationId);
    if (!doc) throw fbErr('not-found', 'VALUATION_NOT_FOUND');
    if (!['draft', 'returned', 'submitted', 'reviewed'].includes(doc.state)) throw fbErr('failed-precondition', 'INVALID_STATE'); // withdraw is NOT day-checked (model DAY_CHECKED)
    doc.state = 'withdrawn'; doc.rev += 1; S.slot.delete(slotKey(doc.fundId, doc.valuationDate));
    return { valuationId: doc.valuationId, fundId: doc.fundId, valuationDate: doc.valuationDate, state: 'withdrawn', contentHash: doc.contentHash };
  }
  async function preview(email, p) {
    const doc = S.vals.get(p.valuationId);
    if (!doc) throw fbErr('not-found', 'VALUATION_NOT_FOUND');
    if (S.previewDelay) await new Promise((r) => setTimeout(r, S.previewDelay));
    if (S.previewHook) await S.previewHook(doc);
    return { ok: true, valuationId: doc.valuationId, state: doc.state, contentHash: doc.contentHash, today: today(), dateOk: doc.valuationDate === today(), baseHeadId: null, currentHeadId: null, stale: false, scopeChanged: false, candidate: { status: doc.validation.ok ? 'ELIGIBLE' : 'BLOCKED', reasonCodes: doc.validation.issues, issues: null } };
  }

  // ---- review / return / reject / approve (B2-3a): the SAME order of checks as functions/fund-valuations.cjs, compared with it by the contract test ----
  const normalized = (action, p) => {
    const { requestId, ...rest } = p;
    if (action === 'approve') return { valuationId: rest.valuationId, expectedContentHash: rest.expectedContentHash, acknowledgeSuspended: rest.acknowledgeSuspended === true, reason: rest.reason === undefined ? null : String(rest.reason).trim() };
    if (action === 'returnDraft' || action === 'reject') return { valuationId: rest.valuationId, reason: String(rest.reason).trim() };
    return rest;
  };
  const brief = (d) => ({ valuationId: d.valuationId, fundId: d.fundId, valuationDate: d.valuationDate, state: d.state });
  const isContrib = (d, email) => Array.isArray(d.contributors) && d.contributors.includes(email);
  const needDay = (d) => { if (d.valuationDate < today()) throw fbErr('failed-precondition', 'DATE_CROSSED'); if (d.valuationDate > today()) throw fbErr('failed-precondition', 'DATE_IN_FUTURE'); };
  const getDoc = (id) => { const d = S.vals.get(id); if (!d) throw fbErr('not-found', 'VALUATION_NOT_FOUND'); return d; };
  function doReview(email, p) {
    const d = getDoc(p.valuationId); needDay(d);
    if (isContrib(d, email)) throw fbErr('permission-denied', 'CONTRIBUTOR_CANNOT_REVIEW');
    if (d.state !== 'submitted') throw fbErr('failed-precondition', 'INVALID_STATE');
    if (p.expectedContentHash !== d.contentHash) throw fbErr('failed-precondition', 'CONTENT_CHANGED');
    d.state = 'reviewed'; d.review = { reviewedBy: email, reviewedContentHash: d.contentHash }; d.rev += 1;
    return { ...brief(d), contentHash: d.contentHash };
  }
  function doReturn(email, p) {
    const d = getDoc(p.valuationId);                                                    // NOT day-checked
    if (isContrib(d, email)) throw fbErr('permission-denied', 'CONTRIBUTOR_CANNOT_REVIEW');
    if (!['submitted', 'reviewed'].includes(d.state)) throw fbErr('failed-precondition', 'INVALID_STATE');
    d.state = 'returned'; d.review = null; d.returnedBy = email; d.returnReason = String(p.reason).trim(); d.rev += 1;   // the slot stays
    return brief(d);
  }
  function doReject(email, p) {
    const d = getDoc(p.valuationId);                                                    // NOT day-checked
    if (isContrib(d, email)) throw fbErr('permission-denied', 'CONTRIBUTOR_CANNOT_REVIEW');
    if (!['submitted', 'reviewed', 'returned'].includes(d.state)) throw fbErr('failed-precondition', 'INVALID_STATE');
    d.state = 'rejected'; d.review = null; d.rejectReason = String(p.reason).trim(); d.rev += 1; S.slot.delete(slotKey(d.fundId, d.valuationDate));
    return brief(d);
  }
  function doApprove(email, p) {
    const d = getDoc(p.valuationId); needDay(d);
    if (isContrib(d, email) || String(d.enteredBy || '').toLowerCase() === email) throw fbErr('permission-denied', 'CONTRIBUTOR_CANNOT_APPROVE');
    if (d.state === 'approved') throw fbErr('failed-precondition', 'ALREADY_APPROVED');
    if (d.state !== 'reviewed') throw fbErr('failed-precondition', 'INVALID_STATE');
    if (p.expectedContentHash !== d.contentHash) throw fbErr('failed-precondition', 'CONTENT_CHANGED');
    if (!d.review || d.review.reviewedContentHash !== d.contentHash) throw fbErr('failed-precondition', 'REVIEW_NOT_CURRENT');
    const head = S.heads.get(slotKey(d.fundId, d.valuationDate)) || { headId: null, version: 0, eligibility: null };
    const wasSuspended = !!(head.eligibility && head.eligibility.state === 'SUSPENDED');
    const reason = p.reason === undefined ? null : String(p.reason).trim();
    if (wasSuspended) {
      if (p.acknowledgeSuspended !== true || !reason) throw fbErr('failed-precondition', 'SUSPENDED_ACK_REQUIRED');
      if (head.eligibility.changedBy === email) throw fbErr('permission-denied', 'SUSPENDER_CANNOT_RESTORE');
    }
    const version = (head.version || 0) + 1;
    d.state = 'approved'; d.status = 'approved'; d.version = version; d.supersedes = head.headId; d.approvedBy = email; d.rev += 1;
    S.heads.set(slotKey(d.fundId, d.valuationDate), { headId: d.valuationId, version, eligibility: { state: 'ELIGIBLE', changedBy: email } });
    S.slot.delete(slotKey(d.fundId, d.valuationDate));
    return { ...brief(d), version, supersedes: head.headId, contentHash: d.contentHash, eligibility: 'ELIGIBLE' };
  }
  S.handle = handle;
  return S;
}

/** A complete environment: server + session + runner + actions + a view the test publishes by hand (or automatically). */
export function makeEnv({ session = FM, now = '2026-10-11T10:00:00Z', auto = false, storage = makeStorage(), locks = new FakeLocks(), linkProposal = undefined, awaitDelayedMs = 8000, awaitStalledMs = 20000, timers = true } = {}) {
  const clock = { now: new Date(now) };
  const server = makeServer({ clock });
  const box = { s: { ...session } };
  const guard = createGenerationGuard();
  const view = { approvedByDate: new Map(), approvedMode: null, status: 'empty', stale: false, drafts: new Map(), latest: null, selectedDate: null, refreshCalls: 0, noContext: false, issued: 0, dataEpoch: null, readConfirmed: true, noRead: false, readTarget: null };
  const sel = () => view.selectedDate || riyadhDay(clock.now);
  let n = 0;
  const runner = createRequestRunner({
    getUser: () => (box.s ? box.s.email : null), storage, locks, guard, now: () => clock.now.getTime(), genId: () => `req_${String(++n).padStart(6, '0')}`,
    call: async (callable, payload, { user }) => server.handle(user, callable, payload),
  });
  const timersLog = []; let tid = 0; const live = new Map();
  const setTimer = timers ? (fn, ms) => { const id = ++tid; live.set(id, { fn, ms }); timersLog.push({ id, ms }); return id; } : setTimeout;
  const clearTimer = timers ? (id) => { live.delete(id); } : clearTimeout;
  const hooks = {};                       // a test may replace the context source / the refresh request (e.g. with a real reader)
  const getContext = (date) => {
    if (hooks.getContext) return hooks.getContext(date);
    if (view.noContext) return null;
    const d = date === undefined ? sel() : date;
    const draftId = server.slotId(FUND, d);
    // the VIEW's copy of the draft: whatever was last published for that date
    const pub = view.drafts.get(d) || null;
    const ctx = { fundId: FUND, valuationDate: d, status: view.status, stale: view.stale, draft: pub ? (pub.__missing ? { id: pub.valuationId, missing: true, doc: null } : { id: pub.valuationId, missing: false, doc: clone(pub) }) : null, latestValuation: view.latest, linkProposal };
    if (view.approvedMode !== 'unknown') ctx.approved = view.approvedMode || view.approvedByDate.get(d) || { kind: 'none' };   // 'unknown' = an older reader that does not report the head at all
    // the reader's read marker: `issued` = reads STARTED so far; `epoch` = number of the read that produced the shown data (null = listener data); `confirmed`
    if (!view.noRead) ctx.read = { ...(view.legacyRead ? {} : { issued: view.issued }), epoch: view.dataEpoch, confirmed: view.readConfirmed && view.status !== 'loading', fundId: FUND, valuationDate: d, ...(view.readTarget || {}) };
    void draftId; return ctx;
  };
  const actions = createValuationActions({
    getContext, getSession: () => box.s, runner, guard, now: () => clock.now, setTimer, clearTimer, awaitDelayedMs, awaitStalledMs,
    callPreview: async ({ valuationId }) => server.handle(box.s.email, 'getValuationPreview', { valuationId }),
    refreshView: () => { view.refreshCalls += 1; if (hooks.refreshView) return hooks.refreshView(); },
  });
  /** deliver the server's current state to the view (the reader's snapshot) */
  const publish = ({ stale = false, keepEpoch = false } = {}) => {
    if (!keepEpoch) view.dataEpoch = null;                                  // a listener snapshot proves no order
    view.drafts = new Map();
    for (const doc of server.vals.values()) { if (server.slotId(doc.fundId, doc.valuationDate) === doc.valuationId) view.drafts.set(doc.valuationDate, clone(doc)); }
    view.approvedByDate = new Map();
    for (const [k, h] of server.heads) { const date = k.split('::')[1]; view.approvedByDate.set(date, { kind: h.eligibility.state === 'SUSPENDED' ? 'suspended' : 'effective', headId: h.headId, version: h.version, valuationDate: date, eligibility: clone(h.eligibility) }); }
    view.status = view.drafts.size || view.latest || view.approvedByDate.size ? 'ready' : 'empty'; view.stale = stale; actions.sync();
  };
  /** a NEW read STARTED after everything that happened so far (issued + 1) and delivered the server's current state */
  const publishFresh = ({ stale = false } = {}) => { view.issued += 1; view.dataEpoch = view.issued; view.readConfirmed = !stale; publish({ stale, keepEpoch: true }); };
  /** the result of read number n arrives now (n may have started long ago); `issued` does not move */
  const deliverRead = (n, { stale = false } = {}) => { view.dataEpoch = n; view.readConfirmed = !stale; publish({ stale, keepEpoch: true }); };
  const fire = (ms) => { for (const [id, t] of [...live]) if (t.ms <= ms) { live.delete(id); t.fn(); } };
  const setSession = (s) => { box.s = s ? { ...s } : null; };
  if (auto) { /* tests that want automatic delivery call publish() themselves after each step */ }
  return { clock, server, box, guard, view, runner, actions, storage, locks, publish, publishFresh, deliverRead, hooks, fire, live, timersLog, setSession, getContext };
}
