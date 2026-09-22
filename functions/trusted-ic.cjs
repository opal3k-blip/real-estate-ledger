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
    const [context, financial, ic, presentation] = await Promise.all([
      read('src/domain/financial/financial-context.js'), read('src/domain/financial/financial-engine.js'),
      read('src/domain/ic/ic-readiness-engine.js'), read('src/features/ic-decision-gate.js'),
    ]);
    return { ...financial.createFinancialEngine(context), icReadiness: ic.icReadiness,
      formatICReadiness: presentation.formatICReadiness, engineVersion: manifest.engineVersion };
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

function validateInput(value, depth = 0) {
  if (depth > 30) throw new Error('Opportunity is too deeply nested');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite opportunity input');
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe opportunity key');
    validateInput(value[key], depth + 1);
  }
}

// Bounds protect synchronous compute from unbounded year/level loops; values are never clamped.
function validateWorkBounds(d) {
  const paths = ['land.basements', 'development.constructionYears', 'development.operationYears',
    'landbank.holdingYears', 'income.refinance.analysisHorizon', 'subdivision.absorptionYears',
    'strategy.directSale.collectionLagYears', 'strategy.offPlanSale.escrowLagYears', 'vat.refundLagYears'];
  for (const field of paths) {
    const v = field.split('.').reduce((o, k) => o && o[k], d);
    if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)) {
      throw new Error(`Invalid or unsupported calculation horizon: ${field}`);
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
  if (Buffer.byteLength(inputJson, 'utf8') > 350000) throw new Error('Opportunity exceeds IC snapshot size limit');
  const c = engine.compute(d);
  const readiness = engine.icReadiness(engine.compute, d, c, { nowMs });
  const metrics = { equityIRR: c.equityIRR, projectIRR: c.projectIRR, MOIC: c.MOIC, dscrMin: c.dscrMin };
  const invalidMetrics = Object.entries(metrics).filter(([k, v]) => !(k === 'dscrMin' && v == null) && (typeof v !== 'number' || !Number.isFinite(v))).map(([k]) => k);
  return {
    readiness, invalidMetrics,
    legacyReasons: engine.formatICReadiness(auditFormat, readiness).reasons,
    audit: { schema: 'canonical-ic-v1', engineVersion: engine.engineVersion, evaluatedAt: new Date(nowMs).toISOString(),
      inputJson, inputHash: hash(inputJson), metrics: auditValue(metrics), invalidMetrics,
      readiness: auditValue(readiness) },
  };
}
module.exports = { recompute, loadEngine, auditValue };
