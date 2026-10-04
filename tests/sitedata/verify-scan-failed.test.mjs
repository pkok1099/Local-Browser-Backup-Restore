// Test: verifyScanTab returns 'failed' for chrome-error pages (not 'foreign'),
// so failed tabs are CLOSED immediately instead of being ungrouped and left
// to pile up.
import assert from 'node:assert/strict';
import { verifyScanTab } from '../../src/lib/sitedata.js';

// Fake chrome.tabs.get
globalThis.chrome = {
  tabs: {
    get: async (tabId) => {
      const tabs = {
        1: { id: 1, url: 'chrome-error://chromewebdata/', pendingUrl: '' },
        2: { id: 2, url: 'about:blank', pendingUrl: '' },
        3: {
          id: 3,
          url: 'https://example.com/__bbr_site_scan__',
          pendingUrl: '',
        },
        4: { id: 4, url: 'https://evil.com/', pendingUrl: '' },
        // Scan page committed, but the user is navigating away right now.
        5: {
          id: 5,
          url: 'https://example.com/__bbr_site_scan__',
          pendingUrl: 'https://google.com/',
        },
      };
      if (!tabs[tabId]) throw new Error('No tab');
      return tabs[tabId];
    },
  },
  history: {
    deleteUrl: async () => {},
  },
};

const v1 = await verifyScanTab(1, 'https://example.com');
assert.equal(v1, 'failed', 'chrome-error page should be failed, not foreign');

const v2 = await verifyScanTab(2, 'https://example.com');
assert.equal(v2, 'failed', 'about:blank should be failed, not foreign');

const v3 = await verifyScanTab(3, 'https://example.com');
assert.equal(v3, 'ours', 'scan page should be ours');

const v4 = await verifyScanTab(4, 'https://example.com');
assert.equal(
  v4,
  'failed',
  'cross-origin site redirect on an untouched tab is the SITE doing it, not the user — must be failed (closed), not foreign'
);

const v5 = await verifyScanTab(999, 'https://example.com');
assert.equal(v5, 'gone', 'missing tab should be gone');

// Unknown origin ('') — crash-recovery / beforeunload cleanup path: a tab
// clearly showing a scan page must verify as ours so leftovers can be
// closed, but a user-navigated tab must stay foreign (never closed).
const v6 = await verifyScanTab(3, '');
assert.equal(
  v6,
  'ours',
  'scan page with unknown origin should be ours (crash recovery)'
);

const v7 = await verifyScanTab(4, '');
assert.equal(
  v7,
  'foreign',
  'user page with unknown origin must stay foreign (never closed)'
);

// Crash-recovery safety (tahap-1 audit HIGH): with unknown origin, an error
// page proves NOTHING — the tab ID may have been reused by a user tab in the
// new session (IDs reset per session). 'failed' requires a known origin;
// otherwise the tab must stay foreign (never closed).
const v8 = await verifyScanTab(1, '');
assert.equal(
  v8,
  'foreign',
  'chrome-error page with unknown origin must stay foreign (never closed)'
);

const v9 = await verifyScanTab(2, '');
assert.equal(
  v9,
  'foreign',
  'about:blank with unknown origin must stay foreign (never closed)'
);

// A navigation in flight AWAY from the scan page vetoes the close: the user
// is taking the tab somewhere else right now (tahap-1 audit T1-M1).
const v10 = await verifyScanTab(5, 'https://example.com');
assert.equal(
  v10,
  'foreign',
  'scan tab with non-scan pendingUrl must stay foreign (user navigating away)'
);

console.log(
  'PASS verifyScanTab failed verdict: chrome-error/about -> failed (closed), scan -> ours, foreign -> kept, gone -> gone'
);

// --- same-origin redirect cases (bug: tabs left the group on site error) ---
// A site redirect away from the marker URL (same origin, known origin) is
// still OUR tab — the site did it, not the user. It must verify as 'failed'
// (closed) instead of 'foreign' (ungrouped and abandoned).
globalThis.chrome.tabs.get = async (tabId) => {
  const tabs = {
    // Site redirected the marker URL to its own 404 page (same origin).
    11: { id: 11, url: 'https://example.com/404.html', pendingUrl: '' },
    // Site normalized the path to its homepage (same origin).
    12: { id: 12, url: 'https://example.com/', pendingUrl: '' },
    // Same-origin URL, but the user is navigating away right now.
    13: {
      id: 13,
      url: 'https://example.com/404.html',
      pendingUrl: 'https://google.com/',
    },
    // Same-origin redirect, but the user is currently viewing the tab.
    14: {
      id: 14,
      url: 'https://example.com/404.html',
      pendingUrl: '',
      active: true,
    },
  };
  if (!tabs[tabId]) throw new Error('No tab');
  return tabs[tabId];
};

const v11 = await verifyScanTab(11, 'https://example.com');
assert.equal(
  v11,
  'failed',
  'same-origin site redirect should be failed (closed), not foreign'
);

const v12 = await verifyScanTab(12, 'https://example.com');
assert.equal(
  v12,
  'failed',
  'same-origin path normalization should be failed (closed), not foreign'
);

// Crash-recovery safety preserved: unknown origin never closes.
const v13 = await verifyScanTab(11, '');
assert.equal(
  v13,
  'foreign',
  'same-origin redirect with unknown origin must stay foreign (never closed)'
);

// The pendingUrl veto (T1-M1) still wins: active user navigation is kept.
const v14 = await verifyScanTab(13, 'https://example.com');
assert.equal(
  v14,
  'foreign',
  'same-origin URL with non-scan pendingUrl must stay foreign (user navigating)'
);

// A tab the user is currently viewing is never closed, whatever it shows.
const v15 = await verifyScanTab(14, 'https://example.com');
assert.equal(
  v15,
  'foreign',
  'active tab must stay foreign (user is viewing it)'
);

console.log(
  'PASS same-origin redirect: failed (closed), unknown origin stays foreign'
);

// --- cross-origin redirect + user-takeover tracking ---
// A background tab the user never activated cannot have been user-navigated
// (no UI gesture navigates a background tab without activating it), so a
// markerless page there is the SITE's redirect — close it. But a tab the
// user DID activate during our ownership may have been taken over: whatever
// it shows now, never close it. The touched set is tracked by
// createTabOwnership via chrome.tabs.onActivated and passed as the 3rd arg.
globalThis.chrome.tabs.get = async (tabId) => {
  const tabs = {
    // Site redirected the marker URL to an error page on another origin.
    21: { id: 21, url: 'https://cdn-errors.net/404.html', pendingUrl: '' },
    // chrome-error page on a tab the user activated earlier.
    22: { id: 22, url: 'chrome-error://chromewebdata/', pendingUrl: '' },
    // Same-origin redirect, but the user activated the tab earlier
    // (took it over, navigated, switched away).
    23: { id: 23, url: 'https://example.com/404.html', pendingUrl: '' },
    // Cross-origin page, user activated the tab earlier.
    24: { id: 24, url: 'https://evil.com/', pendingUrl: '' },
    // User peeked at the scan tab but it still shows our page.
    25: {
      id: 25,
      url: 'https://example.com/__bbr_site_scan__',
      pendingUrl: '',
    },
    // Unknown origin path is unchanged: never close markerless tabs.
    26: { id: 26, url: 'https://evil.com/', pendingUrl: '' },
    // Site mid-redirect: navigation in flight AWAY from the scan page.
    27: {
      id: 27,
      url: 'https://cdn-errors.net/404.html',
      pendingUrl: 'https://cdn-errors.net/spinner.html',
    },
    // Same, but the user activated the tab earlier (may be user-navigating).
    28: {
      id: 28,
      url: 'https://cdn-errors.net/404.html',
      pendingUrl: 'https://cdn-errors.net/spinner.html',
    },
  };
  if (!tabs[tabId]) throw new Error('No tab');
  return tabs[tabId];
};

const v16 = await verifyScanTab(21, 'https://example.com', new Set());
assert.equal(
  v16,
  'failed',
  'cross-origin redirect on untouched tab must be failed (closed) — this was the leak'
);

const v17 = await verifyScanTab(22, 'https://example.com', new Set([22]));
assert.equal(
  v17,
  'foreign',
  'touched tab showing an error page must stay foreign (user may have taken it over)'
);

const v18 = await verifyScanTab(23, 'https://example.com', new Set([23]));
assert.equal(
  v18,
  'foreign',
  'touched tab with same-origin redirect must stay foreign (takeover now protected)'
);

const v19 = await verifyScanTab(24, 'https://example.com', new Set([24]));
assert.equal(
  v19,
  'foreign',
  'touched tab with cross-origin page must stay foreign (user navigation)'
);

const v20 = await verifyScanTab(25, 'https://example.com', new Set([25]));
assert.equal(
  v20,
  'ours',
  'touched tab still showing the scan page is ours (peeked, nothing to lose)'
);

const v21 = await verifyScanTab(26, '', new Set());
assert.equal(
  v21,
  'foreign',
  'unknown origin never closes markerless tabs, touched or not'
);

// The pendingUrl veto only protects tabs the user may be driving. An
// untouched background tab cannot be user-navigated, so an in-flight
// navigation there is the SITE's redirect — close it instead of leaking.
const v22 = await verifyScanTab(27, 'https://example.com', new Set());
assert.equal(
  v22,
  'failed',
  'in-flight site redirect on untouched tab must be failed (closed), not foreign'
);

const v23 = await verifyScanTab(28, 'https://example.com', new Set([28]));
assert.equal(
  v23,
  'foreign',
  'in-flight navigation on a touched tab stays foreign (may be the user)'
);

// No touch info (direct callers): stay conservative, keep the veto.
const v24 = await verifyScanTab(27, 'https://example.com');
assert.equal(
  v24,
  'foreign',
  'in-flight navigation with unknown touch state stays foreign (conservative)'
);

console.log(
  'PASS cross-origin redirect: untouched -> failed (closed), touched -> foreign (kept)'
);
