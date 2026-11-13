/**
 * Video-only control: a lossless remux of the program's video track with audio stripped.
 *
 * Recreated from the original bare-control helpers (videoOnly, videoPacketEvidence), which lived in
 * otio-program-native-controls.ts and were deleted from the worktree. Logic is kept as it was. The
 * control's validity rests on one check: the remux's video packets must match the source's packets
 * in payload hash, pts, dts and duration. Only then is a video-only arm a fair control.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

/** Lossless remux of the source's video track only: no re-encoding, no audio. */
export async function videoOnlyRemux(
  source: string,
  target: string
): Promise<void> {
  const done = Promise.withResolvers<void>();
  const child = spawn(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-i',
      source,
      '-map',
      '0:v:0',
      '-c:v',
      'copy',
      '-an',
      target,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const errors: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  child.on('error', done.reject);
  child.on('close', (code) =>
    code === 0
      ? done.resolve()
      : done.reject(
          new Error(
            `video-only remux exited ${code}: ${Buffer.concat(errors).toString('utf8')}`
          )
        )
  );
  await done.promise;
}

/** Per-packet pts, dts, duration and payload sha256 for the first video stream. */
export async function videoPacketEvidence(file: string): Promise<unknown[]> {
  const done = Promise.withResolvers<Buffer>();
  const child = spawn(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_packets',
      '-show_data_hash',
      'sha256',
      '-show_entries',
      'packet=pts_time,dts_time,duration_time,data_hash',
      '-of',
      'json',
      file,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const out: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  child.once('error', done.reject);
  child.once('close', (code) =>
    code === 0
      ? done.resolve(Buffer.concat(out))
      : done.reject(
          new Error(
            `ffprobe packet evidence exited ${code}: ${Buffer.concat(errors).toString('utf8')}`
          )
        )
  );
  const parsed = JSON.parse((await done.promise).toString('utf8')) as {
    packets?: unknown[];
  };
  assert.ok(parsed.packets?.length, 'video packet evidence is empty');
  return parsed.packets;
}

/**
 * Fails unless the remux's video packets are identical to the source's. A failure here means the
 * video-only arm is not a fair control, so the arm must not be read as one.
 */
export async function assertVideoPacketsIdentical(
  source: string,
  remux: string
): Promise<void> {
  assert.deepEqual(
    await videoPacketEvidence(remux),
    await videoPacketEvidence(source),
    'video-only control changed video packet bytes or timestamps'
  );
}
