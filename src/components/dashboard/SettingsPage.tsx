import { BackupCategoriesCard } from '@/components/dashboard/BackupCategoriesCard';
import { SiteDataSelectionCard } from '@/components/dashboard/SiteDataSelectionCard';
import { SiteDataTuningCard } from '@/components/dashboard/SiteDataTuningCard';

export default function SettingsPage() {
  return (
    <>
      <BackupCategoriesCard />
      <SiteDataSelectionCard />
      <SiteDataTuningCard />
    </>
  );
}
