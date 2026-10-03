import { useEffect } from 'react';
import { CapabilitiesCard } from '@/components/dashboard/CapabilitiesCard';
import { CloudCard } from '@/components/dashboard/CloudCard';
import { RestoreCard } from '@/components/dashboard/RestoreCard';

export default function MorePage() {
  useEffect(() => {
    void import('@/dashboard/cloud-ui').then(({ init }) => init());
  }, []);

  return (
    <>
      <RestoreCard />
      <CloudCard />
      <CapabilitiesCard />
    </>
  );
}
