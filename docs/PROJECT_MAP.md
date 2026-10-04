# PROJECT MAP — Local Browser Backup & Restore

> Complete project map for a **full audit**. Created on 2026-10-03 after reading
> all 195 files (excluding `node_modules/`, `.output/`, `.wxt/`).
> Total ~22.700 LOC: `src/` 16.310 · `tests/` 5.497 · `public/lib/` 884 · `scripts/` 35.
>
> How to use: each file is summarized (purpose, key exports, dependencies, risks).
> Files **most critical for the audit** are marked 🔴. Tech debt already
> documented in config is marked 🟡.

## Overview

Chrome MV3 extension (WXT + React 19) for **100% local browser data backup & restore**
(12 categories), with optional encrypted upload to GitHub, an automatic scheduler, and
site-data collection (localStorage/IndexedDB/Cache/SW/OPFS per origin) via `chrome.debugger`.

**Consistent architectural principles across the codebase:**
- Heavy work runs in the **dashboard page** (`dashboard.html`), NOT in the service
  worker, so it is not killed by the MV3 lifecycle. The worker handles only the scheduler/alarms.
- **Tab safety kernel** (`src/lib/tab-ownership.js`): the only `chrome.tabs.remove`
  allowed, protected by a runtime guard + static test. Invariant: only tabs owned by the operation
  that may be closed, only via `safeCloseTab`.
- Modules without `chrome.*` (crypto, format, util, validate, scheduler-decision, artifact)
  are pure and can be unit-tested in Node.
- Security policy is enforced **in code**, not only in the UI: token never
  logged, public repositories require encryption, uploads are verified remotely before being declared successful.

## Main data flow

```
collect.js (collectAll)
  → sitedata.js / capabilities.js (collect data)
  → format.js (skeleton + integrity digest)
  → crypto.js (optional: PBKDF2 600k → AES-256-GCM)
  → artifact.js (final artifact + manifest)
  → providers.js / github.js — orchestrated by cloud.js (upload → remote VERIFICATION)
Restore: restore.js (+ sitedata.restoreSiteData) → browser APIs (non-destructive by default)
Scheduler: scheduler.js (pure decision) → background.ts (alarm) → dashboard ?action=
Dashboard: lib → callback/progress → store.patchState → useSyncExternalStore → render
```

---

## 1. `src/lib/` — core logic (22 files)

### src/lib/artifact.js
- Purpose: Builds remote backup artifact — the exact bytes stored StorageProvider
  (JSON v2 plaintext or encrypted envelope) along with remote manifest.
- Key exports: `makeRemoteArtifact`, `manifestEntryFromArtifact`, `newRemoteManifest`,
  `normalizeManifest`, `upsertManifestEntry`, `assertUploadSafe`, `ENCRYPTION_VERSION`.
- Depends on: `util.js`, `format.js`.
- Notes/risks: Without `chrome.*` (testable in Node). `assertUploadSafe` is the gate
  upload policy (rejects plaintext to public repositories).

### src/lib/capabilities.js
- Purpose: Detect browser capabilities — which categories can be read/backed up/restored.
  The single source of truth for capability report and UI.
- Key exports: `getChromeVersion`, `detect`, `runProbes`.
- Depends on: `capability-probes.js`.
- Notes/risks: Uses `chrome.debugger`/`scripting`/etc. only for defensive probing.

### src/lib/capability-probes.js
- Purpose: Runtime probes to refine static capability notes.
- Key exports: `runCapabilityProbes`.
- Depends on: `util.js`, `site-log.js`.
- Notes/risks: Touches sensitive APIs only for read tests; probe failures are non-fatal.

### src/lib/cloud.js 🔴
- Purpose: Cloud-backup orchestrator — data → artifact → [encryption] → upload →
  remote object VERIFICATION → update manifest. A durable local copy is always written first.
- Key exports: `runCloudBackup`, `beginScheduledRun`, `listCloudBackups`,
  `downloadAndValidateBackup`, `createProviderFromConfig`, `redactConfig`,
  `getCloudRetryInfo`, `cancelPendingCloudRetry`, `restoreCloudRetryAlarm`.
- Depends on: `util.js`, `crypto.js`, `validate.js`, `artifact.js`, `providers.js`,
  `github.js`, `scheduler.js`.
- Notes/risks: 🟡 **Second-highest complexity (`runCloudBackup`: 77)** — tech debt
  documented. Passwords are never stored/logged. A failed upload → marker pending,
  the next run re-syncs the same artifact (without re-collecting).

### src/lib/collect.js
- Purpose: Collector for all backup categories via public extension APIs → format document.
- Key exports: `collectAll`, `computeCounts`.
- Depends on: `util.js`, `capabilities.js`, `sitedata.js`.
- Notes/risks: Touches the broadest set of APIs (readingList, sessions, history, cookies,
  tabGroups, windows, tabs, storage, management, downloads). Cookie values are not logged;
  incognito excluded by design.

### src/lib/crypto.js 🔴
- Purpose: Backup encryption — PBKDF2-HMAC-SHA-256 (600k iterations) → AES-256-GCM with
  additional data binds the envelope header. Pure Web Crypto.
- Key exports: `encryptBackup`, `decryptBackup`.
- Depends on: `util.js`, `artifact.js`.
- Notes/risks: Without `chrome.*`, small and isolated. Critical for security.
  ⚠️ Has no dedicated unit tests (tested only via E2E round-trip).

### src/lib/format.js
- Purpose: Backup format v2 constants, new-backup skeleton, and integrity digest.
- Key exports: `FORMAT_ID`, `ENCRYPTED_FORMAT_ID`, `FORMAT_VERSION`,
  `SUPPORTED_FORMAT_VERSIONS`, `newBackupSkeleton`, `finalizeIntegrity`, `verifyIntegrity`.
- Depends on: `util.js`.
- Notes/risks: Without `chrome.*`. v1 remains readable (transparent upgrade).

### src/lib/github.js 🔴
- Purpose: `GitHubStorageProvider` — backup cloud via GitHub Contents API. Upload
  forced to be verified (re-download + sha256 + compare git blob sha).
- Key exports: `GitHubStorageProvider`.
- Depends on: `util.js`, `artifact.js`, `providers.js`.
- Notes/risks: PAT tokens are only in the header `Authorization`, never logged/included
  artifacts. Public repositories → encryption REQUIRED.

### src/lib/providers.js
- Purpose: Contract `StorageProvider` + `LocalStorageProvider` + `BackupRef`.
- Key exports: `StorageProvider`, `BackupRef`, `LocalStorageProvider`.
- Depends on: `util.js`, `artifact.js`.
- Notes/risks: Providers operate only on final artifacts, not in raw data.

### src/lib/restore.js 🔴
- Purpose: Restore engine — default NON-DESTRUCTIVE (bookmark merging, tab/window/session
  created as new objects). Mode "replace" only for bookmark + requires explicit confirmation.
- Key exports: `restoreTabsWindows`, `restoreAll`.
- Depends on: `util.js`, `sitedata.js`.
- Notes/risks: 🟡 High complexity (`restoreTabsWindows`: 37, `restoreCookies`: 33).
  Writes to the user’s browser data and must remain non-destructive. Placeholder tab window-restore
  closed only via `safeCloseTab` with `windowId`.

### src/lib/scan-concurrency.js
- Purpose: Site-data crawler concurrency primitives — slot pool (hard tab-window limit), queue
  handoff worker, and adaptive CPU/load monitoring.
- Key exports: `clampScanWindow`, `clampInt`, `createSlotPool`, `createAsyncQueue`,
  `createSystemCpuSampler`, `createLoadMonitor`, `startCpuMonitor`.
- Depends on: `scan-config.js`.
- Notes/risks: the only module that uses `chrome.system.cpu`. Window never < 2;
  decreases quickly / increases slowly (anti-oscillation).

### src/lib/scan-config.js
- Purpose: Single centralized tuning object `SITE_DATA_CONFIG` (window, concurrency, timeout,
  exclusion, retry, stop, storage). Pure data module — cannot create cycles.
- Key exports: `SITE_DATA_CONFIG`.
- Depends on: none.
- Notes/risks: To audit the tuning, read this file.

### src/lib/scan-groups.js
- Purpose: Tab-group manager — one group "BBR Site Scan" + fallback "BBR Site Error"
  (red) for tabs that fail to join the scan group.
- Key exports: `createGroupManager`, `SCAN_ERROR_GROUP_TITLE`, `SCAN_ERROR_GROUP_COLOR`.
- Depends on: none.
- Notes/risks: The group is never deleted directly — gone when tab last closed.
  User tabs are never grouped.

### src/lib/scheduler.js
- Purpose: Automatic backup scheduler — PURE decision functions (testable in Node) +
  config/state helpers via `chrome.storage`.
- Key exports: `normalizeScheduleConfig`, `isBackupDue`, `loadSchedulerState`,
  `saveSchedulerState`, `isLocked`, `cloudRetryDelayMs`, alarm constants.
- Depends on: none (although `cloud.js` imports it).
- Notes/risks: "Due" is calculated from the last SUCCESSFUL backup → failures trigger retry backoff;
  successful backups are not duplicated.

### src/lib/settings.js
- Purpose: Settings export/import.
- Key exports: `buildSettingsExport`, `parseSettingsImport`.
- Depends on: `cloud.js`.
- Notes/risks: **Token-safe**: during import, the GitHub token from the file is not used —
  the current token is retained.

### src/lib/site-data-selection.js
- Purpose: Helper to filter/select site-data origins for the UI.
- Key exports: `filterSiteDataOrigins`, `getSelectedSiteDataOrigins`.
- Depends on: none. Practically zero risk (16 lines, pure).

### src/lib/site-log.js
- Purpose: Centralized crawl logging — `log(level, category, message, context)`,
  level DEBUG–FATAL, categories W1/W2/STORAGE/CPU/LOAD/SAFETY/RETRY/SYSTEM. Buffer + batch
  to IndexedDB (cap 5000); write failures do not stop the crawl.
- Key exports: `createSiteLogger`, `querySiteLog`, `clearPersistedSiteLog`,
  `selectLogEntriesToTrim`, `formatLogTs`, `LOG_LEVELS`, `LOG_CATEGORIES`.
- Depends on: none.

### src/lib/sitedata.js 🔴
- Purpose: Site-data collector — two-worker pipeline (W1 opens scan tabs ≤ window →
  groups; W2 reads via `chrome.debugger` with 4 concurrent workers → close tabs). Failed pool + retry
  waves, separate storage retry, URL exclusion, clean stop, checkpoint resume,
  adaptive window, centralized logging. Also `restoreSiteData`.
- Key exports: `collectSiteData`, `restoreSiteData`, `discoverOrigins`,
  `filterSiteDataOriginsForBackup`, `isExcluded`, `computeSiteDataCounts`
  (+ re-export split modules: `SITE_DATA_CONFIG`, `createTabOwnership`, `verifyScanTab`,
  `createSiteDataOwnership`, `cleanupPreviousSessionTabs`, `createSlotPool`, …).
- Depends on: `util.js`, `site-log.js`, `scan-config.js`, `tab-ownership.js`,
  `scan-groups.js`, `scan-concurrency.js`.
- Notes/risks: 🟡 **Largest file (2138 lines) and highest complexity
  (`collectSiteData`: 65)**. Sensitive APIs: `chrome.debugger`, `chrome.scripting`.
  Tab invariant: owned by the operation via `safeCloseTab`.

### src/lib/tab-ownership.js 🔴
- Purpose: **Tab safety kernel** — the only `chrome.tabs.remove` allowed
  (via `safeCloseTab`), protected by an anti-bypass runtime guard. `verifyScanTab` ensures
  tab still displays scan page (or `failed` for chrome-error) before closing;
  `origin=''` = origin unknown (crash-recovery) → match the marker only.
- Key exports: `createTabOwnership`, `verifyScanTab`, `createSiteDataOwnership`,
  `cleanupPreviousSessionTabs`, `originOf`, `scanUrlFor`, `SCAN_MARKER`.
- Depends on: `site-log.js`, `scan-config.js`.
- Notes/risks: **Most critical for user-data safety.** Cleanup by recorded-ID
  only, never by query/group. `closingTabIds`/`ownedTabIds` cleared in finally.

### src/lib/util.js
- Purpose: Basic utilities — `TypedError`, canonicalize JSON, base64, sha256, gzip,
  `yieldToUI`, `errCode`/`errMessage`.
- Key exports: `TypedError`, `canonicalize`, `sha256Hex`, `bytesToB64`/`b64ToBytes`,
  `gzipCompress`/`gzipDecompress`, `yieldToUI`, `errCode`, `errMessage`.
- Depends on: none (imported 9 files).
- Notes/risks: `TypedError` is the foundation for typed error handling across the codebase.

### src/lib/validate.js
- Purpose: Backup-file validation — structure, version, digest, semantic sanity. Typed errors
  (wrong password vs. corruption vs. unsupported version).
- Key exports: `validateBackupFile`.
- Depends on: `util.js`, `format.js`, `crypto.js`.
- Notes/risks: ⚠️ Has no dedicated unit tests.

### src/lib/utils.ts
- Purpose: Helper `cn()` for merge class Tailwind (clsx + tailwind-merge), shadcn standard.
- Key exports: `cn`. The only file that directly imports an npm dependency.

---

## 2. UI — `src/entrypoints/`, `src/dashboard/`, `src/components/dashboard/`

### src/entrypoints/background.ts
- Purpose: Minimal MV3 service worker that handles only the scheduler: periodic alarms,
  evaluates the cloud-backup schedule (including catch-up), retry pending uploads.
- Key exports: `defineBackground(...)` — handler `onInstalled`/`onStartup`/`onAlarm`/
  `onMessage`; `checkScheduleAndRun()`, `checkCloudRetryAndRun()`.
- Depends on: `@/lib/scheduler`, `@/lib/cloud`.
- Notes/risks: Heavy work is not in the worker — worker only opens
  `dashboard.html?action=…` as a background tab. Guard against duplicate scheduled-run tabs.

### src/entrypoints/dashboard/main.tsx
- Purpose: Boot dashboard: anti-flash theme → `window.__api` for tests → cleanup remaining session tabs,
  then → render `<App/>`.
- Key exports: none (side-effect): `initThemeSync()`, `installTestHooks()`,
  `cleanupPreviousSession()`, listener `beforeunload` best-effort.
- Depends on: `./App`, `@/dashboard/api`, `@/dashboard/theme`,
  `@/dashboard/site-log-store`, `@/lib/sitedata` (dynamic import).
- Notes/risks: `beforeunload` async often does not finish — the real safety net
  is cleanup when the dashboard is reopened.

### src/entrypoints/dashboard/App.tsx
- Purpose: Shell React: header, hash-routing 6 pages in one `dashboard.html`,
  error boundary per chunk lazy, password dialog, toaster.
- Key exports: `App`, `useHashRoute()`, `RouteChunkErrorBoundary`, `NAV`.
- Depends on: `@/dashboard/store`, `@/dashboard/lazy-route`, `@/dashboard/theme`,
  Header/pages components (5 lazy pages).
- Notes/risks: Hash routing is intentional so that crawl JS context is not destroyed when changing
  pages. `?action=` triggers `cloud-ui.init()` (scheduled/retry auto-start).

### src/dashboard/store.ts
- Purpose: Single external store (`useSyncExternalStore`) — the only source
  of truth for all pages.
- Key exports: `AppState` type, `useApp()`, `getState/setState/patchState/updateForm/
  appendLog`, `withDashboardActivity()` (mutual exclusion via Web Locks +
  BroadcastChannel), `hasUnresolvedSiteScan()`.
- Depends on: React only.
- Notes/risks: only one heavy operation at a time across dashboard tabs.
  Clear Results/Logs fail-closed if Web Locks is unavailable.

### src/dashboard/api.ts + api-operations.ts
- Purpose: Automation surface `window.__api` for E2E/UI + its operation implementations
  (probe, collectAll, backup, cloud, scheduler, restore, seed helpers).
- Key exports: `installTestHooks()`; namespace `__api.*`.
- Depends on: `./store`, `./logic`, `@/lib/{collect,cloud,restore,validate,
  capabilities,scheduler,crypto,util}`.
- Notes/risks: 🟡 `@ts-nocheck` (tech debt). `seed.*` manipulates real tabs/windows —
  only for tests.

### src/dashboard/logic.ts 🟡
- Purpose: Dashboard-operation orchestrator: build backup, doBackup + stop, download
  on-demand (without auto-download), retry site-data, password dialog, restore flow,
  capabilities, clear results.
- Key exports: `doBackup`, `buildBackupObject/buildCloudBackupObject`,
  `downloadBackupResult`, `retrySiteDataUrls/retrySiteDataSave`, `askPassword`,
  `openRestoreFlow/onRestoreGo`, `showCapabilities`, `clearBackupResults`,
  `requestBackupStop`.
- Depends on: `./store`, `./backup-categories`, `./site-log-store`,
  `@/lib/{collect,restore,sitedata,format,crypto,validate,capabilities}`.
- Notes/risks: Backup results are held in memory + extension storage; the "Download results" button
  is explicit; Blob is built incrementally. One of 13 remaining type errors has not yet been
  fixed (see Memory 2026-10-02).

### src/dashboard/cloud-ui.ts 🟡
- Purpose: Cloud UI logic: connect GitHub, backup manual/scheduled/retry, remote
  list/restore/delete, export/import settings, auto-start via `?action=`.
- Key exports: `init()`, `onCloudConnect`, `onCloudBackupNow`, `onCloudRestore`,
  `onRetrySync`, `exportSettingsFile/importSettingsFile`, `saveCloudSettings`.
- Depends on: `./store`, `./logic`, `@/lib/{cloud,github,providers,scheduler,
  settings,util,capabilities}`.
- Notes/risks: 🟡 `@ts-nocheck`. The token is cleared from the form after save; only in
  memory + storage config. Plaintext upload requires `confirm()` + private repositories only
  (actual enforcement in storage layer).

### src/dashboard/backup-categories.ts
- Purpose: Definition of 12 backup categories + preference persistence (`chrome.storage.local`):
  selected categories, site origins, scan window, crawl tuning, include
  sessionStorage/serviceWorkers.
- Key exports: `BACKUP_CATEGORIES`, load/save for categories, origin, window, tuning.
- Depends on: `@/lib/sitedata` (`SITE_DATA_CONFIG` as single boundary).
- Notes/risks: 🟡 `@ts-nocheck`. All values are clamped on load (safe from storage
  corruption). sessionStorage/serviceWorkers default OFF (platform limitation).

### src/dashboard/lazy-route.ts
- Purpose: Lazy route chunk loader with one-time recovery (reload once, guarded in
  sessionStorage to prevent loops).
- Key exports: `loadRouteChunk`, `retryRouteChunk`.
- Depends on: none (pure; window.sessionStorage/location can be injected
  for tests).

### src/dashboard/site-log-store.ts
- Purpose: Store live site-log crawl: entries live + IndexedDB, flag error-unseen,
  cross-tab clearing.
- Key exports: `pushSiteLogEntry`, `useSiteLog()`, `useUnseenSiteLogError()`,
  `markSiteLogSeen()`, `clearSiteLogView()`, `loadPersistedSiteLog()`.
- Depends on: `@/lib/site-log`, `./store`, BroadcastChannel.
- Notes/risks: Buffer live 2000 entries; cross-tab clearing via BroadcastChannel.

### src/dashboard/theme.ts
- Purpose: Light/dark/system theme — persisted in `chrome.storage.local` + synchronous mirror
  `window.localStorage` so that class `dark` applied before the first paint.
- Key exports: `initThemeSync()`, `loadTheme()`, `setTheme()`, `watchSystemTheme()`,
  `useTheme()`, `useResolvedTheme()`.
- Depends on: react, matchMedia, chrome.storage.local.

### src/components/dashboard/ (23 files)
Pages and cards — all presentational, state via `useApp()`:
- `pages.tsx` (`SummaryPage`), `SettingsPage.tsx`, `ResultsPage.tsx`, `FailuresPage.tsx`,
  `LogPage.tsx`, `MorePage.tsx` — page composition (5 of them lazy).
- `Header.tsx`, `ThemeToggle.tsx`, `LocalActionsCard.tsx`, `BackupProgressCard.tsx`,
  `CrawlStatusBar.tsx`, `DownloadResultButton.tsx` — summary & progress.
- `BackupCategoriesCard.tsx`, `SiteDataSelectionCard.tsx`, `SiteDataTuningCard.tsx` —
  settings.
- `SiteResultsList.tsx`, `SiteFailuresList.tsx` — results & retry per item
  (save-failed only saved again, not re-fetched).
- `SiteLogViewer.tsx`, `LogCard.tsx` — structured-log viewer + raw logs.
- `RestoreCard.tsx`, `CloudCard.tsx`, `CapabilitiesCard.tsx`, `PasswordDialog.tsx`.
- Notes/risks: Many accesses `(scan as any)` read the dynamic `liveStats` field in
  `CrawlStatusBar`/`BackupProgressCard` — loose typing risks silent failures if
  field names change in the library. The `LogPage` security-warning filter is regex-based and
  fragile if the message format changes. Some files `@ts-nocheck`.

### src/components/ui/ (14 files, ~709 lines)
A set of shadcn/ui components styled `new-york` based Radix (badge, button, card, checkbox,
dialog, input, label, progress, radio-group, select, separator, sonner, table) —
thin wrapper `cva` + `cn()`. Purely presentational, without business logic.

---

## 3. Configuration, scripts, public

### package.json
- Contents: `local-browser-backup-extension` v1.4.7, `type: module`, `private: true`.
  Only four runtime dependencies: `wxt`, `@wxt-dev/module-react`, `react`, `react-dom`.
- Scripts: `dev`/`build`/`zip` (wxt); `test` (Node 24 auto-discovers 39 `*.test.mjs`
  suites at concurrency 7); `test:e2e` (8 `*.e2e.mjs` browser suites); separate `test:ui`;
  `lint`, `typecheck`, and `format:check`; `verify` prepares WXT and runs those checks
  plus `npm test` concurrently; `cycles` (madge); `knip`.
- Key `"prettier"`: printWidth 80, semi, singleQuote, tabWidth 2, trailingComma es5
  (moved from `.prettierrc.json` 2026-10-03; prettier auto-discovery).
- Note: `npm run check` runs lint, typecheck, and format checks; pre-commit/CI use `npm run verify`.

### wxt.config.ts
- Contents: Build configuration WXT + React module + plugin Tailwind (vite). Manifest:
  `key` public key remains (extension ID deterministic), `minimum_chrome_version` 114,
  15 permissions (bookmarks, history, tabs, tabGroups, sessions, cookies, downloads,
  readingList, storage, unlimitedStorage, management, scripting, debugger, alarms,
  system.cpu), `host_permissions` http/https, action without a popup (opens dashboard).

### tsconfig.json / tsconfig.check.json / tsconfig.madge.json
- `tsconfig.json`: `strict: true` + `checkJs: true`, `noUncheckedIndexedAccess`,
  `noUnusedLocals/Parameters`, `exactOptionalPropertyTypes`; extends `.wxt/tsconfig.json`.
- `tsconfig.check.json`: extends the above, but `checkJs: false`, include only
  TS/TSX — this is what `npm run typecheck` uses (JS files are covered by ESLint type-aware).
- `tsconfig.madge.json`: only the `paths` alias so that madge can resolve imports.

### eslint.config.mjs
- Contents: Flat config — `js.configs.recommended` + `typescript-eslint` (4 type-aware rules
  manual: `no-floating-promises`, `no-misused-promises`, `await-thenable`,
  `require-await`) + `eslint-plugin-import` + `eslint-config-prettier`.
- Important rules: `no-use-before-define` (functions off / classes+variables on — TDZ),
  `import/no-cycle`, `no-empty` (catch empty forbidden), `no-console` (except
  site-log.js), `eqeqeq`, `no-param-reassign`, `no-shadow`, `complexity` 25 /
  `max-depth` 6 / `max-params` 5 (8 documented tech-debt exceptions),
  `no-restricted-syntax` forbids `chrome.tabs.remove` raw (override dedicated
  tab-ownership.js), `no-restricted-properties` forbids `innerHTML`/`outerHTML`,
  `reportUnusedDisableDirectives: error`.
- Note: `unsafe-*` disabled (file JS without JSDoc); `tests/**` relaxed.

### knip.json
- Contents: Entry `src/entrypoints/**`, `src/dashboard/theme.ts`, `tests/**/*.mjs`;
  project `src/**`, `tests/**`, `scripts/**`. Configured to suppress the false
  positive for the WXT entry. This cannot be moved to `package.json` because
  Knip v6 reads only eight configuration-file locations.

### components.json
- Contents: shadcn/ui configuration (style `new-york`, slate, cssVariables, lucide).
  Required by the shadcn CLI.

### .husky/pre-commit + scripts/pre-commit + .github/workflows/check.yml
- Husky hook: `npm run verify` (installed via script `prepare`).
- `scripts/pre-commit`: manual alternative (`cp scripts/pre-commit .git/hooks/pre-commit`).
- CI (push/PR, Node 24): `npm ci` → `npm run verify` (`wxt prepare`, then lint,
  typecheck, format check, and Node tests run concurrently).

### scripts/screenshot.mjs
- Contents: Smoke visual test via Playwright (dashboard desktop 768px + mobile 360px).
  Run manually via `npm run screenshot`; not part of the test chain.

### public/lib/pagelib.js (884 lines)
- Contents: Script injected into the target page via debugger; exposes
  `globalThis.__BBR`: read/restore per categories (localStorage, sessionStorage,
  IndexedDB, Cache Storage, service worker, OPFS, buckets) + aggregate
  `readSiteAll`/`restoreSiteAll`/`wipeSiteAll` + transport chunked
  (`setTx`/`txChunk`/`clearTx`/`pushRx`/`takeRx`).
- Notes/risks: The only cross-origin storage read/write bridge; called
  from `src/lib/sitedata.js` via `chrome.debugger`.

## Toolchain summary
- Build: WXT → `.output/chrome-mv3/`. Lint/format: ESLint (strict, zero-warning) +
  Prettier — both cover only `src/`.
- Typecheck: `tsc --noEmit` via `tsconfig.check.json` (TS/TSX only); required
  `npm ci` + `npx wxt prepare` first.
- Tests: `npm test` = Node's auto-discovered `*.test.mjs` suites (`node:test` +
  `node:assert/strict`); `api-operations.types.ts` remains separately typechecked;
  E2E/UI uses separate Playwright commands and a fresh Chromium build.
- Quality gate: `npm run verify` → pre-commit/CI; `npm run cycles`
  (madge) and `npm run knip` for circular-dependency and dead code.

---

## 4. Selected Node test suites — `tests/**/*.test.mjs` (39 suites auto-discovered)

| file | Tests | Visible gaps |
|---|---|---|
| `sitedata-tab-cleanup.test.mjs` (779 lines, largest) | Pipeline `collectSiteData` real vs. fake Chrome — scenarios A–Q: hard window, takeover user (never closed), adaptive CPU, exactly-once safeCloseTab, retry waves, storage retry, error-group fallback | Mid-crawl stop coverage is limited; cross-session crash recovery is covered only in E2E |
| `verify-scan-failed.test.mjs` | Verdict `verifyScanTab`: chrome-error→`failed`, scan→`ours`, user→`foreign`, gone→`gone`, origin empty→marker-only (fix F1, TDD red-first) | Only the `url`, not `pendingUrl` |
| `runtime-tab-remove-guard.test.mjs` | Guard runtime `chrome.tabs.remove`: 5 bypass patterns (alias/destructuring/dynamic) rejected + recorded; official close still works | — |
| `no-raw-tab-remove.test.mjs` | Static: every `chrome.tabs.remove` must choke point `safeCloseTab` marked SAFETY-ALLOWED; `windows.remove` forbidden | Exotic obfuscation passes (blocked by the runtime guard) |
| `no-circular-import.test.mjs` | No circular imports among core modules (to prevent TDZ) | Excludes components/entrypoints; dynamic import not analyzed |
| `restore-tabs.test.mjs` | `restoreTabsWindows` + outcome matrix `restoreAll` (ok/partial/failed) | Restore cookies/history/downloads not covered in depth |
| `restore-tabs-android.test.mjs` | Path Android: two-phase create-then-navigate | Narrow — dispatch order only |
| `cloud-backup-characterization.test.mjs` | `runCloudBackup` `local` provider: durable side-effect ordering | only the `local` provider is covered |
| `cloud-provider-guard.test.mjs` | Plaintext-safety `GitHubStorageProvider` vs simulator REST: matrix public/private × plaintext/encrypted; token only in header Authorization | — |
| `cloud-retry.test.mjs` | Configuration normalization, backoff delay, cancel/restore alarm | Actual retry execution is only covered in E2E |
| `schedule-settings.test.mjs` | Schedule normalization, `isBackupDue`, transfer settings token-safe | Timezone/DST edge cases are not tested |
| `collect-selection.test.mjs` | `collectAll` only selected categories; allowlist extensionStorage | Allowlist is hardcoded in the test (requires manual synchronization) |
| `site-data-origins.test.mjs` | `discoverOrigins` + origin filtering/selection | — |
| `site-exclude.test.mjs` | `isExcluded` — 23 URL cases based hostname parse (anti false-positive) | IPv6 `[::1]` not covered |
| `site-log.test.mjs` | `createSiteLogger` + integration `collectSiteData` via `onLogEntry` | IndexedDB persistence is not tested in Node |
| `pagelib-category-failures.test.mjs` | `pagelib.js` real in `node:vm` with all storage APIs throwing — each category fails independently | only the all-fail case is covered |
| `probe-characterization.test.mjs` | `runProbes` — output shape, failure isolation by category | Locks in behavior, not assessment correctness |
| `lazy-route-retry.test.mjs` | `loadRouteChunk`/`retryRouteChunk` — fails once→reload; fails repeatedly→not loop | — |
| `theme-mode.test.mjs` | `theme.ts` — boot, persistence, system-follow, without flash | Button interaction in E2E |
| `api-operations.types.ts` | Typecheck `runCloudBackup`/`runIfDue` via `@ts-expect-error` | By design, with no runtime assertions |

The Playwright UI smoke test, `tests/extension-ui.mjs`, is separate; the type-only suite remains part of `npm run typecheck`.

**Coverage summary:** Strongest — tab safety (4 layers), pipeline site-data
(scenarios A–Q), guard plaintext provider, token hygiene. Weakest — `crypto.js`
and `validate.js` without dedicated unit tests; dashboard TS logic other than theme is
covered only superficially by E2E; mid-crawl stop and crash-recovery paths have limited
unit-test coverage.

---

## 5. Playwright UI and E2E — `tests/e2e/` (8 suites) and `docs/`

Build a fresh extension with `npm run build`, then run `xvfb-run -a npm run test:e2e`
(or `CI_HEADLESS=1`). The `*.e2e.mjs` suffix keeps all eight browser suites outside
Node's default test discovery. They drive the built extension in Chromium through
Playwright (`launch.mjs` + `window.__api`). The UI smoke test is separate as `npm run test:ui`.

| files | Contents |
|---|---|
| `launch.mjs` | Shared launcher: load extension, wait for `window.__api`, `apiCall`/`must`, collect `pageErrors` |
| `seeds.mjs` / `github-simulator.mjs` | Bookmark-seeding helper; simulator REST GitHub in-memory (fault injection, audit hygiene token) |
| `local-roundtrip.e2e.mjs` | Seed → encrypted backup → destroy → wrong password rejected → exact restore → idempotence |
| `cloud-roundtrip.e2e.mjs` | Cloud cycle vs simulator: verified upload, manifest, digest mismatch, HTTP 500 retry of the same artifact, and public/private × plaintext/encrypted matrix |
| `scheduler-roundtrip.e2e.mjs` | Due/catch-up → execution → dedup `already-succeeded-today` → disabled not due → rejected without a password |
| `sitedata-tabs.e2e.mjs` | Streaming pipeline: hard window never exceeded, existing tabs untouched, monotonic progress, clean teardown |
| `sitedata-error-tabs.e2e.mjs` | Working and deliberately failing origins: temporary tabs and scan/error groups are cleaned up |
| `sitedata-blocking.e2e.mjs` | Blocks subresources during scan while site storage is read; verifies redirect cleanup and session-rule removal |
| `cookies-partitioned.e2e.mjs` | Preserves the partition key while backing up a plain cookie and a partitioned CHIPS cookie |
| `theme-toggle.e2e.mjs` | Dark mode: cycle light → dark → system, persists after reload |
| `tests/extension-ui.mjs` | Separate Playwright UI smoke test: Chromium load, dashboard layout, and mobile viewport |

Most important documents for auditors: `docs/PERMISSIONS.md` (mapping permissions→features),
`docs/CAPABILITY_REPORT.md` (fidelity claims + evidence + irreparable limitations),
`docs/CLOUD_READINESS.md` (pre-cloud security contract), `docs/E2E.md` (how to run
 + test conventions), `docs/BACKUP_FORMAT.md` (format specification v2).

---

## 6. Notes for the full audit

**Files that must be read first (critical paths):**
1. `src/lib/tab-ownership.js` — safety kernel; bug = user tabs are closed.
2. `src/lib/sitedata.js` — largest concurrent pipeline; invariant tab + debugger.
3. `src/lib/cloud.js` — token, encryption, user data remotely.
4. `src/lib/restore.js` — writes to the user’s browser data; must be non-destructive.
5. `src/lib/crypto.js` — small but critical; without dedicated unit tests.
6. `src/dashboard/store.ts` — the only source of truth for the UI; mutual exclusion.

**Documented tech debt (do not treat as bugs):** complexity > 25 in
`runCloudBackup` (77), `collectSiteData` (65), `runProbes` (43),
`restoreTabsWindows` (37), `restoreCookies` (33), `restoreSiteData` (32),
`openOne` (30), `validateSettingsConfig` (27); `@ts-nocheck` in
`src/dashboard/{api,cloud-ui,backup-categories}.ts` + some components
(13 type errors remaining; see Memory 2026-10-02).

**Areas needing auditor attention:** `(scan as any)` in dashboard components
(loose with respect to library field changes); regex security-warning filter in
`LogPage`; `findOrCreateTab` ignores return `waitTabReady`; paths
mid-crawl stop and cross-session crash recovery have limited unit-test coverage.
