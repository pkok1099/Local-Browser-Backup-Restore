import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  loadRouteChunk,
  retryRouteChunk,
} from '../../src/dashboard/lazy-route.ts';

function createStorage() {
  const values = new Map();
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

const failToLoad = async () => {
  throw new Error('simulated route chunk network failure');
};

describe('dashboard lazy route recovery', () => {
  it('allows one automatic reload per route failure and prevents a loop', async () => {
    const storage = createStorage();
    let reloads = 0;
    const recovery = { storage, reload: () => (reloads += 1) };

    await assert.rejects(
      loadRouteChunk('settings', failToLoad, recovery),
      /simulated route chunk network failure/
    );
    assert.equal(reloads, 1);
    assert.equal(storage.values.get('bbr:lazy-route-retry:settings'), '1');

    await assert.rejects(
      loadRouteChunk('settings', failToLoad, recovery),
      /simulated route chunk network failure/
    );
    assert.equal(reloads, 1);
  });

  it('clears the retry guard after a successful route load', async () => {
    const storage = createStorage();
    let reloads = 0;
    const recovery = { storage, reload: () => (reloads += 1) };

    await assert.rejects(
      loadRouteChunk('settings', failToLoad, recovery),
      /simulated route chunk network failure/
    );
    assert.equal(storage.values.get('bbr:lazy-route-retry:settings'), '1');

    const loadedModule = { default: 'settings page' };
    assert.strictEqual(
      await loadRouteChunk('settings', async () => loadedModule, recovery),
      loadedModule
    );
    assert.equal(storage.values.has('bbr:lazy-route-retry:settings'), false);
    assert.equal(reloads, 1);
  });

  it('keeps route guards independent and clears one before manual retry', async () => {
    const storage = createStorage();
    let reloads = 0;
    const recovery = { storage, reload: () => (reloads += 1) };

    await assert.rejects(
      loadRouteChunk('settings', failToLoad, recovery),
      /simulated route chunk network failure/
    );
    await assert.rejects(
      loadRouteChunk('results', failToLoad, recovery),
      /simulated route chunk network failure/
    );
    assert.equal(reloads, 2);
    assert.equal(storage.values.get('bbr:lazy-route-retry:settings'), '1');
    assert.equal(storage.values.get('bbr:lazy-route-retry:results'), '1');

    retryRouteChunk('results', recovery);
    assert.equal(reloads, 3);
    assert.equal(storage.values.has('bbr:lazy-route-retry:results'), false);
  });

  it('surfaces the fallback without reloading when session storage is unavailable', async () => {
    let reloads = 0;
    const unavailableStorage = {
      getItem() {
        throw new Error('storage unavailable');
      },
      setItem() {
        throw new Error('storage unavailable');
      },
      removeItem() {
        throw new Error('storage unavailable');
      },
    };

    await assert.rejects(
      loadRouteChunk('log', failToLoad, {
        storage: unavailableStorage,
        reload: () => (reloads += 1),
      }),
      /simulated route chunk network failure/
    );
    assert.equal(reloads, 0);
  });
});
