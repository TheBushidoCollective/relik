import { expect, test } from 'bun:test';
import {
  createOtioTransportGate,
  OtioGateModuleLoadError,
} from '../src/otio-transport-gate';

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
      audioWorklet: {
        addModule: async () => {
          throw cause;
        },
      },
    } as unknown as AudioContext;
    const error = await createOtioTransportGate(context, () => {}).catch(
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(OtioGateModuleLoadError);
    expect((error as Error).cause).toBe(cause);
    expect(constructed).toBe(false);
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
    audioWorklet: { addModule: async () => {} },
    destination: {},
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
      const gate = await createOtioTransportGate(context, () => {});
      const node = gate.node as unknown as Node;
      const command = gate.arm(i + 1, 0, 10);
      const retirement = gate.dispose();
      expect(gate.dispose()).toBe(retirement);
      await expect(command).rejects.toThrow('disposed');
      expect(sent[sent.length - 1]).toEqual({ type: 'dispose' });
      expect(node.disconnects).toBe(1);
      let resolved = false;
      void retirement.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      node.port.onmessage?.({ data: { type: 'disposed' } });
      await retirement;
      expect(node.disconnects).toBe(2);
      expect(sinkDisconnects).toBe(i + 1);
    }
  } finally {
    globals.AudioWorkletNode = original;
  }
});
