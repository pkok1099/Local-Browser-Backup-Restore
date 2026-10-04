// Site-data backup/restore orchestration: localStorage, sessionStorage,
// IndexedDB, Cache Storage, Service Workers, OPFS, Storage Buckets and
// partitioned (third-party iframe) storage — for EVERY origin, not just open
// tabs. Runs in the dashboard (extension page) using:
//   - chrome.debugger (CDP Runtime.evaluate) to execute lib/pagelib.js in the
//     page's MAIN world — the only path with full storage reachability
//     (the CDP DOMStorage/IndexedDB/ServiceWorker domains are blocked through
//     chrome.debugger; Runtime.evaluate is allowed — research-proven);
//   - chrome.scripting (allFrames) for partitioned frame storage, which the
//     debugger cannot reach (OOPIF targets are invisible to it).
//
// Data crosses the debugger boundary as chunked JSON text (ASCII-safe), which
// sidesteps the proven lone-surrogate corruption of raw returnByValue.
//
// UX contract: attaching the debugger briefly shows Chrome's "started
// debugging" infobar. Collection streams origins through two workers bounded
// by a hard tab window (SITE_DATA_CONFIG.window, user-configurable): Worker 1 opens
// tabs straight into the single "BBR Site Scan" tab group, Worker 2 reads
// them with bounded concurrency and closes each tab, releasing its slot.
// Progress callbacks carry (message, frac, stats) with frac 0..1 inside the
// siteData phase, so the dashboard progress bar tracks the scan accurately,
// and stats carries the live counters (tabs in group, slots, done/failed,
// window).

import { yieldToUI, TypedError } from './util.js';
import { createSiteLogger } from './site-log.js';
import { SITE_DATA_CONFIG } from './scan-config.js';
import {
  SCAN_MARKER,
  scanUrlFor,
  originOf,
  createTabOwnership,
  verifyScanTab,
  createSiteDataOwnership,
  cleanupPreviousSessionTabs,
} from './tab-ownership.js';
import {
  createGroupManager,
  SCAN_ERROR_GROUP_TITLE,
  SCAN_ERROR_GROUP_COLOR,
} from './scan-groups.js';
import {
  applyScanBlocking,
  clearScanBlocking,
  clearAllScanBlocking,
} from './scan-resource-blocking.js';
import {
  clampScanWindow,
  clampInt,
  createSlotPool,
  createAsyncQueue,
  createLoadMonitor,
  startCpuMonitor,
  createSystemCpuSampler,
} from './scan-concurrency.js';

// Re-exported public surface: the factories above live in focused modules;
// re-exported here so every existing importer keeps working unchanged.
export {
  SITE_DATA_CONFIG,
  createTabOwnership,
  verifyScanTab,
  createSiteDataOwnership,
  cleanupPreviousSessionTabs,
  createSlotPool,
  createLoadMonitor,
  startCpuMonitor,
};

const CH = 256 * 1024; // transport chunk size (chars)

// parsed hostname via new URL() — never on URL substrings — so a query like
// ?q=localhost does not false-positive. Applies to any port and http/https.
export function isExcluded(rawUrl) {
  const cfg = SITE_DATA_CONFIG.excluded;
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    return { excluded: true, reason: 'unparseable URL' };
  }
  const scheme = (u.protocol || '').toLowerCase();
  if (cfg.schemes.includes(scheme)) {
    return { excluded: true, reason: `non-web scheme ${scheme}` };
  }
  const host = (u.hostname || '').toLowerCase();
  if (!host) return { excluded: true, reason: 'empty hostname' };
  for (const h of cfg.hosts) {
    if (host === h.toLowerCase())
      return { excluded: true, reason: `excluded host ${h}` };
  }
  for (const s of cfg.hostSuffixes) {
    if (host.endsWith(s.toLowerCase()))
      return { excluded: true, reason: `excluded host suffix ${s}` };
  }
  for (const p of cfg.hostPrefixes) {
    // Only IPv4 literals (192.0.0.0/8, 127.0.0.0/8), not hostnames like
    // 192.example.com.
    const parts = host.split('.');
    const isV4 =
      parts.length === 4 &&
      parts.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255);
    if (host.startsWith(p.toLowerCase()) && isV4)
      return { excluded: true, reason: `excluded IPv4 range ${p}*` };
  }
  return { excluded: false, reason: '' };
}

let PAGELIB_SRC = null;
async function getPagelib() {
  if (!PAGELIB_SRC) {
    PAGELIB_SRC = await (
      await fetch(chrome.runtime.getURL('lib/pagelib.js'))
    ).text();
  }
  return PAGELIB_SRC;
}

const isHttpUrl = (u) => /^https?:\/\//i.test(u || '');

// ---------------- origin discovery ----------------

export async function discoverOrigins(_progress) {
  const found = new Map(); // origin -> source tag
  const add = (url, src) => {
    if (!isHttpUrl(url)) return;
    const o = originOf(url);
    if (!o) return;
    const prev = found.get(o);
    if (!prev) found.set(o, [src]);
    else if (!prev.includes(src)) prev.push(src);
  };
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) if (!t.incognito) add(t.url, 'tab');
  } catch (e) {
    /* ignore */
  }
  try {
    const hist = await chrome.history.search({
      text: '',
      startTime: 0,
      maxResults: 10000,
    });
    for (const h of hist) add(h.url, 'history');
  } catch (e) {
    /* ignore */
  }
  try {
    if (chrome.bookmarks) {
      const tree = await chrome.bookmarks.getTree();
      const walk = (nodes) => {
        for (const n of nodes || []) {
          if (n.url) add(n.url, 'bookmarks');
          walk(n.children);
        }
      };
      for (const r of tree) walk(r.children || []);
    }
  } catch (e) {
    /* ignore */
  }
  try {
    if (chrome.readingList) {
      const entries =
        typeof chrome.readingList.query === 'function'
          ? await chrome.readingList.query({})
          : [];
      for (const e of entries) add(e.url, 'readingList');
    }
  } catch (e) {
    /* ignore */
  }
  try {
    const stores = await chrome.cookies.getAllCookieStores();
    for (const st of stores) {
      if (st.id !== '0') continue;
      const cookies = await chrome.cookies.getAll({ storeId: st.id });
      for (const c of cookies) {
        if (c.domain.startsWith('.'))
          add(`https://${c.domain.slice(1)}/`, 'cookie-domain');
        else add(`https://${c.domain}/`, 'cookie-host');
      }
      if (typeof chrome.cookies.getAllDefaultPartitionKey === 'function') {
        try {
          const keys = await chrome.cookies.getAllDefaultPartitionKey();
          for (const k of keys || [])
            if (k.topLevelSite) add(k.topLevelSite, 'chips-partition');
        } catch (e) {
          /* optional API */
        }
      }
    }
  } catch (e) {
    /* ignore */
  }
  const origins = [...found.keys()].sort();
  return {
    origins: origins.map((o) => ({ origin: o, sources: found.get(o) })),
    truncated: false,
  };
}

// ---------------- tab + debugger plumbing ----------------

// Progress listeners must never break collection: a throwing listener would
// otherwise abort the scan midway and leak tabs.
function safeProgress(progress, msg, frac, stats) {
  if (!progress) return;
  try {
    progress(msg, frac, stats);
  } catch (e) {
    /* listener error — ignore */
  }
}

// Find an existing open (non-incognito) tab for the origin, if any.
async function findOpenTab(origin) {
  const pattern = `${origin}/*`;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: pattern });
  } catch (e) {
    /* pattern unsupported */
  }
  if (!tabs.length) {
    try {
      const all = await chrome.tabs.query({});
      tabs = all.filter((t) => originOf(t.url) === origin);
    } catch (e) {
      /* ignore */
    }
  }
  return tabs.find((t) => !t.incognito) || null;
}

// Wait until a freshly created tab actually navigated to the target origin —
// a new tab reports status 'complete' for about:blank BEFORE the navigation
// starts. Returns false when the tab vanished, the load timed out, or
// isCancelled() becomes true (e.g. the user pressed Stop). Also bails out
// early when the tab committed to a page that can never become the origin
// (the site redirected the marker URL away, e.g. to a cross-origin error
// page): waiting the full timeout cannot help, so fail fast and let the
// caller close the tab via the ownership verifier instead of leaking it.
export async function waitTabReady(tabId, origin, isCancelled) {
  const t0 = Date.now();
  let foreignSince = 0;
  for (;;) {
    if (typeof isCancelled === 'function' && isCancelled()) return false;
    try {
      const t = await chrome.tabs.get(tabId);
      const url = t.url || '';
      if (t.status === 'complete' && url !== '' && url !== 'about:blank') {
        if (url.startsWith(origin)) return true;
        // The site redirected the marker away. It might bounce back (SSO /
        // challenge flow), so only give up once the foreign page has been
        // stable for redirectGraceMs — a definitive error page never comes
        // back, and this still fails fast instead of burning the 20s timeout.
        if (!foreignSince) foreignSince = Date.now();
        else if (Date.now() - foreignSince > SITE_DATA_CONFIG.redirectGraceMs)
          return false;
      } else {
        foreignSince = 0; // transient state — a new navigation may still land
      }
    } catch (e) {
      return false;
    } // tab vanished
    if (Date.now() - t0 > SITE_DATA_CONFIG.tabLoadTimeoutMs) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function findOrCreateTab(origin, progress) {
  let tab = await findOpenTab(origin);
  let created = false;
  if (!tab) {
    if (progress) progress(`sitedata: opening tab for ${origin}`);
    tab = await chrome.tabs.create({ url: scanUrlFor(origin), active: false });
    created = true;
    await waitTabReady(tab.id, origin);
    // small settle delay so the document is fully interactive
    await new Promise((r) => setTimeout(r, 250));
  }
  return { tab, created };
}

function attach(tabId) {
  return new Promise((res) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      const err = chrome.runtime.lastError;
      res(err ? { ok: false, error: err.message } : { ok: true });
    });
  });
}
function detach(tabId) {
  return new Promise((res) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      res(true);
    });
  });
}
function sendCommand(dbg, method, params) {
  return new Promise((res) => {
    chrome.debugger.sendCommand(dbg, method, params || {}, (r) => {
      const err = chrome.runtime.lastError;
      if (err) res({ ok: false, error: err.message });
      else res({ ok: true, result: r });
    });
  });
}
// Normalize chrome.debugger's inconsistent RemoteObject envelopes.
function unremote(r) {
  let v = r;
  if (
    v &&
    typeof v === 'object' &&
    Object.keys(v).length === 1 &&
    'result' in v
  )
    v = v.result;
  if (v && typeof v === 'object' && 'type' in v && 'value' in v) v = v.value;
  return v;
}

// Runs an async page expression whose RESULT is a JSON string stored via
// __BBR.setTx; pulls it in chunks (ASCII-safe) and parses here.
async function evalJsonViaTx(dbg, asyncExpr) {
  const start = await sendCommand(dbg, 'Runtime.evaluate', {
    expression: `(async () => { ${asyncExpr} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (!start.ok) throw new TypedError('ERR_SITE_EVAL', start.error);
  const exc = start.result && start.result.exceptionDetails;
  if (exc) {
    throw new TypedError(
      'ERR_SITE_EVAL',
      'page exception: ' +
        ((exc.exception && exc.exception.description) || exc.text || 'unknown')
    );
  }
  const len = Number(
    unremote(
      start.result && start.result.result ? start.result.result : start.result
    )
  );
  if (!Number.isFinite(len))
    throw new TypedError('ERR_SITE_EVAL', 'transport length not returned');
  let json = '';
  for (let i = 0; i < len; i += CH) {
    const r = await sendCommand(dbg, 'Runtime.evaluate', {
      expression: `__BBR.txChunk(${i}, ${CH})`,
      returnByValue: true,
    });
    if (!r.ok) throw new TypedError('ERR_SITE_EVAL', r.error);
    json += unremote(r.result);
  }
  const clr = await sendCommand(dbg, 'Runtime.evaluate', {
    expression: '__BBR.clearTx()',
  });
  if (!clr.ok) {
    /* non-fatal */
  }
  return JSON.parse(json);
}

async function injectPagelib(dbg, lib) {
  const expr = `globalThis.__BBR_READY = false; ${lib}; globalThis.__BBR_READY = true;`;
  const r = await sendCommand(dbg, 'Runtime.evaluate', { expression: expr });
  if (!r.ok) throw new TypedError('ERR_SITE_LIB', r.error);
}

// ---------------- per-origin backup ----------------

// Read one origin's storage snapshot through the debugger attached to its
// tab. The tab must already exist and be loaded (see openOne).
async function readTabSnapshot(tabId, lib, opts) {
  const att = await attach(tabId);
  if (!att.ok) throw new TypedError('ERR_DEBUGGER_ATTACH', att.error);
  const dbg = { tabId };
  try {
    await injectPagelib(dbg, lib);
    const snapshot = await evalJsonViaTx(
      dbg,
      `
      const r = await __BBR.readSiteAll({ fetchScript: ${!!opts.fetchScript}, opfs: ${opts.opfs !== false}, buckets: ${opts.buckets !== false}, sessionStorage: ${opts.sessionStorage !== false}, serviceWorkers: ${opts.serviceWorkers !== false}, localStorage: ${opts.localStorage !== false}, indexedDB: ${opts.indexedDB !== false}, otherStorage: ${opts.otherStorage !== false} });
      return __BBR.setTx(JSON.stringify(r));
    `
    );
    return snapshot;
  } finally {
    await detach(tabId);
  }
}

// Read with a hard timeout. The debugger occasionally never answers (attach /
// evaluate / detach callback lost) — without this, the reader would hang
// forever, the tab would never close and its slot never release. On timeout
// the orphaned read is abandoned (its late detach is harmless); the caller
// still closes the tab and releases the slot in finally.
async function readWithTimeout(tabId, lib, opts, timeoutMs) {
  const ms =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : SITE_DATA_CONFIG.retry.readTimeoutMs;
  let timer = 0;
  try {
    return await Promise.race([
      readTabSnapshot(tabId, lib, opts),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`read timed out after ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------- slot-based streaming tab-group collection ----------------
//
// Two workers stream origins through a shared slot pool (hard tab limit):
//
//   Worker 1 (opener):  acquire slot -> create tab -> add it to the single
//                       "BBR Site Scan" tab group -> wait until the tab shows
//                       its origin -> hand the ready tab to Worker 2.
//                       Opens run in parallel via Promise.all over the
//                       semaphore; when every slot is taken the opener simply
//                       waits until Worker 2 frees one.
//   Worker 2 (readers): take ready tabs from the queue the moment they
//                       arrive (no batch waits), read them with bounded
//                       concurrency, then close each tab and release its slot.
//
// Hard guarantees:
//   * A slot is reserved BEFORE chrome.tabs.create and released only AFTER
//     the tab is really closed (or ungrouped, when the user took it over),
//     so open + in-flight tabs never exceed the window at any moment.
//   * Every tab Worker 1 opens goes straight into the one scan group, in one
//     window. Group creation runs through a single shared promise (no
//     duplicate groups); the group id is revalidated on every use and the
//     group is recreated when its id becomes invalid (a group vanishes with
//     its last tab). If scan-group placement fails for a tab, the tab is
//     collected into the "BBR Site Error" group instead — no owned scan tab
//     is ever left floating ungrouped.
//   * Tabs are closed and the debugger detached in finally blocks on every
//     path, including errors and timeouts; the slot is released there too.

// ---------------- partitioned (iframe) storage ----------------

async function readPartitions(progress, includedTopOrigins = null) {
  const out = [];
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.incognito || !isHttpUrl(tab.url)) continue;
    const topSite = originOf(tab.url);
    if (!topSite) continue;
    if (includedTopOrigins && !includedTopOrigins.has(topSite)) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['lib/pagelib.js'],
      });
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => {
          try {
            if (window.top === window) return { mainFrame: true };
            if (!globalThis.__BBR) return { error: 'pagelib missing' };
            return (async () => {
              const r = await __BBR.readSiteAll({
                fetchScript: false,
                opfs: false,
                buckets: false,
              });
              delete r.sessionStorage; // per-tab only; not part of partition snapshot
              return { frameOrigin: location.origin, snapshot: r };
            })();
          } catch (e) {
            return { error: String(e) };
          }
        },
      });
      for (const r of results) {
        if (!r.result || r.result.mainFrame || r.result.error) continue;
        out.push({
          topSite,
          frameOrigin: r.result.frameOrigin,
          snapshot: r.result.snapshot,
          frameId: r.frameId,
          tabId: tab.id,
        });
      }
    } catch (e) {
      // cannot inject (no host permission / unsupported scheme) — skip tab
    }
    await yieldToUI();
  }
  return out;
}

async function restorePartitions(
  partitions,
  mode,
  _progress,
  allowLiveTabWrite = false
) {
  const stats = {
    restored: 0,
    skippedNoHost: 0,
    skippedNoConsent: 0,
    notes: [],
  };
  if (!partitions || !partitions.length) return stats;
  // group by topSite
  const byTop = new Map();
  for (const p of partitions) {
    if (!byTop.has(p.topSite)) byTop.set(p.topSite, []);
    byTop.get(p.topSite).push(p);
  }
  const tabs = await chrome.tabs.query({});
  for (const [topSite, list] of byTop) {
    const hosts = tabs.filter(
      (t) => !t.incognito && originOf(t.url) === topSite
    );
    if (!hosts.length) {
      stats.skippedNoHost += list.length;
      stats.notes.push(
        `partitioned data of ${list.map((p) => p.frameOrigin).join(', ')} under ${topSite} kept in backup — requires the embedding site to be open during restore`
      );
      continue;
    }
    if (!allowLiveTabWrite) {
      // Writing into the user's live tabs changes their current browsing state
      // — it needs an explicit opt-in, never happens by default.
      stats.skippedNoConsent += list.length;
      stats.notes.push(
        `partitioned data of ${list.map((p) => p.frameOrigin).join(', ')} under ${topSite} kept in backup — live-tab write not confirmed (enable "Write into open tabs" in the restore options to apply it)`
      );
      continue;
    }
    for (const tab of hosts) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['lib/pagelib.js'],
        });
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: (dataJson, wantMode) => {
            try {
              if (window.top === window) return { mainFrame: true };
              const byOrigin = (JSON.parse(dataJson) || {}).byOrigin || {};
              const data = byOrigin[location.origin];
              if (!data) return { notTargeted: true };
              if (!globalThis.__BBR) return { error: 'pagelib missing' };
              // Partition snapshots use the reader's key names; map them to the
              // restorer's expected payload shape.
              const payload = {
                ls: data.localStorage || {},
                idb: data.indexedDB || [],
                caches: data.cacheStorage || [],
              };
              return (async () => ({
                frameOrigin: location.origin,
                out: await __BBR.restoreSiteAll(payload, { mode: wantMode }),
              }))();
            } catch (e) {
              return { error: String(e) };
            }
          },
          args: [
            JSON.stringify({
              byOrigin: Object.fromEntries(
                list.map((p) => [p.frameOrigin, p.snapshot])
              ),
            }),
            mode,
          ],
        });
        for (const r of results) {
          if (r.result && r.result.frameOrigin) stats.restored++;
          else if (r.result && r.result.error)
            stats.notes.push(
              `partition restore into ${topSite} failed: ${r.result.error}`
            );
        }
      } catch (e) {
        stats.notes.push(
          `partition restore into ${topSite} failed: ${e.message}`
        );
      }
    }
    await yieldToUI();
  }
  return stats;
}

// ---------------- collector / restorer ----------------

// Collector: returns the siteData backup section. Errors are per-origin; a
// failed origin is recorded in notes and excluded.
// Site-data collector options (include/exclude origins, cap).

export function filterSiteDataOriginsForBackup(origins, opts = {}) {
  let list = origins.map((item) =>
    typeof item === 'string' ? item : item.origin
  );
  if (Array.isArray(opts.includeOrigins)) {
    const included = new Set(opts.includeOrigins);
    list = list.filter((origin) => included.has(origin));
  }
  if (Array.isArray(opts.excludeOrigins) && opts.excludeOrigins.length) {
    const excluded = new Set(opts.excludeOrigins);
    list = list.filter((origin) => !excluded.has(origin));
  }
  const candidateCount = list.length;
  const max =
    Number.isFinite(opts.maxOrigins) && opts.maxOrigins > 0
      ? opts.maxOrigins
      : Number.MAX_SAFE_INTEGER;
  return {
    origins: list.slice(0, max),
    truncated: candidateCount > max,
    candidateCount,
  };
}

function siteDataCategoryFailures(snapshot) {
  const failures = [];
  const seen = new Set();
  const addFailure = (category, error) => {
    const message = String(error);
    const key = `${category}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    failures.push({ category, error: message });
  };
  const errors =
    snapshot && Array.isArray(snapshot.errors) ? snapshot.errors : [];
  for (const entry of errors) {
    const message = String(entry);
    const separator = message.indexOf(':');
    addFailure(
      separator > 0 ? message.slice(0, separator).trim() : 'unknown',
      separator > 0 ? message.slice(separator + 1).trim() : message
    );
  }
  if (snapshot && snapshot.opfs && snapshot.opfs.error)
    addFailure('opfs', snapshot.opfs.error);
  if (snapshot && snapshot.buckets && snapshot.buckets.error)
    addFailure('buckets', snapshot.buckets.error);
  return failures;
}

// Pure mapping: dashboard collectSiteData opts -> page-side read flags for
// __BBR.readSiteAll. Exported so unit tests can cover the flag semantics
// without chrome or pagelib. Granular categories default ON (legacy
// behavior); the non-restorable sessionStorage/serviceWorkers default OFF.
export function buildSiteReadOpts(opts = {}) {
  return {
    fetchScript: opts.fetchScript !== false,
    // Non-restorable categories default OFF (not captured at all — saves time
    // and storage). See SITE_DATA_INCLUDE in backup-categories.ts.
    sessionStorage: opts.includeSessionStorage === true,
    serviceWorkers: opts.includeServiceWorkers === true,
    // Granular storage categories default ON (legacy behavior).
    localStorage: opts.includeLocalStorage !== false,
    indexedDB: opts.includeIndexedDB !== false,
    otherStorage: opts.includeOtherStorage !== false,
  };
}

export async function collectSiteData(progress, opts = {}) {
  const lib = await getPagelib();
  const notes = [];
  // Forward declarations: these are assigned later but used in haltCrawl/
  // requestStop (defined before assignment). Declaring with `let` here avoids
  // no-use-before-define violations without reordering code.
  // eslint-disable-next-line prefer-const -- must be let for forward declaration (assigned later)
  let liveStatus;
  // eslint-disable-next-line prefer-const -- must be let for forward declaration (assigned later)
  let updateWorkers;
  // eslint-disable-next-line prefer-const -- must be let for forward declaration (assigned later)
  let report;
  // eslint-disable-next-line prefer-const -- must be let for forward declaration (assigned later)
  let readyQueue;
  let w1Active = 0;
  let w2Active = 0;
  // Centralized logger: log(level, category, message, context). All crawl
  // events go through here (levels DEBUG/INFO/WARN/ERROR/FATAL, categories
  // W1/W2/STORAGE/CPU/LOAD/SAFETY/RETRY/SYSTEM). Persists to IndexedDB in
  // batches; a failed log write never stops the crawl.
  const crawlId = `crawl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const logger = createSiteLogger({
    crawlId,
    onEntry: typeof opts.onLogEntry === 'function' ? opts.onLogEntry : null,
  });
  const log = logger.log.bind(logger);
  // notes[] is kept as a plain-text mirror for the backup section (the
  // structured log lives in IndexedDB + the dashboard). Every note() also
  // goes through the centralized logger — no log text is written elsewhere.
  const note = (msg, level = 'INFO', category = 'SYSTEM', context = {}) => {
    notes.push(msg);
    log(level, category, msg, context);
  };
  async function discoverSelectedOrigins() {
    const { origins } = await discoverOrigins(progress);
    const selection = filterSiteDataOriginsForBackup(origins, opts);
    const list = selection.origins;
    log('INFO', 'SYSTEM', `crawl started: ${list.length} origin(s) selected`, {
      crawlId,
      originCount: list.length,
    });
    if (selection.truncated) {
      const msg = `origin scan capped at ${list.length} of ${selection.candidateCount} selected candidate origins`;
      note(msg);
      log('WARN', 'SYSTEM', msg, {
        selected: list.length,
        candidates: selection.candidateCount,
      });
    }
    if (!list.length) {
      const msg = Array.isArray(opts.includeOrigins)
        ? 'no website origins selected for site-data backup'
        : 'no http(s) origins discovered from tabs/history/bookmarks/reading list/cookies';
      note(msg);
      log('WARN', 'SYSTEM', msg, {});
    }
    return list;
  }
  const list = await discoverSelectedOrigins();
  // progress carries (msg, frac, stats): frac is 0..1 within the siteData
  // phase so the dashboard progress bar stays accurate; stats carries the
  // live scan counters (tabs in group, slots, fetched/saved/failed, window).
  const readOpts = buildSiteReadOpts(opts);
  function logExcludedReadCategories(options) {
    const skipped = [
      ...(!options.sessionStorage ? ['sessionStorage'] : []),
      ...(!options.serviceWorkers ? ['serviceWorkers'] : []),
      ...(!options.localStorage ? ['localStorage'] : []),
      ...(!options.indexedDB ? ['indexedDB'] : []),
      ...(!options.otherStorage ? ['otherStorage'] : []),
    ];
    if (!skipped.length) return;
    log(
      'INFO',
      'SYSTEM',
      `site-data capture excludes: ${skipped.join(', ')} (not captured; enable these categories in Settings to include them)`,
      { excludedCategories: skipped }
    );
  }
  logExcludedReadCategories(readOpts);
  // UI-overridable tunables (clamped; dashboard Settings page).
  const retryMaxAttempts = clampInt(
    opts.retryMaxAttempts,
    1,
    5,
    SITE_DATA_CONFIG.retry.maxAttempts
  );
  const readTimeoutMs = clampInt(
    opts.readTimeoutMs,
    15000,
    180000,
    SITE_DATA_CONFIG.retry.readTimeoutMs
  );
  const checkpointEvery = clampInt(
    opts.checkpointEveryOrigins,
    5,
    50,
    SITE_DATA_CONFIG.checkpointEveryOrigins
  );
  const checkpointEnabled = opts.checkpoint !== false;
  // Stop flag from the dashboard Stop button: { stop: boolean }.
  const stopFlag = opts.stopFlag || null;
  const isStopRequested = () => !!(stopFlag && stopFlag.stop);

  // ---- per-URL lifecycle states ----
  // pending -> fetching -> fetched -> saved
  //    \-> fetch-failed (terminal)      fetched data is NEVER re-fetched,
  //    \-> save-failed  (re-save only)  only re-saved.
  function createUrlStateStore(origins) {
    const states = new Map();
    const setState = (origin, status, error) => {
      const prev = states.get(origin) || { attempts: 0 };
      states.set(origin, {
        origin,
        status,
        attempts: status === 'fetching' ? prev.attempts + 1 : prev.attempts,
        // Keep the last failure visible while a retry is in flight: the
        // dashboard's failure list stays stable instead of flickering
        // (fetch-failed -> fetching -> fetch-failed) on every retry wave.
        error: error || (status === 'fetching' ? prev.error || null : null),
      });
    };
    const listStates = () => [...states.values()];
    for (const origin of origins)
      states.set(origin, {
        origin,
        status: 'pending',
        attempts: 0,
        error: null,
      });
    return { states, setState, listStates };
  }
  const {
    states: urlStates,
    setState: setUrlState,
    listStates: urlStateList,
  } = createUrlStateStore(list);

  // ---- incremental checkpoint + resume ----
  // Every N completed origins the partial result is persisted; a later crawl
  // resumes unfinished URLs instead of starting over. Origins whose data is
  // already checkpointed are NOT re-fetched — they only need re-saving.
  // The checkpoint is cleared only on a fully successful crawl.
  const originsOut = {};
  const storageLocal = () => {
    try {
      return (chrome.storage && chrome.storage.local) || null;
    } catch {
      return null;
    }
  };
  async function resumeFromCheckpoint() {
    let resumed = 0;
    if (opts.resume === false || !checkpointEnabled) return resumed;
    try {
      const storage = storageLocal();
      const checkpoint = storage
        ? await storage.get(SITE_DATA_CONFIG.checkpointKey)
        : null;
      const saved = checkpoint && checkpoint[SITE_DATA_CONFIG.checkpointKey];
      if (!saved || !saved.origins || typeof saved.origins !== 'object')
        return resumed;
      const savedStates =
        saved.states && typeof saved.states === 'object' ? saved.states : {};
      for (const origin of list) {
        if (!saved.origins[origin]) continue;
        originsOut[origin] = saved.origins[origin];
        if (savedStates[origin] === 'saved') {
          setUrlState(origin, 'saved');
          resumed++;
        } else setUrlState(origin, 'fetched'); // data present — needs re-save only
      }
      if (resumed) {
        note(
          `sitedata: resumed ${resumed} origin(s) from the previous checkpoint`,
          'INFO',
          'SYSTEM',
          {
            resumedCount: resumed,
          }
        );
      }
    } catch (e) {
      /* checkpoint is best-effort */
    }
    return resumed;
  }
  const resumedCount = await resumeFromCheckpoint();
  // Exclusion filter: runs BEFORE any slot is reserved. Excluded URLs are
  // never opened, never attached, never read — not even from pre-existing
  // tabs. They get status SKIPPED (not failed), never enter retry.
  // opts.disableExclusion (tests only) skips this filter.
  function filterWorkOrigins() {
    let skipped = 0;
    const exclusionDisabled = opts.disableExclusion === true;
    for (const origin of list) {
      const state = urlStates.get(origin);
      if (state && ['saved', 'fetched', 'skipped'].includes(state.status))
        continue;
      if (exclusionDisabled) continue;
      const { excluded, reason } = isExcluded(origin);
      if (!excluded) continue;
      setUrlState(origin, 'skipped', reason);
      skipped++;
      log('INFO', 'SYSTEM', `skipped ${origin} — ${reason}`, {
        url: origin,
        corr: origin,
        reason,
      });
    }
    const work = list.filter((origin) => {
      const state = urlStates.get(origin);
      return !state || !['saved', 'fetched', 'skipped'].includes(state.status);
    });
    return { skippedCount: skipped, workList: work };
  }
  const { skippedCount, workList } = filterWorkOrigins();
  const total = workList.length;
  const fracFor = (done) => 0.05 + (total ? (done / total) * 0.85 : 0);

  // Hard tab window (user-configurable via the dashboard, clamped).
  const configuredWindow = clampScanWindow(opts.scanWindowSize);
  let effectiveWindow = configuredWindow;

  // Live counters for the dashboard. NOTE: "done" counts SAVED origins only —
  // a fetched-but-unsaved URL is not counted as done (it is re-saved, never
  // re-fetched).
  const stats = {
    done: 0,
    fetched: 0,
    failed: 0,
    aborted: 0,
    inGroup: 0,
    inErrorGroup: 0,
    total,
    skipped: 0,
  };
  // Record skipped count (from the exclusion filter above) — stats is now initialized.
  if (skippedCount) {
    stats.skipped = skippedCount;
    note(
      `sitedata: skipped ${skippedCount} excluded URL(s) (localhost/loopback/private/chromewebstore/non-web)`,
      'INFO',
      'SYSTEM',
      { skippedCount }
    );
  }
  let completed = 0; // terminal fetch outcomes (success or exhausted failure)
  let scanWindowId = null;
  // Every tab created by this scan, tracked AT CREATION TIME so the safety
  // net below finishes them no matter what.
  const scanTabs = [];
  // Early load signal: timeout rate / avg load time over the last N OWNED
  // tabs (reused user tabs resolve instantly and would dilute the signal).
  const loadMon = createLoadMonitor(SITE_DATA_CONFIG.load.windowSize);
  let lastCpuPct = null;

  // ---- unified halt: safety abort AND user stop share the machinery ----
  // A close attempt on a non-owned tab, or a slot grant above the effective
  // limit, can only come from a bug: STOP the crawl loudly (dashboard
  // warning + notes) instead of silently continuing. The user Stop button
  // halts the same way but is reported neutrally (STOPPED, not ABORTED).
  // Partial results are kept; the checkpoint stays for resume.
  let halted = false;
  let haltReason = null;
  let haltIsViolation = false;
  // Declared BEFORE haltCrawl to avoid TDZ (haltCrawl assigns stopPhase).
  const stopCfg = SITE_DATA_CONFIG.stop;
  let stopPhase = 'running'; // 'running' -> 'stopping' -> 'stopped'
  const slots = createSlotPool(
    () => effectiveWindow,
    (reason) => haltCrawl(reason, true)
  );
  const assertForwardDeclarationInitialized = (name, value) => {
    if (value === undefined)
      throw new Error(`called before initialization: ${name}`);
  };
  function haltCrawl(reason, isViolation) {
    assertForwardDeclarationInitialized('liveStatus', liveStatus);
    assertForwardDeclarationInitialized('updateWorkers', updateWorkers);
    assertForwardDeclarationInitialized('report', report);
    assertForwardDeclarationInitialized('readyQueue', readyQueue);
    if (halted) return;
    halted = true;
    haltReason = reason;
    haltIsViolation = !!isViolation;
    stopPhase = 'stopped';
    liveStatus.state = isViolation ? 'fatal' : 'stopped';
    updateWorkers();
    if (isViolation) stats.aborted++;
    try {
      slots.abort();
    } catch (e) {
      log(
        'DEBUG',
        'SYSTEM',
        `slot pool abort threw (benign): ${(e && e.message) || e}`,
        {}
      );
    }
    const tag = isViolation ? 'ABORTED' : 'STOPPED';
    note(
      `sitedata: ${tag} — ${reason}`,
      isViolation ? 'FATAL' : 'WARN',
      isViolation ? 'SAFETY' : 'SYSTEM',
      { reason }
    );
    report(
      `sitedata: ${tag} — ${reason} (partial results kept; resume to continue the rest)`
    );
  }
  // Clean stop: STOPPING phase. Worker 1 halts immediately (no new tabs);
  // in-flight Worker 2 reads get a grace period to finish, then we force
  // the halt. Prevents double-click via the stopPhase guard.
  function requestStop(reason) {
    assertForwardDeclarationInitialized('liveStatus', liveStatus);
    assertForwardDeclarationInitialized('updateWorkers', updateWorkers);
    assertForwardDeclarationInitialized('report', report);
    assertForwardDeclarationInitialized('readyQueue', readyQueue);
    if (stopPhase !== 'running') return; // already stopping/stopped — ignore double-click
    stopPhase = 'stopping';
    liveStatus.state = 'stopping';
    updateWorkers();
    const graceMs = stopCfg.graceMs;
    log(
      'INFO',
      'SYSTEM',
      `stop requested — STOPPING: Worker 1 halted, Worker 2 has ${(graceMs / 1000).toFixed(1)}s to finish in-flight reads`,
      { graceMs }
    );
    report('sitedata: stopping — cleaning up…');
    const force = () => {
      if (stopPhase === 'stopping') {
        log('INFO', 'SYSTEM', 'stop grace period ended — forcing halt', {});
        haltCrawl(reason || 'stopped by user', false);
      }
    };
    setTimeout(force, graceMs);
    // If workers drain early, halt immediately instead of waiting.
    const drainCheck = setInterval(() => {
      if (stopPhase !== 'stopping') {
        clearInterval(drainCheck);
        return;
      }
      if (w2Active === 0 && w1Active === 0) {
        clearInterval(drainCheck);
        log(
          'INFO',
          'SYSTEM',
          'workers drained during STOPPING — halting now',
          {}
        );
        haltCrawl(reason || 'stopped by user', false);
      }
    }, 200);
  }
  const checkStop = () => {
    if (!halted && isStopRequested()) requestStop('stopped by user');
  };

  if (typeof opts.__testBeforeForwardDeclarationsInitialized === 'function') {
    opts.__testBeforeForwardDeclarationsInitialized({
      haltCrawl: () => haltCrawl('pre-initialization test', true),
      requestStop: () => requestStop('pre-initialization test'),
      assertForwardDeclarationInitialized,
    });
  }

  // Failed pool: declared early (before liveStats closure) to avoid TDZ.
  // Failures go here instead of retrying mid-crawl; the pool is processed
  // after the main queue drains.
  const failedPool = []; // { origin, attempt, error }
  const addToFailedPool = (origin, attempt, error) => {
    failedPool.push({ origin, attempt, error });
    log(
      'WARN',
      'RETRY',
      `added to failed pool (attempt ${attempt}): ${error}`,
      {
        url: origin,
        corr: origin,
        attempt,
        error,
        poolSize: failedPool.length,
      }
    );
  };

  // ---- storage retry queue (SEPARATE from fetch retry) ----
  // Persists the checkpoint. Unsaved data stays in originsOut (memory) until
  // a write succeeds — writes are never silently swallowed: failures are
  // noted and retried with exponential backoff (capped). Quota-full is NOT
  // blindly retried: the crawl stops safely with a clear warning and the
  // data is kept in memory (it still ships in the backup section).
  let sinceCheckpoint = 0;
  const markSaved = () => {
    let n = 0;
    for (const st of urlStates.values())
      if (st.status === 'fetched') {
        st.status = 'saved';
        n++;
      }
    if (n) {
      stats.done += n;
      log('INFO', 'STORAGE', `checkpoint saved: ${n} origin(s) persisted`, {
        saved: n,
        total: stats.done,
      });
    }
  };
  const markSaveFailed = (errMsg) => {
    for (const st of urlStates.values())
      if (st.status === 'fetched') {
        st.status = 'save-failed';
        st.error = errMsg;
      }
  };
  const storageSaver = {
    attempts: 0,
    timer: 0,
    async write() {
      if (!checkpointEnabled) {
        markSaved();
        return true;
      }
      const s = storageLocal();
      if (!s) {
        markSaved();
        return true;
      } // no storage (unit tests) — memory only
      const payload = {
        savedAt: Date.now(),
        origins: originsOut,
        states: Object.fromEntries(
          [...urlStates].map(([o, st]) => [o, st.status])
        ),
      };
      try {
        await s.set({ [SITE_DATA_CONFIG.checkpointKey]: payload });
        this.attempts = 0;
        markSaved();
        return true;
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/quota/i.test(msg)) {
          haltCrawl(
            `local storage quota full — stopping safely; ${Object.keys(originsOut).length} origin(s) kept in memory and included in the backup`,
            true
          );
          return false;
        }
        markSaveFailed(msg);
        note(
          `sitedata: checkpoint write failed (${msg}) — retrying with backoff; data kept in memory`,
          'WARN',
          'STORAGE',
          { error: msg }
        );
        this.schedule();
        return false;
      }
    },
    schedule() {
      if (this.timer || halted) return;
      if (this.attempts >= SITE_DATA_CONFIG.storage.maxAttempts) {
        const n = [...urlStates.values()].filter(
          (st) => st.status === 'save-failed'
        ).length;
        note(
          `sitedata: storage retry exhausted after ${this.attempts} attempts — ${n} origin(s) kept in memory with status save-failed`,
          'ERROR',
          'STORAGE',
          { attempts: this.attempts, unsaved: n }
        );
        return;
      }
      const delay = Math.min(
        SITE_DATA_CONFIG.storage.backoffMaxMs,
        SITE_DATA_CONFIG.storage.backoffBaseMs * 2 ** this.attempts
      );
      this.attempts++;
      this.timer = setTimeout(async () => {
        this.timer = 0;
        await this.write();
      }, delay);
    },
    cancel() {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = 0;
      }
    },
  };
  async function clearCheckpoint() {
    const s = storageLocal();
    if (!s || !checkpointEnabled) return;
    try {
      await s.remove(SITE_DATA_CONFIG.checkpointKey);
    } catch (e) {
      /* ignore */
    }
  }

  const tuningLine = () => {
    const c = SITE_DATA_CONFIG;
    return (
      `cpu ≥${c.cpu.highPct}%/${c.cpu.highMs / 1000}s → ½ · ` +
      `load timeout>${Math.round(c.load.timeoutRateHigh * 100)}%/avg>${c.load.avgMsHigh / 1000}s → ½ · ` +
      `rise +2 when healthy`
    );
  };
  // Live crawl status for the dashboard status bar (Log + Summary pages).
  liveStatus = {
    state: 'running', // running | stopped | done | fatal
    worker1: 'idle', // what Worker 1 is doing right now
    worker2: 'idle', // what Worker 2 is doing right now
  };
  w1Active = 0; // opens in flight
  w2Active = 0; // reads in flight
  updateWorkers = () => {
    liveStatus.worker1 =
      w1Active > 0
        ? `opening ${w1Active} ${w1Active === 1 ? 'tab' : 'tabs'}`
        : halted
          ? 'stopped'
          : 'waiting';
    liveStatus.worker2 =
      w2Active > 0
        ? `reading ${w2Active} ${w2Active === 1 ? 'tab' : 'tabs'}`
        : halted
          ? 'stopped'
          : 'waiting';
  };
  const liveStats = () => ({
    done: stats.done,
    fetched: stats.fetched,
    failed: stats.failed,
    aborted: stats.aborted,
    skipped: stats.skipped,
    failedPool: failedPool.length,
    total,
    inGroup: stats.inGroup,
    inErrorGroup: stats.inErrorGroup,
    slotsUsed: slots.used,
    slotsTotal: slots.limit(),
    queue: slots.waiting() + readyQueue.size(),
    cpuPct: lastCpuPct,
    window: effectiveWindow,
    windowMax: configuredWindow,
    crawlState: liveStatus.state,
    worker1: liveStatus.worker1,
    worker2: liveStatus.worker2,
    logCounts: { ...logger.counts },
    logUnseenError: logger.isUnseenError(),
    crawlId,
    tuning: tuningLine(),
    urlStates: urlStateList(),
  });
  const pg = (msg, frac, st) =>
    safeProgress(
      progress,
      msg,
      typeof frac === 'number' ? frac : undefined,
      st === undefined ? liveStats() : st
    );
  report = (msg) => pg(msg, fracFor(completed));

  readyQueue = createAsyncQueue();
  const groupMgr = createGroupManager();
  // Collects owned scan tabs whose scan-group placement failed, so no scan
  // tab is ever left floating ungrouped.
  const errorGroupMgr = createGroupManager({
    title: SCAN_ERROR_GROUP_TITLE,
    color: SCAN_ERROR_GROUP_COLOR,
  });
  const DONE = Symbol('sitedata-done');
  // Tab ownership: ONLY tabs Worker 1 creates below may ever be closed, and
  // then solely through ownership.safeCloseTab (refuses anything else).
  const ownership = createSiteDataOwnership(
    notes,
    (reason) => haltCrawl(reason, true),
    log
  );
  // Sweep leftover subresource-blocking rules from a previous run that died
  // before finishScanTab (session rules survive a dead worker).
  try {
    const swept = await clearAllScanBlocking();
    if (swept > 0)
      log('INFO', 'SYSTEM', `cleared ${swept} leftover scan blocking rule(s)`, {
        crawlId,
      });
  } catch (e) {
    /* best-effort */
  }
  // Persist owned IDs for crash recovery (dashboard reopen cleans by ID,
  // never by query). Best-effort; failures never stop the crawl.
  const persistOwnedIds = async () => {
    try {
      const s = storageLocal();
      if (!s) return;
      const ids = [...ownership.ownedTabIds];
      if (ids.length)
        await s.set({
          [stopCfg.ownedTabsKey]: { tabIds: ids, savedAt: Date.now(), crawlId },
        });
      else await s.remove(stopCfg.ownedTabsKey);
    } catch (e) {
      /* best-effort */
    }
  };

  const trackScanTab = (rec) => {
    scanTabs.push(rec);
  };
  const untrackScanTab = (rec) => {
    const i = scanTabs.indexOf(rec);
    if (i >= 0) scanTabs.splice(i, 1);
  };

  // Exactly-once per slot: close the tab through safeCloseTab (refuses
  // anything not owned by this crawl), untrack it, release the slot. A tab
  // the user took over is never closed — it is ungrouped so the scan group's
  // hard limit stays exact. Every terminal path of an origin (success, open
  // failure, read failure, timeout, unexpected exception, exhausted retry)
  // funnels through here in a finally.
  async function finishScanTab(rec) {
    if (rec.finished) return;
    rec.finished = true;
    if (rec.tab) {
      // Drop the subresource-blocking rule: the tab is going away (or was
      // taken over — either way we must not keep blocking its requests).
      if (rec.blockRuleId !== null && rec.blockRuleId !== undefined) {
        try {
          await clearScanBlocking(rec.blockRuleId);
        } catch (e) {
          /* best-effort; startup cleanup sweeps leftovers */
        }
        rec.blockRuleId = null;
      }
      const st = await ownership.safeCloseTab(rec.tab.id, rec.origin);
      if (st === 'closed' || st === 'gone') {
        log('DEBUG', 'W2', `tab ${rec.tab.id} closed (${st})`, {
          url: rec.origin,
          corr: rec.origin,
          tabId: rec.tab.id,
        });
      } else if (st === 'kept') {
        try {
          await chrome.tabs.ungroup(rec.tab.id);
        } catch (e) {
          log(
            'DEBUG',
            'W2',
            `ungroup failed for taken-over tab (benign): ${(e && e.message) || e}`,
            {
              url: rec.origin,
              corr: rec.origin,
              tabId: rec.tab.id,
            }
          );
        }
        // Diagnostic: record WHY the tab was kept (user viewing it / user
        // navigating / taken over earlier) so a future leak report pinpoints
        // the verdict path. In the live path a kept tab is always
        // user-driven: an untouched markerless tab verifies 'failed' now.
        let keptWhy = 'taken over by the user earlier';
        try {
          const t = await chrome.tabs.get(rec.tab.id);
          if (t.active) keptWhy = 'user is viewing it';
          else if (t.pendingUrl) keptWhy = `user navigating to ${t.pendingUrl}`;
        } catch (e) {
          keptWhy = 'tab closed before verify finished';
        }
        note(
          `sitedata: left scan tab for ${rec.origin} untouched (${keptWhy}) — it no longer shows the scan page`,
          'WARN',
          'SAFETY',
          { url: rec.origin, corr: rec.origin, tabId: rec.tab && rec.tab.id }
        );
      }
    }
    untrackScanTab(rec);
    if (rec.grouped) {
      stats.inGroup--;
      rec.grouped = false;
    }
    if (rec.errorGrouped) {
      stats.inErrorGroup--;
      rec.errorGrouped = false;
    }
    slots.release();
    void persistOwnedIds();
    if (rec.owned)
      log('DEBUG', 'W2', `slot released (${slots.used}/${slots.limit()})`, {
        url: rec.origin,
        corr: rec.origin,
        window: effectiveWindow,
      });
  }

  // Worker 1 — opener. One coroutine per origin, all started at once; the
  // slot pool bounds how many proceed concurrently, so opens are parallel
  // (never serial) and never exceed the window.
  async function tryReuseExistingTab(origin, attempt, releaseWorker) {
    const corr = origin;
    let existing = null;
    try {
      existing = await findOpenTab(origin);
    } catch (error) {
      log(
        'DEBUG',
        'W1',
        `findOpenTab failed (benign): ${(error && error.message) || error}`,
        { url: origin, corr }
      );
    }
    if (existing && (existing.url || '').includes(SCAN_MARKER)) existing = null;
    if (!existing) return false;

    log(
      'INFO',
      'W1',
      `reusing open tab ${existing.id} (not owned — never closed/grouped)`,
      {
        url: origin,
        corr,
        tabId: existing.id,
        attempt,
      }
    );
    const ok = await waitTabReady(existing.id, origin, isStopRequested);
    releaseWorker();
    if (!ok) {
      if (!halted && !isStopRequested()) {
        setUrlState(origin, 'fetch-failed', 'open tab did not settle');
        note(`${origin}: open tab did not settle — skipped`, 'WARN', 'W1', {
          url: origin,
          corr: origin,
        });
        stats.failed++;
        const n = ++completed;
        report(`sitedata: ${origin} (${n}/${total}) — skipped`);
      }
      return true;
    }
    readyQueue.push({ origin, tab: existing, owned: false, attempt });
    return true;
  }

  async function prepareOwnedScanTab(rec, attempt) {
    // The pinned window may have been closed by the user mid-crawl — revalidate
    // before every create, otherwise EVERY later create throws and the whole
    // remaining crawl fails (tahap-1 audit T2-M1). The windows API may be
    // absent (older browsers); then there is nothing to revalidate against.
    if (scanWindowId !== null && typeof chrome.windows?.get === 'function') {
      try {
        await chrome.windows.get(scanWindowId);
      } catch {
        note(
          `scan window ${scanWindowId} is gone — continuing in the active window`,
          'WARN',
          'W1',
          { url: rec.origin, corr: rec.origin }
        );
        scanWindowId = null;
      }
    }
    // Create BLANK first: the subresource-blocking rule must be awaited
    // BEFORE any navigation, otherwise subresources slip through before the
    // rule lands (updateSessionRules is async).
    const createProps = {
      url: 'about:blank',
      active: false,
      ...(scanWindowId !== null ? { windowId: scanWindowId } : {}),
    };
    let tab;
    try {
      tab = await chrome.tabs.create(createProps);
    } catch (e) {
      if (scanWindowId === null) throw e;
      // The window died between the revalidation and the create — drop the pin
      // and retry once in the active window before giving up on this origin.
      note(
        `tab create failed in scan window ${scanWindowId} (${e.message}) — retrying in the active window`,
        'WARN',
        'W1',
        { url: rec.origin, corr: rec.origin }
      );
      scanWindowId = null;
      tab = await chrome.tabs.create({
        url: 'about:blank',
        active: false,
      });
    }
    rec.tab = tab;
    ownership.own(tab.id, tab.active); // register IMMEDIATELY after successful create
    void persistOwnedIds();
    rec.blockRuleId = await applyScanBlocking(tab.id);
    if (rec.blockRuleId === null)
      note(
        `sitedata: resource blocking unavailable for tab ${tab.id} (declarativeNetRequest missing) — scanning unblocked`,
        'WARN',
        'W1',
        { url: rec.origin, corr: rec.origin, tabId: tab.id }
      );
    // Navigation starts only after the blocking rule is in place.
    await chrome.tabs.update(tab.id, { url: scanUrlFor(rec.origin) });
    log('INFO', 'W1', `tab ${tab.id} created`, {
      url: rec.origin,
      corr: rec.origin,
      tabId: tab.id,
      attempt,
      window: effectiveWindow,
    });
    if (scanWindowId === null) scanWindowId = tab.windowId;
    trackScanTab(rec);
    try {
      await groupMgr.ensureGroup(tab.id); // straight into the one scan group
      log('DEBUG', 'W1', `tab ${tab.id} added to scan group`, {
        url: rec.origin,
        corr: rec.origin,
        tabId: tab.id,
        groupId: groupMgr.id,
      });
      rec.grouped = true;
      stats.inGroup++;
    } catch (groupError) {
      // Scan-group placement failed (transient API error while the group is
      // still valid, i.e. a bad tab rather than a gone group — the latter is
      // recreated inside ensureGroup). Collect the owned tab into the error
      // group instead of failing the origin or leaving it floating ungrouped.
      const groupMessage =
        (groupError && groupError.message) || String(groupError);
      log(
        'WARN',
        'W1',
        `tab ${tab.id} could not join the scan group (${groupMessage}) — moving to error group`,
        {
          url: rec.origin,
          corr: rec.origin,
          tabId: tab.id,
          attempt,
          error: groupMessage,
        }
      );
      try {
        await errorGroupMgr.ensureGroup(tab.id);
        log('DEBUG', 'W1', `tab ${tab.id} added to error group`, {
          url: rec.origin,
          corr: rec.origin,
          tabId: tab.id,
          groupId: errorGroupMgr.id,
        });
        rec.errorGrouped = true;
        stats.inErrorGroup++;
      } catch (errorGroupError) {
        // The tab itself is bad/gone — error-group placement cannot help.
        // Rethrow the ORIGINAL grouping error so the origin follows the
        // normal failure path (failed pool, tab closed via finally).
        throw groupError;
      }
    }
    const startedAt = Date.now();
    const ok = await waitTabReady(tab.id, rec.origin, isStopRequested);
    const loadMs = Date.now() - startedAt;
    loadMon.record({ loadMs, timedOut: !ok }); // early load signal
    log(
      ok ? 'DEBUG' : 'WARN',
      'W1',
      ok
        ? `tab ${tab.id} finished loading in ${loadMs}ms`
        : `tab ${tab.id} did not finish loading in time`,
      {
        url: rec.origin,
        corr: rec.origin,
        tabId: tab.id,
        durationMs: loadMs,
        attempt,
      }
    );
    if (!ok)
      throw new Error(
        halted || isStopRequested()
          ? 'cancelled'
          : 'tab did not finish loading in time'
      );
    rec.attempt = attempt;
  }

  async function openOwnedScanTab(origin, attempt) {
    const acquired = await slots.acquire(); // slot reserved BEFORE chrome.tabs.create
    if (!acquired || halted || isStopRequested()) {
      if (acquired) slots.release();
      return; // halted: leave this origin unfinished (resumable via checkpoint)
    }
    log('DEBUG', 'W1', `slot acquired (${slots.used}/${slots.limit()})`, {
      url: origin,
      corr: origin,
      attempt,
      window: effectiveWindow,
    });
    const rec = {
      origin,
      tab: null,
      grouped: false,
      errorGrouped: false,
      finished: false,
      owned: true,
      blockRuleId: null, // DNR subresource-blocking rule; cleared in finishScanTab
    };
    let handedOff = false;
    try {
      await prepareOwnedScanTab(rec, attempt);
      readyQueue.push(rec); // push the SAME rec object (identity matters: the safety net tracks this exact object)
      handedOff = true;
    } catch (error) {
      const message = (error && error.message) || String(error);
      if (!halted && !isStopRequested()) {
        addToFailedPool(origin, attempt, message);
        note(
          `${origin}: open attempt ${attempt} failed (${message}) — added to failed pool`,
          'WARN',
          'RETRY',
          {
            url: origin,
            corr: origin,
            attempt,
            error: message,
          }
        );
        setUrlState(origin, 'fetch-failed', message);
      }
    } finally {
      // Close the old tab before any retry opens a replacement.
      if (!handedOff) await finishScanTab(rec);
    }
  }

  async function openOne(origin, attempt) {
    checkStop();
    if (halted || stopPhase !== 'running') return; // guard tripped or STOPPING: stop opening immediately
    setUrlState(origin, 'fetching');
    const corr = origin; // correlation ID: filter all logs for this URL
    log('DEBUG', 'W1', `queued (attempt ${attempt}/${retryMaxAttempts})`, {
      url: origin,
      corr,
      attempt,
    });
    w1Active++;
    updateWorkers();
    let workerReleased = false;
    const releaseWorker = () => {
      if (workerReleased) return;
      workerReleased = true;
      w1Active--;
      updateWorkers();
    };
    try {
      if (await tryReuseExistingTab(origin, attempt, releaseWorker)) return;
      await openOwnedScanTab(origin, attempt);
    } finally {
      releaseWorker();
    }
  }

  // Worker 2 — readers. They take ready tabs the moment they arrive (no batch
  // waits) and read them with bounded concurrency. Owned tabs are closed and
  // their slots released in the finally, on every path; pre-existing tabs
  // are left open and untouched (the debugger is always detached in
  // readTabSnapshot's finally).
  async function skipStoppedReaderRecord(rec) {
    if (halted || isStopRequested()) {
      if (rec.owned) await finishScanTab(rec);
      return true;
    }
    if (stopPhase !== 'stopping') return false;
    setUrlState(rec.origin, 'pending', 'cancelled during stop — resumable');
    log(
      'INFO',
      'SYSTEM',
      'read cancelled during STOPPING — marked unfinished (resumable)',
      {
        url: rec.origin,
        corr: rec.origin,
        tabId: rec.tab.id,
      }
    );
    if (rec.owned) await finishScanTab(rec);
    return true;
  }

  async function readAndRecordSnapshot(rec) {
    try {
      log('DEBUG', 'W2', `debugger attaching to tab ${rec.tab.id}`, {
        url: rec.origin,
        corr: rec.origin,
        tabId: rec.tab.id,
        attempt: rec.attempt,
      });
      const startedAt = Date.now();
      const snapshot = await readWithTimeout(
        rec.tab.id,
        lib,
        readOpts,
        readTimeoutMs
      );
      const readMs = Date.now() - startedAt;
      for (const failure of siteDataCategoryFailures(snapshot)) {
        note(
          `${rec.origin}: ${failure.category} capture failed (${failure.error}); other categories were retained`,
          'ERROR',
          'W2',
          {
            url: rec.origin,
            corr: rec.origin,
            category: failure.category,
            error: failure.error,
          }
        );
      }
      snapshot.fromOpenTab = !rec.owned;
      originsOut[rec.origin] = snapshot;
      setUrlState(rec.origin, 'fetched');
      stats.fetched++;
      log('INFO', 'W2', `data read in ${readMs}ms`, {
        url: rec.origin,
        corr: rec.origin,
        tabId: rec.tab.id,
        durationMs: readMs,
        attempt: rec.attempt,
      });
      return true;
    } catch (error) {
      const message = (error && error.message) || String(error);
      if (halted || isStopRequested()) return false;
      addToFailedPool(rec.origin, rec.attempt, message);
      setUrlState(rec.origin, 'fetch-failed', message);
      note(
        `${rec.origin}: read attempt ${rec.attempt} failed (${message}) — added to failed pool`,
        'WARN',
        'RETRY',
        {
          url: rec.origin,
          corr: rec.origin,
          tabId: rec.tab.id,
          attempt: rec.attempt,
          error: message,
        }
      );
      report(`sitedata: ${rec.origin} — read attempt ${rec.attempt} failed`);
      return true;
    }
  }

  async function finishReaderRecord(rec, terminal) {
    if (terminal) {
      const n = ++completed;
      report(`sitedata: ${rec.origin} (${n}/${total})`);
    }
    if (++sinceCheckpoint >= checkpointEvery) {
      sinceCheckpoint = 0;
      await storageSaver.write(); // incremental save (retry queue on failure)
    }
    if (rec.owned) await finishScanTab(rec); // closes tab, releases slot — always
    w2Active--;
    updateWorkers();
  }

  async function readerLoop() {
    for (;;) {
      checkStop();
      const rec = await readyQueue.take();
      if (rec === DONE) return;
      if (await skipStoppedReaderRecord(rec)) continue;
      w2Active++;
      updateWorkers();
      let terminal = false;
      try {
        terminal = await readAndRecordSnapshot(rec);
      } finally {
        await finishReaderRecord(rec, terminal);
      }
    }
  }

  // Failed pool: URLs that failed are collected here (with reason), NOT
  // retried mid-crawl. After the main queue drains, a separate retry phase
  // runs the pool through the same pipeline. Storage retry is independent
  // (background backoff) and never blocks this.
  // (failedPool and addToFailedPool are declared earlier, before liveStats.)
  let activeReaders = [];
  const cpuSampler = createSystemCpuSampler();
  const cpuMon = startCpuMonitor({
    getWindow: () => effectiveWindow,
    setWindow: (w) => {
      effectiveWindow = w;
    },
    maxWindow: configuredWindow,
    sampler: async () => {
      const p = await cpuSampler();
      if (typeof p === 'number' && Number.isFinite(p)) lastCpuPct = p;
      return p;
    },
    loadStats: () => loadMon.stats(),
    onAdjust: (reason) => {
      note(
        'sitedata: adaptive window — ' + reason,
        'WARN',
        /cpu/i.test(reason) ? 'CPU' : 'LOAD',
        {
          reason,
          window: effectiveWindow,
          windowMax: configuredWindow,
        }
      );
      slots.kick(); // re-evaluate waiters: a grown window unblocks openers
      report(
        `sitedata: scan window now ${effectiveWindow}/${configuredWindow}`
      );
    },
  });

  async function runSiteDataWaves() {
    report(
      `sitedata: starting scan of ${total} origin(s) — window ${configuredWindow}, up to ${retryMaxAttempts} attempt(s)` +
        (resumedCount ? ` (${resumedCount} resumed from checkpoint)` : '')
    );
    log(
      'INFO',
      'SYSTEM',
      `scan started: ${total} origin(s), window ${configuredWindow}, max ${retryMaxAttempts} attempt(s)`,
      { total, window: configuredWindow, maxAttempts: retryMaxAttempts }
    );

    async function runWave(items) {
      checkStop();
      activeReaders = [];
      for (let i = 0; i < SITE_DATA_CONFIG.readConcurrency; i++)
        activeReaders.push(readerLoop());
      await Promise.all(
        items.map((work) => openOne(work.origin, work.attempt))
      );
      for (let i = 0; i < activeReaders.length; i++) readyQueue.push(DONE);
      await Promise.all(activeReaders);
      activeReaders = [];
    }

    await runWave(workList.map((origin) => ({ origin, attempt: 1 })));

    for (
      let attempt = 2;
      attempt <= retryMaxAttempts && failedPool.length > 0 && !halted;
      attempt++
    ) {
      const items = failedPool
        .splice(0)
        .map((failure) => ({ origin: failure.origin, attempt }));
      const phaseMsg = `sitedata: retry phase — attempt ${attempt}/${retryMaxAttempts} (${items.length} URL(s))`;
      log(
        'INFO',
        'RETRY',
        `retry phase started: attempt ${attempt}/${retryMaxAttempts} for ${items.length} URL(s)`,
        {
          attempt,
          maxAttempts: retryMaxAttempts,
          count: items.length,
        }
      );
      note(phaseMsg, 'INFO', 'RETRY', {
        attempt,
        maxAttempts: retryMaxAttempts,
        count: items.length,
      });
      report(phaseMsg);
      await runWave(items);
      log(
        'INFO',
        'RETRY',
        `retry phase ended: ${failedPool.length} URL(s) still failing`,
        {
          attempt,
          remaining: failedPool.length,
        }
      );
    }

    for (const failure of failedPool.splice(0)) {
      setUrlState(failure.origin, 'fetch-failed', failure.error);
      note(
        `${failure.origin}: read failed permanently after ${retryMaxAttempts} attempt(s) (${failure.error})`,
        'ERROR',
        'W2',
        {
          url: failure.origin,
          corr: failure.origin,
          attempt: retryMaxAttempts,
          error: failure.error,
        }
      );
      stats.failed++;
    }
  }

  function buildHaltedSiteDataResult() {
    completed = total; // let the bar settle; the message says ABORTED/STOPPED
    const tag = haltIsViolation ? 'ABORTED' : 'STOPPED';
    report(
      `sitedata: ${tag} — ${haltReason} (${stats.done}/${total} origins saved; checkpoint kept, resume to continue)`
    );
    return {
      schemaVersion: 1,
      method: 'chrome.debugger+scripting (page-context execution)',
      origins: originsOut,
      partitions: [],
      notes,
      aborted: haltIsViolation,
      stopped: !haltIsViolation,
      haltReason,
      abortReason: haltReason, // backward-compat alias
      urlStates: urlStateList(),
    };
  }

  async function buildSuccessfulSiteDataResult() {
    let partitions = [];
    try {
      pg('sitedata: scanning partitioned (iframe) storage of open tabs', 0.95);
      partitions = await readPartitions(progress, new Set(workList));
    } catch (error) {
      note(
        'partitioned storage scan failed: ' +
          ((error && error.message) || error),
        'ERROR',
        'W2',
        {
          error: (error && error.message) || String(error),
        }
      );
    }

    pg('sitedata: complete', 1);
    liveStatus.state = 'done';
    updateWorkers();
    log(
      'INFO',
      'SYSTEM',
      `crawl complete: ${stats.done}/${total} saved, ${stats.failed} failed`,
      {
        done: stats.done,
        failed: stats.failed,
        total,
      }
    );
    const excludedCategories = Array.isArray(opts.excludedSiteDataCategories)
      ? opts.excludedSiteDataCategories
      : [];
    return {
      schemaVersion: 1,
      method: 'chrome.debugger+scripting (page-context execution)',
      origins: originsOut,
      partitions,
      notes,
      urlStates: urlStateList(),
      crawlId,
      excludedCategories, // site-data sub-categories not captured
    };
  }

  async function drainSiteDataReadersAndTabs() {
    for (let i = 0; i < SITE_DATA_CONFIG.readConcurrency; i++)
      readyQueue.push(DONE);
    if (cpuMon) cpuMon.stop();
    await Promise.all(activeReaders);
    for (const rec of [...scanTabs]) {
      try {
        await finishScanTab(rec);
      } catch (error) {
        log(
          'WARN',
          'SYSTEM',
          `safety-net finishScanTab threw: ${(error && error.message) || error}`,
          {
            url: rec.origin,
            corr: rec.origin,
          }
        );
      }
    }
  }

  async function verifyOwnedScanTabsClosed() {
    for (let attempt = 0; attempt < stopCfg.verifyRetries; attempt++) {
      const remaining = [...ownership.ownedTabIds];
      if (!remaining.length) break;
      log(
        'WARN',
        'SYSTEM',
        `cleanup verification: ${remaining.length} owned tab(s) remain — retrying close (attempt ${attempt + 1}/${stopCfg.verifyRetries})`,
        { tabIds: remaining, attempt: attempt + 1 }
      );
      for (const tabId of remaining) {
        try {
          await ownership.safeCloseTab(tabId, '');
        } catch (error) {
          /* ignore */
        }
      }
      if (attempt < stopCfg.verifyRetries - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, stopCfg.verifyDelayMs)
        );
      }
    }
    const leftover = [...ownership.ownedTabIds];
    if (leftover.length) {
      const message = `cleanup incomplete: ${leftover.length} owned tab(s) could not be closed: ${leftover.join(', ')}`;
      log('ERROR', 'SYSTEM', message, { tabIds: leftover });
      note(`sitedata: WARNING — ${message}`, 'ERROR', 'SYSTEM', {
        tabIds: leftover,
      });
    } else {
      log('INFO', 'SYSTEM', 'cleanup verified: no owned tabs remain', {});
    }
    return leftover;
  }

  async function persistOwnedTabRecord(leftover) {
    try {
      const storage = storageLocal();
      if (!storage) return;
      if (leftover.length)
        await storage.set({
          [stopCfg.ownedTabsKey]: { tabIds: leftover, savedAt: Date.now() },
        });
      else await storage.remove(stopCfg.ownedTabsKey);
    } catch (error) {
      /* best-effort */
    }
  }

  async function finalizeSiteDataCheckpoint() {
    storageSaver.cancel();
    if (halted)
      await storageSaver.write(); // best-effort: keeps the checkpoint for resume
    else await clearCheckpoint();
    await logger.flush(); // persist any remaining log entries
    try {
      await clearAllScanBlocking();
    } catch (e) {
      /* best-effort */
    }
    ownership.dispose();
  }

  async function cleanupSiteDataCrawl() {
    // Cleanup also runs on user Stop. Tabs are only touched through the owned-ID verifier.
    log(
      'INFO',
      'SYSTEM',
      'cleanup: detaching debuggers and closing owned tabs',
      {
        owned: ownership.ownedTabIds.size,
      }
    );
    await drainSiteDataReadersAndTabs();
    const leftover = await verifyOwnedScanTabsClosed();
    await persistOwnedTabRecord(leftover);
    await finalizeSiteDataCheckpoint();
  }

  async function executeSiteDataCrawl() {
    try {
      await runSiteDataWaves();
      if (halted) return buildHaltedSiteDataResult();
      await storageSaver.write();
      if (halted) return buildHaltedSiteDataResult();
      return await buildSuccessfulSiteDataResult();
    } finally {
      await cleanupSiteDataCrawl();
    }
  }
  return executeSiteDataCrawl();
}

export function computeSiteDataCounts(section) {
  if (!section) return {};
  const c = {
    siteDataOrigins: Object.keys(section.origins || {}).length,
    siteDataPartitions: (section.partitions || []).length,
  };
  let ls = 0,
    ss = 0,
    idbRecords = 0,
    cacheEntries = 0,
    sw = 0,
    opfsFiles = 0;
  const bucketNames = new Set();
  const walkIdb = (dbs) => {
    for (const d of dbs || [])
      for (const s of d.stores || []) idbRecords += (s.records || []).length;
  };
  const walkCaches = (list) => {
    for (const cs of list || []) cacheEntries += (cs.entries || []).length;
  };
  for (const snap of Object.values(section.origins || {})) {
    ls += Object.keys(snap.localStorage || {}).length;
    ss += Object.keys(snap.sessionStorage || {}).length;
    walkIdb(snap.indexedDB);
    walkCaches(snap.cacheStorage);
    sw += (snap.serviceWorkers || []).length;
    opfsFiles += ((snap.opfs && snap.opfs.files) || []).length;
    for (const b of (snap.buckets && snap.buckets.buckets) || []) {
      bucketNames.add(b.name);
      walkIdb(b.indexedDB);
      walkCaches(b.cacheStorage);
      opfsFiles += ((b.opfs && b.opfs.files) || []).length;
    }
  }
  c.siteDataKeys = ls;
  c.siteDataSessionKeys = ss;
  c.siteDataIdbRecords = idbRecords;
  c.siteDataCacheEntries = cacheEntries;
  c.siteDataSwRegistrations = sw;
  c.siteDataOpfsFiles = opfsFiles;
  c.siteDataBuckets = bucketNames.size;
  return c;
}

// Restore. options: { enabled, mode: 'merge'|'replace', confirmDestructive }
// eslint-disable-next-line complexity -- TECH DEBT: complexity 32, refactoring risks behavior change
export async function restoreSiteData(section, options, progress) {
  const opts = options || {};
  const mode = opts.mode === 'replace' ? 'replace' : 'merge';
  if (mode === 'replace' && !opts.confirmDestructive) {
    throw new TypedError(
      'ERR_CONFIRMATION_REQUIRED',
      'Replace mode for website data is destructive and requires explicit confirmation.'
    );
  }
  const lib = await getPagelib();
  const stats = {
    originsRestored: 0,
    originsFailed: 0,
    keysWritten: 0,
    ssWritten: 0,
    idbDbs: 0,
    idbRecords: 0,
    cacheEntries: 0,
    swRegistered: 0,
    opfsFiles: 0,
    bucketsTouched: 0,
    notes: [],
  };

  // Helper: accumulate restore stats from a result object.
  // Extracted to reduce nesting depth (max-depth compliance).
  function accumulateRestoreStats(res) {
    if (res.localStorage) stats.keysWritten += res.localStorage.written || 0;
    if (res.indexedDB) {
      for (const r of res.indexedDB) {
        if (r.ok && !r.skippedExisting) {
          stats.idbDbs++;
          stats.idbRecords += r.records || 0;
        }
      }
    }
    if (res.cacheStorage) {
      for (const r of res.cacheStorage) stats.cacheEntries += r.put || 0;
    }
    if (res.serviceWorkers) {
      for (const r of res.serviceWorkers) if (r.ok) stats.swRegistered++;
    }
    if (res.opfs) stats.opfsFiles += res.opfs.filesWritten || 0;
    if (res.buckets)
      stats.bucketsTouched += (res.buckets.bucketsOpened || []).length;
  }

  // Helper: restore sessionStorage into a live tab via debugger.
  // Extracted to reduce nesting depth (max-depth compliance).
  async function restoreSessionStorage(dbg, snap, origin) {
    const r = await sendCommand(dbg, 'Runtime.evaluate', {
      expression: `(async () => __BBR.restoreSS(${JSON.stringify(snap.sessionStorage)}, 'merge'))()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.ok) {
      const v = unremote(r.result);
      stats.ssWritten += (v && v.written) || 0;
    } else {
      stats.notes.push(
        `sessionStorage restore failed for ${origin}: ${r.error}`
      );
    }
  }
  // Ownership for tabs this restore creates: only those may be closed, via
  // safeCloseTab. A reused pre-existing tab is never closed. A refusal can
  // only come from a bug — log it loudly and skip the close.
  const ownership = createSiteDataOwnership(stats.notes, (reason) =>
    stats.notes.push(
      `sitedata: SAFETY VIOLATION during restore — ${reason}; close skipped`
    )
  );
  const entries = Object.entries(section.origins || {});
  let i = 0;
  for (const [origin, snap] of entries) {
    try {
      if (progress)
        progress(`sitedata: restoring ${origin} (${i + 1}/${entries.length})`);
      const { tab, created } = await findOrCreateTab(origin, progress);
      if (created) ownership.own(tab.id); // register immediately after create
      try {
        const att = await attach(tab.id);
        if (!att.ok) throw new TypedError('ERR_DEBUGGER_ATTACH', att.error);
        const dbg = { tabId: tab.id };
        try {
          await injectPagelib(dbg, lib);
          // push payload through chunked RX (ASCII-safe)
          const json = JSON.stringify({
            ls: snap.localStorage || {},
            idb: snap.indexedDB || [],
            sw: snap.serviceWorkers || [],
            caches: snap.cacheStorage || [],
            opfs: snap.opfs || null,
            buckets: snap.buckets || null,
          });
          for (let off = 0; off < json.length; off += CH) {
            const r = await sendCommand(dbg, 'Runtime.evaluate', {
              expression: `__BBR.pushRx(${JSON.stringify(json.slice(off, off + CH))})`,
              returnByValue: true,
            });
            if (!r.ok) throw new TypedError('ERR_SITE_EVAL', r.error);
          }
          const res = await evalJsonViaTx(
            dbg,
            `
            const payload = __BBR.takeRx();
            return __BBR.setTx(JSON.stringify(await __BBR.restoreSiteAll(payload, { mode: ${JSON.stringify(mode)} })));
          `
          );
          stats.originsRestored++;
          accumulateRestoreStats(res);
          // sessionStorage: content-only restore into a live tab context
          if (snap.sessionStorage && Object.keys(snap.sessionStorage).length) {
            if (created) {
              stats.notes.push(
                `sessionStorage of ${origin} NOT restored: it was captured from an open tab and there is no live tab identity to restore it into (platform semantics).`
              );
            } else {
              await restoreSessionStorage(dbg, snap, origin);
            }
          }
        } finally {
          await detach(tab.id);
        }
      } finally {
        if (created) {
          // Only a tab this restore created may be closed — via safeCloseTab,
          // which refuses anything outside the ownership registry.
          const st = await ownership.safeCloseTab(tab.id, origin);
          if (st === 'kept') {
            try {
              await chrome.tabs.ungroup(tab.id);
            } catch (e) {
              /* ignore */
            }
            stats.notes.push(
              `sitedata: left restore tab for ${origin} untouched — it no longer shows the scan page`
            );
          }
        }
      }
    } catch (e) {
      stats.originsFailed++;
      stats.notes.push(`${origin}: restore failed (${(e && e.message) || e})`);
    }
    i++;
    await yieldToUI();
  }

  try {
    const pr = await restorePartitions(
      section.partitions || [],
      'merge',
      progress,
      opts.allowLiveTabWrite === true
    );
    stats.partitionsRestored = pr.restored;
    stats.partitionsWithoutHost = pr.skippedNoHost;
    stats.notes.push(...pr.notes);
  } catch (e) {
    stats.notes.push('partitioned restore failed: ' + ((e && e.message) || e));
  }

  if (mode === 'replace') {
    stats.notes.push(
      "Replace mode: each origin's site storage was wiped before restoring (explicitly confirmed)."
    );
  } else {
    stats.notes.push(
      'Merge mode: existing keys/records/files are overwritten by backup content only where names collide; unrelated data is untouched. Missing IndexedDB databases and buckets are created; existing ones are skipped.'
    );
  }
  stats.notes.push(
    'Service Worker restore requires the worker script to still be served by its site (platform limitation, research-proven).'
  );
  return {
    status: 'ok',
    stats,
    summary: `siteData: ${stats.originsRestored} origins restored (${stats.originsFailed} failed), ${stats.keysWritten} LS keys, ${stats.idbDbs} IDB dbs / ${stats.idbRecords} records, ${stats.cacheEntries} cache entries, ${stats.swRegistered} SW, ${stats.opfsFiles} OPFS files, ${stats.bucketsTouched} buckets`,
  };
}
