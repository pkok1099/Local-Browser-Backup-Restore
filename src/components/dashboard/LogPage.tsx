import { useEffect } from 'react';
import { CrawlStatusBar } from '@/components/dashboard/CrawlStatusBar';
import { LogCard } from '@/components/dashboard/LogCard';
import { SiteLogViewer } from '@/components/dashboard/SiteLogViewer';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApp } from '@/dashboard/store';
import { markSiteLogSeen } from '@/dashboard/site-log-store';

export default function LogPage() {
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
