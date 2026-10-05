import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const topOrigins = ['https://top-one.example', 'https://top-two.example'];
const partitionFramesByTab = new Map([
  [
    1,
    [
      { frameId: 0, mainFrame: true },
      {
        frameId: 2,
        origin: 'https://rejected-frame.example',
        readSiteAll: async () => {
          throw new Error('rejected partition read');
        },
      },
      {
        frameId: 3,
        origin: 'https://same-tab-frame.example',
        readSiteAll: async () => ({
          localStorage: { retained: 'same tab' },
          sessionStorage: { ignored: 'per-tab only' },
        }),
      },
    ],
  ],
  [
    2,
    [
      { frameId: 0, mainFrame: true },
      {
        frameId: 4,
        origin: 'https://other-tab-frame.example',
        readSiteAll: async () => ({
          localStorage: { retained: 'other tab' },
        }),
      },
    ],
  ],
]);
const injectedResultsByTab = new Map();
const tabs = new Map([
  [1, { id: 1, url: `${topOrigins[0]}/page`, status: 'complete' }],
  [2, { id: 2, url: `${topOrigins[1]}/page`, status: 'complete' }],
]);
const snapshotsByTab = new Map([
  [1, { localStorage: { top: 'one' } }],
  [2, { localStorage: { top: 'two' } }],
]);
const originalChrome = globalThis.chrome;
const originalFetch = globalThis.fetch;

function executeFrame(func, frame) {
  const window = {};
  window.top = frame.mainFrame ? window : {};
  return runInNewContext(`(${func.toString()})()`, {
    window,
    location: { origin: frame.origin || 'https://top.example' },
    __BBR: { readSiteAll: frame.readSiteAll || (async () => frame.snapshot) },
  });
}

test('a rejected frame read does not discard successful frames in this or other tabs', async () => {
  const chrome = {
    runtime: { lastError: undefined, getURL: (path) => path },
    tabs: {
      query: async (query = {}) => {
        const allTabs = [...tabs.values()];
        if (!query.url) return allTabs;
        const prefix = String(query.url).replace(/\*$/, '');
        return allTabs.filter((tab) => tab.url.startsWith(prefix));
      },
      get: async (id) => tabs.get(id),
    },
    history: { search: async () => [] },
    bookmarks: { getTree: async () => [] },
    cookies: { getAllCookieStores: async () => [] },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
    debugger: {
      attach: (_target, _version, callback) => callback(),
      detach: (_target, callback) => callback(),
      sendCommand: (debuggerTarget, _method, params, callback) => {
        const expression = params.expression || '';
        const tx = JSON.stringify(snapshotsByTab.get(debuggerTarget.tabId));
        if (expression.includes('__BBR.setTx')) {
          callback({ result: { type: 'number', value: tx.length } });
        } else if (expression.includes('__BBR.txChunk')) {
          callback({ result: { type: 'string', value: tx } });
        } else {
          callback({ result: { type: 'boolean', value: true } });
        }
      },
    },
    scripting: {
      executeScript: async ({ target, files, func }) => {
        if (files) return [];
        const results = await Promise.all(
          (partitionFramesByTab.get(target.tabId) || []).map(async (frame) => {
            const result = await executeFrame(func, frame);
            return {
              frameId: frame.frameId,
              result: JSON.parse(JSON.stringify(result)),
            };
          })
        );
        injectedResultsByTab.set(target.tabId, results);
        return results;
      },
    },
  };

  globalThis.chrome = chrome;
  globalThis.fetch = async () => ({ text: async () => 'fixture pagelib' });
  try {
    const { collectSiteData } =
      await import('../../src/lib/sitedata.js?partition-frame-rejection');
    const section = await collectSiteData(null, {
      checkpoint: false,
      includeOrigins: topOrigins,
      retryMaxAttempts: 1,
      scanWindowSize: 2,
    });

    assert.deepEqual(
      injectedResultsByTab.get(1)?.find(({ frameId }) => frameId === 2)?.result,
      { error: 'Error: rejected partition read' },
      'the rejected read should resolve to the injected function’s local error result'
    );
    assert.deepEqual(
      section.partitions.map(({ topSite, frameOrigin, tabId, snapshot }) => ({
        topSite,
        frameOrigin,
        tabId,
        snapshot,
      })),
      [
        {
          topSite: topOrigins[0],
          frameOrigin: 'https://same-tab-frame.example',
          tabId: 1,
          snapshot: { localStorage: { retained: 'same tab' } },
        },
        {
          topSite: topOrigins[1],
          frameOrigin: 'https://other-tab-frame.example',
          tabId: 2,
          snapshot: { localStorage: { retained: 'other tab' } },
        },
      ],
      'successful same-tab and other-tab frame snapshots should be retained'
    );
  } finally {
    if (originalChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = originalChrome;
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});
