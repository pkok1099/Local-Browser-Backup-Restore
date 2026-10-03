import { SiteResultsList } from '@/components/dashboard/SiteResultsList';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApp } from '@/dashboard/store';

export default function ResultsPage() {
  const state = useApp();
  const urlStates = state.backup.siteScan?.urlStates ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[15px]">Hasil situs</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <SiteResultsList urlStates={urlStates} />
      </CardContent>
    </Card>
  );
}
