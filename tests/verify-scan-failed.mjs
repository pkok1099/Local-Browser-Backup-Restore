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
        3: { id: 3, url: 'https://example.com/__bbr_site_scan__', pendingUrl: '' },
        4: { id: 4, url: 'https://evil.com/', pendingUrl: '' },
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

console.log('PASS verifyScanTab failed verdict: chrome-error/about -> failed (closed), scan -> ours, foreign -> kept, gone -> gone');
