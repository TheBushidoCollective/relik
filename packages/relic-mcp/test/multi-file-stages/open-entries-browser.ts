import { encodeFragment, encryptFolder, generateRelicId } from '@relic/format';
import { load, type ViewerDeps } from '../../../relic-viewer/src/viewer.ts';
import { renderReady } from '../../../relic-viewer/src/main.ts';

const bytes = new TextEncoder();
const key = new Uint8Array(16).fill(17);
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  ),
  (c) => c.charCodeAt(0)
);
const encrypted = await encryptFolder({
  key,
  name: 'example',
  defaultIndex: 0,
  entries: [
    {
      path: 'README.md',
      mimetype: 'text/markdown',
      bytes: bytes.encode('# Folder readme'),
    },
    {
      path: 'data/a.json',
      mimetype: 'application/json',
      bytes: bytes.encode('{"hello":"world"}'),
    },
    { path: 'img/p.png', mimetype: 'image/png', bytes: png },
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
  fetch: (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/object'))
      return new Response(encrypted as unknown as BodyInit);
    return new Response('{}', {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch,
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
