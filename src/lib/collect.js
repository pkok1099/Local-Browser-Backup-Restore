// Data collectors: read every supported category via public extension APIs and
// serialize it into the documented backup format (docs/BACKUP_FORMAT.md).
// Rules:
//  - Only categories that were actually and successfully read end up in the backup.
//  - Cookie values are never logged (only counted).
//  - Incognito data is excluded by design.

import { yieldToUI, TypedError } from './util.js';
import { detect, getChromeVersion } from './capabilities.js';
import { collectSiteData, computeSiteDataCounts } from './sitedata.js';

// ---------- bookmarks ----------

function serBookmarkNode(n) {
  const o = {
    id: n.id,
    type: n.url ? 'url' : 'folder',
    title: n.title,
    index: typeof n.index === 'number' ? n.index : undefined,
  };
  if (n.url) o.url = n.url;
  if (typeof n.dateAdded === 'number') o.dateAdded = n.dateAdded;
  if (Array.isArray(n.children)) o.children = n.children.map(serBookmarkNode);
  return o;
}

async function collectBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  const root = tree[0];
  // Root IDs are NOT stable across Chrome versions (Chrome 131: '1'/'2';
  // Chrome 153: dynamic ids like 57/58/59). Identify the well-known roots by
  // POSITION under the top root: [bookmark bar, other, mobile].
  const kids = root.children || [];
  const barId = (kids.find((k) => k.id === '1') || kids[0] || {}).id;
  const otherId = (kids.find((k) => k.id === '2') || kids[1] || {}).id;
  const roots = {};
  for (const r of kids) {
    const key = r.id === barId ? 'bookmark_bar' : r.id === otherId ? 'other' : 'mobile';
    roots[key] = { id: r.id, title: r.title, children: (r.children || []).map(serBookmarkNode) };
  }
  return { roots };
}

// ---------- history ----------

async function collectHistory(progress) {
  const items = await chrome.history.search({ text: '', startTime: 0, maxResults: 10000000 });
  const visits = {};
  let failedVisits = 0;
  let i = 0;
  for (const item of items) {
    if (!item.url) {
      i++;
      continue;
    }
    try {
      const v = await chrome.history.getVisits({ url: item.url });
      visits[item.url] = v.map((x) => ({
        visitTime: x.visitTime,
        transition: x.transition,
        visitId: x.visitId,
        referringVisitId: x.referringVisitId,
        ...(x.openerVisitId !== undefined ? { openerVisitId: x.openerVisitId } : {}),
      }));
    } catch (e) {
      failedVisits++;
    }
    i++;
    if (i % 50 === 0) {
      if (progress) progress(`history: ${i}/${items.length} items`);
      await yieldToUI();
    }
  }
  return {
    items: items
      .filter((h) => h.url)
      .map((h) => ({
        url: h.url,
        title: h.title || '',
        visitCount: h.visitCount,
        typedCount: h.typedCount,
        lastVisitTime: h.lastVisitTime,
      })),
    visits,
    ...(failedVisits > 0 ? { visitLookupFailures: failedVisits } : {}),
  };
}

// ---------- tabs, windows, tab groups ----------

function serTab(t) {
  const o = {
    url: t.url || '',
    title: t.title || '',
    pinned: !!t.pinned,
    index: t.index,
    muted: !!(t.mutedInfo && t.mutedInfo.muted),
  };
  if (t.groupId !== undefined && t.groupId !== -1) o.groupId = t.groupId;
  return o;
}

async function collectTabsWindows() {
  const notes = [];
  const isExtensionUiTab = (t) => /^(chrome-extension:|devtools:|chrome-untrusted:)/.test(t.url || '');
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal', 'popup'] });
  const windows = [];
  let excludedTabs = 0;
  for (const w of wins) {
    const tabs = (w.tabs || []).slice().sort((a, b) => a.index - b.index);
    const visibleTabs = tabs.filter((t) => !t.incognito && !isExtensionUiTab(t));
    excludedTabs += tabs.length - visibleTabs.length;
    if (tabs.length !== visibleTabs.length && visibleTabs.length === 0) {
      notes.push('Window containing only extension-UI/incognito tabs excluded (not user data).');
      continue;
    }
    if (tabs.length !== visibleTabs.length) {
      notes.push(`${tabs.length - visibleTabs.length} extension-UI/incognito tab(s) excluded (not user data).`);
    }
    windows.push({
      type: w.type,
      state: w.state,
      focused: !!w.focused,
      alwaysOnTop: !!w.alwaysOnTop,
      bounds: { left: w.left, top: w.top, width: w.width, height: w.height },
      tabs: visibleTabs.map(serTab),
    });
  }
  if (excludedTabs > 0) {
    notes.push(
      `${excludedTabs} extension-UI tab(s) (chrome-extension://, devtools://) and any incognito tabs excluded — these are UI surfaces, not user data.`
    );
  }

  let tabGroups = [];
  if (chrome.tabGroups) {
    const groups = await chrome.tabGroups.query({});
    tabGroups = groups.map((g) => ({
      groupId: g.id,
      title: g.title,
      color: g.color,
      collapsed: g.collapsed,
      windowId: g.windowId,
    }));
  }
  const out = { windows, tabGroups };
  if (notes.length) out.notes = notes;
  return out;
}

// ---------- sessions (recently closed + synced devices) ----------

function serSessionItem(item) {
  const o = {};
  if (typeof item.lastModified === 'number') o.lastModified = item.lastModified;
  if (item.tab) {
    o.tab = { url: item.tab.url || '', title: item.tab.title || '', index: item.tab.index };
    if (item.tab.pinned) o.tab.pinned = true;
  }
  if (item.window) {
    o.window = {
      bounds: { left: item.window.left, top: item.window.top, width: item.window.width, height: item.window.height },
      state: item.window.state,
      tabs: (item.window.tabs || [])
        .filter((t) => !t.incognito)
        .sort((a, b) => a.index - b.index)
        .map((t) => ({ url: t.url || '', title: t.title || '', index: t.index, pinned: !!t.pinned })),
    };
  }
  return o;
}

async function collectSessions() {
  const max = chrome.sessions.MAX_SESSION_RESULTS || 25;
  const recent = await chrome.sessions.getRecentlyClosed({ maxResults: max });
  // Exclude the site-data scanner's own tab closures — they are tool noise,
  // not user data (the scanner deletes their history entries; session-service
  // entries are filtered here).
  const isScanNoise = (item) => {
    const urls = [];
    if (item.tab && item.tab.url) urls.push(item.tab.url);
    if (item.window) for (const t of item.window.tabs || []) urls.push(t.url);
    return urls.some((u) => u.includes('/__bbr_site_scan__'));
  };
  const out = {
    maxSessionResults: max,
    recentlyClosed: (recent || []).filter((it) => !isScanNoise(it)).map(serSessionItem),
  };
  if (typeof chrome.sessions.getDevices === 'function') {
    try {
      const devices = await chrome.sessions.getDevices();
      out.devices = (devices || []).map((d) => ({
        deviceName: d.deviceName,
        sessions: (d.sessions || []).map(serSessionItem),
      }));
    } catch (e) {
      out.devicesNote = 'getDevices() failed: ' + (e.message || 'unknown');
    }
  }
  return out;
}

// ---------- cookies ----------

function serCookie(c) {
  const o = {
    name: c.name,
    domain: c.domain,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite || 'unspecified',
    hostOnly: !!c.hostOnly,
    session: !!c.session,
    storeId: c.storeId,
  };
  if (!c.session && typeof c.expirationDate === 'number') o.expirationDate = c.expirationDate;
  if (typeof c.value === 'string') o.value = c.value;
  if (c.firstPartyDomain !== undefined) o.firstPartyDomain = c.firstPartyDomain;
  if (c.partitionKey !== undefined) o.partitionKey = c.partitionKey;
  return o;
}

async function collectCookies() {
  const notes = [];
  const stores = await chrome.cookies.getAllCookieStores();
  let cookies = [];
  for (const st of stores) {
    if (st.id !== '0') {
      notes.push(`Cookie store "${st.id}" (non-default/incognito) excluded by design.`);
      continue;
    }
    const list = await chrome.cookies.getAll({ storeId: st.id });
    cookies = cookies.concat(list.map(serCookie));

    // Partitioned (CHIPS) cookies are INVISIBLE to a plain getAll(): they only
    // come back when the query carries an explicit partitionKey. There is no API
    // to enumerate partition keys, so candidate topLevelSites are derived from
    // open tabs, history and reading-list URLs (best possible coverage).
    const candidates = new Set();
    const addCandidate = (url) => {
      try {
        if (!url) return;
        const u = new URL(url);
        if (u.protocol === 'https:' || u.protocol === 'http:') candidates.add(u.origin);
      } catch (e) {
        /* ignore malformed */
      }
    };
    try {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) addCandidate(t.url);
      const hist = await chrome.history.search({ text: '', startTime: 0, maxResults: 2000 });
      for (const h of hist) addCandidate(h.url);
      if (chrome.readingList && typeof chrome.readingList.query === 'function') {
        for (const e of await chrome.readingList.query({})) addCandidate(e.url);
      }
    } catch (e) {
      notes.push('partition-key candidate scan incomplete: ' + (e.message || e));
    }
    let scanned = 0;
    const seen = new Set(
      cookies.map((c) => `${c.name}|${c.domain}|${c.path}|${JSON.stringify(c.partitionKey ?? null)}`)
    );
    for (const site of candidates) {
      if (scanned >= 3000) {
        notes.push('partition scan capped at 3000 candidate sites');
        break;
      }
      scanned++;
      try {
        const plist = await chrome.cookies.getAll({ storeId: st.id, partitionKey: { topLevelSite: site } });
        for (const c of plist) {
          const key = `${c.name}|${c.domain}|${c.path}|${JSON.stringify(c.partitionKey ?? null)}`;
          if (!seen.has(key)) {
            seen.add(key);
            cookies.push(serCookie(c));
          }
        }
      } catch (e) {
        /* skip candidate */
      }
      if (scanned % 250 === 0) await yieldToUI();
    }
    if (candidates.size > 0) {
      notes.push(
        `Partitioned (CHIPS) cookies: ${scanned} candidate partition keys scanned (derived from tabs/history/reading list; there is no enumeration API).`
      );
    }
  }
  const out = { cookies };
  if (notes.length) out.notes = notes;
  return out;
}

// ---------- downloads (metadata only) ----------

async function collectDownloads() {
  const items = await chrome.downloads.search({});
  return {
    items: items.map((d) => {
      const o = {
        url: d.url,
        finalUrl: d.finalUrl !== d.url ? d.finalUrl : undefined,
        filename: d.filename,
        mimeType: d.mime || '',
        startTime: d.startTime,
        state: d.state,
        totalBytes: d.totalBytes,
        receivedBytes: d.receivedBytes,
        danger: d.danger,
        ...(d.endTime ? { endTime: d.endTime } : {}),
        ...(d.interruptReason ? { interruptReason: d.interruptReason } : {}),
        ...(d.referrer ? { referrer: d.referrer } : {}),
        ...(d.exists !== undefined ? { exists: d.exists } : {}),
      };
      return o;
    }),
    note: 'Metadata only. Downloaded file contents are not accessible via any public extension API.',
  };
}

// ---------- reading list ----------

async function collectReadingList() {
  // Chrome >= 114 exposes chrome.readingList with query() (verified by probe;
  // there is no getEntries() method). Fall back defensively anyway.
  let entries;
  if (typeof chrome.readingList.query === 'function') {
    entries = await chrome.readingList.query({});
  } else if (typeof chrome.readingList.getEntries === 'function') {
    entries = await chrome.readingList.getEntries({});
  } else {
    throw new TypedError('ERR_READINGLIST_NO_ENUM', 'readingList API has no enumeration method in this browser');
  }
  return {
    entries: (entries || []).map((e) => ({
      url: e.url,
      title: e.title,
      hasBeenRead: !!e.hasBeenRead,
      creationTime: e.creationTime,
      lastUpdateTime: e.lastUpdateTime,
    })),
  };
}

// ---------- extension storage (this extension's own) ----------

async function collectExtensionStorage() {
  const local = await chrome.storage.local.get(null);
  let sync = {};
  let syncNote;
  try {
    sync = await chrome.storage.sync.get(null);
  } catch (e) {
    syncNote = 'storage.sync unavailable: ' + (e.message || 'unknown');
  }
  const out = { local };
  if (Object.keys(sync).length) out.sync = sync;
  if (syncNote) out.syncNote = syncNote;
  return out;
}

// ---------- installed extensions (metadata only) ----------

async function collectInstalledExtensions() {
  const all = await chrome.management.getAll();
  const selfId = chrome.runtime.id;
  return {
    selfId,
    items: (all || [])
      .filter((e) => e.installType !== 'component')
      .map((e) => ({
        id: e.id,
        name: e.name,
        version: e.version,
        type: e.type,
        enabled: e.enabled,
        installType: e.installType,
        isSelf: e.id === selfId,
        ...(Array.isArray(e.permissions) && e.permissions.length ? { permissions: e.permissions } : {}),
        ...(Array.isArray(e.hostPermissions) && e.hostPermissions.length ? { hostPermissions: e.hostPermissions } : {}),
        ...(e.disabledReason ? { disabledReason: e.disabledReason } : {}),
        ...(e.optionsUrl ? { optionsUrl: e.optionsUrl } : {}),
        ...(e.homepageUrl ? { homepageUrl: e.homepageUrl } : {}),
        ...(e.updateUrl ? { updateUrl: e.updateUrl } : {}),
      })),
    note: 'Metadata only: extension packages cannot be exported or installed via public APIs. Restore = manual reinstall checklist.',
  };
}

// ---------- this extension's permissions ----------

async function collectExtensionPermissions() {
  const p = await chrome.permissions.getAll();
  return {
    permissions: p.permissions || [],
    origins: p.origins || [],
  };
}

// ---------- profile / browser metadata ----------

async function collectProfile() {
  let platform = null;
  try {
    platform = await chrome.runtime.getPlatformInfo();
  } catch (e) {
    /* ignore */
  }
  return {
    userAgent: navigator.userAgent,
    chromeVersion: getChromeVersion(),
    platform: platform ? { os: platform.os, arch: platform.arch, naclArch: platform.naclArch } : null,
    extensionVersion: chrome.runtime.getManifest().version,
    locale: navigator.language,
  };
}

// ---------- orchestrator ----------

export const COLLECTORS = [
  ['bookmarks', collectBookmarks],
  ['history', collectHistory],
  ['tabsWindows', collectTabsWindows],
  ['sessions', collectSessions],
  ['cookies', collectCookies],
  ['downloads', collectDownloads],
  ['readingList', collectReadingList],
  ['extensionStorage', collectExtensionStorage],
  ['installedExtensions', collectInstalledExtensions],
  ['extensionPermissions', collectExtensionPermissions],
  ['profile', collectProfile],
  // Slowest category last: opens/closes one hidden tab per origin and briefly
  // attaches the debugger (site storage is only reachable from page context).
  ['siteData', collectSiteData],
];

export function computeCounts(data) {
  const c = {};
  if (data.bookmarks) {
    let folders = 0,
      bookmarks = 0;
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.type === 'folder') {
          folders++;
          walk(n.children || []);
        } else bookmarks++;
      }
    };
    for (const r of Object.values(data.bookmarks.roots)) walk(r.children || []);
    c.bookmarks = bookmarks;
    c.bookmarkFolders = folders;
  }
  if (data.history) c.history = data.history.items.length;
  if (data.tabsWindows) {
    c.windows = data.tabsWindows.windows.length;
    c.tabs = data.tabsWindows.windows.reduce((a, w) => a + w.tabs.length, 0);
    c.tabGroups = data.tabsWindows.tabGroups.length;
  }
  if (data.sessions) c.recentlyClosedSessions = data.sessions.recentlyClosed.length;
  if (data.cookies) c.cookies = data.cookies.cookies.length;
  if (data.downloads) c.downloads = data.downloads.items.length;
  if (data.readingList) c.readingList = data.readingList.entries.length;
  if (data.installedExtensions) c.installedExtensions = data.installedExtensions.items.length;
  if (data.extensionPermissions)
    c.extensionPermissions = data.extensionPermissions.permissions.length + data.extensionPermissions.origins.length;
  if (data.extensionStorage) c.extensionStorage = Object.keys(data.extensionStorage).length;
  if (data.profile) c.profile = 1;
  Object.assign(c, computeSiteDataCounts(data.siteData));
  return c;
}

// Collects everything available. Returns { data, counts, capabilities, categoryStatus }.
// A failing category records the error but does not abort the whole backup.
// options.siteData: { includeOrigins, excludeOrigins, maxOrigins, fetchScript, scanWindowSize }
// progress callback: (message, category, state, frac, stats) where frac is 0..1
// across the whole collection phase (categories may report a sub-fraction);
// stats is an optional live-counter object forwarded by the category.
export async function collectAll(progress, options) {
  const opts = options || {};
  const selected = Array.isArray(opts.selectedCategories) ? new Set(opts.selectedCategories) : null;
  const activeCount = COLLECTORS.filter(([name]) => !selected || selected.has(name)).length;
  const total = activeCount || 1;
  const clamp01 = (f) => (typeof f === 'number' && Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0);
  const categoryStatus = {};
  const data = {};
  let doneCount = 0;
  for (const [name, fn] of COLLECTORS) {
    if (selected && !selected.has(name)) {
      categoryStatus[name] = { ok: false, skipped: true };
      continue;
    }
    if (progress) progress(`collecting: ${name}`, name, 'running', doneCount / total);
    try {
      data[name] = await fn(
        (msg, frac, stats) => progress && progress(msg, name, 'running', (doneCount + clamp01(frac)) / total, stats),
        name === 'siteData' ? opts.siteData || {} : undefined
      );
      categoryStatus[name] = { ok: true };
    } catch (e) {
      const stack = e && e.stack ? String(e.stack).split('\n').slice(0, 6).join('\n') : '';
      categoryStatus[name] = { ok: false, error: (e && e.message) || String(e), stack };
    }
    doneCount++;
    if (progress) progress(`collected: ${name}`, name, 'ok', doneCount / total);
    await yieldToUI();
  }
  const capabilities = detect();
  const counts = computeCounts(data);
  return { data, counts, capabilities, categoryStatus };
}
