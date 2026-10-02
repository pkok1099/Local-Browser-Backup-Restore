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

const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch (e) {
    return null;
  }
};

const SCAN_MARKER = '/__bbr_site_scan__';

function scanUrlFor(origin) {
  return origin + SCAN_MARKER;
}

const CH = 256 * 1024; // transport chunk size (chars)

// Single tuning object for the site-data crawler (point 4: all constants in
// one place). The UI window setting is the UPPER BOUND for the effective
// window — the adaptive logic below never overwrites it.
export const SITE_DATA_CONFIG = {
  window: { default: 20, min: 2, max: 50 },
  // Bounded parallelism for debugger reads: chrome.debugger attaches per
  // tab, so concurrent reads are safe; 4 keeps CPU/memory bounded (reads are
  // the CPU-heavy phase, and 4 proved stable).
  readConcurrency: 4,
  tabLoadTimeoutMs: 20000,
  checkpointKey: 'bbr:site-data-checkpoint',
  checkpointEveryOrigins: 10,
  // URLs never crawled: not opened, no debugger attach, no data captured.
  // Matched on the parsed hostname (new URL()), never on URL substrings, so
  // https://contoh.com/?q=localhost is NOT blocked. Applies to http/https on
  // any port, to new URLs and to pre-existing tabs (those are skipped, never
  // touched). Non-web schemes are excluded because the debugger cannot run
  // there at all.
  excluded: {
    hosts: ['localhost', '127.0.0.1', 'chromewebstore.google.com'],
    hostSuffixes: ['.localhost'], // *.localhost
    hostPrefixes: ['192.'], // 192.x.x.x
    schemes: ['chrome:', 'chrome-extension:', 'file:', 'about:', 'data:', 'javascript:'],
  },
  cpu: {
    sampleMs: 1000,
    highPct: 95, // "100%" treated as >= 95% (exact 100 is rare)
    highMs: 10000, // sustained >10s -> halve the window, then reset the count
    lowPct: 70,
    lowSamples: 15, // ~15s of low CPU -> grow back
    floor: 2, // halving never goes below 2
  },
  // Early load signal (before the CPU pegs): tab load time and timeout rate
  // over a sliding window of the last N OWNED tabs. Either the CPU guard or
  // the load guard may shrink the window (fast down); it grows back slowly
  // (+2) only when BOTH signals are healthy (slow up, no oscillation).
  load: {
    windowSize: 20, // sliding window: last N owned tabs
    minSamples: 5, // don't react before this many samples
    timeoutRateHigh: 0.3, // >30% timeouts -> shrink
    timeoutRateRecovered: 0.15,
    avgMsHigh: 8000, // avg load >8s -> shrink
    avgMsRecovered: 4000,
    shrinkCooldownMs: 10000, // min time between load-triggered shrinks
  },
  // Per-URL fetch retry (separate from the storage retry below). A retry
  // always closes the old tab FIRST (in finally) before opening a new one —
  // tabs never pile up.
  retry: {
    maxAttempts: 3, // total attempts per origin (1 initial + 2 retries)
    readTimeoutMs: 60000, // a read that never returns is abandoned, not hung
    backoffBaseMs: 1000, // wait between retry waves (exponential)
    backoffMaxMs: 15000,
  },
  // Clean stop: STOPPING phase gives in-flight Worker 2 reads a grace period
  // before force-halt; cleanup is verified with retries.
  stop: {
    graceMs: 5000, // Worker 2 in-flight tasks may finish within this
    verifyRetries: 3, // cleanup verification attempts
    verifyDelayMs: 1000, // delay between verification retries
    ownedTabsKey: 'bbr:site-data-owned-tabs', // persisted owned tab IDs for crash recovery
  },
  // Storage retry queue (checkpoint persistence), SEPARATE from fetch retry.
  // Unsaved data stays in memory (originsOut) until a write succeeds.
  // Quota-full is never blindly retried: the crawl stops safely instead.
  storage: {
    backoffBaseMs: 1000,
    backoffMaxMs: 30000,
    maxAttempts: 5,
  },
};

const guardedTabsNamespaces = new WeakSet();
const activeGuardLoggers = new Map();
let activeSafeClosePermit = null;
const fallbackTabRemovalLogger = createSiteLogger({ crawlId: 'tab-removal-guard' });

function reportTabRemovalGuard(tabId, reason) {
  const message = `tab removal blocked: ${reason}`;
  const context = { tabId, reason };
  if (activeGuardLoggers.size) {
    for (const logFn of activeGuardLoggers.keys()) {
      try {
        logFn('ERROR', 'SAFETY', message, context);
      } catch (e) {
        /* logging must never weaken the removal guard */
      }
    }
  } else {
    fallbackTabRemovalLogger.log('ERROR', 'SAFETY', message, context);
  }
}

function installTabsRemoveGuard() {
  let tabs;
  try {
    tabs = globalThis.chrome && globalThis.chrome.tabs;
  } catch (e) {
    return false;
  }
  if (!tabs || typeof tabs !== 'object' || typeof tabs.remove !== 'function') return false;
  if (guardedTabsNamespaces.has(tabs)) return true;

  const nativeRemove = tabs.remove.bind(tabs);
  const guardedRemove = function (tabIds, ...args) {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    const tabId = ids.length === 1 ? ids[0] : undefined;
    const permit = activeSafeClosePermit;
    if (!permit || ids.length !== 1 || tabId !== permit.tabId || !permit.ownedTabIds.has(tabId)) {
      const reason = !permit
        ? 'call outside safeCloseTab'
        : `tabId ${String(tabId)} is outside the authorized ownedTabIds entry`;
      reportTabRemovalGuard(tabId, reason);
      return Promise.reject(new Error(`tab removal blocked: ${reason}`));
    }
    activeSafeClosePermit = null; // one synchronous use; aliases cannot reuse the permit
    return nativeRemove(tabIds, ...args);
  };

  try {
    Object.defineProperty(tabs, 'remove', { configurable: true, writable: true, value: guardedRemove });
  } catch (e) {
    reportTabRemovalGuard(undefined, `could not install runtime wrapper: ${(e && e.message) || e}`);
    return false;
  }
  if (tabs.remove !== guardedRemove) {
    reportTabRemovalGuard(undefined, 'runtime wrapper installation did not take effect');
    return false;
  }
  guardedTabsNamespaces.add(tabs);
  return true;
}

// Chrome exposes the API namespace before extension scripts run; install the
// guard at module evaluation, then retry lazily for test and embedded contexts.
installTabsRemoveGuard();

export function createTabOwnership(notes, verify, onViolation, logFn) {
  installTabsRemoveGuard();
  const ownedTabIds = new Set();
  const closingTabIds = new Set();
  let disposed = false;
  if (typeof logFn === 'function') activeGuardLoggers.set(logFn, (activeGuardLoggers.get(logFn) || 0) + 1);
  const dispose = () => {
    if (disposed || typeof logFn !== 'function') return;
    disposed = true;
    const refs = (activeGuardLoggers.get(logFn) || 1) - 1;
    if (refs > 0) activeGuardLoggers.set(logFn, refs);
    else activeGuardLoggers.delete(logFn);
  };
  const own = (tabId) => {
    ownedTabIds.add(tabId);
  };
  async function safeCloseTab(tabId, origin) {
    if (!ownedTabIds.has(tabId) || closingTabIds.has(tabId)) {
      const reason = `refused to close tab ${tabId} — not owned by this operation or already closing`;
      if (notes) notes.push(`SAFETY VIOLATION: REFUSED to close tab ${tabId} — not owned by this operation`);
      if (typeof logFn === 'function') {
        try {
          logFn('ERROR', 'SAFETY', `refused to close tab ${tabId} — not owned by this operation`, {
            tabId,
            url: origin,
            corr: origin,
          });
        } catch (e) {
          /* logging must not throw */
        }
      }
      if (typeof onViolation === 'function') {
        try {
          onViolation(reason);
        } catch (e) {
          /* abort must not throw */
        }
      }
      return 'refused';
    }
    closingTabIds.add(tabId);
    try {
      let verdict;
      try {
        verdict = await verify(tabId, origin);
      } catch (e) {
        verdict = 'gone';
      }
      if (verdict === 'gone') return 'gone';
      if (verdict !== 'ours' && verdict !== 'failed') return 'kept'; // taken over — never close it

      // Failed loads are ours; a normal close also requires a positive page
      // verification. The runtime wrapper consumes this one-use permit before
      // dispatching the native API, so aliases/destructuring cannot bypass it.
      if (!installTabsRemoveGuard()) throw new Error('tab removal runtime guard is unavailable');
      const permit = { tabId, ownedTabIds };
      activeSafeClosePermit = permit;
      let removal;
      try {
        removal = chrome.tabs.remove(tabId); // SAFETY-ALLOWED: the single safeCloseTab choke point
      } finally {
        if (activeSafeClosePermit === permit) activeSafeClosePermit = null;
      }
      try {
        await removal;
      } catch (e) {
        /* raced away */
      }
      return 'closed';
    } finally {
      closingTabIds.delete(tabId);
      ownedTabIds.delete(tabId); // decide exactly once after verification/removal
    }
  }
  return { ownedTabIds, own, safeCloseTab, dispose };
}

// Verifier for the site-data crawl: a registered tab is ours to close only
// while it still shows our scan page (safety: when in doubt, don't close).
export async function verifyScanTab(tabId, origin) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return 'gone';
  } // already gone
  const looksLikeScan = (u) => typeof u === 'string' && u.includes(SCAN_MARKER) && originOf(u) === origin;
  if (looksLikeScan(tab.url) || looksLikeScan(tab.pendingUrl)) {
    // Wipe the history entry the scan created, so backups made later in the
    // same session are not polluted by the scan itself.
    try {
      await chrome.history.deleteUrl({ url: scanUrlFor(origin) });
    } catch (e) {
      /* ignore */
    }
    return 'ours';
  }
  // Failed load: Chrome shows an error page (chrome-error://). This is still
  // OUR tab — the site failed to load, not a user navigation. Mark as failed
  // so the caller closes it instead of leaving it piled up ungrouped.
  const url = tab.url || tab.pendingUrl || '';
  if (typeof url === 'string' && (url.startsWith('chrome-error://') || url.startsWith('about:'))) {
    return 'failed';
  }
  return 'foreign';
}

export function createSiteDataOwnership(notes, onViolation, logFn) {
  return createTabOwnership(notes, verifyScanTab, onViolation, logFn);
}

// Cleanup leftover scan tabs from a previous session (dashboard reopen or
// crash). ONLY closes tabs whose IDs were recorded as owned by a crawl —
// never by query or group membership. Each ID is registered in a temporary
// ownership set and closed via safeCloseTab (which verifies the tab still
// shows a scan page; a taken-over tab is left untouched).
export async function cleanupPreviousSessionTabs(logFn) {
  const log =
    typeof logFn === 'function'
      ? logFn
      : () => {
          /* noop */
        };
  let recorded;
  try {
    const s = (chrome.storage && chrome.storage.local) || null;
    if (!s) return { cleaned: 0 };
    const kv = await s.get(SITE_DATA_CONFIG.stop.ownedTabsKey);
    recorded = kv && kv[SITE_DATA_CONFIG.stop.ownedTabsKey];
    if (!recorded || !Array.isArray(recorded.tabIds) || !recorded.tabIds.length) return { cleaned: 0 };
  } catch (e) {
    return { cleaned: 0 };
  }
  log('INFO', 'SYSTEM', `previous session left ${recorded.tabIds.length} owned tab(s) — cleaning by recorded ID only`, {
    tabIds: recorded.tabIds,
  });
  const ownership = createTabOwnership(null, verifyScanTab, null);
  for (const tabId of recorded.tabIds) ownership.own(tabId);
  let cleaned = 0;
  for (const tabId of recorded.tabIds) {
    try {
      const st = await ownership.safeCloseTab(tabId, '');
      if (st === 'closed' || st === 'gone') {
        cleaned++;
        log('INFO', 'SYSTEM', `closed leftover scan tab ${tabId} from previous session (${st})`, { tabId });
      } else {
        log('INFO', 'SYSTEM', `left tab ${tabId} untouched (safeCloseTab: ${st})`, { tabId });
      }
    } catch (e) {
      log('DEBUG', 'SYSTEM', `leftover tab ${tabId}} cleanup threw: ${(e && e.message) || e}`, { tabId });
    }
  }
  try {
    const s = (chrome.storage && chrome.storage.local) || null;
    if (s) await s.remove(SITE_DATA_CONFIG.stop.ownedTabsKey);
  } catch (e) {
    /* ignore */
  }
  return { cleaned };
}
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
    if (host === h.toLowerCase()) return { excluded: true, reason: `excluded host ${h}` };
  }
  for (const s of cfg.hostSuffixes) {
    if (host.endsWith(s.toLowerCase())) return { excluded: true, reason: `excluded host suffix ${s}` };
  }
  for (const p of cfg.hostPrefixes) {
    // Only IPv4 literals (192.0.0.0/8), not hostnames like 192.example.com.
    const parts = host.split('.');
    const isV4 = parts.length === 4 && parts.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255);
    if (host.startsWith(p.toLowerCase()) && isV4) return { excluded: true, reason: `excluded IPv4 range ${p}*` };
  }
  return { excluded: false, reason: '' };
}

let PAGELIB_SRC = null;
async function getPagelib() {
  if (!PAGELIB_SRC) {
    PAGELIB_SRC = await (await fetch(chrome.runtime.getURL('lib/pagelib.js'))).text();
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
    const hist = await chrome.history.search({ text: '', startTime: 0, maxResults: 10000 });
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
      const entries = typeof chrome.readingList.query === 'function' ? await chrome.readingList.query({}) : [];
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
        if (c.domain.startsWith('.')) add(`https://${c.domain.slice(1)}/`, 'cookie-domain');
        else add(`https://${c.domain}/`, 'cookie-host');
      }
      if (typeof chrome.cookies.getAllDefaultPartitionKey === 'function') {
        try {
          const keys = await chrome.cookies.getAllDefaultPartitionKey();
          for (const k of keys || []) if (k.topLevelSite) add(k.topLevelSite, 'chips-partition');
        } catch (e) {
          /* optional API */
        }
      }
    }
  } catch (e) {
    /* ignore */
  }
  const origins = [...found.keys()].sort();
  return { origins: origins.map((o) => ({ origin: o, sources: found.get(o) })), truncated: false };
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
// isCancelled() becomes true (e.g. the user pressed Stop).
async function waitTabReady(tabId, origin, isCancelled) {
  const t0 = Date.now();
  for (;;) {
    if (typeof isCancelled === 'function' && isCancelled()) return false;
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete' && (t.url || '').startsWith(origin)) return true;
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
  if (v && typeof v === 'object' && Object.keys(v).length === 1 && 'result' in v) v = v.result;
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
      'page exception: ' + ((exc.exception && exc.exception.description) || exc.text || 'unknown')
    );
  }
  const len = Number(unremote(start.result && start.result.result ? start.result.result : start.result));
  if (!Number.isFinite(len)) throw new TypedError('ERR_SITE_EVAL', 'transport length not returned');
  let json = '';
  for (let i = 0; i < len; i += CH) {
    const r = await sendCommand(dbg, 'Runtime.evaluate', {
      expression: `__BBR.txChunk(${i}, ${CH})`,
      returnByValue: true,
    });
    if (!r.ok) throw new TypedError('ERR_SITE_EVAL', r.error);
    json += unremote(r.result);
  }
  const clr = await sendCommand(dbg, 'Runtime.evaluate', { expression: '__BBR.clearTx()' });
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
      const r = await __BBR.readSiteAll({ fetchScript: ${!!opts.fetchScript}, opfs: ${opts.opfs !== false}, buckets: ${opts.buckets !== false}, sessionStorage: ${opts.sessionStorage !== false}, serviceWorkers: ${opts.serviceWorkers !== false} });
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
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : SITE_DATA_CONFIG.retry.readTimeoutMs;
  let timer = 0;
  try {
    return await Promise.race([
      readTabSnapshot(tabId, lib, opts),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`read timed out after ${ms}ms`)), ms);
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
//     its last tab).
//   * Tabs are closed and the debugger detached in finally blocks on every
//     path, including errors and timeouts; the slot is released there too.

const SCAN_GROUP_TITLE = 'BBR Site Scan';
const SCAN_GROUP_COLOR = 'grey';
// (Window, CPU and load tuning now lives in SITE_DATA_CONFIG above.)

function clampScanWindow(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return SITE_DATA_CONFIG.window.default;
  return Math.min(SITE_DATA_CONFIG.window.max, Math.max(SITE_DATA_CONFIG.window.min, n));
}

// Generic integer clamp for UI-overridable tunables.
function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Counting semaphore with a dynamic limit. acquire() waits while
// used >= limit(); release() wakes waiters; kick() re-evaluates waiters
// after the limit changed (adaptive window growth).
//
// Runtime guard: every grant is checked against the limit — a grant while
// used >= limit() can only come from a bug, and fires onViolation (the
// crawler aborts instead of silently continuing). abort() wakes all waiters
// with `false` and refuses further grants, so a stopped crawl can't hang in
// acquire(). Exported for tests.
export function createSlotPool(limitFn, onViolation) {
  let used = 0;
  let aborted = false;
  const waiters = [];
  // Grant-time invariant: a new slot may only be handed out while the owned
  // in-flight count is below the EFFECTIVE limit. (A shrink below `used`
  // does NOT violate this — in-flight tabs finish naturally; only new grants
  // are gated.)
  const checkGrant = () => {
    if (used > limitFn() && typeof onViolation === 'function') {
      onViolation(`slot window breached: ${used} owned tabs in flight above the effective limit ${limitFn()}`);
    }
  };
  const pump = () => {
    if (aborted) return;
    while (waiters.length > 0 && used < limitFn()) {
      used++;
      checkGrant();
      waiters.shift()(true);
    }
  };
  return {
    get used() {
      return used;
    },
    limit() {
      return limitFn();
    },
    waiting() {
      return waiters.length;
    },
    get isAborted() {
      return aborted;
    },
    // Resolves true when a slot is granted, false when the pool was aborted.
    async acquire() {
      if (aborted) return false;
      if (used < limitFn()) {
        used++;
        checkGrant();
        return true;
      }
      const granted = await new Promise((resolve) => waiters.push(resolve));
      return granted === true && !aborted;
    },
    release() {
      if (used > 0) used--;
      pump();
    },
    kick() {
      pump();
    },
    abort() {
      aborted = true;
      while (waiters.length > 0) waiters.shift()(false);
    },
  };
}

// Minimal async FIFO queue between the workers.
function createAsyncQueue() {
  const items = [];
  const takers = [];
  return {
    push(item) {
      if (takers.length > 0) takers.shift()(item);
      else items.push(item);
    },
    take() {
      if (items.length > 0) return Promise.resolve(items.shift());
      return new Promise((resolve) => takers.push(resolve));
    },
    size() {
      return items.length;
    },
  };
}

// One scan group for the whole run. All concurrent openers share a single
// creation promise, so no duplicate groups can form; the group id is
// revalidated on every use and recreated when invalid.
function createGroupManager() {
  let groupId = null;
  let creating = null;
  const clearCreating = () => {
    creating = null;
  };
  async function createWith(tabId) {
    const id = await chrome.tabs.group({ tabIds: tabId });
    try {
      await chrome.tabGroups.update(id, { title: SCAN_GROUP_TITLE, color: SCAN_GROUP_COLOR, collapsed: false });
    } catch (e) {
      /* cosmetic — ignore */
    }
    return id;
  }
  async function ensureGroup(tabId) {
    if (groupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: tabId, groupId });
        return groupId;
      } catch (e) {
        // Distinguish "group is gone" (recreate) from "tab is bad" (fail).
        let valid = false;
        try {
          await chrome.tabGroups.get(groupId);
          valid = true;
        } catch (err) {
          /* gone */
        }
        if (!valid) groupId = null;
        else throw e;
      }
    }
    if (!creating) {
      creating = createWith(tabId);
      creating.then((id) => {
        groupId = id;
        clearCreating();
      }, clearCreating);
    }
    const id = await creating;
    // Another tab may have won the bootstrap race — make sure this one is in.
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.groupId !== id) await chrome.tabs.group({ tabIds: tabId, groupId: id });
    } catch (e) {
      /* tab vanished; the closer handles it */
    }
    return id;
  }
  return {
    ensureGroup,
    get id() {
      return groupId;
    },
  };
}

// Per-operation tab ownership registry.
//
// ONLY tabs explicitly registered via own() — immediately after the
// operation created them via chrome.tabs.create — may ever be closed, and
// then exclusively through safeCloseTab. safeCloseTab REFUSES (never calls
// chrome.tabs.remove, logs a warning) any tabId outside the registry.
// Closing is never decided by a tab query or by group membership: group
// contents are untrusted (the user may drag their own tabs into the group).
// The group is never deleted directly and windows are never removed — the
// group disappears on its own when its last tab closes.
//
// verify(tabId, origin): async -> 'ours' | 'foreign' | 'gone'. Decides
// whether a registered tab is still ours to close.
// onViolation(reason): called when a close is attempted on a tab outside the
// registry — a bug; the caller aborts loudly instead of silently continuing.
// Sample system CPU usage as a 0-100 percentage, or null when unavailable.
// chrome.system.cpu reports cumulative per-processor counters
// ({idle, kernel, total, user}); the percentage is derived from deltas, so
// the formula is unit-independent. Needs the "system.cpu" permission.
function createSystemCpuSampler() {
  let prev = null;
  const countersOf = (u) => {
    if (!u || typeof u !== 'object') return null;
    const total = Number(u.total);
    const idle = Number(u.idle);
    if (Number.isFinite(total) && Number.isFinite(idle) && total > 0) return { total, idle };
    const k = Number(u.kernel),
      usr = Number(u.user);
    if (Number.isFinite(k) && Number.isFinite(usr) && Number.isFinite(idle) && k + usr + idle > 0)
      return { total: k + usr + idle, idle };
    return null;
  };
  return async () => {
    try {
      if (!chrome.system || !chrome.system.cpu || typeof chrome.system.cpu.getInfo !== 'function') return null;
      const info = await chrome.system.cpu.getInfo();
      const now = Date.now();
      const procs = (info && info.processors) || [];
      const cur = procs.map((pr) => countersOf(pr.usage)).filter(Boolean);
      let pct = null;
      if (prev && cur.length === prev.counters.length && cur.length > 0) {
        const dt = now - prev.t;
        void dt;
        let dBusy = 0,
          dTotal = 0;
        for (let i = 0; i < cur.length; i++) {
          const dT = cur[i].total - prev.counters[i].total;
          const dI = cur[i].idle - prev.counters[i].idle;
          if (dT > 0 && dI >= 0 && dI <= dT) {
            dTotal += dT;
            dBusy += dT - dI;
          }
        }
        if (dTotal > 0) pct = Math.min(100, Math.max(0, (dBusy / dTotal) * 100));
      }
      prev = { t: now, counters: cur };
      return pct; // null on the first sample (no delta yet)
    } catch (e) {
      return null;
    }
  };
}

// Sliding-window load monitor: records per-tab load outcomes for OWNED tabs
// (reused user tabs resolve instantly and would dilute the signal) and
// reports timeout rate + average load time over the last N tabs.
export function createLoadMonitor(size) {
  const samples = [];
  return {
    record({ loadMs, timedOut }) {
      samples.push({ loadMs: Math.max(0, Number(loadMs) || 0), timedOut: !!timedOut });
      while (samples.length > size) samples.shift();
    },
    stats() {
      const n = samples.length;
      if (!n) return null;
      const timeouts = samples.filter((s) => s.timedOut).length;
      const avgLoadMs = samples.reduce((a, s) => a + s.loadMs, 0) / n;
      return { n, timeoutRate: timeouts / n, avgLoadMs };
    },
  };
}

// Adaptive window controller.
//
// Two independent shrink triggers (fast down):
//   1. CPU guard: samples system CPU every second (percentage from the delta
//      of two cumulative readings; see createSystemCpuSampler). "100%" counts
//      as >= 95%. While it persists continuously for MORE than 10 seconds,
//      the effective window is halved (minimum 2) and the 10s count is reset
//      so it can drop again if still high.
//   2. Load guard (earlier signal): tab load timeout rate / average load time
//      over the sliding window of the last N owned tabs (see
//      createLoadMonitor). Reacts before the CPU pegs, when tabs already
//      load slowly and time out.
// Shrinking never closes already-open tabs — Worker 1 just stops opening new
// ones until the owned tab count drops below the new effective limit; the
// hard cap keeps being enforced at the effective value.
// Slow up: only after CPU stays < 70% for ~15s AND the load signal is healthy
// does the window grow back (+2), never above maxWindow (the UI setting).
// Fast down, slow up, so it doesn't oscillate.
// Exported for tests; sampleMs/highMs/lowSamples/loadStats are injectable.
export function startCpuMonitor({
  getWindow,
  setWindow,
  maxWindow,
  onAdjust,
  sampler,
  sampleMs,
  highMs,
  lowSamples,
  loadStats,
}) {
  const CFG = SITE_DATA_CONFIG;
  const interval = Number.isFinite(sampleMs) && sampleMs > 0 ? sampleMs : CFG.cpu.sampleMs;
  const highThresholdMs = Number.isFinite(highMs) && highMs > 0 ? highMs : CFG.cpu.highMs;
  const lowThresholdSamples =
    Number.isFinite(lowSamples) && lowSamples > 0 ? Math.floor(lowSamples) : CFG.cpu.lowSamples;
  let highSince = 0,
    lowStreak = 0,
    stopped = false,
    timer = 0,
    lastLoadShrinkAt = 0;
  const shrink = (reason) => {
    const cur = getWindow();
    const next = Math.max(CFG.cpu.floor, Math.floor(cur / 2));
    if (next < cur) {
      setWindow(next);
      onAdjust(`${reason} — window ${cur} → ${next}`);
      return true;
    }
    return false;
  };
  async function tick() {
    if (stopped) return;
    const now = Date.now();
    let cpuHigh = false,
      cpuLow = false;
    try {
      const pct = await sampler();
      if (typeof pct === 'number' && Number.isFinite(pct)) {
        if (pct >= CFG.cpu.highPct) {
          cpuHigh = true;
          if (!highSince) highSince = now;
          lowStreak = 0;
        } else if (pct < CFG.cpu.lowPct) {
          cpuLow = true;
          highSince = 0;
          lowStreak++;
        } else {
          highSince = 0;
          lowStreak = 0;
        }
      } else {
        highSince = 0;
        lowStreak = 0;
      }
    } catch (e) {
      highSince = 0;
      lowStreak = 0; /* sampler hiccup — skip this round */
    }

    let shrank = false;
    if (cpuHigh && now - highSince > highThresholdMs) {
      shrank = shrink(`system CPU ≥ ${CFG.cpu.highPct}% for >10s`);
      highSince = now; // reset the 10s count so it can drop again
    }
    // Load guard: earlier than CPU. Needs enough samples; hysteresis between
    // the shrink and recover thresholds; cooldown between load shrinks.
    let loadDegraded = false,
      loadHealthy = true,
      ls;
    try {
      ls = typeof loadStats === 'function' ? loadStats() : null;
    } catch (e) {
      ls = null;
    }
    if (ls && ls.n >= CFG.load.minSamples) {
      loadDegraded = ls.timeoutRate > CFG.load.timeoutRateHigh || ls.avgLoadMs > CFG.load.avgMsHigh;
      loadHealthy = ls.timeoutRate <= CFG.load.timeoutRateRecovered && ls.avgLoadMs <= CFG.load.avgMsRecovered;
    }
    if (!shrank && loadDegraded && now - lastLoadShrinkAt > CFG.load.shrinkCooldownMs) {
      shrank = shrink(
        `tab load degraded (timeout ${(ls.timeoutRate * 100).toFixed(0)}%, avg ${(ls.avgLoadMs / 1000).toFixed(1)}s over last ${ls.n} tabs)`
      );
      lastLoadShrinkAt = now;
    }
    if (!shrank && cpuLow && loadHealthy && lowStreak >= lowThresholdSamples) {
      lowStreak = 0;
      const cur = getWindow();
      const next = Math.min(maxWindow, cur + 2);
      if (next > cur) {
        setWindow(next);
        onAdjust(`system CPU < ${CFG.cpu.lowPct}% and tab load healthy ~15s — window ${cur} → ${next}`);
      }
    }
    if (!stopped) timer = setTimeout(tick, interval);
  }
  timer = setTimeout(tick, interval);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

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
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['lib/pagelib.js'] });
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => {
          try {
            if (window.top === window) return { mainFrame: true };
            if (!globalThis.__BBR) return { error: 'pagelib missing' };
            return (async () => {
              const r = await __BBR.readSiteAll({ fetchScript: false, opfs: false, buckets: false });
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

async function restorePartitions(partitions, mode, _progress) {
  const stats = { restored: 0, skippedNoHost: 0, notes: [] };
  if (!partitions || !partitions.length) return stats;
  // group by topSite
  const byTop = new Map();
  for (const p of partitions) {
    if (!byTop.has(p.topSite)) byTop.set(p.topSite, []);
    byTop.get(p.topSite).push(p);
  }
  const tabs = await chrome.tabs.query({});
  for (const [topSite, list] of byTop) {
    const hosts = tabs.filter((t) => !t.incognito && originOf(t.url) === topSite);
    if (!hosts.length) {
      stats.skippedNoHost += list.length;
      stats.notes.push(
        `partitioned data of ${list.map((p) => p.frameOrigin).join(', ')} under ${topSite} kept in backup — requires the embedding site to be open during restore`
      );
      continue;
    }
    for (const tab of hosts) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['lib/pagelib.js'] });
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
          args: [JSON.stringify({ byOrigin: Object.fromEntries(list.map((p) => [p.frameOrigin, p.snapshot])) }), mode],
        });
        for (const r of results) {
          if (r.result && r.result.frameOrigin) stats.restored++;
        }
      } catch (e) {
        stats.notes.push(`partition restore into ${topSite}} failed: ${e.message}`);
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
  let list = origins.map((item) => (typeof item === 'string' ? item : item.origin));
  if (Array.isArray(opts.includeOrigins)) {
    const included = new Set(opts.includeOrigins);
    list = list.filter((origin) => included.has(origin));
  }
  if (Array.isArray(opts.excludeOrigins) && opts.excludeOrigins.length) {
    const excluded = new Set(opts.excludeOrigins);
    list = list.filter((origin) => !excluded.has(origin));
  }
  const candidateCount = list.length;
  const max = Number.isFinite(opts.maxOrigins) && opts.maxOrigins > 0 ? opts.maxOrigins : Number.MAX_SAFE_INTEGER;
  return { origins: list.slice(0, max), truncated: candidateCount > max, candidateCount };
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
  const errors = snapshot && Array.isArray(snapshot.errors) ? snapshot.errors : [];
  for (const entry of errors) {
    const message = String(entry);
    const separator = message.indexOf(':');
    addFailure(
      separator > 0 ? message.slice(0, separator).trim() : 'unknown',
      separator > 0 ? message.slice(separator + 1).trim() : message
    );
  }
  if (snapshot && snapshot.opfs && snapshot.opfs.error) addFailure('opfs', snapshot.opfs.error);
  if (snapshot && snapshot.buckets && snapshot.buckets.error) addFailure('buckets', snapshot.buckets.error);
  return failures;
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
    log('INFO', 'SYSTEM', `crawl started: ${list.length} origin(s) selected`, { crawlId, originCount: list.length });
    if (selection.truncated) {
      const msg = `origin scan capped at ${list.length} of ${selection.candidateCount} selected candidate origins`;
      note(msg);
      log('WARN', 'SYSTEM', msg, { selected: list.length, candidates: selection.candidateCount });
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
  const readOpts = {
    fetchScript: opts.fetchScript !== false,
    // Non-restorable categories default OFF (not captured at all — saves time
    // and storage). See SITE_DATA_INCLUDE in backup-categories.ts.
    sessionStorage: opts.includeSessionStorage === true,
    serviceWorkers: opts.includeServiceWorkers === true,
  };
  function logExcludedReadCategories(options) {
    if (options.sessionStorage && options.serviceWorkers) return;
    const skipped = [
      ...(!options.sessionStorage ? ['sessionStorage'] : []),
      ...(!options.serviceWorkers ? ['serviceWorkers'] : []),
    ];
    log(
      'INFO',
      'SYSTEM',
      `site-data capture excludes: ${skipped.join(', ')} (not reliably restorable; enable in Pengaturan to include)`,
      { excludedCategories: skipped }
    );
  }
  logExcludedReadCategories(readOpts);
  // UI-overridable tunables (clamped; dashboard Pengaturan page).
  const retryMaxAttempts = clampInt(opts.retryMaxAttempts, 1, 5, SITE_DATA_CONFIG.retry.maxAttempts);
  const readTimeoutMs = clampInt(opts.readTimeoutMs, 15000, 180000, SITE_DATA_CONFIG.retry.readTimeoutMs);
  const checkpointEvery = clampInt(opts.checkpointEveryOrigins, 5, 50, SITE_DATA_CONFIG.checkpointEveryOrigins);
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
        error: error || null,
      });
    };
    const listStates = () => [...states.values()];
    for (const origin of origins) states.set(origin, { origin, status: 'pending', attempts: 0, error: null });
    return { states, setState, listStates };
  }
  const { states: urlStates, setState: setUrlState, listStates: urlStateList } = createUrlStateStore(list);

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
      const checkpoint = storage ? await storage.get(SITE_DATA_CONFIG.checkpointKey) : null;
      const saved = checkpoint && checkpoint[SITE_DATA_CONFIG.checkpointKey];
      if (!saved || !saved.origins || typeof saved.origins !== 'object') return resumed;
      const savedStates = saved.states && typeof saved.states === 'object' ? saved.states : {};
      for (const origin of list) {
        if (!saved.origins[origin]) continue;
        originsOut[origin] = saved.origins[origin];
        if (savedStates[origin] === 'saved') {
          setUrlState(origin, 'saved');
          resumed++;
        } else setUrlState(origin, 'fetched'); // data present — needs re-save only
      }
      if (resumed) {
        note(`sitedata: resumed ${resumed} origin(s) from the previous checkpoint`, 'INFO', 'SYSTEM', {
          resumedCount: resumed,
        });
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
      if (state && ['saved', 'fetched', 'skipped'].includes(state.status)) continue;
      if (exclusionDisabled) continue;
      const { excluded, reason } = isExcluded(origin);
      if (!excluded) continue;
      setUrlState(origin, 'skipped', reason);
      skipped++;
      log('INFO', 'SYSTEM', `skipped ${origin} — ${reason}`, { url: origin, corr: origin, reason });
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
  const stats = { done: 0, fetched: 0, failed: 0, aborted: 0, inGroup: 0, total, skipped: 0 };
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
    if (value === undefined) throw new Error(`dipanggil sebelum diinisialisasi: ${name}`);
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
      log('DEBUG', 'SYSTEM', `slot pool abort threw (benign): ${(e && e.message) || e}`, {});
    }
    const tag = isViolation ? 'ABORTED' : 'STOPPED';
    note(`sitedata: ${tag} — ${reason}`, isViolation ? 'FATAL' : 'WARN', isViolation ? 'SAFETY' : 'SYSTEM', { reason });
    report(`sitedata: ${tag} — ${reason} (partial results kept; resume to continue the rest)`);
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
    report('sitedata: stopping — sedang membersihkan…');
    const force = () => {
      if (stopPhase === 'stopping') {
        log('INFO', 'SYSTEM', 'stop grace period ended — forcing halt', {});
        haltCrawl(reason || 'dihentikan oleh pengguna', false);
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
        log('INFO', 'SYSTEM', 'workers drained during STOPPING — halting now', {});
        haltCrawl(reason || 'dihentikan oleh pengguna', false);
      }
    }, 200);
  }
  const checkStop = () => {
    if (!halted && isStopRequested()) requestStop('dihentikan oleh pengguna');
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
    log('WARN', 'RETRY', `added to failed pool (attempt ${attempt}): ${error}`, {
      url: origin,
      corr: origin,
      attempt,
      error,
      poolSize: failedPool.length,
    });
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
      log('INFO', 'STORAGE', `checkpoint saved: ${n} origin(s) persisted`, { saved: n, total: stats.done });
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
        states: Object.fromEntries([...urlStates].map(([o, st]) => [o, st.status])),
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
        const n = [...urlStates.values()].filter((st) => st.status === 'save-failed').length;
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
  // Live crawl status for the dashboard status bar (Log + Ringkasan pages).
  liveStatus = {
    state: 'running', // running | stopped | done | fatal
    worker1: 'idle', // what Worker 1 is doing right now
    worker2: 'idle', // what Worker 2 is doing right now
  };
  w1Active = 0; // opens in flight
  w2Active = 0; // reads in flight
  updateWorkers = () => {
    liveStatus.worker1 = w1Active > 0 ? `membuka ${w1Active} tab` : halted ? 'berhenti' : 'menunggu';
    liveStatus.worker2 = w2Active > 0 ? `membaca ${w2Active} tab` : halted ? 'berhenti' : 'menunggu';
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
    safeProgress(progress, msg, typeof frac === 'number' ? frac : undefined, st === undefined ? liveStats() : st);
  report = (msg) => pg(msg, fracFor(completed));

  readyQueue = createAsyncQueue();
  const groupMgr = createGroupManager();
  const DONE = Symbol('sitedata-done');
  // Tab ownership: ONLY tabs Worker 1 creates below may ever be closed, and
  // then solely through ownership.safeCloseTab (refuses anything else).
  const ownership = createSiteDataOwnership(notes, (reason) => haltCrawl(reason, true), log);
  // Persist owned IDs for crash recovery (dashboard reopen cleans by ID,
  // never by query). Best-effort; failures never stop the crawl.
  const persistOwnedIds = async () => {
    try {
      const s = storageLocal();
      if (!s) return;
      const ids = [...ownership.ownedTabIds];
      if (ids.length) await s.set({ [stopCfg.ownedTabsKey]: { tabIds: ids, savedAt: Date.now(), crawlId } });
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
          log('DEBUG', 'W2', `ungroup failed for taken-over tab (benign): ${(e && e.message) || e}`, {
            url: rec.origin,
            corr: rec.origin,
            tabId: rec.tab.id,
          });
        }
        note(
          `sitedata: left scan tab for ${rec.origin} untouched — it no longer shows the scan page`,
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
      log('DEBUG', 'W1', `findOpenTab failed (benign): ${(error && error.message) || error}`, { url: origin, corr });
    }
    if (existing && (existing.url || '').includes(SCAN_MARKER)) existing = null;
    if (!existing) return false;

    log('INFO', 'W1', `reusing open tab ${existing.id} (not owned — never closed/grouped)`, {
      url: origin,
      corr,
      tabId: existing.id,
      attempt,
    });
    const ok = await waitTabReady(existing.id, origin, isStopRequested);
    releaseWorker();
    if (!ok) {
      if (!halted && !isStopRequested()) {
        setUrlState(origin, 'fetch-failed', 'open tab did not settle');
        note(`${origin}: open tab did not settle — skipped`, 'WARN', 'W1', { url: origin, corr: origin });
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
    const tab = await chrome.tabs.create({
      url: scanUrlFor(rec.origin),
      active: false,
      ...(scanWindowId !== null ? { windowId: scanWindowId } : {}),
    });
    rec.tab = tab;
    ownership.own(tab.id); // register IMMEDIATELY after successful create
    void persistOwnedIds();
    log('INFO', 'W1', `tab ${tab.id} created`, {
      url: rec.origin,
      corr: rec.origin,
      tabId: tab.id,
      attempt,
      window: effectiveWindow,
    });
    if (scanWindowId === null) scanWindowId = tab.windowId;
    trackScanTab(rec);
    await groupMgr.ensureGroup(tab.id); // straight into the one scan group
    log('DEBUG', 'W1', `tab ${tab.id} added to scan group`, {
      url: rec.origin,
      corr: rec.origin,
      tabId: tab.id,
      groupId: groupMgr.id,
    });
    rec.grouped = true;
    stats.inGroup++;
    const startedAt = Date.now();
    const ok = await waitTabReady(tab.id, rec.origin, isStopRequested);
    const loadMs = Date.now() - startedAt;
    loadMon.record({ loadMs, timedOut: !ok }); // early load signal
    log(
      ok ? 'DEBUG' : 'WARN',
      'W1',
      ok ? `tab ${tab.id} finished loading in ${loadMs}ms` : `tab ${tab.id} did not finish loading in time`,
      { url: rec.origin, corr: rec.origin, tabId: tab.id, durationMs: loadMs, attempt }
    );
    if (!ok) throw new Error(halted || isStopRequested() ? 'cancelled' : 'tab did not finish loading in time');
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
    const rec = { origin, tab: null, grouped: false, finished: false, owned: true };
    let handedOff = false;
    try {
      await prepareOwnedScanTab(rec, attempt);
      readyQueue.push(rec); // push the SAME rec object (identity matters: the safety net tracks this exact object)
      handedOff = true;
    } catch (error) {
      const message = (error && error.message) || String(error);
      if (!halted && !isStopRequested()) {
        addToFailedPool(origin, attempt, message);
        note(`${origin}: open attempt ${attempt} failed (${message}) — added to failed pool`, 'WARN', 'RETRY', {
          url: origin,
          corr: origin,
          attempt,
          error: message,
        });
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
    log('DEBUG', 'W1', `queued (attempt ${attempt}/${retryMaxAttempts})`, { url: origin, corr, attempt });
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
    log('INFO', 'SYSTEM', 'read cancelled during STOPPING — marked unfinished (resumable)', {
      url: rec.origin,
      corr: rec.origin,
      tabId: rec.tab.id,
    });
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
      const snapshot = await readWithTimeout(rec.tab.id, lib, readOpts, readTimeoutMs);
      const readMs = Date.now() - startedAt;
      for (const failure of siteDataCategoryFailures(snapshot)) {
        note(
          `${rec.origin}: ${failure.category} capture failed (${failure.error}); other categories were retained`,
          'ERROR',
          'W2',
          { url: rec.origin, corr: rec.origin, category: failure.category, error: failure.error }
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
      note(`${rec.origin}: read attempt ${rec.attempt} failed (${message}) — added to failed pool`, 'WARN', 'RETRY', {
        url: rec.origin,
        corr: rec.origin,
        tabId: rec.tab.id,
        attempt: rec.attempt,
        error: message,
      });
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
      note('sitedata: adaptive window — ' + reason, 'WARN', /cpu/i.test(reason) ? 'CPU' : 'LOAD', {
        reason,
        window: effectiveWindow,
        windowMax: configuredWindow,
      });
      slots.kick(); // re-evaluate waiters: a grown window unblocks openers
      report(`sitedata: scan window now ${effectiveWindow}/${configuredWindow}`);
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
      for (let i = 0; i < SITE_DATA_CONFIG.readConcurrency; i++) activeReaders.push(readerLoop());
      await Promise.all(items.map((work) => openOne(work.origin, work.attempt)));
      for (let i = 0; i < activeReaders.length; i++) readyQueue.push(DONE);
      await Promise.all(activeReaders);
      activeReaders = [];
    }

    await runWave(workList.map((origin) => ({ origin, attempt: 1 })));

    for (let attempt = 2; attempt <= retryMaxAttempts && failedPool.length > 0 && !halted; attempt++) {
      const items = failedPool.splice(0).map((failure) => ({ origin: failure.origin, attempt }));
      const phaseMsg = `sitedata: retry phase — attempt ${attempt}/${retryMaxAttempts} (${items.length} URL(s))`;
      log('INFO', 'RETRY', `retry phase started: attempt ${attempt}/${retryMaxAttempts} for ${items.length} URL(s)`, {
        attempt,
        maxAttempts: retryMaxAttempts,
        count: items.length,
      });
      note(phaseMsg, 'INFO', 'RETRY', { attempt, maxAttempts: retryMaxAttempts, count: items.length });
      report(phaseMsg);
      await runWave(items);
      log('INFO', 'RETRY', `retry phase ended: ${failedPool.length} URL(s) still failing`, {
        attempt,
        remaining: failedPool.length,
      });
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
      note('partitioned storage scan failed: ' + ((error && error.message) || error), 'ERROR', 'W2', {
        error: (error && error.message) || String(error),
      });
    }

    pg('sitedata: complete', 1);
    liveStatus.state = 'done';
    updateWorkers();
    log('INFO', 'SYSTEM', `crawl complete: ${stats.done}/${total} saved, ${stats.failed} failed`, {
      done: stats.done,
      failed: stats.failed,
      total,
    });
    const excludedCategories = Array.isArray(opts.excludedSiteDataCategories) ? opts.excludedSiteDataCategories : [];
    return {
      schemaVersion: 1,
      method: 'chrome.debugger+scripting (page-context execution)',
      origins: originsOut,
      partitions,
      notes,
      urlStates: urlStateList(),
      crawlId,
      excludedCategories, // site-data sub-categories not captured (not reliably restorable)
    };
  }

  async function drainSiteDataReadersAndTabs() {
    for (let i = 0; i < SITE_DATA_CONFIG.readConcurrency; i++) readyQueue.push(DONE);
    if (cpuMon) cpuMon.stop();
    await Promise.all(activeReaders);
    for (const rec of [...scanTabs]) {
      try {
        await finishScanTab(rec);
      } catch (error) {
        log('WARN', 'SYSTEM', `safety-net finishScanTab threw: ${(error && error.message) || error}`, {
          url: rec.origin,
          corr: rec.origin,
        });
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
        await new Promise((resolve) => setTimeout(resolve, stopCfg.verifyDelayMs));
      }
    }
    const leftover = [...ownership.ownedTabIds];
    if (leftover.length) {
      const message = `cleanup incomplete: ${leftover.length} owned tab(s) could not be closed: ${leftover.join(', ')}`;
      log('ERROR', 'SYSTEM', message, { tabIds: leftover });
      note(`sitedata: WARNING — ${message}`, 'ERROR', 'SYSTEM', { tabIds: leftover });
    } else {
      log('INFO', 'SYSTEM', 'cleanup verified: no owned tabs remain', {});
    }
    return leftover;
  }

  async function persistOwnedTabRecord(leftover) {
    try {
      const storage = storageLocal();
      if (!storage) return;
      if (leftover.length) await storage.set({ [stopCfg.ownedTabsKey]: { tabIds: leftover, savedAt: Date.now() } });
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
    ownership.dispose();
  }

  async function cleanupSiteDataCrawl() {
    // Cleanup also runs on user Stop. Tabs are only touched through the owned-ID verifier.
    log('INFO', 'SYSTEM', 'cleanup: detaching debuggers and closing owned tabs', {
      owned: ownership.ownedTabIds.size,
    });
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
    for (const d of dbs || []) for (const s of d.stores || []) idbRecords += (s.records || []).length;
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
    if (res.buckets) stats.bucketsTouched += (res.buckets.bucketsOpened || []).length;
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
      stats.notes.push(`sessionStorage restore failed for ${origin}: ${r.error}`);
    }
  }
  // Ownership for tabs this restore creates: only those may be closed, via
  // safeCloseTab. A reused pre-existing tab is never closed. A refusal can
  // only come from a bug — log it loudly and skip the close.
  const ownership = createSiteDataOwnership(stats.notes, (reason) =>
    stats.notes.push(`sitedata: SAFETY VIOLATION during restore — ${reason}; close skipped`)
  );
  const entries = Object.entries(section.origins || {});
  let i = 0;
  for (const [origin, snap] of entries) {
    try {
      if (progress) progress(`sitedata: restoring ${origin} (${i + 1}/${entries.length})`);
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
            stats.notes.push(`sitedata: left restore tab for ${origin} untouched — it no longer shows the scan page`);
          }
        }
      }
    } catch (e) {
      stats.originsFailed++;
      stats.notes.push(`${origin}}: restore failed (${(e && e.message) || e})`);
    }
    i++;
    await yieldToUI();
  }

  try {
    const pr = await restorePartitions(section.partitions || [], 'merge', progress);
    stats.partitionsRestored = pr.restored;
    stats.partitionsWithoutHost = pr.skippedNoHost;
    stats.notes.push(...pr.notes);
  } catch (e) {
    stats.notes.push('partitioned restore failed: ' + ((e && e.message) || e));
  }

  if (mode === 'replace') {
    stats.notes.push("Replace mode: each origin's site storage was wiped before restoring (explicitly confirmed).");
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
