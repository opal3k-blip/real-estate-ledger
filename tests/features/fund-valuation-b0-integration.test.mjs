// R1-B2 / B2-2b-b0 — INTEGRATION: the REAL reader (refresh/read marker) + the REAL actions orchestrator + the fake server.
// What it proves: the order evidence the orchestrator relies on is the one the reader really produces (not a hand-built marker).
import assert from 'node:assert/strict';
import { createFundValuationReader } from '../../src/features/fund-valuation-reader.js';
import * as E from '../../src/features/fund-valuation-editor.js';
import { makeEnv, goodContent, tick, FM, FUND } from '../helpers/fund-valuation-server-fake.mjs';
import { makeFakeSubscribe } from '../helpers/fund-valuation-fakes.mjs';

let passed = 0; let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}`); if (!process.env.CONTINUE_ON_FAIL) throw e; console.error(`      ${String(e.stack).split('\n').slice(0, 3).join(' | ')}`); } }

const PROPOSAL = E.makeLinkProposal({ fundId: FUND, assetIds: ['A1', 'A2'], source: E.LINK_SOURCES.BROWSER_FUND_DATA });
const FILL = [
  ['components.assetsValue', '900'], ['components.cashRetained', '200'], ['components.otherAssets', '50'], ['components.liabilities', '150'], ['components.distributionsPayable', '0'],
  ['residualValue', '1000'], ['method', 'appraisal'], ['methodNote', 'external appraisal'], ['source.ref', 'APP-1'], ['source.provider', 'Valuer Co'],
  ['nonOverlap.cashNotInAssets', true], ['nonOverlap.otherAssetsNotInAssets', true], ['nonOverlap.assetsStatedGrossOfLiabilities', true],
  ['coverage.unlinkedHoldings.declared', 'none'],
];
function fill(a) {
  for (const [p, v] of FILL) assert.equal(a.setField(p, v).status, 'ok', p);
  assert.equal(a.addItem('otherAssetsItems').status, 'ok');
  a.setField('otherAssetsItems.0.description', 'receivable'); a.setField('otherAssetsItems.0.amount', '50');
  assert.equal(a.confirmLinks().status, 'ok');
}
const clone = (v) => JSON.parse(JSON.stringify(v));

/** real reader + real actions on one fake server. The network is held by the test: every fetch waits for `release`. */
function rig({ session = FM } = {}) {
  const env = makeEnv({ session, linkProposal: PROPOSAL });
  const fake = makeFakeSubscribe();
  const net = { calls: [], auto: false, mode: 'call' };
  const snapshot = () => {
    const heads = []; const valuations = [];
    for (const doc of env.server.vals.values()) {
      valuations.push({ id: doc.valuationId, data: clone(doc) });
      if (env.server.slotId(doc.fundId, doc.valuationDate) === doc.valuationId) heads.push({ id: `${doc.fundId}__${doc.valuationDate}`, data: { fundId: doc.fundId, valuationDate: doc.valuationDate, headId: null, version: 0, headHash: null, eligibility: null, activeDraftId: doc.valuationId, rev: 1 } });
    }
    return { heads, valuations };
  };
  const fetchOnce = (source, fundId) => new Promise((resolve, reject) => {
    const c = { source, fundId, at: snapshot(), resolve, reject, done: false };
    net.calls.push(c);
    if (net.auto) { c.done = true; resolve({ docs: c.at[source], fromCache: false }); }
  });
  /** deliver one queued fetch: with the server state as of NOW, or as of when it was issued */
  net.release = (i, { asOf = 'call', fromCache = false } = {}) => { const c = net.calls[i]; c.done = true; c.resolve({ docs: (asOf === 'now' ? snapshot() : c.at)[c.source], fromCache }); };
  net.fail = (i, err) => { const c = net.calls[i]; c.done = true; c.reject(err); };
  net.releaseRead = (k, o) => { net.release(2 * k, o); net.release(2 * k + 1, o); };
  const reader = createFundValuationReader({ subscribe: fake.subscribe, getSession: () => env.box.s, onChange: () => env.actions.sync(), fetchOnce });
  env.hooks.getContext = (d) => { const c = reader.contextFor(d === undefined ? '2026-10-11' : d); return c ? { ...c, linkProposal: PROPOSAL } : null; };
  env.hooks.refreshView = () => reader.refresh();
  /** a listener snapshot (what onSnapshot delivers) with the server's state as of now */
  const listen = async ({ fromCache = false } = {}) => { const s = snapshot(); fake.emit('heads', FUND, s.heads, fromCache); fake.emit('valuations', FUND, s.valuations, fromCache); fake.emit('events', FUND, [], fromCache); await tick(); };
  return { env, fake, net, reader, listen, snapshot };
}
async function started() {
  const r = rig(); r.reader.open(FUND); await r.listen();
  assert.equal(r.env.actions.startCreate().status, 'started'); fill(r.env.actions);
  const res = await r.env.actions.save(); assert.equal(res.status, 'success_waiting_view', JSON.stringify(res));
  return r;
}
/** a created draft that the view has caught up on, ready for an update */
async function withDraft() {
  const r = await started();
  r.net.releaseRead(0, { asOf: 'now' }); await tick();                       // the read the success asked for
  assert.equal(r.env.actions.getState().awaiting, null, 'create reflected');
  r.net.calls.length = 0;
  return r;
}
const id0 = (r) => r.env.server.slotId(FUND, '2026-10-11');
const waiting = (r, action) => { const a = r.env.actions.getState().awaiting; assert.ok(a, 'still awaiting'); assert.equal(a.action, action); assert.notEqual(r.env.actions.getState().outcome.status, 'view_overtaken'); };
const reads = (r) => r.net.calls.length / 2;

console.log('— B2-2b/b0 integration: real reader + real actions —');

await t('I1. the success asks for a read; the read that started AFTER the reply and shows our effect ends the wait as reflected', async () => {
  const r = await started();
  assert.equal(reads(r), 1, 'exactly one read asked for by the success'); waiting(r, 'createDraft');
  r.net.releaseRead(0, { asOf: 'now' }); await tick();
  assert.equal(r.env.actions.getState().awaiting, null); assert.equal(r.env.actions.getState().outcome.status, 'reflected');
  assert.equal(r.reader.getView().read.epoch, 1);
});
await t('I2. a later change by someone else, seen by the read that started after the reply: view_overtaken (a verdict only that read may give)', async () => {
  const r = await withDraft(); r.env.actions.setField('methodNote', 'mine'); await r.env.actions.save(); waiting(r, 'updateDraft');
  await r.env.server.externalEdit(id0(r), { ...goodContent(), methodNote: 'later' });
  r.net.releaseRead(0, { asOf: 'now' }); await tick();
  assert.equal(r.env.actions.getState().awaiting, null); assert.equal(r.env.actions.getState().outcome.status, 'view_overtaken');
});
await t('I3. THE CASE: a read that STARTED BEFORE the reply returns old data AFTER the reply and AFTER another person\'s edit: it must not decide', async () => {
  const r = await withDraft();
  const early = r.reader.refresh();                                          // read #2 starts now, before our update
  await tick(); assert.equal(reads(r), 1);
  r.env.actions.setField('methodNote', 'mine'); await r.env.actions.save();  // reply arrives; the success asks read #3
  assert.equal(reads(r), 2);
  await r.env.server.externalEdit(id0(r), { ...goodContent(), methodNote: 'later' });
  r.net.releaseRead(0);                                                      // read #2 answers with the state as of ITS start (before our update)
  await early; await tick();
  assert.equal(r.reader.getView().read.lastResult.reason, 'SUPERSEDED_BY_NEWER_ISSUE', 'read 3 was issued after the reply: read 2 may not apply any more');
  assert.equal(r.reader.getView().read.epoch, 1, 'the shown data still comes from the earlier applied read');
  assert.ok(r.reader.getView().read.issued >= 3, 'issued is a different number: reads started so far');
  waiting(r, 'updateDraft');                                                  // read 2 started before the reply: no verdict
  r.net.releaseRead(1, { asOf: 'now' }); await tick();                       // read #3 started after the reply
  assert.equal(r.env.actions.getState().outcome.status, 'view_overtaken');
});
await t('I3b. an old read that returns the state from before our update is simply not a proof either: no release, no false "reflected"', async () => {
  const r = await withDraft();
  const early = r.reader.refresh(); r.env.actions.setField('methodNote', 'mine'); await r.env.actions.save();
  r.net.releaseRead(0); await early; await tick();
  waiting(r, 'updateDraft'); assert.equal(r.env.actions.getState().outcome.status !== 'reflected', true);
  r.net.releaseRead(1, { asOf: 'now' }); await tick(); assert.equal(r.env.actions.getState().outcome.status, 'reflected');
});
await t('I4. the refresh start is delayed (the read is not issued until later): nothing is decided in the meantime, and a late start still counts as AFTER', async () => {
  const r = await withDraft(); r.env.actions.setField('methodNote', 'mine');
  const hooked = r.env.hooks.refreshView; let deferred = null; r.env.hooks.refreshView = () => { deferred = () => hooked(); };   // the refresh request is held back
  await r.env.actions.save(); waiting(r, 'updateDraft'); assert.equal(reads(r), 0);
  await r.env.server.externalEdit(id0(r), { ...goodContent(), methodNote: 'later' });
  await r.listen(); waiting(r, 'updateDraft');                                // listener data (a later state): no order proof
  deferred(); await tick(); assert.equal(reads(r), 1); r.net.releaseRead(0, { asOf: 'now' }); await tick();   // the late start still counts as after the reply
  assert.equal(r.env.actions.getState().outcome.status, 'view_overtaken');
});
await t('I5. the refresh fails (offline): the wait stays, data on screen stays and is not decided on; a later successful read decides', async () => {
  const r = await withDraft(); r.env.actions.setField('methodNote', 'mine'); await r.env.actions.save();
  const e = new Error('offline'); e.code = 'unavailable'; r.net.fail(0, e); r.net.fail(1, e); await tick();
  waiting(r, 'updateDraft'); assert.equal(r.reader.getView().read.lastResult.ok, false); assert.ok(r.reader.getView().draft, 'data still shown');
  const again = r.reader.refresh(); void again; await tick(); r.net.releaseRead(1, { asOf: 'now' }); await tick();
  assert.equal(r.env.actions.getState().outcome.status, 'reflected');
});
await t('I6. a listener snapshot after the reply (with our effect) is not order evidence: identity may release, order may not; the epoch goes back to null', async () => {
  const r = await withDraft(); r.env.actions.setField('methodNote', 'mine'); await r.env.actions.save();
  await r.env.server.externalEdit(id0(r), { ...goodContent(), methodNote: 'later' });
  await r.listen();
  assert.equal(r.reader.getView().read.epoch, null); waiting(r, 'updateDraft');       // the listener shows a LATER state, but cannot prove it is after
  r.net.releaseRead(0, { asOf: 'now' }); await tick();                       // the read in flight across the listener snapshot is dropped
  assert.equal(r.reader.getView().read.lastResult.reason, 'SUPERSEDED_BY_LISTENER'); waiting(r, 'updateDraft');
  void r.reader.refresh(); r.net.releaseRead(1, { asOf: 'now' }); await tick();      // a read that starts now decides
  assert.equal(r.env.actions.getState().outcome.status, 'view_overtaken');
});
await t('I7. a read that straddles a listener snapshot is dropped by the reader: the wait goes on, no verdict from it', async () => {
  const r = await started(); await r.listen(); r.net.releaseRead(0, { asOf: 'now' }); await tick();
  assert.equal(r.reader.getView().read.lastResult.reason, 'SUPERSEDED_BY_LISTENER');
  assert.equal(r.reader.getView().read.epoch, null);
});
await t('I8. two gets that disagree (head names a draft the valuations lack): not applied, the block stays', async () => {
  const r = await started();
  r.net.release(0, { asOf: 'now' });                                          // heads: with our draft
  const early = { docs: [], fromCache: false }; r.net.calls[1].done = true; r.net.calls[1].resolve(early); await tick();   // valuations: from before the write
  assert.equal(r.reader.getView().read.lastResult.reason, 'HEAD_DRAFT_MISSING'); assert.equal(r.reader.getView().read.epoch, null);
  waiting(r, 'createDraft');
});
await t('I9. permission-denied on a read: data and awaiting context vanish at once, listeners stop, no retry loop', async () => {
  const r = await started(); const e = new Error('denied'); e.code = 'permission-denied';
  r.net.fail(0, e); r.net.fail(1, e); await tick();
  assert.equal(r.reader.stats().live, 0); assert.equal(r.reader.stats().heldDocs, 0); assert.equal(r.reader.getView().draft, null);
  const n = r.net.calls.length; await tick(); assert.equal(r.net.calls.length, n);
});
await t('I10. the session changes (user switch) while a read is in flight: the late reply shows nothing of the old user', async () => {
  const r = await started(); r.env.setSession({ uid: 'u9', email: 'fm2@example.com', role: 'fund_manager', roleResolved: true }); r.reader.sync(); await tick();
  r.net.releaseRead(0, { asOf: 'now' }); await tick();
  assert.equal(r.reader.stats().heldDocs, 0); assert.equal(r.reader.getView().draft, null);
});
await t('I11. a read answered from cache is not a server read: no stamp, no verdict', async () => {
  const r = await started(); r.net.releaseRead(0, { asOf: 'now', fromCache: true }); await tick();
  assert.equal(r.reader.getView().read.lastResult.reason, 'FROM_CACHE'); waiting(r, 'createDraft');
});
await t('I12. after a confirmed read, a FAILED refresh keeps the data on screen but the actions are NOT enabled (VIEW_NOT_CONFIRMED); the next good read re-enables them', async () => {
  const r = await withDraft(); r.env.actions.setField('methodNote', 'x');
  assert.notEqual(r.env.actions.canStart('updateDraft').reason, 'VIEW_NOT_CONFIRMED'); assert.equal(r.reader.getView().read.confirmed, true);
  void r.reader.refresh(); const e = new Error('offline'); e.code = 'unavailable'; r.net.fail(0, e); r.net.fail(1, e); await tick();
  assert.ok(r.reader.getView().draft, 'still shown'); assert.equal(r.reader.getView().stale, true); assert.equal(r.reader.getView().read.confirmed, false);
  assert.equal(r.env.actions.canStart('updateDraft').reason, 'VIEW_NOT_CONFIRMED');
  void r.reader.refresh(); r.net.releaseRead(1, { asOf: 'now' }); await tick(); assert.notEqual(r.env.actions.canStart('updateDraft').reason, 'VIEW_NOT_CONFIRMED');
});
await t('I12b. ... the same for an inconsistent pair after a confirmed read', async () => {
  const r = await withDraft(); void r.reader.refresh();
  r.net.release(0, { asOf: 'now' }); r.net.calls[1].done = true; r.net.calls[1].resolve({ docs: [], fromCache: false }); await tick();   // heads name the draft, valuations lack it
  assert.equal(r.reader.getView().read.lastResult.reason, 'HEAD_DRAFT_MISSING'); assert.equal(r.reader.getView().read.confirmed, false); assert.equal(r.env.actions.canStart('updateDraft').reason, 'VIEW_NOT_CONFIRMED');
});
await t('I13. refusal behind a connection error: heads `unavailable`, then valuations `permission-denied`: data gone at once, nothing enabled', async () => {
  const r = await started(); const u = new Error('offline'); u.code = 'unavailable'; const d = new Error('no'); d.code = 'permission-denied';
  r.net.fail(0, u); r.net.fail(1, d); await tick();
  assert.equal(r.reader.stats().live, 0); assert.equal(r.reader.stats().heldDocs, 0); assert.equal(r.reader.getView().draft, null); assert.equal(r.reader.getView().status, 'denied');
  assert.equal(r.env.actions.canStart('updateDraft').allowed, false);
});


await t('I14. one get of the current read fails, the other stays PENDING: the confirmation is gone at once and the actions are not enabled (VIEW_NOT_CONFIRMED)', async () => {
  const r = await withDraft(); r.env.actions.setField('methodNote', 'x');
  assert.notEqual(r.env.actions.canStart('updateDraft').reason, 'VIEW_NOT_CONFIRMED'); assert.equal(r.reader.getView().read.confirmed, true);
  void r.reader.refresh(); const e = new Error('offline'); e.code = 'unavailable'; r.net.fail(0, e); await tick();      // call 1 never answers
  assert.equal(r.reader.getView().read.inFlight, 1); assert.equal(r.reader.getView().read.confirmed, false); assert.equal(r.reader.getView().stale, true); assert.ok(r.reader.getView().draft, 'still shown');
  assert.equal(r.env.actions.canStart('updateDraft').reason, 'VIEW_NOT_CONFIRMED');
});
await t('I14b. after reset + a new session an old pending read does not hold inFlight for the new user', async () => {
  const r = await withDraft(); void r.reader.refresh(); assert.equal(r.reader.getView().read.inFlight, 1);
  r.reader.reset(); r.reader.open(FUND); await r.listen(); assert.equal(r.reader.getView().read.inFlight, 0);
});


console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
