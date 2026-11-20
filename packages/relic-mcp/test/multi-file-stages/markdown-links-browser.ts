import { encodeFragment, encryptFolder, generateRelicId } from '@relic/format';
import { load, type ViewerDeps } from '../../../relic-viewer/src/viewer.ts';
import { renderReady } from '../../../relic-viewer/src/main.ts';

const encoder = new TextEncoder();
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  ),
  (c) => c.charCodeAt(0)
);
const large = new Uint8Array(24 * 1024 * 1024);
large.set(png);
const text = `# Folder readme

[Relative](docs/a.md#section) [Root](/docs/a.md) [Outside](../outside.md) [Missing](/missing.md) [Protocol](//evil.example/x) [Case](docs/A.md) [Backslash](docs%5ca.md) [External](https://example.com/)

![Picture](./img/p.png) ![Root picture](/img/p.png) ![Vector](./img/v.svg)

![Large one](img/large.png) ![Large two](img/large.png) ![Budget exceeded](img/large.png)`;
const key = new Uint8Array(16).fill(17);
const encrypted = await encryptFolder({
  key,
  name: 'example',
  defaultIndex: 0,
  entries: [
    {
      path: 'README.md',
      mimetype: 'text/markdown',
      bytes: encoder.encode(text),
    },
    { path: 'a.png', mimetype: 'image/png', bytes: png },
    {
      path: 'docs/a.md',
      mimetype: 'text/markdown',
      bytes: encoder.encode('# Section\n\nTarget document'),
    },
    { path: 'img/large.png', mimetype: 'image/png', bytes: large },
    { path: 'img/p.png', mimetype: 'image/png', bytes: png },
    {
      path: 'img/v.svg',
      mimetype: 'image/svg+xml',
      bytes: encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    },
    {
      path: 'index.html',
      mimetype: 'text/html',
      bytes: encoder.encode(
        '<h1>HTML entry</h1><link rel="stylesheet" href="style.css"><img src="a.png">'
      ),
    },
    {
      path: 'style.css',
      mimetype: 'text/css',
      bytes: encoder.encode('h1 { color: red }'),
    },
  ],
});
const id = generateRelicId();
const fragment = encodeFragment(key);
const deps: ViewerDeps = {
  serviceOrigin: location.origin,
  locationHref: `${location.origin}/${id}#${fragment}`,
  takeFragment: () => fragment,
  stripFragment() {},
  keyVault: {
    remember() {},
    recall() {
      return undefined;
    },
    forget() {},
  },
  fetch: (async (input: RequestInfo | URL) =>
    String(input).endsWith('/object')
      ? new Response(encrypted as unknown as BodyInit)
      : new Response('{}', {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
};
const state = await load(id, deps, undefined, {
  fragment,
  mint: {
    url: `${location.origin}/object`,
    url_expires_at: '2999-01-01T00:00:00Z',
    relic_expires_at: null,
    object_length: encrypted.length,
    object_crc32c: '',
    mints_remaining: 1,
    version: 1,
    current_version: 1,
  },
});
if (state.kind !== 'ready') throw new Error(`open failed: ${state.dead.code}`);
renderReady(state.view, id, location.origin, deps);
document.body.dataset.fixtureReady = 'yes';
