import { SiteFailuresList } from '@/components/dashboard/SiteFailuresList';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApp } from '@/dashboard/store';

export default function FailuresPage() {
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
