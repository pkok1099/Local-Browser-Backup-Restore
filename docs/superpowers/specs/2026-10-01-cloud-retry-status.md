# Cloud retry status

## Goal

Make pending automatic cloud retry state understandable in the dashboard and allow the user to cancel scheduled retries or manually retry immediately.

## Behavior

- When an upload is pending, display its artifact ID, completed retry count, retry limit, and next retry time; indicate when retry is exhausted or automatic retry is disabled.
- Show a cancel-retries action only when an automatic retry is pending. Cancel clears its alarm and retry scheduling metadata but keeps the pending artifact available for manual sync.
- Keep the existing manual sync action; clicking it remains an immediate attempt and resets the automatic retry counter.
- Status values come from the existing pending artifact/config data; no duplicate persistent state is introduced.
- If no upload is pending, hide the retry details and actions.

## Constraints

- Preserve the pending artifact until upload succeeds or the user explicitly discards it through a separately confirmed future feature.
- Never show token, backup contents, or sensitive browser data in retry status.
