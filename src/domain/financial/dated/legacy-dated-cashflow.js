/* =========================================================================
   Phase 3B-5D — Composed legacy dated cash views (shadow mode)
   -------------------------------------------------------------------------
   Provides one deterministic composition point for the two cash views that
   matter to underwriting parity:
     1) unlevered project cash; and
     2) investor/equity cash.

   Financing/debt ledgers remain separate because their zero-project-cash
   events should not be confused with project cash-flow reconciliation.
   ========================================================================= */
import { sortFinancialEvents, eventEffects } from './financial-event.js';
import { generateLegacyProjectCostEvents } from './legacy-project-events.js';
import { generateLegacyVatEvents, generateLegacyPhasedSaleEvents } from './legacy-cash-timing-events.js';
import { generateLegacyDirectSaleTimingEvents } from './legacy-direct-sale-events.js';
import { generateLegacyOperatingExitEvents } from './legacy-operating-exit-events.js';
import { generateLegacyInvestorCashEvents } from './legacy-investor-cash-events.js';

export function generateLegacyProjectCashEvents(opportunity,computation,options={}){
  const project=generateLegacyProjectCostEvents(computation,{...options,scope:`${options.scope||'legacy-dated'}-project-cost`});
  const vat=generateLegacyVatEvents(opportunity,computation,{...options,scope:`${options.scope||'legacy-dated'}-vat`});
  const operating=generateLegacyOperatingExitEvents(computation,{...options,scope:`${options.scope||'legacy-dated'}-operating-exit`});
  const phased=computation?.isPhasedSaleMode
    ? generateLegacyPhasedSaleEvents(opportunity,computation,{...options,scope:`${options.scope||'legacy-dated'}-phased-sale`})
    : null;
  const direct=!computation?.isPhasedSaleMode
    ? generateLegacyDirectSaleTimingEvents(opportunity,computation,{...options,scope:`${options.scope||'legacy-dated'}-direct-sale`})
    : null;

  const all=[...project.events,...vat.events,...operating.events,...(phased?.events||[]),...(direct?.events||[])];
  // Keep only events that actually move the unlevered project cash view.
  const events=sortFinancialEvents(all.filter(e=>eventEffects(e).projectCash!==0));
  return Object.freeze({
    events:Object.freeze(events),
    components:Object.freeze({project,vat,operating,phased,direct}),
  });
}

export function generateLegacyDatedCashflow(opportunity,computation,options={}){
  const project=generateLegacyProjectCashEvents(opportunity,computation,options);
  const investor=generateLegacyInvestorCashEvents(computation,{...options,scope:`${options.scope||'legacy-dated'}-investor`});
  return Object.freeze({project,investor});
}
