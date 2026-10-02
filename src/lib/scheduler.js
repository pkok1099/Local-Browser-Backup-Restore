// Automatic backup scheduler.
//
// Split design:
//  - PURE decision functions (no chrome.* API) — unit-testable in Node.
//  - chrome.storage-backed config/state helpers for the extension runtime.
//
// The scheduler must not assume that any extension process is continuously
// alive: the service worker creates a periodic chrome.alarms check; catch-up
// happens on browser startup / alarm wake. "Due" is derived from the last
// SUCCESSFUL backup (not the last attempt) so a failure retries (with backoff)
// but a success never duplicates.

export const SCHEDULE_CHECK_ALARM = 'bbr-schedule-check';
export const CLOUD_RETRY_ALARM = 'bbr-cloud-upload-retry';
export const ALARM_PERIOD_MINUTES = 15;
const CLOUD_RETRY_BASE_MS = 60 * 1000;
export const CLOUD_RETRY_MAX_ATTEMPTS = 8;

export function cloudRetryDelayMs(retryCount) {
  if (!Number.isInteger(retryCount) || retryCount < 1 || retryCount > CLOUD_RETRY_MAX_ATTEMPTS) return null;
  return CLOUD_RETRY_BASE_MS * 2 ** (retryCount - 1);
}

// After a failed attempt, wait this long before retrying (prevents hammering
// while the browser is open all day with a broken config).
const RETRY_BACKOFF_MS = 10 * 60 * 1000;

export function normalizeScheduleConfig(raw) {
  const c = raw || {};
  const hour = Number.isInteger(c.hour) ? Math.min(23, Math.max(0, c.hour)) : 12;
  const minute = Number.isInteger(c.minute) ? Math.min(59, Math.max(0, c.minute)) : 0;
  const frequency = c.frequency === 'weekly' ? 'weekly' : 'daily';
  const weekdays = [
    ...new Set(
      (Array.isArray(c.weekdays) ? c.weekdays : []).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    ),
  ].sort((a, b) => a - b);
  return {
    enabled: !!c.enabled,
    frequency,
    weekdays: frequency === 'weekly' ? (weekdays.length ? weekdays : [1, 2, 3, 4, 5]) : [],
    hour,
    minute,
  };
}

// The Date of today's scheduled time, in local time.
function scheduledTimeToday(hour, minute, now) {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  return d;
}

// config:  normalized schedule config
// state:   { lastAttempt, lastSuccessfulBackupAt, ... } (ISO strings or null)
// now:     Date
// Returns { due, reason } — reason ∈ disabled | not-scheduled-today | before-today |
//                            already-succeeded-today | retry-backoff | scheduled-due | catch-up
export function isBackupDue(config, state, now) {
  const cfg = normalizeScheduleConfig(config);
  if (!cfg.enabled) return { due: false, reason: 'disabled' };

  const scheduledToday = scheduledTimeToday(cfg.hour, cfg.minute, now);
  if (cfg.frequency === 'weekly' && !cfg.weekdays.includes(now.getDay())) {
    return { due: false, reason: 'not-scheduled-today' };
  }
  if (now < scheduledToday) return { due: false, reason: 'before-today' };

  const lastSuccess = state && state.lastSuccessfulBackupAt ? new Date(state.lastSuccessfulBackupAt) : null;
  if (lastSuccess && !isNaN(lastSuccess) && lastSuccess >= scheduledToday) {
    return { due: false, reason: 'already-succeeded-today' };
  }

  const lastAttempt = state && state.lastAttempt ? new Date(state.lastAttempt) : null;
  if (lastAttempt && !isNaN(lastAttempt) && lastAttempt >= scheduledToday && now - lastAttempt < RETRY_BACKOFF_MS) {
    return { due: false, reason: 'retry-backoff' };
  }

  // A run more than 2×ALARM_PERIOD past the scheduled time is a catch-up run.
  const isCatchUp = now.getTime() - scheduledToday.getTime() > 2 * ALARM_PERIOD_MINUTES * 60 * 1000;
  return { due: true, reason: isCatchUp ? 'catch-up' : 'scheduled-due' };
}

// ---------------- chrome.storage-backed helpers ----------------

const SCHEDULER_STATE_KEY = 'bbr:scheduler-state';

function emptySchedulerState() {
  return {
    lastAttempt: null,
    lastAttemptTrigger: null,
    lastSuccessfulBackupAt: null,
    lastSuccessfulBackupId: null,
    lastResult: null, // 'success' | 'failed' | 'skipped'
    lastError: null, // { code, message } — never contains secrets
    running: false,
    runningSince: null,
  };
}

export async function loadSchedulerState() {
  const o = await chrome.storage.local.get(SCHEDULER_STATE_KEY);
  return o[SCHEDULER_STATE_KEY] || emptySchedulerState();
}

export async function saveSchedulerState(state) {
  await chrome.storage.local.set({ [SCHEDULER_STATE_KEY]: state });
  return state;
}

// Simple cross-context lock so two dashboards/SW checks do not double-collect.
export function isLocked(state) {
  if (!state.running || !state.runningSince) return false;
  const since = new Date(state.runningSince);
  if (isNaN(since)) return false;
  return Date.now() - since.getTime() < 30 * 60 * 1000; // stale locks expire after 30 min
}
