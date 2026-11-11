/**
 * One focused diagnostic: does the default output of an owned headless bare `none` page go quiet
 * after the program's metadata loads, and how long is it held running before that?
 *
 * It is not a proof stage and gates nothing. It never reads the user's browser and never writes to
 * any live system. Sequence:
 *   1. two OS readings of the default output before navigation, 250 ms apart. Both must read idle
 *      on the same device, or the run stops and reports the state it found;
 *   2. one bare `none` navigation in an owned chrome-headless-shell with Chrome's --mute-audio,
 *      served from loopback, while a poller reads the OS every ~25 ms from before navigation;
 *   3. a Chrome trace started after the navigation commits, with a trace-start mark. Device events
 *      are reported from it. Trace events from before the commit are not visible to this run;
 *   4. after metadata first reads ready, the first running reading, then the first pair of
 *      consecutive idle readings on the same device, within DEVICE_IDLE_LIMIT_MS of metadata.
 *
 * Resolution: the hold is bounded by reading times, not measured exactly. The window reported is
 * [last running reading, first idle reading], both relative to metadata.
 *
 * Run (from the repository root, on this Mac only):
 *   RELIC_OTIO_CHROME_PATH=<owned chrome-headless-shell> \
 *   RELIC_OTIO_DIAG_PROGRAM_MP4=<positive program MP4 the bare arms play> \
 *   mise exec -- bun packages/relic-mcp/test/otio-program-idle-diagnostic.ts
 *
 * Exit 0 only for a measured quiet window. Every other verdict exits 1 and prints why.
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDeviceProbe,
  DEVICE_IDLE_LIMIT_MS,
  type DeviceProbe,
  readDeviceState,
} from './otio-program-device-state.ts';
import { bareHtml } from './otio-program-primer-controls.ts';
import {
  DEVICE_CALLBACK_EVENT,
  DEVICE_START_EVENT,
  markTs,
  PRIMER_TRACE_CATEGORIES,
  STREAM_CREATION_EVENTS,
  TRACE_START_MARK,
  type TraceEvent,
} from './otio-program-trace.ts';
import { openViewer, type ViewerPage } from './otio-program-viewer.ts';

const PRE_NAV_READINGS = 2;
const PRE_NAV_SPACING_MS = 250;
const SAMPLE_MS = 25;
const METADATA_POLL_MS = 25;
const VERDICT_POLL_MS = 100;

export interface DeviceSample {
  /** Milliseconds from the start of the run, taken before the OS read was issued. */
  readonly atMs: number;
  readonly readMs: number;
  readonly deviceId: number | null;
  readonly name: string | null;
  readonly running: boolean | null;
  readonly error: string | null;
}

export type HoldVerdict =
  | 'quiet'
  | 'not-quiet'
  | 'never-running-after-metadata'
  | 'device-changed';

export interface Hold {
  readonly verdict: HoldVerdict;
  readonly deviceId: number | null;
  readonly deviceName: string | null;
  readonly runningFirstMs: number | null;
  readonly runningLastBeforeQuietMs: number | null;
  readonly quietFirstIdleMs: number | null;
  readonly quietSecondIdleMs: number | null;
  /** Hold window relative to metadata: the device was running at some point in [from, to]. */
  readonly holdAfterMetadataMs: {
    readonly from: number;
    readonly to: number;
  } | null;
  readonly errorReadings: number;
}

const EMPTY_HOLD = {
  deviceId: null,
  deviceName: null,
  runningFirstMs: null,
  runningLastBeforeQuietMs: null,
  quietFirstIdleMs: null,
  quietSecondIdleMs: null,
  holdAfterMetadataMs: null,
} as const;

/**
 * Pure. Looks at readings from metadata onward. A quiet verdict needs a running reading first,
 * then two adjacent idle readings on the same device with no read error between them. A device
 * change anywhere in the run is its own verdict, never quiet.
 */
export function analyseHold(
  samples: readonly DeviceSample[],
  metadataAtMs: number
): Hold {
  const tail = samples.filter((s) => s.atMs >= metadataAtMs);
  const errorReadings = tail.filter((s) => s.error !== null).length;
  const ok = tail.filter((s) => s.error === null);
  const deviceId = ok[0]?.deviceId ?? null;
  const deviceName = ok[0]?.name ?? null;
  let runningFirst: DeviceSample | null = null;
  let runningLast: DeviceSample | null = null;
  for (let i = 0; i < tail.length; i++) {
    const s = tail[i]!;
    if (s.error !== null) continue;
    if (s.deviceId !== deviceId)
      return {
        ...EMPTY_HOLD,
        verdict: 'device-changed',
        deviceId,
        deviceName,
        errorReadings,
      };
    if (s.running === true) {
      runningFirst ??= s;
      runningLast = s;
      continue;
    }
    if (runningFirst === null) continue;
    const next = tail[i + 1];
    if (
      next !== undefined &&
      next.error === null &&
      next.running === false &&
      next.deviceId === deviceId
    ) {
      return {
        verdict: 'quiet',
        deviceId,
        deviceName,
        runningFirstMs: runningFirst.atMs - metadataAtMs,
        runningLastBeforeQuietMs: runningLast!.atMs - metadataAtMs,
        quietFirstIdleMs: s.atMs - metadataAtMs,
        quietSecondIdleMs: next.atMs - metadataAtMs,
        holdAfterMetadataMs: {
          from: runningLast!.atMs - metadataAtMs,
          to: s.atMs - metadataAtMs,
        },
        errorReadings,
      };
    }
  }
  if (runningFirst === null)
    return {
      ...EMPTY_HOLD,
      verdict: 'never-running-after-metadata',
      deviceId,
      deviceName,
      errorReadings,
    };
  return {
    ...EMPTY_HOLD,
    verdict: 'not-quiet',
    deviceId,
    deviceName,
    runningFirstMs: runningFirst.atMs - metadataAtMs,
    runningLastBeforeQuietMs: runningLast!.atMs - metadataAtMs,
    errorReadings,
  };
}

async function sampleAt(probe: DeviceProbe, t0: number): Promise<DeviceSample> {
  const started = Date.now();
  try {
    const state = await readDeviceState(probe);
    return {
      atMs: started - t0,
      readMs: Date.now() - started,
      deviceId: state.deviceId,
      name: state.name,
      running: state.running,
      error: null,
    };
  } catch (error) {
    return {
      atMs: started - t0,
      readMs: Date.now() - started,
      deviceId: null,
      name: null,
      running: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Idle twice before navigation, on the same device. Returns the reason it is not, or null. */
function preNavigationProblem(
  readings: readonly DeviceSample[]
): string | null {
  if (readings.some((s) => s.error !== null))
    return `pre-navigation read failed: ${readings.find((s) => s.error !== null)?.error}`;
  if (readings.some((s) => s.running !== false))
    return 'default output running before navigation';
  if (readings[0]!.deviceId !== readings[readings.length - 1]!.deviceId)
    return 'default output changed before navigation';
  return null;
}

interface Transition {
  readonly atMs: number;
  readonly running: boolean;
  readonly deviceId: number;
  readonly name: string;
}

/** Each change of running state or device, in order. Read errors are counted, not transitions. */
function transitionsOf(samples: readonly DeviceSample[]): Transition[] {
  const out: Transition[] = [];
  let last: Pick<Transition, 'running' | 'deviceId'> | null = null;
  for (const s of samples) {
    if (s.error !== null || s.running === null || s.deviceId === null) continue;
    if (
      last === null ||
      last.running !== s.running ||
      last.deviceId !== s.deviceId
    ) {
      out.push({
        atMs: s.atMs,
        running: s.running,
        deviceId: s.deviceId,
        name: s.name ?? '',
      });
      last = { running: s.running, deviceId: s.deviceId };
    }
  }
  return out;
}

interface TraceSummary {
  readonly truncated: boolean;
  readonly markFound: boolean;
  readonly traceStartAtMs: number;
  /** Per device-side event name: count, and first and last time relative to the run start. */
  readonly events: Record<
    string,
    { count: number; firstAtMs: number | null; lastAtMs: number | null }
  >;
}

function traceSummary(
  events: readonly TraceEvent[],
  truncated: boolean,
  traceStartAtMs: number
): TraceSummary {
  const markAt = markTs(events, TRACE_START_MARK);
  const names = [
    DEVICE_START_EVENT,
    ...STREAM_CREATION_EVENTS,
    DEVICE_CALLBACK_EVENT,
  ];
  const summarised: TraceSummary['events'] = {};
  for (const name of names) {
    const times = events
      .filter((e) => e.name === name)
      .map((e) => e.ts)
      .sort((a, b) => a - b);
    const wall = (ts: number) =>
      markAt === null ? null : traceStartAtMs + (ts - markAt) / 1000;
    summarised[name] = {
      count: times.length,
      firstAtMs: times[0] === undefined ? null : wall(times[0]),
      lastAtMs: times.length === 0 ? null : wall(times[times.length - 1]!),
    };
  }
  return {
    truncated,
    markFound: markAt !== null,
    traceStartAtMs,
    events: summarised,
  };
}

export interface DiagnosticReport {
  readonly verdict:
    | HoldVerdict
    | 'running-before-navigation'
    | 'read-failed'
    | 'no-metadata'
    | 'pre-navigation-problem';
  readonly problem: string | null;
  readonly preNavigation: readonly DeviceSample[];
  readonly navigationAtMs: number | null;
  readonly metadataAtMs: number | null;
  readonly hold: Hold | null;
  readonly transitions: readonly Transition[];
  readonly trace: TraceSummary | null;
  readonly receipt: string;
}

async function runDiagnostic(
  probe: DeviceProbe,
  origin: string,
  scratch: string
): Promise<DiagnosticReport> {
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const preNavigation: DeviceSample[] = [];
  for (let i = 0; i < PRE_NAV_READINGS; i++) {
    if (i > 0) await Bun.sleep(PRE_NAV_SPACING_MS);
    preNavigation.push(await sampleAt(probe, t0));
  }
  const problem = preNavigationProblem(preNavigation);
  if (problem !== null) {
    const verdict = problem.startsWith('pre-navigation read failed')
      ? 'read-failed'
      : problem.includes('running')
        ? 'running-before-navigation'
        : 'pre-navigation-problem';
    return finish(
      {
        verdict,
        problem,
        preNavigation,
        navigationAtMs: null,
        metadataAtMs: null,
        hold: null,
        transitions: transitionsOf(preNavigation),
        trace: null,
      },
      scratch,
      []
    );
  }

  const samples: DeviceSample[] = [...preNavigation];
  let polling = true;
  const poller = (async () => {
    while (polling) {
      samples.push(await sampleAt(probe, t0));
      await Bun.sleep(SAMPLE_MS);
    }
  })();

  const navigationAtMs = at();
  const page: ViewerPage = await openViewer({
    url: `${origin}/?arm=none`,
    origin,
    sessionToken: 'idle-diagnostic',
  });
  let metadataAtMs: number | null = null;
  let hold: Hold | null = null;
  let traceStartAtMs = 0;
  let traced: { events: unknown[]; truncated: boolean } | null = null;
  let traceStarted = false;
  try {
    await page.startPerformanceTrace(PRIMER_TRACE_CATEGORIES);
    traceStarted = true;
    await page.evaluate(
      `performance.mark(${JSON.stringify(TRACE_START_MARK)})`
    );
    traceStartAtMs = at();
    const metadataLimit = Date.now() + DEVICE_IDLE_LIMIT_MS;
    while (metadataAtMs === null && Date.now() < metadataLimit) {
      const ready = await page.evaluate<boolean>(
        `document.querySelector('video.otio-program-video')?.readyState >= 1`
      );
      if (ready) metadataAtMs = at();
      else await Bun.sleep(METADATA_POLL_MS);
    }
    if (metadataAtMs !== null) {
      const limit = metadataAtMs + DEVICE_IDLE_LIMIT_MS;
      hold = analyseHold(samples, metadataAtMs);
      while (
        hold.verdict !== 'quiet' &&
        hold.verdict !== 'device-changed' &&
        at() < limit
      ) {
        await Bun.sleep(VERDICT_POLL_MS);
        hold = analyseHold(samples, metadataAtMs);
      }
    }
  } finally {
    polling = false;
    await poller;
    if (traceStarted) traced = await page.stopPerformanceTrace();
    await page.close();
  }

  const trace =
    traced === null
      ? null
      : traceSummary(
          traced.events as TraceEvent[],
          traced.truncated,
          traceStartAtMs
        );
  const verdict: DiagnosticReport['verdict'] =
    metadataAtMs === null ? 'no-metadata' : hold!.verdict;
  return finish(
    {
      verdict,
      problem: null,
      preNavigation,
      navigationAtMs,
      metadataAtMs,
      hold,
      transitions: transitionsOf(samples),
      trace,
    },
    scratch,
    samples
  );
}

async function finish(
  body: Omit<DiagnosticReport, 'receipt'>,
  scratch: string,
  samples: readonly DeviceSample[]
): Promise<DiagnosticReport> {
  const receipt = join(scratch, 'idle-diagnostic.json');
  const full = { ...body, samples, receipt };
  await writeFile(receipt, JSON.stringify(full, null, 2));
  return { ...body, receipt };
}

async function main(): Promise<void> {
  const chrome = process.env['RELIC_OTIO_CHROME_PATH'];
  if (!chrome)
    throw new Error(
      'RELIC_OTIO_CHROME_PATH must name the owned chrome-headless-shell; this diagnostic never falls back to an installed Chrome'
    );
  const programPath = process.env['RELIC_OTIO_DIAG_PROGRAM_MP4'];
  if (!programPath)
    throw new Error(
      'RELIC_OTIO_DIAG_PROGRAM_MP4 must name the positive program MP4 that the bare arms play'
    );
  const scratch = await mkdtemp(join(tmpdir(), 'relic-otio-idle-diag-'));
  const program = await readFile(programPath);
  const programSha256 = createHash('sha256').update(program).digest('hex');
  const html = bareHtml('none', programSha256);
  const probe = await buildDeviceProbe(scratch);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/program.mp4')
        return new Response(program, {
          headers: { 'content-type': 'video/mp4' },
        });
      if (url.pathname === '/' && url.searchParams.get('arm') === 'none')
        return new Response(html, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      return new Response('not found', { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    const report = await runDiagnostic(probe, origin, scratch);
    console.log(`OTIO_IDLE_DIAGNOSTIC ${JSON.stringify(report)}`);
    process.exitCode = report.verdict === 'quiet' ? 0 : 1;
  } finally {
    await server.stop(true);
  }
}

if (import.meta.main) await main();
