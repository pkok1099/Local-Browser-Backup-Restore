// Dashboard-side site-log store: holds live entries (pushed by the crawl
// via opts.onLogEntry) plus entries loaded from IndexedDB. Single shared
// state for the Log page — no duplication.
import { useSyncExternalStore } from 'react';
import { querySiteLog, formatLogTs, LOG_LEVELS, LOG_CATEGORIES } from '@/lib/site-log';

export type SiteLogEntry = {
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

const MAX_LIVE = 2000;
let entries: SiteLogEntry[] = [];
let unseenError = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function pushSiteLogEntry(entry: SiteLogEntry) {
  entries.push(entry);
  if (entries.length > MAX_LIVE) entries = entries.slice(-MAX_LIVE);
  if (entry.level === 'ERROR' || entry.level === 'FATAL') unseenError = true;
  emit();
}

export function isUnseenSiteLogError(): boolean {
  return unseenError;
}

export function markSiteLogSeen() {
  unseenError = false;
  emit();
}

export function clearSiteLogView() {
  entries = [];
  emit();
}

export function getSiteLogEntries(): SiteLogEntry[] {
  return entries;
}

export function subscribeSiteLog(l: () => void) {
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
  const rows = await querySiteLog({ limit });
  // Merge: persisted first, then live (dedupe by seq+crawlId).
  const seen = new Set(entries.map((e) => `${e.crawlId}:${e.seq}`));
  const merged = [...rows.filter((r) => !seen.has(`${r.crawlId}:${r.seq}`)), ...entries];
  merged.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  entries = merged.slice(-MAX_LIVE);
  emit();
  return entries;
}

export { formatLogTs, LOG_LEVELS, LOG_CATEGORIES };

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
