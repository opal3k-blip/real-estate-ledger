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

// Evidence dates are date-only (YYYY-MM-DD). They are read as midnight in a FIXED Riyadh offset (UTC+3, no DST), not in the
// runtime's local zone: parsing as local midnight made the same evidence stale in a Riyadh browser and fresh on a UTC server near
// the 730-day boundary. The fixed offset keeps the day boundary Riyadh users already see and makes browser and server agree.
// Only the zone handling differs from the previous `new Date(date+'T00:00:00')`: the accepted shapes are the same (month 1-12,
// day 1-31, day overflow rolls over, anything else is NaN), and years 0000-0099 are read literally (setUTCFullYear, not Date.UTC).
const RIYADH_OFFSET_MS = 3 * 3600000;
function evidenceDateMs(s){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if(!m) return NaN;
  const mo = +m[2], da = +m[3];
  if(mo < 1 || mo > 12 || da < 1 || da > 31) return NaN;
  const d = new Date(0);
  d.setUTCFullYear(+m[1], mo-1, da);
  return d.getTime() - RIYADH_OFFSET_MS;
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
      const ageDays = Math.floor((nowMs - evidenceDateMs(ev.date))/86400000);
      if(isFinite(ageDays) && ageDays>730) stale.push(f);
    }
  });
  return { weak, stale };
}
