'use strict';
// GENERATED from src/domain/validation/document-canonical.js by functions/scripts/build-domain.cjs — do not edit.
/* 3A-3 — canonical, UNAMBIGUOUS encoding of a stored document, shared by the browser and the server.
   Single source: functions/scripts/build-domain.cjs derives functions/generated/document-canonical.cjs from THIS file
   (text transform only; `--check` fails on drift), so the two sides cannot disagree about the representation.

   Encoding (output is plain JSON-compatible data; the digest is taken over JSON.stringify of it):
     - special values become a single-key marker object whose key starts with ONE "$":
         {$number:"NaN"|"Infinity"|"-Infinity"}  {$bigint}  {$date}  {$bytes}  {$ts:[s,ns]}  {$ref}
     - EVERY plain-object key that itself starts with "$" is escaped by prefixing one more "$"
       ("$number" -> "$$number", "$$x" -> "$$$x"). So a real key can never be mistaken for a marker, and the mapping
       is injective: {notes:NaN} and {notes:{"$number":"NaN"}} encode differently.
     - Timestamp / DocumentReference are recognised structurally ONLY on non-plain objects (class instances). A plain
       map such as {seconds:1,nanoseconds:2,...} or {path:"a",id:"b",firestore:true} is data, never a special type.
     - any other non-plain object, function or symbol is refused (fail closed) instead of being guessed at.
   Ordinary documents (strings, finite numbers, booleans, null, arrays, plain maps without "$"-keys) encode exactly as
   before this change, so their hashes are unchanged. */
function fail(code, msg) { const e = new Error(msg); e.rejectionCode = code; return e; }

const tag = (v) => Object.prototype.toString.call(v);
function isPlainObject(v) {
  const p = Object.getPrototypeOf(v);
  return p === null || p === Object.prototype || Object.getPrototypeOf(p) === null; // cross-realm safe
}
function base64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
const escapeKey = (k) => (k.charCodeAt(0) === 36 ? '$' + k : k);

function canonicalDocValue(v, depth = 0, seen = new Set()) {
  if (depth > 60) throw fail('TOO_DEEP', 'Document is too deeply nested');
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : { $number: String(v) };
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'bigint') return { $bigint: String(v) };
  if (t === 'function' || t === 'symbol') throw fail('UNSUPPORTED_TYPE', 'Unsupported value type in document');
  const kind = tag(v);
  if (kind === '[object Date]') return { $date: Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString() };
  if (kind === '[object Uint8Array]') return { $bytes: base64(v) };
  if (seen.has(v)) throw fail('CYCLIC_DOCUMENT', 'Cyclic document');
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map(x => canonicalDocValue(x === undefined ? null : x, depth + 1, seen));
    if (isPlainObject(v)) {
      const out = Object.create(null);
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[escapeKey(k)] = canonicalDocValue(v[k], depth + 1, seen);
      return out;
    }
    // Class instances from the Firestore SDKs, recognised structurally so the module has no SDK dependency.
    if (typeof v.seconds === 'number' && typeof v.nanoseconds === 'number' && typeof v.toMillis === 'function') return { $ts: [v.seconds, v.nanoseconds] };
    if (typeof v.path === 'string' && typeof v.id === 'string' && v.firestore) return { $ref: v.path };
    throw fail('UNSUPPORTED_TYPE', 'Unsupported object type in document');
  } finally { seen.delete(v); }
}

function canonicalDocJson(doc) { return JSON.stringify(canonicalDocValue(doc)); }

/* Removes dot-separated paths (server-managed volatile fields) from an ALREADY canonical value. */
function omitCanonicalPaths(canonical, paths) {
  if (!paths || !paths.length || !canonical || typeof canonical !== 'object') return canonical;
  const copy = JSON.parse(JSON.stringify(canonical));
  for (const p of paths) {
    const parts = p.split('.');
    let o = copy;
    for (let i = 0; i < parts.length - 1 && o; i++) o = o[parts[i]];
    if (o && typeof o === 'object') delete o[parts[parts.length - 1]];
  }
  return copy;
}

module.exports = { canonicalDocValue, canonicalDocJson, omitCanonicalPaths };
