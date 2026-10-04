// E2E: dashboard dark mode toggle in the real browser.
// Cycle light -> dark -> system, assert the `dark` class + computed colors,
// and that the choice persists across reload (no theme flash).
import assert from 'node:assert/strict';
import { launchDashboard } from './launch.mjs';

const { context, page, pageErrors } = await launchDashboard();
try {
  const toggle = page.getByRole('button', { name: /^Switch theme/ });
  await toggle.waitFor({ timeout: 10000 });

  const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
  const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const themeLabel = () => toggle.getAttribute('aria-label');

  // Initial: system theme, resolves to light in this environment.
  assert.equal(await isDark(), false, 'should start without dark class');
  const lightBg = await bodyBg();

  // Click until dark (cycle: system -> light -> dark).
  for (let i = 0; i < 3 && !(await isDark()); i++) await toggle.click();
  assert.equal(await isDark(), true, 'dark class should be applied after toggling to dark');
  assert.match(await themeLabel(), /Dark/, 'toggle should report Dark, got: ' + await themeLabel());
  const darkBg = await bodyBg();
  assert.notEqual(darkBg, lightBg, `background should change in dark mode (light=${lightBg}, dark=${darkBg})`);
  const lum = darkBg.match(/\d+(\.\d+)?/g).map(Number).slice(0, 3);
  const luminance = (0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2]) / 255;
  assert.ok(luminance < 0.25, `dark background should be dark, got ${darkBg}`);

  // Persist across reload.
  await page.reload();
  await page.waitForFunction(() => typeof window.__api !== 'undefined', null, { timeout: 15000 });
  await page.getByRole('button', { name: /^Switch theme/ }).waitFor({ timeout: 10000 });
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains('dark')),
    true,
    'dark theme should persist across reload'
  );

  // Cycle on to system -> resolves to light here, dark class removed.
  const toggle2 = page.getByRole('button', { name: /^Switch theme/ });
  for (let i = 0; i < 3; i++) await toggle2.click(); // dark -> system -> light -> dark
  await toggle2.click(); // -> system
  assert.match(await toggle2.getAttribute('aria-label'), /System/);
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains('dark')),
    false,
    'system theme should resolve to light (no dark class) in this environment'
  );

  assert.deepEqual(pageErrors, [], `dashboard should run without page errors: ${pageErrors.join('; ')}`);
  console.log('PASS dashboard dark mode: toggle cycles, colors change, persists across reload');
} finally {
  await context.close();
}
