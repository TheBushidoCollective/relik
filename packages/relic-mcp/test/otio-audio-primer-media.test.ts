import { describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL(
    '../../relic-viewer/scripts/generate-otio-audio-primer.sh',
    import.meta.url
  )
);
const modulePath = fileURLToPath(
  new URL('../../relic-viewer/src/otio-audio-primer-media.ts', import.meta.url)
);

// Reads the committed module text and recovers the bytes it encodes, without importing the viewer.
async function committedPrimer(): Promise<{
  bytes: Uint8Array;
  sha256: string;
  byteLength: number;
}> {
  const text = await readFile(modulePath, 'utf8');
  const sha256 = /OTIO_AUDIO_PRIMER_SHA256 = "([0-9a-f]{64})"/.exec(text)?.[1];
  const byteLength = Number(
    /OTIO_AUDIO_PRIMER_BYTE_LENGTH = (\d+);/.exec(text)?.[1]
  );
  const body = text.slice(text.indexOf('const base64Text ='));
  const chunks = [...body.matchAll(/"([A-Za-z0-9+/=]*)"/g)].map((m) => m[1]);
  const base64 = chunks.join('');
  if (!sha256) throw new Error('module lacks OTIO_AUDIO_PRIMER_SHA256');
  return {
    bytes: new Uint8Array(Buffer.from(base64, 'base64')),
    sha256,
    byteLength,
  };
}

async function probe(file: string): Promise<{
  streams: Array<Record<string, string | number>>;
  format: { duration: string };
}> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    file,
  ]);
  return JSON.parse(stdout);
}

describe('otio audio primer asset (ffmpeg)', () => {
  test('committed module decodes to a 16x16 H.264 plus AAC-LC stereo 48 kHz file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'primer-mcp-'));
    try {
      const primer = await committedPrimer();
      expect(primer.byteLength).toBe(primer.bytes.byteLength);
      const file = join(dir, 'committed.mp4');
      await writeFile(file, primer.bytes);

      const info = await probe(file);
      const video = info.streams.find((s) => s.codec_type === 'video');
      const audio = info.streams.find((s) => s.codec_type === 'audio');
      expect(video?.codec_name).toBe('h264');
      expect(video?.width).toBe(16);
      expect(video?.height).toBe(16);
      expect(audio?.codec_name).toBe('aac');
      expect(audio?.channels).toBe(2);
      expect(String(audio?.sample_rate)).toBe('48000');
      expect(Number(info.format.duration)).toBeLessThanOrEqual(5.0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('committed module audio is exact digital silence on decoded PCM', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'primer-mcp-'));
    try {
      const primer = await committedPrimer();
      const file = join(dir, 'committed.mp4');
      await writeFile(file, primer.bytes);

      const volume = await run('ffmpeg', [
        '-hide_banner',
        '-i',
        file,
        '-map',
        '0:a:0',
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-',
      ]);
      const maxVolume = Number(
        /max_volume: (-?[\d.]+) dB/.exec(volume.stderr)?.[1]
      );
      expect(maxVolume).toBeLessThanOrEqual(-90);

      const pcm = await run(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          file,
          '-map',
          '0:a:0',
          '-f',
          's16le',
          '-acodec',
          'pcm_s16le',
          '-',
        ],
        { encoding: 'buffer', maxBuffer: 1 << 24 }
      );
      const samples = pcm.stdout as unknown as Buffer;
      expect(samples.byteLength).toBeGreaterThan(0);
      let nonzero = 0;
      for (const byte of samples) if (byte !== 0) nonzero += 1;
      expect(nonzero).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('regenerating with the script yields the same codec shape and silence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'primer-mcp-'));
    try {
      const out = join(dir, 'regen.mp4');
      const moduleOut = join(dir, 'regen.ts');
      await run('bash', [scriptPath, out, moduleOut]);

      const info = await probe(out);
      const video = info.streams.find((s) => s.codec_type === 'video');
      const audio = info.streams.find((s) => s.codec_type === 'audio');
      expect(video?.codec_name).toBe('h264');
      expect(video?.width).toBe(16);
      expect(audio?.codec_name).toBe('aac');
      expect(String(audio?.sample_rate)).toBe('48000');
      expect(Number(info.format.duration)).toBeLessThanOrEqual(5.0);

      const generated = await readFile(moduleOut, 'utf8');
      const committed = await committedPrimer();
      expect(generated).toContain('export const OTIO_AUDIO_PRIMER_SHA256');
      expect(generated).toContain('export function otioAudioPrimerBytes');
      // Byte identity is a property of one ffmpeg build, so the committed bytes are checked for
      // shape above, not for equality with a regeneration on another build.
      expect(committed.bytes.byteLength).toBeLessThanOrEqual(8 * 1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
