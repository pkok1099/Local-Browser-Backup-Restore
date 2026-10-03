# Plan: Incremental siteData berbasis history (jalur B) — revisi 3

Status: DISETUJUI user 2026-10-03 ("Setuju, eksekusi revisi 2") + 5 tambahan.
Revisi 3 memasukkan kelimanya.

## Tujuan
Backup terjadwal harian tetap lengkap semua kategori, tapi crawl siteData hanya
untuk origin yang dikunjungi sejak snapshot terakhir. 15 menit → beberapa menit
pada hari normal, tanpa mengubah format artefak / restore.

## Keputusan eksplisit
1. **Plaintext-at-rest**: cache menyimpan site data (dapat memuat token/sesi)
   plaintext di `chrome.storage.local`. Disadari dan diterima — konsisten dengan
   preseden `bbr:site-data-checkpoint`. Tidak dienkripsi (kunci enkripsi tidak
   tersedia saat scheduled run tanpa interaksi user).
2. **Cache = "snapshot lengkap terakhir"**, ditulis oleh SETIAP run yang
   menghasilkan siteData sukses & tidak di-stop — manual full maupun scheduled
   incremental. Alasan: manual full backup me-refresh cache agar scheduled run
   berikutnya incremental dari titik itu (tidak ada "15 menit kejutan" setelah
   user baru saja backup manual).
3. **Partitions tidak di-merge**: ephemeral (terikat tab/frame live saat crawl),
   fresh-only untuk subset. Hanya `origins` yang durable dan di-merge.
4. **Fail-safe**: ragu → full crawl, tidak pernah skip buta.

## Desain

### Modul `src/lib/site-incremental.js` (semua keputusan di sini, glue bodoh)
Dependency-injected, testable di node polos. Import hanya dari
`scan-config.js` (data murni) dan `tab-ownership.js` (`originOf`).

```js
// --- cache ---
readSiteDataCache(storage) -> { version, savedAt, lastFullAt, origins } | null
  // null juga saat: storage null, korup, BUKAN object, version mismatch.
writeSiteDataCache(storage, payload) -> boolean  // false saat gagal, never throw

// --- sinyal history ---
getVisitedOriginsSince({ history, sinceMs, nowMs, maxResults })
  -> { visited: Set<string>, truncated: boolean }
  // history null → throw 'history-unavailable' (ditangkap caller → full crawl)

// --- perencanaan ---
shouldForceFull({ cache, nowMs, fullIntervalMs }) -> reason: string | null
  // 'no-cache' | 'cache-corrupt' | 'version-mismatch' | 'interval-elapsed' | null
  // interval: nowMs - lastFullAt >= fullIntervalMs → force (batas tepat 7 hari
  // ikut force — arah yang aman).
planIncrementalCrawl({ included: string[], cachedOrigins, visited })
  -> { crawl: string[], reuse: string[] }
  // crawl = included ∩ (visited ∪ belum-pernah-di-cache)

// --- orkestrasi (async, deps di-inject) ---
computeIncrementalPlan({ storage, history, nowMs, included: string[], config })
  -> { crawlOrigins, cache, fullCrawl: boolean, reason: string | null }
  // included kosong → { crawlOrigins: [], reason: 'empty-include' } (no-op).
  // history throw / truncated / null → fullCrawl, reason 'history-error' /
  // 'history-truncated' / 'history-unavailable'.

// --- finalisasi (murni) ---
mergeIncrementalOrigins({ cachedOrigins, freshOrigins, includedSet: Set })
  -> { [origin]: snapshot }
  // fresh menang (termasuk snapshot kosong yang legitimate = situs memang
  // kosong); tanpa snapshot fresh (gagal crawl) → pakai cache (last-known-good);
  // di luar includedSet → dibuang (tidak masuk merge DAN tidak ditulis ke cache).
finalizeIncrementalRun({ cache, freshOrigins, included: string[], stopped: boolean,
                         categoryOk: boolean, fullCrawl: boolean, nowMs })
  -> { origins, notes: string[], cachePayload | null }
  // Selalu merge untuk kelengkapan section (termasuk saat stopped — section
  // lengkap dari partial fresh + cache).
  // cachePayload null saat: !categoryOk ATAU stopped (cache lama dipertahankan,
  // tidak tertimpa data parsial — tambahan user #5).
  // lastFullAt: fullCrawl ? nowMs : cache.lastFullAt.
buildFullCachePayload({ freshOrigins, included: string[] | null, nowMs, version })
  -> payload  // untuk run full (manual): prune ke include-set.

// --- notes transparansi ---
buildIncrementalNotes({ crawled, total, reused, cacheDateStr, fullReason }) -> string[]
  // cth: "sitedata incremental: 3/42 origin(s) re-crawled (visited since
  //  2026-10-02); 39 reused from cache (2026-10-01)"
```

### Konfigurasi (`SITE_DATA_CONFIG`)
- `siteDataCacheKey: 'bbr:site-data-cache'`
- `siteDataCacheVersion: 1`
- `incrementalFullIntervalMs: 7 * 24 * 3600 * 1000`
- `historyMaxResults: 50000`

### Glue `src/dashboard/logic.ts` (`buildBackupObject`)
```ts
// (a) incremental gate — hanya jika flag && siteData dipilih && ada yang di-crawl
if (collectOptions?.incrementalSiteData === true && selectedCategories.includes('siteData')) {
  const rawList = includedOrigins
    ?? (await discoverOrigins()).origins.map((o) => typeof o === 'string' ? o : o.origin);
  incrementalCtx = {
    included: rawList,
    plan: await computeIncrementalPlan({
      storage: chrome.storage?.local ?? null,
      history: (chrome as any).history ?? null,
      nowMs: Date.now(), included: rawList, config: SITE_DATA_CONFIG,
    }),
  };
  effectiveCollectOptions.siteData.includeOrigins = incrementalCtx.plan.crawlOrigins;
}
// ... collectAll(...) tidak berubah ...
// (b) pasca-collect
const sdOk = categoryStatus.siteData?.ok === true;
const sdStopped = (data.siteData as any)?.stopped === true || backupStopFlag?.stop === true;
if (sdOk && selectedCategories.includes('siteData')) {
  if (incrementalCtx) {
    const fin = finalizeIncrementalRun({
      cache: incrementalCtx.plan.cache, freshOrigins: (data.siteData as any)?.origins ?? {},
      included: incrementalCtx.included, stopped: sdStopped, categoryOk: true,
      fullCrawl: incrementalCtx.plan.fullCrawl, nowMs: Date.now(),
    });
    (data.siteData as any).origins = fin.origins;
    (data.siteData as any).notes.push(...fin.notes);
    if (fin.cachePayload) await writeSiteDataCache(chrome.storage?.local ?? null, fin.cachePayload);
    // write gagal → best-effort, lanjut (di-log di dalam finalize notes? tidak —
    // appendLog satu baris di sini).
  } else {
    const payload = buildFullCachePayload({
      freshOrigins: (data.siteData as any)?.origins ?? {},
      included: includedOrigins, nowMs: Date.now(),
      version: SITE_DATA_CONFIG.siteDataCacheVersion,
    });
    await writeSiteDataCache(chrome.storage?.local ?? null, payload); // best-effort
  }
}
```
Catatan: `notes` di section selalu array (lihat `notes[]` di sitedata.js).

### Glue `src/dashboard/cloud-ui.ts`
`runScheduledCloudBackupUnlocked`: tambah
`collectOptions: { incrementalSiteData: true }` pada `runCloudBackup`.

## Tugas (TDD red-green-refactor)

### T1: modul + test
Kasus `tests/site-incremental.mjs` (15):
1. tanpa cache → full (`no-cache`)
2. cache korup / bukan object → full, tanpa throw (#1 user)
3. version mismatch → full (`version-mismatch`) (#2 user)
4. `now - lastFullAt`: interval-1 → incremental; tepat interval → full;
   interval+1 → full (#3 user, jam di-inject)
5. history.search throw → full (`history-error`)
6. hasil == maxResults → full (`history-truncated`)
7. history null → full (`history-unavailable`)
8. subset visited → crawl = visited ∪ uncached; sisanya reuse
9. origin baru (belum di-cache) selalu di-crawl walau tak dikunjungi
10. origin keluar dari include → dibuang dari merge DAN dari cache tertulis (#4)
11. snapshot fresh kosong (legitimate) menang atas cache
12. gagal crawl (tanpa snapshot) → fallback cache
13. stopped / !categoryOk → `cachePayload: null` (cache lama utuh) (#5)
14. write gagal (storage throw) → false, tidak throw
15. read/write round-trip valid
+ kasus: included kosong → no-op.
- Merah dulu, implementasi minimum, hijau, refactor.
- Daftarkan di `package.json` → `test:node`.

### T2: glue (logic.ts + cloud-ui.ts)
- `CollectOptions += incrementalSiteData?: boolean`; import modul; glue (a)+(b);
  satu baris flag di scheduled caller.
- `npm run check` bersih. Glue tidak di-unit-test di node (alias `@/`) —
  dinyatakan; dijaga oleh modul yang ter-test penuh + E2E existing.

### T3: verifikasi + smoke test manual
- `node tests/site-incremental.mjs`, `npm run check`, `npm test`,
  `npm run test:e2e` hijau.
- Self-review: flag mati → difusi nol; tab-ownership tak tersentuh; no-circular-import.
- Smoke test manual (user):
  1. Build baru (`npm run build`), load unpacked di `chrome://extensions`.
     Persempit site-data include ke 2–3 situs (Pengaturan → site data) agar
     smoke cepat. Pastikan cloud backup + jadwal sudah terkonfigurasi.
  2. Run #1 — buka di tab baru:
     `chrome-extension://akkfbbaafgpcminophoimghdjgfcblia/dashboard.html?action=cloud-scheduled&reason=smoke1`
     Tunggu selesai. Ekspektasi: full crawl;
     notes "sitedata: full crawl of 3 origin(s) (no-cache)".
  3. Kunjungi 1 dari 3 situs, tunggu beberapa detik (tercatat di history).
  4. Run #2 — buka di tab baru:
     `chrome-extension://akkfbbaafgpcminophoimghdjgfcblia/dashboard.html?action=cloud-scheduled&reason=smoke2`
  5. Verifikasi pada artefak (atau halaman Log sebelum tab tertutup otomatis):
     notes "sitedata incremental: 1/3 origin(s) re-crawled (visited since
     <tgl>); 2 reused from cache (<tgl>)".
  6. Kembalikan include list ke semula.

## Risiko
- History di-clear → cache dipakai ulang + notes; force-full mingguan pulih.
- Duplikasi lokal ≈ ukuran section siteData (`unlimitedStorage` ada).
- Run pertama pasca-upgrade = full crawl (catatan rilis).
- `chrome.history.search` `text:''` mengembalikan semua item dalam rentang —
  maxResults 50000; truncation → full (aman).

## Di luar cakupan
- Toggle UI; E2E otomatis khusus incremental; incremental 11 kategori lain;
  perubahan format artefak/restore/checkpoint.
