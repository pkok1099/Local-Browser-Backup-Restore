// Extension UI + behavior test for the WXT-built MV3 extension.
// Adapted from the original tests/mobile-ui.mjs: instead of injecting static
// HTML/CSS, it loads the REAL built extension (.output/chrome-mv3) in Chromium
// and exercises the React dashboard: mobile layout, weekly/daily schedule
// toggle, token-safe settings import/export, retry status + cancel, restore
// and password flows.
import assert from 'node:assert/strict';
import { cp, copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { newBackupSkeleton, finalizeIntegrity } from '../src/lib/format.js';

const root = resolve(import.meta.dirname, '..');
const buildDir = resolve(root, '.output/chrome-mv3');

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ['--no-sandbox'],
  headless: !!process.env.CI_HEADLESS, // run under xvfb-run (headless:false) or set CI_HEADLESS=1
});

try {
  console.log(`Playwright Chromium ${browser.version()}`);

  // ---- static build checks ----
  const manifest = JSON.parse(
    await readFile(resolve(buildDir, 'manifest.json'), 'utf8')
  );
  const background = await readFile(resolve(buildDir, 'background.js'), 'utf8');
  assert.equal(manifest.manifest_version, 3, 'MV3 manifest');
  assert.equal(
    manifest.action?.default_popup,
    undefined,
    'toolbar action should not open a popup'
  );
  assert.match(
    background,
    /chrome\.action\.onClicked\.addListener/,
    'toolbar action should open the dashboard from the background worker'
  );
  assert.ok(
    await readFile(resolve(buildDir, 'lib/pagelib.js'), 'utf8'),
    'pagelib.js must ship at the extension root for scripting injection'
  );
  console.log('PASS built manifest + background + pagelib checks');

  // ---- live extension checks (real React dashboard) ----
  const extensionContext = await chromium.launchPersistentContext('', {
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
    headless: !!process.env.CI_HEADLESS,
    viewport: { width: 390, height: 844 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--no-sandbox',
      `--disable-extensions-except=${buildDir}`,
      `--load-extension=${buildDir}`,
    ],
  });
  try {
    const worker =
      extensionContext.serviceWorkers()[0] ||
      (await extensionContext.waitForEvent('serviceworker', {
        timeout: 15000,
      }));
    const extensionId = new URL(worker.url()).host;
    const page = await extensionContext.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    // Route-only UI chunks must stay off the initial route and load on demand.
    // Compare request sets instead of relying on generated chunk filenames.
    const extensionPrefix = `chrome-extension://${extensionId}/`;
    const dashboardScripts = [];
    const scriptBodyBytes = new Map();
    const scriptBodyReads = [];
    page.on('request', (request) => {
      if (
        request.resourceType() === 'script' &&
        request.url().startsWith(extensionPrefix)
      ) {
        dashboardScripts.push(request.url());
      }
    });
    page.on('response', (response) => {
      const request = response.request();
      if (
        request.resourceType() === 'script' &&
        request.url().startsWith(extensionPrefix)
      ) {
        scriptBodyReads.push(
          response
            .body()
            .then((body) => scriptBodyBytes.set(request.url(), body.byteLength))
            .catch(() => {})
        );
      }
    });
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );
    await page.locator('#local-backup').waitFor();
    await page.waitForFunction(() => typeof window.__api === 'object');
    await page.evaluate(() => {
      window.__dashboardApiRef = window.__api;
    });
    // Let startup idle work settle, then measure scripts fetched before navigation.
    await page.waitForTimeout(1800);
    await Promise.all(scriptBodyReads);
    const initialScripts = new Set(dashboardScripts);
    assert.ok(
      initialScripts.size > 0,
      'dashboard entry script should load on the initial route'
    );
    const routeChunkPattern =
      /\/chunks\/(?:SettingsPage|ResultsPage|FailuresPage|LogPage|MorePage)-/;
    assert.deepEqual(
      [...initialScripts].filter((url) => routeChunkPattern.test(url)),
      [],
      'noninitial route chunks must not load before navigation'
    );
    const missingInitialSizes = [...initialScripts].filter(
      (url) => !scriptBodyBytes.has(url)
    );
    assert.deepEqual(
      missingInitialSizes,
      [],
      'every initial dashboard script should have a measured response body'
    );
    const initialScriptBytes = [...initialScripts].reduce(
      (total, url) => total + scriptBodyBytes.get(url),
      0
    );
    assert.ok(
      initialScriptBytes <= 300 * 1024,
      `initial dashboard JavaScript should stay around 300 KiB or less; measured ${initialScriptBytes} bytes`
    );
    console.log(
      `PASS startup JavaScript payload: ${initialScriptBytes} bytes; noninitial route chunks absent`
    );

    const legacySiteLogRows = [
      {
        seq: 41,
        ts: 1790900000001,
        crawlId: 'legacy-crawl-1',
        level: 'INFO',
        category: 'W1',
        message: 'legacy migrated log one',
        corr: 'legacy-corr-1',
        url: 'https://legacy-one.example/',
        context: { tabId: 41, attempt: 2, custom: 'kept' },
      },
      {
        seq: 42,
        ts: 1790900000002,
        crawlId: 'legacy-crawl-2',
        level: 'WARN',
        category: 'STORAGE',
        message: 'legacy migrated log two',
        corr: null,
        url: null,
        context: { error: 'legacy-error', nested: { preserved: true } },
      },
    ];
    await page.evaluate(
      async ({ rows, tabIds }) => {
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('bbr-site-log', 1);
          request.onupgradeneeded = () => {
            const store = request.result.createObjectStore('entries', {
              keyPath: 'seq',
              autoIncrement: true,
            });
            store.createIndex('ts', 'ts', { unique: false });
            store.createIndex('level', 'level', { unique: false });
            store.createIndex('category', 'category', { unique: false });
            store.createIndex('corr', 'corr', { unique: false });
            store.createIndex('crawlId', 'crawlId', { unique: false });
          };
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            if (db.version !== 1 || !db.objectStoreNames.contains('entries')) {
              db.close();
              reject(
                new Error(`expected a v1 entries database, got v${db.version}`)
              );
              return;
            }
            const tx = db.transaction('entries', 'readwrite');
            for (const row of rows) tx.objectStore('entries').add(row);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = () => {
              const error = tx.error || new Error('failed to seed v1 site log');
              db.close();
              reject(error);
            };
          };
        });
        await chrome.storage.local.set({
          'bbr:site-data-owned-tabs': { tabIds },
        });
      },
      { rows: legacySiteLogRows, tabIds: [2147483000, 2147483001] }
    );
    await page.reload();
    await page.locator('#local-backup').waitFor();
    await page.waitForFunction(() => typeof window.__api === 'object');
    await page.evaluate(() => {
      window.__dashboardApiRef = window.__api;
    });
    await page.waitForFunction(async () => {
      const kv = await chrome.storage.local.get('bbr:site-data-owned-tabs');
      return !kv['bbr:site-data-owned-tabs'];
    });
    await page.waitForTimeout(1800);

    const visitLazyRoute = async (hash, ready, label) => {
      const before = new Set(dashboardScripts);
      const chunkRequest = page.waitForRequest(
        (request) =>
          request.resourceType() === 'script' &&
          request.url().startsWith(extensionPrefix) &&
          !before.has(request.url()),
        { timeout: 10000 }
      );
      await page.locator(`a[href="${hash}"]`).click();
      await chunkRequest;
      await ready();
      const after = new Set(dashboardScripts);
      assert.ok(
        after.size > before.size,
        `${label} route should request a deferred script after navigation`
      );
    };
    await visitLazyRoute(
      '#/settings',
      () =>
        page.waitForFunction(() =>
          document.body.textContent.includes('Website data — retry')
        ),
      'Settings'
    );
    await visitLazyRoute(
      '#/results',
      () =>
        page
          .locator('main')
          .getByText('Site results', { exact: true })
          .waitFor(),
      'Results'
    );
    await visitLazyRoute(
      '#/failures',
      () =>
        page.locator('main').getByText('Failures', { exact: true }).waitFor(),
      'Failures'
    );
    await visitLazyRoute(
      '#/more',
      () => page.locator('#cloud-only-backup').waitFor(),
      'More'
    );
    // Previously shared Indonesian hashes should resolve to English routes.
    await page.evaluate(() => {
      window.location.hash = '#/pengaturan';
    });
    await page.waitForFunction(() => location.hash === '#/settings');
    await page
      .locator('main')
      .getByText('Website data — retry & timeout', { exact: true })
      .waitFor();
    await page
      .locator('[data-toaster-ready]')
      .waitFor({ state: 'attached', timeout: 10000 });
    await visitLazyRoute(
      '#/log',
      () =>
        page.waitForFunction(
          () =>
            document
              .querySelector('#log')
              ?.textContent.includes('dashboard ready'),
          null,
          { timeout: 15000 }
        ),
      'Log'
    );
    assert.equal(
      await page.evaluate(() => window.__api === window.__dashboardApiRef),
      true,
      'synchronous startup API hook should survive hash navigation'
    );
    await page.getByText('legacy migrated log one', { exact: true }).waitFor();
    await page.getByText('legacy migrated log two', { exact: true }).waitFor();
    const legacyMigration = await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('bbr-site-log');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const version = db.version;
      const stores = [...db.objectStoreNames];
      if (!stores.includes('entries-v2')) {
        db.close();
        return {
          version,
          stores,
          canonical: null,
          legacy: null,
          metadata: null,
        };
      }
      const sourceNames = ['entries-v2', 'entries', 'metadata'].filter((name) =>
        stores.includes(name)
      );
      const tx = db.transaction(sourceNames, 'readonly');
      const readAll = (name) =>
        new Promise((resolve, reject) => {
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const [canonical, legacy, metadataRows] = await Promise.all([
        readAll('entries-v2'),
        stores.includes('entries') ? readAll('entries') : Promise.resolve(null),
        stores.includes('metadata')
          ? readAll('metadata')
          : Promise.resolve(null),
      ]);
      db.close();
      canonical.sort((a, b) => a.seq - b.seq);
      const metadata = metadataRows
        ? Object.fromEntries(metadataRows.map(({ key, value }) => [key, value]))
        : null;
      return { version, stores, canonical, legacy, metadata };
    });
    assert.equal(
      legacyMigration.version,
      3,
      'opening the Log route should upgrade the database to v3'
    );
    assert.ok(
      legacyMigration.stores.includes('entries-v2'),
      'v2 canonical store should exist'
    );
    assert.ok(
      legacyMigration.stores.includes('metadata'),
      'v3 metadata store should exist'
    );
    assert.deepEqual(
      legacyMigration.canonical,
      legacySiteLogRows.map((row) => ({ ...row, id: `legacy:${row.seq}` })),
      'migration should keep every legacy field and assign deterministic IDs'
    );
    assert.deepEqual(
      legacyMigration.legacy,
      legacySiteLogRows,
      'legacy rows remain intact as the migration source'
    );
    assert.deepEqual(
      legacyMigration.metadata,
      { nextSequence: 0, clearWatermark: 0 },
      'v1→v3 migration should initialize ordering metadata without changing legacy rows'
    );
    assert.equal(
      new Set(legacyMigration.canonical.map((row) => row.id)).size,
      2,
      'migrated IDs should be distinct'
    );

    const siteLogChunkForV2Upgrade = (
      await readdir(join(buildDir, 'chunks'))
    ).find((name) => name.startsWith('site-log-'));
    const v2Upgrade = await page.evaluate(async (chunkName) => {
      const testDbName = 'bbr-site-log-v2-upgrade-test';
      const createIndexes = (store) => {
        for (const name of ['ts', 'level', 'category', 'corr', 'crawlId'])
          store.createIndex(name, name, { unique: false });
      };
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(testDbName, 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          const legacy = db.createObjectStore('entries', {
            keyPath: 'seq',
            autoIncrement: true,
          });
          createIndexes(legacy);
          const canonical = db.createObjectStore('entries-v2', {
            keyPath: 'id',
          });
          createIndexes(canonical);
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(['entries-v2', 'entries'], 'readwrite');
          tx.objectStore('entries-v2').add({
            id: 'v2-canonical-preserved',
            seq: 12,
            ts: 1790900000012,
            crawlId: 'v2-crawl',
            level: 'WARN',
            category: 'STORAGE',
            message: 'v2 canonical row',
            corr: null,
            url: null,
            context: {},
          });
          tx.objectStore('entries').add({
            seq: 13,
            ts: 1790900000013,
            crawlId: 'v2-legacy-source',
            level: 'INFO',
            category: 'W1',
            message: 'v2 legacy source row',
            corr: null,
            url: null,
            context: {},
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            const error = tx.error || new Error('failed to seed v2 site log');
            db.close();
            reject(error);
          };
        };
      });

      const openDescriptor =
        Object.getOwnPropertyDescriptor(indexedDB, 'open') || null;
      const nativeOpen = indexedDB.open.bind(indexedDB);
      Object.defineProperty(indexedDB, 'open', {
        configurable: true,
        value: (name, version) =>
          nativeOpen(name === 'bbr-site-log' ? testDbName : name, version),
      });
      try {
        const siteLogModule = await import(
          chrome.runtime.getURL(`chunks/${chunkName}`)
        );
        const querySiteLog = Object.values(siteLogModule).find(
          (value) =>
            typeof value === 'function' &&
            value.toString().includes('openCursor')
        );
        if (!querySiteLog)
          throw new Error('could not locate production querySiteLog export');
        const rows = await querySiteLog({ limit: 20 });
        const db = await new Promise((resolve, reject) => {
          const request = nativeOpen(testDbName);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const stores = [...db.objectStoreNames];
        const tx = db.transaction(
          ['entries-v2', 'entries', 'metadata'],
          'readonly'
        );
        const readAll = (name) =>
          new Promise((resolve, reject) => {
            const request = tx.objectStore(name).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        const [canonical, legacy, metadataRows] = await Promise.all([
          readAll('entries-v2'),
          readAll('entries'),
          readAll('metadata'),
        ]);
        db.close();
        return {
          version: db.version,
          stores,
          rows,
          canonical,
          legacy,
          metadata: Object.fromEntries(
            metadataRows.map(({ key, value }) => [key, value])
          ),
        };
      } finally {
        if (openDescriptor)
          Object.defineProperty(indexedDB, 'open', openDescriptor);
        else delete indexedDB.open;
      }
    }, siteLogChunkForV2Upgrade);
    assert.equal(
      v2Upgrade.version,
      3,
      'opening an existing v2 database should upgrade it to v3'
    );
    assert.ok(
      v2Upgrade.stores.includes('metadata'),
      'v2→v3 upgrade should add the metadata store'
    );
    assert.deepEqual(
      v2Upgrade.rows.map((row) => row.message),
      ['v2 canonical row'],
      'v2 canonical rows should remain queryable after the upgrade'
    );
    assert.equal(v2Upgrade.canonical[0].id, 'v2-canonical-preserved');
    assert.deepEqual(
      v2Upgrade.legacy.map((row) => row.message),
      ['v2 legacy source row'],
      'legacy entries remain intact as the v1 migration source'
    );
    assert.deepEqual(v2Upgrade.metadata, {
      nextSequence: 0,
      clearWatermark: 0,
    });

    const logExportPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export JSON' }).click();
    const logExport = await logExportPromise;
    const logExportStream = await logExport.createReadStream();
    let logExportText = '';
    for await (const chunk of logExportStream)
      logExportText += chunk.toString();
    const startupEntries = JSON.parse(logExportText).filter(
      (entry) => entry.crawlId === 'startup'
    );
    assert.ok(
      startupEntries.length >= 2,
      'two direct startup entries without IDs should reach the store'
    );
    assert.ok(
      startupEntries.every(
        (entry) => typeof entry.id === 'string' && entry.id.length > 0
      ),
      'direct entries should receive generated IDs at the store boundary'
    );
    assert.equal(
      new Set(startupEntries.map((entry) => entry.id)).size,
      startupEntries.length,
      'direct entries should receive distinct IDs'
    );
    await page.evaluate(() => {
      delete window.__dashboardApiRef;
    });
    console.log(
      'PASS deferred route chunks: all five noninitial routes load only on navigation; startup API preserved'
    );

    // Mobile layout on the live page: no horizontal overflow, 44px targets.
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`chrome-extension://${extensionId}/dashboard.html#/log`);
      await page.waitForFunction(
        () =>
          document
            .querySelector('#log')
            ?.textContent.includes('dashboard ready'),
        null,
        { timeout: 15000 }
      );
      await page.goto(
        `chrome-extension://${extensionId}/dashboard.html#/summary`
      );
      const metrics = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        buttonHeights: [
          ...document.querySelectorAll('button[data-slot="button"]'),
        ]
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => Math.round(el.getBoundingClientRect().height)),
      }));
      assert.equal(
        metrics.innerWidth,
        width,
        'layout viewport should match the target width'
      );
      assert.ok(
        metrics.scrollWidth <= metrics.innerWidth,
        `horizontal page overflow (${metrics.scrollWidth}px @ ${width}px)`
      );
      assert.ok(
        metrics.buttonHeights.every((h) => h >= 44),
        `buttons should have 44px touch targets @ ${width}px: ${metrics.buttonHeights.join(',')}`
      );
      console.log(
        `PASS live dashboard @ ${width}px: no horizontal overflow, touch targets >=44px`
      );
    }

    // Log entry layout on mobile: a long URL must not crush the message
    // into a character-wide column (regression: flex-1 min-w-0 message vs
    // shrink-0 URL in a wrapping flex row).
    await page.setViewportSize({ width: 360, height: 844 });
    await page.goto(`chrome-extension://${extensionId}/dashboard.html#/log`);
    await page.waitForFunction(
      () =>
        document.querySelector('#log')?.textContent.includes('dashboard ready'),
      null,
      { timeout: 15000 }
    );
    await page.evaluate(() =>
      window.__api.pushSiteLog({
        ts: Date.now(),
        seq: 1,
        crawlId: 'layout-test',
        level: 'ERROR',
        category: 'W2',
        message:
          'https://secure.backblaze.com: read failed permanently after 3 attempt(s) (tab did not finish loading in time)',
        corr: null,
        url: 'https://secure.backblaze.com',
        context: {},
      })
    );
    await page.waitForFunction(
      () => document.querySelectorAll('#site-log-panel > div').length > 0,
      null,
      { timeout: 5000 }
    );
    const logMetrics = await page.evaluate(() => {
      const panel = document.querySelector('#site-log-panel');
      const rows = [...panel.querySelectorAll(':scope > div')];
      const row = rows.find((r) => r.textContent.includes('read failed'));
      if (!row)
        return {
          found: false,
          rowCount: rows.length,
          sample: rows.length
            ? rows[rows.length - 1].textContent.slice(0, 120)
            : null,
        };
      const msg = [...row.querySelectorAll('span')].find((s) =>
        s.textContent.includes('read failed')
      );
      const badge = [...row.querySelectorAll('span')].find(
        (s) => s.textContent.trim() === 'W2'
      );
      return {
        found: true,
        msgWidth: msg ? Math.round(msg.getBoundingClientRect().width) : -1,
        badgeHeight: badge
          ? Math.round(badge.getBoundingClientRect().height)
          : -1,
      };
    });
    assert.ok(
      logMetrics.found,
      `pushed log entry should render (rows: ${logMetrics.rowCount}, sample: ${logMetrics.sample})`
    );
    assert.ok(
      logMetrics.msgWidth >= 200,
      `log message must not be crushed on mobile (width ${logMetrics.msgWidth}px @ 360px)`
    );
    assert.ok(
      logMetrics.badgeHeight <= 40,
      `category badge must not stretch vertically (height ${logMetrics.badgeHeight}px)`
    );
    console.log(
      `PASS log entry layout @ 360px: message ${logMetrics.msgWidth}px, badge ${logMetrics.badgeHeight}px`
    );
    // Back to Summary for the assertions below (they expect that route).
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );
    await page.locator('#local-backup').waitFor({ timeout: 15000 });

    // Core controls exist (Summary is the default route).
    assert.equal(
      await page.locator('#local-backup').count(),
      1,
      'dashboard should expose local backup without a popup'
    );
    assert.equal(
      await page.locator('#local-restore').count(),
      1,
      'dashboard should expose restore without a popup'
    );
    // Hash routing: each page renders without a reload (crawl context survives).
    for (const [hash, marker] of [
      ['#/results', 'Site results'],
      ['#/failures', 'Failures'],
      ['#/settings', 'Website data — retry'],
    ]) {
      await page.goto(
        `chrome-extension://${extensionId}/dashboard.html${hash}`
      );
      await page.waitForFunction(
        (text) => document.body.textContent.includes(text),
        marker,
        { timeout: 5000 }
      );
    }
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );
    assert.deepEqual(
      pageErrors.filter((e) => !e.includes('net::')),
      [],
      'page navigation should not produce page errors'
    );

    // Cloud controls live on the More page (hash routing, no reload).
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/more`
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector('a[href="#/more"]')
          ?.getAttribute('aria-current') === 'page',
      null,
      { timeout: 5000 }
    );
    assert.equal(
      await page.locator('#cloud-only-backup').count(),
      1,
      'dashboard should expose cloud-only backup'
    );
    assert.equal(
      await page.locator('#cloud-backup-now').textContent(),
      'Both: download + cloud'
    );
    assert.equal(
      await page.locator('#cloud-auto-retry').count(),
      1,
      'cloud retry should be optional'
    );
    assert.equal(
      await page.locator('#sched-frequency').count(),
      1,
      'weekly frequency control should be available'
    );
    assert.equal(
      await page.locator('#cloud-retry-status').count(),
      1,
      'retry details should have a status region'
    );
    assert.equal(
      await page.locator('#settings-export').count(),
      1,
      'settings export should be available'
    );
    assert.equal(
      await page.locator('#settings-import-file').count(),
      1,
      'settings import should be available'
    );
    // Website-data selection lives on the Settings page.
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/settings`
    );
    await page.waitForFunction(
      () =>
        !document
          .querySelector('#site-data-count')
          ?.textContent.includes('Finding websites'),
      null,
      { timeout: 15000 }
    );
    assert.equal(
      await page.locator('#site-data-search').count(),
      1,
      'website-data selection should include a search box'
    );
    assert.equal(
      await page.locator('#site-data-select-all').count(),
      1,
      'website-data selection should expose select all'
    );
    assert.match(
      await page.locator('#site-data-count').textContent(),
      /websites found · \d+ selected/
    );
    await page.locator('#site-data-search').fill('not-a-real-domain.invalid');
    assert.equal(
      await page.locator('#site-data-origin-list label').count(),
      0,
      'search should filter out nonmatching website origins'
    );

    // Schedule controls live on the More page (CloudCard).
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/more`
    );
    // Weekly <-> daily schedule toggle (Radix Select + Radix Checkboxes).
    await page.locator('#sched-frequency').click();
    await page.getByRole('option', { name: 'Weekly' }).click();
    assert.equal(
      await page.locator('#sched-weekdays').isVisible(),
      true,
      'weekly selection should reveal day checkboxes'
    );
    assert.deepEqual(
      await page
        .locator('#sched-weekdays [data-slot="checkbox"][data-state="checked"]')
        .evaluateAll((days) =>
          days.map((d) => Number(d.getAttribute('data-weekday')))
        ),
      [1, 2, 3, 4, 5],
      'weekly schedule should default to weekdays'
    );
    assert.equal(
      await page.locator('#sched-weekdays [data-slot="checkbox"]').count(),
      7,
      'weekly schedule should offer all weekdays'
    );
    await page.locator('#sched-frequency').click();
    await page.getByRole('option', { name: 'Daily' }).click();
    assert.equal(
      await page.locator('#sched-weekdays').isVisible(),
      false,
      'daily selection should hide day checkboxes'
    );

    // Seed a config, then import settings: token must be preserved.
    await page.evaluate(async () =>
      chrome.storage.local.set({
        'bbr:cloud-config': {
          provider: 'github',
          encryption: 'enabled',
          autoRetryCloud: false,
          github: {
            token: 'destination-secret',
            owner: 'before',
            repo: 'before-repo',
            branch: '',
            basePath: 'browser-backups',
          },
          schedule: {
            enabled: false,
            frequency: 'daily',
            weekdays: [],
            hour: 12,
            minute: 0,
          },
          retention: { enabled: false, keepLast: 30 },
        },
      })
    );
    const importSettings = {
      format: 'browser-backup-settings',
      version: 1,
      config: {
        provider: 'github',
        encryption: 'enabled',
        autoRetryCloud: true,
        github: {
          token: 'must-not-overwrite',
          owner: 'after',
          repo: 'imported-repo',
          branch: 'main',
          basePath: 'vault',
        },
        schedule: {
          enabled: true,
          frequency: 'weekly',
          weekdays: [1, 5],
          hour: 7,
          minute: 30,
        },
        retention: { enabled: true, keepLast: 8 },
      },
    };
    await page.locator('#settings-import-file').setInputFiles({
      name: 'settings.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(importSettings)),
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector('#settings-status')
          ?.textContent.includes('Settings imported'),
      null,
      { timeout: 10000 }
    );
    const storedConfig = await page.evaluate(
      async () =>
        (await chrome.storage.local.get('bbr:cloud-config'))['bbr:cloud-config']
    );
    assert.equal(
      storedConfig.github.token,
      'destination-secret',
      'settings import should preserve the current profile token'
    );
    assert.equal(storedConfig.github.repo, 'imported-repo');
    assert.deepEqual(storedConfig.schedule.weekdays, [1, 5]);

    // Unsupported version: rejected, settings unchanged.
    const invalidImport = { ...importSettings, version: 999 };
    await page.locator('#settings-import-file').setInputFiles({
      name: 'unsupported.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(invalidImport)),
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector('#settings-status')
          ?.textContent.includes('Settings import failed'),
      null,
      { timeout: 10000 }
    );
    const afterInvalidImport = await page.evaluate(
      async () =>
        (await chrome.storage.local.get('bbr:cloud-config'))['bbr:cloud-config']
    );
    assert.equal(
      afterInvalidImport.github.repo,
      'imported-repo',
      'invalid settings import must leave preferences unchanged'
    );

    // Export: must never contain the token.
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#settings-export').click();
    const settingsDownload = await downloadPromise;
    const stream = await settingsDownload.createReadStream();
    let exportedText = '';
    for await (const chunk of stream) exportedText += chunk.toString();
    assert.equal(
      exportedText.includes('destination-secret'),
      false,
      'settings export must omit the profile token'
    );
    assert.match(
      exportedText,
      /"browser-backup-settings"/,
      'export carries the settings format id'
    );

    // Pending upload retry status + cancel.
    await page.evaluate(async () =>
      chrome.storage.local.set({
        'bbr:pending-upload': {
          id: 'retry-test',
          retryCount: 1,
          retryAt: new Date(Date.now() + 60_000).toISOString(),
          retryExhausted: false,
          retryCancelled: false,
        },
      })
    );
    await page.reload();
    await page.goto(`chrome-extension://${extensionId}/dashboard.html#/log`);
    await page.waitForFunction(
      () =>
        document.querySelector('#log')?.textContent.includes('dashboard ready'),
      null,
      { timeout: 15000 }
    );
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/more`
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector('#cloud-retry-status')
          ?.textContent.includes('Retry 1/8 scheduled'),
      null,
      { timeout: 10000 }
    );
    assert.equal(
      await page.locator('#cloud-retry-cancel').isVisible(),
      true,
      'scheduled retry should expose cancel action'
    );
    await page.locator('#cloud-retry-cancel').click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('#cloud-retry-status')
          ?.textContent.includes('Automatic retries cancelled'),
      null,
      { timeout: 10000 }
    );
    const pendingAfterCancel = await page.evaluate(
      async () =>
        (await chrome.storage.local.get('bbr:pending-upload'))[
          'bbr:pending-upload'
        ]
    );
    assert.equal(
      pendingAfterCancel.id,
      'retry-test',
      'cancelling retries should keep the pending artifact'
    );
    assert.equal(pendingAfterCancel.retryAt, null);
    assert.equal(pendingAfterCancel.retryCancelled, true);

    // Clear Results is guarded across pages and preserves recovery/security state.
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );
    const clearResultsButton = page.locator('#clear-results');
    assert.equal(
      await clearResultsButton.count(),
      1,
      'summary should expose Clear Results'
    );
    assert.match(
      await page.locator('#section-local-actions').textContent(),
      /Downloaded files in your chosen location are not deleted/i,
      'clear copy must state that downloaded files are not removed'
    );
    const safeDashboardState = await page.evaluate(() =>
      window.__api.dashboardState()
    );
    const safeStateKeys = ['activeOperations', 'backup', 'restore'];
    assert.deepEqual(Object.keys(safeDashboardState).sort(), safeStateKeys);
    assert.equal(
      'cloud' in safeDashboardState,
      false,
      'test state must not expose cloud configuration'
    );
    assert.equal(
      JSON.stringify(safeDashboardState).includes('token'),
      false,
      'test state must not expose tokens'
    );
    const hasGenericLockApi = await page.evaluate(
      () => 'withDashboardActivity' in window.__api
    );
    assert.equal(
      hasGenericLockApi,
      false,
      'generic lock acquisition must not be exposed to page scripts'
    );
    const seededProjection = await page.evaluate(() =>
      window.__api.seedDashboardState({ restore: { pickError: null } })
    );
    assert.deepEqual(
      Object.keys(seededProjection).sort(),
      safeStateKeys,
      'seed hook must return only safe state'
    );

    const bookmarkTitle = 'task3-clear-results-sentinel';
    await page.evaluate(async (title) => {
      const [root] = await chrome.bookmarks.getTree();
      const bar = root.children.find((node) => node.children);
      await chrome.bookmarks.create({
        parentId: bar.id,
        title,
        url: 'https://example.test/',
      });
    }, bookmarkTitle);

    await page.evaluate(() => {
      window.__smallBackupActivityEvents = [];
      window.__smallBackupActivityObserver = new BroadcastChannel(
        'bbr-dashboard-activity'
      );
      window.__smallBackupActivityObserver.addEventListener(
        'message',
        (event) => {
          window.__smallBackupActivityEvents.push(event.data);
        }
      );
    });
    await page.evaluate(() => {
      window.__smallBackupGetTreeDescriptor =
        Object.getOwnPropertyDescriptor(chrome.bookmarks, 'getTree') || null;
      const nativeGetTree = chrome.bookmarks.getTree.bind(chrome.bookmarks);
      Object.defineProperty(chrome.bookmarks, 'getTree', {
        configurable: true,
        value: (...args) =>
          new Promise((resolve, reject) => {
            setTimeout(() => nativeGetTree(...args).then(resolve, reject), 150);
          }),
      });
    });
    let smallBackup = null;
    let smallBackupBusyRetries = 0;
    let smallBackupLastLockState = null;
    for (let attempt = 0; attempt < 5 && !smallBackup; attempt++) {
      await page.waitForFunction(
        async () => {
          const { held, pending } = await navigator.locks.query();
          return (
            window.__api.dashboardState().activeOperations === 0 &&
            !held.some((lock) => lock.name === 'bbr:dashboard-operation') &&
            !pending.some((lock) => lock.name === 'bbr:dashboard-operation')
          );
        },
        null,
        { timeout: 10000 }
      );
      await page.waitForTimeout(100);
      await page.evaluate(() => {
        window.__smallBackupOutcome = null;
        window.__smallBackupPromise = window.__api
          .runBackupToFile({
            collectOptions: {
              selectedCategories: ['bookmarks'],
              siteData: { includeOrigins: [] },
            },
          })
          .then(
            (value) => {
              window.__smallBackupOutcome = { value };
            },
            (error) => {
              window.__smallBackupOutcome = { error: String(error) };
            }
          );
      });
      await page.waitForFunction(
        async () => {
          if (window.__smallBackupOutcome) return true;
          const state = window.__api.dashboardState();
          const { held } = await navigator.locks.query();
          return (
            state.backup.running &&
            state.activeOperations > 0 &&
            held.some((lock) => lock.name === 'bbr:dashboard-operation') &&
            document.querySelector('#clear-results')?.disabled === true
          );
        },
        null,
        { polling: 1, timeout: 10000 }
      );
      const attemptResult = await page.evaluate(async () => {
        await window.__smallBackupPromise;
        return window.__smallBackupOutcome;
      });
      if (attemptResult.error) {
        assert.match(
          attemptResult.error,
          /Dashboard is busy with another operation/,
          'only an explicit native-lock busy result may retry the backup fixture'
        );
        smallBackupBusyRetries++;
        smallBackupLastLockState = await page.evaluate(async () => {
          const { held, pending } = await navigator.locks.query();
          return {
            state: window.__api.dashboardState(),
            held: held.filter(
              (lock) => lock.name === 'bbr:dashboard-operation'
            ),
            pending: pending.filter(
              (lock) => lock.name === 'bbr:dashboard-operation'
            ),
            events: window.__smallBackupActivityEvents.slice(-10),
          };
        });
        continue;
      }
      smallBackup = attemptResult.value;
    }
    await page.evaluate(() => {
      window.__smallBackupActivityObserver.close();
      if (window.__smallBackupGetTreeDescriptor) {
        Object.defineProperty(
          chrome.bookmarks,
          'getTree',
          window.__smallBackupGetTreeDescriptor
        );
      } else {
        delete chrome.bookmarks.getTree;
      }
    });
    assert.ok(
      smallBackup,
      `small backup should start within five lock retries (busy retries: ${smallBackupBusyRetries}; last lock state: ${JSON.stringify(smallBackupLastLockState)})`
    );
    assert.ok(
      smallBackup.counts.bookmarks >= 1,
      'the small local backup should include the seeded bookmark'
    );
    assert.deepEqual(
      await page.evaluate(() => chrome.storage.local.get('bbr:last-backup')),
      {},
      'a completed backup must not persist the legacy raw cache'
    );

    let testActivitySequence = 0;
    const startNativeActivity = async (targetPage, kind) => {
      const activity = {
        sourceId: `ui-test-${Date.now()}-${++testActivitySequence}`,
        operationId: `${kind}-${testActivitySequence}`,
      };
      await targetPage.evaluate(
        async ({ activity }) => {
          const entered = new Promise((resolve) => {
            window.__activityEnteredResolve = resolve;
          });
          window.__activityError = null;
          window.__activityChannel = new BroadcastChannel(
            'bbr-dashboard-activity'
          );
          window.__activityPromise = navigator.locks
            .request(
              'bbr:dashboard-operation',
              { mode: 'exclusive', ifAvailable: true },
              (lock) => {
                if (!lock)
                  throw new Error(
                    'The test could not acquire the native dashboard lock.'
                  );
                window.__activitySource = activity;
                return new Promise((resolve) => {
                  window.__activityRelease = resolve;
                  window.__activityChannel.postMessage({
                    ...activity,
                    active: true,
                  });
                  window.__activityEnteredResolve();
                });
              }
            )
            .catch((error) => {
              window.__activityError = String(error);
              window.__activityEnteredResolve();
            });
          await entered;
          if (window.__activityError) throw new Error(window.__activityError);
        },
        { activity }
      );
    };
    const releaseNativeActivity = async (targetPage) => {
      await targetPage.evaluate(async () => {
        window.__activityChannel.postMessage({
          ...window.__activitySource,
          active: false,
        });
        window.__activityRelease();
        await window.__activityPromise;
        window.__activityChannel.close();
      });
    };

    const activityPage = await extensionContext.newPage();
    await activityPage.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );
    const secondClearButton = activityPage.locator('#clear-results');
    await secondClearButton.waitFor();
    const directApiLogPage = await extensionContext.newPage();
    await directApiLogPage.goto(
      `chrome-extension://${extensionId}/dashboard.html#/log`
    );
    const directApiClearLogsButton = directApiLogPage.locator('#clear-logs');
    await directApiClearLogsButton.waitFor();
    await activityPage.evaluate(() => {
      const local = chrome.storage.local;
      window.__directApiStorageGetDescriptor =
        Object.getOwnPropertyDescriptor(local, 'get') || null;
      const nativeGet = local.get.bind(local);
      window.__directApiCollectionEntered = false;
      Object.defineProperty(local, 'get', {
        configurable: true,
        value(keys, ...args) {
          if (Array.isArray(keys) && keys.includes('bbr.dashboard.theme')) {
            window.__directApiCollectionEntered = true;
            return new Promise((resolve, reject) => {
              window.__releaseDirectApiCollection = () =>
                nativeGet(keys, ...args).then(resolve, reject);
            });
          }
          return nativeGet(keys, ...args);
        },
      });
      window.__directApiCollection = window.__api.collectAll(null, {
        selectedCategories: ['extensionStorage'],
      });
    });
    await activityPage.waitForFunction(
      () => window.__directApiCollectionEntered === true,
      null,
      { timeout: 10000 }
    );
    await page.waitForTimeout(100);
    try {
      assert.equal(
        await clearResultsButton.isDisabled(),
        true,
        'direct API collection must disable Clear Results on a peer page'
      );
      assert.equal(
        await directApiClearLogsButton.isDisabled(),
        true,
        'direct API collection must disable Clear Logs on a peer page'
      );
    } finally {
      const directApiCollectionResult = await activityPage.evaluate(
        async () => {
          window.__releaseDirectApiCollection();
          const result = await window.__directApiCollection;
          if (window.__directApiStorageGetDescriptor) {
            Object.defineProperty(
              chrome.storage.local,
              'get',
              window.__directApiStorageGetDescriptor
            );
          } else {
            delete chrome.storage.local.get;
          }
          return {
            extensionStorage: result.data.extensionStorage,
            status: result.categoryStatus.extensionStorage,
          };
        }
      );
      assert.equal(
        directApiCollectionResult.status.ok,
        true,
        'the real direct collection should settle successfully'
      );
      await page.waitForFunction(
        () => document.querySelector('#clear-results')?.disabled === false,
        null,
        { timeout: 10000 }
      );
      await directApiLogPage.waitForFunction(
        () => document.querySelector('#clear-logs')?.disabled === false,
        null,
        { timeout: 10000 }
      );
      await directApiLogPage.close();
    }
    console.log(
      'PASS direct window.__api collection holds both peer-page clear actions until completion'
    );
    await activityPage.evaluate(() => {
      window.__activityStartsObserved = [];
      window.__activityStartLockStates = [];
      window.__activityObserver = new BroadcastChannel(
        'bbr-dashboard-activity'
      );
      window.__activityObserver.addEventListener('message', async (event) => {
        if (event.data?.active !== true) return;
        window.__activityStartsObserved.push(event.data.operationId);
        const { held } = await navigator.locks.query();
        window.__activityStartLockStates.push(
          held.some((lock) => lock.name === 'bbr:dashboard-operation')
        );
      });
    });
    await page.evaluate(() => {
      const locks = navigator.locks;
      const nativeRequest = locks.request.bind(locks);
      window.__requestDescriptor =
        Object.getOwnPropertyDescriptor(locks, 'request') || null;
      window.__delayedDashboardRequest = false;
      Object.defineProperty(locks, 'request', {
        configurable: true,
        value(name, options, callback) {
          if (
            name === 'bbr:dashboard-operation' &&
            !window.__delayedDashboardRequest
          ) {
            window.__delayedDashboardRequest = true;
            return new Promise((resolve, reject) => {
              window.__resumeDashboardRequest = () =>
                nativeRequest(name, options, callback).then(resolve, reject);
            });
          }
          return nativeRequest(name, options, callback);
        },
      });
      const bookmarks = chrome.bookmarks;
      window.__getTreeDescriptor =
        Object.getOwnPropertyDescriptor(bookmarks, 'getTree') || null;
      const getTree = bookmarks.getTree.bind(bookmarks);
      Object.defineProperty(bookmarks, 'getTree', {
        configurable: true,
        value: (...args) =>
          new Promise((resolve, reject) => {
            setTimeout(() => getTree(...args).then(resolve, reject), 400);
          }),
      });
      window.__raceBackupPromise = window.__api.runBackupToFile({
        collectOptions: {
          selectedCategories: ['bookmarks'],
          siteData: { includeOrigins: [] },
        },
      });
    });
    await page.waitForFunction(
      () => typeof window.__resumeDashboardRequest === 'function',
      null,
      {
        timeout: 10000,
      }
    );
    await activityPage.evaluate(async () => {
      window.dispatchEvent(new Event('focus'));
      await navigator.locks.query();
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.deepEqual(
      await activityPage.evaluate(() => window.__activityStartsObserved),
      [],
      'an activity must not be broadcast before its native lock is acquired'
    );
    assert.equal(
      await secondClearButton.isDisabled(),
      false,
      'an unacquired operation must not disable another page'
    );
    await page.evaluate(() => {
      window.__resumeDashboardRequest();
    });
    await activityPage.waitForFunction(
      () => window.__activityStartLockStates.length > 0,
      null,
      { timeout: 10000 }
    );
    assert.equal(
      await activityPage.evaluate(() =>
        window.__activityStartLockStates.at(-1)
      ),
      true,
      'the cross-page active message must arrive while the native lock is held'
    );
    await activityPage.waitForFunction(
      () => document.querySelector('#clear-results')?.disabled === true,
      null,
      {
        timeout: 10000,
      }
    );
    const delayedBackup = await page.evaluate(
      async () => window.__raceBackupPromise
    );
    assert.ok(
      delayedBackup.counts.bookmarks >= 1,
      'the delayed real backup should complete'
    );
    await page.evaluate(() => {
      if (window.__requestDescriptor)
        Object.defineProperty(
          navigator.locks,
          'request',
          window.__requestDescriptor
        );
      else delete navigator.locks.request;
      if (window.__getTreeDescriptor)
        Object.defineProperty(
          chrome.bookmarks,
          'getTree',
          window.__getTreeDescriptor
        );
      else delete chrome.bookmarks.getTree;
    });
    await activityPage.evaluate(() => window.__activityObserver.close());
    await activityPage.waitForFunction(
      () => document.querySelector('#clear-results')?.disabled === false,
      null,
      {
        timeout: 10000,
      }
    );

    await startNativeActivity(page, 'probes');
    await activityPage.waitForFunction(
      () => document.querySelector('#clear-results')?.disabled === true,
      null,
      {
        timeout: 10000,
      }
    );
    const secondPageBeforeBusyClear = await activityPage.evaluate(() =>
      window.__api.dashboardState()
    );
    assert.equal(
      await activityPage.evaluate(() => window.__api.clearBackupResults()),
      false,
      'a second page cannot clear while probes hold the lock'
    );
    const secondPageAfterBusyClear = await activityPage.evaluate(() =>
      window.__api.dashboardState()
    );
    assert.deepEqual(
      {
        backup: secondPageAfterBusyClear.backup,
        restore: secondPageAfterBusyClear.restore,
      },
      {
        backup: secondPageBeforeBusyClear.backup,
        restore: secondPageBeforeBusyClear.restore,
      },
      'a busy clear must not change displayed results'
    );
    await releaseNativeActivity(page);
    await activityPage.waitForFunction(
      () => document.querySelector('#clear-results')?.disabled === false,
      null,
      {
        timeout: 10000,
      }
    );

    await startNativeActivity(page, 'download');
    await activityPage.waitForFunction(
      () => document.querySelector('#clear-results')?.disabled === true,
      null,
      {
        timeout: 10000,
      }
    );
    await page.evaluate(async () => {
      window.dispatchEvent(new Event('focus'));
      await navigator.locks.query();
    });
    await releaseNativeActivity(page);
    await page.waitForFunction(
      () => window.__api.dashboardState().activeOperations === 0,
      null,
      { timeout: 10000 }
    );
    await activityPage.waitForFunction(
      () => document.querySelector('#clear-results')?.disabled === false,
      null,
      {
        timeout: 10000,
      }
    );

    const abandonedPage = await extensionContext.newPage();
    await abandonedPage.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );
    await startNativeActivity(abandonedPage, 'abandoned');
    await activityPage.waitForFunction(
      () => document.querySelector('#clear-results')?.disabled === true,
      null,
      {
        timeout: 10000,
      }
    );
    await abandonedPage.close(); // Closing the page releases its native lock; no final BC message is sent.
    await activityPage.waitForFunction(
      async () =>
        !(await navigator.locks.query()).held.some(
          (lock) => lock.name === 'bbr:dashboard-operation'
        ),
      null,
      {
        timeout: 10000,
      }
    );
    const lockHeldAfterClose = await activityPage.evaluate(async () =>
      (await navigator.locks.query()).held.some(
        (lock) => lock.name === 'bbr:dashboard-operation'
      )
    );
    assert.equal(
      lockHeldAfterClose,
      false,
      'closing the source page must release its native Web Lock'
    );
    await activityPage.evaluate(async () => {
      window.dispatchEvent(new Event('focus'));
      await navigator.locks.query();
    });
    await activityPage.waitForFunction(
      () => window.__api.dashboardState().activeOperations === 0,
      null,
      {
        timeout: 10000,
      }
    );
    await activityPage.waitForFunction(
      () => document.querySelector('#clear-results')?.disabled === false,
      null,
      {
        timeout: 10000,
      }
    );
    await page.evaluate(async () => {
      window.dispatchEvent(new Event('focus'));
      await navigator.locks.query();
    });
    await page.waitForFunction(
      () => window.__api.dashboardState().activeOperations === 0,
      null,
      {
        timeout: 10000,
      }
    );

    const locksDisabled = await page.evaluate(() => {
      try {
        Object.defineProperty(navigator, 'locks', {
          configurable: true,
          value: undefined,
        });
        return navigator.locks === undefined;
      } catch {
        return false;
      }
    });
    assert.equal(
      locksDisabled,
      true,
      'test should simulate a browser without Web Locks'
    );
    await page.evaluate(() =>
      window.__api.seedDashboardState({ restore: { pickError: null } })
    );
    await page.waitForFunction(
      () => document.querySelector('#clear-results')?.disabled === true
    );
    const fallbackBackup = await page.evaluate(() =>
      window.__api.runBackupToFile({
        collectOptions: {
          selectedCategories: ['bookmarks'],
          siteData: { includeOrigins: [] },
        },
      })
    );
    assert.ok(
      fallbackBackup.counts.bookmarks >= 1,
      'normal backup should still run without Web Locks'
    );
    await page.evaluate(() =>
      chrome.storage.local.set({
        'bbr:last-backup': { sentinel: 'preserve-without-locks' },
      })
    );
    const fallbackStateBefore = await page.evaluate(() =>
      window.__api.dashboardState()
    );
    assert.equal(
      await page.evaluate(() => window.__api.clearBackupResults()),
      false
    );
    const fallbackStateAfter = await page.evaluate(() =>
      window.__api.dashboardState()
    );
    assert.deepEqual(fallbackStateAfter.backup, fallbackStateBefore.backup);
    assert.deepEqual(fallbackStateAfter.restore, fallbackStateBefore.restore);
    assert.deepEqual(
      await page.evaluate(() => chrome.storage.local.get('bbr:last-backup')),
      { 'bbr:last-backup': { sentinel: 'preserve-without-locks' } },
      'clear without Web Locks must not delete the legacy cache'
    );
    await page.evaluate(() => {
      delete navigator.locks;
      window.__api.seedDashboardState({ restore: { pickError: null } });
    });
    await page.waitForFunction(
      () => document.querySelector('#clear-results')?.disabled === false,
      null,
      {
        timeout: 10000,
      }
    );

    const currentRestoreCapabilities = await page.evaluate(() =>
      window.__api.detect()
    );
    assert.equal(
      currentRestoreCapabilities.bookmarks.canRestore,
      'full',
      'the receiving browser should support bookmark restore'
    );
    assert.equal(
      currentRestoreCapabilities.installedExtensions.canRestore,
      false,
      'the receiving browser cannot install extensions through the public API'
    );
    assert.equal(
      currentRestoreCapabilities.extensionPermissions.canRestore,
      'partial',
      'the receiving browser should report partial permission capability'
    );
    const restorePreviewFixture = newBackupSkeleton(
      {
        bookmarks: { canRestore: false },
        history: { canRestore: 'partial' },
        extensionStorage: { canRestore: 'full' },
        installedExtensions: { canRestore: 'full' },
        extensionPermissions: { canRestore: 'partial' },
      },
      { name: 'restore-preview-test', version: '1.4.7' }
    );
    restorePreviewFixture.counts = {
      bookmarks: 1,
      history: 7,
      extensionStorage: 3,
      installedExtensions: 1,
    };
    restorePreviewFixture.data = {
      bookmarks: {
        roots: {
          bookmark_bar: {
            id: '1',
            title: 'Bookmarks bar',
            children: [
              {
                id: 'preview-bookmark',
                type: 'url',
                title: 'Preview bookmark',
                url: 'https://example.test/',
              },
            ],
          },
        },
      },
      history: {
        items: [
          {
            url: 'https://history.test/',
            title: 'History item',
            visitCount: 1,
            typedCount: 0,
            lastVisitTime: 1,
          },
        ],
        visits: {},
      },
      extensionStorage: {
        local: {
          'bbr.dashboard.theme': 'dark',
          'bbr:backup-categories': ['bookmarks'],
          'bbr:site-data-scan-window': 12,
        },
        sync: { 'ignored.sync.preference': 'must not count' },
      },
      installedExtensions: {
        items: [
          {
            id: 'fixture-extension',
            name: 'Fixture extension',
            version: '1.0',
          },
        ],
      },
      extensionPermissions: {
        permissions: ['bookmarks'],
        origins: ['https://example.test/*'],
      },
      profile: { chromeVersion: 'fixture', locale: 'en' },
    };
    await finalizeIntegrity(restorePreviewFixture);
    await page.locator('#local-restore').click();
    await page.locator('#restore-file').setInputFiles({
      name: 'restore-preview-capabilities.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(restorePreviewFixture)),
    });
    const restorePreviewRows = page.locator('#section-restore tbody tr');
    await page.locator('#section-restore [data-cat="bookmarks"]').waitFor();
    const previewRowFor = (category) =>
      restorePreviewRows.filter({
        has: page.locator(`[data-cat="${category}"]`),
      });
    assert.match(
      await previewRowFor('bookmarks').locator('td').nth(2).innerText(),
      /restorable/,
      'bookmark support should come from the current browser, not archived false'
    );
    assert.match(
      await previewRowFor('installedExtensions')
        .locator('td')
        .nth(2)
        .innerText(),
      /cannot restore/,
      'installed extensions must remain unavailable despite archived full support'
    );
    assert.deepEqual(
      await restorePreviewRows.evaluateAll((rows) =>
        rows.map((row) =>
          row.querySelector('[data-cat]')?.getAttribute('data-cat')
        )
      ),
      [
        'bookmarks',
        'history',
        'extensionStorage',
        'installedExtensions',
        'extensionPermissions',
        'profile',
      ],
      'preview should include each backed-up category, including informational metadata'
    );
    assert.equal(
      await previewRowFor('extensionStorage').locator('td').nth(1).innerText(),
      '3',
      'extension storage preview count should reflect local preference keys and ignore sync data'
    );
    for (const category of ['extensionPermissions', 'profile']) {
      const row = previewRowFor(category);
      assert.match(
        await row.locator('td').nth(2).innerText(),
        /cannot restore/,
        `${category} should be informational and unavailable`
      );
      assert.equal(
        await row.locator('[data-cat]').isDisabled(),
        true,
        `${category} must not enable a nonexistent restore operation`
      );
    }
    assert.equal(
      await previewRowFor('history').locator('td').nth(1).innerText(),
      '1',
      'the displayed history count should reflect actual items'
    );
    assert.ok(
      await page
        .getByText('Warning: counts.history (7) does not match data (1)', {
          exact: true,
        })
        .isVisible(),
      'the archived count mismatch should remain visible'
    );
    assert.ok(
      await page
        .getByText(
          'Warning: Bookmarks restore capability in the backup differs from this browser; showing current browser support.',
          { exact: true }
        )
        .isVisible()
    );
    const extensionPermissionMismatchWarning =
      'Warning: Extension permissions (own) restore capability in the backup differs from this browser; showing current browser support.';
    assert.equal(
      await page
        .getByText(extensionPermissionMismatchWarning, { exact: true })
        .count(),
      0,
      'matching archived and live partial capabilities must not warn merely because the row has no handler'
    );
    assert.equal(
      await page.locator('#opt-bm-replace').getAttribute('aria-checked'),
      'false',
      'bookmark replacement must default off'
    );
    assert.equal(
      await page.locator('#opt-sd-replace').getAttribute('aria-checked'),
      'false',
      'site-data replacement must default off'
    );
    const restorePreviewText = await page
      .locator('#section-restore')
      .innerText();
    assert.match(
      restorePreviewText,
      /replace existing Bookmarks bar & Other bookmarks/i,
      'bookmark replacement impact must be shown before restore'
    );
    assert.match(
      restorePreviewText,
      /wipe each origin's site storage before restoring/i,
      'site-data replacement impact must be shown before restore'
    );
    await page.locator('#restore-cancel').click();
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );
    await page.locator('#local-restore').waitFor();

    const unavailableReadingListUrl = 'https://restore-unavailable.test/';
    await page.evaluate(() => {
      window.__readingListPropertyDescriptor =
        Object.getOwnPropertyDescriptor(chrome, 'readingList') || null;
      Object.defineProperty(chrome, 'readingList', {
        configurable: true,
        value: undefined,
      });
    });
    try {
      assert.equal(
        (await page.evaluate(() => window.__api.detect())).readingList
          .canRestore,
        false,
        'the integration target should lack the Reading List restore API'
      );
      const unavailableRestoreFixture = newBackupSkeleton(
        {
          bookmarks: { canRestore: 'full' },
          readingList: { canRestore: 'full' },
        },
        { name: 'restore-unavailable-test', version: '1.4.7' }
      );
      unavailableRestoreFixture.counts = { bookmarks: 1, readingList: 1 };
      unavailableRestoreFixture.data = {
        bookmarks: {
          roots: {
            bookmark_bar: {
              id: '1',
              title: 'Bookmarks bar',
              children: [
                {
                  id: 'unavailable-test',
                  type: 'url',
                  title: 'Unavailable target test',
                  url: unavailableReadingListUrl,
                },
              ],
            },
          },
        },
        readingList: {
          entries: [
            {
              url: 'https://reading-list-unavailable.test/',
              title: 'Unavailable reading item',
              hasBeenRead: false,
            },
          ],
        },
      };
      await finalizeIntegrity(unavailableRestoreFixture);
      await page.locator('#local-restore').click();
      await page.locator('#restore-file').setInputFiles({
        name: 'restore-unavailable-target.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(unavailableRestoreFixture)),
      });
      const unavailableReadingListRow = page
        .locator('#section-restore tbody tr')
        .filter({
          has: page.locator('[data-cat="readingList"]'),
        });
      await unavailableReadingListRow.waitFor();
      assert.match(
        await unavailableReadingListRow.locator('td').nth(2).innerText(),
        /cannot restore/
      );
      assert.equal(
        await unavailableReadingListRow.locator('[data-cat]').isDisabled(),
        true
      );
      await page.locator('#restore-go').click();
      await page.getByText('Restore results', { exact: true }).waitFor();
      assert.ok(
        await page.getByText('Unavailable', { exact: true }).isVisible(),
        'target-unavailable data should be reported as Unavailable'
      );
      assert.equal(
        await page.getByText('Skipped by user', { exact: true }).count(),
        0,
        'target-unavailable data must not be reported as user-skipped'
      );
      assert.ok(
        await page.getByText(/bookmarks: 1 created/).isVisible(),
        'the other supported category should complete in the same restore'
      );
    } finally {
      await page.evaluate(async (url) => {
        for (const bookmark of await chrome.bookmarks.search({ url }))
          await chrome.bookmarks.remove(bookmark.id);
        if (window.__readingListPropertyDescriptor) {
          Object.defineProperty(
            chrome,
            'readingList',
            window.__readingListPropertyDescriptor
          );
        } else {
          delete chrome.readingList;
        }
        delete window.__readingListPropertyDescriptor;
      }, unavailableReadingListUrl);
    }
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );
    await page.locator('#local-restore').waitFor();

    const emptyBookmarksFixture = newBackupSkeleton(
      {
        bookmarks: { canRestore: 'full' },
        extensionStorage: { canRestore: 'full' },
      },
      { name: 'empty-bookmarks-count-test', version: '1.4.7' }
    );
    emptyBookmarksFixture.counts = {
      bookmarks: 7,
      bookmarkFolders: 0,
      extensionStorage: 0,
    };
    emptyBookmarksFixture.data = {
      bookmarks: { roots: {} },
      extensionStorage: {
        local: {},
        sync: { 'ignored.sync.preference': 'not counted' },
      },
    };
    await finalizeIntegrity(emptyBookmarksFixture);
    await page.locator('#local-restore').click();
    await page.locator('#restore-file').setInputFiles({
      name: 'empty-bookmarks-stale-count.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(emptyBookmarksFixture)),
    });
    const emptyBookmarksRow = page
      .locator('#section-restore tbody tr')
      .filter({ has: page.locator('[data-cat="bookmarks"]') });
    await emptyBookmarksRow.waitFor();
    const emptyExtensionStorageRow = page
      .locator('#section-restore tbody tr')
      .filter({ has: page.locator('[data-cat="extensionStorage"]') });
    await emptyExtensionStorageRow.waitFor();
    assert.ok(
      await page
        .getByText(
          'Warning: counts.bookmarks (7/0) does not match data (0 bookmarks / 0 folders)',
          { exact: true }
        )
        .isVisible(),
      'the validator mismatch warning should remain visible for empty bookmark data'
    );
    assert.equal(
      await emptyBookmarksRow.locator('td').nth(1).innerText(),
      '0',
      'an explicitly empty roots record has a known count of zero, not the archived count'
    );
    assert.equal(
      await emptyExtensionStorageRow.locator('td').nth(1).innerText(),
      '0',
      'an empty local preference object should show zero without counting sync data'
    );
    await page.locator('#restore-cancel').click();
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );
    await page.locator('#local-restore').waitFor();

    const restoreText = await page.evaluate(async () => {
      const { backup } = await window.__api.buildBackupObject(null, {
        selectedCategories: ['bookmarks'],
        siteData: { includeOrigins: [] },
      });
      return JSON.stringify(backup);
    });
    await page.locator('#local-restore').click();
    await page.locator('#restore-file').setInputFiles({
      name: 'task3-restore-preview.json',
      mimeType: 'application/json',
      buffer: Buffer.from(restoreText),
    });
    const bookmarkRow = page.locator('#section-restore [data-cat="bookmarks"]');
    await bookmarkRow.waitFor();
    await bookmarkRow.click();
    assert.equal(
      await bookmarkRow.getAttribute('aria-checked'),
      'false',
      'test restore must leave browser bookmarks untouched'
    );
    await page.locator('#restore-go').click();
    await page.getByText('Restore results', { exact: true }).waitFor();

    const pendingReleaseUrl = 'https://pending-restore-release.test/';
    const pendingReleaseTitle = 'pending-restore-release-test';
    const pendingReleaseFixture = newBackupSkeleton(
      { bookmarks: { canRestore: 'full' } },
      { name: 'pending-restore-release-test', version: '1.4.7' }
    );
    pendingReleaseFixture.counts = { bookmarks: 1 };
    pendingReleaseFixture.data = {
      bookmarks: {
        roots: {
          bookmark_bar: {
            id: '1',
            title: 'Bookmarks bar',
            children: [
              {
                id: 'pending-release-test',
                type: 'url',
                title: pendingReleaseTitle,
                url: pendingReleaseUrl,
              },
            ],
          },
        },
      },
    };
    await finalizeIntegrity(pendingReleaseFixture);
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );
    await page.locator('#local-restore').waitFor();
    await page.locator('#local-restore').click();
    await page.locator('#restore-file').setInputFiles({
      name: 'pending-restore-release.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(pendingReleaseFixture)),
    });
    await page.locator('#section-restore [data-cat="bookmarks"]').waitFor();
    const pendingReleaseClear = await page.evaluate(() =>
      window.__api.clearBackupResults()
    );
    assert.equal(
      pendingReleaseClear,
      true,
      'Clear Results should complete while a restore preview is pending'
    );
    const pendingReleasePreview = (
      await page.evaluate(() => window.__api.dashboardState())
    ).restore.summary;
    assert.ok(
      pendingReleasePreview?.rows.some((row) => row.cat === 'bookmarks'),
      'Clear Results must preserve the pending restore preview payload'
    );
    await page.evaluate(() => {
      const bookmarks = chrome.bookmarks;
      window.__pendingReleaseCreateDescriptor =
        Object.getOwnPropertyDescriptor(bookmarks, 'create') || null;
      window.__pendingReleaseCreateCalls = 0;
      Object.defineProperty(bookmarks, 'create', {
        configurable: true,
        value: () => {
          window.__pendingReleaseCreateCalls++;
          return Promise.reject(new Error('pending release failure sentinel'));
        },
      });
    });
    try {
      await page.locator('#restore-go').click();
      await page.waitForFunction(
        () =>
          window.__api
            .dashboardState()
            .restore.results.some((result) => result.label === 'Bookmarks'),
        null,
        {
          timeout: 10000,
        }
      );
      const failedPendingRestore = await page.evaluate(
        () => window.__api.dashboardState().restore
      );
      assert.ok(
        failedPendingRestore.results.some(
          (result) =>
            result.label === 'Bookmarks' && result.outcome === 'failed'
        )
      );
      assert.ok(
        await page.evaluate(() => window.__pendingReleaseCreateCalls > 0),
        'the first restore should reach and fail its real bookmark API operation'
      );
    } finally {
      await page.evaluate(() => {
        if (window.__pendingReleaseCreateDescriptor) {
          Object.defineProperty(
            chrome.bookmarks,
            'create',
            window.__pendingReleaseCreateDescriptor
          );
        } else {
          delete chrome.bookmarks.create;
        }
      });
    }
    await page.evaluate(
      (summary) =>
        window.__api.seedDashboardState({
          restore: {
            summary,
            progress: {
              visible: false,
              frac: 1,
              status: 'failed restore settled',
            },
          },
        }),
      pendingReleasePreview
    );
    await page.locator('#restore-go').waitFor();
    await page.locator('#restore-go').click();
    await Promise.race([
      page
        .waitForFunction(
          () => window.__api.dashboardState().restore.summary === null,
          null,
          { timeout: 800 }
        )
        .catch(() => null),
      page.waitForTimeout(850),
    ]);
    const stalePendingRestoreBookmarks = await page.evaluate(
      (url) => chrome.bookmarks.search({ url }),
      pendingReleaseUrl
    );
    assert.equal(
      stalePendingRestoreBookmarks.length,
      0,
      'a completed failed restore must release its payload so a later action cannot replay it'
    );
    await page.evaluate(async (url) => {
      for (const bookmark of await chrome.bookmarks.search({ url }))
        await chrome.bookmarks.remove(bookmark.id);
    }, pendingReleaseUrl);
    await page.locator('#restore-cancel').click();
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );
    await page.locator('#local-restore').waitFor();
    await page.locator('#local-restore').click();
    await page.locator('#restore-file').waitFor();
    await page.evaluate(() =>
      window.__api.runBackupToFile({
        collectOptions: {
          selectedCategories: ['bookmarks'],
          siteData: { includeOrigins: [] },
        },
      })
    );
    await page.waitForFunction(() => {
      const state = window.__api.dashboardState();
      return (
        state.backup.summary.length > 0 &&
        state.backup.downloadInfo?.ready === true
      );
    });

    const restoreOutcomeFixtures = [
      {
        label: 'Mixed tabs',
        outcome: 'partial',
        outcomeCounts: { succeeded: 1, failed: 1, skipped: 0 },
        summary: '2 tabs attempted',
        notes: ['one tab could not navigate'],
      },
      {
        label: 'Failed bookmarks',
        outcome: 'failed',
        outcomeCounts: { succeeded: 0, failed: 2, skipped: 0 },
        summary: '2 bookmarks failed',
        notes: [],
      },
      {
        label: 'Permissions',
        outcome: 'unavailable',
        summary: 'no restore API',
        notes: ['permissions remain in the backup'],
      },
      {
        label: 'Cookies',
        outcome: 'complete',
        outcomeCounts: { succeeded: 2, failed: 0, skipped: 0 },
        summary: '2 restored',
        notes: [],
      },
      {
        label: 'Downloads',
        outcome: 'skipped_by_user',
        summary: 'disabled for this restore',
        notes: [],
      },
      {
        label: 'History',
        outcome: 'not_in_backup',
        summary: 'not present in backup',
        notes: [],
      },
    ];
    await page.evaluate(
      (results) => window.__api.seedDashboardState({ restore: { results } }),
      restoreOutcomeFixtures
    );
    for (const label of [
      'Complete',
      'Partial (1 succeeded, 1 failed)',
      'Failed',
      'Unavailable',
      'Skipped by user',
      'Absent from backup',
    ]) {
      assert.ok(
        await page.getByText(label, { exact: true }).isVisible(),
        `${label} outcome label should be visible`
      );
    }
    assert.ok(
      await page
        .getByText('Mixed tabs: 2 tabs attempted', { exact: true })
        .isVisible(),
      'handler summary should remain beside its outcome'
    );
    assert.ok(
      await page.getByText(/one tab could not navigate/).isVisible(),
      'handler notes should remain beside its outcome'
    );
    assert.match(
      await page
        .getByText('Skipped by user', { exact: true })
        .getAttribute('class'),
      /bg-secondary/,
      'user-skipped results should use neutral styling'
    );
    assert.match(
      await page
        .getByText('Absent from backup', { exact: true })
        .getAttribute('class'),
      /bg-secondary/,
      'absent results should use neutral styling'
    );
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );

    const preservedValues = {
      'bbr:artifact:task3-sentinel': {
        id: 'task3-sentinel',
        bytes: 'durable-artifact',
      },
      'bbr:local-manifest': { artifacts: ['task3-sentinel'] },
      'bbr:pending-upload': {
        id: 'task3-pending-upload',
        retryCancelled: true,
      },
      'bbr:cloud-config': {
        github: {
          token: 'task3-secret-sentinel',
          owner: 'sentinel',
          repo: 'vault',
        },
      },
      'bbr:cloud-state': { phase: 'upload-pending', id: 'task3-cloud-state' },
      'bbr:site-data-owned-tabs': { tabIds: [], task3Sentinel: 'owned-tabs' },
    };
    await page.evaluate(
      async (values) =>
        chrome.storage.local.set({
          ...values,
          'bbr:last-backup': {
            backup: { private: 'legacy-raw-cache' },
            at: Date.now(),
          },
        }),
      preservedValues
    );

    // Opening a new preview normally clears old restore outcomes. Seed one prior
    // completion back into the same store to assert both contracts together.
    await page.locator('#local-restore').click();
    await page.locator('#restore-file').setInputFiles({
      name: 'task3-pending-preview.json',
      mimeType: 'application/json',
      buffer: Buffer.from(restoreText),
    });
    await page.locator('#section-restore [data-cat="bookmarks"]').waitFor();
    await page.evaluate(() =>
      window.__api.seedDashboardState({
        restore: {
          pickError: 'previous restore error',
          progress: {
            visible: false,
            frac: 1,
            status: 'previous restore finished',
          },
          results: [
            {
              label: 'Bookmarks',
              outcome: 'complete',
              summary: '1 bookmark restored',
              notes: [],
            },
          ],
        },
      })
    );
    await page.evaluate(() => {
      window.location.hash = '#/summary';
    });
    await page.locator('#clear-results').waitFor();

    const beforeClearState = await page.evaluate(() =>
      window.__api.dashboardState()
    );
    assert.ok(
      beforeClearState.backup.summary.length > 0,
      'backup summary should be visible before clearing'
    );
    assert.equal(
      beforeClearState.backup.downloadInfo?.ready,
      true,
      'download should be ready before clearing'
    );
    assert.ok(
      beforeClearState.restore.summary?.rows.some(
        (row) => row.cat === 'bookmarks'
      )
    );
    assert.equal(beforeClearState.restore.results.length, 1);
    await page.locator('#clear-results').click();
    await page.waitForFunction(() => {
      const state = window.__api.dashboardState();
      return (
        state.backup.summary.length === 0 &&
        state.backup.downloadInfo?.ready === false
      );
    });
    const clearedState = await page.evaluate(() =>
      window.__api.dashboardState()
    );
    assert.equal(
      clearedState.backup.downloadInfo?.ready,
      false,
      'clear should remove download-ready state'
    );
    assert.equal(
      clearedState.backup.siteScan,
      null,
      'clear should remove completed scan presentation'
    );
    assert.deepEqual(
      clearedState.restore.results,
      [],
      'clear should remove completed restore results'
    );
    assert.equal(
      clearedState.restore.pickError,
      null,
      'clear should remove restore selection errors'
    );
    assert.equal(
      clearedState.restore.progress.visible,
      false,
      'clear should hide completed restore progress'
    );
    assert.ok(
      clearedState.restore.summary?.rows.some((row) => row.cat === 'bookmarks'),
      'clear should preserve the pending restore preview'
    );
    await page.getByRole('button', { name: 'Download results' }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Download results' }).isDisabled(),
      true
    );
    const preservedAfterClear = await page.evaluate(
      async (keys) => chrome.storage.local.get(keys),
      [...Object.keys(preservedValues), 'bbr:last-backup']
    );
    for (const [key, value] of Object.entries(preservedValues)) {
      assert.deepEqual(
        preservedAfterClear[key],
        value,
        `${key} must survive Clear Results`
      );
    }
    assert.equal(
      Object.hasOwn(preservedAfterClear, 'bbr:last-backup'),
      false,
      'clear should remove only the legacy raw cache'
    );
    assert.equal(
      (
        await page.evaluate(
          (title) => chrome.bookmarks.search({ title }),
          bookmarkTitle
        )
      ).length,
      1,
      'Clear Results must not delete browser bookmarks'
    );

    // Retryable URL states and checkpoints independently fail closed.
    await page.evaluate(() =>
      window.__api.seedDashboardState({
        backup: {
          siteScan: {
            done: 0,
            fetched: 1,
            failed: 1,
            aborted: 0,
            total: 1,
            inGroup: 0,
            slotsUsed: 0,
            slotsTotal: 1,
            queue: 0,
            cpuPct: null,
            window: 1,
            windowMax: 1,
            tuning: null,
            urlStates: [
              {
                origin: 'https://retryable.example',
                status: 'fetch-failed',
                attempts: 1,
                error: 'offline',
              },
            ],
          },
        },
      })
    );
    await page.waitForFunction(
      () => document.querySelector('#clear-results')?.disabled === true
    );
    const retryStateBefore = await page.evaluate(() =>
      window.__api.dashboardState()
    );
    assert.equal(
      await page.evaluate(() => window.__api.clearBackupResults()),
      false,
      'retryable URL state must block direct clear'
    );
    const retryStateAfter = await page.evaluate(() =>
      window.__api.dashboardState()
    );
    assert.deepEqual(
      retryStateAfter.backup.siteScan,
      retryStateBefore.backup.siteScan,
      'retryable state must remain unchanged'
    );
    await page.evaluate(async () => {
      await chrome.storage.local.set({
        'bbr:site-data-checkpoint': {
          savedAt: 123,
          origins: { 'https://retryable.example': {} },
        },
      });
      await window.__api.seedDashboardState({ backup: { siteScan: null } });
    });
    await page.waitForFunction(
      () => document.querySelector('#clear-results')?.disabled === true
    );
    const checkpointBefore = await page.evaluate(async () => ({
      state: window.__api.dashboardState(),
      storage: await chrome.storage.local.get('bbr:site-data-checkpoint'),
    }));
    assert.equal(
      await page.evaluate(() => window.__api.clearBackupResults()),
      false,
      'a resumable checkpoint must block direct clear'
    );
    const checkpointAfter = await page.evaluate(async () => ({
      state: window.__api.dashboardState(),
      storage: await chrome.storage.local.get('bbr:site-data-checkpoint'),
    }));
    assert.deepEqual(
      checkpointAfter.state.backup,
      checkpointBefore.state.backup
    );
    assert.deepEqual(
      checkpointAfter.state.restore,
      checkpointBefore.state.restore
    );
    assert.deepEqual(
      checkpointAfter.storage,
      checkpointBefore.storage,
      'blocked clear must preserve the checkpoint'
    );
    await page.evaluate(() =>
      chrome.storage.local.remove('bbr:site-data-checkpoint')
    );
    await page.waitForFunction(
      () => document.querySelector('#clear-results')?.disabled === false,
      null,
      { timeout: 10000 }
    );
    await activityPage.close();
    console.log(
      'PASS Clear Results: activity locks, blocked retry/checkpoint states, pending preview, and recovery-state preservation'
    );

    // Clear Logs removes both log stores and both dashboard log views, while
    // stale persisted reads and a delayed pre-clear logger flush are in flight.
    await page.setViewportSize({ width: 1100, height: 500 });
    const clearLogSeeds = Array.from({ length: 620 }, (_, index) => ({
      id: index === 619 ? 'clear-log-stale-error' : `clear-log-seed-${index}`,
      seq: index,
      ts: Date.now() + index,
      crawlId: 'clear-log-test',
      level: index === 619 ? 'ERROR' : 'INFO',
      category: 'SYSTEM',
      message:
        index === 619
          ? 'stale-error-marker'
          : index === 618
            ? 'crawl started: 0 origin(s) selected'
            : `clear-log seed row ${index}`,
      corr: null,
      url: null,
      context: { test: true },
    }));
    await page.evaluate(async (rows) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('bbr-site-log');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (
        !db.objectStoreNames.contains('entries-v2') ||
        !db.objectStoreNames.contains('entries')
      ) {
        db.close();
        throw new Error('Clear Logs test requires both v2 and legacy stores');
      }
      const tx = db.transaction('entries-v2', 'readwrite');
      for (const row of rows) tx.objectStore('entries-v2').add(row);
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          const error = tx.error || new Error('failed to seed Clear Logs rows');
          db.close();
          reject(error);
        };
      });
    }, clearLogSeeds);

    const logActivityPage = await extensionContext.newPage();
    await logActivityPage.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );
    await logActivityPage.locator('#clear-results').waitFor();
    await page.evaluate(() => {
      const nativeSetTimeout = window.setTimeout.bind(window);
      window.__nativeSiteLogTimeout = nativeSetTimeout;
      window.__heldSiteLogTimeouts = [];
      window.setTimeout = (callback, delay, ...args) => {
        if (delay === 1000) {
          const handle = nativeSetTimeout(() => {}, 60000);
          window.__heldSiteLogTimeouts.push({ callback, args, handle });
          return handle;
        }
        return nativeSetTimeout(callback, delay, ...args);
      };
    });
    await page.evaluate(() => {
      window.location.hash = '#/log';
    });
    await page.locator('#site-log-panel').waitFor({ timeout: 10000 });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('#site-log-panel > div.flex').length >= 500,
      null,
      { timeout: 10000 }
    );
    await page.getByText('stale-error-marker', { exact: true }).waitFor();
    const clearLogsButton = page.locator('#clear-logs');
    assert.equal(
      await clearLogsButton.count(),
      1,
      'Log page should expose Clear Logs'
    );
    assert.match(
      await page.locator('main').textContent(),
      /Clear Logs removes dashboard and crawl logs only.*results.*backups.*browser data/i,
      'Clear Logs copy should state what log data is removed and preserved'
    );

    await page.evaluate(() => {
      const bookmarks = chrome.bookmarks;
      const nativeGetTree = bookmarks.getTree.bind(bookmarks);
      window.__bookmarkGetTreeDescriptor =
        Object.getOwnPropertyDescriptor(bookmarks, 'getTree') || null;
      Object.defineProperty(bookmarks, 'getTree', {
        configurable: true,
        value: (...args) =>
          new Promise((resolve, reject) => {
            window.__nativeSiteLogTimeout(
              () => nativeGetTree(...args).then(resolve, reject),
              450
            );
          }),
      });
      window.__clearLogsBackupPromise = window.__api.runBackupToFile({
        collectOptions: {
          selectedCategories: ['bookmarks', 'siteData'],
          siteData: { includeOrigins: [] },
        },
      });
    });
    await page.waitForFunction(
      () => document.querySelector('#clear-logs')?.disabled === true,
      null,
      {
        timeout: 10000,
      }
    );
    await logActivityPage.waitForFunction(
      () => document.querySelector('#clear-results')?.disabled === true,
      null,
      {
        timeout: 10000,
      }
    );
    await page
      .getByText('crawl started: 0 origin(s) selected', { exact: true })
      .waitFor({ timeout: 10000 });
    assert.match(
      await page.locator('#log').textContent(),
      /backup starting: categories=/,
      'backup should add a dashboard-buffer line'
    );
    const clearLogsBackupState = await page.evaluate(async () => {
      const result = await window.__clearLogsBackupPromise;
      if (window.__bookmarkGetTreeDescriptor)
        Object.defineProperty(
          chrome.bookmarks,
          'getTree',
          window.__bookmarkGetTreeDescriptor
        );
      else delete chrome.bookmarks.getTree;
      return { result, state: window.__api.dashboardState() };
    });
    assert.ok(
      clearLogsBackupState.result.counts.bookmarks >= 1,
      'local backup used for log tests should complete'
    );
    assert.equal(
      await clearLogsButton.isDisabled(),
      false,
      'Clear Logs should re-enable after backup settles'
    );
    assert.equal(
      await logActivityPage.locator('#clear-results').isDisabled(),
      false,
      'Clear Results should re-enable after backup settles'
    );
    const siteLogChunkName = (await readdir(join(buildDir, 'chunks'))).find(
      (name) => name.startsWith('site-log-')
    );
    assert.ok(
      siteLogChunkName,
      'production build should contain the site-log module'
    );
    await page.evaluate(async (chunkName) => {
      const siteLogModule = await import(
        chrome.runtime.getURL(`chunks/${chunkName}`)
      );
      const createSiteLogger = Object.values(siteLogModule).find(
        (value) =>
          typeof value === 'function' && value.toString().includes('flushCount')
      );
      if (!createSiteLogger)
        throw new Error(
          'could not locate the production createSiteLogger export'
        );
      window.__preClearPendingLogger = createSiteLogger({
        crawlId: 'clear-logs-pending-flush',
        flushMs: 1000,
      });
      window.__preClearPendingLogger.log(
        'ERROR',
        'SYSTEM',
        'pre-clear-flush-error-marker'
      );
    }, siteLogChunkName);
    assert.ok(
      await page.evaluate(() => window.__heldSiteLogTimeouts.length > 0),
      'test should hold a real pre-clear structured-log flush'
    );

    const peerBackup = await logActivityPage.evaluate(() =>
      window.__api.runBackupToFile({
        collectOptions: {
          selectedCategories: ['bookmarks'],
          siteData: { includeOrigins: [] },
        },
      })
    );
    assert.ok(
      peerBackup.counts.bookmarks >= 1,
      'peer page should have its own dashboard log buffer before clear'
    );
    await page.waitForFunction(
      () => document.querySelector('#clear-logs')?.disabled === false,
      null,
      { timeout: 10000 }
    );

    const clearLogsScanFixture = {
      done: 5,
      fetched: 7,
      failed: 2,
      aborted: 1,
      total: 8,
      inGroup: 2,
      slotsUsed: 1,
      slotsTotal: 4,
      queue: 3,
      cpuPct: 38,
      window: 2,
      windowMax: 9,
      tuning: 'steady',
      urlStates: [
        {
          origin: 'https://scan.example/',
          status: 'saved',
          attempts: 2,
          error: null,
        },
      ],
      logUnseenError: true,
      logCounts: { INFO: 9, WARN: 3, ERROR: 2, FATAL: 1 },
      crawlState: 'stopped',
      worker1: 'done',
      worker2: 'idle',
    };
    const seedClearLogsScan = async (targetPage) =>
      targetPage.evaluate((scan) => {
        const current = window.__api.dashboardState();
        window.__api.seedDashboardState({
          backup: { ...current.backup, siteScan: scan },
        });
      }, clearLogsScanFixture);
    await seedClearLogsScan(page);
    await seedClearLogsScan(logActivityPage);
    await page
      .getByText('Unseen ERROR/FATAL entries', { exact: true })
      .waitFor();
    await logActivityPage
      .getByText('Unseen ERROR/FATAL entries', { exact: true })
      .waitFor();

    await page.evaluate(() =>
      chrome.storage.local.set({
        'bbr:last-backup': { sentinel: 'clear-logs-must-preserve-backup' },
        'bbr:site-data-checkpoint': {
          sentinel: 'clear-logs-must-preserve-checkpoint',
        },
      })
    );
    const storageBeforeClear = await page.evaluate(() =>
      chrome.storage.local.get(['bbr:last-backup', 'bbr:site-data-checkpoint'])
    );
    const snapshotClearLogPage = async (targetPage) =>
      targetPage.evaluate(() => {
        const state = window.__api.dashboardState();
        return {
          rows: [
            ...document.querySelectorAll('#site-log-panel > div.flex'),
          ].map((row) => row.textContent),
          log: document.querySelector('#log')?.textContent ?? null,
          badge: document.body.textContent.includes(
            'Unseen ERROR/FATAL entries'
          ),
          backup: JSON.parse(JSON.stringify(state.backup)),
          restore: JSON.parse(JSON.stringify(state.restore)),
        };
      });
    const readClearLogCounts = async (targetPage) =>
      targetPage.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('bbr-site-log');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const names = ['entries-v2', 'entries'].filter((name) =>
          db.objectStoreNames.contains(name)
        );
        const tx = db.transaction(names, 'readonly');
        const readCount = (name) =>
          new Promise((resolve, reject) => {
            const request = tx.objectStore(name).count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        const counts = await Promise.all(names.map(readCount));
        db.close();
        return counts;
      });
    const readClearLogMetadata = async (targetPage) =>
      targetPage.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('bbr-site-log');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const rows = await new Promise((resolve, reject) => {
          const request = db
            .transaction('metadata', 'readonly')
            .objectStore('metadata')
            .getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
        return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
      });
    const readClearLogMessages = async (targetPage, text) =>
      targetPage.evaluate(async (matchText) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('bbr-site-log');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const rows = await new Promise((resolve, reject) => {
          const request = db
            .transaction('entries-v2', 'readonly')
            .objectStore('entries-v2')
            .getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
        return rows
          .filter((entry) => entry.message.includes(matchText))
          .map((entry) => entry.message);
      }, text);
    const readClearLogEntries = async (targetPage, text) =>
      targetPage.evaluate(async (matchText) => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open('bbr-site-log');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const rows = await new Promise((resolve, reject) => {
          const request = db
            .transaction('entries-v2', 'readonly')
            .objectStore('entries-v2')
            .getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        db.close();
        return rows.filter((entry) => entry.message.includes(matchText));
      }, text);

    // Hold the query's result after its IndexedDB transaction has completed.
    // This lets page A clear the database while page B still has old rows in flight.
    await logActivityPage.evaluate(() => {
      window.__nativeSiteLogPromiseDescriptor =
        Object.getOwnPropertyDescriptor(window, 'Promise') || null;
      window.__nativeSiteLogOpenCursorDescriptor =
        Object.getOwnPropertyDescriptor(IDBIndex.prototype, 'openCursor') ||
        null;
      window.__holdNextSiteLogQueryPromise = false;
      window.__siteLogQueryResolved = false;
      window.__siteLogQueryTransactionComplete = false;
      window.__siteLogQueryWasReleased = false;
      const NativePromise = window.Promise;
      window.Promise = class extends NativePromise {
        static get [Symbol.species]() {
          return NativePromise;
        }
        constructor(executor) {
          if (window.__holdNextSiteLogQueryPromise) {
            window.__holdNextSiteLogQueryPromise = false;
            super((resolve, reject) =>
              executor((value) => {
                window.__siteLogQueryResolved = true;
                window.__releaseSiteLogQuery = () => {
                  window.__siteLogQueryWasReleased = true;
                  resolve(value);
                };
              }, reject)
            );
          } else {
            super(executor);
          }
        }
      };
      const nativeOpenCursor = IDBIndex.prototype.openCursor;
      IDBIndex.prototype.openCursor = function (...args) {
        const request = nativeOpenCursor.apply(this, args);
        if (this.name === 'ts' && this.objectStore.name === 'entries-v2') {
          window.__holdNextSiteLogQueryPromise = true;
          request.transaction.addEventListener(
            'complete',
            () => {
              window.__siteLogQueryTransactionComplete = true;
            },
            { once: true }
          );
        }
        return request;
      };
      window.location.hash = '#/log';
    });
    await logActivityPage
      .locator('#site-log-panel')
      .waitFor({ timeout: 10000 });
    await logActivityPage.locator('#log').waitFor({ timeout: 10000 });
    assert.match(
      await logActivityPage.locator('#log').textContent(),
      /backup starting: categories=/
    );
    await logActivityPage.waitForFunction(
      () =>
        window.__siteLogQueryResolved === true &&
        window.__siteLogQueryTransactionComplete === true &&
        typeof window.__releaseSiteLogQuery === 'function',
      null,
      { timeout: 10000 }
    );
    assert.equal(
      await logActivityPage.locator('#site-log-panel > div.flex').count(),
      0,
      'the peer query should still be pending before its persisted result is delivered'
    );

    const failedClearReadEntry = {
      id: 'clear-failed-read-regression',
      seq: 7,
      ts: Date.now() + 20000,
      crawlId: 'clear-failed-read',
      level: 'INFO',
      category: 'SYSTEM',
      message: 'failed-clear-persisted-read-marker',
      corr: null,
      url: null,
      context: {},
    };
    await page.evaluate(async (entry) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('bbr-site-log');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('entries-v2', 'readwrite');
      tx.objectStore('entries-v2').add(entry);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () =>
          reject(
            tx.error || new Error('failed to seed failed-clear read marker')
          );
      });
      db.close();
    }, failedClearReadEntry);

    // Hold a real local persisted read on page A across its failed clear attempt.
    await page.evaluate(() => {
      window.location.hash = '#/summary';
    });
    await page.locator('#local-backup').waitFor({ timeout: 10000 });
    await page.evaluate(() => {
      window.__nativeSiteLogPromiseDescriptor =
        Object.getOwnPropertyDescriptor(window, 'Promise') || null;
      window.__nativeSiteLogOpenCursorDescriptor =
        Object.getOwnPropertyDescriptor(IDBIndex.prototype, 'openCursor') ||
        null;
      window.__holdNextSiteLogQueryPromise = false;
      window.__siteLogQueryResolved = false;
      window.__siteLogQueryTransactionComplete = false;
      window.__siteLogQueryWasReleased = false;
      const NativePromise = window.Promise;
      window.Promise = class extends NativePromise {
        static get [Symbol.species]() {
          return NativePromise;
        }
        constructor(executor) {
          if (window.__holdNextSiteLogQueryPromise) {
            window.__holdNextSiteLogQueryPromise = false;
            super((resolve, reject) =>
              executor((value) => {
                window.__siteLogQueryResolved = true;
                window.__releaseSiteLogQuery = () => {
                  window.__siteLogQueryWasReleased = true;
                  resolve(value);
                };
              }, reject)
            );
          } else {
            super(executor);
          }
        }
      };
      const nativeOpenCursor = IDBIndex.prototype.openCursor;
      IDBIndex.prototype.openCursor = function (...args) {
        const request = nativeOpenCursor.apply(this, args);
        if (this.name === 'ts' && this.objectStore.name === 'entries-v2') {
          window.__holdNextSiteLogQueryPromise = true;
          request.transaction.addEventListener(
            'complete',
            () => {
              window.__siteLogQueryTransactionComplete = true;
            },
            { once: true }
          );
        }
        return request;
      };
      window.location.hash = '#/log';
    });
    await page.locator('#site-log-panel').waitFor({ timeout: 10000 });
    await page.waitForFunction(
      () =>
        window.__siteLogQueryResolved === true &&
        window.__siteLogQueryTransactionComplete === true &&
        typeof window.__releaseSiteLogQuery === 'function',
      null,
      { timeout: 10000 }
    );

    const databaseBeforeFailedClears =
      await readClearLogCounts(logActivityPage);
    const clearWatermarkBeforeFailedClears = (
      await readClearLogMetadata(logActivityPage)
    ).clearWatermark;
    const viewBeforeFailedClears = await snapshotClearLogPage(page);

    // Start a real enabled-button click, delay its native request, and let the peer acquire the lock first.
    await page.evaluate(() => {
      const locks = navigator.locks;
      const nativeRequest = locks.request.bind(locks);
      window.__clearLogsRequestDescriptor =
        Object.getOwnPropertyDescriptor(locks, 'request') || null;
      window.__clearLogsRequestDelayed = false;
      Object.defineProperty(locks, 'request', {
        configurable: true,
        value(name, options, callback) {
          if (
            name === 'bbr:dashboard-operation' &&
            !window.__clearLogsRequestDelayed
          ) {
            window.__clearLogsRequestDelayed = true;
            return new Promise((resolve, reject) => {
              window.__resumeClearLogsRequest = () =>
                nativeRequest(name, options, callback).then(resolve, reject);
            });
          }
          return nativeRequest(name, options, callback);
        },
      });
    });
    await clearLogsButton.click();
    await page.waitForFunction(
      () => typeof window.__resumeClearLogsRequest === 'function',
      null,
      { timeout: 10000 }
    );
    await startNativeActivity(logActivityPage, 'clear-logs-denial');
    await page.evaluate(() => window.__resumeClearLogsRequest());
    await page
      .getByRole('alert')
      .filter({ hasText: 'Clear Logs failed. Logs were not changed.' })
      .waitFor({ timeout: 5000 });
    assert.deepEqual(
      await snapshotClearLogPage(page),
      viewBeforeFailedClears,
      'a lock-denied Clear Logs attempt must leave the log view and scan state unchanged'
    );
    assert.deepEqual(
      await readClearLogCounts(logActivityPage),
      databaseBeforeFailedClears,
      'a lock-denied Clear Logs attempt must preserve database sentinels'
    );
    assert.equal(
      (await readClearLogMetadata(logActivityPage)).clearWatermark,
      clearWatermarkBeforeFailedClears,
      'a lock-denied Clear Logs attempt must not commit a clear watermark'
    );
    await page.evaluate(() => {
      if (window.__clearLogsRequestDescriptor)
        Object.defineProperty(
          navigator.locks,
          'request',
          window.__clearLogsRequestDescriptor
        );
      else delete navigator.locks.request;
    });
    await releaseNativeActivity(logActivityPage);
    await page.waitForFunction(
      () => document.querySelector('#clear-logs')?.disabled === false,
      null,
      { timeout: 10000 }
    );

    // Model Web Locks disappearing between render and click; the existing enabled control now runs the actual handler.
    const clearLogsLocksDisabled = await page.evaluate(() => {
      try {
        window.__navigatorLocksDescriptor =
          Object.getOwnPropertyDescriptor(navigator, 'locks') || null;
        Object.defineProperty(navigator, 'locks', {
          configurable: true,
          value: undefined,
        });
        return navigator.locks === undefined;
      } catch {
        return false;
      }
    });
    assert.equal(
      clearLogsLocksDisabled,
      true,
      'test should simulate a browser without Web Locks'
    );
    assert.equal(
      await clearLogsButton.isDisabled(),
      false,
      'the already-rendered enabled button should exercise the unavailable-lock race'
    );
    await clearLogsButton.click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'Clear Logs failed. Logs were not changed.' })
      .waitFor({ timeout: 5000 });
    assert.deepEqual(
      await snapshotClearLogPage(page),
      viewBeforeFailedClears,
      'Clear Logs without Web Locks must not mutate memory, dashboard output, or scan state'
    );
    assert.deepEqual(
      await readClearLogCounts(logActivityPage),
      databaseBeforeFailedClears,
      'Clear Logs without Web Locks must preserve database sentinels'
    );
    assert.equal(
      (await readClearLogMetadata(logActivityPage)).clearWatermark,
      clearWatermarkBeforeFailedClears,
      'Clear Logs without Web Locks must not commit a clear watermark'
    );
    await page.evaluate(() => {
      if (window.__navigatorLocksDescriptor)
        Object.defineProperty(
          navigator,
          'locks',
          window.__navigatorLocksDescriptor
        );
      else delete navigator.locks;
      window.__api.seedDashboardState({ restore: { pickError: null } });
    });
    await page.waitForFunction(
      () => document.querySelector('#clear-logs')?.disabled === false,
      null,
      { timeout: 10000 }
    );

    // Fail closed when DB open fails: view memory, dashboard lines, storage, and rows stay untouched.
    await page.evaluate(() => {
      window.__indexedDbOpenDescriptor =
        Object.getOwnPropertyDescriptor(indexedDB, 'open') || null;
      Object.defineProperty(indexedDB, 'open', {
        configurable: true,
        value: () => {
          throw new DOMException(
            'simulated IndexedDB open failure',
            'UnknownError'
          );
        },
      });
    });
    await clearLogsButton.click();
    await page.waitForTimeout(80);
    await page.evaluate(() => {
      if (window.__indexedDbOpenDescriptor)
        Object.defineProperty(
          indexedDB,
          'open',
          window.__indexedDbOpenDescriptor
        );
      else delete indexedDB.open;
    });
    assert.deepEqual(
      await snapshotClearLogPage(page),
      viewBeforeFailedClears,
      'an IndexedDB-open failure must leave memory, logLines, and scan data unchanged'
    );
    assert.deepEqual(
      await readClearLogCounts(logActivityPage),
      databaseBeforeFailedClears,
      'an IndexedDB-open failure must preserve database sentinels'
    );
    assert.equal(
      (await readClearLogMetadata(logActivityPage)).clearWatermark,
      clearWatermarkBeforeFailedClears,
      'an IndexedDB-open failure must not commit a clear watermark'
    );

    await page.evaluate(async () => window.__preClearPendingLogger.flush());
    await page.evaluate(() => window.__releaseSiteLogQuery());
    await page.waitForFunction(
      () => window.__siteLogQueryWasReleased === true,
      null,
      { timeout: 10000 }
    );
    let failedClearReadMerged = false;
    try {
      await page.waitForFunction(
        (message) =>
          document
            .querySelector('#site-log-panel')
            ?.textContent.includes(message),
        'failed-clear-persisted-read-marker',
        { timeout: 1000 }
      );
      failedClearReadMerged = true;
    } catch {
      // The assertion below records that a failed clear incorrectly suppressed this real persisted query.
    }
    await page.evaluate(() => {
      if (window.__nativeSiteLogOpenCursorDescriptor) {
        Object.defineProperty(
          IDBIndex.prototype,
          'openCursor',
          window.__nativeSiteLogOpenCursorDescriptor
        );
      } else {
        delete IDBIndex.prototype.openCursor;
      }
      if (window.__nativeSiteLogPromiseDescriptor) {
        Object.defineProperty(
          window,
          'Promise',
          window.__nativeSiteLogPromiseDescriptor
        );
      } else {
        delete window.Promise;
      }
    });
    assert.deepEqual(
      {
        flushedBufferMessages: await readClearLogMessages(
          page,
          'pre-clear-flush-error-marker'
        ),
        failedClearReadMerged,
      },
      {
        flushedBufferMessages: ['pre-clear-flush-error-marker'],
        failedClearReadMerged: true,
      },
      'failed Clear Logs must preserve pending logger buffers and let persisted reads merge'
    );
    const viewAfterFailedClearRead = await snapshotClearLogPage(page);
    const databaseAfterFailedClearBufferFlush = await readClearLogCounts(page);
    const clearWatermarkBeforeFailedTransaction = (
      await readClearLogMetadata(page)
    ).clearWatermark;

    // Abort after the watermark put is queued: IDB must roll the marker and store clears back together.
    await page.evaluate(() => {
      window.__databasePutDescriptor =
        Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'put') ||
        null;
      const nativePut = IDBObjectStore.prototype.put;
      window.__clearWatermarkAbortTriggered = false;
      IDBObjectStore.prototype.put = function (value, ...args) {
        const request = nativePut.call(this, value, ...args);
        if (this.name === 'metadata' && value?.key === 'clearWatermark') {
          window.__clearWatermarkAbortTriggered = true;
          const tx = this.transaction;
          queueMicrotask(() => {
            try {
              tx.abort();
            } catch (e) {
              /* transaction is already aborting */
            }
          });
        }
        return request;
      };
    });
    await clearLogsButton.click();
    await page.waitForFunction(
      () => window.__clearWatermarkAbortTriggered === true,
      null,
      { timeout: 10000 }
    );
    await page.waitForTimeout(80);
    await page.evaluate(() => {
      if (window.__databasePutDescriptor) {
        Object.defineProperty(
          IDBObjectStore.prototype,
          'put',
          window.__databasePutDescriptor
        );
      } else {
        delete IDBObjectStore.prototype.put;
      }
    });
    assert.deepEqual(
      await snapshotClearLogPage(page),
      viewAfterFailedClearRead,
      'a clear-transaction failure must leave memory, logLines, and scan data unchanged'
    );
    assert.deepEqual(
      await readClearLogCounts(logActivityPage),
      databaseAfterFailedClearBufferFlush,
      'an aborted clear transaction must preserve database sentinels'
    );
    assert.equal(
      (await readClearLogMetadata(logActivityPage)).clearWatermark,
      clearWatermarkBeforeFailedTransaction,
      'an aborted clear transaction must not commit a clear watermark'
    );

    const clearLogsStateBeforeSuccess = await page.evaluate(() =>
      window.__api.dashboardState()
    );
    const peerStateBeforeSuccess = await logActivityPage.evaluate(() =>
      window.__api.dashboardState()
    );
    const scanBeforeSuccess = await page.evaluate(() =>
      JSON.parse(JSON.stringify(window.__api.dashboardState().backup.siteScan))
    );
    const peerScanBeforeSuccess = await logActivityPage.evaluate(() =>
      JSON.parse(JSON.stringify(window.__api.dashboardState().backup.siteScan))
    );
    const clearMetadataBeforeSuccess = await readClearLogMetadata(page);
    const clearSameMillisecondTimestamp = 1790900000999;
    await page.evaluate(async (chunkName) => {
      const siteLogModule = await import(
        chrome.runtime.getURL(`chunks/${chunkName}`)
      );
      const createSiteLogger = Object.values(siteLogModule).find(
        (value) =>
          typeof value === 'function' && value.toString().includes('flushCount')
      );
      if (!createSiteLogger)
        throw new Error(
          'could not locate the production createSiteLogger export'
        );
      window.__preClearSuccessLogger = createSiteLogger({
        crawlId: 'clear-logs-pre-clear-success',
        flushMs: 60000,
      });
      window.__preClearSuccessLogger.info(
        'SYSTEM',
        'pre-clear-success-buffer-marker'
      );
      window.__duringClearLogger = createSiteLogger({
        crawlId: 'clear-logs-during-clear',
        flushMs: 60000,
      });

      window.__clearTransactionDescriptor =
        Object.getOwnPropertyDescriptor(IDBDatabase.prototype, 'transaction') ||
        null;
      const nativeTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (
        storeNames,
        mode,
        ...options
      ) {
        const tx = nativeTransaction.call(this, storeNames, mode, ...options);
        const names = [...tx.objectStoreNames];
        if (
          mode === 'readwrite' &&
          names.includes('entries-v2') &&
          names.includes('entries')
        ) {
          let completeHandler = null;
          Object.defineProperty(tx, 'oncomplete', {
            configurable: true,
            get() {
              return completeHandler;
            },
            set(handler) {
              completeHandler = handler;
            },
          });
          tx.addEventListener(
            'complete',
            (event) => {
              window.__clearTransactionCommitted = true;
              window.__resumeClearTransactionComplete = () =>
                completeHandler?.call(tx, event);
            },
            { once: true }
          );
        }
        return tx;
      };
    }, siteLogChunkName);
    await logActivityPage.evaluate(
      async ({ chunkName, timestamp }) => {
        const siteLogModule = await import(
          chrome.runtime.getURL(`chunks/${chunkName}`)
        );
        const createSiteLogger = Object.values(siteLogModule).find(
          (value) =>
            typeof value === 'function' &&
            value.toString().includes('flushCount')
        );
        if (!createSiteLogger)
          throw new Error(
            'could not locate the production createSiteLogger export'
          );
        window.__peerDateNowDescriptor =
          Object.getOwnPropertyDescriptor(Date, 'now') || null;
        Object.defineProperty(Date, 'now', {
          configurable: true,
          value: () => timestamp,
        });
        window.__peerPreClearLogger = createSiteLogger({
          crawlId: 'clear-logs-peer-pre-clear',
          flushMs: 60000,
        });
        window.__peerPreClearLogger.info(
          'SYSTEM',
          'peer-pre-clear-buffer-marker'
        );
      },
      { chunkName: siteLogChunkName, timestamp: clearSameMillisecondTimestamp }
    );
    await clearLogsButton.click();
    await page.waitForFunction(
      () => window.__clearTransactionCommitted === true,
      null,
      { timeout: 10000 }
    );
    assert.equal(
      await clearLogsButton.isDisabled(),
      true,
      'the Clear Logs operation remains pending until its transaction success handler runs'
    );
    await page.evaluate(() => {
      window.__duringClearLogger.info('SYSTEM', 'during-clear-retained-marker');
      window.__duringClearFlush = window.__duringClearLogger.flush();
      if (window.__clearTransactionDescriptor) {
        Object.defineProperty(
          IDBDatabase.prototype,
          'transaction',
          window.__clearTransactionDescriptor
        );
      } else {
        delete IDBDatabase.prototype.transaction;
      }
      window.__resumeClearTransactionComplete();
    });
    await page.waitForFunction(
      () => document.querySelector('#log')?.textContent === '(no output yet)',
      null,
      {
        timeout: 10000,
      }
    );
    await page.evaluate(async () => window.__duringClearFlush);
    await logActivityPage.evaluate(async () => {
      await window.__peerPreClearLogger.flush();
    });
    assert.deepEqual(
      await readClearLogMessages(page, 'peer-pre-clear-buffer-marker'),
      [],
      'a pre-clear logger buffer in another dashboard page must be rejected by the durable watermark'
    );
    await page.evaluate(async () => window.__preClearSuccessLogger.flush());
    assert.deepEqual(
      await readClearLogMessages(page, 'pre-clear-success-buffer-marker'),
      [],
      'a local buffered row created before clear must not be resurrected by a later flush'
    );
    const peerPostClearTimestamp = await logActivityPage.evaluate(async () => {
      const timestamp = Date.now();
      window.__peerPreClearLogger.info(
        'SYSTEM',
        'peer-post-clear-same-millisecond-marker'
      );
      if (window.__peerDateNowDescriptor)
        Object.defineProperty(Date, 'now', window.__peerDateNowDescriptor);
      else delete Date.now;
      await window.__peerPreClearLogger.flush();
      return timestamp;
    });
    assert.equal(peerPostClearTimestamp, clearSameMillisecondTimestamp);
    assert.deepEqual(
      (
        await readClearLogEntries(
          page,
          'peer-post-clear-same-millisecond-marker'
        )
      ).map((entry) => entry.ts),
      [clearSameMillisecondTimestamp],
      'a post-clear row with the exact same timestamp as the pre-clear row must remain eligible'
    );
    assert.deepEqual(
      await readClearLogMessages(page, 'during-clear-retained-marker'),
      ['during-clear-retained-marker'],
      'a log created while a successful Clear Logs transaction is pending must persist after the clear'
    );
    assert.equal(
      await page.locator('#site-log-panel > div.flex').count(),
      0,
      'structured log rows should be removed from memory'
    );
    assert.equal(
      await page
        .getByText('Unseen ERROR/FATAL entries', { exact: true })
        .count(),
      0,
      'successful Clear Logs should remove the unseen crawl-error badge'
    );
    assert.doesNotMatch(
      await page.locator('#site-log-panel').textContent(),
      /stale-error-marker|pre-clear-flush-error-marker|crawl started: 0 origin\(s\) selected/
    );
    const expectedClearLogsState = structuredClone(clearLogsStateBeforeSuccess);
    expectedClearLogsState.backup.siteScan.logUnseenError = false;
    assert.deepEqual(
      await page.evaluate(() => window.__api.dashboardState()),
      expectedClearLogsState,
      'Clear Logs may reset only logUnseenError and must preserve all other backup/restore/scan state'
    );
    assert.deepEqual(
      scanBeforeSuccess.logUnseenError,
      true,
      'test starts with the unseen scan-error flag set'
    );
    assert.deepEqual(
      await page.evaluate(() =>
        chrome.storage.local.get([
          'bbr:last-backup',
          'bbr:site-data-checkpoint',
        ])
      ),
      storageBeforeClear,
      'Clear Logs must not alter backup or scan-checkpoint storage'
    );
    await logActivityPage.waitForFunction(
      () => document.querySelector('#log')?.textContent === '(no output yet)',
      null,
      {
        timeout: 10000,
      }
    );
    assert.equal(
      await logActivityPage
        .getByText('Unseen ERROR/FATAL entries', { exact: true })
        .count(),
      0,
      'peer Clear Logs notification should reset only its unseen crawl-error badge'
    );
    const expectedPeerClearState = structuredClone(peerStateBeforeSuccess);
    expectedPeerClearState.backup.siteScan.logUnseenError = false;
    assert.deepEqual(
      await logActivityPage.evaluate(() => window.__api.dashboardState()),
      expectedPeerClearState,
      'peer invalidation must preserve all scan statistics and other dashboard state'
    );
    assert.deepEqual(
      peerScanBeforeSuccess.logUnseenError,
      true,
      'peer test starts with its unseen scan-error flag set'
    );

    const committedClearMetadata = await readClearLogMetadata(logActivityPage);
    assert.ok(
      committedClearMetadata.clearWatermark >=
        clearMetadataBeforeSuccess.nextSequence,
      'successful clear should commit the durable watermark through all previously reserved log sequences'
    );
    assert.ok(
      committedClearMetadata.nextSequence >
        committedClearMetadata.clearWatermark,
      'logs created during and after clear should reserve sequences beyond its committed watermark'
    );
    const clearedLogCounts = await readClearLogCounts(logActivityPage);
    assert.deepEqual(
      clearedLogCounts,
      [2, 0],
      'Clear Logs should retain only the during-clear and post-clear logs, not either pre-clear buffer'
    );
    await logActivityPage.evaluate(() => window.__releaseSiteLogQuery());
    await logActivityPage.waitForFunction(
      () => window.__siteLogQueryWasReleased === true,
      null,
      { timeout: 10000 }
    );
    assert.equal(
      await logActivityPage.locator('#site-log-panel > div.flex').count(),
      0,
      'a persisted query released after peer clear must not resurrect old rows'
    );
    assert.doesNotMatch(
      await logActivityPage.locator('#site-log-panel').textContent(),
      /stale-error-marker/
    );
    await logActivityPage.evaluate(() => {
      if (window.__nativeSiteLogOpenCursorDescriptor) {
        Object.defineProperty(
          IDBIndex.prototype,
          'openCursor',
          window.__nativeSiteLogOpenCursorDescriptor
        );
      } else {
        delete IDBIndex.prototype.openCursor;
      }
      if (window.__nativeSiteLogPromiseDescriptor) {
        Object.defineProperty(
          window,
          'Promise',
          window.__nativeSiteLogPromiseDescriptor
        );
      } else {
        delete window.Promise;
      }
    });
    await page.evaluate(() => {
      window.setTimeout = window.__nativeSiteLogTimeout;
      for (const held of window.__heldSiteLogTimeouts) {
        clearTimeout(held.handle);
        held.callback(...held.args);
      }
      window.__releasedSiteLogFlushes = window.__heldSiteLogTimeouts.length;
      window.__heldSiteLogTimeouts = [];
    });
    await page.waitForTimeout(150);
    assert.ok(
      await page.evaluate(() => window.__releasedSiteLogFlushes > 0),
      'test should release a real pending logger flush'
    );
    assert.equal(
      await page.locator('#site-log-panel > div.flex').count(),
      0,
      'a pre-clear persisted read must not restore old rows'
    );
    assert.doesNotMatch(
      await page.locator('#site-log-panel').textContent(),
      /stale-error-marker|pre-clear-flush-error-marker/
    );
    assert.equal(
      await page.locator('#log').textContent(),
      '(no output yet)',
      'a delayed pre-clear flush must not restore dashboard logs'
    );
    const postFlushCounts = await readClearLogCounts(logActivityPage);
    assert.deepEqual(
      postFlushCounts,
      [2, 0],
      'delayed pre-clear flushes must not repopulate either store or replace newer logs'
    );
    assert.deepEqual(
      await readClearLogMessages(page, 'during-clear-retained-marker'),
      ['during-clear-retained-marker'],
      'releasing delayed pre-clear buffers must not erase the log created during Clear Logs'
    );

    // Scroll each overflow pane independently; neither log may move the page.
    const scrollLogSeeds = Array.from({ length: 80 }, (_, index) => ({
      id: `scroll-log-seed-${index}`,
      seq: index,
      ts: Date.now() + index,
      crawlId: 'scroll-log-test',
      level: 'INFO',
      category: 'SYSTEM',
      message: `scroll log seed ${index}`,
      corr: null,
      url: null,
      context: {},
    }));
    await page.evaluate(async (rows) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('bbr-site-log');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('entries-v2', 'readwrite');
      for (const row of rows) tx.objectStore('entries-v2').add(row);
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          const error = tx.error || new Error('failed to seed scroll log rows');
          db.close();
          reject(error);
        };
      });
    }, scrollLogSeeds);
    await page.evaluate(() => {
      window.location.hash = '#/summary';
    });
    await page.locator('#local-backup').waitFor();
    await page.evaluate(() => {
      window.location.hash = '#/log';
    });
    await page.locator('#site-log-panel').waitFor({ timeout: 10000 });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('#site-log-panel > div.flex').length >= 80,
      null,
      {
        timeout: 10000,
      }
    );
    assert.equal(
      await page
        .locator('#site-log-panel')
        .evaluate((el) => el.scrollHeight > el.clientHeight),
      true,
      'structured panel should overflow for scroll assertions'
    );
    for (
      let i = 0;
      i < 24 &&
      !(await page
        .locator('#log')
        .evaluate((el) => el.scrollHeight > el.clientHeight));
      i += 1
    ) {
      await page.evaluate(() =>
        window.__api.runBackupToFile({
          collectOptions: {
            selectedCategories: ['bookmarks', 'siteData'],
            siteData: { includeOrigins: [] },
          },
        })
      );
    }
    assert.equal(
      await page
        .locator('#log')
        .evaluate((el) => el.scrollHeight > el.clientHeight),
      true,
      'dashboard log buffer should overflow for local-scroll assertions'
    );
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      const panel = document.querySelector('#site-log-panel');
      const log = document.querySelector('#log');
      panel.scrollTop = 0;
      log.scrollTop = 0;
      panel.dispatchEvent(new Event('scroll', { bubbles: true }));
      log.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const pageScrollBeforeNewLog = await page.evaluate(() => window.scrollY);
    const panelScrollBeforeNewLog = await page
      .locator('#site-log-panel')
      .evaluate((el) => el.scrollTop);
    const dashboardLogScrollBeforeNewLine = await page
      .locator('#log')
      .evaluate((el) => el.scrollTop);
    assert.ok(
      await page
        .locator('#site-log-panel')
        .evaluate((el) => el.getBoundingClientRect().top > window.innerHeight),
      'structured panel should be below the viewport'
    );
    await page.evaluate(() =>
      window.__api.runBackupToFile({
        collectOptions: {
          selectedCategories: ['bookmarks', 'siteData'],
          siteData: { includeOrigins: [] },
        },
      })
    );
    assert.equal(
      await page.evaluate(() => window.scrollY),
      pageScrollBeforeNewLog,
      'loading a new entry must not scroll the document'
    );
    assert.equal(
      await page.locator('#site-log-panel').evaluate((el) => el.scrollTop),
      panelScrollBeforeNewLog,
      'auto-follow must not move a panel scrolled away from its bottom'
    );
    assert.equal(
      await page.locator('#log').evaluate((el) => el.scrollTop),
      dashboardLogScrollBeforeNewLine,
      'dashboard log should not follow while its own pane is scrolled up'
    );

    await page.evaluate(() => {
      const panel = document.querySelector('#site-log-panel');
      const log = document.querySelector('#log');
      panel.scrollTop = panel.scrollHeight;
      log.scrollTop = log.scrollHeight;
      panel.dispatchEvent(new Event('scroll', { bubbles: true }));
      log.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const pageScrollAtBottom = await page.evaluate(() => window.scrollY);
    await page.evaluate(() =>
      window.__api.runBackupToFile({
        collectOptions: {
          selectedCategories: ['bookmarks', 'siteData'],
          siteData: { includeOrigins: [] },
        },
      })
    );
    const bottomScrollState = await page.evaluate(() => {
      const panel = document.querySelector('#site-log-panel');
      const log = document.querySelector('#log');
      return {
        page: window.scrollY,
        panelAtBottom:
          panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 1,
        logAtBottom: log.scrollHeight - log.scrollTop - log.clientHeight <= 1,
      };
    });
    assert.equal(
      bottomScrollState.page,
      pageScrollAtBottom,
      'auto-follow must not move document scroll'
    );
    assert.equal(
      bottomScrollState.panelAtBottom,
      true,
      'enabled structured auto-follow should advance only its panel'
    );
    assert.equal(
      bottomScrollState.logAtBottom,
      true,
      'dashboard buffer should follow only when its own pane was at bottom'
    );
    await logActivityPage.close();
    console.log(
      'PASS Clear Logs: failed clears preserve buffers/reads; successful clear drops pre-clear rows, retains during-clear logs, and invalidates peer reads'
    );

    // Restore + encrypted-backup password flow.
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );
    await page.locator('#local-restore').click();
    await page.locator('#section-restore').waitFor({ state: 'visible' });
    await page.goto(
      `chrome-extension://${extensionId}/dashboard.html#/summary`
    );
    await page.locator('#local-backup-encrypted').click();
    await page
      .locator('#section-password')
      .waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(
      await page.locator('#section-password').isVisible(),
      true,
      'encrypted backup action should open its password form'
    );

    assert.deepEqual(
      pageErrors,
      [],
      `extension dashboard should run without page errors: ${pageErrors.join('; ')}`
    );
    console.log(
      'PASS Chromium MV3 (WXT build): dashboard initialized; schedule toggle, settings transfer, retry cancel, restore and password flows all respond'
    );
    await page.close();
  } finally {
    await extensionContext.close();
  }

  // Fault-inject a missing route chunk in an isolated build copy. Recovery must
  // be one-shot, preserve the route hash, and offer a working manual retry.
  const failureBuildDir = await mkdtemp(
    join(tmpdir(), 'bbr-route-chunk-failure-')
  );
  let failureContext;
  try {
    await cp(buildDir, failureBuildDir, { recursive: true });
    const settingsChunkName = (
      await readdir(join(failureBuildDir, 'chunks'))
    ).find((name) => name.startsWith('SettingsPage-'));
    assert.ok(
      settingsChunkName,
      'the build should contain the settings route chunk'
    );
    const copiedChunk = join(failureBuildDir, 'chunks', settingsChunkName);
    const originalChunk = join(buildDir, 'chunks', settingsChunkName);
    await rm(copiedChunk);

    failureContext = await chromium.launchPersistentContext('', {
      ...(process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH }
        : {}),
      headless: !!process.env.CI_HEADLESS,
      viewport: { width: 900, height: 800 },
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--no-sandbox',
        `--disable-extensions-except=${failureBuildDir}`,
        `--load-extension=${failureBuildDir}`,
      ],
    });
    const failureWorker =
      failureContext.serviceWorkers()[0] ||
      (await failureContext.waitForEvent('serviceworker', { timeout: 15000 }));
    const failureExtensionId = new URL(failureWorker.url()).host;
    const failurePage = await failureContext.newPage();
    let routeDocumentNavigations = 0;
    failurePage.on('framenavigated', (frame) => {
      if (
        frame === failurePage.mainFrame() &&
        frame.url().endsWith('/dashboard.html#/settings')
      ) {
        routeDocumentNavigations += 1;
      }
    });
    await failurePage.goto(
      `chrome-extension://${failureExtensionId}/dashboard.html#/settings`
    );
    await failurePage.getByRole('alert').waitFor({ timeout: 15000 });
    assert.ok(
      routeDocumentNavigations >= 2,
      'a failed route chunk should trigger one automatic dashboard reload'
    );
    assert.deepEqual(
      await failurePage.evaluate(() => ({
        hash: location.hash,
        retryGuard: sessionStorage.getItem('bbr:lazy-route-retry:settings'),
      })),
      { hash: '#/settings', retryGuard: '1' },
      'the fallback should preserve the route hash and stop automatic reload loops'
    );
    await copyFile(originalChunk, copiedChunk);
    await failurePage
      .getByRole('button', { name: 'Reload and try again' })
      .click();
    await failurePage.locator('#site-data-count').waitFor({ timeout: 20000 });
    assert.equal(
      await failurePage.evaluate(() => location.hash),
      '#/settings',
      'manual retry should keep the requested route'
    );
    console.log(
      'PASS lazy route failure: one guarded reload, visible fallback, hash preserved, manual retry recovered'
    );
  } finally {
    if (failureContext) await failureContext.close();
    await rm(failureBuildDir, { recursive: true, force: true });
  }
} finally {
  await browser.close();
}
