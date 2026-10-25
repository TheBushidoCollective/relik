import { describe, expect, test } from 'bun:test';
import {
  encodeFragment,
  encryptRelic,
  generateKey,
  generateRelicId,
} from '@relic/format';
import { MAX_DIFF_BYTES } from '../src/diff.ts';
import {
  type KeyVault,
  load,
  loadHistoricalVersion,
  MAX_RENDER_BYTES,
  type MintResponse,
  type ViewerDeps,
} from '../src/viewer.ts';

const SERVICE = 'https://relik.example';

function memoryVault(): KeyVault {
  const values = new Map<string, string>();
  return {
    remember: (id, fragment) => values.set(id, fragment),
    recall: (id) => values.get(id),
    forget: (id) => values.delete(id),
  };
}

function mint(
  url: string,
  length: number,
  version: number,
  currentVersion: number
): MintResponse {
  return {
    url,
    url_expires_at: '2030-01-01T00:00:00.000Z',
    relic_expires_at: '2030-01-01T00:00:00.000Z',
    object_length: length,
    object_crc32c: 'AAAAAA==',
    mints_remaining: 7,
    version,
    current_version: currentVersion,
  };
}

function deps(
  fragment: string,
  fetch: typeof globalThis.fetch,
  keyVault: KeyVault = memoryVault()
): ViewerDeps {
  return {
    serviceOrigin: SERVICE,
    fetch,
    takeFragment: () => fragment,
    stripFragment: () => {},
    locationHref: `${SERVICE}/aaaaaaaaaaaaaaaaaaaaaaaaaa#${fragment}`,
    keyVault,
  };
}

async function encrypted(
  text: string,
  key: Uint8Array,
  filename = 'notes.txt',
  mimetype = 'text/plain'
): Promise<Uint8Array> {
  return encryptRelic({
    content: new TextEncoder().encode(text),
    filename,
    mimetype,
    key,
  });
}

describe('version discovery through the current mint', () => {
  test('keeps the existing empty-body mint and records both version numbers', async () => {
    const key = generateKey();
    const fragment = encodeFragment(key);
    const bytes = await encrypted('current\n', key);
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = (async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/mint')) {
        return Response.json(
          mint('https://storage.example/current', bytes.length, 3, 3)
        );
      }
      return new Response(bytes as unknown as BodyInit);
    }) as typeof globalThis.fetch;

    const state = await load(generateRelicId(), deps(fragment, fetch));

    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.view.version).toBe(3);
    expect(state.view.currentVersion).toBe(3);
    expect(requests[0]?.init).toEqual({ method: 'POST' });
    expect(requests[0]?.init?.body).toBeUndefined();
  });
});

describe('loading a historical version', () => {
  test('mints the selected version and decrypts it with the current fragment key', async () => {
    const id = generateRelicId();
    const key = generateKey();
    const fragment = encodeFragment(key);
    const currentBytes = await encrypted('current\n', key);
    const historicalBytes = await encrypted('before\n', key);
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = (async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/mint')) {
        const requested = init?.body === undefined ? 3 : 2;
        const bytes = requested === 3 ? currentBytes : historicalBytes;
        return Response.json(
          mint(
            `https://storage.example/v${requested}`,
            bytes.length,
            requested,
            3
          )
        );
      }
      const body = url.endsWith('/v2') ? historicalBytes : currentBytes;
      return new Response(body as unknown as BodyInit);
    }) as typeof globalThis.fetch;
    const viewerDeps = deps(fragment, fetch);
    const loaded = await load(id, viewerDeps);
    if (loaded.kind !== 'ready') throw new Error('expected current version');

    const history = await loadHistoricalVersion(id, 2, loaded.view, viewerDeps);

    expect(history.kind).toBe('ready');
    if (history.kind !== 'ready') return;
    expect(history.view.version).toBe(2);
    expect(history.view.currentVersion).toBe(3);
    expect(new TextDecoder().decode(history.view.content)).toBe('before\n');
    const explicitMint = requests.find(
      (request) =>
        request.url.endsWith('/mint') && request.init?.body !== undefined
    );
    expect(explicitMint?.init).toEqual({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 2 }),
    });
  });

  /** A `code` current version, three revisions deep. */
  function currentCode() {
    return {
      filename: 'notes.txt',
      declaredMimetype: 'text/plain',
      content: new TextEncoder().encode('current\n'),
      route: 'code' as const,
      downgradeNotice: undefined,
      shareUrl: `${SERVICE}/aaaaaaaaaaaaaaaaaaaaaaaaaa#${encodeFragment(generateKey())}`,
      version: 3,
      currentVersion: 3,
      versionDigest: '0'.repeat(64),
    };
  }

  test('a version past the comparison limit is still fetched, because it can be read alone', async () => {
    // The behaviour this replaces refused at the size gate and never issued
    // the download, so a reader asking for version 2 of a large relic was
    // shown nothing of version 2. Being too large to diff and being too
    // large to open are different limits, and only the second may stop a
    // version being opened.
    //
    // Asserted by where it gets to rather than by decrypting 32 MiB: the
    // fetch is issued, and the refusal that comes back is about the bytes
    // not matching their declared length, which is a leg past the gate that
    // used to stop it.
    //
    // Twice the ceiling, not a kilobyte over it. `plaintextSizeUpperBound`
    // subtracts the envelope's own overhead, so a value just past the limit
    // resolves to an upper bound just under it and the assertion cannot tell
    // the old gate from the new one. Found by mutating the gate back and
    // watching this test stay green.
    const current = currentCode();
    const requests: string[] = [];
    const fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/mint')) {
        return Response.json(
          mint(
            'https://storage.example/v2',
            MAX_DIFF_BYTES * 2,
            2,
            current.currentVersion
          )
        );
      }
      return new Response(new Uint8Array(8) as unknown as BodyInit);
    }) as typeof globalThis.fetch;

    const result = await loadHistoricalVersion(
      generateRelicId(),
      2,
      current,
      deps('', fetch)
    );

    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe('https://storage.example/v2');
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.code).toBe('version_truncated');
  });

  test('a version past what the viewer will allocate is refused before fetching', async () => {
    // The limit that does still stop a version being opened, and it is the
    // same one `load` applies to the current version rather than a second
    // number invented for history.
    const current = currentCode();
    const requests: string[] = [];
    const fetch = (async (input) => {
      requests.push(String(input));
      return Response.json(
        mint(
          'https://storage.example/v2',
          MAX_RENDER_BYTES * 2,
          2,
          current.currentVersion
        )
      );
    }) as typeof globalThis.fetch;

    const result = await loadHistoricalVersion(
      generateRelicId(),
      2,
      current,
      deps('', fetch)
    );

    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.code).toBe('version_too_large');
    // Refused on the declared length, so the bytes are never downloaded.
    expect(requests).toHaveLength(1);
    expect(current.route).toBe('code');
    expect(new TextDecoder().decode(current.content)).toBe('current\n');
  });
});
