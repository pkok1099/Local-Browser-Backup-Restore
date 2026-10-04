# E2E Test Suite

These Playwright tests load the **real built MV3 extension** from `.output/chrome-mv3` in Chromium and drive it through the `window.__api` automation surface (`src/dashboard/api.ts`, installed by `installTestHooks()` in `main.tsx`). Their `*.e2e.mjs` names keep browser suites separate from Node's default `node --test` auto-discovery.

## Browser suites and helpers

| File | What it covers |
| --- | --- |
| `tests/e2e/local-roundtrip.e2e.mjs` | Seeds browser data, creates an encrypted download, destroys the seed, rejects a wrong password, restores the exact data, and verifies a second restore is idempotent; also checks for plaintext leakage. |
| `tests/e2e/cloud-roundtrip.e2e.mjs` | Full encrypted backup/upload/verify/destroy/restore cycle against the local GitHub API simulator, including tampering, retrying the same artifact, policy cases, and token/password hygiene. |
| `tests/e2e/scheduler-roundtrip.e2e.mjs` | Exercises due/catch-up decisions, a successful scheduled run, duplicate prevention, disabled schedules, and passwordless failure handling. |
| `tests/e2e/sitedata-tabs.e2e.mjs` | Tests a bounded site-data scan in Chromium, including tab grouping, scan-window limits, progress, untouched pre-existing tabs, and cleanup. |
| `tests/e2e/sitedata-error-tabs.e2e.mjs` | Observes tabs during a scan with working and deliberately failing origins, then checks that temporary tabs and scan/error groups are cleaned up. |
| `tests/e2e/sitedata-blocking.e2e.mjs` | Verifies scan-time subresource blocking while localStorage, service-worker data, and a large IndexedDB are still read; also checks redirect cleanup and removal of session rules. |
| `tests/e2e/cookies-partitioned.e2e.mjs` | Backs up both a plain cookie and a partitioned CHIPS cookie, preserves its partition key, and compares the result with a legacy candidate-scan oracle. |
| `tests/e2e/theme-toggle.e2e.mjs` | Cycles light → dark → system, checks the rendered theme, verifies persistence across reload, and asserts there are no page errors. |
| `tests/e2e/launch.mjs` | Shared launcher for a persistent Chromium context with the extension loaded and dashboard open; `apiCall()` normalizes results from `window.__api`. Honors `CHROMIUM_PATH`. |
| `tests/e2e/seeds.mjs` | Bookmark seed, destroy, and verification helpers using the real `chrome.bookmarks` API. |
| `tests/e2e/github-simulator.mjs` | In-memory GitHub REST API surface used by the cloud suite; records requests and supports fault injection, byte tampering, and visibility switching. No real token is used. |
| `tests/extension-ui.mjs` | Separate Playwright smoke test for the mobile dashboard and loading the MV3 extension. |

## Related Node regression tests — not browser E2E

| File | What it covers |
| --- | --- |
| `tests/sitedata/sitedata-tab-cleanup.test.mjs` | Node regression checks for bounded scan tabs, takeover safety, vanished tabs, adaptive concurrency, and scan-window options using a fake `chrome` object. |
| `tests/dashboard/theme-mode.test.mjs` | Node unit checks for dashboard theme defaults, synchronous mirror updates, persistence, subscribers, invalid values, and system theme changes. |
| `tests/cloud/cloud-provider-guard.test.mjs` | Node checks of provider-layer encryption policy and token hygiene against the local HTTP simulator. |
| `tests/dashboard/lazy-route-retry.test.mjs` | Four named `node:test` cases for one-shot chunk recovery, loop prevention, guard clearing after success, per-route isolation/manual retry, and unavailable storage. |

## Running

Run the standard checks and auto-discovered Node unit/integration suites with:

```bash
npm run verify
npm test
```

Build a fresh extension **before** either browser command, because the tests load `.output/chrome-mv3`:

```bash
npm run build
export CHROMIUM_PATH=/path/to/chrome    # or: npx playwright install chromium
xvfb-run -a npm run test:e2e            # all eight browser suites
xvfb-run -a npm run test:ui             # dashboard UI smoke test
# Headless alternative: CI_HEADLESS=1 npm run test:e2e
```

The round-trip suites use fresh browser profiles and local fixtures; cloud coverage uses an in-memory simulator, not a real GitHub account or token. Test servers bind to `127.0.0.1`; the deliberate DNS-failure scenario uses a reserved `.invalid` test hostname.

## Conventions for new E2E tests

1. Reuse `launchDashboard()` + `apiCall()` — never hand-roll context setup.
2. Seed through the same public APIs a user interaction would use (`seeds.mjs`).
3. Restore needs explicit category options, mirroring the UI: `options: { bookmarks: { enabled: true } }` (restore defaults to `enabled: false`, i.e. skipped, like an unticked checkbox).
4. Clear `chrome.storage.session` (`bbr:session-pw`) before asserting passwordless behavior — successful encrypted runs remember the password for the session by design.
5. Assert zero `pageErrors` at the end of every browser test.
