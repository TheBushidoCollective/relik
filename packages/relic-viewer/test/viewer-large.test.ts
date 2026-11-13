import { describe, expect, test } from 'bun:test';
import {
  deriveKeys,
  encodeEnvelope,
  encodeFragment,
  encodeHeader,
  encryptedSize,
  encryptRecord,
  encryptRelic,
  FORMAT_VERSION,
  generateKey,
  generateRelicId,
  PLAINTEXT_CAP_BYTES,
  RECORD_SIZE,
  recordCapacity,
  sha256Hex,
} from '@relic/format';
import { contentFromBlob, contentFromBytes } from '../src/content.ts';
import {
  LARGE_OPEN_CONFIRM_BYTES,
  load,
  loadHistoricalVersion,
  openRelicWithKey,
  routeContent,
  routeFor,
  type ViewerDeps,
} from '../src/viewer.ts';

async function encryptedPrefix(
  key: Uint8Array,
  length: number,
  rs = RECORD_SIZE
): Promise<Uint8Array> {
  const salt = new Uint8Array(16);
  const envelope = encodeEnvelope({
    version: FORMAT_VERSION,
    entries: [
      { filename: 'large.txt', mimetype: 'text/plain', offset: 0, length },
    ],
  });
  const record = await encryptRecord(
    await deriveKeys(key, salt),
    0,
    envelope,
    false,
    recordCapacity(rs)
  );
  const header = encodeHeader(salt, rs);
  const prefix = new Uint8Array(header.length + record.length);
  prefix.set(header);
  prefix.set(record, header.length);
  return prefix;
}

function fixture(
  key: Uint8Array,
  prefix: Uint8Array,
  length: number,
  rs = RECORD_SIZE
) {
  const id = generateRelicId();
  const fragment = encodeFragment(key);
  let bodyFetches = 0;
  let cancelled = false;
  let confirmed = 0;
  let confirmation:
    | {
        size: number;
        filename: string | undefined;
        mimetype: string | undefined;
      }
    | undefined;
  const deps: ViewerDeps = {
    serviceOrigin: 'https://relik.example',
    locationHref: `https://relik.example/${id}#${fragment}`,
    takeFragment: () => fragment,
    keyVault: { remember() {}, recall: () => undefined, forget() {} },
    onLargeOpen: async (size, metadata) => {
      confirmed++;
      confirmation = {
        size,
        filename: metadata?.filename,
        mimetype: metadata?.mimetype,
      };
      expect(cancelled).toBe(true);
      return false;
    },
    fetch: (async (input) => {
      if (String(input).endsWith('/mint')) {
        return Response.json({
          url: 'https://storage.example/object',
          url_expires_at: '2099-01-01T00:00:00Z',
          relic_expires_at: null,
          object_length: encryptedSize(length, rs),
          object_crc32c: 'AAAAAA==',
          mints_remaining: 199,
          version: 1,
          current_version: 1,
        });
      }
      bodyFetches++;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            start(controller) {
              controller.enqueue(prefix);
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 }
        )
      );
    }) as typeof fetch,
  };
  return {
    id,
    fragment,
    deps,
    get bodyFetches() {
      return bodyFetches;
    },
    get cancelled() {
      return cancelled;
    },
    get confirmed() {
      return confirmed;
    },
    get confirmation() {
      return confirmation;
    },
  };
}

describe('large file opening', () => {
  test('authenticates and cancels the prefix before showing the exact size; declining never starts the full fetch', async () => {
    const key = generateKey();
    const length = LARGE_OPEN_CONFIRM_BYTES + 1;
    const f = fixture(key, await encryptedPrefix(key, length), length);
    const state = await load(f.id, f.deps);
    expect(state.kind).toBe('dead');
    if (state.kind !== 'dead') return;
    expect(state.dead.code).toBe('large_open_cancelled');
    expect(f.cancelled).toBe(true);
    expect(f.bodyFetches).toBe(1);
    expect(f.confirmed).toBe(1);
    expect(f.confirmation).toEqual({
      size: length,
      filename: 'large.txt',
      mimetype: 'text/plain',
    });
  });

  test('a non-default record size cannot bypass the confirmation', async () => {
    const key = generateKey();
    const length = LARGE_OPEN_CONFIRM_BYTES + 1;
    const rs = 32_768;
    const f = fixture(key, await encryptedPrefix(key, length, rs), length, rs);
    const state = await load(f.id, f.deps);
    expect(state.kind).toBe('dead');
    if (state.kind === 'dead')
      expect(state.dead.code).toBe('large_open_cancelled');
    expect(f.confirmed).toBe(1);
    expect(f.bodyFetches).toBe(1);
  });

  test('approval is bound to the authenticated envelope checked before the prompt', async () => {
    const key = generateKey();
    const length = LARGE_OPEN_CONFIRM_BYTES + 1;
    const f = fixture(key, await encryptedPrefix(key, length), length);
    const changed = await encryptedPrefix(key, length + 1);
    let bodyRequests = 0;
    const fetch: typeof globalThis.fetch = (async (input, init) => {
      if (!String(input).endsWith('/mint') && ++bodyRequests === 2) {
        return new Response(changed as unknown as BodyInit);
      }
      return f.deps.fetch(input, init);
    }) as typeof globalThis.fetch;
    const state = await load(f.id, {
      ...f.deps,
      fetch,
      onLargeOpen: async () => true,
    });
    expect(state.kind).toBe('dead');
    if (state.kind === 'dead') expect(state.dead.code).toBe('content_changed');
    expect(bodyRequests).toBe(2);
  });

  test('refreshes an expiring signed URL after the reader confirms', async () => {
    const key = generateKey();
    const length = LARGE_OPEN_CONFIRM_BYTES + 1;
    const prefix = await encryptedPrefix(key, length);
    const f = fixture(key, prefix, length);
    let now = 1_000_000;
    let mints = 0;
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = (async (input) => {
      if (String(input).endsWith('/mint')) {
        mints++;
        return Response.json({
          url: `https://storage.example/${mints}`,
          url_expires_at: new Date(
            now + (mints === 1 ? 61_000 : 900_000)
          ).toISOString(),
          relic_expires_at: null,
          object_length: encryptedSize(length),
          object_crc32c: 'AAAAAA==',
          mints_remaining: 199,
          version: 1,
          current_version: 1,
        });
      }
      urls.push(String(input));
      return new Response(prefix as unknown as BodyInit);
    }) as typeof globalThis.fetch;
    const state = await load(f.id, {
      ...f.deps,
      fetch,
      now: () => now,
      onLargeOpen: async () => {
        now += 2_000;
        return true;
      },
    });
    expect(state.kind).toBe('dead');
    if (state.kind === 'dead')
      expect(state.dead.code).toBe('truncated_transfer');
    expect(mints).toBe(2);
    expect(urls).toEqual([
      'https://storage.example/1',
      'https://storage.example/2',
    ]);
  });

  test('the manual-key path uses the same confirmation', async () => {
    const key = generateKey();
    const length = LARGE_OPEN_CONFIRM_BYTES + 1;
    const f = fixture(key, await encryptedPrefix(key, length), length);
    const state = await openRelicWithKey(f.id, f.fragment, f.deps);
    expect(state.kind).toBe('dead');
    if (state.kind === 'dead')
      expect(state.dead.code).toBe('large_open_cancelled');
    expect(f.bodyFetches).toBe(1);
    expect(f.confirmed).toBe(1);
  });

  test('historical versions require the same authenticated confirmation', async () => {
    const key = generateKey();
    const length = LARGE_OPEN_CONFIRM_BYTES + 1;
    const f = fixture(key, await encryptedPrefix(key, length), length);
    const bytes = new TextEncoder().encode('current');
    const current = {
      filename: 'current.txt',
      declaredMimetype: 'text/plain',
      content: contentFromBytes(bytes),
      document: { bytes, truncated: false },
      route: 'code' as const,
      downgradeNotice: undefined,
      shareUrl: f.deps.locationHref,
      version: 3,
      currentVersion: 3,
      versionDigest: '0'.repeat(64),
    };
    const fetch: typeof globalThis.fetch = (async (input, init) => {
      if (String(input).endsWith('/mint')) {
        return Response.json({
          url: 'https://storage.example/object',
          url_expires_at: '2099-01-01T00:00:00Z',
          relic_expires_at: null,
          object_length: encryptedSize(length),
          object_crc32c: 'AAAAAA==',
          mints_remaining: 199,
          version: 2,
          current_version: 3,
        });
      }
      return f.deps.fetch(input, init);
    }) as typeof globalThis.fetch;
    const state = await loadHistoricalVersion(f.id, 2, current, {
      ...f.deps,
      fetch,
    });
    expect(state.kind === 'unavailable' && state.code).toBe(
      'large_open_cancelled'
    );
    expect(f.confirmed).toBe(1);
    expect(f.bodyFetches).toBe(1);
  });

  test('a wrong key cannot reveal the filename or length', async () => {
    const key = generateKey();
    const length = LARGE_OPEN_CONFIRM_BYTES + 1;
    const f = fixture(key, await encryptedPrefix(key, length), length);
    const state = await load(f.id, {
      ...f.deps,
      takeFragment: () => encodeFragment(generateKey()),
    });
    expect(state.kind).toBe('dead');
    if (state.kind === 'dead') {
      expect(state.dead.code).toBe('decrypt_failed');
      expect(state.cachedPrefix).toBeDefined();
    }
    expect(f.confirmed).toBe(0);
    expect(f.cancelled).toBe(true);
    expect(f.bodyFetches).toBe(1);
  });

  test('an authenticated length over the cap raises the invariant alarm, not a confirmation', async () => {
    const key = generateKey();
    const length = PLAINTEXT_CAP_BYTES + 1;
    const f = fixture(key, await encryptedPrefix(key, length), length);
    const state = await load(f.id, f.deps);
    expect(state.kind).toBe('dead');
    if (state.kind === 'dead') expect(state.dead.code).toBe('too_large');
    expect(f.confirmed).toBe(0);
    expect(f.bodyFetches).toBe(1);
  });

  test('the ciphertext digest binds the exact authenticated bytes', async () => {
    const key = generateKey();
    const id = generateRelicId();
    const fragment = encodeFragment(key);
    const plaintext = new TextEncoder().encode('a real version\n');
    const ciphertext = await encryptRelic({
      content: plaintext,
      filename: 'notes.txt',
      mimetype: 'text/plain',
      key,
    });
    const f = fixture(key, ciphertext, plaintext.length);
    const state = await load(id, {
      ...f.deps,
      takeFragment: () => fragment,
      fetch: (async (input) =>
        String(input).endsWith('/mint')
          ? Response.json({
              url: 'https://storage.example/object',
              url_expires_at: '2099-01-01T00:00:00Z',
              relic_expires_at: null,
              object_length: ciphertext.length,
              object_crc32c: 'AAAAAA==',
              mints_remaining: 199,
              version: 1,
              current_version: 1,
            })
          : new Response(ciphertext as unknown as BodyInit)) as typeof fetch,
    });
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.view.versionDigest).toBe(sha256Hex(ciphertext));
    expect(
      new Uint8Array(await state.view.content.blob('').arrayBuffer())
    ).toEqual(plaintext);
  });

  test('bounded routing matches byte routing across representative formats', async () => {
    for (const [filename, mimetype, bytes] of [
      ['notes.md', 'text/markdown', new TextEncoder().encode('# notes\n')],
      ['page.html', 'text/html', new TextEncoder().encode('<p>hello</p>')],
      [
        'component.jsx',
        'text/jsx',
        new TextEncoder().encode(
          'export default function App() { return <p>hello</p>; }'
        ),
      ],
      [
        'photo.png',
        'image/png',
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]),
      ],
      [
        'wrong.png',
        'image/png',
        new TextEncoder().encode('<p>not an image</p>'),
      ],
    ] as const) {
      const expected = await routeFor(filename, mimetype, bytes);
      const actual = await routeContent(
        filename,
        mimetype,
        contentFromBytes(bytes)
      );
      expect({ route: actual.route, notice: actual.notice }).toEqual({
        route: expected.route,
        notice: expected.notice,
      });
      expect(actual.componentModule).toEqual(expected.componentModule);
    }
  });

  test('large text keeps the whole source available without materializing a document', async () => {
    const chunk = new Blob([
      new Uint8Array(1024 * 1024).fill(0x61) as BlobPart,
    ]);
    const content = await contentFromBlob(
      new Blob([...Array(101).fill(chunk), 'end'])
    );
    const route = await routeContent('large.txt', 'text/plain', content);
    expect(route.route).toBe('code');
    expect(route.document).toBeUndefined();
    expect(
      new TextDecoder().decode(
        await content.read(content.size - 3, content.size)
      )
    ).toBe('end');
  });
});
