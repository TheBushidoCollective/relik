import { fetchUpload } from './upload-fixture.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type RelicApp } from '@relic/server/src/app.ts';
import type { OutboundMail } from '@relic/server/src/mail.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { type CommentRow, MemoryStore } from '@relic/server/src/store.ts';
import type { CommentAnchorInput, CommentRecord } from '../src/comments.ts';
import { postComment, readComments } from '../src/comments.ts';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, publish } from '../src/publish.ts';
import { republish } from '../src/republish.ts';
import { probeFfmpeg, runFfmpeg } from '../src/resolve-anchor.ts';
import { handleMessage, READ_COMMENTS_TOOL_NAME } from '../src/server.ts';

const SERVICE = 'https://relic.example';
const NOT_FOUND = 'not found in this version';

let scratch: string;
let storage: MemoryStorage;
let store: MemoryStore;
let app: RelicApp;
let deps: PublishDeps;

function shimFetch(): typeof globalThis.fetch {
  const shim = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    if (url.origin === SERVICE) {
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
  };
  return Object.assign(shim, { preconnect: globalThis.fetch.preconnect });
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-structured-republish-'));
  process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'publish-state.json');
  storage = new MemoryStorage();
  store = new MemoryStore();
  app = createApp({
    storage,
    store,
    mailer: {
      send: async () => {},
      sendMail: async (_to: string, _mail: OutboundMail) => {},
    },
  });
  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    fetch: shimFetch(),
    upload: fetchUpload,
    clientName: 'relic-mcp/resolve-structured-republish-test',
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

interface Scenario {
  readonly name: string;
  readonly file: string;
  readonly version1: string;
  readonly version2: string;
  /** The anchor on version 1 content, and what it must resolve to there. */
  readonly v1Anchor: CommentAnchorInput;
  readonly v1Expect: Record<string, unknown>;
  /** The anchor on version 2 content, and what it must resolve to there. */
  readonly v2Anchor: CommentAnchorInput;
  readonly v2Expect: Record<string, unknown>;
  /** Text only version 2 holds. A version 1 or versionless comment must never print it. */
  readonly v2Only: string;
  /**
   * What a comment that records no version resolves to: a time anchor belongs
   * to version 1, and a cell or path anchor is not found.
   */
  readonly versionless: 'v1' | 'not-found';
}

const NOTEBOOK_V1 = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      cell_type: 'code',
      execution_count: null,
      metadata: {},
      source: ['x = 1'],
      outputs: [],
    },
  ],
});

const NOTEBOOK_V2 = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Intro'] },
    {
      cell_type: 'code',
      execution_count: null,
      metadata: {},
      source: ['y = 2'],
      outputs: [],
    },
  ],
});

const SRT_V1 = [
  '1',
  '00:00:00,000 --> 00:00:02,000',
  'alpha',
  '',
  '2',
  '00:00:02,000 --> 00:00:04,000',
  'beta',
  '',
].join('\n');

const SRT_V2 = [
  '1',
  '00:00:00,000 --> 00:00:01,000',
  'intro',
  '',
  '2',
  '00:00:01,000 --> 00:00:03,500',
  'omega',
  '',
  '3',
  '00:00:03,500 --> 00:00:05,000',
  'close',
  '',
].join('\n');

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'a CSV cell',
    file: 'parts.csv',
    version1: 'name,qty\nwidget,3\nbolt,7\n',
    // widget moved from row 2 to row 3, so row 2 now holds nut.
    version2: 'name,qty\nnut,5\nwidget,3\nbolt,9\n',
    v1Anchor: { kind: 'cell', row: 2, col: 2 },
    v1Expect: {
      kind: 'cell',
      status: 'resolved',
      text: '3',
      header: 'qty',
      line: 2,
    },
    v2Anchor: { kind: 'cell', row: 2, col: 2 },
    v2Expect: {
      kind: 'cell',
      status: 'resolved',
      text: '5',
      header: 'qty',
      line: 2,
    },
    v2Only: 'nut',
    versionless: 'not-found',
  },
  {
    name: 'a JSON path',
    file: 'items.json',
    version1: '{"items":[{"name":"alpha","qty":1},{"name":"beta","qty":2}]}\n',
    // beta moved from index 1 to index 2, so index 1 now holds alpha.
    version2:
      '{"items":[{"name":"gamma","qty":4},{"name":"alpha","qty":1},{"name":"beta","qty":5}]}\n',
    v1Anchor: { kind: 'path', pointer: '/items/1/name' },
    v1Expect: {
      kind: 'path',
      status: 'resolved',
      type: 'string',
      excerpt: 'beta',
    },
    v2Anchor: { kind: 'path', pointer: '/items/1/name' },
    v2Expect: {
      kind: 'path',
      status: 'resolved',
      type: 'string',
      excerpt: 'alpha',
    },
    v2Only: 'gamma',
    versionless: 'not-found',
  },
  {
    name: 'an SRT cue',
    file: 'lines.srt',
    version1: SRT_V1,
    // The cue covering 1.5 s is replaced on version 2.
    version2: SRT_V2,
    v1Anchor: { kind: 'time', t: 1.5 },
    v1Expect: { kind: 'time', status: 'resolved', cueTexts: ['alpha'] },
    v2Anchor: { kind: 'time', t: 1.5 },
    v2Expect: { kind: 'time', status: 'resolved', cueTexts: ['omega'] },
    v2Only: 'omega',
    versionless: 'v1',
  },
  {
    name: 'a WebVTT cue',
    file: 'lines.vtt',
    version1:
      'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nalpha\n\n00:00:02.000 --> 00:00:04.000\nbeta\n',
    version2:
      'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nintro\n\n00:00:01.000 --> 00:00:03.500\nomega\n\n00:00:03.500 --> 00:00:05.000\nclose\n',
    v1Anchor: { kind: 'time', t: 1.5 },
    v1Expect: { kind: 'time', status: 'resolved', cueTexts: ['alpha'] },
    v2Anchor: { kind: 'time', t: 1.5 },
    v2Expect: { kind: 'time', status: 'resolved', cueTexts: ['omega'] },
    v2Only: 'omega',
    versionless: 'v1',
  },
  {
    name: 'a notebook cell',
    file: 'demo.ipynb',
    version1: NOTEBOOK_V1,
    // The code cell moved from index 0 to index 1; index 0 is now markdown.
    version2: NOTEBOOK_V2,
    v1Anchor: { kind: 'path', pointer: '/cells/0' },
    v1Expect: {
      kind: 'path',
      status: 'resolved',
      type: 'cell',
      cell_type: 'code',
      excerpt: 'x = 1',
    },
    v2Anchor: { kind: 'path', pointer: '/cells/0' },
    v2Expect: {
      kind: 'path',
      status: 'resolved',
      type: 'cell',
      cell_type: 'markdown',
      excerpt: '# Intro',
    },
    v2Only: '# Intro',
    versionless: 'not-found',
  },
];

interface Setup {
  readonly relicId: string;
  readonly v1CommentId: string;
  readonly v2CommentId: string;
}

/**
 * Publishes version 1, comments on it, republishes version 2 where the
 * commented node moved, then comments on version 2. Each step is the real
 * path: sealed comment, real service, real republish.
 */
async function publishTwoVersions(scenario: Scenario): Promise<Setup> {
  const path = join(scratch, scenario.file);
  await writeFile(path, scenario.version1);
  const published = await publish({ path, cover: false }, deps);
  const relicId = published.relic_id;

  const v1 = await postComment(
    {
      relic_id: relicId,
      body: 'Remark made on version one.',
      anchor: scenario.v1Anchor,
    },
    deps
  );

  await writeFile(path, scenario.version2);
  await republish(
    {
      relic_id: relicId,
      path,
      cover: false,
      notify: false,
      addresses: [
        { comment_id: v1.comment_id, note: 'Acknowledged on version two.' },
      ],
    },
    deps
  );

  const v2 = await postComment(
    {
      relic_id: relicId,
      body: 'Remark made on version two.',
      anchor: scenario.v2Anchor,
    },
    deps
  );
  return { relicId, v1CommentId: v1.comment_id, v2CommentId: v2.comment_id };
}

async function resolvedById(
  relicId: string,
  wired: PublishDeps = deps
): Promise<Map<string, CommentRecord>> {
  const read = await readComments(relicId, wired, {
    version: '*',
    resolve_anchors: true,
  });
  return new Map(read.comments.map((c) => [c.comment_id, c]));
}

/** The text the public read tool prints for every comment on every version. */
async function transcript(relicId: string): Promise<string> {
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: READ_COMMENTS_TOOL_NAME,
        arguments: { relic_id: relicId, version: '*', resolve_anchors: true },
      },
    },
    deps
  );
  const result = response?.result;
  const blocks =
    typeof result === 'object' && result !== null && 'content' in result
      ? result.content
      : undefined;
  const first = Array.isArray(blocks) ? blocks[0] : undefined;
  if (
    typeof first !== 'object' ||
    first === null ||
    !('text' in first) ||
    typeof first.text !== 'string'
  ) {
    throw new Error('expected a text content block from the read tool');
  }
  return first.text;
}

/** The transcript block whose comment body is `body`. */
function blockFor(text: string, body: string): string {
  const block = text.split('\n\n').find((b) => b.includes(body));
  if (block === undefined) throw new Error(`no transcript block for "${body}"`);
  return block;
}

function expectResolution(
  comment: CommentRecord | undefined,
  expected: Record<string, unknown>
): void {
  if (comment === undefined) throw new Error('comment missing from the read');
  const resolved = comment.resolved as
    | Record<string, unknown>
    | null
    | undefined;
  if (resolved === null || resolved === undefined) {
    throw new Error('comment carries no resolution');
  }
  const { cueTexts, ...rest } = expected;
  expect(resolved).toMatchObject(rest);
  if (cueTexts !== undefined) {
    const cues = resolved['cues'] as Array<{ text: string }> | undefined;
    expect(cues?.map((cue) => cue.text)).toEqual(cueTexts as string[]);
  }
}

function unresolvedExplanation(comment: CommentRecord | undefined): string {
  const resolved = comment?.resolved as
    | { status: string; explanation: string }
    | null
    | undefined;
  expect(resolved?.status).toBe('unresolvable');
  return resolved?.explanation ?? '';
}

/** The version 1 comment's sealed row, copied to make a row the service never wrote. */
async function firstCommentRow(relicId: string): Promise<CommentRow> {
  const first = (await store.listComments(relicId)).find(
    (row) => row.author === 'publisher'
  );
  if (first === undefined) throw new Error('no comment row to copy');
  return first;
}

/** Every mint request that names no version, which is a read of the current revision. */
function watchUnversionedMints(): {
  readonly deps: PublishDeps;
  readonly seen: string[];
} {
  const seen: string[] = [];
  const watched: PublishDeps = {
    ...deps,
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/mint')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<
            string,
            unknown
          >;
          if (!('version' in body)) seen.push(url);
        }
        return deps.fetch(input, init);
      },
      { preconnect: globalThis.fetch.preconnect }
    ),
  };
  return { deps: watched, seen };
}

describe('republished reliks resolve each comment against its own version', () => {
  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      test('a version 1 comment resolves against version 1, and a version 2 comment against version 2', async () => {
        const { relicId, v1CommentId, v2CommentId } =
          await publishTwoVersions(scenario);
        const byId = await resolvedById(relicId);
        expectResolution(byId.get(v1CommentId), scenario.v1Expect);
        expectResolution(byId.get(v2CommentId), scenario.v2Expect);
        expect(byId.get(v1CommentId)?.version).toBe(1);
        expect(byId.get(v2CommentId)?.version).toBe(2);
      });

      test('the read tool labels each comment with the version it was made on', async () => {
        const { relicId } = await publishTwoVersions(scenario);
        const text = await transcript(relicId);
        expect(blockFor(text, 'Remark made on version one.')).toContain(
          '[made on version 1]'
        );
        expect(blockFor(text, 'Remark made on version two.')).toContain(
          '[made on version 2]'
        );
        expect(blockFor(text, 'Remark made on version one.')).not.toContain(
          scenario.v2Only
        );
      });

      test('a comment recording a version the relik never had is not found, and prints nothing from the current file', async () => {
        const { relicId, v1CommentId } = await publishTwoVersions(scenario);
        const source = await firstCommentRow(relicId);
        await store.putComment({
          ...source,
          id: 'stray-version-9',
          version: 9,
        });

        const byId = await resolvedById(relicId);
        const stray = byId.get('stray-version-9');
        expect(stray?.version).toBe(9);
        expect(unresolvedExplanation(stray)).toContain(NOT_FOUND);
        expect(JSON.stringify(stray?.resolved)).not.toContain(scenario.v2Only);
        // The real version 1 comment is untouched by the stray row.
        expectResolution(byId.get(v1CommentId), scenario.v1Expect);

        const misses = (await transcript(relicId))
          .split('\n\n')
          .filter((b) => b.includes(NOT_FOUND));
        expect(misses.length).toBeGreaterThan(0);
        for (const block of misses) {
          expect(block).not.toContain(scenario.v2Only);
        }
      });

      test('a comment recording no version never reads the current revision', async () => {
        const { relicId } = await publishTwoVersions(scenario);
        const source = await firstCommentRow(relicId);
        await store.putComment({
          ...source,
          id: 'legacy-no-version',
          version: undefined,
        });

        const watched = watchUnversionedMints();
        await resolvedById(relicId, watched.deps);
        expect(watched.seen).toEqual([]);
      });

      test(
        scenario.versionless === 'v1'
          ? 'a comment recording no version belongs to version 1, and never prints version two'
          : 'a comment recording no version is not found, and prints nothing from the current file',
        async () => {
          const { relicId } = await publishTwoVersions(scenario);
          const source = await firstCommentRow(relicId);
          await store.putComment({
            ...source,
            id: 'legacy-no-version',
            version: undefined,
          });

          const byId = await resolvedById(relicId);
          const legacy = byId.get('legacy-no-version');
          expect(legacy?.version).toBeNull();
          expect(JSON.stringify(legacy?.resolved)).not.toContain(
            scenario.v2Only
          );

          if (scenario.versionless === 'v1') {
            expectResolution(legacy, scenario.v1Expect);
            // The versionless row prints without a version label, so its block is
            // the one that carries the version one body and no label.
            const unlabelled = (await transcript(relicId))
              .split('\n\n')
              .filter(
                (b) =>
                  b.includes('Remark made on version one.') &&
                  !b.includes('[made on version')
              );
            expect(unlabelled.length).toBeGreaterThan(0);
            for (const block of unlabelled) {
              expect(block).not.toContain(scenario.v2Only);
            }
          } else {
            const explanation = unresolvedExplanation(legacy);
            expect(explanation).toContain(NOT_FOUND);
            expect(explanation).toContain('records no version');
            const misses = (await transcript(relicId))
              .split('\n\n')
              .filter((b) => b.includes('records no version'));
            expect(misses.length).toBeGreaterThan(0);
            for (const block of misses) {
              expect(block).not.toContain(scenario.v2Only);
            }
          }
        }
      );
    });
  }
});

describe('a versionless subtitle comment on a relik that was never republished', () => {
  test('resolves against version 1, the only version it has', async () => {
    const path = join(scratch, 'once.srt');
    await writeFile(path, SRT_V1);
    const published = await publish({ path, cover: false }, deps);
    const relicId = published.relic_id;
    const stamped = await postComment(
      {
        relic_id: relicId,
        body: 'Remark on the only version.',
        anchor: { kind: 'time', t: 1.5 },
      },
      deps
    );
    const source = await firstCommentRow(relicId);
    await store.putComment({
      ...source,
      id: 'legacy-no-version',
      version: undefined,
    });

    const byId = await resolvedById(relicId);
    expectResolution(byId.get(stamped.comment_id), {
      kind: 'time',
      status: 'resolved',
      cueTexts: ['alpha'],
    });
    expectResolution(byId.get('legacy-no-version'), {
      kind: 'time',
      status: 'resolved',
      cueTexts: ['alpha'],
    });
  });
});

/** A small generated video, from ffmpeg's lavfi sources. */
async function makeVideo(source: string): Promise<Uint8Array> {
  const ffmpeg = await probeFfmpeg(deps);
  if (!ffmpeg) throw new Error('ffmpeg is required for the video time case');
  return runFfmpeg(
    ffmpeg,
    [
      '-f',
      'lavfi',
      '-i',
      source,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      'frag_keyframe+empty_moov',
      '-f',
      'mp4',
      'pipe:1',
    ],
    new Uint8Array(0)
  );
}

/** The frames a read resolves for one version's comments, in list order. */
async function framesAt(relicId: string, version: number): Promise<unknown[]> {
  const read = await readComments(relicId, deps, {
    version,
    resolve_anchors: true,
  });
  return [...(read.content_blocks ?? [])];
}

describe('a versionless video time comment resolves to version 1 frames', () => {
  test('its frames are version 1 frames, and differ from version 2 frames', async () => {
    const path = join(scratch, 'clip.mp4');
    await writeFile(
      path,
      await makeVideo('testsrc=duration=2:size=160x120:rate=1')
    );
    const published = await publish({ path, cover: false }, deps);
    const relicId = published.relic_id;
    const v1 = await postComment(
      {
        relic_id: relicId,
        body: 'Remark made on version one.',
        anchor: { kind: 'time', t: 0.5 },
      },
      deps
    );

    await writeFile(
      path,
      await makeVideo('color=c=red:size=160x120:duration=2')
    );
    await republish(
      {
        relic_id: relicId,
        path,
        cover: false,
        notify: false,
        addresses: [
          { comment_id: v1.comment_id, note: 'Acknowledged on version two.' },
        ],
      },
      deps
    );
    await postComment(
      {
        relic_id: relicId,
        body: 'Remark made on version two.',
        anchor: { kind: 'time', t: 0.5 },
      },
      deps
    );

    const v1Frames = await framesAt(relicId, 1);
    const v2Frames = await framesAt(relicId, 2);
    expect(v1Frames.length).toBeGreaterThan(0);
    expect(v2Frames.length).toBeGreaterThan(0);
    expect(v2Frames).not.toEqual(v1Frames);

    // A versionless copy of the version 1 comment, in the same scope as it.
    const source = await firstCommentRow(relicId);
    await store.putComment({
      ...source,
      id: 'legacy-no-version',
      version: undefined,
    });
    const withLegacy = await framesAt(relicId, 1);
    expect(withLegacy).toEqual([...v1Frames, ...v1Frames]);
    expect(withLegacy).not.toEqual([...v1Frames, ...v2Frames]);

    const byId = await resolvedById(relicId);
    expect(byId.get('legacy-no-version')?.resolved).toMatchObject({
      kind: 'time',
      status: 'resolved',
    });
  });
});
