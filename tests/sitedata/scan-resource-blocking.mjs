// Unit tests for scan-resource-blocking: DNR session rules that make each
// scan tab a near-free document shell (all subresources blocked).
//
// The critical ordering: updateSessionRules MUST be awaited BEFORE the tab
// navigates, otherwise subresources slip through before the rule lands.
import assert from 'node:assert/strict';
import {
  SCAN_BLOCK_RULE_ID_BASE,
  buildScanBlockRule,
  isScanBlockRuleId,
  applyScanBlocking,
  clearScanBlocking,
  clearAllScanBlocking,
  resetScanBlockRuleIds,
} from '../../src/lib/scan-resource-blocking.js';

let n = 0;
const check = (actual, expected, label) => {
  n++;
  assert.equal(actual, expected, label);
};

// --- rule shape (pure) ---
const rule = buildScanBlockRule(1000001, 42);
check(rule.id, 1000001, 'rule id passes through');
check(rule.action.type, 'block', 'action is block');
check(
  JSON.stringify(rule.condition.tabIds),
  JSON.stringify([42]),
  'rule scoped to the tab via tabIds'
);
check(rule.condition.resourceTypes.includes('script'), true, 'scripts blocked');
check(rule.condition.resourceTypes.includes('image'), true, 'images blocked');
check(rule.condition.resourceTypes.includes('media'), true, 'media blocked');
check(rule.condition.resourceTypes.includes('font'), true, 'fonts blocked');
check(
  rule.condition.resourceTypes.includes('xmlhttprequest'),
  true,
  'xhr blocked'
);
check(
  rule.condition.resourceTypes.includes('sub_frame'),
  false,
  'sub_frame documents allowed (their subresources are still blocked by the same tab-scoped rule; partitioned storage stays readable)'
);
check(
  rule.condition.resourceTypes.includes('main_frame'),
  false,
  'main_frame never blocked'
);
check(
  rule.condition.resourceTypes.includes('other'),
  false,
  "'other' not blocked: SW lifecycle requests are classified as 'other' " +
    'and blocking them hangs navigations on SW-controlled pages'
);

check(isScanBlockRuleId(1000000), true, 'base id is a scan rule');
check(isScanBlockRuleId(1000042), true, 'counter id is a scan rule');
check(isScanBlockRuleId(999999), false, 'below base is not a scan rule');
check(isScanBlockRuleId(7), false, 'small id is not a scan rule');

// --- apply/clear with mocked chrome ---
const calls = [];
globalThis.chrome = {
  declarativeNetRequest: {
    updateSessionRules: async (opts) => {
      calls.push(opts);
    },
    getSessionRules: async () => [
      { id: 1000001 },
      { id: 1000002 },
      { id: 5 }, // someone else's rule: must survive
    ],
  },
};

resetScanBlockRuleIds();
const id1 = await applyScanBlocking(42);
check(id1, SCAN_BLOCK_RULE_ID_BASE, 'first rule id is the base');
check(calls.length, 1, 'updateSessionRules called once');
check(calls[0].addRules[0].condition.tabIds[0], 42, 'rule targets the tab');
const id2 = await applyScanBlocking(43);
check(id2, SCAN_BLOCK_RULE_ID_BASE + 1, 'rule ids increment');
check(id1 !== id2, true, 'rule ids unique');

await clearScanBlocking(id1);
check(
  JSON.stringify(calls[calls.length - 1].removeRuleIds),
  JSON.stringify([id1]),
  'clear removes the rule'
);
await clearScanBlocking(null); // no-op, must not throw
check(true, true, 'clear(null) is a no-op');

const cleared = await clearAllScanBlocking();
check(cleared, 2, 'startup cleanup removes only scan-range rules');
check(
  JSON.stringify(calls[calls.length - 1].removeRuleIds.sort()),
  JSON.stringify([1000001, 1000002]),
  'foreign rule id 5 survives'
);

// --- graceful degradation: no DNR (very old browser) ---
globalThis.chrome = {};
resetScanBlockRuleIds();
const id3 = await applyScanBlocking(44);
check(id3, null, 'no DNR -> null rule id, no throw');
await clearScanBlocking(999); // no-op, must not throw
const cleared2 = await clearAllScanBlocking();
check(cleared2, 0, 'no DNR -> cleanup is a no-op');

console.log(`PASS scan-resource-blocking (${n} assertions)`);
