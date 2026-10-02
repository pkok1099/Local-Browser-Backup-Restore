import assert from 'node:assert/strict';
import { restoreTabsWindows } from '../src/lib/restore.js';

const created = [];
const operations = [];
const windowCreates = [];
let createsInFlight = 0;
let maxCreatesInFlight = 0;
globalThis.chrome = {
  runtime: { async getPlatformInfo() { return { os: 'android' }; } },
  windows: {
    async getLastFocused() { return { id: 41, focused: true, tabs: [{ id: 9 }] }; },
    async create(props) { windowCreates.push(props); return { id: 42, tabs: [{ id: 10 }] }; }
  },
  tabs: {
    async create(props) {
      created.push(props);
      const id = 100 + created.length;
      operations.push(['create', id, props]);
      createsInFlight++;
      maxCreatesInFlight = Math.max(maxCreatesInFlight, createsInFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      createsInFlight--;
      return { id, windowId: props.windowId };
    },
    async move() {}, async update(id, props) { operations.push(['update', id, props]); }, async remove() {}, async group() { return 1; }
  },
  tabGroups: { async update() {} }
};

const tabs = Array.from({ length: 10 }, (_, i) => ({ url: `https://${i}.example` }));
await restoreTabsWindows({ windows: [{ tabs }] }, {}, null);
assert.equal(windowCreates.length, 0, 'Android restore should not create/focus another window');
assert.deepEqual(created.map((tab) => tab.windowId), Array(10).fill(41));
assert.ok(created.every((tab) => tab.active === false));
assert.equal(maxCreatesInFlight, tabs.length, 'Android should dispatch all tab creation calls before waiting for results');
assert.ok(created.every((tab) => tab.url === 'about:blank'), 'all Android background tabs should be created empty first');
const firstNavigation = operations.findIndex(([, , props]) => props.url && props.url !== 'about:blank');
assert.ok(firstNavigation >= created.length, 'all blank tabs should exist before any URL navigation begins');
assert.equal(operations.filter(([, , props]) => props.url && props.url !== 'about:blank').length, tabs.length);
console.log('PASS Android restore creates all background tabs before dispatching concurrent navigations');
