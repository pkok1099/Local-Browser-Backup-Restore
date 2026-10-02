import { ScrollText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApp } from '@/dashboard/store';
import { useEffect, useRef } from 'react';

export function LogCard() {
  const state = useApp();
  const ref = useRef<HTMLPreElement>(null);

  // Auto-scroll to the newest line, like the original log element.
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.logLines.length]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-[15px]">
          <ScrollText className="size-4 text-primary" />
          Log
        </CardTitle>
      </CardHeader>
      <CardContent>
        <pre
          id="log"
          ref={ref}
          className="bg-slate-950 text-slate-200 max-h-[260px] overflow-auto rounded-lg p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap max-sm:max-h-[40vh] [overflow-wrap:anywhere]"
        >
          {state.logLines.length ? state.logLines.join('\n') : '(no output yet)'}
        </pre>
      </CardContent>
    </Card>
  );
}
