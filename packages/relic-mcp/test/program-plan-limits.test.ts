import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { OTIO_DOCUMENT_MAX_BYTES, PLAINTEXT_CAP_BYTES } from '@relic/format';
import { buildZipArchive } from '../src/otio-bundle.ts';
import { BUILD_MESSAGES, buildProgramArchive } from '../src/program/build.ts';
import { programPolicyFrom } from '../src/program/policy.ts';
import type {
  ProgramRenderer,
  ProgramRenderJob,
  ProgramRenderOutput,
} from '../src/program/render.ts';
import { PublishError } from '../src/publish.ts';

const ENCODER = new TextEncoder();
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
};

interface Entry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly method: 0 | 8;
}

/** A one-clip document whose only reference is `mediaPath`. */
function clipDocument(mediaPath: string): Uint8Array {
  return ENCODER.encode(
    JSON.stringify({
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
            children: [
              {
                OTIO_SCHEMA: 'Clip.1',
                name: 'clip',
                metadata: { relic: { id: 'clip' } },
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
    })
  );
}

/** A canonical bundle with `total` entries in all, counting content.otio and version.txt. */
function bundleWithEntries(total: number): Entry[] {
  const entries: Entry[] = [
    { name: 'content.otio', data: clipDocument('media/f00000.bin'), method: 8 },
    { name: 'version.txt', data: ENCODER.encode('1.0.0'), method: 8 },
  ];
  for (let i = 0; i < total - 2; i++) {
    entries.push({
      name: `media/f${String(i).padStart(5, '0')}.bin`,
      data: new Uint8Array([i & 0xff]),
      method: 0,
    });
  }
  return entries;
}

/** Incompressible bytes, so DEFLATE stores them and the compressed size is about the input size. */
function incompressible(size: number): Uint8Array {
  const out = new Uint8Array(size);
  const chunk = 65536;
  for (let at = 0; at < size; at += chunk) {
    crypto.getRandomValues(out.subarray(at, Math.min(size, at + chunk)));
  }
  return out;
}

function renderedFor(jobs: ProgramRenderJob[]): ProgramRenderer {
  return async (job) => {
    jobs.push(job);
    return {
      browser: 'Fake Browser',
      outcomes: job.timelineIds.map((id) => ({
        status: 'rendered' as const,
        timelineId: id,
        program: PROGRAM,
        mp4: MP4,
        sha256: createHash('sha256').update(MP4).digest('hex'),
      })),
    } as unknown as ProgramRenderOutput;
  };
}

async function publishOf(entries: readonly Entry[], jobs: ProgramRenderJob[]) {
  return buildProgramArchive({
    archive: buildZipArchive(entries),
    sourceName: 'show.otioz',
    sizeLimit: PLAINTEXT_CAP_BYTES,
    policy: programPolicyFrom({}),
    renderer: renderedFor(jobs),
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

describe('a DEFLATE entry the reader cannot load is refused with its size, before any read or render', () => {
  test('a DEFLATE entry that compresses past 100 MiB is refused as entry-too-large, not output-invalid', async () => {
    // 100 MiB less 1 KiB of incompressible data: its DEFLATE stream carries
    // stored-block overhead that pushes the compressed size over 100 MiB.
    const media = incompressible(OTIO_DOCUMENT_MAX_BYTES - 1024);
    const entries: Entry[] = [
      { name: 'content.otio', data: clipDocument('media/big.bin'), method: 8 },
      { name: 'version.txt', data: ENCODER.encode('1.0.0'), method: 8 },
      { name: 'media/big.bin', data: media, method: 8 },
    ];
    const jobs: ProgramRenderJob[] = [];
    const refusal = await refusalOf(publishOf(entries, jobs));
    expect(refusal.code).toBe('program_refused');
    expect(refusal.details['program_reason']).toBe('entry-too-large');
    expect(refusal.message).toBe(BUILD_MESSAGES.entryTooLarge);
    expect(refusal.details['limit']).toBe('entry-bytes');
    expect(refusal.details['size_limit_bytes']).toBe(OTIO_DOCUMENT_MAX_BYTES);
    expect(refusal.details['size_basis']).toBe('deflate-entry');
    // The declared size is the one that breaks the limit: the compressed size.
    expect(refusal.details['declared_size_bytes'] as number).toBeGreaterThan(
      OTIO_DOCUMENT_MAX_BYTES
    );
    expect(jobs).toHaveLength(0);
  }, 120_000);

  test('a STORED entry of 200 MiB is preserved and focus-only, because a STORED entry is streamed', async () => {
    const media = new Uint8Array(200 * 1024 * 1024).fill(5);
    const entries: Entry[] = [
      { name: 'content.otio', data: clipDocument('media/huge.bin'), method: 8 },
      { name: 'version.txt', data: ENCODER.encode('1.0.0'), method: 8 },
      { name: 'media/huge.bin', data: media, method: 0 },
    ];
    const archive = buildZipArchive(entries);
    const jobs: ProgramRenderJob[] = [];
    const result = await buildProgramArchive({
      archive,
      sourceName: 'show.otioz',
      sizeLimit: PLAINTEXT_CAP_BYTES,
      policy: programPolicyFrom({}),
      renderer: renderedFor(jobs),
      clientName: 'relic-mcp/test',
    });
    // Not refused: the source is kept as the same bytes, and only the program is focus-only.
    expect(result.parts[0]!.buffer).toBe(archive.buffer);
    expect(jobs).toHaveLength(0);
    expect(result.report.status).toBe('unavailable');
    expect(result.report.timelines[0]!.reasons[0]!.message).toBe(
      BUILD_MESSAGES.renderInput
    );
  }, 120_000);

  test('a STORED entry exactly 100 MiB is not refused for its size', async () => {
    // The limit is inclusive: exactly the reader's maximum is loadable.
    const entries: Entry[] = [
      {
        name: 'content.otio',
        data: clipDocument('media/exact.bin'),
        method: 8,
      },
      { name: 'version.txt', data: ENCODER.encode('1.0.0'), method: 8 },
      {
        name: 'media/exact.bin',
        data: new Uint8Array(OTIO_DOCUMENT_MAX_BYTES),
        method: 0,
      },
    ];
    const jobs: ProgramRenderJob[] = [];
    const result = await publishOf(entries, jobs);
    // Loadable by the reader, but over the render input bound, so it is
    // focus-only with that exact reason and no browser starts.
    expect(jobs).toHaveLength(0);
    expect(result.report.status).toBe('unavailable');
    expect(result.report.timelines[0]!.reasons[0]!.message).toBe(
      BUILD_MESSAGES.renderInput
    );
  }, 120_000);
});

describe('no room for even one program entry: the renderer does not start', () => {
  test('65,533 entries leave no room for one program, so no browser starts and the timeline is focus-only', async () => {
    const jobs: ProgramRenderJob[] = [];
    const result = await publishOf(bundleWithEntries(65_533), jobs);
    expect(jobs).toHaveLength(0);
    expect(result.report.status).toBe('unavailable');
    expect(result.report.timelines[0]!.reasons[0]!.code).toBe(
      'size-cap-exceeded'
    );
    expect(result.report.timelines[0]!.reasons[0]!.message).toBe(
      BUILD_MESSAGES.sizeCap
    );
  }, 120_000);

  test('65,532 entries leave room for exactly one program, so the renderer runs and the timeline renders', async () => {
    const jobs: ProgramRenderJob[] = [];
    const result = await publishOf(bundleWithEntries(65_532), jobs);
    expect(jobs).toHaveLength(1);
    expect(result.report.status).toBe('rendered');
  }, 120_000);

  test('65,534 entries cannot hold even the manifest: refused as manifest-unfit with the entry-count limit', async () => {
    const jobs: ProgramRenderJob[] = [];
    const refusal = await refusalOf(publishOf(bundleWithEntries(65_534), jobs));
    expect(refusal.details['program_reason']).toBe('manifest-unfit');
    expect(refusal.details['limit']).toBe('entry-count');
    expect(refusal.details['entry_limit']).toBe(0xfffe);
    expect(refusal.details['declared_entries']).toBe(0xffff);
    expect(jobs).toHaveLength(0);
  }, 120_000);
});
