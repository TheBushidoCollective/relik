import { beforeEach, describe, expect, test } from 'bun:test';
import { parseFragment } from '@relic/format';
import {
  type AppOptions,
  createApp,
  type RelicApp,
} from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import {
  type PublishDeps,
  PublishFailure,
  type PublishPhase,
  type PublishSource,
  publishFile,
} from '../src/publish.ts';
import { load, type ViewerDeps } from '../src/viewer.ts';

const SERVICE = 'https://relic.example';
const utf8 = (text: string) => new TextEncoder().encode(text);

let storage: MemoryStorage;
let app: RelicApp;
let sent: Array<{ path: string; body: string }>;
/** Storage statuses the fake upload leg answers with, one per upload. */
let uploadStatus: number | 'throw';

function build(config: AppOptions = {}): void {
  storage = new MemoryStorage();
  sent = [];
  uploadStatus = 200;
  app = createApp({
    store: new MemoryStore(),
    storage,
    now: () => Date.parse('2026-08-02T12:00:00.000Z'),
    ...config,
  });
}

function publishDeps(): PublishDeps {
  return {
    serviceOrigin: SERVICE,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      sent.push({ path: url.pathname, body: String(init?.body ?? '') });
      const headers = new Headers(init?.headers);
      headers.set('x-forwarded-for', '203.0.113.5');
      return app.fetch(new Request(url.toString(), { ...init, headers }));
    }) as typeof globalThis.fetch,
    upload: async (url, body, onProgress) => {
      if (uploadStatus === 'throw') throw new Error('network down');
      onProgress(body.length, body.length);
      if (uploadStatus >= 200 && uploadStatus < 300) {
        const id = new URL(url).pathname
          .split('/')
          .filter(Boolean)[1] as string;
        storage.put(id, body);
      }
      return uploadStatus;
    },
  };
}

function viewerDeps(fragment: string): ViewerDeps {
  return {
    serviceOrigin: SERVICE,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === SERVICE) {
        const headers = new Headers(init?.headers);
        headers.set('x-forwarded-for', '198.51.100.20');
        return app.fetch(new Request(url.toString(), { ...init, headers }));
      }
      const id = url.pathname.split('/').filter(Boolean)[1] as string;
      const bytes = await storage.read(id);
      return bytes === undefined
        ? new Response(null, { status: 404 })
        : new Response(bytes as unknown as BodyInit);
    }) as typeof globalThis.fetch,
    keyVault: { remember() {}, recall: () => undefined, forget() {} },
    takeFragment: () => fragment,
    stripFragment() {},
    locationHref: `${SERVICE}/x`,
  };
}

function source(name: string, content: Uint8Array): PublishSource {
  return { name, size: content.length, read: async () => content };
}

beforeEach(() => build());

describe('publishing from the page', () => {
  test('a published file opens in the viewer with its content and name intact', async () => {
    const content = utf8('# Quarterly notes\n\nA paragraph.');
    const phases: PublishPhase['kind'][] = [];

    const result = await publishFile(
      source('notes.md', content),
      publishDeps(),
      (phase) => phases.push(phase.kind)
    );

    expect(result.url.startsWith(`${SERVICE}/${result.relicId}#`)).toBe(true);
    expect(result.rendererClass).toBe('markdown');
    expect(result.relicExpiresAt).toBeNull();
    expect(phases).toEqual([
      'preparing',
      'encrypting',
      'uploading',
      'finishing',
    ]);

    const state = await load(
      result.relicId,
      viewerDeps(new URL(result.url).hash)
    );
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.view.filename).toBe('notes.md');
    expect(state.view.declaredMimetype).toBe('text/markdown');
    expect([...state.view.content]).toEqual([...content]);
  });

  test('no request to the service carries the key or the filename', async () => {
    const result = await publishFile(
      source('payroll-2026.csv', utf8('name,amount\nA,1')),
      publishDeps()
    );

    const { key } = parseFragment(new URL(result.url).hash);
    const encodedKey = new URL(result.url).hash.slice(1 + 'r1'.length);
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(request.body).not.toContain(encodedKey);
      expect(request.body).not.toContain('payroll');
      expect(request.body).not.toContain(String.fromCharCode(...key));
    }
    // The service recorded the coarse class and the client name, which the
    // disclosure says it keeps, and nothing finer.
    const row = await app.store.getRelic(result.relicId);
    expect(row?.rendererClass).toBe('code');
    expect(row?.publishingClient).toBe('relik-web');
  });

  test('a file over the cap is refused with the server number, and never read', async () => {
    let reads = 0;
    const huge: PublishSource = {
      name: 'big.bin',
      size: 101 * 1024 * 1024,
      read: async () => {
        reads += 1;
        return new Uint8Array(0);
      },
    };

    const failure = await publishFile(huge, publishDeps()).catch((e) => e);

    expect(failure).toBeInstanceOf(PublishFailure);
    expect(failure.code).toBe('size_over_cap');
    expect(failure.message).toContain('The limit is 100.0 MB');
    expect(reads).toBe(0);
    expect(sent.map((r) => r.path)).toEqual(['/api/challenge']);
  });

  test('an unreadable source, such as a dropped folder, is refused before any grant', async () => {
    const folder: PublishSource = {
      name: 'reports',
      size: 0,
      read: async () => {
        throw new Error('NotFoundError');
      },
    };

    const failure = await publishFile(folder, publishDeps()).catch((e) => e);

    expect(failure.code).toBe('source_unreadable');
    expect(failure.message).toContain('folder');
    expect(sent.map((r) => r.path)).not.toContain('/api/grant');
  });

  test('a rate limit says when to come back', async () => {
    build({ config: { publishRateLimit: { limit: 1, windowSeconds: 3600 } } });

    const failure = await publishFile(
      source('a.txt', utf8('a')),
      publishDeps()
    ).catch((e) => e);

    expect(failure.code).toBe('publish_rate_limited');
    expect(failure.message).toMatch(/Try again in \d+ minutes/);
  });

  test('the kill switch reads as paused, not as a failure of the file', async () => {
    build({ config: { killSwitchEngaged: true } });

    const failure = await publishFile(
      source('a.txt', utf8('a')),
      publishDeps()
    ).catch((e) => e);

    expect(failure.code).toBe('service_paused');
  });

  test('a storage refusal is reported and never marked complete', async () => {
    uploadStatus = 403;

    const failure = await publishFile(
      source('a.txt', utf8('a')),
      publishDeps()
    ).catch((e) => e);

    expect(failure.code).toBe('upload_failed');
    expect(failure.details['storage_status']).toBe(403);
    expect(sent.some((r) => r.path.endsWith('/complete'))).toBe(false);
  });

  test('a dropped connection mid-upload says nothing was published', async () => {
    uploadStatus = 'throw';

    const failure = await publishFile(
      source('a.txt', utf8('a')),
      publishDeps()
    ).catch((e) => e);

    expect(failure.code).toBe('upload_failed');
    expect(failure.message).toContain('Nothing was published');
    expect(sent.some((r) => r.path.endsWith('/complete'))).toBe(false);
  });

  test('an empty file publishes and opens as an empty relic', async () => {
    const result = await publishFile(
      source('empty.txt', new Uint8Array(0)),
      publishDeps()
    );
    expect(result.rendererClass).toBe('binary');

    const state = await load(
      result.relicId,
      viewerDeps(new URL(result.url).hash)
    );
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.view.content.length).toBe(0);
  });
});
