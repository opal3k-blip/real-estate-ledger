import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..', '..');

export function loadCore(extraExports = []){
  let coreCode = fs.readFileSync(path.join(ROOT, 'src/core.js'), 'utf8');
  const extras = Array.isArray(extraExports) && extraExports.length ? `${extraExports.join(',')},` : '';
  coreCode = coreCode.replace(/export\s*\{/, `globalThis.__C = {${extras}`);
  const ctx = {
    console, setTimeout, clearTimeout,
    localStorage: { getItem(){ return null; }, setItem(){} },
    document: {
      documentElement:{ lang:'ar' },
      querySelector(){ return null; }, addEventListener(){}, getElementById(){ return null; },
      querySelectorAll(){ return []; }, body:{}, createElement(){ return {}; }
    },
    window: {}, Notification: undefined, navigator: {}, URL,
    FileReader: function(){}, Intl, Math, JSON, Date, parseFloat, parseInt,
    isFinite, Number, String, Array, Object, Boolean, RegExp, Error,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(coreCode, ctx, { timeout: 20000 });
  if(!ctx.__C || typeof ctx.__C.compute !== 'function' || typeof ctx.__C.blankOpportunity !== 'function'){
    throw new Error('Unable to load canonical src/core.js compute/blankOpportunity exports');
  }
  return ctx.__C;
}
