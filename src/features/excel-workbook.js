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

/* المسار "القياسي" للحساب — الحالة التي بُنيت لها معادلات Excel حقيقية مترابطة عبر أوراق ٠٢-١٠
   (تمويل بتمويل بنكي واحد وفوائد فقط بلا جدول سحب، بلا ضريبة قيمة مضافة، بلا بيع على مراحل/خارطة،
   بلا إعادة تمويل عند الخروج، بلا نسبة بيع+إيجار مختلطة لفرص الدخل). أي فرصة تخرج عن هذا المسار
   (ميزات متقدمة مفعَّلة) تحتفظ بنفس الأرقام الدقيقة 🔒 المحسوبة من محرك compute() كما كانت دائماً —
   لا فرق في الدقة، فقط في كون الرقم معادلة قابلة للتتبع خلية بخلية أو نتيجة محرك موثَّقة بوضوح. */
function isStandardCalcPath(d, c){
  if(d.vat && d.vat.enabled) return false;
  if((d.financing.structure||'single')!=='single') return false;
  if((d.financing.amortType||'interest_only')!=='interest_only') return false;
  if(c.drawSchedule) return false;
  if((d.financing.interestDuringConstruction||'cash')!=='cash') return false;
  if(c.isPhasedSaleMode || c.isOffPlanSale) return false;
  if(c.holdStrategy!=='exit_sale') return false;
  if(c.applySalePctToIncome) return false;
  if(d.strategy && d.strategy.directSale && (d.strategy.directSale.bankFinancedPct||0)>0) return false;
  if(d.meta.oppType==='income' && d.income.gla) return false;
  // فئات الأصول المتخصصة (فندقي/محطات وقود/صيدليات-مطاعم) لها اشتقاق NOI مختلف كلياً عن معادلة
  // PGI×الإشغال×(1-OPEX) القياسية المبنية في 05_Revenue — تبقى 🔒 محسوبة بدل معادلة مترابطة خاطئة.
  if(d.meta.oppType==='income' && (d.income.assetClass||'عام')!=='عام') return false;
  // بيع أرض مخدومة فقط (بلا مبنى) — noiForYear() يُرجع صفراً بينما معادلة 05_Revenue القياسية
  // ستحتسب إيجاراً وهمياً على GFA غير موجود فعلياً، وقيمة الخروج تُحسَب بمنطق مختلف (سعر البيع×مساحة الأرض).
  if(d.meta.oppType==='development' && d.development && d.development.scopeType==='infra_only') return false;
  // رسوم اختيارية إضافية (منصة إيجار / تأمين الأصل) تُخصَم داخل noiForYear() لكنها غير مُدرَجة في
  // معادلة NOI المبسّطة في 05_Revenue — تبقى الفرصة 🔒 محسوبة لو فُعِّلت أي منهما.
  if((d.fees.ejarFeePct||0)>0) return false;
  if((d.fees.insuranceAnnualPct||0)>0) return false;
  return true;
}

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

    /* ===================== حالة المسار القياسي (يقرِّر أي الأوراق التالية تُبنى بمعادلات مترابطة كاملة) ===================== */
    const standardPath = isStandardCalcPath(d, c);
    const ref = (sheet, row, col)=> `'${sheet}'!${xlColLetter(col||2)}${row}`;

    /* ===================== 02_Assumptions ===================== */
    const A = {}; // خريطة أرقام صفوف كل مُدخل — تُستخدم من كل الأوراق التالية للربط الحقيقي بينها
    {
      const B = xlRowsBuilder(); const S = [];
      const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
      push(['جميع الافتراضات — All Assumptions',''],'title');
      if(!standardPath) push(['⚠️ هذه الفرصة تستخدم ميزة متقدمة واحدة أو أكثر (ضريبة قيمة مضافة/بيع على مراحل أو الخارطة/إعادة تمويل عند الخروج/مديونية مركّبة...) — أوراق ٠٧-١٠ تبقى أرقاماً محسوبة 🔒 موثَّقة من محرك التطبيق بدل معادلات مترابطة خلية بخلية لهذه الفرصة تحديداً (دقتها كاملة 100% مثل أي فرصة أخرى).','']);
      push(['الأرض (Land)',''],'section');
      push(['المتغيّر','القيمة'],'header');
      A.landArea = push(['مساحة الأرض (Land Area) م²', d.land.area], 'data', 'input');
      A.landPrice = push(['سعر متر الأرض (Land Price/m²)', d.land.price], 'data', 'input');
      A.landFar = push(['معامل البناء (FAR)', d.land.far], 'data', 'input');
      A.landBar = push(['نسبة البصمة/الأرض (BAR)', d.land.bar], 'data', 'input');
      A.landBasements = push(['عدد البدرومات (Basements)', d.land.basements||0], 'data', 'input');
      A.landFloorHeight = push(['ارتفاع الدور (Floor Height) م', d.land.floorHeight||3.6], 'data', 'input');
      A.floorHeightPremiumPct = push(['علاوة تكلفة ارتفاع الدور الزائد', d.land.floorHeightPremiumPct??0.04], 'data', 'input');
      A.basementCostPremiumPct = push(['علاوة تكلفة البدروم الأساسية', d.land.basementCostPremiumPct??0.30], 'data', 'input');
      A.basementDepthEscalationPct = push(['تصاعد علاوة العمق لكل بدروم إضافي', d.land.basementDepthEscalationPct??0.07], 'data', 'input');
      push(['معاملات التصنيف الداخلية (Classification Multipliers)',''],'section');
      push(['المتغيّر','القيمة'],'header');
      A.tierMult = push(['معامل الفئة (Tier Multiplier) — '+d.meta.tier, c.tierMult], 'data', 'ext');
      A.useMult = push(['معامل نوع الاستخدام (Use-Type Multiplier) — '+(d.meta.useType||'—'), c.useInfo.mult], 'data', 'ext');
      A.siteFactor = push(['معامل عوامل الموقع مجتمعة (Site Factors Combined)', c.siteFactor], 'data', 'ext');
      push(['التمويل (Financing)',''],'section');
      push(['المتغيّر','القيمة'],'header');
      A.saibor = push(['SAIBOR', d.financing.saibor], 'data', 'input');
      A.margin = push(['هامش البنك (Margin)', d.financing.margin], 'data', 'input');
      A.ltc = push(['نسبة التمويل (LTC)', d.financing.ltc], 'data', 'input');
      push(['تكلفة رأس المال المرجّح WACC (نموذج CAPM)',''],'section');
      push(['المتغيّر','القيمة'],'header');
      A.rf = push(['العائد الخالي من المخاطر (Rf)', d.wacc.rf], 'data', 'input');
      A.beta = push(['بيتا (Beta)', d.wacc.beta], 'data', 'input');
      A.mrp = push(['علاوة مخاطر السوق (MRP)', d.wacc.mrp], 'data', 'input');
      A.crp = push(['علاوة مخاطر الدولة (CRP)', d.wacc.crp], 'data', 'input');
      A.sp = push(['علاوة الحجم (Size Premium)', d.wacc.sp], 'data', 'input');
      A.alpha = push(['ألفا خاصة بالمشروع', d.wacc.alpha], 'data', 'input');
      A.marketCap = push(['معدل الرسملة السوقي (Market Cap Rate)', d.wacc.marketCap], 'data', 'input');
      A.growth = push(['معدل النمو طويل الأمد (Growth)', d.wacc.growth], 'data', 'input');
      push(['الرسوم (Fees)',''],'section');
      push(['المتغيّر','القيمة'],'header');
      A.feeMgmt = push(['رسوم إدارة الصندوق السنوية (% من متوسط Equity+Debt)', d.fees.mgmt], 'data', 'input');
      A.feeStructuring = push(['رسوم الهيكلة (% من الأرض+التكلفة الإنشائية)', d.fees.structuring], 'data', 'input');
      A.feeArrangement = push(['رسوم ترتيب التمويل (% من الدين)', d.fees.arrangement], 'data', 'input');
      A.feeAcquisition = push(['رسوم الاستحواذ (% من تكلفة الأرض)', d.fees.acquisition], 'data', 'input');
      A.feeDisposition = push(['رسوم التصرّف عند الخروج', d.fees.disposition], 'data', 'input');
      A.feeAssetMgmt = push(['رسوم إدارة الأصول السنوية (% من TPC)', d.fees.assetMgmt], 'data', 'input');
      A.feePropMgmt = push(['رسوم إدارة الملكية (% من صافي الدخل بعد OPEX)', d.fees.propMgmt], 'data', 'input');
      A.feeRegAuditCustodian = push(['رسوم تنظيمية/تدقيق/أمين حفظ سنوية', d.fees.regAuditCustodian], 'data', 'input');
      A.feeCmaSetup = push(['رسوم تأسيس (هيئة السوق المالية)', d.fees.cmaSetup], 'data', 'input');
      A.feeDueDiligence = push(['تكلفة العناية الواجبة', d.fees.dueDiligence], 'data', 'input');
      A.feeValuation = push(['تكلفة التقييم', d.fees.valuation], 'data', 'input');
      push(['تكاليف الخروج (Exit Costs)',''],'section');
      push(['المتغيّر','القيمة'],'header');
      A.exitBroker = push(['عمولة الوساطة', d.exitCosts.broker], 'data', 'input');
      A.exitLegal = push(['التكاليف القانونية', d.exitCosts.legal], 'data', 'input');
      A.exitRett = push(['رسوم نقل الملكية (RETT)', d.exitCosts.rett], 'data', 'input');
      A.exitFeeOther = push(['رسوم أخرى عند الخروج', d.exitCosts.exitFee], 'data', 'input');
      push(['الاشتراك (Subscription)',''],'section');
      push(['المتغيّر','القيمة'],'header');
      A.subscriptionFee = push(['رسوم الاشتراك (% من حقوق الملكية)', d.subscription.subscriptionFee], 'data', 'input');
      push(['معايير القبول (Acceptance Criteria)',''],'section');
      push(['المتغيّر','القيمة'],'header');
      A.irrMin = push(['الحد الأدنى لـEquity IRR', d.criteria.irrMin], 'data', 'input');
      A.dscrMin = push(['الحد الأدنى لـDSCR', (d.criteria.dscrMin||0).toFixed(2)+'×'], 'data', 'input');
      A.moicMin = push(['الحد الأدنى لـMOIC', (d.criteria.moicMin||0).toFixed(2)+'×'], 'data', 'input');
      if(d.meta.oppType==='development' || d.meta.oppType==='income'){
        push(['مدخلات البناء (Building Inputs)',''],'section');
        push(['المتغيّر','القيمة'],'header');
        A.buildCost = push(['تكلفة البناء/م²', d.development.buildCost], 'data', 'input');
        A.constructionYears = push(['مدة الإنشاء (سنوات)', d.development.constructionYears], 'data', 'input');
        A.operationYears = push(['مدة التشغيل بعد الإنشاء (سنوات)', d.development.operationYears||0], 'data', 'input');
        A.exitCapRate = push(['معدل الرسملة عند الخروج', d.development.exitCapRate], 'data', 'input');
        A.efficiency = push(['الكفاءة (Efficiency)', d.development.efficiency], 'data', 'input');
        A.contingency = push(['احتياطي الطوارئ', d.development.contingency], 'data', 'input');
        push(['توزيع تكلفة البناء (Cost Breakdown %)',''],'section');
        push(['المتغيّر','القيمة'],'header');
        const cb = d.development.costBreakdown||{structure:0.42,mep:0.18,finishes:0.20,external:0.08,fees:0.12};
        A.cbStructure = push(['الهيكل الإنشائي (Structure)', cb.structure], 'data', 'input');
        A.cbMep = push(['الأعمال الكهروميكانيكية (MEP)', cb.mep], 'data', 'input');
        A.cbFinishes = push(['التشطيبات (Finishes)', cb.finishes], 'data', 'input');
        A.cbExternal = push(['الأعمال الخارجية (External)', cb.external], 'data', 'input');
        A.cbFees = push(['أتعاب استشارية/إشراف (Fees)', cb.fees], 'data', 'input');
      }
      if(d.meta.oppType==='development'){
        push(['الإيرادات — بيع (Development Sale)',''],'section');
        push(['المتغيّر','القيمة'],'header');
        A.salePrice = push(['سعر البيع المتوقع/م²', d.development.salePrice], 'data', 'input');
        A.salePct = push(['نسبة البيع من الاستراتيجية', d.strategy&&d.strategy.salePct!=null? d.strategy.salePct : 1], 'data', 'input');
        // الجزء المُبقى (1-نسبة البيع) — لو أقل من 100% — يُؤجَّر خلال مدة التشغيل ويُقيَّم بالرسملة عند
        // الخروج، فتلزم نفس مدخلات الإيجار المستخدَمة لفرص الدخل، ولو لم تكن معروضة صراحة من قبل.
        push(['— إيجار الجزء المُبقى (إن كانت نسبة البيع أقل من ١٠٠٪)',''],'section');
        push(['المتغيّر','القيمة'],'header');
        A.rent = push(['الإيجار السنوي/م² (للجزء المُبقى)', d.income.rent], 'data', 'input');
        A.occupancy = push(['نسبة الإشغال (للجزء المُبقى)', d.income.occupancy], 'data', 'input');
        A.opex = push(['نسبة OPEX (للجزء المُبقى)', d.income.opex], 'data', 'input');
      } else if(d.meta.oppType==='income'){
        push(['الإيرادات — إيجار (Income Rental)',''],'section');
        push(['المتغيّر','القيمة'],'header');
        A.rent = push(['الإيجار السنوي/م²', d.income.rent], 'data', 'input');
        A.occupancy = push(['نسبة الإشغال', d.income.occupancy], 'data', 'input');
        A.opex = push(['نسبة OPEX', d.income.opex], 'data', 'input');
      } else {
        push(['بنك الأراضي (Land Bank)',''],'section');
        push(['المتغيّر','القيمة'],'header');
        A.appreciation = push(['معدل النمو السنوي', d.landbank.appreciation||0], 'data', 'input');
        A.carryAnnual = push(['تكلفة الحمل السنوية', d.landbank.carryAnnual||0], 'data', 'input');
        A.holdingYears = push(['مدة الاحتفاظ (سنوات)', d.landbank.holdingYears||0], 'data', 'input');
        A.whiteLandFeePct = push(['رسم الأرض البيضاء (نسبة)', d.landbank.whiteLandFeeExempt? 0 : (d.landbank.whiteLandFeePct||0)], 'data', 'input');
        A.interimAnnualIncome = push(['دخل مرحلي سنوي (إن وُجد)', d.landbank.interimAnnualIncome||0], 'data', 'input');
      }
      xlNewSheet(wb, '02_Assumptions', B.rows, B.kinds, { colWidths:[42,26] });
      colorize(wsLast(wb), B.kinds, S);
      /* الخلايا أعلاه أصبحت الآن أرقاماً عشرية خامة (بعد إزالة أغلفة fmtPct النصية) حتى يصح
         استخدامها داخل معادلات Excel حسابية حقيقية في بقية الأوراق — لكن هذا يفقدها تنسيق
         العرض كنسبة مئوية (ستظهر "0.055" بدل "5.5%"). نطبّق هنا صراحة numFmt='0.0%' على كل
         خلية تمثّل فعلياً نسبة مئوية (حسب تعريفها في core.js عبر F.pct)، مع استثناء A.beta
         (معامل بيتا خام وليس نسبة) وكل الحقول النقدية/العددية الأخرى (مساحات، مبالغ ر.س،
         سنوات، معاملات FAR/×...). */
      const wsAssump = wsLast(wb);
      const pctRows = [
        A.landBar, A.floorHeightPremiumPct, A.basementCostPremiumPct, A.basementDepthEscalationPct,
        A.saibor, A.margin, A.ltc,
        A.rf, A.mrp, A.crp, A.sp, A.alpha, A.marketCap, A.growth,
        A.feeMgmt, A.feeStructuring, A.feeArrangement, A.feeAcquisition, A.feeDisposition, A.feeAssetMgmt, A.feePropMgmt,
        A.exitBroker, A.exitLegal, A.exitRett, A.exitFeeOther,
        A.subscriptionFee, A.irrMin,
        A.exitCapRate, A.efficiency, A.contingency,
        A.cbStructure, A.cbMep, A.cbFinishes, A.cbExternal, A.cbFees,
        A.salePct, A.occupancy, A.opex,
        A.appreciation, A.whiteLandFeePct,
      ];
      pctRows.forEach(rn=>{ if(rn){ wsAssump.getCell(rn, 2).numFmt = '0.0%'; } });
    }

    /* ===================== 03_Sources & Uses ===================== */
    const U = {};
    {
      const AS = '02_Assumptions';
      const B = xlRowsBuilder(); const S = [];
      const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
      push(['مصادر واستخدامات الأموال — Sources & Uses',''],'title');
      push(['الاستخدامات (Uses)',''],'section');
      push(['البند','القيمة (ر.س)'],'header');
      U.land = push(['تكلفة الأرض (Land Cost)', null], 'data', 'link');
      U.hard = push(['التكلفة الإنشائية (Hard Cost)', null], 'data', 'link');
      U.fixed = push(['تكاليف ثابتة (One-time Fixed)', null], 'data', 'link');
      U.struct = push(['رسوم الهيكلة (Structuring Fee)', null], 'data', 'link');
      U.acq = push(['رسوم الاستحواذ (Acquisition Fee)', null], 'data', 'link');
      U.arr = push(['رسوم الترتيب (Arrangement Fee)', null], 'data', 'link');
      if(c.vatInputTotal>0){ U.vat = push(['🔒 ضريبة القيمة المضافة على مدخلات الإنشاء (غير قابلة للمعادلة لهذه الفرصة)', Math.round(c.vatInputTotal)]); }
      U.tpc = push(['إجمالي تكلفة المشروع (TPC)', null]);
      push(['المصادر (Sources)',''],'section');
      push(['البند','القيمة (ر.س)'],'header');
      U.debt = push(['الدين (Debt)', null]);
      U.equity = push(['حقوق الملكية (Equity)', null]);
      U.total = push(['الإجمالي (Total)', null]);
      const ws = xlNewSheet(wb, '03_Sources & Uses', B.rows, B.kinds, { colWidths:[40,22] });
      colorize(ws, B.kinds, S);
      // تكلفة الأرض = مساحة الأرض × سعر المتر (رابط حقيقي لورقة الافتراضات)
      xlSetFormula(ws, U.land, 2, `${ref(AS,A.landArea)}*${ref(AS,A.landPrice)}`, '#,##0;(#,##0);"-"');
      if(d.meta.oppType==='landbank'){
        xlSetFormula(ws, U.hard, 2, `0`, '#,##0;(#,##0);"-"');
      } else {
        // GFA = مساحة الأرض × FAR — بصمة المبنى = مساحة الأرض × BAR — عدد الأدوار = تقريب لأعلى(GFA/البصمة)
        // التكلفة الإنشائية الرأسية = GFA × تكلفة البناء/م² × معامل الفئة × معامل الاستخدام × معامل الموقع × علاوة ارتفاع الدور
        const gfaF = `${ref(AS,A.landArea)}*${ref(AS,A.landFar)}`;
        const footprintF = `${ref(AS,A.landArea)}*${ref(AS,A.landBar)}`;
        const heightPremF = `(1+MAX(0,${ref(AS,A.landFloorHeight)}-3.6)*${ref(AS,A.floorHeightPremiumPct)})`;
        // ملاحظة دقيقة: معامل الفئة (tierMult) إعلامي فقط في محرك compute() — لا يدخل فعلياً في حساب
        // التكلفة الإنشائية (راجع verticalCost/basementCostFor في core.js: كلاهما يستخدمان معامل الاستخدام
        // والموقع فقط). لذا معامل التكلفة الفعلي هنا يستثني tierMult عمداً حتى يطابق محرك التطبيق تماماً —
        // معامل الفئة المعروض في ورقة الافتراضات (٠٢) يبقى رقماً إعلامياً مرجعياً لا أكثر.
        const costMultF = `${ref(AS,A.useMult)}*${ref(AS,A.siteFactor)}`;
        const verticalCostF = `(${gfaF})*${ref(AS,A.buildCost)}*${costMultF}*${heightPremF}`;
        // تكلفة البدرومات: مجموع تكلفة كل مستوى (البصمة × تكلفة البناء × المعاملات × علاوة المستوى المتصاعدة)
        const basementLevels = Math.max(0, Math.round(d.land.basements||0));
        let basementCostF = '0';
        if(basementLevels>0){
          const terms = [];
          for(let lvl=1; lvl<=basementLevels; lvl++){
            const lvlPremF = lvl===1 ? `(1+${ref(AS,A.basementCostPremiumPct)})` : `(1+${ref(AS,A.basementCostPremiumPct)}+${lvl-1}*${ref(AS,A.basementDepthEscalationPct)})`;
            terms.push(`(${footprintF})*${ref(AS,A.buildCost)}*${costMultF}*${heightPremF}*${lvlPremF}`);
          }
          basementCostF = terms.join('+');
        }
        const infraCostF = (d.development.scopeType!=='vertical_only' && (d.development.infraCostPerSqm||0)>0)
          ? `${ref(AS,A.landArea)}*${d.development.infraCostPerSqm}` : '0';
        const hardCostBaseF = `(${verticalCostF})+(${basementCostF})+(${infraCostF})`;
        xlSetFormula(ws, U.hard, 2, `(${hardCostBaseF})*(1+${ref(AS,A.contingency)})`, '#,##0;(#,##0);"-"');
      }
      xlSetFormula(ws, U.fixed, 2, `${ref(AS,A.feeCmaSetup)}+${ref(AS,A.feeDueDiligence)}+${ref(AS,A.feeValuation)}`, '#,##0;(#,##0);"-"');
      xlSetFormula(ws, U.struct, 2, `${ref(AS,A.feeStructuring)}*(B${U.land}+B${U.hard})`, '#,##0;(#,##0);"-"');
      xlSetFormula(ws, U.acq, 2, `${ref(AS,A.feeAcquisition)}*B${U.land}`, '#,##0;(#,##0);"-"');
      const preTpcRange = U.vat ? `B${U.land}:B${U.struct}` : `B${U.land}:B${U.struct}`; // (VAT إن وُجد يُضاف لاحقاً صراحة، لا يدخل ضمن preTPC)
      xlSetFormula(ws, U.arr, 2, `${ref(AS,A.ltc)}*SUM(${preTpcRange},B${U.acq})*${ref(AS,A.feeArrangement)}`, '#,##0;(#,##0);"-"');
      const tpcRange = U.vat ? `B${U.land}:B${U.vat}` : `B${U.land}:B${U.arr}`;
      xlSetFormula(ws, U.tpc, 2, `SUM(${tpcRange})`, '#,##0;(#,##0);"-"');
      // الدين = LTC × preTPC (الأرض+الإنشاء+الثابتة+الهيكلة+الاستحواذ فقط — بدون رسوم الترتيب، لأنها نفسها % من الدين)
      xlSetFormula(ws, U.debt, 2, `${ref(AS,A.ltc)}*SUM(${preTpcRange},B${U.acq})`, '#,##0;(#,##0);"-"');
      xlSetFormula(ws, U.equity, 2, `B${U.tpc}-B${U.debt}`, '#,##0;(#,##0);"-"');
      xlSetFormula(ws, U.total, 2, `B${U.debt}+B${U.equity}`, '#,##0;(#,##0);"-"');
    }

    /* ===================== 04_Development ===================== */
    const D04 = build04Development(core, wb, d, c, A, U, standardPath);

    /* ===================== 05_Revenue ===================== */
    const R05 = build05Revenue(core, wb, d, c, A, U, D04, standardPath);

    /* ===================== 06_OPEX ===================== */
    const O06 = build06Opex(core, wb, d, c, A, U, R05, standardPath);

    /* ===================== 07_Debt ===================== */
    const DB07 = build07Debt(core, wb, d, c, A, U, R05, standardPath);

    /* ===================== 08_Project CF / 09_Equity CF ===================== */
    const CF0809 = await build0809CashFlowsWithChart(core, wb, d, c, A, U, R05, O06, DB07, standardPath);

    /* ===================== 08b_Cash Flow Timing (شهري/ربع سنوي + ذروة الاحتياج) ===================== */
    build0809bCashFlowTiming(core, wb, d, c, rec.id);

    /* ===================== 10_Returns ===================== */
    build10Returns(core, wb, d, c, CF0809);

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

function build04Development(core, wb, d, c, A, U, standardPath){
  const { xlRowsBuilder, xlNewSheet, xlSetFormula, xlColLetter } = core;
  const AS = '02_Assumptions';
  const ref = (row,col)=> `'${AS}'!${xlColLetter(col||2)}${row}`;
  const B = xlRowsBuilder(); const S = [];
  const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
  push(['برنامج التطوير — Development Program',''],'title');
  const D = {};
  if(d.meta.oppType==='landbank'){
    push(['البند','القيمة'],'header');
    push(['— لا ينطبق (الفرصة ليست من نوع تطوير/دخل)', 'N/A — not a Development/Income opportunity']);
    const ws = xlNewSheet(wb, '04_Development', B.rows, B.kinds, { colWidths:[42,26] });
    colorize(ws, B.kinds, S);
    return D;
  }
  push(['البند','القيمة'],'header');
  D.gfa = push(['🟢 المساحة الإجمالية القابلة للتأجير/البيع (GFA = مساحة الأرض × FAR) م²', null], 'data', 'link');
  D.footprint = push(['🟢 بصمة المبنى (Footprint = مساحة الأرض × BAR) م²', null], 'data', 'link');
  D.floors = push(['🟢 عدد الأدوار المطلوب (تقريب لأعلى GFA/البصمة)', null], 'data', 'link');
  D.heightPrem = push(['🟢 معامل علاوة ارتفاع الدور', null], 'data', 'link');
  D.masterMult = push(['🟢 المعامل المجمّع إعلامي (فئة × استخدام × موقع) — لا يدخل في حساب التكلفة', null], 'data', 'link');
  D.costMult = push(['🟢 معامل التكلفة الفعلي (استخدام × موقع فقط — معامل الفئة إعلامي في محرك التطبيق)', null], 'data', 'link');
  push(['','']);
  push(['توزيع التكلفة الإنشائية الرأسية (Vertical Cost Breakdown)',''],'section');
  push(['البند','القيمة (ر.س)'],'header');
  D.vertical = push(['🟢 التكلفة الإنشائية الرأسية (Vertical Cost) — قبل الطوارئ', null], 'data', 'link');
  D.structure = push(['— منها: الهيكل الإنشائي (Structure)', null], 'data', 'link');
  D.mep = push(['— منها: الأعمال الكهروميكانيكية (MEP)', null], 'data', 'link');
  D.finishes = push(['— منها: التشطيبات (Finishes)', null], 'data', 'link');
  D.external = push(['— منها: الأعمال الخارجية (External)', null], 'data', 'link');
  D.fees = push(['— منها: أتعاب استشارية/إشراف (Fees)', null], 'data', 'link');
  D.basement = push(['🟢 تكلفة البدرومات (Basement Cost)', null], 'data', 'link');
  D.infra = push(['🟢 تكلفة البنية التحتية (Infrastructure Cost)', null], 'data', 'link');
  D.hardBase = push(['🟢 التكلفة الإنشائية الأساسية (قبل الطوارئ)', null], 'data', 'link');
  D.contingencyAmt = push(['🟢 احتياطي الطوارئ (مبلغ)', null], 'data', 'link');
  D.hard = push(['🟢 التكلفة الإنشائية الكلية (Hard Cost)', null], 'data', 'link');

  const ws = xlNewSheet(wb, '04_Development', B.rows, B.kinds, { colWidths:[46,26] });
  colorize(ws, B.kinds, S);

  const gfaF = `${ref(A.landArea)}*${ref(A.landFar)}`;
  const footprintF = `${ref(A.landArea)}*${ref(A.landBar)}`;
  const heightPremF = `1+MAX(0,${ref(A.landFloorHeight)}-3.6)*${ref(A.floorHeightPremiumPct)}`;
  const masterMultF = `${ref(A.tierMult)}*${ref(A.useMult)}*${ref(A.siteFactor)}`;
  // معامل التكلفة الفعلي المستخدَم في كل معادلات التكلفة الإنشائية أدناه — يستثني معامل الفئة (tierMult)
  // عمداً: محرك compute() في core.js لا يُدخل tierMult في حساب verticalCost/basementCostFor إطلاقاً (معامل
  // الفئة إعلامي بحت هناك أيضاً)، فيبقى هذا التمييز مطابقاً تماماً لسلوك التطبيق الفعلي.
  const costMultF = `${ref(A.useMult)}*${ref(A.siteFactor)}`;
  xlSetFormula(ws, D.gfa, 2, gfaF, '#,##0');
  xlSetFormula(ws, D.footprint, 2, footprintF, '#,##0');
  xlSetFormula(ws, D.floors, 2, `ROUNDUP(B${D.gfa}/B${D.footprint},0)`, '0');
  xlSetFormula(ws, D.heightPrem, 2, heightPremF, '0.000');
  xlSetFormula(ws, D.masterMult, 2, masterMultF, '0.000');
  xlSetFormula(ws, D.costMult, 2, costMultF, '0.000');

  const scopeType = d.development.scopeType||'both';
  const verticalF = scopeType==='infra_only' ? '0' : `B${D.gfa}*${ref(A.buildCost)}*B${D.costMult}*B${D.heightPrem}`;
  xlSetFormula(ws, D.vertical, 2, verticalF, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, D.structure, 2, `B${D.vertical}*${ref(A.cbStructure)}`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, D.mep, 2, `B${D.vertical}*${ref(A.cbMep)}`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, D.finishes, 2, `B${D.vertical}*${ref(A.cbFinishes)}`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, D.external, 2, `B${D.vertical}*${ref(A.cbExternal)}`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, D.fees, 2, `B${D.vertical}*${ref(A.cbFees)}`, '#,##0;(#,##0);"-"');

  const basementLevels = Math.max(0, Math.round(d.land.basements||0));
  let basementF = '0';
  if(scopeType!=='infra_only' && basementLevels>0){
    const terms = [];
    for(let lvl=1; lvl<=basementLevels; lvl++){
      const lvlPremF = lvl===1 ? `(1+${ref(A.basementCostPremiumPct)})` : `(1+${ref(A.basementCostPremiumPct)}+${lvl-1}*${ref(A.basementDepthEscalationPct)})`;
      terms.push(`B${D.footprint}*${ref(A.buildCost)}*B${D.costMult}*B${D.heightPrem}*${lvlPremF}`);
    }
    basementF = terms.join('+');
  }
  xlSetFormula(ws, D.basement, 2, basementF, '#,##0;(#,##0);"-"');
  const infraF = (scopeType!=='vertical_only' && (d.development.infraCostPerSqm||0)>0) ? `${ref(A.landArea)}*${d.development.infraCostPerSqm}` : '0';
  xlSetFormula(ws, D.infra, 2, infraF, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, D.hardBase, 2, `B${D.vertical}+B${D.basement}+B${D.infra}`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, D.contingencyAmt, 2, `B${D.hardBase}*${ref(A.contingency)}`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, D.hard, 2, `B${D.hardBase}+B${D.contingencyAmt}`, '#,##0;(#,##0);"-"');
  return D;
}

function build05Revenue(core, wb, d, c, A, U, D04, standardPath){
  const { fmtSAR, fmtPct, xlRowsBuilder, xlNewSheet, xlSetFormula, xlColLetter } = core;
  const AS = '02_Assumptions';
  const ref = (row,col)=> `'${AS}'!${xlColLetter(col||2)}${row}`;
  const B = xlRowsBuilder(); const S = [];
  const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
  push(['الإيرادات — Revenue',''],'title');
  push(['البند','القيمة'],'header');
  const R = {};
  if(d.meta.oppType==='landbank'){
    push(['معدل نمو قيمة الأرض السنوي', d.landbank? fmtPct(d.landbank.appreciation):'—'], 'data', 'input');
    push(['دخل مرحلي (إن وُجد)', d.landbank&&d.landbank.interimAnnualIncome? fmtSAR(d.landbank.interimAnnualIncome):'—'], 'data', 'input');
    const ws = xlNewSheet(wb, '05_Revenue', B.rows, B.kinds, { colWidths:[42,26] });
    colorize(ws, B.kinds, S);
    return R;
  }
  if(d.meta.oppType==='income'){
    push(['متوسط العمر المتبقي للعقود (WALE)', d.income.wale!=null? d.income.wale+' سنة':'—'], 'data', 'input');
    push(['تركّز أكبر مستأجر', d.income.tenantConc!=null? fmtPct(d.income.tenantConc):'—'], 'data', 'input');
  } else {
    push(['سعر البيع المتوقع/م² (من ورقة 02)', fmtSAR(d.development.salePrice)], 'data', 'link');
    push(['نسبة البيع من الاستراتيجية', d.strategy&&d.strategy.salePct!=null? fmtPct(d.strategy.salePct):'—'], 'data', 'input');
  }
  push(['','']);
  push([d.meta.oppType==='income' ? 'اشتقاق صافي الدخل التشغيلي السنوي (خلال التشغيل)' : 'اشتقاق صافي الدخل التشغيلي للجزء المُبقى مؤجَّراً (خلال التشغيل)', ''],'section');
  push(['البند','القيمة'],'header');
  R.gla = push(['🟢 المساحة القابلة للتأجير (GLA = GFA × الكفاءة)', null], 'data', 'link');
  const effOccLabel = d.meta.oppType==='income' ? 'نسبة الإشغال الفعلية' : 'نسبة الإشغال الفعلية (× (1-نسبة البيع))';
  R.effOcc = push(['🟢 '+effOccLabel, null], 'data', 'link');
  R.pgi = push(['🟢 الإيراد الإجمالي المحتمل (PGI = GLA × الإيجار)', null], 'data', 'link');
  R.egi = push(['🟢 الإيراد الإجمالي الفعلي (EGI = PGI × الإشغال الفعلية)', null], 'data', 'link');
  R.opexAmt = push(['🟢 المصاريف التشغيلية (OPEX = EGI × نسبة OPEX)', null], 'data', 'link');
  R.noi = push(['🟢 صافي الدخل التشغيلي (NOI = (EGI-OPEX)×(1-رسوم إدارة الملكية))', null], 'data', 'link');
  R.yoc = push(['🟢 عائد التكلفة (Yield on Cost = NOI ÷ TPC)', null], 'data', 'link');
  const ws = xlNewSheet(wb, '05_Revenue', B.rows, B.kinds, { colWidths:[46,26] });
  colorize(ws, B.kinds, S);

  if(!standardPath){
    xlSetFormula(ws, R.gla, 2, `'04_Development'!B${D04.gfa}*${ref(A.efficiency)}`, '#,##0');
    ws.getCell(R.effOcc,2).value = '—'; ws.getCell(R.pgi,2).value = '—'; ws.getCell(R.egi,2).value = '—'; ws.getCell(R.opexAmt,2).value = '—';
    ws.getCell(R.noi,2).value = Math.round(c.stabilizedNOIyr1||0);
    ws.getCell(R.yoc,2).value = fmtPct(c.yieldOnCost);
    return R;
  }
  xlSetFormula(ws, R.gla, 2, `'04_Development'!B${D04.gfa}*${ref(A.efficiency)}`, '#,##0');
  const effOccF = d.meta.oppType==='income' ? `${ref(A.occupancy)}` : `${ref(A.occupancy)}*(1-${ref(A.salePct)})`;
  xlSetFormula(ws, R.effOcc, 2, effOccF, '0.0%');
  xlSetFormula(ws, R.pgi, 2, `B${R.gla}*${ref(A.rent)}`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, R.egi, 2, `B${R.pgi}*B${R.effOcc}`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, R.opexAmt, 2, `B${R.egi}*${ref(A.opex)}`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, R.noi, 2, `(B${R.egi}-B${R.opexAmt})*(1-${ref(A.feePropMgmt)})`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, R.yoc, 2, `B${R.noi}/'03_Sources & Uses'!B${U.tpc}`, '0.0%');
  return R;
}

function build06Opex(core, wb, d, c, A, U, R05, standardPath){
  const { fmtPct, xlRowsBuilder, xlNewSheet, xlSetFormula, xlColLetter } = core;
  const AS = '02_Assumptions'; const SU = '03_Sources & Uses';
  const ref = (row,col)=> `'${AS}'!${xlColLetter(col||2)}${row}`;
  const B = xlRowsBuilder(); const S = [];
  const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
  push(['المصروفات التشغيلية — OPEX',''],'title');
  push(['البند','القيمة'],'header');
  const O = {};
  if(d.meta.oppType==='income'){
    O.noi = push(['🟢 صافي الدخل التشغيلي بعد OPEX (سنة ١ من ورقة 05)', null], 'data', 'link');
  }
  // مدة الصندوق الكلية — تُستخدم لتراكم رسوم الصندوق السنوية على كامل العمر
  const totalYearsF = d.meta.oppType==='landbank' ? `${ref(A.holdingYears)}`
    : `MAX(1,${ref(A.constructionYears)}+${ref(A.operationYears)})`;
  O.mgmtFeeTotal = push(['🟢 رسوم إدارة الصندوق التراكمية (Mgmt Fee)', null], 'data', 'link');
  O.assetMgmtTotal = push(['🟢 رسوم إدارة الأصول التراكمية (Asset Mgmt Fee)', null], 'data', 'link');
  O.regAuditCustodianTotal = push(['🟢 رسوم تنظيمية/تدقيق/أمين حفظ (تراكمية)', null], 'data', 'link');
  O.fundSideFees = push(['🟢 إجمالي رسوم الصندوق (Fund-Side Fees)', null], 'data', 'link');
  O.feesPctOfTPC = push(['🟢 نسبة إجمالي الرسوم من TPC', null], 'data', 'link');
  const ws = xlNewSheet(wb, '06_OPEX', B.rows, B.kinds, { colWidths:[42,26] });
  colorize(ws, B.kinds, S);
  if(d.meta.oppType==='income'){
    xlSetFormula(ws, O.noi, 2, `'05_Revenue'!B${R05.noi}`, '#,##0;(#,##0);"-"');
  }
  xlSetFormula(ws, O.mgmtFeeTotal, 2, `${ref(A.feeMgmt)}*(${SU_ref(SU,U.equity)}+${SU_ref(SU,U.debt)})/2*(${totalYearsF})`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, O.assetMgmtTotal, 2, `${ref(A.feeAssetMgmt)}*${SU_ref(SU,U.tpc)}*(${totalYearsF})`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, O.regAuditCustodianTotal, 2, `${ref(A.feeRegAuditCustodian)}*(${totalYearsF})`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, O.fundSideFees, 2, `${SU_ref(SU,U.struct)}+${SU_ref(SU,U.arr)}+B${O.mgmtFeeTotal}+B${O.assetMgmtTotal}+B${O.regAuditCustodianTotal}+${SU_ref(SU,U.fixed)}+${SU_ref(SU,U.acq)}`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws, O.feesPctOfTPC, 2, `B${O.fundSideFees}/${SU_ref(SU,U.tpc)}`, '0.0%');
  return O;
}
function SU_ref(sheetName,row){ return `'${sheetName}'!B${row}`; }

function build07Debt(core, wb, d, c, A, U, R05, standardPath){
  const { fmtSAR, fmtPct, xlRowsBuilder, xlNewSheet, xlSetFormula, xlColLetter } = core;
  const AS = '02_Assumptions'; const SU = '03_Sources & Uses';
  const ref = (row,col)=> `'${AS}'!${xlColLetter(col||2)}${row}`;
  const B = xlRowsBuilder(); const S = [];
  const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
  push(['التمويل والديون — Debt',''],'title');
  const DB = {};

  if(!standardPath){
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
    return DB;
  }

  // ---- المسار القياسي: معادلات حقيقية مترابطة (فوائد فقط، بلا جدول سحب، بلا استهلاك أصل) ----
  push(['البند','القيمة'],'header');
  DB.saibor = push(['🟢 SAIBOR (من ٠٢_الافتراضات)', null], 'data', 'link');
  DB.margin = push(['🟢 هامش البنك (Margin)', null], 'data', 'link');
  DB.rate = push(['🟢 معدل الفائدة الكلي (SAIBOR+Margin)', null], 'data', 'link');
  DB.ltc = push(['🟢 نسبة التمويل (LTC)', null], 'data', 'link');
  DB.totalDebt = push(['🟢 إجمالي الدين (Total Debt، من ٠٣_المصادر والاستخدامات)', null], 'data', 'link');
  DB.dscrMin = push(['🟢 DSCR (أدنى، من الجدول أدناه)', null], 'data', 'link');
  DB.dscrAvg = push(['🟢 DSCR (متوسط، من الجدول أدناه)', null], 'data', 'link');
  push(['','']);
  push(['جدول خدمة الدين السنوي (Annual Debt Service — فوائد فقط، بلا استهلاك أصل)',''],'section');
  push(['السنة','صافي الدخل التشغيلي (NOI)','الفائدة','سداد الأصل','خدمة الدين','DSCR'],'header');

  const totalYears = Math.round(c.totalYears||0);
  const constructionYears = Math.round(c.constructionYears||0);
  const isLandbank = d.meta.oppType==='landbank';
  DB.yearRows = [];
  for(let yr=1; yr<=totalYears; yr++){
    const inConstruction = !isLandbank && yr<=constructionYears;
    const rn = push([yr, null, null, 0, null, null]);
    DB.yearRows.push({ yr, row:rn, inConstruction });
  }
  DB.firstYearRow = DB.yearRows.length? DB.yearRows[0].row : null;
  DB.lastYearRow = DB.yearRows.length? DB.yearRows[DB.yearRows.length-1].row : null;

  const ws = xlNewSheet(wb, '07_Debt', B.rows, B.kinds, { colWidths:[10,22,18,16,18,12] });
  colorize(ws, B.kinds, S);

  xlSetFormula(ws, DB.saibor, 2, ref(A.saibor), '0.0%');
  xlSetFormula(ws, DB.margin, 2, ref(A.margin), '0.0%');
  xlSetFormula(ws, DB.rate, 2, `${ref(A.saibor)}+${ref(A.margin)}`, '0.0%');
  xlSetFormula(ws, DB.ltc, 2, ref(A.ltc), '0.0%');
  xlSetFormula(ws, DB.totalDebt, 2, SU_ref(SU,U.debt), '#,##0;(#,##0);"-"');

  DB.yearRows.forEach(({yr,row,inConstruction})=>{
    // صافي الدخل التشغيلي (NOI) لهذه السنة
    let noiF;
    if(isLandbank){
      noiF = `-${ref(A.carryAnnual)}-${SU_ref(SU,U.land)}*${ref(A.whiteLandFeePct)}+${ref(A.interimAnnualIncome)}`;
    } else if(inConstruction){
      noiF = null; // صفر حرفي — لا إيراد تشغيلي خلال الإنشاء
    } else {
      noiF = `'05_Revenue'!B${R05.noi}`;
    }
    if(noiF) xlSetFormula(ws, row, 2, noiF, '#,##0;(#,##0);"-"');
    else { ws.getCell(row,2).value = 0; ws.getCell(row,2).numFmt = '#,##0;(#,##0);"-"'; }
    // الفائدة = إجمالي الدين × معدل الفائدة (ثابتة كل سنة — لا استهلاك أصل، لا جدول سحب)
    xlSetFormula(ws, row, 3, `B${DB.totalDebt}*B${DB.rate}`, '#,##0;(#,##0);"-"');
    // خدمة الدين = الفائدة + سداد الأصل (سداد الأصل = 0 دوماً في هذا المسار)
    xlSetFormula(ws, row, 5, `C${row}+D${row}`, '#,##0;(#,##0);"-"');
    // DSCR — يُحتسب فقط لسنوات التشغيل الفعلية لفرص الدخل/التطوير (لا معنى له لبنك الأراضي ولا لسنوات الإنشاء)
    if(isLandbank || inConstruction){
      ws.getCell(row,6).value = '—';
    } else {
      xlSetFormula(ws, row, 6, `IF(E${row}>0,B${row}/E${row},IF(B${row}>0,99,"—"))`, '0.00"×"');
    }
  });

  if(DB.firstYearRow){
    xlSetFormula(ws, DB.dscrMin, 2, `IFERROR(MIN(F${DB.firstYearRow}:F${DB.lastYearRow}),"—")`, '0.00"×"');
    xlSetFormula(ws, DB.dscrAvg, 2, `IFERROR(AVERAGE(F${DB.firstYearRow}:F${DB.lastYearRow}),"—")`, '0.00"×"');
  } else {
    ws.getCell(DB.dscrMin,2).value = '—'; ws.getCell(DB.dscrAvg,2).value = '—';
  }
  return DB;
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
    return { ws, rIRR, rNPV };
  }
}

/* المسار القياسي لأوراق ٠٨/٠٩ — معادلات حقيقية مترابطة سنة-بسنة (بدل أرقام جامدة من c.projectCF/
   c.equityCF)، مبنية من نفس جبر compute() بالضبط لكن كخلايا Excel: قسم "تفاصيل سنة الخروج" في
   ٠٨_Project CF يُحتسَب مرة واحدة (قيمة الخروج/تكاليف الخروج/سداد الدين) بحسب نوع الفرصة، ثم يُشار
   إليه من صف السنة الأخيرة في كلا الشيتين — يمنع أي ازدواج أو تعارض بين ٠٨ و٠٩. */
function build0809CashFlowsStandard(core, wb, d, c, A, U, R05, DB07){
  const { xlRowsBuilder, xlNewSheet, xlSetFormula, xlColLetter } = core;
  const AS = '02_Assumptions'; const SU = '03_Sources & Uses';
  const ref = (row,col)=> `'${AS}'!${xlColLetter(col||2)}${row}`;
  const totalYears = Math.round(c.totalYears||0);
  const oppType = d.meta.oppType;
  const isLandbank = oppType==='landbank';

  /* ---- 08_Project CF ---- */
  const B8 = xlRowsBuilder(); const S8 = [];
  const push8 = (vals,kind,sem)=>{ const n=B8.push(vals,kind); S8[n-1]=sem||null; return n; };
  push8(['التدفقات النقدية للمشروع — Project Cash Flow',''],'title');
  push8(['تفاصيل سنة الخروج (Exit Year Detail)',''],'section');
  push8(['البند','القيمة'],'header');
  const EX = {};
  EX.value = push8(['🟢 قيمة الخروج (Exit Value)', null], 'data', 'link');
  EX.costPct = push8(['🟢 نسبة تكاليف الخروج (وساطة+قانونية+RETT+أخرى+تصرّف)', null], 'data', 'link');
  EX.costs = push8(['🟢 تكاليف الخروج (مبلغ)', null], 'data', 'link');
  EX.debtPayoff = push8(['🟢 سداد الدين المتبقي عند الخروج (Debt Payoff)', null], 'data', 'link');
  push8(['','']);
  push8(['السنة','تدفق المشروع (ر.س)'],'header');
  const firstRow8 = B8.rows.length+1;
  const yrRows8 = [];
  for(let yr=0; yr<=totalYears; yr++){ yrRows8.push(push8([yr, null])); }
  const lastRow8 = B8.rows.length;
  push8(['','']);
  const rIRR8 = push8(['🔒 Project IRR (معادلة IRR على الصفوف أعلاه)', null], 'note');
  const rNPV8 = push8(['🔒 NPV @ WACC ('+(c.WACC*100).toFixed(1)+'%)', null], 'note');
  const ws08 = xlNewSheet(wb, '08_Project CF', B8.rows, B8.kinds, { colWidths:[46,26] });
  colorize(ws08, B8.kinds, S8);

  let exitValueF;
  if(isLandbank){
    exitValueF = `${SU_ref(SU,U.land)}*(1+${ref(A.appreciation)})^${totalYears}`;
  } else if(oppType==='development'){
    const saleValueF = `'05_Revenue'!B${R05.gla}*${ref(A.salePrice)}*${ref(A.salePct)}`;
    const rentedValueF = `'05_Revenue'!B${R05.gla}*(1-${ref(A.salePct)})*${ref(A.rent)}*${ref(A.occupancy)}*(1-${ref(A.opex)})*(1-${ref(A.feePropMgmt)})/MAX(0.02,${ref(A.exitCapRate)})`;
    exitValueF = `(${saleValueF})+(${rentedValueF})`;
  } else { // income
    exitValueF = `('05_Revenue'!B${R05.noi}*(1+${ref(A.growth)})^${totalYears})/MAX(0.02,${ref(A.marketCap)})`;
  }
  xlSetFormula(ws08, EX.value, 2, exitValueF, '#,##0;(#,##0);"-"');
  const costPctF = `${ref(A.exitBroker)}+${ref(A.exitLegal)}+${ref(A.exitRett)}+${ref(A.exitFeeOther)}+${ref(A.feeDisposition)}`;
  xlSetFormula(ws08, EX.costPct, 2, costPctF, '0.0%');
  xlSetFormula(ws08, EX.costs, 2, `B${EX.value}*B${EX.costPct}`, '#,##0;(#,##0);"-"');
  xlSetFormula(ws08, EX.debtPayoff, 2, SU_ref(SU,U.debt), '#,##0;(#,##0);"-"');

  yrRows8.forEach((rn, yr)=>{
    if(yr===0){ xlSetFormula(ws08, rn, 2, `-${SU_ref(SU,U.tpc)}`, '#,##0;(#,##0);"-"'); return; }
    const dbRow = DB07.yearRows[yr-1].row;
    if(yr===totalYears) xlSetFormula(ws08, rn, 2, `'07_Debt'!B${dbRow}+B${EX.value}-B${EX.costs}`, '#,##0;(#,##0);"-"');
    else xlSetFormula(ws08, rn, 2, `'07_Debt'!B${dbRow}`, '#,##0;(#,##0);"-"');
  });
  xlSetFormula(ws08, rIRR8, 2, `IRR(B${firstRow8}:B${lastRow8})`, '0.0%');
  xlSetFormula(ws08, rNPV8, 2, `B${firstRow8}+NPV(${c.WACC},B${firstRow8+1}:B${lastRow8})`, '#,##0;(#,##0);"-"');

  /* ---- 09_Equity CF ---- */
  const B9 = xlRowsBuilder(); const S9 = [];
  const push9 = (vals,kind,sem)=>{ const n=B9.push(vals,kind); S9[n-1]=sem||null; return n; };
  push9(['التدفقات النقدية لحقوق الملكية — Equity Cash Flow',''],'title');
  push9(['السنة','تدفق حقوق الملكية (ر.س)'],'header');
  const firstRow9 = B9.rows.length+1;
  const yrRows9 = [];
  for(let yr=0; yr<=totalYears; yr++){ yrRows9.push(push9([yr, null])); }
  const lastRow9 = B9.rows.length;
  push9(['','']);
  const rIRR9 = push9(['🔒 Equity IRR (معادلة IRR على الصفوف أعلاه)', null], 'note');
  const rMOIC9 = push9(['🔒 MOIC (مجموع التوزيعات الموجبة ÷ |التدفق الأول|)', null], 'note');
  const ws09 = xlNewSheet(wb, '09_Equity CF', B9.rows, B9.kinds, { colWidths:[46,26] });
  colorize(ws09, B9.kinds, S9);

  const annualFundFeeF = `${ref(A.feeMgmt)}*(${SU_ref(SU,U.equity)}+${SU_ref(SU,U.debt)})/2+${ref(A.feeAssetMgmt)}*${SU_ref(SU,U.tpc)}+${ref(A.feeRegAuditCustodian)}`;
  yrRows9.forEach((rn, yr)=>{
    if(yr===0){ xlSetFormula(ws09, rn, 2, `-${SU_ref(SU,U.equity)}*(1+${ref(A.subscriptionFee)})`, '#,##0;(#,##0);"-"'); return; }
    const dbRow = DB07.yearRows[yr-1].row;
    const netOpF = `'07_Debt'!B${dbRow}-'07_Debt'!E${dbRow}-(${annualFundFeeF})`;
    if(yr===totalYears) xlSetFormula(ws09, rn, 2, `${netOpF}+'08_Project CF'!B${EX.value}-'08_Project CF'!B${EX.costs}-'08_Project CF'!B${EX.debtPayoff}`, '#,##0;(#,##0);"-"');
    else xlSetFormula(ws09, rn, 2, netOpF, '#,##0;(#,##0);"-"');
  });
  xlSetFormula(ws09, rIRR9, 2, `IRR(B${firstRow9}:B${lastRow9})`, '0.0%');
  // المقام = إجمالي رأس المال المُستثمَر فعلياً (contributedEquity + investorSideFees في compute()) —
  // مجموع القيم المطلقة لكل التدفقات السالبة عبر كل السنوات (لا التدفق الأول فقط — قد تُوجَد نداءات
  // رأسمالية إضافية خلال سنوات الإنشاء) زائد رسوم الاشتراك مرة إضافية (نفس ازدواج compute() المتعمَّد).
  const moicDenomF9 = `-SUMIF(B${firstRow9}:B${lastRow9},"<0")+${ref(A.subscriptionFee)}*${SU_ref(SU,U.equity)}`;
  xlSetFormula(ws09, rMOIC9, 2, `SUMIF(B${firstRow9}:B${lastRow9},">0")/(${moicDenomF9})`, '0.00"×"');

  return { ws09, lastRow9, rIRR8, rNPV8, rIRR9, rMOIC9 };
}

async function build0809CashFlowsWithChart(core, wb, d, c, A, U, R05, O06, DB07, standardPath){
  const AS2 = '02_Assumptions'; const SU2 = '03_Sources & Uses';
  let ws09, lastRowForChart, rIRR8, rNPV8, rIRR9, rMOIC9;
  if(standardPath){
    const res = build0809CashFlowsStandard(core, wb, d, c, A, U, R05, DB07);
    ws09 = res.ws09; lastRowForChart = res.lastRow9;
    rIRR8 = res.rIRR8; rNPV8 = res.rNPV8; rIRR9 = res.rIRR9; rMOIC9 = res.rMOIC9;
  } else {
    const res08 = build0809CashFlows(core, wb, d, c);
    rIRR8 = res08.rIRR; rNPV8 = res08.rNPV;
    const { xlRowsBuilder, xlNewSheet, xlSetFormula } = core;
    const B = xlRowsBuilder();
    B.push(['التدفقات النقدية لحقوق الملكية — Equity Cash Flow',''],'title');
    B.push(['السنة','تدفق حقوق الملكية (ر.س)'],'header');
    const firstRow = B.rows.length+1;
    c.equityCF.forEach((v,i)=> B.push([i, Math.round(v)]));
    const lastRow = B.rows.length;
    B.push(['','']);
    const rIRR = B.push(['🔒 Equity IRR (معادلة IRR على الصفوف أعلاه)', null], 'note');
    const rMOIC = B.push(['🔒 MOIC (مجموع التوزيعات الموجبة ÷ إجمالي رأس المال المُستثمَر)', null], 'note');
    ws09 = xlNewSheet(wb, '09_Equity CF', B.rows, B.kinds, { colWidths:[46,26] });
    xlSetFormula(ws09, rIRR, 2, `IRR(B${firstRow}:B${lastRow})`, '0.0%');
    const moicDenomF = `-SUMIF(B${firstRow}:B${lastRow},"<0")+'${AS2}'!B${A.subscriptionFee}*'${SU2}'!B${U.equity}`;
    xlSetFormula(ws09, rMOIC, 2, `SUMIF(B${firstRow}:B${lastRow},">0")/(${moicDenomF})`, '0.00"×"');
    lastRowForChart = lastRow;
    rIRR9 = rIRR; rMOIC9 = rMOIC;
  }

  const years = c.equityCF.map((v,i)=>i);
  await addChartImage(wb, ws09, { type:'bar',
    data:{ labels:years, datasets:[
      { label:'Project CF', data:c.projectCF.map(v=>Math.round(v)), backgroundColor:XL_CHART_COLORS.accent },
      { label:'Equity CF', data:c.equityCF.map(v=>Math.round(v)), backgroundColor:XL_CHART_COLORS.gold },
    ] },
    options:Object.assign({}, XL_CHART_BASE, { plugins:{ title:{ display:true, text:'Project vs Equity Cash Flow by Year', color:XL_CHART_COLORS.ink, font:{ size:13, weight:'bold' } }, legend:{ position:'bottom', labels:{ color:XL_CHART_COLORS.ink, font:XL_CHART_FONT } } } })
  }, 520, 280, 0, lastRowForChart+3);

  return { rIRR8, rNPV8, rIRR9, rMOIC9 };
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

function build10Returns(core, wb, d, c, CF0809){
  const { fmtSAR, fmtPct, xlRowsBuilder, xlNewSheet, xlSetFormula } = core;
  const B = xlRowsBuilder(); const S = [];
  const push = (vals,kind,sem)=>{ const n=B.push(vals,kind); S[n-1]=sem||null; return n; };
  push(['العوائد — Returns',''],'title');
  push(['المؤشر','القيمة'],'header');
  const rEquityIRR = push(['🟢 Equity IRR (من 09_Equity CF)', null], 'data', 'link');
  const rProjectIRR = push(['🟢 Project IRR (من 08_Project CF)', null], 'data', 'link');
  const rMOIC = push(['🟢 MOIC (من 09_Equity CF)', null], 'data', 'link');
  const rNPVProject = push(['🟢 NPV (Project @ WACC، من 08_Project CF)', null], 'data', 'link');
  push(['DPI', isFinite(c.DPI)?c.DPI.toFixed(2)+'×':'—']);
  push(['RVPI', isFinite(c.RVPI)?c.RVPI.toFixed(2)+'×':'—']);
  push(['TVPI', isFinite(c.TVPI)?c.TVPI.toFixed(2)+'×':'—']);
  push(['NPV (Equity @ Ke)', fmtSAR(c.npvEquity)]);
  push(['ROI (عائد نقدي على مدى العمر)', fmtPct(c.ROI)]);
  push(['فترة استرداد رأس المال', c.paybackPeriod!=null? c.paybackPeriod.toFixed(1)+' سنة':'لم يُسترد بالكامل']);
  push(['القيمة الصافية التقديرية (NAV)', fmtSAR(c.NAV)]);
  const ws = xlNewSheet(wb, '10_Returns', B.rows, B.kinds, { colWidths:[42,26] });
  colorize(ws, B.kinds, S);
  if(CF0809 && CF0809.rIRR9!=null) xlSetFormula(ws, rEquityIRR, 2, `'09_Equity CF'!B${CF0809.rIRR9}`, '0.0%');
  else ws.getCell(rEquityIRR,2).value = fmtPct(c.equityIRR);
  if(CF0809 && CF0809.rIRR8!=null) xlSetFormula(ws, rProjectIRR, 2, `'08_Project CF'!B${CF0809.rIRR8}`, '0.0%');
  else ws.getCell(rProjectIRR,2).value = fmtPct(c.projectIRR);
  if(CF0809 && CF0809.rMOIC9!=null) xlSetFormula(ws, rMOIC, 2, `'09_Equity CF'!B${CF0809.rMOIC9}`, '0.00"×"');
  else ws.getCell(rMOIC,2).value = c.MOIC.toFixed(2)+'×';
  if(CF0809 && CF0809.rNPV8!=null) xlSetFormula(ws, rNPVProject, 2, `'08_Project CF'!B${CF0809.rNPV8}`, '#,##0;(#,##0);"-"');
  else ws.getCell(rNPVProject,2).value = fmtSAR(c.npvProject);
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
