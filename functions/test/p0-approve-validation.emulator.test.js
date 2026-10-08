'use strict';
/* Phase 3A-3 — end-to-end checks against the REAL Firestore emulator (real transactions, real stored values).
   What the fakes cannot prove:
     1) a save that lands between preview and approval aborts the approval (DOC_CHANGED) — also when the two
        calls really race;
     2) values Firestore itself can store (NaN, Infinity) are refused, never approved;
     3) a red (INVALID/INCOMPLETE) opportunity can never be approved, with or without override, and nothing is written;
     4) the compound-warnings acknowledgement is enforced and recorded;
     5) getApprovalPreview returns the hash that approveOpportunity then accepts.
   Run (from tests/rules):  npm run test:emulator   — or directly:
     firebase emulators:exec --only firestore --project demo-test --config tests/rules/firebase.json \
       "node functions/test/p0-approve-validation.emulator.test.js" */
const assert = require('node:assert/strict');
const { loadIndexAgainstRealEmulator } = require('./load-index-with-real-emulator');
const { loadEngine, documentHash } = require('../trusted-ic.cjs');

const EMAIL = 'ic-validation@example.com';
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`OK ${name}`); }
const clone = x => JSON.parse(JSON.stringify(x));

async function readyFixture() {
  const engine = await loadEngine();
  const o = engine.withDefaults({});
  Object.assign(o.meta, { name: 'Ready Development (validation emulator)', city: 'Riyadh', neighborhood: 'Test', analyst: 'Analyst', oppType: 'development', tier: 'متوسط', useType: '__neutral__' });
  for (const k of ['soil', 'water', 'tower', 'topo', 'infra']) o.site[k] = 1;
  Object.assign(o.land, { area: 5000, price: 2000, far: 2, bar: 0.5, setbacks: 0.15, floorsAllowed: 10, floorHeight: 3.6 });
  Object.assign(o.development, { salePrice: 9000, buildCost: 3000, efficiency: 0.85, contingency: 0.05, constructionYears: 2, operationYears: 1, scopeType: 'both', exitCapRate: 0.08 });
  o.strategy.salePct = 1;
  Object.assign(o.financing, { ltc: 0.5, saibor: 0.05, margin: 0.02 });
  o.regulatory.offeringType = 'private';
  Object.assign(o.criteria, { irrMin: 0.05, projIrrMin: -1, moicMin: 0, dscrMin: null });
  const { defaultItemsDict } = await import('../generated/src/domain/due-diligence/dd-engine.js');
  o.dd = { items: defaultItemsDict() };
  Object.values(o.dd.items).forEach(it => { it.status = 'completed'; it.severity = 'medium'; });
  const { KEY_FIELDS } = await import('../generated/src/domain/evidence/evidence-engine.js');
  o.evidence = {};
  for (const f of KEY_FIELDS.filter(f => !f.appliesTo || f.appliesTo === 'development')) {
    o.evidence[f.path] = { source: 'test-source', tier: 'tier1', confidence: 'high', verifiedBy: EMAIL, date: '2099-01-01' };
  }
  return o;
}

(async () => {
  const { fns, db } = loadIndexAgainstRealEmulator();
  const ready = await readyFixture();
  await Promise.all([
    db.collection('team_members').doc(EMAIL).set({ expiresAt: null }),
    db.collection('team_roles').doc(EMAIL).set({ role: 'senior_ic' }),
  ]);
  let seq = 0;
  const call = (data) => fns.approveOpportunity({ auth: { token: { email: EMAIL } }, data: { requestId: 'EMU-' + (++seq) + '-' + Date.now(), decision: { decision: 'approve' }, ...data } });
  const preview = (oppId) => fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: { oppId } });
  const put = (id, doc) => db.collection('opportunities').doc(id).set(doc);
  const stored = async (id) => (await db.collection('opportunities').doc(id).get()).data();
  const decisionCount = async (id) => (await db.collection('icDecisions').where('oppId', '==', id).get()).size;
  const rejection = (e, code, rej) => e.code === code && (!rej || (e.details && e.details.rejectionCode === rej));

  await test('preview hash is accepted by the approval (round trip on real Firestore)', async () => {
    await put('V1', clone(ready));
    const p = await preview('V1');
    assert.match(p.docHash, /^[0-9a-f]{64}$/);
    assert.equal(p.verdict.color, 'green');
    assert.equal(p.docHash, documentHash(await stored('V1')), 'server hash equals the hash of the stored document');
    const r = await call({ oppId: 'V1', expectedDocHash: p.docHash });
    assert.equal(r.ok, true);
    assert.equal(await decisionCount('V1'), 1);
  });

  await test('a save between preview and approval aborts the approval (DOC_CHANGED) and writes nothing', async () => {
    await put('V2', clone(ready));
    const p = await preview('V2');
    const edited = clone(ready); edited.meta.notes = 'edited after the preview';
    await put('V2', edited);
    await assert.rejects(call({ oppId: 'V2', expectedDocHash: p.docHash }), e => rejection(e, 'failed-precondition', 'DOC_CHANGED'));
    assert.equal(await decisionCount('V2'), 0);
    const p2 = await preview('V2');
    assert.notEqual(p2.docHash, p.docHash);
    assert.equal((await call({ oppId: 'V2', expectedDocHash: p2.docHash })).ok, true, 'a fresh preview can be approved');
  });

  await test('a save racing the approval: either the approval wins on the reviewed document or it is refused — never a decision on unseen data', async () => {
    for (let i = 0; i < 5; i++) {
      const id = 'V3-' + i;
      await put(id, clone(ready));
      const p = await preview(id);
      const edited = clone(ready); edited.land.price = 2000 + i + 1;
      const [a, w] = await Promise.allSettled([call({ oppId: id, expectedDocHash: p.docHash }), put(id, edited)]);
      assert.equal(w.status, 'fulfilled');
      const finalDoc = await stored(id);
      const n = await decisionCount(id);
      if (a.status === 'fulfilled') {
        assert.equal(n, 1);
        // The approval committed: the recorded hash must be the hash of the document that was reviewed.
        const dec = (await db.collection('icDecisions').where('oppId', '==', id).get()).docs[0].data();
        assert.equal(dec.decision.docHash, p.docHash, 'the recorded decision is bound to the reviewed document');
      } else {
        assert.ok(rejection(a.reason, 'failed-precondition', 'DOC_CHANGED'), 'refused only because the document changed');
        assert.equal(n, 0);
      }
      assert.equal(finalDoc.land.price, 2000 + i + 1);
    }
  });

  await test('NaN / Infinity stored in Firestore is refused (never approved) with a figure-free code', async () => {
    for (const [i, bad] of [NaN, Infinity, -Infinity].entries()) {
      const id = 'V4-' + i;
      const doc = clone(ready); doc.land.price = bad;
      await put(id, doc);
      const hash = documentHash(await stored(id));
      await assert.rejects(call({ oppId: id, expectedDocHash: hash }), e => e.code === 'failed-precondition' && e.details && ['NON_FINITE_INPUT', 'INPUTS_BLOCKED'].includes(e.details.rejectionCode));
      assert.equal(await decisionCount(id), 0);
    }
  });

  await test('red inputs never approve — not even with override — and leave no partial write', async () => {
    const cases = {
      'V5-tiny-ltc-text': d => { d.financing.ltc = '0.5'; },
      'V5-huge-price': d => { d.land.price = 1e15; },
      'V5-negative-area': d => { d.land.area = -5; },
      'V5-dscr-forged': d => { d.criteria.dscrMin = -5; },
    };
    for (const [id, mut] of Object.entries(cases)) {
      const d = clone(ready); mut(d); await put(id, d);
      const hash = documentHash(await stored(id));
      await assert.rejects(call({ oppId: id, expectedDocHash: hash, override: true, reasons: ['I know what I am doing'] }),
        e => e.code === 'failed-precondition', id);
      assert.equal(await decisionCount(id), 0, id);
      assert.equal((await stored(id)).ic, undefined, id);
    }
  });

  await test('compound warnings need a written acknowledgement, which is then recorded', async () => {
    // Four financial high-risk reasons together (same flags as the fakes suite); criteria loosened to isolate the risk logic.
    const d = clone(ready); Object.assign(d.criteria, { irrMin: -1, projIrrMin: -1, moicMin: 0, dscrMin: null });
    Object.assign(d.financing, { ltc: 0.9, saibor: 0.25 }); d.development.exitCapRate = 0.25; d.development.constructionYears = 12;
    await put('V6', d);
    const p = await preview('V6');
    assert.equal(p.verdict.compound.requiresAcknowledgement, true, 'the fixture must reach the compound threshold');
    assert.equal(p.verdict.color, 'yellow');
    await assert.rejects(call({ oppId: 'V6', expectedDocHash: p.docHash }), e => rejection(e, 'failed-precondition', 'WARNINGS_ACK_REQUIRED'));
    await assert.rejects(call({ oppId: 'V6', expectedDocHash: p.docHash, warningsAcknowledged: true }), e => rejection(e, 'failed-precondition', 'WARNINGS_ACK_REQUIRED'), 'ack without a written reason is not enough');
    const r = await call({ oppId: 'V6', expectedDocHash: p.docHash, warningsAcknowledged: true, reasons: ['Risks reviewed and accepted by the committee'] });
    assert.equal(r.ok, true);
    const dec = (await db.collection('icDecisions').where('oppId', '==', 'V6').get()).docs[0].data();
    assert.equal(dec.decision.warningsAcknowledged, true);
    assert.equal(dec.decision.validation.color, 'yellow');
    assert.ok(dec.decision.validation.compound.count >= 2);
  });

  await test('key attacks are rejected end-to-end (extra field, forged label, prototype keys)', async () => {
    await put('V7', clone(ready));
    const hash = documentHash(await stored('V7'));
    await assert.rejects(call({ oppId: 'V7', expectedDocHash: hash, color: 'green' }), e => rejection(e, 'invalid-argument', 'UNEXPECTED_FIELD'));
    await assert.rejects(call({ oppId: 'V7', expectedDocHash: hash, readiness: { ready: true } }), e => rejection(e, 'invalid-argument', 'UNEXPECTED_FIELD'));
    const evil = JSON.parse('{"oppId":"V7","decision":{"decision":"approve"},"requestId":"EMU-evil","expectedDocHash":"' + hash + '","__proto__":{"x":1}}');
    await assert.rejects(fns.approveOpportunity({ auth: { token: { email: EMAIL } }, data: evil }), e => rejection(e, 'invalid-argument', 'UNSAFE_KEY'));
    assert.equal(await decisionCount('V7'), 0);
  });

  await test('lost reply: the SAME requestId replayed after a successful approval returns the original result even though docHash changed; a different payload under that requestId is refused', async () => {
    const id = 'V8', RID = 'EMU-LOST-REPLY-1';
    const versions = async () => (await db.collection('underwritingVersions').where('oppId', '==', id).get()).size;
    await put(id, clone(ready));
    const p = await preview(id);
    const original = { oppId: id, requestId: RID, expectedDocHash: p.docHash, reasons: ['ok'] };
    const first = await call(original);                       // the server commits; the reply is "lost" (discarded)
    assert.equal(first.ok, true);
    assert.equal(await decisionCount(id), 1);
    const hashAfterApproval = documentHash(await stored(id));
    assert.notEqual(hashAfterApproval, p.docHash, 'the approval itself changed the stored document (ic was written)');
    const edited = await stored(id); edited.meta.notes = 'edited after the lost reply'; await put(id, edited);   // a further save
    assert.notEqual(documentHash(await stored(id)), hashAfterApproval, 'docHash changed again');
    const counts = { d: await decisionCount(id), v: await versions() };
    const replay = await call(original);                      // the client retries the identical request
    assert.deepEqual(replay, first, 'idempotent replay returns the ORIGINAL result');
    assert.equal(await decisionCount(id), counts.d, 'no second decision');
    assert.equal(await versions(), counts.v, 'no second underwriting version');
    // same requestId, different reviewed hash (what a refreshed preview would send) is a different payload, not a replay
    const fresh = await preview(id);
    await assert.rejects(call({ ...original, expectedDocHash: fresh.docHash }), e => e.code === 'already-exists');
    assert.equal(await decisionCount(id), counts.d, 'refusal wrote nothing');
    // documented behaviour: a NEW requestId with a fresh preview is a deliberate second decision (not blocked by the server)
    const second = await call({ oppId: id, expectedDocHash: fresh.docHash, reasons: ['second decision'] });
    assert.equal(second.ok, true);
    assert.equal(await decisionCount(id), counts.d + 1, 'a new requestId is a new decision');
  });

  await test('getApprovalPreview binds to the DISPLAYED version: displayedMatches is true only for the same stored document; malformed hashes are refused', async () => {
    const id = 'V9';
    const call2 = (data) => fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data });
    await put(id, clone(ready));
    const p0 = await preview(id);
    assert.equal(p0.displayedMatches, null, 'no hash sent -> null (not a false positive)');
    const ok = await call2({ oppId: id, displayedDocHash: p0.docHash });
    assert.equal(ok.displayedMatches, true);
    // two financially different but equally green documents have different hashes: the displayed one must not match the stored one
    const other = clone(ready); other.development.salePrice = 9500;
    const otherHash = documentHash(other);
    assert.notEqual(otherHash, p0.docHash);
    const mismatch = await call2({ oppId: id, displayedDocHash: otherHash });
    assert.equal(mismatch.displayedMatches, false);
    assert.equal(mismatch.verdict.color, 'green', 'the stored document is green too — only the hash binding tells them apart');
    assert.equal(mismatch.docHash, p0.docHash);
    // a change that does not alter the verdict (a note) still breaks the binding
    const noted = clone(ready); noted.meta.notes = 'only a note'; await put(id, noted);
    const afterNote = await call2({ oppId: id, displayedDocHash: p0.docHash });
    assert.equal(afterNote.displayedMatches, false);
    assert.equal(afterNote.verdict.color, 'green');
    for (const bad of ['', 'abc', 'A'.repeat(64), p0.docHash.slice(1), 123, null, {}, [p0.docHash]]) {
      await assert.rejects(call2({ oppId: id, displayedDocHash: bad }), e => e.code === 'invalid-argument', 'rejects ' + JSON.stringify(bad));
    }
    await assert.rejects(call2({ oppId: id, displayedDocHash: p0.docHash, extra: 1 }), e => e.code === 'invalid-argument');
  });

  console.log(`\n${passed}/${passed} validation emulator tests passed (real Firestore emulator).`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
