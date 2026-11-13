/**
 * Ties the analytic reference's placements to the library's own placement. The OTIO document is
 * built with the pinned OpenTimelineIO 0.18.1 generator, without media: placement is decided by
 * the document alone, so no ffmpeg work runs here. The oracle records the sha256 of the
 * content.otio it describes; each test checks that digest against the file it is about, so the
 * oracle cannot be a stale or substituted copy.
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildProgramFixture,
  type BuiltProgramFixture,
} from './otio-program-fixture.ts';
import { EXPECTED_PLACEMENTS } from './otio-program-reference.ts';

interface OracleChild {
  readonly index: number;
  readonly schema: string;
  readonly name: string;
  readonly start?: readonly [number, number];
  readonly duration?: readonly [number, number];
  readonly in_offset?: readonly [number, number];
  readonly out_offset?: readonly [number, number];
  readonly error?: string;
}
interface OracleTrack {
  readonly name: string;
  readonly kind: string;
  readonly children: readonly OracleChild[];
}
interface LibraryOracle {
  readonly otio_version: string;
  readonly content_sha256: string;
  readonly duration: readonly [number, number];
  readonly tracks: readonly OracleTrack[];
}

const scratch = await mkdtemp(join(tmpdir(), 'relic-otio-oracle-'));
const seconds = (pair: readonly [number, number]): number => pair[0] / pair[1];

async function oracleFor(variant: 'positive' | 'global-start'): Promise<{
  readonly fixture: BuiltProgramFixture;
  readonly oracle: LibraryOracle;
  readonly contentSha: string;
}> {
  const fixture = await buildProgramFixture(scratch, variant, { media: false });
  const oracle = JSON.parse(
    await readFile(fixture.libraryOraclePath, 'utf8')
  ) as LibraryOracle;
  const contentSha = createHash('sha256')
    .update(await readFile(fixture.contentOtioPath))
    .digest('hex');
  return { fixture, oracle, contentSha };
}

const positive = await oracleFor('positive');
const globalStart = await oracleFor('global-start');

describe('the oracle describes the document under test', () => {
  test('the oracle digest is the sha256 of the content.otio it was computed from', () => {
    expect(positive.oracle.content_sha256).toBe(positive.contentSha);
    expect(globalStart.oracle.content_sha256).toBe(globalStart.contentSha);
  });

  test('placement-only builds write no media', async () => {
    const media = await readdir(join(positive.fixture.bundleDir, 'media'));
    expect(media).toEqual([]);
  });
});

describe('library oracle agrees with the analytic reference', () => {
  test('the library is the pinned 0.18.1', () => {
    expect(positive.oracle.otio_version).toBe('0.18.1');
  });

  test('no child reports a library error', () => {
    const errors = positive.oracle.tracks.flatMap((t) =>
      t.children.filter((c) => c.error)
    );
    expect(errors).toEqual([]);
  });

  test('timeline duration is 6 s', () => {
    expect(seconds(positive.oracle.duration)).toBe(6);
  });

  for (const [trackName, expected] of Object.entries(EXPECTED_PLACEMENTS)) {
    test(`${trackName} placements match the library`, () => {
      const track = positive.oracle.tracks.find((t) => t.name === trackName);
      expect(track).toBeDefined();
      const items = (track?.children ?? []).filter(
        (c) => !c.schema.startsWith('Transition')
      );
      expect(items.length).toBe(expected.length);
      items.forEach((item, i) => {
        const want = expected[i];
        expect(want).toBeDefined();
        if (!item.start || !item.duration || !want)
          throw new Error(`${trackName}[${i}] has no range`);
        expect(seconds(item.start)).toBeCloseTo(want.start, 9);
        expect(seconds(item.duration)).toBeCloseTo(want.duration, 9);
      });
    });
  }

  test('the SMPTE dissolve spans 0.2 s either side of the cut', () => {
    const v1 = positive.oracle.tracks.find((t) => t.name === 'V1');
    const transition = v1?.children.find((c) =>
      c.schema.startsWith('Transition')
    );
    expect(transition?.in_offset && seconds(transition.in_offset)).toBeCloseTo(
      0.2,
      9
    );
    expect(
      transition?.out_offset && seconds(transition.out_offset)
    ).toBeCloseTo(0.2, 9);
  });
});

describe('a non-zero global_start_time does not move the library placement', () => {
  test('global-start tracks equal the positive tracks', () => {
    expect(globalStart.oracle.tracks).toEqual(positive.oracle.tracks);
  });
});
