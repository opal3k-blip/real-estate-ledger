/* Canonical deterministic IC-readiness domain engine.
   Reasons are structured {gate, code, params}; presentation/localization stays outside domain. */
import { ddStats, defaultItemsDict } from '../due-diligence/dd-engine.js';
import { dataQualityStats } from '../data-quality/data-quality-engine.js';
import { evidenceCoverageStats, evidenceQuality } from '../evidence/evidence-engine.js';
import { planningFeasibility } from '../planning/planning-engine.js';
import { maxAcquisitionPrice } from '../financial/max-acquisition-price.js';

export const GOV_DATA_QUALITY_MIN = 0.85;
export const GOV_EVIDENCE_MIN = 0.80;
export const DD_COMPLETION_MIN = 0.80;
export const EVIDENCE_VERIFIED_MIN = 0.60;

function reason(gate, code, params={}){ return { gate, code, params }; }

export function icReadiness(compute, d, c, options={}){
  if(typeof compute!=='function') throw new Error('icReadiness: compute function is required');
  c = c || compute(d);
  const crit = d.criteria || {};
  const reasons = [];

  const finChecks = [
    { key:'equityIRR', label:'Equity IRR', actual:c.equityIRR, minimum:crit.irrMin,
      ok:isFinite(c.equityIRR) && crit.irrMin!=null && c.equityIRR>=crit.irrMin },
    { key:'projectIRR', label:'Project IRR', actual:c.projectIRR, minimum:crit.projIrrMin,
      ok:isFinite(c.projectIRR) && crit.projIrrMin!=null && c.projectIRR>=crit.projIrrMin },
    { key:'moic', label:'MOIC', actual:c.MOIC, minimum:crit.moicMin,
      ok:isFinite(c.MOIC) && crit.moicMin!=null && c.MOIC>=crit.moicMin },
    { key:'dscr', label:'DSCR', actual:c.dscrMin, minimum:crit.dscrMin,
      ok:(c.dscrMin==null) || (crit.dscrMin==null) || (isFinite(c.dscrMin) && c.dscrMin>=crit.dscrMin) },
  ];
  const financialOk = finChecks.every(x=>x.ok);
  const finReasonCodes = {
    equityIRR:'FIN_EQUITY_IRR_BELOW_MIN', projectIRR:'FIN_PROJECT_IRR_BELOW_MIN',
    moic:'FIN_MOIC_BELOW_MIN', dscr:'FIN_DSCR_BELOW_MIN',
  };
  finChecks.forEach(x=>{ if(!x.ok) reasons.push(reason('financial', finReasonCodes[x.key], { actual:x.actual, minimum:x.minimum })); });

  const dd = ddStats((d.dd && d.dd.items) || defaultItemsDict());
  const ddOk = dd.criticalPending===0 && dd.pct>=DD_COMPLETION_MIN;
  if(dd.criticalPending) reasons.push(reason('dd','DD_CRITICAL_PENDING',{ count:dd.criticalPending }));
  if(dd.pct<DD_COMPLETION_MIN) reasons.push(reason('dd','DD_COMPLETION_BELOW_MIN',{ pct:dd.pct, minimum:DD_COMPLETION_MIN }));

  const dq = dataQualityStats(d);
  const ev = evidenceCoverageStats(d);
  const evQuality = evidenceQuality(d, options.nowMs==null ? Date.now() : options.nowMs);
  const dqOk = dq.criticalMissing.length===0 && dq.pct>=GOV_DATA_QUALITY_MIN;
  const evOk = ev.unsourcedCritical.length===0 && (ev.pct/100)>=GOV_EVIDENCE_MIN && (ev.verifiedPct/100)>=EVIDENCE_VERIFIED_MIN && evQuality.weak.length===0 && evQuality.stale.length===0;
  const governanceOk = dqOk && evOk;
  if(dq.criticalMissing.length) reasons.push(reason('governance','DQ_CRITICAL_MISSING',{ count:dq.criticalMissing.length, paths:dq.criticalMissing.map(f=>f.path) }));
  else if(dq.pct<GOV_DATA_QUALITY_MIN) reasons.push(reason('governance','DQ_COMPLETION_BELOW_MIN',{ pct:dq.pct, minimum:GOV_DATA_QUALITY_MIN }));
  if(ev.unsourcedCritical.length) reasons.push(reason('governance','EVIDENCE_CRITICAL_UNSOURCED',{ count:ev.unsourcedCritical.length, paths:ev.unsourcedCritical.map(f=>f.path) }));
  else if((ev.pct/100)<GOV_EVIDENCE_MIN) reasons.push(reason('governance','EVIDENCE_COVERAGE_BELOW_MIN',{ pct:ev.pct/100, minimum:GOV_EVIDENCE_MIN }));
  if((ev.verifiedPct/100)<EVIDENCE_VERIFIED_MIN) reasons.push(reason('governance','EVIDENCE_VERIFICATION_BELOW_MIN',{ pct:ev.verifiedPct/100, minimum:EVIDENCE_VERIFIED_MIN }));
  if(evQuality.weak.length) reasons.push(reason('governance','EVIDENCE_WEAK',{ count:evQuality.weak.length, paths:evQuality.weak.map(f=>f.path) }));
  if(evQuality.stale.length) reasons.push(reason('governance','EVIDENCE_STALE',{ count:evQuality.stale.length, paths:evQuality.stale.map(f=>f.path) }));

  const planning = planningFeasibility(d,c);
  const planningOk = planning.ok;
  if(!planningOk) reasons.push(reason('planning','PLANNING_INFEASIBLE',{ allowedFloors:planning.allowedFloors, requiredFloors:planning.requiredFloors, allowedFootprint:planning.allowedFootprint }));

  const map = maxAcquisitionPrice(compute,d,crit.irrMin);
  const pricingOk = !map.infeasible && map.currentPrice<=map.maxPrice;
  if(map.infeasible) reasons.push(reason('pricing','PRICING_INFEASIBLE_AT_ZERO',{ targetIRR:map.targetIRR, targetDSCR:map.targetDSCR, bindingConstraint:map.bindingConstraint }));
  else if(!pricingOk) reasons.push(reason('pricing','PRICING_ABOVE_MAX',{ currentPrice:map.currentPrice, maxPrice:map.maxPrice }));

  const gates = {
    financial:{ ok:financialOk, checks:finChecks },
    dd:{ ok:ddOk, criticalPending:dd.criticalPending, pct:dd.pct },
    governance:{ ok:governanceOk, dataQualityPct:dq.pct, evidencePct:ev.pct/100, evidenceVerifiedPct:ev.verifiedPct/100,
      criticalMissing:dq.criticalMissing.length, unsourcedCritical:ev.unsourcedCritical.length, weakEvidence:evQuality.weak.length, staleEvidence:evQuality.stale.length },
    planning,
    pricing:{ ok:pricingOk, maxPrice:map.maxPrice, currentPrice:map.currentPrice, infeasible:map.infeasible },
  };
  const ready = financialOk && ddOk && governanceOk && planningOk && pricingOk;
  return { ready, gates, reasons };
}
