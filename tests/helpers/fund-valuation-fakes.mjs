// أدوات مشتركة لاختبارات B2-1: اشتراك مزيَّف قابل للعدّ، وبناة وثائق بصمات حقيقية (نفس documentHashHex المستخدمة في العميل).
import { documentHashHex } from '../../src/domain/validation/document-hash.js';

export const tick = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0)); };

export function makeFakeSubscribe() {
  const subs = []; const log = [];
  const subscribe = (source, fundId, onNext, onError) => {
    const s = { source, fundId, onNext, onError, active: true };
    subs.push(s); log.push(`sub:${source}:${fundId}`);
    return () => { if (s.active) { s.active = false; log.push(`unsub:${source}:${fundId}`); } };
  };
  return {
    subscribe, subs, log,
    live: () => subs.filter((s) => s.active),
    liveFor: (fundId) => subs.filter((s) => s.active && s.fundId === fundId),
    emit(source, fundId, docs, fromCache = false) { for (const s of subs.filter((x) => x.active && x.source === source && x.fundId === fundId)) s.onNext({ docs, fromCache }); },
    emitAll(fundId, { heads = [], valuations = [], events = [] }, fromCache = false) {
      this.emit('heads', fundId, heads, fromCache); this.emit('valuations', fundId, valuations, fromCache); this.emit('events', fundId, events, fromCache);
    },
    fail(source, fundId, err) { for (const s of subs.filter((x) => x.active && x.source === source && x.fundId === fundId)) s.onError(err); },
  };
}

export const SESSION_FM = { uid: 'u1', email: 'fm@example.com', role: 'fund_manager', roleResolved: true };
export function sessionBox(initial = SESSION_FM) { const box = { s: { ...initial } }; box.get = () => ({ ...box.s }); box.set = (p) => { box.s = { ...box.s, ...p }; }; return box; }

export function content(over = {}) {
  return {
    currency: 'SAR', basis: 'RESIDUAL_VALUE_AS_OF_DATE', residualValue: 1000,
    components: { assetsValue: 900, cashRetained: 200, otherAssets: 50, liabilities: 150, distributionsPayable: 0, otherAssetsItems: [{ description: 'receivable', amount: 50 }] },
    method: 'appraisal', methodNote: 'external appraisal', source: { ref: 'APP-1', provider: 'Valuer Co' },
    nonOverlap: { cashNotInAssets: true, otherAssetsNotInAssets: true, assetsStatedGrossOfLiabilities: true }, coverage: { linkedAssets: ['A1', 'A2'] },
    ...over,
  };
}

/** رأس + وثيقة معتمدة متسقان (بصمة صحيحة) ما لم تُمرَّر تعديلات. */
export async function approvedPair({ fundId = 'F1', date = '2026-10-01', valuationId = 'V1', version = 1, approvedBy = 'boss@example.com', contentHash = 'CH-1', eligibility, doc = {}, head = {}, goodHash = true } = {}) {
  const headHash = goodHash ? await documentHashHex({ valuationId, version, contentHash, approvedBy }) : 'bad-hash';
  const elig = eligibility === undefined ? { state: 'ELIGIBLE', changedBy: approvedBy, changedAt: '2026-10-01T08:00:00.000Z', reasonCode: 'APPROVED', reason: null } : eligibility;
  const d = { valuationId, fundId, valuationDate: date, state: 'approved', status: 'approved', enteredBy: 'prep@example.com', approvedBy, approvedAt: '2026-10-01T08:00:00.000Z', version, contentHash, updatedAt: '2026-10-01T08:00:00.000Z', ...content(), ...doc };
  const h = { fundId, valuationDate: date, headId: valuationId, version, headHash, eligibility: elig, activeDraftId: null, updatedAt: '2026-10-01T08:00:00.000Z', rev: 1, ...head };
  return { head: { id: `${fundId}__${date}`, data: h }, doc: { id: valuationId, data: d } };
}
export function draftDoc({ fundId = 'F1', date = '2026-10-02', valuationId = 'D1', state = 'draft', over = {} } = {}) {
  return { id: valuationId, data: { valuationId, fundId, valuationDate: date, state, status: 'draft', enteredBy: 'prep@example.com', updatedAt: '2026-10-02T09:00:00.000Z', ...content(), ...over } };
}
export function headOnlyDraft({ fundId = 'F1', date = '2026-10-02', activeDraftId = 'D1' } = {}) {
  return { id: `${fundId}__${date}`, data: { fundId, valuationDate: date, headId: null, version: 0, headHash: null, eligibility: null, activeDraftId, rev: 1 } };
}
export function event(i, { fundId = 'F1', date = '2026-10-01', type = 'DRAFT_CREATED', actor = 'prep@example.com', reason } = {}) {
  const at = new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
  return { id: `E${String(i).padStart(4, '0')}`, data: { fundId, valuationDate: date, valuationId: 'V1', type, action: 'x', actor, role: 'fund_manager', at, details: reason ? { reason } : {} } };
}
