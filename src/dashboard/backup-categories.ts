// @ts-nocheck -- Dashboard UI predates strict mode; needs dedicated refactoring pass. Tracked as tech debt.
import { SITE_DATA_CONFIG } from '@/lib/sitedata';

const BACKUP_CATEGORY_STORAGE_KEY = 'bbr:backup-categories';
const SITE_DATA_INCLUDED_ORIGINS_KEY = 'bbr:site-data-included-origins';
const SITE_DATA_SCAN_WINDOW_KEY = 'bbr:site-data-scan-window';
// Hard cap on simultaneously open scan tabs during website-data collection.
// Single source of truth: SITE_DATA_CONFIG in lib/sitedata.js.
export const SITE_DATA_SCAN_WINDOW_DEFAULT = SITE_DATA_CONFIG.window.default;
export const SITE_DATA_SCAN_WINDOW_MIN = SITE_DATA_CONFIG.window.min;
export const SITE_DATA_SCAN_WINDOW_MAX = SITE_DATA_CONFIG.window.max;

export async function loadSiteDataScanWindow(): Promise<number> {
  try {
    const stored = await chrome.storage.local.get(SITE_DATA_SCAN_WINDOW_KEY);
    const n = Math.floor(Number(stored[SITE_DATA_SCAN_WINDOW_KEY]));
    if (Number.isFinite(n))
      return Math.min(
        SITE_DATA_SCAN_WINDOW_MAX,
        Math.max(SITE_DATA_SCAN_WINDOW_MIN, n)
      );
  } catch (e) {
    /* ignore */
  }
  return SITE_DATA_SCAN_WINDOW_DEFAULT;
}

export async function saveSiteDataScanWindow(n: number): Promise<void> {
  const v = Math.min(
    SITE_DATA_SCAN_WINDOW_MAX,
    Math.max(
      SITE_DATA_SCAN_WINDOW_MIN,
      Math.floor(Number(n) || SITE_DATA_SCAN_WINDOW_DEFAULT)
    )
  );
  await chrome.storage.local.set({ [SITE_DATA_SCAN_WINDOW_KEY]: v });
}

// Additional user-safe tunables (dashboard Settings page). Bounds keep the
// crawl safe: attempts 1-5, read timeout 15-180s, checkpoint every 5-50.
const SITE_DATA_TUNING_KEY = 'bbr:site-data-tuning';
export type SiteDataTuning = {
  retryMaxAttempts: number;
  readTimeoutMs: number;
  checkpointEveryOrigins: number;
};
const SITE_DATA_TUNING_DEFAULT: SiteDataTuning = {
  retryMaxAttempts: SITE_DATA_CONFIG.retry.maxAttempts,
  readTimeoutMs: SITE_DATA_CONFIG.retry.readTimeoutMs,
  checkpointEveryOrigins: SITE_DATA_CONFIG.checkpointEveryOrigins,
};
const TUNING_BOUNDS = {
  retryMaxAttempts: [1, 5],
  readTimeoutMs: [15000, 180000],
  checkpointEveryOrigins: [5, 50],
} as const;

export async function loadSiteDataTuning(): Promise<SiteDataTuning> {
  try {
    const stored = await chrome.storage.local.get(SITE_DATA_TUNING_KEY);
    const v = stored[SITE_DATA_TUNING_KEY];
    if (v && typeof v === 'object') {
      const clamp = (x: unknown, [lo, hi]: readonly number[], fb: number) => {
        const n = Math.floor(Number(x));
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
      };
      return {
        retryMaxAttempts: clamp(
          v.retryMaxAttempts,
          TUNING_BOUNDS.retryMaxAttempts,
          SITE_DATA_TUNING_DEFAULT.retryMaxAttempts
        ),
        readTimeoutMs: clamp(
          v.readTimeoutMs,
          TUNING_BOUNDS.readTimeoutMs,
          SITE_DATA_TUNING_DEFAULT.readTimeoutMs
        ),
        checkpointEveryOrigins: clamp(
          v.checkpointEveryOrigins,
          TUNING_BOUNDS.checkpointEveryOrigins,
          SITE_DATA_TUNING_DEFAULT.checkpointEveryOrigins
        ),
      };
    }
  } catch (e) {
    /* ignore */
  }
  return { ...SITE_DATA_TUNING_DEFAULT };
}

export async function saveSiteDataTuning(t: SiteDataTuning): Promise<void> {
  const cur = await loadSiteDataTuning();
  // loadSiteDataTuning clamps, so merging then re-loading normalizes bounds.
  await chrome.storage.local.set({ [SITE_DATA_TUNING_KEY]: { ...cur, ...t } });
  const checked = await loadSiteDataTuning();
  await chrome.storage.local.set({ [SITE_DATA_TUNING_KEY]: checked });
}

export const BACKUP_CATEGORIES = [
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'history', label: 'History' },
  { id: 'tabs', label: 'Tabs' },
  { id: 'windows', label: 'Windows (layout & position)' },
  { id: 'tabGroups', label: 'Tab groups (name & color)' },
  { id: 'sessions_tabs', label: 'Recently closed tabs' },
  { id: 'sessions_windows', label: 'Recently closed windows' },
  { id: 'cookies_plain', label: 'Cookies (plain)' },
  { id: 'cookies_partitioned', label: 'Cookies (partitioned)' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'readingList', label: 'Reading list' },
  { id: 'extensionStorage', label: 'Extension storage (this extension)' },
  { id: 'installedExtensions', label: 'Installed extension list' },
  { id: 'extensionPermissions', label: 'Extension permissions' },
  { id: 'profile', label: 'Browser profile metadata' },
  { id: 'siteData_localStorage', label: 'Website data: Local Storage' },
  { id: 'siteData_indexedDB', label: 'Website data: IndexedDB' },
  {
    id: 'siteData_otherStorage',
    label: 'Website data: Cache, OPFS & Buckets',
  },
] as const;

export type BackupCategoryId = (typeof BACKUP_CATEGORIES)[number]['id'];

const ALL_CATEGORY_IDS = BACKUP_CATEGORIES.map(
  (category) => category.id
) as BackupCategoryId[];

// Legacy coarse IDs (pre-granular format) mapped to their granular
// replacements. Legacy IDs no longer exist in BACKUP_CATEGORIES, so a single
// expansion pass handles every case without format detection: legacy IDs
// expand, granular IDs pass through, and anything unknown is filtered out.
const GRANULAR_EXPANSION: Record<string, string[]> = {
  siteData: [
    'siteData_localStorage',
    'siteData_indexedDB',
    'siteData_otherStorage',
  ],
  cookies: ['cookies_plain', 'cookies_partitioned'],
  sessions: ['sessions_tabs', 'sessions_windows'],
  tabsWindows: ['tabs', 'windows', 'tabGroups'],
};

export async function loadBackupCategories(): Promise<BackupCategoryId[]> {
  try {
    const stored = await chrome.storage.local.get(BACKUP_CATEGORY_STORAGE_KEY);
    const value = stored[BACKUP_CATEGORY_STORAGE_KEY];
    if (!Array.isArray(value)) return [...ALL_CATEGORY_IDS];
    const migrated = [
      ...new Set(
        value.flatMap((id: unknown) =>
          typeof id === 'string' && id in GRANULAR_EXPANSION
            ? GRANULAR_EXPANSION[id]
            : [id]
        )
      ),
    ].filter((id): id is BackupCategoryId =>
      ALL_CATEGORY_IDS.includes(id as BackupCategoryId)
    );
    // Persist the migrated shape so the legacy format is stored only once.
    await chrome.storage.local.set({
      [BACKUP_CATEGORY_STORAGE_KEY]: migrated,
    });
    return migrated;
  } catch (e) {
    return [...ALL_CATEGORY_IDS];
  }
}

export async function saveBackupCategories(
  categories: BackupCategoryId[]
): Promise<void> {
  const valid = categories.filter((id) => ALL_CATEGORY_IDS.includes(id));
  await chrome.storage.local.set({
    [BACKUP_CATEGORY_STORAGE_KEY]: [...new Set(valid)],
  });
}

export async function loadIncludedSiteOrigins(): Promise<string[] | null> {
  try {
    const stored = await chrome.storage.local.get(
      SITE_DATA_INCLUDED_ORIGINS_KEY
    );
    const value = stored[SITE_DATA_INCLUDED_ORIGINS_KEY];
    return Array.isArray(value)
      ? value.filter((origin: unknown) => typeof origin === 'string')
      : null;
  } catch (e) {
    return null;
  }
}

export async function saveIncludedSiteOrigins(
  origins: string[]
): Promise<void> {
  await chrome.storage.local.set({
    [SITE_DATA_INCLUDED_ORIGINS_KEY]: [...new Set(origins)],
  });
}

// ---- Non-restorable site-data sub-categories ----
// Factual: sessionStorage cannot be restored when restore creates a new tab
// (only into a pre-existing open tab); service worker restore requires the
// worker script to still be served by its site. Both default OFF (not backed
// up); the user can enable them manually. When OFF, the data is not captured
// at all (saves time and storage).
export type SiteDataInclude = {
  sessionStorage: boolean;
  serviceWorkers: boolean;
};
const SITE_DATA_INCLUDE_DEFAULT: SiteDataInclude = {
  sessionStorage: false,
  serviceWorkers: false,
};
const SITE_DATA_INCLUDE_KEY = 'bbr:site-data-include';

export async function loadSiteDataInclude(): Promise<SiteDataInclude> {
  try {
    const stored = await chrome.storage.local.get(SITE_DATA_INCLUDE_KEY);
    const v = stored[SITE_DATA_INCLUDE_KEY];
    if (v && typeof v === 'object') {
      return {
        sessionStorage: v.sessionStorage === true,
        serviceWorkers: v.serviceWorkers === true,
      };
    }
  } catch (e) {
    /* ignore */
  }
  return { ...SITE_DATA_INCLUDE_DEFAULT };
}

export async function saveSiteDataInclude(v: SiteDataInclude): Promise<void> {
  await chrome.storage.local.set({
    [SITE_DATA_INCLUDE_KEY]: {
      sessionStorage: v.sessionStorage === true,
      serviceWorkers: v.serviceWorkers === true,
    },
  });
}
