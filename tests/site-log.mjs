// Unit test for the centralized site-data logger (src/lib/site-log.js).
import assert from 'node:assert/strict';

const { createSiteLogger, LOG_LEVELS, LOG_CATEGORIES, formatLogTs } = await import('../src/lib/site-log.js');

// Levels and categories are fixed.
assert.deepEqual(Object.keys(LOG_LEVELS), ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL']);
assert.ok(LOG_CATEGORIES.includes('W1') && LOG_CATEGORIES.includes('W2'));
assert.ok(LOG_CATEGORIES.includes('STORAGE') && LOG_CATEGORIES.includes('SAFETY'));
assert.ok(LOG_CATEGORIES.includes('RETRY') && LOG_CATEGORIES.includes('SYSTEM'));
assert.ok(LOG_CATEGORIES.includes('CPU') && LOG_CATEGORIES.includes('LOAD'));

// Basic logging: entry shape, ms timestamp, counts, invalid level/category fallback.
{
  const seen = [];
  const logger = createSiteLogger({ crawlId: 'test-1', onEntry: (e) => seen.push(e) });
  const e1 = logger.info('W1', 'tab opened', { url: 'http://x.com/', tabId: 5, attempt: 1 });
  assert.equal(e1.level, 'INFO');
  assert.equal(e1.category, 'W1');
  assert.equal(e1.message, 'tab opened');
  assert.equal(e1.crawlId, 'test-1');
  assert.equal(e1.url, 'http://x.com/');
  assert.equal(e1.corr, null);
  assert.deepEqual(e1.context, { tabId: 5, attempt: 1 });
  assert.ok(typeof e1.ts === 'number' && e1.ts > 0, 'ms timestamp required');
  assert.equal(logger.counts.INFO, 1);

  const e2 = logger.log('NOPE', 'BOGUS', 'fallback', { corr: 'c1', url: 'http://y.com/' });
  assert.equal(e2.level, 'INFO', 'invalid level falls back to INFO');
  assert.equal(e2.category, 'SYSTEM', 'invalid category falls back to SYSTEM');
  assert.equal(e2.corr, 'c1');
  assert.equal(seen.length, 2, 'onEntry sink receives every entry');

  logger.warn('RETRY', 'retrying', {});
  logger.error('W2', 'read failed', { error: 'denied' });
  logger.fatal('SAFETY', 'aborted', {});
  assert.equal(logger.isUnseenError(), true, 'ERROR/FATAL sets unseen flag');
  logger.markSeen();
  assert.equal(logger.isUnseenError(), false);
  assert.deepEqual(logger.counts, { DEBUG: 0, INFO: 2, WARN: 1, ERROR: 1, FATAL: 1 });
  await logger.flush(); // must not throw without IndexedDB
  console.log('PASS site-log: entry shape, levels, categories, counts, unseen flag');
}

// Shorthands exist for every level.
{
  const logger = createSiteLogger({ crawlId: 'test-2' });
  for (const lvl of ['debug', 'info', 'warn', 'error', 'fatal']) {
    assert.equal(typeof logger[lvl], 'function', `logger.${lvl} must exist`);
    logger[lvl]('SYSTEM', `msg ${lvl}`, {});
  }
  assert.equal(logger.counts.DEBUG, 1);
  assert.equal(logger.counts.FATAL, 1);
  console.log('PASS site-log: level shorthands');
}

// Timestamp formatting includes milliseconds.
{
  const s = formatLogTs(new Date('2026-10-02T14:32:05.123Z').getTime());
  assert.match(s, /^\d{2}:\d{2}:\d{2}\.\d{3}$/, `ms timestamp format, got: ${s}`);
  console.log('PASS site-log: ms timestamp format');
}

console.log('PASS site-log module: centralized levels, categories, batching');

// Integration: collectSiteData emits structured logs via opts.onLogEntry.
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let nextId = 100;
  const tabsById = new Map();
  const bookmarks = [{ url: 'http://example0.com/', children: [] }];
  const chrome = {
    tabs: {
      query: async () => [...tabsById.values()],
      create: async ({ url }) => { const t = { id: nextId++, url, status: 'loading', windowId: 7, groupId: -1, createdAt: Date.now() }; tabsById.set(t.id, t); return t; },
      get: async (id) => { const t = tabsById.get(id); if (!t) throw new Error('gone'); return { ...t, status: 'complete' }; },
      remove: async (id) => { tabsById.delete(id); },
      ungroup: async () => {}, group: async () => 42,
    },
    tabGroups: { update: async () => ({}), get: async (id) => ({ id, title: 'x' }) },
    debugger: {
      attach: (t, v, cb) => { chrome.runtime.lastError = { message: 'denied' }; setTimeout(cb, 0); },
      detach: (t, cb) => { chrome.runtime.lastError = undefined; setTimeout(cb, 0); },
      sendCommand: (d, m, p, cb) => { chrome.runtime.lastError = { message: 'denied' }; setTimeout(() => cb(undefined), 0); },
    },
    history: { search: async () => [], deleteUrl: async () => {} },
    bookmarks: { getTree: async () => [{ children: bookmarks }] },
    cookies: { getAllCookieStores: async () => [] },
    scripting: { executeScript: async () => [] },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    runtime: { getURL: (p) => p, lastError: undefined },
  };
  globalThis.chrome = chrome;
  globalThis.fetch = async () => ({ text: async () => 'globalThis.__BBR = {};' });
  const { collectSiteData } = await import('../src/lib/sitedata.js');
  const entries = [];
  const section = await collectSiteData(() => {}, {
    scanWindowSize: 2, retryMaxAttempts: 1, onLogEntry: (e) => entries.push(e),
  });
  assert.ok(entries.length > 0, 'crawl must emit log entries');
  const levels = new Set(entries.map((e) => e.level));
  const cats = new Set(entries.map((e) => e.category));
  assert.ok(levels.has('INFO'), 'INFO entries expected, got: ' + [...levels]);
  assert.ok(levels.has('ERROR') || levels.has('WARN'), 'WARN/ERROR expected for failed reads');
  assert.ok(cats.has('W1') && cats.has('W2'), 'W1/W2 categories expected, got: ' + [...cats]);
  assert.ok(cats.has('SYSTEM'), 'SYSTEM category expected');
  assert.ok(entries.every((e) => e.crawlId && e.ts && e.message), 'every entry needs crawlId, ts, message');
  assert.ok(entries.some((e) => e.url === 'http://example0.com'), 'per-URL correlation expected, got urls: ' + JSON.stringify([...new Set(entries.map((e) => e.url))]));
  // Live stats carry the log counts + crawl state for the status bar.
  let lastStats = null;
  await collectSiteData((m, f, st) => { if (st) lastStats = st; }, {
    scanWindowSize: 2, retryMaxAttempts: 1, onLogEntry: () => {},
  });
  assert.ok(lastStats.logCounts && typeof lastStats.logCounts.INFO === 'number', 'stats must carry logCounts');
  assert.ok(['running', 'done', 'stopped', 'fatal'].includes(lastStats.crawlState), 'stats must carry crawlState, got: ' + lastStats.crawlState);
  assert.ok(typeof lastStats.worker1 === 'string' && typeof lastStats.worker2 === 'string', 'stats must carry worker activity');
  console.log(`PASS site-log integration: ${entries.length} entries, levels=[${[...levels]}], categories=[${[...cats]}]`);
}
