/* Canonical deterministic Due Diligence domain engine.
   UI registration/rendering remains in src/features/due-diligence.js. */

export const DD_CATEGORIES = [
  { key:'legal',         ar:'قانونية',   en:'Legal' },
  { key:'technical',     ar:'فنية',      en:'Technical' },
  { key:'planning',      ar:'تخطيطية',   en:'Planning' },
  { key:'valuation',     ar:'تقييم',     en:'Valuation' },
  { key:'market',        ar:'سوق',       en:'Market' },
  { key:'financial',     ar:'مالية',      en:'Financial' },
  { key:'tax',           ar:'ضريبية',    en:'Tax' },
  { key:'environmental', ar:'بيئية',     en:'Environmental' },
  { key:'financing',     ar:'تمويلية',   en:'Financing' },
  { key:'commercial',    ar:'تجارية',    en:'Commercial' },
];

export const DEFAULT_DD_ITEMS = [
  { key:'legal_title',           category:'legal',         ar:'التحقق من سند الملكية',                              en:'Verify title deed' },
  { key:'legal_liens',           category:'legal',         ar:'مراجعة القيود والرهون على الصك',                     en:'Review liens & encumbrances' },
  { key:'technical_survey',      category:'technical',     ar:'تقرير المساحة والحدود',                              en:'Survey & boundary report' },
  { key:'technical_soil',        category:'technical',     ar:'فحص التربة والأساسات',                               en:'Soil & foundation investigation' },
  { key:'planning_zoning',       category:'planning',      ar:'التحقق من نظام البناء والاشتراطات',                  en:'Verify zoning & building code' },
  { key:'planning_permit',       category:'planning',      ar:'رخصة البناء أو إمكانية الحصول عليها',                en:'Building permit / obtainability' },
  { key:'valuation_report',      category:'valuation',     ar:'تقرير تقييم مستقل معتمد',                            en:'Independent accredited valuation report' },
  { key:'market_study',          category:'market',        ar:'دراسة السوق والمقارنات',                              en:'Market study & comparables' },
  { key:'financial_model',       category:'financial',     ar:'مراجعة النموذج المالي والافتراضات',                  en:'Financial model & assumptions review' },
  { key:'tax_compliance',        category:'tax',           ar:'التحقق من الالتزامات الضريبية (تصرفات عقارية/قيمة مضافة)', en:'Verify tax obligations (RETT/VAT)' },
  { key:'environmental_impact',  category:'environmental', ar:'تقييم الأثر البيئي إن لزم',                           en:'Environmental impact assessment (if required)' },
  { key:'financing_termsheet',   category:'financing',     ar:'التحقق من شروط التمويل المبدئية (Term Sheet)',        en:'Verify preliminary financing term sheet' },
  { key:'commercial_contracts',  category:'commercial',    ar:'مراجعة العقود التجارية / عقود الإيجار القائمة',       en:'Review commercial/existing lease contracts' },
];

export function defaultItemsDict(){
  const out = {};
  DEFAULT_DD_ITEMS.forEach(it=>{
    out[it.key] = { status:'pending', document:'', reviewer:'', date:'', finding:'', severity:'medium', requiredAction:'' };
  });
  return out;
}

export function ddStats(items){
  const keys = DEFAULT_DD_ITEMS.map(it=>it.key);
  const total = keys.length;
  let completed = 0, criticalPending = 0;
  keys.forEach(k=>{
    const it = (items && items[k]) || {};
    if(it.status==='completed') completed++;
    if(it.severity==='critical' && it.status!=='completed') criticalPending++;
  });
  return { total, completed, pct: total ? completed/total : 0, criticalPending };
}
