import { expect, test } from 'bun:test';
import {
  assertDescriptorBudgetRefusal,
  assertHeldReleaseBeforeSuccessor,
  assertShiftedBankRefusal,
  naturalStarvation,
  recoveryFrontierOvershoot,
  starvationRefusalText,
  siteBridgeCommitLeadAfterHold,
  siteBridgeFinalGuardAfterHold,
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
  output: Record<string, number>,
  native: Record<string, number> | null = injected
    ? BRIDGE_ANCHOR
    : BRIDGE_NATIVE
): BridgeEntry => ({
  kind: 'audio-output-timestamp-observed',
  value: {
    injected,
    site: injected ? 'recovery-bridge' : null,
    currentAfter: frameTime(frame),
    output,
    native,
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

test('site-bridge classifier requires the consumed native pair to be the anchor itself', () => {
  const contextDrift = bridgeSignature();
  contextDrift[3] = bridgeRead(boundary + 256, true, BRIDGE_HELD, {
    contextTime: 10.5,
    performanceTime: 1000,
  });
  expect(
    siteBridgeGapInfeasibleAfterHold(contextDrift, BRIDGE_RATE)
  ).toBeNull();
  const performanceDrift = bridgeSignature();
  performanceDrift[3] = bridgeRead(boundary + 256, true, BRIDGE_HELD, {
    contextTime: 10,
    performanceTime: 1000.5,
  });
  expect(
    siteBridgeGapInfeasibleAfterHold(performanceDrift, BRIDGE_RATE)
  ).toBeNull();
  const missingNative = bridgeSignature();
  missingNative[3] = bridgeRead(boundary + 256, true, BRIDGE_HELD, null);
  expect(
    siteBridgeGapInfeasibleAfterHold(missingNative, BRIDGE_RATE)
  ).toBeNull();
});

test('site-bridge classifier requires a fresh, present native read for the handoff refusal', () => {
  const stale = bridgeSignature();
  stale[5] = bridgeRead(boundary + 512, false, BRIDGE_NATIVE, BRIDGE_ANCHOR);
  expect(siteBridgeGapInfeasibleAfterHold(stale, BRIDGE_RATE)).toBeNull();
  const earlier = bridgeSignature();
  earlier[5] = bridgeRead(boundary + 512, false, BRIDGE_NATIVE, {
    contextTime: 10.002,
    performanceTime: 999,
  });
  expect(siteBridgeGapInfeasibleAfterHold(earlier, BRIDGE_RATE)).toBeNull();
  const missing = bridgeSignature();
  missing[5] = bridgeRead(boundary + 512, false, BRIDGE_NATIVE, null);
  expect(siteBridgeGapInfeasibleAfterHold(missing, BRIDGE_RATE)).toBeNull();
});

test('site-bridge classifier refuses any scheduled-pcm error other than the single terminal refusal', () => {
  const intervening = bridgeSignature();
  intervening.splice(4, 0, bridgeError('underflow'));
  expect(siteBridgeGapInfeasibleAfterHold(intervening, BRIDGE_RATE)).toBeNull();
  const earlier = [bridgeError('earlier'), ...bridgeSignature()];
  expect(siteBridgeGapInfeasibleAfterHold(earlier, BRIDGE_RATE)).toBeNull();
});

test('site-bridge classifier requires the refusal evidence to precede the terminal error', () => {
  const useAfterError = bridgeSignature();
  const [terminalError] = useAfterError.splice(7, 1);
  useAfterError.splice(6, 0, terminalError!);
  expect(
    siteBridgeGapInfeasibleAfterHold(useAfterError, BRIDGE_RATE)
  ).toBeNull();
  const rejection = bridgeRejection('sub-resolution');
  const reordered = [
    rejection[0]!,
    rejection[1]!,
    rejection[2]!,
    rejection[3]!,
    rejection[5]!,
    rejection[4]!,
  ];
  expect(siteBridgeGapInfeasibleAfterHold(reordered, BRIDGE_RATE)).toBeNull();
});

test('site-bridge classifier ignores a native use that precedes the hold', () => {
  const early: BridgeEntry[] = [
    bridgeClosure(),
    bridgeRead(boundary + 512, false, BRIDGE_NATIVE),
    bridgeUse(),
    ...bridgeSignature().slice(1, 4),
    bridgeError(BRIDGE_HANDOFF),
  ];
  expect(siteBridgeGapInfeasibleAfterHold(early, BRIDGE_RATE)).toBeNull();
});

test('site-bridge classifier refuses a candidate refused after the hold', () => {
  const candidate = bridgeSignature();
  candidate.splice(
    5,
    0,
    bridgePcm({
      event: 'recovery-candidate-failed',
      code: 'descriptor-budget-exhausted',
      boundaryFrame: boundary,
    })
  );
  expect(siteBridgeGapInfeasibleAfterHold(candidate, BRIDGE_RATE)).toBeNull();
});

// Commit-lead classifier. Modelled on CI run 43181201646: the hold is consumed with the context
// on the boundary, lasts until the sink stamps again, the selection takes boundary + 960, and
// one 512-frame burst leaves a lead of 448 at the commit.
const COMMIT_REFUSED = 'recovery final clock or visual guard failed';
const COMMIT_STAMP = { contextTime: 10.003, performanceTime: 1009.9 };
const commitTrace = (
  patch: {
    selection?: Record<string, unknown>;
    commit?: Record<string, unknown>;
    commitFrame?: number;
    commitInjected?: boolean;
    heldFrame?: number;
    reread?: BridgeEntry[];
    fresh?: BridgeEntry;
    code?: string;
    extra?: BridgeEntry[];
  } = {}
): BridgeEntry[] => {
  const commitFrame = patch.commitFrame ?? boundary + 512;
  return [
    bridgeClosure(),
    bridgeMarker(),
    bridgeConsumed(),
    bridgeRead(patch.heldFrame ?? boundary, true, BRIDGE_HELD),
    ...(patch.reread ?? [
      bridgeMarker(),
      bridgeRead(boundary, true, BRIDGE_HELD),
    ]),
    bridgeMarker(),
    patch.fresh ?? bridgeRead(boundary, false, BRIDGE_NATIVE),
    bridgeUse(),
    bridgePcm({
      event: 'recovery-selection',
      boundaryFrame: boundary,
      f0: BRIDGE_GAP_UPPER,
      feasibleUpper: BRIDGE_GAP_UPPER,
      guardFrames: 512,
      contextFrame: boundary,
      ...patch.selection,
    }),
    ...(patch.extra ?? []),
    bridgePcm({ event: 'clock-site', site: 'commit', phase: 'read' }),
    bridgeRead(
      commitFrame,
      patch.commitInjected ?? false,
      COMMIT_STAMP,
      COMMIT_STAMP
    ),
    bridgePcm({
      event: 'clock-commit-detail',
      reason: 'observation-or-lead',
      stamp: COMMIT_STAMP,
      observation: {
        status: 'calibrated',
        reason: 'accepted',
        offsetMin: 1,
        offsetMax: 1.1,
      },
      readEnd: 1010,
      deadline: 1300,
      contextAfter: frameTime(commitFrame),
      contextFrame: BRIDGE_GAP_UPPER,
      guardFrames: 512,
      remainingLeadFrames: BRIDGE_GAP_UPPER - commitFrame,
      ...patch.commit,
    }),
    bridgeError(patch.code ?? COMMIT_REFUSED),
  ];
};

test('commit-lead classifier names a hold released by the next stamp and one burst', () => {
  const evidence = siteBridgeCommitLeadAfterHold(commitTrace(), BRIDGE_RATE);
  expect(evidence).toContain('one burst of 512 frames left a lead of 448');
  expect(
    siteBridgeGapInfeasibleAfterHold(commitTrace(), BRIDGE_RATE)
  ).toBeNull();
});

test('commit-lead classifier refuses a late commit, a kept lead, or an earlier selection', () => {
  // Two bursts: the viewer was late, not held.
  expect(
    siteBridgeCommitLeadAfterHold(
      commitTrace({ commitFrame: boundary + 768 }),
      BRIDGE_RATE
    )
  ).toBeNull();
  // The lead still met the guard, so the lead was not what failed.
  expect(
    siteBridgeCommitLeadAfterHold(
      commitTrace({ commitFrame: boundary + 384 }),
      BRIDGE_RATE
    )
  ).toBeNull();
  // The context did not move between the selection and the commit.
  expect(
    siteBridgeCommitLeadAfterHold(
      commitTrace({
        commitFrame: boundary,
        commit: { remainingLeadFrames: 960 },
      }),
      BRIDGE_RATE
    )
  ).toBeNull();
  for (const selection of [
    { f0: BRIDGE_GAP_UPPER - 1 },
    { feasibleUpper: BRIDGE_GAP_UPPER + 64 },
    { boundaryFrame: boundary + 128 },
    { guardFrames: 256 },
    { contextFrame: boundary + 512 },
  ])
    expect(
      siteBridgeCommitLeadAfterHold(commitTrace({ selection }), BRIDGE_RATE)
    ).toBeNull();
});

test('commit-lead classifier refuses a hold that did not last until the next stamp', () => {
  // A native bridge read before the fresh one: the viewer, not the hold, waited.
  expect(
    siteBridgeCommitLeadAfterHold(
      commitTrace({
        reread: [bridgeMarker(), bridgeRead(boundary, false, BRIDGE_NATIVE)],
      }),
      BRIDGE_RATE
    )
  ).toBeNull();
  // The read that ended the hold carried no newer stamp.
  expect(
    siteBridgeCommitLeadAfterHold(
      commitTrace({
        fresh: bridgeRead(boundary, false, BRIDGE_ANCHOR, BRIDGE_ANCHOR),
      }),
      BRIDGE_RATE
    )
  ).toBeNull();
  // The read that ended the hold was itself injected.
  expect(
    siteBridgeCommitLeadAfterHold(
      commitTrace({ fresh: bridgeRead(boundary, true, BRIDGE_HELD) }),
      BRIDGE_RATE
    )
  ).toBeNull();
  // The hold was already infeasible when it was consumed.
  expect(
    siteBridgeCommitLeadAfterHold(
      commitTrace({ heldFrame: boundary + 600 }),
      BRIDGE_RATE
    )
  ).toBeNull();
});

test('commit-lead classifier refuses a commit that failed for another reason', () => {
  for (const commit of [
    { reason: 'mapping' },
    { observation: { status: 'interrupted', reason: 'future' } },
    { observation: { status: 'calibrated', reason: 'duplicate' } },
    { readEnd: 1301 },
    { contextFrame: BRIDGE_GAP_UPPER - 128 },
    { remainingLeadFrames: 449 },
    { stamp: null },
  ])
    expect(
      siteBridgeCommitLeadAfterHold(commitTrace({ commit }), BRIDGE_RATE)
    ).toBeNull();
  expect(
    siteBridgeCommitLeadAfterHold(
      commitTrace({ commitInjected: true }),
      BRIDGE_RATE
    )
  ).toBeNull();
  expect(
    siteBridgeCommitLeadAfterHold(
      commitTrace({ code: BRIDGE_HANDOFF }),
      BRIDGE_RATE
    )
  ).toBeNull();
  for (const extra of [
    bridgePcm({ event: 'recovery-candidate-failed' }),
    bridgePcm({ event: 'recovery-fault', code: 'recovery-phase-mismatch' }),
    bridgePcm({ event: 'recovery-clock-observation-rejected' }),
    bridgePcm({ event: 'recovery-selection', boundaryFrame: boundary }),
  ])
    expect(
      siteBridgeCommitLeadAfterHold(
        commitTrace({ extra: [extra] }),
        BRIDGE_RATE
      )
    ).toBeNull();
  expect(
    siteBridgeCommitLeadAfterHold(
      [...commitTrace(), bridgeError(COMMIT_REFUSED)],
      BRIDGE_RATE
    )
  ).toBeNull();
});

// Final-guard classifier. Modelled on CI run 43295017278: the hold is consumed on a read whose
// native stamp the sink had already advanced, the selection takes boundary + 960, the commit
// keeps a lead of 704 after one 256-frame burst, and a second burst lands before the final guard.
const FINAL_GUARD = 'recovery final guard exceeded';
const finalGuardTrace = (
  patch: {
    commitFrame?: number;
    afterFrame?: number | null;
    commit?: Record<string, unknown>;
    extra?: BridgeEntry[];
    consumedNative?: Record<string, number>;
  } = {}
): BridgeEntry[] => {
  const commitFrame = patch.commitFrame ?? boundary + 256;
  const afterFrame =
    patch.afterFrame === undefined ? boundary + 512 : patch.afterFrame;
  return [
    bridgeClosure(),
    bridgeMarker(),
    bridgeConsumed(),
    bridgeRead(
      boundary,
      true,
      BRIDGE_HELD,
      patch.consumedNative ?? BRIDGE_NATIVE
    ),
    bridgeMarker(),
    bridgeRead(boundary, false, BRIDGE_NATIVE),
    bridgeUse(),
    bridgePcm({
      event: 'recovery-selection',
      boundaryFrame: boundary,
      f0: BRIDGE_GAP_UPPER,
      feasibleUpper: BRIDGE_GAP_UPPER,
      guardFrames: 512,
      contextFrame: boundary,
    }),
    ...(patch.extra ?? []),
    bridgePcm({
      event: 'clock-commit',
      contextFrame: BRIDGE_GAP_UPPER,
      guardFrames: 512,
      contextAfter: frameTime(commitFrame),
      remainingLeadFrames: BRIDGE_GAP_UPPER - commitFrame,
      ...patch.commit,
    }),
    bridgeError(FINAL_GUARD),
    ...(afterFrame === null
      ? []
      : [
          {
            kind: 'audio-startup-monitor',
            value: { bridge: { currentAfter: frameTime(afterFrame) } },
          },
        ]),
  ];
};

test('final-guard classifier names an accepted commit and the burst before the guard', () => {
  const evidence = siteBridgeFinalGuardAfterHold(
    finalGuardTrace(),
    BRIDGE_RATE
  );
  expect(evidence).toContain('kept a lead of 704');
  expect(evidence).toContain('a burst of 256 frames');
  // The other two classifiers do not claim it, and it does not claim theirs.
  expect(
    siteBridgeCommitLeadAfterHold(finalGuardTrace(), BRIDGE_RATE)
  ).toBeNull();
  expect(
    siteBridgeGapInfeasibleAfterHold(finalGuardTrace(), BRIDGE_RATE)
  ).toBeNull();
  expect(siteBridgeFinalGuardAfterHold(commitTrace(), BRIDGE_RATE)).toBeNull();
});

test('final-guard classifier refuses a late viewer, a kept guard, or a refused commit', () => {
  // The context two bursts past the commit: the viewer was late, not held.
  expect(
    siteBridgeFinalGuardAfterHold(
      finalGuardTrace({ afterFrame: boundary + 256 + 768 }),
      BRIDGE_RATE
    )
  ).toBeNull();
  // The context still met the guard when last read, so the guard was not what failed.
  expect(
    siteBridgeFinalGuardAfterHold(
      finalGuardTrace({ afterFrame: boundary + 448 }),
      BRIDGE_RATE
    )
  ).toBeNull();
  // No reading of the context after the refusal.
  expect(
    siteBridgeFinalGuardAfterHold(
      finalGuardTrace({ afterFrame: null }),
      BRIDGE_RATE
    )
  ).toBeNull();
  // The commit lost its lead: that is the commit classifier's signature.
  expect(
    siteBridgeFinalGuardAfterHold(
      finalGuardTrace({
        commitFrame: boundary + 768,
        commit: { remainingLeadFrames: BRIDGE_GAP_UPPER - boundary - 768 },
      }),
      BRIDGE_RATE
    )
  ).toBeNull();
  // A native stamp older than the anchor under the injected read is not a held re-read.
  expect(
    siteBridgeFinalGuardAfterHold(
      finalGuardTrace({
        consumedNative: { contextTime: 9.9, performanceTime: 990 },
      }),
      BRIDGE_RATE
    )
  ).toBeNull();
  // Another refusal or an injected overrun after the hold.
  for (const extra of [
    bridgePcm({ event: 'recovery-fault' }),
    bridgePcm({ event: 'recovery-candidate-failed' }),
    { kind: 'recovery-overrun-injected' },
  ])
    expect(
      siteBridgeFinalGuardAfterHold(
        finalGuardTrace({ extra: [extra] }),
        BRIDGE_RATE
      )
    ).toBeNull();
  // A second commit, or a commit refusal.
  expect(
    siteBridgeFinalGuardAfterHold(
      finalGuardTrace({
        extra: [bridgePcm({ event: 'clock-commit-detail' })],
      }),
      BRIDGE_RATE
    )
  ).toBeNull();
});

// Frontier-overshoot classifier. The boundary and the last read are the recorded 44.1 kHz refusal
// of CI run 43175372082: that read sat 128 frames short of the frontier. The context frame at the
// check, 384 past the frontier, is computed from the refusal (384 + 512 is 896, and the 20 ms gap
// is 882 frames); that run carried no event for it.
const OVER_RATE = 44100;
const OVER_BOUNDARY = 1254784;
const OVER_GAP_UPPER = OVER_BOUNDARY + 882;
const overRead = (frame: number, injected = false): BridgeEntry => ({
  kind: 'audio-output-timestamp-observed',
  value: { currentAfter: frame / OVER_RATE, injected },
});
const overRefusal = (
  patch: Record<string, unknown> = {}
): Record<string, unknown> => ({
  event: 'recovery-gap-infeasible',
  generation: 82,
  boundaryFrame: OVER_BOUNDARY,
  contextFrame: OVER_BOUNDARY + 384,
  guardFrames: 512,
  gapUpper: OVER_GAP_UPPER,
  checks: 0,
  ...patch,
});
const overTrace = (
  patch: {
    refusal?: Record<string, unknown>;
    gate?: Record<string, unknown>;
    lastRead?: BridgeEntry;
    between?: BridgeEntry[];
    error?: Record<string, unknown>;
  } = {}
): BridgeEntry[] => [
  patch.lastRead ?? overRead(OVER_BOUNDARY - 128),
  bridgePcm({
    event: 'gate-close',
    generation: 82,
    reason: 'frontier',
    contextStopFrame: OVER_BOUNDARY,
    ...patch.gate,
  }),
  bridgePcm({ event: 'recovery-request', boundaryFrame: OVER_BOUNDARY }),
  bridgePcm({ event: 'recovery-render-closed', boundaryFrame: OVER_BOUNDARY }),
  ...(patch.between ?? []),
  bridgePcm(overRefusal(patch.refusal)),
  bridgePcm({ event: 'cancel', generation: 82, reason: 'underflow' }),
  bridgePcm({
    event: 'error',
    stage: 'schedule',
    code: BRIDGE_HANDOFF,
    ...patch.error,
  }),
];

test('frontier-overshoot classifier names the recorded 44.1 kHz refusal', () => {
  const evidence = recoveryFrontierOvershoot(overTrace(), OVER_RATE);
  expect(evidence).toContain('overshot by 384 frames');
  expect(evidence).toContain(`gap upper ${OVER_GAP_UPPER}`);
});

test('frontier-overshoot classifier accepts the closing burst read before its closure arrives', () => {
  // CI run 43270214432: a tick read 1257856, 384 past the frontier, 1.5 ms before the main
  // thread received the closure. The refusal saw the same frame, so one burst did it.
  const early = overRead(OVER_BOUNDARY + 384);
  expect(
    recoveryFrontierOvershoot(
      [overRead(OVER_BOUNDARY - 128), ...overTrace({ lastRead: early })],
      OVER_RATE
    )
  ).toContain('overshot by 384 frames');
  // With no read from before the frontier, the burst is not shown to be the closing one.
  expect(
    recoveryFrontierOvershoot(overTrace({ lastRead: early }), OVER_RATE)
  ).toBeNull();
  // An injected read is never passed over.
  expect(
    recoveryFrontierOvershoot(
      [
        overRead(OVER_BOUNDARY - 128),
        ...overTrace({ lastRead: overRead(OVER_BOUNDARY + 384, true) }),
      ],
      OVER_RATE
    )
  ).toBeNull();
  // A read past the frontier at another frame means more was rendered before the refusal.
  expect(
    recoveryFrontierOvershoot(
      [
        overRead(OVER_BOUNDARY - 128),
        ...overTrace({ lastRead: overRead(OVER_BOUNDARY + 128) }),
      ],
      OVER_RATE
    )
  ).toBeNull();
});

test('frontier-overshoot classifier refuses a late or feasible recovery', () => {
  // A second burst always puts the overshoot at one guard or more: that is a late recovery.
  expect(
    recoveryFrontierOvershoot(
      overTrace({ refusal: { contextFrame: OVER_BOUNDARY + 512 } }),
      OVER_RATE
    )
  ).toBeNull();
  expect(
    recoveryFrontierOvershoot(
      overTrace({ refusal: { contextFrame: OVER_BOUNDARY + 768 } }),
      OVER_RATE
    )
  ).toBeNull();
  // Not the first check: the viewer waited before it refused.
  expect(
    recoveryFrontierOvershoot(overTrace({ refusal: { checks: 1 } }), OVER_RATE)
  ).toBeNull();
  // A 256-frame overshoot fits the gap, so a refusal there is not this signature.
  expect(
    recoveryFrontierOvershoot(
      overTrace({ refusal: { contextFrame: OVER_BOUNDARY + 256 } }),
      OVER_RATE
    )
  ).toBeNull();
  // At 48 kHz the same overshoot fits: 384 + 512 is under 960.
  expect(
    recoveryFrontierOvershoot(
      overTrace({ refusal: { gapUpper: OVER_BOUNDARY + 960 } }),
      48000
    )
  ).toBeNull();
  // The context had already passed the frontier at the last read before the closure.
  expect(
    recoveryFrontierOvershoot(
      overTrace({ lastRead: overRead(OVER_BOUNDARY + 128) }),
      OVER_RATE
    )
  ).toBeNull();
});

test('frontier-overshoot classifier refuses evidence that does not agree', () => {
  for (const refusal of [
    { gapUpper: OVER_GAP_UPPER + 1 },
    { guardFrames: 256 },
    { boundaryFrame: OVER_BOUNDARY - 128 },
    { generation: 83 },
    { contextFrame: OVER_BOUNDARY - 128 },
    { contextFrame: 1.5 },
  ])
    expect(
      recoveryFrontierOvershoot(overTrace({ refusal }), OVER_RATE)
    ).toBeNull();
  expect(
    recoveryFrontierOvershoot(
      overTrace({ gate: { reason: 'pause' } }),
      OVER_RATE
    )
  ).toBeNull();
  expect(
    recoveryFrontierOvershoot(
      overTrace({ error: { code: BRIDGE_CLOCK } }),
      OVER_RATE
    )
  ).toBeNull();
  expect(
    recoveryFrontierOvershoot(
      overTrace({ error: { stage: 'clock' } }),
      OVER_RATE
    )
  ).toBeNull();
  expect(
    recoveryFrontierOvershoot(
      [...overTrace(), bridgePcm({ event: 'error', code: BRIDGE_HANDOFF })],
      OVER_RATE
    )
  ).toBeNull();
  expect(
    recoveryFrontierOvershoot(
      overTrace().filter(
        (entry) => entry.value?.['event'] !== 'recovery-render-closed'
      ),
      OVER_RATE
    )
  ).toBeNull();
  expect(
    recoveryFrontierOvershoot(
      overTrace().filter(
        (entry) => entry.value?.['event'] !== 'recovery-gap-infeasible'
      ),
      OVER_RATE
    )
  ).toBeNull();
  expect(recoveryFrontierOvershoot(overTrace().slice(1), OVER_RATE)).toBeNull();
});

test('frontier-overshoot classifier refuses anything injected or any further recovery step', () => {
  for (const entry of [
    overRead(OVER_BOUNDARY + 384, true),
    { kind: 'clock-site-hold-consumed', value: { site: 'recovery-bridge' } },
    { kind: 'recovery-overrun-injected', value: {} },
    bridgePcm({ event: 'recovery-fault', code: 'recovery-delayed-staging' }),
    bridgePcm({ event: 'recovery-selection', boundaryFrame: OVER_BOUNDARY }),
    bridgePcm({ event: 'recovery-candidate-failed' }),
    bridgePcm({ event: 'epoch', generation: 83 }),
  ] as BridgeEntry[])
    expect(
      recoveryFrontierOvershoot(overTrace({ between: [entry] }), OVER_RATE)
    ).toBeNull();
  // A native read between the closure and the refusal changes nothing.
  expect(
    recoveryFrontierOvershoot(
      overTrace({ between: [overRead(OVER_BOUNDARY + 384)] }),
      OVER_RATE
    )
  ).not.toBeNull();
});

// Natural-starvation classifier. Modelled on CI runs 43279024045, 43290221910 and 43297935043.
const starved = (...tail: BridgeEntry[]): BridgeEntry[] => [
  bridgePcm({
    event: 'gate-close',
    reason: 'frontier',
    contextStopFrame: 1000,
  }),
  bridgePcm({ event: 'recovery-request', boundaryFrame: 1000 }),
  ...tail,
];
const underflow = () => bridgePcm({ event: 'cancel', reason: 'underflow' });
const visualRefusal = (code = 'recovery-frame-unavailable'): BridgeEntry =>
  bridgePcm({ event: 'error', stage: 'visual', code });

test('natural-starvation classifier names each recovery refusal after a frontier close', () => {
  for (const trace of [
    // The recovery had no frame for a video source.
    starved(
      visualRefusal(),
      underflow(),
      bridgeError('committed recovery frame is unavailable')
    ),
    // The output clock was already past the gap, with and without the gap refusal event.
    starved(underflow(), bridgeError(BRIDGE_HANDOFF)),
    starved(
      bridgePcm({ event: 'recovery-gap-infeasible' }),
      underflow(),
      bridgeError(BRIDGE_HANDOFF)
    ),
    // A burst before the final guard.
    starved(bridgeError('recovery final guard exceeded'), underflow()),
    starved(visualRefusal('recovery-phase-expired'), underflow()),
  ])
    expect(naturalStarvation(trace)).toContain('frontier closed at frame 1000');
});

test('natural-starvation classifier refuses anything else', () => {
  // No frontier close first: the run did not starve, or the fault came before the close.
  expect(
    naturalStarvation([underflow(), bridgeError(BRIDGE_HANDOFF)])
  ).toBeNull();
  expect(
    naturalStarvation([
      bridgeError(BRIDGE_HANDOFF),
      bridgePcm({ event: 'gate-close', reason: 'frontier' }),
    ])
  ).toBeNull();
  expect(
    naturalStarvation([
      bridgePcm({ event: 'gate-close', reason: 'abort' }),
      underflow(),
      bridgeError(BRIDGE_HANDOFF),
    ])
  ).toBeNull();
  // A cancel alone is no refusal, and any other fault code or cancel reason is a different failure.
  expect(naturalStarvation(starved(underflow()))).toBeNull();
  expect(naturalStarvation(starved())).toBeNull();
  expect(
    naturalStarvation(
      starved(
        underflow(),
        bridgePcm({
          event: 'error',
          stage: 'provider',
          code: 'PCM provider failed',
        })
      )
    )
  ).toBeNull();
  expect(
    naturalStarvation(
      starved(
        underflow(),
        bridgePcm({
          event: 'error',
          stage: 'schedule',
          code: 'transport stop rejected: invalid stop',
        })
      )
    )
  ).toBeNull();
  expect(
    naturalStarvation(
      starved(
        bridgePcm({ event: 'cancel', reason: 'seek' }),
        bridgeError(BRIDGE_HANDOFF)
      )
    )
  ).toBeNull();
  // The wrong stage for a code from the other table.
  expect(
    naturalStarvation(starved(visualRefusal(BRIDGE_HANDOFF), underflow()))
  ).toBeNull();
  // Anything the proof injected is its own control, not natural.
  for (const injected of [
    bridgePcm({ event: 'recovery-fault', code: 'recovery-delayed-staging' }),
    { kind: 'recovery-overrun-injected', value: {} },
    bridgeConsumed(),
  ])
    expect(
      naturalStarvation(
        starved(injected, underflow(), bridgeError(BRIDGE_HANDOFF))
      )
    ).toBeNull();
  // The constructor of a plain record is no refusal code.
  expect(
    naturalStarvation(
      starved(
        underflow(),
        bridgePcm({ event: 'error', stage: 'schedule', code: 'constructor' })
      )
    )
  ).toBeNull();
});

// CI run 43376038918: the play request was refused 91 ms in, 0.2 ms past the video phase band.
const STARTUP_BAND_REFUSAL =
  'no causal audio epoch: the earliest guarded epoch is past the video phase band';

test('natural-starvation classifier names a startup refusal before any audio epoch', () => {
  expect(
    naturalStarvation([
      bridgePcm({ event: 'backend', backend: 'pcm' }),
      underflow(),
      bridgeError(STARTUP_BAND_REFUSAL),
    ])
  ).toContain('startup refused before any audio epoch');
});

// CI run 43377955990: the stage paused a held start on purpose, and the restart was refused
// 1.58 ms past the band.
const playRequest = (): BridgeEntry => ({ kind: 'play-request', value: {} });
const ringRefused = (): BridgeEntry => ({
  kind: 'cold-controller',
  value: {
    event: 'ring-refused',
    earliestWall: 1602.6797,
    upperWall: 1601.1,
    slots: 5,
    requiredSlots: 5,
  },
});

test('natural-starvation classifier judges a startup refusal from the last play request', () => {
  const restarted = naturalStarvation([
    playRequest(),
    bridgePcm({ event: 'cancel', reason: 'pause' }),
    playRequest(),
    ringRefused(),
    underflow(),
    bridgeError(STARTUP_BAND_REFUSAL),
  ]);
  expect(restarted).toContain('startup refused before any audio epoch');
  expect(restarted).toContain(
    "earliest epoch 1602.680 ms against the band's upper edge 1601.100 ms, 5 of 5 ring slots"
  );
  // The last start had an epoch, a closed frontier or another cancel: not a refused start.
  for (const after of [
    bridgePcm({ event: 'epoch', generation: 4 }),
    bridgePcm({ event: 'gate-close', reason: 'frontier' }),
    bridgePcm({ event: 'cancel', reason: 'pause' }),
    bridgeError('PCM provider failed'),
  ])
    expect(
      naturalStarvation([
        playRequest(),
        after,
        underflow(),
        bridgeError(STARTUP_BAND_REFUSAL),
      ])
    ).toBeNull();
  // An injection anywhere in the trace is the proof's own control.
  expect(
    naturalStarvation([
      bridgeConsumed(),
      playRequest(),
      underflow(),
      bridgeError(STARTUP_BAND_REFUSAL),
    ])
  ).toBeNull();
});

test('natural-starvation classifier refuses a startup refusal that is anything else', () => {
  // Playback that had an epoch, or a closed frontier, is not a start that never happened.
  for (const earlier of [
    bridgePcm({ event: 'epoch', generation: 3 }),
    bridgePcm({ event: 'gate-close', reason: 'frontier' }),
    bridgePcm({ event: 'recovery-fault', code: 'recovery-delayed-staging' }),
    { kind: 'recovery-overrun-injected', value: {} },
    bridgeConsumed(),
  ] as BridgeEntry[])
    expect(
      naturalStarvation([
        earlier,
        underflow(),
        bridgeError(STARTUP_BAND_REFUSAL),
      ])
    ).toBeNull();
  // Another cancel reason, another code, or the refusal with no cancel at all.
  expect(
    naturalStarvation([
      bridgePcm({ event: 'cancel', reason: 'seek' }),
      bridgeError(STARTUP_BAND_REFUSAL),
    ])
  ).toBeNull();
  expect(
    naturalStarvation([underflow(), bridgeError('PCM provider failed')])
  ).toBeNull();
  expect(naturalStarvation([underflow()])).toBeNull();
  // The refusal text the reader shows names it too, and only when the marker is there.
  expect(
    starvationRefusalText(`Scheduled audio stopped: ${STARTUP_BAND_REFUSAL}`)
  ).toBe(STARTUP_BAND_REFUSAL);
  expect(starvationRefusalText(STARTUP_BAND_REFUSAL)).toBeNull();
});

test('starvation refusal text names a recovery refusal and nothing else', () => {
  expect(
    starvationRefusalText(
      'unsupported-browser · Scheduled audio stopped: committed recovery frame is unavailable unsupported-browser · Scheduled audio stopped: committed recovery frame is unavailable'
    )
  ).toBe('committed recovery frame is unavailable');
  expect(
    starvationRefusalText(`Scheduled audio stopped: ${BRIDGE_HANDOFF}`)
  ).toBe(BRIDGE_HANDOFF);
  expect(starvationRefusalText('')).toBeNull();
  expect(
    starvationRefusalText('Scheduled audio stopped: PCM provider failed')
  ).toBeNull();
  expect(
    starvationRefusalText(
      'Scheduled audio stopped: transport stop rejected: invalid stop'
    )
  ).toBeNull();
  expect(
    starvationRefusalText(`${BRIDGE_HANDOFF} without the stopped marker`)
  ).toBeNull();
});
