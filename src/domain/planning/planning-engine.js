/* Canonical deterministic planning-feasibility domain engine. */

export function planningFeasibility(d, c){
  const land = (d && d.land) || {};
  const allowedFloors = Number(land.floorsAllowed || 0);
  const setback = Math.max(0, Math.min(0.8, Number(land.setbacks || 0)));
  const allowedFootprint = Number(land.area || 0) * Math.max(0, 1-setback) * Number(land.bar || 0);
  const requiredFloors = allowedFootprint>0 ? Math.ceil(((c && c.gfa) || 0)/allowedFootprint) : ((c && c.floorsNeeded) || 0);
  const floorsOk = !allowedFloors || !requiredFloors || requiredFloors<=allowedFloors;
  const footprintOk = allowedFootprint>0 || (d && d.meta && d.meta.oppType==='landbank');
  return { ok:floorsOk && footprintOk, allowedFloors, requiredFloors, setback, allowedFootprint };
}
