/**
 * Primer proof trials. Every trial opens a fresh owned chrome-headless-shell with Chrome's default
 * --mute-audio, so nothing reaches a speaker. Gates live in otio-program-trace.ts; this module only
 * drives the browser and records what it saw.
 *
 * Measured sources, none of them an audio tap:
 *   - presented frames: requestVideoFrameCallback on the program video, page clock, with the element
 *     clock beside each frame (for the element-clock deficit diagnostic);
 *   - stream starts and device callbacks: Chrome's own trace, trace clock. These are telemetry;
 *     they never prove an audio gap;
 *   - trusted pointer events: performance.mark, which bridges the two clocks.
 *
 * Arms (PATH.md has the full table):
 *   wrap:   primer alone for 12 s, with and without AudioRendererMixerImmediatePause;
 *   bare:   none | sham | av | av-blob | audio-only | context | video-only (Prepare, 1500 ms, Play);
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
import type { ProofHarness } from './otio-program-harness.ts';
import {
  assertVideoPacketsIdentical,
  videoOnlyRemux,
} from './otio-program-remux-controls.ts';
import {
  classifyStart,
  deviceCallbacks,
  deviceExcessMs,
  firstStart,
  framesAfter,
  GAP_BUDGET_MS,
  gateGaps,
  gatePrimerWindow,
  intervals,
  markTs,
  maxOf,
  p95,
  PLAY_MARK,
  PREPARE_MARK,
  PRIMER_TRACE_CATEGORIES,
  type PrimerWindow,
  type StartClass,
  streamStarts,
  type TraceEvent,
  UNMUTE_MARK,
  WINDOW_MS,
} from './otio-program-trace.ts';
import {
  openViewer,
  PRIMER_IMMEDIATE_PAUSE_ARG,
  type PrimerChromeArg,
  type ViewerPage,
  VIEWER_CONTRACT,
} from './otio-program-viewer.ts';

export const PRIMER_ROUNDS = 5;
/** Cold trials each control needs. Fewer makes that group inconclusive, which fails. */
export const MIN_COLD_TRIALS = 3;
/** Unmute window: [-500, +2000] ms around the Unmute pointerdown. */
const UNMUTE_WINDOW_BEFORE_MS = 500;
const UNMUTE_WINDOW_AFTER_MS = 2000;
const MIN_UNMUTE_INTERVALS = 40;
const UNMUTE_DELAY_MS = 1500;
const UNMUTE_MUTED_BUDGET_MS = 1000;
const BARE_PREPARE_WAIT_MS = 1500;
const WRAP_MS = 12_000;
const PRIMER_SEEK_BACK_S = 3;

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
/** Arms that run the real primer, and therefore gate on stream sharing and frame cadence. */
const PRIMER_BARE_ARMS: readonly BareArm[] = ['av', 'av-blob'];
const VIEWER_ARMS = ['prepared', 'sham', 'first-click', 'unmute'] as const;
type ViewerArm = (typeof VIEWER_ARMS)[number];

/** Gap between trials, so each trial starts on a device that has gone quiet, as a user's would. */
export const PRIMER_TRIAL_GAP_MS = Number(
  process.env['RELIC_OTIO_PRIMER_TRIAL_GAP_MS'] ?? 12_000
);

export interface PrimerTrial {
  readonly arm: string;
  readonly round: number;
  /** Classification of the first stream the trial created, from its trusted interaction on. */
  readonly coldness: StartClass;
  readonly dMs: number | null;
  readonly startupMs: number | null;
  readonly maxGapMs: number | null;
  readonly p95GapMs: number | null;
  readonly intervals: number;
  readonly streamStartsBeforeTrusted: number;
  readonly streamStartsAfterPlay: number;
  /** Telemetry only: callback spacing from the trace. Never gates and never proves audio. */
  readonly callbackTelemetry: {
    readonly count: number;
    readonly excessMs: number | null;
  };
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
  /** The instrumented production build the video arms serve (emit recorder on). */
  readonly productionEntry: string;
  readonly shamEntry: string;
  /** Replaces the viewer's served main.js and viewer.js with the given build. */
  readonly installViewerBuild: (entry: string) => Promise<void>;
}

interface Frame {
  readonly now: number;
  readonly mediaTime: number;
  readonly currentTime: number;
}

interface PointerObservation {
  readonly pointerAt: number;
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

function bareHtml(arm: BareArm, programSha256: string): string {
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
<script>window.__primerArm = ${JSON.stringify(arm)};</script>
<script>${BARE_SCRIPT}</script>
${blob}`;
}

/**
 * Records every presented frame, its element clock, and buffering changes from the first trusted
 * pointerdown that matches selector. durationMs 0 only writes the mark. The listener is
 * capture-phase and is not `once`, so a non-matching pointer event cannot consume it.
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
  const onFrame = (now, metadata) => {
    if (!observing) return;
    frames.push({ now: now, mediaTime: metadata.mediaTime, currentTime: video.currentTime });
    video.requestVideoFrameCallback(onFrame);
  };
  if (observing) video.requestVideoFrameCallback(onFrame);
  const mutations = view && observing ? new MutationObserver(() => buffering.push({ at: performance.now(), value: view.getAttribute('data-buffering') })) : null;
  if (mutations) mutations.observe(view, { attributes: true, attributeFilter: ['data-buffering'] });
  const observed = Promise.withResolvers();
  window.__primerObs[mark] = observed.promise;
  document.addEventListener('pointerdown', (event) => {
    if (pointerAt !== null) return;
    const target = event.target instanceof Element ? event.target.closest(selector) : null;
    if (!target) return;
    if (!event.isTrusted) { observed.reject(new Error('pointerdown on ' + mark + ' was not trusted')); return; }
    pointerAt = performance.now();
    performance.mark(mark);
    window.__primerPointer[mark] = pointerAt;
    if (durationMs <= 0) { observed.resolve({ pointerAt: pointerAt }); return; }
    setTimeout(() => {
      observing = false;
      if (mutations) mutations.disconnect();
      observed.resolve({
        pointerAt: pointerAt,
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
    `document.querySelector('.otio-view')?.getAttribute('data-otio-audio-output') ?? null`
  );
}

async function programState(page: ViewerPage): Promise<ProgramState> {
  return page.evaluate<ProgramState>(`(() => {
    const v = document.querySelector('video.otio-program-video');
    return { paused: v.paused, currentTime: v.currentTime, muted: v.muted };
  })()`);
}

async function waitForMetadata(page: ViewerPage): Promise<void> {
  await page.waitFor('program video metadata', async () =>
    (await page.evaluate<boolean>(
      `document.querySelector('video.otio-program-video')?.readyState >= 1`
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

interface Analysis {
  readonly coldness: StartClass;
  readonly dMs: number | null;
  readonly startupMs: number | null;
  readonly gapsMs: readonly number[];
  readonly streamStartsBeforeTrusted: number;
  readonly streamStartsAfterPlay: number;
  readonly callbackCount: number;
  readonly callbackExcessMs: number | null;
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
  options: { firstClick: boolean; expectedStreamStarts: number }
): Analysis {
  const frames = obs.frames ?? [];
  const frameTimes = frames.map((frame) => frame.now);
  const gapsMs = intervals(frameTimes);
  const startupMs = frames[0] ? frames[0].now - obs.pointerAt : null;
  const firstFrame = frames[0];
  const bufferingBeforeFirstFrame =
    options.firstClick && firstFrame
      ? (obs.buffering ?? []).some(
          (b) => b.value === 'true' && b.at < firstFrame.now
        )
      : null;
  const prepareTs = markTs(events, PREPARE_MARK);
  const playTs = markTs(events, PLAY_MARK);
  const firstTs = prepareTs ?? playTs;
  if (playTs === null || firstTs === null) {
    return {
      coldness: 'absent',
      dMs: null,
      startupMs,
      gapsMs,
      streamStartsBeforeTrusted: 0,
      streamStartsAfterPlay: 0,
      callbackCount: 0,
      callbackExcessMs: null,
      window: {
        startupMs,
        gapsMs,
        bufferingBeforeFirstFrame,
        streamStarts: 0,
        expectedStreamStarts: options.expectedStreamStarts,
        firstCallbackMs: null,
        deviceExcessMs: null,
        deviceCallbacks: 0,
        firstClick: options.firstClick,
      },
      failures: ['trace has no trusted pointerdown mark'],
    };
  }
  const first = firstStart(events, firstTs);
  const dMs = first?.dMs ?? null;
  const callbackTs = deviceCallbacks(events, playTs, playTs + WINDOW_MS * 1000);
  const excess = deviceExcessMs(callbackTs);
  const firstCallbackMs =
    callbackTs[0] === undefined ? null : (callbackTs[0] - playTs) / 1000;
  const after = streamStarts(events, playTs);
  return {
    coldness: classifyStart(dMs),
    dMs,
    startupMs,
    gapsMs,
    streamStartsBeforeTrusted: streamStarts(events, 0, firstTs - 1),
    streamStartsAfterPlay: after,
    callbackCount: callbackTs.length,
    callbackExcessMs: excess,
    window: {
      startupMs,
      gapsMs,
      bufferingBeforeFirstFrame,
      streamStarts: after,
      expectedStreamStarts: options.expectedStreamStarts,
      firstCallbackMs,
      deviceExcessMs: excess,
      deviceCallbacks: callbackTs.length,
      firstClick: options.firstClick,
    },
    failures: [],
  };
}

function trialOf(
  arm: string,
  round: number,
  analysis: Analysis,
  extra: readonly string[]
): PrimerTrial {
  return {
    arm,
    round,
    coldness: analysis.coldness,
    dMs: analysis.dMs,
    startupMs: analysis.startupMs,
    maxGapMs: maxOf(analysis.gapsMs),
    p95GapMs: p95(analysis.gapsMs),
    intervals: analysis.gapsMs.length,
    streamStartsBeforeTrusted: analysis.streamStartsBeforeTrusted,
    streamStartsAfterPlay: analysis.streamStartsAfterPlay,
    callbackTelemetry: {
      count: analysis.callbackCount,
      excessMs: analysis.callbackExcessMs,
    },
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

/** Bare arm: fresh browser, Prepare, 1500 ms, then trusted Play. Receipts stay in scratch. */
async function runBareTrial(
  arm: BareArm,
  round: number,
  origin: string,
  scratch: string
): Promise<PrimerTrial> {
  const page = await openViewer({
    url: `${origin}/?arm=${arm}`,
    origin,
    sessionToken: 'primer-bare',
  });
  try {
    if (arm === 'av-blob') await waitForBlobSource(page);
    await waitForMetadata(page);
    await page.startPerformanceTrace(PRIMER_TRACE_CATEGORIES);
    await armPointer(page, 'button.otio-prepare', PREPARE_MARK, 0);
    await page.click('button.otio-prepare');
    await sleep(BARE_PREPARE_WAIT_MS);
    await armPointer(page, 'button.otio-play', PLAY_MARK, WINDOW_MS);
    await page.click('button.otio-play');
    const obs = await pointerObservation(page, PLAY_MARK);
    const report = await page.evaluate<BareReport>('window.__primerReport()');
    const blobError = await page.evaluate<string | null>(
      'window.__barePlayError ?? null'
    );
    const done = await page.stopPerformanceTrace();
    const primerArm = PRIMER_BARE_ARMS.includes(arm);
    const analysis = analyse(done.events as TraceEvent[], obs, {
      firstClick: false,
      expectedStreamStarts: primerArm ? 0 : 1,
    });
    const extra: string[] = [];
    if (done.truncated) extra.push('trace truncated: window is incomplete');
    if (report.error) extra.push(`bare play failed: ${report.error}`);
    if (blobError) extra.push(`blob source failed: ${blobError}`);
    if (analysis.streamStartsBeforeTrusted !== 0)
      extra.push(
        `${analysis.streamStartsBeforeTrusted} stream start(s) before the Prepare pointerdown`
      );
    if (primerArm) extra.push(...gatePrimerWindow(analysis.window));
    const trial = trialOf(arm, round, analysis, extra);
    await writeReceipt(scratch, `primer-bare-${arm}-${round}.json`, {
      trial,
      obs,
      report,
      clockDeficit: clockDeficitSummary(obs.frames ?? []),
      trace: done,
    });
    console.log(`OTIO_PRIMER_TRIAL ${JSON.stringify(trial)}`);
    return trial;
  } finally {
    await page.close();
  }
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

/** Viewer arm: one fresh browser on the real viewer, with the production or sham build installed. */
async function runViewerTrial(
  arm: ViewerArm,
  round: number,
  input: PrimerProofInput
): Promise<{ trial: PrimerTrial; visibility: string | null }> {
  const sessionToken = await input.harness.createSession();
  const page = await openViewer({
    url: input.shareUrl,
    origin: input.harness.origin,
    sessionToken,
    instrumentEmits: true,
  });
  try {
    await waitForProgramState(page);
    await waitForMetadata(page);
    const extra: string[] = [];
    // Before the first trusted event: primer idle, program paused and not moving.
    const primerBefore = await primerAttribute(page);
    const restBefore = await programState(page);
    if (primerBefore !== 'idle')
      extra.push(`primer is ${primerBefore} before the first trusted event`);
    if (!restBefore.paused)
      extra.push('program was playing before the first trusted event');
    await page.startPerformanceTrace(PRIMER_TRACE_CATEGORIES);

    if (arm !== 'first-click') {
      // Prepared, sham and unmute: one genuine earlier interaction arms the primer.
      const control =
        arm === 'unmute'
          ? 'button[aria-label="Mute"]'
          : '.otio-inspector-tab[data-tab="markers"]';
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
    if (arm === 'unmute')
      await armPointer(page, 'button[aria-label="Unmute"]', UNMUTE_MARK, 0);
    await page.click('button.otio-play');
    if (arm === 'unmute') {
      await sleep(UNMUTE_DELAY_MS);
      await page.click('button[aria-label="Unmute"]');
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

    const analysis = analyse(done.events as TraceEvent[], obs, {
      firstClick: arm === 'first-click',
      expectedStreamStarts: arm === 'first-click' ? 1 : 0,
    });
    if (analysis.streamStartsBeforeTrusted !== 0)
      extra.push(
        `${analysis.streamStartsBeforeTrusted} stream start(s) before the first trusted event`
      );
    if (arm === 'prepared' || arm === 'first-click')
      extra.push(...gatePrimerWindow(analysis.window));
    if (arm === 'unmute') {
      if (unmuteAt === undefined) {
        extra.push('no Unmute pointer mark');
      } else {
        const frameTimes = (obs.frames ?? []).map((f) => f.now);
        const windowTimes = framesAfter(
          frameTimes,
          unmuteAt - UNMUTE_WINDOW_BEFORE_MS
        ).filter((t) => t <= unmuteAt + UNMUTE_WINDOW_AFTER_MS);
        extra.push(
          ...gateGaps(
            intervals(windowTimes),
            MIN_UNMUTE_INTERVALS,
            'unmute window'
          )
        );
      }
      if (analysis.streamStartsAfterPlay !== 0)
        extra.push(
          `${analysis.streamStartsAfterPlay} stream start(s) after Play, expected 0`
        );
    }
    if (arm === 'first-click') {
      const kinds = emitKinds ?? [];
      if (!kinds.includes('session') || !kinds.includes('player'))
        extra.push('instrumented emits missing session or player');
    }

    // Hidden leg: the primer must stop when the viewer is hidden. Headless may keep it visible.
    let visibility: string | null = null;
    if (arm === 'prepared' && round === 0) {
      const foreground = await page.foregroundOtherTab();
      if (foreground.hidden) {
        await sleep(1500);
        const after = await primerAttribute(page);
        if (after !== 'idle')
          extra.push(`primer is ${after} 1.5 s after the viewer was hidden`);
        visibility = 'hidden';
      } else {
        visibility = `unproven: headless kept the viewer ${foreground.visibility}`;
      }
    }

    const trial = trialOf(arm, round, analysis, extra);
    await writeReceipt(input.scratch, `primer-viewer-${arm}-${round}.json`, {
      trial,
      obs,
      trace: done,
      unmuteAt: unmuteAt ?? null,
      clockDeficit: clockDeficitSummary(obs.frames ?? []),
    });
    console.log(`OTIO_PRIMER_TRIAL ${JSON.stringify(trial)}`);
    return { trial, visibility };
  } finally {
    await page.close();
  }
}

/** The sham build must differ from production by exactly the primer's mute line. */
async function assertShamDiffers(
  productionEntry: string,
  shamEntry: string
): Promise<void> {
  const production = (await readFile(productionEntry, 'utf8')).split('\n');
  const sham = (await readFile(shamEntry, 'utf8')).split('\n');
  assert.equal(sham.length, production.length, 'sham build line count differs');
  const differing = production
    .map((_, index) => index)
    .filter((index) => production[index] !== sham[index]);
  assert.equal(
    differing.length,
    1,
    `sham build differs from production on ${differing.length} line(s), expected 1`
  );
  const index = differing[0]!;
  assert.equal(production[index]!.trim(), 'element.muted = false;');
  assert.equal(sham[index]!.trim(), 'element.muted = true;');
}

/** Primer alone for 12 s, with or without the immediate-pause feature. Exactly one stream start. */
async function runWrapTrial(
  immediatePause: boolean,
  origin: string
): Promise<{
  failures: string[];
  starts: number;
  primerPaused: boolean | null;
}> {
  const extraArgs: PrimerChromeArg[] = immediatePause
    ? [PRIMER_IMMEDIATE_PAUSE_ARG]
    : [];
  const page = await openViewer({
    url: `${origin}/?arm=av`,
    origin,
    sessionToken: 'primer-wrap',
    extraArgs,
  });
  try {
    await waitForMetadata(page);
    await page.startPerformanceTrace(PRIMER_TRACE_CATEGORIES);
    await armPointer(page, 'button.otio-prepare', PREPARE_MARK, 0);
    await page.click('button.otio-prepare');
    await sleep(WRAP_MS);
    const report = await page.evaluate<WrapReport>('window.__primerReport()');
    const done = await page.stopPerformanceTrace();
    const events = done.events as TraceEvent[];
    const failures: string[] = [];
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
    const starts = events.filter(
      (e) => e.name === 'OutputController::Play' && e.ts >= prepareTs
    ).length;
    if (starts !== 1)
      failures.push(
        `${starts} OutputController::Play in 12 s, expected exactly 1`
      );
    return { failures, starts, primerPaused: report.primer?.paused ?? null };
  } finally {
    await page.close();
  }
}

function bareGroup(arm: BareArm): string {
  return `bare:${arm}`;
}

function viewerGroup(arm: ViewerArm): string {
  return `viewer:${arm}`;
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
  await assertShamDiffers(input.productionEntry, input.shamEntry);
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
  const record = (group: string, trial: PrimerTrial) => {
    trials.set(group, [...(trials.get(group) ?? []), trial]);
    const messages = trial.failures.map(
      (failure) => `round ${trial.round} ${trial.arm}: ${failure}`
    );
    if (messages.length)
      failures.set(group, [...(failures.get(group) ?? []), ...messages]);
  };
  const recordError = (
    group: string,
    round: number,
    arm: string,
    error: unknown
  ) =>
    failures.set(group, [
      ...(failures.get(group) ?? []),
      `round ${round} ${arm}: ${messageOf(error)}`,
    ]);
  let started = false;
  const gap = async () => {
    if (started) await sleep(PRIMER_TRIAL_GAP_MS);
    started = true;
  };

  try {
    for (const immediatePause of [false, true]) {
      await gap();
      try {
        const wrap = await runWrapTrial(immediatePause, origin);
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
      for (const arm of rotate(BARE_ARMS, round)) {
        if (arm === 'video-only' && remuxFailure) {
          recordError(bareGroup(arm), round, arm, remuxFailure);
          continue;
        }
        await gap();
        try {
          record(
            bareGroup(arm),
            await runBareTrial(arm, round, origin, input.scratch)
          );
        } catch (error) {
          recordError(bareGroup(arm), round, arm, error);
        }
      }

      const viewerArms = rotate(
        VIEWER_ARMS.filter((arm) => arm !== 'unmute' || round < 3),
        round
      );
      for (const arm of viewerArms) {
        await gap();
        const isSham = arm === 'sham';
        try {
          if (isSham) await input.installViewerBuild(input.shamEntry);
          const outcome = await runViewerTrial(arm, round, input);
          record(viewerGroup(arm), outcome.trial);
          if (outcome.visibility)
            console.log(
              `OTIO_PRIMER_VISIBILITY ${JSON.stringify({ arm, round, visibility: outcome.visibility })}`
            );
        } catch (error) {
          recordError(viewerGroup(arm), round, arm, error);
        } finally {
          if (isSham) await input.installViewerBuild(input.productionEntry);
        }
      }
    }
  } finally {
    await server.stop(true);
  }

  const bare = (arm: BareArm) => trials.get(bareGroup(arm)) ?? [];
  const viewer = (arm: ViewerArm) => trials.get(viewerGroup(arm)) ?? [];
  const failuresOf = (group: string) => failures.get(group) ?? [];
  const cold = (list: readonly PrimerTrial[]) =>
    list.filter((trial) => trial.coldness === 'cold');
  const inconclusive = (name: string, list: readonly PrimerTrial[]) =>
    cold(list).length < MIN_COLD_TRIALS
      ? [
          `${name}: ${cold(list).length} cold trial(s), need ${MIN_COLD_TRIALS}; inconclusive`,
        ]
      : [];
  /** A control must reproduce the stall in every cold trial: a gap over the budget. */
  const stallRequired = (name: string, list: readonly PrimerTrial[]) =>
    cold(list)
      .filter(
        (trial) => trial.maxGapMs === null || trial.maxGapMs <= GAP_BUDGET_MS
      )
      .map(
        (trial) =>
          `${name} round ${trial.round}: cold start did not stall (max gap ${trial.maxGapMs ?? 'none'} ms)`
      );

  const reportArms: readonly BareArm[] = [
    'audio-only',
    'context',
    'video-only',
  ];
  return [
    {
      stage: 'primer-wrap-single-start',
      failures: wrapFailures,
      trials: [],
    },
    {
      stage: 'primer-bare-none-stalls',
      failures: [
        ...failuresOf(bareGroup('none')),
        ...inconclusive('bare none', bare('none')),
        ...stallRequired('bare none', bare('none')),
      ],
      trials: bare('none'),
    },
    {
      stage: 'primer-bare-sham-stalls',
      failures: [
        ...failuresOf(bareGroup('sham')),
        ...inconclusive('bare sham', bare('sham')),
        ...stallRequired('bare sham', bare('sham')),
      ],
      trials: bare('sham'),
    },
    {
      stage: 'primer-bare-real-shares-stream',
      failures: [
        ...failuresOf(bareGroup('av')),
        ...inconclusive('bare av', bare('av')),
      ],
      trials: bare('av'),
    },
    {
      stage: 'primer-bare-blob-shares-stream',
      failures: [
        ...failuresOf(bareGroup('av-blob')),
        ...inconclusive('bare av-blob', bare('av-blob')),
      ],
      trials: bare('av-blob'),
    },
    {
      stage: 'primer-bare-report-controls',
      failures: [
        ...(remuxFailure ? [remuxFailure] : []),
        ...reportArms.flatMap((arm) => failuresOf(bareGroup(arm))),
      ],
      trials: reportArms.flatMap((arm) => bare(arm)),
    },
    {
      stage: 'viewer-primer-prepared',
      failures: [
        ...failuresOf(viewerGroup('prepared')),
        ...inconclusive('viewer prepared', viewer('prepared')),
      ],
      trials: viewer('prepared'),
    },
    {
      stage: 'viewer-primer-sham-stalls',
      failures: [
        ...failuresOf(viewerGroup('sham')),
        ...inconclusive('viewer sham', viewer('sham')),
        ...stallRequired('viewer sham', viewer('sham')),
      ],
      trials: viewer('sham'),
    },
    {
      stage: 'viewer-first-click',
      failures: failuresOf(viewerGroup('first-click')),
      trials: viewer('first-click'),
    },
    {
      stage: 'viewer-unmute',
      failures: failuresOf(viewerGroup('unmute')),
      trials: viewer('unmute'),
    },
  ];
}
