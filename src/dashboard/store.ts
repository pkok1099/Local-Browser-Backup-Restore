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

export type RestoreOptions = {
  bm: boolean; // bookmarks replace (destructive)
  sd: boolean; // site data replace (destructive)
  dl: boolean; // downloads redownload
};

export type RestoreSummary = {
  rows: RestoreRow[];
  encryptedNote: string | null;
  warnings: string[];
  notes: string[];
  options: RestoreOptions;
};

export type ResultLine = {
  label: string;
  cls: 'ok' | 'warn' | 'err';
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

// Live counters reported by the website-data scan workers (null when idle).
export type UrlStatus = 'pending' | 'fetching' | 'fetched' | 'saved' | 'fetch-failed' | 'save-failed' | 'skipped';
export type UrlState = {
  origin: string;
  status: UrlStatus;
  attempts: number;
  error: string | null;
};

export type SiteScanStats = {
  done: number; // SAVED origins only — fetched-but-unsaved is not counted as done
  fetched: number;
  failed: number;
  aborted: number;
  total: number;
  inGroup: number;
  slotsUsed: number;
  slotsTotal: number;
  queue: number; // slots waiting + tabs queued for reading
  cpuPct: number | null;
  window: number;
  windowMax: number;
  tuning: string | null;
  urlStates: UrlState[];
};

export type AppState = {
  subline: string;
  logLines: string[];
  backup: {
    visible: boolean;
    running: boolean;
    status: string;
    frac: number;
    summary: SummaryLine[];
    foldersNote: string | null;
    siteScan: SiteScanStats | null;
    downloadInfo?: { ready: boolean; siteCount: number; estBytes: number } | null;
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
    repoInfo: { account: string; fullName: string; isPublic: boolean; branch: string } | null;
    repoInfoError: string | null;
    form: CloudForm;
    retry: { syncVisible: boolean; syncLabel: string; status: string | null; cancelVisible: boolean };
    schedState: string;
    settingsStatus: string;
    remoteList: { loading: boolean; error: string | null; refs: RemoteRef[] } | null;
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
  backup: {
    visible: false,
    running: false,
    status: 'starting…',
    frac: 0,
    summary: [],
    foldersNote: null,
    siteScan: null,
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
    retry: { syncVisible: false, syncLabel: 'Retry pending upload', status: null, cancelVisible: false },
    schedState: '',
    settingsStatus: '',
    remoteList: null,
    settingsImportKey: 0,
  },
  caps: { visible: false, status: '', rows: [], probes: '…' },
};

let state: AppState = initialState;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
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
  state = { ...state, cloud: { ...state.cloud, form: { ...state.cloud.form, ...patch } } };
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
