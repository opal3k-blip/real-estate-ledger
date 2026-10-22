/* =========================================================================
   Explicit deterministic timeline helpers — Phase 3B recovery rebuild.
   No hidden current date. acquisitionDate is mandatory.
   ========================================================================= */
import { isStrictIsoDate } from './financial-event.js';

function daysInMonthUTC(year, month1){
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function requireAcquisitionDate(value){
  if(!isStrictIsoDate(value)) throw new Error(`INVALID_ACQUISITION_DATE:${value}`);
  return value;
}

export function addMonthsClamped(isoDate, months){
  requireAcquisitionDate(isoDate);
  if(!Number.isInteger(months)) throw new Error(`INVALID_MONTH_OFFSET:${months}`);
  const [y,m,d]=isoDate.split('-').map(Number);
  const zero=(y*12+(m-1))+months;
  const ty=Math.floor(zero/12);
  const tm=((zero%12)+12)%12 + 1;
  const td=Math.min(d,daysInMonthUTC(ty,tm));
  return `${String(ty).padStart(4,'0')}-${String(tm).padStart(2,'0')}-${String(td).padStart(2,'0')}`;
}

export function addYearsClamped(isoDate, years){
  if(!Number.isInteger(years)) throw new Error(`INVALID_YEAR_OFFSET:${years}`);
  return addMonthsClamped(isoDate,years*12);
}

export function legacyYearEndDate(acquisitionDate, yearIndex){
  requireAcquisitionDate(acquisitionDate);
  if(!Number.isInteger(yearIndex) || yearIndex<0) throw new Error(`INVALID_YEAR_INDEX:${yearIndex}`);
  return addYearsClamped(acquisitionDate,yearIndex);
}

/* A scheduled construction draw is placed at the exact half-year point of the
   legacy annual period. This is a timing representation of core.js's average
   beginning/ending-balance interest approximation; it is NOT a claim that the
   real lender drew on that exact day. */
export function legacyYearMidpointDate(acquisitionDate, yearIndex){
  requireAcquisitionDate(acquisitionDate);
  if(!Number.isInteger(yearIndex) || yearIndex<1) throw new Error(`INVALID_YEAR_INDEX:${yearIndex}`);
  return addMonthsClamped(addYearsClamped(acquisitionDate,yearIndex-1),6);
}

export function buildLegacyAnnualTimeline({acquisitionDate,totalYears}){
  requireAcquisitionDate(acquisitionDate);
  if(!Number.isInteger(totalYears) || totalYears<0) throw new Error(`INVALID_TOTAL_YEARS:${totalYears}`);
  return Object.freeze({
    acquisitionDate,
    totalYears,
    t0:acquisitionDate,
    yearEnds:Object.freeze(Array.from({length:totalYears},(_,i)=>legacyYearEndDate(acquisitionDate,i+1))),
    yearMidpoints:Object.freeze(Array.from({length:totalYears},(_,i)=>legacyYearMidpointDate(acquisitionDate,i+1))),
  });
}
