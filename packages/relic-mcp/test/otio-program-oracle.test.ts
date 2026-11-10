/**
 * Ties the analytic reference's placements to the library's own placement. The fixture is built
 * with the pinned OpenTimelineIO 0.18.1 generator; its oracle lists where the library puts every
 * stack child. EXPECTED_PLACEMENTS must agree with that, or the reference is describing a
 * different timeline than the one that gets rendered.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgramFixture } from './otio-program-fixture.ts';
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
  readonly duration: readonly [number, number];
  readonly tracks: readonly OracleTrack[];
}

const scratch = await mkdtemp(join(tmpdir(), 'relic-otio-oracle-'));
const fixture = await buildProgramFixture(scratch, 'positive');
const oracle = JSON.parse(
  await readFile(fixture.libraryOraclePath, 'utf8')
) as LibraryOracle;

const seconds = (pair: readonly [number, number]): number => pair[0] / pair[1];

describe('library oracle agrees with the analytic reference', () => {
  test('the library is the pinned 0.18.1', () => {
    expect(oracle.otio_version).toBe('0.18.1');
  });

  test('no child reports a library error', () => {
    const errors = oracle.tracks.flatMap((t) =>
      t.children.filter((c) => c.error)
    );
    expect(errors).toEqual([]);
  });

  test('timeline duration is 6 s', () => {
    expect(seconds(oracle.duration)).toBe(6);
  });

  for (const [trackName, expected] of Object.entries(EXPECTED_PLACEMENTS)) {
    test(`${trackName} placements match the library`, () => {
      const track = oracle.tracks.find((t) => t.name === trackName);
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
    const v1 = oracle.tracks.find((t) => t.name === 'V1');
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
  test('global-start tracks equal the positive tracks', async () => {
    const origin = await buildProgramFixture(scratch, 'global-start');
    const globalOracle = JSON.parse(
      await readFile(origin.libraryOraclePath, 'utf8')
    ) as LibraryOracle;
    expect(globalOracle.tracks).toEqual(oracle.tracks);
  });
});
