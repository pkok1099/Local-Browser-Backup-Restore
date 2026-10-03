// Shared predicate: which per-URL crawl states count as "failed" for the
// dashboard's failure list and badge.
//
// A URL counts as failed while it is terminally failed OR while a retry is
// in flight after a failure. Retry waves flip the status back to 'fetching'
// (and a manual retry even starts from 'pending'), so filtering on
// 'fetch-failed' alone makes the list flicker mid-crawl and reappear at the
// end. The crawler preserves the last error on the state while retrying, so
// `error != null` marks "has failed and not yet succeeded".
export function isFailedUrl(u) {
  if (!u || typeof u !== 'object') return false;
  const hasError = u.error !== null && u.error !== undefined;
  return (
    u.status === 'fetch-failed' ||
    u.status === 'save-failed' ||
    ((u.status === 'fetching' || u.status === 'pending') && hasError)
  );
}

// A failed URL that is currently being retried (vs. terminally failed).
export function isRetryingUrl(u) {
  return (
    !!u && u.status === 'fetching' && u.error !== null && u.error !== undefined
  );
}
