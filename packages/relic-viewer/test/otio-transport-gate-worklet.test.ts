import { expect, test } from 'bun:test';
import type { OtioGateDecodeDiagnostic } from '../src/otio-transport-gate-state';
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
      processor.port.onmessage?.({
        data: {
          clockEpoch: 1,
          ...(message.type === 'arm' ? { slot: 0 } : {}),
          ...message,
        },
      });
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
      instance.port.onmessage?.({
        data: {
          clockEpoch: 2,
          ...(value.type === 'arm' ? { slot: 0 } : {}),
          ...value,
        },
      });
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
      const replacement = [
        new Float32Array(4).fill(2),
        new Float32Array(4).fill(2),
      ];
      const alive = instance.process([source, carrier, replacement], [output], {
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
    expect(
      prefix.port.messages.some(
        (message) => message.type === 'clock-stale-pair'
      )
    ).toBe(false);
    const stale = new ProcessorClass({
      processorOptions: {
        clockEpoch: 2,
        initialFrame: 0,
        proofStaleMaxPairs: 16,
      },
    });
    for (let i = 0; i < 20; i++) block(stale, i * 4);
    expect(
      stale.port.messages.some(
        (message) => message.type === 'clock-stale-overflow'
      )
    ).toBe(false);
    command(stale, { type: 'proof-stale-start', captureId: 1 });
    expect(stale.port.messages.at(-1)).toMatchObject({
      type: 'clock-stale-started',
      captureId: 1,
      afterCallbackOrdinal: 20,
    });
    block(stale, 80);
    expect(
      stale.port.messages.some((message) => message.type === 'clock-stale-pair')
    ).toBe(false);
    block(stale, 84);
    const pair = stale.port.messages.find(
      (message) => message.type === 'clock-stale-pair'
    ) as {
      previous: {
        callbackOrdinal: number;
        certifiedFrame: number;
        clockFrameA: number[];
        clockTagA: number[];
      };
      current: {
        callbackOrdinal: number;
        certifiedFrame: number;
        clockFrameA: number[];
        clockTagA: number[];
      };
    };
    expect(pair.previous).toMatchObject({
      callbackOrdinal: 21,
      certifiedFrame: 80,
      clockFrameA: [80, 81, 82, 83],
      clockTagA: [1],
    });
    expect(pair.current).toMatchObject({
      callbackOrdinal: 22,
      certifiedFrame: 84,
      clockFrameA: [84, 85, 86, 87],
      clockTagA: [1],
    });
    for (let i = 22; i < 39; i++) block(stale, i * 4);
    expect(
      stale.port.messages.filter(
        (message) => message.type === 'clock-stale-pair'
      )
    ).toHaveLength(16);
    expect(
      stale.port.messages.filter(
        (message) => message.type === 'clock-stale-overflow'
      )
    ).toHaveLength(1);
    command(stale, { type: 'proof-stale-stop', captureId: 1 });
    expect(stale.port.messages.at(-1)).toMatchObject({
      type: 'clock-stale-stopped',
      captureId: 1,
      pairs: 16,
      overflow: true,
    });
    block(stale, 156);
    command(stale, { type: 'proof-stale-start', captureId: 2 });
    block(stale, 160);
    expect(
      stale.port.messages.filter(
        (message) => message.type === 'clock-stale-pair'
      )
    ).toHaveLength(16);
    block(stale, 164);
    expect(
      stale.port.messages.filter(
        (message) => message.type === 'clock-stale-pair'
      )
    ).toHaveLength(17);
    command(stale, { type: 'proof-stale-start', captureId: 2 });
    expect(stale.port.messages.at(-1)?.type).toBe('clock-stale-control-error');
    command(stale, { type: 'proof-stale-stop', captureId: 99 });
    expect(stale.port.messages.at(-1)?.type).toBe('clock-stale-control-error');
    command(stale, { type: 'proof-stale-stop', captureId: 2 });
    expect(stale.port.messages.at(-1)).toMatchObject({
      type: 'clock-stale-stopped',
      captureId: 2,
      pairs: 1,
      overflow: false,
    });
    const invalidStale = new ProcessorClass({
      processorOptions: {
        clockEpoch: 2,
        initialFrame: 0,
        proofStaleMaxPairs: 16,
      },
    });
    command(invalidStale, { type: 'proof-stale-start', captureId: 1 });
    block(invalidStale, 0);
    block(invalidStale, 4, Float32Array.of(4, 4, 4, 4));
    expect(
      invalidStale.port.messages.some(
        (message) => message.type === 'clock-stale-pair'
      )
    ).toBe(false);
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
    const recovery = fresh();
    expect(Array.from(block(recovery, 0).output[0]!)).toEqual([0, 0, 0, 0]);
    expect(Array.from(block(recovery, 4).output[0]!)).toEqual([0, 0, 0, 0]);
    command(recovery, {
      type: 'arm',
      generation: 1,
      sequence: 1,
      f0: 10,
      throughFrame: 14,
      slot: 0,
    });
    expect(Array.from(block(recovery, 8).output[0]!)).toEqual([0, 0, 1, 1]);
    command(recovery, {
      type: 'arm',
      generation: 2,
      sequence: 2,
      f0: 14,
      throughFrame: 24,
      slot: 1,
    });
    expect(Array.from(block(recovery, 12).output[0]!)).toEqual([1, 1, 0, 0]);
    expect(
      recovery.port.messages.find(
        (message) => message.type === 'arm' && message.sequence === 2
      )?.accepted
    ).toBe(false);
    command(recovery, {
      type: 'arm',
      generation: 2,
      sequence: 3,
      f0: 18,
      throughFrame: 24,
      slot: 1,
    });
    expect(Array.from(block(recovery, 16).output[0]!)).toEqual([0, 0, 2, 2]);
    command(recovery, { type: 'abort', generation: 2, sequence: 4 });
    expect(Array.from(block(recovery, 20).output[0]!)).toEqual([0, 0, 0, 0]);
    command(recovery, {
      type: 'arm',
      generation: 3,
      sequence: 5,
      f0: 24,
      throughFrame: 28,
      slot: 0,
    });
    expect(Array.from(block(recovery, 24).output[0]!)).toEqual([1, 1, 1, 1]);
    const invalidSlot = fresh();
    block(invalidSlot, 0);
    block(invalidSlot, 4);
    invalidSlot.port.onmessage?.({
      data: {
        type: 'arm',
        clockEpoch: 2,
        generation: 1,
        sequence: 1,
        f0: 8,
        throughFrame: 24,
      },
    });
    expect(Array.from(block(invalidSlot, 8).output[0]!)).toEqual([0, 0, 0, 0]);
    expect(
      invalidSlot.port.messages.find(
        (message) => message.type === 'arm' && message.sequence === 1
      )?.accepted
    ).toBe(false);
    command(invalidSlot, {
      type: 'arm',
      generation: 1,
      sequence: 2,
      f0: 12,
      throughFrame: 24,
      slot: 2,
    });
    expect(Array.from(block(invalidSlot, 12).output[0]!)).toEqual([0, 0, 0, 0]);
    expect(
      invalidSlot.port.messages.find(
        (message) => message.type === 'arm' && message.sequence === 2
      )?.accepted
    ).toBe(false);
    command(invalidSlot, {
      type: 'arm',
      generation: 1,
      sequence: 3,
      f0: 16,
      throughFrame: 20,
      slot: 1,
    });
    expect(Array.from(block(invalidSlot, 16).output[0]!)).toEqual([2, 2, 2, 2]);
    command(invalidSlot, {
      type: 'arm',
      generation: 1,
      sequence: 4,
      f0: 20,
      throughFrame: 24,
      slot: 0,
    });
    expect(Array.from(block(invalidSlot, 20).output[0]!)).toEqual([0, 0, 0, 0]);
    expect(
      invalidSlot.port.messages.find(
        (message) => message.type === 'arm' && message.sequence === 4
      )?.accepted
    ).toBe(false);
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
    // Fault diagnostics: bounded evidence beside an unchanged rejection.
    const isDiagnostic = (value: unknown): value is OtioGateDecodeDiagnostic =>
      typeof value === 'object' &&
      value !== null &&
      'reason' in value &&
      'samples' in value;
    const diagnosticOf = (
      message: Message | undefined
    ): OtioGateDecodeDiagnostic => {
      const diagnostic = message?.diagnostic;
      if (!isDiagnostic(diagnostic))
        throw new Error('clock-fault without diagnostic');
      return diagnostic;
    };
    const driveQuantum = (
      instance: Processor,
      start: number,
      params: Record<string, Float32Array>
    ) => {
      const length = 128;
      const output = [
        new Float32Array(length).fill(9),
        new Float32Array(length).fill(9),
      ];
      const source = [
        new Float32Array(length).fill(1),
        new Float32Array(length).fill(1),
      ];
      const carrier = [
        Float32Array.from(
          { length },
          (_, i) => 1 + Math.floor((start + i) / 65536)
        ),
        Float32Array.from({ length }, (_, i) => (start + i) % 65536),
      ];
      const alive = instance.process(
        [source, carrier, source],
        [output],
        params
      );
      return { alive, output };
    };
    const activeLanes = (start: number) => ({
      clockFrameA: Float32Array.from({ length: 128 }, (_, i) => start + i),
      clockTagA: Float32Array.of(1),
      clockFrameB: new Float32Array(128),
      clockTagB: Float32Array.of(0),
    });

    // A wrong active tag rejects the quantum with its own predicate and lanes.
    const tagged = new ProcessorClass({
      processorOptions: { clockEpoch: 2, initialFrame: 0 },
    });
    const wrongTag = driveQuantum(tagged, 0, {
      clockFrameA: Float32Array.from({ length: 128 }, (_, i) => i),
      clockTagA: Float32Array.of(7),
      clockFrameB: new Float32Array(128),
      clockTagB: Float32Array.of(0),
    });
    expect(wrongTag.alive).toBe(false);
    expect(Array.from(wrongTag.output[0]!)).toEqual(Array(128).fill(0));
    const tagFault = tagged.port.messages.at(-1)!;
    expect(tagFault).toMatchObject({
      type: 'clock-fault',
      expectedFrame: null,
      observedFrame: -1,
    });
    expect(diagnosticOf(tagFault)).toMatchObject({
      location: 'active',
      reason: 'tag-mismatch',
      failingSample: 0,
      failingFrame: 0,
      failingTag: 7,
      length: 128,
      cachedCurrentFrame: 0,
      bank: { bank: 0, serial: 1, startFrame: 0, endFrame: 65536 },
      activeBank: { bank: 0, serial: 1 },
      warmingBank: null,
      frame: {
        first: 0,
        last: 127,
        min: 0,
        max: 127,
        nonFinite: 0,
        count: 128,
      },
      tag: { first: 7, last: 7, min: 7, max: 7, nonFinite: 0, count: 1 },
    });
    expect(diagnosticOf(tagFault).samples.active.tag).toEqual([7]);
    expect(diagnosticOf(tagFault).samples.active.frame).toHaveLength(128);
    expect(diagnosticOf(tagFault).samples.warming).toBeNull();

    // An endpoint outside the bank rejects at the offending sample.
    const endpoint = new ProcessorClass({
      processorOptions: { clockEpoch: 2, initialFrame: 0 },
    });
    const beyond = driveQuantum(endpoint, 0, {
      clockFrameA: Float32Array.from({ length: 128 }, (_, i) =>
        i === 5 ? 70000 : i
      ),
      clockTagA: Float32Array.of(1),
      clockFrameB: new Float32Array(128),
      clockTagB: Float32Array.of(0),
    });
    expect(beyond.alive).toBe(false);
    expect(endpoint.port.messages.at(-1)?.diagnostic).toMatchObject({
      location: 'active',
      reason: 'frame-out-of-bank',
      failingSample: 5,
      failingFrame: 70000,
      failingTag: 1,
      frame: { min: 0, max: 70000, count: 128 },
    });

    // A warming bank whose tag is wrong reports location 'warming' and both descriptors.
    const warm = new ProcessorClass({
      processorOptions: { clockEpoch: 2, initialFrame: 0 },
    });
    let at = 0;
    for (; at < 32128; at += 128)
      expect(driveQuantum(warm, at, activeLanes(at)).alive).toBe(true);
    warm.port.onmessage?.({
      data: {
        clockEpoch: 2,
        type: 'install-bank',
        requestId: 9,
        descriptor: {
          clockEpoch: 2,
          bank: 1,
          serial: 2,
          startFrame: 32768,
          endFrame: 98304,
        },
      },
    });
    for (; at < 32768; at += 128)
      expect(driveQuantum(warm, at, activeLanes(at)).alive).toBe(true);
    const warmFault = driveQuantum(warm, 32768, {
      clockFrameA: Float32Array.from({ length: 128 }, (_, i) => 32768 + i),
      clockTagA: Float32Array.of(1),
      clockFrameB: Float32Array.from({ length: 128 }, (_, i) => i),
      clockTagB: Float32Array.of(3),
    });
    expect(warmFault.alive).toBe(false);
    const warmDiagnostic = warm.port.messages.at(-1);
    expect(warmDiagnostic?.type).toBe('clock-fault');
    expect(diagnosticOf(warmDiagnostic)).toMatchObject({
      location: 'warming',
      reason: 'tag-mismatch',
      failingSample: 0,
      failingFrame: 0,
      failingTag: 3,
      bank: { bank: 1, serial: 2, startFrame: 32768, endFrame: 98304 },
      activeBank: { bank: 0, serial: 1 },
      warmingBank: { bank: 1, serial: 2 },
      tag: { first: 3, last: 3, count: 1 },
    });
    const warmingSamples = diagnosticOf(warmDiagnostic).samples.warming;
    if (!warmingSamples) throw new Error('warming bank samples missing');
    expect(warmingSamples.frame).toEqual(
      Array.from({ length: 128 }, (_, i) => i)
    );
    expect(warmingSamples.tag).toEqual([3]);
    expect(diagnosticOf(warmDiagnostic).samples.active.frame).toHaveLength(128);
  } finally {
    globals.AudioWorkletProcessor = originalProcessor;
    globals.registerProcessor = originalRegister;
    globals.currentFrame = originalFrame;
  }
});
