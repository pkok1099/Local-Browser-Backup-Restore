// E2E: lightweight scan mode (subresource blocking) through the REAL extension.
//
// Verifies that with declarativeNetRequest session rules active:
//   1. heavy origin: images/scripts/css/fonts/fetch are NEVER requested during
//      the crawl (the blocking proof), while localStorage is still read fully;
//   2. redirect origin: marker -> 302 -> landing; tab still closes, no leak;
//   3. service-worker origin: a registered SW does not break the read;
//   4. big-IndexedDB origin: ~5MB across 100 records is backed up completely.
// Also asserts no scan-range DNR session rules are left behind, and records
// the crawl duration for before/after comparison.
//
// Seeding (localStorage / IndexedDB / SW registration) happens in a separate
// phase with NORMAL tabs (scripts allowed) — mirroring production, where the
// data persists from the user's real browsing and the scan only reads it.
// The crawl itself must never execute the page's scripts.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchDashboard, apiCall } from './launch.mjs';

const LS_KEY = 'e2e-block-ls';
const LS_VAL = 'e2e-block-value';
const IDB_DB = 'e2e-block-db';
const IDB_RECORDS = 100;
const IDB_RECORD_BYTES = 50 * 1024; // ~5MB total

function startServer(handler) {
  const counts = new Map();
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    counts.set(path, (counts.get(path) || 0) + 1);
    handler(path, req, res);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        origin: 'http://127.0.0.1:' + server.address().port,
        counts,
        count: (p) => counts.get(p) || 0,
      })
    )
  );
}

const ok = (res, type = 'text/html; charset=utf-8') =>
  res.writeHead(200, { 'Content-Type': type });

// 1. Heavy origin: marker page references many subresources.
const heavy = await startServer((path, req, res) => {
  if (path === '/seed') {
    ok(res);
    res.end(
      `<script>try{localStorage.setItem('${LS_KEY}','${LS_VAL}')}catch(e){}document.title='seeded'</script>`
    );
  } else if (path === '/__bbr_site_scan__') {
    ok(res);
    res.end(
      '<!doctype html><html><head>' +
        '<link rel="stylesheet" href="/app.css">' +
        '<script src="/app.js"></script>' +
        '</head><body>' +
        '<img src="/img1.png"><img src="/img2.png"><img src="/img3.png">' +
        '<script>fetch("/api/ping").catch(()=>{})</script>' +
        'heavy</body></html>'
    );
  } else if (path === '/verify') {
    ok(res);
    res.end('<!doctype html><html><body>verify</body></html>');
  } else {
    ok(res, 'application/octet-stream');
    res.end('x'.repeat(128));
  }
});
const HEAVY_SUBS = ['/app.css', '/app.js', '/img1.png', '/img2.png', '/img3.png', '/api/ping'];

// 2. Redirect origin: marker 302s to /landing (same origin).
const redir = await startServer((path, req, res) => {
  if (path === '/seed') {
    ok(res);
    res.end(
      `<script>try{localStorage.setItem('${LS_KEY}','redir')}catch(e){}document.title='seeded'</script>`
    );
  } else if (path === '/__bbr_site_scan__') {
    res.writeHead(302, { Location: '/landing' });
    res.end();
  } else {
    ok(res);
    res.end('landed');
  }
});

// 3. Service-worker origin.
const sw = await startServer((path, req, res) => {
  if (path === '/seed') {
    ok(res);
    res.end(
      `<script>(async()=>{try{localStorage.setItem('${LS_KEY}','sw');` +
        `await navigator.serviceWorker.register('/sw.js');}catch(e){}document.title='seeded'})()</script>`
    );
  } else if (path === '/sw.js') {
    ok(res, 'application/javascript');
    res.end(`self.addEventListener('fetch',()=>{});`);
  } else {
    ok(res);
    res.end('sw origin');
  }
});

// 4. Big IndexedDB origin.
const bigidb = await startServer((path, req, res) => {
  if (path === '/seed') {
    ok(res);
    res.end(
      `<script>(async()=>{` +
        `const db=await new Promise((res,rej)=>{const r=indexedDB.open('${IDB_DB}',1);` +
        `r.onupgradeneeded=()=>r.result.createObjectStore('s');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});` +
        `const tx=db.transaction('s','readwrite');const st=tx.objectStore('s');` +
        `for(let i=0;i<${IDB_RECORDS};i++)st.put('v'.repeat(${IDB_RECORD_BYTES}),'k'+i);` +
        `await new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=()=>rej(tx.error)});` +
        `document.title='seeded'})()</script>`
    );
  } else {
    ok(res);
    res.end('bigidb origin');
  }
});

const servers = [heavy, redir, sw, bigidb];
// Expected localStorage seed per server (null = seeds no localStorage).
heavy.expectLs = { key: LS_KEY, val: LS_VAL };
redir.expectLs = { key: LS_KEY, val: 'redir' };
sw.expectLs = { key: LS_KEY, val: 'sw' };
bigidb.expectLs = null;
bigidb.expectIdbCount = IDB_RECORDS;
const origins = servers.map((s) => s.origin);

const { context, page, pageErrors } = await launchDashboard();
try {
  // Make all origins discoverable via bookmarks (discovery source).
  await page.evaluate((list) => (async () => {
    const tree = await chrome.bookmarks.getTree();
    const bar = tree[0].children[0];
    for (const o of list) await chrome.bookmarks.create({ parentId: bar.id, title: 'e2e-block', url: o + '/' });
  })(), origins);

  // ---- seed phase: normal tabs, scripts allowed ----
  // Verification is two-layer: first in the seed tab (MAIN world), then from
  // a FRESH tab — the seed renderer's cache can mask a write that hasn't
  // flushed to the storage service yet, and closing the tab first can lose it.
  const checkLs = (tid, key, val) =>
    page.evaluate(
      (args) =>
        chrome.scripting
          .executeScript({
            target: { tabId: args.id },
            world: 'MAIN',
            func: (k, v) => {
              try {
                return localStorage.getItem(k) === v;
              } catch (e) {
                return false;
              }
            },
            args: [args.key, args.val],
          })
          .then((r) => r[0].result)
          .catch(() => false),
      { id: tid, key, val }
    );
  const checkIdbCount = (tid, dbName, expected) =>
    page.evaluate(
      (args) =>
        chrome.scripting
          .executeScript({
            target: { tabId: args.id },
            world: 'MAIN',
            func: async (db, exp) => {
              try {
                const d = await new Promise((res, rej) => {
                  const r = indexedDB.open(db);
                  r.onsuccess = () => res(r.result);
                  r.onerror = () => rej(r.error);
                });
                const n = await new Promise((res, rej) => {
                  const q = d
                    .transaction('s', 'readonly')
                    .objectStore('s')
                    .count();
                  q.onsuccess = () => res(q.result);
                  q.onerror = () => rej(q.error);
                });
                d.close();
                return n === exp;
              } catch (e) {
                return false;
              }
            },
            args: [args.dbName, args.expected],
          })
          .then((r) => r[0].result)
          .catch(() => false),
      { id: tid, dbName, expected }
    );
  const closeTab = (tid) =>
    page
      .evaluate((id) => chrome.tabs.remove(id).catch(() => {}), tid)
      .catch(() => {});
  for (const s of servers) {
    const tabId = await page.evaluate(
      (url) => chrome.tabs.create({ url, active: false }).then((t) => t.id),
      s.origin + '/seed'
    );
    await page.waitForFunction(
      (args) =>
        chrome.tabs
          .get(args.id)
          .then((t) => t.title === 'seeded')
          .catch(() => false),
      { id: tabId },
      { timeout: 30000 }
    );
    if (s.expectLs) {
      assert.equal(
        await checkLs(tabId, s.expectLs.key, s.expectLs.val),
        true,
        `seed verification failed for ${s.origin}/seed`
      );
    }
    if (s.expectIdbCount) {
      assert.equal(
        await checkIdbCount(tabId, IDB_DB, s.expectIdbCount),
        true,
        `IDB seed verification failed for ${s.origin}/seed`
      );
    }
    // NOTE: seed tab stays open during fresh-tab verification below — closing
    // it first can destroy the renderer mid-flush and lose the write.
    // Fresh-tab re-verification with polling: proves persistence in the
    // storage service, not just the seed renderer's cache.
    if (s.expectLs) {
      const vtab = await page.evaluate(
        (url) => chrome.tabs.create({ url, active: false }).then((t) => t.id),
        s.origin + '/verify'
      );
      await page.waitForFunction(
        (args) =>
          chrome.tabs
            .get(args.id)
            .then((t) => t.status === 'complete')
            .catch(() => false),
        { id: vtab },
        { timeout: 15000 }
      );
      let persisted = false;
      for (let i = 0; i < 10 && !persisted; i++) {
        persisted = await checkLs(vtab, s.expectLs.key, s.expectLs.val);
        if (!persisted) await new Promise((r) => setTimeout(r, 1000));
      }
      await closeTab(vtab);
      assert.equal(
        persisted,
        true,
        `seed did not persist for ${s.origin} (renderer cache vs storage service race)`
      );
    }
    await closeTab(tabId);
  }
  console.log('PASS seed phase: storage seeded in normal tabs');

  const tabsBefore = await page.evaluate(() =>
    chrome.tabs.query({}).then((ts) => ts.map((t) => t.id).sort())
  );
  const heavyBefore = HEAVY_SUBS.map((p) => heavy.count(p));

  // ---- crawl phase: blocking active ----
  const t0 = Date.now();
  const expr = `
(async () => {
  const r = await api.collectAll(
    function () {},
    { selectedCategories: ['siteData'], siteData: { includeOrigins: a.origins, scanWindowSize: 2, disableExclusion: true } }
  );
  const sd = r.data.siteData || {};
  const out = { origins: {}, notes: sd.notes || [] };
  for (const o of Object.keys(sd.origins || {})) {
    const snap = sd.origins[o];
    out.origins[o] = {
      ls: snap.localStorage || null,
      idbStores: (snap.indexedDB || []).map((d) => ({
        name: d.name,
        stores: (d.stores || []).map((s) => ({
          name: s.name,
          count: (s.records || []).length,
        })),
      })),
    };
  }
  return out;
})()`;
  const res = await apiCall(page, expr, { origins });
  const crawlMs = Date.now() - t0;
  assert.equal(res.ok, true, 'crawl should succeed: ' + res.message);
  console.log(`crawl duration with blocking: ${crawlMs}ms`);

  // ---- 1. heavy: subresources never requested during the crawl ----
  const heavyAfter = HEAVY_SUBS.map((p) => heavy.count(p));
  assert.deepEqual(
    heavyAfter,
    heavyBefore,
    `no subresource requests during crawl (before ${heavyBefore}, after ${heavyAfter})`
  );
  console.log('PASS blocking: zero subresource requests during crawl');
  const heavySnap = res.value.origins[heavy.origin];
  if (!heavySnap) {
    console.log(
      'notes mentioning heavy:',
      JSON.stringify(
        res.value.notes.filter((n) => n.includes(String(heavy.server.address().port))).slice(-6)
      ).slice(0, 1500)
    );
    console.log(
      'all origin keys:',
      JSON.stringify(Object.keys(res.value.origins))
    );
  }
  console.log(
    'heavy snapshot keys:',
    heavySnap ? Object.keys(heavySnap.ls || {}).slice(0, 5) : 'MISSING ORIGIN'
  );
  assert.equal(
    heavySnap && heavySnap.ls[LS_KEY],
    LS_VAL,
    'heavy origin localStorage still read fully with blocking'
  );
  console.log('PASS heavy origin data intact with blocking');

  // ---- 2. redirect: no leak, tab closed ----
  const tabsAfter = await page.evaluate(() =>
    chrome.tabs.query({}).then((ts) => ts.map((t) => t.id).sort())
  );
  assert.deepEqual(tabsAfter, tabsBefore, 'redirect must not leak tabs');
  const markerTabs = await page.evaluate(() =>
    chrome.tabs
      .query({})
      .then((ts) => ts.filter((t) => (t.url || '').includes('__bbr_site_scan__')))
  );
  assert.equal(markerTabs.length, 0, 'no scan-marker tabs left behind');
  console.log('PASS redirect origin: no leaks with blocking');

  // ---- 3. service worker: read works ----
  const swSnap = res.value.origins[sw.origin];
  if (!swSnap) {
    console.log(
      'SW notes:',
      JSON.stringify(
        res.value.notes.filter((n) =>
          n.includes(String(sw.server.address().port))
        ).slice(-8)
      ).slice(0, 2000)
    );
  }
  assert.equal(
    res.value.origins[sw.origin].ls[LS_KEY],
    'sw',
    'SW origin localStorage read with blocking'
  );
  console.log('PASS service-worker origin read with blocking');

  // ---- 4. big IndexedDB: all records backed up ----
  const stores = res.value.origins[bigidb.origin].idbStores;
  const total = stores.reduce(
    (acc, d) => acc + d.stores.reduce((a, s) => a + s.count, 0),
    0
  );
  assert.equal(
    total,
    IDB_RECORDS,
    `all ${IDB_RECORDS} IDB records backed up, got ${total}`
  );
  console.log(`PASS big IndexedDB (${IDB_RECORDS} records) intact with blocking`);

  // ---- no leftover DNR rules ----
  const leftover = await page.evaluate(() =>
    chrome.declarativeNetRequest
      .getSessionRules()
      .then((rs) => rs.filter((r) => r.id >= 1000000).map((r) => r.id))
  );
  assert.deepEqual(leftover, [], 'no scan blocking rules left behind');
  console.log('PASS no leftover DNR session rules');

  assert.equal(pageErrors.length, 0, 'zero page errors: ' + pageErrors.join('; '));
  console.log('PASS siteData E2E blocking: subresources blocked, data intact, no leaks');
} finally {
  for (const s of servers) s.server.close();
  await context.close();
}
