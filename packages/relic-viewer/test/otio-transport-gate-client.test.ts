import { expect, test } from 'bun:test';
import { createOtioTransportGate } from '../src/otio-transport-gate';

test('client bounds commands, joins stops and forwards render closures', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const original = globals.AudioWorkletNode;
  const sent: Array<Record<string, unknown>> = [];
  const closed: unknown[] = [];
  class Node {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onmessageerror: null,
      postMessage: (message: Record<string, unknown>) => sent.push(message),
      close: () => {},
    };
    onprocessorerror = null;
    disconnect() {}
  }
  let asset = '';
  globals.AudioWorkletNode = Node;
  try {
    const context = {
      audioWorklet: {
        addModule: async (url: string) => {
          asset = url;
        },
      },
    } as unknown as AudioContext;
    const gate = await createOtioTransportGate(context, (ack) =>
      closed.push(ack)
    );
    const node = gate.node as unknown as Node;
    expect(asset).toBe('/assets/otio-transport-gate-worklet.js');
    const arm = gate.arm(1, 10, 100);
    await expect(gate.extend(1, 100, 200)).rejects.toThrow('pending');
    node.port.onmessage?.({
      data: {
        type: 'arm',
        generation: 1,
        sequence: sent[0]?.sequence,
        accepted: true,
        throughFrame: 100,
        closedFrame: null,
      },
    });
    expect((await arm).accepted).toBe(true);
    const stop = gate.stop(1, 80);
    expect(gate.stop(1, 80)).toBe(stop);
    await expect(gate.stop(1, 81)).rejects.toThrow('Conflicting');
    const abort = gate.abort(1);
    expect(sent).toHaveLength(3);
    node.port.onmessage?.({
      data: {
        type: 'stop',
        generation: 1,
        sequence: sent[1]?.sequence,
        accepted: true,
        throughFrame: 80,
        closedFrame: null,
      },
    });
    node.port.onmessage?.({
      data: {
        type: 'abort',
        generation: 1,
        sequence: sent[2]?.sequence,
        accepted: true,
        throughFrame: 80,
        closedFrame: 20,
      },
    });
    await stop;
    await abort;
    node.port.onmessage?.({
      data: {
        type: 'closed',
        generation: 1,
        sequence: 3,
        accepted: true,
        throughFrame: 80,
        closedFrame: 80,
      },
    });
    expect(closed).toHaveLength(1);
    gate.dispose();
    await expect(gate.arm(2, 100, 200)).rejects.toThrow('disposed');
  } finally {
    globals.AudioWorkletNode = original;
  }
});
