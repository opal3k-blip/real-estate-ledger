// R1-C3 — browser harness (page side). Real: index.html, main.js (all real features registered), core.js, real render(), the real portfolio and command-center screens,
// real net-xirr-live layer + MutationObserver + document/window events, real portfolio-valuation-source and bridge. Faked: Firebase + CDN (stubs), the Firestore listener (in-page fake
// that emits the explicit {docs, fromCache, hasPendingWrites} contract), the ledger inputs (the unit test covers makeGetInputs), the clock (injected). Cloud Chromium only.
import { documentHashHex } from '/src/domain/validation/document-hash.js';
import { makeFakeSubscribe } from '/tests/helpers/fund-valuation-fakes.mjs';
import { installNetXirrLive } from '/src/features/net-xirr-live-wiring.js';
const CORE_URL = '/src/core.js?v=20261011-b2-1-fund-valuation-panel';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (e) { /* keep waiting */ } await sleep(50); } throw new Error('timeout'); }
const DAY = '2026-03-31';

async function boot() {
  await waitFor(() => typeof window.__authCb === 'function'); await sleep(300);
  const core = await import(CORE_URL);
  const fake = makeFakeSubscribe();
  const H = { core, fake, clock: { base: new Date('2026-03-31T09:00:00Z').getTime(), t0: performance.now() }, session: { uid: 'u3', email: 'ic@example.com', role: 'senior_ic', roleResolved: true }, renders: 0, subscribeLog: [] };
  H.now = () => new Date(H.clock.base + (performance.now() - H.clock.t0));
  H.inputs = { scope: { snapshotDate: DAY, funds: ['f1', 'f2'], linksByFund: { f1: ['a1', 'a2'], f2: [] } }, records: [{ kind: 'capitalCall', id: 'c1', fundId: 'f1', date: '2025-03-31', amount: 1000000, status: 'paid', reversalOfId: null }] };
  const { source, layer } = installNetXirrLive(core, {
    now: H.now, getSession: () => ({ ...H.session }), getInputs: () => H.inputs,
    subscribe: (s, f, n, e) => { H.subscribeLog.push(`${s}:${f}`); return fake.subscribe(s, f, (x) => n({ hasPendingWrites: false, ...x }), e); },
  });
  Object.assign(H, { source, layer });
  core.registerRenderEnd(() => { H.renders += 1; });
  H.pair = async (fundId) => {
    const valuationId = `v-${fundId}`; const approvedBy = 'appr@x.sa'; const contentHash = `CH-${fundId}`;
    const c = fundId === 'f1' ? { components: { assetsValue: 1000000, cashRetained: 50000, otherAssets: 20000, otherAssetsItems: [{ description: 'receivable', amount: 20000 }], liabilities: 70000, distributionsPayable: 0 }, residualValue: 1000000, coverage: { linkedAssets: ['a1', 'a2'], unlinkedHoldings: { declared: 'none' } } }
      : { components: { assetsValue: 500000, cashRetained: 0, otherAssets: 0, otherAssetsItems: [], liabilities: 0, distributionsPayable: 0 }, residualValue: 500000, coverage: { linkedAssets: [], unlinkedHoldings: { declared: 'none' } } };
    const doc = { valuationId, fundId, valuationDate: DAY, state: 'approved', status: 'approved', currency: 'SAR', basis: 'RESIDUAL_VALUE_AS_OF_DATE', ...c, method: 'appraisal', source: { ref: 'D', provider: 'V' }, nonOverlap: { cashNotInAssets: true, otherAssetsNotInAssets: true, assetsStatedGrossOfLiabilities: true }, version: 1, supersedes: null, enteredBy: 'prep@x.sa', approvedBy, contentHash };
    const head = { fundId, valuationDate: DAY, headId: valuationId, version: 1, headHash: await documentHashHex({ valuationId, version: 1, contentHash, approvedBy }), eligibility: { state: 'ELIGIBLE', changedBy: approvedBy, changedAt: 't', reasonCode: 'APPROVED', reason: null }, activeDraftId: null, rev: 1 };
    return { head: { id: `${fundId}__${DAY}`, data: head }, doc: { id: valuationId, data: doc } };
  };
  H.feedAll = async () => { for (const f of ['f1', 'f2']) { const p = await H.pair(f); fake.emit('heads', f, [p.head]); fake.emit('valuations', f, [p.doc]); } };
  // Variant that goes through the REAL ledger source (no injected getInputs): the Firestore ledger listener is an in-page fake emitting the explicit contract.
  H.ledgerSubs = [];
  H.ledgerEmit = (name, docs, flags = { fromCache: false, hasPendingWrites: false }) => { for (const s of H.ledgerSubs.filter((x) => x.name === name && !x.closed)) s.onNext({ docs, ...flags }); };
  H.ledgerAll = () => { H.ledgerEmit('funds', [{ id: 'f1', data: { name: 'F1', assetIds: ['a1', 'a2'] } }, { id: 'f2', data: { name: 'F2', assetIds: [] } }]); H.ledgerEmit('capitalCalls', [{ id: 'c1', data: { fundId: 'f1', callDate: '2025-03-31', amount: 1000000, status: 'paid' } }]); H.ledgerEmit('distributions', []); };
  H.useLedgerSource = () => {
    const r = installNetXirrLive(core, { now: H.now, getSession: () => ({ ...H.session }),
      subscribe: (s, f, n, e) => { H.subscribeLog.push(`${s}:${f}`); return fake.subscribe(s, f, (x) => n({ hasPendingWrites: false, ...x }), e); },
      subscribeLedger: (name, onNext, onError) => { const s = { name, onNext, onError, closed: false }; H.ledgerSubs.push(s); return () => { s.closed = true; }; } });
    Object.assign(H, { source: r.source, layer: r.layer }); return r;
  };
  H.signIn = () => { core.STORE.funds = [{ id: 'f1', data: { name: 'F1', assetIds: ['a1', 'a2'] } }, { id: 'f2', data: { name: 'F2', assetIds: [] } }]; window.__authCb({ uid: H.session.uid, email: H.session.email }); };
  window.__r1c3 = H; H.signIn();
  return H;
}
boot().catch((e) => { window.__bootError = String(e && e.stack || e); });
