// Tests for the lazy site-scan persistence module (Results/Failures): throttling,
// record shaping, and best-effort reads/writes to chrome.storage.local via injected storage.
//
// Standalone Node script: `node tests/sitedata/site-scan-persist.mjs`; failures use a non-zero exit code.
import { strict as assert } from 'node:assert/strict';
import {
  SITE_SCAN_STORAGE_KEY,
  SITE_SCAN_PERSIST_THROTTLE_MS,
  newSiteScanRunId,
  shouldPersistSiteScan,
  buildSiteScanRecord,
  writeSiteScanRecord,
  readSiteScanRecord,
  clearSiteScanRecord,
} from '../../src/lib/site-scan-persist.js';

let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed += 1;
};

// --- konstanta -------------------------------------------------------------
ok(
  SITE_SCAN_STORAGE_KEY === 'bbr:last-site-scan',
  'storage key matches the contract'
);
ok(SITE_SCAN_PERSIST_THROTTLE_MS === 5000, 'default throttle 5000ms');

// --- newSiteScanRunId ------------------------------------------------------
{
  const a = newSiteScanRunId();
  const b = newSiteScanRunId();
  ok(typeof a === 'string' && a.length > 0, 'runId is a non-empty string');
  ok(a !== b, 'runId is unique across calls');
}

// --- shouldPersistSiteScan --------------------------------------------------
ok(shouldPersistSiteScan(0, 0) === false, 'throttle: diff 0 -> false');
ok(
  shouldPersistSiteScan(1000, 5999) === false,
  'throttle: diff 4999 -> false'
);
ok(shouldPersistSiteScan(1000, 6000) === true, 'throttle: diff 5000 -> true');
ok(
  shouldPersistSiteScan(1000, 10000) === true,
  'throttle: diff > interval -> true'
);
ok(
  shouldPersistSiteScan(0, 4999) === false,
  'throttle: lastWriteMs=0 means no prior write; diff 4999 -> false'
);
ok(
  shouldPersistSiteScan(0, 5000) === true,
  'throttle: lastWriteMs=0, diff 5000 -> true'
);
ok(
  shouldPersistSiteScan(-1000, 3000) === false,
  'throttle: lastWriteMs negatif, diff 4000 -> false'
);
ok(
  shouldPersistSiteScan(-1000, 4000) === true,
  'throttle: lastWriteMs negatif, diff 5000 -> true'
);
ok(
  shouldPersistSiteScan(0, 999, 1000) === false,
  'throttle: interval custom 1000, diff 999 -> false'
);
ok(
  shouldPersistSiteScan(0, 1000, 1000) === true,
  'throttle: interval custom 1000, diff 1000 -> true'
);
ok(
  shouldPersistSiteScan(5000, 4000, 1000) === false,
  'throttle: clock moved backward (negative diff < interval) -> false'
);

// --- buildSiteScanRecord -----------------------------------------------------
{
  const rec = buildSiteScanRecord({
    runId: 'r-1',
    startedAt: 100,
    completedAt: 200,
    siteScan: null,
  });
  assert.deepStrictEqual(
    rec,
    { runId: 'r-1', startedAt: 100, completedAt: 200, stats: null, urlStates: [] },
    'siteScan null -> stats null + urlStates []'
  );
  passed += 1;
}
{
  const urlStates = [{ url: 'https://a.id/', status: 'ok' }];
  const siteScan = { total: 2, failed: 1, note: 'x', urlStates };
  const rec = buildSiteScanRecord({
    runId: 'r-2',
    startedAt: 1,
    completedAt: 2,
    siteScan,
  });
  assert.deepStrictEqual(rec.stats, { total: 2, failed: 1, note: 'x' });
  passed += 1;
  assert.deepStrictEqual(rec.urlStates, urlStates);
  passed += 1;
  ok(!('urlStates' in rec.stats), 'stats do not include urlStates');
  // input is not mutated
  assert.deepStrictEqual(siteScan, {
    total: 2,
    failed: 1,
    note: 'x',
    urlStates,
  });
  passed += 1;
}
{
  const rec = buildSiteScanRecord({
    runId: 'r-3',
    startedAt: 0,
    completedAt: 0,
    siteScan: { total: 0 },
  });
  assert.deepStrictEqual(rec.urlStates, []);
  passed += 1;
  assert.deepStrictEqual(rec.stats, { total: 0 });
  passed += 1;
}

// --- fake storage in-memory --------------------------------------------------
const makeStorage = () => {
  const data = {};
  return {
    get(key) {
      return Promise.resolve({ [key]: data[key] });
    },
    set(obj) {
      Object.assign(data, obj);
      return Promise.resolve();
    },
    remove(key) {
      delete data[key];
      return Promise.resolve();
    },
    _data: data,
  };
};

// --- round-trip write -> read ------------------------------------------------
{
  const storage = makeStorage();
  const record = buildSiteScanRecord({
    runId: 'r-rt',
    startedAt: 10,
    completedAt: 20,
    siteScan: {
      total: 1,
      failed: 0,
      urlStates: [{ url: 'https://b.id/', status: 'ok' }],
    },
  });
  ok((await writeSiteScanRecord(storage, record)) === true, 'write -> true');
  const back = await readSiteScanRecord(storage);
  assert.deepStrictEqual(back, record, 'round-trip write->read identik');
  passed += 1;
}

// --- read corrupt -> null ----------------------------------------------------
for (const [label, stored] of [
  ['missing', undefined],
  ['null', null],
  ['bukan object', 'corrupt'],
  ['array', []],
  ['runId bukan string', { runId: 123, urlStates: [] }],
  ['runId hilang', { urlStates: [] }],
  ['urlStates bukan array', { runId: 'r', urlStates: 'x' }],
  ['urlStates hilang', { runId: 'r' }],
]) {
  const storage = {
    get(key) {
      return Promise.resolve({ [key]: stored });
    },
  };
  ok(
    (await readSiteScanRecord(storage)) === null,
    `read corrupt (${label}) -> null`
  );
}

// --- null storage does not throw ----------------------------------------------
ok((await writeSiteScanRecord(null, {})) === false, 'write null -> false');
ok((await readSiteScanRecord(null)) === null, 'read null -> null');
ok((await clearSiteScanRecord(null)) === false, 'clear null -> false');

// --- clear removes the record --------------------------------------------------
{
  const storage = makeStorage();
  const record = buildSiteScanRecord({
    runId: 'r-cl',
    startedAt: 0,
    completedAt: 1,
    siteScan: { total: 0, urlStates: [] },
  });
  ok((await writeSiteScanRecord(storage, record)) === true, 'write before clear');
  ok((await clearSiteScanRecord(storage)) === true, 'clear -> true');
  ok((await readSiteScanRecord(storage)) === null, 'read after clear -> null');
}

// --- throwing storage returns false/null without throwing --------------------
{
  const bad = {
    get() {
      return Promise.reject(new Error('boom-get'));
    },
    set() {
      return Promise.reject(new Error('boom-set'));
    },
    remove() {
      return Promise.reject(new Error('boom-remove'));
    },
  };
  ok((await writeSiteScanRecord(bad, {})) === false, 'write throw -> false');
  ok((await readSiteScanRecord(bad)) === null, 'read throw -> null');
  ok((await clearSiteScanRecord(bad)) === false, 'clear throw -> false');
}

console.log(`site-scan-persist: ${passed} asersi PASS`);
