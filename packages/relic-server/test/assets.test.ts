import { describe, expect, test } from 'bun:test';
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

  test('cuts the frame off from the network entirely', async () => {
    const csp = await sandboxPolicy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("webrtc 'block'");
  });

  test('lets script come only from the document and a local blob', async () => {
    const csp = await sandboxPolicy();
    // Directive-scoped because frame-ancestors legitimately carries an
    // https:// origin. The script-src token must be exactly this pair: any
    // scheme source (a CDN import, a component fetch) lands here.
    const scriptSrc = csp
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('script-src '));
    expect(scriptSrc).toBe("script-src 'unsafe-inline' blob:");
    expect(scriptSrc).not.toContain('https:');
    expect(scriptSrc).not.toContain('http:');
  });

  test('is the exact policy, order included', async () => {
    // The directive list and its order are the contract; anything else is a
    // loosening or a drift, and both fail here before they ship.
    expect(await sandboxPolicy()).toBe(
      [
        "default-src 'none'",
        "script-src 'unsafe-inline' blob:",
        "style-src 'unsafe-inline'",
        'img-src data: blob:',
        'font-src data:',
        'media-src data: blob:',
        "worker-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        'frame-ancestors https://relic.example',
        "webrtc 'block'",
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
