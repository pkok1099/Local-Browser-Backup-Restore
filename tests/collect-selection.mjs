import assert from 'node:assert/strict';
import { collectAll } from '../src/lib/collect.js';

globalThis.chrome = {
  runtime: {
    async getPlatformInfo() { return { os: 'android', arch: 'arm64' }; },
    getManifest() { return { version: '1.4.2' }; }
  }
};

const selected = await collectAll(null, { selectedCategories: ['profile'] });
assert.deepEqual(Object.keys(selected.data), ['profile'], 'only selected categories should be collected');
for (const [name, status] of Object.entries(selected.categoryStatus)) {
  if (name !== 'profile') assert.equal(status.skipped, true, `${name} should be marked skipped`);
}
assert.equal(selected.categoryStatus.profile.ok, true);
console.log('PASS backup selection collects only the chosen categories');
