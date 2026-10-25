import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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

  test('digest streams a chunked body and computes sha256', async () => {
    const originalFetch = globalThis.fetch;
    try {
      const chunk1 = new TextEncoder().encode('hello ');
      const chunk2 = new TextEncoder().encode('world');
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(chunk1);
          controller.enqueue(chunk2);
          controller.close();
        },
      });
      globalThis.fetch = (async () => {
        return new Response(stream, {
          status: 200,
          headers: {
            'content-length': '11',
            'x-goog-generation': '12345',
          },
        });
      }) as unknown as typeof fetch;

      const digest = await storage().digest('abc123');
      const expected = createHash('sha256').update('hello world').digest('hex');
      expect(digest).toBe(expected);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('digest returns undefined on 404', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        return new Response('not found', { status: 404 });
      }) as unknown as typeof fetch;

      const digest = await storage().digest('missing');
      expect(digest).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('digest throws on other non-200 status', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        return new Response('server error', { status: 500 });
      }) as unknown as typeof fetch;

      await expect(storage().digest('error')).rejects.toThrow(/500/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('digest throws if hashed bytes do not match stat length', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit
      ) => {
        const method =
          init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: { 'content-length': '20' }, // stat says 20
          });
        }
        return new Response('short', {
          status: 200,
          headers: { 'content-length': '20' }, // 5 bytes != 20
        });
      }) as unknown as typeof fetch;

      await expect(storage().digest('abc123')).rejects.toThrow(/mismatch/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('digest pins GET to stat generation with x-goog-if-generation-match', async () => {
    const originalFetch = globalThis.fetch;
    try {
      let getHeaders: Headers | undefined;
      globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit
      ) => {
        const method =
          init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: {
              'content-length': '5',
              'x-goog-generation': 'gen-999',
            },
          });
        }
        getHeaders = new Headers(init?.headers);
        return new Response('hello', {
          status: 200,
          headers: { 'content-length': '5' },
        });
      }) as unknown as typeof fetch;

      const digest = await storage().digest('abc123');
      expect(digest).toBe(createHash('sha256').update('hello').digest('hex'));
      expect(getHeaders?.get('x-goog-if-generation-match')).toBe('gen-999');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('digest returns undefined if generation match returns 412', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit
      ) => {
        const method =
          init?.method ?? (input instanceof Request ? input.method : 'GET');
        if (method === 'HEAD') {
          return new Response(null, {
            status: 200,
            headers: {
              'content-length': '5',
              'x-goog-generation': 'gen-999',
            },
          });
        }
        return new Response('precondition failed', { status: 412 });
      }) as unknown as typeof fetch;

      const digest = await storage().digest('abc123');
      expect(digest).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
