import assert from 'node:assert/strict';
import { discoverOrigins, filterSiteDataOriginsForBackup } from '../../src/lib/sitedata.js';
import { filterSiteDataOrigins, getSelectedSiteDataOrigins } from '../../src/lib/site-data-selection.js';

globalThis.chrome = {
  tabs: { async query() { return [{ url: 'https://a.example/path', incognito: false }, { url: 'chrome://settings', incognito: false }]; } },
  history: { async search() { return [{ url: 'https://b.example/page' }, { url: 'https://a.example/other' }]; } },
  bookmarks: { async getTree() { return [{ children: [{ url: 'https://c.example/' }] }]; } },
  readingList: { async query() { return [{ url: 'https://d.example/' }]; } },
  cookies: { async getAllCookieStores() { return [{ id: '0' }]; }, async getAll() { return [{ domain: '.e.example' }]; } }
};

const { origins } = await discoverOrigins();
assert.deepEqual(origins.map(({ origin }) => origin), [
  'https://a.example', 'https://b.example', 'https://c.example', 'https://d.example', 'https://e.example'
]);
assert.deepEqual(filterSiteDataOrigins(origins, 'C.ExAmPlE').map(({ origin }) => origin), ['https://c.example']);
assert.deepEqual(getSelectedSiteDataOrigins(origins, ['https://a.example', 'https://e.example']).map(({ origin }) => origin), [
  'https://a.example', 'https://e.example'
]);
assert.equal(getSelectedSiteDataOrigins(origins, null).length, origins.length, 'no saved selection defaults to all candidates');
assert.deepEqual(filterSiteDataOriginsForBackup(origins, { includeOrigins: ['https://b.example', 'https://d.example'] }), {
  origins: ['https://b.example', 'https://d.example'], truncated: false, candidateCount: 2
});
assert.deepEqual(filterSiteDataOriginsForBackup(origins, { includeOrigins: [] }).origins, [], 'an empty explicit selection must scan no sites');
assert.equal(filterSiteDataOriginsForBackup(Array.from({ length: 80 }, (_, i) => ({ origin: `https://${i}.example` })), {}).origins.length, 80, 'default selection must include every discovered origin');
console.log('PASS site-data origin discovery, filtering and selection');
