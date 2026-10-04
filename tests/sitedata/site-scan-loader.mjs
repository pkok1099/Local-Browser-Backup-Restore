import assert from 'node:assert/strict';
import { register } from 'node:module';

// Loader yang diuji (src/dashboard/site-scan-persist.ts) mengimpor './store'
// (React — tidak bisa jalan di node) dan '@/lib/site-scan-persist' (JS murni).
// Stub './store' via data: URL yang meneruskan getState/patchState ke objek
// lokal lewat globalThis; arahkan '@/lib/site-scan-persist' ke FILE ASLI agar
// kode produksi ikut teruji.
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

// ---- Fake store (semantik patchState disamakan dengan store.ts asli) ----
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

// (a) record completed + in-memory kosong -> siteScan terisi, meta benar
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

// (b) record in-progress (completedAt null) -> terisi partial, meta.completedAt null
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

// (c) storage kosong -> return false, tidak patch
resetChrome();
fake = useFakeStore(null);
assert.equal(await loadPersistedSiteScan(), false);
assert.equal(fake.patched, 0, 'tidak boleh patch saat storage kosong');
assert.equal(fake.state.backup.siteScanMeta, null);

// (d) record corrupt -> return false, tidak patch
resetChrome();
backing[KEY] = 'bukan-record';
fake = useFakeStore(null);
assert.equal(await loadPersistedSiteScan(), false);
assert.equal(fake.patched, 0, 'tidak boleh patch saat record corrupt');

// (e) in-memory SUDAH ada (live) -> tidak ditimpa walau storage lebih baru
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
assert.equal(fake.patched, 0, 'live in-memory tidak boleh ditimpa');
assert.equal(fake.state.backup.siteScan.urlStates[0].origin, 'https://live.example');
assert.equal(fake.state.backup.siteScanMeta, null);

// (f) stats null + urlStates kosong -> siteScan tetap null tapi meta ter-set
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
