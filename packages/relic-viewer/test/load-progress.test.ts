import { describe, expect, test } from 'bun:test';
import {
  encryptRelic,
  encodeFragment,
  generateKey,
  RECORD_SIZE,
  recordCapacity,
  HEADER_BYTES,
} from '@relic/format';
import {
  formatBytes,
  formatTransfer,
  load,
  loadHistoricalVersion,
  openRelicWithKey,
  progressLine,
  type LoadProgress,
  type ViewerDeps,
  type MintResponse,
} from '../src/viewer.ts';

const CAPACITY = recordCapacity(RECORD_SIZE);

function bytes(length: number, seed = 42): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[index] = state & 0xff;
  }
  return out;
}

function makeMockVault() {
  const map = new Map<string, string>();
  return {
    remember: (id: string, frag: string) => map.set(id, frag),
    recall: (id: string) => map.get(id),
    forget: (id: string) => map.delete(id),
    lookup: (id: string) => map.get(id),
  };
}

describe('Spec B: Viewer load progress and early key check', () => {
  test('formatBytes and formatTransfer give decimal values; progressLine gives C2 forms', () => {
    // Rule 10: below 1000 prints '999 B'; otherwise one decimal place in KB, MB, GB by powers of 1000
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1236)).toBe('1.2 KB');
    expect(formatBytes(104_857_600)).toBe('104.9 MB');
    expect(formatBytes(105_298_736)).toBe('105.3 MB');
    expect(formatBytes(2_500_000_000)).toBe('2.5 GB');

    // formatTransfer(r, t) prints r in t's unit
    expect(formatTransfer(41_200_000, 105_300_000)).toBe('41.2 of 105.3 MB');
    expect(formatTransfer(600_000, 105_300_000)).toBe('0.6 of 105.3 MB');
    expect(formatTransfer(500, 800)).toBe('500 of 800 B');
    expect(formatTransfer(500, 1200)).toBe('0.5 of 1.2 KB');

    // progressLine C2 forms
    expect(progressLine({ phase: 'opening' })).toBe('Opening…');
    expect(
      progressLine({
        phase: 'fetching',
        received: 41_200_000,
        total: 105_300_000,
      })
    ).toBe('Fetching 41.2 of 105.3 MB');
    expect(
      progressLine({
        phase: 'decrypting',
        opened: 98_100_000,
        contents: { filename: 'file.bin', length: 104_900_000 },
      })
    ).toBe('Decrypting 98.1 of 104.9 MB');
  });

  test('secureContext: () => false gives insecure_context with zero fetch calls', async () => {
    let fetchCalls = 0;
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: 'https://relic.example/r1#r1ABC',
      fetch: (async () => {
        fetchCalls++;
        return new Response('');
      }) as unknown as typeof globalThis.fetch,
      keyVault: makeMockVault(),
      secureContext: () => false,
    };

    const res = await load('r1', deps);
    expect(res.kind).toBe('dead');
    if (res.kind === 'dead') {
      expect(res.dead.code).toBe('insecure_context');
      expect(res.dead.action).toBe('none');
      expect(res.dead.headline).toBe(
        'This page did not arrive over a secure connection'
      );
      expect(res.dead.detail).toContain('hotel network');
    }
    expect(fetchCalls).toBe(0);
  });

  test('phases arrive in order; fetching total === object_length; distinct received; contents appears only after record 0', async () => {
    // 3 content records
    const content = bytes(CAPACITY * 2 + 100);
    const key = generateKey();
    const fragment = encodeFragment(key);
    const container = await encryptRelic({
      content,
      filename: 'report.txt',
      mimetype: 'text/plain',
      key,
    });

    const mintResp: MintResponse = {
      url: 'https://storage.example/blob',
      url_expires_at: new Date(Date.now() + 300_000).toISOString(),
      relic_expires_at: null,
      object_length: container.length,
      object_crc32c: '0',
      mints_remaining: 5,
      version: 1,
      current_version: 1,
    };

    const chunkSize = 16 * 1024;
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: `https://relic.example/r1#${fragment}`,
      keyVault: makeMockVault(),
      fetch: (async (input) => {
        const url = String(input);
        if (url.endsWith('/mint')) {
          return Response.json(mintResp);
        }
        if (url.includes('/blob')) {
          let offset = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset >= container.length) {
                controller.close();
                return;
              }
              const end = Math.min(offset + chunkSize, container.length);
              controller.enqueue(container.slice(offset, end));
              offset = end;
            },
          });
          return new Response(body);
        }
        return new Response('', { status: 404 });
      }) as typeof globalThis.fetch,
    };

    const events: LoadProgress[] = [];
    const res = await load('r1', deps, (p) => {
      events.push(p);
    });

    expect(res.kind).toBe('ready');

    // 1. opening is first
    expect(events[0]?.phase).toBe('opening');

    // 2. fetching events follow
    const fetchingEvents = events.filter((e) => e.phase === 'fetching') as Array<{
      phase: 'fetching';
      received: number;
      total: number;
      contents?: { filename: string; length: number };
    }>;
    expect(fetchingEvents.length).toBeGreaterThanOrEqual(3);

    for (const f of fetchingEvents) {
      expect(f.total).toBe(container.length);
    }

    const distinctReceived = new Set(fetchingEvents.map((f) => f.received));
    expect(distinctReceived.size).toBeGreaterThanOrEqual(3);

    // Before record 0 (first 65,557 bytes), contents must be undefined
    const beforeRecord0 = fetchingEvents.filter((f) => f.received < HEADER_BYTES + RECORD_SIZE);
    for (const f of beforeRecord0) {
      expect(f.contents).toBeUndefined();
    }

    // After record 0, contents must be present
    const afterRecord0 = fetchingEvents.filter((f) => f.received >= HEADER_BYTES + RECORD_SIZE);
    expect(afterRecord0.length).toBeGreaterThan(0);
    for (const f of afterRecord0) {
      expect(f.contents).toBeDefined();
      expect(f.contents?.filename).toBe('report.txt');
    }
  });

  test('wrong key on large object: dead decrypt_failed; cancels after prefix; cachedPrefix.prefix.length === 65_557', async () => {
    // 5 MB object
    const content = bytes(5 * 1024 * 1024);
    const rightKey = generateKey();
    const wrongKey = generateKey();
    const wrongFragment = encodeFragment(wrongKey);

    const container = await encryptRelic({
      content,
      filename: 'large.bin',
      mimetype: 'application/octet-stream',
      key: rightKey,
    });

    let pulledBytes = 0;
    let cancels = 0;
    const chunkSize = 16 * 1024;

    const mintResp: MintResponse = {
      url: 'https://storage.example/blob',
      url_expires_at: new Date(Date.now() + 300_000).toISOString(),
      relic_expires_at: null,
      object_length: container.length,
      object_crc32c: '0',
      mints_remaining: 5,
      version: 1,
      current_version: 1,
    };

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: `https://relic.example/r1#${wrongFragment}`,
      keyVault: makeMockVault(),
      fetch: (async (input) => {
        const url = String(input);
        if (url.endsWith('/mint')) return Response.json(mintResp);
        if (url.includes('/blob')) {
          let offset = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset >= container.length) {
                controller.close();
                return;
              }
              pulledBytes += Math.min(chunkSize, container.length - offset);
              const end = Math.min(offset + chunkSize, container.length);
              controller.enqueue(container.slice(offset, end));
              offset = end;
            },
            cancel() {
              cancels++;
            },
          });
          return new Response(body);
        }
        return new Response('', { status: 404 });
      }) as typeof globalThis.fetch,
    };

    const res = await load('r1', deps);
    expect(res.kind).toBe('dead');
    if (res.kind === 'dead') {
      expect(res.dead.code).toBe('decrypt_failed');
      expect(res.dead.action).toBe('reopen-original-link');
      expect(res.cachedPrefix).toBeDefined();
      expect(res.cachedPrefix?.prefix.length).toBe(HEADER_BYTES + RECORD_SIZE); // 65,557
    }

    expect(cancels).toBe(1);
    // At most 65,557 bytes plus one chunk pulled (5 chunks to reach 65,557 + 1 pre-pulled chunk = 6 chunks):
    const maxExpectedBytes = (Math.ceil(65_557 / chunkSize) + 1) * chunkSize;
    expect(pulledBytes).toBeLessThanOrEqual(maxExpectedBytes);
  });

  test('mint fetch rejecting gives dead service_unreachable with action retry and resume.fragment; load never throws', async () => {
    const key = generateKey();
    const fragment = encodeFragment(key);
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: `https://relic.example/r1#${fragment}`,
      keyVault: makeMockVault(),
      fetch: (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof globalThis.fetch,
    };

    const res = await load('r1', deps);
    expect(res.kind).toBe('dead');
    if (res.kind === 'dead') {
      expect(res.dead.code).toBe('service_unreachable');
      expect(res.dead.action).toBe('retry');
      expect(res.resume?.fragment).toBe(fragment);
    }
  });

  test('storage body erroring mid-stream gives truncated_transfer with resume', async () => {
    const content = bytes(CAPACITY * 2);
    const key = generateKey();
    const fragment = encodeFragment(key);
    const container = await encryptRelic({
      content,
      filename: 'mid.txt',
      mimetype: 'text/plain',
      key,
    });

    const mintResp: MintResponse = {
      url: 'https://storage.example/blob',
      url_expires_at: new Date(Date.now() + 300_000).toISOString(),
      relic_expires_at: null,
      object_length: container.length,
      object_crc32c: '0',
      mints_remaining: 5,
      version: 1,
      current_version: 1,
    };

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: `https://relic.example/r1#${fragment}`,
      keyVault: makeMockVault(),
      fetch: (async (input) => {
        const url = String(input);
        if (url.endsWith('/mint')) return Response.json(mintResp);
        if (url.includes('/blob')) {
          let count = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (count === 0) {
                count++;
                controller.enqueue(container.slice(0, 16 * 1024));
              } else {
                controller.error(new Error('network disconnect'));
              }
            },
          });
          return new Response(body);
        }
        return new Response('', { status: 404 });
      }) as typeof globalThis.fetch,
    };

    const res = await load('r1', deps);
    expect(res.kind).toBe('dead');
    if (res.kind === 'dead') {
      expect(res.dead.code).toBe('truncated_transfer');
      expect(res.dead.action).toBe('retry');
      expect(res.resume).toBeDefined();
      expect(res.resume?.fragment).toBe(fragment);
    }
  });

  test('byte flipped in record 2 gives content_damaged, action retry-report, resume present, vault key kept', async () => {
    const content = bytes(CAPACITY * 3);
    const key = generateKey();
    const fragment = encodeFragment(key);
    const container = await encryptRelic({
      content,
      filename: 'damaged.txt',
      mimetype: 'text/plain',
      key,
    });

    // Flip byte in record 2
    const tampered = new Uint8Array(container);
    tampered[HEADER_BYTES + 2 * RECORD_SIZE + 10] = (tampered[HEADER_BYTES + 2 * RECORD_SIZE + 10]! ^ 0xff);

    const vault = makeMockVault();
    vault.remember('r1', fragment);

    const mintResp: MintResponse = {
      url: 'https://storage.example/blob',
      url_expires_at: new Date(Date.now() + 300_000).toISOString(),
      relic_expires_at: null,
      object_length: tampered.length,
      object_crc32c: '0',
      mints_remaining: 5,
      version: 1,
      current_version: 1,
    };

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: 'https://relic.example/r1', // no fragment in URL, loads from vault
      keyVault: vault,
      fetch: (async (input) => {
        const url = String(input);
        if (url.endsWith('/mint')) return Response.json(mintResp);
        if (url.includes('/blob')) return new Response(tampered);
        return new Response('', { status: 404 });
      }) as typeof globalThis.fetch,
    };

    const res = await load('r1', deps);
    expect(res.kind).toBe('dead');
    if (res.kind === 'dead') {
      expect(res.dead.code).toBe('content_damaged');
      expect(res.dead.action).toBe('retry-report');
      expect(res.dead.headline).toBe('The stored file is damaged');
      expect(res.dead.detail).toContain('start of the file decrypted with this link, so the link is fine');
      expect(res.resume).toBeDefined();
      expect(res.resume?.fragment).toBe(fragment);
    }
    // Key in vault must NOT be forgotten:
    expect(vault.recall('r1')).toBe(fragment);
  });

  test('stored object missing its final record with mint object_length matching stored gives content_damaged', async () => {
    const content = bytes(CAPACITY * 3);
    const key = generateKey();
    const fragment = encodeFragment(key);
    const container = await encryptRelic({
      content,
      filename: 'cut.txt',
      mimetype: 'text/plain',
      key,
    });

    // Remove final record
    const cutContainer = container.slice(0, container.length - RECORD_SIZE);

    const mintResp: MintResponse = {
      url: 'https://storage.example/blob',
      url_expires_at: new Date(Date.now() + 300_000).toISOString(),
      relic_expires_at: null,
      object_length: cutContainer.length,
      object_crc32c: '0',
      mints_remaining: 5,
      version: 1,
      current_version: 1,
    };

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: `https://relic.example/r1#${fragment}`,
      keyVault: makeMockVault(),
      fetch: (async (input) => {
        const url = String(input);
        if (url.endsWith('/mint')) return Response.json(mintResp);
        if (url.includes('/blob')) return new Response(cutContainer);
        return new Response('', { status: 404 });
      }) as typeof globalThis.fetch,
    };

    const res = await load('r1', deps);
    expect(res.kind).toBe('dead');
    if (res.kind === 'dead') {
      expect(res.dead.code).toBe('content_damaged');
      expect(res.dead.action).toBe('retry-report');
    }
  });

  test('openRelicWithKey: cachedPrefix wrong key makes 0 fetch calls; right key reuses valid URL or mints if expired', async () => {
    const content = bytes(100);
    const rightKey = generateKey();
    const wrongKey = generateKey();
    const container = await encryptRelic({
      content,
      filename: 'key-test.txt',
      mimetype: 'text/plain',
      key: rightKey,
    });

    const prefix = container.slice(0, HEADER_BYTES + RECORD_SIZE);

    let fetchCount = 0;
    let mintCount = 0;
    let storageCount = 0;

    const validMint: MintResponse = {
      url: 'https://storage.example/blob',
      url_expires_at: new Date(Date.now() + 300_000).toISOString(),
      relic_expires_at: null,
      object_length: container.length,
      object_crc32c: '0',
      mints_remaining: 5,
      version: 1,
      current_version: 1,
    };

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: 'https://relic.example/r1',
      keyVault: makeMockVault(),
      fetch: (async (input: RequestInfo | URL) => {
        fetchCount++;
        const url = String(input);
        if (url.endsWith('/mint')) {
          mintCount++;
          return Response.json(validMint);
        }
        if (url.includes('/blob')) {
          storageCount++;
          return new Response(container as unknown as BodyInit);
        }
        return new Response('', { status: 404 });
      }) as unknown as typeof globalThis.fetch,
    };

    // 1. Wrong key with cachedPrefix -> 0 fetch calls
    const resWrong = await openRelicWithKey('r1', encodeFragment(wrongKey), deps, {
      prefix,
      mint: validMint,
    });
    expect(resWrong.kind).toBe('wrong_key');
    expect(fetchCount).toBe(0);

    // 2. Right key with valid cachedPrefix URL -> exactly 1 storage GET, 0 mints
    const resRight = await openRelicWithKey('r1', encodeFragment(rightKey), deps, {
      prefix,
      mint: validMint,
    });
    expect(resRight.kind).toBe('ready');
    expect(mintCount).toBe(0);
    expect(storageCount).toBe(1);

    // 3. Right key with expired cachedPrefix URL -> 1 mint + 1 storage GET
    const expiredMint: MintResponse = {
      ...validMint,
      url_expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    mintCount = 0;
    storageCount = 0;
    const resExpired = await openRelicWithKey('r1', encodeFragment(rightKey), deps, {
      prefix,
      mint: expiredMint,
    });
    expect(resExpired.kind).toBe('ready');
    expect(mintCount).toBe(1);
    expect(storageCount).toBe(1);
  });

  test('openRelicWithKey: without cachedPrefix, record-0 failure returns wrong_key with cachedPrefix', async () => {
    const content = bytes(100);
    const rightKey = generateKey();
    const wrongKey = generateKey();
    const container = await encryptRelic({
      content,
      filename: 'key-test-2.txt',
      mimetype: 'text/plain',
      key: rightKey,
    });

    const validMint: MintResponse = {
      url: 'https://storage.example/blob',
      url_expires_at: new Date(Date.now() + 300_000).toISOString(),
      relic_expires_at: null,
      object_length: container.length,
      object_crc32c: '0',
      mints_remaining: 5,
      version: 1,
      current_version: 1,
    };

    let fetchCount = 0;
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: 'https://relic.example/r1',
      keyVault: makeMockVault(),
      fetch: (async (input: RequestInfo | URL) => {
        fetchCount++;
        const url = String(input);
        if (url.endsWith('/mint')) return Response.json(validMint);
        if (url.includes('/blob')) return new Response(container as unknown as BodyInit);
        return new Response('', { status: 404 });
      }) as unknown as typeof globalThis.fetch,
    };

    const res1 = await openRelicWithKey('r1', encodeFragment(wrongKey), deps);
    expect(res1.kind).toBe('wrong_key');
    if (res1.kind === 'wrong_key') {
      expect(res1.cachedPrefix).toBeDefined();
      expect(res1.cachedPrefix?.prefix.length).toBe(HEADER_BYTES + RECORD_SIZE);

      // Now pass it back with another wrong key -> 0 fetches!
      const initialFetches = fetchCount;
      const res2 = await openRelicWithKey('r1', encodeFragment(generateKey()), deps, res1.cachedPrefix);
      expect(res2.kind).toBe('wrong_key');
      expect(fetchCount).toBe(initialFetches);
    }
  });

  test('load with resume skips takeFragment, stripFragment, and reuses valid mint URL', async () => {
    const content = bytes(100);
    const key = generateKey();
    const fragment = encodeFragment(key);
    const container = await encryptRelic({
      content,
      filename: 'resume.txt',
      mimetype: 'text/plain',
      key,
    });

    const mintResp: MintResponse = {
      url: 'https://storage.example/blob',
      url_expires_at: new Date(Date.now() + 300_000).toISOString(),
      relic_expires_at: null,
      object_length: container.length,
      object_crc32c: '0',
      mints_remaining: 5,
      version: 1,
      current_version: 1,
    };

    let takeCalled = false;
    let stripCalled = false;
    let mintCalled = false;
    let storageCalled = false;

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: 'https://relic.example/r1',
      keyVault: makeMockVault(),
      takeFragment: () => {
        takeCalled = true;
        return '';
      },
      stripFragment: () => {
        stripCalled = true;
      },
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/mint')) {
          mintCalled = true;
          return Response.json(mintResp);
        }
        if (url.includes('/blob')) {
          storageCalled = true;
          return new Response(container as unknown as BodyInit);
        }
        return new Response('', { status: 404 });
      }) as unknown as typeof globalThis.fetch,
    };

    const res = await load('r1', deps, undefined, {
      fragment,
      mint: mintResp,
    });

    expect(res.kind).toBe('ready');
    expect(takeCalled).toBe(false);
    expect(stripCalled).toBe(false);
    expect(mintCalled).toBe(false);
    expect(storageCalled).toBe(true);
  });

  test('loadHistoricalVersion with onProgress reports against historical mint object_length', async () => {
    const content = bytes(100);
    const key = generateKey();
    const fragment = encodeFragment(key);
    const container = await encryptRelic({
      content,
      filename: 'v2.txt',
      mimetype: 'text/plain',
      key,
    });

    const mintResp: MintResponse = {
      url: 'https://storage.example/v2-blob',
      url_expires_at: new Date(Date.now() + 300_000).toISOString(),
      relic_expires_at: null,
      object_length: container.length,
      object_crc32c: '0',
      mints_remaining: 5,
      version: 2,
      current_version: 3,
    };

    const currentReady = {
      filename: 'v3.txt',
      declaredMimetype: 'text/plain',
      content: bytes(50),
      route: 'markdown' as const,
      downgradeNotice: undefined,
      shareUrl: `https://relic.example/r1#${fragment}`,
      version: 3,
      currentVersion: 3,
      versionDigest: '0'.repeat(64),
    };

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: 'https://relic.example/r1',
      keyVault: makeMockVault(),
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/mint')) return Response.json(mintResp);
        if (url.includes('/v2-blob')) return new Response(container as unknown as BodyInit);
        return new Response('', { status: 404 });
      }) as unknown as typeof globalThis.fetch,
    };

    const events: LoadProgress[] = [];
    const res = await loadHistoricalVersion('r1', 2, currentReady, deps, (p) => {
      events.push(p);
    });

    expect(res.kind).toBe('ready');
    const fetchingEvents = events.filter((e) => e.phase === 'fetching') as Array<{
      phase: 'fetching';
      received: number;
      total: number;
    }>;
    expect(fetchingEvents.length).toBeGreaterThan(0);
    for (const f of fetchingEvents) {
      expect(f.total).toBe(container.length);
    }
  });
});
