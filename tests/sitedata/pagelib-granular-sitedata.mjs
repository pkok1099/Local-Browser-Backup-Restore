// Test: granular site-data category flags.
// - pagelib readSiteAll honors { localStorage: false }, { indexedDB: false }
//   and { otherStorage: false } (cacheStorage + OPFS + buckets); default
//   reads everything (legacy equivalence).
// - sitedata.js buildSiteReadOpts maps dashboard opts to page-side read flags.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildSiteReadOpts } from '../../src/lib/sitedata.js';

function makeContext(calls) {
  return vm.createContext({
    location: { origin: 'https://example.test' },
    localStorage: {
      get length() {
        calls.push('localStorage');
        return 0;
      },
      key: () => null,
      getItem: () => null,
    },
    sessionStorage: {
      get length() {
        calls.push('sessionStorage');
        return 0;
      },
      key: () => null,
      getItem: () => null,
    },
    indexedDB: {
      databases: async () => {
        calls.push('indexedDB');
        return [];
      },
    },
    caches: {
      keys: async () => {
        calls.push('cacheStorage');
        return [];
      },
    },
    navigator: {
      serviceWorker: {
        getRegistrations: async () => {
          calls.push('serviceWorkers');
          return [];
        },
      },
      storage: {
        getDirectory: async () => {
          calls.push('opfs');
          return { entries: async function* () {} };
        },
      },
      storageBuckets: {
        keys: async () => {
          calls.push('buckets');
          return [];
        },
      },
    },
  });
}

const source = await readFile(
  new URL('../../public/lib/pagelib.js', import.meta.url),
  'utf8'
);

async function snapshotWith(opts) {
  const calls = [];
  const context = makeContext(calls);
  vm.runInContext(source, context, { filename: 'pagelib.js' });
  const snapshot = JSON.parse(
    JSON.stringify(await context.__BBR.readSiteAll(opts))
  );
  return { calls, snapshot };
}

// (a) Default reads everything: legacy behavior unchanged.
{
  const { calls, snapshot } = await snapshotWith({});
  assert.deepEqual(calls, [
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'cacheStorage',
    'serviceWorkers',
    'opfs',
    'buckets',
  ]);
  assert.ok(!('skipped' in snapshot), 'no skipped list by default');
  console.log('PASS pagelib granular (a): readSiteAll({}) reads all');
}

// (b) localStorage: false skips only localStorage.
{
  const { calls, snapshot } = await snapshotWith({ localStorage: false });
  assert.deepEqual(calls, [
    'sessionStorage',
    'indexedDB',
    'cacheStorage',
    'serviceWorkers',
    'opfs',
    'buckets',
  ]);
  assert.deepEqual(snapshot.localStorage, {});
  assert.deepEqual(snapshot.skipped, ['localStorage']);
  console.log(
    'PASS pagelib granular (b): {localStorage:false} skips only localStorage'
  );
}

// (b2) indexedDB: false skips only indexedDB.
{
  const { calls, snapshot } = await snapshotWith({ indexedDB: false });
  assert.deepEqual(calls, [
    'localStorage',
    'sessionStorage',
    'cacheStorage',
    'serviceWorkers',
    'opfs',
    'buckets',
  ]);
  assert.deepEqual(snapshot.indexedDB, []);
  assert.deepEqual(snapshot.skipped, ['indexedDB']);
  console.log(
    'PASS pagelib granular (b2): {indexedDB:false} skips only indexedDB'
  );
}

// (c) otherStorage: false skips cacheStorage + OPFS + buckets together.
{
  const { calls, snapshot } = await snapshotWith({ otherStorage: false });
  assert.deepEqual(calls, [
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'serviceWorkers',
  ]);
  assert.deepEqual(snapshot.cacheStorage, []);
  assert.deepEqual(snapshot.opfs, { files: [], dirs: [] });
  assert.deepEqual(snapshot.buckets, { buckets: [] });
  assert.deepEqual(snapshot.skipped, ['cacheStorage', 'opfs', 'buckets']);
  console.log(
    'PASS pagelib granular (c): {otherStorage:false} skips cacheStorage+opfs+buckets'
  );
}

// (d) buildSiteReadOpts: defaults all true; explicit false passes through.
{
  const defaults = {
    fetchScript: true,
    sessionStorage: false,
    serviceWorkers: false,
    localStorage: true,
    indexedDB: true,
    otherStorage: true,
  };
  assert.deepEqual(buildSiteReadOpts(), defaults);
  assert.deepEqual(buildSiteReadOpts({}), defaults);
  assert.deepEqual(
    buildSiteReadOpts({
      fetchScript: false,
      includeSessionStorage: true,
      includeServiceWorkers: true,
      includeLocalStorage: false,
      includeIndexedDB: false,
      includeOtherStorage: false,
    }),
    {
      fetchScript: false,
      sessionStorage: true,
      serviceWorkers: true,
      localStorage: false,
      indexedDB: false,
      otherStorage: false,
    }
  );
  console.log('PASS sitedata buildSiteReadOpts: defaults + explicit flags');
}
