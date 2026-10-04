// Ported dashboard logic (from the original vanilla-JS dashboard.js).
// Heavy backup/restore operations still run in this extension page (NOT in the
// service worker) so MV3 worker lifecycle cannot kill an operation. Every UI
// mutation from the original file becomes a store update; the React components
// render it. window.__api (see api.ts) keeps the exact same programmatic
// surface for the automated test suite — it never logs cookie values or
// passwords.
import { TypedError, errMessage, errCode } from '@/lib/util';
import {
  newBackupSkeleton,
  finalizeIntegrity,
  verifyIntegrity,
} from '@/lib/format';
import { encryptBackup } from '@/lib/crypto';
import { detect, runProbes, getChromeVersion } from '@/lib/capabilities';
import { collectAll, computeCounts, subCategorySelected } from '@/lib/collect';
import {
  sectionForRow,
  capabilityKeyForRow,
  presentRestoreRows,
  countFromData,
  countFor,
  synthesizeSectionOptions,
} from '@/lib/restore-rows';
import { restoreAll } from '@/lib/restore';
import { validateBackupFile } from '@/lib/validate';
import {
  patchState,
  setState,
  appendLog,
  getState,
  type SummaryLine,
  type RestoreRow,
  type ResultLine,
  type CapsRow,
  type SiteScanStats,
  type UrlState,
  hasUnresolvedSiteScan,
  withDashboardActivity,
} from './store';
import {
  loadBackupCategories,
  loadIncludedSiteOrigins,
  loadSiteDataScanWindow,
  loadSiteDataTuning,
  loadSiteDataInclude,
} from './backup-categories';
import { collectSiteData, discoverOrigins } from '@/lib/sitedata';
import {
  computeIncrementalPlan,
  finalizeIncrementalRun,
  buildFullCachePayload,
  writeSiteDataCache,
} from '@/lib/site-incremental';
import { SITE_DATA_CONFIG } from '@/lib/scan-config';
import {
  newSiteScanRunId,
  shouldPersistSiteScan,
  buildSiteScanRecord,
  writeSiteScanRecord,
  clearSiteScanRecord,
} from '@/lib/site-scan-persist';
import { pushSiteLogEntry, type SiteLogEntry } from './site-log-store';

type UnknownRecord = Record<string, unknown>;
type RestoreCapability = 'full' | 'partial' | false;
type CapabilityDetail = {
  canRead?: boolean;
  canBackup?: boolean;
  canRestore?: RestoreCapability;
  notes?: string[];
};
type SiteDataSection = UnknownRecord & { origins?: Record<string, unknown> };
type BackupData = UnknownRecord & {
  siteData?: SiteDataSection;
  tabsWindows?: UnknownRecord & { tabGroups?: unknown[] };
};
type BackupObject = UnknownRecord & {
  data?: BackupData;
  counts?: Record<string, number | string | undefined>;
  capabilities?: Record<string, CapabilityDetail | undefined>;
  integrity?: { digest?: string } | null;
  generator?: unknown;
};
type SiteDataOptions = UnknownRecord & {
  includeOrigins?: string[] | null;
  excludeOrigins?: string[] | null;
  scanWindowSize?: number | null;
  retryMaxAttempts?: number | undefined;
  readTimeoutMs?: number | undefined;
  checkpointEveryOrigins?: number | undefined;
  includeSessionStorage?: boolean;
  includeServiceWorkers?: boolean;
  includeLocalStorage?: boolean;
  includeIndexedDB?: boolean;
  includeOtherStorage?: boolean;
  excludedSiteDataCategories?: string[];
  tuning?: {
    retryMaxAttempts?: number | undefined;
    readTimeoutMs?: number | undefined;
    checkpointEveryOrigins?: number | undefined;
  };
};
type CollectOptions = UnknownRecord & {
  selectedCategories?: string[];
  siteData?: SiteDataOptions;
  // Scheduled runs only: re-crawl just origins visited since the last
  // snapshot (history-gated); the section is merged back to complete.
  // Manual runs never set this (always a full crawl).
  incrementalSiteData?: boolean;
};
type CategoryStatus = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  stack?: string;
};
type CollectionResult = {
  data: BackupData;
  capabilities: Record<string, CapabilityDetail | undefined>;
  categoryStatus: Record<string, CategoryStatus | undefined>;
};
type ValidationResult = {
  backup: BackupObject;
  warnings?: string[];
  encrypted?: boolean;
  envelopeMeta?: { kdf: { name: string; iterations: number }; cipher: string };
};
type RestoreOption = {
  enabled: boolean;
  unavailable?: boolean;
  // Split-section synthesis only: per-member enabled flags (see
  // synthesizeSectionOptions in @/lib/restore-rows).
  granular?: Record<string, boolean>;
  mode?: 'merge' | 'replace' | 'redownload' | 'metadata-only';
  confirmDestructive?: boolean;
  allowLiveTabWrite?: boolean;
};
type RestoreOutcome = {
  status: string;
  outcome:
    | 'complete'
    | 'partial'
    | 'failed'
    | 'unavailable'
    | 'skipped_by_user'
    | 'not_in_backup';
  summary: string;
  stats?: {
    notes?: string[];
    outcomeCounts?: { succeeded: number; failed: number; skipped: number };
  };
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function isRestoreCapability(value: unknown): value is RestoreCapability {
  return value === 'full' || value === 'partial' || value === false;
}

function normalizeSiteDataSection(value: unknown): SiteDataSection {
  const section = asRecord(value);
  return { ...section, origins: asRecord(section.origins) };
}

function countRecord(
  value: unknown
): Record<string, number | string | undefined> {
  const counts: Record<string, number | string | undefined> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (
      typeof item === 'number' ||
      typeof item === 'string' ||
      item === undefined
    )
      counts[key] = item;
  }
  return counts;
}

function capabilityDetail(value: unknown): CapabilityDetail {
  const detail = asRecord(value);
  return {
    canRead: detail.canRead === true,
    canBackup: detail.canBackup === true,
    canRestore: isRestoreCapability(detail.canRestore)
      ? detail.canRestore
      : false,
    notes: Array.isArray(detail.notes)
      ? detail.notes.filter(
          (note: unknown): note is string => typeof note === 'string'
        )
      : [],
  };
}

// ---------------- metadata ----------------

function generatorInfo() {
  return {
    name: 'Local Browser Backup & Restore',
    extensionVersion: chrome.runtime.getManifest().version,
    chromeVersion: getChromeVersion(),
    userAgent: navigator.userAgent,
    locale: navigator.language,
  };
}

export function fileName(ext = 'json') {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `browser-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

// ---------------- backup pipeline ----------------

// Batch 1 granular site-data categories: 'siteData' (legacy) or any
// 'siteData_*' ID selects the site-data crawl.
function siteDataCategorySelected(selectedCategories: string[]): boolean {
  return selectedCategories.some(
    (c) => c === 'siteData' || c.startsWith('siteData_')
  );
}

// Stop flag for the running backup (dashboard Stop button). The site-data
// crawl polls it and halts safely: owned scan tabs are closed via
// safeCloseTab (safety net), partial results are kept.
let backupStopFlag: { stop: boolean } | null = null;
export function requestBackupStop() {
  if (backupStopFlag) backupStopFlag.stop = true;
}

// Last site-data options + section, for the Failures page retry buttons.
let lastSiteDataOpts: CollectOptions | null = null;
let lastSiteDataSection: SiteDataSection | null = null;

// Persist site-scan snapshots (key 'bbr:last-site-scan') so the Results and
// Failures pages stay populated after a reload, in a new tab, or after a scheduled
// backup. The run is created when the backup starts; save retries reuse the same
// runId (do not set it to null in buildBackupObject).
let siteScanRun: { runId: string; startedAt: number } | null = null;
let siteScanLastPersistMs = 0;

async function persistSiteScanNow(final: boolean): Promise<void> {
  const run = siteScanRun;
  if (!run) return;
  const now = Date.now();
  const ok = await writeSiteScanRecord(
    chrome.storage?.local ?? null,
    buildSiteScanRecord({
      runId: run.runId,
      startedAt: run.startedAt,
      completedAt: final ? now : null,
      siteScan: getState().backup.siteScan,
    })
  );
  if (!ok) return;
  siteScanLastPersistMs = now;
  if (final)
    patchState('backup', (b) => ({
      ...b,
      siteScanMeta: {
        runId: run.runId,
        startedAt: run.startedAt,
        completedAt: now,
      },
    }));
}

function maybePersistSiteScan(): void {
  if (!siteScanRun) return;
  if (!shouldPersistSiteScan(siteScanLastPersistMs, Date.now())) return;
  void persistSiteScanNow(false);
}

export async function buildBackupObject(
  onProgress?: (m: string) => void,
  collectOptions?: CollectOptions | null
): Promise<{
  backup: BackupObject;
  categoryStatus: Record<string, CategoryStatus | undefined>;
}> {
  const selectedCategories =
    collectOptions?.selectedCategories ?? (await loadBackupCategories());
  const includedOrigins =
    collectOptions?.siteData?.includeOrigins ??
    (await loadIncludedSiteOrigins());
  const scanWindowSize =
    collectOptions?.siteData?.scanWindowSize ??
    (await loadSiteDataScanWindow());
  const tuning =
    collectOptions?.siteData?.tuning ?? (await loadSiteDataTuning());
  const siteDataInclude = await loadSiteDataInclude();
  // Granular site-data storage categories (Batch 1): each defaults to
  // included unless the category selection excludes both 'siteData' and its
  // granular ID.
  const includeSiteLocalStorage = subCategorySelected(
    selectedCategories,
    'siteData',
    'siteData_localStorage'
  );
  const includeSiteIndexedDB = subCategorySelected(
    selectedCategories,
    'siteData',
    'siteData_indexedDB'
  );
  const includeSiteOtherStorage = subCategorySelected(
    selectedCategories,
    'siteData',
    'siteData_otherStorage'
  );
  const effectiveCollectOptions = {
    ...(collectOptions || {}),
    selectedCategories,
    siteData: {
      ...(collectOptions?.siteData || {}),
      scanWindowSize,
      ...(includedOrigins === null ? {} : { includeOrigins: includedOrigins }),
      retryMaxAttempts:
        collectOptions?.siteData?.retryMaxAttempts ?? tuning.retryMaxAttempts,
      readTimeoutMs:
        collectOptions?.siteData?.readTimeoutMs ?? tuning.readTimeoutMs,
      checkpointEveryOrigins:
        collectOptions?.siteData?.checkpointEveryOrigins ??
        tuning.checkpointEveryOrigins,
      includeSessionStorage: siteDataInclude.sessionStorage,
      includeServiceWorkers: siteDataInclude.serviceWorkers,
      includeLocalStorage: includeSiteLocalStorage,
      includeIndexedDB: includeSiteIndexedDB,
      includeOtherStorage: includeSiteOtherStorage,
      excludedSiteDataCategories: [
        ...(siteDataInclude.sessionStorage ? [] : ['sessionStorage']),
        ...(siteDataInclude.serviceWorkers ? [] : ['serviceWorkers']),
        ...(includeSiteLocalStorage ? [] : ['localStorage']),
        ...(includeSiteIndexedDB ? [] : ['indexedDB']),
        ...(includeSiteOtherStorage ? [] : ['otherStorage']),
      ],
      stopFlag: backupStopFlag,
      onLogEntry: (entry: SiteLogEntry) => pushSiteLogEntry(entry),
    },
  };
  lastSiteDataOpts = effectiveCollectOptions;
  // Incremental site-data (scheduled runs only): narrow the crawl to origins
  // visited since the last snapshot. The section is merged back to a complete
  // snapshot after collection, so the artifact format never changes.
  let incrementalCtx: {
    included: string[];
    plan: {
      crawlOrigins: string[];
      eligibleOrigins: string[];
      cache: UnknownRecord | null;
      fullCrawl: boolean;
      reason: string | null;
    };
  } | null = null;
  if (
    collectOptions?.incrementalSiteData === true &&
    siteDataCategorySelected(selectedCategories)
  ) {
    const rawList =
      includedOrigins ??
      (await discoverOrigins()).origins.map((o: unknown) =>
        typeof o === 'string' ? o : (o as { origin: string }).origin
      );
    // Last-resort guard: the planner is internally fail-safe, but an
    // unattended scheduled run must never die here — degrade to a full crawl.
    let plan;
    try {
      plan = await computeIncrementalPlan({
        storage: chrome.storage?.local ?? null,
        history: chrome.history ?? null,
        nowMs: Date.now(),
        included: rawList,
        excludeOrigins: effectiveCollectOptions.siteData.excludeOrigins,
        config: SITE_DATA_CONFIG,
      });
    } catch (e) {
      appendLog(
        `sitedata incremental plan failed (${errMessage(e)}) — falling back to full crawl`
      );
      plan = {
        crawlOrigins: rawList,
        eligibleOrigins: rawList,
        cache: null,
        fullCrawl: true,
        reason: 'plan-error',
      };
    }
    incrementalCtx = { included: plan.eligibleOrigins, plan };
    // Mutates the same object lastSiteDataOpts already references.
    effectiveCollectOptions.siteData.includeOrigins = plan.crawlOrigins;
    appendLog(
      `sitedata incremental plan: ${plan.crawlOrigins.length}/${plan.eligibleOrigins.length} origin(s) to crawl` +
        (plan.fullCrawl ? ` (full crawl: ${plan.reason})` : '')
    );
  }
  const _runId = newSiteScanRunId();
  const _startedAt = Date.now();
  siteScanRun = { runId: _runId, startedAt: _startedAt };
  siteScanLastPersistMs = _startedAt;
  patchState('backup', (b) => ({
    ...b,
    siteScan: null,
    siteScanMeta: { runId: _runId, startedAt: _startedAt, completedAt: null },
  }));
  void writeSiteScanRecord(
    chrome.storage?.local ?? null,
    buildSiteScanRecord({
      runId: _runId,
      startedAt: _startedAt,
      completedAt: null,
      siteScan: null,
    })
  );
  appendLog(`backup starting: categories=[${selectedCategories.join(', ')}]`);
  const result = (await collectAll(
    (
      msg: string,
      cat?: string,
      _state?: string,
      frac?: number,
      stats?: SiteScanStats
    ) => {
      onProgress && onProgress(msg);
      // The collection phase drives the progress bar 0.05 → 0.65; categories
      // that report a sub-fraction (siteData) keep it accurate throughout.
      if (typeof frac === 'number' && Number.isFinite(frac)) {
        const f = 0.05 + Math.min(1, Math.max(0, frac)) * 0.6;
        patchState('backup', (b) => ({ ...b, frac: f }));
      }
      if (cat) appendLog(`collect: ${msg}`);
      // Live website-data scan counters for the dashboard.
      if (cat === 'siteData' && stats && typeof stats === 'object') {
        patchState('backup', (b) => ({
          ...b,
          siteScan: stats as SiteScanStats,
        }));
        maybePersistSiteScan();
      }
    },
    effectiveCollectOptions
  )) as unknown as CollectionResult;
  const { data, capabilities, categoryStatus } = result;
  // Incremental finalize: merge the crawled subset back into a complete
  // snapshot and advance the cache — but only on a clean, successful run.
  // A stopped/failed run never advances the cache (stale data must not look
  // fresh). A manual full run refreshes the cache wholesale instead, so the
  // next scheduled run starts incremental from a fresh snapshot.
  const siteDataSection = data.siteData as SiteDataSection | undefined;
  const siteDataWanted = siteDataCategorySelected(selectedCategories);
  if (
    categoryStatus.siteData?.ok === true &&
    siteDataWanted &&
    siteDataSection
  ) {
    const stopped =
      siteDataSection.stopped === true || backupStopFlag?.stop === true;
    const storage = chrome.storage?.local ?? null;
    if (incrementalCtx) {
      const fin = finalizeIncrementalRun({
        cache: incrementalCtx.plan.cache,
        freshOrigins: siteDataSection.origins ?? {},
        included: incrementalCtx.included,
        stopped,
        categoryOk: true,
        fullCrawl: incrementalCtx.plan.fullCrawl,
        fullReason: incrementalCtx.plan.reason,
        nowMs: Date.now(),
      });
      siteDataSection.origins = fin.origins as Record<string, unknown>;
      // notes is always an array from collectSiteData (success and halted paths).
      (siteDataSection.notes as string[]).push(...fin.notes);
      appendLog(fin.notes.join(' | '));
      if (fin.cachePayload) {
        const written = await writeSiteDataCache(storage, fin.cachePayload);
        if (!written)
          appendLog(
            'sitedata: cache write failed (best-effort) — next run re-crawls'
          );
      }
    } else if (!stopped) {
      const payload = buildFullCachePayload({
        freshOrigins: siteDataSection.origins ?? {},
        included: includedOrigins,
        nowMs: Date.now(),
      });
      await writeSiteDataCache(storage, payload); // best-effort; never fails the backup
    }
  }
  // Only categories that were actually & successfully read go into the backup.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (categoryStatus[k]?.ok) clean[k] = v;
    else {
      const st = categoryStatus[k] || { ok: false };
      const errMsg = `collect: category "${k}" FAILED and is excluded: ${st.error}`;
      appendLog(errMsg);
      // Also log to the site-log at ERROR/STORAGE with stack trace and context.
      pushSiteLogEntry({
        seq: 0,
        ts: Date.now(),
        crawlId: 'backup',
        level: 'ERROR',
        category: 'STORAGE',
        message: `category "${k}" failed: ${st.error}`,
        corr: null,
        url: null,
        context: {
          category: k,
          error: String(st.error || ''),
          stack: String(st.stack || ''),
        },
      });
      if (st.stack) appendLog(`collect: "${k}" stack:\n${st.stack}`);
    }
  }
  const backup = newBackupSkeleton(
    capabilities,
    generatorInfo()
  ) as BackupObject;
  backup.data = clean;
  backup.counts = countRecord(computeCounts(clean));
  await finalizeIntegrity(backup);
  lastSiteDataSection = data.siteData || null;
  // Final snapshot (completedAt is set); deliberately keep siteScanRun non-null
  // so a later save retry reuses the same runId.
  await persistSiteScanNow(true);
  return { backup, categoryStatus };
}

export async function buildCloudBackupObject(
  onProgress?: (message: string) => void,
  collectOptions?: CollectOptions | null
): Promise<BackupObject> {
  const { backup } = await buildBackupObject(onProgress, collectOptions);
  return backup;
}

export async function saveTextFile(text: string, name: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: name,
      saveAs: false,
    });
    // Wait for completion so callers can read the file from disk immediately.
    for (let i = 0; i < 600; i++) {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item && (item.state === 'complete' || item.state === 'interrupted')) {
        if (item.state === 'interrupted') {
          const reason =
            'interruptReason' in item &&
            typeof item.interruptReason === 'string'
              ? item.interruptReason
              : 'unknown';
          throw new TypedError(
            'ERR_DOWNLOAD_INTERRUPTED',
            `Saving backup file failed: ${reason}`
          );
        }
        return {
          downloadId,
          filename: item.filename,
          sizeBytes: item.fileSize || text.length,
        };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new TypedError(
      'ERR_DOWNLOAD_TIMEOUT',
      'Timed out waiting for the backup file to be saved.'
    );
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

export function doBackup(
  options: {
    encrypt?: boolean;
    password?: string | null;
    collectOptions?: CollectOptions | null;
  } = {}
) {
  return withDashboardActivity('backup', () => doBackupUnlocked(options));
}

async function doBackupUnlocked({
  encrypt = false,
  password = null,
  collectOptions = null,
}: {
  encrypt?: boolean;
  password?: string | null;
  collectOptions?: CollectOptions | null;
} = {}) {
  backupStopFlag = { stop: false };
  patchState('backup', (b) => ({
    ...b,
    visible: true,
    running: true,
    status: 'collecting data…',
    frac: 0.05,
    summary: [],
    foldersNote: null,
  }));
  setState({ password: { ...getState().password, open: false } });
  const t0 = performance.now();

  try {
    const { backup, categoryStatus } = await buildBackupObject(
      (m) => patchState('backup', (b) => ({ ...b, status: m })),
      collectOptions
    );
    if (backupStopFlag?.stop) {
      patchState('backup', (b) => ({
        ...b,
        status:
          'Stopped by user — partial results are kept; resume to continue the rest.',
      }));
      appendLog('backup stopped by user; no file written');
      // Keep the partial backup for download (user can download what exists).
      await storeBackupForDownload(backup, encrypt, password);
      return null;
    }
    patchState('backup', (b) => ({ ...b, frac: 0.7, status: 'preparing…' }));

    // No auto-download: the result stays in extension storage. The user
    // downloads explicitly via the "Download results" button.
    await storeBackupForDownload(backup, encrypt, password);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    patchState('backup', (b) => ({
      ...b,
      frac: 1,
      status: `Backup finished in ${secs}s — saved to extension storage. Click "Download results" to download the file.`,
    }));

    const counts = backup.counts || {};
    const cap = backup.capabilities || {};
    // Maps category -> [label, counts key, count formatter]. The counts keys
    // differ from category IDs for some categories (see computeCounts).
    const labelMap: Record<string, [string, string]> = {
      bookmarks: ['Bookmarks', 'bookmarks'],
      history: ['History', 'history'],
      tabsWindows: ['Tabs & windows', 'tabs'],
      sessions: ['Sessions (recently closed)', 'recentlyClosedSessions'],
      cookies: ['Cookies', 'cookies'],
      downloads: ['Downloads', 'downloads'],
      readingList: ['Reading list', 'readingList'],
      extensionStorage: ['Extension storage (own)', 'extensionStorage'],
      installedExtensions: [
        'Installed extensions (metadata)',
        'installedExtensions',
      ],
      extensionPermissions: [
        'Extension permissions (own)',
        'extensionPermissions',
      ],
      profile: ['Browser profile', 'profile'],
      siteData: [
        'Website data (localStorage/IndexedDB/CacheStorage/OPFS/Buckets)',
        'siteDataOrigins',
      ],
    };
    const summary: SummaryLine[] = [];
    for (const [key, [label, countKey]] of Object.entries(labelMap)) {
      if (!(countKey in counts)) {
        // Show failed categories instead of silently omitting them.
        const st = categoryStatus[key];
        if (st && !st.ok && !st.skipped) {
          summary.push({
            label: `${label} — FAILED (error)`,
            count: String(st.error || 'unknown'),
            pill: 'error',
          });
        }
        continue;
      }
      const r = cap[key]?.canRestore ?? false;
      const pill = (
        r === 'full' ? 'full' : r === 'partial' ? 'partial' : 'no'
      ) as 'full' | 'partial' | 'no';
      summary.push({ label, count: String(counts[countKey]), pill });
    }
    const foldersNote = counts.bookmarkFolders
      ? `plus ${counts.bookmarkFolders} bookmark folders`
      : null;
    patchState('backup', (b) => ({ ...b, summary, foldersNote }));
    appendLog(
      `backup finished and stored in extension storage (no auto-download)`
    );
    return { backup };
  } finally {
    backupStopFlag = null;
    patchState('backup', (b) => ({ ...b, running: false }));
  }
}

// ---------------- download on demand (no auto-download) ----------------

// The last backup is kept in memory for the active dashboard page only.
// Download happens ONLY when the user clicks "Download results".
let lastBackupForDownload: UnknownRecord | null = null;
let lastBackupMeta: {
  encrypt: boolean;
  at: number;
  isEnvelope?: boolean;
} | null = null;
export function isBackupEnvelopeReady(): boolean {
  return !!lastBackupMeta?.isEnvelope;
}

async function storeBackupForDownload(
  backup: BackupObject,
  encrypt: boolean,
  password: string | null
) {
  await verifyIntegrity(backup);
  let payload: UnknownRecord = backup;
  let meta: { encrypt: boolean; at: number; isEnvelope?: boolean } = {
    encrypt,
    at: Date.now(),
  };
  if (encrypt) {
    const envelope = asRecord(await encryptBackup(backup, password));
    const validation = (await validateBackupFile(JSON.stringify(envelope), {
      password,
    })) as ValidationResult;
    if (validation.backup.integrity?.digest !== backup.integrity?.digest) {
      throw new TypedError(
        'ERR_CHECKSUM_MISMATCH',
        'Encrypted backup validation did not recover the finalized backup.'
      );
    }
    payload = envelope;
    meta = { encrypt: true, at: Date.now(), isEnvelope: true };
  }
  lastBackupForDownload = payload;
  lastBackupMeta = meta;
  updateDownloadInfo();
}

export function getDownloadInfo(): {
  ready: boolean;
  siteCount: number;
  estBytes: number;
} {
  const b = lastBackupForDownload;
  if (!b) return { ready: false, siteCount: 0, estBytes: 0 };
  const data = asRecord(b.data);
  const siteData = asRecord(data.siteData);
  const origins = asRecord(siteData.origins);
  const siteCount = Object.keys(origins).length;
  // Estimate without building the full string: sample-based.
  let estBytes = 0;
  try {
    const keys = Object.keys(origins);
    const sample = keys.slice(0, 5);
    let sampleBytes = 0;
    for (const k of sample)
      sampleBytes += JSON.stringify(origins[k])?.length || 0;
    const avg = sample.length ? sampleBytes / sample.length : 0;
    const shell = JSON.stringify({
      ...b,
      data: { ...data, siteData: { origins: {} } },
    });
    estBytes = Math.round(avg * keys.length + (shell?.length || 0));
  } catch (e) {
    estBytes = 0;
  }
  return { ready: true, siteCount, estBytes };
}

function updateDownloadInfo() {
  const info = getDownloadInfo();
  patchState('backup', (b) => ({ ...b, downloadInfo: info }));
}

// Build the download Blob incrementally (no single giant JSON string in
// memory): top-level keys are stringified separately, and siteData origins
// are streamed one by one.
function buildBackupBlob(
  backup: UnknownRecord,
  encrypt: boolean
): { blob: Blob; outName: string } {
  const payload = backup;
  let outName: string;
  const meta = lastBackupMeta;
  if (meta?.isEnvelope) {
    // Already encrypted (envelope built at backup time).
    outName = fileName('backup.enc.json');
    return {
      blob: new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      }),
      outName,
    };
  }
  if (encrypt) {
    throw new Error(
      'Encrypted download needs the password — run backup with encryption first.'
    );
  }
  outName = fileName('backup.json');
  const parts: string[] = ['{\n'];
  const data = asRecord(payload.data);
  const topKeys = Object.keys(payload).filter((k) => k !== 'data');
  topKeys.forEach((k) => {
    const encoded = JSON.stringify(payload[k]);
    if (encoded !== undefined) parts.push(JSON.stringify(k) + ': ' + encoded);
    parts.push(',\n');
  });
  parts.push('"data": {\n');
  const dataKeys = Object.keys(data).filter((k) => k !== 'siteData');
  dataKeys.forEach((k) => {
    const encoded = JSON.stringify(data[k]);
    if (encoded !== undefined)
      parts.push(JSON.stringify(k) + ': ' + encoded + ',\n');
  });
  // siteData: stream origins one by one.
  const siteData = asRecord(data.siteData);
  parts.push('"siteData": {\n');
  const sdKeys = Object.keys(siteData).filter((k) => k !== 'origins');
  sdKeys.forEach((k) => {
    const encoded = JSON.stringify(siteData[k]);
    if (encoded !== undefined)
      parts.push(JSON.stringify(k) + ': ' + encoded + ',\n');
  });
  parts.push('"origins": {\n');
  const origins = asRecord(siteData.origins);
  const oKeys = Object.keys(origins).filter((k) => origins[k] !== undefined);
  oKeys.forEach((k, i) => {
    const encoded = JSON.stringify(origins[k]);
    if (encoded !== undefined) parts.push(JSON.stringify(k) + ': ' + encoded);
    parts.push(i < oKeys.length - 1 ? ',\n' : '\n');
  });
  parts.push('}\n}\n}\n}');
  return { blob: new Blob(parts, { type: 'application/json' }), outName };
}

export function downloadBackupResult(): Promise<void> {
  return withDashboardActivity('download', downloadBackupResultUnlocked);
}

async function downloadBackupResultUnlocked(): Promise<void> {
  const backup = lastBackupForDownload;
  if (!backup) throw new Error('No backup data available.');
  const meta = lastBackupMeta || { encrypt: false, at: 0 };
  const { blob, outName } = buildBackupBlob(backup, meta.encrypt);
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: outName, saveAs: false });
    const sizeBytes = blob.size;
    appendLog(
      `backup downloaded: ${outName} (${(sizeBytes / 1024).toFixed(1)} KB)`
    );
    pushSiteLogEntry({
      seq: 0,
      ts: Date.now(),
      crawlId: 'download',
      level: 'INFO',
      category: 'SYSTEM',
      message: `backup downloaded: ${outName} (${(sizeBytes / 1024).toFixed(1)} KB)`,
      corr: null,
      url: null,
      context: { filename: outName, sizeBytes },
    });
    return;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

// ---------------- site-data retry (Failures page) ----------------

// Re-run a targeted site-data crawl for the given origins (fetch-failed
// URLs) and merge the fresh results into the dashboard state. The retry does
// not touch the main checkpoint (checkpoint: false, resume: false).
export function retrySiteDataUrls(urls: string[]): Promise<void> {
  if (!urls.length) return Promise.resolve();
  return withDashboardActivity('site-data-retry', () =>
    retrySiteDataUrlsUnlocked(urls)
  );
}

async function retrySiteDataUrlsUnlocked(urls: string[]): Promise<void> {
  if (!urls.length) return;
  const base = (lastSiteDataOpts && lastSiteDataOpts.siteData) || {};
  const scanWindowSize =
    base.scanWindowSize ?? (await loadSiteDataScanWindow());
  const tuning = await loadSiteDataTuning();
  patchState('backup', (b) => ({
    ...b,
    visible: true,
    running: true,
    status: `retrying ${urls.length} site(s)…`,
  }));
  try {
    const section = await collectSiteData(
      (msg: string, _frac?: number, stats?: SiteScanStats) => {
        patchState('backup', (b) => ({ ...b, status: msg }));
        if (stats && typeof stats === 'object') {
          // Merge per-URL states into the existing ones (single shared state).
          patchState('backup', (b) => {
            const cur = (b.siteScan && b.siteScan.urlStates) || [];
            const byOrigin = new Map<string, UrlState>(
              cur.map((u) => [u.origin, u])
            );
            for (const u of stats.urlStates || []) {
              const prev = byOrigin.get(u.origin);
              if (!prev) {
                byOrigin.set(u.origin, u);
                continue;
              }
              // A manual retry runs a fresh crawl: keep the last failure
              // visible until the origin actually succeeds, so the failure
              // list doesn't flicker while the retry is in flight.
              const succeeded = u.status === 'saved' || u.status === 'fetched';
              byOrigin.set(
                u.origin,
                succeeded ? u : { ...u, error: u.error ?? prev.error }
              );
            }
            return {
              ...b,
              siteScan: { ...stats, urlStates: [...byOrigin.values()] },
            };
          });
          maybePersistSiteScan();
        }
        appendLog(`retry: ${msg}`);
      },
      {
        ...base,
        includeOrigins: urls,
        scanWindowSize,
        retryMaxAttempts: tuning.retryMaxAttempts,
        readTimeoutMs: tuning.readTimeoutMs,
        checkpointEveryOrigins: tuning.checkpointEveryOrigins,
        resume: false,
        checkpoint: false,
        stopFlag: null,
        onLogEntry: (entry: SiteLogEntry) => pushSiteLogEntry(entry),
      }
    );
    const siteDataSection = normalizeSiteDataSection(section);
    // Merge fresh origins into the last section for the Results page.
    if (lastSiteDataSection) {
      lastSiteDataSection.origins = {
        ...(lastSiteDataSection.origins || {}),
        ...(siteDataSection.origins || {}),
      };
    } else {
      lastSiteDataSection = siteDataSection;
    }
    appendLog(
      `retry finished: ${Object.keys(siteDataSection.origins || {}).length}/${urls.length} origin(s) recovered`
    );
  } finally {
    patchState('backup', (b) => ({ ...b, running: false }));
  }
}

// Re-attempt the checkpoint write for save-failed origins. The data is
// already in memory (lastSiteDataSection.origins) — it only needs re-saving,
// never re-fetching.
export function retrySiteDataSave(): Promise<boolean> {
  return withDashboardActivity('site-data-retry', retrySiteDataSaveUnlocked);
}

async function retrySiteDataSaveUnlocked(): Promise<boolean> {
  const section = lastSiteDataSection;
  if (!section || !section.origins) return false;
  try {
    await chrome.storage.local.set({
      'bbr:site-data-checkpoint': {
        savedAt: Date.now(),
        origins: section.origins,
        states: Object.fromEntries(
          Object.keys(section.origins).map((o) => [o, 'saved'])
        ),
      },
    });
    patchState('backup', (b) => ({
      ...b,
      siteScan: b.siteScan && {
        ...b.siteScan,
        urlStates: b.siteScan.urlStates.map((u) =>
          u.status === 'save-failed'
            ? { ...u, status: 'saved' as const, error: null }
            : u
        ),
      },
    }));
    // Include save-failed -> saved transitions in the persisted snapshot.
    void persistSiteScanNow(false);
    appendLog(
      'retry: checkpoint save succeeded — save-failed origins are now saved'
    );
    return true;
  } catch (e) {
    appendLog(`retry: checkpoint save failed again (${errMessage(e)})`);
    return false;
  }
}

// ---------------- password form ----------------

let passwordResolve: ((v: string | null) => void) | null = null;

export function askPassword(mode: 'new' | 'existing'): Promise<string | null> {
  return new Promise((resolve) => {
    if (passwordResolve) {
      // A password dialog is already pending (e.g. autoStart's
      // ?action=backup-encrypted racing a user click). Fail fast as
      // "cancelled" instead of overwriting the pending resolver — that would
      // leave the first caller hanging forever.
      resolve(null);
      return;
    }
    passwordResolve = resolve;
    setState({ password: { open: true, mode, error: '' } });
  });
}

export function closePassword(result: string | null) {
  setState((s) => ({ password: { ...s.password, open: false } }));
  if (passwordResolve) {
    passwordResolve(result);
    passwordResolve = null;
  }
}

function setPasswordError(error: string) {
  setState((s) => ({ password: { ...s.password, error } }));
}

export function submitPassword(p1: string, p2: string): boolean {
  const mode = getState().password.mode;
  const isNew = mode === 'new';
  if (!p1) {
    setPasswordError('Password is required.');
    return false;
  }
  if (isNew && p1 !== p2) {
    setPasswordError('Passwords do not match.');
    return false;
  }
  if (
    isNew &&
    p1.length < 8 &&
    !confirm('Password is shorter than 8 characters — use it anyway?')
  )
    return false;
  closePassword(p1);
  return true;
}

// ---------------- restore pipeline (UI) ----------------

const CATEGORY_LABELS: Record<string, string> = {
  bookmarks: 'Bookmarks',
  history: 'History',
  tabsWindows: 'Tabs & windows',
  tabGroups: 'Tab groups',
  tabs: 'Tabs',
  windows: 'Windows (layout & position)',
  sessions: 'Sessions (recently closed)',
  sessions_tabs: 'Recently closed tabs',
  sessions_windows: 'Recently closed windows',
  cookies: 'Cookies',
  cookies_plain: 'Cookies (plain)',
  cookies_partitioned: 'Cookies (partitioned)',
  downloads: 'Downloads',
  readingList: 'Reading list',
  extensionStorage: 'Extension storage (own)',
  installedExtensions: 'Installed extensions (metadata)',
  extensionPermissions: 'Extension permissions (own)',
  siteData: 'Website data (storage per origin)',
  siteData_localStorage: 'Website data: Local Storage',
  siteData_indexedDB: 'Website data: IndexedDB',
  siteData_otherStorage: 'Website data: Cache, OPFS, Buckets',
  profile: 'Profile metadata',
};

const RESTORE_HANDLED_CATEGORIES = new Set([
  'bookmarks',
  'history',
  'tabsWindows',
  'sessions',
  'cookies',
  'downloads',
  'readingList',
  'extensionStorage',
  'installedExtensions',
  'siteData',
]);

let pendingRestore: {
  validation: ValidationResult;
  text: string;
  options: Record<string, unknown>;
  targetCapabilities: ReturnType<typeof detect>;
} | null = null;

export function handleFileSelected(file: File): Promise<void> {
  return withDashboardActivity('restore', async () => {
    const text = await file.text();
    await openRestoreFlow(text);
  });
}

export async function openRestoreFlow(
  text: string,
  presetPassword: string | null = null
) {
  patchState('restore', (r) => ({
    ...r,
    sectionVisible: true,
    pickError: null,
    results: [],
  }));
  try {
    let validation: ValidationResult;
    try {
      validation = (await validateBackupFile(text, {
        password: presetPassword,
      })) as ValidationResult;
    } catch (e: unknown) {
      if (errCode(e) === 'ERR_NO_PASSWORD') {
        const pw = await askPassword('existing');
        if (!pw) {
          appendLog('restore cancelled: no password entered');
          return;
        }
        validation = (await validateBackupFile(text, {
          password: pw,
        })) as ValidationResult; // may throw ERR_DECRYPT_FAILED
      } else {
        throw e;
      }
    }
    if (!validation) return;
    pendingRestore = {
      validation,
      text,
      options: {},
      targetCapabilities: detect(),
    };
    renderRestoreSummary();
  } catch (e: unknown) {
    const code = errCode(e) || 'ERROR';
    appendLog(`restore rejected: [${code}] ${errMessage(e)}`);
    patchState('restore', (r) => ({
      ...r,
      pickError: `Cannot open this backup: ${errMessage(e)} (code: ${code})`,
      fileKey: r.fileKey + 1,
      summary: null,
    }));
  }
}

function renderRestoreSummary() {
  const { validation, targetCapabilities } = pendingRestore!;
  const backup = validation.backup;
  const archivedCapabilities = backup.capabilities || {};

  const warnings: string[] = [...(validation.warnings || [])];
  const rows: RestoreRow[] = [];
  for (const [cat, label] of presentRestoreRows(backup.data, CATEGORY_LABELS)) {
    const n = countFromData(backup, cat) ?? countFor(backup, cat);
    // Granular rows resolve to their section: restore handler, capability
    // and archived-capability lookups all use the section key. tabGroups
    // keeps its own capability key (detect() reports it separately).
    const section = sectionForRow(cat);
    const capabilityKey = capabilityKeyForRow(cat);
    const currentCapability = asRecord(targetCapabilities)[capabilityKey] as
      CapabilityDetail | undefined;
    const hasRestoreHandler = RESTORE_HANDLED_CATEGORIES.has(section);
    const targetRestore = isRestoreCapability(currentCapability?.canRestore)
      ? currentCapability.canRestore
      : false;
    const r = hasRestoreHandler ? targetRestore : false;
    const archivedRestore = archivedCapabilities[capabilityKey]?.canRestore;
    if (
      isRestoreCapability(archivedRestore) &&
      archivedRestore !== targetRestore
    ) {
      warnings.push(
        `${label} restore capability in the backup differs from this browser; showing current browser support.`
      );
    }
    let checked: boolean, disabled: boolean, extraNote: string | undefined;
    if (cat === 'tabGroups') {
      // Tab groups are a real, independent toggle now: the user can restore
      // them without restoring tabs & windows. Disabled only when the
      // browser itself cannot restore groups.
      if (r !== false) {
        checked = true;
        disabled = false;
      } else {
        checked = false;
        disabled = true;
        extraNote = 'This browser cannot restore tab groups.';
      }
    } else if (!RESTORE_HANDLED_CATEGORIES.has(section)) {
      checked = false;
      disabled = true;
      extraNote =
        'Informational only; no restore operation is available for this category.';
    } else if (!r) {
      checked = false;
      disabled = true;
      if (cat === 'installedExtensions')
        extraNote = 'Manual reinstall from this backup’s extension checklist.';
    } else if (cat === 'downloads') {
      checked = false;
      disabled = false; // opt-in only
    } else {
      checked = true;
      disabled = false;
    }
    rows.push({
      cat,
      label,
      n: n !== undefined ? String(n) : '—',
      restore: r,
      checked,
      disabled,
      ...(extraNote !== undefined ? { note: extraNote } : {}),
    });
  }

  const notes: string[] = [];

  patchState('restore', (r) => ({
    ...r,
    pickError: null,
    summary: {
      rows,
      encryptedNote: validation.encrypted
        ? `Encrypted backup unlocked successfully (${validation.envelopeMeta?.kdf.name || 'unknown'}, ${validation.envelopeMeta?.kdf.iterations || 0} iterations, ${validation.envelopeMeta?.cipher || 'unknown'}).`
        : null,
      warnings,
      notes,
      options: { bm: false, sd: false, dl: false, sdLive: false },
    },
    results: [],
    progress: { visible: false, frac: 0, status: 'starting…' },
  }));
}

export function toggleRestoreRow(cat: string, checked: boolean) {
  const s = getState();
  const summary = s.restore.summary;
  if (!summary) return;
  const rows = summary.rows.map((r) => (r.cat === cat ? { ...r, checked } : r));
  patchState('restore', { summary: { ...summary, rows } });
}

export function setRestoreOption(
  key: 'bm' | 'sd' | 'dl' | 'sdLive',
  checked: boolean
) {
  // Destructive replace options need an explicit confirmation, exactly like the
  // original window.confirm gates.
  if (checked && (key === 'bm' || key === 'sd')) {
    const msg =
      key === 'bm'
        ? 'Replace mode will DELETE all current bookmarks in the Bookmarks bar and Other bookmarks, then restore the backup tree. Continue?'
        : 'Replace mode will WIPE the website storage (localStorage, IndexedDB, caches, OPFS, buckets) of every origin contained in the backup before restoring it. Continue?';
    if (!confirm(msg)) return;
  }
  // Writing backup data into live tabs changes the user's current browsing
  // state — confirm explicitly, and keep it off by default.
  if (checked && key === 'sdLive') {
    if (
      !confirm(
        "This will write the backup's partitioned website data INTO YOUR CURRENTLY OPEN TABS (where the embedding site is open). The pages may reload their stored data. Continue?"
      )
    )
      return;
  }
  const s = getState();
  if (!s.restore.summary) return;
  patchState('restore', {
    summary: {
      ...s.restore.summary,
      options: { ...s.restore.summary.options, [key]: checked },
    },
  });
}

export function cancelRestoreFlow() {
  pendingRestore = null;
  patchState('restore', (r) => ({
    ...r,
    sectionVisible: false,
    summary: null,
  }));
  appendLog('restore cancelled by user');
}

export function onRestoreGo(): Promise<void> {
  return withDashboardActivity('restore', onRestoreGoUnlocked);
}

async function onRestoreGoUnlocked(): Promise<void> {
  const pending = pendingRestore;
  if (!pending) return;
  try {
    const { validation } = pending;
    const backup = validation.backup;
    const state = getState();
    const summary = state.restore.summary;
    const options: Record<string, RestoreOption> = {};
    if (summary) {
      for (const row of summary.rows) {
        options[row.cat] = {
          enabled: row.checked,
          unavailable: row.disabled && row.restore === false,
        };
      }
      // Section-level synthesis for split sections (tabsWindows, sessions,
      // cookies, siteData): enabled when any member row is on, plus the
      // granular map the restore engine pre-filters on.
      synthesizeSectionOptions(options);
      if (options.bookmarks?.enabled) {
        options.bookmarks = {
          enabled: true,
          mode: summary.options.bm ? 'replace' : 'merge',
          confirmDestructive: summary.options.bm,
        };
      }
      // Trigger: any siteData sub-row is on (not the section entry itself).
      const siteDataSubRowOn = Object.values(
        options.siteData?.granular ?? {}
      ).some((on) => on === true);
      if (siteDataSubRowOn) {
        options.siteData = {
          ...options.siteData,
          enabled: true,
          mode: summary.options.sd ? 'replace' : 'merge',
          confirmDestructive: summary.options.sd,
          allowLiveTabWrite: summary.options.sdLive === true,
        };
      }
      if (options.downloads) {
        options.downloads = {
          enabled: summary.options.dl,
          mode: summary.options.dl ? 'redownload' : 'metadata-only',
        };
      }
    }
    patchState('restore', (r) => ({
      ...r,
      progress: { visible: true, frac: 0.05, status: 'starting…' },
      summary: null,
    }));
    const t0 = performance.now();
    const results = (await restoreAll(backup, options, (m: string) =>
      patchState('restore', (r) => ({
        ...r,
        progress: { ...r.progress, status: m },
      }))
    )) as Record<string, RestoreOutcome>;
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    patchState('restore', (r) => ({
      ...r,
      progress: {
        ...r.progress,
        frac: 1,
        status: `Restore finished in ${secs}s.`,
      },
    }));

    const lines: ResultLine[] = [];
    for (const [cat, res] of Object.entries(results)) {
      lines.push({
        label: CATEGORY_LABELS[cat] || cat,
        outcome: res.outcome,
        ...(res.stats?.outcomeCounts
          ? { outcomeCounts: res.stats.outcomeCounts }
          : {}),
        summary: res.summary,
        notes: (res.stats && res.stats.notes) || [],
      });
    }
    patchState('restore', (r) => ({ ...r, results: lines }));
    appendLog('restore finished');
  } finally {
    if (pendingRestore === pending) pendingRestore = null;
  }
}

// ---------------- capabilities ----------------

export function showCapabilities(): Promise<void> {
  return withDashboardActivity('probes', showCapabilitiesUnlocked);
}

async function showCapabilitiesUnlocked(): Promise<void> {
  patchState('caps', (c) => ({ ...c, visible: true }));
  const rows: CapsRow[] = [];
  for (const [cat, rawCapability] of Object.entries(asRecord(detect()))) {
    const c = capabilityDetail(rawCapability);
    rows.push({
      cat,
      read: !!c.canRead,
      backup: !!c.canBackup,
      restore: c.canRestore ?? false,
      notes: (c.notes || []).join(' '),
    });
  }
  patchState('caps', (c) => ({
    ...c,
    rows,
    status: `Chromium ${getChromeVersion()} · extension v${chrome.runtime.getManifest().version}`,
    probes: 'running probes…',
  }));
  try {
    const probes = await runProbes();
    patchState('caps', (c) => ({
      ...c,
      probes: JSON.stringify(probes, null, 2),
    }));
  } catch (e) {
    patchState('caps', (c) => ({
      ...c,
      probes: 'probe error: ' + errMessage(e),
    }));
  }
}

export async function clearBackupResults(): Promise<boolean> {
  try {
    return await withDashboardActivity('clear-results', async () => {
      const stored = await chrome.storage.local.get('bbr:site-data-checkpoint');
      if (
        Object.hasOwn(stored, 'bbr:site-data-checkpoint') ||
        hasUnresolvedSiteScan(getState().backup.siteScan)
      ) {
        return false;
      }

      await chrome.storage.local.remove('bbr:last-backup');
      if (!getState().restore.summary) pendingRestore = null;
      lastBackupForDownload = null;
      lastBackupMeta = null;
      lastSiteDataOpts = null;
      lastSiteDataSection = null;
      siteScanRun = null;
      void clearSiteScanRecord(chrome.storage?.local ?? null);
      patchState('backup', (backup) => ({
        ...backup,
        visible: false,
        running: false,
        status: 'No backup results.',
        frac: 0,
        summary: [],
        foldersNote: null,
        siteScan: null,
        siteScanMeta: null,
        downloadInfo: { ready: false, siteCount: 0, estBytes: 0 },
      }));
      patchState('restore', (restore) => ({
        ...restore,
        pickError: null,
        progress: { visible: false, frac: 0, status: 'starting…' },
        results: [],
      }));
      return true;
    });
  } catch {
    return false;
  }
}
