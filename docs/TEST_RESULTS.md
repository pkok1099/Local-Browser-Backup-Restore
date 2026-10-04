# Test Results — cloud stage (GitHub + Encryption + Scheduler)

> **Code optimization + E2E expansion (post-1.4.4, Chromium 152.0.7977.82 via
> Playwright under xvfb):**
>
> Code changes (behavior-preserving):
> - `src/lib/cloud.js`: extracted `maybeDownloadLocalCopy()` (local-download
>   step for destination `both`, used by the fresh-backup and pending-sync
>   paths) and `updateRemoteManifest()` (read→upsert→write, used by
>   `runCloudBackup` and `syncPendingArtifact`); removed the dead
>   `setCloudPhaseSilent` stub; pipeline step comments renumbered 1–10.
> - `src/dashboard/cloud-ui.ts`: removed the unused `form` variable + `void form;`
>   no-op in `refreshCloudUI()`.
> - `tests/extension-ui.mjs`: `launchPersistentContext` now honors
>   `CHROMIUM_PATH` like `chromium.launch` already did (lets the suite run
>   against a system Chromium).
>
> New suites (see `docs/E2E.md`):
> - `npm test` (Node): existing 6 suites + `tests/cloud/cloud-provider-guard.mjs`
>   (provider-layer plaintext policy over real HTTP against the simulator) +
>   `tests/sitedata/sitedata-tab-cleanup.mjs` (scan tabs always closed, incl.
>   never-ready tabs and midway open failures) +
>   `tests/dashboard/theme-mode.mjs` (dashboard theme module: boot, persistence,
>   system-follow) — all PASS.
> - `npm run test:e2e` (new): `local-roundtrip` (seed → encrypted file via real
>   `chrome.downloads` → destroy → wrong-password rejected → restore exact →
>   idempotent), `cloud-roundtrip` (connect, verified encrypted upload,
>   manifest, secret hygiene, wrong password, remote-tamper rejection,
>   injected 500 → pending retry → sync-retry uploads the SAME artifact,
>   public/private × plaintext/encrypted policy matrix), `scheduler-roundtrip`
>   (catch-up decision, scheduled run, duplicate prevention, disabled
>   schedule, passwordless refusal), `sitedata-tabs` (batched collection: new
>   `BBR Site Scan` tab group → open-all-first → concurrent reads →
>   `(n/N)` progress with accurate monotonic frac → clean teardown),
>   `theme-toggle` (dark mode: toggle cycles, colors change, persists) — all
>   PASS, zero page errors.
> - `npm run test:ui` (`tests/extension-ui.mjs`): PASS unchanged with the
>   refactored code — no regressions.
> - `npm run compile` (`tsc --noEmit`): 0 errors.

> **v1.4.0 migration (WXT + React + shadcn/ui) — re-verification, Chromium 153.0.8010.12 (Playwright build):**
>
> - `npm test` (Node): `cloud-retry` + `schedule-settings` suites PASS unchanged — the ported
>   `src/lib/*.js` core is byte-identical to v1.3.0, so destination/retry policy, weekly weekday
>   normalization, due decisions and token-safe settings transfer behave exactly the same.
> - `npx tsc --noEmit`: 0 errors (React + TSX layer, chrome types via @wxt-dev/browser).
> - `npm run test:ui` (`tests/extension-ui.mjs`, loads the REAL built MV3 extension):
>   - built manifest: MV3, no `default_popup`, `chrome.action.onClicked` opens the dashboard,
>     `lib/pagelib.js` present at the extension root for `chrome.scripting` injection;
>   - live dashboard at 360 px and 390 px: no horizontal overflow, all buttons ≥ 44 px touch targets;
>   - weekly/daily schedule toggle: weekday checkboxes appear for Weekly with the Mon–Fri default
>     and disappear for Daily (7 days offered);
>   - settings import: destination token preserved, unsupported version rejected leaving settings
>     unchanged; settings export never contains the token;
>   - pending-upload retry status shows "Retry 1/8 scheduled"; cancelling keeps the pending
>     artifact, sets `retryCancelled`, clears `retryAt`, and survives a reload;
>   - local restore flow and encrypted-backup password dialog open correctly; zero page errors.
> - All v1.3.0 behavior (Format v2, crypto envelope, provider contract, public-repo encryption
>   guard, scheduler, catch-up) is untouched — the results below remain valid for the core.

**Browser:** Chrome for Testing **153.0.8010.36** (pinned — all results in this repo come from this build)
**Runner:** `node tests/run-all.mjs` (sequential, per-test process isolation)
**Result:** **ALL PASS — 11/11 suites** (9 proven suites re-run green + 2 new cloud suites)

| Suite | Checks | What it proves |
|---|---|---|
| probe-apis | — | runtime API-surface probe (capability claims start from reality) |
| run-A (export) | ✅ | data collection → v2 artifact → in-browser validation (integrity, categoryVersions, per-category digests, siteData section) → end-to-end file save via `chrome.downloads` |
| run-B (restore) | ✅ | fresh profile → restore → bookmarks (hierarchy/order/titles), cookies (all attributes incl. CHIPS back into its partition), tabs/windows/groups (URL/pinned/muted/geometry), reading list, sessions reopen, history basic, downloads metadata |
| run-C (encrypted) | ✅ | PBKDF2 600k + AES-256-GCM v2 envelope, gzip, no plaintext leakage |
| run-D+E (rejection) | ✅ | wrong password, empty password, truncated, modified (checksum), foreign format, future version, flipped ciphertext, KDF downgrade (AAD), empty file, non-JSON — all rejected with correct error codes |
| run-F (repeat) | ✅ | double restore idempotent (merge) |
| run-G (large) | ✅ | 1052 bookmarks / 1201 history / 400 cookies / 150 reading list / 40 downloads — collect 0.7s, restore 1.3s, heap ≤ 10 MB |
| run-H (site data round-trip) | ✅ 55 checks | **byte/value-level EXACT** through the real extension: localStorage (incl. lone surrogate via WTF-16 envelope, 256 KB value), sessionStorage (content-only), IndexedDB (schema + binary/Date values + key generator restored exactly), Cache Storage (bodies/status/headers), Service Worker (script bytes + activation), OPFS (nested dirs/unicode/empty/64 KB binary), Storage Buckets (bucket-scoped IDB + caches + OPFS), **partitioned storage** (two distinct partitions of the same origin under two top sites), repeat-restore idempotency |
| run-K (destructive restore) | ✅ 68 checks | the stage's flagship: seed ALL categories → snapshot S1 → backup → **destroy the profile through supported APIs** (bookmarks cleared, history deleted, cookies removed incl. partitioned via CDP, reading list cleared, tabs/windows closed, `clearDataForOrigin('all')` per origin, partition wipe, extension storage cleared) → destroyed-state sanity (everything verified empty) → restore → snapshot S2 → classified comparison: **exact** (bookmarks/cookies/tabs/groups/reading list/siteData/partitions/extension storage), **semantic** (history basic re-registration, sessions re-opened), **lossy** (documented: bookmark dateAdded, history detail, SS tab identity, downloads metadata-only), **unsupported** (extension installation). Key generators verified EXACTLY equal between backup and restored profile. |

| **run-L (cloud unit)** | ✅ 83 checks | Node-only, against a local **GitHub REST API simulator**: artifact + plaintext-safety guard (public+plaintext rejected **at the provider layer even with plaintextAllowed=true**; metadata/content mismatch rejected), envelope `encryptionVersion` (unknown version rejected before decryption; tamper fail-closed; backward-compatible AAD), wrong password / corrupted ciphertext / structural corruption, GitHub auth failure (401), repository-not-found (404), **repository visibility detection** (public/private + default branch), upload + remote verification (re-download SHA-256 + git blob sha1), download byte-identity, verifyRemoteObject detects remote tampering, listing (manifest-first + directory fallback), metadata, delete, private+plaintext allowed **only with explicit ack**, injected HTTP 500 → typed error + successful retry, **secret hygiene** (password never transmitted; token only in Authorization headers, never in bodies/paths/error messages), scheduler decision matrix (disabled / before-time / catch-up / duplicate prevention via last SUCCESS / manual-run-before-slot / yesterday-success / retry backoff 5 min vs 11 min), config normalization, effective-encryption policy matrix, error→status mapping, WebDAV & Google Drive placeholders throw `ERR_PROVIDER_NOT_IMPLEMENTED`, retention (oldest deleted beyond keepLast only after verified upload; disabled-by-default semantics) |
| **run-M (cloud E2E)** | ✅ 47 checks | the mandatory stage cycle in the real browser through the extension's cloud API: seed profile → cloud backup (Format v2 → AES-256-GCM envelope → local durable copy → GitHub upload → remote verified) → manifest entry carries digest + no browser data → scheduler recorded SUCCESS → **fresh profile (browser data destroyed)** → manifest discovery → wrong password rejected → corrupted remote artifact rejected → download → decrypt → restore → full comparator verification (bookmarks 22/22 URLs+titles+order, cookies attribute-by-attribute incl. CHIPS, reading list) → **policy matrix in-extension**: public+plaintext FAIL (provider layer), public+encrypted PASS, private+plaintext (explicit choice) PASS and lands only in the private repo, public repo contains only encrypted artifacts → **scheduler integration**: due when slot open, scheduled run executes, duplicate prevented, catch-up decision, no-password run refuses cleanly with `ERR_NO_PASSWORD` (never a plaintext fallback) → **cloud failure handling**: injected 500 → typed error, local durable copy survives, retry syncs the SAME artifact (no re-collection), pending cleared, scheduler state success → session-wide secret hygiene |

### Feature verification (extension v1.3.0)

- `npm test` passed: exponential retry policy, cancellation persistence, weekly weekday normalization/due decisions, settings import/export validation, token preservation, and rejection of injected API endpoint overrides.
- `xvfb-run -a npm run test:mobile-ui` passed in Chromium 153: no horizontal overflow at 360/390/768 px; weekly controls toggle; import preserves the destination token; invalid import leaves settings unchanged; export omits the token; retry cancellation keeps the pending artifact and does not restore its alarm after reload; dashboard local backup/restore controls initialize.

Raw results: `tests/results/*.json` + per-suite logs (`*.log`), summary in `SUMMARY.md`/`SUMMARY.json`.

## Fidelity classification used by run-K

| Class | Categories |
|---|---|
| exact | bookmarks (tree/order/titles/URLs), cookies incl. CHIPS, tabs/windows/groups, reading list, extension storage, localStorage, IndexedDB (+generators), Cache Storage, Service Worker (script served), OPFS, Storage Buckets, partitioned storage |
| semantically equivalent | history (URLs re-registered, single typed visit), sessions (URLs re-opened) |
| intentionally lossy | bookmark `dateAdded`, history per-visit detail, sessionStorage tab identity, downloads (metadata-only by default), OPFS `lastModified`, bucket durability echo |
| unsupported | extension package installation (checklist only) |

## Notable findings fixed or documented during this stage

- `requestAnimationFrame`-based yielding hung backups in background tabs (fixed: visible-only rAF).
- Bookmark root ids are not stable across Chrome versions (collector/restore resolve by position; fixed).
- The site-data scan tab used to pollute history/sessions (fixed: marker URLs + `history.deleteUrl` + session filter).
- WTF-16 base64 envelope fixed a real lone-surrogate corruption in the restore path.
- Key-generator measurement consumes one value per read — restore reproduces the recorded value exactly; repeated verification reads shift the live counter by +1 per read (documented; comparator handles it).
- 404 navigations do not enter Chrome history (test seeding uses 200-OK URLs).
- Chrome 153 `StorageBucketManager.keys()` returns a promise, not an async iterable; bucket names cannot start with `__`; `clearDataForOrigin('all')` also deletes buckets and OPFS (wipe policy aware).
