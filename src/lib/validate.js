// Backup file validation: structure, format id, version, integrity digest,
// semantic sanity. Produces typed errors so the UI (and tests) can distinguish
// wrong-password vs corrupted-file vs unsupported-version.

import { TypedError } from './util.js';
import { FORMAT_ID, SUPPORTED_FORMAT_VERSIONS, verifyIntegrity } from './format.js';
import { decryptBackup } from './crypto.js';

function metaFromEnvelope(env) {
  return {
    encrypted: true,
    formatVersion: env.formatVersion,
    kdf: env.kdf ? { name: env.kdf.name, hash: env.kdf.hash, iterations: env.kdf.iterations } : null,
    cipher: env.aead ? env.aead.algorithm : null,
    compression: env.compression || 'none',
  };
}

function semanticChecks(backup) {
  const warnings = [];
  const counts = backup.counts || {};
  const data = backup.data || {};
  if (data.bookmarks && typeof counts.bookmarks === 'number') {
    let n = 0,
      f = 0;
    const walk = (nodes) => {
      for (const x of nodes) {
        if (x.type === 'folder') {
          f++;
          walk(x.children || []);
        } else n++;
      }
    };
    for (const r of Object.values(data.bookmarks.roots || {})) walk(r.children || []);
    if (n !== counts.bookmarks || f !== (counts.bookmarkFolders || 0)) {
      warnings.push(
        `counts.bookmarks (${counts.bookmarks}/${counts.bookmarkFolders}) does not match data (${n} bookmarks / ${f} folders)`
      );
    }
  }
  if (data.history && typeof counts.history === 'number' && data.history.items.length !== counts.history) {
    warnings.push(`counts.history (${counts.history}) does not match data (${data.history.items.length})`);
  }
  if (data.cookies && typeof counts.cookies === 'number' && data.cookies.cookies.length !== counts.cookies) {
    warnings.push(`counts.cookies (${counts.cookies}) does not match data (${data.cookies.cookies.length})`);
  }
  if (data.tabsWindows && typeof counts.tabs === 'number') {
    const t = data.tabsWindows.windows.reduce((a, w) => a + (w.tabs || []).length, 0);
    if (t !== counts.tabs) warnings.push(`counts.tabs (${counts.tabs}) does not match data (${t})`);
  }
  if (data.siteData && typeof counts.siteDataOrigins === 'number') {
    const n = Object.keys(data.siteData.origins || {}).length;
    if (n !== counts.siteDataOrigins)
      warnings.push(`counts.siteDataOrigins (${counts.siteDataOrigins}) does not match data (${n})`);
  }
  const empty = Object.keys(data).length === 0;
  if (empty) warnings.push('backup contains no data categories');
  return warnings;
}

// text: raw file content (JSON string).
// password: required for encrypted files (pass empty/null to only get envelope meta).
export async function validateBackupFile(text, { password } = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new TypedError('ERR_EMPTY_FILE', 'File is empty.');
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new TypedError('ERR_PARSE', 'File is not valid JSON — it is corrupted, truncated or not a backup file.', {
      parseError: e.message,
    });
  }

  if (obj && obj.format === 'chrome-local-backup-encrypted') {
    const meta = metaFromEnvelope(obj);
    const plain = await decryptBackup(obj, password);
    let inner;
    try {
      inner = JSON.parse(plain);
    } catch (e) {
      throw new TypedError('ERR_PARSE', 'Decrypted payload is not valid JSON — file is corrupted.');
    }
    return validatePlain(inner, { encrypted: true, envelopeMeta: meta });
  }

  return validatePlain(obj, { encrypted: false });
}

async function validatePlain(backup, { encrypted, envelopeMeta } = {}) {
  if (!backup || typeof backup !== 'object') {
    throw new TypedError('ERR_UNKNOWN_FORMAT', 'File is not a browser backup.');
  }
  if (backup.format !== FORMAT_ID) {
    throw new TypedError(
      'ERR_UNKNOWN_FORMAT',
      `Unknown format "${backup.format}" — expected "${FORMAT_ID}". This is not a valid backup file.`
    );
  }
  if (!SUPPORTED_FORMAT_VERSIONS.includes(backup.formatVersion)) {
    throw new TypedError(
      'ERR_UNSUPPORTED_VERSION',
      `Backup format version ${backup.formatVersion} is not supported (this extension reads v${SUPPORTED_FORMAT_VERSIONS.join(', ')}).`
    );
  }
  if (backup.formatVersion === 1) {
    // v1 upgrade path: no categoryVersions, no per-category digests, no siteData.
    // verifyIntegrity handles the missing pieces; normalize in memory.
    backup.categoryVersions = backup.categoryVersions || {};
  }
  if (backup.formatVersion >= 2 && backup.categoryVersions) {
    for (const [cat, ver] of Object.entries(backup.categoryVersions)) {
      if (typeof ver !== 'number' || ver < 1) {
        throw new TypedError('ERR_MALFORMED', `categoryVersions["${cat}"] is malformed.`);
      }
    }
  }
  if (!backup.data || typeof backup.data !== 'object') {
    throw new TypedError('ERR_MALFORMED', 'Backup has no data section.');
  }
  await verifyIntegrity(backup); // MUST be awaited — throws ERR_NO_INTEGRITY / ERR_CHECKSUM_MISMATCH
  const warnings = semanticChecks(backup);
  return {
    encrypted: !!encrypted,
    envelopeMeta: envelopeMeta || null,
    backup,
    warnings,
  };
}
