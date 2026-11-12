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

import { assertPatchedPdfWorker } from '../build.ts';

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
 * the same number in bytes (486400). Change both together. The guards below
 * measure the file's bytes, as that smoke does, not its UTF-16 length.
 */
const SHELL_CEILING_BYTES = 475 * 1024;

/** Strings only the windowed source renderer emits, never its shell bridge. */
const TEXT_WINDOW_MARKERS = [
  'relic:text-window-paint',
  'text-window-page',
  'text-window-scroll',
];

/** The asset list the built service worker precaches on install. */
async function precachedAssets(): Promise<string[]> {
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
  if (!install) throw new Error('built service worker has no install listener');
  let installation: Promise<unknown> | undefined;
  install({
    waitUntil(work: Promise<unknown>) {
      installation = work;
    },
  });
  if (!installation)
    throw new Error('install handler did not schedule cache work');
  await installation;
  return requests;
}

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

    expect(Bun.file(`${pkgDir}dist/viewer.js`).size).toBeLessThan(
      SHELL_CEILING_BYTES
    );
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

    expect(Bun.file(`${pkgDir}dist/viewer.js`).size).toBeLessThan(
      SHELL_CEILING_BYTES
    );

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

  test('keeps the JSX compiler out of the eager shell', async () => {
    // Sucrase is the compiler. Routing loads it on demand from its own chunk,
    // so nothing reachable from viewer.js through static imports may carry it.
    for (const stale of new Bun.Glob('chunk-*.js').scanSync(`${pkgDir}dist`)) {
      await unlink(`${pkgDir}dist/${stale}`).catch(() => {});
    }
    const built = Bun.spawnSync([process.execPath, 'build.ts'], {
      cwd: pkgDir,
    });
    expect(built.exitCode).toBe(0);

    const markers = [
      'enableLegacyTypeScriptModuleInterop',
      'jsxFragmentPragma',
    ];
    const staticImport = /(?:from|import)\s*"\.\/(chunk-[a-z0-9]+\.js)"/g;

    // The static closure of viewer.js: every chunk it reaches without import().
    const eager = new Map<string, string>();
    const pending = ['viewer.js'];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (eager.has(next)) continue;
      const text = await Bun.file(`${pkgDir}dist/${next}`).text();
      eager.set(next, text);
      for (const match of text.matchAll(staticImport)) {
        if (match[1] !== undefined) pending.push(match[1]);
      }
    }
    const leaked = [...eager]
      .filter(([, text]) => markers.some((marker) => text.includes(marker)))
      .map(([file]) => file);
    expect(leaked).toEqual([]);

    const chunks = [...new Bun.Glob('chunk-*.js').scanSync(`${pkgDir}dist`)];
    const carriers: string[] = [];
    for (const chunk of chunks) {
      const text = await Bun.file(`${pkgDir}dist/${chunk}`).text();
      if (markers.every((marker) => text.includes(marker)))
        carriers.push(chunk);
    }
    expect(carriers).toHaveLength(1);

    // Routing may live in any eagerly imported shell chunk after code splitting.
    expect(
      [...eager.values()].some((text) =>
        text.includes(`import("./${carriers[0]}")`)
      )
    ).toBe(true);
  });

  test('loads dashboard search on demand, not in viewer.js', async () => {
    // Runs on the clean build above, so no stale chunk can satisfy it.
    const marker = 'Reading contents, ';
    const shell = await Bun.file(`${pkgDir}dist/viewer.js`).text();
    expect(shell.includes(marker)).toBe(false);

    let carriers = 0;
    for (const chunk of new Bun.Glob('chunk-*.js').scanSync(`${pkgDir}dist`)) {
      const content = await Bun.file(`${pkgDir}dist/${chunk}`).text();
      if (content.includes(marker)) carriers++;
    }
    expect(carriers).toBe(1);
  });

  test('loads the windowed source renderer on demand, as a precached chunk', async () => {
    // Runs on the clean build above, so no stale chunk can satisfy it.
    const shell = await Bun.file(`${pkgDir}dist/viewer.js`).text();
    expect(
      TEXT_WINDOW_MARKERS.filter((marker) => shell.includes(marker))
    ).toEqual([]);

    const carriers: string[] = [];
    for (const chunk of new Bun.Glob('chunk-*.js').scanSync(`${pkgDir}dist`)) {
      const content = await Bun.file(`${pkgDir}dist/${chunk}`).text();
      if (TEXT_WINDOW_MARKERS.every((marker) => content.includes(marker)))
        carriers.push(chunk);
    }
    expect(carriers).toHaveLength(1);
    // viewer.js imports it by its content-hashed name.
    expect(shell).toContain(carriers[0]!);
    expect(await precachedAssets()).toContain(`/assets/${carriers[0]}`);
  });

  test('loads the Word exporter on demand, as a precached chunk', async () => {
    // Runs on the clean build above. The converter is the docx library, and
    // every reader of every relic would otherwise download it to open a page.
    const shell = await Bun.file(`${pkgDir}dist/viewer.js`).text();
    const marker = 'wordprocessingml';
    expect(shell.includes(marker)).toBe(false);

    const carriers: string[] = [];
    for (const chunk of new Bun.Glob('chunk-*.js').scanSync(`${pkgDir}dist`)) {
      const content = await Bun.file(`${pkgDir}dist/${chunk}`).text();
      if (content.includes(marker)) carriers.push(chunk);
    }
    expect(carriers).toHaveLength(1);
    expect(shell).toContain(carriers[0]!);
    expect(await precachedAssets()).toContain(`/assets/${carriers[0]}`);
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
    assertPatchedPdfWorker(await worker.text());
  });

  test('rejects incomplete or altered PDF worker patches', async () => {
    const worker = await Bun.file(`${pkgDir}dist/pdf.worker.js`).text();
    const sites = [
      {
        name: 'Linearization.create',
        source: `      lexer: new IndirectObjectLexer(stream),
      xref: null
    });
    const obj1 = parser.getObj();`,
      },
      {
        name: 'XRef.readXRef',
        source: `        stream.pos = startXRef + stream.start;
        const parser = new Parser({
          lexer: new IndirectObjectLexer(stream),`,
      },
      {
        name: 'XRef.fetchUncompressed',
        source: `    const stream = this.stream.makeSubStream(xrefEntry.offset + this.stream.start);
    const parser = new Parser({
      lexer: new IndirectObjectLexer(stream),`,
      },
    ];
    for (const { name, source } of sites) {
      expect(worker).toContain(source);
      const mutated = worker.replace(
        source,
        source.replace('new IndirectObjectLexer(stream)', 'new Lexer(stream)')
      );
      expect(() => assertPatchedPdfWorker(mutated)).toThrow(name);
    }

    const endCondition = 'this.#ended = this.#openers.length === 0;';
    expect(worker).toContain(endCondition);
    expect(() =>
      assertPatchedPdfWorker(
        worker.replace(endCondition, 'this.#ended = false;')
      )
    ).toThrow('contents');

    const notice =
      'Modified by The Bushido Collective: stop indirect-object lookahead at endobj';
    expect(worker).toContain(notice);
    expect(() =>
      assertPatchedPdfWorker(worker.replace(notice, 'Modified worker'))
    ).toThrow('contents');

    expect(() =>
      assertPatchedPdfWorker(
        worker.replace(
          'class Linearization {',
          'new IndirectObjectLexer(stream);\nclass Linearization {'
        )
      )
    ).toThrow('exactly three');
  });

  test('ships the OTIO demuxer as a licensed worker asset outside shell requests', async () => {
    const built = Bun.spawnSync([process.execPath, 'build.ts'], {
      cwd: pkgDir,
    });
    expect(built.exitCode).toBe(0);

    const shell = Bun.file(`${pkgDir}dist/viewer.js`);
    const timingWorker = Bun.file(`${pkgDir}dist/otio-video-timing-worker.js`);
    const pcmWorker = Bun.file(`${pkgDir}dist/otio-audio-pcm-worker.js`);
    const gateWorklet = Bun.file(
      `${pkgDir}dist/otio-transport-gate-worklet.js`
    );
    const distributedLicense = Bun.file(`${pkgDir}dist/mediabunny-license.txt`);
    const installedLicense = Bun.file(
      `${pkgDir}node_modules/mediabunny/LICENSE`
    );

    const timingWorkerText = await timingWorker.text();
    const shellText = await shell.text();
    expect(await timingWorker.exists()).toBe(true);
    expect(await pcmWorker.exists()).toBe(true);
    expect(await gateWorklet.exists()).toBe(true);
    expect(await gateWorklet.text()).toContain('otio-transport-gate');
    expect(await pcmWorker.text()).toContain('Mediabunny 1.62.0 by Vanilagy');
    expect(await distributedLicense.exists()).toBe(true);
    expect(timingWorker.size).toBeGreaterThan(50 * 1024);
    expect(timingWorkerText).toContain(
      'Mediabunny 1.62.0 by Vanilagy and contributors; MPL-2.0; license: /assets/mediabunny-license.txt; source: https://registry.npmjs.org/mediabunny/-/mediabunny-1.62.0.tgz'
    );
    expect(timingWorkerText).toContain('metadataOnly');
    expect(shellText).not.toContain('metadataOnly');
    expect(await distributedLicense.text()).toBe(await installedLicense.text());
    expect(shellText).not.toContain('Mediabunny 1.62.0 by Vanilagy');

    const requests = await precachedAssets();
    expect(requests).toContain('/assets/viewer.js');
    expect(requests).not.toContain('/assets/otio-video-timing-worker.js');
    expect(requests).not.toContain('/assets/otio-audio-pcm-worker.js');
    expect(requests).not.toContain('/assets/otio-transport-gate-worklet.js');
    expect(requests).not.toContain('/assets/mediabunny-license.txt');
  });

  test('keeps the private reader out of the shell, in exactly one lazy chunk', async () => {
    const built = Bun.spawnSync([process.execPath, 'build.ts'], {
      cwd: pkgDir,
    });
    expect(built.exitCode).toBe(0);

    // The private-share copy and the owner pin storage key. The shell must
    // carry none of them, and exactly one lazy chunk must carry them: the
    // reader that loads on a private relic.
    const markers = [
      'Read this fingerprint',
      'private-share key',
      'relic:owner-pins',
    ];
    const shell = await Bun.file(`${pkgDir}dist/viewer.js`).text();
    expect(markers.filter((marker) => shell.includes(marker))).toEqual([]);

    const chunks = [...new Bun.Glob('chunk-*.js').scanSync(`${pkgDir}dist`)];
    const carriers: string[] = [];
    for (const chunk of chunks) {
      const content = await Bun.file(`${pkgDir}dist/${chunk}`).text();
      if (markers.some((marker) => content.includes(marker))) {
        carriers.push(chunk);
      }
    }
    expect(carriers).toHaveLength(1);
  });
});
