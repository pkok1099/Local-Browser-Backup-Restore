import { createRoot } from 'react-dom/client';
import '@/style.css';
import App from './App';
import { installTestHooks } from '@/dashboard/api';
import { initThemeSync } from '@/dashboard/theme';

function isOwnedTabsRecord(value: unknown): value is { tabIds: number[] } {
  if (typeof value !== 'object' || value === null || !('tabIds' in value)) return false;
  const tabIds = (value as { tabIds?: unknown }).tabIds;
  return Array.isArray(tabIds) && tabIds.every((tabId: unknown) => Number.isInteger(tabId));
}

function logPreviousSessionCleanup(level: string, category: string, message: string, context: Record<string, unknown>) {
  void import('@/dashboard/site-log-store').then(({ pushSiteLogEntry }) => {
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
  });
}

function cleanupPreviousSession() {
  void chrome.storage.local
    .get('bbr:site-data-owned-tabs')
    .then((kv) => {
      const rec: unknown = kv && kv['bbr:site-data-owned-tabs'];
      if (!isOwnedTabsRecord(rec) || rec.tabIds.length === 0) return;
      return import('@/lib/sitedata').then(({ cleanupPreviousSessionTabs }) =>
        cleanupPreviousSessionTabs(logPreviousSessionCleanup)
      );
    })
    .catch(() => {});
}

// Apply the persisted theme class before the first paint (no flash).
initThemeSync();

// Expose the automation surface synchronously before the first render.
installTestHooks();

// Clean prior scan tabs after the initial UI has had a chance to render.
window.setTimeout(() => {
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  };
  if (idleWindow.requestIdleCallback) idleWindow.requestIdleCallback(cleanupPreviousSession, { timeout: 1500 });
  else cleanupPreviousSession();
}, 250);

// Best-effort cleanup on dashboard close: fire-and-forget close of recorded
// owned tabs via safeCloseTab (never chrome.tabs.remove directly). The next
// dashboard open re-verifies records if unload prevents this import from finishing.
window.addEventListener('beforeunload', () => {
  try {
    chrome.storage.local.get('bbr:site-data-owned-tabs', (kv) => {
      const rec: unknown = kv && kv['bbr:site-data-owned-tabs'];
      if (isOwnedTabsRecord(rec) && rec.tabIds.length) {
        void import('@/lib/sitedata')
          .then(({ createTabOwnership, verifyScanTab }) => {
            const ownership = createTabOwnership(null, verifyScanTab, null);
            for (const id of rec.tabIds) {
              ownership.own(id);
              void ownership.safeCloseTab(id, '').catch(() => {});
            }
          })
          .catch(() => {});
      }
    });
  } catch (e) {
    /* ignore */
  }
});

createRoot(document.getElementById('root')!).render(<App />);
