// بيئة مزيَّفة لاختبارات طبقة التوصيل: مؤقّتات قابلة للتحكم، doc/win بمستمعات، ومراقِب DOM يدوي.
export function makeTimers() {
  let id = 0; const pending = new Map(); let t = 0;
  return {
    setTimeout: (fn, ms) => { id += 1; pending.set(id, { fn, at: t + ms, ms }); return id; },
    clearTimeout: (h) => { pending.delete(h); },
    pending: () => [...pending.values()].map((p) => ({ at: p.at, ms: p.ms })),
    count: () => pending.size,
    now: () => t,
    advance(ms) { const end = t + ms; for (;;) { const due = [...pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; t = due[1].at; pending.delete(due[0]); due[1].fn(); } t = end; },
  };
}
export function makeEmitter() {
  const l = {};
  return {
    addEventListener: (n, f) => { (l[n] = l[n] || new Set()).add(f); },
    removeEventListener: (n, f) => { if (l[n]) l[n].delete(f); },
    fire: (n) => { for (const f of [...(l[n] || [])]) f(); },
    count: () => Object.values(l).reduce((a, s) => a + s.size, 0),
  };
}
export function makeDoc() { const e = makeEmitter(); e.visibilityState = 'visible'; e.body = {}; e.querySelector = () => null; return e; }
export function makeObserver() { const box = { cb: null, live: 0 }; box.observe = (cb) => { box.cb = cb; box.live += 1; return () => { box.live -= 1; box.cb = null; }; }; return box; }
