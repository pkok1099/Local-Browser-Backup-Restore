# Plan: Lag-free scheduled backups (tiered/incremental siteData)

## Problem
A full backup takes ~15 minutes and causes severe lag, so running one daily is not viable.
Root cause: the 11 categories use fast Chrome API reads that take seconds. `siteData` opens
one tab per origin and attaches a debugger; it is the only slow category.

## Options considered

### A. Tiered schedule (RECOMMENDED)
- Daily scheduled backups include only the 11 fast categories (without `siteData`).
- `siteData` remains available through manual backups or as an opt-in scheduled feature.
- Artifacts remain complete snapshots for each included category, and restore is unchanged.

### B. History-based incremental approach for siteData (REVISED — viable)
- Low-cost change signal: one `chrome.history.search({ text: '', startTime:
  lastCrawl, endTime: now })` returns a set of visited origins. No tabs need to be opened.
  The `history` permission already exists; this query pattern is already used in
  `capability-probes.js`.
- Crawl only origins that were visited and are in the include list (the `includeOrigins`
  filter already exists in `sitedata.js`).
- For origins that were not visited, reuse data from the previous backup and merge it.
  There are two sub-options for the old data source:
  - B1: download the latest artifact from the cloud, extract the siteData section, and merge
    it. (No new local store; incurs download cost.)
  - B2: cache each origin in `chrome.storage.local` (the `unlimitedStorage` permission
    already exists) and update the cache after each crawl; assemble the backup from the
    cache and fresh results. (No download; introduces a new persistent store.)
- Safe fallback: if history is empty or cleared, run a full crawl (never skip blindly).
- Documented edge case: storage changes without a visit (such as service worker
  background sync) are missed until the origin is visited again.

Recommendation A is deterministic (it always takes seconds daily), simple, and addresses
the core complaint. Use B only if A is insufficient and daily siteData is still desired.

## Implementation plan (option A)

### Task 1: Schedule configuration
- File: `src/lib/scheduler.js` (`normalizeScheduleConfig`), schedule settings UI.
- Add `schedule.includeSiteData: boolean` (default `false`).
- Verification: unit test `normalizeScheduleConfig`: the default is false, and true survives
  a round trip.

### Task 2: Scheduled run honors the option
- File: `src/dashboard/cloud-ui.ts` (`runScheduledCloudBackupUnlocked`).
- If `includeSiteData === false`, pass `collectOptions.selectedCategories`
  = all categories except `'siteData'` to `runCloudBackup`.
- Verification: characterization test: collect is called without siteData when the option
  is off and with siteData when the option is on.

### Task 3: UI checkbox and explanatory text
- File: schedule settings component (dashboard).
- Checkbox "Include site data in scheduled backups" + subtext:
  "Site data opens one tab per site (±15 min). Turn this off for fast daily backups;
  site data can still be backed up manually at any time."
- Verification: `npm run test:ui` passes.

### Task 4: Final verification
- `npm run check`, `npm test`, `npm run test:e2e` pass.
- Ensure manual backups are unchanged (still full by default).

## Risks
- Daily artifacts do not contain siteData, so daily restores do not restore it by design.
  Manual and older backups still contain it.
- Default behavior changes: users who already rely on daily siteData
  need to select the option (communicate this in the release notes).

## Out of scope
- History-based incremental approach (option B) — decide after evaluating A.
- Changing manual backups.
