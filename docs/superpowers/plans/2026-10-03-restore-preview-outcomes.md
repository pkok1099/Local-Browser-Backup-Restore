# Restore Preview and Truthful Outcomes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preview restore against the receiving browser's current capabilities and report complete, partial, failed, user-skipped, and absent categories without presenting non-errors as failures.

**Architecture:** Keep file parsing, integrity validation, and the single-dashboard-page restore flow. Build preview rows from categories actually present in the validated file, but calculate support from the current browser's existing `detect()` result rather than the archived capability snapshot. Keep handler-specific restore statistics, add a normalized outcome count for attempted categories, and map outcomes to explicit labels and non-error styling in the existing RestoreCard.

**Tech Stack:** Existing JavaScript/TypeScript modules, Chrome Extension API-presence detection, Node built-in assertions, Playwright Chromium UI tests.

**Spec:** `docs/superpowers/specs/2026-10-03-backup-restore-trust-1.4.7-design.md`

## Global Constraints

- Keep the change suitable for a 1.4.x release: retain the current v2 backup output format and v1/v2 read compatibility, preserve the dashboard’s single-document crawl context, and do not change browser permission requirements.
- Do not add a format field in 1.4.7.
- Use live target capability results for preview; archived capabilities are informational only and cannot enable unsupported target operations.
- Destructive replace options remain opt-in and require their existing explicit confirmation before restore begins.
- Do not add a generic Retry All action; only offer retry for a category whose existing restore operation is demonstrably safe to repeat.
- Do not implement generalized restore resume in this release.
- Do not commit, tag, or push; stop after verification unless the owner explicitly approves a commit.

## Review Focus

- A v1/v2 file whose saved capability snapshot disagrees with the receiving browser still shows the current target's support and never enables an unavailable operation.
- A category present with missing or inconsistent counts remains visible and produces a warning instead of disappearing or implying a reliable count.
- Mixed per-item success and failure statistics are shown as partial with the exact success/failure counts; an all-failed attempted category is shown as failed.
- User-skipped and backup-absent categories are visibly distinct and never use error styling.
- Replace previews state the affected browser data before restore starts, while the destructive operation remains unchecked until the user opts in and confirms.

---

## File Map

- `src/lib/capabilities.js:1-20,247-254` — existing `detect()` returns the current browser's capability map; `runProbes()` is a separate runtime-probe operation.
- `src/dashboard/logic.ts:624-781` — category labels/counts, file validation, `presentCategories`, and `renderRestoreSummary` currently use archived capabilities.
- `src/dashboard/logic.ts:814-865` — current restore dispatch and result-to-UI mapping treats only `ok` as success and maps other non-unsupported statuses to error.
- `src/dashboard/store.ts:14-43,121-128` — `RestoreRow`, `RestoreSummary`, and `ResultLine` state types.
- `src/lib/restore.js:27-156,163-347,351-611,631-680` — restore handlers expose category-specific statistics; `restoreAll` already distinguishes `skipped_by_user` and `not_in_backup`.
- `src/components/dashboard/RestoreCard.tsx:19-23,58-157,170-188` — capability badges, preview table, destructive choices, and result styling.
- `tests/restore-tabs.mjs` — existing Node test of restore operation order and statistics.
- `tests/extension-ui.mjs` — existing real-dashboard browser test; extend it with valid fixtures whose archived capability snapshots conflict with the target and with the visible outcome labels.
- `tests/e2e/local-roundtrip.mjs` — existing end-to-end validation and restore path; retain its integrity and wrong-password coverage.

## Tasks

### Task 1: Use current-target capabilities and data-aware preview rows

**Files:**
- Modify: `src/dashboard/logic.ts:624-781`
- Modify: `src/dashboard/store.ts:14-43,121-128`
- Modify: `src/components/dashboard/RestoreCard.tsx:19-23,58-157`
- Test: `tests/extension-ui.mjs`

**Interfaces:**
- Consumes: `detect()` in `src/lib/capabilities.js` and `validateBackupFile(text, { password })`; both are existing interfaces.
- Produces: after a selected file passes validation, each category present in `backup.data` gets one preview row with its data-derived item count and target support `'full' | 'partial' | false`. The archived `backup.capabilities` is used only to identify a mismatch warning, never to select or enable an operation. Existing `RestoreSummary.rows`, `warnings`, `notes`, and replace options remain the UI state surface.

- [ ] **Step 1: Add a failing preview test with a valid integrity-stamped fixture**

  Extend `tests/extension-ui.mjs` to import `newBackupSkeleton` and `finalizeIntegrity` from `src/lib/format.js`, construct a v2 fixture containing bookmarks whose archived `canRestore` is `false`, `installedExtensions` whose archived `canRestore` is `'full'`, profile and extension-permissions metadata, and a history count that intentionally disagrees with its item list. Upload it through `#restore-file`. Assert the bookmark row uses the current browser's live support, the installed-extension row is unavailable on the current target, the profile and extension-permissions rows remain visible as informational/unavailable data, all present categories remain listed, and the count mismatch appears as a warning. Assert the replace controls are off by default and the UI states what bookmark/site-data replacement would affect before starting restore.

- [ ] **Step 2: Run the focused UI test and verify it fails on archived capability use**

  Run: `npm run build && xvfb-run -a npm run test:ui`
  Expected: FAIL because `renderRestoreSummary` currently reads `backup.capabilities` and omits informational categories from its preview rows.

- [ ] **Step 3: Build preview rows from validated data and live target support**

  Call existing `detect()` after file validation and retain that map with the pending restore. Use it for every restorable category row's `restore`, `checked`, and `disabled` fields. Show every category present in the backup, including profile/permission and other informational/unavailable categories without enabling an operation for them; derive counts from the actual category data when a suitable count is absent, keep `—` when the count cannot be determined, and retain `validateBackupFile` consistency warnings. Add a warning when the archived capability differs from the current target. Preserve the existing destructive confirmation gates and their default-off behavior; do not call `runProbes()` here because it performs temporary API operations rather than supplying the category map used by `detect()`.

- [ ] **Step 4: Run the UI and end-to-end tests**

  Run: `npm run build && xvfb-run -a npm run test:ui`
  Expected: PASS; preview support reflects current Chrome APIs, inconsistent data is warned, and destructive effects are visible before restore.

  Run: `xvfb-run -a npm run test:e2e`
  Expected: PASS; v1/v2 validation, encrypted round-trip, and existing restore behavior remain compatible.

### Task 2: Normalize restore outcomes from actual handler statistics

**Files:**
- Modify: `src/lib/restore.js:27-156,163-347,351-611,631-680`
- Modify: `src/dashboard/store.ts:38-43`
- Modify: `src/dashboard/logic.ts:814-865`
- Modify: `src/components/dashboard/RestoreCard.tsx:170-188`
- Test: `tests/restore-tabs.mjs`
- Test: `tests/extension-ui.mjs`

**Interfaces:**
- Produces: preserve every existing machine-readable `status` (`ok`, `error`, `unsupported`, `skipped_by_user`, `not_in_backup`) and add `outcome: 'complete' | 'partial' | 'failed' | 'unavailable' | 'skipped_by_user' | 'not_in_backup'` plus `stats.outcomeCounts: { succeeded: number; failed: number; skipped: number }` for attempted categories. Carry the normalized `outcome` into `ResultLine` and use it for UI badges/classes rather than re-inferring from `status`. Unsupported categories use `outcome: 'unavailable'`, not success or a runtime error. The UI labels each category `Complete`, `Partial`, `Failed`, `Unavailable`, `Skipped by user`, or `Absent from backup`; partial text includes succeeded/failed counts.
- Consumes: existing per-category counters (`created`/`skippedExisting`/`failed`, `tabsCreated`/`tabsFailed`, `windowsReopened`/`tabsReopened`, `set`/`added`/`redownloaded`, `originsRestored`/`originsFailed`, and extension-storage key counters) and the existing `restoreAll(backup, options, progress)` entry point.

- [ ] **Step 1: Add failing mixed-result assertions to `tests/restore-tabs.mjs`**

  Import `restoreAll` in `tests/restore-tabs.mjs`; keep a separate one-tab-success/one-tab-failure mock case. Call `restoreAll` with only `tabsWindows` enabled and assert `results.tabsWindows.status` remains `ok`, `results.tabsWindows.outcome` is `partial`, `results.tabsWindows.stats.outcomeCounts` is `{ succeeded: 1, failed: 1, skipped: 0 }`, and detailed tab counters remain. Add an all-failed bookmarks case and assert status `ok` with outcome `failed`; add absent and disabled categories and assert the unchanged `not_in_backup` and `skipped_by_user` statuses plus matching explicit outcomes.

- [ ] **Step 2: Run the focused test and verify current `ok` status is misleading**

  Run: `node tests/restore-tabs.mjs`
  Expected: FAIL because a handler currently returns `status: 'ok'` even when `tabsFailed` is nonzero, with no normalized outcome counts.

- [ ] **Step 3: Add normalized counts and truthful statuses without discarding detail**

  Keep every existing machine-readable `status`; add `outcome` and `stats.outcomeCounts` without replacing statuses. For each handler, derive outcome counts from category-level item results; count duplicate/already-present items as skipped, not failed. Count failures currently represented only by notes when they correspond to an attempted item operation (including tab navigation/group/order/metadata failures). Set outcome `complete` when no attempted item failed, `partial` when some succeeded and some failed, and `failed` when no attempted item succeeded and at least one failed; benign duplicate skips do not alone make an outcome partial. A thrown category handler whose item counts are unavailable reports one failed category operation. Set unsupported, skipped, and absent outcomes to `unavailable`, `skipped_by_user`, and `not_in_backup` respectively. For site data, include restored/failed origins and partitions without a live host in the summary.

- [ ] **Step 4: Map result states to explicit labels and non-error classes**

  In `src/dashboard/logic.ts` and `RestoreCard.tsx`, render partial/failed/unavailable/skipped/absent as distinct outcomes; use neutral styling for user-skipped and absent categories. Keep handler summaries and notes beside the outcome so warnings are not lost.

- [ ] **Step 5: Run focused and full verification**

  Run: `node tests/restore-tabs.mjs`
  Expected: PASS; mixed and all-failed cases have exact normalized counts, and absent/skipped statuses remain distinct.

  Run: `npm run build && xvfb-run -a npm run test:ui`
  Expected: PASS; each visible result uses the required label, partial counts are shown, and skipped/absent rows are not styled as errors.

  Run: `npm test`
  Expected: PASS; all Node restore and compatibility tests exit 0.

## Release Verification

Run: `npm run check`
Expected: PASS; lint, typecheck, and formatting checks exit 0.

Run: `npm test && npm run knip && npm run cycles && npm run build && xvfb-run -a npm run test:ui && xvfb-run -a npm run test:e2e`
Expected: PASS; all Node, unused-code, circular-import, build, UI, and E2E checks exit 0.

Stop after verification. Do not commit, tag, or push unless the owner explicitly approves it.
