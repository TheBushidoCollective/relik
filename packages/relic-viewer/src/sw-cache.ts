/**
 * Core cacheability rules, asset lists, and generation lifecycle helpers
 * for the Relic service worker.
 *
 * Placed in its own module so tests and the service worker entry point can both
 * import these rules directly without sw.ts having to export them.
 * A classic service worker script cannot contain module exports.
 */

export const SHELL_ASSETS = [
  '/assets/viewer.js',
  '/assets/styles.css',
  '/manifest.webmanifest',
] as const;

/**
 * Computes the cache generation name from a build identity hash.
 * If no build hash is provided (e.g. in development or unit tests),
 * returns a development fallback name.
 */
export function shellCacheName(buildId?: string): string {
  if (buildId && buildId.length > 0) {
    return `relic-shell-${buildId}`;
  }
  return 'relic-shell-dev';
}

export function isCacheable(
  url: URL,
  sameOrigin: boolean,
  shell: readonly string[] = SHELL_ASSETS
): boolean {
  if (!sameOrigin) return false; // storage lives elsewhere; never cache it
  if (url.pathname.startsWith('/api/')) return false;
  return shell.includes(url.pathname);
}

export interface MinimalCache {
  addAll(requests: string[]): Promise<void>;
}

export interface MinimalCacheStorage {
  open(cacheName: string): Promise<MinimalCache>;
  keys(): Promise<string[]>;
  delete(cacheName: string): Promise<boolean>;
}

/**
 * Installs the new generation of shell assets into cache storage.
 *
 * Wholesale atomicity: cache.addAll fetches all assets in SHELL_ASSETS. If any
 * fail, the entire install rejects and the previous worker remains active.
 */
export async function installShell(
  cacheStorage: MinimalCacheStorage,
  cacheName: string,
  assets: readonly string[] = SHELL_ASSETS,
  skipWaiting?: () => Promise<void> | void
): Promise<void> {
  const cache = await cacheStorage.open(cacheName);
  await cache.addAll(assets as string[]);
  await skipWaiting?.();
}

/**
 * Activates the new generation and purges all older cache generations.
 *
 * Returns the list of deleted cache names.
 */
export async function activateShell(
  cacheStorage: MinimalCacheStorage,
  currentCache: string,
  claim?: () => Promise<void> | void
): Promise<string[]> {
  const names = await cacheStorage.keys();
  const toDelete = names.filter((name) => name !== currentCache);
  await Promise.all(toDelete.map((name) => cacheStorage.delete(name)));
  await claim?.();
  return toDelete;
}
