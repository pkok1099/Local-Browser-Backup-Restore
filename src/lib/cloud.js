// Cloud backup orchestrator.
//
// Pipeline (stage spec):
//   Browser Data → Backup Engine → Versioned Backup Artifact → [Encryption] →
//   StorageProvider (upload → VERIFY REMOTE OBJECT → manifest update)
//
// Failure semantics (§17):
//   - The LOCAL durable copy is written BEFORE any remote upload. A cloud
//     failure never destroys a successful local backup.
//   - A failed upload records a "pending upload" marker; the next run RE-SYNCS
//     the same artifact instead of re-collecting identical browser data.
//
// Encryption policy (§5, enforced in code, below the UI):
//   public  repo -> encryption REQUIRED (plaintext upload rejected by the provider)
//   private repo -> user choice; plaintext only with an explicit ack
//
// Password handling (§6/§7):
//   - Never stored on disk, never sent to GitHub, never logged.
//   - For scheduled runs the user MAY keep the password in chrome.storage.session
//     (memory-only, cleared when the browser closes) — see keepSessionPassword().

import { TypedError, errCode } from './util.js';
import { encryptBackup } from './crypto.js';
import { validateBackupFile } from './validate.js';
import {
  makeRemoteArtifact,
  manifestEntryFromArtifact,
  newRemoteManifest,
  upsertManifestEntry,
  normalizeManifest,
} from './artifact.js';
import { LocalStorageProvider } from './providers.js';
import { GitHubStorageProvider } from './github.js';
import {
  loadSchedulerState,
  saveSchedulerState,
  cloudRetryDelayMs,
  CLOUD_RETRY_ALARM,
  normalizeScheduleConfig,
} from './scheduler.js';

export const CONFIG_KEY = 'bbr:cloud-config';
export const CLOUD_STATE_KEY = 'bbr:cloud-state';
export const PENDING_KEY = 'bbr:pending-upload';
export const SESSION_PW_KEY = 'bbr:session-pw';

export function normalizeBackupDestination(value) {
  return ['local-only', 'cloud-only', 'both'].includes(value) ? value : 'cloud-only';
}

export function shouldKeepTransientRetryCopy({ destination, autoRetryCloud } = {}) {
  return ['cloud-only', 'both'].includes(normalizeBackupDestination(destination)) && !!autoRetryCloud;
}

// ---------------- config ----------------

export function normalizeCloudConfig(raw) {
  const c = raw || {};
  const gh = c.github || {};
  return {
    provider: c.provider === 'local' ? 'local' : 'github',
    // user's encryption preference: 'enabled' (default) | 'disabled' (explicit
    // plaintext choice, private repos only — public repos force encryption in code)
    encryption: c.encryption === 'disabled' ? 'disabled' : 'enabled',
    autoRetryCloud: !!c.autoRetryCloud,
    github: {
      token: typeof gh.token === 'string' ? gh.token : '',
      owner: (gh.owner || '').trim(),
      repo: (gh.repo || '').trim(),
      branch: (gh.branch || '').trim(), // empty = repo default branch
      basePath: (gh.basePath || 'browser-backups').trim().replace(/^\/+|\/+$/g, '') || 'browser-backups',
      // API base URL — https://api.github.com in production. Overridable only
      // programmatically (used by the automated test suite's local GitHub API
      // simulator); the UI never exposes or changes it.
      apiBaseUrl: (gh.apiBaseUrl || '').trim() || 'https://api.github.com',
    },
    schedule: normalizeScheduleConfig(c.schedule),
    retention: {
      enabled: !!(c.retention && c.retention.enabled),
      keepLast: c.retention && Number.isInteger(c.retention.keepLast) ? Math.max(2, c.retention.keepLast) : 30,
    },
  };
}

export async function loadCloudConfig() {
  const o = await chrome.storage.local.get(CONFIG_KEY);
  return normalizeCloudConfig(o[CONFIG_KEY]);
}

export async function saveCloudConfig(raw) {
  const cfg = normalizeCloudConfig(raw);
  await chrome.storage.local.set({ [CONFIG_KEY]: cfg });
  if (!cfg.autoRetryCloud) {
    try {
      await chrome.alarms.clear(CLOUD_RETRY_ALARM);
    } catch (e) {
      /* alarms may be unavailable in test/runtime variants */
    }
  } else {
    await restoreCloudRetryAlarm();
  }
  return cfg;
}

// Config summary WITHOUT the token (for UI info / tests / logs).
export function redactConfig(cfg) {
  const c = normalizeCloudConfig(cfg);
  return {
    ...c,
    github: { ...c.github, token: c.github.token ? '<set>' : '' },
    hasToken: !!c.github.token,
  };
}

export function isConfigured(cfg) {
  const c = normalizeCloudConfig(cfg);
  if (c.provider === 'local') return true;
  return !!(c.github.token && c.github.owner && c.github.repo);
}

// ---------------- provider factory ----------------

export function createProviderFromConfig(cfg, { apiBaseUrl: _apiBaseUrl } = {}) {
  const c = normalizeCloudConfig(cfg);
  if (c.provider === 'local') return new LocalStorageProvider();
  if (!isConfigured(c)) {
    throw new TypedError(
      'ERR_NOT_CONFIGURED',
      'Cloud backup is not configured (provider, token, owner or repository missing).'
    );
  }
  return new GitHubStorageProvider({
    token: c.github.token,
    owner: c.github.owner,
    repo: c.github.repo,
    branch: c.github.branch || null,
    basePath: c.github.basePath,
    apiBaseUrl: c.github.apiBaseUrl,
  });
}

// ---------------- status machine ----------------

export const PHASES = Object.freeze([
  'not-configured',
  'ready',
  'collecting',
  'encrypting',
  'uploading',
  'upload-successful',
  'upload-failed',
  'downloading',
  'decrypting',
  'restore-downloaded',
  'restoring',
  'restore-successful',
  'restore-failed',
  'auth-failed',
  'repo-not-found',
  'public-requires-encryption',
  'wrong-password',
  'corrupted-backup',
  'unsupported-version',
  'password-unavailable',
  'network-error',
]);

export async function getCloudState() {
  const o = await chrome.storage.local.get(CLOUD_STATE_KEY);
  return o[CLOUD_STATE_KEY] || { phase: 'ready', updatedAt: null, lastError: null };
}

export async function setCloudPhase(phase, detail = '', lastError = null) {
  if (!PHASES.includes(phase)) throw new TypedError('ERR_MALFORMED', `Unknown cloud phase "${phase}".`);
  const state = { phase, detail: String(detail || ''), lastError, updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [CLOUD_STATE_KEY]: state });
  return state;
}

// Typed error code -> UI status (secrets never appear in any of these).
export function statusFromError(e) {
  const code = errCode(e);
  switch (code) {
    case 'ERR_NOT_CONFIGURED':
      return 'not-configured';
    case 'ERR_GITHUB_AUTH':
      return 'auth-failed';
    case 'ERR_GITHUB_REPO_NOT_FOUND':
      return 'repo-not-found';
    case 'ERR_PUBLIC_REQUIRES_ENCRYPTION':
      return 'public-requires-encryption';
    case 'ERR_DECRYPT_FAILED':
      return 'wrong-password';
    case 'ERR_UNSUPPORTED_VERSION':
    case 'ERR_UNSUPPORTED_ENCRYPTION_VERSION':
      return 'unsupported-version';
    case 'ERR_NETWORK':
      return 'network-error';
    case 'ERR_NO_PASSWORD':
      return 'password-unavailable';
    default:
      if (
        [
          'ERR_CHECKSUM_MISMATCH',
          'ERR_NO_INTEGRITY',
          'ERR_PARSE',
          'ERR_MALFORMED',
          'ERR_MALFORMED_ENVELOPE',
          'ERR_EMPTY_FILE',
          'ERR_UTF8_DECODE',
          'ERR_DECOMPRESSION_FAILED',
          'ERR_UNKNOWN_FORMAT',
        ].includes(code)
      ) {
        return 'corrupted-backup';
      }
      return null; // caller keeps its contextual phase (upload-failed / restore-failed)
  }
}

// ---------------- encryption policy ----------------

// effectiveEncryption: 'required' (public repo) | 'enabled' (user choice) | 'disabled' (private + explicit)
export function effectiveEncryption(config, repoInfo) {
  const cfg = normalizeCloudConfig(config);
  if (cfg.provider === 'local') return cfg.encryption === 'disabled' ? 'disabled' : 'enabled';
  if (repoInfo && repoInfo.private === false) return 'required'; // public repository — enforced in code
  return cfg.encryption === 'disabled' ? 'disabled' : 'enabled';
}

// ---------------- pending upload (local-first, deferred sync) ----------------

async function loadPendingUpload() {
  const o = await chrome.storage.local.get(PENDING_KEY);
  return o[PENDING_KEY] || null;
}

async function savePendingUpload(p) {
  await chrome.storage.local.set({ [PENDING_KEY]: p });
  return p;
}

async function clearPendingUpload() {
  await chrome.storage.local.remove(PENDING_KEY);
  try {
    await chrome.alarms.clear(CLOUD_RETRY_ALARM);
  } catch (e) {
    /* alarm may already be absent */
  }
}

function isRetryableUploadError(e) {
  return ['ERR_NETWORK', 'ERR_GITHUB_HTTP', 'ERR_VERIFY_FAILED'].includes(errCode(e));
}

export async function schedulePendingCloudRetry() {
  const cfg = await loadCloudConfig();
  const pending = await loadPendingUpload();
  if (!cfg.autoRetryCloud || !pending || !chrome.alarms?.create) return { scheduled: false };
  const retryCount = (Number.isInteger(pending.retryCount) ? pending.retryCount : 0) + 1;
  const delay = cloudRetryDelayMs(retryCount);
  if (delay === null) {
    await savePendingUpload({ ...pending, retryAt: null, retryExhausted: true, retryCancelled: false });
    try {
      await chrome.alarms.clear(CLOUD_RETRY_ALARM);
    } catch (e) {
      /* ignore */
    }
    return { scheduled: false, exhausted: true };
  }
  const retryAt = Date.now() + delay;
  await savePendingUpload({
    ...pending,
    retryCount,
    retryAt: new Date(retryAt).toISOString(),
    retryExhausted: false,
    retryCancelled: false,
  });
  await chrome.alarms.create(CLOUD_RETRY_ALARM, { when: retryAt });
  return { scheduled: true, retryCount, retryAt };
}

export async function restoreCloudRetryAlarm() {
  if (!chrome.alarms?.create) return { restored: false };
  const cfg = await loadCloudConfig();
  const pending = await loadPendingUpload();
  if (!cfg.autoRetryCloud || !pending || pending.retryExhausted || pending.retryCancelled) {
    try {
      await chrome.alarms.clear(CLOUD_RETRY_ALARM);
    } catch (e) {
      /* ignore */
    }
    return { restored: false };
  }
  if (!pending.retryAt) return schedulePendingCloudRetry();
  const parsed = pending.retryAt ? Date.parse(pending.retryAt) : NaN;
  const when = Number.isFinite(parsed) ? Math.max(parsed, Date.now() + 1000) : Date.now() + 60_000;
  await chrome.alarms.create(CLOUD_RETRY_ALARM, { when });
  return { restored: true, when };
}

export async function getCloudRetryInfo() {
  const cfg = await loadCloudConfig();
  const pending = await loadPendingUpload();
  return {
    enabled: cfg.autoRetryCloud,
    pending: pending
      ? {
          id: pending.id,
          retryCount: pending.retryCount || 0,
          retryAt: pending.retryAt || null,
          retryExhausted: !!pending.retryExhausted,
          retryCancelled: !!pending.retryCancelled,
        }
      : null,
  };
}

export async function cancelPendingCloudRetry() {
  const pending = await loadPendingUpload();
  if (!pending) return false;
  await savePendingUpload({ ...pending, retryAt: null, retryCancelled: true });
  try {
    await chrome.alarms.clear(CLOUD_RETRY_ALARM);
  } catch (e) {
    /* alarm may already be absent */
  }
  return true;
}

function sameLocalDay(isoA, dateB) {
  if (!isoA) return false;
  const a = new Date(isoA);
  if (isNaN(a)) return false;
  return (
    a.getFullYear() === dateB.getFullYear() && a.getMonth() === dateB.getMonth() && a.getDate() === dateB.getDate()
  );
}

// ---------------- session password (memory-only, for scheduled runs) ----------------

export async function keepSessionPassword(password) {
  if (!password) return;
  // chrome.storage.session is RAM-only: never written to disk, cleared when the
  // browser closes, accessible only to this extension's trusted contexts.
  await chrome.storage.session.set({ [SESSION_PW_KEY]: password });
}

export async function readSessionPassword() {
  try {
    const o = await chrome.storage.session.get(SESSION_PW_KEY);
    return o[SESSION_PW_KEY] || null;
  } catch (e) {
    return null;
  }
}

export async function forgetSessionPassword() {
  try {
    await chrome.storage.session.remove(SESSION_PW_KEY);
  } catch (e) {
    /* ignore */
  }
}

// ---------------- backup pipeline ----------------

// User-facing "download a local copy" step for destination 'both'.
// Returns { localDownload, localDownloadError }; never throws — a failed
// download is reported on the result instead of failing the backup.
async function maybeDownloadLocalCopy({
  destination: normalizedDestination,
  downloadArtifact,
  artifact,
  log = () => {
    /* noop */
  },
}) {
  let localDownload = null;
  let localDownloadError = null;
  if (normalizedDestination === 'both' && typeof downloadArtifact === 'function') {
    try {
      localDownload = await downloadArtifact(artifact);
      log('local download saved');
    } catch (e) {
      localDownloadError = e && e.message ? e.message : String(e);
      log(`local download failed: ${localDownloadError}`);
    }
  }
  return { localDownload, localDownloadError };
}

// Read → upsert → write the remote manifest. A malformed remote manifest is
// replaced instead of failing the (already verified) upload.
async function updateRemoteManifest(provider, entry) {
  let manifest;
  try {
    const { manifest: m } = await provider.readManifest();
    manifest = upsertManifestEntry(m || newRemoteManifest(), entry);
  } catch (e) {
    if (e.code === 'ERR_MALFORMED') manifest = upsertManifestEntry(newRemoteManifest(), entry);
    else throw e;
  }
  await provider.writeManifest(manifest);
  return manifest;
}

// collectBackup: async (onProgress, collectOptions) => finalized backup object
//   (injected by the dashboard — heavy work always runs in an extension page).
// eslint-disable-next-line complexity -- TECH DEBT: complexity 77, refactoring risks behavior change
export async function runCloudBackup({
  collectBackup,
  onProgress = () => {
    /* noop */
  },
  collectOptions = null,
  password = null,
  useSessionPassword = false,
  plaintextAck = false,
  trigger = 'manual',
  destination = null,
  preserveLocalCopy = null,
  downloadArtifact = null,
  autoRetryCloud = null,
} = {}) {
  const log = (m) => onProgress(m);
  const cfg = await loadCloudConfig();
  const explicitDestination = destination !== null;
  const normalizedDestination = normalizeBackupDestination(destination === null ? 'both' : destination);
  const retryEnabled = autoRetryCloud === null ? cfg.autoRetryCloud : !!autoRetryCloud;
  const keepLegacyCopy =
    preserveLocalCopy === null ? !explicitDestination || trigger === 'scheduled' : !!preserveLocalCopy;
  const transientRetryCopy =
    shouldKeepTransientRetryCopy({ destination: normalizedDestination, autoRetryCloud: retryEnabled }) &&
    !keepLegacyCopy;
  const keepLocalArtifact = cfg.provider === 'local' || keepLegacyCopy || transientRetryCopy;

  if (normalizedDestination === 'local-only') {
    throw new TypedError(
      'ERR_DESTINATION',
      'Local-only backups are downloaded directly and do not use the cloud backup pipeline.'
    );
  }
  if (explicitDestination && cfg.provider === 'local') {
    throw new TypedError('ERR_DESTINATION', 'Choose GitHub as the provider for Cloud only or Both backups.');
  }

  if (!isConfigured(cfg)) {
    await setCloudPhase('not-configured', 'Cloud backup is not configured.');
    throw new TypedError(
      'ERR_NOT_CONFIGURED',
      'Cloud backup is not configured (provider, token, owner or repository missing).'
    );
  }

  const provider = createProviderFromConfig(cfg);

  // 1) connect + repository visibility
  log('connecting to ' + (cfg.provider === 'local' ? 'local storage' : 'GitHub…'));
  let repoInfo;
  try {
    await provider.connect();
    repoInfo = provider.repoInfo || null;
  } catch (e) {
    const st = statusFromError(e);
    if (retryEnabled && isRetryableUploadError(e) && (await loadPendingUpload())) await schedulePendingCloudRetry();
    await setCloudPhase(st || 'upload-failed', 'connect failed', { code: errCode(e), message: e.message });
    await recordSchedulerOutcome(trigger, false, e);
    throw e;
  }

  // 2) encryption decision (public repo => required, enforced again inside the provider)
  const effEnc = effectiveEncryption(cfg, repoInfo);
  const encRequired = effEnc !== 'disabled';
  const plaintextAllowed = effEnc === 'disabled' && plaintextAck === true;
  if (effEnc === 'disabled' && !plaintextAck) {
    throw new TypedError(
      'ERR_PLAINTEXT_NOT_ALLOWED',
      'Plaintext backup requires an explicit user acknowledgement (private repositories only).'
    );
  }

  // 3) pending upload? sync the existing artifact instead of re-collecting.
  //    This needs NO password — the artifact is already encrypted (if it was).
  let pending = await loadPendingUpload();
  if (pending && (trigger === 'manual' || trigger === 'sync-retry')) {
    pending = { ...pending, retryCount: 0, retryAt: null, retryExhausted: false, retryCancelled: false };
    await savePendingUpload(pending);
    try {
      await chrome.alarms.clear(CLOUD_RETRY_ALARM);
    } catch (e) {
      /* ignore */
    }
  }
  const retryTrigger = trigger === 'auto-retry' || trigger === 'sync-retry';
  if (pending && (sameLocalDay(pending.createdAt, new Date()) || retryTrigger) && pending.encrypted === encRequired) {
    log('pending upload found — syncing existing artifact (no re-collection)…');
    try {
      let localDownload = null;
      let localDownloadError = null;
      if (normalizedDestination === 'both' && typeof downloadArtifact === 'function') {
        try {
          const stored = await new LocalStorageProvider().downloadBackup(pending.id);
          const artifact = await makeRemoteArtifact(stored.text, {
            backupId: pending.id,
            createdAt: pending.createdAt,
            trigger,
          });
          ({ localDownload, localDownloadError } = await maybeDownloadLocalCopy({
            destination: normalizedDestination,
            downloadArtifact,
            artifact,
            log,
          }));
        } catch (e) {
          localDownloadError = e && e.message ? e.message : String(e);
          log(`local download failed: ${localDownloadError}`);
        }
      }
      const res = await syncPendingArtifact({ provider, pending, plaintextAllowed, trigger });
      await setCloudPhase('upload-successful', `Synced pending artifact ${pending.id}`);
      return { ...res, localDownload, localDownloadError };
    } catch (e) {
      const st = statusFromError(e);
      if (isRetryableUploadError(e)) await schedulePendingCloudRetry();
      await setCloudPhase(st || 'upload-failed', 'pending sync failed', { code: errCode(e), message: e.message });
      await recordSchedulerOutcome(trigger, false, e);
      throw e;
    }
  }
  if (pending && !sameLocalDay(pending.createdAt, new Date())) {
    if (pending.transientLocalCopy) {
      try {
        await new LocalStorageProvider().deleteBackup(pending.id);
      } catch (e) {
        /* stale retry artifact cleanup is best-effort */
      }
    }
    await clearPendingUpload(); // stale pending from a previous day: discard
  }

  // 4) password availability BEFORE any data collection (scheduled runs must
  //    not collect data they cannot encrypt)
  let pw = password;
  if (encRequired && !pw && useSessionPassword) pw = await readSessionPassword();
  if (encRequired && !pw) {
    await setCloudPhase('password-unavailable', 'No encryption password available for this run.', {
      code: 'ERR_NO_PASSWORD',
      message: 'Encryption password required.',
    });
    await recordSchedulerOutcome(
      trigger,
      false,
      new TypedError('ERR_NO_PASSWORD', 'Encryption password required but not available for this run.')
    );
    throw new TypedError(
      'ERR_NO_PASSWORD',
      'An encryption password is required for this backup (public repository or encryption enabled).'
    );
  }
  if (encRequired && pw) await keepSessionPassword(pw);

  // 5) collect + finalize
  await setCloudPhase('collecting', 'Collecting browser data…');
  const backup = await collectBackup((m) => log(m), collectOptions);

  // 6) serialize + encrypt
  await setCloudPhase('encrypting', encRequired ? 'Encrypting backup…' : 'Serializing backup…');
  let artifact;
  if (encRequired) {
    const env = await encryptBackup(backup, pw);
    artifact = await makeRemoteArtifact(JSON.stringify(env), { trigger, browser: backup.generator || null });
  } else {
    artifact = await makeRemoteArtifact(JSON.stringify(backup), { trigger, browser: backup.generator || null });
  }

  // 7) local download (destination 'both'): user-facing copy, never fatal
  const { localDownload, localDownloadError } = await maybeDownloadLocalCopy({
    destination: normalizedDestination,
    downloadArtifact,
    artifact,
    log,
  });

  const localProvider = new LocalStorageProvider();
  if (keepLocalArtifact) {
    log(transientRetryCopy ? 'saving temporary retry copy…' : 'saving local durable copy…');
    await localProvider.uploadBackup(artifact, { plaintextAllowed });
  }

  // 8) remote upload (+ verification inside the provider) — skip for local provider
  if (cfg.provider !== 'local') {
    if (keepLocalArtifact)
      await savePendingUpload({
        id: artifact.id,
        createdAt: artifact.createdAt,
        encrypted: artifact.encrypted,
        sha256Hex: artifact.sha256Hex,
        sizeBytes: artifact.sizeBytes,
        trigger,
        transientLocalCopy: transientRetryCopy,
        retryCount: 0,
        retryAt: null,
        retryCancelled: false,
      });
    await setCloudPhase('uploading', 'Uploading to GitHub…');
    try {
      const up = await provider.uploadBackup(artifact, { plaintextAllowed });
      log(`remote object verified (sha256 ${up.sha256Hex.slice(0, 12)}…)`);
      // 9) manifest update
      await updateRemoteManifest(provider, manifestEntryFromArtifact(artifact));
      if (transientRetryCopy) await localProvider.deleteBackup(artifact.id);
      await clearPendingUpload();

      // 10) retention (optional, only after verified upload; disabled by default)
      if (cfg.retention.enabled) {
        await applyRemoteRetention(provider, { keepLast: cfg.retention.keepLast, protectId: artifact.id });
      }

      await recordSchedulerOutcome(trigger, true, null, artifact.id);
      await setCloudPhase('upload-successful', `Backup ${artifact.id} uploaded and verified.`);
      return {
        ok: true,
        artifactId: artifact.id,
        sizeBytes: artifact.sizeBytes,
        sha256Hex: artifact.sha256Hex,
        encrypted: artifact.encrypted,
        localDownload,
        localDownloadError,
        upload: up,
        synced: false,
      };
    } catch (e) {
      if (keepLocalArtifact && retryEnabled && isRetryableUploadError(e)) await schedulePendingCloudRetry();
      const st = statusFromError(e);
      await setCloudPhase(
        st || 'upload-failed',
        keepLocalArtifact
          ? 'upload failed — retry copy kept locally'
          : 'upload failed — no local retry copy was requested',
        { code: errCode(e), message: e.message }
      );
      await recordSchedulerOutcome(trigger, false, e);
      e.localDownload = localDownload;
      e.localDownloadError = localDownloadError;
      throw e;
    }
  }

  // local provider: the durable copy above IS the backup
  await clearPendingUpload();
  await recordSchedulerOutcome(trigger, true, null, artifact.id);
  await setCloudPhase('upload-successful', `Backup ${artifact.id} stored locally.`);
  return {
    ok: true,
    artifactId: artifact.id,
    sizeBytes: artifact.sizeBytes,
    sha256Hex: artifact.sha256Hex,
    encrypted: artifact.encrypted,
    upload: { verified: true },
    synced: false,
  };
}

// Re-sync an artifact that was collected+stored locally earlier but whose
// upload failed (§17: never regenerate identical backups because of the cloud).
async function syncPendingArtifact({ provider, pending, plaintextAllowed, trigger }) {
  const localProvider = new LocalStorageProvider();
  const { text } = await localProvider.downloadBackup(pending.id);
  const artifact = await makeRemoteArtifact(text, {
    backupId: pending.id,
    filename: pending.filename || undefined,
    createdAt: pending.createdAt,
    trigger: pending.trigger || trigger,
  });
  if (artifact.sha256Hex !== pending.sha256Hex) {
    await clearPendingUpload();
    throw new TypedError(
      'ERR_CHECKSUM_MISMATCH',
      'Pending artifact no longer matches its recorded digest — discarded.'
    );
  }
  if (provider.constructor.id !== 'local') {
    const up = await provider.uploadBackup(artifact, { plaintextAllowed });
    await updateRemoteManifest(provider, manifestEntryFromArtifact(artifact));
    if (pending.transientLocalCopy) await localProvider.deleteBackup(artifact.id);
    await clearPendingUpload();
    const cfg = await loadCloudConfig();
    if (cfg.retention.enabled)
      await applyRemoteRetention(provider, { keepLast: cfg.retention.keepLast, protectId: artifact.id });
    await recordSchedulerOutcome(trigger, true, null, artifact.id);
    return {
      ok: true,
      artifactId: artifact.id,
      sha256Hex: artifact.sha256Hex,
      encrypted: artifact.encrypted,
      upload: up,
      synced: true,
    };
  }
  await clearPendingUpload();
  await recordSchedulerOutcome(trigger, true, null, artifact.id);
  return {
    ok: true,
    artifactId: artifact.id,
    sha256Hex: artifact.sha256Hex,
    encrypted: artifact.encrypted,
    upload: { verified: true },
    synced: true,
  };
}

async function recordSchedulerOutcome(trigger, success, error, artifactId = null) {
  const state = await loadSchedulerState();
  state.lastAttempt = new Date().toISOString();
  state.lastAttemptTrigger = trigger;
  state.running = false;
  state.runningSince = null;
  if (success) {
    state.lastSuccessfulBackupAt = new Date().toISOString();
    state.lastSuccessfulBackupId = artifactId;
    state.lastResult = 'success';
    state.lastError = null;
  } else {
    state.lastResult = 'failed';
    state.lastError = error
      ? { code: errCode(error), message: error.message }
      : { code: 'UNKNOWN', message: 'unknown error' };
  }
  await saveSchedulerState(state);
}

// Mark a scheduled run as started (cross-context lock).
export async function beginScheduledRun() {
  const state = await loadSchedulerState();
  state.running = true;
  state.runningSince = new Date().toISOString();
  await saveSchedulerState(state);
  return state;
}

export async function endScheduledRun() {
  const state = await loadSchedulerState();
  state.running = false;
  state.runningSince = null;
  await saveSchedulerState(state);
}

// ---------------- restore path ----------------

export async function listCloudBackups() {
  const cfg = await loadCloudConfig();
  if (!isConfigured(cfg)) throw new TypedError('ERR_NOT_CONFIGURED', 'Cloud backup is not configured.');
  const provider = createProviderFromConfig(cfg);
  await provider.connect();
  return provider.listBackups();
}

// Downloads + validates (decrypt if needed). Returns { text, sha256Hex, validation }.
// The caller (dashboard) then runs the normal restore flow on validation.backup.
export async function downloadAndValidateBackup(ref, { password = null } = {}) {
  const cfg = await loadCloudConfig();
  const provider = createProviderFromConfig(cfg);
  await setCloudPhase('downloading', `Downloading ${ref.id || ref.filename || 'backup'}…`);
  const { text, sha256Hex } = await provider.downloadBackup(ref);

  // manifest integrity, when the listing carried a digest
  if (ref && ref.integrity && ref.integrity.digest && sha256Hex !== ref.integrity.digest) {
    await setCloudPhase('corrupted-backup', 'Downloaded artifact does not match its recorded digest.', {
      code: 'ERR_CHECKSUM_MISMATCH',
      message: 'integrity mismatch vs manifest',
    });
    throw new TypedError(
      'ERR_CHECKSUM_MISMATCH',
      'The downloaded backup does not match the digest recorded in the remote manifest. It is corrupted or was replaced.'
    );
  }

  let validation;
  try {
    validation = await validateBackupFile(text, { password });
  } catch (e) {
    const st = statusFromError(e);
    await setCloudPhase(st || 'restore-failed', 'validation failed', { code: errCode(e), message: e.message });
    throw e;
  }
  await setCloudPhase('restore-downloaded', 'Backup validated — ready to restore.');
  return { text, sha256Hex, validation };
}

// ---------------- retention (optional; disabled by default) ----------------

// Runs ONLY after a verified upload. Deletes the OLDEST remote artifacts beyond
// keepLast (never the just-uploaded one), then rewrites the manifest.
export async function applyRemoteRetention(provider, { keepLast = 30, protectId = null } = {}) {
  const { manifest } = await provider.readManifest();
  if (!manifest || manifest.backups.length <= keepLast) return { deleted: 0 };
  const sorted = manifest.backups.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const doomed = sorted.slice(keepLast).filter((b) => b.id !== protectId);
  let deleted = 0;
  for (const b of doomed) {
    try {
      await provider.deleteBackup(b);
      deleted++;
    } catch (e) {
      if (e.code !== 'ERR_NOT_FOUND' && e.code !== 'ERR_GITHUB_REPO_NOT_FOUND') throw e;
    }
  }
  if (deleted > 0) {
    const remaining = manifest.backups.filter((b) => !doomed.some((d) => d.id === b.id));
    await provider.writeManifest(normalizeManifest({ ...manifest, backups: remaining }));
  }
  return { deleted };
}

// ---------------- info helper (UI/tests) ----------------

export async function getCloudInfo() {
  const cfg = await loadCloudConfig();
  const state = await getCloudState();
  const sched = await loadSchedulerState();
  const pending = await loadPendingUpload();
  return {
    configured: isConfigured(cfg),
    config: redactConfig(cfg),
    cloudState: state,
    schedulerState: sched,
    pendingUpload: pending ? { ...pending } : null,
  };
}
