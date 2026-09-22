const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CORE_PATH = path.join(ROOT, 'src', 'core.js');
const ENGINE_PATH = path.join(ROOT, 'src', 'domain', 'financial', 'financial-engine.js');
const CORE_ENGINE_IMPORT_RE = /^\s*import\s*\{\s*createFinancialEngine\s*\}\s*from\s*['"]\.\/domain\/financial\/financial-engine\.js['"];?\s*$/m;

function buildCoreVmSource(options = {}) {
  const extraExports = Array.isArray(options.extraExports) ? options.extraExports : [];
  let coreCode = fs.readFileSync(CORE_PATH, 'utf8');
  let engineCode = fs.readFileSync(ENGINE_PATH, 'utf8');
  const contextPath = path.join(ROOT, 'src/domain/financial/financial-context.js');
  const contextImport = /^import \{[^\n]+baseBlankOpportunity \} from '\.\/domain\/financial\/financial-context\.js';$/m;
  if (!contextImport.test(coreCode)) throw new Error('core-vm-source: canonical financial context import missing');
  coreCode = coreCode.replace(contextImport, '');
  const contextCode = fs.readFileSync(contextPath, 'utf8')
    .replace(/export const /g, 'const ').replace(/export function /g, 'function ')
    .replace('function blankOpportunity()', 'function baseBlankOpportunity()');

  if (!CORE_ENGINE_IMPORT_RE.test(coreCode)) {
    throw new Error('core-vm-source: expected canonical financial-engine import was not found in src/core.js');
  }
  coreCode = coreCode.replace(CORE_ENGINE_IMPORT_RE, '');

  if (!/export\s+function\s+createFinancialEngine\s*\(/.test(engineCode)) {
    throw new Error('core-vm-source: createFinancialEngine export was not found');
  }
  engineCode = engineCode.replace(/export\s+function\s+createFinancialEngine\s*\(/, 'function createFinancialEngine(');

  const extras = extraExports.length ? `${extraExports.join(',')},` : '';
  if (!/export\s*\{/.test(coreCode)) {
    throw new Error('core-vm-source: src/core.js export block was not found');
  }
  coreCode = coreCode.replace(/export\s*\{/, `globalThis.__C = {${extras}`);

  return `${contextCode}\n${engineCode}\n${coreCode}`;
}

module.exports = { ROOT, buildCoreVmSource };
