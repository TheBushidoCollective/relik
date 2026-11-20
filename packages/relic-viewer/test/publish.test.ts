import { beforeEach, describe, expect, test } from 'bun:test';
import {
  deriveShareProof,
  parseFragment,
  shareVerifierFor,
} from '@relic/format';
import {
  type AppOptions,
  createApp,
  type RelicApp,
} from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import {
  BROWSER_PUBLISH_LIMIT_BYTES,
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
/** Every request the page made to the service, as path and raw body. */
let sent: Array<{ path: string; body: string }>;
/** What the fake upload leg does: store faithfully, answer a status, throw, or corrupt. */
let uploadMode: number | 'throw' | 'corrupt';

function build(config: AppOptions = {}): void {
  storage = new MemoryStorage();
  sent = [];
  uploadMode = 200;
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
      if (uploadMode === 'throw') throw new Error('network down');
      onProgress(body.length, body.length);
      const status = typeof uploadMode === 'number' ? uploadMode : 200;
      if (status >= 200 && status < 300) {
        const id = new URL(url).pathname
          .split('/')
          .filter(Boolean)[1] as string;
        // A byte flipped in transit, which only the digest check can see.
        storage.put(
          id,
          uploadMode === 'corrupt' ? body.map((b) => b ^ 1) : body
        );
      }
      return status;
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

const defaults = { title: '' };

beforeEach(() => build());

describe('publishing from the page', () => {
  test('a published file opens in the viewer with its content and name intact', async () => {
    const content = utf8('# Quarterly notes\n\nA paragraph.');
    const phases: PublishPhase['kind'][] = [];

    const result = await publishFile(
      source('notes.md', content),
      { title: 'notes.md' },
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
    const read = await state.view.content.readWhole(1024 * 1024);
    expect([...(read ?? [])]).toEqual([...content]);
  });

  test('the key never crosses, and the filename crosses only as the title the publisher kept', async () => {
    const result = await publishFile(
      source('payroll-2026.csv', utf8('name,amount\nA,1')),
      defaults,
      publishDeps()
    );

    const encodedKey = new URL(result.url).hash.slice(1 + 'r1'.length);
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(request.body).not.toContain(encodedKey);
      // Cleared title: the name is nowhere in what was sent.
      expect(request.body).not.toContain('payroll');
    }
    const row = await app.store.getRelic(result.relicId);
    expect(row?.title).toBeUndefined();
    expect(result.title).toBeUndefined();
    expect(row?.publishingClient).toBe('relik-web');

    // The same file with the title kept does send the name, and says so.
    build();
    const kept = await publishFile(
      source('payroll-2026.csv', utf8('name,amount\nA,1')),
      { title: 'payroll-2026.csv' },
      publishDeps()
    );
    expect(kept.title).toBe('payroll-2026.csv');
    expect((await app.store.getRelic(kept.relicId))?.title).toBe(
      'payroll-2026.csv'
    );
  });

  test('a title the publisher typed is normalized and reported as what the service holds', async () => {
    const result = await publishFile(
      source('a.txt', utf8('a')),
      { title: '  Q3 \n  numbers\u202e  ' },
      publishDeps()
    );

    expect(result.title).toBe('Q3 numbers');
    expect((await app.store.getRelic(result.relicId))?.title).toBe(
      'Q3 numbers'
    );
  });

  test('registers the share verifier for the key it drew, so readers can share the link', async () => {
    const result = await publishFile(
      source('a.txt', utf8('a')),
      defaults,
      publishDeps()
    );

    const { key } = parseFragment(new URL(result.url).hash);
    const expected = await shareVerifierFor(await deriveShareProof(key));
    expect((await app.store.getRelic(result.relicId))?.shareVerifier).toBe(
      expected
    );
  });

  test('a file over the page ceiling is refused before it is read, naming what the agent can do', async () => {
    let reads = 0;
    const huge: PublishSource = {
      name: 'big.bin',
      size: BROWSER_PUBLISH_LIMIT_BYTES + 1,
      read: async () => {
        reads += 1;
        return new Uint8Array(0);
      },
    };

    const failure = await publishFile(huge, defaults, publishDeps()).catch(
      (e) => e
    );

    expect(failure).toBeInstanceOf(PublishFailure);
    expect(failure.code).toBe('size_over_cap');
    expect(failure.message).toContain('This page publishes files up to');
    expect(failure.message).toContain('your coding agent can publish up to');
    expect(reads).toBe(0);
    expect(sent.map((r) => r.path)).toEqual(['/api/challenge']);
  });

  test('a service limit below the page ceiling is the one that binds', async () => {
    build({ config: { plaintextCapBytes: 1024 } });

    const failure = await publishFile(
      source('a.bin', new Uint8Array(2048)),
      defaults,
      publishDeps()
    ).catch((e) => e);

    expect(failure.code).toBe('size_over_cap');
    expect(failure.details['size_limit_bytes']).toBe(1024);
    expect(failure.message).not.toContain('coding agent');
  });

  test('an unreadable source, such as a dropped folder, is refused before any grant', async () => {
    const folder: PublishSource = {
      name: 'reports',
      size: 0,
      read: async () => {
        throw new Error('NotFoundError');
      },
    };

    const failure = await publishFile(folder, defaults, publishDeps()).catch(
      (e) => e
    );

    expect(failure.code).toBe('source_unreadable');
    expect(failure.message).toContain('folder');
    expect(sent.map((r) => r.path)).not.toContain('/api/grant');
  });

  test('a rate limit says when to come back', async () => {
    build({ config: { publishRateLimit: { limit: 1, windowSeconds: 3600 } } });

    const failure = await publishFile(
      source('a.txt', utf8('a')),
      defaults,
      publishDeps()
    ).catch((e) => e);

    expect(failure.code).toBe('publish_rate_limited');
    expect(failure.message).toMatch(/Try again in \d+ minutes/);
  });

  test('the kill switch reads as paused, not as a failure of the file', async () => {
    build({ config: { killSwitchEngaged: true } });

    const failure = await publishFile(
      source('a.txt', utf8('a')),
      defaults,
      publishDeps()
    ).catch((e) => e);

    expect(failure.code).toBe('service_paused');
  });

  test('a storage refusal is reported and never marked complete', async () => {
    uploadMode = 403;

    const failure = await publishFile(
      source('a.txt', utf8('a')),
      defaults,
      publishDeps()
    ).catch((e) => e);

    expect(failure.code).toBe('upload_failed');
    expect(failure.details['storage_status']).toBe(403);
    expect(sent.some((r) => r.path.endsWith('/complete'))).toBe(false);
  });

  test('a dropped connection mid-upload says nothing was published', async () => {
    uploadMode = 'throw';

    const failure = await publishFile(
      source('a.txt', utf8('a')),
      defaults,
      publishDeps()
    ).catch((e) => e);

    expect(failure.code).toBe('upload_failed');
    expect(failure.message).toContain('Nothing was published');
    expect(sent.some((r) => r.path.endsWith('/complete'))).toBe(false);
  });

  test('a copy altered in transit is caught by the digest, and no link is handed out', async () => {
    uploadMode = 'corrupt';

    const failure = await publishFile(
      source('a.txt', utf8('some bytes')),
      defaults,
      publishDeps()
    ).catch((e) => e);

    expect(failure).toBeInstanceOf(PublishFailure);
    expect(failure.code).toBe('digest_mismatch');
  });

  test('an empty file publishes and opens as an empty relic', async () => {
    const result = await publishFile(
      source('empty.txt', new Uint8Array(0)),
      defaults,
      publishDeps()
    );
    expect(result.rendererClass).toBe('binary');

    const state = await load(
      result.relicId,
      viewerDeps(new URL(result.url).hash)
    );
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.view.content.size).toBe(0);
  });
});
