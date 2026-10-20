// R1-B2 / B2-3a — the REAL server service (functions/fund-valuations.cjs, unmodified) running over an in-memory Firestore stand-in.
// Name it exactly so: "الخدمة الحقيقية فوق مخزن Firestore مزيّف". It is NOT the Firebase emulator: it has no real transaction isolation,
// no security rules and no real Timestamp type. It proves what the server's LOGIC decides (states, payloads, separation of duties,
// day checks, hash binding) for single-threaded scenarios; races and rules stay with the emulator suites, which are not run here.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FUNCTIONS_DIR = path.resolve(HERE, '..', '..', 'functions');
const fv = require(path.join(FUNCTIONS_DIR, 'fund-valuations.cjs'));
const { documentHash, validateInput } = require(path.join(FUNCTIONS_DIR, 'trusted-ic.cjs'));

export const SERVER_ROLE_LISTS = fv.ROLE_LISTS;           // read from the real module, for the parity checks only
export const SERVER_ALLOWED_KEYS = fv.ALLOWED_KEYS;

export class HttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
const clone = (v) => JSON.parse(JSON.stringify(v));

class Snap { constructor(id, data) { this.id = id; this._d = data; this.exists = data !== undefined; } data() { return this._d === undefined ? undefined : clone(this._d); } }
class QSnap { constructor(docs) { this.docs = docs; this.size = docs.length; this.empty = docs.length === 0; } forEach(f) { this.docs.forEach(f); } }
class DocRef { constructor(db, coll, id) { this.db = db; this.coll = coll; this.id = id; } async get() { return new Snap(this.id, (this.db.data[this.coll] || {})[this.id]); } }
class Query {
  constructor(db, coll, filters) { this.db = db; this.coll = coll; this.filters = filters; }
  where(f, op, v) { if (op !== '==') throw new Error('only == is modelled'); return new Query(this.db, this.coll, [...this.filters, [f, v]]); }
  async get() {
    const c = this.db.data[this.coll] || {};
    return new QSnap(Object.keys(c).filter((id) => this.filters.every(([f, v]) => c[id][f] === v)).map((id) => new Snap(id, c[id])));
  }
}
class MemoryFirestore {
  constructor() { this.data = {}; this.auto = 0; }
  collection(name) { const db = this; return { doc: (id) => new DocRef(db, name, id === undefined ? `auto${++db.auto}` : id), where: (f, op, v) => new Query(db, name, []).where(f, op, v) }; }
  async runTransaction(fn) {
    const db = this; const writes = [];
    const tx = {
      get: (x) => x.get(),
      set: (ref, data) => { writes.push([ref, clone(data)]); },
    };
    const out = await fn(tx);                       // a throw leaves the store untouched, like a rolled-back transaction
    for (const [ref, data] of writes) { (db.data[ref.coll] = db.data[ref.coll] || {})[ref.id] = data; }
    return out;
  }
  seed(coll, id, data) { (this.data[coll] = this.data[coll] || {})[id] = clone(data); }
  read(coll, id) { const d = (this.data[coll] || {})[id]; return d === undefined ? undefined : clone(d); }
  all(coll) { return Object.entries(this.data[coll] || {}).map(([id, d]) => ({ id, ...clone(d) })); }
}

const ADMINS = new Set(['opal3k@gmail.com', 'ggocss@gmail.com']);
let domainP;
async function loadDomain() {
  if (!domainP) domainP = import(path.join(FUNCTIONS_DIR, 'generated', 'src', 'domain', 'financial', 'xirr', 'residual-valuation.js'))
    .then((m) => ({ selectResidualValuation: m.selectResidualValuation, validateValuationCandidate: m.validateValuationCandidate }));
  return domainP;
}

export const ADMIN_EMAIL = 'opal3k@gmail.com';
export function makeRealRig({ now = '2026-10-11T10:00:00Z', team = {} } = {}) {
  const db = new MemoryFirestore();
  const clock = { now: () => new Date(clock.t) }; clock.t = now;
  const isAdminEmail = (e) => ADMINS.has(e);
  const requireEmail = (request) => { const e = request.auth && request.auth.token && request.auth.token.email; if (!e) throw new HttpsError('unauthenticated', 'Authentication required.'); return String(e).toLowerCase(); };
  const requireAuthorized = async (email) => { if (isAdminEmail(email)) return; const s = await db.collection('team_members').doc(email).get(); if (!s.exists) throw new HttpsError('permission-denied', 'Not an authorized team member.'); };
  const roleForEmail = async (email) => { if (isAdminEmail(email)) return 'admin'; const s = await db.collection('team_roles').doc(email).get(); return s.exists ? ((s.data() || {}).role || 'analyst') : 'analyst'; };
  const svc = fv.createFundValuationService({ db, FieldValue: { serverTimestamp: () => '__SERVER_TS__' }, HttpsError, documentHash, validateInput, requireAuthorized, roleForEmail, isAdminEmail, loadDomain, clock });
  const R = {
    db, svc, clock, ADMIN_EMAIL,
    setTime(iso) { clock.t = iso; },
    setRole(email, role) { db.seed('team_members', email, { expiresAt: null }); db.seed('team_roles', email, { role }); },
    fund(id = 'F1', assetIds = ['A1', 'A2']) { db.seed('funds', id, { name: id, assetIds }); },
    /** call a service method as `email`; resolves { ok, data } or { ok:false, code, reason } */
    async call(method, email, data) {
      try { return { ok: true, data: await svc[method]({ auth: { token: { email } }, data }, requireEmail) }; } catch (e) { return { ok: false, code: e.code || null, reason: (e.details && e.details.reason) || null, message: e.message }; }
    },
  };
  for (const [email, role] of Object.entries(team)) R.setRole(email, role);
  return R;
}
let ridN = 0;
export const rid = () => `rq-${String(++ridN).padStart(8, '0')}-test`;
export function realContent(over = {}) {
  return JSON.parse(JSON.stringify({
    currency: 'SAR', basis: 'RESIDUAL_VALUE_AS_OF_DATE',
    components: { assetsValue: 1000000, cashRetained: 50000, otherAssets: 20000, otherAssetsItems: [{ description: 'receivable', amount: 20000 }], liabilities: 70000, distributionsPayable: 0 },
    residualValue: 1000000, method: 'appraisal', source: { ref: 'DOC-1', provider: 'Valuer Co' },
    nonOverlap: { cashNotInAssets: true, otherAssetsNotInAssets: true, assetsStatedGrossOfLiabilities: true },
    coverage: { linkedAssets: ['A1', 'A2'], unlinkedHoldings: { declared: 'none' } }, ...over,
  }));
}
