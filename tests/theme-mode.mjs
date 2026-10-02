// Node unit test for src/dashboard/theme.ts (TypeScript, erasable syntax —
// Node strips types natively). Uses fake document/window/chrome globals.
import assert from 'node:assert/strict';

function installFakes({ systemDark = false, mirror = null, stored = null } = {}) {
  const classes = new Set();
  const style = {};
  const ls = {};
  if (mirror !== null) ls['bbr.dashboard.theme.mirror'] = mirror;
  const store = {};
  if (stored !== null) store['bbr.dashboard.theme'] = stored;
  const mqListeners = new Set();
  let mqMatches = systemDark;
  globalThis.document = {
    documentElement: {
      classList: {
        toggle: (c, force) => { if (force) classes.add(c); else classes.delete(c); },
        contains: (c) => classes.has(c),
      },
      style,
    },
  };
  globalThis.window = {
    localStorage: {
      getItem: (k) => (k in ls ? ls[k] : null),
      setItem: (k, v) => { ls[k] = String(v); },
    },
    matchMedia: () => ({
      get matches() { return mqMatches; },
      addEventListener: (ev, l) => { if (ev === 'change') mqListeners.add(l); },
      addListener: (l) => mqListeners.add(l),
    }),
  };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (k) => ({ [k]: store[k] }),
        set: async (o) => Object.assign(store, o),
      },
    },
  };
  return {
    classes, style, ls, store,
    setSystemDark: (v) => { mqMatches = v; for (const l of mqListeners) l(); },
  };
}

// Fresh module per scenario (module holds `current` in closure).
const importTheme = () => import(`../src/dashboard/theme.ts?x=${Math.random()}`);

{
  // 1) boot with no persisted value -> system -> light here, no dark class
  installFakes({ systemDark: false });
  const t = await importTheme();
  t.initThemeSync();
  assert.equal(t.getTheme(), 'system');
  assert.equal(t.getResolvedTheme(), 'light');
  assert.equal(document.documentElement.classList.contains('dark'), false);
  assert.equal(document.documentElement.style.colorScheme, 'light');
  console.log('PASS boot defaults to system (light), no dark class');
}
{
  // 2) boot applies the localStorage mirror synchronously (no flash)
  installFakes({ mirror: 'dark' });
  const t = await importTheme();
  t.initThemeSync();
  assert.equal(t.getTheme(), 'dark');
  assert.equal(document.documentElement.classList.contains('dark'), true);
  console.log('PASS boot applies persisted dark from mirror synchronously');
}
{
  // 3) setTheme persists to chrome.storage.local + mirror, applies class, notifies
  const f = installFakes({});
  const t = await importTheme();
  t.initThemeSync();
  let notified = 0;
  const unsub = t.subscribeTheme(() => notified++);
  await t.setTheme('dark');
  assert.equal(f.store['bbr.dashboard.theme'], 'dark');
  assert.equal(f.ls['bbr.dashboard.theme.mirror'], 'dark');
  assert.equal(document.documentElement.classList.contains('dark'), true);
  assert.equal(notified, 1);
  await t.setTheme('dark'); // no-op: no duplicate notify
  assert.equal(notified, 1);
  unsub();
  console.log('PASS setTheme persists, applies, notifies once');
}
{
  // 4) loadTheme reconciles from chrome.storage.local
  installFakes({ stored: 'dark' });
  const t = await importTheme();
  t.initThemeSync();
  assert.equal(document.documentElement.classList.contains('dark'), false);
  await t.loadTheme();
  assert.equal(t.getTheme(), 'dark');
  assert.equal(document.documentElement.classList.contains('dark'), true);
  console.log('PASS loadTheme reconciles persisted value');
}
{
  // 5) invalid stored values are ignored
  installFakes({ stored: 'neon', mirror: 'blurple' });
  const t = await importTheme();
  t.initThemeSync();
  await t.loadTheme();
  assert.equal(t.getTheme(), 'system');
  console.log('PASS invalid stored values ignored');
}
{
  // 6) system mode follows OS changes
  const f = installFakes({ systemDark: false });
  const t = await importTheme();
  t.initThemeSync();
  t.watchSystemTheme();
  await t.setTheme('system');
  f.setSystemDark(true);
  assert.equal(t.getResolvedTheme(), 'dark');
  assert.equal(document.documentElement.classList.contains('dark'), true);
  console.log('PASS system mode follows OS dark change');
}

console.log('PASS dashboard theme module');
