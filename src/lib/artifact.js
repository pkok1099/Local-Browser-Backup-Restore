// Remote backup artifact: the exact bytes that a StorageProvider stores.
// The provider layer never sees browser data or "backup objects" — only a
// serialized artifact (plaintext backup v2 JSON, or the encrypted envelope
// JSON) plus non-sensitive metadata. This module has NO chrome.* dependency so
// it can be unit-tested in Node.

import { sha256Hex, TypedError } from './util.js';
import { FORMAT_ID, ENCRYPTED_FORMAT_ID, FORMAT_VERSION } from './format.js';

export const ARTIFACT_EXT = '.bbr';
export const REMOTE_MANIFEST_ID = 'browser-backup-remote-manifest';
export const REMOTE_MANIFEST_VERSION = 1;
export const ENCRYPTION_VERSION = 1; // encryption scheme version, independent of the backup format version

// Filenames carry ONLY a timestamp and a random id — never URLs, titles,
// domains, cookie values or any other browser-derived content.
export function makeBackupId(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const rnd = new Uint8Array(4);
  crypto.getRandomValues(rnd);
  let hex = '';
  for (const b of rnd) hex += b.toString(16).padStart(2, '0');
  return `${stamp}-${hex}`;
}

export function artifactFilename(backupId) {
  return `backup-${backupId}${ARTIFACT_EXT}`;
}

// text: the serialized artifact (plaintext backup JSON or encrypted envelope JSON).
export async function makeRemoteArtifact(text, { backupId, filename, createdAt, trigger, browser } = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypedError('ERR_MALFORMED', 'Artifact text is empty.');
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new TypedError('ERR_MALFORMED', 'Artifact is not valid JSON.');
  }
  const encrypted = obj.format === ENCRYPTED_FORMAT_ID;
  if (!encrypted && obj.format !== FORMAT_ID) {
    throw new TypedError('ERR_UNKNOWN_FORMAT', `Unknown artifact format "${obj.format}".`);
  }
  const id = backupId || makeBackupId();
  const bytes = new TextEncoder().encode(text);
  const artifact = {
    id,
    filename: filename || artifactFilename(id),
    text,
    bytes,
    sizeBytes: bytes.length,
    sha256Hex: await sha256Hex(text), // digest over the exact stored bytes
    encrypted,
    formatId: obj.format,
    formatVersion: obj.formatVersion !== undefined ? obj.formatVersion : FORMAT_VERSION,
    encryptionVersion: encrypted ? obj.encryptionVersion || 1 : null,
    createdAt: createdAt || new Date().toISOString(),
    trigger: trigger || 'manual',
    browser: browser || null,
  };
  return artifact;
}

// Non-sensitive manifest entry for the remote manifest.json. Deliberately
// excludes counts, URLs, titles, origins, cookie counts — nothing that
// describes the *content* of the backup.
export function manifestEntryFromArtifact(artifact) {
  return {
    id: artifact.id,
    filename: artifact.filename,
    createdAt: artifact.createdAt,
    sizeBytes: artifact.sizeBytes,
    format: artifact.formatId,
    formatVersion: artifact.formatVersion,
    encrypted: artifact.encrypted,
    encryptionVersion: artifact.encryptionVersion,
    integrity: { algorithm: 'sha256', encoding: 'utf8', digest: artifact.sha256Hex },
    browser: artifact.browser,
    trigger: artifact.trigger,
  };
}

export function newRemoteManifest() {
  return {
    format: REMOTE_MANIFEST_ID,
    manifestVersion: REMOTE_MANIFEST_VERSION,
    updatedAt: new Date().toISOString(),
    backups: [],
  };
}

// Newest first. Corrupt/foreign entries are dropped so a hand-edited or
// partially-written manifest cannot break listing.
export function normalizeManifest(obj) {
  if (!obj || obj.format !== REMOTE_MANIFEST_ID || !Array.isArray(obj.backups)) {
    throw new TypedError('ERR_MALFORMED', 'Remote manifest is malformed or is not a backup manifest.');
  }
  const seen = new Set();
  const backups = [];
  for (const b of obj.backups) {
    if (!b || typeof b.id !== 'string' || typeof b.filename !== 'string' || seen.has(b.id)) continue;
    if (!/^[A-Za-z0-9._/-]+$/.test(b.filename) || b.filename.includes('..')) continue; // path traversal guard
    seen.add(b.id);
    backups.push({
      id: b.id,
      filename: b.filename,
      createdAt: typeof b.createdAt === 'string' ? b.createdAt : '',
      sizeBytes: typeof b.sizeBytes === 'number' ? b.sizeBytes : null,
      format: b.format || null,
      formatVersion: b.formatVersion || null,
      encrypted: !!b.encrypted,
      encryptionVersion: b.encryptionVersion !== undefined ? b.encryptionVersion : null,
      integrity: b.integrity || null,
      browser: b.browser || null,
      trigger: b.trigger || 'manual',
    });
  }
  backups.sort(
    (a, b2) => (b2.createdAt || '').localeCompare(a.createdAt || '') || (b2.id || '').localeCompare(a.id || '')
  );
  return {
    format: REMOTE_MANIFEST_ID,
    manifestVersion: REMOTE_MANIFEST_VERSION,
    updatedAt: obj.updatedAt || new Date().toISOString(),
    backups,
  };
}

export function upsertManifestEntry(manifest, entry) {
  const rest = (manifest.backups || []).filter((b) => b.id !== entry.id);
  const m = { ...manifest, backups: [...rest, entry] };
  return normalizeManifest(m);
}

// ---------------- upload safety guard (policy enforcement BELOW the UI) ----------------
//
// Repository visibility policy:
//   public  repo -> encrypted artifact REQUIRED (plaintext upload must FAIL here,
//                   in the storage layer — a UI bug cannot bypass this)
//   private repo -> encrypted or plaintext, only with an explicit user choice
//
// The guard also cross-checks the artifact's own consistency so a mislabeled
// artifact can never slip through.

export function assertUploadSafe(artifact, { repoPublic, plaintextAllowed = false } = {}) {
  if (!artifact || typeof artifact !== 'object' || typeof artifact.text !== 'string') {
    throw new TypedError('ERR_MALFORMED', 'Upload guard: invalid artifact.');
  }
  const obj = JSON.parse(artifact.text);
  const isEncryptedFormat = obj.format === ENCRYPTED_FORMAT_ID;
  const isPlainFormat = obj.format === FORMAT_ID;
  if (!isEncryptedFormat && !isPlainFormat) {
    throw new TypedError('ERR_UNKNOWN_FORMAT', 'Upload guard: not a browser backup artifact.');
  }
  if (artifact.encrypted !== isEncryptedFormat) {
    throw new TypedError(
      'ERR_MALFORMED',
      'Upload guard: artifact metadata contradicts its content (encrypted flag mismatch).'
    );
  }
  if (artifact.formatVersion !== obj.formatVersion) {
    throw new TypedError(
      'ERR_MALFORMED',
      'Upload guard: artifact metadata contradicts its content (version mismatch).'
    );
  }
  if (isPlainFormat && repoPublic === true) {
    throw new TypedError(
      'ERR_PUBLIC_REQUIRES_ENCRYPTION',
      'Upload rejected: this repository is PUBLIC and the backup is NOT encrypted. Browser backups contain session material (cookies, site storage); plaintext upload to a public repository is refused by policy.'
    );
  }
  if (isPlainFormat && !plaintextAllowed) {
    throw new TypedError(
      'ERR_PLAINTEXT_NOT_ALLOWED',
      'Upload rejected: plaintext (unencrypted) backup upload was not explicitly allowed for this operation.'
    );
  }
  return true;
}
