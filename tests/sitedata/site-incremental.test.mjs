import assert from 'node:assert/strict';
import {
  readSiteDataCache,
  writeSiteDataCache,
  getVisitedOriginsSince,
  shouldForceFull,
  planIncrementalCrawl,
  mergeIncrementalOrigins,
  buildIncrementalNotes,
  computeIncrementalPlan,
  finalizeIncrementalRun,
  buildFullCachePayload,
} from '../../src/lib/site-incremental.js';
import { SITE_DATA_CONFIG } from '../../src/lib/scan-config.js';

const DAY = 24 * 3600 * 1000;
const NOW = 1_780_000_000_000; // fixed injected clock
const KEY = SITE_DATA_CONFIG.siteDataCacheKey;
const VERSION = SITE_DATA_CONFIG.siteDataCacheVersion;

function makeStorage(initial = {}, { throwOnSet = false } = {}) {
  const data = { ...initial };
  return {
    async get(k) {
      if (Array.isArray(k))
        return Object.fromEntries(k.map((x) => [x, data[x] ?? null]));
      return { [k]: data[k] ?? null };
    },
    async set(obj) {
      if (throwOnSet) throw new Error('quota exceeded');
      Object.assign(data, obj);
    },
    async remove(k) {
      delete data[k];
    },
    _data: data,
  };
}

function makeHistory(items, { shouldThrow = false } = {}) {
  return {
    lastQuery: null,
    async search(q) {
      if (shouldThrow) throw new Error('history unavailable');
      this.lastQuery = q;
      return items;
    },
  };
}

const snap = (n) => ({ localStorage: { [`k${n}`]: `v${n}` } });
const cacheOf = (origins, savedAt = NOW - DAY, lastFullAt = NOW - DAY) => ({
  version: VERSION,
  savedAt,
  lastFullAt,
  origins,
});

// 1. no cache -> full crawl
{
  const plan = await computeIncrementalPlan({
    storage: makeStorage(),
    history: makeHistory([]),
    nowMs: NOW,
    included: ['https://a.example', 'https://b.example'],
    config: SITE_DATA_CONFIG,
  });
  assert.equal(plan.fullCrawl, true);
  assert.equal(plan.reason, 'no-cache');
  assert.deepEqual(plan.crawlOrigins, [
    'https://a.example',
    'https://b.example',
  ]);
}

// 2. corrupt cache -> full crawl, no throw
{
  const bad = makeStorage({ [KEY]: 'not-an-object' });
  assert.equal(await readSiteDataCache(bad), null);
  const bad2 = makeStorage({ [KEY]: { version: VERSION } }); // missing origins
  assert.equal(await readSiteDataCache(bad2), null);
  const plan = await computeIncrementalPlan({
    storage: bad,
    history: makeHistory([]),
    nowMs: NOW,
    included: ['https://a.example'],
    config: SITE_DATA_CONFIG,
  });
  assert.equal(plan.fullCrawl, true);
  assert.equal(plan.reason, 'no-cache');
}

// 3. version mismatch -> treated as no cache
{
  const s = makeStorage({
    [KEY]: { ...cacheOf({ 'https://a.example': snap(1) }), version: 999 },
  });
  assert.equal(await readSiteDataCache(s), null);
  assert.equal(
    shouldForceFull({ cache: null, nowMs: NOW, fullIntervalMs: 7 * DAY }),
    'no-cache'
  );
}

// 4. 7-day safety valve boundary (clock injected)
{
  const iv = 7 * DAY;
  const mk = (lastFullAt) =>
    cacheOf({ 'https://a.example': snap(1) }, lastFullAt, lastFullAt);
  assert.equal(
    shouldForceFull({
      cache: mk(NOW - 8 * DAY),
      nowMs: NOW,
      fullIntervalMs: iv,
    }),
    'interval-elapsed'
  );
  assert.equal(
    shouldForceFull({
      cache: mk(NOW - 7 * DAY),
      nowMs: NOW,
      fullIntervalMs: iv,
    }),
    'interval-elapsed',
    'exactly 7 days forces full (>=)'
  );
  assert.equal(
    shouldForceFull({
      cache: mk(NOW - 7 * DAY + 1),
      nowMs: NOW,
      fullIntervalMs: iv,
    }),
    null,
    'just under 7 days stays incremental'
  );
  assert.equal(
    shouldForceFull({ cache: mk(NOW - DAY), nowMs: NOW, fullIntervalMs: iv }),
    null
  );
}

// 4b. clock skew: now before the snapshot -> full crawl, never a blind skip
{
  const skewed = cacheOf(
    { 'https://a.example': snap(1) },
    NOW + DAY,
    NOW - DAY
  );
  assert.equal(
    shouldForceFull({ cache: skewed, nowMs: NOW, fullIntervalMs: 7 * DAY }),
    'clock-skew'
  );
  const plan = await computeIncrementalPlan({
    storage: makeStorage({ [KEY]: skewed }),
    history: makeHistory([]),
    nowMs: NOW,
    included: ['https://a.example'],
    config: SITE_DATA_CONFIG,
  });
  assert.equal(plan.fullCrawl, true);
  assert.equal(plan.reason, 'clock-skew');
}
// 5. history.search throws -> full crawl
{
  const plan = await computeIncrementalPlan({
    storage: makeStorage({ [KEY]: cacheOf({ 'https://a.example': snap(1) }) }),
    history: makeHistory([], { shouldThrow: true }),
    nowMs: NOW,
    included: ['https://a.example'],
    config: SITE_DATA_CONFIG,
  });
  assert.equal(plan.fullCrawl, true);
  assert.equal(plan.reason, 'history-error');
}

// 6. history truncated (hit maxResults) -> full crawl
{
  const maxResults = 3;
  const items = Array.from({ length: maxResults }, (_, i) => ({
    url: `https://x${i}.example/`,
  }));
  const cfg = { ...SITE_DATA_CONFIG, historyMaxResults: maxResults };
  const plan = await computeIncrementalPlan({
    storage: makeStorage({ [KEY]: cacheOf({ 'https://a.example': snap(1) }) }),
    history: makeHistory(items),
    nowMs: NOW,
    included: ['https://a.example'],
    config: cfg,
  });
  assert.equal(plan.fullCrawl, true);
  assert.equal(plan.reason, 'history-truncated');
}

// 7. history null -> full crawl
{
  const plan = await computeIncrementalPlan({
    storage: makeStorage({ [KEY]: cacheOf({ 'https://a.example': snap(1) }) }),
    history: null,
    nowMs: NOW,
    included: ['https://a.example'],
    config: SITE_DATA_CONFIG,
  });
  assert.equal(plan.fullCrawl, true);
  assert.equal(plan.reason, 'history-unavailable');
}

// 8. subset visited -> crawl visited, reuse rest; query window starts at savedAt
{
  const savedAt = NOW - 2 * DAY;
  const history = makeHistory([
    { url: 'https://a.example/page1' },
    { url: 'https://a.example/page2' },
  ]);
  const plan = await computeIncrementalPlan({
    storage: makeStorage({
      [KEY]: cacheOf(
        {
          'https://a.example': snap(1),
          'https://b.example': snap(2),
          'https://c.example': snap(3),
        },
        savedAt
      ),
    }),
    history,
    nowMs: NOW,
    included: ['https://a.example', 'https://b.example', 'https://c.example'],
    config: SITE_DATA_CONFIG,
  });
  assert.equal(plan.fullCrawl, false);
  assert.deepEqual(plan.crawlOrigins, ['https://a.example']);
  assert.equal(
    history.lastQuery.startTime,
    savedAt,
    'history query must start at last snapshot'
  );
  assert.equal(history.lastQuery.text, '');
  const p = planIncrementalCrawl({
    included: ['https://a.example', 'https://b.example'],
    cachedOrigins: {
      'https://a.example': snap(1),
      'https://b.example': snap(2),
    },
    visited: new Set(['https://a.example']),
  });
  assert.deepEqual(p.crawl, ['https://a.example']);
  assert.deepEqual(p.reuse, ['https://b.example']);
}

// 9. never-cached origin is always crawled even if not visited
{
  const p = planIncrementalCrawl({
    included: ['https://a.example', 'https://new.example'],
    cachedOrigins: { 'https://a.example': snap(1) },
    visited: new Set(),
  });
  assert.deepEqual(p.crawl, ['https://new.example']);
  assert.deepEqual(p.reuse, ['https://a.example']);
}

// 10. origin removed from include -> dropped from merge AND from written cache
{
  const merged = mergeIncrementalOrigins({
    cachedOrigins: {
      'https://a.example': snap(1),
      'https://old.example': snap(9),
    },
    freshOrigins: { 'https://a.example': snap(2) },
    includedSet: new Set(['https://a.example', 'https://b.example']),
  });
  assert.deepEqual(Object.keys(merged), ['https://a.example']);
  const fin = finalizeIncrementalRun({
    cache: cacheOf({
      'https://a.example': snap(1),
      'https://old.example': snap(9),
    }),
    freshOrigins: { 'https://a.example': snap(2) },
    included: ['https://a.example', 'https://b.example'],
    stopped: false,
    categoryOk: true,
    fullCrawl: false,
    nowMs: NOW,
  });
  assert.deepEqual(
    Object.keys(fin.cachePayload.origins),
    ['https://a.example'],
    'pruned from written cache so it cannot bloat'
  );
}

// 11. legitimate empty fresh snapshot wins over cache
{
  const merged = mergeIncrementalOrigins({
    cachedOrigins: { 'https://a.example': snap(1) },
    freshOrigins: { 'https://a.example': { localStorage: {} } },
    includedSet: new Set(['https://a.example']),
  });
  assert.deepEqual(merged['https://a.example'], { localStorage: {} });
}

// 12. failed crawl (no fresh snapshot) -> cache reused (last-known-good)
{
  const merged = mergeIncrementalOrigins({
    cachedOrigins: {
      'https://a.example': snap(1),
      'https://b.example': snap(2),
    },
    freshOrigins: { 'https://a.example': snap(10) },
    includedSet: new Set(['https://a.example', 'https://b.example']),
  });
  assert.deepEqual(merged['https://b.example'], snap(2));
  assert.deepEqual(merged['https://a.example'], snap(10));
}

// 13. stopped mid-crawl -> section merged (complete) but cache NOT overwritten
{
  const cache = cacheOf({
    'https://a.example': snap(1),
    'https://b.example': snap(2),
  });
  const fin = finalizeIncrementalRun({
    cache,
    freshOrigins: { 'https://a.example': snap(10) },
    included: ['https://a.example', 'https://b.example'],
    stopped: true,
    categoryOk: true,
    fullCrawl: false,
    nowMs: NOW,
  });
  assert.equal(
    fin.cachePayload,
    null,
    'old cache must survive a stopped crawl'
  );
  assert.deepEqual(
    Object.keys(fin.origins).sort(),
    ['https://a.example', 'https://b.example'],
    'section stays complete via merge'
  );
  assert.ok(
    fin.notes.some((n) => /stop/i.test(n)),
    'notes must disclose the stop'
  );
  const fin2 = finalizeIncrementalRun({
    cache,
    freshOrigins: {},
    included: ['https://a.example'],
    stopped: false,
    categoryOk: false,
    fullCrawl: false,
    nowMs: NOW,
  });
  assert.equal(
    fin2.cachePayload,
    null,
    'failed category must not advance the cache'
  );
}

// 14. write failure -> false, never throws
{
  const s = makeStorage({}, { throwOnSet: true });
  assert.equal(await writeSiteDataCache(s, cacheOf({})), false);
}

// 15. read/write round-trip
{
  const s = makeStorage();
  const payload = cacheOf(
    { 'https://a.example': snap(1) },
    NOW - 3 * DAY,
    NOW - 3 * DAY
  );
  assert.equal(await writeSiteDataCache(s, payload), true);
  assert.deepEqual(await readSiteDataCache(s), payload);
}

// 16. empty include list -> no-op
{
  const plan = await computeIncrementalPlan({
    storage: makeStorage({ [KEY]: cacheOf({ 'https://a.example': snap(1) }) }),
    history: makeHistory([]),
    nowMs: NOW,
    included: [],
    config: SITE_DATA_CONFIG,
  });
  assert.deepEqual(plan.crawlOrigins, []);
  assert.equal(plan.fullCrawl, false);
  assert.equal(plan.reason, 'empty-include');
}

// notes transparency
{
  const notes = buildIncrementalNotes({
    crawled: 3,
    total: 42,
    reused: 39,
    dateStr: '2026-10-02',
    fullReason: null,
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /3\/42/);
  assert.match(notes[0], /39.*reused from cache/);
  const fullNotes = buildIncrementalNotes({
    crawled: 42,
    total: 42,
    reused: 0,
    dateStr: '',
    fullReason: 'interval-elapsed',
  });
  assert.match(fullNotes[0], /full crawl.*interval-elapsed/);
}

// buildFullCachePayload (manual full runs refresh the cache, pruned to include-set)
{
  const payload = buildFullCachePayload({
    freshOrigins: {
      'https://a.example': snap(1),
      'https://b.example': snap(2),
    },
    included: ['https://a.example'],
    nowMs: NOW,
  });
  assert.equal(payload.version, VERSION);
  assert.equal(payload.savedAt, NOW);
  assert.equal(payload.lastFullAt, NOW);
  assert.deepEqual(Object.keys(payload.origins), ['https://a.example']);
  const payload2 = buildFullCachePayload({
    freshOrigins: { 'https://a.example': snap(1) },
    included: null,
    nowMs: NOW,
  });
  assert.deepEqual(
    Object.keys(payload2.origins),
    ['https://a.example'],
    'null include keeps everything'
  );
}

// getVisitedOriginsSince maps urls to origins, dedupes, drops non-web
{
  const history = makeHistory([
    { url: 'https://a.example/1' },
    { url: 'https://a.example/2' },
    { url: 'chrome://settings' },
    { url: 'https://b.example/' },
  ]);
  const { visited, truncated } = await getVisitedOriginsSince({
    history,
    sinceMs: 1,
    nowMs: 2,
    maxResults: 50000,
  });
  assert.equal(truncated, false);
  assert.deepEqual([...visited].sort(), [
    'https://a.example',
    'https://b.example',
  ]);
}

// exclusion: excludeOrigins and built-in host blocklist never resurrect
{
  const plan = await computeIncrementalPlan({
    storage: makeStorage({
      [KEY]: cacheOf({
        'https://a.example': snap(1),
        'https://b.example': snap(2),
      }),
    }),
    history: makeHistory([]),
    nowMs: NOW,
    included: [
      'https://a.example',
      'https://b.example',
      'https://localhost:3000',
    ],
    excludeOrigins: ['https://b.example'],
    config: SITE_DATA_CONFIG,
  });
  assert.deepEqual(plan.eligibleOrigins, ['https://a.example']);
  assert.ok(
    !plan.crawlOrigins.includes('https://b.example'),
    'excluded origin must not be crawled'
  );
  assert.ok(
    !plan.crawlOrigins.includes('https://localhost:3000'),
    'blocked host must not be crawled'
  );
  const fin = finalizeIncrementalRun({
    cache: cacheOf({
      'https://a.example': snap(1),
      'https://b.example': snap(2),
    }),
    freshOrigins: {},
    included: plan.eligibleOrigins,
    stopped: false,
    categoryOk: true,
    fullCrawl: true,
    fullReason: 'no-cache',
    nowMs: NOW,
  });
  assert.deepEqual(
    Object.keys(fin.origins),
    ['https://a.example'],
    'eligible origin reused from cache (last-known-good)'
  );
  assert.deepEqual(
    Object.keys(fin.cachePayload.origins),
    ['https://a.example'],
    'excluded/blocked origins pruned from written cache'
  );
}

console.log('PASS site-incremental: history-gated planning, merge and cache');
