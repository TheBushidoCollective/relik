export const WAVE_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const WAVE_MAX_METADATA_CHUNK = 64 * 1024;
export const WAVE_MAX_METADATA_TOTAL = 1024 * 1024;

export interface WavePcmHeader {
  readonly format: 'pcm16' | 'float32';
  readonly channels: 1 | 2;
  readonly sampleRate: 44100 | 48000;
  readonly blockAlign: number;
  readonly dataOffset: number;
  readonly dataBytes: number;
  readonly totalFrames: number;
}

// The demuxer sees only a canonical header and the validated data range.
// In particular, attacker-controlled INFO tags never become retained objects.
export function wavePcmDataView(blob: Blob, header: WavePcmHeader) {
  const prefix = new Uint8Array(44);
  const view = new DataView(prefix.buffer);
  for (const [offset, text] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ] as const)
    for (let i = 0; i < 4; i++) prefix[offset + i] = text.charCodeAt(i);
  const bits = header.format === 'pcm16' ? 16 : 32;
  view.setUint32(4, 36 + header.dataBytes, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, header.format === 'pcm16' ? 1 : 3, true);
  view.setUint16(22, header.channels, true);
  view.setUint32(24, header.sampleRate, true);
  view.setUint32(28, header.sampleRate * header.blockAlign, true);
  view.setUint16(32, header.blockAlign, true);
  view.setUint16(34, bits, true);
  view.setUint32(40, header.dataBytes, true);
  return {
    size: 44 + header.dataBytes,
    async read(start: number, end: number): Promise<Uint8Array> {
      // Mediabunny bridges at most 128 KiB between reads. One WAV packet
      // contributes at most 16 KiB; 44 bytes allow a crossing header read.
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > 44 + header.dataBytes ||
        end - start > 128 * 1024 + 16 * 1024 + 44
      )
        throw new Error('WAV source read exceeds bounded packet extent');
      if (end <= 44) return prefix.slice(start, end);
      const from = Math.max(start, 44);
      const data = new Uint8Array(
        await blob
          .slice(header.dataOffset + from - 44, header.dataOffset + end - 44)
          .arrayBuffer()
      );
      if (start >= 44) return data;
      const combined = new Uint8Array(end - start);
      combined.set(prefix.subarray(start), 0);
      combined.set(data, 44 - start);
      return combined;
    },
  };
}

/** Validate all extents before allowing the demuxer to inspect the Blob. */
export async function preflightWavePcm(blob: Blob): Promise<WavePcmHeader> {
  if (
    !(blob instanceof Blob) ||
    blob.size < 12 ||
    blob.size > WAVE_MAX_FILE_BYTES
  )
    throw new Error('Unsupported WAV file size');
  const read = async (offset: number, length: number) =>
    new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
  const id = (b: Uint8Array, offset = 0) =>
    String.fromCharCode(...b.subarray(offset, offset + 4));
  const u32 = (b: Uint8Array, offset: number) =>
    new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(offset, true);
  const root = await read(0, 12);
  if (
    id(root) !== 'RIFF' ||
    id(root, 8) !== 'WAVE' ||
    u32(root, 4) + 8 !== blob.size
  )
    throw new Error('Invalid RIFF/WAVE extent');
  let pos = 12,
    metadata = 0;
  let fmt:
    | Omit<WavePcmHeader, 'dataOffset' | 'dataBytes' | 'totalFrames'>
    | undefined;
  let data: { offset: number; length: number } | undefined;
  while (pos < blob.size) {
    if (blob.size - pos < 8) throw new Error('Truncated WAV chunk header');
    const chunk = await read(pos, 8);
    const name = id(chunk),
      size = u32(chunk, 4),
      start = pos + 8;
    const end = start + size,
      padded = end + (size & 1);
    if (!Number.isSafeInteger(padded) || padded > blob.size)
      throw new Error('Truncated WAV chunk');
    if (name === 'data') {
      if (data) throw new Error('Duplicate WAV data chunk');
      data = { offset: start, length: size };
    } else {
      metadata += size + 8;
      if (size > WAVE_MAX_METADATA_CHUNK || metadata > WAVE_MAX_METADATA_TOTAL)
        throw new Error('WAV metadata limit exceeded');
      if (name === 'fmt ') {
        if (fmt || size !== 16)
          throw new Error('Unsupported or duplicate WAV format chunk');
        const b = await read(start, size),
          view = new DataView(b.buffer, b.byteOffset, b.byteLength);
        const tag = view.getUint16(0, true),
          channels = view.getUint16(2, true),
          rate = view.getUint32(4, true);
        const byteRate = view.getUint32(8, true),
          align = view.getUint16(12, true),
          bits = view.getUint16(14, true);
        if (
          !((tag === 1 && bits === 16) || (tag === 3 && bits === 32)) ||
          (channels !== 1 && channels !== 2) ||
          (rate !== 44100 && rate !== 48000) ||
          align !== (channels * bits) / 8 ||
          byteRate !== rate * align
        )
          throw new Error('Unsupported or inconsistent WAV format');
        fmt = {
          format: tag === 1 ? 'pcm16' : 'float32',
          channels,
          sampleRate: rate,
          blockAlign: align,
        };
      } else if (name === 'LIST') {
        if (size < 4) throw new Error('Invalid WAV LIST');
        const b = await read(start, size);
        if (id(b) !== 'INFO') throw new Error('Unsupported WAV LIST');
        let p = 4;
        while (p < size) {
          if (size - p < 8) throw new Error('Truncated WAV INFO');
          const n = u32(b, p + 4);
          p += 8 + n + (n & 1);
          if (p > size) throw new Error('Truncated WAV INFO entry');
        }
      } else {
        throw new Error('Unsupported WAV metadata chunk');
      }
    }
    pos = padded;
  }
  if (!fmt || !data || data.length % fmt.blockAlign !== 0)
    throw new Error('Missing or incomplete WAV PCM frames');
  return {
    ...fmt,
    dataOffset: data.offset,
    dataBytes: data.length,
    totalFrames: data.length / fmt.blockAlign,
  };
}
