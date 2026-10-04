// E2E: local backup → file → destroy → restore, through the REAL extension.
//
// Flow: seed bookmarks via chrome.bookmarks → __api.runBackupToFile (encrypted,
// real chrome.downloads pipeline) → destroy the seeded folder → wrong password
// rejected → __api.restoreFromText → seeded bookmarks verified back in place.
// Also asserts the encrypted file leaks no plaintext URLs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launchDashboard, apiCall, must } from './launch.mjs';
import { seedBookmarks, destroyBookmarks, readSeededBookmarks, BOOKMARK_SEED, SEED_FOLDER } from './seeds.mjs';

const PASSWORD = 'e2e-local-pw-1';
const collectOptions = { selectedCategories: ['bookmarks'] };
// Mirrors the dashboard UI: the user ticks the categories to restore.
const RESTORE_OPTIONS = { bookmarks: { enabled: true } };

const { context, page, pageErrors } = await launchDashboard();
try {
  // 1) seed profile data through the same API a user interaction would use
  await seedBookmarks(page);
  assert.deepEqual(await readSeededBookmarks(page), BOOKMARK_SEED, 'seeded bookmarks should be visible before backup');

  // 2) encrypted backup — no auto-download; the test explicitly triggers it (like the UI button)
  const meta = must(
    await apiCall(page, `api.runBackupToFile({ encrypt: true, password: a.password, collectOptions: a.collectOptions })`, { password: PASSWORD, collectOptions }),
    'runBackupToFile'
  );
  assert.deepEqual(
    await page.evaluate(() => chrome.storage.local.get('bbr:last-backup')),
    {},
    'encrypted backup should not leave a raw backup cache in extension storage'
  );
  const downloadPromise = page.waitForEvent('download');
  must(await apiCall(page, `api.downloadBackupFile()`, {}), 'downloadBackupFile');
  const download = await downloadPromise;
  const filePath = await download.path();
  assert.ok(filePath, 'download should land on disk');
  const text = await readFile(filePath, 'utf8');
  assert.ok(text.length > 100, 'backup file should be non-trivial');
  assert.match(meta.outName, /\.backup\.enc\.json$/, 'backup file should use the .backup.enc.json name');
  assert.ok(meta.counts.bookmarks >= BOOKMARK_SEED.length, `backup should contain the seeded bookmarks (got ${meta.counts.bookmarks})`);

  // 3) encrypted envelope: no plaintext leakage of bookmark data
  const envelope = JSON.parse(text);
  assert.equal(envelope.format, 'chrome-local-backup-encrypted', 'file should be the encrypted envelope');
  assert.ok(!text.includes('example.com/e2e-one'), 'encrypted file must not leak bookmark URLs in plaintext');
  assert.ok(!text.includes(PASSWORD), 'encrypted file must not contain the password');

  // 4) validation decrypts with the right password
  const validation = must(
    await apiCall(page, `api.validate(a.text, { password: a.password })`, { text, password: PASSWORD }),
    'validate'
  );
  assert.equal(validation.encrypted, true);
  assert.equal(validation.backup.formatVersion, 2);

  // 5) destroy the profile data, verify it is gone
  assert.equal(await destroyBookmarks(page), 1, 'one seeded folder should be removed');
  assert.equal(await readSeededBookmarks(page), null, 'seeded bookmarks should be gone after destroy');

  // 6) wrong password is rejected with the typed error code
  const wrong = await apiCall(page, `api.restoreFromText(a.text, { password: 'wrong-password' })`, { text });
  assert.equal(wrong.ok, false, 'restore with wrong password must fail');
  assert.equal(wrong.code, 'ERR_DECRYPT_FAILED', 'wrong password should surface ERR_DECRYPT_FAILED');

  // 7) restore from the file, verify the data is back exactly
  const restored = must(
    await apiCall(page, `api.restoreFromText(a.text, { password: a.password, options: a.options })`, { text, password: PASSWORD, options: RESTORE_OPTIONS }),
    'restoreFromText'
  );
  assert.ok(restored.results, 'restore should return per-category results');
  assert.deepEqual(await readSeededBookmarks(page), BOOKMARK_SEED, 'restored bookmarks should match the seed exactly (title + URL + order)');

  // 8) restore is idempotent: a second run merges without duplicating
  must(
    await apiCall(page, `api.restoreFromText(a.text, { password: a.password, options: a.options })`, { text, password: PASSWORD, options: RESTORE_OPTIONS }),
    'second restoreFromText'
  );
  assert.deepEqual(await readSeededBookmarks(page), BOOKMARK_SEED, 'second restore should not duplicate bookmarks');

  assert.deepEqual(pageErrors, [], `dashboard should run without page errors: ${pageErrors.join('; ')}`);
  console.log(`PASS local E2E round-trip (${SEED_FOLDER}): seed → encrypted file → destroy → wrong-password rejected → restore exact → idempotent, zero page errors`);
} finally {
  await context.close();
}
