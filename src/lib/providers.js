// StorageProvider contract + implementations.
//
//   StorageProvider (abstract contract)
//   ├── LocalStorageProvider        functional (chrome.storage.local durable copy)
//   └── GitHubStorageProvider       functional  — see lib/github.js
//
// Contract (simplest practical interface). Providers operate on the FINAL
// backup artifact (see lib/artifact.js) — never on browser data:
//
//   connect()                  → provider/repo info (auth + reachability)
//   listBackups()              → [BackupRef] (id, filename, createdAt, sizeBytes, encrypted, ...)
//   uploadBackup(artifact, o)  → { verified: true, id, ... } — MUST verify the remote object
//   downloadBackup(ref)        → { text, sha256Hex } — bytes of the stored artifact
//   deleteBackup(ref)          → true
//   getMetadata(ref)           → BackupRef + provider-specific fields
//   verifyRemoteObject(ref, expectedSha256) → { ok, ... }
//
// Providers MUST enforce the plaintext-safety guard themselves (assertUploadSafe)
// so a UI bug cannot bypass policy. Error messages never contain secrets.

import { TypedError, sha256Hex } from './util.js';
import { assertUploadSafe } from './artifact.js';

export class BackupRef {
  constructor(fields) {
    Object.assign(this, fields);
  }
}

// ---------------- base class ----------------

export class StorageProvider {
  static get id() {
    return 'base';
  }

  get id() {
    return this.constructor.id;
  }

  connect() {
    return Promise.reject(
      new TypedError(
        'ERR_PROVIDER_NOT_IMPLEMENTED',
        'connect() not implemented'
      )
    );
  }
  listBackups() {
    return Promise.reject(
      new TypedError(
        'ERR_PROVIDER_NOT_IMPLEMENTED',
        'listBackups() not implemented'
      )
    );
  }
  uploadBackup(_artifact, _options) {
    return Promise.reject(
      new TypedError(
        'ERR_PROVIDER_NOT_IMPLEMENTED',
        'uploadBackup() not implemented'
      )
    );
  }
  downloadBackup(_ref) {
    return Promise.reject(
      new TypedError(
        'ERR_PROVIDER_NOT_IMPLEMENTED',
        'downloadBackup() not implemented'
      )
    );
  }
  deleteBackup(_ref) {
    return Promise.reject(
      new TypedError(
        'ERR_PROVIDER_NOT_IMPLEMENTED',
        'deleteBackup() not implemented'
      )
    );
  }
  getMetadata(_ref) {
    return Promise.reject(
      new TypedError(
        'ERR_PROVIDER_NOT_IMPLEMENTED',
        'getMetadata() not implemented'
      )
    );
  }
  verifyRemoteObject(_ref, _expectedSha256) {
    return Promise.reject(
      new TypedError(
        'ERR_PROVIDER_NOT_IMPLEMENTED',
        'verifyRemoteObject() not implemented'
      )
    );
  }
}

// ---------------- LocalStorageProvider ----------------
//
// Durable local copy inside the extension's own storage area (unlimitedStorage).
// Used as the "local durable copy" step of the cloud pipeline (a cloud failure
// must never destroy a successful local backup) and as a provider in its own
// right. Key layout: bbr:artifact:<id> → { meta, text }; bbr:local-manifest →
// manifest JSON (mirror of the remote manifest shape).

const LS_KEY = (id) => `bbr:artifact:${id}`;
const LS_MANIFEST = 'bbr:local-manifest';

export class LocalStorageProvider extends StorageProvider {
  static get id() {
    return 'local';
  }

  connect() {
    return Promise.resolve({
      ok: true,
      provider: this.id,
      storage: 'chrome.storage.local',
    });
  }

  async #readManifestRaw() {
    const o = await chrome.storage.local.get(LS_MANIFEST);
    return o[LS_MANIFEST] || null;
  }

  async #writeManifest(manifest) {
    await chrome.storage.local.set({ [LS_MANIFEST]: manifest });
  }

  async uploadBackup(
    artifact,
    { manifestEntry = null, plaintextAllowed = false } = {}
  ) {
    // The local area is not a public repository, but the same guard runs so
    // local mirrors can never diverge from the policy decisions.
    assertUploadSafe(artifact, { repoPublic: false, plaintextAllowed });
    const meta = manifestEntry || {
      id: artifact.id,
      filename: artifact.filename,
      createdAt: artifact.createdAt,
      sizeBytes: artifact.sizeBytes,
      format: artifact.formatId,
      formatVersion: artifact.formatVersion,
      encrypted: artifact.encrypted,
      encryptionVersion: artifact.encryptionVersion,
      integrity: {
        algorithm: 'sha256',
        encoding: 'utf8',
        digest: artifact.sha256Hex,
      },
      browser: artifact.browser,
      trigger: artifact.trigger,
    };
    await chrome.storage.local.set({
      [LS_KEY(artifact.id)]: { meta, text: artifact.text },
    });
    const raw = await this.#readManifestRaw();
    const manifest = raw || {
      format: 'browser-backup-remote-manifest',
      manifestVersion: 1,
      updatedAt: new Date().toISOString(),
      backups: [],
    };
    manifest.backups = [
      ...(manifest.backups || []).filter((b) => b.id !== meta.id),
      meta,
    ];
    manifest.updatedAt = new Date().toISOString();
    await this.#writeManifest(manifest);
    // verify the stored object by reading it back
    const stored = await chrome.storage.local.get(LS_KEY(artifact.id));
    const sha = await sha256Hex(stored[LS_KEY(artifact.id)].text);
    if (sha !== artifact.sha256Hex) {
      throw new TypedError(
        'ERR_VERIFY_FAILED',
        'Local copy verification failed after write.'
      );
    }
    return { verified: true, id: artifact.id, sha256Hex: sha };
  }

  async #manifest() {
    const raw = await this.#readManifestRaw();
    if (!raw) return [];
    return (raw.backups || [])
      .slice()
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  async listBackups() {
    return (await this.#manifest()).map(
      (b) => new BackupRef({ ...b, provider: this.id })
    );
  }

  async downloadBackup(ref) {
    const id = typeof ref === 'string' ? ref : ref.id;
    const o = await chrome.storage.local.get(LS_KEY(id));
    const rec = o[LS_KEY(id)];
    if (!rec)
      throw new TypedError('ERR_NOT_FOUND', `Local backup "${id}" not found.`);
    return { text: rec.text, sha256Hex: await sha256Hex(rec.text) };
  }

  async deleteBackup(ref) {
    const id = typeof ref === 'string' ? ref : ref.id;
    await chrome.storage.local.remove(LS_KEY(id));
    const raw = await this.#readManifestRaw();
    if (raw) {
      raw.backups = (raw.backups || []).filter((b) => b.id !== id);
      raw.updatedAt = new Date().toISOString();
      await this.#writeManifest(raw);
    }
    return true;
  }

  async getMetadata(ref) {
    const id = typeof ref === 'string' ? ref : ref.id;
    const all = await this.#manifest();
    const m = all.find((b) => b.id === id);
    if (!m)
      throw new TypedError('ERR_NOT_FOUND', `Local backup "${id}" not found.`);
    return new BackupRef({ ...m, provider: this.id });
  }

  async verifyRemoteObject(ref, expectedSha256) {
    try {
      const { text } = await this.downloadBackup(ref);
      const sha = await sha256Hex(text);
      return { ok: sha === expectedSha256, sha256Hex: sha, expectedSha256 };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}
