// Restore engine. Defaults are NON-DESTRUCTIVE:
//  - bookmarks: merge (skip URLs that already exist in the target folder)
//  - readingList / cookies: idempotent merges/sets
//  - tabs/windows/sessions: re-created as NEW windows/tabs (existing ones untouched)
//  - downloads: metadata-only unless the user explicitly opts into re-downloading
//  - "replace" (destructive) modes exist only for bookmarks and require an
//    explicit user confirmation flag passed by the UI.
// History and installed extensions genuinely CANNOT be restored via public APIs;
// the engine reports that instead of pretending.

import { yieldToUI, TypedError } from './util.js';
import { CATEGORY_GROUP_MEMBERS } from './collect.js';
import {
  restoreSiteData as restoreSiteDataImpl,
  createTabOwnership,
} from './sitedata.js';

// Only http(s) URLs may be navigated/opened during restore. Anything else
// (data:, javascript:, chrome:, …) is refused and reported — a malicious
// backup file must not be able to render attacker HTML as a real tab.
function isRestorableHttpUrl(u) {
  return (
    typeof u === 'string' &&
    (u.startsWith('http://') || u.startsWith('https://'))
  );
}

// Hard cap on tabs created by one restore (tab-bomb guard). A malicious
// backup with tens of thousands of tabs would hang the browser in
// chrome.tabs.create long before any of them is useful — refuse up front,
// fail-closed, with a clear error instead of a partial restore.
const MAX_RESTORE_TABS = 500;

// ---------- bookmarks ----------

// Resolve current well-known bookmark root ids (they are NOT stable across
// Chrome versions — Chrome 131 used '1'/'2', Chrome 153 uses dynamic ids).
async function bookmarkRootIds() {
  const tree = await chrome.bookmarks.getTree();
  const kids = (tree[0] && tree[0].children) || [];
  const barId = (kids.find((k) => k.id === '1') || kids[0] || {}).id || '1';
  const otherId = (kids.find((k) => k.id === '2') || kids[1] || {}).id || '2';
  const mobileId = (kids[2] || {}).id || null;
  return { barId, otherId, mobileId };
}

async function restoreBookmarks(data, opts, progress) {
  const mode = (opts && opts.mode) === 'replace' ? 'replace' : 'merge';
  const stats = { created: 0, skippedExisting: 0, failed: 0, notes: [] };
  const { barId, otherId } = await bookmarkRootIds();

  if (mode === 'replace') {
    if (!(opts && opts.confirmDestructive)) {
      throw new TypedError(
        'ERR_CONFIRMATION_REQUIRED',
        'Replace mode is destructive and requires explicit confirmation.'
      );
    }
    progress &&
      progress(
        'bookmarks: replace mode — clearing existing bookmark bar / other bookmarks'
      );
    for (const rootId of [barId, otherId]) {
      const kids = await chrome.bookmarks.getChildren(rootId);
      for (const k of kids.slice().reverse()) {
        try {
          if (k.url) await chrome.bookmarks.remove(k.id);
          else await chrome.bookmarks.removeTree(k.id);
        } catch (e) {
          stats.failed++;
          stats.notes.push(
            `could not clear existing bookmark node ${k.id}: ${e.message}`
          );
        }
      }
    }
  }

  // Cache of existing children per folder id (for merge dedupe).
  const childrenCache = new Map();
  async function childrenOf(folderId) {
    if (!childrenCache.has(folderId)) {
      const kids = await chrome.bookmarks.getChildren(folderId);
      childrenCache.set(folderId, kids);
    }
    return childrenCache.get(folderId);
  }

  async function ensureFolder(parentId, title) {
    const kids = await childrenOf(parentId);
    const found = kids.find((k) => !k.url && k.title === title);
    if (found) return found.id;
    const created = await chrome.bookmarks.create({ parentId, title });
    kids.push(created);
    return created.id;
  }

  async function restoreChildren(children, parentId, path) {
    let idx = 0;
    for (const child of children) {
      if (child.type === 'folder' || (!child.url && child.children)) {
        const fid = await ensureFolder(parentId, child.title || '');
        if (mode === 'replace' && Array.isArray(child.children)) {
          // In replace mode the folder is freshly created, recreate exact order via index.
          await restoreChildrenIndexed(
            child.children || [],
            fid,
            path + '/' + (child.title || '')
          );
        } else {
          await restoreChildren(
            child.children || [],
            fid,
            path + '/' + (child.title || '')
          );
        }
        await yieldToUI();
      } else if (child.url) {
        try {
          if (mode === 'merge') {
            const kids = await childrenOf(parentId);
            if (kids.some((k) => k.url === child.url)) {
              stats.skippedExisting++;
              idx++;
              continue;
            }
          }
          const props = { parentId, title: child.title || '', url: child.url };
          if (mode === 'replace') props.index = idx;
          await chrome.bookmarks.create(props);
          if (mode === 'merge')
            (await childrenOf(parentId)).push({
              url: child.url,
              title: child.title,
            });
          stats.created++;
        } catch (e) {
          stats.failed++;
          stats.notes.push(`bookmark failed: ${child.url}: ${e.message}`);
        }
        idx++;
        if (stats.created % 50 === 0) {
          progress && progress(`bookmarks: ${stats.created} created`);
          await yieldToUI();
        }
      }
    }
  }

  async function restoreChildrenIndexed(children, parentId, path) {
    let idx = 0;
    for (const child of children) {
      if (child.type === 'folder' || (!child.url && child.children)) {
        const created = await chrome.bookmarks.create({
          parentId,
          index: idx,
          title: child.title || '',
        });
        await restoreChildrenIndexed(
          child.children || [],
          created.id,
          path + '/' + (child.title || '')
        );
      } else if (child.url) {
        try {
          await chrome.bookmarks.create({
            parentId,
            index: idx,
            title: child.title || '',
            url: child.url,
          });
          stats.created++;
        } catch (e) {
          stats.failed++;
          stats.notes.push(`bookmark failed: ${child.url}: ${e.message}`);
        }
      }
      idx++;
      if (idx % 50 === 0) {
        progress && progress(`bookmarks: ${stats.created} created`);
        await yieldToUI();
      }
    }
  }

  const roots = (data && data.roots) || {};
  for (const [rootKey, rootNode] of Object.entries(roots)) {
    let targetId;
    if (rootKey === 'bookmark_bar') targetId = barId;
    else if (rootKey === 'other') targetId = otherId;
    else targetId = await ensureFolder(otherId, 'Mobile bookmarks');
    if (mode === 'replace')
      await restoreChildrenIndexed(
        rootNode.children || [],
        targetId,
        '/' + rootKey
      );
    else
      await restoreChildren(rootNode.children || [], targetId, '/' + rootKey);
    progress && progress(`bookmarks: root "${rootKey}" done`);
    await yieldToUI();
  }

  if (mode === 'merge') {
    stats.notes.push(
      'Merge mode: duplicates (same URL in same folder) skipped.'
    );
  }
  stats.notes.push(
    'dateAdded timestamps cannot be restored (bookmarks.create does not accept them — API limitation).'
  );
  return {
    status: 'ok',
    stats,
    summary: `bookmarks: ${stats.created} created, ${stats.skippedExisting} duplicates skipped, ${stats.failed} failed`,
  };
}

// ---------- tabs & windows ----------

const VALID_STATES = ['normal', 'minimized', 'maximized', 'fullscreen'];

// Granular tabsWindows (Batch 2): the "tabs"-without-"windows" selection stores
// tabs as a flat list carrying their old windowId (no window layout). Group
// them into one synthetic window entry per old windowId so the restore loop
// below stays single-pathed. Legacy nested backups (no top-level tabs[]) and
// layout-only windows pass through unchanged.
function expandFlatTabsWindows(data) {
  const windows = (data && data.windows) || [];
  const flatTabs = data && Array.isArray(data.tabs) ? data.tabs : [];
  if (flatTabs.length === 0) return windows;
  const byWindowId = new Map();
  for (const t of flatTabs) {
    const key =
      t && t.windowId !== undefined && t.windowId !== null
        ? String(t.windowId)
        : '';
    if (!byWindowId.has(key)) byWindowId.set(key, []);
    byWindowId.get(key).push(t);
  }
  return windows.concat([...byWindowId.values()].map((tabs) => ({ tabs })));
}

// Notes the skipped grouping when a backup carries tab-group metadata but no
// tabs at all (granular "tabGroups"-only selection).
function noteSkippedTabGroups(data, totalTabs, notes) {
  if ((data.tabGroups || []).length > 0 && totalTabs === 0) {
    notes.push(
      'Tab groups skipped: the backup contains tab-group metadata but no tabs to group.'
    );
  }
}

// eslint-disable-next-line complexity -- TECH DEBT: complexity 40, refactoring risks behavior change
export async function restoreTabsWindows(data, opts, progress) {
  const stats = {
    windowsCreated: 0,
    tabsCreated: 0,
    tabsFailed: 0,
    windowGeometryFailures: 0,
    pinned: 0,
    muted: 0,
    grouped: 0,
    notes: [],
  };
  const failedTabIndexes = new Set();
  const groupMetaByOldId = new Map(
    (data.tabGroups || []).map((g) => [String(g.groupId), g])
  );

  const windows = expandFlatTabsWindows(data);
  const totalTabs = windows.reduce(
    (n, w) => n + ((w && w.tabs && w.tabs.length) || 0),
    0
  );
  if (totalTabs > MAX_RESTORE_TABS) {
    throw new TypedError(
      'ERR_RESTORE_TOO_LARGE',
      `Refusing to restore ${totalTabs} tabs (limit ${MAX_RESTORE_TABS}): ` +
        'this looks like a malicious or corrupted backup file.'
    );
  }
  noteSkippedTabGroups(data, totalTabs, stats.notes);
  let androidWindow = null;
  let androidBaseIndex = 0;
  try {
    const platform = await chrome.runtime.getPlatformInfo();
    if (platform.os === 'android' && windows.length) {
      androidWindow = await chrome.windows.getLastFocused({ populate: true });
      androidBaseIndex = (androidWindow.tabs || []).length;
      stats.windowsCreated = 1;
      stats.notes.push(
        'Android: backed-up windows were restored as background tabs in the current window.'
      );
    }
  } catch (e) {
    /* use the standard window restore path where platform detection is unavailable */
  }

  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi];
    const state = VALID_STATES.includes(w.state) ? w.state : 'normal';
    const createProps = {
      focused: false,
      type: w.type === 'popup' ? 'popup' : 'normal',
      state,
    };
    if (state === 'normal' && w.bounds && w.bounds.width && w.bounds.height) {
      createProps.left = w.bounds.left;
      createProps.top = w.bounds.top;
      createProps.width = w.bounds.width;
      createProps.height = w.bounds.height;
    }
    let win;
    if (androidWindow) {
      win = androidWindow;
    } else {
      try {
        win = await chrome.windows.create(createProps);
      } catch (e) {
        stats.windowGeometryFailures++;
        stats.notes.push(
          `window ${wi} could not be created with geometry (${e.message}); retrying default`
        );
        win = await chrome.windows.create({ focused: false });
      }
      stats.windowsCreated++;
    }

    const initialTabId = androidWindow
      ? null
      : (win.tabs && win.tabs[0] && win.tabs[0].id) || null;
    // Ownership: only this placeholder tab — created by our own
    // windows.create above — may ever be closed, via safeCloseTab. A refusal
    // can only come from a bug — log it loudly and skip the close.
    const ownership = createTabOwnership(
      stats.notes,
      async (tabId) => {
        try {
          const t = await chrome.tabs.get(tabId);
          return t.windowId === win.id ? 'ours' : 'foreign';
        } catch (e) {
          return 'gone';
        }
      },
      (reason) =>
        stats.notes.push(
          `SAFETY VIOLATION during window restore — ${reason}; close skipped`
        )
    );
    if (initialTabId !== null) ownership.own(initialTabId);
    const orderOffset = androidWindow ? androidBaseIndex : 0;
    const tabsByOldGroup = new Map(); // oldGroupId -> [newTabId, ...] in order
    const createdTabs = [];
    const tabs = w.tabs || [];
    // Cromite Android appears to serialize small create batches visibly. Send
    // every background create request for the current saved window together;
    // the browser remains responsible for scheduling page loads.
    const batchSize = androidWindow ? Math.max(tabs.length, 1) : 4;
    for (let start = 0; start < tabs.length; start += batchSize) {
      const batch = tabs.slice(start, start + batchSize);
      const results = await Promise.all(
        batch.map(async (t, offset) => {
          const ti = start + offset;
          try {
            // Stage 1: create all tab placeholders without starting page loads.
            // Android Cromite can otherwise serialize tab creation and navigation.
            const created = await chrome.tabs.create({
              windowId: win.id,
              url: 'about:blank',
              active: false,
            });
            stats.tabsCreated++;
            const record = { id: created.id, index: ti, tab: t };
            createdTabs.push(record);
            return record;
          } catch (e) {
            stats.tabsFailed++;
            failedTabIndexes.add(`${wi}:${ti}`);
            stats.notes.push(`tab failed: ${t.url}: ${e.message}`);
            return null;
          }
        })
      );
      // Stage 2: only after the whole batch exists, dispatch URL loads and
      // metadata changes together. Promise.all invokes each tabs.update before
      // awaiting any result, so the browser receives the complete batch at once.
      await Promise.all(
        results.filter(Boolean).map(async (record) => {
          const { id, index: ti, tab: t } = record;
          const jobs = [];
          if (t.url && t.url !== 'about:blank') {
            if (!isRestorableHttpUrl(t.url)) {
              stats.tabsFailed++;
              failedTabIndexes.add(`${wi}:${ti}`);
              stats.notes.push(
                `tab navigation refused (non-http(s) URL): ${t.url}`
              );
            } else {
              jobs.push(
                chrome.tabs
                  .update(id, { url: t.url, active: false })
                  .catch((e) => {
                    stats.tabsFailed++;
                    failedTabIndexes.add(`${wi}:${ti}`);
                    stats.notes.push(
                      `tab navigation failed: ${t.url}: ${e.message}`
                    );
                  })
              );
            }
          }
          if (t.pinned)
            jobs.push(
              chrome.tabs
                .update(id, { pinned: true })
                .then(() => {
                  stats.pinned++;
                })
                .catch((e) => {
                  failedTabIndexes.add(`${wi}:${ti}`);
                  stats.notes.push(`pin failed: ${t.url}: ${e.message}`);
                })
            );
          if (t.muted)
            jobs.push(
              chrome.tabs
                .update(id, { muted: true })
                .then(() => {
                  stats.muted++;
                })
                .catch((e) => {
                  failedTabIndexes.add(`${wi}:${ti}`);
                  stats.notes.push(`mute failed: ${t.url}: ${e.message}`);
                })
            );
          if (t.groupId !== undefined) {
            const key = String(t.groupId);
            if (!tabsByOldGroup.has(key)) tabsByOldGroup.set(key, []);
            tabsByOldGroup.get(key).push({ id, index: ti });
          }
          await Promise.all(jobs);
        })
      );
      progress &&
        progress(
          `window ${wi + 1}/${windows.length}: tab ${Math.min(start + batch.length, tabs.length)}/${tabs.length}`
        );
      await yieldToUI();
    }

    // APIs may insert concurrently created tabs in completion order. Move them
    // once all batches finish, in backup order, before restoring groups.
    createdTabs.sort((a, b) => a.index - b.index);
    for (const tab of createdTabs) {
      try {
        await chrome.tabs.move(tab.id, {
          windowId: win.id,
          index: orderOffset + tab.index,
        });
      } catch (e) {
        failedTabIndexes.add(`${wi}:${tab.index}`);
        stats.notes.push(`tab ordering failed: ${tab.tab.url}: ${e.message}`);
      }
    }

    if (initialTabId !== null) {
      // Only our own placeholder tab may be closed — safeCloseTab refuses
      // anything outside the ownership registry.
      await ownership.safeCloseTab(initialTabId);
    }

    for (const [oldGid, groupedTabs] of tabsByOldGroup) {
      const tabIds = groupedTabs
        .sort((a, b) => a.index - b.index)
        .map((tab) => tab.id);
      try {
        // createProperties.windowId is REQUIRED: without it tabs.group() creates
        // the group in the CURRENT window and silently MOVES the tabs there.
        const newGid = await chrome.tabs.group({
          tabIds,
          createProperties: { windowId: win.id },
        });
        const meta = groupMetaByOldId.get(oldGid);
        if (meta) {
          const upd = { title: meta.title || '' };
          if (meta.color) upd.color = meta.color;
          if (typeof meta.collapsed === 'boolean')
            upd.collapsed = meta.collapsed;
          try {
            await chrome.tabGroups.update(newGid, upd);
          } catch (e) {
            for (const tab of groupedTabs)
              failedTabIndexes.add(`${wi}:${tab.index}`);
            stats.notes.push(`group update failed: ${e.message}`);
          }
        }
        stats.grouped += tabIds.length;
      } catch (e) {
        for (const tab of groupedTabs)
          failedTabIndexes.add(`${wi}:${tab.index}`);
        stats.notes.push(`grouping failed: ${e.message}`);
      }
    }
    if (androidWindow) androidBaseIndex += tabs.length;
    await yieldToUI();
  }

  stats.notes.push(
    'Tab titles/favicons are re-fetched by the browser (no API to set titles).'
  );
  const tabCount = windows.reduce(
    (count, window) => count + (window.tabs || []).length,
    0
  );
  stats.outcomeCounts = {
    succeeded: tabCount - failedTabIndexes.size,
    failed: failedTabIndexes.size + stats.windowGeometryFailures,
    skipped: 0,
  };
  return {
    status: 'ok',
    stats,
    summary: `tabs/windows: ${stats.windowsCreated} windows, ${stats.tabsCreated} tabs (${stats.tabsFailed} failed), ${stats.pinned} pinned, ${stats.grouped} grouped`,
  };
}

// ---------- sessions (recently closed) — approximate reopen ----------

async function restoreSessions(data, _opts, _progress) {
  const stats = { windowsReopened: 0, tabsReopened: 0, failed: 0, notes: [] };
  const items = (data && data.recentlyClosed) || [];
  const totalTabs = items.reduce(
    (n, item) =>
      n +
      (((item && item.window && item.window.tabs && item.window.tabs.length) ||
        0) +
        (item && item.tab ? 1 : 0)),
    0
  );
  if (totalTabs > MAX_RESTORE_TABS) {
    throw new TypedError(
      'ERR_RESTORE_TOO_LARGE',
      `Refusing to restore ${totalTabs} session tabs (limit ${MAX_RESTORE_TABS}): ` +
        'this looks like a malicious or corrupted backup file.'
    );
  }
  for (const item of items) {
    try {
      if (item.window && item.window.tabs && item.window.tabs.length) {
        const urls = item.window.tabs
          .map((t) => t.url)
          .filter(isRestorableHttpUrl);
        if (!urls.length) {
          stats.failed++;
          stats.notes.push(
            'session window skipped: no restorable http(s) URLs'
          );
        } else {
          await chrome.windows.create({ focused: false, url: urls });
          stats.windowsReopened++;
        }
      } else if (item.tab && isRestorableHttpUrl(item.tab.url)) {
        await chrome.tabs.create({ url: item.tab.url, active: false });
        stats.tabsReopened++;
      } else if (item.tab && item.tab.url) {
        stats.failed++;
        stats.notes.push(
          `session tab refused (non-http(s) URL): ${item.tab.url}`
        );
      }
    } catch (e) {
      stats.failed++;
      stats.notes.push(`session reopen failed: ${e.message}`);
    }
    await yieldToUI();
  }
  stats.notes.push(
    'Approximate restore: URLs re-opened as new tabs/windows. Original timestamps and back/forward stacks are not restorable (API limitation).'
  );
  return {
    status: 'ok',
    stats,
    summary: `sessions: ${stats.windowsReopened} windows + ${stats.tabsReopened} tabs re-opened (approximate)`,
  };
}

// ---------- cookies ----------

function cookieUrlFor(c) {
  const host = (c.domain || '').replace(/^\./, '');
  return `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
}

// eslint-disable-next-line complexity -- TECH DEBT: complexity 33, refactoring risks behavior change
async function restoreCookies(data, opts, progress) {
  const stats = { set: 0, failed: 0, adjusted: 0, skippedStale: 0, notes: [] };
  const cookies = (data && data.cookies) || [];
  for (let i = 0; i < cookies.length; i++) {
    const c = cookies[i];
    try {
      const details = {
        url: cookieUrlFor(c),
        name: c.name,
        value: c.value,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
      };
      let sameSite = c.sameSite || 'unspecified';
      if (sameSite === 'no_restriction' && !c.secure) {
        sameSite = 'unspecified'; // Chrome rejects no_restriction without Secure
        stats.adjusted++;
      }
      if (sameSite && sameSite !== 'unspecified') details.sameSite = sameSite;
      if (!c.hostOnly && c.domain) details.domain = c.domain;
      if (!c.session && typeof c.expirationDate === 'number')
        details.expirationDate = c.expirationDate;
      if (c.firstPartyDomain !== undefined)
        details.firstPartyDomain = c.firstPartyDomain;
      if (c.partitionKey !== undefined && c.partitionKey !== null) {
        details.partitionKey =
          typeof c.partitionKey === 'string'
            ? { topLevelSite: c.partitionKey, hasCrossSiteAncestor: false }
            : { hasCrossSiteAncestor: false, ...c.partitionKey };
      }
      // Never let a stale backup cookie overwrite a fresher live one:
      // compare expirationDate (a live session cookie counts as infinitely
      // fresh — the user's current state wins over an old snapshot).
      const live = await chrome.cookies
        .get({ url: details.url, name: c.name })
        .catch(() => null);
      if (live) {
        const liveExp =
          typeof live.expirationDate === 'number'
            ? live.expirationDate
            : Infinity;
        const backupExp =
          !c.session && typeof c.expirationDate === 'number'
            ? c.expirationDate
            : Infinity;
        if (liveExp >= backupExp) {
          stats.skippedStale++;
          stats.notes.push(
            `cookie skipped: fresher live cookie exists (name="${c.name}", domain ${c.domain})`
          );
          continue;
        }
      }
      const done = await chrome.cookies.set(details);
      if (!done && c.partitionKey !== undefined && c.partitionKey !== null) {
        // Chrome refuses partitioned cookies via the extension API (probe-verified).
        stats.failed++;
        stats.notes.push(
          `partitioned cookie could not be re-created (cookies.set refuses partitionKey) — name hidden, domain ${c.domain}`
        );
        continue;
      }
      stats.set++;
    } catch (e) {
      // Retry once without partition/firstParty attributes in case of API mismatch.
      // (Partitioned cookies are NOT retried unpartitioned: that would create a
      // different, wrong cookie. See note above.)
      if (c.partitionKey !== undefined && c.partitionKey !== null) {
        stats.failed++;
        stats.notes.push(
          `partitioned cookie failed: ${e.message || 'unknown'}`
        );
        continue;
      }
      try {
        await chrome.cookies.set({
          url: cookieUrlFor(c),
          name: c.name,
          value: c.value,
          path: c.path || '/',
          secure: !!c.secure,
          httpOnly: !!c.httpOnly,
          ...(c.domain && !c.hostOnly ? { domain: c.domain } : {}),
          ...(!c.session && typeof c.expirationDate === 'number'
            ? { expirationDate: c.expirationDate }
            : {}),
        });
        stats.set++;
        stats.adjusted++;
        stats.notes.push(
          `cookie restored without partition/firstParty attributes (name hidden).`
        );
      } catch (err) {
        stats.failed++;
        stats.notes.push(
          `cookie failed: name="${c.name}" reason=${err.message}`
        );
      }
    }
    if (i % 100 === 0) {
      progress && progress(`cookies: ${i}/${cookies.length}`);
      await yieldToUI();
    }
  }
  return {
    status: 'ok',
    stats,
    summary: `cookies: ${stats.set} set, ${stats.failed} failed (${stats.adjusted} attribute-adjusted)`,
  };
}

// ---------- downloads ----------

async function restoreDownloads(data, opts, progress) {
  const mode =
    (opts && opts.mode) === 'redownload' ? 'redownload' : 'metadata-only';
  const stats = { redownloaded: 0, failed: 0, notes: [] };
  const items = (data && data.items) || [];
  if (mode === 'metadata-only') {
    stats.notes.push(
      'Metadata-only restore (default): download records were NOT re-downloaded. File bytes are not accessible via extension APIs.'
    );
    return {
      status: 'ok',
      stats,
      summary: `downloads: ${items.length} records available in backup (metadata-only mode — nothing re-downloaded)`,
    };
  }
  for (const d of items) {
    if (d.state !== 'complete') continue;
    const url = d.url || '';
    if (!(url.startsWith('http://') || url.startsWith('https://'))) continue;
    try {
      const base = (d.filename || 'download').split(/[\\/]/).pop();
      await chrome.downloads.download({ url, filename: base, saveAs: false });
      stats.redownloaded++;
    } catch (e) {
      stats.failed++;
      stats.notes.push(`re-download failed: ${e.message}`);
    }
    if (stats.redownloaded % 10 === 0) {
      progress && progress(`downloads: ${stats.redownloaded} re-downloaded`);
      await yieldToUI();
    }
  }
  stats.notes.push(
    'Re-downloaded items get NEW timestamps; original completion state is not reproducible.'
  );
  return {
    status: 'ok',
    stats,
    summary: `downloads: ${stats.redownloaded} re-downloaded, ${stats.failed} failed`,
  };
}

// ---------- history (basic restore via addUrl) ----------

async function restoreHistory(data, opts, progress) {
  const stats = { added: 0, skippedExisting: 0, failed: 0, notes: [] };
  const items = (data && data.items) || [];
  let existing = new Set();
  try {
    existing = new Set(
      (
        await chrome.history.search({
          text: '',
          startTime: 0,
          maxResults: 10000000,
        })
      ).map((h) => h.url)
    );
  } catch (e) {
    /* empty */
  }
  for (const it of items) {
    if (!it || !it.url) continue;
    try {
      if (existing.has(it.url)) {
        stats.skippedExisting++;
        continue;
      }
      await chrome.history.addUrl({ url: it.url });
      existing.add(it.url);
      stats.added++;
    } catch (e) {
      stats.failed++;
      stats.notes.push(`history addUrl failed: ${e.message}`);
    }
    if (stats.added % 100 === 0) {
      progress && progress(`history: ${stats.added} URLs added`);
      await yieldToUI();
    }
  }
  stats.notes.push(
    'BASIC restore via chrome.history.addUrl(): URLs are re-registered, but the browser records each as a single "typed" visit at restore time.',
    'Original titles, visit counts, visit timestamps and transition types cannot be restored — no public API exists for them (verified by runtime probe).',
    'The full-fidelity history (incl. per-visit data) remains inside the backup file for archival.'
  );
  return {
    status: 'ok',
    stats,
    summary: `history: ${stats.added} URLs re-added (basic mode), ${stats.skippedExisting} already present, ${stats.failed} failed`,
  };
}

// ---------- reading list ----------

async function restoreReadingList(data, opts, progress) {
  const stats = { added: 0, skippedExisting: 0, failed: 0, notes: [] };
  const entries = (data && data.entries) || [];
  let existing = new Set();
  const listAll = () => {
    if (typeof chrome.readingList.query === 'function')
      return chrome.readingList.query({});
    if (typeof chrome.readingList.getEntries === 'function')
      return chrome.readingList.getEntries({});
    return Promise.resolve([]);
  };
  try {
    existing = new Set((await listAll()).map((e) => e.url));
  } catch (e) {
    /* empty set */
  }
  for (const e of entries) {
    try {
      if (existing.has(e.url)) {
        stats.skippedExisting++;
        continue;
      }
      await chrome.readingList.addEntry({
        url: e.url,
        title: e.title || '',
        hasBeenRead: !!e.hasBeenRead,
      });
      existing.add(e.url);
      stats.added++;
    } catch (err) {
      stats.failed++;
      stats.notes.push(`readingList failed: ${err.message}`);
    }
    if (stats.added % 50 === 0) {
      progress && progress(`readingList: ${stats.added}`);
      await yieldToUI();
    }
  }
  stats.notes.push(
    'creationTime/lastUpdateTime are assigned by the browser on add (no API to set them).'
  );
  return {
    status: 'ok',
    stats,
    summary: `readingList: ${stats.added} added, ${stats.skippedExisting} duplicates skipped, ${stats.failed} failed`,
  };
}

// ---------- extension storage ----------

const EXTENSION_STORAGE_ALLOWLIST = [
  'bbr.dashboard.theme',
  'bbr:backup-categories',
  'bbr:site-data-scan-window',
  'bbr:site-data-tuning',
  'bbr:site-data-include',
];

async function restoreExtensionStorage(data, _opts, _progress) {
  const local = data.local && typeof data.local === 'object' ? data.local : {};
  const sync = data.sync && typeof data.sync === 'object' ? data.sync : {};
  const filteredLocal = Object.fromEntries(
    Object.entries(local).filter(([key]) =>
      EXTENSION_STORAGE_ALLOWLIST.includes(key)
    )
  );
  const stats = {
    keysLocal: Object.keys(filteredLocal).length,
    keysSync: 0,
    skippedKeys:
      Object.keys(local).length -
      Object.keys(filteredLocal).length +
      Object.keys(sync).length,
    notes: [],
  };
  if (stats.keysLocal) {
    await chrome.storage.local.set(filteredLocal);
  }
  return {
    status: 'ok',
    stats,
    summary: `extensionStorage: ${stats.keysLocal} local keys, ${stats.keysSync} sync keys, ${stats.skippedKeys} skipped`,
  };
}

// ---------- unsupported categories (honest reporting) ----------

function restoreExtensionsUnsupported(data) {
  const n = data && data.items ? data.items.length : 0;
  return Promise.resolve({
    status: 'unsupported',
    summary: `installedExtensions: cannot restore — no public API to install extensions. Backup contains a checklist of ${n} extensions for manual reinstallation.`,
    stats: {
      notes: [
        'Open chrome://extensions and the Chrome Web Store to reinstall manually.',
      ],
    },
  });
}

// ---------- site data (websites' storage via debugger/scripting) ----------

async function restoreSiteData(data, opts, progress) {
  const res = await restoreSiteDataImpl(data, opts, progress);
  const stats = res.stats || {};
  return {
    status: res.status,
    stats,
    summary: `${res.summary}, ${stats.partitionsRestored || 0} partitions restored, ${stats.partitionsWithoutHost || 0} partitions without a live host`,
  };
}

// ---------- granular restore pre-filter ----------

// The dashboard restore UI splits four sections into granular rows (the
// worker UI contract): tabsWindows -> tabs/windows/tabGroups,
// cookies -> cookies_plain/cookies_partitioned,
// sessions -> sessions_tabs/sessions_windows,
// siteData -> siteData_localStorage/siteData_indexedDB/siteData_otherStorage.
// The UI synthesizes options[section] =
//   { enabled, unavailable, granular: { [memberId]: bool }, ... }
// where `granular` maps member id -> enabled. This pure function narrows the
// backed-up section data to what the user selected BEFORE the restore
// function runs, so every guard inside (MAX_RESTORE_TABS, the http(s) URL
// allowlist, …) keeps working on the narrowed data unchanged.
export function filterSectionDataForRestore(cat, sectionData, granular) {
  if (
    granular === null ||
    granular === undefined ||
    typeof granular !== 'object' ||
    typeof sectionData !== 'object' ||
    sectionData === null
  ) {
    return sectionData;
  }
  const members = CATEGORY_GROUP_MEMBERS[cat] || [];
  // No-op: undivided sections, or every member selected, return the input
  // AS IS (identical reference). This is the equivalence guarantee: an
  // all-on restore sees exactly the same input as a filter-less restore.
  if (members.length === 0 || members.every((m) => granular[m])) {
    return sectionData;
  }
  switch (cat) {
    case 'tabsWindows':
      return filterTabsWindowsSection(sectionData, granular);
    case 'cookies':
      return filterCookiesSection(sectionData, granular);
    case 'sessions':
      return filterSessionsSection(sectionData, granular);
    case 'siteData':
      return filterSiteDataSection(sectionData, granular);
    default:
      return sectionData;
  }
}

function filterTabsWindowsSection(sectionData, granular) {
  const keepTabs = !!granular.tabs;
  const keepWindows = !!granular.windows;
  const keepGroups = !!granular.tabGroups;
  let windows = sectionData.windows || [];
  let flatTabs = Array.isArray(sectionData.tabs) ? sectionData.tabs : null;
  if (!keepTabs) {
    windows = windows.map((w) => ({ ...w, tabs: [] }));
    flatTabs = null;
  }
  if (!keepWindows) {
    // Tabs-only selection: flatten the nested tabs into a flat list
    // carrying their old windowId, mirroring collect's flat-tabs output, so
    // expandFlatTabsWindows regroups them into fresh windows on restore.
    const flat = [];
    windows.forEach((w, wi) => {
      const wid = w && w.id !== undefined && w.id !== null ? w.id : wi;
      for (const t of (w && w.tabs) || []) flat.push({ ...t, windowId: wid });
    });
    if (flatTabs) flat.push(...flatTabs);
    windows = [];
    flatTabs = flat;
  }
  const out = {
    ...sectionData,
    windows,
    tabGroups: keepGroups ? sectionData.tabGroups : [],
  };
  if (flatTabs) out.tabs = flatTabs;
  else delete out.tabs;
  if (!keepGroups && (sectionData.tabGroups || []).length > 0) {
    const notes = Array.isArray(sectionData.notes) ? sectionData.notes : [];
    out.notes = [
      ...notes,
      'Tab groups deselected by the user; grouping skipped.',
    ];
  }
  return out;
}

function filterCookiesSection(sectionData, granular) {
  const keepPlain = !!granular.cookies_plain;
  const keepPartitioned = !!granular.cookies_partitioned;
  return {
    ...sectionData,
    cookies: (sectionData.cookies || []).filter((c) =>
      c && c.partitionKey !== undefined ? keepPartitioned : keepPlain
    ),
  };
}

function keepSessionItem(item, keepTabs, keepWindows) {
  return !((item.tab && !keepTabs) || (item.window && !keepWindows));
}

function filterSessionsSection(sectionData, granular) {
  const keepTabs = !!granular.sessions_tabs;
  const keepWindows = !!granular.sessions_windows;
  const keep = (it) => keepSessionItem(it, keepTabs, keepWindows);
  const out = {
    ...sectionData,
    recentlyClosed: (sectionData.recentlyClosed || []).filter(keep),
  };
  if (Array.isArray(sectionData.devices)) {
    out.devices = sectionData.devices.map((d) => ({
      ...d,
      sessions: (d.sessions || []).filter(keep),
    }));
  }
  return out;
}

function filterSiteDataSection(sectionData, granular) {
  const keepLS = !!granular.siteData_localStorage;
  const keepIDB = !!granular.siteData_indexedDB;
  const keepOther = !!granular.siteData_otherStorage;
  const origins = {};
  for (const [origin, snap] of Object.entries(sectionData.origins || {})) {
    const s = { ...snap };
    if (!keepLS) delete s.localStorage;
    if (!keepIDB) delete s.indexedDB;
    if (!keepOther) {
      delete s.cacheStorage;
      delete s.opfs;
      delete s.buckets;
    }
    // sessionStorage / serviceWorkers are separate options — never touched.
    origins[origin] = s;
  }
  return { ...sectionData, origins };
}

// ---------- orchestrator ----------

const RESTORE_PLAN = [
  ['bookmarks', restoreBookmarks],
  ['history', restoreHistory],
  ['tabsWindows', restoreTabsWindows],
  ['sessions', restoreSessions],
  ['cookies', restoreCookies],
  ['readingList', restoreReadingList],
  ['downloads', restoreDownloads],
  ['extensionStorage', restoreExtensionStorage],
  ['installedExtensions', restoreExtensionsUnsupported],
  ['siteData', restoreSiteData],
];

function itemOutcomeCounts(cat, data, stats) {
  const items = (value) => (Array.isArray(value) ? value.length : 0);
  const count = (value) => (Number.isFinite(value) && value > 0 ? value : 0);
  if (stats.outcomeCounts) return stats.outcomeCounts;
  switch (cat) {
    case 'bookmarks':
      return {
        succeeded: count(stats.created),
        failed: count(stats.failed),
        skipped: count(stats.skippedExisting),
      };
    case 'history':
      return {
        succeeded: count(stats.added),
        failed: count(stats.failed),
        skipped: Math.max(
          0,
          items(data.items) - count(stats.added) - count(stats.failed)
        ),
      };
    case 'sessions': {
      const succeeded =
        count(stats.windowsReopened) + count(stats.tabsReopened);
      return {
        succeeded,
        failed: count(stats.failed),
        skipped: Math.max(
          0,
          items(data.recentlyClosed) - succeeded - count(stats.failed)
        ),
      };
    }
    case 'cookies':
      return {
        succeeded: count(stats.set),
        failed: count(stats.failed),
        skipped: Math.max(
          0,
          items(data.cookies) - count(stats.set) - count(stats.failed)
        ),
      };
    case 'downloads':
      return {
        succeeded: count(stats.redownloaded),
        failed: count(stats.failed),
        skipped: Math.max(
          0,
          items(data.items) - count(stats.redownloaded) - count(stats.failed)
        ),
      };
    case 'readingList':
      return {
        succeeded: count(stats.added),
        failed: count(stats.failed),
        skipped: Math.max(
          0,
          items(data.entries) - count(stats.added) - count(stats.failed)
        ),
      };
    case 'extensionStorage':
      return {
        succeeded: count(stats.keysLocal),
        failed: 0,
        skipped: count(stats.skippedKeys),
      };
    case 'siteData': {
      const notes = stats.notes || [];
      const partitionFailures = notes.filter(
        (note) =>
          (note.startsWith('partition restore into ') &&
            note.includes(' failed:')) ||
          note.startsWith('partitioned restore failed:')
      ).length;
      const sessionStorageFailures = notes.filter((note) =>
        note.startsWith('sessionStorage restore failed for ')
      ).length;
      const sessionStorageSkipped = notes.filter(
        (note) =>
          note.startsWith('sessionStorage of ') &&
          note.includes(' NOT restored:')
      ).length;
      return {
        succeeded:
          count(stats.originsRestored) + count(stats.partitionsRestored),
        failed:
          count(stats.originsFailed) +
          partitionFailures +
          sessionStorageFailures,
        skipped: count(stats.partitionsWithoutHost) + sessionStorageSkipped,
      };
    }
    default:
      return { succeeded: 0, failed: 0, skipped: 0 };
  }
}

function outcomeFor(counts) {
  if (!counts.failed) return 'complete';
  return counts.succeeded ? 'partial' : 'failed';
}

// options: { bookmarks: {mode:'merge'|'replace', confirmDestructive:bool},
//            tabsWindows: {enabled:bool}, sessions: {enabled:bool},
//            cookies: {enabled:bool}, readingList: {enabled:bool},
//            downloads: {mode:'metadata-only'|'redownload', enabled:bool},
//            extensionStorage: {enabled:bool} }
export async function restoreAll(backup, options, progress) {
  const results = {};
  const data = backup.data || {};
  const optFor = (cat, defaults) => {
    const o = (options && options[cat]) || {};
    return { ...defaults, ...o };
  };

  for (const [cat, fn] of RESTORE_PLAN) {
    const opts = optFor(cat, { enabled: false });
    const present = !!data[cat];
    if (!present) {
      results[cat] = {
        status: 'not_in_backup',
        outcome: 'not_in_backup',
        summary: `${cat}: not present in this backup.`,
      };
      continue;
    }
    if (opts.unavailable === true && fn !== restoreExtensionsUnsupported) {
      results[cat] = {
        status: 'unsupported',
        outcome: 'unavailable',
        summary: `${cat}: unavailable in the target browser because its restore API is not present.`,
      };
      continue;
    }
    if (opts.enabled === false && fn !== restoreExtensionsUnsupported) {
      results[cat] = {
        status: 'skipped_by_user',
        outcome: 'skipped_by_user',
        summary: `${cat}: skipped (disabled for this restore).`,
      };
      continue;
    }
    if (progress) progress(`restoring: ${cat}`, cat, 'running');
    try {
      const sectionInput = data[cat];
      const filtered = filterSectionDataForRestore(
        cat,
        sectionInput,
        opts.granular
      );
      const result = await fn(
        filtered,
        opts,
        (msg) => progress && progress(msg, cat, 'running')
      );
      if (result.status === 'unsupported') {
        results[cat] = { ...result, outcome: 'unavailable' };
      } else {
        const stats = result.stats || {};
        // Surface notes the pre-filter added (e.g. tab-group deselection)
        // so the user sees why items were skipped. Reference comparison:
        // the filter only replaces the notes array when it appends one.
        if (
          filtered !== sectionInput &&
          filtered &&
          filtered.notes !== sectionInput.notes &&
          Array.isArray(filtered.notes)
        ) {
          stats.notes = [...filtered.notes, ...(stats.notes || [])];
        }
        const outcomeCounts = itemOutcomeCounts(cat, sectionInput, stats);
        results[cat] = {
          ...result,
          outcome: outcomeFor(outcomeCounts),
          stats: { ...stats, outcomeCounts },
        };
      }
      if (progress) progress(`restored: ${cat}`, cat, 'ok');
    } catch (e) {
      results[cat] = {
        status: 'error',
        outcome: 'failed',
        summary: `${cat}: ${(e && e.message) || String(e)}`,
        stats: { outcomeCounts: { succeeded: 0, failed: 1, skipped: 0 } },
      };
    }
    await yieldToUI();
  }
  return results;
}
