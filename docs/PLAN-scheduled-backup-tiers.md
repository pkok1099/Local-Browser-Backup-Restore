# Plan: Scheduled backup tanpa lag (siteData tiered / incremental)

## Masalah
Backup full butuh ~15 menit dan sangat lag. Dijalankan harian → tidak layak.
Root cause: 11 kategori adalah bacaan API Chrome (detik). `siteData` membuka
satu tab per origin + attach debugger (satu-satunya kategori lambat).

## Opsi yang dipertimbangkan

### A. Tiered schedule (REKOMENDASI)
- Backup terjadwal harian: 11 kategori cepat saja (tanpa `siteData`).
- `siteData`: tetap tersedia via backup manual, atau opt-in di jadwal.
- Artefak tetap snapshot lengkap per kategori yang disertakan; restore tidak berubah.

### B. Incremental history-based untuk siteData (REVISI — viable)
- Sinyal perubahan murah: satu `chrome.history.search({ text: '', startTime:
  lastCrawl, endTime: now })` → himpunan origin yang dikunjungi. Tanpa buka tab.
  Permission `history` sudah ada; pola query sudah dipakai di
  `capability-probes.js`.
- Crawl hanya untuk origin yang dikunjungi ∩ include-list (filter `includeOrigins`
  sudah ada di `sitedata.js`).
- Origin yang tidak dikunjungi: pakai ulang data dari backup sebelumnya (merge).
  Sumber data lama — dua sub-opsi:
  - B1: unduh artefak terakhir dari cloud, ambil section siteData, merge.
    (Tanpa store lokal baru; ada biaya unduh.)
  - B2: cache per-origin di `chrome.storage.local` (permission
    `unlimitedStorage` sudah ada), di-update tiap crawl; backup merakit dari
    cache + hasil fresh. (Tanpa unduh; ada store persisten baru.)
- Fallback aman: history kosong/di-clear → full crawl (jangan pernah skip buta).
- Edge case yang didokumentasikan: storage berubah tanpa visit (service worker
  background sync) akan kelewat sampai origin dikunjungi lagi.

Rekomendasi A: deterministik (harian selalu detik), simpel, mengatasi keluhan
inti. B hanya jika A dinilai kurang (siteData harian tetap diinginkan).

## Rencana implementasi (opsi A)

### Tugas 1: Opsi konfigurasi jadwal
- File: `src/lib/scheduler.js` (`normalizeScheduleConfig`), UI pengaturan jadwal.
- Tambah `schedule.includeSiteData: boolean` (default `false`).
- Verifikasi: unit test `normalizeScheduleConfig` — default false, true bertahan
  round-trip.

### Tugas 2: Scheduled run menghormati opsi
- File: `src/dashboard/cloud-ui.ts` (`runScheduledCloudBackupUnlocked`).
- Jika `includeSiteData === false`, teruskan `collectOptions.selectedCategories`
  = semua kategori kecuali `'siteData'` ke `runCloudBackup`.
- Verifikasi: test karakterisasi — collect dipanggil tanpa siteData saat opsi
  mati, dengan siteData saat opsi hidup.

### Tugas 3: UI checkbox + teks penjelasan
- File: komponen pengaturan jadwal (dashboard).
- Checkbox "Sertakan site data di backup terjadwal" + subteks:
  "Site data membuka satu tab per situs (±15 mnt). Matikan untuk backup harian
  yang cepat; site data tetap bisa di-backup manual kapan saja."
- Verifikasi: `npm run test:ui` hijau.

### Tugas 4: Verifikasi akhir
- `npm run check`, `npm test`, `npm run test:e2e` hijau.
- Pastikan backup manual tidak berubah (tetap full default).

## Risiko
- Artefak harian tidak berisi siteData → restore harian tidak mengembalikan
  siteData (oleh desain; backup manual/lama masih punya).
- Perubahan perilaku default: user yang sudah mengandalkan siteData harian
  perlu mencentang opsi (komunikasikan di catatan rilis).

## Di luar cakupan
- Incremental history-based (opsi B) — diputuskan setelah A dievaluasi.
- Mengubah backup manual.
