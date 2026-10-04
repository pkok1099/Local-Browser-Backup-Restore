// Granular backup categories: cookies_plain / cookies_partitioned and
// sessions_tabs / sessions_windows (Batch 1).
//
// Covers:
//   1. subCategorySelected() helper semantics;
//   2. equivalence: selecting all granular members == no selection (cookies);
//   3. equivalence: selecting all granular members == legacy id (sessions);
//   4. partial selection filters the output (cookies + sessions, incl. devices);
//   5. legacy ids keep backward compatibility;
//   6. non-matching selectedCategories skips the section entirely;
//   7. the site-data scan-noise filter still applies to sessions.
import assert from 'node:assert/strict';

let n = 0;
const check = (actual, expected, label) => {
  n++;
  assert.deepEqual(actual, expected, label);
};

const plainCookie = {
  name: 'plain',
  value: 'p1',
  domain: 'example.test',
  path: '/',
  secure: false,
  httpOnly: false,
  sameSite: 'lax',
  hostOnly: true,
  session: false,
  storeId: '0',
};
const partitionedCookie = {
  name: 'chips',
  value: 'c1',
  domain: 'example.test',
  path: '/',
  secure: true,
  httpOnly: false,
  sameSite: 'no_restriction',
  hostOnly: true,
  session: false,
  storeId: '0',
  partitionKey: { topLevelSite: 'https://example.test' },
};

const tabItem = {
  lastModified: 1000,
  tab: { url: 'https://example.test/a', title: 'A', index: 0 },
};
const windowItem = {
  lastModified: 1001,
  window: {
    left: 0,
    top: 0,
    width: 800,
    height: 600,
    state: 'normal',
    tabs: [{ url: 'https://example.test/b', title: 'B', index: 0 }],
  },
};
const scanNoiseItem = {
  lastModified: 1002,
  tab: { url: 'https://x.invalid/__bbr_site_scan__', title: 'scan', index: 0 },
};
// Defensive case: a session item with neither tab nor window must be kept.
const oddItem = { lastModified: 1003 };

globalThis.chrome = {
  runtime: {
    async getPlatformInfo() {
      return { os: 'android', arch: 'arm64' };
    },
    getManifest() {
      return { version: '1.4.8' };
    },
  },
  cookies: {
    getAllCookieStores: async () => [{ id: '0' }],
    getAll: async (q) =>
      q.partitionKey && Object.keys(q.partitionKey).length === 0
        ? [plainCookie, partitionedCookie]
        : [plainCookie],
  },
  sessions: {
    MAX_SESSION_RESULTS: 25,
    getRecentlyClosed: async () => [
      tabItem,
      windowItem,
      scanNoiseItem,
      oddItem,
    ],
    getDevices: async () => [
      { deviceName: 'Phone', sessions: [tabItem, windowItem] },
    ],
  },
  tabs: { query: async () => [] },
  history: { search: async () => [] },
};

const { collectAll, collectCookies, subCategorySelected } = await import(
  '../../src/lib/collect.js'
);

// 1. subCategorySelected() semantics.
check(subCategorySelected(undefined, 'cookies', 'cookies_plain'), true, 'no selection array means select everything');
check(subCategorySelected(['cookies'], 'cookies', 'cookies_plain'), true, 'legacy id selects the group');
check(subCategorySelected(['cookies_plain'], 'cookies', 'cookies_plain'), true, 'granular id selects itself');
check(subCategorySelected(['cookies_partitioned'], 'cookies', 'cookies_plain'), false, 'other granular id does not select');
check(subCategorySelected([], 'cookies', 'cookies_plain'), false, 'empty selection selects nothing');

// 2. Cookies equivalence: all granular members == no selection.
{
  const granular = await collectAll(null, {
    selectedCategories: ['cookies_plain', 'cookies_partitioned'],
  });
  const unfiltered = await collectAll(null);
  check(granular.data.cookies, unfiltered.data.cookies, 'all granular cookies == unfiltered cookies');
  check(granular.data.cookies, await collectCookies(), 'all granular cookies == direct collectCookies()');
  check(granular.categoryStatus.cookies.ok, true, 'cookies status ok');
}

// 3. Sessions equivalence: all granular members == legacy id.
{
  const granular = await collectAll(null, {
    selectedCategories: ['sessions_tabs', 'sessions_windows'],
  });
  const legacy = await collectAll(null, { selectedCategories: ['sessions'] });
  const unfiltered = await collectAll(null);
  check(granular.data.sessions, legacy.data.sessions, 'all granular sessions == legacy sessions id');
  check(granular.data.sessions, unfiltered.data.sessions, 'all granular sessions == unfiltered sessions');
  check(
    granular.data.sessions.recentlyClosed.every(
      (s) => !(s.tab && s.tab.url.includes('/__bbr_site_scan__'))
    ),
    true,
    'scan-noise filter still applies'
  );
}

// 4a. Partial cookies: plain only / partitioned only.
{
  const plainOnly = await collectAll(null, {
    selectedCategories: ['cookies_plain'],
  });
  check(
    plainOnly.data.cookies.cookies.map((c) => c.name),
    ['plain'],
    'cookies_plain keeps only plain cookies'
  );
  const partitionedOnly = await collectAll(null, {
    selectedCategories: ['cookies_partitioned'],
  });
  check(
    partitionedOnly.data.cookies.cookies.map((c) => c.name),
    ['chips'],
    'cookies_partitioned keeps only partitioned cookies'
  );
}

// 4b. Partial sessions: tabs only / windows only (recentlyClosed + devices).
{
  const tabsOnly = await collectAll(null, {
    selectedCategories: ['sessions_tabs'],
  });
  const rc = tabsOnly.data.sessions.recentlyClosed;
  check(rc.some((s) => s.tab), true, 'sessions_tabs keeps tab items');
  check(rc.some((s) => s.window), false, 'sessions_tabs drops window items');
  check(
    rc.some((s) => s.lastModified === 1003),
    true,
    'sessions_tabs keeps items with neither tab nor window'
  );
  check(
    tabsOnly.data.sessions.devices[0].sessions.some((s) => s.window),
    false,
    'sessions_tabs drops window items from devices'
  );
  check(
    tabsOnly.data.sessions.devices[0].sessions.some((s) => s.tab),
    true,
    'sessions_tabs keeps tab items in devices'
  );

  const windowsOnly = await collectAll(null, {
    selectedCategories: ['sessions_windows'],
  });
  const rcw = windowsOnly.data.sessions.recentlyClosed;
  check(rcw.some((s) => s.window), true, 'sessions_windows keeps window items');
  check(rcw.some((s) => s.tab), false, 'sessions_windows drops tab items');
  check(
    windowsOnly.data.sessions.devices[0].sessions.some((s) => s.tab),
    false,
    'sessions_windows drops tab items from devices'
  );
}

// 5. Legacy ids stay backward compatible.
{
  const legacy = await collectAll(null, { selectedCategories: ['cookies'] });
  check(
    legacy.data.cookies.cookies.map((c) => c.name).sort(),
    ['chips', 'plain'],
    "legacy 'cookies' id keeps every cookie"
  );
}

// 6. Non-matching selectedCategories skips the section entirely.
{
  const other = await collectAll(null, { selectedCategories: ['profile'] });
  check(other.data.cookies, undefined, 'cookies section absent when not selected');
  check(other.data.sessions, undefined, 'sessions section absent when not selected');
  check(other.categoryStatus.cookies.skipped, true, 'cookies marked skipped');
  check(other.categoryStatus.sessions.skipped, true, 'sessions marked skipped');
  check(other.categoryStatus.profile.ok, true, 'profile still collected');
}

console.log(`PASS collect-granular-cookies-sessions (${n} assertions)`);
