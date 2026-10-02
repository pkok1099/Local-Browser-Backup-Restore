// Extension UI + behavior test for the WXT-built MV3 extension.
// Adapted from the original tests/mobile-ui.mjs: instead of injecting static
// HTML/CSS, it loads the REAL built extension (.output/chrome-mv3) in Chromium
// and exercises the React dashboard: mobile layout, weekly/daily schedule
// toggle, token-safe settings import/export, retry status + cancel, restore
// and password flows.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const buildDir = resolve(root, '.output/chrome-mv3');

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
  headless: !!process.env.CI_HEADLESS // run under xvfb-run (headless:false) or set CI_HEADLESS=1
});

try {
  console.log(`Playwright Chromium ${browser.version()}`);

  // ---- static build checks ----
  const manifest = JSON.parse(await readFile(resolve(buildDir, 'manifest.json'), 'utf8'));
  const background = await readFile(resolve(buildDir, 'background.js'), 'utf8');
  assert.equal(manifest.manifest_version, 3, 'MV3 manifest');
  assert.equal(manifest.action?.default_popup, undefined, 'toolbar action should not open a popup');
  assert.match(background, /chrome\.action\.onClicked\.addListener/, 'toolbar action should open the dashboard from the background worker');
  assert.ok(await readFile(resolve(buildDir, 'lib/pagelib.js'), 'utf8'), 'pagelib.js must ship at the extension root for scripting injection');
  console.log('PASS built manifest + background + pagelib checks');

  // ---- live extension checks (real React dashboard) ----
  const extensionContext = await chromium.launchPersistentContext('', {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless: !!process.env.CI_HEADLESS,
    viewport: { width: 390, height: 844 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', `--disable-extensions-except=${buildDir}`, `--load-extension=${buildDir}`]
  });
  try {
    const worker = extensionContext.serviceWorkers()[0] || await extensionContext.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(worker.url()).host;
    const page = await extensionContext.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    // Mobile layout on the live page: no horizontal overflow, 44px targets.
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`chrome-extension://${extensionId}/dashboard.html#/log`);
      await page.waitForFunction(() => document.querySelector('#log')?.textContent.includes('dashboard ready'), null, { timeout: 15000 });
      await page.goto(`chrome-extension://${extensionId}/dashboard.html#/ringkasan`);
      const metrics = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        buttonHeights: [...document.querySelectorAll('button[data-slot="button"]')]
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => Math.round(el.getBoundingClientRect().height))
      }));
      assert.equal(metrics.innerWidth, width, 'layout viewport should match the target width');
      assert.ok(metrics.scrollWidth <= metrics.innerWidth, `horizontal page overflow (${metrics.scrollWidth}px @ ${width}px)`);
      assert.ok(metrics.buttonHeights.every((h) => h >= 44), `buttons should have 44px touch targets @ ${width}px: ${metrics.buttonHeights.join(',')}`);
      console.log(`PASS live dashboard @ ${width}px: no horizontal overflow, touch targets >=44px`);
    }

    // Core controls exist (Ringkasan page is the default route).
    assert.equal(await page.locator('#local-backup').count(), 1, 'dashboard should expose local backup without a popup');
    assert.equal(await page.locator('#local-restore').count(), 1, 'dashboard should expose restore without a popup');
    // Hash routing: each page renders without a reload (crawl context survives).
    for (const [hash, marker] of [['#/hasil', 'Hasil situs'], ['#/kegagalan', 'Kegagalan'], ['#/pengaturan', 'Website data — retry']]) {
      await page.goto(`chrome-extension://${extensionId}/dashboard.html${hash}`);
      await page.waitForFunction(
        (text) => document.body.textContent.includes(text),
        marker,
        { timeout: 5000 }
      );
    }
    await page.goto(`chrome-extension://${extensionId}/dashboard.html#/ringkasan`);
    assert.deepEqual(pageErrors.filter((e) => !e.includes('net::')), [], 'page navigation should not produce page errors');

    // Cloud controls live on the Lainnya page (hash routing, no reload).
    await page.goto(`chrome-extension://${extensionId}/dashboard.html#/lainnya`);
    await page.waitForFunction(() => document.querySelector('a[href="#/lainnya"]')?.getAttribute('aria-current') === 'page', null, { timeout: 5000 });
    assert.equal(await page.locator('#cloud-only-backup').count(), 1, 'dashboard should expose cloud-only backup');
    assert.equal(await page.locator('#cloud-backup-now').textContent(), 'Both: download + cloud');
    assert.equal(await page.locator('#cloud-auto-retry').count(), 1, 'cloud retry should be optional');
    assert.equal(await page.locator('#sched-frequency').count(), 1, 'weekly frequency control should be available');
    assert.equal(await page.locator('#cloud-retry-status').count(), 1, 'retry details should have a status region');
    assert.equal(await page.locator('#settings-export').count(), 1, 'settings export should be available');
    assert.equal(await page.locator('#settings-import-file').count(), 1, 'settings import should be available');
    // Website-data selection lives on the Pengaturan page.
    await page.goto(`chrome-extension://${extensionId}/dashboard.html#/pengaturan`);
    await page.waitForFunction(() => !document.querySelector('#site-data-count')?.textContent.includes('Finding websites'), null, { timeout: 15000 });
    assert.equal(await page.locator('#site-data-search').count(), 1, 'website-data selection should include a search box');
    assert.equal(await page.locator('#site-data-select-all').count(), 1, 'website-data selection should expose select all');
    assert.match(await page.locator('#site-data-count').textContent(), /websites found · \d+ selected/);
    await page.locator('#site-data-search').fill('not-a-real-domain.invalid');
    assert.equal(await page.locator('#site-data-origin-list label').count(), 0, 'search should filter out nonmatching website origins');

    // Schedule controls live on the Lainnya page (CloudCard).
    await page.goto(`chrome-extension://${extensionId}/dashboard.html#/lainnya`);
    // Weekly <-> daily schedule toggle (Radix Select + Radix Checkboxes).
    await page.locator('#sched-frequency').click();
    await page.getByRole('option', { name: 'Weekly' }).click();
    assert.equal(await page.locator('#sched-weekdays').isVisible(), true, 'weekly selection should reveal day checkboxes');
    assert.deepEqual(
      await page.locator('#sched-weekdays [data-slot="checkbox"][data-state="checked"]').evaluateAll((days) => days.map((d) => Number(d.getAttribute('data-weekday')))),
      [1, 2, 3, 4, 5],
      'weekly schedule should default to weekdays'
    );
    assert.equal(await page.locator('#sched-weekdays [data-slot="checkbox"]').count(), 7, 'weekly schedule should offer all weekdays');
    await page.locator('#sched-frequency').click();
    await page.getByRole('option', { name: 'Daily' }).click();
    assert.equal(await page.locator('#sched-weekdays').isVisible(), false, 'daily selection should hide day checkboxes');

    // Seed a config, then import settings: token must be preserved.
    await page.evaluate(async () => chrome.storage.local.set({ 'bbr:cloud-config': {
      provider: 'github', encryption: 'enabled', autoRetryCloud: false,
      github: { token: 'destination-secret', owner: 'before', repo: 'before-repo', branch: '', basePath: 'browser-backups' },
      schedule: { enabled: false, frequency: 'daily', weekdays: [], hour: 12, minute: 0 },
      retention: { enabled: false, keepLast: 30 }
    } }));
    const importSettings = {
      format: 'browser-backup-settings', version: 1,
      config: {
        provider: 'github', encryption: 'enabled', autoRetryCloud: true,
        github: { token: 'must-not-overwrite', owner: 'after', repo: 'imported-repo', branch: 'main', basePath: 'vault' },
        schedule: { enabled: true, frequency: 'weekly', weekdays: [1, 5], hour: 7, minute: 30 },
        retention: { enabled: true, keepLast: 8 }
      }
    };
    await page.locator('#settings-import-file').setInputFiles({
      name: 'settings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importSettings))
    });
    await page.waitForFunction(() => document.querySelector('#settings-status')?.textContent.includes('Settings imported'), null, { timeout: 10000 });
    const storedConfig = await page.evaluate(async () => (await chrome.storage.local.get('bbr:cloud-config'))['bbr:cloud-config']);
    assert.equal(storedConfig.github.token, 'destination-secret', 'settings import should preserve the current profile token');
    assert.equal(storedConfig.github.repo, 'imported-repo');
    assert.deepEqual(storedConfig.schedule.weekdays, [1, 5]);

    // Unsupported version: rejected, settings unchanged.
    const invalidImport = { ...importSettings, version: 999 };
    await page.locator('#settings-import-file').setInputFiles({
      name: 'unsupported.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalidImport))
    });
    await page.waitForFunction(() => document.querySelector('#settings-status')?.textContent.includes('Settings import failed'), null, { timeout: 10000 });
    const afterInvalidImport = await page.evaluate(async () => (await chrome.storage.local.get('bbr:cloud-config'))['bbr:cloud-config']);
    assert.equal(afterInvalidImport.github.repo, 'imported-repo', 'invalid settings import must leave preferences unchanged');

    // Export: must never contain the token.
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#settings-export').click();
    const settingsDownload = await downloadPromise;
    const stream = await settingsDownload.createReadStream();
    let exportedText = '';
    for await (const chunk of stream) exportedText += chunk.toString();
    assert.equal(exportedText.includes('destination-secret'), false, 'settings export must omit the profile token');
    assert.match(exportedText, /"browser-backup-settings"/, 'export carries the settings format id');

    // Pending upload retry status + cancel.
    await page.evaluate(async () => chrome.storage.local.set({ 'bbr:pending-upload': {
      id: 'retry-test', retryCount: 1, retryAt: new Date(Date.now() + 60_000).toISOString(),
      retryExhausted: false, retryCancelled: false
    } }));
    await page.reload();
    await page.goto(`chrome-extension://${extensionId}/dashboard.html#/log`);
    await page.waitForFunction(() => document.querySelector('#log')?.textContent.includes('dashboard ready'), null, { timeout: 15000 });
    await page.goto(`chrome-extension://${extensionId}/dashboard.html#/lainnya`);
    await page.waitForFunction(() => document.querySelector('#cloud-retry-status')?.textContent.includes('Retry 1/8 scheduled'), null, { timeout: 10000 });
    assert.equal(await page.locator('#cloud-retry-cancel').isVisible(), true, 'scheduled retry should expose cancel action');
    await page.locator('#cloud-retry-cancel').click();
    await page.waitForFunction(() => document.querySelector('#cloud-retry-status')?.textContent.includes('Automatic retries cancelled'), null, { timeout: 10000 });
    const pendingAfterCancel = await page.evaluate(async () => (await chrome.storage.local.get('bbr:pending-upload'))['bbr:pending-upload']);
    assert.equal(pendingAfterCancel.id, 'retry-test', 'cancelling retries should keep the pending artifact');
    assert.equal(pendingAfterCancel.retryAt, null);
    assert.equal(pendingAfterCancel.retryCancelled, true);

    // Restore + encrypted-backup password flow.
    await page.goto(`chrome-extension://${extensionId}/dashboard.html#/ringkasan`);
    await page.locator('#local-restore').click();
    assert.equal(await page.locator('#section-restore').isVisible(), true, 'restore action should reveal the file flow');
    await page.goto(`chrome-extension://${extensionId}/dashboard.html#/ringkasan`);
    await page.locator('#local-backup-encrypted').click();
    assert.equal(await page.locator('#section-password').isVisible(), true, 'encrypted backup action should open its password form');

    assert.deepEqual(pageErrors, [], `extension dashboard should run without page errors: ${pageErrors.join('; ')}`);
    console.log('PASS Chromium MV3 (WXT build): dashboard initialized; schedule toggle, settings transfer, retry cancel, restore and password flows all respond');
    await page.close();
  } finally {
    await extensionContext.close();
  }
} finally {
  await browser.close();
}
