// Truth table for the failure-list predicate.
// Regression: retry waves flip the status back to 'fetching' (a manual retry
// even starts from 'pending'), so filtering on 'fetch-failed' alone made the
// Kegagalan list flicker mid-crawl and reappear at the end.
import assert from 'node:assert/strict';
import { isFailedUrl, isRetryingUrl } from '../../src/lib/url-status.js';

const u = (status, error = null, attempts = 1) => ({
  origin: 'https://example.com',
  status,
  attempts,
  error,
});

let n = 0;
const check = (actual, expected, label) => {
  n++;
  assert.equal(actual, expected, label);
};

// Terminal failures always count.
check(isFailedUrl(u('fetch-failed', 'boom')), true, 'fetch-failed counts');
check(isFailedUrl(u('save-failed', 'boom')), true, 'save-failed counts');

// A retry in flight after a failure still counts (error is preserved while
// retrying) — this is the flicker fix.
check(
  isFailedUrl(u('fetching', 'boom', 2)),
  true,
  'fetching with error (retry) counts'
);
check(
  isFailedUrl(u('pending', 'boom', 1)),
  true,
  'pending with error (manual retry not started yet) counts'
);

// First attempt in flight: never failed, must not count.
check(
  isFailedUrl(u('fetching', null, 1)),
  false,
  'fetching without error (first attempt) does not count'
);
check(
  isFailedUrl(u('pending', null, 0)),
  false,
  'pending without error does not count'
);

// Success / neutral states never count, even with attempts.
check(isFailedUrl(u('saved', null, 3)), false, 'saved does not count');
check(isFailedUrl(u('fetched', null, 2)), false, 'fetched does not count');
check(
  isFailedUrl(u('skipped', 'excluded', 1)),
  false,
  'skipped does not count'
);

// isRetryingUrl: only the in-flight retry, not terminal failures.
check(
  isRetryingUrl(u('fetching', 'boom', 2)),
  true,
  'fetching with error is retrying'
);
check(
  isRetryingUrl(u('fetch-failed', 'boom', 3)),
  false,
  'fetch-failed is not retrying'
);
check(
  isRetryingUrl(u('fetching', null, 1)),
  false,
  'first attempt is not retrying'
);
check(isRetryingUrl(u('pending', 'boom', 1)), false, 'pending is not retrying');
check(isRetryingUrl(null), false, 'null is not retrying');
check(isFailedUrl(null), false, 'null is not failed');
check(isFailedUrl(undefined), false, 'undefined is not failed');

console.log(`PASS url-status (${n} assertions)`);
