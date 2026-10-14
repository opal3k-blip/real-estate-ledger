'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const generated = path.join(__dirname, 'generated');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
let enginePromise;

function loadEngine() {
  if (!enginePromise) enginePromise = (async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(generated, 'manifest.json'), 'utf8'));
    if (manifest.schema !== 1 || hash(JSON.stringify(manifest.files)) !== manifest.engineVersion) throw new Error('Invalid domain manifest');
    for (const [file, expected] of Object.entries(manifest.files)) {
      if (file.includes('..') || path.isAbsolute(file)) throw new Error('Invalid bundle path');
      const bytes = fs.readFileSync(path.join(generated, file), 'utf8').replace(/\r\n/g, '\n');
      if (hash(bytes) !== expected) throw new Error(`Domain bundle integrity failure: ${file}`);
    }
    const read = file => import(pathToFileURL(path.join(generated, file)).href);
    const [context, financial, ic, presentation, risk] = await Promise.all([
      read('src/domain/financial/financial-context.js'), read('src/domain/financial/financial-engine.js'),
      read('src/domain/ic/ic-readiness-engine.js'), read('src/features/ic-decision-gate.js'),
      read('src/domain/validation/risk-classification.js'),
    ]);
    // 3A-3: classifyOpportunity/verdictSummary are the exact modules the browser runs (copied by build-domain).
    return { ...financial.createFinancialEngine(context), icReadiness: ic.icReadiness,
      formatICReadiness: presentation.formatICReadiness, engineVersion: manifest.engineVersion,
      classifyOpportunity: risk.classifyOpportunity, verdictSummary: risk.verdictSummary };
  })();
  return enginePromise;
}

// Stable JSON snapshots retain explicit non-finite values, instead of silently becoming null.
function auditValue(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) return { $number: String(value) };
  if (Array.isArray(value)) return value.map(v => auditValue(v === undefined ? null : v));
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function') return auditValue(value.toJSON());
    const out = Object.create(null);
    for (const k of Object.keys(value).sort()) if (value[k] !== undefined) out[k] = auditValue(value[k]);
    return out;
  }
  return value;
}

/* Figure-free, machine-readable rejection: callers map `rejectionCode` into the HttpsError details. */
function rejection(code, message, extra) {
  const error = new Error(message);
  error.rejectionCode = code;
  if (extra && extra.path) error.rejectionPath = extra.path;
  return error;
}
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// Structural guard on the STORED document (never on the request payload). Fail closed; never coerce or clamp.
function validateInput(value, depth = 0, pathParts = []) {
  const where = () => pathParts.join('.');
  if (depth > 30) throw rejection('TOO_DEEP', 'Opportunity is too deeply nested', { path: where() });
  if (typeof value === 'number' && !Number.isFinite(value)) throw rejection('NON_FINITE_INPUT', 'Non-finite opportunity input', { path: where() });
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw rejection('UNSUPPORTED_TYPE', 'Unsupported value type in opportunity', { path: where() });
  }
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) throw rejection('UNSAFE_KEY', 'Unsafe opportunity key', { path: where() });
    validateInput(value[key], depth + 1, pathParts.concat(key));
  }
}

/* Canonical hash of the WHOLE stored document (every financial and non-financial field, including `ic`).
   It binds an approval to exactly what the approver reviewed: any change, even to a condition or a note,
   changes the hash. Only paths listed in VOLATILE_DOC_FIELDS (server-managed, never user-meaningful) are
   excluded. Audit of the repository (3A-3): no such field is written today, so the list is empty. */
const VOLATILE_DOC_FIELDS = Object.freeze([]);
// The encoding itself lives in src/domain/validation/document-canonical.js (single source shared with the browser);
// build-domain derives this CJS file from it and `--check` fails on drift.
const { canonicalDocValue, omitCanonicalPaths } = require('./generated/document-canonical.cjs');
function documentHash(doc, volatilePaths = VOLATILE_DOC_FIELDS) {
  return hash(JSON.stringify(omitCanonicalPaths(canonicalDocValue(doc), volatilePaths)));
}

// Bounds protect synchronous compute from unbounded year/level loops; values are never clamped.
function validateWorkBounds(d) {
  const paths = ['land.basements', 'development.constructionYears', 'development.operationYears',
    'landbank.holdingYears', 'income.refinance.analysisHorizon', 'subdivision.absorptionYears',
    'strategy.directSale.collectionLagYears', 'strategy.offPlanSale.escrowLagYears', 'vat.refundLagYears'];
  for (const field of paths) {
    const v = field.split('.').reduce((o, k) => o && o[k], d);
    if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)) {
      throw rejection('HORIZON_OUT_OF_BOUNDS', `Invalid or unsupported calculation horizon: ${field}`, { path: field });
    }
  }
}

const auditFormat = {
  fmtPct(v) { return v == null || !Number.isFinite(v) ? '—' : (v * 100).toFixed(1) + '%'; },
  fmtSAR(v) { return v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' SAR'; },
};

async function recompute(stored, nowMs) {
  const engine = await loadEngine();
  // Decision history is not an input and must not recursively grow each audit snapshot.
  const input = Object.fromEntries(Object.entries(stored).filter(([key]) => key !== 'ic'));
  validateInput(input);
  const d = engine.withDefaults(input);
  validateWorkBounds(d);
  const inputJson = JSON.stringify(auditValue(d));
  if (Buffer.byteLength(inputJson, 'utf8') > 350000) throw rejection('SNAPSHOT_TOO_LARGE', 'Opportunity exceeds IC snapshot size limit');
  let c;
  try { c = engine.compute(d); }
  catch (error) { throw rejection('COMPUTE_FAILED', 'The calculation could not run on this opportunity'); }
  // 3A-3: the colour/status/blocking decision is computed HERE, from the stored document, by the same
  // module the browser uses. Nothing the client sends can influence it.
  const classification = engine.classifyOpportunity(d, c);
  const verdict = engine.verdictSummary(classification);
  // A malformed value (e.g. a threshold stored as text) can make the readiness engine throw. That must never surface as an
  // uncontrolled exception: if the inputs are already blocked the verdict carries the real reason; otherwise fail closed.
  let readiness; let legacyReasons;
  try {
    readiness = engine.icReadiness(engine.compute, d, c, { nowMs });
    legacyReasons = engine.formatICReadiness(auditFormat, readiness).reasons;
  } catch (error) {
    if (!verdict.blocked) throw rejection('READINESS_FAILED', 'The readiness evaluation could not run on this opportunity');
    readiness = { ready: false, gates: {}, reasons: [{ code: 'READINESS_UNAVAILABLE', ar: 'تعذّر تقييم الجاهزية بسبب مدخلات غير صالحة.', en: 'Readiness could not be evaluated because of invalid inputs.' }] };
    legacyReasons = [];
  }
  const metrics = { equityIRR: c.equityIRR, projectIRR: c.projectIRR, MOIC: c.MOIC, dscrMin: c.dscrMin };
  const invalidMetrics = Object.entries(metrics).filter(([k, v]) => !(k === 'dscrMin' && v == null) && (typeof v !== 'number' || !Number.isFinite(v))).map(([k]) => k);
  return {
    readiness, invalidMetrics, verdict, docHash: documentHash(stored),
    legacyReasons,
    audit: { schema: 'canonical-ic-v1', engineVersion: engine.engineVersion, evaluatedAt: new Date(nowMs).toISOString(),
      inputJson, inputHash: hash(inputJson), docHash: documentHash(stored), metrics: auditValue(metrics), invalidMetrics, verdict,
      readiness: auditValue(readiness) },
  };
}
module.exports = { recompute, loadEngine, auditValue, documentHash, canonicalDocValue, validateInput, VOLATILE_DOC_FIELDS };
