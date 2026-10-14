/* Phase 3A-3 — client wiring of the IC approval to the server contract.
   Run: node tests/features/ic-workflow-approval.test.mjs   (exit 0 only if all pass)
   Fake core + fake firebase callable. Proves the browser:
     - fetches getApprovalPreview and shows red / acknowledgement UI from the SERVER verdict;
     - never calls approveOpportunity while the preview is loading/failed or the verdict is red;
     - sends expectedDocHash + warningsAcknowledged (real booleans) and nothing else outside the whitelist;
     - re-fetches the preview when the opportunity changes in the UI (no stale hash is reused);
     - after DOC_CHANGED forces a fresh preview; the demo/local path applies the same shared classification. */
import assert from 'assert/strict';
import { createRequire } from 'module';
import { loadCore } from '../domain/core-vm-harness.mjs';
import { registerICWorkflow as registerICWorkflowStatic, icRequestPayloadSignature } from '../../src/features/ic-workflow.js';

const { documentHash } = createRequire(import.meta.url)('../../functions/trusted-ic.cjs'); // the SERVER's hash, used by the fake server
// A fresh module instance = a page reload (the pending-request map is read from localStorage at import time).
let instanceSeq = 0;
async function freshRegister(mem) {
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const m = await import('../../src/features/ic-workflow.js?instance=' + (++instanceSeq));
  return m.registerICWorkflow;
}

let passed = 0, failed = 0;
// Sequential: the tests share globals (alert, firebase, document).
let chain = Promise.resolve();
const pending = [];
// After each test we wait briefly: async previews started by one test must not leak into the next test's fake server.
function check(name, fn) {
  chain = chain.then(() => Promise.resolve().then(fn).then(() => new Promise((r) => setTimeout(r, 40))).then(() => { passed += 1; console.log('PASS  ' + name); },
    (e) => { failed += 1; console.log('FAIL  ' + name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')); }));
  pending.push(chain);
}
const clone = (o) => JSON.parse(JSON.stringify(o));
function set(o, p, v) { const a = p.split('.'); let x = o; for (let i = 0; i < a.length - 1; i++) x = x[a[i]]; x[a.at(-1)] = v; }
const tick = () => new Promise((r) => setTimeout(r, 25)); // the displayed hash is a real async WebCrypto digest

const C0 = loadCore(['opportunities']);
function sane() {
  const o = clone(C0.blankOpportunity());
  set(o, 'meta.oppType', 'development'); set(o, 'meta.tier', 'متوسط'); set(o, 'meta.useType', '__neutral__');
  for (const k of ['soil', 'water', 'tower', 'topo', 'infra']) set(o, 'site.' + k, 1);
  set(o, 'land.floorHeight', 3.6); set(o, 'land.area', 5000); set(o, 'land.price', 2000);
  set(o, 'land.far', 2); set(o, 'land.bar', 0.5); set(o, 'land.basements', 0);
  set(o, 'development.buildCost', 3000); set(o, 'development.salePrice', 9000);
  set(o, 'development.efficiency', 0.85); set(o, 'development.contingency', 0.05);
  set(o, 'development.constructionYears', 2); set(o, 'development.operationYears', 0);
  set(o, 'development.scopeType', 'both'); set(o, 'strategy.salePct', 1);
  set(o, 'financing.ltc', 0.6); set(o, 'financing.saibor', 0.055); set(o, 'financing.margin', 0.025);
  set(o, 'financing.interestDuringConstruction', 'cash');
  return o;
}
const HASH_A = 'a'.repeat(64), HASH_B = 'b'.repeat(64);
const GREEN = { status: 'OK', color: 'green', blocked: false, compound: { count: 0, threshold: 2, requiresAcknowledgement: false } };
const RED = { status: 'INVALID', color: 'red', blocked: true, compound: { count: 0, threshold: 2, requiresAcknowledgement: false } };
const YELLOW2 = { status: 'WARNINGS', color: 'yellow', blocked: false, compound: { count: 2, threshold: 2, requiresAcknowledgement: true } };

function setup({ demo = false, previews = [{ verdict: GREEN }], approve, mem = new Map(), register = registerICWorkflowStatic } = {}) {
  let serverDoc = null; // what the fake SERVER has stored for O1 (defaults to whatever setOpp last displayed)
  const calls = []; const alerts = []; const saved = [];
  let previewIdx = 0;
  globalThis.alert = (m) => alerts.push(String(m));
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.firebase = {
    functions: () => ({
      httpsCallable: (name) => async (payload) => {
        calls.push({ name, payload: clone(payload) });
        if (name === 'getApprovalPreview') {
          const p = previews[Math.min(previewIdx++, previews.length - 1)];
          if (p instanceof Error) throw p;
          const docHash = documentHash(p.doc || serverDoc);          // the server hashes ITS stored document
          const displayedMatches = payload.displayedDocHash === undefined ? null : payload.displayedDocHash === docHash;
          return { data: { docHash, displayedMatches, verdict: p.verdict, inputHash: 'x', engineVersion: 'v', ready: true, invalidMetrics: [] } };
        }
        if (name === 'approveOpportunity') { if (approve) return approve(payload); return { data: { ok: true, decisionId: 'D1' } }; }
        throw new Error('unexpected callable ' + name);
      },
    }),
  };
  const f = { sections: [], handlers: [], opportunities: [], renders: 0, openDetailId: 'O1' };
  Object.assign(f, {
    T: (a, b) => b, esc: (s) => String(s), LANG: 'en', DEMO_MODE: demo, DB: demo ? null : {}, STORE: {}, ADMIN_EMAILS: ['ic@example.com'],
    currentUser: { email: 'ic@example.com' }, canEditOpp: () => true,
    withDefaults: (x) => { const d = C0.withDefaults(clone(x)); d.ic = d.ic || { decisions: [] }; return d; }, compute: (d) => C0.compute(clone(d)),
    registerOpportunitySchemaExtender() {}, registerDetailSection: (fn) => f.sections.push(fn), registerActionHandler: (fn) => f.handlers.push(fn),
    render: () => { f.renders += 1; }, loadAll: async () => {}, todayStr: () => '2026-10-06', uid: (p) => p + '-1',
    persistOpportunity: async (r) => { saved.push(clone(r)); return true; }, persistIfRecord: async () => true,
  });
  register(f);
  const setOpp = (data, { server = true } = {}) => { f.opportunities = [{ id: 'O1', data: clone(data) }]; if (server) serverDoc = clone(data); };
  const setServer = (data) => { serverDoc = clone(data); };
  const html = () => { const rec = f.opportunities[0]; const d = f.withDefaults(rec.data); return f.sections[0](d, f.compute(d)); };
  let form;
  const setForm = ({ decision = 'approve', reasons = '', override = false, ack = false } = {}) => {
    const fields = { decision: { value: decision }, reasons: { value: reasons }, conditions: { value: '' }, override: { checked: override }, ackWarnings: { checked: ack } };
    form = { querySelector: (sel) => { const m = /\[name="(\w+)"\]/.exec(sel); const el = m && fields[m[1]]; return el || null; } };
    // The real form only renders the override / ack inputs when needed: emulate by hiding what the html did not render.
    const h = html();
    if (!h.includes('name="override"')) fields.override = undefined;
    if (!h.includes('name="ackWarnings"')) fields.ackWarnings = undefined;
  };
  globalThis.document = { querySelector: (sel) => (sel.includes('data-ic-form') ? form : null) };
  const decide = async () => { for (const h of f.handlers) { const r = await h('ic-decide', { dataset: { id: 'O1' } }); if (r) return; } };
  const discard = async ({ ack = true } = {}) => { const el = { dataset: { id: 'O1' }, closest: () => ({ querySelector: () => ({ checked: ack }) }) }; for (const h of f.handlers) { const r = await h('ic-discard-pending', el); if (r) return; } };
  const refresh = async () => { for (const h of f.handlers) { const r = await h('ic-refresh-preview', { dataset: { id: 'O1' } }); if (r) return; } };
  return { f, calls, alerts, saved, setOpp, setServer, html, setForm, decide, discard, refresh, mem };
}
const approveCalls = (t) => t.calls.filter((c) => c.name === 'approveOpportunity');
const previewCalls = (t) => t.calls.filter((c) => c.name === 'getApprovalPreview');

check('rendering the detail fetches the server preview once and shows a loading note until it is ready', async () => {
  const t = setup(); t.setOpp(sane());
  assert.match(t.html(), /Loading the approval preview/); await tick();
  assert.equal(previewCalls(t).length, 1); assert.deepEqual(previewCalls(t)[0].payload, { oppId: 'O1', displayedDocHash: documentHash(sane()) }, 'the preview request carries the hash of the DISPLAYED document');
  assert.doesNotMatch(t.html(), /Loading the approval preview/);
  t.html(); t.html(); await tick(); assert.equal(previewCalls(t).length, 1, 'same document → no refetch');
  assert.ok(t.f.renders >= 1, 'a re-render is requested when the preview arrives');
});
check('approving while the preview is still loading never calls approveOpportunity', async () => {
  const t = setup(); t.setOpp(sane()); t.html(); t.setForm({ override: true, reasons: 'x' });
  await t.decide(); assert.equal(approveCalls(t).length, 0); assert.match(t.alerts.join('|'), /still loading/);
});
check('a failed preview blocks approval with a clear message', async () => {
  const t = setup({ previews: [new Error('network')] }); t.setOpp(sane()); t.html(); await tick();
  assert.match(t.html(), /Could not load the approval preview/);
  t.setForm({ override: true, reasons: 'x' }); await t.decide();
  assert.equal(approveCalls(t).length, 0); assert.match(t.alerts.join('|'), /unavailable/);
});
check('green: approval sends expectedDocHash and warningsAcknowledged=false, and only whitelisted fields', async () => {
  const t = setup(); t.setOpp(sane()); t.html(); await tick();
  t.setForm({ override: true, reasons: 'ok' }); await t.decide();
  const [c] = approveCalls(t); assert.ok(c, 'approve called');
  assert.equal(c.payload.expectedDocHash, documentHash(sane())); assert.equal(c.payload.warningsAcknowledged, false);
  const allowed = new Set(['oppId', 'decision', 'reasons', 'conditions', 'override', 'warningsAcknowledged', 'requestId', 'expectedDocHash']);
  assert.deepEqual(Object.keys(c.payload).filter((k) => !allowed.has(k)), []);
  assert.deepEqual(c.payload.decision, { decision: 'approve' });
});
check('red verdict from the server: red box shown, approval never sent, override cannot bypass', async () => {
  const t = setup({ previews: [{ verdict: RED }] }); t.setOpp(sane()); t.html(); await tick();
  assert.match(t.html(), /data-ic-verdict="red"/);
  t.setForm({ override: true, reasons: 'I accept' }); await t.decide();
  assert.equal(approveCalls(t).length, 0); assert.match(t.alerts.join('|'), /Approval blocked/);
});
check('red does not stop non-approving decisions (reject / hold / revise)', async () => {
  const t = setup({ previews: [{ verdict: RED }] }); t.setOpp(sane()); t.html(); await tick();
  t.setForm({ decision: 'reject', reasons: 'not viable' }); await t.decide();
  const [c] = approveCalls(t); assert.ok(c); assert.equal(c.payload.decision.decision, 'reject'); assert.equal('expectedDocHash' in c.payload, false);
});
check('compound yellow: acknowledgement box is shown; approval needs the box AND a written reason', async () => {
  const t = setup({ previews: [{ verdict: YELLOW2 }] }); t.setOpp(sane()); t.html(); await tick();
  assert.match(t.html(), /name="ackWarnings"/);
  t.setForm({ override: true, reasons: 'why', ack: false }); await t.decide();
  assert.equal(approveCalls(t).length, 0); assert.match(t.alerts.join('|'), /acknowledgement/);
  t.setForm({ override: true, reasons: '', ack: true }); await t.decide();
  assert.equal(approveCalls(t).length, 0, 'ack without a reason is not enough');
  t.setForm({ override: true, reasons: 'Accepted by committee', ack: true }); await t.decide();
  const [c] = approveCalls(t); assert.ok(c); assert.equal(c.payload.warningsAcknowledged, true); assert.equal(c.payload.expectedDocHash, documentHash(sane()));
});
check('green/yellow-below-threshold: no acknowledgement box', async () => {
  const t = setup(); t.setOpp(sane()); t.html(); await tick(); assert.doesNotMatch(t.html(), /name="ackWarnings"/);
});
check('the opportunity changed in the UI → a NEW preview is fetched and the old hash is not reused', async () => {
  const t = setup({ previews: [{ verdict: GREEN }, { verdict: GREEN }] });
  t.setOpp(sane()); t.html(); await tick();
  const changed = sane(); set(changed, 'meta.name', 'edited elsewhere'); t.setOpp(changed);
  t.setForm({ override: true, reasons: 'x' }); await t.decide();
  assert.equal(approveCalls(t).length, 0, 'stale preview is not used'); await tick(); assert.equal(previewCalls(t).length, 2); t.setForm({ override: true, reasons: 'x' }); await t.decide();
  const [c] = approveCalls(t); assert.equal(c.payload.expectedDocHash, documentHash(changed));
});
check('DOC_CHANGED from the server discards the preview, explains why and re-renders', async () => {
  const err = Object.assign(new Error('changed'), { code: 'functions/failed-precondition', details: { rejectionCode: 'DOC_CHANGED' } });
  const t = setup({ previews: [{ verdict: GREEN }, { verdict: GREEN }], approve: () => { throw err; } });
  t.setOpp(sane()); t.html(); await tick(); const before = t.f.renders;
  t.setForm({ override: true, reasons: 'x' }); await t.decide();
  assert.match(t.alerts.join('|'), /changed after it was reviewed/); assert.ok(t.f.renders > before);
  t.html(); await tick(); assert.equal(previewCalls(t).length, 2, 'a fresh preview is required');
});
check('success clears the preview (next decision needs a fresh hash)', async () => {
  const t = setup({ previews: [{ verdict: GREEN }, { verdict: GREEN }] });
  t.setOpp(sane()); t.html(); await tick(); t.setForm({ override: true, reasons: 'x' }); await t.decide();
  assert.equal(approveCalls(t).length, 1); t.html(); await tick(); assert.equal(previewCalls(t).length, 2);
});
check('demo / local path: applies the SAME shared classification (red blocks, compound needs the acknowledgement)', async () => {
  const red = sane(); set(red, 'financing.ltc', 1.8);
  let t = setup({ demo: true }); t.setOpp(red); assert.match(t.html(), /data-ic-verdict="red"/);
  t.setForm({ override: true, reasons: 'x' }); await t.decide();
  assert.equal(t.saved.length, 0); assert.match(t.alerts.join('|'), /Approval blocked/); assert.equal(t.calls.length, 0, 'no server in demo');
  const comp = sane(); set(comp, 'financing.ltc', 0.9); set(comp, 'financing.saibor', 0.25); set(comp, 'development.exitCapRate', 0.25); set(comp, 'development.constructionYears', 12);
  t = setup({ demo: true }); t.setOpp(comp); assert.match(t.html(), /name="ackWarnings"/);
  t.setForm({ override: true, reasons: 'x', ack: false }); await t.decide(); assert.equal(t.saved.length, 0);
  t.setForm({ override: true, reasons: 'accepted', ack: true }); await t.decide();
  assert.equal(t.saved.length, 1); const dec = t.saved[0].data.ic.decisions.at(-1); assert.equal(dec.warningsAcknowledged, true);
});
check('request signature covers the acknowledgement and the reviewed hash (so a changed payload gets a new requestId)', () => {
  const base = icRequestPayloadSignature('O', 'approve', [], [], false, false, HASH_A);
  assert.notEqual(base, icRequestPayloadSignature('O', 'approve', [], [], false, true, HASH_A));
  assert.notEqual(base, icRequestPayloadSignature('O', 'approve', [], [], false, false, HASH_B));
  assert.equal(base, icRequestPayloadSignature('O', 'approve', [], [], false, 0, HASH_A));
});

/* ---- Review evidence (requested before XIRR-P) -------------------------------------------------------------------- */
check('EVIDENCE lost reply, UI unchanged: the retry re-sends the SAME requestId and the SAME reviewed hash (server replays the original)', async () => {
  let n = 0;
  const t = setup({ approve: () => { n += 1; if (n === 1) throw new Error('network timeout'); return { data: { ok: true, decisionId: 'D1' } }; } });
  t.setOpp(sane()); t.html(); await tick();
  t.setForm({ override: true, reasons: 'x' }); await t.decide();            // reply lost (ambiguous failure)
  t.setForm({ override: true, reasons: 'x' }); await t.decide();            // user retries the identical decision
  const [a, b] = approveCalls(t);
  assert.equal(approveCalls(t).length, 2);
  assert.equal(a.payload.requestId, b.payload.requestId, 'same requestId');
  assert.equal(a.payload.expectedDocHash, b.payload.expectedDocHash, 'same reviewed hash');
});
const NET = () => new Error('network timeout'); // no error code => ambiguous outcome
const sameOpp = () => sane();
const changedOpp = () => { const o = sane(); set(o, 'meta.notes', 'document changed after the approval committed / by another save'); return o; };
check('lost reply, approval committed, document changed, fresh preview fetched: the retry re-sends the ORIGINAL payload verbatim (same requestId, same reviewed hash) — never a new request', async () => {
  let n = 0;
  const t = setup({ register: await freshRegister(new Map()), previews: [{ verdict: GREEN }, { verdict: GREEN }],
    approve: () => { n += 1; if (n === 1) throw NET(); return { data: { ok: true, decisionId: 'D2' } }; } });
  t.setOpp(sameOpp()); t.html(); await tick();
  t.setForm({ override: true, reasons: 'x' }); await t.decide();
  t.setOpp(changedOpp()); t.html(); await tick();                              // new document -> new preview (HASH_B) is fetched
  t.setForm({ override: true, reasons: 'x' }); await t.decide();
  const [a, b] = approveCalls(t);
  assert.equal(approveCalls(t).length, 2);
  assert.deepEqual(b.payload, a.payload, 'byte-for-byte the original payload');
  assert.equal(b.payload.expectedDocHash, documentHash(sameOpp()), 'the ORIGINAL reviewed hash, not the new preview hash');
  assert.notEqual(b.payload.expectedDocHash, documentHash(changedOpp()));
  t.html(); assert.doesNotMatch(t.html(), /data-ic-pending/, 'resolved by the server reply');
});
check('page reload while a request is pending: the persisted original payload is re-sent verbatim', async () => {
  const mem = new Map();
  let t = setup({ mem, register: await freshRegister(mem), approve: () => { throw NET(); } });
  t.setOpp(sameOpp()); t.html(); await tick(); t.setForm({ override: true, reasons: 'x' }); await t.decide();
  const first = approveCalls(t)[0].payload;
  assert.ok(mem.get('reop:pendingIcRequests:v1'), 'pending request persisted');
  assert.match(mem.get('reop:pendingIcRequests:v1'), /expectedDocHash/, 'the whole payload is persisted, not only the id');
  // ---- reload: new module instance reading the same storage; the document has meanwhile changed ----
  t = setup({ mem, register: await freshRegister(mem), previews: [{ verdict: GREEN }] });
  t.setOpp(changedOpp()); assert.match(t.html(), /data-ic-pending/, 'the pending notice survives the reload');
  await tick(); t.setForm({ override: true, reasons: 'x' }); await t.decide();
  const [again] = approveCalls(t);
  assert.deepEqual(again.payload, first, 'same requestId and same reviewed hash after the reload');
  assert.doesNotMatch(t.html(), /data-ic-pending/);
});
check('changing the decision content while a request is pending sends NOTHING and does not replace it', async () => {
  const mem = new Map();
  const t = setup({ mem, register: await freshRegister(mem), approve: () => { throw NET(); } });
  t.setOpp(sameOpp()); t.html(); await tick(); t.setForm({ override: true, reasons: 'x' }); await t.decide();
  const before = approveCalls(t).length; const stored = mem.get('reop:pendingIcRequests:v1');
  for (const change of [{ decision: 'reject', reasons: 'x' }, { decision: 'approve', reasons: 'a different reason' }, { decision: 'approve', reasons: 'x', override: false }]) {
    t.alerts.length = 0; t.setForm({ override: true, ...change }); await t.decide();
    assert.equal(approveCalls(t).length, before, 'nothing sent for ' + JSON.stringify(change));
    assert.match(t.alerts.join('|'), /unknown outcome/);
    assert.equal(mem.get('reop:pendingIcRequests:v1'), stored, 'the pending request is untouched');
  }
  t.setForm({ override: true, reasons: 'x' }); await t.decide();      // the identical decision is still re-sent verbatim
  assert.equal(approveCalls(t).length, before + 1);
  assert.deepEqual(approveCalls(t)[1].payload, approveCalls(t)[0].payload);
});
check('only an explicit discard by the user replaces a pending request; the next decision is then a NEW request with a fresh preview', async () => {
  const mem = new Map();
  const t = setup({ mem, register: await freshRegister(mem), previews: [{ verdict: GREEN }, { verdict: GREEN }],
    approve: (pl) => { if (!t.__n) { t.__n = 1; throw NET(); } return { data: { ok: true, decisionId: 'D3' } }; } });
  t.setOpp(sameOpp()); t.html(); await tick(); t.setForm({ override: true, reasons: 'x' }); await t.decide();
  t.setForm({ decision: 'reject', override: true, reasons: 'changed my mind' }); await t.decide();
  assert.equal(approveCalls(t).length, 1, 'blocked until the user acts');
  await t.discard(); assert.equal(mem.get('reop:pendingIcRequests:v1'), '{}', 'cleared by the explicit action');
  t.setOpp(changedOpp()); t.html(); await tick();
  t.setForm({ decision: 'reject', override: true, reasons: 'changed my mind' }); await t.decide();
  const [a, b] = approveCalls(t);
  assert.notEqual(b.payload.requestId, a.payload.requestId, 'a new request, by the user\'s explicit choice');
  assert.equal(b.payload.decision.decision, 'reject');
});
check('a DEFINITIVE server refusal of the re-sent request clears the pending request; nothing is auto-sent afterwards', async () => {
  const err = Object.assign(new Error('changed'), { code: 'functions/failed-precondition', details: { rejectionCode: 'DOC_CHANGED' } });
  let n = 0; const mem = new Map();
  const t = setup({ mem, register: await freshRegister(mem), previews: [{ verdict: GREEN }, { verdict: GREEN }],
    approve: () => { n += 1; if (n === 1) throw NET(); if (n === 2) throw err; return { data: { ok: true, decisionId: 'D4' } }; } });
  t.setOpp(sameOpp()); t.html(); await tick(); t.setForm({ override: true, reasons: 'x' }); await t.decide();   // lost (never executed)
  t.setForm({ override: true, reasons: 'x' }); await t.decide();                                               // verbatim re-send: the server says the document changed
  assert.equal(approveCalls(t).length, 2, 'no automatic third call');
  assert.equal(mem.get('reop:pendingIcRequests:v1'), '{}', 'cleared by the definitive answer');
  t.html(); await tick(); t.setForm({ override: true, reasons: 'x' }); await t.decide();                       // the user decides again, on a fresh preview
  const calls = approveCalls(t); assert.equal(calls.length, 3);
  assert.notEqual(calls[2].payload.requestId, calls[0].payload.requestId); assert.equal(calls[2].payload.expectedDocHash, documentHash(sameOpp()));
});
check('a legacy pending entry without a stored payload cannot be re-sent: blocked until explicitly discarded', async () => {
  const mem = new Map([['reop:pendingIcRequests:v1', JSON.stringify({ 'ic@example.com::O1': { requestId: 'old-req', signature: 'sig', busy: false } })]]);
  const t = setup({ mem, register: await freshRegister(mem) });
  t.setOpp(sameOpp()); assert.match(t.html(), /data-ic-pending/); await tick();
  t.setForm({ override: true, reasons: 'x' }); await t.decide();
  assert.equal(approveCalls(t).length, 0); assert.match(t.alerts.join('|'), /older format/);
  await t.discard(); t.html(); await tick(); t.setForm({ override: true, reasons: 'x' }); await t.decide();
  assert.equal(approveCalls(t).length, 1);
});
check('non-approving decisions follow the same rule (a pending reject is re-sent verbatim, without needing a preview)', async () => {
  let n = 0; const mem = new Map();
  const t = setup({ mem, register: await freshRegister(mem), approve: () => { n += 1; if (n === 1) throw NET(); return { data: { ok: true, decisionId: 'D5' } }; } });
  t.setOpp(sameOpp()); t.setForm({ decision: 'reject', reasons: 'no' }); await t.decide();
  t.setForm({ decision: 'reject', reasons: 'no' }); await t.decide();
  const [a, b] = approveCalls(t); assert.deepEqual(b.payload, a.payload);
});
/* ---- Preview binding (3A-3 final): the fingerprint is bound to the version the user is actually shown ---------------- */
const priced = (price) => { const o = sane(); set(o, 'development.salePrice', price); return o; };
check('BINDING: displayed document D1 (green) but the server stores D2 (also green, financially different): no approval, stale notice, never D2\'s hash', async () => {
  const D1 = priced(9000), D2 = priced(9500);
  assert.notEqual(documentHash(D1), documentHash(D2));
  const t = setup({ previews: [{ verdict: GREEN }, { verdict: GREEN }] });
  t.setOpp(D1); t.setServer(D2); t.html(); await tick();
  assert.match(t.html(), /data-ic-stale/, 'explicit stale notice with a refresh button');
  t.setForm({ override: true, reasons: 'x' }); await t.decide();
  assert.equal(approveCalls(t).length, 0, 'nothing is sent on a green verdict for a document the user did not see');
  assert.match(t.alerts.join('|'), /differs from the server version/);
  await t.refresh(); t.html(); await tick();                                  // still stale: the snapshot has not caught up
  assert.equal(previewCalls(t).length, 2); assert.equal(approveCalls(t).length, 0);
  t.setOpp(D2); t.html(); await tick();                                       // the live snapshot delivers D2: now the user sees what the server holds
  t.setForm({ override: true, reasons: 'x' }); await t.decide();
  const [c] = approveCalls(t); assert.ok(c); assert.equal(c.payload.expectedDocHash, documentHash(D2));
});
check('BINDING: a change that does NOT alter the verdict (a note) still breaks the binding', async () => {
  const shown = sane(); const stored = sane(); set(stored, 'meta.notes', 'edited elsewhere');
  const t = setup(); t.setOpp(shown); t.setServer(stored); t.html(); await tick();
  t.setForm({ override: true, reasons: 'x' }); await t.decide();
  assert.equal(approveCalls(t).length, 0); assert.match(t.html(), /data-ic-stale/);
});
check('BINDING: displayed locally red, server (a different document) green: the green preview is NOT accepted for the red document', async () => {
  const shownRed = sane(); set(shownRed, 'financing.ltc', 1.8);
  const t = setup({ previews: [{ verdict: GREEN }] });
  t.setOpp(shownRed); t.setServer(sane()); t.html(); await tick();
  t.setForm({ override: true, reasons: 'x' }); await t.decide();
  assert.equal(approveCalls(t).length, 0, 'no approval is built from a preview of another document');
});
check('BINDING: shown green locally, server preview RED for the same document: approval is never sent', async () => {
  const t = setup({ previews: [{ verdict: RED }] });
  t.setOpp(sane()); t.html(); await tick();
  t.setForm({ override: true, reasons: 'x' }); await t.decide();
  assert.equal(approveCalls(t).length, 0);
});
check('BINDING: a server that does not confirm displayedMatches (null / missing / false) is never trusted', async () => {
  for (const dm of [null, undefined, false, 'true', 1]) {
    const t = setup(); t.setOpp(sane());
    const orig = globalThis.firebase.functions;
    globalThis.firebase.functions = () => ({ httpsCallable: (name) => async (payload) => {
      if (name === 'getApprovalPreview') { t.calls.push({ name, payload }); const d = { docHash: documentHash(sane()), verdict: GREEN }; if (dm !== undefined) d.displayedMatches = dm; return { data: d }; }
      t.calls.push({ name, payload }); return { data: { ok: true, decisionId: 'D' } };
    } });
    t.html(); await tick(); t.setForm({ override: true, reasons: 'x' }); await t.decide();
    assert.equal(approveCalls(t).length, 0, 'displayedMatches=' + String(dm));
    globalThis.firebase.functions = orig;
  }
});
check('BINDING: the server answers with a docHash different from the one the client computed although it claims a match: rejected', async () => {
  const t = setup();
  globalThis.firebase.functions = () => ({ httpsCallable: (name) => async (payload) => { t.calls.push({ name, payload }); return { data: { docHash: 'c'.repeat(64), displayedMatches: true, verdict: GREEN } }; } });
  t.setOpp(sane()); t.html(); await tick(); t.setForm({ override: true, reasons: 'x' }); await t.decide();
  assert.equal(approveCalls(t).length, 0);
});
check('BINDING: the hash is recomputed at click time — a document whose JSON signature is unchanged (NaN vs null) but whose canonical hash differs is blocked', async () => {
  const withNull = sane(); set(withNull, 'development.exitCapRate', null);
  const t = setup({ previews: [{ verdict: GREEN }, { verdict: GREEN }] });
  t.setOpp(withNull); t.html(); await tick();
  assert.match(t.html(), /name="decision"|data-ic-form|Record Decision/);
  const rec = t.f.opportunities[0]; rec.data.development.exitCapRate = NaN;    // JSON.stringify(NaN) === 'null' → same signature, different canonical document
  t.setForm({ override: true, reasons: 'x' }); await t.decide();
  assert.equal(approveCalls(t).length, 0, 'blocked at click');
  assert.match(t.alerts.join('|'), /changed since the preview loaded/);
});
check('BINDING: no WebCrypto → fail closed (no preview accepted, no approval)', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    const t = setup(); t.setOpp(sane()); t.html(); await tick();
    assert.match(t.html(), /Could not load the approval preview/);
    t.setForm({ override: true, reasons: 'x' }); await t.decide();
    assert.equal(approveCalls(t).length, 0); assert.equal(previewCalls(t).length, 0, 'the server is not even asked without a displayed hash');
  } finally { if (saved) Object.defineProperty(globalThis, 'crypto', saved); else delete globalThis.crypto; }
});

/* ---- "Stop tracking locally": honest wording, explicit acknowledgement, refused while sending ---------------------- */
check('STOP-TRACKING: the notice says it does not cancel the server request; it needs the acknowledgement; wording never implies cancellation', async () => {
  const mem = new Map();
  const t = setup({ mem, register: await freshRegister(mem), approve: () => { throw NET(); } });
  t.setOpp(sameOpp()); t.html(); await tick(); t.setForm({ override: true, reasons: 'x' }); await t.decide();
  const h = t.html();
  assert.match(h, /data-ic-pending/); assert.match(h, /name="icDiscardAck"/); assert.match(h, /Stop tracking locally/);
  assert.match(h, /does not cancel the request on the server/);
  assert.doesNotMatch(h, /Discard pending request|تجاهل الطلب المعلّق/);
  await t.discard({ ack: false });
  assert.notEqual(mem.get('reop:pendingIcRequests:v1'), '{}', 'without the acknowledgement nothing is cleared');
  assert.match(t.alerts.join('|'), /does not cancel the request on the server/);
  await t.discard({ ack: true }); assert.equal(mem.get('reop:pendingIcRequests:v1'), '{}');
});
check('STOP-TRACKING: refused while the request is being sent (busy)', async () => {
  const mem = new Map(); let release; const gate = new Promise((r) => { release = r; });
  const t = setup({ mem, register: await freshRegister(mem), approve: async () => { await gate; return { data: { ok: true, decisionId: 'D' } }; } });
  t.setOpp(sameOpp()); t.html(); await tick(); t.setForm({ override: true, reasons: 'x' });
  const inFlight = t.decide(); await tick();
  assert.match(mem.get('reop:pendingIcRequests:v1'), /"busy":true/);
  await t.discard({ ack: true });
  assert.match(mem.get('reop:pendingIcRequests:v1'), /"busy":true/, 'not removed while sending');
  assert.match(t.alerts.join('|'), /being sent right now/);
  assert.doesNotMatch(t.html(), /data-ic-pending/, 'the button is not even offered while sending');
  release(); await inFlight;
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
