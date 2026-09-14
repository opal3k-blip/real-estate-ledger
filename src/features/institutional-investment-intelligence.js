/* =========================================================================
   محرك الذكاء الاستثماري المؤسسي — Institutional Investment Intelligence
   ---------------------------------------------------------------------------
   طبقة مؤسسية موحّدة لا تغيّر محرك الحساب الأساسي، بل تجمع
   النتائج الحالية، سجل الإصدارات، الأداء الفعلي، أدلة العناية الواجبة، وسجل
   قرارات اللجنة في لوحة واحدة + Investment Passport لكل أصل.
   ========================================================================= */

import { computeInvestmentScore, scoreBand } from './investment-score.js';
import { computeDecisionConfidence } from './decision-confidence.js';
import { computeAlerts } from './alerts.js';
import { portfolioIntelligenceStats } from './portfolio.js';
import { ddStats, defaultItemsDict } from './due-diligence.js';
import { evidenceCoverageStats } from './evidence-tracking.js';
import { icReadiness } from './ic-decision-gate.js';

const UW_COLLECTION = 'underwritingVersions';
const ACTUALS_COLLECTION = 'assetActuals';

function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
function safeNum(v, fallback=null){ const n = Number(v); return isFinite(n) ? n : fallback; }
let _iiiCoreRef=null;
function pctPoint(v){ if(v==null || !isFinite(v)) return '—'; const n=(v*100).toFixed(1); return (_iiiCoreRef&&_iiiCoreRef.LANG==='en')? n+'%' : '%'+n; }
function ratio(v){ return v==null || !isFinite(v) ? '—' : Number(v).toFixed(2)+'×'; }
function median(vals){
  const a = vals.filter(v=>v!=null && isFinite(v)).sort((x,y)=>x-y);
  if(!a.length) return null;
  const m = Math.floor(a.length/2);
  return a.length%2 ? a[m] : (a[m-1]+a[m])/2;
}
function escJoin(core, rows){ return rows.filter(Boolean).map(x=>core.esc(String(x))).join(' · '); }

function riskMaxScore(d){
  const items = (d.risk && d.risk.items) || {};
  const vals = Object.values(items).map(it=> (Number(it.probability)||1) * (Number(it.impact)||1));
  return vals.length ? Math.max(...vals) : 1;
}
function riskBand(score){
  if(score>=15) return { key:'high', ar:'مرتفعة', en:'High', color:'var(--bad)' };
  if(score>=7) return { key:'medium', ar:'متوسطة', en:'Medium', color:'var(--warn)' };
  return { key:'low', ar:'منخفضة', en:'Low', color:'var(--good)' };
}

function latestByDate(rows, field){
  return rows.slice().sort((a,b)=> String(b.data[field]||'').localeCompare(String(a.data[field]||'')))[0] || null;
}
function versionsFor(core, oppId){
  return (core.STORE[UW_COLLECTION] || []).filter(v=>v.data.oppId===oppId)
    .slice().sort((a,b)=> String(a.data.savedAt||'').localeCompare(String(b.data.savedAt||'')));
}
function actualsFor(core, oppId){
  return (core.STORE[ACTUALS_COLLECTION] || []).filter(v=>v.data.oppId===oppId)
    .slice().sort((a,b)=> String(a.data.asOfDate||'').localeCompare(String(b.data.asOfDate||'')));
}
function baselineFor(core, oppId){
  const versions = versionsFor(core, oppId);
  const v4 = versions.filter(v=>v.data.stage==='v4_ic_approved').pop();
  return v4 || versions[0] || null;
}
function latestActualFor(core, oppId){ return latestByDate(actualsFor(core, oppId), 'asOfDate'); }

function executionConfidence(core, d, c){
  const dd = ddStats((d.dd && d.dd.items) || defaultItemsDict());
  const risk = riskMaxScore(d);
  const latestDecision = ((d.ic && d.ic.decisions) || []).slice(-1)[0] || null;
  const capReady = d.capitalAllocation && safeNum(d.capitalAllocation.targetEquity, 0) > 0;
  const pipelineReady = d.pipeline && d.pipeline.stage && d.pipeline.stage !== 'intake';
  const dscrOk = c.dscrMin==null || !isFinite(c.dscrMin) || c.dscrMin >= (d.criteria.dscrMin || 1.2);
  let score = 40;
  score += clamp((dd.pct || 0)*30, 0, 30);
  score += clamp((25-risk)/24*20, 0, 20);
  if(latestDecision && ['approve','approve_conditions'].includes(latestDecision.decision)) score += 10;
  if(capReady) score += 8;
  if(pipelineReady) score += 5;
  if(dscrOk) score += 7;
  score = clamp(score, 0, 100);
  const blockers = [];
  if(dd.criticalPending) blockers.push(`${dd.criticalPending} DD critical pending`);
  if(risk>=15) blockers.push('High risk register item');
  if(!capReady) blockers.push('No target capital allocation');
  if(!dscrOk) blockers.push('DSCR below threshold');
  return { score, band: confidenceBand(score), blockers, dd, risk };
}
function confidenceBand(score){
  if(score>=80) return { key:'high', ar:'مرتفعة', en:'High', color:'var(--good)' };
  if(score>=60) return { key:'moderate', ar:'متوسطة', en:'Moderate', color:'var(--warn)' };
  return { key:'low', ar:'منخفضة', en:'Low', color:'var(--bad)' };
}
function confidenceSuite(core, d, c){
  const iq = computeInvestmentScore(core, d, c);
  const dc = computeDecisionConfidence(core, d);
  const ex = executionConfidence(core, d, c);
  const ev = evidenceCoverageStats(core, d);
  const evidenceScore = Math.round((ev.pct || 0)*0.55 + (ev.verifiedPct || 0)*0.45);
  return {
    investmentQuality: { score: iq.composite, band: scoreBand(iq.composite), raw: iq },
    decisionConfidence: dc,
    executionConfidence: ex,
    evidenceConfidence: { score: evidenceScore, band: confidenceBand(evidenceScore), ev },
  };
}

function opportunityIntelligenceRows(core){
  return core.opportunities.map(rec=>{
    const d = core.withDefaults(rec.data);
    let c = {};
    try{ c = core.compute(d); }catch(e){ c = {}; }
    const suite = confidenceSuite(core, d, c);
    const riskScore = riskMaxScore(d);
    const actual = latestActualFor(core, rec.id);
    const baseline = baselineFor(core, rec.id);
    return { rec, d, c, suite, riskScore, risk: riskBand(riskScore), actual, baseline };
  });
}

function stressClone(d, kind){
  const x = JSON.parse(JSON.stringify(d));
  if(kind==='interest_up'){
    x.financing.saibor = safeNum(x.financing.saibor,0) + 0.02;
  } else if(kind==='occupancy_down'){
    x.income.occupancy = clamp(safeNum(x.income.occupancy,1) - 0.10, 0, 1);
  } else if(kind==='exit_cap_up'){
    x.development.exitCapRate = safeNum(x.development.exitCapRate,0.08) + 0.01;
  } else if(kind==='construction_up'){
    x.development.buildCost = safeNum(x.development.buildCost,0) * 1.15;
  } else if(kind==='worst_case'){
    x.financing.saibor = safeNum(x.financing.saibor,0) + 0.02;
    x.income.occupancy = clamp(safeNum(x.income.occupancy,1) - 0.10, 0, 1);
    x.development.exitCapRate = safeNum(x.development.exitCapRate,0.08) + 0.01;
    x.development.buildCost = safeNum(x.development.buildCost,0) * 1.15;
    x.development.salePrice = safeNum(x.development.salePrice,0) * 0.93;
  } else if(kind==='best_case'){
    x.financing.saibor = Math.max(0, safeNum(x.financing.saibor,0) - 0.01);
    x.income.occupancy = clamp(safeNum(x.income.occupancy,1) + 0.05, 0, 1);
    x.development.exitCapRate = Math.max(0.01, safeNum(x.development.exitCapRate,0.08) - 0.005);
    x.development.buildCost = safeNum(x.development.buildCost,0) * 0.95;
    x.development.salePrice = safeNum(x.development.salePrice,0) * 1.05;
  }
  return x;
}
function weightedPortfolioIrr(core, rows, kind=null){
  let num=0, den=0, dscrNum=0, dscrDen=0, moicNum=0, moicDen=0;
  rows.forEach(r=>{
    const d = kind ? stressClone(r.d, kind) : r.d;
    let c; try{ c = core.compute(d); }catch(e){ return; }
    const w = safeNum(c.equity,0) || safeNum(c.TPC,0);
    if(w>0 && isFinite(c.equityIRR)){ num += c.equityIRR*w; den += w; }
    if(w>0 && isFinite(c.MOIC)){ moicNum += c.MOIC*w; moicDen += w; }
    if(w>0 && c.dscrMin!=null && isFinite(c.dscrMin)){ dscrNum += c.dscrMin*w; dscrDen += w; }
  });
  return {
    irr: den ? num/den : null,
    moic: moicDen ? moicNum/moicDen : null,
    dscr: dscrDen ? dscrNum/dscrDen : null,
  };
}

function portfolioStressRows(core, rows){
  const base = weightedPortfolioIrr(core, rows);
  const cases = [
    ['interest_up', 'الفائدة +2%', 'Interest +2%'],
    ['occupancy_down', 'الإشغال -10%', 'Occupancy -10%'],
    ['exit_cap_up', 'Exit Cap +100 bps', 'Exit Cap +100 bps'],
    ['construction_up', 'تكلفة الإنشاء +15%', 'Construction +15%'],
    ['worst_case', 'Worst Case', 'Worst Case'],
    ['best_case', 'Best Case', 'Best Case'],
  ];
  return cases.map(([key, ar, en])=>{
    const s = weightedPortfolioIrr(core, rows, key);
    return { key, ar, en, base, stressed:s, delta: s.irr!=null && base.irr!=null ? s.irr-base.irr : null };
  });
}

function allocationOptimizer(core, rows){
  const p = portfolioIntelligenceStats(core);
  const linkedIds = new Set();
  (core.STORE.funds || []).forEach(f => (f.data.assetIds || []).forEach(id=>linkedIds.add(id)));
  let remaining = Math.max(0, safeNum(p.uninvestedCapital, 0));
  const candidates = rows.map(r=>{
    const need = safeNum(r.d.capitalAllocation && r.d.capitalAllocation.targetEquity, null) || safeNum(r.c.equity, 0);
    const max = safeNum(r.d.capitalAllocation && r.d.capitalAllocation.maxAllocation, null);
    const riskPenalty = r.riskScore>=15 ? 0.55 : r.riskScore>=7 ? 0.8 : 1;
    const quality = r.suite.investmentQuality.score;
    const confidence = r.suite.decisionConfidence.score;
    const ret = isFinite(r.c.equityIRR) ? r.c.equityIRR : 0;
    const priority = ((r.d.capitalAllocation||{}).priority === 'urgent') ? 1.12 : ((r.d.capitalAllocation||{}).priority === 'high') ? 1.06 : 1;
    const rank = quality * 0.45 + confidence * 0.25 + clamp(ret*100, -50, 50) * 0.30;
    return {
      id:r.rec.id, name:r.d.meta.name || r.rec.id, city:r.d.meta.city, need, max,
      score:quality, confidence, ret, risk:r.risk, riskScore:r.riskScore,
      marginal:(ret * riskPenalty * priority) || 0,
      linked: linkedIds.has(r.rec.id),
      rank: rank * riskPenalty * priority,
    };
  }).filter(x=>x.need>0 && !x.linked).sort((a,b)=> b.rank-a.rank);
  const recs = candidates.map(x=>{
    const cap = Math.min(x.need, x.max || x.need, remaining);
    remaining -= cap;
    return { ...x, recommended: Math.max(0, cap), remainingAfter: remaining };
  });
  return { availableEquity: Math.max(0, safeNum(p.uninvestedCapital, 0)), recommendations: recs, remaining };
}

function earlyWarnings(core, rows){
  const alerts = computeAlerts(core).map(a=>({
    severity:a.severity==='high'?'critical':a.severity==='medium'?'warning':'info',
    oppId:a.oppId, name:a.name, metric:a.kind, message:a.message, action:'Review IC',
  }));
  rows.forEach(r=>{
    const actual = r.actual && r.actual.data;
    const base = r.baseline && r.baseline.data && r.baseline.data.metrics;
    if(actual && base){
      if(base.dscrMin!=null && actual.actualDSCR!=null && actual.actualDSCR < base.dscrMin){
        alerts.push({ severity:'critical', oppId:r.rec.id, name:r.d.meta.name||r.rec.id, metric:'DSCR', message:`Actual DSCR ${actual.actualDSCR.toFixed(2)}× below IC baseline ${base.dscrMin.toFixed(2)}×`, action:'Review IC' });
      }
      if(base.equityIRR!=null && actual.actualEquityIRR!=null && actual.actualEquityIRR < base.equityIRR - 0.03){
        alerts.push({ severity:'warning', oppId:r.rec.id, name:r.d.meta.name||r.rec.id, metric:'IRR', message:`Actual IRR ${pctPoint(actual.actualEquityIRR)} is more than 300 bps below baseline ${pctPoint(base.equityIRR)}`, action:'Update recovery plan' });
      }
      if(base.MOIC!=null && actual.actualMOIC!=null && actual.actualMOIC < base.MOIC * 0.9){
        alerts.push({ severity:'warning', oppId:r.rec.id, name:r.d.meta.name||r.rec.id, metric:'MOIC', message:`Actual MOIC ${ratio(actual.actualMOIC)} is >10% below baseline ${ratio(base.MOIC)}`, action:'Reforecast exit' });
      }
    }
    const dd = (r.d.dd && r.d.dd.items) || {};
    Object.values(dd).forEach(item=>{
      if(item && item.dueDate && item.dueDate < core.todayStr() && item.status !== 'completed'){
        alerts.push({ severity:item.severity==='critical'?'critical':'warning', oppId:r.rec.id, name:r.d.meta.name||r.rec.id, metric:'DD', message:`DD expired: ${item.title || item.name || item.dueDate}`, action:'Refresh evidence' });
      }
    });
  });
  const order = { critical:0, warning:1, info:2 };
  return alerts.sort((a,b)=> order[a.severity]-order[b.severity]);
}

function knowledgeStats(core, rows){
  const irrVar=[], moicVar=[], dscrVar=[], priceVar=[];
  rows.forEach(r=>{
    const actual = r.actual && r.actual.data;
    const base = r.baseline && r.baseline.data && r.baseline.data.metrics;
    if(!actual || !base) return;
    if(actual.actualEquityIRR!=null && base.equityIRR!=null) irrVar.push(actual.actualEquityIRR - base.equityIRR);
    if(actual.actualMOIC!=null && base.MOIC!=null) moicVar.push(actual.actualMOIC - base.MOIC);
    if(actual.actualDSCR!=null && base.dscrMin!=null) dscrVar.push(actual.actualDSCR - base.dscrMin);
    if(actual.actualPrice!=null && base.price!=null) priceVar.push((actual.actualPrice - base.price) / base.price);
  });
  const medIrr = median(irrVar);
  const medPrice = median(priceVar);
  const recContingency = clamp(0.05 + Math.max(0, medPrice || 0) * 0.8 + Math.max(0, -(medIrr || 0)) * 0.5, 0.05, 0.15);
  return { sample: Math.max(irrVar.length, moicVar.length, dscrVar.length, priceVar.length), medIrr, medMoic:median(moicVar), medDscr:median(dscrVar), medPrice, recContingency };
}

function formulaValidation(core, rows){
  const checks = [];
  rows.forEach(r=>{
    const c = r.c;
    const name = r.d.meta.name || r.rec.id;
    if(c.TPC!=null && c.debt!=null && c.equity!=null){
      const diff = Math.abs((c.debt + c.equity) - c.TPC);
      checks.push({ name, check:'Debt + Equity = TPC', pass: diff <= Math.max(1, c.TPC*0.001), detail: core.fmtSAR(diff), kpi:'TPC / Equity / Debt' });
    }
    if(c.MOIC!=null && c.investorCashInvested!=null && c.totalDistrib!=null && c.investorCashInvested>0){
      const expected = c.totalDistrib / c.investorCashInvested;
      checks.push({ name, check:'MOIC = Total Distributions / Total Contributed Equity', pass: Math.abs(expected-c.MOIC) <= 0.01, detail: `${ratio(c.MOIC)} vs ${ratio(expected)}`, kpi:'MOIC/PIC' });
    }
    if(c.projectCF && c.totalYears!=null){
      checks.push({ name, check:'Cash-flow length matches model years', pass: c.projectCF.length >= Math.max(1, Number(c.totalYears)||1), detail:`${c.projectCF.length} rows`, kpi:'IRR / NPV' });
    }
  });
  return checks;
}

function thesisValidation(core, row){
  const thesis = String(row.d.thesis || '').trim();
  const latestActual = row.actual && row.actual.data;
  const base = row.baseline && row.baseline.data && row.baseline.data.metrics;
  if(!thesis) return { status:'missing', valid:null, reason:core.T('لا توجد أطروحة محفوظة بعد.','No saved thesis yet.') };
  if(!latestActual || !base) return { status:'pending', valid:null, reason:core.T('الأطروحة محفوظة، لكن لا توجد baseline/actuals كافية للتحقق النهائي.','Thesis saved, but baseline/actuals are not sufficient for final validation yet.') };
  const okIrr = latestActual.actualEquityIRR==null || base.equityIRR==null || latestActual.actualEquityIRR >= base.equityIRR - 0.02;
  const okMoic = latestActual.actualMOIC==null || base.MOIC==null || latestActual.actualMOIC >= base.MOIC * 0.92;
  const okDscr = latestActual.actualDSCR==null || base.dscrMin==null || latestActual.actualDSCR >= Math.min(base.dscrMin, row.d.criteria.dscrMin || base.dscrMin);
  const valid = okIrr && okMoic && okDscr;
  return {
    status: valid ? 'valid' : 'challenged',
    valid,
    reason: valid
      ? core.T('الأداء الفعلي لا يكسر أطروحة اللجنة مقارنة بالـbaseline المعتمد.','Actual performance does not break the IC thesis versus the approved baseline.')
      : core.T('يوجد انحراف فعلي مؤثر عن baseline المعتمد؛ يلزم تحديث الأطروحة أو إعادة العرض على اللجنة.','Actual performance materially diverges from the approved baseline; update the thesis or replay to IC.'),
  };
}

function aiChallenge(core, row){
  const d = row.d, c = row.c;
  const reasons = [];
  if(row.riskScore>=15) reasons.push(core.T('سجل المخاطر يحتوي بنداً مرتفعاً قد يبرر رفض الصفقة.','Risk register includes a high-risk item that may justify rejecting the deal.'));
  if(c.dscrMin!=null && c.dscrMin < (d.criteria.dscrMin || 1.2)) reasons.push(core.T('DSCR دون حد اللجنة، ما يعني هشاشة خدمة الدين.','DSCR is below IC threshold, indicating debt-service fragility.'));
  if(isFinite(c.equityIRR) && c.equityIRR < (d.criteria.irrMin || 0.12)) reasons.push(core.T('العائد على حقوق الملكية دون الحد الأدنى المطلوب.','Equity IRR is below the required threshold.'));
  if(row.suite.decisionConfidence.score < 60) reasons.push(core.T('ثقة القرار منخفضة: البيانات/الأدلة/العناية الواجبة لا تدعم قراراً نهائياً بعد.','Decision Confidence is low: data/evidence/DD do not yet support a final decision.'));
  if(row.suite.evidenceConfidence.score < 60) reasons.push(core.T('الأرقام الحرجة ليست موثقة أو متحققة بما يكفي.','Critical figures are not sufficiently sourced or verified.'));
  if(!d.thesis) reasons.push(core.T('لا توجد أطروحة استثمارية مكتوبة يمكن اختبارها لاحقاً.','No written investment thesis exists to test later.'));
  if(!baselineFor(core, row.rec.id)) reasons.push(core.T('لا توجد baseline موثقة بالإصدارات للمقارنة المستقبلية.','No versioned baseline exists for future comparison.'));
  if(!latestActualFor(core, row.rec.id)) reasons.push(core.T('لا يوجد أداء فعلي مسجل، وبالتالي لا يمكن إثبات صحة الأطروحة.','No actual performance entry exists, so thesis validation is not yet possible.'));
  if(safeNum(d.capitalAllocation && d.capitalAllocation.targetEquity,0)<=0) reasons.push(core.T('لا يوجد تخصيص رأس مال مستهدف يربط القرار بدفتر الصندوق.','No target capital allocation links the decision to the fund ledger.'));
  if(!((d.ic && d.ic.decisions)||[]).length) reasons.push(core.T('لا يوجد قرار لجنة استثمار مسجل.','No IC decision is recorded.'));
  while(reasons.length<10) reasons.push(core.T('اطلب دليلاً مستقلاً إضافياً قبل الاعتماد النهائي.','Require additional independent evidence before final approval.'));
  return reasons.slice(0,10);
}

function kv(core, pairs){
  return `<div class="kv">${pairs.map(([k,v])=>`<div class="k">${k}</div><div class="v">${v}</div>`).join('')}</div>`;
}
function miniScore(core, title, item){
  const band = item.band || confidenceBand(item.score);
  return `<div style="padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--surface);">
    <div class="k" style="margin-bottom:2px;">${title}</div>
    <div style="font-size:20px;font-weight:800;color:${band.color};">${Number(item.score||0).toFixed(0)}/100</div>
    <div class="note" style="margin:0;">${core.T(band.ar || band.key, band.en || band.key)}</div>
  </div>`;
}

function renderInstitutionalInvestmentIntelligenceDashboard(core){
  const rows = opportunityIntelligenceRows(core);
  const p = portfolioIntelligenceStats(core);
  const stress = portfolioStressRows(core, rows);
  const optimizer = allocationOptimizer(core, rows);
  const warnings = earlyWarnings(core, rows);
  const knowledge = knowledgeStats(core, rows);
  const formulas = formulaValidation(core, rows);
  const failedFormulas = formulas.filter(x=>!x.pass);
  const top = rows.slice().sort((a,b)=> b.suite.investmentQuality.score-a.suite.investmentQuality.score).slice(0,5);
  const worst = rows.slice().sort((a,b)=> a.suite.executionConfidence.score-b.suite.executionConfidence.score).slice(0,5);

  return `
  <div class="section" style="margin-bottom:14px;display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;">
    <div>
      <h2 style="margin:0;">🧠 ${core.T('محرك الذكاء الاستثماري المؤسسي','Institutional Investment Intelligence Engine')}</h2>
      <p class="note" style="margin:4px 0 0;">${core.T('لوحة واحدة تجمع القرار، المحفظة، التخصيص، التحذير المبكر، التعلم المؤسسي، والتقارير من نفس البيانات.','One layer for decision intelligence, portfolio analytics, allocation, warnings, institutional learning, and reporting from the same data.')}</p>
    </div>
    <button class="btn btn-sm btn-ghost" data-action="institutional-intelligence-close">✖ ${core.T('إغلاق','Close')}</button>
  </div>

  <div class="panel" style="margin-bottom:14px;">
    <div class="panel-head"><h3>${core.T('Investment Intelligence Engine','Investment Intelligence Engine')}</h3></div>
    <div class="grid3">
      ${miniScore(core, 'Investment Quality', { score: median(rows.map(r=>r.suite.investmentQuality.score)) || 0, band: confidenceBand(median(rows.map(r=>r.suite.investmentQuality.score)) || 0) })}
      ${miniScore(core, 'Decision Confidence', { score: median(rows.map(r=>r.suite.decisionConfidence.score)) || 0, band: confidenceBand(median(rows.map(r=>r.suite.decisionConfidence.score)) || 0) })}
      ${miniScore(core, 'Execution Confidence', { score: median(rows.map(r=>r.suite.executionConfidence.score)) || 0, band: confidenceBand(median(rows.map(r=>r.suite.executionConfidence.score)) || 0) })}
    </div>
    <div class="tablewrap" style="margin-top:10px;"><table class="db" style="font-size:12px;"><thead><tr><th>${core.T('الفرصة','Opportunity')}</th><th>Quality</th><th>Decision</th><th>Execution</th><th>Evidence</th><th>${core.T('لماذا؟','Why?')}</th></tr></thead><tbody>
      ${rows.map(r=>`<tr>
        <td><button class="btn btn-sm btn-ghost" data-action="institutional-intelligence-open-opp" data-id="${r.rec.id}">${core.esc(r.d.meta.name||r.rec.id)}</button></td>
        <td class="num">${r.suite.investmentQuality.score.toFixed(0)}</td>
        <td class="num">${r.suite.decisionConfidence.score.toFixed(0)}</td>
        <td class="num">${r.suite.executionConfidence.score.toFixed(0)}</td>
        <td class="num">${r.suite.evidenceConfidence.score.toFixed(0)}</td>
        <td>${escJoin(core, [
          isFinite(r.c.equityIRR) ? `IRR ${pctPoint(r.c.equityIRR)}` : '',
          `Risk ${r.risk.en}`,
          r.suite.decisionConfidence.blockers.length ? r.suite.decisionConfidence.blockers.map(b=>b.en).join(', ') : 'No critical blocker',
        ])}</td>
      </tr>`).join('')}
    </tbody></table></div>
  </div>

  <div class="panel" style="margin-bottom:14px;">
    <div class="panel-head"><h3>${core.T('Portfolio Intelligence','Portfolio Intelligence')}</h3></div>
    ${kv(core, [
      [core.T('NAV تقديرية من الاكتتاب','Estimated Underwriting NAV'), core.fmtSAR(p.nav)],
      ['AUM / Committed', core.fmtSAR(p.committed)],
      ['Drawn / Paid-in', core.fmtSAR(p.paidIn)],
      ['Remaining Capital', core.fmtSAR(p.uninvestedCapital)],
      ['Average IRR', p.grossIRR!=null? pctPoint(p.grossIRR):'—'],
      ['Average MOIC', p.portfolioMOIC!=null? ratio(p.portfolioMOIC):'—'],
      ['Average DSCR', p.dscrAvg!=null? ratio(p.dscrAvg):'—'],
      ['Average LTV', p.ltv!=null? pctPoint(p.ltv):'—'],
    ])}
    <div class="grid3" style="margin-top:10px;">
      <div class="note">Top Performers: ${top.map(r=>core.esc(r.d.meta.name||r.rec.id)).join(' · ') || '—'}</div>
      <div class="note">Worst Execution: ${worst.map(r=>core.esc(r.d.meta.name||r.rec.id)).join(' · ') || '—'}</div>
      <div class="note">${core.T('أهم المخاطر','Top Risks')}: ${warnings.slice(0,5).map(w=>core.esc(w.name)).join(' · ') || '—'}</div>
    </div>
  </div>

  <div class="panel" style="margin-bottom:14px;">
    <div class="panel-head"><h3>${core.T('محسّن تخصيص رأس المال','Capital Allocation Optimizer')}</h3></div>
    <div class="kv"><div class="k">${core.T('حقوق الملكية المتاحة','Available Equity')}</div><div class="v"><b>${core.fmtSAR(optimizer.availableEquity)}</b></div><div class="k">${core.T('رأس المال المتبقي','Capital Remaining')}</div><div class="v"><b>${core.fmtSAR(optimizer.remaining)}</b></div></div>
    <div class="tablewrap" style="margin-top:10px;"><table class="db" style="font-size:12px;"><thead><tr><th>${core.T('الفرصة','Opportunity')}</th><th>${core.T('الاحتياج','Need')}</th><th>${core.T('الدرجة','Score')}</th><th>${core.T('المخاطر','Risk')}</th><th>${core.T('العائد','Return')}</th><th>${core.T('العائد الحدي','Marginal Return')}</th><th>${core.T('التخصيص الموصى به','Recommended Allocation')}</th><th>${core.T('المتبقي','Remaining')}</th></tr></thead><tbody>
      ${optimizer.recommendations.map(r=>`<tr>
        <td>${core.esc(r.name)}</td><td class="num">${core.fmtSAR(r.need)}</td><td class="num">${r.score.toFixed(0)}</td><td style="color:${r.risk.color};font-weight:700;">${core.T(r.risk.ar,r.risk.en)}</td><td class="num">${pctPoint(r.ret)}</td><td class="num">${pctPoint(r.marginal)}</td><td class="num"><b>${core.fmtSAR(r.recommended)}</b></td><td class="num">${core.fmtSAR(r.remainingAfter)}</td>
      </tr>`).join('') || `<tr><td colspan="8" class="note">${core.T('لا توجد فرص غير مربوطة تحتاج تخصيصاً أو لا يوجد رأس مال متاح.','No unlinked allocation candidates or no available capital.')}</td></tr>`}
    </tbody></table></div>
  </div>

  <div class="panel" style="margin-bottom:14px;">
    <div class="panel-head"><h3>${core.T('Portfolio Stress Testing','Portfolio Stress Testing')}</h3></div>
    <div class="tablewrap"><table class="db" style="font-size:12px;"><thead><tr><th>Scenario</th><th>Portfolio IRR</th><th>Δ</th><th>MOIC</th><th>DSCR</th><th>Probability</th></tr></thead><tbody>
      ${stress.map(s=>`<tr><td>${core.T(s.ar,s.en)}</td><td class="num">${pctPoint(s.stressed.irr)}</td><td class="num" style="${s.delta<0?'color:var(--bad);font-weight:700;':''}">${s.delta==null?'—':(s.delta*100).toFixed(1)+' pts'}</td><td class="num">${ratio(s.stressed.moic)}</td><td class="num">${ratio(s.stressed.dscr)}</td><td>${s.key==='worst_case'?'Low / Severe':s.key==='best_case'?'Low / Upside':'Medium'}</td></tr>`).join('')}
    </tbody></table></div>
  </div>

  <div class="panel" style="margin-bottom:14px;">
    <div class="panel-head"><h3>${core.T('Early Warning Engine','Early Warning Engine')}</h3></div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${warnings.slice(0,18).map(w=>`<div style="padding:8px 10px;border-radius:8px;border:1px solid ${w.severity==='critical'?'var(--bad)':w.severity==='warning'?'var(--warn)':'var(--border)'};background:${w.severity==='critical'?'var(--bad-soft)':w.severity==='warning'?'var(--warn-soft)':'var(--surface-2)'};"><b>${w.severity==='critical'?'🔴 Critical':w.severity==='warning'?'🟡 Warning':'⚪ Info'} — ${core.esc(w.metric)}</b> | ${core.esc(w.name)} — ${core.esc(w.message)} <span class="tag">${core.esc(w.action)}</span></div>`).join('') || `<p class="note">${core.T('لا توجد تحذيرات مبكرة حالياً.','No early warnings currently.')}</p>`}
    </div>
  </div>

  <div class="panel" style="margin-bottom:14px;">
    <div class="panel-head"><h3>${core.T('Knowledge Engine','Knowledge Engine')}</h3></div>
    ${kv(core, [
      ['Closed/Actual Sample', knowledge.sample],
      ['Median IRR Variance', knowledge.medIrr==null?'—':(knowledge.medIrr*100).toFixed(1)+' pts'],
      ['Median MOIC Variance', knowledge.medMoic==null?'—':knowledge.medMoic.toFixed(2)+'×'],
      ['Median DSCR Variance', knowledge.medDscr==null?'—':knowledge.medDscr.toFixed(2)+'×'],
      ['Median Price/Cost Variance', knowledge.medPrice==null?'—':pctPoint(knowledge.medPrice)],
      ['Recommended Construction Contingency', pctPoint(knowledge.recContingency)],
    ])}
    <p class="note">${core.T('كل إدخال Actual جديد يغذي هذه القراءة تلقائياً. عندما تكبر العينة، تتحول من قراءة وصفية إلى سياسة افتراضات داخلية.','Every new Actual entry feeds this automatically. As the sample grows, this becomes an internal underwriting-assumption policy engine.')}</p>
  </div>

  <div class="panel" style="margin-bottom:14px;">
    <div class="panel-head"><h3>${core.T('Institutional Reporting','Institutional Reporting')}</h3></div>
    <div class="grid3">
      ${['Board Pack','IC Pack','Fund Pack','Quarterly Pack','Asset Pack','LP Report','ESG Report'].map(name=>`<div style="padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--surface);"><b>${name}</b><p class="note" style="margin:4px 0 0;">${core.T('جاهز كمصدر بيانات موحد؛ يتم توليده من نفس بيانات محرك الذكاء الاستثماري المؤسسي وكتب IC الحالية.','Ready as a unified data source; generated from the same Institutional Investment Intelligence data and existing IC books.')}</p></div>`).join('')}
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>${core.T('حوكمة المحرك — Simulator / Validator / Regression / Replay','Engine Governance — Simulator / Validator / Regression / Replay')}</h3></div>
    ${kv(core, [
      ['Rule Simulator', core.T('مغطى باختبارات Firestore Emulator قبل النشر؛ آخر suite يضم سيناريوهات v4 المزيفة وMonday وappend-only.','Covered by Firestore Emulator pre-deploy tests; latest suite includes fake v4, Monday, and append-only scenarios.')],
      ['Formula Validator', failedFormulas.length ? `FAIL (${failedFormulas.length})` : 'PASS'],
      ['Regression Dashboard', 'Financial Tests + Firestore Tests + Browser readiness manifest'],
      ['Decision Replay', core.T('متاح داخل كل Investment Passport من سجل icDecisions + v4 snapshots + actuals.','Available in each Investment Passport from icDecisions + v4 snapshots + actuals.')],
    ])}
    <div class="tablewrap" style="margin-top:10px;"><table class="db" style="font-size:12px;"><thead><tr><th>Formula</th><th>Status</th><th>Affected KPIs</th><th>Detail</th><th>Opportunity</th></tr></thead><tbody>
      ${formulas.slice(0,24).map(f=>`<tr><td>${core.esc(f.check)}</td><td style="font-weight:700;color:${f.pass?'var(--good)':'var(--bad)'};">${f.pass?'PASS':'FAIL'}</td><td>${core.esc(f.kpi)}</td><td>${core.esc(f.detail)}</td><td>${core.esc(f.name)}</td></tr>`).join('')}
    </tbody></table></div>
  </div>`;
}

function renderPassport(core, row){
  const d = row.d, c = row.c, suite = row.suite;
  const baseline = row.baseline && row.baseline.data;
  const actual = row.actual && row.actual.data;
  const thesis = thesisValidation(core, row);
  const icRows = (core.STORE.icDecisions || []).filter(x=>x.data.oppId===row.rec.id)
    .slice().sort((a,b)=>String(a.data.recordedAt||'').localeCompare(String(b.data.recordedAt||'')));
  const challenge = aiChallenge(core, row);
  const gate = icReadiness(core, d, c);

  return `<div class="section" data-institutional-intelligence-passport="${row.rec.id}">
    <h3>🛂 ${core.T('Investment Passport — المرجع الرسمي للأصل','Investment Passport — Official Asset Reference')}</h3>
    <div class="grid3" style="margin-bottom:10px;">
      ${miniScore(core, 'Investment Quality', suite.investmentQuality)}
      ${miniScore(core, 'Decision Confidence', suite.decisionConfidence)}
      ${miniScore(core, 'Execution Confidence', suite.executionConfidence)}
    </div>
    ${kv(core, [
      ['Investment Thesis', d.thesis ? core.esc(d.thesis).slice(0,300) : '—'],
      ['Thesis Validation', `${thesis.valid===true?'✅ Valid':thesis.valid===false?'🔴 Challenged':'🟡 Pending'} — ${core.esc(thesis.reason)}`],
      ['Current Status', core.esc((d.pipeline && d.pipeline.stage) || '—')],
      ['IRR / MOIC / DSCR', `${pctPoint(c.equityIRR)} · ${ratio(c.MOIC)} · ${ratio(c.dscrMin)}`],
      ['Maximum Price / Current Price', `${core.fmtSAR(c.maxLandPrice || 0)} / ${core.fmtSAR(d.land.price || 0)}`],
      ['Actual Performance', actual ? `${actual.period || actual.asOfDate}: IRR ${pctPoint(actual.actualEquityIRR)}, MOIC ${ratio(actual.actualMOIC)}, DSCR ${ratio(actual.actualDSCR)}` : '—'],
      ['Risk', `${core.T(row.risk.ar,row.risk.en)} (${row.riskScore}/25)`],
      ['DD / Evidence', `${Math.round((suite.executionConfidence.dd.pct||0)*100)}% DD · ${suite.evidenceConfidence.score.toFixed(0)}/100 Evidence`],
      ['Conditions', (((d.ic && d.ic.decisions)||[]).slice(-1)[0]||{}).conditions ? `${(((d.ic && d.ic.decisions)||[]).slice(-1)[0]||{}).conditions.length}` : '0'],
      ['Capital', d.capitalAllocation && d.capitalAllocation.targetEquity ? core.fmtSAR(d.capitalAllocation.targetEquity) : '—'],
      ['Next Action', core.esc((d.pipeline && d.pipeline.nextAction) || (gate.ready ? 'Ready for IC / monitoring' : 'Resolve readiness blockers'))],
    ])}
    <div class="panel" style="margin-top:10px;">
      <div class="panel-head"><h4 style="margin:0;">Decision Replay</h4></div>
      <div class="tablewrap"><table class="db" style="font-size:12px;"><thead><tr><th>Date</th><th>Decision</th><th>Original Numbers</th><th>Original Thesis</th><th>Actual Outcome</th></tr></thead><tbody>
        ${icRows.map(ic=>{
          const v = (core.STORE[UW_COLLECTION]||[]).find(x=>x.data.sourceDecisionId===ic.id) || row.baseline;
          const m = v && v.data.metrics;
          return `<tr><td>${core.esc(String(ic.data.recordedAt||'').slice(0,10))}</td><td>${core.esc((ic.data.decision||{}).decision || '—')}</td><td>${m?`IRR ${pctPoint(m.equityIRR)} · MOIC ${ratio(m.MOIC)} · DSCR ${ratio(m.dscrMin)}`:'—'}</td><td>${core.esc((v&&v.data.thesisSnapshot)||'—').slice(0,180)}</td><td>${actual?`IRR ${pctPoint(actual.actualEquityIRR)} · MOIC ${ratio(actual.actualMOIC)} · DSCR ${ratio(actual.actualDSCR)}`:'—'}</td></tr>`;
        }).join('') || `<tr><td colspan="5" class="note">${core.T('لا توجد قرارات IC مستقلة بعد.','No independent IC decisions yet.')}</td></tr>`}
      </tbody></table></div>
    </div>
    <div class="panel" style="margin-top:10px;">
      <div class="panel-head"><h4 style="margin:0;">AI Challenge Mode</h4></div>
      <ol style="margin:0;padding-inline-start:22px;">${challenge.map(x=>`<li>${core.esc(x)}</li>`).join('')}</ol>
    </div>
  </div>`;
}

export function registerInstitutionalInvestmentIntelligence(core){
  _iiiCoreRef = core;
  core.registerTopbarButton(()=>`<button class="btn btn-sm" data-action="institutional-intelligence-open">🧠 ${core.T('محرك الذكاء الاستثماري المؤسسي','Institutional Investment Intelligence')}</button>`);
  core.registerMainView('institutional-intelligence', ()=>renderInstitutionalInvestmentIntelligenceDashboard(core));
  core.registerDetailSection((d, c, rec)=>{
    const oppId = core.openDetailId;
    const row = opportunityIntelligenceRows(core).find(x=>x.rec.id===oppId);
    return row ? renderPassport(core, row) : '';
  });
  core.registerActionHandler(async (action, el)=>{
    if(action==='institutional-intelligence-open'){
      core.setCoreState({ mainView:'institutional-intelligence', openDetailId:null, fundsViewOpen:false, render:true });
      return true;
    }
    if(action==='institutional-intelligence-close'){
      core.setCoreState({ mainView:null, render:true });
      return true;
    }
    if(action==='institutional-intelligence-open-opp'){
      core.openOpportunityDetail(el.dataset.id);
      return true;
    }
    return false;
  });
}

export {
  confidenceSuite,
  portfolioStressRows,
  allocationOptimizer,
  earlyWarnings,
  knowledgeStats,
  formulaValidation,
};
