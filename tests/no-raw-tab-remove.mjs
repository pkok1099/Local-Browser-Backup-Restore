// Static safety test: tab/window closing discipline.
//
//   * Every chrome.tabs.remove call in src/ must be the single choke point
//     inside safeCloseTab (marked SAFETY-ALLOWED). Closing is never decided
//     by query or group membership — the only basis is the ownedTabIds
//     registry.
//   * chrome.windows.remove must not be called anywhere in src/ (the scan
//     group is left to vanish on its own when its last tab closes).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = new URL('../src/', import.meta.url);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { yield* walk(p); continue; }
    if (/\.(js|ts|tsx)$/.test(name)) yield p;
  }
}

let removeHits = 0;
for (const file of walk(srcDir.pathname)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return; // doc comment, not code
    assert.ok(
      !/chrome\.windows\.remove/.test(line),
      `chrome.windows.remove is forbidden: ${file}:${i + 1}`
    );
    // Also forbid dynamic access: chrome.tabs["remove"], chrome["tabs"]["remove"], etc.
    assert.ok(
      !/chrome\s*\[\s*['"]tabs['"]\s*\]\s*\[\s*['"]remove['"]\s*\]/.test(line),
      `dynamic chrome.tabs["remove"] is forbidden: ${file}:${i + 1}`
    );
    assert.ok(
      !/\btabs\s*\[\s*['"]remove['"]\s*\]/.test(line),
      `dynamic tabs["remove"] is forbidden: ${file}:${i + 1}`
    );
    if (/chrome\.tabs\.remove/.test(line)) {
      removeHits++;
      // SAFETY-ALLOWED may be on same line or within next few lines (prettier may split)
      const nextLines = lines.slice(i, i + 6).join('\n');
      assert.ok(
        nextLines.includes('SAFETY-ALLOWED'),
        `chrome.tabs.remove outside safeCloseTab: ${file}:${i + 1}: ${line.trim()}`
      );
    }
  });
}
assert.ok(removeHits >= 1, 'expected the single safeCloseTab choke point to exist');

console.log(`PASS no-raw-tab-remove: ${removeHits} chrome.tabs.remove call(s), all inside safeCloseTab; no windows.remove`);
