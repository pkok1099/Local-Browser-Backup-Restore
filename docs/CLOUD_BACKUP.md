# Cloud Backup (GitHub) — Design, Setup & Security

**Stage:** GitHub Cloud Backup + Encryption + Automatic Scheduler (extension v1.3.0).
**Scope of this stage:** GitHub storage provider, repository-visibility encryption policy, upload/download verification, daily/weekly scheduler with catch-up, and token-safe settings transfer. WebDAV and Google Drive are architectural placeholders only (see §12).

---

## 1. Architecture

```
Browser Data
      ↓  collectors (chrome.* APIs + debugger CDP path — unchanged, proven in stages 1–7)
Backup Engine            (dashboard extension page)
      ↓
Backup Artifact          Format v2 (chrome-local-backup, formatVersion 2)
      ↓  serialize
      ↓  encrypt when required (policy §4)
Encrypted Backup Envelope  (chrome-local-backup-encrypted, encryptionVersion 1)
      ↓
LOCAL DURABLE COPY       chrome.storage.local (LocalStorageProvider) — always first
      ↓
StorageProvider          GitHubStorageProvider — Contents API
      ↓  upload → VERIFY REMOTE OBJECT → manifest update
GitHub repository
```

The storage layer never knows how browser data is collected: providers receive the final artifact bytes only. There is no code path from a collector to a provider.

### StorageProvider contract

```
connect()                  → auth + reachability + repo info (visibility)
listBackups()              → [BackupRef]
uploadBackup(artifact, o)  → { verified: true, ... }   (verifies the remote object internally)
downloadBackup(ref)        → { text, sha256Hex }
deleteBackup(ref)          → true
getMetadata(ref)           → BackupRef
verifyRemoteObject(ref, sha256) → { ok, ... }
```

Implementations:

| Provider | Status |
|---|---|
| `LocalStorageProvider` | functional — durable local copies inside the extension's `chrome.storage.local` (`unlimitedStorage`) |
| `GitHubStorageProvider` | functional — GitHub Contents API |
| `WebDAVStorageProvider` | placeholder — constructor throws `ERR_PROVIDER_NOT_IMPLEMENTED`; contains no network code |
| `GoogleDriveStorageProvider` | placeholder — constructor throws `ERR_PROVIDER_NOT_IMPLEMENTED`; contains no network/OAuth code |

## 2. GitHub setup

1. Create a repository for your backups (private is strongly recommended even though encryption makes public repos technically safe).
2. Create a personal access token (fine-grained recommended):
   - **Fine-grained PAT:** Repository access → only the backup repository; Permissions → **Contents: Read and write**. Nothing else.
   - **Classic PAT:** `repo` scope (required to push; private repos are invisible to tokens without it).
3. In the extension dashboard → *Cloud backup* → Provider **GitHub**, paste the token, owner, repository, optionally branch and backup path, then **Connect & check repository**. The extension reads the repository's real visibility from the API — you never declare public/private yourself.
4. **Save settings.** The token is stored only in this browser profile's `chrome.storage.local`. It is sent ONLY to `api.github.com` and never logged or embedded in errors.

No backend server exists. The extension talks to GitHub directly. No telemetry, no analytics.

## 3. Repository layout

Deterministic layout inside the repository (basePath configurable, default `browser-backups`):

```
browser-backups/
    manifest.json
    backups/
        backup-<timestamp>-<id>.bbr
```

- Every backup has a unique id; nothing is blindly overwritten (a PUT updates a path only with its exact prior git blob sha).
- `manifest.json` (`browser-backup-remote-manifest`, version 1) lists per backup: **id, filename, creation timestamp, size, format id, format version, encrypted flag, encryption version, integrity digest (SHA-256 of the exact artifact bytes), browser/environment metadata, trigger**.
- Filenames and the manifest contain **no browser-derived content** — no URLs, titles, origins, counts or cookie material. Knowing the repository contents reveals nothing about which sites you visited.
- Manifest listing falls back to a directory scan of `backups/` if the manifest is missing or unreadable.

## 4. Public/private repository encryption policy (enforced in code)

| Repository | Policy | Enforcement |
|---|---|---|
| **Public** | Encryption **required** | `assertUploadSafe()` in the storage layer rejects any plaintext artifact with `ERR_PUBLIC_REQUIRES_ENCRYPTION` — even if the UI incorrectly requests it (`plaintextAllowed: true`). The UI additionally disables the "disabled" option. |
| **Private** | User choice | Encryption enabled (default) or explicit plaintext upload after an explicit confirmation dialog. |

- The guard lives **below the UI** (provider + orchestrator), so a future UI bug cannot leak plaintext to a public repository. Automated regression: run-L §1/§3 and run-M phase 3.
- The extension detects visibility via `GET /repos/{owner}/{repo}` at connect time and re-derives the policy on every upload; the user is never asked to declare visibility manually.
- The user's encryption preference is stored (`enabled`/`disabled`); for public repositories it is overridden to required regardless of the stored choice.

## 5. Encryption design

Unchanged from the audited stage, plus an independent envelope version:

- **AEAD:** AES-256-GCM (256-bit key, 128-bit tag, fresh random 96-bit IV per artifact), Web Crypto only. No custom cryptography.
- **KDF:** PBKDF2-HMAC-SHA-256, **600,000 iterations** (OWASP 2024), 16-byte random salt. Derived key is non-extractable. `SHA-256(password)` is never used anywhere.
- **AAD binding:** the entire envelope header (format id, format version, compression, KDF params + salt, AEAD algorithm, IV, **encryptionVersion**) is bound as GCM additional data — parameter swaps/downgrades fail closed.
- **`encryptionVersion: 1`** is versioned independently from the backup format version, so encryption can evolve without touching Format v2. Unknown future values are rejected with `ERR_UNSUPPORTED_ENCRYPTION_VERSION` before any decryption is attempted. Envelopes created before this field existed remain readable (the field joins the AAD only when present).
- **Envelope fields** (non-secret, needed for restore): salt, KDF name/hash/iterations, algorithm/version, nonce/IV, compression, ciphertext. The password is **never** stored, logged or sent to GitHub; it exists only in page memory for the duration of an operation.
- **Integrity:** two independent layers — AEAD authentication and the artifact's own SHA-256 digests (whole + per-category, Format v2). The remote manifest adds a third: the downloaded artifact's SHA-256 is compared against the digest recorded at upload time.
- **Wrong password vs corrupted ciphertext:** both fail GCM authentication and produce the same typed error (`ERR_DECRYPT_FAILED`). This is honest AEAD semantics — the ciphertext cannot distinguish them without weakening the construction. Structural corruption (invalid JSON/base64) yields `ERR_PARSE` / `ERR_MALFORMED_ENVELOPE` instead.

## 6. Upload pipeline (integrity)

```
create backup → validate (finalizeIntegrity) → encrypt if required →
calculate SHA-256 → LOCAL durable copy → upload to GitHub →
VERIFY REMOTE OBJECT (re-download; compare SHA-256 AND git blob sha1) →
update remote manifest → mark upload successful
```

An HTTP 2xx alone is never treated as success. `uploadBackup()` re-downloads the artifact it just stored and fails with `ERR_VERIFY_FAILED` unless the bytes match both digests.

## 7. Download + restore from GitHub

```
GitHub → download artifact → verify vs manifest digest → validate envelope →
decrypt if encrypted (password requested only when needed) → validate backup
(integrity) → restore → verify
```

- Both encrypted backups and plaintext private-repository backups are supported.
- Incorrect passwords (`ERR_DECRYPT_FAILED`), corrupted artifacts (`ERR_CHECKSUM_MISMATCH` / `ERR_DECRYPT_FAILED`), and unsupported versions (`ERR_UNSUPPORTED_VERSION` / `ERR_UNSUPPORTED_ENCRYPTION_VERSION`) are rejected with distinct typed errors before any browser data is touched.

## 8. Automatic daily/weekly scheduler

- Mechanism: `chrome.alarms` — a periodic 15-minute check (`bbr-schedule-check`), re-armed on install/startup and after every fire. The scheduler does **not** assume any process is continuously alive.
- The service worker only *decides*; the heavy collection always runs in the dashboard extension page (the architecture proven in earlier stages). When due, the worker opens `dashboard.html?action=cloud-scheduled` (background tab) which performs the run and records the outcome; on success the tab closes itself, on failure it stays open and visible.
- Configuration: **Automatic Backup ON/OFF, Frequency: Daily or Weekly, selected weekdays for weekly schedules, Time (e.g. 12:00)** — stored in `bbr:cloud-config` together with `lastAttempt`, `lastSuccessfulBackupAt`, `lastSuccessfulBackupId`, `lastResult`, `lastError`. No browser data in scheduler state. Older configs without a frequency remain daily.

### Catch-up (missed schedule)

- The decision uses the last **successful** backup, never the last attempt.
- 12:00 scheduled, browser closed at 11:00, opened at 15:30 → on startup the check sees no success after today's 12:00 → **catch-up run** (`reason: catch-up`).
- Success already recorded after today's scheduled time → **no duplicate** (`already-succeeded-today`). A manual morning backup does not suppress the 12:00 slot; a successful 12:05 scheduled run suppresses further runs that day.
- A failed attempt retries with a 10-minute backoff (no hammering; next alarm retries).
- Weekly schedules use local weekday/time. A missed slot on a selected day catches up once when the browser next runs on a selected day; non-selected days do not trigger backups.

Settings can be exported/imported as versioned JSON. The file contains provider preferences, repository coordinates, encryption/retry/retention choices, and schedule settings, but omits the GitHub token and all runtime/pending backup data. Import validates before saving and preserves the destination profile's existing token.

### Scheduled runs and the encryption password

- The password is never written to disk. When you run an encrypted cloud backup from the dashboard, the password is kept in `chrome.storage.session` (RAM-only, cleared when the browser closes) so scheduled runs in the same browser session can encrypt without user interaction.
- If encryption is required and no password is available (fresh browser session), the scheduled run **refuses before collecting any data** and records `ERR_NO_PASSWORD` in the scheduler state — it never falls back to plaintext. Open the dashboard once (any encrypted cloud backup) to re-enable scheduled encryption for that session.
- Scheduled plaintext runs (private repository + explicit choice recorded in settings) need no password and work unattended.

## 9. Cloud failure handling

```
Local backup SUCCESS → Encryption SUCCESS → GitHub upload FAILED
```

- The local durable copy is written **before** any remote upload; a cloud failure never destroys it.
- The failed artifact is recorded as a *pending upload* (`bbr:pending-upload`: id, timestamp, encrypted flag, digest — no browser data).
- The next run (scheduled catch-up, "Retry pending upload" button, or any manual run the same day) **re-syncs the exact same artifact** instead of re-collecting identical browser data. Pending artifacts from previous days are discarded.
- After a verified upload, optional retention (see §11) may clean up.

## 10. Retention

Implemented but **disabled by default** (config `retention: { enabled, keepLast }`, default keepLast 30). When enabled: after a new upload has been uploaded, remotely verified and its manifest updated, artifacts beyond the newest `keepLast` are deleted remotely and the manifest is rewritten. It is never destructive by default and never touches the newest backup.

## 11. Status & error surface

`Not configured · Ready · Backing up (collecting) · Encrypting · Uploading · Upload successful · Upload failed · Downloading · Decrypting · Restoring · Restore successful · Restore failed · Authentication failed · Repository not found · Public repository requires encryption · Wrong encryption password · Corrupted backup · Unsupported version · Password unavailable · Network error`

Typed errors map to these statuses (`statusFromError`). Secrets never appear in statuses, error messages, or logs: tokens are redacted from provider errors; passwords never leave page memory; cookie/storage values are never logged (long-standing rule from stage 1).

## 12. Placeholders (not implemented in this stage)

- **WebDAV** (`WebDAVStorageProvider`) and **Google Drive** (`GoogleDriveStorageProvider`) exist as architectural placeholders. Constructing them throws `ERR_PROVIDER_NOT_IMPLEMENTED`; they contain **no** network code, require no credentials, and cannot appear as working providers.
- Not implemented by design: WebDAV/Drive networking, Google OAuth, generic cloud backend, multi-provider sync, cross-provider deduplication, automatic destructive remote cleanup.

## 13. Security assumptions & limitations

- **Private ≠ safe-to-store-plaintext.** A plaintext backup in a private repository is still sensitive: anyone who gains access to that repository (a leaked token, a compromised account, an org member, a future misconfiguration) could read it. The backup contains cookies, session tokens and site storage — effectively your logged-in identity on those sites. Encryption is the default; disable it only with full awareness of this.
- **Token scope:** use the minimal scope (single repository, Contents read/write). The token can read/modify everything in that repository, including the backups — treat it like the backups themselves.
- **GitHub sees ciphertext only** when the policy is respected (encrypted upload). Metadata visible to GitHub: artifact sizes, timestamps, commit cadence, repository name.
- **PBKDF2 600k** protects against offline guessing of moderate passwords; a short/dictionary password still weakens the envelope. Use a long passphrase. Losing the password means the encrypted backup is unrecoverable — there is no recovery mechanism by design.
- **chrome.storage.session** holds the password in RAM between dashboard operations during one browser session. It never touches disk, but any code able to run inside the extension's own privileged context could read it (standard extension-trust assumption).
- **The local durable copy** follows the same encryption decision as the upload: encrypted runs store encrypted artifacts locally; explicit-plaintext runs store plaintext in the browser profile (protected by OS-level profile security, same as the browser's own data).
- **Manifest/commit metadata is visible** to anyone with repository access. It deliberately contains no browsing-derived content.
- Scheduler state, pending-upload markers and cloud state contain ids, timestamps and error codes only.

## 14. Files

| File | Role |
|---|---|
| `lib/providers.js` | StorageProvider contract, LocalStorageProvider, placeholders |
| `lib/github.js` | GitHubStorageProvider (auth, visibility, upload+verify, download, list, delete, manifest) |
| `lib/cloud.js` | orchestrator: policy, local-first pipeline, pending sync, retention, statuses |
| `lib/artifact.js` | remote artifact, manifest entries, `assertUploadSafe` guard |
| `lib/scheduler.js` | pure decision logic + state persistence |
| `lib/crypto.js` | AES-GCM envelope (now with `encryptionVersion`) |
| `background.js` | alarm scheduling + catch-up (opens the dashboard when due) |
| `dashboard.html/js` | cloud UI section + `__api.cloud` / `__api.scheduler` test hooks |
| `tests/run-L.mjs` | cloud unit tests vs GitHub API simulator (Node) |
| `tests/run-M.mjs` | cloud end-to-end tests (browser) |
| `tests/helpers/github-mock.mjs` | local GitHub REST API simulator |
