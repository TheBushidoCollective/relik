/**
 * Sampled audio arm for the primer proof: the actual samples the program element outputs, aligned
 * to the independent analytic reference, with silence and dropouts measured in milliseconds.
 *
 * Separation, which is the point of this arm:
 *   - Uninstrumented: the production viewer build, with no emit recorder. The emitted-graph
 *     instrumentation used by the video arms is not present here.
 *   - Separate from every video arm. The video arms never tap audio, so the capture cannot alter
 *     their presented-frame timing. This arm's tap is itself a changed condition, reported as such.
 *   - Recording starts at the trusted Play pointerdown, not at AudioContext creation, so the
 *     alignment measures the start the user hears.
 *
 * Callback telemetry is not read here. Only the captured samples count as audio.
 */

import assert from 'node:assert/strict';
import { expectedAudio, PROGRAM } from './otio-program-reference.ts';
import {
  gateSignal,
  measureSignal,
  type SignalEvidence,
} from './otio-program-audio-signal.ts';
import type { ProofHarness } from './otio-program-harness.ts';
import type { PrimerStage } from './otio-program-primer-controls.ts';
import { openViewer, VIEWER_CONTRACT } from './otio-program-viewer.ts';

export const AUDIO_ROUNDS = 3;
/** Captured from the trusted Play. Ends before the reference's designed silence at 4.5 s. */
export const AUDIO_CAPTURE_SECONDS = 4.5;
const SETTLE_MS = 1500;

export interface AudioArmInput {
  readonly harness: ProofHarness;
  readonly shareUrl: string;
  readonly scratch: string;
  /** The production build, as shipped: no emit recorder. */
  readonly uninstrumentedEntry: string;
  /** Restores the instrumented build that the video arms use. */
  readonly restoreEntry: string;
  readonly installViewerBuild: (entry: string) => Promise<void>;
}

type AudioArm = 'prepared' | 'first-click';

interface CapturedAudio {
  readonly rate: number;
  readonly left: number[];
  readonly right: number[];
}

/**
 * Installed on the program's Play button before the trusted click. Samples are kept only after the
 * trusted pointerdown. The AudioContext is created here but its samples are discarded until then.
 */
function tapScript(): string {
  return `(() => {
  const hook = window.${VIEWER_CONTRACT.hook};
  const video = document.querySelector('video.otio-program-video');
  const play = document.querySelector('button.otio-play');
  if (!video || !play) throw new Error('audio arm: program controls missing');
  if (typeof video.captureStream !== 'function') throw new Error('captureStream unavailable');
  const stream = video.captureStream();
  if (!stream.getAudioTracks().length) throw new Error('program captureStream has no audio track');
  const ctx = new AudioContext({ sampleRate: 48000 });
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 2, 2);
  const left = [];
  const right = [];
  let recording = false;
  processor.onaudioprocess = (event) => {
    if (!recording) return;
    const l = event.inputBuffer.getChannelData(0);
    const r = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : l;
    for (let i = 0; i < l.length; i++) { left.push(l[i]); right.push(r[i]); }
  };
  source.connect(processor);
  processor.connect(ctx.destination);
  window.__audioSignal = new Promise((resolve, reject) => {
    play.addEventListener('pointerdown', (event) => {
      if (!event.isTrusted) { reject(new Error('audio Play pointerdown was not trusted')); return; }
      recording = true;
      ctx.resume().catch(reject);
      setTimeout(async () => {
        try {
          recording = false;
          await hook.pause();
          processor.disconnect();
          source.disconnect();
          const rate = ctx.sampleRate;
          await ctx.close();
          resolve({ rate, left, right });
        } catch (error) { reject(error); }
      }, ${AUDIO_CAPTURE_SECONDS * 1000});
    }, { once: true });
  });
})()`;
}

async function runAudioTrial(
  arm: AudioArm,
  round: number,
  input: AudioArmInput
): Promise<{ failures: string[]; evidence: Record<string, SignalEvidence> }> {
  await input.installViewerBuild(input.uninstrumentedEntry);
  try {
    const page = await openViewer({
      url: input.shareUrl,
      origin: input.harness.origin,
      sessionToken: await input.harness.createSession(),
    });
    try {
      await page.waitFor('program state for audio arm', async () =>
        (await page.evaluate<string | null>(
          `document.querySelector('.otio-view')?.getAttribute('${VIEWER_CONTRACT.stateAttribute}') ?? null`
        )) === 'program'
          ? true
          : undefined
      );
      await page.waitFor('program video metadata for audio arm', async () =>
        (await page.evaluate<boolean>(
          `document.querySelector('video.otio-program-video')?.readyState >= 1`
        ))
          ? true
          : undefined
      );
      const failures: string[] = [];
      if (arm === 'prepared') {
        // A genuine earlier interaction, as in the prepared video arm, then the same tap.
        await page.click('.otio-inspector-tab[data-tab="markers"]');
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        const state = await page.evaluate<string | null>(
          `document.querySelector('.otio-view')?.getAttribute('data-otio-audio-output') ?? null`
        );
        if (state !== 'running')
          failures.push(
            `${arm} round ${round}: primer is ${state}, not running, before Play`
          );
      }
      await page.evaluate(tapScript());
      await page.click('button.otio-play');
      const captured = await page.evaluate<CapturedAudio>(
        'window.__audioSignal'
      );
      assert.equal(
        captured.rate,
        PROGRAM.audioRate,
        'capture rate differs from the program'
      );
      const reference = Float32Array.from(expectedAudio());
      const evidence: Record<string, SignalEvidence> = {};
      for (const [label, samples] of [
        ['left', captured.left],
        ['right', captured.right],
      ] as const) {
        const measured = measureSignal(
          Float32Array.from(samples),
          reference,
          captured.rate
        );
        evidence[label] = measured;
        failures.push(
          ...gateSignal(measured, `${arm} round ${round} ${label}`)
        );
      }
      return { failures, evidence };
    } finally {
      await page.close();
    }
  } finally {
    await input.installViewerBuild(input.restoreEntry);
  }
}

/** Runs both sampled audio arms, interleaved over AUDIO_ROUNDS, and returns one stage per arm. */
export async function runAudioArm(
  input: AudioArmInput
): Promise<PrimerStage[]> {
  const failures: Record<AudioArm, string[]> = {
    prepared: [],
    'first-click': [],
  };
  const errors: Record<AudioArm, string[]> = {
    prepared: [],
    'first-click': [],
  };
  const evidence: Record<AudioArm, Array<Record<string, SignalEvidence>>> = {
    prepared: [],
    'first-click': [],
  };
  for (let round = 0; round < AUDIO_ROUNDS; round++) {
    for (const arm of round % 2 === 0
      ? (['prepared', 'first-click'] as const)
      : (['first-click', 'prepared'] as const)) {
      try {
        const outcome = await runAudioTrial(arm, round, input);
        failures[arm].push(...outcome.failures);
        evidence[arm].push(outcome.evidence);
        console.log(
          `OTIO_PRIMER_AUDIO ${JSON.stringify({ arm, round, failures: outcome.failures.length, left: summarise(outcome.evidence['left']), right: summarise(outcome.evidence['right']) })}`
        );
      } catch (error) {
        errors[arm].push(
          `round ${round}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  return (['prepared', 'first-click'] as const).map((arm) => ({
    stage: `viewer-audio-${arm}-signal`,
    failures: [...errors[arm], ...failures[arm]],
    trials: [],
  }));
}

function summarise(evidence: SignalEvidence | undefined) {
  if (!evidence) return null;
  return {
    onsetMs: Number(evidence.onsetMs.toFixed(2)),
    snrDb: Number(evidence.snrDb.toFixed(1)),
    testedMs: evidence.testedMs,
    longestGapMs: evidence.longestGapMs,
    gapStartSeconds: evidence.gapStartSeconds,
    windowFaults: evidence.windowFaults.length,
  };
}
