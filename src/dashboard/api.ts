// @ts-nocheck -- Dashboard UI predates strict mode; needs dedicated refactoring pass. Tracked as tech debt.
// window.__api — the programmatic surface used by the automated test suite.
// Ported 1:1 from the original dashboard.js; harmless in production. The API
// never logs cookie values or passwords.
import { TypedError } from '@/lib/util';
import { encryptBackup } from '@/lib/crypto';
import { collectAll } from '@/lib/collect';
import { validateBackupFile } from '@/lib/validate';
import { restoreAll } from '@/lib/restore';
import { detect, runProbes, getChromeVersion } from '@/lib/capabilities';
import {
  loadCloudConfig,
  saveCloudConfig,
  redactConfig,
  runCloudBackup,
  listCloudBackups,
  downloadAndValidateBackup,
  getCloudInfo,
  getCloudState,
  createProviderFromConfig,
} from '@/lib/cloud';
import { isBackupDue, loadSchedulerState, saveSchedulerState } from '@/lib/scheduler';
import { appendLog } from './store';
import { buildBackupObject, buildCloudBackupObject, doBackup } from './logic';

const w = window as unknown as Record<string, unknown>;

export function installTestHooks() {
  if (w.__api) return; // already installed

  w.__api = {
    meta: () => ({
      extId: chrome.runtime.id,
      extensionVersion: chrome.runtime.getManifest().version,
      chromeVersion: getChromeVersion(),
      url: location.href,
    }),
    detect: () => detect(),
    probe: () => runProbes(),
    collectAll: async (onProgress: any, options: any) => {
      const { data, counts, capabilities, categoryStatus } = await collectAll(onProgress, options);
      return { data, counts, capabilities, categoryStatus };
    },
    buildBackupObject: (onProgress: any, collectOptions: any) => buildBackupObject(onProgress, collectOptions),
    // Full user-facing pipeline: collect -> finalize -> (encrypt) -> download file.
    runBackupToFile: async ({ encrypt = false, password = null, collectOptions = null } = {}) => {
      const r = await doBackup({ encrypt, password, collectOptions });
      // No auto-download: the test explicitly triggers the download (like the UI button).
      const { getDownloadInfo, fileName } = await import('./logic');
      const info = getDownloadInfo();
      // Wait for the encrypted envelope to be built (async, may take a moment under load).
      if (encrypt) {
        const { isBackupEnvelopeReady } = await import('./logic');
        for (let i = 0; i < 20; i++) {
          if (isBackupEnvelopeReady()) break;
          await new Promise((res) => setTimeout(res, 250));
        }
      }
      return {
        outName: fileName(encrypt ? 'backup.enc.json' : 'backup.json'),
        downloadId: null,
        sizeBytes: info.estBytes,
        counts: r.backup.counts,
        format: r.backup.format,
        needsManualDownload: true,
      };
    },
    downloadBackupFile: async () => {
      const { downloadBackupResult } = await import('./logic');
      await downloadBackupResult();
      return { ok: true };
    },
    encryptBackup: async (backupObj: any, password: string) => encryptBackup(backupObj, password),
    validate: (text: string, opts: any) => validateBackupFile(text, opts || {}),
    // ---------------- cloud hooks (automated tests) ----------------
    cloud: {
      saveConfig: async (raw: any) => {
        const cfg = await saveCloudConfig(raw);
        return redactConfig(cfg);
      },
      getConfig: async () => redactConfig(await loadCloudConfig()),
      connect: async () => {
        const provider = createProviderFromConfig(await loadCloudConfig());
        return provider.connect();
      },
      runBackup: async ({
        password = null,
        plaintextAck = false,
        trigger = 'manual',
        collectOptions = null,
        useSessionPassword = true,
      } = {}) => {
        await loadCloudConfig(); // cfg unused
        return runCloudBackup({
          collectBackup: buildCloudBackupObject,
          onProgress: (m: string) => appendLog(`cloud: ${m}`),
          password,
          plaintextAck,
          trigger,
          collectOptions,
          useSessionPassword,
        } as any);
      },
      listBackups: () => listCloudBackups(),
      download: async (refId: string, { password = null } = {}) => {
        const refs = await listCloudBackups();
        const ref = refs.find((r: any) => r.id === refId);
        if (!ref) throw new TypedError('ERR_NOT_FOUND', `Backup "${refId}" not found remotely.`);
        const r = await downloadAndValidateBackup(ref, { password });
        return {
          text: r.text,
          sha256Hex: r.sha256Hex,
          encrypted: r.validation.encrypted,
          formatVersion: r.validation.backup.formatVersion,
          counts: r.validation.backup.counts,
          warnings: r.validation.warnings,
        };
      },
      restoreFromCloud: async (refId: string, { password = null, options = {} } = {}) => {
        const refs = await listCloudBackups();
        const ref = refs.find((r: any) => r.id === refId);
        if (!ref) throw new TypedError('ERR_NOT_FOUND', `Backup "${refId}" not found remotely.`);
        const { text } = await downloadAndValidateBackup(ref, { password });
        const validation = await validateBackupFile(text, { password });
        const results = await restoreAll(validation.backup, options);
        return { ok: true, results, counts: validation.backup.counts };
      },
      info: () => getCloudInfo(),
      cloudState: () => getCloudState(),
    },
    scheduler: {
      decide: async ({ now = null } = {}) => {
        const cfg: any = await loadCloudConfig();
        const st: any = await loadSchedulerState();
        return isBackupDue(cfg.schedule, st, now ? new Date(now) : new Date());
      },
      getState: () => loadSchedulerState(),
      setState: (s: any) => saveSchedulerState(s),
      setSchedule: async ({ enabled, hour, minute }: { enabled?: boolean; hour?: number; minute?: number } = {}) => {
        const cfg: any = await loadCloudConfig();
        cfg.schedule = { ...cfg.schedule, enabled: !!enabled, hour, minute };
        await saveCloudConfig(cfg);
        return redactConfig(cfg).schedule;
      },
      // Runs the scheduled backup only when the pure decision says it is due.
      // `now` is injectable for deterministic tests (production: real clock).
      runIfDue: async ({ now = null, collectOptions = null, password = null } = {}) => {
        const cfg: any = await loadCloudConfig();
        const st: any = await loadSchedulerState();
        const decision = isBackupDue(cfg.schedule, st, now ? new Date(now) : new Date());
        if (!decision.due) return { ran: false, ...decision };
        const result = await runCloudBackup({
          collectBackup: buildCloudBackupObject,
          onProgress: (m: string) => appendLog(`scheduled: ${m}`),
          password,
          useSessionPassword: !password,
          plaintextAck: cfg.encryption === 'disabled',
          trigger: 'scheduled',
          collectOptions,
        } as any);
        return { ran: true, decision, result };
      },
    },
    restoreFromText: async (text: string, { password = null, options = {} } = {}) => {
      const validation = await validateBackupFile(text, { password });
      const results = await restoreAll(validation.backup, options);
      return { validation, results };
    },
    // Seed helpers for the automated test suite (create test data through the
    // same public APIs a user interaction would use).
    seed: {
      createTab: (url: string, opts: any = {}) =>
        (chrome.tabs.create as any)({ url, active: false, ...opts }).then((t: any) => ({
          id: t.id,
          windowId: t.windowId,
          index: t.index,
        })),
      updateTab: (tabId: number, props: any) => chrome.tabs.update(tabId, props),
      createWindow: (urls: string[] = [], opts: any = {}) =>
        chrome.windows.create({ url: urls, focused: false, ...opts } as any).then((w2: any) => ({
          id: w2.id,
          state: w2.state,
          bounds: { left: w2.left, top: w2.top, width: w2.width, height: w2.height },
          tabs: (w2.tabs || []).map((t: any) => ({ id: t.id, index: t.index })),
        })),
      groupTabs: async (tabIds: number[], meta: any = {}) => {
        const gid = await (chrome.tabs as any).group({ tabIds });
        if (meta.title || meta.color)
          await chrome.tabGroups.update(gid, {
            title: meta.title || '',
            ...(meta.color ? { color: meta.color } : {}),
            ...(typeof meta.collapsed === 'boolean' ? { collapsed: meta.collapsed } : {}),
          });
        return gid;
      },
      addReadingListEntry: (entry: any) => chrome.readingList.addEntry(entry as any),
      addDownload: (url: string, filename: string) => chrome.downloads.download({ url, filename, saveAs: false }),
      listTabs: async () => {
        const tabs: any[] = await chrome.tabs.query({});
        return tabs
          .filter((t) => !t.url!.startsWith('chrome-extension://'))
          .map((t) => ({
            url: t.url,
            title: t.title,
            pinned: t.pinned,
            index: t.index,
            windowId: t.windowId,
            groupId: t.groupId,
          }));
      },
      listGroups: async () => chrome.tabGroups.query({}),
      // Seed partitioned (third-party iframe) storage: injects pagelib into all
      // frames of the top-level page, then writes data in every frame whose
      // origin matches framePrefix. Isolated-world storage APIs map to the same
      // origin-partitioned storage (research-proven).
      seedPartitionedFrame: async (
        topUrl: string,
        framePrefix: string,
        lsEntries: Record<string, string>,
        idbName: string,
        cacheName: string
      ) => {
        const all = await chrome.tabs.query({});
        const tab = all.find((t) => (t.url || '').startsWith(topUrl));
        if (!tab) return { error: 'host tab not open: ' + topUrl };
        await chrome.scripting.executeScript({
          target: { tabId: tab.id!, allFrames: true },
          files: ['lib/pagelib.js'],
        });
        return chrome.scripting.executeScript({
          target: { tabId: tab.id!, allFrames: true },
          func: (prefix: string, lsJson: string, idb: string, cache: string) => {
            if (window.top === window) return { main: true };
            if (!location.origin.startsWith(prefix)) return { skip: true, origin: location.origin };
            const ls: Record<string, string> = JSON.parse(lsJson);
            for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v);
            const out = { origin: location.origin, lsKeys: Object.keys(ls).length };
            const idbDone = new Promise((res) => {
              const rq = indexedDB.open(idb, 1);
              rq.onupgradeneeded = () => {
                if (!rq.result.objectStoreNames.contains('kv')) rq.result.createObjectStore('kv');
              };
              rq.onsuccess = () => {
                const db = rq.result;
                const tx = db.transaction('kv', 'readwrite');
                tx.objectStore('kv').put('part-value-1', 'k1');
                tx.objectStore('kv').put(new Uint8Array([9, 8, 7, 6]), 'k2');
                tx.oncomplete = () => {
                  db.close();
                  res(true);
                };
                tx.onerror = () => res(false);
              };
              rq.onerror = () => res(false);
            });
            const cacheDone = (async () => {
              try {
                const c = await caches.open(cache);
                await c.put(
                  '/part-asset',
                  new Response('partitioned-cache-body', { status: 200, headers: { 'x-part': '1' } })
                );
                return true;
              } catch (e) {
                return String(e);
              }
            })();
            return Promise.all([idbDone, cacheDone]).then(([idbOk, cacheOk]) => ({
              ...out,
              idb: idbOk,
              cache: cacheOk,
            }));
          },
          args: [framePrefix, JSON.stringify(lsEntries), idbName, cacheName],
        });
      },
      // Wipe partitioned storage of all frames of an open top-level page.
      wipePartitionedFrame: async (topUrl: string) => {
        const all = await chrome.tabs.query({});
        const tab = all.find((t) => (t.url || '').startsWith(topUrl));
        if (!tab) return { error: 'host tab not open: ' + topUrl };
        await chrome.scripting.executeScript({
          target: { tabId: tab.id!, allFrames: true },
          files: ['lib/pagelib.js'],
        });
        return chrome.scripting.executeScript({
          target: { tabId: tab.id!, allFrames: true },
          func: () => {
            if (window.top === window) return { main: true };
            return (async () => ({ origin: location.origin, out: await (window as any).__BBR.wipeSiteAll() }))();
          },
        });
      },
    },
  };
}
