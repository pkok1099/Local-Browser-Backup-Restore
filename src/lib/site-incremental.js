// Incremental site-data for scheduled backups: history-gated crawl planning,
// last-complete-snapshot cache, and merge.
//
// A scheduled run re-crawls only origins visited since the last snapshot —
// cheap, one chrome.history.search, no page loads. Unvisited origins are
// reused from the cache, so every artifact stays a COMPLETE snapshot and
// restore is unchanged.
//
// Fail-safe rule: any doubt -> full crawl, never a blind skip.
//
// All decisions live here (dependency-injected, node-testable); the dashboard
// glue in logic.ts stays dumb and only applies the results.
import { SITE_DATA_CONFIG } from './scan-config.js';
import { originOf } from './tab-ownership.js';
import { isExcluded } from './sitedata.js';

const CACHE_KEY = SITE_DATA_CONFIG.siteDataCacheKey;
const CACHE_VERSION = SITE_DATA_CONFIG.siteDataCacheVersion;

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);
// originOf returns the string "null" for non-special schemes (chrome://…);
// only real web origins can carry site data worth caching.
const isWebOrigin = (o) => typeof o === 'string' && /^https?:\/\//.test(o);

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

// Best-effort read: null on missing storage, corrupt payload, or version
// mismatch (a future format never gets misread as current).
export async function readSiteDataCache(storage) {
  try {
    if (!storage || typeof storage.get !== 'function') return null;
    const raw = await storage.get(CACHE_KEY);
    const payload = raw ? raw[CACHE_KEY] : null;
    if (!isRecord(payload)) return null;
    if (payload.version !== CACHE_VERSION) return null;
    if (!isRecord(payload.origins)) return null;
    if (
      !Number.isFinite(payload.savedAt) ||
      !Number.isFinite(payload.lastFullAt)
    )
      return null;
    return payload;
  } catch {
    return null;
  }
}

// Best-effort write: returns false (never throws) so a cache failure can
// never fail the backup itself.
export async function writeSiteDataCache(storage, payload) {
  try {
    if (!storage || typeof storage.set !== 'function') return false;
    await storage.set({ [CACHE_KEY]: payload });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// history signal
// ---------------------------------------------------------------------------

// One query answering "which web origins were visited since sinceMs".
// truncated=true means the result hit maxResults and may be incomplete —
// the caller must treat that as "unknown" and full-crawl.
export async function getVisitedOriginsSince({
  history,
  sinceMs,
  nowMs,
  maxResults,
}) {
  if (!history || typeof history.search !== 'function')
    throw new Error('history-unavailable');
  // A missing maxResults must not silently disable truncation detection
  // (that would turn an incomplete answer into a blind skip).
  const max = Number.isFinite(maxResults)
    ? maxResults
    : SITE_DATA_CONFIG.historyMaxResults;
  const items = await history.search({
    text: '',
    startTime: sinceMs,
    endTime: nowMs,
    maxResults: max,
  });
  const list = Array.isArray(items) ? items : [];
  const visited = new Set();
  for (const item of list) {
    const o = originOf(item && item.url);
    if (isWebOrigin(o)) visited.add(o);
  }
  return { visited, truncated: list.length >= max };
}

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

// null = go incremental; otherwise the reason a full crawl is required.
export function shouldForceFull({ cache, nowMs, fullIntervalMs }) {
  if (!cache) return 'no-cache';
  if (!Number.isFinite(cache.lastFullAt)) return 'no-cache';
  // Clock skew: the wall clock moved backwards past our last snapshot. The
  // history query would then get startTime > endTime (empty result → a silent
  // full skip), and the future-dated savedAt would make every later run skip
  // too. Force a full crawl instead — the safe direction.
  if (nowMs < cache.savedAt) return 'clock-skew';
  // >= : exactly at the interval counts as due (safe direction — a full
  // crawl a moment early is harmless, a stale heuristic is not).
  return nowMs - cache.lastFullAt >= fullIntervalMs ? 'interval-elapsed' : null;
}

// Pure split: crawl what was visited OR never cached; reuse the rest.
export function planIncrementalCrawl({ included, cachedOrigins, visited }) {
  const cached = isRecord(cachedOrigins) ? cachedOrigins : {};
  const seen = visited instanceof Set ? visited : new Set();
  const crawl = [];
  const reuse = [];
  for (const origin of included || []) {
    if (seen.has(origin) || !Object.hasOwn(cached, origin)) crawl.push(origin);
    else reuse.push(origin);
  }
  return { crawl, reuse };
}

export async function computeIncrementalPlan({
  storage,
  history,
  nowMs,
  included,
  excludeOrigins,
  config,
}) {
  const list = Array.isArray(included) ? included : [];
  // Eligibility: the merge must never resurrect an origin the crawler refuses
  // to touch — neither API-level excludeOrigins nor the built-in host block
  // list (localhost, chromewebstore, …). The crawl itself re-applies these
  // downstream; this keeps the merge set honest even if a caller passes them.
  const excluded = new Set(Array.isArray(excludeOrigins) ? excludeOrigins : []);
  const eligible = list.filter(
    (o) => !excluded.has(o) && !isExcluded(o).excluded
  );
  if (!eligible.length)
    return {
      crawlOrigins: [],
      eligibleOrigins: [],
      cache: null,
      fullCrawl: false,
      reason: 'empty-include',
    };
  const cache = await readSiteDataCache(storage);
  const forceReason = shouldForceFull({
    cache,
    nowMs,
    fullIntervalMs: config.incrementalFullIntervalMs,
  });
  if (forceReason)
    return {
      crawlOrigins: eligible,
      eligibleOrigins: eligible,
      cache,
      fullCrawl: true,
      reason: forceReason,
    };
  try {
    const { visited, truncated } = await getVisitedOriginsSince({
      history,
      sinceMs: cache.savedAt,
      nowMs,
      maxResults: config.historyMaxResults,
    });
    if (truncated)
      return {
        crawlOrigins: eligible,
        eligibleOrigins: eligible,
        cache,
        fullCrawl: true,
        reason: 'history-truncated',
      };
    const { crawl } = planIncrementalCrawl({
      included: eligible,
      cachedOrigins: cache.origins,
      visited,
    });
    return {
      crawlOrigins: crawl,
      eligibleOrigins: eligible,
      cache,
      fullCrawl: false,
      reason: null,
    };
  } catch (e) {
    const reason =
      e?.message === 'history-unavailable'
        ? 'history-unavailable'
        : 'history-error';
    return {
      crawlOrigins: eligible,
      eligibleOrigins: eligible,
      cache,
      fullCrawl: true,
      reason,
    };
  }
}

// ---------------------------------------------------------------------------
// merge + finalize (pure)
// ---------------------------------------------------------------------------

// Fresh wins — including a legitimately EMPTY snapshot (the site really has
// no data; that must not resurrect stale cache). No fresh snapshot (failed
// crawl) -> last-known-good from cache. Anything outside includedSet is
// dropped, so it never reaches the merge NOR the written cache.
export function mergeIncrementalOrigins({
  cachedOrigins,
  freshOrigins,
  includedSet,
}) {
  const cached = isRecord(cachedOrigins) ? cachedOrigins : {};
  const fresh = isRecord(freshOrigins) ? freshOrigins : {};
  const set = includedSet instanceof Set ? includedSet : new Set();
  const merged = {};
  for (const origin of set) {
    if (Object.hasOwn(fresh, origin)) merged[origin] = fresh[origin];
    else if (Object.hasOwn(cached, origin)) merged[origin] = cached[origin];
  }
  return merged;
}

export function buildIncrementalNotes({
  crawled,
  total,
  reused,
  dateStr,
  fullReason,
}) {
  if (fullReason)
    return [`sitedata: full crawl of ${total} origin(s) (${fullReason})`];
  return [
    `sitedata incremental: ${crawled}/${total} origin(s) re-crawled ` +
      `(visited since ${dateStr}); ${reused} reused from cache (${dateStr})`,
  ];
}

// Decides the section content AND whether the cache may advance.
// The section is always merged (complete) — even when stopped — but the
// cache only advances on a clean, successful run: a stopped or failed run
// must never mark partial/stale data as fresh.
export function finalizeIncrementalRun({
  cache,
  freshOrigins,
  included,
  stopped,
  categoryOk,
  fullCrawl,
  fullReason,
  nowMs,
}) {
  const includedSet = new Set(Array.isArray(included) ? included : []);
  const fresh = isRecord(freshOrigins) ? freshOrigins : {};
  const cached = cache && isRecord(cache.origins) ? cache.origins : {};
  const origins = mergeIncrementalOrigins({
    cachedOrigins: cached,
    freshOrigins: fresh,
    includedSet,
  });
  const total = includedSet.size;
  const crawled = [...includedSet].filter((o) =>
    Object.hasOwn(fresh, o)
  ).length;
  const reused = [...includedSet].filter(
    (o) => !Object.hasOwn(fresh, o) && Object.hasOwn(cached, o)
  ).length;
  const dateStr =
    cache && Number.isFinite(cache.savedAt) ? fmtDate(cache.savedAt) : 'n/a';
  const notes = buildIncrementalNotes({
    crawled,
    total,
    reused,
    dateStr,
    fullReason: fullCrawl ? fullReason || 'full-crawl' : null,
  });
  if (!categoryOk) {
    notes.push('sitedata incremental: category failed — cache not updated');
    return { origins, notes, cachePayload: null };
  }
  if (stopped) {
    notes.push(
      'sitedata incremental: stopped before completion — cache not updated; ' +
        'section merged from partial crawl + cache'
    );
    return { origins, notes, cachePayload: null };
  }
  return {
    origins,
    notes,
    cachePayload: {
      version: CACHE_VERSION,
      savedAt: nowMs,
      lastFullAt:
        fullCrawl || !Number.isFinite(cache && cache.lastFullAt)
          ? nowMs
          : cache.lastFullAt,
      origins,
    },
  };
}

// A full run (manual backup, or a forced-full scheduled run) refreshes the
// cache wholesale, pruned to the run's include-set (null = everything).
export function buildFullCachePayload({ freshOrigins, included, nowMs }) {
  const fresh = isRecord(freshOrigins) ? freshOrigins : {};
  const origins = {};
  if (Array.isArray(included)) {
    const set = new Set(included);
    for (const [o, s] of Object.entries(fresh)) if (set.has(o)) origins[o] = s;
  } else {
    Object.assign(origins, fresh);
  }
  return {
    version: CACHE_VERSION,
    savedAt: nowMs,
    lastFullAt: nowMs,
    origins,
  };
}
