import assert from 'node:assert/strict';

const nativeRemovals = [];
const events = [];
globalThis.chrome = {
  tabs: {
    async get(tabId) {
      events.push(`tabs.get:${tabId}`);
      return { id: tabId, url: 'http://scan.example/__bbr_site_scan__', pendingUrl: '' };
    },
    remove(tabId) {
      nativeRemovals.push(tabId);
      events.push(`native-remove:${tabId}`);
      return Promise.resolve();
    },
  },
  history: {
    async deleteUrl({ url }) { events.push(`history.deleteUrl:${url}`); },
  },
};

const { createSiteDataOwnership } = await import('../src/lib/sitedata.js?runtime-tab-remove-guard');
const guardLogs = [];
const ownership = createSiteDataOwnership([], () => {}, (level, category, message, context) => {
  guardLogs.push({ level, category, message, context });
});
ownership.own(101);

const rawAlias = chrome.tabs.remove;
await assert.rejects(rawAlias(101), /tab removal blocked: call outside safeCloseTab/);
const { remove: destructuredRemove } = chrome.tabs;
await assert.rejects(destructuredRemove(102), /tab removal blocked: call outside safeCloseTab/);
await assert.rejects(chrome.tabs['remove'](103), /tab removal blocked: call outside safeCloseTab/);
await assert.rejects(chrome['tabs']['remove'](104), /tab removal blocked: call outside safeCloseTab/);
await assert.rejects(chrome.tabs.remove(999), /tab removal blocked: call outside safeCloseTab/);

assert.deepEqual(nativeRemovals, [], 'unapproved direct/aliased calls never reach the native API');
assert.equal(guardLogs.length, 5);
assert.ok(guardLogs.every((entry) => entry.level === 'ERROR' && entry.category === 'SAFETY'));
assert.deepEqual(guardLogs.map((entry) => entry.context.tabId), [101, 102, 103, 104, 999]);
assert.ok(guardLogs.every((entry) => entry.message.includes('blocked')));

const status = await ownership.safeCloseTab(101, 'http://scan.example');
assert.equal(status, 'closed');
assert.deepEqual(nativeRemovals, [101], 'the verified, owned close remains functional through safeCloseTab');
assert.ok(events.indexOf('history.deleteUrl:http://scan.example/__bbr_site_scan__') < events.indexOf('native-remove:101'));
assert.equal(ownership.ownedTabIds.size, 0);
ownership.dispose();
console.log('PASS runtime tab-remove guard: direct, alias, destructuring, dynamic access, logging, and authorized close');
