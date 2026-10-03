import { appendLog, withDashboardActivity } from './store';

type UnknownRecord = Record<string, unknown>;
type BackupCounts = Record<string, number | string | undefined>;
type ProgressHandler = (message: string, category?: string, state?: string, fraction?: number, stats?: unknown) => void;
type SiteDataOptions = UnknownRecord & {
  includeOrigins?: string[] | null;
  scanWindowSize?: number | null;
  retryMaxAttempts?: number;
  readTimeoutMs?: number;
  checkpointEveryOrigins?: number;
  tuning?: {
    retryMaxAttempts?: number;
    readTimeoutMs?: number;
    checkpointEveryOrigins?: number;
  };
};
type CollectOptions = UnknownRecord & {
  selectedCategories?: string[];
  siteData?: SiteDataOptions;
};
type CapabilityDetail = {
  available?: boolean;
  canRead?: boolean;
  canBackup?: boolean;
  canRestore?: 'full' | 'partial' | false;
  notes?: string[];
};
type CategoryStatus = { ok: boolean; skipped?: boolean; error?: string; stack?: string };
type CollectionResult = {
  data: Record<string, unknown>;
  counts: BackupCounts;
  capabilities: Record<string, CapabilityDetail | undefined>;
  categoryStatus: Record<string, CategoryStatus | undefined>;
};
type BackupObject = UnknownRecord & {
  data?: Record<string, unknown>;
  counts?: BackupCounts;
  formatVersion?: number;
  integrity?: { digest?: string } | null;
};
type BuildBackupResult = {
  backup: BackupObject;
  categoryStatus: Record<string, CategoryStatus | undefined>;
};
type RestoreCategoryOptions = {
  enabled?: boolean;
  unavailable?: boolean;
  mode?: 'merge' | 'replace' | 'redownload' | 'metadata-only';
  confirmDestructive?: boolean;
};
type RestoreOptions = Record<string, RestoreCategoryOptions>;
type RestoreCategoryResult = {
  status: string;
  outcome: 'complete' | 'partial' | 'failed' | 'unavailable' | 'skipped_by_user' | 'not_in_backup';
  summary: string;
  stats?: {
    notes?: string[];
    outcomeCounts?: { succeeded: number; failed: number; skipped: number };
  };
};
type RestoreResults = Record<string, RestoreCategoryResult>;
type ValidationResult = {
  backup: BackupObject;
  warnings?: string[];
  encrypted: boolean;
  envelopeMeta?: UnknownRecord | null;
};
type PasswordOptions = { password?: string | null };
type CloudRestoreOptions = PasswordOptions & { options?: RestoreOptions };
type RunCloudBackupOptions = PasswordOptions & {
  plaintextAck?: boolean;
  trigger?: 'manual' | 'scheduled';
  collectOptions?: CollectOptions | null;
  useSessionPassword?: boolean;
};
type CloudBackupResult = {
  ok: true;
  artifactId: string;
  sizeBytes?: number;
  sha256Hex: string;
  encrypted: boolean;
  localDownload?: string | null;
  localDownloadError?: string | null;
  upload: UnknownRecord & { verified?: boolean; sha256Hex?: string };
  synced: boolean;
};
type CloudBackupRef = UnknownRecord & {
  id: string;
  filename?: string;
  integrity?: { digest?: string };
};
type CloudDownloadResult = {
  text: string;
  sha256Hex: string;
  validation: ValidationResult;
};
type CloudRunOperation = (options: {
  collectBackup: (onProgress?: (message: string) => void, options?: CollectOptions | null) => Promise<BackupObject>;
  onProgress: (message: string) => void;
  password?: string | null;
  useSessionPassword?: boolean;
  plaintextAck?: boolean;
  trigger?: 'manual' | 'scheduled';
  collectOptions?: CollectOptions | null;
}) => Promise<CloudBackupResult>;
type CloudDownloadOperation = (ref: CloudBackupRef, options?: PasswordOptions) => Promise<CloudDownloadResult>;
type CloudDownloadSummary = {
  text: string;
  sha256Hex: string;
  encrypted: boolean;
  formatVersion: number | undefined;
  counts: BackupCounts | undefined;
  warnings: string[] | undefined;
};
type CloudRestoreResult = {
  ok: true;
  results: RestoreResults;
  counts: BackupCounts | undefined;
};
type ScheduleReason =
  | 'disabled'
  | 'not-scheduled-today'
  | 'before-today'
  | 'already-succeeded-today'
  | 'retry-backoff'
  | 'scheduled-due'
  | 'catch-up';
type BackupDecision =
  | { due: false; reason: Exclude<ScheduleReason, 'scheduled-due' | 'catch-up'> }
  | { due: true; reason: 'scheduled-due' | 'catch-up' };
type RunIfDueOptions = PasswordOptions & {
  now?: string | null;
  collectOptions?: CollectOptions | null;
};
type RunIfDueResult =
  | { ran: false; due: false; reason: Exclude<ScheduleReason, 'scheduled-due' | 'catch-up'> }
  | { ran: true; decision: Extract<BackupDecision, { due: true }>; result: CloudBackupResult };
type CloudConfig = { schedule: UnknownRecord; encryption?: string };
type SchedulerState = UnknownRecord;
type RestoreFromTextResult = { validation: ValidationResult; results: RestoreResults };

export const probe = (): Promise<UnknownRecord> =>
  withDashboardActivity(
    'probes',
    async () => (await (await import('@/lib/capabilities')).runProbes()) as unknown as UnknownRecord
  );

export const collectAll = (
  onProgress: ProgressHandler | null,
  options: CollectOptions | null
): Promise<CollectionResult> =>
  withDashboardActivity('backup', async () => {
    const { collectAll } = await import('@/lib/collect');
    return (await collectAll(onProgress, options)) as unknown as CollectionResult;
  });

export const buildBackupObject = (
  onProgress?: (message: string) => void,
  collectOptions?: CollectOptions | null
): Promise<BuildBackupResult> =>
  withDashboardActivity('backup', async () => (await import('./logic')).buildBackupObject(onProgress, collectOptions));

export const runCloudBackup = (options: RunCloudBackupOptions = {}): Promise<CloudBackupResult> =>
  withDashboardActivity('cloud-backup', async () => {
    const [cloud, logic] = await Promise.all([import('@/lib/cloud'), import('./logic')]);
    await cloud.loadCloudConfig();
    const run = cloud.runCloudBackup as unknown as CloudRunOperation;
    return await run({
      collectBackup: logic.buildCloudBackupObject,
      onProgress: (message: string) => appendLog(`cloud: ${message}`),
      password: options.password ?? null,
      plaintextAck: options.plaintextAck ?? false,
      trigger: options.trigger ?? 'manual',
      collectOptions: options.collectOptions ?? null,
      useSessionPassword: options.useSessionPassword ?? true,
    });
  });

export const downloadCloudBackup = (refId: string, options: PasswordOptions = {}): Promise<CloudDownloadSummary> =>
  withDashboardActivity('download', async () => {
    const [{ listCloudBackups, downloadAndValidateBackup }, { TypedError }] = await Promise.all([
      import('@/lib/cloud'),
      import('@/lib/util'),
    ]);
    const refs = (await listCloudBackups()) as CloudBackupRef[];
    const ref = refs.find((item) => item.id === refId);
    if (!ref) throw new TypedError('ERR_NOT_FOUND', `Backup "${refId}" not found remotely.`);
    const download = downloadAndValidateBackup as unknown as CloudDownloadOperation;
    const result = await download(ref, { password: options.password ?? null });
    return {
      text: result.text,
      sha256Hex: result.sha256Hex,
      encrypted: result.validation.encrypted,
      formatVersion: result.validation.backup.formatVersion,
      counts: result.validation.backup.counts,
      warnings: result.validation.warnings,
    };
  });

export const restoreFromCloud = (refId: string, options: CloudRestoreOptions = {}): Promise<CloudRestoreResult> =>
  withDashboardActivity('restore', async () => {
    const [{ listCloudBackups, downloadAndValidateBackup }, { validateBackupFile }, { restoreAll }, { TypedError }] =
      await Promise.all([
        import('@/lib/cloud'),
        import('@/lib/validate'),
        import('@/lib/restore'),
        import('@/lib/util'),
      ]);
    const refs = (await listCloudBackups()) as CloudBackupRef[];
    const ref = refs.find((item) => item.id === refId);
    if (!ref) throw new TypedError('ERR_NOT_FOUND', `Backup "${refId}" not found remotely.`);
    const download = downloadAndValidateBackup as unknown as CloudDownloadOperation;
    const { text } = await download(ref, { password: options.password ?? null });
    const validation = (await validateBackupFile(text, { password: options.password ?? null })) as ValidationResult;
    const results = (await restoreAll(validation.backup, options.options ?? {})) as RestoreResults;
    return { ok: true, results, counts: validation.backup.counts };
  });

export const runIfDue = async (options: RunIfDueOptions = {}): Promise<RunIfDueResult> => {
  const [cloud, scheduler, logic] = await Promise.all([
    import('@/lib/cloud'),
    import('@/lib/scheduler'),
    import('./logic'),
  ]);
  const config = (await cloud.loadCloudConfig()) as CloudConfig;
  const state = (await scheduler.loadSchedulerState()) as SchedulerState;
  const decision = scheduler.isBackupDue(
    config.schedule,
    state,
    options.now ? new Date(options.now) : new Date()
  ) as BackupDecision;
  if (!decision.due) return { ran: false, ...decision };
  const result = await withDashboardActivity('cloud-backup', () =>
    (cloud.runCloudBackup as unknown as CloudRunOperation)({
      collectBackup: logic.buildCloudBackupObject,
      onProgress: (message: string) => appendLog(`scheduled: ${message}`),
      password: options.password ?? null,
      useSessionPassword: !options.password,
      plaintextAck: config.encryption === 'disabled',
      trigger: 'scheduled',
      collectOptions: options.collectOptions ?? null,
    })
  );
  return { ran: true, decision, result };
};

export const restoreFromText = (text: string, options: CloudRestoreOptions = {}): Promise<RestoreFromTextResult> =>
  withDashboardActivity('restore', async () => {
    const [{ validateBackupFile }, { restoreAll }] = await Promise.all([
      import('@/lib/validate'),
      import('@/lib/restore'),
    ]);
    const validation = (await validateBackupFile(text, { password: options.password ?? null })) as ValidationResult;
    const results = (await restoreAll(validation.backup, options.options ?? {})) as RestoreResults;
    return { validation, results };
  });
