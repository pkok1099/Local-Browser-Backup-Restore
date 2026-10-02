import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const calls = [];
const localStorage = {
  get length() {
    calls.push('localStorage');
    throw new Error('localStorage denied');
  },
};
const sessionStorage = {
  get length() {
    calls.push('sessionStorage');
    throw 'sessionStorage denied';
  },
};
const context = vm.createContext({
  location: { origin: 'https://example.test' },
  localStorage,
  sessionStorage,
  indexedDB: {
    databases: async () => {
      calls.push('indexedDB');
      throw new Error('indexedDB denied');
    },
  },
  caches: {
    keys: async () => {
      calls.push('cacheStorage');
      throw new Error('cacheStorage denied');
    },
  },
  navigator: {
    serviceWorker: {
      getRegistrations: async () => {
        calls.push('serviceWorkers');
        throw new Error('serviceWorkers denied');
      },
    },
    storage: {
      getDirectory: async () => {
        calls.push('opfs');
        throw new Error('opfs denied');
      },
    },
    storageBuckets: {
      keys: () => {
        calls.push('buckets');
        throw new Error('buckets denied');
      },
    },
  },
});

const source = await readFile(new URL('../public/lib/pagelib.js', import.meta.url), 'utf8');
vm.runInContext(source, context, { filename: 'pagelib.js' });
const snapshot = JSON.parse(JSON.stringify(await context.__BBR.readSiteAll({ fetchScript: false })));

assert.equal(snapshot.origin, 'https://example.test');
assert.deepEqual(snapshot.localStorage, {});
assert.deepEqual(snapshot.sessionStorage, {});
assert.deepEqual(snapshot.indexedDB, []);
assert.deepEqual(snapshot.cacheStorage, []);
assert.deepEqual(snapshot.serviceWorkers, []);
assert.deepEqual(snapshot.opfs, { error: 'Error: opfs denied', files: [], dirs: [] });
assert.deepEqual(snapshot.buckets, { error: 'Error: buckets denied', buckets: [] });
assert.deepEqual(snapshot.errors, [
  'localStorage: localStorage denied',
  'sessionStorage: sessionStorage denied',
  'indexedDB: indexedDB denied',
  'cacheStorage: cacheStorage denied',
  'serviceWorkers: serviceWorkers denied',
]);
assert.deepEqual(calls, [
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'cacheStorage',
  'serviceWorkers',
  'opfs',
  'buckets',
]);
console.log('PASS pagelib category failures: stable fallbacks, independent continuation, and capture order');
