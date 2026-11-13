import { expect, test } from 'bun:test';
import {
  createOtioTransportGate,
  OtioGateModuleLoadError,
  OtioGatePreconstructionError,
} from '../src/otio-transport-gate';
import { fakeGateContext, FakeGateNode } from './otio-transport-gate-fixture';

test('module load failure is classified before node construction', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.AudioWorkletNode;
  let constructed = false;
  globals.AudioWorkletNode = class {
    constructor() {
      constructed = true;
    }
  };
  try {
    const cause = new Error('module unavailable');
    const context = {
      state: 'suspended',
      sampleRate: 48000,
      currentTime: 0,
      audioWorklet: {
        addModule: async () => {
          throw cause;
        },
      },
    } as unknown as AudioContext;
    const error = await createOtioTransportGate(context, () => {}, undefined, {
      mode: 'frozen',
      initialFrame: 0,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(OtioGateModuleLoadError);
    expect(error).toBeInstanceOf(OtioGatePreconstructionError);
    expect((error as Error).cause).toBe(cause);
    expect(constructed).toBe(false);
  } finally {
    globals.AudioWorkletNode = original;
  }
});

test('repeated context changes during module loading fail before node construction', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.AudioWorkletNode;
  let constructed = 0;
  globals.AudioWorkletNode = class {
    constructor() {
      constructed++;
    }
  };
  try {
    for (let i = 0; i < 24; i++) {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const context = {
        state: 'suspended',
        sampleRate: 48000,
        currentTime: 0,
        audioWorklet: { addModule: () => blocked },
      };
      const constructing = createOtioTransportGate(
        context as unknown as AudioContext,
        () => {},
        undefined,
        { mode: 'frozen', initialFrame: 0 }
      );
      if (i % 2 === 0) context.state = 'running';
      else context.currentTime = 1 / 48000;
      release();
      await expect(constructing).rejects.toBeInstanceOf(
        OtioGatePreconstructionError
      );
      expect(constructed).toBe(0);
    }
  } finally {
    globals.AudioWorkletNode = original;
  }
});

test('repeated disposal waits for render-thread retirement and removes its silent route', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.AudioWorkletNode;
  const sent: unknown[] = [];
  let sinkDisconnects = 0;
  class Node {
    parameters = new Map(
      ['clockFrameA', 'clockTagA', 'clockFrameB', 'clockTagB'].map((name) => [
        name,
        {
          cancelScheduledValues() {},
          setValueAtTime() {},
          linearRampToValueAtTime() {},
        },
      ])
    );
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onmessageerror: null,
      postMessage: (value: unknown) => sent.push(value),
      close: () => {},
    };
    onprocessorerror = null;
    disconnects = 0;
    connect(_sink: unknown) {}
    disconnect() {
      this.disconnects++;
    }
  }
  globals.AudioWorkletNode = Node;
  const context = {
    state: 'suspended',
    sampleRate: 48000,
    currentTime: 0,
    audioWorklet: { addModule: async () => {} },
    destination: {},
    createBuffer: (_channels: number, frames: number) => ({
      getChannelData: () => new Float32Array(frames),
    }),
    createBufferSource: () => ({
      buffer: null,
      playbackRate: { value: 1 },
      detune: { value: 0 },
      onended: null,
      connect() {},
      disconnect() {},
      start() {},
      stop() {},
    }),
    createGain: () => ({
      gain: { value: 1 },
      connect: (_destination: unknown) => {},
      disconnect: () => {
        sinkDisconnects++;
      },
    }),
  } as unknown as AudioContext;
  try {
    for (let i = 0; i < 20; i++) {
      const gate = await createOtioTransportGate(context, () => {}, undefined, {
        mode: 'frozen',
        initialFrame: 0,
      });
      const node = gate.node as unknown as Node;
      const retirement = gate.dispose();
      expect(gate.dispose()).toBe(retirement);
      expect(sent[sent.length - 1]).toEqual({
        type: 'dispose',
        clockEpoch: gate.clockEpoch,
      });
      expect(node.disconnects).toBe(0);
      let resolved = false;
      void retirement.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      node.port.onmessage?.({
        data: { type: 'disposed', clockEpoch: gate.clockEpoch },
      });
      await retirement;
      expect(node.disconnects).toBe(1);
      expect(sinkDisconnects).toBe(i + 1);
    }
  } finally {
    globals.AudioWorkletNode = original;
  }
});

test('carrier credit survives gate disposal until source ended', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.AudioWorkletNode;
  globals.AudioWorkletNode = FakeGateNode;
  const source = {
    buffer: null as unknown,
    playbackRate: { value: 1 },
    detune: { value: 0 },
    onended: null as (() => void) | null,
    stops: 0,
    connect() {},
    disconnect() {},
    start() {},
    stop() {
      this.stops++;
    },
  };
  let releases = 0;
  const context = {
    ...fakeGateContext(),
    createBufferSource: () => source,
  } as unknown as AudioContext;
  try {
    const gate = await createOtioTransportGate(
      context,
      () => {},
      undefined,
      { mode: 'frozen', initialFrame: 0 },
      undefined,
      () => {
        releases++;
      }
    );
    const node = gate.node as unknown as FakeGateNode;
    node.emit({
      type: 'anchor-certified',
      clockEpoch: gate.clockEpoch,
      firstFrame: 0,
      lastCertifiedEnd: 256,
      sampleCount: 256,
      callbackOrdinal: 2,
      quantumLength: 128,
      bankSerial: 1,
      clockCoverageEnd: 63488,
    });
    await gate.ready();
    expect(source.stops).toBe(1);
    expect(releases).toBe(0);
    const retired = gate.dispose();
    node.emit({ type: 'disposed', clockEpoch: gate.clockEpoch });
    await retired;
    expect(source.stops).toBe(1);
    expect(releases).toBe(0);
    source.onended?.();
    expect(releases).toBe(1);
    expect(source.buffer).toBeNull();
  } finally {
    globals.AudioWorkletNode = original;
  }
});
