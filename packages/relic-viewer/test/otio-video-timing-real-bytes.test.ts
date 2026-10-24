import { describe, expect, test } from 'bun:test';
import type { OtioVideoTiming } from '../src/otio-video-timing.ts';
import { scanOtioVideoTiming } from '../src/otio-video-timing-scanner.ts';

const fixtureRoot = new URL(
  '../../relic-format/test/fixtures/otio/decoder-boundary.otiod/',
  import.meta.url
).pathname;

type OraclePacket = {
  readonly pts: number | string;
  readonly duration?: number | string | null;
};

type OracleFile = {
  readonly stream: { readonly time_base: string };
  readonly packets: readonly OraclePacket[];
};

type TimingOracle = {
  readonly files: Record<string, OracleFile>;
};

type PacketTiming = {
  readonly pts: number;
  readonly duration: number | null;
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
    throw new Error(
      `invalid ffprobe packet timing: ${String(value)}@${timeBase}`
    );
  }
  return (ticks * numerator) / denominator;
}

function oraclePackets(file: OracleFile): PacketTiming[] {
  const packets = file.packets
    .map((packet) => ({
      pts: seconds(packet.pts, file.stream.time_base),
      duration:
        packet.duration === undefined || packet.duration === null
          ? null
          : seconds(packet.duration, file.stream.time_base),
    }))
    .sort((left, right) => left.pts - right.pts);

  for (let index = 1; index < packets.length; index += 1) {
    const previous = packets[index - 1];
    const packet = packets[index];
    if (!previous || !packet || !(previous.pts < packet.pts)) {
      throw new Error('ffprobe packet PTS must be strictly increasing');
    }
  }
  return packets;
}

/**
 * The independent oracle supplies actual packet PTS. For non-terminal packets
 * their next PTS is the only portable upper boundary. ffprobe duration remains
 * evidence for the terminal bound, never a substitute for reader timing.
 */
function adjacentPtsWindows(file: OracleFile): Window[] {
  const packets = oraclePackets(file);
  const windows: Window[] = [];
  for (let index = 0; index + 1 < packets.length; index += 1) {
    const packet = packets[index];
    const next = packets[index + 1];
    if (!packet || !next) throw new Error('missing ffprobe packet');
    const start = Math.max(0, packet.pts);
    if (start < next.pts) windows.push([start, next.pts]);
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

function expectWindowsNear(
  actual: readonly Window[],
  expected: readonly Window[]
): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    const actualWindow = actual[index];
    const expectedWindow = expected[index];
    if (!actualWindow || !expectedWindow) {
      throw new Error('missing timing window');
    }
    expect(actualWindow[0]).toBeCloseTo(expectedWindow[0], 10);
    expect(actualWindow[1]).toBeCloseTo(expectedWindow[1], 10);
  }
}

function expectOrdinaryWindows(
  actual: readonly Window[],
  file: OracleFile
): void {
  const packets = oraclePackets(file);
  const finalPacket = packets[packets.length - 1];
  const finalWindow = actual[actual.length - 1];
  if (!finalPacket || !finalWindow) {
    throw new Error('ordinary fixture has no certified final packet window');
  }

  expectWindowsNear(actual.slice(0, -1), adjacentPtsWindows(file));
  expect(finalWindow[0]).toBeCloseTo(finalPacket.pts, 10);

  // A declared ISO edit may shorten the final interval. It cannot extend it
  // past an independently available positive terminal duration.
  if (
    finalPacket.duration !== null &&
    finalPacket.duration > 0 &&
    Number.isFinite(finalPacket.pts + finalPacket.duration)
  ) {
    expect(finalWindow[1]).toBeLessThanOrEqual(
      finalPacket.pts + finalPacket.duration + 1e-10
    );
  }
}

function mimeType(name: string): string {
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.mov')) return 'video/quicktime';
  return 'video/mp4';
}

async function timingFor(name: string): Promise<OtioVideoTiming> {
  const bytes = await Bun.file(`${fixtureRoot}media/${name}`).arrayBuffer();
  return scanOtioVideoTiming(
    new Blob([bytes], { type: mimeType(name) }),
    mimeType(name)
  );
}

async function oracle(): Promise<TimingOracle> {
  return Bun.file(
    `${fixtureRoot}media/timing-oracle.json`
  ).json() as Promise<TimingOracle>;
}

describe('released Mediabunny scanner against independent synthetic ffprobe timing', () => {
  test('certifies actual packet windows for ordinary MP4, MOV, B-frame, and VFR media', async () => {
    const timingOracle = await oracle();
    for (const name of [
      'fr24.mp4',
      'fr60.mp4',
      'fr24b.mp4',
      'fr24b.mov',
      'vfr.mp4',
    ]) {
      const file = timingOracle.files[name];
      if (!file) throw new Error(`missing ffprobe oracle for ${name}`);
      expectOrdinaryWindows(certifiedWindows(await timingFor(name)), file);
    }
  });

  test('keeps the released WebM packet duration only where the next PTS permits it', async () => {
    const timingOracle = await oracle();
    const file = timingOracle.files['fr30.webm'];
    if (!file) throw new Error('missing ffprobe oracle for fr30.webm');
    const ffprobePacket = oraclePackets(file).find(
      (packet) => Math.abs(packet.pts - 0.033) < 1e-10
    );
    if (!ffprobePacket || ffprobePacket.duration === null) {
      throw new Error('missing 33ms WebM packet');
    }

    // ffprobe's coarse 33ms duration is evidence, not a replacement for the
    // released reader's measured .034. The next actual PTS still makes 2/30
    // belong to [.033, .067).
    expect(ffprobePacket.duration).toBeCloseTo(0.033, 10);
    const target = 2 / 30;
    const matching = certifiedWindows(await timingFor('fr30.webm')).find(
      ([start, end]) => start <= target && target < end
    );
    if (!matching) {
      throw new Error('2/30 is not covered by a certified WebM window');
    }
    expect(matching[0]).toBeCloseTo(0.033, 10);
    expect(matching[1]).toBeCloseTo(0.067, 10);
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

  test('keeps an earlier no-duration WebM interval and leaves terminal PTS 2.967 uncovered', async () => {
    const timingOracle = await oracle();
    const file = timingOracle.files['no-duration.webm'];
    if (!file) throw new Error('missing ffprobe oracle for no-duration.webm');
    const actual = certifiedWindows(await timingFor('no-duration.webm'));
    expectWindowsNear(actual, adjacentPtsWindows(file));

    const packets = oraclePackets(file);
    const terminalPacket = packets[packets.length - 1];
    if (!terminalPacket) throw new Error('missing no-duration terminal packet');
    expect(terminalPacket.pts).toBeCloseTo(2.967, 10);
    expect(actual.length).toBeGreaterThan(0);
    expect(
      actual.some(
        ([start, end]) =>
          start <= terminalPacket.pts && terminalPacket.pts < end
      )
    ).toBe(false);
  });
});
