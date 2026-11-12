/**
 * Sampled audio arm for the primer proof: the program renderer's output as its own tee delivers
 * it (MediaStreamTrackProcessor over the element's captureStream audio), joined to the same trial's
 * Chrome trace and aligned to the independent analytic reference.
 *
 * Separation, which is the point of this arm:
 *   - Uninstrumented: the production viewer build, with no emit recorder. The emitted-graph
 *     instrumentation used by the video arms is not present here.
 *   - Separate from every video arm. The video arms never capture audio.
 *   - Every trial runs with Chrome's --mute-audio. Nothing here reaches a speaker, so a pass proves
 *     the program renderer's own output, not what a listener hears.
 *   - Stamps are pairing keys only. They are never read as capture, playout or onset times.
 *
 * Each normal trial is gated by the join, the trusted Play's marks, the reference coverage, and
 * the mutation controls (each mutation of a real capture must be rejected). One extra early-start
 * control runs after the normal trials and must produce program audio before the trusted Play.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROOF_GLOBAL } from '../../relic-viewer/test/otio-program-emit-instrument.ts';
import {
  type ViewerBuild,
  type ViewerRouter,
  readBuild,
} from './otio-program-builds.ts';
import { latin1 } from './otio-program-sham-check.ts';
import { expectedAudio } from './otio-program-reference.ts';
import type { SignalEvidence } from './otio-program-audio-signal.ts';
import {
  gateCapture,
  mutationControlFailures,
  PRE_GESTURE_FAILURE,
} from './otio-program-audio-join.ts';
import {
  captureProgramAudio,
  trialCoverageFailures,
  EARLY_START_LEAD_MS,
  gatedChannel,
  replayEvents,
} from './otio-program-audio-capture.ts';
import {
  markOrderFailures,
  PLAY_MARK,
  type TraceEvent,
} from './otio-program-trace.ts';
import type { ProofHarness } from './otio-program-harness.ts';
import type { PrimerStage } from './otio-program-primer-controls.ts';
import {
  openViewer,
  type ViewerPage,
  VIEWER_CONTRACT,
} from './otio-program-viewer.ts';

export const AUDIO_ROUNDS = 3;
/** Captured from the trusted Play. Ends before the reference's designed silence at 4.5 s. */
export const AUDIO_CAPTURE_SECONDS = 4.5;
const SETTLE_MS = 1500;
const PREPARED_STAGE = 'viewer-audio-prepared-signal';
const FIRST_CLICK_STAGE = 'viewer-audio-first-click-signal';

export interface AudioArmInput {
  readonly harness: ProofHarness;
  readonly shareUrl: string;
  readonly scratch: string;
  /** The production build as shipped: no emit recorder. Served as one complete directory. */
  readonly uninstrumentedBuild: ViewerBuild;
  /** The instrumented production build restored after the audio arm. */
  readonly restoreBuild: ViewerBuild;
  readonly router: ViewerRouter;
}

type AudioArm = 'prepared' | 'first-click';

interface TrialOutcome {
  /** Failures of the trial's own checks: served builds, primer state, the gate and the controls. */
  readonly failures: string[];
  /** Early-start control strings only. They belong to the prepared stage. */
  readonly controlFailures: string[];
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** The trace timestamp (microseconds) of the named mark, or null when the trace lacks it. */
function markTsUs(events: readonly unknown[], name: string): number | null {
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const record = event as { name?: unknown; ts?: unknown };
    if (record.name === name && typeof record.ts === 'number') return record.ts;
  }
  return null;
}

function receiptPath(
  scratch: string,
  arm: AudioArm,
  round: number,
  earlyStart: boolean
): string {
  return join(
    scratch,
    earlyStart
      ? `primer-audio-${arm}-early-start`
      : `primer-audio-${arm}-${round}`
  );
}

async function runAudioTrial(
  arm: AudioArm,
  round: number,
  earlyStart: boolean,
  input: AudioArmInput
): Promise<TrialOutcome> {
  await input.router.activate(input.uninstrumentedBuild);
  input.router.resetServed();
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
      const served = input.router.servedBuilds();
      if (served.length !== 1 || served[0] !== input.uninstrumentedBuild.name)
        failures.push(
          `round ${round} ${arm}: served builds ${JSON.stringify(served)}, expected only ${input.uninstrumentedBuild.name}`
        );

      // The prepared arm has a genuine earlier interaction and a running primer before Play.
      let primerState: string | null = null;
      const record = await captureProgramAudio(page, {
        seconds: AUDIO_CAPTURE_SECONDS,
        beforePlay:
          arm === 'prepared'
            ? async (p: ViewerPage) => {
                await p.click('.otio-inspector-tab[data-tab="markers"]');
                await sleep(SETTLE_MS);
                primerState = await p.evaluate<string | null>(
                  `document.querySelector('.otio-view')?.getAttribute('data-otio-audio-output') ?? null`
                );
              }
            : undefined,
        beforeClick: earlyStart
          ? async (p: ViewerPage) => {
              // The program element starts without a gesture, so its audio reaches the tee before
              // the trusted Play. The control is expected to fail. Only the prediction is checked.
              await p.evaluate(
                `(async () => { try { await document.querySelector('video.otio-program-video').play(); } catch (error) {} })()`
              );
              await sleep(EARLY_START_LEAD_MS);
            }
          : undefined,
      });
      if (arm === 'prepared' && primerState !== 'running')
        failures.push(
          `${arm} round ${round}: primer is ${primerState}, not running, before Play`
        );

      const reference = Float32Array.from(expectedAudio());
      const label = `${arm} round ${round}${earlyStart ? ' early-start' : ''}`;
      const options = {
        reference: { left: reference, right: reference },
        label,
      };
      const gate = gateCapture(record, options);
      const coverage = trialCoverageFailures(record, gate.join, label);
      const markFailures = markOrderFailures(
        // The trace's events are the TraceEvent records the proof's trace reads. The join types
        // them as unknown so it does not depend on the trace module.
        record.events as readonly TraceEvent[],
        PLAY_MARK
      );
      const controls = mutationControlFailures(record, options);

      // Early-start control: a program render must end before the trusted Play, and the gate must
      // report it as pre-gesture audio. Render times are the join's tee times on the trace clock.
      const controlFailures: string[] = [];
      if (earlyStart) {
        const playUs = markTsUs(record.events, PLAY_MARK);
        const preGesture =
          playUs === null
            ? 0
            : gate.join.pairs.filter((pair) => pair.teeUs < playUs).length;
        if (preGesture === 0)
          controlFailures.push(
            'early-start control produced no program render before the trusted Play'
          );
        if (
          !gate.failures.some((failure) =>
            failure.startsWith(PRE_GESTURE_FAILURE)
          )
        )
          controlFailures.push(
            `early-start control did not fail as predicted: ${gate.failures.join(' | ') || 'none'}`
          );
      }

      // Receipts: enough to replay the join and the gate offline. The measured samples, the
      // sanitized render and mixer-input timings, the marks, and every outcome are kept in scratch.
      // Nothing here changes what is gated.
      const receipt = receiptPath(input.scratch, arm, round, earlyStart);
      const allFailures = [
        ...failures,
        ...gate.failures,
        ...coverage,
        ...markFailures,
        ...controls,
      ];
      await writeFile(
        `${receipt}.json`,
        JSON.stringify({
          arm,
          round,
          earlyStart,
          label,
          primerState,
          failures: allFailures,
          controlFailures,
          dataLossOccurred: record.dataLossOccurred,
          truncated: record.truncated,
          restCurrentTime: record.restCurrentTime,
          observerFrames: record.observerFrames,
          referenceSamples: reference.length,
          chunks: record.chunks.map((chunk) => ({
            stampUs: chunk.stampUs,
            frames: chunk.frames,
            rate: chunk.rate,
            deliveredMs: chunk.deliveredMs,
          })),
          replayEvents: replayEvents(record.events),
          join: {
            pass: gate.join.pass,
            programId: gate.join.programId,
            pairs: gate.join.pairs,
            failures: gate.join.failures,
            telemetry: gate.join.telemetry,
          },
          evidence: gate.evidence,
        })
      );
      await writeFile(
        `${receipt}-measured-left.f32`,
        new Uint8Array(gatedChannel(record, gate.join, 'left').buffer)
      );
      await writeFile(
        `${receipt}-measured-right.f32`,
        new Uint8Array(gatedChannel(record, gate.join, 'right').buffer)
      );

      console.log(
        `OTIO_PRIMER_AUDIO ${JSON.stringify({
          arm,
          round,
          earlyStart,
          failures: allFailures.length,
          join: {
            pass: gate.join.pass,
            pairs: gate.join.pairs.length,
            programId: gate.join.programId,
          },
          telemetry: gate.join.telemetry,
          left: summarise(gate.evidence?.left),
          right: summarise(gate.evidence?.right),
        })}`
      );

      if (earlyStart) return { failures, controlFailures };
      return { failures: allFailures, controlFailures: [] };
    } finally {
      await page.close();
    }
  } finally {
    await input.router.activate(input.restoreBuild);
  }
}

/**
 * Runs both sampled audio arms over AUDIO_ROUNDS, interleaved, then one extra early-start control
 * in the prepared flow. Returns one stage per arm.
 */
export async function runAudioArm(
  input: AudioArmInput
): Promise<PrimerStage[]> {
  // The audio arm must run the production build as shipped. Any emit recorder in it is a failure.
  const uninstrumented = await readBuild(input.uninstrumentedBuild);
  for (const [name, bytes] of uninstrumented)
    if (latin1(bytes).includes(PROOF_GLOBAL))
      throw new Error(
        `${input.uninstrumentedBuild.name} ${name} contains the emit recorder; the audio arm must use the production build`
      );
  const failures: Record<AudioArm, string[]> = {
    prepared: [],
    'first-click': [],
  };
  const errors: Record<AudioArm, string[]> = {
    prepared: [],
    'first-click': [],
  };
  const trial = (
    arm: AudioArm,
    round: number,
    run: () => Promise<TrialOutcome>
  ) =>
    run().then(
      (outcome) => {
        failures[arm].push(...outcome.failures, ...outcome.controlFailures);
      },
      (error: unknown) => {
        errors[arm].push(
          `round ${round}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    );

  for (let round = 0; round < AUDIO_ROUNDS; round++) {
    for (const arm of round % 2 === 0
      ? (['prepared', 'first-click'] as const)
      : (['first-click', 'prepared'] as const)) {
      await trial(arm, round, () => runAudioTrial(arm, round, false, input));
    }
  }
  // The early-start control is an extra trial in the prepared flow. Its own gate outcome is not
  // added to the stage. Only its control strings and its served-build and primer checks are.
  await trial('prepared', -1, () => runAudioTrial('prepared', -1, true, input));

  return [
    {
      stage: PREPARED_STAGE,
      failures: [...errors.prepared, ...failures.prepared],
      trials: [],
    },
    {
      stage: FIRST_CLICK_STAGE,
      failures: [...errors['first-click'], ...failures['first-click']],
      trials: [],
    },
  ];
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
    silentRuns: evidence.silentRuns,
  };
}
