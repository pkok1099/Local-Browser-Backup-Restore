# Backup and restore trust design for 1.4.7

## Goal

Make backups safer to create and restore, make partial outcomes honest, and let users clear extension-generated results and logs without touching browser data or durable recovery state. Keep the change suitable for a 1.4.x release: retain the current v2 backup output format and v1/v2 read compatibility, preserve the dashboard’s single-document crawl context, and do not change browser permission requirements.

## Existing behavior that this design addresses

- The extension-storage collector currently copies all of `chrome.storage.local` and `chrome.storage.sync`. Local data includes cloud configuration and its GitHub token, internal checkpoints, durable artifacts, and `bbr:last-backup`, which can contain an unencrypted raw backup even when an encrypted file is produced.
- Backup output already has v2 integrity hashes; restore validates format and integrity, and encrypted artifacts use authenticated encryption. Cloud uploads are verified against the remote artifact digest. The missing guarantee is that all generated local/encrypted artifacts are self-checked before they are retained or offered.
- Restore preview currently relies on capability data recorded in the backup, which may not describe the browser receiving the restore. Several restore handlers can report `ok` while their statistics show failed items, and the UI can color skipped/absent outcomes as errors.
- Structured log count caps exist, but the IndexedDB key sequence restarts for each logger instance, persistent entries may collide across scans, “Bersihkan tampilan” clears only memory, auto-scroll can move the outer page, and fatal entries can bypass the nominal hard cap.
- A stopped scan may retain a checkpoint and retry cache. Durable local/cloud artifacts, pending uploads, cloud credentials, and owned-tab records also serve distinct recovery or security purposes and must not be treated as display results.

## Proposed behavior

### Safe extension preferences and verified artifacts

Replace broad extension-storage export with an explicit allowlist of non-secret preferences currently used by the extension:

- `bbr.dashboard.theme`
- `bbr:backup-categories`
- `bbr:site-data-scan-window`
- `bbr:site-data-tuning`
- `bbr:site-data-include`

Do not export the selected site-origin list (`bbr:site-data-included-origins`), because it can reveal browsing interests. Do not export unknown or internal local/sync keys. In particular, omit cloud config and tokens, pending upload/cloud state, scheduler internals, scan checkpoints and owned tabs, durable local-artifact records, retry guards, and raw backup cache. The current code does not use `storage.sync` for extension preferences, so export no sync keys until an explicit safe setting is added.

On restore, apply only keys on the same allowlist; ignore reserved/unknown keys in older backup files, never replace credentials, and report how many extension-storage keys were skipped. Merge allowed preferences rather than clearing the extension’s entire storage namespace. Continue reading existing v1/v2 backup artifacts; do not add a format field in 1.4.7.

Before a new backup artifact is saved, downloaded, or uploaded, validate the finalized v2 object. For encrypted output, perform a bounded encrypt/decrypt round-trip check and validate the recovered object before making the artifact available. Do not persist a raw unencrypted duplicate in `bbr:last-backup`; retain the current on-demand file download in memory only for the active page. Clear Results removes any legacy `bbr:last-backup` entry. Existing durable local artifacts and remote cloud copies remain independent and are not deleted by this operation.

### Restore preview and outcome reporting

After the selected file is parsed and integrity-checked, evaluate the current target browser with the existing live API-presence capability map and use those results for the preview; do not run separate temporary runtime probes as part of preview. Show the categories and item counts present in the file, the target’s full/partial/unavailable support, warnings for unsupported or inconsistent data, and the effects of destructive replacement options before the user starts restore.

Report each attempted category as complete, partial (with success/failure counts), or failed. If data is present but the target cannot restore that category, label it unavailable; distinguish that from user-skipped and backup-absent categories. Do not present unavailable, skipped, or absent data as a restore error. Do not add a generic Retry All action: only offer retry for a category whose existing restore operation is demonstrably safe to repeat. Keep cloud transfer retry separate from restore retry. Do not implement generalized restore resume in this release.

### Separate result and log clearing

Provide separate `Clear Results` and `Clear Logs` actions with copy that states exactly what each removes. Keep both disabled during relevant active backup, site-data scan/retry, cloud upload, restore, capability-probe, or file-download operations, using a shared activity guard so scheduled and direct cloud paths are included.

- **Clear Results** removes completed backup summaries, completed scan/restore presentation state, the in-memory download object/metadata, and legacy `bbr:last-backup`. Preserve a pending download only if the user has not explicitly chosen to clear it; under this design it is cleared. Preserve retryable site-data data and its checkpoint; disable Clear Results while retryable failures or a resumable checkpoint remain, so the clear action cannot hide unfinished recovery work. Preserve local durable artifacts/manifests, cloud artifacts, pending uploads, credentials, session passwords, owned-tab safety records, and browser data.
- **Clear Logs** empties the dashboard log buffer, structured in-memory log view, persisted `bbr-site-log` entries, and unseen-error count. Serialize/invalidate pending reads and flushes so cleared rows cannot reappear. Do not clear backup/scan state or artifacts.

Neither action calls `chrome.storage.local.clear()` or invokes bookmark, history, tab, cookie, reading-list, or website-storage mutation APIs. The UI makes clear that already-downloaded files cannot be removed from the user's chosen download location.

### Log correctness and usability

Give each persisted log entry a stable unique key across logger instances and scans; migrate existing IndexedDB rows in a versioned upgrade without dropping history. Apply a true hard cap that includes fatal entries while retaining the newest high-severity diagnostics. Auto-scroll only the log panel, only while the user is at its bottom and auto-follow is enabled; pausing must not affect the page scroll position.

## Non-goals

- No new backup format version or mandatory migration of user backup files.
- No generalized restore checkpoint/resume or retry-all workflow.
- No deletion of durable local/cloud backups, cloud credentials, pending uploads, or browser data through a clear-results control.
- No broad permissions change, dashboard redesign, or `logic.ts` refactor unrelated to the trust boundary.
- No attempt to reduce build chunk warnings at the expense of behavior.

## Implementation stages and acceptance checks

1. **Data boundary:** introduce and test the allowlist; filter extension-storage restore input; validate newly finalized plaintext/encrypted artifacts; stop storing a raw backup duplicate. Preserve v1/v2 reading and the existing download action.
2. **Restore truthfulness:** probe the target browser at preview time, correct capability badges, and classify partial/skipped/absent outcomes. Add focused tests for mixed success/failure statistics and unsupported categories.
3. **Log and clear lifecycle:** repair cross-scan IndexedDB identity with migration; enforce the hard cap; make auto-scroll panel-local; add the two guarded clear actions and tests for active-operation locks, pending reads/flushes, and preservation of recovery state.
4. **End-to-end regression:** test plaintext/encrypted exports for secret absence, cache deletion, old-format restore compatibility, target-capability preview, partial results, and both clear actions while asserting browser data, durable artifacts, cloud state/credentials, pending uploads, and scan checkpoints remain unchanged.

Release validation: `npm run check`, `npm test`, `npm run knip`, `npm run cycles`, `npm run build`, `xvfb-run -a npm run test:ui`, and `xvfb-run -a npm run test:e2e`. No code implementation, format change, commit, tag, or push is part of this design document.
