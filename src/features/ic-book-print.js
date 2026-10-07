/* =========================================================================
   كتاب لجنة الاستثمار الكامل — Investment Committee Book (٢١ قسماً)
   ---------------------------------------------------------------------------
   إعادة هيكلة الطباعة من "مذكرة استثمارية" (renderDetail الحالية في core.js)
   إلى كتاب كامل بمستوى لجنة استثمار مؤسسية، بالترتيب المطلوب بالضبط (انظر
   خطة_التقارير_والمهام_القادمة.md § ١): Cover → Executive Recommendation →
   Snapshot → Thesis → Site → Acquisition → Dev/Ops Plan → Sources & Uses →
   Returns → Cash Flow → Debt → Sensitivity → Scenarios → Comparables → Risks
   → DD Status → IC Checklist → Negotiation → Conditions Precedent → Final
   Recommendation → Sources/Evidence/Disclaimer.

   قرار معماري متعمَّد: renderDetail() في core.js قالب كبير (500+ سطر)، معقَّد
   الشبكة (.grid-2col)، ومرقَّم يدوياً بترتيب مختلف تماماً عن الترتيب المطلوب
   هنا. إعادة ترتيب ذلك القالب نفسه كانت لتحمل مخاطرة عالية (سطح كبير، ترقيم
   متشابك، شروط عرض متعددة) وتخالف الانضباط المتَّبع طوال هذا المشروع بعدم لمس
   منطق core.js الداخلي. البديل الأكثر أماناً المُتَّبع هنا: طريقة عرض رئيسية
   جديدة كاملة ومستقلة (registerMainView('icBook', ...)) تُركِّب مستنداً جديداً
   بالكامل بالترتيب المطلوب، مُعاد استخدام فيه كل قيمة محسوبة مسبقاً من
   core.compute()/core.withDefaults() ومن دوال الأنظمة السابقة المُصدَّرة
   (sensitivityRows/scenarioCompareRows/icRecommendations/... إلخ) — صفر حسابات
   مالية جديدة، وصفر تعديل على core.js. نفس أصناف CSS المستخدمة أصلاً في
   renderDetail (.memo/.section/.kv/table.db/.n) حتى تُطبَّق طباعة/PDF بنفس
   الجودة دون أي تنسيق CSS جديد، وبنفس زر الطباعة الحالي (data-action="print-memo").
   نُخزِّن هوية الفرصة المطلوب طباعة كتابها في core.openDetailId نفسه (حقل
   مُدرَج أصلاً في القائمة البيضاء لـsetCoreState) بدل حقل جديد — لأنه غير
   مُستخدَم أثناء نشاط mainView (renderActiveMainView() تُسقِط render الفرصة
   الافتراضي بالكامل، فلا تعارض).
   ========================================================================= */

import { generateAnalystNarrative } from './ai-analyst.js';
import { ddStats, defaultItemsDict, DD_CATEGORIES } from './due-diligence.js';
import { RISK_CATEGORIES, defaultRiskItems, scoreOf as riskScoreOf, bandOf as riskBandOf } from './risk-engine.js';
import { matchBenchmarks, aggregateBench } from './benchmark-engine.js';
import { maxAcquisitionPrice } from './max-acquisition-price.js';
import { stageLabel } from './pipeline.js';
// دقة التدفقات النقدية (شهري/ربع سنوي) + ذروة الاحتياج + صافي النقدي من المستثمرين النقديين
// نفس مصدر الحساب المستخدَم في واجهة المذكرة الحية وفي دفتر الاكتتاب
// الكامل (excel-workbook.js)، حتى لا يتكرر منطق منحنى S/التوزيع الشهري في أكثر من مكان.
import { cashFlowTimingAnalysis } from './cash-flow-timing.js';

const COMPARABLES_COLLECTION = 'comparables';
const DEC_LABEL = {
  approve:            ['اعتماد','Approve'],
  approve_conditions: ['اعتماد بشروط','Approve with Conditions'],
  revise:              ['مراجعة وإعادة عرض','Revise & Resubmit'],
  hold:                ['تعليق','Hold'],
  reject:              ['رفض','Reject'],
};
const DEC_COLOR = { approve:'#34d399', approve_conditions:'#a3e635', revise:'#fbbf24', hold:'#fb923c', reject:'#f87171' };

function median(nums){
  if(!nums.length) return null;
  const s = nums.slice().sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length%2 ? s[mid] : (s[mid-1]+s[mid])/2;
}

export function registerICBookPrint(core){
  const { T, esc, fmtSAR, fmtPct, fmtNum } = core;

  /* زر التشغيل — يظهر داخل تفاصيل كل فرصة (مثل زر الطباعة العادي)، لا يستبدله. */
  core.registerDetailSection((d, c)=>{
    const oppId = core.openDetailId;
    const rec = core.opportunities.find(o=>o.id===oppId);
    if(!rec) return '';
    return `
    <div class="section" style="text-align:center; background:var(--surface-2); border:1px dashed var(--border);">
      <button type="button" class="btn btn-sm btn-primary" data-action="icbook-open" data-id="${rec.id}">📘 ${core.T('طباعة كتاب اللجنة الكامل (٢١ قسماً)','Print Full IC Book (21 Sections)')}</button>
      <p class="note" style="margin:8px 0 0;">${core.T('نسخة كاملة بمستوى لجنة استثمار — من صفحة الغلاف حتى المصادر والإخلاء، بالترتيب المؤسسي القياسي، قابلة للطباعة/PDF مباشرة.','A full IC-level book — from the cover page through sources & disclaimer, in standard institutional order, printable/exportable to PDF directly.')}</p>
    </div>`;
  });

  core.registerMainView('icBook', ()=>{
    const oppId = core.openDetailId;
    const rec = core.opportunities.find(o=>o.id===oppId);
    if(!rec){
      return `
      <div class="section">
        <p>${core.T('لم يتم اختيار فرصة لعرض كتابها.','No opportunity selected to build its book.')}</p>
        <button type="button" class="btn btn-sm btn-ghost" data-action="icbook-close">✖ ${core.T('رجوع','Back')}</button>
      </div>`;
    }
    const d = core.withDefaults(rec.data), c = core.compute(d);
    /* 3A-2c: كتاب اللجنة لفرصة محجوبة (INVALID/INCOMPLETE) لا يُبنى ولا يُطبع — صفحة إيضاح بلا أي رقم. */
    const _blk = typeof core.oppMetricGuard==='function' ? core.oppMetricGuard(rec, c) : null;
    if(_blk){
      const top = typeof core.renderMemoTopExtensions==='function' ? core.renderMemoTopExtensions(d, c, rec) : '';
      return `<div class="section" data-blocked-book="1">
        <h2>⛔ ${core.T('كتاب لجنة الاستثمار غير متاح لهذه الفرصة','The Investment Committee book is not available for this opportunity')}</h2>
        <p>${core.T('مدخلات الفرصة غير صالحة أو ناقصة، فلا يُنشأ كتاب يحوي نتائج غير معتمدة. صحّح المدخلات الموضَّحة أدناه ثم أعد المحاولة.','The opportunity inputs are invalid or incomplete, so no book with unapproved results is produced. Correct the inputs listed below and try again.')}</p>
        ${top}
        <button type="button" class="btn btn-sm btn-ghost" data-action="icbook-close">✖ ${core.T('رجوع','Back')}</button>
      </div>`;
    }
    scheduleBookCharts(core, d, c); // الحاويات الثلاث الجديدة (رأس المال/العائد/المخاطر) جديدة على DOM بعد هذا الرسم
    return buildICBook(core, rec, d, c);
  });
  watchForBookCharts(core);

  core.registerActionHandler(async (action, el)=>{
    if(action==='icbook-open'){
      core.setCoreState({ openDetailId: el.dataset.id, mainView:'icBook', render:true });
      // طباعة تلقائية عند الفتح من زر "طباعة / PDF" في رأس المذكرة (data-autoprint="1") —
      // نمهل رسم الكتاب الكامل الجديد ورسومه البيانية (canvas/Chart.js) قبل نداء الطباعة
      // حتى تُطبع نسخة الكتاب المؤسسي كاملة بالرسوم لا لقطة فارغة/غير مكتملة.
      if(el.dataset.autoprint){ setTimeout(()=> window.print(), 220); }
      return true;
    }
    if(action==='icbook-close'){ core.setCoreState({ mainView:null, render:true }); return true; }
    return false;
  });
}

/* ---------------------------------------------------------------------
   أدوات بناء HTML مشتركة بين الأقسام الـ٢١ — بنفس أصناف CSS الموجودة أصلاً
   في index.html (.section / .kv / table.db / .n)، بلا أي CSS جديد.
   --------------------------------------------------------------------- */
function sec(core, num, titleAr, titleEn, subtitle, bodyHtml){
  const { T, esc } = core;
  return `
  <div class="section" style="break-inside:avoid; margin-bottom:14px;">
    <h3><span class="n">${num}</span> ${T(titleAr,titleEn)}${subtitle? ` <span style="color:var(--ink-faint); font-weight:500; font-size:12px;">(${esc(subtitle)})</span>` : ''}</h3>
    ${bodyHtml}
  </div>`;
}
function kv(rows){
  return `<div class="kv" style="margin-bottom:4px;">${rows.filter(Boolean).map(([k,v])=>`<div class="k">${k}</div><div class="v">${v}</div>`).join('')}</div>`;
}
function tbl(headers, rowsHtml, emptyLabel){
  return `<div class="tablewrap"><table class="db" style="font-size:11.5px;">
    <thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rowsHtml.length? rowsHtml.join('') : `<tr><td colspan="${headers.length}" style="text-align:center; padding:14px;">${emptyLabel||'—'}</td></tr>`}</tbody>
  </table></div>`;
}
function pcolor(v){ return v>=0 ? 'var(--good)' : 'var(--bad)'; }

/* ---------------------------------------------------------------------
   رسوم بيانية إضافية داخل الكتاب المطبوع (Chart.js) — طلب المستخدم صراحة:
   "أعتقد انه من الأفضل وجود رسوم بيانية" في البي دي إف/الطباعة أيضاً، لا في
   الشاشة العادية فقط. نُعيد استخدام نفس محرك core.mkChart/CHART_COLORS/
   CHART_BASE_OPTS بلا أي تكرار منطقي، ونُضيف ٣ رسوم بيانية جديدة غير موجودة
   أصلاً في initDetailCharts (رأس مال/عائد مقابل الحد الأدنى/مخاطر) — أما
   التدفقات النقدية والسيناريوهات والحساسية (chart-cashflow/chart-scenarios/
   chart-sensitivity) فتُستخدَم فيها *نفس* عناصر canvas الموجودة أصلاً في
   renderDetail، فتُملأ تلقائياً بواسطة initDetailCharts() الحالية في core.js
   (تُستدعى من render() في كل مرة بلا أي شرط) — صفر كود إضافي لهذه الثلاثة.
   core.js لا يملك نقطة توسّع "بعد الرسم" عامة (نفس ملاحظة opportunities-map.js)،
   فنتبع بالضبط نفس نمط MutationObserver المُتَّبع هناك بلا أي لمس لـcore.js. */
let _bookChartsPending = false;
function scheduleBookCharts(core, d, c){
  if(_bookChartsPending) return;
  _bookChartsPending = true;
  const raf = (typeof window!=='undefined' && window.requestAnimationFrame) ? window.requestAnimationFrame : (fn)=>setTimeout(fn, 30);
  raf(()=>{ _bookChartsPending = false; renderBookCharts(core, d, c); });
}
function renderBookCharts(core, d, c){
  const { mkChart, CHART_COLORS, CHART_BASE_OPTS, T, fmtSAR } = core;
  if(typeof document==='undefined') return;

  if(document.getElementById('chart-book-capital')){
    mkChart('chart-book-capital', { type:'doughnut',
      data:{ labels:[T('الدين','Debt'), T('حقوق الملكية','Equity')], datasets:[{ data:[c.debt, c.equity],
        backgroundColor:[CHART_COLORS.gold, CHART_COLORS.accent], borderColor:'#fff', borderWidth:2 }] },
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ position:'bottom', labels:{ color:CHART_COLORS.inkFaint, font:{ family:'Sakkal Majalla, Amiri, sans-serif', size:11 }, boxWidth:10, padding:8 } },
          tooltip:{ callbacks:{ label:(ctx)=>ctx.label+': '+fmtSAR(ctx.raw) } } } } });
  }

  if(document.getElementById('chart-book-returns')){
    const hurdle = (d.criteria && d.criteria.irrMin) || 0.15;
    const moicMin = (d.criteria && d.criteria.moicMin) || 1.5;
    const dscrMin = (d.criteria && d.criteria.dscrMin) || 1.2;
    const metrics = [
      hurdle>0 && isFinite(c.equityIRR)? { label:'Equity IRR', ratio:(c.equityIRR/hurdle)*100 } : null,
      moicMin>0 && isFinite(c.MOIC)? { label:'MOIC', ratio:(c.MOIC/moicMin)*100 } : null,
      dscrMin>0 && c.dscrMin!=null? { label:'DSCR', ratio:(c.dscrMin/dscrMin)*100 } : null,
    ].filter(Boolean);
    mkChart('chart-book-returns', { type:'bar',
      data:{ labels:metrics.map(m=>m.label), datasets:[{ label:T('% من الحد الأدنى المطلوب (١٠٠٪ = الحد الأدنى)','% of Minimum Required (100% = hurdle)'),
        data:metrics.map(m=>Math.round(m.ratio)),
        backgroundColor:metrics.map(m=>m.ratio>=100?CHART_COLORS.goodSoft:CHART_COLORS.badSoft),
        borderColor:metrics.map(m=>m.ratio>=100?CHART_COLORS.good:CHART_COLORS.bad), borderWidth:1.5, borderRadius:6, maxBarThickness:60 }] },
      options:Object.assign({}, CHART_BASE_OPTS, { plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label:(ctx)=>ctx.raw+'%' } } },
        scales:{ x:CHART_BASE_OPTS.scales.x, y:Object.assign({}, CHART_BASE_OPTS.scales.y, { ticks:{ color:CHART_COLORS.inkFaint, callback:(v)=>v+'%' } }) } }) });
  }

  if(document.getElementById('chart-book-risk')){
    const riskItems = (d.risk && d.risk.items) || defaultRiskItems();
    const rows = RISK_CATEGORIES.map(cat=>{
      const it = riskItems[cat.key] || {probability:1,impact:1};
      const score = riskScoreOf(it);
      return { label:T(cat.ar,cat.en), score, band:riskBandOf(score) };
    });
    mkChart('chart-book-risk', { type:'bar',
      data:{ labels:rows.map(r=>r.label), datasets:[{ label:T('درجة المخاطرة','Risk Score'), data:rows.map(r=>r.score),
        backgroundColor:rows.map(r=>r.band.color), borderColor:rows.map(r=>r.band.color), borderWidth:1, borderRadius:6, maxBarThickness:22 }] },
      options:Object.assign({}, CHART_BASE_OPTS, { indexAxis:'y', plugins:{ legend:{ display:false } } }) });
  }
}
function watchForBookCharts(core){
  if(typeof document==='undefined' || typeof MutationObserver==='undefined') return;
  const app = document.getElementById('app');
  if(!app) return;
  const obs = new MutationObserver(()=>{
    const oppId = core.openDetailId;
    const rec = core.opportunities.find(o=>o.id===oppId);
    if(!rec) return;
    const d = core.withDefaults(rec.data), c = core.compute(d);
    if(typeof core.oppMetricGuard==='function' && core.oppMetricGuard(rec, c)) return;
    scheduleBookCharts(core, d, c);
  });
  obs.observe(app, { childList:true, subtree:true });
}

/* ---------------------------------------------------------------------
   الجسم الكامل — ٢١ قسماً بالترتيب المطلوب بالضبط.
   --------------------------------------------------------------------- */
export function buildICBook(core, rec, d, c){
  const { T, esc, fmtSAR, fmtPct, fmtNum } = core;
  const reportDates = core.reportDateMeta(d);
  const ti = core.OPP_TYPE_INFO[d.meta.oppType];
  const vcls = c.verdict==='good'?'verdict-good':c.verdict==='warn'?'verdict-warn':'verdict-bad';
  const vlbl = c.verdict==='good'? '🟢 '+T('التوصية: قابلة للعرض على لجنة الاستثمار','Recommendation: Ready to present to the Investment Committee')
    : c.verdict==='warn'? '🟡 '+T('التوصية: تحت المراجعة — تحتاج تحسين مؤشرات محددة','Recommendation: Under review — specific metrics need improvement')
    : '🔴 '+T('التوصية: دون معايير القبول — تحتاج إعادة هيكلة','Recommendation: Below acceptance standards — needs restructuring');

  const narrative = generateAnalystNarrative(core, d, c);
  const decisions = (d.ic && d.ic.decisions) || [];
  const latest = decisions.length? decisions[decisions.length-1] : null;

  let html = '';

  /* ===================== 1) Cover Page ===================== */
  html += `
  <div class="memo" data-print-date="${esc(reportDates.asOfText)}">
    <div class="print-run-header">
      <span>${esc(core.branding.companyName||T('أوبال القابضة','Opal Holding'))} — ${esc(d.meta.name||T('بدون اسم','Unnamed'))}</span>
      <span>${T('كتاب لجنة الاستثمار','Investment Committee Book')} · ${T('تاريخ سريان البيانات','As-of Date')}: ${esc(reportDates.asOfText)}</span>
    </div>
    <div class="print-letterhead">
      ${core.branding.logoDataUrl? `<img src="${core.branding.logoDataUrl}" alt="${esc(core.branding.companyName||T('شعار الشركة','Company Logo'))}" class="print-letterhead-logo">` : ''}
      <div class="print-letterhead-text">
        <div class="print-letterhead-company">${esc(core.branding.companyName||'')}</div>
        <div class="print-letterhead-app">${T('مستكشف الفرص العقارية','Opal Real Estate Opportunity Explorer')} · Opal Real Estate Opportunity Explorer</div>
        <div class="print-letterhead-date">${T('تاريخ سريان البيانات','As-of Date')} ${esc(reportDates.asOfText)} · ${T('تم إنشاؤه في','Generated on')} ${esc(reportDates.generatedText)}</div>
      </div>
    </div>
    <div class="memo-hero" style="text-align:center; padding:40px 4px 30px;">
      <div class="eyebrow">${T('كتاب لجنة الاستثمار الكامل','Full Investment Committee Book')} — ${esc(rec.id)}</div>
      <h2 style="font-size:28px;">${esc(d.meta.name||T('فرصة بدون اسم','Unnamed Opportunity'))}</h2>
      <div class="meta" style="justify-content:center;">
        <span>📍 ${esc(d.meta.city)} · ${esc(d.meta.neighborhood||'—')} · ${esc(d.meta.tier)}</span>
        <span>${ti.ic} ${T(ti.t,ti.en)}</span>
        <span>🗓️ ${T('تاريخ سريان البيانات','As-of Date')}: ${esc(reportDates.asOfText)}</span>
        <span>👤 ${T('أُعِدَّ بواسطة','Prepared by')}: ${esc(core.currentUser? core.currentUser.email : (d.meta.analyst||'—'))}</span>
      </div>
      <div class="verdict-banner ${vcls}" style="margin:22px auto 0; max-width:640px;">${vlbl}</div>
      <div style="margin-top:18px;">
        <button type="button" class="btn btn-sm" data-action="print-memo">🖨️ ${T('طباعة / PDF','Print / PDF')}</button>
        <button type="button" class="btn btn-sm btn-ghost" data-action="icbook-close">✖ ${T('إغلاق والرجوع للفرصة','Close & return to opportunity')}</button>
      </div>
    </div>`;

  /* ===================== 2) Executive Investment Recommendation ===================== */
  html += sec(core, 2, 'التوصية التنفيذية للاستثمار', 'Executive Investment Recommendation', 'Executive Investment Recommendation', `
    <div class="verdict-banner ${vcls}" style="margin-bottom:12px;">${vlbl}</div>
    ${kv([
      ['TPC', fmtSAR(c.TPC)],
      ['Equity IRR', `<b>${isFinite(c.equityIRR)?fmtPct(c.equityIRR):'—'}</b>`],
      ['MOIC', `<b>${isFinite(c.MOIC)?c.MOIC.toFixed(2)+'×':'—'}</b>`],
      ['DSCR ('+T('أدنى','min')+')', c.dscrMin!=null&&isFinite(c.dscrMin)? c.dscrMin.toFixed(2)+'×':'—'],
      ['NPV', isFinite(c.npvProject)?fmtSAR(c.npvProject):'—'],
      [T('قرار اللجنة الأحدث','Latest IC Decision'), latest? `<span style="color:${DEC_COLOR[latest.decision]}; font-weight:700;">${T(DEC_LABEL[latest.decision][0],DEC_LABEL[latest.decision][1])}</span>` : T('لم يُتخَذ قرار بعد','No decision yet')],
    ])}
    <p style="margin:10px 0 0; font-size:12.5px; line-height:1.85;">${esc(narrative.paras[narrative.paras.length-1])}</p>
  `);

  /* ===================== 3) Opportunity Snapshot ===================== */
  const stg = (d.pipeline && d.pipeline.stage) ? stageLabel(d.pipeline.stage) : null;
  html += sec(core, 3, 'لمحة الفرصة', 'Opportunity Snapshot', 'Opportunity Snapshot', `
    ${kv([
      [T('معرّف الفرصة','Opportunity ID'), esc(rec.id)],
      [T('الاسم','Name'), esc(d.meta.name||'—')],
      [T('المدينة','City'), esc(d.meta.city)],
      [T('الحي','Neighborhood'), esc(d.meta.neighborhood||'—')],
      [T('الفئة','Tier'), esc(d.meta.tier)],
      [T('نوع الفرصة','Opportunity Type'), T(ti.t,ti.en)],
      [T('نوع الاستخدام','Use Type'), esc(d.meta.useType||'—')],
      [T('مرحلة خط الأنابيب','Pipeline Stage'), stg? T(stg.ar,stg.en) : '—'],
      [T('المحلل','Analyst'), esc(d.meta.analyst||'—')],
      [T('تاريخ سريان البيانات','As-of Date'), esc(reportDates.asOfText)],
      [T('تاريخ إنشاء الملف','Generated on'), esc(reportDates.generatedText)],
      [T('تاريخ الإنشاء','Created'), d.meta.createdAt? esc(core.fmtDateBilingual(d.meta.createdAt)) : '—'],
      [T('آخر تحديث','Last Updated'), d.meta.updatedAt? esc(core.fmtDateBilingual(d.meta.updatedAt)) : '—'],
    ])}
  `);

  /* ===================== 4) Investment Thesis ===================== */
  const scoreRes = narrative.scoreRes, band = narrative.band, decisionConfidence = narrative.decisionConfidence;
  html += sec(core, 4, 'الأطروحة الاستثمارية', 'Investment Thesis', 'Investment Thesis', `
    ${kv([
      [T('الدرجة الاستثمارية المركّبة','Composite Investment Score'), `<b>${scoreRes.composite.toFixed(0)}/100</b> (${T(band.ar,band.en)})`],
      [T('ثقة القرار','Decision Confidence'), `<b style="color:${decisionConfidence.band.color};">${decisionConfidence.score.toFixed(0)}/100</b> (${T(decisionConfidence.band.ar,decisionConfidence.band.en)})`],
    ])}
    <p class="note" style="margin:0 0 10px;">${T('التمييز مقصود: Investment Score يعبّر عن جاذبية الصفقة وفق الافتراضات الحالية، بينما Decision Confidence يعبّر عن قوة التوثيق والتحقق والعناية الواجبة الداعمة للقرار.','The distinction is intentional: Investment Score reflects deal attractiveness under current assumptions, while Decision Confidence reflects the strength of the documentation, verification, and due diligence supporting the decision.')}</p>
    <p class="step-sub" style="margin:10px 0 6px;">${T('لماذا الاستثمار — نقاط القوة الموثَّقة','Why Invest — Documented Strengths')}</p>
    ${narrative.strengths.length? `<ul style="margin:0; padding-inline-start:20px; font-size:12px; line-height:1.9;">${narrative.strengths.map(s=>`<li>${esc(s)}</li>`).join('')}</ul>`
      : `<p class="note">${T('لا توجد نقاط قوة بارزة مسجَّلة بعد وفق المعايير الآلية.','No standout strengths flagged yet by the automated criteria.')}</p>`}
  `);

  /* ===================== 5) Site / Location ===================== */
  const siteFactorsAr = { soil:'التربة', water:'المياه الجوفية', tower:'قرب أبراج/مطارات', topo:'التضاريس', infra:'البنية التحتية' };
  const siteFactorsEn = { soil:'Soil', water:'Groundwater', tower:'Tower/Airport Proximity', topo:'Topography', infra:'Infrastructure' };
  html += sec(core, 5, 'الموقع', 'Site / Location', 'Site / Location', `
    ${kv([
      [T('المدينة','City'), esc(d.meta.city)],
      [T('الحي','Neighborhood'), esc(d.meta.neighborhood||'—')],
      [T('الفئة','Tier'), esc(d.meta.tier)],
      [T('مساحة الأرض','Land Area'), fmtNum(d.land.area)+' م²'],
      [T('معامل البناء (FAR)','FAR'), fmtNum(d.land.far)],
      [T('عدد البدرومات','Basements'), fmtNum(d.land.basements||0)],
    ])}
    <p class="step-sub" style="margin:12px 0 6px;">${T('عوامل الموقع (علاوات/خصومات تكلفة)','Site Factors (cost premiums/discounts)')}</p>
    ${kv(Object.keys(siteFactorsAr).map(k=>[T(siteFactorsAr[k],siteFactorsEn[k]), d.site&&d.site[k]!=null? fmtPct(d.site[k]) : '—']))}
  `);

  /* ===================== 6) Acquisition & Land Economics ===================== */
  const targetIRR = d.criteria.irrMin || 0.15;
  const mapRes = maxAcquisitionPrice(core, d, targetIRR);
  const neg = d.negotiation || { askingPrice:null, targetPrice:null, walkAwayPrice:null, history:[] };
  html += sec(core, 6, 'الاستحواذ واقتصاديات الأرض', 'Acquisition & Land Economics', 'Acquisition & Land Economics', `
    ${kv([
      [T('سعر متر الأرض (مُدخَل)','Land Price/m² (underwritten)'), fmtSAR(d.land.price)+'/م²'],
      [T('مساحة الأرض','Land Area'), fmtNum(d.land.area)+' م²'],
      [T('إجمالي تكلفة الأرض','Total Land Cost'), fmtSAR(c.landCost)],
      [T('حصة الأرض من إجمالي تكلفة المشروع','Land Share of TPC'), c.TPC>0? fmtPct(c.landCost/c.TPC) : '—'],
      [T('الحد الأقصى لسعر الاستحواذ (لتحقيق '+fmtPct(targetIRR)+')','Maximum Acquisition Price (to reach '+fmtPct(targetIRR)+')'), mapRes.infeasible? T('غير قابل للتحقق مهما انخفض السعر','Not achievable at any price') : fmtSAR(mapRes.maxPrice)+'/م²'],
      [T('سعر طلب البائع','Seller Asking Price'), neg.askingPrice!=null? fmtSAR(neg.askingPrice)+'/م²' : '—'],
      [T('السعر المستهدف','Target Price'), neg.targetPrice!=null? fmtSAR(neg.targetPrice)+'/م²' : '—'],
    ])}
  `);

  /* ===================== 7) Development / Operating Plan ===================== */
  let devBody = '';
  if(d.meta.oppType==='development'){
    devBody = kv([
      [T('سعر البيع المتوقع/م²','Expected Sale Price/m²'), fmtSAR(d.development.salePrice)],
      [T('تكلفة البناء/م²','Build Cost/m²'), fmtSAR(d.development.buildCost)],
      [T('مدة الإنشاء','Construction Duration'), fmtNum(d.development.constructionYears)+' '+T('سنة','yrs')],
      [T('معدل الرسملة عند الخروج','Exit Cap Rate'), fmtPct(d.development.exitCapRate)],
      [T('احتياطي الطوارئ الإنشائي','Construction Contingency'), fmtPct(d.development.contingency)],
      [T('نسبة البيع من الاستراتيجية','Sale % (strategy)'), d.strategy&&d.strategy.salePct!=null? fmtPct(d.strategy.salePct) : '—'],
    ]);
  } else if(d.meta.oppType==='income'){
    devBody = kv([
      [T('الإيجار السنوي/م²','Annual Rent/m²'), fmtSAR(d.income.rent)],
      [T('نسبة الإشغال','Occupancy'), fmtPct(d.income.occupancy)],
      [T('نسبة المصاريف التشغيلية (OPEX)','OPEX Ratio'), fmtPct(d.income.opex)],
      [T('متوسط العمر المتبقي للعقود (WALE)','WALE'), d.income.wale!=null? fmtNum(d.income.wale)+' '+T('سنة','yrs') : '—'],
      [T('تركّز أكبر مستأجر','Largest Tenant Concentration'), d.income.tenantConc!=null? fmtPct(d.income.tenantConc) : '—'],
      [T('صافي الدخل التشغيلي (سنة ١ مستقر)','Stabilized NOI (Yr 1)'), fmtSAR(c.stabilizedNOIyr1)],
    ]);
  } else {
    devBody = kv([
      [T('معدل نمو قيمة الأرض السنوي','Annual Land Appreciation'), d.landbank&&d.landbank.appreciation!=null? fmtPct(d.landbank.appreciation) : '—'],
      [T('تكلفة الحمل السنوية','Annual Carry Cost'), d.landbank&&d.landbank.carryAnnual!=null? fmtSAR(d.landbank.carryAnnual) : '—'],
      [T('مدة الاحتفاظ','Holding Period'), d.landbank&&d.landbank.holdingYears!=null? fmtNum(d.landbank.holdingYears)+' '+T('سنة','yrs') : '—'],
    ]);
  }
  html += sec(core, 7, 'الخطة التطويرية / التشغيلية', 'Development / Operating Plan', T(ti.t,ti.en), devBody);

  /* ===================== 8) Sources & Uses ===================== */
  html += sec(core, 8, 'مصادر واستخدامات الأموال', 'Sources & Uses', 'Sources & Uses', `
    <div style="position:relative; height:190px; max-width:340px; margin:0 auto 14px;"><canvas id="chart-book-capital"></canvas></div>
    <p class="step-sub" style="margin:0 0 6px;">${T('الاستخدامات','Uses')}</p>
    ${kv([
      [T('تكلفة الأرض','Land Cost'), fmtSAR(c.landCost)],
      [T('التكلفة الإنشائية','Hard Cost'), fmtSAR(c.hardCost)],
      [T('تكاليف ثابتة لمرة واحدة','One-time Fixed Costs'), fmtSAR(c.oneTimeFixed)],
      [T('رسوم الهيكلة','Structuring Fee'), fmtSAR(c.structuringFee)],
      [T('رسوم الاستحواذ','Acquisition Fee'), fmtSAR(c.acquisitionFee)],
      [T('رسوم الترتيب (التمويل)','Arrangement Fee'), fmtSAR(c.arrangementFee)],
      ['<b>'+T('إجمالي تكلفة المشروع (TPC)','Total Project Cost (TPC)')+'</b>', `<b>${fmtSAR(c.TPC)}</b>`],
    ])}
    <p class="step-sub" style="margin:12px 0 6px;">${T('المصادر','Sources')}</p>
    ${kv([
      [T('الدين (تمويل بنكي)','Debt Financing'), fmtSAR(c.debt)],
      [T('حقوق الملكية (المستثمرون)','Equity (Investors)'), fmtSAR(c.equity)],
      [T('نسبة التمويل (LTC)','Financing Ratio (LTC)'), c.TPC>0? fmtPct(c.debt/c.TPC) : '—'],
      ['<b>'+T('الإجمالي','Total')+'</b>', `<b>${fmtSAR(c.debt+c.equity)}</b>`],
    ])}
  `);

  /* ===================== 9) Financial Returns ===================== */
  html += sec(core, 9, 'العوائد المالية', 'Financial Returns', 'Financial Returns', `
    <div style="position:relative; height:190px; margin-bottom:14px;"><canvas id="chart-book-returns"></canvas></div>
    ${kv([
      ['Equity IRR', isFinite(c.equityIRR)?fmtPct(c.equityIRR):'—'],
      ['Project IRR (Unlevered)', isFinite(c.projectIRR)?fmtPct(c.projectIRR):'—'],
      ['MOIC', isFinite(c.MOIC)?c.MOIC.toFixed(2)+'×':'—'],
      ['NPV (Project @ WACC)', isFinite(c.npvProject)?fmtSAR(c.npvProject):'—'],
      ['NPV (Equity @ Ke)', isFinite(c.npvEquity)?fmtSAR(c.npvEquity):'—'],
      ['WACC', fmtPct(c.WACC)],
      ['Yield on Cost', d.meta.oppType!=='landbank'? fmtPct(c.yieldOnCost) : '—'],
      ['ROI ('+T('عائد نقدي على مدى العمر','lifetime cash-on-cash')+')', fmtPct(c.ROI)],
      [T('فترة استرداد رأس المال','Payback Period'), c.paybackPeriod!=null? c.paybackPeriod.toFixed(1)+' '+T('سنة','yrs') : T('لم يُسترد بالكامل','Not fully recovered')],
      ['DSCR ('+T('أدنى / متوسط','min / avg')+')', `${c.dscrMin!=null?c.dscrMin.toFixed(2):'—'}× / ${c.dscrAvg!=null?c.dscrAvg.toFixed(2):'—'}×`],
      [T('القيمة الصافية التقديرية (NAV)','Estimated NAV'), fmtSAR(c.NAV)],
    ])}
  `);

  /* ===================== 10) Cash Flow ===================== */
  const cfRows = [];
  for(let i=0;i<c.projectCF.length;i++){
    cfRows.push(`<tr>
      <td class="num">${i}</td>
      <td class="num" style="color:${pcolor(c.projectCF[i])};">${fmtSAR(c.projectCF[i])}</td>
      <td class="num" style="color:${pcolor(c.equityCF[i])};">${fmtSAR(c.equityCF[i])}</td>
    </tr>`);
  }
  html += sec(core, 10, 'التدفقات النقدية', 'Cash Flow', 'Cash Flow', `
    <div style="position:relative; height:220px; margin-bottom:14px;"><canvas id="chart-cashflow" data-opp-id="${esc(rec.id)}"></canvas></div>
    ${tbl([T('السنة','Year'), T('تدفق المشروع','Project CF'), T('تدفق حقوق الملكية','Equity CF')], cfRows)}
  `);

  /* ===================== 10b) Cash Flow Timing — دقة شهرية/ربع سنوية + ذروة الاحتياج
     النقدي الفعلي + صافي النقدي المطلوب من المستثمرين النقديين (طلب
     المستخدم الأول). إضافة بعد القسم ١٠ دون إعادة ترقيم الأقسام ١١-٢١ القائمة (نفس نمط
     08b في excel-workbook.js) — مُشتقّة من نفس صفوف c.projectCF/c.equityCF أعلاه دون أي
     تعديل عليها. ===================== */
  {
    const a = cashFlowTimingAnalysis(core, d, c, rec.id);
    const peakLabel = a.peakCashNeed.yearIndex===0 ? T('بداية المشروع (Day 0)','Project Start (Day 0)')
      : T('سنة '+a.peakCashNeed.yearIndex+' — شهر '+a.peakCashNeed.monthInYear, 'Year '+a.peakCashNeed.yearIndex+' — Month '+a.peakCashNeed.monthInYear);
    const qRows = a.equityQuarterly.map(q=>{
      const label = q.yearIndex===0 ? T('بداية المشروع (Day 0)','Project Start (Day 0)') : T('سنة '+q.yearIndex+' — ربع '+q.quarter, 'Year '+q.yearIndex+' — Q'+q.quarter);
      return `<tr><td>${label}</td><td class="num" style="color:${pcolor(q.amount)};">${fmtSAR(q.amount)}</td><td class="num" style="color:${pcolor(q.cumulative)};">${fmtSAR(q.cumulative)}</td></tr>`;
    });
    html += sec(core, '10b', T('دقة التدفقات النقدية — شهري / ربع سنوي','Cash Flow Timing Precision — Monthly / Quarterly'), 'Cash Flow Timing', 'Cash Flow Timing', `
      ${kv([
        ['🔴 '+T('ذروة الاحتياج النقدي الفعلي','Actual Peak Cash Need'), `<b style="color:${a.peakCashNeed.amount>0?'var(--bad)':'var(--good)'};">${fmtSAR(a.peakCashNeed.amount)}</b>`],
        [T('متى يحدث','When it occurs'), peakLabel],
        [T('إجمالي المساهمات العينية المرتبطة','Total linked in-kind contributions'), '🏗️ '+fmtSAR(a.totalInKind)],
        [T('إجمالي المساهمات النقدية المرتبطة','Total linked cash contributions'), '💵 '+fmtSAR(a.totalCash)],
        [T('صافي النقدي المطلوب فعلياً من المستثمرين النقديين','Net cash actually required from cash investors'), `<b>${fmtSAR(a.netCashRequiredFromCashInvestors)}</b>`],
      ])}
      ${a.linkedFunds.length===0? `<p class="note" style="margin:6px 0 10px; color:var(--bad);">⚠️ ${T('لا يوجد صندوق مرتبط بهذه الفرصة بعد — الرقم أعلاه يفترض تغطية عينية صفرية.','No fund is linked to this opportunity yet — the figure above assumes zero in-kind coverage.')}</p>` : ''}
      <p class="note" style="margin:0 0 8px; font-size:11px;">${T('التفصيل ربع السنوي أدناه (لحقوق الملكية) — التفصيل الشهري الكامل متوفر في مذكرة الفرصة الحية ودفتر الاكتتاب الكامل (Excel).','Quarterly detail below (equity) — full monthly detail is available in the live opportunity memo and the full underwriting workbook (Excel).')}</p>
      ${tbl([T('الفترة','Period'), T('تدفق حقوق الملكية','Equity CF'), T('التراكمي','Cumulative')], qRows)}
    `);
  }

  /* ===================== 11) Debt & Financing ===================== */
  const debtRows = (c.pnlRows||[]).filter(r=>r.debtService>0).map(r=>`<tr>
    <td class="num">${r.yr}</td>
    <td class="num">${fmtSAR(r.interestExpense)}</td>
    <td class="num">${fmtSAR(r.principalPayment)}</td>
    <td class="num">${fmtSAR(r.debtService)}</td>
    <td class="num">${r.debtService>0? (r.noi/r.debtService).toFixed(2)+'×' : '—'}</td>
  </tr>`);
  html += sec(core, 11, 'الدين والتمويل', 'Debt & Financing', 'Debt & Financing', `
    ${kv([
      ['SAIBOR', fmtPct(d.financing.saibor)],
      [T('هامش البنك','Bank Margin'), fmtPct(d.financing.margin)],
      [T('نسبة التمويل (LTC)','Financing Ratio (LTC)'), fmtPct(d.financing.ltc)],
      [T('إجمالي الدين','Total Debt'), fmtSAR(c.debt)],
      ['DSCR ('+T('أدنى / متوسط','min / avg')+')', `${c.dscrMin!=null?c.dscrMin.toFixed(2):'—'}× / ${c.dscrAvg!=null?c.dscrAvg.toFixed(2):'—'}×`],
    ])}
    ${d.constructionFinancing? `<p class="note" style="margin:10px 0;">💡 ${T('تمويل فعلي إضافي على تكلفة الإنشاء فقط مُسجَّل لهذه الفرصة — راجع تفاصيل الفرصة على الشاشة.','Additional actual construction-only financing is recorded for this opportunity — see the on-screen opportunity detail.')}</p>` : ''}
    ${debtRows.length? tbl([T('السنة','Year'), T('الفائدة','Interest'), T('سداد الأصل','Principal'), T('خدمة الدين','Debt Service'), 'DSCR'], debtRows) : ''}
  `);

  /* ===================== 12) Sensitivity ===================== */
  const sensRows = core.sensitivityRows(d).map(r=>`<tr>
    <td>${esc(r.label)}</td>
    <td class="num" style="color:${pcolor(r.down-r.base)};">${fmtPct(r.down)}</td>
    <td class="num" style="font-weight:700;">${fmtPct(r.base)}</td>
    <td class="num" style="color:${pcolor(r.up-r.base)};">${fmtPct(r.up)}</td>
  </tr>`);
  html += sec(core, 12, 'تحليل الحساسية', 'Sensitivity', 'Equity IRR — one variable at a time', `
    <div style="position:relative; height:200px; margin-bottom:14px;"><canvas id="chart-sensitivity" data-opp-id="${esc(rec.id)}"></canvas></div>
    ${tbl([T('المتغيّر','Variable'), T('سيناريو منخفض','Downside'), T('الأساسي','Base'), T('سيناريو مرتفع','Upside')], sensRows)}
  `);

  /* ===================== 13) Scenario Analysis ===================== */
  const scenRows = core.scenarioCompareRows(d).map(s=>`<tr>
    <td>${s.label}</td>
    <td class="num">${isFinite(s.irr)?fmtPct(s.irr):'—'}</td>
    <td class="num">${isFinite(s.moic)?s.moic.toFixed(2)+'×':'—'}</td>
    <td class="num">${isFinite(s.npv)?fmtSAR(s.npv):'—'}</td>
  </tr>`);
  const bridge = core.returnBridgeRows(d);
  html += sec(core, 13, 'تحليل السيناريوهات', 'Scenario Analysis', 'Pessimistic / Base / Optimistic', `
    <div style="position:relative; height:170px; margin-bottom:14px;"><canvas id="chart-scenarios" data-opp-id="${esc(rec.id)}"></canvas></div>
    ${tbl(['', 'Equity IRR', 'MOIC', 'NPV'], scenRows)}
    <p class="step-sub" style="margin:14px 0 6px;">${T('أثر الرافعة المالية والرسوم على العائد','Leverage & Fee Impact on Return')}</p>
    ${kv([
      ['Project IRR (Unlevered)', fmtPct(bridge.projectIRR)],
      [T('أثر الرافعة المالية','Leverage Effect'), (bridge.leverageEffect>=0?'+':'')+fmtPct(bridge.leverageEffect)],
      ['Equity IRR ('+T('قبل الرسوم','gross of fees')+')', fmtPct(bridge.equityIRRGrossOfFees)],
      [T('أثر الرسوم','Fee Drag'), (bridge.feeDrag>=0?'+':'')+fmtPct(bridge.feeDrag)],
      ['Equity IRR ('+T('صافي','net')+')', `<b>${fmtPct(bridge.equityIRRNet)}</b>`],
    ])}
  `);

  /* ===================== 14) Market Comparables ===================== */
  const comps = (core.STORE[COMPARABLES_COLLECTION] || []).map(r=>r.data).filter(cm=> cm.city && d.meta.city && cm.city.trim()===d.meta.city.trim());
  const perM2s = comps.filter(cm=>cm.landSize>0).map(cm=>cm.price/cm.landSize);
  const med = median(perM2s);
  const { rows: benchRows, scope: benchScope } = matchBenchmarks(core, d.meta.city, d.meta.oppType);
  const bench = benchRows.length? aggregateBench(benchRows) : null;
  const compRows = comps.map(cm=>`<tr>
    <td>${esc(cm.neighborhood||'—')}</td><td>${esc(cm.propertyType||'—')}</td>
    <td class="num">${fmtNum(cm.landSize)}</td><td class="num">${fmtSAR(cm.landSize>0?cm.price/cm.landSize:0)}</td>
    <td class="mono">${esc(cm.date||'')}</td>
  </tr>`);
  html += sec(core, 14, 'مقارنات السوق', 'Market Comparables', comps.length+' '+T('مقارنة','comparable(s)'), `
    ${med!=null? kv([
      [T('الوسيط (سعر/م² أرض)','Median (price/m² land)'), fmtSAR(med)],
      [T('سعر الفرصة الحالي','Subject Price'), fmtSAR(d.land.price)],
      [T('الفرق عن الوسيط','Difference vs. Median'), (((d.land.price-med)/med)>=0?'+':'')+fmtPct((d.land.price-med)/med)],
    ]) : `<p class="note">${T('لا توجد مقارنات مسجَّلة لهذه المدينة بعد.','No comparables recorded for this city yet.')}</p>`}
    ${compRows.length? tbl([T('الحي','Neighborhood'), T('النوع','Type'), T('مساحة الأرض','Land Size'), T('السعر/م²','Price/m²'), T('التاريخ','Date')], compRows) : ''}
    <p class="step-sub" style="margin:14px 0 6px;">${T('المعيار المرجعي (Benchmark)','Benchmark')} ${bench? `— ${benchScope==='exact'?T('مدينة ونوع مطابقان','matching city & type'):T('نوع الفرصة فقط','type-only')}`:''}</p>
    ${bench? kv([
      ['Equity IRR range', bench.irrMin!=null? `${fmtPct(bench.irrMin)} – ${bench.irrMax!=null?fmtPct(bench.irrMax):'—'}` : '—'],
      ['Cap Rate range', bench.capRateMin!=null? `${fmtPct(bench.capRateMin)} – ${bench.capRateMax!=null?fmtPct(bench.capRateMax):'—'}` : '—'],
      ['DSCR min (avg)', bench.dscrMin!=null? bench.dscrMin.toFixed(2)+'×' : '—'],
    ]) : `<p class="note">${T('لا يوجد معيار مرجعي مسجَّل بعد.','No benchmark recorded yet.')}</p>`}
  `);

  /* ===================== 15) Risks & Mitigations ===================== */
  const riskItems = (d.risk && d.risk.items) || defaultRiskItems();
  const riskRows = RISK_CATEGORIES.map(cat=>{
    const it = riskItems[cat.key] || {probability:1,impact:1,mitigation:'',owner:'',dueDate:''};
    const score = riskScoreOf(it), bnd = riskBandOf(score);
    return `<tr>
      <td>${T(cat.ar,cat.en)}</td>
      <td class="num">${it.probability||1} × ${it.impact||1} = ${score}</td>
      <td><span style="color:${bnd.color}; font-weight:700;">${T(bnd.ar,bnd.en)}</span></td>
      <td style="font-size:11px;">${esc(it.mitigation||'—')}</td>
      <td>${esc(it.owner||'—')}</td>
    </tr>`;
  }).sort((a,b)=>0); // الترتيب الثابت حسب RISK_CATEGORIES مقصود (لا إعادة فرز)
  html += sec(core, 15, 'المخاطر والتخفيف', 'Risks & Mitigations', 'Risk Register', `
    <div style="position:relative; height:220px; margin-bottom:14px;"><canvas id="chart-book-risk"></canvas></div>
    ${tbl([T('الفئة','Category'), T('الاحتمالية × الأثر','Probability × Impact'), T('الدرجة','Band'), T('إجراء التخفيف','Mitigation'), T('المسؤول','Owner')], riskRows)}
  `);

  /* ===================== 16) Due Diligence Status ===================== */
  const ddItems = (d.dd && d.dd.items) || defaultItemsDict();
  const dd = ddStats(ddItems);
  const ddRows = DD_CATEGORIES.map(cat=>{
    const catItems = Object.entries(ddItems).filter(([k])=>k.startsWith(cat.key));
    const done = catItems.filter(([,v])=>v.status==='completed').length;
    return `<tr><td>${T(cat.ar,cat.en)}</td><td class="num">${done}/${catItems.length}</td></tr>`;
  });
  html += sec(core, 16, 'حالة العناية الواجبة', 'Due Diligence Status', dd.completed+'/'+dd.total+' '+T('مكتمل','complete'), `
    ${kv([
      [T('نسبة الإنجاز الإجمالية','Overall Completion'), fmtPct(dd.pct)],
      [T('بنود حرجة معلّقة','Critical Items Pending'), dd.criticalPending>0? `<b style="color:var(--bad);">${dd.criticalPending}</b>` : '0'],
    ])}
    ${tbl([T('الفئة','Category'), T('مكتمل','Completed')], ddRows)}
  `);

  /* ===================== 17) IC Checklist ===================== */
  const icRecs = core.icRecommendations(d, c);
  const icRows = icRecs.map(r=>`<tr>
    <td>${esc(r.k)}</td><td class="num">${esc(r.valStr)}</td><td class="num">${esc(r.minStr)}</td><td class="num" style="color:var(--bad);">${esc(r.gapStr)}</td><td style="font-size:11px;">${esc(r.action)}</td>
  </tr>`);
  html += sec(core, 17, 'قائمة تحقق لجنة الاستثمار', 'IC Checklist', icRecs.length? icRecs.length+' '+T('معيار غير مستوفى','criteria not met') : T('كل المعايير مستوفاة','all criteria met'), `
    ${icRecs.length? tbl([T('المعيار','Criterion'), T('القيمة الحالية','Current'), T('الحد الأدنى','Minimum'), T('الفجوة','Gap'), T('الإجراء المقترح','Suggested Action')], icRows)
      : `<p class="note">✅ ${T('جميع معايير القبول المالية الأساسية مستوفاة حسب آخر حساب.','All core financial acceptance criteria are currently met.')}</p>`}
  `);

  /* ===================== 18) Negotiation Strategy ===================== */
  const walkAway = neg.walkAwayPrice!=null ? neg.walkAwayPrice : mapRes.maxPrice;
  const negHistRows = (neg.history||[]).map(h=>`<tr>
    <td class="mono">${esc(h.date||'')}</td><td>${esc(h.party||'—')}</td><td class="num">${fmtSAR(h.price)}/م²</td><td>${esc(h.status||'—')}</td>
  </tr>`);
  html += sec(core, 18, 'استراتيجية التفاوض', 'Negotiation Strategy', 'Negotiation Strategy', `
    ${kv([
      [T('سعر طلب البائع','Seller Asking Price'), neg.askingPrice!=null? fmtSAR(neg.askingPrice)+'/م²' : '—'],
      [T('السعر المُدخَل حالياً','Currently Underwritten'), fmtSAR(d.land.price)+'/م²'],
      [T('السعر المستهدف','Target Price'), neg.targetPrice!=null? fmtSAR(neg.targetPrice)+'/م²' : '—'],
      [T('الحد الأقصى للاستحواذ','Maximum Acquisition Price'), mapRes.infeasible? '—' : fmtSAR(mapRes.maxPrice)+'/م²'],
      [T('سعر الانسحاب','Walk-away Price'), `<b style="color:var(--bad);">${walkAway==null?'—':fmtSAR(walkAway)+'/م²'}</b>`],
    ])}
    ${narrative.negotiations.length? `<p class="step-sub" style="margin:12px 0 6px;">${T('نقاط تفاوض مقترحة','Suggested Negotiation Points')}</p>
    <ul style="margin:0; padding-inline-start:20px; font-size:12px; line-height:1.9;">${narrative.negotiations.map(n=>`<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    ${negHistRows.length? `<p class="step-sub" style="margin:12px 0 6px;">${T('سجل جولات التفاوض','Negotiation Rounds Log')}</p>${tbl([T('التاريخ','Date'), T('الطرف','Party'), T('السعر','Price'), T('الحالة','Status')], negHistRows)}` : ''}
  `);

  /* ===================== 19) Conditions Precedent ===================== */
  const condRows = latest && latest.conditions && latest.conditions.length
    ? latest.conditions.map(cn=>`<tr><td style="font-size:11.5px;">${esc(cn.text||'—')}</td><td>${esc(cn.owner||'—')}</td><td class="mono">${esc(cn.dueDate||'—')}</td><td>${esc(cn.status||'pending')}</td></tr>`)
    : [];
  html += sec(core, 19, 'الشروط المسبقة للاعتماد', 'Conditions Precedent', 'Conditions Precedent', `
    ${condRows.length? tbl([T('الشرط','Condition'), T('المسؤول','Owner'), T('الموعد النهائي','Due Date'), T('الحالة','Status')], condRows)
      : `<p class="note">${T('لا توجد شروط مسبقة مسجَّلة على قرار اللجنة الأحدث.','No conditions precedent recorded on the latest IC decision.')}</p>`}
  `);

  /* ===================== 20) Final Recommendation ===================== */
  const decHistRows = decisions.slice().reverse().map(dec=>`<tr>
    <td><span style="color:${DEC_COLOR[dec.decision]}; font-weight:700;">${T(DEC_LABEL[dec.decision][0],DEC_LABEL[dec.decision][1])}</span></td>
    <td style="font-size:11px;">${(dec.reasons||[]).map(esc).join('؛ ')||'—'}</td>
    <td>${esc(dec.decidedBy||'—')}</td>
    <td class="mono">${esc(dec.decidedAt||'—')}</td>
  </tr>`);
  html += sec(core, 20, 'التوصية النهائية', 'Final Recommendation', 'Final Recommendation', `
    <div class="verdict-banner ${vcls}" style="margin-bottom:12px;">${vlbl}</div>
    ${decHistRows.length? tbl([T('القرار','Decision'), T('الأسباب','Reasons'), T('اتُّخذ بواسطة','Decided By'), T('التاريخ','Date')], decHistRows)
      : `<p class="note">${T('لم تجتمع لجنة الاستثمار على هذه الفرصة بعد.','The Investment Committee has not yet convened on this opportunity.')}</p>`}
  `);

  /* ===================== 21) Sources / Evidence / Disclaimer ===================== */
  const evidenceCount = Object.keys(d.evidence||{}).length;
  html += sec(core, 21, 'المصادر والأدلة وإخلاء المسؤولية', 'Sources / Evidence / Disclaimer', 'Sources / Evidence / Disclaimer', `
    ${kv([
      [T('عدد الحقول الموثَّقة بمصدر','Fields with a documented source'), fmtNum(evidenceCount)],
      [T('تاريخ سريان البيانات','As-of Date'), esc(reportDates.asOfText)],
      [T('تاريخ إنشاء الملف','Generated on'), esc(reportDates.generatedText)],
    ])}
    <p style="margin:12px 0 0; font-size:11px; line-height:1.8; color:var(--ink-faint);">
      ${T('هذا الكتاب أُعِدَّ آلياً من بيانات مُدخَلة داخل تطبيق مستكشف الفرص العقارية، ويستند إلى الافتراضات المُدخَلة من المحلل المسؤول وقت الإعداد. الأرقام هنا تقديرية ولا تُغني عن تقييم مستقل معتمد أو مراجعة قانونية/ضريبية/شرعية متخصصة قبل اتخاذ أي قرار استثماري نهائي. جميع الحقوق محفوظة.',
        'This book was automatically compiled from data entered into the Opal Real Estate Opportunity Explorer, and is based on assumptions entered by the responsible analyst at the time of preparation. Figures here are estimates and do not substitute for an accredited independent valuation or specialized legal/tax/Sharia review before any final investment decision. All rights reserved.')}
    </p>
  `);

  /* إغلاق غلاف .memo المفتوح في بداية صفحة الغلاف (القسم ١) — بعد آخر قسم مباشرة. */
  html += `</div>`;

  return html;
}
