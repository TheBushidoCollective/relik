/**
 * The app shell must not carry the PDF renderer.
 *
 * This exists because the split was incidental rather than enforced, and an
 * incidental split is one toolchain bump away from being no split at all.
 *
 * The renderer is ~430 KB. Bundled into the shell it took `viewer.js` from
 * 303,891 bytes to 741,279, and the shell is what every reader of every
 * relic downloads, cached wholesale by the service worker, for a renderer
 * most of them never invoke. Nothing about `import()` guarantees a separate
 * chunk: it is the bundler's choice, so the guarantee has to be checked
 * rather than assumed.
 *
 * Two assertions, because either alone can pass while the property is lost.
 * A ceiling catches the renderer arriving inline even under a bundler that
 * renames everything. A marker check catches it arriving while still under
 * the ceiling, and names what leaked.
 */

import { describe, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';

const pkgDir = new URL('..', import.meta.url).pathname;

/**
 * Generous against the measured shell, tight against the failure.
 *
 * The shell measured 465,448 bytes with the sign-in code entry included and
 * ~890 KB with the PDF renderer inline. 475 KiB sits safely above the first
 * and far below the second, so ordinary growth does not trip it and the
 * regression cannot hide under it.
 *
 * The smoke test of the deployed shell in .github/workflows/deploy.yml holds
 * the same number in bytes (486400). Change both together.
 */
const SHELL_CEILING_BYTES = 475 * 1024;

describe('the app shell', () => {
  test('does not carry the PDF renderer', async () => {
    const built = Bun.spawnSync([process.execPath, 'build.ts'], {
      cwd: pkgDir,
    });
    expect(built.exitCode).toBe(0);

    const shell = await Bun.file(`${pkgDir}dist/viewer.js`).text();

    // Identifiers pdf.js exports and cannot be minified away, because they
    // are public API names the module boundary preserves.
    const markers = ['GlobalWorkerOptions', 'getDocument', 'PDFWorker'];
    const inlined = markers.filter((marker) => shell.includes(marker));
    expect(inlined).toEqual([]);

    expect(shell.length).toBeLessThan(SHELL_CEILING_BYTES);
  });

  test('does not carry the mnemonic wordlist', async () => {
    const shell = await Bun.file(`${pkgDir}dist/viewer.js`).text();

    // The mnemonic wordlist must be split out and loaded dynamically on demand,
    // never bundled into the eager viewer.js shell.
    const wordlistMarkers = ['WORDLIST_SIZE', 'aardvark', 'abacus'];
    const inlined = wordlistMarkers.filter((marker) => shell.includes(marker));
    expect(inlined).toEqual([]);

    // The mnemonic module must be emitted in a chunk rather than missing entirely.
    const chunks = [...new Bun.Glob('chunk-*.js').scanSync(`${pkgDir}dist`)];
    let carriesMnemonic = false;
    for (const chunk of chunks) {
      const content = await Bun.file(`${pkgDir}dist/${chunk}`).text();
      if (
        content.includes('WORDLIST_SIZE') ||
        content.includes('isMnemonicLike') ||
        content.includes('mnemonicToKey')
      ) {
        carriesMnemonic = true;
      }
    }
    expect(carriesMnemonic).toBe(true);
  });
  test('keeps passkey sign-in and ceremony controller out of viewer.js', async () => {
    for (const stale of new Bun.Glob('chunk-*.js').scanSync(`${pkgDir}dist`)) {
      await unlink(`${pkgDir}dist/${stale}`).catch(() => {});
    }
    const built = Bun.spawnSync([process.execPath, 'build.ts'], {
      cwd: pkgDir,
    });
    expect(built.exitCode).toBe(0);

    const shell = await Bun.file(`${pkgDir}dist/viewer.js`).text();

    const markers = [
      'isConditionalMediationAvailable',
      'authenticatorData',
      'A newer passkey request replaced this one',
    ];
    const inlined = markers.filter((marker) => shell.includes(marker));
    expect(inlined).toEqual([]);

    expect(shell.length).toBeLessThan(SHELL_CEILING_BYTES);

    const chunks = [...new Bun.Glob('chunk-*.js').scanSync(`${pkgDir}dist`)];
    let chunksWithCeremonyAborted = 0;
    let chunkWithSignInText = false;
    for (const chunk of chunks) {
      const content = await Bun.file(`${pkgDir}dist/${chunk}`).text();
      if (content.includes('A newer passkey request replaced this one')) {
        chunksWithCeremonyAborted++;
      }
      if (content.includes('Sign in with passkey')) {
        chunkWithSignInText = true;
      }
    }
    expect(chunksWithCeremonyAborted).toBe(1);
    expect(chunkWithSignInText).toBe(true);
  });

  test('the renderer is emitted as its own chunk', async () => {
    // The other half of the same property. An empty `dist` with no chunk at
    // all would satisfy the shell assertions above while shipping a viewer
    // that cannot open a pdf.
    const chunks = [...new Bun.Glob('chunk-*.js').scanSync(`${pkgDir}dist`)];
    expect(chunks.length).toBeGreaterThan(0);

    let carriesRenderer = false;
    for (const chunk of chunks) {
      const content = await Bun.file(`${pkgDir}dist/${chunk}`).text();
      if (content.includes('GlobalWorkerOptions')) carriesRenderer = true;
    }
    expect(carriesRenderer).toBe(true);
  });

  test('the worker is a separate same-origin asset', async () => {
    // Served from `/assets/`, never a CDN: the viewing origin's CSP allows
    // `script-src 'self'` and nothing else, so a remote worker URL would be
    // refused by the browser rather than by review.
    const worker = Bun.file(`${pkgDir}dist/pdf.worker.js`);
    expect(await worker.exists()).toBe(true);
    expect(worker.size).toBeGreaterThan(0);
  });

  test('ships the OTIO demuxer as a licensed worker asset outside shell requests', async () => {
    const built = Bun.spawnSync([process.execPath, 'build.ts'], {
      cwd: pkgDir,
    });
    expect(built.exitCode).toBe(0);

    const shell = Bun.file(`${pkgDir}dist/viewer.js`);
    const timingWorker = Bun.file(`${pkgDir}dist/otio-video-timing-worker.js`);
    const distributedLicense = Bun.file(`${pkgDir}dist/mediabunny-license.txt`);
    const installedLicense = Bun.file(
      `${pkgDir}node_modules/mediabunny/LICENSE`
    );

    const timingWorkerText = await timingWorker.text();
    const shellText = await shell.text();
    expect(await timingWorker.exists()).toBe(true);
    expect(await distributedLicense.exists()).toBe(true);
    expect(timingWorker.size).toBeGreaterThan(50 * 1024);
    expect(timingWorkerText).toContain(
      'Mediabunny 1.62.0 by Vanilagy and contributors; MPL-2.0; license: /assets/mediabunny-license.txt; source: https://registry.npmjs.org/mediabunny/-/mediabunny-1.62.0.tgz'
    );
    expect(timingWorkerText).toContain('metadataOnly');
    expect(shellText).not.toContain('metadataOnly');
    expect(await distributedLicense.text()).toBe(await installedLicense.text());
    expect(shellText).not.toContain('Mediabunny 1.62.0 by Vanilagy');

    const sw = await Bun.file(`${pkgDir}dist/sw.js`).text();
    const listeners = new Map<string, (event: unknown) => void>();
    const requests: string[] = [];
    const workerScope = {
      skipWaiting: () => undefined,
      clients: { claim: () => undefined },
      addEventListener(name: string, listener: (event: unknown) => void) {
        listeners.set(name, listener);
      },
    };
    const caches = {
      open: async () => ({
        addAll: async (assets: string[]) => {
          requests.push(...assets);
        },
      }),
      keys: async () => [],
      delete: async () => true,
      match: async () => undefined,
    };
    new Function('self', 'caches', sw)(workerScope, caches);
    const install = listeners.get('install');
    if (!install)
      throw new Error('built service worker has no install listener');
    let installation: Promise<unknown> | undefined;
    install({
      waitUntil(work: Promise<unknown>) {
        installation = work;
      },
    });
    if (!installation)
      throw new Error('install handler did not schedule cache work');
    await installation;

    expect(requests).toContain('/assets/viewer.js');
    expect(requests).not.toContain('/assets/otio-video-timing-worker.js');
    expect(requests).not.toContain('/assets/mediabunny-license.txt');
  });
});
