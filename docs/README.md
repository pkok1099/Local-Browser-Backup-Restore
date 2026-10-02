# Local Browser Backup & Restore

Extension Chromium/Chrome **Manifest V3** untuk backup dan restore data browser secara **100% lokal** — tanpa server, tanpa telemetry, tanpa native code, tanpa modifikasi browser.

- **Versi format backup:** 1 (`chrome-local-backup`)
- **Core backup/restore diuji pada:** Chrome for Testing 131.0.6778.204 (Linux x86-64, headless)
- **Versi minimum:** Chrome/Chromium ≥ 114 (karena permission `readingList`)
- Kategori backup dapat dipilih di dashboard. Website data menampilkan daftar origin dengan pencarian dan pilihan include per situs.

---

## Instalasi (unpacked extension)

1. Buka `chrome://extensions`.
2. Aktifkan **Developer mode** (kanan atas).
3. Jalankan `npm ci` lalu `npm run build`, kemudian klik **Load unpacked** → pilih folder `.output/chrome-mv3/`.
4. Ikon extension muncul di toolbar. Klik untuk membuka dashboard di tab baru; ekstensi tidak memakai popup agar alur lebih nyaman di browser Android.

> ID extension bersifat deterministik karena manifest menyertakan `key` publik. Backup lokal tidak mengirim data; koneksi GitHub hanya digunakan jika fitur cloud dikonfigurasi dan dijalankan.

### Permission yang diminta (dan alasannya)

| Permission | Alasan |
|---|---|
| `bookmarks`, `history`, `tabs`, `tabGroups`, `sessions`, `readingList` | Membaca & memulihkan data tersebut |
| `cookies` + host `http://*/*`, `https://*/*` | Membaca & memulihkan cookie semua situs |
| `downloads` | Membaca daftar riwayat unduhan & menyimpan file backup |
| `storage`, `unlimitedStorage` | Menyimpan preferensi & backup sementara |
| `management` | Membaca daftar extension ter-install (metadata, untuk checklist reinstall) |

Extension tidak mengirim telemetry atau memakai remote code. Koneksi jaringan hanya dipakai untuk fitur backup GitHub yang dipilih pengguna; token GitHub disimpan pada storage extension dan tidak ditampilkan ulang di UI.

---

## Penggunaan singkat

### Backup
1. Klik ikon extension untuk membuka dashboard. Pilih **Local only** untuk file Downloads, **Cloud only** untuk GitHub, atau **Both** untuk menyimpan ke Downloads dan GitHub.
2. Backup lokal dapat dibuat sebagai plaintext `.json` atau terenkripsi `.enc.json`; backup cloud mengikuti kebijakan enkripsi repository dan preferensi cloud.
3. Untuk backup terenkripsi: masukkan password (≥ 8 karakter disarankan). **Password tidak pernah disimpan — jika hilang, backup tidak dapat dibuka.**
4. File yang diunduh tersimpan di folder Downloads dengan nama `browser-backup-YYYYMMDD-HHMMSS[.enc].json`.
5. Ringkasan per kategori (jumlah item + status restorable) ditampilkan di dashboard.

Jadwal cloud dapat dijalankan setiap hari atau mingguan pada hari-hari yang dipilih. Status retry menampilkan percobaan berikutnya; retry otomatis bisa dibatalkan tanpa menghapus backup yang tertunda. Pengaturan dapat diekspor atau diimpor sebagai JSON; token GitHub tidak pernah disertakan dan token di profil tujuan tetap dipertahankan.

> Jika **Automatically retry failed uploads** diaktifkan, kegagalan upload cloud memakai salinan sementara di extension storage dan mencoba ulang setelah 1, 2, 4… menit (maksimal 8 percobaan). Salinan sementara dihapus setelah upload berhasil. Browser harus berjalan agar alarm retry dapat diproses.

### Restore
1. Klik ikon extension untuk membuka dashboard, lalu pilih **Restore from file** dan pilih file backup.
2. Jika terenkripsi → masukkan password.
3. Dashboard menampilkan isi backup + status restorable per kategori + **keterbatasan yang jujur** (mis. "History: basic restore only").
4. Pilih kategori yang ingin dipulihkan (default: semua yang restorable; `Downloads` nonaktif secara default).
5. Klik **Restore**. Default restore **non-destruktif**:
   - Bookmarks: *merge* (URL yang sudah ada di folder tujuan dilewati).
   - Mode *replace* (menghapus bookmarks bar & other bookmarks dulu) hanya dijalankan jika dicentang + dikonfirmasi via dialog.
   - Tabs/windows dibuat sebagai jendela/tab **baru**; data existing tidak disentuh.
6. Hasil per kategori ditampilkan, termasuk item yang gagal dan alasannya.

### Check Capabilities
Menampilkan deteksi API live di browser Anda (Read / Backup / Restore per kategori) + hasil probe runtime (bukti eksperimental, mis. perilaku `history.addUrl`).

---

## Struktur proyek (sejak v1.4.0 — WXT + React + shadcn/ui)

```
wxt.config.ts              ← konfigurasi WXT: manifest MV3, permissions, key publik, Tailwind v4
src/
  entrypoints/
    background.ts          ← service worker (scheduler + cloud-retry alarm; logika identik v1.3.0)
    dashboard/             ← halaman dashboard (index.html + main.tsx + App.tsx)
  dashboard/
    store.ts               ← store state eksternal (jembatan logika ↔ React)
    logic.ts               ← port pipeline backup lokal/restore/capabilities
    cloud-ui.ts            ← port handler cloud (connect/backup/retry/schedule/settings/init)
    api.ts                 ← window.__api (surface test otomatis, identik v1.3.0)
  lib/                     ← logika inti (TIDAK diubah dari v1.3.0):
    settings.js            ← validasi ekspor/impor preferensi (tanpa token)
    scheduler.js           ← keputusan jadwal murni (daily/weekly) + state storage
    cloud.js               ← orkestrator cloud (pending retry, retention, fase status)
    github.js              ← GitHubStorageProvider (Contents API + verifikasi objek)
    providers.js           ← kontrak StorageProvider + LocalStorageProvider + placeholder
    artifact.js            ← artefak backup + manifest + guard plaintext (below-UI)
    crypto.js              ← PBKDF2(600k) + AES-256-GCM + AAD envelope
    format.js              ← konstanta format v2 + integrity digest
    collect.js/restore.js  ← collector & restorer semua kategori
    sitedata.js/capabilities.js/util.js/validate.js
  components/
    ui/                    ← komponen shadcn/ui (button, card, select, checkbox, dst.)
    dashboard/             ← kartu fitur dashboard (React + Tailwind)
public/lib/pagelib.js      ← disalin apa adanya ke root build (dipakai chrome.scripting)
tests/                     ← cloud-retry.mjs, schedule-settings.mjs (Node) + extension-ui.mjs (Playwright)
docs/                      ← dokumentasi lengkap + spesifikasi fitur
.output/chrome-mv3/        ← hasil `npm run build` (folder yang di-load sebagai unpacked extension)
```

**Catatan arsitektur penting (MV3):** semua operasi backup/restore berjalan di *dashboard page* (tab extension), **bukan** di service worker. Alasannya: service worker MV3 dapat dimatikan browser kapan saja (idle timeout), yang fatal untuk operasi panjang. Extension page hidup selama tab terbuka dan punya DOM API penuh (Blob, CompressionStream, dsb.).

---

## Pengembangan (WXT)

```bash
npm install          # instal dependensi
npm run dev          # mode dev (auto-reload, load unpacked dari .output/chrome-mv3)
npm run build        # build produksi → .output/chrome-mv3
npm run zip          # paket zip siap publish
npm run compile      # typecheck TypeScript (tsc --noEmit)
npm test             # test Node: retry, schedule, restore tabs and backup/site selection
npm run test:ui      # test UI Playwright terhadap build asli (butuh Chromium + X server)
```

Migrasi v1.4.0 mempertahankan: format backup v2, format envelope enkripsi, kontrak
StorageProvider, kebijakan enkripsi publik/private, penjadwalan daily/weekly, retry
eksponensial, dan settings transfer token-safe. Logika inti (`src/lib/*.js`) identik
dengan v1.3.0 sehingga backup lama tetap dapat dibuka.

---

## Keamanan

- Tidak ada request jaringan, telemetry, analytics, atau remote code (CSP MV3 `script-src 'self'`).
- Enkripsi: **PBKDF2-HMAC-SHA-256 (600.000 iterasi)** → **AES-256-GCM** dengan AAD yang mengikat seluruh header envelope (menolak serangan downgrade parameter).
- Password: tidak disimpan, tidak dikirim, tidak di-log; derived key dibuat *non-extractable*.
- Integritas: SHA-256 atas canonical JSON (sorted keys) dari `counts+data+capabilities`.
- Cookie **values tidak pernah dicetak ke console/log**; log hanya memuat nama/jumlah.
- Data incognito tidak dibaca (cookie store incognito & jendela incognito dikecualikan by design).
- Password manager/autofill: tidak disentuh (memang tidak ada API-nya).

---

## Dokumentasi lanjutan

- `docs/BACKUP_FORMAT.md` — skema lengkap format backup v1.
- `docs/CAPABILITY_REPORT.md` — matriks Read/Backup/Restore per kategori + bukti runtime + keterbatasan API.
- `docs/TEST_RESULTS.md` — hasil automated test A–G di Chrome 131.
- `tests/extension-ui.mjs` — smoke test Playwright untuk dashboard mobile dan load MV3 extension di Chromium.
- Jalankan unit test: `npm test`. Jalankan test Playwright Chromium: `npm ci`, `npx playwright install chromium`, lalu `xvfb-run -a npm run test:ui` pada Linux headless.

---

## Atribusi ikon

Ikon extension (`public/icon.png`) oleh Smashicons dari Flaticon — [www.flaticon.com](https://www.flaticon.com).
