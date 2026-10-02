import assert from 'node:assert/strict';

globalThis.chrome = undefined;
const events = [];
const fakeChrome = {
  bookmarks: {
    async create(details) {
      events.push({ op: 'bookmarks.create', details: structuredClone(details) });
      if (details.url) return { id: 'probe-bookmark', dateAdded: 500 };
      return { id: 'probe-folder' };
    },
    async removeTree(id) { events.push({ op: 'bookmarks.removeTree', id }); },
    async remove(id) { events.push({ op: 'bookmarks.remove', id }); },
  },
  history: {
    async addUrl(details) { events.push({ op: 'history.addUrl', details }); },
    async search(details) {
      events.push({ op: 'history.search', details });
      return [{ url: 'https://bbr-probe.example/bbr-history-probe', title: 'probe history', visitCount: 3, lastVisitTime: 5000 }];
    },
    async getVisits(details) {
      events.push({ op: 'history.getVisits', details });
      return [{ transition: 'link' }];
    },
    async deleteUrl(details) { events.push({ op: 'history.deleteUrl', details }); },
  },
  readingList: {
    async getEntries() { events.push({ op: 'readingList.getEntries' }); return [...entries.values()]; },
    async addEntry(details) { events.push({ op: 'readingList.addEntry', details: structuredClone(details) }); entries.set(details.url, { ...details }); },
    async removeEntry(details) { events.push({ op: 'readingList.removeEntry', details }); entries.delete(details.url); },
  },
  cookies: {
    async set(details) {
      events.push({ op: 'cookies.set', details: structuredClone(details) });
      if (details.name === '__bbr_probe') return { partitionKey: { topLevelSite: 'https://bbr-probe.example/' } };
      return { name: details.name, firstPartyDomain: '' };
    },
    async remove(details) { events.push({ op: 'cookies.remove', details }); },
    async getAllCookieStores() { return []; },
  },
  sessions: { MAX_SESSION_RESULTS: 25 },
};
const entries = new Map();
globalThis.chrome = fakeChrome;

const { runProbes } = await import('../src/lib/capabilities.js');
const result = await runProbes();

assert.deepEqual(result, {
  bookmarksCreateHonorsDateAdded: false,
  historyWriteApis: {
    addUrl: 'function',
    addVisit: 'undefined',
    createDetails: 'undefined',
    knownMethods: ['addUrl', 'deleteUrl', 'getVisits', 'search'],
  },
  historyAddUrl: {
    works: true,
    visitCount: 3,
    title: 'probe history',
    lastVisitTimeSet: 5000,
    transition: 'link',
  },
  readingListApi: ['addEntry', 'getEntries', 'removeEntry'],
  cookiesPartitionKey: {
    works: true,
    partitionKeyEcho: { topLevelSite: 'https://bbr-probe.example/' },
  },
  cookiesFirstPartyDomainField: true,
  readingList: {
    creationTimeHonored: true,
    fields: ['creationTime', 'hasBeenRead', 'lastUpdateTime', 'title', 'url'],
  },
  compressionStream: typeof CompressionStream !== 'undefined',
  privateApisPresent: {
    settingsPrivate: false,
    developerPrivate: false,
    enterprisePlatformKeysPrivate: false,
    contentSettings: false,
    browsingData: false,
  },
  sessionsMaxResults: 25,
});

assert.deepEqual(events.map((event) => event.op), [
  'bookmarks.create',
  'bookmarks.create',
  'bookmarks.removeTree',
  'bookmarks.remove',
  'history.addUrl',
  'history.search',
  'history.getVisits',
  'history.deleteUrl',
  'cookies.set',
  'cookies.remove',
  'cookies.set',
  'cookies.remove',
  'readingList.addEntry',
  'readingList.getEntries',
  'readingList.removeEntry',
]);
assert.equal(events[0].details.parentId, '2');
assert.equal(events[1].details.dateAdded, 1000);
assert.deepEqual(events[8].details.partitionKey, { topLevelSite: 'https://bbr-probe.example/' });
assert.equal(entries.size, 0, 'the temporary reading-list item is cleaned up');
console.log('PASS runProbes characterization: output shape, probe inputs, and side-effect order');
