// Scan tab groups: the single "BBR Site Scan" group that collects
// every owned scan tab, plus the "BBR Site Error" group that collects
// owned scan tabs whose scan-group placement failed — no owned scan
// tab is ever left floating ungrouped. One manager instance per
// group per crawl; concurrent openers share a single creation promise
// so no duplicate groups form.

const SCAN_GROUP_TITLE = 'BBR Site Scan';
const SCAN_GROUP_COLOR = 'grey';
// Error group: owned scan tabs that could not be placed into the scan group
// (grouping API failure) are collected here instead of being left floating
// ungrouped — every scan tab ends up in a group. Never used for pre-existing
// user tabs (those are never grouped, moved or closed).
export const SCAN_ERROR_GROUP_TITLE = 'BBR Site Error';
export const SCAN_ERROR_GROUP_COLOR = 'red';

export function createGroupManager({
  title = SCAN_GROUP_TITLE,
  color = SCAN_GROUP_COLOR,
} = {}) {
  let groupId = null;
  let creating = null;
  const clearCreating = () => {
    creating = null;
  };
  async function createWith(tabId) {
    const id = await chrome.tabs.group({ tabIds: tabId });
    try {
      await chrome.tabGroups.update(id, { title, color, collapsed: false });
    } catch (e) {
      /* cosmetic — ignore */
    }
    return id;
  }
  async function ensureGroup(tabId) {
    if (groupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: tabId, groupId });
        return groupId;
      } catch (e) {
        // Distinguish "group is gone" (recreate) from "tab is bad" (fail).
        let valid = false;
        try {
          await chrome.tabGroups.get(groupId);
          valid = true;
        } catch (err) {
          /* gone */
        }
        if (!valid) groupId = null;
        else throw e;
      }
    }
    if (!creating) {
      creating = createWith(tabId);
      creating.then((id) => {
        groupId = id;
        clearCreating();
      }, clearCreating);
    }
    const id = await creating;
    // Another tab may have won the bootstrap race — make sure this one is in.
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.groupId !== id)
        await chrome.tabs.group({ tabIds: tabId, groupId: id });
    } catch (e) {
      /* tab vanished; the closer handles it */
    }
    return id;
  }
  return {
    ensureGroup,
    get id() {
      return groupId;
    },
  };
}
