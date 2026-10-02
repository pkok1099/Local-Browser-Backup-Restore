import { useEffect, useMemo, useState } from 'react';
import { Globe2, RefreshCw, Search } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { discoverOrigins } from '@/lib/sitedata';
import { filterSiteDataOrigins, getSelectedSiteDataOrigins } from '@/lib/site-data-selection';
import {
  loadIncludedSiteOrigins,
  saveIncludedSiteOrigins,
  loadSiteDataScanWindow,
  saveSiteDataScanWindow,
  SITE_DATA_SCAN_WINDOW_DEFAULT,
  SITE_DATA_SCAN_WINDOW_MIN,
  SITE_DATA_SCAN_WINDOW_MAX,
} from '@/dashboard/backup-categories';

type OriginCandidate = { origin: string; sources: string[] };

const SOURCE_LABELS: Record<string, string> = {
  tab: 'open tab',
  history: 'history',
  bookmarks: 'bookmark',
  readingList: 'reading list',
  'cookie-domain': 'cookie domain',
  'cookie-host': 'cookie host',
  'chips-partition': 'partitioned cookie',
};

export function SiteDataSelectionCard() {
  const [origins, setOrigins] = useState<OriginCandidate[]>([]);
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [scanWindow, setScanWindow] = useState<number>(SITE_DATA_SCAN_WINDOW_DEFAULT);

  async function refresh() {
    setLoading(true);
    const [discovery, savedIncluded, savedWindow] = await Promise.all([
      discoverOrigins(),
      loadIncludedSiteOrigins(),
      loadSiteDataScanWindow(),
    ]);
    const found = discovery.origins as OriginCandidate[];
    setOrigins(found);
    setIncluded(new Set(savedIncluded ?? found.map(({ origin }) => origin)));
    setScanWindow(savedWindow);
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  const selected: OriginCandidate[] = useMemo(
    () => getSelectedSiteDataOrigins(origins, included) as OriginCandidate[],
    [origins, included]
  );
  const visible: OriginCandidate[] = useMemo(
    () => filterSiteDataOrigins(origins, query) as OriginCandidate[],
    [origins, query]
  );

  function save(next: Set<string>) {
    setIncluded(next);
    void saveIncludedSiteOrigins([...next]);
  }

  function toggle(origin: string, checked: boolean | 'indeterminate') {
    const next = new Set(included);
    if (checked) next.add(origin);
    else next.delete(origin);
    save(next);
  }

  return (
    <Card id="section-site-data-selection">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <Globe2 className="size-4 text-primary" />
          Websites included in website-data backup
        </CardTitle>
        <CardDescription>
          Select which discovered sites to keep. Sites are found from open tabs, history, bookmarks, reading list and
          cookie domains. This only filters website data.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="site-data-search"
              className="pl-9"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search websites…"
            />
          </div>
          <Button id="site-data-refresh" variant="outline" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className="size-4" /> Refresh list
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <strong id="site-data-count">
            {loading ? 'Finding websites…' : `${origins.length} websites found · ${selected.length} selected`}
          </strong>
          <Button
            id="site-data-select-all"
            variant="outline"
            size="sm"
            onClick={() => save(new Set(origins.map(({ origin }) => origin)))}
            disabled={loading}
          >
            Select all
          </Button>
          <Button
            id="site-data-clear-all"
            variant="outline"
            size="sm"
            onClick={() => save(new Set())}
            disabled={loading}
          >
            Clear all
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="site-data-scan-window" className="text-muted-foreground">
            Max tabs open during scan:
          </label>
          <Input
            id="site-data-scan-window"
            type="number"
            className="w-20"
            min={SITE_DATA_SCAN_WINDOW_MIN}
            max={SITE_DATA_SCAN_WINDOW_MAX}
            value={scanWindow}
            disabled={loading}
            onChange={(event) => {
              const v = Math.min(
                SITE_DATA_SCAN_WINDOW_MAX,
                Math.max(
                  SITE_DATA_SCAN_WINDOW_MIN,
                  Math.floor(Number(event.target.value) || SITE_DATA_SCAN_WINDOW_DEFAULT)
                )
              );
              setScanWindow(v);
              void saveSiteDataScanWindow(v);
            }}
          />
          <span className="text-muted-foreground text-xs">
            ({SITE_DATA_SCAN_WINDOW_MIN}–{SITE_DATA_SCAN_WINDOW_MAX}; lower if the browser slows down)
          </span>
        </div>
        <div
          id="site-data-origin-list"
          className="grid max-h-[46vh] gap-1 overflow-y-auto overscroll-contain rounded-md border p-1"
          aria-live="polite"
        >
          {!loading && visible.length === 0 && (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              {origins.length ? 'No websites match this search.' : 'No websites found. Use Refresh list to scan again.'}
            </p>
          )}
          {visible.map(({ origin, sources }) => (
            <label key={origin} className="flex min-h-11 items-start gap-3 rounded-md px-2 py-2 hover:bg-muted/50">
              <Checkbox
                checked={included.has(origin)}
                onCheckedChange={(checked) => toggle(origin, checked)}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block break-all text-sm">{origin}</span>
                <span className="block text-xs text-muted-foreground">
                  {sources.map((source) => SOURCE_LABELS[source] || source).join(' · ')}
                </span>
              </span>
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
