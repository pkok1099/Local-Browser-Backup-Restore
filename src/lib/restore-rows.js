// Granular restore rows (UI side): content-driven row detection for the
// restore summary, per-sub-row counts, counts fallbacks, and the
// section-level options synthesis passed to restoreAll.
//
// The granular ids are defined by the backup pipeline (CATEGORY_GROUP_MEMBERS
// in collect.js — imported here, never duplicated): the restore summary shows
// one row per id whose content is present in the backup file.
import { CATEGORY_GROUP_MEMBERS } from './collect.js';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value) {
  return isRecord(value) ? value : {};
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function isNonEmptyRecord(value) {
  return isRecord(value) && Object.keys(value).length > 0;
}

// Granular row id -> its backup section (section ids and unknown ids pass
// through unchanged).
export function sectionForRow(cat) {
  for (const [section, members] of Object.entries(CATEGORY_GROUP_MEMBERS)) {
    if (members.includes(cat)) return section;
  }
  return cat;
}

// Capability lookup key for a row id: detect() reports tabGroups separately
// from tabsWindows, everything else uses its section's capability.
export function capabilityKeyForRow(cat) {
  if (cat === 'tabGroups') return 'tabGroups';
  return sectionForRow(cat);
}

function hasPartitionKey(cookie) {
  const pk = asRecord(cookie).partitionKey;
  return pk !== undefined && pk !== null;
}

function hasTab(item) {
  const tab = asRecord(item).tab;
  return tab !== undefined && tab !== null;
}

function hasWindow(item) {
  const window = asRecord(item).window;
  return window !== undefined && window !== null;
}

function allSessionItems(section) {
  const items = Array.isArray(section.recentlyClosed)
    ? [...section.recentlyClosed]
    : [];
  const devices = Array.isArray(section.devices) ? section.devices : [];
  for (const device of devices) {
    const sessions = asRecord(device).sessions;
    if (Array.isArray(sessions)) items.push(...sessions);
  }
  return items;
}

// Per-origin storage keys as written by pagelib readSiteAll:
// localStorage (record), indexedDB (array), cacheStorage (array),
// opfs ({files, dirs}), buckets ({buckets: []}).
function siteStorageNonEmpty(origin, key) {
  const value = origin[key];
  switch (key) {
    case 'localStorage':
      return isNonEmptyRecord(value);
    case 'indexedDB':
    case 'cacheStorage':
      return isNonEmptyArray(value);
    case 'opfs': {
      const opfs = asRecord(value);
      return isNonEmptyArray(opfs.files) || isNonEmptyArray(opfs.dirs);
    }
    case 'buckets':
      return isNonEmptyArray(asRecord(value).buckets);
    default:
      return false;
  }
}

function siteDataRowIds(section) {
  const origins = Object.values(asRecord(section.origins));
  const nonEmpty = (key) =>
    origins.some((origin) => siteStorageNonEmpty(asRecord(origin), key));
  const rows = [];
  if (nonEmpty('localStorage')) rows.push('siteData_localStorage');
  if (nonEmpty('indexedDB')) rows.push('siteData_indexedDB');
  if (['cacheStorage', 'opfs', 'buckets'].some(nonEmpty))
    rows.push('siteData_otherStorage');
  return rows;
}

// Granular row ids for a split section, from the section's content in the
// backup file. Non-split sections return [].
export function granularRowIds(section, data) {
  const sectionData = asRecord(asRecord(data)[section]);
  switch (section) {
    case 'tabsWindows': {
      const rows = [];
      const windows = sectionData.windows;
      const hasNestedTabs =
        Array.isArray(windows) &&
        windows.some((w) => isNonEmptyArray(asRecord(w).tabs));
      if (hasNestedTabs || isNonEmptyArray(sectionData.tabs)) rows.push('tabs');
      if (isNonEmptyArray(windows)) rows.push('windows');
      // Existing behavior: the tabGroups row shows whenever the array exists
      // (even empty) — an explicit group list is intentional.
      if (Array.isArray(sectionData.tabGroups)) rows.push('tabGroups');
      return rows;
    }
    case 'cookies': {
      const cookies = Array.isArray(sectionData.cookies)
        ? sectionData.cookies
        : [];
      const rows = [];
      if (cookies.some((c) => !hasPartitionKey(c))) rows.push('cookies_plain');
      if (cookies.some((c) => hasPartitionKey(c)))
        rows.push('cookies_partitioned');
      return rows;
    }
    case 'sessions': {
      const items = allSessionItems(sectionData);
      const rows = [];
      if (items.some(hasTab)) rows.push('sessions_tabs');
      if (items.some(hasWindow)) rows.push('sessions_windows');
      return rows;
    }
    case 'siteData':
      return siteDataRowIds(sectionData);
    default:
      return [];
  }
}

const ALL_MEMBER_IDS = new Set(Object.values(CATEGORY_GROUP_MEMBERS).flat());

// Restore-summary rows as [id, label] pairs: split sections expand into their
// granular rows (at the section's position in label order); other sections
// keep one row; unknown sections are appended last. Fully data-driven — no
// hardcoded row list.
export function presentRestoreRows(data, labels) {
  const rec = asRecord(data);
  const rows = [];
  for (const [cat, label] of Object.entries(labels)) {
    if (ALL_MEMBER_IDS.has(cat)) continue; // emitted via its section
    if (Object.hasOwn(CATEGORY_GROUP_MEMBERS, cat)) {
      for (const id of granularRowIds(cat, rec))
        rows.push([id, labels[id] ?? id]);
      continue;
    }
    if (Object.hasOwn(rec, cat)) rows.push([cat, label]);
  }
  for (const cat of Object.keys(rec))
    if (!Object.hasOwn(labels, cat)) rows.push([cat, cat]);
  return rows;
}

function countTabsIn(data) {
  const section = asRecord(asRecord(data).tabsWindows);
  const nested = Array.isArray(section.windows)
    ? section.windows.reduce((n, w) => {
        const tabs = asRecord(w).tabs;
        return n + (Array.isArray(tabs) ? tabs.length : 0);
      }, 0)
    : 0;
  const flat = Array.isArray(section.tabs) ? section.tabs.length : 0;
  return nested + flat;
}

function countCookies(data, partitioned) {
  const section = asRecord(asRecord(data).cookies);
  const cookies = Array.isArray(section.cookies) ? section.cookies : [];
  return cookies.filter((c) =>
    partitioned ? hasPartitionKey(c) : !hasPartitionKey(c)
  ).length;
}

function countSessions(data, kind) {
  const section = asRecord(asRecord(data).sessions);
  const items = allSessionItems(section);
  return items.filter((item) =>
    kind === 'tabs' ? hasTab(item) : hasWindow(item)
  ).length;
}

function countSiteDataOrigins(data, keys) {
  const origins = Object.values(asRecord(asRecord(data).siteData).origins);
  return origins.filter((origin) =>
    keys.some((key) => siteStorageNonEmpty(asRecord(origin), key))
  ).length;
}

// Item counts for one restore row, straight from the backup file.
function countTabsWindowsRows(data, cat) {
  const section = asRecord(asRecord(data).tabsWindows);
  switch (cat) {
    case 'tabsWindows':
      // Legacy section behavior: undefined without a windows array.
      return Array.isArray(section.windows)
        ? String(countTabsIn(data))
        : undefined;
    case 'tabs':
      return String(countTabsIn(data));
    case 'windows':
      return Array.isArray(section.windows)
        ? String(section.windows.length)
        : undefined;
    case 'tabGroups':
      return Array.isArray(section.tabGroups)
        ? String(section.tabGroups.length)
        : undefined;
    default:
      return undefined;
  }
}

function countSessionsRows(data, cat) {
  const section = asRecord(asRecord(data).sessions);
  switch (cat) {
    case 'sessions':
      return Array.isArray(section.recentlyClosed)
        ? String(section.recentlyClosed.length)
        : undefined;
    case 'sessions_tabs':
      return String(countSessions(data, 'tabs'));
    case 'sessions_windows':
      return String(countSessions(data, 'windows'));
    default:
      return undefined;
  }
}

function countCookiesRows(data, cat) {
  const section = asRecord(asRecord(data).cookies);
  switch (cat) {
    case 'cookies':
      return Array.isArray(section.cookies)
        ? String(section.cookies.length)
        : undefined;
    case 'cookies_plain':
      return String(countCookies(data, false));
    case 'cookies_partitioned':
      return String(countCookies(data, true));
    default:
      return undefined;
  }
}

function countSiteDataRows(data, cat) {
  const section = asRecord(asRecord(data).siteData);
  switch (cat) {
    case 'siteData':
      return Object.hasOwn(section, 'origins')
        ? `${Object.keys(asRecord(section.origins)).length} origins`
        : undefined;
    case 'siteData_localStorage':
      return `${countSiteDataOrigins(data, ['localStorage'])} origins`;
    case 'siteData_indexedDB':
      return `${countSiteDataOrigins(data, ['indexedDB'])} origins`;
    case 'siteData_otherStorage':
      return `${countSiteDataOrigins(data, ['cacheStorage', 'opfs', 'buckets'])} origins`;
    default:
      return undefined;
  }
}

// Dispatch granular row ids to their section's counter; section ids (and
// unknown ids) fall through to the legacy per-category switch.
function countSectionRow(data, section, cat) {
  switch (section) {
    case 'tabsWindows':
      return countTabsWindowsRows(data, cat);
    case 'sessions':
      return countSessionsRows(data, cat);
    case 'cookies':
      return countCookiesRows(data, cat);
    case 'siteData':
      return countSiteDataRows(data, cat);
    default:
      return undefined;
  }
}

export function countFromData(backup, cat) {
  const data = asRecord(backup.data);
  const section = asRecord(data[cat]);
  const length = (value) =>
    Array.isArray(value) ? String(value.length) : undefined;
  const rowSection = sectionForRow(cat);
  if (rowSection !== cat) return countSectionRow(data, rowSection, cat);
  switch (cat) {
    case 'bookmarks': {
      if (!isRecord(section.roots)) return undefined;
      const roots = asRecord(section.roots);
      let count = 0;
      const walk = (nodes) => {
        if (!Array.isArray(nodes)) return;
        for (const value of nodes) {
          const node = asRecord(value);
          if (node.type === 'folder') walk(node.children);
          else count++;
        }
      };
      for (const root of Object.values(roots)) walk(asRecord(root).children);
      return String(count);
    }
    case 'history':
      return length(section.items);
    case 'tabsWindows':
      return countTabsWindowsRows(data, cat);
    case 'sessions':
      return countSessionsRows(data, cat);
    case 'cookies':
      return countCookiesRows(data, cat);
    case 'downloads':
    case 'installedExtensions':
      return length(section.items);
    case 'readingList':
      return length(section.entries);
    case 'extensionPermissions':
      return Array.isArray(section.permissions) &&
        Array.isArray(section.origins)
        ? String(section.permissions.length + section.origins.length)
        : undefined;
    case 'extensionStorage':
      return isRecord(data.extensionStorage)
        ? String(Object.keys(asRecord(section.local)).length)
        : undefined;
    case 'profile':
      return isRecord(data.profile) ? '1' : undefined;
    case 'siteData':
      return countSiteDataRows(data, cat);
    default:
      return Array.isArray(data[cat])
        ? String(data[cat].length)
        : length(section.items);
  }
}

// Fallback counts from backup.counts when the file content can't be counted
// directly. Granular ids fall back to their section's count — never invent
// numbers: missing section count -> undefined.
export function countFor(backup, cat) {
  const c = backup.counts || {};
  const countText = (value) =>
    typeof value === 'number' || typeof value === 'string'
      ? String(value)
      : undefined;
  const siteDataOrigins = (value) =>
    value !== undefined ? `${value} origins` : undefined;
  switch (cat) {
    case 'tabGroups':
      return countText(c.tabGroups);
    case 'tabs':
      return countText(c.tabs);
    case 'windows':
      return countText(c.windows);
    case 'bookmarks':
      return countText(c.bookmarks);
    case 'history':
      return countText(c.history);
    case 'tabsWindows':
      return countText(c.tabs);
    case 'sessions':
      return countText(c.recentlyClosedSessions);
    case 'sessions_tabs':
    case 'sessions_windows':
      return countText(c.recentlyClosedSessions);
    case 'cookies':
      return countText(c.cookies);
    case 'cookies_plain':
    case 'cookies_partitioned':
      return countText(c.cookies);
    case 'downloads':
      return countText(c.downloads);
    case 'readingList':
      return countText(c.readingList);
    case 'installedExtensions':
      return countText(c.installedExtensions);
    case 'siteData':
      return siteDataOrigins(c.siteDataOrigins);
    case 'siteData_localStorage':
    case 'siteData_indexedDB':
    case 'siteData_otherStorage':
      return siteDataOrigins(c.siteDataOrigins);
    default:
      return countText(c[cat]);
  }
}

// Section-level options synthesis for split sections, added after the
// per-row option loop: enabled when any member row is on, unavailable only
// when every member is unavailable. The restore engine reads `granular` to
// pre-filter per member.
export function synthesizeSectionOptions(options) {
  for (const [section, members] of Object.entries(CATEGORY_GROUP_MEMBERS)) {
    const granular = {};
    for (const member of members)
      granular[member] = options[member]?.enabled === true;
    const states = members.map((member) => options[member]);
    options[section] = {
      enabled: states.some((state) => state?.enabled === true),
      unavailable:
        members.length > 0 &&
        states.every(
          (state) => state !== undefined && state.unavailable === true
        ),
      granular,
    };
  }
}

export { CATEGORY_GROUP_MEMBERS };
