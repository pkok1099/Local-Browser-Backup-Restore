# Backup Format — v2

Single-file, self-contained JSON artifact. Plaintext: `chrome-local-backup` (`formatVersion: 2`). Encrypted: `chrome-local-backup-encrypted` (envelope, `formatVersion: 2`, **`encryptionVersion: 1`** — versioned independently of the backup format); v1 files of both kinds remain readable (transparent upgrade path).

```jsonc
{
  "format": "chrome-local-backup",
  "formatVersion": 2,
  "createdAt": "2026-10-01T12:00:00.000Z",
  "generator": {                       // who/what produced the file
    "name": "Local Browser Backup & Restore",
    "extensionVersion": "1.1.0",
    "chromeVersion": "153.0.8010.36",
    "userAgent": "…", "locale": "…"
  },
  "capabilities": { /* capability snapshot at backup time (detect()) */ },
  "categoryVersions": {                // NEW in v2: per-category schema versions
    "bookmarks": 1, "history": 1, "tabsWindows": 1, "sessions": 1, "cookies": 1,
    "downloads": 1, "readingList": 1, "extensionStorage": 1,
    "installedExtensions": 1, "extensionPermissions": 1, "profile": 1,
    "siteData": 1
  },
  "counts": { /* item counts per category, incl. siteData* aggregates */ },
  "data": {
    "bookmarks":  { "roots": { "bookmark_bar": …, "other": …, "mobile": … } },
    "history":    { "items": […], "visits": { "url": […] } },
    "tabsWindows":{ "windows": […], "tabGroups": […] },
    "sessions":   { "recentlyClosed": […], "devices": […] },
    "cookies":    { "cookies": [ /* incl. partitionKey for CHIPS */ ] },
    "downloads":  { "items": […] },
    "readingList":{ "entries": […] },
    "extensionStorage": { "local": {…}, "sync": {…} },
    "installedExtensions": { "items": […] },
    "extensionPermissions": { "permissions": […], "origins": […] },
    "profile":    { "userAgent": "…", "chromeVersion": "…", "platform": {…} },
    "siteData": {                      // NEW in v2 — websites' storage
      "schemaVersion": 1,
      "method": "chrome.debugger+scripting (page-context execution)",
      "origins": {
        "https://example.com": {
          "origin": "https://example.com",
          "fromOpenTab": false,
          "localStorage": { "key": "value", "lone\uFFFD…": { "__bbrSur": "<b64 WTF-16LE>" } },
          "sessionStorage": { /* captured only when an open tab existed */ },
          "indexedDB": [ {
            "name": "AppDB", "version": 2,
            "stores": [ {
              "name": "notes", "keyPath": "id", "autoIncrement": false,
              "indexes": [ { "name": "by_title", "keyPath": "title", "unique": false, "multiEntry": false } ],
              "records": [ { "k": { "t": "str", "v": "n1" }, "v": { "t": "obj", "v": { … } } } ]
            } ]
          } ],
          "cacheStorage": [ { "name": "assets-v1", "entries": [ {
              "url": "/api/json", "method": "GET", "status": 200,
              "statusText": "", "headers": {…},
              "bodyB64": "…", "bodyLen": 42 } ] } ],
          "serviceWorkers": [ { "scope": "…/", "scriptURL": "…/sw.js",
              "updateViaCache": "none", "state": "activated",
              "scriptB64": "…", "scriptError": null } ],
          "opfs": { "files": [ { "path": "docs/a-4kb.bin", "size": 4096,
                        "lastModified": 1710000000000, "type": "", "b64": "…" } ],
                    "dirs": [ "docs/", "docs/nested/", "__order__…" ] },
          "buckets": [ { "name": "bkt-alpha",
              "requested": { "durability": "strict", "persisted": true },
              "handleProps": { "name": "bkt-alpha", "durability": null },
              "persisted": false, "expires": null,
              "indexedDB": [ … same shape as origin IDB … ],
              "cacheStorage": [ … ],
              "opfs": { … },
              "apiPresence": { "indexedDB": "object", "caches": "object",
                               "getDirectory": "function", "open": "undefined" } } ],
          "errors": [ /* per-block read errors, e.g. unreachable origin */ ]
        }
      },
      "partitions": [ /* third-party iframe storage of open tabs */
        { "topSite": "https://host.test", "frameOrigin": "https://frame.test",
          "snapshot": { "origin": "…", "localStorage": {…}, "indexedDB": […], "cacheStorage": […] } }
      ],
      "notes": [ /* per-origin read failures, scan caps, etc. */ ]
    }
  },
  "integrity": {
    "algorithm": "sha256",
    "canonicalization": "json-sorted-keys-utf8",
    "scope": "counts+data+capabilities+categoryVersions",
    "digest": "<sha256 hex of canonicalized {counts,data,capabilities,categoryVersions}>",
    "categories": { "<name>": "<sha256 hex of canonicalized section>" }   // NEW in v2
  }
}
```

## Design decisions

- **Versioning.** `formatVersion` (2) gates whole-file compatibility; `categoryVersions` lets a restore engine reason per category (e.g. an old backup without `siteData`, or a future tool adding `siteData` schema 2). v1 artifacts (no `categoryVersions`, no per-category digests, no `siteData`) are accepted and validated with the v1 digest scope.
- **Integrity.** Whole-file digest plus per-category digests (v2). Corrupted category ⇒ error naming the category. The digest covers `counts` too, so count tampering is detected.
- **Type fidelity.** Values are stored in a tagged encoding (`t: str/date/ab/tv/blob/file/map/set/…`) so Date, ArrayBuffer/TypedArray, Blob, File, Map, Set and RegExp survive byte/value-level. Keys of IDB records use the same mechanism (`num/str/date/arr/bin`).
- **Strings and lone surrogates.** Strings containing lone surrogates (invalid Unicode, rare but real) are wrapped as `{ "__bbrSur": "<base64 of UTF-16LE bytes>" }`. This both (a) survives the chrome.debugger transport, which corrupts lone surrogates (proven), and (b) keeps the JSON artifact clean.
- **Binary policy.** Binary payloads are base64 inside the JSON artifact; the encrypted envelope is gzip-compressed before encryption, which recovers most of the base64 overhead. A multi-file "blob sidecar" layout was considered and rejected for now: it would break the single-artifact guarantee (easy safe copy/move/delete, one integrity scope, one upload unit) for a ~33% size win on binary-heavy sections. This is a documented trade-off, revisitable before cloud integration if real-world artifacts prove binary-dominated.
- **No secrets by design.** Passwords never enter the artifact or logs; cookie values are only inside the (optionally encrypted) artifact; logs redact values.
- **Only what was actually read** ends up in `data` — a failing category is recorded in the run log and excluded, never stubbed.

## siteData notes

- Origins are discovered from open tabs, history, bookmarks, reading list and cookie domains (capped, prioritized). Each origin is read by opening/reusing one hidden tab and executing page-context JavaScript through `chrome.debugger` (the CDP storage domains are blocked through that API — research-proven).
- `sessionStorage` is captured only from tabs that were open at backup time and restored only into a live tab of the same origin (platform semantics).
- Service Worker script bytes are fetched (`cache: no-store`) and archived; restore re-registers and waits for activation. If the site no longer serves the script, restore reports the failure explicitly instead of pretending.
- `partitions` cover third-party iframe storage of open tabs; restore requires a live embedding page, otherwise the section is preserved with a note.
- The scan never modifies origin storage at backup time, with one documented exception: measuring an IndexedDB key generator consumes exactly one generator value (probe row + delete).

## Encrypted envelope (cloud era)

The encrypted artifact wraps the whole backup JSON as an AEAD envelope. Fields (all non-secret; the password never appears anywhere):

```jsonc
{
  "format": "chrome-local-backup-encrypted",
  "formatVersion": 2,                  // inner-artifact compatibility gate
  "encryptionVersion": 1,              // NEW: encryption scheme version, independent of formatVersion
  "compression": "gzip",               // gzip before encryption
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<b64, 16 bytes>" },
  "aead": { "algorithm": "AES-256-GCM", "iv": "<b64, 12 bytes>" },
  "ciphertext": "<b64>"               // AEAD(canon(header) as AAD, plaintext = gzip(backup JSON))
}
```

- The entire header is bound as GCM additional data; `encryptionVersion` joins the AAD when present (envelopes created before the field existed keep the identical AAD bytes — backward compatible).
- Unknown `encryptionVersion` → `ERR_UNSUPPORTED_ENCRYPTION_VERSION` (rejected before decryption). Wrong password or tampered ciphertext → `ERR_DECRYPT_FAILED` (honest AEAD fail-closed semantics). Corrupt structure → `ERR_PARSE` / `ERR_MALFORMED_ENVELOPE`.

## Remote artifact & repository layout (GitHub cloud stage)

The bytes stored remotely are exactly the serialized artifact above (plaintext `chrome-local-backup` only for private repositories with an explicit user choice; encrypted envelope otherwise — public repositories only ever receive the encrypted envelope, enforced below the UI in `lib/artifact.js assertUploadSafe()`).

```
<basePath>/manifest.json                    browser-backup-remote-manifest v1
<basePath>/backups/backup-<timestamp>-<id>.bbr
```

Manifest entry (non-sensitive by design — no URLs, titles, origins or counts):

```jsonc
{
  "id": "20261002-120000-a1b2c3d4", "filename": "backup-…bbr",
  "createdAt": "…", "sizeBytes": 25413,
  "format": "chrome-local-backup-encrypted", "formatVersion": 2,
  "encrypted": true, "encryptionVersion": 1,
  "integrity": { "algorithm": "sha256", "encoding": "utf8", "digest": "<sha256 of the exact artifact bytes>" },
  "browser": { "extensionVersion": "…", "chromeVersion": "…" },
  "trigger": "manual | scheduled | sync-retry"
}
```

Upload verification: after the Contents API PUT, the provider re-downloads the object and requires both SHA-256 and git blob sha1 (`sha1("blob <len>\0<content>")`) to match; otherwise the upload is reported as failed (`ERR_VERIFY_FAILED`).
