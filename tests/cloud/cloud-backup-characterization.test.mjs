import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { CONFIG_KEY, PENDING_KEY, runCloudBackup } from '../../src/lib/cloud.js';
import { finalizeIntegrity } from '../../src/lib/format.js';

globalThis.crypto ??= webcrypto;
const events = [];
const storage = new Map([[CONFIG_KEY, { provider: 'local', encryption: 'disabled', autoRetryCloud: false }]]);
const keyName = (key) => String(key);
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        events.push(`storage:get:${keyName(key)}`);
        return storage.has(key) ? { [key]: structuredClone(storage.get(key)) } : {};
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) {
          events.push(`storage:set:${key}:${value?.phase ?? ''}`);
          storage.set(key, structuredClone(value));
        }
      },
      async remove(key) {
        events.push(`storage:remove:${keyName(key)}`);
        storage.delete(key);
      },
    },
  },
  alarms: {
    async clear(name) { events.push(`alarm:clear:${name}`); return true; },
  },
};

const collectOptions = { selectedCategories: ['bookmarks'], marker: 'characterization-input' };
const backup = {
  format: 'chrome-local-backup',
  formatVersion: 2,
  createdAt: '2026-10-02T00:00:00.000Z',
  generator: { name: 'characterization-test' },
  capabilities: { bookmarks: { canBackup: true, canRestore: 'full' } },
  counts: { bookmarks: 1 },
  data: { bookmarks: { roots: { bookmark_bar: { children: [{ title: 'fixture' }] } } } },
};
await finalizeIntegrity(backup);
const result = await runCloudBackup({
  collectOptions,
  plaintextAck: true,
  trigger: 'characterization',
  onProgress: (message) => events.push(`progress:${message}`),
  collectBackup: async (onProgress, options) => {
    events.push('collect:start');
    assert.strictEqual(options, collectOptions, 'collection options pass through unchanged');
    onProgress('collection fixture ready');
    events.push('collect:complete');
    return backup;
  },
  downloadArtifact: async (artifact) => {
    events.push(`download:${artifact.id}`);
    throw new Error('disk full');
  },
});

assert.equal(result.ok, true);
assert.equal(result.encrypted, false);
assert.equal(result.synced, false);
assert.equal(result.localDownload, undefined, 'the local-provider result currently omits optional-copy fields');
assert.equal(result.localDownloadError, undefined, 'the local-provider result currently omits optional-copy fields');
assert.equal(storage.has(PENDING_KEY), false, 'local-provider completion clears stale pending uploads');
assert.ok([...storage.keys()].some((key) => key.startsWith('bbr:artifact:')), 'the durable artifact is stored locally');
assert.ok(events.includes('progress:local download failed: disk full'), 'the failed optional copy is reported');

const index = (predicate) => events.findIndex(predicate);
const collect = index((event) => event === 'collect:complete');
const download = index((event) => event.startsWith('download:'));
const artifactWrite = index((event) => event.startsWith('storage:set:bbr:artifact:'));
const manifestWrite = index((event) => event === 'storage:set:bbr:local-manifest:');
const verificationRead = index((event) => event.startsWith('storage:get:bbr:artifact:'));
const successPhase = index((event) => event === 'storage:set:bbr:cloud-state:upload-successful');
assert.ok(collect >= 0 && collect < download, 'collection precedes the user-facing copy step');
assert.ok(download < artifactWrite, 'the optional local download is attempted before the durable provider write');
assert.ok(artifactWrite < manifestWrite && manifestWrite < verificationRead, 'provider writes artifact, updates manifest, then verifies the stored bytes');
assert.ok(verificationRead < successPhase, 'success is recorded only after local verification');

const invalidBackup = structuredClone(backup);
invalidBackup.counts.bookmarks = 2;
events.length = 0;
await assert.rejects(
  runCloudBackup({
    collectOptions,
    plaintextAck: true,
    trigger: 'characterization-invalid',
    collectBackup: async () => invalidBackup,
    downloadArtifact: async () => events.push('download:invalid'),
  }),
  (error) => error.code === 'ERR_CHECKSUM_MISMATCH'
);
assert.equal(events.some((event) => event.startsWith('download:')), false, 'invalid artifacts are rejected before the optional download callback');
assert.equal(events.some((event) => event.startsWith('storage:set:bbr:artifact:')), false, 'invalid artifacts are rejected before the durable artifact write');
assert.equal(events.includes('storage:set:bbr:local-manifest:'), false, 'invalid artifacts are rejected before the manifest write');
console.log('PASS runCloudBackup characterization: input passthrough, output, optional-copy failure, and durable side-effect order');
