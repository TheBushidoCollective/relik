/**
 * OS-level state of the output device the browser plays through.
 *
 * `otio-device-running.swift` reads kAudioDevicePropertyDeviceIsRunningSomewhere on the macOS
 * default output device. It is read-only: it writes no audio, sets no device property and opens
 * no stream. The proof uses it to learn whether anything (Chrome, another app) holds the output
 * before a trial begins. Any failure throws. A malformed reading is never treated as idle.
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DeviceProbe {
  /** Compiled helper in the caller's scratch directory. */
  readonly binary: string;
}

export interface DeviceState {
  readonly deviceId: number;
  readonly name: string;
  readonly running: boolean;
}

export interface IdleReading extends DeviceState {
  /** Milliseconds from load to the reading that found the device idle. */
  readonly idleAfterMs: number;
}

/** Longest the proof waits, from load, for the default output to go idle. */
export const DEVICE_IDLE_LIMIT_MS = 30_000;
export const DEVICE_POLL_MS = 250;

const SWIFT_SOURCE = fileURLToPath(
  new URL('./otio-device-running.swift', import.meta.url)
);
const COMPILE_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 5_000;
const DEVICE_KEYS = 'deviceId,name,running';

interface ChildResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Runs one command to exit. Only this child is ever signalled, and only if it outlives the
 * deadline or the caller unwinds before it exits. Nothing is matched by process name.
 */
async function runChild(
  cmd: string[],
  timeoutMs: number
): Promise<ChildResult> {
  const child = Bun.spawn(cmd, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}

function preview(text: string): string {
  const shown = text.length > 200 ? `${text.slice(0, 200)}...` : text;
  return JSON.stringify(shown);
}

/** Compiles the helper with `xcrun swiftc` into `scratch`. Throws if the compile fails. */
export async function buildDeviceProbe(scratch: string): Promise<DeviceProbe> {
  const binary = join(scratch, 'otio-device-running');
  const run = await runChild(
    ['xcrun', 'swiftc', SWIFT_SOURCE, '-o', binary],
    COMPILE_TIMEOUT_MS
  );
  if (run.timedOut) {
    throw new Error(`swiftc timed out after ${COMPILE_TIMEOUT_MS} ms`);
  }
  if (run.code !== 0) {
    const detail = run.stderr.trim() || run.stdout.trim();
    throw new Error(
      `swiftc failed (${run.code}) for ${SWIFT_SOURCE}: ${detail}`
    );
  }
  return { binary };
}

/**
 * Parses the helper's one-line report. Anything other than exactly one JSON object with
 * `deviceId` (a non-negative safe integer), `name` (a non-empty string) and `running` (a
 * boolean) throws.
 */
export function parseDeviceState(text: string): DeviceState {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (body.length === 0 || body.includes('\n')) {
    throw new Error(`device probe output must be one line: ${preview(text)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error(`device probe output is not JSON: ${preview(text)}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`device probe output is not an object: ${preview(text)}`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== DEVICE_KEYS) {
    throw new Error(
      `device probe output must have exactly ${DEVICE_KEYS}: ${preview(text)}`
    );
  }
  const { deviceId, name, running } = record;
  if (
    typeof deviceId !== 'number' ||
    !Number.isSafeInteger(deviceId) ||
    deviceId < 0
  ) {
    throw new Error(`device probe deviceId is invalid: ${preview(text)}`);
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`device probe name is invalid: ${preview(text)}`);
  }
  if (typeof running !== 'boolean') {
    throw new Error(`device probe running is not a boolean: ${preview(text)}`);
  }
  return { deviceId, name, running };
}

/** Reads the current default output's state. Throws on a bad exit, timeout or output. */
export async function readDeviceState(
  probe: DeviceProbe
): Promise<DeviceState> {
  const run = await runChild([probe.binary], PROBE_TIMEOUT_MS);
  if (run.timedOut) {
    throw new Error(`device probe timed out after ${PROBE_TIMEOUT_MS} ms`);
  }
  if (run.code !== 0) {
    throw new Error(
      `device probe exited ${run.code}: ${run.stderr.trim() || 'no stderr'}`
    );
  }
  return parseDeviceState(run.stdout);
}

export interface IdleDeps {
  readonly read?: (probe: DeviceProbe) => Promise<DeviceState>;
  /** Milliseconds on the same clock as `loadedAt`. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Polls the default output until nothing runs it. Throws when it is still running at
 * DEVICE_IDLE_LIMIT_MS after `loadedAt`, or when the default device changes during the wait.
 * A read that fails throws straight through.
 */
export async function waitForDeviceIdle(
  probe: DeviceProbe,
  loadedAt: number,
  deps: IdleDeps = {}
): Promise<IdleReading> {
  const read = deps.read ?? readDeviceState;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  let initial: DeviceState | undefined;
  for (;;) {
    const state = await read(probe);
    if (initial === undefined) {
      initial = state;
    } else if (state.deviceId !== initial.deviceId) {
      throw new Error(
        `default output changed from ${initial.name} to ${state.name} during the idle wait`
      );
    }
    const elapsed = now() - loadedAt;
    if (!state.running) return { ...state, idleAfterMs: elapsed };
    if (elapsed >= DEVICE_IDLE_LIMIT_MS) {
      throw new Error(
        `default output ${state.name} still running ${elapsed} ms after load`
      );
    }
    await sleep(DEVICE_POLL_MS);
  }
}
