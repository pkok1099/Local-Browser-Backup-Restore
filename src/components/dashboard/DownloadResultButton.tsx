import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useApp } from '@/dashboard/store';

// "Download results" button: the backup is stored in extension storage, with no
// automatic download. The file is built only when clicked. The button shows the
// site count and estimated size first; it is disabled when no data is available
// and works during or after a crawl, downloading whatever data is available.
export function DownloadResultButton() {
  const state = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = state.backup.downloadInfo || {
    ready: false,
    siteCount: 0,
    estBytes: 0,
  };

  const onClick = async () => {
    setBusy(true);
    setError(null);
    try {
      const { downloadBackupResult } = await import('@/dashboard/logic');
      await downloadBackupResult();
    } catch (e) {
      setError((e as Error)?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const sizeStr =
    info.estBytes > 0
      ? info.estBytes / 1024 / 1024 >= 1
        ? `${(info.estBytes / 1024 / 1024).toFixed(1)} MB`
        : `${(info.estBytes / 1024).toFixed(1)} KB`
      : '—';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        onClick={() => void onClick()}
        disabled={!info.ready || busy}
      >
        {busy ? 'Preparing…' : 'Download results'}
      </Button>
      {info.ready ? (
        <span className="text-muted-foreground text-xs">
          {info.siteCount} {info.siteCount === 1 ? 'site' : 'sites'} · estimated{' '}
          {sizeStr}
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">
          No data is available to download.
        </span>
      )}
      {error && (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      )}
    </div>
  );
}
