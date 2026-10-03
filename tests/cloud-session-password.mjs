// Test (T3-M3): the session password must only be kept for unattended runs
// (scheduled/auto-retry) or when the user explicitly opts in — not on every
// manual encrypted backup.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { CONFIG_KEY, runCloudBackup } from '../src/lib/cloud.js';
import { finalizeIntegrity } from '../src/lib/format.js';

globalThis.crypto ??= webcrypto;
const storage = new Map([
  [
    CONFIG_KEY,
    { provider: 'local', encryption: 'enabled', autoRetryCloud: false },
  ],
]);
const sessionStorage = new Map();
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
    session: {
      async get(key) {
        return sessionStorage.has(key)
          ? { [key]: structuredClone(sessionStorage.get(key)) }
          : {};
      },
      async set(values) {
        for (const [key, value] of Object.entries(values))
          sessionStorage.set(key, structuredClone(value));
      },
      async remove(key) {
        sessionStorage.delete(key);
      },
    },
  },
  alarms: {
    async clear() {
      return true;
    },
  },
};

const backup = {
  format: 'chrome-local-backup',
  formatVersion: 2,
  createdAt: '2026-10-02T00:00:00.000Z',
  generator: { name: 'session-password-test' },
  capabilities: { bookmarks: { canBackup: true, canRestore: 'full' } },
  counts: { bookmarks: 1 },
  data: { bookmarks: { roots: {} } },
};
await finalizeIntegrity(backup);

const baseArgs = {
  collectOptions: { selectedCategories: ['bookmarks'] },
  plaintextAck: false,
  password: 's3cret',
  onProgress: () => {},
  collectBackup: async () => backup,
};

// 1. Manual run, no opt-in: password must NOT be kept in session storage.
await runCloudBackup({ ...baseArgs, trigger: 'manual' });
assert.equal(
  sessionStorage.size,
  0,
  'manual run without opt-in must not keep the session password'
);

// 2. Manual run WITH explicit opt-in: password is kept.
await runCloudBackup({
  ...baseArgs,
  trigger: 'manual',
  rememberPassword: true,
});
assert.ok(
  sessionStorage.size > 0,
  'manual run with rememberPassword:true must keep the session password'
);
sessionStorage.clear();

// 3. Scheduled run WITH opt-in: password is kept, so the next scheduled run
// can encrypt without prompting. Without opt-in it is not kept.
await runCloudBackup({
  ...baseArgs,
  trigger: 'scheduled',
  rememberPassword: true,
});
assert.ok(
  sessionStorage.size > 0,
  'scheduled run with opt-in must keep the session password'
);
sessionStorage.clear();
await runCloudBackup({ ...baseArgs, trigger: 'scheduled' });
assert.equal(
  sessionStorage.size,
  0,
  'scheduled run without opt-in must not keep the session password'
);

console.log(
  'PASS session password is only kept for unattended runs or explicit opt-in'
);
