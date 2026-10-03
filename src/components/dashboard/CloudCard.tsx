import {
  Cloud,
  KeyRound,
  RefreshCw,
  Save,
  Download,
  Upload,
  XCircle,
  RotateCcw,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useApp, updateForm } from '@/dashboard/store';
import {
  onCloudConnect,
  onCloudBackupNow,
  onCloudRestore,
  onCloudRestorePick,
  onCloudDeletePick,
  onRetrySync,
  onCancelRetry,
  exportSettingsFile,
  importSettingsFile,
  saveCloudSettings,
  onScheduleFieldChange,
  onAutoRetryChange,
  CLOUD_STATUS_TEXT,
} from '@/dashboard/cloud-ui';

const WEEKDAY_LABELS: Array<{ day: number; label: string }> = [
  { day: 1, label: 'Monday' },
  { day: 2, label: 'Tuesday' },
  { day: 3, label: 'Wednesday' },
  { day: 4, label: 'Thursday' },
  { day: 5, label: 'Friday' },
  { day: 6, label: 'Saturday' },
  { day: 0, label: 'Sunday' },
];

function FieldsetLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
      {children}
    </div>
  );
}

export function CloudCard() {
  const state = useApp();
  const { cloud } = state;
  const form = cloud.form;
  const isPublic = cloud.repoInfo?.isPublic === true;
  const remoteReady = form.provider === 'github';
  const weekly = form.frequency === 'weekly';

  return (
    <Card id="section-cloud">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <Cloud className="size-4 text-primary" />
          Cloud backup
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div
          id="cloud-status"
          className="text-muted-foreground text-sm"
          aria-live="polite"
        >
          {cloud.status}
        </div>

        {/* provider */}
        <Label htmlFor="cloud-provider">
          Provider
          <Select
            value={form.provider}
            onValueChange={(v) => updateForm({ provider: v })}
          >
            <SelectTrigger id="cloud-provider" className="w-full max-w-sm">
              <SelectValue placeholder="Choose a provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="github">GitHub</SelectItem>
              <SelectItem value="local">
                This browser (local durable copy)
              </SelectItem>
              <SelectItem value="webdav" disabled>
                WebDAV — not implemented in this version
              </SelectItem>
              <SelectItem value="gdrive" disabled>
                Google Drive — not implemented in this version
              </SelectItem>
            </SelectContent>
          </Select>
        </Label>

        {/* github config */}
        {form.provider === 'github' && (
          <div id="cloud-github-config" className="grid gap-3">
            <Label htmlFor="gh-token">
              Personal access token
              <Input
                id="gh-token"
                type="password"
                autoComplete="off"
                placeholder="saved — type a new one to replace it"
                value={form.token}
                onChange={(e) => updateForm({ token: e.target.value })}
              />
            </Label>
            <Label htmlFor="gh-owner">
              Owner
              <Input
                id="gh-owner"
                type="text"
                placeholder="your-github-user"
                value={form.owner}
                onChange={(e) => updateForm({ owner: e.target.value })}
              />
            </Label>
            <Label htmlFor="gh-repo">
              Repository
              <Input
                id="gh-repo"
                type="text"
                placeholder="browser-backups"
                value={form.repo}
                onChange={(e) => updateForm({ repo: e.target.value })}
              />
            </Label>
            <Label htmlFor="gh-branch">
              Branch
              <Input
                id="gh-branch"
                type="text"
                placeholder="repository default branch (e.g. main)"
                value={form.branch}
                onChange={(e) => updateForm({ branch: e.target.value })}
              />
            </Label>
            <Label htmlFor="gh-path">
              Backup path
              <Input
                id="gh-path"
                type="text"
                value={form.basePath}
                onChange={(e) => updateForm({ basePath: e.target.value })}
              />
            </Label>
            <div>
              <Button
                id="cloud-connect"
                variant="outline"
                onClick={() => void onCloudConnect()}
              >
                Connect &amp; check repository
              </Button>
            </div>
            <div id="cloud-repo-info" className="text-muted-foreground text-sm">
              {cloud.repoInfoError && (
                <span className="text-destructive">{cloud.repoInfoError}</span>
              )}
              {cloud.repoInfo && (
                <span>
                  Connected as <b>{cloud.repoInfo.account}</b> — repository{' '}
                  <b>{cloud.repoInfo.fullName}</b> is{' '}
                  <b>{cloud.repoInfo.isPublic ? 'PUBLIC' : 'private'}</b>,
                  default branch <b>{cloud.repoInfo.branch}</b>.
                </span>
              )}
            </div>
          </div>
        )}

        <Separator />

        {/* encryption */}
        <div className="grid gap-2">
          <FieldsetLabel>Encryption</FieldsetLabel>
          <RadioGroup
            value={form.encryption}
            onValueChange={(v) =>
              updateForm({ encryption: v as 'enabled' | 'disabled' })
            }
            className="gap-2"
          >
            <Label
              htmlFor="cloud-enc-enabled"
              className="items-start font-normal"
            >
              <RadioGroupItem
                id="cloud-enc-enabled"
                value="enabled"
                className="mt-0.5"
              />
              <span className="text-sm">
                Enabled — recommended (browser backups contain cookies and
                session material)
              </span>
            </Label>
            <Label
              htmlFor="cloud-enc-disabled"
              className="items-start font-normal"
            >
              <RadioGroupItem
                id="cloud-enc-disabled"
                value="disabled"
                disabled={isPublic}
                className="mt-0.5"
              />
              <span className="text-sm">
                Disabled — store a plaintext backup (private repository only;
                requires explicit confirmation)
              </span>
            </Label>
          </RadioGroup>
          {isPublic && (
            <div
              id="cloud-enc-public"
              className="text-sm text-amber-700 dark:text-amber-400"
            >
              This repository is PUBLIC — encryption is required for every
              upload and cannot be disabled.
            </div>
          )}
          {!isPublic && form.encryption === 'disabled' && (
            <div id="cloud-enc-warn" className="text-muted-foreground text-xs">
              Private does not mean safe to store plaintext: anyone who gains
              access to that repository (or to your token) could read the
              backup, which contains authentication/session material.
            </div>
          )}
        </div>

        <Separator />

        {/* cloud retry */}
        <div className="grid gap-2">
          <FieldsetLabel>Cloud retry</FieldsetLabel>
          <Label htmlFor="cloud-auto-retry" className="items-start font-normal">
            <Checkbox
              id="cloud-auto-retry"
              checked={form.autoRetryCloud}
              onCheckedChange={(v) => void onAutoRetryChange(v === true)}
              className="mt-0.5"
            />
            <span className="text-sm">
              Automatically retry failed uploads with exponential backoff (1, 2,
              4… minutes; up to 8 retries)
            </span>
          </Label>
          <div className="text-muted-foreground text-xs">
            When enabled, a temporary local copy is kept until the cloud upload
            succeeds.
          </div>
        </div>

        <Separator />

        {/* schedule */}
        <div className="grid gap-2">
          <FieldsetLabel>Schedule — automatic backup</FieldsetLabel>
          <Label htmlFor="sched-enabled" className="items-start font-normal">
            <Checkbox
              id="sched-enabled"
              checked={form.schedEnabled}
              onCheckedChange={(v) =>
                void onScheduleFieldChange({ schedEnabled: v === true })
              }
              className="mt-0.5"
            />
            <span className="text-sm">
              {weekly
                ? 'Automatic backup on selected days'
                : 'Automatic backup daily'}
            </span>
          </Label>
          <Label htmlFor="sched-frequency">
            Frequency
            <Select
              value={form.frequency}
              onValueChange={(v) =>
                void onScheduleFieldChange({
                  frequency: v as 'daily' | 'weekly',
                })
              }
            >
              <SelectTrigger id="sched-frequency" className="w-40">
                <SelectValue placeholder="Frequency" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
              </SelectContent>
            </Select>
          </Label>
          {!weekly && <input type="hidden" id="sched-weekdays-hidden" />}
          {weekly && (
            <div
              id="sched-weekdays"
              className="flex flex-wrap gap-x-4 gap-y-1"
              aria-label="Backup weekdays"
            >
              {WEEKDAY_LABELS.map(({ day, label }) => (
                <Label
                  key={day}
                  htmlFor={`sched-weekday-${day}`}
                  className="font-normal"
                >
                  <Checkbox
                    id={`sched-weekday-${day}`}
                    data-weekday={day}
                    checked={form.weekdays.includes(day)}
                    onCheckedChange={(v) => {
                      const next =
                        v === true
                          ? [...form.weekdays, day].sort((a, b) => a - b)
                          : form.weekdays.filter((d) => d !== day);
                      void onScheduleFieldChange({ weekdays: next });
                    }}
                  />
                  {label}
                </Label>
              ))}
            </div>
          )}
          <Label htmlFor="sched-time">
            Time
            <Input
              id="sched-time"
              type="time"
              value={form.time}
              onChange={(e) =>
                void onScheduleFieldChange({ time: e.target.value })
              }
              className="w-32"
            />
          </Label>
          <Label
            htmlFor="sched-remember-pw"
            className="items-start font-normal"
          >
            <Checkbox
              id="sched-remember-pw"
              checked={form.rememberPw}
              onCheckedChange={(v) => updateForm({ rememberPw: v === true })}
              className="mt-0.5"
            />
            <span className="text-muted-foreground text-sm">
              Keep the encryption password in memory for scheduled runs (cleared
              when the browser closes; never written to disk, never uploaded)
            </span>
          </Label>
          <div id="sched-state" className="text-muted-foreground text-xs">
            {cloud.schedState}
          </div>
        </div>

        {/* actions */}
        <div className="mt-1 flex flex-wrap gap-2">
          <Button
            id="cloud-only-backup"
            variant="outline"
            disabled={!remoteReady}
            onClick={() => void onCloudBackupNow('manual', 'cloud-only')}
          >
            Cloud only
          </Button>
          <Button
            id="cloud-backup-now"
            disabled={!remoteReady}
            onClick={() => void onCloudBackupNow('manual', 'both')}
          >
            Both: download + cloud
          </Button>
          <Button
            id="cloud-restore"
            variant="outline"
            onClick={() => void onCloudRestore()}
          >
            Restore Backup
          </Button>
          <Button
            id="cloud-save"
            variant="outline"
            onClick={() => void saveCloudSettings()}
          >
            <Save className="size-4" />
            Save settings
          </Button>
          {!cloud.retry.syncVisible ? null : (
            <Button
              id="cloud-retry-sync"
              variant="outline"
              onClick={() => void onRetrySync()}
            >
              <RotateCcw className="size-4" />
              {cloud.retry.syncLabel}
            </Button>
          )}
          {!cloud.retry.cancelVisible ? null : (
            <Button
              id="cloud-retry-cancel"
              variant="destructive"
              onClick={() => void onCancelRetry()}
            >
              <XCircle className="size-4" />
              Cancel automatic retries
            </Button>
          )}
        </div>

        {/* retry status */}
        <div
          id="cloud-retry-status"
          className={
            cloud.retry.status ? 'text-muted-foreground text-xs' : 'hidden'
          }
          aria-live="polite"
        >
          {cloud.retry.status ?? ''}
        </div>

        {/* settings transfer */}
        <div className="grid gap-2">
          <FieldsetLabel>Settings transfer</FieldsetLabel>
          <div className="flex flex-wrap gap-2">
            <Button
              id="settings-export"
              variant="outline"
              onClick={() => void exportSettingsFile()}
            >
              <Download className="size-4" />
              Export settings (without token)
            </Button>
            <Label
              htmlFor="settings-import-file"
              className="min-w-[220px] flex-1 flex-col items-stretch gap-1"
            >
              <span className="text-sm">Import settings file</span>
              <Input
                key={cloud.settingsImportKey}
                id="settings-import-file"
                type="file"
                accept="application/json,.json"
                onChange={(event) =>
                  void importSettingsFile(event.target.files?.[0] || null)
                }
              />
            </Label>
          </div>
          <div
            id="settings-status"
            className="text-muted-foreground text-xs"
            aria-live="polite"
          >
            {cloud.settingsStatus}
          </div>
        </div>

        {/* progress */}
        {cloud.progress.visible && (
          <div id="cloud-progress" className="mt-1 grid gap-2">
            <Progress
              value={Math.max(
                2,
                Math.min(100, Math.round(cloud.progress.frac * 100))
              )}
            />
            <div
              id="cloud-status-detail"
              className="text-muted-foreground text-xs"
            >
              {cloud.detail}
            </div>
          </div>
        )}

        {/* remote list */}
        <div id="cloud-list" className="mt-2">
          {cloud.remoteList?.loading && (
            <div className="text-muted-foreground text-sm">
              listing remote backups…
            </div>
          )}
          {cloud.remoteList?.error && (
            <div className="text-destructive text-sm">
              {cloud.remoteList.error}
            </div>
          )}
          {cloud.remoteList &&
            !cloud.remoteList.loading &&
            !cloud.remoteList.error &&
            cloud.remoteList.refs.length === 0 && (
              <div className="text-muted-foreground text-sm">
                No remote backups found.
              </div>
            )}
          {cloud.remoteList &&
            !cloud.remoteList.loading &&
            !cloud.remoteList.error &&
            cloud.remoteList.refs.length > 0 && (
              <div className="grid gap-1.5">
                <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                  Remote backups
                </h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>ID</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Format</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cloud.remoteList.refs.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-mono text-xs">
                          {r.id}
                        </TableCell>
                        <TableCell className="text-xs">{r.createdAt}</TableCell>
                        <TableCell className="text-xs">{r.sizeLabel}</TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-1.5">
                            {r.encrypted === true && (
                              <Badge variant="success">encrypted</Badge>
                            )}
                            {r.encrypted === false && (
                              <Badge variant="warning">plaintext</Badge>
                            )}
                            {r.encrypted === null && (
                              <span className="text-muted-foreground text-xs">
                                unknown
                              </span>
                            )}
                            {r.formatVersion ? (
                              <span className="text-muted-foreground text-xs">
                                v{r.formatVersion}
                              </span>
                            ) : (
                              <span className="text-muted-foreground text-xs">
                                —
                              </span>
                            )}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="inline-flex gap-1.5">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void onCloudRestorePick(r.id)}
                            >
                              <Upload className="size-3.5" />
                              Restore
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => void onCloudDeletePick(r.id)}
                            >
                              Delete
                            </Button>
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
        </div>

        {/* policy note */}
        <div className="text-muted-foreground flex items-start gap-1.5 text-[11px]">
          <KeyRound className="mt-0.5 size-3 shrink-0" />
          <span>
            {CLOUD_STATUS_TEXT['public-requires-encryption'] !== '' &&
              'The token is sent only to api.github.com. Passwords never leave this device. Public repositories only ever receive encrypted backups — enforced below the UI.'}
          </span>
          <RefreshCw className="hidden size-3" />
        </div>
      </CardContent>
    </Card>
  );
}
