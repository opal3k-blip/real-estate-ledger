// R1-B2 / B2-3a — drives the SAME table rows against the fake server ("خادم مزيّف"), to show the fake obeys the same table as the real service.
import { makeServer } from './fund-valuation-server-fake.mjs';
import { CALLABLES } from '../../src/features/fund-valuation-model.js';
import { rawPayload, DAY, NEXT_DAY_TIME, BUILD_TIME, classify } from './fund-valuation-contract-driver-real.mjs';

export const FAKE_EMAIL = Object.freeze({ prep: 'fm@example.com', prep2: 'fm2@example.com', ic1: 'ic@example.com', ic2: 'ic2@example.com', hybrid: 'hybrid@example.com', analyst: 'analyst@example.com', admin: 'admin@example.com', stranger: 'stranger@example.com' });

export async function runFakeRow(row) {
  const clock = { now: new Date(BUILD_TIME) };
  const S = makeServer({ clock });
  const m = /^suspended-by-(ic1|ic2)$/.exec(row.head || '');
  if (row.head && row.head !== 'none') S.seedHead({ valuationDate: DAY, headId: 'H0', version: 1, suspended: m ? { by: FAKE_EMAIL[m[1]] } : null });
  const doc = await S.seedDraft({ valuationId: 'V1', valuationDate: DAY, state: row.state, enteredBy: FAKE_EMAIL[row.preparer] });
  if (row.contributors.includes('hybrid')) doc.contributors.push(FAKE_EMAIL.hybrid);
  if (row.state === 'reviewed') doc.review = { reviewedBy: FAKE_EMAIL.ic1, reviewedContentHash: doc.contentHash };
  if (row.storedContributors === 'none') doc.contributors.length = 0;
  if (row.day === 'crossed') clock.now = new Date(NEXT_DAY_TIME);
  const payload = rawPayload(row, 'V1', doc.contentHash);
  const before = JSON.stringify([...S.vals.entries()]) + JSON.stringify([...S.slot.entries()]) + JSON.stringify([...S.heads.entries()]);
  let res;
  try { res = { ok: true, data: await S.handle(FAKE_EMAIL[row.actor], CALLABLES[row.action], payload) }; } catch (e) { res = { ok: false, code: String(e.code || '').replace(/^functions\//, '') || null, reason: (e.details && e.details.reason) || null, message: e.message }; }
  const after = JSON.stringify([...S.vals.entries()]) + JSON.stringify([...S.slot.entries()]) + JSON.stringify([...S.heads.entries()]);
  return { S, id: 'V1', res, got: classify(res), before, after, payload };
}
