import { Badge } from '@/components/ui/badge';
import { useApp } from '@/dashboard/store';
import { useSiteLog, useUnseenSiteLogError } from '@/dashboard/site-log-store';

const STATE_LABEL: Record<string, string> = {
  running: 'berjalan',
  stopping: 'sedang membersihkan…',
  stopped: 'dihentikan',
  done: 'selesai',
  fatal: 'fatal',
};

const STATE_COLOR: Record<string, string> = {
  running: 'bg-green-600',
  stopping: 'bg-amber-500',
  stopped: 'bg-amber-500',
  done: 'bg-blue-600',
  fatal: 'bg-red-600',
};

// Live crawl status bar: what is running right now. Shown at the top of the
// Log and Ringkasan pages. All data comes from the shared store (liveStats).
export function CrawlStatusBar() {
  const state = useApp();
  useSiteLog(); // re-render on new log entries (for unseen-error badge)
  const unseenFromStore = useUnseenSiteLogError();
  const scan = state.backup.siteScan;

  if (!scan) {
    return (
      <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
        Belum ada crawl berjalan. Jalankan backup dengan kategori website data.
      </div>
    );
  }

  const crawlState =
    (scan as any).crawlState || (scan.aborted > 0 ? 'fatal' : 'running');
  const worker1 = (scan as any).worker1 || '—';
  const worker2 = (scan as any).worker2 || '—';
  const logCounts = (scan as any).logCounts || {};
  const unseenError = unseenFromStore || !!(scan as any).logUnseenError;
  const info = logCounts.INFO || 0;
  const warn = logCounts.WARN || 0;
  const err = (logCounts.ERROR || 0) + (logCounts.FATAL || 0);

  // Per-stage URL counts from urlStates.
  const stageCounts: Record<string, number> = {};
  for (const u of scan.urlStates || [])
    stageCounts[u.status] = (stageCounts[u.status] || 0) + 1;

  return (
    <div className="grid gap-2 rounded-md border px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 font-semibold text-white ${STATE_COLOR[crawlState] || 'bg-gray-500'}`}
        >
          <span className="inline-block size-2 animate-pulse rounded-full bg-white" />
          {STATE_LABEL[crawlState] || crawlState}
        </span>
        {unseenError && (
          <Badge variant="danger" className="animate-pulse">
            ada ERROR/FATAL belum dilihat
          </Badge>
        )}
        <span className="text-muted-foreground">
          tab:{' '}
          <b className="text-foreground">
            {scan.slotsUsed}/{scan.slotsTotal}
          </b>{' '}
          · antrean:{' '}
          <b className="text-foreground">{(scan as any).queue ?? 0}</b> ·
          window: <b className="text-foreground">{scan.window}</b>
          {typeof (scan as any).cpuPct === 'number' && (
            <>
              {' '}
              · cpu:{' '}
              <b className="text-foreground">
                {Math.round((scan as any).cpuPct)}%
              </b>
            </>
          )}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>
          Worker 1: <b className="text-foreground">{worker1}</b>
        </span>
        <span>
          Worker 2: <b className="text-foreground">{worker2}</b>
        </span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <span>
          INFO: <b className="text-foreground">{info}</b>
        </span>
        <span className="text-amber-600 dark:text-amber-400">
          WARN: <b>{warn}</b>
        </span>
        <span className="text-red-600 dark:text-red-400">
          ERROR: <b>{err}</b>
        </span>
        {Object.entries(stageCounts).map(([st, n]) => (
          <span key={st} className="text-muted-foreground">
            {st}: <b className="text-foreground">{n}</b>
          </span>
        ))}
      </div>
    </div>
  );
}
