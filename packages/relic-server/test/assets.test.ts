import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { contentTypeFor, diskAssets, memoryAssets } from '../src/assets.ts';

const VIEWER_DIST = new URL('../../relic-viewer/dist/', import.meta.url)
  .pathname;

function app(assets = diskAssets(VIEWER_DIST)) {
  return createApp({ assets });
}

function get(path: string): Request {
  return new Request(`https://relic.example${path}`);
}

describe('asset serving', () => {
  const cases = [
    ['/assets/viewer.js', 'text/javascript'],
    ['/assets/styles.css', 'text/css'],
    ['/assets/icon.svg', 'image/svg+xml'],
    ['/manifest.webmanifest', 'application/manifest+json'],
    ['/sw.js', 'text/javascript'],
  ] as const;

  for (const [path, type] of cases) {
    test(`serves ${path} as ${type}`, async () => {
      const response = await app().fetch(get(path));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(type);
    });
  }

  test('gzips when the client offers it, and says so', async () => {
    // Every response here is no-store, so its full size is paid on every
    // view, and the frame's page carries its whole bundle inline. Nothing
    // upstream compresses.
    const request = new Request('https://relic.example/assets/viewer.js', {
      headers: { 'accept-encoding': 'gzip, br' },
    });
    const response = await app().fetch(request);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('vary')).toBe('accept-encoding');
  });

  test('sends identity to a client that offered no encoding', async () => {
    const response = await app().fetch(get('/assets/viewer.js'));
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  test('serves the service worker registration without inline script', async () => {
    // The shell's CSP is script-src 'self'; adding 'unsafe-inline' for three
    // lines of registration would weaken the directive that matters most on
    // the origin holding the fragment.
    const response = await app().fetch(get('/assets/register-sw.js'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("register('/sw.js')");
  });

  test('register-sw recovers a page whose viewer module never booted', async () => {
    const response = await app().fetch(get('/assets/register-sw.js'));
    const script = await response.text();
    // The viewer marks the document when it runs; the recovery keys on that
    // mark and retries once per tab, so a still-broken page cannot loop.
    expect(script).toContain('viewerBooted');
    expect(script).toContain('relic:shell-heal');
    expect(script).toContain('location.reload()');
  });

  test('sets nosniff and no-referrer', async () => {
    const response = await app().fetch(get('/assets/viewer.js'));
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('404s an unknown asset', async () => {
    expect((await app().fetch(get('/assets/nope.js'))).status).toBe(404);
  });

  const traversals = [
    '/assets/../../../etc/passwd',
    '/assets/..%2f..%2fetc%2fpasswd',
    '/assets/....//etc/passwd',
  ];

  for (const path of traversals) {
    test(`refuses traversal ${path}`, async () => {
      const response = await app().fetch(get(path));
      expect(response.status).toBe(404);
    });
  }

  test('diskAssets refuses traversal at the source', async () => {
    const source = diskAssets(VIEWER_DIST);
    expect(await source.get('../../../etc/passwd')).toBeUndefined();
    expect(await source.get('a\\b')).toBeUndefined();
  });

  test('contentTypeFor falls back rather than guessing', () => {
    expect(contentTypeFor('x.js')).toContain('javascript');
    expect(contentTypeFor('x.unknown')).toBe('application/octet-stream');
    expect(contentTypeFor('noextension')).toBe('application/octet-stream');
  });

  test('memoryAssets serves what it was given', async () => {
    const source = memoryAssets({ '/a.css': 'body{}' });
    const asset = await source.get('a.css');
    expect(new TextDecoder().decode(asset?.body)).toBe('body{}');
  });
});

describe('the shell references what is actually served', () => {
  test('the shell and worker name the same build for every shell asset', async () => {
    const server = app();
    const build = (
      await Bun.file(`${VIEWER_DIST}/shell-build.txt`).text()
    ).trim();
    const html = await (
      await server.fetch(get('/aaaaaaaaaaaaaaaaaaaaaaaaaa'))
    ).text();
    const worker = await (await server.fetch(get('/sw.js'))).text();
    for (const path of [
      '/assets/viewer.js',
      '/assets/styles.css',
      '/assets/icon.svg',
      '/assets/register-sw.js',
      '/manifest.webmanifest',
    ]) {
      const url = `${path}?v=${build}`;
      expect(html).toContain(`"${url}"`);
      expect(worker).toContain(url);
      expect((await server.fetch(get(url))).status).toBe(200);
    }
  });

  test('a disk source without valid build metadata refuses the shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'relic-shell-test-'));
    try {
      const server = app(diskAssets(dir));
      await expect(
        server.fetch(get('/aaaaaaaaaaaaaaaaaaaaaaaaaa'))
      ).rejects.toThrow('Missing or invalid shell-build.txt');
      await writeFile(join(dir, 'shell-build.txt'), '');
      await expect(
        server.fetch(get('/aaaaaaaaaaaaaaaaaaaaaaaaaa'))
      ).rejects.toThrow('Missing or invalid shell-build.txt');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test('every asset the shell names resolves', async () => {
    const server = app();
    const html = await server
      .fetch(get('/aaaaaaaaaaaaaaaaaaaaaaaaaa'))
      .then((r) => r.text());

    const referenced = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
      .map((match) => match[1] as string)
      .filter((href) => href.startsWith('/'));

    expect(referenced.length).toBeGreaterThan(0);
    for (const href of referenced) {
      const response = await server.fetch(get(href));
      expect(`${href} -> ${response.status}`).toBe(`${href} -> 200`);
    }
  });

  test('the shell tells the viewer which origin the content is on', async () => {
    const html = await app()
      .fetch(get('/aaaaaaaaaaaaaaaaaaaaaaaaaa'))
      .then((r) => r.text());
    expect(html).toContain(
      'data-usercontent-origin="https://relic-usercontent.example"'
    );
  });
});

describe('the sandbox page', () => {
  test('does not serve the sandbox through generic asset routes', async () => {
    const server = app(
      memoryAssets({
        'sandbox.html': '<!doctype html><title>fixture</title>',
        'SaNdBoX.html': '<!doctype html><title>fixture</title>',
      })
    );
    for (const path of ['/assets/sandbox.html', '/assets/SaNdBoX.html']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await server.fetch(
          new Request(`https://relic.example${path}`, { method })
        );
        expect(response.status).toBe(404);
      }
    }
  });

  test('is served and only the service origin may frame it', async () => {
    const response = await app().fetch(get('/sandbox.html'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain(
      'frame-ancestors https://relic.example'
    );
  });

  const sandboxPolicy = async (): Promise<string> =>
    (await app().fetch(get('/sandbox.html'))).headers.get(
      'content-security-policy'
    ) ?? '';

  // The shim's one inline script, computed here from the served body rather
  // than read back from the server's own helper, so a mismatch fails.
  const shimHash = async (): Promise<string> => {
    const body = await (await app().fetch(get('/sandbox.html'))).text();
    const match = /<script type="module">([\s\S]*?)<\/script>/.exec(body);
    if (match?.[1] === undefined) throw new Error('no inline module script');
    const digest = new Bun.CryptoHasher('sha256')
      .update(match[1])
      .digest('base64');
    return `sha256-${digest}`;
  };

  test('denies the frame HTTP requests by policy', async () => {
    const csp = await sandboxPolicy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    // Chrome does not enforce `webrtc 'block'`, so none is pinned here. The
    // RTC constructors are removed in the shim's realm (rtc-guard.ts).
    expect(csp).toContain('sandbox allow-scripts');
  });

  test('a direct navigation to the shim gets the sandbox flags too', async () => {
    // The iframe attribute covers the framed case. A top-level navigation has no
    // attribute, so the response itself must carry the flags.
    const navigation = new Request('https://relic.example/sandbox.html', {
      headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' },
    });
    const response = await app().fetch(navigation);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain(
      'sandbox allow-scripts'
    );
  });

  test('admits script only by the shim hash and a local blob', async () => {
    // Directive-scoped because frame-ancestors legitimately carries an
    // https:// origin. The script-src tokens must be exactly the shim's hash
    // and blob:. No unsafe-inline, unsafe-eval or scheme source.
    const scriptSrc = (await sandboxPolicy())
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('script-src '));
    expect(scriptSrc).toBe(`script-src '${await shimHash()}' blob:`);
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
    expect(scriptSrc).not.toContain('https:');
    expect(scriptSrc).not.toContain('http:');
  });

  test('is the exact policy, order included', async () => {
    // The directive list and its order are the contract; anything else is a
    // loosening or a drift, and both fail here before they ship.
    expect(await sandboxPolicy()).toBe(
      [
        "default-src 'none'",
        `script-src '${await shimHash()}' blob:`,
        "style-src 'unsafe-inline'",
        'img-src data: blob:',
        'font-src data:',
        'media-src data: blob:',
        "worker-src 'none'",
        "frame-src 'none'",
        "object-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        'sandbox allow-scripts',
        'frame-ancestors https://relic.example',
      ].join('; ')
    );
  });

  test('is not cached, so a stale renderer cannot outlive a deploy', async () => {
    const response = await app().fetch(get('/sandbox.html'));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('shell assets are no-store too, because their filenames are stable', async () => {
    // Measured in the field: viewer.js served with max-age made a shipped
    // fix not run for returning browsers for up to an hour after the deploy.
    // The service worker is the caching layer; the HTTP cache only added
    // staleness.
    const response = await app().fetch(get('/assets/viewer.js'));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('is reserved, so it can never be shadowed by an issued id', async () => {
    const { RESERVED_SEGMENTS } = await import('@relic/format');
    expect(RESERVED_SEGMENTS).toContain('sandbox.html');
  });
});
