// Test: verifyScanTab returns 'failed' for chrome-error pages (not 'foreign'),
// so failed tabs are CLOSED immediately instead of being ungrouped and left
// to pile up.
import assert from 'node:assert/strict';
import { verifyScanTab } from '../src/lib/sitedata.js';

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
assert.equal(v4, 'foreign', 'user-navigated page should be foreign');

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
