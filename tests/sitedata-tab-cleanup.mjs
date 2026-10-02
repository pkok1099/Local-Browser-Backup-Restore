// Node regression test for the slot-based streaming site-data collector.
//
// Runs the REAL src/lib/sitedata.js against a fake `chrome` object and
// verifies the hard rules:
//   A. hard tab window: with 40 origins and window=8, open+in-flight tabs
//      never exceed 8; opens are parallel (peak > 1), every tab lands in the
//      ONE scan group, and no tab is left behind;
//   B. takeover: a tab the user navigated elsewhere is never closed — it is
//      ungrouped, its slot is released, the scan completes;
//   C. vanished tabs are skipped cleanly;
//   D. the adaptive CPU window halves on >10s of >=95% CPU (floor 2, timer
//      resets so it can drop again) and grows back +2 after ~15s under 70%,
//      never exceeding the configured maximum (the UI value is untouched);
//   E. the UI window option is clamped and actually reaches the collector;
//   F. safeCloseTab refuses any tab outside ownedTabIds (no remove call, a
//      REFUSED warning is logged) and closes an owned tab exactly once;
//   G. pre-existing user tabs are reused for reading but never grouped,
//      moved, ungrouped or closed, and don't count against the slot window;
//   H. runtime guard: a close attempt on a non-owned tab aborts the crawl
//      loudly (ABORTED warning via progress + notes, partial results kept)
//      instead of silently continuing;
//   I. incremental checkpoint: partial results persist and a later crawl
//      resumes unfinished URLs only; the checkpoint clears on success;
//   J. load signal: tab timeout rate / avg load time over the sliding window
//      shrinks the effective window before the CPU pegs; the pool never
//      grants above the effective limit and stops granting after abort.
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFakeChrome({ failCreateFor = new Set(), urlMode = 'scan', originCount = 2, createDelayMs = 5, attachDelayMs = 0, preExisting = [], readsSucceed = false, duplicateCreateId = false, loadDelayMs = 0, failAttachTimes = 0, failEval = false, storageFailMode = 'none' } = {}) {
  const created = [];
  const removed = [];
  const ungrouped = [];
  const deletedHistory = [];
  const groupCalls = [];
  const events = [];
  let nextId = 100;
  let openCount = 0;
  let maxOpen = 0;
  let maxSlotsSeen = 0;
  const tabsById = new Map();
  let attachFailsLeft = failAttachTimes;
  for (const t of preExisting) tabsById.set(t.id, { ...t });
  const bookmarks = [];
  for (let i = 0; i < originCount; i++) bookmarks.push({ url: `http://example${i}.com/`, children: [] });
  // Minimal chrome.storage.local mock (checkpoint read/write).
  const storageData = {};
  const storageWrites = [];
  // Payload served by the mocked debugger when readsSucceed is on.
  const txPayload = JSON.stringify({ localStorage: { reuse_key: 'reuse_value' } });
  const chrome = {
    tabs: {
      query: async (q = {}) => {
        if (!q || !q.url) return [...tabsById.values()];
        const prefix = String(q.url).replace(/\*$/, '');
        return [...tabsById.values()].filter((t) => (t.url || '').startsWith(prefix));
      },
      create: async ({ url }) => {
        for (const host of failCreateFor) if (url.startsWith(host)) throw new Error('fake create denied');
        await sleep(createDelayMs); // deterministic overlap between parallel opens
        const tab = { id: duplicateCreateId ? 100 : nextId++, url, status: 'loading', windowId: 7, groupId: -1, createdAt: Date.now() };
        tabsById.set(tab.id, tab);
        created.push(tab);
        events.push(`create:${tab.id}`);
        openCount++;
        maxOpen = Math.max(maxOpen, openCount);
        return tab;
      },
      get: async (id) => {
        const t = tabsById.get(id);
        if (!t) throw new Error('fake: no such tab');
        // urlMode: 'throw' = tab vanished; 'scan' = still shows our scan page;
        // 'taken-over' = user navigated the tab elsewhere.
        if (urlMode === 'throw') throw new Error('fake: tab gone');
        if (urlMode === 'taken-over') {
          const origin = t.url.split('/__bbr_site_scan__')[0];
          return { ...t, status: 'complete', url: origin + '/user-page' };
        }
        // loadDelayMs: the tab stays 'loading' this long after creation —
        // lets waitTabReady time out.
        if (loadDelayMs > 0 && Date.now() - (t.createdAt || 0) < loadDelayMs) {
          return { ...t, status: 'loading' };
        }
        return { ...t, status: 'complete' };
      },
      remove: async (id) => { removed.push(id); events.push(`remove:${id}`); if (tabsById.delete(id)) openCount--; },
      ungroup: async (id) => { ungrouped.push(id); const t = tabsById.get(id); if (t) t.groupId = -1; },
      group: async ({ tabIds, groupId }) => {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]; // real Chrome accepts a single id too
        groupCalls.push({ tabIds: [...ids], groupId });
        const gid = groupId ?? 42;
        for (const id of ids) { const t = tabsById.get(id); if (t) t.groupId = gid; }
        return gid;
      },
    },
    tabGroups: {
      update: async () => ({}),
      get: async (id) => ({ id, title: 'BBR Site Scan' }),
    },
    debugger: {
      attach: (target, version, cb) => {
        // failAttachTimes: fail the first N attaches, then succeed.
        if (attachFailsLeft > 0) {
          attachFailsLeft--;
          chrome.runtime.lastError = { message: 'fake attach denied' };
        } else {
          chrome.runtime.lastError = readsSucceed ? undefined : { message: 'fake attach denied' };
        }
        setTimeout(cb, attachDelayMs);
      },
      detach: (target, cb) => { chrome.runtime.lastError = undefined; setTimeout(cb, 0); },
      sendCommand: (dbg, method, params, cb) => {
        if (failEval) { chrome.runtime.lastError = { message: 'fake eval failed' }; setTimeout(() => cb(undefined), 0); return; }
        if (!readsSucceed) { chrome.runtime.lastError = { message: 'fake sendCommand denied' }; setTimeout(() => cb(undefined), 0); return; }
        const expr = (params && params.expression) || '';
        chrome.runtime.lastError = undefined;
        if (expr.includes('__BBR.setTx')) {
          // evalJsonViaTx: first evaluate returns the payload length.
          setTimeout(() => cb({ result: { type: 'number', value: txPayload.length } }), 0);
        } else if (expr.includes('__BBR.txChunk')) {
          setTimeout(() => cb({ result: { type: 'string', value: txPayload } }), 0);
        } else {
          // injectPagelib / clearTx — just acknowledge.
          setTimeout(() => cb({ result: { type: 'boolean', value: true } }), 0);
        }
      },
    },
    history: {
      search: async () => [],
      deleteUrl: async ({ url }) => { deletedHistory.push(url); },
    },
    bookmarks: {
      getTree: async () => [{ children: bookmarks }],
    },
    cookies: { getAllCookieStores: async () => [] },
    scripting: { executeScript: async () => [] },
    storage: {
      local: {
        get: async (key) => ({ [key]: storageData[key] }),
        set: async (obj) => {
          if (storageFailMode === 'quota') throw new Error('QUOTA_BYTES quota exceeded');
          if (storageFailMode === 'error') throw new Error('fake storage write failed');
          Object.assign(storageData, obj); storageWrites.push(Object.keys(obj));
        },
        remove: async (key) => { delete storageData[key]; },
      },
    },
    runtime: { getURL: (p) => p, lastError: undefined },
    // no chrome.system — the CPU sampler must degrade gracefully (null).
  };
  return {
    chrome, created, removed, ungrouped, deletedHistory, groupCalls, events,
    getMaxOpen: () => maxOpen,
    noteMaxSlots: (n) => { maxSlotsSeen = Math.max(maxSlotsSeen, n); },
    getMaxSlotsSeen: () => maxSlotsSeen,
    hasTab: (id) => tabsById.has(id),
    getTab: (id) => tabsById.get(id),
    listTabs: () => [...tabsById.values()],
    storageData,
    storageWrites,
    seedCheckpoint: (origins) => { storageData['bbr:site-data-checkpoint'] = { savedAt: Date.now(), origins }; },
  };
}

globalThis.fetch = async () => ({ text: async () => 'globalThis.__BBR = {};' });

const { collectSiteData, startCpuMonitor, createTabOwnership, createSiteDataOwnership, createSlotPool, createLoadMonitor, SITE_DATA_CONFIG } = await import('../src/lib/sitedata.js');

// Scenario A: 40 origins, window 8, slow reads (backpressure). Peak open
// tabs must never exceed the window; opens must be parallel; every tab goes
// into the single scan group; nothing is left behind. Retry is disabled here
// to keep the scenario focused (retry waves are covered in L).
{
  const fake = makeFakeChrome({ originCount: 40, attachDelayMs: 30 });
  globalThis.chrome = fake.chrome;
  const seenStats = [];
  const section = await collectSiteData(
    (m, f, st) => { if (st) { seenStats.push(st); fake.noteMaxSlots(st.slotsUsed); } },
    { scanWindowSize: 8, retryMaxAttempts: 1 }
  );
  assert.equal(fake.created.length, 40, '40 scan tabs should be created, got ' + fake.created.length);
  assert.ok(fake.getMaxOpen() <= 8, `hard window: peak open tabs must be <= 8, got ${fake.getMaxOpen()}`);
  assert.ok(fake.getMaxOpen() > 1, `opens must be parallel, peak was ${fake.getMaxOpen()}`);
  assert.ok(fake.getMaxSlotsSeen() <= 8, `slots used must never exceed 8, got ${fake.getMaxSlotsSeen()}`);
  assert.deepEqual(
    fake.removed.sort((a, b) => a - b),
    fake.created.map((t) => t.id).sort((a, b) => a - b),
    'every created tab must be closed'
  );
  const bootstraps = fake.groupCalls.filter((c) => c.groupId === undefined || c.groupId === null);
  assert.equal(bootstraps.length, 1, `exactly one scan group must be created, got ${bootstraps.length}`);
  assert.ok(fake.created.every((t) => t.groupId === 42), 'every scan tab must land in the scan group');
  for (const st of seenStats) {
    assert.ok(st.slotsUsed <= st.slotsTotal, `slotsUsed (${st.slotsUsed}) must never exceed slotsTotal (${st.slotsTotal})`);
    assert.ok(st.inGroup <= st.slotsTotal, `inGroup (${st.inGroup}) must never exceed the window (${st.slotsTotal})`);
    assert.equal(st.windowMax, 8, 'configured window must reach the collector');
  }
  assert.deepEqual(Object.keys(section.origins || {}), [], 'reads fail in the fake (attach denied)');
  assert.ok((section.notes || []).some((n) => n.includes('read failed')), 'read failures should be noted');
  // (c) no scan tabs left behind: nothing carrying the scan marker may remain.
  const leftovers = fake.listTabs().filter((t) => (t.url || '').includes('/__bbr_site_scan__'));
  assert.deepEqual(leftovers, [], 'no scan tabs may remain after the crawl, got: ' + JSON.stringify(leftovers.map((t) => t.id)));
  // (d) UI setting untouched: the checkpoint is cleared on success.
  assert.equal(fake.storageData['bbr:site-data-checkpoint'], undefined, 'checkpoint must be cleared after a successful crawl');
  console.log('PASS scenario A: hard window respected, parallel opens, single group, clean teardown');
}

// Scenario B: the user takes over a scan tab mid-scan — it must never be
// closed. It is ungrouped, its slot is released, and the scan completes.
{
  const fake = makeFakeChrome({ urlMode: 'taken-over' });
  globalThis.chrome = fake.chrome;
  const section = await collectSiteData(null, { scanWindowSize: 4, retryMaxAttempts: 1 });
  assert.equal(fake.created.length, 2, 'two scan tabs should be created, got ' + fake.created.length);
  assert.deepEqual(fake.removed, [], 'a taken-over tab must never be closed');
  assert.deepEqual(
    fake.ungrouped.sort((a, b) => a - b),
    fake.created.map((t) => t.id).sort((a, b) => a - b),
    'taken-over tabs must be ungrouped so the group limit stays exact'
  );
  const untouched = (section.notes || []).filter((n) => n.includes('left scan tab for') && n.includes('untouched'));
  assert.equal(untouched.length, 2, 'notes should record both untouched tabs, got: ' + JSON.stringify(section.notes));
  console.log('PASS scenario B: taken-over scan tabs are never closed, slots released');
}

// Scenario C: tabs vanish before becoming ready — skipped cleanly, no errors.
{
  const fake = makeFakeChrome({ urlMode: 'throw' });
  globalThis.chrome = fake.chrome;
  const section = await collectSiteData(null, { retryMaxAttempts: 1 });
  assert.equal(fake.created.length, 2, 'two scan tabs should be created, got ' + fake.created.length);
  assert.deepEqual(fake.removed, [], 'vanished tabs need no closing');
  assert.deepEqual(fake.ungrouped, [], 'vanished tabs need no ungrouping');
  assert.ok(
    (section.notes || []).some((n) => n.includes('http://example0.com') && n.includes('did not finish loading')),
    'notes should record the skipped origin, got: ' + JSON.stringify(section.notes)
  );
  console.log('PASS scenario C: vanished scan tabs are skipped cleanly');
}

// Scenario D: adaptive CPU window — halve on >10s of >=95% CPU (floor 2,
// 10s count resets so it can drop again), grow back +2 after ~15s under 70%,
// never exceeding the configured maximum.
{
  const waitFor = async (cond, what) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > 8000) throw new Error('timeout waiting for: ' + what);
      await sleep(5);
    }
  };
  // High phase: 97% sustained -> 20 -> 10 -> 5 -> 2 (floor), then holds.
  let window = 20;
  const adjustments = [];
  const mon = startCpuMonitor({
    getWindow: () => window,
    setWindow: (w) => { window = w; },
    maxWindow: 20,
    sampler: async () => 97,
    sampleMs: 5,
    highMs: 60,
    onAdjust: (reason) => adjustments.push(reason),
  });
  await waitFor(() => window === 10, 'halve 20 -> 10');
  await waitFor(() => window === 5, 'halve 10 -> 5');
  await waitFor(() => window === 2, 'halve 5 -> 2 (floor)');
  await sleep(150);
  assert.equal(window, 2, `window must hold at the floor of 2, got ${window}`);
  assert.ok(adjustments.length >= 3, 'each halving should be reported, got: ' + JSON.stringify(adjustments));
  mon.stop();
  // Rise phase: <70% for ~15s -> +2 per step, capped at the UI setting.
  let w2 = 2;
  const mon2 = startCpuMonitor({
    getWindow: () => w2,
    setWindow: (w) => { w2 = w; },
    maxWindow: 8,
    sampler: async () => 10,
    sampleMs: 5,
    onAdjust: () => {},
  });
  await waitFor(() => w2 === 4, 'grow 2 -> 4');
  await waitFor(() => w2 === 6, 'grow 4 -> 6');
  await waitFor(() => w2 === 8, 'grow 6 -> 8');
  await sleep(150);
  assert.equal(w2, 8, `window must never exceed the UI setting, got ${w2}`);
  mon2.stop();
  console.log('PASS scenario D: adaptive CPU window halves fast, grows slow, respects cap and floor');
}

// Scenario E: the UI window option is clamped and reaches the collector.
{
  const seen = [];
  const fake = makeFakeChrome({ originCount: 3 });
  globalThis.chrome = fake.chrome;
  await collectSiteData((m, f, st) => { if (st) seen.push(st); }, { scanWindowSize: 100, retryMaxAttempts: 1 });
  assert.ok(seen.length > 0, 'progress should carry stats');
  assert.ok(seen.every((st) => st.windowMax === 50 && st.slotsTotal === 50),
    'scanWindowSize should be clamped to 50, got: ' + JSON.stringify(seen[0]));
  const seen2 = [];
  globalThis.chrome = makeFakeChrome({ originCount: 3 }).chrome;
  await collectSiteData((m, f, st) => { if (st) seen2.push(st); }, { scanWindowSize: 1, retryMaxAttempts: 1 });
  assert.ok(seen2.every((st) => st.windowMax === 2 && st.slotsTotal === 2),
    'scanWindowSize should be clamped to a minimum of 2, got: ' + JSON.stringify(seen2[0]));
  console.log('PASS scenario E: scanWindowSize option is clamped and wired through');
}

// Scenario F: safeCloseTab refuses anything outside ownedTabIds — no
// chrome.tabs.remove call, a REFUSED warning is logged. An owned tab closes
// exactly once.
{
  const fake = makeFakeChrome({ originCount: 1 });
  globalThis.chrome = fake.chrome;
  const notes = [];
  const ownership = createSiteDataOwnership(notes);
  // Simulate a non-owned tab id entering the close path.
  const st = await ownership.safeCloseTab(424242, 'http://example0.com');
  assert.equal(st, 'refused', 'non-owned tab must be refused');
  assert.ok(!fake.removed.includes(424242), 'chrome.tabs.remove must NOT be called for a non-owned tab');
  assert.ok(
    notes.some((n) => n.includes('REFUSED') && n.includes('424242')),
    'the refusal must be logged, got: ' + JSON.stringify(notes)
  );
  // An owned scan tab closes exactly once.
  const tab = await fake.chrome.tabs.create({ url: 'http://example0.com/__bbr_site_scan__' });
  ownership.own(tab.id);
  const st2 = await ownership.safeCloseTab(tab.id, 'http://example0.com');
  assert.equal(st2, 'closed', 'owned scan tab should close');
  assert.ok(fake.removed.includes(tab.id), 'chrome.tabs.remove must be called for the owned tab');
  const st3 = await ownership.safeCloseTab(tab.id, 'http://example0.com');
  assert.equal(st3, 'refused', 'a closed tab must not be closed twice');
  assert.equal(fake.removed.filter((id) => id === tab.id).length, 1, 'remove must be called exactly once');
  console.log('PASS scenario F: safeCloseTab refuses non-owned tabs and closes owned ones exactly once');
}

// Scenario G: a pre-existing user tab is reused for reading — it survives
// the crawl (still open, never grouped/moved/ungrouped), its data is read,
// and it doesn't count against the slot window.
{
  const preTab = { id: 7, url: 'http://example0.com/', status: 'complete', windowId: 7, groupId: -1 };
  const fake = makeFakeChrome({ originCount: 2, preExisting: [preTab], readsSucceed: true });
  globalThis.chrome = fake.chrome;
  const seenStats = [];
  const section = await collectSiteData(
    (m, f, st) => { if (st) { seenStats.push(st); fake.noteMaxSlots(st.slotsUsed); } },
    { scanWindowSize: 2, retryMaxAttempts: 1 }
  );
  assert.ok(fake.hasTab(7), 'the pre-existing tab must still be open after the crawl');
  assert.ok(!fake.removed.includes(7), 'the pre-existing tab must never be closed');
  assert.ok(!fake.ungrouped.includes(7), 'the pre-existing tab must never be ungrouped');
  assert.equal(fake.getTab(7).groupId, -1, 'the pre-existing tab must never be put in the scan group');
  const reused = section.origins['http://example0.com'];
  assert.ok(reused && reused.fromOpenTab === true, 'the pre-existing tab should be marked as reused');
  assert.equal(reused.localStorage && reused.localStorage.reuse_key, 'reuse_value', 'data must actually be read from the pre-existing tab');
  const scanned = section.origins['http://example1.com'];
  assert.ok(scanned && scanned.fromOpenTab === false, 'origins without an open tab use a scan tab');
  assert.equal(fake.created.length, 1, 'only one scan tab should be created, got ' + fake.created.length);
  assert.ok(fake.getMaxSlotsSeen() <= 2, 'slots must respect the window, got ' + fake.getMaxSlotsSeen());
  assert.ok(fake.created.every((t) => t.groupId === 42), 'the scan tab must land in the scan group');
  console.log('PASS scenario G: pre-existing tabs are read but never touched, slots only count owned tabs');
}

// Scenario H: runtime guard — a close attempt on a non-owned tab aborts the
// crawl loudly instead of silently continuing. Simulated with a buggy tab id
// source (duplicate ids): exactly one close succeeds, the other is refused,
// the guard fires, the crawl stops, and a clear ABORTED warning reaches the
// dashboard via progress and notes. Partial results are kept.
//
// (Mock limits: a real duplicate tab id can't happen in Chrome; this drives
// the genuine refusal → onViolation → abortScan path inside collectSiteData.)
{
  const fake = makeFakeChrome({ originCount: 2, duplicateCreateId: true });
  globalThis.chrome = fake.chrome;
  const origTimeout = SITE_DATA_CONFIG.tabLoadTimeoutMs;
  SITE_DATA_CONFIG.tabLoadTimeoutMs = 300; // keep the test fast (one waiter times out)
  const progressMsgs = [];
  let section;
  try {
    section = await collectSiteData(
      (m) => progressMsgs.push(String(m)),
      { scanWindowSize: 4 }
    );
  } finally {
    SITE_DATA_CONFIG.tabLoadTimeoutMs = origTimeout;
  }
  assert.equal(section.aborted, true, 'the crawl must abort on a safety violation');
  assert.ok(section.abortReason && section.abortReason.includes('not owned'), 'abort reason must name the violation, got: ' + section.abortReason);
  assert.ok(progressMsgs.some((m) => m.includes('ABORTED')), 'an ABORTED warning must reach the dashboard, got: ' + JSON.stringify(progressMsgs.slice(-3)));
  assert.ok((section.notes || []).some((n) => n.includes('ABORTED')), 'notes must record the abort');
  assert.ok((section.notes || []).some((n) => n.includes('SAFETY VIOLATION')), 'notes must record the violation');
  // The refused tab was never passed to chrome.tabs.remove a second time.
  assert.ok(fake.removed.filter((id) => id === 100).length <= 1, 'a refused close must never reach chrome.tabs.remove');
  console.log('PASS scenario H: safety violation aborts the crawl loudly, partial results kept');
}

// Scenario I: incremental checkpoint — a crawl that doesn't finish leaves a
// checkpoint; the next crawl resumes unfinished URLs only; success clears it.
{
  const fake = makeFakeChrome({ originCount: 4, readsSucceed: true });
  globalThis.chrome = fake.chrome;
  // Simulate a previous interrupted crawl that finished 2 of 4 origins.
  fake.seedCheckpoint({
    'http://example0.com': { localStorage: { a: '1' } },
    'http://example1.com': { localStorage: { b: '2' } },
  });
  const section = await collectSiteData(null, { scanWindowSize: 4, retryMaxAttempts: 1 });
  const origins = Object.keys(section.origins || {}).sort();
  assert.deepEqual(origins,
    ['http://example0.com', 'http://example1.com', 'http://example2.com', 'http://example3.com'],
    'resumed + fresh origins must all be present, got: ' + JSON.stringify(origins));
  assert.equal(section.origins['http://example0.com'].localStorage.a, '1', 'checkpointed data must be reused, not re-crawled');
  assert.equal(fake.created.length, 2, 'only unfinished origins may open scan tabs, got ' + fake.created.length);
  assert.ok(fake.created.every((t) => t.url.startsWith('http://example2.com') || t.url.startsWith('http://example3.com')),
    'scan tabs must only cover unfinished origins');
  assert.equal(fake.storageData['bbr:site-data-checkpoint'], undefined, 'checkpoint must be cleared after a successful crawl');
  console.log('PASS scenario I: checkpoint resume covers unfinished URLs only, cleared on success');
}

// Scenario J: early load signal + pool discipline.
// (1) A degraded sliding window (high timeout rate) halves the effective
//     window before the CPU pegs.
// (2) The pool never grants above the effective limit, doesn't close
//     in-flight tabs on shrink, and stops granting after abort.
{
  // (1) load-triggered shrink
  let window = 20;
  const adjustments = [];
  const loadMon = createLoadMonitor(20);
  for (let i = 0; i < 10; i++) loadMon.record({ loadMs: 12000, timedOut: i < 4 }); // 40% timeouts, 12s avg
  const mon = startCpuMonitor({
    getWindow: () => window,
    setWindow: (w) => { window = w; },
    maxWindow: 20,
    sampler: async () => 10, // CPU is fine — the load signal fires first
    loadStats: () => loadMon.stats(),
    sampleMs: 5,
    onAdjust: (r) => adjustments.push(r),
  });
  const waitFor = async (cond, what) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > 8000) throw new Error('timeout waiting for: ' + what);
      await sleep(5);
    }
  };
  await waitFor(() => window === 10, 'load-degraded halve 20 -> 10');
  assert.ok(adjustments.some((r) => r.includes('tab load degraded')), 'the shrink must name the load signal, got: ' + JSON.stringify(adjustments));
  mon.stop();

  // (2) pool discipline
  const violations = [];
  let limit = 2;
  const pool = createSlotPool(() => limit, (r) => violations.push(r));
  assert.equal(await pool.acquire(), true);
  assert.equal(await pool.acquire(), true);
  let third = null;
  const p3 = pool.acquire().then((v) => { third = v; });
  await sleep(20);
  assert.equal(third, null, 'third acquire must wait while the window is full');
  limit = 1; // shrink below in-flight: must NOT close tabs, just stop new grants
  pool.release(); // used=1; 1 < 1 is false -> waiter stays parked
  await sleep(20);
  assert.equal(third, null, 'no new grant while owned in-flight >= effective limit');
  assert.equal(pool.used, 1, 'in-flight tabs are not closed by a shrink');
  pool.release(); // used=0 -> grant
  await p3;
  assert.equal(third, true, 'grant resumes once below the effective limit');
  assert.equal(pool.used, 1);
  pool.release();
  pool.abort();
  assert.equal(await pool.acquire(), false, 'no grants after abort');
  assert.deepEqual(violations, [], 'no spurious violations, got: ' + JSON.stringify(violations));
  // A waiter parked during abort is woken with false (no hang).
  let limit2 = 2;
  const pool2 = createSlotPool(() => limit2, (r) => violations.push(r));
  await pool2.acquire();
  await pool2.acquire();
  let parked = null;
  const pp = pool2.acquire().then((v) => { parked = v; });
  await sleep(20);
  assert.equal(parked, null, 'third acquire must park');
  pool2.abort();
  await pp;
  assert.equal(parked, false, 'parked acquirers must be released on abort');
  console.log('PASS scenario J: load signal shrinks early; pool grants respect the effective limit and abort');
}

// Scenario K: failure matrix — a failure at EVERY stage (load timeout, attach
// error, exception during read) must still end in finally: the tab is closed
// via safeCloseTab and its slot is released (final stats show slotsUsed 0,
// no scan tabs remain).
{
  // K1: load timeout (tab never finishes loading).
  const realTimeout = SITE_DATA_CONFIG.tabLoadTimeoutMs;
  SITE_DATA_CONFIG.tabLoadTimeoutMs = 300;
  try {
    const fake = makeFakeChrome({ originCount: 2, loadDelayMs: 5000 });
    globalThis.chrome = fake.chrome;
    let lastStats = null;
    const section = await collectSiteData(
      (m, f, st) => { if (st) lastStats = st; },
      { scanWindowSize: 4, retryMaxAttempts: 1 }
    );
    assert.equal(fake.created.length, 2, 'K1: 2 tabs created');
    assert.deepEqual(fake.removed.sort(), fake.created.map((t) => t.id).sort(), 'K1: timed-out tabs must be closed');
    assert.equal(lastStats.slotsUsed, 0, 'K1: all slots released, got ' + lastStats.slotsUsed);
    assert.deepEqual(fake.listTabs().filter((t) => (t.url || '').includes('/__bbr_site_scan__')), [], 'K1: no scan tabs remain');
    assert.equal(section.urlStates.filter((u) => u.status === 'fetch-failed').length, 2, 'K1: both origins fetch-failed');
    console.log('PASS scenario K1: load timeout — tab closed, slot released');
  } finally {
    SITE_DATA_CONFIG.tabLoadTimeoutMs = realTimeout;
  }
  // K2: attach error.
  {
    const fake = makeFakeChrome({ originCount: 2 }); // attach denied by default
    globalThis.chrome = fake.chrome;
    let lastStats = null;
    const section = await collectSiteData(
      (m, f, st) => { if (st) lastStats = st; },
      { scanWindowSize: 4, retryMaxAttempts: 1 }
    );
    assert.equal(fake.created.length, 2, 'K2: 2 tabs created');
    assert.deepEqual(fake.removed.sort(), fake.created.map((t) => t.id).sort(), 'K2: tabs must be closed after attach failure');
    assert.equal(lastStats.slotsUsed, 0, 'K2: all slots released, got ' + lastStats.slotsUsed);
    assert.deepEqual(fake.listTabs().filter((t) => (t.url || '').includes('/__bbr_site_scan__')), [], 'K2: no scan tabs remain');
    assert.equal(section.urlStates.filter((u) => u.status === 'fetch-failed').length, 2, 'K2: both origins fetch-failed');
    console.log('PASS scenario K2: attach error — tab closed, slot released');
  }
  // K3: unexpected exception during read (eval fails after attach succeeds).
  {
    const fake = makeFakeChrome({ originCount: 2, readsSucceed: true, failEval: true });
    globalThis.chrome = fake.chrome;
    let lastStats = null;
    const section = await collectSiteData(
      (m, f, st) => { if (st) lastStats = st; },
      { scanWindowSize: 4, retryMaxAttempts: 1 }
    );
    assert.equal(fake.created.length, 2, 'K3: 2 tabs created');
    assert.deepEqual(fake.removed.sort(), fake.created.map((t) => t.id).sort(), 'K3: tabs must be closed after read exception');
    assert.equal(lastStats.slotsUsed, 0, 'K3: all slots released, got ' + lastStats.slotsUsed);
    assert.deepEqual(fake.listTabs().filter((t) => (t.url || '').includes('/__bbr_site_scan__')), [], 'K3: no scan tabs remain');
    assert.equal(section.urlStates.filter((u) => u.status === 'fetch-failed').length, 2, 'K3: both origins fetch-failed');
    console.log('PASS scenario K3: read exception — tab closed, slot released');
  }
}

// Scenario L: retry waves — a failed origin is retried with a FRESH tab, but
// the old tab is always closed first (no pile-up: peak open tabs never exceed
// the window, even across waves).
{
  // L1: all reads fail, 3 attempts -> 3 waves, 6 tabs, all closed.
  const fake = makeFakeChrome({ originCount: 2 });
  globalThis.chrome = fake.chrome;
  let lastStats = null;
  const section = await collectSiteData(
    (m, f, st) => { if (st) lastStats = st; },
    { scanWindowSize: 4, retryMaxAttempts: 3 }
  );
  assert.equal(fake.created.length, 6, 'L1: 2 origins x 3 attempts = 6 tabs, got ' + fake.created.length);
  assert.deepEqual(fake.removed.sort((a, b) => a - b), fake.created.map((t) => t.id).sort((a, b) => a - b), 'L1: every attempt tab must be closed');
  assert.ok(fake.getMaxOpen() <= 4, `L1: no pile-up across waves, peak open must be <= 4, got ${fake.getMaxOpen()}`);
  assert.equal(lastStats.slotsUsed, 0, 'L1: all slots released');
  assert.ok((section.notes || []).some((n) => n.includes('retry phase')), 'L1: retry phases must be noted');
  const failed = section.urlStates.filter((u) => u.status === 'fetch-failed');
  assert.equal(failed.length, 2, 'L1: both origins fetch-failed after exhaustion');
  assert.ok(failed.every((u) => u.attempts === 3), 'L1: 3 attempts each, got ' + JSON.stringify(failed.map((u) => u.attempts)));
  console.log('PASS scenario L1: retry waves — old tab closed before new one, no pile-up');

  // L2: first attempt fails, retry succeeds — no re-fetch needed beyond that.
  const fake2 = makeFakeChrome({ originCount: 2, readsSucceed: true, failAttachTimes: 2 });
  globalThis.chrome = fake2.chrome;
  const section2 = await collectSiteData(() => {}, { scanWindowSize: 4, retryMaxAttempts: 3 });
  assert.equal(Object.keys(section2.origins || {}).length, 2, 'L2: both origins recovered on retry');
  assert.equal(fake2.created.length, 4, 'L2: 2 origins x 2 attempts = 4 tabs, got ' + fake2.created.length);
  assert.deepEqual(fake2.removed.sort((a, b) => a - b), fake2.created.map((t) => t.id).sort((a, b) => a - b), 'L2: all tabs closed');
  assert.ok(section2.urlStates.every((u) => u.status === 'saved'), 'L2: all origins saved, got ' + JSON.stringify(section2.urlStates.map((u) => u.status)));
  console.log('PASS scenario L2: retry recovers — failed origin re-fetched with a fresh tab');
}

// Scenario M: storage retry queue — checkpoint write failures are never
// swallowed; unsaved data stays in memory; quota-full stops the crawl safely.
{
  // M1: write errors -> save-failed status, data kept in memory, not counted
  // as done, retry scheduled with backoff (noted, not silent).
  const fake = makeFakeChrome({ originCount: 2, readsSucceed: true, storageFailMode: 'error' });
  globalThis.chrome = fake.chrome;
  let lastStats = null;
  const section = await collectSiteData(
    (m, f, st) => { if (st) lastStats = st; },
    { scanWindowSize: 4, retryMaxAttempts: 1, checkpointEveryOrigins: 1 }
  );
  assert.equal(Object.keys(section.origins || {}).length, 2, 'M1: fetched data stays in memory');
  assert.equal(lastStats.fetched, 2, 'M1: 2 fetched');
  assert.equal(lastStats.done, 0, 'M1: fetched-but-unsaved must NOT count as done, got ' + lastStats.done);
  assert.ok(section.urlStates.every((u) => u.status === 'save-failed'), 'M1: all origins save-failed, got ' + JSON.stringify(section.urlStates.map((u) => u.status)));
  assert.ok((section.notes || []).some((n) => n.includes('checkpoint write failed')), 'M1: write failure must be noted, not swallowed');
  assert.ok((section.notes || []).some((n) => n.includes('retrying with backoff')), 'M1: backoff retry must be scheduled');
  console.log('PASS scenario M1: storage write failure — save-failed status, data kept in memory, retry scheduled');

  // M2: quota-full -> no blind retry; the crawl stops safely with a clear
  // warning and the data is kept (it still ships in the backup section).
  const fake2 = makeFakeChrome({ originCount: 2, readsSucceed: true, storageFailMode: 'quota' });
  globalThis.chrome = fake2.chrome;
  const section2 = await collectSiteData(() => {}, { scanWindowSize: 4, retryMaxAttempts: 1 });
  assert.equal(section2.aborted, true, 'M2: quota-full must halt the crawl');
  assert.ok((section2.notes || []).some((n) => /quota/i.test(n)), 'M2: quota warning must be noted');
  assert.equal(Object.keys(section2.origins || {}).length, 2, 'M2: data kept in memory despite quota');
  assert.deepEqual(fake2.listTabs().filter((t) => (t.url || '').includes('/__bbr_site_scan__')), [], 'M2: no scan tabs remain after quota halt');
  console.log('PASS scenario M2: quota-full — safe stop, clear warning, data kept');
}

console.log('PASS siteData streaming pipeline: hard window, single group, takeover safety, adaptive CPU');
