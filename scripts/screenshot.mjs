// Visual smoke check: capture dashboard screenshots at desktop + mobile width.
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const buildDir = resolve(root, '.output/chrome-mv3');

const browser = await chromium.launch({ args: ['--no-sandbox'], headless: false });
const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  viewport: { width: 768, height: 1024 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-sandbox', `--disable-extensions-except=${buildDir}`, `--load-extension=${buildDir}`]
});
const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extensionId = new URL(worker.url()).host;
const page = await ctx.newPage();
await page.setViewportSize({ width: 768, height: 1400 });
await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
await page.waitForFunction(() => document.querySelector('#log')?.textContent.includes('dashboard ready'), null, { timeout: 15000 });
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(root, 'shot-desktop.png'), fullPage: true });

// weekly state screenshot
await page.locator('#sched-frequency').click();
await page.getByRole('option', { name: 'Weekly' }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: resolve(root, 'shot-weekly.png'), fullPage: true });

await page.setViewportSize({ width: 360, height: 900 });
await page.waitForTimeout(300);
await page.screenshot({ path: resolve(root, 'shot-mobile.png'), fullPage: true });
await ctx.close();
await browser.close();
console.log('screenshots saved');
