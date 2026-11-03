/**
 * The service worker.
 *
 * It exists to make the viewer installable and to survive a bad connection.
 * It caches the app shell and **nothing else**, and that boundary is a
 * privacy control rather than a performance choice.
 *
 * Three things are never cached, ever:
 *
 * 1. **Relic ciphertext.** The signed download URL is short-lived by design,
 *    and the whole point of the TTL and the per-object cap is that content
 *    stops being reachable. A cache entry would quietly outlive both, on the
 *    recipient's disk, past a takedown.
 * 2. **Mint responses.** They carry a signed URL and a remaining-cap count,
 *    both of which are correct only at the instant they were issued.
 * 3. **Anything under `/api/`.** Same reason, stated as a path rule so a new
 *    endpoint inherits it without anybody remembering to.
 *
 * Previously, this file used a hand-maintained constant ('relic-shell-v1')
 * with a comment to bump on every deploy. Because nothing bumped it, deploys
 * never changed the sw.js bundle, install never re-ran, and returning visitors
 * remained pinned to whichever shell version they first cached.
 *
 * Even worse, sw.ts re-exported isCacheable so unit tests could import it,
 * causing the bundler to emit export syntax in sw.js. Because register-sw.js
 * registers a classic service worker, browsers rejected the script with a
 * syntax error during initial evaluation before a single event listener was
 * attached, and a bare catch swallowed the rejection.
 *
 * The rules and lifecycle helpers now live in sw-cache.ts, imported here without
 * re-exporting. This file is built as an IIFE classic script with zero export
 * statements and zero top-level imports.
 *
 * The cache name is derived at build time from a content hash of the emitted
 * shell assets (viewer.js, its code-split chunks, styles.css,
 * manifest.webmanifest). When any shell asset changes, the build injects a new build hash, altering SHELL_CACHE
 * and producing byte-different sw.js output. The browser sees the changed
 * sw.js on navigation or update check, runs install to fetch the new asset set
 * into the new cache generation, calls skipWaiting, and on activate purges
 * every older generation while claiming clients.
 *
 * This preserves generation atomicity wholesale: a reader never runs a new
 * viewer.js against an old styles.css. Per-request background revalidation
 * (stale-while-revalidate) in the fetch handler is deliberately omitted
 * because updating individual assets piecemeal would break this atomicity,
 * risking mismatched scripts and stylesheets if one fetch succeeds while
 * another fails. All shell updates proceed strictly through the service worker
 * install and activate lifecycle.
 */

/// <reference lib="webworker" />

import {
  activateShell,
  installShell,
  isCacheable,
  SHELL_ASSETS,
  shellCacheName,
} from './sw-cache.ts';

declare const self: ServiceWorkerGlobalScope;
declare const __BUILD_HASH__: string | undefined;
declare const __SHELL_CACHE__: string | undefined;
declare const __SHELL_ASSETS__: readonly string[] | undefined;

const SHELL_CACHE =
  typeof __SHELL_CACHE__ !== 'undefined'
    ? __SHELL_CACHE__
    : typeof __BUILD_HASH__ !== 'undefined'
      ? shellCacheName(__BUILD_HASH__)
      : shellCacheName();

// The build lists viewer.js together with every code-split chunk it imports.
// viewer.js names those chunks by content hash, so a generation that cached
// viewer.js alone served a script whose imports no longer existed after the
// next deploy.
const SHELL: readonly string[] =
  typeof __SHELL_ASSETS__ !== 'undefined' ? __SHELL_ASSETS__ : SHELL_ASSETS;

const inServiceWorker =
  typeof self !== 'undefined' &&
  'skipWaiting' in self &&
  typeof self.skipWaiting === 'function';

if (inServiceWorker) {
  self.addEventListener('install', (event) => {
    event.waitUntil(
      installShell(caches, SHELL_CACHE, SHELL, () => self.skipWaiting())
    );
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      activateShell(caches, SHELL_CACHE, () => self.clients.claim())
    );
  });

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    const sameOrigin = url.origin === self.location.origin;

    if (!isCacheable(url, sameOrigin, SHELL)) {
      // Explicitly not handled, so it goes straight to the network and never
      // touches a cache.
      return;
    }

    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetch(request))
    );
  });
}
