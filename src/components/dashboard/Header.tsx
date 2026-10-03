import { ThemeToggle } from '@/components/dashboard/ThemeToggle';

export function Header({ subline }: { subline: string }) {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex w-full max-w-[880px] items-start justify-between gap-2 px-4 py-3.5">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">
            Local Browser Backup &amp; Restore
          </h1>
          <div id="subline" className="text-muted-foreground mt-0.5 text-xs">
            {subline}
          </div>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}
