import { describe, expect, test } from 'bun:test';
import { assertClassicWorkerScript, computeShellHash } from '../build.ts';
import type { MinimalCache, MinimalCacheStorage } from '../src/sw-cache.ts';
import {
  activateShell,
  installShell,
  isCacheable,
  SHELL_ASSETS,
  shellCacheName,
} from '../src/sw-cache.ts';

class FakeCache implements MinimalCache {
  readonly entries = new Set<string>();

  async addAll(requests: string[]): Promise<void> {
    for (const req of requests) {
      this.entries.add(req);
    }
  }

  has(entry: string): boolean {
    return this.entries.has(entry);
  }
}

class FakeCacheStorage implements MinimalCacheStorage {
  readonly caches = new Map<string, FakeCache>();

  async open(cacheName: string): Promise<FakeCache> {
    let cache = this.caches.get(cacheName);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(cacheName, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return Array.from(this.caches.keys());
  }

  async delete(cacheName: string): Promise<boolean> {
    return this.caches.delete(cacheName);
  }

  has(cacheName: string): boolean {
    return this.caches.has(cacheName);
  }
}

describe('service worker shell cache generation', () => {
  test('two different build identities produce two different cache names, and identical builds produce the same name', () => {
    const buildIdA = 'a1b2c3d4e5f6';
    const buildIdB = 'f6e5d4c3b2a1';

    const nameA = shellCacheName(buildIdA);
    const nameB = shellCacheName(buildIdB);
    const nameAIdentical = shellCacheName(buildIdA);

    expect(nameA).not.toBe(nameB);
    expect(nameA).toBe(nameAIdentical);
    expect(nameA).toBe('relic-shell-a1b2c3d4e5f6');
    expect(nameB).toBe('relic-shell-f6e5d4c3b2a1');
  });

  test('computeShellHash returns distinct hashes for modified assets and identical hashes for matching assets', () => {
    const gen1 = [
      { path: '/assets/viewer.js', content: 'console.log("gen1");' },
      { path: '/assets/styles.css', content: 'body { color: black; }' },
      { path: '/manifest.webmanifest', content: '{"name":"Relic"}' },
    ];

    const gen2 = [
      { path: '/assets/viewer.js', content: 'console.log("gen2");' },
      { path: '/assets/styles.css', content: 'body { color: black; }' },
      { path: '/manifest.webmanifest', content: '{"name":"Relic"}' },
    ];

    const hash1 = computeShellHash(gen1);
    const hash2 = computeShellHash(gen2);
    const hash1Again = computeShellHash(gen1);

    expect(hash1).not.toBe(hash2);
    expect(hash1).toBe(hash1Again);

    const cache1 = shellCacheName(hash1);
    const cache2 = shellCacheName(hash2);
    expect(cache1).not.toBe(cache2);
  });

  test('activate deletes a cache from a previous generation and keeps the current one', async () => {
    const fakeStorage = new FakeCacheStorage();

    const gen1Cache = shellCacheName('build-hash-1111');
    const gen2Cache = shellCacheName('build-hash-2222');

    // Generation 1 was previously installed
    await fakeStorage.open(gen1Cache);
    expect(fakeStorage.has(gen1Cache)).toBe(true);

    // Generation 2 installs its own cache
    await fakeStorage.open(gen2Cache);
    expect(fakeStorage.has(gen2Cache)).toBe(true);

    let claimed = false;
    const deleted = await activateShell(fakeStorage, gen2Cache, () => {
      claimed = true;
    });

    expect(claimed).toBe(true);
    expect(deleted).toEqual([gen1Cache]);
    expect(fakeStorage.has(gen1Cache)).toBe(false);
    expect(fakeStorage.has(gen2Cache)).toBe(true);
  });

  test('install populates every entry of SHELL_ASSETS in the new generation', async () => {
    const fakeStorage = new FakeCacheStorage();
    const newGenCache = shellCacheName('build-hash-3333');

    let skipped = false;
    await installShell(fakeStorage, newGenCache, SHELL_ASSETS, () => {
      skipped = true;
    });

    expect(skipped).toBe(true);
    expect(fakeStorage.has(newGenCache)).toBe(true);

    const cache = await fakeStorage.open(newGenCache);
    for (const asset of SHELL_ASSETS) {
      expect(cache.has(asset)).toBe(true);
    }
    expect(cache.entries.size).toBe(SHELL_ASSETS.length);
  });

  test('isCacheable still refuses cross-origin, /api/, and non-shell paths', () => {
    const origin = (path: string) => new URL(`https://relic.example${path}`);

    // Refuses cross-origin requests
    expect(
      isCacheable(new URL('https://storage.googleapis.com/o/abc'), false)
    ).toBe(false);
    expect(
      isCacheable(new URL('https://other.origin/assets/viewer.js'), false)
    ).toBe(false);

    // Refuses /api/ paths on same origin
    expect(isCacheable(origin('/api/relics/abc/mint'), true)).toBe(false);
    expect(isCacheable(origin('/api/grant'), true)).toBe(false);
    expect(isCacheable(origin('/api/anything-added-later'), true)).toBe(false);

    // Refuses non-shell paths on same origin
    expect(isCacheable(origin('/'), true)).toBe(false);
    expect(isCacheable(origin('/aaaaaaaaaaaaaaaaaaaaaaaaaa'), true)).toBe(
      false
    );
    expect(isCacheable(origin('/assets/pdf.worker.js'), true)).toBe(false);
    expect(
      isCacheable(origin('/assets/otio-video-timing-worker.js'), true)
    ).toBe(false);
    expect(isCacheable(origin('/assets/card.v1.png'), true)).toBe(false);
    expect(isCacheable(origin('/card.v1.png'), true)).toBe(false);
    expect(isCacheable(origin('/assets/chunk-12345678.js'), true)).toBe(false);
    expect(isCacheable(origin('/assets/home.js'), true)).toBe(false);

    // Allows exact shell assets on same origin
    expect(isCacheable(origin('/assets/viewer.js'), true)).toBe(true);
    expect(isCacheable(origin('/assets/styles.css'), true)).toBe(true);
    expect(isCacheable(origin('/manifest.webmanifest'), true)).toBe(true);
  });
});

describe('classic service worker script guards', () => {
  test('assertClassicWorkerScript rejects scripts containing export syntax', () => {
    expect(() => {
      assertClassicWorkerScript('export function isCacheable() {}');
    }).toThrow('forbidden "export" syntax');

    expect(() => {
      assertClassicWorkerScript('export { a as b };');
    }).toThrow('forbidden "export" syntax');

    expect(() => {
      assertClassicWorkerScript('export default 42;');
    }).toThrow('forbidden "export" syntax');
  });

  test('assertClassicWorkerScript rejects scripts containing import syntax', () => {
    expect(() => {
      assertClassicWorkerScript('import { foo } from "./foo.js";');
    }).toThrow('forbidden "import" syntax');

    expect(() => {
      assertClassicWorkerScript('import "./side-effect.js";');
    }).toThrow('forbidden "import" syntax');
  });

  test('assertClassicWorkerScript rejects invalid script syntax', () => {
    expect(() => {
      assertClassicWorkerScript('function broken(');
    }).toThrow('fails classic script syntax evaluation');
  });

  test('assertClassicWorkerScript accepts valid classic script bodies', () => {
    expect(() => {
      assertClassicWorkerScript(
        '(()=>{self.addEventListener("install",()=>{});})();'
      );
    }).not.toThrow();
  });

  test('the emitted dist/sw.js artifact parses as a classic script with no module syntax', async () => {
    const pkgDir = new URL('..', import.meta.url).pathname;
    const swPath = `${pkgDir}dist/sw.js`;
    const swText = await Bun.file(swPath).text();

    expect(swText.length).toBeGreaterThan(0);
    expect(/\bexport\b/.test(swText)).toBe(false);
    expect(/\bimport\s*[{*"'\w]/.test(swText)).toBe(false);
    expect(swText).toContain('relic-shell-');

    // Asserts clean parsing via the guard
    expect(() => assertClassicWorkerScript(swText)).not.toThrow();
  });
});
