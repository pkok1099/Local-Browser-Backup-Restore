// Persist site-scan results so the Results and Failures pages remain populated
// after a reload or when opened in a new tab. state.backup.siteScan.urlStates
// exists only in memory; this module writes incremental snapshots to
// chrome.storage.local (through injected storage, so it remains testable in Node)
// and reads them back when a page mounts.
//
// Plain JavaScript: no React or global chrome imports. All write/read/clear
// operations are best-effort and NEVER throw; storage failures must not fail
// a backup.

export const SITE_SCAN_STORAGE_KEY = 'bbr:last-site-scan';
export const SITE_SCAN_PERSIST_THROTTLE_MS = 5000;

// Use crypto.randomUUID() when available; otherwise use a random string that
// remains unique (older environments without WebCrypto need uniqueness, not a UUID).
export function newSiteScanRunId() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return (
    'scan-' +
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 12)
  );
}

// Write throttle: true when at least intervalMs has elapsed since the last write.
// lastWriteMs=0 means nothing has been written yet, so this always returns true.
export function shouldPersistSiteScan(
  lastWriteMs,
  nowMs,
  intervalMs = SITE_SCAN_PERSIST_THROTTLE_MS
) {
  return nowMs - lastWriteMs >= intervalMs;
}

// Keep the large urlStates array (read by Results/Failures) separate from stats
// so the record stays stable and easy to inspect; the input is not mutated.
export function buildSiteScanRecord({
  runId,
  startedAt,
  completedAt,
  siteScan,
}) {
  if (!siteScan)
    return { runId, startedAt, completedAt, stats: null, urlStates: [] };
  const { urlStates, ...stats } = siteScan;
  return {
    runId,
    startedAt,
    completedAt,
    stats,
    urlStates: urlStates ?? [],
  };
}

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Best-effort write: returns false (does not throw) if storage is null or broken.
export async function writeSiteScanRecord(storage, record) {
  try {
    if (!storage || typeof storage.set !== 'function') return false;
    await storage.set({ [SITE_SCAN_STORAGE_KEY]: record });
    return true;
  } catch {
    return false;
  }
}

// Best-effort read: returns null if storage is null, the payload is missing or
// corrupt, or basic validation fails (runId must be a string; urlStates an array).
export async function readSiteScanRecord(storage) {
  try {
    if (!storage || typeof storage.get !== 'function') return null;
    const raw = await storage.get(SITE_SCAN_STORAGE_KEY);
    const record = raw ? raw[SITE_SCAN_STORAGE_KEY] : null;
    if (!isRecord(record)) return null;
    if (typeof record.runId !== 'string') return null;
    if (!Array.isArray(record.urlStates)) return null;
    return record;
  } catch {
    return null;
  }
}

// Best-effort clear: returns false (does not throw) if storage is null or broken.
export async function clearSiteScanRecord(storage) {
  try {
    if (!storage || typeof storage.remove !== 'function') return false;
    await storage.remove(SITE_SCAN_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
