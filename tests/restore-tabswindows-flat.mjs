// Batch 2: restoreTabsWindows fallback for granular tabsWindows data.
//
// Covers:
//   1. flat tabs[] (no windows[]) -> one window per old windowId, tabs
//      created in the right window;
//   2. layout-only windows (tabs: []) -> empty windows created with geometry;
//   3. tabGroups present but no tabs at all -> skip grouping with a note,
//      no crash;
//   4. legacy nested format -> old path unchanged (single window, grouped);
//   5. MAX_RESTORE_TABS enforced for flat tabs;
//   6. Android: flat tabs reuse the focused window (no windows.create);
//   7. flat tabs with groupId + tabGroups meta -> tabs.group called with the
//      NEW window id and group metadata applied.
import assert from 'node:assert/strict';

let n = 0;
const check = (actual, expected, label) => {
  n++;
  assert.deepEqual(actual, expected, label);
};

let nextWinId;
let nextTabId;
let createdWindows;
let createdTabs;
let groupCalls;
let groupUpdateCalls;
let lastFocusedCalls;
let platformOs;
const placeholderWindow = new Map();

function resetMocks() {
  nextWinId = 100;
  nextTabId = 1000;
  createdWindows = [];
  createdTabs = [];
  groupCalls = [];
  groupUpdateCalls = [];
  lastFocusedCalls = 0;
  platformOs = 'linux';
  placeholderWindow.clear();
}

resetMocks();

globalThis.chrome = {
  runtime: {
    async getPlatformInfo() {
      return { os: platformOs };
    },
  },
  windows: {
    async create(props) {
      const id = nextWinId++;
      const placeholderId = 9000 + id;
      createdWindows.push({ id, props });
      placeholderWindow.set(placeholderId, id);
      return { id, tabs: [{ id: placeholderId }] };
    },
    async getLastFocused() {
      lastFocusedCalls++;
      return { id: 42, tabs: [] };
    },
  },
  tabs: {
    async create(props) {
      const id = nextTabId++;
      createdTabs.push({ id, props });
      return { id, windowId: props.windowId };
    },
    async update() {},
    async move() {},
    async get(id) {
      return { id, windowId: placeholderWindow.get(id) };
    },
    async remove(id) {
      // Placeholder cleanup must only ever target our own placeholders.
      assert.ok(
        placeholderWindow.has(id),
        `safeCloseTab must only close owned placeholder tabs (got ${id})`
      );
    },
    async group({ tabIds, createProperties }) {
      groupCalls.push({ tabIds, createProperties });
      return 77;
    },
  },
  tabGroups: {
    async update(groupId, props) {
      groupUpdateCalls.push({ groupId, props });
    },
  },
};

const { restoreTabsWindows } = await import('../src/lib/restore.js');

// 1. Flat tabs -> one window per old windowId.
{
  resetMocks();
  const result = await restoreTabsWindows(
    {
      windows: [],
      tabs: [
        { url: 'https://a.example/', title: 'A', index: 0, windowId: 1 },
        { url: 'https://b.example/', title: 'B', index: 1, windowId: 1 },
        { url: 'https://c.example/', title: 'C', index: 0, windowId: 2 },
      ],
      tabGroups: [],
    },
    {},
    null
  );
  check(createdWindows.length, 2, 'one window per old windowId');
  check(result.stats.tabsCreated, 3, 'all flat tabs created');
  check(result.stats.tabsFailed, 0, 'no tab failures');
  const winIds = createdWindows.map((w) => w.id);
  const tabsByWin = new Map(winIds.map((id) => [id, 0]));
  for (const t of createdTabs)
    tabsByWin.set(t.props.windowId, tabsByWin.get(t.props.windowId) + 1);
  check(
    [...tabsByWin.values()].sort(),
    [1, 2],
    'tabs land in the window matching their old windowId group'
  );
  check(result.status, 'ok', 'status ok');
}

// 2. Layout-only windows -> empty windows with geometry.
{
  resetMocks();
  const result = await restoreTabsWindows(
    {
      windows: [
        {
          type: 'normal',
          state: 'normal',
          focused: false,
          alwaysOnTop: false,
          bounds: { left: 10, top: 20, width: 1280, height: 800 },
          tabs: [],
        },
        {
          type: 'popup',
          state: 'maximized',
          focused: false,
          alwaysOnTop: true,
          bounds: { left: 0, top: 0, width: 640, height: 480 },
          tabs: [],
        },
      ],
      tabGroups: [],
    },
    {},
    null
  );
  check(createdWindows.length, 2, 'both layout windows created');
  check(createdTabs.length, 0, 'no tabs created');
  check(
    createdWindows[0].props,
    {
      focused: false,
      type: 'normal',
      state: 'normal',
      left: 10,
      top: 20,
      width: 1280,
      height: 800,
    },
    'geometry applied to empty window'
  );
  check(
    createdWindows[1].props.type,
    'popup',
    'popup type preserved for empty window'
  );
  check(result.status, 'ok', 'status ok');
}

// 3. tabGroups present but no tabs -> note, no crash.
{
  resetMocks();
  const result = await restoreTabsWindows(
    {
      windows: [],
      tabGroups: [{ groupId: 5, title: 'Ghost', color: 'red', windowId: 9 }],
    },
    {},
    null
  );
  check(result.status, 'ok', 'status ok with no tabs');
  check(createdWindows.length, 0, 'no windows created');
  check(groupCalls.length, 0, 'no grouping attempted');
  check(
    result.stats.notes.some((note) => /tab group/i.test(note)),
    true,
    'note explains skipped tab groups'
  );
}

// 4. Legacy nested format -> old path unchanged.
{
  resetMocks();
  const result = await restoreTabsWindows(
    {
      windows: [
        {
          state: 'normal',
          tabs: [
            { url: 'https://a.example/', title: 'A', index: 0, groupId: 5 },
            { url: 'https://b.example/', title: 'B', index: 1, groupId: 5 },
          ],
        },
      ],
      tabGroups: [{ groupId: 5, title: 'Research', color: 'blue' }],
    },
    {},
    null
  );
  check(createdWindows.length, 1, 'single window for legacy backup');
  check(result.stats.tabsCreated, 2, 'nested tabs created');
  check(groupCalls.length, 1, 'grouping still applied');
  check(result.stats.grouped, 2, 'grouped count reported');
}

// 5. MAX_RESTORE_TABS enforced for flat tabs.
{
  resetMocks();
  const tabs = Array.from({ length: 501 }, (_, i) => ({
    url: `https://x.example/${i}`,
    title: `X${i}`,
    index: i,
    windowId: 1,
  }));
  await assert.rejects(
    () => restoreTabsWindows({ windows: [], tabs, tabGroups: [] }, {}, null),
    (e) => e && e.code === 'ERR_RESTORE_TOO_LARGE',
    'flat tab flood refused'
  );
  check(createdWindows.length, 0, 'no window created before the limit check');
}

// 6. Android: flat tabs reuse the focused window.
{
  resetMocks();
  platformOs = 'android';
  const result = await restoreTabsWindows(
    {
      windows: [],
      tabs: [
        { url: 'https://a.example/', title: 'A', index: 0, windowId: 1 },
        { url: 'https://b.example/', title: 'B', index: 0, windowId: 2 },
      ],
      tabGroups: [],
    },
    {},
    null
  );
  check(lastFocusedCalls, 1, 'focused window reused on Android');
  check(createdWindows.length, 0, 'no windows.create on Android');
  check(
    createdTabs.every((t) => t.props.windowId === 42),
    true,
    'flat tabs created in the focused window'
  );
  check(result.stats.tabsCreated, 2, 'tabs created');
}

// 7. Flat tabs with groups -> tabs.group targets the NEW window id.
{
  resetMocks();
  await restoreTabsWindows(
    {
      windows: [],
      tabs: [
        {
          url: 'https://a.example/',
          title: 'A',
          index: 0,
          windowId: 1,
          groupId: 5,
        },
        {
          url: 'https://b.example/',
          title: 'B',
          index: 1,
          windowId: 1,
          groupId: 5,
        },
      ],
      tabGroups: [
        { groupId: 5, title: 'Research', color: 'green', windowId: 1 },
      ],
    },
    {},
    null
  );
  check(groupCalls.length, 1, 'one group created');
  check(
    groupCalls[0].createProperties.windowId,
    createdWindows[0].id,
    'tabs.group targets the newly created window, not the old windowId'
  );
  check(groupCalls[0].tabIds.length, 2, 'both grouped tabs passed');
  check(
    groupUpdateCalls[0].props,
    { title: 'Research', color: 'green' },
    'group metadata (title+color) applied'
  );
}

console.log(`PASS restore-tabswindows-flat (${n} assertions)`);
