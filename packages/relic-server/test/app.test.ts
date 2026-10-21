import { beforeEach, describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import {
  decryptComment,
  deriveCommentKey,
  encryptComment,
  encryptedSize,
  encryptRelic,
  generateKey,
  generateRelicId,
  RESERVED_SEGMENTS,
} from '@relic/format';
import {
  COVER_CAP_BYTES,
  COVER_HEIGHT,
  COVER_WIDTH,
  crc32,
} from '@relic/format/cover';
import {
  createApp,
  type Mailer,
  type RelicApp,
  stripToRelicId,
} from '../src/app.ts';
import { memoryAssets } from '../src/assets.ts';
import { sha256Hex } from '../src/gcs.ts';
import { MailRefusedError, type OutboundMail } from '../src/mail.ts';
import { ciphertextHash, MemoryStorage } from '../src/storage.ts';
import { MemoryStore } from '../src/store.ts';

const OPERATOR = new Map([['jason', 'operator-secret']]);

let now = Date.parse('2026-08-02T12:00:00.000Z');
let storage: MemoryStorage;
let app: RelicApp;

function build(overrides: Parameters<typeof createApp>[0] = {}): RelicApp {
  storage = new MemoryStorage();
  return createApp({
    store: new MemoryStore(),
    storage,
    now: () => now,
    operatorTokens: OPERATOR,
    ...overrides,
  });
}

beforeEach(() => {
  now = Date.parse('2026-08-02T12:00:00.000Z');
  app = build();
});

function req(
  path: string,
  init: RequestInit & { ip?: string | undefined } = {}
): Request {
  const headers = new Headers(init.headers);
  if (!headers.has('x-forwarded-for')) {
    headers.set(
      'x-forwarded-for',
      `${init.ip ?? '198.51.100.10'}, 130.211.0.1`
    );
  }
  return new Request(`https://relic.example${path}`, { ...init, headers });
}

async function publish(
  options: {
    ip?: string | undefined;
    id?: string;
    rendererClass?: string;
    size?: number;
    ttlDays?: number;
    title?: string;
    ownerEmail?: string;
    owner?: string;
  } = {}
): Promise<{ id: string; key: Uint8Array; grant: Record<string, unknown> }> {
  const challengeResponse = await app.fetch(
    req('/api/challenge', { method: 'POST', ip: options.ip })
  );
  const challenge = (await challengeResponse.json()) as {
    challenge_nonce: string;
  };

  const id = options.id ?? generateRelicId();
  const key = generateKey();

  const grantResponse = await app.fetch(
    req('/api/grant', {
      method: 'POST',
      ip: options.ip,
      body: JSON.stringify({
        challenge_nonce: challenge.challenge_nonce,
        relic_id: id,
        renderer_class: options.rendererClass ?? 'markdown',
        publishing_client: 'relic-mcp/0.1.0 (test)',
        declared_size_bytes: options.size ?? 12,
        declared_ciphertext_bytes: encryptedSize(options.size ?? 12),
        ...(options.ttlDays === undefined ? {} : { ttl_days: options.ttlDays }),
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.ownerEmail === undefined
          ? {}
          : { owner_email: options.ownerEmail }),
        ...(options.owner === undefined ? {} : { owner: options.owner }),
      }),
    })
  );
  expect(grantResponse.status).toBe(200);
  const grant = (await grantResponse.json()) as Record<string, unknown>;

  const container = await encryptRelic({
    content: new TextEncoder().encode('hello relic'),
    filename: 'notes.md',
    mimetype: 'text/markdown',
    key,
  });
  storage.put(id, container);

  return { id, key, grant };
}

/** Ciphertext for a republished version, under the same key as v1. */
async function encrypted(text: string, key: Uint8Array): Promise<Uint8Array> {
  return encryptRelic({
    content: new TextEncoder().encode(text),
    filename: 'notes.md',
    mimetype: 'text/markdown',
    key,
  });
}

/**
 * A republish request the test controls token by token. `undefined` omits
 * the field entirely, which is its own refusal case.
 */
async function republish(
  id: string,
  token: string | undefined,
  options: { rendererClass?: string; size?: number; title?: string } = {}
): Promise<Response> {
  return app.fetch(
    req(`/api/relics/${id}/republish`, {
      method: 'POST',
      body: JSON.stringify({
        ...(token === undefined ? {} : { publish_token: token }),
        renderer_class: options.rendererClass ?? 'markdown',
        declared_size_bytes: options.size ?? 12,
        declared_ciphertext_bytes: encryptedSize(options.size ?? 12),
        ...(options.title === undefined ? {} : { title: options.title }),
      }),
    })
  );
}

/** A relic with every object present from version 1 through `currentVersion`. */
async function publishThroughVersion(
  currentVersion: number
): Promise<{ id: string }> {
  const { id, key, grant } = await publish();
  const token = grant['publish_token'] as string;

  for (let version = 2; version <= currentVersion; version++) {
    const response = await republish(id, token);
    expect(response.status).toBe(200);
    storage.put(
      `${id}/v${version}`,
      await encrypted(`hello relic, version ${version}`, key)
    );
  }

  return { id };
}

/**
 * A grant request the test controls field by field, for the metadata the
 * publish helper does not model.
 */
async function grantFor(fields: Record<string, unknown>): Promise<Response> {
  const challenge = (await app
    .fetch(req('/api/challenge', { method: 'POST' }))
    .then((r) => r.json())) as { challenge_nonce: string };
  return app.fetch(
    req('/api/grant', {
      method: 'POST',
      body: JSON.stringify({
        challenge_nonce: challenge.challenge_nonce,
        relic_id: generateRelicId(),
        renderer_class: 'markdown',
        publishing_client: 'test',
        declared_size_bytes: 12,
        declared_ciphertext_bytes: encryptedSize(12),
        ...fields,
      }),
    })
  );
}

describe('the shell', () => {
  test('serving /{id} performs no mint and consumes no cap', async () => {
    const { id } = await publish();
    const before = await app.store.readMintLog();

    const response = await app.fetch(req(`/${id}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    // No mint log entry, no cap consumption. This is what keeps Slack's
    // fetcher, which does not honor robots.txt, off both counters.
    expect(await app.store.readMintLog()).toHaveLength(before.length);
    expect((await app.store.getRelic(id))?.mintsUsed).toBe(0);
  });

  test('sends Referrer-Policy: no-referrer', async () => {
    const { id } = await publish();
    const response = await app.fetch(req(`/${id}`));
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('sends X-Robots-Tag on a real relic path, not just the apex', async () => {
    const { id } = await publish();
    const response = await app.fetch(req(`/${id}`));
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
  });

  test('frames only the usercontent origin', async () => {
    const { id } = await publish();
    const csp = await app
      .fetch(req(`/${id}`))
      .then((r) => r.headers.get('content-security-policy'));
    expect(csp).toContain('frame-src https://relic-usercontent.example');
  });

  test('permits the manifest it links, which default-src none refused', async () => {
    // The shell has always linked a manifest and the server has always served
    // it, but a manifest fetch falls back to default-src when manifest-src is
    // absent. Production reported a csp-blocked request of type Manifest, so
    // the install path never worked. Any relic path serves the same shell.
    const { id } = await publish();
    const csp = await app
      .fetch(req(`/${id}`))
      .then((r) => r.headers.get('content-security-policy'));
    expect(csp).toContain("manifest-src 'self'");
  });

  test('permits media blobs rendered by the player, which default-src none refused', async () => {
    const { id } = await publish();
    const csp = await app
      .fetch(req(`/${id}`))
      .then((r) => r.headers.get('content-security-policy'));
    expect(csp).toContain("media-src 'self' blob: data:");
  });

  test('the head byte order: Open Graph block appears before <script, <style, <link, or <title, and after <meta charset', async () => {
    const { id } = await publish({ title: 'Byte Order Test' });
    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    const charsetIdx = body.indexOf('<meta charset="utf-8">');
    const ogTypeIdx = body.indexOf('<meta property="og:type"');
    const ogSiteNameIdx = body.indexOf('<meta property="og:site_name"');
    const ogTitleIdx = body.indexOf('<meta property="og:title"');
    const ogDescIdx = body.indexOf('<meta property="og:description"');
    const ogUrlIdx = body.indexOf('<meta property="og:url"');
    const ogImageIdx = body.indexOf('<meta property="og:image"');
    const twitterCardIdx = body.indexOf('<meta name="twitter:card"');
    const titleIdx = body.indexOf('<title>');
    const linkIdx = body.indexOf('<link');
    const scriptIdx = body.indexOf('<script');

    expect(charsetIdx).toBeGreaterThanOrEqual(0);
    expect(ogTypeIdx).toBeGreaterThan(charsetIdx);
    expect(ogSiteNameIdx).toBeGreaterThan(ogTypeIdx);
    expect(ogTitleIdx).toBeGreaterThan(ogSiteNameIdx);
    expect(ogDescIdx).toBeGreaterThan(ogTitleIdx);
    expect(ogUrlIdx).toBeGreaterThan(ogDescIdx);
    expect(ogImageIdx).toBeGreaterThan(ogUrlIdx);
    expect(twitterCardIdx).toBeGreaterThan(ogImageIdx);
    expect(titleIdx).toBeGreaterThan(twitterCardIdx);
    expect(linkIdx).toBeGreaterThan(titleIdx);
    expect(scriptIdx).toBeGreaterThan(linkIdx);

    const styleIdx = body.indexOf('<style');
    if (styleIdx >= 0) {
      expect(styleIdx).toBeGreaterThan(twitterCardIdx);
    }
  });

  test('a relic published with a title emits it in og:title, twitter:title, and <title> while description carries the class', async () => {
    const { id } = await publish({ title: 'My Custom Document' });
    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    expect(body).toContain(
      '<meta property="og:title" content="My Custom Document">'
    );
    expect(body).toContain(
      '<meta name="twitter:title" content="My Custom Document">'
    );
    expect(body).toContain('<title>My Custom Document · Relic</title>');
    expect(body).toContain(
      '<meta property="og:description" content="A Markdown document. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
    expect(body).toContain(
      '<meta name="twitter:description" content="A Markdown document. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
  });

  test('an untitled relic serves its per-class fallback title in og:title, twitter:title and <title>', async () => {
    const { id } = await publish();
    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    expect(body).toContain(
      '<meta property="og:title" content="A Markdown relic">'
    );
    expect(body).toContain(
      '<meta name="twitter:title" content="A Markdown relic">'
    );
    expect(body).toContain('<title>A Markdown relic</title>');
    expect(body).not.toContain('· Relic');
    expect(body).toContain(
      '<meta property="og:description" content="A Markdown document. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
  });

  test('a relic published as markdown serves the Markdown phrase and browser tail; one published as archive serves the archive phrase and download tail', async () => {
    const { id: mdId } = await publish({ rendererClass: 'markdown' });
    const mdResponse = await app.fetch(req(`/${mdId}`));
    const mdBody = await mdResponse.text();

    expect(mdBody).toContain(
      '<meta property="og:description" content="A Markdown document. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
    expect(mdBody).toContain(
      '<meta name="twitter:description" content="A Markdown document. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );

    const { id: archiveId } = await publish({ rendererClass: 'archive' });
    const archiveResponse = await app.fetch(req(`/${archiveId}`));
    const archiveBody = await archiveResponse.text();

    expect(archiveBody).toContain(
      '<meta property="og:description" content="An archive. It downloads to your device, and only someone holding the whole link, including the part after the #, can open it.">'
    );
    expect(archiveBody).toContain(
      '<meta name="twitter:description" content="An archive. It downloads to your device, and only someone holding the whole link, including the part after the #, can open it.">'
    );
    expect(archiveBody).toContain(
      '<meta property="og:title" content="An archive relic">'
    );
    expect(archiveBody).toContain(
      '<meta name="twitter:title" content="An archive relic">'
    );
    expect(archiveBody).toContain('<title>An archive relic</title>');
  });

  test('a relic published as media serves the media phrase and played tail on og:description and twitter:description', async () => {
    const { id } = await publish({ rendererClass: 'media' });
    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    const expectedDescription =
      'An audio or video file. It plays in your browser, and only someone holding the whole link, including the part after the #, can open it.';

    expect(body).toContain(
      `<meta property="og:description" content="${expectedDescription}">`
    );
    expect(body).toContain(
      `<meta name="twitter:description" content="${expectedDescription}">`
    );
    expect(body).not.toContain('downloads to your device');
    expect(body).toContain(
      '<meta property="og:title" content="A media relic">'
    );
    expect(body).toContain(
      '<meta name="twitter:title" content="A media relic">'
    );
    expect(body).toContain('<title>A media relic</title>');
  });
  test('a relic published as otio serves the otio phrase and played tail on og:description and twitter:description', async () => {
    const { id } = await publish({ rendererClass: 'otio' });
    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    const expectedDescription =
      'An OpenTimelineIO timeline. It plays in your browser, and only someone holding the whole link, including the part after the #, can open it.';

    expect(body).toContain(
      `<meta property="og:description" content="${expectedDescription}">`
    );
    expect(body).toContain(
      `<meta name="twitter:description" content="${expectedDescription}">`
    );
    expect(body).not.toContain('downloads to your device');
    expect(body).toContain(
      '<meta property="og:title" content="An OpenTimelineIO relic">'
    );
    expect(body).toContain(
      '<meta name="twitter:title" content="An OpenTimelineIO relic">'
    );
    expect(body).toContain('<title>An OpenTimelineIO relic</title>');
  });

  test('a title containing quotes and angle brackets cannot break out', async () => {
    const hostileTitle = 'hello "evil" <script>alert(1)</script>';
    const { id } = await publish({ title: hostileTitle });
    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    expect(body).not.toContain(hostileTitle);
    expect(body).toContain(
      '<meta property="og:title" content="hello &quot;evil&quot; &lt;script&gt;alert(1)&lt;/script&gt;">'
    );
    expect(body).toContain(
      '<meta name="twitter:title" content="hello &quot;evil&quot; &lt;script&gt;alert(1)&lt;/script&gt;">'
    );
    expect(body).toContain(
      '<title>hello &quot;evil&quot; &lt;script&gt;alert(1)&lt;/script&gt; · Relic</title>'
    );
  });

  test('a tombstoned relic serves the constant card and leaks neither title nor class', async () => {
    const { id } = await publish({
      title: 'Secret Tombstoned Title',
      rendererClass: 'markdown',
    });
    await app.store.putTombstone({
      id,
      publishIp: '198.51.100.10',
      publishedAt: now,
      publishingClient: 'test',
      rendererClass: 'markdown',
      ciphertextHash: 'hash',
      deletedAt: now,
      reasonClass: 'abuse',
      operator: 'test-op',
      reportReference: undefined,
    });

    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    expect(body).not.toContain('Secret Tombstoned Title');
    expect(body).not.toContain('Markdown');
    expect(body).toContain('<meta property="og:title" content="A relic">');
    expect(body).toContain('<meta name="twitter:title" content="A relic">');
    expect(body).toContain('<title>Relic</title>');
    expect(body).toContain(
      '<meta property="og:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
    expect(body).toContain(
      '<meta name="twitter:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
  });

  test('an expired relic serves the constant card and leaks neither title nor class', async () => {
    const { id } = await publish({
      title: 'Secret Expired Title',
      ttlDays: 1,
      rendererClass: 'markdown',
    });
    now += 2 * 86_400 * 1000;

    const response = await app.fetch(req(`/${id}`));
    const body = await response.text();

    expect(body).not.toContain('Secret Expired Title');
    expect(body).not.toContain('Markdown');
    expect(body).toContain('<meta property="og:title" content="A relic">');
    expect(body).toContain('<meta name="twitter:title" content="A relic">');
    expect(body).toContain('<title>Relic</title>');
    expect(body).toContain(
      '<meta property="og:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
    expect(body).toContain(
      '<meta name="twitter:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
  });

  test('an unknown id serves the constant card and leaks neither title nor class', async () => {
    const unknownId = generateRelicId();
    const response = await app.fetch(req(`/${unknownId}`));
    const body = await response.text();

    expect(body).not.toContain('Markdown');
    expect(body).toContain('<meta property="og:title" content="A relic">');
    expect(body).toContain('<meta name="twitter:title" content="A relic">');
    expect(body).toContain('<title>Relic</title>');
    expect(body).toContain(
      '<meta property="og:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
    expect(body).toContain(
      '<meta name="twitter:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
    expect(body).toContain(`https://relic.example/${unknownId}`);
  });

  test('a malformed id serves the unknown pair and leaks neither title nor class', async () => {
    const malformedId = 'not-valid-base32-id!!';
    const response = await app.fetch(req(`/${malformedId}`));
    const body = await response.text();

    expect(body).not.toContain('Markdown');
    expect(body).toContain('<meta property="og:title" content="A relic">');
    expect(body).toContain('<meta name="twitter:title" content="A relic">');
    expect(body).toContain('<title>Relic</title>');
    expect(body).toContain(
      '<meta property="og:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
    expect(body).toContain(
      '<meta name="twitter:description" content="An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can read it.">'
    );
  });
  test('a reserved-word-shaped non-id serves the constant card with origin root and leaks nothing', async () => {
    await app.store.putRelic({
      id: 'not-a-valid-id',
      publishIp: '198.51.100.10',
      grantedAt: now,
      expiresAt: undefined,
      rendererClass: 'markdown',
      publishingClient: 'test',
      declaredSizeBytes: 12,
      version: 1,
      publishTokenHash: 'hash',
      mintsUsed: 0,
      title: 'Secret NonId Title',
    });

    const response = await app.fetch(req('/not-a-valid-id'));
    const body = await response.text();

    expect(body).not.toContain('Secret NonId Title');
    expect(body).toContain('<meta property="og:title" content="A relic">');
    expect(body).toContain('<meta name="twitter:title" content="A relic">');
    expect(body).toContain('<title>Relic</title>');
    expect(body).toContain(
      '<meta property="og:url" content="https://relic.example/">'
    );
  });

  test('serving /{id} for a titled relic still writes no mint log entry and leaves mintsUsed at 0', async () => {
    const { id } = await publish({ title: 'Uncounted Title' });
    const before = await app.store.readMintLog();

    const response = await app.fetch(req(`/${id}`));
    expect(response.status).toBe(200);

    expect(await app.store.readMintLog()).toHaveLength(before.length);
    expect((await app.store.getRelic(id))?.mintsUsed).toBe(0);
  });

  test('serving /{id} for a classed relic still writes no mint log entry and leaves mintsUsed at 0', async () => {
    const { id } = await publish({
      rendererClass: 'archive',
      title: 'Classed Relic',
    });
    const before = await app.store.readMintLog();

    const response = await app.fetch(req(`/${id}`));
    expect(response.status).toBe(200);

    expect(await app.store.readMintLog()).toHaveLength(before.length);
    expect((await app.store.getRelic(id))?.mintsUsed).toBe(0);
  });

  test('/assets/card.v1.png is served image/png with immutable cache policy and no content-encoding', async () => {
    const customApp = createApp({
      assets: memoryAssets({
        'card.v1.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        'viewer.js': 'console.log("viewer")',
        'styles.css': 'body { margin: 0; }',
      }),
    });

    const request = new Request('https://relic.example/assets/card.v1.png', {
      headers: { 'accept-encoding': 'gzip, br' },
    });
    const response = await customApp.fetch(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable'
    );
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-encoding')).toBeNull();

    const jsResponse = await customApp.fetch(
      new Request('https://relic.example/assets/viewer.js', {
        headers: { 'accept-encoding': 'gzip, br' },
      })
    );
    expect(jsResponse.headers.get('cache-control')).toBe('no-store');
    expect(jsResponse.headers.get('content-encoding')).toBe('gzip');

    const cssResponse = await customApp.fetch(
      new Request('https://relic.example/assets/styles.css', {
        headers: { 'accept-encoding': 'gzip, br' },
      })
    );
    expect(cssResponse.headers.get('cache-control')).toBe('no-store');
    expect(cssResponse.headers.get('content-encoding')).toBe('gzip');
  });
});

describe('reserved segments beat ids at the router', () => {
  for (const word of RESERVED_SEGMENTS) {
    test(`/${word} is not treated as a relic id`, async () => {
      const response = await app.fetch(req(`/${word}`));
      // Whatever it does, it must not be the relic shell for an id.
      const body = await response.text();
      expect(body).not.toContain(`data-relic-id="${word}"`);
    });
  }

  test('/abuse serves the form, which is a go/no-go obligation', async () => {
    const response = await app.fetch(req('/abuse'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<form method="post"');
  });

  test('/robots.txt disallows', async () => {
    expect(await app.fetch(req('/robots.txt')).then((r) => r.text())).toContain(
      'Disallow: /'
    );
  });

  test('/policy publishes the disclosure statement', async () => {
    const body = await app.fetch(req('/policy')).then((r) => r.text());
    expect(body).toContain('Your browser never sends the');
    expect(body).toContain('enters the model');
    expect(body).toContain('Deleted does not mean erased');
    expect(body).toContain('permits no remote source');
    expect(body).toContain('renders without them');
    expect(body).toContain('not safety');
    expect(body).toContain('markdown, code, html, jsx, image');
    expect(body).toContain('archive, binary, otio');
    expect(body).toContain(
      "Anyone holding a relic's link can fetch every version it has ever held"
    );
    expect(body).toContain(
      'When someone comments or a relic gets a new version, we email the people following it.'
    );
    expect(body).toContain('Sharing gives us addresses, never the link.');
    expect(body).toContain('One stop link stops every email about that relic.');
  });

  test('/install on a self-hosted deployment names the origin to point at', async () => {
    // A self-hoster needs it: without the variable their client resolves the
    // hosted default and publishes to somebody else's service.
    const response = await app.fetch(req('/install'));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('claude mcp add relic');
    expect(body).toContain('RELIC_SERVICE_ORIGIN=https://relic.example');
    expect(body).toContain('"RELIC_SERVICE_ORIGIN": "https://relic.example"');
  });

  test('/install on the hosted service configures nothing', async () => {
    // The reported defect. The hosted service was printing
    // `--env RELIC_SERVICE_ORIGIN=https://relik.link` in its own install
    // instructions, which asks a recipient of a hosted product to choose
    // which host they are already on. That belongs in the repository, for
    // somebody running their own.
    // `build` so the deployment differs from the default in exactly one way,
    // the origin, rather than in whatever a hand-assembled config forgets.
    const hostedApp = build({
      config: {
        serviceOrigin: 'https://relik.link',
        usercontentOrigin: 'https://relic-usercontent.example',
      },
    });

    const body = await hostedApp
      .fetch(new Request('https://relik.link/install'))
      .then((r) => r.text());

    expect(body).toContain('claude mcp add relic');
    // Not a substring check on the whole variable name only: the page must
    // not mention it at all, in either snippet or in prose explaining it.
    expect(body).not.toContain('RELIC_SERVICE_ORIGIN');
    expect(body).not.toContain('Why the origin is required');
    // And the command it does print has to be the whole command, not a
    // fragment left behind by removing the flag.
    expect(body).toContain('claude mcp add relic -- npx -y relic-mcp@latest');
  });

  test('/install claims no more than the system delivers', async () => {
    const body = await app.fetch(req('/install')).then((r) => r.text());
    // The decrypting page is served by the operator the claim is made against,
    // so the copy may not say the operator cannot read a relic.
    expect(body).toContain('rests on our intent');
    expect(body).not.toMatch(/nobody can read/i);
  });

  test('/install is noindex and needs no script', async () => {
    const response = await app.fetch(req('/install'));
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'"
    );
    const body = await response.text();
    expect(body).not.toContain('<script');
    expect(body).not.toContain('id="home-relics"');
  });
});

describe('the landing page', () => {
  const mount =
    '<section id="home-relics" class="home-relics" aria-labelledby="home-relics-title" hidden></section>';
  const script = '<script type="module" src="/assets/home.js"></script>';

  test('/ is a real page, not the shell with a bogus relic id', async () => {
    const response = await app.fetch(req('/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await response.text();
    // The regression this page exists to fix: `/` used to serve the viewer
    // shell fed the literal string "Relic" as an id, so the homepage rendered
    // as a relic that does not exist. The manifest's start_url is `/`, so the
    // installed app landed there too.
    expect(body).not.toContain('id="relic-root"');
    expect(body).not.toContain('/assets/viewer.js');
  });

  test('/ contains the home relics mount between the lede and how it goes', async () => {
    const body = await app.fetch(req('/')).then((r) => r.text());
    expect(body).toContain(mount);
    const ledeIndex = body.indexOf('class="lede"');
    const mountIndex = body.indexOf(mount);
    const headingIndex = body.indexOf('<h2>How it goes</h2>');
    expect(ledeIndex).toBeGreaterThan(-1);
    expect(mountIndex).toBeGreaterThan(ledeIndex);
    expect(headingIndex).toBeGreaterThan(mountIndex);
  });

  test('/ contains exactly one script tag and no inline script', async () => {
    const body = await app.fetch(req('/')).then((r) => r.text());
    const scripts = body.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toEqual(['<script type="module" src="/assets/home.js">']);
    expect(body).toContain(script);
    expect(body).not.toMatch(/<script(?:\s+type="module")?\s*>/i);
  });

  test('/ sends exactly the contract headers with script-src and no connect-src', async () => {
    const response = await app.fetch(req('/'));
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toBe(
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'"
    );
    expect(csp).not.toContain('connect-src');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('/ with the mount and script removed equals /install byte-for-byte', async () => {
    const root = await app.fetch(req('/')).then((r) => r.text());
    const install = await app.fetch(req('/install')).then((r) => r.text());
    expect(root).toContain(mount);
    expect(root).toContain(script);
    expect(root.replace(mount, '').replace(script, '')).toBe(install);
  });

  test('carries the three install forms, each naming the configured origin', async () => {
    // build() leaves serviceOrigin at its default, which is the origin the
    // forms must interpolate; relik.link must not appear by accident.
    const body = await app.fetch(req('/')).then((r) => r.text());
    expect(body).toContain('claude mcp add');
    expect(body).toContain('mcpServers');
    expect(body).toContain('RELIC_SERVICE_ORIGIN');
    expect(body).toContain('https://relic.example');
  });

  test('links the policy, the abuse form, and the installable manifest', async () => {
    const body = await app.fetch(req('/')).then((r) => r.text());
    expect(body).toContain('href="/policy"');
    expect(body).toContain('href="/abuse"');
    expect(body).toContain('href="/manifest.webmanifest"');
  });

  test('a single segment that is not reserved still serves the viewer shell', async () => {
    // Guards the router change that gave `/` to the landing page: an id-shaped
    // path must keep reaching the shell.
    const body = await app
      .fetch(req('/aaaaaaaaaaaaaaaaaaaaaaaaaa'))
      .then((r) => r.text());
    expect(body).toContain('id="relic-root"');
  });
});

describe('the grant', () => {
  test('returns the cap before a grant is requested', async () => {
    const body = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as Record<string, unknown>;
    expect(body['size_limit_bytes']).toBe(100 * 1024 * 1024);
    expect(body['size_basis']).toBe('plaintext');
  });

  test('refuses a dead challenge nonce with a code the client can key on', async () => {
    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: 'never-issued',
          relic_id: generateRelicId(),
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('invalid_challenge_nonce');
  });

  test('refuses an expired challenge nonce', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    now += 6 * 60 * 1000;

    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: generateRelicId(),
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );
    expect((await response.json()).code).toBe('invalid_challenge_nonce');
  });

  test('names which id check failed', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };

    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: 'too-short',
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe('invalid_relic_id');
    expect(body.id_validation_failure).toBe('length');
  });

  test('refuses an over-cap declaration with 413 and the three size fields', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };

    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: generateRelicId(),
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 200 * 1024 * 1024,
          declared_ciphertext_bytes: encryptedSize(200 * 1024 * 1024),
        }),
      })
    );
    const body = await response.json();
    expect(response.status).toBe(413);
    expect(body.code).toBe('size_over_cap');
    expect(body.size_basis).toBe('plaintext');
    expect(body.size_limit_bytes).toBe(100 * 1024 * 1024);
    expect(body.declared_size_bytes).toBe(200 * 1024 * 1024);
  });

  test('refuses a renderer class outside the seven', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };

    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: generateRelicId(),
          renderer_class: 'spreadsheet',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_publish_metadata');
  });

  test('grant title validation and storage', async () => {
    const nonString = await grantFor({ title: 12345 });
    expect(nonString.status).toBe(400);
    expect((await nonString.json()).code).toBe('invalid_publish_metadata');

    const tooLong = await grantFor({ title: 'a'.repeat(129) });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).code).toBe('invalid_publish_metadata');

    const withControl = await grantFor({ title: 'line1\nline2' });
    expect(withControl.status).toBe(400);
    expect((await withControl.json()).code).toBe('invalid_publish_metadata');

    const validId = generateRelicId();
    const validRes = await grantFor({ relic_id: validId, title: 'Good Title' });
    expect(validRes.status).toBe(200);
    const validRow = await app.store.getRelic(validId);
    expect(validRow?.title).toBe('Good Title');

    const trimmedId = generateRelicId();
    const trimmedRes = await grantFor({
      relic_id: trimmedId,
      title: '   Trimmed Title   ',
    });
    expect(trimmedRes.status).toBe(200);
    const trimmedRow = await app.store.getRelic(trimmedId);
    expect(trimmedRow?.title).toBe('Trimmed Title');

    const emptyId = generateRelicId();
    const emptyRes = await grantFor({ relic_id: emptyId, title: '' });
    expect(emptyRes.status).toBe(200);
    expect((await app.store.getRelic(emptyId))?.title).toBeUndefined();

    const spaceId = generateRelicId();
    const spaceRes = await grantFor({ relic_id: spaceId, title: '    ' });
    expect(spaceRes.status).toBe(200);
    expect((await app.store.getRelic(spaceId))?.title).toBeUndefined();
  });

  test('never overwrites: a colliding id is refused with 409', async () => {
    const id = generateRelicId();
    await publish({ id });

    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: id,
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('relic_id_collision');
  });

  test("signs the object's exact byte length, not the cap", async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    const grant = (await app
      .fetch(
        req('/api/grant', {
          method: 'POST',
          body: JSON.stringify({
            challenge_nonce: challenge.challenge_nonce,
            relic_id: generateRelicId(),
            renderer_class: 'markdown',
            publishing_client: 'test',
            declared_size_bytes: 5000,
            declared_ciphertext_bytes: encryptedSize(5000),
          }),
        })
      )
      .then((r) => r.json())) as { upload_headers: Record<string, string> };

    // Signing the cap would mean the upload had to be 100 MiB exactly, which
    // is the bug that made every real publish fail with a 403.
    expect(grant.upload_headers['content-length']).toBe(
      String(encryptedSize(5000))
    );
    expect(grant.upload_headers['content-length']).not.toBe(
      String(100 * 1024 * 1024)
    );
  });

  test('refuses a ciphertext length that disagrees with its own arithmetic', async () => {
    // A disagreement means the two ends have drifted on the format. Caught
    // here rather than producing an object nobody can open.
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };

    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: generateRelicId(),
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 5000,
          declared_ciphertext_bytes: encryptedSize(5000) + 1,
        }),
      })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('invalid_publish_metadata');
  });

  test('refuses a ciphertext length over the cap', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };

    const response = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: generateRelicId(),
          renderer_class: 'binary',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: 500 * 1024 * 1024,
        }),
      })
    );
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('size_over_cap');
  });

  test('signs no x-goog-meta header, because nothing needs object metadata', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    const grant = (await app
      .fetch(
        req('/api/grant', {
          method: 'POST',
          body: JSON.stringify({
            challenge_nonce: challenge.challenge_nonce,
            relic_id: generateRelicId(),
            renderer_class: 'markdown',
            publishing_client: 'test',
            declared_size_bytes: 1,
            declared_ciphertext_bytes: encryptedSize(1),
          }),
        })
      )
      .then((r) => r.json())) as { upload_headers: Record<string, string> };

    for (const header of Object.keys(grant.upload_headers)) {
      expect(header.toLowerCase().startsWith('x-goog-meta-')).toBe(false);
    }
  });
});

describe('the mint', () => {
  test('omitting version signs the current object for version 1', async () => {
    const { id } = await publish();
    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as Record<string, unknown>;

    expect(body['url']).toContain(`/o/${id}?`);
    expect(body['version']).toBe(1);
    expect(body['current_version']).toBe(1);
  });

  test('omitting version signs the current object for version 5', async () => {
    const { id } = await publishThroughVersion(5);
    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as Record<string, unknown>;

    expect(body['url']).toContain(`/o/${id}/v5?`);
    expect(body['version']).toBe(5);
    expect(body['current_version']).toBe(5);
  });

  test('version 1 on a version 5 relic signs the bare object path', async () => {
    const { id } = await publishThroughVersion(5);
    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, {
          method: 'POST',
          ip: '203.0.113.5',
          body: JSON.stringify({ version: 1 }),
        })
      )
      .then((r) => r.json())) as Record<string, unknown>;

    expect(body['url']).toContain(`/o/${id}?`);
    expect(body['url']).not.toContain(`/v1?`);
    expect(body['version']).toBe(1);
    expect(body['current_version']).toBe(5);
  });

  test('version 3 on a version 5 relic signs the v3 object path', async () => {
    const { id } = await publishThroughVersion(5);
    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, {
          method: 'POST',
          ip: '203.0.113.5',
          body: JSON.stringify({ version: 3 }),
        })
      )
      .then((r) => r.json())) as Record<string, unknown>;

    expect(body['url']).toContain(`/o/${id}/v3?`);
    expect(body['version']).toBe(3);
    expect(body['current_version']).toBe(5);
  });

  test('returns the eight fields the viewer consumes', async () => {
    const { id } = await publish();
    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      'current_version',
      'mints_remaining',
      'object_crc32c',
      'object_length',
      'relic_expires_at',
      'url',
      'url_expires_at',
      'version',
    ]);
  });

  test('excludes filename, mimetype, and renderer class', async () => {
    const { id } = await publish();
    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as Record<string, unknown>;

    for (const barred of ['filename', 'mimetype', 'renderer_class']) {
      expect(body[barred]).toBeUndefined();
    }
  });

  test('refuses an invalid explicit version without consuming the cap', async () => {
    const { id } = await publishThroughVersion(5);

    for (const version of [0, 6, -1, 1.5, 'three']) {
      const response = await app.fetch(
        req(`/api/relics/${id}/mint`, {
          method: 'POST',
          ip: `203.0.113.${String(version).length + 10}`,
          body: JSON.stringify({ version }),
        })
      );
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('invalid_relic_version');
    }

    expect((await app.store.getRelic(id))?.mintsUsed).toBe(0);
  });

  test('rate limiting counts each explicit-version mint', async () => {
    app = build({ config: { mintRateLimit: { limit: 2, windowSeconds: 60 } } });
    const { id } = await publishThroughVersion(5);
    const statuses: number[] = [];

    for (const version of [1, 3, 5]) {
      statuses.push(
        (
          await app.fetch(
            req(`/api/relics/${id}/mint`, {
              method: 'POST',
              ip: '203.0.113.5',
              body: JSON.stringify({ version }),
            })
          )
        ).status
      );
    }

    expect(statuses).toEqual([200, 200, 429]);
    expect((await app.store.getRelic(id))?.mintsUsed).toBe(2);
  });

  test('is case-insensitive on the id, and the cap does not fragment', async () => {
    const { id } = await publish();
    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    await app.fetch(
      req(`/api/relics/${id.toUpperCase()}/mint`, {
        method: 'POST',
        ip: '203.0.113.6',
      })
    );
    expect((await app.store.getRelic(id))?.mintsUsed).toBe(2);
  });

  test('a never-issued id is 404, distinguishable from expired', async () => {
    const response = await app.fetch(
      req(`/api/relics/${generateRelicId()}/mint`, { method: 'POST' })
    );
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('relic_not_found');
  });

  test('an expired relic is 410 relic_expired', async () => {
    const { id } = await publish({ ttlDays: 7 });
    now += 8 * 86_400 * 1000;
    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST' })
    );
    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe('relic_expired');
  });

  test('a granted-but-never-uploaded relic is 410 relic_never_published', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    const id = generateRelicId();
    await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: id,
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
          ttl_days: 7,
        }),
      })
    );
    now += 8 * 86_400 * 1000;

    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST' })
    );
    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe('relic_never_published');
  });

  test('a live grant whose bytes have not landed is 409, temporary and retryable', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    const id = generateRelicId();
    await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: id,
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );

    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST' })
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe('relic_not_yet_published');
    expect(body.retry_after_seconds).toBeGreaterThan(0);
    expect(response.headers.get('retry-after')).not.toBeNull();
  });
});

describe('counting', () => {
  test('an open from the publishing IP is dropped from the metric', async () => {
    const { id } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;
    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '198.51.100.10' })
    );

    const entry = (await app.store.readMintLog()).at(-1);
    expect(entry?.countedAsOpen).toBe(false);
    expect(entry?.dropReason).toBe('publishing_ip_match');
  });

  test('an open inside the post-publish window is dropped', async () => {
    const { id } = await publish({ ip: '198.51.100.10' });
    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );

    const entry = (await app.store.readMintLog()).at(-1);
    expect(entry?.countedAsOpen).toBe(false);
    expect(entry?.dropReason).toBe('post_publish_window');
  });

  test('a recipient open outside both filters counts', async () => {
    const { id } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;
    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );

    const entry = (await app.store.readMintLog()).at(-1);
    expect(entry?.countedAsOpen).toBe(true);
    expect(entry?.dropReason).toBeUndefined();
  });

  test('a repeat inside the dedup window is not a distinct open but still consumes cap', async () => {
    const { id } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;

    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    now += 60 * 1000;
    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );

    const log = await app.store.readMintLog();
    const last = log.at(-1);
    expect(last?.countedAsOpen).toBe(false);
    expect(last?.dropReason).toBe('dedup');
    expect(last?.consumedCap).toBe(true);
    expect((await app.store.getRelic(id))?.mintsUsed).toBe(2);
  });

  test('a deduped mint returns the URL already issued, never a fresh one', async () => {
    const { id } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;

    const first = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as { url: string };
    now += 60 * 1000;
    const second = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as { url: string };

    expect(second.url).toBe(first.url);
  });

  test('a refused mint is never an open and never consumes the cap', async () => {
    await app.fetch(
      req(`/api/relics/${generateRelicId()}/mint`, { method: 'POST' })
    );
    const entry = (await app.store.readMintLog()).at(-1);
    expect(entry?.outcome).toBe('refused');
    expect(entry?.countedAsOpen).toBe(false);
    expect(entry?.consumedCap).toBe(false);
  });

  test('the mint log records the code, not only the status', async () => {
    await app.fetch(
      req(`/api/relics/${generateRelicId()}/mint`, { method: 'POST' })
    );
    expect((await app.store.readMintLog()).at(-1)?.code).toBe(
      'relic_not_found'
    );
  });
});

describe('the publish completion call', () => {
  test('records a true publish timestamp', async () => {
    const { id } = await publish();
    now += 30 * 1000;

    const response = await app.fetch(
      req(`/api/relics/${id}/complete`, { method: 'POST' })
    );
    expect(response.status).toBe(200);
    expect((await app.store.getRelic(id))?.publishedAt).toBe(now);
  });

  test('is optional: a lost confirmation still yields a usable relic', async () => {
    const { id } = await publish();
    now += 10 * 60 * 1000;

    // No completion call was ever made.
    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    expect(response.status).toBe(200);
  });

  test('falls back to the grant time, so the first genuine open still counts', async () => {
    const { id } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;

    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    expect((await app.store.readMintLog()).at(-1)?.countedAsOpen).toBe(true);
  });

  test('an open inside the window of a reported publish is still dropped', async () => {
    const { id } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));

    now += 30 * 1000; // inside the 120-second window
    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );

    const entry = (await app.store.readMintLog()).at(-1);
    expect(entry?.countedAsOpen).toBe(false);
    expect(entry?.dropReason).toBe('post_publish_window');
  });

  test('refuses when the bytes have not landed', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    const id = generateRelicId();
    await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: id,
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );

    const response = await app.fetch(
      req(`/api/relics/${id}/complete`, { method: 'POST' })
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('relic_not_yet_published');
  });

  test('does not mint, consume cap, or write an open', async () => {
    const { id } = await publish();
    const before = (await app.store.readMintLog()).length;

    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));

    expect((await app.store.getRelic(id))?.mintsUsed).toBe(0);
    expect(await app.store.readMintLog()).toHaveLength(before);
  });
});

describe('republish and versions', () => {
  test('a first grant returns the publish token exactly once, at version 1', async () => {
    const { id, grant } = await publish();
    const token = grant['publish_token'];
    // 32 random bytes, base64url: 43 characters, no padding, no + or /.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = await app.store.getRelic(id);
    expect(row?.version).toBe(1);
    // The row holds a hash, never the credential itself.
    expect(row?.publishTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.publishTokenHash).not.toBe(token);
  });

  test('the token never appears outside the first grant response', async () => {
    const { id, grant } = await publish();
    const token = grant['publish_token'] as string;

    const response = await republish(id, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['publish_token']).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(token);
  });

  test('a valid token opens version 2 at the suffixed object path', async () => {
    const { id, grant } = await publish();

    const response = await republish(id, grant['publish_token'] as string, {
      rendererClass: 'html',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { upload_url: string };
    expect(body.upload_url).toContain(`/upload/${id}/v2?`);

    const row = await app.store.getRelic(id);
    expect(row?.version).toBe(2);
    expect(row?.rendererClass).toBe('html');
    // Version 1's object stays in place until the new one completes: a
    // republish in flight must not be able to destroy the servable bytes.
    expect(await storage.stat(id)).toBeDefined();
    expect(await storage.stat(`${id}/v2`)).toBeUndefined();
  });

  test('republish with no title key leaves stored title, empty string clears it, and value replaces it', async () => {
    const { id, grant } = await publish({ title: 'Initial Title' });
    const token = grant['publish_token'] as string;

    const res1 = await republish(id, token, { rendererClass: 'html' });
    expect(res1.status).toBe(200);
    const row1 = await app.store.getRelic(id);
    expect(row1?.version).toBe(2);
    expect(row1?.title).toBe('Initial Title');

    const res2 = await republish(id, token, { title: 'Second Title' });
    expect(res2.status).toBe(200);
    const row2 = await app.store.getRelic(id);
    expect(row2?.version).toBe(3);
    expect(row2?.title).toBe('Second Title');

    const res3 = await republish(id, token, { title: '   ' });
    expect(res3.status).toBe(200);
    const row3 = await app.store.getRelic(id);
    expect(row3?.version).toBe(4);
    expect(row3?.title).toBeUndefined();

    const res4 = await republish(id, token, { title: 'bad\0title' });
    expect(res4.status).toBe(400);
    expect((await res4.json()).code).toBe('invalid_publish_metadata');
  });

  test('completion and mint serve the new version bytes', async () => {
    const { id, key, grant } = await publish();
    const first = await storage.stat(id);

    await republish(id, grant['publish_token'] as string);
    const container = await encrypted('hello relic, revised and longer', key);
    storage.put(`${id}/v2`, container);

    now += 30 * 1000;
    const completed = await app.fetch(
      req(`/api/relics/${id}/complete`, { method: 'POST' })
    );
    expect(completed.status).toBe(200);
    const completedBody = await completed.json();
    expect(completedBody.object_length).toBe(container.length);
    // A true publish timestamp for the new version, same as a first publish.
    expect((await app.store.getRelic(id))?.publishedAt).toBe(now);

    const mint = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as {
      url: string;
      object_length: number;
      object_crc32c: string;
    };
    expect(mint.url).toContain(`/o/${id}/v2?`);
    expect(mint.object_length).toBe(container.length);
    expect(mint.object_crc32c).not.toBe(first?.crc32c);
  });

  test('a mint between republish and landing is the usual temporary 409', async () => {
    const { id, grant } = await publish();
    await republish(id, grant['publish_token'] as string);

    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('relic_not_yet_published');
  });

  test('a wrong or missing publish token is 403 invalid_publish_token', async () => {
    const { id, grant } = await publish();
    const token = grant['publish_token'] as string;

    for (const bad of [undefined, 'not-the-token', token.slice(0, 42)]) {
      const response = await republish(id, bad);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.code).toBe('invalid_publish_token');
      expect(body.relic_id).toBe(id);
    }
    // A refused republish does not consume a version.
    expect((await app.store.getRelic(id))?.version).toBe(1);
  });

  test('a takedown can never be undone by republishing', async () => {
    const { id, grant } = await publish();
    await app.fetch(
      req(`/api/relics/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );

    // The refusal lands before the token is even hashed, so the rightful
    // holder and a brute force are indistinguishable here.
    const response = await republish(id, grant['publish_token'] as string);
    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe('relic_removed');
  });

  test('the download cap is one number across all versions', async () => {
    app = build({ config: { downloadCap: 2 } });
    const { id, grant } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;

    for (let index = 0; index < 2; index++) {
      const response = await app.fetch(
        req(`/api/relics/${id}/mint`, {
          method: 'POST',
          ip: `203.0.113.${index + 20}`,
        })
      );
      expect(response.status).toBe(200);
    }

    await republish(id, grant['publish_token'] as string);
    storage.put(
      `${id}/v2`,
      await encrypted('hello relic again', generateKey())
    );
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));

    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.99' })
    );
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.code).toBe('download_cap_exhausted');
    expect(body.download_cap).toBe(2);
  });

  test('version 1 keeps the bare object path production already serves', async () => {
    const { id, grant } = await publish();
    expect(grant['upload_url']).toContain(`/upload/${id}?`);
    expect(await storage.stat(`${id}/v1`)).toBeUndefined();

    const mint = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as { url: string };
    expect(mint.url).toContain(`/o/${id}?`);
    expect(mint.url).not.toContain('/v1');
  });

  test('a repeat mint after a republish is a fresh URL for new content', async () => {
    const { id, key, grant } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;
    const first = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as { url: string };

    await republish(id, grant['publish_token'] as string);
    storage.put(
      `${id}/v2`,
      await encrypted('hello relic, second edition', key)
    );
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));

    // Still inside the dedup window, but the content changed: new content
    // is a first look, not a reload.
    now += 3 * 60 * 1000;
    const second = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as { url: string };
    expect(second.url).toContain(`/o/${id}/v2?`);
    expect(second.url).not.toBe(first.url);

    const entry = (await app.store.readMintLog()).at(-1);
    expect(entry?.countedAsOpen).toBe(true);
    expect(entry?.dropReason).toBeUndefined();
  });

  test('a delete removes and blocklists every version payload', async () => {
    const { id, key, grant } = await publish();
    const v1Bytes = await storage.read(id);
    if (v1Bytes === undefined) throw new Error('v1 bytes missing');
    const v1Hash = await ciphertextHash(v1Bytes);

    await republish(id, grant['publish_token'] as string);
    storage.put(`${id}/v2`, await encrypted('a second payload', key));
    await app.fetch(req(`/api/relics/${id}/complete`, { method: 'POST' }));

    const response = await app.fetch(
      req(`/api/relics/${id}?reason=abuse`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    expect(response.status).toBe(200);

    expect(await storage.stat(id)).toBeUndefined();
    expect(await storage.stat(`${id}/v2`)).toBeUndefined();

    // The tombstone records the version that was being served, and the
    // blocklist covers the older payload too: one republish must not be
    // able to hide a payload from the abuse control.
    const stone = await app.store.getTombstone(id);
    expect(stone?.ciphertextHash).not.toBe(v1Hash);
    expect(await app.store.isBlocklisted(stone?.ciphertextHash ?? '')).toBe(
      true
    );
    expect(await app.store.isBlocklisted(v1Hash)).toBe(true);
  });

  test('a republish declaration obeys the same size cap arithmetic', async () => {
    const { id, grant } = await publish();
    const response = await republish(id, grant['publish_token'] as string, {
      size: 200 * 1024 * 1024,
    });
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('size_over_cap');
    expect((await app.store.getRelic(id))?.version).toBe(1);
  });

  test('a republish on an unknown id is 404, an unparseable one is 400', async () => {
    const missing = await republish(generateRelicId(), 'whatever');
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('relic_not_found');

    const malformed = await republish('too-short', 'whatever');
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).code).toBe('invalid_relic_id');
  });
});

describe('the download cap', () => {
  test('exhaustion is 410 download_cap_exhausted, echoing the published cap', async () => {
    app = build({ config: { downloadCap: 2 } });
    const { id } = await publish({ ip: '198.51.100.10' });
    now += 10 * 60 * 1000;

    for (let index = 0; index < 2; index++) {
      const response = await app.fetch(
        req(`/api/relics/${id}/mint`, {
          method: 'POST',
          ip: `203.0.113.${index + 20}`,
        })
      );
      expect(response.status).toBe(200);
    }

    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.99' })
    );
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.code).toBe('download_cap_exhausted');
    expect(body.download_cap).toBe(2);
  });

  test('the default cap clears the 40-person Defender arithmetic with room', async () => {
    // A 40-person list draws a floor of 40 legitimate mints and a ceiling near
    // 80 where scanners detonate with a real browser.
    expect(app.config.downloadCap).toBeGreaterThanOrEqual(80);
  });
});

describe('signed URL validity', () => {
  test('clamps to min(url_validity, relic_expiry)', async () => {
    const { id } = await publish({ ttlDays: 7 });
    // 5 minutes of relic life left, against a 15-minute validity window.
    now += 7 * 86_400 * 1000 - 5 * 60 * 1000;

    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as { url_expires_at: string };

    expect(Date.parse(body.url_expires_at)).toBeLessThanOrEqual(
      now + 5 * 60 * 1000 + 1000
    );
  });

  test('refuses below the minimum viable validity rather than issuing a dying URL', async () => {
    const { id } = await publish({ ttlDays: 7 });
    now += 7 * 86_400 * 1000 - 30 * 1000;

    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe('relic_expired');
  });
});

describe('publisher lifetimes', () => {
  const grantedAt = Date.parse('2026-08-02T12:00:00.000Z');

  test('a grant with no ttl_days reports no deadline', async () => {
    const response = await grantFor({});
    const grant = (await response.json()) as {
      relic_expires_at: string | null;
    };
    expect(grant.relic_expires_at).toBeNull();
  });

  test('an explicit null ttl_days means the same as omitting it', async () => {
    const response = await grantFor({ ttl_days: null });
    const grant = (await response.json()) as {
      relic_expires_at: string | null;
    };
    expect(grant.relic_expires_at).toBeNull();
  });

  test('a supplied ttl_days is recorded as the grant deadline', async () => {
    const response = await grantFor({ ttl_days: 3 });
    const grant = (await response.json()) as {
      relic_expires_at: string | null;
    };
    expect(grant.relic_expires_at).toBe(
      new Date(grantedAt + 3 * 86_400 * 1000).toISOString()
    );
  });

  test('the ttl_days boundaries are inclusive', async () => {
    for (const ttlDays of [1, 3650]) {
      const response = await grantFor({ ttl_days: ttlDays });
      expect(response.status).toBe(200);
    }
  });

  test('out-of-range and non-integer ttl_days refuse with invalid_publish_metadata', async () => {
    for (const bad of [0, -1, 1.5, 3651, '7', true]) {
      const response = await grantFor({ ttl_days: bad });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('invalid_publish_metadata');
    }
  });

  test('a relic with no lifetime mints however far the clock advances', async () => {
    const { id } = await publish();
    // Past the 3650-day ceiling, past any retention window.
    now += 11 * 365 * 86_400 * 1000;
    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      relic_expires_at: string | null;
    };
    expect(body.relic_expires_at).toBeNull();
  });

  test('a relic with no lifetime reports null on complete too', async () => {
    const { id } = await publish();
    const response = await app.fetch(
      req(`/api/relics/${id}/complete`, { method: 'POST' })
    );
    expect(response.status).toBe(200);
    expect((await response.json()).relic_expires_at).toBeNull();
  });

  test('a relic with no lifetime mints at the full validity window', async () => {
    const { id } = await publish();
    // Thirty days past any TTL this service ever had, and the URL still
    // carries the whole fifteen minutes: nothing left to clamp against.
    now += 30 * 86_400 * 1000;
    const body = (await app
      .fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
      )
      .then((r) => r.json())) as { url_expires_at: string };
    expect(Date.parse(body.url_expires_at)).toBe(now + 15 * 60 * 1000);
  });

  test('a relic granted a lifetime behaves exactly as the fixed TTL did', async () => {
    const { id } = await publish({ ttlDays: 7 });
    now += 6 * 86_400 * 1000;
    const live = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    expect(live.status).toBe(200);

    now += 2 * 86_400 * 1000;
    const dead = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.6' })
    );
    expect(dead.status).toBe(410);
    expect((await dead.json()).code).toBe('relic_expired');
  });
});

describe('the kill switch', () => {
  test('refuses every mint with 503 service_paused', async () => {
    app = build({ config: { killSwitchEngaged: true } });
    const response = await app.fetch(
      req(`/api/relics/${generateRelicId()}/mint`, { method: 'POST' })
    );
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('service_paused');
  });

  test('refuses publishing too', async () => {
    app = build({ config: { killSwitchEngaged: true } });
    const response = await app.fetch(req('/api/challenge', { method: 'POST' }));
    expect(response.status).toBe(503);
  });
});

describe('rate limiting', () => {
  test('refuses with 429 and never 401 or 403', async () => {
    app = build({ config: { mintRateLimit: { limit: 2, windowSeconds: 60 } } });
    const { id } = await publish();

    const statuses: number[] = [];
    for (let index = 0; index < 5; index++) {
      const response = await app.fetch(
        req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.7' })
      );
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
    expect(statuses).not.toContain(401);
    expect(statuses).not.toContain(403);
  });

  test('sends both Retry-After and the mirrored extension member', async () => {
    app = build({ config: { mintRateLimit: { limit: 1, windowSeconds: 60 } } });
    const { id } = await publish();
    await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.8' })
    );
    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.8' })
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect((await response.json()).retry_after_seconds).toBeGreaterThan(0);
  });

  test('rotating a spoofed leading X-Forwarded-For entry does not bypass rate limiting', async () => {
    app = build({ config: { authRateLimit: { limit: 1, windowSeconds: 60 } } });
    const trustedClientIp = '198.51.100.10';
    const lbIp = '130.211.0.1';

    const first = await app.fetch(
      new Request('https://relic.example/api/auth/request', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `203.0.113.195, ${trustedClientIp}, ${lbIp}`,
        },
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );
    expect(first.status).toBe(202);

    const second = await app.fetch(
      new Request('https://relic.example/api/auth/request', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `203.0.113.196, ${trustedClientIp}, ${lbIp}`,
        },
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );
    expect(second.status).toBe(429);
    expect((await second.json()).code).toBe('auth_rate_limited');
  });

  test('local no-proxy requests derive client IP from fallback without bypassing limits', async () => {
    app = build({ config: { authRateLimit: { limit: 1, windowSeconds: 60 } } });

    const first = await app.fetch(
      new Request('https://relic.example/api/auth/request', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );
    expect(first.status).toBe(202);

    const second = await app.fetch(
      new Request('https://relic.example/api/auth/request', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );
    expect(second.status).toBe(429);
    expect((await second.json()).code).toBe('auth_rate_limited');
  });
});

describe('problem documents', () => {
  test('are served as application/problem+json', async () => {
    const response = await app.fetch(
      req(`/api/relics/${generateRelicId()}/mint`, { method: 'POST' })
    );
    expect(response.headers.get('content-type')).toBe(
      'application/problem+json'
    );
  });

  test('carry an occurrence id in instance, never the request path', async () => {
    const id = generateRelicId();
    const body = (await app
      .fetch(req(`/api/relics/${id}/mint`, { method: 'POST' }))
      .then((r) => r.json())) as { instance: string };

    expect(body.instance).toContain('/problems/occurrences/');
    expect(body.instance).not.toContain(id);
  });

  test('the occurrence id joins the response to a mint log line', async () => {
    const body = (await app
      .fetch(req(`/api/relics/${generateRelicId()}/mint`, { method: 'POST' }))
      .then((r) => r.json())) as { instance: string };

    const occurrenceId = body.instance.split('/').pop();
    const entry = (await app.store.readMintLog()).at(-1);
    expect(entry?.occurrenceId).toBe(occurrenceId as string);
  });

  test('type is generated from code, so the two cannot disagree', async () => {
    const body = (await app
      .fetch(req(`/api/relics/${generateRelicId()}/mint`, { method: 'POST' }))
      .then((r) => r.json())) as { type: string; code: string };
    expect(body.type).toBe(`https://relic.example/problems/${body.code}`);
  });
});

describe('delete by id', () => {
  test('requires an operator credential', async () => {
    const { id } = await publish();
    const response = await app.fetch(
      req(`/api/relics/${id}`, { method: 'DELETE' })
    );
    expect(response.status).toBe(401);
  });

  test('stops serving and tombstones the row, which is never removed', async () => {
    const { id } = await publish();
    const response = await app.fetch(
      req(`/api/relics/${id}?reason=abuse&reference=REP-1`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    expect(response.status).toBe(200);

    const stone = await app.store.getTombstone(id);
    expect(stone?.operator).toBe('jason');
    expect(stone?.reasonClass).toBe('abuse');
    expect(stone?.reportReference).toBe('REP-1');
    // Upload IP and timestamp survive for law enforcement.
    expect(stone?.publishIp).toBe('198.51.100.10');
    expect(stone?.ciphertextHash).toHaveLength(64);
  });

  test('a deleted relic mints 410 relic_removed with the appeal path', async () => {
    const { id } = await publish();
    await app.fetch(
      req(`/api/relics/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );

    const response = await app.fetch(
      req(`/api/relics/${id}/mint`, { method: 'POST', ip: '203.0.113.5' })
    );
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.code).toBe('relic_removed');
    expect(body.report_url).toBe('https://relic.example/abuse');
  });

  test('the public code never names the reason', async () => {
    for (const reason of ['abuse', 'legal', 'blocklist_match']) {
      const local = build();
      app = local;
      const { id } = await publish();
      await app.fetch(
        req(`/api/relics/${id}?reason=${reason}`, {
          method: 'DELETE',
          headers: { authorization: 'Bearer operator-secret' },
        })
      );
      const body = await app
        .fetch(req(`/api/relics/${id}/mint`, { method: 'POST' }))
        .then((r) => r.json());
      expect(body.code).toBe('relic_removed');
    }
  });

  test('blocklists automatically on abuse, not on legal', async () => {
    const first = await publish();
    await app.fetch(
      req(`/api/relics/${first.id}?reason=abuse`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    const abuseStone = await app.store.getTombstone(first.id);
    expect(
      await app.store.isBlocklisted(abuseStone?.ciphertextHash ?? '')
    ).toBe(true);

    const second = await publish();
    await app.fetch(
      req(`/api/relics/${second.id}?reason=legal`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    const legalStone = await app.store.getTombstone(second.id);
    expect(
      await app.store.isBlocklisted(legalStone?.ciphertextHash ?? '')
    ).toBe(false);
  });

  test('is idempotent and never returns 404 on a tombstoned id', async () => {
    const { id } = await publish();
    const auth = { authorization: 'Bearer operator-secret' };
    await app.fetch(
      req(`/api/relics/${id}`, { method: 'DELETE', headers: auth })
    );

    const second = await app.fetch(
      req(`/api/relics/${id}`, { method: 'DELETE', headers: auth })
    );
    expect(second.status).toBe(200);
    expect((await second.json()).already_deleted).toBe(true);
  });

  test('404 on the delete endpoint means never issued, and nothing else', async () => {
    const response = await app.fetch(
      req(`/api/relics/${generateRelicId()}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    expect(response.status).toBe(404);
  });

  test('refuses a delete it cannot hash', async () => {
    const challenge = (await app
      .fetch(req('/api/challenge', { method: 'POST' }))
      .then((r) => r.json())) as { challenge_nonce: string };
    const id = generateRelicId();
    await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce: challenge.challenge_nonce,
          relic_id: id,
          renderer_class: 'markdown',
          publishing_client: 'test',
          declared_size_bytes: 1,
          declared_ciphertext_bytes: encryptedSize(1),
        }),
      })
    );

    const response = await app.fetch(
      req(`/api/relics/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    expect(response.status).toBe(409);
  });
});

describe('the abuse form', () => {
  test('strips the fragment server-side, which is the only strip a no-JS post reaches', async () => {
    const key = 'r1AAAAAAAAAAAAAAAAAAAA';
    const id = generateRelicId();
    const form = new FormData();
    form.set('relic_id', `https://relic.example/${id}#${key}`);
    form.set('category', 'phishing');
    form.set('description', 'looks like a credential harvest');

    const response = await app.fetch(
      req('/abuse', { method: 'POST', body: form })
    );
    expect(response.status).toBe(202);

    const reports = await app.store.readAbuseReports();
    expect(reports[0]?.relicId).toBe(id);
    expect(JSON.stringify(reports)).not.toContain(key);
  });

  test('requires authority and reference on legal process', async () => {
    const form = new FormData();
    form.set('relic_id', generateRelicId());
    form.set('category', 'legal_process');
    form.set('description', 'court order');

    const response = await app.fetch(
      req('/abuse', { method: 'POST', body: form })
    );
    expect(response.status).toBe(400);
  });
});

describe('stripToRelicId', () => {
  test('drops the fragment and the origin', () => {
    expect(stripToRelicId('https://relic.example/abc123#r1KEY')).toBe('abc123');
  });

  test('accepts a bare id', () => {
    expect(stripToRelicId('abc123')).toBe('abc123');
  });

  test('drops a fragment on a bare id', () => {
    expect(stripToRelicId('abc123#r1KEY')).toBe('abc123');
  });
});

describe('config invariants', () => {
  test('refuses a dedup interval inside the post-publish window', () => {
    expect(() =>
      createApp({
        config: { mintDedupSeconds: 60, postPublishWindowSeconds: 120 },
      })
    ).toThrow(/dedup/);
  });

  test('refuses a usercontent origin sharing the service host', () => {
    expect(() =>
      createApp({
        config: {
          serviceOrigin: 'https://relic.example',
          usercontentOrigin: 'https://relic.example',
        },
      })
    ).toThrow(/distinct host/);
  });

  test('refuses a URL validity over the GCS ceiling', () => {
    expect(() =>
      createApp({ config: { urlValiditySeconds: 700_000 } })
    ).toThrow(/ceiling/);
  });
});

describe('comments', () => {
  test('lists an empty thread without asking who you are', async () => {
    const { id } = await publish();
    const response = await app.fetch(req(`/api/relics/${id}/comments`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([]);
  });

  test('the publisher comments with the publish token and is stored as publisher', async () => {
    const { id, grant } = await publish();
    const token = grant['publish_token'] as string;

    const posted = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: 'YWJjZA',
          publish_token: token,
        }),
      })
    );
    expect(posted.status).toBe(201);
    const created = (await posted.json()) as { author: string };
    expect(created.author).toBe('publisher');

    const listed = await app.fetch(req(`/api/relics/${id}/comments`));
    const listedBody = await listed.json();
    expect(Array.isArray(listedBody)).toBe(true);
    expect(listedBody).toHaveLength(1);
    expect(listedBody[0]?.author).toBe('publisher');
    expect(listedBody[0]?.ciphertext).toBe('YWJjZA');
  });

  test('the stored ciphertext is not the plaintext, which is the zero-knowledge claim', async () => {
    const { id, key, grant } = await publish();
    const token = grant['publish_token'] as string;
    const secret = 'the body the server must never see';

    const commentKey = await deriveCommentKey(key);
    const ciphertext = await encryptComment(commentKey, {
      body: secret,
      display_name: null,
    });

    const posted = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ ciphertext, publish_token: token }),
      })
    );
    expect(posted.status).toBe(201);

    const rows = await app.store.listComments(id);
    expect(rows).toHaveLength(1);
    const stored = rows[0]?.ciphertext ?? '';
    expect(stored).toBe(ciphertext);
    expect(stored).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toContain(secret);

    // And a holder of the fragment key can still read it, which is the
    // other half of the claim: opaque to the server, readable to anyone
    // who already holds the relic.
    const opened = await decryptComment(commentKey, stored);
    expect(opened.body).toBe(secret);
  });

  test('refuses a body that is not base64url, the one check this server can make', async () => {
    const { id, grant } = await publish();
    const posted = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: 'not+valid/base64==',
          publish_token: grant['publish_token'],
        }),
      })
    );
    expect(posted.status).toBe(400);
    expect((await posted.json()).code).toBe('invalid_comment');
    expect(await app.store.listComments(id)).toHaveLength(0);
  });

  test('a tombstoned relic has no thread, even to a reader who already has the link', async () => {
    const { id } = await publish();
    await app.fetch(
      req(`/api/relics/${id}?reason=abuse`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );

    const listed = await app.fetch(req(`/api/relics/${id}/comments`));
    expect(listed.status).toBe(410);
    expect((await listed.json()).code).toBe('relic_removed');
  });

  test('deleting a relic takes its comments with it', async () => {
    const { id, grant } = await publish();
    await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: 'YWJjZA',
          publish_token: grant['publish_token'],
        }),
      })
    );
    expect(await app.store.listComments(id)).toHaveLength(1);

    const deleted = await app.fetch(
      req(`/api/relics/${id}?reason=abuse`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    expect(deleted.status).toBe(200);
    expect((await deleted.json()).comments_deleted).toBe(1);
    expect(await app.store.listComments(id)).toHaveLength(0);
  });

  test('the author can delete their own comment, and nobody else can', async () => {
    const { id, grant } = await publish();
    const token = grant['publish_token'] as string;
    const posted = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ ciphertext: 'YWJjZA', publish_token: token }),
      })
    );
    const commentId = ((await posted.json()) as { comment_id: string })
      .comment_id;

    const stranger = await app.fetch(
      req(`/api/relics/${id}/comments/${commentId}`, {
        method: 'DELETE',
        body: JSON.stringify({}),
      })
    );
    expect(stranger.status).toBe(403);
    expect((await stranger.json()).code).toBe('comment_forbidden');
    expect(await app.store.listComments(id)).toHaveLength(1);

    const own = await app.fetch(
      req(`/api/relics/${id}/comments/${commentId}`, {
        method: 'DELETE',
        body: JSON.stringify({ publish_token: token }),
      })
    );
    expect(own.status).toBe(204);
    expect(await app.store.listComments(id)).toHaveLength(0);
  });

  test('absent version in post stamps current relic version', async () => {
    const { id, key, grant } = await publish();
    const token = grant['publish_token'] as string;

    const post1 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ ciphertext: 'YWJjZA', publish_token: token }),
      })
    );
    expect(post1.status).toBe(201);

    const list1 = (await (
      await app.fetch(req(`/api/relics/${id}/comments`))
    ).json()) as Array<{
      version: number | null;
    }>;
    expect(list1).toHaveLength(1);
    expect(list1[0]?.version).toBe(1);

    // Advance time and advance relic to version 2
    now += 1000;
    await republish(id, token);
    storage.put(`${id}/v2`, await encrypted('relic revision 2', key));

    now += 1000;
    const post2 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ ciphertext: 'ZGVmZw', publish_token: token }),
      })
    );
    expect(post2.status).toBe(201);

    const list2 = (await (
      await app.fetch(req(`/api/relics/${id}/comments`))
    ).json()) as Array<{
      version: number | null;
    }>;
    expect(list2).toHaveLength(2);
    expect(list2[0]?.version).toBe(1);
    expect(list2[1]?.version).toBe(2);
  });

  test('a valid earlier version in post is stored as given', async () => {
    const { id, key, grant } = await publish();
    const token = grant['publish_token'] as string;

    // Advance to version 3
    await republish(id, token);
    storage.put(`${id}/v2`, await encrypted('relic revision 2', key));
    await republish(id, token);
    storage.put(`${id}/v3`, await encrypted('relic revision 3', key));
    now += 1000;
    const postV1 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: 'Y29tbWVudDE',
          publish_token: token,
          version: 1,
        }),
      })
    );
    expect(postV1.status).toBe(201);
    now += 1000;
    const postV2 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: 'Y29tbWVudDI',
          publish_token: token,
          version: 2,
        }),
      })
    );
    expect(postV2.status).toBe(201);
    now += 1000;
    const postV3 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: 'Y29tbWVudDM',
          publish_token: token,
          version: 3,
        }),
      })
    );
    expect(postV3.status).toBe(201);

    const list = (await (
      await app.fetch(req(`/api/relics/${id}/comments`))
    ).json()) as Array<{
      version: number | null;
      ciphertext: string;
    }>;
    expect(list).toHaveLength(3);
    expect(list[0]?.version).toBe(1);
    expect(list[1]?.version).toBe(2);
    expect(list[2]?.version).toBe(3);
  });

  test('refuses invalid versions on comment post with 400 invalid_relic_version', async () => {
    const { id, key, grant } = await publish();
    const token = grant['publish_token'] as string;

    // Advance to version 2
    await republish(id, token);
    storage.put(`${id}/v2`, await encrypted('relic revision 2', key));

    // Zero, negative, fraction, string, and one past current (3)
    for (const badVersion of [0, -1, 1.5, 'three', 3]) {
      const response = await app.fetch(
        req(`/api/relics/${id}/comments`, {
          method: 'POST',
          body: JSON.stringify({
            ciphertext: 'YWJjZA',
            publish_token: token,
            version: badVersion,
          }),
        })
      );
      expect(response.status).toBe(400);
      const problem = (await response.json()) as Record<string, unknown>;
      expect(problem['code']).toBe('invalid_relic_version');
      expect(problem['relic_id']).toBe(id);
    }

    expect(await app.store.listComments(id)).toHaveLength(0);
  });

  test('unauthenticated caller with out-of-range version receives 401 rather than 400', async () => {
    const { id } = await publish();

    // No session cookie and no publish token provided
    const response = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: 'YWJjZA',
          version: 999,
        }),
      })
    );
    expect(response.status).toBe(401);
    const problem = (await response.json()) as Record<string, unknown>;
    expect(problem['code']).toBe('invalid_session');
  });

  test('get returns version as a number for versioned rows and null for legacy rows', async () => {
    const { id, grant } = await publish();
    const token = grant['publish_token'] as string;

    // Seed a legacy comment directly in store with no version key
    await app.store.putComment({
      id: 'legacy_row',
      relicId: id,
      author: 'legacy@example.com',
      createdAt: 1000,
      ciphertext: 'bGVnYWN5',
    });
    now += 2000;
    // Post a modern comment through the API
    const posted = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: 'bW9kZXJu',
          publish_token: token,
        }),
      })
    );
    expect(posted.status).toBe(201);

    const list = (await (
      await app.fetch(req(`/api/relics/${id}/comments`))
    ).json()) as Array<{
      comment_id: string;
      version: number | null;
    }>;
    expect(list).toHaveLength(2);
    expect(list[0]?.comment_id).toBe('legacy_row');
    expect(list[0]?.version).toBeNull();

    expect(list[1]?.version).toBe(1);

    // In store, legacy row has undefined, not null
    const storedLegacy = await app.store.getComment(id, 'legacy_row');
    expect(storedLegacy?.version).toBeUndefined();
  });

  test('stored comment version survives the relic being republished', async () => {
    const { id, key, grant } = await publish();
    const token = grant['publish_token'] as string;

    // Advance to version 2
    await republish(id, token);
    storage.put(`${id}/v2`, await encrypted('relic v2 content', key));

    // Comment written on version 2
    const posted = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: 'Y29tbWVudCBvbiB2Mg',
          publish_token: token,
          version: 2,
        }),
      })
    );
    expect(posted.status).toBe(201);

    // Verify it reports version 2 before republish
    const before = (await (
      await app.fetch(req(`/api/relics/${id}/comments`))
    ).json()) as Array<{
      version: number | null;
    }>;
    expect(before[0]?.version).toBe(2);

    // Advance to version 3
    await republish(id, token);
    storage.put(`${id}/v3`, await encrypted('relic v3 content', key));

    expect((await app.store.getRelic(id))?.version).toBe(3);

    // The comment written on version 2 still reports 2 after reaching version 3
    const after = (await (
      await app.fetch(req(`/api/relics/${id}/comments`))
    ).json()) as Array<{
      version: number | null;
    }>;
    expect(after).toHaveLength(1);
    expect(after[0]?.version).toBe(2);

    // Add a comment on version 3 without explicit version (defaults to 3)
    now += 1000;
    const postV3 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: 'Y29tbWVudCBvbiB2Mw',
          publish_token: token,
        }),
      })
    );
    expect(postV3.status).toBe(201);

    const final = (await (
      await app.fetch(req(`/api/relics/${id}/comments`))
    ).json()) as Array<{
      version: number | null;
    }>;
    expect(final).toHaveLength(2);
    expect(final[0]?.version).toBe(2);
    expect(final[1]?.version).toBe(3);
  });
});

describe('magic-link identity', () => {
  test('a followed link lets a reader comment, and the stored author is the address', async () => {
    const sent: Array<{ email: string; link: string }> = [];
    const mailer: Mailer = {
      async send(email, link) {
        sent.push({ email, link });
      },
    };
    app = build({ mailer });

    const { id } = await publish();
    const asked = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({
          email: 'reader@example.com',
          return_to: `/${id}`,
        }),
      })
    );
    expect(asked.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.email).toBe('reader@example.com');

    const link = sent[0]?.link ?? '';
    const followed = await app.fetch(
      req(new URL(link).pathname + new URL(link).search, {
        redirect: 'manual',
      })
    );
    expect(followed.status).toBe(303);
    expect(followed.headers.get('location')).toBe(`/${id}`);
    const cookie = followed.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toMatch(/relic_session=/);

    const session = cookie.split(';')[0] ?? '';
    const posted = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: session },
        body: JSON.stringify({ ciphertext: 'YWJjZA' }),
      })
    );
    expect(posted.status).toBe(201);
    expect(((await posted.json()) as { author: string }).author).toBe(
      'reader@example.com'
    );
  });

  test('one sign-in carries to every other relic, without a second link', async () => {
    // The reported symptom was signing in again for each relic. The session
    // row has no relic id and the cookie is Path=/, so this asserts the
    // property end to end rather than reading the shapes and assuming it.
    const sent: Array<{ email: string; link: string }> = [];
    app = build({
      mailer: {
        async send(email, link) {
          sent.push({ email, link });
        },
      },
    });

    const first = await publish();
    const second = await publish();
    expect(second.id).not.toBe(first.id);

    // Signed in from the first relic, and only ever from there.
    await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({
          email: 'reader@example.com',
          return_to: `/${first.id}`,
        }),
      })
    );
    const link = sent[0]?.link;
    if (link === undefined) throw new Error('no link was sent');
    const followed = await app.fetch(
      req(new URL(link).pathname + new URL(link).search, {
        redirect: 'manual',
      })
    );
    const session = (followed.headers.get('set-cookie') ?? '').split(';')[0];
    if (session === undefined) throw new Error('no session cookie');

    // The reader now opens a relic they have never signed in on. The session
    // endpoint has to already know them, or the composer asks again and this
    // is exactly the reported bug.
    const who = await app.fetch(
      req('/api/auth/session', { headers: { cookie: session } })
    );
    expect(who.status).toBe(200);
    expect(await who.json()).toEqual({ email: 'reader@example.com' });

    // And the write on the second relic is attributed to the same address,
    // with no second link anywhere in the flow.
    const posted = await app.fetch(
      req(`/api/relics/${second.id}/comments`, {
        method: 'POST',
        headers: { cookie: session },
        body: JSON.stringify({ ciphertext: 'c2Vjb25k' }),
      })
    );
    expect(posted.status).toBe(201);

    const rows = await app.store.listComments(second.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.author).toBe('reader@example.com');
    expect(sent).toHaveLength(1);
  });

  test('asking for a link always answers 202, even for garbage, so it is not an address oracle', async () => {
    const sent: Array<{ email: string; link: string }> = [];
    const mailer: Mailer = {
      async send(email, link) {
        sent.push({ email, link });
      },
    };
    app = build({ mailer });

    const garbage = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({ email: 'not-an-address' }),
      })
    );
    expect(garbage.status).toBe(202);
    expect(sent).toHaveLength(0);

    const missing = await app.fetch(
      req('/api/auth/request', { method: 'POST', body: '{}' })
    );
    expect(missing.status).toBe(202);
    expect(sent).toHaveLength(0);
  });

  test('a provider refusal is still 202, so error codes cannot become the oracle', async () => {
    // Mail can fail for reasons that have nothing to do with the address: an
    // unverified domain, a suspended key, a quota. If those turned into a 500
    // while an undeliverable address kept its 202, the oracle the status code
    // was flattened to prevent would be rebuilt out of failure modes.
    const attempts: string[] = [];
    app = build({
      mailer: {
        async send(email) {
          attempts.push(email);
          throw new Error('resend refused with 403 validation_error');
        },
      },
    });

    const asked = await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );

    expect(asked.status).toBe(202);
    expect(attempts).toEqual(['reader@example.com']);
  });

  test('a spent or missing token is invalid_session, not a new session', async () => {
    const sent: Array<{ email: string; link: string }> = [];
    app = build({
      mailer: {
        async send(email, link) {
          sent.push({ email, link });
        },
      },
    });

    await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({ email: 'reader@example.com' }),
      })
    );
    const link = sent[0]?.link ?? '';
    const url = new URL(link);
    const path = url.pathname + url.search;

    const first = await app.fetch(req(path, { redirect: 'manual' }));
    expect(first.status).toBe(303);

    const replay = await app.fetch(req(path, { redirect: 'manual' }));
    expect(replay.status).toBe(401);
    expect((await replay.json()).code).toBe('invalid_session');

    const missing = await app.fetch(
      req('/api/auth/callback', { redirect: 'manual' })
    );
    expect(missing.status).toBe(401);
    expect((await missing.json()).code).toBe('invalid_session');
  });

  test('GET /api/auth/session is 200 with null when nobody is signed in, never 401', async () => {
    const response = await app.fetch(req('/api/auth/session'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: null });
  });

  test('after a followed link, GET /api/auth/session returns the verified address', async () => {
    const sent: Array<{ email: string; link: string }> = [];
    app = build({
      mailer: {
        async send(email, link) {
          sent.push({ email, link });
        },
      },
    });
    const { id } = await publish();

    await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({
          email: 'reader@example.com',
          relic_id: id,
        }),
      })
    );
    const link = sent[0]?.link ?? '';
    const followed = await app.fetch(
      req(new URL(link).pathname + new URL(link).search, {
        redirect: 'manual',
      })
    );
    expect(followed.headers.get('location')).toBe(`/${id}`);
    const session = (followed.headers.get('set-cookie') ?? '').split(';')[0];

    const probe = await app.fetch(
      req('/api/auth/session', { headers: { cookie: session ?? '' } })
    );
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ email: 'reader@example.com' });
  });

  test('an absolute return_to is dropped so a sign-in cannot leave the service', async () => {
    const sent: Array<{ email: string; link: string }> = [];
    app = build({
      mailer: {
        async send(email, link) {
          sent.push({ email, link });
        },
      },
    });

    await app.fetch(
      req('/api/auth/request', {
        method: 'POST',
        body: JSON.stringify({
          email: 'reader@example.com',
          return_to: 'https://evil.example/steal',
        }),
      })
    );
    const link = sent[0]?.link ?? '';
    const followed = await app.fetch(
      req(new URL(link).pathname + new URL(link).search, {
        redirect: 'manual',
      })
    );
    expect(followed.headers.get('location')).toBe('/');
  });
});

describe('session relic listing', () => {
  async function createSession(
    email = 'reader@example.com',
    expiresAt = now + 3600 * 1000
  ): Promise<string> {
    const token = `token-${Math.random()}`;
    const tokenHash = await sha256Hex(token);
    await app.store.putSession({
      tokenHash,
      email,
      createdAt: now,
      expiresAt,
    });
    return `relic_session=${token}`;
  }

  async function postCommentAs(
    relicId: string,
    cookie: string,
    ciphertext = 'YWJjZA'
  ): Promise<Response> {
    return app.fetch(
      req(`/api/relics/${relicId}/comments`, {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ ciphertext }),
      })
    );
  }

  test('GET /api/auth/relics returns 401 invalid_session with no session', async () => {
    const response = await app.fetch(req('/api/auth/relics'));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('invalid_session');
  });

  test('GET /api/auth/relics returns 401 invalid_session with an expired session', async () => {
    const cookie = await createSession('reader@example.com', now - 1000);
    const response = await app.fetch(
      req('/api/auth/relics', { headers: { cookie } })
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('invalid_session');
  });

  test('a signed-in address sees exactly the relics it commented on, ordered by most recent engagement first', async () => {
    const cookie = await createSession('reader@example.com');
    const relic1 = await publish({ title: 'First Relic' });
    const relic2 = await publish({ title: 'Second Relic' });

    // Comment on relic1 at now = 1000
    now = 1000;
    await postCommentAs(relic1.id, cookie);

    // Comment on relic2 at now = 2000
    now = 2000;
    await postCommentAs(relic2.id, cookie);

    // Comment again on relic1 at now = 3000 (engagement becomes 3000)
    now = 3000;
    await postCommentAs(relic1.id, cookie);

    const response = await app.fetch(
      req('/api/auth/relics', { headers: { cookie } })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      relics: Array<{
        relic_id: string;
        title: string | null;
        renderer_class: string;
        version: number;
        published_at: string | null;
        expires_at: string | null;
        last_comment_at: string;
      }>;
    };

    expect(body.relics).toHaveLength(2);
    // relic1 had most recent engagement at 3000, so it appears first
    expect(body.relics[0]?.relic_id).toBe(relic1.id);
    expect(body.relics[0]?.title).toBe('First Relic');
    expect(body.relics[0]?.last_comment_at).toBe(new Date(3000).toISOString());

    expect(body.relics[1]?.relic_id).toBe(relic2.id);
    expect(body.relics[1]?.title).toBe('Second Relic');
    expect(body.relics[1]?.last_comment_at).toBe(new Date(2000).toISOString());
  });

  test("a second address's relics are absent", async () => {
    const reader1Cookie = await createSession('reader1@example.com');
    const reader2Cookie = await createSession('reader2@example.com');

    const relic1 = await publish({ title: 'Reader 1 Relic' });
    const relic2 = await publish({ title: 'Reader 2 Relic' });

    now = 1000;
    await postCommentAs(relic1.id, reader1Cookie);

    now = 2000;
    await postCommentAs(relic2.id, reader2Cookie);

    // Reader 1 only sees relic1
    const res1 = await app.fetch(
      req('/api/auth/relics', { headers: { cookie: reader1Cookie } })
    );
    const body1 = (await res1.json()) as {
      relics: Array<{ relic_id: string }>;
    };
    expect(body1.relics.map((r) => r.relic_id)).toEqual([relic1.id]);

    // Reader 2 only sees relic2
    const res2 = await app.fetch(
      req('/api/auth/relics', { headers: { cookie: reader2Cookie } })
    );
    const body2 = (await res2.json()) as {
      relics: Array<{ relic_id: string }>;
    };
    expect(body2.relics.map((r) => r.relic_id)).toEqual([relic2.id]);
  });

  test('tombstoned relics never appear', async () => {
    const cookie = await createSession('reader@example.com');
    const relic = await publish({ title: 'To Be Tombstoned' });

    now = 1000;
    await postCommentAs(relic.id, cookie);

    // Verify it appears initially
    const before = await app.fetch(
      req('/api/auth/relics', { headers: { cookie } })
    );
    const beforeJson = (await before.json()) as { relics: unknown[] };
    expect(beforeJson.relics).toHaveLength(1);

    // Tombstone the relic
    await app.store.putTombstone({
      id: relic.id,
      publishIp: '198.51.100.10',
      publishedAt: 1000,
      publishingClient: 'relic-mcp/0.1.0',
      rendererClass: 'markdown',
      ciphertextHash: 'abc',
      deletedAt: 2000,
      operator: 'jason',
      reasonClass: 'legal',
      reportReference: undefined,
    });

    const after = await app.fetch(
      req('/api/auth/relics', { headers: { cookie } })
    );
    expect(((await after.json()) as { relics: unknown[] }).relics).toEqual([]);
  });

  test('expired relics never appear', async () => {
    const cookie = await createSession('reader@example.com');
    // Relic with ttl_days: 1
    now = 1000;
    const relic = await publish({ title: 'Expiring Relic', ttlDays: 1 });

    await postCommentAs(relic.id, cookie);

    // Before expiry, it appears
    const before = await app.fetch(
      req('/api/auth/relics', { headers: { cookie } })
    );
    const beforeJson = (await before.json()) as { relics: unknown[] };
    expect(beforeJson.relics).toHaveLength(1);

    // Advance time past expiry (1 day + 1000ms)
    now += 86_400 * 1000 + 1000;

    const after = await app.fetch(
      req('/api/auth/relics', { headers: { cookie } })
    );
    expect(((await after.json()) as { relics: unknown[] }).relics).toEqual([]);
  });

  test('absent-row relics never appear', async () => {
    const cookie = await createSession('reader@example.com');
    // Directly record a comment on a relic ID that was never created in the store
    await app.store.putComment({
      id: 'c_ghost',
      relicId: 'ghost_relic',
      author: 'reader@example.com',
      createdAt: now,
      ciphertext: 'YWJjZA',
    });

    const response = await app.fetch(
      req('/api/auth/relics', { headers: { cookie } })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { relics: unknown[] };
    expect(body.relics).toEqual([]);
  });

  test('the response body contains no key, fragment, ciphertext, or comment body under any field name', async () => {
    const cookie = await createSession('reader@example.com');
    const relic = await publish({ title: 'Secret Doc' });

    now = 1000;
    const secretCiphertext = 'secret_comment_ciphertext_payload';
    await postCommentAs(relic.id, cookie, secretCiphertext);

    const response = await app.fetch(
      req('/api/auth/relics', { headers: { cookie } })
    );
    const rawJson = await response.text();
    const parsed = JSON.parse(rawJson) as { relics: Record<string, unknown>[] };

    expect(rawJson).not.toContain(secretCiphertext);
    expect(rawJson).not.toContain('fragment');
    expect(rawJson).not.toContain('ciphertext');
    expect(rawJson).not.toContain('"key"');

    const expectedKeys: Record<string, true> = {
      relic_id: true,
      title: true,
      renderer_class: true,
      version: true,
      published_at: true,
      expires_at: true,
      last_comment_at: true,
    };
    for (const item of parsed.relics) {
      for (const k of Object.keys(item)) {
        expect(expectedKeys[k]).toBe(true);
      }
    }
  });

  test('non-GET methods on /api/auth/relics return 405 Method Not Allowed', async () => {
    const cookie = await createSession('reader@example.com');
    const response = await app.fetch(
      req('/api/auth/relics', { method: 'POST', headers: { cookie } })
    );
    expect(response.status).toBe(405);
  });
});

describe('GET /dashboard', () => {
  test('returns 200 HTML with data-view="dashboard", no relic id value, no relic title, and noindex plus no-store headers', async () => {
    const response = await app.fetch(req('/dashboard'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("connect-src 'self'");

    const body = await response.text();
    expect(body).toContain('data-view="dashboard"');
    expect(body).not.toContain('data-relic-id');
    expect(body).toContain('<title>Relic</title>');
    expect(body).toContain('content="A relic"');
    expect(body).toContain('/dashboard');
  });

  test('is served to a signed-out reader', async () => {
    const response = await app.fetch(req('/dashboard'));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('data-view="dashboard"');
  });

  test('dashboard is not parsed as a relic id', async () => {
    const response = await app.fetch(req('/dashboard'));
    const body = await response.text();
    expect(body).not.toContain('data-relic-id="dashboard"');
    expect(body).not.toContain('dashb0ard');
  });

  test('non-GET methods on /dashboard return 405 Method Not Allowed', async () => {
    const response = await app.fetch(req('/dashboard', { method: 'POST' }));
    expect(response.status).toBe(405);
  });
});

describe('comment notifications', () => {
  let sentMails: Array<{ email: string; mail: OutboundMail }>;
  let notifMailer: Mailer;

  async function createSession(
    email = 'reader@example.com',
    expiresAt = now + 3600 * 1000
  ): Promise<string> {
    const token = `token-${Math.random()}`;
    const tokenHash = await sha256Hex(token);
    await app.store.putSession({
      tokenHash,
      email,
      createdAt: now,
      expiresAt,
    });
    return `relic_session=${token}`;
  }

  beforeEach(() => {
    sentMails = [];
    notifMailer = {
      async send(email, link) {
        sentMails.push({
          email,
          mail: { subject: 'link', text: link, html: link },
        });
      },
      async sendMail(email, mail) {
        sentMails.push({ email, mail });
      },
    };
    app = build({ mailer: notifMailer });
  });

  test('a comment on a relic with a verified owner address mails the owner', async () => {
    await createSession('owner@example.com');
    const { id } = await publish({
      title: 'Roadmap',
      ownerEmail: 'owner@example.com',
    });
    const commenterSession = await createSession('commenter@example.com');

    const response = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: commenterSession },
        body: JSON.stringify({ ciphertext: 'YWJjZA' }),
      })
    );
    expect(response.status).toBe(201);
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.email).toBe('owner@example.com');
    expect(sentMails[0]?.mail.subject).toBe('New comment on "Roadmap"');
    expect(sentMails[0]?.mail.text).toContain(
      'commenter@example.com left a comment on "Roadmap".'
    );
    expect(sentMails[0]?.mail.text).toContain(
      'Open the link you hold for this relic to read and answer the comment.'
    );
  });

  test('with no owner address, nothing is sent and the POST still succeeds', async () => {
    const { id } = await publish();
    const commenterSession = await createSession('commenter@example.com');

    const response = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: commenterSession },
        body: JSON.stringify({ ciphertext: 'YWJjZA' }),
      })
    );
    expect(response.status).toBe(201);
    expect(sentMails).toHaveLength(0);
  });

  test('a comment carrying a clear addresses mails the addressed comment author', async () => {
    const { id } = await publish({ title: 'Spec doc' });
    const alice = await createSession('alice@example.com');
    const bob = await createSession('bob@example.com');

    const c1Response = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: alice },
        body: JSON.stringify({ ciphertext: 'YWxpY2Ux' }),
      })
    );
    expect(c1Response.status).toBe(201);
    const { comment_id: c1Id } = (await c1Response.json()) as {
      comment_id: string;
    };
    sentMails = [];

    const c2Response = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: bob },
        body: JSON.stringify({
          ciphertext: 'Ym9iMQ',
          addresses: c1Id,
        }),
      })
    );
    expect(c2Response.status).toBe(201);
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.email).toBe('alice@example.com');
    expect(sentMails[0]?.mail.subject).toBe(
      'Your comment on "Spec doc" was answered'
    );
    expect(sentMails[0]?.mail.text).toContain(
      'bob@example.com answered your comment on "Spec doc".'
    );
    expect(sentMails[0]?.mail.text).toContain(
      'Open the link you hold for this relic to read the reply.'
    );
  });

  test('the triggering author is never mailed about their own comment', async () => {
    await createSession('owner@example.com');
    const { id, grant } = await publish({
      title: 'Solo',
      ownerEmail: 'owner@example.com',
    });
    const ownerCookie = await createSession('owner@example.com');

    // Case 1: Owner comments on their own relic
    const c1 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: ownerCookie },
        body: JSON.stringify({ ciphertext: 'b3duZXI' }),
      })
    );
    expect(c1.status).toBe(201);
    expect(sentMails).toHaveLength(0);

    // Case 2: Publisher comments with publish token on relic with ownerEmail
    const c2 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          ciphertext: 'cHVibGlzaGVy',
          publish_token: grant['publish_token'],
        }),
      })
    );
    expect(c2.status).toBe(201);
    expect(sentMails).toHaveLength(0);

    // Case 3: Author addresses their own earlier comment
    const alice = await createSession('alice@example.com');
    const c3 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: alice },
        body: JSON.stringify({ ciphertext: 'YWxpY2Ux' }),
      })
    );
    const { comment_id: aliceC1Id } = (await c3.json()) as {
      comment_id: string;
    };
    sentMails = [];

    const c4 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: alice },
        body: JSON.stringify({
          ciphertext: 'YWxpY2Uy',
          addresses: aliceC1Id,
        }),
      })
    );
    expect(c4.status).toBe(201);
    expect(sentMails.some((m) => m.email === 'alice@example.com')).toBe(false);
  });

  test('the window collapses repeats and the cap holds', async () => {
    await createSession('owner@example.com');
    const { id } = await publish({
      title: 'Active Thread',
      ownerEmail: 'owner@example.com',
    });
    const commenter = await createSession('commenter@example.com');

    // First comment at t=0: sends notification #1
    const res1 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: commenter },
        body: JSON.stringify({ ciphertext: 'Y29tbWVudDE' }),
      })
    );
    expect(res1.status).toBe(201);
    expect(sentMails).toHaveLength(1);

    // Second comment 5 seconds later (well within 10-minute window): collapsed
    now += 5000;
    const res2 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: commenter },
        body: JSON.stringify({ ciphertext: 'Y29tbWVudDI' }),
      })
    );
    expect(res2.status).toBe(201);
    expect(sentMails).toHaveLength(1);

    // Third comment 10 seconds later: still collapsed
    now += 10_000;
    const res3 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: commenter },
        body: JSON.stringify({ ciphertext: 'Y29tbWVudDM' }),
      })
    );
    expect(res3.status).toBe(201);
    expect(sentMails).toHaveLength(1);

    // Advance time past the 10-minute window (600s + 1s = 601s)
    now += 601_000;
    const res4 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: commenter },
        body: JSON.stringify({ ciphertext: 'Y29tbWVudDQ' }),
      })
    );
    expect(res4.status).toBe(201);
    expect(sentMails).toHaveLength(2);
  });

  test('an unverified owner address is refused at publish with a message naming sign-in', async () => {
    const challengeRes = await app.fetch(
      req('/api/challenge', { method: 'POST' })
    );
    const { challenge_nonce } = (await challengeRes.json()) as {
      challenge_nonce: string;
    };
    const id = generateRelicId();

    const refused = await app.fetch(
      req('/api/grant', {
        method: 'POST',
        body: JSON.stringify({
          challenge_nonce,
          relic_id: id,
          renderer_class: 'markdown',
          publishing_client: 'relic-mcp/0.1.0 (test)',
          declared_size_bytes: 12,
          declared_ciphertext_bytes: encryptedSize(12),
          owner_email: 'unverified@example.com',
        }),
      })
    );
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { code: string; detail?: string };
    expect(body.code).toBe('invalid_publish_metadata');
    expect(body.detail?.toLowerCase()).toContain('sign in');

    // Republish attempt with unverified address
    const { id: validId, grant } = await publish();
    const token = grant['publish_token'] as string;
    const republishRefused = await app.fetch(
      req(`/api/relics/${validId}/republish`, {
        method: 'POST',
        body: JSON.stringify({
          publish_token: token,
          renderer_class: 'markdown',
          declared_size_bytes: 12,
          declared_ciphertext_bytes: encryptedSize(12),
          owner_email: 'unverified@example.com',
        }),
      })
    );
    expect(republishRefused.status).toBe(400);
    const republishBody = (await republishRefused.json()) as {
      code: string;
      detail?: string;
    };
    expect(republishBody.code).toBe('invalid_publish_metadata');
    expect(republishBody.detail?.toLowerCase()).toContain('sign in');
  });

  test('a provider refusal leaves the POST at its normal status', async () => {
    const failingMailer: Mailer = {
      async send() {
        throw new MailRefusedError(
          403,
          'validation_error',
          'domain unverified'
        );
      },
      async sendMail() {
        throw new MailRefusedError(
          403,
          'validation_error',
          'domain unverified'
        );
      },
    };
    app = build({ mailer: failingMailer });

    await createSession('owner@example.com');
    const { id } = await publish({
      title: 'Robust',
      ownerEmail: 'owner@example.com',
    });
    const commenter = await createSession('commenter@example.com');

    const response = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: commenter },
        body: JSON.stringify({ ciphertext: 'YWJjZA' }),
      })
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      comment_id: string;
      author: string;
    };
    expect(body.author).toBe('commenter@example.com');
    expect(await app.store.listComments(id)).toHaveLength(1);
  });

  test('the rendered body carries no body text, no fragment, and no key', async () => {
    const rawKey = generateKey();
    const commentKey = await deriveCommentKey(rawKey);
    const commentBodyText = 'very-confidential-remark-inside-aead';
    const sealed = await encryptComment(commentKey, {
      body: commentBodyText,
      display_name: 'Reporter',
      anchor: null,
      addresses: null,
    });
    await createSession('owner@example.com');
    const { id } = await publish({
      title: 'Confidential Plan',
      ownerEmail: 'owner@example.com',
    });
    const alice = await createSession('alice@example.com');
    const bob = await createSession('bob@example.com');

    // Alice comments, triggering owner notification
    const res1 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: alice },
        body: JSON.stringify({ ciphertext: sealed }),
      })
    );
    expect(res1.status).toBe(201);
    const { comment_id: c1Id } = (await res1.json()) as {
      comment_id: string;
    };

    // Bob replies, triggering reply notification to Alice
    const res2 = await app.fetch(
      req(`/api/relics/${id}/comments`, {
        method: 'POST',
        headers: { cookie: bob },
        body: JSON.stringify({
          ciphertext: sealed,
          addresses: c1Id,
        }),
      })
    );
    expect(res2.status).toBe(201);

    expect(sentMails.length).toBeGreaterThanOrEqual(2);
    for (const { mail } of sentMails) {
      expect(mail.text).not.toContain(commentBodyText);
      expect(mail.html).not.toContain(commentBodyText);
      expect(mail.text).not.toContain('#');
      expect(mail.html).not.toContain('#');
      expect(mail.text).not.toContain(rawKey.toString());
      expect(mail.html).not.toContain(rawKey.toString());
      expect(mail.text).not.toContain('fragment');
      expect(mail.html).not.toContain('fragment');
    }
  });
});

describe('comment edits and resolutions', () => {
  async function createSession(
    email = 'reader@example.com',
    expiresAt = now + 3600 * 1000
  ): Promise<string> {
    const token = `token-${Math.random()}`;
    const tokenHash = await sha256Hex(token);
    await app.store.putSession({
      tokenHash,
      email,
      createdAt: now,
      expiresAt,
    });
    return `relic_session=${token}`;
  }

  function patch(
    relicId: string,
    commentId: string,
    init: {
      cookie?: string;
      publishToken?: string;
      ciphertext?: string;
      resolved?: boolean;
    } = {}
  ): Promise<Response> {
    return app.fetch(
      req(`/api/relics/${relicId}/comments/${commentId}`, {
        method: 'PATCH',
        headers: {
          ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
        },
        body: JSON.stringify({
          ...(init.publishToken === undefined
            ? {}
            : { publish_token: init.publishToken }),
          ...(init.ciphertext === undefined
            ? {}
            : { ciphertext: init.ciphertext }),
          ...(init.resolved === undefined ? {} : { resolved: init.resolved }),
        }),
      })
    );
  }

  async function postAs(
    relicId: string,
    init: { cookie?: string; publishToken?: string; ciphertext?: string } = {}
  ): Promise<{ commentId: string; author: string }> {
    const posted = await app.fetch(
      req(`/api/relics/${relicId}/comments`, {
        method: 'POST',
        headers: {
          ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
        },
        body: JSON.stringify({
          ...(init.publishToken === undefined
            ? {}
            : { publish_token: init.publishToken }),
          ciphertext: init.ciphertext ?? 'YWJjZA',
        }),
      })
    );
    expect(posted.status).toBe(201);
    const body = (await posted.json()) as {
      comment_id: string;
      author: string;
    };
    return { commentId: body.comment_id, author: body.author };
  }

  async function listThread(relicId: string): Promise<
    Array<{
      comment_id: string;
      ciphertext: string;
      edited_at: string | null;
      resolved_at: string | null;
      resolved_by: string | null;
    }>
  > {
    const listed = await app.fetch(req(`/api/relics/${relicId}/comments`));
    expect(listed.status).toBe(200);
    return (await listed.json()) as Array<{
      comment_id: string;
      ciphertext: string;
      edited_at: string | null;
      resolved_at: string | null;
      resolved_by: string | null;
    }>;
  }

  type PatchBody = {
    comment_id: string;
    author: string;
    created_at: string;
    edited_at: string | null;
    resolved_at: string | null;
    resolved_by: string | null;
  };

  test('a fresh thread lists all three fields as null', async () => {
    const { id } = await publish();
    const alice = await createSession('alice@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    const listed = await listThread(id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.comment_id).toBe(commentId);
    expect(listed[0]?.edited_at).toBeNull();
    expect(listed[0]?.resolved_at).toBeNull();
    expect(listed[0]?.resolved_by).toBeNull();
  });

  test('an author edits their own comment and the row carries the edit stamp', async () => {
    const { id } = await publish();
    const alice = await createSession('alice@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    now += 5000;
    const edited = await patch(id, commentId, {
      cookie: alice,
      ciphertext: 'ZWRpdGVk',
    });
    expect(edited.status).toBe(200);
    const body = (await edited.json()) as PatchBody;
    expect(body.comment_id).toBe(commentId);
    expect(body.author).toBe('alice@example.com');
    expect(body.created_at).toBe(new Date(now - 5000).toISOString());
    expect(body.edited_at).toBe(new Date(now).toISOString());
    expect(body.resolved_at).toBeNull();
    expect(body.resolved_by).toBeNull();

    const listed = await listThread(id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.ciphertext).toBe('ZWRpdGVk');
    expect(listed[0]?.edited_at).toBe(new Date(now).toISOString());
  });

  test("a stranger cannot edit somebody else's comment", async () => {
    const { id } = await publish();
    const alice = await createSession('alice@example.com');
    const bob = await createSession('bob@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    const edited = await patch(id, commentId, {
      cookie: bob,
      ciphertext: 'Ym9i',
    });
    expect(edited.status).toBe(403);
    expect((await edited.json()).code).toBe('comment_forbidden');
  });

  test('an unauthenticated caller is refused for both fields', async () => {
    const { id } = await publish();
    const alice = await createSession('alice@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    const edited = await patch(id, commentId, { ciphertext: 'eHl6' });
    expect(edited.status).toBe(403);
    expect((await edited.json()).code).toBe('comment_forbidden');

    const resolved = await patch(id, commentId, { resolved: true });
    expect(resolved.status).toBe(403);
    expect((await resolved.json()).code).toBe('comment_forbidden');
  });

  test('a session address cannot edit a publisher-authored comment', async () => {
    const { id, grant } = await publish();
    const { commentId } = await postAs(id, {
      publishToken: grant['publish_token'] as string,
    });
    const alice = await createSession('alice@example.com');

    const edited = await patch(id, commentId, {
      cookie: alice,
      ciphertext: 'YWxpY2U',
    });
    expect(edited.status).toBe(403);
    expect((await edited.json()).code).toBe('comment_forbidden');
  });

  test('the publish token edits a publisher-authored comment', async () => {
    const { id, grant } = await publish();
    const token = grant['publish_token'] as string;
    const { commentId } = await postAs(id, { publishToken: token });

    now += 5000;
    const edited = await patch(id, commentId, {
      publishToken: token,
      ciphertext: 'cmVwbHk',
    });
    expect(edited.status).toBe(200);
    const body = (await edited.json()) as PatchBody;
    expect(body.author).toBe('publisher');
    expect(body.edited_at).toBe(new Date(now).toISOString());
  });

  test('the publish token resolves a comment its holder did not make', async () => {
    const { id, grant } = await publish();
    const alice = await createSession('alice@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    const resolved = await patch(id, commentId, {
      publishToken: grant['publish_token'] as string,
      resolved: true,
    });
    expect(resolved.status).toBe(200);
    const body = (await resolved.json()) as PatchBody;
    expect(body.resolved_at).toBe(new Date(now).toISOString());
    expect(body.resolved_by).toBe('publisher');
  });

  test("a stranger cannot resolve somebody else's comment", async () => {
    const { id } = await publish();
    const alice = await createSession('alice@example.com');
    const bob = await createSession('bob@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    const resolved = await patch(id, commentId, {
      cookie: bob,
      resolved: true,
    });
    expect(resolved.status).toBe(403);
    expect((await resolved.json()).code).toBe('comment_forbidden');
  });

  test('an author resolves their own comment, then unresolving clears both fields', async () => {
    const { id } = await publish();
    const alice = await createSession('alice@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    const resolved = await patch(id, commentId, {
      cookie: alice,
      resolved: true,
    });
    expect(resolved.status).toBe(200);
    const set = (await resolved.json()) as PatchBody;
    expect(set.resolved_at).toBe(new Date(now).toISOString());
    expect(set.resolved_by).toBe('alice@example.com');

    now += 1000;
    const cleared = await patch(id, commentId, {
      cookie: alice,
      resolved: false,
    });
    expect(cleared.status).toBe(200);
    const body = (await cleared.json()) as PatchBody;
    expect(body.resolved_at).toBeNull();
    expect(body.resolved_by).toBeNull();

    const listed = await listThread(id);
    expect(listed[0]?.resolved_at).toBeNull();
    expect(listed[0]?.resolved_by).toBeNull();
  });

  test('clearing a resolution leaves the edit stamp standing', async () => {
    const { id, grant } = await publish();
    const token = grant['publish_token'] as string;
    const alice = await createSession('alice@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    now += 5000;
    await patch(id, commentId, { cookie: alice, ciphertext: 'ZWRpdA' });
    now += 5000;
    await patch(id, commentId, { publishToken: token, resolved: true });
    now += 5000;
    const cleared = await patch(id, commentId, {
      publishToken: token,
      resolved: false,
    });

    const body = (await cleared.json()) as PatchBody;
    expect(body.resolved_at).toBeNull();
    expect(body.edited_at).toBe(new Date(now - 10000).toISOString());

    // And the store row agrees, which is what a later republish check reads.
    const row = await app.store.getComment(id, commentId);
    expect(row?.editedAt).toBe(now - 10000);
    expect(row?.resolvedAt).toBeUndefined();
    expect(row?.resolvedBy).toBeUndefined();
  });

  test('an over-cap ciphertext is refused', async () => {
    const { id } = await publish();
    const alice = await createSession('alice@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    const edited = await patch(id, commentId, {
      cookie: alice,
      ciphertext: 'A'.repeat(8193),
    });
    expect(edited.status).toBe(400);
    expect((await edited.json()).code).toBe('invalid_comment');
  });

  test('a non-base64url ciphertext is refused', async () => {
    const { id } = await publish();
    const alice = await createSession('alice@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    const edited = await patch(id, commentId, {
      cookie: alice,
      ciphertext: 'not valid/base64!',
    });
    expect(edited.status).toBe(400);
    expect((await edited.json()).code).toBe('invalid_comment');
  });

  test('a body with neither field is nothing_to_change', async () => {
    const { id } = await publish();
    const alice = await createSession('alice@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    const response = await patch(id, commentId, { cookie: alice });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('nothing_to_change');
  });

  test('a missing comment is 404, before any authorization question', async () => {
    const { id } = await publish();
    const alice = await createSession('alice@example.com');

    const response = await patch(id, 'no-such-comment', {
      cookie: alice,
      ciphertext: 'YWJjZA',
    });
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('comment_not_found');
  });

  test('a comment on a tombstoned relic is refused', async () => {
    const { id } = await publish();
    const alice = await createSession('alice@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    const removed = await app.fetch(
      req(`/api/relics/${id}?reason=abuse`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );
    expect(removed.status).toBe(200);

    const edited = await patch(id, commentId, {
      cookie: alice,
      ciphertext: 'YWJjZA',
    });
    expect(edited.status).toBe(410);
    expect((await edited.json()).code).toBe('relic_removed');
  });

  test('the paused service refuses a patch', async () => {
    const { id } = await publish();
    const alice = await createSession('alice@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    app = build({ config: { killSwitchEngaged: true } });
    const edited = await patch(id, commentId, {
      cookie: alice,
      ciphertext: 'YWJjZA',
    });
    expect(edited.status).toBe(503);
    expect((await edited.json()).code).toBe('service_paused');
  });

  test('an edit and a resolution land in one patch', async () => {
    const { id } = await publish();
    const alice = await createSession('alice@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    now += 5000;
    const response = await patch(id, commentId, {
      cookie: alice,
      ciphertext: 'Ym90aA',
      resolved: true,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as PatchBody;
    expect(body.edited_at).toBe(new Date(now).toISOString());
    expect(body.resolved_at).toBe(new Date(now).toISOString());
    expect(body.resolved_by).toBe('alice@example.com');
  });

  test('the store distinguishes leaving a resolution alone from clearing it', async () => {
    const { id } = await publish();
    const alice = await createSession('alice@example.com');
    const { commentId } = await postAs(id, { cookie: alice });

    // Clearing on a comment that was never resolved stays clean, not nulls.
    await app.store.updateComment(id, commentId, { resolved: null });
    let row = await app.store.getComment(id, commentId);
    expect(row?.resolvedAt).toBeUndefined();
    expect(row?.resolvedBy).toBeUndefined();
    expect(row?.ciphertext).toBe('YWJjZA');

    now += 5000;
    const set = await app.store.updateComment(id, commentId, {
      ciphertext: 'ZWRpdGVk',
      editedAt: now,
      resolved: { at: now, by: 'alice@example.com' },
    });
    expect(set?.editedAt).toBe(now);
    expect(set?.resolvedAt).toBe(now);
    expect(set?.resolvedBy).toBe('alice@example.com');

    // Clearing removes the resolution keys and leaves the edit stamp.
    const cleared = await app.store.updateComment(id, commentId, {
      resolved: null,
    });
    expect(cleared?.editedAt).toBe(now);
    expect(cleared?.ciphertext).toBe('ZWRpdGVk');
    expect(cleared?.resolvedAt).toBeUndefined();
    expect(cleared?.resolvedBy).toBeUndefined();

    // Omitting `resolved` leaves an existing resolution untouched.
    now += 5000;
    await app.store.updateComment(id, commentId, {
      resolved: { at: now, by: 'alice@example.com' },
    });
    row = await app.store.updateComment(id, commentId, {
      ciphertext: 'YWdhaW4',
      editedAt: now,
    });
    expect(row?.resolvedAt).toBe(now);
    expect(row?.resolvedBy).toBe('alice@example.com');
    expect(row?.editedAt).toBe(now);
  });
});

describe('cover image upload, serving, and lifecycle', () => {
  function makeChunk(type: string, data: Uint8Array): Uint8Array {
    const typeBytes = new TextEncoder().encode(type);
    const len = data.length;
    const chunk = new Uint8Array(4 + 4 + len + 4);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, len);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    const crcTarget = chunk.subarray(4, 8 + len);
    view.setUint32(8 + len, crc32(crcTarget));
    return chunk;
  }

  function concatBytes(...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((acc, a) => acc + a.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const a of arrays) {
      out.set(a, pos);
      pos += a.length;
    }
    return out;
  }

  function makeValidPng(colorType: 2 | 6 = 2): Uint8Array {
    const bpp = colorType === 2 ? 3 : 4;
    const rawPixels = new Uint8Array(COVER_HEIGHT * (1 + COVER_WIDTH * bpp));
    const idat = makeChunk('IDAT', deflateSync(rawPixels));
    const iend = makeChunk('IEND', new Uint8Array(0));
    const ihdrData = new Uint8Array(13);
    const view = new DataView(ihdrData.buffer);
    view.setUint32(0, COVER_WIDTH);
    view.setUint32(4, COVER_HEIGHT);
    ihdrData[8] = 8;
    ihdrData[9] = colorType;
    ihdrData[10] = 0;
    ihdrData[11] = 0;
    ihdrData[12] = 0;
    return concatBytes(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      makeChunk('IHDR', ihdrData),
      idat,
      iend
    );
  }

  function makeValidJpeg(): Uint8Array {
    return new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x10,
      0x4a,
      0x46,
      0x49,
      0x46,
      0x00,
      0x01,
      0x01,
      0x00,
      0x00,
      0x01,
      0x00,
      0x01,
      0x00,
      0x00,
      0xff,
      0xdb,
      0x00,
      0x43,
      0x00,
      ...new Array(64).fill(1),
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      0x02,
      0x76,
      0x04,
      0xb0,
      0x03,
      0x01,
      0x11,
      0x00,
      0x02,
      0x11,
      0x00,
      0x03,
      0x11,
      0x00,
      0xff,
      0xc4,
      0x00,
      0x1f,
      0x00,
      0x00,
      0x01,
      0x05,
      0x01,
      0x01,
      0x01,
      0x01,
      0x01,
      0x01,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x01,
      0x02,
      0x03,
      0x04,
      0x05,
      0x06,
      0x07,
      0x08,
      0x09,
      0x0a,
      0x0b,
      0xff,
      0xda,
      0x00,
      0x0c,
      0x03,
      0x01,
      0x00,
      0x02,
      0x00,
      0x03,
      0x00,
      0x00,
      0x3f,
      0x00,
      0x12,
      0x34,
      0xff,
      0x00,
      0x56,
      0xff,
      0xd9,
    ]);
  }

  function toBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
  }

  describe('upload refusals in exact check order', () => {
    test('refusal 1: returns service_paused when kill switch is engaged', async () => {
      const pausedApp = build({ config: { killSwitchEngaged: true } });
      const res = await pausedApp.fetch(
        req('/api/relics/invalid_id/cover', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      );
      expect(res.status).toBe(503);
      const problem = (await res.json()) as { code: string };
      expect(problem.code).toBe('service_paused');
    });

    test('refusal 2: returns publish_rate_limited when cover rate limit is exceeded', async () => {
      const limitedApp = build({
        config: { publishRateLimit: { limit: 1, windowSeconds: 3600 } },
      });
      const ip = '198.51.100.99';
      // First request passes rate limiter
      await limitedApp.fetch(
        req('/api/relics/bad_id/cover', {
          method: 'POST',
          ip,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      );
      // Second request is rate limited before checking relic id
      const res = await limitedApp.fetch(
        req('/api/relics/bad_id/cover', {
          method: 'POST',
          ip,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      );
      expect(res.status).toBe(429);
      const problem = (await res.json()) as { code: string };
      expect(problem.code).toBe('publish_rate_limited');
    });

    test('refusal 3: returns invalid_relic_id for malformed id', async () => {
      const res = await app.fetch(
        req('/api/relics/not-a-valid-id!/cover', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      );
      expect(res.status).toBe(400);
      const problem = (await res.json()) as { code: string };
      expect(problem.code).toBe('invalid_relic_id');
    });

    test('refusal 4: returns relic_removed for tombstoned relic', async () => {
      const { id } = await publish();
      await app.fetch(
        req(`/api/relics/${id}`, {
          method: 'DELETE',
          headers: { authorization: 'Bearer operator-secret' },
        })
      );
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'malformed json body',
        })
      );
      expect(res.status).toBe(410);
      const problem = (await res.json()) as { code: string };
      expect(problem.code).toBe('relic_removed');
    });

    test('refusal 5: returns relic_not_found when relic row does not exist', async () => {
      const unissuedId = generateRelicId();
      const res = await app.fetch(
        req(`/api/relics/${unissuedId}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: 'malformed json body',
        })
      );
      expect(res.status).toBe(404);
      const problem = (await res.json()) as { code: string };
      expect(problem.code).toBe('relic_not_found');
    });

    test('refusal 6: returns invalid_cover size when body exceeds 720000 bytes', async () => {
      const { id } = await publish();
      const largeBody = 'a'.repeat(720_001);
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': String(largeBody.length),
          },
          body: largeBody,
        })
      );
      expect(res.status).toBe(400);
      const problem = (await res.json()) as {
        code: string;
        cover_validation_failure?: string;
      };
      expect(problem.code).toBe('invalid_cover');
      expect(problem.cover_validation_failure).toBe('size');
    });

    test('refusal 6b: returns invalid_cover structure when content-type is not application/json', async () => {
      const { id } = await publish();
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({}),
        })
      );
      expect(res.status).toBe(400);
      const problem = (await res.json()) as {
        code: string;
        cover_validation_failure?: string;
      };
      expect(problem.code).toBe('invalid_cover');
      expect(problem.cover_validation_failure).toBe('structure');
    });

    test('refusal 6c: returns invalid_cover structure when json is malformed', async () => {
      const { id } = await publish();
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{ invalid json',
        })
      );
      expect(res.status).toBe(400);
      const problem = (await res.json()) as {
        code: string;
        cover_validation_failure?: string;
      };
      expect(problem.code).toBe('invalid_cover');
      expect(problem.cover_validation_failure).toBe('structure');
    });

    test('refusal 6d: returns invalid_cover structure when json is not an object', async () => {
      const { id } = await publish();
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(['array', 'not', 'object']),
        })
      );
      expect(res.status).toBe(400);
      const problem = (await res.json()) as {
        code: string;
        cover_validation_failure?: string;
      };
      expect(problem.code).toBe('invalid_cover');
      expect(problem.cover_validation_failure).toBe('structure');
    });

    test('refusal 7: returns invalid_publish_token when publish token is missing or wrong', async () => {
      const { id } = await publish();
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: 'wrong-token',
            version: 99,
          }),
        })
      );
      expect(res.status).toBe(403);
      const problem = (await res.json()) as { code: string };
      expect(problem.code).toBe('invalid_publish_token');
    });

    test('refusal 8: returns cover_version_stale when version does not match row version', async () => {
      const { id, grant } = await publish();
      const token = grant.publish_token as string;
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: token,
            version: 2,
          }),
        })
      );
      expect(res.status).toBe(409);
      const problem = (await res.json()) as {
        code: string;
        relic_id: string;
        current_version: number;
      };
      expect(problem.code).toBe('cover_version_stale');
      expect(problem.relic_id).toBe(id);
      expect(problem.current_version).toBe(1);
    });

    test('refusal 9: returns relic_not_yet_published when ciphertext is absent from storage', async () => {
      const challengeResponse = await app.fetch(
        req('/api/challenge', { method: 'POST' })
      );
      const challenge = (await challengeResponse.json()) as {
        challenge_nonce: string;
      };
      const id = generateRelicId();
      const grantResponse = await app.fetch(
        req('/api/grant', {
          method: 'POST',
          body: JSON.stringify({
            challenge_nonce: challenge.challenge_nonce,
            relic_id: id,
            renderer_class: 'markdown',
            publishing_client: 'relic-mcp/0.1.0',
            declared_size_bytes: 10,
            declared_ciphertext_bytes: encryptedSize(10),
          }),
        })
      );
      const grant = (await grantResponse.json()) as { publish_token: string };
      // Note: we intentionally do NOT put the object into storage
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'unknown_kind',
          }),
        })
      );
      expect(res.status).toBe(409);
      const problem = (await res.json()) as { code: string };
      expect(problem.code).toBe('relic_not_yet_published');
    });

    test('refusal 10: returns invalid_cover structure when kind is unrecognized', async () => {
      const { id, grant } = await publish();
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'invalid-kind',
            type: 'image/png',
            data: 'AAAA',
          }),
        })
      );
      expect(res.status).toBe(400);
      const problem = (await res.json()) as {
        code: string;
        cover_validation_failure?: string;
      };
      expect(problem.code).toBe('invalid_cover');
      expect(problem.cover_validation_failure).toBe('structure');
    });

    test('refusal 10b: returns invalid_cover structure when type is unsupported', async () => {
      const { id, grant } = await publish();
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/gif',
            data: 'AAAA',
          }),
        })
      );
      expect(res.status).toBe(400);
      const problem = (await res.json()) as {
        code: string;
        cover_validation_failure?: string;
      };
      expect(problem.code).toBe('invalid_cover');
      expect(problem.cover_validation_failure).toBe('structure');
    });

    test('refusal 11: returns invalid_cover structure when data is invalid base64', async () => {
      const { id, grant } = await publish();
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: 'not!base64!!!',
          }),
        })
      );
      expect(res.status).toBe(400);
      const problem = (await res.json()) as {
        code: string;
        cover_validation_failure?: string;
      };
      expect(problem.code).toBe('invalid_cover');
      expect(problem.cover_validation_failure).toBe('structure');
    });

    test('refusal 12: returns invalid_cover size when decoded raster exceeds coverCapBytes', async () => {
      const { id, grant } = await publish();
      const oversizedBytes = new Uint8Array(COVER_CAP_BYTES + 1);
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: toBase64(oversizedBytes),
          }),
        })
      );
      expect(res.status).toBe(400);
      const problem = (await res.json()) as {
        code: string;
        cover_validation_failure?: string;
        size_limit_bytes?: number;
      };
      expect(problem.code).toBe('invalid_cover');
      expect(problem.cover_validation_failure).toBe('size');
      expect(problem.size_limit_bytes).toBe(COVER_CAP_BYTES);
    });

    test('refusal 13: returns invalid_cover with validation failure when raster fails validation', async () => {
      const { id, grant } = await publish();
      // 8 bytes of garbage with PNG signature broken
      const badRaster = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: toBase64(badRaster),
          }),
        })
      );
      expect(res.status).toBe(400);
      const problem = (await res.json()) as {
        code: string;
        cover_validation_failure?: string;
      };
      expect(problem.code).toBe('invalid_cover');
      expect(problem.cover_validation_failure).toBe('signature');
    });

    test('refusal 14: returns invalid_cover signature when declared type does not match detected signature', async () => {
      const { id, grant } = await publish();
      const pngBytes = makeValidPng(2);
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/jpeg', // Declaring JPEG for a PNG raster
            data: toBase64(pngBytes),
          }),
        })
      );
      expect(res.status).toBe(400);
      const problem = (await res.json()) as {
        code: string;
        cover_validation_failure?: string;
      };
      expect(problem.code).toBe('invalid_cover');
      expect(problem.cover_validation_failure).toBe('signature');
    });
  });

  describe('valid PNG and JPEG uploads', () => {
    test('accepts valid PNG cover and returns 200 with metadata and cover url', async () => {
      const { id, grant } = await publish();
      const pngBytes = makeValidPng(2);
      const sha256 = await sha256Hex(pngBytes);

      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: toBase64(pngBytes),
          }),
        })
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        relic_id: string;
        version: number;
        kind: string;
        type: string;
        sha256: string;
        bytes: number;
        cover_url: string;
      };
      expect(body.relic_id).toBe(id);
      expect(body.version).toBe(1);
      expect(body.kind).toBe('markdown');
      expect(body.type).toBe('image/png');
      expect(body.sha256).toBe(sha256);
      expect(body.bytes).toBe(pngBytes.byteLength);
      expect(body.cover_url).toBe(
        `https://relic.example/${id}/cover/${sha256}.png`
      );
    });

    test('accepts valid JPEG cover and returns 200 with metadata and cover url', async () => {
      const { id, grant } = await publish({ rendererClass: 'code' });
      const jpegBytes = makeValidJpeg();
      const sha256 = await sha256Hex(jpegBytes);

      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'code',
            type: 'image/jpeg',
            data: toBase64(jpegBytes),
          }),
        })
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        relic_id: string;
        version: number;
        kind: string;
        type: string;
        sha256: string;
        bytes: number;
        cover_url: string;
      };
      expect(body.relic_id).toBe(id);
      expect(body.version).toBe(1);
      expect(body.kind).toBe('code');
      expect(body.type).toBe('image/jpeg');
      expect(body.sha256).toBe(sha256);
      expect(body.bytes).toBe(jpegBytes.byteLength);
      expect(body.cover_url).toBe(
        `https://relic.example/${id}/cover/${sha256}.jpg`
      );
    });
  });

  describe('G1 state table and cover route', () => {
    test('no cover: shell serves card.v1.png and cover route returns 404', async () => {
      const { id } = await publish();
      const shellRes = await app.fetch(req(`/${id}`));
      const shellBody = await shellRes.text();
      expect(shellBody).toContain(
        'content="https://relic.example/assets/card.v1.png"'
      );
      expect(shellBody).not.toContain('/cover/');

      const dummySha = 'a'.repeat(64);
      const coverRes = await app.fetch(req(`/${id}/cover/${dummySha}.png`));
      expect(coverRes.status).toBe(404);
    });

    test('declined: shell serves card.v1.png and cover route returns 404', async () => {
      const { id } = await publish();
      const shellRes = await app.fetch(req(`/${id}`));
      const shellBody = await shellRes.text();
      expect(shellBody).toContain(
        'content="https://relic.example/assets/card.v1.png"'
      );

      const dummySha = 'b'.repeat(64);
      const coverRes = await app.fetch(req(`/${id}/cover/${dummySha}.png`));
      expect(coverRes.status).toBe(404);
    });

    test('stale version cover route returns 404 and shell serves card.v1.png', async () => {
      const { id, grant } = await publish();
      const pngBytes = makeValidPng(2);
      const sha256 = await sha256Hex(pngBytes);
      await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: toBase64(pngBytes),
          }),
        })
      );

      // Simulate a stale version cover: row is version 2, cover is version 1
      const row = await app.store.getRelic(id);
      if (row !== undefined) {
        const staleRow = { ...row, version: 2 };
        await app.store.putRelic(staleRow);
      }

      const coverRes = await app.fetch(req(`/${id}/cover/${sha256}.png`));
      expect(coverRes.status).toBe(404);
      expect(await coverRes.text()).toBe('Not found');

      const shellRes = await app.fetch(req(`/${id}`));
      const shellBody = await shellRes.text();
      expect(shellBody).toContain(
        'content="https://relic.example/assets/card.v1.png"'
      );
      expect(shellBody).not.toContain('/cover/');
    });

    test('tombstoned relic cover route returns 404 and shell serves card.v1.png', async () => {
      const { id, grant } = await publish();
      const pngBytes = makeValidPng(2);
      const sha256 = await sha256Hex(pngBytes);
      await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: toBase64(pngBytes),
          }),
        })
      );

      await app.store.putTombstone({
        id,
        publishIp: '198.51.100.10',
        publishedAt: now,
        publishingClient: 'relic-mcp/0.1.0 (test)',
        rendererClass: 'markdown',
        ciphertextHash: 'dummyhash',
        deletedAt: now,
        operator: 'jason',
        reasonClass: 'abuse',
        reportReference: undefined,
      });

      const coverRes = await app.fetch(req(`/${id}/cover/${sha256}.png`));
      expect(coverRes.status).toBe(404);
      expect(await coverRes.text()).toBe('Not found');

      const shellRes = await app.fetch(req(`/${id}`));
      const shellBody = await shellRes.text();
      expect(shellBody).toContain(
        'content="https://relic.example/assets/card.v1.png"'
      );
    });

    test('expired relic cover route returns 404 and shell serves card.v1.png', async () => {
      const { id, grant } = await publish({ ttlDays: 1 });
      const pngBytes = makeValidPng(2);
      const sha256 = await sha256Hex(pngBytes);
      await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: toBase64(pngBytes),
          }),
        })
      );

      // Advance clock past expiration
      now += 2 * 86_400 * 1000;

      const coverRes = await app.fetch(req(`/${id}/cover/${sha256}.png`));
      expect(coverRes.status).toBe(404);

      const shellRes = await app.fetch(req(`/${id}`));
      const shellBody = await shellRes.text();
      expect(shellBody).toContain(
        'content="https://relic.example/assets/card.v1.png"'
      );
    });

    test('unknown relic id cover route returns 404 and shell serves card.v1.png', async () => {
      const unissuedId = generateRelicId();
      const sha256 = 'c'.repeat(64);
      const coverRes = await app.fetch(
        req(`/${unissuedId}/cover/${sha256}.png`)
      );
      expect(coverRes.status).toBe(404);

      const shellRes = await app.fetch(req(`/${unissuedId}`));
      const shellBody = await shellRes.text();
      expect(shellBody).toContain(
        'content="https://relic.example/assets/card.v1.png"'
      );
    });

    test('store throws error: cover route returns 503 and shell serves card.v1.png', async () => {
      const throwingStore = new MemoryStore();
      throwingStore.getTombstone = async () => {
        throw new Error('store failure');
      };
      const customApp = build({ store: throwingStore });
      const id = generateRelicId();
      const sha256 = 'd'.repeat(64);

      const coverRes = await customApp.fetch(req(`/${id}/cover/${sha256}.png`));
      expect(coverRes.status).toBe(503);
      expect(coverRes.headers.get('cache-control')).toBe('no-store');

      const shellRes = await customApp.fetch(req(`/${id}`));
      expect(shellRes.status).toBe(200);
      const shellBody = await shellRes.text();
      expect(shellBody).toContain(
        'content="https://relic.example/assets/card.v1.png"'
      );
    });

    test('hash mismatch: cover route returns 404', async () => {
      const { id, grant } = await publish();
      const pngBytes = makeValidPng(2);
      await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: toBase64(pngBytes),
          }),
        })
      );

      const wrongSha = 'e'.repeat(64);
      const res = await app.fetch(req(`/${id}/cover/${wrongSha}.png`));
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
    });

    test('extension mismatch: cover route returns 404', async () => {
      const { id, grant } = await publish();
      const pngBytes = makeValidPng(2);
      const sha256 = await sha256Hex(pngBytes);
      await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: toBase64(pngBytes),
          }),
        })
      );

      // PNG cover requested with .jpg extension
      const res = await app.fetch(req(`/${id}/cover/${sha256}.jpg`));
      expect(res.status).toBe(404);
    });
  });

  describe('cover route headers and HEAD', () => {
    test('cover route serves exact 200 headers with no content encoding', async () => {
      const { id, grant } = await publish();
      const pngBytes = makeValidPng(2);
      const sha256 = await sha256Hex(pngBytes);
      await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: toBase64(pngBytes),
          }),
        })
      );

      const res = await app.fetch(
        req(`/${id}/cover/${sha256}.png`, {
          headers: { 'accept-encoding': 'gzip, br' },
        })
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('content-length')).toBe(
        String(pngBytes.byteLength)
      );
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
      expect(res.headers.get('content-security-policy')).toBe(
        "default-src 'none'; sandbox"
      );
      expect(res.headers.get('content-encoding')).toBeNull();

      const bodyBytes = new Uint8Array(await res.arrayBuffer());
      expect(Array.from(bodyBytes)).toEqual(Array.from(pngBytes));
    });

    test('HEAD cover route returns 200 with exact headers and null body', async () => {
      const { id, grant } = await publish();
      const pngBytes = makeValidPng(2);
      const sha256 = await sha256Hex(pngBytes);
      await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: toBase64(pngBytes),
          }),
        })
      );

      const res = await app.fetch(
        req(`/${id}/cover/${sha256}.png`, { method: 'HEAD' })
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('content-length')).toBe(
        String(pngBytes.byteLength)
      );
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
      expect(res.headers.get('content-security-policy')).toBe(
        "default-src 'none'; sandbox"
      );
      expect(res.headers.get('content-encoding')).toBeNull();
      expect(await res.text()).toBe('');
    });
  });

  describe('mint accounting', () => {
    test('shell and cover route fetches do not mint and do not append to mint log', async () => {
      const { id, grant } = await publish();
      const pngBytes = makeValidPng(2);
      const sha256 = await sha256Hex(pngBytes);
      await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: toBase64(pngBytes),
          }),
        })
      );

      // Fetch shell
      await app.fetch(req(`/${id}`));
      // Fetch cover
      await app.fetch(req(`/${id}/cover/${sha256}.png`));

      const row = await app.store.getRelic(id);
      expect(row?.mintsUsed).toBe(0);
      const mintLog = await app.store.readMintLog();
      expect(mintLog.length).toBe(0);
    });
  });

  describe('lifecycle: republish and operator delete', () => {
    test('republish without upload clears cover, deletes stored object, and serves card.v1.png', async () => {
      const { id, grant } = await publish();
      const pngBytes = makeValidPng(2);
      const sha256 = await sha256Hex(pngBytes);

      // Upload cover for v1
      await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: toBase64(pngBytes),
          }),
        })
      );

      // Verify cover is serving on v1
      const v1CoverRes = await app.fetch(req(`/${id}/cover/${sha256}.png`));
      expect(v1CoverRes.status).toBe(200);
      const v1Shell = await app.fetch(req(`/${id}`));
      expect(await v1Shell.text()).toContain(
        `https://relic.example/${id}/cover/${sha256}.png`
      );

      // In the republish flow, beginVersion clears cover: undefined
      const v2Row = await app.store.beginVersion(id, 'markdown', 20);
      expect(v2Row?.version).toBe(2);
      expect(v2Row?.cover).toBeUndefined();

      // And deleteCovers deletes the stored objects
      const deletedCovers = await app.store.deleteCovers(id);
      expect(deletedCovers).toBe(1);

      const covers = await app.store.listCovers(id);
      expect(covers.length).toBe(0);

      // Assert v1 cover URL now returns 404
      const oldCoverRes = await app.fetch(req(`/${id}/cover/${sha256}.png`));
      expect(oldCoverRes.status).toBe(404);

      // Assert shell now falls back to card.v1.png
      const v2Shell = await app.fetch(req(`/${id}`));
      const v2ShellBody = await v2Shell.text();
      expect(v2ShellBody).toContain(
        'content="https://relic.example/assets/card.v1.png"'
      );
      expect(v2ShellBody).not.toContain('/cover/');
    });

    test('operator delete removes cover objects and reports covers_deleted', async () => {
      const { id, grant } = await publish();
      const pngBytes = makeValidPng(2);
      const sha256 = await sha256Hex(pngBytes);

      await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: toBase64(pngBytes),
          }),
        })
      );

      const deleteRes = await app.fetch(
        req(`/api/relics/${id}`, {
          method: 'DELETE',
          headers: { authorization: 'Bearer operator-secret' },
        })
      );
      expect(deleteRes.status).toBe(200);
      const deleteJson = (await deleteRes.json()) as {
        deleted: boolean;
        covers_deleted: number;
      };
      expect(deleteJson.deleted).toBe(true);
      expect(deleteJson.covers_deleted).toBe(1);

      const covers = await app.store.listCovers(id);
      expect(covers.length).toBe(0);

      const coverRes = await app.fetch(req(`/${id}/cover/${sha256}.png`));
      expect(coverRes.status).toBe(404);
    });

    test('uploading cover for stale version after republish returns 409 cover_version_stale', async () => {
      const { id, grant } = await publish();
      await app.fetch(
        req(`/api/relics/${id}/republish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            renderer_class: 'markdown',
            declared_size_bytes: 20,
            declared_ciphertext_bytes: encryptedSize(20),
          }),
        })
      );

      const pngBytes = makeValidPng(2);
      const res = await app.fetch(
        req(`/api/relics/${id}/cover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            publish_token: grant.publish_token,
            version: 1,
            kind: 'markdown',
            type: 'image/png',
            data: toBase64(pngBytes),
          }),
        })
      );
      expect(res.status).toBe(409);
      const problem = (await res.json()) as {
        code: string;
        current_version: number;
      };
      expect(problem.code).toBe('cover_version_stale');
      expect(problem.current_version).toBe(2);
    });
  });
});
