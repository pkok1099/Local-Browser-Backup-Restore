# Extension permission audit (1.4.6)

The manifest permission set was traced against the collectors, restore pipeline, dashboard, scheduler, capability probes, and site-data scanner before the 1.4.6 release. **No permission was removed:** each declared API permission supports an implemented backup, restore, scheduling, diagnostics, or large-data persistence path. The broad host access is also necessary for the documented all-origin site-data and cookie workflows.

| Manifest permission | Feature/API use | Why it remains |
| --- | --- | --- |
| `bookmarks` | `chrome.bookmarks.getTree()` in collection and origin discovery; bookmark mutations during restore and capability probes | Required to back up and restore bookmarks and to discover candidate origins for site-data scanning. |
| `history` | `chrome.history.search()`, `getVisits()`, and history restore | Required for history backup/restore and origin discovery. |
| `tabs` | `chrome.tabs` queries/create/update/group/cleanup in collection, restore, dashboard, background worker, and site-data scanner | Required for tab/session backup/restore and for safely opening, reusing, tracking, and cleaning up scan tabs. |
| `tabGroups` | Query/update groups during tab collection, restore, and scan-tab management | Required to preserve browser tab groups and to keep scanner tabs organized. |
| `sessions` | `chrome.sessions.getRecentlyClosed()` and related restore paths | Required to back up and reopen recently closed tabs/windows. |
| `cookies` | `chrome.cookies.getAll*()`, `set()`, and `remove()` in collection, restore, and capability probes | Required for cookie backup/restore, including supported partitioned-cookie handling. Chrome additionally requires matching host access for cookies on site origins. |
| `downloads` | `chrome.downloads.search()` and `download()` | Required to collect download metadata and create backup artifacts. |
| `readingList` | Reading-list collection, restore, origin discovery, and capability probes | Required to preserve the user's reading-list entries and use their origins during site-data backup. |
| `storage` | `chrome.storage.local`, `sync`, and `session` across preferences, scan state, local backup state, cloud credentials/state, and scheduler | Required for extension settings and workflow state; session storage also holds ephemeral backup credentials. |
| `unlimitedStorage` | Durable local extension storage for backup/state payloads and scan/crawl records | Retained to avoid the default extension-storage quota breaking larger browser backups or long site-data scans. |
| `management` | `chrome.management.getAll()` in extension collection | Required to include installed-extension metadata in backups. It does not read extension package contents. |
| `scripting` | `chrome.scripting.executeScript()` for cross-origin frame storage capture and restore | Required for site storage in open cross-origin/OOPIF frames that the debugger API cannot reach. |
| `debugger` | `chrome.debugger.attach/sendCommand/detach()` for page-context storage access and restore | Required for the implemented localStorage, IndexedDB, Cache Storage, service worker, OPFS, and storage-bucket workflows; the project documents that the relevant CDP storage domains are unavailable directly through this API. |
| `alarms` | Background schedule checks and cloud retry scheduling | Required for daily/weekly backup scheduling and deferred cloud-upload retries. |
| `system.cpu` | `chrome.system.cpu.getInfo()` in the site-data scan load monitor | Required by the scanner's CPU-aware concurrency/load management. The code has a defensive fallback when the API is unavailable, but removing the declaration would disable this supported monitoring path. |

## Host permissions

`http://*/*` and `https://*/*` are both retained. The extension scans and restores site data for origins discovered across tabs, history, bookmarks, reading-list entries, and cookies—not only the dashboard's own origin or currently open sites. The scanner opens/reuses origin tabs and executes page-context code through `chrome.debugger`; `chrome.scripting` also accesses frames on those origins. Cookie collection/restoration likewise needs access for arbitrary site URLs. Narrowing the patterns to a fixed host list would break the core all-site backup/restore contract.

## Sensitive APIs

`cookies` and `debugger` remain because the corresponding features are implemented and directly call those APIs. Removing either would disable an explicit core category: cookies, or website storage/site-data backup and restore. The UI and capability documentation disclose the debugger attachment indicator and the sensitive nature of cookie/site storage data.
