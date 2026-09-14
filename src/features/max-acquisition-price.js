/* =========================================================================
   الحد الأقصى لسعر الاستحواذ — Maximum Acquisition Price (Phase 2، النظام الأول)
   ---------------------------------------------------------------------------
   بدل "البائع يطلب ١٢٠م" → النظام يقول "الحد الأقصى = ١٠٦٫٤م حتى تتحقق Equity
   IRR ≥ ١٥٪". بحث ثنائي (Binary Search) على سعر متر الأرض (land.price) باستخدام
   محرك الحساب core.compute() نفسه دون أي تكرار لمنطقه — نفس المعادلات المُتحقَّق
   منها بالضبط، فقط نبحث عكسياً عن السعر الذي يُنتج target IRR بدل حساب IRR من
   سعر معطى. غير مخزَّن كحقل ثابت في بيانات الفرصة (لا داعي: يُعاد حسابه حياً في
   كل عرض من land.price/criteria.irrMin الحاليين) — يُصدَّر كدالة يستخدمها أيضاً
   negotiation.js لحساب Walk-away Price الافتراضي. لا تعديل على core.js.
   ========================================================================= */

function metricsAtPrice(core, d, price){
  const trial = JSON.parse(JSON.stringify(d));
  trial.land.price = price;
  try{ const c = core.compute(trial); return { irr: c.equityIRR, dscr: c.dscrMin }; }
  catch(e){ return { irr: -1, dscr: null }; }
}
function irrAtPrice(core, d, price){ return metricsAtPrice(core, d, price).irr; }

/* السعر "قابل للدفع" فقط لو حقق كلا القيدين معاً: Equity IRR ≥ الحد الأدنى، وDSCR الأدنى عبر
   مدة التشغيل ≥ الحد الأدنى المعتمد (لو كان للصفقة تمويل بنكي أصلاً — dscr يكون null لصفقات
   لا معنى لـDSCR فيها، كبيع كامل بلا تمويل، فلا يُفرَض القيد حينها). قبل هذا الإصلاح كان البحث
   الثنائي يستهدف IRR فقط، فقد يُبلِّغ المستخدم بسعر "أقصى مسموح" يحقق العائد المستهدف لكنه فعلياً
   يخالف حد تغطية خدمة الدين المعتمد لنفس الصفقة — وهو قيد تمويلي أساسي لا يقل أهمية عن العائد. */
function feasibleAtPrice(core, d, price, targetIRR, targetDSCR){
  const m = metricsAtPrice(core, d, price);
  const irrOk = isFinite(m.irr) && m.irr >= targetIRR;
  const dscrOk = targetDSCR==null || m.dscr==null || !isFinite(m.dscr) || m.dscr >= targetDSCR;
  return irrOk && dscrOk;
}

/* يُعيد: maxPrice (الحد الأقصى الذي يحقق كلا القيدين معاً)، targetIRR، targetDSCR، currentPrice،
   currentIRR، currentDSCR، infeasible (true لو حتى أرض مجانية "٠" لا تحقق أحد الهدفين)،
   bindingConstraint ('irr' أو 'dscr' — أيهما فعلياً القيد الحاكم عند السعر الأقصى الناتج). */
function maxAcquisitionPrice(core, d, targetIRR, targetDSCR){
  targetIRR = targetIRR!=null ? targetIRR : (d.criteria.irrMin || 0.15);
  targetDSCR = targetDSCR!=null ? targetDSCR : (d.criteria.dscrMin!=null ? d.criteria.dscrMin : null);
  const currentPrice = d.land.price || 0;
  const curM = metricsAtPrice(core, d, currentPrice);
  const currentIRR = curM.irr, currentDSCR = curM.dscr;

  if(!feasibleAtPrice(core, d, 0, targetIRR, targetDSCR)){
    const zero = metricsAtPrice(core, d, 0);
    const irrBlocks = !(isFinite(zero.irr) && zero.irr>=targetIRR);
    const dscrBlocks = targetDSCR!=null && zero.dscr!=null && isFinite(zero.dscr) && zero.dscr<targetDSCR;
    return { maxPrice: 0, targetIRR, targetDSCR, currentPrice, currentIRR, currentDSCR, infeasible: true,
      bindingConstraint: (irrBlocks && dscrBlocks) ? 'both' : (dscrBlocks ? 'dscr' : 'irr') };
  }

  let lo = 0, hi = Math.max(currentPrice, 100) * 3;
  let guard = 0;
  while(feasibleAtPrice(core, d, hi, targetIRR, targetDSCR) && guard < 40){ hi *= 1.6; guard++; }

  for(let i=0;i<50;i++){
    const mid = (lo+hi)/2;
    if(feasibleAtPrice(core, d, mid, targetIRR, targetDSCR)) lo = mid; else hi = mid;
  }

  const atMax = metricsAtPrice(core, d, lo);
  const irrSlack = isFinite(atMax.irr) ? (atMax.irr - targetIRR) : Infinity;
  const dscrSlack = (targetDSCR!=null && atMax.dscr!=null && isFinite(atMax.dscr)) ? (atMax.dscr - targetDSCR) : Infinity;
  const bindingConstraint = dscrSlack < irrSlack ? 'dscr' : 'irr';
  return { maxPrice: lo, targetIRR, targetDSCR, currentPrice, currentIRR, currentDSCR, infeasible: false, bindingConstraint };
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
