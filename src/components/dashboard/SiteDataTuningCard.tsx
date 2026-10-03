import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  loadSiteDataTuning,
  saveSiteDataTuning,
  loadSiteDataInclude,
  saveSiteDataInclude,
  type SiteDataTuning,
  type SiteDataInclude,
} from '@/dashboard/backup-categories';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

// Extra user-safe tunables for the site-data crawl (Pengaturan page).
export function SiteDataTuningCard() {
  const [tuning, setTuning] = useState<SiteDataTuning | null>(null);
  const [include, setInclude] = useState<SiteDataInclude | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadSiteDataTuning().then(setTuning);
    void loadSiteDataInclude().then(setInclude);
  }, []);

  if (!tuning || !include) return null;

  const set = (patch: Partial<SiteDataTuning>) => {
    setTuning({ ...tuning, ...patch });
    setSaved(false);
  };
  const setInc = (patch: Partial<SiteDataInclude>) => {
    setInclude({ ...include, ...patch });
    setSaved(false);
  };

  const save = async () => {
    await saveSiteDataTuning(tuning);
    await saveSiteDataInclude(include);
    setSaved(true);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[15px]">
          Website data — retry &amp; timeout
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="tuning-attempts">
            Upaya maksimum per situs (1–5)
          </Label>
          <Input
            id="tuning-attempts"
            type="number"
            min={1}
            max={5}
            value={tuning.retryMaxAttempts}
            onChange={(e) =>
              set({ retryMaxAttempts: Math.floor(Number(e.target.value)) })
            }
          />
          <p className="text-muted-foreground text-xs">
            Tab lama selalu ditutup dulu sebelum upaya berikutnya dibuka.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="tuning-read-timeout">
            Timeout baca per tab, detik (15–180)
          </Label>
          <Input
            id="tuning-read-timeout"
            type="number"
            min={15}
            max={180}
            value={Math.round(tuning.readTimeoutMs / 1000)}
            onChange={(e) =>
              set({ readTimeoutMs: Math.floor(Number(e.target.value)) * 1000 })
            }
          />
          <p className="text-muted-foreground text-xs">
            Pembacaan yang menggantung dibatalkan — tab tetap ditutup, slot
            dilepas.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="tuning-checkpoint">
            Simpan checkpoint tiap N situs (5–50)
          </Label>
          <Input
            id="tuning-checkpoint"
            type="number"
            min={5}
            max={50}
            value={tuning.checkpointEveryOrigins}
            onChange={(e) =>
              set({
                checkpointEveryOrigins: Math.floor(Number(e.target.value)),
              })
            }
          />
        </div>
        <div className="grid gap-2 rounded-md border p-2.5">
          <div className="text-xs font-semibold">
            Kategori yang tidak bisa di-restore — sertakan dalam backup?
          </div>
          <p className="text-muted-foreground text-[11px]">
            Default mati (tidak di-backup). Bila dimatikan, datanya tidak
            diambil sama sekali — hemat waktu dan penyimpanan.
          </p>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={include.sessionStorage}
              onChange={(e) => setInc({ sessionStorage: e.target.checked })}
            />
            <span>
              <b>sessionStorage</b> — tidak bisa di-restore bila restore membuat
              tab baru (hanya bisa ke tab yang sudah terbuka).
            </span>
          </label>
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={include.serviceWorkers}
              onChange={(e) => setInc({ serviceWorkers: e.target.checked })}
            />
            <span>
              <b>Service Workers</b> — restore butuh script worker masih
              disajikan oleh situsnya (keterbatasan platform).
            </span>
          </label>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void save()}>
            Simpan
          </Button>
          {saved && <Badge variant="success">tersimpan</Badge>}
        </div>
      </CardContent>
    </Card>
  );
}
