# Agent Guide

## Core Architecture & MV3 Execution
- **WXT + React + Tailwind**: Build output is strictly `.output/chrome-mv3/` (unpacked extension root).
- **Execution Location**: All backup, restore, capability probing, and cloud operations run inside the **dashboard page tab** (`src/entrypoints/dashboard/`), NOT in the service worker (`src/entrypoints/background.ts`). Service workers are idle-killed by Chrome MV3 during long operations.
- **Core Logic & State Bridge**: Business logic is pure JS in `src/lib/*.js` (`collect.js`, `restore.js`, `sitedata.js`, `cloud.js`, `crypto.js`). UI state bridges logic via `src/dashboard/store.ts` and `logic.ts`. `src/dashboard/api.ts` exposes `window.__api` for test automation.

## Developer Commands & Order
- **Verification Order**: Run `npm run check` then `npm test`.
- **Typecheck Prerequisite**: `npm run typecheck` uses `tsconfig.check.json` and requires generated WXT types. Run `npx wxt prepare` first if `.wxt` directory is missing or after manifest changes.
- **Single Node Test**: `node tests/<test-file>.mjs` (e.g., `node tests/sitedata-tab-cleanup.mjs`).
- **E2E Tests**: Require built extension (`npm run build`).
  - Headless run: `CI_HEADLESS=1 npm run test:e2e`
  - With Xvfb: `xvfb-run -a npm run test:e2e`
  - Dashboard UI E2E: `xvfb-run -a npm run test:ui`
- **Quality Checks**:
  - `npm run check` runs `lint`, `typecheck`, and `format:check`.
  - `npm run cycles` checks for circular dependencies via `madge`.
  - `npm run knip` checks for unused files/exports.

## Code Conventions & Safety Rules
- **Tab Removal Safety**: Direct calls to `chrome.tabs.remove` or `browser.tabs.remove` are strictly forbidden outside `safeCloseTab()` in `src/lib/sitedata.js` (enforced by ESLint and `tests/no-raw-tab-remove.mjs`). Use `ownership.safeCloseTab()`.
- **XSS & Logging**: `innerHTML` and `outerHTML` are forbidden. `console.log` is blocked by ESLint across `src/` (except `src/lib/site-log.js`). Never log cookie values or user passwords.
- **Data Preservation**: Never delete browser/user storage or wipe data broadly. Maintain Chrome MV3 backup/restore compatibility contracts (v2 envelope, PBKDF2 600k iterations, AES-256-GCM).

## Git & Workflow
- Do NOT run `git commit`, `git tag`, or `git push` without explicit user permission.
- **Agent Skills**: Local skill instructions exist under `docs/agent-skills/`.
