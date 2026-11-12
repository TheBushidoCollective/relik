import { expect, test } from 'bun:test';
import {
  assertDescriptorBudgetRefusal,
  assertHeldReleaseBeforeSuccessor,
  assertShiftedBankRefusal,
  siteBridgeGapInfeasibleAfterHold,
} from './otio-recovery-checks.ts';

const boundary = 41473;
const staged = {
  event: 'recovery-candidate-failed',
  code: 'descriptor-budget-exhausted',
  reason: 'PCM byte budget exceeded',
  boundaryFrame: boundary,
};
const closed = { event: 'gate-close', contextStopFrame: boundary };
const refusal = {
  event: 'recovery-candidate-failed',
  code: 'descriptor-budget-exhausted',
  boundaryFrame: boundary,
};
const error = { event: 'error', code: 'descriptor-budget-exhausted' };
const valid = (): Record<string, unknown>[] => [
  { ...staged },
  { ...closed },
  { ...refusal },
  { ...error },
];

test('descriptor budget check accepts the staged refusal and rejects a late fault', () => {
  expect(assertDescriptorBudgetRefusal(valid(), 1, boundary)).toBe(2);
  const late = [
    { event: 'recovery-candidate-ready', boundaryFrame: boundary },
    closed,
    { event: 'recovery-selection', boundaryFrame: boundary },
    {
      event: 'recovery-candidate-failed',
      code: 'descriptor-not-ready',
      boundaryFrame: 46529,
    },
  ];
  expect(() => assertDescriptorBudgetRefusal(late, 1, boundary)).toThrow(
    'not consumed'
  );
});

test('descriptor budget check rejects each broken refusal boundary', () => {
  const ready = valid();
  ready[0] = { event: 'recovery-candidate-ready', boundaryFrame: boundary };
  expect(() => assertDescriptorBudgetRefusal(ready, 1, boundary)).toThrow(
    'not consumed'
  );
  const wrongRefusal = valid();
  wrongRefusal[2] = { ...refusal, code: 'descriptor-not-ready' };
  expect(() =>
    assertDescriptorBudgetRefusal(wrongRefusal, 1, boundary)
  ).toThrow('did not refuse');
  const wrongError = valid();
  wrongError[3] = { ...error, code: 'descriptor-not-ready' };
  expect(() => assertDescriptorBudgetRefusal(wrongError, 1, boundary)).toThrow(
    'not visible'
  );
  const admitted = [
    ...valid(),
    { event: 'recovery-selection' },
    { event: 'epoch' },
  ];
  expect(() => assertDescriptorBudgetRefusal(admitted, 1, boundary)).toThrow(
    'still admitted'
  );
});

test('shifted banks must refuse both bounded attempts before admission', () => {
  const gate = (epoch: number, frame: number) => ({
    kind: 'witness-attach',
    value: { clockEpoch: epoch, gateInitialFrame: frame },
  });
  const inject = (frame: number) => ({
    kind: 'anchor-bank-control-injected',
    value: { kind: 'shift-bank', initialFrame: frame },
  });
  const late = (epoch: number, frame: number) => ({
    kind: 'transport-message',
    value: {
      type: 'anchor-late',
      clockEpoch: epoch,
      firstFrame: frame,
      observedFrame: frame + 1,
    },
  });
  const a = 1280,
    b = 3584;
  const terminal = {
    kind: 'scheduled-pcm',
    value: {
      event: 'error',
      code: `PCM preparation failed: Transport anchor late: anchor ${b}, observed ${b + 1}`,
    },
  };
  const valid = [
    gate(1, a),
    inject(a),
    late(1, a),
    gate(2, b),
    inject(b),
    late(2, b),
    terminal,
  ];
  expect(() => assertShiftedBankRefusal(valid)).not.toThrow();
  expect(() =>
    assertShiftedBankRefusal(valid.filter((_, i) => i !== 4))
  ).toThrow('without the shifted bank');
  expect(() => assertShiftedBankRefusal([...valid, gate(3, 6000)])).toThrow(
    'exactly one bounded retry'
  );
  expect(() =>
    assertShiftedBankRefusal(
      valid.map((e, i) =>
        i === 5
          ? {
              kind: 'transport-message',
              value: {
                type: 'anchor-late',
                clockEpoch: 2,
                firstFrame: b,
                observedFrame: b + 128,
              },
            }
          : e
      )
    )
  ).toThrow('expected native refusals');
  expect(() =>
    assertShiftedBankRefusal(
      valid.map((e, i) =>
        i === 5
          ? { kind: 'transport-message', value: { type: 'clock-fault' } }
          : e
      )
    )
  ).toThrow('expected native refusals');
  expect(() =>
    assertShiftedBankRefusal([
      ...valid,
      { kind: 'transport-message', value: { type: 'anchor-certified' } },
    ])
  ).toThrow('admitted');
  expect(() =>
    assertShiftedBankRefusal([
      ...valid,
      { kind: 'scheduled-pcm', value: { event: 'epoch' } },
    ])
  ).toThrow('admitted');
  expect(() => assertShiftedBankRefusal(valid.slice(0, -1))).toThrow(
    'did not report'
  );
});

type TraceEvent = {
  kind: string;
  timestamp: number;
  value?: Record<string, unknown>;
};
const pcm = (
  timestamp: number,
  value: Record<string, unknown>
): TraceEvent => ({ kind: 'scheduled-pcm', timestamp, value });
const release = (
  timestamp: number,
  triggerIndex: number | null,
  released = 1
): TraceEvent => ({
  kind: 'pcm-hold-release',
  timestamp,
  value: { trigger: 'recovery-render-closed', triggerIndex, released },
});
const frontier = pcm(891.3, {
  event: 'frontier',
  generation: 1,
  frontierKind: 'extension',
  compositionThrough: { value: 36864 },
  preparedThrough: 40960,
  decodedCap: 36864,
  reserveFrames: 4096,
});
const gate = (stop: number, reason = 'frontier'): TraceEvent =>
  pcm(1210.8, {
    event: 'gate-close',
    generation: 1,
    reason,
    compositionStop: { value: stop },
  });
const closure = (
  stop: number,
  prepared: number,
  descriptorReady = true
): TraceEvent =>
  pcm(1211.1, {
    event: 'recovery-render-closed',
    generation: 1,
    descriptorReady,
    compositionStop: { value: stop },
    preparedThrough: prepared,
  });
const handoff = pcm(1216.1, {
  event: 'frontier',
  generation: 13,
  frontierKind: 'handoff',
  compositionThrough: { value: 40960 },
  preparedThrough: 40960,
});
type Overrides = {
  stop?: number;
  prepared?: number;
  reason?: string;
  descriptorReady?: boolean;
  release?: TraceEvent | null;
};
// The 7Roe0Z shape: closure 1211.1, release 1212.6 armed on it, handoff 1216.1.
const trace = (o: Overrides = {}): TraceEvent[] => {
  const events = [
    frontier,
    gate(o.stop ?? 36864, o.reason ?? 'frontier'),
    closure(o.stop ?? 36864, o.prepared ?? 40960, o.descriptorReady ?? true),
  ];
  if (o.release !== null) events.push(o.release ?? release(1212.6, 2));
  events.push(handoff);
  return events;
};

test('held release check accepts the released ordering and returns its indices', () => {
  expect(assertHeldReleaseBeforeSuccessor(trace())).toEqual({
    closureIndex: 2,
    releaseIndex: 3,
    handoffIndex: 4,
  });
});

test('held release check rejects the captured release after the handoff', () => {
  const captured = [
    frontier,
    gate(36864),
    closure(36864, 40960),
    handoff,
    release(1218.8, 2),
  ];
  expect(() => assertHeldReleaseBeforeSuccessor(captured)).toThrow(
    'ordering not reached'
  );
});

test('held release check rejects each ordering violation', () => {
  const beforeClosure = [
    frontier,
    gate(36864),
    release(1210.9, 3),
    closure(36864, 40960),
    handoff,
  ];
  expect(() => assertHeldReleaseBeforeSuccessor(beforeClosure)).toThrow(
    'ordering not reached'
  );
  const equalAfterHandoff = [
    frontier,
    gate(36864),
    closure(36864, 40960),
    handoff,
    release(1216.1, 2),
  ];
  expect(() => assertHeldReleaseBeforeSuccessor(equalAfterHandoff)).toThrow(
    'ordering not reached'
  );
  const regressed = [
    frontier,
    gate(36864),
    closure(36864, 40960),
    release(1210.0, 2),
    handoff,
  ];
  expect(() => assertHeldReleaseBeforeSuccessor(regressed)).toThrow(
    'ordering not reached'
  );
});

test('held release check rejects each broken release', () => {
  const misarmed = [
    frontier,
    gate(36864),
    closure(36864, 40960),
    release(1212.6, 5),
    handoff,
    closure(40960, 45056),
  ];
  expect(() => assertHeldReleaseBeforeSuccessor(misarmed)).toThrow(
    'not armed on the first closure'
  );
  expect(() =>
    assertHeldReleaseBeforeSuccessor(trace({ release: release(1212.6, null) }))
  ).toThrow('not armed on the first closure');
  expect(() =>
    assertHeldReleaseBeforeSuccessor(trace({ release: release(1212.6, 2, 0) }))
  ).toThrow('freed no held pulls');
  expect(() =>
    assertHeldReleaseBeforeSuccessor(trace({ release: null }))
  ).toThrow('no pcm-hold-release');
  expect(() =>
    assertHeldReleaseBeforeSuccessor([...trace(), release(1213.0, 2)])
  ).toThrow('more than one');
});

test('held release check rejects a predecessor that was not starved', () => {
  expect(() =>
    assertHeldReleaseBeforeSuccessor(trace({ descriptorReady: false }))
  ).toThrow('not descriptor-ready');
  expect(() =>
    assertHeldReleaseBeforeSuccessor(trace({ reason: 'pause' }))
  ).toThrow('not gate-closed at a frontier');
  expect(() =>
    assertHeldReleaseBeforeSuccessor(trace({ stop: 40960 }))
  ).toThrow("not at the predecessor's decode cap");
  expect(() =>
    assertHeldReleaseBeforeSuccessor(trace({ prepared: 45056 }))
  ).toThrow('moved between');
});

// Site-bridge gap-infeasible classifier. frameTime(f) classifies to frame f under ceil(seconds * rate).
const BRIDGE_RATE = 48000;
const BRIDGE_GAP_UPPER = boundary + 960; // floor(0.02 * 48000) = 960
const BRIDGE_HANDOFF = 'recovery render handoff has no feasible frame';
const BRIDGE_CAUSAL = 'video recovery phase has no causal audio epoch';
const BRIDGE_COMMITTED = 'committed recovery frame is unavailable';
const BRIDGE_CLOCK = 'fresh recovery output clock unavailable';
const BRIDGE_ANCHOR = { contextTime: 10, performanceTime: 1000 };
const BRIDGE_HELD = { contextTime: 10.001, performanceTime: 1000 };
const BRIDGE_NATIVE = { contextTime: 10.002, performanceTime: 1009.33 };
type BridgeEntry = { kind: string; value?: Record<string, unknown> };
const frameTime = (frame: number) => (frame - 0.5) / BRIDGE_RATE;
const bridgePcm = (value: Record<string, unknown>): BridgeEntry => ({
  kind: 'scheduled-pcm',
  value,
});
const bridgeClosure = (closed: number = boundary): BridgeEntry =>
  bridgePcm({
    event: 'recovery-render-closed',
    boundaryFrame: closed,
    descriptorReady: true,
  });
const bridgeMarker = (
  last: Record<string, number> = BRIDGE_ANCHOR
): BridgeEntry =>
  bridgePcm({
    event: 'clock-site',
    site: 'recovery-bridge',
    phase: 'read',
    lastAccepted: last,
  });
const bridgeConsumed = (): BridgeEntry => ({
  kind: 'clock-site-hold-consumed',
  value: {
    site: 'recovery-bridge',
    kind: 'ctx',
    deltaUs: 86,
    contextTime: BRIDGE_HELD.contextTime,
    performanceTime: BRIDGE_HELD.performanceTime,
    anchor: BRIDGE_ANCHOR,
  },
});
const bridgeRead = (
  frame: number,
  injected: boolean,
  output: Record<string, number>
): BridgeEntry => ({
  kind: 'audio-output-timestamp-observed',
  value: {
    injected,
    site: injected ? 'recovery-bridge' : null,
    currentAfter: frameTime(frame),
    output,
  },
});
const bridgeUse = (): BridgeEntry =>
  bridgePcm({
    event: 'clock-site',
    site: 'recovery-bridge',
    phase: 'use',
    usedStamp: BRIDGE_NATIVE,
  });
const bridgeError = (code: string): BridgeEntry =>
  bridgePcm({ event: 'error', stage: 'schedule', code });
// The re-read signature: consumed at B+256, the native successor edge at B+512.
const bridgeSignature = (
  consumed = boundary + 256,
  next = boundary + 512,
  code = BRIDGE_HANDOFF
): BridgeEntry[] => [
  bridgeClosure(),
  bridgeMarker(),
  bridgeConsumed(),
  bridgeRead(consumed, true, BRIDGE_HELD),
  bridgeMarker(),
  bridgeRead(next, false, BRIDGE_NATIVE),
  bridgeUse(),
  bridgeError(code),
];
const bridgeRejection = (
  reason: string,
  frame = boundary + 512,
  code = BRIDGE_CLOCK
): BridgeEntry[] => [
  bridgeClosure(),
  bridgeMarker(),
  bridgeConsumed(),
  bridgeRead(boundary + 256, true, BRIDGE_HELD),
  bridgePcm({
    event: 'recovery-clock-observation-rejected',
    contextAfter: frameTime(frame),
    gapUpper: BRIDGE_GAP_UPPER,
    observation: { reason },
  }),
  bridgeError(code),
];

test('site-bridge classifier names the exact re-read signature and its refusal', () => {
  const evidence = siteBridgeGapInfeasibleAfterHold(
    bridgeSignature(),
    BRIDGE_RATE
  );
  expect(evidence ?? '').toContain(
    `refused by "${BRIDGE_HANDOFF}" via a native read`
  );
});

test('site-bridge classifier accepts the causal-epoch refusal and each feasible-clock rejection', () => {
  expect(
    siteBridgeGapInfeasibleAfterHold(
      bridgeSignature(undefined, undefined, BRIDGE_CAUSAL),
      BRIDGE_RATE
    )
  ).not.toBeNull();
  for (const reason of ['accepted', 'duplicate', 'sub-resolution']) {
    expect(
      siteBridgeGapInfeasibleAfterHold(bridgeRejection(reason), BRIDGE_RATE) ??
        ''
    ).toContain('via a rejected fresh clock');
  }
});

test('site-bridge classifier edges on the gap are exact', () => {
  // The held read on the last feasible frame is inside the gap; one frame later it is not.
  expect(
    siteBridgeGapInfeasibleAfterHold(
      bridgeSignature(BRIDGE_GAP_UPPER - 512),
      BRIDGE_RATE
    )
  ).not.toBeNull();
  expect(
    siteBridgeGapInfeasibleAfterHold(
      bridgeSignature(BRIDGE_GAP_UPPER - 511),
      BRIDGE_RATE
    )
  ).toBeNull();
  // A native read on the edge is feasible and so must be injected; one frame later it is the infeasible use.
  expect(
    siteBridgeGapInfeasibleAfterHold(
      bridgeSignature(undefined, BRIDGE_GAP_UPPER - 512),
      BRIDGE_RATE
    )
  ).toBeNull();
  expect(
    siteBridgeGapInfeasibleAfterHold(
      bridgeSignature(undefined, BRIDGE_GAP_UPPER - 511),
      BRIDGE_RATE
    )
  ).not.toBeNull();
});

test('site-bridge classifier refuses a feasible native read before the infeasible one', () => {
  const edited = bridgeSignature();
  edited.splice(
    4,
    0,
    bridgeMarker(),
    bridgeRead(boundary + 300, false, BRIDGE_NATIVE)
  );
  expect(siteBridgeGapInfeasibleAfterHold(edited, BRIDGE_RATE)).toBeNull();
});

test('site-bridge classifier refuses a hold that was already infeasible at consumption', () => {
  expect(
    siteBridgeGapInfeasibleAfterHold(
      bridgeSignature(boundary + 600),
      BRIDGE_RATE
    )
  ).toBeNull();
});

test('site-bridge classifier refuses any selection, a committed-frame refusal, or a later error', () => {
  const selected = bridgeSignature();
  selected.splice(
    6,
    0,
    bridgePcm({
      event: 'recovery-selection',
      boundaryFrame: boundary,
      f0: boundary,
    })
  );
  expect(siteBridgeGapInfeasibleAfterHold(selected, BRIDGE_RATE)).toBeNull();
  expect(
    siteBridgeGapInfeasibleAfterHold(
      bridgeSignature(undefined, undefined, BRIDGE_COMMITTED),
      BRIDGE_RATE
    )
  ).toBeNull();
  expect(
    siteBridgeGapInfeasibleAfterHold(
      [...bridgeSignature(), bridgeError(BRIDGE_COMMITTED)],
      BRIDGE_RATE
    )
  ).toBeNull();
});

test('site-bridge classifier needs one consumption, a marker naming its anchor, and an injected read', () => {
  expect(
    siteBridgeGapInfeasibleAfterHold(
      bridgeSignature().filter(
        (entry) => entry.kind !== 'clock-site-hold-consumed'
      ),
      BRIDGE_RATE
    )
  ).toBeNull();
  expect(
    siteBridgeGapInfeasibleAfterHold(
      [...bridgeSignature(), bridgeConsumed()],
      BRIDGE_RATE
    )
  ).toBeNull();
  const wrongAnchor = bridgeSignature();
  wrongAnchor[1] = bridgeMarker({ contextTime: 9, performanceTime: 999 });
  expect(siteBridgeGapInfeasibleAfterHold(wrongAnchor, BRIDGE_RATE)).toBeNull();
  const notInjected = bridgeSignature();
  notInjected[3] = bridgeRead(boundary + 256, false, BRIDGE_HELD);
  expect(siteBridgeGapInfeasibleAfterHold(notInjected, BRIDGE_RATE)).toBeNull();
  const wrongOutput = bridgeSignature();
  wrongOutput[3] = bridgeRead(boundary + 256, true, BRIDGE_NATIVE);
  expect(siteBridgeGapInfeasibleAfterHold(wrongOutput, BRIDGE_RATE)).toBeNull();
});

test('site-bridge classifier measures the gap from the last closure before the hold', () => {
  expect(
    siteBridgeGapInfeasibleAfterHold(
      [bridgeClosure(boundary - 5000), ...bridgeSignature()],
      BRIDGE_RATE
    )
  ).not.toBeNull();
  const staleLast = bridgeSignature();
  staleLast.splice(1, 0, bridgeClosure(boundary - 5000));
  expect(siteBridgeGapInfeasibleAfterHold(staleLast, BRIDGE_RATE)).toBeNull();
  expect(
    siteBridgeGapInfeasibleAfterHold(bridgeSignature().slice(1), BRIDGE_RATE)
  ).toBeNull();
});

test('site-bridge classifier requires a native use for the handoff refusal', () => {
  const noUse = bridgeSignature().filter(
    (entry) =>
      !(entry.kind === 'scheduled-pcm' && entry.value?.['phase'] === 'use')
  );
  expect(siteBridgeGapInfeasibleAfterHold(noUse, BRIDGE_RATE)).toBeNull();
  expect(
    siteBridgeGapInfeasibleAfterHold(
      bridgeRejection('sub-resolution', BRIDGE_GAP_UPPER - 512, BRIDGE_HANDOFF),
      BRIDGE_RATE
    )
  ).toBeNull();
});

test('site-bridge classifier refuses a rejection that is infeasible, feasible, or before the hold', () => {
  expect(
    siteBridgeGapInfeasibleAfterHold(bridgeRejection('regression'), BRIDGE_RATE)
  ).toBeNull();
  expect(
    siteBridgeGapInfeasibleAfterHold(
      bridgeRejection('sub-resolution', BRIDGE_GAP_UPPER - 512),
      BRIDGE_RATE
    )
  ).toBeNull();
  const before: BridgeEntry[] = [
    bridgeClosure(),
    bridgePcm({
      event: 'recovery-clock-observation-rejected',
      contextAfter: frameTime(boundary + 512),
      gapUpper: BRIDGE_GAP_UPPER,
      observation: { reason: 'sub-resolution' },
    }),
    bridgeMarker(),
    bridgeConsumed(),
    bridgeRead(boundary + 256, true, BRIDGE_HELD),
    bridgeError(BRIDGE_CLOCK),
  ];
  expect(siteBridgeGapInfeasibleAfterHold(before, BRIDGE_RATE)).toBeNull();
});

test('site-bridge classifier rejects a non-positive rate', () => {
  expect(siteBridgeGapInfeasibleAfterHold(bridgeSignature(), 0)).toBeNull();
});
