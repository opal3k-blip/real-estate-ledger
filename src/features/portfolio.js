/* =========================================================================
   ذكاء المحفظة — Portfolio Intelligence (Phase 3، النظام الأول)
   ---------------------------------------------------------------------------
   يمتد فوق نظام "المستثمرون والصناديق" القائم أصلاً في core.js (الذي يوفّر
   بالفعل: fundLedgerSummary، fundEquityAndValue، commitmentsForFund،
   capitalCallsFor، distributionsFor) ليضيف طبقة تحليل محفظة كاملة تجمع كل
   الصناديق معاً: AUM، رأس المال المستثمر/غير المستثمر (Dry Powder)، NAV،
   Gross IRR (على مستوى الأصول)، Net IRR حقيقي (XIRR على تدفقات نداءات رأس
   المال والتوزيعات المسدَّدة بتاريخَي السجل callDate/distDate — وهما تاريخا السجل المستخدمان وليس ثابتاً أنهما تاريخا الدفع الفعليان — مع NAV كتدفق ختامي عند اعتماد أساس قيمة متبقية موثوق)،
   مضاعف المحفظة (TVPI)، الدين وLTV وDSCR، وتركّز المحفظة حسب الصندوق/المدينة/
   نوع الفرصة (يُستهلَك أيضاً من concentration-risk.js عبر تصدير
   portfolioIntelligenceStats — بلا أي تكرار للحساب).
   Net IRR (XIRR-P) يُحسب عبر الحلّال المشترك لـXIRR الفرص (domain/financial/xirr/portfolio-xirr.js) ولا يُعرض معدل رئيسي إلا عند status OK؛ لا يكرر core.irr() (الذي
   يفترض فترات سنوية صحيحة لمحرك الجدوى لكل فرصة على حدة) — هذا تجميع محفظة
   على مستوى مختلف تماماً غير موجود في core.js أصلاً. ملاحظة حوكمة: قيمة NAV
   هنا تقديرية مشتقة من underwriting linked assets، وليست Current Independent
   Valuation رسمية إلا بعد إضافة سجل تقييم حالي مستقل للأصل. لا تعديل على منطق
   core.js الداخلي — فقط عبر نقاط التوسّع المُصدَّرة (registerMainView
   المضافة سابقاً لأجل Pipeline).
   ========================================================================= */

import { computePortfolioNetXirr, riyadhDateStr } from '../domain/financial/xirr/portfolio-xirr.js';

const WARN_THRESHOLD = 0.35;

/* اكتمال NAV: يعكس تماماً ما يجمعه core.fundEquityAndValue (بلا تعديل عليه) لكن يُبلغ عن كل أصل لم يدخل القيمة:
   سجل مفقود، فشل الحساب، أصل محجوب، أو MOIC غير منتهٍ (الذي يحوّله core إلى قيمة صفرية بصمت). */
function navCompleteness(core, funds){
  const issues = [];
  funds.forEach(f=>{
    (f.data.assetIds||[]).forEach(id=>{
      const rec = core.opportunities.find(o=>o.id===id);
      if(!rec){ issues.push({ code:'ASSET_RECORD_MISSING', fundId:f.id, assetId:id }); return; }
      let c; try{ c = core.compute(core.withDefaults(rec.data)); }catch(e){ issues.push({ code:'ASSET_COMPUTE_FAILED', fundId:f.id, assetId:id }); return; }
      if(typeof core.oppMetricGuard==='function' && core.oppMetricGuard(rec, c)){ issues.push({ code:'ASSET_BLOCKED', fundId:f.id, assetId:id }); return; }
      if(!isFinite(c.MOIC)) issues.push({ code:'ASSET_VALUE_NOT_COMPUTABLE', fundId:f.id, assetId:id });
    });
  });
  // الأساس: equity×MOIC = إجمالي متحصلات متوقعة طوال عمر الاستثمار (غير مخصوم وغير مؤرَّخ، وقد يتضمن توزيعات موجودة في الدفتر)
  // وليس قيمة متبقية بتاريخ معيّن → أساس NAV غير محسوم. وغياب الأصول المرتبطة ليس إثباتاً أن القيمة المتبقية صفر (قد توجد
  // حيازات غير مرتبطة) → يبقى غير محسوم أيضاً. لا يوجد في النظام حالياً مصدر قيمة متبقية، فلا يُمرَّر RESIDUAL_VALUE_AS_OF_DATE.
  const linkedTotal = funds.reduce((n,f)=>n+(f.data.assetIds||[]).length,0);
  return { complete: issues.length===0, issues, basis: linkedTotal===0 ? 'NO_LINKED_ASSETS_RESIDUAL_VALUE_UNKNOWN' : 'UNDERWRITING_TOTAL_PROJECTED_EQUITY_PROCEEDS' };
}

/* سجلات دفتر الصناديق كما هي (كل الحالات: الأصل لقيد عكسي يجب أن يكون مرئياً). التاريخ المعتمد: callDate للنداءات، distDate للتوزيعات. */
function ledgerRecords(core, funds){
  const out = [];
  funds.forEach(f=>{
    core.capitalCallsFor(f.id).forEach(c=>out.push({ kind:'capitalCall', id:c.id, fundId:f.id, date:c.data.callDate, amount:c.data.amount, status:c.data.status, reversalOfId:c.data.reversalOfId||null, inKindAssetId:c.data.inKindAssetId||null, linkedCommitmentId:c.data.linkedCommitmentId||null }));
    core.distributionsFor(f.id).forEach(d=>out.push({ kind:'distribution', id:d.id, fundId:f.id, date:d.data.distDate, amount:d.data.amount, status:d.data.status, reversalOfId:d.data.reversalOfId||null }));
  });
  return out;
}

/* مدخل الحلّال: asOfDate مدخل صريح للدالة النقية؛ إن لم يمرّره المستدعي فهو يوم الحساب بتوقيت الرياض (UTC+3) ويُعلَن بتحذير.
   مصدر NAV المعلن: UNDERWRITING_EQUITY_X_MOIC (تحذيراته مرتبطة بهذا المصدر وحده). لا تاريخ تقييم للـNAV في النظام. */
export function netXirrInput(core, funds, nav, options={}){
  const asOfGiven = options.asOfDate!=null;
  return {
    asOfDate: asOfGiven ? options.asOfDate : riyadhDateStr(options.now || new Date()),
    asOfDateSource: asOfGiven ? 'explicit' : 'calculation-date',
    records: ledgerRecords(core, funds),
    nav: { value: nav, source: 'UNDERWRITING_EQUITY_X_MOIC', ...navCompleteness(core, funds) },
  };
}

function portfolioIntelligenceStats(core, options={}){
  const funds = core.STORE.funds || [];
  let aum=0, committed=0, calledTotal=0, paidIn=0, distPaid=0, nav=0;
  const byFund = [];
  funds.forEach(f=>{
    const s = core.fundLedgerSummary(f.id);
    aum += s.committed; committed += s.committed; calledTotal += s.called;
    paidIn += s.paidIn; distPaid += s.distPaid; nav += s.totalValue;
    byFund.push({ key: f.data.name || f.id, value: s.totalValue });
  });

  const linkedIds = new Set();
  funds.forEach(f=> (f.data.assetIds||[]).forEach(id=>linkedIds.add(id)));
  let tpcSum=0, debtSum=0, equitySum=0;
  let irrWeighted=0, irrWeight=0;
  let dscrWeighted=0, dscrWeight=0, dscrMinOverall=null;
  const byCity={}, byType={};
  let blockedN = 0;
  linkedIds.forEach(id=>{
    const rec = core.opportunities.find(o=>o.id===id);
    if(!rec) return;
    let c; try{ c = core.compute(rec.data); }catch(e){ return; }
    // 3A-2c: أصل محجوب (INVALID/INCOMPLETE) لا يدخل أي مجموع/متوسط/تركّز
    if(typeof core.oppMetricGuard==='function' && core.oppMetricGuard(rec, c)){ blockedN++; return; }
    tpcSum += c.TPC||0; debtSum += c.debt||0; equitySum += c.equity||0;
    if(isFinite(c.equityIRR) && c.equity){ irrWeighted += c.equityIRR*c.equity; irrWeight += c.equity; }
    if(c.dscrMin!=null && isFinite(c.dscrMin) && c.TPC){
      dscrWeighted += c.dscrMin*c.TPC; dscrWeight += c.TPC;
      if(dscrMinOverall==null || c.dscrMin<dscrMinOverall) dscrMinOverall = c.dscrMin;
    }
    const d = core.withDefaults(rec.data);
    const city = d.meta.city || core.T('غير محدد','Unspecified');
    byCity[city] = (byCity[city]||0) + (c.TPC||0);
    const ti = core.OPP_TYPE_INFO[d.meta.oppType];
    const tlabel = ti? core.T(ti.t, ti.en) : d.meta.oppType;
    byType[tlabel] = (byType[tlabel]||0) + (c.TPC||0);
  });

  const grossIRR = irrWeight>0 ? irrWeighted/irrWeight : null;
  const ltv = tpcSum>0 ? debtSum/tpcSum : null;
  const dscrAvg = dscrWeight>0 ? dscrWeighted/dscrWeight : null;
  const investedCapital = equitySum;
  const uninvestedCapital = Math.max(0, committed-calledTotal);
  const portfolioMOIC = paidIn>0 ? (distPaid+nav)/paidIn : null;

  const netXirr = computePortfolioNetXirr(netXirrInput(core, funds, nav, options));
  const netIRR = (netXirr.status==='OK' && isFinite(netXirr.rate)) ? netXirr.rate : null;

  const mk = (obj, total) => Object.entries(obj).map(([key,value])=>({ key, value, pct: total>0? value/total : 0 })).sort((a,b)=>b.value-a.value);
  const cityConc = mk(byCity, tpcSum);
  const typeConc = mk(byType, tpcSum);
  const fundConc = byFund.map(f=>({ ...f, pct: nav>0? f.value/nav : 0 })).sort((a,b)=>b.value-a.value);

  return {
    fundsCount: funds.length, linkedCount: linkedIds.size,
    aum, committed, calledTotal, paidIn, distPaid, nav,
    investedCapital, uninvestedCapital, grossIRR, netIRR, netXirr, portfolioMOIC,
    tpcSum, debtSum, equitySum, ltv, dscrAvg, dscrMinOverall,
    cityConc, typeConc, fundConc, blockedN,
  };
}

/* عرض Net XIRR: النسبة الرئيسية فقط عند status==='OK'. غير ذلك: اسم الحالة بلا نسبة، والتفاصيل (تحذيرات المصدر، الجذور/المرشَّحات،
   أسباب نقص البيانات) في <details>. رموز غير معروفة تبقى حرفية. */
const XIRR_STATUS_TEXT = {
  INSUFFICIENT_SOURCE_DATA: ['بيانات المصدر لا تكفي لحساب معدل للمحفظة كاملة','Source data insufficient for a whole-portfolio rate'],
  POSSIBLE_MULTIPLE_ROOTS: ['أكثر من معدل يحقق المعادلة — لا معدل واحد','More than one rate satisfies the equation — no single rate'],
  NUMERICALLY_AMBIGUOUS: ['غموض عددي — لا معدل معتمد','Numerically ambiguous — no accepted rate'],
  INSUFFICIENT_INPUT: ['بيانات نداءات/توزيعات غير كافية بعد','Not enough capital call/distribution data yet'],
  DEGENERATE_NO_TIME_SPREAD: ['بيانات نداءات/توزيعات غير كافية بعد','Not enough capital call/distribution data yet'],
  NO_SIGN_CHANGE: ['بيانات نداءات/توزيعات غير كافية بعد','Not enough capital call/distribution data yet'],
  INVALID_INPUT: ['مدخلات غير صالحة','Invalid input'],
};
const XIRR_REASON_TEXT = {
  NAV_INCOMPLETE: ['NAV غير مكتملة: أصل مرتبط لم يدخل التقدير','NAV incomplete: a linked asset is not in the estimate'],
  NAV_INVALID: ['قيمة NAV غير صالحة','NAV value invalid'],
  NAV_BASIS_UNRESOLVED: ['أساس NAV غير محسوم: equity×MOIC إجمالي متحصلات متوقعة طوال العمر وليس قيمة متبقية بتاريخ الحساب','NAV basis unresolved: equity×MOIC is total projected lifetime proceeds, not a remaining value at the as-of date'],
  REVERSAL_MEANING_UNRESOLVED: ['قيد عكسي لا يمكن تصنيفه (تصحيح أم رد نقدي)','Reversal entry cannot be classified (correction vs cash return)'],
  IN_KIND_VALUE_BASIS_UNRESOLVED: ['نداء عيني بلا أساس تقييم معتمد للمبلغ','In-kind call without a stated valuation basis'],
  INVALID_DATE: ['سجل مسدَّد بتاريخ غير صالح','Paid record with an invalid date'],
  INVALID_AMOUNT: ['سجل مسدَّد بمبلغ مفقود/غير صالح','Paid record with a missing/invalid amount'],
  NEGATIVE_AMOUNT_WITHOUT_REVERSAL: ['مبلغ سالب بلا قيد عكسي','Negative amount without a reversal link'],
  UNKNOWN_RECORD_KIND: ['نوع سجل غير معروف','Unknown record kind'],
};
const pick = (core, tbl, code) => tbl[code] ? core.T(tbl[code][0], tbl[code][1]) : code;

export function netXirrHtml(core, s, opts={}){
  const x = s && s.netXirr;
  if(!x) return '—';
  const ok = x.status==='OK' && isFinite(x.rate);
  const label = ok ? core.fmtPct(x.rate) : pick(core, XIRR_STATUS_TEXT, x.status);
  // تاريخ الحساب وتحذيرات المصدر يظهران في كل الحالات وفي كل العرضين (المحفظة ومركز القيادة)
  const asOf = x.asOfDate ? `<div class="note" data-netxirr-asof="${core.esc(x.asOfDate)}" style="font-size:11px;">${core.T('حتى','As of')} ${core.esc(x.asOfDate)}${x.asOfDateSource==='calculation-date' ? ` (${core.T('تاريخ الحساب — الرياض','calculation date — Riyadh')})` : ''}</div>` : '';
  const parts = [];
  const warn = Array.isArray(x.sourceWarnings) ? x.sourceWarnings : [];
  if(warn.length){
    parts.push(`<p class="note" style="margin:4px 0 2px;">${core.T('تحذيرات المصدر','Source warnings')} (${warn.length})</p><ul style="margin:0 0 4px; padding-inline-start:18px; font-size:11.5px;">${warn.map(w=>`<li><code>${core.esc(w.code)}</code> — ${core.esc(w.message)}</li>`).join('')}</ul>`);
  }
  if(!ok){
    if(Array.isArray(x.issues) && x.issues.length){
      parts.push(`<ul style="margin:4px 0; padding-inline-start:18px; font-size:11.5px;">${x.issues.map(i=>`<li><code>${core.esc(i.code)}</code> — ${core.esc(pick(core, XIRR_REASON_TEXT, i.code))}${i.detail?` (${core.esc(i.detail)})`:''}${(i.ids&&i.ids.length)?` — ${core.esc(i.ids.slice(0,5).join('، '))}${i.ids.length>5?' …':''}`:''}</li>`).join('')}</ul>`);
    }
    const cands = [].concat(x.roots||[], x.candidateRates||[], x.crossingRates||[], x.tangentCandidates||[]).filter(v=>isFinite(v));
    if(cands.length){
      parts.push(`<p class="note" style="margin:4px 0;">${core.T('معدلات/مرشَّحات من الحلّال — ليست عائداً معتمداً','Solver rates/candidates — not an approved return')}: ${cands.map(v=>core.fmtPct(v)).join(' · ')}</p>`);
    }
    if(x.reason) parts.push(`<p class="note" style="margin:4px 0;">${core.esc(x.reason)}</p>`);
  }
  const details = parts.length ? `<details style="margin-top:4px;"><summary class="note">${core.T('التفاصيل','Details')} <code>${core.esc(x.status)}</code></summary>${parts.join('')}</details>` : '';
  return `<span${ok?'':' class="note"'} data-netxirr-status="${core.esc(x.status)}">${core.esc(label)}</span>${asOf}${details}`;
}

export function blockedNotice(core, s){
  if(!s || !s.blockedN) return '';
  return `<div class="panel" data-blocked-excluded="${s.blockedN}" style="margin:0 0 14px; padding:10px 14px; border:1px solid var(--bad);"><b style="color:var(--bad);">⛔ ${s.blockedN} ${core.T('أصل محجوب (مدخلات غير صالحة أو ناقصة) مستثنى من كل المجاميع والمتوسطات والتركّز أدناه','blocked asset(s) (invalid or incomplete inputs) excluded from every total, average and concentration below')}</b></div>`;
}

function concTable(core, rows, label){
  if(!rows.length) return '';
  return `<div style="margin-bottom:14px;">
    <p class="step-sub" style="margin:0 0 6px;">${label}</p>
    <div class="tablewrap"><table class="db" style="font-size:12px;">
      <thead><tr><th>${label}</th><th>${core.T('القيمة','Value')}</th><th>%</th></tr></thead>
      <tbody>
        ${rows.map(r=>`<tr>
          <td>${core.esc(r.key)}</td>
          <td class="num mono">${core.fmtSAR(r.value)}</td>
          <td class="num" style="font-weight:700; color:${r.pct>=WARN_THRESHOLD?'var(--bad)':'var(--ink)'};">${core.fmtPct(r.pct)}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
  </div>`;
}

export function registerPortfolio(core){
  core.registerTopbarButton(()=>{
    if(!core.STORE.funds || !core.STORE.funds.length) return '';
    return `<button class="btn btn-sm" data-action="portfolio-open">📊 ${core.T('ذكاء المحفظة','Portfolio Intelligence')}</button>`;
  });

  core.registerMainView('portfolio', ()=>{
    const s = portfolioIntelligenceStats(core);
    return `${blockedNotice(core, s)}
    <div class="section" style="margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <div>
        <h2 style="margin:0;">📊 ${core.T('ذكاء المحفظة','Portfolio Intelligence')}</h2>
        <p class="note" style="margin:4px 0 0;">${core.T('عبر','Across')} ${s.fundsCount} ${core.T('صندوق و','fund(s) and')} ${s.linkedCount} ${core.T('أصلاً مرتبطاً','linked asset(s)')}</p>
      </div>
      <button class="btn btn-sm btn-ghost" data-action="portfolio-close">✖ ${core.T('إغلاق ورجوع للوحة الفرص','Close & return to dashboard')}</button>
    </div>

    <div class="panel" style="margin-bottom:14px;">
      <div class="panel-head"><h3>${core.T('رأس المال والتوظيف','Capital & Deployment')}</h3></div>
      <div class="kv">
        <div class="k">AUM (${core.T('إجمالي الالتزامات','Total Commitments')})</div><div class="v"><b>${core.fmtSAR(s.aum)}</b></div>
        <div class="k">${core.T('رأس المال المستثمر (منشور في أصول)','Invested Capital (Deployed)')}</div><div class="v">${core.fmtSAR(s.investedCapital)}</div>
        <div class="k">${core.T('رأس المال غير المستثمر (Dry Powder)','Uninvested Capital (Dry Powder)')}</div><div class="v">${core.fmtSAR(s.uninvestedCapital)}</div>
        <div class="k">${core.T('NAV تقديرية من الاكتتاب','Estimated Underwriting NAV')}</div><div class="v"><b>${core.fmtSAR(s.nav)}</b></div>
        <div class="k">${core.T('التوزيعات المصروفة','Distributions Paid')}</div><div class="v">${core.fmtSAR(s.distPaid)}</div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:14px;">
      <div class="panel-head"><h3>${core.T('العوائد','Returns')}</h3></div>
      <div class="kv">
        <div class="k">Gross IRR <span style="font-size:10.5px; color:var(--ink-faint);">(${core.T('على مستوى الأصول، مرجَّح بحقوق الملكية','asset-level, equity-weighted')})</span></div><div class="v">${s.grossIRR!=null? core.fmtPct(s.grossIRR): '—'}</div>
        <div class="k">Indicative Net IRR <span style="font-size:10.5px; color:var(--ink-faint);">(${core.T('تدفقات مسدَّدة بتاريخَي السجل + NAV تقديرية من الاكتتاب، ليست NAV رسمية ولا تاريخ دفع مثبت','paid ledger flows at record dates + estimated underwriting NAV, not official NAV and not proven payment dates')})</span></div><div class="v">${netXirrHtml(core, s)}</div>
        <div class="k">${core.T('مضاعف المحفظة (TVPI)','Portfolio Multiple (TVPI)')}</div><div class="v">${s.portfolioMOIC!=null? s.portfolioMOIC.toFixed(2)+'×':'—'}</div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:14px;">
      <div class="panel-head"><h3>${core.T('الدين والتغطية','Debt & Coverage')}</h3></div>
      <div class="kv">
        <div class="k">${core.T('إجمالي الدين (الأصول المرتبطة)','Total Debt (linked assets)')}</div><div class="v">${core.fmtSAR(s.debtSum)}</div>
        <div class="k">${core.T('نسبة القرض إلى القيمة (LTV)','LTV')}</div><div class="v">${s.ltv!=null? core.fmtPct(s.ltv): '—'}</div>
        <div class="k">DSCR (${core.T('متوسط مرجَّح','weighted avg')})</div><div class="v">${s.dscrAvg!=null? s.dscrAvg.toFixed(2)+'×':'—'}</div>
        <div class="k">DSCR (${core.T('الأدنى في المحفظة','portfolio minimum')})</div><div class="v" style="${s.dscrMinOverall!=null && s.dscrMinOverall<1.2 ? 'color:var(--bad); font-weight:700;':''}">${s.dscrMinOverall!=null? s.dscrMinOverall.toFixed(2)+'×':'—'}</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h3>${core.T('التركّز — حسب الصندوق / المدينة / نوع الفرصة','Concentration — by Fund / City / Opportunity Type')}</h3></div>
      ${concTable(core, s.fundConc, core.T('الصندوق','Fund'))}
      ${concTable(core, s.cityConc, core.T('المدينة','City'))}
      ${concTable(core, s.typeConc, core.T('النوع','Type'))}
      ${(!s.fundConc.length && !s.cityConc.length)? `<p class="note">${core.T('اربط فرصاً بصندوق واحد على الأقل (من صفحة الصندوق) لعرض تحليل التركّز.','Link at least one opportunity to a fund (from the fund page) to see concentration analysis.')}</p>` : ''}
    </div>`;
  });

  core.registerActionHandler(async (action)=>{
    if(action==='portfolio-open'){ core.setCoreState({ mainView:'portfolio', openDetailId:null, fundsViewOpen:false, render:true }); return true; }
    if(action==='portfolio-close'){ core.setCoreState({ mainView:null, render:true }); return true; }
    return false;
  });
}

export { portfolioIntelligenceStats, WARN_THRESHOLD };
