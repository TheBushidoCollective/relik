import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  crc32,
  decodeKey,
  deriveCommentKey,
  encryptComment,
  indexOtioZip,
  type OtioAnchorV1,
  type OtioDocumentV1,
  type OtioTimeRange,
  otioBundleMediaIndex,
  otioSequenceFrameEntries,
  readOtioDocument,
  readOtioImageSequence,
  sourceSpansForOtioRange,
} from '@relic/format';
import { createApp, type RelicApp } from '@relic/server/src/app.ts';
import type { OutboundMail } from '@relic/server/src/mail.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import type { CommentRecord } from '../src/comments.ts';
import {
  postComment,
  readComments,
  resolveComment,
  validateAndNormalizeAnchor,
} from '../src/comments.ts';
import { nodeFiles } from '../src/files.ts';
import {
  type PublishDeps,
  type PublishError,
  publish,
} from '../src/publish.ts';
import { republish } from '../src/republish.ts';
import { resolveAnchors } from '../src/resolve-anchor.ts';
import { handleMessage, READ_COMMENTS_TOOL_NAME } from '../src/server.ts';
import { loadPublishState } from '../src/state.ts';

const SERVICE = 'https://relic.example';

let scratch: string;
let storage: MemoryStorage;
let store: MemoryStore;
let app: RelicApp;
let deps: PublishDeps;
let mintBodies: unknown[];
let mintRequests: number;
let sentMails: { to: string; mail: OutboundMail }[];
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

function otioArchive(
  text: string,
  media: readonly OtiozFixtureEntry[]
): Uint8Array {
  return createOtioz([
    {
      name: 'version.txt',
      bytes: new TextEncoder().encode('1.0.0\n'),
    },
    {
      name: 'content.otio',
      bytes: new TextEncoder().encode(text),
    },
    ...media,
  ]);
}

async function browserOtioDocument(
  archive: Uint8Array
): Promise<OtioDocumentV1> {
  const zip = await indexOtioZip(archive);
  return readOtioDocument(zip.contentOtioBytes, {
    mediaIndex: await otioBundleMediaIndex(zip),
  });
}

function otioAnchor(
  document: OtioDocumentV1,
  trackId: string,
  itemId: string,
  range: OtioTimeRange,
  snapshot: OtioAnchorV1['snapshot']
): OtioAnchorV1 {
  const timelineId = document.timeline_ids[0];
  if (!timelineId) throw new Error('expected an OTIO timeline');
  return {
    kind: 'otio',
    v: 1,
    relic_version: 1,
    document_sha256: document.document_sha256,
    timeline_id: timelineId,
    track_id: trackId,
    item_id: itemId,
    range,
    snapshot,
  };
}

async function resolvedOtioComment(
  relicId: string,
  body: string
): Promise<Extract<NonNullable<CommentRecord['resolved']>, { kind: 'otio' }>> {
  const read = await readComments(relicId, deps, {
    version: '*',
    resolve_anchors: true,
  });
  const comment = read.comments.find((entry) => entry.body === body);
  if (comment?.resolved?.kind !== 'otio') {
    throw new Error(`expected OTIO resolution for ${body}`);
  }
  return comment.resolved;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function derivedTimelineWithDuplicateTrackNames(): string {
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    name: 'Derived root timeline',
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'V1',
          kind: 'Video',
          metadata: { relic: { id: 'track-a' } },
          children: [clip('clip-a', 'First V1 clip', 'shot.mov')],
        },
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'V1',
          kind: 'Video',
          metadata: { relic: { id: 'track-b' } },
          children: [clip('clip-b', 'Second V1 clip', 'shot.mov')],
        },
      ],
    },
  });
}

function imageSequenceTimeline(): string {
  return JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    name: 'Sequence continuity',
    metadata: { relic: { id: 'sequence-timeline' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'V1',
          kind: 'Video',
          metadata: { relic: { id: 'sequence-track' } },
          children: [
            {
              OTIO_SCHEMA: 'Clip.1',
              name: 'Three-frame sequence',
              metadata: { relic: { id: 'sequence-clip' } },
              source_range: {
                OTIO_SCHEMA: 'TimeRange.1',
                start_time: {
                  OTIO_SCHEMA: 'RationalTime.1',
                  value: 0,
                  rate: 24,
                },
                duration: {
                  OTIO_SCHEMA: 'RationalTime.1',
                  value: 3,
                  rate: 24,
                },
              },
              media_reference: {
                OTIO_SCHEMA: 'ImageSequenceReference.1',
                target_url_base: 'media/',
                name_prefix: 'frame_',
                name_suffix: '.png',
                start_frame: 1,
                frame_step: 1,
                rate: 24,
                frame_zero_padding: 4,
                missing_frame_policy: 'error',
                available_range: {
                  OTIO_SCHEMA: 'TimeRange.1',
                  start_time: {
                    OTIO_SCHEMA: 'RationalTime.1',
                    value: 0,
                    rate: 24,
                  },
                  duration: {
                    OTIO_SCHEMA: 'RationalTime.1',
                    value: 3,
                    rate: 24,
                  },
                },
              },
            },
          ],
        },
      ],
    },
  });
}

function completeFetchDouble(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response>
): typeof globalThis.fetch {
  return Object.assign(implementation, {
    preconnect: globalThis.fetch.preconnect,
  });
}

function shimFetch(): typeof globalThis.fetch {
  return completeFetchDouble(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : String(input));
      if (url.origin === SERVICE) {
        if (url.pathname.endsWith('/mint')) {
          mintRequests++;
          if (init?.body) {
            mintBodies.push(JSON.parse(String(init.body)));
          }
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
    }
  );
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-otio-feedback-'));
  process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'publish-state.json');
  storage = new MemoryStorage();
  store = new MemoryStore();
  sentMails = [];
  app = createApp({
    storage,
    store,
    mailer: {
      send: async () => {},
      sendMail: async (to, mail) => {
        sentMails.push({ to, mail });
      },
    },
  });
  mintBodies = [];
  mintRequests = 0;
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
      fetch: completeFetchDouble(async () => {
        fetches += 1;
        return new Response(null, { status: 500 });
      }),
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

  test('resolves a browser-created OTIOZ anchor without changing its derived timeline identity', async () => {
    const text = derivedTimelineWithDuplicateTrackNames();
    const media = new TextEncoder().encode('actual media/shot.mov bytes');
    const archive = otioArchive(text, [
      { name: 'media/shot.mov', bytes: media },
    ]);
    const browserDocument = await browserOtioDocument(archive);
    expect(browserDocument.media['media/shot.mov']?.sha256).toBeUndefined();
    const anchor = otioAnchor(
      browserDocument,
      'track-a',
      'clip-a',
      {
        start_time: { value: 0, rate: 24 },
        duration: { value: 12, rate: 24 },
      },
      {
        timeline: 'Derived root timeline',
        track: 'V1',
        item: 'First V1 clip',
      }
    );
    expect(browserDocument.nodes[anchor.timeline_id]?.identity_origin).toBe(
      'derived-unique'
    );

    const path = join(scratch, 'browser-anchor.otioz');
    await writeFile(path, archive);
    const published = await publish({ path, cover: false }, deps);
    const body = 'Anchor this V1 track only.';
    await postComment(
      {
        relic_id: published.relic_id,
        body,
        anchor,
      },
      deps
    );

    const resolved = await resolvedOtioComment(published.relic_id, body);
    expect(resolved.status).toBe('resolved');
    expect(resolved.timeline_path[0]?.id).toBe(anchor.timeline_id);
    expect(resolved.intersections.map((span) => span.node_id)).toEqual([
      'clip-a',
    ]);
    expect(
      resolved.intersections.every((span) =>
        span.ancestry.some((node) => node.id === 'track-a')
      )
    ).toBe(true);
    expect(
      resolved.intersections.some((span) =>
        span.ancestry.some((node) => node.id === 'track-b')
      )
    ).toBe(false);
    expect(resolved.intersections[0]?.bundle_path).toBe('media/shot.mov');
    expect(resolved.intersections[0]?.media_digest).toBe(
      await sha256Hex(media)
    );
    expect(resolved.current_projection.status).toBe('same');
  });

  test('reads same-bundle single-decoded media digests from selected bytes', async () => {
    const encoder = new TextEncoder();
    const cases = [
      {
        id: 'encoded-question',
        authored: 'media/%253F.png',
        entry: 'media/%3F.png',
        bytes: encoder.encode('encoded question bytes'),
      },
      {
        id: 'literal-question',
        authored: 'media/%3F.png',
        entry: 'media/?.png',
        bytes: encoder.encode('literal question bytes'),
      },
      {
        id: 'encoded-space',
        authored: 'media/a%2520b.png',
        entry: 'media/a%20b.png',
        bytes: encoder.encode('encoded space bytes'),
      },
      {
        id: 'literal-space',
        authored: 'media/a%20b.png',
        entry: 'media/a b.png',
        bytes: encoder.encode('literal space bytes'),
      },
    ] as const;
    const text = timelineWithItems(
      cases.map(({ id, authored }) => clip(id, id, authored))
    );
    const archive = otioArchive(
      text,
      cases.map(({ entry, bytes }) => ({ name: entry, bytes }))
    );
    const browserDocument = await browserOtioDocument(archive);
    for (const { entry } of cases) {
      expect(browserDocument.media[entry]?.sha256).toBeUndefined();
    }

    const path = join(scratch, 'single-decoded-media.otioz');
    await writeFile(path, archive);
    const published = await publish({ path, cover: false }, deps);

    for (const [index, example] of cases.entries()) {
      const body = `Check ${example.id}.`;
      const anchor = otioAnchor(
        browserDocument,
        'track-v1',
        example.id,
        {
          start_time: { value: index * 24, rate: 24 },
          duration: { value: 1, rate: 24 },
        },
        { timeline: 'Cut', track: 'V1', item: example.id }
      );
      await postComment({ relic_id: published.relic_id, body, anchor }, deps);

      const resolved = await resolvedOtioComment(published.relic_id, body);
      const span = resolved.intersections.find(
        (intersection) => intersection.node_id === example.id
      );
      expect(span?.bundle_path).toBe(example.entry);
      expect(span?.media_digest).toBe(await sha256Hex(example.bytes));
    }
  });

  test('marks a source range changed when its referenced archive media changes', async () => {
    const text = timelineWithItems([
      clip('clip-media', 'Referenced archive media', 'shot.mov'),
    ]);
    const originalMedia = new TextEncoder().encode('source media bytes');
    const originalArchive = otioArchive(text, [
      { name: 'media/shot.mov', bytes: originalMedia },
    ]);
    const browserDocument = await browserOtioDocument(originalArchive);
    const anchor = otioAnchor(
      browserDocument,
      'track-v1',
      'clip-media',
      {
        start_time: { value: 0, rate: 24 },
        duration: { value: 12, rate: 24 },
      },
      { timeline: 'Cut', track: 'V1', item: 'Referenced archive media' }
    );
    const v1Path = join(scratch, 'media-v1.otioz');
    await writeFile(v1Path, originalArchive);
    const published = await publish({ path: v1Path, cover: false }, deps);
    const body = 'Media continuity must not guess.';
    const posted = await postComment(
      { relic_id: published.relic_id, body, anchor },
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

    const v2Path = join(scratch, 'media-v2.otioz');
    await writeFile(
      v2Path,
      otioArchive(text, [
        {
          name: 'media/shot.mov',
          bytes: new TextEncoder().encode('changed source media bytes'),
        },
      ])
    );
    await republish(
      { relic_id: published.relic_id, path: v2Path, cover: false },
      deps
    );

    const resolved = await resolvedOtioComment(published.relic_id, body);
    expect(resolved.status).toBe('resolved');
    expect(resolved.current_projection.status).toBe('changed');
    expect(resolved.current_projection).not.toHaveProperty('mapped_range');
  });

  test('keeps a source range same when only an unreferenced archive entry is added', async () => {
    const text = timelineWithItems([
      clip('clip-unchanged', 'Referenced media survives', 'shot.mov'),
    ]);
    const media = new TextEncoder().encode('unchanged source media');
    const originalArchive = otioArchive(text, [
      { name: 'media/shot.mov', bytes: media },
    ]);
    const browserDocument = await browserOtioDocument(originalArchive);
    const anchor = otioAnchor(
      browserDocument,
      'track-v1',
      'clip-unchanged',
      {
        start_time: { value: 0, rate: 24 },
        duration: { value: 12, rate: 24 },
      },
      { timeline: 'Cut', track: 'V1', item: 'Referenced media survives' }
    );
    const v1Path = join(scratch, 'unreferenced-v1.otioz');
    await writeFile(v1Path, originalArchive);
    const published = await publish({ path: v1Path, cover: false }, deps);
    const body = 'Ignore the unrelated bundle member.';
    const posted = await postComment(
      { relic_id: published.relic_id, body, anchor },
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

    const v2Path = join(scratch, 'unreferenced-v2.otioz');
    await writeFile(
      v2Path,
      otioArchive(text, [
        { name: 'media/shot.mov', bytes: media },
        {
          name: 'media/unreferenced.mov',
          bytes: new TextEncoder().encode('not referenced by this timeline'),
        },
      ])
    );
    await republish(
      { relic_id: published.relic_id, path: v2Path, cover: false },
      deps
    );

    const resolved = await resolvedOtioComment(published.relic_id, body);
    expect(resolved.status).toBe('resolved');
    expect(resolved.current_projection.status).toBe('same');
  });

  test('marks a sequence range changed when one referenced frame changes', async () => {
    const text = imageSequenceTimeline();
    const originalEntries = [
      {
        name: 'media/frame_0001.png',
        bytes: new TextEncoder().encode('frame one'),
      },
      {
        name: 'media/frame_0002.png',
        bytes: new TextEncoder().encode('frame two'),
      },
      {
        name: 'media/frame_0003.png',
        bytes: new TextEncoder().encode('frame three'),
      },
    ] as const;
    const originalArchive = otioArchive(text, originalEntries);
    const browserDocument = await browserOtioDocument(originalArchive);
    const sequenceReference =
      browserDocument.nodes['sequence-clip']?.media_references?.[
        'DEFAULT_MEDIA'
      ];
    if (!sequenceReference) {
      throw new Error('expected the sequence media reference');
    }
    const sequence = readOtioImageSequence(
      sequenceReference.raw ?? sequenceReference
    );
    if (!sequence.ok) {
      throw new Error(sequence.reason);
    }
    expect(sequence.sequence.count).toBe(3);
    expect<readonly string[]>(
      otioSequenceFrameEntries(
        sequenceReference.raw ?? sequenceReference,
        browserDocument.media
      )
    ).toEqual([
      'media/frame_0001.png',
      'media/frame_0002.png',
      'media/frame_0003.png',
    ]);

    const changedFrame2 = new TextEncoder().encode('frame two changed');
    expect(await sha256Hex(changedFrame2)).not.toBe(
      await sha256Hex(originalEntries[1].bytes)
    );
    const revisions = [
      {
        name: 'equal-bytes',
        status: 'same' as const,
        entries: originalEntries,
      },
      {
        name: 'changed-frame2',
        status: 'changed' as const,
        entries: originalEntries.map((entry) =>
          entry.name === 'media/frame_0002.png'
            ? { ...entry, bytes: changedFrame2 }
            : entry
        ),
      },
      {
        name: 'missing-frame2',
        status: 'changed' as const,
        entries: originalEntries.filter(
          (entry) => entry.name !== 'media/frame_0002.png'
        ),
      },
    ] as const;

    const anchor = otioAnchor(
      browserDocument,
      'sequence-track',
      'sequence-clip',
      {
        start_time: { value: 0, rate: 24 },
        duration: { value: 3, rate: 24 },
      },
      {
        timeline: 'Sequence continuity',
        track: 'V1',
        item: 'Three-frame sequence',
      }
    );

    for (const revision of revisions) {
      const v1Path = join(scratch, `sequence-${revision.name}-v1.otioz`);
      await writeFile(v1Path, originalArchive);
      const published = await publish({ path: v1Path, cover: false }, deps);
      const body = `Check all sequence frames (${revision.name}).`;
      const posted = await postComment(
        { relic_id: published.relic_id, body, anchor },
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

      const v2Path = join(scratch, `sequence-${revision.name}-v2.otioz`);
      await writeFile(v2Path, otioArchive(text, revision.entries));
      const republished = await republish(
        { relic_id: published.relic_id, path: v2Path, cover: false },
        deps
      );
      expect(republished.version).toBe(2);

      const read = await readComments(published.relic_id, deps, {
        version: '*',
        resolve_anchors: true,
      });
      const comment = read.comments.find(
        (entry) => entry.comment_id === posted.comment_id
      );
      expect(comment?.readable).toBe(true);
      expect(comment?.resolved?.kind).toBe('otio');
      if (comment?.resolved?.kind !== 'otio') {
        throw new Error('expected a sequence OTIO resolution');
      }
      expect(comment.resolved.status).toBe('resolved');
      expect(comment.resolved.intersections[0]?.bundle_path).toBeNull();
      expect(comment.resolved.intersections[0]?.media_digest).toBeNull();
      expect(comment.resolved.current_projection.status).toBe(revision.status);
      if (revision.status === 'changed') {
        expect(comment.resolved.current_projection).not.toHaveProperty(
          'mapped_range'
        );
      }
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

  test('keeps a late version 1 OTIO comment on its original source revision', async () => {
    const v1Text = timeline('clip-v1', 'Version one');
    const original = readOtioDocument(v1Text);
    const savedV1Anchor = otioAnchor(
      original,
      'track-v1',
      'clip-v1',
      {
        start_time: { value: 12, rate: 24 },
        duration: { value: 6, rate: 24 },
      },
      { timeline: 'Cut', track: 'V1', item: 'Version one' }
    );
    const v1Path = join(scratch, 'late-v1.otio');
    await writeFile(v1Path, v1Text);
    const published = await publish({ path: v1Path, cover: false }, deps);

    const v2Path = join(scratch, 'late-v2.otio');
    await writeFile(v2Path, timeline('clip-v2', 'Version two'));
    const republished = await republish(
      { relic_id: published.relic_id, path: v2Path, cover: false },
      deps
    );
    expect(republished.version).toBe(2);
    expect((await store.getRelic(published.relic_id))?.version).toBe(2);

    const body = 'Keep this note on the original version.';
    const posted = await postComment(
      {
        relic_id: published.relic_id,
        body,
        anchor: savedV1Anchor,
      },
      deps
    );
    expect(
      (await store.getComment(published.relic_id, posted.comment_id))?.version
    ).toBe(1);
    expect((await store.getRelic(published.relic_id))?.version).toBe(2);

    mintBodies = [];
    mintRequests = 0;
    const read = await readComments(published.relic_id, deps, {
      version: '*',
      resolve_anchors: true,
    });
    const comment = read.comments.find(
      (entry) => entry.comment_id === posted.comment_id
    );
    expect(comment?.readable).toBe(true);
    expect(comment?.version).toBe(1);
    expect(comment?.body).toBe(body);
    expect(comment?.anchor?.kind).toBe('otio');
    if (comment?.anchor?.kind !== 'otio') {
      throw new Error('expected the saved OTIO anchor');
    }
    expect(comment.anchor.relic_version).toBe(1);
    expect(comment.anchor.document_sha256).toBe(original.document_sha256);
    expect(comment?.resolved?.kind).toBe('otio');
    if (comment?.resolved?.kind !== 'otio') {
      throw new Error('expected the late OTIO comment to resolve');
    }
    expect(comment.resolved.status).toBe('resolved');
    expect(comment.resolved.relic_version).toBe(1);
    expect(comment.resolved.document_sha256).toBe(original.document_sha256);
    expect(comment.resolved.range).toEqual({
      start_time: { value: 12, rate: 24 },
      duration: { value: 6, rate: 24 },
    });
    expect(comment.resolved.start_seconds).toBe(0.5);
    expect(comment.resolved.duration_seconds).toBe(0.25);
    const originalShot = comment.resolved.intersections.find(
      (span) => span.node_id === 'clip-v1'
    );
    expect(originalShot).toBeDefined();
    expect(
      comment.resolved.intersections.some((span) => span.node_id === 'clip-v2')
    ).toBe(false);
    const expectedSourceSpan = sourceSpansForOtioRange(
      original,
      savedV1Anchor.timeline_id,
      savedV1Anchor.track_id,
      savedV1Anchor.range
    ).find((span) => span.node_id === savedV1Anchor.item_id);
    expect(originalShot?.source_mapping).toEqual(
      expectedSourceSpan?.source_mapping
    );
    expect(comment.resolved.current_projection.current_version).toBe(2);
    expect(comment.resolved.current_projection.status).not.toBe('same');
    expect(mintBodies[0]).toEqual({ version: 1 });
    expect(
      mintBodies.findIndex((request) => {
        if (typeof request !== 'object' || request === null) return false;
        const body = request as { version?: unknown };
        return !Object.hasOwn(body, 'version') || body.version === 2;
      })
    ).toBeGreaterThan(0);
  });

  test('does not mint a sealed anchor for a different service-stamped comment version', async () => {
    const v1Path = join(scratch, 'version-one.otio');
    const v1Text = timeline('clip-v1', 'Version one');
    const v1 = readOtioDocument(v1Text);
    const savedV1Anchor = otioAnchor(
      v1,
      'track-v1',
      'clip-v1',
      {
        start_time: { value: 0, rate: 24 },
        duration: { value: 0, rate: 24 },
      },
      { timeline: 'Cut', track: 'V1', item: 'Version one' }
    );
    await writeFile(v1Path, v1Text);
    const published = await publish({ path: v1Path, cover: false }, deps);

    const v2Path = join(scratch, 'version-two.otio');
    await writeFile(v2Path, timeline('clip-v2', 'Version two'));
    await republish(
      { relic_id: published.relic_id, path: v2Path, cover: false },
      deps
    );

    const state = await loadPublishState(published.relic_id);
    if (!state) throw new Error('expected local publish state');
    const commentKey = await deriveCommentKey(decodeKey(state.key));
    const ciphertext = await encryptComment(commentKey, {
      body: 'This seal claims the wrong version.',
      display_name: null,
      anchor: savedV1Anchor,
    });
    const response = await app.fetch(
      new Request(`${SERVICE}/api/relics/${published.relic_id}/comments`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '198.51.100.10',
        },
        body: JSON.stringify({
          publish_token: state.publish_token,
          ciphertext,
          version: 2,
        }),
      })
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { comment_id?: unknown };
    expect(typeof created.comment_id).toBe('string');
    if (typeof created.comment_id !== 'string') {
      throw new Error('expected a string comment id from the local server');
    }
    expect(
      (await store.getComment(published.relic_id, created.comment_id))?.version
    ).toBe(2);
    expect(sentMails).toEqual([]);

    mintRequests = 0;
    mintBodies = [];
    const read = await readComments(published.relic_id, deps, {
      version: '*',
      resolve_anchors: true,
    });
    const comment = read.comments.find(
      (entry) => entry.comment_id === created.comment_id
    );
    expect(comment?.readable).toBe(true);
    expect(comment?.version).toBe(2);
    expect(comment?.anchor?.kind).toBe('otio');
    if (comment?.anchor?.kind !== 'otio') {
      throw new Error('expected the mismatched OTIO anchor');
    }
    expect(comment.anchor.relic_version).toBe(1);
    expect(comment.anchor.document_sha256).toBe(v1.document_sha256);
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
    expect(mintRequests).toBe(0);
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
      fetch: completeFetchDouble(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(
            typeof input === 'string' ? input : String(input)
          );
          if (
            url.origin === SERVICE &&
            url.pathname.endsWith('/mint') &&
            init?.body
          ) {
            const body = JSON.parse(String(init.body)) as {
              version?: number;
            };
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
        }
      ),
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
