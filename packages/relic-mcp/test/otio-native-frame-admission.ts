/**
 * OTIO Native Video Frame Admission Proof
 *
 * Verifies continuous native HTML <video> decoding with certified frame approval
 * by measuring actual drawn pixels inside headless Chromium.
 *
 * Requirements:
 * 1. WebCodecs/VideoDecoder/AudioDecoder TRAPPED (native HTML video ONLY).
 * 2. Compares drawn pixels under certified draw method:
 *    inside_rvfc: ctx.drawImage called directly inside requestVideoFrameCallback.
 * 3. Compares actual pixels against independent ffmpeg decoder reference frames
 *    and decoded burned-in stripe frame indices.
 * 4. 100% exact match rate required for an approved draw method on certified windows.
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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type {
  OtioVideoTiming,
  OtioVideoTimingReason,
} from '../../relic-viewer/src/otio-video-timing.ts';
import { type CdpConnection, connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';
import { isOpaqueBlack } from './otio-path-pixels.ts';

/* ==========================================================================
 * Types & Interfaces
 * ========================================================================== */

export type DrawMethod = 'inside_rvfc' | 'vf_rvfc';

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
  readonly cpu4x?: boolean;
  readonly cpuThrottlingRate?: number;
  readonly twoElements?: boolean;
  readonly negativeControls?: boolean;
  readonly delayRvfcMs?: number;
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
  readonly presentedFrames?: number;
  readonly expectedDisplayTime?: number;
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
  | 'uncovered_in_span'
  | 'fallback_required'
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
  readonly presentedFrames?: number;
  readonly expectedFrame: number;
  readonly closestFrame: number;
  readonly lagDelta: number | null;
  readonly timeDeltaUs: number | null;
  readonly rmseExpected: number;
  readonly rmseClosest: number;
  readonly rmseSecondClosest: number;
  readonly distinctionMargin: number;
  readonly burnedInFrame: number | null;
  readonly isMatch: boolean;
  readonly rejectionReason: RejectionReason;
  readonly isCertified: boolean;
  readonly isFallbackRequired: boolean;
  readonly isPredictedFallback?: boolean;
}

export interface MethodEvaluationResult {
  readonly drawMethod: DrawMethod;
  readonly sampleCount: number;
  readonly certifiedSampleCount: number;
  readonly distinctFramesCount: number;
  readonly matchCount: number;
  readonly mismatchCount: number;
  readonly wrongFrameCount: number;
  readonly uncoveredInSpanCount: number;
  readonly fallbackRequiredCount: number;
  readonly unpredictedFallbackCount: number;
  readonly captureFailedCount: number;
  readonly matchRate: number;
  readonly errorRatio: number;
  readonly rmseP50: number | null;
  readonly rmseP95: number | null;
  readonly rmseMax: number | null;
  readonly distinctionMarginP50: number | null;
  readonly deltaMinUs: number | null;
  readonly deltaMaxUs: number | null;
  readonly maxAbsDeltaUs: number | null;
  readonly deltaP50Us: number | null;
  readonly deltaP95Us: number | null;
  readonly deltaDistribution?: Record<string, number>;
  readonly lagDistribution: Record<string, number>;
  readonly rejectionReasons: Record<string, number>;
  readonly approved: boolean;
  readonly failedCondition?: string;
  readonly failureReason?: string;
}

export type CaseOutcome =
  | 'pass'
  | 'native_mismatch'
  | 'ineligible'
  | 'oracle_invalid'
  | 'probe_error';

export interface CaseAdmissionResult {
  readonly caseName: string;
  readonly filePath: string;
  readonly outcome: CaseOutcome;
  readonly totalOracleFrames: number;
  readonly oracleDistinctionMinRmse: number;
  readonly oracleAmbiguous: boolean;
  readonly eligible: boolean;
  readonly ineligibilityReason?: string;
  readonly failureReason?: string;
  readonly methods: Record<DrawMethod, MethodEvaluationResult>;
  readonly approved: boolean;
  readonly metadataDisagreementCount?: number;
  readonly metadataDisagreementRate?: number;
}

export type NegativeControlCounter =
  | 'wrongFrame'
  | 'uncoveredInSpan'
  | 'captureFailed'
  | 'oracleAmbiguous'
  | 'unpredictedFallback'
  | 'probeError';

export interface NegativeControlResult {
  readonly name: string;
  readonly intendedCounter: NegativeControlCounter;
  readonly observedCounter: string;
  readonly rejectionReason: RejectionReason | string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface TwoElementResult {
  readonly name: string;
  readonly element1: {
    readonly caseName: string;
    readonly offsetSeconds: number;
    readonly sampleCount: number;
    readonly matchRate: number;
    readonly approved: boolean;
  };
  readonly element2: {
    readonly caseName: string;
    readonly offsetSeconds: number;
    readonly sampleCount: number;
    readonly matchRate: number;
    readonly approved: boolean;
  };
  readonly passed: boolean;
  readonly failureReason?: string;
}

export interface AdmissionReport {
  readonly schemaVersion: 'relic-otio-native-frame-admission/v1';
  readonly timestamp: string;
  readonly chromePath: string;
  readonly browserProduct: string;
  readonly cpuThrottlingRate: number;
  readonly delayRvfcMs?: number;
  readonly minSamplesRequired: number;
  readonly casesTotal: number;
  readonly casesPassed: number;
  readonly casesEligible?: number;
  readonly methodApproval: {
    readonly inside_rvfc: boolean;
    readonly vf_rvfc: boolean;
  };
  readonly certifiedDrawMethod: 'inside_rvfc' | 'vf_rvfc' | 'none';
  readonly cases: readonly CaseAdmissionResult[];
  readonly negativeControls?: readonly NegativeControlResult[];
  readonly twoElementCoverage?: readonly TwoElementResult[];
  readonly metadataDisagreementByClass?: Record<
    string,
    {
      readonly sampleCount: number;
      readonly disagreementCount: number;
      readonly disagreementRate: number;
    }
  >;
}

/* ==========================================================================
 * Mathematical & Pixel Utilities
 * ========================================================================== */

export function isZeroAlpha(rgba: Uint8Array): boolean {
  if (rgba.length === 0 || rgba.length % 4 !== 0) return true;
  for (let i = 3; i < rgba.length; i += 4) {
    if ((rgba[i] ?? 0) !== 0) {
      return false;
    }
  }
  return true;
}

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
  const fileBase = basename(filePath);

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
    `ffmpeg reference extraction failed for ${fileBase}: ${batchRes.stderr}`
  );

  assert.equal(
    batchRes.stdout.length % bytesPerFrame,
    0,
    `ffmpeg output size ${batchRes.stdout.length} is not a multiple of bytesPerFrame ${bytesPerFrame} for ${fileBase}`
  );

  const decodedCount = batchRes.stdout.length / bytesPerFrame;
  assert.equal(
    decodedCount,
    expectedCount,
    `ffmpeg decoded frame count ${decodedCount} != expectedCount ${expectedCount} for ${fileBase}`
  );

  for (let f = 0; f < decodedCount; f++) {
    frames.set(
      f,
      batchRes.stdout.subarray(f * bytesPerFrame, (f + 1) * bytesPerFrame)
    );
  }

  assert.ok(frames.size > 0, `No reference frames extracted for ${fileBase}`);
  return frames;
}

export function checkOracleDistinction(
  refFrames: ReadonlyMap<number, Uint8Array>,
  _label: string
): {
  readonly ambiguous: boolean;
  readonly minDelta: number;
} {
  let minDelta = Infinity;

  const sortedFrames = [...refFrames.keys()].sort((a, b) => a - b);
  for (let i = 0; i < sortedFrames.length - 1; i++) {
    const fA = sortedFrames[i]!;
    const fB = sortedFrames[i + 1]!;
    const bufA = refFrames.get(fA)!;
    const bufB = refFrames.get(fB)!;
    const d = rmse(bufA, bufB);
    if (d < minDelta) {
      minDelta = d;
    }
  }

  return {
    ambiguous: minDelta <= 4.0,
    minDelta: Number.isFinite(minDelta) ? minDelta : 0,
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

/**
 * Validates timing window geometrical eligibility.
 * Rejects windows with zero count, start distances within 2Q, or lengths within 2Q.
 * No hardcoded filenames; fully data-driven.
 */
export function checkCaseEligibility(
  windows: readonly PacketWindow[],
  q = API_ROUNDING_Q
): { readonly eligible: boolean; readonly reason?: string } {
  if (windows.length === 0) {
    return { eligible: false, reason: 'no-certified-windows' };
  }
  for (const w of windows) {
    if (w.end - w.start <= 2 * q) {
      return { eligible: false, reason: 'window-length-within-2q' };
    }
  }
  for (let i = 0; i < windows.length - 1; i++) {
    if (windows[i + 1]!.start - windows[i]!.start <= 2 * q) {
      return { eligible: false, reason: 'starts-within-2q' };
    }
  }
  return { eligible: true };
}

/**
 * Runs scanOtioVideoTiming in a fresh Bun child process for total process and demuxer isolation.
 */
export async function scanFixtureTimingInFreshProcess(
  filePath: string,
  mimeType: string
): Promise<OtioVideoTiming> {
  const scannerPath = fileURLToPath(
    new URL(
      '../../relic-viewer/src/otio-video-timing-scanner.ts',
      import.meta.url
    )
  );

  const script = `
import { readFile } from 'node:fs/promises';
import { scanOtioVideoTiming } from ${JSON.stringify(scannerPath)};

const filePath = ${JSON.stringify(filePath)};
const mimeType = ${JSON.stringify(mimeType)};

const buffer = await readFile(filePath);
const blob = new Blob([buffer]);
const timing = await scanOtioVideoTiming(blob, mimeType);
if (timing.kind === 'windows') {
  process.stdout.write(JSON.stringify({
    kind: 'windows',
    starts: Array.from(timing.starts),
    ends: Array.from(timing.ends),
  }));
} else {
  process.stdout.write(JSON.stringify(timing));
}
`;

  const res = await runChild(['bun', '-e', script], {
    timeoutMs: 30000,
  });

  if (res.exit !== 0) {
    throw new Error(
      `Timing scanner process failed for ${basename(filePath)} (exit ${res.exit}): ${res.stderr}`
    );
  }

  const parsed = JSON.parse(new TextDecoder().decode(res.stdout)) as {
    readonly kind: 'windows' | 'unknown';
    readonly starts?: readonly number[];
    readonly ends?: readonly number[];
    readonly reason?: string;
  };

  if (parsed.kind === 'windows' && parsed.starts && parsed.ends) {
    return {
      kind: 'windows',
      starts: new Float64Array(parsed.starts),
      ends: new Float64Array(parsed.ends),
    };
  }

  return {
    kind: 'unknown',
    reason: (parsed.reason as OtioVideoTimingReason) ?? 'demux-warning',
  };
}

/**
 * Builds harness packet windows strictly from the product scanner timing output,
 * matching each start to an ffprobe packet best_effort_timestamp to obtain frame pixel identity.
 * Rejects with oracle_invalid if the oracle cannot supply exact identity for every certified window.
 */
export function buildHarnessWindowsFromScanner(
  scannerTiming: { readonly starts: Float64Array; readonly ends: Float64Array },
  fileEntry: FfprobeFileEntry,
  fileName: string
): {
  readonly windows: readonly PacketWindow[];
  readonly oracleValid: boolean;
  readonly reason?: string;
  readonly uncertifiedFrames?: ReadonlySet<number>;
} {
  const timeBase = ffprobeTimeBase(fileEntry.stream?.time_base, fileName);
  const frames = (fileEntry.frames ?? [])
    .map((f) => f.best_effort_timestamp)
    .filter((tick): tick is number => Number.isSafeInteger(tick))
    .sort((a, b) => a - b);

  if (frames.length === 0) {
    return {
      windows: [],
      oracleValid: false,
      reason: `ffprobe has no frames with best_effort_timestamp in ${fileName}`,
    };
  }

  const frameByTick = new Map<number, number>();
  for (const [index, tick] of frames.entries()) {
    if (!frameByTick.has(tick)) {
      frameByTick.set(tick, index);
    }
  }

  const rawPackets = fileEntry.packets ?? [];
  const packets = rawPackets
    .filter((p): p is { readonly pts: number; readonly duration?: number } =>
      Number.isSafeInteger(p.pts)
    )
    .sort((a, b) => a.pts - b.pts);

  if (packets.length === 0) {
    return {
      windows: [],
      oracleValid: false,
      reason: `ffprobe has no packets in ${fileName}`,
    };
  }

  const windows: PacketWindow[] = [];
  for (let i = 0; i < scannerTiming.starts.length; i++) {
    const start = scannerTiming.starts[i]!;
    const end = scannerTiming.ends[i]!;

    let matchedPacket: { readonly pts: number } | undefined;
    let minDelta = Infinity;
    for (const p of packets) {
      const pSec = p.pts * timeBase;
      const d = Math.abs(pSec - start);
      if (d < minDelta) {
        minDelta = d;
        matchedPacket = p;
      }
    }

    if (!matchedPacket || minDelta > 1e-4) {
      return {
        windows: [],
        oracleValid: false,
        reason: `Scanner window ${i} start ${start}s does not match any ffprobe packet in ${fileName} (min delta ${minDelta}s)`,
      };
    }

    const frame = frameByTick.get(matchedPacket.pts);
    if (frame === undefined) {
      return {
        windows: [],
        oracleValid: false,
        reason: `Packet pts ${matchedPacket.pts} has no corresponding frame index in ${fileName}`,
      };
    }

    windows.push({ start, end, frame });
  }

  const certifiedFrames = new Set(windows.map((w) => w.frame));
  const allFrameIndices = Array.from({ length: frames.length }, (_, i) => i);
  const uncertified = allFrameIndices.filter((f) => !certifiedFrames.has(f));

  if (uncertified.length > 0) {
    const isHead =
      uncertified[0] === 0 && uncertified.every((f, idx) => f === idx);
    const isTail =
      uncertified[uncertified.length - 1] === frames.length - 1 &&
      uncertified.every(
        (f, idx) => f === frames.length - uncertified.length + idx
      );

    if (!isHead && !isTail) {
      return {
        windows: [],
        oracleValid: false,
        reason: `Uncertified frames in ${fileName} do not form a contiguous tail or head: [${uncertified.join(', ')}]`,
      };
    }
  }

  return {
    windows,
    oracleValid: true,
    uncertifiedFrames: new Set(uncertified),
  };
}

/**
 * Validates real paused-seek oracle: captures each window midpoint in the browser page
 * and validates that every window matches its expected frame with unique frames.
 */
export async function validateRealPausedSeekOracle(
  cdp: CdpConnection,
  sessionId: string,
  mediaUrl: string,
  windows: readonly PacketWindow[],
  refFrames: ReadonlyMap<number, Uint8Array>,
  uncertifiedFrames?: ReadonlySet<number>
): Promise<{ readonly valid: boolean; readonly reason?: string }> {
  if (windows.length === 0) {
    return { valid: false, reason: 'No certified windows' };
  }
  const targets = windows.map((w) => (w.start + w.end) / 2);
  let capturedSamples: readonly BrowserFrameSample[];
  try {
    capturedSamples = await evaluateInPage<readonly BrowserFrameSample[]>(
      cdp,
      sessionId,
      `window.capturePausedFrames(${JSON.stringify(mediaUrl)}, ${JSON.stringify(targets)})`
    );
  } catch (err) {
    return {
      valid: false,
      reason: `Failed to capture paused frames: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (capturedSamples.length !== windows.length) {
    return {
      valid: false,
      reason: `Captured ${capturedSamples.length} paused frames but expected ${windows.length}`,
    };
  }

  const seenFrames = new Set<number>();
  for (let k = 0; k < windows.length; k++) {
    const w = windows[k]!;
    const s = capturedSamples[k]!;
    const ev = evaluateFrameSample(
      {
        ...s,
        mediaTime: w.start,
      },
      k,
      windows,
      refFrames,
      API_ROUNDING_Q,
      uncertifiedFrames
    );
    if (!ev.isMatch || ev.closestFrame !== w.frame) {
      return {
        valid: false,
        reason: `Window ${k} (target mid=${targets[k]?.toFixed(4)}s, expected frame=${w.frame}) failed paused-seek oracle match: closestFrame=${ev.closestFrame}, rejection=${ev.rejectionReason}`,
      };
    }

    if (seenFrames.has(ev.closestFrame)) {
      return {
        valid: false,
        reason: `Window ${k} (frame ${w.frame}) duplicate frame already seen in paused-seek oracle`,
      };
    }
    seenFrames.add(ev.closestFrame);
  }

  return { valid: true };
}

export function windowForSeconds(
  windows: readonly PacketWindow[],
  seconds: number,
  q = API_ROUNDING_Q
): PacketWindow | null {
  if (windows.length === 0) return null;

  let low = 0;
  let high = windows.length - 1;
  let bestIdx = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (windows[mid]!.start <= seconds + q) {
      bestIdx = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (bestIdx === -1) {
    return null;
  }

  const matching: PacketWindow[] = [];
  for (let i = bestIdx; i >= 0 && windows[i]!.start >= seconds - q; i--) {
    if (Math.abs(windows[i]!.start - seconds) <= q) {
      matching.push(windows[i]!);
    }
  }

  if (matching.length > 1) {
    return null;
  }

  if (matching.length === 1) {
    return matching[0] ?? null;
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

  const probeRes = await runChild(
    [
      'ffprobe',
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,time_base,r_frame_rate,avg_frame_rate,width,height,nb_frames,duration:packet=pts,dts,duration,pts_time,dts_time,duration_time:frame=best_effort_timestamp,best_effort_timestamp_time,pkt_dts,pkt_dts_time,pict_type,coded_picture_number',
      '-of',
      'json',
      filePath,
    ],
    { timeoutMs: 30000 }
  );
  assert.equal(
    probeRes.exit,
    0,
    `ffprobe failed on generated 1080p long GOP fixture: ${probeRes.stderr}`
  );

  const probeData = JSON.parse(new TextDecoder().decode(probeRes.stdout)) as {
    readonly streams?: readonly FfprobeStream[];
    readonly frames?: readonly FfprobeFrame[];
    readonly packets?: readonly FfprobePacket[];
    readonly packets_and_frames?: ReadonlyArray<
      { readonly type?: string } & FfprobeFrame & FfprobePacket
    >;
  };

  assert.ok(
    probeData.streams && probeData.streams.length > 0,
    'Generated 1080p long GOP fixture has no video stream'
  );
  const stream = probeData.streams[0]!;
  const rawItems = probeData.packets_and_frames ?? [];
  const frames: readonly FfprobeFrame[] =
    probeData.frames ??
    rawItems.filter(
      (item): item is FfprobeFrame & { readonly type?: string } =>
        item.type === 'frame'
    );
  const packets: readonly FfprobePacket[] =
    probeData.packets ??
    rawItems.filter(
      (item): item is FfprobePacket & { readonly type?: string } =>
        item.type === 'packet'
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
    const body = bytes.slice().buffer as ArrayBuffer;
    return new Response(body, {
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

  const sliceBody = bytes.slice(start, end + 1).buffer as ArrayBuffer;
  return new Response(sliceBody, {
    status: 206,
    headers: {
      'content-type': mimeType,
      'content-length': String(end - start + 1),
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

function createHtmlTestPage(delayRvfcMs = 0): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>OTIO Native Frame Admission Probe</title>
  <style>
    body { background: black; margin: 0; padding: 0; overflow: hidden; }
    .otio-video-decoders { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); pointer-events: none; }
    #test-canvas { position: absolute; left: 0; top: 0; width: 64px; height: 16px; opacity: 1; }
    #test-canvas-vf { position: absolute; left: 0; top: 0; width: 64px; height: 16px; opacity: 1; }
    #test-canvas-2 { position: absolute; left: 0; top: 20px; width: 64px; height: 16px; opacity: 1; }
    #test-canvas-2-vf { position: absolute; left: 0; top: 20px; width: 64px; height: 16px; opacity: 1; }
  </style>
</head>
<body>
  <div class="otio-video-decoders" aria-hidden="true">
    <video id="test-video" muted playsinline></video>
    <video id="test-video-2" muted playsinline></video>
  </div>
  <canvas id="test-canvas" width="64" height="16"></canvas>
  <canvas id="test-canvas-vf" width="64" height="16"></canvas>
  <canvas id="test-canvas-2" width="64" height="16"></canvas>
  <canvas id="test-canvas-2-vf" width="64" height="16"></canvas>
  <script>
    if (${delayRvfcMs > 0 ? delayRvfcMs : 0} > 0) {
      const delayMs = ${delayRvfcMs > 0 ? delayRvfcMs : 0};
      const origRvfc = HTMLVideoElement.prototype.requestVideoFrameCallback;
      HTMLVideoElement.prototype.requestVideoFrameCallback = function(cb) {
        return origRvfc.call(this, (now, metadata) => {
          const start = performance.now();
          while (performance.now() - start < delayMs) {}
          cb(now, metadata);
        });
      };
    }

    function readPixels(source, ctx, canvas) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let binary = '';
      for (let i = 0; i < d.length; i++) binary += String.fromCharCode(d[i]);
      return btoa(binary);
    }

    window.capturePausedFrames = function(mediaUrl, targets) {
      return new Promise((resolve, reject) => {
        const video = document.getElementById('test-video');
        const canvas = document.getElementById('test-canvas');
        if (!video || !canvas) return reject(new Error('Missing video or canvas element'));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return reject(new Error('Canvas 2D context is null'));

        video.pause();
        canvas.width = 64;
        canvas.height = 16;
        let finished = false;
        let timeoutTimer = setTimeout(() => {
          if (finished) return;
          finished = true;
          cleanup();
          reject(new Error('Timeout during capturePausedFrames for ' + mediaUrl));
        }, 60000);

        function cleanup() {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          video.onloadeddata = null;
          video.onerror = null;
        }

        video.onerror = () => {
          if (finished) return;
          finished = true;
          cleanup();
          reject(new Error('HTML Video error: ' + (video.error ? video.error.message : 'unknown')));
        };

        async function startCapturing() {
          if (finished) return;
          try {
            const samples = [];
            for (let i = 0; i < targets.length; i++) {
              if (finished) return;
              const target = targets[i];
              await seekOne(target);
              let pixels = readPixels(video, ctx, canvas);
              let sampleTime = video.currentTime;
              if (i > 0 && samples[i - 1] && samples[i - 1].pixelsBase64 === pixels) {
                await new Promise((res) => {
                  let timer = setTimeout(() => { video.pause(); res(); }, 500);
                  video.requestVideoFrameCallback((now, meta) => {
                    clearTimeout(timer);
                    video.pause();
                    sampleTime = meta.mediaTime;
                    pixels = readPixels(video, ctx, canvas);
                    res();
                  });
                  video.play().catch(() => { clearTimeout(timer); res(); });
                });
              }
              samples.push({
                mediaTime: sampleTime,
                width: canvas.width,
                height: canvas.height,
                pixelsBase64: pixels,
              });
            }
            finished = true;
            cleanup();
            resolve(samples);
          } catch (err) {
            if (finished) return;
            finished = true;
            cleanup();
            reject(err);
          }
        }

        function seekOne(target) {
          return new Promise((res, rej) => {
            let settled = false;
            let seekTimer = setTimeout(() => finish(false, new Error('Seek timeout for target ' + target)), 10000);
            const finish = (ok, err) => {
              if (settled) return;
              settled = true;
              if (seekTimer) clearTimeout(seekTimer);
              video.removeEventListener('seeked', onSeeked);
              video.removeEventListener('error', onErr);
              if (ok) res(true);
              else rej(err || new Error('Seek failed'));
            };
            const onSeeked = () => {
              if (video.readyState >= 2) finish(true);
            };
            const onErr = () => finish(false, new Error('Video error during seek'));
            video.addEventListener('seeked', onSeeked);
            video.addEventListener('error', onErr);
            try {
              video.currentTime = target;
            } catch (e) {
              finish(false, e);
            }
          });
        }

        video.muted = true;
        video.onloadeddata = () => { void startCapturing(); };
        video.src = mediaUrl;
        video.load();
      });
    };

    window.runAdmissionProbe = function(mediaUrl, minSamples) {
      return new Promise((resolve, reject) => {
        const video = document.getElementById('test-video');
        if (!video) return reject(new Error('HTML Video element not found'));
        if (typeof video.requestVideoFrameCallback !== 'function') {
          return reject(new Error('requestVideoFrameCallback is not supported on HTMLVideoElement'));
        }
        if (typeof VideoFrame !== 'function') {
          return reject(new Error('VideoFrame is not supported in this environment'));
        }
        const canvas = document.getElementById('test-canvas');
        const canvasVf = document.getElementById('test-canvas-vf');
        if (!canvas || !canvasVf) return reject(new Error('HTML Canvas element not found'));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const ctxVf = canvasVf.getContext('2d', { willReadFrequently: true });
        if (!ctx || !ctxVf) return reject(new Error('Canvas 2D context is null'));

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
        canvasVf.addEventListener('contextlost', onContextLost);

        video.pause();
        video.removeAttribute('src');
        video.load();
        canvas.width = 64;
        canvas.height = 16;
        canvasVf.width = 64;
        canvasVf.height = 16;
        const insideSamples = [];
        const vfSamples = [];

        function cleanup() {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          canvas.removeEventListener('contextlost', onContextLost);
          canvasVf.removeEventListener('contextlost', onContextLost);
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
          if (vfSamples.length > 0) {
            resolve({
              inside_rvfc: insideSamples,
              vf_rvfc: vfSamples,
              samples: vfSamples,
              completed: false,
              timedOut: true,
            });
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
              if (
                (ctx.isContextLost && ctx.isContextLost()) ||
                (ctxVf.isContextLost && ctxVf.isContextLost())
              ) {
                finished = true;
                cleanup();
                reject(new Error('Canvas 2D context is lost during onFrame'));
                return;
              }
              try {
                insideSamples.push({
                  mediaTime: metadata.mediaTime,
                  presentedFrames: metadata.presentedFrames,
                  expectedDisplayTime: metadata.expectedDisplayTime,
                  width: canvas.width,
                  height: canvas.height,
                  sourceWidth: metadata.width,
                  sourceHeight: metadata.height,
                  capturedWidth: canvas.width,
                  capturedHeight: canvas.height,
                  pixelsBase64: readPixels(video, ctx, canvas),
                });

                let vf = null;
                try {
                  vf = new VideoFrame(video);
                  const vfMediaTime = vf.timestamp / 1e6;
                  vfSamples.push({
                    mediaTime: vfMediaTime,
                    presentedFrames: metadata.presentedFrames,
                    expectedDisplayTime: metadata.expectedDisplayTime,
                    width: canvasVf.width,
                    height: canvasVf.height,
                    sourceWidth: vf.displayWidth || metadata.width,
                    sourceHeight: vf.displayHeight || metadata.height,
                    capturedWidth: canvasVf.width,
                    capturedHeight: canvasVf.height,
                    pixelsBase64: readPixels(vf, ctxVf, canvasVf),
                  });
                } catch (vfErr) {
                  vfSamples.push({
                    mediaTime: metadata.mediaTime,
                    presentedFrames: metadata.presentedFrames,
                    expectedDisplayTime: metadata.expectedDisplayTime,
                    width: canvasVf.width,
                    height: canvasVf.height,
                    pixelsBase64: '',
                  });
                } finally {
                  vf?.close();
                }
              } catch (err) {
                finished = true;
                cleanup();
                reject(err);
                return;
              }
              if (vfSamples.length >= minSamples) {
                finished = true;
                cleanup();
                resolve({
                  inside_rvfc: insideSamples,
                  vf_rvfc: vfSamples,
                  samples: vfSamples,
                  completed: true,
                  timedOut: false,
                });
                return;
              }
              rVfcId = video.requestVideoFrameCallback(onFrame);
            }

            video.onended = () => {
              if (vfSamples.length < minSamples && !finished) {
                video.currentTime = 0;
                video.play().catch(reject);
              } else if (!finished) {
                finished = true;
                cleanup();
                resolve({
                  inside_rvfc: insideSamples,
                  vf_rvfc: vfSamples,
                  samples: vfSamples,
                  completed: true,
                  timedOut: false,
                });
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

    window.runTwoElementAdmissionProbe = function(mediaUrl1, mediaUrl2, offset1, offset2, minSamples) {
      return new Promise((resolve, reject) => {
        const video1 = document.getElementById('test-video');
        const video2 = document.getElementById('test-video-2');
        const canvas1 = document.getElementById('test-canvas');
        const canvas2 = document.getElementById('test-canvas-2');
        if (!video1 || !video2 || !canvas1 || !canvas2) {
          return reject(new Error('Missing elements for two-element probe'));
        }
        const ctx1 = canvas1.getContext('2d', { willReadFrequently: true });
        const ctx2 = canvas2.getContext('2d', { willReadFrequently: true });
        if (!ctx1 || !ctx2) {
          return reject(new Error('Canvas 2D context is null in two-element probe'));
        }

        let finished = false;
        let rVfc1 = null;
        let rVfc2 = null;
        let timer = null;
        const samples1 = [];
        const samples2 = [];

        function cleanup() {
          if (timer) clearTimeout(timer);
          if (rVfc1 !== null && typeof video1.cancelVideoFrameCallback === 'function') {
            video1.cancelVideoFrameCallback(rVfc1);
            rVfc1 = null;
          }
          if (rVfc2 !== null && typeof video2.cancelVideoFrameCallback === 'function') {
            video2.cancelVideoFrameCallback(rVfc2);
            rVfc2 = null;
          }
          video1.pause();
          video2.pause();
        }

        timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          cleanup();
          resolve({ samples1, samples2, completed: false, timedOut: true });
        }, 60000);

        function checkDone() {
          if (samples1.length >= minSamples && samples2.length >= minSamples && !finished) {
            finished = true;
            cleanup();
            resolve({ samples1, samples2, completed: true, timedOut: false });
          }
        }

        function onFrame1(now, metadata) {
          if (finished) return;
          let vf = null;
          try {
            vf = new VideoFrame(video1);
            samples1.push({
              mediaTime: vf.timestamp / 1e6,
              presentedFrames: metadata.presentedFrames,
              expectedDisplayTime: metadata.expectedDisplayTime,
              width: canvas1.width,
              height: canvas1.height,
              pixelsBase64: readPixels(vf, ctx1, canvas1),
            });
          } catch (e) {
            samples1.push({
              mediaTime: metadata.mediaTime,
              presentedFrames: metadata.presentedFrames,
              expectedDisplayTime: metadata.expectedDisplayTime,
              width: canvas1.width,
              height: canvas1.height,
              pixelsBase64: '',
            });
          } finally {
            vf?.close();
          }
          if (samples1.length < minSamples) {
            rVfc1 = video1.requestVideoFrameCallback(onFrame1);
          }
          checkDone();
        }

        function onFrame2(now, metadata) {
          if (finished) return;
          let vf = null;
          try {
            vf = new VideoFrame(video2);
            samples2.push({
              mediaTime: vf.timestamp / 1e6,
              presentedFrames: metadata.presentedFrames,
              expectedDisplayTime: metadata.expectedDisplayTime,
              width: canvas2.width,
              height: canvas2.height,
              pixelsBase64: readPixels(vf, ctx2, canvas2),
            });
          } catch (e) {
            samples2.push({
              mediaTime: metadata.mediaTime,
              presentedFrames: metadata.presentedFrames,
              expectedDisplayTime: metadata.expectedDisplayTime,
              width: canvas2.width,
              height: canvas2.height,
              pixelsBase64: '',
            });
          } finally {
            vf?.close();
          }
          if (samples2.length < minSamples) {
            rVfc2 = video2.requestVideoFrameCallback(onFrame2);
          }
          checkDone();
        }

        video1.loop = true;
        video1.muted = true;
        video2.loop = true;
        video2.muted = true;

        video1.onloadedmetadata = () => { if (offset1 > 0) video1.currentTime = offset1; };
        video2.onloadedmetadata = () => { if (offset2 > 0) video2.currentTime = offset2; };

        video1.onloadeddata = async () => {
          rVfc1 = video1.requestVideoFrameCallback(onFrame1);
          await video1.play().catch(reject);
        };
        video2.onloadeddata = async () => {
          rVfc2 = video2.requestVideoFrameCallback(onFrame2);
          await video2.play().catch(reject);
        };

        video1.src = mediaUrl1;
        video2.src = mediaUrl2;
        video1.load();
        video2.load();
      });
    };
  </script>
</body>
</html>`;
}

export async function startLoopbackServer(
  fixturesDir: string,
  tempDir: string,
  delayRvfcMs = 0
): Promise<{ readonly origin: string; readonly close: () => Promise<void> }> {
  const htmlPage = createHtmlTestPage(delayRvfcMs);
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
  refFrames: ReadonlyMap<number, Uint8Array>,
  q = API_ROUNDING_Q,
  uncertifiedFrames?: ReadonlySet<number>
): SampleEvaluation {
  if (windows.length === 0) {
    throw new Error('windows cannot be empty in evaluateFrameSample');
  }

  const binaryStr = atob(sample.pixelsBase64);
  const captured = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    captured[i] = binaryStr.charCodeAt(i);
  }

  const capWidth = sample.capturedWidth ?? sample.width ?? 64;
  const capHeight = sample.capturedHeight ?? sample.height ?? 16;

  // 1. Capture failures: unreadable, zero alpha, or opaque black
  if (captured.length === 0 || captured.length % 4 !== 0) {
    return {
      sampleIndex,
      mediaTime: sample.mediaTime,
      ...(sample.presentedFrames !== undefined
        ? { presentedFrames: sample.presentedFrames }
        : {}),
      expectedFrame: -1,
      closestFrame: -1,
      lagDelta: null,
      timeDeltaUs: null,
      rmseExpected: Infinity,
      rmseClosest: Infinity,
      rmseSecondClosest: Infinity,
      distinctionMargin: 0,
      burnedInFrame: null,
      isMatch: false,
      rejectionReason: 'unreadable',
      isCertified: false,
      isFallbackRequired: false,
    };
  }

  if (isZeroAlpha(captured)) {
    return {
      sampleIndex,
      mediaTime: sample.mediaTime,
      ...(sample.presentedFrames !== undefined
        ? { presentedFrames: sample.presentedFrames }
        : {}),
      expectedFrame: -1,
      closestFrame: -1,
      lagDelta: null,
      timeDeltaUs: null,
      rmseExpected: Infinity,
      rmseClosest: Infinity,
      rmseSecondClosest: Infinity,
      distinctionMargin: 0,
      burnedInFrame: null,
      isMatch: false,
      rejectionReason: 'zero_alpha',
      isCertified: false,
      isFallbackRequired: false,
    };
  }

  if (isOpaqueBlack(captured)) {
    return {
      sampleIndex,
      mediaTime: sample.mediaTime,
      ...(sample.presentedFrames !== undefined
        ? { presentedFrames: sample.presentedFrames }
        : {}),
      expectedFrame: -1,
      closestFrame: -1,
      lagDelta: null,
      timeDeltaUs: null,
      rmseExpected: Infinity,
      rmseClosest: Infinity,
      rmseSecondClosest: Infinity,
      distinctionMargin: 0,
      burnedInFrame: null,
      isMatch: false,
      rejectionReason: 'opaque_black',
      isCertified: false,
      isFallbackRequired: false,
    };
  }

  // 2. Check certified span: [spanStart - q, spanEnd - q)
  const spanStart = windows[0]!.start;
  const spanEnd = windows[windows.length - 1]!.end;
  const isInsideSpan =
    sample.mediaTime >= spanStart - q && sample.mediaTime < spanEnd - q;

  if (!isInsideSpan) {
    const burnedIn = decodeBurnedInFrameIndex(captured, capWidth, capHeight);
    const { closestFrame, closestRmse, secondClosestRmse } =
      findClosestReferenceFrame(captured, refFrames);
    const isPredictedFallback = uncertifiedFrames
      ? uncertifiedFrames.has(closestFrame)
      : false;
    return {
      sampleIndex,
      mediaTime: sample.mediaTime,
      ...(sample.presentedFrames !== undefined
        ? { presentedFrames: sample.presentedFrames }
        : {}),
      expectedFrame: -1,
      closestFrame,
      lagDelta: null,
      timeDeltaUs: null,
      rmseExpected: Infinity,
      rmseClosest: closestRmse,
      rmseSecondClosest: secondClosestRmse,
      distinctionMargin: 0,
      burnedInFrame: burnedIn,
      isMatch: false,
      rejectionReason: 'fallback_required',
      isCertified: false,
      isFallbackRequired: true,
      ...(isPredictedFallback !== undefined ? { isPredictedFallback } : {}),
    };
  }

  // 3. Inside certified span: search for matching packet window start within q
  const expectedWin = windowForSeconds(windows, sample.mediaTime, q);
  const burnedIn = decodeBurnedInFrameIndex(captured, capWidth, capHeight);

  if (!expectedWin) {
    return {
      sampleIndex,
      mediaTime: sample.mediaTime,
      ...(sample.presentedFrames !== undefined
        ? { presentedFrames: sample.presentedFrames }
        : {}),
      expectedFrame: -1,
      closestFrame: -1,
      lagDelta: null,
      timeDeltaUs: null,
      rmseExpected: Infinity,
      rmseClosest: Infinity,
      rmseSecondClosest: Infinity,
      distinctionMargin: 0,
      burnedInFrame: burnedIn,
      isMatch: false,
      rejectionReason: 'uncovered_in_span',
      isCertified: false,
      isFallbackRequired: false,
    };
  }

  // 4. Certified sample: compute delta and check frame identity
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
  let isCertified = true;
  let rejectionReason: RejectionReason = 'none';

  // Exact unrounded timing check: |Δ| <= 1.0 µs
  if (Math.abs(timeDeltaUs) > 1.0) {
    isMatch = false;
    rejectionReason = 'ineligible_timing';
  } else if (closestFrame !== expectedFrame) {
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
    (burnedIn === null || burnedIn !== expectedBurned)
  ) {
    isMatch = false;
    if (burnedIn === null) {
      rejectionReason = 'unreadable';
      isCertified = false;
    } else {
      rejectionReason = 'burned_in_mismatch';
    }
  }

  return {
    sampleIndex,
    mediaTime: sample.mediaTime,
    ...(sample.presentedFrames !== undefined
      ? { presentedFrames: sample.presentedFrames }
      : {}),
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
    isCertified,
    isFallbackRequired: false,
  };
}

export function aggregateMethodResults(
  drawMethod: DrawMethod,
  evaluations: readonly SampleEvaluation[],
  minRequiredSamples: number,
  totalWindowsCount?: number
): MethodEvaluationResult {
  const sampleCount = evaluations.length;
  if (sampleCount === 0) {
    return {
      drawMethod,
      sampleCount: 0,
      certifiedSampleCount: 0,
      distinctFramesCount: 0,
      matchCount: 0,
      mismatchCount: 0,
      wrongFrameCount: 0,
      uncoveredInSpanCount: 0,
      fallbackRequiredCount: 0,
      unpredictedFallbackCount: 0,
      captureFailedCount: 0,
      matchRate: 0,
      errorRatio: 1,
      rmseP50: null,
      rmseP95: null,
      rmseMax: null,
      distinctionMarginP50: null,
      deltaMinUs: null,
      deltaMaxUs: null,
      maxAbsDeltaUs: null,
      deltaP50Us: null,
      deltaP95Us: null,
      deltaDistribution: {},
      lagDistribution: {},
      rejectionReasons: { empty: 1 },
      approved: false,
      failedCondition: 'no_samples_collected',
      failureReason: 'No frame samples were captured by the probe',
    };
  }

  const distinctFrames = new Set<number>();
  let matchCount = 0;
  let wrongFrameCount = 0;
  let uncoveredInSpanCount = 0;
  let fallbackRequiredCount = 0;
  let unpredictedFallbackCount = 0;
  let captureFailedCount = 0;
  let certifiedSampleCount = 0;

  const rmseValues: number[] = [];
  const margins: number[] = [];
  const certifiedDeltas: number[] = [];
  const certifiedLags: number[] = [];
  const deltaDistribution: Record<string, number> = {};
  const lagDistribution: Record<string, number> = {};
  const rejectionReasons: Record<string, number> = {};

  for (const ev of evaluations) {
    if (
      ev.rejectionReason === 'opaque_black' ||
      ev.rejectionReason === 'zero_alpha' ||
      ev.rejectionReason === 'unreadable'
    ) {
      captureFailedCount++;
      rejectionReasons[ev.rejectionReason] =
        (rejectionReasons[ev.rejectionReason] ?? 0) + 1;
    } else if (ev.isFallbackRequired) {
      fallbackRequiredCount++;
      if (!ev.isPredictedFallback) {
        unpredictedFallbackCount++;
        rejectionReasons['unpredicted_fallback'] =
          (rejectionReasons['unpredicted_fallback'] ?? 0) + 1;
      }
      rejectionReasons[ev.rejectionReason] =
        (rejectionReasons[ev.rejectionReason] ?? 0) + 1;
    } else if (ev.rejectionReason === 'uncovered_in_span') {
      uncoveredInSpanCount++;
      rejectionReasons[ev.rejectionReason] =
        (rejectionReasons[ev.rejectionReason] ?? 0) + 1;
    } else if (ev.isCertified) {
      certifiedSampleCount++;
      if (ev.closestFrame >= 0) {
        distinctFrames.add(ev.closestFrame);
      }
      if (ev.isMatch) {
        matchCount++;
      } else {
        wrongFrameCount++;
        rejectionReasons[ev.rejectionReason] =
          (rejectionReasons[ev.rejectionReason] ?? 0) + 1;
      }

      if (Number.isFinite(ev.rmseExpected)) {
        rmseValues.push(ev.rmseExpected);
      }
      if (Number.isFinite(ev.distinctionMargin)) {
        margins.push(ev.distinctionMargin);
      }

      if (ev.timeDeltaUs !== null && Number.isFinite(ev.timeDeltaUs)) {
        certifiedDeltas.push(ev.timeDeltaUs);
        const bucket = `${(Math.round(ev.timeDeltaUs * 10) / 10).toFixed(1)}us`;
        deltaDistribution[bucket] = (deltaDistribution[bucket] ?? 0) + 1;
      }

      if (ev.lagDelta !== null && Number.isFinite(ev.lagDelta)) {
        certifiedLags.push(ev.lagDelta);
        const lagKey = String(ev.lagDelta);
        lagDistribution[lagKey] = (lagDistribution[lagKey] ?? 0) + 1;
      }
    }
  }

  const mismatchCount =
    wrongFrameCount +
    uncoveredInSpanCount +
    captureFailedCount +
    unpredictedFallbackCount;

  const matchRate =
    certifiedSampleCount > 0 ? matchCount / certifiedSampleCount : 0;
  const errorRatio =
    certifiedSampleCount > 0 ? wrongFrameCount / certifiedSampleCount : 0;

  const deltaMinUs =
    certifiedDeltas.length > 0 ? Math.min(...certifiedDeltas) : null;
  const deltaMaxUs =
    certifiedDeltas.length > 0 ? Math.max(...certifiedDeltas) : null;
  const maxAbsDeltaUs =
    certifiedDeltas.length > 0
      ? Math.max(...certifiedDeltas.map((d) => Math.abs(d)))
      : null;
  const deltaP50Us =
    certifiedDeltas.length > 0 ? quantile(certifiedDeltas, 0.5) : null;
  const deltaP95Us =
    certifiedDeltas.length > 0 ? quantile(certifiedDeltas, 0.95) : null;

  const rmseP50 = rmseValues.length > 0 ? quantile(rmseValues, 0.5) : null;
  const rmseP95 = rmseValues.length > 0 ? quantile(rmseValues, 0.95) : null;
  const rmseMax = rmseValues.length > 0 ? Math.max(...rmseValues) : null;
  const distinctionMarginP50 =
    margins.length > 0 ? quantile(margins, 0.5) : null;

  const minCertifiedRequired =
    totalWindowsCount !== undefined
      ? Math.min(minRequiredSamples, totalWindowsCount)
      : minRequiredSamples;

  let approved = true;
  let failedCondition: string | undefined;
  let failureReason: string | undefined;

  if (wrongFrameCount > 0) {
    approved = false;
    failedCondition = 'wrong_frame';
    failureReason = `wrongFrame: ${wrongFrameCount} sample(s) had incorrect frame, excessive RMSE, or timing delta > 1us`;
  } else if (captureFailedCount > 0) {
    approved = false;
    failedCondition = 'capture_failed';
    failureReason = `captureFailed: ${captureFailedCount} sample(s) with black, zero alpha, or unreadable frame`;
  } else if (uncoveredInSpanCount > 0) {
    approved = false;
    failedCondition = 'uncovered_in_span';
    failureReason = `uncoveredInSpan: ${uncoveredInSpanCount} sample(s) inside certified span had no unique window start match`;
  } else if (certifiedSampleCount < minCertifiedRequired) {
    approved = false;
    failedCondition = 'insufficient_certified_samples';
    failureReason = `Certified samples ${certifiedSampleCount} < required ${minCertifiedRequired}`;
  } else if (unpredictedFallbackCount > 0) {
    approved = false;
    failedCondition = 'unpredicted_fallback';
    failureReason = `fallbackRequired: ${unpredictedFallbackCount} sample(s) outside predicted fallback set`;
  } else if (maxAbsDeltaUs !== null && maxAbsDeltaUs > 1.0) {
    approved = false;
    failedCondition = 'max_delta_exceeded';
    failureReason = `max |Δ| ${maxAbsDeltaUs.toFixed(3)}us > 1.0us required`;
  }

  return {
    drawMethod,
    sampleCount,
    certifiedSampleCount,
    distinctFramesCount: distinctFrames.size,
    matchCount,
    mismatchCount,
    wrongFrameCount,
    uncoveredInSpanCount,
    fallbackRequiredCount,
    unpredictedFallbackCount,
    captureFailedCount,
    matchRate,
    errorRatio,
    rmseP50,
    rmseP95,
    rmseMax,
    distinctionMarginP50,
    deltaMinUs,
    deltaMaxUs,
    maxAbsDeltaUs,
    deltaP50Us,
    deltaP95Us,
    ...(deltaDistribution && Object.keys(deltaDistribution).length > 0
      ? { deltaDistribution }
      : {}),
    lagDistribution,
    rejectionReasons,
    approved,
    ...(failedCondition !== undefined ? { failedCondition } : {}),
    ...(failureReason !== undefined ? { failureReason } : {}),
  };
}

/* ==========================================================================
 * Negative Controls Suite
 * ========================================================================== */

export async function runNegativeControls(
  referenceWindows: readonly PacketWindow[],
  refFrames: ReadonlyMap<number, Uint8Array>,
  uncertifiedFrames?: ReadonlySet<number>,
  stressOptions?: {
    readonly delayRvfcMs?: number | undefined;
    readonly caseResults?: readonly CaseAdmissionResult[] | undefined;
  }
): Promise<readonly NegativeControlResult[]> {
  const results: NegativeControlResult[] = [];
  if (referenceWindows.length < 2 || refFrames.size < 2) {
    throw new Error(
      'Negative controls require at least 2 certified windows and reference frames'
    );
  }

  const w0 = referenceWindows[0]!;
  const w1 = referenceWindows[1]!;
  const ref0 = refFrames.get(w0.frame)!;

  function makeSample(
    mediaTime: number,
    pixels: Uint8Array,
    presented = 1
  ): BrowserFrameSample {
    let binary = '';
    for (let i = 0; i < pixels.length; i++)
      binary += String.fromCharCode(pixels[i]!);
    return {
      mediaTime,
      presentedFrames: presented,
      expectedDisplayTime: 0,
      width: 64,
      height: 16,
      capturedWidth: 64,
      capturedHeight: 16,
      pixelsBase64: btoa(binary),
    };
  }

  // Control 1: Tag shifted by +1
  // Expected: wrongFrame counter (burned_in_mismatch)
  {
    const modifiedPixels = new Uint8Array(ref0);
    const targetTag = w0.frame + 1;
    const width = 64;
    const y = 8;
    for (let x = 0; x < 8; x++) {
      const idx = (y * width + x) * 4;
      modifiedPixels[idx] = 235;
      modifiedPixels[idx + 1] = 235;
      modifiedPixels[idx + 2] = 235;
      modifiedPixels[idx + 3] = 255;
    }
    for (let bit = 0; bit < 7; bit++) {
      const isOne = (targetTag & (1 << bit)) !== 0;
      const lum = isOne ? 235 : 16;
      for (let x = (bit + 1) * 8; x < (bit + 2) * 8; x++) {
        const idx = (y * width + x) * 4;
        modifiedPixels[idx] = lum;
        modifiedPixels[idx + 1] = lum;
        modifiedPixels[idx + 2] = lum;
        modifiedPixels[idx + 3] = 255;
      }
    }

    const sample = makeSample(w0.start, modifiedPixels);

    const ev = evaluateFrameSample(
      sample,
      0,
      referenceWindows,
      refFrames,
      API_ROUNDING_Q,
      uncertifiedFrames
    );
    const agg = aggregateMethodResults(
      'vf_rvfc',
      [ev],
      1,
      referenceWindows.length
    );
    const passed =
      (ev.rejectionReason === 'burned_in_mismatch' ||
        ev.rejectionReason === 'excessive_rmse') &&
      agg.wrongFrameCount === 1;
    results.push({
      name: 'tag_shift_plus_one',
      intendedCounter: 'wrongFrame',
      observedCounter: agg.wrongFrameCount === 1 ? 'wrongFrame' : 'none',
      rejectionReason: ev.rejectionReason,
      passed,
      detail: `Rejection: ${ev.rejectionReason}, wrongFrameCount: ${agg.wrongFrameCount}`,
    });
  }

  // Control 2: Stale pixels (held frame from prior window)
  // Expected: wrongFrame counter (lagged_frame)
  {
    const sample = makeSample(w1.start, ref0, 2);

    const ev = evaluateFrameSample(
      sample,
      0,
      referenceWindows,
      refFrames,
      API_ROUNDING_Q,
      uncertifiedFrames
    );
    const agg = aggregateMethodResults(
      'vf_rvfc',
      [ev],
      1,
      referenceWindows.length
    );
    const passed =
      (ev.rejectionReason === 'lagged_frame' ||
        ev.rejectionReason === 'burned_in_mismatch') &&
      agg.wrongFrameCount === 1;
    results.push({
      name: 'stale_pixels',
      intendedCounter: 'wrongFrame',
      observedCounter: agg.wrongFrameCount === 1 ? 'wrongFrame' : 'none',
      rejectionReason: ev.rejectionReason,
      passed,
      detail: `Rejection: ${ev.rejectionReason}, wrongFrameCount: ${agg.wrongFrameCount}, lagDelta: ${ev.lagDelta}`,
    });
  }

  // Control 3: Q + 1us delta shifted inside span
  // Expected: uncoveredInSpan counter (uncovered_in_span)
  {
    const sample = makeSample(w0.start + (API_ROUNDING_Q + 1e-6), ref0);

    const ev = evaluateFrameSample(
      sample,
      0,
      referenceWindows,
      refFrames,
      API_ROUNDING_Q,
      uncertifiedFrames
    );
    const agg = aggregateMethodResults(
      'vf_rvfc',
      [ev],
      1,
      referenceWindows.length
    );
    const passed =
      ev.rejectionReason === 'uncovered_in_span' &&
      agg.uncoveredInSpanCount === 1;
    results.push({
      name: 'q_plus_one_us_delta_uncovered',
      intendedCounter: 'uncoveredInSpan',
      observedCounter:
        agg.uncoveredInSpanCount === 1 ? 'uncoveredInSpan' : 'none',
      rejectionReason: ev.rejectionReason,
      passed,
      detail: `Rejection: ${ev.rejectionReason}, uncoveredInSpanCount: ${agg.uncoveredInSpanCount}`,
    });
  }

  // Control 3b: Delta within Q but > 1.0us (e.g. 1.5us)
  // Expected: wrongFrame counter (ineligible_timing)
  {
    const sample = makeSample(w0.start + 1.5e-6, ref0);

    const ev = evaluateFrameSample(
      sample,
      0,
      referenceWindows,
      refFrames,
      API_ROUNDING_Q,
      uncertifiedFrames
    );
    const agg = aggregateMethodResults(
      'vf_rvfc',
      [ev],
      1,
      referenceWindows.length
    );
    const passed =
      ev.rejectionReason === 'ineligible_timing' && agg.wrongFrameCount === 1;
    results.push({
      name: 'timing_delta_exceeds_1us',
      intendedCounter: 'wrongFrame',
      observedCounter: agg.wrongFrameCount === 1 ? 'wrongFrame' : 'none',
      rejectionReason: ev.rejectionReason,
      passed,
      detail: `Rejection: ${ev.rejectionReason}, wrongFrameCount: ${agg.wrongFrameCount}, timeDeltaUs: ${ev.timeDeltaUs?.toFixed(3)}us`,
    });
  }

  // Control 4: Duplicated VFR oracle
  // Expected: oracleAmbiguous and ambiguous_match in wrongFrame
  {
    const dupFrames = new Map<number, Uint8Array>();
    dupFrames.set(0, ref0);
    dupFrames.set(1, new Uint8Array(ref0));
    const distinction = checkOracleDistinction(dupFrames, 'vfr_duplicated');

    const sample = makeSample(w0.start, ref0);

    const ev = evaluateFrameSample(
      sample,
      0,
      referenceWindows,
      dupFrames,
      API_ROUNDING_Q,
      uncertifiedFrames
    );
    const agg = aggregateMethodResults(
      'vf_rvfc',
      [ev],
      1,
      referenceWindows.length
    );
    const passed =
      distinction.ambiguous &&
      ev.rejectionReason === 'ambiguous_match' &&
      agg.wrongFrameCount === 1;
    results.push({
      name: 'duplicated_vfr_oracle',
      intendedCounter: 'oracleAmbiguous',
      observedCounter:
        distinction.ambiguous && agg.wrongFrameCount === 1
          ? 'oracleAmbiguous'
          : 'none',
      rejectionReason: ev.rejectionReason,
      passed,
      detail: `Distinction minDelta: ${distinction.minDelta.toFixed(3)}, ambiguous: ${distinction.ambiguous}, ev.rejectionReason: ${ev.rejectionReason}`,
    });
  }

  // Control 5 (B9): Paused capture of window k evaluated as window k+1
  // Expected: wrongFrame counter
  {
    const sample = makeSample(w1.start, ref0);

    const ev = evaluateFrameSample(
      sample,
      1,
      referenceWindows,
      refFrames,
      API_ROUNDING_Q,
      uncertifiedFrames
    );
    const agg = aggregateMethodResults(
      'vf_rvfc',
      [ev],
      1,
      referenceWindows.length
    );
    const passed =
      (ev.rejectionReason === 'lagged_frame' ||
        ev.rejectionReason === 'burned_in_mismatch') &&
      agg.wrongFrameCount === 1;
    results.push({
      name: 'paused_window_k_evaluated_as_k_plus_1',
      intendedCounter: 'wrongFrame',
      observedCounter: agg.wrongFrameCount === 1 ? 'wrongFrame' : 'none',
      rejectionReason: ev.rejectionReason,
      passed,
      detail: `Rejection: ${ev.rejectionReason}, wrongFrameCount: ${agg.wrongFrameCount}`,
    });
  }

  // Control 6 (B9): Outside-span sample that shows a certified frame
  // Expected: unpredictedFallback counter
  {
    const lastWindow = referenceWindows[referenceWindows.length - 1]!;
    const sample = makeSample(lastWindow.end + 0.1, ref0);

    const ev = evaluateFrameSample(
      sample,
      0,
      referenceWindows,
      refFrames,
      API_ROUNDING_Q,
      new Set<number>() // frame 0 is not in empty uncertified set -> unpredicted fallback
    );
    const agg = aggregateMethodResults(
      'vf_rvfc',
      [ev],
      1,
      referenceWindows.length
    );
    const passed =
      ev.isFallbackRequired &&
      !ev.isPredictedFallback &&
      agg.unpredictedFallbackCount === 1;
    results.push({
      name: 'outside_span_certified_frame_unpredicted',
      intendedCounter: 'unpredictedFallback',
      observedCounter:
        agg.unpredictedFallbackCount === 1 ? 'unpredictedFallback' : 'none',
      rejectionReason: ev.rejectionReason,
      passed,
      detail: `Rejection: ${ev.rejectionReason}, unpredictedFallbackCount: ${agg.unpredictedFallbackCount}`,
    });
  }

  // Control 7 (B9): Scanner child run on a missing file
  // Expected: probeError counter
  {
    let threw = false;
    let errorMsg = '';
    try {
      await scanFixtureTimingInFreshProcess(
        resolve('/nonexistent/file/missing-fixture-404.mp4'),
        'video/mp4'
      );
    } catch (err) {
      threw = true;
      errorMsg = err instanceof Error ? err.message : String(err);
    }
    results.push({
      name: 'scanner_missing_file_probe_error',
      intendedCounter: 'probeError',
      observedCounter: threw ? 'probeError' : 'none',
      rejectionReason: 'probe_error',
      passed: threw,
      detail: `Scanner threw: ${threw} (${errorMsg.slice(0, 80)})`,
    });
  }

  // Control 8: Stress mode delay causes metadata inside_rvfc to produce wrongFrame on 60 fps class
  if (
    stressOptions?.delayRvfcMs !== undefined &&
    stressOptions.delayRvfcMs >= 40
  ) {
    const fr60Case = stressOptions.caseResults?.find(
      (c) => c.caseName === 'fr60.mp4' || c.caseName.includes('60')
    );
    const fr60WrongFrameCount =
      fr60Case?.methods.inside_rvfc.wrongFrameCount ?? 0;
    const stressPassed = fr60WrongFrameCount > 0;
    results.push({
      name: 'stress_delay_metadata_wrong_frame',
      intendedCounter: 'wrongFrame',
      observedCounter: stressPassed ? 'wrongFrame' : 'none',
      rejectionReason: stressPassed ? 'none' : 'stress_ineffective',
      passed: stressPassed,
      detail: fr60Case
        ? `fr60.mp4 inside_rvfc wrongFrameCount: ${fr60WrongFrameCount}`
        : 'fr60 class not found in case results',
    });
  }

  return results;
}

/* ==========================================================================
 * Two-Element Concurrent Coverage Helper
 * ========================================================================== */

export type PreparedCaseData = {
  readonly windows: readonly PacketWindow[];
  readonly refFrames: ReadonlyMap<number, Uint8Array>;
  readonly uncertifiedFrames?: ReadonlySet<number>;
};

export async function runTwoElementCoverage(
  cdp: CdpConnection,
  sessionId: string,
  serverOrigin: string,
  preparedCases: ReadonlyMap<string, PreparedCaseData>,
  minSamples = 20
): Promise<readonly TwoElementResult[]> {
  const results: TwoElementResult[] = [];

  function emptyResult(
    name: string,
    c1: string,
    off1: number,
    c2: string,
    off2: number,
    reason: string
  ): TwoElementResult {
    return {
      name,
      element1: {
        caseName: c1,
        offsetSeconds: off1,
        sampleCount: 0,
        matchRate: 0,
        approved: false,
      },
      element2: {
        caseName: c2,
        offsetSeconds: off2,
        sampleCount: 0,
        matchRate: 0,
        approved: false,
      },
      passed: false,
      failureReason: reason,
    };
  }

  async function evaluatePair(
    name: string,
    c1: string,
    off1: number,
    d1: PreparedCaseData,
    c2: string,
    off2: number,
    d2: PreparedCaseData
  ): Promise<TwoElementResult> {
    try {
      const u1 = `${serverOrigin}/media/${c1}`;
      const u2 = `${serverOrigin}/media/${c2}`;
      const probeRes = await evaluateInPage<{
        readonly samples1: readonly BrowserFrameSample[];
        readonly samples2: readonly BrowserFrameSample[];
      }>(
        cdp,
        sessionId,
        `window.runTwoElementAdmissionProbe('${u1}', '${u2}', ${off1}, ${off2}, ${minSamples})`
      );

      const ev1 = probeRes.samples1.map((s, idx) =>
        evaluateFrameSample(
          s,
          idx,
          d1.windows,
          d1.refFrames,
          API_ROUNDING_Q,
          d1.uncertifiedFrames
        )
      );
      const ev2 = probeRes.samples2.map((s, idx) =>
        evaluateFrameSample(
          s,
          idx,
          d2.windows,
          d2.refFrames,
          API_ROUNDING_Q,
          d2.uncertifiedFrames
        )
      );
      const agg1 = aggregateMethodResults(
        'vf_rvfc',
        ev1,
        minSamples,
        d1.windows.length
      );
      const agg2 = aggregateMethodResults(
        'vf_rvfc',
        ev2,
        minSamples,
        d2.windows.length
      );
      const passed = agg1.approved && agg2.approved;

      return {
        name,
        element1: {
          caseName: c1,
          offsetSeconds: off1,
          sampleCount: agg1.sampleCount,
          matchRate: agg1.matchRate,
          approved: agg1.approved,
        },
        element2: {
          caseName: c2,
          offsetSeconds: off2,
          sampleCount: agg2.sampleCount,
          matchRate: agg2.matchRate,
          approved: agg2.approved,
        },
        passed,
        ...(passed
          ? {}
          : {
              failureReason:
                `${agg1.failureReason ?? ''}; ${agg2.failureReason ?? ''}`.trim(),
            }),
      };
    } catch (err) {
      return emptyResult(
        name,
        c1,
        off1,
        c2,
        off2,
        `probe_error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const fr24 = preparedCases.get('fr24.mp4');
  const fr60 = preparedCases.get('fr60.mp4');

  if (!fr24) {
    results.push(
      emptyResult(
        'same_file_different_offsets',
        'fr24.mp4',
        0,
        'fr24.mp4',
        1.0,
        'probe_error: Missing fr24.mp4'
      )
    );
  } else {
    results.push(
      await evaluatePair(
        'same_file_different_offsets',
        'fr24.mp4',
        0,
        fr24,
        'fr24.mp4',
        1.0,
        fr24
      )
    );
  }

  if (!fr24 || !fr60) {
    results.push(
      emptyResult(
        'different_frame_rates',
        'fr24.mp4',
        0,
        'fr60.mp4',
        0,
        'probe_error: Missing fr24.mp4 or fr60.mp4'
      )
    );
  } else {
    results.push(
      await evaluatePair(
        'different_frame_rates',
        'fr24.mp4',
        0,
        fr24,
        'fr60.mp4',
        0,
        fr60
      )
    );
  }

  return results;
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
  let minSamples = 20;
  let cases: string[] | undefined;
  let methods: DrawMethod[] = ['inside_rvfc', 'vf_rvfc'];
  let json = false;
  let help = false;
  let cpu4x = false;
  let cpuThrottlingRate = 1;
  let delayRvfcMs: number | undefined;
  let twoElements = false;
  let negativeControls = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
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
      minSamples = Math.max(1, Number(argv[++i]!) || 20);
    } else if (arg === '--cases' && i + 1 < argv.length) {
      cases = argv[++i]!.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === '--methods' && i + 1 < argv.length) {
      methods = argv[++i]!.split(',')
        .map((s) => s.trim())
        .filter((s): s is DrawMethod => s === 'inside_rvfc' || s === 'vf_rvfc');
    } else if (arg === '--delay-rvfc-ms' && i + 1 < argv.length) {
      delayRvfcMs = Math.max(0, Number(argv[++i]!) || 0);
    } else if (arg === '--cpu-4x') {
      cpu4x = true;
      cpuThrottlingRate = 4;
    } else if (arg === '--cpu-throttling' && i + 1 < argv.length) {
      cpuThrottlingRate = Math.max(1, Number(argv[++i]!) || 1);
    } else if (arg === '--two-elements') {
      twoElements = true;
    } else if (arg === '--negative-controls') {
      negativeControls = true;
    }
  }

  return {
    ...(chromePath !== undefined ? { chromePath } : {}),
    fixturesDir,
    ...(outputDir !== undefined ? { outputDir } : {}),
    ...(outputPath !== undefined ? { outputPath } : {}),
    ...(tempDir !== undefined ? { tempDir } : {}),
    minSamples,
    ...(cases !== undefined ? { cases } : {}),
    methods: methods.length > 0 ? methods : ['inside_rvfc', 'vf_rvfc'],
    json,
    help,
    cpu4x,
    cpuThrottlingRate,
    ...(delayRvfcMs !== undefined ? { delayRvfcMs } : {}),
    twoElements,
    negativeControls,
  };
}

function printUsage(): void {
  console.log(`Usage: bun packages/relic-mcp/test/otio-native-frame-admission.ts [options]

Options:
  --chrome <path>        Path to owned Chrome/Chromium headless executable
  --fixtures-dir <dir>   Path to decoder boundary fixtures directory
  --output-dir <dir>     Directory to write json admission report
  --output <path>        Explicit path to write json admission report
  --temp-dir <dir>       Directory for scratch/runtime files
  --min-samples <n>      Minimum frame samples per fixture method (default: 20)
  --cases <list>         Comma-separated list of fixture files to test (default: all)
  --methods <list>       Draw methods to test: inside_rvfc, vf_rvfc (default: inside_rvfc, vf_rvfc)
  --cpu-4x               Throttle browser CPU by 4x during probe
  --cpu-throttling <n>   Set browser CPU throttling rate (default: 1)
  --delay-rvfc-ms <n>   Wrap rVFC with <n> ms busy-wait stress delay
  --two-elements         Run concurrent two-element decoder coverage
  --negative-controls    Run negative controls verification suite
  --json                 Output full report as JSON to stdout
  --help, -h             Show this help message
`);
}

/* ==========================================================================
 * Admission Proof Orchestrator
 * ========================================================================== */

export const COVERAGE_FLOOR_CASES = [
  'fr24.mp4',
  'fr60.mp4',
  'fr24b.mp4',
  'fr24b.mov',
  'vfr.mp4',
  'fr30.webm',
  'no-duration.webm',
  'long-gop-1080p.mp4',
] as const;

export async function runAdmissionProof(
  options: CliOptions
): Promise<AdmissionReport> {
  const defaultOwnedShell =
    '/Users/jwaldrip/.omp/owned-shells/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell';
  const chromePath =
    options.chromePath ??
    process.env['RELIC_OTIO_CHROME_PATH'] ??
    process.env['RELIC_CHROME_PATH'] ??
    defaultOwnedShell;

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

  const tempRoot = options.tempDir
    ? resolve(options.tempDir)
    : await mkdtemp(join(tmpdir(), 'relic-otio-admission-'));
  const profileDir = join(tempRoot, 'profile');
  await mkdir(profileDir, { recursive: true });

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
    serverHandle = await startLoopbackServer(
      options.fixturesDir,
      tempRoot,
      options.delayRvfcMs ?? 0
    );

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

    const productRaw = attestation.version?.['product'];
    if (!productRaw || typeof productRaw !== 'string') {
      throw new Error(
        'Browser product attestation is missing from Browser.getVersion'
      );
    }
    const browserProduct = String(productRaw);

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

    // CPU Throttling if requested
    if (options.cpuThrottlingRate && options.cpuThrottlingRate > 1) {
      await cdp.send(
        'Emulation.setCPUThrottlingRate',
        { rate: options.cpuThrottlingRate },
        sessionId
      );
    }

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

    // Wait for test harness function to mount
    const mountDeadline = Date.now() + 20000;
    let mounted = false;
    while (Date.now() < mountDeadline) {
      try {
        const hasFn = await evaluateInPage<boolean>(
          cdp,
          sessionId,
          `typeof window.runAdmissionProbe === 'function' && typeof window.capturePausedFrames === 'function'`
        );
        if (hasFn) {
          mounted = true;
          break;
        }
      } catch {}
      const { promise: delayPromise, resolve: delayResolve } =
        Promise.withResolvers<void>();
      setTimeout(delayResolve, 50);
      await delayPromise;
    }
    assert.ok(
      mounted,
      'Timed out waiting for harness functions to mount after Page.navigate'
    );

    // 5. Enumerate test cases
    const staticCaseNames = [
      'fr24.mp4',
      'fr60.mp4',
      'fr24b.mp4',
      'fr24b.mov',
      'vfr.mp4',
      'fr30.webm',
      'no-duration.webm',
      'short-edit.mp4',
      'rate-edit.mp4',
      'loop-edit.mp4',
    ];
    const allCandidateCases: Array<{
      readonly caseName: string;
      readonly filePath: string;
      readonly oracleEntry: FfprobeFileEntry;
    }> = staticCaseNames
      .map((caseName) => ({
        caseName,
        filePath: join(options.fixturesDir, caseName),
        oracleEntry: oracle.files?.[caseName]!,
      }))
      .concat([
        {
          caseName: longGop.fileName,
          filePath: longGop.filePath,
          oracleEntry: longGop.oracleEntry,
        },
      ]);

    const activeCases = allCandidateCases.filter((c) => {
      if (!options.cases || options.cases.length === 0) return true;
      return options.cases.includes(c.caseName);
    });

    assert.ok(activeCases.length > 0, 'No active test cases selected');

    // 6. Execute admission tests per case
    const caseResults: CaseAdmissionResult[] = [];
    const preparedCases = new Map<string, PreparedCaseData>();

    for (const testCase of activeCases) {
      let caseWindows: readonly PacketWindow[] = [];
      let eligibility: { eligible: boolean; reason?: string } = {
        eligible: true,
      };
      let oracleFramesCount = 0;
      let refFrames: ReadonlyMap<number, Uint8Array> = new Map();
      let distinction = { ambiguous: false, minDelta: 0 };
      let caseFailureReason: string | undefined;
      let outcome: CaseOutcome = 'pass';
      let uncertifiedFrames: ReadonlySet<number> | undefined;

      try {
        const mimeType = getMimeType(testCase.caseName);
        const scannerTiming = await scanFixtureTimingInFreshProcess(
          testCase.filePath,
          mimeType
        );

        if (scannerTiming.kind === 'unknown') {
          eligibility = { eligible: false, reason: scannerTiming.reason };
          oracleFramesCount = (testCase.oracleEntry.frames ?? []).length;
          outcome = 'ineligible';
        } else {
          const harness = buildHarnessWindowsFromScanner(
            scannerTiming,
            testCase.oracleEntry,
            testCase.caseName
          );
          if (!harness.oracleValid) {
            outcome = 'oracle_invalid';
            caseFailureReason = harness.reason;
          } else {
            caseWindows = harness.windows;
            uncertifiedFrames = harness.uncertifiedFrames;
            eligibility = checkCaseEligibility(caseWindows, API_ROUNDING_Q);
            oracleFramesCount = (testCase.oracleEntry.frames ?? []).length;
            if (!eligibility.eligible) {
              outcome = 'ineligible';
            } else {
              refFrames = await extractReferenceFrames(
                testCase.filePath,
                oracleFramesCount,
                64,
                16
              );

              distinction = checkOracleDistinction(
                refFrames,
                testCase.caseName
              );
              if (distinction.ambiguous) {
                caseFailureReason = `Ambiguous oracle in ${testCase.caseName}: min delta ${distinction.minDelta.toFixed(3)} <= 4.0`;
                outcome = 'oracle_invalid';
              } else {
                const mediaUrl = `${serverHandle.origin}/media/${testCase.caseName}`;
                const pausedOracle = await validateRealPausedSeekOracle(
                  cdp,
                  sessionId,
                  mediaUrl,
                  caseWindows,
                  refFrames,
                  uncertifiedFrames
                );
                if (!pausedOracle.valid) {
                  caseFailureReason = pausedOracle.reason;
                  outcome = 'oracle_invalid';
                } else {
                  preparedCases.set(testCase.caseName, {
                    windows: caseWindows,
                    refFrames,
                    ...(uncertifiedFrames !== undefined
                      ? { uncertifiedFrames }
                      : {}),
                  });
                }
              }
            }
          }
        }
      } catch (prepErr) {
        caseFailureReason =
          prepErr instanceof Error ? prepErr.message : String(prepErr);
        outcome = 'probe_error';
      }

      function makeEmptyMethod(
        drawMethod: DrawMethod,
        reason?: string,
        condition?: string
      ): MethodEvaluationResult {
        return {
          drawMethod,
          sampleCount: 0,
          certifiedSampleCount: 0,
          distinctFramesCount: 0,
          matchCount: 0,
          mismatchCount: 0,
          wrongFrameCount: 0,
          uncoveredInSpanCount: 0,
          fallbackRequiredCount: 0,
          unpredictedFallbackCount: 0,
          captureFailedCount: 0,
          matchRate: 0,
          errorRatio: 1,
          rmseP50: null,
          rmseP95: null,
          rmseMax: null,
          distinctionMarginP50: null,
          deltaMinUs: null,
          deltaMaxUs: null,
          maxAbsDeltaUs: null,
          deltaP50Us: null,
          deltaP95Us: null,
          lagDistribution: {},
          rejectionReasons: reason ? { [reason]: 1 } : {},
          approved: false,
          ...(reason !== undefined ? { failureReason: reason } : {}),
          ...(condition !== undefined ? { failedCondition: condition } : {}),
        };
      }

      const methodResults: Record<DrawMethod, MethodEvaluationResult> = {
        inside_rvfc: makeEmptyMethod('inside_rvfc'),
        vf_rvfc: makeEmptyMethod('vf_rvfc'),
      };

      let caseDisagreementCount = 0;
      let caseDisagreementRate = 0;

      if (outcome === 'pass') {
        try {
          const mediaUrl = `${serverHandle.origin}/media/${testCase.caseName}`;
          const probeRes = await evaluateInPage<{
            readonly inside_rvfc: readonly BrowserFrameSample[];
            readonly vf_rvfc: readonly BrowserFrameSample[];
            readonly completed: boolean;
            readonly timedOut: boolean;
          }>(
            cdp,
            sessionId,
            `window.runAdmissionProbe('${mediaUrl}', ${options.minSamples})`
          );

          const insideEvaluations: SampleEvaluation[] = (
            probeRes.inside_rvfc ?? []
          ).map((s, idx) =>
            evaluateFrameSample(
              s,
              idx,
              caseWindows,
              refFrames,
              API_ROUNDING_Q,
              uncertifiedFrames
            )
          );

          const vfEvaluations: SampleEvaluation[] = (
            probeRes.vf_rvfc ?? []
          ).map((s, idx) =>
            evaluateFrameSample(
              s,
              idx,
              caseWindows,
              refFrames,
              API_ROUNDING_Q,
              uncertifiedFrames
            )
          );

          const insideAgg = aggregateMethodResults(
            'inside_rvfc',
            insideEvaluations,
            options.minSamples,
            caseWindows.length
          );

          const vfAgg = aggregateMethodResults(
            'vf_rvfc',
            vfEvaluations,
            options.minSamples,
            caseWindows.length
          );

          methodResults.inside_rvfc = insideAgg;
          methodResults.vf_rvfc = vfAgg;

          let disagreementCount = 0;
          const pairCount = Math.min(
            insideEvaluations.length,
            vfEvaluations.length
          );
          for (let pIdx = 0; pIdx < pairCount; pIdx++) {
            const inEv = insideEvaluations[pIdx]!;
            const vfEv = vfEvaluations[pIdx]!;
            if (
              inEv.expectedFrame !== vfEv.expectedFrame ||
              inEv.isMatch !== vfEv.isMatch
            ) {
              disagreementCount++;
            }
          }
          caseDisagreementCount = disagreementCount;
          caseDisagreementRate =
            pairCount > 0 ? disagreementCount / pairCount : 0;

          // vf_rvfc is the certified / gating method
          if (vfAgg.approved) {
            outcome = 'pass';
          } else {
            outcome = 'native_mismatch';
            caseFailureReason = vfAgg.failureReason;
          }
        } catch (probeErr) {
          const errMsg =
            probeErr instanceof Error ? probeErr.message : String(probeErr);
          methodResults.inside_rvfc = makeEmptyMethod(
            'inside_rvfc',
            errMsg,
            'probe_error'
          );
          methodResults.vf_rvfc = makeEmptyMethod(
            'vf_rvfc',
            errMsg,
            'probe_error'
          );
          outcome = 'probe_error';
          caseFailureReason = errMsg;
        }
      } else {
        const failureReason = !eligibility.eligible
          ? `Ineligible: ${eligibility.reason}`
          : caseFailureReason;
        const failedCondition = !eligibility.eligible
          ? `ineligible_${eligibility.reason}`
          : outcome;
        methodResults.inside_rvfc = makeEmptyMethod(
          'inside_rvfc',
          failureReason,
          failedCondition
        );
        methodResults.vf_rvfc = makeEmptyMethod(
          'vf_rvfc',
          failureReason,
          failedCondition
        );
      }

      caseResults.push({
        caseName: testCase.caseName,
        filePath: basename(testCase.filePath),
        outcome,
        totalOracleFrames: oracleFramesCount,
        oracleDistinctionMinRmse: distinction.minDelta,
        oracleAmbiguous: distinction.ambiguous,
        eligible: eligibility.eligible,
        ...(eligibility.reason !== undefined
          ? { ineligibilityReason: eligibility.reason }
          : {}),
        ...(caseFailureReason !== undefined
          ? { failureReason: caseFailureReason }
          : {}),
        methods: methodResults,
        approved: outcome === 'pass',
        metadataDisagreementCount: caseDisagreementCount,
        metadataDisagreementRate: caseDisagreementRate,
      });
    }

    // 7. Negative controls suite execution
    let negativeControlResults: readonly NegativeControlResult[] = [];
    if (options.negativeControls) {
      const firstEligibleCase =
        activeCases.find((c) => c.caseName === 'fr24.mp4') ?? activeCases[0];
      if (firstEligibleCase) {
        try {
          const fr24Entry = firstEligibleCase.oracleEntry;
          const fr24Mime = getMimeType(firstEligibleCase.caseName);
          const fr24Scanner = await scanFixtureTimingInFreshProcess(
            firstEligibleCase.filePath,
            fr24Mime
          );
          if (fr24Scanner.kind === 'windows') {
            const fr24Harness = buildHarnessWindowsFromScanner(
              fr24Scanner,
              fr24Entry,
              firstEligibleCase.caseName
            );
            if (fr24Harness.oracleValid && fr24Harness.windows.length >= 2) {
              const fr24RefFrames = await extractReferenceFrames(
                firstEligibleCase.filePath,
                (fr24Entry.frames ?? []).length,
                64,
                16
              );
              negativeControlResults = await runNegativeControls(
                fr24Harness.windows,
                fr24RefFrames,
                fr24Harness.uncertifiedFrames,
                {
                  ...(options.delayRvfcMs !== undefined
                    ? { delayRvfcMs: options.delayRvfcMs }
                    : {}),
                  caseResults,
                }
              );
            }
          }
        } catch {}
      }
    }

    // 8. Two-element concurrent decode coverage if requested
    let twoElementResults: readonly TwoElementResult[] = [];
    if (options.twoElements) {
      twoElementResults = await runTwoElementCoverage(
        cdp,
        sessionId,
        serverHandle.origin,
        preparedCases,
        20
      );
    }

    const eligibleCases = caseResults.filter((c) => c.eligible !== false);
    const insideApproved =
      eligibleCases.length > 0 &&
      eligibleCases.every((c) => c.methods.inside_rvfc.approved);
    const vfApproved =
      eligibleCases.length > 0 &&
      eligibleCases.every((c) => c.methods.vf_rvfc.approved);

    const metadataDisagreementByClass: Record<
      string,
      {
        readonly sampleCount: number;
        readonly disagreementCount: number;
        readonly disagreementRate: number;
      }
    > = {};

    for (const c of caseResults) {
      if (c.eligible && c.metadataDisagreementCount !== undefined) {
        metadataDisagreementByClass[c.caseName] = {
          sampleCount: c.methods.inside_rvfc.sampleCount,
          disagreementCount: c.metadataDisagreementCount,
          disagreementRate: c.metadataDisagreementRate ?? 0,
        };
      }
    }

    const report: AdmissionReport = {
      schemaVersion: 'relic-otio-native-frame-admission/v1',
      timestamp: new Date().toISOString(),
      chromePath: basename(foundChrome.path),
      browserProduct,
      cpuThrottlingRate: options.cpuThrottlingRate ?? (options.cpu4x ? 4 : 1),
      ...(options.delayRvfcMs !== undefined
        ? { delayRvfcMs: options.delayRvfcMs }
        : {}),
      minSamplesRequired: options.minSamples,
      casesTotal: caseResults.length,
      casesPassed: caseResults.filter((c) => c.approved).length,
      casesEligible: eligibleCases.length,
      methodApproval: {
        inside_rvfc: insideApproved,
        vf_rvfc: vfApproved,
      },
      certifiedDrawMethod: vfApproved ? 'vf_rvfc' : 'none',
      cases: caseResults,
      metadataDisagreementByClass,
      ...(negativeControlResults.length > 0
        ? { negativeControls: negativeControlResults }
        : {}),
      ...(twoElementResults.length > 0
        ? { twoElementCoverage: twoElementResults }
        : {}),
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
        [
          '\n===============================================================',
          'OTIO Native Frame Admission Proof Report',
          '===============================================================',
          `Browser Product:   ${report.browserProduct}`,
          `Chrome Binary:     ${report.chromePath}`,
          `CPU Throttling:    ${report.cpuThrottlingRate}x`,
          ...(report.delayRvfcMs !== undefined
            ? [`Delay rVFC:       ${report.delayRvfcMs}ms`]
            : []),
          `Cases Evaluated:   ${report.casesTotal}`,
          ...(report.casesEligible !== undefined
            ? [
                `Cases Eligible:    ${report.casesEligible} / ${report.casesTotal}`,
              ]
            : []),
          `Cases Passed:      ${report.casesPassed} / ${report.casesTotal}`,
          `Method vf_rvfc:    ${report.methodApproval.vf_rvfc ? 'APPROVED (100% match)' : 'REJECTED'}`,
          `Method inside_rvfc: ${report.methodApproval.inside_rvfc ? 'APPROVED (100% match)' : 'REJECTED (non-gating)'}`,
          `Certified Method:  ${report.certifiedDrawMethod.toUpperCase()}`,
        ].join('\n')
      );
      for (const c of report.cases) {
        const eligStr =
          c.eligible === false
            ? ` [INELIGIBLE: ${c.ineligibilityReason ?? 'unsupported'}]`
            : '';
        console.log(
          `\nCase: ${c.caseName} [${c.outcome.toUpperCase()}]${eligStr} (${c.totalOracleFrames} oracle frames, min distinction: ${c.oracleDistinctionMinRmse.toFixed(2)} RMSE)`
        );
        if (c.failureReason) {
          console.log(`    Case Note: ${c.failureReason}`);
        }
        const vfRes = c.methods.vf_rvfc;
        const insideRes = c.methods.inside_rvfc;
        if (vfRes) {
          console.log(
            `  [vf_rvfc]     samples=${vfRes.sampleCount}, certified=${vfRes.certifiedSampleCount}, distinct=${vfRes.distinctFramesCount}, matchRate=${(vfRes.matchRate * 100).toFixed(2)}%, rmseP50=${vfRes.rmseP50 !== null ? vfRes.rmseP50.toFixed(2) : 'null'}, rmseMax=${vfRes.rmseMax !== null ? vfRes.rmseMax.toFixed(2) : 'null'}, maxDelta=${vfRes.maxAbsDeltaUs !== null ? `${vfRes.maxAbsDeltaUs.toFixed(3)}us` : 'null'}, approved=${vfRes.approved}`
          );
          if (vfRes.failureReason) {
            console.log(`    VF Failure: ${vfRes.failureReason}`);
          }
        }
        if (insideRes) {
          console.log(
            `  [inside_rvfc] samples=${insideRes.sampleCount}, certified=${insideRes.certifiedSampleCount}, distinct=${insideRes.distinctFramesCount}, matchRate=${(insideRes.matchRate * 100).toFixed(2)}%, wrongFrames=${insideRes.wrongFrameCount}, approved=${insideRes.approved}`
          );
          if (insideRes.failureReason) {
            console.log(`    Metadata Note: ${insideRes.failureReason}`);
          }
        }
        if (c.metadataDisagreementCount !== undefined) {
          console.log(
            `  [disagreement] inside_rvfc vs vf_rvfc: count=${c.metadataDisagreementCount}/${insideRes?.sampleCount ?? 0} (${((c.metadataDisagreementRate ?? 0) * 100).toFixed(2)}%)`
          );
        }
        if (
          vfRes.deltaDistribution &&
          Object.keys(vfRes.deltaDistribution).length > 0
        ) {
          console.log(
            `    Delta Distribution (0.1us buckets): ${JSON.stringify(vfRes.deltaDistribution)}`
          );
        }
        if (Object.keys(vfRes.lagDistribution).length > 0) {
          console.log(
            `    Lag Distribution (delta frames): ${JSON.stringify(vfRes.lagDistribution)}`
          );
        }
        if (Object.keys(vfRes.rejectionReasons).length > 0) {
          console.log(
            `    Rejection Reasons: ${JSON.stringify(vfRes.rejectionReasons)}`
          );
        }
      }

      if (report.negativeControls && report.negativeControls.length > 0) {
        console.log(
          '\n---------------------------------------------------------------'
        );
        console.log('Negative Controls Verification:');
        for (const nc of report.negativeControls) {
          console.log(
            `  [${nc.name}] intended=${nc.intendedCounter} observed=${nc.observedCounter} passed=${nc.passed} (${nc.detail ?? ''})`
          );
        }
      }

      if (report.twoElementCoverage && report.twoElementCoverage.length > 0) {
        console.log(
          '\n---------------------------------------------------------------'
        );
        console.log('Two-Element Coverage:');
        for (const te of report.twoElementCoverage) {
          console.log(
            `  [${te.name}] el1=${te.element1.caseName}@${te.element1.offsetSeconds}s (${te.element1.sampleCount} samples) el2=${te.element2.caseName}@${te.element2.offsetSeconds}s (${te.element2.sampleCount} samples) passed=${te.passed}`
          );
        }
      }
      if (
        report.metadataDisagreementByClass &&
        Object.keys(report.metadataDisagreementByClass).length > 0
      ) {
        console.log(
          '\n---------------------------------------------------------------'
        );
        console.log('Metadata Disagreement Summary (inside_rvfc vs vf_rvfc):');
        for (const [cls, d] of Object.entries(
          report.metadataDisagreementByClass
        )) {
          console.log(
            `  ${cls.padEnd(20)}: ${d.disagreementCount}/${d.sampleCount} disagreed (${(d.disagreementRate * 100).toFixed(2)}%)`
          );
        }
      }

      console.log(
        '\n==============================================================='
      );
    }

    if (options.delayRvfcMs !== undefined && options.delayRvfcMs >= 40) {
      const fr60Case = report.cases.find(
        (c) => c.caseName === 'fr60.mp4' || c.caseName.includes('60')
      );
      const fr60WrongFrameCount =
        fr60Case?.methods.inside_rvfc.wrongFrameCount ?? 0;
      if (fr60WrongFrameCount === 0) {
        console.error(
          '\nADMISSION INCOMPLETE: stress ineffective (exit 2) - metadata inside_rvfc showed 0 wrongFrame on 60 fps class under delay stress'
        );
        process.exit(2);
      }
    }

    const hasNativeMismatch = report.cases.some(
      (c) => c.outcome === 'native_mismatch'
    );
    const hasTwoElementMismatch =
      Boolean(options.twoElements) &&
      Boolean(report.twoElementCoverage?.some((te) => !te.passed));
    const hasControlMismatch =
      Boolean(options.negativeControls) &&
      Boolean(report.negativeControls?.some((nc) => !nc.passed));

    if (hasNativeMismatch || hasTwoElementMismatch || hasControlMismatch) {
      console.error('\nADMISSION FAILED (exit 1)');
      process.exit(1);
    }

    const floorPassed = COVERAGE_FLOOR_CASES.every((fc) => {
      const c = report.cases.find((x) => x.caseName === fc);
      return c && c.outcome === 'pass';
    });
    const twoElementsPassed =
      !options.twoElements ||
      Boolean(
        report.twoElementCoverage &&
          report.twoElementCoverage.length > 0 &&
          report.twoElementCoverage.every((te) => te.passed)
      );
    const controlsPassed =
      !options.negativeControls ||
      Boolean(
        report.negativeControls &&
          report.negativeControls.length > 0 &&
          report.negativeControls.every((nc) => nc.passed)
      );

    if (floorPassed && twoElementsPassed && controlsPassed) {
      console.log('\nADMISSION PASSED (exit 0)');
      process.exit(0);
    }

    console.error('\nADMISSION INCOMPLETE (exit 2)');
    process.exit(2);
  } catch (err) {
    console.error('\nADMISSION PROOF ERROR:', err);
    process.exit(2);
  }
}

// Run CLI when invoked directly
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  void main();
}
