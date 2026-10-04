import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { retrySiteDataUrls, retrySiteDataSave } from '@/dashboard/logic';
import { isFailedUrl, isRetryingUrl, type UrlState } from '@/dashboard/store';
import { statusLabel } from './SiteResultsList';

export function SiteFailuresList({ urlStates }: { urlStates: UrlState[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const failed = urlStates.filter(isFailedUrl);
  const fetchFailed = failed.filter((u) => u.status === 'fetch-failed');
  const saveFailed = failed.filter((u) => u.status === 'save-failed');

  if (!urlStates.length) {
    return (
      <p className="text-muted-foreground text-sm">
        No site data yet. Run a backup with the Website Data category enabled.
      </p>
    );
  }
  if (!failed.length) {
    return (
      <p className="text-sm text-green-600 dark:text-green-400">
        All sites were processed successfully.
      </p>
    );
  }

  const runRetry = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        {fetchFailed.length > 0 && (
          <Button
            size="sm"
            disabled={busy !== null}
            onClick={() =>
              void runRetry('all', () =>
                retrySiteDataUrls(fetchFailed.map((u) => u.origin))
              )
            }
          >
            {busy === 'all' ? 'Retrying…' : `Retry all (${fetchFailed.length})`}
          </Button>
        )}
        {saveFailed.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void runRetry('save', () => retrySiteDataSave())}
          >
            {busy === 'save'
              ? 'Saving…'
              : `Retry saving ${saveFailed.length} failed ${saveFailed.length === 1 ? 'item' : 'items'}`}
          </Button>
        )}
      </div>
      <div className="grid gap-1.5">
        {failed.map((u) => (
          <div
            key={u.origin}
            className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm"
          >
            <span className="min-w-0 flex-1 break-all">{u.origin}</span>
            <Badge variant="danger">
              {isRetryingUrl(u) ? 'Retrying…' : statusLabel(u.status)}
            </Badge>
            {u.status === 'fetch-failed' && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() =>
                  void runRetry(u.origin, () => retrySiteDataUrls([u.origin]))
                }
              >
                {busy === u.origin ? '…' : 'Retry'}
              </Button>
            )}
            {u.error && (
              <span
                className="text-muted-foreground w-full truncate text-xs"
                title={u.error}
              >
                {u.error}
              </span>
            )}
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">
        Fetch retries close the previous tab before opening another. Save
        retries reuse the collected data without fetching the URL again.
      </p>
    </div>
  );
}
