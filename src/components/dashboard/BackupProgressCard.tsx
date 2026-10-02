import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useApp } from '@/dashboard/store';
import { requestBackupStop } from '@/dashboard/logic';

export function BackupProgressCard() {
  const state = useApp();
  const { backup } = state;
  if (!backup.visible) return null;
  const crawlState = (backup.siteScan as any)?.crawlState;
  const isStopping = crawlState === 'stopping';

  return (
    <Card id="section-backup">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-[15px]">Creating backup</CardTitle>
        {backup.running && (
          <Button variant="destructive" size="sm" onClick={() => requestBackupStop()} disabled={isStopping}>
            {isStopping ? 'Membersihkan…' : 'Stop'}
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-2.5">
        <Progress value={Math.max(2, Math.min(100, Math.round(backup.frac * 100)))} />
        <div
          className={`text-xs ${backup.status.includes('ABORTED') ? 'font-semibold text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}
        >
          {backup.status}
        </div>
        {backup.siteScan && (
          <div
            id="site-scan-counters"
            className="flex flex-wrap gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5 text-xs"
          >
            <span>
              tabs in group: <b>{backup.siteScan.inGroup}</b>
            </span>
            <span>
              slots:{' '}
              <b>
                {backup.siteScan.slotsUsed}/{backup.siteScan.slotsTotal}
              </b>
            </span>
            <span>
              queue: <b>{backup.siteScan.queue ?? 0}</b>
            </span>
            <span>
              saved:{' '}
              <b>
                {backup.siteScan.done}/{backup.siteScan.total}
              </b>
            </span>
            <span>
              fetched: <b>{backup.siteScan.fetched ?? 0}</b>
            </span>
            <span>
              failed: <b>{backup.siteScan.failed}</b>
            </span>
            {(backup.siteScan as any).failedPool > 0 && (
              <span>
                failed pool: <b>{(backup.siteScan as any).failedPool}</b>
              </span>
            )}
            {(backup.siteScan as any).skipped > 0 && (
              <span>
                skipped: <b>{(backup.siteScan as any).skipped}</b>
              </span>
            )}
            {backup.siteScan.aborted > 0 && (
              <span className="font-semibold text-red-600 dark:text-red-400">
                aborted: <b>{backup.siteScan.aborted}</b>
              </span>
            )}
            <span>
              window: <b>{backup.siteScan.window}</b>{' '}
              <span className="opacity-75">(setting: {backup.siteScan.windowMax})</span>
            </span>
            {typeof backup.siteScan.cpuPct === 'number' && (
              <span>
                cpu: <b>{Math.round(backup.siteScan.cpuPct)}%</b>
              </span>
            )}
          </div>
        )}
        {backup.siteScan?.tuning && (
          <div className="text-muted-foreground px-2.5 text-[11px]">tuning: {backup.siteScan.tuning}</div>
        )}
        {backup.summary.length > 0 && (
          <div className="mt-1 grid gap-1">
            <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Backup completed</h3>
            {backup.summary.map((line) => (
              <div key={line.label} className="flex flex-wrap items-center gap-1.5 text-sm">
                <span>{line.label}:</span>
                <b>{line.count}</b>
                {line.pill === 'full' && <Badge variant="success">restorable</Badge>}
                {line.pill === 'partial' && <Badge variant="warning">partially restorable</Badge>}
                {line.pill === 'no' && <Badge variant="danger">cannot restore: API limitation</Badge>}
                {line.pill === 'error' && <Badge variant="danger">GAGAL (error)</Badge>}
              </div>
            ))}
            {backup.foldersNote && <div className="text-muted-foreground text-sm">{backup.foldersNote}</div>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
