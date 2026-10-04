import assert from 'node:assert/strict';
import { register } from 'node:module';

// The loader under test (src/dashboard/site-scan-persist.ts) imports './store'
// (React, which cannot run directly in Node) and '@/lib/site-scan-persist' (plain JS).
// Stub './store' with a data URL that forwards getState/patchState to a local
// object through globalThis; point '@/lib/site-scan-persist' to the REAL FILE so
// the production code is exercised too.
const PERSIST_URL = new URL(
  '../../src/lib/site-scan-persist.js',
  import.meta.url
).href;
const STORE_STUB =
  'export function getState(){return globalThis.__sslTest.getState();}' +
  'export function patchState(k,p){return globalThis.__sslTest.patchState(k,p);}';
const HOOK = `
export async function resolve(specifier, context, next) {
  if (specifier === './store') {
    return { url: ${JSON.stringify(
      `data:text/javascript,${encodeURIComponent(STORE_STUB)}`
    )}, shortCircuit: true };
  }
  if (specifier === '@/lib/site-scan-persist') {
    return { url: ${JSON.stringify(PERSIST_URL)}, shortCircuit: true };
  }
  return next(specifier, context);
}`;
register(
  `data:text/javascript,${encodeURIComponent(HOOK)}`,
  import.meta.url
);

// ---- Fake chrome.storage.local (in-memory) ----
const KEY = 'bbr:last-site-scan';
let backing;
function resetChrome() {
  backing = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (k) => ({ [k]: backing[k] }),
        set: async (o) => {
          Object.assign(backing, o);
        },
        remove: async (k) => {
          delete backing[k];
        },
      },
    },
  };
}

// ---- Fake store (patchState semantics match the real store.ts) ----
function useFakeStore(siteScan) {
  const fake = {
    state: { backup: { siteScan, siteScanMeta: null } },
    patched: 0,
    getState() {
      return this.state;
    },
    patchState(k, p) {
      this.patched += 1;
      const cur = this.state[k];
      this.state[k] = typeof p === 'function' ? p(cur) : { ...cur, ...p };
    },
  };
  globalThis.__sslTest = fake;
  return fake;
}

const { loadPersistedSiteScan } = await import(
  '../../src/dashboard/site-scan-persist.ts'
);

const urlStates = [
  { origin: 'https://a.example', status: 'saved', attempts: 1, error: null },
];
const stats = {
  done: 1,
  fetched: 1,
  failed: 0,
  aborted: 0,
  total: 1,
  inGroup: 0,
  slotsUsed: 0,
  slotsTotal: 1,
  queue: 0,
  cpuPct: null,
  window: 5,
  windowMax: 5,
  tuning: null,
};

// (a) completed record + empty in-memory state -> siteScan populated, metadata correct
resetChrome();
backing[KEY] = {
  runId: 'run-a',
  startedAt: 1000,
  completedAt: 2000,
  stats,
  urlStates,
};
let fake = useFakeStore(null);
assert.equal(await loadPersistedSiteScan(), true);
assert.equal(fake.state.backup.siteScan.done, 1);
assert.deepEqual(fake.state.backup.siteScan.urlStates, urlStates);
assert.deepEqual(fake.state.backup.siteScanMeta, {
  runId: 'run-a',
  startedAt: 1000,
  completedAt: 2000,
});

// (b) in-progress record (completedAt null) -> partial data loaded, meta.completedAt null
resetChrome();
backing[KEY] = {
  runId: 'run-b',
  startedAt: 3000,
  completedAt: null,
  stats,
  urlStates,
};
fake = useFakeStore(null);
assert.equal(await loadPersistedSiteScan(), true);
assert.equal(fake.state.backup.siteScan.total, 1);
assert.deepEqual(fake.state.backup.siteScanMeta, {
  runId: 'run-b',
  startedAt: 3000,
  completedAt: null,
});

// (c) empty storage -> return false without patching
resetChrome();
fake = useFakeStore(null);
assert.equal(await loadPersistedSiteScan(), false);
assert.equal(fake.patched, 0, 'must not patch when storage is empty');
assert.equal(fake.state.backup.siteScanMeta, null);

// (d) corrupt record -> return false without patching
resetChrome();
backing[KEY] = 'not-a-record';
fake = useFakeStore(null);
assert.equal(await loadPersistedSiteScan(), false);
assert.equal(fake.patched, 0, 'must not patch when the record is corrupt');

// (e) live in-memory state already exists -> do not overwrite it, even if storage is newer
resetChrome();
backing[KEY] = {
  runId: 'run-stale',
  startedAt: 9999,
  completedAt: 9999,
  stats: { ...stats, done: 99 },
  urlStates: [],
};
const live = {
  ...stats,
  urlStates: [
    {
      origin: 'https://live.example',
      status: 'fetching',
      attempts: 1,
      error: null,
    },
  ],
};
fake = useFakeStore(live);
assert.equal(await loadPersistedSiteScan(), false);
assert.equal(fake.patched, 0, 'must not overwrite live in-memory state');
assert.equal(fake.state.backup.siteScan.urlStates[0].origin, 'https://live.example');
assert.equal(fake.state.backup.siteScanMeta, null);

// (f) null stats + empty urlStates -> siteScan stays null, but metadata is set
resetChrome();
backing[KEY] = {
  runId: 'run-f',
  startedAt: 5000,
  completedAt: null,
  stats: null,
  urlStates: [],
};
fake = useFakeStore(null);
assert.equal(await loadPersistedSiteScan(), true);
assert.equal(fake.state.backup.siteScan, null);
assert.deepEqual(fake.state.backup.siteScanMeta, {
  runId: 'run-f',
  startedAt: 5000,
  completedAt: null,
});

console.log('site-scan-loader: OK');
