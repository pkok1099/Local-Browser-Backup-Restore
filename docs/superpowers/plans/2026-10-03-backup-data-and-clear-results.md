# Backup Data Boundary and Clear Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Limit extension-storage transfer to approved preferences, validate every newly created backup before making it available, and clear transient results without deleting recovery state or browser data.

**Architecture:** Filter extension storage at both collection and restore boundaries, using the approved local-preference allowlist and no sync keys. Validate finalized plaintext v2 data with the existing integrity verifier; validate encrypted output through one decrypt-and-validate round trip before retaining it, downloading it, or sending it into the cloud artifact path. Keep the current on-demand download object in dashboard memory only, and add a guarded Clear Results action that removes legacy `bbr:last-backup` and presentation state while preserving checkpoints, retryable data, durable artifacts, cloud state, and browser data.

**Tech Stack:** Existing JavaScript/TypeScript modules, Chrome Extension storage/download APIs, Web Crypto, Node built-in assertions, Playwright Chromium UI tests.

**Spec:** `docs/superpowers/specs/2026-10-03-backup-restore-trust-1.4.7-design.md`

## Global Constraints

- Keep the change suitable for a 1.4.x release: retain the current v2 backup output format and v1/v2 read compatibility, preserve the dashboard’s single-document crawl context, and do not change browser permission requirements.
- Do not add a format field in 1.4.7.
- The current code does not use `storage.sync` for extension preferences, so export no sync keys until an explicit safe setting is added.
- Existing durable local artifacts and remote cloud copies remain independent and are not deleted by this operation.
- Neither action calls `chrome.storage.local.clear()` or invokes bookmark, history, tab, cookie, reading-list, or website-storage mutation APIs.
- The UI makes clear that already-downloaded files cannot be removed from the user's chosen download location.
- Do not commit, tag, or push; stop after verification unless the owner explicitly approves a commit.

## Review Focus

- Legacy v1/v2 extension-storage data containing reserved, secret, unknown, or sync keys is filtered and the skipped-key count is truthful.
- A malformed or integrity-tampered v2 backup is rejected before local retention, download, durable artifact write, or cloud upload.
- An encrypted envelope that fails decryption or whose recovered v2 integrity is invalid is never offered as a ready download or persisted as a raw backup copy.
- Clear Results is unavailable while operations are active and while retryable scan failures remain; checkpoints and retry data stay intact.
- After Clear Results, browser data, durable artifacts/manifests, cloud credentials/state, pending uploads, and owned-tab safety records are unchanged while transient results and legacy `bbr:last-backup` are removed.

---

## File Map

- `src/lib/collect.js:347-362` — currently reads every `storage.local` and `storage.sync` key for the `extensionStorage` category.
- `src/lib/restore.js:590-611` — currently writes imported local and sync objects wholesale; `restoreAll` is the existing public restore entry point.
- `src/lib/format.js:63-139` and `src/lib/validate.js:61-130` — existing v2 integrity finalization/verification and v1/v2 file validation.
- `src/lib/crypto.js:55-177` — existing `encryptBackup` and `decryptBackup` primitives.
- `src/lib/artifact.js:34-65` and `src/lib/cloud.js:574-580` — cloud artifact construction currently parses/serializes artifacts but does not validate the newly collected backup before artifact creation.
- `src/dashboard/logic.ts:160-238,273-390,421-495` — finalizes backup objects, stores the raw object under `bbr:last-backup`, holds the on-demand download object in module memory, and downloads it.
- `src/dashboard/store.ts:103-148,166-201,210-257` — shared UI state and log/store updates; add the observable operation count here for both clear actions.
- `src/dashboard/cloud-ui.ts:202-273,348-447,537-558` — direct, scheduled, automatic-retry, and pending-sync cloud backup paths that must participate in the shared activity guard.
- `src/components/dashboard/LocalActionsCard.tsx:6-57` — summary-page actions; suitable placement for Clear Results and its scope copy.
- `tests/collect-selection.mjs` — existing Node test for selecting collected categories; extend with extension-storage collection and restore boundary assertions.
- `tests/cloud-backup-characterization.mjs` — existing test records download, durable-write, manifest, verification, and cloud-state side-effect order.
- `tests/e2e/local-roundtrip.mjs` and `tests/extension-ui.mjs` — existing encrypted round-trip and real-dashboard UI tests.

## Tasks

### Task 1: Allowlist extension-storage collection and restore

**Files:**
- Modify: `src/lib/collect.js:347-362`
- Modify: `src/lib/restore.js:590-611`
- Test: `tests/collect-selection.mjs`

**Interfaces:**
- Consumes: `collectAll(progress, options)` in `src/lib/collect.js`; `restoreAll(backup, options, progress)` in `src/lib/restore.js`.
- Produces: `data.extensionStorage.local` contains only `bbr.dashboard.theme`, `bbr:backup-categories`, `bbr:site-data-scan-window`, `bbr:site-data-tuning`, and `bbr:site-data-include`; collection requests only those keys from `chrome.storage.local` and emits no `sync` object. Restore applies only those local keys, merges via `chrome.storage.local.set`, and returns the ignored-key count at `results.extensionStorage.stats.skippedKeys: number` (the existing `restoreAll` result is keyed by category).

- [ ] **Step 1: Write failing assertions in `tests/collect-selection.mjs`**

  Mock `chrome.storage.local.get(keys)` with the five approved keys plus `bbr:cloud-config`, `bbr:site-data-checkpoint`, `bbr:site-data-owned-tabs`, `bbr:last-backup`, and an unknown key; mock sync with at least one key. Assert the collector requests exactly the allowlist, returns exactly those local keys, and has no `sync` property. Call `restoreAll` with an old-style object containing an allowed local preference plus reserved/unknown local and sync keys; assert only the allowed key reaches `storage.local.set`, `storage.sync.set` is not called, pre-existing credentials remain untouched, and `results.extensionStorage.stats.skippedKeys` equals the number of ignored keys.

- [ ] **Step 2: Run the focused test and verify it fails on the current broad-copy behavior**

  Run: `node tests/collect-selection.mjs`
  Expected: FAIL because current collection includes reserved/unknown keys or sync data and restore applies imported storage objects wholesale.

- [ ] **Step 3: Filter collection and restore at their storage boundaries**

  Use the five exact allowlist keys above in `collectExtensionStorage` and `restoreExtensionStorage`; request only those keys from `chrome.storage.local`, do not read all local keys, and do not add a sync allowlist. Preserve Chrome's merge semantics by setting only filtered local preferences. Include the skipped count in the extension-storage result summary without logging key values.

- [ ] **Step 4: Run the focused test and the full Node suite**

  Run: `node tests/collect-selection.mjs`
  Expected: PASS; returned local keys equal the five-key allowlist, sync is absent, reserved values are not applied, and skipped count is exact.

  Run: `npm test`
  Expected: PASS; all existing Node regression tests plus the extended collection/restore assertions pass.

### Task 2: Self-validate finalized local and cloud artifacts; remove raw backup persistence

**Files:**
- Modify: `src/dashboard/logic.ts:160-238,273-390,421-495`
- Modify: `src/lib/cloud.js:574-580`
- Test: `tests/cloud-backup-characterization.mjs`
- Test: `tests/e2e/local-roundtrip.mjs`

**Interfaces:**
- Consumes: `finalizeIntegrity(backup)`, `verifyIntegrity(backup)`, `validateBackupFile(text, { password })`, `encryptBackup(backup, password)`, and `decryptBackup(envelope, password)`; all are existing interfaces.
- Produces: the existing private download cache is populated only after validation succeeds; `bbr:last-backup` is no longer written. For cloud artifacts, the exact serialized text passed to `makeRemoteArtifact` has passed `validateBackupFile` first. Encrypted paths perform one encrypt/decrypt validation round trip and compare the recovered integrity digest with the finalized input.

- [ ] **Step 1: Add failing tests for invalid artifacts and raw-cache absence**

  Extend `tests/cloud-backup-characterization.mjs` so its fixture is finalized with `finalizeIntegrity`, then run a second case with a changed count or category data and assert `runCloudBackup` rejects before the optional download callback, `bbr:artifact:*` write, or manifest write. Extend `tests/e2e/local-roundtrip.mjs` to assert an encrypted backup remains v2-valid and that `chrome.storage.local.get('bbr:last-backup')` is empty after `runBackupToFile`; retain the existing wrong-password and plaintext-leak assertions.

- [ ] **Step 2: Run the focused tests and verify the new assertions fail**

  Run: `node tests/cloud-backup-characterization.mjs`
  Expected: FAIL because the current cloud path accepts the invalid fixture and proceeds to artifact side effects.

  Run: `xvfb-run -a npm run test:e2e`
  Expected: FAIL at the new cache-absence assertion because local backup currently persists `bbr:last-backup`.

- [ ] **Step 3: Validate before retaining or publishing**

  In the local path, make `storeBackupForDownload` asynchronous and await it from both completed and stopped `doBackup` paths. Await `verifyIntegrity` for the finalized plaintext object. For encrypted output, await `encryptBackup`, pass its envelope through `decryptBackup` and `validateBackupFile`, compare the recovered v2 integrity digest with the input, and only then assign `lastBackupForDownload`/`lastBackupMeta` or publish download readiness. Remove the `chrome.storage.local.set` of `bbr:last-backup`; keep the on-demand object in memory for the active dashboard page. In `collectAndBuildRemoteArtifact`, serialize the finalized payload once, validate that text (passing the password for encrypted output), verify the recovered digest for encrypted output, and only then pass that same text to `makeRemoteArtifact`.

- [ ] **Step 4: Run focused cloud and round-trip tests**

  Run: `node tests/cloud-backup-characterization.mjs`
  Expected: PASS; invalid integrity is rejected before any artifact side effect, and the valid path preserves the existing local-download/durable-write/manifest/verification ordering.

  Run: `xvfb-run -a npm run test:e2e`
  Expected: PASS; encrypted v2 round-trip and wrong-password checks still pass, and no raw `bbr:last-backup` entry is stored.

### Task 3: Add Clear Results with recovery preservation and a shared activity guard

**Files:**
- Modify: `src/dashboard/store.ts:103-148,203-257`
- Modify: `src/dashboard/logic.ts:148-158,273-390,421-581,684-895`
- Modify: `src/dashboard/cloud-ui.ts:202-273,348-447,537-558`
- Modify: `src/components/dashboard/LocalActionsCard.tsx:6-57`
- Test: `tests/extension-ui.mjs`

**Interfaces:**
- Produces (new store contract): `AppState.activeOperations: number` and `withDashboardActivity<T>(kind: 'backup' | 'site-data-retry' | 'cloud-backup' | 'restore' | 'probes' | 'download' | 'clear-results' | 'clear-logs', operation: () => Promise<T>): Promise<T>`; the helper uses the named exclusive Web Lock `bbr:dashboard-operation` with `ifAvailable: true`, updates local activity immediately, broadcasts start/end over `BroadcastChannel('bbr-dashboard-activity')`, and releases in `finally`. Other dashboard pages query `navigator.locks.query()` on mount, focus, and visibility changes and apply BroadcastChannel events; do not add a periodic poll. If an operation lock is unavailable, the attempted operation is rejected as busy rather than run concurrently. If Web Locks are unsupported, existing backup/restore/probe/download operations still run with local activity tracking, but both clear actions fail closed and do not delete data.
- Produces (new clear contract): `clearBackupResults(): Promise<boolean>` in `src/dashboard/logic.ts`; acquire the shared lock and return `false` without clearing if another operation holds it, a resumable `bbr:site-data-checkpoint` exists, or `siteScan.urlStates` contains `pending`, `fetching`, `fetched`, `fetch-failed`, or `save-failed`; otherwise clear and return `true`. Do not reject based on the shared activity state after this function has acquired its own `clear-results` lock.
- Consumes: existing `AppState.backup.summary`, `backup.siteScan`, `backup.downloadInfo`, `restore.results`, `restore.pickError`, and private in-memory download/retry references. Clear completed restore results/errors and progress state, but preserve a pending `restore.summary` preview. When no unresolved scan state exists, clear `lastSiteDataOpts` and `lastSiteDataSection` to release transient data. Preserve `bbr:site-data-checkpoint`, `bbr:artifact:*`, `bbr:local-manifest`, `bbr:pending-upload`, `bbr:cloud-config`, `bbr:cloud-state`, session password, owned-tab records, and browser data.

- [ ] **Step 1: Add a failing real-dashboard test**

  In `tests/extension-ui.mjs`, run a small local backup through the existing `window.__api.runBackupToFile` hook, assert Clear Results is disabled while the operation is active, and assert the legacy raw cache is absent. Open a second dashboard page in the same browser context; while the first page holds the operation lock, assert Clear Results is disabled there too and a direct clear call returns `false`. Hold the `probes` activity lock and assert Clear Results remains disabled while probe log writes can still be pending. Hold the `download` activity lock and assert Clear Results remains disabled until the download settles. Create a pending restore preview, then seed a bookmark plus representative durable artifact, manifest, pending-upload, cloud-config, and owned-tab values; click Clear Results after completion and assert the backup summary/download-ready UI and completed restore results clear, the pending restore preview remains, the bookmark and every seeded recovery/security value remain unchanged, and the button copy says downloaded files in the user's chosen location are not deleted. In a separate case, seed a resumable checkpoint and assert Clear Results is disabled and a direct clear call returns `false` without changing any prior results or recovery state. Add a failure-state case that leaves a retryable URL status and verifies Clear Results is disabled.

- [ ] **Step 2: Run the focused browser test and verify it fails**

  Run: `npm run build && xvfb-run -a npm run test:ui`
  Expected: FAIL because there is no Clear Results control, no shared activity count, and the legacy cache remains.

- [ ] **Step 3: Track relevant activities and implement the guarded clear**

  Wrap `doBackup`, site-data URL/save retry, direct/scheduled/automatic-retry/pending-sync cloud backup, file/cloud restore validation, restore execution, capability-probe execution, and `downloadBackupResult` with `withDashboardActivity`, without acquiring the lock again from nested functions. Implement `clearBackupResults` to acquire `clear-results` lock (which automatically rejects while the shared lock is held), then test only for a resumable checkpoint or unresolved scan state inside its callback; do not reject because its own lock makes the activity count nonzero. If safe, clear completed backup and scan presentation/progress, backup summary and download metadata/references, `restore.results`, `restore.pickError`, completed restore progress, and legacy `bbr:last-backup`; clear `lastSiteDataOpts`/`lastSiteDataSection` because no unresolved retry needs them. Leave a pending `restore.summary` preview untouched. Add the action and concise scope copy to `LocalActionsCard`; disable it from current/cross-page activity state and unresolved scan states. Do not clear checkpoints, artifacts, credentials, pending uploads, or browser data.

- [ ] **Step 4: Run the focused Clear Results UI test**

  Run: `npm run build && xvfb-run -a npm run test:ui`
  Expected: PASS; the button is disabled during active work and unresolved retry state, and clearing removes only transient results/cache.

### Task 4: Bump and package 1.4.7 artifacts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Output: `/workspace/browser-backup-extension-1.4.7-source.zip`
- Output: `/workspace/browser-backup-extension-1.4.7-chrome.zip`

**Interfaces:**
- Consumes: all verified implementation tasks and the existing `npm run zip` release pipeline.
- Produces: package and lockfile version `1.4.7`; a source archive without `.git`, `node_modules`, WXT caches, or build output; and the Chrome MV3 ZIP produced by WXT, with `manifest.json` version `1.4.7`.

- [ ] **Step 1: Bump package and lockfile without creating Git history**

  Run: `npm version 1.4.7 --no-git-tag-version`
  Expected: `package.json` and `package-lock.json` both report `1.4.7`; no commit or tag is created.

- [ ] **Step 2: Run all release validation against the 1.4.7 version**

  Run: `npm run check && npm test && npm run knip && npm run cycles && npm run build && xvfb-run -a npm run test:ui && xvfb-run -a npm run test:e2e`
  Expected: every command exits 0; no existing characterization test is removed or weakened.

- [ ] **Step 3: Create and inspect source and compiled archives**

  Run: `npm run zip`, then copy the generated Chrome archive to `/workspace/browser-backup-extension-1.4.7-chrome.zip`. Create `/workspace/browser-backup-extension-1.4.7-source.zip` from the worktree while excluding `.git`, `node_modules`, `.output`, `.wxt`, `build`, `dist`, and `.superpowers`.
  Expected: both archives exist, list without dependency/cache directories, the Chrome ZIP contains MV3 files whose manifest version is `1.4.7`, and the source ZIP contains the approved spec and plans plus implementation source.

- [ ] **Step 4: Stop with a clean, reviewed change set and no publication**

  Run: `git diff --check && git status --short && git tag --points-at HEAD`
  Expected: whitespace check passes; the 1.4.7 changes remain uncommitted on the isolated feature branch; no tag or push is made without separate approval.

## Release Verification

Run: `npm run check && npm test && npm run knip && npm run cycles && npm run build && xvfb-run -a npm run test:ui && xvfb-run -a npm run test:e2e`
Expected: PASS; lint, typecheck, formatting, Node tests, unused-code and circular-import checks, production build, UI tests, and E2E round trips all exit 0.
