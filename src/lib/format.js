// Backup format v2: constants, skeleton, integrity computation/verification.
// Format documentation: docs/BACKUP_FORMAT.md
// v2 adds: per-category schema versions (categoryVersions), per-category
// integrity digests, and the siteData family of categories. v1 files remain
// readable (validate.js upgrades them transparently).

import { canonicalize, sha256Hex, TypedError } from './util.js';

export const FORMAT_ID = 'chrome-local-backup';
export const ENCRYPTED_FORMAT_ID = 'chrome-local-backup-encrypted';
export const FORMAT_VERSION = 2;
export const SUPPORTED_FORMAT_VERSIONS = [1, 2];

// Schema version of each data category, so a restore engine can tell whether a
// given section's internal shape is understood, independently of the overall
// format version.
export const CATEGORY_SCHEMA_VERSIONS = Object.freeze({
  bookmarks: 1,
  history: 1,
  tabsWindows: 1,
  sessions: 1,
  cookies: 1,
  downloads: 1,
  readingList: 1,
  extensionStorage: 1,
  installedExtensions: 1,
  extensionPermissions: 1,
  profile: 1,
  siteData: 1,
});

// OWASP 2024 guidance for PBKDF2-HMAC-SHA-256 is 600,000 iterations.
export const KDF_DEFAULT = Object.freeze({
  name: 'PBKDF2',
  hash: 'SHA-256',
  iterations: 600000,
  saltBytes: 16,
});

export const AEAD_DEFAULT = Object.freeze({
  algorithm: 'AES-256-GCM',
  ivBytes: 12,
  tagBits: 128,
});

export function newBackupSkeleton(capabilities, generatorInfo) {
  return {
    format: FORMAT_ID,
    formatVersion: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    generator: generatorInfo,
    capabilities: capabilities || {},
    categoryVersions: { ...CATEGORY_SCHEMA_VERSIONS },
    counts: {},
    data: {},
    integrity: null,
  };
}

// Integrity covers counts + data + capabilities + categoryVersions so that any
// modification of the payload (including category counts) invalidates the
// backup. Per-category digests localize corruption for diagnostics.
export async function finalizeIntegrity(backup) {
  const payload = canonicalize({
    counts: backup.counts,
    data: backup.data,
    capabilities: backup.capabilities,
    categoryVersions: backup.categoryVersions || {},
  });
  const categories = {};
  const entries = Object.entries(backup.data || {});
  const digests = await Promise.all(entries.map(([, section]) => sha256Hex(canonicalize(section))));
  for (let i = 0; i < entries.length; i++) categories[entries[i][0]] = digests[i];
  backup.integrity = {
    algorithm: 'sha256',
    canonicalization: 'json-sorted-keys-utf8',
    scope: 'counts+data+capabilities+categoryVersions',
    digest: await sha256Hex(payload),
    categories,
  };
  return backup;
}

export async function verifyIntegrity(backup, { skipCategories = false } = {}) {
  if (!backup || !backup.integrity || typeof backup.integrity.digest !== 'string') {
    throw new TypedError(
      'ERR_NO_INTEGRITY',
      'Backup has no integrity record — file may have been hand-edited or produced by an unknown tool.'
    );
  }
  // v1 digests cover {counts,data,capabilities} only; v2 adds categoryVersions.
  const isV1 = (backup.formatVersion || 1) < 2;
  const payload = canonicalize(
    isV1
      ? {
          counts: backup.counts,
          data: backup.data,
          capabilities: backup.capabilities,
        }
      : {
          counts: backup.counts,
          data: backup.data,
          capabilities: backup.capabilities,
          categoryVersions: backup.categoryVersions || {},
        }
  );
  const digest = await sha256Hex(payload);
  if (digest !== backup.integrity.digest) {
    throw new TypedError(
      'ERR_CHECKSUM_MISMATCH',
      'Integrity check failed: backup content does not match its SHA-256 digest. The file is corrupted or was modified after creation.'
    );
  }
  // v1 files have no per-category digests.
  if (!skipCategories && backup.integrity.categories && typeof backup.integrity.categories === 'object') {
    const entries = Object.entries(backup.integrity.categories);
    const digests = await Promise.all(
      entries.map(([name]) => {
        if (!(name in (backup.data || {}))) {
          throw new TypedError(
            'ERR_CHECKSUM_MISMATCH',
            `Integrity record lists category "${name}" which is missing from the data section.`
          );
        }
        return sha256Hex(canonicalize(backup.data[name]));
      })
    );
    for (let i = 0; i < entries.length; i++) {
      const [name, want] = entries[i];
      const got = digests[i];
      if (got !== want) {
        throw new TypedError(
          'ERR_CHECKSUM_MISMATCH',
          `Category "${name}" is corrupted (per-category digest mismatch).`
        );
      }
    }
  }
  return true;
}
