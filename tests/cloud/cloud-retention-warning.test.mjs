// Test (T3-M1): a retention failure AFTER a verified upload must not fail the
// backup. The upload is already safe on the remote; retention becomes a
// warning, the outcome is recorded as success, and no duplicate backup is
// scheduled.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { uploadRemoteArtifact } from '../../src/lib/cloud.js';

globalThis.crypto ??= webcrypto;
const events = [];
const storage = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        events.push(`storage:get:${String(key)}`);
        return storage.has(key)
          ? { [key]: structuredClone(storage.get(key)) }
          : {};
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) {
          events.push(`storage:set:${key}`);
          storage.set(key, structuredClone(value));
        }
      },
      async remove(key) {
        events.push(`storage:remove:${String(key)}`);
        storage.delete(key);
      },
    },
  },
};

const oldBackups = Array.from({ length: 31 }, (_, i) => ({
  id: `old-${i}`,
  createdAt: '2020-01-01T00:00:00.000Z',
}));
const provider = {
  async uploadBackup() {
    events.push('upload');
    return { sha256Hex: 'ab'.repeat(32), verified: true };
  },
  async readManifest() {
    return { manifest: { backups: [...oldBackups] } };
  },
  async writeManifest(m) {
    events.push(`writeManifest:${m.backups.length}`);
  },
  async deleteBackup(b) {
    events.push(`delete:${b.id}`);
    throw new Error('retention boom');
  },
};
const artifact = {
  id: 'new-1',
  createdAt: new Date().toISOString(),
  encrypted: false,
  sha256Hex: 'ab'.repeat(32),
  sizeBytes: 10,
};
const logs = [];
const result = await uploadRemoteArtifact({
  cfg: { provider: 'github', retention: { enabled: true, keepLast: 30 } },
  provider,
  artifact,
  keepLocalArtifact: false,
  transientRetryCopy: false,
  retryEnabled: false,
  plaintextAllowed: true,
  trigger: 'manual',
  localDownload: null,
  localDownloadError: null,
  log: (m) => logs.push(m),
});

assert.equal(result.ok, true, 'upload must still succeed when retention fails');
assert.ok(
  logs.some((m) => m.includes('retention') && m.includes('retention boom')),
  'retention failure must surface as a warning in the log, got: ' +
    JSON.stringify(logs)
);
assert.ok(
  !events.some((e) => e.startsWith('storage:set:bbr:cloud-retry')),
  'no retry must be scheduled for a retention-only failure, events: ' +
    JSON.stringify(events)
);

console.log(
  'PASS retention failure after a verified upload is a warning, not a failed backup'
);
