// Service worker — deliberately minimal. All heavy backup/restore work runs in
// the dashboard page (an extension tab) so MV3 worker lifecycle cannot kill an
// operation. The worker's only job here is the SCHEDULER: keep a periodic alarm
// alive and, when a scheduled cloud backup is due (including catch-up after a
// missed slot), open the dashboard page which performs the run and records the
// scheduler state. See lib/scheduler.js for the decision logic.
import {
  isBackupDue,
  loadSchedulerState,
  isLocked,
  SCHEDULE_CHECK_ALARM,
  ALARM_PERIOD_MINUTES,
  CLOUD_RETRY_ALARM,
} from '@/lib/scheduler';
import { loadCloudConfig, beginScheduledRun, getCloudRetryInfo, restoreCloudRetryAlarm } from '@/lib/cloud';

export default defineBackground(() => {
  // Mobile browsers often render extension popups in a cramped or unreliable
  // surface. Open the full dashboard as a regular tab when the toolbar action
  // is pressed instead.
  chrome.action.onClicked.addListener(() => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });

  async function ensureAlarm() {
    await chrome.alarms.create(SCHEDULE_CHECK_ALARM, { periodInMinutes: ALARM_PERIOD_MINUTES, delayInMinutes: 0.5 });
  }

  // Evaluate the schedule; if today's backup has not succeeded yet and the
  // scheduled time has passed, open the dashboard to run it (catch-up included).
  async function checkScheduleAndRun(): Promise<{ ran: boolean; reason?: string }> {
    let cfg, state;
    try {
      cfg = await loadCloudConfig();
      state = await loadSchedulerState();
    } catch (e) {
      console.warn('schedule check: storage unavailable');
      return { ran: false, reason: 'storage-error' };
    }
    const decision = isBackupDue(cfg.schedule, state, new Date());
    if (!decision.due) return { ran: false, reason: decision.reason };
    if (isLocked(state)) return { ran: false, reason: 'locked' };

    // Never open a second scheduled-run tab.
    const open = await chrome.tabs.query({ url: `${chrome.runtime.getURL('dashboard.html')}*` });
    if (open.some((t) => (t.url || '').includes('action=cloud-scheduled'))) {
      return { ran: false, reason: 'already-open' };
    }

    await beginScheduledRun(); // lock; recordSchedulerOutcome clears it
    await chrome.tabs.create({
      url: chrome.runtime.getURL(
        `dashboard.html?action=cloud-scheduled&reason=${encodeURIComponent(decision.reason ?? 'catch-up')}`
      ),
      active: false,
    });
    return { ran: true, reason: decision.reason };
  }

  async function checkCloudRetryAndRun(): Promise<{ ran: boolean; reason?: string; retryCount?: number }> {
    let info;
    try {
      info = await getCloudRetryInfo();
    } catch {
      return { ran: false, reason: 'storage-error' };
    }
    if (!info.enabled || !info.pending || info.pending.retryExhausted || info.pending.retryCancelled) {
      return { ran: false, reason: 'disabled-or-empty' };
    }
    const retryAt = Date.parse(info.pending.retryAt || '');
    if (!Number.isFinite(retryAt) || retryAt > Date.now()) return { ran: false, reason: 'not-due' };

    const dashboardUrl = chrome.runtime.getURL('dashboard.html');
    const open = await chrome.tabs.query({ url: `${dashboardUrl}*` });
    if (open.some((tab) => (tab.url || '').includes('action=cloud-retry'))) {
      return { ran: false, reason: 'already-open' };
    }
    await chrome.tabs.create({
      url: `${dashboardUrl}?action=cloud-retry`,
      active: false,
    });
    return { ran: true, retryCount: info.pending.retryCount };
  }

  chrome.runtime.onInstalled.addListener(async (details) => {
    try {
      await chrome.storage.local.set({
        __installInfo: {
          installedAt: new Date().toISOString(),
          event: details.reason,
          version: chrome.runtime.getManifest().version,
        },
      });
    } catch (e) {
      console.warn('onInstalled: could not persist install info');
    }
    await ensureAlarm();
    await restoreCloudRetryAlarm();
    await checkScheduleAndRun(); // catch-up right after install/update
    await checkCloudRetryAndRun();
  });

  chrome.runtime.onStartup.addListener(async () => {
    await ensureAlarm();
    await restoreCloudRetryAlarm();
    await checkScheduleAndRun(); // missed-schedule catch-up on browser start
    await checkCloudRetryAndRun();
  });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === CLOUD_RETRY_ALARM) {
      await checkCloudRetryAndRun();
      return;
    }
    if (alarm.name !== SCHEDULE_CHECK_ALARM) return;
    await ensureAlarm(); // alarms can be cleared by browser restarts — re-arm defensively
    await checkScheduleAndRun();
  });

  // Message hook: the dashboard asks the worker to re-check the schedule after
  // the user edits schedule settings (so "Daily 12:00" takes effect immediately).
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'bbr:check-schedule') {
      checkScheduleAndRun()
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch(() => sendResponse({ ok: false }));
      return true; // async response
    }
    return false;
  });
});
