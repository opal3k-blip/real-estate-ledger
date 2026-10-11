/* XIRR-R1B2 / B2-0 — pending-request store, per-scope lock and runner for the valuation callables.
   Pure logic: storage, locks and the network call are injected (no DOM, no Firebase). Contract §5.
   Scope = user + fund + valuation date (NOT valuationId alone). While a request of a scope is unresolved no other
   mutating action of that scope starts, and nothing is ever replaced automatically.
   Fail-closed rules: MODIFYING actions need (a) a reliable cross-tab lock (Web Locks) and (b) shared storage that can be
   read, written and read back. Without them the runner refuses to send; viewing is unaffected. */
import { documentHashHex } from '../domain/validation/document-hash.js';
import { buildPayload, deepClone, CALLABLES, PAYLOAD_SPEC, normalizeFunctionsErrorCode, describeError } from './fund-valuation-model.js';

export const STORE_PREFIX = 'reop:pendingValuationRequests:v1:';
export const LEASE_PREFIX = 'reop:valuationLease:v1:';
const PROBE_KEY = 'reop:valuationStorageProbe:v1';

/* First attempt: these codes mean the transaction was rolled back (failed requests are never recorded). */
const DEFINITIVE = new Set(['invalid-argument', 'permission-denied', 'unauthenticated', 'not-found', 'failed-precondition', 'already-exists']);
/* Retry of an ambiguous request. A refusal proves "no effect" ONLY when it is raised after the server's stored-result
   lookup. In B1 that holds for every failed-precondition / not-found reason (all raised inside the transaction body or
   helpers it calls); it does NOT hold for invalid-argument (payload shape is checked BEFORE the lookup) nor for
   permission-denied (authorization is checked BEFORE the lookup). A code without a known reason is never trusted.
   The list is tied to the server source by a test: a new reason there forces a review here. */
export const NO_EFFECT_AFTER_LOOKUP_REASONS = Object.freeze([
  'ALREADY_APPROVED', 'ALREADY_SUBMITTED', 'ALREADY_SUSPENDED', 'APPROVAL_VALIDATION_FAILED', 'CONTENT_CHANGED', 'CONTENT_HASH_MISMATCH',
  'COPY_SOURCE_MISMATCH', 'COPY_SOURCE_STATE', 'DATE_CROSSED', 'DATE_IN_FUTURE', 'FUND_NOT_FOUND', 'HEAD_POINTER_INCONSISTENT', 'INVALID_STATE',
  'NOT_SUSPENDED', 'NO_HEAD', 'REVIEW_NOT_CURRENT', 'SCOPE_CHANGED', 'SLOT_INCONSISTENT', 'STALE_HEAD', 'SUSPENDED_ACK_REQUIRED',
  'VALIDATION_FAILED', 'VALUATION_NOT_FOUND',
]);
const AFTER_LOOKUP = new Set(NO_EFFECT_AFTER_LOOKUP_REASONS);
const RETRY_UNRESOLVED = new Set(['permission-denied', 'unauthenticated', 'already-exists', 'invalid-argument']);
const RETRY_CHECKED = new Set(['failed-precondition', 'not-found']);

/** @param {{outcome:{ok:boolean,code?:string|null,reason?:string|null}, attempt:'first'|'retry'}} a -> 'success'|'no_effect'|'ambiguous'|'unresolved' */
export function classifyResult({ outcome, attempt }) {
  if (outcome && outcome.ok) return 'success';
  const code = normalizeFunctionsErrorCode(outcome && outcome.code);
  const reason = outcome && typeof outcome.reason === 'string' ? outcome.reason : null;
  if (attempt === 'retry') {
    if (code && RETRY_UNRESOLVED.has(code)) return 'unresolved';
    if (code && RETRY_CHECKED.has(code)) return reason && AFTER_LOOKUP.has(reason) ? 'no_effect' : 'unresolved';
    return 'ambiguous';
  }
  return code && DEFINITIVE.has(code) ? 'no_effect' : 'ambiguous';
}

export function scopeKey({ user, fundId, valuationDate }) { return JSON.stringify([String(user || '').toLowerCase(), fundId, valuationDate]); }
export function scopeLabel(scope) { try { return JSON.parse(scope).join('::'); } catch (e) { return String(scope); } }
export function scopeOfValuation(v) { return { fundId: v && v.fundId, valuationDate: v && v.valuationDate }; }

export function defaultGenId() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(24);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return 'vr_' + Array.from(bytes, (b) => abc[b % abc.length]).join('');
}

/* ---------- store: one key per scope; "nothing there" is distinguished from "could not find out" ---------- */
export function createPendingStore(storage) {
  const mem = new Map(); // tab-local copy, ONLY for updates that could not be persisted after a request was already sent
  const state = { localFallback: false, corruptKeys: 0, unreadable: false };
  const keyFor = (scope) => STORE_PREFIX + encodeURIComponent(scope);
  const corruptEntry = (scope) => ({ v: 1, scope, requestId: null, action: null, callable: null, payload: null, signature: null, sentAt: null, status: 'unresolved', attempts: 0, lastOutcome: { code: 'PENDING_CORRUPT' }, corrupt: true });
  const valid = (e) => e && typeof e === 'object' && e.v === 1 && typeof e.scope === 'string' && typeof e.requestId === 'string' && typeof e.action === 'string'
    && typeof e.callable === 'string' && e.payload && typeof e.payload === 'object' && typeof e.signature === 'string' && ['inflight', 'ambiguous', 'unresolved'].includes(e.status);
  /** @returns {{kind:'none'}|{kind:'entry',entry:object}|{kind:'unknown'}} */
  function readState(scope) {
    if (mem.has(scope)) return { kind: 'entry', entry: deepClone(mem.get(scope)) };
    if (!storage) return { kind: 'unknown' };
    let raw;
    try { raw = storage.getItem(keyFor(scope)); } catch (e) { state.unreadable = true; return { kind: 'unknown' }; }
    if (raw == null) return { kind: 'none' };
    try { const e = JSON.parse(raw); if (valid(e) && e.scope === scope) return { kind: 'entry', entry: e }; } catch (e) { /* corrupt */ }
    state.corruptKeys += 1;
    return { kind: 'entry', entry: corruptEntry(scope) };
  }
  const read = (scope) => { const r = readState(scope); return r.kind === 'entry' ? r.entry : null; };
  /** Persist and read back. false = NOT durably stored (the caller must not send). */
  function writeVerified(entry) {
    if (!storage) return false;
    try { const raw = JSON.stringify(entry); storage.setItem(keyFor(entry.scope), raw); mem.delete(entry.scope); return storage.getItem(keyFor(entry.scope)) === raw; } catch (e) { return false; }
  }
  /** After a request was sent: keep the newest state even if persisting fails (tab-local, flagged). */
  function writeAfterSend(entry) { if (!writeVerified(entry)) { mem.set(entry.scope, deepClone(entry)); state.localFallback = true; } }
  function remove(scope) {
    mem.delete(scope);
    if (!storage) return false;
    try { storage.removeItem(keyFor(scope)); return storage.getItem(keyFor(scope)) == null; } catch (e) { return false; }
  }
  function list(userLc) {
    const scopes = new Set(mem.keys());
    if (storage) {
      try { for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(STORE_PREFIX)) scopes.add(decodeURIComponent(k.slice(STORE_PREFIX.length))); } } catch (e) { state.unreadable = true; }
    } else state.unreadable = true;
    const out = [];
    for (const s of scopes) {
      let u; try { u = JSON.parse(s)[0]; } catch (e) { continue; }
      if (userLc && u !== userLc) continue; // never show another user's pending requests
      const e = read(s); if (e) out.push(e);
    }
    return out;
  }
  /** shared storage usable for coordination: write, read back, remove */
  function probe() {
    if (!storage) return false;
    try { const t = String(Math.random()); storage.setItem(PROBE_KEY, t); const ok = storage.getItem(PROBE_KEY) === t; storage.removeItem(PROBE_KEY); return ok; } catch (e) { return false; }
  }
  return { readState, read, writeVerified, writeAfterSend, remove, list, probe, get localFallback() { return state.localFallback; }, get corruptKeys() { return state.corruptKeys; }, get unreadable() { return state.unreadable; } };
}

/* ---------- per-scope exclusive lock: Web Locks (ifAvailable) when present, otherwise a WEAK localStorage lease ---------- */
export function createScopeLocks({ locks, storage, now = () => Date.now(), leaseTtlMs = 60000 }) {
  const mode = locks && typeof locks.request === 'function' ? 'web' : 'weak';
  const memLeases = new Map();
  let seq = 0;
  async function runWeb(scope, fn) {
    return locks.request('reop-valuation:' + scope, { ifAvailable: true }, async (lock) => (lock ? { locked: true, value: await fn() } : { locked: false }));
  }
  async function runWeak(scope, fn) {
    const key = LEASE_PREFIX + encodeURIComponent(scope);
    const token = `${now()}-${Math.random().toString(36).slice(2)}-${++seq}`;
    const getLease = () => { if (memLeases.has(scope)) return memLeases.get(scope); if (!storage) return null; try { const r = storage.getItem(key); return r ? JSON.parse(r) : null; } catch (e) { return null; } };
    const setLease = (l) => { if (storage) { try { storage.setItem(key, JSON.stringify(l)); return; } catch (e) { /* memory */ } } memLeases.set(scope, l); };
    const clear = () => { memLeases.delete(scope); if (storage) { try { storage.removeItem(key); } catch (e) { /* ignore */ } } };
    const cur = getLease();
    if (cur && cur.expires > now()) return { locked: false };
    setLease({ token, expires: now() + leaseTtlMs });
    const back = getLease();
    if (!back || back.token !== token) return { locked: false };
    try { return { locked: true, value: await fn() }; } finally { const l = getLease(); if (l && l.token === token) clear(); }
  }
  return { mode, run: (scope, fn) => (mode === 'web' ? runWeb(scope, fn) : runWeak(scope, fn)) };
}

/* ---------- runner ---------- */
export function createRequestRunner({ getUser, call, storage, locks, guard, now = () => Date.now(), genId = defaultGenId, hashFn = documentHashHex, leaseTtlMs }) {
  const store = createPendingStore(storage);
  const lock = createScopeLocks({ locks, storage, now, leaseTtlMs });
  const listeners = new Set();
  const notify = () => { for (const f of listeners) { try { f(); } catch (e) { /* listener errors never break the runner */ } } };
  const user = () => { const u = getUser && getUser(); return typeof u === 'string' && u ? u.toLowerCase() : null; };
  /* An operation is bound to the identity AND the session generation it started under; it is re-checked after every wait. */
  const identity = () => ({ user: user(), gen: guard ? guard.current() : 0 });
  const stillSame = (id) => { const c = identity(); return c.user === id.user && c.gen === id.gen; };
  const sign = (e) => hashFn({ scope: e.scope, action: e.action, callable: e.callable, payload: e.payload });
  const blocked = (code, entry, extra) => ({ status: 'blocked', code, entry: entry ? deepClone(entry) : null, ...(extra || {}) });
  const aborted = () => ({ status: 'aborted', code: 'SESSION_CHANGED' });
  /** Modifying actions need a reliable lock and shared storage. Viewing never depends on this. */
  function mutationGate() {
    const reasons = [];
    if (lock.mode !== 'web') reasons.push('NO_RELIABLE_LOCK');
    if (!store.probe()) reasons.push('STORAGE_UNAVAILABLE');
    return { allowed: reasons.length === 0, reasons };
  }

  async function send(callable, payload, id) {
    try { const data = await call(callable, deepClone(payload), { user: id.user }); return { ok: true, data }; } catch (e) {
      const d = e && e.details;
      return { ok: false, code: normalizeFunctionsErrorCode(e && e.code), reason: d && typeof d === 'object' && typeof d.reason === 'string' ? d.reason : null, error: e };
    }
  }
  const outcomeRecord = (r) => ({ code: r.code || null, reason: r.reason || null, at: now() });
  /** The result belongs to the scope's owner. If the session changed meanwhile it is stored for the owner and NOT shown. */
  const present = (id, shown) => (stillSame(id) ? shown : { status: 'background', outcome: shown.status });

  async function begin({ action, fields, scope: sc }) {
    const id = identity();
    if (!id.user) return blocked('NO_SESSION');
    if (action === 'preview') return blocked('PREVIEW_NOT_QUEUED');
    if (!sc || !sc.fundId || !sc.valuationDate) return blocked('SCOPE_MISMATCH');
    const gate = mutationGate();
    if (!gate.allowed) return blocked(gate.reasons[0], null, { reasons: gate.reasons });
    const scope = scopeKey({ user: id.user, fundId: sc.fundId, valuationDate: sc.valuationDate });
    const requestId = genId();
    let payload;
    try { payload = buildPayload(action, { ...fields, requestId }); } catch (e) { return { status: 'invalid', code: e.clientCode || 'PAYLOAD_INVALID', error: describeError(e) }; }
    if ((payload.fundId !== undefined && payload.fundId !== sc.fundId) || (payload.valuationDate !== undefined && payload.valuationDate !== sc.valuationDate)) return blocked('SCOPE_MISMATCH');
    const callable = CALLABLES[action];
    /* `payload` is an independent deep copy taken before the first wait: the same object content is signed, stored and sent. */
    const res = await lock.run(scope, async () => {
      if (!stillSame(id)) return aborted();                       // the lock wait may have outlived the session
      const rs = store.readState(scope);
      if (rs.kind === 'unknown') return blocked('STORAGE_UNREADABLE'); // cannot rule out an earlier request: no new one
      if (rs.kind === 'entry') return blocked('PENDING_EXISTS', rs.entry);
      const entry = { v: 1, scope, requestId, action, callable, payload, signature: null, sentAt: now(), status: 'inflight', attempts: 1, lastOutcome: null };
      entry.signature = await sign(entry);
      if (!stillSame(id)) return aborted();                       // the hash wait may have outlived the session
      if (!store.writeVerified(entry)) { store.remove(scope); return blocked('STORAGE_WRITE_FAILED'); } // not durable: do NOT send
      notify();                                                    // written (and read back) BEFORE sending; no await until the call
      const r = await send(callable, payload, id);
      const cls = classifyResult({ outcome: r, attempt: 'first' });
      if (cls === 'success') { store.remove(scope); notify(); return present(id, { status: 'success', data: r.data, replayed: !!(r.data && r.data.replayed) }); }
      if (cls === 'no_effect') { store.remove(scope); notify(); return present(id, { status: 'no_effect', error: describeError(r.error) }); }
      const kept = { ...entry, status: 'ambiguous', lastOutcome: outcomeRecord(r) };
      store.writeAfterSend(kept); notify();
      return present(id, { status: 'ambiguous', entry: deepClone(kept), error: describeError(r.error) });
    });
    return res.locked ? res.value : blocked('LOCKED_OTHER_TAB');
  }

  async function retry(scope) {
    const id = identity();
    if (!id.user) return blocked('NO_SESSION');
    try { if (JSON.parse(scope)[0] !== id.user) return blocked('NO_SESSION'); } catch (e) { return blocked('SCOPE_MISMATCH'); }
    const gate = mutationGate();
    if (!gate.allowed) return blocked(gate.reasons[0], null, { reasons: gate.reasons });
    const res = await lock.run(scope, async () => {
      if (!stillSame(id)) return aborted();
      const rs = store.readState(scope);
      if (rs.kind === 'unknown') return blocked('STORAGE_UNREADABLE');
      if (rs.kind === 'none') return { status: 'none' };
      const entry = rs.entry;
      if (entry.corrupt) return blocked('PENDING_CORRUPT', entry);
      if ((await sign(entry)) !== entry.signature) return blocked('SIGNATURE_MISMATCH', entry);
      if (!stillSame(id)) return aborted();
      const sending = { ...entry, status: 'inflight', attempts: entry.attempts + 1 };
      if (!store.writeVerified(sending)) return blocked('STORAGE_WRITE_FAILED', entry);
      notify();
      const r = await send(entry.callable, entry.payload, id); // verbatim payload, same requestId
      const cls = classifyResult({ outcome: r, attempt: 'retry' });
      if (cls === 'success') { store.remove(scope); notify(); return present(id, { status: 'success', data: r.data, replayed: !!(r.data && r.data.replayed) }); }
      if (cls === 'no_effect') { store.remove(scope); notify(); return present(id, { status: 'no_effect', error: describeError(r.error) }); }
      const kept = { ...sending, status: cls, lastOutcome: outcomeRecord(r) };
      store.writeAfterSend(kept); notify();
      return present(id, { status: cls, entry: deepClone(kept), code: cls === 'unresolved' ? 'UNRESOLVED_PERMISSION' : undefined, error: describeError(r.error) });
    });
    return res.locked ? res.value : blocked('LOCKED_OTHER_TAB');
  }

  /** Never calls the server, but it CHANGES the record, so it needs the same reliable lock and shared storage as sending. */
  async function discard(scope, { acknowledgeRisk } = {}) {
    if (acknowledgeRisk !== true) return blocked('ACK_REQUIRED');
    const id = identity();
    if (!id.user) return blocked('NO_SESSION');
    try { if (JSON.parse(scope)[0] !== id.user) return blocked('NO_SESSION'); } catch (e) { return blocked('SCOPE_MISMATCH'); }
    const gate = mutationGate(); // changing the record is a modification: same reliable lock + storage as sending
    if (!gate.allowed) return blocked(gate.reasons[0], null, { reasons: gate.reasons });
    const res = await lock.run(scope, async () => {
      if (!stillSame(id)) return aborted();
      if (!store.remove(scope)) return blocked('STORAGE_WRITE_FAILED');
      notify(); return { status: 'discarded' };
    });
    return res.locked ? res.value : blocked('LOCKED_OTHER_TAB');
  }

  /** On start: an `inflight` entry whose scope lock nobody holds was left by a closed/crashed tab -> `ambiguous`. */
  async function recoverInflight() {
    const id = identity(); const out = [];
    if (!id.user) return out;
    if (!mutationGate().allowed) return out; // rewriting a record needs the reliable lock too; reading continues
    for (const e of store.list(id.user)) {
      if (e.status !== 'inflight' || e.corrupt) continue;
      const r = await lock.run(e.scope, async () => {
        if (!stillSame(id)) return false;
        const cur = store.read(e.scope);
        if (cur && cur.status === 'inflight') { store.writeAfterSend({ ...cur, status: 'ambiguous', lastOutcome: { code: 'RECOVERED_INFLIGHT', reason: null, at: now() } }); return true; }
        return false;
      });
      if (r.locked && r.value) out.push(e.scope);
    }
    if (out.length) notify();
    return out;
  }

  return {
    begin, retry, discard, recoverInflight, mutationGate,
    pending: () => { const u = user(); return u ? store.list(u).map(deepClone) : []; }, // copies: callers cannot alter internal state
    get: (scope) => deepClone(store.read(scope)),
    /** true also when the answer is unknown (fail closed) */
    isBlocked: ({ fundId, valuationDate }) => { const u = user(); if (!u) return false; return store.readState(scopeKey({ user: u, fundId, valuationDate })).kind !== 'none'; },
    subscribe: (f) => { listeners.add(f); return () => listeners.delete(f); },
    refresh: notify, // for the `storage` event: refresh the banner only, never a gate
    get lockMode() { return lock.mode; }, get storageOk() { return store.probe(); }, get localFallback() { return store.localFallback; },
    get storageUnreadable() { return store.unreadable; }, get corruptKeys() { return store.corruptKeys; },
  };
}

export { PAYLOAD_SPEC };
