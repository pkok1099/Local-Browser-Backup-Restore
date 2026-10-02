// Dashboard pages (hash-routed, single HTML page — navigation never reloads,
// so the crawl engine in this page context keeps running while the user
// switches pages). All pages read from the one shared store, no duplication.
import { LocalActionsCard } from '@/components/dashboard/LocalActionsCard';
import { BackupProgressCard } from '@/components/dashboard/BackupProgressCard';
import { BackupCategoriesCard } from '@/components/dashboard/BackupCategoriesCard';
import { SiteDataSelectionCard } from '@/components/dashboard/SiteDataSelectionCard';
import { SiteDataTuningCard } from '@/components/dashboard/SiteDataTuningCard';
import { RestoreCard } from '@/components/dashboard/RestoreCard';
import { CloudCard } from '@/components/dashboard/CloudCard';
import { CapabilitiesCard } from '@/components/dashboard/CapabilitiesCard';
import { LogCard } from '@/components/dashboard/LogCard';
import { SiteResultsList } from '@/components/dashboard/SiteResultsList';
import { SiteFailuresList } from '@/components/dashboard/SiteFailuresList';
import { SiteLogViewer } from '@/components/dashboard/SiteLogViewer';
import { CrawlStatusBar } from '@/components/dashboard/CrawlStatusBar';
import { DownloadResultButton } from '@/components/dashboard/DownloadResultButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApp } from '@/dashboard/store';
import { markSiteLogSeen } from '@/dashboard/site-log-store';
import { useEffect } from 'react';

export function SummaryPage() {
  return (
    <>
      <CrawlStatusBar />
      <Card>
        <CardContent className="pt-4">
          <DownloadResultButton />
        </CardContent>
      </Card>
      <LocalActionsCard />
      <BackupProgressCard />
    </>
  );
}

export function SettingsPage() {
  return (
    <>
      <BackupCategoriesCard />
      <SiteDataSelectionCard />
      <SiteDataTuningCard />
    </>
  );
}

export function ResultsPage() {
  const state = useApp();
  const urlStates = state.backup.siteScan?.urlStates ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[15px]">Hasil situs</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <DownloadResultButton />
        <SiteResultsList urlStates={urlStates} />
      </CardContent>
    </Card>
  );
}

export function FailuresPage() {
  const state = useApp();
  const urlStates = state.backup.siteScan?.urlStates ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[15px]">Kegagalan</CardTitle>
      </CardHeader>
      <CardContent>
        <SiteFailuresList urlStates={urlStates} />
      </CardContent>
    </Card>
  );
}

export function LogPage() {
  const state = useApp();
  useEffect(() => {
    markSiteLogSeen();
  }, []);
  const security = state.logLines.filter((l) => /SAFETY VIOLATION|ABORTED|STOPPED|quota|REFUSED/i.test(l));
  return (
    <>
      <CrawlStatusBar />
      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Log crawl</CardTitle>
        </CardHeader>
        <CardContent>
          <SiteLogViewer />
        </CardContent>
      </Card>
      {security.length > 0 && (
        <Card className="border-red-300 dark:border-red-800">
          <CardHeader>
            <CardTitle className="text-[15px] text-red-600 dark:text-red-400">
              Peringatan keamanan ({security.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid max-h-64 gap-1 overflow-y-auto font-mono text-[11px]">
              {security.map((l, i) => (
                <div key={i} className="text-red-600 dark:text-red-400">
                  {l}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      <LogCard />
    </>
  );
}

export function MorePage() {
  return (
    <>
      <RestoreCard />
      <CloudCard />
      <CapabilitiesCard />
    </>
  );
}
