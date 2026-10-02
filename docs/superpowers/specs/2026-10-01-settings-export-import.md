# Settings export and import

## Goal

Allow users to move extension preferences and scheduling configuration between browser profiles without exporting GitHub credentials.

## Behavior

- Export a versioned JSON settings file through the dashboard download flow.
- Include non-secret cloud preferences, provider selection, repository owner/name/branch/path, encryption preference, automatic retry preference, schedule settings, and retention settings.
- Never include the GitHub token, session password, backup data, pending artifact, scheduler history, or cloud runtime status.
- Import validates the version and field shapes before changing storage. Unsupported versions and malformed input leave all current settings unchanged.
- A successful import merges only supported settings into the existing cloud config and preserves the current GitHub token and unrelated runtime storage.
- The UI provides export and file-import controls with a clear success/error result.

## Constraints

- Keep settings data local; importing/exporting does not make network requests.
- Reuse config normalization and the browser Downloads API.
