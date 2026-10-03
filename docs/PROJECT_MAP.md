# PROJECT MAP — Local Browser Backup & Restore

> Peta seluruh project untuk keperluan **audit total**. Dibuat 2026-10-03 dari pembacaan
> penuh 195 file (tidak termasuk `node_modules/`, `.output/`, `.wxt/`).
> Total ~22.700 LOC: `src/` 16.310 · `tests/` 5.497 · `public/lib/` 884 · `scripts/` 35.
>
> Cara pakai: setiap file diringkas (tujuan, ekspor kunci, dependensi, risiko).
> File **paling kritis untuk audit** ditandai 🔴. Tech debt yang sudah
> didokumentasikan di config ditandai 🟡.

## Gambaran umum

Extension Chrome MV3 (WXT + React 19) untuk **backup & restore data browser 100% lokal**
(12 kategori), dengan opsi upload terenkripsi ke GitHub, scheduler otomatis, dan
koleksi site-data (localStorage/IndexedDB/Cache/SW/OPFS per origin) via `chrome.debugger`.

**Prinsip arsitektur yang konsisten di seluruh codebase:**
- Pekerjaan berat berjalan di **halaman dashboard** (`dashboard.html`), BUKAN di service
  worker — agar tidak dibunuh lifecycle MV3. Worker hanya menangani scheduler/alarm.
- **Safety kernel tab** (`src/lib/tab-ownership.js`): satu-satunya `chrome.tabs.remove`
  yang diizinkan, dijaga runtime guard + static test. Invariant: hanya tab milik operasi
  yang boleh ditutup, hanya via `safeCloseTab`.
- Modul tanpa `chrome.*` (crypto, format, util, validate, scheduler-decision, artifact)
  murni dan bisa di-unit-test di Node.
- Kebijakan keamanan dipaksakan **di kode**, bukan hanya di UI: token tidak pernah
  dilog, repo publik wajib enkripsi, upload diverifikasi remote sebelum dinyatakan sukses.

## Alur data utama

```
collect.js (collectAll)
  → sitedata.js / capabilities.js (kumpulkan data)
  → format.js (skeleton + digest integritas)
  → crypto.js (opsional: PBKDF2 600k → AES-256-GCM)
  → artifact.js (artefak final + manifest)
  → providers.js / github.js — diorkestrasi cloud.js (upload → VERIFIKASI remote)
Restore: restore.js (+ sitedata.restoreSiteData) → API browser (non-destruktif default)
Scheduler: scheduler.js (keputusan murni) → background.ts (alarm) → dashboard ?action=
Dashboard: lib → callback/progress → store.patchState → useSyncExternalStore → render
```

---

## 1. `src/lib/` — logika inti (22 file)

### src/lib/artifact.js
- Tujuan: Membangun artefak backup remote — byte persis yang disimpan StorageProvider
  (JSON v2 plaintext atau envelope terenkripsi) beserta manifest remote.
- Ekspor kunci: `makeRemoteArtifact`, `manifestEntryFromArtifact`, `newRemoteManifest`,
  `normalizeManifest`, `upsertManifestEntry`, `assertUploadSafe`, `ENCRYPTION_VERSION`.
- Tergantung pada: `util.js`, `format.js`.
- Catatan/risiko: Tanpa `chrome.*` (testable di Node). `assertUploadSafe` adalah gerbang
  kebijakan upload (menolak plaintext ke repo publik).

### src/lib/capabilities.js
- Tujuan: Deteksi kapabilitas browser — kategori apa yang bisa read/backup/restore.
  Satu-satunya sumber kebenaran untuk capability report dan UI.
- Ekspor kunci: `getChromeVersion`, `detect`, `runProbes`.
- Tergantung pada: `capability-probes.js`.
- Catatan/risiko: Memakai `chrome.debugger`/`scripting`/dsb hanya untuk probing defensif.

### src/lib/capability-probes.js
- Tujuan: Probe runtime untuk menyempurnakan catatan kapabilitas statis.
- Ekspor kunci: `runCapabilityProbes`.
- Tergantung pada: `util.js`, `site-log.js`.
- Catatan/risiko: Menyentuh API sensitif hanya untuk uji baca; gagal probe tidak fatal.

### src/lib/cloud.js 🔴
- Tujuan: Orkestrator backup cloud — data → artefak → [enkripsi] → upload →
  VERIFIKASI objek remote → update manifest. Salinan lokal durable selalu ditulis dulu.
- Ekspor kunci: `runCloudBackup`, `beginScheduledRun`, `listCloudBackups`,
  `downloadAndValidateBackup`, `createProviderFromConfig`, `redactConfig`,
  `getCloudRetryInfo`, `cancelPendingCloudRetry`, `restoreCloudRetryAlarm`.
- Tergantung pada: `util.js`, `crypto.js`, `validate.js`, `artifact.js`, `providers.js`,
  `github.js`, `scheduler.js`.
- Catatan/risiko: 🟡 **Kompleksitas tertinggi kedua (`runCloudBackup`: 77)** — tech debt
  terdokumentasi. Password tidak pernah disimpan/dilog. Upload gagal → marker pending,
  run berikutnya re-sync artefak yang sama (tanpa re-collect).

### src/lib/collect.js
- Tujuan: Kolektor semua kategori backup via API ekstensi publik → format dokumen.
- Ekspor kunci: `collectAll`, `computeCounts`.
- Tergantung pada: `util.js`, `capabilities.js`, `sitedata.js`.
- Catatan/risiko: Menyentuh API paling luas (readingList, sessions, history, cookies,
  tabGroups, windows, tabs, storage, management, downloads). Cookie value tidak dilog;
  incognito dikecualikan by design.

### src/lib/crypto.js 🔴
- Tujuan: Enkripsi backup — PBKDF2-HMAC-SHA-256 (600k iterasi) → AES-256-GCM dengan
  additional data mengikat header envelope. Murni Web Crypto.
- Ekspor kunci: `encryptBackup`, `decryptBackup`.
- Tergantung pada: `util.js`, `artifact.js`.
- Catatan/risiko: Tanpa `chrome.*`, kecil dan terisolasi. Kritis untuk keamanan.
  ⚠️ Tidak punya unit test khusus (hanya teruji via E2E round-trip).

### src/lib/format.js
- Tujuan: Konstanta format backup v2, skeleton backup baru, digest integritas.
- Ekspor kunci: `FORMAT_ID`, `ENCRYPTED_FORMAT_ID`, `FORMAT_VERSION`,
  `SUPPORTED_FORMAT_VERSIONS`, `newBackupSkeleton`, `finalizeIntegrity`, `verifyIntegrity`.
- Tergantung pada: `util.js`.
- Catatan/risiko: Tanpa `chrome.*`. v1 tetap bisa dibaca (upgrade transparan).

### src/lib/github.js 🔴
- Tujuan: `GitHubStorageProvider` — backup cloud via GitHub Contents API. Upload
  dipaksa terverifikasi (re-download + sha256 + bandingkan git blob sha).
- Ekspor kunci: `GitHubStorageProvider`.
- Tergantung pada: `util.js`, `artifact.js`, `providers.js`.
- Catatan/risiko: Token PAT hanya di header `Authorization`, tidak pernah dilog/masuk
  artefak. Repo publik → enkripsi WAJIB.

### src/lib/providers.js
- Tujuan: Kontrak `StorageProvider` + `LocalStorageProvider` + `BackupRef`.
- Ekspor kunci: `StorageProvider`, `BackupRef`, `LocalStorageProvider`.
- Tergantung pada: `util.js`, `artifact.js`.
- Catatan/risiko: Provider hanya beroperasi pada artefak final, tidak pada data mentah.

### src/lib/restore.js 🔴
- Tujuan: Mesin restore — default NON-DESTRUKTIF (bookmark merge, tab/window/session
  dibuat baru). Mode "replace" hanya untuk bookmark + butuh konfirmasi eksplisit.
- Ekspor kunci: `restoreTabsWindows`, `restoreAll`.
- Tergantung pada: `util.js`, `sitedata.js`.
- Catatan/risiko: 🟡 Kompleksitas tinggi (`restoreTabsWindows`: 37, `restoreCookies`: 33).
  Menulis ke data browser user — harus tetap non-destruktif. Placeholder tab window-restore
  ditutup hanya via `safeCloseTab` dengan verify `windowId`.

### src/lib/scan-concurrency.js
- Tujuan: Primitif konkurensi crawler site-data — slot pool (hard tab window), antrean
  handoff worker, monitor adaptif CPU/load.
- Ekspor kunci: `clampScanWindow`, `clampInt`, `createSlotPool`, `createAsyncQueue`,
  `createSystemCpuSampler`, `createLoadMonitor`, `startCpuMonitor`.
- Tergantung pada: `scan-config.js`.
- Catatan/risiko: Satu-satunya pengguna `chrome.system.cpu`. Window tidak pernah < 2;
  turun cepat / naik lambat (anti-osilasi).

### src/lib/scan-config.js
- Tujuan: Satu objek tuning terpusat `SITE_DATA_CONFIG` (window, konkurensi, timeout,
  exclusion, retry, stop, storage). Modul data murni — tidak bisa menimbulkan cycle.
- Ekspor kunci: `SITE_DATA_CONFIG`.
- Tergantung pada: tidak ada.
- Catatan/risiko: Audit tuning cukup baca file ini.

### src/lib/scan-groups.js
- Tujuan: Manajer grup tab — satu grup "BBR Site Scan" + fallback "BBR Site Error"
  (merah) untuk tab yang gagal masuk grup scan.
- Ekspor kunci: `createGroupManager`, `SCAN_ERROR_GROUP_TITLE`, `SCAN_ERROR_GROUP_COLOR`.
- Tergantung pada: tidak ada.
- Catatan/risiko: Grup tidak pernah dihapus langsung — hilang saat tab terakhir ditutup.
  Tab milik user tidak pernah di-group.

### src/lib/scheduler.js
- Tujuan: Scheduler backup otomatis — fungsi keputusan MURNI (testable di Node) +
  helper config/state via `chrome.storage`.
- Ekspor kunci: `normalizeScheduleConfig`, `isBackupDue`, `loadSchedulerState`,
  `saveSchedulerState`, `isLocked`, `cloudRetryDelayMs`, konstanta alarm.
- Tergantung pada: tidak ada (diimpor `cloud.js`).
- Catatan/risiko: "Due" dihitung dari backup SUKSES terakhir → gagal = retry backoff,
  sukses = tidak duplikat.

### src/lib/settings.js
- Tujuan: Ekspor/impor pengaturan.
- Ekspor kunci: `buildSettingsExport`, `parseSettingsImport`.
- Tergantung pada: `cloud.js`.
- Catatan/risiko: **Token-safe**: saat impor, token GitHub dari file TIDAK dipakai —
  token saat ini dipertahankan.

### src/lib/site-data-selection.js
- Tujuan: Helper filter/pilih origin site-data untuk UI.
- Ekspor kunci: `filterSiteDataOrigins`, `getSelectedSiteDataOrigins`.
- Tergantung pada: tidak ada. Risiko praktis nol (16 baris, murni).

### src/lib/site-log.js
- Tujuan: Logging terpusat crawl — `log(level, category, message, context)`,
  level DEBUG–FATAL, kategori W1/W2/STORAGE/CPU/LOAD/SAFETY/RETRY/SYSTEM. Buffer + batch
  ke IndexedDB (cap 5000); gagal tulis tidak menghentikan crawl.
- Ekspor kunci: `createSiteLogger`, `querySiteLog`, `clearPersistedSiteLog`,
  `selectLogEntriesToTrim`, `formatLogTs`, `LOG_LEVELS`, `LOG_CATEGORIES`.
- Tergantung pada: tidak ada.

### src/lib/sitedata.js 🔴
- Tujuan: Kolektor site-data — pipeline dua worker (W1 buka tab scan ≤ window →
  grup; W2 baca via `chrome.debugger` 4 konkuren → tutup tab). Failed pool + retry
  waves, storage retry terpisah, URL exclusion, clean stop, checkpoint resume,
  adaptive window, logging terpusat. Juga `restoreSiteData`.
- Ekspor kunci: `collectSiteData`, `restoreSiteData`, `discoverOrigins`,
  `filterSiteDataOriginsForBackup`, `isExcluded`, `computeSiteDataCounts`
  (+ re-export modul pecahan: `SITE_DATA_CONFIG`, `createTabOwnership`, `verifyScanTab`,
  `createSiteDataOwnership`, `cleanupPreviousSessionTabs`, `createSlotPool`, …).
- Tergantung pada: `util.js`, `site-log.js`, `scan-config.js`, `tab-ownership.js`,
  `scan-groups.js`, `scan-concurrency.js`.
- Catatan/risiko: 🟡 **File terbesar (2138 baris) dan kompleksitas tertinggi
  (`collectSiteData`: 65)**. API sensitif: `chrome.debugger`, `chrome.scripting`.
  Invariant tab: hanya milik operasi via `safeCloseTab`.

### src/lib/tab-ownership.js 🔴
- Tujuan: **Safety kernel tab** — satu-satunya `chrome.tabs.remove` yang diizinkan
  (via `safeCloseTab`), dijaga runtime guard anti-bypass. `verifyScanTab` memastikan
  tab masih menampilkan halaman scan (atau `failed` untuk chrome-error) sebelum tutup;
  `origin=''` = origin tak diketahui (crash-recovery) → cocok marker saja.
- Ekspor kunci: `createTabOwnership`, `verifyScanTab`, `createSiteDataOwnership`,
  `cleanupPreviousSessionTabs`, `originOf`, `scanUrlFor`, `SCAN_MARKER`.
- Tergantung pada: `site-log.js`, `scan-config.js`.
- Catatan/risiko: **Paling kritis untuk keselamatan data user.** Cleanup by recorded-ID
  only, tidak pernah by query/grup. `closingTabIds`/`ownedTabIds` dibersihkan di finally.

### src/lib/util.js
- Tujuan: Utilitas dasar — `TypedError`, canonicalize JSON, base64, sha256, gzip,
  `yieldToUI`, `errCode`/`errMessage`.
- Ekspor kunci: `TypedError`, `canonicalize`, `sha256Hex`, `bytesToB64`/`b64ToBytes`,
  `gzipCompress`/`gzipDecompress`, `yieldToUI`, `errCode`, `errMessage`.
- Tergantung pada: tidak ada (diimpor 9 file).
- Catatan/risiko: `TypedError` adalah fondasi error handling bertipe seluruh codebase.

### src/lib/validate.js
- Tujuan: Validasi file backup — struktur, versi, digest, sanity semantik. Error bertipe
  (salah-password vs korup vs versi tak didukung).
- Ekspor kunci: `validateBackupFile`.
- Tergantung pada: `util.js`, `format.js`, `crypto.js`.
- Catatan/risiko: ⚠️ Tidak punya unit test khusus.

### src/lib/utils.ts
- Tujuan: Helper `cn()` untuk merge class Tailwind (clsx + tailwind-merge), standar shadcn.
- Ekspor kunci: `cn`. Satu-satunya file yang mengimpor dependensi npm langsung.

---

## 2. UI — `src/entrypoints/`, `src/dashboard/`, `src/components/dashboard/`

### src/entrypoints/background.ts
- Tujuan: Service worker MV3 yang disengaja minimal — hanya scheduler: alarm periodik,
  evaluasi jadwal backup cloud (termasuk catch-up), retry upload tertunda.
- Ekspor kunci: `defineBackground(...)` — handler `onInstalled`/`onStartup`/`onAlarm`/
  `onMessage`; `checkScheduleAndRun()`, `checkCloudRetryAndRun()`.
- Tergantung pada: `@/lib/scheduler`, `@/lib/cloud`.
- Catatan/risiko: Pekerjaan berat TIDAK di worker — worker hanya membuka
  `dashboard.html?action=…` sebagai tab background. Guard anti-duplikat tab scheduled-run.

### src/entrypoints/dashboard/main.tsx
- Tujuan: Boot dashboard: tema anti-flash → `window.__api` untuk tes → cleanup tab sisa
  sesi lalu → render `<App/>`.
- Ekspor kunci: tidak ada (side-effect): `initThemeSync()`, `installTestHooks()`,
  `cleanupPreviousSession()`, listener `beforeunload` best-effort.
- Tergantung pada: `./App`, `@/dashboard/api`, `@/dashboard/theme`,
  `@/dashboard/site-log-store`, `@/lib/sitedata` (dynamic import).
- Catatan/risiko: `beforeunload` async sering tidak selesai — jaring pengaman sebenarnya
  adalah cleanup saat dashboard dibuka ulang.

### src/entrypoints/dashboard/App.tsx
- Tujuan: Shell React: header, hash-routing 6 halaman dalam SATU `dashboard.html`,
  error boundary per chunk lazy, dialog password, toaster.
- Ekspor kunci: `App`, `useHashRoute()`, `RouteChunkErrorBoundary`, `NAV`.
- Tergantung pada: `@/dashboard/store`, `@/dashboard/lazy-route`, `@/dashboard/theme`,
  komponen Header/pages (5 halaman lazy).
- Catatan/risiko: Hash routing disengaja agar konteks JS crawl tidak hancur saat pindah
  halaman. `?action=` memicu `cloud-ui.init()` (scheduled/retry auto-start).

### src/dashboard/store.ts
- Tujuan: Store eksternal tunggal (`useSyncExternalStore`) — satu-satunya sumber
  kebenaran semua halaman.
- Ekspor kunci: tipe `AppState`, `useApp()`, `getState/setState/patchState/updateForm/
  appendLog`, `withDashboardActivity()` (mutual exclusion via Web Locks +
  BroadcastChannel), `hasUnresolvedSiteScan()`.
- Tergantung pada: react saja.
- Catatan/risiko: Hanya satu operasi berat dalam satu waktu antar tab dashboard.
  Clear Results/Logs fail-closed bila Web Locks tak tersedia.

### src/dashboard/api.ts + api-operations.ts
- Tujuan: Permukaan otomasi `window.__api` untuk E2E/UI + implementasi operasinya
  (probe, collectAll, backup, cloud, scheduler, restore, seed helpers).
- Ekspor kunci: `installTestHooks()`; namespace `__api.*`.
- Tergantung pada: `./store`, `./logic`, `@/lib/{collect,cloud,restore,validate,
  capabilities,scheduler,crypto,util}`.
- Catatan/risiko: 🟡 `@ts-nocheck` (tech debt). `seed.*` memanipulasi tab/window asli —
  hanya untuk tes.

### src/dashboard/logic.ts 🟡
- Tujuan: Orkestrator operasi dashboard: build backup, doBackup + stop, download
  on-demand (tanpa auto-download), retry site-data, dialog password, alur restore,
  capabilities, clear results.
- Ekspor kunci: `doBackup`, `buildBackupObject/buildCloudBackupObject`,
  `downloadBackupResult`, `retrySiteDataUrls/retrySiteDataSave`, `askPassword`,
  `openRestoreFlow/onRestoreGo`, `showCapabilities`, `clearBackupResults`,
  `requestBackupStop`.
- Tergantung pada: `./store`, `./backup-categories`, `./site-log-store`,
  `@/lib/{collect,restore,sitedata,format,crypto,validate,capabilities}`.
- Catatan/risiko: Hasil backup di memori + extension storage; tombol "Download hasil"
  eksplisit; Blob dibangun inkremental. Salah satu dari 13 type error yang belum
  dibereskan (lihat Memory 2026-10-02).

### src/dashboard/cloud-ui.ts 🟡
- Tujuan: Logika UI cloud: connect GitHub, backup manual/terjadwal/retry, remote
  list/restore/delete, export/import settings, auto-start via `?action=`.
- Ekspor kunci: `init()`, `onCloudConnect`, `onCloudBackupNow`, `onCloudRestore`,
  `onRetrySync`, `exportSettingsFile/importSettingsFile`, `saveCloudSettings`.
- Tergantung pada: `./store`, `./logic`, `@/lib/{cloud,github,providers,scheduler,
  settings,util,capabilities}`.
- Catatan/risiko: 🟡 `@ts-nocheck`. Token dikosongkan dari form setelah save; hanya di
  memori + storage config. Plaintext upload butuh `confirm()` + hanya repo private
  (enforcement nyata di storage layer).

### src/dashboard/backup-categories.ts
- Tujuan: Definisi 12 kategori backup + persistensi preferensi (`chrome.storage.local`):
  kategori terpilih, origin situs, scan window, tuning crawl, include
  sessionStorage/serviceWorkers.
- Ekspor kunci: `BACKUP_CATEGORIES`, load/save untuk kategori, origin, window, tuning.
- Tergantung pada: `@/lib/sitedata` (`SITE_DATA_CONFIG` sebagai batas tunggal).
- Catatan/risiko: 🟡 `@ts-nocheck`. Semua nilai di-clamp saat load (aman dari storage
  korup). sessionStorage/serviceWorkers default OFF (keterbatasan platform).

### src/dashboard/lazy-route.ts
- Tujuan: Loader chunk route lazy dengan pemulihan satu-kali (reload sekali, guard di
  sessionStorage agar tidak loop).
- Ekspor kunci: `loadRouteChunk`, `retryRouteChunk`.
- Tergantung pada: tidak ada (murni; window.sessionStorage/location bisa di-inject
  untuk tes).

### src/dashboard/site-log-store.ts
- Tujuan: Store live site-log crawl: entri live + IndexedDB, flag error-belum-dilihat,
  clear lintas tab.
- Ekspor kunci: `pushSiteLogEntry`, `useSiteLog()`, `useUnseenSiteLogError()`,
  `markSiteLogSeen()`, `clearSiteLogView()`, `loadPersistedSiteLog()`.
- Tergantung pada: `@/lib/site-log`, `./store`, BroadcastChannel.
- Catatan/risiko: Buffer live 2000 entri; clear lintas tab via BroadcastChannel.

### src/dashboard/theme.ts
- Tujuan: Tema light/dark/system — persist `chrome.storage.local` + mirror sinkron
  `window.localStorage` agar class `dark` terpasang sebelum first paint.
- Ekspor kunci: `initThemeSync()`, `loadTheme()`, `setTheme()`, `watchSystemTheme()`,
  `useTheme()`, `useResolvedTheme()`.
- Tergantung pada: react, matchMedia, chrome.storage.local.

### src/components/dashboard/ (23 file)
Halaman dan kartu — semuanya presentasional, state via `useApp()`:
- `pages.tsx` (`SummaryPage`), `SettingsPage.tsx`, `ResultsPage.tsx`, `FailuresPage.tsx`,
  `LogPage.tsx`, `MorePage.tsx` — komposisi per halaman (5 di antaranya lazy).
- `Header.tsx`, `ThemeToggle.tsx`, `LocalActionsCard.tsx`, `BackupProgressCard.tsx`,
  `CrawlStatusBar.tsx`, `DownloadResultButton.tsx` — ringkasan & progres.
- `BackupCategoriesCard.tsx`, `SiteDataSelectionCard.tsx`, `SiteDataTuningCard.tsx` —
  pengaturan.
- `SiteResultsList.tsx`, `SiteFailuresList.tsx` — hasil & retry per item
  (save-failed hanya disimpan ulang, tidak diambil ulang).
- `SiteLogViewer.tsx`, `LogCard.tsx` — penampil log terstruktur + log mentah.
- `RestoreCard.tsx`, `CloudCard.tsx`, `CapabilitiesCard.tsx`, `PasswordDialog.tsx`.
- Catatan/risiko: Banyak akses `(scan as any)` ke field liveStats dinamis di
  `CrawlStatusBar`/`BackupProgressCard` — longgar terhadap tipe; berisiko silent bila
  nama field berubah di lib. Filter peringatan keamanan di `LogPage` berbasis regex —
  rapuh bila format pesan berubah. Beberapa file `@ts-nocheck`.

### src/components/ui/ (14 file, ~709 baris)
Satu set shadcn/ui gaya `new-york` berbasis Radix (badge, button, card, checkbox,
dialog, input, label, progress, radio-group, select, separator, sonner, table) —
wrapper tipis `cva` + `cn()`. Murni presentasional, tanpa logika bisnis.

---

## 3. Konfigurasi, scripts, public

### package.json
- Isi: `local-browser-backup-extension` v1.4.7, `type: module`, `private: true`.
  Dependencies runtime hanya 4: `wxt`, `@wxt-dev/module-react`, `react`, `react-dom`.
- Scripts: `dev`/`build`/`zip` (wxt); `test:node` (19 skrip Node mandiri); `test:ui`;
  `test:e2e` (6 skrip E2E); `lint` (eslint src, zero-warning); `typecheck`
  (tsc + tsconfig.check.json); `format:check`/`format:write` (prettier src/);
  `check` = lint + typecheck + format:check; `cycles` (madge); `knip`.
- Key `"prettier"`: printWidth 80, semi, singleQuote, tabWidth 2, trailingComma es5
  (dipindah dari `.prettierrc.json` 2026-10-03; prettier auto-discovery).
- Catatan: `npm run check` tidak mencakup tes — itu di pre-commit/CI.

### wxt.config.ts
- Isi: Konfigurasi build WXT + modul React + plugin Tailwind (vite). Manifest:
  `key` publik tetap (extension ID deterministik), `minimum_chrome_version` 114,
  15 permission (bookmarks, history, tabs, tabGroups, sessions, cookies, downloads,
  readingList, storage, unlimitedStorage, management, scripting, debugger, alarms,
  system.cpu), `host_permissions` http/https, action tanpa popup (membuka dashboard).

### tsconfig.json / tsconfig.check.json / tsconfig.madge.json
- `tsconfig.json`: `strict: true` + `checkJs: true`, `noUncheckedIndexedAccess`,
  `noUnusedLocals/Parameters`, `exactOptionalPropertyTypes`; extends `.wxt/tsconfig.json`.
- `tsconfig.check.json`: extends di atas tapi `checkJs: false`, include hanya
  TS/TSX — inilah yang dipakai `npm run typecheck` (file JS di-cover ESLint type-aware).
- `tsconfig.madge.json`: hanya alias `paths` agar madge bisa resolve import.

### eslint.config.mjs
- Isi: Flat config — `js.configs.recommended` + `typescript-eslint` (4 aturan type-aware
  manual: `no-floating-promises`, `no-misused-promises`, `await-thenable`,
  `require-await`) + `eslint-plugin-import` + `eslint-config-prettier`.
- Aturan penting: `no-use-before-define` (functions off / classes+variables on — TDZ),
  `import/no-cycle`, `no-empty` (catch kosong dilarang), `no-console` (kecuali
  site-log.js), `eqeqeq`, `no-param-reassign`, `no-shadow`, `complexity` 25 /
  `max-depth` 6 / `max-params` 5 (8 pengecualian tech-debt terdokumentasi),
  `no-restricted-syntax` melarang `chrome.tabs.remove` mentah (override khusus
  tab-ownership.js), `no-restricted-properties` melarang `innerHTML`/`outerHTML`,
  `reportUnusedDisableDirectives: error`.
- Catatan: `unsafe-*` dimatikan (file JS tanpa JSDoc); `tests/**` dilonggarkan.

### knip.json
- Isi: Entry `src/entrypoints/**`, `src/dashboard/theme.ts`, `tests/**/*.mjs`;
  project `src/**`, `tests/**`, `scripts/**`. Dikonfigurasi agar false-positive
  hilang untuk entry WXT. Tidak bisa dipindah ke package.json (knip v6 hanya baca
  8 lokasi file).

### components.json
- Isi: Konfigurasi shadcn/ui (style `new-york`, slate, cssVariables, lucide).
  File wajib shadcn CLI.

### .husky/pre-commit + scripts/pre-commit + .github/workflows/check.yml
- Husky hook: `npm run check` lalu `npm test` (terinstal via script `prepare`).
- `scripts/pre-commit`: alternatif manual (`cp scripts/pre-commit .git/hooks/pre-commit`).
- CI (push/PR, Node 24): `npm ci` → `npx wxt prepare` (wajib sebelum typecheck) →
  `npm run check` → `npm test`.

### scripts/screenshot.mjs
- Isi: Smoke test visual via Playwright (dashboard desktop 768px + mobile 360px).
  Dijalankan manual via `npm run screenshot`; bukan bagian rantai tes.

### public/lib/pagelib.js (884 baris)
- Isi: Skrip yang di-inject ke halaman target via debugger; mengekspos
  `globalThis.__BBR`: read/restore per kategori (localStorage, sessionStorage,
  IndexedDB, Cache Storage, service worker, OPFS, buckets) + agregat
  `readSiteAll`/`restoreSiteAll`/`wipeSiteAll` + transport chunked
  (`setTx`/`txChunk`/`clearTx`/`pushRx`/`takeRx`).
- Catatan/risiko: Satu-satunya jembatan baca/tulis storage antar-origin; dipanggil
  dari `src/lib/sitedata.js` lewat `chrome.debugger`.

## Ringkasan toolchain
- Build: WXT → `.output/chrome-mv3/`. Lint/format: ESLint (ketat, zero-warning) +
  Prettier — keduanya hanya mencakup `src/`.
- Typecheck: `tsc --noEmit` via `tsconfig.check.json` (TS/TSX saja); wajib
  `npm ci` + `npx wxt prepare` dulu.
- Tes: `npm test` = 19 skrip Node mandiri (`node:assert/strict`, tanpa framework);
  E2E/UI butuh Chromium hasil build (`xvfb-run` atau `CI_HEADLESS=1`).
- Gerbang mutu: `npm run check` → pre-commit/CI → `npm test`; `npm run cycles`
  (madge) dan `npm run knip` untuk circular-dependency dan kode mati.

---

## 4. Unit tests — `tests/*.mjs` (19 file, tanpa framework)

| File | Menguji | Gap terlihat |
|---|---|---|
| `sitedata-tab-cleanup.mjs` (779 baris, terbesar) | Pipeline `collectSiteData` asli vs chrome palsu — skenario A–Q: hard window, takeover user (tidak pernah ditutup), CPU adaptif, exactly-once safeCloseTab, retry waves, storage retry, fallback grup error | Jalur Stop-di-tengah-crawl minim; crash-recovery antar-sesi hanya di E2E |
| `verify-scan-failed.mjs` | Verdict `verifyScanTab`: chrome-error→`failed`, scan→`ours`, user→`foreign`, hilang→`gone`, origin kosong→marker-only (fix F1, TDD merah-dulu) | Hanya varian `url`, bukan `pendingUrl` |
| `runtime-tab-remove-guard.mjs` | Guard runtime `chrome.tabs.remove`: 5 pola bypass (alias/destructuring/dinamis) ditolak + tercatat; close resmi tetap jalan | — |
| `no-raw-tab-remove.mjs` | Statis: tiap `chrome.tabs.remove` harus choke point `safeCloseTab` bertanda SAFETY-ALLOWED; `windows.remove` dilarang | Obfuskasi eksotis lolos (ditutup runtime guard) |
| `no-circular-import.mjs` | Tidak ada import sirkular antar modul inti (pencegah TDZ) | Melewatkan components/entrypoints; dynamic import tidak dianalisis |
| `restore-tabs.mjs` | `restoreTabsWindows` + matriks outcome `restoreAll` (ok/partial/failed) | Restore cookies/history/downloads tidak mendalam |
| `restore-tabs-android.mjs` | Jalur Android: two-phase create-then-navigate | Sempit — hanya urutan dispatch |
| `cloud-backup-characterization.mjs` | `runCloudBackup` provider `local`: urutan side-effect durable | Hanya provider `local` |
| `cloud-provider-guard.mjs` | Plaintext-safety `GitHubStorageProvider` vs simulator REST: matriks public/private × plaintext/encrypted; token hanya di header Authorization | — |
| `cloud-retry.mjs` | Normalisasi config, backoff delay, cancel/restore alarm | Eksekusi retry aktual hanya di E2E |
| `schedule-settings.mjs` | Normalisasi jadwal, `isBackupDue`, transfer settings token-safe | Edge timezone/DST tidak diuji |
| `collect-selection.mjs` | `collectAll` hanya kategori terpilih; allowlist extensionStorage | Allowlist di-hardcode di tes (perlu sinkron manual) |
| `site-data-origins.mjs` | `discoverOrigins` + filter/seleksi origin | — |
| `site-exclude.mjs` | `isExcluded` — 23 kasus URL berbasis hostname parse (anti false-positive) | IPv6 `[::1]` tidak dicover |
| `site-log.mjs` | `createSiteLogger` + integrasi `collectSiteData` via `onLogEntry` | Persistensi IndexedDB tidak diuji di Node |
| `pagelib-category-failures.mjs` | `pagelib.js` asli di `node:vm` dengan semua API storage melempar — tiap kategori gagal independen | Hanya kasus semua-gagal |
| `probe-characterization.mjs` | `runProbes` — bentuk output, isolasi kegagalan per kategori | Mengunci perilaku, bukan kebenaran penilaian |
| `lazy-route-retry.mjs` | `loadRouteChunk`/`retryRouteChunk` — gagal sekali→reload; gagal berulang→tidak loop | — |
| `theme-mode.mjs` | `theme.ts` — boot, persist, system-follow, tanpa flash | Interaksi tombol di E2E |
| `extension-ui.mjs` (2069 baris) | Extension HASIL BUILD di Chromium: manifest, lazy chunks (JS awal ≤300KiB), layout mobile, settings import/export, restore + password, kegagalan route chunk | Dangkal per halaman; logika bisnis tetap di unit |
| `api-operations.types.ts` | Typecheck `runCloudBackup`/`runIfDue` via `@ts-expect-error` | By design tanpa asersi runtime |

**Ringkasan cakupan:** Paling kuat — keselamatan tab (4 lapis), pipeline site-data
(skenario A–Q), guard plaintext provider, higiene token. Paling lemah — `crypto.js`
dan `validate.js` tanpa unit test khusus; logika dashboard TS selain theme hanya
tersentuh E2E dangkal; jalur Stop-di-tengah-crawl dan crash-recovery minim di unit.

---

## 5. E2E — `tests/e2e/` (8 file) dan `docs/`

E2E dijalankan: `npm run build` dulu, lalu `xvfb-run -a npm run test:e2e`
(atau `CI_HEADLESS=1`). Rantai: local → cloud → scheduler → sitedata-tabs →
sitedata-error-tabs → theme-toggle, semua lewat extension hasil build asli di
Chromium Playwright (`launch.mjs` + `window.__api`).

| File | Isi |
|---|---|
| `launch.mjs` | Launcher bersama: load extension, tunggu `window.__api`, `apiCall`/`must`, kumpulkan `pageErrors` |
| `seeds.mjs` / `github-simulator.mjs` | Helper seed bookmark; simulator REST GitHub in-memory (fault injection, audit hygiene token) |
| `local-roundtrip.mjs` | Seed → backup terenkripsi → destroy → password salah ditolak → restore persis → idempoten |
| `cloud-roundtrip.mjs` | Siklus cloud vs simulator: upload terverifikasi, manifest, digest-mismatch ditolak, HTTP 500 → retry sync artefak yang sama, matriks public/private × plaintext/encrypted |
| `scheduler-roundtrip.mjs` | Due/catch-up → eksekusi → dedup `already-succeeded-today` → disabled tidak due → tanpa password ditolak |
| `sitedata-tabs.mjs` | Pipeline streaming: hard window tidak pernah terlampaui (polling live), tab pre-existing dipakai tapi tak tersentuh, progres monotonik, teardown bersih |
| `sitedata-error-tabs.mjs` | 2 origin jalan + 3 rusak (port tertutup, DNS `.invalid`): jumlah tab setelah == sebelum, tanpa marker/ID baru/chrome-error, kedua grup hilang |
| `theme-toggle.mjs` | Dark mode: siklus light→dark→system, persist setelah reload |

Dokumen terpenting untuk auditor: `docs/PERMISSIONS.md` (jejak permission→fitur),
`docs/CAPABILITY_REPORT.md` (klaim fidelity + bukti + keterbatasan tak terperbaiki),
`docs/CLOUD_READINESS.md` (kontrak keamanan pra-cloud), `docs/E2E.md` (cara
menjalankan + konvensi tes), `docs/BACKUP_FORMAT.md` (spesifikasi format v2).

---

## 6. Catatan untuk audit total

**File yang wajib dibaca duluan (jalur kritis):**
1. `src/lib/tab-ownership.js` — safety kernel; bug = tab user tertutup.
2. `src/lib/sitedata.js` — pipeline konkuren terbesar; invariant tab + debugger.
3. `src/lib/cloud.js` — token, enkripsi, data user di remote.
4. `src/lib/restore.js` — menulis ke data browser user; harus non-destruktif.
5. `src/lib/crypto.js` — kecil tapi kritis; tanpa unit test khusus.
6. `src/dashboard/store.ts` — satu-satunya sumber kebenaran UI; mutual exclusion.

**Tech debt terdokumentasi (jangan dianggap bug):** complexity > 25 pada
`runCloudBackup` (77), `collectSiteData` (65), `runProbes` (43),
`restoreTabsWindows` (37), `restoreCookies` (33), `restoreSiteData` (32),
`openOne` (30), `validateSettingsConfig` (27); `@ts-nocheck` di
`src/dashboard/{api,cloud-ui,backup-categories}.ts` + sebagian komponen
(13 type error tersisa, lihat Memory 2026-10-02).

**Area yang butuh perhatian auditor:** `(scan as any)` di komponen dashboard
(longgar terhadap perubahan field lib); filter regex peringatan keamanan di
`LogPage`; `findOrCreateTab` mengabaikan return `waitTabReady`; jalur
Stop-di-tengah-crawl dan crash-recovery antar-sesi minim di unit test.
