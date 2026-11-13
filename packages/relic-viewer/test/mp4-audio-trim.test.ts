import { describe, expect, test } from 'bun:test';
import { trimProgramAudio } from '../src/program-render/mp4-audio-trim.ts';

function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let p = 0;
  for (const part of parts) {
    result.set(part, p);
    p += part.length;
  }
  return result;
}
function bytes(size: number, values: Record<number, number> = {}): Uint8Array {
  const result = new Uint8Array(size);
  const view = new DataView(result.buffer);
  for (const [offset, value] of Object.entries(values))
    view.setUint32(Number(offset), value);
  return result;
}
function box(type: string, ...contents: Uint8Array[]): Uint8Array {
  const payload = join(...contents);
  const result = new Uint8Array(payload.length + 8);
  new DataView(result.buffer).setUint32(0, result.length);
  result.set(new TextEncoder().encode(type), 4);
  result.set(payload, 8);
  return result;
}
function track(
  kind: 'soun' | 'vide',
  offset: number,
  edit?: Uint8Array
): Uint8Array {
  const handler = bytes(12);
  handler.set(new TextEncoder().encode(kind), 8);
  const entry = bytes(28);
  new DataView(entry.buffer).setUint32(24, 48000 * 65536);
  // ES descriptor with an AAC DecoderConfigDescriptor.
  const esds = box(
    'esds',
    new Uint8Array([
      0, 0, 0, 0, 3, 22, 0, 1, 0, 4, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 5, 2, 0x11, 0x90,
    ])
  );
  const stsd = box('stsd', bytes(8, { 4: 1 }), box('mp4a', entry, esds));
  const stts = box('stts', bytes(16, { 4: 1, 8: 6, 12: 1024 }));
  const stco = box('stco', bytes(12, { 4: 1, 8: offset }));
  const stbl = box('stbl', ...(kind === 'soun' ? [stsd, stts] : []), stco);
  const mdia = box(
    'mdia',
    box('mdhd', bytes(24, { 12: 48000, 16: 6144 })),
    box('hdlr', handler),
    box('minf', stbl)
  );
  return box(
    'trak',
    box('tkhd', bytes(24, { 20: kind === 'soun' ? 6144 : 4000 })),
    ...(edit ? [edit] : []),
    mdia
  );
}
function fixture(
  options: {
    audioCount?: number;
    movieScale?: number;
    mediaFirst?: boolean;
    edit?: Uint8Array;
    videoEdit?: Uint8Array;
    metadata?: Uint8Array;
  } = {}
): Uint8Array {
  const ftyp = box('ftyp', new Uint8Array(8));
  const mdat = box('mdat', new Uint8Array([1, 2, 3, 4]));
  const makeMoov = (offset: number) =>
    box(
      'moov',
      box('mvhd', bytes(24, { 12: options.movieScale ?? 48000, 16: 6144 })),
      track('vide', offset, options.videoEdit),
      ...Array.from({ length: options.audioCount ?? 1 }, () =>
        track('soun', offset, options.edit)
      ),
      ...(options.metadata ? [options.metadata] : [])
    );
  const preliminary = makeMoov(0);
  const offset =
    ftyp.length + (options.mediaFirst ? 0 : preliminary.length) + 8;
  const moov = makeMoov(offset);
  return options.mediaFirst ? join(ftyp, mdat, moov) : join(ftyp, moov, mdat);
}
function find(bytes: Uint8Array, name: string): number {
  const signature = new TextEncoder().encode(name);
  for (let p = 4; p <= bytes.length - signature.length; p++) {
    if (signature.every((v, i) => bytes[p + i] === v)) return p - 4;
  }
  throw new Error(`missing ${name}`);
}
function edit(base: number): Uint8Array {
  const payload = bytes(20, { 4: 1, 8: 6000, 12: base });
  new DataView(payload.buffer).setInt16(16, 1);
  return box('edts', box('elst', payload));
}

describe('trimProgramAudio', () => {
  for (const mediaFirst of [false, true]) {
    test(`preserves media and relocates chunk offsets when mediaFirst=${mediaFirst}`, () => {
      const original = fixture({ mediaFirst });
      const output = trimProgramAudio(original, 1024, 4000, 48000);
      const view = new DataView(
        output.buffer,
        output.byteOffset,
        output.byteLength
      );
      const elst = find(output, 'elst');
      expect(view.getUint8(elst + 8)).toBe(1);
      expect(view.getBigUint64(elst + 16)).toBe(4000n);
      expect(view.getBigInt64(elst + 24)).toBe(1024n);
      const mdat = find(output, 'mdat');
      expect([...output.subarray(mdat + 8, mdat + 12)]).toEqual([1, 2, 3, 4]);
      const firstStco = find(output, 'stco');
      expect(view.getUint32(firstStco + 16)).toBe(mdat + 8);
      const audioStco =
        find(output.subarray(firstStco + 20), 'stco') + firstStco + 20;
      expect(view.getUint32(audioStco + 16)).toBe(mdat + 8);
      expect(view.getUint32(find(output, 'mvhd') + 24)).toBe(4000);
      expect(output.length).toBe(original.length + 44);
    });
  }
  test('replaces a pre-existing zero-offset media edit', () => {
    const result = trimProgramAudio(
      fixture({ edit: edit(0) }),
      1024,
      4000,
      48000
    );
    const view = new DataView(
      result.buffer,
      result.byteOffset,
      result.byteLength
    );
    expect(view.getBigInt64(find(result, 'elst') + 24)).toBe(1024n);
  });
  test('promotes coarse movie timescale and preserves video presentation', () => {
    const input = fixture({ movieScale: 1000, videoEdit: edit(0) });
    const output = trimProgramAudio(input, 1, 4001, 48000);
    const view = new DataView(
      output.buffer,
      output.byteOffset,
      output.byteLength
    );
    expect(view.getUint32(find(output, 'mvhd') + 20)).toBe(48000);
    expect(view.getUint32(find(output, 'tkhd') + 28)).toBe(192000);
    expect(view.getUint32(find(output, 'elst') + 16)).toBe(288000);
    const videoEdit = find(output, 'elst');
    const audioEdit =
      videoEdit + 20 + find(output.subarray(videoEdit + 20), 'elst');
    expect(view.getBigUint64(audioEdit + 16)).toBe(4001n);
    expect(view.getBigInt64(audioEdit + 24)).toBe(1n);
  });
  test('preserves inline movie metadata while relocating media', () => {
    const handler = bytes(12);
    handler.set(new TextEncoder().encode('mdir'), 8);
    const metadata = box(
      'udta',
      box(
        'meta',
        bytes(4),
        box('hdlr', handler),
        box('ilst', box('tool', box('data', bytes(12, { 8: 1234 }))))
      )
    );
    const output = trimProgramAudio(
      fixture({ movieScale: 1000, metadata }),
      1,
      4001,
      48000
    );
    const start = find(output, 'udta');
    expect([...output.subarray(start, start + metadata.length)]).toEqual([
      ...metadata,
    ]);
    const view = new DataView(
      output.buffer,
      output.byteOffset,
      output.byteLength
    );
    expect(view.getUint32(find(output, 'stco') + 16)).toBe(
      find(output, 'mdat') + 8
    );
    expect(() =>
      trimProgramAudio(
        fixture({ metadata: box('udta', box('iloc', bytes(8))) }),
        0,
        4000,
        48000
      )
    ).toThrow('unsupported user metadata');
  });
  test('rejects ambiguous audio and unrepresentable promoted timescale', () => {
    expect(() =>
      trimProgramAudio(fixture({ audioCount: 2 }), 1, 4000, 48000)
    ).toThrow('multiple audio');
    expect(() =>
      trimProgramAudio(fixture({ movieScale: 0xffffffff }), 1, 4001, 48000)
    ).toThrow('timescale overflow');
  });
  test('rejects unsupported edits, non-AAC data and invalid chunk offsets', () => {
    expect(() =>
      trimProgramAudio(fixture({ edit: edit(-1) }), 0, 4000, 48000)
    ).toThrow('unsupported audio edit mapping');
    expect(() =>
      trimProgramAudio(fixture({ edit: edit(100) }), 0, 4000, 48000)
    ).toThrow('unsupported audio edit mapping');
    const nonAac = fixture();
    const esds = find(nonAac, 'esds');
    nonAac[esds + 8 + 11] = 0x6b;
    expect(() => trimProgramAudio(nonAac, 0, 4000, 48000)).toThrow('not AAC');
    const badOffset = fixture();
    new DataView(badOffset.buffer).setUint32(find(badOffset, 'stco') + 16, 1);
    expect(() => trimProgramAudio(badOffset, 0, 4000, 48000)).toThrow(
      'outside mdat'
    );
  });
  test('rejects a zero-sized terminal audio mdia without hiding the inserted edit', () => {
    const input = fixture();
    const firstMdia = find(input, 'mdia');
    const audioMdia =
      firstMdia + 8 + find(input.subarray(firstMdia + 8), 'mdia');
    new DataView(input.buffer).setUint32(audioMdia, 0);
    expect(() => trimProgramAudio(input, 0, 4000, 48000)).toThrow(
      'zero-sized nested box'
    );
  });
  test('preserves a valid terminal zero-sized mdat', () => {
    const input = fixture();
    new DataView(input.buffer).setUint32(find(input, 'mdat'), 0);
    const output = trimProgramAudio(input, 0, 4000, 48000);
    const mdat = find(output, 'mdat');
    expect(new DataView(output.buffer, output.byteOffset).getUint32(mdat)).toBe(
      0
    );
    expect([...output.subarray(mdat + 8)]).toEqual([1, 2, 3, 4]);
  });
  test('rejects malformed input, missing packets, and invalid sample counts', () => {
    expect(() =>
      trimProgramAudio(new Uint8Array([0, 0, 0]), 0, 1, 48000)
    ).toThrow('malformed');
    expect(() => trimProgramAudio(fixture(), 3000, 4000, 48000)).toThrow(
      'do not cover'
    );
    expect(() => trimProgramAudio(fixture(), -1, 4000, 48000)).toThrow(
      'delaySamples'
    );
    expect(() => trimProgramAudio(fixture(), 0, 4000, 44100)).toThrow(
      'sample rate mismatch'
    );
  });
});
