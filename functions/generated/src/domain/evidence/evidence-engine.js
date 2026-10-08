/* Canonical deterministic Evidence domain engine. */

export const KEY_FIELDS = [
  { path:'land.price',              ar:'سعر متر الأرض',               en:'Land price/m²',           appliesTo:null,          fmt:'sar', critical:true  },
  { path:'land.far',                ar:'معامل البناء (FAR)',          en:'FAR',                     appliesTo:null,          fmt:'num', critical:false },
  { path:'financing.saibor',        ar:'السايبور',                    en:'SAIBOR',                  appliesTo:null,          fmt:'pct', critical:false },
  { path:'financing.margin',        ar:'هامش البنك',                  en:'Bank margin',             appliesTo:null,          fmt:'pct', critical:false },
  { path:'income.rent',             ar:'الإيجار السنوي/م²',           en:'Annual rent/m²',          appliesTo:'income',      fmt:'sar', critical:true  },
  { path:'income.occupancy',        ar:'نسبة الإشغال',                 en:'Occupancy',               appliesTo:'income',      fmt:'pct', critical:true  },
  { path:'wacc.marketCap',          ar:'معدل الرسملة عند الخروج',       en:'Exit cap rate',           appliesTo:'income',      fmt:'pct', critical:true  },
  { path:'development.salePrice',   ar:'سعر البيع المتوقع/م²',         en:'Expected sale price/m²',  appliesTo:'development', fmt:'sar', critical:true  },
  { path:'development.buildCost',   ar:'تكلفة البناء/م²',              en:'Build cost/m²',           appliesTo:'development', fmt:'sar', critical:true  },
  { path:'development.exitCapRate', ar:'معدل الرسملة عند الخروج',       en:'Exit cap rate',           appliesTo:'development', fmt:'pct', critical:false },
  { path:'landbank.appreciation',   ar:'معدل نمو قيمة الأرض',           en:'Land appreciation rate',  appliesTo:'landbank',    fmt:'pct', critical:false },
];

export function evidenceFieldsFor(oppType){
  return KEY_FIELDS.filter(f=>f.appliesTo===null || f.appliesTo===oppType);
}

export function evidenceCoverageStats(d){
  const evidence = (d && d.evidence) || {};
  const fields = evidenceFieldsFor(d && d.meta && d.meta.oppType);
  const sourced = [], unsourcedCritical = [], unsourcedMinor = [], verified = [];
  fields.forEach(f=>{
    const ev = evidence[f.path];
    const hasSource = !!(ev && ev.source);
    if(hasSource){
      sourced.push(f.path);
      if(ev.verifiedBy) verified.push(f.path);
    } else if(f.critical){
      unsourcedCritical.push(f);
    } else {
      unsourcedMinor.push(f);
    }
  });
  const total = fields.length;
  const pct = total ? Math.round((sourced.length/total)*100) : 100;
  const verifiedPct = total ? Math.round((verified.length/total)*100) : 100;
  return { total, sourcedCount:sourced.length, pct, verifiedCount:verified.length, verifiedPct, unsourcedCritical, unsourcedMinor };
}

export function evidenceQuality(d, nowMs = Date.now()){
  const evidence = (d && d.evidence) || {};
  const critical = KEY_FIELDS.filter(f=>f.critical && (!f.appliesTo || f.appliesTo===(d && d.meta && d.meta.oppType)));
  const weak = [];
  const stale = [];
  critical.forEach(f=>{
    const ev = evidence[f.path] || {};
    if(!ev.source) return;
    if(ev.tier==='tier4' || ev.confidence==='low' || !ev.verifiedBy) weak.push(f);
    if(ev.date){
      const ageDays = Math.floor((nowMs - new Date(ev.date+'T00:00:00').getTime())/86400000);
      if(isFinite(ageDays) && ageDays>730) stale.push(f);
    }
  });
  return { weak, stale };
}
