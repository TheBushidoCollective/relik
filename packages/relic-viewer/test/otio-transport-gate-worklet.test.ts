import { expect, test } from 'bun:test';
import type { OtioGateDecodeDiagnostic } from '../src/otio-transport-gate-state';

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
type ProcessorClass = new (options: unknown) => Processor;

let worklet: Promise<ProcessorClass> | null = null;
/** Imports the worklet once. The module registers itself on import, and Bun caches the import. */
const loadProcessor = (): Promise<ProcessorClass> => {
  worklet ??= (async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const originalProcessor = globals.AudioWorkletProcessor;
    const originalRegister = globals.registerProcessor;
    const registry: { processor?: ProcessorClass } = {};
    globals.AudioWorkletProcessor = class {
      port = {
        onmessage: null,
        messages: [] as Message[],
        postMessage(value: Message) {
          this.messages.push(value);
        },
      };
    };
    globals.registerProcessor = (_name: string, processor: ProcessorClass) => {
      registry.processor = processor;
    };
    try {
      // The worklet registers against the globals installed here; a static import runs too early.
      await import('../src/otio-transport-gate-worklet');
    } finally {
      globals.AudioWorkletProcessor = originalProcessor;
      globals.registerProcessor = originalRegister;
    }
    if (!registry.processor) throw new Error('processor was not registered');
    return registry.processor;
  })();
  return worklet;
};

test('native render clock certifies promotions and silences a held ramp', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalFrame = globals.currentFrame;
  globals.currentFrame = 0;
  try {
    const ProcessorClass = await loadProcessor();
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
      if (scenario === 'skipped')
        expect(instance.port.messages.at(-1)).toMatchObject({
          type: 'anchor-late',
          firstFrame: 0,
          observedFrame: 4,
        });
      else expect(instance.port.messages.at(-1)?.type).toBe('clock-fault');
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

    // Running start: exact silence until the anchor, then two exact tagged quanta certify it.
    const RUNNING_START = 1024;
    const zeroCarrier = (): Float32Array[] => [
      new Float32Array(128),
      new Float32Array(128),
    ];
    const runningCarrier = (first: number): Float32Array[] => [
      Float32Array.from(
        { length: 128 },
        (_, i) => 1 + Math.floor((first + i) / 65536)
      ),
      Float32Array.from({ length: 128 }, (_, i) => (first + i) % 65536),
    ];
    const runningStep = (
      instance: Processor,
      params: Record<string, Float32Array>,
      carrier: Float32Array[]
    ) => {
      const output = [
        new Float32Array(128).fill(9),
        new Float32Array(128).fill(9),
      ];
      const source = [
        new Float32Array(128).fill(1),
        new Float32Array(128).fill(1),
      ];
      const alive = instance.process(
        [source, carrier, source],
        [output],
        params
      );
      return { alive, output };
    };
    const quietParams = (): Record<string, Float32Array> => ({
      clockFrameA: new Float32Array(128),
      clockTagA: Float32Array.of(0),
      clockFrameB: new Float32Array(128),
      clockTagB: Float32Array.of(0),
    });
    const taggedParams = (
      relative: Float32Array,
      tag: Float32Array
    ): Record<string, Float32Array> => ({
      clockFrameA: relative,
      clockTagA: tag,
      clockFrameB: new Float32Array(128),
      clockTagB: Float32Array.of(0),
    });
    const relativeRamp = (from: number) =>
      Float32Array.from({ length: 128 }, (_, i) => from + i);
    const runningProcessor = (prestartBudgetFrames: number) =>
      new ProcessorClass({
        processorOptions: {
          clockEpoch: 3,
          initialFrame: RUNNING_START,
          prestartBudgetFrames,
        },
      });

    const exact = runningProcessor(5120);
    expect(runningStep(exact, quietParams(), zeroCarrier()).alive).toBe(true);
    expect(runningStep(exact, quietParams(), zeroCarrier()).alive).toBe(true);
    expect(
      runningStep(
        exact,
        taggedParams(relativeRamp(0), Float32Array.of(1)),
        runningCarrier(RUNNING_START)
      ).alive
    ).toBe(true);
    expect(
      runningStep(
        exact,
        taggedParams(relativeRamp(128), Float32Array.of(1)),
        runningCarrier(RUNNING_START + 128)
      ).alive
    ).toBe(true);
    expect(
      exact.port.messages.find((m) => m.type === 'anchor-certified')
    ).toMatchObject({
      firstFrame: RUNNING_START,
      lastCertifiedEnd: RUNNING_START + 256,
      sampleCount: 256,
      callbackOrdinal: 2,
    });
    expect(
      exact.port.messages.some(
        (m) => m.type === 'clock-fault' || m.type === 'anchor-late'
      )
    ).toBe(false);

    const budget = runningProcessor(256);
    expect(runningStep(budget, quietParams(), zeroCarrier()).alive).toBe(true);
    expect(runningStep(budget, quietParams(), zeroCarrier()).alive).toBe(true);
    const over = runningStep(budget, quietParams(), zeroCarrier());
    expect(over.alive).toBe(false);
    expect(Array.from(over.output[0]!)).toEqual(Array(128).fill(0));
    expect(budget.port.messages.at(-1)).toMatchObject({
      type: 'anchor-late',
      firstFrame: RUNNING_START,
      observedFrame: null,
      prestartSamples: 384,
      budget: 256,
    });

    const early = runningProcessor(5120);
    const leak = runningStep(early, quietParams(), [
      Float32Array.from({ length: 128 }, () => 1),
      new Float32Array(128),
    ]);
    expect(leak.alive).toBe(false);
    expect(early.port.messages.at(-1)).toMatchObject({
      type: 'clock-fault',
      expectedFrame: RUNNING_START,
      observedFrame: -1,
      diagnostic: { reason: 'carrier-before-anchor', location: 'active' },
    });

    const partial = runningProcessor(5120);
    runningStep(partial, quietParams(), zeroCarrier());
    const split = runningStep(
      partial,
      taggedParams(
        relativeRamp(0),
        Float32Array.from({ length: 128 }, (_, i) => (i < 64 ? 1 : 0))
      ),
      runningCarrier(RUNNING_START)
    );
    expect(split.alive).toBe(false);
    expect(partial.port.messages.at(-1)).toMatchObject({
      type: 'clock-fault',
      diagnostic: { reason: 'tag-mismatch', failingSample: 64 },
    });

    const late = runningProcessor(5120);
    const lateStep = runningStep(
      late,
      taggedParams(relativeRamp(128), Float32Array.of(1)),
      runningCarrier(RUNNING_START + 128)
    );
    expect(lateStep.alive).toBe(false);
    expect(late.port.messages.at(-1)).toMatchObject({
      type: 'anchor-late',
      firstFrame: RUNNING_START,
      observedFrame: RUNNING_START + 128,
    });

    const skewed = runningProcessor(5120);
    runningStep(skewed, quietParams(), zeroCarrier());
    const skew = runningStep(
      skewed,
      taggedParams(relativeRamp(0), Float32Array.of(1)),
      runningCarrier(RUNNING_START + 1)
    );
    expect(skew.alive).toBe(false);
    expect(skewed.port.messages.at(-1)).toMatchObject({
      type: 'clock-fault',
      expectedFrame: RUNNING_START,
      observedFrame: -1,
    });

    const offset = runningProcessor(5120);
    runningStep(offset, quietParams(), zeroCarrier());
    const offStep = runningStep(
      offset,
      taggedParams(relativeRamp(128), Float32Array.of(1)),
      runningCarrier(RUNNING_START + 128)
    );
    expect(offStep.alive).toBe(false);
    expect(offset.port.messages.at(-1)).toMatchObject({
      type: 'anchor-late',
      firstFrame: RUNNING_START,
      observedFrame: RUNNING_START + 128,
    });
  } finally {
    globals.currentFrame = originalFrame;
  }
});

const FAULTS = ['clock-fault', 'protocol-fault', 'anchor-late'];
const START = 256;
const zeros = (length = 128) => new Float32Array(length);
const source = (): Float32Array[] => [zeros().fill(0.5), zeros().fill(0.5)];
/** Absolute carrier frames: the reference an anchored quantum is checked against. */
const carrier = (start: number): Float32Array[] => [
  Float32Array.from(
    { length: 128 },
    (_, i) => 1 + Math.floor((start + i) / 65536)
  ),
  Float32Array.from({ length: 128 }, (_, i) => (start + i) % 65536),
];
/** Clock lanes for one quantum. Frames are offsets from the bank's start frame, as the worklet decodes them. */
const lanes = (bankStart: number, start: number, serial = 1) => ({
  clockFrameA: Float32Array.from(
    { length: 128 },
    (_, i) => start + i - bankStart
  ),
  clockTagA: Float32Array.of(serial),
  clockFrameB: zeros(),
  clockTagB: Float32Array.of(0),
});
const silentLanes = () => ({
  clockFrameA: zeros(),
  clockTagA: zeros(1),
  clockFrameB: zeros(),
  clockTagB: zeros(1),
});
const step = (
  instance: Processor,
  inputs: Float32Array[][],
  params: Record<string, Float32Array>
) => {
  const output = [zeros().fill(9), zeros().fill(9)];
  return { alive: instance.process(inputs, [output], params), output };
};
const send = (instance: Processor, clockEpoch: number, message: Message) =>
  instance.port.onmessage?.({
    data: {
      clockEpoch,
      ...(message.type === 'arm' ? { slot: 0 } : {}),
      ...message,
    },
  });
const faults = (instance: Processor) =>
  instance.port.messages.filter((message) =>
    FAULTS.includes(String(message.type))
  );

test('a frozen start without a prestart budget anchors on its exact first quantum', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalFrame = globals.currentFrame;
  globals.currentFrame = 0;
  try {
    const ProcessorClass = await loadProcessor();
    const frozen = new ProcessorClass({
      processorOptions: { clockEpoch: 11, initialFrame: 0 },
    });
    expect(step(frozen, [source(), carrier(0)], lanes(0, 0)).alive).toBe(true);
    expect(step(frozen, [source(), carrier(128)], lanes(0, 128)).alive).toBe(
      true
    );
    expect(
      frozen.port.messages.find(
        (message) => message.type === 'anchor-certified'
      )
    ).toMatchObject({ firstFrame: 0, lastCertifiedEnd: 256 });
    expect(faults(frozen)).toEqual([]);

    // A frozen start grants no prestart silence: silence before A is a late start.
    const late = new ProcessorClass({
      processorOptions: { clockEpoch: 12, initialFrame: 0 },
    });
    expect(step(late, [source(), []], silentLanes()).alive).toBe(false);
    expect(
      late.port.messages.find((message) => message.type === 'anchor-late')
    ).toMatchObject({ budget: 0, prestartSamples: 128 });

    // A budget that is present but malformed is still a protocol fault.
    const malformed = new ProcessorClass({
      processorOptions: {
        clockEpoch: 13,
        initialFrame: 0,
        prestartBudgetFrames: -1,
      },
    });
    expect(step(malformed, [source(), carrier(0)], lanes(0, 0)).alive).toBe(
      false
    );
    expect(
      malformed.port.messages.some(
        (message) => message.type === 'protocol-fault'
      )
    ).toBe(true);
  } finally {
    globals.currentFrame = originalFrame;
  }
});

test('a running start accepts absent or empty carrier silence before its exact anchor', async () => {
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalFrame = globals.currentFrame;
  globals.currentFrame = 0;
  try {
    const ProcessorClass = await loadProcessor();
    const running = (clockEpoch: number) =>
      new ProcessorClass({
        processorOptions: {
          clockEpoch,
          initialFrame: START,
          prestartBudgetFrames: 512,
        },
      });

    // Four silent quanta, each with a different absent or empty carrier, spend the whole budget.
    const silent = running(21);
    const before: Float32Array[][][] = [
      [source(), []],
      [source()],
      [source(), [zeros(0), zeros(0)]],
      [source(), []],
    ];
    for (const inputs of before) {
      const block = step(silent, inputs, silentLanes());
      expect(block.alive).toBe(true);
      expect(block.output).toEqual([zeros(), zeros()]);
    }
    expect(
      step(silent, [source(), carrier(START)], lanes(START, START)).alive
    ).toBe(true);
    expect(
      step(silent, [source(), carrier(START + 128)], lanes(START, START + 128))
        .alive
    ).toBe(true);
    expect(
      silent.port.messages.find(
        (message) => message.type === 'anchor-certified'
      )
    ).toMatchObject({ firstFrame: START, lastCertifiedEnd: START + 256 });
    expect(faults(silent)).toEqual([]);

    // Late and corrupt controls after the anchor are still rejected.
    send(silent, 21, {
      type: 'arm',
      generation: 1,
      sequence: 1,
      f0: START + 40,
      throughFrame: START + 4096,
    });
    expect(
      step(silent, [source(), carrier(START + 256)], lanes(START, START + 256))
        .alive
    ).toBe(true);
    expect(
      silent.port.messages.find(
        (message) => message.type === 'arm' && message.accepted === false
      )
    ).toMatchObject({ reason: 'invalid or late arm' });
    send(silent, 21, {
      type: 'stop',
      generation: 1,
      sequence: 2,
      stopFrame: START + 300,
    });
    send(silent, 21, {
      type: 'stop',
      generation: 1,
      sequence: 3,
      stopFrame: START + 300,
    });
    expect(
      step(silent, [source(), carrier(START + 384)], lanes(START, START + 384))
        .alive
    ).toBe(false);
    expect(
      silent.port.messages.some((message) => message.type === 'protocol-fault')
    ).toBe(true);

    // Nonzero carrier before A is energy the anchor never permitted.
    const loud = running(22);
    expect(step(loud, [source(), carrier(0)], silentLanes()).alive).toBe(false);
    const loudFault = loud.port.messages.find(
      (message) => message.type === 'clock-fault'
    );
    expect(
      (loudFault?.diagnostic as OtioGateDecodeDiagnostic | undefined)?.reason
    ).toBe('carrier-before-anchor');

    // A malformed carrier shape before A is a fault, not silence.
    const shaped = running(23);
    expect(step(shaped, [source(), [zeros()]], silentLanes()).alive).toBe(
      false
    );
    expect(
      shaped.port.messages.some((message) => message.type === 'clock-fault')
    ).toBe(true);

    // An anchor tag with no carrier at all is a fault, even though the carrier was empty before it.
    const untagged = running(24);
    expect(
      step(untagged, [source(), []], {
        ...silentLanes(),
        clockTagA: Float32Array.of(1),
      }).alive
    ).toBe(false);
    expect(
      untagged.port.messages.some((message) => message.type === 'clock-fault')
    ).toBe(true);

    // A tagged quantum that starts past A after silence is a late start.
    const late = running(25);
    expect(step(late, [source(), []], silentLanes()).alive).toBe(true);
    expect(
      step(late, [source(), carrier(START + 128)], lanes(START, START + 128))
        .alive
    ).toBe(false);
    expect(
      late.port.messages.find((message) => message.type === 'anchor-late')
    ).toMatchObject({ firstFrame: START, observedFrame: START + 128 });

    // Empty silence spends the budget: the fifth quantum is over 512 prestart frames.
    const over = running(26);
    for (let i = 0; i < 4; i++)
      expect(step(over, [source(), []], silentLanes()).alive).toBe(true);
    expect(step(over, [source(), []], silentLanes()).alive).toBe(false);
    expect(
      over.port.messages.find((message) => message.type === 'anchor-late')
    ).toMatchObject({ prestartSamples: 640, budget: 512 });

    // The exact anchor still checks the carrier after empty prestart: an off-by-one carrier faults.
    const off = running(27);
    expect(step(off, [source(), []], silentLanes()).alive).toBe(true);
    expect(
      step(off, [source(), carrier(START + 1)], lanes(START, START)).alive
    ).toBe(false);
    expect(
      off.port.messages.some((message) => message.type === 'clock-fault')
    ).toBe(true);
  } finally {
    globals.currentFrame = originalFrame;
  }
});
