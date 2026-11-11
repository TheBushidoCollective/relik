import { fetchUpload } from './upload-fixture.ts';
/**
 * The unfurl card, as a repeatable command.
 *
 *   bun packages/relic-mcp/test/unfurl-card-path.ts
 *
 * Every other path script in this directory stands a stub in for Relic,
 * because what it proves lives in the client. This one cannot: the card is
 * produced by the app server's shell and by a raster on disk, and the defect
 * it exists to catch is a byte order inside that shell. So the service here
 * is the real `createApp` on a loopback listener, serving the real built
 * viewer assets, and the publish is a real `relic_publish` through the client.
 *
 * Four things it proves that a unit test cannot:
 *
 * 1. **The head's byte order over HTTP.** The most consequential unfurler
 *    range-fetches the head of the document, so metadata that lands after a
 *    link or script tag may never be read. A blank card on an unfamiliar
 *    domain is the visual shape of a phishing link, which is the failure the
 *    tags exist to prevent, so getting the order wrong fails silently and
 *    looks exactly like the thing being fixed.
 * 2. **The default title is the filename, end to end**, through the client's
 *    normalization, the grant, the row, and the served head.
 * 3. **The opt-out works at the row.** Defaulting a public title to a private
 *    filename is defensible only because a publisher can decline it, so the
 *    declining is proven rather than described.
 * 4. **The card image is really a 1200x630 PNG** served immutable and
 *    unzipped. Every major unfurler rejects or crops a wrong-sized image, and
 *    a placeholder of the wrong dimensions would otherwise ship green.
 * 5. **The coarse renderer class reaches the card**, selecting a description
 *    with a browser or download tail, and providing the class fallback title
 *    when the publisher declines to declare one.
 *
 * It also asserts the rule the whole card rides on: none of these fetches
 * mints, so an unfurl never spends one of a relic's finite opens.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { nodeFiles } from '../src/files.ts';
import {
  type PublishDeps,
  type PublishInput,
  publish,
} from '../src/publish.ts';

const viewerDist = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);

const scratch = await mkdtemp(join(tmpdir(), 'relic-unfurl-card-path-'));
process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'state.json');

const store = new MemoryStore();
const storage = new MemoryStorage();

/**
 * The listener comes up before the app, because the app needs its own origin.
 *
 * `og:image` is absolute and is built from the configured service origin
 * rather than from the request's Host, which is the correct behaviour: an
 * unfurler must be handed the canonical asset URL and not whichever host the
 * deployment happens to answer on. That makes the port a prerequisite of the
 * config, so the socket is opened first and the handler is attached after.
 */
let handler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  port: 0,
  fetch: (request) =>
    handler === undefined
      ? new Response(null, { status: 503 })
      : handler(request),
});
const origin = `http://127.0.0.1:${service.port}`;

const app = createApp({
  config: { serviceOrigin: origin },
  store,
  storage,
  // The assets are read off disk rather than from memory, so the card this
  // asserts on is the committed file and not a fixture that agrees with it.
  assets: diskAssets(viewerDist),
});
handler = app.fetch;

/**
 * Real network for the service, memory for the object store.
 *
 * The service leg has to be real HTTP, because the head's byte order is what
 * this script exists to check and a direct handler call would not prove a
 * response ever crossed a socket. The storage leg cannot be: `MemoryStorage`
 * signs URLs at `storage.invalid`, which resolves nowhere on purpose.
 */
function routedFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    if (url.hostname !== 'storage.invalid') return fetch(url.toString(), init);

    const key = url.pathname.replace(/^\/(?:upload|o)\//, '');
    if (init?.method === 'PUT') {
      storage.put(key, new Uint8Array(init.body as Uint8Array));
      return new Response(null, { status: 200 });
    }

    const bytes = await storage.read(key);
    if (bytes === undefined) return new Response(null, { status: 404 });
    return new Response(bytes as unknown as BodyInit, { status: 200 });
  }) as typeof globalThis.fetch;
}

const deps: PublishDeps = {
  serviceOrigin: origin,
  relicOrigin: origin,
  files: nodeFiles,
  fetch: routedFetch(),
  upload: fetchUpload,
  clientName: 'relic-mcp/unfurl-card-path',
  // Repin to the fallback: when cover rendering is skipped, link previews
  // fall back to the constant card.v1.png.
  renderCover: async () => ({
    status: 'skipped',
    reason: 'browser_not_found',
    detail: 'unfurl-card-path tests the fallback card, not the renderer',
  }),
};

/**
 * Indices of every landmark in the served head, in one read.
 *
 * Named members rather than a record, so an assertion against a landmark
 * this function stopped emitting fails to compile instead of comparing
 * undefined and passing.
 */
function landmarks(body: string): {
  charset: number;
  ogType: number;
  ogTitle: number;
  ogImage: number;
  twitter: number;
  title: number;
  link: number;
  script: number;
} {
  return {
    charset: body.indexOf('<meta charset="utf-8">'),
    ogType: body.indexOf('<meta property="og:type"'),
    ogTitle: body.indexOf('<meta property="og:title"'),
    ogImage: body.indexOf('<meta property="og:image"'),
    twitter: body.indexOf('<meta name="twitter:card"'),
    title: body.indexOf('<title>'),
    link: body.indexOf('<link'),
    script: body.indexOf('<script'),
  };
}

try {
  // --- A relic published with no title argument, so the filename is it ----
  const source = join(scratch, 'quarterly-review.md');
  await writeFile(source, '# Quarterly review\n\nThe numbers.\n');

  const published = await publish({ path: source }, deps);
  assert.equal(published.title, 'quarterly-review.md');
  console.log(
    `PUBLISHED relic_id=${published.relic_id} title=${published.title}`
  );

  const shell = await fetch(`${origin}/${published.relic_id}`);
  assert.equal(shell.status, 200);
  const body = await shell.text();
  const at = landmarks(body);

  // Ordered, not merely present. A tag after the link and script block may
  // fall outside the range an unfurler fetches.
  assert.ok(at.charset >= 0, 'no charset declaration');
  assert.ok(at.ogType > at.charset, 'og block precedes the charset');
  assert.ok(at.ogTitle > at.ogType, 'og:title precedes og:type');
  assert.ok(at.ogImage > at.ogTitle, 'og:image precedes og:title');
  assert.ok(at.twitter > at.ogImage, 'twitter block precedes the og block');
  assert.ok(at.title > at.twitter, 'the title element precedes the card block');
  assert.ok(at.link > at.title, 'a link tag precedes the card block');
  assert.ok(at.script > at.link, 'a script tag precedes the card block');
  console.log(
    `HEAD_ORDER charset=${at.charset} og=${at.ogType} twitter=${at.twitter} ` +
      `title=${at.title} link=${at.link} script=${at.script}`
  );

  assert.ok(
    body.includes('<meta property="og:title" content="quarterly-review.md">') &&
      body.includes(
        '<meta name="twitter:title" content="quarterly-review.md">'
      ) &&
      body.includes('<title>quarterly-review.md · Relic</title>'),
    'the served head does not carry the published title'
  );
  // This assertion is the reverse of its former self: previously, card.v1.png
  // was the sole, unconditional raster for every relic under the "one constant
  // raster" invariant. Now, per-relic covers are the default, and card.v1.png
  // is the fallback when cover rendering is skipped or declined.
  assert.ok(
    body.includes(
      `<meta property="og:image" content="${origin}/assets/card.v1.png">`
    ),
    'the card image is not the fallback card.v1.png path'
  );
  console.log('CARD_TITLE og:title=quarterly-review.md title=… · Relic');

  const expectedMarkdownDesc =
    'A Markdown document. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.';
  assert.ok(
    body.includes(
      `<meta property="og:description" content="${expectedMarkdownDesc}">`
    ) &&
      body.includes(
        `<meta name="twitter:description" content="${expectedMarkdownDesc}">`
      ),
    'the served head does not carry the markdown class description'
  );
  console.log('CARD_DESCRIPTION class=markdown tail=browser');

  // --- The same publish, declining the title and cover -------------------
  const declinedInput: PublishInput = {
    path: source,
    title: '',
    cover: false,
    force_new: true,
  };
  const declined = await publish(declinedInput, deps);
  assert.equal(declined.title, null);

  const declinedRow = await store.getRelic(declined.relic_id);
  assert.equal(declinedRow?.title, undefined);
  assert.ok(
    !JSON.stringify(declinedRow).includes('quarterly-review'),
    'the name reached the row despite an empty title'
  );

  const declinedBody = await fetch(`${origin}/${declined.relic_id}`).then((r) =>
    r.text()
  );
  assert.ok(
    declinedBody.includes(
      '<meta property="og:title" content="A Markdown relic">'
    ) &&
      declinedBody.includes(
        '<meta name="twitter:title" content="A Markdown relic">'
      ) &&
      declinedBody.includes('<title>A Markdown relic</title>'),
    'an untitled markdown relic served something other than the class fallback title'
  );
  assert.ok(
    declinedBody.includes(
      `<meta property="og:description" content="${expectedMarkdownDesc}">`
    ) &&
      declinedBody.includes(
        `<meta name="twitter:description" content="${expectedMarkdownDesc}">`
      ),
    'the untitled markdown relic does not carry the markdown class description'
  );
  console.log(
    `DECLINED relic_id=${declined.relic_id} row_title=absent card=A Markdown relic`
  );

  // --- An archive relic identified by content sniffing -------------------
  const archiveSource = join(scratch, 'payload.bin');
  // Real gzip header bytes (0x1f, 0x8b) so the sniffer derives archive
  // from content alone, despite the neutral filename.
  await writeFile(
    archiveSource,
    new Uint8Array([
      0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x03, 0x00,
    ])
  );
  const archive = await publish(
    { path: archiveSource, title: '', force_new: true },
    deps
  );
  assert.equal(archive.title, null);

  const archiveBody = await fetch(`${origin}/${archive.relic_id}`).then((r) =>
    r.text()
  );
  const expectedArchiveDesc =
    'An archive. It downloads to your device, and only someone holding the whole link, including the part after the #, can open it.';
  assert.ok(
    archiveBody.includes(
      `<meta property="og:description" content="${expectedArchiveDesc}">`
    ) &&
      archiveBody.includes(
        `<meta name="twitter:description" content="${expectedArchiveDesc}">`
      ),
    'the archive relic does not carry the archive class download description'
  );
  assert.ok(
    archiveBody.includes(
      '<meta property="og:title" content="An archive relic">'
    ) &&
      archiveBody.includes(
        '<meta name="twitter:title" content="An archive relic">'
      ) &&
      archiveBody.includes('<title>An archive relic</title>'),
    'the untitled archive relic does not carry the archive fallback title'
  );
  console.log(
    'ARCHIVE_CARD class=archive tail=download title=An archive relic'
  );

  // --- A media relic identified by content sniffing ----------------------
  const mediaSource = join(scratch, 'recording.bin');
  // Real MP4 container header: 'ftyp' at offset 4 so the sniffer derives
  // media from content alone, despite the neutral filename.
  await writeFile(
    mediaSource,
    new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
      0x00, 0x00, 0x00, 0x00,
    ])
  );
  const media = await publish(
    { path: mediaSource, title: '', force_new: true },
    deps
  );
  assert.equal(media.title, null);

  const mediaBody = await fetch(`${origin}/${media.relic_id}`).then((r) =>
    r.text()
  );
  const expectedMediaDesc =
    'An audio or video file. It plays in your browser, and only someone holding the whole link, including the part after the #, can open it.';
  assert.ok(
    mediaBody.includes(
      `<meta property="og:description" content="${expectedMediaDesc}">`
    ) &&
      mediaBody.includes(
        `<meta name="twitter:description" content="${expectedMediaDesc}">`
      ),
    'the media relic does not carry the media class playback description'
  );
  assert.ok(
    mediaBody.includes('<meta property="og:title" content="A media relic">') &&
      mediaBody.includes(
        '<meta name="twitter:title" content="A media relic">'
      ) &&
      mediaBody.includes('<title>A media relic</title>'),
    'the untitled media relic does not carry the media fallback title'
  );
  console.log('MEDIA_CARD class=media tail=plays title=A media relic');
  // --- The one raster on this origin -------------------------------------
  const card = await fetch(`${origin}/assets/card.v1.png`);
  assert.equal(card.status, 200);
  assert.equal(card.headers.get('content-type'), 'image/png');
  assert.equal(
    card.headers.get('cache-control'),
    'public, max-age=31536000, immutable'
  );
  assert.equal(card.headers.get('content-encoding'), null);

  const bytes = new Uint8Array(await card.arrayBuffer());
  const png = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // IHDR is the first chunk and its width and height are big-endian at 16
  // and 20. Read them rather than trusting the filename, because the size is
  // what unfurlers reject on.
  assert.equal(png.getUint32(16), 1200);
  assert.equal(png.getUint32(20), 630);
  console.log(
    `CARD_IMAGE bytes=${bytes.length} dimensions=1200x630 cache=immutable`
  );

  // --- The rule the card rides on ---------------------------------------
  assert.equal((await store.getRelic(published.relic_id))?.mintsUsed, 0);
  assert.equal((await store.readMintLog()).length, 0);
  console.log('NO_MINT opens_spent=0 mint_log=0');

  console.log('UNFURL_CARD_PATH_OK');
} finally {
  service.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
