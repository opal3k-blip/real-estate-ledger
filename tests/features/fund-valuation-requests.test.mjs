/* XIRR-R1B2 / B2-0 — pending-request store, scope lock and runner of the valuation callables.
   Run: node tests/features/fund-valuation-requests.test.mjs   (exit 0 only if all pass)
   The "server" below is a fake that implements B1's CHECK ORDER (identity -> authorization -> payload allow-list ->
   in-transaction authorization -> stored-result lookup -> state checks -> effect) and counts effects, so the
   ambiguous-request scenarios are exercised against the property the classification depends on. */
import assert from 'assert/strict';
import { createRequire } from 'module';
import * as R from '../../src/features/fund-valuation-requests.js';
import { CALLABLES, createGenerationGuard } from '../../src/features/fund-valuation-model.js';

const require = createRequire(import.meta.url);
const S = require('../../functions/fund-valuations.cjs');
const ACTION_OF = Object.fromEntries(Object.entries(CALLABLES).map(([a, c]) => [c, a]));

let passed = 0; let failed = 0;
const tests = []; const test = (name, fn) => tests.push([name, fn]);
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- fakes ---------------- */
function fbErr(code, reason) { const e = new Error(reason || code); e.code = 'functions/' + code; if (reason) e.details = { reason }; return e; }

function makeStorage({ failSet = false, failGet = false } = {}) {
  const m = new Map();
  const st = {
    m, failSet, failGet, onSet: null,
    getItem(k) { if (st.failGet) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (st.failSet) throw new Error('quota'); m.set(k, String(v)); if (st.onSet) st.onSet(k, v, m); },
    removeItem(k) { m.delete(k); },
    key(i) { return [...m.keys()][i] ?? null; },
    get length() { return m.size; },
  };
  return st;
}
/* Web Locks API semantics for { ifAvailable: true }: the grant decision is asynchronous and atomic per name. */
class FakeLocks {
  constructor() { this.held = new Set(); this.requests = 0; this.beforeGrant = null; }
  async request(name, opts, cb) {
    this.requests++;
    await Promise.resolve();
    if (this.beforeGrant) { const f = this.beforeGrant; this.beforeGrant = null; f(); }
    if (this.held.has(name)) { if (opts && opts.ifAvailable) return cb(null); throw new Error('queueing not modelled'); }
    this.held.add(name);
    try { return await cb({ name }); } finally { this.held.delete(name); }
  }
}

function makeServer() {
  const st = {
    roles: { 'rev@x.com': 'senior_ic', 'prep@x.com': 'fund_manager', 'rev2@x.com': 'senior_ic' },
    members: new Set(['rev@x.com', 'prep@x.com', 'rev2@x.com']),
    vals: { v1: { fundId: 'f1', valuationDate: '2026-10-11', state: 'reviewed', contributors: ['prep@x.com'], enteredBy: 'prep@x.com' } },
    replay: new Map(), effects: [], calls: [], dropReplyOnce: false, failBeforeOnce: null, hang: false, delay: 0, seq: 0,
  };
  async function handle(email, callable, payload) {
    st.calls.push({ callable, payload: JSON.parse(JSON.stringify(payload)) });
    if (st.hang) return new Promise(() => {});
    if (st.delay) await sleep(st.delay);
    if (st.failBeforeOnce) { const c = st.failBeforeOnce; st.failBeforeOnce = null; throw fbErr(c); }
    const action = ACTION_OF[callable];
    if (!email) throw fbErr('unauthenticated', 'AUTH_REQUIRED');                                  // 1 identity
    const role = () => (st.members.has(email) ? (st.roles[email] || 'analyst') : null);
    if (role() === null) throw fbErr('permission-denied', 'MEMBERSHIP_REQUIRED');                  // 2 early authorization
    if (!S.roleAllowed(action, role())) throw fbErr('permission-denied', 'ROLE_NOT_ALLOWED');
    const unknown = Object.keys(payload).filter((k) => !S.ALLOWED_KEYS[action].includes(k));       // 3 payload allow-list
    if (unknown.length || st.shapeRejectOnce) { st.shapeRejectOnce = false; throw fbErr('invalid-argument', 'PAYLOAD_UNKNOWN_FIELD'); }
    // 4 one transaction: authorization AGAIN (authoritative), then 5 the stored-result lookup, then the checks and the effect
    if (role() === null) throw fbErr('permission-denied', 'MEMBERSHIP_REQUIRED');
    if (!S.roleAllowed(action, role())) throw fbErr('permission-denied', 'ROLE_NOT_ALLOWED');
    const rk = S.replayKey(email, payload.requestId); const stored = st.replay.get(rk);
    if (stored) {
      if (stored.json !== JSON.stringify({ ...payload, requestId: undefined })) throw fbErr('already-exists', 'REQUEST_ID_REUSED');
      return { ...stored.result, replayed: true };
    }
    let result;
    const v = st.vals[payload.valuationId];
    if (action === 'approve' || action === 'reject' || action === 'review') {
      if (!v) throw fbErr('not-found', 'VALUATION_NOT_FOUND');
      if (v.contributors.includes(email)) throw fbErr('permission-denied', action === 'approve' ? 'CONTRIBUTOR_CANNOT_APPROVE' : 'CONTRIBUTOR_CANNOT_REVIEW');
      const from = action === 'approve' ? ['reviewed'] : action === 'review' ? ['submitted'] : ['submitted', 'reviewed', 'returned'];
      if (!from.includes(v.state)) throw fbErr('failed-precondition', 'INVALID_STATE');
      v.state = action === 'approve' ? 'approved' : action === 'review' ? 'reviewed' : 'rejected';
      result = { valuationId: payload.valuationId, state: v.state };
    } else if (action === 'createDraft') {
      if (Object.values(st.vals).some((x) => x.fundId === payload.fundId && x.valuationDate === payload.valuationDate && ['draft', 'returned', 'submitted', 'reviewed'].includes(x.state))) throw fbErr('already-exists', 'ACTIVE_DRAFT_EXISTS');
      const id = 'n' + (++st.seq); st.vals[id] = { fundId: payload.fundId, valuationDate: payload.valuationDate, state: 'draft', contributors: [email], enteredBy: email };
      result = { valuationId: id, state: 'draft' };
    } else if (action === 'suspend') {
      result = { fundId: payload.fundId, eligibility: 'SUSPENDED' };
    } else throw new Error('fake server: action not modelled ' + action);
    st.effects.push({ action, requestId: payload.requestId, email });
    st.replay.set(rk, { json: JSON.stringify({ ...payload, requestId: undefined }), result });     // the request record, written WITH the effect
    if (st.dropReplyOnce) { st.dropReplyOnce = false; throw fbErr('unavailable'); }                 // effect committed, reply lost
    return result;
  }
  return { st, handle };
}

/* one "tab" = one runner; tabs of one browser share storage + locks; users share the server */
function makeTab({ server, storage, locks, userBox, now, genId, guard, hashFn }) {
  let n = 0;
  return R.createRequestRunner({
    getUser: () => userBox.email, storage, locks, guard, hashFn,
    call: (callable, payload, id) => server.handle(id.user, callable, payload), // the identity the operation STARTED with
    now: now || (() => 1000), genId: genId || (() => 'req-' + String(++n).padStart(8, '0') + '-' + Math.random().toString(36).slice(2, 8)),
  });
}
const APPROVE = (id = 'v1') => ({ action: 'approve', fields: { valuationId: id, expectedContentHash: 'a'.repeat(64) }, scope: { fundId: 'f1', valuationDate: '2026-10-11' } });
const REJECT = (id = 'v1') => ({ action: 'reject', fields: { valuationId: id, reason: 'no' }, scope: { fundId: 'f1', valuationDate: '2026-10-11' } });
const REV = 'rev@x.com';
const fresh = (over = {}) => { const server = makeServer(); const storage = 'storage' in over ? over.storage : makeStorage(); const locks = 'locks' in over ? over.locks : new FakeLocks(); const userBox = { email: REV }; return { server, storage, locks, userBox, tab: makeTab({ server, storage, locks, userBox }) }; };
const scopeOf = (e = REV, f = 'f1', d = '2026-10-11') => R.scopeKey({ user: e, fundId: f, valuationDate: d });

/* ---------------- classification (every cell of contract §5.1) ---------------- */
test('1. classifyResult: first attempt', () => {
  const c = (code, ok = false) => R.classifyResult({ outcome: { ok, code }, attempt: 'first' });
  assert.equal(c(null, true), 'success');
  for (const x of ['invalid-argument', 'permission-denied', 'unauthenticated', 'not-found', 'failed-precondition', 'already-exists']) assert.equal(c(x), 'no_effect', x);
  for (const x of ['functions/failed-precondition', 'functions/permission-denied']) assert.equal(c(x), 'no_effect', 'prefix stripped ' + x);
  for (const x of ['unavailable', 'internal', 'deadline-exceeded', 'aborted', 'resource-exhausted', 'unknown', 'cancelled', 'data-loss', null, undefined, '', 'weird']) assert.equal(c(x), 'ambiguous', String(x));
});
test('1b. classifyResult: retry of an ambiguous request', () => {
  const c = (code, ok = false) => R.classifyResult({ outcome: { ok, code }, attempt: 'retry' });
  assert.equal(c(null, true), 'success');
  for (const x of ['permission-denied', 'unauthenticated', 'already-exists', 'functions/permission-denied']) assert.equal(c(x), 'unresolved', x);
  // invalid-argument is checked BEFORE the stored-result lookup, permission BEFORE it too: never "no effect" on the code alone
  for (const x of ['invalid-argument', 'functions/invalid-argument']) assert.equal(c(x), 'unresolved', x);
  // failed-precondition / not-found prove "no effect" only with a reason known to be raised after the lookup
  const cr = (code, reason) => R.classifyResult({ outcome: { ok: false, code, reason }, attempt: 'retry' });
  for (const r of R.NO_EFFECT_AFTER_LOOKUP_REASONS) assert.equal(cr('functions/failed-precondition', r), 'no_effect', r);
  assert.equal(cr('not-found', 'VALUATION_NOT_FOUND'), 'no_effect');
  for (const x of ['failed-precondition', 'not-found']) { assert.equal(cr(x, null), 'unresolved'); assert.equal(cr(x, undefined), 'unresolved'); assert.equal(cr(x, 'SOMETHING_NEW'), 'unresolved'); assert.equal(cr(x, 'PAYLOAD_UNKNOWN_FIELD'), 'unresolved'); }
  assert.equal(cr('invalid-argument', 'INVALID_STATE'), 'unresolved', 'the code decides first: an invalid-argument is never trusted');
  for (const x of ['unavailable', 'internal', 'deadline-exceeded', 'aborted', 'resource-exhausted', 'unknown', null, undefined]) assert.equal(c(x), 'ambiguous', String(x));
});

/* ---------------- THE scenario: unknown success, then the permission is revoked ---------------- */
test('2. unknown success, then permission revoked: request stays UNRESOLVED, no replacement, one effect', async () => {
  const { server, storage, tab } = fresh(); const s = server.st;
  s.dropReplyOnce = true;
  const first = await tab.begin(APPROVE());
  assert.equal(first.status, 'ambiguous'); assert.equal(s.effects.length, 1, 'the approval DID take effect');
  const sc = scopeOf(); const entry0 = tab.get(sc); const rid = entry0.requestId; const payload0 = JSON.stringify(entry0.payload);
  assert.equal(entry0.status, 'ambiguous');

  s.roles[REV] = 'analyst'; // the user's permission is revoked after the reply was lost
  const r1 = await tab.retry(sc);
  assert.equal(r1.status, 'unresolved'); assert.equal(r1.code, 'UNRESOLVED_PERMISSION');
  assert.equal(s.effects.length, 1, 'still exactly one effect');
  const e1 = tab.get(sc);
  assert.ok(e1, 'the request must NOT be erased by the permission refusal');
  assert.equal(e1.status, 'unresolved'); assert.equal(e1.requestId, rid); assert.equal(JSON.stringify(e1.payload), payload0);
  assert.equal(e1.lastOutcome.reason, 'ROLE_NOT_ALLOWED');

  // nothing replaces it, automatically or by a new action of the same scope (any action)
  const callsBefore = s.calls.length;
  const b1 = await tab.begin(APPROVE()); const b2 = await tab.begin(REJECT());
  assert.deepEqual([b1.status, b1.code, b2.status, b2.code], ['blocked', 'PENDING_EXISTS', 'blocked', 'PENDING_EXISTS']);
  assert.equal(s.calls.length, callsBefore, 'blocked actions send nothing');
  assert.equal(tab.pending().length, 1);

  // retry again while still revoked: still unresolved (not "failed"), attempts counted
  const r2 = await tab.retry(sc); assert.equal(r2.status, 'unresolved'); assert.equal(tab.get(sc).attempts, 3);

  // permission restored -> the SAME request returns the stored result: success, replayed, still ONE effect
  s.roles[REV] = 'senior_ic';
  const r3 = await tab.retry(sc);
  assert.equal(r3.status, 'success'); assert.equal(r3.replayed, true); assert.equal(s.effects.length, 1);
  assert.equal(tab.get(sc), null); assert.equal(tab.pending().length, 0);
  assert.equal(s.calls.filter((c) => c.payload.requestId === rid).length, 4); // first + 3 retries, all the same id
  assert.equal(storage.m.size, 0);
});

test('2b. same scenario, user discards while permission stays revoked: no server call, entry gone, nothing replaced', async () => {
  const { server, tab } = fresh(); const s = server.st;
  s.dropReplyOnce = true; await tab.begin(APPROVE()); s.roles[REV] = 'analyst';
  const sc = scopeOf(); assert.equal((await tab.retry(sc)).status, 'unresolved');
  const calls = s.calls.length;
  assert.deepEqual((await tab.discard(sc)).code, 'ACK_REQUIRED'); assert.ok(tab.get(sc));
  assert.deepEqual((await tab.discard(sc, { acknowledgeRisk: false })).code, 'ACK_REQUIRED'); assert.ok(tab.get(sc));
  assert.equal((await tab.discard(sc, { acknowledgeRisk: true })).status, 'discarded');
  assert.equal(tab.get(sc), null); assert.equal(s.calls.length, calls); assert.equal(s.effects.length, 1);
});

test('2c. a permission refusal of the FIRST attempt is definitive (no_effect): entry removed', async () => {
  const { server, tab } = fresh(); const s = server.st; s.roles[REV] = 'analyst';
  const r = await tab.begin(APPROVE());
  assert.equal(r.status, 'no_effect'); assert.equal(r.error.reason, 'ROLE_NOT_ALLOWED'); assert.equal(tab.get(scopeOf()), null); assert.equal(s.effects.length, 0);
});

test('2d. retry whose answer proves "no effect": INVALID_STATE after authorization (first attempt never executed)', async () => {
  const { server, tab } = fresh(); const s = server.st;
  s.failBeforeOnce = 'unavailable'; assert.equal((await tab.begin(APPROVE())).status, 'ambiguous'); assert.equal(s.effects.length, 0);
  s.vals.v1.state = 'returned'; // someone else changed it meanwhile
  const r = await tab.retry(scopeOf());
  assert.equal(r.status, 'no_effect'); assert.equal(r.error.reason, 'INVALID_STATE'); assert.equal(tab.get(scopeOf()), null); assert.equal(s.effects.length, 0);
});

test('2e. retry succeeds normally when the first attempt never executed (fresh effect, not replayed)', async () => {
  const { server, tab } = fresh(); const s = server.st;
  s.failBeforeOnce = 'deadline-exceeded'; await tab.begin(APPROVE());
  const r = await tab.retry(scopeOf());
  assert.deepEqual([r.status, r.replayed], ['success', false]); assert.equal(s.effects.length, 1);
});

test('2f. retry stays ambiguous on a network error; REQUEST_ID_REUSED stays unresolved (never silently dropped)', async () => {
  const { server, tab } = fresh(); const s = server.st;
  s.dropReplyOnce = true; await tab.begin(APPROVE()); const sc = scopeOf();
  s.failBeforeOnce = 'unavailable'; assert.equal((await tab.retry(sc)).status, 'ambiguous'); assert.equal(tab.get(sc).status, 'ambiguous');
  s.replay.clear(); const k = S.replayKey(REV, tab.get(sc).requestId); s.replay.set(k, { json: '{"other":1}', result: {} });
  const r = await tab.retry(sc); assert.equal(r.status, 'unresolved'); assert.equal(r.error.reason, 'REQUEST_ID_REUSED'); assert.ok(tab.get(sc));
});

/* ---------------- tab contention ---------------- */
test('3. two tabs start the action at the SAME instant (same user, fund, date): exactly one request is sent', async () => {
  const server = makeServer(); const storage = makeStorage(); const locks = new FakeLocks(); const userBox = { email: REV };
  server.st.delay = 15;
  const A = makeTab({ server, storage, locks, userBox }); const B = makeTab({ server, storage, locks, userBox });
  const [ra, rb] = await Promise.all([A.begin(APPROVE()), B.begin(APPROVE())]);
  const results = [ra, rb].map((r) => r.status + ':' + (r.code || ''));
  assert.equal(server.st.calls.length, 1, 'only one request reached the server: ' + results);
  assert.equal(server.st.effects.length, 1);
  assert.deepEqual([ra.status, rb.status].sort(), ['blocked', 'success']);
  assert.ok(['LOCKED_OTHER_TAB', 'PENDING_EXISTS'].includes((ra.status === 'blocked' ? ra : rb).code));
});
test('3b. same instant with DIFFERENT actions in the same scope (approve vs reject): one wins, the other sends nothing', async () => {
  const server = makeServer(); const storage = makeStorage(); const locks = new FakeLocks(); const userBox = { email: REV };
  server.st.delay = 15; const A = makeTab({ server, storage, locks, userBox }); const B = makeTab({ server, storage, locks, userBox });
  const [ra, rb] = await Promise.all([A.begin(APPROVE()), B.begin(REJECT())]);
  assert.equal(server.st.calls.length, 1); assert.deepEqual([ra.status, rb.status].sort(), ['blocked', 'success']);
});
test('3c. different scopes do not block each other (other date / other fund / other user)', async () => {
  const server = makeServer(); const storage = makeStorage(); const locks = new FakeLocks(); const userBox = { email: REV };
  server.st.vals.v2 = { fundId: 'f1', valuationDate: '2026-10-10', state: 'reviewed', contributors: ['prep@x.com'], enteredBy: 'prep@x.com' };
  server.st.vals.v3 = { fundId: 'f2', valuationDate: '2026-10-11', state: 'reviewed', contributors: ['prep@x.com'], enteredBy: 'prep@x.com' };
  server.st.delay = 15; const A = makeTab({ server, storage, locks, userBox }); const B = makeTab({ server, storage, locks, userBox }); const C = makeTab({ server, storage, locks, userBox });
  const rs = await Promise.all([A.begin(APPROVE('v1')), B.begin({ ...APPROVE('v2'), scope: { fundId: 'f1', valuationDate: '2026-10-10' } }), C.begin({ ...APPROVE('v3'), scope: { fundId: 'f2', valuationDate: '2026-10-11' } })]);
  assert.deepEqual(rs.map((r) => r.status), ['success', 'success', 'success']); assert.equal(server.st.effects.length, 3);
  // another user in the same browser, same fund/date: different scope
  const other = { email: 'rev2@x.com' }; const D = makeTab({ server, storage, locks, userBox: other });
  server.st.vals.v1.state = 'submitted'; // so rev2 can review it
  const [x, y] = await Promise.all([D.begin({ action: 'review', fields: { valuationId: 'v1', expectedContentHash: 'a'.repeat(64) }, scope: { fundId: 'f1', valuationDate: '2026-10-11' } }), A.begin(REJECT('v1'))]);
  assert.equal(server.st.calls.length >= 5, true); assert.equal(x.status === 'blocked' && y.status === 'blocked', false);
});
test('3d. the lock is held ACROSS the call and released after; a throwing call also releases it', async () => {
  const { server, tab, locks } = fresh(); server.st.delay = 20;
  const p = tab.begin(APPROVE()); await tick(); assert.equal(locks.held.size, 1, 'lock held during the call');
  const mid = await tab.begin(APPROVE()); assert.deepEqual([mid.status, mid.code], ['blocked', 'LOCKED_OTHER_TAB']);
  await p; assert.equal(locks.held.size, 0);
  const f = fresh(); f.server.st.vals.v1.state = 'reviewed'; const t2 = R.createRequestRunner({ getUser: () => REV, storage: f.storage, locks: f.locks, call: async () => { throw undefined; }, now: () => 1 });
  const r = await t2.begin(APPROVE()); assert.equal(r.status, 'ambiguous'); assert.equal(f.locks.held.size, 0);
});
test('3e. the `storage` event only refreshes the banner: it never lets a second request through', async () => {
  const { server, storage, tab } = fresh(); server.st.dropReplyOnce = true; await tab.begin(APPROVE());
  let n = 0; tab.subscribe(() => n++); tab.refresh(); assert.equal(n, 1);
  const other = makeTab({ server, storage, locks: new FakeLocks(), userBox: { email: REV } }); // a tab that never saw the first (its own locks)
  assert.equal(other.pending().length, 1);
  const r = await other.begin(REJECT()); assert.deepEqual([r.status, r.code], ['blocked', 'PENDING_EXISTS']);
  assert.equal(server.st.calls.length, 1);
});

/* ---------------- weak mode (no Web Locks) ---------------- */
test('4. no reliable lock (no Web Locks): NO modifying request is sent, viewing continues, no guarantee is claimed', async () => {
  const server = makeServer(); const storage = makeStorage(); const userBox = { email: REV };
  const A = makeTab({ server, storage, locks: undefined, userBox }); const B = makeTab({ server, storage, locks: undefined, userBox });
  assert.equal(A.lockMode, 'weak'); assert.deepEqual(A.mutationGate(), { allowed: false, reasons: ['NO_RELIABLE_LOCK'] });
  const [ra, rb] = await Promise.all([A.begin(APPROVE()), B.begin(APPROVE())]);
  assert.deepEqual([ra.status, ra.code, rb.status, rb.code], ['blocked', 'NO_RELIABLE_LOCK', 'blocked', 'NO_RELIABLE_LOCK']);
  assert.equal(server.st.calls.length, 0, 'nothing sent'); assert.equal(storage.m.size, 0, 'nothing stored');
  // an entry that already exists stays visible; retry is refused too (it also sends); discard needs no server call
  storage.m.set(R.STORE_PREFIX + encodeURIComponent(scopeOf()), JSON.stringify({ v: 1, scope: scopeOf(), requestId: 'req-weak-0001', action: 'approve', callable: 'approveValuation', payload: { requestId: 'req-weak-0001', valuationId: 'v1', expectedContentHash: 'a'.repeat(64) }, signature: 'x', sentAt: 1, status: 'ambiguous', attempts: 1, lastOutcome: null }));
  assert.equal(A.pending().length, 1); assert.equal((await A.retry(scopeOf())).code, 'NO_RELIABLE_LOCK'); assert.equal(server.st.calls.length, 0);
  assert.equal(fresh().tab.lockMode, 'web'); assert.equal(fresh().tab.mutationGate().allowed, true);
  const snap = JSON.stringify([...storage.m]);
  const d = await A.discard(scopeOf(), { acknowledgeRisk: true }); assert.deepEqual([d.status, d.code], ['blocked', 'NO_RELIABLE_LOCK']);
  assert.deepEqual(await A.recoverInflight(), []); assert.equal(JSON.stringify([...storage.m]), snap, 'the record is neither deleted nor rewritten without the reliable lock');
});
test('4b. weak lease: overwritten by another tab before the re-read -> not acquired; expired lease -> acquirable', async () => {
  const storage = makeStorage(); let t = 1000;
  const L1 = R.createScopeLocks({ locks: undefined, storage, now: () => t, leaseTtlMs: 5000 });
  storage.onSet = (k, v, m) => { if (k.startsWith(R.LEASE_PREFIX)) { m.set(k, JSON.stringify({ token: 'someone-else', expires: t + 5000 })); storage.onSet = null; } };
  let ran = false; const r = await L1.run('S', async () => { ran = true; });
  assert.deepEqual([r.locked, ran], [false, false]);
  storage.m.set(R.LEASE_PREFIX + encodeURIComponent('S'), JSON.stringify({ token: 'old', expires: 2000 }));
  t = 1500; assert.equal((await L1.run('S', async () => 1)).locked, false, 'live lease blocks');
  t = 2500; const ok = await L1.run('S', async () => 7); assert.deepEqual([ok.locked, ok.value], [true, 7]);
  assert.equal(L1.mode, 'weak');
});

/* ---------------- persistence ---------------- */
test('5. written BEFORE sending; survives a reload; retry is verbatim (same requestId and payload)', async () => {
  const server = makeServer(); const storage = makeStorage(); const locks = new FakeLocks(); const userBox = { email: REV };
  let seen;
  const tab = R.createRequestRunner({ getUser: () => REV, storage, locks, genId: () => 'req-verbatim-0001', now: () => 5, call: async (c, p) => { const raw = storage.getItem(R.STORE_PREFIX + encodeURIComponent(scopeOf())); assert.ok(raw, 'entry must be stored BEFORE the request is sent'); seen = JSON.parse(raw); return server.handle(REV, c, p); } });
  server.st.dropReplyOnce = true; await tab.begin(APPROVE());
  assert.ok(seen, 'the call hook saw a stored entry before sending');
  assert.equal(seen.status, 'inflight', 'entry existed (inflight) before the request left'); assert.equal(seen.requestId, 'req-verbatim-0001'); assert.equal(seen.payload.valuationId, 'v1');
  // reload = a new runner on the same storage and a NEW lock manager (the old page's locks died with it)
  const reloaded = makeTab({ server, storage, locks: new FakeLocks(), userBox });
  assert.equal(reloaded.pending().length, 1); assert.equal(reloaded.pending()[0].status, 'ambiguous');
  const before = server.st.calls[0].payload;
  const r = await reloaded.retry(scopeOf());
  assert.equal(r.status, 'success'); assert.equal(r.replayed, true);
  assert.deepEqual(server.st.calls[1].payload, before); assert.equal(server.st.effects.length, 1);
});
test('5b. inflight left by a closed tab becomes ambiguous; inflight of a LIVE tab is left alone', async () => {
  const server = makeServer(); const storage = makeStorage(); const locks = new FakeLocks(); const userBox = { email: REV };
  server.st.hang = true; const live = makeTab({ server, storage, locks, userBox }); live.begin(APPROVE()); await tick(); await tick();
  assert.equal(live.pending()[0].status, 'inflight');
  assert.deepEqual(await live.recoverInflight(), [], 'its own lock is held: not touched');
  const sameBrowser = makeTab({ server, storage, locks, userBox }); assert.deepEqual(await sameBrowser.recoverInflight(), []); assert.equal(sameBrowser.pending()[0].status, 'inflight');
  const afterClose = makeTab({ server, storage, locks: new FakeLocks(), userBox }); // tab closed -> its lock is gone
  assert.deepEqual(await afterClose.recoverInflight(), [scopeOf()]); assert.equal(afterClose.pending()[0].status, 'ambiguous'); assert.equal(afterClose.pending()[0].lastOutcome.code, 'RECOVERED_INFLIGHT');
});
test('5c. storage not usable for coordination: modifying actions are refused (no silent in-memory store); viewing is unaffected', async () => {
  const cases = { 'setItem fails': makeStorage({ failSet: true }), 'getItem fails': makeStorage({ failGet: true }), 'no storage': null };
  for (const [name, st] of Object.entries(cases)) {
    const f = fresh({ storage: st });
    assert.equal(f.tab.storageOk, false, name); assert.deepEqual(f.tab.mutationGate(), { allowed: false, reasons: ['STORAGE_UNAVAILABLE'] }, name);
    const r = await f.tab.begin(APPROVE()); assert.deepEqual([r.status, r.code], ['blocked', 'STORAGE_UNAVAILABLE'], name);
    assert.equal(f.server.st.calls.length, 0, name); assert.equal(f.server.st.effects.length, 0, name);
    assert.deepEqual(f.tab.pending(), [], name); // viewing still works (empty here, no throw)
  }
  assert.equal(fresh().tab.storageOk, true);
  // corrupt value: blocks the scope, cannot be retried, can be discarded with acknowledgement
  const d = fresh(); d.storage.m.set(R.STORE_PREFIX + encodeURIComponent(scopeOf()), '{not json');
  assert.equal(d.tab.pending().length, 1); assert.equal(d.tab.pending()[0].corrupt, true); assert.equal(d.tab.corruptKeys >= 1, true);
  assert.equal((await d.tab.begin(APPROVE())).code, 'PENDING_EXISTS'); assert.equal((await d.tab.retry(scopeOf())).code, 'PENDING_CORRUPT');
  assert.equal(d.server.st.calls.length, 0);
  assert.equal((await d.tab.discard(scopeOf(), { acknowledgeRisk: true })).status, 'discarded'); assert.equal(d.tab.pending().length, 0);
  const e = fresh(); e.storage.m.set(R.STORE_PREFIX + encodeURIComponent(scopeOf()), JSON.stringify({ v: 1, scope: scopeOf() })); assert.equal(e.tab.pending()[0].corrupt, true);
});
test('5c2. a pending request exists but its record cannot be READ: no replacement request (the unknown is not "none")', async () => {
  const f = fresh(); f.server.st.dropReplyOnce = true; assert.equal((await f.tab.begin(APPROVE())).status, 'ambiguous');
  const sent = f.server.st.calls.length; const prefixOnly = (k) => k.startsWith(R.STORE_PREFIX);
  const realGet = f.storage.getItem.bind(f.storage);
  f.storage.getItem = (k) => { if (prefixOnly(k)) throw new Error('read blocked'); return realGet(k); }; // probe still passes: only the record is unreadable
  assert.equal(f.tab.mutationGate().allowed, true);
  for (const req of [APPROVE(), REJECT()]) { const r = await f.tab.begin(req); assert.deepEqual([r.status, r.code], ['blocked', 'STORAGE_UNREADABLE']); }
  assert.equal((await f.tab.retry(scopeOf())).code, 'STORAGE_UNREADABLE');
  assert.equal(f.tab.isBlocked({ fundId: 'f1', valuationDate: '2026-10-11' }), true, 'unknown is treated as blocked');
  assert.equal(f.server.st.calls.length, sent, 'no new request'); assert.equal(f.server.st.effects.length, 1);
  f.storage.getItem = realGet; // readable again: the original request is still there, unchanged
  assert.equal(f.tab.get(scopeOf()).status, 'ambiguous'); assert.equal((await f.tab.begin(APPROVE())).code, 'PENDING_EXISTS');
  // a scope with nothing stored is "none", not "unknown"
  assert.equal(f.tab.isBlocked({ fundId: 'f1', valuationDate: '2026-10-12' }), false);
});
test('5c3. the request cannot be saved (write or read-back fails) before sending: nothing is sent and the block is explicit', async () => {
  for (const mode of ['throws', 'silent-drop']) {
    const f = fresh(); const realSet = f.storage.setItem.bind(f.storage);
    f.storage.setItem = (k, v) => { if (k.startsWith(R.STORE_PREFIX)) { if (mode === 'throws') throw new Error('quota'); return; } realSet(k, v); }; // probe passes
    assert.equal(f.tab.mutationGate().allowed, true, mode);
    const r = await f.tab.begin(APPROVE()); assert.deepEqual([r.status, r.code], ['blocked', 'STORAGE_WRITE_FAILED'], mode);
    assert.equal(f.server.st.calls.length, 0, mode); assert.equal(f.tab.get(scopeOf()), null, mode);
  }
  // persisting the RESULT after a send fails: the newest state is kept tab-locally and flagged; the stored inflight record still blocks
  const g = fresh(); g.server.st.dropReplyOnce = true; const realSet = g.storage.setItem.bind(g.storage); let n = 0;
  g.storage.setItem = (k, v) => { if (k.startsWith(R.STORE_PREFIX) && ++n >= 2) throw new Error('quota'); realSet(k, v); };
  const r = await g.tab.begin(APPROVE()); assert.equal(r.status, 'ambiguous'); assert.equal(g.tab.localFallback, true);
  assert.equal((await g.tab.begin(REJECT())).code, 'PENDING_EXISTS'); assert.equal(g.server.st.calls.length, 1);
});
test('5c4. discard reports success only if the record is really gone', async () => {
  const f = fresh(); f.server.st.dropReplyOnce = true; await f.tab.begin(APPROVE());
  const realRemove = f.storage.removeItem.bind(f.storage); f.storage.removeItem = (k) => { if (k.startsWith(R.STORE_PREFIX)) return; realRemove(k); }; // silently keeps it
  const r = await f.tab.discard(scopeOf(), { acknowledgeRisk: true }); assert.deepEqual([r.status, r.code], ['blocked', 'STORAGE_WRITE_FAILED']);
  assert.ok(f.tab.get(scopeOf()));
});
/* ---------------- regression: payload is an immutable copy of the user's intent ---------------- */
import { documentHashHex } from '../../src/domain/validation/document-hash.js';
test('10. nested inputs changed WHILE HASHING: signed = stored = sent = retried (deep copy taken before the first wait)', async () => {
  const f = fresh(); f.server.st.roles[REV] = 'admin'; f.server.st.dropReplyOnce = true;
  const content = { method: 'appraisal', components: [{ k: 1 }], nested: { deep: { x: 1 } } };
  const fields = { fundId: 'f9', valuationDate: '2026-10-11', content };
  const hashFn = async (doc) => { content.method = 'cost_basis'; content.components[0].k = 99; content.nested.deep.x = 2; fields.content = { method: 'other' }; return documentHashHex(doc); };
  const tab = makeTab({ server: f.server, storage: f.storage, locks: f.locks, userBox: f.userBox, hashFn });
  const r = await tab.begin({ action: 'createDraft', fields, scope: { fundId: 'f9', valuationDate: '2026-10-11' } });
  assert.equal(r.status, 'ambiguous');
  const sent = f.server.st.calls[0].payload;
  assert.deepEqual(sent.content, { method: 'appraisal', components: [{ k: 1 }], nested: { deep: { x: 1 } } }, 'what was sent is what the user intended');
  const sc = scopeOf(REV, 'f9'); const stored = JSON.parse(f.storage.m.get(R.STORE_PREFIX + encodeURIComponent(sc)));
  assert.deepEqual(stored.payload, sent, 'stored = sent');
  assert.equal(stored.signature, await documentHashHex({ scope: stored.scope, action: stored.action, callable: stored.callable, payload: stored.payload }), 'signature covers the stored payload');
  const rr = await tab.retry(sc); assert.deepEqual([rr.status, rr.replayed], ['success', true], 'the retry is not rejected for a signature mismatch');
  assert.deepEqual(f.server.st.calls[1].payload, sent, 'retry is verbatim');
});
test('10b. values handed out (begin result, pending, get) and the payload given to call cannot alter the internal copy', async () => {
  const f = fresh(); f.server.st.roles[REV] = 'admin';
  let mutateInCall = true; let calls = 0; f.server.st.dropReplyOnce = true;
  const tab = R.createRequestRunner({ getUser: () => REV, storage: f.storage, locks: f.locks, genId: () => 'req-copy-00001', now: () => 1, call: async (c, p, id) => {
    calls++;
    try { return await f.server.handle(id.user, c, JSON.parse(JSON.stringify(p))); }
    finally { if (mutateInCall) { p.content.method = 'MUTATED-BY-CALL'; p.fundId = 'zzz'; mutateInCall = false; } } } }); // the callee scribbles on its argument afterwards
  const req = { action: 'createDraft', fields: { fundId: 'f9', valuationDate: '2026-10-11', content: { method: 'appraisal' } }, scope: { fundId: 'f9', valuationDate: '2026-10-11' } };
  const r = await tab.begin(req); assert.equal(r.status, 'ambiguous'); const sc = scopeOf(REV, 'f9');
  const stored = () => JSON.parse(f.storage.m.get(R.STORE_PREFIX + encodeURIComponent(sc))).payload;
  assert.equal(stored().content.method, 'appraisal'); assert.equal(stored().fundId, 'f9');
  r.entry.payload.content.method = 'M1'; tab.pending()[0].payload.content.method = 'M2'; tab.get(sc).payload.content.method = 'M3';
  assert.equal(tab.get(sc).payload.content.method, 'appraisal'); assert.equal(tab.pending()[0].payload.content.method, 'appraisal');
  const rr = await tab.retry(sc); assert.equal(rr.status, 'success'); assert.equal(f.server.st.calls[1].payload.content.method, 'appraisal');
  assert.equal(calls, 2);
  // tab-local fallback copy (storage failed AFTER the send) is isolated as well
  const g = fresh(); g.server.st.roles[REV] = 'admin'; g.server.st.dropReplyOnce = true; const realSet = g.storage.setItem.bind(g.storage); let n = 0;
  g.storage.setItem = (k, v) => { if (k.startsWith(R.STORE_PREFIX) && ++n >= 2) throw new Error('quota'); realSet(k, v); };
  await g.tab.begin(req); assert.equal(g.tab.localFallback, true);
  g.tab.pending()[0].payload.content.method = 'X'; g.tab.get(sc).payload.content.method = 'Y'; assert.equal(g.tab.get(sc).payload.content.method, 'appraisal');
});

/* ---------------- regression: EVERY change to the request record needs the reliable lock ---------------- */
test('11. a Web Lock is held by a sending tab: discard / recover from a weak-lock runner or another tab leave the record untouched', async () => {
  const server = makeServer(); const storage = makeStorage(); const locks = new FakeLocks(); const userBox = { email: REV }; server.st.delay = 40;
  const A = makeTab({ server, storage, locks, userBox }); const p = A.begin(APPROVE()); await sleep(10);
  const key = R.STORE_PREFIX + encodeURIComponent(scopeOf()); const before = storage.m.get(key); assert.equal(JSON.parse(before).status, 'inflight');
  const B = makeTab({ server, storage, locks: undefined, userBox }); // no Web Locks here: only the weak lease exists
  const d = await B.discard(scopeOf(), { acknowledgeRisk: true }); assert.deepEqual([d.status, d.code], ['blocked', 'NO_RELIABLE_LOCK']);
  assert.deepEqual(await B.recoverInflight(), []); assert.equal(storage.m.get(key), before, 'weak runner: record unchanged');
  assert.equal(B.pending().length, 1, 'reading continues');
  const C = makeTab({ server, storage, locks, userBox }); // same Web Locks manager = another tab of the same browser
  const d2 = await C.discard(scopeOf(), { acknowledgeRisk: true }); assert.deepEqual([d2.status, d2.code], ['blocked', 'LOCKED_OTHER_TAB']);
  assert.deepEqual(await C.recoverInflight(), []); assert.equal(storage.m.get(key), before, 'other tab: record unchanged');
  const r = await p; assert.equal(r.status, 'success'); assert.equal(server.st.effects.length, 1); assert.equal(storage.m.size, 0);
});
test('11b. without the reliable lock nothing rewrites a stale inflight record and nothing deletes an ambiguous one', async () => {
  const f = fresh(); f.server.st.dropReplyOnce = true; await f.tab.begin(APPROVE()); const key = R.STORE_PREFIX + encodeURIComponent(scopeOf());
  const amb = f.storage.m.get(key); const inflight = JSON.stringify({ ...JSON.parse(amb), status: 'inflight' }); f.storage.m.set(key, inflight);
  const W = makeTab({ server: f.server, storage: f.storage, locks: undefined, userBox: f.userBox });
  assert.deepEqual(await W.recoverInflight(), []); assert.equal(f.storage.m.get(key), inflight);
  assert.equal((await W.discard(scopeOf(), { acknowledgeRisk: true })).code, 'NO_RELIABLE_LOCK'); assert.equal(f.storage.m.get(key), inflight);
  // when the reliable environment returns, the original request is retried (the discard was not forced)
  const back = makeTab({ server: f.server, storage: f.storage, locks: new FakeLocks(), userBox: f.userBox });
  assert.deepEqual(await back.recoverInflight(), [scopeOf()]); const r = await back.retry(scopeOf()); assert.deepEqual([r.status, r.replayed], ['success', true]); assert.equal(f.server.st.effects.length, 1);
});

test('5d. tampering: a stored request that no longer matches its signature is never sent', async () => {
  for (const mutate of [(e) => { e.payload.reason = 'x'; }, (e) => { e.payload.valuationId = 'v9'; }, (e) => { e.requestId = 'req-other-0001'; e.payload.requestId = 'req-other-0001'; }, (e) => { e.action = 'approve'; }, (e) => { e.callable = 'approveValuation'; }]) {
    const { server, storage, tab } = fresh(); server.st.dropReplyOnce = true; await tab.begin(REJECT());
    const k = R.STORE_PREFIX + encodeURIComponent(scopeOf()); const e = JSON.parse(storage.m.get(k)); mutate(e); storage.m.set(k, JSON.stringify(e));
    const n = server.st.calls.length; const r = await tab.retry(scopeOf());
    assert.deepEqual([r.status, r.code], ['blocked', 'SIGNATURE_MISMATCH']); assert.equal(server.st.calls.length, n); assert.ok(tab.get(scopeOf()));
  }
});
test('5e. another user on the same device cannot see, retry or discard my pending request', async () => {
  const { server, storage, locks, userBox, tab } = fresh(); server.st.dropReplyOnce = true; await tab.begin(APPROVE());
  userBox.email = 'rev2@x.com'; assert.equal(tab.pending().length, 0); assert.equal(tab.isBlocked({ fundId: 'f1', valuationDate: '2026-10-11' }), false);
  const sc = scopeOf(REV); assert.equal((await tab.retry(sc)).code, 'NO_SESSION'); assert.equal((await tab.discard(sc, { acknowledgeRisk: true })).code, 'NO_SESSION');
  assert.ok(storage.m.size === 1); assert.equal(server.st.calls.length, 1);
  userBox.email = null; assert.equal((await tab.begin(APPROVE())).code, 'NO_SESSION');
  userBox.email = REV; assert.equal(tab.pending().length, 1); assert.equal(tab.isBlocked({ fundId: 'f1', valuationDate: '2026-10-11' }), true);
  void locks;
});

/* ---------------- begin() input handling ---------------- */
test('6. begin refuses bad input without storing or sending', async () => {
  const { server, storage, tab } = fresh();
  const bad = async (req, code) => { const r = await tab.begin(req); assert.equal(r.code, code, JSON.stringify(req)); assert.equal(storage.m.size, 0); assert.equal(server.st.calls.length, 0); };
  await bad({ ...APPROVE(), fields: { valuationId: 'v1', expectedContentHash: 'a'.repeat(64), viewFingerprint: 'x' } }, 'PAYLOAD_UNKNOWN_FIELD');
  await bad({ ...APPROVE(), fields: { valuationId: 'v1' } }, 'PAYLOAD_MISSING');
  await bad({ action: 'preview', fields: { valuationId: 'v1' }, scope: { fundId: 'f1', valuationDate: '2026-10-11' } }, 'PREVIEW_NOT_QUEUED');
  await bad({ ...APPROVE(), scope: null }, 'SCOPE_MISMATCH');
  await bad({ action: 'suspend', fields: { fundId: 'f1', valuationDate: '2026-10-11', expectedHeadId: 'v0', reason: 'r' }, scope: { fundId: 'f2', valuationDate: '2026-10-11' } }, 'SCOPE_MISMATCH');
  await bad({ action: 'createDraft', fields: { fundId: 'f1', valuationDate: '2026-10-10', content: { residualValue: 1 } }, scope: { fundId: 'f1', valuationDate: '2026-10-11' } }, 'SCOPE_MISMATCH');
});
test('6b. each begin uses a fresh valid requestId; success clears the entry; first-attempt "no effect" clears it', async () => {
  const { server, tab, storage } = fresh({}); const ids = new Set();
  const t = R.createRequestRunner({ getUser: () => REV, storage, locks: new FakeLocks(), call: (c, p) => { ids.add(p.requestId); return server.handle(REV, c, p); } });
  server.st.vals.v2 = { fundId: 'f1', valuationDate: '2026-10-11', state: 'reviewed', contributors: [], enteredBy: 'x' };
  assert.equal((await t.begin(APPROVE('v1'))).status, 'success'); assert.equal((await t.begin(APPROVE('v1'))).status, 'no_effect'); assert.equal((await t.begin(APPROVE('v2'))).status, 'success');
  assert.equal(ids.size, 3); for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{8,64}$/);
  assert.equal(storage.m.size, 0); void tab;
  for (let i = 0; i < 20; i++) assert.match(R.defaultGenId(), /^[A-Za-z0-9_-]{8,64}$/);
  assert.notEqual(R.defaultGenId(), R.defaultGenId());
});
test('6c. createDraft / suspend scopes come from the payload; a lost-reply createDraft blocks a second create', async () => {
  const { server, tab } = fresh({}); server.st.roles[REV] = 'admin'; server.st.dropReplyOnce = true;
  const c = { action: 'createDraft', fields: { fundId: 'f9', valuationDate: '2026-10-11', content: { residualValue: 10 } }, scope: { fundId: 'f9', valuationDate: '2026-10-11' } };
  assert.equal((await tab.begin(c)).status, 'ambiguous'); assert.equal(Object.values(server.st.vals).filter((v) => v.fundId === 'f9').length, 1);
  assert.equal((await tab.begin(c)).code, 'PENDING_EXISTS'); assert.equal(Object.values(server.st.vals).filter((v) => v.fundId === 'f9').length, 1, 'no duplicate draft');
  const r = await tab.retry(scopeOf(REV, 'f9')); assert.deepEqual([r.status, r.replayed], ['success', true]);
});
test('6d. helpers: scopeKey is unambiguous and case-insensitive on the user; scopeLabel is readable', () => {
  assert.equal(R.scopeKey({ user: 'A@X.com', fundId: 'f', valuationDate: 'd' }), R.scopeKey({ user: 'a@x.com', fundId: 'f', valuationDate: 'd' }));
  assert.notEqual(R.scopeKey({ user: 'a', fundId: 'b__c', valuationDate: 'd' }), R.scopeKey({ user: 'a', fundId: 'b', valuationDate: 'c__d' }));
  assert.equal(R.scopeLabel(R.scopeKey({ user: 'a@x.com', fundId: 'f1', valuationDate: '2026-10-11' })), 'a@x.com::f1::2026-10-11');
  assert.deepEqual(R.scopeOfValuation({ fundId: 'f', valuationDate: 'd', valuationId: 'v' }), { fundId: 'f', valuationDate: 'd' });
});

/* ---------------- session / identity bound to the operation ---------------- */
test('7. the session changes WHILE WAITING FOR THE LOCK: nothing is sent, nothing stored', async () => {
  const f = fresh(); f.locks.beforeGrant = () => { f.userBox.email = 'rev2@x.com'; };
  const r = await f.tab.begin(APPROVE()); assert.deepEqual([r.status, r.code], ['aborted', 'SESSION_CHANGED']);
  assert.equal(f.server.st.calls.length, 0); assert.equal(f.storage.m.size, 0); assert.equal(f.locks.held.size, 0);
  // same user but a new session generation (logout + login, lost role) is also a change
  const guard = createGenerationGuard(); const g = fresh(); const tab = makeTab({ server: g.server, storage: g.storage, locks: g.locks, userBox: g.userBox, guard });
  g.locks.beforeGrant = () => guard.bump();
  assert.equal((await tab.begin(APPROVE())).status, 'aborted'); assert.equal(g.server.st.calls.length, 0); assert.equal(g.storage.m.size, 0);
});
test('7b. the session changes WHILE HASHING: nothing is sent, nothing stored (begin and retry)', async () => {
  const f = fresh(); const slow = async (doc) => { await sleep(10); f.userBox.email = 'rev2@x.com'; return 'h' + JSON.stringify(doc).length; };
  const tab = makeTab({ server: f.server, storage: f.storage, locks: f.locks, userBox: f.userBox, hashFn: slow });
  const r = await tab.begin(APPROVE()); assert.deepEqual([r.status, r.code], ['aborted', 'SESSION_CHANGED']);
  assert.equal(f.server.st.calls.length, 0); assert.equal(f.storage.m.size, 0);
  // retry: an ambiguous request of REV exists; the session flips while the signature is recomputed
  const g = fresh(); g.server.st.dropReplyOnce = true; await g.tab.begin(APPROVE()); const sent = g.server.st.calls.length;
  const t2 = makeTab({ server: g.server, storage: g.storage, locks: new FakeLocks(), userBox: g.userBox, hashFn: async (d) => { const h = await (await import('../../src/domain/validation/document-hash.js')).documentHashHex(d); g.userBox.email = 'rev2@x.com'; return h; } });
  const rr = await t2.retry(scopeOf()); assert.deepEqual([rr.status, rr.code], ['aborted', 'SESSION_CHANGED']);
  assert.equal(g.server.st.calls.length, sent); g.userBox.email = REV; assert.equal(g.tab.get(scopeOf()).status, 'ambiguous', 'the original entry is untouched');
});
test('7c. the session changes AFTER the send: the outcome is kept in the OWNER\'s scope and not shown to the new user', async () => {
  // success: sent under REV, user switches while the call is in flight
  const f = fresh(); f.server.st.delay = 20; const p = f.tab.begin(APPROVE()); await sleep(5); f.userBox.email = 'rev2@x.com';
  const r = await p; assert.deepEqual([r.status, r.outcome], ['background', 'success']); assert.equal(r.data, undefined); assert.equal(r.error, undefined);
  assert.equal(f.server.st.effects.length, 1); assert.equal(f.server.st.effects[0].email, REV, 'sent under the identity the operation started with');
  assert.equal(f.tab.pending().length, 0);
  // ambiguous: the new user sees nothing; the owner, back again, sees the unresolved request
  const g = fresh(); g.server.st.delay = 20; g.server.st.dropReplyOnce = true; const q = g.tab.begin(APPROVE()); await sleep(5); g.userBox.email = 'rev2@x.com';
  const r2 = await q; assert.deepEqual([r2.status, r2.outcome], ['background', 'ambiguous']); assert.equal(r2.entry, undefined);
  assert.deepEqual(g.tab.pending(), [], 'not shown to the new user'); assert.equal(g.tab.isBlocked({ fundId: 'f1', valuationDate: '2026-10-11' }), false);
  assert.equal(g.storage.m.size, 1, 'stored under the owner scope'); assert.equal(JSON.parse([...g.storage.m.values()][0]).scope, scopeOf(REV));
  g.userBox.email = REV; assert.equal(g.tab.pending().length, 1); assert.equal(g.tab.pending()[0].status, 'ambiguous');
  // retry result after a switch: also kept, not shown
  g.server.st.delay = 20; const t = g.tab.retry(scopeOf()); await sleep(5); g.userBox.email = 'rev2@x.com'; const r3 = await t;
  assert.deepEqual([r3.status, r3.outcome], ['background', 'success']); assert.equal(g.server.st.effects.length, 1); assert.equal(g.storage.m.size, 0);
});
test('7d. discard and recoverInflight are also bound to the starting session', async () => {
  const f = fresh(); f.server.st.dropReplyOnce = true; await f.tab.begin(APPROVE());
  f.locks.beforeGrant = () => { f.userBox.email = 'rev2@x.com'; };
  f.userBox.email = REV; const d = await f.tab.discard(scopeOf(), { acknowledgeRisk: true }); assert.deepEqual([d.status, d.code], ['aborted', 'SESSION_CHANGED']);
  f.userBox.email = REV; assert.equal(f.tab.pending().length, 1, 'not discarded');
});

/* ---------------- a refusal that precedes the stored-result lookup proves nothing ---------------- */
test('8. a retry refused BEFORE the lookup (payload shape) stays UNRESOLVED; the first attempt had taken effect', async () => {
  const f = fresh(); const s = f.server.st; s.dropReplyOnce = true; await f.tab.begin(APPROVE()); assert.equal(s.effects.length, 1);
  s.shapeRejectOnce = true; // e.g. the server contract changed between the two attempts
  const r = await f.tab.retry(scopeOf());
  assert.equal(r.status, 'unresolved'); assert.equal(r.error.reason, 'PAYLOAD_UNKNOWN_FIELD'); assert.ok(f.tab.get(scopeOf())); assert.equal(f.tab.get(scopeOf()).status, 'unresolved');
  assert.equal((await f.tab.begin(APPROVE())).code, 'PENDING_EXISTS'); assert.equal(s.effects.length, 1);
  const ok = await f.tab.retry(scopeOf()); assert.deepEqual([ok.status, ok.replayed], ['success', true]); assert.equal(s.effects.length, 1);
});
test('8b. the "no effect after lookup" reason list is tied to the server source', async () => {
  const fs = await import('fs'); const src = fs.readFileSync(new URL('../../functions/fund-valuations.cjs', import.meta.url), 'utf8').split('\n');
  const found = new Map();
  src.forEach((line, i) => { for (const m of line.matchAll(/err\('(failed-precondition|not-found|invalid-argument|permission-denied)', '([A-Z_]+)'/g)) { if (!found.has(m[2])) found.set(m[2], []); found.get(m[2]).push({ code: m[1], line: i + 1 }); } });
  const checked = [...found].filter(([, v]) => v.some((x) => x.code === 'failed-precondition' || x.code === 'not-found')).map(([k]) => k).sort();
  assert.deepEqual([...R.NO_EFFECT_AFTER_LOOKUP_REASONS].sort(), checked, 'a new failed-precondition/not-found reason in the server needs a decision here');
  const lookupLine = src.findIndex((l) => l.includes('const reqSnap = await tx.get(reqRef)')) + 1; assert.ok(lookupLine > 200);
  const envelopeStart = src.findIndex((l) => l.includes('async function envelope(')) + 1;
  for (const r of R.NO_EFFECT_AFTER_LOOKUP_REASONS) {
    assert.ok(!found.get(r).some((x) => x.code === 'invalid-argument' || x.code === 'permission-denied'), r + ' is also raised with a pre-lookup code');
    // raised only in transaction bodies or helpers they call (all located after the shape helpers, none inside parse/envelope pre-lookup code)
    for (const x of found.get(r)) assert.ok(x.line > 200 && !(x.line > envelopeStart && x.line < lookupLine), r + ' raised before the stored-result lookup at line ' + x.line);
  }
  // codes raised before the lookup are never "no effect"
  for (const r of ['PAYLOAD_UNKNOWN_FIELD', 'REQUEST_ID_INVALID', 'ID_INVALID', 'HASH_INVALID', 'REASON_REQUIRED', 'ROLE_NOT_ALLOWED', 'MEMBERSHIP_REQUIRED']) assert.ok(!R.NO_EFFECT_AFTER_LOOKUP_REASONS.includes(r), r);
});
test('9. no claim beyond what the contract and runner guarantee (static)', async () => {
  const fs = await import('fs');
  const doc = fs.readFileSync(new URL('../../docs/XIRR_RESIDUAL_VALUATION_UI_CONTRACT.md', import.meta.url), 'utf8');
  assert.doesNotMatch(doc, /هي التي تمنع الأثر المزدوج حتى لو أُرسل طلبان بمعرّفين مختلفين/);
  assert.match(doc, /لا يضمن منع الأثر المزدوج في كل الحالات/); assert.match(doc, /NO_RELIABLE_LOCK/); assert.match(doc, /التجاهل ليس إثباتًا لحسم النتيجة/);
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e).split('\n').slice(0, 5).join('\n      ')); }
}
console.log(`\nfund-valuation-requests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
