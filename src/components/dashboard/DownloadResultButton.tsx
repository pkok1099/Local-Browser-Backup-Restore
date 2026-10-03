import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useApp } from '@/dashboard/store';

// "Download hasil" button: the backup is stored in extension storage (no
// auto-download). The file is built only when clicked. Shows site count and
// estimated size beforehand. Disabled when no data. Works during a crawl or
// after stop (downloads whatever exists).
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
        {busy ? 'Menyiapkan…' : 'Download hasil'}
      </Button>
      {info.ready ? (
        <span className="text-muted-foreground text-xs">
          {info.siteCount} situs · perkiraan {sizeStr}
        </span>
      ) : (
        <span className="text-muted-foreground text-xs">
          Belum ada data untuk diunduh.
        </span>
      )}
      {error && (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      )}
    </div>
  );
}
