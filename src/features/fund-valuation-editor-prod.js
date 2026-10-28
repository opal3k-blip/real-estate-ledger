/* R1-B2 / B2-2b-b1 — the production adapters of the editor: Firebase callables, the browser's pending-request storage and Web Locks, fund data from core.
   Kept out of the read-only panel on purpose (the panel's guard test forbids callables / storage there). The draft FORM is never stored: only the runner's
   pending-request record (B2-0, approved) is persisted, and only for requests that were actually sent. */
export function editorAvailable(g = globalThis) {
  return !!g && !!g.firebase && typeof g.firebase.functions === 'function';
}
export function makeEditorProdDeps(core, g = globalThis) {
  const safe = (fn) => { try { return fn(); } catch (e) { return null; } };
  return {
    call: (callable, payload) => g.firebase.functions().httpsCallable(callable)(payload).then((r) => r.data),
    storage: safe(() => g.localStorage),
    locks: (g.navigator && g.navigator.locks) || null,
    getFundAssetIds: (fundId) => {
      const f = core && core.STORE && Array.isArray(core.STORE.funds) ? core.STORE.funds.find((x) => x.id === fundId) : null;
      return f && f.data && Array.isArray(f.data.assetIds) ? f.data.assetIds : null;
    },
    doc: g.document, win: g.window,
  };
}
