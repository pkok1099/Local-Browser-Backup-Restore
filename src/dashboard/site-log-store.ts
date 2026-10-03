// Dashboard-side site-log store: holds live entries (pushed by the crawl
// via opts.onLogEntry) plus entries loaded from IndexedDB. Single shared
// state for the Log page — no duplication.
import { useSyncExternalStore } from 'react';
import { clearPersistedSiteLog, querySiteLog, formatLogTs } from '@/lib/site-log';
import { patchState, setState, withDashboardActivity } from './store';

export type SiteLogEntry = {
  id: string;
  seq: number;
  ts: number;
  crawlId: string;
  level: string;
  category: string;
  message: string;
  corr: string | null;
  url: string | null;
  context: Record<string, unknown>;
};

type SiteLogEntryInput = Omit<SiteLogEntry, 'id'> & { id?: string };

const MAX_LIVE = 2000;
let entries: SiteLogEntry[] = [];
let unseenError = false;
let loadGeneration = 0;
let pendingClear = Promise.resolve();
const listeners = new Set<() => void>();
const clearPageId = Math.random().toString(36).slice(2);
const clearChannel =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('bbr-dashboard-site-log-clear')
    : null;

function emit() {
  for (const l of listeners) l();
}

export function pushSiteLogEntry(entry: SiteLogEntryInput) {
  const normalized = { ...entry, id: entry.id || crypto.randomUUID() };
  entries.push(normalized);
  if (entries.length > MAX_LIVE) entries = entries.slice(-MAX_LIVE);
  if (normalized.level === 'ERROR' || normalized.level === 'FATAL') unseenError = true;
  emit();
}

function isUnseenSiteLogError(): boolean {
  return unseenError;
}

export function markSiteLogSeen() {
  unseenError = false;
  emit();
}

function resetSiteLogState() {
  entries = [];
  unseenError = false;
  setState({ logLines: [] });
  patchState('backup', (backup) =>
    backup.siteScan ? { ...backup, siteScan: { ...backup.siteScan, logUnseenError: false } } : backup
  );
  emit();
}

if (typeof window !== 'undefined') {
  clearChannel?.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as { type?: unknown; sourceId?: unknown };
    if (message?.type !== 'cleared' || typeof message.sourceId !== 'string' || message.sourceId === clearPageId) {
      return;
    }
    loadGeneration += 1;
    resetSiteLogState();
  });
}

export async function clearSiteLogView(): Promise<boolean> {
  try {
    return await withDashboardActivity('clear-logs', async () => {
      const clearing = clearPersistedSiteLog();
      pendingClear = clearing.catch(() => {});
      await clearing;
      loadGeneration += 1;
      resetSiteLogState();
      clearChannel?.postMessage({ type: 'cleared', sourceId: clearPageId });
      return true;
    });
  } catch {
    return false;
  }
}

function getSiteLogEntries(): SiteLogEntry[] {
  return entries;
}

function subscribeSiteLog(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useSiteLog(): SiteLogEntry[] {
  return useSyncExternalStore(subscribeSiteLog, getSiteLogEntries);
}

export function useUnseenSiteLogError(): boolean {
  return useSyncExternalStore(subscribeSiteLog, isUnseenSiteLogError);
}

// Load persisted entries from IndexedDB (survives dashboard close/crash).
export async function loadPersistedSiteLog(limit = 500): Promise<SiteLogEntry[]> {
  const generation = loadGeneration;
  await pendingClear;
  const rows = await querySiteLog({ limit });
  if (generation !== loadGeneration) return entries;
  // Merge: persisted first, then live (dedupe by stable ID).
  const seen = new Set(entries.map((e) => e.id));
  const merged = [...rows.filter((r) => !seen.has(r.id)), ...entries];
  merged.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  entries = merged.slice(-MAX_LIVE);
  emit();
  return entries;
}

export { formatLogTs };

export const LEVEL_COLORS: Record<string, string> = {
  DEBUG: 'text-muted-foreground',
  INFO: 'text-foreground',
  WARN: 'text-amber-600 dark:text-amber-400',
  ERROR: 'text-red-600 dark:text-red-400',
  FATAL: 'text-white bg-red-600 dark:bg-red-700',
};

export const LEVEL_ICONS: Record<string, string> = {
  DEBUG: '·',
  INFO: 'ℹ',
  WARN: '⚠',
  ERROR: '✖',
  FATAL: '■',
};
