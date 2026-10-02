import { useEffect, useState } from 'react';
import { useApp } from '@/dashboard/store';
import { init } from '@/dashboard/cloud-ui';
import { loadTheme, useResolvedTheme, watchSystemTheme } from '@/dashboard/theme';
import { Header } from '@/components/dashboard/Header';
import { PasswordDialog } from '@/components/dashboard/PasswordDialog';
import { Toaster } from '@/components/ui/sonner';
import { SummaryPage, SettingsPage, ResultsPage, FailuresPage, LogPage, MorePage } from '@/components/dashboard/pages';

// Hash routing on a SINGLE extension page: changing location.hash never
// reloads the page, so the crawl engine (Worker 1, Worker 2, load/CPU
// monitors, open tabs) in this page's JS context keeps running while the
// user switches pages. Separate HTML files would destroy that context and
// kill the crawl.
const NAV = [
  { id: 'ringkasan', label: 'Ringkasan' },
  { id: 'pengaturan', label: 'Pengaturan' },
  { id: 'hasil', label: 'Hasil' },
  { id: 'kegagalan', label: 'Kegagalan' },
  { id: 'log', label: 'Log' },
  { id: 'lainnya', label: 'Lainnya' },
] as const;

function useHashRoute(): string {
  const read = () => (window.location.hash || '').replace(/^#\/?/, '') || 'ringkasan';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onHash = () => setRoute(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return NAV.some((p) => p.id === route) ? route : 'ringkasan';
}

export default function App() {
  const state = useApp();
  const resolvedTheme = useResolvedTheme();
  const route = useHashRoute();

  useEffect(() => {
    void init();
    void loadTheme();
    watchSystemTheme();
  }, []);

  const failCount =
    state.backup.siteScan?.urlStates.filter((u) => u.status === 'fetch-failed' || u.status === 'save-failed').length ??
    0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header subline={state.subline} />
      <nav aria-label="Halaman dashboard" className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[880px] gap-1 overflow-x-auto px-4 py-2 max-sm:px-2.5">
          {NAV.map((p) => (
            <a
              key={p.id}
              href={`#/${p.id}`}
              aria-current={route === p.id ? 'page' : undefined}
              className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium ${
                route === p.id
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {p.label}
              {p.id === 'kegagalan' && failCount > 0 && (
                <span className="rounded-full bg-red-600 px-1.5 text-[11px] font-bold text-white">{failCount}</span>
              )}
            </a>
          ))}
        </div>
      </nav>
      <main className="mx-auto flex w-full max-w-[880px] flex-col gap-3.5 px-4 py-4 max-sm:px-2.5">
        {route === 'ringkasan' && <SummaryPage />}
        {route === 'pengaturan' && <SettingsPage />}
        {route === 'hasil' && <ResultsPage />}
        {route === 'kegagalan' && <FailuresPage />}
        {route === 'log' && <LogPage />}
        {route === 'lainnya' && <MorePage />}
        <PasswordDialog />
      </main>
      <Toaster position="top-center" theme={resolvedTheme} />
    </div>
  );
}
