import { describe, expect, test } from 'bun:test';

const bridgeUrl = new URL('../src/otio-video-timing.ts', import.meta.url).href;

describe('OTIO timing bridge', () => {
  test('imports and reports worker-unavailable without constructing a Worker', () => {
    // A child process is the only honest way to exercise a no-Worker import
    // boundary without replacing this test process's global Worker.
    const script = [
      'globalThis.Worker = undefined;',
      `const bridge = await import(${JSON.stringify(bridgeUrl)});`,
      "const result = await bridge.readOtioVideoTiming(new Blob(['inert']), 'video/mp4');",
      "if (result.kind !== 'unknown' || result.reason !== 'worker-unavailable') process.exit(1);",
    ].join('\n');
    const child = Bun.spawnSync([process.execPath, '--eval', script]);

    expect(child.exitCode).toBe(0);
  });
});
