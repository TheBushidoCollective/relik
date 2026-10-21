import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  crc32,
  readOtioDocument,
  sourceSpansForOtioRange,
} from '@relic/format';
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
import { handleMessage, READ_COMMENTS_TOOL_NAME } from '../src/server.ts';
import type { CommentRecord } from '../src/comments.ts';

const SERVICE = 'https://relic.example';

let scratch: string;
let storage: MemoryStorage;
let store: MemoryStore;
let app: RelicApp;
let deps: PublishDeps;
let mintBodies: unknown[];

type OtioFixtureItem = Record<string, unknown>;

function clip(
  clipId: string,
  clipName: string,
  mediaPath = 'media/shot.mov',
  effects: readonly Record<string, unknown>[] = []
): OtioFixtureItem {
  return {
    OTIO_SCHEMA: 'Clip.1',
    name: clipName,
    metadata: { relic: { id: clipId } },
    source_range: {
      start_time: { value: 0, rate: 24 },
      duration: { value: 24, rate: 24 },
    },
    media_reference: {
      OTIO_SCHEMA: 'ExternalReference.1',
      target_url: mediaPath,
      available_range: {
        start_time: { value: 10, rate: 24 },
        duration: { value: 48, rate: 24 },
      },
    },
    ...(effects.length === 0 ? {} : { effects }),
  };
}

function timelineWithItems(items: readonly OtioFixtureItem[]): string {
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
          children: items,
        },
      ],
    },
  });
}

function timeline(
  clipId: string,
  clipName: string,
  effects: readonly Record<string, unknown>[] = []
): string {
  return timelineWithItems([clip(clipId, clipName, 'media/shot.mov', effects)]);
}

interface OtiozFixtureEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly deflate?: boolean;
  readonly declared_size?: number;
}

function createOtioz(entries: readonly OtiozFixtureEntry[]): Uint8Array {
  const encoded = entries.map((entry) => {
    const name = new TextEncoder().encode(entry.name);
    const payload = entry.deflate
      ? new Uint8Array(deflateRawSync(entry.bytes))
      : entry.bytes;
    return {
      name,
      payload,
      method: entry.deflate ? 8 : 0,
      declaredSize: entry.declared_size ?? entry.bytes.length,
      crc: crc32(entry.bytes),
    };
  });
  const localParts: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const entry of encoded) {
    offsets.push(offset);
    const local = new Uint8Array(30 + entry.name.length + entry.payload.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, entry.method, true);
    view.setUint32(14, entry.crc, true);
    view.setUint32(18, entry.payload.length, true);
    view.setUint32(22, entry.declaredSize, true);
    view.setUint16(26, entry.name.length, true);
    local.set(entry.name, 30);
    local.set(entry.payload, 30 + entry.name.length);
    localParts.push(local);
    offset += local.length;
  }

  const centralOffset = offset;
  const centralParts: Uint8Array[] = [];
  for (const [index, entry] of encoded.entries()) {
    const central = new Uint8Array(46 + entry.name.length);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(10, entry.method, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.payload.length, true);
    view.setUint32(24, entry.declaredSize, true);
    view.setUint16(28, entry.name.length, true);
    view.setUint32(42, offsets[index] as number, true);
    central.set(entry.name, 46);
    centralParts.push(central);
    offset += central.length;
  }

  const archive = new Uint8Array(offset + 22);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts]) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  const end = new DataView(archive.buffer);
  end.setUint32(cursor, 0x06054b50, true);
  end.setUint16(cursor + 8, encoded.length, true);
  end.setUint16(cursor + 10, encoded.length, true);
  end.setUint32(cursor + 12, offset - centralOffset, true);
  end.setUint32(cursor + 16, centralOffset, true);
  return archive;
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
      expect(resolved.comments[0].resolved.explanation).toContain(
        'not evidence'
      );
      expect(resolved.comments[0].resolved.declared).toBe('otio-v9');
    }
  });

  test('version 1 source intervals survive after version 2, and the projection is separate', async () => {
    const v1Path = join(scratch, 'cut.otio');
    const v1Text = timeline('clip-a', 'Shot');
    await writeFile(v1Path, v1Text);
    const original = readOtioDocument(v1Text);
    const published = await publish({ path: v1Path, cover: false }, deps);

    const anchor = {
      kind: 'otio' as const,
      v: 1 as const,
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
    };
    const posted = await postComment(
      {
        relic_id: published.relic_id,
        body: 'The shot starts late.',
        anchor,
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
    const comment = read.comments.find(
      (row) => row.comment_id === posted.comment_id
    );
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
    const expectedSourceSpan = sourceSpansForOtioRange(
      original,
      anchor.timeline_id,
      anchor.track_id,
      anchor.range
    ).find((span) => span.node_id === anchor.item_id);
    expect(shot?.source_mapping).toEqual(expectedSourceSpan?.source_mapping);
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

  test('does not mint a sealed anchor for a different service-stamped comment version', async () => {
    const v1Path = join(scratch, 'version-one.otio');
    const v1Text = timeline('clip-v1', 'Version one');
    const v1 = readOtioDocument(v1Text);
    await writeFile(v1Path, v1Text);
    const published = await publish({ path: v1Path, cover: false }, deps);

    const v2Path = join(scratch, 'version-two.otio');
    await writeFile(v2Path, timeline('clip-v2', 'Version two'));
    await republish(
      { relic_id: published.relic_id, path: v2Path, cover: false },
      deps
    );

    mintBodies = [];
    const posted = await postComment(
      {
        relic_id: published.relic_id,
        body: 'This seal claims the wrong version.',
        anchor: {
          kind: 'otio',
          v: 1,
          relic_version: 1,
          document_sha256: v1.document_sha256,
          timeline_id: 'tl1',
          track_id: 'track-v1',
          range: {
            start_time: { value: 0, rate: 24 },
            duration: { value: 0, rate: 24 },
          },
          snapshot: { timeline: 'Cut', track: 'V1', item: null },
        },
      },
      deps
    );
    const read = await readComments(published.relic_id, deps, {
      version: '*',
      resolve_anchors: true,
    });
    const comment = read.comments.find(
      (entry) => entry.comment_id === posted.comment_id
    );
    expect(comment?.version).toBe(2);
    expect(comment?.resolved?.kind).toBe('otio');
    if (comment?.resolved?.kind !== 'otio') {
      throw new Error('expected an OTIO resolution');
    }
    expect(comment.resolved.status).toBe('unresolvable');
    expect(comment.resolved.explanation).toContain(
      'does not match the service-stamped comment version'
    );
    expect(comment.resolved.timeline_path).toEqual([]);
    expect(comment.resolved.intersections).toEqual([]);
    expect(comment.resolved.current_projection.status).toBe('unresolvable');
    expect(mintBodies).toEqual([]);
  });

  test('uses core membership validation before treating a same revision as mapped', async () => {
    const path = join(scratch, 'membership.otio');
    const text = timeline('clip-a', 'Membership');
    const document = readOtioDocument(text);
    await writeFile(path, text);
    const published = await publish({ path, cover: false }, deps);
    const posted = await postComment(
      {
        relic_id: published.relic_id,
        body: 'This track does not exist.',
        anchor: {
          kind: 'otio',
          v: 1,
          relic_version: 1,
          document_sha256: document.document_sha256,
          timeline_id: 'tl1',
          track_id: 'missing-track',
          range: {
            start_time: { value: 0, rate: 24 },
            duration: { value: 0, rate: 24 },
          },
          snapshot: { timeline: 'Cut', track: 'Missing', item: null },
        },
      },
      deps
    );
    mintBodies = [];
    const read = await readComments(published.relic_id, deps, {
      version: '*',
      resolve_anchors: true,
    });
    const comment = read.comments.find(
      (entry) => entry.comment_id === posted.comment_id
    );
    expect(comment?.resolved?.kind).toBe('otio');
    if (comment?.resolved?.kind !== 'otio') {
      throw new Error('expected an OTIO resolution');
    }
    expect(comment.resolved.status).toBe('unresolvable');
    expect(comment.resolved.current_projection.status).toBe('unresolvable');
    expect(comment.resolved.current_projection).not.toHaveProperty(
      'mapped_range'
    );
    expect(mintBodies).toEqual([{ version: 1 }]);
  });

  test('withholds a validly decrypted wrong revision without fetching its latest projection', async () => {
    const v1Path = join(scratch, 'sealed-v1.otio');
    const v1Text = timeline('clip-v1', 'Original');
    const v1 = readOtioDocument(v1Text);
    await writeFile(v1Path, v1Text);
    const published = await publish({ path: v1Path, cover: false }, deps);
    const historical = await postComment(
      {
        relic_id: published.relic_id,
        body: 'Original seal stays readable.',
        anchor: {
          kind: 'otio',
          v: 1,
          relic_version: 1,
          document_sha256: v1.document_sha256,
          timeline_id: 'tl1',
          track_id: 'track-v1',
          item_id: 'clip-v1',
          range: {
            start_time: { value: 0, rate: 24 },
            duration: { value: 12, rate: 24 },
          },
          snapshot: { timeline: 'sealed-v1', track: 'V1', item: 'sealed' },
        },
      },
      deps
    );
    await resolveComment(
      {
        relic_id: published.relic_id,
        comment_id: historical.comment_id,
        resolved: true,
      },
      deps
    );

    const v2Path = join(scratch, 'sealed-v2.otio');
    const v2Text = timeline('clip-v2', 'Replacement');
    const v2 = readOtioDocument(v2Text);
    await writeFile(v2Path, v2Text);
    await republish(
      { relic_id: published.relic_id, path: v2Path, cover: false },
      deps
    );
    const peer = await postComment(
      {
        relic_id: published.relic_id,
        body: 'Valid peer context.',
        anchor: {
          kind: 'otio',
          v: 1,
          relic_version: 2,
          document_sha256: v2.document_sha256,
          timeline_id: 'tl1',
          track_id: 'track-v1',
          item_id: 'clip-v2',
          range: {
            start_time: { value: 0, rate: 24 },
            duration: { value: 12, rate: 24 },
          },
          snapshot: { timeline: 'sealed-v2', track: 'V1', item: 'sealed' },
        },
      },
      deps
    );

    const currentMint = await deps.fetch(
      `${SERVICE}/api/relics/${published.relic_id}/mint`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }
    );
    if (!currentMint.ok) {
      throw new Error('expected the loopback current mint to succeed');
    }
    const currentDescriptor = (await currentMint.json()) as {
      url?: unknown;
      object_length?: unknown;
    };
    if (
      typeof currentDescriptor.url !== 'string' ||
      typeof currentDescriptor.object_length !== 'number'
    ) {
      throw new Error('expected a loopback current mint descriptor');
    }

    mintBodies = [];
    const forged: PublishDeps = {
      ...deps,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : String(input));
        if (
          url.origin === SERVICE &&
          url.pathname.endsWith('/mint') &&
          init?.body
        ) {
          const body = JSON.parse(String(init.body)) as { version?: number };
          if (body.version === 1) {
            mintBodies.push(body);
            return Response.json({
              url: currentDescriptor.url,
              object_length: currentDescriptor.object_length,
              version: 1,
              current_version: 2,
            });
          }
        }
        return deps.fetch(input, init);
      }) as typeof globalThis.fetch,
    };
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: READ_COMMENTS_TOOL_NAME,
          arguments: {
            relic_id: published.relic_id,
            version: '*',
            resolve_anchors: true,
          },
        },
      },
      forged
    );
    const toolResult = response?.result as {
      readonly isError: boolean;
      readonly content: readonly {
        readonly type: string;
        readonly text?: string;
      }[];
      readonly structuredContent: {
        readonly comments: readonly CommentRecord[];
      };
    };
    expect(toolResult.isError).toBe(false);
    const tampered = toolResult.structuredContent.comments.find(
      (entry) => entry.comment_id === historical.comment_id
    );
    const validPeer = toolResult.structuredContent.comments.find(
      (entry) => entry.comment_id === peer.comment_id
    );
    expect(tampered?.body).toBe('Original seal stays readable.');
    expect(tampered?.anchor?.kind).toBe('otio');
    expect(tampered?.resolved?.kind).toBe('otio');
    if (tampered?.resolved?.kind !== 'otio') {
      throw new Error('expected a tampered OTIO resolution');
    }
    expect(tampered.resolved.status).toBe('unresolvable');
    expect(tampered.resolved.explanation).toBe(
      'The sealed OTIO document digest does not match the requested revision, so artifact-derived context was withheld.'
    );
    expect(tampered.resolved.start_seconds).toBe(0);
    expect(tampered.resolved.duration_seconds).toBe(0.5);
    expect(tampered.resolved.timeline_path).toEqual([]);
    expect(tampered.resolved.intersections).toEqual([]);
    expect(tampered.resolved.current_projection).toEqual({
      status: 'unresolvable',
      current_version: null,
      explanation:
        'The sealed OTIO document digest does not match the requested revision, so artifact-derived context was withheld.',
    });
    expect(JSON.stringify(tampered.resolved)).not.toContain('Replacement');
    expect(validPeer?.resolved?.kind).toBe('otio');
    if (validPeer?.resolved?.kind !== 'otio') {
      throw new Error('expected the valid batch peer to resolve');
    }
    expect(validPeer.resolved.status).toBe('resolved');
    const transcript = toolResult.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    expect(transcript).toContain(
      'The sealed OTIO document digest does not match the requested revision'
    );
    expect(transcript).not.toContain('Replacement');
    expect(mintBodies).toEqual([{ version: 1 }, { version: 2 }, {}]);
  });

  test('copies forward, reverse, and freeze source mappings from core unchanged', async () => {
    const cases: readonly {
      readonly name: string;
      readonly scalar: number;
      readonly effects: readonly Record<string, unknown>[];
    }[] = [
      { name: 'forward', scalar: 1, effects: [] },
      {
        name: 'reverse',
        scalar: -1,
        effects: [{ OTIO_SCHEMA: 'LinearTimeWarp.1', time_scalar: -1 }],
      },
      {
        name: 'freeze',
        scalar: 0,
        effects: [{ OTIO_SCHEMA: 'FreezeFrame.1' }],
      },
    ];

    for (const scenario of cases) {
      const path = join(scratch, `${scenario.name}.otio`);
      const text = timeline(
        `clip-${scenario.name}`,
        scenario.name,
        scenario.effects
      );
      const document = readOtioDocument(text);
      await writeFile(path, text);
      const published = await publish({ path, cover: false }, deps);
      const anchor = {
        kind: 'otio' as const,
        v: 1 as const,
        relic_version: 1,
        document_sha256: document.document_sha256,
        timeline_id: 'tl1',
        track_id: 'track-v1',
        item_id: `clip-${scenario.name}`,
        range: {
          start_time: { value: 6, rate: 24 },
          duration: { value: 6, rate: 24 },
        },
        snapshot: { timeline: 'Cut', track: 'V1', item: scenario.name },
      };
      const posted = await postComment(
        {
          relic_id: published.relic_id,
          body: `${scenario.name} mapping`,
          anchor,
        },
        deps
      );
      const read = await readComments(published.relic_id, deps, {
        version: 1,
        resolve_anchors: true,
      });
      const comment = read.comments.find(
        (entry) => entry.comment_id === posted.comment_id
      );
      if (comment?.resolved?.kind !== 'otio') {
        throw new Error(`expected ${scenario.name} OTIO resolution`);
      }
      const expected = sourceSpansForOtioRange(
        document,
        anchor.timeline_id,
        anchor.track_id,
        anchor.range
      ).find((span) => span.node_id === anchor.item_id);
      const actual = comment.resolved.intersections.find(
        (span) => span.node_id === anchor.item_id
      );
      expect(actual?.source_mapping).toEqual(expected?.source_mapping);
      expect(actual?.source_mapping?.scalar).toBe(scenario.scalar);
      expect(comment.resolved.current_projection.status).toBe('same');
    }
  });

  test('preserves disjoint core projection pieces without inventing a bounding range', async () => {
    const v1Text = timelineWithItems([
      clip('clip-a', 'A', 'media/a.mov'),
      clip('clip-b', 'B', 'media/b.mov'),
    ]);
    const original = readOtioDocument(v1Text);
    const v1Path = join(scratch, 'disjoint-v1.otio');
    await writeFile(v1Path, v1Text);
    const published = await publish({ path: v1Path, cover: false }, deps);
    const anchor = {
      kind: 'otio' as const,
      v: 1 as const,
      relic_version: 1,
      document_sha256: original.document_sha256,
      timeline_id: 'tl1',
      track_id: 'track-v1',
      range: {
        start_time: { value: 0, rate: 24 },
        duration: { value: 48, rate: 24 },
      },
      snapshot: { timeline: 'Cut', track: 'V1', item: null },
    };
    const posted = await postComment(
      {
        relic_id: published.relic_id,
        body: 'Keep both pieces apart.',
        anchor,
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

    const v2Path = join(scratch, 'disjoint-v2.otio');
    await writeFile(
      v2Path,
      timelineWithItems([
        clip('clip-a', 'A', 'media/a.mov'),
        {
          OTIO_SCHEMA: 'Gap.1',
          name: 'Editorial gap',
          source_range: {
            start_time: { value: 0, rate: 24 },
            duration: { value: 24, rate: 24 },
          },
        },
        clip('clip-b', 'B', 'media/b.mov'),
      ])
    );
    await republish(
      { relic_id: published.relic_id, path: v2Path, cover: false },
      deps
    );

    const read = await readComments(published.relic_id, deps, {
      version: '*',
      resolve_anchors: true,
    });
    const comment = read.comments.find(
      (entry) => entry.comment_id === posted.comment_id
    );
    if (comment?.resolved?.kind !== 'otio') {
      throw new Error('expected a disjoint OTIO resolution');
    }
    const projection = comment.resolved.current_projection;
    expect(projection.status).toBe('mapped');
    expect(projection.mapped_timeline_id).toBe('tl1');
    expect(projection.mapped_ranges).toEqual([
      {
        start_time: { value: 0, rate: 24 },
        duration: { value: 24, rate: 24 },
      },
      {
        start_time: { value: 48, rate: 24 },
        duration: { value: 24, rate: 24 },
      },
    ]);
    expect(projection).not.toHaveProperty('mapped_range');
    expect(projection).not.toHaveProperty('mapped_start_seconds');
    expect(projection).not.toHaveProperty('mapped_start_timecode');
  });

  test('accepts a zero-length DEFLATE media entry at its zero-byte bound', async () => {
    const text = timeline('clip-empty', 'Empty media companion');
    const document = readOtioDocument(text);
    const archive = createOtioz([
      {
        name: 'version.txt',
        bytes: new TextEncoder().encode('1.0.0\n'),
      },
      { name: 'content.otio', bytes: new TextEncoder().encode(text) },
      {
        name: 'media/empty.bin',
        bytes: new Uint8Array(),
        deflate: true,
      },
    ]);
    const path = join(scratch, 'zero-media.otioz');
    await writeFile(path, archive);
    const published = await publish({ path, cover: false }, deps);
    const posted = await postComment(
      {
        relic_id: published.relic_id,
        body: 'The empty entry is still a valid archive member.',
        anchor: {
          kind: 'otio',
          v: 1,
          relic_version: 1,
          document_sha256: document.document_sha256,
          timeline_id: 'tl1',
          track_id: 'track-v1',
          item_id: 'clip-empty',
          range: {
            start_time: { value: 0, rate: 24 },
            duration: { value: 1, rate: 24 },
          },
          snapshot: { timeline: 'Cut', track: 'V1', item: 'Empty' },
        },
      },
      deps
    );
    const read = await readComments(published.relic_id, deps, {
      version: 1,
      resolve_anchors: true,
    });
    const comment = read.comments.find(
      (entry) => entry.comment_id === posted.comment_id
    );
    expect(comment?.resolved?.kind).toBe('otio');
    if (comment?.resolved?.kind !== 'otio') {
      throw new Error('expected the zero-byte archive member to resolve');
    }
    expect(comment.resolved.status).toBe('resolved');
  });

  test('bounds Node OTIOZ expansion to the entry declaration before a large result exists', async () => {
    const text = timeline('clip-bomb', 'Bounded media companion');
    const document = readOtioDocument(text);
    const expanded = new Uint8Array(4 * 1024 * 1024);
    expanded.fill(0x61);
    const archive = createOtioz([
      {
        name: 'version.txt',
        bytes: new TextEncoder().encode('1.0.0\n'),
      },
      { name: 'content.otio', bytes: new TextEncoder().encode(text) },
      {
        name: 'media/bomb.bin',
        bytes: expanded,
        deflate: true,
        declared_size: 1,
      },
    ]);
    const path = join(scratch, 'underdeclared-media.otioz');
    await writeFile(path, archive);
    const published = await publish({ path, cover: false }, deps);
    const posted = await postComment(
      {
        relic_id: published.relic_id,
        body: 'Do not expand the declared byte.',
        anchor: {
          kind: 'otio',
          v: 1,
          relic_version: 1,
          document_sha256: document.document_sha256,
          timeline_id: 'tl1',
          track_id: 'track-v1',
          item_id: 'clip-bomb',
          range: {
            start_time: { value: 0, rate: 24 },
            duration: { value: 1, rate: 24 },
          },
          snapshot: { timeline: 'Cut', track: 'V1', item: 'Bomb' },
        },
      },
      deps
    );
    mintBodies = [];
    const read = await readComments(published.relic_id, deps, {
      version: 1,
      resolve_anchors: true,
    });
    const comment = read.comments.find(
      (entry) => entry.comment_id === posted.comment_id
    );
    expect(comment?.resolved?.kind).toBe('otio');
    if (comment?.resolved?.kind !== 'otio') {
      throw new Error('expected the underdeclared archive to be unresolvable');
    }
    expect(comment.resolved.status).toBe('unresolvable');
    expect(comment.resolved.explanation).toContain(
      'Failed to read OTIO document'
    );
    expect(mintBodies).toEqual([{ version: 1 }]);
  });
});
