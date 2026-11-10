import { expect, test } from 'bun:test';
test('native render clock certifies promotions and silences a held ramp', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalProcessor = globals.AudioWorkletProcessor;
  const originalRegister = globals.registerProcessor;
  const originalFrame = globals.currentFrame;
  globals.currentFrame = 0;
  type Message = Record<string, unknown>;
  type Processor = {
    port: {
      onmessage: ((event: { data: Message }) => void) | null;
      messages: Message[];
    };
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      params: Record<string, Float32Array>
    ): boolean;
  };
  const registry: { processor?: new (options: unknown) => Processor } = {};
  globals.AudioWorkletProcessor = class {
    port = {
      onmessage: null,
      messages: [] as Message[],
      postMessage(value: Message) {
        this.messages.push(value);
      },
    };
  };
  globals.registerProcessor = (
    _name: string,
    processor: new (options: unknown) => Processor
  ) => {
    registry.processor = processor;
  };
  try {
    // The worklet registers against globals installed by this test; a static import runs too early.
    await import('../src/otio-transport-gate-worklet');
    const ProcessorClass = registry.processor;
    if (!ProcessorClass) throw new Error('processor was not registered');
    const processor = new ProcessorClass({
      processorOptions: {
        clockEpoch: 1,
        initialFrame: 0,
        traceMaxCallbacks: 2,
      },
    });
    const send = (message: Message) =>
      processor.port.onmessage?.({ data: { clockEpoch: 1, ...message } });
    const run = (start: number, corrupt = false) => {
      const frames = (base: number) =>
        Float32Array.from({ length: 128 }, (_, i) => start + i - base);
      const params = {
        clockFrameA: frames(start >= 32896 ? 65536 : 0),
        clockTagA: Float32Array.of(start >= 32896 ? 3 : 1),
        clockFrameB: frames(32768),
        clockTagB: Float32Array.of(2),
      };
      if (corrupt) params.clockFrameA.fill(start - 65536);
      const input = [
        new Float32Array(128).fill(0.75),
        new Float32Array(128).fill(-0.5),
      ];
      const output = [
        new Float32Array(128).fill(9),
        new Float32Array(128).fill(9),
      ];
      const carrier = [
        Float32Array.from(
          { length: 128 },
          (_, i) => 1 + Math.floor((start + i) / 65536)
        ),
        Float32Array.from({ length: 128 }, (_, i) => (start + i) % 65536),
      ];
      const alive = processor.process([input, carrier], [output], params);
      return { alive, output };
    };
    send({ type: 'proof-trace-start' });
    run(0);
    run(128);
    expect(
      processor.port.messages.find(
        (message) => message.type === 'anchor-certified'
      )?.lastCertifiedEnd
    ).toBe(256);
    run(256);
    expect(
      processor.port.messages.filter(
        (message) => message.type === 'clock-trace'
      )
    ).toHaveLength(2);
    expect(
      processor.port.messages.some(
        (message) => message.type === 'clock-trace-overflow'
      )
    ).toBe(true);
    const trace = processor.port.messages.find(
      (message) => message.type === 'clock-trace'
    );
    expect(trace?.cachedCurrentFrame).toBe(0);
    expect(trace?.certifiedFrame).toBe(0);
    expect((trace?.clockFrameA as number[]).length).toBe(128);
    send({
      type: 'install-bank',
      requestId: 2,
      descriptor: {
        clockEpoch: 1,
        bank: 1,
        serial: 2,
        startFrame: 32768,
        endFrame: 98304,
      },
    });
    send({
      type: 'arm',
      generation: 1,
      sequence: 1,
      f0: 512,
      throughFrame: 40000,
    });
    for (let start = 384; start <= 32768; start += 128) {
      const block = run(start);
      if (start >= 512)
        expect(block.output[0]).toEqual(new Float32Array(128).fill(0.75));
    }
    expect(
      processor.port.messages.some(
        (message) =>
          message.type === 'clock-promoted' && message.boundary === 32896
      )
    ).toBe(true);
    send({
      type: 'install-bank',
      requestId: 3,
      descriptor: {
        clockEpoch: 1,
        bank: 0,
        serial: 3,
        startFrame: 65536,
        endFrame: 131072,
      },
    });
    for (let start = 32896; start <= 65536; start += 128) {
      const block = run(start);
      if (start === 40064)
        expect(block.output[0]).toEqual(new Float32Array(128));
    }
    expect(
      processor.port.messages.some(
        (message) => message.type === 'closed' && message.closedFrame === 40000
      )
    ).toBe(true);
    expect(
      processor.port.messages.some(
        (message) =>
          message.type === 'clock-promoted' && message.boundary === 65664
      )
    ).toBe(true);
    const failed = run(65664, true);
    expect(failed.alive).toBe(false);
    expect(failed.output[0]).toEqual(new Float32Array(128));
    expect(failed.output[1]).toEqual(new Float32Array(128));
    expect(
      processor.port.messages.some((message) => message.type === 'clock-fault')
    ).toBe(true);
    // Exercise exact prefix closure, rejected reopening, and terminal queue handling.
    const fresh = () =>
      new ProcessorClass({
        processorOptions: { clockEpoch: 2, initialFrame: 0 },
      });
    const command = (instance: Processor, value: Message) =>
      instance.port.onmessage?.({ data: { clockEpoch: 2, ...value } });
    const block = (
      instance: Processor,
      start: number,
      values?: Float32Array,
      serial = 1
    ) => {
      const output = [new Float32Array(4).fill(9), new Float32Array(4).fill(9)];
      const source = [new Float32Array(4).fill(1), new Float32Array(4).fill(1)];
      const carrier = [
        Float32Array.from(
          { length: 4 },
          (_, i) => 1 + Math.floor((start + i) / 65536)
        ),
        Float32Array.from({ length: 4 }, (_, i) => (start + i) % 65536),
      ];
      const alive = instance.process([source, carrier], [output], {
        clockFrameA:
          values ??
          Float32Array.from({ length: 4 }, (_, index) => start + index),
        clockTagA: Float32Array.of(serial),
        clockFrameB: new Float32Array(4),
        clockTagB: Float32Array.of(0),
      });
      return { output, alive };
    };
    const prefix = fresh();
    block(prefix, 0);
    block(prefix, 4);
    command(prefix, {
      type: 'arm',
      generation: 1,
      sequence: 1,
      f0: 10,
      throughFrame: 14,
    });
    expect(Array.from(block(prefix, 8).output[0]!)).toEqual([0, 0, 1, 1]);
    expect(Array.from(block(prefix, 12).output[0]!)).toEqual([1, 1, 0, 0]);
    expect(
      prefix.port.messages.find((message) => message.type === 'closed')
        ?.closedFrame
    ).toBe(14);
    command(prefix, {
      type: 'extend',
      generation: 1,
      sequence: 2,
      expectedThroughFrame: 14,
      throughFrame: 30,
    });
    expect(Array.from(block(prefix, 16).output[0]!)).toEqual([0, 0, 0, 0]);
    expect(prefix.port.messages.at(-1)?.accepted).toBe(false);
    const maximum = 2 ** 24 - 1;
    const exhausted = new ProcessorClass({
      processorOptions: {
        clockEpoch: 2,
        initialFrame: 0,
        proofInitialSerial: maximum,
      },
    });
    block(exhausted, 0, undefined, maximum);
    block(exhausted, 4, undefined, maximum);
    expect(
      exhausted.port.messages.find(
        (message) => message.type === 'anchor-certified'
      )?.bankSerial
    ).toBe(maximum);
    command(exhausted, {
      type: 'arm',
      generation: 1,
      sequence: 1,
      f0: 10,
      throughFrame: 20,
    });
    expect(
      Array.from(block(exhausted, 8, undefined, maximum).output[0]!)
    ).toEqual([0, 0, 1, 1]);
    command(exhausted, {
      type: 'install-bank',
      requestId: 2,
      descriptor: {
        clockEpoch: 2,
        bank: 1,
        serial: maximum + 1,
        startFrame: 32768,
        endFrame: 98304,
      },
    });
    expect(
      Array.from(block(exhausted, 12, undefined, maximum).output[0]!)
    ).toEqual([1, 1, 1, 1]);
    expect(exhausted.port.messages.at(-1)?.type).toBe('bank-rejected');
    for (const values of [
      Float32Array.of(0, 0, 0, 0),
      Float32Array.of(8, 9, 10, 11),
      Float32Array.of(1, 2, 3, 4),
      Float32Array.of(NaN, 5, 6, 7),
    ]) {
      const faulted = fresh();
      block(faulted, 0);
      const result = block(faulted, 4, values);
      expect(result.alive).toBe(false);
      expect(Array.from(result.output[0]!)).toEqual([0, 0, 0, 0]);
      expect(faulted.port.messages.at(-1)?.type).toBe('clock-fault');
    }
    for (const scenario of [
      'missing',
      'one-channel',
      'shifted',
      'corrupt',
      'skipped',
    ] as const) {
      const instance = fresh();
      const start = scenario === 'skipped' ? 4 : 0;
      const carrier = [
        Float32Array.of(1, 1, 1, 1),
        Float32Array.from(
          { length: 4 },
          (_, i) => start + i + (scenario === 'shifted' ? 1 : 0)
        ),
      ];
      if (scenario === 'corrupt') carrier[0]![2] = NaN;
      const output = [new Float32Array(4).fill(9), new Float32Array(4).fill(9)];
      const input =
        scenario === 'missing'
          ? []
          : scenario === 'one-channel'
            ? [carrier[0]!]
            : carrier;
      const alive = instance.process(
        [[new Float32Array(4).fill(1), new Float32Array(4).fill(1)], input],
        [output],
        {
          clockFrameA: Float32Array.from({ length: 4 }, (_, i) => start + i),
          clockTagA: Float32Array.of(1),
          clockFrameB: new Float32Array(4),
          clockTagB: Float32Array.of(0),
        }
      );
      expect(alive).toBe(false);
      expect(Array.from(output[0]!)).toEqual([0, 0, 0, 0]);
      expect(instance.port.messages.at(-1)?.type).toBe('clock-fault');
    }
    const carryOrigin = 65534;
    const carry = new ProcessorClass({
      processorOptions: { clockEpoch: 2, initialFrame: carryOrigin },
    });
    for (const relative of [0, 4]) {
      const input = [new Float32Array(4), new Float32Array(4)];
      const carrier = [
        Float32Array.from(
          { length: 4 },
          (_, i) => 1 + Math.floor((carryOrigin + relative + i) / 65536)
        ),
        Float32Array.from(
          { length: 4 },
          (_, i) => (carryOrigin + relative + i) % 65536
        ),
      ];
      expect(
        carry.process(
          [input, carrier],
          [[new Float32Array(4), new Float32Array(4)]],
          {
            clockFrameA: Float32Array.from(
              { length: 4 },
              (_, i) => relative + i
            ),
            clockTagA: Float32Array.of(1),
            clockFrameB: new Float32Array(4),
            clockTagB: Float32Array.of(0),
          }
        )
      ).toBe(true);
    }
    expect(
      carry.port.messages.find((message) => message.type === 'anchor-certified')
    ).toMatchObject({
      firstFrame: carryOrigin,
      lastCertifiedEnd: carryOrigin + 8,
      sampleCount: 8,
    });
    const overloaded = fresh();
    for (let sequence = 1; sequence <= 3; sequence++)
      command(overloaded, {
        type: 'arm',
        generation: 1,
        sequence,
        f0: 12,
        throughFrame: 30,
      });
    expect(block(overloaded, 0).alive).toBe(false);
    expect(overloaded.port.messages.at(-1)?.type).toBe('protocol-fault');
    for (let i = 0; i < 20; i++) {
      const instance = fresh();
      command(instance, { type: 'dispose' });
      const result = block(instance, 0);
      expect(result.alive).toBe(false);
      expect(Array.from(result.output[0]!)).toEqual([0, 0, 0, 0]);
      expect(instance.port.messages.at(-1)?.type).toBe('disposed');
      const count = instance.port.messages.length;
      command(instance, {
        type: 'arm',
        generation: 1,
        sequence: 1,
        f0: 12,
        throughFrame: 30,
      });
      block(instance, 4);
      expect(instance.port.messages).toHaveLength(count);
    }
  } finally {
    globals.AudioWorkletProcessor = originalProcessor;
    globals.registerProcessor = originalRegister;
    globals.currentFrame = originalFrame;
  }
});
