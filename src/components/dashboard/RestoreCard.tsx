import { FileClock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useApp } from '@/dashboard/store';
import {
  handleFileSelected,
  toggleRestoreRow,
  setRestoreOption,
  cancelRestoreFlow,
  onRestoreGo,
} from '@/dashboard/logic';

function RestoreBadge({ restore }: { restore: 'full' | 'partial' | false }) {
  if (restore === 'full') return <Badge variant="success">restorable</Badge>;
  if (restore === 'partial') return <Badge variant="warning">partial</Badge>;
  return <Badge variant="danger">cannot restore: API limitation</Badge>;
}

export function RestoreCard() {
  const state = useApp();
  const { restore } = state;
  if (!restore.sectionVisible) return null;

  return (
    <Card id="section-restore">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <FileClock className="size-4 text-primary" />
          Restore backup
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!restore.summary && (
          <div className="grid gap-2">
            {restore.pickError && <div className="text-destructive text-sm">{restore.pickError}</div>}
            <p className="text-sm">Select a backup file (.json or encrypted .enc.json):</p>
            <Input
              key={restore.fileKey}
              id="restore-file"
              type="file"
              accept=".json,.enc,application/json"
              onChange={(ev) => {
                if (ev.target.files && ev.target.files[0]) void handleFileSelected(ev.target.files[0]);
              }}
            />
            <p className="text-muted-foreground text-xs">
              Everything happens locally — the file is parsed in this page, never uploaded.
            </p>
          </div>
        )}

        {restore.summary && !restore.progress.visible && (
          <div className="grid gap-3">
            <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Backup contains</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Category</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Restore</TableHead>
                  <TableHead>Include</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {restore.summary.rows.map((row) => (
                  <TableRow key={row.cat} title={row.note}>
                    <TableCell className="font-medium">{row.label}</TableCell>
                    <TableCell>{row.n}</TableCell>
                    <TableCell>
                      <RestoreBadge restore={row.restore} />
                    </TableCell>
                    <TableCell>
                      <Checkbox
                        data-cat={row.cat}
                        checked={row.checked}
                        disabled={row.disabled}
                        onCheckedChange={(v) => toggleRestoreRow(row.cat, v === true)}
                        aria-label={`Include ${row.label}`}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="grid gap-1">
              {restore.summary.encryptedNote && (
                <div className="text-sm text-emerald-700 dark:text-emerald-400">{restore.summary.encryptedNote}</div>
              )}
              {restore.summary.warnings.map((w) => (
                <div key={w} className="text-sm text-amber-700 dark:text-amber-400">
                  Warning: {w}
                </div>
              ))}
              {restore.summary.notes.length > 0 && (
                <ul className="text-muted-foreground list-disc pl-5 text-xs">
                  {restore.summary.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
            </div>

            <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Restore options</h3>
            <div className="grid gap-2">
              <Label htmlFor="opt-bm-replace" className="items-start">
                <Checkbox
                  id="opt-bm-replace"
                  checked={restore.summary.options.bm}
                  onCheckedChange={(v) => setRestoreOption('bm', v === true)}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  Bookmarks: <b>replace</b> existing Bookmarks bar &amp; Other bookmarks instead of merging
                  (destructive!)
                </span>
              </Label>
              <Label htmlFor="opt-sd-replace" className="items-start">
                <Checkbox
                  id="opt-sd-replace"
                  checked={restore.summary.options.sd}
                  onCheckedChange={(v) => setRestoreOption('sd', v === true)}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  Website data: <b>replace</b> — wipe each origin's site storage before restoring (destructive! default
                  is a non-destructive merge)
                </span>
              </Label>
              <Label htmlFor="opt-dl-redownload" className="items-start">
                <Checkbox
                  id="opt-dl-redownload"
                  checked={restore.summary.options.dl}
                  onCheckedChange={(v) => setRestoreOption('dl', v === true)}
                  className="mt-0.5"
                />
                <span className="text-sm">
                  Downloads: attempt to re-download completed items from their source URLs (network required; off by
                  default)
                </span>
              </Label>
            </div>

            <div className="mt-1 flex flex-wrap gap-2">
              <Button id="restore-go" onClick={() => void onRestoreGo()}>
                Restore
              </Button>
              <Button id="restore-cancel" variant="outline" onClick={cancelRestoreFlow}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {restore.progress.visible && (
          <div className="grid gap-2">
            <Progress value={Math.max(2, Math.min(100, Math.round(restore.progress.frac * 100)))} />
            <div id="restore-status" className="text-muted-foreground text-xs">
              {restore.progress.status}
            </div>
          </div>
        )}

        {restore.results.length > 0 && (
          <div className="grid gap-1">
            <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Restore results</h3>
            {restore.results.map((line) => (
              <div key={line.label} className="grid gap-0.5">
                <div
                  className={`text-sm ${line.cls === 'ok' ? 'text-emerald-700 dark:text-emerald-400' : line.cls === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-destructive'}`}
                >
                  {line.label}: {line.summary}
                </div>
                {line.notes.map((n) => (
                  <div key={n} className="text-muted-foreground pl-4 text-xs">
                    • {n}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
