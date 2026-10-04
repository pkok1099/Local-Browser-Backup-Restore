import assert from 'node:assert/strict';
import { register } from 'node:module';

// backup-categories.ts imports SITE_DATA_CONFIG from '@/lib/sitedata' (a wxt
// alias plain node cannot resolve). Stub that one import with a data: URL
// loader so the category logic is tested hermetically with `node <file>`.
const STUB_SOURCE = `export const SITE_DATA_CONFIG = {
  window: { default: 5, min: 1, max: 20 },
  retry: { maxAttempts: 3, readTimeoutMs: 30000 },
  checkpointEveryOrigins: 20,
};`;
const LOADER_SOURCE = `
export async function resolve(specifier, context, next) {
  if (specifier === '@/lib/sitedata') {
    return { url: ${JSON.stringify(
      `data:text/javascript,${encodeURIComponent(STUB_SOURCE)}`
    )}, shortCircuit: true };
  }
  return next(specifier, context);
}
`;
register(
  `data:text/javascript,${encodeURIComponent(LOADER_SOURCE)}`,
  import.meta.url
);

const { BACKUP_CATEGORIES, loadBackupCategories, saveBackupCategories } =
  await import('../src/dashboard/backup-categories.ts');

// ---- Fake chrome.storage.local (in-memory) ----
let store;
let setCalls;
function resetChrome() {
  store = {};
  setCalls = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: store[key] }),
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) store[k] = v;
          setCalls.push(obj);
        },
      },
    },
  };
}
const KEY = 'bbr:backup-categories';

const ids = () => BACKUP_CATEGORIES.map((c) => c.id);

// ---- Test 1: nothing stored -> all 18 new IDs ----
resetChrome();
assert.deepEqual(await loadBackupCategories(), ids());
assert.equal(ids().length, 18, 'must be 18 granular categories');
assert.deepEqual(setCalls, [], 'default all-on must NOT persist anything');

// ---- Test 2: full legacy array (12 old IDs) -> exactly 18 new IDs ----
resetChrome();
store[KEY] = [
  'bookmarks',
  'history',
  'tabsWindows',
  'sessions',
  'cookies',
  'downloads',
  'readingList',
  'extensionStorage',
  'installedExtensions',
  'extensionPermissions',
  'profile',
  'siteData',
];
assert.deepEqual(await loadBackupCategories(), ids());

// ---- Test 3: legacy array WITHOUT siteData and cookies (user unchecked) ----
resetChrome();
store[KEY] = [
  'bookmarks',
  'history',
  'tabsWindows',
  'sessions',
  'downloads',
  'readingList',
  'extensionStorage',
  'installedExtensions',
  'extensionPermissions',
  'profile',
];
const withoutUnchecked = await loadBackupCategories();
assert.deepEqual(withoutUnchecked, [
  'bookmarks',
  'history',
  'tabs',
  'windows',
  'tabGroups',
  'sessions_tabs',
  'sessions_windows',
  'downloads',
  'readingList',
  'extensionStorage',
  'installedExtensions',
  'extensionPermissions',
  'profile',
]);
for (const sub of [
  'siteData_localStorage',
  'siteData_indexedDB',
  'siteData_otherStorage',
  'cookies_plain',
  'cookies_partitioned',
]) {
  assert.ok(!withoutUnchecked.includes(sub), `${sub} must stay unchecked`);
}

// ---- Test 3b: legacy array WITHOUT tabsWindows (user unchecked) ----
resetChrome();
store[KEY] = [
  'bookmarks',
  'history',
  'sessions',
  'cookies',
  'downloads',
  'readingList',
  'extensionStorage',
  'installedExtensions',
  'extensionPermissions',
  'profile',
  'siteData',
];
const withoutTabsWindows = await loadBackupCategories();
for (const sub of ['tabs', 'windows', 'tabGroups']) {
  assert.ok(
    !withoutTabsWindows.includes(sub),
    `${sub} must stay unchecked when legacy tabsWindows was unchecked`
  );
}
assert.ok(
  withoutTabsWindows.includes('sessions_tabs'),
  'unrelated granular ids still expand'
);

// ---- Test 4: already-granular partial array -> returned AS-IS ----
resetChrome();
store[KEY] = ['bookmarks', 'siteData_localStorage'];
assert.deepEqual(await loadBackupCategories(), [
  'bookmarks',
  'siteData_localStorage',
]);

// ---- Test 5: mixed legacy+granular -> granular respected, legacy expanded ----
resetChrome();
store[KEY] = ['siteData_localStorage', 'cookies'];
assert.deepEqual(await loadBackupCategories(), [
  'siteData_localStorage',
  'cookies_plain',
  'cookies_partitioned',
]);

// ---- Test 6: empty array (user Clear all) -> stays empty ----
resetChrome();
store[KEY] = [];
assert.deepEqual(await loadBackupCategories(), []);

// ---- Test 7: migration result is persisted via chrome.storage.local.set ----
resetChrome();
store[KEY] = ['bookmarks', 'sessions', 'cookies'];
await loadBackupCategories();
const persisted = store[KEY];
assert.ok(persisted.includes('sessions_tabs'), 'persisted: sessions_tabs');
assert.ok(
  persisted.includes('sessions_windows'),
  'persisted: sessions_windows'
);
assert.ok(persisted.includes('cookies_plain'), 'persisted: cookies_plain');
assert.ok(
  persisted.includes('cookies_partitioned'),
  'persisted: cookies_partitioned'
);
assert.ok(!persisted.includes('sessions'), 'persisted: no legacy sessions');
assert.ok(!persisted.includes('cookies'), 'persisted: no legacy cookies');
assert.equal(setCalls.length, 1, 'migration persists exactly once');

// ---- Test 8: unknown IDs are filtered out ----
resetChrome();
store[KEY] = ['bookmarks', 'nope', 'siteData', undefined, 42];
assert.deepEqual(await loadBackupCategories(), [
  'bookmarks',
  'siteData_localStorage',
  'siteData_indexedDB',
  'siteData_otherStorage',
]);

// ---- Sanity: save still filters/dedupes against new IDs ----
resetChrome();
await saveBackupCategories([
  'bookmarks',
  'bookmarks',
  'siteData_localStorage',
  'sessions',
]);
assert.deepEqual(store[KEY], ['bookmarks', 'siteData_localStorage']);

console.log('backup-categories-migration: OK');
