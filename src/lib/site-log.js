// Centralized site-data crawl logging.
//
// ONE function for all crawl logs: log(level, category, message, context).
// No console.log and no ad-hoc log strings anywhere else in the crawl path.
//
// Levels: DEBUG (hidden by default) < INFO < WARN < ERROR < FATAL.
// Categories: W1 (open tab/group), W2 (read data/close tab), STORAGE (persist
// + save retry), CPU / LOAD (load monitoring + window changes), SAFETY (close
// refusals, limit violations), RETRY, SYSTEM (start/stop/resume/final sweep).
//
// Every entry: ms timestamp, level, category, human message, structured
// context (url, tabId, groupId, retry attempt, durationMs, original error,
// effective window...). Errors keep the ORIGINAL Chrome/CDP message.
//
// Persistence: entries are buffered and written to IndexedDB in batches so
// logging never waits on entry writes in the pipeline. A small metadata
// transaction reserves each entry's global order; failed log writes never stop the
// crawl. Size is capped (default 5000): oldest DEBUG/INFO are trimmed first,
// ERROR/WARN/FATAL are kept longest. Survives dashboard close/crash and is
// visible on resume.

export const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
};

export const LOG_LEVEL_NAMES = Object.keys(LOG_LEVELS);

export const LOG_CATEGORIES = ['W1', 'W2', 'STORAGE', 'CPU', 'LOAD', 'SAFETY', 'RETRY', 'SYSTEM'];

const DB_NAME = 'bbr-site-log';
const DB_STORE = 'entries-v2';
const LEGACY_DB_STORE = 'entries';
const DB_META_STORE = 'metadata';
const NEXT_SEQUENCE_KEY = 'nextSequence';
const CLEAR_WATERMARK_KEY = 'clearWatermark';
const DB_VERSION = 3;
const SITE_LOG_ORDER_LOCK = 'bbr:site-log-order';
let pendingClear = Promise.resolve();

function openDb() {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        const tx = req.transaction;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          const store = db.createObjectStore(DB_STORE, { keyPath: 'id' });
          store.createIndex('ts', 'ts', { unique: false });
          store.createIndex('level', 'level', { unique: false });
          store.createIndex('category', 'category', { unique: false });
          store.createIndex('corr', 'corr', { unique: false });
          store.createIndex('crawlId', 'crawlId', { unique: false });
          if (db.objectStoreNames.contains(LEGACY_DB_STORE)) {
            const abortUpgrade = () => {
              try {
                tx.abort();
              } catch (e) {
                /* transaction is already aborting */
              }
            };
            let cursorRequest;
            try {
              cursorRequest = tx.objectStore(LEGACY_DB_STORE).openCursor();
            } catch (e) {
              abortUpgrade();
              return;
            }
            cursorRequest.onerror = abortUpgrade;
            cursorRequest.onsuccess = () => {
              try {
                const cursor = cursorRequest.result;
                if (!cursor) return;
                const addRequest = store.add({ ...cursor.value, id: `legacy:${cursor.primaryKey}` });
                addRequest.onerror = abortUpgrade;
                cursor.continue();
              } catch (e) {
                abortUpgrade();
              }
            };
          }
        }
        if (!db.objectStoreNames.contains(DB_META_STORE)) {
          const metadata = db.createObjectStore(DB_META_STORE, { keyPath: 'key' });
          metadata.put({ key: NEXT_SEQUENCE_KEY, value: 0 });
          metadata.put({ key: CLEAR_WATERMARK_KEY, value: 0 });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // log persistence is best-effort
    } catch (e) {
      resolve(null);
    }
  });
}

export function selectLogEntriesToTrim(entries, maxEntries) {
  const excess = Math.max(0, entries.length - Math.floor(maxEntries));
  if (!excess) return [];
  const trimPriority = (level) =>
    level === 'DEBUG' || level === 'INFO' ? 0 : level === 'WARN' || level === 'ERROR' ? 1 : 2;
  return [...entries]
    .sort((a, b) => {
      const priority = trimPriority(a.level) - trimPriority(b.level);
      if (priority) return priority;
      const timestamp = a.ts - b.ts;
      if (timestamp) return timestamp;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, excess)
    .map((entry) => entry.id);
}

function withSiteLogOrderLock(operation, { required = false } = {}) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) return locks.request(SITE_LOG_ORDER_LOCK, operation);
  if (required && typeof indexedDB !== 'undefined') {
    return Promise.reject(new Error('Web Locks are unavailable; persisted site logs were not cleared.'));
  }
  // Clear Logs itself is gated by the dashboard activity lock. Logger persistence
  // remains best-effort in contexts where Web Locks are unavailable.
  return Promise.resolve().then(operation);
}

function waitForTransaction(tx, message) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error(message));
    tx.onabort = () => reject(tx.error || new Error(message));
  });
}

async function reserveLogSequence(db) {
  const tx = db.transaction(DB_META_STORE, 'readwrite');
  const completed = waitForTransaction(tx, 'Failed to reserve a site-log sequence.');
  const store = tx.objectStore(DB_META_STORE);
  const request = store.get(NEXT_SEQUENCE_KEY);
  let sequence = null;
  request.onsuccess = () => {
    const current = request.result?.value ?? 0;
    if (!Number.isSafeInteger(current) || current < 0 || current === Number.MAX_SAFE_INTEGER) {
      try {
        tx.abort();
      } catch (e) {
        /* transaction is already aborting */
      }
      return;
    }
    sequence = current + 1;
    try {
      store.put({ key: NEXT_SEQUENCE_KEY, value: sequence });
    } catch (e) {
      try {
        tx.abort();
      } catch (abortError) {
        /* transaction is already aborting */
      }
    }
  };
  request.onerror = () => {
    try {
      tx.abort();
    } catch (e) {
      /* transaction is already aborting */
    }
  };
  await completed;
  if (!Number.isSafeInteger(sequence)) throw new Error('Site-log sequence metadata is unavailable.');
  return sequence;
}

export function clearPersistedSiteLog() {
  // Queue ordering requests immediately when the UI invokes clear. Earlier log
  // calls reserve lower sequences; later log calls remain on the post-clear side.
  const previousClear = pendingClear;
  const clearing = withSiteLogOrderLock(
    async () => {
      await previousClear;
      const db = await openDb();
      if (!db) throw new Error('IndexedDB is unavailable; persisted site logs were not cleared.');
      const hasStore = (name) => db.objectStoreNames.contains(name);
      if (!hasStore(DB_STORE) || !hasStore(DB_META_STORE)) {
        db.close();
        throw new Error('Persisted site-log stores are unavailable; logs were not cleared.');
      }
      const stores = [DB_STORE, LEGACY_DB_STORE, DB_META_STORE].filter(hasStore);
      try {
        const tx = db.transaction(stores, 'readwrite');
        const completed = waitForTransaction(tx, 'Failed to clear persisted site logs.');
        const metadata = tx.objectStore(DB_META_STORE);
        const sequenceRequest = metadata.get(NEXT_SEQUENCE_KEY);
        sequenceRequest.onsuccess = () => {
          const sequence = sequenceRequest.result?.value ?? 0;
          if (!Number.isSafeInteger(sequence) || sequence < 0) {
            try {
              tx.abort();
            } catch (e) {
              /* transaction is already aborting */
            }
            return;
          }
          try {
            metadata.put({ key: CLEAR_WATERMARK_KEY, value: sequence });
          } catch (e) {
            try {
              tx.abort();
            } catch (abortError) {
              /* transaction is already aborting */
            }
          }
        };
        sequenceRequest.onerror = () => {
          try {
            tx.abort();
          } catch (e) {
            /* transaction is already aborting */
          }
        };
        for (const name of [DB_STORE, LEGACY_DB_STORE]) {
          if (hasStore(name)) tx.objectStore(name).clear();
        }
        await completed;
      } finally {
        db.close();
      }
    },
    { required: true }
  );
  pendingClear = clearing.catch(() => undefined);
  return clearing;
}

export function createSiteLogger(opts = {}) {
  const {
    crawlId = `crawl-${Date.now()}`,
    maxEntries = 5000,
    flushMs = 1000,
    flushCount = 50,
    onEntry = null, // live sink (dashboard subscribes)
  } = opts;

  let seq = 0;
  let dbPromise = null;
  let buffer = []; // pending IndexedDB writes with globally ordered reservations
  let flushTimer = 0;
  const counts = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0, FATAL: 0 };
  let unseenError = false; // an ERROR/FATAL the user hasn't viewed yet

  const getDb = () => {
    if (!dbPromise) dbPromise = openDb();
    return dbPromise;
  };

  async function trimDb(db) {
    try {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      const count = await new Promise((res, rej) => {
        const r = store.count();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      if (count <= maxEntries) return;
      const rows = await new Promise((res, rej) => {
        const r = store.getAll();
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      for (const id of selectLogEntriesToTrim(rows, maxEntries)) {
        try {
          store.delete(id);
        } catch (e) {
          /* ignore */
        }
      }
    } catch (e) {
      /* trim is best-effort */
    }
  }

  async function flush() {
    flushTimer = 0;
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    try {
      const db = await getDb();
      if (!db) return; // no IndexedDB (unit tests) — memory only
      const orderedBatch = await Promise.all(
        batch.map(async (item) => ({
          entry: item.entry,
          sequence: await item.sequencePromise,
        }))
      );
      const entries = orderedBatch.filter((item) => Number.isSafeInteger(item.sequence) && item.sequence > 0);
      if (!entries.length) return;
      const tx = db.transaction([DB_STORE, DB_META_STORE], 'readwrite');
      const completed = waitForTransaction(tx, 'Failed to persist site logs.');
      const store = tx.objectStore(DB_STORE);
      const watermarkRequest = tx.objectStore(DB_META_STORE).get(CLEAR_WATERMARK_KEY);
      watermarkRequest.onsuccess = () => {
        const watermark = watermarkRequest.result?.value ?? 0;
        if (!Number.isSafeInteger(watermark) || watermark < 0) {
          try {
            tx.abort();
          } catch (e) {
            /* transaction is already aborting */
          }
          return;
        }
        for (const item of entries) {
          if (item.sequence <= watermark) continue;
          try {
            store.add(item.entry);
          } catch (e) {
            /* ignore single-entry failure */
          }
        }
      };
      watermarkRequest.onerror = () => {
        try {
          tx.abort();
        } catch (e) {
          /* transaction is already aborting */
        }
      };
      await completed;
      await trimDb(db);
    } catch (e) {
      // A failed log write must NEVER stop the crawl. Drop the batch.
    }
  }

  function scheduleFlush() {
    if (buffer.length >= flushCount) {
      void flush();
      return;
    }
    if (!flushTimer)
      flushTimer = setTimeout(() => {
        void flush();
      }, flushMs);
  }

  function log(level, category, message, context = {}) {
    const normLevel = LOG_LEVEL_NAMES.includes(level) ? level : 'INFO';
    const normCategory = LOG_CATEGORIES.includes(category) ? category : 'SYSTEM';
    const entry = {
      id: crypto.randomUUID(),
      seq: seq++,
      ts: Date.now(),
      crawlId,
      level: normLevel,
      category: normCategory,
      message: String(message),
      corr: context.corr || null,
      url: context.url || null,
      context: { ...context },
    };
    // Don't duplicate url/corr inside context.
    delete entry.context.url;
    delete entry.context.corr;
    counts[normLevel]++;
    if (normLevel === 'ERROR' || normLevel === 'FATAL') unseenError = true;
    const sequencePromise = withSiteLogOrderLock(async () => {
      const db = await getDb();
      if (!db) return null;
      return reserveLogSequence(db);
    }).catch(() => null);
    buffer.push({ entry, sequencePromise });
    scheduleFlush();
    if (typeof onEntry === 'function') {
      try {
        onEntry(entry);
      } catch (e) {
        /* live sink must not throw */
      }
    }
    return entry;
  }

  // Convenience shorthands: logger.info('W1', 'tab opened', { url, tabId })
  const api = {
    log,
    crawlId,
    counts,
    isUnseenError: () => unseenError,
    markSeen: () => {
      unseenError = false;
    },
    flush: () => flush(),
  };
  for (const lvl of LOG_LEVEL_NAMES) {
    api[lvl.toLowerCase()] = (category, message, context) => log(lvl, category, message, context);
  }
  return api;
}

// Query the persisted log (dashboard Log page). Filters are optional.
export async function querySiteLog({ levels, categories, corr, url, text, since, until, limit = 500 } = {}) {
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction(DB_STORE, 'readonly');
    const store = tx.objectStore(DB_STORE);
    const out = [];
    // Iterate newest-first via a reversed cursor over the ts index.
    const req = store.index('ts').openCursor(null, 'prev');
    await new Promise((res) => {
      req.onsuccess = () => {
        const c = req.result;
        if (!c || out.length >= limit) {
          res();
          return;
        }
        const e = c.value;
        if (levels && levels.length && !levels.includes(e.level)) {
          c.continue();
          return;
        }
        if (categories && categories.length && !categories.includes(e.category)) {
          c.continue();
          return;
        }
        if (corr && e.corr !== corr) {
          c.continue();
          return;
        }
        if (url && e.url !== url && !(e.url || '').includes(url)) {
          c.continue();
          return;
        }
        if (since && e.ts < since) {
          c.continue();
          return;
        }
        if (until && e.ts > until) {
          c.continue();
          return;
        }
        if (
          text &&
          !(e.message || '').toLowerCase().includes(text.toLowerCase()) &&
          !JSON.stringify(e.context || {})
            .toLowerCase()
            .includes(text.toLowerCase())
        ) {
          c.continue();
          return;
        }
        out.push(e);
        c.continue();
      };
      req.onerror = () => res();
    });
    return out.reverse(); // chronological
  } catch (e) {
    return [];
  }
}

// Format a timestamp with milliseconds: 14:32:05.123
export function formatLogTs(ts) {
  const d = new Date(ts);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
