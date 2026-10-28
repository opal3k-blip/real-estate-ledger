// Review comment #5 (firestore.rules, transactions): the audit-record id is `type-action-relatedId`.
//   (a) `action` was free text, so one real event could be logged under unlimited ids, and
//   (b) `-` is a legal character inside `action` and `relatedId`, so different events could derive the SAME id
//       (e.g. action="create", relatedId="x-y"  vs  action="create-x", relatedId="y"), the second being rejected as an "update".
// The fix is an allow-list of (type, action) pairs that the clients and the server actually use. No id format change.
// Run (from tests/rules):  firebase emulators:exec --only firestore --project demo-test "node transactions-canonical-id.test.mjs"
// RULES_FILE selects another rules file (e.g. the pre-fix one) so the same assertions can be run against it.
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { doc, setDoc } from 'firebase/firestore';

const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST must be a local emulator, got:', host || '(unset)'); process.exit(3); }
const [h, p] = host.split(':');
const rules = readFileSync(process.env.RULES_FILE || new URL('../../firestore.rules', import.meta.url), 'utf8');
const env = await initializeTestEnvironment({ projectId: 'demo-txn-id', firestore: { rules, host: h, port: Number(p) } });

let failures = 0;
const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); failures++; } else console.log('ok  :', msg); };
const FM = 'fund-manager@x.com';
await env.withSecurityRulesDisabled(async ctx => {
  const db = ctx.firestore();
  await setDoc(doc(db, 'team_members', FM), { expiresAt: null });
  await setDoc(doc(db, 'team_roles', FM), { role: 'fund_manager' });
  for (const id of ['CC1', 'x-y', 'y', 'CC-EXEC-K1']) await setDoc(doc(db, 'capitalCalls', id), { fundId: 'F1', investorId: 'I1', amount: 100, status: 'approved' });
  for (const id of ['D1', 'a-b', 'b']) await setDoc(doc(db, 'distributions', id), { fundId: 'F1', investorId: 'I1', amount: 100, status: 'declared' });
  for (const id of ['K1', 'k-1', '1']) await setDoc(doc(db, 'commitments', id), { fundId: 'F1', investorId: 'I1', commitmentAmount: 100 });
});
const db = env.authenticatedContext('fm', { email: FM }).firestore();
const canon = (type, action, rid) => `${type}-${action}-${rid}`;
const body = (type, action, rid) => ({ type, action, relatedId: rid, fundId: 'F1', investorId: 'I1', amount: 100, by: FM, at: 't', version: 1 });
const tryWrite = async (id, data) => { try { await assertSucceeds(setDoc(doc(db, 'transactions', id), data)); return true; } catch { return false; } };

// 1) Every (type, action) pair the product actually writes is accepted at its canonical id, including relatedIds containing '-'.
const PAIRS = [['commitment', 'create', ['K1', 'k-1']], ['capitalCall', 'create', ['CC1', 'CC-EXEC-K1']], ['capitalCall', 'approve', ['CC1']],
  ['capitalCall', 'post', ['CC1']], ['capitalCall', 'waive', ['x-y']], ['distribution', 'create', ['D1', 'a-b']], ['distribution', 'approve', ['D1']], ['distribution', 'post', ['D1']]];
for (const [type, action, rids] of PAIRS) for (const rid of rids) {
  check(await tryWrite(canon(type, action, rid), body(type, action, rid)), `allowed: ${type}/${action} relatedId=${rid} at id ${canon(type, action, rid)}`);
}

// 2) Free-text or unused actions are refused, for an otherwise valid event (id derived from the free text).
for (const action of ['create2', 'anything-i-like', 'Create', 'CREATE', 'create ', '', 'delete', 'update']) {
  check(!(await tryWrite(canon('capitalCall', action, 'y'), body('capitalCall', action, 'y'))), `refused: capitalCall action=${JSON.stringify(action)}`);
}
check(!(await tryWrite(canon('distribution', 'waive', 'b'), body('distribution', 'waive', 'b'))), 'refused: distribution/waive (only capital calls can be waived)');
check(!(await tryWrite(canon('commitment', 'approve', '1'), body('commitment', 'approve', '1'))), 'refused: commitment/approve (commitments are only created)');
check(!(await tryWrite(canon('assetLink', 'create', 'OPP-1'), body('assetLink', 'create', 'OPP-1'))), 'refused: assetLink from a client (unchanged)');
check(!(await tryWrite(canon('fund', 'archive', 'F1'), body('fund', 'archive', 'F1'))), 'refused: fund/archive from a client (server-only, unchanged)');

// 3) The collision pair from the review. `-` inside `action` made two different events derive one id:
//    (action="create", relatedId="x-y") and (action="create-x", relatedId="y") both give "capitalCall-create-x-y".
//    Harm: whoever writes the free-text variant FIRST makes the genuine event un-loggable (rejected as an "update").
const ambiguousId = canon('capitalCall', 'create-x', 'y');
check(ambiguousId === canon('capitalCall', 'create', 'x-y'), 'precondition: both events derive the same id string (the ambiguity is real)');
check(!(await tryWrite(ambiguousId, body('capitalCall', 'create-x', 'y'))), 'refused: (action="create-x", relatedId="y") cannot be written first');
check(await tryWrite(canon('capitalCall', 'create', 'x-y'), body('capitalCall', 'create', 'x-y')), 'the genuine event (action="create", relatedId="x-y") is still loggable afterwards');

// 4) Injectivity over everything the rules now accept: no two different (type, action, relatedId) share an id.
const rids = ['CC1', 'x-y', 'y', 'x', 'CC-EXEC-K1', 'a-b', 'b', 'k-1', '1', 'create-1', 'approve-CC1', 'post-x-y', '-', 'a--b'];
const seen = new Map(); let collisions = 0;
for (const [type, action] of PAIRS.map(([t, a]) => [t, a])) for (const rid of rids) {
  const id = canon(type, action, rid), key = JSON.stringify([type, action, rid]);
  if (seen.has(id) && seen.get(id) !== key) { collisions++; console.error('collision', id, seen.get(id), key); }
  seen.set(id, key);
}
const ALLOWED = [...new Set(PAIRS.map(([t, a]) => `${t}\u0000${a}`))].map(s => s.split('\u0000'));
check(ALLOWED.every(([t, a]) => !t.includes('-') && !a.includes('-')), "allowed type and action tokens contain no '-', so splitting the id at the first two '-' recovers (type, action, relatedId) uniquely");
check(collisions === 0, `no id collisions among ${PAIRS.length} allowed (type, action) pairs x ${rids.length} relatedIds`);

// 5) Unchanged guarantees: non-canonical id, duplicate event, and update/delete are still refused.
check(!(await tryWrite('TXN-ARBITRARY', body('capitalCall', 'create', 'CC1'))), 'refused: non-canonical id');
check(!(await tryWrite(canon('capitalCall', 'create', 'CC1'), body('capitalCall', 'create', 'CC1'))), 'refused: second write of an already-logged event (same canonical id)');

await env.cleanup();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
