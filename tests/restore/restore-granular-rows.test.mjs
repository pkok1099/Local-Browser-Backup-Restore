// Granular restore rows (Batch 2, UI side): content-driven row detection for
// the restore summary, per-sub-row counts, counts fallback, and the
// section-level options synthesis consumed by restoreAll.
//
// Covers:
//   1. full backup -> all granular rows in section order;
//   2. partial backup (cookies plain-only; siteData localStorage-only;
//      tabsWindows without tabGroups) -> only matching rows;
//   3. empty sections -> no rows (tabGroups keeps existing "array exists"
//      behavior);
//   4. countFromData per granular row id;
//   5. countFor fallback to section counts (never invents numbers);
//   6. synthesizeSectionOptions: all on / partial / all off ->
//      enabled/unavailable/granular correct;
//   7. sectionForRow / capabilityKeyForRow mappings.
import assert from 'node:assert/strict';

const {
  CATEGORY_GROUP_MEMBERS,
  sectionForRow,
  capabilityKeyForRow,
  granularRowIds,
  presentRestoreRows,
  countFromData,
  countFor,
  synthesizeSectionOptions,
} = await import('../../src/lib/restore-rows.js');

let n = 0;
const check = (actual, expected, label) => {
  n++;
  assert.deepEqual(actual, expected, label);
};

// Minimal CATEGORY_LABELS mirror (order = section order, granular ids
// expand at their section's position).
const LABELS = {
  bookmarks: 'Bookmarks',
  history: 'History',
  tabsWindows: 'Tabs & windows',
  tabGroups: 'Tab groups',
  tabs: 'Tabs',
  windows: 'Windows (layout & position)',
  sessions: 'Sessions (recently closed)',
  sessions_tabs: 'Recently closed tabs',
  sessions_windows: 'Recently closed windows',
  cookies: 'Cookies',
  cookies_plain: 'Cookies (plain)',
  cookies_partitioned: 'Cookies (partitioned)',
  siteData: 'Website data (storage per origin)',
  siteData_localStorage: 'Website data: Local Storage',
  siteData_indexedDB: 'Website data: IndexedDB',
  siteData_otherStorage: 'Website data: Cache, OPFS, Buckets',
};

const tabA = { url: 'https://a.example/', title: 'A' };
const tabB = { url: 'https://b.example/', title: 'B' };
const tabC = { url: 'https://c.example/', title: 'C' };
const plainCookie = { name: 'p', value: '1', domain: 'a.example' };
const partitionedCookie = {
  name: 'x',
  value: '2',
  domain: 'b.example',
  partitionKey: { topLevelSite: 'https://b.example' },
};

const fullBackup = {
  data: {
    history: { items: [{ url: 'https://h.example/' }] },
    tabsWindows: {
      windows: [
        { id: 1, tabs: [tabA, tabB] },
        { id: 2, tabs: [] },
      ],
      tabs: [tabC],
      tabGroups: [{ id: 5, title: 'g' }],
    },
    sessions: {
      recentlyClosed: [{ tab: tabA }, { window: { tabs: [tabB] } }],
      devices: [{ deviceName: 'phone', sessions: [{ tab: tabC }] }],
    },
    cookies: { cookies: [plainCookie, partitionedCookie] },
    siteData: {
      origins: {
        'https://a.example/': {
          localStorage: { k: 'v' },
          indexedDB: [],
          cacheStorage: [],
          opfs: { files: [], dirs: [] },
          buckets: { buckets: [] },
        },
        'https://b.example/': {
          localStorage: {},
          indexedDB: [{ name: 'db' }],
          cacheStorage: [],
          opfs: { files: [], dirs: [] },
          buckets: { buckets: [] },
        },
        'https://c.example/': {
          localStorage: {},
          indexedDB: [],
          cacheStorage: [{ name: 'c1' }],
          opfs: { files: ['/a.txt'], dirs: [] },
          buckets: { buckets: [] },
        },
      },
    },
  },
  counts: {
    tabs: 3,
    windows: 2,
    tabGroups: 1,
    cookies: 2,
    recentlyClosedSessions: 2,
    siteDataOrigins: 3,
    history: 1,
  },
};

// 1. Full backup: every granular row, grouped per section in label order.
{
  const rows = presentRestoreRows(fullBackup.data, LABELS).map(([id]) => id);
  check(
    rows,
    [
      'history',
      'tabs',
      'windows',
      'tabGroups',
      'sessions_tabs',
      'sessions_windows',
      'cookies_plain',
      'cookies_partitioned',
      'siteData_localStorage',
      'siteData_indexedDB',
      'siteData_otherStorage',
    ],
    'full backup emits all granular rows in section order'
  );
  const labels = Object.fromEntries(presentRestoreRows(fullBackup.data, LABELS));
  check(labels.tabs, 'Tabs', 'granular label: tabs');
  check(labels.windows, 'Windows (layout & position)', 'granular label: windows');
  check(labels.cookies_partitioned, 'Cookies (partitioned)', 'granular label');
  check(labels.sessions_tabs, 'Recently closed tabs', 'granular label');
  check(
    labels.siteData_otherStorage,
    'Website data: Cache, OPFS, Buckets',
    'granular label'
  );
}

// 2. Partial backup.
{
  const data = {
    cookies: { cookies: [plainCookie] }, // plain only
    siteData: {
      origins: {
        'https://a.example/': {
          localStorage: { k: 'v' },
          indexedDB: [],
          cacheStorage: [],
          opfs: { files: [], dirs: [] },
          buckets: { buckets: [] },
        },
      },
    },
    tabsWindows: {
      // no tabGroups key at all
      windows: [{ id: 1, tabs: [tabA] }],
    },
  };
  const rows = presentRestoreRows(data, LABELS).map(([id]) => id);
  check(
    rows,
    ['tabs', 'windows', 'cookies_plain', 'siteData_localStorage'],
    'partial backup emits only matching rows'
  );
  check(rows.includes('cookies_partitioned'), false, 'no partitioned row');
  check(rows.includes('siteData_indexedDB'), false, 'no indexedDB row');
  check(rows.includes('siteData_otherStorage'), false, 'no otherStorage row');
  check(rows.includes('tabGroups'), false, 'no tabGroups row without array');
}

// 3. Empty sections emit no rows; tabGroups keeps the existing array-exists
// behavior.
{
  const data = {
    cookies: { cookies: [] },
    sessions: { recentlyClosed: [], devices: [] },
    siteData: { origins: {} },
    tabsWindows: { windows: [], tabGroups: [] },
  };
  const rows = presentRestoreRows(data, LABELS).map(([id]) => id);
  check(
    rows,
    ['tabGroups'],
    'empty sections emit no rows; empty tabGroups array still shows (existing behavior)'
  );
}

// 3b. granularRowIds directly on section data.
{
  check(
    granularRowIds('tabsWindows', fullBackup.data),
    ['tabs', 'windows', 'tabGroups'],
    'granularRowIds tabsWindows'
  );
  check(
    granularRowIds('cookies', { cookies: { cookies: [plainCookie] } }),
    ['cookies_plain'],
    'granularRowIds cookies plain-only'
  );
  check(
    granularRowIds('sessions', {
      sessions: { recentlyClosed: [{ window: {} }], devices: [] },
    }),
    ['sessions_windows'],
    'granularRowIds sessions windows-only'
  );
  check(granularRowIds('bookmarks', {}), [], 'non-split section -> []');
}

// 4. countFromData per granular row.
{
  check(countFromData(fullBackup, 'tabs'), '3', 'tabs: nested + flat');
  check(countFromData(fullBackup, 'windows'), '2', 'windows count');
  check(countFromData(fullBackup, 'tabGroups'), '1', 'tabGroups count');
  check(countFromData(fullBackup, 'cookies_plain'), '1', 'plain cookies');
  check(
    countFromData(fullBackup, 'cookies_partitioned'),
    '1',
    'partitioned cookies'
  );
  check(countFromData(fullBackup, 'sessions_tabs'), '2', 'session tabs');
  check(countFromData(fullBackup, 'sessions_windows'), '1', 'session windows');
  check(
    countFromData(fullBackup, 'siteData_localStorage'),
    '1 origins',
    'localStorage origins'
  );
  check(
    countFromData(fullBackup, 'siteData_indexedDB'),
    '1 origins',
    'indexedDB origins'
  );
  check(
    countFromData(fullBackup, 'siteData_otherStorage'),
    '1 origins',
    'otherStorage origins'
  );
  // Legacy section counts still work.
  check(countFromData(fullBackup, 'tabsWindows'), '3', 'legacy tabsWindows');
  check(countFromData(fullBackup, 'cookies'), '2', 'legacy cookies');
}

// 5. countFor: granular ids fall back to their section counts; no invented
// numbers.
{
  check(countFor(fullBackup, 'tabs'), '3', 'tabs -> c.tabs');
  check(countFor(fullBackup, 'windows'), '2', 'windows -> c.windows');
  check(countFor(fullBackup, 'tabGroups'), '1', 'tabGroups -> c.tabGroups');
  check(countFor(fullBackup, 'cookies_plain'), '2', 'plain -> c.cookies');
  check(
    countFor(fullBackup, 'cookies_partitioned'),
    '2',
    'partitioned -> c.cookies'
  );
  check(
    countFor(fullBackup, 'sessions_tabs'),
    '2',
    'sessions_tabs -> c.recentlyClosedSessions'
  );
  check(
    countFor(fullBackup, 'sessions_windows'),
    '2',
    'sessions_windows -> c.recentlyClosedSessions'
  );
  check(
    countFor(fullBackup, 'siteData_localStorage'),
    '3 origins',
    'siteData_* -> c.siteDataOrigins'
  );
  check(
    countFor({ counts: {} }, 'tabs'),
    undefined,
    'missing section count -> undefined (no invented numbers)'
  );
  check(
    countFor({ counts: {} }, 'siteData_localStorage'),
    undefined,
    'missing siteDataOrigins -> undefined'
  );
}

// 6. synthesizeSectionOptions.
{
  // all on
  const options = {
    tabs: { enabled: true, unavailable: false },
    windows: { enabled: true, unavailable: false },
    tabGroups: { enabled: true, unavailable: false },
  };
  synthesizeSectionOptions(options);
  check(
    options.tabsWindows,
    {
      enabled: true,
      unavailable: false,
      granular: { tabs: true, windows: true, tabGroups: true },
    },
    'all on -> section enabled'
  );
}
{
  // partial: only partitioned cookies on
  const options = {
    cookies_plain: { enabled: false, unavailable: false },
    cookies_partitioned: { enabled: true, unavailable: false },
  };
  synthesizeSectionOptions(options);
  check(
    options.cookies,
    {
      enabled: true,
      unavailable: false,
      granular: { cookies_plain: false, cookies_partitioned: true },
    },
    'partial -> section enabled, granular map exact'
  );
}
{
  // all off
  const options = {
    sessions_tabs: { enabled: false, unavailable: false },
    sessions_windows: { enabled: false, unavailable: false },
  };
  synthesizeSectionOptions(options);
  check(
    options.sessions,
    {
      enabled: false,
      unavailable: false,
      granular: { sessions_tabs: false, sessions_windows: false },
    },
    'all off -> section disabled'
  );
}
{
  // all unavailable
  const options = {
    siteData_localStorage: { enabled: false, unavailable: true },
    siteData_indexedDB: { enabled: false, unavailable: true },
    siteData_otherStorage: { enabled: false, unavailable: true },
  };
  synthesizeSectionOptions(options);
  check(options.siteData.unavailable, true, 'all unavailable -> section unavailable');
  check(options.siteData.enabled, false, 'all unavailable -> section disabled');
}
{
  // every section in CATEGORY_GROUP_MEMBERS is synthesized, even absent
  const options = {};
  synthesizeSectionOptions(options);
  for (const section of Object.keys(CATEGORY_GROUP_MEMBERS)) {
    check(
      typeof options[section],
      'object',
      `section entry created for ${section}`
    );
  }
}

// 7. mappings.
{
  check(sectionForRow('tabs'), 'tabsWindows', 'tabs -> tabsWindows');
  check(sectionForRow('windows'), 'tabsWindows', 'windows -> tabsWindows');
  check(sectionForRow('tabGroups'), 'tabsWindows', 'tabGroups -> tabsWindows');
  check(sectionForRow('cookies_plain'), 'cookies', 'cookies_plain -> cookies');
  check(
    sectionForRow('cookies_partitioned'),
    'cookies',
    'cookies_partitioned -> cookies'
  );
  check(sectionForRow('sessions_tabs'), 'sessions', 'sessions_tabs');
  check(sectionForRow('sessions_windows'), 'sessions', 'sessions_windows');
  check(
    sectionForRow('siteData_indexedDB'),
    'siteData',
    'siteData_indexedDB -> siteData'
  );
  check(sectionForRow('bookmarks'), 'bookmarks', 'section ids pass through');
  check(
    capabilityKeyForRow('tabGroups'),
    'tabGroups',
    'tabGroups keeps its own capability key'
  );
  check(
    capabilityKeyForRow('tabs'),
    'tabsWindows',
    'tabs capability -> tabsWindows'
  );
  check(
    capabilityKeyForRow('siteData_localStorage'),
    'siteData',
    'siteData_* capability -> siteData'
  );
  check(
    capabilityKeyForRow('bookmarks'),
    'bookmarks',
    'other ids pass through'
  );
}

console.log(`restore-granular-rows: ${n} assertions passed`);
