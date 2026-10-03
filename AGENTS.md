# Panduan Agen

## Validasi
- CI memakai Node 24: `npm ci` → `npm exec -- wxt prepare` → `npm run check` → `npm test`; `check` menjalankan lint → typecheck → format:check. `wxt prepare` membuat `.wxt/` yang dibutuhkan TypeScript; jangan edit hasil generated itu.
- Jalankan satu tes Node dengan `node tests/<nama>.mjs`; `npm test` menjalankan seluruh rangkaian Node, bukan tes browser.
- Tes UI/E2E memakai build MV3 nyata: jalankan `npm run build`, lalu `xvfb-run -a npm run test:ui` atau `xvfb-run -a npm run test:e2e` (perlu Chromium dan display; gunakan `CI_HEADLESS=1` untuk mode headless).

## Struktur dan keselamatan
- Backup/restore berjalan di halaman dashboard extension; `src/entrypoints/background.ts` menangani alarm jadwal dan retry saja—jangan pindahkan operasi panjang ke service worker MV3.
- Pertahankan kompatibilitas backup v1/v2; `formatVersion` dan `encryptionVersion` adalah versi terpisah. Ubah kontrak rilis hanya berdasar desain/spesifikasi yang disetujui; periksa `docs/BACKUP_FORMAT.md` dan `src/lib/{format,validate,crypto}.js` sebelum perubahan format.
- Restore harus tetap non-destruktif secara default: bookmark di-merge dan tab/jendela baru dibuat. Mode replace bookmark memerlukan opt-in serta konfirmasi; jangan menghapus data browser atau storage secara luas.
- Tutup hanya tab yang dibuat/dimiliki operasi lewat `safeCloseTab`; jangan panggil `chrome.windows.remove`. ESLint dan `tests/no-raw-tab-remove.mjs` menjaga aturan ini.

## Git
- Jangan membuat commit, tag, atau push tanpa persetujuan eksplisit pengguna.
