// R1-B2 / B2-2a — fake valuation SERVER + environment for the actions orchestrator tests.
// The fake follows B1's check order (identity -> authorization -> payload allow-list -> stored-result lookup -> date/state -> effect),
// counts EFFECTS (not calls), and publishes snapshots to the "view" only when the test says so (to model snapshot lag).
import { documentHashHex } from '../../src/domain/validation/document-hash.js';
import { CALLABLES, PAYLOAD_SPEC, roleCanDo, riyadhDay, createGenerationGuard } from '../../src/features/fund-valuation-model.js';
import { createRequestRunner } from '../../src/features/fund-valuation-requests.js';
import { createValuationActions } from '../../src/features/fund-valuation-actions.js';
import { CONTENT_KEYS } from '../../src/features/fund-valuation-editor.js';

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
    members: new Map([['fm@example.com', 'fund_manager'], ['fm2@example.com', 'fund_manager'], ['ic@example.com', 'senior_ic']]),
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
    if (!role || !roleCanDo(action, role)) throw fbErr('permission-denied'); // authorization BEFORE the lookup
    const spec = PAYLOAD_SPEC[action];
    const allowed = new Set([...spec.required, ...spec.optional, 'requestId']);
    for (const k of Object.keys(payload)) if (!allowed.has(k)) throw fbErr('invalid-argument', 'PAYLOAD_UNKNOWN_FIELD');
    for (const k of spec.required) if (payload[k] === undefined) throw fbErr('invalid-argument', 'PAYLOAD_MISSING');
    if (action === 'preview') return preview(email, payload);
    const stored = S.replay.get(`${email}|${payload.requestId}`);
    if (stored) return { ...clone(stored), replayed: true };                    // lookup BEFORE date/state
    let result;
    if (action === 'createDraft') result = await doCreate(email, payload);
    else if (action === 'updateDraft') result = await doUpdate(email, payload);
    else if (action === 'submit') result = doSubmit(email, payload);
    else if (action === 'withdraw') result = doWithdraw(email, payload);
    else throw fbErr('permission-denied');
    S.replay.set(`${email}|${payload.requestId}`, clone(result));
    if (S.omitValuationId && action === 'createDraft') { const k = `${email}|${payload.requestId}`; S.effects.push({ action, requestId: payload.requestId, valuationId: result.valuationId }); const out = clone(result); delete out.valuationId; S.replay.set(k, out); return out; } // a malformed reply: the artifact is not named
    if (S.includeRev) { result.rev = S.vals.get(result.valuationId).rev; S.replay.set(`${email}|${payload.requestId}`, clone(result)); } // optional: the reply carries the revision it produced
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
  S.handle = handle;
  return S;
}

/** A complete environment: server + session + runner + actions + a view the test publishes by hand (or automatically). */
export function makeEnv({ session = FM, now = '2026-10-11T10:00:00Z', auto = false, storage = makeStorage(), locks = new FakeLocks(), linkProposal = undefined, awaitDelayedMs = 8000, awaitStalledMs = 20000, timers = true } = {}) {
  const clock = { now: new Date(now) };
  const server = makeServer({ clock });
  const box = { s: { ...session } };
  const guard = createGenerationGuard();
  const view = { status: 'empty', stale: false, drafts: new Map(), latest: null, selectedDate: null, refreshCalls: 0, noContext: false, issued: 0, dataEpoch: null, readConfirmed: true, noRead: false, readTarget: null };
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
    view.status = view.drafts.size || view.latest ? 'ready' : 'empty'; view.stale = stale; actions.sync();
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
