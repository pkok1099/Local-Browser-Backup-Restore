# Plan: History-based incremental siteData (path B) — revision 3

Status: APPROVED by the user on 2026-10-03 ("Agreed, execute revision 2"), plus five additions.
Revision 3 incorporates all five additions.

## Goal
Daily scheduled backups remain complete for all categories, while the siteData crawl
covers only origins visited since the last snapshot. On a normal day, this reduces
the time from 15 minutes to a few minutes without changing the artifact/restore format.

## Explicit decisions
1. **Plaintext-at-rest**: the cache stores site data (which may contain tokens/sessions)
   in plaintext in `chrome.storage.local`. This is understood and accepted — consistent with
   precedent `bbr:site-data-checkpoint`. It is not encrypted (the encryption key is not
   available during a scheduled run without user interaction).
2. **Cache = "last complete snapshot"**, written by every run that
   successfully produces siteData and is not stopped, including manual full and scheduled
   incremental runs. A manual full backup therefore refreshes the cache, so the next
   scheduled run is incremental from that point (no "15-minute surprise" after the
   user has just made a manual backup).
3. **Partitions are not merged**: ephemeral data remains bound to the live tab/frame during
   crawling, and fresh-only data remains limited to the subset. Only durable `origins` are merged.
4. **Fail-safe**: uncertainty triggers a full crawl; never skip blindly.

## Design

### Module `src/lib/site-incremental.js` (all decisions here; glue is intentionally dumb)
Dependency-injected and testable in plain Node. Import only from
`scan-config.js` (pure data) and `tab-ownership.js` (`originOf`).

```js
// --- cache ---
readSiteDataCache(storage) -> { version, savedAt, lastFullAt, origins } | null
  // also null when: storage is null, corrupt, NOT an object, or the version mismatches.
writeSiteDataCache(storage, payload) -> boolean  // false on failure, never throw

// --- history signal ---
getVisitedOriginsSince({ history, sinceMs, nowMs, maxResults })
  -> { visited: Set<string>, truncated: boolean }
  // history null → throw 'history-unavailable' (caught by the caller → full crawl)

// --- planning ---
shouldForceFull({ cache, nowMs, fullIntervalMs }) -> reason: string | null
  // 'no-cache' | 'cache-corrupt' | 'version-mismatch' | 'interval-elapsed' | null
  // interval: nowMs - lastFullAt >= fullIntervalMs → force (exactly 7 days
  // also forces it — the safe direction).
planIncrementalCrawl({ included: string[], cachedOrigins, visited })
  -> { crawl: string[], reuse: string[] }
  // crawl = included ∩ (visited ∪ never-before-cached)

// --- orchestration (async, injected dependencies) ---
computeIncrementalPlan({ storage, history, nowMs, included: string[], config })
  -> { crawlOrigins, cache, fullCrawl: boolean, reason: string | null }
  // empty included → { crawlOrigins: [], reason: 'empty-include' } (no-op).
  // history throw / truncated / null → fullCrawl, reason 'history-error' /
  // 'history-truncated' / 'history-unavailable'.

// --- finalization (pure) ---
mergeIncrementalOrigins({ cachedOrigins, freshOrigins, includedSet: Set })
  -> { [origin]: snapshot }
  // fresh wins (including a legitimate empty snapshot = the site is actually
  // empty); without a fresh snapshot (crawl failure) → use the cache (last-known-good);
  // outside includedSet → discarded (not merged AND not written to the cache).
finalizeIncrementalRun({ cache, freshOrigins, included: string[], stopped: boolean,
                         categoryOk: boolean, fullCrawl: boolean, nowMs })
  -> { origins, notes: string[], cachePayload | null }
  // Always merge for section completeness (including when stopped — the section
  // is complete from partial fresh + cache).
  // cachePayload null when: !categoryOk OR stopped (the old cache is preserved,
  // not overwritten by partial data — user addition #5).
  // lastFullAt: fullCrawl ? nowMs : cache.lastFullAt.
buildFullCachePayload({ freshOrigins, included: string[] | null, nowMs, version })
  -> payload  // for a full run (manual): prune to the include-set.

// --- transparency notes ---
buildIncrementalNotes({ crawled, total, reused, cacheDateStr, fullReason }) -> string[]
  // e.g.: "sitedata incremental: 3/42 origin(s) re-crawled (visited since
  //  2026-10-02); 39 reused from cache (2026-10-01)"
```

### Configuration (`SITE_DATA_CONFIG`)
- `siteDataCacheKey: 'bbr:site-data-cache'`
- `siteDataCacheVersion: 1`
- `incrementalFullIntervalMs: 7 * 24 * 3600 * 1000`
- `historyMaxResults: 50000`

### Glue `src/dashboard/logic.ts` (`buildBackupObject`)
```ts
// (a) incremental gate — only when the flag is set, siteData is selected, and something is crawled
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
// ... collectAll(...) unchanged ...
// (b) post-collect
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
    // write failure → best effort, continue (logged in finalize notes? no —
    // append one line to the log here).
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
Note: `notes` in this section is always an array (see `notes[]` in sitedata.js).

### Glue `src/dashboard/cloud-ui.ts`
`runScheduledCloudBackupUnlocked`: add
`collectOptions: { incrementalSiteData: true }` to `runCloudBackup`.

## Tasks (TDD red-green-refactor)

### T1: module + tests
Cases in `tests/site-incremental.mjs` (15):
1. no cache → full (`no-cache`)
2. corrupt cache / not an object → full, without throwing (#1 user)
3. version mismatch → full (`version-mismatch`) (#2 user)
4. `now - lastFullAt`: interval-1 → incremental; exact interval → full;
   interval+1 → full (#3 user, injected clock)
5. history.search throw → full (`history-error`)
6. result == maxResults → full (`history-truncated`)
7. history null → full (`history-unavailable`)
8. visited subset → crawl = visited ∪ uncached; reuse the rest
9. new origins (not yet cached) are always crawled even if not visited
10. origins removed from the include set → discarded from the merge AND from the written cache (#4)
11. an empty fresh snapshot (legitimate) wins over the cache
12. crawl failure (without a snapshot) → fall back to the cache
13. stopped / !categoryOk → `cachePayload: null` (old cache remains intact) (#5)
14. write failure (storage throws) → false, does not throw
15. read/write round-trip valid
+ case: empty included → no-op.
- Start with a failing test, implement the minimum, make it pass, then refactor.
- Register it in `package.json` under `test:node`.

### T2: glue (logic.ts + cloud-ui.ts)
- `CollectOptions += incrementalSiteData?: boolean`; import the module; glue (a)+(b);
  one flag line in the scheduled caller.
- `npm run check` passes cleanly. Glue is not unit-tested in Node (because of the `@/` alias);
  this is documented and covered by the fully tested module plus existing E2E tests.

### T3: verification + manual smoke test
- `node tests/site-incremental.mjs`, `npm run check`, `npm test`,
  `npm run test:e2e` passes.
- Self-review: flag off causes no diffusion; tab ownership remains untouched; no circular import.
- Manual smoke test (user):
  1. Build a new version (`npm run build`), load unpacked at `chrome://extensions`.
     Narrow the site-data include list to 2–3 sites (Settings → site data) so the
     smoke test is quick. Ensure cloud backup + scheduling are configured.
  2. Run #1 — open in a new tab:
     `chrome-extension://akkfbbaafgpcminophoimghdjgfcblia/dashboard.html?action=cloud-scheduled&reason=smoke1`
     Wait for it to finish. Expected: full crawl;
     notes "sitedata: full crawl of 3 origin(s) (no-cache)".
  3. Visit 1 of the 3 sites and wait a few seconds (so it is recorded in history).
  4. Run #2 — open in a new tab:
     `chrome-extension://akkfbbaafgpcminophoimghdjgfcblia/dashboard.html?action=cloud-scheduled&reason=smoke2`
  5. Verify in the artifact (or on the Log page before the tab closes automatically):
     notes "sitedata incremental: 1/3 origin(s) re-crawled (visited since
     <date>); 2 reused from cache (<date>)".
  6. Restore the include list to its original state.

## Risks
- If history is cleared, reuse the cache and notes; the weekly force-full run recovers.
- Local duplication is approximately the size of the siteData section (`unlimitedStorage` is available).
- The first run after an upgrade is a full crawl (release note).
- `chrome.history.search` with `text:''` returns all items in the range, up to
  maxResults 50000; truncation triggers a full crawl (the safe behavior).

## Out of scope
- Toggle UI; automated E2E tests specific to incremental mode; incremental support for 11 other categories;
  changes to the artifact/restore/checkpoint format.
