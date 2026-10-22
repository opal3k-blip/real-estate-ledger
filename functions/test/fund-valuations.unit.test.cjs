'use strict';
/* R1-B1 — pure helpers of the valuation workflow (no Firestore). The transactional behaviour is covered by
   fund-valuations.emulator.test.js against the real emulator. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fv = require('../fund-valuations.cjs');
const { ROLES: DECIDED_ROLES, APPROVED } = require('./helpers/valuation-approved-matrix.cjs');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`OK ${name}`); }

test('role lists are explicit arrays of known roles (no "role and above"), frozen, and cover every action', () => {
  const actions = ['createDraft', 'updateDraft', 'submit', 'review', 'returnDraft', 'reject', 'withdraw', 'approve', 'suspend', 'reinstate', 'preview'];
  assert.deepEqual(Object.keys(fv.ROLE_LISTS).sort(), actions.slice().sort());
  for (const a of actions) {
    const l = fv.ROLE_LISTS[a];
    assert.ok(Array.isArray(l) && l.length > 0 && Object.isFrozen(l), a);
    for (const r of l) assert.ok(fv.ROLES.includes(r), `${a}: unknown role ${r}`);
    assert.equal(new Set(l).size, l.length);
  }
});

test('payload allow-lists: one frozen list per action, no unknown actions, requestId on every mutating action', () => {
  assert.deepEqual(Object.keys(fv.ALLOWED_KEYS).sort(), Object.keys(fv.ROLE_LISTS).sort());
  for (const [a, l] of Object.entries(fv.ALLOWED_KEYS)) {
    assert.ok(Object.isFrozen(l), a);
    assert.equal(new Set(l).size, l.length, a);
    if (a !== 'preview') assert.ok(l.includes('requestId'), a);
  }
  assert.ok(fv.ALLOWED_KEYS.updateDraft.includes('expectedContentHash'));
  assert.ok(fv.ALLOWED_KEYS.review.includes('expectedContentHash') && fv.ALLOWED_KEYS.approve.includes('expectedContentHash'));
  assert.ok(!fv.ALLOWED_KEYS.submit.includes('content'));
});

test('static: every mutating action passes through the shared envelope (allow-list + in-transaction authorization + commit-time day check)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'fund-valuations.cjs'), 'utf8');
  assert.ok(/needPayload\(action, request\.data\)/.test(src));
  assert.ok(/authorizeInTx\(tx, email/.test(src));
  assert.ok(/needPayload\('preview'/.test(src));
  for (const n of ['createDraft', 'updateDraft', 'submit', 'review', 'approve']) assert.ok(new RegExp(`commitCheck\\('${n}'`).test(src), `commitCheck missing for ${n}`);
});

test('decided matrix (hand-written literal, 2026-10-08 15:36): every action x every role matches exactly', () => {
  assert.deepEqual(Object.keys(APPROVED).sort(), Object.keys(fv.ROLE_LISTS).sort());
  assert.deepEqual(fv.ROLES.slice().sort(), DECIDED_ROLES.slice().sort());
  for (const [action, byRole] of Object.entries(APPROVED)) {
    for (const role of DECIDED_ROLES) assert.equal(fv.roleAllowed(action, role), byRole[role], `${action}/${role}`);
    assert.deepEqual(fv.ROLE_LISTS[action].slice().sort(), DECIDED_ROLES.filter((r) => byRole[r]).sort(), action);
  }
  for (const a of ['review', 'returnDraft', 'reject', 'approve', 'suspend', 'reinstate']) assert.equal(fv.roleAllowed(a, 'fund_manager'), false, `fund_manager must not ${a}`);
  assert.equal(fv.roleAllowed('preview', 'analyst'), false);
});

test('roleAllowed: exact membership only; unknown action or role is refused', () => {
  assert.equal(fv.roleAllowed('approve', 'senior_ic'), true);
  assert.equal(fv.roleAllowed('approve', 'analyst'), false);
  assert.equal(fv.roleAllowed('submit', 'senior_ic'), false);
  assert.equal(fv.roleAllowed('submit', 'admin'), true);
  assert.equal(fv.roleAllowed('nope', 'admin'), false);
  assert.equal(fv.roleAllowed('approve', 'superuser'), false);
  assert.equal(fv.roleAllowed('constructor', 'admin'), false);
  assert.equal(fv.roleAllowed('__proto__', 'admin'), false);
});

test('riyadhDay: fixed UTC+3, exact boundaries, invalid instant throws', () => {
  assert.equal(fv.riyadhDay(new Date('2026-10-08T20:59:59.999Z')), '2026-10-08');
  assert.equal(fv.riyadhDay(new Date('2026-10-08T21:00:00.000Z')), '2026-10-09');
  assert.equal(fv.riyadhDay(new Date('2026-12-31T21:00:00.000Z')), '2027-01-01');
  assert.equal(fv.riyadhDay(new Date('2028-02-28T21:00:00.000Z')), '2028-02-29');
  assert.throws(() => fv.riyadhDay(new Date('x')));
  assert.throws(() => fv.riyadhDay('2026-10-08'));
});

test('realIsoDay: real calendar dates only', () => {
  for (const ok of ['2026-10-08', '2028-02-29']) assert.equal(fv.realIsoDay(ok), true, ok);
  for (const bad of ['2026-02-30', '2027-02-29', '2026-1-1', '', null, 20261008, '2026-10-08T00:00:00Z', '2026-13-01']) assert.equal(fv.realIsoDay(bad), false, String(bad));
});

test('replayKey: bound to actor AND requestId, stable, hex digest', () => {
  const a = fv.replayKey('a@x.sa', 'req-00000001'), b = fv.replayKey('b@x.sa', 'req-00000001'), c = fv.replayKey('a@x.sa', 'req-00000002');
  assert.match(a, /^[0-9a-f]{64}$/); assert.notEqual(a, b); assert.notEqual(a, c); assert.equal(a, fv.replayKey('a@x.sa', 'req-00000001'));
  assert.notEqual(fv.replayKey('a@x.sa\nreq', '00000001'), fv.replayKey('a@x.sa', 'req\n00000001'));   // no delimiter ambiguity
  assert.notEqual(fv.replayKey('ab', 'c'), fv.replayKey('a', 'bc'));
});

test('requestId and id formats', () => {
  for (const ok of ['abcdefgh', 'A_b-1234567890', 'x'.repeat(64)]) assert.match(ok, fv.REQUEST_ID_RE);
  for (const bad of ['short', 'x'.repeat(65), 'has space1', 'a/b/c/d/e/f', '', 'ünïcödé123']) assert.doesNotMatch(bad, fv.REQUEST_ID_RE);
  assert.match('F1abc', fv.ID_RE); assert.doesNotMatch('a/b', fv.ID_RE); assert.doesNotMatch('', fv.ID_RE);
});

test('headKey and ledgerRecord shapes', () => {
  assert.equal(fv.headKey('F1', '2026-10-08'), 'F1__2026-10-08');
  assert.deepEqual(fv.ledgerRecord('capitalCall', 'c1', { fundId: 'F1', callDate: '2026-01-01', status: 'paid', amount: 5 }), { kind: 'capitalCall', id: 'c1', fundId: 'F1', date: '2026-01-01', status: 'paid' });
  assert.deepEqual(fv.ledgerRecord('distribution', 'd1', { fundId: 'F1', distDate: '2026-02-01', status: 'approved' }), { kind: 'distribution', id: 'd1', fundId: 'F1', date: '2026-02-01', status: 'approved' });
});

test('state vocabulary: active states hold the draft slot; terminal states do not', () => {
  assert.deepEqual(fv.ACTIVE_STATES.slice().sort(), ['draft', 'returned', 'reviewed', 'submitted']);
  for (const t of ['approved', 'rejected', 'withdrawn']) assert.ok(!fv.ACTIVE_STATES.includes(t));
  for (const s of fv.ACTIVE_STATES) assert.ok(fv.STATES.includes(s));
});

test('content whitelist cannot carry workflow or approval fields', () => {
  for (const k of ['status', 'state', 'approvedBy', 'enteredBy', 'version', 'supersedes', 'contributors', 'baseHeadId', 'review', 'scopeSnapshot', 'contentHash', 'valuationId', 'fundId', 'valuationDate']) assert.ok(!fv.CONTENT_KEYS.includes(k), k);
});

test('static: the module has no direct Date.now / new Date() outside the injectable clock, and does not import the UI', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'fund-valuations.cjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/Date\.now\(/.test(src));
  assert.equal((src.match(/new Date\(\)/g) || []).length, 1, 'only the default clock may call new Date()');
  assert.ok(!/require\(['"]\.\.\/src/.test(src));
});

test('static: the workflow never writes the selector status "approved" outside the approval path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'fund-valuations.cjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const hits = [...src.matchAll(/status:\s*'approved'/g)].map((m) => src.slice(Math.max(0, m.index - 140), m.index));
  // the only writers: the query filter (where('status','==','approved') is a different form), the shadow record and the approved record
  assert.ok(hits.length >= 2 && hits.length <= 3, `unexpected number of status:'approved' sites: ${hits.length}`);
  const apprFn = src.slice(src.indexOf('async function approve('), src.indexOf('async function eligibilityChange('));
  for (const m of src.matchAll(/status:\s*'approved'/g)) assert.ok(m.index >= src.indexOf('async function approve(') && m.index < src.indexOf('async function eligibilityChange('), 'status approved outside approve()');
  void apprFn;
});

console.log(`\n${passed} unit tests passed (fund-valuations).`);
