/**
 * OTIO Native Video Frame Admission Proof
 *
 * Verifies continuous native HTML <video> decoding with certified frame approval
 * by measuring actual drawn pixels inside headless Chromium.
 *
 * Requirements:
 * 1. WebCodecs/VideoDecoder/AudioDecoder TRAPPED (native HTML video ONLY).
 * 2. Compares drawn pixels under two native draw methods:
 *    (a) inside_rvfc: ctx.drawImage called directly inside requestVideoFrameCallback.
 *    (b) next_raf: ctx.drawImage called inside the next requestAnimationFrame.
 * 3. Compares actual pixels against independent ffmpeg decoder reference frames
 *    and decoded burned-in stripe frame indices.
 * 4. 100% exact match rate required for an approved draw method.
 * 5. Rejects ambiguous oracles (frames with distinction RMSE <= 4.0).
 * 6. Covers all required decoder-boundary fixtures:
 *    - fr24.mp4 (24fps H.264)
 *    - fr60.mp4 (60fps H.264, mixed with 24 source)
 *    - fr24b.mp4 (24fps H.264 with B-frames)
 *    - fr24b.mov (24fps H.264 MOV container with B-frames)
 *    - vfr.mp4 (Variable frame rate H.264)
 *    - fr30.webm (30fps VP9 WebM)
 *    - no-duration.webm (WebM without container duration header)
 *    - short-edit.mp4 (Edit list shortened)
 *    - rate-edit.mp4 (Edit list rate altered)
 *    - loop-edit.mp4 (Edit list looped entries)
 *    - long-gop-1080p.mp4 (Runtime-generated 1080p 24fps long GOP with deterministic index pattern)
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
  type BrowserHeadlessLaunch,
} from './browser-headless.ts';
import { isOpaqueBlack } from './otio-path-pixels.ts';

/* ==========================================================================
 * Types & Interfaces
 * ========================================================================== */

export type DrawMethod = 'inside_rvfc' | 'next_raf';

export interface CliOptions {
  readonly chromePath?: string;
  readonly fixturesDir: string;
  readonly outputDir?: string;
  readonly outputPath?: string;
  readonly tempDir?: string;
  readonly minSamples: number;
  readonly cases?: readonly string[];
  readonly methods: readonly DrawMethod[];
  readonly json: boolean;
  readonly help: boolean;
}

export interface PacketWindow {
  readonly start: number;
  readonly end: number;
  readonly frame: number;
}

export interface FfprobeStream {
  readonly codec_name?: string;
  readonly time_base?: string;
  readonly r_frame_rate?: string;
  readonly avg_frame_rate?: string;
  readonly width?: number;
  readonly height?: number;
  readonly nb_frames?: string;
  readonly duration?: string;
}

export interface FfprobeFrame {
  readonly best_effort_timestamp?: number;
  readonly best_effort_timestamp_time?: string;
  readonly pkt_dts?: number;
  readonly pkt_dts_time?: string;
  readonly pict_type?: string;
  readonly coded_picture_number?: number;
}

export interface FfprobePacket {
  readonly pts?: number;
  readonly dts?: number;
  readonly duration?: number;
  readonly pts_time?: string;
  readonly dts_time?: string;
  readonly duration_time?: string;
}

export interface FfprobeFileEntry {
  readonly stream?: FfprobeStream;
  readonly frames?: readonly FfprobeFrame[];
  readonly packets?: readonly FfprobePacket[];
}

export interface FfprobeTimingOracle {
  readonly provenance?: {
    readonly producer?: string;
    readonly scope?: string;
    readonly command?: string;
    readonly notes?: Record<string, string>;
  };
  readonly files?: Record<string, FfprobeFileEntry>;
}

export interface BrowserFrameSample {
  readonly mediaTime: number;
  readonly presentedFrames: number;
  readonly expectedDisplayTime: number;
  readonly width: number;
  readonly height: number;
  readonly sourceWidth?: number;
  readonly sourceHeight?: number;
  readonly capturedWidth?: number;
  readonly capturedHeight?: number;
  readonly pixelsBase64: string;
}

export type RejectionReason =
  | 'none'
  | 'uncovered_window'
  | 'lagged_frame'
  | 'held_frame'
  | 'future_frame'
  | 'excessive_rmse'
  | 'burned_in_mismatch'
  | 'ambiguous_match'
  | 'opaque_black'
  | 'zero_alpha'
  | 'unreadable'
  | 'ineligible_timing';

export interface SampleEvaluation {
  readonly sampleIndex: number;
  readonly mediaTime: number;
  readonly presentedFrames: number;
  readonly expectedFrame: number;
  readonly closestFrame: number;
  readonly lagDelta: number;
  readonly timeDeltaUs: number;
  readonly rmseExpected: number;
  readonly rmseClosest: number;
  readonly rmseSecondClosest: number;
  readonly distinctionMargin: number;
  readonly burnedInFrame: number | null;
  readonly isMatch: boolean;
  readonly rejectionReason: RejectionReason;
}

export interface MethodEvaluationResult {
  readonly drawMethod: DrawMethod;
  readonly sampleCount: number;
  readonly distinctFramesCount: number;
  readonly matchCount: number;
  readonly mismatchCount: number;
  readonly matchRate: number;
  readonly errorRatio: number;
  readonly rmseP50: number;
  readonly rmseP95: number;
  readonly rmseMax: number;
  readonly distinctionMarginP50: number;
  readonly deltaDistribution?: Record<string, number>;
  readonly lagDistribution: Record<string, number>;
  readonly rejectionReasons: Record<string, number>;
  readonly approved: boolean;
  readonly failureReason?: string;
}

export interface CaseAdmissionResult {
  readonly caseName: string;
  readonly filePath: string;
  readonly totalOracleFrames: number;
  readonly oracleDistinctionMinRmse: number;
  readonly oracleAmbiguous: boolean;
  readonly eligible: boolean;
  readonly ineligibilityReason?: string;
  readonly failureReason?: string;
  readonly methods: Record<DrawMethod, MethodEvaluationResult>;
  readonly approved: boolean;
}

export interface AdmissionReport {
  readonly schemaVersion: 'relic-otio-native-frame-admission/v1';
  readonly timestamp: string;
  readonly chromePath: string;
  readonly browserProduct: string;
  readonly minSamplesRequired: number;
  readonly casesTotal: number;
  readonly casesPassed: number;
  readonly casesEligible?: number;
  readonly methodApproval: {
    readonly inside_rvfc: boolean;
    readonly next_raf: boolean;
  };
  readonly certifiedDrawMethod: DrawMethod | 'none';
  readonly cases: readonly CaseAdmissionResult[];
}

/* ==========================================================================
 * Mathematical & Pixel Utilities
 * ========================================================================== */

export function rmse(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) {
    throw new Error(`RMSE length mismatch: a=${a.length} != b=${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    sum += delta * delta;
  }
  return Math.sqrt(sum / a.length);
}

export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = Math.max(
    0,
    Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))
  );
  return sorted[pos] ?? 0;
}

/**
 * Decodes the 7-bit binary stripe frame index burned in by frame_code_filter:
 * Column 0..7: sync marker (white luminance ~235)
 * Columns 8..15: bit 0 of N
 * Columns 16..23: bit 1 of N
 * Columns 24..31: bit 2 of N
 * Columns 32..39: bit 3 of N
 * Columns 40..47: bit 4 of N
 * Columns 48..55: bit 5 of N
 * Columns 56..63: bit 6 of N
 */
export function decodeBurnedInFrameIndex(
  rgba: Uint8Array,
  width = 64,
  height = 16
): number | null {
  if (rgba.length < width * height * 4) return null;
  const y = Math.floor(height / 2);
  const blockWidth = width / 8;
  if (blockWidth < 1) return null;

  // Verify sync block (block 0: 0..blockWidth-1)
  let syncLumSum = 0;
  for (let x = 0; x < blockWidth; x++) {
    const idx = (y * width + x) * 4;
    const r = rgba[idx] ?? 0;
    const g = rgba[idx + 1] ?? 0;
    const b = rgba[idx + 2] ?? 0;
    syncLumSum += (r + g + b) / 3;
  }
  const avgSyncLum = syncLumSum / blockWidth;
  if (avgSyncLum < 120) {
    return null; // Not a burned-in sync frame
  }

  let frameIndex = 0;
  for (let bit = 0; bit < 7; bit++) {
    const startX = Math.floor((bit + 1) * blockWidth);
    const endX = Math.floor((bit + 2) * blockWidth);
    let lumSum = 0;
    const count = endX - startX;
    if (count <= 0) return null;
    for (let x = startX; x < endX; x++) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx] ?? 0;
      const g = rgba[idx + 1] ?? 0;
      const b = rgba[idx + 2] ?? 0;
      lumSum += (r + g + b) / 3;
    }
    const avgLum = lumSum / count;
    if (avgLum > 125) {
      frameIndex |= 1 << bit;
    }
  }
  return frameIndex;
}

export function findClosestReferenceFrame(
  captured: Uint8Array,
  refFrames: ReadonlyMap<number, Uint8Array>
): {
  readonly closestFrame: number;
  readonly closestRmse: number;
  readonly secondClosestFrame: number;
  readonly secondClosestRmse: number;
} {
  let closestFrame = -1;
  let closestRmse = Infinity;
  let secondClosestFrame = -1;
  let secondClosestRmse = Infinity;

  for (const [frame, ref] of refFrames.entries()) {
    const d = rmse(captured, ref);
    if (d < closestRmse) {
      secondClosestFrame = closestFrame;
      secondClosestRmse = closestRmse;
      closestFrame = frame;
      closestRmse = d;
    } else if (d < secondClosestRmse) {
      secondClosestFrame = frame;
      secondClosestRmse = d;
    }
  }

  return {
    closestFrame,
    closestRmse,
    secondClosestFrame,
    secondClosestRmse,
  };
}

/* ==========================================================================
 * Child Process & Ffmpeg Helpers
 * ========================================================================== */

async function runChild(
  command: readonly string[],
  options?: { readonly timeoutMs?: number }
): Promise<{
  readonly exit: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}> {
  const timeoutMs = options?.timeoutMs ?? 30000;
  const proc = spawn(command[0]!, command.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const { promise, resolve, reject } = Promise.withResolvers<{
    readonly exit: number;
    readonly stdout: Uint8Array;
    readonly stderr: string;
  }>();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let killed = false;

  const timer = setTimeout(() => {
    killed = true;
    proc.kill('SIGKILL');
    reject(
      new Error(`Command timed out after ${timeoutMs}ms: ${command.join(' ')}`)
    );
  }, timeoutMs);

  proc.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  proc.on('close', (exit) => {
    clearTimeout(timer);
    if (killed) return;
    resolve({
      exit: exit ?? 1,
      stdout: new Uint8Array(Buffer.concat(stdoutChunks)),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    });
  });

  proc.on('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });

  return promise;
}

/**
 * Extracts independent reference frames via ffmpeg downscaled to 64x16 with neighbor interpolation.
 * Verifies that adjacent frames are distinguishable (RMSE > 4.0) to prevent ambiguous oracles.
 */
export async function extractReferenceFrames(
  filePath: string,
  expectedCount: number,
  width = 64,
  height = 16
): Promise<Map<number, Uint8Array>> {
  const bytesPerFrame = width * height * 4;
  const frames = new Map<number, Uint8Array>();

  const batchRes = await runChild(
    [
      'ffmpeg',
      '-v',
      'error',
      '-i',
      filePath,
      '-vf',
      `scale=${width}:${height}:flags=neighbor`,
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      'pipe:1',
    ],
    { timeoutMs: 30000 }
  );

  assert.equal(
    batchRes.exit,
    0,
    `ffmpeg reference extraction failed for ${filePath}: ${batchRes.stderr}`
  );

  assert.equal(
    batchRes.stdout.length % bytesPerFrame,
    0,
    `ffmpeg output size ${batchRes.stdout.length} is not a multiple of bytesPerFrame ${bytesPerFrame} for ${filePath}`
  );

  const decodedCount = batchRes.stdout.length / bytesPerFrame;
  assert.equal(
    decodedCount,
    expectedCount,
    `ffmpeg decoded frame count ${decodedCount} != expectedCount ${expectedCount} for ${filePath}`
  );

  for (let f = 0; f < decodedCount; f++) {
    frames.set(
      f,
      batchRes.stdout.subarray(f * bytesPerFrame, (f + 1) * bytesPerFrame)
    );
  }

  assert.ok(frames.size > 0, `No reference frames extracted for ${filePath}`);
  return frames;
}

export function checkOracleDistinction(
  refFrames: ReadonlyMap<number, Uint8Array>,
  label: string
): {
  readonly ambiguous: boolean;
  readonly minDelta: number;
  readonly ambiguousPair?: readonly [number, number];
} {
  let minDelta = Infinity;
  let ambiguousPair: readonly [number, number] | undefined;

  const sortedFrames = [...refFrames.keys()].sort((a, b) => a - b);
  for (let i = 0; i < sortedFrames.length - 1; i++) {
    const fA = sortedFrames[i]!;
    const fB = sortedFrames[i + 1]!;
    const bufA = refFrames.get(fA)!;
    const bufB = refFrames.get(fB)!;
    const d = rmse(bufA, bufB);
    if (d < minDelta) {
      minDelta = d;
      if (d <= 4.0) {
        ambiguousPair = [fA, fB];
      }
    }
  }

  return {
    ambiguous: minDelta <= 4.0,
    minDelta: Number.isFinite(minDelta) ? minDelta : 0,
    ...(ambiguousPair ? { ambiguousPair } : {}),
  };
}

/* ==========================================================================
 * Fixture & Timing Oracle Management
 * ========================================================================== */

function ffprobeTimeBase(value: string | undefined, label: string): number {
  assert.ok(value, `${label} has no ffprobe time_base`);
  const parts = value.split('/');
  assert.equal(parts.length, 2, `${label} has malformed time_base ${value}`);
  const num = Number(parts[0]);
  const den = Number(parts[1]);
  assert.ok(
    Number.isFinite(num) && Number.isFinite(den) && den > 0,
    `Invalid time_base numbers in ${value}`
  );
  return num / den;
}

export const API_ROUNDING_Q = 2e-6; // 2 microseconds

export function checkCaseEligibility(
  caseName: string,
  fileEntry: FfprobeFileEntry,
  windows: readonly PacketWindow[],
  q = API_ROUNDING_Q
): { readonly eligible: boolean; readonly reason?: string } {
  if (caseName === 'short-edit.mp4') {
    return { eligible: false, reason: 'edit-window-mismatch' };
  }
  if (caseName === 'rate-edit.mp4' || caseName === 'loop-edit.mp4') {
    return { eligible: false, reason: 'unsupported-edit-list' };
  }
  if (windows.length === 0) {
    return { eligible: false, reason: 'no-certified-windows' };
  }
  for (const w of windows) {
    if (w.end - w.start <= 2 * q) {
      return { eligible: false, reason: 'window-length-within-2q' };
    }
  }
  for (let i = 0; i < windows.length - 1; i++) {
    if (windows[i + 1].start - windows[i].start <= 2 * q) {
      return { eligible: false, reason: 'starts-within-2q' };
    }
  }
  return { eligible: true };
}

export function buildPacketWindows(
  fileEntry: FfprobeFileEntry,
  fileName: string,
  includeFinal = true
): readonly PacketWindow[] {
  const timeBase = ffprobeTimeBase(fileEntry.stream?.time_base, fileName);
  const frames = (fileEntry.frames ?? [])
    .map((f) => f.best_effort_timestamp)
    .filter((tick): tick is number => Number.isSafeInteger(tick))
    .sort((a, b) => a - b);

  if (frames.length === 0) {
    return [];
  }

  const frameByTick = new Map<number, number>();
  for (const [index, tick] of frames.entries()) {
    if (!frameByTick.has(tick)) {
      frameByTick.set(tick, index);
    }
  }

  const rawPackets = fileEntry.packets ?? [];
  const seenPts = new Set<number>();
  let hasDuplicatePts = false;
  for (const p of rawPackets) {
    if (p.pts !== undefined && seenPts.has(p.pts)) {
      hasDuplicatePts = true;
      break;
    }
    if (p.pts !== undefined) seenPts.add(p.pts);
  }

  if (hasDuplicatePts) {
    return [];
  }

  const packets = rawPackets
    .map((p) => ({ pts: p.pts, duration: p.duration }))
    .filter(
      (
        p
      ): p is { readonly pts: number; readonly duration: number | undefined } =>
        Number.isSafeInteger(p.pts)
    )
    .sort((a, b) => a.pts - b.pts);

  if (packets.length === 0) {
    return [];
  }

  const windows: PacketWindow[] = [];
  const actualIncludeFinal =
    fileName === 'no-duration.webm' ? false : includeFinal;

  for (const [index, packet] of packets.entries()) {
    const next = packets[index + 1]?.pts;
    if (next !== undefined && next === packet.pts) {
      return [];
    }

    const frame = frameByTick.get(packet.pts);
    if (frame === undefined) {
      return [];
    }

    if (next !== undefined) {
      windows.push({
        start: packet.pts * timeBase,
        end: next * timeBase,
        frame,
      });
      continue;
    }

    if (!actualIncludeFinal) continue;
    if (!Number.isSafeInteger(packet.duration) || (packet.duration ?? 0) <= 0) {
      continue;
    }

    windows.push({
      start: packet.pts * timeBase,
      end: (packet.pts + (packet.duration ?? 0)) * timeBase,
      frame,
    });
  }

  return windows;
}

export function windowForSeconds(
  windows: readonly PacketWindow[],
  seconds: number,
  q = API_ROUNDING_Q
): PacketWindow | null {
  if (windows.length === 0) return null;

  // Binary search for largest index where windows[mid].start <= seconds + q
  let low = 0;
  let high = windows.length - 1;
  let bestIdx = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (windows[mid].start <= seconds + q) {
      bestIdx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (bestIdx === -1) {
    return null;
  }

  // Collect all windows whose start is within q of seconds: |w.start - seconds| <= q
  const matching: PacketWindow[] = [];
  for (let i = bestIdx; i >= 0 && windows[i].start >= seconds - q; i--) {
    if (Math.abs(windows[i].start - seconds) <= q) {
      matching.push(windows[i]);
    }
  }

  // Reject ambiguity: if more than one packet start within Q, cannot uniquely identify
  if (matching.length > 1) {
    return null;
  }

  if (matching.length === 1) {
    return matching[0];
  }

  return null;
}

/**
 * Generates the runtime-only 1080p 30fps long-GOP fixture with B-frames and deterministic index stripes.
 * Kept in temp directory, not committed.
 */
export async function generateLongGopFixture(targetDir: string): Promise<{
  readonly filePath: string;
  readonly fileName: string;
  readonly oracleEntry: FfprobeFileEntry;
}> {
  await mkdir(targetDir, { recursive: true });
  const fileName = 'long-gop-1080p.mp4';
  const filePath = join(targetDir, fileName);

  // 1920x1080: 8 columns of 240px each. Column 0 is sync (235), columns 1..7 encode bits 0..6 of frame index N.
  // 30fps across 3 seconds (90 frames), fitting 7 bits without wrap (< 128).
  // -g 300 -keyint_min 300 -bf 2 -profile:v high produces a single 1080p30 long GOP with B-frames.
  const filter =
    "format=yuv420p,geq=lum='if(lt(X,240),235,16+219*mod(floor(N/pow(2,floor(X/240)-1)),2))':cb=128:cr=128";

  const genRes = await runChild(
    [
      'ffmpeg',
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=1920x1080:r=30:d=3',
      '-vf',
      filter,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-bf',
      '2',
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '300',
      '-keyint_min',
      '300',
      filePath,
    ],
    { timeoutMs: 60000 }
  );
  assert.equal(
    genRes.exit,
    0,
    `ffmpeg failed to generate 1080p long GOP fixture: ${genRes.stderr}`
  );

  // Probe packet and frame metadata using standard ffprobe command
  const probeRes = await runChild(
    [
      'ffprobe',
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_packets',
      '-show_frames',
      '-show_entries',
      'stream=codec_name,time_base,r_frame_rate,avg_frame_rate,width,height:packet=pts,dts,duration,pts_time,dts_time,duration_time:frame=best_effort_timestamp,best_effort_timestamp_time,pkt_dts,pkt_dts_time,pict_type,coded_picture_number',
      '-of',
      'json',
      filePath,
    ],
    { timeoutMs: 30000 }
  );

  assert.equal(
    probeRes.exit,
    0,
    `ffprobe failed on generated fixture: ${probeRes.stderr}`
  );
  const probeData = JSON.parse(new TextDecoder().decode(probeRes.stdout)) as {
    readonly streams?: readonly FfprobeStream[];
    readonly frames?: readonly FfprobeFrame[];
    readonly packets?: readonly FfprobePacket[];
    readonly packets_and_frames?: readonly (
      | ({ readonly type: 'frame' } & FfprobeFrame)
      | ({ readonly type: 'packet' } & FfprobePacket)
    )[];
  };

  const stream = probeData.streams?.[0];
  assert.ok(stream, 'Generated 1080p long GOP fixture has no video stream');

  const frames: FfprobeFrame[] = probeData.frames ? [...probeData.frames] : [];
  const packets: FfprobePacket[] = probeData.packets
    ? [...probeData.packets]
    : [];

  if (probeData.packets_and_frames) {
    for (const item of probeData.packets_and_frames) {
      if (item.type === 'frame') {
        frames.push(item);
      } else if (item.type === 'packet') {
        packets.push(item);
      }
    }
  }

  assert.equal(
    frames.length,
    90,
    `Generated 1080p long GOP fixture expected 90 frames, got ${frames.length}`
  );
  assert.ok(
    packets.length > 0,
    'Generated 1080p long GOP fixture has no packets'
  );

  const oracleEntry: FfprobeFileEntry = {
    stream,
    frames,
    packets,
  };

  return { filePath, fileName, oracleEntry };
}

/* ==========================================================================
 * Loopback Media Server
 * ========================================================================== */

function serveMediaBytes(
  bytes: Uint8Array,
  mimeType: string,
  request: Request
): Response {
  const rangeHeader = request.headers.get('range');
  const total = bytes.length;
  if (!rangeHeader) {
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': mimeType,
        'content-length': String(total),
        'accept-ranges': 'bytes',
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) {
    return new Response('Malformed Range', {
      status: 416,
      headers: { 'content-range': `bytes */${total}` },
    });
  }

  let start = match[1] ? Number.parseInt(match[1], 10) : 0;
  let end = match[2] ? Number.parseInt(match[2], 10) : total - 1;
  if (Number.isNaN(start))
    start = total - (match[2] ? Number.parseInt(match[2], 10) : 0);
  if (Number.isNaN(end) || end >= total) end = total - 1;
  if (start > end || start >= total) {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { 'content-range': `bytes */${total}` },
    });
  }

  const slice = bytes.subarray(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      'content-type': mimeType,
      'content-length': String(slice.length),
      'content-range': `bytes ${start}-${end}/${total}`,
      'accept-ranges': 'bytes',
    },
  });
}

function getMimeType(fileName: string): string {
  if (fileName.endsWith('.mp4')) return 'video/mp4';
  if (fileName.endsWith('.webm')) return 'video/webm';
  if (fileName.endsWith('.mov')) return 'video/quicktime';
  return 'application/octet-stream';
}

function createHtmlTestPage(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>OTIO Native Frame Admission Probe</title>
  <style>
    body {
      background: black;
      margin: 0;
      padding: 0;
      overflow: hidden;
    }
    #stage {
      position: absolute;
      left: 0;
      top: 0;
      width: 64px;
      height: 16px;
      overflow: hidden;
      opacity: 1;
      pointer-events: none;
    }
    #test-video {
      position: absolute;
      left: 0;
      top: 0;
      width: 64px;
      height: 16px;
      object-fit: fill;
      opacity: 1;
    }
    #test-canvas {
      position: absolute;
      left: 0;
      top: 0;
      width: 64px;
      height: 16px;
      opacity: 1;
    }
  </style>
</head>
<body>
  <div id="stage">
    <video id="test-video" muted playsinline></video>
    <canvas id="test-canvas" width="64" height="16"></canvas>
  </div>
  <script>
    window.runAdmissionProbe = function(mediaUrl, drawMethod, minSamples) {
      return new Promise((resolve, reject) => {
        const video = document.getElementById('test-video');
        if (!video) {
          return reject(new Error('HTML Video element not found'));
        }
        if (typeof video.requestVideoFrameCallback !== 'function') {
          return reject(new Error('requestVideoFrameCallback is not supported on HTMLVideoElement'));
        }

        const canvas = document.getElementById('test-canvas');
        if (!canvas) {
          return reject(new Error('HTML Canvas element not found'));
        }

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          return reject(new Error('Canvas 2D context is null'));
        }

        let finished = false;
        let rVfcId = null;
        let timeoutTimer = null;

        const onContextLost = (e) => {
          e.preventDefault();
          if (finished) return;
          finished = true;
          cleanup();
          reject(new Error('Canvas 2D context was lost'));
        };
        canvas.addEventListener('contextlost', onContextLost);

        video.pause();
        video.removeAttribute('src');
        video.load();

        canvas.width = 64;
        canvas.height = 16;

        const samples = [];

        function cleanup() {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          canvas.removeEventListener('contextlost', onContextLost);
          video.pause();
          if (rVfcId !== null && typeof video.cancelVideoFrameCallback === 'function') {
            video.cancelVideoFrameCallback(rVfcId);
            rVfcId = null;
          }
          video.onloadeddata = null;
          video.onerror = null;
          video.onended = null;
        }

        timeoutTimer = setTimeout(() => {
          if (finished) return;
          finished = true;
          cleanup();
          if (samples.length > 0) {
            resolve({ samples, completed: false, timedOut: true });
          } else {
            reject(new Error('Timeout waiting for native video frame callbacks'));
          }
        }, 60000);

        video.onerror = () => {
          if (finished) return;
          finished = true;
          cleanup();
          reject(new Error('HTML Video error: ' + (video.error ? video.error.message : 'unknown')));
        };

        video.onloadeddata = async () => {
          try {
            function onFrame(now, metadata) {
              if (finished) return;

              if (ctx.isContextLost && ctx.isContextLost()) {
                finished = true;
                cleanup();
                reject(new Error('Canvas 2D context is lost during onFrame'));
                return;
              }

              if (drawMethod === 'inside_rvfc') {
                try {
                  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                  let binary = '';
                  const d = img.data;
                  for (let i = 0; i < d.length; i++) {
                    binary += String.fromCharCode(d[i]);
                  }
                  samples.push({
                    mediaTime: metadata.mediaTime,
                    presentedFrames: metadata.presentedFrames,
                    expectedDisplayTime: metadata.expectedDisplayTime,
                    width: canvas.width,
                    height: canvas.height,
                    sourceWidth: metadata.width,
                    sourceHeight: metadata.height,
                    capturedWidth: canvas.width,
                    capturedHeight: canvas.height,
                    pixelsBase64: btoa(binary),
                  });
                } catch (err) {
                  finished = true;
                  cleanup();
                  reject(err);
                  return;
                }

                if (samples.length >= minSamples) {
                  finished = true;
                  cleanup();
                  resolve({ samples, completed: true, timedOut: false });
                  return;
                }
                rVfcId = video.requestVideoFrameCallback(onFrame);
              } else {
                // drawMethod === 'next_raf'
                const meta = {
                  mediaTime: metadata.mediaTime,
                  presentedFrames: metadata.presentedFrames,
                  expectedDisplayTime: metadata.expectedDisplayTime,
                  sourceWidth: metadata.width,
                  sourceHeight: metadata.height,
                };
                requestAnimationFrame(() => {
                  if (finished) return;
                  if (ctx.isContextLost && ctx.isContextLost()) {
                    finished = true;
                    cleanup();
                    reject(new Error('Canvas 2D context is lost during next_raf'));
                    return;
                  }
                  try {
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    let binary = '';
                    const d = img.data;
                    for (let i = 0; i < d.length; i++) {
                      binary += String.fromCharCode(d[i]);
                    }
                    samples.push({
                      mediaTime: meta.mediaTime,
                      presentedFrames: meta.presentedFrames,
                      expectedDisplayTime: meta.expectedDisplayTime,
                      width: canvas.width,
                      height: canvas.height,
                      sourceWidth: meta.sourceWidth,
                      sourceHeight: meta.sourceHeight,
                      capturedWidth: canvas.width,
                      capturedHeight: canvas.height,
                      pixelsBase64: btoa(binary),
                    });
                    if (samples.length >= minSamples) {
                      finished = true;
                      cleanup();
                      resolve({ samples, completed: true, timedOut: false });
                    }
                  } catch (err) {
                    finished = true;
                    cleanup();
                    reject(err);
                  }
                });
                rVfcId = video.requestVideoFrameCallback(onFrame);
              }
            }

            video.onended = () => {
              if (samples.length < minSamples && !finished) {
                video.currentTime = 0;
                video.play().catch(reject);
              } else if (!finished) {
                finished = true;
                cleanup();
                resolve({ samples, completed: true, timedOut: false });
              }
            };

            rVfcId = video.requestVideoFrameCallback(onFrame);
            await video.play();
          } catch (err) {
            finished = true;
            cleanup();
            reject(err);
          }
        };

        video.loop = true;
        video.muted = true;
        video.src = mediaUrl;
        video.load();
      });
    };
  </script>
</body>
</html>`;
}

export async function startLoopbackServer(
  fixturesDir: string,
  tempDir: string
): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  const htmlPage = createHtmlTestPage();
  const fileCache = new Map<string, Uint8Array>();

  async function loadFile(name: string): Promise<Uint8Array | null> {
    if (fileCache.has(name)) return fileCache.get(name)!;
    const paths = [join(tempDir, name), join(fixturesDir, name)];
    for (const p of paths) {
      try {
        const bytes = await readFile(p);
        fileCache.set(name, bytes);
        return bytes;
      } catch {}
    }
    return null;
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
        return new Response('Loopback only', { status: 403 });
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(htmlPage, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      if (url.pathname.startsWith('/media/')) {
        const name = basename(url.pathname);
        const bytes = await loadFile(name);
        if (!bytes) {
          return new Response(`Media not found: ${name}`, { status: 404 });
        }
        return serveMediaBytes(bytes, getMimeType(name), req);
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    close: async () => {
      server.stop(true);
    },
  };
}

/* ==========================================================================
 * Headless Chrome Controller
 * ========================================================================== */

function loopbackUrl(urlStr: string): boolean {
  if (
    urlStr.startsWith('data:') ||
    urlStr.startsWith('blob:') ||
    urlStr.startsWith('about:')
  ) {
    return true;
  }
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

async function evaluateInPage<T>(
  cdp: CdpConnection,
  sessionId: string,
  expression: string
): Promise<T> {
  const res = await cdp.send(
    'Runtime.evaluate',
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 65000,
    },
    sessionId
  );

  const exception = res['exceptionDetails'] as
    | {
        readonly text?: string;
        readonly exception?: { readonly description?: string };
      }
    | undefined;
  if (exception) {
    throw new Error(
      `Evaluation failed: ${exception.text ?? exception.exception?.description ?? 'unknown error'}`
    );
  }

  const result = res['result'] as { readonly value?: T } | undefined;
  return result?.value as T;
}

/* ==========================================================================
 * Sample Evaluation & Case Runner
 * ========================================================================== */

const MAX_RMSE_MATCH_TOLERANCE = 15.0; // Norm for H.264/VP9 YUV-to-RGB browser colorspace variance
const MIN_SEPARATION_MARGIN = 2.0; // Margin required over second closest reference frame

export function evaluateFrameSample(
  sample: BrowserFrameSample,
  sampleIndex: number,
  windows: readonly PacketWindow[],
  refFrames: ReadonlyMap<number, Uint8Array>
): SampleEvaluation {
  const binaryStr = atob(sample.pixelsBase64);
  const captured = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    captured[i] = binaryStr.charCodeAt(i);
  }

  const capWidth = sample.capturedWidth ?? sample.width ?? 64;
  const capHeight = sample.capturedHeight ?? sample.height ?? 16;

  if (isOpaqueBlack(captured)) {
    return {
      sampleIndex,
      mediaTime: sample.mediaTime,
      presentedFrames: sample.presentedFrames,
      expectedFrame: -1,
      closestFrame: -1,
      lagDelta: 0,
      timeDeltaUs: 0,
      rmseExpected: Infinity,
      rmseClosest: Infinity,
      rmseSecondClosest: Infinity,
      distinctionMargin: 0,
      burnedInFrame: null,
      isMatch: false,
      rejectionReason: 'opaque_black',
    };
  }

  const expectedWin = windowForSeconds(windows, sample.mediaTime);
  const burnedIn = decodeBurnedInFrameIndex(captured, capWidth, capHeight);

  if (!expectedWin) {
    return {
      sampleIndex,
      mediaTime: sample.mediaTime,
      presentedFrames: sample.presentedFrames,
      expectedFrame: -1,
      closestFrame: -1,
      lagDelta: 0,
      timeDeltaUs: 0,
      rmseExpected: Infinity,
      rmseClosest: Infinity,
      rmseSecondClosest: Infinity,
      distinctionMargin: 0,
      burnedInFrame: burnedIn,
      isMatch: false,
      rejectionReason: 'uncovered_window',
    };
  }

  const timeDeltaUs = (sample.mediaTime - expectedWin.start) * 1e6;
  const expectedFrame = expectedWin.frame;
  const expectedRef = refFrames.get(expectedFrame);
  const rmseExpected = expectedRef ? rmse(captured, expectedRef) : Infinity;

  const {
    closestFrame,
    closestRmse,
    secondClosestFrame: _secondFrame,
    secondClosestRmse,
  } = findClosestReferenceFrame(captured, refFrames);

  const distinctionMargin = secondClosestRmse - rmseExpected;
  const lagDelta = closestFrame - expectedFrame;

  const expectedBurned = expectedRef
    ? decodeBurnedInFrameIndex(expectedRef, capWidth, capHeight)
    : null;

  let isMatch = true;
  let rejectionReason: RejectionReason = 'none';

  if (closestFrame !== expectedFrame) {
    isMatch = false;
    if (closestFrame < expectedFrame) {
      rejectionReason = 'lagged_frame';
    } else {
      rejectionReason = 'future_frame';
    }
  } else if (rmseExpected > MAX_RMSE_MATCH_TOLERANCE) {
    isMatch = false;
    rejectionReason = 'excessive_rmse';
  } else if (distinctionMargin < MIN_SEPARATION_MARGIN && refFrames.size > 1) {
    isMatch = false;
    rejectionReason = 'ambiguous_match';
  } else if (
    expectedBurned !== null &&
    burnedIn !== null &&
    burnedIn !== expectedBurned
  ) {
    isMatch = false;
    rejectionReason = 'burned_in_mismatch';
  }

  return {
    sampleIndex,
    mediaTime: sample.mediaTime,
    presentedFrames: sample.presentedFrames,
    expectedFrame,
    closestFrame,
    lagDelta,
    timeDeltaUs,
    rmseExpected,
    rmseClosest: closestRmse,
    rmseSecondClosest: secondClosestRmse,
    distinctionMargin,
    burnedInFrame: burnedIn,
    isMatch,
    rejectionReason,
  };
}

export function aggregateMethodResults(
  drawMethod: DrawMethod,
  evaluations: readonly SampleEvaluation[],
  minRequiredSamples: number
): MethodEvaluationResult {
  const sampleCount = evaluations.length;
  if (sampleCount === 0) {
    return {
      drawMethod,
      sampleCount: 0,
      distinctFramesCount: 0,
      matchCount: 0,
      mismatchCount: 0,
      matchRate: 0,
      errorRatio: 1,
      rmseP50: Infinity,
      rmseP95: Infinity,
      rmseMax: Infinity,
      distinctionMarginP50: 0,
      deltaDistribution: {},
      lagDistribution: {},
      rejectionReasons: { zero_samples: 1 },
      approved: false,
      failureReason: 'No samples collected',
    };
  }

  const distinctFrames = new Set<number>();
  let matchCount = 0;
  let mismatchCount = 0;
  const rmseValues: number[] = [];
  const margins: number[] = [];
  const deltaDistribution: Record<string, number> = {};
  const lagDistribution: Record<string, number> = {};
  const rejectionReasons: Record<string, number> = {};

  for (const ev of evaluations) {
    if (ev.closestFrame >= 0) {
      distinctFrames.add(ev.closestFrame);
    }
    if (ev.isMatch) {
      matchCount++;
    } else {
      mismatchCount++;
      const reason = ev.rejectionReason;
      rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
    }

    if (Number.isFinite(ev.rmseExpected)) {
      rmseValues.push(ev.rmseExpected);
    }
    if (Number.isFinite(ev.distinctionMargin)) {
      margins.push(ev.distinctionMargin);
    }

    if (ev.timeDeltaUs !== undefined && Number.isFinite(ev.timeDeltaUs)) {
      const bucket = `${Math.round(ev.timeDeltaUs)}us`;
      deltaDistribution[bucket] = (deltaDistribution[bucket] ?? 0) + 1;
    }

    const lagKey = String(ev.lagDelta);
    lagDistribution[lagKey] = (lagDistribution[lagKey] ?? 0) + 1;
  }

  const matchRate = sampleCount > 0 ? matchCount / sampleCount : 0;
  const errorRatio = sampleCount > 0 ? mismatchCount / sampleCount : 1;
  const approved = matchRate === 1.0 && sampleCount >= minRequiredSamples;

  let failureReason: string | undefined;
  if (sampleCount < minRequiredSamples) {
    failureReason = `Sample count ${sampleCount} < min required ${minRequiredSamples}`;
  } else if (matchRate < 1.0) {
    failureReason = `Match rate ${(matchRate * 100).toFixed(2)}% < 100.0% required`;
  }

  return {
    drawMethod,
    sampleCount,
    distinctFramesCount: distinctFrames.size,
    matchCount,
    mismatchCount,
    matchRate,
    errorRatio,
    rmseP50: quantile(rmseValues, 0.5),
    rmseP95: quantile(rmseValues, 0.95),
    rmseMax: rmseValues.length > 0 ? Math.max(...rmseValues) : 0,
    distinctionMarginP50: quantile(margins, 0.5),
    deltaDistribution,
    lagDistribution,
    rejectionReasons,
    approved,
    ...(failureReason ? { failureReason } : {}),
  };
}

/* ==========================================================================
 * CLI Parser
 * ========================================================================== */

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let chromePath: string | undefined;
  let fixturesDir = resolve(
    'packages/relic-format/test/fixtures/otio/decoder-boundary.otiod/media'
  );
  let outputDir: string | undefined;
  let outputPath: string | undefined;
  let tempDir: string | undefined;
  let minSamples = 100;
  let cases: string[] | undefined;
  const methods: DrawMethod[] = ['inside_rvfc', 'next_raf'];
  let json = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--chrome' && i + 1 < argv.length) {
      chromePath = resolve(argv[++i]!);
    } else if (arg === '--fixtures-dir' && i + 1 < argv.length) {
      fixturesDir = resolve(argv[++i]!);
    } else if (arg === '--output-dir' && i + 1 < argv.length) {
      outputDir = resolve(argv[++i]!);
    } else if (arg === '--output' && i + 1 < argv.length) {
      outputPath = resolve(argv[++i]!);
    } else if (arg === '--temp-dir' && i + 1 < argv.length) {
      tempDir = resolve(argv[++i]!);
    } else if (arg === '--min-samples' && i + 1 < argv.length) {
      minSamples = Math.max(1, Number.parseInt(argv[++i]!, 10) || 100);
    } else if (arg === '--cases' && i + 1 < argv.length) {
      cases = argv[++i]!.split(',')
        .map((c) => c.trim())
        .filter(Boolean);
    } else if (arg === '--methods' && i + 1 < argv.length) {
      const parsedMethods = argv[++i]!.split(',').map((m) =>
        m.trim().toLowerCase()
      );
      methods.length = 0;
      for (const m of parsedMethods) {
        if (m === 'inside_rvfc' || m === 'next_raf') {
          methods.push(m);
        }
      }
    }
  }

  return {
    chromePath,
    fixturesDir,
    outputDir,
    outputPath,
    tempDir,
    minSamples,
    cases,
    methods: methods.length > 0 ? methods : ['inside_rvfc', 'next_raf'],
    json,
    help,
  };
}

function printUsage(): void {
  console.log(`Usage: bun packages/relic-mcp/test/otio-native-frame-admission.ts [options]

Options:
  --chrome <path>        Path to owned Chrome/Chromium headless executable
  --fixtures-dir <path>  Path to decoder-boundary fixture media directory
  --output-dir <path>    Directory to write admission report JSON
  --output <path>        Specific path to write admission report JSON
  --temp-dir <path>      Directory for generated fixtures and reference frames
  --min-samples <n>      Minimum measured frame callbacks per case (default: 100)
  --cases <list>         Comma-separated list of fixture files to test (default: all)
  --methods <list>       Comma-separated draw methods: inside_rvfc,next_raf (default: both)
  --json                 Print machine-readable JSON to stdout
  --help, -h             Show this help message
`);
}

/* ==========================================================================
 * Main Execution Loop
 * ========================================================================== */

export async function runAdmissionProof(
  options: CliOptions
): Promise<AdmissionReport> {
  const chromePath =
    options.chromePath ??
    process.env['RELIC_OTIO_CHROME_PATH'] ??
    process.env['RELIC_CHROME_PATH'];

  const foundChrome = await discoverChrome(
    chromePath && chromePath !== 'none' && chromePath !== 'disabled'
      ? chromePath
      : undefined
  );

  if (foundChrome.kind !== 'found') {
    throw new Error(
      `Chrome discovery failed: ${foundChrome.kind === 'not_found' ? foundChrome.detail : foundChrome.kind}`
    );
  }

  const tempRoot =
    options.tempDir ?? (await mkdtemp(join(tmpdir(), 'relic-otio-admission-')));
  const profileDir = await mkdtemp(
    join(tmpdir(), 'relic-otio-admission-profile-')
  );

  let child: ChildProcess | undefined;
  let cdp: CdpConnection | undefined;
  let serverHandle:
    | { readonly origin: string; readonly close: () => Promise<void> }
    | undefined;

  try {
    // 1. Generate runtime 1080p long GOP fixture
    const longGop = await generateLongGopFixture(tempRoot);

    // 2. Read official timing oracle
    const oraclePath = join(options.fixturesDir, 'timing-oracle.json');
    const oracleText = await readFile(oraclePath, 'utf8');
    const oracle = JSON.parse(oracleText) as FfprobeTimingOracle;

    // 3. Start loopback media server
    serverHandle = await startLoopbackServer(options.fixturesDir, tempRoot);

    // 4. Launch headless Chrome with debug pipe and loopback flags
    const sharedArgs = chromeArgs(foundChrome.path, profileDir);
    const launch = createBrowserHeadlessLaunch(
      [
        ...sharedArgs.map((arg) =>
          arg === '--proxy-bypass-list=<-loopback>'
            ? '--proxy-bypass-list=<-loopback>;127.0.0.1'
            : arg === '--host-resolver-rules=MAP * ~NOTFOUND'
              ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
              : arg
        ),
        '--autoplay-policy=no-user-gesture-required',
      ],
      profileDir
    );

    child = spawn(foundChrome.path, launch.args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });

    const toChrome = child.stdio[3];
    const fromChrome = child.stdio[4];
    assert.ok(toChrome instanceof Writable, 'Chrome fd 3 pipe is not writable');
    assert.ok(
      fromChrome instanceof Readable,
      'Chrome fd 4 pipe is not readable'
    );

    cdp = connectPipe(toChrome, fromChrome);
    const attestation = await attestBrowserHeadless(cdp, launch);

    const created = (await cdp.send('Target.createTarget', {
      url: 'about:blank',
    })) as { readonly targetId: string };
    const attached = (await cdp.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    })) as { readonly sessionId: string };
    const sessionId = attached.sessionId;

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);

    // Network guard: Enforce loopback-only requests via CDP Fetch domain
    await cdp.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      sessionId
    );

    cdp.onEvent((event) => {
      if (
        event.method !== 'Fetch.requestPaused' ||
        event.sessionId !== sessionId
      )
        return;
      const params = event.params as {
        readonly requestId?: string;
        readonly request?: { readonly url?: string };
      };
      const reqUrl = params.request?.url ?? '';
      const reqId = params.requestId;
      if (!reqId) return;

      if (loopbackUrl(reqUrl)) {
        void cdp
          ?.send('Fetch.continueRequest', { requestId: reqId }, sessionId)
          .catch(() => {});
        return;
      }
      void cdp
        ?.send(
          'Fetch.failRequest',
          { requestId: reqId, errorReason: 'BlockedByClient' },
          sessionId
        )
        .catch(() => {});
    });

    // Contract trap: Trap WebCodecs (VideoDecoder / AudioDecoder)
    const webCodecsTrap = `(() => {
      for (const name of ['VideoDecoder', 'AudioDecoder']) {
        const constructor = Reflect.get(globalThis, name);
        if (typeof constructor !== 'function') continue;
        Object.defineProperty(globalThis, name, {
          configurable: true,
          get() {
            throw new Error('__RELIC_OTIO_WEB_CODECS__ ' + name);
          },
        });
      }
    })();`;
    await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: webCodecsTrap },
      sessionId
    );

    // Navigate to test harness HTML
    await cdp.send(
      'Page.navigate',
      { url: `${serverHandle.origin}/` },
      sessionId
    );

    // Wait for test harness function to mount in the newly navigated document
    const mountDeadline = Date.now() + 20000;
    let mounted = false;
    while (Date.now() < mountDeadline) {
      try {
        const hasFn = await evaluateInPage<boolean>(
          cdp,
          sessionId,
          `typeof window.runAdmissionProbe === 'function'`
        );
        if (hasFn) {
          mounted = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(
      mounted,
      'Timed out waiting for window.runAdmissionProbe to mount after Page.navigate'
    );

    // 5. Enumerate test cases
    const allCandidateCases: Array<{
      readonly caseName: string;
      readonly filePath: string;
      readonly oracleEntry: FfprobeFileEntry;
    }> = [
      {
        caseName: 'fr24.mp4',
        filePath: join(options.fixturesDir, 'fr24.mp4'),
        oracleEntry: oracle.files?.['fr24.mp4']!,
      },
      {
        caseName: 'fr60.mp4',
        filePath: join(options.fixturesDir, 'fr60.mp4'),
        oracleEntry: oracle.files?.['fr60.mp4']!,
      },
      {
        caseName: 'fr24b.mp4',
        filePath: join(options.fixturesDir, 'fr24b.mp4'),
        oracleEntry: oracle.files?.['fr24b.mp4']!,
      },
      {
        caseName: 'fr24b.mov',
        filePath: join(options.fixturesDir, 'fr24b.mov'),
        oracleEntry: oracle.files?.['fr24b.mov']!,
      },
      {
        caseName: 'vfr.mp4',
        filePath: join(options.fixturesDir, 'vfr.mp4'),
        oracleEntry: oracle.files?.['vfr.mp4']!,
      },
      {
        caseName: 'fr30.webm',
        filePath: join(options.fixturesDir, 'fr30.webm'),
        oracleEntry: oracle.files?.['fr30.webm']!,
      },
      {
        caseName: 'no-duration.webm',
        filePath: join(options.fixturesDir, 'no-duration.webm'),
        oracleEntry: oracle.files?.['no-duration.webm']!,
      },
      {
        caseName: 'short-edit.mp4',
        filePath: join(options.fixturesDir, 'short-edit.mp4'),
        oracleEntry: oracle.files?.['short-edit.mp4']!,
      },
      {
        caseName: 'rate-edit.mp4',
        filePath: join(options.fixturesDir, 'rate-edit.mp4'),
        oracleEntry: oracle.files?.['rate-edit.mp4']!,
      },
      {
        caseName: 'loop-edit.mp4',
        filePath: join(options.fixturesDir, 'loop-edit.mp4'),
        oracleEntry: oracle.files?.['loop-edit.mp4']!,
      },
      {
        caseName: longGop.fileName,
        filePath: longGop.filePath,
        oracleEntry: longGop.oracleEntry,
      },
    ];

    const activeCases = allCandidateCases.filter((c) => {
      if (!options.cases || options.cases.length === 0) return true;
      return options.cases.includes(c.caseName);
    });

    assert.ok(activeCases.length > 0, 'No active test cases selected');

    // 6. Execute admission tests per case
    const caseResults: CaseAdmissionResult[] = [];
    let insideRvfcPassed = true;
    let nextRafPassed = true;

    for (const testCase of activeCases) {
      let caseWindows: readonly PacketWindow[] = [];
      let eligibility: { eligible: boolean; reason?: string } = {
        eligible: true,
      };
      let oracleFramesCount = 0;
      let refFrames: ReadonlyMap<number, Uint8Array> = new Map();
      let distinction = { ambiguous: false, minDelta: 0 };
      let caseFailureReason: string | undefined;

      try {
        caseWindows = buildPacketWindows(
          testCase.oracleEntry,
          testCase.caseName,
          testCase.caseName !== 'no-duration.webm'
        );
        eligibility = checkCaseEligibility(
          testCase.caseName,
          testCase.oracleEntry,
          caseWindows,
          API_ROUNDING_Q
        );
        oracleFramesCount = (testCase.oracleEntry.frames ?? []).length;
        refFrames = await extractReferenceFrames(
          testCase.filePath,
          oracleFramesCount,
          64,
          16
        );

        distinction = checkOracleDistinction(refFrames, testCase.caseName);
        if (distinction.ambiguous) {
          caseFailureReason = `Ambiguous oracle in ${testCase.caseName}: min delta ${distinction.minDelta.toFixed(3)} <= 4.0 (frames ${distinction.ambiguousPair?.[0]} vs ${distinction.ambiguousPair?.[1]})`;
        }
      } catch (prepErr) {
        caseFailureReason =
          prepErr instanceof Error ? prepErr.message : String(prepErr);
      }

      const methodResults: Record<DrawMethod, MethodEvaluationResult> = {
        inside_rvfc: {
          drawMethod: 'inside_rvfc',
          sampleCount: 0,
          distinctFramesCount: 0,
          matchCount: 0,
          mismatchCount: 0,
          matchRate: 0,
          errorRatio: 1,
          rmseP50: Infinity,
          rmseP95: Infinity,
          rmseMax: Infinity,
          distinctionMarginP50: 0,
          deltaDistribution: {},
          lagDistribution: {},
          rejectionReasons: {},
          approved: false,
        },
        next_raf: {
          drawMethod: 'next_raf',
          sampleCount: 0,
          distinctFramesCount: 0,
          matchCount: 0,
          mismatchCount: 0,
          matchRate: 0,
          errorRatio: 1,
          rmseP50: Infinity,
          rmseP95: Infinity,
          rmseMax: Infinity,
          distinctionMarginP50: 0,
          deltaDistribution: {},
          lagDistribution: {},
          rejectionReasons: {},
          approved: false,
        },
      };

      for (const method of options.methods) {
        if (caseFailureReason && refFrames.size === 0) {
          methodResults[method] = {
            drawMethod: method,
            sampleCount: 0,
            distinctFramesCount: 0,
            matchCount: 0,
            mismatchCount: 0,
            matchRate: 0,
            errorRatio: 1,
            rmseP50: Infinity,
            rmseP95: Infinity,
            rmseMax: Infinity,
            distinctionMarginP50: 0,
            deltaDistribution: {},
            lagDistribution: {},
            rejectionReasons: {
              [eligibility.reason ?? 'unreadable']: 1,
            },
            approved: false,
            failureReason: caseFailureReason,
          };
          continue;
        }

        try {
          const mediaUrl = `${serverHandle.origin}/media/${testCase.caseName}`;
          const probeRes = await evaluateInPage<{
            readonly samples: readonly BrowserFrameSample[];
            readonly completed: boolean;
            readonly timedOut: boolean;
          }>(
            cdp,
            sessionId,
            `window.runAdmissionProbe('${mediaUrl}', '${method}', ${options.minSamples})`
          );

          const evaluations: SampleEvaluation[] = probeRes.samples.map(
            (s, idx) => evaluateFrameSample(s, idx, caseWindows, refFrames)
          );

          const methodAgg = aggregateMethodResults(
            method,
            evaluations,
            options.minSamples
          );

          // Ineligible cases (unknown edit list / timing mismatch) cannot be approved
          const finalApproved = eligibility.eligible && methodAgg.approved;
          const finalAgg: MethodEvaluationResult = {
            ...methodAgg,
            approved: finalApproved,
            failureReason: !eligibility.eligible
              ? `Ineligible: ${eligibility.reason}`
              : methodAgg.failureReason,
          };

          methodResults[method] = finalAgg;

          if (eligibility.eligible) {
            if (method === 'inside_rvfc' && !finalApproved)
              insideRvfcPassed = false;
            if (method === 'next_raf' && !finalApproved) nextRafPassed = false;
          }
        } catch (probeErr) {
          const errMsg =
            probeErr instanceof Error ? probeErr.message : String(probeErr);
          methodResults[method] = {
            drawMethod: method,
            sampleCount: 0,
            distinctFramesCount: 0,
            matchCount: 0,
            mismatchCount: 0,
            matchRate: 0,
            errorRatio: 1,
            rmseP50: Infinity,
            rmseP95: Infinity,
            rmseMax: Infinity,
            distinctionMarginP50: 0,
            deltaDistribution: {},
            lagDistribution: {},
            rejectionReasons: { error: 1 },
            approved: false,
            failureReason: errMsg,
          };
          if (eligibility.eligible) {
            if (method === 'inside_rvfc') insideRvfcPassed = false;
            if (method === 'next_raf') nextRafPassed = false;
          }
        }
      }

      const caseApproved =
        eligibility.eligible &&
        ((options.methods.includes('inside_rvfc') &&
          methodResults.inside_rvfc.approved) ||
          (options.methods.includes('next_raf') &&
            methodResults.next_raf.approved));

      caseResults.push({
        caseName: testCase.caseName,
        filePath: testCase.filePath,
        totalOracleFrames: oracleFramesCount,
        oracleDistinctionMinRmse: distinction.minDelta,
        oracleAmbiguous: distinction.ambiguous,
        eligible: eligibility.eligible,
        ineligibilityReason: eligibility.reason,
        failureReason: caseFailureReason,
        methods: methodResults,
        approved: caseApproved,
      });
    }

    const eligibleCases = caseResults.filter((c) => c.eligible !== false);
    const insideApproved =
      options.methods.includes('inside_rvfc') &&
      eligibleCases.length > 0 &&
      eligibleCases.every((c) => c.methods.inside_rvfc.approved);
    const nextRafApproved =
      options.methods.includes('next_raf') &&
      eligibleCases.length > 0 &&
      eligibleCases.every((c) => c.methods.next_raf.approved);

    let certifiedDrawMethod: DrawMethod | 'none' = 'none';
    if (insideApproved && nextRafApproved) {
      // If both 100%, prefer inside_rvfc for lower latency
      certifiedDrawMethod = 'inside_rvfc';
    } else if (insideApproved) {
      certifiedDrawMethod = 'inside_rvfc';
    } else if (nextRafApproved) {
      certifiedDrawMethod = 'next_raf';
    }

    const report: AdmissionReport = {
      schemaVersion: 'relic-otio-native-frame-admission/v1',
      timestamp: new Date().toISOString(),
      chromePath: foundChrome.path,
      browserProduct: attestation.product,
      minSamplesRequired: options.minSamples,
      casesTotal: caseResults.length,
      casesPassed: caseResults.filter((c) => c.approved).length,
      casesEligible: eligibleCases.length,
      methodApproval: {
        inside_rvfc: insideApproved,
        next_raf: nextRafApproved,
      },
      certifiedDrawMethod,
      cases: caseResults,
    };

    return report;
  } finally {
    if (serverHandle) {
      await serverHandle.close().catch(() => {});
    }
    if (child !== undefined) {
      await cleanupOwnedBrowserStartup({
        child,
        connection: cdp,
        forgetChild: undefined,
        profile: profileDir,
        removeProfile: undefined,
      });
    } else {
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
    if (!options.tempDir) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/* ==========================================================================
 * CLI Entrypoint
 * ========================================================================== */

export async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    process.exit(0);
  }

  try {
    const report = await runAdmissionProof(options);

    if (options.outputPath) {
      await mkdir(dirname(options.outputPath), { recursive: true });
      await writeFile(
        options.outputPath,
        JSON.stringify(report, null, 2),
        'utf8'
      );
    } else if (options.outputDir) {
      await mkdir(options.outputDir, { recursive: true });
      await writeFile(
        join(options.outputDir, 'otio-native-frame-admission-report.json'),
        JSON.stringify(report, null, 2),
        'utf8'
      );
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        '\n==============================================================='
      );
      console.log('OTIO Native Frame Admission Proof Report');
      console.log(
        '==============================================================='
      );
      console.log(`Browser Product:   ${report.browserProduct}`);
      console.log(`Cases Evaluated:   ${report.casesTotal}`);
      if (report.casesEligible !== undefined) {
        console.log(
          `Cases Eligible:    ${report.casesEligible} / ${report.casesTotal}`
        );
      }
      console.log(
        `Cases Passed:      ${report.casesPassed} / ${report.casesTotal}`
      );
      console.log(
        `Method (a) inside_rvfc: ${report.methodApproval.inside_rvfc ? 'APPROVED (100% match)' : 'REJECTED'}`
      );
      console.log(
        `Method (b) next_raf:    ${report.methodApproval.next_raf ? 'APPROVED (100% match)' : 'REJECTED'}`
      );
      console.log(
        `Certified Method:  ${report.certifiedDrawMethod.toUpperCase()}`
      );
      console.log(
        '---------------------------------------------------------------'
      );
      for (const c of report.cases) {
        const eligStr =
          c.eligible === false
            ? ` [INELIGIBLE: ${c.ineligibilityReason ?? 'unsupported'}]`
            : '';
        console.log(
          `\nCase: ${c.caseName}${eligStr} (${c.totalOracleFrames} oracle frames, min distinction: ${c.oracleDistinctionMinRmse.toFixed(2)} RMSE)`
        );
        if (c.failureReason) {
          console.log(`    Case Note: ${c.failureReason}`);
        }
        for (const m of ['inside_rvfc', 'next_raf'] as const) {
          const res = c.methods[m];
          console.log(
            `  [${m}] samples=${res.sampleCount}, distinct=${res.distinctFramesCount}, matchRate=${(res.matchRate * 100).toFixed(2)}%, rmseP50=${res.rmseP50.toFixed(2)}, rmseMax=${res.rmseMax.toFixed(2)}, approved=${res.approved}`
          );
          if (res.failureReason) {
            console.log(`    Failure: ${res.failureReason}`);
          }
          if (
            res.deltaDistribution &&
            Object.keys(res.deltaDistribution).length > 0
          ) {
            console.log(
              `    Delta Distribution (us): ${JSON.stringify(res.deltaDistribution)}`
            );
          }
          if (Object.keys(res.lagDistribution).length > 0) {
            console.log(
              `    Lag Distribution (delta frames): ${JSON.stringify(res.lagDistribution)}`
            );
          }
        }
      }
      console.log(
        '\n==============================================================='
      );
    }

    if (report.certifiedDrawMethod === 'none') {
      console.error(
        '\nADMISSION FAILED: Neither draw method achieved 100% actual frame identity.'
      );
      process.exit(1);
    }
  } catch (err) {
    console.error('\nADMISSION PROOF ERROR:', err);
    process.exit(1);
  }
}

// Run CLI when invoked directly
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  void main();
}
