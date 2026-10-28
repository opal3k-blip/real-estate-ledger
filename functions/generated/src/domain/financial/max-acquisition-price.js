/* Canonical deterministic maximum-acquisition-price domain engine.
   It consumes the canonical financial compute function; it never reimplements economics. */

function metricsAtPrice(compute, d, price){
  const trial = JSON.parse(JSON.stringify(d));
  trial.land.price = price;
  try{
    const c = compute(trial);
    return { irr:c.equityIRR, dscr:c.dscrMin };
  }catch(_e){
    return { irr:-1, dscr:null };
  }
}

export function irrAtPrice(compute, d, price){
  return metricsAtPrice(compute, d, price).irr;
}

function feasibleAtPrice(compute, d, price, targetIRR, targetDSCR){
  const m = metricsAtPrice(compute, d, price);
  const irrOk = isFinite(m.irr) && m.irr>=targetIRR;
  const dscrOk = targetDSCR==null || m.dscr==null || !isFinite(m.dscr) || m.dscr>=targetDSCR;
  return irrOk && dscrOk;
}

export function maxAcquisitionPrice(compute, d, targetIRR, targetDSCR){
  if(typeof compute!=='function') throw new Error('maxAcquisitionPrice: compute function is required');
  targetIRR = targetIRR!=null ? targetIRR : (d.criteria.irrMin || 0.15);
  targetDSCR = targetDSCR!=null ? targetDSCR : (d.criteria.dscrMin!=null ? d.criteria.dscrMin : null);
  const currentPrice = d.land.price || 0;
  const curM = metricsAtPrice(compute, d, currentPrice);
  const currentIRR = curM.irr, currentDSCR = curM.dscr;

  if(!feasibleAtPrice(compute, d, 0, targetIRR, targetDSCR)){
    const zero = metricsAtPrice(compute, d, 0);
    const irrBlocks = !(isFinite(zero.irr) && zero.irr>=targetIRR);
    const dscrBlocks = targetDSCR!=null && zero.dscr!=null && isFinite(zero.dscr) && zero.dscr<targetDSCR;
    return { maxPrice:0, targetIRR, targetDSCR, currentPrice, currentIRR, currentDSCR, infeasible:true,
      bindingConstraint:(irrBlocks && dscrBlocks) ? 'both' : (dscrBlocks ? 'dscr' : 'irr') };
  }

  let lo = 0, hi = Math.max(currentPrice,100)*3;
  let guard = 0;
  while(feasibleAtPrice(compute,d,hi,targetIRR,targetDSCR) && guard<40){ hi*=1.6; guard++; }
  for(let i=0;i<50;i++){
    const mid = (lo+hi)/2;
    if(feasibleAtPrice(compute,d,mid,targetIRR,targetDSCR)) lo=mid; else hi=mid;
  }
  const atMax = metricsAtPrice(compute,d,lo);
  const irrSlack = isFinite(atMax.irr) ? (atMax.irr-targetIRR) : Infinity;
  const dscrSlack = (targetDSCR!=null && atMax.dscr!=null && isFinite(atMax.dscr)) ? (atMax.dscr-targetDSCR) : Infinity;
  const bindingConstraint = dscrSlack<irrSlack ? 'dscr' : 'irr';
  return { maxPrice:lo, targetIRR, targetDSCR, currentPrice, currentIRR, currentDSCR, infeasible:false, bindingConstraint };
}
