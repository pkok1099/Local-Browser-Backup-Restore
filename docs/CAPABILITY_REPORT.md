# Capability Report — Final (pre-cloud stage)

**Extension:** Local Browser Backup & Restore v1.1.0 (Manifest V3)
**Browser under test:** Chrome for Testing **153.0.8010.36** (headless=new, Linux x86_64) — the single browser every result in this repo was produced with
**Evidence:** automated suite `tests/` (9 suites, 9/9 PASS), research kits `research/cdp-storage` + `research/opfs-buckets`
**Date:** 2026-10-01

Legend — **Backup**: data actually captured into the artifact. **Restore**: demonstrated by automated test. **Fidelity**: exact = byte/value-level verified; semantic = meaning preserved, representation differs; lossy = documented data loss inherent to browser APIs; unsupported = no API path (data archived only).

| Data | Backup | Restore | Fidelity | Method | Limitation (all evidence-based) |
|---|---|---|---|---|---|
| Bookmarks | ✅ | ✅ | **exact** (tree/order/titles/URLs) — `dateAdded` **lossy** | `chrome.bookmarks` | `bookmarks.create()` rejects `dateAdded` (runtime probe). Root ids are NOT stable across Chrome versions (131: `1`/`2`; 153: dynamic) — collector/restore resolve roots by position. |
| History | ✅ | ⚠️ basic | **lossy** (URLs re-registered) | `chrome.history` | `addUrl()` re-registers each URL as one "typed" visit at restore time; titles, visit counts, timestamps, transitions are archived only. |
| Tabs & windows | ✅ | ✅ | **exact** (URL/order/pinned/muted/geometry/type/state) | `chrome.tabs` / `chrome.windows` | Titles/favicons re-fetched by the browser. Incognito excluded by design. |
| Tab groups | ✅ | ✅ | **exact** (title/color/collapsed/members) | `chrome.tabGroups` + `tabs.group()` | Group ids regenerated (old→new mapping internal). |
| Sessions (recently closed) | ✅ | ⚠️ semantic | re-opened as new tabs/windows | `chrome.sessions` | 25-item API cap; restore re-opens URLs (timestamps/back-forward stacks not restorable). |
| Cookies | ✅ | ✅ | **exact** (all attributes) | `chrome.cookies` | Incognito store excluded by design. |
| Partitioned cookies (CHIPS) | ✅ | ✅ | **exact**, restored into original partition | `chrome.cookies` + candidate-key scan | No partition-key enumeration API; candidates derived from tabs/history/reading list/cookies (`getAllDefaultPartitionKey` when present). Requires `hasCrossSiteAncestor:false` (probe-verified). |
| Downloads | ✅ | ⚠️ metadata-only | lossy (metadata preserved; file bytes inaccessible) | `chrome.downloads` | Optional re-download mode (off by default) produces new timestamps. |
| Extension metadata | ✅ | ❌ unsupported | checklist only | `chrome.management` | No public API installs extensions; backup contains a reinstall checklist. |
| Extension storage (own) | ✅ | ✅ | exact | `chrome.storage` | This extension's own `storage.local`/`sync` only. |
| **localStorage** | ✅ | ✅ | **EXACT** byte/value-level (unicode, lone surrogates, 256 KB+ values, exotic keys) | `chrome.debugger` → `Runtime.evaluate` in page context | CDP `DOMStorage.*` domain is **blocked** through chrome.debugger; page-context execution is the only path (research-proven). Lone surrogates cross the boundary in a WTF-16 base64 envelope (debugger transport otherwise corrupts them — proven). |
| **sessionStorage** | ✅ | ⚠️ content-only | content restored where a live tab of the origin exists; tab identity lossy | same | Per-tab platform semantics: no API can re-attach storage to a "previous" tab. |
| **IndexedDB** | ✅ | ✅ | **EXACT** (schema, Date/binary/Blob/File/Map/Set/RegExp values, exotic keys incl. array/binary/Infinity, multi-entry indexes) + **key generators restored exactly** | same | Generator measurement consumes one value (probe row); restore reproduces the recorded generator via the bump-trick (put target−1 → delete). CDP `IndexedDB.requestData` is NOT byte-fidelity (truncated previews) — page-context serialization is used instead. |
| **Cache Storage** | ✅ | ✅ | **EXACT** (body bytes, status, statusText, headers) | same | `Response.url`/`redirected`/`type` are cosmetic-only (constructor cannot set them — spec). Opaque (no-cors) responses cannot be read (spec). |
| **Service Worker** | ✅ | ⚠️ conditional | exact when the script is still served (script bytes archived in backup) | same | If the worker script 404s at restore time, registration fails — content is not injectable into the HTTP cache (platform limitation; research R4). |
| **Partitioned website storage** (3rd-party iframe: LS/IDB/Cache) | ✅ (open tabs) | ✅ | **EXACT** per (top-level site, frame origin) — two distinct partitions of the same origin verified | `chrome.scripting` allFrames (debugger cannot reach OOPIF) | Backup covers frames of currently-open tabs; restore requires the embedding page to be open — partitions without a live host are kept in the backup with an explicit note. |
| **OPFS** (Origin Private File System) | ✅ | ✅ | **EXACT** (nested dirs, unicode/exotic filenames, empty files, 1 MB binary) — `lastModified` **lossy** | same (page context) | `createWritable()` cannot set mtimes (no API). Merge restore keeps unrelated files (non-destructive); replace mode wipes first (explicit confirmation). |
| **Storage Buckets** | ✅ | ✅ | **EXACT** (bucket-scoped IndexedDB + Cache Storage + OPFS per bucket) | same | Bucket identity = name string; `durability`/`persisted` are request hints and are NOT echoed back by the API (`durability` reads null). Names cannot start with `__`. `clearDataForOrigin('all')` deletes buckets (verified) — restore recreates them. Official docs claim only IndexedDB is implemented; empirical probing found all three sub-APIs (Chrome 153). |
| Browser settings (homepage, search, theme…) | ❌ | ❌ | — | none | No public API (`settingsPrivate` is Google-private). |
| Passwords / autofill / payments | ❌ | ❌ | — | none | Out of scope by design (security). |
| Favicons / Top Sites | ❌ (derived) | ❌ | — | — | Derived data, regenerated automatically; archived implicitly via history. |
| Per-site content settings | ❌ | ❌ | — | `chrome.contentSettings` | Can set patterns but cannot reliably enumerate existing exceptions. |

## Method notes (why this matrix is trustworthy)

1. **Every "exact" claim is backed by an automated, repeatable comparison** — canonical (type-preserving) JSON comparison of backup vs post-restore re-read, per key/record/entry/file, plus SHA-256 per category section. Same reader performs seed, backup and verify (no asymmetric encoding).
2. **The destructive restore test (`run-K`)** seeds every category, destroys the profile through supported APIs only (no raw profile-database access), restores, and compares pre/post snapshots with the classification above. 68 automated checks.
3. **Restore correctness outranks coverage**: categories that cannot be fully restored (history detail, downloads bytes, extension packages, SW scripts when unserved) are labeled lossy/unsupported here, in the UI, and inside the backup file itself.

## Known limitations that are *not* fixable via supported APIs

- History visit-level fidelity (no write API for visits).
- `bookmarks.create` ignoring `dateAdded`.
- sessionStorage tab identity.
- Service Worker scripts that no longer resolve (archived; cannot be force-injected).
- Downloaded file bytes (no API).
- Extension package installation.
- OPFS file mtimes.
- Bucket durability/persisted echo.
- Partitioned-storage enumeration without an open embedding page.
- Chrome-Android: extensions (and thus `chrome.debugger`) are unavailable there; the raw-CDP page-session path remains usable via adb (documented in research/cdp-storage REPORT §8).
