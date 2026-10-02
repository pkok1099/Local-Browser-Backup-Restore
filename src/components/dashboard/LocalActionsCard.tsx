import { HardDriveDownload, Undo2, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { appendLog, patchState } from '@/dashboard/store';

export function LocalActionsCard() {
  return (
    <Card id="section-local-actions">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <HardDriveDownload className="size-4 text-primary" />
          Local backup and restore
        </CardTitle>
        <CardDescription>Backup files stay on this device unless you choose a cloud provider below.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button
          id="local-backup"
          onClick={() => void import('@/dashboard/logic').then(({ doBackup }) => doBackup({ encrypt: false }))}
        >
          Local only — plain
        </Button>
        <Button
          id="local-backup-encrypted"
          onClick={async () => {
            const { askPassword, doBackup } = await import('@/dashboard/logic');
            const password = await askPassword('new');
            if (password) await doBackup({ encrypt: true, password });
          }}
        >
          Local only — encrypted
        </Button>
        <Button
          id="local-restore"
          variant="outline"
          onClick={() => {
            patchState('restore', (r) => ({ ...r, sectionVisible: true, pickError: null }));
            appendLog('restore: choose a backup file');
            window.location.hash = '#/lainnya'; // RestoreCard lives on the Lainnya page
            requestAnimationFrame(() => document.getElementById('restore-file')?.focus());
          }}
        >
          <Undo2 className="size-4" />
          Restore from file
        </Button>
        <Button
          id="local-capabilities"
          variant="outline"
          onClick={() => {
            window.location.hash = '#/lainnya'; // CapabilitiesCard lives on the Lainnya page
            void import('@/dashboard/logic').then(({ showCapabilities }) => showCapabilities());
          }}
        >
          <Activity className="size-4" />
          Check Capabilities
        </Button>
      </CardContent>
    </Card>
  );
}
