import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as Primer from '../../relic-viewer/src/otio-audio-primer-media.ts';
import {
  OTIO_AUDIO_PRIMER_BYTE_LENGTH,
  OTIO_AUDIO_PRIMER_SHA256,
  otioAudioPrimerBytes,
} from '../../relic-viewer/src/otio-audio-primer-media.ts';

const scriptPath = fileURLToPath(
  new URL(
    '../../relic-viewer/scripts/generate-otio-audio-primer.sh',
    import.meta.url
  )
);

// The primer is four seconds long. The bounds allow for container padding.
const MIN_SECONDS = 3.5;
const MAX_SECONDS = 5.0;

type Probe = {
  streams: Array<Record<string, string | number>>;
  format: { duration: string };
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { maxBuffer: 1 << 26 });
  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${result.status}: ${result.stderr.toString()}`
    );
  }
  return result;
}

function probe(file: string): Probe {
  const { stdout } = run('ffprobe', [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    file,
  ]);
  const parsed: Probe = JSON.parse(stdout.toString());
  return parsed;
}

function decodedPcm(file: string): Buffer {
  return run('ffmpeg', [
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
  ]).stdout;
}

function peakDb(file: string): number {
  const { stderr } = run('ffmpeg', [
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
  const match = /max_volume: (-?[\d.]+) dB/.exec(stderr.toString());
  if (!match) throw new Error('volumedetect printed no max_volume');
  return Number(match[1]);
}

function assertPrimerShape(file: string): void {
  const info = probe(file);
  const video = info.streams.find((s) => s.codec_type === 'video');
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  expect(video?.codec_name).toBe('h264');
  expect(video?.width).toBe(16);
  expect(video?.height).toBe(16);
  expect(audio?.codec_name).toBe('aac');
  expect(audio?.channels).toBe(2);
  expect(String(audio?.sample_rate)).toBe('48000');
  const seconds = Number(info.format.duration);
  expect(seconds).toBeGreaterThanOrEqual(MIN_SECONDS);
  expect(seconds).toBeLessThanOrEqual(MAX_SECONDS);
}

function assertDigitalSilence(file: string): void {
  // Peak level is a summary; the decoded samples are the proof.
  expect(peakDb(file)).toBeLessThanOrEqual(-90);
  const pcm = decodedPcm(file);
  expect(pcm.byteLength).toBeGreaterThanOrEqual(MIN_SECONDS * 48000 * 2 * 2);
  let nonzero = 0;
  for (const byte of pcm) if (byte !== 0) nonzero += 1;
  expect(nonzero).toBe(0);
}

describe('otio audio primer asset (ffmpeg)', () => {
  test('runtime bytes match the exported SHA-256 and byte length', () => {
    const bytes = otioAudioPrimerBytes();
    expect(sha256Hex(bytes)).toBe(OTIO_AUDIO_PRIMER_SHA256);
    expect(bytes.byteLength).toBe(OTIO_AUDIO_PRIMER_BYTE_LENGTH);
  });

  test('runtime bytes decode to 16x16 H.264 with AAC-LC stereo 48 kHz audio', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'primer-mcp-'));
    try {
      const file = join(dir, 'runtime.mp4');
      await writeFile(file, otioAudioPrimerBytes());
      assertPrimerShape(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('runtime bytes are exact digital silence on decoded PCM', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'primer-mcp-'));
    try {
      const file = join(dir, 'runtime.mp4');
      await writeFile(file, otioAudioPrimerBytes());
      assertDigitalSilence(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the generator writes a primer whose module exports the same bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'primer-mcp-'));
    try {
      const out = join(dir, 'regen.mp4');
      const moduleOut = join(dir, 'regen.ts');
      run('bash', [scriptPath, out, moduleOut]);
      assertPrimerShape(out);
      assertDigitalSilence(out);

      // moduleOut is a temp file this test has the generator write at run time, so no static
      // import can name it. The module is loaded, not parsed, and its SHA is checked against the
      // file the script wrote, independently of the module's own decoder.
      const generated: typeof Primer = await import(moduleOut);
      const fileBytes = await readFile(out);
      const bytes = generated.otioAudioPrimerBytes();
      expect(sha256Hex(fileBytes)).toBe(generated.OTIO_AUDIO_PRIMER_SHA256);
      expect(sha256Hex(bytes)).toBe(generated.OTIO_AUDIO_PRIMER_SHA256);
      expect(bytes.byteLength).toBe(generated.OTIO_AUDIO_PRIMER_BYTE_LENGTH);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
