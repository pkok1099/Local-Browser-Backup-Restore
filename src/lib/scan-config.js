// Central tuning object for the site-data crawler: every tunable
// constant lives here, in one place. Imported by the pipeline
// (sitedata.js) and by the safety/concurrency primitives that need
// it — a pure data module, so it can never create an import cycle.

// Single tuning object for the site-data crawler (point 4: all constants in
// one place). The UI window setting is the UPPER BOUND for the effective
// window — the adaptive logic below never overwrites it.
export const SITE_DATA_CONFIG = {
  window: { default: 20, min: 2, max: 50 },
  // Bounded parallelism for debugger reads: chrome.debugger attaches per
  // tab, so concurrent reads are safe; 4 keeps CPU/memory bounded (reads are
  // the CPU-heavy phase, and 4 proved stable).
  readConcurrency: 4,
  tabLoadTimeoutMs: 20000,
  checkpointKey: 'bbr:site-data-checkpoint',
  checkpointEveryOrigins: 10,
  // Incremental site-data (history-gated): the key holding the last complete
  // snapshot, its schema version (bumped when the payload shape changes), how
  // long a snapshot stays eligible for incremental reuse before a forced full
  // crawl, and the history query page size (hitting it forces a full crawl).
  siteDataCacheKey: 'bbr:site-data-cache',
  siteDataCacheVersion: 1,
  incrementalFullIntervalMs: 7 * 24 * 3600 * 1000,
  historyMaxResults: 50000,
  // URLs never crawled: not opened, no debugger attach, no data captured.
  // Matched on the parsed hostname (new URL()), never on URL substrings, so
  // https://contoh.com/?q=localhost is NOT blocked. Applies to http/https on
  // any port, to new URLs and to pre-existing tabs (those are skipped, never
  // touched). Non-web schemes are excluded because the debugger cannot run
  // there at all.
  excluded: {
    hosts: ['localhost', '127.0.0.1', 'chromewebstore.google.com'],
    hostSuffixes: ['.localhost'], // *.localhost
    hostPrefixes: ['192.'], // 192.x.x.x
    schemes: [
      'chrome:',
      'chrome-extension:',
      'file:',
      'about:',
      'data:',
      'javascript:',
    ],
  },
  cpu: {
    sampleMs: 1000,
    highPct: 95, // "100%" treated as >= 95% (exact 100 is rare)
    highMs: 10000, // sustained >10s -> halve the window, then reset the count
    lowPct: 70,
    lowSamples: 15, // ~15s of low CPU -> grow back
    floor: 2, // halving never goes below 2
  },
  // Early load signal (before the CPU pegs): tab load time and timeout rate
  // over a sliding window of the last N OWNED tabs. Either the CPU guard or
  // the load guard may shrink the window (fast down); it grows back slowly
  // (+2) only when BOTH signals are healthy (slow up, no oscillation).
  load: {
    windowSize: 20, // sliding window: last N owned tabs
    minSamples: 5, // don't react before this many samples
    timeoutRateHigh: 0.3, // >30% timeouts -> shrink
    timeoutRateRecovered: 0.15,
    avgMsHigh: 8000, // avg load >8s -> shrink
    avgMsRecovered: 4000,
    shrinkCooldownMs: 10000, // min time between load-triggered shrinks
  },
  // Per-URL fetch retry (separate from the storage retry below). A retry
  // always closes the old tab FIRST (in finally) before opening a new one —
  // tabs never pile up.
  retry: {
    maxAttempts: 3, // total attempts per origin (1 initial + 2 retries)
    readTimeoutMs: 60000, // a read that never returns is abandoned, not hung
    backoffBaseMs: 1000, // wait between retry waves (exponential)
    backoffMaxMs: 15000,
  },
  // Clean stop: STOPPING phase gives in-flight Worker 2 reads a grace period
  // before force-halt; cleanup is verified with retries.
  stop: {
    graceMs: 5000, // Worker 2 in-flight tasks may finish within this
    verifyRetries: 3, // cleanup verification attempts
    verifyDelayMs: 1000, // delay between verification retries
    ownedTabsKey: 'bbr:site-data-owned-tabs', // persisted owned tab IDs for crash recovery
  },
  // Storage retry queue (checkpoint persistence), SEPARATE from fetch retry.
  // Unsaved data stays in memory (originsOut) until a write succeeds.
  // Quota-full is never blindly retried: the crawl stops safely instead.
  storage: {
    backoffBaseMs: 1000,
    backoffMaxMs: 30000,
    maxAttempts: 5,
  },
};
