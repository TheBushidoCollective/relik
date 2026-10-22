/**
 * Bundles the viewer into `dist/`, which the app server serves as `/assets/`.
 *
 * Five entry points, deliberately separate bundles. `viewer.js` runs on the
 * service origin and holds the key. `home.js` runs on the service origin on the
 * landing page to render the local vault relic list without key handling or
 * network requests. `sandbox.js` runs on the usercontent origin and must never
 * contain a line of key-handling code, which staying a separate entry point
 * makes true by construction rather than by review. `sw.js` is the service
 * worker and has to sit at the root scope. `otio-video-timing-worker.js` alone
 * carries the metadata demuxer.
 */

import { copyFile, mkdir, readdir } from 'node:fs/promises';

const pkgDir = new URL('.', import.meta.url).pathname;

interface MediabunnyDistribution {
  readonly version: string;
  readonly licensePath: string;
  readonly banner: string;
}

async function readMediabunnyDistribution(): Promise<MediabunnyDistribution> {
  const viewerPackage = (await Bun.file(`${pkgDir}package.json`).json()) as {
    dependencies?: Record<string, unknown>;
  };
  const dependency = viewerPackage.dependencies?.mediabunny;
  const packagePath = new URL(
    './node_modules/mediabunny/package.json',
    import.meta.url
  ).pathname;
  const installed = (await Bun.file(packagePath).json()) as {
    version?: unknown;
  };
  const version = installed.version;
  if (
    dependency !== version ||
    typeof version !== 'string' ||
    version !== '1.62.0'
  ) {
    throw new Error(
      `Expected installed mediabunny@1.62.0, found ${String(version)}`
    );
  }

  const source = `https://registry.npmjs.org/mediabunny/-/mediabunny-${version}.tgz`;
  return {
    version,
    licensePath: new URL('./node_modules/mediabunny/LICENSE', import.meta.url)
      .pathname,
    banner:
      `/*! Mediabunny ${version} by Vanilagy and contributors; MPL-2.0; ` +
      `license: /assets/mediabunny-license.txt; source: ${source} */`,
  };
}

/**
 * Computes a deterministic content hash over the shell assets that sw.ts precaches.
 * Any change to viewer.js, styles.css, or manifest.webmanifest alters this hash,
 * which in turn updates SHELL_CACHE and the sw.js bundle bytes.
 */
export function computeShellHash(
  assets: Array<{ path: string; content: Uint8Array | string }>
): string {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const asset of assets) {
    hasher.update(asset.path);
    hasher.update('\0');
    hasher.update(asset.content);
    hasher.update('\0');
  }
  return hasher.digest('hex').slice(0, 16);
}

/**
 * Asserts that the emitted service worker bundle is a valid classic script.
 * Classic service workers in all browsers (including Firefox) fail evaluation
 * immediately if any export keyword or top-level import statement is present.
 */
export function assertClassicWorkerScript(code: string): void {
  if (/\bexport\b/.test(code)) {
    throw new Error(
      'Emitted sw.js contains forbidden "export" syntax; classic service workers fail evaluation on module syntax'
    );
  }
  if (/\bimport\s*[{*"'\w]/.test(code)) {
    throw new Error(
      'Emitted sw.js contains forbidden "import" syntax; classic service workers fail evaluation on module syntax'
    );
  }
  try {
    new Function(code);
  } catch (error) {
    throw new Error(
      `Emitted sw.js fails classic script syntax evaluation: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function buildViewer(options?: {
  outdir?: string;
}): Promise<string> {
  const out = options?.outdir ?? `${pkgDir}dist/`;
  await mkdir(out, { recursive: true });
  const mediabunny = await readMediabunnyDistribution();

  // Three builds, because exactly one entrypoint wants code splitting and the
  // others must not have it. `main.ts` dynamically imports the PDF renderer,
  // and splitting is what keeps that 429 KB out of the app shell. `home.ts`
  // runs on the landing page and must not share code chunks with `main.ts`.
  // `sandbox.ts` is inlined into an HTML document served from the opaque
  // usercontent origin, so a chunk import in it would be a request that document
  // cannot make; `sw.ts` is a service worker, which cannot import a sibling
  // chunk either.
  const built = await Bun.build({
    entrypoints: [`${pkgDir}src/main.ts`],
    outdir: out,
    target: 'browser',
    format: 'esm',
    minify: true,
    splitting: true,
    naming: '[name].js',
    // React picks its development or production build by reading
    // `process.env.NODE_ENV`; with no define the bundler keeps the development
    // branch, which roughly doubles the sandbox page the build then inlines.
    // Nothing in this repo branches on NODE_ENV itself.
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  if (!built.success) {
    for (const log of built.logs) console.error(log);
    process.exit(1);
  }

  const builtSandbox = await Bun.build({
    entrypoints: [`${pkgDir}src/sandbox.ts`],
    outdir: out,
    target: 'browser',
    format: 'esm',
    minify: true,
    splitting: false,
    naming: '[name].js',
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  if (!builtSandbox.success) {
    for (const log of builtSandbox.logs) console.error(log);
    process.exit(1);
  }
  const builtHome = await Bun.build({
    entrypoints: [`${pkgDir}src/home.ts`],
    outdir: out,
    target: 'browser',
    format: 'esm',
    minify: true,
    splitting: false,
    naming: '[name].js',
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  if (!builtHome.success) {
    for (const log of builtHome.logs) console.error(log);
    process.exit(1);
  }

  // The metadata scanner has a deliberately separate entrypoint. Unlike the
  // app shell, it may bundle the demuxer, and must never share a chunk with it.
  const builtTimingWorker = await Bun.build({
    entrypoints: [`${pkgDir}src/otio-video-timing-worker.ts`],
    outdir: out,
    target: 'browser',
    format: 'esm',
    minify: true,
    splitting: false,
    naming: '[name].js',
    banner: mediabunny.banner,
  });
  if (!builtTimingWorker.success) {
    for (const log of builtTimingWorker.logs) console.error(log);
    process.exit(1);
  }

  // `main.js` is served as `viewer.js`, because that is the name the shell and
  // the service worker's cache list both reference.
  await copyFile(`${out}main.js`, `${out}viewer.js`);
  await copyFile(`${pkgDir}src/styles.css`, `${out}styles.css`);

  for (const name of await readdir(`${pkgDir}public`)) {
    await copyFile(`${pkgDir}public/${name}`, `${out}${name}`);
  }

  const workerPath = new URL(
    './node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).pathname;
  await copyFile(workerPath, `${out}pdf.worker.js`);
  const timingWorkerPath = `${out}otio-video-timing-worker.js`;
  if (!(await Bun.file(timingWorkerPath).exists())) {
    throw new Error('Timing worker build did not emit its fixed worker asset');
  }
  await copyFile(mediabunny.licensePath, `${out}mediabunny-license.txt`);

  /**
   * Inline the sandbox bundle into its page, rather than linking it.
   *
   * The frame is deliberately given no `allow-same-origin`, which puts its
   * document in an opaque origin. Every request that document makes is
   * therefore cross-origin with `Origin: null`, and a `type="module"` script is
   * fetched with CORS semantics. With no `Access-Control-Allow-Origin` on the
   * response the browser refuses the module, the script never runs, the frame
   * never announces itself, and the parent's markup is posted to a listener that
   * does not exist. The visible result is a blank frame and an empty console,
   * because the failure is in the frame's origin and not the page's.
   *
   * Relaxing CORS on the asset would fix the symptom by making the usercontent
   * origin serve something cross-origin, which is the property that origin
   * exists to remove. An inline script fetches nothing, so there is no request
   * to be blocked and no header anybody can regress.
   *
   * This runs after the copy above, which would otherwise put the linked version
   * back.
   */
  const SCRIPT_TAG = '<script type="module" src="/assets/sandbox.js"></script>';

  const shell = await Bun.file(`${pkgDir}public/sandbox.html`).text();
  if (!shell.includes(SCRIPT_TAG)) {
    console.error(
      'sandbox.html no longer contains the expected script tag, so the bundle ' +
        'would ship linked instead of inlined and the frame would never render'
    );
    process.exit(1);
  }

  const sandboxJs = await Bun.file(`${out}sandbox.js`).text();
  await Bun.write(
    `${out}sandbox.html`,
    shell.replace(
      SCRIPT_TAG,
      // A `</script` anywhere in the bundle would close the tag early. Minified
      // output has no reason to contain one, which is exactly why it would go
      // unnoticed if it ever did.
      //
      // The replacement is a function, not a string, because the bundle now
      // carries React and minified React contains `$&`. In a string
      // replacement that expands to the matched script tag, splicing tag
      // fragments into the code and shipping a bundle that cannot parse.
      () =>
        `<script type="module">${sandboxJs.replace(/<\/script/gi, '<\\/script')}</script>`
    )
  );

  // Compute the shell asset hash across viewer.js, styles.css, and manifest.webmanifest.
  // This build identity is injected into sw.ts so SHELL_CACHE changes on every deploy
  // that modifies shell assets, making sw.js byte-different and forcing an update.
  const shellAssetFiles = [
    { path: '/assets/viewer.js', file: `${out}viewer.js` },
    { path: '/assets/styles.css', file: `${out}styles.css` },
    { path: '/manifest.webmanifest', file: `${out}manifest.webmanifest` },
  ];

  const assetBuffers = await Promise.all(
    shellAssetFiles.map(async ({ path, file }) => ({
      path,
      content: new Uint8Array(await Bun.file(file).arrayBuffer()),
    }))
  );

  const buildHash = computeShellHash(assetBuffers);

  // sw.ts is bundled as an IIFE classic script so it runs in every browser
  // without module support requirements (Firefox lacks module service workers).
  // It must never emit export or top-level import syntax.
  const builtSw = await Bun.build({
    entrypoints: [`${pkgDir}src/sw.ts`],
    outdir: out,
    target: 'browser',
    format: 'iife',
    minify: true,
    splitting: false,
    naming: '[name].js',
    define: {
      'process.env.NODE_ENV': '"production"',
      __BUILD_HASH__: JSON.stringify(buildHash),
      __SHELL_CACHE__: JSON.stringify(`relic-shell-${buildHash}`),
    },
  });

  if (!builtSw.success) {
    for (const log of builtSw.logs) console.error(log);
    process.exit(1);
  }

  // Build-time guard: verify that the emitted sw.js parses as a classic worker
  // script and contains no module syntax. Classic service workers fail evaluation
  // completely if any export/import is present.
  const swText = await Bun.file(`${out}sw.js`).text();
  assertClassicWorkerScript(swText);

  const names = (await readdir(out)).sort();
  console.log(
    `built ${names.length} assets (shell hash: ${buildHash}): ${names.join(', ')}`
  );

  return buildHash;
}

export const FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; worker-src 'none'; form-action 'none'; base-uri 'none'";

export const FRAME_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`;

export async function buildCover(options?: { outdir?: string }): Promise<void> {
  const out = options?.outdir ?? `${pkgDir}dist/cover/`;
  await mkdir(out, { recursive: true });

  const builtCover = await Bun.build({
    entrypoints: [`${pkgDir}src/cover/main.ts`],
    outdir: out,
    target: 'browser',
    format: 'esm',
    minify: false,
    splitting: false,
    naming: 'cover.js',
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  if (!builtCover.success) {
    for (const log of builtCover.logs) console.error(log);
    throw new Error('Failed to bundle cover.js');
  }

  const builtSandbox = await Bun.build({
    entrypoints: [`${pkgDir}src/sandbox.ts`],
    target: 'browser',
    format: 'esm',
    minify: false,
    splitting: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  if (!builtSandbox.success) {
    for (const log of builtSandbox.logs) console.error(log);
    throw new Error('Failed to bundle sandbox for frame.html');
  }

  const output = builtSandbox.outputs[0];
  if (!output) {
    throw new Error('Failed to bundle sandbox for frame.html');
  }
  const sandboxJs = await output.text();
  const SCRIPT_TAG = '<script type="module" src="/assets/sandbox.js"></script>';
  const shell = await Bun.file(`${pkgDir}public/sandbox.html`).text();
  if (!shell.includes(SCRIPT_TAG)) {
    throw new Error('sandbox.html does not contain the expected script tag');
  }

  let frameHtml = shell.replace(
    SCRIPT_TAG,
    () =>
      `<script type="module">${sandboxJs.replace(/<\/script/gi, '<\\/script')}</script>`
  );

  if (frameHtml.includes('<head>')) {
    frameHtml = frameHtml.replace('<head>', `<head>\n${FRAME_CSP_META}`);
  } else {
    frameHtml = frameHtml.replace(
      '<!doctype html>\n',
      `<!doctype html>\n${FRAME_CSP_META}\n`
    );
  }

  await Bun.write(`${out}frame.html`, frameHtml);

  await copyFile(`${pkgDir}src/styles.css`, `${out}styles.css`);
  await copyFile(`${pkgDir}src/cover/cover.css`, `${out}cover.css`);

  const indexHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=600, height=315, initial-scale=1">
  <title>Cover</title>
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/cover.css">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/cover.js"></script>
</body>
</html>
`;
  await Bun.write(`${out}index.html`, indexHtml);

  const workerPath = new URL(
    './node_modules/pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  ).pathname;
  await copyFile(workerPath, `${out}pdf.worker.mjs`);
}

if (import.meta.main) {
  await buildViewer();
}
