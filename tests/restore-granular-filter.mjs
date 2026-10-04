// Granular restore pre-filter: filterSectionDataForRestore + restoreAll wiring.
//
// Covers:
//   1. no-op identity: granular null/undefined, all members on, or an unknown
//      category -> the SAME object reference is returned (not a clone);
//   2. tabsWindows: tabs off -> windows[].tabs emptied, flat tabs dropped;
//      windows off -> windows emptied, nested tabs converted to flat tabs
//      carrying windowId; tabGroups off -> [] + a "deselected" note;
//   3. cookies: cookies_plain / cookies_partitioned off filters cookies[];
//   4. sessions: sessions_tabs / sessions_windows off filters recentlyClosed
//      AND devices[].sessions[];
//   5. siteData: localStorage / indexedDB / otherStorage off deletes the
//      matching per-origin keys; sessionStorage/serviceWorkers untouched;
//   6. the input object is never mutated;
//   7. restoreAll applies the filter before the restore function runs.
import assert from 'node:assert/strict';
import { filterSectionDataForRestore, restoreAll } from '../src/lib/restore.js';

let n = 0;
const check = (actual, expected, label) => {
  n++;
  assert.deepEqual(actual, expected, label);
};
const checkSame = (actual, expected, label) => {
  n++;
  assert.strictEqual(actual, expected, label);
};

// ---------- fixtures ----------

const tabsWindowsSample = () => ({
  windows: [
    {
      type: 'normal',
      state: 'normal',
      tabs: [
        { url: 'https://a.example/', title: 'a', index: 0, groupId: 11 },
        { url: 'https://b.example/', title: 'b', index: 1 },
      ],
    },
    {
      type: 'normal',
      state: 'normal',
      tabs: [{ url: 'https://c.example/', title: 'c', index: 0 }],
    },
  ],
  tabGroups: [
    { groupId: 11, title: 'g', color: 'blue', collapsed: false, windowId: 1 },
  ],
});

const cookiesSample = () => ({
  cookies: [
    { name: 'plain1', domain: 'a.example', path: '/' },
    {
      name: 'part1',
      domain: 'b.example',
      path: '/',
      partitionKey: { topLevelSite: 'https://x.example' },
    },
    { name: 'plain2', domain: 'c.example', path: '/' },
  ],
});

const sessionsSample = () => ({
  recentlyClosed: [
    { tab: { url: 'https://a.example/', title: 'a' }, lastModified: 1 },
    { window: { tabs: [{ url: 'https://b.example/', title: 'b' }] } },
  ],
  devices: [
    {
      deviceName: 'phone',
      sessions: [
        { tab: { url: 'https://c.example/', title: 'c' } },
        { window: { tabs: [{ url: 'https://d.example/' }] } },
      ],
    },
  ],
});

const siteDataSample = () => ({
  origins: {
    'https://a.example': {
      localStorage: { k: 'v' },
      sessionStorage: { s: 'v' },
      indexedDB: [{ name: 'db' }],
      cacheStorage: [{ cacheName: 'c' }],
      opfs: { files: [] },
      buckets: [{ name: 'b' }],
      serviceWorkers: [{ scriptURL: 'https://a.example/sw.js' }],
    },
  },
});

const ALL_TW = { tabs: true, windows: true, tabGroups: true };
const ALL_COOKIES = { cookies_plain: true, cookies_partitioned: true };
const ALL_SESSIONS = { sessions_tabs: true, sessions_windows: true };
const ALL_SITEDATA = {
  siteData_localStorage: true,
  siteData_indexedDB: true,
  siteData_otherStorage: true,
};

// ---------- 1. no-op identity (=== input, not just deep-equal) ----------

{
  const d = tabsWindowsSample();
  checkSame(
    filterSectionDataForRestore('tabsWindows', d, null),
    d,
    'granular null -> identical'
  );
  checkSame(
    filterSectionDataForRestore('tabsWindows', d, undefined),
    d,
    'granular undefined -> identical'
  );
  checkSame(
    filterSectionDataForRestore('tabsWindows', d, ALL_TW),
    d,
    'all members on -> identical'
  );
}
{
  const d = cookiesSample();
  checkSame(
    filterSectionDataForRestore('cookies', d, ALL_COOKIES),
    d,
    'cookies all on -> identical'
  );
  const s = sessionsSample();
  checkSame(
    filterSectionDataForRestore('sessions', s, ALL_SESSIONS),
    s,
    'sessions all on -> identical'
  );
  const sd = siteDataSample();
  checkSame(
    filterSectionDataForRestore('siteData', sd, ALL_SITEDATA),
    sd,
    'siteData all on -> identical'
  );
}
{
  const d = { items: [1, 2] };
  checkSame(
    filterSectionDataForRestore('bookmarks', d, { whatever: false }),
    d,
    'non-split category -> identical'
  );
}

// ---------- 2. tabsWindows ----------

{
  // tabs off: window layout kept, every window emptied of tabs
  const d = tabsWindowsSample();
  const r = filterSectionDataForRestore('tabsWindows', d, {
    ...ALL_TW,
    tabs: false,
  });
  check(r.windows.length, 2, 'tabs off: window count kept');
  check(
    r.windows.every((w) => Array.isArray(w.tabs) && w.tabs.length === 0),
    true,
    'tabs off: windows[].tabs emptied'
  );
  check('tabs' in r, false, 'tabs off: no flat tabs key');
  checkSame(r.tabGroups, d.tabGroups, 'tabs off: tabGroups reference kept');
}

{
  // windows off: flat tabs carrying windowId, no window layout
  const d = tabsWindowsSample();
  const r = filterSectionDataForRestore('tabsWindows', d, {
    ...ALL_TW,
    windows: false,
  });
  check(r.windows, [], 'windows off: windows emptied');
  check(r.tabs.length, 3, 'windows off: 3 flat tabs');
  check(
    r.tabs.every((t) => t.windowId !== undefined && t.windowId !== null),
    true,
    'windows off: every flat tab carries windowId'
  );
  check(
    r.tabs.map((t) => t.url),
    ['https://a.example/', 'https://b.example/', 'https://c.example/'],
    'windows off: tab order preserved'
  );
  checkSame(r.tabGroups, d.tabGroups, 'windows off: tabGroups kept');
}

{
  // tabGroups off: [] + deselected note
  const d = tabsWindowsSample();
  const r = filterSectionDataForRestore('tabsWindows', d, {
    ...ALL_TW,
    tabGroups: false,
  });
  check(r.tabGroups, [], 'tabGroups off: []');
  check(
    Array.isArray(r.notes) && r.notes.some((x) => /deselected/i.test(x)),
    true,
    'tabGroups off: deselected note present'
  );
  check(r.windows.length, 2, 'tabGroups off: windows untouched');
}

{
  // tabGroups off but backup had none: no noise note added
  const d = { windows: [], tabGroups: [] };
  const r = filterSectionDataForRestore('tabsWindows', d, {
    ...ALL_TW,
    tabGroups: false,
  });
  check(r.tabGroups, [], 'empty tabGroups -> []');
  check('notes' in r, false, 'no note when there were no groups');
}

{
  // tabs off + windows off: nothing to restore
  const d = tabsWindowsSample();
  const r = filterSectionDataForRestore('tabsWindows', d, {
    tabs: false,
    windows: false,
    tabGroups: true,
  });
  check(r.windows, [], 'tabs+windows off: windows []');
  check(r.tabs, [], 'tabs+windows off: tabs []');
}

// ---------- 3. cookies ----------

{
  const d = cookiesSample();
  const r = filterSectionDataForRestore('cookies', d, {
    ...ALL_COOKIES,
    cookies_plain: false,
  });
  check(
    r.cookies.map((c) => c.name),
    ['part1'],
    'plain off: only partitioned remain'
  );
}
{
  const d = cookiesSample();
  const r = filterSectionDataForRestore('cookies', d, {
    ...ALL_COOKIES,
    cookies_partitioned: false,
  });
  check(
    r.cookies.map((c) => c.name),
    ['plain1', 'plain2'],
    'partitioned off: only plain remain'
  );
}
{
  const d = cookiesSample();
  const r = filterSectionDataForRestore('cookies', d, {
    cookies_plain: false,
    cookies_partitioned: false,
  });
  check(r.cookies, [], 'both off: no cookies');
}

// ---------- 4. sessions ----------

{
  const d = sessionsSample();
  const r = filterSectionDataForRestore('sessions', d, {
    ...ALL_SESSIONS,
    sessions_tabs: false,
  });
  check(
    r.recentlyClosed.every((it) => !it.tab),
    true,
    'sessions_tabs off: no tab items in recentlyClosed'
  );
  check(
    r.devices[0].sessions.every((it) => !it.tab),
    true,
    'sessions_tabs off: no tab items in devices'
  );
  check(r.recentlyClosed.length, 1, 'sessions_tabs off: window item kept');
  check(r.devices[0].deviceName, 'phone', 'device entry preserved');
}
{
  const d = sessionsSample();
  const r = filterSectionDataForRestore('sessions', d, {
    ...ALL_SESSIONS,
    sessions_windows: false,
  });
  check(
    r.recentlyClosed.every((it) => !it.window),
    true,
    'sessions_windows off: no window items in recentlyClosed'
  );
  check(
    r.devices[0].sessions.every((it) => !it.window),
    true,
    'sessions_windows off: no window items in devices'
  );
}

// ---------- 5. siteData ----------

{
  const d = siteDataSample();
  const r = filterSectionDataForRestore('siteData', d, {
    ...ALL_SITEDATA,
    siteData_localStorage: false,
  });
  const snap = r.origins['https://a.example'];
  check('localStorage' in snap, false, 'localStorage off: key removed');
  check(snap.indexedDB, [{ name: 'db' }], 'localStorage off: indexedDB kept');
  check(
    snap.sessionStorage,
    { s: 'v' },
    'localStorage off: sessionStorage kept'
  );
  check(
    snap.serviceWorkers,
    [{ scriptURL: 'https://a.example/sw.js' }],
    'localStorage off: serviceWorkers kept'
  );
}
{
  const d = siteDataSample();
  const r = filterSectionDataForRestore('siteData', d, {
    ...ALL_SITEDATA,
    siteData_indexedDB: false,
  });
  check(
    'indexedDB' in r.origins['https://a.example'],
    false,
    'indexedDB off: key removed'
  );
  check(
    r.origins['https://a.example'].localStorage,
    { k: 'v' },
    'indexedDB off: localStorage kept'
  );
}
{
  const d = siteDataSample();
  const r = filterSectionDataForRestore('siteData', d, {
    ...ALL_SITEDATA,
    siteData_otherStorage: false,
  });
  const snap = r.origins['https://a.example'];
  for (const k of ['cacheStorage', 'opfs', 'buckets'])
    check(k in snap, false, `otherStorage off: ${k} removed`);
  check(snap.localStorage, { k: 'v' }, 'otherStorage off: localStorage kept');
  check(
    snap.sessionStorage,
    { s: 'v' },
    'otherStorage off: sessionStorage kept'
  );
  check(
    snap.serviceWorkers,
    [{ scriptURL: 'https://a.example/sw.js' }],
    'otherStorage off: serviceWorkers kept'
  );
}

// ---------- 6. input never mutated ----------

{
  const inputs = {
    tabsWindows: [
      tabsWindowsSample(),
      { tabs: false, windows: true, tabGroups: false },
    ],
    cookies: [cookiesSample(), { ...ALL_COOKIES, cookies_plain: false }],
    sessions: [sessionsSample(), { ...ALL_SESSIONS, sessions_windows: false }],
    siteData: [
      siteDataSample(),
      { ...ALL_SITEDATA, siteData_otherStorage: false },
    ],
  };
  for (const [cat, [data, granular]] of Object.entries(inputs)) {
    const before = JSON.stringify(data);
    filterSectionDataForRestore(cat, data, granular);
    check(JSON.stringify(data), before, `${cat}: input not mutated`);
  }
}

// ---------- 7. restoreAll applies the filter ----------

let nextTabId;
let groupCalls;
let removedTabs;
function resetChromeMocks() {
  nextTabId = 1000;
  groupCalls = [];
  removedTabs = [];
}
resetChromeMocks();

globalThis.chrome = {
  runtime: {
    async getPlatformInfo() {
      return { os: 'linux' };
    },
  },
  windows: {
    async create() {
      return { id: 7, tabs: [{ id: 99 }] };
    },
  },
  tabs: {
    async create() {
      return { id: nextTabId++, windowId: 7 };
    },
    async update() {},
    async move() {},
    async get(id) {
      return { id, windowId: 7 };
    },
    async group({ tabIds }) {
      groupCalls.push(tabIds);
      return 55;
    },
    async remove(id) {
      removedTabs.push(id);
    },
  },
  tabGroups: {
    async update() {},
  },
};

{
  // tabs off + tabGroups off: windows created empty, no grouping, note visible
  resetChromeMocks();
  const backup = { data: { tabsWindows: tabsWindowsSample() } };
  const before = JSON.stringify(backup);
  const res = await restoreAll(
    backup,
    {
      tabsWindows: {
        enabled: true,
        granular: { tabs: false, windows: true, tabGroups: false },
      },
    },
    null
  );
  const tw = res.tabsWindows;
  check(tw.status, 'ok', 'restoreAll granular: ok');
  check(tw.stats.windowsCreated, 2, 'restoreAll granular: 2 windows created');
  check(tw.stats.tabsCreated, 0, 'restoreAll granular: 0 tabs created');
  check(tw.stats.grouped, 0, 'restoreAll granular: 0 grouped');
  check(
    tw.stats.notes.some((x) => /deselected/i.test(x)),
    true,
    'restoreAll granular: deselected note in stats'
  );
  check(
    JSON.stringify(backup),
    before,
    'restoreAll granular: backup not mutated'
  );
}

{
  // all-on granular behaves exactly like no granular option
  resetChromeMocks();
  const mk = () => ({ data: { tabsWindows: tabsWindowsSample() } });
  const plain = await restoreAll(
    mk(),
    { tabsWindows: { enabled: true } },
    null
  );
  resetChromeMocks();
  const gran = await restoreAll(
    mk(),
    { tabsWindows: { enabled: true, granular: ALL_TW } },
    null
  );
  check(
    [
      gran.tabsWindows.stats.windowsCreated,
      gran.tabsWindows.stats.tabsCreated,
      gran.tabsWindows.stats.grouped,
    ],
    [
      plain.tabsWindows.stats.windowsCreated,
      plain.tabsWindows.stats.tabsCreated,
      plain.tabsWindows.stats.grouped,
    ],
    'all-on granular: same counts as no granular'
  );
  check(groupCalls.length > 0, true, 'all-on granular: grouping ran');
}

console.log(`PASS restore-granular-filter (${n} assertions)`);
