import assert from 'node:assert/strict';
import { loadRouteChunk, retryRouteChunk } from '../../src/dashboard/lazy-route.ts';

function createStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

const storage = createStorage();
let reloads = 0;
const recovery = { storage, reload: () => { reloads += 1; } };
const failToLoad = async () => { throw new Error('simulated route chunk network failure'); };

await assert.rejects(loadRouteChunk('settings', failToLoad, recovery), /simulated route chunk network failure/);
assert.equal(reloads, 1, 'the first failed route import triggers one dashboard reload');
assert.equal(storage.values.get('bbr:lazy-route-retry:settings'), '1');

await assert.rejects(loadRouteChunk('settings', failToLoad, recovery), /simulated route chunk network failure/);
assert.equal(reloads, 1, 'a repeated failure must not cause an automatic reload loop');

const loadedModule = { default: 'settings page' };
assert.equal(await loadRouteChunk('settings', async () => loadedModule, recovery), loadedModule);
assert.equal(storage.values.has('bbr:lazy-route-retry:settings'), false, 'a successful load clears the retry guard');

await assert.rejects(loadRouteChunk('results', failToLoad, recovery), /simulated route chunk network failure/);
assert.equal(reloads, 2, 'a different route gets an independent one-shot retry');
retryRouteChunk('results', recovery);
assert.equal(reloads, 3, 'the fallback retry action reloads the dashboard');
assert.equal(storage.values.has('bbr:lazy-route-retry:results'), false, 'manual retry clears its guard first');

const unavailableStorage = {
  getItem() { throw new Error('storage unavailable'); },
  setItem() { throw new Error('storage unavailable'); },
  removeItem() { throw new Error('storage unavailable'); }
};
await assert.rejects(
  loadRouteChunk('log', failToLoad, { storage: unavailableStorage, reload: () => { reloads += 1; } }),
  /simulated route chunk network failure/
);
assert.equal(reloads, 3, 'unavailable storage must surface the fallback instead of risking reload loops');

console.log('PASS lazy route chunk retry guard and manual recovery');
