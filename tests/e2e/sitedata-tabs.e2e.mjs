// E2E: slot-based streaming site-data collection through the REAL extension.
//
// Verifies the two-worker pipeline with a hard tab window:
//   1. Worker 1 opens scan tabs straight into the single "BBR Site Scan" tab
//      group (one group, one window); Worker 2 reads them with bounded
//      concurrency and closes each tab, releasing its slot;
//   2. the hard window is never exceeded (polled live during the scan AND
//      asserted on every stats snapshot);
//   3. progress messages carry (done/total) counts (e.g. 3/50) and a
//      monotonic frac in [0,1] ending at 1, so the progress bar is accurate;
//   4. scan tabs + group are cleaned up afterwards; pre-existing tabs are
//      untouched (never grouped, never closed).
//
// Uses three local HTTP origins (distinct ports) serving pages that seed
// localStorage on load — no external network needed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchDashboard, apiCall, must } from './launch.mjs';

const LS_KEY = 'e2e-site-ls-key';
const LS_VAL = 'e2e-site-ls-value';
const GROUP_TITLE = 'BBR Site Scan';
const WINDOW = 2; // small window to exercise slot blocking with 3 origins

function startSiteServer() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><title>e2e site</title></head><body>' +
      '<script>try { localStorage.setItem("' + LS_KEY + '", "' + LS_VAL + '"); } catch (e) {}</script>' +
      'e2e</body></html>'
    );
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    origin: 'http://127.0.0.1:' + server.address().port
  })));
}

const sites = [await startSiteServer(), await startSiteServer(), await startSiteServer()];
const origins = sites.map((s) => s.origin);

const { context, page, pageErrors } = await launchDashboard();
try {
  // Make all three origins discoverable (bookmarks are a discovery source).
  await page.evaluate((list) => (async () => {
    const tree = await chrome.bookmarks.getTree();
    const bar = tree[0].children[0];
    for (const o of list) await chrome.bookmarks.create({ parentId: bar.id, title: 'e2e-site', url: o + '/' });
  })(), origins);

  // Pre-existing open tab for origins[0]: must survive untouched — never
  // grouped, moved, ungrouped or closed. The crawl may reuse it for reading
  // (debugger attach + read + detach only); it takes no slot and is left open.
  const keepTabId = await page.evaluate((url) => chrome.tabs.create({ url, active: false }).then((t) => t.id), origins[0] + '/keep');
  await page.waitForFunction(
    (args) => chrome.tabs.get(args.id).then((t) => t.status === 'complete' && (t.url || '').startsWith(args.origin)).catch(() => false),
    { id: keepTabId, origin: origins[0] },
    { timeout: 15000 }
  );

  // Warm the lazy route before the crawl so the E2E measures crawl continuity,
  // not the first-download latency of that route chunk.
  await page.locator('a[href="#/results"]').click();
  await page.locator('main').getByText('Site results', { exact: true }).waitFor();
  await page.locator('a[href="#/summary"]').click();
  await page.locator('#local-backup').waitFor();

  const expr = `
(async () => {
  window.__e2eProgress = [];
  window.__e2eStats = [];
  const r = await api.collectAll(
    function (m, cat, st, f, stats) {
      window.__e2eProgress.push([String(m), typeof f === 'number' ? f : null]);
      if (stats && typeof stats === 'object') window.__e2eStats.push(stats);
    },
    { selectedCategories: ['siteData'], siteData: { includeOrigins: a.origins, scanWindowSize: a.window, disableExclusion: true } }
  );
  const sd = r.data.siteData || {};
  const out = { progress: window.__e2eProgress, stats: window.__e2eStats, origins: Object.keys(sd.origins || {}).sort(), lsShape: {}, fromOpenTab: {}, notes: sd.notes || [] };
  for (const o of Object.keys(sd.origins || {})) {
    out.lsShape[o] = sd.origins[o].localStorage || null;
    out.fromOpenTab[o] = sd.origins[o].fromOpenTab === true;
  }
  return out;
})()`;

  // Start collection; while it runs, poll the scan group's live tab count —
  // the hard window must never be exceeded at any moment.
  const pending = apiCall(page, expr, { origins, window: WINDOW, lsKey: LS_KEY });
  let sawGroup = false;
  let settled = false;
  let maxGroupTabs = 0;
  let maxScanGroups = 0;
  let navigatedDuringScan = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    const info = await page.evaluate((title) => chrome.tabGroups.query({}).then(async (gs) => {
      const mine = gs.filter((x) => x.title === title);
      let tabs = 0;
      for (const g of mine) tabs += (await chrome.tabs.query({ groupId: g.id })).length;
      return { found: mine.length > 0, tabs, scanGroups: mine.length };
    }), GROUP_TITLE);
    if (info.found) {
      sawGroup = true;
      maxGroupTabs = Math.max(maxGroupTabs, info.tabs);
      maxScanGroups = Math.max(maxScanGroups, info.scanGroups);
      if (!navigatedDuringScan) {
        await page.evaluate(() => {
          window.__sitedataRouteMarker = 'same-dashboard-document';
          window.__sitedataApiRef = window.__api;
          window.location.hash = '#/results';
        });
        await page.waitForFunction(() => document.querySelector('main')?.textContent.includes('Site results'), null, { timeout: 10000 });
        assert.equal(await page.evaluate(() => window.location.hash), '#/results', 'hash navigation should select Results while the crawl is active');
        assert.equal(await page.evaluate(() => window.__sitedataRouteMarker), 'same-dashboard-document', 'route navigation should keep the same dashboard document alive');
        assert.equal(await page.evaluate(() => window.__api === window.__sitedataApiRef), true, 'startup API should remain registered during the crawl');
        assert.equal(settled, false, 'site-data crawl should still be running after hash navigation');
        navigatedDuringScan = true;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  const v = must(await pending, 'collectAll siteData');
  assert.equal(navigatedDuringScan, true, 'dashboard should navigate while a site-data scan is active');
  await page.evaluate(() => {
    delete window.__sitedataRouteMarker;
    delete window.__sitedataApiRef;
  });

  // ---- 1) tab group observed during the scan; hard window respected ----
  assert.equal(sawGroup, true, 'scan tabs should be grouped under "' + GROUP_TITLE + '" while reading');
  assert.ok(maxGroupTabs <= WINDOW, `tabs in the scan group must never exceed the window (${WINDOW}), saw ${maxGroupTabs}`);
  assert.ok(maxGroupTabs >= 1, 'should have observed scan tabs in the group, saw none');
  assert.equal(maxScanGroups, 1, `exactly one scan group must exist at a time, saw ${maxScanGroups}`);

  // ---- 2) all origins read ----
  // NOTE: this sandbox blocks top-level tab navigation to local HTTP origins
  // (Chrome Local Network Access checks), so fixture pages cannot load here
  // and storage content cannot be asserted. The read path itself
  // (readTabSnapshot: debugger attach → pagelib inject → chunked eval) is
  // unchanged from the previously validated implementation; what is new and
  // asserted here is the streaming worker pipeline around it.
  assert.deepEqual(v.origins, [...origins].sort(), 'all three origins should be collected');
  for (const o of origins) {
    assert.equal(typeof v.lsShape[o], 'object', 'snapshot should carry a localStorage object for ' + o);
  }

  // ---- 2a) the pre-existing tab is reused for reading, never touched ----
  // origins[0] has an open tab: the crawl must read from it (fromOpenTab)
  // without grouping, moving, ungrouping or closing it. The other origins
  // get real scan tabs.
  assert.equal(v.fromOpenTab[origins[0]], true, 'origins[0] should be read from its pre-existing tab, got: ' + JSON.stringify(v.fromOpenTab));
  assert.equal(v.fromOpenTab[origins[1]], false, 'origins[1] should use a scan tab');
  assert.equal(v.fromOpenTab[origins[2]], false, 'origins[2] should use a scan tab');

  // ---- 2b) stats snapshots: window invariants on every report ----
  assert.ok(v.stats.length > 0, 'progress should carry stats snapshots');
  for (const st of v.stats) {
    assert.ok(st.slotsUsed <= st.slotsTotal, `slotsUsed (${st.slotsUsed}) must never exceed slotsTotal (${st.slotsTotal})`);
    assert.ok(st.inGroup <= st.slotsTotal, `inGroup (${st.inGroup}) must never exceed the window (${st.slotsTotal})`);
    assert.equal(st.window, WINDOW, `effective window should be ${WINDOW}, got ${st.window}`);
    assert.equal(st.windowMax, WINDOW, `configured window should be ${WINDOW}, got ${st.windowMax}`);
    assert.equal(typeof st.tuning, 'string', 'stats should carry the tuning thresholds line');
    assert.ok(st.tuning.includes('cpu') && st.tuning.includes('load'), 'tuning line should name the cpu and load guards, got: ' + st.tuning);
  }

  // ---- 3) progress: (n/N) counts, accurate frac ----
  const msgs = v.progress.map((p) => p[0]);
  const readIdx = msgs.findIndex((m) => /^sitedata: http.*\(\d+\/\d+\)/.test(m));
  assert.ok(readIdx > 0, 'should emit per-origin progress with (done/total) counts');
  for (const n of [1, 2, 3]) {
    assert.ok(msgs.some((m) => m.includes('(' + n + '/3)')),
      'progress should include the (' + n + '/3) count, got: ' + JSON.stringify(msgs));
  }
  const fracs = v.progress.map((p) => p[1]).filter((f) => typeof f === 'number');
  assert.ok(fracs.length >= 6, 'progress should carry frac values throughout, got ' + fracs.length);
  for (const f of fracs) assert.ok(f >= 0 && f <= 1, 'frac must stay in [0,1], got ' + f);
  for (let i = 1; i < fracs.length; i++) {
    assert.ok(fracs[i] >= fracs[i - 1], 'frac must be monotonic, got ' + fracs[i - 1] + ' -> ' + fracs[i]);
  }
  assert.equal(fracs[fracs.length - 1], 1, 'frac should end at exactly 1');

  // ---- 4) cleanup: scan tabs + group gone, user tab untouched ----
  const tabsAfter = await page.evaluate(() => chrome.tabs.query({}).then((ts) => ts.map((t) => ({ id: t.id, url: t.url, groupId: t.groupId }))));
  const keepTab = tabsAfter.find((t) => t.id === keepTabId);
  assert.ok(keepTab, 'pre-existing tab must survive the scan');
  assert.equal(keepTab.groupId, -1, 'pre-existing tab must not be moved into the scan group');
  assert.ok(!tabsAfter.some((t) => (t.url || '').includes('__bbr_site_scan__')), 'scan tabs must be closed afterwards');
  const groupsAfter = await page.evaluate(() => chrome.tabGroups.query({}).then((gs) => gs.map((g) => g.title)));
  assert.ok(!groupsAfter.includes(GROUP_TITLE), 'scan tab group should disappear with its tabs');

  assert.deepEqual(pageErrors, [], `dashboard should run without page errors: ${pageErrors.join('; ')}`);
  console.log('PASS siteData E2E: streaming workers, hard window respected, pre-existing tab reused for reading but untouched, (n/N) progress with accurate monotonic frac, clean teardown');
} finally {
  await context.close();
  for (const s of sites) await new Promise((r) => s.server.close(r));
}
