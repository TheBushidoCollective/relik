import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  indexOtioZip,
  MAX_EXPANDED_ZIP_BYTES,
  MAX_INFLATED_ZIP_BYTES,
  MAX_OTIO_PROGRAM_MANIFEST_BYTES,
  MAX_ZIP_DIRECTORY_BYTES,
  OTIO_PROGRAM_MAX_BYTES,
  PLAINTEXT_CAP_BYTES,
  readOtioProgramArchive,
} from '@relic/format';
import { deflateRawSync } from 'node:zlib';
import { buildZipArchive } from '../src/otio-bundle.ts';
import {
  type ArchiveFacts,
  BUILD_MESSAGES,
  brokenProgramLimit,
  buildProgramArchive,
  deflateRawBound,
  programArchiveBytes,
  type ProgramPlanSize,
  programRenderBudget,
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
  ProgramRenderOutput,
} from '../src/program/render.ts';
import type { ProgramReport } from '../src/program/report.ts';
import { PublishError } from '../src/publish.ts';

const MIB = 1024 * 1024;
const ENCODER = new TextEncoder();

interface Entry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method: 0 | 8;
}

const MP4 = new Uint8Array(4096).fill(7);
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

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function rendered(
  timelineId: string,
  mp4: Uint8Array = MP4,
  program: object = PROGRAM
) {
  return {
    status: 'rendered' as const,
    timelineId,
    program,
    mp4,
    sha256: sha(mp4),
  };
}

/** A renderer that answers with whatever outcomes the test builds, and records each job. */
function rendererWith(
  jobs: ProgramRenderJob[],
  outcomes: (ids: readonly string[]) => unknown,
  browser = 'Fake Browser'
): ProgramRenderer {
  return async (job) => {
    jobs.push(job);
    return {
      browser,
      outcomes: outcomes(job.timelineIds),
    } as unknown as ProgramRenderOutput;
  };
}

/** A renderer that succeeds for every timeline and records each job it was given. */
function fakeRenderer(jobs: ProgramRenderJob[]): ProgramRenderer {
  return rendererWith(jobs, (ids) => ids.map((id) => rendered(id)));
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
  readonly renderer?: ProgramRenderer;
  readonly clientName?: string;
  readonly sourceName?: string;
}

function publish(entries: readonly Entry[], options: PublishOptions = {}) {
  return buildProgramArchive({
    archive: buildZipArchive(entries),
    sourceName: options.sourceName ?? 'show.otioz',
    sizeLimit: options.sizeLimit ?? PLAINTEXT_CAP_BYTES,
    policy: programPolicyFrom(options.env ?? {}),
    renderer: options.renderer ?? fakeRenderer(options.jobs ?? []),
    clientName: options.clientName ?? 'relic-mcp/test',
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

function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const SMALL = entriesFor([{ path: 'media/clip.mp4', size: 1024 }]);

describe('the output is parts that reference the source and the renderer output', () => {
  test('a canonical bundle keeps its source bytes and carries the program', async () => {
    const archive = buildZipArchive(SMALL);
    const result = await buildProgramArchive({
      archive,
      sourceName: 'show.otioz',
      sizeLimit: PLAINTEXT_CAP_BYTES,
      policy: programPolicyFrom({}),
      renderer: fakeRenderer([]),
      clientName: 'relic-mcp/test',
    });
    expect(result.parts[0]!.buffer).toBe(archive.buffer);
    expect(result.parts.some((p) => p === MP4)).toBe(true);
    const bytes = concatParts(result.parts);
    expect(bytes.length).toBe(result.length);
    expect(result.report.status).toBe('rendered');

    const written = await indexOtioZip(bytes);
    const verified = await readOtioProgramArchive(written, {
      document_sha256: written.contentSha256,
      timeline_ids: [result.report.timelines[0]!.timeline_id],
      media_paths: ['media/clip.mp4'],
    });
    expect(verified).not.toBeNull();
    expect([...verified!.programs.values()][0]).toEqual(MP4);
  });

  test('a raw .otio and a non-OTIO source come back unchanged', async () => {
    const archive = buildZipArchive(SMALL);
    const raw = await buildProgramArchive({
      archive,
      sourceName: 'show.otio',
      sizeLimit: PLAINTEXT_CAP_BYTES,
      policy: programPolicyFrom({}),
      renderer: undefined,
      clientName: 'relic-mcp/test',
    });
    expect(raw.parts).toHaveLength(1);
    expect(raw.parts[0]).toBe(archive);
    expect(raw.report.status).toBe('not_run');

    const other = await buildProgramArchive({
      archive,
      sourceName: 'show.zip',
      sizeLimit: PLAINTEXT_CAP_BYTES,
      policy: programPolicyFrom({}),
      renderer: undefined,
      clientName: 'relic-mcp/test',
    });
    expect(other.parts[0]).toBe(archive);
    expect(other.report.status).toBe('not_applicable');
  });
});

describe('the renderer budget is aggregate and below the program bound', () => {
  test('the renderer is given a budget below 100 MiB', async () => {
    const jobs: ProgramRenderJob[] = [];
    await publish(SMALL, { jobs });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.maxTotalBytes).toBeGreaterThan(0);
    expect(jobs[0]!.maxTotalBytes).toBeLessThan(OTIO_PROGRAM_MAX_BYTES);
  });

  test('a lowered knob reaches the renderer and never raises it', async () => {
    const jobs: ProgramRenderJob[] = [];
    await publish(SMALL, {
      jobs,
      env: { RELIC_PROGRAM_MAX_BYTES: String(8 * MIB) },
    });
    expect(jobs[0]!.maxTotalBytes).toBeLessThan(8 * MIB);
    const high: ProgramRenderJob[] = [];
    await publish(SMALL, {
      jobs: high,
      env: { RELIC_PROGRAM_MAX_BYTES: '1000000000000' },
    });
    expect(high[0]!.maxTotalBytes).toBeLessThan(OTIO_PROGRAM_MAX_BYTES);
  });

  test('a non-positive knob is refused as invalid-config', async () => {
    const refusal = await refusalOf(
      publish(SMALL, { env: { RELIC_PROGRAM_MAX_BYTES: '0' } })
    );
    expect(refusal.details['program_reason']).toBe('invalid-config');
  });

  test('a sizeLimit that is not a positive safe integer is refused as invalid-size-limit', async () => {
    for (const sizeLimit of [0, Number.NaN, -1, 1.5, 2 ** 53]) {
      const refusal = await refusalOf(publish(SMALL, { sizeLimit }));
      expect(refusal.details['program_reason']).toBe('invalid-size-limit');
    }
  });

  test('a client name the manifest cannot record is refused as invalid-config', async () => {
    const refusal = await refusalOf(
      publish(SMALL, { clientName: 'c'.repeat(129) })
    );
    expect(refusal.details['program_reason']).toBe('invalid-config');
    expect(refusal.message).toBe(BUILD_MESSAGES.clientInvalid);
  });

  test('the program budget is the smallest of the cap, the policy and the program bound', () => {
    expect(
      programArchiveBudget(PLAINTEXT_CAP_BYTES + 1, programPolicyFrom({}))
    ).toBe(PLAINTEXT_CAP_BYTES);
    expect(
      programArchiveBudget(
        8 * MIB,
        programPolicyFrom({ RELIC_PROGRAM_MAX_BYTES: '9000000' })
      )
    ).toBe(8 * MIB);
  });
});

describe('the reserved plan decides whether a program can start at all', () => {
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

  test('a limit that fits the manifest but not the reserved plan skips the renderer', async () => {
    const jobs: ProgramRenderJob[] = [];
    const sizeLimit = baseSizeOf(SMALL) + 1500;
    const { report } = await publish(SMALL, { jobs, sizeLimit });
    expect(jobs).toHaveLength(0);
    expect(report.status).toBe('unavailable');
    expect(report.timelines[0]!.reasons[0]!.code).toBe('size-cap-exceeded');
  });
});

describe('render input guard', () => {
  test('a single 64 MiB media entry is within the render input bounds', () => {
    expect(
      programRenderInputWithinBounds([{ size: RENDER_INPUT_MAX_ENTRY_BYTES }])
    ).toBe(true);
  });

  test('a 64 MiB + 1 media entry is focus-only and no browser starts', async () => {
    const jobs: ProgramRenderJob[] = [];
    const entries = entriesFor([
      { path: 'media/big.mp4', size: RENDER_INPUT_MAX_ENTRY_BYTES + 1 },
    ]);
    const { report } = await publish(entries, { jobs });
    expect(jobs).toHaveLength(0);
    expect(report.status).toBe('unavailable');
    expect(report.timelines[0]!.reasons[0]!.message).toBe(
      BUILD_MESSAGES.renderInput
    );
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
});

describe('a renderer outcome that fails validation loses only its own timeline', () => {
  const cases: [string, (id: string) => unknown, string][] = [
    [
      'the program is missing',
      (id) => ({
        status: 'rendered',
        timelineId: id,
        mp4: MP4,
        sha256: sha(MP4),
      }),
      BUILD_MESSAGES.programInvalid,
    ],
    [
      'the width is 4098',
      (id) => rendered(id, MP4, { ...PROGRAM, width: 4098 }),
      BUILD_MESSAGES.programInvalid,
    ],
    [
      'the frame rate is 1.5',
      (id) =>
        rendered(id, MP4, { ...PROGRAM, frame_rate: { num: 24, den: 1.5 } }),
      BUILD_MESSAGES.programInvalid,
    ],
    [
      'the codec is hev1',
      (id) => rendered(id, MP4, { ...PROGRAM, video_codec: 'hev1.1.6.L93.B0' }),
      BUILD_MESSAGES.programInvalid,
    ],
    [
      'the frames disagree with the duration',
      (id) => rendered(id, MP4, { ...PROGRAM, frames: 5 }),
      BUILD_MESSAGES.programInvalid,
    ],
    [
      'the range does not match the timeline',
      (id) =>
        rendered(id, MP4, {
          ...PROGRAM,
          range: {
            start_time: { value: 0, rate: 24 },
            duration: { value: 48, rate: 24 },
          },
          frames: 48,
          audio_samples: 96000,
        }),
      BUILD_MESSAGES.programRange,
    ],
    [
      'the sha256 does not match the bytes',
      (id) => ({ ...rendered(id), sha256: '0'.repeat(64) }),
      'the program output did not match the page digest',
    ],
    [
      'the timeline id belongs to another timeline',
      (id) => ({ ...rendered(id), timelineId: 'someone-else' }),
      'the program page answered for a different document or timeline',
    ],
    [
      'the reasons are empty',
      () => ({ status: 'unavailable', reasons: [] }),
      BUILD_MESSAGES.reasonsInvalid,
    ],
    [
      'a reason code is unknown',
      () => ({
        status: 'unavailable',
        reasons: [{ code: 'not-a-code', message: 'x' }],
      }),
      BUILD_MESSAGES.reasonsInvalid,
    ],
    [
      'the outcome is not an object',
      () => 'rendered',
      'the renderer returned no outcome for this timeline',
    ],
  ];

  for (const [name, outcome, message] of cases) {
    test(`${name}: the timeline is focus-only with its fixed reason and the publish succeeds`, async () => {
      const { report, parts } = await publish(SMALL, {
        renderer: rendererWith([], (ids) => ids.map(outcome)),
      });
      expect(parts.length).toBeGreaterThan(0);
      expect(report.status).toBe('unavailable');
      expect(report.timelines[0]!.reasons[0]!.message).toBe(message);
    });
  }

  test('outcomes that are not an array leave every timeline with the no-outcome reason', async () => {
    const renderer: ProgramRenderer = async () =>
      ({
        browser: 'Fake Browser',
        outcomes: 'nope',
      }) as unknown as ProgramRenderOutput;
    const { report } = await publish(SMALL, { renderer });
    expect(report.timelines[0]!.reasons[0]!.code).toBe('render-failed');
  });

  test('a browser identity that cannot be recorded gives every timeline the browser reason', async () => {
    const jobs: ProgramRenderJob[] = [];
    const longBrowser = 'B'.repeat(200);
    const { report } = await publish(SMALL, {
      renderer: rendererWith(
        jobs,
        (ids) => ids.map((id) => rendered(id)),
        longBrowser
      ),
    });
    expect(report.status).toBe('unavailable');
    expect(report.timelines[0]!.reasons[0]!.message).toBe(
      BUILD_MESSAGES.browserIdentity
    );
  });
});

describe('admission keeps the archive inside every reader limit', () => {
  test('a 60 MiB program on a 60 MiB media entry stays inside the program bound', async () => {
    const big = new Uint8Array(60 * MIB).fill(3);
    const renderer: ProgramRenderer = async (job) =>
      ({
        browser: 'Fake Browser',
        outcomes: job.timelineIds.map((id) => rendered(id, big)),
      }) as unknown as ProgramRenderOutput;
    const { report } = await publish(
      entriesFor([{ path: 'media/clip.mp4', size: 60 * MIB }]),
      {
        renderer,
      }
    );
    expect(report.status).toBe('rendered');
    expect(report.timelines[0]!.program!.bytes).toBe(big.length);
  }, 60_000);

  test('a canonical source is accepted and its planned length equals its parts', async () => {
    const result = await publish(SMALL);
    expect(result.length).toBeGreaterThan(baseSizeOf(SMALL));
    expect(result.length).toBeLessThanOrEqual(PLAINTEXT_CAP_BYTES);
  });

  test('an entry name outside the canonical set is refused as unsafe-entry', async () => {
    const withJunk: Entry[] = [
      ...SMALL,
      { name: 'junk/', data: new Uint8Array(), method: 0 },
    ];
    const refusal = await refusalOf(publish(withJunk));
    expect(refusal.details['program_reason']).toBe('unsafe-entry');
  });

  test('a directory entry that carries data is refused as unsafe-entry', async () => {
    const withData: Entry[] = [
      ...SMALL,
      { name: 'media/', data: new Uint8Array([1, 2, 3]), method: 0 },
    ];
    const refusal = await refusalOf(publish(withData));
    expect(refusal.details['program_reason']).toBe('unsafe-entry');
  });
});

describe('the planner bounds each reader limit exactly', () => {
  const facts: ArchiveFacts = {
    prefixBytes: 1000,
    directoryBytes: 200,
    entryCount: 3,
    commentBytes: 0,
    expandedBytes: 1000,
    deflateBytes: 100,
  };
  const plan: ProgramPlanSize = {
    manifestBytes: 500,
    manifestCompressedBytes: 300,
    programCount: 0,
    programNameBytes: 0,
    programBytes: 0,
  };

  test('the archive size formula matches the reader layout', () => {
    // prefix + (30 + 18 + 300) + 200 + (46 + 18) + 22
    expect(programArchiveBytes(facts, plan)).toBe(1634);
  });

  test('the archive limit accepts exactly its size and breaks one byte under', () => {
    expect(brokenProgramLimit(1634, facts, plan)).toBeUndefined();
    expect(brokenProgramLimit(1633, facts, plan)?.limit).toBe('archive-bytes');
  });

  test('the manifest limit accepts its cap and breaks one byte over', () => {
    const at = { ...plan, manifestBytes: MAX_OTIO_PROGRAM_MANIFEST_BYTES };
    expect(
      brokenProgramLimit(PLAINTEXT_CAP_BYTES, facts, {
        ...at,
        manifestCompressedBytes: 1,
      })?.limit
    ).toBeUndefined();
    const over = {
      ...plan,
      manifestBytes: MAX_OTIO_PROGRAM_MANIFEST_BYTES + 1,
    };
    expect(brokenProgramLimit(PLAINTEXT_CAP_BYTES, facts, over)?.limit).toBe(
      'manifest-bytes'
    );
  });

  test('the program limit accepts exactly 100 MiB together and breaks one byte over', () => {
    const fits = {
      ...plan,
      programBytes: OTIO_PROGRAM_MAX_BYTES - plan.manifestBytes,
    };
    expect(
      brokenProgramLimit(PLAINTEXT_CAP_BYTES, facts, fits)
    ).toBeUndefined();
    const over = { ...fits, programBytes: fits.programBytes + 1 };
    expect(brokenProgramLimit(PLAINTEXT_CAP_BYTES, facts, over)?.limit).toBe(
      'program-bytes'
    );
  });

  test('the deflate and expanded limits accept exactly and break one byte over', () => {
    const deflate = {
      ...facts,
      deflateBytes: MAX_INFLATED_ZIP_BYTES - plan.manifestBytes,
    };
    expect(
      brokenProgramLimit(PLAINTEXT_CAP_BYTES, deflate, plan)
    ).toBeUndefined();
    const deflateOver = { ...facts, deflateBytes: deflate.deflateBytes + 1 };
    expect(
      brokenProgramLimit(PLAINTEXT_CAP_BYTES, deflateOver, plan)?.limit
    ).toBe('deflate-bytes');

    const expanded = {
      ...facts,
      expandedBytes: MAX_EXPANDED_ZIP_BYTES - plan.manifestBytes,
    };
    expect(
      brokenProgramLimit(PLAINTEXT_CAP_BYTES, expanded, plan)
    ).toBeUndefined();
    const expandedOver = {
      ...facts,
      expandedBytes: expanded.expandedBytes + 1,
    };
    expect(
      brokenProgramLimit(PLAINTEXT_CAP_BYTES, expandedOver, plan)?.limit
    ).toBe('expanded-bytes');
  });

  test('the entry count stays below the 0xFFFF sentinel', () => {
    // 65533 base entries plus the manifest is 65534, the largest the reader takes.
    const fits = { ...facts, entryCount: 65533 };
    expect(brokenProgramLimit(PLAINTEXT_CAP_BYTES, fits, plan)).toBeUndefined();
    const over = { ...facts, entryCount: 65534 };
    const broken = brokenProgramLimit(PLAINTEXT_CAP_BYTES, over, plan);
    expect(broken?.limit).toBe('entry-count');
    expect(broken?.allowed).toBe(0xfffe);
  });

  test('the central directory accepts its size and breaks one byte over', () => {
    const fits = { ...facts, directoryBytes: MAX_ZIP_DIRECTORY_BYTES - 64 };
    expect(
      brokenProgramLimit(PLAINTEXT_CAP_BYTES * 4, fits, plan)
    ).toBeUndefined();
    const over = { ...facts, directoryBytes: fits.directoryBytes + 1 };
    expect(brokenProgramLimit(PLAINTEXT_CAP_BYTES * 4, over, plan)?.limit).toBe(
      'directory-bytes'
    );
  });

  test('the programArchiveBudget never exceeds its cap', () => {
    expect(
      programArchiveBudget(PLAINTEXT_CAP_BYTES + 1, programPolicyFrom({}))
    ).toBe(PLAINTEXT_CAP_BYTES);
  });

  test('a DEFLATE stream never exceeds its bound', () => {
    for (const n of [0, 1, 1000, 65_536, 200_000]) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = (i * 2654435761) & 0xff;
      expect(deflateRawSync(data, { level: 9 }).length).toBeLessThanOrEqual(
        deflateRawBound(n)
      );
    }
  });

  test('the render budget is below the program bound and the manifest reserve is subtracted', () => {
    const budget = programRenderBudget({
      budget: PLAINTEXT_CAP_BYTES,
      facts,
      manifestBytes: 1000,
      timelineCount: 2,
    });
    expect(budget).toBeLessThan(OTIO_PROGRAM_MAX_BYTES);
    expect(budget).toBeLessThanOrEqual(OTIO_PROGRAM_MAX_BYTES - 1000);
  });
});

describe('the report and the reader agree on what was rendered', () => {
  test('the report says rendered when every timeline is rendered', async () => {
    const result = await publish(SMALL);
    const report: ProgramReport = result.report;
    expect(report.status).toBe('rendered');
    expect(report.timelines[0]!.program!.bytes).toBe(MP4.length);
  });
});
