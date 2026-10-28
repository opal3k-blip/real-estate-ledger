/* =========================================================================
   بوابة قرار لجنة الاستثمار — IC Decision Gate (المرحلة السابعة، P0 #2)
   ---------------------------------------------------------------------------
   "الـ IC يجب ألا يكون مجرد 'تسجيل قرار'" — هذا الملف يحوِّل صفحة اللجنة من
   نموذج تسجيل حرّ إلى بوابة جهوزية حقيقية بأربع بوابات فرعية (+بوابة التسعير
   = خمس)، تُركَّب كلها من نتائج محسوبة سلفاً.

   Phase 2R-4B — Client Cutover: القرار الحتمي الكامل (خمس بوابات + أسباب)
   أصبح من src/domain/ic/ic-readiness-engine.js وحده (الجهة الرسمية
   الوحيدة، بعد إثبات تطابقه Shadow-Mode في Phase 2R-4A — 17/17). لم يعد
   هناك أي implementation قرار مكرر هنا. هذا الملف مسؤول فقط عن:
     1) تمرير core.compute كدالة compute إلى الـdomain (بدل تمرير كائن core
        الكامل — الـdomain لا يعرف شيئاً عن واجهة core / المتصفح).
     2) ترجمة الأسباب البنيوية {gate, code, params} التي يُرجعها الـdomain
        إلى نصوص ثنائية اللغة {gate, ar, en} — لأن التنسيق/التوطين مسؤولية
        UI بتصميم صريح موثَّق في Phase 2R-4A، ويجب أن يبقى مطابقاً حرفياً
        للنصوص القديمة (نفس السجل يُخزَّن في ic.decisions عند التجاوز —
        انظر ic-workflow.js).
   icReadiness(core, d, c) تبقى بنفس التوقيع والشكل المُرجَع تماماً
   (ready/gates/reasons) للتوافق الخلفي مع ic-workflow.js و
   institutional-investment-intelligence.js. لا تغيير في semantics
   الجهوزية نفسها — هذه مرحلة authority/cutover فقط.
   ========================================================================= */
import { icReadiness as domainIcReadiness } from '../domain/ic/ic-readiness-engine.js';

// جدول ترجمة: كود سبب بنيوي من الـdomain → نص عربي/إنجليزي مطابق حرفياً
// لما كان يُنتجه هذا الملف قبل الـcutover. أي كود غير معروف هنا يُترجَم
// كنص احتياطي (fail-safe) بدل إسقاطه بصمت — تماشياً مع مبدأ "Invalid
// economics/state يجب ألا تُحسَب أو تُعرَض بصمت".
const FIN_LABEL = { equityIRR:'Equity IRR', projectIRR:'Project IRR', moic:'MOIC', dscr:'DSCR' };
function finDetail(core, key, actual, minimum){
  if(key==='moic') return `${isFinite(actual)?actual.toFixed(2)+'×':'—'} / min ${minimum!=null?minimum.toFixed(2)+'×':'—'}`;
  if(key==='dscr') return actual==null ? 'n/a' : `${isFinite(actual)?actual.toFixed(2)+'×':'—'} / min ${minimum!=null?minimum.toFixed(2)+'×':'—'}`;
  return `${core.fmtPct?core.fmtPct(actual):actual} / min ${minimum!=null?(core.fmtPct?core.fmtPct(minimum):minimum):'—'}`;
}
const FIN_CODE_TO_KEY = { FIN_EQUITY_IRR_BELOW_MIN:'equityIRR', FIN_PROJECT_IRR_BELOW_MIN:'projectIRR', FIN_MOIC_BELOW_MIN:'moic', FIN_DSCR_BELOW_MIN:'dscr' };

const REASON_TEXT = {
  FIN_EQUITY_IRR_BELOW_MIN: (core,p)=>{ const detail = finDetail(core,'equityIRR',p.actual,p.minimum); return { ar:`Equity IRR دون الحد الأدنى (${detail})`, en:`Equity IRR below minimum (${detail})` }; },
  FIN_PROJECT_IRR_BELOW_MIN: (core,p)=>{ const detail = finDetail(core,'projectIRR',p.actual,p.minimum); return { ar:`Project IRR دون الحد الأدنى (${detail})`, en:`Project IRR below minimum (${detail})` }; },
  FIN_MOIC_BELOW_MIN: (core,p)=>{ const detail = finDetail(core,'moic',p.actual,p.minimum); return { ar:`MOIC دون الحد الأدنى (${detail})`, en:`MOIC below minimum (${detail})` }; },
  FIN_DSCR_BELOW_MIN: (core,p)=>{ const detail = finDetail(core,'dscr',p.actual,p.minimum); return { ar:`DSCR دون الحد الأدنى (${detail})`, en:`DSCR below minimum (${detail})` }; },
  DD_CRITICAL_PENDING: (core,p)=>({ ar:`${p.count} بند حرج معلّق في العناية الواجبة`, en:`${p.count} critical DD item(s) still pending` }),
  DD_COMPLETION_BELOW_MIN: (core,p)=>({ ar:`اكتمال العناية الواجبة ${Math.round(p.pct*100)}% دون الحد ${Math.round(p.minimum*100)}%`, en:`DD completion ${Math.round(p.pct*100)}% below ${Math.round(p.minimum*100)}% threshold` }),
  DQ_CRITICAL_MISSING: (core,p)=>({ ar:`${p.count} حقل حرج غير مُدخَل`, en:`${p.count} critical field(s) not entered` }),
  DQ_COMPLETION_BELOW_MIN: (core,p)=>({ ar:`جودة البيانات ${Math.round(p.pct*100)}% دون الحد ${Math.round(p.minimum*100)}%`, en:`Data quality ${Math.round(p.pct*100)}% below ${Math.round(p.minimum*100)}% threshold` }),
  EVIDENCE_CRITICAL_UNSOURCED: (core,p)=>({ ar:`${p.count} رقماً حرجاً بلا مصدر (🔴 IC BLOCKER)`, en:`${p.count} critical figure(s) unsourced (🔴 IC BLOCKER)` }),
  EVIDENCE_COVERAGE_BELOW_MIN: (core,p)=>({ ar:`تغطية المصادر ${Math.round(p.pct*100)}% دون الحد ${Math.round(p.minimum*100)}%`, en:`Source coverage ${Math.round(p.pct*100)}% below ${Math.round(p.minimum*100)}% threshold` }),
  EVIDENCE_VERIFICATION_BELOW_MIN: (core,p)=>({ ar:`تحقق الأدلة ${Math.round(p.pct*100)}% دون الحد ${Math.round(p.minimum*100)}%`, en:`Evidence verification ${Math.round(p.pct*100)}% below ${Math.round(p.minimum*100)}% threshold` }),
  EVIDENCE_WEAK: (core,p)=>({ ar:`${p.count} دليل حرج ضعيف الجودة/غير محقق`, en:`${p.count} critical evidence item(s) are weak or unverified` }),
  EVIDENCE_STALE: (core,p)=>({ ar:`${p.count} دليل حرج قديم يحتاج تحديث`, en:`${p.count} critical evidence item(s) are stale` }),
  PLANNING_INFEASIBLE: (core,p)=>({
    ar:`الاشتراطات التخطيطية غير متحققة: مطلوب ${p.requiredFloors} دور مقابل مسموح ${p.allowedFloors || '—'}، وبصمة مسموحة بعد الارتدادات ${Math.round(p.allowedFootprint||0)} م²`,
    en:`Planning feasibility failed: requires ${p.requiredFloors} floors vs allowed ${p.allowedFloors || '—'}, allowed footprint after setbacks ${Math.round(p.allowedFootprint||0)} sqm`,
  }),
  PRICING_INFEASIBLE_AT_ZERO: (core,p)=>({
    ar:`حتى بأرض مجانية لا تتحقق Equity IRR ≥ ${core.fmtPct?core.fmtPct(p.targetIRR):p.targetIRR}`,
    en:`Even at zero land cost, target Equity IRR is not reached`,
  }),
  PRICING_ABOVE_MAX: (core,p)=>({
    ar:`السعر الحالي (${core.fmtSAR?core.fmtSAR(p.currentPrice):p.currentPrice}) يتجاوز الحد الأقصى للاستحواذ (${core.fmtSAR?core.fmtSAR(p.maxPrice):p.maxPrice})`,
    en:`Current price exceeds max acquisition price`,
  }),
};

/* icReadiness(core, d, c) — c اختيارية (core.compute(d) لو لم تُمرَّر، لتفادي
   إعادة الحساب لو استُدعيت من مكان يملكه أصلاً). لا تُعدِّل أي شيء، تقرأ فقط.
   تُرجع: { ready, gates:{financial,dd,governance,planning,pricing}، reasons:[{gate,ar,en}] } */
export function icReadiness(core, d, c){
  c = c || core.compute(d);
  const res = domainIcReadiness(core.compute.bind(core), d, c);
  return formatICReadiness(core, res);
}

// Presentation only; also used by the trusted server for historical bilingual reasons.
export function formatICReadiness(core, res){

  // gates.financial.checks: الـdomain يُرجع {key,label,actual,minimum,ok} —
  // نعيد بناء نص "detail" المُنسَّق محلياً (UI) بينما .ok يبقى من الـdomain
  // (الجهة الحاكمة الوحيدة على القرار).
  const checks = res.gates.financial.checks.map(x=>({
    label: FIN_LABEL[x.key] || x.label,
    ok: x.ok,
    detail: finDetail(core, x.key, x.actual, x.minimum),
  }));
  const gates = { ...res.gates, financial: { ok: res.gates.financial.ok, checks } };

  const reasons = res.reasons.map(r=>{
    const tpl = REASON_TEXT[r.code];
    if(!tpl){
      // fail-safe: سبب غير مُترجَم لا يُسقَط بصمت أبداً — يُعرَض الكود خامًا
      // ليبقى مرئياً بدل أن يختفي القرار وراءه بلا تفسير.
      return { gate: r.gate, ar: r.code, en: r.code };
    }
    const t = tpl(core, r.params || {});
    return { gate: r.gate, ar: t.ar, en: t.en };
  });

  return { ready: res.ready, gates, reasons };
}

function gateRow(core, label, g){
  return `<tr>
    <td style="font-size:12.5px; font-weight:600;">${label}</td>
    <td>${g.ok
      ? `<span class="tag" style="background:#34d39922; color:#34d399; font-weight:700;">✅ ${core.T('جاهزة','Pass')}</span>`
      : `<span class="tag" style="background:#ef444422; color:#ef4444; font-weight:700;">🔴 ${core.T('غير جاهزة','Fail')}</span>`}</td>
  </tr>`;
}

export function registerICDecisionGate(core){
  core.registerDetailSection((d, c)=>{
    const res = icReadiness(core, d, c);
    const gates = res.gates;

    const reasonsList = res.reasons.length
      ? `<ul style="margin:8px 0 0; padding-inline-start:20px; font-size:12px;">${res.reasons.map(r=>`<li style="margin-bottom:4px;">${core.T(r.ar,r.en)}</li>`).join('')}</ul>`
      : '';

    return `
    <div class="section">
      <h3>🚦 ${core.T('بوابة قرار لجنة الاستثمار','IC Decision Gate')} <span style="color:var(--ink-faint); font-weight:500; font-size:12px;">(IC Readiness)</span></h3>
      <div style="margin:6px 0 14px;">
        ${res.ready
          ? `<span class="tag" style="background:#34d39922; color:#34d399; font-weight:700; font-size:13px; padding:6px 12px;">✅ IC READY</span>`
          : `<span class="tag" style="background:#ef444422; color:#ef4444; font-weight:700; font-size:13px; padding:6px 12px;">🔴 NOT READY</span>`}
      </div>
      <div class="tablewrap"><table class="db" style="font-size:12px;">
        <thead><tr><th>${core.T('البوابة','Gate')}</th><th>${core.T('الحالة','Status')}</th></tr></thead>
        <tbody>
          ${gateRow(core, core.T('البوابة المالية (IRR/MOIC/DSCR)','Financial (IRR/MOIC/DSCR)'), gates.financial)}
          ${gateRow(core, core.T('العناية الواجبة (بلا بنود حرجة معلّقة)','Due Diligence (no critical pending)'), gates.dd)}
          ${gateRow(core, core.T('الحوكمة (جودة بيانات + جودة/تحقق الأدلة)','Governance (data quality + evidence quality/verification)'), gates.governance)}
          ${gateRow(core, core.T('التخطيط (الأدوار والارتدادات والبصمة)','Planning (floors, setbacks, footprint)'), gates.planning)}
          ${gateRow(core, core.T('التسعير (السعر ≤ الحد الأقصى للاستحواذ)','Pricing (price ≤ max acquisition price)'), gates.pricing)}
        </tbody>
      </table></div>
      ${!res.ready? `<div class="note" style="margin-top:10px; color:var(--bad);">${core.T('أسباب عدم الجهوزية:','Reasons not ready:')}${reasonsList}</div>` : `<p class="note" style="margin-top:10px; color:var(--good);">${core.T('كل البوابات الأربع مُستوفاة — الفرصة جاهزة تقنياً للعرض على اللجنة.','All four gates satisfied — technically ready for IC submission.')}</p>`}
    </div>`;
  });
}
