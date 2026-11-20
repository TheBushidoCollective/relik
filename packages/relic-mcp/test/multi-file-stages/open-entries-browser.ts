import {
  encodeFragment,
  encryptFolder,
  generateRelicId,
  indexZip,
} from '@relic/format';
import { load, type ViewerDeps } from '../../../relic-viewer/src/viewer.ts';
import { renderReady } from '../../../relic-viewer/src/main.ts';
import { folderZip } from '../../../relic-viewer/src/folder-downloads.ts';

const bytes = new TextEncoder();
const key = new Uint8Array(16).fill(17);
const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  ),
  (c) => c.charCodeAt(0)
);
let encrypted = await encryptFolder({
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
(
  window as unknown as { mountLargeFolder: () => Promise<void> }
).mountLargeFolder = async () => {
  encrypted = await encryptFolder({
    key,
    name: 'large',
    defaultIndex: 0,
    entries: Array.from({ length: 2000 }, (_, i) => ({
      path: `a/b/c/d/e/f/g/h/file-${String(i).padStart(4, '0')}.txt`,
      mimetype: 'text/plain',
      bytes: bytes.encode(`file ${i}`),
    })),
  });
  const large = await load(id, deps, undefined, {
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
  if (large.kind !== 'ready')
    throw new Error(`open failed: ${large.dead.code}`);
  renderReady(large.view, id, location.origin, deps);
};
(
  window as unknown as { measureZipFixtures: () => Promise<unknown[]> }
).measureZipFixtures = async () => {
  const results: unknown[] = [];
  for (const [count, size] of [
    [3, 1024 * 1024],
    [200, 37],
  ] as const) {
    const entries = Array.from({ length: count }, (_, i) => ({
      path: `file-${String(i).padStart(4, '0')}.bin`,
      mimetype: 'application/octet-stream',
      bytes: new Uint8Array(size).fill(i),
    }));
    encrypted = await encryptFolder({
      key,
      name: 'measure',
      defaultIndex: 0,
      entries,
    });
    const opened = await load(id, deps, undefined, {
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
    if (opened.kind !== 'ready' || !opened.view.folder)
      throw new Error('folder did not open');
    const start = performance.now();
    const zip = await folderZip(
      opened.view.folder,
      new AbortController().signal,
      () => {}
    );
    const milliseconds = performance.now() - start;
    const indexed = await indexZip(
      {
        size: zip.size,
        async read(from, to) {
          return new Uint8Array(await zip.slice(from, to).arrayBuffer());
        },
      },
      {
        maxArchiveBytes: zip.size,
        maxEntries: count,
        maxEntryBytes: size,
        maxTotalBytes: count * size,
      }
    );
    if (!indexed.ok || indexed.index.entries.size !== count)
      throw new Error('zip index failed');
    for (const entry of entries) {
      const read = await indexed.index.read(entry.path);
      if (
        !read.ok ||
        read.bytes.length !== entry.bytes.length ||
        read.bytes.some((byte, i) => byte !== entry.bytes[i])
      )
        throw new Error('zip entry mismatch');
    }
    results.push({ count, size, zipBytes: zip.size, milliseconds });
  }
  return results;
};
