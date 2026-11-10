import { describe, expect, test } from 'bun:test';
import type {
  OtioTimeRange,
  OtioZipIndex,
  OtioZipEntryInfo,
} from '@relic/format';
import {
  resolveOtioProgram,
  type ResolveOtioProgramInput,
} from '../src/otio-program.ts';

const rate = 24;
const timelineRange: OtioTimeRange = {
  start_time: { value: 0, rate },
  duration: { value: 240, rate },
};

/** Builds the entry the indexer would record: directories lose their trailing slash and set isDirectory. */
const entry = (
  rawName: string,
  isDirectory = rawName.endsWith('/')
): [string, OtioZipEntryInfo] => {
  const name = rawName.replace(/\/+$/, '');
  return [
    name,
    {
      name,
      method: isDirectory ? 0 : 8,
      compressedSize: 0,
      uncompressedSize: 0,
      crc32: 0,
      dataOffset: 0,
      isDirectory,
    },
  ];
};

const zipWith = (rawNames: readonly string[]): OtioZipIndex =>
  ({
    entries: new Map(rawNames.map((name) => entry(name))),
    versionText: '1.0.0',
    contentOtioBytes: new Uint8Array(),
    contentSha256: 'a'.repeat(64),
    readEntry: async () => {
      throw new Error('readEntry must not be reached in presence tests');
    },
  }) as unknown as OtioZipIndex;

/** A thunk that records whether it ran. */
const recordingThunk = () => {
  const calls = { count: 0 };
  return {
    calls,
    mediaPaths: () => {
      calls.count += 1;
      return [] as readonly string[];
    },
  };
};

const input = (
  zip: OtioZipIndex,
  mediaPaths: () => readonly string[]
): ResolveOtioProgramInput => ({
  zip,
  timelineId: 'timeline-1',
  timelineIds: ['timeline-1'],
  mediaPaths,
  timelineRange,
  canPlayType: () => 'probably',
});

describe('legacy archives', () => {
  test('a plain archive is legacy and never evaluates the media thunk', async () => {
    const thunk = recordingThunk();
    const result = await resolveOtioProgram(
      input(zipWith(['content.otio', 'version.txt']), thunk.mediaPaths)
    );
    expect(result.status).toBe('legacy');
    expect(thunk.calls.count).toBe(0);
  });

  test('a directory outside the reserved prefix is legacy', async () => {
    const thunk = recordingThunk();
    const result = await resolveOtioProgram(
      input(
        zipWith(['content.otio', 'version.txt', 'media/']),
        thunk.mediaPaths
      )
    );
    expect(result.status).toBe('legacy');
    expect(thunk.calls.count).toBe(0);
  });

  test('a directory named relic/program/ alone is legacy, matching the format', async () => {
    const thunk = recordingThunk();
    const result = await resolveOtioProgram(
      input(
        zipWith(['content.otio', 'version.txt', 'relic/program/']),
        thunk.mediaPaths
      )
    );
    expect(result.status).toBe('legacy');
    expect(thunk.calls.count).toBe(0);
  });

  test('a legacy archive whose media thunk would throw still opens as legacy', async () => {
    const result = await resolveOtioProgram(
      input(zipWith(['content.otio', 'version.txt']), () => {
        throw new RangeError('more than 65532 sequence items');
      })
    );
    expect(result.status).toBe('legacy');
  });
});

describe('program presence is not skipped', () => {
  test('a directory posing as relic/program.json/ is unavailable, never legacy', async () => {
    const thunk = recordingThunk();
    const result = await resolveOtioProgram(
      input(
        zipWith(['content.otio', 'version.txt', 'relic/program.json/']),
        thunk.mediaPaths
      )
    );
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasons[0]?.code).toBe('archive-mismatch');
    expect(thunk.calls.count).toBe(1);
  });

  test('a file under the reserved prefix with no manifest is unavailable, never legacy', async () => {
    const thunk = recordingThunk();
    const result = await resolveOtioProgram(
      input(
        zipWith([
          'content.otio',
          'version.txt',
          'relic/program/timeline-0.mp4',
        ]),
        thunk.mediaPaths
      )
    );
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasons[0]?.code).toBe('archive-mismatch');
  });

  test('a file that only shares the prefix text is still a reserved entry, as in the format', async () => {
    const thunk = recordingThunk();
    const result = await resolveOtioProgram(
      input(
        zipWith(['content.otio', 'version.txt', 'relic/programme.txt']),
        thunk.mediaPaths
      )
    );
    expect(result.status).toBe('unavailable');
  });
});

describe('thunk failure on a program archive', () => {
  test('a throwing media thunk is unavailable with a fixed message, not the thunk message', async () => {
    const result = await resolveOtioProgram(
      input(
        zipWith(['content.otio', 'version.txt', 'relic/program.json/']),
        () => {
          throw new RangeError('secret internal detail');
        }
      )
    );
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') return;
    expect(result.reasons[0]?.code).toBe('archive-mismatch');
    expect(result.reasons[0]?.message).toBe(
      'The document media for this program could not be described.'
    );
    expect(result.reasons[0]?.message).not.toContain('secret');
  });
});
