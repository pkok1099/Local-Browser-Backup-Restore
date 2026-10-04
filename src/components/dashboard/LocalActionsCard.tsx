import { useEffect, useState } from 'react';
import { HardDriveDownload, Undo2, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  appendLog,
  hasUnresolvedSiteScan,
  patchState,
  useApp,
} from '@/dashboard/store';

export function LocalActionsCard() {
  const state = useApp();
  const [hasCheckpoint, setHasCheckpoint] = useState(true);

  useEffect(() => {
    const key = 'bbr:site-data-checkpoint';
    const refresh = () => {
      void chrome.storage.local
        .get(key)
        .then((values) => setHasCheckpoint(Object.hasOwn(values, key)))
        .catch(() => setHasCheckpoint(true));
    };
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName === 'local' && key in changes)
        setHasCheckpoint(changes[key].newValue !== undefined);
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    refresh();
    return () => chrome.storage.onChanged.removeListener(onStorageChanged);
  }, []);

  const clearDisabled =
    typeof navigator === 'undefined' ||
    typeof navigator.locks?.request !== 'function' ||
    typeof navigator.locks?.query !== 'function' ||
    state.activeOperations > 0 ||
    state.backup.running ||
    hasCheckpoint ||
    hasUnresolvedSiteScan(state.backup.siteScan);

  return (
    <Card id="section-local-actions">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <HardDriveDownload className="size-4 text-primary" />
          Local backup and restore
        </CardTitle>
        <CardDescription>
          Backup files stay on this device unless you choose a cloud provider
          below.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button
          id="local-backup"
          onClick={() =>
            void import('@/dashboard/logic').then(({ doBackup }) =>
              doBackup({ encrypt: false })
            )
          }
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
            patchState('restore', (r) => ({
              ...r,
              sectionVisible: true,
              pickError: null,
            }));
            appendLog('restore: choose a backup file');
            window.location.hash = '#/more'; // RestoreCard lives on the More page
            requestAnimationFrame(() =>
              document.getElementById('restore-file')?.focus()
            );
          }}
        >
          <Undo2 className="size-4" />
          Restore from file
        </Button>
        <Button
          id="local-capabilities"
          variant="outline"
          onClick={() => {
            window.location.hash = '#/more'; // CapabilitiesCard lives on the More page
            void import('@/dashboard/logic').then(({ showCapabilities }) =>
              showCapabilities()
            );
          }}
        >
          <Activity className="size-4" />
          Check Capabilities
        </Button>
        <Button
          id="clear-results"
          variant="outline"
          disabled={clearDisabled}
          onClick={() =>
            void import('@/dashboard/logic').then(({ clearBackupResults }) =>
              clearBackupResults()
            )
          }
        >
          Clear Results
        </Button>
        <p className="basis-full text-muted-foreground text-xs">
          Clear Results removes transient backup, scan, and restore results.
          Downloaded files in your chosen location are not deleted. Recovery
          checkpoints, durable backups, cloud credentials, and browser data are
          preserved.
        </p>
      </CardContent>
    </Card>
  );
}
