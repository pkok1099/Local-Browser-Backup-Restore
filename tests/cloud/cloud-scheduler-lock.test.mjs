// Test (T3-M2): runCloudBackup must record the scheduler outcome (which also
// releases the cross-context running lock) on EVERY failure path — not just
// the ones with their own catch. A collect/encrypt/store crash must not leave
// the scheduler lock stuck for ~30 minutes.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  CONFIG_KEY,
  beginScheduledRun,
  runCloudBackup,
} from '../../src/lib/cloud.js';
import { loadSchedulerState } from '../../src/lib/scheduler.js';

globalThis.crypto ??= webcrypto;
const storage = new Map([
  [
    CONFIG_KEY,
    { provider: 'local', encryption: 'disabled', autoRetryCloud: false },
  ],
]);
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return storage.has(key)
          ? { [key]: structuredClone(storage.get(key)) }
          : {};
      },
      async set(values) {
        for (const [key, value] of Object.entries(values))
          storage.set(key, structuredClone(value));
      },
      async remove(key) {
        storage.delete(key);
      },
    },
  },
  alarms: {
    async clear() {
      return true;
    },
  },
};

const schedState = async () => (await loadSchedulerState()) || {};

// Take the lock the way the background scheduler does, then crash mid-run.
await beginScheduledRun();
assert.equal(
  (await schedState()).running,
  true,
  'precondition: the lock is held'
);

await assert.rejects(
  runCloudBackup({
    trigger: 'scheduled',
    plaintextAck: true,
    collectBackup: async () => {
      throw new Error('collection exploded');
    },
  }),
  /collection exploded/,
  'the original error must still propagate'
);

const after = await schedState();
assert.equal(
  after.running,
  false,
  'the running lock must be released after a mid-run crash'
);
assert.equal(after.lastResult, 'failed', 'the failed outcome must be recorded');
assert.match(
  after.lastError.message,
  /collection exploded/,
  'the recorded error must be the real one'
);

console.log(
  'PASS runCloudBackup releases the scheduler lock and records the outcome on every failure path'
);
