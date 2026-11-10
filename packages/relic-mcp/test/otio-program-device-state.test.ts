import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEVICE_IDLE_LIMIT_MS,
  type DeviceProbe,
  type DeviceState,
  parseDeviceState,
  readDeviceState,
  waitForDeviceIdle,
} from './otio-program-device-state.ts';

const root = await mkdtemp(join(tmpdir(), 'device-state-'));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const SPEAKERS: DeviceState = {
  deviceId: 73,
  name: 'MacBook Pro Speakers',
  running: false,
};

/** A stand-in helper that prints `stdout`, writes `stderr`, and exits with `code`. */
async function fakeProbe(
  stdout: string,
  stderr: string,
  code: number
): Promise<DeviceProbe> {
  const dir = await mkdtemp(join(root, 'probe-'));
  const out = join(dir, 'out');
  const err = join(dir, 'err');
  const binary = join(dir, 'probe');
  await Bun.write(out, stdout);
  await Bun.write(err, stderr);
  await Bun.write(
    binary,
    `#!/bin/sh\ncat '${out}'\ncat '${err}' >&2\nexit ${code}\n`
  );
  await chmod(binary, 0o755);
  return { binary };
}

describe('parseDeviceState', () => {
  test('reads an idle device', () => {
    const line = `${JSON.stringify(SPEAKERS)}\n`;
    expect(parseDeviceState(line)).toEqual(SPEAKERS);
  });

  test('reads a running device and a name needing escapes', () => {
    const name = 'Jason\'s "Desk" \u00e9 \u97f3';
    const line = `${JSON.stringify({ deviceId: 1, name, running: true })}\n`;
    expect(parseDeviceState(line)).toEqual({
      deviceId: 1,
      name,
      running: true,
    });
  });

  test('accepts the line without a trailing newline', () => {
    expect(parseDeviceState(JSON.stringify(SPEAKERS))).toEqual(SPEAKERS);
  });

  const malformed: Array<[string, string]> = [
    ['empty output', ''],
    ['only a newline', '\n'],
    ['not JSON', 'not json\n'],
    ['two lines', `${JSON.stringify(SPEAKERS)}\n${JSON.stringify(SPEAKERS)}\n`],
    [
      'trailing text after the object',
      `${JSON.stringify(SPEAKERS)} trailing\n`,
    ],
    ['an array', '[1,2,3]\n'],
    ['null', 'null\n'],
    ['a string', '"MacBook Pro Speakers"\n'],
    ['missing running', '{"deviceId":73,"name":"x"}\n'],
    ['missing name', '{"deviceId":73,"running":true}\n'],
    ['an extra key', '{"deviceId":73,"name":"x","running":true,"extra":1}\n'],
    ['negative deviceId', '{"deviceId":-1,"name":"x","running":true}\n'],
    ['fractional deviceId', '{"deviceId":1.5,"name":"x","running":true}\n'],
    ['string deviceId', '{"deviceId":"73","name":"x","running":true}\n'],
    [
      'unsafe integer deviceId',
      '{"deviceId":9007199254740993,"name":"x","running":true}\n',
    ],
    ['empty name', '{"deviceId":73,"name":"","running":true}\n'],
    ['numeric name', '{"deviceId":73,"name":7,"running":true}\n'],
    ['numeric running', '{"deviceId":73,"name":"x","running":1}\n'],
    ['string running', '{"deviceId":73,"name":"x","running":"false"}\n'],
    ['null running', '{"deviceId":73,"name":"x","running":null}\n'],
  ];
  for (const [label, text] of malformed) {
    test(`rejects ${label}`, () => {
      expect(() => parseDeviceState(text)).toThrow();
    });
  }
});

describe('readDeviceState', () => {
  test('returns the helper report on a clean exit', async () => {
    const probe = await fakeProbe(`${JSON.stringify(SPEAKERS)}\n`, '', 0);
    expect(await readDeviceState(probe)).toEqual(SPEAKERS);
  });

  test('throws on a nonzero exit and carries the helper message', async () => {
    const probe = await fakeProbe(
      '',
      'default output lookup failed: OSStatus 2003',
      1
    );
    await expect(readDeviceState(probe)).rejects.toThrow(
      /device probe exited 1: default output lookup failed/
    );
  });

  test('throws on a clean exit with empty output', async () => {
    const probe = await fakeProbe('', '', 0);
    await expect(readDeviceState(probe)).rejects.toThrow();
  });

  test('throws on a clean exit with malformed output', async () => {
    const probe = await fakeProbe('{"deviceId":73}\n', '', 0);
    await expect(readDeviceState(probe)).rejects.toThrow();
  });
});

describe('waitForDeviceIdle', () => {
  const probe: DeviceProbe = { binary: '/unused' };

  /** A fake clock whose `sleep` advances time, and a scripted sequence of readings. */
  function fakeClock(start: number) {
    let t = start;
    const sleeps: number[] = [];
    return {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
      sleeps,
    };
  }

  function scripted(states: Array<DeviceState | Error>) {
    const queue = [...states];
    return async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('script exhausted');
      if (next instanceof Error) throw next;
      return next;
    };
  }

  test('returns at once when the device is already idle', async () => {
    const clock = fakeClock(1_000);
    const reading = await waitForDeviceIdle(probe, 1_000, {
      read: scripted([SPEAKERS]),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(reading).toEqual({ ...SPEAKERS, idleAfterMs: 0 });
    expect(clock.sleeps).toEqual([]);
  });

  test('polls every 250 ms until the device goes idle', async () => {
    const busy = { ...SPEAKERS, running: true };
    const clock = fakeClock(0);
    const reading = await waitForDeviceIdle(probe, 0, {
      read: async () => (clock.now() < 500 ? busy : SPEAKERS),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(reading).toEqual({ ...SPEAKERS, idleAfterMs: 500 });
    expect(clock.sleeps).toEqual([250, 250]);
  });

  test('fails at the limit with the device name and elapsed time', async () => {
    const busy = { ...SPEAKERS, running: true };
    const clock = fakeClock(0);
    await expect(
      waitForDeviceIdle(probe, 0, {
        read: async () => busy,
        now: clock.now,
        sleep: clock.sleep,
      })
    ).rejects.toThrow(
      `default output MacBook Pro Speakers still running ${DEVICE_IDLE_LIMIT_MS} ms after load`
    );
    expect(clock.now()).toBe(DEVICE_IDLE_LIMIT_MS);
  });

  test('fails when the default device changes during the wait', async () => {
    const airpods: DeviceState = {
      deviceId: 91,
      name: 'AirPods Pro',
      running: false,
    };
    const clock = fakeClock(0);
    await expect(
      waitForDeviceIdle(probe, 0, {
        read: scripted([{ ...SPEAKERS, running: true }, airpods]),
        now: clock.now,
        sleep: clock.sleep,
      })
    ).rejects.toThrow(
      'default output changed from MacBook Pro Speakers to AirPods Pro during the idle wait'
    );
  });

  test('fails when the device changes even while the new one is idle', async () => {
    const clock = fakeClock(0);
    await expect(
      waitForDeviceIdle(probe, 0, {
        read: scripted([
          { ...SPEAKERS, running: true },
          { deviceId: 74, name: 'HDMI', running: false },
        ]),
        now: clock.now,
        sleep: clock.sleep,
      })
    ).rejects.toThrow('changed from MacBook Pro Speakers to HDMI');
  });

  test('propagates a failed read', async () => {
    const clock = fakeClock(0);
    await expect(
      waitForDeviceIdle(probe, 0, {
        read: scripted([new Error('device probe exited 1: no stderr')]),
        now: clock.now,
        sleep: clock.sleep,
      })
    ).rejects.toThrow('device probe exited 1');
  });
});
