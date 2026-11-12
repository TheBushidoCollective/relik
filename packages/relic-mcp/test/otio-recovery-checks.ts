import assert from 'node:assert/strict';

// The budget fault is consumed during candidate staging, before the gate closes.
export function assertDescriptorBudgetRefusal(
  events: readonly Record<string, unknown>[],
  closedIndex: number,
  boundary: number
): number {
  const stagings = events
    .slice(0, closedIndex)
    .filter(
      (event) =>
        event['event'] === 'recovery-candidate-ready' ||
        event['event'] === 'recovery-candidate-failed'
    );
  assert.ok(
    stagings.length > 0 &&
      stagings.every(
        (event) =>
          event['event'] === 'recovery-candidate-failed' &&
          event['code'] === 'descriptor-budget-exhausted' &&
          event['reason'] === 'PCM byte budget exceeded'
      ),
    'descriptor-budget fault was not consumed by every candidate staging before the closure'
  );
  const refusalIndex = events.findIndex(
    (event, index) =>
      index > closedIndex &&
      event['event'] === 'recovery-candidate-failed' &&
      event['code'] === 'descriptor-budget-exhausted' &&
      event['boundaryFrame'] === boundary
  );
  assert.ok(
    refusalIndex > closedIndex,
    'descriptor budget exhaustion did not refuse the successor candidate'
  );
  assert.ok(
    events
      .slice(refusalIndex + 1)
      .some(
        (event) =>
          event['event'] === 'error' &&
          event['code'] === 'descriptor-budget-exhausted'
      ),
    'descriptor budget refusal was not visible as an interruption'
  );
  assert.ok(
    !events
      .slice(closedIndex + 1)
      .some(
        (event) =>
          event['event'] === 'recovery-selection' ||
          event['event'] === 'recovery-candidate-ready' ||
          event['event'] === 'epoch'
      ),
    'descriptor budget refusal still admitted a successor epoch'
  );
  return refusalIndex;
}

export function assertShiftedBankRefusal(
  events: readonly { kind: string; value?: unknown }[]
): void {
  const entries = events.map((event, index) => ({
    kind: event.kind,
    value: (event.value ?? {}) as Record<string, unknown>,
    index,
  }));
  const gates = entries.filter((e) => e.kind === 'witness-attach');
  assert.equal(
    gates.length,
    2,
    'shift-bank requires exactly one bounded retry'
  );
  const first = gates[0]!.value;
  const second = gates[1]!.value;
  const epoch1 = Number(first['clockEpoch']),
    epoch2 = Number(second['clockEpoch']);
  const a1 = Number(first['gateInitialFrame']),
    a2 = Number(second['gateInitialFrame']);
  assert.ok(
    Number.isSafeInteger(epoch1) &&
      epoch2 > epoch1 &&
      Number.isSafeInteger(a1) &&
      a2 > a1,
    'invalid retry gate identity'
  );
  const injections = entries.filter(
    (e) =>
      e.kind === 'anchor-bank-control-injected' &&
      e.value['kind'] === 'shift-bank'
  );
  assert.deepEqual(
    injections.map((e) => e.value['initialFrame']),
    [a1, a2],
    'gate ran without the shifted bank'
  );
  const late = entries.filter(
    (e) => e.kind === 'transport-message' && e.value['type'] === 'anchor-late'
  );
  assert.deepEqual(
    late.map((e) => [
      e.value['clockEpoch'],
      e.value['firstFrame'],
      e.value['observedFrame'],
    ]),
    [
      [epoch1, a1, a1 + 1],
      [epoch2, a2, a2 + 1],
    ],
    'shifted banks did not produce the expected native refusals'
  );
  assert.ok(
    late[0]!.index < gates[1]!.index && gates[1]!.index < late[1]!.index,
    'retry preceded the first refusal'
  );
  assert.ok(
    !entries.some(
      (e) =>
        (e.kind === 'transport-message' &&
          [
            'clock-fault',
            'anchor-certified',
            'bank-installed',
            'clock-promoted',
          ].includes(String(e.value['type']))) ||
        (e.kind === 'transport-command' &&
          ['arm', 'extend', 'install-bank'].includes(
            String(e.value['type'])
          )) ||
        (e.kind === 'scheduled-pcm' && e.value['event'] === 'epoch')
    ),
    'shifted bank admitted a clock or media epoch'
  );
  assert.ok(
    entries.some(
      (e) =>
        e.index > late[1]!.index &&
        e.kind === 'scheduled-pcm' &&
        e.value['event'] === 'error' &&
        String(e.value['code']).includes(
          `Transport anchor late: anchor ${a2}, observed ${a2 + 1}`
        )
    ),
    'second shifted bank did not report its refusal'
  );
}

// Held pulls are released on the first closure, before the successor's handoff frontier.
// The trace index is the ordering authority; timestamps only corroborate it.
export function assertHeldReleaseBeforeSuccessor(
  events: readonly { kind: string; timestamp: number; value?: unknown }[]
): { closureIndex: number; releaseIndex: number; handoffIndex: number } {
  const payload = (event: { value?: unknown }): Record<string, unknown> =>
    (event.value ?? {}) as Record<string, unknown>;
  const fieldValue = (field: unknown): unknown =>
    (field as { value?: unknown } | null | undefined)?.value;
  const isPcm = (event: { kind: string; value?: unknown }, name: string) =>
    event.kind === 'scheduled-pcm' && payload(event)['event'] === name;

  const closureIndex = events.findIndex((e) =>
    isPcm(e, 'recovery-render-closed')
  );
  assert.ok(
    closureIndex >= 0,
    'first recovery-render-closed closure is missing'
  );
  const closure = payload(events[closureIndex]!);
  assert.equal(
    closure['descriptorReady'],
    true,
    'first closure was not descriptor-ready'
  );
  const generation = closure['generation'];
  const lastBefore = (name: string): number => {
    for (let i = closureIndex - 1; i >= 0; i--) {
      const e = events[i]!;
      if (isPcm(e, name) && payload(e)['generation'] === generation) return i;
    }
    return -1;
  };

  // Starvation premise: the predecessor was gate-closed at a frontier, and its
  // last frontier before the closure already covers exactly what was closed.
  const gateIndex = lastBefore('gate-close');
  assert.ok(
    gateIndex >= 0,
    'closure has no preceding gate-close of its generation'
  );
  const gate = payload(events[gateIndex]!);
  assert.equal(
    gate['reason'],
    'frontier',
    'predecessor was not gate-closed at a frontier'
  );
  assert.equal(
    fieldValue(gate['compositionStop']),
    fieldValue(closure['compositionStop']),
    'gate-close and closure disagree on the composition stop'
  );
  const frontierIndex = lastBefore('frontier');
  assert.ok(
    frontierIndex >= 0,
    'predecessor has no frontier before its closure'
  );
  const frontier = payload(events[frontierIndex]!);
  const decodedCap = frontier['decodedCap'];
  assert.equal(
    fieldValue(frontier['compositionThrough']),
    decodedCap,
    'predecessor frontier did not reach its decode cap'
  );
  assert.equal(
    fieldValue(closure['compositionStop']),
    decodedCap,
    "closure is not at the predecessor's decode cap"
  );
  assert.equal(
    frontier['preparedThrough'],
    closure['preparedThrough'],
    'predecessor prepared frontier moved between its last frontier and the closure'
  );
  assert.ok(
    Number(frontier['reserveFrames']) > 0,
    'predecessor frontier reserved no frames'
  );

  // Release: exactly one, armed on this closure, freeing at least one held pull.
  const releases = events.flatMap((e, index) =>
    e.kind === 'pcm-hold-release' ? [index] : []
  );
  assert.ok(releases.length > 0, 'no pcm-hold-release was recorded');
  assert.equal(
    releases.length,
    1,
    'more than one pcm-hold-release was recorded'
  );
  const releaseIndex = releases[0]!;
  const release = payload(events[releaseIndex]!);
  assert.equal(
    release['triggerIndex'],
    closureIndex,
    'release was not armed on the first closure'
  );
  assert.ok(Number(release['released']) >= 1, 'release freed no held pulls');

  const handoffIndex = events.findIndex(
    (e, index) =>
      index > closureIndex &&
      isPcm(e, 'frontier') &&
      payload(e)['frontierKind'] === 'handoff'
  );
  assert.ok(
    handoffIndex > closureIndex,
    'no handoff frontier followed the closure'
  );

  const at = (index: number) => `${index} at ${events[index]!.timestamp} ms`;
  const ordered =
    closureIndex < releaseIndex &&
    releaseIndex < handoffIndex &&
    events[closureIndex]!.timestamp <= events[releaseIndex]!.timestamp &&
    events[releaseIndex]!.timestamp <= events[handoffIndex]!.timestamp;
  assert.ok(
    ordered,
    `pulls were not released before the successor frontier; ordering not reached (closure ${at(closureIndex)}, release ${at(releaseIndex)}, handoff ${at(handoffIndex)})`
  );
  return { closureIndex, releaseIndex, handoffIndex };
}

// The one-shot recovery-bridge hold lands on a first bridge read. The held stamp is then
// re-read, and the successor edge falls past the recovery gap, so the recovery refuses inside
// its own gap. Every clause below must hold or the classifier returns null, and a null is a
// failed attempt, never a rerun. Frames are ceil(seconds * rate), as the proof defines them.
const RECOVERY_BRIDGE_SITE = 'recovery-bridge';
const GAP_GUARD_FRAMES = 512;
const HANDOFF_REFUSAL = 'recovery render handoff has no feasible frame';
const CAUSAL_REFUSAL = 'video recovery phase has no causal audio epoch';
const CLOCK_REFUSAL = 'fresh recovery output clock unavailable';
const REJECTED_FRESH_REASONS: Record<string, true> = {
  accepted: true,
  duplicate: true,
  'sub-resolution': true,
};

interface TraceEntry {
  kind: string;
  value?: unknown;
}
interface Stamp {
  contextTime: number;
  performanceTime: number;
}

function entryValue(entry: TraceEntry | undefined): Record<string, unknown> {
  return (entry?.value ?? {}) as Record<string, unknown>;
}

function stampOf(value: unknown): Stamp | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const contextTime = record['contextTime'];
  const performanceTime = record['performanceTime'];
  if (typeof contextTime !== 'number' || typeof performanceTime !== 'number')
    return null;
  if (!Number.isFinite(contextTime) || !Number.isFinite(performanceTime))
    return null;
  return { contextTime, performanceTime };
}

function sameStamp(a: Stamp | null, b: Stamp | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.contextTime === b.contextTime &&
    a.performanceTime === b.performanceTime
  );
}

function isPcm(entry: TraceEntry | undefined, name: string): boolean {
  return entry?.kind === 'scheduled-pcm' && entryValue(entry)['event'] === name;
}

function isBridgeMarker(
  entry: TraceEntry | undefined,
  phase: 'read' | 'use'
): boolean {
  return (
    isPcm(entry, 'clock-site') &&
    entryValue(entry)['site'] === RECOVERY_BRIDGE_SITE &&
    entryValue(entry)['phase'] === phase
  );
}

function isObservedRead(entry: TraceEntry | undefined): boolean {
  return entry?.kind === 'audio-output-timestamp-observed';
}

function ceilFrame(seconds: unknown, rate: number): number | null {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? Math.ceil(seconds * rate)
    : null;
}

// Frame of an observed read: ceil of its context time after the read.
function readFrame(entry: TraceEntry | undefined, rate: number): number | null {
  return ceilFrame(entryValue(entry)['currentAfter'], rate);
}

// Returns evidence only for the exact gap-infeasible signature after a one-shot
// recovery-bridge hold, or null for every other trace (including every near miss).
export function siteBridgeGapInfeasibleAfterHold(
  events: readonly TraceEntry[],
  rate: number
): string | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const consumptions: number[] = [];
  events.forEach((entry, index) => {
    if (
      entry.kind === 'clock-site-hold-consumed' &&
      entryValue(entry)['site'] === RECOVERY_BRIDGE_SITE
    )
      consumptions.push(index);
  });
  if (consumptions.length !== 1) return null;
  const at = consumptions[0]!;
  const consumed = entryValue(events[at]);
  const held = stampOf(consumed);
  const anchor = stampOf(consumed['anchor']);
  if (held === null || anchor === null) return null;

  // (a) ordering: the marker names the anchor, and the held read follows it at once.
  if (
    !isBridgeMarker(events[at - 1], 'read') ||
    !sameStamp(stampOf(entryValue(events[at - 1])['lastAccepted']), anchor)
  )
    return null;
  const consumedRead = events[at + 1];
  if (!isObservedRead(consumedRead)) return null;
  const consumedValue = entryValue(consumedRead);
  if (
    consumedValue['injected'] !== true ||
    consumedValue['site'] !== RECOVERY_BRIDGE_SITE ||
    !sameStamp(stampOf(consumedValue['output']), held)
  )
    return null;

  // (b) the gap, from the last closure before the consumption.
  let closure = -1;
  for (let i = at - 1; i >= 0 && closure < 0; i--)
    if (isPcm(events[i], 'recovery-render-closed')) closure = i;
  if (closure < 0) return null;
  const boundary = entryValue(events[closure])['boundaryFrame'];
  if (typeof boundary !== 'number' || !Number.isSafeInteger(boundary))
    return null;
  const gapUpper = boundary + Math.floor(0.02 * rate);

  // (c) the held read was itself still feasible.
  const heldFrame = readFrame(consumedRead, rate);
  if (heldFrame === null || heldFrame + GAP_GUARD_FRAMES > gapUpper)
    return null;

  // (d) every feasible bridge read after the consumption was injected, so only the hold is blamed.
  for (let i = at + 1; i < events.length; i++) {
    if (!isObservedRead(events[i]) || !isBridgeMarker(events[i - 1], 'read'))
      continue;
    const frame = readFrame(events[i], rate);
    if (frame === null) return null;
    if (
      frame + GAP_GUARD_FRAMES <= gapUpper &&
      entryValue(events[i])['injected'] !== true
    )
      return null;
  }

  // A recovery that reached a successor would have selected one.
  if (events.some((entry) => isPcm(entry, 'recovery-selection'))) return null;

  // The terminal refusal is the last scheduled-pcm error of the trace.
  let terminal: TraceEntry | undefined;
  for (const entry of events) if (isPcm(entry, 'error')) terminal = entry;
  if (terminal === undefined) return null;
  const code = entryValue(terminal)['code'];

  // (e1) a native use whose preceding bridge read was not injected and is past the gap.
  let nativeRead = false;
  for (let u = at + 1; u < events.length; u++) {
    if (!isBridgeMarker(events[u], 'use')) continue;
    let marker = -1;
    for (let r = u - 1; r > at; r--)
      if (isBridgeMarker(events[r], 'read')) {
        marker = r;
        break;
      }
    if (marker < 0 || !isObservedRead(events[marker + 1])) continue;
    const frame = readFrame(events[marker + 1], rate);
    if (
      entryValue(events[marker + 1])['injected'] === false &&
      frame !== null &&
      frame + GAP_GUARD_FRAMES > gapUpper
    )
      nativeRead = true;
  }

  // (e2) a fresh clock observation after the hold, feasible to use but past the gap.
  const rejected = events.some((entry, index) => {
    if (index <= at || !isPcm(entry, 'recovery-clock-observation-rejected'))
      return false;
    const value = entryValue(entry);
    const observation = value['observation'];
    const reason =
      typeof observation === 'object' && observation !== null
        ? (observation as Record<string, unknown>)['reason']
        : undefined;
    const frame = ceilFrame(value['contextAfter'], rate);
    return (
      frame !== null &&
      frame + GAP_GUARD_FRAMES > gapUpper &&
      typeof reason === 'string' &&
      REJECTED_FRESH_REASONS[reason] === true
    );
  });

  const handoffRefusal =
    (code === HANDOFF_REFUSAL || code === CAUSAL_REFUSAL) && nativeRead;
  const clockRefusal = code === CLOCK_REFUSAL && rejected;
  if (!handoffRefusal && !clockRefusal) return null;
  return `${RECOVERY_BRIDGE_SITE} hold consumed at frame ${heldFrame} with gap upper ${gapUpper} (boundary ${boundary}); refused by "${String(code)}" via ${handoffRefusal ? 'a native read' : 'a rejected fresh clock'}`;
}
