import assert from 'node:assert/strict';
import { normalizeCloudConfig, normalizeBackupDestination, shouldKeepTransientRetryCopy, cancelPendingCloudRetry, getCloudRetryInfo, restoreCloudRetryAlarm, CONFIG_KEY, PENDING_KEY } from '../../src/lib/cloud.js';
import { cloudRetryDelayMs, CLOUD_RETRY_MAX_ATTEMPTS } from '../../src/lib/scheduler.js';

assert.equal(normalizeCloudConfig({}).autoRetryCloud, false, 'auto retry should default off');
assert.equal(normalizeCloudConfig({ autoRetryCloud: true }).autoRetryCloud, true, 'auto retry preference should persist');
assert.equal(normalizeCloudConfig({ schedule: { frequency: 'weekly', weekdays: [2, 6] } }).schedule.frequency, 'weekly');
assert.deepEqual(normalizeCloudConfig({ schedule: { frequency: 'weekly', weekdays: [6, 2, 2] } }).schedule.weekdays, [2, 6]);
assert.deepEqual(normalizeCloudConfig({}).schedule.weekdays, []);
assert.equal(normalizeBackupDestination('local-only'), 'local-only');
assert.equal(normalizeBackupDestination('cloud-only'), 'cloud-only');
assert.equal(normalizeBackupDestination('both'), 'both');
assert.equal(normalizeBackupDestination('unexpected'), 'cloud-only', 'unknown destinations should safely default to cloud-only');

assert.equal(shouldKeepTransientRetryCopy({ destination: 'cloud-only', autoRetryCloud: false }), false);
assert.equal(shouldKeepTransientRetryCopy({ destination: 'cloud-only', autoRetryCloud: true }), true);
assert.equal(shouldKeepTransientRetryCopy({ destination: 'both', autoRetryCloud: true }), true);
assert.equal(shouldKeepTransientRetryCopy({ destination: 'both', autoRetryCloud: false }), false);

assert.equal(cloudRetryDelayMs(1), 60_000);
assert.equal(cloudRetryDelayMs(2), 120_000);
assert.equal(cloudRetryDelayMs(3), 240_000);
assert.equal(cloudRetryDelayMs(CLOUD_RETRY_MAX_ATTEMPTS), 60_000 * 2 ** (CLOUD_RETRY_MAX_ATTEMPTS - 1));
assert.equal(cloudRetryDelayMs(CLOUD_RETRY_MAX_ATTEMPTS + 1), null, 'retry count should stop at the configured cap');
assert.equal(cloudRetryDelayMs(0), null, 'invalid retry count should not schedule');

const storageData = {
  [CONFIG_KEY]: { autoRetryCloud: true },
  [PENDING_KEY]: { id: 'backup-test', retryCount: 2, retryAt: '2026-10-01T19:00:00.000Z', retryExhausted: false }
};
const clearedAlarms = [];
const createdAlarms = [];
globalThis.chrome = {
  storage: { local: {
    async get(key) { return { [key]: storageData[key] }; },
    async set(values) { Object.assign(storageData, values); },
    async remove(key) { delete storageData[key]; }
  } },
  alarms: {
    async clear(name) { clearedAlarms.push(name); },
    async create(name, info) { createdAlarms.push({ name, info }); }
  }
};
assert.equal(await cancelPendingCloudRetry(), true, 'cancel should report a pending upload was updated');
assert.deepEqual(storageData[PENDING_KEY], {
  id: 'backup-test', retryCount: 2, retryAt: null, retryExhausted: false, retryCancelled: true
}, 'cancel should retain the artifact and retry count while clearing its next run');
assert.deepEqual(clearedAlarms, ['bbr-cloud-upload-retry']);
assert.deepEqual(await restoreCloudRetryAlarm(), { restored: false }, 'cancelled retry must stay cancelled after restart');
assert.deepEqual(createdAlarms, [], 'startup must not recreate a cancelled retry alarm');
assert.deepEqual(await getCloudRetryInfo(), {
  enabled: true,
  pending: { id: 'backup-test', retryCount: 2, retryAt: null, retryExhausted: false, retryCancelled: true }
});

console.log('PASS destination and exponential cloud retry policy');
