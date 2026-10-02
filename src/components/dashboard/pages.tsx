// Dashboard pages (hash-routed, single HTML page — navigation never reloads,
// so the crawl engine in this page context keeps running while the user
// switches pages). All pages read from the one shared store, no duplication.
import { LocalActionsCard } from '@/components/dashboard/LocalActionsCard';
import { BackupProgressCard } from '@/components/dashboard/BackupProgressCard';
import { CrawlStatusBar } from '@/components/dashboard/CrawlStatusBar';
import { DownloadResultButton } from '@/components/dashboard/DownloadResultButton';
import { Card, CardContent } from '@/components/ui/card';

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
