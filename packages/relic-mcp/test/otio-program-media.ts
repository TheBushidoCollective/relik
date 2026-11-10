/**
 * Independent decoding of a rendered program MP4 with ffprobe and ffmpeg. Nothing here imports
 * Relic code, so a decode path bug cannot be hidden by the code under test.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { RgbFrame } from './otio-program-checks.ts';

function run(
  command: string,
  args: readonly string[]
): Promise<{ stdout: Buffer; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    stdout: Buffer;
    stderr: string;
  }>();
  const child = spawn(command, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  child.on('error', reject);
  child.on('close', (code) => {
    const stderr = Buffer.concat(err).toString('utf8');
    if (code !== 0)
      reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    else resolve({ stdout: Buffer.concat(out), stderr });
  });
  return promise;
}

export interface ProbedStream {
  readonly codec_type: 'video' | 'audio' | string;
  readonly codec_name: string;
  readonly profile?: string;
  readonly width?: number;
  readonly height?: number;
  readonly pix_fmt?: string;
  readonly r_frame_rate?: string;
  readonly avg_frame_rate?: string;
  readonly sample_rate?: string;
  readonly channels?: number;
  readonly nb_frames?: string;
  readonly start_time?: string;
  readonly duration?: string;
}

export async function probeStreams(file: string): Promise<ProbedStream[]> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    file,
  ]);
  const parsed = JSON.parse(stdout.toString('utf8')) as {
    streams?: ProbedStream[];
  };
  return parsed.streams ?? [];
}

/** Presentation timestamps of every video frame, in seconds, in decode order. */
export async function videoPresentationTimes(file: string): Promise<number[]> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'frame=pts_time',
    '-of',
    'csv=p=0',
    file,
  ]);
  return stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => Number(line));
}

/**
 * Streams every decoded frame as rgb24 and calls onFrame in presentation order. Only one frame
 * is held at a time. Returns the number of whole frames read. Trailing partial bytes fail.
 */
export async function forEachVideoFrame(
  file: string,
  width: number,
  height: number,
  onFrame: (index: number, frame: RgbFrame) => void
): Promise<number> {
  const frameBytes = width * height * 3;
  const child = spawn(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:v:0',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  const finished = Promise.withResolvers<number>();
  child.on('error', finished.reject);
  child.on('close', (code) => {
    if (code !== 0)
      finished.reject(
        new Error(
          `ffmpeg exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`
        )
      );
    else finished.resolve(code);
  });
  let pending: Buffer = Buffer.alloc(0);
  let index = 0;
  for await (const chunk of child.stdout) {
    const piece = chunk as Buffer;
    pending = pending.length === 0 ? piece : Buffer.concat([pending, piece]);
    while (pending.length >= frameBytes) {
      const data = new Uint8Array(pending.subarray(0, frameBytes));
      pending = pending.subarray(frameBytes);
      onFrame(index++, { width, height, data });
    }
  }
  await finished.promise;
  if (pending.length !== 0)
    throw new Error(
      `ffmpeg produced ${pending.length} trailing bytes, not a whole frame`
    );
  return index;
}

export interface DecodedAudio {
  readonly rate: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
}

/** Decodes the first audio stream to stereo float at the given rate. ffmpeg honours edit lists. */
export async function decodeAudio(
  file: string,
  rate = 48000
): Promise<DecodedAudio> {
  const { stdout } = await run('ffmpeg', [
    '-v',
    'error',
    '-i',
    file,
    '-map',
    '0:a:0',
    '-f',
    'f32le',
    '-acodec',
    'pcm_f32le',
    '-ac',
    '2',
    '-ar',
    String(rate),
    '-',
  ]);
  const aligned = new Float32Array(
    stdout.buffer.slice(
      stdout.byteOffset,
      stdout.byteOffset + stdout.byteLength
    )
  );
  const frames = Math.floor(aligned.length / 2);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = aligned[2 * i] ?? 0;
    right[i] = aligned[2 * i + 1] ?? 0;
  }
  return { rate, left, right };
}

export async function sha256OfFile(file: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
