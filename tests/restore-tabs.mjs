import assert from 'node:assert/strict';
import { restoreTabsWindows } from '../src/lib/restore.js';

let activeCreates = 0;
let maximumActiveCreates = 0;
let nextId = 100;
const createCalls = [];
const moveCalls = [];
const updateCalls = [];
const removedTabs = [];
const groups = [];

globalThis.chrome = {
  windows: {
    async create() { return { id: 7, tabs: [{ id: 99 }] }; }
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
    async update(id, props) { updateCalls.push({ id, props }); },
    async move(id, props) { moveCalls.push({ id, props }); },
    async get(id) { return { id, windowId: 7 }; },
    async remove(id) { removedTabs.push(id); },
    async group({ tabIds }) { groups.push(tabIds); return 12; }
  },
  tabGroups: { async update() {} }
};

const tabs = [
  { url: 'https://one.example/', pinned: true, muted: false, groupId: 5 },
  { url: 'https://two.example/', pinned: false, muted: true, groupId: 5 },
  { url: 'https://three.example/', pinned: false, muted: false },
  { url: 'https://four.example/', pinned: false, muted: false },
  { url: 'https://five.example/', pinned: false, muted: false },
  { url: 'https://six.example/', pinned: false, muted: false }
];

const result = await restoreTabsWindows({ windows: [{ state: 'normal', tabs }], tabGroups: [{ groupId: 5, title: 'Research' }] }, {}, null);
assert.equal(result.stats.tabsCreated, tabs.length);
assert.equal(result.stats.tabsFailed, 0);
assert.ok(maximumActiveCreates > 1, 'tab URLs should be created concurrently');
assert.ok(maximumActiveCreates <= 4, 'concurrent tab creation should be bounded for mobile memory');
assert.ok(createCalls.every((props) => props.active === false), 'each restored tab should stay in the background');
assert.ok(createCalls.every((props) => props.url === 'about:blank'));
assert.deepEqual(updateCalls.filter(({ props }) => props.url).map(({ props }) => props.url), tabs.map((tab) => tab.url));
assert.deepEqual(moveCalls.map(({ id, props }) => [id, props.index]), [
  [100, 0], [101, 1], [102, 2], [103, 3], [104, 4], [105, 5]
], 'restored tabs should be reordered to match backup order after parallel creation');
assert.ok(updateCalls.some(({ id, props }) => id === 100 && props.pinned === true));
assert.ok(updateCalls.some(({ id, props }) => id === 101 && props.muted === true));
assert.deepEqual(groups, [[100, 101]], 'group membership should be restored after tab creation');
assert.deepEqual(removedTabs, [99], 'the new window placeholder tab should be removed after tabs are restored');

console.log('PASS tab restore keeps tabs in background, creates bounded batches in parallel, and preserves order and metadata');
