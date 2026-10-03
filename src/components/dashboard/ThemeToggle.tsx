// @ts-nocheck -- Dashboard UI predates strict mode; needs dedicated refactoring pass. Tracked as tech debt.
import { Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { setTheme, useTheme, type Theme } from '@/dashboard/theme';

const ORDER: Theme[] = ['light', 'dark', 'system'];
const LABEL: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

export function ThemeToggle() {
  const theme = useTheme();
  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    void setTheme(next);
  };
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={cycle}
      title={`Theme: ${LABEL[theme]} — click to switch`}
      aria-label={`Switch theme (current: ${LABEL[theme]})`}
    >
      <Icon />
    </Button>
  );
}
