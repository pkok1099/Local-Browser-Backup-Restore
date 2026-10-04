import { useEffect } from 'react';
import { SiteResultsList } from '@/components/dashboard/SiteResultsList';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApp } from '@/dashboard/store';
import { loadPersistedSiteScan } from '@/dashboard/site-scan-persist';

function formatScanTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function ResultsPage() {
  const state = useApp();
  const urlStates = state.backup.siteScan?.urlStates ?? [];
  const meta = state.backup.siteScanMeta;
  useEffect(() => {
    void loadPersistedSiteScan();
  }, []);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[15px]">Site results</CardTitle>
        {meta && (
          <p className="text-xs text-muted-foreground">
            {meta.completedAt
              ? `Latest scan completed at ${formatScanTime(meta.completedAt)}`
              : `Scan started at ${formatScanTime(meta.startedAt)}; no completion time yet`}
          </p>
        )}
      </CardHeader>
      <CardContent className="grid gap-3">
        <SiteResultsList urlStates={urlStates} />
      </CardContent>
    </Card>
  );
}
