// Dashboard theme management: light / dark / system.
// Persisted in chrome.storage.local, with a synchronous window.localStorage
// mirror so the correct `dark` class is applied before the first paint
// (no theme flash). Follows the OS while in 'system' mode.
import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'bbr.dashboard.theme';
const LS_MIRROR_KEY = 'bbr.dashboard.theme.mirror';

const isTheme = (v: unknown): v is Theme => v === 'light' || v === 'dark' || v === 'system';

let current: Theme = 'system';
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTheme(): Theme {
  return current;
}

function systemIsDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function getResolvedTheme(t: Theme = current): ResolvedTheme {
  return t === 'system' ? (systemIsDark() ? 'dark' : 'light') : t;
}

export function applyTheme(resolved: ResolvedTheme = getResolvedTheme()): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  // Native controls (scrollbars, form widgets) follow the theme too.
  document.documentElement.style.colorScheme = resolved;
}

function syncMirror(): void {
  try {
    window.localStorage.setItem(LS_MIRROR_KEY, current);
  } catch (e) {
    /* ignore */
  }
}

/** Synchronous boot — call from main.tsx before React renders. */
export function initThemeSync(): void {
  try {
    const mirror = window.localStorage.getItem(LS_MIRROR_KEY);
    if (isTheme(mirror)) current = mirror;
  } catch (e) {
    /* ignore */
  }
  applyTheme();
}

/** Reconcile with the persisted value (async); notifies subscribers on change. */
export async function loadTheme(): Promise<Theme> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const v = stored?.[STORAGE_KEY];
    if (isTheme(v) && v !== current) {
      current = v;
      applyTheme();
      syncMirror();
      emit();
    }
  } catch (e) {
    /* ignore */
  }
  return current;
}

export async function setTheme(t: Theme): Promise<void> {
  if (t === current) return;
  current = t;
  applyTheme();
  syncMirror();
  emit();
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: t });
  } catch (e) {
    /* ignore */
  }
}

/** Re-apply when the OS theme changes while in 'system' mode. */
export function watchSystemTheme(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (current === 'system') {
      applyTheme();
      emit();
    }
  };
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
  else (mq as unknown as { addListener: (l: () => void) => void }).addListener(onChange);
}

/** React bindings. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, getTheme);
}
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeTheme, () => getResolvedTheme());
}
