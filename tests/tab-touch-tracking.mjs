// Test: createTabOwnership tracks user activation of owned tabs via
// chrome.tabs.onActivated and hands the touched set to the verifier as the
// 3rd argument. The verifier (verifyScanTab) decides what to do with it;
// this file only tests the plumbing: listener registration, owned-only
// tracking, delivery to verify, cleanup on close, and dispose.
import assert from 'node:assert/strict';
import { createTabOwnership, verifyScanTab } from '../src/lib/sitedata.js';

const activatedListeners = [];
const removedListeners = [];
const removedTabs = [];
globalThis.chrome = {
  tabs: {
    get: async (tabId) => ({
      id: tabId,
      url: 'https://cdn-errors.net/404.html',
      pendingUrl: '',
      active: false,
    }),
    remove: async (tabId) => {
      removedTabs.push(tabId);
    },
    onActivated: {
      addListener: (fn) => activatedListeners.push(fn),
      removeListener: (fn) => {
        const i = activatedListeners.indexOf(fn);
        if (i >= 0) activatedListeners.splice(i, 1);
      },
    },
    onRemoved: {
      addListener: (fn) => removedListeners.push(fn),
      removeListener: (fn) => {
        const i = removedListeners.indexOf(fn);
        if (i >= 0) removedListeners.splice(i, 1);
      },
    },
  },
  history: { deleteUrl: async () => {} },
};

const seenTouched = [];
const ownership = createTabOwnership(
  [],
  async (tabId, origin, userTouchedTabIds) => {
    // Snapshot: safeCloseTab drops the touched entry in its finally block.
    seenTouched.push(new Set(userTouchedTabIds));
    return 'failed';
  },
  null,
  () => {}
);
assert.equal(
  activatedListeners.length,
  1,
  'onActivated listener must be registered'
);

ownership.own(7);
// The user activates the owned tab, then switches away.
activatedListeners[0]({ tabId: 7, windowId: 1 });
// Activation of a tab we do NOT own must be ignored.
activatedListeners[0]({ tabId: 999, windowId: 1 });

const st7 = await ownership.safeCloseTab(7, 'https://example.com');
assert.equal(st7, 'closed', 'fake verifier says failed -> closed');
assert.ok(
  seenTouched[0] instanceof Set && seenTouched[0].has(7),
  'verifier must receive the touched set containing tab 7'
);
assert.ok(
  !seenTouched[0].has(999),
  'activations of unowned tabs must be ignored'
);

// Re-owning a closed tab starts clean: the touched entry was dropped.
ownership.own(7);
const st7b = await ownership.safeCloseTab(7, 'https://example.com');
assert.equal(st7b, 'closed');
assert.ok(!seenTouched[1].has(7), 'touched entry must be dropped on close');

ownership.dispose();
assert.equal(
  activatedListeners.length,
  0,
  'onActivated listener must be removed on dispose'
);
assert.equal(
  removedListeners.length,
  0,
  'onRemoved listener must be removed on dispose'
);

// I1: a tab that was ALREADY active when we took ownership (the platform
// ignored active:false, or something activated it before own() ran) must
// count as touched — the onActivated listener can never have seen it.
const ownershipI1 = createTabOwnership(
  [],
  async (tabId, origin, userTouchedTabIds) => {
    seenTouched.push(new Set(userTouchedTabIds));
    return 'failed';
  },
  null,
  () => {}
);
ownershipI1.own(11, true);
await ownershipI1.safeCloseTab(11, 'https://example.com');
assert.ok(
  seenTouched[seenTouched.length - 1].has(11),
  'own(tabId, wasActive=true) must mark the tab touched'
);
ownershipI1.dispose();

// I2: the user closes a scan tab externally mid-crawl — the stale ID must
// drop immediately, so a later safeCloseTab refuses instead of verifying a
// tab that may no longer be ours.
const ownershipI2 = createTabOwnership(
  [],
  async () => 'failed',
  null,
  () => {}
);
ownershipI2.own(12);
removedListeners[removedListeners.length - 1](12);
const st12 = await ownershipI2.safeCloseTab(12, 'https://example.com');
assert.equal(
  st12,
  'refused',
  'externally-removed tab must be refused, never verified'
);
assert.ok(!removedTabs.includes(12), 'externally-removed tab must not be re-removed');
ownershipI2.dispose();

// M5 composition: the REAL verifier honors the tracked touch end to end —
// no fake verifier in between.
const ownershipReal = createTabOwnership([], verifyScanTab, null, () => {});
ownershipReal.own(31);
activatedListeners[activatedListeners.length - 1]({ tabId: 31, windowId: 1 });
const st31 = await ownershipReal.safeCloseTab(31, 'https://example.com');
assert.equal(
  st31,
  'kept',
  'touched tab through the real verifier must be kept (cross-origin page)'
);
ownershipReal.own(32);
const st32 = await ownershipReal.safeCloseTab(32, 'https://example.com');
assert.equal(
  st32,
  'closed',
  'untouched tab through the real verifier must be closed (cross-origin page)'
);
assert.ok(removedTabs.includes(32), 'untouched tab must actually be removed');
ownershipReal.dispose();

console.log(
  'PASS tab touch tracking: onActivated -> touched set -> verifier 3rd arg, dispose cleans up'
);
