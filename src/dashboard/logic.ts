// @ts-nocheck -- Dashboard UI predates strict mode; needs dedicated refactoring pass. Tracked as tech debt.
// Ported dashboard logic (from the original vanilla-JS dashboard.js).
// Heavy backup/restore operations still run in this extension page (NOT in the
// service worker) so MV3 worker lifecycle cannot kill an operation. Every UI
// mutation from the original file becomes a store update; the React components
// render it. window.__api (see api.ts) keeps the exact same programmatic
// surface for the automated test suite — it never logs cookie values or
// passwords.
import { TypedError, errMessage, errCode } from '@/lib/util';
import { newBackupSkeleton, finalizeIntegrity } from '@/lib/format';
import { encryptBackup } from '@/lib/crypto';
import { detect, runProbes, getChromeVersion } from '@/lib/capabilities';
import { collectAll, computeCounts } from '@/lib/collect';
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
} from './store';
import {
  loadBackupCategories,
  loadIncludedSiteOrigins,
  loadSiteDataScanWindow,
  loadSiteDataTuning,
  loadSiteDataInclude,
} from './backup-categories';
import { collectSiteData } from '@/lib/sitedata';
import { pushSiteLogEntry } from './site-log-store';

// ---------------- metadata ----------------

export function generatorInfo() {
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

// Stop flag for the running backup (dashboard Stop button). The site-data
// crawl polls it and halts safely: owned scan tabs are closed via
// safeCloseTab (safety net), partial results are kept.
let backupStopFlag: { stop: boolean } | null = null;
export function requestBackupStop() {
  if (backupStopFlag) backupStopFlag.stop = true;
}

// Last site-data options + section, for the Failures page retry buttons.
let lastSiteDataOpts: any = null;
let lastSiteDataSection: any = null;

export async function buildBackupObject(onProgress?: (m: string) => void, collectOptions?: any) {
  const selectedCategories = collectOptions?.selectedCategories ?? (await loadBackupCategories());
  const includedOrigins = collectOptions?.siteData?.includeOrigins ?? (await loadIncludedSiteOrigins());
  const scanWindowSize = collectOptions?.siteData?.scanWindowSize ?? (await loadSiteDataScanWindow());
  const tuning = collectOptions?.siteData?.tuning ?? (await loadSiteDataTuning());
  const siteDataInclude = await loadSiteDataInclude();
  const effectiveCollectOptions = {
    ...(collectOptions || {}),
    selectedCategories,
    siteData: {
      ...(collectOptions?.siteData || {}),
      scanWindowSize,
      ...(includedOrigins === null ? {} : { includeOrigins: includedOrigins }),
      retryMaxAttempts: collectOptions?.siteData?.retryMaxAttempts ?? tuning.retryMaxAttempts,
      readTimeoutMs: collectOptions?.siteData?.readTimeoutMs ?? tuning.readTimeoutMs,
      checkpointEveryOrigins: collectOptions?.siteData?.checkpointEveryOrigins ?? tuning.checkpointEveryOrigins,
      includeSessionStorage: siteDataInclude.sessionStorage,
      includeServiceWorkers: siteDataInclude.serviceWorkers,
      excludedSiteDataCategories: [
        ...(siteDataInclude.sessionStorage ? [] : ['sessionStorage']),
        ...(siteDataInclude.serviceWorkers ? [] : ['serviceWorkers']),
      ],
      stopFlag: backupStopFlag,
      onLogEntry: (entry: any) => pushSiteLogEntry(entry),
    },
  };
  lastSiteDataOpts = effectiveCollectOptions;
  patchState('backup', (b) => ({ ...b, siteScan: null }));
  appendLog(`backup starting: categories=[${selectedCategories.join(', ')}]`);
  const result: any = await collectAll((msg: string, cat?: string, _state?: string, frac?: number, stats?: any) => {
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
      patchState('backup', (b) => ({ ...b, siteScan: stats as SiteScanStats }));
    }
  }, effectiveCollectOptions);
  const { data, capabilities, categoryStatus } = result;
  // Only categories that were actually & successfully read go into the backup.
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (categoryStatus[k] && categoryStatus[k].ok) clean[k] = v;
    else {
      const st = categoryStatus[k] || {};
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
        context: { category: k, error: String(st.error || ''), stack: String(st.stack || '') },
      });
      if (st.stack) appendLog(`collect: "${k}" stack:\n${st.stack}`);
    }
  }
  const backup = newBackupSkeleton(capabilities, generatorInfo());
  backup.data = clean;
  backup.counts = computeCounts(clean);
  await finalizeIntegrity(backup);
  lastSiteDataSection = (data as any)?.siteData || null;
  return { backup, categoryStatus };
}

export async function saveTextFile(text: string, name: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({ url, filename: name, saveAs: false });
    // Wait for completion so callers can read the file from disk immediately.
    for (let i = 0; i < 600; i++) {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (item && (item.state === 'complete' || item.state === 'interrupted')) {
        if (item.state === 'interrupted')
          throw new TypedError(
            'ERR_DOWNLOAD_INTERRUPTED',
            `Saving backup file failed: ${(item as any).interruptReason || 'unknown'}`
          );
        return { downloadId, filename: item.filename, sizeBytes: item.fileSize || text.length };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new TypedError('ERR_DOWNLOAD_TIMEOUT', 'Timed out waiting for the backup file to be saved.');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

export async function doBackup({
  encrypt = false,
  password = null,
  collectOptions = null,
}: { encrypt?: boolean; password?: string | null; collectOptions?: any } = {}) {
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
  setState((s) => ({ password: { ...s.password, open: false } }));
  const t0 = performance.now();

  try {
    const { backup, categoryStatus } = await buildBackupObject(
      (m) => patchState('backup', (b) => ({ ...b, status: m })),
      collectOptions
    );
    if (backupStopFlag?.stop) {
      patchState('backup', (b) => ({
        ...b,
        status: 'dihentikan pengguna — partial results kept, resume to continue the rest.',
      }));
      appendLog('backup stopped by user; no file written');
      // Keep the partial backup for download (user can download what exists).
      storeBackupForDownload(backup, encrypt, password);
      return null;
    }
    patchState('backup', (b) => ({ ...b, frac: 0.7, status: 'preparing…' }));

    // No auto-download: the result stays in extension storage. The user
    // downloads explicitly via the "Download hasil" button.
    storeBackupForDownload(backup, encrypt, password);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const siteCount = backup?.data?.siteData ? Object.keys(backup.data.siteData.origins || {}).length : 0;
    patchState('backup', (b) => ({
      ...b,
      frac: 1,
      status: `Backup selesai dalam ${secs}s — tersimpan di penyimpanan ekstensi. Klik "Download hasil" untuk mengunduh file.`,
    }));

    const counts: any = backup.counts || {};
    const cap: any = backup.capabilities || {};
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
      installedExtensions: ['Installed extensions (metadata)', 'installedExtensions'],
      extensionPermissions: ['Extension permissions (own)', 'extensionPermissions'],
      profile: ['Browser profile', 'profile'],
      siteData: ['Website data (localStorage/IndexedDB/CacheStorage/OPFS/Buckets)', 'siteDataOrigins'],
    };
    const summary: SummaryLine[] = [];
    for (const [key, [label, countKey]] of Object.entries(labelMap)) {
      if (!(countKey in counts)) {
        // Show failed categories instead of silently omitting them.
        const st = (categoryStatus as any)?.[key];
        if (st && !st.ok && !st.skipped) {
          summary.push({ label: `${label} — GAGAL (error)`, count: String(st.error || 'unknown'), pill: 'error' });
        }
        continue;
      }
      const r = cap[key] ? cap[key].canRestore : false;
      const pill = (r === 'full' ? 'full' : r === 'partial' ? 'partial' : 'no') as 'full' | 'partial' | 'no';
      summary.push({ label, count: String(counts[countKey]), pill });
    }
    const foldersNote = counts.bookmarkFolders ? `plus ${counts.bookmarkFolders} bookmark folders` : null;
    patchState('backup', (b) => ({ ...b, summary, foldersNote }));
    appendLog(`backup finished and stored in extension storage (no auto-download)`);
    return { backup };
  } finally {
    backupStopFlag = null;
    patchState('backup', (b) => ({ ...b, running: false }));
  }
}

// ---------------- download on demand (no auto-download) ----------------

// The last backup is kept in memory and (if it fits) in chrome.storage.local.
// Download happens ONLY when the user clicks "Download hasil".
let lastBackupForDownload: any = null;
let lastBackupMeta: { encrypt: boolean; at: number; isEnvelope?: boolean } | null = null;
export function isBackupEnvelopeReady(): boolean {
  return !!(lastBackupMeta as any)?.isEnvelope;
}

function storeBackupForDownload(backup: any, encrypt: boolean, password: string | null) {
  lastBackupForDownload = backup;
  lastBackupMeta = { encrypt, at: Date.now() };
  // If encrypted, pre-build the envelope now (password is available here;
  // we never store the password itself).
  if (encrypt && password) {
    encryptBackup(backup, password)
      .then((env) => {
        lastBackupForDownload = env;
        lastBackupMeta = { encrypt: true, at: Date.now(), isEnvelope: true } as any;
        updateDownloadInfo();
      })
      .catch(() => {});
  }
  // Best-effort persist to extension storage (may exceed quota for huge backups).
  try {
    chrome.storage.local.set({ 'bbr:last-backup': { backup, encrypt, at: Date.now() } }).catch(() => {});
  } catch (e) {
    /* ignore */
  }
  updateDownloadInfo();
}

export function getDownloadInfo(): { ready: boolean; siteCount: number; estBytes: number } {
  const b = lastBackupForDownload;
  if (!b) return { ready: false, siteCount: 0, estBytes: 0 };
  const origins = b?.data?.siteData?.origins || {};
  const siteCount = Object.keys(origins).length;
  // Estimate without building the full string: sample-based.
  let estBytes = 0;
  try {
    const keys = Object.keys(origins);
    const sample = keys.slice(0, 5);
    let sampleBytes = 0;
    for (const k of sample) sampleBytes += JSON.stringify(origins[k]).length;
    const avg = sample.length ? sampleBytes / sample.length : 0;
    estBytes = Math.round(
      avg * keys.length + JSON.stringify({ ...b, data: { ...b.data, siteData: { origins: {} } } }).length
    );
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
function buildBackupBlob(backup: any, encrypt: boolean, password: string | null): { blob: Blob; outName: string } {
  let payload: any = backup;
  let outName: string;
  const meta = lastBackupMeta as any;
  if (meta?.isEnvelope) {
    // Already encrypted (envelope built at backup time).
    outName = fileName('backup.enc.json');
    return { blob: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), outName };
  }
  if (encrypt) {
    throw new Error('Encrypted download needs the password — run backup with encryption first.');
  }
  outName = fileName('backup.json');
  const parts: string[] = ['{\n'];
  const data = payload.data || {};
  const topKeys = Object.keys(payload).filter((k) => k !== 'data');
  topKeys.forEach((k, i) => {
    parts.push(JSON.stringify(k) + ': ' + JSON.stringify((payload as any)[k]));
    parts.push(',\n');
  });
  parts.push('"data": {\n');
  const dataKeys = Object.keys(data).filter((k) => k !== 'siteData');
  dataKeys.forEach((k) => {
    parts.push(JSON.stringify(k) + ': ' + JSON.stringify((data as any)[k]) + ',\n');
  });
  // siteData: stream origins one by one.
  const siteData = data.siteData || {};
  parts.push('"siteData": {\n');
  const sdKeys = Object.keys(siteData).filter((k) => k !== 'origins');
  sdKeys.forEach((k) => {
    parts.push(JSON.stringify(k) + ': ' + JSON.stringify((siteData as any)[k]) + ',\n');
  });
  parts.push('"origins": {\n');
  const origins = siteData.origins || {};
  const oKeys = Object.keys(origins);
  oKeys.forEach((k, i) => {
    parts.push(JSON.stringify(k) + ': ' + JSON.stringify(origins[k]));
    parts.push(i < oKeys.length - 1 ? ',\n' : '\n');
  });
  parts.push('}\n}\n}\n}');
  return { blob: new Blob(parts, { type: 'application/json' }), outName };
}

export async function downloadBackupResult(): Promise<void> {
  const backup = lastBackupForDownload;
  if (!backup) throw new Error('No backup data available.');
  const meta = lastBackupMeta || { encrypt: false, at: 0 };
  const { blob, outName } = buildBackupBlob(backup, meta.encrypt, null);
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({ url, filename: outName, saveAs: false });
    const sizeBytes = blob.size;
    appendLog(`backup downloaded: ${outName} (${(sizeBytes / 1024).toFixed(1)} KB)`);
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
export async function retrySiteDataUrls(urls: string[]): Promise<void> {
  if (!urls.length) return;
  const base = (lastSiteDataOpts && lastSiteDataOpts.siteData) || {};
  const scanWindowSize = base.scanWindowSize ?? (await loadSiteDataScanWindow());
  const tuning = await loadSiteDataTuning();
  patchState('backup', (b) => ({ ...b, visible: true, running: true, status: `retrying ${urls.length} site(s)…` }));
  try {
    const section: any = await collectSiteData(
      (msg: string, frac?: number, stats?: SiteScanStats) => {
        patchState('backup', (b) => ({ ...b, status: msg }));
        if (stats && typeof stats === 'object') {
          // Merge per-URL states into the existing ones (single shared state).
          patchState('backup', (b) => {
            const cur = (b.siteScan && b.siteScan.urlStates) || [];
            const byOrigin = new Map<string, UrlState>(cur.map((u) => [u.origin, u]));
            for (const u of stats.urlStates || []) byOrigin.set(u.origin, u);
            return { ...b, siteScan: { ...stats, urlStates: [...byOrigin.values()] } };
          });
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
        onLogEntry: (entry: any) => pushSiteLogEntry(entry),
      }
    );
    // Merge fresh origins into the last section for the Results page.
    if (lastSiteDataSection) {
      lastSiteDataSection.origins = { ...(lastSiteDataSection.origins || {}), ...(section.origins || {}) };
    } else {
      lastSiteDataSection = section;
    }
    appendLog(`retry finished: ${Object.keys(section.origins || {}).length}/${urls.length} origin(s) recovered`);
  } finally {
    patchState('backup', (b) => ({ ...b, running: false }));
  }
}

// Re-attempt the checkpoint write for save-failed origins. The data is
// already in memory (lastSiteDataSection.origins) — it only needs re-saving,
// never re-fetching.
export async function retrySiteDataSave(): Promise<boolean> {
  const section = lastSiteDataSection;
  if (!section || !section.origins) return false;
  try {
    await chrome.storage.local.set({
      'bbr:site-data-checkpoint': {
        savedAt: Date.now(),
        origins: section.origins,
        states: Object.fromEntries(Object.keys(section.origins).map((o) => [o, 'saved'])),
      },
    });
    patchState('backup', (b) => ({
      ...b,
      siteScan: b.siteScan && {
        ...b.siteScan,
        urlStates: b.siteScan.urlStates.map((u) =>
          u.status === 'save-failed' ? { ...u, status: 'saved' as const, error: null } : u
        ),
      },
    }));
    appendLog('retry: checkpoint save succeeded — save-failed origins are now saved');
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
    passwordResolve = resolve;
    setState((s) => ({ password: { open: true, mode, error: '' } }));
  });
}

export function closePassword(result: string | null) {
  setState((s) => ({ password: { ...s.password, open: false } }));
  if (passwordResolve) {
    passwordResolve(result);
    passwordResolve = null;
  }
}

export function setPasswordError(error: string) {
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
  if (isNew && p1.length < 8 && !confirm('Password is shorter than 8 characters — use it anyway?')) return false;
  closePassword(p1);
  return true;
}

// ---------------- restore pipeline (UI) ----------------

export const CATEGORY_LABELS: Record<string, string> = {
  bookmarks: 'Bookmarks',
  history: 'History',
  tabsWindows: 'Tabs & windows',
  tabGroups: 'Tab groups',
  sessions: 'Sessions (recently closed)',
  cookies: 'Cookies',
  downloads: 'Downloads',
  readingList: 'Reading list',
  extensionStorage: 'Extension storage (own)',
  installedExtensions: 'Installed extensions (metadata)',
  extensionPermissions: 'Extension permissions (own)',
  siteData: 'Website data (storage per origin)',
  profile: 'Profile metadata',
};

function countFor(backup: any, cat: string): string | undefined {
  const c = backup.counts || {};
  switch (cat) {
    case 'tabGroups':
      return c.tabGroups;
    case 'bookmarks':
      return c.bookmarks;
    case 'history':
      return c.history;
    case 'tabsWindows':
      return c.tabs;
    case 'sessions':
      return c.recentlyClosedSessions;
    case 'cookies':
      return c.cookies;
    case 'downloads':
      return c.downloads;
    case 'readingList':
      return c.readingList;
    case 'installedExtensions':
      return c.installedExtensions;
    case 'siteData':
      return c.siteDataOrigins !== undefined ? `${c.siteDataOrigins} origins` : undefined;
    default:
      return undefined;
  }
}

function presentCategories(backup: any): Array<[string, string]> {
  const data = backup.data || {};
  const cats: Array<[string, string]> = [];
  for (const [cat, label] of Object.entries(CATEGORY_LABELS)) {
    if (cat === 'tabGroups') {
      if (data.tabsWindows && data.tabsWindows.tabGroups) cats.push([cat, label]);
      continue;
    }
    if (cat === 'extensionPermissions' || cat === 'profile') continue; // informational, no restore action
    if (data[cat]) cats.push([cat, label]);
  }
  return cats;
}

let pendingRestore: { validation: any; text: string; options: Record<string, unknown> } | null = null;

export async function handleFileSelected(file: File) {
  const text = await file.text();
  await openRestoreFlow(text);
}

export async function openRestoreFlow(text: string, presetPassword: string | null = null) {
  patchState('restore', (r) => ({ ...r, sectionVisible: true, pickError: null, results: [] }));
  try {
    let validation;
    try {
      validation = await validateBackupFile(text, { password: presetPassword });
    } catch (e: any) {
      if (e.code === 'ERR_NO_PASSWORD') {
        const pw = await askPassword('existing');
        if (!pw) {
          appendLog('restore cancelled: no password entered');
          return;
        }
        validation = await validateBackupFile(text, { password: pw }); // may throw ERR_DECRYPT_FAILED
      } else {
        throw e;
      }
    }
    if (!validation) return;
    pendingRestore = { validation, text, options: {} };
    renderRestoreSummary();
  } catch (e: any) {
    appendLog(`restore rejected: [${e.code || 'ERROR'}] ${errMessage(e)}`);
    patchState('restore', (r) => ({
      ...r,
      pickError: `Cannot open this backup: ${errMessage(e)} (code: ${e.code || 'ERROR'})`,
      fileKey: r.fileKey + 1,
      summary: null,
    }));
  }
}

function renderRestoreSummary() {
  const { validation } = pendingRestore!;
  const backup = validation.backup;
  const caps: any = backup.capabilities || {};

  const rows: RestoreRow[] = [];
  for (const [cat, label] of presentCategories(backup)) {
    const n = countFor(backup, cat);
    const capCat = cat === 'tabGroups' ? caps.tabGroups : caps[cat];
    const r = capCat ? capCat.canRestore : false;
    let checked: boolean, disabled: boolean, extraNote: string | undefined;
    if (cat === 'tabGroups') {
      // Groups are restored together with tabs & windows (same API surface).
      checked = true;
      disabled = true;
      extraNote = 'Restored together with Tabs & windows';
    } else if (!r) {
      checked = false;
      disabled = true;
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
      restore: r as any,
      checked,
      disabled,
      note: extraNote,
    });
  }

  const warnings: string[] = [...(validation.warnings || [])];
  const notes: string[] = [];
  if (caps.history) notes.push('History is preserved in the backup but cannot be restored (no write API).');
  if (caps.installedExtensions) notes.push('Installed extensions: restore = manual reinstall from the checklist.');

  patchState('restore', (r) => ({
    ...r,
    pickError: null,
    summary: {
      rows,
      encryptedNote: validation.encrypted
        ? `Encrypted backup unlocked successfully (${validation.envelopeMeta.kdf.name}, ${validation.envelopeMeta.kdf.iterations} iterations, ${validation.envelopeMeta.cipher}).`
        : null,
      warnings,
      notes,
      options: { bm: false, sd: false, dl: false },
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

export function setRestoreOption(key: 'bm' | 'sd' | 'dl', checked: boolean) {
  // Destructive replace options need an explicit confirmation, exactly like the
  // original window.confirm gates.
  if (checked && (key === 'bm' || key === 'sd')) {
    const msg =
      key === 'bm'
        ? 'Replace mode will DELETE all current bookmarks in the Bookmarks bar and Other bookmarks, then restore the backup tree. Continue?'
        : 'Replace mode will WIPE the website storage (localStorage, IndexedDB, caches, OPFS, buckets) of every origin contained in the backup before restoring it. Continue?';
    if (!confirm(msg)) return;
  }
  const s = getState();
  if (!s.restore.summary) return;
  patchState('restore', {
    summary: { ...s.restore.summary, options: { ...s.restore.summary.options, [key]: checked } },
  });
}

export function cancelRestoreFlow() {
  pendingRestore = null;
  patchState('restore', (r) => ({ ...r, sectionVisible: false, summary: null }));
  appendLog('restore cancelled by user');
}

export async function onRestoreGo() {
  if (!pendingRestore) return;
  const { validation } = pendingRestore;
  const backup = validation.backup;
  const state = getState();
  const summary = state.restore.summary;
  const options: Record<string, unknown> = {};
  if (summary) {
    for (const row of summary.rows) {
      options[row.cat] = { enabled: row.checked };
    }
    if (options.bookmarks && (options.bookmarks as any).enabled) {
      options.bookmarks = {
        enabled: true,
        mode: summary.options.bm ? 'replace' : 'merge',
        confirmDestructive: summary.options.bm,
      };
    }
    if (options.siteData && (options.siteData as any).enabled) {
      options.siteData = {
        enabled: true,
        mode: summary.options.sd ? 'replace' : 'merge',
        confirmDestructive: summary.options.sd,
      };
    }
    if (options.downloads) {
      options.downloads = { enabled: summary.options.dl, mode: summary.options.dl ? 'redownload' : 'metadata-only' };
    }
  }
  patchState('restore', (r) => ({ ...r, progress: { visible: true, frac: 0.05, status: 'starting…' }, summary: null }));
  const t0 = performance.now();
  const results = await restoreAll(backup, options, (m: string) =>
    patchState('restore', (r) => ({ ...r, progress: { ...r.progress, status: m } }))
  );
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  patchState('restore', (r) => ({
    ...r,
    progress: { ...r.progress, frac: 1, status: `Restore finished in ${secs}s.` },
  }));

  const lines: ResultLine[] = [];
  for (const [cat, res] of Object.entries(results) as Array<[string, any]>) {
    const cls = res.status === 'ok' ? 'ok' : res.status === 'unsupported' ? 'warn' : 'err';
    lines.push({
      label: CATEGORY_LABELS[cat] || cat,
      cls,
      summary: res.summary,
      notes: (res.stats && res.stats.notes) || [],
    });
  }
  patchState('restore', (r) => ({ ...r, results: lines }));
  appendLog('restore finished');
}

// ---------------- capabilities ----------------

export async function showCapabilities() {
  patchState('caps', (c) => ({ ...c, visible: true }));
  const caps = detect();
  const rows: CapsRow[] = [];
  for (const [cat, c] of Object.entries(caps) as Array<[string, any]>) {
    rows.push({
      cat,
      read: !!c.canRead,
      backup: !!c.canBackup,
      restore: c.canRestore as any,
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
    patchState('caps', (c) => ({ ...c, probes: JSON.stringify(probes, null, 2) }));
  } catch (e) {
    patchState('caps', (c) => ({ ...c, probes: 'probe error: ' + errMessage(e) }));
  }
}

// re-export so cloud-ui/init and components can share the same logger
export { appendLog, getState as appState };
export const errText = errMessage;
export const errOf = errCode;
export type { TypedError };
