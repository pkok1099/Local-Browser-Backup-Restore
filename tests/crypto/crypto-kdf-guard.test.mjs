// Test: decryptBackup rejects absurd kdf.iterations BEFORE running PBKDF2
// (DoS guard). A malicious envelope with iterations: 999999999 must throw
// ERR_MALFORMED_ENVELOPE immediately instead of hanging in key derivation.
import assert from 'node:assert/strict';
import { decryptBackup } from '../../src/lib/crypto.js';
import {
  ENCRYPTED_FORMAT_ID,
  FORMAT_VERSION,
  KDF_ITERATIONS_MAX,
} from '../../src/lib/format.js';
import { ENCRYPTION_VERSION } from '../../src/lib/artifact.js';

const envelope = {
  format: ENCRYPTED_FORMAT_ID,
  formatVersion: FORMAT_VERSION,
  encryptionVersion: ENCRYPTION_VERSION,
  kdf: {
    name: 'PBKDF2',
    hash: 'SHA-256',
    iterations: 999999999,
    salt: btoa('0123456789abcdef'),
  },
  aead: { algorithm: 'AES-256-GCM', iv: btoa('0123456789ab') },
  ciphertext: btoa('x'),
};

// Must reject fast: race against a timeout — without the guard, PBKDF2 with
// ~1e9 iterations would never settle (the shell `timeout` around this script
// proves the red state by killing the hang).
let timeoutHandle;
const timeout = new Promise((_, reject) => {
  timeoutHandle = setTimeout(
    () =>
      reject(
        new Error('decrypt did not reject in time — KDF ran before validation')
      ),
    5000
  );
});
try {
  await assert.rejects(
    Promise.race([decryptBackup(envelope, 'password'), timeout]),
    (e) => e && e.code === 'ERR_MALFORMED_ENVELOPE',
    'absurd kdf.iterations should throw ERR_MALFORMED_ENVELOPE before key derivation'
  );
} finally {
  clearTimeout(timeoutHandle);
}

// Boundary: iterations exactly at the cap pass validation (they then fail
// GCM auth with ERR_DECRYPT_FAILED — the expensive KDF is bounded).
const capEnvelope = {
  ...envelope,
  kdf: { ...envelope.kdf, iterations: KDF_ITERATIONS_MAX },
};
await assert.rejects(
  decryptBackup(capEnvelope, 'password'),
  (e) => e && e.code === 'ERR_DECRYPT_FAILED',
  'iterations at the cap should fail at GCM auth, not at validation'
);

// Non-integer / negative iterations are malformed too.
for (const bad of [1.5, -3, Number.NaN]) {
  const badEnvelope = {
    ...envelope,
    kdf: { ...envelope.kdf, iterations: bad },
  };
  await assert.rejects(
    decryptBackup(badEnvelope, 'password'),
    (e) => e && e.code === 'ERR_MALFORMED_ENVELOPE',
    `iterations ${String(bad)} should be ERR_MALFORMED_ENVELOPE`
  );
}

console.log('PASS crypto KDF guard: absurd iterations rejected before PBKDF2');
