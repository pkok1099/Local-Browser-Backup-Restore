// Node-level provider guard test: the plaintext-safety policy enforced BELOW
// the UI inside GitHubStorageProvider.uploadBackup (see assertUploadSafe in
// src/lib/artifact.js), exercised against the local GitHub REST API simulator
// with real HTTP — no browser needed.
//
// Policy matrix:
//   public repo  + plaintext (even with plaintextAllowed=true) → ERR_PUBLIC_REQUIRES_ENCRYPTION
//   private repo + plaintext, no explicit ack                  → ERR_PLAINTEXT_NOT_ALLOWED
//   private repo + plaintext + explicit ack                     → upload + verified
//   public repo  + encrypted                                    → upload + verified
import assert from 'node:assert/strict';
import { createGitHubSimulator } from './e2e/github-simulator.mjs';
import { GitHubStorageProvider } from '../src/lib/github.js';
import { makeRemoteArtifact } from '../src/lib/artifact.js';

const sim = createGitHubSimulator({ owner: 'e2e', repo: 'guard-vault', isPublic: false });
await sim.start();

function provider() {
  return new GitHubStorageProvider({
    token: 'guard-token', owner: 'e2e', repo: 'guard-vault',
    branch: 'main', basePath: 'guard', apiBaseUrl: sim.url
  });
}

async function codeOf(promise) {
  try { await promise; return null; }
  catch (e) { return e && e.code; }
}

try {
  const plainText = JSON.stringify({ format: 'chrome-local-backup', formatVersion: 2, data: { bookmarks: { roots: {} } } });
  const plain = await makeRemoteArtifact(plainText, { trigger: 'test' });
  assert.equal(plain.encrypted, false);

  // private repo: plaintext without explicit ack is refused
  let p = provider();
  await p.connect();
  assert.equal(await codeOf(p.uploadBackup(plain, { plaintextAllowed: false })), 'ERR_PLAINTEXT_NOT_ALLOWED');

  // private repo: plaintext WITH explicit ack uploads and verifies
  p = provider();
  const upPrivate = await p.uploadBackup(plain, { plaintextAllowed: true });
  assert.equal(upPrivate.verified, true);
  assert.equal(sim.readFile(`guard/backups/${plain.filename}`).toString('utf8'), plainText, 'private plaintext artifact should land byte-identical');

  // public repo: plaintext is refused even with plaintextAllowed=true (provider layer, below the UI)
  sim.setPublic(true);
  p = provider();
  await p.connect();
  assert.equal(p.repoInfo.private, false);
  assert.equal(await codeOf(p.uploadBackup(plain, { plaintextAllowed: true })), 'ERR_PUBLIC_REQUIRES_ENCRYPTION');
  assert.equal(sim.listFiles().filter((f) => f.includes(plain.filename)).length, 1, 'rejected upload must not create a second object');

  // public repo: encrypted artifact uploads and verifies
  const encText = JSON.stringify({ format: 'chrome-local-backup-encrypted', formatVersion: 2, ciphertext: 'AAEC' });
  const enc = await makeRemoteArtifact(encText, { trigger: 'test' });
  // makeRemoteArtifact marks encrypted from the envelope format
  assert.equal(enc.encrypted, true, 'envelope format should mark the artifact encrypted');
  p = provider();
  const upPublic = await p.uploadBackup(enc, { plaintextAllowed: false });
  assert.equal(upPublic.verified, true);

  // secret hygiene on the wire
  for (const req of sim.audit) {
    assert.ok(!req.bodyText.includes('guard-token') && !req.path.includes('guard-token'), 'token must only travel in the Authorization header');
  }
  assert.ok(sim.audit.some((r) => r.authorization === 'Bearer guard-token'));

  console.log('PASS provider-layer plaintext guard: public+plaintext refused, private+plaintext gated by ack, encrypted always allowed');
} finally {
  await sim.stop();
}
