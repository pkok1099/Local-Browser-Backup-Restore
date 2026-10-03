// Shared utilities: canonical JSON, hashing, base64, gzip, typed errors, yielding.

export const TextEnc = new TextEncoder();
export const TextDec = new TextDecoder();

export class TypedError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'TypedError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// Deterministic, sorted-key JSON serialization. Used for integrity digests and
// AEAD additional data so any byte-level tampering is detected.
export function canonicalize(value) {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'undefined') return 'null';
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ',';
      out += canonicalize(value[i]);
    }
    return out + ']';
  }
  if (value instanceof Uint8Array) return canonicalize(Array.from(value));
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  let out = '{';
  let first = true;
  for (const k of keys) {
    if (!first) out += ',';
    first = false;
    out += JSON.stringify(k) + ':' + canonicalize(value[k]);
  }
  return out + '}';
}

function bytesToHex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', TextEnc.encode(str));
  return bytesToHex(new Uint8Array(buf));
}

export function hasCompressionStream() {
  return (
    typeof CompressionStream !== 'undefined' &&
    typeof DecompressionStream !== 'undefined'
  );
}

export async function gzipCompress(u8) {
  const stream = new Blob([u8])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gzipDecompress(u8) {
  const stream = new Blob([u8])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Yield to the event loop / renderer so the dashboard stays responsive and
// long operations do not freeze the UI thread.
// IMPORTANT: requestAnimationFrame NEVER fires in a backgrounded/hidden tab
// (browser throttling), so it is only used when the document is actually
// visible — otherwise a backup running while the user looks at another tab
// would hang forever (found during test H on Chrome 153).
export async function yieldToUI() {
  await new Promise((r) => setTimeout(r, 0));
  if (
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible'
  ) {
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  }
}

export function errMessage(e) {
  if (!e) return 'unknown error';
  if (e instanceof TypedError) return e.message;
  return e.message || String(e);
}

export function errCode(e) {
  return (e && e.code) || 'UNKNOWN_ERROR';
}
