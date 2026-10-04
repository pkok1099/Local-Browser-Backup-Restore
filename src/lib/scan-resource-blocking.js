// Lightweight scan mode: block all subresources in scan tabs via
// declarativeNetRequest session rules.
//
// Why: a site-data scan only needs the committed first-party document as a
// context for reading already-persisted storage (localStorage, IndexedDB,
// ...). The site's own scripts, images, fonts, XHRs and trackers must not
// run — that is what made backups lag the device. With subresources blocked
// each origin load is a near-free document shell.
//
// Critical ordering: updateSessionRules is async. The rule MUST be awaited
// BEFORE the tab navigates — a navigation that starts first lets
// subresources slip through, silently and flakily losing the whole effect.
//
// Notes:
// - Rules are session-scoped (gone on browser restart) and tab-scoped via
//   condition.tabIds. Rule IDs come from our own counter in a dedicated
//   range so startup cleanup can recognize them.
// - sub_frame documents are allowed (their own subresources are still
//   blocked by the same tab-scoped rule) so partitioned third-party storage
//   stays readable. Everything else except main_frame is blocked.
// - Requests made by a service worker are not associated with any tabId, so
//   they bypass these rules. That does not affect storage reads, but a site
//   with a busy service worker can still cost some CPU.
// - Chrome 92+ supports tabIds in DNR conditions. If the API is absent the
//   scan degrades gracefully to unblocked loads (with a warning at the call
//   site, not here).

export const SCAN_BLOCK_RULE_ID_BASE = 1000000;

// Every resource type except the document itself. sub_frame documents stay
// allowed (see above); their scripts/images/... are blocked by the same rule
// because those requests carry the tab's ID too.
//
// 'other' is deliberately NOT blocked: service-worker lifecycle requests
// (script update checks, fetch dispatch) are classified as 'other', and
// blocking them hangs navigations on SW-controlled pages. Allowing 'other'
// costs almost nothing (the heavy types stay blocked).
const BLOCKED_RESOURCE_TYPES = [
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
];

export function buildScanBlockRule(ruleId, tabId) {
  return {
    id: ruleId,
    priority: 1,
    action: { type: 'block' },
    condition: {
      tabIds: [tabId],
      resourceTypes: [...BLOCKED_RESOURCE_TYPES],
    },
  };
}

export function isScanBlockRuleId(ruleId) {
  return Number.isInteger(ruleId) && ruleId >= SCAN_BLOCK_RULE_ID_BASE;
}

let nextRuleId = SCAN_BLOCK_RULE_ID_BASE;

// Test-only: reset the counter so rule IDs are deterministic.
export function resetScanBlockRuleIds() {
  nextRuleId = SCAN_BLOCK_RULE_ID_BASE;
}

const dnr = () => globalThis.chrome?.declarativeNetRequest;

// Apply blocking to a tab. Returns the rule ID, or null when DNR is
// unavailable (caller then skips the matching clear). MUST be awaited
// before navigating the tab.
export async function applyScanBlocking(tabId) {
  const api = dnr();
  if (!api || typeof api.updateSessionRules !== 'function') return null;
  const ruleId = nextRuleId++;
  await api.updateSessionRules({
    addRules: [buildScanBlockRule(ruleId, tabId)],
  });
  return ruleId;
}

export async function clearScanBlocking(ruleId) {
  const api = dnr();
  if (!api || typeof api.updateSessionRules !== 'function') return;
  if (ruleId === null || ruleId === undefined) return;
  await api.updateSessionRules({ removeRuleIds: [ruleId] });
}

// Startup safety: drop leftover scan rules (e.g. the worker died before
// finishScanTab ran). Only touches our own ID range; returns how many were
// removed.
export async function clearAllScanBlocking() {
  const api = dnr();
  if (!api || typeof api.getSessionRules !== 'function') return 0;
  const rules = await api.getSessionRules();
  const ids = rules.filter((r) => isScanBlockRuleId(r.id)).map((r) => r.id);
  if (ids.length > 0) await api.updateSessionRules({ removeRuleIds: ids });
  return ids.length;
}
