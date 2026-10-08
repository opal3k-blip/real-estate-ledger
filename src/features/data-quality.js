/* =========================================================================
   درجة جودة البيانات — Data Quality Score (Phase 1، النظام الرابع)
   ---------------------------------------------------------------------------
   نسبة اكتمال المدخلات الحرجة لكل فرصة (هل أُدخلت الأرقام أصلاً؟) — منفصلة
   تماماً عن "العناية الواجبة" (هل تحقّقنا من صحة الأرقام؟).

   Phase 2R-4B — Client Cutover: هذا الملف أصبح UI wrapper فقط. الحساب
   الحتمي (deterministic) الحقيقي أصبح في src/domain/data-quality/
   data-quality-engine.js (الجهة الرسمية الوحيدة له، بعد إثبات تطابقه
   Shadow-Mode في Phase 2R-4A — 17/17). لا تغيير في أسماء أو توقيعات
   الدوال المُصدَّرة هنا حتى لا تنكسر ملفات الاستيراد الحالية
   (ai-analyst.js, ic-workflow.js, decision-confidence.js,
   ic-decision-gate.js, ...). لا تعديل على منطق core.js الداخلي.
   ========================================================================= */
import {
  dataQualityStats as domainDataQualityStats,
  fieldsFor as domainFieldsFor,
  isFilled as domainIsFilled,
} from '../domain/data-quality/data-quality-engine.js';

/* توقيع قديم (core, d) يبقى كما هو للمستوردين الحاليين؛ core لم تعد
   مُستخدَمة فعلياً (الحساب لا يعتمد على واجهة core) لكنها تبقى في
   التوقيع للتوافق الخلفي فقط. */
function dataQualityStats(core, d){
  return domainDataQualityStats(d);
}
function fieldsFor(oppType){
  return domainFieldsFor(oppType);
}
function isFilled(v){
  return domainIsFilled(v);
}

export function registerDataQuality(core){
  // زر شريط علوي إعلامي فقط — يفتح لوحة خط الأنابيب لو رغب المستخدم بمراجعة كل الفرص (لا حاجة لعرض مستقل خاص به هنا).

  core.registerDetailSection((d, c)=>{
    const oppId = core.openDetailId;
    const rec = core.opportunities.find(o=>o.id===oppId);
    if(!rec) return '';
    const stats = dataQualityStats(core, d);
    const pctStr = core.LANG==='en' ? (stats.pct*100).toFixed(0)+'%' : '%'+(stats.pct*100).toFixed(0);
    const color = stats.criticalMissing.length>0 ? 'var(--bad)' : (stats.pct>=0.9? 'var(--good)' : 'var(--gold)');

    return `
    <div class="section">
      <h3>🧪 ${core.T('جودة البيانات','Data Quality')} <span style="color:var(--ink-faint); font-weight:500; font-size:12px;">(Data Quality Score)</span></h3>
      <div class="kv" style="margin-bottom:10px;">
        <div class="k">${core.T('نسبة اكتمال المدخلات','Input Completeness')}</div><div class="v"><b style="color:${color};">${pctStr}</b> (${stats.filled}/${stats.total})</div>
      </div>
      <div style="height:8px; background:var(--surface-2); border-radius:5px; overflow:hidden; margin-bottom:10px;">
        <div style="height:100%; width:${(stats.pct*100).toFixed(1)}%; background:${color};"></div>
      </div>
      ${stats.criticalMissing.length>0? `
      <p class="note" style="color:var(--bad); margin:0 0 8px;">🚫 ${core.T('لا تُرفع هذه الفرصة للجنة الاستثمار — يوجد','Do not submit this opportunity to the IC —')} ${stats.criticalMissing.length} ${core.T('مُدخل حرج مفقود:','critical input(s) missing:')}</p>
      <ul style="margin:0; padding-inline-start:20px; display:flex; flex-direction:column; gap:3px;">
        ${stats.criticalMissing.map(f=>`<li style="font-size:12px; color:var(--bad);">${core.T(f.ar,f.en)}</li>`).join('')}
      </ul>` : `<p class="note" style="color:var(--good);">✅ ${core.T('جميع المدخلات الحرجة مكتملة.','All critical inputs are complete.')}</p>`}
    </div>`;
  });
}

export { dataQualityStats, fieldsFor, isFilled };
