// Test: waitTabReady bails out early when the tab committed to a page that
// can never satisfy the origin (site redirected the marker URL cross-origin),
// instead of burning the full 20s load timeout per attempt.
import assert from 'node:assert/strict';
import { waitTabReady } from '../../src/lib/sitedata.js';
import { SITE_DATA_CONFIG } from '../../src/lib/scan-config.js';

const originalDateNow = Object.getOwnPropertyDescriptor(Date, 'now');
const originalSetTimeout = Object.getOwnPropertyDescriptor(
  globalThis,
  'setTimeout'
);
const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
const realDateNow = Date.now.bind(Date);
let fakeNow = realDateNow();

function restoreProperty(target, name, descriptor) {
  if (descriptor) Object.defineProperty(target, name, descriptor);
  else Reflect.deleteProperty(target, name);
}

try {
  // Advance virtual time by the requested delay, but resolve immediately so
  // the helper's 150ms polling interval never causes real waiting.
  Date.now = () => fakeNow;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const elapsed = Number(delay);
    if (Number.isFinite(elapsed) && elapsed > 0) fakeNow += elapsed;
    callback(...args);
    return 0;
  };

  let current = {
    status: 'complete',
    url: 'https://cdn-errors.net/404.html',
  };
  globalThis.chrome = {
    tabs: {
      get: async () => ({ ...current }),
    },
  };

  const t0 = fakeNow;
  const wallT0 = realDateNow();
  const r = await waitTabReady(1, 'https://example.com', () => false);
  const wallMs = realDateNow() - wallT0;
  const redirectElapsedMs = fakeNow - t0;
  assert.equal(
    r,
    false,
    'a completed cross-origin page can never become the origin -> false'
  );
  assert.ok(
    redirectElapsedMs > SITE_DATA_CONFIG.redirectGraceMs,
    `stable cross-origin page must outlast the redirect grace (took ${redirectElapsedMs}ms)`
  );
  assert.ok(
    redirectElapsedMs < SITE_DATA_CONFIG.tabLoadTimeoutMs,
    `stable cross-origin page must bail before the full load timeout (took ${redirectElapsedMs}ms)`
  );
  assert.ok(
    wallMs < 5000,
    `must bail out early instead of waiting in real time (took ${wallMs}ms)`
  );

  // Control: a normal marker load still resolves true...
  let calls = 0;
  globalThis.chrome.tabs.get = async () => {
    calls++;
    if (calls < 3) return { status: 'loading', url: '' };
    return {
      status: 'complete',
      url: 'https://example.com/__bbr_site_scan__',
    };
  };
  const ok = await waitTabReady(2, 'https://example.com', () => false);
  assert.equal(ok, true, 'normal marker load must still resolve true');

  // ...and the transient about:blank-before-navigation state must not bail out.
  calls = 0;
  globalThis.chrome.tabs.get = async () => {
    calls++;
    if (calls === 1) return { status: 'complete', url: 'about:blank' };
    return {
      status: 'complete',
      url: 'https://example.com/__bbr_site_scan__',
    };
  };
  const ok2 = await waitTabReady(3, 'https://example.com', () => false);
  assert.equal(
    ok2,
    true,
    'about:blank transient state must not bail out early'
  );

  // A redirect that bounces BACK to the origin quickly (SSO / challenge flow)
  // must still resolve true — only a stable foreign page bails out.
  let n = 0;
  globalThis.chrome.tabs.get = async () => {
    n++;
    if (n <= 6) return { status: 'complete', url: 'https://cdn-errors.net/x' };
    return {
      status: 'complete',
      url: 'https://example.com/__bbr_site_scan__',
    };
  };
  const bounceStart = fakeNow;
  const ok3 = await waitTabReady(4, 'https://example.com', () => false);
  assert.equal(
    ok3,
    true,
    'foreign page that returns to the origin within the grace period must resolve true'
  );
  assert.ok(
    fakeNow - bounceStart < SITE_DATA_CONFIG.redirectGraceMs,
    'bounce-back scenario must return before the redirect grace expires'
  );

  console.log(
    'PASS waitTabReady: early bail on definitive redirect, normal loads unaffected'
  );
} finally {
  restoreProperty(Date, 'now', originalDateNow);
  restoreProperty(globalThis, 'setTimeout', originalSetTimeout);
  restoreProperty(globalThis, 'chrome', originalChrome);
}
