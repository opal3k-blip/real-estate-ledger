// R1-B2 / B2-4c — MANUAL ACCEPTANCE KIT (server). Serves the repo on 127.0.0.1 only, with Firebase and the CDN libraries replaced by stubs and the fund
// editor wired to an in-page FAKE server (tests/helpers/fund-valuation-server-fake.mjs). Nothing real is read or written: no Firebase, no network, no account.
// Run (any machine with Node, from the repo root):   node tests/manual/b2-4c-acceptance-server.mjs [port]      then open the printed address in Edge/Chrome.
// Stop with Ctrl+C in that same terminal. This script starts one server and never touches any other process.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.argv[2] || process.env.PORT || 8765);
const STUB = `(() => {
  const mk = () => new Proxy(function () {}, { get(t, k) { if (k === 'then') return undefined; if (k === 'onSnapshot') return () => () => {}; if (k === 'docs') return []; if (k === 'exists') return false; if (k === 'data') return () => ({}); if (k === Symbol.toPrimitive) return () => ''; return mk(); }, apply() { return mk(); } });
  const db = mk();
  window.firebase = { initializeApp() {}, firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => 0, delete: () => 0 } }), auth: () => ({ onAuthStateChanged(cb) { window.__authCb = cb; }, signOut: async () => {} }), functions: () => ({ httpsCallable: () => async () => ({ data: {} }) }), storage: () => mk() };
})();`;
const PANEL_STUB = 'export function registerFundValuationPanel(){ return null; }\nexport function renderPanel(){ return ""; }\nexport const esc = (v)=>String(v); export const fmtAmount = (v)=>String(v); export function makeFirestoreSubscribe(){} export function makeFirestoreFetchOnce(){} export function makeSession(){}';
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function pageHtml() {
  let h = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  h = h.replace(/<script[^>]*\ssrc="https?:\/\/[^"]*"[^>]*><\/script>/g, '');          // CDN libraries (charts, firebase SDKs): not needed, never loaded
  h = h.replace(/<head[^>]*>/i, (m) => m + '<script>' + STUB + '</script>');
  h = h.replace('</body>', '<script type="module" src="/tests/manual/b2-4c-acceptance-boot.mjs"></script></body>');
  return h;
}

const server = http.createServer((req, res) => {
  const [rawPath, query = ''] = req.url.split('?'); const u = decodeURIComponent(rawPath);
  if (u === '/' || u === '/index.html') { res.setHeader('content-type', TYPES['.html']); res.setHeader('cache-control', 'no-store'); return res.end(pageHtml()); }
  if (/\/fund-valuation-panel\.js$/.test(u) && !/real=1/.test(query)) { res.setHeader('content-type', TYPES['.js']); return res.end(PANEL_STUB); }   // main.js's own registration is stubbed; the boot module registers the real one
  if (/\/firebase-config\.js$/.test(u)) { res.setHeader('content-type', TYPES['.js']); return res.end("window.FIREBASE_CONFIG = { apiKey: 'test', authDomain: 'test.invalid', projectId: 'acceptance-kit', storageBucket: 'test.invalid', messagingSenderId: '0', appId: 'acceptance-kit' };"); }   // a dummy: the real project config is never served by this kit
  const f = path.join(ROOT, u);
  if (!f.startsWith(ROOT + path.sep) || /(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(f) || /firebase-config\.js$/.test(f)) { res.statusCode = 403; return res.end('forbidden'); }
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream'); res.setHeader('cache-control', 'no-store'); res.end(fs.readFileSync(f));
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`B2-4c acceptance kit: http://127.0.0.1:${PORT}/   (fake server, stubbed Firebase; Ctrl+C here stops it)`);
});
server.on('error', (e) => { console.error('cannot start: ' + e.message + '  (try another port: node tests/manual/b2-4c-acceptance-server.mjs 8777)'); process.exit(1); });
