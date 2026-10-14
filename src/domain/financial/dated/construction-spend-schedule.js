/* =========================================================================
   Explicit construction-spend schedule contract — Phase 3B-6
   -------------------------------------------------------------------------
   Transaction-grade construction timing MUST be supplied explicitly. This
   module never invents an S-curve, never normalizes malformed shares, and
   never consults the current date.

   Contract v1:
     {
       version: 'CONSTRUCTION_SPEND_V1',
       basis: 'HARD_COST_INCLUDING_CONTINGENCY',
       entries: [{ date:'YYYY-MM-DD', share:0.25 }, ...]
     }

   Shares are decimal fractions and must sum to exactly 1 within tolerance.
   Dates are absolute and must fall between acquisition and modeled construction
   completion. Duplicate dates are rejected because this is an aggregate spend
   schedule, not a work-package register.
   ========================================================================= */
import { isStrictIsoDate } from './financial-event.js';
import { requireAcquisitionDate, addMonthsClamped } from './timeline.js';

export const CONSTRUCTION_SPEND_SCHEDULE_VERSION='CONSTRUCTION_SPEND_V1';
export const CONSTRUCTION_SPEND_BASIS='HARD_COST_INCLUDING_CONTINGENCY';

const DEFAULT_TOLERANCE=1e-9;
function num(v){ return Number(v); }

export function normalizeConstructionSpendSchedule(schedule,{acquisitionDate,constructionYears,tolerance=DEFAULT_TOLERANCE}={}){
  requireAcquisitionDate(acquisitionDate);
  const years=num(constructionYears);
  if(!Number.isFinite(years) || years<0) throw new Error(`INVALID_CONSTRUCTION_YEARS:${constructionYears}`);
  if(!schedule || typeof schedule!=='object') throw new Error('MISSING_CONSTRUCTION_SPEND_SCHEDULE');
  if(schedule.version!==CONSTRUCTION_SPEND_SCHEDULE_VERSION) throw new Error(`UNSUPPORTED_CONSTRUCTION_SPEND_SCHEDULE_VERSION:${schedule.version}`);
  if(schedule.basis!==CONSTRUCTION_SPEND_BASIS) throw new Error(`UNSUPPORTED_CONSTRUCTION_SPEND_BASIS:${schedule.basis}`);
  if(!Array.isArray(schedule.entries) || schedule.entries.length===0) throw new Error('EMPTY_CONSTRUCTION_SPEND_SCHEDULE');

  const constructionMonths=Math.max(0,Math.round(years*12));
  const completionDate=addMonthsClamped(acquisitionDate,constructionMonths);
  const seen=new Set();
  const entries=schedule.entries.map((row,index)=>{
    if(!row || typeof row!=='object') throw new Error(`INVALID_CONSTRUCTION_SPEND_ENTRY:${index}`);
    const date=row.date;
    const share=num(row.share);
    if(!isStrictIsoDate(date)) throw new Error(`INVALID_CONSTRUCTION_SPEND_DATE:${index}:${date}`);
    if(date<acquisitionDate) throw new Error(`CONSTRUCTION_SPEND_BEFORE_ACQUISITION:${index}:${date}`);
    if(date>completionDate) throw new Error(`CONSTRUCTION_SPEND_AFTER_MODELED_COMPLETION:${index}:${date}:${completionDate}`);
    if(seen.has(date)) throw new Error(`DUPLICATE_CONSTRUCTION_SPEND_DATE:${date}`);
    seen.add(date);
    if(!Number.isFinite(share) || share<=0 || share>1) throw new Error(`INVALID_CONSTRUCTION_SPEND_SHARE:${index}:${row.share}`);
    return Object.freeze({date,share,sourceIndex:index});
  });

  const shareTotal=entries.reduce((a,e)=>a+e.share,0);
  if(Math.abs(shareTotal-1)>tolerance) throw new Error(`CONSTRUCTION_SPEND_SHARES_MUST_SUM_TO_ONE:${shareTotal}`);
  const sorted=entries.slice().sort((a,b)=>a.date.localeCompare(b.date)||a.sourceIndex-b.sourceIndex)
    .map((e,sequence)=>Object.freeze({date:e.date,share:e.share,sequence}));

  return Object.freeze({
    version:CONSTRUCTION_SPEND_SCHEDULE_VERSION,
    basis:CONSTRUCTION_SPEND_BASIS,
    acquisitionDate,
    modeledConstructionYears:years,
    modeledCompletionDate:completionDate,
    shareTotal,
    entries:Object.freeze(sorted),
  });
}
