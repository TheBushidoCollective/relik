/**
 * Primer proof trials. Every trial opens a fresh owned chrome-headless-shell with Chrome's default
 * --mute-audio, so nothing reaches a speaker. Gates live in otio-program-trace.ts; this module only
 * drives the browser and records what it saw.
 *
 * Two sequences, both starting from an idle default output:
 *   - pre-navigation: two OS readings 250 ms apart, the same device, both idle. Otherwise the trial
 *     fails with "external audio before navigation". The trace starts on about:blank and writes
 *     its start mark there, before navigation, so preload is inside the trace.
 *   - F, fresh visit: navigate and interact as soon as metadata loads. The user budgets are gated
 *     on prepared, first-click and unmute. Sham and the bare arms are reported only. F makes no
 *     cold claim.
 *   - L, late interaction: after metadata, the output must first run (within 3 s), then read idle
 *     on two consecutive polls (within 30 s of load). The trial then holds a quiet window and a
 *     quiet OS reading before its first trusted event. Only a trial that meets that is cold, and
 *     the cold bare controls (none and sham) must each miss a program frame slot.
 *
 * Measured sources, none of them an audio tap:
 *   - presented frames: requestVideoFrameCallback on the program video, page clock, with the
 *     element clock and the frame's timing metadata beside each frame;
 *   - device starts (OutputController::Play) and device callbacks: Chrome's own trace, trace clock.
 *     Device starts gate; callbacks and stream creation are telemetry and never prove an audio gap;
 *   - the default output's running state: the OS, read through otio-program-device-state.ts;
 *   - trusted pointer events: performance.mark, which bridges the two clocks.
 *   - bare display tick: the bare page's own per-frame loop, recording its page times in the page.
 *
 * Arms (PATH.md has the full table):
 *   wrap:   primer alone for 12 s, with and without AudioRendererMixerImmediatePause (sequence L);
 *   bare:   none | sham | av | av-blob | audio-only | context | video-only (Prepare, 1500 ms, Play);
 *     Bare pages run a per-frame loop, lighter than the viewer's tick (which emits only on a frame change
 *     and enforces bounds): from the program's play event until pause or end, each animation frame writes video.currentTime into a non-media output. It only reads the media element.
 *   viewer: prepared | sham | first-click | unmute on the real viewer, production or sham build.
 *
 * Each group returns its failures. A control group with too few cold trials is inconclusive, and
 * inconclusive fails. Sampled audio lives in otio-program-audio-arm.ts, not here.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  OTIO_AUDIO_PRIMER_BYTE_LENGTH,
  OTIO_AUDIO_PRIMER_SHA256,
  otioAudioPrimerBytes,
} from '../../relic-viewer/src/otio-audio-primer-media.ts';
import { clockDeficitSummary } from './otio-program-clock-deficit.ts';
import {
  DEVICE_IDLE_LIMIT_MS,
  type DeviceProbe,
  type DeviceState,
  readDeviceState,
} from './otio-program-device-state.ts';
import type { ProofHarness } from './otio-program-harness.ts';
import { PROGRAM } from './otio-program-reference.ts';
import {
  assertVideoPacketsIdentical,
  videoOnlyRemux,
} from './otio-program-remux-controls.ts';
import {
  externalRunningMs,
  markOrderFailures,
  type OsReading,
  pipelineResumed,
  RESUME_WINDOW_US,
  type Coldness,
  classifyColdness,
  creationCounts,
  DEVICE_START_EVENT,
  deviceCallbacks,
  deviceExcessMs,
  deviceStarts,
  firstStart,
  GAP_BUDGET_MS,
  gateGaps,
  gatePrimerWindow,
  intervals,
  markTs,
  maxOf,
  MIN_WINDOW_INTERVALS,
  missedSlots,
  newFrames,
  p95,
  PLAY_MARK,
  PREPARE_MARK,
  PRIMER_TRACE_CATEGORIES,
  type PrimerWindow,
  QUIET_WINDOW_MS,
  type QuietWindow,
  quietWindow,
  STREAM_CREATION_EVENTS,
  TRACE_START_MARK,
  type TraceEvent,
  UNMUTE_MARK,
  WINDOW_MS,
  windowEdgeGaps,
} from './otio-program-trace.ts';
import {
  type HideLog,
  openViewer,
  PRIMER_ATTRIBUTE,
  PRIMER_IMMEDIATE_PAUSE_ARG,
  type PrimerChromeArg,
  type ViewerPage,
  VIEWER_CONTRACT,
} from './otio-program-viewer.ts';
import type { ViewerBuild, ViewerRouter } from './otio-program-builds.ts';
import { checkShamBuilds } from './otio-program-sham-build.ts';

export const PRIMER_ROUNDS = 5;
/** Cold trials each control needs. Fewer makes that group inconclusive, which fails. */
export const MIN_COLD_TRIALS = 3;

/** Cold trials of a list. Only the 'cold' label is a cold start: resumed, warm, absent and unproven never count. */
export function coldTrials<T extends Pick<PrimerTrial, 'coldness'>>(
  list: readonly T[]
): T[] {
  return list.filter((trial) => trial.coldness === 'cold');
}

/** A group with fewer cold trials than MIN_COLD_TRIALS is inconclusive, and that fails. */
export function inconclusiveFailures(
  name: string,
  list: readonly Pick<PrimerTrial, 'coldness'>[]
): string[] {
  const count = coldTrials(list).length;
  return count < MIN_COLD_TRIALS
    ? [`${name}: ${count} cold trial(s), need ${MIN_COLD_TRIALS}; inconclusive`]
    : [];
}
/** Sequence F and L: two OS readings this far apart, both idle, before navigation. */
const PRE_NAV_SPACING_MS = 250;
/** Sequence L: the output must start within this long after metadata. */
const LATE_RUNNING_LIMIT_MS = 3000;
/** Sequence L: how often the OS is read while the running-then-idle pattern is awaited. */
const SETTLE_POLL_MS = 25;
/** Sequence L: quiet time after the idle pair, so the 500 ms before the trusted event is idle. */
const QUIET_SETTLE_MS = QUIET_WINDOW_MS + 100;
/** Unmute window: [-500, +2000] ms around the Unmute pointerdown. */
const UNMUTE_WINDOW_BEFORE_MS = 500;
const UNMUTE_WINDOW_AFTER_MS = 2000;
const MIN_UNMUTE_INTERVALS = 40;
const UNMUTE_DELAY_MS = 1500;
const UNMUTE_MUTED_BUDGET_MS = 1000;
const MUTE_PRESS_BUDGET_MS = 2000;
const BARE_PREPARE_WAIT_MS = 1500;
const WRAP_MS = 12_000;
const PRIMER_SEEK_BACK_S = 3;
/** A hidden viewer's primer must read idle this soon after the hidden event. */
const HIDDEN_IDLE_BUDGET_MS = 1500;
const MARKERS_TAB = '.otio-inspector-tab[data-tab="markers"]';
const MUTE_CONTROL = 'button.otio-program-mute';
const MUTE_PRESSED = `document.querySelector('button.otio-program-mute')?.getAttribute('aria-pressed') ?? null`;

const BARE_ARMS = [
  'none',
  'sham',
  'av',
  'av-blob',
  'audio-only',
  'context',
  'video-only',
] as const;
type BareArm = (typeof BARE_ARMS)[number];
export type { BareArm };
/** Arms that run the real primer, and therefore gate on device starts and frame cadence. */
const PRIMER_BARE_ARMS: readonly BareArm[] = ['av', 'av-blob'];
const VIEWER_ARMS = ['prepared', 'sham', 'first-click', 'unmute'] as const;
type ViewerArm = (typeof VIEWER_ARMS)[number];

/** F: fresh visit, no cold claim. L: late interaction, cold controls. */
export type Sequence = 'fresh' | 'late';

/** Sequence L's wait for the running-then-idle pattern, relative to metadata. */
export interface SettleHold {
  readonly runningAfterMetadataMs: number | null;
  /** Last running reading before the idle pair: the start of the hold window. */
  readonly holdFromMs: number | null;
  /** First idle reading of the idle pair: the end of the hold window. */
  readonly holdToMs: number | null;
  /** Time from load to the first idle reading of the pair. */
  readonly idleAfterLoadMs: number | null;
}

/** Telemetry: where Chrome's start and stream creation landed. Never gates. */
export interface Reported {
  readonly firstDeviceStartFromTraceStartMs: number | null;
  readonly firstCreationFromTraceStartMs: number | null;
  readonly firstDeviceStartFromTrustedMs: number | null;
  readonly bufferingBeforeFirstFrame: boolean | null;
}

export interface PrimerTrial {
  readonly arm: string;
  readonly round: number;
  readonly sequence: Sequence;
  /** Sequence L's cold label. Sequence F never uses it. */
  readonly coldness: Coldness;
  /** Telemetry: a Play rebuilt the program's pipeline, so the start was resumed. Never cold. */
  readonly pipelineResumed: boolean;
  /** Telemetry: how long the OS read the default output running after Chrome's last pause. Never gates. */
  readonly externalRunningMs: number | null;
  /** Telemetry only: first device start to first device callback. Never gates. */
  readonly dMs: number | null;
  readonly startupMs: number | null;
  readonly maxGapMs: number | null;
  readonly p95GapMs: number | null;
  readonly intervals: number;
  /** Device starts (OutputController::Play) after the trusted Play. These gate where stated. */
  readonly deviceStartsAfterPlay: number;
  /** Sequence L only: the running-then-idle wait. Null for sequence F. */
  readonly settle: SettleHold | null;
  /** The OS reading of the default output at the first trusted event. */
  readonly osIdleAtTrusted: boolean;
  readonly restCurrentTime: number | null;
  readonly quiet: QuietWindow;
  /** Telemetry only: stream-creation events seen before the first trusted event, per name. */
  readonly creationBeforeTrusted: Record<string, number>;
  readonly reported: Reported;
  /** Telemetry only: callback spacing from the trace. Never gates and never proves audio. */
  readonly callbackTelemetry: {
    readonly count: number;
    readonly excessMs: number | null;
    readonly firstCallbackMs: number | null;
  };
  /** Bare arms: presentation and tick evidence of the window. Null for every other arm. */
  readonly bare: BareEvidence | null;
  readonly failures: string[];
}

export interface PrimerStage {
  readonly stage: string;
  /** Empty means the stage passed. */
  readonly failures: string[];
  readonly trials: readonly PrimerTrial[];
}

export interface PrimerProofInput {
  readonly harness: ProofHarness;
  readonly scratch: string;
  /** The positive program MP4: the same bytes the bare arms and the viewer play. */
  readonly programMp4: string;
  readonly shareUrl: string;
  /** Serves each arm from its own complete build directory, after routing is verified. */
  readonly router: ViewerRouter;
  /** The instrumented production build the video arms serve (emit recorder on). */
  readonly productionBuild: ViewerBuild;
  /** The same build with the primer's mute flipped. Verified against production before use. */
  readonly shamBuild: ViewerBuild;
  /** Built once by the path proof. Reads the default output's running state from the OS. */
  readonly deviceProbe: DeviceProbe;
}

interface Frame {
  readonly now: number;
  readonly mediaTime: number;
  readonly currentTime: number;
  readonly expectedDisplayTime: number | null;
  readonly presentationTime: number | null;
  readonly presentedFrames: number | null;
}

interface PointerObservation {
  readonly pointerAt: number;
  /** The program's currentTime read inside the trusted pointerdown: the resting frame. */
  readonly restCurrentTime?: number | null;
  readonly frames?: readonly Frame[];
  readonly buffering?: ReadonlyArray<{ at: number; value: string | null }>;
}

interface WrapReport {
  readonly error: string | null;
  readonly primer: { readonly paused: boolean } | null;
}

interface BareReport {
  readonly error: string | null;
}

interface ProgramState {
  readonly paused: boolean;
  readonly currentTime: number;
  readonly muted: boolean;
}

/** One default-output reading on the wall clock. Kept in the receipts, never gates by itself. */
interface WallReading {
  readonly wallMs: number;
  readonly running: boolean;
}

/** The instant of the trace-start mark on the wall clock, and the load instant the idle limit counts from. */
interface NavigationClock {
  readonly loadedAt: number;
  readonly traceStartWall: number;
}

/** A trial's OS readings on the trace clock, from the trace-start mark. Empty when that mark is absent. */
function osReadingsOnTrace(
  readings: readonly WallReading[],
  events: readonly TraceEvent[],
  traceStartWall: number
): OsReading[] {
  const traceStart = markTs(events, TRACE_START_MARK);
  if (traceStart === null) return [];
  return readings.map((r) => ({
    traceTs: traceStart + (r.wallMs - traceStartWall) * 1000,
    running: r.running,
  }));
}

/** What the OS showed before the first trusted event. Sequence F only reads it, never waits. */
interface Settled {
  /** Sequence L only: no running reading within 3 s, or no idle pair within 30 s of load. */
  readonly failures: string[];
  readonly hold: SettleHold | null;
  /** Every default-output reading taken while waiting, on the wall clock. Sequence L only. */
  readonly readings: readonly WallReading[];
  readonly state: DeviceState;
}

/** Page script for the bare arms. Plain string: no interpolation besides the seek-back constant. */
const BARE_SCRIPT = `
(() => {
  const arm = window.__primerArm;
  const prepare = document.querySelector('button.otio-prepare');
  const play = document.querySelector('button.otio-play');
  const video = document.querySelector('video.otio-program-video');
  const state = { error: null, primer: null, audio: null, context: null };
  const fail = (error) => { state.error = String(error); };
  const seekBack = (element) => setInterval(() => {
    if (element.currentTime > ${PRIMER_SEEK_BACK_S}) element.currentTime = 0;
  }, 50);
  prepare.addEventListener('pointerdown', (event) => {
    if (!event.isTrusted) return;
    try {
      if (arm === 'av' || arm === 'av-blob' || arm === 'sham') {
        const primer = document.createElement('video');
        primer.playsInline = true;
        primer.preload = 'auto';
        primer.volume = 1;
        primer.muted = arm === 'sham';
        primer.src = '/primer.mp4';
        state.primer = primer;
        seekBack(primer);
        primer.play().catch(fail);
      } else if (arm === 'audio-only') {
        const audio = new Audio('/primer.mp4');
        state.audio = audio;
        seekBack(audio);
        audio.play().catch(fail);
      } else if (arm === 'context') {
        const context = new AudioContext({ sampleRate: 48000 });
        state.context = context;
        context.resume().catch(fail);
      }
    } catch (error) { fail(error); }
  });
  play.addEventListener('pointerdown', (event) => {
    if (!event.isTrusted) return;
    video.play().catch(fail);
  });
  // Per-frame tick. While the program plays, each animation frame writes its clock into a non-media
  // output. Unlike the viewer's tick, which emits only on a frame change and enforces bounds, this loop
  // writes every frame and only reads video.currentTime.
  const tickOutput = document.querySelector('output.otio-tick');
  let tickFrame = 0;
  window.__primerTickLog = [];
  const tick = () => {
    tickFrame = 0;
    window.__primerTickLog.push(performance.now());
    tickOutput.textContent = String(video.currentTime);
    if (!video.paused && !video.ended) tickFrame = requestAnimationFrame(tick);
  };
  video.addEventListener('play', () => { if (tickFrame === 0) tickFrame = requestAnimationFrame(tick); });
  const stopTick = () => { if (tickFrame !== 0) cancelAnimationFrame(tickFrame); tickFrame = 0; };
  video.addEventListener('pause', stopTick);
  video.addEventListener('ended', stopTick);
  window.__primerReport = () => ({
    error: state.error,
    primer: state.primer ? { paused: state.primer.paused, currentTime: state.primer.currentTime, muted: state.primer.muted } : null,
    contextState: state.context ? state.context.state : null,
    videoPaused: video.paused,
  });
})();
`;

/**
 * Loads the program through a Blob URL. The bytes are fetched and their SHA-256 checked against the
 * program before the blob is made, so a Blob source cannot silently play different media.
 */
function blobScript(programSha256: string): string {
  return `(() => {
  const expected = ${JSON.stringify(programSha256)};
  const video = document.querySelector('video.otio-program-video');
  fetch('/program.mp4')
    .then((response) => { if (!response.ok) throw new Error('program fetch failed'); return response.arrayBuffer(); })
    .then(async (bytes) => {
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (x) => x.toString(16).padStart(2, '0')).join('');
      if (digest !== expected) throw new Error('blob bytes differ from program');
      video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    })
    .catch((error) => { window.__barePlayError = String(error); });
})();`;
}

export function bareHtml(arm: BareArm, programSha256: string): string {
  const src =
    arm === 'video-only'
      ? '/video-only.mp4'
      : arm === 'av-blob'
        ? ''
        : '/program.mp4';
  const srcAttr = src ? ` src="${src}"` : '';
  const blob =
    arm === 'av-blob' ? `<script>${blobScript(programSha256)}</script>` : '';
  return `<!doctype html><meta charset="utf-8">
<button class="otio-prepare" type="button">Prepare</button>
<button class="otio-play" type="button">Play</button>
<video class="otio-program-video" playsinline preload="auto"${srcAttr} style="width:640px;height:360px"></video>
<output class="otio-tick" style="display:block;font:12px monospace"></output>
<script>window.__primerArm = ${JSON.stringify(arm)};</script>
<script>${BARE_SCRIPT}</script>
${blob}`;
}

/**
 * Records every presented frame, its element clock and timing metadata, and buffering changes from
 * the first trusted pointerdown that matches selector. The resting currentTime is read inside that
 * same listener. durationMs 0 only writes the mark. The listener sits on window in the capture
 * phase, so it runs before every page listener: the mark precedes the page's reaction to the same
 * event, and markOrderFailures checks that order. It is not `once`, so a non-matching pointer event
 * cannot consume it.
 */
function observerScript(
  selector: string,
  mark: string,
  durationMs: number
): string {
  return `(() => {
  const selector = ${JSON.stringify(selector)};
  const mark = ${JSON.stringify(mark)};
  const durationMs = ${durationMs};
  const video = document.querySelector('video.otio-program-video');
  if (!video) throw new Error('observer: program video missing');
  const view = document.querySelector('.otio-view');
  window.__primerPointer = window.__primerPointer || {};
  window.__primerObs = window.__primerObs || {};
  const frames = [];
  const buffering = [];
  let observing = durationMs > 0;
  let pointerAt = null;
  let restCurrentTime = null;
  const onFrame = (now, metadata) => {
    if (!observing) return;
    frames.push({
      now: now,
      mediaTime: metadata.mediaTime,
      currentTime: video.currentTime,
      expectedDisplayTime: metadata.expectedDisplayTime ?? null,
      presentationTime: metadata.presentationTime ?? null,
      presentedFrames: metadata.presentedFrames ?? null,
    });
    video.requestVideoFrameCallback(onFrame);
  };
  if (observing) video.requestVideoFrameCallback(onFrame);
  const mutations = view && observing ? new MutationObserver(() => buffering.push({ at: performance.now(), value: view.getAttribute('data-buffering') })) : null;
  if (mutations) mutations.observe(view, { attributes: true, attributeFilter: ['data-buffering'] });
  const observed = Promise.withResolvers();
  window.__primerObs[mark] = observed.promise;
  window.addEventListener('pointerdown', (event) => {
    if (pointerAt !== null) return;
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    if (!target) return;
    if (!event.isTrusted) { observed.reject(new Error('pointerdown on ' + mark + ' was not trusted')); return; }
    pointerAt = performance.now();
    restCurrentTime = video.currentTime;
    performance.mark(mark);
    window.__primerPointer[mark] = pointerAt;
    if (durationMs <= 0) { observed.resolve({ pointerAt: pointerAt, restCurrentTime: restCurrentTime }); return; }
    setTimeout(() => {
      observing = false;
      if (mutations) mutations.disconnect();
      observed.resolve({
        pointerAt: pointerAt,
        restCurrentTime: restCurrentTime,
        frames: frames.filter((f) => f.now >= pointerAt),
        buffering: buffering.filter((b) => b.at >= pointerAt),
      });
    }, durationMs);
  }, { capture: true });
})()`;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Rotates an arm list so each round starts at a different arm. */
function rotate<T>(items: readonly T[], round: number): T[] {
  const shift = round % items.length;
  return [...items.slice(shift), ...items.slice(0, shift)];
}

async function armPointer(
  page: ViewerPage,
  selector: string,
  mark: string,
  durationMs: number
): Promise<void> {
  await page.evaluate(observerScript(selector, mark, durationMs));
}

async function pointerObservation(
  page: ViewerPage,
  mark: string
): Promise<PointerObservation> {
  return page.evaluate<PointerObservation>(
    `window.__primerObs[${JSON.stringify(mark)}]`
  );
}

async function pointerTimes(page: ViewerPage): Promise<Record<string, number>> {
  return page.evaluate<Record<string, number>>('window.__primerPointer');
}

async function primerAttribute(page: ViewerPage): Promise<string | null> {
  return page.evaluate<string | null>(
    `document.querySelector('.otio-view')?.getAttribute(${JSON.stringify(PRIMER_ATTRIBUTE)}) ?? null`
  );
}

async function programState(page: ViewerPage): Promise<ProgramState> {
  return page.evaluate<ProgramState>(`(() => {
    const v = document.querySelector('video.otio-program-video');
    return { paused: v.paused, currentTime: v.currentTime, muted: v.muted };
  })()`);
}

/** Resolves when the program video reports metadata. Returns the wall time it was observed. */
async function waitForMetadata(page: ViewerPage): Promise<number> {
  await page.waitFor('program video metadata', async () =>
    (await page.evaluate<boolean>(
      `document.querySelector('video.otio-program-video')?.readyState >= 1`
    ))
      ? true
      : undefined
  );
  return Date.now();
}

/** Resolves once the viewer enables Play: the program is playable and a trusted Play can reach it. */
async function waitForPlayEnabled(page: ViewerPage): Promise<void> {
  await page.waitFor('play button enabled', async () =>
    (await page.evaluate<boolean>(
      `(() => { const play = document.querySelector('button.otio-play'); return play !== null && !play.disabled; })()`
    ))
      ? true
      : undefined
  );
}

async function waitForProgramState(page: ViewerPage): Promise<void> {
  await page.waitFor('program state', async () =>
    (await page.evaluate<string | null>(
      `document.querySelector('.otio-view')?.getAttribute('${VIEWER_CONTRACT.stateAttribute}') ?? null`
    )) === 'program'
      ? true
      : undefined
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copies bytes into a fresh ArrayBuffer. The copy is typed Uint8Array<ArrayBuffer>, which is what
 * Response bodies accept. A copy, not a cast: the bytes are unchanged and the buffer is owned.
 */
function ownedBytes(source: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(source.byteLength));
  copy.set(source);
  return copy;
}

/**
 * Runs before navigation, on the about:blank target, after the page exists. Starts the trace and
 * writes its start mark so that preload is inside the trace. Then two OS readings 250 ms apart
 * must both read idle on the same device. Returns the wall time, which starts the 30 s budget.
 */
async function beforeNavigation(
  page: ViewerPage,
  probe: DeviceProbe
): Promise<NavigationClock> {
  await page.startPerformanceTrace(PRIMER_TRACE_CATEGORIES);
  const traceStartWall = await page.evaluate<number>(
    `(() => { performance.mark(${JSON.stringify(TRACE_START_MARK)}); return Date.now(); })()`
  );
  const first = await readDeviceState(probe);
  await sleep(PRE_NAV_SPACING_MS);
  const second = await readDeviceState(probe);
  if (first.running || second.running)
    throw new Error(
      `external audio before navigation: ${second.name} is running`
    );
  if (first.deviceId !== second.deviceId)
    throw new Error(
      `external audio before navigation: default output changed from ${first.name} to ${second.name}`
    );
  return { loadedAt: Date.now(), traceStartWall };
}

/**
 * Sequence L. After metadata the output must first run, within LATE_RUNNING_LIMIT_MS, then read
 * idle on two consecutive polls, within DEVICE_IDLE_LIMIT_MS of load. A device change throws. A
 * missed pattern is recorded as a failure but the trial still runs, so its evidence is kept. The
 * idle pair is followed by a quiet settle and a fresh OS reading at the first trusted event.
 */
async function lateSettle(
  probe: DeviceProbe,
  loadedAt: number,
  metadataAt: number
): Promise<Settled> {
  const failures: string[] = [];
  const readings: WallReading[] = [];
  let device: number | null = null;
  let runningAt: number | null = null;
  let lastRunning: number | null = null;
  let priorIdle: number | null = null;
  let idleFirst: number | null = null;
  const deadline = loadedAt + DEVICE_IDLE_LIMIT_MS;
  for (;;) {
    const at = Date.now();
    const state = await readDeviceState(probe);
    readings.push({ wallMs: at, running: state.running });
    if (device === null) device = state.deviceId;
    else if (state.deviceId !== device)
      throw new Error(
        `default output changed to ${state.name} during the wait`
      );
    if (state.running) {
      runningAt ??= at;
      lastRunning = at;
      priorIdle = null;
    } else if (runningAt !== null) {
      if (priorIdle !== null) {
        idleFirst = priorIdle;
        break;
      }
      priorIdle = at;
    } else if (at - metadataAt >= LATE_RUNNING_LIMIT_MS) {
      failures.push(
        `default output not running within ${LATE_RUNNING_LIMIT_MS} ms after metadata`
      );
      break;
    }
    if (at >= deadline) break;
    await sleep(SETTLE_POLL_MS);
  }
  if (idleFirst !== null) await sleep(QUIET_SETTLE_MS);
  else if (runningAt !== null)
    failures.push(
      `default output not quiet within ${DEVICE_IDLE_LIMIT_MS / 1000} s of load`
    );
  else if (failures.length === 0)
    failures.push('default output never ran after metadata');
  const finalAt = Date.now();
  const state = await readDeviceState(probe);
  readings.push({ wallMs: finalAt, running: state.running });
  return {
    failures,
    hold: {
      runningAfterMetadataMs:
        runningAt === null ? null : runningAt - metadataAt,
      holdFromMs: lastRunning === null ? null : lastRunning - metadataAt,
      holdToMs: idleFirst === null ? null : idleFirst - metadataAt,
      idleAfterLoadMs: idleFirst === null ? null : idleFirst - loadedAt,
    },
    state,
    readings,
  };
}

/** Sequence F. No wait: the OS is read as telemetry and the trusted events follow metadata. */
async function freshSettle(probe: DeviceProbe): Promise<Settled> {
  return {
    failures: [],
    hold: null,
    state: await readDeviceState(probe),
    readings: [],
  };
}

/**
 * Video-only control. The file has no audio track, so the output must never run. The OS is read
 * for the same window sequence L allows a start in, and any running reading fails the control.
 * Nothing here waits for the output to start.
 */
async function absentSettle(
  probe: DeviceProbe,
  metadataAt: number
): Promise<Settled> {
  const failures: string[] = [];
  while (Date.now() - metadataAt < LATE_RUNNING_LIMIT_MS) {
    const seen = await readDeviceState(probe);
    if (seen.running) {
      failures.push(
        `video-only control: default output ${seen.name} ran with no audio track`
      );
      break;
    }
    await sleep(SETTLE_POLL_MS);
  }
  await sleep(QUIET_SETTLE_MS);
  return {
    failures,
    hold: null,
    state: await readDeviceState(probe),
    readings: [],
  };
}

/**
 * Chooses the OS wait for a bare arm. Sequence F reads only. Sequence L waits for the output
 * pattern, except video-only, which has no output to wait for and is judged as absent.
 */
async function bareSettle(
  sequence: Sequence,
  arm: BareArm,
  probe: DeviceProbe,
  loadedAt: number,
  metadataAt: number
): Promise<Settled> {
  if (sequence === 'fresh') return freshSettle(probe);
  if (arm === 'video-only') return absentSettle(probe, metadataAt);
  return lateSettle(probe, loadedAt, metadataAt);
}

/** The cold-state failures for a sequence L trial, read from its trace and its OS reading. */
function quietFailures(quiet: QuietWindow, state: DeviceState): string[] {
  const failures: string[] = [];
  if (!quiet.covered)
    failures.push(
      `trace does not cover ${QUIET_WINDOW_MS} ms before the first trusted event`
    );
  if (quiet.offending.length > 0)
    failures.push(
      `output device activity before the first trusted event: ${quiet.offending.join(', ')}`
    );
  if (state.running)
    failures.push(
      `default output ${state.name} running at the first trusted event`
    );
  return failures;
}

/** The earliest trace event with one of these names at or after fromTs. Null when none. */
function earliestAfter(
  events: readonly TraceEvent[],
  names: readonly string[],
  fromTs: number
): number | null {
  let best: number | null = null;
  for (const event of events) {
    if (!names.includes(event.name) || event.ts < fromTs) continue;
    if (best === null || event.ts < best) best = event.ts;
  }
  return best;
}

/** Device starts after Play that a sequence gates on. Null means reported only. */
function expectedDeviceStarts(
  sequence: Sequence,
  arm: ViewerArm
): number | null {
  if (arm !== 'first-click') return 0;
  return sequence === 'late' ? 1 : null;
}

interface Analysis {
  readonly coldness: Coldness;
  readonly pipelineResumed: boolean;
  readonly externalRunningMs: number | null;
  readonly dMs: number | null;
  readonly restCurrentTime: number | null;
  readonly startupMs: number | null;
  readonly gapsMs: readonly number[];
  /** Page times of the kept new frames, for windows judged from the same frames. */
  readonly keptMs: readonly number[];
  readonly quiet: QuietWindow;
  readonly creationBeforeTrusted: Record<string, number>;
  readonly deviceStartsAfterPlay: number;
  readonly callbackCount: number;
  readonly callbackExcessMs: number | null;
  readonly firstCallbackMs: number | null;
  readonly reported: Reported;
  readonly window: PrimerWindow;
  readonly failures: string[];
}

/**
 * One trace and one pointer observation become the window's evidence. A missing mark or trace
 * event is a recorded failure here, never a defaulted value.
 */
function analyse(
  events: readonly TraceEvent[],
  obs: PointerObservation,
  options: {
    firstClick: boolean;
    expectedDeviceStarts: number | null;
    osIdleAtTrusted: boolean;
    /** 'play' for bare arms, whose Prepare builds its own primer. 'first' for viewer arms. */
    resumeFrom: 'first' | 'play';
    /** The OS readings of this trial on the trace clock, for externalRunningMs. */
    osReadings: readonly OsReading[];
  }
): Analysis {
  const failures: string[] = [];
  const prepareTs = markTs(events, PREPARE_MARK);
  const playTs = markTs(events, PLAY_MARK);
  const firstTs = prepareTs ?? playTs;
  if (firstTs === null) failures.push('trace has no trusted pointerdown mark');
  for (const name of [PREPARE_MARK, PLAY_MARK, UNMUTE_MARK])
    failures.push(...markOrderFailures(events, name));

  const quiet: QuietWindow =
    firstTs === null
      ? { covered: false, offending: [] }
      : quietWindow(events, firstTs);
  const startsAfterTrusted =
    firstTs === null ? 0 : deviceStarts(events, firstTs);
  const resumeFromTs = options.resumeFrom === 'play' ? playTs : firstTs;
  const resumed =
    resumeFromTs !== null &&
    pipelineResumed(
      events,
      resumeFromTs,
      (playTs ?? resumeFromTs) + RESUME_WINDOW_US
    );
  const coldness = classifyColdness({
    quiet,
    osIdleAtTrusted: options.osIdleAtTrusted,
    startsAfterTrusted,
    resumed,
  });
  const external =
    firstTs === null
      ? null
      : externalRunningMs(events, options.osReadings, firstTs);
  const first = firstTs === null ? null : firstStart(events, firstTs);

  const restCurrentTime = obs.restCurrentTime ?? null;
  if (restCurrentTime === null)
    failures.push('no resting currentTime at the trusted Play');
  const fresh =
    restCurrentTime === null
      ? null
      : newFrames(obs.frames ?? [], restCurrentTime, PROGRAM.fps);
  if (fresh?.backward)
    failures.push('media time moved backward after the first new frame');
  const kept = fresh?.kept ?? [];
  const firstNew = fresh?.firstNew ?? null;
  const keptMs = kept.map((frame) => frame.now);
  const edges = windowEdgeGaps(
    keptMs,
    obs.pointerAt,
    obs.pointerAt + WINDOW_MS
  );
  const gapsMs = edges.gapsMs;
  const trailingGapMs = edges.trailingGapMs;
  const startupMs = firstNew === null ? null : firstNew.now - obs.pointerAt;
  const bufferingBeforeFirstFrame =
    options.firstClick && firstNew !== null
      ? (obs.buffering ?? []).some(
          (b) => b.value === 'true' && b.at < firstNew.now
        )
      : null;

  const playedAfter = playTs === null ? 0 : deviceStarts(events, playTs);
  const callbackTs =
    playTs === null
      ? []
      : deviceCallbacks(events, playTs, playTs + WINDOW_MS * 1000);
  const firstCallback = callbackTs[0];
  const firstCallbackMs =
    firstCallback === undefined || playTs === null
      ? null
      : (firstCallback - playTs) / 1000;

  const traceStart = markTs(events, TRACE_START_MARK);
  const deviceAt =
    traceStart === null
      ? null
      : earliestAfter(events, [DEVICE_START_EVENT], traceStart);
  const creationAt =
    traceStart === null
      ? null
      : earliestAfter(events, [...STREAM_CREATION_EVENTS], traceStart);
  const trustedDeviceAt =
    firstTs === null
      ? null
      : earliestAfter(events, [DEVICE_START_EVENT], firstTs);

  return {
    coldness,
    pipelineResumed: resumed,
    externalRunningMs: external,
    dMs: first?.dMs ?? null,
    restCurrentTime,
    startupMs,
    gapsMs,
    keptMs,
    quiet,
    creationBeforeTrusted:
      firstTs === null ? {} : creationCounts(events, 0, firstTs - 1),
    deviceStartsAfterPlay: playedAfter,
    callbackCount: callbackTs.length,
    callbackExcessMs: deviceExcessMs(callbackTs),
    firstCallbackMs,
    reported: {
      firstDeviceStartFromTraceStartMs:
        traceStart === null || deviceAt === null
          ? null
          : (deviceAt - traceStart) / 1000,
      firstCreationFromTraceStartMs:
        traceStart === null || creationAt === null
          ? null
          : (creationAt - traceStart) / 1000,
      firstDeviceStartFromTrustedMs:
        firstTs === null || trustedDeviceAt === null
          ? null
          : (trustedDeviceAt - firstTs) / 1000,
      bufferingBeforeFirstFrame,
    },
    window: {
      startupMs,
      gapsMs,
      trailingGapMs,
      bufferingBeforeFirstFrame,
      deviceStarts: playedAfter,
      expectedDeviceStarts: options.expectedDeviceStarts,
      firstClick: options.firstClick,
    },
    failures,
  };
}

/** Sham check: the muted primer must not start the output between Prepare and Play. */
function shamTrialFailures(events: readonly TraceEvent[]): string[] {
  const prepareTs = markTs(events, PREPARE_MARK);
  const playTs = markTs(events, PLAY_MARK);
  if (prepareTs === null || playTs === null)
    return ['sham control has no Prepare or Play mark'];
  return deviceStarts(events, prepareTs, playTs - 1) === 0
    ? []
    : ['sham started the output device before Play; control invalid'];
}

/** One presented frame for the bare gate. Both times are page milliseconds. */
interface BareFrame {
  readonly now: number;
  readonly mediaTime: number;
  readonly presentationTime: number | null;
}

interface BareMeasureInput {
  /** New frames in order from newFrames. Their presentation times are the presentation evidence. */
  readonly kept: readonly BareFrame[];
  readonly pointerAt: number;
  /** Page times of the display-tick writes, or null when the page reported no log. */
  readonly ticksMs: readonly number[] | null;
  readonly windowMs: number;
  readonly fps: number;
}

/** What one bare window showed. Null means the evidence is missing, never a defaulted value. */
export interface BareEvidence {
  readonly keptFrames: number;
  /** Reported only, never gating. The user's p95 budget gates through gatePrimerWindow. */
  readonly presentationP95Ms: number | null;
  /** Largest presented gap, with the trailing gap to the window end included. */
  readonly presentationMaxGapMs: number | null;
  /** From the last presented frame to the window end. Null when no frame was presented. */
  readonly presentationTrailingGapMs: number | null;
  readonly presentationMissing: boolean;
  /** Program frame slots skipped by presented gaps, window end included. */
  readonly missedSlots: number;
  /** Presented span minus media span over the kept frames, in ms. Null without presentation evidence. */
  readonly netSlipMs: number | null;
  /** Median interval between display-tick writes. Reported, never gating. */
  readonly tickPeriodMs: number | null;
  /** Share of frames within half a tick of the median offset. Reported, never gating. */
  readonly tickClassShare: number | null;
  readonly droppedFrames: number;
  readonly tickCount: number;
  readonly tickMaxGapMs: number | null;
  /** At least one missed program frame slot, window end included. Measured in this trial, never assumed. */
  readonly stalled: boolean;
}

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Measures one window from presented frames and the page's tick log. Pure: no browser. */
export function measureBare(input: BareMeasureInput): BareEvidence {
  const presentation = input.kept.map((frame) => frame.presentationTime);
  const presentationMissing = presentation.some((time) => time === null);
  const presented = presentation.filter(
    (time): time is number => time !== null
  );
  const presentedIntervals = presentationMissing ? [] : intervals(presented);
  const end = input.pointerAt + input.windowMs;
  // A stall that runs to the window end has no later frame to show it, so the trailing gap counts.
  const trailingGapMs =
    presentationMissing || presented.length === 0
      ? null
      : end - presented[presented.length - 1]!;
  const presentedGaps =
    trailingGapMs === null
      ? presentedIntervals
      : [...presentedIntervals, trailingGapMs];
  const missed = missedSlots(presentedGaps, input.fps);
  // Presented span minus media span over the kept frames: a clock running slow or fast shows here.
  const netSlipMs =
    presentationMissing || input.kept.length < 2
      ? null
      : presented[presented.length - 1]! -
        presented[0]! -
        (input.kept[input.kept.length - 1]!.mediaTime -
          input.kept[0]!.mediaTime) *
          1000;

  const offsets: number[] = [];
  for (const frame of input.kept)
    if (frame.presentationTime !== null)
      offsets.push(frame.now - frame.presentationTime);

  const ticks =
    input.ticksMs === null
      ? null
      : input.ticksMs.filter((t) => t >= input.pointerAt && t <= end);
  const tickPeriodMs =
    ticks !== null && ticks.length >= 3 ? medianOf(intervals(ticks)) : null;
  const center = medianOf(offsets);
  const tickClassShare =
    tickPeriodMs === null || center === null || offsets.length === 0
      ? null
      : offsets.filter((o) => Math.abs(o - center) < tickPeriodMs / 2).length /
        offsets.length;

  let droppedFrames = 0;
  for (let i = 1; i < input.kept.length; i++) {
    const steps = Math.round(
      (input.kept[i]!.mediaTime - input.kept[i - 1]!.mediaTime) * input.fps
    );
    droppedFrames += Math.max(0, steps - 1);
  }

  const tickStamps = ticks === null ? [] : [input.pointerAt, ...ticks, end];
  return {
    keptFrames: input.kept.length,
    presentationP95Ms: p95(presentedIntervals),
    presentationMaxGapMs: maxOf(presentedGaps),
    presentationTrailingGapMs: trailingGapMs,
    presentationMissing,
    tickPeriodMs,
    tickClassShare,
    droppedFrames,
    tickCount: ticks?.length ?? 0,
    tickMaxGapMs: ticks === null ? null : maxOf(intervals(tickStamps)),
    missedSlots: missed,
    netSlipMs,
    stalled: missed > 0,
  };
}

export interface BareRules {
  readonly label: string;
  /**
   * Late av and av-blob: frame count, missed program frame slots, net slip and dropped frames, window
   * end included. Every bare trial always needs its presented frames, presentation times and tick.
   */
  readonly presentationGate: boolean;
}

/** The bare trial gate. Every failure it returns fails the trial. */
export function bareFailures(e: BareEvidence, rules: BareRules): string[] {
  const label = rules.label;
  const failures: string[] = [];
  if (e.keptFrames === 0)
    failures.push(
      `${label}: no presented frame in the window; presentation evidence missing`
    );
  if (e.tickCount === 0)
    failures.push(`${label}: no display tick during the window (tick missing)`);
  else if (e.tickMaxGapMs !== null && e.tickMaxGapMs > GAP_BUDGET_MS)
    failures.push(
      `${label}: display tick stalled for ${e.tickMaxGapMs.toFixed(1)} ms > ${GAP_BUDGET_MS} ms`
    );
  if (e.presentationMissing)
    failures.push(`${label}: presented frame without presentation time`);
  if (rules.presentationGate) {
    if (e.keptFrames - 1 < MIN_WINDOW_INTERVALS)
      failures.push(
        `${label}: only ${e.keptFrames} presented frames, need ${MIN_WINDOW_INTERVALS + 1}`
      );
    if (e.droppedFrames > 0)
      failures.push(
        `${label}: ${e.droppedFrames} program frame(s) dropped between presented frames`
      );
    if (e.stalled)
      failures.push(
        `${label}: ${e.missedSlots} missed program frame slot(s): presented gap ${(e.presentationMaxGapMs ?? 0).toFixed(1)} ms, window end included`
      );
    if (e.netSlipMs !== null && Math.abs(e.netSlipMs) >= 500 / PROGRAM.fps)
      failures.push(
        `${label}: presentation slipped ${e.netSlipMs.toFixed(1)} ms against media time over the window, half a program frame is ${(500 / PROGRAM.fps).toFixed(1)} ms`
      );
  }
  return failures;
}

/** A cold none or sham trial as the pool sees it. */
type ColdPoolTrial = Pick<PrimerTrial, 'round' | 'arm' | 'bare'>;

/**
 * Per-trial check for the cold bare none and sham controls. Each cold trial must have presented
 * frames with presentation times, and must miss at least one program frame slot, window end
 * included. A trial that misses none did not fail the way the hypothesis predicts. The injected
 * stalls in bareControlFailures prove the detector itself fires.
 */
export function coldStallComparator(
  trials: readonly ColdPoolTrial[]
): string[] {
  const failures: string[] = [];
  for (const trial of trials) {
    const bare = trial.bare;
    if (bare === null || bare.keptFrames === 0 || bare.presentationMissing)
      failures.push(
        `round ${trial.round} ${trial.arm}: cold control has no presentation evidence`
      );
    else if (!bare.stalled)
      failures.push(
        `round ${trial.round} ${trial.arm}: cold control missed no program frame slot (largest presented gap ${(bare.presentationMaxGapMs ?? 0).toFixed(1)} ms, window end included)`
      );
  }
  return failures;
}

/** Synthetic window for the negative controls: pointer at 1000 ms, a 4 s window at 30 fps. */
const SYNTH_POINTER_MS = 1000;
const SYNTH_END_MS = SYNTH_POINTER_MS + WINDOW_MS;
const SYNTH_FRAME_MS = 1000 / PROGRAM.fps;
const SYNTH_TICK_MS = 1000 / 120;

interface SyntheticFrames {
  readonly count?: number;
  readonly intervalMs?: (i: number) => number;
  readonly mediaSteps?: (i: number) => number;
  readonly offsetMs?: (i: number) => number;
  readonly presentation?: boolean;
}

function syntheticFrames(spec: SyntheticFrames): BareFrame[] {
  const frames: BareFrame[] = [];
  let presented = SYNTH_POINTER_MS + 20;
  let media = 0;
  for (let i = 0; i < (spec.count ?? 120); i++) {
    if (i > 0) {
      presented += spec.intervalMs?.(i) ?? SYNTH_FRAME_MS;
      // The observer records only frames presented inside the window.
      if (presented > SYNTH_END_MS) break;
      media += (spec.mediaSteps?.(i) ?? 1) / PROGRAM.fps;
    }
    frames.push({
      now: presented + (spec.offsetMs?.(i) ?? 3),
      mediaTime: media,
      presentationTime: spec.presentation === false ? null : presented,
    });
  }
  return frames;
}

/** Display ticks every SYNTH_TICK_MS across the window, skipping an optional hole. */
function syntheticTicks(hole?: { fromMs: number; lengthMs: number }): number[] {
  const ticks: number[] = [];
  for (
    let t = SYNTH_POINTER_MS + SYNTH_TICK_MS;
    t <= SYNTH_END_MS;
    t += SYNTH_TICK_MS
  ) {
    if (hole && t >= hole.fromMs && t < hole.fromMs + hole.lengthMs) continue;
    ticks.push(t);
  }
  return ticks;
}

/**
 * Behavioural negative controls, run on every proof. Each window carries one defect the gate must
 * reject, or one shape it must accept. Each window keeps every other measure within budget, so the
 * named rule alone decides it: the held-frame and slow-clock windows are rejected only by missed
 * slots and net slip, and the judder and extreme windows are accepted. The comparator cases check the
 * stall detector on injected stalls, on the observed 66.8 ms cold gap, on a healthy 38.9 ms gap and
 * on a stall that runs to the window end. The pool cases check the per-trial cold comparator.
 * Returns every control the gate got wrong. The stage fails on any entry.
 */
export function bareControlFailures(): string[] {
  const measure = (kept: BareFrame[], ticks: number[] | null) =>
    measureBare({
      kept,
      pointerAt: SYNTH_POINTER_MS,
      ticksMs: ticks,
      windowMs: WINDOW_MS,
      fps: PROGRAM.fps,
    });
  const midStallFrames = (ms: number) =>
    syntheticFrames({ intervalMs: (i) => (i === 60 ? ms : SYNTH_FRAME_MS) });
  const full = syntheticTicks();
  const gated: BareRules = { label: 'control', presentationGate: true };
  const ungated: BareRules = { label: 'control', presentationGate: false };
  const cases: Array<{
    name: string;
    evidence: BareEvidence;
    rules: BareRules;
    accept: boolean;
  }> = [
    {
      name: 'steady presentation with a display tick',
      evidence: measure(syntheticFrames({}), full),
      rules: gated,
      accept: true,
    },
    {
      name: 'missing tick log',
      evidence: measure(syntheticFrames({}), null),
      rules: gated,
      accept: false,
    },
    {
      name: 'tick loop never wrote',
      evidence: measure(syntheticFrames({}), []),
      rules: gated,
      accept: false,
    },
    {
      name: 'stalled tick loop',
      evidence: measure(
        syntheticFrames({}),
        syntheticTicks({ fromMs: 2000, lengthMs: 150 })
      ),
      rules: gated,
      accept: false,
    },
    {
      name: 'dropped program frame',
      evidence: measure(
        syntheticFrames({
          intervalMs: (i) => (i === 50 ? 2 * SYNTH_FRAME_MS : SYNTH_FRAME_MS),
          mediaSteps: (i) => (i === 50 ? 2 : 1),
        }),
        full
      ),
      rules: gated,
      accept: false,
    },
    {
      name: 'stalled playback mid-window',
      evidence: measure(midStallFrames(150), full),
      rules: gated,
      accept: false,
    },
    {
      name: 'presentation stops before the window end',
      evidence: measure(syntheticFrames({ count: 93 }), full),
      rules: gated,
      accept: false,
    },
    {
      name: 'callback offsets split across tick classes',
      evidence: measure(
        syntheticFrames({
          offsetMs: (i) => 3 + [-SYNTH_TICK_MS, 0, SYNTH_TICK_MS][i % 3]!,
        }),
        full
      ),
      rules: gated,
      accept: true,
    },
    {
      name: 'held frame then catch-up',
      evidence: measure(
        syntheticFrames({
          intervalMs: (i) =>
            i === 60 ? 66.7 : i === 61 || i === 62 ? 16.7 : SYNTH_FRAME_MS,
        }),
        full
      ),
      rules: gated,
      accept: false,
    },
    {
      name: 'slow program clock',
      evidence: measure(syntheticFrames({ intervalMs: () => 35 }), full),
      rules: gated,
      accept: false,
    },
    {
      name: 'judder inside one slot',
      evidence: measure(
        syntheticFrames({
          intervalMs: (i) =>
            i % 10 === 5 ? 41.7 : i % 10 === 6 ? 25 : SYNTH_FRAME_MS,
        }),
        full
      ),
      rules: gated,
      accept: true,
    },
    {
      name: 'measured healthy extremes',
      evidence: measure(
        syntheticFrames({
          intervalMs: (i) =>
            i === 1
              ? SYNTH_FRAME_MS - 8.5
              : i === 60
                ? 38.9
                : i === 61
                  ? 2 * SYNTH_FRAME_MS - 38.9
                  : SYNTH_FRAME_MS,
        }),
        full
      ),
      rules: gated,
      accept: true,
    },
    {
      name: 'too few presented frames',
      evidence: measure(syntheticFrames({ count: 40 }), full),
      rules: gated,
      accept: false,
    },
    {
      name: 'presentation time missing',
      evidence: measure(syntheticFrames({ presentation: false }), full),
      rules: ungated,
      accept: false,
    },
    {
      name: 'no presented frame',
      evidence: measure(syntheticFrames({ count: 0 }), full),
      rules: ungated,
      accept: false,
    },
    {
      name: 'cold trial with a 66.8 ms gap is not a per-trial failure',
      evidence: measure(midStallFrames(66.8), full),
      rules: ungated,
      accept: true,
    },
    {
      name: 'cold trial with a 150 ms gap is not a per-trial failure',
      evidence: measure(midStallFrames(150), full),
      rules: ungated,
      accept: true,
    },
    {
      name: 'cold trial stopping before the window end is not a per-trial failure',
      evidence: measure(syntheticFrames({ count: 93 }), full),
      rules: ungated,
      accept: true,
    },
    {
      name: 'cold trial with a missing tick log',
      evidence: measure(syntheticFrames({}), null),
      rules: ungated,
      accept: false,
    },
  ];
  const comparator: Array<{
    name: string;
    evidence: BareEvidence;
    stalled: boolean;
  }> = [
    {
      name: 'injected 150 ms presented stall',
      evidence: measure(midStallFrames(150), full),
      stalled: true,
    },
    {
      name: 'injected 300 ms presented stall',
      evidence: measure(midStallFrames(300), full),
      stalled: true,
    },
    {
      name: 'observed 66.8 ms cold gap',
      evidence: measure(midStallFrames(66.8), full),
      stalled: true,
    },
    {
      name: 'measured healthy extreme: a 38.9 ms gap',
      evidence: measure(midStallFrames(38.9), full),
      stalled: false,
    },
    {
      name: 'stall that runs to the window end',
      evidence: measure(syntheticFrames({ count: 93 }), full),
      stalled: true,
    },
    {
      name: 'clean presentation',
      evidence: measure(syntheticFrames({}), full),
      stalled: false,
    },
    {
      name: 'presentation time missing',
      evidence: measure(syntheticFrames({ presentation: false }), full),
      stalled: false,
    },
  ];
  const pools: Array<{
    name: string;
    trials: ColdPoolTrial[];
    accept: boolean;
  }> = [
    {
      name: 'one cold trial missed no slot',
      trials: [
        { round: 0, arm: 'none', bare: measure(midStallFrames(150), full) },
        { round: 0, arm: 'sham', bare: measure(syntheticFrames({}), full) },
      ],
      accept: false,
    },
    {
      name: 'every cold trial missed a slot',
      trials: [
        { round: 0, arm: 'none', bare: measure(midStallFrames(66.8), full) },
        { round: 0, arm: 'sham', bare: measure(midStallFrames(150), full) },
      ],
      accept: true,
    },
    {
      name: 'pool with a stall to the window end',
      trials: [
        {
          round: 0,
          arm: 'none',
          bare: measure(syntheticFrames({ count: 93 }), full),
        },
      ],
      accept: true,
    },
    {
      name: 'pool with no measured stall',
      trials: [
        { round: 0, arm: 'none', bare: measure(syntheticFrames({}), full) },
        { round: 1, arm: 'sham', bare: measure(syntheticFrames({}), full) },
      ],
      accept: false,
    },
    {
      name: 'pool with a trial lacking presentation evidence',
      trials: [
        { round: 0, arm: 'none', bare: null },
        { round: 1, arm: 'sham', bare: measure(midStallFrames(150), full) },
      ],
      accept: false,
    },
    {
      name: 'pool with a trial that presented no frame',
      trials: [
        {
          round: 0,
          arm: 'none',
          bare: measure(syntheticFrames({ count: 0 }), full),
        },
        { round: 1, arm: 'sham', bare: measure(midStallFrames(150), full) },
      ],
      accept: false,
    },
    {
      name: 'empty pool is left to the inconclusive check',
      trials: [],
      accept: true,
    },
  ];
  const failures: string[] = [];
  for (const c of cases) {
    const reasons = bareFailures(c.evidence, c.rules);
    if (c.accept && reasons.length > 0)
      failures.push(
        `negative control "${c.name}": rejected a valid window: ${reasons.join('; ')}`
      );
    if (!c.accept && reasons.length === 0)
      failures.push(
        `negative control "${c.name}": accepted a window it must reject`
      );
  }
  for (const c of comparator)
    if (c.evidence.stalled !== c.stalled)
      failures.push(
        `stall comparator "${c.name}": measured stalled=${c.evidence.stalled}, expected ${c.stalled}`
      );
  for (const c of pools) {
    const reasons = coldStallComparator(c.trials);
    if (c.accept && reasons.length > 0)
      failures.push(
        `pool control "${c.name}": rejected a valid pool: ${reasons.join('; ')}`
      );
    if (!c.accept && reasons.length === 0)
      failures.push(`pool control "${c.name}": accepted a pool it must reject`);
  }
  return failures;
}

function trialOf(
  sequence: Sequence,
  arm: string,
  round: number,
  analysis: Analysis,
  extra: readonly string[],
  settled: Settled
): PrimerTrial {
  const edgeGapsMs =
    analysis.window.trailingGapMs === null
      ? []
      : [analysis.window.trailingGapMs];
  const gapsWithEdge = [...analysis.gapsMs, ...edgeGapsMs];
  return {
    arm,
    round,
    sequence,
    coldness: analysis.coldness,
    pipelineResumed: analysis.pipelineResumed,
    externalRunningMs: analysis.externalRunningMs,
    dMs: analysis.dMs,
    startupMs: analysis.startupMs,
    maxGapMs: maxOf(gapsWithEdge),
    p95GapMs: p95(gapsWithEdge),
    intervals: analysis.gapsMs.length,
    deviceStartsAfterPlay: analysis.deviceStartsAfterPlay,
    settle: settled.hold,
    osIdleAtTrusted: !settled.state.running,
    restCurrentTime: analysis.restCurrentTime,
    quiet: analysis.quiet,
    creationBeforeTrusted: analysis.creationBeforeTrusted,
    reported: analysis.reported,
    callbackTelemetry: {
      count: analysis.callbackCount,
      excessMs: analysis.callbackExcessMs,
      firstCallbackMs: analysis.firstCallbackMs,
    },
    bare: null,
    failures: [...analysis.failures, ...extra],
  };
}

async function writeReceipt(
  scratch: string,
  name: string,
  value: unknown
): Promise<void> {
  await writeFile(join(scratch, name), JSON.stringify(value));
}

/** The blob source is set asynchronously after the SHA-256 check. Wait until it is attached. */
async function waitForBlobSource(page: ViewerPage): Promise<void> {
  await page.waitFor('blob source attached', async () =>
    (await page.evaluate<boolean>(
      `document.querySelector('video.otio-program-video')?.src.startsWith('blob:') === true || window.__barePlayError != null`
    ))
      ? true
      : undefined
  );
  const failure = await page.evaluate<string | null>(
    'window.__barePlayError ?? null'
  );
  assert.equal(failure, null, `blob source failed: ${failure}`);
}

/**
 * The build that answered this trial's JavaScript requests must be exactly the arm's build. A
 * sham trial served from production, or a production trial served from the sham, is a failure.
 */
function servedFailures(input: PrimerProofInput, arm: ViewerArm): string[] {
  const expected =
    arm === 'sham' ? input.shamBuild.name : input.productionBuild.name;
  const served = input.router.servedBuilds();
  return served.length === 1 && served[0] === expected
    ? []
    : [`served builds ${JSON.stringify(served)}, expected only ${expected}`];
}

/**
 * Null when the hidden leg is proven: the viewer is hidden, a visibility change to hidden was
 * logged before the freeze, and the primer read idle within the budget of that change. Otherwise
 * the reason, which the trial reports as an unproven hidden leg.
 */
function hiddenLegFailure(result: HideLog): string | null {
  if (result.visibility !== 'hidden')
    return `visibility reads ${result.visibility}`;
  const minimized = result.events.find((e) => e.kind === 'minimize-sent');
  const hidden = result.events.find(
    (e) => e.kind === 'visibilitychange' && e.value === 'hidden'
  );
  if (!minimized || !hidden || hidden.at < minimized.at)
    return 'no visibilitychange to hidden logged after the owned window was minimized';
  const idle = result.events.find(
    (e) => e.kind === 'primer' && e.value === 'idle' && e.at >= hidden.at
  );
  if (!idle) return 'primer never read idle after the hidden event';
  if (idle.at - hidden.at > HIDDEN_IDLE_BUDGET_MS)
    return `primer read idle ${Math.round(idle.at - hidden.at)} ms after the hidden event, budget ${HIDDEN_IDLE_BUDGET_MS} ms`;
  return null;
}

/** Bare arm: fresh browser, Prepare, 1500 ms, then trusted Play. Receipts stay in scratch. */
async function runBareTrial(
  sequence: Sequence,
  arm: BareArm,
  round: number,
  origin: string,
  scratch: string,
  probe: DeviceProbe
): Promise<PrimerTrial> {
  let loadedAt = 0;
  let traceStartWall = 0;
  const page = await openViewer({
    url: `${origin}/?arm=${arm}`,
    origin,
    sessionToken: 'primer-bare',
    beforeNavigate: async (target) => {
      const nav = await beforeNavigation(target, probe);
      loadedAt = nav.loadedAt;
      traceStartWall = nav.traceStartWall;
    },
  });
  try {
    if (arm === 'av-blob') await waitForBlobSource(page);
    const metadataAt = await waitForMetadata(page);
    const settled = await bareSettle(
      sequence,
      arm,
      probe,
      loadedAt,
      metadataAt
    );
    await armPointer(page, 'button.otio-prepare', PREPARE_MARK, 0);
    await page.click('button.otio-prepare');
    await sleep(BARE_PREPARE_WAIT_MS);
    await armPointer(page, 'button.otio-play', PLAY_MARK, WINDOW_MS);
    await page.click('button.otio-play');
    const obs = await pointerObservation(page, PLAY_MARK);
    const report = await page.evaluate<BareReport>('window.__primerReport()');
    const ticksMs = await page.evaluate<number[] | null>(
      'window.__primerTickLog ?? null'
    );
    const blobError = await page.evaluate<string | null>(
      'window.__barePlayError ?? null'
    );
    const done = await page.stopPerformanceTrace();
    const events = done.events as TraceEvent[];
    const primerArm = PRIMER_BARE_ARMS.includes(arm);
    const analysis = analyse(events, obs, {
      firstClick: false,
      expectedDeviceStarts: primerArm ? 0 : null,
      osIdleAtTrusted: !settled.state.running,
      resumeFrom: 'play',
      osReadings: osReadingsOnTrace(settled.readings, events, traceStartWall),
    });
    const rest = obs.restCurrentTime ?? null;
    const evidence = measureBare({
      kept:
        rest === null
          ? []
          : newFrames(obs.frames ?? [], rest, PROGRAM.fps).kept,
      pointerAt: obs.pointerAt,
      ticksMs,
      windowMs: WINDOW_MS,
      fps: PROGRAM.fps,
    });
    const extra: string[] = [];
    if (done.truncated) extra.push('trace truncated: window is incomplete');
    if (report.error) extra.push(`bare play failed: ${report.error}`);
    if (blobError) extra.push(`blob source failed: ${blobError}`);
    if (sequence === 'late') {
      extra.push(...settled.failures);
      extra.push(...quietFailures(analysis.quiet, settled.state));
      if (arm === 'sham') extra.push(...shamTrialFailures(events));
      if (arm === 'video-only') {
        const traceStart = markTs(events, TRACE_START_MARK);
        const starts =
          traceStart === null ? null : deviceStarts(events, traceStart);
        if (starts === null)
          extra.push('video-only control has no trace start mark');
        else if (starts !== 0)
          extra.push(
            `video-only control started the output device ${starts} time(s)`
          );
      }
      if (primerArm) extra.push(...gatePrimerWindow(analysis.window));
      extra.push(
        ...bareFailures(evidence, {
          label: arm,
          presentationGate: primerArm,
        })
      );
    }
    const trial: PrimerTrial = {
      ...trialOf(sequence, arm, round, analysis, extra, settled),
      bare: evidence,
    };
    await writeReceipt(
      scratch,
      `primer-bare-${sequence}-${arm}-${round}.json`,
      {
        trial,
        obs,
        report,
        clockDeficit: clockDeficitSummary(obs.frames ?? []),
        trace: done,
      }
    );
    console.log(`OTIO_PRIMER_TRIAL ${JSON.stringify(trial)}`);
    return trial;
  } finally {
    await page.close();
  }
}

/** Viewer arm: one fresh browser on the real viewer, with the production or sham build installed. */
async function runViewerTrial(
  sequence: Sequence,
  arm: ViewerArm,
  round: number,
  input: PrimerProofInput
): Promise<{ trial: PrimerTrial; visibility: string | null }> {
  const sessionToken = await input.harness.createSession();
  input.router.resetServed();
  let loadedAt = 0;
  let traceStartWall = 0;
  const page = await openViewer({
    url: input.shareUrl,
    origin: input.harness.origin,
    sessionToken,
    instrumentEmits: true,
    beforeNavigate: async (target) => {
      const nav = await beforeNavigation(target, input.deviceProbe);
      loadedAt = nav.loadedAt;
      traceStartWall = nav.traceStartWall;
    },
  });
  try {
    await waitForProgramState(page);
    const metadataAt = await waitForMetadata(page);
    await waitForPlayEnabled(page);
    const late = sequence === 'late';
    const settled = late
      ? await lateSettle(input.deviceProbe, loadedAt, metadataAt)
      : await freshSettle(input.deviceProbe);
    const extra: string[] = [...servedFailures(input, arm)];
    if (late) extra.push(...settled.failures);
    // Before the first trusted event: primer idle, program paused and not moving.
    const primerBefore = await primerAttribute(page);
    const restBefore = await programState(page);
    if (primerBefore !== 'idle')
      extra.push(`primer is ${primerBefore} before the first trusted event`);
    if (!restBefore.paused)
      extra.push('program was playing before the first trusted event');

    if (arm !== 'first-click') {
      // Prepared, sham and unmute: one genuine earlier interaction arms the primer.
      const control = arm === 'unmute' ? MUTE_CONTROL : MARKERS_TAB;
      if (arm === 'unmute') {
        const before = await page.evaluate<string | null>(MUTE_PRESSED);
        if (before !== 'false')
          extra.push(`mute control aria-pressed is ${before} before Mute`);
      }
      await armPointer(page, control, PREPARE_MARK, 0);
      await page.click(control);
      try {
        await page.waitFor(
          'primer running after the trusted interaction',
          async () =>
            (await primerAttribute(page)) === 'running' ? true : undefined,
          3000
        );
      } catch (error) {
        extra.push(messageOf(error));
      }
      if (arm === 'unmute') {
        try {
          await page.waitFor(
            'mute control aria-pressed true',
            async () =>
              (await page.evaluate<string | null>(MUTE_PRESSED)) === 'true'
                ? true
                : undefined,
            MUTE_PRESS_BUDGET_MS
          );
        } catch (error) {
          extra.push(messageOf(error));
        }
        try {
          await page.waitFor(
            'program muted after the Mute click',
            async () => ((await programState(page)).muted ? true : undefined),
            2000
          );
        } catch (error) {
          extra.push(messageOf(error));
        }
      }
    }
    const restAtPlay = await programState(page);
    if (!restAtPlay.paused || restAtPlay.currentTime !== restBefore.currentTime)
      extra.push('program moved before Play');

    await armPointer(page, 'button.otio-play', PLAY_MARK, WINDOW_MS);
    if (arm === 'unmute') await armPointer(page, MUTE_CONTROL, UNMUTE_MARK, 0);
    await page.click('button.otio-play');
    if (arm === 'unmute') {
      await sleep(UNMUTE_DELAY_MS);
      await page.click(MUTE_CONTROL);
      try {
        await page.waitFor(
          'mute control aria-pressed false',
          async () =>
            (await page.evaluate<string | null>(MUTE_PRESSED)) === 'false'
              ? true
              : undefined,
          MUTE_PRESS_BUDGET_MS
        );
      } catch (error) {
        extra.push(messageOf(error));
      }
      try {
        await page.waitFor(
          'program unmuted',
          async () => ((await programState(page)).muted ? undefined : true),
          UNMUTE_MUTED_BUDGET_MS
        );
      } catch {
        extra.push(
          `program still muted ${UNMUTE_MUTED_BUDGET_MS} ms after Unmute`
        );
      }
    }
    const obs = await pointerObservation(page, PLAY_MARK);
    const unmuteAt =
      arm === 'unmute' ? (await pointerTimes(page))[UNMUTE_MARK] : undefined;
    const emitKinds = await page.evaluate<string[] | null>(
      'Array.isArray(window.__relicProofEmits) ? window.__relicProofEmits.map((e) => e.kind) : null'
    );
    const done = await page.stopPerformanceTrace();
    if (done.truncated) extra.push('trace truncated: window is incomplete');
    const events = done.events as TraceEvent[];

    const analysis = analyse(events, obs, {
      firstClick: arm === 'first-click',
      expectedDeviceStarts: expectedDeviceStarts(sequence, arm),
      osIdleAtTrusted: !settled.state.running,
      resumeFrom: 'first',
      osReadings: osReadingsOnTrace(settled.readings, events, traceStartWall),
    });
    if (late) extra.push(...quietFailures(analysis.quiet, settled.state));
    if (arm === 'sham' && late) extra.push(...shamTrialFailures(events));
    if (arm === 'prepared' || arm === 'first-click')
      // Sequence F gates the user budgets only. Buffering is reported there, not gated.
      extra.push(
        ...gatePrimerWindow(
          late ? analysis.window : { ...analysis.window, firstClick: false }
        )
      );
    if (arm === 'unmute') {
      if (unmuteAt === undefined) {
        extra.push('no Unmute pointer mark');
      } else {
        const edges = windowEdgeGaps(
          analysis.keptMs,
          unmuteAt - UNMUTE_WINDOW_BEFORE_MS,
          unmuteAt + UNMUTE_WINDOW_AFTER_MS
        );
        extra.push(
          ...gateGaps(
            edges.gapsMs,
            MIN_UNMUTE_INTERVALS,
            'unmute window',
            [edges.leadingGapMs, edges.trailingGapMs].filter(
              (gap): gap is number => gap !== null
            )
          )
        );
      }
      if (analysis.deviceStartsAfterPlay !== 0)
        extra.push(
          `${analysis.deviceStartsAfterPlay} device start(s) after Play, expected 0`
        );
    }
    if (arm === 'first-click') {
      const kinds = emitKinds ?? [];
      if (!kinds.includes('session') || !kinds.includes('player'))
        extra.push('instrumented emits missing session or player');
    }

    // Hidden leg, sequence F only: the primer must stop when the viewer is hidden. It is proven or
    // it fails. Headless may keep the viewer visible, in which case the leg is unproven.
    let visibility: string | null = null;
    let hidden: HideLog | null = null;
    if (sequence === 'fresh' && arm === 'prepared' && round === 0) {
      hidden = await page.hideViewer();
      const reason = hiddenLegFailure(hidden);
      if (reason === null) {
        visibility = 'hidden';
      } else {
        visibility = `unproven: ${reason}`;
        extra.push(`hidden leg unproven: ${reason}`);
      }
    }

    const trial = trialOf(sequence, arm, round, analysis, extra, settled);
    await writeReceipt(
      input.scratch,
      `primer-viewer-${sequence}-${arm}-${round}.json`,
      {
        trial,
        obs,
        trace: done,
        unmuteAt: unmuteAt ?? null,
        hidden,
        clockDeficit: clockDeficitSummary(obs.frames ?? []),
      }
    );
    console.log(`OTIO_PRIMER_TRIAL ${JSON.stringify(trial)}`);
    return { trial, visibility };
  } finally {
    await page.close();
  }
}

/**
 * Primer alone for 12 s, with or without the immediate-pause feature. Sequence L, so the output is
 * idle and quiet before Prepare. Exactly one device start after Prepare.
 */
async function runWrapTrial(
  immediatePause: boolean,
  origin: string,
  probe: DeviceProbe
): Promise<{
  failures: string[];
  starts: number;
  primerPaused: boolean | null;
}> {
  const extraArgs: PrimerChromeArg[] = immediatePause
    ? [PRIMER_IMMEDIATE_PAUSE_ARG]
    : [];
  let loadedAt = 0;
  const page = await openViewer({
    url: `${origin}/?arm=av`,
    origin,
    sessionToken: 'primer-wrap',
    extraArgs,
    beforeNavigate: async (target) => {
      loadedAt = (await beforeNavigation(target, probe)).loadedAt;
    },
  });
  try {
    const metadataAt = await waitForMetadata(page);
    const settled = await lateSettle(probe, loadedAt, metadataAt);
    const failures: string[] = [...settled.failures];
    await armPointer(page, 'button.otio-prepare', PREPARE_MARK, 0);
    await page.click('button.otio-prepare');
    await sleep(WRAP_MS);
    const report = await page.evaluate<WrapReport>('window.__primerReport()');
    const done = await page.stopPerformanceTrace();
    const events = done.events as TraceEvent[];
    if (done.truncated) failures.push('trace truncated');
    if (report.error) failures.push(`primer failed: ${report.error}`);
    if (report.primer?.paused !== false)
      failures.push('primer was not playing at the end of the 12 s window');
    const prepareTs = markTs(events, PREPARE_MARK);
    if (prepareTs === null) {
      failures.push('no Prepare pointer mark');
      return {
        failures,
        starts: 0,
        primerPaused: report.primer?.paused ?? null,
      };
    }
    failures.push(
      ...quietFailures(quietWindow(events, prepareTs), settled.state)
    );
    const starts = deviceStarts(events, prepareTs);
    if (starts !== 1)
      failures.push(
        `${starts} device start(s) after Prepare in 12 s, expected exactly 1`
      );
    return { failures, starts, primerPaused: report.primer?.paused ?? null };
  } finally {
    await page.close();
  }
}

/** Number of audio streams in a file, read by ffprobe. Fails rather than guessing on a bad probe. */
async function audioStreamCount(file: string): Promise<number> {
  const child = Bun.spawn(
    [
      'ffprobe',
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=index',
      '-of',
      'csv=p=0',
      file,
    ],
    { stdout: 'pipe', stderr: 'pipe' }
  );
  const [out, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `ffprobe failed on ${file}`);
  return out.split('\n').filter((line) => line.trim() !== '').length;
}
/**
 * Runs every primer group. Each trial is isolated: a thrown error becomes a failure of its group
 * and the other groups still run. Nothing is skipped.
 */
export async function runPrimerProof(
  input: PrimerProofInput
): Promise<PrimerStage[]> {
  assert.ok(
    process.env['RELIC_OTIO_CHROME_PATH'],
    'RELIC_OTIO_CHROME_PATH must name the owned chrome-headless-shell; the primer proof never falls back to an installed Chrome'
  );
  const shamBuildFailures = await checkShamBuilds(
    input.productionBuild,
    input.shamBuild
  );
  if (shamBuildFailures.length)
    throw new Error(
      `sham build is not trusted: ${shamBuildFailures.join('; ')}`
    );
  const primer = ownedBytes(otioAudioPrimerBytes());
  assert.equal(
    primer.byteLength,
    OTIO_AUDIO_PRIMER_BYTE_LENGTH,
    'primer byte length differs from the generated module'
  );
  assert.equal(
    createHash('sha256').update(primer).digest('hex'),
    OTIO_AUDIO_PRIMER_SHA256,
    'primer bytes do not match the generated SHA-256'
  );
  const program = await readFile(input.programMp4);
  const programSha256 = createHash('sha256').update(program).digest('hex');

  // The video-only control is valid only when its packets are identical to the source's.
  const noAudioPath = join(input.scratch, 'native-control-video-only.mp4');
  let videoOnly: Uint8Array<ArrayBuffer> | null = null;
  let remuxFailure: string | null = null;
  try {
    await videoOnlyRemux(input.programMp4, noAudioPath);
    await assertVideoPacketsIdentical(input.programMp4, noAudioPath);
    assert.ok(
      (await audioStreamCount(input.programMp4)) > 0,
      'program has no audio stream: the video-only control would not be a fair control'
    );
    assert.equal(
      await audioStreamCount(noAudioPath),
      0,
      'video-only control still has an audio stream'
    );
    videoOnly = ownedBytes(await readFile(noAudioPath));
  } catch (error) {
    remuxFailure = `video-only control is not a fair control: ${messageOf(error)}`;
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/program.mp4')
        return new Response(program, {
          headers: { 'content-type': 'video/mp4' },
        });
      if (url.pathname === '/video-only.mp4' && videoOnly)
        return new Response(videoOnly, {
          headers: { 'content-type': 'video/mp4' },
        });
      if (url.pathname === '/primer.mp4')
        return new Response(primer, {
          headers: { 'content-type': 'video/mp4' },
        });
      if (url.pathname !== '/')
        return new Response('not found', { status: 404 });
      const arm = url.searchParams.get('arm');
      const known = BARE_ARMS.find((candidate) => candidate === arm);
      if (!known) return new Response('unknown arm', { status: 400 });
      return new Response(bareHtml(known, programSha256), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const trials = new Map<string, PrimerTrial[]>();
  const failures = new Map<string, string[]>();
  const wrapFailures: string[] = [];
  const group = (sequence: Sequence, kind: 'bare' | 'viewer', arm: string) =>
    `${sequence}/${kind}/${arm}`;
  const record = (name: string, trial: PrimerTrial) => {
    trials.set(name, [...(trials.get(name) ?? []), trial]);
    const messages = trial.failures.map(
      (failure) => `round ${trial.round} ${trial.arm}: ${failure}`
    );
    if (messages.length)
      failures.set(name, [...(failures.get(name) ?? []), ...messages]);
  };
  const recordError = (
    name: string,
    round: number,
    arm: string,
    error: unknown
  ) =>
    failures.set(name, [
      ...(failures.get(name) ?? []),
      `round ${round} ${arm}: ${messageOf(error)}`,
    ]);

  const bareCase = async (sequence: Sequence, arm: BareArm, round: number) => {
    const name = group(sequence, 'bare', arm);
    if (arm === 'video-only' && remuxFailure) {
      recordError(name, round, arm, remuxFailure);
      return;
    }
    try {
      record(
        name,
        await runBareTrial(
          sequence,
          arm,
          round,
          origin,
          input.scratch,
          input.deviceProbe
        )
      );
    } catch (error) {
      recordError(name, round, arm, error);
    }
  };

  const viewerCase = async (
    sequence: Sequence,
    arm: ViewerArm,
    round: number
  ) => {
    const name = group(sequence, 'viewer', arm);
    try {
      await input.router.activate(
        arm === 'sham' ? input.shamBuild : input.productionBuild
      );
      const outcome = await runViewerTrial(sequence, arm, round, input);
      record(name, outcome.trial);
      if (outcome.visibility)
        console.log(
          `OTIO_PRIMER_VISIBILITY ${JSON.stringify({ sequence, arm, round, visibility: outcome.visibility })}`
        );
    } catch (error) {
      recordError(name, round, arm, error);
    } finally {
      await input.router.activate(input.productionBuild);
    }
  };

  try {
    for (const immediatePause of [false, true]) {
      try {
        const wrap = await runWrapTrial(
          immediatePause,
          origin,
          input.deviceProbe
        );
        for (const failure of wrap.failures)
          wrapFailures.push(`immediate-pause=${immediatePause}: ${failure}`);
        console.log(
          `OTIO_PRIMER_WRAP ${JSON.stringify({ immediatePause, starts: wrap.starts, primerPaused: wrap.primerPaused })}`
        );
      } catch (error) {
        wrapFailures.push(
          `immediate-pause=${immediatePause}: ${messageOf(error)}`
        );
      }
    }

    for (let round = 0; round < PRIMER_ROUNDS; round++) {
      for (const arm of rotate(BARE_ARMS, round))
        await bareCase('late', arm, round);
      const viewerArms = rotate(
        VIEWER_ARMS.filter((arm) => arm !== 'unmute' || round < 3),
        round
      );
      for (const arm of viewerArms) await viewerCase('late', arm, round);
      for (const arm of viewerArms) await viewerCase('fresh', arm, round);
      for (const arm of rotate(BARE_ARMS, round))
        await bareCase('fresh', arm, round);
    }
  } finally {
    await server.stop(true);
  }

  const lateBare = (arm: BareArm) =>
    trials.get(group('late', 'bare', arm)) ?? [];
  const lateViewer = (arm: ViewerArm) =>
    trials.get(group('late', 'viewer', arm)) ?? [];
  const freshViewer = (arm: ViewerArm) =>
    trials.get(group('fresh', 'viewer', arm)) ?? [];
  const failuresOf = (name: string) => failures.get(name) ?? [];
  const cold = coldTrials;
  const inconclusive = inconclusiveFailures;
  /**
   * A cold control must start the output after its Play. That is the mechanism the cold label
   * rests on. Frame gaps gate only through the cold stall comparator, which needs every cold trial
   * to miss a program frame slot.
   */
  const deviceStartRequired = (name: string, list: readonly PrimerTrial[]) =>
    cold(list)
      .filter((trial) => trial.deviceStartsAfterPlay < 1)
      .map(
        (trial) =>
          `${name} round ${trial.round}: cold trial started no device after Play`
      );

  const reportArms: readonly BareArm[] = [
    'audio-only',
    'context',
    'video-only',
  ];
  const freshReported: PrimerTrial[] = [
    ...BARE_ARMS.flatMap(
      (arm) => trials.get(group('fresh', 'bare', arm)) ?? []
    ),
    ...(trials.get(group('fresh', 'viewer', 'sham')) ?? []),
  ];
  return [
    {
      stage: 'primer-wrap-single-start',
      failures: wrapFailures,
      trials: [],
    },
    {
      stage: 'primer-bare-negative-controls',
      failures: bareControlFailures(),
      trials: [],
    },
    {
      stage: 'primer-bare-cold-stall-comparator',
      failures: coldStallComparator([
        ...cold(lateBare('none')),
        ...cold(lateBare('sham')),
      ]),
      trials: [...cold(lateBare('none')), ...cold(lateBare('sham'))],
    },
    {
      stage: 'primer-bare-none-cold-start',
      failures: [
        ...failuresOf(group('late', 'bare', 'none')),
        ...inconclusive('bare none', lateBare('none')),
        ...deviceStartRequired('bare none', lateBare('none')),
      ],
      trials: lateBare('none'),
    },
    {
      stage: 'primer-bare-sham-cold-start',
      failures: [
        ...failuresOf(group('late', 'bare', 'sham')),
        ...inconclusive('bare sham', lateBare('sham')),
        ...deviceStartRequired('bare sham', lateBare('sham')),
      ],
      trials: lateBare('sham'),
    },
    {
      stage: 'primer-bare-real-shares-stream',
      failures: [
        ...failuresOf(group('late', 'bare', 'av')),
        ...inconclusive('bare av', lateBare('av')),
      ],
      trials: lateBare('av'),
    },
    {
      stage: 'primer-bare-blob-shares-stream',
      failures: [
        ...failuresOf(group('late', 'bare', 'av-blob')),
        ...inconclusive('bare av-blob', lateBare('av-blob')),
      ],
      trials: lateBare('av-blob'),
    },
    {
      stage: 'primer-bare-report-controls',
      failures: [
        ...(remuxFailure ? [remuxFailure] : []),
        ...reportArms.flatMap((arm) => failuresOf(group('late', 'bare', arm))),
      ],
      trials: reportArms.flatMap((arm) => lateBare(arm)),
    },
    {
      stage: 'viewer-primer-prepared',
      failures: [
        ...failuresOf(group('late', 'viewer', 'prepared')),
        ...inconclusive('viewer prepared', lateViewer('prepared')),
      ],
      trials: lateViewer('prepared'),
    },
    {
      stage: 'viewer-primer-sham-cold-start',
      failures: [
        ...failuresOf(group('late', 'viewer', 'sham')),
        ...inconclusive('viewer sham', lateViewer('sham')),
        ...deviceStartRequired('viewer sham', lateViewer('sham')),
      ],
      trials: lateViewer('sham'),
    },
    {
      stage: 'viewer-first-click',
      failures: failuresOf(group('late', 'viewer', 'first-click')),
      trials: lateViewer('first-click'),
    },
    {
      stage: 'viewer-unmute',
      failures: failuresOf(group('late', 'viewer', 'unmute')),
      trials: lateViewer('unmute'),
    },
    {
      stage: 'fresh-viewer-prepared',
      failures: failuresOf(group('fresh', 'viewer', 'prepared')),
      trials: freshViewer('prepared'),
    },
    {
      stage: 'fresh-viewer-first-click',
      failures: failuresOf(group('fresh', 'viewer', 'first-click')),
      trials: freshViewer('first-click'),
    },
    {
      stage: 'fresh-viewer-unmute',
      failures: failuresOf(group('fresh', 'viewer', 'unmute')),
      trials: freshViewer('unmute'),
    },
    {
      // Reported arms: sham and the bare arms in sequence F. They gate nothing, so only their
      // infrastructure errors and precondition failures (external audio before navigation) fail.
      stage: 'fresh-reported',
      failures: [
        ...BARE_ARMS.flatMap((arm) => failuresOf(group('fresh', 'bare', arm))),
        ...failuresOf(group('fresh', 'viewer', 'sham')),
      ],
      trials: freshReported,
    },
  ];
}
