import { describe, expect, test } from 'bun:test';
import {
  type IsoEditGateFailure,
  MAX_ISO_BOX_HEADERS,
  type OtioVideoTimingByteReader,
  readSafeIsoPresentationEdit,
} from '../src/otio-video-timing-iso.ts';

type Edit = {
  readonly duration: number;
  readonly mediaTime: number;
  readonly rateInteger?: number;
  readonly rateFraction?: number;
};

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function fourcc(type: string): Uint8Array {
  if (type.length !== 4) throw new Error(`expected fourcc, got ${type}`);
  return new TextEncoder().encode(type);
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, result.byteLength);
  result.set(fourcc(type), 4);
  result.set(payload, 8);
  return result;
}

function wideBox(type: string, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(16 + payload.byteLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, 1);
  result.set(fourcc(type), 4);
  view.setBigUint64(8, BigInt(result.byteLength));
  result.set(payload, 16);
  return result;
}

function mvhd(timescale: number, version: 0 | 1): Uint8Array {
  const payload = new Uint8Array(24);
  const view = new DataView(payload.buffer);
  payload[0] = version;
  if (version === 0) view.setUint32(12, timescale);
  else view.setUint32(20, timescale);
  return box('mvhd', payload);
}

function tkhd(trackId: number, version: 0 | 1): Uint8Array {
  const payload = new Uint8Array(24);
  const view = new DataView(payload.buffer);
  payload[0] = version;
  if (version === 0) view.setUint32(12, trackId);
  else view.setUint32(20, trackId);
  return box('tkhd', payload);
}

function elst(entries: readonly Edit[], version: 0 | 1): Uint8Array {
  const entryBytes = version === 0 ? 12 : 20;
  const payload = new Uint8Array(8 + entries.length * entryBytes);
  const view = new DataView(payload.buffer);
  payload[0] = version;
  view.setUint32(4, entries.length);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) throw new Error('missing edit entry');
    const offset = 8 + index * entryBytes;
    if (version === 0) {
      view.setUint32(offset, entry.duration);
      view.setInt32(offset + 4, entry.mediaTime);
      view.setInt16(offset + 8, entry.rateInteger ?? 1);
      view.setInt16(offset + 10, entry.rateFraction ?? 0);
    } else {
      view.setBigUint64(offset, BigInt(entry.duration));
      view.setBigInt64(offset + 8, BigInt(entry.mediaTime));
      view.setInt16(offset + 16, entry.rateInteger ?? 1);
      view.setInt16(offset + 18, entry.rateFraction ?? 0);
    }
  }
  return box('elst', payload);
}

function isoMovie(
  options: {
    readonly trackId?: number;
    readonly timescale?: number;
    readonly edits?: readonly Edit[];
    readonly version?: 0 | 1;
    readonly extendedMoov?: boolean;
  } = {}
): Uint8Array {
  const version = options.version ?? 0;
  const trackId = options.trackId ?? 7;
  const timescale = options.timescale ?? 1000;
  const trackChildren = [tkhd(trackId, version)];
  if (options.edits) {
    trackChildren.push(box('edts', elst(options.edits, version)));
  }
  const moovPayload = concatenate([
    mvhd(timescale, version),
    box('trak', concatenate(trackChildren)),
  ]);
  return options.extendedMoov
    ? wideBox('moov', moovPayload)
    : box('moov', moovPayload);
}

function reader(bytes: Uint8Array): OtioVideoTimingByteReader {
  return {
    size: bytes.byteLength,
    read(start, end) {
      return Promise.resolve(bytes.slice(start, end));
    },
  };
}

describe('narrow ISO edit safety gate', () => {
  test('accepts one effective forward rate-one edit', async () => {
    const result = await readSafeIsoPresentationEdit(
      reader(isoMovie({ edits: [{ duration: 1000, mediaTime: 0 }] })),
      7
    );

    expect(result).toEqual({
      start: 0,
      end: 1,
      endMovieTicks: 1000,
      movieTimescale: 1000,
    });
  });

  test('accounts for one leading empty edit without replacing packet timing', async () => {
    const result = await readSafeIsoPresentationEdit(
      reader(
        isoMovie({
          edits: [
            { duration: 500, mediaTime: -1 },
            { duration: 1000, mediaTime: 1024 },
          ],
        })
      ),
      7
    );

    expect(result).toEqual({
      start: 0.5,
      end: 1.5,
      endMovieTicks: 1500,
      movieTimescale: 1000,
    });
  });

  test('supports 64-bit ISO sizes and version-one movie and edit fields', async () => {
    const result = await readSafeIsoPresentationEdit(
      reader(
        isoMovie({
          version: 1,
          extendedMoov: true,
          edits: [{ duration: 3000, mediaTime: 0 }],
        })
      ),
      7
    );

    expect(result).toEqual({
      start: 0,
      end: 3,
      endMovieTicks: 3000,
      movieTimescale: 1000,
    });
  });

  test('accepts an absent selected-track edit list', async () => {
    await expect(
      readSafeIsoPresentationEdit(reader(isoMovie()), 7)
    ).resolves.toBe(null);
  });

  test('rejects rate changes, empty-only lists, and ambiguous selected tracks', async () => {
    for (const bytes of [
      isoMovie({ edits: [{ duration: 1000, mediaTime: 0, rateInteger: 2 }] }),
      isoMovie({ edits: [{ duration: 1000, mediaTime: -1 }] }),
      isoMovie({ trackId: 8, edits: [{ duration: 1000, mediaTime: 0 }] }),
    ]) {
      await expect(
        readSafeIsoPresentationEdit(reader(bytes), 7)
      ).rejects.toEqual(
        expect.objectContaining({
          reason: 'unsupported-edit-list',
        } satisfies Pick<IsoEditGateFailure, 'reason'>)
      );
    }
  });

  test('rejects unsafe version-one edit durations and endpoint sums', async () => {
    for (const edits of [
      [{ duration: Number.MAX_SAFE_INTEGER + 1, mediaTime: 0 }],
      [
        { duration: Number.MAX_SAFE_INTEGER, mediaTime: -1 },
        { duration: 1, mediaTime: 0 },
      ],
    ]) {
      await expect(
        readSafeIsoPresentationEdit(reader(isoMovie({ version: 1, edits })), 7)
      ).rejects.toEqual(
        expect.objectContaining({
          reason: 'unsupported-edit-list',
        } satisfies Pick<IsoEditGateFailure, 'reason'>)
      );
    }
  });

  test('bounds hostile root box walks before parsing arbitrary payloads', async () => {
    const boxes = Array.from({ length: MAX_ISO_BOX_HEADERS + 1 }, () =>
      box('free', new Uint8Array())
    );
    await expect(
      readSafeIsoPresentationEdit(reader(concatenate(boxes)), 7)
    ).rejects.toEqual(
      expect.objectContaining({
        reason: 'read-budget',
      } satisfies Pick<IsoEditGateFailure, 'reason'>)
    );
  });
});
