import { describe, expect, test } from 'bun:test';
import type { OtioVideoTiming } from '../src/otio-video-timing.ts';
import { scanOtioVideoTiming } from '../src/otio-video-timing-scanner.ts';

const fixtureRoot = new URL(
  '../../relic-format/test/fixtures/otio/decoder-boundary.otiod/',
  import.meta.url
).pathname;

type OraclePacket = {
  readonly pts: number | string;
  readonly duration: number | string;
};

type OracleFile = {
  readonly stream: { readonly time_base: string };
  readonly packets: readonly OraclePacket[];
};

type TimingOracle = {
  readonly files: Record<string, OracleFile>;
};

type Window = readonly [number, number];

function seconds(value: number | string, timeBase: string): number {
  const [numeratorText, denominatorText, extra] = timeBase.split('/');
  if (!numeratorText || !denominatorText || extra !== undefined) {
    throw new Error(`invalid ffprobe time base: ${timeBase}`);
  }
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  const ticks = Number(value);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    !Number.isFinite(ticks) ||
    denominator <= 0
  ) {
    throw new Error(`invalid ffprobe packet timing: ${String(value)}@${timeBase}`);
  }
  return (ticks * numerator) / denominator;
}

function oracleWindows(file: OracleFile, includeTerminal: boolean): Window[] {
  const packets = file.packets
    .map((packet) => ({
      pts: seconds(packet.pts, file.stream.time_base),
      duration: seconds(packet.duration, file.stream.time_base),
    }))
    .sort((left, right) => left.pts - right.pts);
  const windows: Window[] = [];

  for (let index = 0; index < packets.length; index += 1) {
    const packet = packets[index];
    if (!packet) throw new Error('missing ffprobe packet');
    const next = packets[index + 1];
    if (!next && !includeTerminal) continue;
    const end = next
      ? Math.min(next.pts, packet.pts + packet.duration)
      : packet.pts + packet.duration;
    const start = Math.max(0, packet.pts);
    if (start < end) windows.push([start, end]);
  }
  return windows;
}

function certifiedWindows(timing: OtioVideoTiming): Window[] {
  if (timing.kind !== 'windows') {
    throw new Error(`expected certified windows, got ${timing.reason}`);
  }
  return Array.from(timing.starts, (start, index) => {
    const end = timing.ends[index];
    if (end === undefined) throw new Error('missing timing end');
    return [start, end] as const;
  });
}

function expectWindowsNear(actual: readonly Window[], expected: readonly Window[]): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    const actualWindow = actual[index];
    const expectedWindow = expected[index];
    if (!actualWindow || !expectedWindow) throw new Error('missing timing window');
    expect(actualWindow[0]).toBeCloseTo(expectedWindow[0], 10);
    expect(actualWindow[1]).toBeCloseTo(expectedWindow[1], 10);
  }
}

function mimeType(name: string): string {
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.mov')) return 'video/quicktime';
  return 'video/mp4';
}

async function timingFor(name: string): Promise<OtioVideoTiming> {
  const bytes = await Bun.file(`${fixtureRoot}media/${name}`).arrayBuffer();
  return scanOtioVideoTiming(new Blob([bytes], { type: mimeType(name) }), mimeType(name));
}

async function oracle(): Promise<TimingOracle> {
  return Bun.file(`${fixtureRoot}timing-oracle.json`).json() as Promise<TimingOracle>;
}

describe('released Mediabunny scanner against independent synthetic ffprobe timing', () => {
  test('certifies actual packet windows for ordinary MP4, MOV, B-frame, WebM, and VFR media', async () => {
    const timingOracle = await oracle();
    for (const name of [
      'fr24.mp4',
      'fr60.mp4',
      'fr24b.mp4',
      'fr24b.mov',
      'fr30.webm',
      'vfr.mp4',
    ]) {
      const file = timingOracle.files[name];
      if (!file) throw new Error(`missing ffprobe oracle for ${name}`);
      expectWindowsNear(certifiedWindows(await timingFor(name)), oracleWindows(file, true));
    }
  });

  test('rejects the shortened rate-one edit rather than selecting past its declared end', async () => {
    await expect(timingFor('short-edit.mp4')).resolves.toEqual({
      kind: 'unknown',
      reason: 'edit-window-mismatch',
    });
  });

  test('does not certify multi-edit or rate-changed ISO files after a warning', async () => {
    for (const name of ['rate-edit.mp4', 'loop-edit.mp4']) {
      const timing = await timingFor(name);
      expect(timing.kind).toBe('unknown');
    }
  });

  test('keeps independently verified pre-terminal WebM windows and omits its unknown tail', async () => {
    const timingOracle = await oracle();
    const file = timingOracle.files['no-duration.webm'];
    if (!file) throw new Error('missing ffprobe oracle for no-duration.webm');
    expectWindowsNear(
      certifiedWindows(await timingFor('no-duration.webm')),
      oracleWindows(file, false)
    );
  });
});
