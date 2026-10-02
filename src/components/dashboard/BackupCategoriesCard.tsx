import { useEffect, useState } from 'react';
import { ListChecks } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  BACKUP_CATEGORIES,
  loadBackupCategories,
  saveBackupCategories,
  type BackupCategoryId,
} from '@/dashboard/backup-categories';

export function BackupCategoriesCard() {
  const [selected, setSelected] = useState<BackupCategoryId[]>(BACKUP_CATEGORIES.map(({ id }) => id));

  useEffect(() => {
    let active = true;
    void loadBackupCategories().then((categories) => {
      if (active) setSelected(categories);
    });
    return () => {
      active = false;
    };
  }, []);

  function updateSelection(next: BackupCategoryId[]) {
    setSelected(next);
    void saveBackupCategories(next);
  }

  return (
    <Card id="section-backup-categories">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <ListChecks className="size-4 text-primary" />
          Data to back up
        </CardTitle>
        <CardDescription>
          Applies to local, cloud and scheduled backups. Tab groups are included with tabs. Website data can take
          longer.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {BACKUP_CATEGORIES.map(({ id, label }) => (
            <label key={id} className="flex min-h-11 items-center gap-3 rounded-md border px-3 py-2 text-sm">
              <Checkbox
                checked={selected.includes(id)}
                onCheckedChange={(checked) =>
                  updateSelection(checked ? [...selected, id] : selected.filter((item) => item !== id))
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => updateSelection(BACKUP_CATEGORIES.map(({ id }) => id))}>
            Select all
          </Button>
          <Button variant="outline" size="sm" onClick={() => updateSelection([])}>
            Clear all
          </Button>
          <span className="self-center text-xs text-muted-foreground">
            {selected.length} of {BACKUP_CATEGORIES.length} selected
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
