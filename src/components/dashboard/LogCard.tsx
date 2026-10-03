import { ScrollText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApp } from '@/dashboard/store';
import { useEffect, useRef } from 'react';

export function LogCard() {
  const state = useApp();
  const ref = useRef<HTMLPreElement>(null);
  const previousLinesRef = useRef(state.logLines);
  const wasAtBottomRef = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const hasNewOutput = previousLinesRef.current !== state.logLines;
    previousLinesRef.current = state.logLines;
    if (!hasNewOutput) return;
    if (!state.logLines.length) {
      wasAtBottomRef.current = true;
      return;
    }
    if (wasAtBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [state.logLines]);

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
          onScroll={() => {
            const el = ref.current;
            if (el)
              wasAtBottomRef.current =
                el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
          }}
          className="bg-slate-950 text-slate-200 max-h-[260px] overflow-auto rounded-lg p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap max-sm:max-h-[40vh] [overflow-wrap:anywhere]"
        >
          {state.logLines.length
            ? state.logLines.join('\n')
            : '(no output yet)'}
        </pre>
      </CardContent>
    </Card>
  );
}
