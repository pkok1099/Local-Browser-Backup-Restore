import assert from 'node:assert/strict';
import { isBackupDue, normalizeScheduleConfig } from '../../src/lib/scheduler.js';
import { buildSettingsExport, parseSettingsImport } from '../../src/lib/settings.js';

const mondayMorning = new Date(2026, 8, 28, 10, 31); // Monday
assert.equal(normalizeScheduleConfig({}).frequency, 'daily', 'legacy config remains daily');
assert.deepEqual(normalizeScheduleConfig({ frequency: 'weekly', weekdays: [5, 1, 5, 9, '2'] }).weekdays, [1, 5]);
assert.deepEqual(normalizeScheduleConfig({ frequency: 'weekly', weekdays: [] }).weekdays, [1, 2, 3, 4, 5]);
assert.deepEqual(isBackupDue({ enabled: true, frequency: 'weekly', weekdays: [1], hour: 10, minute: 0 }, {}, mondayMorning), {
  due: true, reason: 'catch-up'
});
assert.deepEqual(isBackupDue({ enabled: true, frequency: 'weekly', weekdays: [2], hour: 10, minute: 0 }, {}, mondayMorning), {
  due: false, reason: 'not-scheduled-today'
});
assert.deepEqual(isBackupDue({ enabled: true, frequency: 'weekly', weekdays: [1], hour: 11, minute: 0 }, {}, mondayMorning), {
  due: false, reason: 'before-today'
});
assert.deepEqual(isBackupDue({ enabled: true, frequency: 'weekly', weekdays: [1], hour: 10, minute: 0 }, {
  lastSuccessfulBackupAt: new Date(2026, 8, 28, 10, 10).toISOString()
}, mondayMorning), { due: false, reason: 'already-succeeded-today' });

const sourceConfig = {
  provider: 'github', encryption: 'enabled', autoRetryCloud: true,
  github: { token: 'secret-token', owner: 'owner', repo: 'backup', branch: 'main', basePath: 'vault' },
  schedule: { enabled: true, frequency: 'weekly', weekdays: [1, 5], hour: 7, minute: 30 },
  retention: { enabled: true, keepLast: 9 }
};
const exported = buildSettingsExport(sourceConfig);
assert.equal(exported.version, 1);
assert.equal(JSON.stringify(exported).includes('secret-token'), false, 'export must never contain GitHub token');
assert.deepEqual(exported.config.schedule.weekdays, [1, 5]);
const imported = parseSettingsImport(JSON.stringify(exported), { ...sourceConfig, github: { ...sourceConfig.github, token: 'destination-token' } });
assert.equal(imported.github.token, 'destination-token', 'import preserves the destination profile token');
assert.equal(imported.github.repo, 'backup');
assert.deepEqual(imported.schedule.weekdays, [1, 5]);
const injectedEndpoint = structuredClone(exported);
injectedEndpoint.config.github.apiBaseUrl = 'https://attacker.example/api';
const safeImported = parseSettingsImport(JSON.stringify(injectedEndpoint), sourceConfig);
assert.equal(safeImported.github.apiBaseUrl, 'https://api.github.com', 'unexported API endpoint fields must not redirect credential traffic');
assert.throws(() => parseSettingsImport('{"version":99,"config":{}}', sourceConfig), /Unsupported settings version/);
assert.throws(() => parseSettingsImport('{broken', sourceConfig), /valid JSON/);

console.log('PASS weekly schedule and token-safe settings transfer');
