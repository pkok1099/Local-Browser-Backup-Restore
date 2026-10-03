// Encrypted backups: PBKDF2-HMAC-SHA-256 (600k iterations) -> AES-256-GCM with
// additional data binding the whole envelope header. Passwords are never stored,
// sent anywhere or logged. Implemented exclusively with the Web Crypto API.

import {
  TextEnc,
  TextDec,
  canonicalize,
  bytesToB64,
  b64ToBytes,
  gzipCompress,
  gzipDecompress,
  hasCompressionStream,
  TypedError,
} from './util.js';
import {
  ENCRYPTED_FORMAT_ID,
  FORMAT_VERSION,
  SUPPORTED_FORMAT_VERSIONS,
  KDF_DEFAULT,
  KDF_ITERATIONS_MAX,
  AEAD_DEFAULT,
} from './format.js';
import { ENCRYPTION_VERSION } from './artifact.js';

// Supported encryption-scheme versions (independent of the backup format
// version, so the encryption envelope can evolve on its own schedule).
const SUPPORTED_ENCRYPTION_VERSIONS = [1];

async function deriveKey(password, saltBytes, iterations) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    TextEnc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable: the derived key can never be read out
    ['encrypt', 'decrypt']
  );
}

function aadFor(env) {
  // encryptionVersion is included only when present: v2 envelopes created
  // before this field existed keep the exact same AAD bytes (backward
  // compatible), while new envelopes bind it as well.
  const aad = {
    format: env.format,
    formatVersion: env.formatVersion,
    compression: env.compression,
    kdf: {
      name: env.kdf.name,
      hash: env.kdf.hash,
      iterations: env.kdf.iterations,
      salt: env.kdf.salt,
    },
    aead: { algorithm: env.aead.algorithm },
    iv: env.aead.iv,
  };
  if (env.encryptionVersion !== undefined)
    aad.encryptionVersion = env.encryptionVersion;
  return canonicalize(aad);
}

// backupObj: a finalized (integrity-stamped) plaintext backup object.
export async function encryptBackup(backupObj, password) {
  if (!password || typeof password !== 'string' || password.length === 0) {
    throw new TypedError(
      'ERR_NO_PASSWORD',
      'A non-empty password is required.'
    );
  }
  const jsonStr = JSON.stringify(backupObj);
  const salt = crypto.getRandomValues(new Uint8Array(KDF_DEFAULT.saltBytes));
  const iv = crypto.getRandomValues(new Uint8Array(AEAD_DEFAULT.ivBytes));

  let compression = 'none';
  let plainBytes = TextEnc.encode(jsonStr);
  if (hasCompressionStream()) {
    try {
      const gz = await gzipCompress(plainBytes);
      if (gz && gz.length > 0) {
        plainBytes = gz;
        compression = 'gzip';
      }
    } catch (e) {
      compression = 'none';
      plainBytes = TextEnc.encode(jsonStr);
    }
  }

  const env = {
    format: ENCRYPTED_FORMAT_ID,
    formatVersion: FORMAT_VERSION,
    encryptionVersion: ENCRYPTION_VERSION,
    compression,
    kdf: {
      name: KDF_DEFAULT.name,
      hash: KDF_DEFAULT.hash,
      iterations: KDF_DEFAULT.iterations,
      salt: bytesToB64(salt),
    },
    aead: {
      algorithm: AEAD_DEFAULT.algorithm,
      iv: bytesToB64(iv),
    },
    ciphertext: '',
  };

  const key = await deriveKey(password, salt, KDF_DEFAULT.iterations);
  const ct = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: TextEnc.encode(aadFor(env)),
      tagLength: AEAD_DEFAULT.tagBits,
    },
    key,
    plainBytes
  );
  env.ciphertext = bytesToB64(new Uint8Array(ct));
  return env;
}

// Returns the plaintext backup JSON string. Throws TypedError('ERR_DECRYPT_FAILED')
// on wrong password / tampering (GCM authentication failure).
export async function decryptBackup(envelope, password) {
  if (!envelope || envelope.format !== ENCRYPTED_FORMAT_ID) {
    throw new TypedError(
      'ERR_NOT_ENCRYPTED_BACKUP',
      'Not an encrypted backup file.'
    );
  }
  if (!SUPPORTED_FORMAT_VERSIONS.includes(envelope.formatVersion)) {
    throw new TypedError(
      'ERR_UNSUPPORTED_VERSION',
      `Encrypted format version ${envelope.formatVersion} is not supported (this extension supports v${SUPPORTED_FORMAT_VERSIONS.join(', ')}).`
    );
  }
  if (
    envelope.encryptionVersion !== undefined &&
    !SUPPORTED_ENCRYPTION_VERSIONS.includes(envelope.encryptionVersion)
  ) {
    throw new TypedError(
      'ERR_UNSUPPORTED_ENCRYPTION_VERSION',
      `Encryption scheme version ${envelope.encryptionVersion} is not supported by this extension (supported: v${SUPPORTED_ENCRYPTION_VERSIONS.join(', ')}). Update the extension to open this backup.`
    );
  }
  if (
    !envelope.kdf ||
    !envelope.kdf.salt ||
    !envelope.kdf.iterations ||
    !envelope.aead ||
    !envelope.aead.iv ||
    !envelope.ciphertext
  ) {
    throw new TypedError(
      'ERR_MALFORMED_ENVELOPE',
      'Encrypted backup envelope is malformed.'
    );
  }
  if (!password || typeof password !== 'string' || password.length === 0) {
    throw new TypedError(
      'ERR_NO_PASSWORD',
      'A password is required to open this backup.'
    );
  }
  // The iteration count comes from the untrusted file and PBKDF2 runs BEFORE
  // the GCM tag is verified — reject absurd values first (DoS guard).
  const iterations = envelope.kdf.iterations;
  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > KDF_ITERATIONS_MAX
  ) {
    throw new TypedError(
      'ERR_MALFORMED_ENVELOPE',
      `Encrypted backup has an invalid KDF iteration count (${String(iterations)}).`
    );
  }

  const saltBytes = b64ToBytes(envelope.kdf.salt);
  const key = await deriveKey(password, saltBytes, iterations);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: b64ToBytes(envelope.aead.iv),
        additionalData: TextEnc.encode(aadFor(envelope)),
        tagLength: AEAD_DEFAULT.tagBits,
      },
      key,
      b64ToBytes(envelope.ciphertext)
    );
  } catch (e) {
    // GCM tag mismatch: wrong password OR corrupted/tampered ciphertext.
    throw new TypedError(
      'ERR_DECRYPT_FAILED',
      'Decryption failed: wrong password, or the encrypted file is corrupted/tampered with.'
    );
  }

  let bytes = new Uint8Array(plain);
  if (envelope.compression === 'gzip') {
    try {
      bytes = await gzipDecompress(bytes);
    } catch (e) {
      throw new TypedError(
        'ERR_DECOMPRESSION_FAILED',
        'Could not decompress decrypted payload — file may be corrupted.'
      );
    }
  }
  try {
    return TextDec.decode(bytes);
  } catch (e) {
    throw new TypedError(
      'ERR_UTF8_DECODE',
      'Decrypted payload is not valid UTF-8 — file may be corrupted.'
    );
  }
}
