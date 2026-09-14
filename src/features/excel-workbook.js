/* =========================================================================
   دفتر الاكتتاب الاستثماري الكامل — Investment Underwriting Workbook (٢١ ورقة)
   ---------------------------------------------------------------------------
   إعادة هيكلة تصدير Excel من "تصدير" (exportOpportunityExcel الحالية في
   core.js، تبقى كما هي دون أي تعديل — لا تزال متاحة كتصدير سريع) إلى نسخة
   تحليلية كاملة قابلة للتدقيق بهيكل ٢١ ورقة قياسي (00_IC Dashboard →
   20_Audit Trail)، حسب طلب المستخدم بالضبط (خطة_التقارير_والمهام_القادمة.md
   § ٢). يُعاد استخدام كل محرك بناء الشيتات المهنية المُصدَّر أصلاً من core.js
   (XL/xlBorderAll/xlColLetter/xlRowsBuilder/xlNewSheet/xlSetFormula — نفس
   الأداة المستخدمة في exportOpportunityExcel نفسها)، بلا أي تكرار أو تعديل
   على منطق core.js الداخلي. الإضافة الوحيدة هنا فوق تلك الأداة: طبقة تلوين
   خلايا رقيقة (colorize()) تُطبِّق تمييز "معيار الاكتتاب المهني" الإلزامي —
   أزرق=مُدخل يدوي (Hardcoded Input) / أسود=معادلة أو رقم محسوب (Calculated
   Output) / أخضر=رابط بين الأوراق (Linked Formula) / أصفر=بيانات سوق خارجية
   (External Market Data) — مع دليل ألوان (Legend) صريح في أول ورقة (00)، حتى
   يعرف أي محلل يفتح الملف مصدر كل رقم دون سؤال (بالضبط طلب المستخدم). حيث
   أمكن (مجاميع TPC/Equity، وIRR/NPV على مدى صفوف التدفقات النقدية داخل نفس
   الشيت) نكتب معادلات Excel حقيقية (SUM/IRR/NPV) بدل أرقام جامدة — بقية أرقام
   المحرك المالي المعقّدة (NAV، تسلسل توزيع الأرباح الكامل، تقدير الزكاة...)
   قيمًا محسوبة موثَّقة بوضوح (🔒 محسوبة بواسطة محرك التطبيق) بدل إعادة بناء
   محرك compute() بالكامل كمعادلات Excel — قرار هندسي واعٍ يوازن بين "معادلات
   حقيقية لا أرقام جامدة" (مهارة xlsx) وحجم/مخاطرة إعادة بناء محرك مالي كامل
   خارج core.js. لا تعديل على منطق core.js الداخلي — فقط عبر نقاط التوسّع
   المُصدَّرة والدوال المُصدَّرة أصلاً.
   ========================================================================= */

import { ddStats, defaultItemsDict, DD_CATEGORIES } from './due-diligence.js';
import { RISK_CATEGORIES, defaultRiskItems, scoreOf as riskScoreOf, bandOf as riskBandOf } from './risk-engine.js';
import { matchBenchmarks, aggregateBench } from './benchmark-engine.js';
import { maxAcquisitionPrice } from './max-acquisition-price.js';
import { computeInvestmentScore, scoreBand } from './investment-score.js';
import { computeDecisionConfidence } from './decision-confidence.js';
// دقة التدفقات النقدية (شهري/ربع سنوي) + ذروة الاحتياج + صافي النقدي من المستثمرين النقديين
// إعادة استخدام مباشرة لنفس دوال cash-flow-timing.js المستخدَمة في واجهة
// المذكرة الحية، حتى لا يتكرر منطق منحنى S/التوزيع الشهري في أكثر من مكان (يبقى مصدراً واحداً).
import { cashFlowTimingAnalysis } from './cash-flow-timing.js';

const COMPARABLES_COLLECTION = 'comparables';
const SEM = { INPUT:'FF1E40AF', LINK:'FF15803D', EXT_FONT:'FF92650B', EXT_FILL:'FFFEF3C7' };
const DEC_LABEL = {
  approve:['اعتماد','Approve'], approve_conditions:['اعتماد بشروط','Approve with Conditions'],
  revise:['مراجعة وإعادة عرض','Revise & Resubmit'], hold:['تعليق','Hold'], reject:['رفض','Reject'],
};

function median(nums){
  if(!nums.length) return null;
  const s = nums.slice().sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length%2 ? s[mid] : (s[mid-1]+s[mid])/2;
}

/* ---------------------------------------------------------------------
   رسوم بيانية داخل Excel — طلب المستخدم صراحة ("ليه البي دي اف والاكسل مش
   يفهم شارتس"). ExcelJS لا يدعم رسوماً بيانية أصلية (Native Charts) إطلاقاً
   (مؤكَّد من التوثيق الرسمي لمكتبة exceljs — قسم Images فقط)، فالحل العملي
   الوحيد هو رسم Chart.js (المكتبة محمَّلة أصلاً عبر CDN في index.html) على
   canvas منفصل غير مرفق بالـDOM بأبعاد بكسل صريحة، ثم تحويله لصورة PNG
   وإدراجها كصورة ثابتة في الورقة عبر workbook.addImage/worksheet.addImage —
   بلا أي تعديل على core.js، وبلا أي تكرار — تُستدعى فقط من هنا.
   --------------------------------------------------------------------- */
async function chartToImage(config, width, height){
  if(typeof Chart==='undefined' || typeof document==='undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  let chart = null;
  try{
    const cfg = Object.assign({}, config, { options: Object.assign({}, config.options, { responsive:false, maintainAspectRatio:false, animation:false, devicePixelRatio:1 }) });
    chart = new Chart(canvas, cfg);
    // انتظار إطارَي رسم متتاليَين لضمان اكتمال الرسم فعلياً على الـcanvas قبل التقاطه —
    // Chart.js يُجدوِل الرسم الأول عبر requestAnimationFrame حتى مع animation:false.
    await new Promise(resolve=>{
      const raf = (typeof window!=='undefined' && window.requestAnimationFrame) ? window.requestAnimationFrame : (fn)=>setTimeout(fn,30);
      raf(()=> raf(resolve));
    });
    return canvas.toDataURL('image/png');
  }catch(e){ console.error('تعذّر رسم الرسم البياني لملف Excel:', e); return null; }
  finally{ if(chart){ try{ chart.destroy(); }catch(e){} } }
}
async function addChartImage(wb, ws, config, width, height, tlCol, tlRow){
  const dataUrl = await chartToImage(config, width, height);
  if(!dataUrl) return;
  try{
    const imageId = wb.addImage({ base64:dataUrl, extension:'png' });
    ws.addImage(imageId, { tl:{ col:tlCol, row:tlRow }, ext:{ width, height } });
  }catch(e){ console.error('تعذّر إدراج صورة الرسم البياني في Excel:', e); }
}
const XL_CHART_COLORS = { accent:'#5B4FE8', gold:'#D6558B', good:'#1FA67E', goodSoft:'rgba(31,166,126,0.55)', warn:'#C98A2E', warnSoft:'rgba(201,138,46,0.55)', bad:'#C23B5B', badSoft:'rgba(194,59,91,0.55)', ink:'#241B36', grid:'rgba(36,27,54,0.12)' };
const XL_CHART_FONT = { family:"'Aptos','Segoe UI',Arial,sans-serif", size:11 };
const XL_CHART_BASE = { plugins:{ legend:{ labels:{ color:XL_CHART_COLORS.ink, font:XL_CHART_FONT } } },
  scales:{ x:{ ticks:{ color:XL_CHART_COLORS.ink, font:XL_CHART_FONT }, grid:{ color:XL_CHART_COLORS.grid } }, y:{ ticks:{ color:XL_CHART_COLORS.ink, font:XL_CHART_FONT }, grid:{ color:XL_CHART_COLORS.grid } } } };

export function registerExcelWorkbook(core){
  core.registerDetailSection((d,c)=>{
    const oppId = core.openDetailId;
    const rec = core.opportunities.find(o=>o.id===oppId);
    if(!rec) return '';
    return `
    <div class="section" style="text-align:center; background:var(--surface-2); border:1px dashed var(--border);">
      <button type="button" class="btn btn-sm btn-primary" data-action="xlbook-export" data-id="${rec.id}">📊 ${core.T('تنزيل دفتر الاكتتاب الكامل (Excel، ٢١ ورقة)','Download Full Underwriting Workbook (Excel, 21 sheets)')}</button>
      <p class="note" style="margin:8px 0 0;">${core.T('نسخة تحليلية كاملة قابلة للتدقيق — تمييز لوني إلزامي بين المُدخلات اليدوية والنتائج المحسوبة والروابط بين الأوراق وبيانات السوق الخارجية.','A full auditable analytical workbook — mandatory color-coding between hardcoded inputs, calculated outputs, cross-sheet links, and external market data.')}</p>
    </div>`;
  });

  core.registerActionHandler(async (action, el)=>{
    if(action==='xlbook-export'){ await exportUnderwritingWorkbook(core, el.dataset.id); return true; }
    return false;
  });
}

/* ---------------------------------------------------------------------
   طبقة التلوين الرقيقة فوق core.xlNewSheet — تُطبَّق بعد بناء الشيت.
   sem: مصفوفة موازية لـkinds، بنفس الطول، بقيمة لكل صف بيانات:
   'input' (أزرق) / 'link' (أخضر) / 'ext' (أصفر + نص كهرماني) / null (أسود، افتراضي).
   colIdx: رقم العمود (1-based) المطلوب تلوينه في كل صف (افتراضياً العمود ٢).
   --------------------------------------------------------------------- */
function colorize(ws, kinds, sem, colIdx){
  colIdx = colIdx || 2;
  kinds.forEach((k, i)=>{
    const s = sem[i];
    if(!s || k!=='data') return;
    const cell = ws.getCell(i+1, colIdx);
    if(s==='input'){ cell.font = Object.assign({}, cell.font, { color:{argb:SEM.INPUT} }); }
    else if(s==='link'){ cell.font = Object.assign({}, cell.font, { color:{argb:SEM.LINK} }); }
    else if(s==='ext'){
      cell.font = Object.assign({}, cell.font, { color:{argb:SEM.EXT_FONT} });
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{argb:SEM.EXT_FILL} };
    }
  });
}
/* باني صفوف مساعد: يُرجع {B, SEM} — B لتمرير مباشر لـcore.xlRowsBuilder، SEM موازية لتتبّع النوع الدلالي. */
function rowsBuilder(){
  const B = []; const S = [];
  return {
    push(vals, kind, sem){ B.push(vals); S.push(sem||null); return B.length; },
    get rows(){ return B; },
    kinds: null, // يُملأ لاحقاً عبر kindsFrom
    sem: S,
  };
}

export async function exportUnderwritingWorkbook(core, id){
  const rec = core.opportunities.find(o=>o.id===id);
  if(!rec) return;
  const d = core.withDefaults(rec.data), c = core.compute(d);
  const reportDates = core.reportDateMeta(d);
  const scoreRes = computeInvestmentScore(core, d, c);
  const scoreResBand = scoreBand(scoreRes.composite);
  const decisionConfidence = computeDecisionConfidence(core, d);
  const { fmtSAR, fmtPct, fmtNum, XL, xlRowsBuilder, xlNewSheet, xlSetFormula, xlColLetter } = core;

  try{
    const wb = new ExcelJS.Workbook();
    wb.creator = 'مستكشف الفرص العقارية — أوبال';
    wb.calcProperties = { fullCalcOnLoad:true };

    /* ===================== 00_IC Dashboard ===================== */
    {
      const B = xlRowsBuilder(); const S = [];
      const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
      push(['دفتر الاكتتاب الاستثماري الكامل — Investment Underwriting Workbook',''],'title');
      push(['الفرصة (Opportunity)', d.meta.name||'—']);
      push(['المعرّف (ID)', rec.id]);
      push(['تاريخ سريان البيانات (As-of Date)', reportDates.asOfText]);
      push(['تاريخ إنشاء الملف (Generated on)', reportDates.generatedText]);
      push(['', '']);
      push(['دليل الألوان — من أين أتى كل رقم (Color Legend — Where Every Number Comes From)', ''],'section');
      push(['🔵 أزرق — مُدخل يدوي (Hardcoded Input)', 'يُدخله المحلل مباشرة — عدّله بحذر'], 'header');
      push(['⚫ أسود — نتيجة محسوبة (Calculated Output)', 'ناتج معادلة أو محرك التطبيق — لا تُعدَّل يدوياً']);
      push(['🟢 أخضر — رابط بين الأوراق (Linked Formula)', 'يشير لخلية في ورقة أخرى داخل نفس الملف']);
      push(['🟡 أصفر (تظليل) — بيانات سوق خارجية (External Market Data)', 'مصدرها مقارنات/معيار مرجعي مُدخَل يدوياً في التطبيق']);
      push(['', '']);
      push(['لوحة القرار (Decision Dashboard)', ''],'section');
      push(['المؤشر (Metric)', 'القيمة (Value)'],'header');
      push(['TPC', Math.round(c.TPC)]);
      push(['Composite Investment Score', `${scoreRes.composite.toFixed(0)}/100 (${core.T(scoreResBand.ar,scoreResBand.en)})`]);
      push(['Decision Confidence', `${decisionConfidence.score.toFixed(0)}/100 (${core.T(decisionConfidence.band.ar,decisionConfidence.band.en)})`]);
      push(['Equity IRR', fmtPct(c.equityIRR,2)]);
      push(['Project IRR', fmtPct(c.projectIRR,2)]);
      push(['MOIC', c.MOIC.toFixed(2)+'×']);
      push(['DSCR (أدنى / متوسط)', `${c.dscrMin!=null?c.dscrMin.toFixed(2):'—'}× / ${c.dscrAvg!=null?c.dscrAvg.toFixed(2):'—'}×`]);
      push(['NPV (Project)', Math.round(c.npvProject)]);
      push(['التوصية (Verdict)', c.verdict==='good'?'🟢 قابلة للعرض':c.verdict==='warn'?'🟡 تحت المراجعة':'🔴 دون المعايير']);
      const decisions = (d.ic && d.ic.decisions) || [];
      const latest = decisions.length? decisions[decisions.length-1] : null;
      push(['قرار اللجنة الأحدث (Latest IC Decision)', latest? core.T(DEC_LABEL[latest.decision][0],DEC_LABEL[latest.decision][1]) : 'لم يُتخَذ بعد']);
      push(['ملاحظة الحوكمة (Interpretation)', core.T('Investment Score = جاذبية الصفقة، وDecision Confidence = قوة التوثيق والتحقق الداعمَين للقرار.','Investment Score = deal attractiveness; Decision Confidence = strength of the supporting documentation and verification.')]);
      const ws = xlNewSheet(wb, '00_IC Dashboard', B.rows, B.kinds, { colWidths:[52,30] });
      /* دليل الألوان (الصفوف ٨-١١): بعد إزالة الرموز التعبيرية (🔵⚫🟢🟡 — غير مدعومة في خط
         Sakkal Majalla فتظهر كمربع فيه علامة استفهام) من نص الخلية، نطبّق نفس تلوين colorize()
         الحقيقي المُستخدَم فعلياً في بقية الورقة مباشرة على خلايا الدليل نفسها، ليبقى الدليل تفسيرياً
         بصرياً حقيقياً (لون الخلية) بدل رمز نصي. */
      [8,9,10,11].forEach(rn=>{
        const cell = ws.getCell(rn,1);
        if(rn===8){ cell.font = Object.assign({}, cell.font, { color:{argb:SEM.INPUT} }); }
        else if(rn===10){ cell.font = Object.assign({}, cell.font, { color:{argb:SEM.LINK} }); }
        else if(rn===11){
          cell.font = Object.assign({}, cell.font, { color:{argb:SEM.EXT_FONT} });
          cell.fill = { type:'pattern', pattern:'solid', fgColor:{argb:SEM.EXT_FILL} };
        }
      });
      const dashRow = B.rows.length + 2;
      await addChartImage(wb, ws, { type:'doughnut',
        data:{ labels:['Debt','Equity'], datasets:[{ data:[Math.round(c.debt), Math.round(c.equity)], backgroundColor:[XL_CHART_COLORS.gold, XL_CHART_COLORS.accent] }] },
        options:Object.assign({}, XL_CHART_BASE, { plugins:{ title:{ display:true, text:'Capital Structure — Debt vs Equity', color:XL_CHART_COLORS.ink, font:{ size:13, weight:'bold' } }, legend:{ position:'bottom', labels:{ color:XL_CHART_COLORS.ink, font:XL_CHART_FONT } } } })
      }, 330, 250, 0, dashRow);
      const hurdle = (d.criteria && d.criteria.irrMin) || 0.15;
      const moicMin = (d.criteria && d.criteria.moicMin) || 1.5;
      const dscrMin = (d.criteria && d.criteria.dscrMin) || 1.2;
      const rMetrics = [
        hurdle>0 && isFinite(c.equityIRR)? { label:'Equity IRR', ratio:Math.round((c.equityIRR/hurdle)*100) } : null,
        moicMin>0 && isFinite(c.MOIC)? { label:'MOIC', ratio:Math.round((c.MOIC/moicMin)*100) } : null,
        dscrMin>0 && c.dscrMin!=null? { label:'DSCR', ratio:Math.round((c.dscrMin/dscrMin)*100) } : null,
      ].filter(Boolean);
      await addChartImage(wb, ws, { type:'bar',
        data:{ labels:rMetrics.map(m=>m.label), datasets:[{ label:'% of Minimum Required (100% = hurdle)', data:rMetrics.map(m=>m.ratio),
          backgroundColor:rMetrics.map(m=>m.ratio>=100?XL_CHART_COLORS.goodSoft:XL_CHART_COLORS.badSoft), borderColor:rMetrics.map(m=>m.ratio>=100?XL_CHART_COLORS.good:XL_CHART_COLORS.bad), borderWidth:1.5 }] },
        options:Object.assign({}, XL_CHART_BASE, { plugins:{ title:{ display:true, text:'Returns vs Minimum Hurdles (%)', color:XL_CHART_COLORS.ink, font:{ size:13, weight:'bold' } }, legend:{ display:false } },
          scales:{ x:XL_CHART_BASE.scales.x, y:Object.assign({}, XL_CHART_BASE.scales.y, { ticks:{ color:XL_CHART_COLORS.ink, callback:(v)=>v+'%' } }) } })
      }, 380, 250, 4, dashRow);
    }

    /* ===================== 01_Opportunity ===================== */
    {
      const B = xlRowsBuilder(); const S = [];
      const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
      push(['بيانات الفرصة — Opportunity',''],'title');
      push(['الحقل (Field)','القيمة (Value)'],'header');
      push(['المعرّف (ID)', rec.id]);
      push(['الاسم (Name)', d.meta.name||'—'], 'data', 'input');
      push(['المدينة (City)', d.meta.city], 'data', 'input');
      push(['الحي (Neighborhood)', d.meta.neighborhood||'—'], 'data', 'input');
      push(['الفئة (Tier)', d.meta.tier], 'data', 'input');
      push(['نوع الفرصة (Type)', core.T(core.OPP_TYPE_INFO[d.meta.oppType].t, core.OPP_TYPE_INFO[d.meta.oppType].en)]);
      push(['نوع الاستخدام (Use Type)', d.meta.useType||'—'], 'data', 'input');
      push(['المحلل (Analyst)', d.meta.analyst||'—'], 'data', 'input');
      push(['تاريخ سريان البيانات (As-of Date)', reportDates.asOfText]);
      push(['تاريخ الإنشاء (Created)', d.meta.createdAt||'—']);
      push(['آخر تحديث (Updated)', d.meta.updatedAt||'—']);
      xlNewSheet(wb, '01_Opportunity', B.rows, B.kinds, { colWidths:[36,30] });
      colorize(wsLast(wb), B.kinds, S);
    }

    /* ===================== 02_Assumptions ===================== */
    {
      const B = xlRowsBuilder(); const S = [];
      const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
      push(['جميع الافتراضات — All Assumptions',''],'title');
      push(['الأرض (Land)',''],'section');
      push(['المتغيّر','القيمة'],'header');
      push(['مساحة الأرض (Land Area) م²', d.land.area], 'data', 'input');
      push(['سعر متر الأرض (Land Price/m²)', d.land.price], 'data', 'input');
      push(['معامل البناء (FAR)', d.land.far], 'data', 'input');
      push(['عدد البدرومات (Basements)', d.land.basements||0], 'data', 'input');
      push(['ارتفاع الدور (Floor Height) م', d.land.floorHeight||3.6], 'data', 'input');
      push(['التمويل (Financing)',''],'section');
      push(['المتغيّر','القيمة'],'header');
      push(['SAIBOR', fmtPct(d.financing.saibor)], 'data', 'input');
      push(['هامش البنك (Margin)', fmtPct(d.financing.margin)], 'data', 'input');
      push(['نسبة التمويل (LTC)', fmtPct(d.financing.ltc)], 'data', 'input');
      push(['معايير القبول (Acceptance Criteria)',''],'section');
      push(['المتغيّر','القيمة'],'header');
      push(['الحد الأدنى لـEquity IRR', fmtPct(d.criteria.irrMin)], 'data', 'input');
      push(['الحد الأدنى لـDSCR', (d.criteria.dscrMin||0).toFixed(2)+'×'], 'data', 'input');
      push(['الحد الأدنى لـMOIC', (d.criteria.moicMin||0).toFixed(2)+'×'], 'data', 'input');
      if(d.meta.oppType==='development'){
        push(['التطوير (Development)',''],'section');
        push(['المتغيّر','القيمة'],'header');
        push(['سعر البيع المتوقع/م²', d.development.salePrice], 'data', 'input');
        push(['تكلفة البناء/م²', d.development.buildCost], 'data', 'input');
        push(['مدة الإنشاء (سنوات)', d.development.constructionYears], 'data', 'input');
        push(['معدل الرسملة عند الخروج', fmtPct(d.development.exitCapRate)], 'data', 'input');
        push(['احتياطي الطوارئ', fmtPct(d.development.contingency)], 'data', 'input');
      } else if(d.meta.oppType==='income'){
        push(['الدخل التأجيري (Income)',''],'section');
        push(['المتغيّر','القيمة'],'header');
        push(['الإيجار السنوي/م²', d.income.rent], 'data', 'input');
        push(['نسبة الإشغال', fmtPct(d.income.occupancy)], 'data', 'input');
        push(['نسبة OPEX', fmtPct(d.income.opex)], 'data', 'input');
      } else {
        push(['بنك الأراضي (Land Bank)',''],'section');
        push(['المتغيّر','القيمة'],'header');
        push(['معدل النمو السنوي', d.landbank? fmtPct(d.landbank.appreciation) : '—'], 'data', 'input');
        push(['تكلفة الحمل السنوية', d.landbank? fmtSAR(d.landbank.carryAnnual) : '—'], 'data', 'input');
        push(['مدة الاحتفاظ (سنوات)', d.landbank? d.landbank.holdingYears : '—'], 'data', 'input');
      }
      xlNewSheet(wb, '02_Assumptions', B.rows, B.kinds, { colWidths:[42,26] });
      colorize(wsLast(wb), B.kinds, S);
    }

    /* ===================== 03_Sources & Uses ===================== */
    {
      const B = xlRowsBuilder(); const S = [];
      const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
      push(['مصادر واستخدامات الأموال — Sources & Uses',''],'title');
      push(['الاستخدامات (Uses)',''],'section');
      push(['البند','القيمة (ر.س)'],'header');
      const rLand = push(['تكلفة الأرض (Land Cost)', Math.round(c.landCost)]);
      const rHard = push(['التكلفة الإنشائية (Hard Cost)', Math.round(c.hardCost)]);
      const rFixed = push(['تكاليف ثابتة (One-time Fixed)', Math.round(c.oneTimeFixed)]);
      const rStruct = push(['رسوم الهيكلة (Structuring Fee)', Math.round(c.structuringFee)]);
      const rAcq = push(['رسوم الاستحواذ (Acquisition Fee)', Math.round(c.acquisitionFee)]);
      const rArr = push(['رسوم الترتيب (Arrangement Fee)', Math.round(c.arrangementFee)]);
      const rTPC = push(['إجمالي تكلفة المشروع (TPC)', null]);
      push(['المصادر (Sources)',''],'section');
      push(['البند','القيمة (ر.س)'],'header');
      const rDebt = push(['الدين (Debt)', Math.round(c.debt)]);
      const rEquity = push(['حقوق الملكية (Equity)', null]);
      const rTotal = push(['الإجمالي (Total)', null]);
      const ws = xlNewSheet(wb, '03_Sources & Uses', B.rows, B.kinds, { colWidths:[40,22] });
      colorize(ws, B.kinds, S);
      // معادلات حقيقية: TPC = مجموع بنود الاستخدامات، Equity = TPC - Debt، Total = Debt+Equity
      xlSetFormula(ws, rTPC, 2, `SUM(B${rLand}:B${rArr})`, '#,##0;(#,##0);"-"');
      xlSetFormula(ws, rEquity, 2, `B${rTPC}-B${rDebt}`, '#,##0;(#,##0);"-"');
      xlSetFormula(ws, rTotal, 2, `B${rDebt}+B${rEquity}`, '#,##0;(#,##0);"-"');
    }

    /* ===================== 04_Development ===================== */
    build04Development(core, wb, d, c);

    /* ===================== 05_Revenue ===================== */
    build05Revenue(core, wb, d, c);

    /* ===================== 06_OPEX ===================== */
    build06Opex(core, wb, d, c);

    /* ===================== 07_Debt ===================== */
    build07Debt(core, wb, d, c);

    /* ===================== 08_Project CF / 09_Equity CF ===================== */
    await build0809CashFlowsWithChart(core, wb, d, c);

    /* ===================== 08b_Cash Flow Timing (شهري/ربع سنوي + ذروة الاحتياج) ===================== */
    build0809bCashFlowTiming(core, wb, d, c, rec.id);

    /* ===================== 10_Returns ===================== */
    build10Returns(core, wb, d, c);

    /* ===================== 11_Sensitivity ===================== */
    await build11Sensitivity(core, wb, d, c);

    /* ===================== 12_Scenarios ===================== */
    await build12Scenarios(core, wb, d, c);

    /* ===================== 13_Comparables ===================== */
    build13Comparables(core, wb, d, c);

    /* ===================== 14_Risk Register ===================== */
    await build14RiskRegister(core, wb, d, c);

    /* ===================== 15_DD ===================== */
    build15DD(core, wb, d, c);

    /* ===================== 16_IC Checklist ===================== */
    build16ICChecklist(core, wb, d, c);

    /* ===================== 17_Negotiation ===================== */
    build17Negotiation(core, wb, d, c);

    /* ===================== 18_Waterfall ===================== */
    build18Waterfall(core, wb, d, c);

    /* ===================== 19_Fund Ledger ===================== */
    build19FundLedger(core, wb, rec, d, c);

    /* ===================== 20_Audit Trail ===================== */
    build20AuditTrail(core, wb, rec);

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${rec.id}-Underwriting-Workbook.xlsx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url), 8000);
  }catch(e){
    alert('تعذّر تصدير دفتر الاكتتاب: '+e.message+'\nافتح رابط الأداة مباشرة في تبويب متصفح جديد (وليس داخل نافذة المعاينة) ثم أعد المحاولة.');
  }
}

/* آخر ورقة أُضيفت للمصنَّف — مساعد صغير لأن core.xlNewSheet لا يُرجَّع عبر متغيّر محفوظ دائماً أعلاه. */
function wsLast(wb){ return wb.worksheets[wb.worksheets.length-1]; }

function build04Development(core, wb, d, c){
  const { fmtSAR, fmtPct, xlRowsBuilder, xlNewSheet } = core;
  const B = xlRowsBuilder(); const S = [];
  const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
  push(['برنامج التطوير — Development Program',''],'title');
  push(['البند','القيمة'],'header');
  if(d.meta.oppType==='development'){
    push(['سعر البيع المتوقع/م²', fmtSAR(d.development.salePrice)], 'data', 'input');
    push(['تكلفة البناء/م²', fmtSAR(d.development.buildCost)], 'data', 'input');
    push(['مدة الإنشاء (سنوات)', d.development.constructionYears], 'data', 'input');
    push(['مدة التشغيل بعد الإنشاء (سنوات)', d.development.operationYears||0], 'data', 'input');
    push(['معدل الرسملة عند الخروج', fmtPct(d.development.exitCapRate)], 'data', 'input');
    push(['الكفاءة (Efficiency)', fmtPct(d.development.efficiency)], 'data', 'input');
    push(['احتياطي الطوارئ (Contingency)', fmtPct(d.development.contingency)], 'data', 'input');
    push(['المساحة الإجمالية القابلة للتأجير/البيع (GFA م²)', Math.round(c.gfa||0)]);
    push(['التكلفة الإنشائية الأساسية (قبل الطوارئ)', Math.round(c.hardCostBase||0)]);
    push(['🔒 التكلفة الإنشائية الكلية (Hard Cost)', Math.round(c.hardCost||0)]);
  } else {
    push(['— لا ينطبق (الفرصة ليست من نوع تطوير)', 'N/A — not a Development opportunity']);
  }
  const ws = xlNewSheet(wb, '04_Development', B.rows, B.kinds, { colWidths:[42,26] });
  colorize(ws, B.kinds, S);
}

function build05Revenue(core, wb, d, c){
  const { fmtSAR, fmtPct, xlRowsBuilder, xlNewSheet } = core;
  const B = xlRowsBuilder(); const S = [];
  const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
  push(['الإيرادات — Revenue',''],'title');
  push(['البند','القيمة'],'header');
  if(d.meta.oppType==='income'){
    push(['الإيجار السنوي/م²', fmtSAR(d.income.rent)], 'data', 'input');
    push(['نسبة الإشغال (Occupancy)', fmtPct(d.income.occupancy)], 'data', 'input');
    push(['متوسط العمر المتبقي للعقود (WALE)', d.income.wale!=null? d.income.wale+' سنة':'—'], 'data', 'input');
    push(['تركّز أكبر مستأجر', d.income.tenantConc!=null? fmtPct(d.income.tenantConc):'—'], 'data', 'input');
    push(['🔒 صافي الدخل التشغيلي (سنة ١ مستقر)', Math.round(c.stabilizedNOIyr1||0)]);
    push(['🔒 عائد التكلفة (Yield on Cost)', fmtPct(c.yieldOnCost)]);
  } else if(d.meta.oppType==='development'){
    push(['سعر البيع المتوقع/م² (من ورقة 04)', fmtSAR(d.development.salePrice)], 'data', 'link');
    push(['نسبة البيع من الاستراتيجية', d.strategy&&d.strategy.salePct!=null? fmtPct(d.strategy.salePct):'—'], 'data', 'input');
  } else {
    push(['معدل نمو قيمة الأرض السنوي', d.landbank? fmtPct(d.landbank.appreciation):'—'], 'data', 'input');
    push(['دخل مرحلي (إن وُجد)', d.landbank&&d.landbank.interimAnnualIncome? fmtSAR(d.landbank.interimAnnualIncome):'—'], 'data', 'input');
  }
  const ws = xlNewSheet(wb, '05_Revenue', B.rows, B.kinds, { colWidths:[42,26] });
  colorize(ws, B.kinds, S);
}

function build06Opex(core, wb, d, c){
  const { fmtSAR, fmtPct, xlRowsBuilder, xlNewSheet } = core;
  const B = xlRowsBuilder(); const S = [];
  const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
  push(['المصروفات التشغيلية — OPEX',''],'title');
  push(['البند','القيمة'],'header');
  if(d.meta.oppType==='income'){
    push(['نسبة المصاريف التشغيلية (OPEX Ratio)', fmtPct(d.income.opex)], 'data', 'input');
    push(['🔒 صافي الدخل التشغيلي بعد OPEX (سنة ١)', Math.round(c.stabilizedNOIyr1||0)]);
  }
  push(['🔒 رسوم إدارة الصندوق التراكمية (Mgmt Fee)', Math.round(c.mgmtFeeTotal||0)]);
  push(['🔒 رسوم إدارة الأصول التراكمية (Asset Mgmt Fee)', Math.round(c.assetMgmtTotal||0)]);
  push(['🔒 رسوم تنظيمية/تدقيق/أمين حفظ', Math.round(c.regAuditCustodianTotal||0)]);
  push(['🔒 إجمالي رسوم الصندوق (Fund-Side Fees)', Math.round(c.fundSideFees||0)]);
  push(['🔒 نسبة إجمالي الرسوم من TPC', fmtPct(c.feesPctOfTPC)]);
  const ws = xlNewSheet(wb, '06_OPEX', B.rows, B.kinds, { colWidths:[42,26] });
  colorize(ws, B.kinds, S);
}

function build07Debt(core, wb, d, c){
  const { fmtSAR, fmtPct, xlRowsBuilder, xlNewSheet, xlSetFormula } = core;
  const B = xlRowsBuilder(); const S = [];
  const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
  push(['التمويل والديون — Debt',''],'title');
  push(['البند','القيمة'],'header');
  push(['SAIBOR', fmtPct(d.financing.saibor)], 'data', 'input');
  push(['هامش البنك (Margin)', fmtPct(d.financing.margin)], 'data', 'input');
  push(['نسبة التمويل (LTC)', fmtPct(d.financing.ltc)], 'data', 'input');
  push(['🔒 إجمالي الدين (Total Debt)', Math.round(c.debt||0)]);
  push(['🔒 DSCR (أدنى)', c.dscrMin!=null?c.dscrMin.toFixed(2)+'×':'—']);
  push(['🔒 DSCR (متوسط)', c.dscrAvg!=null?c.dscrAvg.toFixed(2)+'×':'—']);
  const rows = (c.pnlRows||[]).filter(r=>r.debtService>0);
  if(rows.length){
    push(['','']);
    push(['جدول خدمة الدين السنوي (Annual Debt Service)',''],'section');
    push(['السنة','الفائدة','سداد الأصل','خدمة الدين','DSCR'],'header');
    rows.forEach(r=>{
      push([r.yr, Math.round(r.interestExpense), Math.round(r.principalPayment), Math.round(r.debtService), r.debtService>0?(r.noi/r.debtService).toFixed(2)+'×':'—']);
    });
  }
  const ws = xlNewSheet(wb, '07_Debt', B.rows, B.kinds, { colWidths:[42,18,18,18,14] });
  colorize(ws, B.kinds, S);
}

function build0809CashFlows(core, wb, d, c){
  const { fmtSAR, xlRowsBuilder, xlNewSheet, xlSetFormula, xlColLetter } = core;
  // 08_Project CF
  {
    const B = xlRowsBuilder();
    B.push(['التدفقات النقدية للمشروع — Project Cash Flow',''],'title');
    B.push(['السنة','تدفق المشروع (ر.س)'],'header');
    const firstRow = B.rows.length+1;
    c.projectCF.forEach((v,i)=> B.push([i, Math.round(v)]));
    const lastRow = B.rows.length;
    B.push(['','']);
    const rIRR = B.push(['🔒 Project IRR (معادلة IRR على الصفوف أعلاه)', null], 'note');
    const rNPV = B.push(['🔒 NPV @ WACC ('+(c.WACC*100).toFixed(1)+'%)', null], 'note');
    const ws = xlNewSheet(wb, '08_Project CF', B.rows, B.kinds, { colWidths:[46,26] });
    xlSetFormula(ws, rIRR, 2, `IRR(B${firstRow}:B${lastRow})`, '0.0%');
    xlSetFormula(ws, rNPV, 2, `B${firstRow}+NPV(${c.WACC},B${firstRow+1}:B${lastRow})`, '#,##0;(#,##0);"-"');
    return ws;
  }
}

async function build0809CashFlowsWithChart(core, wb, d, c){
  const ws08 = build0809CashFlows(core, wb, d, c);
  const ws09Rows = [];
  // 09_Equity CF
  const { xlRowsBuilder, xlNewSheet, xlSetFormula } = core;
  const B = xlRowsBuilder();
  B.push(['التدفقات النقدية لحقوق الملكية — Equity Cash Flow',''],'title');
  B.push(['السنة','تدفق حقوق الملكية (ر.س)'],'header');
  const firstRow = B.rows.length+1;
  c.equityCF.forEach((v,i)=> B.push([i, Math.round(v)]));
  const lastRow = B.rows.length;
  B.push(['','']);
  const rIRR = B.push(['🔒 Equity IRR (معادلة IRR على الصفوف أعلاه)', null], 'note');
  const rMOIC = B.push(['🔒 MOIC (مجموع التوزيعات الموجبة ÷ |التدفق الأول|)', null], 'note');
  const ws09 = xlNewSheet(wb, '09_Equity CF', B.rows, B.kinds, { colWidths:[46,26] });
  xlSetFormula(ws09, rIRR, 2, `IRR(B${firstRow}:B${lastRow})`, '0.0%');
  xlSetFormula(ws09, rMOIC, 2, `SUMIF(B${firstRow}:B${lastRow},">0")/ABS(B${firstRow})`, '0.00"×"');

  const years = c.equityCF.map((v,i)=>i);
  await addChartImage(wb, ws09, { type:'bar',
    data:{ labels:years, datasets:[
      { label:'Project CF', data:c.projectCF.map(v=>Math.round(v)), backgroundColor:XL_CHART_COLORS.accent },
      { label:'Equity CF', data:c.equityCF.map(v=>Math.round(v)), backgroundColor:XL_CHART_COLORS.gold },
    ] },
    options:Object.assign({}, XL_CHART_BASE, { plugins:{ title:{ display:true, text:'Project vs Equity Cash Flow by Year', color:XL_CHART_COLORS.ink, font:{ size:13, weight:'bold' } }, legend:{ position:'bottom', labels:{ color:XL_CHART_COLORS.ink, font:XL_CHART_FONT } } } })
  }, 520, 280, 0, lastRow+3);
}

/* دقة زمنية شهرية/ربع سنوية + ذروة الاحتياج النقدي الفعلي + صافي النقدي المطلوب من
   المستثمرين النقديين بعد خصم المساهمات العينية —
   مُشتقّة بالكامل من نفس صفوف 08_Project CF / 09_Equity CF أعلاه دون أي تعديل عليها. */
function build0809bCashFlowTiming(core, wb, d, c, oppId){
  const { fmtSAR, xlRowsBuilder, xlNewSheet } = core;
  const a = cashFlowTimingAnalysis(core, d, c, oppId);
  const B = xlRowsBuilder(); const S = [];
  const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
  const periodLabel = (row, unit)=> row.yearIndex===0 ? 'بداية المشروع (Day 0)' : `سنة ${row.yearIndex} — ${unit} ${unit==='شهر'?row.monthInYear:row.quarter}`;

  push(['دقة التدفقات النقدية — Cash Flow Timing Precision (شهري / ربع سنوي)',''],'title');
  push(['مُشتقّة من 08_Project CF / 09_Equity CF السنوية دون أي تعديل عليها — سنوات الإنشاء بمنحنى S واقعي، سنوات التشغيل الوسيطة بتوزيع خطي متساوٍ، وسنة الخروج/البيع كدفعة إغلاق واحدة في شهرها الأخير.','']);
  push(['','']);

  push(['🔴 ذروة الاحتياج النقدي الفعلي (Peak Cash Need)',''],'section');
  push(['المؤشر','القيمة'],'header');
  push(['المبلغ (ر.س)', Math.round(a.peakCashNeed.amount)]);
  push(['متى يحدث', a.peakCashNeed.yearIndex===0? 'بداية المشروع (Day 0)' : `سنة ${a.peakCashNeed.yearIndex} — شهر ${a.peakCashNeed.monthInYear}`]);
  push(['','']);

  push(['صافي النقدي المطلوب فعلياً من المستثمرين النقديين',''],'section');
  push(['المؤشر','القيمة (ر.س)'],'header');
  push(['إجمالي المساهمات العينية المرتبطة (صندوق/صناديق هذه الفرصة)', Math.round(a.totalInKind)]);
  push(['إجمالي المساهمات النقدية المرتبطة (نفس الصندوق/الصناديق)', Math.round(a.totalCash)]);
  push(['= صافي النقدي المطلوب فعلياً (ذروة الاحتياج − إجمالي العيني، بحد أدنى صفر)', Math.round(a.netCashRequiredFromCashInvestors)], 'note');
  if(a.linkedFunds.length===0) push(['⚠️ ملاحظة', 'لا يوجد صندوق مرتبط بهذه الفرصة بعد — الرقم أعلاه يفترض تغطية عينية صفرية.']);
  push(['','']);

  push(['التفصيل الشهري — Monthly Detail (تدفق حقوق الملكية)',''],'section');
  push(['الفترة','التدفق (ر.س)','التراكمي (ر.س)'],'header');
  a.equityMonthly.forEach(mo=> push([periodLabel(mo,'شهر'), Math.round(mo.amount), Math.round(mo.cumulative)]));
  push(['','']);

  push(['التفصيل ربع السنوي — Quarterly Detail (تدفق حقوق الملكية)',''],'section');
  push(['الفترة','التدفق (ر.س)','التراكمي (ر.س)'],'header');
  a.equityQuarterly.forEach(q=> push([periodLabel(q,'ربع'), Math.round(q.amount), Math.round(q.cumulative)]));

  const ws = xlNewSheet(wb, '08b_Cash Flow Timing', B.rows, B.kinds, { colWidths:[46,22,22] });
  colorize(ws, B.kinds, S);
}

function build10Returns(core, wb, d, c){
  const { fmtSAR, fmtPct, xlRowsBuilder, xlNewSheet } = core;
  const B = xlRowsBuilder(); const S = [];
  const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
  push(['العوائد — Returns',''],'title');
  push(['المؤشر','القيمة'],'header');
  push(['🟢 Equity IRR (من 09_Equity CF)', fmtPct(c.equityIRR)], 'data', 'link');
  push(['🟢 Project IRR (من 08_Project CF)', fmtPct(c.projectIRR)], 'data', 'link');
  push(['🟢 MOIC (من 09_Equity CF)', c.MOIC.toFixed(2)+'×'], 'data', 'link');
  push(['DPI', isFinite(c.DPI)?c.DPI.toFixed(2)+'×':'—']);
  push(['RVPI', isFinite(c.RVPI)?c.RVPI.toFixed(2)+'×':'—']);
  push(['TVPI', isFinite(c.TVPI)?c.TVPI.toFixed(2)+'×':'—']);
  push(['NPV (Project @ WACC)', fmtSAR(c.npvProject)]);
  push(['NPV (Equity @ Ke)', fmtSAR(c.npvEquity)]);
  push(['ROI (عائد نقدي على مدى العمر)', fmtPct(c.ROI)]);
  push(['فترة استرداد رأس المال', c.paybackPeriod!=null? c.paybackPeriod.toFixed(1)+' سنة':'لم يُسترد بالكامل']);
  push(['القيمة الصافية التقديرية (NAV)', fmtSAR(c.NAV)]);
  const ws = xlNewSheet(wb, '10_Returns', B.rows, B.kinds, { colWidths:[42,26] });
  colorize(ws, B.kinds, S);
}

async function build11Sensitivity(core, wb, d, c){
  const { fmtPct, xlRowsBuilder, xlNewSheet } = core;
  const B = xlRowsBuilder();
  B.push(['تحليل الحساسية — Sensitivity (Equity IRR)',''],'title');
  B.push(['المتغيّر','سيناريو منخفض','الأساسي','سيناريو مرتفع'],'header');
  const rows = core.sensitivityRows(d);
  rows.forEach(r=>{
    B.push([r.label, fmtPct(r.down,2), fmtPct(r.base,2), fmtPct(r.up,2)]);
  });
  const ws = xlNewSheet(wb, '11_Sensitivity', B.rows, B.kinds, { colWidths:[46,18,18,18], landscape:true });
  const base = rows.length? rows[0].base : c.equityIRR;
  await addChartImage(wb, ws, { type:'bar',
    data:{ labels:rows.map(r=>r.label), datasets:[
      { label:'Downside Δ', data:rows.map(r=>Math.round((r.down-r.base)*1000)/10), backgroundColor:XL_CHART_COLORS.badSoft },
      { label:'Upside Δ', data:rows.map(r=>Math.round((r.up-r.base)*1000)/10), backgroundColor:XL_CHART_COLORS.goodSoft },
    ] },
    options:Object.assign({}, XL_CHART_BASE, { indexAxis:'y', plugins:{ title:{ display:true, text:'Sensitivity — Equity IRR Δ vs Base (pts)', color:XL_CHART_COLORS.ink, font:{ size:13, weight:'bold' } }, legend:{ position:'bottom', labels:{ color:XL_CHART_COLORS.ink, font:XL_CHART_FONT } } } })
  }, 560, 300, 0, rows.length+4);
}

async function build12Scenarios(core, wb, d, c){
  const { fmtSAR, fmtPct, xlRowsBuilder, xlNewSheet } = core;
  const B = xlRowsBuilder();
  B.push(['تحليل السيناريوهات — Scenario Analysis',''],'title');
  B.push(['السيناريو','Equity IRR','MOIC','NPV','الحكم'],'header');
  const scen = core.scenarioCompareRows(d);
  scen.forEach(s=>{
    B.push([s.label.replace(/[🔴🔵🟢]\s*/g,''), fmtPct(s.irr,2), s.moic.toFixed(2)+'×', Math.round(s.npv||0), s.verdict==='good'?'🟢 جيد':s.verdict==='warn'?'🟡 مراجعة':'🔴 دون المعايير']);
  });
  B.push(['','','','','']);
  const rb = core.returnBridgeRows(d);
  B.push(['جسر العائد — Return Bridge (أثر الرافعة والرسوم)','','','',''],'section');
  B.push(['Project IRR (Unlevered)', fmtPct(rb.projectIRR,2)]);
  B.push(['+ أثر الرافعة المالية', fmtPct(rb.leverageEffect,2)]);
  B.push(['= Equity IRR (قبل الرسوم)', fmtPct(rb.equityIRRGrossOfFees,2)]);
  B.push(['− أثر الرسوم', fmtPct(rb.feeDrag,2)]);
  B.push(['= Equity IRR (الصافي)', fmtPct(rb.equityIRRNet,2)]);
  const ws = xlNewSheet(wb, '12_Scenarios', B.rows, B.kinds, { colWidths:[40,16,16,18,16], landscape:true });
  await addChartImage(wb, ws, { type:'bar',
    data:{ labels:scen.map(s=>s.label.replace(/[🔴🔵🟢]\s*/g,'')), datasets:[{ label:'Equity IRR', data:scen.map(s=>Math.round((s.irr||0)*1000)/10),
      backgroundColor:scen.map(s=>s.verdict==='good'?XL_CHART_COLORS.goodSoft:s.verdict==='warn'?XL_CHART_COLORS.warnSoft:XL_CHART_COLORS.badSoft) }] },
    options:Object.assign({}, XL_CHART_BASE, { plugins:{ title:{ display:true, text:'Equity IRR by Scenario (%)', color:XL_CHART_COLORS.ink, font:{ size:13, weight:'bold' } }, legend:{ display:false } },
      scales:{ x:XL_CHART_BASE.scales.x, y:Object.assign({}, XL_CHART_BASE.scales.y, { ticks:{ color:XL_CHART_COLORS.ink, callback:(v)=>v+'%' } }) } })
  }, 480, 260, 0, B.rows.length+2);
}

function build13Comparables(core, wb, d, c){
  const { fmtSAR, fmtPct, fmtNum, xlRowsBuilder, xlNewSheet } = core;
  const B = xlRowsBuilder(); const S = [];
  const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
  push(['مقارنات السوق — Market Comparables',''],'title');
  const comps = (core.STORE[COMPARABLES_COLLECTION] || []).map(r=>r.data).filter(cm=> cm.city && d.meta.city && cm.city.trim()===d.meta.city.trim());
  push(['الحي','النوع','مساحة الأرض','السعر/م²','التاريخ','المصدر'],'header');
  comps.forEach(cm=>{
    push([cm.neighborhood||'—', cm.propertyType||'—', cm.landSize, cm.landSize>0?Math.round(cm.price/cm.landSize):0, cm.date||'', cm.source||'—'], 'data', 'ext');
  });
  if(!comps.length) push(['لا توجد مقارنات مسجَّلة لهذه المدينة','','','','','']);
  push(['','','','','','']);
  const perM2s = comps.filter(cm=>cm.landSize>0).map(cm=>cm.price/cm.landSize);
  const med = median(perM2s);
  push(['الوسيط (سعر/م² أرض)', med!=null?Math.round(med):'—']);
  push(['سعر الفرصة الحالي', Math.round(d.land.price)], 'data', 'link');
  const { rows: benchRows, scope: benchScope } = matchBenchmarks(core, d.meta.city, d.meta.oppType);
  const bench = benchRows.length? aggregateBench(benchRows) : null;
  if(bench){
    push(['','']);
    push(['المعيار المرجعي (Benchmark) — '+(benchScope==='exact'?'مدينة ونوع مطابقان':'نوع فقط'), ''],'section');
    push(['Equity IRR range', bench.irrMin!=null?`${fmtPct(bench.irrMin)} – ${bench.irrMax!=null?fmtPct(bench.irrMax):'—'}`:'—'], 'data', 'ext');
    push(['Cap Rate range', bench.capRateMin!=null?`${fmtPct(bench.capRateMin)} – ${bench.capRateMax!=null?fmtPct(bench.capRateMax):'—'}`:'—'], 'data', 'ext');
  }
  const ws = xlNewSheet(wb, '13_Comparables', B.rows, B.kinds, { colWidths:[26,18,16,16,14,20], landscape:true });
  colorize(ws, B.kinds, S);
}

async function build14RiskRegister(core, wb, d, c){
  const { xlRowsBuilder, xlNewSheet } = core;
  const B = xlRowsBuilder();
  B.push(['سجل المخاطر — Risk Register',''],'title');
  B.push(['الفئة','الاحتمالية','الأثر','الدرجة','التصنيف','إجراء التخفيف','المسؤول'],'header');
  const riskItems = (d.risk && d.risk.items) || defaultRiskItems();
  const chartLabels = [], chartScores = [], chartColors = [];
  RISK_CATEGORIES.forEach(cat=>{
    const it = riskItems[cat.key] || {probability:1,impact:1,mitigation:'',owner:''};
    const score = riskScoreOf(it), bnd = riskBandOf(score);
    B.push([core.T(cat.ar,cat.en), it.probability||1, it.impact||1, score, core.T(bnd.ar,bnd.en), it.mitigation||'—', it.owner||'—']);
    chartLabels.push(core.T(cat.ar,cat.en)); chartScores.push(score); chartColors.push(bnd.color);
  });
  const ws = xlNewSheet(wb, '14_Risk Register', B.rows, B.kinds, { colWidths:[22,12,10,10,14,40,18], landscape:true });
  await addChartImage(wb, ws, { type:'bar',
    data:{ labels:chartLabels, datasets:[{ label:'Risk Score (max 25)', data:chartScores, backgroundColor:chartColors }] },
    options:Object.assign({}, XL_CHART_BASE, { indexAxis:'y', plugins:{ title:{ display:true, text:'Risk Score by Category', color:XL_CHART_COLORS.ink, font:{ size:13, weight:'bold' } }, legend:{ display:false } } })
  }, 520, 300, 0, B.rows.length+2);
}

function build15DD(core, wb, d, c){
  const { fmtPct, xlRowsBuilder, xlNewSheet } = core;
  const B = xlRowsBuilder();
  B.push(['العناية الواجبة — Due Diligence',''],'title');
  const ddItems = (d.dd && d.dd.items) || defaultItemsDict();
  const dd = ddStats(ddItems);
  B.push(['نسبة الإنجاز الإجمالية', fmtPct(dd.pct)]);
  B.push(['بنود حرجة معلّقة', dd.criticalPending]);
  B.push(['', '']);
  B.push(['البند','الفئة','الحالة','المستند','المراجع','الخطورة'],'header');
  Object.entries(ddItems).forEach(([key, it])=>{
    const cat = DD_CATEGORIES.find(c2=>key.startsWith(c2.key));
    B.push([key, cat?core.T(cat.ar,cat.en):'—', it.status||'pending', it.document||'—', it.reviewer||'—', it.severity||'—']);
  });
  xlNewSheet(wb, '15_DD', B.rows, B.kinds, { colWidths:[26,16,14,20,16,12], landscape:true });
}

function build16ICChecklist(core, wb, d, c){
  const { xlRowsBuilder, xlNewSheet } = core;
  const B = xlRowsBuilder();
  B.push(['قائمة تحقق لجنة الاستثمار — IC Checklist',''],'title');
  B.push(['المعيار','القيمة الحالية','الحد الأدنى','الفجوة','الإجراء المقترح'],'header');
  const icRecs = core.icRecommendations(d, c);
  if(icRecs.length){
    icRecs.forEach(r=> B.push([r.k, r.valStr, r.minStr, r.gapStr, r.action]));
  } else {
    B.push(['جميع المعايير مستوفاة','—','—','—','—']);
  }
  xlNewSheet(wb, '16_IC Checklist', B.rows, B.kinds, { colWidths:[24,16,16,16,50], landscape:true });
}

function build17Negotiation(core, wb, d, c){
  const { fmtSAR, xlRowsBuilder, xlNewSheet } = core;
  const B = xlRowsBuilder(); const S = [];
  const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
  push(['التفاوض — Negotiation',''],'title');
  const neg = d.negotiation || { askingPrice:null, targetPrice:null, walkAwayPrice:null, history:[] };
  const targetIRR = d.criteria.irrMin || 0.15;
  const mapRes = maxAcquisitionPrice(core, d, targetIRR);
  push(['البند','القيمة'],'header');
  push(['سعر طلب البائع', neg.askingPrice!=null?Math.round(neg.askingPrice):'—'], 'data', 'input');
  push(['السعر المُدخَل حالياً', Math.round(d.land.price)], 'data', 'link');
  push(['السعر المستهدف', neg.targetPrice!=null?Math.round(neg.targetPrice):'—'], 'data', 'input');
  push(['🔒 الحد الأقصى للاستحواذ', mapRes.infeasible?'—':Math.round(mapRes.maxPrice)]);
  push(['سعر الانسحاب', neg.walkAwayPrice!=null?Math.round(neg.walkAwayPrice):(mapRes.infeasible?'—':Math.round(mapRes.maxPrice))], 'data', 'input');
  if((neg.history||[]).length){
    push(['','']);
    push(['سجل جولات التفاوض','','',''],'section');
    push(['التاريخ','الطرف','السعر','الحالة'],'header');
    neg.history.forEach(h=> push([h.date||'', h.party||'—', Math.round(h.price||0), h.status||'—'], 'data', 'input'));
  }
  const ws = xlNewSheet(wb, '17_Negotiation', B.rows, B.kinds, { colWidths:[32,18,18,18] });
  colorize(ws, B.kinds, S);
}

function build18Waterfall(core, wb, d, c){
  const { fmtSAR, fmtPct, xlRowsBuilder, xlNewSheet } = core;
  const B = xlRowsBuilder();
  B.push(['توزيع العوائد — Distribution Waterfall',''],'title');
  B.push(['البند','القيمة'],'header');
  B.push(['رأس المال المدفوع (PIC)', Math.round(c.PIC||0)]);
  B.push(['العائد المفضّل (Preferred Return)', fmtPct(c.pref||0)]);
  B.push(['Catch-up', fmtPct(c.catchup||0)]);
  B.push(['حصة الشريك المحدود القياسية (LP Standard)', Math.round(c.lpStandard||0)]);
  B.push(['مجمع الفائدة المرحّلة (Carry Pool)', Math.round(c.carryPool||0)]);
  B.push(['علاوة الشريك المحدود (LP Bonus)', Math.round(c.lpBonus||0)]);
  B.push(['🎯 إجمالي حصة الشريك المحدود (LP Total)', Math.round(c.lpTotal||0)]);
  B.push(['🎯 إجمالي حصة الشريك العام (GP Total)', Math.round(c.gpTotal||0)]);
  B.push(['إجمالي حصة المطوّر (Dev Total)', Math.round(c.devTotal||0)]);
  xlNewSheet(wb, '18_Waterfall', B.rows, B.kinds, { colWidths:[42,26] });
}

function build19FundLedger(core, wb, rec, d, c){
  const { fmtSAR, xlRowsBuilder, xlNewSheet } = core;
  const B = xlRowsBuilder();
  B.push(['دفتر الصندوق — Fund Ledger',''],'title');
  const funds = (core.STORE['funds']||[]).filter(f=> (f.data.assetIds||[]).includes(rec.id));
  if(!funds.length){
    B.push(['لا يوجد صندوق مرتبط بهذه الفرصة حالياً','']);
  } else {
    funds.forEach(f=>{
      B.push([f.data.name||f.id, ''],'section');
      const s = core.fundLedgerSummary(f.id);
      B.push(['رأس المال المستهدف (Target Size)', Math.round(f.data.targetSize||0)]);
      B.push(['إجمالي الالتزامات (Committed)', Math.round(s.committed||0)]);
      B.push(['إجمالي النداءات الرأسمالية (Called)', Math.round(s.called||0)]);
      B.push(['إجمالي المدفوع (Paid-in)', Math.round(s.paidIn||0)]);
      B.push(['إجمالي التوزيعات المسدَّدة (Distributed)', Math.round(s.distPaid||0)]);
      B.push(['DPI', s.dpi!=null? s.dpi.toFixed(2)+'×' : '—']);
      B.push(['إجمالي حقوق ملكية الصندوق في الأصول (Total Equity)', Math.round(s.totalEquity||0)]);
      B.push(['إجمالي القيمة الحالية للأصول (Total Value)', Math.round(s.totalValue||0)]);
    });
  }
  xlNewSheet(wb, '19_Fund Ledger', B.rows, B.kinds, { colWidths:[42,26] });
}

function build20AuditTrail(core, wb, rec){
  const { xlRowsBuilder, xlNewSheet } = core;
  const B = xlRowsBuilder();
  B.push(['سجل التغييرات — Audit Trail',''],'title');
  B.push(['التاريخ','الإجراء','بواسطة','الحقل','القيمة السابقة','القيمة الجديدة'],'header');
  const entries = (core.STORE['oppAuditLog']||[]).filter(a=>a.data.oppId===rec.id).sort((a,b)=>(b.data.changedAt||'').localeCompare(a.data.changedAt||''));
  if(!entries.length){
    B.push(['لا توجد تغييرات مسجَّلة بعد','','','','','']);
  } else {
    entries.forEach(a=>{
      const changes = (a.data.changes && a.data.changes.length) ? a.data.changes : [{label:'—',before:'—',after:'—'}];
      changes.slice(0,20).forEach((ch,i)=>{
        B.push([i===0?(a.data.changedAt||''):'', i===0?(a.data.action||''):'', i===0?(a.data.changedBy||''):'', ch.label||ch.field||'', String(ch.before==null?'—':ch.before), String(ch.after==null?'—':ch.after)]);
      });
    });
  }
  xlNewSheet(wb, '20_Audit Trail', B.rows, B.kinds, { colWidths:[18,12,20,26,20,20], landscape:true });
}
