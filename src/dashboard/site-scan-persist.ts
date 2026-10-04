// Satu titik masuk untuk memuat snapshot site-scan yang dipersist
// (chrome.storage.local, key 'bbr:last-site-scan') ke state dashboard.
// Dipakai halaman Results (#/hasil) dan Failures (#/kegagalan) saat mount,
// agar daftar situs tetap terisi setelah reload/tab baru/backup terjadwal.
import {
  getState,
  patchState,
  type SiteScanStats,
  type UrlState,
} from './store';
import { readSiteScanRecord } from '@/lib/site-scan-persist';

type PersistedSiteScanRecord = {
  runId: string;
  startedAt: number;
  completedAt: number | null;
  stats: Omit<SiteScanStats, 'urlStates'> | null;
  urlStates: UrlState[];
};

// Limitation: cross-tab live sync DI LUAR SCOPE — hanya re-read saat mount.
// Tab dashboard kedua tidak sync sampai reload.
export async function loadPersistedSiteScan(): Promise<boolean> {
  const storage = globalThis.chrome?.storage?.local ?? null;
  const rec = (await readSiteScanRecord(
    storage
  )) as PersistedSiteScanRecord | null;
  if (!rec) return false;
  if (getState().backup.siteScan) return false; // live in-memory menang; jangan timpa
  patchState('backup', (b) => ({
    ...b,
    siteScan: rec.stats
      ? { ...rec.stats, urlStates: rec.urlStates ?? [] }
      : null,
    siteScanMeta: {
      runId: rec.runId,
      startedAt: rec.startedAt,
      completedAt: rec.completedAt ?? null,
    },
  }));
  return true;
}
