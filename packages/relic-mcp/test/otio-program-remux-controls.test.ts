import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertVideoPacketsIdentical,
  videoOnlyRemux,
  videoPacketEvidence,
} from './otio-program-remux-controls.ts';

/** A one second clip with video and audio, encoded with the given extra ffmpeg arguments. */
function makeClip(path: string, extra: string[] = []): void {
  const run = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=160x90:rate=24:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    ...extra,
    path,
  ]);
  if (run.status !== 0) throw new Error(run.stderr.toString('utf8'));
}

describe('video-only remux control', () => {
  test('a lossless remux keeps every video packet identical and drops audio', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'primer-remux-'));
    try {
      const source = join(dir, 'source.mp4');
      const remux = join(dir, 'remux.mp4');
      makeClip(source);
      await videoOnlyRemux(source, remux);
      await assertVideoPacketsIdentical(source, remux);
      const audio = spawnSync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'a',
        '-show_entries',
        'stream=index',
        '-of',
        'csv=p=0',
        remux,
      ]);
      expect(audio.stdout.toString('utf8').trim()).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('negative control: a re-encoded video is rejected as not a fair control', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'primer-remux-neg-'));
    try {
      const source = join(dir, 'source.mp4');
      const reencoded = join(dir, 'reencoded.mp4');
      makeClip(source);
      makeClip(reencoded, ['-crf', '40']);
      await expect(
        assertVideoPacketsIdentical(source, reencoded)
      ).rejects.toThrow(
        'video-only control changed video packet bytes or timestamps'
      );
      expect((await videoPacketEvidence(source)).length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
