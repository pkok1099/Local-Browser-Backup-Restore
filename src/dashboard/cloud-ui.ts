// @ts-nocheck -- Dashboard UI predates strict mode; needs dedicated refactoring pass. Tracked as tech debt.
// Cloud dashboard logic — 1:1 port of the original vanilla-JS cloud handlers
// (cloud connect/check, manual + scheduled + retry backup runs, remote list,
// restore-from-cloud, delete, settings export/import, schedule auto-save,
// init + URL action auto-start). Status strings are kept identical because the
// automated UI suite asserts on them.
import { TypedError, errMessage, errCode } from '@/lib/util';
import { getChromeVersion } from '@/lib/capabilities';
import {
  loadCloudConfig,
  saveCloudConfig,
  isConfigured,
  runCloudBackup,
  listCloudBackups,
  downloadAndValidateBackup,
  getCloudInfo,
  statusFromError,
  createProviderFromConfig,
  cancelPendingCloudRetry,
} from '@/lib/cloud';
import { CLOUD_RETRY_MAX_ATTEMPTS } from '@/lib/scheduler';
import { GitHubStorageProvider } from '@/lib/github';
import { LocalStorageProvider } from '@/lib/providers';
import { buildSettingsExport, parseSettingsImport } from '@/lib/settings';
import {
  patchState,
  setState,
  updateForm,
  appendLog,
  getState,
  withDashboardActivity,
  type CloudForm,
  type RemoteRef,
} from './store';
import {
  buildCloudBackupObject,
  saveTextFile,
  fileName,
  askPassword,
  openRestoreFlow,
  showCapabilities,
  doBackup,
} from './logic';

// ---------------- cloud status text ----------------

export const CLOUD_STATUS_TEXT: Record<string, string> = {
  'not-configured': 'Not configured',
  ready: 'Ready',
  collecting: 'Backing up (collecting)…',
  encrypting: 'Encrypting…',
  uploading: 'Uploading…',
  'upload-successful': 'Upload successful',
  'upload-failed': 'Upload failed',
  downloading: 'Downloading…',
  decrypting: 'Decrypting…',
  'restore-downloaded': 'Backup downloaded and validated',
  restoring: 'Restoring…',
  'restore-successful': 'Restore successful',
  'restore-failed': 'Restore failed',
  'auth-failed': 'Authentication failed — check the personal access token',
  'repo-not-found': 'Repository not found — check owner, name, branch and token permissions',
  'public-requires-encryption': 'Public repository requires encryption — plaintext upload was refused',
  'wrong-password': 'Wrong encryption password',
  'corrupted-backup': 'Corrupted backup',
  'unsupported-version': 'Backup uses an unsupported format or encryption version',
  'password-unavailable':
    'No encryption password available for this run — open the dashboard once to enable scheduled encrypted backups',
  'network-error': 'Network error',
};

let savedToken = ''; // kept in memory only to avoid re-typing; stored in chrome.storage.local via config

// ---------------- config <-> form ----------------

function cloudConfigFromForm() {
  const form = getState().cloud.form;
  const t = (form.time || '12:00').split(':');
  return {
    provider: form.provider,
    encryption: form.encryption,
    autoRetryCloud: form.autoRetryCloud,
    github: {
      token: form.token || savedToken || '',
      owner: form.owner.trim(),
      repo: form.repo.trim(),
      branch: form.branch.trim(),
      basePath: form.basePath.trim() || 'browser-backups',
    },
    schedule: {
      enabled: form.schedEnabled,
      frequency: form.frequency,
      weekdays: [...form.weekdays],
      hour: Number.isInteger(+t[0]) ? +t[0] : 12,
      minute: Number.isInteger(+t[1]) ? +t[1] : 0,
    },
    retention: { enabled: false, keepLast: 30 }, // disabled by default (§18); advanced setting in a later stage
  };
}

function notifyScheduleCheck() {
  try {
    chrome.runtime.sendMessage({ type: 'bbr:check-schedule' }, () => void chrome.runtime.lastError);
  } catch (e) {
    /* SW unavailable */
  }
}

// ---------------- status refresh ----------------

async function refreshCloudUI() {
  const info: any = await getCloudInfo();
  const phase = info.cloudState.phase || 'ready';
  const detail = info.cloudState.detail || '';

  const retry = {
    syncVisible: !!info.pendingUpload,
    syncLabel: 'Retry pending upload',
    status: null as string | null,
    cancelVisible: false,
  };
  if (info.pendingUpload) {
    retry.syncLabel = `Retry pending upload (${info.pendingUpload.id})`;
    const pending = info.pendingUpload;
    const count = Number.isInteger(pending.retryCount) ? pending.retryCount : 0;
    const retryAt = pending.retryAt ? new Date(pending.retryAt) : null;
    if (pending.retryExhausted) {
      retry.status = `Automatic retries exhausted (${count}/${CLOUD_RETRY_MAX_ATTEMPTS}) for ${pending.id}. The pending backup is kept for manual retry.`;
    } else if (pending.retryCancelled) {
      retry.status = `Automatic retries cancelled after ${count}/${CLOUD_RETRY_MAX_ATTEMPTS} for ${pending.id}. The pending backup is kept for manual retry.`;
    } else if (!info.config.autoRetryCloud) {
      retry.status = `Automatic retries are off for pending backup ${pending.id}. Use Retry pending upload to try now.`;
    } else if (retryAt && Number.isFinite(retryAt.getTime())) {
      retry.status = `Retry ${count}/${CLOUD_RETRY_MAX_ATTEMPTS} scheduled for ${retryAt.toLocaleString()} · pending backup ${pending.id}.`;
    } else {
      retry.status = `Pending backup ${pending.id}; no automatic retry is scheduled. Use Retry pending upload to try now.`;
    }
    retry.cancelVisible = !!(
      info.config.autoRetryCloud &&
      retryAt &&
      Number.isFinite(retryAt.getTime()) &&
      !pending.retryExhausted &&
      !pending.retryCancelled
    );
  }

  const sched = info.schedulerState || {};
  const lastSuccess = sched.lastSuccessfulBackupAt ? new Date(sched.lastSuccessfulBackupAt).toLocaleString() : 'never';
  const lastAttempt = sched.lastAttempt ? new Date(sched.lastAttempt).toLocaleString() : 'never';
  const errPart = sched.lastError ? ` — last error: [${sched.lastError.code}]` : '';
  const schedule = info.config.schedule;
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const cadence =
    schedule.frequency === 'weekly'
      ? `weekly ${schedule.weekdays.map((day: number) => weekdays[day]).join(', ')}`
      : 'daily';
  const schedState = `Schedule ${schedule.enabled ? 'ON' : 'OFF'} · ${cadence} ${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')} — last success: ${lastSuccess} (${sched.lastSuccessfulBackupId || '—'}) · last attempt: ${lastAttempt} · result: ${sched.lastResult || '—'}${errPart}`;

  patchState('cloud', (c) => ({
    ...c,
    status: CLOUD_STATUS_TEXT[phase] || phase,
    detail,
    retry,
    schedState,
  }));
}

// ---------------- connect ----------------

export async function onCloudConnect() {
  patchState('cloud', (c) => ({ ...c, repoInfo: null, repoInfoError: null }));
  try {
    const cfg = cloudConfigFromForm();
    await saveCloudConfig(cfg);
    savedToken = cfg.github.token;
    const provider = new GitHubStorageProvider({
      token: cfg.github.token,
      owner: cfg.github.owner,
      repo: cfg.github.repo,
      branch: cfg.github.branch || null,
      basePath: cfg.github.basePath,
    });
    const info = await provider.connect();
    patchState('cloud', (c) => ({
      ...c,
      repoInfo: {
        account: info.account ? info.account.login : '?',
        fullName: info.repo.fullName,
        isPublic: !info.repo.private,
        branch: info.branch,
      },
    }));
    if (!cfg.github.branch) {
      updateForm({ branch: info.branch });
      await saveCloudConfig(cloudConfigFromForm());
    }
    if (!info.repo.private) {
      // policy shown in the UI — the real enforcement lives in the storage layer
      updateForm({ encryption: 'enabled' });
    }
    appendLog(`cloud: connected to ${info.repo.fullName} (${info.repo.private ? 'private' : 'public'})`);
  } catch (e: any) {
    const st = statusFromError(e) || 'upload-failed';
    patchState('cloud', (c) => ({ ...c, repoInfoError: CLOUD_STATUS_TEXT[st] || errMessage(e) }));
    appendLog(`cloud connect failed: [${errCode(e)}] ${errMessage(e)}`);
  }
}

// ---------------- manual cloud backup ----------------

export function onCloudBackupNow(trigger = 'manual', destination: 'both' | 'cloud-only' = 'both') {
  return withDashboardActivity('cloud-backup', () => onCloudBackupNowUnlocked(trigger, destination));
}

async function onCloudBackupNowUnlocked(trigger = 'manual', destination: 'both' | 'cloud-only' = 'both') {
  patchState('cloud', (c) => ({ ...c, progress: { visible: true, frac: 0.05 } }));
  const cfg = cloudConfigFromForm();
  await saveCloudConfig(cfg);
  savedToken = cfg.github.token;
  const enc = getState().cloud.form.encryption;
  let pw: string | null = null;
  if (enc === 'enabled') {
    pw = await askPassword('new');
    if (!pw) {
      appendLog('cloud backup cancelled: no password');
      patchState('cloud', (c) => ({ ...c, progress: { visible: false, frac: 0 } }));
      return;
    }
  } else {
    const ok = confirm(
      'Upload a PLAINTEXT (unencrypted) backup?\n\nThe backup contains cookies, session tokens and site data. Anyone who gains access to the repository could read it. This is only possible for PRIVATE repositories.'
    );
    if (!ok) {
      appendLog('cloud backup cancelled: plaintext not confirmed');
      patchState('cloud', (c) => ({ ...c, progress: { visible: false, frac: 0 } }));
      return;
    }
  }
  patchState('cloud', (c) => ({ ...c, status: 'Backing up…' }));
  let localDownload: { filename: string } | null = null;
  try {
    const r = await runCloudBackup({
      collectBackup: buildCloudBackupObject,
      onProgress: (m: string) => patchState('cloud', (c) => ({ ...c, detail: m })),
      password: pw,
      useSessionPassword: true,
      plaintextAck: enc === 'disabled',
      trigger,
      destination,
      preserveLocalCopy: false,
      autoRetryCloud: cfg.autoRetryCloud,
      downloadArtifact:
        destination === 'both'
          ? async (artifact: any) => {
              const saved = await saveTextFile(
                artifact.text,
                fileName(artifact.encrypted ? 'backup.enc.json' : 'backup.json')
              );
              localDownload = saved;
              return saved;
            }
          : null,
    } as any);
    patchState('cloud', (c) => ({ ...c, progress: { ...c.progress, frac: 1 } }));
    const delivery =
      destination === 'both'
        ? r.localDownloadError
          ? `Cloud upload successful; local file download failed: ${r.localDownloadError}`
          : 'Local file and cloud upload complete.'
        : 'Cloud upload successful.';
    patchState('cloud', (c) => ({
      ...c,
      status: `${delivery} ${r.artifactId} (${((r.sizeBytes ?? 0) / 1024).toFixed(1)} KB, ${r.encrypted ? 'encrypted' : 'plaintext'})`,
    }));
    appendLog(`cloud backup finished: ${r.artifactId}`);
  } catch (e: any) {
    patchState('cloud', (c) => ({ ...c, progress: { visible: true, frac: 0 } }));
    const st = statusFromError(e) || 'upload-failed';
    const localPart = localDownload ? `Local file saved as ${(localDownload as any).filename}. ` : '';
    patchState('cloud', (c) => ({ ...c, status: `${localPart}${CLOUD_STATUS_TEXT[st] || st}` }));
    appendLog(
      `cloud backup failed: [${errCode(e)}] ${errMessage(e)}${localDownload ? ' (local file remains available)' : ''}`
    );
  }
  await refreshCloudUI();
}

// ---------------- remote list / restore / delete ----------------

export async function onCloudRestore() {
  patchState('cloud', (c) => ({ ...c, remoteList: { loading: true, error: null, refs: [] } }));
  try {
    const refs = await listCloudBackups();
    if (!refs.length) {
      patchState('cloud', (c) => ({ ...c, remoteList: { loading: false, error: null, refs: [] } }));
      return;
    }
    const list: RemoteRef[] = refs.map((r: any) => ({
      id: r.id,
      createdAt: r.createdAt || '—',
      sizeLabel: r.sizeBytes != null ? `${(r.sizeBytes / 1024).toFixed(1)} KB` : '—',
      encrypted: r.encrypted === true ? true : r.encrypted === false ? false : null,
      formatVersion: r.formatVersion || null,
    }));
    patchState('cloud', (c) => ({ ...c, remoteList: { loading: false, error: null, refs: list } }));
  } catch (e: any) {
    const st = statusFromError(e) || 'restore-failed';
    patchState('cloud', (c) => ({
      ...c,
      remoteList: { loading: false, error: CLOUD_STATUS_TEXT[st] || errMessage(e), refs: [] },
    }));
    appendLog(`cloud list failed: [${errCode(e)}] ${errMessage(e)}`);
  }
}

export function onCloudRestorePick(id: string) {
  return withDashboardActivity('restore', () => onCloudRestorePickUnlocked(id));
}

async function onCloudRestorePickUnlocked(id: string) {
  try {
    const refs = await listCloudBackups();
    const ref = refs.find((r: any) => r.id === id);
    if (!ref) throw new TypedError('ERR_NOT_FOUND', `Backup "${id}" not found remotely.`);
    let pw: string | null = null;
    if (ref.encrypted === true) {
      pw = await askPassword('existing');
      if (!pw) {
        appendLog('cloud restore cancelled: no password');
        return;
      }
    }
    patchState('cloud', (c) => ({ ...c, status: 'Downloading…' }));
    const { text } = await downloadAndValidateBackup(ref as any, { password: pw } as any);
    appendLog(`cloud: downloaded ${id}, opening restore flow`);
    await openRestoreFlow(text, pw);
  } catch (e: any) {
    const st = statusFromError(e) || 'restore-failed';
    patchState('cloud', (c) => ({ ...c, status: CLOUD_STATUS_TEXT[st] || st }));
    appendLog(`cloud download failed: [${errCode(e)}] ${errMessage(e)}`);
  }
}

export async function onCloudDeletePick(id: string) {
  if (!confirm(`Delete remote backup "${id}"? This cannot be undone.`)) return;
  try {
    const cfg = await loadCloudConfig();
    let provider;
    if (cfg.provider === 'local') {
      provider = new LocalStorageProvider();
    } else {
      provider = createProviderFromConfig(cfg);
      await provider.connect();
    }
    await provider.deleteBackup(id);
    appendLog(`cloud: deleted ${id}`);
    await onCloudRestore();
  } catch (e: any) {
    appendLog(`cloud delete failed: [${errCode(e)}] ${errMessage(e)}`);
  }
}

// ---------------- scheduled / retry runs ----------------

function runScheduledCloudBackup(reason: string) {
  return withDashboardActivity('cloud-backup', () => runScheduledCloudBackupUnlocked(reason));
}

async function runScheduledCloudBackupUnlocked(reason: string) {
  patchState('cloud', (c) => ({ ...c, progress: { visible: true, frac: 0.05 } }));
  appendLog(`scheduled cloud backup starting (${reason})`);
  patchState('cloud', (c) => ({ ...c, status: 'Backing up (scheduled)…' }));
  try {
    const cfg = await loadCloudConfig();
    const r = await runCloudBackup({
      collectBackup: buildCloudBackupObject,
      onProgress: (m: string) => patchState('cloud', (c) => ({ ...c, detail: m })),
      password: null,
      useSessionPassword: true,
      plaintextAck: cfg.encryption === 'disabled', // choice recorded at configuration time
      trigger: 'scheduled',
    } as any);
    patchState('cloud', (c) => ({
      ...c,
      progress: { ...c.progress, frac: 1 },
      status: `Scheduled backup successful — ${r.artifactId}`,
    }));
    appendLog(`scheduled backup finished: ${r.artifactId}`);
    setTimeout(() => {
      try {
        window.close();
      } catch (e) {
        /* tab stays open */
      }
    }, 1200);
  } catch (e: any) {
    const st = statusFromError(e) || 'upload-failed';
    patchState('cloud', (c) => ({ ...c, status: CLOUD_STATUS_TEXT[st] || st }));
    appendLog(`scheduled backup failed: [${errCode(e)}] ${errMessage(e)} — the tab stays open so this is visible`);
  }
  await refreshCloudUI();
}

function runAutomaticCloudRetry() {
  return withDashboardActivity('cloud-backup', runAutomaticCloudRetryUnlocked);
}

async function runAutomaticCloudRetryUnlocked() {
  patchState('cloud', (c) => ({
    ...c,
    progress: { visible: true, frac: 0.05 },
    status: 'Retrying pending cloud upload…',
  }));
  try {
    const cfg = await loadCloudConfig();
    const r = await runCloudBackup({
      collectBackup: buildCloudBackupObject,
      onProgress: (m: string) => patchState('cloud', (c) => ({ ...c, detail: m })),
      useSessionPassword: true,
      plaintextAck: cfg.encryption === 'disabled',
      trigger: 'auto-retry',
      destination: 'cloud-only',
      preserveLocalCopy: false,
      autoRetryCloud: true,
    } as any);
    patchState('cloud', (c) => ({
      ...c,
      progress: { ...c.progress, frac: 1 },
      status: `Cloud retry successful — ${r.artifactId}`,
    }));
    appendLog(`cloud retry finished: ${r.artifactId}`);
    setTimeout(() => {
      try {
        window.close();
      } catch (e) {
        /* tab stays open */
      }
    }, 1200);
  } catch (e: any) {
    const st = statusFromError(e) || 'upload-failed';
    patchState('cloud', (c) => ({ ...c, status: CLOUD_STATUS_TEXT[st] || st }));
    appendLog(`automatic cloud retry failed: [${errCode(e)}] ${errMessage(e)}`);
  }
  await refreshCloudUI();
}

export function onRetrySync() {
  return withDashboardActivity('cloud-backup', onRetrySyncUnlocked);
}

async function onRetrySyncUnlocked() {
  patchState('cloud', (c) => ({ ...c, progress: { visible: true, frac: 0.05 }, status: 'Syncing pending upload…' }));
  try {
    const cfg = await loadCloudConfig();
    const r = await runCloudBackup({
      collectBackup: buildCloudBackupObject,
      onProgress: (m: string) => patchState('cloud', (c) => ({ ...c, detail: m })),
      password: null,
      useSessionPassword: true,
      plaintextAck: cfg.encryption === 'disabled',
      trigger: 'sync-retry',
    } as any);
    patchState('cloud', (c) => ({ ...c, status: `Upload successful — ${r.artifactId}` }));
    appendLog(`pending upload synced: ${r.artifactId}`);
  } catch (e: any) {
    const st = statusFromError(e) || 'upload-failed';
    patchState('cloud', (c) => ({ ...c, status: CLOUD_STATUS_TEXT[st] || st }));
    appendLog(`pending sync failed: [${errCode(e)}] ${errMessage(e)}`);
  }
  await refreshCloudUI();
}

export async function onCancelRetry() {
  await cancelPendingCloudRetry();
  appendLog('automatic retry cancelled; pending artifact remains available for manual sync');
  await refreshCloudUI();
}

// ---------------- settings transfer ----------------

export async function exportSettingsFile() {
  try {
    const config = await loadCloudConfig();
    const file = buildSettingsExport(config);
    const name = `browser-backup-settings-${new Date().toISOString().slice(0, 10)}.json`;
    await saveTextFile(JSON.stringify(file, null, 2), name);
    patchState('cloud', (c) => ({ ...c, settingsStatus: 'Settings exported. The GitHub token is not included.' }));
  } catch (e: any) {
    patchState('cloud', (c) => ({ ...c, settingsStatus: `Settings export failed: ${errMessage(e)}` }));
  }
}

export async function importSettingsFile(file: File | null) {
  if (!file) return;
  try {
    const current = await loadCloudConfig();
    const imported = parseSettingsImport(await file.text(), current);
    await saveCloudConfig(imported);
    savedToken = imported.github.token;
    await loadCloudConfigIntoUI();
    notifyScheduleCheck();
    patchState('cloud', (c) => ({
      ...c,
      settingsStatus: 'Settings imported. The existing GitHub token was preserved.',
    }));
  } catch (e: any) {
    patchState('cloud', (c) => ({ ...c, settingsStatus: `Settings import failed: ${errMessage(e)}` }));
  } finally {
    patchState('cloud', (c) => ({ ...c, settingsImportKey: c.settingsImportKey + 1 }));
  }
}

// ---------------- save + schedule ----------------

export async function saveCloudSettings() {
  const cfg = cloudConfigFromForm();
  await saveCloudConfig(cfg);
  savedToken = cfg.github.token;
  updateForm({ token: '' });
  appendLog('cloud settings saved');
  notifyScheduleCheck();
  await refreshCloudUI();
}

// Weekly default: Mon–Fri when switching to weekly with no day selected
// (spec: "Missing, invalid, or empty weekly day selections normalize safely
// to Monday-Friday"). Persist + re-check on every schedule edit.
export async function onScheduleFieldChange(patch: Partial<CloudForm>) {
  updateForm(patch);
  const form = getState().cloud.form;
  if (form.frequency === 'weekly' && form.weekdays.length === 0) {
    updateForm({ weekdays: [1, 2, 3, 4, 5] });
  }
  await saveCloudConfig(cloudConfigFromForm());
  notifyScheduleCheck();
  await refreshCloudUI();
}

export async function onAutoRetryChange(autoRetryCloud: boolean) {
  updateForm({ autoRetryCloud });
  await saveCloudConfig(cloudConfigFromForm());
  await refreshCloudUI();
}

// ---------------- boot ----------------

async function loadCloudConfigIntoUI() {
  const cfg: any = await loadCloudConfig();
  updateForm({
    provider: cfg.provider,
    owner: cfg.github.owner,
    repo: cfg.github.repo,
    branch: cfg.github.branch,
    basePath: cfg.github.basePath,
    encryption: cfg.encryption,
    schedEnabled: cfg.schedule.enabled,
    frequency: cfg.schedule.frequency,
    weekdays: [...cfg.schedule.weekdays],
    time: `${String(cfg.schedule.hour).padStart(2, '0')}:${String(cfg.schedule.minute).padStart(2, '0')}`,
    autoRetryCloud: cfg.autoRetryCloud,
  });
  savedToken = cfg.github.token; // kept in page memory only; the input stays empty
  await refreshCloudUI();
}

async function autoStart() {
  const params = new URLSearchParams(location.search);
  const action = params.get('action');
  if (!action) return;
  if (action === 'backup') {
    appendLog('action: backup everything');
    await doBackup({ encrypt: false });
  } else if (action === 'backup-encrypted') {
    appendLog('action: backup encrypted');
    const pw = await askPassword('new');
    if (pw) await doBackup({ encrypt: true, password: pw });
    else appendLog('encrypted backup cancelled');
  } else if (action === 'restore') {
    patchState('restore', (r) => ({ ...r, sectionVisible: true }));
  } else if (action === 'cloud-scheduled') {
    await runScheduledCloudBackup(params.get('reason') || 'catch-up');
  } else if (action === 'cloud-retry') {
    await runAutomaticCloudRetry();
  } else if (action === 'capabilities') {
    await showCapabilities();
  }
}

let initStarted = false;

export async function init() {
  if (initStarted) return; // React 18/19 dev remounts must not double-run actions
  initStarted = true;
  setState((s) => ({
    ...s,
    subline: `Chromium ${getChromeVersion()} · extension v${chrome.runtime.getManifest().version} · local by default — cloud upload only if you enable it`,
  }));
  await loadCloudConfigIntoUI();
  await autoStart();
}
