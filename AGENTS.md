# Agent Guide

## Commands
- Run `npm ci`, then `npm run build`; the output goes to `.output/chrome-mv3/` (load unpacked for manual installation).
- `npm run check` runs `lint`, `typecheck`, and `format:check`. Prefer `npm run verify`: it runs `wxt prepare` first, then runs `lint`, `typecheck`, `format:check`, and `npm test` concurrently. CI and pre-commit use this pipeline; failures are collected, labeled, and returned as a nonzero exit.
- `npm test` uses Node 24's built-in `node --test --test-concurrency=7` auto-discovery for `tests/**/*.test.mjs`. Filter normally with `node --test tests/cloud/*.test.mjs` or a specific `*.test.mjs` path. `tests/api-operations.types.ts` remains a separate part of `npm run typecheck`.
- Browser suites use `tests/e2e/*.e2e.mjs`; helpers and `tests/extension-ui.mjs` are not discovered by `npm test`. Playwright requires a fresh `npm run build`, Chromium (`export CHROMIUM_PATH=/path/to/chrome` or `npx playwright install chromium`), and a display — use `xvfb-run -a npm run test:e2e` / `npm run test:ui`, or `CI_HEADLESS=1`.
- Use `npm run cycles` (madge) to find circular imports and `npm run knip` to find dead code (entries: `src/entrypoints/**`, `src/dashboard/theme.ts`, and `tests/**/*.mjs`).
- Release: push tag `vX.Y.Z` (it must match the `package.json` version) → workflow `.github/workflows/release.yml` runs `verify` + `wxt zip` (which builds the production output), then creates a GitHub Release containing the zip (always) and CRX (only when the `CRX_PRIVATE_KEY` secret is set — it must be a PEM private key matching the `key` pinned in `wxt.config.ts`, verified in CI; without the secret, the release contains only the zip).

## Architecture
- The service worker (`src/entrypoints/background.ts`) is intentionally minimal and handles only scheduling and alarms. All heavy backup/restore work runs on the dashboard page so the MV3 worker lifecycle does not terminate operations. There is no popup — the toolbar action opens `dashboard.html` as a tab (Android-friendly).
- `src/lib/`: core logic (JS) — `collect.js`, `restore.js`, `sitedata.js` (pipeline orchestration; dependencies are split into focused modules: `scan-config.js` = SITE_DATA_CONFIG, `tab-ownership.js` = tab safety kernel, `scan-groups.js` = scan/error groups, `scan-concurrency.js` = slot pool + CPU/load monitor; `sitedata.js` re-exports its public surface so existing importers remain unchanged), `site-log.js` (centralized logging), `cloud.js`/`github.js`/`providers.js`, `scheduler.js`, `crypto.js`, `validate.js`, `settings.js`, `capabilities.js`.
- `src/dashboard/`: dashboard logic (TS) — `logic.ts`, `store.ts`, `api.ts` (adds `window.__api` for test automation via `installTestHooks()`), `theme.ts`, `site-log-store.ts`, and `cloud-ui.ts`. The single `dashboard.html` uses the hash routes `#/summary`, `#/settings`, `#/results`, `#/failures`, `#/log`, and `#/more`. Legacy Indonesian hashes remain supported.
- `public/lib/pagelib.js`: script injected into pages (namespace `__BBR`), used to read per-site data.
- Manifest: the public `key` is fixed, which makes the extension ID deterministic. Do not change permissions without a real need (release compatibility contract).

## Tab safety (hard rules)
- `chrome.tabs.remove` may only be called inside `safeCloseTab` (`src/lib/tab-ownership.js`, marked `SAFETY-ALLOWED`), based on the `ownedTabIds` registry plus verification that the tab URL still carries the scan marker. Never close tabs based on a query or group membership.
- `chrome.windows.remove` is prohibited everywhere. Scan groups are allowed to disappear on their own when their last tab is closed.
- These protections are enforced in layers: `tests/safety/no-raw-tab-remove.test.mjs` (static, including dynamic access via `chrome.tabs["remove"]`), `tests/sitedata/runtime-tab-remove-guard.test.mjs` (runtime), and the ESLint `no-restricted-syntax` rule (disabled specifically in `sitedata.js` because tests check the `SAFETY-ALLOWED` marker).
- Do not delete browser/user data or perform broad storage cleanup.

## Other security
- `innerHTML`/`outerHTML` are prohibited (XSS) — use safe DOM APIs.
- `no-console` in `src/` (exception: the `log()` implementation in `src/lib/site-log.js`). Log through `log(level, category, message, context)` with levels `DEBUG/INFO/WARN/ERROR/FATAL` and categories `W1/W2/STORAGE/CPU/LOAD/SAFETY/RETRY/SYSTEM`; empty catches are prohibited (`allowEmptyCatch: false`), so log the reason.
- Secret hygiene: GitHub tokens belong only in the `Authorization` header; passwords are never transmitted or stored; settings exports do not include tokens. Public+plaintext cloud backups are always rejected (`ERR_NO_PASSWORD` / `ERR_PUBLIC_REQUIRES_ENCRYPTION`), with no plaintext fallback.

## Lint & style (the unexpected parts)
- `no-use-before-define`: `functions: false` (function declarations are hoisted and safe), `classes`/`variables: true`. Real TDZ issues come from `let`/`const`/`class`, not functions — do not "fix" this with `functions: true`, because that would force a refactor of safe code.
- Type-aware rules are enabled (`no-floating-promises`, `require-await`, `no-misused-promises`, `await-thenable`), but `unsafe-*` is disabled because JS files have no JSDoc types. TypeScript is pinned to 5.9.2 (typescript-eslint does not yet support TS 7).
- Limits: `complexity` 25, `max-depth` 6, `max-params` 5. The technical-debt exceptions documented in `eslint.config.mjs` (for example, `runCloudBackup` 77, `collectSiteData` 65) are technical debt, not exemptions. Refactoring risks changing behavior, so do not touch them without a reason.
- `no-await-in-loop` is disabled (sequential await is intentional); `require-atomic-updates` is disabled (false positive, no shared-memory concurrency).

## Test conventions
- Write unit/integration suites with Node's `node:test` (`describe`/`it`) and `node:assert/strict`, named `*.test.mjs` in the existing domain folders so `node --test` discovers them. Keep browser suites named `*.e2e.mjs` and the extension UI script separate from default auto-discovery.
- E2E conventions (`docs/E2E.md`): reuse `launchDashboard()` + `apiCall()` from `tests/e2e/launch.mjs`; restore requires explicit category options (`options: { bookmarks: { enabled: true } }`) because restore is disabled by default; clear `chrome.storage.session` (`bbr:session-pw`) before testing behavior without a password; end every browser test with an assertion that there are zero `pageErrors`.
- A sandbox that blocks top-level navigation to a local origin (Chrome Local Network Access) cannot assert site-data storage contents — this is an environment limitation, not a bug.

## Git
- Do not create commits, tags, or pushes without the user's explicit approval for those actions. Do not use amend, rebase, or force-push as a substitute for that approval.

## Workflow
- Understand the structure, relevant flows, contracts, documentation, and tests before designing changes; map components and dependencies before making architectural changes.
- Complete skills are available in `docs/agent-skills/`. Read the relevant copies and invoke installed skills when their triggers apply (`brainstorming` for design, TDD for features/fixes, `systematic-debugging` when something fails, `verification-before-completion` before claiming completion).
- Keep changes as small as possible, preserve behavior and tests, do not weaken or remove tests, and do not add dependencies without a real need.
- Preserve Chrome MV3 backup/restore safety and the release compatibility contract. Release-specific contracts may be changed only based on an approved design or specification.
