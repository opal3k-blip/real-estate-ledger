/* =========================================================================
   ذكاء المحفظة — Portfolio Intelligence (Phase 3، النظام الأول)
   ---------------------------------------------------------------------------
   يمتد فوق نظام "المستثمرون والصناديق" القائم أصلاً في core.js (الذي يوفّر
   بالفعل: fundLedgerSummary، fundEquityAndValue، commitmentsForFund،
   capitalCallsFor، distributionsFor) ليضيف طبقة تحليل محفظة كاملة تجمع كل
   الصناديق معاً: AUM، رأس المال المستثمر/غير المستثمر (Dry Powder)، NAV،
   Gross IRR (على مستوى الأصول)، Net IRR حقيقي (XIRR على تدفقات نداءات رأس
   المال والتوزيعات الفعلية بتواريخها الحقيقية + NAV الحالي كتدفق ختامي)،
   مضاعف المحفظة (TVPI)، الدين وLTV وDSCR، وتركّز المحفظة حسب الصندوق/المدينة/
   نوع الفرصة (يُستهلَك أيضاً من concentration-risk.js عبر تصدير
   portfolioIntelligenceStats — بلا أي تكرار للحساب).
   Net IRR هنا حساب جديد كلياً (XIRR بتواريخ فعلية) لا يكرر core.irr() (الذي
   يفترض فترات سنوية صحيحة لمحرك الجدوى لكل فرصة على حدة) — هذا تجميع محفظة
   على مستوى مختلف تماماً غير موجود في core.js أصلاً. ملاحظة حوكمة: قيمة NAV
   هنا تقديرية مشتقة من underwriting linked assets، وليست Current Independent
   Valuation رسمية إلا بعد إضافة سجل تقييم حالي مستقل للأصل. لا تعديل على منطق
   core.js الداخلي — فقط عبر نقاط التوسّع المُصدَّرة (registerMainView
   المضافة سابقاً لأجل Pipeline).
   ========================================================================= */

const WARN_THRESHOLD = 0.35;

function xirr(cashflows){
  // cashflows: [{date:'YYYY-MM-DD', amount}], مُرتَّبة بالتاريخ. Newton's method مع fallback بالتنصيف،
  // بنفس أسلوب core.js's irr() لكن بخصم حسب الأيام الفعلية (Act/365) بدل فترات سنوية صحيحة.
  if(!cashflows.length) return null;
  const t0 = new Date(cashflows[0].date+'T00:00:00').getTime();
  if(isNaN(t0)) return null;
  function npv(rate){
    return cashflows.reduce((s,cf)=>{
      const t = new Date(cf.date+'T00:00:00').getTime();
      if(isNaN(t)) return s;
      const years = (t-t0)/86400000/365;
      return s + cf.amount/Math.pow(1+rate, years);
    },0);
  }
  let r = 0.15;
  for(let i=0;i<80;i++){
    const f = npv(r);
    const df = (npv(r+1e-5)-f)/1e-5;
    if(Math.abs(df)<1e-9) break;
    const rn = r - f/df;
    if(!isFinite(rn)) break;
    if(Math.abs(rn-r)<1e-7){ r=rn; break; }
    r = rn;
  }
  if(isFinite(r) && Math.abs(npv(r))<1) return r;
  let lo=-0.95, hi=5, flo=npv(lo), fhi=npv(hi);
  if(flo*fhi>0) return null; // لا يوجد تدفقات بإشارتين مختلفتين (لا يمكن حساب IRR ذي معنى)
  for(let i=0;i<200;i++){
    const mid=(lo+hi)/2, fm=npv(mid);
    if(Math.abs(fm)<1) return mid;
    if(flo*fm<0){ hi=mid; fhi=fm; } else { lo=mid; flo=fm; }
  }
  return (lo+hi)/2;
}

function portfolioIntelligenceStats(core){
  const funds = core.STORE.funds || [];
  let aum=0, committed=0, calledTotal=0, paidIn=0, distPaid=0, nav=0;
  const cashflows = [];
  const byFund = [];
  funds.forEach(f=>{
    const s = core.fundLedgerSummary(f.id);
    aum += s.committed; committed += s.committed; calledTotal += s.called;
    paidIn += s.paidIn; distPaid += s.distPaid; nav += s.totalValue;
    byFund.push({ key: f.data.name || f.id, value: s.totalValue });
    core.capitalCallsFor(f.id).forEach(c=>{
      const amt = Number(c.data.amount)||0;
      if(c.data.status==='paid' && amt) cashflows.push({ date:c.data.callDate, amount:-Math.abs(amt) });
    });
    core.distributionsFor(f.id).forEach(d=>{
      const amt = Number(d.data.amount)||0;
      if(d.data.status==='paid' && amt) cashflows.push({ date:d.data.distDate, amount:Math.abs(amt) });
    });
  });

  const linkedIds = new Set();
  funds.forEach(f=> (f.data.assetIds||[]).forEach(id=>linkedIds.add(id)));
  let tpcSum=0, debtSum=0, equitySum=0;
  let irrWeighted=0, irrWeight=0;
  let dscrWeighted=0, dscrWeight=0, dscrMinOverall=null;
  const byCity={}, byType={};
  linkedIds.forEach(id=>{
    const rec = core.opportunities.find(o=>o.id===id);
    if(!rec) return;
    let c; try{ c = core.compute(rec.data); }catch(e){ return; }
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

  let netIRR = null;
  if(cashflows.length){
    const withTerminal = cashflows.slice().sort((a,b)=> a.date<b.date?-1:1);
    withTerminal.push({ date: core.todayStr(), amount: nav });
    netIRR = xirr(withTerminal);
  }

  const mk = (obj, total) => Object.entries(obj).map(([key,value])=>({ key, value, pct: total>0? value/total : 0 })).sort((a,b)=>b.value-a.value);
  const cityConc = mk(byCity, tpcSum);
  const typeConc = mk(byType, tpcSum);
  const fundConc = byFund.map(f=>({ ...f, pct: nav>0? f.value/nav : 0 })).sort((a,b)=>b.value-a.value);

  return {
    fundsCount: funds.length, linkedCount: linkedIds.size,
    aum, committed, calledTotal, paidIn, distPaid, nav,
    investedCapital, uninvestedCapital, grossIRR, netIRR, portfolioMOIC,
    tpcSum, debtSum, equitySum, ltv, dscrAvg, dscrMinOverall,
    cityConc, typeConc, fundConc,
  };
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
    return `
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
        <div class="k">Indicative Net IRR <span style="font-size:10.5px; color:var(--ink-faint);">(${core.T('تدفقات فعلية + NAV تقديرية من الاكتتاب، ليست NAV رسمية','actual calls/distributions + estimated underwriting NAV, not official NAV')})</span></div><div class="v">${s.netIRR!=null? core.fmtPct(s.netIRR): `<span class="note">${core.T('بيانات نداءات/توزيعات غير كافية بعد','Not enough capital call/distribution data yet')}</span>`}</div>
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
