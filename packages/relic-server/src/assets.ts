/**
 * Static asset serving for the viewer shell.
 *
 * The assets are the only thing this server hands out that it authored. Relic
 * content never passes through here: it goes client-to-storage and
 * storage-to-client under signed URLs, which is what makes the
 * zero-knowledge claim structural rather than a promise.
 */

export interface Asset {
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface AssetSource {
  get(pathname: string): Promise<Asset | undefined>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

export function contentTypeFor(pathname: string): string {
  const dot = pathname.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return CONTENT_TYPES[pathname.slice(dot)] ?? 'application/octet-stream';
}

/**
 * Serve from a directory on disk.
 *
 * `pathname` is confined to the root: any request that resolves outside it is
 * refused rather than served. The viewer's own filenames are fixed, so this
 * only ever fires on a malformed or hostile request, which is exactly when it
 * needs to hold.
 */
export function diskAssets(root: string): AssetSource {
  const base = root.endsWith('/') ? root.slice(0, -1) : root;

  return {
    async get(pathname: string): Promise<Asset | undefined> {
      const relative = pathname.replace(/^\/+/, '');
      if (relative.length === 0) return undefined;
      // No traversal, no absolute escapes, no encoded separators.
      if (
        relative.includes('..') ||
        relative.includes('\\') ||
        relative.includes('\0')
      ) {
        return undefined;
      }

      const file = Bun.file(`${base}/${relative}`);
      if (!(await file.exists())) return undefined;

      return {
        body: new Uint8Array(await file.arrayBuffer()),
        contentType: contentTypeFor(relative),
      };
    },
  };
}

/** Serve from memory. Used by tests and by a single-binary deploy. */
export function memoryAssets(
  entries: Readonly<Record<string, string | Uint8Array>>
): AssetSource {
  const encoder = new TextEncoder();
  const table = new Map<string, Asset>();

  for (const [pathname, value] of Object.entries(entries)) {
    table.set(pathname.replace(/^\/+/, ''), {
      body: typeof value === 'string' ? encoder.encode(value) : value,
      contentType: contentTypeFor(pathname),
    });
  }

  return {
    async get(pathname: string): Promise<Asset | undefined> {
      return table.get(pathname.replace(/^\/+/, ''));
    },
  };
}

/**
 * Registers the service worker.
 *
 * Served as its own file rather than inline, because the shell's CSP is
 * `script-src 'self'` and adding `'unsafe-inline'` to accommodate three lines
 * of registration would weaken the one directive that matters most on the
 * origin holding the fragment.
 */
export const REGISTER_SW_JS = `if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((error) => {
    // A failed registration is logged to the console so syntax, evaluation,
    // or network errors are visible in DevTools rather than staying silent.
    // We log as a warning rather than throwing an unhandled rejection, so
    // viewers continue to function online even if caching cannot be established.
    console.warn('Service worker registration failed:', error);
  });

  // Recovery for a shell the worker cached before its code-split chunks were
  // part of the cache: viewer.js then imports a chunk the server no longer
  // has, the module graph fails, and the page never leaves its static plate.
  // The viewer marks the document once it has run, so a loaded page without
  // the mark is that failure. Drop the worker and its caches and reload once;
  // the fragment is still in the URL because the viewer never reached it.
  window.addEventListener('load', () => {
    if (document.documentElement.dataset.viewerBooted === '1') {
      try {
        sessionStorage.removeItem('relic:shell-heal');
      } catch {}
      return;
    }
    if (!document.querySelector('script[src="/assets/viewer.js"]')) return;
    try {
      if (sessionStorage.getItem('relic:shell-heal') !== null) return;
      sessionStorage.setItem('relic:shell-heal', '1');
    } catch {
      return;
    }
    void (async () => {
      try {
        for (const reg of await navigator.serviceWorker.getRegistrations()) {
          await reg.unregister();
        }
        for (const name of await caches.keys()) await caches.delete(name);
      } finally {
        location.reload();
      }
    })();
  });
}
`;
