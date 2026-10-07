/* =========================================================================
   تغطية خدمة الدين سنةً بسنة (Phase 3A-2c) — وحدة نقية، لا تغيّر core.compute ولا Golden Master.
   القاعدة: في أي سنة فيها خدمة دين (debtService > 0) يُقارَن التدفق المتاح للسداد بخدمة الدين:
     المتاح = NOI التشغيلي + (في سنة بيع/تخارج: قيمة البيع − تكاليفه)
   فإن كان المتاح < خدمة الدين (نسبة < 1) تُسجَّل السنة كعجز تغطية.
   لا يُستثنى أي نوع فرصة؛ مشاريع التطوير للبيع تُقيَّم بتدفقات مبيعاتها أيضًا.
   مصدر البيانات: c.pnlRows (noi, debtService, isExitYear, exitValue, exitCostsAmt, phase, yr).
   ========================================================================= */
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** @returns {{years:Array, shortfalls:Array, worst:(object|null), hasDebtService:boolean}} لا يرمي أبدًا. */
export function debtCoverageByYear(c) {
  const rows = c && Array.isArray(c.pnlRows) ? c.pnlRows : [];
  const years = [];
  rows.forEach((r) => {
    if (!r || typeof r !== 'object') return;
    const ds = num(r.debtService);
    if (!(ds > 0)) return;
    const operating = num(r.noi);
    const sale = r.isExitYear ? Math.max(0, num(r.exitValue) - num(r.exitCostsAmt)) : 0;
    const available = operating + sale;
    years.push({
      yr: r.yr, phase: r.phase === 'construction' ? 'construction' : 'operation',
      debtService: ds, operating, sale, available, ratio: available / ds, shortfall: available / ds < 1,
    });
  });
  const shortfalls = years.filter((y) => y.shortfall);
  const worst = years.length ? years.reduce((a, b) => (b.ratio < a.ratio ? b : a)) : null;
  return { years, shortfalls, worst, hasDebtService: years.length > 0 };
}
