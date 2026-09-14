/* =========================================================================
   درجة جودة البيانات — Data Quality Score (Phase 1، النظام الرابع)
   ---------------------------------------------------------------------------
   نسبة اكتمال المدخلات الحرجة لكل فرصة (هل أُدخلت الأرقام أصلاً؟) — منفصلة
   تماماً عن "العناية الواجبة" (هل تحقّقنا من صحة الأرقام؟). قائمة حقول ثابتة
   (بعضها خاص بنوع الفرصة)، كل حقل إما "حرج" (يمنع الرفع للجنة الاستثمار عند
   غيابه) أو "مهم" فقط (يُخصم من النسبة لكن لا يمنع الرفع).
   قسم للقراءة فقط (لا نموذج تعديل هنا — يُعرَض تلقائياً من بيانات الفرصة
   نفسها بعد كل حفظ عبر المعالج العادي). لا تعديل على منطق core.js الداخلي.
   ========================================================================= */

function isFilled(v){
  if(v==null) return false;
  if(typeof v==='string') return v.trim()!=='';
  if(typeof v==='number') return isFinite(v) && v>0;
  return !!v;
}

/* appliesTo: null = كل الأنواع، وإلا 'income' | 'development' | 'landbank' فقط */
const FIELD_DEFS = [
  { path:'meta.name',              ar:'اسم الفرصة',               en:'Opportunity name',        critical:true,  appliesTo:null },
  { path:'meta.city',              ar:'المدينة',                   en:'City',                     critical:true,  appliesTo:null },
  { path:'meta.neighborhood',      ar:'الحي',                      en:'Neighborhood',             critical:false, appliesTo:null },
  { path:'meta.analyst',           ar:'المحلل المسؤول',            en:'Responsible analyst',      critical:false, appliesTo:null },
  { path:'land.area',              ar:'مساحة الأرض',               en:'Land area',                critical:true,  appliesTo:null },
  { path:'land.price',             ar:'سعر متر الأرض',             en:'Land price/m²',            critical:true,  appliesTo:null },
  { path:'land.far',               ar:'معامل البناء (FAR)',        en:'FAR',                      critical:true,  appliesTo:null },
  { path:'financing.ltc',          ar:'نسبة التمويل إلى التكلفة',  en:'Financing LTC',            critical:false, appliesTo:null },
  { path:'financing.saibor',       ar:'السايبور',                  en:'SAIBOR',                   critical:false, appliesTo:null },
  { path:'financing.margin',       ar:'هامش البنك',                en:'Bank margin',              critical:false, appliesTo:null },
  { path:'regulatory.offeringType',ar:'نوع الطرح',                 en:'Offering type',            critical:false, appliesTo:null },
  { path:'income.rent',            ar:'الإيجار السنوي/م²',         en:'Annual rent/m²',           critical:true,  appliesTo:'income' },
  { path:'income.occupancy',       ar:'نسبة الإشغال',              en:'Occupancy',                critical:true,  appliesTo:'income' },
  { path:'development.salePrice',  ar:'سعر البيع المتوقع/م²',      en:'Expected sale price/m²',   critical:true,  appliesTo:'development' },
  { path:'development.buildCost',  ar:'تكلفة البناء/م²',           en:'Build cost/m²',            critical:true,  appliesTo:'development' },
  { path:'development.constructionYears', ar:'مدة الإنشاء',        en:'Construction duration',    critical:false, appliesTo:'development' },
  { path:'landbank.appreciation',  ar:'معدل نمو قيمة الأرض',       en:'Land appreciation rate',   critical:true,  appliesTo:'landbank' },
  { path:'landbank.holdingYears',  ar:'مدة الاحتفاظ',              en:'Holding period',           critical:false, appliesTo:'landbank' },
];

function fieldsFor(oppType){
  return FIELD_DEFS.filter(f => f.appliesTo===null || f.appliesTo===oppType);
}

function dataQualityStats(core, d){
  const fields = fieldsFor(d.meta.oppType);
  let filled = 0, criticalMissing = [];
  fields.forEach(f=>{
    const v = core.getPath(d, f.path);
    if(isFilled(v)) filled++;
    else if(f.critical) criticalMissing.push(f);
  });
  return { total: fields.length, filled, pct: fields.length? filled/fields.length : 0, criticalMissing, fields };
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
