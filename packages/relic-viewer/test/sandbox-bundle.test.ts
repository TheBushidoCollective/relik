import { describe, expect, test } from 'bun:test';

/**
 * The shipped sandbox page must carry everything it runs.
 *
 * The frame is not allowed to reach the network, and an opaque origin could
 * not fetch its own origin's assets even if it were, so the build inlines
 * the whole sandbox bundle, React and ReactDOM included, into sandbox.html.
 * These checks read the artifact the build actually emits, so a CDN import
 * reintroduced in the source fails here instead of shipping silently.
 */

const pkgDir = new URL('..', import.meta.url).pathname;

describe('the built sandbox.html', () => {
  test('inlines the bundle with React inside and no external script', async () => {
    // Build for real rather than trusting a dist/ that may predate the
    // change under test.
    const built = Bun.spawnSync([process.execPath, 'build.ts'], {
      cwd: pkgDir,
    });
    expect(built.exitCode).toBe(0);

    const html = await Bun.file(`${pkgDir}dist/sandbox.html`).text();
    const viewer = await Bun.file(`${pkgDir}dist/viewer.js`).text();

    // The inline script must be present, or the assertions below would
    // pass vacuously against an empty page.
    expect(html).toContain('<script type="module">');
    // The viewer's own code landed inside...
    expect(html).toContain('relic-root');
    // ...and React came with it, at the pinned version.
    expect(html).toContain('19.2.0');

    // No CDN reference and no script that the frame would have to fetch.
    expect(html).not.toContain('https://esm.sh');
    expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);

    // The diff implementation lands in the service-origin bundle and nowhere
    // in the frame bundle. The comparison's two new message types are
    // deliberately named `relic:tree` and `relic:annotate`, and neither
    // carries a diff: one reports structure, the other carries paths.
    const diffMarker = 'No changes. These versions have identical content.';
    expect(viewer).toContain(diffMarker);
    expect(html).not.toContain(diffMarker);
    expect(html).not.toContain('relic:diff');

    // Same again for the rendered comparison's own algorithm. The frame
    // captures its structure and marks its nodes; it never compares.
    const renderedMarker = 'These versions render identically.';
    expect(viewer).toContain(renderedMarker);
    expect(html).not.toContain(renderedMarker);

    // The highlight path did ship into the frame, so the absence assertions
    // above are not passing because the feature never arrived.
    expect(html).toContain('data-relic-diff');
    expect(html).toContain('relic:annotate');
    expect(html).toContain('relic:tree');
  });
  test('renderer module text stays in one lazy chunk per format', async () => {
    const html = await Bun.file(`${pkgDir}dist/sandbox.html`).text();
    const shell = await Bun.file(`${pkgDir}dist/viewer.js`).text();
    for (const marker of [
      'Word document renderer is not available yet.',
      'EPUB document renderer is not available yet.',
    ]) {
      expect(html).not.toContain(marker);
      expect(shell).not.toContain(marker);
      const chunks = [...new Bun.Glob('chunk-*.js').scanSync(`${pkgDir}dist`)];
      const carriers: string[] = [];
      for (const chunk of chunks) {
        if ((await Bun.file(`${pkgDir}dist/${chunk}`).text()).includes(marker))
          carriers.push(chunk);
      }
      expect(carriers).toHaveLength(1);
    }
  });
});
