// Single entry point for loading the persisted site-scan snapshot
// (chrome.storage.local, key 'bbr:last-site-scan') into dashboard state.
// Used by the Results and Failures pages when they mount, so the site lists
// remain populated after a reload, a new tab, or a scheduled backup.
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

// Limitation: live cross-tab sync is out of scope; data is re-read only on mount.
// A second dashboard tab will not sync until it is reloaded.
export async function loadPersistedSiteScan(): Promise<boolean> {
  const storage = globalThis.chrome?.storage?.local ?? null;
  const rec = (await readSiteScanRecord(
    storage
  )) as PersistedSiteScanRecord | null;
  if (!rec) return false;
  if (getState().backup.siteScan) return false; // live in-memory state takes precedence; do not overwrite it
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
