# E2E Test Suite

End-to-end tests that load the **real built MV3 extension** (`.output/chrome-mv3`)
in Chromium (Playwright) and drive it through the `window.__api` automation
surface (`src/dashboard/api.ts`, installed by `installTestHooks()` in
`main.tsx` — harmless in production).

## Layout

| File | What it is |
|---|---|
| `tests/e2e/launch.mjs` | Shared launcher: persistent context with the extension loaded, dashboard opened, `__api` ready. `apiCall(page, expr, arg)` runs an expression against `(api, a)` inside the page and normalizes to `{ ok, value }` / `{ ok, false, code, message }`. Honors `CHROMIUM_PATH` (also fixed in `tests/extension-ui.mjs`). |
| `tests/e2e/seeds.mjs` | Bookmark seed / destroy / verify helpers through the real `chrome.bookmarks` API. |
| `tests/e2e/github-simulator.mjs` | In-memory GitHub REST API simulator implementing exactly the surface `GitHubStorageProvider` uses (`GET /user`, `GET /repos/{o}/{r}`, contents GET/PUT/DELETE incl. raw mode, directory listing). Records every request in `sim.audit` for secret-hygiene assertions, supports fault injection (`sim.failNext(n, {status})`), byte tampering (`sim.tamper`), and public/private visibility switching. |
| `tests/e2e/local-roundtrip.mjs` | Seed → encrypted `runBackupToFile` (real `chrome.downloads` pipeline) → destroy → wrong password rejected (`ERR_DECRYPT_FAILED`) → `restoreFromText` → bookmarks back exactly → second restore idempotent. Asserts the encrypted file leaks no plaintext URLs/password. |
| `tests/e2e/cloud-roundtrip.mjs` | Full cloud cycle against the simulator: connect + visibility detection → encrypted backup → verified upload → manifest entry (digest, no browser data) → secret hygiene (token only in `Authorization`, password never transmitted) → list → destroy → wrong password → tampered remote artifact rejected (`ERR_CHECKSUM_MISMATCH`) → restore exact → injected HTTP 500 → typed error + pending retry scheduled → `sync-retry` uploads the **same** artifact (no re-collection) → policy matrix (public+plaintext refused with `ERR_NO_PASSWORD`, never a plaintext fallback; public+encrypted passes; private+plaintext passes as plaintext). |
| `tests/e2e/scheduler-roundtrip.mjs` | Scheduler integration: catch-up decision → `runIfDue` executes and verifies → duplicate prevented (`already-succeeded-today`) → disabled schedule not due → passwordless run refused (`ERR_NO_PASSWORD`) and recorded as failed. |
| `tests/e2e/sitedata-tabs.mjs` | Streaming site-data collection against three local HTTP origins with `scanWindowSize: 2`: Worker 1 opens scan tabs straight into the single `BBR Site Scan` group while Worker 2 reads with bounded concurrency (4 debugger sessions) and closes each tab — the live group tab count is polled during the run and every stats snapshot is asserted so tabs-in-group/slots never exceed the window, exactly one scan group exists, progress carries `(done/total)` counts with monotonic `frac` ending at 1, pre-existing tabs survive untouched (never grouped/closed), and scan tabs + group are cleaned up afterwards → snapshots read with bounded concurrency (4 parallel debugger sessions) → progress messages carry `(done/total)` counts (e.g. `3/50`) with a monotonic `frac` in `[0,1]` ending at exactly 1 → scan tabs + group cleaned up afterwards, history entries wiped. NOTE: sandboxes that block top-level navigation to local origins (Chrome Local Network Access checks) prevent asserting storage *content*; the read path itself is unchanged from the validated implementation. |
| `tests/sitedata-tab-cleanup.mjs` | Node regression test (no browser): runs the real `src/lib/sitedata.js` against a fake `chrome` object. Verifies the streaming pipeline's hard rules — (A) 40 origins with window=8: peak open tabs ≤ 8, opens are parallel (peak > 1), every tab lands in the single scan group, nothing left behind; (B) a taken-over tab is never closed (ungrouped, slot released, scan completes); (C) vanished tabs skipped cleanly; (D) adaptive CPU window shrinks fast on sustained high CPU, grows back slowly, never exceeds the configured max, floor holds; (E) `scanWindowSize` option is clamped (2–50) and reaches the collector. |
| `tests/theme-mode.mjs` | Node unit test for `src/dashboard/theme.ts` (fake document/window/chrome): boot defaults, synchronous mirror apply (no flash), persistence to `chrome.storage.local` + mirror, subscriber notification, invalid values ignored, system mode follows OS changes. |
| `tests/e2e/theme-toggle.mjs` | Dark mode in the real browser: toggle cycles light → dark → system, `dark` class + computed background change, choice persists across reload, zero page errors. |
| `tests/cloud-provider-guard.mjs` | Node-level (no browser) provider-layer policy matrix against the simulator over real HTTP: public+plaintext refused even with `plaintextAllowed=true` (`ERR_PUBLIC_REQUIRES_ENCRYPTION`), private+plaintext gated by explicit ack, encrypted always allowed, token only in `Authorization`. |

## Running

```bash
npm run build                                   # wxt build → .output/chrome-mv3
npm test                                        # node suites (incl. provider guard)

# E2E needs a display (or headless) and a Chromium binary:
export CHROMIUM_PATH=/path/to/chrome           # or: npx playwright install chromium
xvfb-run -a npm run test:e2e                    # local + cloud + scheduler + sitedata round-trips
xvfb-run -a npm run test:ui                     # dashboard UI E2E (existing)
# headless alternative: CI_HEADLESS=1 npm run test:e2e
```

The suite uses fixed, isolated fixtures per run: a fresh browser profile, an
ephemeral in-memory simulator, and bookmark-only collection
(`selectedCategories: ['bookmarks']`) to keep runs fast. No network access
beyond `127.0.0.1` is required; no real GitHub token is ever used.

## Conventions for new E2E tests

1. Reuse `launchDashboard()` + `apiCall()` — never hand-roll context setup.
2. Seed through the same public APIs a user interaction would use (`seeds.mjs`).
3. Restore needs explicit category options, mirroring the UI:
   `options: { bookmarks: { enabled: true } }` (restore defaults to
   `enabled: false`, i.e. skipped, like an unticked checkbox).
4. Clear `chrome.storage.session` (`bbr:session-pw`) before asserting
   passwordless behavior — successful encrypted runs remember the password
   for the session by design.
5. Assert zero `pageErrors` at the end of every browser test.
