import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, test } from 'bun:test';
import {
  indexOtioZip,
  OTIO_PROGRAM_PROTOCOL,
  OTIO_PROGRAM_MAX_BYTES,
  OTIO_PROGRAM_REASON_CODES,
  OTIO_PROGRAM_SCHEMA,
  PLAINTEXT_CAP_BYTES,
  readOtioProgramArchive,
  stringifyOtioJson,
  stringifyOtioProgramManifest,
} from '@relic/format';
import type { CdpEvent } from '../src/cover/cdp.ts';
import type { RunningChrome } from '../src/cover/chrome.ts';
import { buildZipArchive } from '../src/otio-bundle.ts';
import {
  BUILD_MESSAGES,
  buildProgramArchive,
  PROGRAM_RECORD_RESERVE_BYTES,
  programRenderBudget,
  RENDERER_IDENTITY_RESERVE_BYTES,
} from '../src/program/build.ts';
import { programPolicyFrom } from '../src/program/policy.ts';
import {
  type ProgramRenderer,
  type ProgramRenderJob,
  type ProgramRenderOutput,
  RENDER_MESSAGES,
  renderInBrowser,
} from '../src/program/render.ts';
import { PublishError } from '../src/publish.ts';

const MIB = 1024 * 1024;
const ENCODER = new TextEncoder();
const MP4 = new Uint8Array(4096).fill(7);
const PAGES = { html: new Uint8Array(), js: new Uint8Array() };
const PROGRAM = {
  frame_rate: { num: 24, den: 1 },
  frames: 24,
  width: 320,
  height: 240,
  video_codec: 'avc1.42001f',
  video_bitrate: 1_000_000,
  audio_codec: 'mp4a.40.2',
  audio_rate: 48000,
  channels: 2,
  audio_samples: 48000,
  range: {
    start_time: { value: 0, rate: 24 },
    duration: { value: 24, rate: 24 },
  },
};

interface Entry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method: 0 | 8;
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function utf8Length(text: string): number {
  return ENCODER.encode(text).length;
}

/** `count` authored Timeline.1 nodes in one selectable collection, each clipping one media file. */
function collectionFor(count: number, mediaPath: string): Uint8Array {
  const timelines = Array.from({ length: count }, (_, t) => ({
    OTIO_SCHEMA: 'Timeline.1',
    name: `timeline-${t}`,
    metadata: { relic: { id: `timeline-${t}` } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      metadata: { relic: { id: `stack-${t}` } },
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          kind: 'Video',
          metadata: { relic: { id: `track-${t}` } },
          children: [
            {
              OTIO_SCHEMA: 'Clip.1',
              name: `clip-${t}`,
              metadata: { relic: { id: `clip-${t}` } },
              source_range: {
                start_time: { value: 0, rate: 24 },
                duration: { value: 24, rate: 24 },
              },
              media_reference: {
                OTIO_SCHEMA: 'ExternalReference.1',
                target_url: mediaPath,
              },
            },
          ],
        },
      ],
    },
  }));
  return ENCODER.encode(
    JSON.stringify({
      OTIO_SCHEMA: 'SerializableCollection.1',
      name: 'Collection',
      metadata: {},
      children: timelines,
    })
  );
}

function bundleOf(document: Uint8Array, media: readonly Entry[]): Entry[] {
  return [
    { name: 'content.otio', data: document, method: 8 },
    { name: 'version.txt', data: ENCODER.encode('1.0.0'), method: 8 },
    ...media,
  ];
}

const MEDIA: Entry = {
  name: 'media/clip.mp4',
  data: new Uint8Array(1024).fill(1),
  method: 0,
};

function fakeRenderer(outcome: (id: string) => unknown): ProgramRenderer {
  return async (job) =>
    ({
      browser: 'Fake Browser',
      outcomes: job.timelineIds.map((id) => outcome(id)),
    }) as unknown as ProgramRenderOutput;
}

function renderedOutcome(id: string, mp4: Uint8Array = MP4) {
  return {
    status: 'rendered' as const,
    timelineId: id,
    program: PROGRAM,
    mp4,
    sha256: sha(mp4),
  };
}

function publishOf(entries: readonly Entry[], renderer: ProgramRenderer) {
  return buildProgramArchive({
    archive: buildZipArchive(entries),
    sourceName: 'show.otioz',
    sizeLimit: PLAINTEXT_CAP_BYTES,
    policy: programPolicyFrom({}),
    renderer,
    clientName: 'relic-mcp/test',
  });
}

function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The budget the publisher gives the renderer for these entries, recomputed
 * from the format's own functions: the base facts, and the baseline manifest
 * with every timeline unavailable for the size-cap reason, plus the reserve.
 */
async function expectedRenderBudget(
  entries: readonly Entry[],
  ids: readonly string[]
): Promise<number> {
  const index = await indexOtioZip(buildZipArchive(entries));
  let expandedBytes = 0;
  let deflateBytes = 0;
  for (const info of index.entries.values()) {
    expandedBytes += info.uncompressedSize;
    if (info.method === 8) deflateBytes += info.uncompressedSize;
  }
  const media: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.name.startsWith('media/')) media[entry.name] = sha(entry.data);
  }
  const baseline = stringifyOtioProgramManifest({
    schema: OTIO_PROGRAM_SCHEMA,
    document_sha256: index.contentSha256,
    renderer: {
      client: 'relic-mcp/test',
      protocol: OTIO_PROGRAM_PROTOCOL,
      browser: 'none',
    },
    media,
    timelines: ids.map((id, i) => ({
      timeline_id: id,
      index: i,
      status: 'unavailable' as const,
      reasons: [
        { code: 'size-cap-exceeded' as const, message: BUILD_MESSAGES.sizeCap },
      ],
    })),
  });
  const reserved =
    baseline.length +
    ids.length * PROGRAM_RECORD_RESERVE_BYTES +
    RENDERER_IDENTITY_RESERVE_BYTES;
  return programRenderBudget({
    budget: PLAINTEXT_CAP_BYTES,
    facts: {
      prefixBytes: index.directory.offset,
      directoryBytes: index.directory.size,
      entryCount: index.directory.entryCount,
      commentBytes: index.directory.commentLength,
      expandedBytes,
      deflateBytes,
    },
    manifestBytes: reserved,
    timelineCount: ids.length,
  });
}

describe('aggregate program budget across timelines', () => {
  test('a second 60 MiB program is dropped and the first is kept, with the renderer budget recomputed', async () => {
    const big = new Uint8Array(60 * MIB).fill(3);
    const jobs: ProgramRenderJob[] = [];
    const entries = bundleOf(collectionFor(2, 'media/clip.mp4'), [MEDIA]);
    const renderer: ProgramRenderer = async (job) => {
      jobs.push(job);
      return {
        browser: 'Fake Browser',
        outcomes: job.timelineIds.map((id) => renderedOutcome(id, big)),
      } as unknown as ProgramRenderOutput;
    };
    const result = await publishOf(entries, renderer);

    expect(jobs).toHaveLength(1);
    const budget = await expectedRenderBudget(entries, [
      'timeline-0',
      'timeline-1',
    ]);
    expect(jobs[0]!.maxTotalBytes).toBe(budget);
    expect(jobs[0]!.maxTotalBytes).toBeLessThan(OTIO_PROGRAM_MAX_BYTES);

    expect(result.report.status).toBe('partial');
    expect(result.report.timelines[0]!.status).toBe('rendered');
    expect(result.report.timelines[1]!.status).toBe('unavailable');
    expect(result.report.timelines[1]!.reasons[0]!.code).toBe(
      'size-cap-exceeded'
    );

    const written = await indexOtioZip(concatParts(result.parts));
    const verified = await readOtioProgramArchive(written, {
      document_sha256: written.contentSha256,
      timeline_ids: ['timeline-0', 'timeline-1'],
      media_paths: ['media/clip.mp4'],
    });
    expect(verified).not.toBeNull();
    expect(verified!.programs.size).toBe(1);
    expect(verified!.programs.get(0)!.length).toBe(big.length);
  }, 120_000);
});

describe('timeline count limit', () => {
  test('256 timelines render in one job with 256 ids', async () => {
    const entries = bundleOf(collectionFor(256, 'media/clip.mp4'), [MEDIA]);
    const jobs: ProgramRenderJob[] = [];
    const renderer: ProgramRenderer = async (job) => {
      jobs.push(job);
      return {
        browser: 'Fake Browser',
        outcomes: job.timelineIds.map((id) => renderedOutcome(id)),
      } as unknown as ProgramRenderOutput;
    };
    const result = await publishOf(entries, renderer);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.timelineIds).toHaveLength(256);
    expect(result.report.status).toBe('rendered');
    expect(result.report.timelines).toHaveLength(256);
  }, 120_000);

  test('257 timelines are refused as timeline-count before any browser starts', async () => {
    const entries = bundleOf(collectionFor(257, 'media/clip.mp4'), [MEDIA]);
    const jobs: ProgramRenderJob[] = [];
    const renderer: ProgramRenderer = async (job) => {
      jobs.push(job);
      return { browser: 'none', outcomes: [] };
    };
    let refusal: PublishError | undefined;
    try {
      await publishOf(entries, renderer);
    } catch (error) {
      if (error instanceof PublishError) refusal = error;
      else throw error;
    }
    expect(refusal?.details['program_reason']).toBe('timeline-count');
    expect(refusal?.message).toBe(BUILD_MESSAGES.timelineCount);
    expect(jobs).toHaveLength(0);
  }, 120_000);
});

describe('the reserved record sizes bound every shipped record', () => {
  const sizeCap = {
    code: 'size-cap-exceeded',
    message: BUILD_MESSAGES.sizeCap,
  };
  const capRecord = {
    timeline_id: 'timeline-0',
    index: 0,
    status: 'unavailable',
    reasons: [sizeCap],
  };
  const capBytes = utf8Length(stringifyOtioJson(capRecord));

  test('a maximal rendered descriptor is at most PROGRAM_RECORD_RESERVE_BYTES above the size-cap record', () => {
    // -1.2345678901234567e-300 is 24 characters: the widest number a descriptor carries.
    const wide = -1.2345678901234567e-300;
    const record = {
      timeline_id: 'timeline-0',
      index: 0,
      status: 'rendered',
      reasons: [],
      program: {
        entry: `relic/program/timeline-${'9'.repeat(3)}.mp4`,
        sha256: 'f'.repeat(64),
        bytes: wide,
        range: {
          start_time: { value: wide, rate: wide },
          duration: { value: wide, rate: wide },
        },
        frame_rate: { num: wide, den: wide },
        frames: wide,
        width: wide,
        height: wide,
        video_codec: 'avc1.ffffff',
        video_bitrate: wide,
        audio_codec: 'mp4a.40.2',
        audio_rate: wide,
        channels: wide,
        audio_samples: wide,
      },
    };
    const growth = utf8Length(stringifyOtioJson(record)) - capBytes;
    expect(growth).toBeLessThanOrEqual(PROGRAM_RECORD_RESERVE_BYTES);
  });

  test('a record with all ten page reasons at the longest fixed sentence fits the reserve', () => {
    const messages = [
      ...Object.values(RENDER_MESSAGES),
      ...Object.values(BUILD_MESSAGES),
    ];
    const longest = messages.reduce((a, b) => (b.length > a.length ? b : a));
    const record = {
      timeline_id: 'timeline-0',
      index: 0,
      status: 'unavailable',
      reasons: OTIO_PROGRAM_REASON_CODES.map((code) => ({
        code,
        message: longest,
      })),
    };
    const growth = utf8Length(stringifyOtioJson(record)) - capBytes;
    expect(growth).toBeLessThanOrEqual(PROGRAM_RECORD_RESERVE_BYTES);
  });

  test('every single fixed render or build sentence fits the reserve', () => {
    for (const message of [
      ...Object.values(RENDER_MESSAGES),
      ...Object.values(BUILD_MESSAGES),
    ]) {
      const record = {
        timeline_id: 'timeline-0',
        index: 0,
        status: 'unavailable',
        reasons: [{ code: 'render-failed', message }],
      };
      const growth = utf8Length(stringifyOtioJson(record)) - capBytes;
      expect(growth).toBeLessThanOrEqual(PROGRAM_RECORD_RESERVE_BYTES);
    }
  });

  test('a 128-character browser identity fits the identity reserve', () => {
    const growth =
      utf8Length(stringifyOtioJson('B'.repeat(128))) -
      utf8Length(stringifyOtioJson('none'));
    expect(growth).toBeLessThanOrEqual(RENDERER_IDENTITY_RESERVE_BYTES);
  });
});

describe('the output is byte-identical to a rebuilt archive', () => {
  test('concat(parts) equals buildZipArchive with the same manifest and program entries', async () => {
    const entries = bundleOf(collectionFor(1, 'media/clip.mp4'), [MEDIA]);
    const result = await publishOf(
      entries,
      fakeRenderer((id) => renderedOutcome(id))
    );
    expect(result.report.status).toBe('rendered');
    // Parts: [source prefix, manifest local header + DEFLATE data, ...]
    const manifestLocal = result.parts[1]!;
    const manifest = new Uint8Array(
      inflateRawSync(manifestLocal.subarray(30 + 18))
    );
    const expected = buildZipArchive([
      ...entries,
      { name: 'relic/program.json', data: manifest, method: 8 },
      { name: 'relic/program/timeline-0.mp4', data: MP4, method: 0 },
    ]);
    const actual = concatParts(result.parts);
    expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
  });
});

describe('the fake-CDP page drives the whole publish path', () => {
  /**
   * A scripted browser over the CDP surface renderInBrowser uses. Each render
   * is answered with the timeline's own MP4 in one chunk and its own digest.
   */
  function scriptedBrowser(
    ids: readonly string[],
    documentSha256: string,
    mp4s: readonly Uint8Array[]
  ): RunningChrome {
    const listeners: Array<(event: CdpEvent) => void> = [];
    const cdp = {
      onEvent(listener: (event: CdpEvent) => void) {
        listeners.push(listener);
        return () => {
          const at = listeners.indexOf(listener);
          if (at >= 0) listeners.splice(at, 1);
        };
      },
      async waitForEvent() {
        return {} as CdpEvent;
      },
      async send(
        method: string,
        params: Record<string, unknown> = {}
      ): Promise<Record<string, unknown>> {
        if (method === 'Browser.getVersion')
          return { product: 'HeadlessChrome/fake' };
        if (method === 'Target.createBrowserContext')
          return { browserContextId: 'ctx' };
        if (method === 'Target.createTarget') return { targetId: 'target' };
        if (method === 'Target.attachToTarget') return { sessionId: 'session' };
        if (method !== 'Runtime.evaluate') return {};
        const expression = String(params['expression']);
        if (expression.startsWith('window.__relicProgram && ')) {
          return { result: { value: 1 } };
        }
        const prefix = 'window.__relicProgram.render(';
        const request = JSON.parse(
          expression.slice(prefix.length, -1)
        ) as Record<string, unknown>;
        const index = request['timeline_index'] as number;
        const mp4 = mp4s[index]!;
        const payload = `0:${Buffer.from(mp4).toString('base64')}`;
        for (const listener of [...listeners]) {
          listener({
            sessionId: 'session',
            method: 'Runtime.bindingCalled',
            params: { name: '__relicProgramChunk', payload },
          } as unknown as CdpEvent);
        }
        return {
          result: {
            value: {
              ok: true,
              document_sha256: documentSha256,
              timeline_id: ids[index],
              byte_length: mp4.length,
              sha256: sha(mp4),
              program: PROGRAM,
            },
          },
        };
      },
    };
    return { cdp, close: async () => {} } as unknown as RunningChrome;
  }

  test('two timelines rendered by the page verify through publish and the reader', async () => {
    const mp4a = new Uint8Array(4096).fill(11);
    const mp4b = new Uint8Array(4096).fill(12);
    const entries = bundleOf(collectionFor(2, 'media/clip.mp4'), [MEDIA]);
    const renderer: ProgramRenderer = (job) =>
      renderInBrowser(
        scriptedBrowser(job.timelineIds, job.documentSha256, [mp4a, mp4b]),
        PAGES,
        job,
        Date.now() + 60_000
      );
    const result = await publishOf(entries, renderer);
    expect(result.report.status).toBe('rendered');
    const written = await indexOtioZip(concatParts(result.parts));
    const verified = await readOtioProgramArchive(written, {
      document_sha256: written.contentSha256,
      timeline_ids: ['timeline-0', 'timeline-1'],
      media_paths: ['media/clip.mp4'],
    });
    expect(verified).not.toBeNull();
    expect(
      Buffer.from(verified!.programs.get(0)!).equals(Buffer.from(mp4a))
    ).toBe(true);
    expect(
      Buffer.from(verified!.programs.get(1)!).equals(Buffer.from(mp4b))
    ).toBe(true);
  }, 60_000);

  test('a page answering for the wrong document is refused as an outcome, not a publish', async () => {
    const entries = bundleOf(collectionFor(1, 'media/clip.mp4'), [MEDIA]);
    const renderer: ProgramRenderer = (job) =>
      renderInBrowser(
        scriptedBrowser(job.timelineIds, 'e'.repeat(64), [MP4]),
        PAGES,
        job,
        Date.now() + 60_000
      );
    const result = await publishOf(entries, renderer);
    expect(result.report.status).toBe('unavailable');
    expect(result.report.timelines[0]!.reasons[0]!.message).toBe(
      RENDER_MESSAGES.pageAnsweredOther
    );
  }, 60_000);
});
