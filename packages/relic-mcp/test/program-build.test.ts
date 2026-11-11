import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { OTIO_PROGRAM_MAX_BYTES, PLAINTEXT_CAP_BYTES } from '@relic/format';
import { buildZipArchive } from '../src/otio-bundle.ts';
import {
  BUILD_MESSAGES,
  buildProgramArchive,
  MANIFEST_RESERVE_BYTES,
  MANIFEST_RESERVE_PER_TIMELINE,
  programRenderBudget,
  ZIP_ENTRY_OVERHEAD_BYTES,
} from '../src/program/build.ts';
import {
  programArchiveBudget,
  programPolicyFrom,
  programRenderInputWithinBounds,
  RENDER_INPUT_MAX_ENTRY_BYTES,
  RENDER_INPUT_MAX_TOTAL_BYTES,
} from '../src/program/policy.ts';
import type {
  ProgramRenderer,
  ProgramRenderJob,
} from '../src/program/render.ts';
import { PublishError } from '../src/publish.ts';

const MIB = 1024 * 1024;
const ENCODER = new TextEncoder();

interface Entry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method: 0 | 8;
}

const MP4 = new Uint8Array(4096).fill(7);
const MP4_SHA = createHash('sha256').update(MP4).digest('hex');
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
} as const;

/** A renderer that succeeds for every timeline and records each job it was given. */
function fakeRenderer(jobs: ProgramRenderJob[]): ProgramRenderer {
  return async (job) => {
    jobs.push(job);
    return {
      browser: 'Fake Browser',
      outcomes: job.timelineIds.map((timelineId) => ({
        status: 'rendered' as const,
        timelineId,
        program: PROGRAM,
        mp4: MP4,
        sha256: MP4_SHA,
      })),
    };
  };
}

/** One timeline that references every media path it is given, one clip each. */
function documentFor(mediaPaths: readonly string[]): Uint8Array {
  const document = {
    OTIO_SCHEMA: 'Timeline.1',
    name: 'Program',
    metadata: { relic: { id: 'timeline-main' } },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      metadata: { relic: { id: 'stack-main' } },
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          kind: 'Video',
          metadata: { relic: { id: 'track-main' } },
          children: mediaPaths.map((target, i) => ({
            OTIO_SCHEMA: 'Clip.1',
            name: `clip-${i}`,
            metadata: { relic: { id: `clip-${i}` } },
            source_range: {
              start_time: { value: 0, rate: 24 },
              duration: { value: 24, rate: 24 },
            },
            media_reference: {
              OTIO_SCHEMA: 'ExternalReference.1',
              target_url: target,
            },
          })),
        },
      ],
    },
  };
  return ENCODER.encode(JSON.stringify(document));
}

/** A bundle with content.otio, version.txt and one STORED entry per media file. */
function entriesFor(media: readonly { path: string; size: number }[]): Entry[] {
  return [
    {
      name: 'content.otio',
      data: documentFor(media.map((m) => m.path)),
      method: 8,
    },
    { name: 'version.txt', data: ENCODER.encode('1.0.0'), method: 8 },
    ...media.map((m) => ({
      name: m.path,
      data: new Uint8Array(m.size).fill(1),
      method: 0 as const,
    })),
  ];
}

interface PublishOptions {
  readonly sizeLimit?: number;
  readonly env?: Record<string, string>;
  readonly jobs?: ProgramRenderJob[];
}

function publish(entries: readonly Entry[], options: PublishOptions = {}) {
  return buildProgramArchive({
    archive: buildZipArchive(entries),
    sourceName: 'show.otioz',
    sizeLimit: options.sizeLimit ?? PLAINTEXT_CAP_BYTES,
    policy: programPolicyFrom(options.env ?? {}),
    renderer: fakeRenderer(options.jobs ?? []),
    clientName: 'relic-mcp/test',
  });
}

async function refusalOf(promise: Promise<unknown>): Promise<PublishError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PublishError) return error;
    throw error;
  }
  throw new Error('expected the publish to be refused');
}

/** Archive bytes with no program: the base the publisher starts from. */
function baseSizeOf(entries: readonly Entry[]): number {
  return buildZipArchive(entries).length;
}

/** The sizeLimit at which exactly `headroom` bytes remain for one timeline. */
function sizeLimitWithHeadroom(entries: readonly Entry[], headroom: number) {
  return (
    baseSizeOf(entries) +
    MANIFEST_RESERVE_BYTES +
    MANIFEST_RESERVE_PER_TIMELINE +
    ZIP_ENTRY_OVERHEAD_BYTES +
    headroom
  );
}

const SMALL = entriesFor([{ path: 'media/clip.mp4', size: 1024 }]);

describe('publisher headroom', () => {
  test('a plaintext-cap publish gives the renderer the program bound', async () => {
    const jobs: ProgramRenderJob[] = [];
    const report = await publish(SMALL, { jobs });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.maxBytes).toBe(OTIO_PROGRAM_MAX_BYTES);
    expect(jobs[0]!.maxBytes).toBeLessThanOrEqual(OTIO_PROGRAM_MAX_BYTES);
    expect(report.report.status).toBe('rendered');
  });

  test('a one-byte headroom is the smallest render the publisher starts', async () => {
    const jobs: ProgramRenderJob[] = [];
    await publish(SMALL, { jobs, sizeLimit: sizeLimitWithHeadroom(SMALL, 1) });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.maxBytes).toBe(1);
  });

  test('zero headroom skips the renderer and marks every timeline size-cap-exceeded', async () => {
    const jobs: ProgramRenderJob[] = [];
    const { report } = await publish(SMALL, {
      jobs,
      sizeLimit: sizeLimitWithHeadroom(SMALL, 0),
    });
    expect(jobs).toHaveLength(0);
    expect(report.status).toBe('unavailable');
    expect(report.timelines).toHaveLength(1);
    expect(report.timelines[0]!.reasons[0]!.code).toBe('size-cap-exceeded');
  });

  test('negative headroom also skips the renderer', async () => {
    const jobs: ProgramRenderJob[] = [];
    await publish(SMALL, {
      jobs,
      sizeLimit: sizeLimitWithHeadroom(SMALL, -1),
    });
    expect(jobs).toHaveLength(0);
  });

  test('a base at exactly the cap is refused as manifest-unfit with its sizes', async () => {
    const jobs: ProgramRenderJob[] = [];
    const base = baseSizeOf(SMALL);
    const refusal = await refusalOf(publish(SMALL, { jobs, sizeLimit: base }));
    expect(refusal.code).toBe('program_refused');
    expect(refusal.details['program_reason']).toBe('manifest-unfit');
    expect(refusal.details['size_limit_bytes']).toBe(base);
    expect(refusal.details['size_basis']).toBe('whole-archive');
    expect(refusal.details['declared_size_bytes'] as number).toBeGreaterThan(
      base
    );
    expect(jobs).toHaveLength(0);
  });
});

describe('render input guard', () => {
  test('a single 64 MiB media entry renders', async () => {
    const jobs: ProgramRenderJob[] = [];
    const entries = entriesFor([
      { path: 'media/big.mp4', size: RENDER_INPUT_MAX_ENTRY_BYTES },
    ]);
    const { report } = await publish(entries, { jobs });
    expect(jobs).toHaveLength(1);
    expect(report.status).toBe('rendered');
  }, 60_000);

  test('a 64 MiB + 1 media entry is focus-only and no browser starts', async () => {
    const jobs: ProgramRenderJob[] = [];
    const entries = entriesFor([
      { path: 'media/big.mp4', size: RENDER_INPUT_MAX_ENTRY_BYTES + 1 },
    ]);
    const { report } = await publish(entries, { jobs });
    expect(jobs).toHaveLength(0);
    expect(report.status).toBe('unavailable');
    expect(report.timelines[0]!.reasons[0]!.code).toBe('size-cap-exceeded');
  }, 60_000);

  test('two 60 MiB entries exceed the 100 MiB total and do not render', async () => {
    const jobs: ProgramRenderJob[] = [];
    const entries = entriesFor([
      { path: 'media/a.mp4', size: 60 * MIB },
      { path: 'media/b.mp4', size: 60 * MIB },
    ]);
    const { report } = await publish(entries, { jobs });
    expect(RENDER_INPUT_MAX_TOTAL_BYTES).toBe(100 * MIB);
    expect(jobs).toHaveLength(0);
    expect(report.timelines[0]!.reasons[0]!.code).toBe('size-cap-exceeded');
  }, 60_000);

  test('the guard names its own sentence, distinct from the cap sentence', async () => {
    const entries = entriesFor([
      { path: 'media/big.mp4', size: RENDER_INPUT_MAX_ENTRY_BYTES + 1 },
    ]);
    const { report } = await publish(entries);
    expect(report.timelines[0]!.reasons).toHaveLength(1);
    expect(BUILD_MESSAGES.renderInput).not.toBe(BUILD_MESSAGES.sizeCap);
  }, 60_000);

  test('the guard accepts exactly the bounds and refuses one byte over', () => {
    expect(
      programRenderInputWithinBounds([{ size: RENDER_INPUT_MAX_ENTRY_BYTES }])
    ).toBe(true);
    expect(
      programRenderInputWithinBounds([
        { size: RENDER_INPUT_MAX_ENTRY_BYTES + 1 },
      ])
    ).toBe(false);
    expect(
      programRenderInputWithinBounds([
        { size: RENDER_INPUT_MAX_TOTAL_BYTES / 2 },
        { size: RENDER_INPUT_MAX_TOTAL_BYTES / 2 },
      ])
    ).toBe(true);
    expect(
      programRenderInputWithinBounds([
        { size: RENDER_INPUT_MAX_TOTAL_BYTES / 2 },
        { size: RENDER_INPUT_MAX_TOTAL_BYTES / 2 + 1 },
      ])
    ).toBe(false);
  });
});

describe('RELIC_PROGRAM_MAX_BYTES only lowers', () => {
  test('the knob lowers the budget and never raises it', () => {
    const lower = programPolicyFrom({ RELIC_PROGRAM_MAX_BYTES: '8388608' });
    expect(programArchiveBudget(PLAINTEXT_CAP_BYTES, lower)).toBe(8 * MIB);

    const higher = programPolicyFrom({
      RELIC_PROGRAM_MAX_BYTES: '1000000000000',
    });
    expect(programArchiveBudget(PLAINTEXT_CAP_BYTES, higher)).toBe(
      PLAINTEXT_CAP_BYTES
    );

    expect(
      programArchiveBudget(
        8 * MIB,
        programPolicyFrom({ RELIC_PROGRAM_MAX_BYTES: '9000000' })
      )
    ).toBe(8 * MIB);
  });

  test('a lowered knob reaches the renderer as the headroom budget', async () => {
    const jobs: ProgramRenderJob[] = [];
    await publish(SMALL, {
      jobs,
      env: { RELIC_PROGRAM_MAX_BYTES: String(8 * MIB) },
    });
    const base = baseSizeOf(SMALL);
    const expected = programRenderBudget({
      budget: 8 * MIB,
      baseSize: base,
      timelineCount: 1,
    });
    expect(jobs[0]!.maxBytes).toBe(expected);
    expect(jobs[0]!.maxBytes).toBeLessThan(OTIO_PROGRAM_MAX_BYTES);
  });

  test('a knob above the program bound still renders at the bound', async () => {
    const jobs: ProgramRenderJob[] = [];
    await publish(SMALL, {
      jobs,
      env: { RELIC_PROGRAM_MAX_BYTES: '1000000000000' },
    });
    expect(jobs[0]!.maxBytes).toBe(OTIO_PROGRAM_MAX_BYTES);
  });

  test('a non-positive knob is refused as invalid-config', async () => {
    const refusal = await refusalOf(
      publish(SMALL, { env: { RELIC_PROGRAM_MAX_BYTES: '0' } })
    );
    expect(refusal.details['program_reason']).toBe('invalid-config');
  });
});

describe('programRenderBudget', () => {
  test('is the program bound when the headroom is larger', () => {
    expect(
      programRenderBudget({
        budget: PLAINTEXT_CAP_BYTES,
        baseSize: 1000,
        timelineCount: 1,
      })
    ).toBe(OTIO_PROGRAM_MAX_BYTES);
  });

  test('subtracts the base, the reserves and one entry overhead exactly', () => {
    const headroom =
      10 * MIB -
      1000 -
      MANIFEST_RESERVE_BYTES -
      MANIFEST_RESERVE_PER_TIMELINE * 3 -
      ZIP_ENTRY_OVERHEAD_BYTES;
    expect(
      programRenderBudget({
        budget: 10 * MIB,
        baseSize: 1000,
        timelineCount: 3,
      })
    ).toBe(headroom);
  });
});
