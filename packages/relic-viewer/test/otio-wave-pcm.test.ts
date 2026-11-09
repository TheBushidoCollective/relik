import { describe, expect, test } from 'bun:test';
import { CustomSource, EncodedPacketSink, Input, WAVE } from 'mediabunny';
import {
  preflightWavePcm,
  wavePcmDataView,
  WAVE_MAX_FILE_BYTES,
} from '../src/otio-wave-pcm';

function wave(frames = 8, channels = 2, bits = 16, tag = 1): Uint8Array {
  const align = (channels * bits) / 8;
  const bytes = new Uint8Array(44 + frames * align);
  const v = new DataView(bytes.buffer);
  for (const [at, text] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ] as const)
    for (let i = 0; i < 4; i++) bytes[at + i] = text.charCodeAt(i);
  v.setUint32(4, bytes.length - 8, true);
  v.setUint32(16, 16, true);
  v.setUint16(20, tag, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, 48000, true);
  v.setUint32(28, 48000 * align, true);
  v.setUint16(32, align, true);
  v.setUint16(34, bits, true);
  v.setUint32(40, frames * align, true);
  return bytes;
}

describe('bounded WAV admission', () => {
  test('admits validated PCM16 and float32 with exact frame counts', async () => {
    expect(await preflightWavePcm(new Blob([wave()]))).toMatchObject({
      format: 'pcm16',
      channels: 2,
      sampleRate: 48000,
      dataOffset: 44,
      totalFrames: 8,
    });
    expect(
      await preflightWavePcm(new Blob([wave(19, 1, 32, 3)]))
    ).toMatchObject({ format: 'float32', channels: 1, totalFrames: 19 });
  });
  test('rejects incompatible alignment, partial data and invalid RIFF extents', async () => {
    for (const mutate of [
      (v: DataView) => v.setUint16(32, 1, true),
      (v: DataView) => v.setUint32(28, 1, true),
      (v: DataView) => v.setUint32(40, 31, true),
      (v: DataView) => v.setUint32(4, 0xffffffff, true),
      (v: DataView) => v.setUint16(20, 0xfffe, true),
    ]) {
      const bytes = wave();
      mutate(new DataView(bytes.buffer));
      await expect(preflightWavePcm(new Blob([bytes]))).rejects.toThrow();
    }
  });
  test('rejects duplicate structural chunks and oversized metadata before reading', async () => {
    const original = wave();
    const duplicate = new Uint8Array(original.length + 8);
    duplicate.set(original);
    duplicate.set(new TextEncoder().encode('data'), original.length);
    new DataView(duplicate.buffer).setUint32(4, duplicate.length - 8, true);
    await expect(preflightWavePcm(new Blob([duplicate]))).rejects.toThrow();
    const large = wave();
    new DataView(large.buffer).setUint32(16, 0xffffffff, true);
    await expect(preflightWavePcm(new Blob([large]))).rejects.toThrow();
    await expect(
      preflightWavePcm(new Blob([new Uint8Array(WAVE_MAX_FILE_BYTES + 1)]))
    ).rejects.toThrow();
  });
  test('validates LIST INFO nested bounds', async () => {
    const original = wave();
    const bytes = new Uint8Array(original.length + 20);
    bytes.set(original.subarray(0, 36));
    bytes.set(new TextEncoder().encode('LIST'), 36);
    const v = new DataView(bytes.buffer);
    v.setUint32(40, 12, true);
    bytes.set(new TextEncoder().encode('INFOINAM'), 44);
    v.setUint32(52, 0, true);
    bytes.set(original.subarray(36), 56);
    v.setUint32(4, bytes.length - 8, true);
    await expect(preflightWavePcm(new Blob([bytes]))).resolves.toMatchObject({
      totalFrames: 8,
    });
    v.setUint32(52, 1, true);
    await expect(preflightWavePcm(new Blob([bytes]))).rejects.toThrow();
  });
  test('demux view omits dense INFO while preserving every PCM byte', async () => {
    const original = wave(8);
    original[44] = 0x7a;
    const entries = 4096;
    const listBytes = 4 + entries * 8;
    const bytes = new Uint8Array(original.length + listBytes + 8);
    bytes.set(original.subarray(0, 36));
    bytes.set(new TextEncoder().encode('LIST'), 36);
    const view = new DataView(bytes.buffer);
    view.setUint32(40, listBytes, true);
    bytes.set(new TextEncoder().encode('INFO'), 44);
    for (let i = 0; i < entries; i++) view.setUint32(48 + i * 8, i, true);
    bytes.set(original.subarray(36), 44 + listBytes);
    view.setUint32(4, bytes.length - 8, true);
    const blob = new Blob([bytes]);
    const header = await preflightWavePcm(blob);
    const virtual = wavePcmDataView(blob, header);
    expect(virtual.size).toBe(original.length);
    expect(await virtual.read(0, virtual.size)).toEqual(original);
    const input = new Input({
      formats: [WAVE],
      source: new CustomSource({
        getSize: () => virtual.size,
        read: virtual.read,
        maxCacheSize: 0,
        prefetchProfile: 'none',
      }),
    });
    const tracks = await input.getAudioTracks();
    expect(tracks).toHaveLength(1);
    const packet = await new EncodedPacketSink(tracks[0]!).getPacket(0);
    expect(packet?.data).toEqual(original.subarray(44));
    expect(await input.getMetadataTags()).toEqual({});
    input.dispose();
    await expect(virtual.read(0, virtual.size + 1)).rejects.toThrow();
  });
});
