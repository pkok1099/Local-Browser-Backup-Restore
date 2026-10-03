// Tab ownership safety kernel.
//
// Decides which tabs an operation may ever close, and enforces it at
// runtime: ONLY tabs registered via own() immediately after
// chrome.tabs.create may be closed, and then solely through
// safeCloseTab. A runtime wrapper around chrome.tabs.remove rejects
// anything outside the registry (aliases and destructuring included).
import { createSiteLogger } from './site-log.js';
import { SITE_DATA_CONFIG } from './scan-config.js';

export const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch (e) {
    return null;
  }
};

export const SCAN_MARKER = '/__bbr_site_scan__';

export function scanUrlFor(origin) {
  return origin + SCAN_MARKER;
}

const guardedTabsNamespaces = new WeakSet();
const activeGuardLoggers = new Map();
let activeSafeClosePermit = null;
const fallbackTabRemovalLogger = createSiteLogger({
  crawlId: 'tab-removal-guard',
});

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
  if (!tabs || typeof tabs !== 'object' || typeof tabs.remove !== 'function')
    return false;
  if (guardedTabsNamespaces.has(tabs)) return true;

  const nativeRemove = tabs.remove.bind(tabs);
  const guardedRemove = function (tabIds, ...args) {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    const tabId = ids.length === 1 ? ids[0] : undefined;
    const permit = activeSafeClosePermit;
    if (
      !permit ||
      ids.length !== 1 ||
      tabId !== permit.tabId ||
      !permit.ownedTabIds.has(tabId)
    ) {
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
    Object.defineProperty(tabs, 'remove', {
      configurable: true,
      writable: true,
      value: guardedRemove,
    });
  } catch (e) {
    reportTabRemovalGuard(
      undefined,
      `could not install runtime wrapper: ${(e && e.message) || e}`
    );
    return false;
  }
  if (tabs.remove !== guardedRemove) {
    reportTabRemovalGuard(
      undefined,
      'runtime wrapper installation did not take effect'
    );
    return false;
  }
  guardedTabsNamespaces.add(tabs);
  return true;
}

// Chrome exposes the API namespace before extension scripts run; install the
// guard at module evaluation, then retry lazily for test and embedded contexts.
installTabsRemoveGuard();

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
export function createTabOwnership(notes, verify, onViolation, logFn) {
  installTabsRemoveGuard();
  const ownedTabIds = new Set();
  const closingTabIds = new Set();
  // Tabs the user activated at least once while we owned them. A background
  // tab the user never activated cannot have been user-navigated (no UI
  // gesture navigates a background tab without activating it), so a
  // markerless page there is the SITE's doing. A touched tab, however, may
  // have been taken over — the verifier must never close it. Tracked via
  // chrome.tabs.onActivated; the synchronous tab.active check in the verifier
  // remains the first line of defense (it needs no event).
  const userTouchedTabIds = new Set();
  const onTabActivated = (info) => {
    const id = info && info.tabId;
    if (ownedTabIds.has(id)) userTouchedTabIds.add(id);
  };
  globalThis.chrome?.tabs?.onActivated?.addListener?.(onTabActivated);
  // Drop stale IDs the moment a tab disappears: without this, a tab the user
  // closed externally stays registered until finishScanTab's finally runs,
  // and a later safeCloseTab would verify whatever now sits behind the ID.
  const onTabRemoved = (tabId) => {
    ownedTabIds.delete(tabId);
    userTouchedTabIds.delete(tabId);
    closingTabIds.delete(tabId);
  };
  globalThis.chrome?.tabs?.onRemoved?.addListener?.(onTabRemoved);
  let disposed = false;
  if (typeof logFn === 'function')
    activeGuardLoggers.set(logFn, (activeGuardLoggers.get(logFn) || 0) + 1);
  const dispose = () => {
    globalThis.chrome?.tabs?.onActivated?.removeListener?.(onTabActivated);
    globalThis.chrome?.tabs?.onRemoved?.removeListener?.(onTabRemoved);
    if (disposed || typeof logFn !== 'function') return;
    disposed = true;
    const refs = (activeGuardLoggers.get(logFn) || 1) - 1;
    if (refs > 0) activeGuardLoggers.set(logFn, refs);
    else activeGuardLoggers.delete(logFn);
  };
  const own = (tabId, wasActive) => {
    ownedTabIds.add(tabId);
    // The create response already tells us if the tab came up active (the
    // platform ignored active:false, or something activated it before own()
    // ran): the onActivated listener can never have seen that, so mark it
    // touched here — an event-independent backstop.
    if (wasActive) userTouchedTabIds.add(tabId);
  };
  async function safeCloseTab(tabId, origin) {
    if (!ownedTabIds.has(tabId) || closingTabIds.has(tabId)) {
      const reason = `refused to close tab ${tabId} — not owned by this operation or already closing`;
      if (notes)
        notes.push(
          `SAFETY VIOLATION: REFUSED to close tab ${tabId} — not owned by this operation`
        );
      if (typeof logFn === 'function') {
        try {
          logFn(
            'ERROR',
            'SAFETY',
            `refused to close tab ${tabId} — not owned by this operation`,
            {
              tabId,
              url: origin,
              corr: origin,
            }
          );
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
        verdict = await verify(tabId, origin, userTouchedTabIds);
      } catch (e) {
        verdict = 'gone';
      }
      if (verdict === 'gone') return 'gone';
      if (verdict !== 'ours' && verdict !== 'failed') return 'kept'; // taken over — never close it

      // Failed loads are ours; a normal close also requires a positive page
      // verification. The runtime wrapper consumes this one-use permit before
      // dispatching the native API, so aliases/destructuring cannot bypass it.
      if (!installTabsRemoveGuard())
        throw new Error('tab removal runtime guard is unavailable');
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
      userTouchedTabIds.delete(tabId); // re-owning starts clean
    }
  }
  return { ownedTabIds, own, safeCloseTab, dispose };
}

// Verifier for the site-data crawl: a registered tab is ours to close only
// while it still shows our scan page (safety: when in doubt, don't close).
// An empty origin means "origin unknown" (crash-recovery / beforeunload
// cleanup — the persisted record carries IDs only). Then a page carrying the
// scan marker still verifies as ours (no legitimate user page contains the
// marker), but an error page does NOT verify as failed: the tab ID may have
// been reused by a user tab in the new session, and an error page alone
// proves nothing about ownership.
//
// userTouchedTabIds (3rd arg, supplied by createTabOwnership): tabs the user
// activated at least once during our ownership. Such a tab may have been
// taken over — whatever it shows now, never close it. A tab the user never
// activated, however, cannot have been user-navigated, so a markerless page
// there is the SITE's doing (redirect to an error page, possibly
// cross-origin) and the tab is closed instead of abandoned ungrouped.
export async function verifyScanTab(tabId, origin, userTouchedTabIds) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return 'gone';
  } // already gone
  // A tab the user is currently viewing is never closed, whatever it shows —
  // closing it would destroy their active browsing. This also covers a user
  // who took over a scan tab and is still looking at it.
  if (tab.active) return 'foreign';
  const looksLikeScan = (u) =>
    typeof u === 'string' &&
    u.includes(SCAN_MARKER) &&
    (origin === '' || originOf(u) === origin);
  // A navigation in flight AWAY from the scan page vetoes the close — but
  // only for a tab the user may be driving. An untouched background tab
  // cannot be user-navigated (activating it is the only way, which marks it
  // touched), so a pending navigation there is the SITE's redirect in
  // flight; the origin already failed, so the tab is closed instead of
  // leaking. (A pending navigation TO a scan page still verifies as ours
  // below.) With no touch info (direct callers), stay conservative and veto.
  if (
    typeof tab.pendingUrl === 'string' &&
    tab.pendingUrl !== '' &&
    !looksLikeScan(tab.pendingUrl) &&
    (!userTouchedTabIds || userTouchedTabIds.has(tabId))
  ) {
    return 'foreign';
  }
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
  // The user activated this tab earlier in our ownership, then navigated away
  // and left: it may show anything now — never close it. (A tab that still
  // shows our scan page returned 'ours' above: peeking loses nothing.)
  if (userTouchedTabIds && userTouchedTabIds.has(tabId)) return 'foreign';
  // Failed load: Chrome shows an error page (chrome-error://). This is still
  // OUR tab — the site failed to load, not a user navigation. Mark as failed
  // so the caller closes it instead of leaving it piled up ungrouped.
  // 'failed' requires a KNOWN origin: with origin unknown (crash-recovery /
  // beforeunload — the tab ID may have been reused by a user tab in the new
  // session, since IDs reset per session), an error page proves nothing.
  // When in doubt, don't close.
  const url = tab.url || tab.pendingUrl || '';
  if (
    typeof url === 'string' &&
    (url.startsWith('chrome-error://') || url.startsWith('about:'))
  ) {
    return origin === '' ? 'foreign' : 'failed';
  }
  // Site redirect: the SITE navigated away from the marker URL (its own 404
  // page, SPA router, path normalization, or a cross-origin error page) —
  // not the user (an untouched background tab cannot be user-navigated, and
  // touched/active tabs returned 'foreign' above). This is still our scan
  // tab: close it like a failed load instead of misreading it as a user
  // takeover ('foreign'), which ungroups and abandons the tab — the leak.
  // Requires a KNOWN origin (crash-recovery safety: with origin unknown the
  // tab ID may have been reused, so never close). The pendingUrl veto above
  // already protects an in-flight user navigation.
  return origin !== '' ? 'failed' : 'foreign';
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
    if (!recorded || !Array.isArray(recorded.tabIds) || !recorded.tabIds.length)
      return { cleaned: 0 };
  } catch (e) {
    return { cleaned: 0 };
  }
  log(
    'INFO',
    'SYSTEM',
    `previous session left ${recorded.tabIds.length} owned tab(s) — cleaning by recorded ID only`,
    {
      tabIds: recorded.tabIds,
    }
  );
  const ownership = createTabOwnership(null, verifyScanTab, null);
  for (const tabId of recorded.tabIds) ownership.own(tabId);
  let cleaned = 0;
  for (const tabId of recorded.tabIds) {
    try {
      const st = await ownership.safeCloseTab(tabId, '');
      if (st === 'closed' || st === 'gone') {
        cleaned++;
        log(
          'INFO',
          'SYSTEM',
          `closed leftover scan tab ${tabId} from previous session (${st})`,
          { tabId }
        );
      } else {
        log(
          'INFO',
          'SYSTEM',
          `left tab ${tabId} untouched (safeCloseTab: ${st})`,
          { tabId }
        );
      }
    } catch (e) {
      log(
        'DEBUG',
        'SYSTEM',
        `leftover tab ${tabId}} cleanup threw: ${(e && e.message) || e}`,
        { tabId }
      );
    }
  }
  try {
    const s = (chrome.storage && chrome.storage.local) || null;
    if (s) await s.remove(SITE_DATA_CONFIG.stop.ownedTabsKey);
  } catch (e) {
    /* ignore */
  }
  ownership.dispose(); // drop the tab-event listeners for this one-off cleanup
  return { cleaned };
}
