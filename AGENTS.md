# Panduan Agen

## Perintah
- `npm ci`, lalu `npm run build` → hasil di `.output/chrome-mv3/` (load unpacked untuk instal manual).
- `npm run check` = `lint` + `typecheck` + `format:check`. CI dan pre-commit (husky) menjalankan `npm run check` lalu `npm test`; jangan membuat perubahan yang merusaknya.
- `npm test` hanya menjalankan suite Node (`test:node`): tiap file `tests/*.mjs` adalah skrip Node mandiri (tanpa framework), jadi satu tes dijalankan dengan `node tests/<nama>.mjs` langsung.
- E2E/UI butuh Chromium: `export CHROMIUM_PATH=/path/to/chrome` (atau `npx playwright install chromium`), dan display — gunakan `xvfb-run -a npm run test:e2e` / `npm run test:ui`, atau `CI_HEADLESS=1`. E2E selalu `npm run build` dulu.
- `npm run cycles` (madge) untuk import sirkular, `npm run knip` untuk kode mati (entry: `src/entrypoints/**`, `src/dashboard/theme.ts`, `tests/**/*.mjs`).
- Rilis: push tag `vX.Y.Z` (harus sama dengan `package.json` version) → workflow `.github/workflows/release.yml` menjalankan check + unit test + build + `wxt zip`, lalu membuat GitHub Release berisi zip (selalu) dan CRX (hanya bila secret `CRX_PRIVATE_KEY` diisi — harus private key PEM yang cocok dengan `key` yang di-pin di `wxt.config.ts`, diverifikasi di CI; tanpa secret, rilis hanya berisi zip).

## Arsitektur
- Service worker (`src/entrypoints/background.ts`) sengaja minimal: hanya scheduler/alarm. Semua backup/restore berat berjalan di halaman dashboard agar lifecycle worker MV3 tidak mematikan operasi. Tidak ada popup — toolbar action membuka `dashboard.html` sebagai tab (ramah Android).
- `src/lib/`: logika inti (JS) — `collect.js`, `restore.js`, `sitedata.js` (orkestrasi pipeline; dependensi dipecah ke modul fokus: `scan-config.js` = SITE_DATA_CONFIG, `tab-ownership.js` = safety kernel tab, `scan-groups.js` = grup scan/error, `scan-concurrency.js` = slot pool + monitor CPU/load; `sitedata.js` me-re-export permukaan publiknya agar importer lama tak berubah), `site-log.js` (logging terpusat), `cloud.js`/`github.js`/`providers.js`, `scheduler.js`, `crypto.js`, `validate.js`, `settings.js`, `capabilities.js`.
- `src/dashboard/`: logika dashboard (TS) — `logic.ts`, `store.ts`, `api.ts` (menambah `window.__api` untuk otomasi tes via `installTestHooks()`), `theme.ts`, `site-log-store.ts`, `cloud-ui.ts`. Routing halaman via hash (`#/ringkasan`, `#/pengaturan`, `#/hasil`, `#/kegagalan`, `#/log`, `#/lainnya`) dalam satu `dashboard.html`.
- `public/lib/pagelib.js`: skrip yang di-inject ke halaman (namespace `__BBR`), dipakai membaca data per-site.
- Manifest: `key` publik bersifat tetap → ID extension deterministik. Jangan ubah permission tanpa kebutuhan nyata (kontrak kompatibilitas rilis).

## Keamanan tab (aturan keras)
- `chrome.tabs.remove` hanya boleh dipanggil di dalam `safeCloseTab` (`src/lib/tab-ownership.js`, ditandai `SAFETY-ALLOWED`), berdasarkan registry `ownedTabIds` + verifikasi URL tab masih membawa marker scan. Jangan pernah menutup tab berdasarkan query atau keanggotaan grup.
- `chrome.windows.remove` dilarang di mana-mana. Grup scan dibiarkan hilang sendiri saat tab terakhirnya ditutup.
- Ditegakkan berlapis: `tests/no-raw-tab-remove.mjs` (statis, termasuk akses dinamis `chrome.tabs["remove"]`), `tests/runtime-tab-remove-guard.mjs` (runtime), dan rule ESLint `no-restricted-syntax` (dinonaktifkan khusus di `sitedata.js` karena penanda `SAFETY-ALLOWED` dicek oleh tes).
- Jangan menghapus data browser/pengguna atau melakukan pembersihan storage yang luas.

## Keamanan lain
- `innerHTML`/`outerHTML` dilarang (XSS) — pakai DOM API yang aman.
- `no-console` di `src/` (pengecualian: implementasi `log()` di `src/lib/site-log.js`). Log lewat `log(level, category, message, context)` dengan level `DEBUG/INFO/WARN/ERROR/FATAL` dan kategori `W1/W2/STORAGE/CPU/LOAD/SAFETY/RETRY/SYSTEM`; catch kosong dilarang (`allowEmptyCatch: false`) — log alasannya.
- Higiene rahasia: token GitHub hanya di header `Authorization`, password tidak pernah ditransmisikan/disimpan; ekspor pengaturan tidak menyertakan token. Backup cloud public+plaintext selalu ditolak (`ERR_NO_PASSWORD` / `ERR_PUBLIC_REQUIRES_ENCRYPTION`) — tidak ada fallback plaintext.

## Lint & gaya (yang tidak terduga)
- `no-use-before-define`: `functions: false` (function declaration ter-hoist, aman), `classes`/`variables: true`. TDZ nyata datang dari `let/const/class`, bukan function — jangan "memperbaiki" dengan `functions: true` karena memaksa refactor kode aman.
- Type-aware rules aktif (`no-floating-promises`, `require-await`, `no-misused-promises`, `await-thenable`), tapi `unsafe-*` dimatikan karena file JS tidak punya tipe JSDoc. TypeScript dipin 5.9.2 (typescript-eslint belum mendukung TS 7).
- Batas `complexity` 25, `max-depth` 6, `max-params` 5. Pengecualian utang teknis yang terdokumentasi di `eslint.config.mjs` (mis. `runCloudBackup` 77, `collectSiteData` 65) adalah utang, bukan diabaikan — refactor berisiko mengubah perilaku, jadi jangan sentuh tanpa alasan.
- `no-await-in-loop` mati (await sekuensial disengaja); `require-atomic-updates` mati (false positive, tidak ada shared-memory concurrency).

## Konvensi tes
- Tulis tes Node sebagai skrip mandiri dengan `node:assert/strict` yang gagal via exit code; tambah ke rantai `test:node` di `package.json`.
- Konvensi E2E (`docs/E2E.md`): pakai ulang `launchDashboard()` + `apiCall()` dari `tests/e2e/launch.mjs`; restore butuh opsi kategori eksplisit (`options: { bookmarks: { enabled: true } }`) karena default restore nonaktif; kosongkan `chrome.storage.session` (`bbr:session-pw`) sebelum menguji perilaku tanpa password; akhiri setiap tes browser dengan asersi nol `pageErrors`.
- Sandbox yang memblokir navigasi top-level ke origin lokal (Chrome Local Network Access) tidak bisa mengasersi isi storage site-data — itu keterbatasan lingkungan, bukan bug.

## Git
- Jangan membuat commit, tag, atau push tanpa persetujuan eksplisit pengguna untuk tindakan tersebut. Jangan memakai amend, rebase, atau force-push sebagai pengganti persetujuan itu.

## Alur kerja
- Pahami struktur, alur terkait, kontrak, dokumentasi, dan tes sebelum merancang perubahan; petakan komponen serta dependensi sebelum perubahan arsitektur.
- Skill lengkap tersedia di `docs/agent-skills/`. Baca salinan yang relevan dan panggil skill terpasang yang sesuai pemicunya (`brainstorming` untuk desain, TDD untuk fitur/fix, `systematic-debugging` saat gagal, `verification-before-completion` sebelum klaim selesai).
- Jaga perubahan sekecil mungkin, pertahankan perilaku dan tes, jangan melemahkan atau menghapus tes, dan jangan menambah dependensi tanpa kebutuhan nyata.
- Pertahankan keselamatan backup/restore Chrome MV3 dan kontrak kompatibilitas rilis. Kontrak khusus rilis hanya boleh diubah berdasarkan desain atau spesifikasi yang telah disetujui.
