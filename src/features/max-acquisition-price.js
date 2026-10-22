/* =========================================================================
   الحد الأقصى لسعر الاستحواذ — Maximum Acquisition Price (Phase 2، النظام الأول)
   ---------------------------------------------------------------------------
   بدل "البائع يطلب ١٢٠م" → النظام يقول "الحد الأقصى = ١٠٦٫٤م حتى تتحقق Equity
   IRR ≥ ١٥٪". بحث ثنائي (Binary Search) على سعر متر الأرض (land.price) باستخدام
   محرك الحساب core.compute() نفسه دون أي تكرار لمنطقه — نفس المعادلات المُتحقَّق
   منها بالضبط، فقط نبحث عكسياً عن السعر الذي يُنتج target IRR بدل حساب IRR من
   سعر معطى. غير مخزَّن كحقل ثابت في بيانات الفرصة (لا داعي: يُعاد حسابه حياً في
   كل عرض من land.price/criteria.irrMin الحاليين) — يُصدَّر كدالة يستخدمها أيضاً
   negotiation.js لحساب Walk-away Price الافتراضي.

   Phase 2R-4B — Client Cutover: البحث الثنائي الفعلي أصبح في
   src/domain/financial/max-acquisition-price.js (الجهة الرسمية الوحيدة،
   بعد إثبات تطابقها Shadow-Mode في Phase 2R-4A — 17/17). هذا الملف أصبح
   UI wrapper فقط + توقيع (core, d, ...) للتوافق الخلفي مع كل المستوردين
   الحاليين (excel-workbook.js, ic-book-print.js, ic-presentation.js,
   negotiation.js, valuation-engine.js, ic-decision-gate.js). لا تعديل
   على core.js.
   ========================================================================= */
import {
  maxAcquisitionPrice as domainMaxAcquisitionPrice,
  irrAtPrice as domainIrrAtPrice,
} from '../domain/financial/max-acquisition-price.js';

function maxAcquisitionPrice(core, d, targetIRR, targetDSCR){
  return domainMaxAcquisitionPrice(core.compute.bind(core), d, targetIRR, targetDSCR);
}
function irrAtPrice(core, d, price){
  return domainIrrAtPrice(core.compute.bind(core), d, price);
}

export function registerMaxAcquisitionPrice(core){
  core.registerDetailSection((d, c)=>{
    const targetIRR = d.criteria.irrMin || 0.15;
    const res = maxAcquisitionPrice(core, d, targetIRR);
    const gap = res.maxPrice - res.currentPrice;
    const gapPct = res.currentPrice>0 ? gap/res.currentPrice : 0;
    const canPay = !res.infeasible && gap >= 0;

    return `
    <div class="section">
      <h3>💰 ${core.T('الحد الأقصى لسعر الاستحواذ','Maximum Acquisition Price')}</h3>
      ${res.infeasible? `
      <p class="note" style="color:var(--bad);">🚫 ${core.T('حتى بأرض مجانية (سعر = صفر)، الفرصة لا تحقق الحد الأدنى لـ Equity IRR','Even at zero land cost, the opportunity does not reach the minimum Equity IRR')} (${core.fmtPct(targetIRR)}) — ${core.T('المشكلة ليست في سعر الأرض؛ راجع الافتراضات الأساسية (التكلفة/الإيراد/التمويل).','the issue is not the land price; review the core assumptions (cost/revenue/financing).')}</p>
      ` : `
      <div class="kv" style="margin-bottom:10px;">
        <div class="k">${core.T('السعر الحالي المُدخَل','Current Entered Price')}</div><div class="v">${core.fmtSAR(res.currentPrice)}/م²</div>
        <div class="k">Equity IRR (${core.T('عند السعر الحالي','at current price')})</div><div class="v">${core.fmtPct(res.currentIRR)}</div>
        <div class="k">${core.T('الحد الأقصى المسموح به','Maximum Payable')}</div><div class="v"><b style="color:${canPay?'var(--good)':'var(--bad)'}; font-size:15px;">${core.fmtSAR(res.maxPrice)}/م²</b></div>
        <div class="k">${core.T('العائد المستهدف (الحد الأدنى)','Target Return (Minimum)')}</div><div class="v">Equity IRR ≥ ${core.fmtPct(targetIRR)}</div>
        <div class="k">${core.T('الهامش المتبقي','Remaining Headroom')}</div><div class="v" style="color:${gap>=0?'var(--good)':'var(--bad)'};">${gap>=0?'+':''}${core.fmtSAR(gap)}/م²</div>
        <div class="k">${core.T('الهامش كنسبة من السعر الحالي','Headroom as % of Current Price')}</div><div class="v" style="color:${gap>=0?'var(--good)':'var(--bad)'};">${gap>=0?'+':''}${core.fmtPct(gapPct,1)}</div>
      </div>
      <p class="note">${gap>=0
        ? core.T('السعر الحالي ضمن الحد المسموح — لا يزال هناك هامش تفاوضي متاح للبائع دون المساس بالعائد المستهدف.','Current price is within the payable limit — there is still negotiation headroom before hitting the target return.')
        : core.T('السعر الحالي يتجاوز الحد الأقصى المسموح به — العائد المستهدف لن يتحقق بهذا السعر.','Current price exceeds the maximum payable — the target return will not be met at this price.')}
        ${res.targetDSCR!=null? ` ${core.T(`القيد الحاكم عند هذا السعر: ${res.bindingConstraint==='dscr'? `تغطية خدمة الدين (DSCR ≥ ${res.targetDSCR.toFixed(2)}×)` : `العائد المستهدف (Equity IRR ≥ ${core.fmtPct(targetIRR)})`}.`, `Binding constraint at this price: ${res.bindingConstraint==='dscr'? `debt service coverage (DSCR ≥ ${res.targetDSCR.toFixed(2)}×)` : `target return (Equity IRR ≥ ${core.fmtPct(targetIRR)})`}.`)}` : ''}
      </p>
      `}
    </div>`;
  });
}

export { maxAcquisitionPrice, irrAtPrice };
