/* =========================================================================
   المذكرة التنفيذية الآلية — Automated IC Memo (Phase 3، النظام السابع)
   ---------------------------------------------------------------------------
   ملخص تنفيذي مُولَّد بالكامل آلياً (بلا كتابة يدوية) يظهر دائماً — على
   الشاشة وفي الطباعة/PDF على حدٍّ سواء (بخلاف قسم "محلل الاستثمار الآلي" في
   ai-analyst.js القابل للطي على الشاشة فقط) — يجمع: النص التحليلي المُركَّب
   (generateAnalystNarrative من ai-analyst.js، بلا أي تكرار منطقي)، جدول
   مقاييس رئيسي مضغوط، وحالة قرار لجنة الاستثمار الأحدث إن وُجد. هذا لا يستبدل
   إعادة هيكلة الطباعة الكاملة (٢١ قسماً) الموثَّقة في
   خطة_التقارير_والمهام_القادمة.md — تلك مهمة أوسع مؤجَّلة عمداً لما بعد
   اكتمال المرحلة ٣؛ هذا ملخص تنفيذي واحد يُضاف للمذكرة الحالية فوراً.
   يُسجَّل هذا الملف **أولاً** في main.js (قبل كل وحدات المرحلة ١/٢/٣ الأخرى)
   حتى يظهر الملخص التنفيذي في أعلى قسم الإضافات (بعد محتوى core.js الأساسي
   مباشرة، قبل بقية الأقسام الإضافية) — لا تعديل على منطق core.js الداخلي،
   فقط ترتيب التسجيل في main.js.
   ========================================================================= */

import { generateAnalystNarrative } from './ai-analyst.js';

export function registerAutomatedICMemo(core){
  core.registerDetailSection((d, c)=>{
    const { paras, scoreRes, band, decisionConfidence } = generateAnalystNarrative(core, d, c);
    const decisions = (d.ic && d.ic.decisions) || [];
    const latest = decisions.length? decisions[decisions.length-1] : null;
    const DEC_LABEL = { approve:['اعتماد','Approve'], approve_conditions:['اعتماد بشروط','Approve with Conditions'], revise:['مراجعة وإعادة عرض','Revise & Resubmit'], hold:['تعليق','Hold'], reject:['رفض','Reject'] };

    return `
    <div class="section">
      <h3>📄 ${core.T('الملخص التنفيذي الآلي','Automated Executive Summary')} <span style="color:var(--ink-faint); font-weight:500; font-size:12px;">(Automated IC Memo)</span></h3>
      <div class="kv" style="margin-bottom:12px;">
        <div class="k">${core.T('إجمالي تكلفة المشروع (TPC)','TPC')}</div><div class="v">${core.fmtSAR(c.TPC)}</div>
        <div class="k">${core.T('العائد الداخلي لحقوق الملكية (Equity IRR)','Equity IRR')}</div><div class="v" style="font-weight:700;">${isFinite(c.equityIRR)? core.fmtPct(c.equityIRR): '—'}</div>
        <div class="k">${core.T('مضاعف رأس المال (MOIC)','MOIC')}</div><div class="v" style="font-weight:700;">${isFinite(c.MOIC)? c.MOIC.toFixed(2)+'×': '—'}</div>
        <div class="k">DSCR (${core.T('أدنى','min')})</div><div class="v">${c.dscrMin!=null && isFinite(c.dscrMin)? c.dscrMin.toFixed(2)+'×': '—'}</div>
        <div class="k">${core.T('الدرجة الاستثمارية المركّبة','Composite Investment Score')}</div><div class="v"><b style="color:${band.color};">${scoreRes.composite.toFixed(0)}/100</b> — ${core.T(band.ar,band.en)}</div>
        <div class="k">${core.T('ثقة القرار','Decision Confidence')}</div><div class="v"><b style="color:${decisionConfidence.band.color};">${decisionConfidence.score.toFixed(0)}/100</b> — ${core.T(decisionConfidence.band.ar,decisionConfidence.band.en)}</div>
        <div class="k">${core.T('صافي القيمة الحالية (NPV)','NPV')}</div><div class="v">${isFinite(c.npvProject)? core.fmtSAR(c.npvProject): '—'}</div>
        <div class="k">${core.T('قرار اللجنة الأحدث','Latest IC Decision')}</div><div class="v">${latest? core.T(DEC_LABEL[latest.decision][0],DEC_LABEL[latest.decision][1]) : core.T('لم يُتخَذ قرار بعد','No decision yet')}</div>
      </div>
      <p class="note" style="margin:0 0 10px;">${core.T('التمييز مقصود: Investment Score يقيس جاذبية الفرصة وفق الافتراضات الحالية، بينما Decision Confidence يقيس قوة التوثيق والتحقق الداعمَين للقرار.','The distinction is intentional: Investment Score measures opportunity attractiveness under current assumptions, while Decision Confidence measures the strength of the supporting documentation and verification.')}</p>
      <div style="display:flex; flex-direction:column; gap:6px;">
        ${paras.map(p=>`<p style="margin:0; font-size:12px; line-height:1.85;">${core.esc(p)}</p>`).join('')}
      </div>
    </div>`;
  });
}
