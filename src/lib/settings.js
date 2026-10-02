import { normalizeCloudConfig } from './cloud.js';

const SETTINGS_FORMAT = 'browser-backup-settings';
const SETTINGS_VERSION = 1;

export function buildSettingsExport(rawConfig) {
  const cfg = normalizeCloudConfig(rawConfig);
  return {
    format: SETTINGS_FORMAT,
    version: SETTINGS_VERSION,
    exportedAt: new Date().toISOString(),
    config: {
      provider: cfg.provider,
      encryption: cfg.encryption,
      autoRetryCloud: cfg.autoRetryCloud,
      github: {
        owner: cfg.github.owner,
        repo: cfg.github.repo,
        branch: cfg.github.branch,
        basePath: cfg.github.basePath,
      },
      schedule: cfg.schedule,
      retention: cfg.retention,
    },
  };
}

// eslint-disable-next-line complexity -- TECH DEBT: complexity 27, refactoring risks behavior change
function validateSettingsConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Settings config must be an object.');
  if (!['github', 'local'].includes(value.provider)) throw new Error('Settings provider is invalid.');
  if (!['enabled', 'disabled'].includes(value.encryption))
    throw new Error('Settings encryption preference is invalid.');
  if (typeof value.autoRetryCloud !== 'boolean') throw new Error('Settings retry preference is invalid.');
  const gh = value.github;
  if (
    !gh ||
    typeof gh !== 'object' ||
    ['owner', 'repo', 'branch', 'basePath'].some((key) => typeof gh[key] !== 'string')
  ) {
    throw new Error('Settings repository fields are invalid.');
  }
  const schedule = value.schedule;
  if (
    !schedule ||
    typeof schedule !== 'object' ||
    typeof schedule.enabled !== 'boolean' ||
    !['daily', 'weekly'].includes(schedule.frequency) ||
    !Number.isInteger(schedule.hour) ||
    schedule.hour < 0 ||
    schedule.hour > 23 ||
    !Number.isInteger(schedule.minute) ||
    schedule.minute < 0 ||
    schedule.minute > 59 ||
    !Array.isArray(schedule.weekdays) ||
    schedule.weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    throw new Error('Settings schedule is invalid.');
  }
  const retention = value.retention;
  if (
    !retention ||
    typeof retention !== 'object' ||
    typeof retention.enabled !== 'boolean' ||
    !Number.isInteger(retention.keepLast) ||
    retention.keepLast < 2
  ) {
    throw new Error('Settings retention is invalid.');
  }
}

export function parseSettingsImport(text, currentConfig) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error('Settings file must contain valid JSON.');
  }
  if (!file || file.format !== SETTINGS_FORMAT || file.version !== SETTINGS_VERSION) {
    throw new Error(`Unsupported settings version (expected ${SETTINGS_FORMAT} v${SETTINGS_VERSION}).`);
  }
  validateSettingsConfig(file.config);
  const current = normalizeCloudConfig(currentConfig);
  return normalizeCloudConfig({
    ...file.config,
    github: {
      owner: file.config.github.owner,
      repo: file.config.github.repo,
      branch: file.config.github.branch,
      basePath: file.config.github.basePath,
      token: current.github.token,
    },
  });
}
