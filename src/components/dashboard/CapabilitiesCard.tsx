import { Activity } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useApp } from '@/dashboard/store';

export function CapabilitiesCard() {
  const state = useApp();
  const { caps } = state;
  if (!caps.visible) return null;

  return (
    <Card id="section-caps">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <Activity className="size-4 text-primary" />
          Capabilities (detected live in this browser)
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        <div id="caps-status" className="text-muted-foreground text-xs">
          {caps.status}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Read</TableHead>
              <TableHead>Backup</TableHead>
              <TableHead>Restore</TableHead>
              <TableHead>Notes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {caps.rows.map((row) => (
              <TableRow key={row.cat}>
                <TableCell className="font-medium">{row.cat}</TableCell>
                <TableCell>{row.read ? '✓' : '—'}</TableCell>
                <TableCell>{row.backup ? '✓' : '—'}</TableCell>
                <TableCell>
                  {row.restore === 'full' && (
                    <Badge variant="success">yes</Badge>
                  )}
                  {row.restore === 'partial' && (
                    <Badge variant="warning">partial</Badge>
                  )}
                  {!row.restore && <Badge variant="danger">no</Badge>}
                </TableCell>
                <TableCell className="text-muted-foreground text-xs whitespace-normal">
                  {row.notes}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <h3 className="text-muted-foreground mt-1 text-xs font-semibold tracking-wide uppercase">
          Runtime probes
        </h3>
        <pre
          id="caps-probes"
          className="bg-slate-950 text-slate-200 max-h-60 overflow-auto rounded-lg p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
        >
          {caps.probes}
        </pre>
      </CardContent>
    </Card>
  );
}
