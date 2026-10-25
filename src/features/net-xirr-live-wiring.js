/* =========================================================================
   تركيب مصدر Net XIRR الحي (R1-C3): يصل core + Firestore + الجلسة بمصدر R1-C2 وطبقة التوصيل، ويثبّتها كمثيل مشترك.
   لا منطق مالي هنا. المدخلات: النطاق (صناديق STORE.funds وأصولها المرتبطة اليوم) والتدفقات = كل وثائق capitalCalls وdistributions المؤكدة بلا تصفية بقائمة الصناديق (القرار للمحرك المعتمد).
   الدفتر (funds، capitalCalls، distributions) يُقرأ بمصدر مستقل (portfolio-ledger-source.js) بتأكيد راهن مرتبط بالوثائق المستعملة؛ لا يُستعمل core.STORE ولا علم isIfCollectionServerConfirmed.
   ========================================================================= */
import { createPortfolioValuationSource } from './portfolio-valuation-source.js';
import { createNetXirrLive, setNetXirrLive } from './net-xirr-live.js';
import { makePortfolioSubscribe } from './portfolio-valuation-firestore.js';
import { makeSession } from './fund-valuation-panel.js';
import { riyadhDay } from './fund-valuation-model.js';
import { createLedgerSource, makeLedgerSubscribe } from './portfolio-ledger-source.js';


const UNRESOLVED = Object.freeze({ uid: null, email: null, role: null, roleResolved: false });
/** The panel's session reader, created on first use. If the panel module is replaced by a stub (some acceptance kits do), the session is simply unresolved: nothing is read. */
export function lazySession(core) {
  let f;
  return () => { if (f === undefined) f = makeSession(core); return typeof f === 'function' ? f() : { ...UNRESOLVED }; };
}

/** Inputs come from the ledger source's CONFIRMED docs (same data the result is computed from), never from core.STORE or the old once-only flag. */
export function makeGetInputs(ledger, now) {
  return () => {
    let L;
    try { ledger.sync(); L = ledger.getLedger(); } catch (e) { return { unavailable: 'INPUTS_LEDGER_CONFIRMATION_UNAVAILABLE' }; }
    if (!L || L.ok !== true) return { unavailable: L && typeof L.reason === 'string' && L.reason ? L.reason : 'INPUTS_LEDGER_CONFIRMATION_UNAVAILABLE' };
    const funds = L.funds;
    const ids = [...new Set(funds.map((f) => f.id))].sort();
    const linksByFund = {};
    for (const f of funds) linksByFund[f.id] = [...new Set(((f.data && f.data.assetIds) || []).filter((x) => typeof x === 'string' && x))].sort();
    // EVERY confirmed capitalCalls / distributions doc becomes a record — never filtered by the scope's fund list. Fund id, date, status, amount (sign) and
    // reversal reference are carried as stored; the approved engine decides to block (COVERAGE_FUND_MISSING) or exclude. Dropping a record here would hide it from the selector.
    const records = [
      ...L.capitalCalls.map((c) => ({ kind: 'capitalCall', id: c.id, fundId: c.data.fundId, date: c.data.callDate, amount: c.data.amount, status: c.data.status, reversalOfId: c.data.reversalOfId || null, inKindAssetId: c.data.inKindAssetId || null, linkedCommitmentId: c.data.linkedCommitmentId || null })),
      ...L.distributions.map((d) => ({ kind: 'distribution', id: d.id, fundId: d.data.fundId, date: d.data.distDate, amount: d.data.amount, status: d.data.status, reversalOfId: d.data.reversalOfId || null })),
    ];
    return { scope: { snapshotDate: riyadhDay(now()), funds: ids, linksByFund }, records };
  };
}

/** Never throws: a failure here must not take the app down. Without the live source the screens fall back to the previous display (no rate). */
export function installNetXirrLive(core, deps = {}) {
  try { return installUnsafe(core, deps); }
  catch (e) { setNetXirrLive(null); if (typeof console !== 'undefined') console.error('[net-xirr-live] not installed:', e); return null; }
}

function installUnsafe(core, deps) {
  const now = deps.now || (() => new Date());
  const getSession = deps.getSession || lazySession(core);
  let layer = null; let base = null;
  // The ledger is read by its own source (current confirmation, tied to the docs used). Injected getInputs (tests) bypasses it.
  const ledger = deps.getInputs ? null : (deps.ledger || createLedgerSource({
    subscribe: deps.subscribeLedger || makeLedgerSubscribe(core), getSession,
    onChange: () => { if (base && typeof base.sync === 'function') base.sync(); },
  }));
  base = deps.source || createPortfolioValuationSource({
    subscribe: deps.subscribe || makePortfolioSubscribe(core),
    getSession,
    getInputs: deps.getInputs || makeGetInputs(ledger, now),
    now,
    verify: deps.verify,
    onChange: () => { if (layer) layer.onSourceChange(); },
  });
  const source = ledger ? {
    start() { ledger.start(); base.start(); },
    stop() { base.stop(); ledger.stop(); },
    recover() { ledger.recover(); return base.recover(); },
    sync: () => { ledger.sync(); base.sync(); }, getView: () => { ledger.sync(); return base.getView(); },   // the ledger follows the session even when the valuation source never asks for inputs
    stats: () => ({ ...base.stats(), ledger: ledger.stats() }),
  } : base;
  layer = createNetXirrLive({
    source, now, requestRender: deps.requestRender || (() => core.render()),
    timers: deps.timers, doc: 'doc' in deps ? deps.doc : (typeof document !== 'undefined' ? document : null),
    win: 'win' in deps ? deps.win : (typeof window !== 'undefined' ? window : null), isShown: deps.isShown, observe: deps.observe,
  });
  setNetXirrLive(layer);
  return { source, layer, ledger };
}
