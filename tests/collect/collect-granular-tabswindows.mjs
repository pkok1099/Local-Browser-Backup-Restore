// Granular backup categories: tabs / windows / tabGroups (Batch 2).
//
// Covers:
//   1. equivalence: all granular members == legacy 'tabsWindows' id == direct
//      no-opts collectTabsWindows() call (deep-equal, not just same info);
//   2. partial: tabs off -> windows[].tabs = [] (layout kept, no flat key);
//   3. partial: windows off -> windows = [] + flat top-level tabs[] with
//      windowId (extension-UI/incognito tabs still excluded);
//   4. partial: tabGroups off -> tabGroups = [];
//   5. non-matching selectedCategories skips the section entirely;
//   6. computeCounts counts flat tabs.
import assert from 'node:assert/strict';

let n = 0;
const check = (actual, expected, label) => {
  n++;
  assert.deepEqual(actual, expected, label);
};

const tabA = {
  id: 11,
  index: 0,
  url: 'https://a.example/',
  title: 'A',
  pinned: false,
  groupId: 5,
  mutedInfo: { muted: false },
  incognito: false,
};
const tabB = {
  id: 12,
  index: 1,
  url: 'https://b.example/',
  title: 'B',
  pinned: true,
  groupId: -1,
  mutedInfo: { muted: true },
  incognito: false,
};
// Extension-UI tab: excluded in every mode.
const tabExt = {
  id: 13,
  index: 2,
  url: 'chrome-extension://xyz/page.html',
  title: 'Ext',
  pinned: false,
  incognito: false,
};
const tabC = {
  id: 21,
  index: 0,
  url: 'https://c.example/',
  title: 'C',
  pinned: false,
  incognito: false,
};

globalThis.chrome = {
  windows: {
    getAll: async () => [
      {
        id: 1,
        type: 'normal',
        state: 'normal',
        focused: true,
        alwaysOnTop: false,
        left: 0,
        top: 0,
        width: 1280,
        height: 800,
        tabs: [tabA, tabB, tabExt],
      },
      {
        id: 2,
        type: 'normal',
        state: 'maximized',
        focused: false,
        alwaysOnTop: false,
        left: 0,
        top: 0,
        width: 1920,
        height: 1080,
        tabs: [tabC],
      },
    ],
  },
  tabGroups: {
    query: async () => [
      {
        id: 5,
        title: 'Research',
        color: 'blue',
        collapsed: false,
        windowId: 1,
      },
    ],
  },
};

const { collectAll, collectTabsWindows, computeCounts } = await import(
  '../../src/lib/collect.js'
);

// 1. Equivalence: all granular == legacy id == direct no-opts call.
{
  const granular = await collectAll(null, {
    selectedCategories: ['tabs', 'windows', 'tabGroups'],
  });
  const legacy = await collectAll(null, {
    selectedCategories: ['tabsWindows'],
  });
  const direct = await collectTabsWindows();
  check(
    granular.data.tabsWindows,
    legacy.data.tabsWindows,
    'all granular == legacy tabsWindows id'
  );
  check(
    granular.data.tabsWindows,
    direct,
    'all granular == direct no-opts collectTabsWindows()'
  );
  check(
    'tabs' in granular.data.tabsWindows,
    false,
    'no flat tabs key when windows toggle is on'
  );
  check(
    granular.data.tabsWindows.windows[0].tabs.map((t) => t.url),
    ['https://a.example/', 'https://b.example/'],
    'nested tabs keep extension-UI tab excluded'
  );
  check(
    'windowId' in granular.data.tabsWindows.windows[0].tabs[0],
    false,
    'nested tabs carry no windowId (identical to legacy shape)'
  );
  check(granular.categoryStatus.tabsWindows.ok, true, 'status ok');
}

// 2. Tabs off: layout kept, nested tabs emptied, no flat key.
{
  const r = await collectAll(null, {
    selectedCategories: ['windows', 'tabGroups'],
  });
  const tw = r.data.tabsWindows;
  check(tw.windows.length, 2, 'both window layouts kept');
  check(
    tw.windows.every((w) => Array.isArray(w.tabs) && w.tabs.length === 0),
    true,
    'nested tabs emptied when tabs toggle off'
  );
  check('tabs' in tw, false, 'no flat tabs key when tabs toggle off');
  check(
    tw.windows[0].bounds,
    { left: 0, top: 0, width: 1280, height: 800 },
    'window layout preserved'
  );
  check(tw.tabGroups.length, 1, 'tabGroups unaffected');
}

// 3. Windows off: windows = [] + flat tabs[] with windowId.
{
  const r = await collectAll(null, {
    selectedCategories: ['tabs', 'tabGroups'],
  });
  const tw = r.data.tabsWindows;
  check(tw.windows, [], 'no window layouts');
  check(tw.tabs.length, 3, 'flat tabs collected');
  check(
    tw.tabs.map((t) => t.windowId),
    [1, 1, 2],
    'windowId preserved per flat tab'
  );
  check(
    tw.tabs.every((t) => t.url.startsWith('https://')),
    true,
    'extension-UI tab still excluded from flat tabs'
  );
  check(tw.tabs[0].groupId, 5, 'groupId preserved on flat tabs');
  check(tw.tabs[1].pinned, true, 'pinned preserved on flat tabs');
  check(tw.tabs[1].muted, true, 'muted preserved on flat tabs');
  check(tw.tabGroups.length, 1, 'tabGroups still collected');
}

// 4. Tab groups off.
{
  const r = await collectAll(null, {
    selectedCategories: ['tabs', 'windows'],
  });
  const tw = r.data.tabsWindows;
  check(tw.tabGroups, [], 'tabGroups emptied');
  check(tw.windows[0].tabs.length, 2, 'nested tabs still collected');
  check('tabs' in tw, false, 'no flat tabs key');
}

// 5. Tabs only.
{
  const r = await collectAll(null, { selectedCategories: ['tabs'] });
  const tw = r.data.tabsWindows;
  check(tw.windows, [], 'no windows');
  check(tw.tabs.length, 3, 'flat tabs only');
  check(tw.tabGroups, [], 'no tabGroups');
}

// 6. Non-matching selectedCategories skips the section entirely.
{
  const r = await collectAll(null, { selectedCategories: ['profile'] });
  check(r.data.tabsWindows, undefined, 'section absent when not selected');
  check(r.categoryStatus.tabsWindows.skipped, true, 'marked skipped');
}

// 7. computeCounts handles the flat shape.
{
  const r = await collectAll(null, { selectedCategories: ['tabs'] });
  const c = computeCounts(r.data);
  check(c.tabs, 3, 'counts flat tabs');
  check(c.windows, 0, 'counts zero windows');
  check(c.tabGroups, 0, 'counts zero tab groups');
}

console.log(`PASS collect-granular-tabswindows (${n} assertions)`);
