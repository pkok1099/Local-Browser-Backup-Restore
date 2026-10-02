# Weekly backup schedule

## Goal

Let the user choose one or more weekdays and a local time for scheduled GitHub backups while preserving daily schedules saved by earlier versions.

## Behavior

- Schedule frequency supports `daily` and `weekly`; legacy or missing frequency normalizes to `daily`.
- Weekly schedule stores selected weekdays as integers using JavaScript's local convention: Sunday `0` through Saturday `6`.
- Missing, invalid, or empty weekly day selections normalize safely to Monday-Friday (`[1, 2, 3, 4, 5]`). Values are deduplicated and sorted.
- A due run may start only on a selected day at or after the configured local hour/minute, unless today's slot already succeeded or an attempt is inside the existing retry backoff.
- On a non-selected day, the scheduler waits for the next selected day; missed days do not cause multiple catch-up runs.
- Existing once-per-day success and attempt-backoff rules continue to apply on selected days.
- Dashboard provides daily/weekly selection and weekday checkboxes, and hides/disables weekday controls for daily frequency.

## Constraints

- Keep the 15-minute alarm and dashboard-tab execution model.
- Do not change backup artifact format or cloud provider behavior.
- The pure schedule decision remains testable in Node without Chrome APIs.
