/* 3A-3 — browser-side document hash: shared canonical encoding (document-canonical.js, also the source of the server's
   copy) + standard WebCrypto SHA-256 (no hand-written hash). Fails closed when WebCrypto is unavailable. */
import { canonicalDocValue, canonicalDocJson } from './document-canonical.js';
export { canonicalDocValue, canonicalDocJson };

export async function documentHashHex(doc) {
  const json = canonicalDocJson(doc); // encodes synchronously, before any await
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || typeof subtle.digest !== 'function') { const e = new Error('WebCrypto SHA-256 unavailable'); e.rejectionCode = 'NO_WEBCRYPTO'; throw e; }
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}
