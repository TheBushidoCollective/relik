import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Crc32c } from '@relic/format';
import {
  buildSignedRequest,
  encodeObjectPath,
  gcsStorage,
  MAX_EXPIRES_SECONDS,
  privateKeySigner,
  rfc3986,
  type SignRequestInput,
  signUrl,
  stringToSignFor,
  toDatestamp,
  toTimestamp,
} from '../src/gcs.ts';
import { MemoryStorage } from '../src/storage.ts';

const NOW = Date.parse('2026-08-04T09:15:30.000Z');
const EMAIL = 'relic@relic-prod.iam.gserviceaccount.com';

const base: SignRequestInput = {
  method: 'GET',
  host: 'storage.googleapis.com',
  path: '/relic-objects/abc123',
  clientEmail: EMAIL,
  expiresSeconds: 900,
  now: NOW,
};

/** A real RSA keypair, so the signature can actually be verified. */
let privateKey: CryptoKey;
let publicKey: CryptoKey;
let privateKeyPem: string;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${
    b64.match(/.{1,64}/g)?.join('\n') ?? b64
  }\n-----END PRIVATE KEY-----\n`;
});

describe('percent encoding', () => {
  test('escapes the characters encodeURIComponent leaves alone', () => {
    // A mismatch here signs a different request than the one being made, and
    // it surfaces as an opaque 403 rather than anything diagnosable.
    expect(rfc3986("!'()*")).toBe('%21%27%28%29%2A');
  });

  test('escapes the separators that matter', () => {
    expect(rfc3986('a/b')).toBe('a%2Fb');
    expect(rfc3986('a b')).toBe('a%20b');
    expect(rfc3986('a+b')).toBe('a%2Bb');
  });

  test('object paths keep their separators', () => {
    expect(encodeObjectPath('bucket/dir/name')).toBe('bucket/dir/name');
    expect(encodeObjectPath('dir/a b')).toBe('dir/a%20b');
  });
});

describe('timestamps', () => {
  test('are basic-format ISO 8601', () => {
    expect(toTimestamp(NOW)).toBe('20260804T091530Z');
    expect(toDatestamp(NOW)).toBe('20260804');
  });
});

describe('the canonical request', () => {
  test('has the exact six-part structure GCS expects', () => {
    const { canonicalRequest } = buildSignedRequest(base);
    const lines = canonicalRequest.split('\n');

    expect(lines[0]).toBe('GET');
    expect(lines[1]).toBe('/relic-objects/abc123');
    expect(lines[2]).toContain('X-Goog-Algorithm=GOOG4-RSA-SHA256');
    expect(lines[3]).toBe('host:storage.googleapis.com');
    expect(lines[4]).toBe(''); // blank line after canonical headers
    expect(lines[5]).toBe('host');
    expect(lines[6]).toBe('UNSIGNED-PAYLOAD');
  });

  test('sorts query parameters by encoded key', () => {
    const { query } = buildSignedRequest(base);
    const keys = query.split('&').map((pair) => pair.split('=')[0] as string);
    expect(keys).toEqual([...keys].sort());
  });

  test('encodes the credential scope', () => {
    const { query } = buildSignedRequest(base);
    expect(query).toContain(
      `X-Goog-Credential=${rfc3986(`${EMAIL}/20260804/auto/storage/goog4_request`)}`
    );
  });

  test('signs extra headers, lowercased and sorted', () => {
    const { canonicalRequest, signedHeaders } = buildSignedRequest({
      ...base,
      method: 'PUT',
      headers: { 'Content-Length': ' 4096 ' },
    });
    expect(signedHeaders).toBe('content-length;host');
    expect(canonicalRequest).toContain('content-length:4096\n');
    expect(canonicalRequest).toContain('host:storage.googleapis.com\n');
  });

  test('is deterministic for the same inputs', () => {
    expect(buildSignedRequest(base)).toEqual(buildSignedRequest(base));
  });

  test('refuses an expiry past the GCS ceiling', () => {
    expect(() =>
      buildSignedRequest({ ...base, expiresSeconds: MAX_EXPIRES_SECONDS + 1 })
    ).toThrow(/ceiling/);
  });

  test('accepts exactly the ceiling', () => {
    expect(() =>
      buildSignedRequest({ ...base, expiresSeconds: MAX_EXPIRES_SECONDS })
    ).not.toThrow();
  });
});

describe('signing', () => {
  test('produces a signature that verifies against the public key', async () => {
    // The real assertion: the bytes we sign are the bytes stringToSignFor
    // produces, and the signature over them is valid RSASSA-PKCS1-v1_5.
    const url = await signUrl(base, privateKeySigner(EMAIL, privateKeyPem));
    const signature = new URL(url).searchParams.get('X-Goog-Signature');
    expect(signature).not.toBeNull();

    const bytes = Uint8Array.from(
      (signature as string).match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []
    );
    const verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      bytes,
      new TextEncoder().encode(await stringToSignFor(base))
    );
    expect(verified).toBe(true);
  });

  test('a different request does not verify against the first signature', async () => {
    const url = await signUrl(base, privateKeySigner(EMAIL, privateKeyPem));
    const signature = new URL(url).searchParams.get(
      'X-Goog-Signature'
    ) as string;
    const bytes = Uint8Array.from(
      signature.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? []
    );

    const tampered = await stringToSignFor({ ...base, method: 'DELETE' });
    expect(
      await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        publicKey,
        bytes,
        new TextEncoder().encode(tampered)
      )
    ).toBe(false);
  });

  test('the string to sign has the four-line V4 structure', async () => {
    const lines = (await stringToSignFor(base)).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('GOOG4-RSA-SHA256');
    expect(lines[1]).toBe('20260804T091530Z');
    expect(lines[2]).toBe('20260804/auto/storage/goog4_request');
    expect(lines[3]).toMatch(/^[0-9a-f]{64}$/);
  });
});

/** A loopback GCS fake that models transcoding and conditional metadata edits. */
async function digestFixture(options: {
  bytes: Buffer;
  contentEncoding?: string;
  contentType?: string;
  cacheControl?: string;
  reportedLength?: number;
}) {
  const state: {
    metadata: {
      generation: string;
      metageneration: string;
      size: string;
      contentEncoding?: string;
      contentType?: string;
      cacheControl?: string;
      metadata: Record<string, string>;
    };
    patchCalls: Array<{
      query: URLSearchParams;
      body: Record<string, unknown>;
    }>;
    getCalls: Array<{
      headers: Record<string, string | string[] | undefined>;
      query: URLSearchParams;
    }>;
    metadataStatus: number;
    patchStatus: number;
    getStatus: number;
    bodyOverride?: Buffer;
    chunked: boolean;
    forceTranscode: boolean;
    beforeGet?: () => void;
    afterPatch?: () => void;
  } = {
    metadata: {
      generation: '12345',
      metageneration: '7',
      size: String(options.reportedLength ?? options.bytes.length),
      ...(options.contentEncoding
        ? { contentEncoding: options.contentEncoding }
        : {}),
      ...(options.contentType ? { contentType: options.contentType } : {}),
      ...(options.cacheControl ? { cacheControl: options.cacheControl } : {}),
      metadata: { retained: 'unchanged' },
    },
    patchCalls: [],
    getCalls: [],
    metadataStatus: 200,
    patchStatus: 200,
    getStatus: 200,
    chunked: false,
    forceTranscode: false,
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const metadataRequest = url.pathname.startsWith('/storage/v1/b/');
      if (metadataRequest) {
        if (request.headers.authorization !== 'Bearer fixture-token') {
          response.writeHead(401).end();
          return;
        }
        if (request.method === 'GET') {
          response.writeHead(state.metadataStatus, {
            'content-type': 'application/json',
          });
          response.end(JSON.stringify(state.metadata));
          return;
        }
        if (request.method === 'PATCH') {
          let text = '';
          for await (const chunk of request)
            text += Buffer.from(chunk).toString();
          const body = JSON.parse(text) as Record<string, unknown>;
          state.patchCalls.push({ query: url.searchParams, body });
          const matches =
            url.searchParams.get('ifGenerationMatch') ===
              state.metadata.generation &&
            url.searchParams.get('ifMetagenerationMatch') ===
              state.metadata.metageneration;
          if (!matches || state.patchStatus !== 200) {
            response.writeHead(matches ? state.patchStatus : 412).end();
            return;
          }
          if (typeof body['cacheControl'] !== 'string') {
            response.writeHead(400).end();
            return;
          }
          state.metadata.cacheControl = body['cacheControl'];
          state.metadata.metageneration = String(
            Number(state.metadata.metageneration) + 1
          );
          state.afterPatch?.();
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(state.metadata));
          return;
        }
        response.writeHead(405).end();
        return;
      }

      state.getCalls.push({
        headers: request.headers,
        query: url.searchParams,
      });
      state.beforeGet?.();
      if (state.getStatus !== 200) {
        response.writeHead(state.getStatus).end();
        return;
      }
      if (
        (request.headers['x-goog-if-generation-match'] &&
          request.headers['x-goog-if-generation-match'] !==
            state.metadata.generation) ||
        (request.headers['x-goog-if-metageneration-match'] &&
          request.headers['x-goog-if-metageneration-match'] !==
            state.metadata.metageneration)
      ) {
        response.writeHead(412).end();
        return;
      }

      const noTransform = (state.metadata.cacheControl ?? '')
        .split(',')
        .some((part) => part.trim().toLowerCase() === 'no-transform');
      const acceptsGzip = (request.headers['accept-encoding'] ?? '').includes(
        'gzip'
      );
      const transcoded =
        state.metadata.contentEncoding === 'gzip' &&
        (state.forceTranscode ||
          (!noTransform &&
            (state.metadata.contentType === 'application/gzip' ||
              !acceptsGzip)));
      const body =
        state.bodyOverride ??
        (transcoded ? gunzipSync(options.bytes) : options.bytes);
      response.setHeader('x-goog-generation', state.metadata.generation);
      response.setHeader(
        'x-goog-metageneration',
        state.metadata.metageneration
      );
      if (state.metadata.contentEncoding && !transcoded) {
        response.setHeader('content-encoding', state.metadata.contentEncoding);
      }
      if (state.chunked || transcoded) {
        response.setHeader('transfer-encoding', 'chunked');
      } else {
        response.setHeader('content-length', String(body.length));
      }
      response.write(body.subarray(0, Math.floor(body.length / 2)));
      response.end(body.subarray(Math.floor(body.length / 2)));
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('missing fixture port');
  const origin = `http://127.0.0.1:${address.port}`;
  const localUrl = (url: string): string => {
    const parsed = new URL(url);
    return `${origin}${parsed.pathname}${parsed.search}`;
  };
  const storage = gcsStorage({
    bucket: 'relic-objects',
    prefix: 'r',
    signer: {
      clientEmail: EMAIL,
      sign: async () => new Uint8Array([1, 2, 3]),
    },
    getAccessToken: async () => 'fixture-token',
    metadataFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return fetch(localUrl(url), init);
    }) as typeof globalThis.fetch,
    rawRequest: (url, init, callback) =>
      httpRequest(localUrl(url), init, callback),
  });

  return {
    state,
    storage,
    origin,
    async close() {
      const closed = Promise.withResolvers<void>();
      server.close((error) =>
        error ? closed.reject(error) : closed.resolve()
      );
      server.closeAllConnections();
      await closed.promise;
    },
  };
}

describe('the storage adapter', () => {
  const storage = () =>
    gcsStorage({
      bucket: 'relic-objects',
      prefix: 'r',
      signer: privateKeySigner(EMAIL, privateKeyPem),
    });

  test('signs an upload with content-length pinned', async () => {
    const upload = await storage().signUpload('abc123', 4096, 900, NOW);

    expect(upload.method).toBe('PUT');
    expect(upload.headers['content-length']).toBe('4096');
    // Signed, so a client cannot alter it without invalidating the signature.
    expect(upload.url).toContain('content-length%3Bhost');
    expect(upload.contentLength).toBe(4096);
    expect(upload.expiresAt).toBe(NOW + 900_000);
  });

  test('signs a cap-sized upload for the configured 4,500-second window', async () => {
    const upload = await storage().signUpload(
      'abc123',
      524_489_608,
      4_500,
      NOW
    );
    const url = new URL(upload.url);
    expect(upload.headers['content-length']).toBe('524489608');
    expect(upload.expiresAt).toBe(NOW + 4_500_000);
    expect(url.searchParams.get('X-Goog-Expires')).toBe('4500');
    expect(url.searchParams.get('X-Goog-SignedHeaders')).toBe(
      'content-length;host'
    );
  });

  test('signs no x-goog-meta header, because nothing needs object metadata', async () => {
    const upload = await storage().signUpload('abc123', 4096, 900, NOW);
    for (const name of Object.keys(upload.headers)) {
      expect(name.toLowerCase().startsWith('x-goog-meta-')).toBe(false);
    }
    expect(upload.url.toLowerCase()).not.toContain('x-goog-meta');
  });

  test('places the object under the configured prefix', async () => {
    const upload = await storage().signUpload('abc123', 1, 900, NOW);
    expect(new URL(upload.url).pathname).toBe('/relic-objects/r/abc123');
  });

  test('signs a download for GET and reports its expiry', async () => {
    const signed = await storage().signDownload('abc123', 900, NOW);
    expect(signed.url).toContain('X-Goog-Signature=');
    expect(signed.expiresAt).toBe(NOW + 900_000);
  });

  test('download and upload URLs differ, since the method is signed', async () => {
    const store = storage();
    const download = await store.signDownload('abc123', 900, NOW);
    const upload = await store.signUpload('abc123', 4096, 900, NOW);
    expect(download.url).not.toBe(upload.url);
  });

  test('refuses to sign past the GCS ceiling', async () => {
    await expect(
      storage().signDownload('abc123', MAX_EXPIRES_SECONDS + 1, NOW)
    ).rejects.toThrow(/ceiling/);
  });

  test('digest streams chunked bytes and signs both generation preconditions', async () => {
    const bytes = Buffer.from('hello world');
    const fixture = await digestFixture({ bytes });
    fixture.state.chunked = true;
    try {
      expect(await fixture.storage.digest('abc123')).toBe(
        createHash('sha256').update(bytes).digest('hex')
      );
      expect(fixture.state.patchCalls).toHaveLength(0);
      const get = fixture.state.getCalls[0];
      expect(get?.headers['accept-encoding']).toBe('gzip');
      expect(get?.headers['x-goog-if-generation-match']).toBe('12345');
      expect(get?.headers['x-goog-if-metageneration-match']).toBe('7');
      expect(get?.query.get('X-Goog-SignedHeaders')).toBe(
        'accept-encoding;host;x-goog-if-generation-match;x-goog-if-metageneration-match'
      );
    } finally {
      await fixture.close();
    }
  });

  test('digest preserves stored gzip bytes through real HTTP and GCS-style transcoding', async () => {
    const inner = gzipSync(
      Buffer.from('sensitive ciphertext payload '.repeat(50))
    );
    const stored = gzipSync(inner);
    const fixture = await digestFixture({
      bytes: stored,
      contentEncoding: 'gzip',
      contentType: 'application/gzip',
      cacheControl: 'private, max-age=60',
    });
    try {
      // GCS documents transcoding for this combination even when gzip is
      // accepted. The fake demonstrates why the metadata update is needed.
      const before = await fetch(`${fixture.origin}/object`, {
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(before.headers.get('content-encoding')).toBeNull();
      expect(Buffer.from(await before.arrayBuffer()).equals(inner)).toBe(true);

      expect(await fixture.storage.digest('abc123')).toBe(
        createHash('sha256').update(stored).digest('hex')
      );
      expect(fixture.state.patchCalls).toHaveLength(1);
      const patch = fixture.state.patchCalls[0];
      expect(patch?.query.get('ifGenerationMatch')).toBe('12345');
      expect(patch?.query.get('ifMetagenerationMatch')).toBe('7');
      expect(patch?.body).toEqual({
        cacheControl: 'no-transform, private, max-age=60',
      });
      expect(fixture.state.metadata.metadata).toEqual({
        retained: 'unchanged',
      });
      const get = fixture.state.getCalls[1];
      expect(get?.headers['x-goog-if-generation-match']).toBe('12345');
      expect(get?.headers['x-goog-if-metageneration-match']).toBe('8');
      expect(get?.headers['accept-encoding']).toBe('gzip');

      // The same HTTP response is transparently decompressed by fetch. The
      // signed Node HTTP path above must instead hash the outer gzip bytes.
      const decoded = await fetch(`${fixture.origin}/object`, {
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(decoded.headers.get('content-encoding')).toBe('gzip');
      expect(Buffer.from(await decoded.arrayBuffer()).equals(inner)).toBe(true);
      expect(createHash('sha256').update(inner).digest('hex')).not.toBe(
        createHash('sha256').update(stored).digest('hex')
      );
    } finally {
      await fixture.close();
    }
  });

  test('digest hashes bytes even when gzip metadata mislabels the object', async () => {
    const bytes = Buffer.from('not a gzip stream');
    const fixture = await digestFixture({
      bytes,
      contentEncoding: 'gzip',
      contentType: 'application/gzip',
    });
    try {
      expect(await fixture.storage.digest('abc123')).toBe(
        createHash('sha256').update(bytes).digest('hex')
      );
      expect(fixture.state.patchCalls[0]?.body).toEqual({
        cacheControl: 'no-transform',
      });
    } finally {
      await fixture.close();
    }
  });

  test('digest leaves an existing no-transform directive intact', async () => {
    const bytes = gzipSync(Buffer.from('ciphertext'));
    const fixture = await digestFixture({
      bytes,
      contentEncoding: 'gzip',
      cacheControl: 'private, NO-TRANSFORM',
    });
    try {
      expect(await fixture.storage.digest('abc123')).toBe(
        createHash('sha256').update(bytes).digest('hex')
      );
      expect(fixture.state.patchCalls).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test('a quoted no-transform value cannot bypass the metadata guard', async () => {
    const bytes = gzipSync(Buffer.from('ciphertext'));
    const cacheControl = 'private, custom="one,no-transform,two"';
    const fixture = await digestFixture({
      bytes,
      contentEncoding: 'gzip',
      contentType: 'application/gzip',
      cacheControl,
    });
    try {
      expect(await fixture.storage.digest('abc123')).toBe(
        createHash('sha256').update(bytes).digest('hex')
      );
      expect(fixture.state.patchCalls[0]?.body).toEqual({
        cacheControl: `no-transform, ${cacheControl}`,
      });
    } finally {
      await fixture.close();
    }
  });

  test('digest rejects an unexpectedly transcoded equal-length response', async () => {
    const bytes = gzipSync(Buffer.from('ciphertext'));
    const fixture = await digestFixture({
      bytes,
      contentEncoding: 'gzip',
      cacheControl: 'no-transform',
    });
    fixture.state.forceTranscode = true;
    fixture.state.bodyOverride = Buffer.alloc(bytes.length, 1);
    try {
      await expect(fixture.storage.digest('abc123')).rejects.toThrow(
        /response metadata mismatch/
      );
    } finally {
      await fixture.close();
    }
  });

  test('digest returns undefined only when metadata is absent', async () => {
    const fixture = await digestFixture({ bytes: Buffer.from('hello') });
    try {
      fixture.state.metadataStatus = 404;
      expect(await fixture.storage.digest('missing')).toBeUndefined();
      fixture.state.metadataStatus = 500;
      await expect(fixture.storage.digest('error')).rejects.toThrow(/500/);
      fixture.state.metadataStatus = 200;
      fixture.state.getStatus = 404;
      await expect(fixture.storage.digest('vanished')).rejects.toThrow(/404/);
    } finally {
      await fixture.close();
    }
  });

  test('digest rejects missing generation or invalid stored size', async () => {
    const fixture = await digestFixture({ bytes: Buffer.from('hello') });
    try {
      fixture.state.metadata.generation = '';
      await expect(fixture.storage.digest('abc123')).rejects.toThrow(
        /metadata/
      );
      fixture.state.metadata.generation = '12345';
      fixture.state.metadata.metageneration = '';
      await expect(fixture.storage.digest('abc123')).rejects.toThrow(
        /metadata/
      );
      fixture.state.metadata.metageneration = '7';
      fixture.state.metadata.size = '5garbage';
      await expect(fixture.storage.digest('abc123')).rejects.toThrow(
        /metadata/
      );
      expect(fixture.state.getCalls).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test('digest fails closed when the guarded metadata patch fails', async () => {
    const fixture = await digestFixture({
      bytes: gzipSync(Buffer.from('data')),
      contentEncoding: 'gzip',
    });
    try {
      fixture.state.patchStatus = 412;
      await expect(fixture.storage.digest('abc123')).rejects.toThrow(/412/);
      expect(fixture.state.getCalls).toHaveLength(0);
      expect(fixture.state.metadata.cacheControl).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  test('digest rejects a patch response for a different object generation', async () => {
    const fixture = await digestFixture({
      bytes: gzipSync(Buffer.from('data')),
      contentEncoding: 'gzip',
    });
    try {
      fixture.state.afterPatch = () => {
        fixture.state.metadata.generation = '12346';
      };
      await expect(fixture.storage.digest('abc123')).rejects.toThrow(
        /metadata/
      );
      expect(fixture.state.getCalls).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test('digest rejects a patch that loses existing cache directives', async () => {
    const fixture = await digestFixture({
      bytes: gzipSync(Buffer.from('data')),
      contentEncoding: 'gzip',
      cacheControl: 'private, max-age=60',
    });
    try {
      fixture.state.afterPatch = () => {
        fixture.state.metadata.cacheControl = 'no-transform';
      };
      await expect(fixture.storage.digest('abc123')).rejects.toThrow(
        /metadata/
      );
      expect(fixture.state.getCalls).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test('digest rejects generation and metadata changes between lookup and GET', async () => {
    const fixture = await digestFixture({ bytes: Buffer.from('hello') });
    try {
      fixture.state.beforeGet = () => {
        fixture.state.metadata.generation = '12346';
      };
      await expect(fixture.storage.digest('abc123')).rejects.toThrow(/412/);
      fixture.state.metadata.generation = '12345';
      fixture.state.beforeGet = () => {
        fixture.state.metadata.metageneration = '8';
      };
      await expect(fixture.storage.digest('abc123')).rejects.toThrow(/412/);
    } finally {
      await fixture.close();
    }
  });

  test('digest rejects response lengths inconsistent with stored metadata', async () => {
    const fixture = await digestFixture({
      bytes: Buffer.from('hello'),
      reportedLength: 20,
    });
    try {
      await expect(fixture.storage.digest('abc123')).rejects.toThrow(
        /mismatch/
      );
      fixture.state.chunked = true;
      await expect(fixture.storage.digest('abc123')).rejects.toThrow(
        /mismatch/
      );
      fixture.state.metadata.size = '3';
      await expect(fixture.storage.digest('abc123')).rejects.toThrow(/exceeds/);
    } finally {
      await fixture.close();
    }
  });

  test('a private-key signer exchanges a valid assertion for metadata access', async () => {
    let exchanges = 0;
    const store = gcsStorage({
      bucket: 'relic-objects',
      signer: privateKeySigner(EMAIL, privateKeyPem),
      metadataFetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === 'https://oauth2.googleapis.com/token') {
          exchanges++;
          const params = init?.body as URLSearchParams;
          expect(params.get('grant_type')).toBe(
            'urn:ietf:params:oauth:grant-type:jwt-bearer'
          );
          const parts = (params.get('assertion') ?? '').split('.');
          const [header, claims, signature] = parts;
          if (!header || !claims || !signature) throw new Error('missing JWT');
          expect(
            JSON.parse(Buffer.from(header, 'base64url').toString())
          ).toEqual({
            alg: 'RS256',
            typ: 'JWT',
          });
          const decoded = JSON.parse(
            Buffer.from(claims, 'base64url').toString()
          );
          expect(decoded.iss).toBe(EMAIL);
          expect(decoded.aud).toBe(url);
          expect(decoded.scope).toBe(
            'https://www.googleapis.com/auth/devstorage.read_write'
          );
          expect(decoded.exp - decoded.iat).toBe(3600);
          expect(
            await crypto.subtle.verify(
              'RSASSA-PKCS1-v1_5',
              publicKey,
              Uint8Array.from(Buffer.from(signature, 'base64url')),
              new TextEncoder().encode(`${header}.${claims}`)
            )
          ).toBe(true);
          return Response.json({
            access_token: 'fixture-token',
            expires_in: 3600,
          });
        }
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer fixture-token'
        );
        return new Response(null, { status: 404 });
      }) as typeof globalThis.fetch,
    });
    expect(await store.digest('missing')).toBeUndefined();
    expect(await store.digest('missing')).toBeUndefined();
    expect(exchanges).toBe(1);
  });
});

describe('in-memory storage', () => {
  test('caches CRC32C at put and refreshes it on replacement', async () => {
    const storage = new MemoryStorage();
    const update = spyOn(Crc32c.prototype, 'update');
    try {
      const bytes = new TextEncoder().encode('123456789');
      storage.put('object', bytes);
      expect(update).toHaveBeenCalledTimes(1);
      expect(await storage.stat('object')).toEqual({
        length: 9,
        crc32c: '4waSgw==',
      });
      expect(await storage.stat('object')).toEqual({
        length: 9,
        crc32c: '4waSgw==',
      });
      expect(update).toHaveBeenCalledTimes(1);

      storage.put('object', new TextEncoder().encode('hello'));
      expect(update).toHaveBeenCalledTimes(2);
      expect(await storage.stat('object')).toEqual({
        length: 5,
        crc32c: 'mnG7TA==',
      });
      await storage.delete('object');
      expect(await storage.stat('object')).toBeUndefined();
    } finally {
      update.mockRestore();
    }
  });
});
