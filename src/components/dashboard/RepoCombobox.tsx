import { useEffect, useRef, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { filterRepos } from '@/lib/cloud-picker';
import { cn } from '@/lib/utils';

type RepoOption = {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
};

type Props = {
  id: string;
  repos: RepoOption[];
  value: string; // fullName or ''
  onChange: (fullName: string) => void;
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
};

// Minimal searchable select (command-palette pattern): trigger button opens a
// panel whose top row is an auto-focused search input, with the live-filtered
// repo list below. Built from existing primitives (Input + buttons) because
// the project has no combobox component and Radix Select cannot host a
// search input.
export function RepoCombobox({
  id,
  repos,
  value,
  onChange,
  loading = false,
  disabled = false,
  placeholder = 'Choose a repository',
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = filterRepos(repos, query);
  const selected = repos.find((r) => r.fullName === value) ?? null;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlight(0);
    // Focus after the panel paints.
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  const choose = (fullName: string) => {
    onChange(fullName);
    setOpen(false);
  };

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = filtered[highlight];
      if (r) choose(r.fullName);
    }
  };

  const isDisabled = disabled || loading;

  return (
    <div ref={rootRef} className="relative w-full max-w-sm">
      <button
        id={id}
        type="button"
        disabled={isDisabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          'border-input flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs transition-colors',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          isDisabled && 'cursor-not-allowed opacity-50',
          !selected && 'text-muted-foreground'
        )}
      >
        <span className="truncate">
          {loading
            ? 'Loading repositories…'
            : (selected?.fullName ?? placeholder)}
        </span>
        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
      </button>
      {open && !isDisabled && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="bg-popover text-popover-foreground absolute z-50 mt-1 w-full rounded-md border shadow-md">
            <div className="border-b p-2">
              <Input
                ref={inputRef}
                type="text"
                placeholder="Search repositories…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onInputKey}
                aria-label="Search repositories"
              />
            </div>
            <ul role="listbox" className="max-h-64 overflow-y-auto p-1">
              {filtered.map((r, i) => (
                <li
                  key={r.fullName}
                  role="option"
                  aria-selected={r.fullName === value}
                >
                  <button
                    type="button"
                    onClick={() => choose(r.fullName)}
                    onMouseEnter={() => setHighlight(i)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm',
                      i === highlight && 'bg-accent text-accent-foreground'
                    )}
                  >
                    <span className="truncate">
                      {r.fullName} ({r.private ? 'private' : 'public'})
                    </span>
                    {r.fullName === value && (
                      <Check className="h-4 w-4 shrink-0" />
                    )}
                  </button>
                </li>
              ))}
              {filtered.length === 0 && (
                <li className="text-muted-foreground px-2 py-1.5 text-sm">
                  {query
                    ? `No repositories match “${query}”.`
                    : 'No repositories.'}
                </li>
              )}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
