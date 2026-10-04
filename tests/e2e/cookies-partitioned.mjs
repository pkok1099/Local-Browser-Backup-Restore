// E2E: cookie wildcard (partitionKey:{}) with a REAL partitioned cookie.
//
// Sets one plain + one partitioned (CHIPS) cookie on a local origin, runs the
// backup's cookie collection, and asserts:
//   1. the partitioned cookie is actually backed up (not silently dropped);
//   2. the wildcard result is a superset of the legacy candidate-scan oracle
//      (kept as ground truth during the transition — the empty-object form
//      has a history of version-specific bugs, e.g. Chrome 126/128).
//
// This test validates the behavior on the Chrome version running the scan
// right now; a green run here is the evidence the wildcard works here.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { launchDashboard, apiCall } from './launch.mjs';

const PLAIN = 'e2e-cookie-plain';
const CHIPS = 'e2e-cookie-chips';

const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('cookie probe');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + server.address().port;

const { context, page, pageErrors } = await launchDashboard();
try {
  // Set one plain + one partitioned cookie via the real API.
  const setup = await page.evaluate(async (u) => {
    const out = {};
    try {
      await chrome.cookies.set({
        url: u,
        name: 'e2e-cookie-plain',
        value: 'p1',
      });
      out.plain = 'ok';
    } catch (e) {
      out.plain = 'ERR:' + e.message;
    }
    try {
      await chrome.cookies.set({
        url: u,
        name: 'e2e-cookie-chips',
        value: 'c1',
        secure: true,
        sameSite: 'no_restriction',
        partitionKey: { topLevelSite: u },
      });
      out.partitioned = 'ok';
    } catch (e) {
      out.partitioned = 'ERR:' + e.message;
    }
    return out;
  }, url);
  assert.equal(setup.plain, 'ok', 'plain cookie setup: ' + setup.plain);
  assert.equal(
    setup.partitioned,
    'ok',
    'partitioned cookie setup: ' + setup.partitioned
  );
  console.log('PASS cookie setup: plain + partitioned');

  // Run the backup's cookie collection.
  const res = await apiCall(
    page,
    `(async () => {
      const r = await api.collectAll(function(){}, { selectedCategories: a.cats });
      const sec = (r.data && r.data.cookies) || {};
      return { cookies: sec.cookies || [], notes: sec.notes || [] };
    })()`,
    { cats: ['cookies'] }
  );
  assert.equal(res.ok, true, 'collectAll should succeed: ' + res.message);
  const cookies = res.value.cookies;
  const names = cookies
    .filter((c) => c.name.startsWith('e2e-cookie'))
    .map((c) => c.name)
    .sort();
  assert.deepEqual(
    names,
    [CHIPS, PLAIN],
    'both cookies backed up, got: ' + JSON.stringify(names)
  );
  console.log('PASS partitioned cookie backed up via wildcard');

  const chips = cookies.find((c) => c.name === CHIPS);
  assert.ok(
    chips.partitionKey && chips.partitionKey.topLevelSite,
    'partitionKey preserved in backup'
  );
  console.log(
    'PASS partitionKey preserved, topLevelSite=' +
      chips.partitionKey.topLevelSite
  );

  // Equivalence oracle: legacy candidate-scan path, run independently.
  const oracle = await page.evaluate(async (u) => {
    const stores = await chrome.cookies.getAllCookieStores();
    const st = stores.find((s) => s.id === '0');
    const plain = await chrome.cookies.getAll({ storeId: st.id });
    const part = await chrome.cookies.getAll({
      storeId: st.id,
      partitionKey: { topLevelSite: u },
    });
    const key = (c) =>
      `${c.name}|${c.domain}|${c.path}|${JSON.stringify(c.partitionKey ?? null)}`;
    const seen = new Set(plain.map(key));
    const merged = [...plain];
    for (const c of part) {
      if (!seen.has(key(c))) {
        seen.add(key(c));
        merged.push(c);
      }
    }
    return merged
      .filter((c) => c.name.startsWith('e2e-cookie'))
      .map(key)
      .sort();
  }, url);
  const backupKeys = cookies
    .filter((c) => c.name.startsWith('e2e-cookie'))
    .map(
      (c) =>
        `${c.name}|${c.domain}|${c.path}|${JSON.stringify(c.partitionKey ?? null)}`
    )
    .sort();
  const missing = oracle.filter((k) => !backupKeys.includes(k));
  assert.deepEqual(
    missing,
    [],
    'wildcard result is a superset of the legacy oracle, missing: ' +
      JSON.stringify(missing)
  );
  console.log('PASS wildcard superset of legacy candidate-scan oracle');

  // Cleanup.
  await page.evaluate(async (u) => {
    await chrome.cookies.remove({ url: u, name: 'e2e-cookie-plain' });
    await chrome.cookies.remove({ url: u, name: 'e2e-cookie-chips' });
  }, url);

  assert.equal(
    pageErrors.length,
    0,
    'zero page errors: ' + pageErrors.join('; ')
  );
  console.log(
    'PASS cookies E2E: partitioned cookie backed up, oracle equivalence holds'
  );
  console.log(
    'Chrome version:',
    await page.evaluate(() => navigator.userAgent.match(/Chrome\/(\d+)/)?.[1])
  );
} finally {
  server.close();
  await context.close();
}
