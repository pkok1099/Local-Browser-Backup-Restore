# Dashboard Logs and Clear Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give persisted crawl logs unique identity across scans, enforce a true storage cap, keep auto-follow inside the log panel, and make Clear Logs remove memory and IndexedDB history together.

**Architecture:** Keep the current logger/store/viewer split. Add a stable per-entry ID and a versioned IndexedDB migration that copies v1 history from the existing `entries` store into a new `entries-v2` canonical store keyed by `id`; retain the legacy store only as a migration source and do not promise that older extension versions can open a newer-version database. Choose rows to trim by severity and age while always enforcing `maxEntries`. Coordinate clear, reads, and pending flushes with invalidation so old rows cannot reappear, clear the plain dashboard log buffer and unseen-error flag, and use panel-local scroll state. Reuse the shared `activeOperations`/`withDashboardActivity` contract produced by the Clear Results plan so both clear controls are disabled during backup, scan/retry, cloud, restore, probes, and downloads.

**Tech Stack:** Existing JavaScript/TypeScript modules, IndexedDB, React external store, Node built-in assertions, Playwright Chromium UI tests.

**Spec:** `docs/superpowers/specs/2026-10-03-backup-restore-trust-1.4.7-design.md`

## Global Constraints

- Keep the change suitable for a 1.4.x release: retain the current v2 backup output format and v1/v2 read compatibility, preserve the dashboard’s single-document crawl context, and do not change browser permission requirements.
- Clear Logs empties the dashboard log buffer, structured in-memory log view, persisted `bbr-site-log` entries, and unseen-error count; it does not clear backup/scan state or artifacts.
- Neither clear action calls `chrome.storage.local.clear()` or invokes bookmark, history, tab, cookie, reading-list, or website-storage mutation APIs.
- Use the `AppState.activeOperations` and `withDashboardActivity` interface from Task 3 of `docs/superpowers/plans/2026-10-03-backup-data-and-clear-results.md`; do not create a second activity counter.
- Do not commit, tag, or push; stop after verification unless the owner explicitly approves a commit.

## Review Focus

- Two logger instances, including instances with the same `crawlId`, persist distinct row keys and the dashboard does not deduplicate valid entries.
- A database at schema version 1 upgrades without dropping history, preserving timestamps, categories, crawl IDs, messages, and context in the canonical store.
- More fatal entries than `maxEntries` still result in exactly the hard cap, retaining the newest high-severity rows rather than exceeding the limit.
- A read or flush already pending when Clear Logs runs cannot repopulate cleared rows; new post-clear entries still work and unseen-error state is reset.
- Auto-follow changes only the log panel when enabled and already at bottom; pausing or scrolling up leaves both panel position and document scroll position unchanged.

---

## File Map

- `src/lib/site-log.js:33-61` — IndexedDB schema is version 1 and uses the auto-increment `seq` key; `:64-144` trims low-severity rows but can keep fatal rows beyond the cap; `:64-230` resets `seq` in each logger instance and writes batches asynchronously.
- `src/dashboard/site-log-store.ts:7-77` — live log buffer, unseen-error flag, memory-only `clearSiteLogView`, and async persisted/live merge currently deduped by `crawlId:seq`.
- `src/components/dashboard/SiteLogViewer.tsx:38-55,136-191` — structured log filters, current `scrollIntoView` behavior, and the current memory-only “Bersihkan tampilan” control.
- `src/components/dashboard/LogCard.tsx:6-35` — capped dashboard log buffer view and its local `<pre>` scroller.
- `src/dashboard/store.ts:103-148,166-257` — plain dashboard log buffer (`logLines`) and shared operation state.
- `src/components/dashboard/LogPage.tsx:9-45` — Log route marks structured errors as seen and composes both log views.
- `tests/site-log.mjs` — existing Node coverage for logger shape, levels, counts, live entries, and site-data integration.
- `tests/extension-ui.mjs` — existing real Chromium extension test; extend it to seed a v1 IndexedDB database, verify migration/clear, and check panel/document scroll positions.
- `docs/superpowers/plans/2026-10-03-backup-data-and-clear-results.md` — produces the shared operation tracker required by the clear-button disabled state.

## Tasks

### Task 1: Add stable log identity and migrate v1 history

**Files:**
- Modify: `src/lib/site-log.js:33-61,64-84,146-230,232-293`
- Modify: `src/dashboard/site-log-store.ts:7-77`
- Modify: `src/components/dashboard/SiteLogViewer.tsx:156-161`
- Test: `tests/site-log.mjs`
- Test: `tests/extension-ui.mjs`

**Interfaces:**
- Produces: each structured entry has `id: string` from `crypto.randomUUID()`; `seq` remains a per-logger ordering/count field and is no longer the IndexedDB primary key or a uniqueness promise. `pushSiteLogEntry` normalizes direct entries from `logic.ts`/`main.tsx` that lack an ID at the store boundary. The version-2 `entries-v2` object store is keyed by `id`; the versioned upgrade copies every v1 `entries` row under a deterministic `legacy:<old-primary-key>` ID before the upgrade transaction commits, retaining all original fields and aborting the upgrade if copying fails. The original `entries` store is retained only as a migration source.
- Consumes: existing `createSiteLogger(opts)`, `querySiteLog({ ..., limit })`, `loadPersistedSiteLog(limit)`, and `useSiteLog()` interfaces. Dedupe and React keys use `id` rather than `crawlId:seq`.

- [ ] **Step 1: Add failing identity and migration assertions**

  In `tests/site-log.mjs`, create two logger instances with the same explicit `crawlId`, log an entry from each, and assert their `id` values are non-empty and distinct while `seq` may restart. In `tests/extension-ui.mjs`, push two direct entries without IDs through the store boundary and assert distinct generated IDs. Before opening the Log route, create a version-1 `bbr-site-log` database with the current `entries` schema and two representative rows; after visiting `#/log`, assert both rows are visible with all original fields and that `entries-v2` contains distinct migrated IDs.

- [ ] **Step 2: Run focused tests and verify the current collision/migration gaps**

  Run: `node tests/site-log.mjs`
  Expected: FAIL because current entries have no stable ID and each logger starts `seq` at zero.

  Run: `npm run build && xvfb-run -a npm run test:ui`
  Expected: FAIL because the current schema remains version 1 and has no versioned history migration.

- [ ] **Step 3: Migrate and use stable IDs**

  Increment the database version, create `entries-v2` keyed by `id` with the existing timestamp/level/category/correlation/crawl indexes, and copy every v1 `entries` row with a deterministic legacy ID without dropping its original fields. Keep `entries` read-only as the migration source. Generate a UUID for every new logger entry and normalize any direct `pushSiteLogEntry` input without an ID at the store boundary. Update canonical queries, `SiteLogEntry`, persisted/live dedupe, and React keys to use that ID. Keep the logger's local `seq` for existing ordering metadata.

- [ ] **Step 4: Run the identity and migration tests**

  Run: `node tests/site-log.mjs`
  Expected: PASS; entries from separate logger instances always have distinct IDs and existing logger behavior remains intact.

  Run: `npm run build && xvfb-run -a npm run test:ui`
  Expected: PASS; both seeded v1 rows survive the upgrade and render once from the canonical store.

### Task 2: Enforce the hard cap, including fatal entries

**Files:**
- Modify: `src/lib/site-log.js:85-144,146-171`
- Test: `tests/site-log.mjs`

**Interfaces:**
- Produces (new pure helper): `selectLogEntriesToTrim(entries, maxEntries): string[]`, returning stable entry IDs to delete so persisted count after trimming is at most `maxEntries`.
- Consumes: `createSiteLogger({ maxEntries })` and the v2 `id` key path from Task 1.

- [ ] **Step 1: Add failing cap assertions**

  Add a `tests/site-log.mjs` case with `maxEntries: 3` and more than three rows, including only FATAL rows and a mix of DEBUG/INFO/WARN/ERROR/FATAL. Assert the trim selection never leaves more than three rows, removes older low-severity entries first, and when the input is all FATAL keeps only the three newest by timestamp (breaking equal timestamps deterministically by ID).

- [ ] **Step 2: Run the Node test and verify fatal rows exceed the current cap**

  Run: `node tests/site-log.mjs`
  Expected: FAIL because `trimDb` deliberately never deletes FATAL entries when lower-severity rows cannot satisfy the limit.

- [ ] **Step 3: Implement severity-first trimming with an unconditional cap**

  Implement `selectLogEntriesToTrim` as a pure selection over the current rows: discard oldest DEBUG/INFO first, then oldest WARN/ERROR, then oldest FATAL only if needed; use timestamp then stable ID to order ties and preserve newest high-severity rows. In `trimDb`, compare persisted row count to `maxEntries`, delete the returned IDs, and keep database persistence best-effort as it is today.

- [ ] **Step 4: Run the Node test and verify the cap**

  Run: `node tests/site-log.mjs`
  Expected: PASS; every tested severity distribution trims to `maxEntries` or fewer and retains the newest fatal diagnostics.

### Task 3: Make auto-follow panel-local and add separate Clear Logs

**Files:**
- Modify: `src/lib/site-log.js:33-61,146-171,232-293`
- Modify: `src/dashboard/site-log-store.ts:1-80`
- Modify: `src/dashboard/store.ts:203-257`
- Modify: `src/components/dashboard/SiteLogViewer.tsx:38-55,136-191`
- Modify: `src/components/dashboard/LogCard.tsx:6-35`
- Test: `tests/extension-ui.mjs`

**Interfaces:**
- Consumes: `AppState.activeOperations` and `withDashboardActivity(...)` from Task 3 of the Backup Data and Clear Results plan. Both Clear Results and Clear Logs read the same operation guard.
- Produces (new persistence contract): `clearPersistedSiteLog(): Promise<void>` clears both canonical `entries-v2` and legacy `entries` rows in one IndexedDB transaction and invalidates pending pre-clear flushes; `clearSiteLogView(): Promise<boolean>` acquires the shared `bbr:dashboard-operation` lock as `clear-logs` before clearing persisted structured entries, structured in-memory entries, `unseenError`, and `AppState.logLines`. If another task holds the lock, it returns `false` and clears nothing. `loadPersistedSiteLog` discards a query result started before the latest clear.
- Produces (UI contract): a `Clear Logs` button with `id="clear-logs"`, disabled while `activeOperations > 0`; the structured panel has `id="site-log-panel"`. Auto-follow writes only `scrollTop` on the panel and only when enabled and already at its bottom.

- [ ] **Step 1: Add failing real-browser clear and scroll assertions**

  Extend `tests/extension-ui.mjs` to add a dashboard-buffer line and structured rows, open `#/log`, and click Clear Logs. Assert `#log` returns to `(no output yet)`, the structured panel contains no rows, both `entries-v2` and legacy `entries` stores have zero rows, and old errors do not reappear after a delayed persisted-log load or flush. Start a local backup through the existing `window.__api.runBackupToFile` hook and assert both clear buttons are disabled until it settles. For scroll, place the log panel below the viewport, record `window.scrollY`, add/load an entry, and assert page scroll is unchanged; scroll the panel away from bottom and assert a later entry does not move it, then return to bottom and verify enabled auto-follow advances only the panel.

- [ ] **Step 2: Run the focused UI test and verify current clear/scroll behavior fails**

  Run: `npm run build && xvfb-run -a npm run test:ui`
  Expected: FAIL because “Bersihkan tampilan” only clears memory, IndexedDB rows can reload, Clear Logs does not exist, and `scrollIntoView` can move the document.

- [ ] **Step 3: Serialize clear against reads and flushes; clear both log stores**

  In `src/lib/site-log.js`, add `clearPersistedSiteLog` and an epoch captured by pending flushes; clearing advances the epoch so pre-clear batches cannot write after the clear transaction, while entries logged afterward use the new epoch. In `src/dashboard/site-log-store.ts`, invalidate in-flight `loadPersistedSiteLog` results, clear `entries` and `unseenError`, and make the existing `clearSiteLogView` clear both persisted stores and reset `store.ts` `logLines` under `withDashboardActivity('clear-logs', ...)`. Rename the control to `Clear Logs`, explain that it removes both dashboard and crawl logs but not results/backups, and disable it using the shared activity state. If the lock is unavailable, return `false` without clearing.

- [ ] **Step 4: Keep scrolling inside the log panes**

  Replace `bottomRef.current?.scrollIntoView()` in `SiteLogViewer` with a ref to `#site-log-panel`, an at-bottom check, and `panel.scrollTop = panel.scrollHeight` only when auto-follow is enabled and the user was already at the bottom. Keep pause/resume behavior local to the structured viewer. In `LogCard`, follow new lines only if its own `<pre>` was already at the bottom; never call `scrollIntoView` or adjust the document scroll position.

- [ ] **Step 5: Run focused and full verification**

  Run: `node tests/site-log.mjs`
  Expected: PASS; identity, logger behavior, and hard-cap selection assertions pass.

  Run: `npm run build && xvfb-run -a npm run test:ui`
  Expected: PASS; migration, clear/no-resurrection, shared disabled state, and panel-local scrolling assertions pass.

  Run: `npm test`
  Expected: PASS; all Node regression tests exit 0.

## Release Verification

Run: `npm run check`
Expected: PASS; lint, typecheck, and formatting checks exit 0.

Run: `npm test && npm run knip && npm run cycles && npm run build && xvfb-run -a npm run test:ui && xvfb-run -a npm run test:e2e`
Expected: PASS; Node, unused-code, circular-import, build, UI, and E2E checks exit 0.

Stop after verification. Do not commit, tag, or push unless the owner explicitly approves it.
