// E2E: full cloud cycle through the REAL extension against a local GitHub
// REST API simulator (tests/e2e/github-simulator.mjs).
//
// Covers, in one browser session:
//   1. connect + repository visibility detection (private)
//   2. encrypted cloud backup → upload → remote verification → manifest entry
//      (no plaintext leakage; token only in Authorization headers)
//   3. list → destroy profile → wrong password rejected → corrupted remote
//      artifact rejected (manifest digest mismatch) → download → restore exact
//   4. failure path: injected HTTP 500 → typed error, local durable copy
//      survives, pending retry scheduled → sync-retry uploads the SAME artifact
//      (no re-collection), pending cleared, scheduler records success
//   5. policy matrix: public repo + plaintext request → never a plaintext
//      fallback (ERR_NO_PASSWORD); public repo + encrypted → passes;
//      private repo + explicit plaintext ack → passes and lands as plaintext
import assert from 'node:assert/strict';
import { launchDashboard, apiCall, must } from './launch.mjs';
import { createGitHubSimulator } from './github-simulator.mjs';
import { seedBookmarks, destroyBookmarks, readSeededBookmarks, BOOKMARK_SEED } from './seeds.mjs';

const TOKEN = 'e2e-token-abc123';
const PASSWORD = 'e2e-cloud-pw-1';
const collectOptions = { selectedCategories: ['bookmarks'] };
const BASE_PATH = 'browser-backups';

const sim = createGitHubSimulator({ owner: 'e2e', repo: 'vault', isPublic: false });
await sim.start();
const apiBaseUrl = sim.url;

function baseConfig() {
  return {
    provider: 'github',
    encryption: 'enabled',
    autoRetryCloud: true,
    github: { token: TOKEN, owner: 'e2e', repo: 'vault', branch: 'main', basePath: BASE_PATH, apiBaseUrl },
    schedule: { enabled: false },
    retention: { enabled: false }
  };
}

const { context, page, pageErrors } = await launchDashboard();
try {
  await seedBookmarks(page);

  // ---- 1) configure + connect (private repo) ----
  const saved = must(
    await apiCall(page, `api.cloud.saveConfig(a.cfg)`, { cfg: baseConfig() }),
    'cloud.saveConfig'
  );
  assert.equal(saved.github.token, '<set>', 'saved config should redact the token');
  assert.equal(saved.hasToken, true);
  const conn = must(await apiCall(page, `api.cloud.connect()`, {}), 'cloud.connect');
  assert.equal(conn.repo.private, true, 'simulator repo should be detected as private');
  assert.equal(conn.branch, 'main');

  // ---- 2) encrypted cloud backup ----
  const backup = must(
    await apiCall(page, `api.cloud.runBackup({ password: a.password, trigger: 'manual', collectOptions: a.collectOptions })`, { password: PASSWORD, collectOptions }),
    'cloud.runBackup (encrypted)'
  );
  assert.equal(backup.ok, true);
  assert.equal(backup.encrypted, true);
  assert.equal(backup.upload.verified, true, 'remote object should be verified (sha256 + git blob sha)');
  assert.equal(backup.synced, false);

  const bbrPath = `${BASE_PATH}/backups/backup-${backup.artifactId}.bbr`;
  const remoteBytes = sim.readFile(bbrPath);
  assert.ok(remoteBytes, 'artifact should exist on the simulated remote');
  const remoteText = remoteBytes.toString('utf8');
  const envelope = JSON.parse(remoteText);
  assert.equal(envelope.format, 'chrome-local-backup-encrypted', 'remote artifact should be the encrypted envelope');
  assert.ok(!remoteText.includes('example.com/e2e-one'), 'remote artifact must not leak bookmark URLs in plaintext');

  const manifest = JSON.parse(sim.readFile(`${BASE_PATH}/manifest.json`).toString('utf8'));
  assert.equal(manifest.backups.length, 1, 'manifest should carry one entry');
  assert.equal(manifest.backups[0].id, backup.artifactId);
  assert.ok(manifest.backups[0].integrity && manifest.backups[0].integrity.digest, 'manifest entry should carry an integrity digest');
  assert.ok(!JSON.stringify(manifest).includes('example.com'), 'manifest must not contain browser data');

  // secret hygiene across every simulated request
  for (const req of sim.audit) {
    assert.ok(!req.path.includes(TOKEN) && !req.bodyText.includes(TOKEN), `token must never appear in URL or body (${req.method} ${req.path})`);
    assert.ok(!req.bodyText.includes(PASSWORD) && !req.path.includes(PASSWORD), `password must never be transmitted (${req.method} ${req.path})`);
  }
  assert.ok(sim.audit.some((r) => r.authorization === `Bearer ${TOKEN}`), 'token should be sent in the Authorization header');
  console.log('PASS cloud E2E 1-2: connect, encrypted backup, verified upload, manifest, secret hygiene');

  // ---- 3) list → destroy → wrong password → corruption → restore ----
  const list = must(await apiCall(page, `api.cloud.listBackups()`, {}), 'cloud.listBackups');
  assert.equal(list.length, 1);
  const refId = list[0].id;

  assert.equal(await destroyBookmarks(page), 1);
  assert.equal(await readSeededBookmarks(page), null, 'seeded bookmarks should be gone after destroy');

  const wrong = await apiCall(page, `api.cloud.download(a.refId, { password: 'wrong-password' })`, { refId });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, 'ERR_DECRYPT_FAILED', 'wrong password should surface ERR_DECRYPT_FAILED');

  const originalRemote = sim.readFile(bbrPath);
  sim.tamper(bbrPath, (buf) => { buf[buf.length - 10] ^= 0xff; return buf; });
  const corrupted = await apiCall(page, `api.cloud.download(a.refId, { password: a.password })`, { refId, password: PASSWORD });
  assert.equal(corrupted.ok, false);
  assert.equal(corrupted.code, 'ERR_CHECKSUM_MISMATCH', 'tampered remote artifact should fail the manifest digest check');
  sim.tamper(bbrPath, () => originalRemote);

  const downloaded = must(
    await apiCall(page, `api.cloud.download(a.refId, { password: a.password })`, { refId, password: PASSWORD }),
    'cloud.download (valid)'
  );
  assert.equal(downloaded.encrypted, true);
  assert.equal(downloaded.formatVersion, 2, 'decrypted cloud payload should be a v2 backup, not a collector wrapper');
  assert.ok(downloaded.counts.bookmarks >= BOOKMARK_SEED.length, 'downloaded backup should contain seeded bookmarks');

  const restored = must(
    await apiCall(page, `api.cloud.restoreFromCloud(a.refId, { password: a.password, options: a.options })`, { refId, password: PASSWORD, options: { bookmarks: { enabled: true } } }),
    'cloud.restoreFromCloud'
  );
  assert.equal(restored.ok, true);
  assert.deepEqual(await readSeededBookmarks(page), BOOKMARK_SEED, 'restored bookmarks should match the seed exactly');
  console.log('PASS cloud E2E 3: list, destroy, wrong-password rejected, remote corruption rejected, restore exact');

  // ---- 4) failure path: injected 500 → pending retry → sync same artifact ----
  sim.failNext(1, { status: 500, methods: ['PUT'] });
  const failed = await apiCall(page, `api.cloud.runBackup({ password: a.password, trigger: 'manual', collectOptions: a.collectOptions })`, { password: PASSWORD, collectOptions });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'ERR_GITHUB_HTTP', 'injected 500 should surface ERR_GITHUB_HTTP');
  sim.clearFailures();

  const infoAfterFail = must(await apiCall(page, `api.cloud.info()`, {}), 'cloud.info after failure');
  assert.ok(infoAfterFail.pendingUpload, 'failed upload should leave a pending-upload marker');
  assert.equal(infoAfterFail.pendingUpload.retryCount, 1, 'one retry should be scheduled');
  assert.ok(infoAfterFail.pendingUpload.retryAt, 'retry should have a scheduled time');
  assert.equal(infoAfterFail.schedulerState.lastResult, 'failed', 'scheduler should record the failure');
  const pendingId = infoAfterFail.pendingUpload.id;

  const synced = must(
    await apiCall(page, `api.cloud.runBackup({ password: a.password, trigger: 'sync-retry', collectOptions: a.collectOptions })`, { password: PASSWORD, collectOptions }),
    'cloud.runBackup (sync-retry)'
  );
  assert.equal(synced.ok, true);
  assert.equal(synced.synced, true, 'retry should sync the existing artifact, not re-collect');
  assert.equal(synced.artifactId, pendingId, 'retry should upload the SAME artifact id');
  assert.equal(sim.readFile(`${BASE_PATH}/backups/backup-${pendingId}.bbr`).toString('utf8').length > 0, true);

  const infoAfterSync = must(await apiCall(page, `api.cloud.info()`, {}), 'cloud.info after sync');
  assert.equal(infoAfterSync.pendingUpload, null, 'pending marker should be cleared after successful sync');
  assert.equal(infoAfterSync.schedulerState.lastResult, 'success', 'scheduler should record success');
  assert.equal(infoAfterSync.schedulerState.lastSuccessfulBackupId, pendingId);
  console.log('PASS cloud E2E 4: 500 → typed error → pending retry → sync-retry uploads the same artifact, scheduler success');

  // ---- 5) policy matrix ----
  sim.setPublic(true);
  // public repo + plaintext request: the pipeline must refuse BEFORE any
  // upload — never a plaintext fallback. (Clear the remembered session
  // password first so this is genuinely a passwordless run.)
  await page.evaluate(() => chrome.storage.session.remove('bbr:session-pw'));
  must(await apiCall(page, `api.cloud.saveConfig(a.cfg)`, { cfg: { ...baseConfig(), encryption: 'disabled' } }), 'saveConfig plaintext');
  const publicPlain = await apiCall(
    page,
    `api.cloud.runBackup({ password: null, plaintextAck: true, trigger: 'manual', collectOptions: a.collectOptions })`,
    { collectOptions }
  );
  assert.equal(publicPlain.ok, false);
  assert.equal(publicPlain.code, 'ERR_NO_PASSWORD', 'public repo must refuse a passwordless run instead of falling back to plaintext');
  assert.ok(!sim.listFiles().some((f) => f.endsWith('.bbr') && sim.readFile(f).toString('utf8').includes('example.com/e2e-one')),
    'no plaintext artifact may land in the public repo');

  // public repo + encrypted: passes
  must(await apiCall(page, `api.cloud.saveConfig(a.cfg)`, { cfg: baseConfig() }), 'saveConfig encrypted');
  const publicEnc = must(
    await apiCall(page, `api.cloud.runBackup({ password: a.password, trigger: 'manual', collectOptions: a.collectOptions })`, { password: PASSWORD, collectOptions }),
    'cloud.runBackup public+encrypted'
  );
  assert.equal(publicEnc.ok, true);
  assert.equal(publicEnc.encrypted, true);

  // private repo + explicit plaintext ack: passes and lands as plaintext
  sim.setPublic(false);
  must(await apiCall(page, `api.cloud.saveConfig(a.cfg)`, { cfg: { ...baseConfig(), encryption: 'disabled' } }), 'saveConfig private plaintext');
  const privatePlain = must(
    await apiCall(page, `api.cloud.runBackup({ password: null, plaintextAck: true, trigger: 'manual', collectOptions: a.collectOptions })`, { collectOptions }),
    'cloud.runBackup private+plaintext'
  );
  assert.equal(privatePlain.ok, true);
  assert.equal(privatePlain.encrypted, false);
  const plainRemote = sim.readFile(`${BASE_PATH}/backups/backup-${privatePlain.artifactId}.bbr`).toString('utf8');
  const plainBackup = JSON.parse(plainRemote);
  assert.equal(plainBackup.format, 'chrome-local-backup', 'private plaintext artifact should be the plaintext format');
  assert.ok(plainRemote.includes('example.com/e2e-one'), 'private plaintext artifact should contain the bookmark data');
  console.log('PASS cloud E2E 5: public+plaintext refused (no fallback), public+encrypted passes, private+plaintext passes as plaintext');

  assert.deepEqual(pageErrors, [], `dashboard should run without page errors: ${pageErrors.join('; ')}`);
  console.log('PASS cloud E2E round-trip: full cycle against the GitHub simulator, zero page errors');
} finally {
  await context.close();
  await sim.stop();
}
