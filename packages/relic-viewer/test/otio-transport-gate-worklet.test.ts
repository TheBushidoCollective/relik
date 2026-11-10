import { expect, test } from 'bun:test';

// Drive the actual processor with a render clock independent of message delivery.
test('processor seals the committed prefix while the main thread sends nothing', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    AudioWorkletProcessor: globals.AudioWorkletProcessor,
    registerProcessor: globals.registerProcessor,
    currentFrame: globals.currentFrame,
  };
  const messages: Array<Record<string, unknown>> = [];
  type ProcessorType = new () => {
    port: { onmessage: (event: { data: unknown }) => void };
    process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
  };
  const registration: { processor?: ProcessorType } = {};
  class FakeProcessor {
    port = {
      onmessage: (_event: { data: unknown }) => {},
      postMessage: (data: Record<string, unknown>) => messages.push(data),
    };
  }
  globals.AudioWorkletProcessor = FakeProcessor;
  globals.registerProcessor = (_name: string, processor: ProcessorType) => {
    registration.processor = processor;
  };
  globals.currentFrame = 0;
  try {
    // The worklet captures its globals during module evaluation, after the fake is installed.
    await import('../src/otio-transport-gate-worklet');
    if (!registration.processor) throw new Error('processor did not register');
    const processor = new registration.processor();
    processor.port.onmessage({
      data: { type: 'arm', generation: 1, sequence: 1, f0: 2, throughFrame: 6 },
    });
    expect(messages).toHaveLength(0);
    const rendered: number[] = [];
    for (let frame = 0; frame < 12; frame += 4) {
      globals.currentFrame = frame;
      const output = new Float32Array(4);
      processor.process([[new Float32Array([1, 1, 1, 1])]], [[output]]);
      rendered.push(...output);
    }
    expect(messages[0]?.accepted).toBe(true);
    expect(rendered).toEqual([0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
    expect(
      messages.find((message) => message.type === 'closed')?.closedFrame
    ).toBe(6);
    globals.currentFrame = 12;
    processor.port.onmessage({
      data: {
        type: 'extend',
        generation: 1,
        sequence: 2,
        expectedThroughFrame: 6,
        throughFrame: 30,
      },
    });
    const output = new Float32Array(4);
    processor.process([[new Float32Array([1, 1, 1, 1])]], [[output]]);
    expect(messages[messages.length - 1]?.accepted).toBe(false);
    expect(Array.from(output)).toEqual([0, 0, 0, 0]);
    for (const badFrame of [12, 20, 11, NaN]) {
      const faulted = new registration.processor();
      globals.currentFrame = 12;
      faulted.port.onmessage({
        data: {
          type: 'arm',
          generation: 1,
          sequence: 1,
          f0: 12,
          throughFrame: 30,
        },
      });
      const first = new Float32Array(4);
      expect(
        faulted.process([[new Float32Array([1, 1, 1, 1])]], [[first]])
      ).toBe(true);
      expect(Array.from(first)).toEqual([1, 1, 1, 1]);
      globals.currentFrame = badFrame;
      const beforeCommand = messages.length;
      faulted.port.onmessage({
        data: {
          type: 'extend',
          generation: 1,
          sequence: 2,
          expectedThroughFrame: 30,
          throughFrame: 40,
        },
      });
      expect(messages).toHaveLength(beforeCommand);
      const bad = new Float32Array([1, 1, 1, 1]);
      expect(faulted.process([[new Float32Array([1, 1, 1, 1])]], [[bad]])).toBe(
        false
      );
      expect(Array.from(bad)).toEqual([0, 0, 0, 0]);
      expect(messages[messages.length - 1]).toEqual({
        type: 'clock-fault',
        expectedFrame: 16,
        observedFrame: badFrame,
      });
      expect(messages).toHaveLength(beforeCommand + 1);
    }
    globals.currentFrame = 12;
    const overloaded = new registration.processor();
    const beforeOverflow = messages.length;
    for (let sequence = 1; sequence <= 3; sequence++) {
      overloaded.port.onmessage({
        data: {
          type: 'arm',
          generation: 1,
          sequence,
          f0: 12,
          throughFrame: 30,
        },
      });
    }
    const overflowOutput = new Float32Array([1, 1, 1, 1]);
    expect(
      overloaded.process([[new Float32Array([1, 1, 1, 1])]], [[overflowOutput]])
    ).toBe(false);
    expect(Array.from(overflowOutput)).toEqual([0, 0, 0, 0]);
    expect(messages.slice(beforeOverflow)).toEqual([
      { type: 'protocol-fault' },
    ]);
    for (let i = 0; i < 20; i++) {
      const instance = new registration.processor();
      instance.port.onmessage({
        data: {
          type: 'arm',
          generation: i + 1,
          sequence: 1,
          f0: 12,
          throughFrame: 30,
        },
      });
      instance.port.onmessage({ data: { type: 'dispose' } });
      const silent = new Float32Array([1, 1, 1, 1]);
      expect(
        instance.process([[new Float32Array([1, 1, 1, 1])]], [[silent]])
      ).toBe(false);
      expect(Array.from(silent)).toEqual([0, 0, 0, 0]);
      expect(messages[messages.length - 1]?.type).toBe('disposed');
      const count = messages.length;
      instance.port.onmessage({
        data: {
          type: 'arm',
          generation: i + 2,
          sequence: 2,
          f0: 12,
          throughFrame: 30,
        },
      });
      expect(messages).toHaveLength(count);
    }
  } finally {
    globals.AudioWorkletProcessor = saved.AudioWorkletProcessor;
    globals.registerProcessor = saved.registerProcessor;
    globals.currentFrame = saved.currentFrame;
  }
});
