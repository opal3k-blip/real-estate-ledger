/* =========================================================================
   مركز القيادة الاستثماري — OPAL Investment Command Center
   (Phase 3، النظام الرابع)
   ---------------------------------------------------------------------------
   شاشة تجميعية واحدة (Main View اختياري عبر زر شريط علوي — بلا تعديل على
   شاشة اللوحة الافتراضية في core.js) تجمع أربعة أنظمة مبنية مسبقاً في مكان
   واحد قابل للمسح البصري السريع: Pipeline (عدد الفرص لكل مرحلة، مستورَد من
   pipeline.js)، Capital (AUM/Invested/Uninvested/NAV/Debt، مستورَد من
   portfolio.js)، IC (قرارات معلّقة، قراءة مباشرة من ic.decisions)، وAlerts
   (أهم التنبيهات، مستورَدة من alerts.js). لا حساب جديد هنا إطلاقاً — تجميع
   عرضي بحت لأنظمة قائمة، بلا أي تكرار منطقي. لا تعديل على منطق core.js
   الداخلي.
   ========================================================================= */

import { PIPELINE_STAGES, stageLabel } from './pipeline.js';
import { portfolioIntelligenceStats } from './portfolio.js';
import { computeAlerts } from './alerts.js';

function pipelineCounts(core){
  const counts = {};
  PIPELINE_STAGES.forEach(s=> counts[s.key]=0);
  core.opportunities.forEach(rec=>{
    const d = core.withDefaults(rec.data);
    const stage = (d.pipeline && d.pipeline.stage) || 'lead';
    counts[stage] = (counts[stage]||0)+1;
  });
  return counts;
}
function icPendingCounts(core){
  let awaitingReview=0, holdRevise=0;
  core.opportunities.forEach(rec=>{
    const d = core.withDefaults(rec.data);
    const decisions = (d.ic && d.ic.decisions) || [];
    const latest = decisions.length? decisions[decisions.length-1] : null;
    if(d.pipeline && d.pipeline.stage==='ic_review' && !decisions.length) awaitingReview++;
    if(latest && (latest.decision==='hold' || latest.decision==='revise')) holdRevise++;
  });
  return { awaitingReview, holdRevise };
}

export function registerCommandCenter(core){
  core.registerTopbarButton(()=>`<button class="btn btn-sm" data-action="cc-open">🎯 ${core.T('مركز القيادة','Command Center')}</button>`);

  core.registerMainView('commandCenter', ()=>{
    const pc = pipelineCounts(core);
    const activeTotal = core.opportunities.length - (pc.archived||0);
    const s = portfolioIntelligenceStats(core);
    const ic = icPendingCounts(core);
    const alerts = computeAlerts(core);
    const topAlerts = alerts.slice(0,8);
    const sevIcon = { high:'🔴', medium:'🟡', low:'⚪' };

    return `
    <div class="section" style="margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <div>
        <h2 style="margin:0;">🎯 ${core.T('مركز القيادة الاستثماري','OPAL Investment Command Center')}</h2>
        <p class="note" style="margin:4px 0 0;">${core.T('نظرة شاملة سريعة — بدون تفاصيل، بحاجة لتفاصيل افتح لوحة الفرص أو أي نظام من الأعلى',"Fast bird's-eye view — for detail, open the opportunities table or any system above")}</p>
      </div>
      <button class="btn btn-sm btn-ghost" data-action="cc-close">✖ ${core.T('إغلاق ورجوع للوحة الفرص','Close & return to dashboard')}</button>
    </div>

    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(260px,1fr)); gap:14px; margin-bottom:14px;">
      <div class="panel">
        <div class="panel-head"><h3>🧭 ${core.T('خط الأنابيب','Pipeline')}</h3></div>
        <p class="note" style="margin:0 0 8px;">${core.T('نشطة (غير مؤرشفة)','Active (non-archived)')}: <b>${activeTotal}</b></p>
        <div style="display:flex; flex-direction:column; gap:5px;">
          ${PIPELINE_STAGES.filter(st=>st.key!=='archived').map(st=>`
            <div style="display:flex; align-items:center; gap:8px; font-size:12px;">
              <span style="width:8px; height:8px; border-radius:50%; background:${st.color}; flex:0 0 auto;"></span>
              <span style="flex:1;">${stageLabel(core, st.key)}</span>
              <b class="mono">${pc[st.key]||0}</b>
            </div>`).join('')}
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>💰 ${core.T('رأس المال','Capital')}</h3></div>
        <div class="kv">
          <div class="k">${core.T('الأصول تحت الإدارة (AUM)','AUM')}</div><div class="v">${core.fmtSAR(s.aum)}</div>
          <div class="k">${core.T('مستثمر','Invested')}</div><div class="v">${core.fmtSAR(s.investedCapital)}</div>
          <div class="k">${core.T('متاح تقديري (سيولة جاهزة للاستثمار)','Estimated Available (Dry Powder)')}</div><div class="v">${core.fmtSAR(s.uninvestedCapital)}</div>
          <div class="k">${core.T('NAV تقديرية من الاكتتاب','Estimated Underwriting NAV')}</div><div class="v"><b>${core.fmtSAR(s.nav)}</b></div>
          <div class="k">${core.T('الدين','Debt')}</div><div class="v">${core.fmtSAR(s.debtSum)}</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>🏛️ ${core.T('لجنة الاستثمار','Investment Committee')}</h3></div>
        <div class="kv">
          <div class="k">${core.T('بانتظار مراجعة اللجنة','Awaiting IC Review')}</div><div class="v" style="${ic.awaitingReview>0?'color:var(--bad); font-weight:700;':''}">${ic.awaitingReview}</div>
          <div class="k">${core.T('معلّقة (تعليق/مراجعة)','Pending (Hold/Revise)')}</div><div class="v" style="${ic.holdRevise>0?'color:#f59e0b; font-weight:700;':''}">${ic.holdRevise}</div>
        </div>
        <p class="step-sub" style="margin:14px 0 6px;">${core.T('العوائد على مستوى المحفظة','Portfolio-level Returns')}</p>
        <div class="kv">
          <div class="k">${core.T('العائد الإجمالي (Gross IRR)','Gross IRR')}</div><div class="v">${s.grossIRR!=null? core.fmtPct(s.grossIRR): '—'}</div>
          <div class="k">${core.T('العائد الصافي الاسترشادي (Net IRR)','Indicative Net IRR')}</div><div class="v">${s.netIRR!=null? core.fmtPct(s.netIRR): '—'}</div>
          <div class="k">${core.T('إجمالي القيمة إلى المدفوع (TVPI)','TVPI')}</div><div class="v">${s.portfolioMOIC!=null? s.portfolioMOIC.toFixed(2)+'×':'—'}</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>🔔 ${core.T('التنبيهات','Alerts')} <span class="tag" style="margin-inline-start:6px;">${alerts.length}</span></h3></div>
        ${topAlerts.length? `
        <div style="display:flex; flex-direction:column; gap:6px;">
          ${topAlerts.map(a=>`
            <div class="card" style="padding:7px 9px; cursor:pointer; border:1px solid var(--border); border-radius:8px;" data-action="cc-view-opp" data-id="${a.oppId}">
              <div style="font-size:11.5px; line-height:1.5;">${sevIcon[a.severity]} <b>${core.esc(a.name)}</b> — ${core.esc(a.kind)}</div>
              <div style="font-size:11px; color:var(--ink-faint); margin-top:2px;">${core.esc(a.message)}</div>
            </div>`).join('')}
        </div>
        ${alerts.length>topAlerts.length? `<p class="note" style="margin:8px 0 0;">+${alerts.length-topAlerts.length} ${core.T('تنبيهاً إضافياً','more alert(s)')}</p>`:''}
        ` : `<p class="note">✅ ${core.T('لا توجد تنبيهات حالياً','No alerts at this time')}</p>`}
      </div>
    </div>`;
  });

  core.registerActionHandler(async (action, el)=>{
    if(action==='cc-open'){ core.setCoreState({ mainView:'commandCenter', openDetailId:null, fundsViewOpen:false, render:true }); return true; }
    if(action==='cc-close'){ core.setCoreState({ mainView:null, render:true }); return true; }
    if(action==='cc-view-opp'){
      // ملاحظة هندسية: action 'open-detail' المدمج في core.js يضبط openDetailId لكن لا يصفّر mainView
      // (كان مصمَّماً أصلاً فقط للوحة الافتراضية) — فلو mainView لا يزال مضبوطاً (هنا 'commandCenter')
      // ستستمر renderActiveMainView() في تجاوز عرض التفاصيل. الحل: نصفّر mainView صراحة هنا قبل فتح التفاصيل.
      core.setCoreState({ mainView:null, openDetailId: el.dataset.id, render:true });
      return true;
    }
    return false;
  });
}
