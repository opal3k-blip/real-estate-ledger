/* Canonical deterministic Data Quality domain engine. */

export const FIELD_DEFS = [
  { path:'meta.name',              ar:'اسم الفرصة',               en:'Opportunity name',        critical:true,  appliesTo:null },
  { path:'meta.city',              ar:'المدينة',                   en:'City',                     critical:true,  appliesTo:null },
  { path:'meta.neighborhood',      ar:'الحي',                      en:'Neighborhood',             critical:false, appliesTo:null },
  { path:'meta.analyst',           ar:'المحلل المسؤول',            en:'Responsible analyst',      critical:false, appliesTo:null },
  { path:'land.area',              ar:'مساحة الأرض',               en:'Land area',                critical:true,  appliesTo:null },
  { path:'land.price',             ar:'سعر متر الأرض',             en:'Land price/m²',            critical:true,  appliesTo:null },
  { path:'land.far',               ar:'معامل البناء (FAR)',        en:'FAR',                      critical:true,  appliesTo:null },
  { path:'financing.ltc',          ar:'نسبة التمويل إلى التكلفة',  en:'Financing LTC',            critical:false, appliesTo:null },
  { path:'financing.saibor',       ar:'السايبور',                  en:'SAIBOR',                   critical:false, appliesTo:null },
  { path:'financing.margin',       ar:'هامش البنك',                en:'Bank margin',               critical:false, appliesTo:null },
  { path:'regulatory.offeringType',ar:'نوع الطرح',                 en:'Offering type',             critical:false, appliesTo:null },
  { path:'income.rent',            ar:'الإيجار السنوي/م²',         en:'Annual rent/m²',            critical:true,  appliesTo:'income' },
  { path:'income.occupancy',       ar:'نسبة الإشغال',              en:'Occupancy',                 critical:true,  appliesTo:'income' },
  { path:'development.salePrice',  ar:'سعر البيع المتوقع/م²',      en:'Expected sale price/m²',    critical:true,  appliesTo:'development' },
  { path:'development.buildCost',  ar:'تكلفة البناء/م²',           en:'Build cost/m²',             critical:true,  appliesTo:'development' },
  { path:'development.constructionYears', ar:'مدة الإنشاء',        en:'Construction duration',     critical:false, appliesTo:'development' },
  { path:'landbank.appreciation',  ar:'معدل نمو قيمة الأرض',       en:'Land appreciation rate',    critical:true,  appliesTo:'landbank' },
  { path:'landbank.holdingYears',  ar:'مدة الاحتفاظ',              en:'Holding period',             critical:false, appliesTo:'landbank' },
];

export function getPathValue(obj, path){
  return String(path||'').split('.').reduce((cur, key)=>cur==null ? undefined : cur[key], obj);
}

export function isFilled(v){
  if(v==null) return false;
  if(typeof v==='string') return v.trim()!=='';
  if(typeof v==='number') return isFinite(v) && v>0;
  return !!v;
}

export function fieldsFor(oppType){
  return FIELD_DEFS.filter(f=>f.appliesTo===null || f.appliesTo===oppType);
}

export function dataQualityStats(d){
  const fields = fieldsFor(d && d.meta && d.meta.oppType);
  let filled = 0;
  const criticalMissing = [];
  fields.forEach(f=>{
    const v = getPathValue(d, f.path);
    if(isFilled(v)) filled++;
    else if(f.critical) criticalMissing.push(f);
  });
  return { total:fields.length, filled, pct:fields.length ? filled/fields.length : 0, criticalMissing, fields };
}
