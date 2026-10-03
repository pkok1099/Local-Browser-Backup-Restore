import assert from 'node:assert/strict';
import { restoreAll, restoreTabsWindows } from '../src/lib/restore.js';

let activeCreates = 0;
let maximumActiveCreates = 0;
let nextId = 100;
const createCalls = [];
const moveCalls = [];
const updateCalls = [];
const removedTabs = [];
const groups = [];
let failedNavigationUrl = null;
let failBookmarkCreates = false;
let failWindowGeometry = false;
let failTabPin = false;
let failTabMute = false;
let failTabMove = false;
let failTabGroup = false;
let failTabGroupUpdate = false;
let failBookmarkRemoval = false;

globalThis.chrome = {
  windows: {
    async create(props) {
      if (failWindowGeometry && props.width)
        throw new Error('window bounds rejected');
      return { id: 7, tabs: [{ id: 99 }] };
    },
  },
  tabs: {
    async create(props) {
      createCalls.push(props);
      activeCreates++;
      maximumActiveCreates = Math.max(maximumActiveCreates, activeCreates);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeCreates--;
      return { id: nextId++, windowId: props.windowId };
    },
    async update(id, props) {
      updateCalls.push({ id, props });
      if (props.url === failedNavigationUrl)
        throw new Error('navigation blocked');
      if (failTabPin && props.pinned) throw new Error('pin metadata denied');
      if (failTabMute && props.muted) throw new Error('mute metadata denied');
    },
    async move(id, props) {
      moveCalls.push({ id, props });
      if (failTabMove) throw new Error('tab order denied');
    },
    async get(id) {
      return { id, windowId: 7 };
    },
    async remove(id) {
      removedTabs.push(id);
    },
    async group({ tabIds }) {
      groups.push(tabIds);
      if (failTabGroup) throw new Error('tab grouping denied');
      return 12;
    },
  },
  tabGroups: {
    async update() {
      if (failTabGroupUpdate) throw new Error('group metadata denied');
    },
  },
  bookmarks: {
    async getTree() {
      return [{ children: [{ id: '1' }, { id: '2' }] }];
    },
    async getChildren(rootId) {
      return failBookmarkRemoval && rootId === '1'
        ? [{ id: 'legacy-bookmark', url: 'https://legacy.example/' }]
        : [];
    },
    async remove() {
      if (failBookmarkRemoval) throw new Error('bookmark cleanup denied');
    },
    async create(props) {
      if (failBookmarkCreates && props.url)
        throw new Error('bookmark write failed');
      return { id: 'created-bookmark' };
    },
  },
};

const tabs = [
  { url: 'https://one.example/', pinned: true, muted: false, groupId: 5 },
  { url: 'https://two.example/', pinned: false, muted: true, groupId: 5 },
  { url: 'https://three.example/', pinned: false, muted: false },
  { url: 'https://four.example/', pinned: false, muted: false },
  { url: 'https://five.example/', pinned: false, muted: false },
  { url: 'https://six.example/', pinned: false, muted: false },
];

const result = await restoreTabsWindows(
  {
    windows: [{ state: 'normal', tabs }],
    tabGroups: [{ groupId: 5, title: 'Research' }],
  },
  {},
  null
);
assert.equal(result.stats.tabsCreated, tabs.length);
assert.equal(result.stats.tabsFailed, 0);
assert.ok(maximumActiveCreates > 1, 'tab URLs should be created concurrently');
assert.ok(
  maximumActiveCreates <= 4,
  'concurrent tab creation should be bounded for mobile memory'
);
assert.ok(
  createCalls.every((props) => props.active === false),
  'each restored tab should stay in the background'
);
assert.ok(createCalls.every((props) => props.url === 'about:blank'));
assert.deepEqual(
  updateCalls.filter(({ props }) => props.url).map(({ props }) => props.url),
  tabs.map((tab) => tab.url)
);
assert.deepEqual(
  moveCalls.map(({ id, props }) => [id, props.index]),
  [
    [100, 0],
    [101, 1],
    [102, 2],
    [103, 3],
    [104, 4],
    [105, 5],
  ],
  'restored tabs should be reordered to match backup order after parallel creation'
);
assert.ok(
  updateCalls.some(({ id, props }) => id === 100 && props.pinned === true)
);
assert.ok(
  updateCalls.some(({ id, props }) => id === 101 && props.muted === true)
);
assert.deepEqual(
  groups,
  [[100, 101]],
  'group membership should be restored after tab creation'
);
assert.deepEqual(
  removedTabs,
  [99],
  'the new window placeholder tab should be removed after tabs are restored'
);

// T4-M1: tab bomb — a backup with more tabs than the cap must be refused
// BEFORE creating anything (fail-closed, no partial restore).
const bombTabs = Array.from({ length: 501 }, (_, i) => ({
  url: `https://bomb${i}.example/`,
}));
const createsBefore = createCalls.length;
await assert.rejects(
  restoreTabsWindows(
    { windows: [{ state: 'normal', tabs: bombTabs }], tabGroups: [] },
    {},
    null
  ),
  (e) => e && e.code === 'ERR_RESTORE_TOO_LARGE',
  'restoring >500 tabs should throw ERR_RESTORE_TOO_LARGE'
);
assert.equal(
  createCalls.length,
  createsBefore,
  'no tabs may be created when the cap is exceeded'
);

// T4-M2: non-http(s) tab URLs must never be navigated — a malicious backup
// must not render attacker HTML (data:) as a real tab.
updateCalls.length = 0;
const evilTabs = [
  { url: 'data:text/html,<h1>evil</h1>' },
  { url: 'javascript:alert(1)' },
  { url: 'https://good.example/' },
];
const evilResult = await restoreTabsWindows(
  { windows: [{ state: 'normal', tabs: evilTabs }], tabGroups: [] },
  {},
  null
);
const navigatedUrls = updateCalls
  .filter(({ props }) => props.url)
  .map(({ props }) => props.url);
assert.deepEqual(
  navigatedUrls,
  ['https://good.example/'],
  'only http(s) URLs may be navigated during restore, got: ' +
    JSON.stringify(navigatedUrls)
);
assert.equal(
  evilResult.stats.tabsFailed,
  2,
  'non-http(s) URLs should be refused and counted as failed'
);
assert.ok(
  evilResult.stats.notes.some((n) => n.includes('non-http(s)')),
  'URL refusal should be noted, got: ' + JSON.stringify(evilResult.stats.notes)
);

failedNavigationUrl = 'https://failed.example/';
const mixedTabs = await restoreAll(
  {
    data: {
      tabsWindows: {
        windows: [
          {
            tabs: [
              { url: 'https://success.example/' },
              { url: failedNavigationUrl },
            ],
          },
        ],
      },
    },
  },
  { tabsWindows: { enabled: true } }
);
failedNavigationUrl = null;
assert.equal(mixedTabs.tabsWindows.status, 'ok');
assert.equal(mixedTabs.tabsWindows.outcome, 'partial');
assert.deepEqual(mixedTabs.tabsWindows.stats.outcomeCounts, {
  succeeded: 1,
  failed: 1,
  skipped: 0,
});
assert.equal(
  mixedTabs.tabsWindows.stats.tabsCreated,
  2,
  'detailed created-tab count must remain available'
);
assert.equal(
  mixedTabs.tabsWindows.stats.tabsFailed,
  1,
  'detailed failed-tab count must remain available'
);

failedNavigationUrl = 'https://failed.example/';
const failedAcrossWindows = await restoreAll(
  {
    data: {
      tabsWindows: {
        windows: [
          { tabs: [{ url: failedNavigationUrl }] },
          { tabs: [{ url: failedNavigationUrl }] },
        ],
      },
    },
  },
  { tabsWindows: { enabled: true } }
);
failedNavigationUrl = null;
assert.equal(failedAcrossWindows.tabsWindows.outcome, 'failed');
assert.deepEqual(failedAcrossWindows.tabsWindows.stats.outcomeCounts, {
  succeeded: 0,
  failed: 2,
  skipped: 0,
});

failWindowGeometry = true;
const geometryFallback = await restoreAll(
  {
    data: {
      tabsWindows: {
        windows: [
          {
            state: 'normal',
            bounds: { left: 0, top: 0, width: 800, height: 600 },
            tabs: [{ url: 'https://geometry.example/' }],
          },
        ],
      },
    },
  },
  { tabsWindows: { enabled: true } }
);
failWindowGeometry = false;
assert.equal(geometryFallback.tabsWindows.outcome, 'partial');
assert.deepEqual(geometryFallback.tabsWindows.stats.outcomeCounts, {
  succeeded: 1,
  failed: 1,
  skipped: 0,
});

failTabPin = true;
const failedPinMetadata = await restoreAll(
  {
    data: {
      tabsWindows: {
        windows: [{ tabs: [{ url: 'https://pin.example/', pinned: true }] }],
      },
    },
  },
  { tabsWindows: { enabled: true } }
);
failTabPin = false;
assert.equal(failedPinMetadata.tabsWindows.outcome, 'failed');
assert.deepEqual(failedPinMetadata.tabsWindows.stats.outcomeCounts, {
  succeeded: 0,
  failed: 1,
  skipped: 0,
});
assert.equal(
  failedPinMetadata.tabsWindows.stats.tabsFailed,
  0,
  'note-only metadata failures should not rewrite detailed tab counters'
);

failTabMove = true;
const failedOrdering = await restoreAll(
  {
    data: {
      tabsWindows: { windows: [{ tabs: [{ url: 'https://order.example/' }] }] },
    },
  },
  { tabsWindows: { enabled: true } }
);
failTabMove = false;
assert.equal(failedOrdering.tabsWindows.outcome, 'failed');
assert.deepEqual(failedOrdering.tabsWindows.stats.outcomeCounts, {
  succeeded: 0,
  failed: 1,
  skipped: 0,
});

failTabGroup = true;
const failedGrouping = await restoreAll(
  {
    data: {
      tabsWindows: {
        windows: [{ tabs: [{ url: 'https://group.example/', groupId: 3 }] }],
        tabGroups: [{ groupId: 3, title: 'Group' }],
      },
    },
  },
  { tabsWindows: { enabled: true } }
);
failTabGroup = false;
assert.equal(failedGrouping.tabsWindows.outcome, 'failed');
assert.deepEqual(failedGrouping.tabsWindows.stats.outcomeCounts, {
  succeeded: 0,
  failed: 1,
  skipped: 0,
});

failTabGroupUpdate = true;
const failedGroupMetadata = await restoreAll(
  {
    data: {
      tabsWindows: {
        windows: [
          { tabs: [{ url: 'https://group-meta.example/', groupId: 4 }] },
        ],
        tabGroups: [{ groupId: 4, title: 'Group' }],
      },
    },
  },
  { tabsWindows: { enabled: true } }
);
failTabGroupUpdate = false;
assert.equal(failedGroupMetadata.tabsWindows.outcome, 'failed');
assert.deepEqual(failedGroupMetadata.tabsWindows.stats.outcomeCounts, {
  succeeded: 0,
  failed: 1,
  skipped: 0,
});

failBookmarkRemoval = true;
const failedBookmarkCleanup = await restoreAll(
  {
    data: {
      bookmarks: {
        roots: {
          bookmark_bar: {
            children: [
              { type: 'url', title: 'new', url: 'https://new.example/' },
            ],
          },
        },
      },
    },
  },
  { bookmarks: { enabled: true, mode: 'replace', confirmDestructive: true } }
);
failBookmarkRemoval = false;
assert.equal(failedBookmarkCleanup.bookmarks.outcome, 'partial');
assert.deepEqual(failedBookmarkCleanup.bookmarks.stats.outcomeCounts, {
  succeeded: 1,
  failed: 1,
  skipped: 0,
});

failBookmarkCreates = true;
const failedBookmarks = await restoreAll(
  {
    data: {
      bookmarks: {
        roots: {
          bookmark_bar: {
            children: [
              { type: 'url', title: 'one', url: 'https://one.example/' },
              { type: 'url', title: 'two', url: 'https://two.example/' },
            ],
          },
        },
      },
    },
  },
  { bookmarks: { enabled: true } }
);
failBookmarkCreates = false;
assert.equal(failedBookmarks.bookmarks.status, 'ok');
assert.equal(failedBookmarks.bookmarks.outcome, 'failed');
assert.deepEqual(failedBookmarks.bookmarks.stats.outcomeCounts, {
  succeeded: 0,
  failed: 2,
  skipped: 0,
});

const untouchedCategories = await restoreAll(
  { data: { tabsWindows: { windows: [], tabGroups: [] } } },
  { tabsWindows: { enabled: false } }
);
assert.equal(untouchedCategories.history.status, 'not_in_backup');
assert.equal(untouchedCategories.history.outcome, 'not_in_backup');
assert.equal(untouchedCategories.tabsWindows.status, 'skipped_by_user');
assert.equal(untouchedCategories.tabsWindows.outcome, 'skipped_by_user');

const unavailableReadingList = await restoreAll(
  {
    data: {
      readingList: {
        entries: [{ url: 'https://unavailable.test/', title: 'Unavailable' }],
      },
    },
  },
  { readingList: { enabled: false, unavailable: true } }
);
assert.equal(unavailableReadingList.readingList.status, 'unsupported');
assert.equal(unavailableReadingList.readingList.outcome, 'unavailable');
const skippedReadingList = await restoreAll(
  {
    data: {
      readingList: {
        entries: [{ url: 'https://skipped.test/', title: 'Skipped' }],
      },
    },
  },
  { readingList: { enabled: false } }
);
assert.equal(skippedReadingList.readingList.status, 'skipped_by_user');
assert.equal(skippedReadingList.readingList.outcome, 'skipped_by_user');
const unavailableInstalledExtensions = await restoreAll(
  { data: { installedExtensions: { items: [{ id: 'abc' }, { id: 'def' }] } } },
  { installedExtensions: { enabled: false, unavailable: true } }
);
assert.equal(
  unavailableInstalledExtensions.installedExtensions.status,
  'unsupported'
);
assert.equal(
  unavailableInstalledExtensions.installedExtensions.outcome,
  'unavailable'
);
assert.ok(
  unavailableInstalledExtensions.installedExtensions.summary.includes(
    'checklist of 2 extensions'
  )
);
assert.ok(
  unavailableInstalledExtensions.installedExtensions.summary.includes(
    'manual reinstallation'
  )
);
assert.ok(
  unavailableInstalledExtensions.installedExtensions.stats.notes[0].includes(
    'reinstall manually'
  )
);

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => ({ text: async () => 'fixture pagelib' });
chrome.runtime = { getURL: (path) => `chrome-extension://test/${path}` };
chrome.tabs.query = async () => [
  { id: 77, url: 'https://top.example/page', incognito: false },
];
chrome.scripting = {
  async executeScript({ files }) {
    if (files) return [];
    return [
      { frameId: 0, result: { mainFrame: true } },
      { frameId: 2, result: { error: 'partition write denied' } },
      { frameId: 3, result: { notTargeted: true } },
    ];
  },
};
try {
  const failedPartition = await restoreAll(
    {
      data: {
        siteData: {
          origins: {},
          partitions: [
            {
              topSite: 'https://top.example',
              frameOrigin: 'https://frame.example',
              snapshot: { localStorage: { key: 'value' } },
            },
          ],
        },
      },
    },
    { siteData: { enabled: true, allowLiveTabWrite: true } }
  );
  assert.equal(
    failedPartition.siteData.status,
    'ok',
    'legacy handler status must stay unchanged'
  );
  assert.equal(failedPartition.siteData.outcome, 'failed');
  assert.deepEqual(failedPartition.siteData.stats.outcomeCounts, {
    succeeded: 0,
    failed: 1,
    skipped: 0,
  });
  assert.ok(
    failedPartition.siteData.stats.notes.some((note) =>
      note.includes('partition write denied')
    )
  );
} finally {
  globalThis.fetch = originalFetch;
  delete chrome.runtime;
  delete chrome.scripting;
  delete chrome.tabs.query;
}

// T4-M3: partitioned restore must NOT inject scripts into the user's live tabs
// without explicit opt-in (allowLiveTabWrite). Default is skip-with-note.
let liveTabScriptCalls = 0;
globalThis.fetch = async () => ({ text: async () => 'fixture pagelib' });
chrome.runtime = { getURL: (path) => `chrome-extension://test/${path}` };
chrome.tabs.query = async () => [
  { id: 77, url: 'https://top.example/page', incognito: false },
];
chrome.scripting = {
  async executeScript() {
    liveTabScriptCalls++;
    return [];
  },
};
const partitionData = {
  data: {
    siteData: {
      origins: {},
      partitions: [
        {
          topSite: 'https://top.example',
          frameOrigin: 'https://frame.example',
          snapshot: { localStorage: { key: 'value' } },
        },
      ],
    },
  },
};
try {
  const denied = await restoreAll(partitionData, {
    siteData: { enabled: true },
  });
  assert.equal(
    liveTabScriptCalls,
    0,
    'no script may be injected into live tabs without allowLiveTabWrite'
  );
  assert.ok(
    denied.siteData.stats.notes.some((n) =>
      n.includes('live-tab write not confirmed')
    ),
    'the skip must be noted, got: ' +
      JSON.stringify(denied.siteData.stats.notes)
  );

  const allowed = await restoreAll(partitionData, {
    siteData: { enabled: true, allowLiveTabWrite: true },
  });
  assert.ok(
    liveTabScriptCalls > 0,
    'explicit allowLiveTabWrite must permit the live-tab write'
  );
} finally {
  globalThis.fetch = originalFetch;
  delete chrome.runtime;
  delete chrome.scripting;
  delete chrome.tabs.query;
}

console.log(
  'PASS partitioned restore needs explicit opt-in before touching live tabs'
);

console.log(
  'PASS restoreAll reports partition-frame errors without counting main or untargeted frames'
);
console.log(
  'PASS tab restore keeps tabs in background, creates bounded batches in parallel, and preserves order and metadata'
);

// T4-M4: a stale backup cookie must not overwrite a fresher live cookie.
const cookieSets = [];
const liveCookies = {
  // live cookie expires LATER than the backup copy -> backup is stale
  fresh: { name: 'fresh', expirationDate: 2000000000 },
  // live cookie expires EARLIER than the backup copy -> backup is fresher
  stale: { name: 'stale', expirationDate: 1000000000 },
};
chrome.cookies = {
  async get({ name }) {
    return liveCookies[name] || null;
  },
  async set(details) {
    cookieSets.push(details);
    return { name: details.name };
  },
};
const cookieResult = await restoreAll(
  {
    data: {
      cookies: {
        cookies: [
          {
            name: 'fresh',
            value: 'old-backup',
            domain: 'example.com',
            path: '/',
            expirationDate: 1500000000,
          },
          {
            name: 'stale',
            value: 'new-backup',
            domain: 'example.com',
            path: '/',
            expirationDate: 1500000000,
          },
          {
            name: 'missing',
            value: 'x',
            domain: 'example.com',
            path: '/',
            expirationDate: 1500000000,
          },
        ],
      },
    },
  },
  { cookies: { enabled: true } }
);
delete chrome.cookies;
const setNames = cookieSets.map((d) => d.name);
assert.ok(
  !setNames.includes('fresh'),
  'fresher live cookie must not be overwritten, sets were: ' +
    JSON.stringify(setNames)
);
assert.ok(
  setNames.includes('stale'),
  'older live cookie should be replaced by the fresher backup copy'
);
assert.ok(
  setNames.includes('missing'),
  'absent live cookie should be set from backup'
);
assert.ok(
  cookieResult.cookies.stats.notes.some((n) =>
    n.includes('fresher live cookie')
  ),
  'skipped stale overwrite should be noted, notes were: ' +
    JSON.stringify(cookieResult.cookies.stats.notes)
);
console.log(
  'PASS restore cookies skip stale overwrites of fresher live cookies'
);
