// E2E: scheduler integration through the REAL extension against the local
// GitHub simulator.
//
// Covers: due decision (catch-up), scheduled run executes via runIfDue,
// duplicate prevention (already-succeeded-today), disabled schedule,
// and the no-password refusal (ERR_NO_PASSWORD, never a plaintext fallback).
import assert from 'node:assert/strict';
import { launchDashboard, apiCall, must } from './launch.mjs';
import { createGitHubSimulator } from './github-simulator.mjs';

const TOKEN = 'e2e-sched-token';
const PASSWORD = 'e2e-sched-pw-1';
const collectOptions = { selectedCategories: ['bookmarks'] };

const sim = createGitHubSimulator({ owner: 'e2e', repo: 'sched-vault', isPublic: false });
await sim.start();

function baseConfig(schedule) {
  return {
    provider: 'github',
    encryption: 'enabled',
    autoRetryCloud: false,
    github: { token: TOKEN, owner: 'e2e', repo: 'sched-vault', branch: 'main', basePath: 'sched-backups', apiBaseUrl: sim.url },
    schedule,
    retention: { enabled: false }
  };
}

const { context, page, pageErrors } = await launchDashboard();
try {
  // Schedule the daily slot 60 minutes before "now" (same local day; the
  // midnight edge is handled by falling back to a fixed 00:01 slot with an
  // injected 02:00 "now").
  const realNow = Date.now();
  let schedDate = new Date(realNow - 60 * 60 * 1000);
  let now = new Date(realNow);
  if (schedDate.getDate() !== now.getDate()) {
    now = new Date(realNow); now.setHours(2, 0, 0, 0);
    schedDate = new Date(realNow); schedDate.setHours(0, 1, 0, 0);
  }
  const nowISO = now.toISOString();
  const schedHour = schedDate.getHours();
  const schedMinute = schedDate.getMinutes();
  must(
    await apiCall(page, `api.cloud.saveConfig(a.cfg)`, {
      cfg: baseConfig({ enabled: true, frequency: 'daily', hour: schedHour, minute: schedMinute })
    }),
    'cloud.saveConfig'
  );

  // ---- 1) due decision: slot passed > 2× alarm period ago → catch-up ----
  const decision = must(
    await apiCall(page, `api.scheduler.decide({ now: a.nowISO })`, { nowISO }),
    'scheduler.decide'
  );
  assert.equal(decision.due, true, 'backup should be due');
  assert.equal(decision.reason, 'catch-up', `expected catch-up, got ${decision.reason}`);

  // ---- 2) scheduled run executes ----
  const ran = must(
    await apiCall(page, `api.scheduler.runIfDue({ now: a.nowISO, password: a.password, collectOptions: a.collectOptions })`, { nowISO, password: PASSWORD, collectOptions }),
    'scheduler.runIfDue'
  );
  assert.equal(ran.ran, true, 'scheduled run should execute');
  assert.equal(ran.result.ok, true);
  assert.equal(ran.result.upload.verified, true, 'scheduled backup should upload and verify');
  const state = must(await apiCall(page, `api.scheduler.getState()`, {}), 'scheduler.getState');
  assert.equal(state.lastResult, 'success');
  assert.equal(state.lastSuccessfulBackupId, ran.result.artifactId);
  assert.ok(state.lastAttempt, 'attempt should be recorded');
  console.log('PASS scheduler E2E 1-2: catch-up decision, scheduled run executes and verifies');

  // ---- 3) duplicate prevention ----
  const again = must(
    await apiCall(page, `api.scheduler.runIfDue({ now: a.nowISO, password: a.password, collectOptions: a.collectOptions })`, { nowISO, password: PASSWORD, collectOptions }),
    'scheduler.runIfDue (duplicate)'
  );
  assert.equal(again.ran, false, 'second run must not duplicate');
  assert.equal(again.reason, 'already-succeeded-today');
  console.log('PASS scheduler E2E 3: duplicate run prevented (already-succeeded-today)');

  // ---- 4) disabled schedule → not due ----
  must(await apiCall(page, `api.scheduler.setSchedule({ enabled: false })`, {}), 'scheduler.setSchedule off');
  const disabled = must(await apiCall(page, `api.scheduler.decide({})`, {}), 'scheduler.decide disabled');
  assert.equal(disabled.due, false);
  assert.equal(disabled.reason, 'disabled');
  console.log('PASS scheduler E2E 4: disabled schedule is not due');

  // ---- 5) no-password run refuses cleanly (never a plaintext fallback) ----
  // (re-enable the schedule first — step 4 disabled it)
  must(await apiCall(page, `api.scheduler.setSchedule(a.sched)`, { sched: { enabled: true, hour: schedHour, minute: schedMinute } }), 'scheduler.setSchedule on');
  await page.evaluate(() => chrome.storage.session.remove('bbr:session-pw'));
  const tomorrowISO = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const noPw = await apiCall(
    page,
    `api.scheduler.runIfDue({ now: a.tomorrowISO, password: null, collectOptions: a.collectOptions })`,
    { tomorrowISO, collectOptions }
  );
  assert.equal(noPw.ok, false, 'passwordless scheduled run must fail');
  assert.equal(noPw.code, 'ERR_NO_PASSWORD', 'passwordless run should surface ERR_NO_PASSWORD');
  const stateAfter = must(await apiCall(page, `api.scheduler.getState()`, {}), 'scheduler.getState after no-pw');
  assert.equal(stateAfter.lastResult, 'failed', 'failed scheduled run should be recorded');
  console.log('PASS scheduler E2E 5: no-password run refused with ERR_NO_PASSWORD, recorded as failed');

  assert.deepEqual(pageErrors, [], `dashboard should run without page errors: ${pageErrors.join('; ')}`);
  console.log('PASS scheduler E2E round-trip: decision, execution, dedup, disabled, no-password refusal');
} finally {
  await context.close();
  await sim.stop();
}
