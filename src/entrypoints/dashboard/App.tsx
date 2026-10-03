import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { appendLog, setState, useApp } from '@/dashboard/store';
import { loadRouteChunk, retryRouteChunk } from '@/dashboard/lazy-route';
import {
  loadTheme,
  useResolvedTheme,
  watchSystemTheme,
} from '@/dashboard/theme';
import { Header } from '@/components/dashboard/Header';
import { SummaryPage } from '@/components/dashboard/pages';

const Toaster = lazy(() =>
  import('@/components/ui/sonner').then((module) => ({
    default: module.Toaster,
  }))
);
const PasswordDialog = lazy(() =>
  import('@/components/dashboard/PasswordDialog').then((module) => ({
    default: module.PasswordDialog,
  }))
);
const SettingsPage = lazy(() =>
  loadRouteChunk(
    'pengaturan',
    () => import('@/components/dashboard/SettingsPage')
  )
);
const ResultsPage = lazy(() =>
  loadRouteChunk('hasil', () => import('@/components/dashboard/ResultsPage'))
);
const FailuresPage = lazy(() =>
  loadRouteChunk(
    'kegagalan',
    () => import('@/components/dashboard/FailuresPage')
  )
);
const LogPage = lazy(() =>
  loadRouteChunk('log', () => import('@/components/dashboard/LogPage'))
);
const MorePage = lazy(() =>
  loadRouteChunk('lainnya', () => import('@/components/dashboard/MorePage'))
);

class RouteChunkErrorBoundary extends Component<
  { route: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) {
      return (
        <div
          role="alert"
          className="rounded-lg border bg-card p-4 text-sm text-muted-foreground"
        >
          <p>
            Halaman gagal dimuat. Dashboard sudah mencoba memuat ulang satu
            kali.
          </p>
          <button
            type="button"
            className="mt-3 min-h-11 rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground"
            onClick={() => retryRouteChunk(this.props.route)}
          >
            Muat ulang dan coba lagi
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
  const read = () =>
    (window.location.hash || '').replace(/^#\/?/, '') || 'ringkasan';
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
  const [toasterReady, setToasterReady] = useState(() =>
    new URLSearchParams(location.search).has('action')
  );

  useEffect(() => {
    const match = navigator.userAgent.match(/Chrom(?:e|ium)\/(\d+(\.\d+)+)/);
    const chromeVersion = match ? match[1] : 'unknown';
    setState({
      subline: `Chromium ${chromeVersion} · extension v${chrome.runtime.getManifest().version} · local by default — cloud upload only if you enable it`,
    });
    appendLog('dashboard ready');
    if (new URLSearchParams(location.search).has('action')) {
      void import('@/dashboard/cloud-ui').then(({ init }) => init());
    }
    void loadTheme();
    watchSystemTheme();
  }, []);

  useEffect(() => {
    if (route === 'lainnya' || state.backup.running) setToasterReady(true);
  }, [route, state.backup.running]);

  const failCount =
    state.backup.siteScan?.urlStates.filter(
      (u) => u.status === 'fetch-failed' || u.status === 'save-failed'
    ).length ?? 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header subline={state.subline} />
      <nav
        aria-label="Halaman dashboard"
        className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur"
      >
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
                <span className="rounded-full bg-red-600 px-1.5 text-[11px] font-bold text-white">
                  {failCount}
                </span>
              )}
            </a>
          ))}
        </div>
      </nav>
      <main className="mx-auto flex w-full max-w-[880px] flex-col gap-3.5 px-4 py-4 max-sm:px-2.5">
        <RouteChunkErrorBoundary key={route} route={route}>
          <Suspense
            fallback={
              <div
                role="status"
                aria-live="polite"
                className="rounded-lg border bg-card p-4 text-sm text-muted-foreground"
              >
                Memuat halaman…
              </div>
            }
          >
            {route === 'ringkasan' && <SummaryPage />}
            {route === 'pengaturan' && <SettingsPage />}
            {route === 'hasil' && <ResultsPage />}
            {route === 'kegagalan' && <FailuresPage />}
            {route === 'log' && <LogPage />}
            {route === 'lainnya' && <MorePage />}
          </Suspense>
        </RouteChunkErrorBoundary>
        {state.password.open && (
          <Suspense fallback={null}>
            <PasswordDialog />
          </Suspense>
        )}
      </main>
      {toasterReady && (
        <Suspense fallback={null}>
          <Toaster position="top-center" theme={resolvedTheme} />
        </Suspense>
      )}
    </div>
  );
}
