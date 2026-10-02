import { createRoot } from 'react-dom/client';
import '@/style.css';
import App from './App';
import { installTestHooks } from '@/dashboard/api';
import { initThemeSync } from '@/dashboard/theme';
import { cleanupPreviousSessionTabs, createTabOwnership, verifyScanTab } from '@/lib/sitedata';
import { pushSiteLogEntry } from '@/dashboard/site-log-store';

function isOwnedTabsRecord(value: unknown): value is { tabIds: number[] } {
  if (typeof value !== 'object' || value === null || !('tabIds' in value)) return false;
  const tabIds = (value as { tabIds?: unknown }).tabIds;
  return Array.isArray(tabIds) && tabIds.every((tabId: unknown) => Number.isInteger(tabId));
}

// Apply the persisted theme class before the first paint (no flash).
initThemeSync();

// Expose the automation surface before the first render (same timing as the
// original top-level script evaluation).
installTestHooks();

// On dashboard reopen: clean leftover scan tabs from a previous session.
// ONLY by recorded tab ID (never by query); each tab is verified to still
// show a scan page before closing.
void cleanupPreviousSessionTabs(
  (level: string, category: string, message: string, context: Record<string, unknown>) => {
    pushSiteLogEntry({
      seq: 0,
      ts: Date.now(),
      crawlId: 'startup',
      level,
      category,
      message,
      corr: null,
      url: null,
      context: context || {},
    });
  }
);

// Best-effort cleanup on dashboard close: fire-and-forget close of any
// recorded owned tabs via safeCloseTab (never chrome.tabs.remove directly).
// Cannot await in beforeunload; the next dashboard open re-verifies via
// cleanupPreviousSessionTabs.
window.addEventListener('beforeunload', () => {
  try {
    chrome.storage.local.get('bbr:site-data-owned-tabs', (kv) => {
      const rec: unknown = kv && kv['bbr:site-data-owned-tabs'];
      if (isOwnedTabsRecord(rec) && rec.tabIds.length) {
        const ownership = createTabOwnership(null, verifyScanTab, null);
        for (const id of rec.tabIds) {
          ownership.own(id);
          void ownership.safeCloseTab(id, '').catch(() => {});
        }
      }
    });
  } catch (e) {
    /* ignore */
  }
});

createRoot(document.getElementById('root')!).render(<App />);
