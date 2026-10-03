import assert from 'node:assert/strict';
import { collectAll, computeCounts } from '../src/lib/collect.js';
import { restoreAll } from '../src/lib/restore.js';

const allowlistedKeys = [
  'bbr.dashboard.theme',
  'bbr:backup-categories',
  'bbr:site-data-scan-window',
  'bbr:site-data-tuning',
  'bbr:site-data-include',
];
const localData = {
  'bbr.dashboard.theme': 'dark',
  'bbr:backup-categories': ['bookmarks'],
  'bbr:site-data-scan-window': 12,
  'bbr:site-data-tuning': { maxOrigins: 4 },
  'bbr:site-data-include': ['https://example.test'],
  'bbr:cloud-config': { github: { token: 'destination-secret' } },
  'bbr:site-data-checkpoint': { origin: 'https://example.test' },
  'bbr:site-data-owned-tabs': [42],
  'bbr:last-backup': { raw: 'private-backup' },
  'unknown.local.setting': 'private-value',
};
const localGetCalls = [];
const localSetCalls = [];
const syncData = { 'unknown.sync.setting': 'private-sync-value' };
const syncGetCalls = [];
const syncSetCalls = [];

globalThis.chrome = {
  runtime: {
    async getPlatformInfo() { return { os: 'android', arch: 'arm64' }; },
    getManifest() { return { version: '1.4.2' }; }
  },
  storage: {
    local: {
      async get(keys) {
        localGetCalls.push(keys);
        if (keys === null) return { ...localData };
        return Object.fromEntries(keys.filter((key) => Object.hasOwn(localData, key)).map((key) => [key, localData[key]]));
      },
      async set(values) {
        localSetCalls.push(values);
        Object.assign(localData, values);
      }
    },
    sync: {
      async get(keys) {
        syncGetCalls.push(keys);
        return { ...syncData };
      },
      async set(values) {
        syncSetCalls.push(values);
        Object.assign(syncData, values);
      }
    }
  }
};

const selected = await collectAll(null, { selectedCategories: ['profile'] });
assert.deepEqual(Object.keys(selected.data), ['profile'], 'only selected categories should be collected');
for (const [name, status] of Object.entries(selected.categoryStatus)) {
  if (name !== 'profile') assert.equal(status.skipped, true, `${name} should be marked skipped`);
}
assert.equal(selected.categoryStatus.profile.ok, true);
console.log('PASS backup selection collects only the chosen categories');

const collectedStorage = await collectAll(null, { selectedCategories: ['extensionStorage'] });
assert.deepEqual(localGetCalls, [allowlistedKeys], 'collection should request only the approved local keys');
assert.deepEqual(Object.keys(collectedStorage.data.extensionStorage.local), allowlistedKeys, 'collection should return only approved local keys');
assert.deepEqual(collectedStorage.data.extensionStorage.local, {
  'bbr.dashboard.theme': 'dark',
  'bbr:backup-categories': ['bookmarks'],
  'bbr:site-data-scan-window': 12,
  'bbr:site-data-tuning': { maxOrigins: 4 },
  'bbr:site-data-include': ['https://example.test'],
});
assert.equal(Object.hasOwn(collectedStorage.data.extensionStorage, 'sync'), false, 'sync data should not be exported');
assert.deepEqual(syncGetCalls, [], 'collection should not read sync storage');
console.log('PASS extension storage collection requests and exports only approved local keys');

const oldStyleStorage = {
  local: {
    'bbr.dashboard.theme': 'light',
    'bbr:cloud-config': { github: { token: 'imported-secret' } },
    'bbr:site-data-checkpoint': { origin: 'https://imported.test' },
    'bbr:site-data-owned-tabs': [99],
    'bbr:last-backup': { raw: 'imported-backup' },
    'unknown.local.setting': 'imported-value',
  },
  sync: { 'unknown.sync.setting': 'imported-sync-value' },
};
const restored = await restoreAll(
  { data: { extensionStorage: oldStyleStorage } },
  { extensionStorage: { enabled: true } }
);
assert.equal(restored.extensionStorage.status, 'ok', 'restore should preserve its existing status field');
assert.deepEqual(localSetCalls, [{ 'bbr.dashboard.theme': 'light' }], 'restore should set only allowlisted local keys');
assert.deepEqual(syncSetCalls, [], 'restore should not write sync storage');
assert.equal(localData['bbr:cloud-config'].github.token, 'destination-secret', 'restore should preserve existing credentials');
assert.equal(restored.extensionStorage.stats.keysLocal, 1);
assert.equal(restored.extensionStorage.stats.keysSync, 0);
assert.equal(restored.extensionStorage.stats.skippedKeys, 6, 'restore should count five ignored local keys and one ignored sync key');
assert.match(restored.extensionStorage.summary, /6.*skipped/i, 'restore summary should include the skipped-key count');
console.log('PASS extension storage restore merges approved local keys and counts ignored keys');

assert.equal(
  computeCounts({ extensionStorage: { local: { first: 1, second: 2, third: 3 }, sync: { ignored: 4, alsoIgnored: 5 } } }).extensionStorage,
  3,
  'extension storage counts should include local preference keys only'
);
assert.equal(
  computeCounts({ extensionStorage: { local: {}, sync: { ignored: 1 } } }).extensionStorage,
  0,
  'an empty local preference object should count as zero, regardless of sync data'
);
console.log('PASS extension storage counts include only local preference keys');
