import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOtioDocument } from '@relic/format';
import { createApp, type RelicApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import {
  postComment,
  readComments,
  resolveComment,
  validateAndNormalizeAnchor,
} from '../src/comments.ts';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, PublishError, publish } from '../src/publish.ts';
import { republish } from '../src/republish.ts';
import { resolveAnchors } from '../src/resolve-anchor.ts';
import type { CommentRecord } from '../src/comments.ts';

const SERVICE = 'https://relic.example';

let scratch: string;
let storage: MemoryStorage;
let store: MemoryStore;
let app: RelicApp;
let deps: PublishDeps;
let mintBodies: unknown[];

function timeline(clipId: string, clipName: string): string {
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    name: 'Cut',
    metadata: { relic: { id: 'tl1' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'V1',
          kind: 'Video',
          metadata: { relic: { id: 'track-v1' } },
          children: [
            {
              OTIO_SCHEMA: 'Clip.1',
              name: clipName,
              metadata: { relic: { id: clipId } },
              source_range: {
                start_time: { value: 0, rate: 24 },
                duration: { value: 24, rate: 24 },
              },
              media_reference: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: 'media/shot.mov',
                available_range: {
                  start_time: { value: 10, rate: 24 },
                  duration: { value: 48, rate: 24 },
                },
              },
            },
          ],
        },
      ],
    },
  });
}

function shimFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    if (url.origin === SERVICE) {
      if (url.pathname.endsWith('/mint') && init?.body) {
        mintBodies.push(JSON.parse(String(init.body)));
      }
      const headers = new Headers(init?.headers);
      headers.set('x-forwarded-for', '198.51.100.10');
      return app.fetch(new Request(url.toString(), { ...init, headers }));
    }
    if (url.hostname === 'storage.invalid') {
      const key = url.pathname.replace(/^\/(?:upload|o)\//, '');
      if (init?.method === 'PUT') {
        storage.put(key, new Uint8Array(init.body as Uint8Array));
        return new Response(null, { status: 200 });
      }
      const bytes = await storage.read(key);
      if (bytes === undefined) return new Response(null, { status: 404 });
      return new Response(bytes as unknown as BodyInit, { status: 200 });
    }
    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-otio-feedback-'));
  process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'publish-state.json');
  storage = new MemoryStorage();
  store = new MemoryStore();
  app = createApp({ storage, store });
  mintBodies = [];
  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    fetch: shimFetch(),
    clientName: 'relic-mcp/otio-feedback-test',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test fake renderer',
    }),
  };
});

afterEach(async () => {
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(scratch, { recursive: true, force: true });
});

describe('OTIO comment anchors', () => {
  test('refuses a future otio anchor version instead of treating it as tamper', () => {
    let thrown: PublishError | undefined;
    try {
      validateAndNormalizeAnchor({
        kind: 'otio',
        v: 2,
        relic_version: 1,
        document_sha256: 'a'.repeat(64),
        timeline_id: 'tl1',
        track_id: null,
        range: {
          start_time: { value: 0, rate: 24 },
          duration: { value: 0, rate: 24 },
        },
        snapshot: { timeline: 'Cut', track: null, item: null },
      });
    } catch (error) {
      thrown = error as PublishError;
    }
    expect(thrown?.code).toBe('local_comment_anchor_unsupported');
    expect(thrown?.message).toContain('not treated as tampering');
  });

  test('a future otio version read back stays unsupported and is not fetched as tamper', async () => {
    let fetches = 0;
    const idle: PublishDeps = {
      ...deps,
      fetch: (async () => {
        fetches += 1;
        return new Response(null, { status: 500 });
      }) as typeof globalThis.fetch,
    };
    const comment = {
      comment_id: 'c1',
      author: 'publisher',
      created_at: '2026-10-20T00:00:00Z',
      display_name: null,
      body: 'hold this frame',
      anchor: { kind: 'unsupported', declared: 'otio-v9' },
      addresses: null,
      readable: true,
      unreadable_reason: null,
      addressed: false,
      addressed_by: null,
      version: 1,
      edited_at: null,
      resolution: null,
    } as CommentRecord;
    const resolved = await resolveAnchors('unused', [comment], idle);
    expect(fetches).toBe(0);
    expect(resolved.comments[0]?.body).toBe('hold this frame');
    expect(resolved.comments[0]?.resolved?.kind).toBe('unsupported');
    if (resolved.comments[0]?.resolved?.kind === 'unsupported') {
      expect(resolved.comments[0].resolved.explanation).toContain('not evidence');
      expect(resolved.comments[0].resolved.declared).toBe('otio-v9');
    }
  });

  test('version 1 source intervals survive after version 2, and the projection is separate', async () => {
    const v1Path = join(scratch, 'cut.otio');
    const v1Text = timeline('clip-a', 'Shot');
    await writeFile(v1Path, v1Text);
    const original = readOtioDocument(v1Text);
    const published = await publish({ path: v1Path, cover: false }, deps);

    const posted = await postComment(
      {
        relic_id: published.relic_id,
        body: 'The shot starts late.',
        anchor: {
          kind: 'otio',
          v: 1,
          relic_version: 1,
          document_sha256: original.document_sha256,
          timeline_id: 'tl1',
          track_id: 'track-v1',
          item_id: 'clip-a',
          range: {
            start_time: { value: 12, rate: 24 },
            duration: { value: 6, rate: 24 },
          },
          snapshot: { timeline: 'Cut', track: 'V1', item: 'Shot' },
        },
      },
      deps
    );
    await resolveComment(
      {
        relic_id: published.relic_id,
        comment_id: posted.comment_id,
        resolved: true,
      },
      deps
    );

    const v2Path = join(scratch, 'cut-v2.otio');
    await writeFile(v2Path, timeline('clip-b', 'Replacement'));
    const next = await republish(
      { relic_id: published.relic_id, path: v2Path, cover: false },
      deps
    );
    expect(next.version).toBe(2);

    mintBodies = [];
    const read = await readComments(published.relic_id, deps, {
      version: '*',
      resolve_anchors: true,
    });
    const comment = read.comments.find((row) => row.comment_id === posted.comment_id);
    expect(comment?.body).toBe('The shot starts late.');
    expect(comment?.anchor?.kind).toBe('otio');
    expect(comment?.resolved?.kind).toBe('otio');
    if (comment?.resolved?.kind !== 'otio') {
      throw new Error('expected an otio resolution');
    }
    expect(comment.resolved.status).toBe('resolved');
    expect(comment.resolved.relic_version).toBe(1);
    expect(comment.resolved.start_seconds).toBe(0.5);
    expect(comment.resolved.duration_seconds).toBe(0.25);
    expect(comment.resolved.point).toBe(false);
    expect(comment.resolved.timeline_path.map((node) => node.id)).toContain(
      'track-v1'
    );
    const shot = comment.resolved.intersections.find(
      (span) => span.node_id === 'clip-a'
    );
    expect(shot?.bundle_path).toBe('media/shot.mov');
    expect(shot?.available_range?.start_time.value).toBe(10);
    expect(shot?.schema.startsWith('Clip')).toBe(true);
    expect(comment.resolved.current_projection.current_version).toBe(2);
    expect(comment.resolved.current_projection.status).not.toBe('same');
    expect(
      comment.resolved.intersections.some((span) => span.node_id === 'clip-b')
    ).toBe(false);
    expect(
      mintBodies.some((body) => {
        if (typeof body !== 'object' || body === null || !('version' in body)) {
          return false;
        }
        return body.version === 1;
      })
    ).toBe(true);
  });
});
