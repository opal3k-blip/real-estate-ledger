/* =========================================================================
   عرض لجنة الاستثمار — Investment Committee Presentation (١٢ شريحة)
   ---------------------------------------------------------------------------
   إعادة هيكلة تصدير PowerPoint من "Financial Presentation Export" (الدالة
   الحالية exportOpportunityPptx في core.js، تبقى كما هي دون أي تعديل — لا
   تزال متاحة كتصدير سريع من زر "⬇️ PowerPoint" الأصلي) إلى عرض بمستوى لجنة
   استثمار (١٠-١٢ شريحة فقط، حسب طلب المستخدم بالضبط —
   خطة_التقارير_والمهام_القادمة.md § ٣) بدل عشرات شرائح البيانات. تصدير جديد
   ومستقل تماماً (لا يلمس core.js)، يُعيد استخدام نفس مكتبة PptxGenJS المحمَّلة
   أصلاً عالمياً (window.PptxGenJS، نفس ما تستخدمه exportOpportunityPptx)
   ونفس لوحة الألوان المستخدمة هناك (أخضر أوبال 0E6B4C / نص رمادي 4C5850 /
   خلفية بطاقات F3F4F0 / حدود D6DACF / نتائج جيدة-تحذير-سيئة 1E8A56-9C6A0A-
   AE2E22)، وكل بيانات الشرائح مُعادة استخدامها من دوال محسوبة مسبقاً (compute/
   sensitivityRows/RISK_CATEGORIES/matchBenchmarks+aggregateBench/
   maxAcquisitionPrice/dealStrengthsAndNegotiationPoints) — صفر حسابات مالية
   جديدة، صفر تعديل على core.js.
   ========================================================================= */

import { generateAnalystNarrative } from './ai-analyst.js';
import { RISK_CATEGORIES, defaultRiskItems, scoreOf as riskScoreOf, bandOf as riskBandOf } from './risk-engine.js';
import { matchBenchmarks, aggregateBench } from './benchmark-engine.js';
import { maxAcquisitionPrice } from './max-acquisition-price.js';
// دقة التدفقات النقدية (شهري/ربع سنوي) + ذروة الاحتياج + صافي النقدي من المستثمرين النقديين
// نفس مصدر الحساب المستخدَم في واجهة المذكرة الحية وفي دفتر الاكتتاب
// الكامل (excel-workbook.js)، حتى لا يتكرر منطق منحنى S/التوزيع الشهري في أكثر من مكان.
import { cashFlowTimingAnalysis } from './cash-flow-timing.js';

const COMPARABLES_COLLECTION = 'comparables';
const PAL = { green:'0E6B4C', text:'4C5850', ink:'152019', card:'F3F4F0', border:'D6DACF', good:'1E8A56', warn:'9C6A0A', bad:'AE2E22' };
const PPTX_FONT = 'Sakkal Majalla';

function median(nums){
  if(!nums.length) return null;
  const s = nums.slice().sort((a,b)=>a-b);
  const mid = Math.floor(s.length/2);
  return s.length%2 ? s[mid] : (s[mid-1]+s[mid])/2;
}

// تنظيف أي نص (خصوصاً النصوص الحرة التي يُدخلها المستخدم: التخفيف/الشروط/مصدر المقارنة/سردية
// المحلل...) قبل كتابته داخل PowerPoint — إزالة الرموز التعبيرية (Emoji) التي لا يدعمها خط
// Sakkal Majalla فتظهر كمربع فيه علامة استفهام (Tofu Glyph)، ورموز التحكّم غير المرئية بالاتجاه
// (Bidi Control Characters). نفس منطق xlCleanText في core.js، مُعاد هنا لأن هذا الملف تصدير مستقل
// تماماً عن core.js (انظر تعليق أعلى الملف) فلا يستورد دوالها الداخلية.
function pptxCleanText(v){
  if(typeof v!=='string') return v;
  return v
    .replace(/[‪-‮⁦-⁩]/g,'')
    .replace(/[☀-➿\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}]️?/gu,'')
    .replace(/[ \t]{2,}/g,' ')
    .trim();
}

export function registerICPresentation(core){
  core.registerDetailSection((d,c)=>{
    const oppId = core.openDetailId;
    const rec = core.opportunities.find(o=>o.id===oppId);
    if(!rec) return '';
    return `
    <div class="section" style="text-align:center; background:var(--surface-2); border:1px dashed var(--border);">
      <button type="button" class="btn btn-sm btn-primary" data-action="icppt-export" data-id="${rec.id}">🖥️ ${core.T('تنزيل عرض لجنة الاستثمار (PowerPoint، ١٢ شريحة)','Download IC Presentation (PowerPoint, 12 slides)')}</button>
      <p class="note" style="margin:8px 0 0;">${core.T('عرض مختصر بمستوى لجنة استثمار — ١٢ شريحة فقط، لا عشرات شرائح البيانات.','A concise IC-level deck — just 12 slides, not dozens of data slides.')}</p>
    </div>`;
  });

  core.registerActionHandler(async (action, el)=>{
    if(action==='icppt-export'){ await exportICPresentation(core, el.dataset.id); return true; }
    return false;
  });
}

export async function exportICPresentation(core, id){
  const rec = core.opportunities.find(o=>o.id===id);
  if(!rec) return;
  const d = core.withDefaults(rec.data), c = core.compute(d);
  const { fmtSAR, fmtPct, fmtNum } = core;
  try{
    const Ctor = window.PptxGenJS || (window.pptxgenjs && window.pptxgenjs.default);
    const pres = new Ctor();
    pres.defineLayout({ name:'WIDE', width:13.33, height:7.5 });
    pres.layout = 'WIDE';
    // اتجاه صحيح من اليمين لليسار وخط عربي موحَّد لكل نص في هذا العرض — نفس الإعداد المستخدَم في
    // exportOpportunityPptx (core.js)، كان غائباً هنا بالكامل فكان النص العربي يُكتب افتراضياً
    // بالاتجاه اللاتيني (LTR) في PowerPoint. pres.rtlMode/pres.theme وحدهما لا يكفيان عملياً (لا
    // يُطبَّقان تلقائياً على كل addText/addTable في بعض إصدارات المكتبة) لذا يُكرَّران صراحة على
    // كل عنصر نصي عبر الثابت PPTX_FONT ودالتَي H وkpiRow أدناه.
    pres.rtlMode = true;
    pres.theme = { headFontFace:PPTX_FONT, bodyFontFace:PPTX_FONT };

    const narrative = generateAnalystNarrative(core, d, c);
    const reportDates = core.reportDateMeta(d);
    const decisionConfidence = narrative.decisionConfidence;
    const decisions = (d.ic && d.ic.decisions) || [];
    const latest = decisions.length? decisions[decisions.length-1] : null;
    const ti = core.OPP_TYPE_INFO[d.meta.oppType];
    const vlbl = c.verdict==='good'?'قابلة للعرض على لجنة الاستثمار':c.verdict==='warn'?'تحت المراجعة':'دون معايير القبول';
    const vcolor = c.verdict==='good'?PAL.good:c.verdict==='warn'?PAL.warn:PAL.bad;

    // خلية جدول موحَّدة: pptxgenjs لا يُطبِّق rtlMode على مستوى addTable على أي خلية فعلياً (تأكَّد
    // هذا بفحص XML الناتج فعلياً — rtlMode في خيارات الجدول العامة لا يترك أي أثر "rtl=1" داخل
    // <a:pPr> لأي خلية، بعكس fontFace الذي يترشَّح بشكل صحيح لكل خلية). لذلك يجب ضبط rtlMode
    // صراحة داخل خيارات كل خلية على حدة عبر هذه الدالة، وليس فقط في خيارات addTable نفسها.
    const cell = (text, extra)=> ({ text: pptxCleanText(String(text==null?'':text)), options: Object.assign({ rtlMode:true, fontFace:PPTX_FONT }, extra||{}) });
    const H = (s, txt, y)=> s.addText(pptxCleanText(txt), { x:0.5, y:y!=null?y:0.35, w:12.3, h:0.6, fontSize:22, bold:true, color:PAL.green, align:'right', rtlMode:true, fontFace:PPTX_FONT });
    const kpiRow = (s, items, y, w)=>{
      let kx = 0.5; const boxW = w || (12.3/items.length - 0.1);
      items.forEach(([l,v])=>{
        s.addText([{text:pptxCleanText(v)+'\n',options:{fontSize:18,bold:true,color:PAL.green}},{text:pptxCleanText(l),options:{fontSize:10,color:PAL.text}}],
          { x:kx, y:y, w:boxW, h:1.05, align:'center', valign:'middle', fill:{color:PAL.card}, line:{color:PAL.border,width:1}, rtlMode:true, fontFace:PPTX_FONT });
        kx += boxW + 0.12;
      });
    };

    /* ===================== 1) Investment Opportunity ===================== */
    {
      const s = pres.addSlide();
      s.addText(pptxCleanText(d.meta.name)||'فرصة استثمارية', { x:0.5,y:0.5,w:12.3,h:1, fontSize:30, bold:true, color:PAL.green, align:'right', rtlMode:true, fontFace:PPTX_FONT });
      s.addText(pptxCleanText(`${d.meta.city} · ${d.meta.neighborhood||'—'} · ${d.meta.tier}  |  ${ti.ic} ${core.T(ti.t,ti.en)}  |  ${rec.id}`), { x:0.5,y:1.5,w:12.3,h:0.5, fontSize:14, color:PAL.text, align:'right', rtlMode:true, fontFace:PPTX_FONT });
      s.addText(`${core.T('تاريخ سريان البيانات','As-of Date')}: ${reportDates.asOfText}  |  ${core.T('تم إنشاؤه في','Generated on')}: ${reportDates.generatedText}`,
        { x:0.5, y:1.95, w:12.3, h:0.35, fontSize:10.5, color:PAL.text, align:'right', rtlMode:true, fontFace:PPTX_FONT });
      s.addText('التوصية: ' + vlbl, { x:0.5,y:2.3,w:12.3,h:0.45, fontSize:18, bold:true, color:vcolor, align:'right', rtlMode:true, fontFace:PPTX_FONT });
      s.addText(`${core.T('الدرجة الاستثمارية المركّبة','Composite Investment Score')}: ${narrative.scoreRes.composite.toFixed(0)}/100 (${core.T(narrative.band.ar,narrative.band.en)})  |  ${core.T('ثقة القرار','Decision Confidence')}: ${decisionConfidence.score.toFixed(0)}/100 (${core.T(decisionConfidence.band.ar,decisionConfidence.band.en)})`,
        { x:0.5, y:2.7, w:12.3, h:0.35, fontSize:11, color:PAL.ink, align:'right', rtlMode:true, fontFace:PPTX_FONT });
      kpiRow(s, [
        ['حجم الاستثمار (TPC)', fmtSAR(c.TPC)],
        ['حقوق الملكية المطلوبة', fmtSAR(c.equity)],
        ['Equity IRR', fmtPct(c.equityIRR,1)],
        ['MOIC', c.MOIC.toFixed(2)+'×'],
      ], 3.15);
    }

    /* ===================== 2) Executive Investment Case ===================== */
    {
      const s = pres.addSlide();
      H(s, 'الحالة الاستثمارية التنفيذية — Executive Investment Case');
      const whyInvest = narrative.strengths.length? narrative.strengths[0] : 'المؤشرات المالية الأساسية تبدو ضمن أو قريبة من معايير القبول المعتمدة وفق الافتراضات الحالية.';
      const bench = (()=>{ const {rows} = matchBenchmarks(core, d.meta.city, d.meta.oppType); return rows.length? aggregateBench(rows) : null; })();
      const whyNow = bench && bench.irrMin!=null
        ? `عائد الفرصة (${fmtPct(c.equityIRR,1)}) يبدو ${c.equityIRR>=bench.irrMin?'ضمن أو أعلى من':'قريباً من'} نطاق السوق المرجعي الحالي (${fmtPct(bench.irrMin)}${bench.irrMax!=null?'–'+fmtPct(bench.irrMax):''}).`
        : 'التوقيت مبني على جاهزية الفرصة وتوفر التمويل حالياً — لا يوجد معيار سوقي مسجَّل بعد للمقارنة.';
      const targetIRR = d.criteria.irrMin || 0.15;
      const mapRes = maxAcquisitionPrice(core, d, targetIRR);
      const whyPrice = mapRes.infeasible
        ? 'السعر الحالي يحتاج مراجعة جوهرية — لا يوجد سعر أرض يحقق العائد المستهدف عند الافتراضات الحالية.'
        : `السعر المُدخَل (${fmtSAR(d.land.price)}/م²) يبدو ${d.land.price<=mapRes.maxPrice?'ضمن':'أعلى من'} الحد الأقصى المحسوب لتحقيق ${fmtPct(targetIRR)} (${fmtSAR(mapRes.maxPrice)}/م²).`;
      const boxes = [
        ['لماذا الاستثمار؟ (Why Invest?)', whyInvest],
        ['لماذا الآن؟ (Why Now?)', whyNow],
        ['لماذا بهذا السعر؟ (Why This Price?)', whyPrice],
      ];
      let bx = 0.5;
      boxes.forEach(([t,body])=>{
        s.addText([{text:t+'\n\n',options:{fontSize:13,bold:true,color:PAL.green}},{text:pptxCleanText(body),options:{fontSize:11,color:PAL.ink}}],
          { x:bx, y:1.3, w:3.97, h:4.8, valign:'top', align:'right', fill:{color:PAL.card}, line:{color:PAL.border,width:1}, margin:0.15, rtlMode:true, fontFace:PPTX_FONT });
        bx += 4.13;
      });
    }

    /* ===================== 3) Asset / Location ===================== */
    {
      const s = pres.addSlide();
      H(s, 'الأصل والموقع — Asset / Location');
      s.addText([
        {text:'المدينة: ', options:{bold:true}}, {text:(d.meta.city||'—')+'\n'},
        {text:'الحي: ', options:{bold:true}}, {text:(d.meta.neighborhood||'—')+'\n'},
        {text:'الفئة: ', options:{bold:true}}, {text:(d.meta.tier||'—')+'\n'},
        {text:'مساحة الأرض: ', options:{bold:true}}, {text:fmtNum(d.land.area)+' م²\n'},
        {text:'معامل البناء (FAR): ', options:{bold:true}}, {text:fmtNum(d.land.far)+'\n'},
        {text:'نوع الفرصة: ', options:{bold:true}}, {text:core.T(ti.t,ti.en)},
      ], { x:0.5,y:1.3,w:12.3,h:5, fontSize:16, align:'right', color:PAL.ink, lineSpacing:32, rtlMode:true, fontFace:PPTX_FONT });
    }

    /* ===================== 4) Business Plan ===================== */
    {
      const s = pres.addSlide();
      H(s, 'خطة العمل — Business Plan');
      // ملاحظة: الترتيب البصري لمراحل خطة العمل (من اليسار لليمين هنا) واتجاه السهم بينها
      // مقصودان بصرياً كتسلسل زمني LTR تقليدي حتى مع rtlMode على النص نفسه — لا علاقة له
      // باتجاه القراءة العربي للنص داخل كل مربع.
      const stages = d.meta.oppType==='development'
        ? ['الأرض (Land)', 'التطوير (Development)', 'البيع/التأجير (Lease/Sale)', 'الخروج (Exit)']
        : d.meta.oppType==='income'
        ? ['الاستحواذ (Acquisition)', 'التشغيل والتأجير (Operate/Lease)', 'الاستقرار (Stabilization)', 'الخروج أو التمويل (Exit/Refinance)']
        : ['الاستحواذ (Acquisition)', 'الحمل والانتظار (Carry/Hold)', 'تغيير التصنيف/التطوير (Rezoning)', 'البيع (Disposition)'];
      let sx = 0.5;
      stages.forEach((label,i)=>{
        s.addText(label, { x:sx, y:2.8, w:2.75, h:1.2, align:'center', valign:'middle', fontSize:13, bold:true, color:PAL.green, fill:{color:PAL.card}, line:{color:PAL.border,width:1.5}, rtlMode:true, fontFace:PPTX_FONT });
        if(i<stages.length-1) s.addText('←', { x:sx+2.78, y:2.9, w:0.35, h:1, align:'center', valign:'middle', fontSize:22, color:PAL.border });
        sx += 3.13;
      });
    }

    /* ===================== 5) Financial Summary ===================== */
    {
      const s = pres.addSlide();
      H(s, 'الملخص المالي — Financial Summary');
      kpiRow(s, [
        ['TPC', fmtSAR(c.TPC)],
        ['حقوق الملكية', fmtSAR(c.equity)],
        ['الدين', fmtSAR(c.debt)],
        ['NPV', fmtSAR(c.npvProject)],
      ], 1.3);
      kpiRow(s, [
        ['Equity IRR', fmtPct(c.equityIRR,1)],
        ['Project IRR', fmtPct(c.projectIRR,1)],
        ['MOIC', c.MOIC.toFixed(2)+'×'],
        ['DSCR (أدنى)', c.dscrMin!=null?c.dscrMin.toFixed(2)+'×':'—'],
      ], 2.55);
      // رسم بياني حقيقي (قابل للتعديل داخل PowerPoint نفسه) — هيكل رأس المال
      s.addChart(pres.ChartType.doughnut, [{ name:'Capital', labels:['Debt','Equity'], values:[Math.round(c.debt), Math.round(c.equity)] }],
        { x:0.7, y:3.95, w:5.5, h:3.15, chartColors:[PAL.warn, PAL.green], showLegend:true, legendPos:'b', legendFontSize:11,
          showValue:false, dataLabelColor:'FFFFFF', title:'Capital Structure — Debt vs Equity', titleFontSize:13, titleColor:PAL.ink });
      // رسم بياني: نسبة تحقيق الحد الأدنى المطلوب للعوائد الرئيسية
      const hurdle = (d.criteria && d.criteria.irrMin) || 0.15;
      const moicMin = (d.criteria && d.criteria.moicMin) || 1.5;
      const dscrMinReq = (d.criteria && d.criteria.dscrMin) || 1.2;
      const rMetrics = [
        hurdle>0 && isFinite(c.equityIRR)? { label:'Equity IRR', ratio:Math.round((c.equityIRR/hurdle)*100) } : null,
        moicMin>0 && isFinite(c.MOIC)? { label:'MOIC', ratio:Math.round((c.MOIC/moicMin)*100) } : null,
        dscrMinReq>0 && c.dscrMin!=null? { label:'DSCR', ratio:Math.round((c.dscrMin/dscrMinReq)*100) } : null,
      ].filter(Boolean);
      s.addChart(pres.ChartType.bar, [{ name:'% of Minimum Required', labels:rMetrics.map(m=>m.label), values:rMetrics.map(m=>m.ratio) }],
        { x:6.3, y:3.95, w:6.1, h:3.15, barDir:'col', chartColors:rMetrics.map(m=>m.ratio>=100?PAL.good:PAL.bad), showLegend:false,
          showValue:true, dataLabelPosition:'outEnd', dataLabelFontSize:10, catAxisLabelFontSize:11, valAxisLabelFormatCode:'0"%"',
          title:'Returns vs Minimum Hurdles (100% = Hurdle)', titleFontSize:13, titleColor:PAL.ink });
    }

    /* ===================== 6) Cash Flow ===================== */
    {
      const s = pres.addSlide();
      H(s, 'التدفقات النقدية — Cash Flow');
      // ذروة الاحتياج النقدي الفعلي + صافي النقدي المطلوب من المستثمرين النقديين (المرحلة
      // تُضاف كشريط مؤشرات مضغوط فوق الجدول السنوي القائم نفسه، بلا شريحة جديدة
      // وبلا تفصيل شهري/ربع سنوي كامل هنا، احتراماً لقيد "١٠-١٢ شريحة فقط" الذي طلبه المستخدم
      // بالضبط لهذا العرض (انظر تعليق أعلى الملف) — التفصيل الشهري/ربع السنوي الكامل متوفر في
      // دفتر الاكتتاب الكامل (excel-workbook.js، ورقة 08b) وفي مذكرة الفرصة الحية.
      const a = cashFlowTimingAnalysis(core, d, c, rec.id);
      const peakLabel = a.peakCashNeed.yearIndex===0 ? 'بداية المشروع (Day 0)' : `سنة ${a.peakCashNeed.yearIndex} — شهر ${a.peakCashNeed.monthInYear}`;
      kpiRow(s, [
        ['ذروة الاحتياج النقدي', fmtSAR(a.peakCashNeed.amount)],
        ['متى يحدث', peakLabel],
        ['صافي النقدي من المستثمرين النقديين', fmtSAR(a.netCashRequiredFromCashInvestors)],
      ], 1.3, 4.0);
      const years = c.projectCF.map((v,i)=>String(i));
      s.addChart(pres.ChartType.bar, [
        { name:'Project CF', labels:years, values:c.projectCF.map(v=>Math.round(v)) },
        { name:'Equity CF', labels:years, values:c.equityCF.map(v=>Math.round(v)) },
      ], { x:0.5, y:2.55, w:12.3, h:2.6, barDir:'col', barGrouping:'clustered', chartColors:[PAL.text, PAL.green], showLegend:true, legendPos:'b', legendFontSize:11,
        catAxisLabelFontSize:10, valAxisLabelFontSize:10, title:'Project vs Equity Cash Flow by Year', titleFontSize:13, titleColor:PAL.ink });
      const rows = [[
        cell('السنة', {bold:true, fill:{color:PAL.card}}),
        cell('تدفق المشروع', {bold:true, fill:{color:PAL.card}}),
        cell('تدفق حقوق الملكية', {bold:true, fill:{color:PAL.card}}),
      ]];
      // حدّ أقصى ١٠ صفوف سنوية معروضة هنا: autoPage:true في addTable يُسبِّب استثناءً داخلياً
      // حقيقياً في pptxgenjs 3.12.0 (addTableDefinition تستدعي addTable داخلياً بصفٍّ فارغ عند
      // تقسيم الجدول تلقائياً على أكثر من شريحة، فيفشل تصدير العرض بالكامل بلا أي ملف ناتج — تم
      // التحقق من هذا فعلياً بتشغيل حقيقي للمكتبة، وليس افتراضاً). بما أن هذا عرض ملخّص لـ١٢
      // شريحة فقط أصلاً (انظر تعليق أعلى الملف)، الحل الأنسب تفصيل السنوات الأولى/الأخيرة فقط بدل
      // تفعيل ترقيم صفحات هش — التفصيل الكامل لكل سنة متوفر في دفتر الاكتتاب (excel-workbook.js).
      const maxRows = 10;
      const n = c.projectCF.length;
      const cfRow = (i)=> [ cell(i), cell(fmtSAR(c.projectCF[i])), cell(fmtSAR(c.equityCF[i])) ];
      if(n<=maxRows){
        for(let i=0;i<n;i++) rows.push(cfRow(i));
      } else {
        const headN = 6, tailN = maxRows-headN-1;
        for(let i=0;i<headN;i++) rows.push(cfRow(i));
        rows.push([ cell('⋯'), cell('⋯'), cell('⋯') ]);
        for(let i=n-tailN;i<n;i++) rows.push(cfRow(i));
      }
      s.addTable(rows, { x:0.5,y:5.35,w:12.3,h:1.8, fontSize:10.5, border:{type:'solid',color:PAL.border,pt:0.5}, align:'center' });
    }

    /* ===================== 7) Sensitivity ===================== */
    {
      const s = pres.addSlide();
      H(s, 'تحليل الحساسية — Sensitivity');
      const sensRows = core.sensitivityRows(d).slice(0,6);
      s.addChart(pres.ChartType.bar, [
        { name:'Downside Δ (pts)', labels:sensRows.map(r=>r.label), values:sensRows.map(r=>Math.round((r.down-r.base)*1000)/10) },
        { name:'Upside Δ (pts)', labels:sensRows.map(r=>r.label), values:sensRows.map(r=>Math.round((r.up-r.base)*1000)/10) },
      ], { x:0.5, y:1.25, w:12.3, h:3.2, barDir:'bar', barGrouping:'clustered', chartColors:[PAL.bad, PAL.good], showLegend:true, legendPos:'b', legendFontSize:11,
        catAxisLabelFontSize:10, catAxisLabelFontFace:PPTX_FONT, valAxisLabelFontSize:10, valAxisLabelFormatCode:'0.0', title:'Equity IRR Sensitivity — Δ vs Base (pts)', titleFontSize:13, titleColor:PAL.ink });
      const rows = [[
        cell('المتغيّر', {bold:true, fill:{color:PAL.card}}),
        cell('منخفض', {bold:true, fill:{color:PAL.card}}),
        cell('الأساسي', {bold:true, fill:{color:PAL.card}}),
        cell('مرتفع', {bold:true, fill:{color:PAL.card}}),
      ]];
      sensRows.forEach(r=> rows.push([ cell(r.label), cell(fmtPct(r.down,1)), cell(fmtPct(r.base,1)), cell(fmtPct(r.up,1)) ]));
      s.addTable(rows, { x:0.5,y:4.65,w:12.3,h:2.5, fontSize:10.5, border:{type:'solid',color:PAL.border,pt:0.5}, align:'center' });
    }

    /* ===================== 8) Risk Matrix ===================== */
    {
      const s = pres.addSlide();
      H(s, 'مصفوفة المخاطر — Risk Matrix');
      const riskItems = (d.risk && d.risk.items) || defaultRiskItems();
      const ranked = RISK_CATEGORIES.map(cat=>{
        const it = riskItems[cat.key] || {probability:1,impact:1,mitigation:''};
        const score = riskScoreOf(it), band = riskBandOf(score);
        return { label: core.T(cat.ar,cat.en), p:it.probability||1, i:it.impact||1, score, band, mitigation: it.mitigation||'—' };
      }).sort((a,b)=>b.score-a.score).slice(0,7);
      s.addChart(pres.ChartType.bar, [{ name:'Risk Score (max 25)', labels:ranked.map(r=>r.label), values:ranked.map(r=>r.score) }],
        { x:0.5, y:1.25, w:12.3, h:2.75, barDir:'bar', chartColors:ranked.map(r=>(r.band.color||'333333').replace('#','')), showLegend:false,
          showValue:true, dataLabelPosition:'outEnd', dataLabelFontSize:10, catAxisLabelFontSize:10.5, catAxisLabelFontFace:PPTX_FONT, valAxisLabelFontSize:10,
          title:'Risk Score by Category', titleFontSize:13, titleColor:PAL.ink });
      const rows = [[
        cell('المخاطرة', {bold:true, fill:{color:PAL.card}}),
        cell('الاحتمالية×الأثر', {bold:true, fill:{color:PAL.card}}),
        cell('الدرجة', {bold:true, fill:{color:PAL.card}}),
        cell('التخفيف', {bold:true, fill:{color:PAL.card}}),
      ]];
      ranked.forEach(r=> rows.push([ cell(r.label), cell(`${r.p} × ${r.i}`), cell(core.T(r.band.ar,r.band.en), {color:'#'+(r.band.color||'#333').replace('#','')}), cell(r.mitigation) ]));
      s.addTable(rows, { x:0.5,y:4.15,w:12.3,h:3.0, fontSize:10.5, border:{type:'solid',color:PAL.border,pt:0.5}, align:'center' });
    }

    /* ===================== 9) Market Evidence ===================== */
    {
      const s = pres.addSlide();
      H(s, 'أدلة السوق — Market Evidence');
      const comps = (core.STORE[COMPARABLES_COLLECTION] || []).map(r=>r.data).filter(cm=> cm.city && d.meta.city && cm.city.trim()===d.meta.city.trim());
      const perM2s = comps.filter(cm=>cm.landSize>0).map(cm=>cm.price/cm.landSize);
      const med = median(perM2s);
      const { rows: benchRows, scope } = matchBenchmarks(core, d.meta.city, d.meta.oppType);
      const bench = benchRows.length? aggregateBench(benchRows) : null;
      kpiRow(s, [
        ['وسيط سعر المقارنات/م²', med!=null?fmtSAR(med):'—'],
        ['سعر الفرصة الحالي/م²', fmtSAR(d.land.price)],
        ['Cap Rate المرجعي', bench&&bench.capRateMin!=null?`${fmtPct(bench.capRateMin)}–${bench.capRateMax!=null?fmtPct(bench.capRateMax):'—'}`:'—'],
        ['عدد المقارنات المسجَّلة', String(comps.length)],
      ], 1.3);
      s.addChart(pres.ChartType.bar, [{ name:'Price/m² (Land)', labels:['وسيط المقارنات','سعر الفرصة الحالي'], values:[med!=null?Math.round(med):0, Math.round(d.land.price)] }],
        { x:0.7, y:2.55, w:5.4, h:2.55, barDir:'col', chartColors:[PAL.text, PAL.green], showLegend:false, showValue:true, dataLabelPosition:'outEnd', dataLabelFontSize:11,
          catAxisLabelFontSize:11, catAxisLabelFontFace:PPTX_FONT, valAxisLabelFontSize:10, title:'Opportunity Price vs Comparables Median (SAR/m²)', titleFontSize:12, titleColor:PAL.ink });
      if(comps.length){
        const rows = [[
          cell('الحي', {bold:true, fill:{color:PAL.card}}),
          cell('النوع', {bold:true, fill:{color:PAL.card}}),
          cell('السعر/م²', {bold:true, fill:{color:PAL.card}}),
          cell('التاريخ', {bold:true, fill:{color:PAL.card}}),
        ]];
        comps.slice(0,6).forEach(cm=> rows.push([ cell(cm.neighborhood||'—'), cell(cm.propertyType||'—'), cell(cm.landSize>0?fmtSAR(cm.price/cm.landSize):'—'), cell(cm.date||'—') ]));
        s.addTable(rows, { x:6.4,y:2.55,w:6.4, fontSize:10.5, border:{type:'solid',color:PAL.border,pt:0.5}, align:'center' });
      }
    }

    /* ===================== 10) Investment Committee Decision ===================== */
    {
      const s = pres.addSlide();
      H(s, 'قرار لجنة الاستثمار — Investment Committee Decision');
      // لا رموز تعبيرية هنا (Sakkal Majalla لا يدعمها) — لون النص (vcolor) وحده ينقل حالة
      // القرار (جيد/تحذير/سيئ)، تماماً كما في شريحة التوصية الأولى.
      const decText = latest? {approve:'اعتماد',approve_conditions:'اعتماد بشروط',revise:'مراجعة وإعادة عرض',hold:'تعليق',reject:'رفض'}[latest.decision] : (c.verdict==='good'?'اعتماد (مقترح)':c.verdict==='warn'?'اعتماد بشروط (مقترح)':'رفض (مقترح)');
      s.addText(decText, { x:0.5,y:1.4,w:12.3,h:1, fontSize:30, bold:true, color:vcolor, align:'center', rtlMode:true, fontFace:PPTX_FONT });
      const conds = latest && latest.conditions && latest.conditions.length? latest.conditions : [];
      if(conds.length){
        const rows = [[cell('الشرط',{bold:true,fill:{color:PAL.card}}),cell('المسؤول',{bold:true,fill:{color:PAL.card}}),cell('الموعد النهائي',{bold:true,fill:{color:PAL.card}})]];
        conds.forEach(cn=> rows.push([ cell(cn.text||'—'), cell(cn.owner||'—'), cell(cn.dueDate||'—') ]));
        s.addTable(rows, { x:0.5,y:2.8,w:12.3, fontSize:12, border:{type:'solid',color:PAL.border,pt:0.5}, align:'center' });
      } else {
        s.addText('لا توجد شروط مسبقة مسجَّلة.', { x:0.5,y:2.8,w:12.3,h:0.6, fontSize:13, color:PAL.text, align:'center', rtlMode:true, fontFace:PPTX_FONT });
      }
    }

    /* ===================== 11) Negotiation Strategy ===================== */
    {
      const s = pres.addSlide();
      H(s, 'استراتيجية التفاوض — Negotiation Strategy');
      const neg = d.negotiation || {};
      const targetIRR = d.criteria.irrMin || 0.15;
      const mapRes = maxAcquisitionPrice(core, d, targetIRR);
      const walkAway = neg.walkAwayPrice!=null? neg.walkAwayPrice : mapRes.maxPrice;
      kpiRow(s, [
        ['سعر طلب البائع', neg.askingPrice!=null?fmtSAR(neg.askingPrice):'—'],
        ['السعر المستهدف', neg.targetPrice!=null?fmtSAR(neg.targetPrice):'—'],
        ['الحد الأقصى للاستحواذ', mapRes.infeasible?'—':fmtSAR(mapRes.maxPrice)],
        ['سعر الانسحاب', walkAway!=null?fmtSAR(walkAway):'—'],
      ], 1.6);
    }

    /* ===================== 12) Appendix ===================== */
    {
      const s = pres.addSlide();
      H(s, 'ملحق — Appendix: الافتراضات المالية التفصيلية');
      s.addText([
        {text:'SAIBOR: ', options:{bold:true}}, {text:fmtPct(d.financing.saibor)+'    '},
        {text:'هامش البنك: ', options:{bold:true}}, {text:fmtPct(d.financing.margin)+'    '},
        {text:'LTC: ', options:{bold:true}}, {text:fmtPct(d.financing.ltc)+'\n'},
        {text:'WACC: ', options:{bold:true}}, {text:fmtPct(c.WACC)+'    '},
        {text:'Yield on Cost: ', options:{bold:true}}, {text:(d.meta.oppType!=='landbank'?fmtPct(c.yieldOnCost):'—')+'\n'},
        {text:'ROI: ', options:{bold:true}}, {text:fmtPct(c.ROI)+'    '},
        {text:'فترة الاسترداد: ', options:{bold:true}}, {text:(c.paybackPeriod!=null?c.paybackPeriod.toFixed(1)+' سنة':'—')+'\n'},
      ], { x:0.5,y:1.4,w:12.3,h:2.5, fontSize:14, align:'right', color:PAL.ink, lineSpacing:34, rtlMode:true, fontFace:PPTX_FONT });
      // هيكل توزيع العوائد (Waterfall) — ملخّص مضغوط في الملحق نفسه بدل شريحة إضافية (احتراماً
      // لقيد "١٢ شريحة فقط")، بنفس أرقام ١٨_Waterfall في دفتر الاكتتاب الكامل (compute()، PIC/
      // Hurdle/Carry/LP-GP-Dev Total من نفس نتيجة compute() المستخدَمة في كل هذا العرض).
      s.addText([
        {text:'Hurdle: ', options:{bold:true}}, {text:fmtPct(d.economics.hurdle)+'    '},
        {text:'Carry: ', options:{bold:true}}, {text:fmtPct(d.economics.carry)+'    '},
        {text:'رأس المال المدفوع (PIC): ', options:{bold:true}}, {text:fmtSAR(c.PIC)+'\n'},
        {text:'إجمالي حصة الشريك المحدود (LP Total): ', options:{bold:true}}, {text:fmtSAR(c.lpTotal)+'    '},
        {text:'إجمالي حصة الشريك العام (GP Total): ', options:{bold:true}}, {text:fmtSAR(c.gpTotal)+'    '},
        {text:'إجمالي حصة المطوّر (Dev Total): ', options:{bold:true}}, {text:fmtSAR(c.devTotal)},
      ], { x:0.5,y:3.95,w:12.3,h:1, fontSize:12, align:'right', color:PAL.ink, lineSpacing:26, rtlMode:true, fontFace:PPTX_FONT });
      s.addText(`هذا العرض أُعِدَّ آلياً من بيانات مستكشف الفرص العقارية كما هي في تاريخ سريان البيانات ${reportDates.asOfText}. الأرقام تقديرية/قائمة على النموذج الحالي ولا تُغني عن تقييم مستقل معتمد أو مراجعة متخصصة قبل أي قرار استثماري نهائي.`,
        { x:0.5,y:5.15,w:12.3,h:1, fontSize:10, color:PAL.text, align:'right', italic:true, rtlMode:true, fontFace:PPTX_FONT });
    }

    pres.writeFile({ fileName: `${rec.id}-IC-Presentation.pptx` });
  }catch(e){
    alert('تعذّر تصدير عرض لجنة الاستثمار: '+e.message+'\nافتح رابط الأداة مباشرة في تبويب متصفح جديد (وليس داخل نافذة المعاينة) ثم أعد المحاولة.');
  }
}
