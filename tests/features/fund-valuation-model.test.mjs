/* XIRR-R1B2 / B2-0 — pure UI model of the fund residual-valuation workflow.
   Run: node tests/features/fund-valuation-model.test.mjs   (exit 0 only if all pass)
   Parity with the SERVER (roles, payload allow-list, error reasons, headHash) is checked against the real
   functions/fund-valuations.cjs / trusted-ic.cjs / firestore.rules; the expectation tables below are written by hand. */
import assert from 'assert/strict';
import fs from 'fs';
import { createRequire } from 'module';
import * as M from '../../src/features/fund-valuation-model.js';

const require = createRequire(import.meta.url);
const S = require('../../functions/fund-valuations.cjs');
const { documentHash } = require('../../functions/trusted-ic.cjs');

let passed = 0; let failed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---- independent expectation: action -> [fund_manager, senior_ic, admin, analyst] allowed (hand-written) ---- */
const EXPECT = {
  createDraft: [1, 0, 1, 0], updateDraft: [1, 0, 1, 0], submit: [1, 0, 1, 0], withdraw: [1, 0, 1, 0],
  review: [0, 1, 1, 0], returnDraft: [0, 1, 1, 0], reject: [0, 1, 1, 0], approve: [0, 1, 1, 0], suspend: [0, 1, 1, 0], reinstate: [0, 1, 1, 0],
  preview: [1, 1, 1, 0],
};
const ORDER = ['fund_manager', 'senior_ic', 'admin', 'analyst'];

test('1. roles: client table = independent table = server ROLE_LISTS', () => {
  assert.deepEqual(Object.keys(M.ACTION_ROLES).sort(), Object.keys(EXPECT).sort());
  for (const [a, row] of Object.entries(EXPECT)) {
    ORDER.forEach((role, i) => {
      assert.equal(M.roleCanDo(a, role), !!row[i], `${a}/${role}`);
      assert.equal(S.roleAllowed(a, role), !!row[i], `server ${a}/${role}`);
    });
  }
  assert.deepEqual(Object.keys(S.ROLE_LISTS).sort(), Object.keys(M.ACTION_ROLES).sort());
  for (const a of Object.keys(S.ROLE_LISTS)) assert.deepEqual([...M.ACTION_ROLES[a]].sort(), [...S.ROLE_LISTS[a]].sort(), a);
  assert.equal(M.roleCanDo('hasOwnProperty', 'admin'), false);
  assert.equal(M.roleCanDo('createDraft', 'superuser'), false);
});

test('1b. read roles = firestore.rules canReadFundValuations (static)', () => {
  const rules = fs.readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
  const m = rules.match(/function canReadFundValuations\(\)\s*\{[^}]*currentRole\(\) in \[([^\]]*)\]/);
  assert.ok(m, 'rule function not found');
  const inRules = m[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort();
  assert.deepEqual(inRules, [...M.READ_ROLES].sort());
  for (const r of ORDER) assert.equal(M.canRead(r), r !== 'analyst');
  assert.equal(M.canRead(undefined), false);
});

test('2. payload spec = server ALLOWED_KEYS (every callable)', () => {
  assert.deepEqual(Object.keys(M.PAYLOAD_SPEC).sort(), Object.keys(S.ALLOWED_KEYS).sort());
  for (const a of Object.keys(S.ALLOWED_KEYS)) {
    const mine = [...M.PAYLOAD_SPEC[a].required, ...M.PAYLOAD_SPEC[a].optional].sort();
    assert.deepEqual(mine, [...S.ALLOWED_KEYS[a]].filter((k) => !(a === 'preview' && false)).sort(), a);
  }
  assert.deepEqual(Object.keys(M.CALLABLES).sort(), Object.keys(S.ALLOWED_KEYS).sort());
  // callable names are exported by functions/index.js
  const idx = fs.readFileSync(new URL('../../functions/index.js', import.meta.url), 'utf8');
  for (const c of Object.values(M.CALLABLES)) assert.match(idx, new RegExp(`exports\\.${c}\\s*=`), c);
});

const H = 'a'.repeat(64);
const FIELDS = {
  createDraft: { requestId: 'req-00001', fundId: 'f1', valuationDate: '2026-10-11', content: { residualValue: 1 } },
  updateDraft: { requestId: 'req-00002', valuationId: 'v1', expectedContentHash: H, content: { residualValue: 2 } },
  submit: { requestId: 'req-00003', valuationId: 'v1' },
  review: { requestId: 'req-00004', valuationId: 'v1', expectedContentHash: H },
  returnDraft: { requestId: 'req-00005', valuationId: 'v1', reason: 'r' },
  reject: { requestId: 'req-00006', valuationId: 'v1', reason: 'r' },
  withdraw: { requestId: 'req-00007', valuationId: 'v1' },
  approve: { requestId: 'req-00008', valuationId: 'v1', expectedContentHash: H },
  suspend: { requestId: 'req-00009', fundId: 'f1', valuationDate: '2026-10-11', expectedHeadId: 'v0', reason: 'r' },
  reinstate: { requestId: 'req-00010', fundId: 'f1', valuationDate: '2026-10-11', expectedHeadId: 'v0', reason: 'r' },
  preview: { valuationId: 'v1' },
};

test('2b. builders: required present, no extra keys, unknown/missing rejected', () => {
  for (const [a, f] of Object.entries(FIELDS)) {
    const p = M.buildPayload(a, f);
    assert.deepEqual(Object.keys(p).sort(), Object.keys(f).sort(), a);
    for (const k of Object.keys(p)) assert.ok(S.ALLOWED_KEYS[a].includes(k), `${a}.${k} not allowed by server`);
    assert.throws(() => M.buildPayload(a, { ...f, viewFingerprint: 'x' }), (e) => e.clientCode === 'PAYLOAD_UNKNOWN_FIELD', a);
    for (const k of M.PAYLOAD_SPEC[a].required) {
      if (a === 'createDraft' && k === 'content') continue;
      const g = { ...f }; delete g[k];
      assert.throws(() => M.buildPayload(a, g), (e) => e.clientCode === 'PAYLOAD_MISSING', `${a} without ${k}`);
    }
  }
  // actions with no server binding must not grow a hash/head field
  for (const a of ['submit', 'withdraw', 'returnDraft', 'reject']) {
    assert.throws(() => M.buildPayload(a, { ...FIELDS[a], expectedContentHash: H }), (e) => e.clientCode === 'PAYLOAD_UNKNOWN_FIELD');
    assert.throws(() => M.buildPayload(a, { ...FIELDS[a], expectedHeadId: 'v0' }), (e) => e.clientCode === 'PAYLOAD_UNKNOWN_FIELD');
  }
  assert.deepEqual(M.SERVER_BINDING.submit, []); assert.deepEqual(M.SERVER_BINDING.approve, ['contentHash']); assert.deepEqual(M.SERVER_BINDING.suspend, ['headId']);
});

test('2c. approve: acknowledgeSuspended only when exactly true; createDraft copy/content', () => {
  assert.equal('acknowledgeSuspended' in M.buildPayload('approve', { ...FIELDS.approve, acknowledgeSuspended: false }), false);
  assert.equal('acknowledgeSuspended' in M.buildPayload('approve', { ...FIELDS.approve }), false);
  assert.equal(M.buildPayload('approve', { ...FIELDS.approve, acknowledgeSuspended: true, reason: 'why' }).acknowledgeSuspended, true);
  assert.throws(() => M.buildPayload('approve', { ...FIELDS.approve, acknowledgeSuspended: 'yes' }), (e) => e.clientCode === 'ACK_INVALID');
  const c = M.buildPayload('createDraft', { requestId: 'req-00011', fundId: 'f1', valuationDate: '2026-10-11', copyFromValuationId: 'v9' });
  assert.deepEqual(Object.keys(c).sort(), ['copyFromValuationId', 'fundId', 'requestId', 'valuationDate']);
  assert.throws(() => M.buildPayload('createDraft', { requestId: 'req-00011', fundId: 'f1', valuationDate: '2026-10-11' }), (e) => e.clientCode === 'PAYLOAD_MISSING');
});

test('2d. builders refuse what the server refuses (ids, hash, request id, date, reason)', () => {
  const bad = (a, patch, code) => assert.throws(() => M.buildPayload(a, { ...FIELDS[a], ...patch }), (e) => e.clientCode === code, `${a} ${JSON.stringify(patch)}`);
  bad('submit', { requestId: 'short' }, 'REQUEST_ID_INVALID');
  bad('submit', { requestId: 'has space 123' }, 'REQUEST_ID_INVALID');
  bad('submit', { valuationId: 'a__b' }, 'ID_INVALID');
  bad('review', { expectedContentHash: 'ABC' }, 'HASH_INVALID');
  bad('suspend', { valuationDate: '2026-02-30' }, 'DATE_INVALID');
  bad('suspend', { reason: '   ' }, 'REASON_REQUIRED');
  bad('suspend', { reason: 'x'.repeat(1001) }, 'REASON_REQUIRED');
  bad('updateDraft', { content: [1] }, 'CONTENT_INVALID');
  assert.throws(() => M.buildPayload('nope', {}), (e) => e.clientCode === 'ACTION_UNKNOWN');
  // same shape rules as the server's own regexes
  assert.equal(M.REQUEST_ID_RE.source, S.REQUEST_ID_RE.source); assert.equal(M.ID_RE.source, S.ID_RE.source);
});

test('2e. buildPayload returns an independent deep copy (no aliasing of nested caller objects)', () => {
  const content = { method: 'appraisal', components: [{ k: 1 }] }; const f = { ...FIELDS.createDraft, content };
  const p = M.buildPayload('createDraft', f);
  content.method = 'x'; content.components[0].k = 2; content.components.push({ k: 3 });
  assert.deepEqual(p.content, { method: 'appraisal', components: [{ k: 1 }] });
  p.content.components[0].k = 9; assert.equal(content.components[0].k, 2);
  assert.throws(() => M.buildPayload('createDraft', { ...FIELDS.createDraft, content: { f() {} } }), (e) => e.clientCode === 'PAYLOAD_INVALID');
});

test('3. dates: riyadhDay parity, three different date situations', () => {
  const t = [new Date('2026-10-10T20:59:59.999Z'), new Date('2026-10-10T21:00:00.000Z'), new Date('2026-12-31T21:00:00Z'), new Date('2028-02-28T21:00:00Z')];
  for (const d of t) assert.equal(M.riyadhDay(d), S.riyadhDay(d));
  assert.equal(M.riyadhDay(t[0]), '2026-10-10'); assert.equal(M.riyadhDay(t[1]), '2026-10-11');
  assert.throws(() => M.riyadhDay(new Date('x'))); assert.throws(() => M.riyadhDay('2026-10-11'));
  assert.equal(M.classifyDate('2026-10-11', '2026-10-11'), 'today');
  assert.equal(M.classifyDate('2026-10-10', '2026-10-11'), 'crossed');
  assert.equal(M.classifyDate('2026-10-12', '2026-10-11'), 'future');
  for (const x of ['2026-02-30', '2026-13-01', 'abc', '', null, undefined, 20261011, '2026-1-1']) assert.equal(M.classifyDate(x, '2026-10-11'), 'invalid', String(x));
  assert.equal(M.classifyDate('2026-10-11', 'bad'), 'invalid');
  for (const x of ['2026-02-29', '2024-02-29', '2026-04-31']) assert.equal(M.isRealIsoDay(x), S.realIsoDay(x), x);
  const m = (r) => M.describeError({ code: 'functions/failed-precondition', details: { reason: r } }, 'ar').message;
  assert.equal(new Set([m('DATE_CROSSED'), m('DATE_IN_FUTURE'), M.describeError({ code: 'invalid-argument', details: { reason: 'DATE_INVALID' } }).message]).size, 3);
  assert.match(m('DATE_CROSSED'), /عبر اليوم/); assert.match(m('DATE_IN_FUTURE'), /مستقبلي/);
});

const V = (o) => ({ valuationId: 'v1', fundId: 'f1', valuationDate: '2026-10-11', state: 'draft', contributors: ['prep@x.com'], enteredBy: 'prep@x.com', contentHash: H, rev: 1, ...o });
const TODAY = '2026-10-11';
const acts = (role, email, v, extra) => M.availableActions({ role, email, today: TODAY, valuation: v, ...extra });
const ok = (r, a) => assert.equal(r[a].allowed, true, `${a}: ${r[a].reason}`);
const nope = (r, a, reason) => { assert.equal(r[a].allowed, false, a); if (reason) assert.equal(r[a].reason, reason, a); };

test('4. states: reject is NOT offered on draft; others per server', () => {
  const by = (state, role, email, extra) => acts(role, email, V({ state }), extra);
  nope(by('draft', 'senior_ic', 'rev@x.com'), 'reject', 'INVALID_STATE');
  for (const s of ['submitted', 'reviewed', 'returned']) ok(by(s, 'senior_ic', 'rev@x.com'), 'reject');
  for (const s of ['approved', 'rejected', 'withdrawn']) nope(by(s, 'senior_ic', 'rev@x.com'), 'reject');
  ok(by('submitted', 'senior_ic', 'rev@x.com'), 'review'); nope(by('reviewed', 'senior_ic', 'rev@x.com'), 'review', 'INVALID_STATE');
  ok(by('reviewed', 'senior_ic', 'rev@x.com'), 'approve'); nope(by('submitted', 'senior_ic', 'rev@x.com'), 'approve', 'INVALID_STATE');
  ok(by('submitted', 'senior_ic', 'rev@x.com'), 'returnDraft'); ok(by('reviewed', 'senior_ic', 'rev@x.com'), 'returnDraft'); nope(by('returned', 'senior_ic', 'rev@x.com'), 'returnDraft');
  for (const s of ['draft', 'returned']) { ok(by(s, 'fund_manager', 'prep@x.com'), 'updateDraft'); ok(by(s, 'fund_manager', 'prep@x.com'), 'submit'); }
  for (const s of ['submitted', 'reviewed', 'approved']) nope(by(s, 'fund_manager', 'prep@x.com'), 'updateDraft', 'INVALID_STATE');
  nope(by('submitted', 'fund_manager', 'prep@x.com'), 'submit', 'ALREADY_SUBMITTED');
  ok(by('submitted', 'fund_manager', 'prep@x.com', { stale: true }), 'submit');
  for (const s of ['draft', 'returned', 'submitted', 'reviewed']) ok(by(s, 'fund_manager', 'prep@x.com'), 'withdraw');
  for (const s of ['approved', 'rejected', 'withdrawn']) nope(by(s, 'fund_manager', 'prep@x.com'), 'withdraw', 'INVALID_STATE');
});

test('4b. people: contributor rules, admin not exempt, roles', () => {
  nope(acts('fund_manager', 'other@x.com', V()), 'submit', 'NOT_A_CONTRIBUTOR');
  nope(acts('fund_manager', 'other@x.com', V()), 'withdraw', 'NOT_A_CONTRIBUTOR');
  ok(acts('fund_manager', 'other@x.com', V()), 'updateDraft'); // any holder of the role may edit; the server adds them as contributor
  const sub = V({ state: 'submitted' });
  nope(acts('senior_ic', 'prep@x.com', sub), 'review', 'CONTRIBUTOR_CANNOT_REVIEW');
  const rev = V({ state: 'reviewed' });
  nope(acts('admin', 'prep@x.com', rev), 'approve', 'CONTRIBUTOR_CANNOT_APPROVE'); // admin not exempt
  nope(acts('admin', 'enterer@x.com', V({ state: 'reviewed', enteredBy: 'enterer@x.com' })), 'approve', 'CONTRIBUTOR_CANNOT_APPROVE');
  // a CONTRIBUTOR who is not the preparer: still refused, admin included
  const multi = (state) => V({ state, contributors: ['prep@x.com', 'c2@x.com'] });
  nope(acts('admin', 'c2@x.com', multi('reviewed')), 'approve', 'CONTRIBUTOR_CANNOT_APPROVE');
  nope(acts('admin', 'c2@x.com', multi('submitted')), 'review', 'CONTRIBUTOR_CANNOT_REVIEW');
  nope(acts('admin', 'c2@x.com', multi('submitted')), 'returnDraft', 'CONTRIBUTOR_CANNOT_REVIEW');
  nope(acts('admin', 'c2@x.com', multi('submitted')), 'reject', 'CONTRIBUTOR_CANNOT_REVIEW');
  ok(acts('admin', 'rev@x.com', rev), 'approve');
  nope(acts('fund_manager', 'rev@x.com', rev), 'approve', 'ROLE_NOT_ALLOWED');
  nope(acts('senior_ic', 'prep@x.com', V()), 'submit', 'ROLE_NOT_ALLOWED');
  nope(acts('analyst', 'a@x.com', V()), 'updateDraft', 'ROLE_NOT_ALLOWED');
  ok(acts('senior_ic', 'rev@x.com', sub), 'review'); // reviewer may be the approver too
});

test('4c. crossing the day: only withdraw / return / reject remain; messages differ for crossed vs future', () => {
  const old = V({ valuationDate: '2026-10-10', state: 'reviewed' });
  nope(acts('fund_manager', 'prep@x.com', V({ valuationDate: '2026-10-10' })), 'updateDraft', 'DATE_CROSSED');
  nope(acts('fund_manager', 'prep@x.com', V({ valuationDate: '2026-10-10' })), 'submit', 'DATE_CROSSED');
  nope(acts('senior_ic', 'rev@x.com', V({ valuationDate: '2026-10-10', state: 'submitted' })), 'review', 'DATE_CROSSED');
  nope(acts('senior_ic', 'rev@x.com', old), 'approve', 'DATE_CROSSED');
  ok(acts('senior_ic', 'rev@x.com', old), 'returnDraft'); ok(acts('senior_ic', 'rev@x.com', old), 'reject');
  ok(acts('fund_manager', 'prep@x.com', old), 'withdraw');
  const fut = V({ valuationDate: '2026-10-12' });
  nope(acts('fund_manager', 'prep@x.com', fut), 'updateDraft', 'DATE_IN_FUTURE');
  const inv = V({ valuationDate: '2026-02-30' });
  nope(acts('fund_manager', 'prep@x.com', inv), 'updateDraft', 'DATE_INVALID');
  // server check: these four are the requireDay actions
  const src = fs.readFileSync(new URL('../../functions/fund-valuations.cjs', import.meta.url), 'utf8');
  assert.equal((src.match(/requireDay\(v, today\)/g) || []).length, 4);
});

test('4d. creation is today-only and blocked by an active draft; past dates stay readable/suspendable', () => {
  ok(M.availableActions({ role: 'fund_manager', email: 'p@x.com', today: TODAY }), 'createDraft');
  nope(M.availableActions({ role: 'fund_manager', email: 'p@x.com', today: TODAY, createDate: '2026-10-10' }), 'createDraft', 'DATE_CROSSED');
  nope(M.availableActions({ role: 'fund_manager', email: 'p@x.com', today: TODAY, createDate: '2026-10-12' }), 'createDraft', 'DATE_IN_FUTURE');
  nope(M.availableActions({ role: 'fund_manager', email: 'p@x.com', today: TODAY, head: { headId: 'v0', activeDraftId: 'v1' } }), 'createDraft', 'ACTIVE_DRAFT_EXISTS');
  nope(M.availableActions({ role: 'senior_ic', email: 'p@x.com', today: TODAY }), 'createDraft', 'ROLE_NOT_ALLOWED');
  // a PAST date with an approved head: suspend/reinstate remain available (server has no day check there)
  const head = { headId: 'v0', headHash: H, eligibility: { state: 'ELIGIBLE' }, valuationDate: '2026-09-01' };
  ok(M.availableActions({ role: 'senior_ic', email: 'r@x.com', today: TODAY, head }), 'suspend');
  const susp = { ...head, eligibility: { state: 'SUSPENDED', changedBy: 'r@x.com' } };
  nope(M.availableActions({ role: 'senior_ic', email: 'r@x.com', today: TODAY, head: susp }), 'reinstate', 'SUSPENDER_CANNOT_RESTORE');
  ok(M.availableActions({ role: 'senior_ic', email: 'o@x.com', today: TODAY, head: susp }), 'reinstate');
  nope(M.availableActions({ role: 'senior_ic', email: 'o@x.com', today: TODAY, head: susp, headValuation: { contributors: ['o@x.com'] } }), 'reinstate', 'CONTRIBUTOR_CANNOT_REINSTATE');
  nope(M.availableActions({ role: 'senior_ic', email: 'o@x.com', today: TODAY, head: susp, headValuation: { contributors: [], approvedBy: 'O@x.com' } }), 'reinstate', 'CONTRIBUTOR_CANNOT_REINSTATE');
  nope(M.availableActions({ role: 'senior_ic', email: 'o@x.com', today: TODAY, head }), 'reinstate', 'NOT_SUSPENDED');
  nope(M.availableActions({ role: 'senior_ic', email: 'o@x.com', today: TODAY, head: susp }), 'suspend', 'ALREADY_SUSPENDED');
  nope(M.availableActions({ role: 'senior_ic', email: 'o@x.com', today: TODAY }), 'suspend', 'NO_HEAD');
  nope(M.availableActions({ role: 'fund_manager', email: 'o@x.com', today: TODAY, head }), 'suspend', 'ROLE_NOT_ALLOWED');
});

test('5. view binding: what changed is reported; unbound actions are labelled as such', () => {
  const v = V({ state: 'submitted', scopeHash: 's1', baseHeadId: 'v0' }); const head = { headId: 'v0', headHash: H, eligibility: { state: 'ELIGIBLE' } };
  const a = M.snapshotOf({ valuation: v, head, today: TODAY });
  assert.equal(M.bindingStatus(a, M.snapshotOf({ valuation: { ...v }, head, today: TODAY })).same, true);
  const chg = (patchV, patchH, today) => M.bindingStatus(a, M.snapshotOf({ valuation: { ...v, ...patchV }, head: { ...head, ...patchH }, today: today || TODAY })).changed;
  assert.deepEqual(chg({ contentHash: 'b'.repeat(64) }), ['contentHash']);
  assert.deepEqual(chg({ scopeHash: 's2' }), ['scopeHash']);
  assert.deepEqual(chg({ baseHeadId: 'v5' }), ['baseHeadId']);
  assert.deepEqual(chg({ state: 'reviewed' }), ['state']);
  assert.deepEqual(chg({ rev: 2 }), ['rev']);
  assert.deepEqual(chg({}, { headId: 'v7' }), ['headId']);
  assert.deepEqual(chg({}, { headHash: 'c'.repeat(64) }), ['headHash']);
  assert.deepEqual(chg({}, { eligibility: { state: 'SUSPENDED' } }), ['eligibilityState']);
  assert.deepEqual(chg({}, {}, '2026-10-12'), ['today']);
  assert.deepEqual(M.diffSnapshots(null, null), []);
});

test('6. headHash: client recomputation == server documentHash; any field change fails', async () => {
  const fields = { valuationId: 'v1', version: 3, contentHash: H, approvedBy: 'rev@x.com' };
  const server = documentHash(fields);
  const head = { headId: 'v1', version: 3, headHash: server };
  const doc = { ...fields, state: 'approved' };
  assert.deepEqual(await M.verifyHeadConsistency(head, doc), { ok: true, reason: null });
  const flips = { valuationId: 'v2', version: 4, contentHash: 'b'.repeat(64), approvedBy: 'x@x.com' };
  for (const [k, val] of Object.entries(flips)) {
    const r = await M.verifyHeadConsistency(k === 'valuationId' ? { ...head } : head, { ...doc, [k]: val });
    assert.equal(r.ok, false, k);
  }
  assert.equal((await M.verifyHeadConsistency({ ...head, headHash: 'd'.repeat(64) }, doc)).reason, 'HEAD_HASH_MISMATCH');
  assert.equal((await M.verifyHeadConsistency(head, { ...doc, state: 'draft' })).reason, 'HEAD_DOC_NOT_APPROVED');
  assert.equal((await M.verifyHeadConsistency(head, { ...doc, valuationId: 'v2' })).reason, 'HEAD_DOC_MISMATCH');
  assert.equal((await M.verifyHeadConsistency({ ...head, version: 9 }, doc)).reason, 'HEAD_VERSION_MISMATCH');
  assert.equal((await M.verifyHeadConsistency(null, doc)).reason, 'HEAD_INCOMPLETE');
  assert.equal((await M.verifyHeadConsistency(head, null)).reason, 'HEAD_DOC_NOT_APPROVED');
  assert.equal((await M.verifyHeadConsistency(head, doc, async () => { throw new Error('no crypto'); })).reason, 'HEAD_UNVERIFIABLE'); // fails closed
  // the hash function is the shared one: no hashing code of its own in the model
  const src = fs.readFileSync(new URL('../../src/features/fund-valuation-model.js', import.meta.url), 'utf8');
  assert.match(src, /from '\.\.\/domain\/validation\/document-hash\.js'/); assert.doesNotMatch(src, /crypto\.subtle|createHash/);
});

test('7. error messages: every server reason code has a message (extracted from the source)', () => {
  const src = fs.readFileSync(new URL('../../functions/fund-valuations.cjs', import.meta.url), 'utf8');
  const reasons = new Set([...src.matchAll(/err\('[a-z-]+', '([A-Z_]+)'/g)].map((m) => m[1]));
  assert.ok(reasons.size >= 40, 'extraction found ' + reasons.size);
  for (const r of reasons) {
    assert.ok(M.MESSAGES[r], 'missing message for ' + r);
    for (const lang of ['ar', 'en']) { const d = M.describeError({ code: 'functions/failed-precondition', details: { reason: r } }, lang); assert.equal(d.known, true); assert.equal(d.reason, r); assert.ok(d.message.length > 3); }
  }
  for (const [k, [ar, en]] of Object.entries(M.MESSAGES)) { assert.ok(ar && en, k); assert.notEqual(ar, en, k); }
});

test('7b. describeError keeps the raw reason; unknown reasons are shown verbatim; no invented text', () => {
  const u = M.describeError({ code: 'functions/failed-precondition', details: { reason: 'SOMETHING_NEW' } });
  assert.deepEqual([u.known, u.reason, u.message, u.code], [false, 'SOMETHING_NEW', 'SOMETHING_NEW', 'failed-precondition']);
  assert.match(M.describeError({ code: 'permission-denied' }, 'en').message, /Permission denied/);
  assert.equal(M.describeError(null).code, null); assert.equal(M.describeError({}).known, false);
  assert.equal(M.normalizeFunctionsErrorCode('functions/unavailable'), 'unavailable'); assert.equal(M.normalizeFunctionsErrorCode('unavailable'), 'unavailable'); assert.equal(M.normalizeFunctionsErrorCode(5), null);
});

test('8. session key and generation guard: logout / user switch / lost role stop everything; late results ignored', () => {
  const S1 = { uid: 'u1', email: 'A@x.com', role: 'senior_ic' };
  assert.equal(M.sessionKey(S1), M.sessionKey({ ...S1, email: 'a@x.com' }));
  assert.equal(M.sessionKey({ ...S1, role: 'analyst' }), null); assert.equal(M.sessionKey(null), null); assert.equal(M.sessionKey({ ...S1, uid: '' }), null);
  assert.notEqual(M.sessionKey(S1), M.sessionKey({ ...S1, role: 'admin' }));
  const guard = M.createGenerationGuard(); const resets = []; const shown = [];
  const t = M.createSessionTracker({ guard, onReset: (x) => resets.push(x.reason) });
  assert.equal(t.update(S1).changed, true); assert.deepEqual(resets, []); const g0 = guard.current();
  const late = guard.wrap((x) => shown.push(x)); late('fresh'); assert.deepEqual(shown, ['fresh']);
  assert.equal(t.update({ ...S1 }).changed, false); assert.equal(guard.current(), g0);
  t.update({ uid: 'u2', email: 'b@x.com', role: 'senior_ic' }); // user switch
  assert.deepEqual(resets, ['SESSION_CHANGED']); assert.notEqual(guard.current(), g0);
  late('LATE-from-previous-user'); assert.deepEqual(shown, ['fresh'], 'late result from an old generation must be ignored');
  const late2 = guard.wrap((x) => shown.push(x));
  t.update({ uid: 'u2', email: 'b@x.com', role: 'analyst' }); // lost read role
  assert.deepEqual(resets, ['SESSION_CHANGED', 'NO_READ_ACCESS']); late2('late2'); assert.deepEqual(shown, ['fresh']);
  t.update(null); assert.equal(t.key(), null); // already without access: stays null, no second reset
  assert.deepEqual(resets, ['SESSION_CHANGED', 'NO_READ_ACCESS']);
  // logout from a live session: reset + bump, and a handler created BEFORE the logout is ignored afterwards
  t.update(S1); const late3 = guard.wrap((x) => shown.push(x)); const before = guard.current();
  t.update(null); assert.deepEqual(resets, ['SESSION_CHANGED', 'NO_READ_ACCESS', 'NO_READ_ACCESS']); assert.notEqual(guard.current(), before);
  late3('late3-after-logout'); assert.deepEqual(shown, ['fresh']);
});

test('9. static: no XIRR / DOM / Firebase in the B2-0 modules', () => {
  for (const f of ['fund-valuation-model.js', 'fund-valuation-requests.js']) {
    const src = fs.readFileSync(new URL('../../src/features/' + f, import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const i of imports) assert.ok(/^\.\/fund-valuation-model\.js$|^\.\.\/domain\/validation\/document-hash\.js$/.test(i), f + ' imports ' + i);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /xirr|firebase|\bdocument\.|\bwindow\.|\balert\(|\blocalStorage\b/i);
    assert.doesNotMatch(code, /roleAtLeast|roles-permissions/);
  }
});

for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log('PASS  ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e && e.stack || e).split('\n').slice(0, 4).join('\n      ')); }
}
console.log(`\nfund-valuation-model: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
