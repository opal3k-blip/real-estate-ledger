'use strict';
// Shared fixtures for the 3A-3 server tests (fakes only; no Firebase project, no network).
const { loadIndexWithFakes } = require('../load-index-with-fakes');
const { loadEngine, documentHash } = require('../../trusted-ic.cjs');

const EMAIL = 'ic@example.com';
const clone = x => JSON.parse(JSON.stringify(x));

async function readyFixture() {
  const engine = await loadEngine();
  const o = engine.withDefaults({});
  Object.assign(o.meta, { name: 'Ready Development', city: 'Riyadh', neighborhood: 'Test', analyst: 'Analyst', oppType: 'development', tier: 'متوسط', useType: '__neutral__' });
  for (const k of ['soil', 'water', 'tower', 'topo', 'infra']) o.site[k] = 1;
  Object.assign(o.land, { area: 5000, price: 2000, far: 2, bar: 0.5, setbacks: 0.15, floorsAllowed: 10, floorHeight: 3.6 });
  Object.assign(o.development, { salePrice: 9000, buildCost: 3000, efficiency: 0.85, contingency: 0.05, constructionYears: 2, operationYears: 1, scopeType: 'both', exitCapRate: 0.08 });
  o.strategy.salePct = 1;
  Object.assign(o.financing, { ltc: 0.5, saibor: 0.05, margin: 0.02 });
  o.regulatory.offeringType = 'private';
  Object.assign(o.criteria, { irrMin: 0.05, projIrrMin: -1, moicMin: 0, dscrMin: null });
  const { defaultItemsDict } = await import('../../generated/src/domain/due-diligence/dd-engine.js');
  o.dd = { items: defaultItemsDict() };
  Object.values(o.dd.items).forEach(it => { it.status = 'completed'; it.severity = 'medium'; });
  const { KEY_FIELDS } = await import('../../generated/src/domain/evidence/evidence-engine.js');
  o.evidence = {};
  for (const f of KEY_FIELDS.filter(f => !f.appliesTo || f.appliesTo === 'development')) {
    o.evidence[f.path] = { source: 'test-source', tier: 'tier1', confidence: 'high', verifiedBy: EMAIL, date: '2099-01-01' };
  }
  return o;
}

function setPath(o, path, v) {
  const ks = path.split('.'); let x = o;
  for (let i = 0; i < ks.length - 1; i++) { if (x[ks[i]] == null || typeof x[ks[i]] !== 'object') x[ks[i]] = {}; x = x[ks[i]]; }
  x[ks[ks.length - 1]] = v;
  return o;
}

function makeEnv() {
  const { fns, db } = loadIndexWithFakes();
  let seq = 0;
  const env = {
    fns, db, EMAIL,
    seed(o, id = 'OPP') {
      db.__reset();
      db.__seed('team_members', EMAIL, { expiresAt: null });
      db.__seed('team_roles', EMAIL, { role: 'senior_ic' });
      db.__seed('opportunities', id, o); // NOT cloned: lets a test store NaN / Infinity / unsafe keys the way Firestore can
    },
    hash(id = 'OPP') { return documentHash(db.__get('opportunities', id)); },
    req(data = {}, email = EMAIL) {
      const base = { oppId: 'OPP', decision: { decision: 'approve' }, requestId: 'REQ-' + (++seq), ...data };
      if (!('expectedDocHash' in data)) {
        const doc = db.__get('opportunities', base.oppId);
        base.expectedDocHash = doc ? documentHash(doc) : '0'.repeat(64);
      }
      return { auth: { token: { email } }, data: base };
    },
    counts() {
      return ['icDecisions', 'underwritingVersions', 'icDecisionRequests'].map(c => Object.keys(db.__all(c)).length);
    },
  };
  return env;
}

module.exports = { EMAIL, clone, readyFixture, setPath, makeEnv };
