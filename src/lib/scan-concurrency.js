// Concurrency primitives for the site-data crawler: the slot pool
// (hard tab window), the worker handoff queue, and the adaptive
// CPU/load monitors. Pure coordination logic — no crawl state.
import { SITE_DATA_CONFIG } from './scan-config.js';

export function clampScanWindow(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return SITE_DATA_CONFIG.window.default;
  return Math.min(
    SITE_DATA_CONFIG.window.max,
    Math.max(SITE_DATA_CONFIG.window.min, n)
  );
}

// Generic integer clamp for UI-overridable tunables.
export function clampInt(v, min, max, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Counting semaphore with a dynamic limit. acquire() waits while
// used >= limit(); release() wakes waiters; kick() re-evaluates waiters
// after the limit changed (adaptive window growth).
//
// Runtime guard: every grant is checked against the limit — a grant while
// used >= limit() can only come from a bug, and fires onViolation (the
// crawler aborts instead of silently continuing). abort() wakes all waiters
// with `false` and refuses further grants, so a stopped crawl can't hang in
// acquire(). Exported for tests.
export function createSlotPool(limitFn, onViolation) {
  let used = 0;
  let aborted = false;
  const waiters = [];
  // Grant-time invariant: a new slot may only be handed out while the owned
  // in-flight count is below the EFFECTIVE limit. (A shrink below `used`
  // does NOT violate this — in-flight tabs finish naturally; only new grants
  // are gated.)
  const checkGrant = () => {
    if (used > limitFn() && typeof onViolation === 'function') {
      onViolation(
        `slot window breached: ${used} owned tabs in flight above the effective limit ${limitFn()}`
      );
    }
  };
  const pump = () => {
    if (aborted) return;
    while (waiters.length > 0 && used < limitFn()) {
      used++;
      checkGrant();
      waiters.shift()(true);
    }
  };
  return {
    get used() {
      return used;
    },
    limit() {
      return limitFn();
    },
    waiting() {
      return waiters.length;
    },
    get isAborted() {
      return aborted;
    },
    // Resolves true when a slot is granted, false when the pool was aborted.
    async acquire() {
      if (aborted) return false;
      if (used < limitFn()) {
        used++;
        checkGrant();
        return true;
      }
      const granted = await new Promise((resolve) => waiters.push(resolve));
      return granted === true && !aborted;
    },
    release() {
      if (used > 0) used--;
      pump();
    },
    kick() {
      pump();
    },
    abort() {
      aborted = true;
      while (waiters.length > 0) waiters.shift()(false);
    },
  };
}

// Minimal async FIFO queue between the workers.
export function createAsyncQueue() {
  const items = [];
  const takers = [];
  return {
    push(item) {
      if (takers.length > 0) takers.shift()(item);
      else items.push(item);
    },
    take() {
      if (items.length > 0) return Promise.resolve(items.shift());
      return new Promise((resolve) => takers.push(resolve));
    },
    size() {
      return items.length;
    },
  };
}

// One scan group for the whole run. All concurrent openers share a single
// creation promise, so no duplicate groups can form; the group id is
// revalidated on every use and recreated when invalid.

// registry — a bug; the caller aborts loudly instead of silently continuing.
// Sample system CPU usage as a 0-100 percentage, or null when unavailable.
// chrome.system.cpu reports cumulative per-processor counters
// ({idle, kernel, total, user}); the percentage is derived from deltas, so
export function createSystemCpuSampler() {
  let prev = null;
  const countersOf = (u) => {
    if (!u || typeof u !== 'object') return null;
    const total = Number(u.total);
    const idle = Number(u.idle);
    if (Number.isFinite(total) && Number.isFinite(idle) && total > 0)
      return { total, idle };
    const k = Number(u.kernel),
      usr = Number(u.user);
    if (
      Number.isFinite(k) &&
      Number.isFinite(usr) &&
      Number.isFinite(idle) &&
      k + usr + idle > 0
    )
      return { total: k + usr + idle, idle };
    return null;
  };
  return async () => {
    try {
      if (
        !chrome.system ||
        !chrome.system.cpu ||
        typeof chrome.system.cpu.getInfo !== 'function'
      )
        return null;
      const info = await chrome.system.cpu.getInfo();
      const now = Date.now();
      const procs = (info && info.processors) || [];
      const cur = procs.map((pr) => countersOf(pr.usage)).filter(Boolean);
      let pct = null;
      if (prev && cur.length === prev.counters.length && cur.length > 0) {
        const dt = now - prev.t;
        void dt;
        let dBusy = 0,
          dTotal = 0;
        for (let i = 0; i < cur.length; i++) {
          const dT = cur[i].total - prev.counters[i].total;
          const dI = cur[i].idle - prev.counters[i].idle;
          if (dT > 0 && dI >= 0 && dI <= dT) {
            dTotal += dT;
            dBusy += dT - dI;
          }
        }
        if (dTotal > 0)
          pct = Math.min(100, Math.max(0, (dBusy / dTotal) * 100));
      }
      prev = { t: now, counters: cur };
      return pct; // null on the first sample (no delta yet)
    } catch (e) {
      return null;
    }
  };
}

// Sliding-window load monitor: records per-tab load outcomes for OWNED tabs
// (reused user tabs resolve instantly and would dilute the signal) and
// reports timeout rate + average load time over the last N tabs.
export function createLoadMonitor(size) {
  const samples = [];
  return {
    record({ loadMs, timedOut }) {
      samples.push({
        loadMs: Math.max(0, Number(loadMs) || 0),
        timedOut: !!timedOut,
      });
      while (samples.length > size) samples.shift();
    },
    stats() {
      const n = samples.length;
      if (!n) return null;
      const timeouts = samples.filter((s) => s.timedOut).length;
      const avgLoadMs = samples.reduce((a, s) => a + s.loadMs, 0) / n;
      return { n, timeoutRate: timeouts / n, avgLoadMs };
    },
  };
}

// Adaptive window controller.
//
// Two independent shrink triggers (fast down):
//   1. CPU guard: samples system CPU every second (percentage from the delta
//      of two cumulative readings; see createSystemCpuSampler). "100%" counts
//      as >= 95%. While it persists continuously for MORE than 10 seconds,
//      the effective window is halved (minimum 2) and the 10s count is reset
//      so it can drop again if still high.
//   2. Load guard (earlier signal): tab load timeout rate / average load time
//      over the sliding window of the last N owned tabs (see
//      createLoadMonitor). Reacts before the CPU pegs, when tabs already
//      load slowly and time out.
// Shrinking never closes already-open tabs — Worker 1 just stops opening new
// ones until the owned tab count drops below the new effective limit; the
// hard cap keeps being enforced at the effective value.
// Slow up: only after CPU stays < 70% for ~15s AND the load signal is healthy
// does the window grow back (+2), never above maxWindow (the UI setting).
// Fast down, slow up, so it doesn't oscillate.
// Exported for tests; sampleMs/highMs/lowSamples/loadStats are injectable.
export function startCpuMonitor({
  getWindow,
  setWindow,
  maxWindow,
  onAdjust,
  sampler,
  sampleMs,
  highMs,
  lowSamples,
  loadStats,
}) {
  const CFG = SITE_DATA_CONFIG;
  const interval =
    Number.isFinite(sampleMs) && sampleMs > 0 ? sampleMs : CFG.cpu.sampleMs;
  const highThresholdMs =
    Number.isFinite(highMs) && highMs > 0 ? highMs : CFG.cpu.highMs;
  const lowThresholdSamples =
    Number.isFinite(lowSamples) && lowSamples > 0
      ? Math.floor(lowSamples)
      : CFG.cpu.lowSamples;
  let highSince = 0,
    lowStreak = 0,
    stopped = false,
    timer = 0,
    lastLoadShrinkAt = 0;
  const shrink = (reason) => {
    const cur = getWindow();
    const next = Math.max(CFG.cpu.floor, Math.floor(cur / 2));
    if (next < cur) {
      setWindow(next);
      onAdjust(`${reason} — window ${cur} → ${next}`);
      return true;
    }
    return false;
  };
  async function tick() {
    if (stopped) return;
    const now = Date.now();
    let cpuHigh = false,
      cpuLow = false;
    try {
      const pct = await sampler();
      if (typeof pct === 'number' && Number.isFinite(pct)) {
        if (pct >= CFG.cpu.highPct) {
          cpuHigh = true;
          if (!highSince) highSince = now;
          lowStreak = 0;
        } else if (pct < CFG.cpu.lowPct) {
          cpuLow = true;
          highSince = 0;
          lowStreak++;
        } else {
          highSince = 0;
          lowStreak = 0;
        }
      } else {
        highSince = 0;
        lowStreak = 0;
      }
    } catch (e) {
      highSince = 0;
      lowStreak = 0; /* sampler hiccup — skip this round */
    }

    let shrank = false;
    if (cpuHigh && now - highSince > highThresholdMs) {
      shrank = shrink(`system CPU ≥ ${CFG.cpu.highPct}% for >10s`);
      highSince = now; // reset the 10s count so it can drop again
    }
    // Load guard: earlier than CPU. Needs enough samples; hysteresis between
    // the shrink and recover thresholds; cooldown between load shrinks.
    let loadDegraded = false,
      loadHealthy = true,
      ls;
    try {
      ls = typeof loadStats === 'function' ? loadStats() : null;
    } catch (e) {
      ls = null;
    }
    if (ls && ls.n >= CFG.load.minSamples) {
      loadDegraded =
        ls.timeoutRate > CFG.load.timeoutRateHigh ||
        ls.avgLoadMs > CFG.load.avgMsHigh;
      loadHealthy =
        ls.timeoutRate <= CFG.load.timeoutRateRecovered &&
        ls.avgLoadMs <= CFG.load.avgMsRecovered;
    }
    if (
      !shrank &&
      loadDegraded &&
      now - lastLoadShrinkAt > CFG.load.shrinkCooldownMs
    ) {
      shrank = shrink(
        `tab load degraded (timeout ${(ls.timeoutRate * 100).toFixed(0)}%, avg ${(ls.avgLoadMs / 1000).toFixed(1)}s over last ${ls.n} tabs)`
      );
      lastLoadShrinkAt = now;
    }
    if (!shrank && cpuLow && loadHealthy && lowStreak >= lowThresholdSamples) {
      lowStreak = 0;
      const cur = getWindow();
      const next = Math.min(maxWindow, cur + 2);
      if (next > cur) {
        setWindow(next);
        onAdjust(
          `system CPU < ${CFG.cpu.lowPct}% and tab load healthy ~15s — window ${cur} → ${next}`
        );
      }
    }
    if (!stopped) timer = setTimeout(tick, interval);
  }
  timer = setTimeout(tick, interval);
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
