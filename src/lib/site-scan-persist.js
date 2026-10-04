// Persist hasil site-scan agar halaman Results/Failures tetap terisi setelah
// reload/tab baru. state.backup.siteScan.urlStates hanya in-memory; modul ini
// menyimpan snapshot incremental ke chrome.storage.local (via storage DI, jadi
// tetap node-testable) dan membacanya kembali saat halaman di-mount.
//
// JS murni: tanpa import React/chrome global. Semua write/read/clear
// best-effort — TIDAK PERNAH throw, kegagalan storage tidak boleh menggagalkan
// backup.

export const SITE_SCAN_STORAGE_KEY = 'bbr:last-site-scan';
export const SITE_SCAN_PERSIST_THROTTLE_MS = 5000;

// crypto.randomUUID() bila tersedia; fallback string acak yang tetap unik
// (lingkungan lama tanpa WebCrypto — keunikan, bukan UUID, yang dibutuhkan).
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

// Throttle penulisan: true bila sudah >= intervalMs sejak tulis terakhir.
// lastWriteMs=0 = belum pernah tulis -> selalu true.
export function shouldPersistSiteScan(
  lastWriteMs,
  nowMs,
  intervalMs = SITE_SCAN_PERSIST_THROTTLE_MS
) {
  return nowMs - lastWriteMs >= intervalMs;
}

// Pisahkan urlStates (besar, dibaca Results/Failures) dari stats agar record
// stabil dan mudah dibaca; input tidak dimutasi.
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

// Best-effort write: false (tidak throw) bila storage null/rusak.
export async function writeSiteScanRecord(storage, record) {
  try {
    if (!storage || typeof storage.set !== 'function') return false;
    await storage.set({ [SITE_SCAN_STORAGE_KEY]: record });
    return true;
  } catch {
    return false;
  }
}

// Best-effort read: null bila storage null, payload hilang/corrupt, atau
// validasi minimal gagal (runId harus string, urlStates harus array).
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

// Best-effort clear: false (tidak throw) bila storage null/rusak.
export async function clearSiteScanRecord(storage) {
  try {
    if (!storage || typeof storage.remove !== 'function') return false;
    await storage.remove(SITE_SCAN_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
