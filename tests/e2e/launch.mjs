// Shared launcher for the E2E suite: loads the REAL built MV3 extension
// (.output/chrome-mv3) in Chromium and opens the dashboard with the
// window.__api automation surface ready.
//
// Run under xvfb-run (headful) or set CI_HEADLESS=1 for headless mode —
// mirrors tests/extension-ui.mjs.
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..', '..');
const buildDir = resolve(root, '.output/chrome-mv3');

export async function launchDashboard({ width = 1280, height = 900 } = {}) {
  const headless = !!process.env.CI_HEADLESS;
  const context = await chromium.launchPersistentContext('', {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    headless,
    viewport: { width, height },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', `--disable-extensions-except=${buildDir}`, `--load-extension=${buildDir}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String((error && error.message) || error)));
    await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
    // Readiness: the automation API is set up by init() regardless of which
    // hash-routed page is showing (the log card lives on the Log page now).
    await page.waitForFunction(() => typeof window.__api !== 'undefined', null, { timeout: 30000 });
    return { context, page, extensionId, pageErrors };
  } catch (e) {
    await context.close();
    throw e;
  }
}

// Calls window.__api inside the dashboard page and normalizes the outcome to
// { ok: true, value } or { ok: false, code, message }.
//
// `expr` is an expression string evaluated against (api, a) — e.g.
//   apiCall(page, `api.cloud.runBackup({ password: a.password })`, { password })
// The wrapper function is constructed in Node (never eval'd inside the page),
// so the extension page's CSP is not an issue; Playwright invokes it via CDP
// with `arg` as its single parameter.
export const apiCall = (page, expr, arg) =>
  page.evaluate(
    // eslint-disable-next-line no-new-func
    new Function(
      'a',
      `return (async () => {
        const api = window.__api;
        try { return { ok: true, value: await (${expr}) }; }
        catch (e) { return { ok: false, code: (e && e.code) || null, message: String((e && e.message) || e) }; }
      })();`
    ),
    arg
  );

export function must(result, what) {
  if (!result.ok) {
    throw new Error(`${what} failed: [${result.code}] ${result.message}`);
  }
  return result.value;
}
