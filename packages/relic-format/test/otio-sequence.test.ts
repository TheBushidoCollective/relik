import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  otioSequenceFrameEntries,
  readOtioImageSequence,
} from '../src/otio-sequence.ts';
import type { OtioImageSequence } from '../src/otio-sequence.ts';
import type { OtioMediaEntry } from '../src/otio-types.ts';

function timeRange(value = 48, rate = 24): Record<string, unknown> {
  return {
    OTIO_SCHEMA: 'TimeRange.1',
    start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 0, rate },
    duration: { OTIO_SCHEMA: 'RationalTime.1', value, rate },
  };
}

function imageSequence(
  overrides: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    OTIO_SCHEMA: 'ImageSequenceReference.1',
    target_url_base: 'media/',
    name_prefix: 'plate_',
    name_suffix: '.png',
    start_frame: 1001,
    frame_step: 1,
    rate: 24,
    frame_zero_padding: 4,
    available_range: timeRange(),
    ...overrides,
  };
}

function requiredSequence(record: unknown): OtioImageSequence {
  const read = readOtioImageSequence(record);
  if (!read.ok) throw new Error(read.reason);
  return read.sequence;
}

function mediaIndex(names: readonly string[]): Record<string, OtioMediaEntry> {
  const media = Object.create(null) as Record<string, OtioMediaEntry>;
  for (const name of names) {
    media[name] = {
      key: name,
      bundle_path: name,
      size: 1,
      sha256: 'a'.repeat(64),
    };
  }
  return media;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected object');
  }
  return value as Record<string, unknown>;
}

function oracleSequences(
  value: unknown,
  found: Record<string, unknown>[]
): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) oracleSequences(item, found);
    return;
  }
  const record = asRecord(value);
  if (record['schema'] === 'ImageSequenceReference.1') found.push(record);
  for (const key of Object.keys(record)) oracleSequences(record[key], found);
}

function rawOracleSequence(
  vector: Record<string, unknown>
): Record<string, unknown> {
  const range = asRecord(vector['available_range']);
  const duration = asRecord(range['duration']);
  return {
    OTIO_SCHEMA: 'ImageSequenceReference.1',
    target_url_base: vector['target_url_base'],
    name_prefix: vector['name_prefix'],
    name_suffix: vector['name_suffix'],
    start_frame: vector['start_frame'],
    frame_step: vector['frame_step'],
    rate: vector['rate'],
    frame_zero_padding: vector['frame_zero_padding'],
    available_range: {
      OTIO_SCHEMA: 'TimeRange.1',
      duration: {
        OTIO_SCHEMA: 'RationalTime.1',
        value: duration['value'],
        rate: duration['rate'],
      },
    },
  };
}

interface OracleSequenceVector {
  readonly number_of_images_in_sequence: number;
  readonly images: readonly {
    readonly image_index: number;
    readonly target_url: string;
  }[];
}

function oracleSequenceVector(
  vector: Record<string, unknown>
): OracleSequenceVector {
  const count = vector['number_of_images_in_sequence'];
  const rawImages = vector['images'];
  if (typeof count !== 'number' || !Array.isArray(rawImages)) {
    throw new Error('expected oracle image-sequence vector');
  }
  const images = rawImages.map((image) => {
    const record = asRecord(image);
    const imageIndex = record['image_index'];
    const targetUrl = record['target_url'];
    if (typeof imageIndex !== 'number' || typeof targetUrl !== 'string') {
      throw new Error('expected oracle image');
    }
    return { image_index: imageIndex, target_url: targetUrl };
  });
  return { number_of_images_in_sequence: count, images };
}

describe('OTIO image-sequence semantics', () => {
  test('matches every official image-sequence oracle vector', () => {
    const oracle = JSON.parse(
      readFileSync(
        new URL('./fixtures/otio/expected-oracle.json', import.meta.url),
        'utf8'
      )
    ) as unknown;
    const vectors: Record<string, unknown>[] = [];
    oracleSequences(oracle, vectors);
    expect(vectors.length).toBeGreaterThan(0);

    for (const vector of vectors) {
      const sequence = requiredSequence(rawOracleSequence(vector));
      const oracleVector = oracleSequenceVector(vector);
      expect(sequence.count).toBe(oracleVector.number_of_images_in_sequence);
      expect(oracleVector.images.length).toBe(
        oracleVector.number_of_images_in_sequence
      );
      for (const image of oracleVector.images) {
        expect(sequence.url(image.image_index)).toBe(image.target_url);
        expect<string | null>(sequence.entry(image.image_index)).toBe(
          image.target_url
        );
      }
    }
  });

  test('uses official URL joining, count, padding, and zero-image rules', () => {
    const slashPrefix = requiredSequence(
      imageSequence({ target_url_base: 'media', name_prefix: '/plate_' })
    );
    expect(slashPrefix.url(0)).toBe('media//plate_1001.png');
    expect<string | null>(slashPrefix.entry(0)).toBe('media/plate_1001.png');

    const rootBase = requiredSequence(imageSequence({ target_url_base: '' }));
    expect(rootBase.url(0)).toBe('plate_1001.png');
    expect<string | null>(rootBase.entry(0)).toBe('media/plate_1001.png');

    const querySuffix = requiredSequence(
      imageSequence({ name_suffix: '.png?v=1' })
    );
    expect(querySuffix.url(0)).toBe('media/plate_1001.png?v=1');
    expect<string | null>(querySuffix.entry(0)).toBe('media/plate_1001.png');

    const backslashBase = requiredSequence(
      imageSequence({ target_url_base: 'media\\' })
    );
    expect(backslashBase.url(0)).toBe('media\\/plate_1001.png');
    expect<string | null>(backslashBase.entry(0)).toBe('media/plate_1001.png');

    const frameBase = requiredSequence(
      imageSequence({ target_url_base: 'frames' })
    );
    expect<string | null>(frameBase.entry(0)).toBe('media/frames/plate_1001.png');

    const traversingBase = requiredSequence(
      imageSequence({ target_url_base: 'media/sub/../' })
    );
    expect(traversingBase.url(0)).toBe('media/sub/../plate_1001.png');
    expect(traversingBase.entry(0)).toBeNull();

    const mixedRate = requiredSequence(imageSequence({ rate: 30 }));
    expect(mixedRate.count).toBe(60);
    const stepped = requiredSequence(
      imageSequence({ frame_step: 2, available_range: timeRange(7, 24) })
    );
    expect(stepped.count).toBe(3);
    const signed = requiredSequence(
      imageSequence({ start_frame: -3, frame_zero_padding: 4 })
    );
    expect(signed.url(0)).toBe('media/plate_-0003.png');

    const defaults = requiredSequence({
      OTIO_SCHEMA: 'ImageSequenceReference.1',
    });
    expect(defaults.count).toBe(0);
    expect(defaults.startFrame).toBe(1);
    expect(defaults.frameStep).toBe(1);
    expect(() => defaults.entry(0)).toThrow(RangeError);
    const noRange = requiredSequence(
      imageSequence({ available_range: null, missing_frame_policy: 'black' })
    );
    expect(noRange.count).toBe(0);
    expect(() => noRange.url(0)).toThrow(RangeError);
  });

  test('refuses malformed or bounded-out sequence descriptions', () => {
    const refused = [
      { OTIO_SCHEMA: 'ExternalReference.1' },
      imageSequence({ frame_zero_padding: 33 }),
      imageSequence({ frame_step: 0 }),
      imageSequence({ available_range: timeRange(65533, 1), rate: 1 }),
      imageSequence({ name_prefix: 'x'.repeat(1020) }),
      imageSequence({ target_url_base: 7 }),
      imageSequence({ available_range: { OTIO_SCHEMA: 'TimeRange.1' } }),
    ];
    for (const record of refused) {
      expect(readOtioImageSequence(record).ok).toBe(false);
    }
  });

  test('enumerates exactly the canonical indexed sequence frames once', () => {
    const record = imageSequence();
    const names = Array.from(
      { length: 48 },
      (_, index) => `media/plate_${String(index + 1001).padStart(4, '0')}.png`
    );
    const media = mediaIndex(names);
    expect<readonly string[]>(otioSequenceFrameEntries(record, media)).toEqual(names);
    expect(
      otioSequenceFrameEntries(
        imageSequence({ target_url_base: 'media/sub/../' }),
        media
      )
    ).toEqual([]);
  });

  test('decodes canonical entry names exactly once', () => {
    expect<string | null>(
      requiredSequence(imageSequence({ name_prefix: 'a%20b_' })).entry(0)
    ).toBe('media/a b_1001.png');
    expect<string | null>(
      requiredSequence(imageSequence({ name_prefix: 'a%2520b_' })).entry(0)
    ).toBe('media/a%20b_1001.png');
    expect<string | null>(
      requiredSequence(imageSequence({ name_prefix: '%3F_' })).entry(0)
    ).toBe('media/?_1001.png');
    expect<string | null>(
      requiredSequence(imageSequence({ name_prefix: '%25_' })).entry(0)
    ).toBe('media/%_1001.png');
    expect<string | null>(
      requiredSequence(imageSequence({ name_prefix: '%23_' })).entry(0)
    ).toBe('media/#_1001.png');
  });
});
