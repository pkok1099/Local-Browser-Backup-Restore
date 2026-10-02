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
// logging never slows the pipeline; a failed log write never stops the
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
const DB_STORE = 'entries';
const DB_VERSION = 1;

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
        if (!db.objectStoreNames.contains(DB_STORE)) {
          const store = db.createObjectStore(DB_STORE, { keyPath: 'seq', autoIncrement: true });
          store.createIndex('ts', 'ts', { unique: false });
          store.createIndex('level', 'level', { unique: false });
          store.createIndex('category', 'category', { unique: false });
          store.createIndex('corr', 'corr', { unique: false });
          store.createIndex('crawlId', 'crawlId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // log persistence is best-effort
    } catch (e) {
      resolve(null);
    }
  });
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
  let buffer = []; // pending IndexedDB writes
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
      // Trim oldest DEBUG/INFO first, keep ERROR/WARN/FATAL longest.
      let toDelete = count - maxEntries;
      const cursor = store.openCursor();
      const ids = [];
      await new Promise((res) => {
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c || toDelete <= 0) {
            res();
            return;
          }
          const lvl = c.value.level;
          if (lvl === 'DEBUG' || lvl === 'INFO') {
            ids.push(c.primaryKey);
            toDelete--;
          }
          c.continue();
        };
        cursor.onerror = () => res();
      });
      // If still over budget, trim oldest of any level (but keep FATAL).
      if (toDelete > 0) {
        const cursor2 = store.openCursor();
        await new Promise((res) => {
          cursor2.onsuccess = () => {
            const c = cursor2.result;
            if (!c || toDelete <= 0) {
              res();
              return;
            }
            if (c.value.level !== 'FATAL' && !ids.includes(c.primaryKey)) {
              ids.push(c.primaryKey);
              toDelete--;
            }
            c.continue();
          };
          cursor2.onerror = () => res();
        });
      }
      for (const id of ids) {
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
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      for (const e of batch) {
        try {
          store.add(e);
        } catch (err) {
          /* ignore single-entry failure */
        }
      }
      await new Promise((res) => {
        tx.oncomplete = res;
        tx.onerror = res;
      });
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
    buffer.push(entry);
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
