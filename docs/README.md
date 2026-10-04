# Local Browser Backup & Restore

A **Manifest V3** Chromium/Chrome extension for backing up and restoring browser data **100% locally**. It uses no server, telemetry, native code, or browser modifications.

- **Backup format version:** 1 (`chrome-local-backup`)
- **Core backup/restore tested on:** Chrome for Testing 131.0.6778.204 (Linux x86-64, headless)
- **Minimum version:** Chrome/Chromium ≥ 114 (because of the `readingList` permission)
- Select backup categories in the dashboard. Website data appears as a searchable list of origins, with an option to include each site.

---

## Installation (unpacked extension)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Run `npm ci`, then `npm run build`. Click **Load unpacked** → select the `.output/chrome-mv3/` folder.
4. The extension icon appears in the toolbar. Click it to open the dashboard in a new tab. The extension has no popup, which makes the flow more convenient in Android browsers.

> The extension ID is deterministic because the manifest includes a public `key`. Local backups do not send data. The GitHub connection is used only when the cloud feature is configured and used.

### Requested permissions (and why)

| Permission | Reason |
|---|---|
| `bookmarks`, `history`, `tabs`, `tabGroups`, `sessions`, `readingList` | Read and restore this data |
| `cookies` + host `http://*/*`, `https://*/*` | Read and restore cookies from all sites |
| `downloads` | Read the download history list and save backup files |
| `storage`, `unlimitedStorage` | Store preferences and temporary backups |
| `management` | Read the list of installed extensions (metadata, for the reinstall checklist) |

The extension does not send telemetry or use remote code. It uses network connections only for the GitHub backup feature selected by the user. The GitHub token is stored in extension storage and is not shown again in the UI.

---

## Quick usage

### Backup
1. Click the extension icon to open the dashboard. Choose **Local only** to save a file in Downloads, **Cloud only** to save to GitHub, or **Both** to save to both.
2. Local backups can be created as plaintext `.json` or encrypted `.enc.json`. Cloud backups follow the repository's encryption policy and cloud preferences.
3. For an encrypted backup, enter a password (≥ 8 characters recommended). **The password is never stored. If it is lost, the backup cannot be opened.**
4. Downloaded files are saved in the Downloads folder with the name `browser-backup-YYYYMMDD-HHMMSS[.enc].json`.
5. The dashboard displays a summary for each category, including the item count and restorable status.

Cloud scheduling can run daily or weekly on selected days. Retry status shows the next attempt, and automatic retries can be canceled without deleting the pending backup. Settings can be exported or imported as JSON. The GitHub token is never included, and the token in the destination profile is retained.

> If **Automatically retry failed uploads** is enabled, failed cloud uploads use a temporary copy in extension storage and retry after 1, 2, 4… minutes (up to 8 attempts). The temporary copy is deleted after a successful upload. The browser must be running for the retry alarm to be processed.

### Restore
1. Click the extension icon to open the dashboard, then choose **Restore from file** and select a backup file.
2. If it is encrypted, enter the password.
3. The dashboard displays the backup contents, the restorable status for each category, and **honest limitations** (for example, "History: basic restore only").
4. Select the categories to restore. By default, all restorable categories are selected, while `Downloads` is disabled.
5. Click **Restore**. The default restore is **non-destructive**:
   - Bookmarks: *merge* (existing URLs in the destination folder are skipped).
   - *Replace* mode, which first deletes the bookmarks bar and other bookmarks, runs only when selected and confirmed in the dialog.
   - Tabs/windows are created as **new** windows/tabs. Existing data is not touched.
6. Results are displayed for each category, including failed items and the reasons they failed.

### Check Capabilities
Displays live API detection in your browser (Read / Backup / Restore for each category) and runtime probe results (experimental evidence, such as `history.addUrl` behavior).

---

## Project structure (since v1.4.0 — WXT + React + shadcn/ui)

```
wxt.config.ts              ← WXT configuration: MV3 manifest, permissions, public key, Tailwind v4
src/
  entrypoints/
    background.ts          ← service worker (scheduler + cloud-retry alarm; logic identical to v1.3.0)
    dashboard/             ← dashboard page (index.html + main.tsx + App.tsx)
  dashboard/
    store.ts               ← external state store (logic ↔ React bridge)
    logic.ts               ← local backup/restore/capabilities pipeline port
    cloud-ui.ts            ← cloud handler port (connect/backup/retry/schedule/settings/init)
    api.ts                 ← window.__api (automated test surface, identical to v1.3.0)
  lib/                     ← core logic (NOT changed from v1.3.0):
    settings.js            ← preference export/import validation (without token)
    scheduler.js           ← pure scheduling decisions (daily/weekly) + storage state
    cloud.js               ← cloud orchestrator (pending retry, retention, status phases)
    github.js              ← GitHubStorageProvider (Contents API + object verification)
    providers.js           ← StorageProvider contract + LocalStorageProvider + placeholder
    artifact.js            ← backup artifact + manifest + plaintext guard (below-UI)
    crypto.js              ← PBKDF2(600k) + AES-256-GCM + AAD envelope
    format.js              ← format v2 constants + integrity digest
    collect.js/restore.js  ← collector & restorer for all categories
    sitedata.js/capabilities.js/util.js/validate.js
  components/
    ui/                    ← shadcn/ui components (button, card, select, checkbox, etc.)
    dashboard/             ← dashboard feature cards (React + Tailwind)
public/lib/pagelib.js      ← copied unchanged to the build root (used by chrome.scripting)
tests/                     ← Node node:test suites plus separate Playwright UI/E2E tests
docs/                      ← complete documentation + feature specifications
.output/chrome-mv3/        ← output of `npm run build` (folder loaded as an unpacked extension)
```

**Important architecture note (MV3):** all backup/restore operations run on the *dashboard page* (extension tab), rather than in the service worker. The MV3 service worker can be shut down by the browser at any time (idle timeout), which would interrupt long operations. The extension page stays alive while its tab is open and has the full DOM API (Blob, CompressionStream, etc.).

---

## Development (WXT)

```bash
npm install          # install dependencies
npm run dev          # dev mode (auto-reload, load unpacked from .output/chrome-mv3)
npm run build        # production build → .output/chrome-mv3
npm run zip          # zip package ready for publishing
npm run compile      # TypeScript typecheck (tsc --noEmit)
npm test             # Node 24 auto-discovers tests/**/*.test.mjs (concurrency 7)
npm run verify       # WXT prepare, then lint + typecheck + format check + npm test in parallel
npm run test:e2e     # Playwright browser suites (*.e2e.mjs), after a fresh build
npm run test:ui      # Separate Playwright UI smoke test, after a fresh build
```

The v1.4.0 migration preserves backup format v2, the StorageProvider contract, public/private encryption policies, daily/weekly scheduling, exponential retries, and token-safe settings transfer. The core logic (`src/lib/*.js`) is identical to v1.3.0, so older backups can still be opened.

---

## Security

- No network requests, telemetry, analytics, or remote code (CSP MV3 `script-src 'self'`).
- Encryption: **PBKDF2-HMAC-SHA-256 (600,000 iterations)** → **AES-256-GCM** with AAD binding the entire envelope header (rejects parameter downgrade attacks).
- Passwords are not stored, sent, or logged; the derived key is made *non-extractable*.
- Integrity: SHA-256 over canonical JSON (sorted keys) for `counts+data+capabilities`.
- Cookie **values are never printed to the console/log**. Logs contain only names/counts.
- Incognito data is not read. Incognito cookie stores and incognito windows are excluded by design.
- Password managers/autofill are not touched because there is no API for them.

---

## Further documentation

- `docs/BACKUP_FORMAT.md` — complete backup format v1 schema.
- `docs/CAPABILITY_REPORT.md` — Read/Backup/Restore matrix by category + runtime evidence + API limitations.
- `docs/TEST_RESULTS.md` — results of automated tests A–G in Chrome 131.
- `tests/extension-ui.mjs` — Playwright smoke test for the mobile dashboard and loading the MV3 extension in Chromium.
- Run unit/integration tests: `npm test` (or `npm run verify` for checks plus tests). Node's normal CLI can filter them, for example `node --test tests/cloud/*.test.mjs` or `node --test tests/cloud/cloud-retry.test.mjs`. For Playwright tests, first run `npm run build`, then install Chromium with `npx playwright install chromium` and use `xvfb-run -a npm run test:ui` or `xvfb-run -a npm run test:e2e` on headless Linux.

---

## Icon attribution

The extension icon (`public/icon.png`) is by Smashicons from Flaticon — [www.flaticon.com](https://www.flaticon.com).
