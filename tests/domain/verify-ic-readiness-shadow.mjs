import assert from 'assert/strict';
import { loadCore } from './core-vm-harness.mjs';
import { icReadiness as legacyIcReadiness } from '../../src/features/ic-decision-gate.js';
import { ddStats as legacyDdStats, defaultItemsDict as legacyDefaultItemsDict } from '../../src/features/due-diligence.js';
import { dataQualityStats as legacyDataQualityStats } from '../../src/features/data-quality.js';
import { evidenceCoverageStats as legacyEvidenceCoverageStats, KEY_FIELDS as LEGACY_KEY_FIELDS } from '../../src/features/evidence-tracking.js';
import { maxAcquisitionPrice as legacyMaxAcquisitionPrice } from '../../src/features/max-acquisition-price.js';

import { icReadiness as domainIcReadiness } from '../../src/domain/ic/ic-readiness-engine.js';
import { ddStats as domainDdStats } from '../../src/domain/due-diligence/dd-engine.js';
import { dataQualityStats as domainDataQualityStats } from '../../src/domain/data-quality/data-quality-engine.js';
import { evidenceCoverageStats as domainEvidenceCoverageStats } from '../../src/domain/evidence/evidence-engine.js';
import { maxAcquisitionPrice as domainMaxAcquisitionPrice } from '../../src/domain/financial/max-acquisition-price.js';

const C = loadCore();
const ABS = 1e-12;
const REL = 1e-12;

function set(o,path,value){
  const parts=path.split('.');
  let cur=o;
  for(let i=0;i<parts.length-1;i++){
    if(!cur[parts[i]] || typeof cur[parts[i]]!=='object') cur[parts[i]]={};
    cur=cur[parts[i]];
  }
  cur[parts.at(-1)]=value;
}
function clone(v){ return JSON.parse(JSON.stringify(v)); }
function approx(a,b,label){
  assert.equal(typeof a, typeof b, `${label}: type drift`);
  if(typeof a!=='number'){ assert.deepStrictEqual(a,b,label); return; }
  if(!Number.isFinite(a) || !Number.isFinite(b)){ assert.deepStrictEqual(a,b,label); return; }
  const scale=Math.max(1,Math.abs(a),Math.abs(b));
  assert.ok(Math.abs(a-b)<=Math.max(ABS,REL*scale), `${label}: ${a} != ${b}`);
}
function compareObject(actual, expected, path='root'){
  if(typeof actual==='number' || typeof expected==='number'){ approx(actual,expected,path); return; }
  if(Array.isArray(actual) || Array.isArray(expected)){
    assert.ok(Array.isArray(actual)&&Array.isArray(expected), `${path}: array drift`);
    assert.equal(actual.length,expected.length,`${path}: length drift`);
    actual.forEach((v,i)=>compareObject(v,expected[i],`${path}[${i}]`));
    return;
  }
  if(actual && expected && typeof actual==='object' && typeof expected==='object'){
    const ak=Object.keys(actual).sort(), ek=Object.keys(expected).sort();
    assert.deepStrictEqual(ak,ek,`${path}: keys drift`);
    ak.forEach(k=>compareObject(actual[k],expected[k],`${path}.${k}`));
    return;
  }
  assert.deepStrictEqual(actual,expected,path);
}

function readyDevelopment(){
  const o=clone(C.blankOpportunity());
  set(o,'meta.name','Ready Development');
  set(o,'meta.city','Riyadh');
  set(o,'meta.neighborhood','Test');
  set(o,'meta.analyst','Analyst');
  set(o,'meta.oppType','development');
  set(o,'meta.tier','متوسط');
  set(o,'meta.useType','__neutral__');
  for(const k of ['soil','water','tower','topo','infra']) set(o,`site.${k}`,1);
  set(o,'land.area',5000); set(o,'land.price',2000); set(o,'land.far',2); set(o,'land.bar',0.5);
  set(o,'land.setbacks',0.15); set(o,'land.floorsAllowed',10); set(o,'land.floorHeight',3.6);
  set(o,'development.salePrice',9000); set(o,'development.buildCost',3000); set(o,'development.efficiency',0.85);
  set(o,'development.contingency',0.05); set(o,'development.constructionYears',2); set(o,'development.operationYears',1);
  set(o,'development.scopeType','both'); set(o,'development.exitCapRate',0.08);
  set(o,'strategy.salePct',1);
  set(o,'financing.ltc',0.5); set(o,'financing.saibor',0.05); set(o,'financing.margin',0.02);
  set(o,'regulatory.offeringType','private');
  set(o,'criteria.irrMin',0.05); set(o,'criteria.projIrrMin',-1); set(o,'criteria.moicMin',0); set(o,'criteria.dscrMin',null);

  const items=legacyDefaultItemsDict();
  Object.values(items).forEach(it=>{ it.status='completed'; it.severity='medium'; });
  set(o,'dd.items',items);

  const evidence={};
  LEGACY_KEY_FIELDS.filter(f=>!f.appliesTo || f.appliesTo==='development').forEach(f=>{
    evidence[f.path]={ source:'test-source', tier:'tier1', confidence:'high', verifiedBy:'ic@example.com', date:'2099-01-01' };
  });
  set(o,'evidence',evidence);
  return o;
}

const fixtures=[
  ['R01-ready',()=>{}],
  ['R02-equity-irr',o=>set(o,'criteria.irrMin',0.30)],
  ['R03-project-irr',o=>set(o,'criteria.projIrrMin',0.30)],
  ['R04-moic',o=>set(o,'criteria.moicMin',2.0)],
  ['R05-dscr',o=>set(o,'criteria.dscrMin',1.20)],
  ['R06-dd-critical',o=>{ o.dd.items.legal_title.status='pending'; o.dd.items.legal_title.severity='critical'; }],
  ['R07-dd-completion',o=>{ ['legal_title','legal_liens','technical_survey','technical_soil'].forEach(k=>{o.dd.items[k].status='pending';o.dd.items[k].severity='medium';}); }],
  ['R08-dq-critical',o=>set(o,'meta.city','')],
  ['R09-dq-completion',o=>{set(o,'meta.neighborhood','');set(o,'meta.analyst','');set(o,'regulatory.offeringType','');}],
  ['R10-evidence-critical-unsourced',o=>{delete o.evidence['land.price'];}],
  ['R11-evidence-coverage',o=>{delete o.evidence['land.far'];delete o.evidence['financing.saibor'];}],
  ['R12-evidence-verification',o=>{for(const p of ['land.far','financing.saibor','financing.margin']) o.evidence[p].verifiedBy=null;}],
  ['R13-evidence-weak',o=>{o.evidence['land.price'].tier='tier4';}],
  ['R14-evidence-stale',o=>{o.evidence['land.price'].date='2020-01-01';}],
  ['R15-planning',o=>set(o,'land.floorsAllowed',2)],
  ['R16-pricing-above-max',o=>set(o,'land.price',4500)],
  ['R17-pricing-infeasible',o=>set(o,'criteria.irrMin',0.50)],
];

function legacyReasonCode(r){
  const en=String(r && r.en || '');
  if(en.startsWith('Equity IRR below minimum')) return 'FIN_EQUITY_IRR_BELOW_MIN';
  if(en.startsWith('Project IRR below minimum')) return 'FIN_PROJECT_IRR_BELOW_MIN';
  if(en.startsWith('MOIC below minimum')) return 'FIN_MOIC_BELOW_MIN';
  if(en.startsWith('DSCR below minimum')) return 'FIN_DSCR_BELOW_MIN';
  if(en.includes('critical DD item(s) still pending')) return 'DD_CRITICAL_PENDING';
  if(en.startsWith('DD completion ')) return 'DD_COMPLETION_BELOW_MIN';
  if(en.includes('critical field(s) not entered')) return 'DQ_CRITICAL_MISSING';
  if(en.startsWith('Data quality ')) return 'DQ_COMPLETION_BELOW_MIN';
  if(en.includes('critical figure(s) unsourced')) return 'EVIDENCE_CRITICAL_UNSOURCED';
  if(en.startsWith('Source coverage ')) return 'EVIDENCE_COVERAGE_BELOW_MIN';
  if(en.startsWith('Evidence verification ')) return 'EVIDENCE_VERIFICATION_BELOW_MIN';
  if(en.includes('critical evidence item(s) are weak or unverified')) return 'EVIDENCE_WEAK';
  if(en.includes('critical evidence item(s) are stale')) return 'EVIDENCE_STALE';
  if(en.startsWith('Planning feasibility failed:')) return 'PLANNING_INFEASIBLE';
  if(en.startsWith('Even at zero land cost,')) return 'PRICING_INFEASIBLE_AT_ZERO';
  if(en==='Current price exceeds max acquisition price') return 'PRICING_ABOVE_MAX';
  throw new Error(`Unmapped legacy reason: ${en}`);
}

function comparableLegacyGate(g){
  return {
    ready:g.ready,
    financial:{ok:g.gates.financial.ok,checks:g.gates.financial.checks.map(x=>({label:x.label,ok:x.ok}))},
    dd:g.gates.dd,
    governance:g.gates.governance,
    planning:g.gates.planning,
    pricing:g.gates.pricing,
    reasonCodes:g.reasons.map(legacyReasonCode),
    reasonGates:g.reasons.map(r=>r.gate),
  };
}
function comparableDomainGate(g){
  return {
    ready:g.ready,
    financial:{ok:g.gates.financial.ok,checks:g.gates.financial.checks.map(x=>({label:x.label,ok:x.ok}))},
    dd:g.gates.dd,
    governance:g.gates.governance,
    planning:g.gates.planning,
    pricing:g.gates.pricing,
    reasonCodes:g.reasons.map(r=>r.code),
    reasonGates:g.reasons.map(r=>r.gate),
  };
}

let passed=0;
for(const [id,mutate] of fixtures){
  const d=readyDevelopment(); mutate(d);
  const c=C.compute(d);

  compareObject(domainDdStats((d.dd&&d.dd.items)||{}), legacyDdStats((d.dd&&d.dd.items)||{}), `${id}.ddStats`);
  compareObject(domainDataQualityStats(d), legacyDataQualityStats(C,d), `${id}.dataQuality`);
  compareObject(domainEvidenceCoverageStats(d), legacyEvidenceCoverageStats(C,d), `${id}.evidence`);
  compareObject(domainMaxAcquisitionPrice(C.compute,d,d.criteria.irrMin), legacyMaxAcquisitionPrice(C,d,d.criteria.irrMin), `${id}.pricing`);

  const legacy=legacyIcReadiness(C,d,c);
  const domain=domainIcReadiness(C.compute,d,c);
  compareObject(comparableDomainGate(domain),comparableLegacyGate(legacy),`${id}.icReadiness`);
  for(const reason of domain.reasons){
    assert.equal(typeof reason.gate,'string',`${id}: structured reason gate`);
    assert.equal(typeof reason.code,'string',`${id}: structured reason code`);
    assert.ok(reason.params && typeof reason.params==='object',`${id}: structured reason params`);
  }
  passed++;
  console.log(`OK  ${id}: domain IC readiness shadow-reconciles current feature semantics.`);
}
console.log(`\n${passed}/${fixtures.length} fixtures: Phase 2R-4A DD/Data Quality/Evidence/Planning/Pricing/IC domain engines shadow-reconcile current feature semantics.`);
