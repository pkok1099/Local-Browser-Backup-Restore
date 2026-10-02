# Security Review — pre-cloud (stage gate for cloud integration)

**Scope:** verify that the pipeline from browser data to stored artifact is safe to put a remote StorageProvider underneath. **No cloud code exists in this stage** — this document is the readiness assessment and the contract the providers must satisfy.

## 1. Current pipeline (audited)

```
Browser Data
      ↓  collectors (chrome.* APIs + page-context execution via chrome.debugger/scripting)
Backup Engine            (dashboard page, not the service worker)
      ↓
Versioned Backup Artifact      chrome-local-backup v2 (format + categoryVersions + integrity)
      ↓  [optional user password]
Encryption                    PBKDF2-HMAC-SHA-256 (600k) → AES-256-GCM (Web Crypto only)
      ↓
Encrypted Artifact            chrome-local-backup-encrypted v2 envelope
      ↓
Local file only               chrome.downloads.download() → user's Downloads folder
```

## 2. Encryption readiness (verified, Web Crypto only)

- **Authenticated encryption.** AES-256-GCM, 128-bit tag, fresh random 96-bit IV per artifact. Wrong password or tampered ciphertext fails closed (`ERR_DECRYPT_FAILED`).
- **KDF.** PBKDF2-HMAC-SHA-256, 600,000 iterations (OWASP 2024 guidance), 16-byte random salt. Derived key is non-extractable.
- **Header binding (AAD).** The entire envelope header — format id, format version, compression, KDF params + salt, AEAD algorithm, IV — is bound as GCM additional data. KDF-downgrade or parameter swapping is rejected (automated test D-E).
- **Integrity inside the plaintext.** Whole-file + per-category SHA-256 over canonical JSON — two independent layers (AEAD + artifact digest).
- **Password handling.** Never stored, never logged, never sent anywhere; kept in page memory only for the duration of the operation. Encrypted and plaintext formats are distinguishable ONLY by the `format` field — knowing it reveals nothing about content.
- **Compression before encryption** (gzip) — no CRIME-style risk: nothing secret crosses a shared-compression channel; the compressed bytes are the AES input.

## 3. Protection against accidental plaintext upload (contract for the next stage)

No upload path exists today. Before any provider is implemented, the following is REQUIRED (and trivially enforceable):

1. `StorageProvider.put()` accepts **only** the encrypted envelope object — assert `obj.format === 'chrome-local-backup-encrypted'` and `formatVersion` in the supported set; refuse everything else. Plaintext artifacts (`chrome-local-backup`) must fail the assert.
2. The provider interface receives bytes, never "backup objects" — there is no code path from a live collector to a provider.
3. Provider error messages must never include artifact content (names/domains only, mirroring the existing log hygiene).
4. The cloud architecture remains: everything left of `StorageProvider` runs locally; providers get an opaque encrypted blob.

A local unit test pins the envelope marker (plaintext must not validate as upload-safe) — included in the schema compatibility tests.

## 4. Local-only guarantees (re-verified this stage)

- **No network by the extension itself.** No fetch/XHR to any remote host in the codebase; the only fetches are (a) the extension's own `lib/pagelib.js` resource and (b) site pages through the debugger path to read *that site's* storage (SW script fetch uses the site's own URL). No CDN, no fonts, no analytics, no telemetry, no error reporting.
- **No remote code.** MV3 CSP; no eval in the isolated world (pagelib is injected as a file); no remote scripts.
- **No raw profile access.** Every byte in the artifact comes from browser APIs or page-context JavaScript. No LevelDB/SQLite parsing, no undocumented file layouts.
- **Log hygiene.** Cookie values, storage values and passwords are never logged; names/counts only (automated test A asserts redaction).
- **Incognito excluded** by design (tabs, windows, cookies).

## 5. Risk notes carried into the cloud stage

- The artifact contains cookies and site storage ⇒ session material. Cloud upload without the encrypted envelope must be structurally impossible (§3), and the UI must make "encrypted before upload" the default.
- `chrome.debugger` shows Chrome's "started debugging" infobar during site-data collection — visible, honest, inherent to the only working path (documented in UI + capability report).
- Backup artifacts downloaded via `chrome.downloads` inherit the user's Downloads-folder security; unchanged by cloud integration.

## 6. Readiness statement

**The architecture is ready for cloud-provider integration** (StorageProvider: Local / GitHub / WebDAV / Google Drive) under the constraints above:

- format stable and versioned (v2, with per-category schema versions and v1 compatibility),
- restore engine proven by destructive restore testing (run-K, 68 checks) and byte/value-level round trips (run-H, 55 checks) on Chrome 153,
- encryption is mandatory-by-contract *before* any provider sees the artifact, implemented with Web Crypto AEAD and header binding,
- plaintext upload is structurally preventable (envelope marker assert pinned by test).

No provider code was implemented in this stage, per the stage scope.

---

## 7. Stage outcome (cloud stage completed)

This readiness contract was implemented in the following stage (extension v1.2.0, see `docs/CLOUD_BACKUP.md`):

- StorageProvider abstraction with Local (functional), GitHub (functional), WebDAV/Google Drive (placeholders, no network code).
- GitHubStorageProvider enforces §3 item 1 in code: `assertUploadSafe()` rejects plaintext artifacts for public repositories **below the UI**, pinned by automated tests (run-L, run-M).
- Providers receive serialized artifact bytes only; there is still no path from collectors to providers (§3 item 2).
- Provider errors are secret-free; tokens are redacted from every error message (§3 item 3).
- Uploads are verified by re-downloading the remote object and comparing SHA-256 + git blob sha (stricter than §3 required).
