type RetryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type RecoveryOptions = {
  storage?: RetryStorage | null;
  reload?: () => void;
};

const RETRY_KEY_PREFIX = 'bbr:lazy-route-retry:';

function retryKey(route: string): string {
  return `${RETRY_KEY_PREFIX}${encodeURIComponent(route)}`;
}

function getSessionStorage(): RetryStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function reloadDashboard(): void {
  window.location.reload();
}

/**
 * Load a lazy dashboard route and recover from one transient chunk failure by
 * reloading the same dashboard URL once. The route hash, query, and active
 * dashboard document context are preserved by the browser reload. A second
 * failure is surfaced to the route error boundary instead of looping.
 */
export async function loadRouteChunk<T>(
  route: string,
  load: () => Promise<T>,
  options: RecoveryOptions = {}
): Promise<T> {
  try {
    const module = await load();
    try {
      (options.storage === undefined ? getSessionStorage() : options.storage)?.removeItem(retryKey(route));
    } catch {
      // Storage is only a loop guard; a successfully loaded chunk must render.
    }
    return module;
  } catch (error) {
    const storage = options.storage === undefined ? getSessionStorage() : options.storage;
    if (storage) {
      try {
        if (storage.getItem(retryKey(route)) !== '1') {
          storage.setItem(retryKey(route), '1');
          (options.reload ?? reloadDashboard)();
        }
      } catch {
        // If session storage is unavailable, surface the error without an
        // automatic reload; the route boundary still offers a manual retry.
      }
    }
    throw error;
  }
}

/** Clear the one-shot guard and explicitly retry by reloading the dashboard. */
export function retryRouteChunk(route: string, options: RecoveryOptions = {}): void {
  const storage = options.storage === undefined ? getSessionStorage() : options.storage;
  try {
    storage?.removeItem(retryKey(route));
  } catch {
    // A manual retry remains useful even when session storage is unavailable.
  }
  (options.reload ?? reloadDashboard)();
}
