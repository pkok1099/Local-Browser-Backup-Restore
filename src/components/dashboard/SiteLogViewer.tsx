import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useApp } from '@/dashboard/store';
import {
  useSiteLog,
  loadPersistedSiteLog,
  clearSiteLogView,
  formatLogTs,
  LEVEL_COLORS,
  LEVEL_ICONS,
  type SiteLogEntry,
} from '@/dashboard/site-log-store';
import { LOG_LEVEL_NAMES, LOG_CATEGORIES } from '@/lib/site-log';

function exportJson(entries: SiteLogEntry[]) {
  const blob = new Blob([JSON.stringify(entries, null, 2)], {
    type: 'application/json',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bbr-site-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function exportText(entries: SiteLogEntry[]) {
  const lines = entries.map((e) => {
    const ctx =
      e.context && Object.keys(e.context).length
        ? ` ${JSON.stringify(e.context)}`
        : '';
    return `${formatLogTs(e.ts)} [${e.level}] [${e.category}] ${e.message}${ctx}`;
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bbr-site-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export function SiteLogViewer() {
  const entries = useSiteLog();
  const { activeOperations } = useApp();
  const [levels, setLevels] = useState<string[]>([
    'INFO',
    'WARN',
    'ERROR',
    'FATAL',
  ]); // DEBUG hidden by default
  const [categories, setCategories] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [corr, setCorr] = useState('');
  const [detailed, setDetailed] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [clearError, setClearError] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  useEffect(() => {
    void loadPersistedSiteLog();
  }, []);

  useEffect(() => {
    const panel = panelRef.current;
    if (autoScroll && panel && wasAtBottomRef.current)
      panel.scrollTop = panel.scrollHeight;
  }, [entries, autoScroll]);

  const updatePanelPosition = () => {
    const panel = panelRef.current;
    if (panel)
      wasAtBottomRef.current =
        panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 1;
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (!levels.includes(e.level)) return false;
      if (categories.length && !categories.includes(e.category)) return false;
      if (corr && e.corr !== corr && e.url !== corr) return false;
      if (selectedUrl && e.url !== selectedUrl && e.corr !== selectedUrl)
        return false;
      if (
        q &&
        !(e.message || '').toLowerCase().includes(q) &&
        !JSON.stringify(e.context || {})
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
  }, [entries, levels, categories, query, corr, selectedUrl]);

  const toggleLevel = (l: string) =>
    setLevels((cur) =>
      cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]
    );
  const toggleCategory = (c: string) =>
    setCategories((cur) =>
      cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]
    );

  return (
    <div className="grid gap-3">
      {/* Filters */}
      <div className="grid gap-2">
        <div className="flex flex-wrap gap-1.5">
          {LOG_LEVEL_NAMES.map((l) => (
            <button
              key={l}
              onClick={() => toggleLevel(l)}
              className={`rounded-md border px-2 py-1 text-xs font-medium ${levels.includes(l) ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
            >
              {LEVEL_ICONS[l]} {l}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {LOG_CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => toggleCategory(c)}
              className={`rounded-md border px-2 py-1 text-xs ${categories.includes(c) ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground'}`}
            >
              {c}
            </button>
          ))}
          {categories.length > 0 && (
            <button
              onClick={() => setCategories([])}
              className="text-xs text-muted-foreground underline"
            >
              reset
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Cari teks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1"
          />
          <Input
            placeholder="Filter URL / id korelasi…"
            value={corr}
            onChange={(e) => setCorr(e.target.value)}
            className="min-w-0 flex-1"
          />
        </div>
        {selectedUrl && (
          <div className="flex items-center gap-2 text-sm">
            <span>Riwayat URL:</span>
            <Badge variant="default">{selectedUrl}</Badge>
            <button
              onClick={() => setSelectedUrl(null)}
              className="text-xs text-muted-foreground underline"
            >
              tutup
            </button>
          </div>
        )}
      </div>

      {/* View controls */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDetailed((d) => !d)}
        >
          {detailed ? 'Tampilan ringkas' : 'Tampilan rinci'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setAutoScroll((a) => !a)}
        >
          {autoScroll ? 'Jeda auto-scroll' : 'Lanjut auto-scroll'}
        </Button>
        <Button
          id="clear-logs"
          size="sm"
          variant="outline"
          disabled={
            activeOperations > 0 ||
            typeof navigator === 'undefined' ||
            typeof navigator.locks?.request !== 'function' ||
            typeof navigator.locks?.query !== 'function'
          }
          onClick={async () => {
            setClearError(false);
            if (!(await clearSiteLogView())) setClearError(true);
          }}
        >
          Clear Logs
        </Button>
        {clearError && (
          <p role="alert" className="basis-full text-destructive text-xs">
            Clear Logs failed. Logs were not changed.
          </p>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => exportJson(filtered)}
        >
          Ekspor JSON
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => exportText(filtered)}
        >
          Ekspor teks
        </Button>
        <span className="text-muted-foreground ml-auto">
          {filtered.length} entri
        </span>
        <p className="basis-full text-muted-foreground text-xs">
          Clear Logs removes dashboard and crawl logs only. It does not remove
          results, backups, artifacts, scan state, or browser data.
        </p>
      </div>

      {/* Entries */}
      <div
        id="site-log-panel"
        ref={panelRef}
        onScroll={updatePanelPosition}
        className="grid max-h-[60vh] gap-1 overflow-y-auto rounded-md border p-2 font-mono text-[11px]"
      >
        {filtered.map((e) => (
          <div
            key={e.id}
            className={`flex flex-wrap gap-x-2 gap-y-0.5 rounded px-1.5 py-0.5 ${e.level === 'FATAL' ? 'bg-red-600 text-white' : ''}`}
          >
            <span className="text-muted-foreground shrink-0">
              {formatLogTs(e.ts)}
            </span>
            <span
              className={`shrink-0 font-bold ${e.level === 'FATAL' ? '' : LEVEL_COLORS[e.level]}`}
            >
              {LEVEL_ICONS[e.level]} {e.level}
            </span>
            <Badge variant="default" className="shrink-0 text-[10px]">
              {e.category}
            </Badge>
            <span className="min-w-0 flex-1 break-words">{e.message}</span>
            {e.url && (
              <button
                onClick={() => setSelectedUrl(e.url)}
                className="shrink-0 text-blue-600 dark:text-blue-400 underline"
                title="Lihat riwayat URL ini"
              >
                {e.url}
              </button>
            )}
            {detailed && e.context && Object.keys(e.context).length > 0 && (
              <pre className="bg-muted w-full overflow-x-auto rounded p-1.5 text-[10px]">
                {JSON.stringify(e.context, null, 1)}
              </pre>
            )}
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="text-muted-foreground p-2 font-sans text-sm">
            Tidak ada entri yang cocok dengan filter.
          </p>
        )}
      </div>
    </div>
  );
}
