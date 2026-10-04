import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import type { UrlState, UrlStatus } from '@/dashboard/store';

const STATUS_LABEL: Record<UrlStatus, string> = {
  pending: 'Pending',
  fetching: 'Fetching…',
  fetched: 'Fetched',
  saved: 'Saved',
  'fetch-failed': 'Fetch failed',
  'save-failed': 'Save failed',
  skipped: 'Skipped',
};

const STATUS_VARIANT: Record<
  UrlStatus,
  'default' | 'success' | 'warning' | 'danger'
> = {
  pending: 'default',
  fetching: 'default',
  fetched: 'warning',
  saved: 'success',
  'fetch-failed': 'danger',
  'save-failed': 'danger',
  skipped: 'default',
};

export function statusLabel(s: UrlStatus): string {
  return STATUS_LABEL[s] ?? s;
}

export function SiteResultsList({ urlStates }: { urlStates: UrlState[] }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | UrlStatus>('all');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return urlStates.filter((u) => {
      if (filter !== 'all' && u.status !== filter) return false;
      if (q && !u.origin.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [urlStates, query, filter]);

  if (!urlStates.length) {
    return (
      <p className="text-muted-foreground text-sm">
        No results yet—run a backup with the Website Data category.
      </p>
    );
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const u of urlStates) c[u.status] = (c[u.status] || 0) + 1;
    return c;
  }, [urlStates]);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="Search sites…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1"
        />
        <select
          aria-label="Filter status"
          value={filter}
          onChange={(e) => setFilter(e.target.value as 'all' | UrlStatus)}
          className="border-input bg-background rounded-md border px-2 py-1.5 text-sm"
        >
          <option value="all">All ({urlStates.length})</option>
          {(Object.keys(STATUS_LABEL) as UrlStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]} ({counts[s] || 0})
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-1.5">
        {filtered.map((u) => (
          <div
            key={u.origin}
            className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm"
          >
            <span className="min-w-0 flex-1 break-all">{u.origin}</span>
            <Badge variant={STATUS_VARIANT[u.status]}>
              {STATUS_LABEL[u.status]}
            </Badge>
            {u.attempts > 1 && (
              <span className="text-muted-foreground text-xs">
                {u.attempts}× attempts
              </span>
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
        {filtered.length === 0 && (
          <p className="text-muted-foreground text-sm">No matching sites.</p>
        )}
      </div>
    </div>
  );
}
