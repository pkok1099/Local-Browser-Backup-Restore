// Tiny external store shared by the ported dashboard logic and the React UI.
// The original dashboard.js wrote straight into DOM nodes; during the WXT +
// shadcn migration the same logic functions now publish state here, and the
// React components subscribe. State shape mirrors the original UI structure so
// the port stays 1:1.
import { useSyncExternalStore } from 'react';

export type SummaryLine = {
  label: string;
  count: string;
  pill: 'full' | 'partial' | 'no' | 'error' | null;
};

export type RestoreRow = {
  cat: string;
  label: string;
  n: string;
  restore: 'full' | 'partial' | false;
  checked: boolean;
  disabled: boolean;
  note?: string;
};

type RestoreOptions = {
  bm: boolean; // bookmarks replace (destructive)
  sd: boolean; // site data replace (destructive)
  dl: boolean; // downloads redownload
  sdLive: boolean; // site data: write partitioned data into currently open tabs
};

type RestoreSummary = {
  rows: RestoreRow[];
  encryptedNote: string | null;
  warnings: string[];
  notes: string[];
  options: RestoreOptions;
};

export type ResultLine = {
  label: string;
  outcome:
    | 'complete'
    | 'partial'
    | 'failed'
    | 'unavailable'
    | 'skipped_by_user'
    | 'not_in_backup';
  outcomeCounts?: { succeeded: number; failed: number; skipped: number };
  summary: string;
  notes: string[];
};

export type CloudForm = {
  provider: string;
  token: string;
  owner: string;
  repo: string;
  branch: string;
  basePath: string;
  encryption: 'enabled' | 'disabled';
  autoRetryCloud: boolean;
  schedEnabled: boolean;
  frequency: 'daily' | 'weekly';
  weekdays: number[];
  time: string; // HH:MM
  rememberPw: boolean;
};

export type RemoteRef = {
  id: string;
  createdAt: string;
  sizeLabel: string;
  encrypted: boolean | null;
  formatVersion: number | null;
};

export type CapsRow = {
  cat: string;
  read: boolean;
  backup: boolean;
  restore: 'full' | 'partial' | false;
  notes: string;
};

export type DashboardActivityKind =
  | 'backup'
  | 'site-data-retry'
  | 'cloud-backup'
  | 'restore'
  | 'probes'
  | 'download'
  | 'clear-results'
  | 'clear-logs';

// Live counters reported by the website-data scan workers (null when idle).
export type UrlStatus =
  | 'pending'
  | 'fetching'
  | 'fetched'
  | 'saved'
  | 'fetch-failed'
  | 'save-failed'
  | 'skipped';
export type UrlState = {
  origin: string;
  status: UrlStatus;
  attempts: number;
  error: string | null;
};

// Failure-list predicate lives in src/lib so the node test suite can cover
// it (this module imports React and cannot run under plain node).
export { isFailedUrl, isRetryingUrl } from '@/lib/url-status';

export type SiteScanStats = {
  done: number; // SAVED origins only — fetched-but-unsaved is not counted as done
  fetched: number;
  failed: number;
  aborted: number;
  total: number;
  inGroup: number;
  inErrorGroup?: number;
  slotsUsed: number;
  slotsTotal: number;
  queue: number; // slots waiting + tabs queued for reading
  cpuPct: number | null;
  window: number;
  windowMax: number;
  tuning: string | null;
  logUnseenError?: boolean;
  urlStates: UrlState[];
};

export type AppState = {
  subline: string;
  logLines: string[];
  activeOperations: number;
  backup: {
    visible: boolean;
    running: boolean;
    status: string;
    frac: number;
    summary: SummaryLine[];
    foldersNote: string | null;
    siteScan: SiteScanStats | null;
    // Source of siteScan data: runId/timestamp from the snapshot persisted to
    // chrome.storage.local (bbr:last-site-scan). null means no snapshot exists yet.
    siteScanMeta: {
      runId: string;
      startedAt: number;
      completedAt: number | null;
    } | null;
    downloadInfo?: {
      ready: boolean;
      siteCount: number;
      estBytes: number;
    } | null;
  };
  password: {
    open: boolean;
    mode: 'new' | 'existing';
    error: string;
  };
  restore: {
    sectionVisible: boolean;
    pickError: string | null;
    fileKey: number;
    summary: RestoreSummary | null;
    progress: { visible: boolean; frac: number; status: string };
    results: ResultLine[];
  };
  cloud: {
    status: string;
    detail: string;
    progress: { visible: boolean; frac: number };
    repoInfo: {
      account: string;
      fullName: string;
      isPublic: boolean;
      branch: string;
    } | null;
    repoInfoError: string | null;
    form: CloudForm;
    retry: {
      syncVisible: boolean;
      syncLabel: string;
      status: string | null;
      cancelVisible: boolean;
    };
    schedState: string;
    settingsStatus: string;
    remoteList: {
      loading: boolean;
      error: string | null;
      refs: RemoteRef[];
    } | null;
    repoList: {
      loading: boolean;
      error: string | null;
      repos: Array<{
        owner: string;
        name: string;
        fullName: string;
        private: boolean;
        defaultBranch: string;
      }>;
      manual: boolean;
    } | null;
    branchList: {
      loading: boolean;
      error: string | null;
      branches: string[];
      manual: boolean;
    } | null;
    tokenValid: { account: string } | null;
    settingsImportKey: number;
  };
  caps: {
    visible: boolean;
    status: string;
    rows: CapsRow[];
    probes: string;
  };
};

const emptyForm: CloudForm = {
  provider: 'github',
  token: '',
  owner: '',
  repo: '',
  branch: '',
  basePath: 'browser-backups',
  encryption: 'enabled',
  autoRetryCloud: false,
  schedEnabled: false,
  frequency: 'daily',
  weekdays: [],
  time: '12:00',
  rememberPw: true,
};

const initialState: AppState = {
  subline: 'loading…',
  logLines: [],
  activeOperations: 0,
  backup: {
    visible: false,
    running: false,
    status: 'starting…',
    frac: 0,
    summary: [],
    foldersNote: null,
    siteScan: null,
    siteScanMeta: null,
  },
  password: { open: false, mode: 'new', error: '' },
  restore: {
    sectionVisible: false,
    pickError: null,
    fileKey: 0,
    summary: null,
    progress: { visible: false, frac: 0, status: 'starting…' },
    results: [],
  },
  cloud: {
    status: 'Not configured',
    detail: '',
    progress: { visible: false, frac: 0 },
    repoInfo: null,
    repoInfoError: null,
    form: { ...emptyForm },
    retry: {
      syncVisible: false,
      syncLabel: 'Retry pending upload',
      status: null,
      cancelVisible: false,
    },
    schedState: '',
    settingsStatus: '',
    remoteList: null,
    repoList: null,
    branchList: null,
    tokenValid: null,
    settingsImportKey: 0,
  },
  caps: { visible: false, status: '', rows: [], probes: '…' },
};

let state: AppState = initialState;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

const ACTIVITY_LOCK = 'bbr:dashboard-operation';
const localActivityIds = new Set<string>();
const remoteActivityIds = new Set<string>();
const activityPageId = Math.random().toString(36).slice(2);
let activitySequence = 0;
let lockQueryActive = false;
let lockQuerySequence = 0;
let activityEventGeneration = 0;
const activityChannel =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('bbr-dashboard-activity')
    : null;

function updateActivityCount() {
  const activeOperations =
    localActivityIds.size +
    remoteActivityIds.size +
    (lockQueryActive && !localActivityIds.size && !remoteActivityIds.size
      ? 1
      : 0);
  if (state.activeOperations === activeOperations) return;
  state = { ...state, activeOperations };
  emit();
}

async function refreshActivityFromLocks() {
  const sequence = ++lockQuerySequence;
  const eventGeneration = activityEventGeneration;
  if (typeof navigator === 'undefined' || !navigator.locks?.query) {
    if (sequence !== lockQuerySequence) return;
    lockQueryActive = false;
    updateActivityCount();
    return;
  }
  let active = true;
  try {
    const { held } = await navigator.locks.query();
    active = !held || held.some((lock) => lock.name === ACTIVITY_LOCK);
  } catch {
    // A failed query must remain fail-closed for Clear Results.
  }
  if (
    sequence !== lockQuerySequence ||
    eventGeneration !== activityEventGeneration
  )
    return;
  lockQueryActive = active;
  if (!active) remoteActivityIds.clear();
  updateActivityCount();
}

if (typeof window !== 'undefined') {
  activityChannel?.addEventListener('message', (event: MessageEvent) => {
    const message = event.data as {
      sourceId?: unknown;
      operationId?: unknown;
      active?: unknown;
    };
    if (
      typeof message?.sourceId !== 'string' ||
      message.sourceId === activityPageId ||
      typeof message.operationId !== 'string' ||
      typeof message.active !== 'boolean'
    ) {
      return;
    }
    activityEventGeneration += 1;
    const remoteId = `${message.sourceId}:${message.operationId}`;
    if (message.active) remoteActivityIds.add(remoteId);
    else {
      remoteActivityIds.delete(remoteId);
      lockQueryActive = false;
    }
    updateActivityCount();
  });
  void refreshActivityFromLocks();
  window.addEventListener('focus', () => void refreshActivityFromLocks());
  document.addEventListener(
    'visibilitychange',
    () => void refreshActivityFromLocks()
  );
}

export function hasUnresolvedSiteScan(
  siteScan: AppState['backup']['siteScan']
): boolean {
  return !!siteScan?.urlStates.some((url) =>
    ['pending', 'fetching', 'fetched', 'fetch-failed', 'save-failed'].includes(
      url.status
    )
  );
}

export async function withDashboardActivity<T>(
  kind: DashboardActivityKind,
  operation: () => Promise<T>
): Promise<T> {
  const operationId = `${activityPageId}:${++activitySequence}:${kind}`;
  localActivityIds.add(operationId);
  updateActivityCount();
  let announced = false;
  try {
    const locks =
      typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks?.request) {
      if (kind === 'clear-results' || kind === 'clear-logs') {
        throw new Error(
          'Web Locks are unavailable; clearing is disabled for safety.'
        );
      }
      return await operation();
    }
    return await locks.request(
      ACTIVITY_LOCK,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) throw new Error('Dashboard is busy with another operation.');
        activityChannel?.postMessage({
          sourceId: activityPageId,
          operationId,
          active: true,
        });
        announced = !!activityChannel;
        return operation();
      }
    );
  } finally {
    localActivityIds.delete(operationId);
    lockQueryActive = false;
    updateActivityCount();
    if (announced)
      activityChannel?.postMessage({
        sourceId: activityPageId,
        operationId,
        active: false,
      });
    void refreshActivityFromLocks();
  }
}

export function getState(): AppState {
  return state;
}

export function setState(
  patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)
) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  emit();
}

export function patchState<K extends keyof AppState>(
  key: K,
  patch: Partial<AppState[K]> | ((s: AppState[K]) => AppState[K])
) {
  const cur = state[key];
  const next =
    typeof patch === 'function'
      ? (patch as (s: AppState[K]) => AppState[K])(cur)
      : ({ ...(cur as object), ...(patch as object) } as AppState[K]);
  state = { ...state, [key]: next };
  emit();
}

export function updateForm(patch: Partial<CloudForm>) {
  state = {
    ...state,
    cloud: { ...state.cloud, form: { ...state.cloud.form, ...patch } },
  };
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useApp(): AppState {
  return useSyncExternalStore(subscribe, getState, getState);
}

// appendLog — mirrors the original log(): timestamped lines, capped buffer,
// newest at the bottom.
export function appendLog(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg}`;
  const lines = [...state.logLines, line].slice(-400);
  state = { ...state, logLines: lines };
  emit();
}
