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

  // The trace must hold exactly one scheduled-pcm error, and it is the terminal refusal.
  // Any other error, before or after the hold, means this is not the measured signature.
  const errorAt: number[] = [];
  events.forEach((entry, index) => {
    if (isPcm(entry, 'error')) errorAt.push(index);
  });
  if (errorAt.length !== 1) return null;
  const terminal = errorAt[0]!;
  const code = entryValue(events[terminal])['code'];

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
  if (at >= terminal) return null;
  const consumed = entryValue(events[at]);
  const held = stampOf(consumed);
  const anchor = stampOf(consumed['anchor']);
  if (held === null || anchor === null) return null;

  // (a) ordering: the marker names the anchor, and the held read follows it at once. That read
  // is injected, reports the held stamp, and its native pair is the anchor itself (a re-read).
  if (
    !isBridgeMarker(events[at - 1], 'read') ||
    !sameStamp(stampOf(entryValue(events[at - 1])['lastAccepted']), anchor)
  )
    return null;
  const consumedRead = events[at + 1];
  if (!isObservedRead(consumedRead) || at + 1 >= terminal) return null;
  const consumedValue = entryValue(consumedRead);
  if (
    consumedValue['injected'] !== true ||
    consumedValue['site'] !== RECOVERY_BRIDGE_SITE ||
    !sameStamp(stampOf(consumedValue['output']), held) ||
    !sameStamp(stampOf(consumedValue['native']), anchor)
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

  // (d) every feasible bridge read between the hold and the refusal was injected, so only the
  // hold, never a product delay, is blamed.
  for (let i = at + 1; i < terminal; i++) {
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

  // Any selection, or any candidate refused after the hold, means recovery did not fail inside its gap.
  if (events.some((entry) => isPcm(entry, 'recovery-selection'))) return null;
  if (
    events.some(
      (entry, index) => index > at && isPcm(entry, 'recovery-candidate-failed')
    )
  )
    return null;

  // (e1) a native use between the hold and the refusal, whose preceding bridge read was not
  // injected, carries a fresh native stamp (performanceTime past the anchor), and sits past the gap.
  let nativeRead = false;
  for (let u = at + 1; u < terminal; u++) {
    if (!isBridgeMarker(events[u], 'use')) continue;
    let marker = -1;
    for (let r = u - 1; r > at; r--)
      if (isBridgeMarker(events[r], 'read')) {
        marker = r;
        break;
      }
    if (marker < 0 || marker + 1 >= u || !isObservedRead(events[marker + 1]))
      continue;
    const read = entryValue(events[marker + 1]);
    const native = stampOf(read['native']);
    const frame = readFrame(events[marker + 1], rate);
    if (
      read['injected'] === false &&
      native !== null &&
      native.performanceTime > anchor.performanceTime &&
      frame !== null &&
      frame + GAP_GUARD_FRAMES > gapUpper
    )
      nativeRead = true;
  }

  // (e2) a fresh clock observation rejected between the hold and the refusal, feasible to use
  // but past the gap.
  const rejected = events.some((entry, index) => {
    if (
      index <= at ||
      index >= terminal ||
      !isPcm(entry, 'recovery-clock-observation-rejected')
    )
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

function safeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : null;
}

const COMMIT_REFUSAL = 'recovery final clock or visual guard failed';

// The same one-shot recovery-bridge hold, refused one step later. The hold holds every read of
// its performanceTime, so it ends only when the sink stamps again, and on a 10 ms sink that
// stamp comes with the next render burst. The fresh read is still feasible and the selection
// takes the last frame the 20 ms gap allows, but the burst lands before the commit read and
// the lead falls under the guard (run 43181201646: lead 960 at selection, 448 at commit). The
// hold is blamed only when it was feasible as consumed, every bridge read until the stamp
// advanced was injected, the selection had no later frame to take, the commit clock was
// accepted, the lead is the only failing clause, and the context moved by one burst at most
// between the selection and the commit. Every clause must hold or the classifier returns null.
export function siteBridgeCommitLeadAfterHold(
  events: readonly TraceEntry[],
  rate: number
): string | null {
  const prefix = siteBridgeHoldPrefix(events, rate, COMMIT_REFUSAL);
  if (prefix === null) return null;
  const {
    terminal,
    at,
    boundary,
    gapUpper,
    heldFrame,
    selectedAt,
    selectionFrame,
  } = prefix;

  // One commit refusal, on an accepted native read inside its deadline, for the lead alone.
  const commits: number[] = [];
  events.forEach((entry, index) => {
    if (isPcm(entry, 'clock-commit-detail')) commits.push(index);
  });
  if (commits.length !== 1) return null;
  const commitAt = commits[0]!;
  if (commitAt <= selectedAt || commitAt >= terminal) return null;
  const commit = entryValue(events[commitAt]);
  const observation = (commit['observation'] ?? {}) as Record<string, unknown>;
  const commitFrame = ceilFrame(commit['contextAfter'], rate);
  const readEnd = commit['readEnd'];
  const deadline = commit['deadline'];
  if (
    commit['reason'] !== 'observation-or-lead' ||
    observation['status'] !== 'calibrated' ||
    observation['reason'] !== 'accepted' ||
    typeof observation['offsetMin'] !== 'number' ||
    typeof observation['offsetMax'] !== 'number' ||
    stampOf(commit['stamp']) === null ||
    typeof readEnd !== 'number' ||
    typeof deadline !== 'number' ||
    readEnd > deadline ||
    commit['contextFrame'] !== gapUpper ||
    commit['guardFrames'] !== GAP_GUARD_FRAMES ||
    commitFrame === null ||
    commit['remainingLeadFrames'] !== gapUpper - commitFrame ||
    gapUpper - commitFrame >= GAP_GUARD_FRAMES
  )
    return null;
  const commitRead = events[commitAt - 1];
  if (
    !isObservedRead(commitRead) ||
    entryValue(commitRead)['injected'] !== false
  )
    return null;

  // One burst at most between the selection and the commit. Two bursts move at least 768 frames.
  const moved = commitFrame - selectionFrame;
  if (moved <= 0 || moved > GAP_GUARD_FRAMES) return null;

  // Nothing else was refused or injected after the hold.
  for (let i = at + 1; i < terminal; i++)
    if (
      isPcm(events[i], 'recovery-candidate-failed') ||
      isPcm(events[i], 'recovery-fault') ||
      isPcm(events[i], 'recovery-clock-observation-rejected') ||
      events[i]?.kind === 'recovery-overrun-injected'
    )
      return null;

  return `${RECOVERY_BRIDGE_SITE} hold consumed at frame ${heldFrame}, released by the next stamp; selection at frame ${selectionFrame} took ${gapUpper} (boundary ${boundary}); one burst of ${moved} frames left a lead of ${gapUpper - commitFrame} under the guard at the commit`;
}

// The native stamp under the injected read. The first classifier needs it to still be the anchor,
// which is the sub-resolution re-read. The final guard one also takes a native stamp the sink has
// already moved on from the anchor (run 43295017278: native 10.1 ms past it), because the next
// bridge read, which the selection used, then carries that same later stamp.
function consumedNativeIsAcceptable(
  native: Stamp | null,
  anchor: Stamp,
  mayHaveAdvanced: boolean
): boolean {
  if (native === null) return false;
  return mayHaveAdvanced
    ? native.performanceTime >= anchor.performanceTime
    : sameStamp(native, anchor);
}

// What the two hold classifiers below share: one terminal refusal with the given code, the
// one-shot recovery-bridge hold consumed once as an injected re-read, still feasible as
// consumed, one selection after it at the last frame the gap allows, and a bridge read that
// ended the hold with the next native stamp, which the selection used.
function siteBridgeHoldPrefix(
  events: readonly TraceEntry[],
  rate: number,
  terminalCode: string,
  nativeMayHaveAdvanced = false
): {
  terminal: number;
  at: number;
  boundary: number;
  gapUpper: number;
  heldFrame: number;
  selectedAt: number;
  selectionFrame: number;
} | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const errorAt: number[] = [];
  events.forEach((entry, index) => {
    if (isPcm(entry, 'error')) errorAt.push(index);
  });
  if (errorAt.length !== 1) return null;
  const terminal = errorAt[0]!;
  const failure = entryValue(events[terminal]);
  if (failure['code'] !== terminalCode || failure['stage'] !== 'schedule')
    return null;

  // The hold: consumed once, on a bridge read that names the anchor, as an injected re-read.
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
  if (at >= terminal) return null;
  const consumed = entryValue(events[at]);
  const held = stampOf(consumed);
  const anchor = stampOf(consumed['anchor']);
  if (held === null || anchor === null) return null;
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
    !sameStamp(stampOf(consumedValue['output']), held) ||
    !consumedNativeIsAcceptable(
      stampOf(consumedValue['native']),
      anchor,
      nativeMayHaveAdvanced
    )
  )
    return null;

  // The gap, from the last closure before the consumption. The held read was still feasible.
  let closure = -1;
  for (let i = at - 1; i >= 0 && closure < 0; i--)
    if (isPcm(events[i], 'recovery-render-closed')) closure = i;
  if (closure < 0) return null;
  const boundary = safeInt(entryValue(events[closure])['boundaryFrame']);
  if (boundary === null) return null;
  const gapUpper = boundary + Math.floor(0.02 * rate);
  const heldFrame = readFrame(consumedRead, rate);
  if (heldFrame === null || heldFrame + GAP_GUARD_FRAMES > gapUpper)
    return null;

  // One selection, after the hold, at the last frame the gap allows.
  const selections: number[] = [];
  events.forEach((entry, index) => {
    if (isPcm(entry, 'recovery-selection')) selections.push(index);
  });
  if (selections.length !== 1) return null;
  const selectedAt = selections[0]!;
  if (selectedAt <= at || selectedAt >= terminal) return null;
  const selection = entryValue(events[selectedAt]);
  const selectionFrame = safeInt(selection['contextFrame']);
  if (
    selection['boundaryFrame'] !== boundary ||
    selection['f0'] !== gapUpper ||
    selection['feasibleUpper'] !== gapUpper ||
    selection['guardFrames'] !== GAP_GUARD_FRAMES ||
    selectionFrame === null ||
    selectionFrame + GAP_GUARD_FRAMES > gapUpper
  )
    return null;

  // Every bridge read from the hold to the selection was injected, except the last. That one is
  // native, carries a stamp past the anchor, and is the stamp the bridge used.
  const bridgeReads: number[] = [];
  for (let i = at + 1; i < selectedAt; i++)
    if (isObservedRead(events[i]) && isBridgeMarker(events[i - 1], 'read'))
      bridgeReads.push(i);
  const freshAt = bridgeReads.pop();
  if (freshAt === undefined) return null;
  for (const index of bridgeReads)
    if (entryValue(events[index])['injected'] !== true) return null;
  const fresh = entryValue(events[freshAt]);
  const freshStamp = stampOf(fresh['native']);
  if (
    fresh['injected'] !== false ||
    freshStamp === null ||
    freshStamp.performanceTime <= anchor.performanceTime
  )
    return null;
  let used: Stamp | null = null;
  for (let i = freshAt + 1; i < selectedAt; i++)
    if (isBridgeMarker(events[i], 'use'))
      used = stampOf(entryValue(events[i])['usedStamp']);
  if (!sameStamp(used, freshStamp)) return null;

  return {
    terminal,
    at,
    boundary,
    gapUpper,
    heldFrame,
    selectedAt,
    selectionFrame,
  };
}

const FINAL_GUARD_REFUSAL = 'recovery final guard exceeded';

// The same one-shot hold, refused one step later again. The commit read is accepted and keeps
// its lead, and the render burst that the hold's release comes with lands after it, before the
// final guard reads the context clock (run 43295017278: lead 704 at the commit, the context
// past boundary + 448 at the guard). The hold is blamed only when every clause of the shared
// prefix holds, exactly one commit was accepted and none refused, its lead kept the guard, the
// context moved by at most one burst between the selection and the commit, and the first native
// read after the refusal sits past the guard by no more than one burst from the commit.
export function siteBridgeFinalGuardAfterHold(
  events: readonly TraceEntry[],
  rate: number
): string | null {
  const prefix = siteBridgeHoldPrefix(events, rate, FINAL_GUARD_REFUSAL, true);
  if (prefix === null) return null;
  const {
    terminal,
    at,
    boundary,
    gapUpper,
    heldFrame,
    selectedAt,
    selectionFrame,
  } = prefix;

  const commits: number[] = [];
  let commitRefused = false;
  events.forEach((entry, index) => {
    if (index <= selectedAt || index >= terminal) return;
    if (isPcm(entry, 'clock-commit')) commits.push(index);
    if (isPcm(entry, 'clock-commit-detail')) commitRefused = true;
  });
  if (commits.length !== 1 || commitRefused) return null;
  const commit = entryValue(events[commits[0]!]);
  const commitFrame = ceilFrame(commit['contextAfter'], rate);
  if (
    commit['contextFrame'] !== gapUpper ||
    commit['guardFrames'] !== GAP_GUARD_FRAMES ||
    commitFrame === null ||
    commit['remainingLeadFrames'] !== gapUpper - commitFrame ||
    gapUpper - commitFrame < GAP_GUARD_FRAMES
  )
    return null;
  const toCommit = commitFrame - selectionFrame;
  if (toCommit < 0 || toCommit > GAP_GUARD_FRAMES) return null;

  // The first context reading after the refusal, from a native read or from the startup monitor's
  // bridge: the context is past the guard, by one burst at most.
  let after: number | null = null;
  for (let i = terminal + 1; i < events.length && after === null; i++) {
    const entry = events[i];
    if (isObservedRead(entry) && entryValue(entry)['injected'] === false)
      after = readFrame(entry, rate);
    else if (entry?.kind === 'audio-startup-monitor') {
      const bridge = entryValue(entry)['bridge'];
      if (typeof bridge === 'object' && bridge !== null)
        after = ceilFrame(
          (bridge as Record<string, unknown>)['currentAfter'],
          rate
        );
    }
  }
  if (
    after === null ||
    after + GAP_GUARD_FRAMES <= gapUpper ||
    after - commitFrame > GAP_GUARD_FRAMES
  )
    return null;

  // Nothing else was refused or injected after the hold.
  for (let i = at + 1; i < terminal; i++)
    if (
      isPcm(events[i], 'recovery-candidate-failed') ||
      isPcm(events[i], 'recovery-fault') ||
      isPcm(events[i], 'recovery-clock-observation-rejected') ||
      events[i]?.kind === 'recovery-overrun-injected'
    )
      return null;

  return `${RECOVERY_BRIDGE_SITE} hold consumed at frame ${heldFrame}, released by the next stamp; selection at frame ${selectionFrame} took ${gapUpper} (boundary ${boundary}); the commit at frame ${commitFrame} kept a lead of ${gapUpper - commitFrame}, and a burst of ${after - commitFrame} frames before the final guard left the context at ${after}, under the ${GAP_GUARD_FRAMES}-frame guard`;
}

// A starved run closes at its frontier inside a render burst. A sink that renders 384 or 512
// frames per callback can leave currentTime up to 384 frames past the frontier before the main
// thread hears of the closure. When that overshoot plus the guard passes the 20 ms gap, the
// first recovery check refuses, and no viewer delay is involved: at 44.1 kHz the gap is 882
// frames, so an overshoot of 384 is refused by 14 frames. Jason approved rerunning this exact
// signature on 2026-11-12. The overshoot must be under one guard, which a second burst always
// exceeds, so a late recovery is never classified. Every clause below must hold or the
// classifier returns null, and a null is a failed attempt, never a rerun.
export function recoveryFrontierOvershoot(
  events: readonly TraceEntry[],
  rate: number
): string | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;

  // Exactly one scheduled-pcm error, and it is the handoff refusal.
  const errorAt: number[] = [];
  events.forEach((entry, index) => {
    if (isPcm(entry, 'error')) errorAt.push(index);
  });
  if (errorAt.length !== 1) return null;
  const terminal = errorAt[0]!;
  const failure = entryValue(events[terminal]);
  if (failure['code'] !== HANDOFF_REFUSAL || failure['stage'] !== 'schedule')
    return null;

  // Exactly one gap refusal, before the error, at the first recovery check.
  const refusalAt: number[] = [];
  events.forEach((entry, index) => {
    if (isPcm(entry, 'recovery-gap-infeasible')) refusalAt.push(index);
  });
  if (refusalAt.length !== 1) return null;
  const at = refusalAt[0]!;
  if (at >= terminal) return null;
  const refusal = entryValue(events[at]);
  const boundary = safeInt(refusal['boundaryFrame']);
  const contextFrame = safeInt(refusal['contextFrame']);
  const gapUpper = safeInt(refusal['gapUpper']);
  if (boundary === null || contextFrame === null || gapUpper === null)
    return null;
  if (refusal['checks'] !== 0) return null;
  if (refusal['guardFrames'] !== GAP_GUARD_FRAMES) return null;
  if (gapUpper !== boundary + Math.floor(0.02 * rate)) return null;

  // The overshoot is the closing burst's alone, and it is what passes the gap.
  const overshoot = contextFrame - boundary;
  if (overshoot < 0 || overshoot >= GAP_GUARD_FRAMES) return null;
  if (contextFrame + GAP_GUARD_FRAMES <= gapUpper) return null;

  // The closure: this generation's frontier close at the boundary, then its render closure.
  let closure = -1;
  for (let i = at - 1; i >= 0 && closure < 0; i--)
    if (isPcm(events[i], 'gate-close')) closure = i;
  if (closure < 0) return null;
  const gate = entryValue(events[closure]);
  if (
    gate['reason'] !== 'frontier' ||
    gate['contextStopFrame'] !== boundary ||
    gate['generation'] !== refusal['generation']
  )
    return null;
  let renderClosed = false;
  for (let i = closure + 1; i < at; i++)
    if (
      isPcm(events[i], 'recovery-render-closed') &&
      entryValue(events[i])['boundaryFrame'] === boundary
    )
      renderClosed = true;
  if (!renderClosed) return null;

  // The last read before the closure was native and had not passed the frontier, so the
  // overshoot happened inside the burst that closed the run. The closing burst can also be
  // read before its closure reaches the main thread. Such a read is native and sits exactly
  // on the refused frame, so nothing rendered between it and the refusal, and it is passed
  // over to the read before it, which must meet the same condition.
  let lastRead = -1;
  for (let i = closure - 1; i >= 0 && lastRead < 0; i--) {
    if (!isObservedRead(events[i])) continue;
    if (
      overshoot > 0 &&
      readFrame(events[i], rate) === contextFrame &&
      entryValue(events[i])['injected'] === false
    )
      continue;
    lastRead = i;
  }
  if (lastRead < 0) return null;
  const before = readFrame(events[lastRead], rate);
  if (
    before === null ||
    before > boundary ||
    entryValue(events[lastRead])['injected'] !== false
  )
    return null;

  // Nothing was injected between the closure and the error, and recovery got no further.
  for (let i = closure + 1; i < terminal; i++) {
    const entry = events[i];
    if (isObservedRead(entry) && entryValue(entry)['injected'] !== false)
      return null;
    if (
      entry?.kind === 'clock-site-hold-consumed' ||
      entry?.kind === 'recovery-overrun-injected' ||
      isPcm(entry, 'recovery-fault') ||
      isPcm(entry, 'recovery-selection') ||
      isPcm(entry, 'recovery-candidate-failed') ||
      isPcm(entry, 'epoch')
    )
      return null;
  }

  return `frontier ${boundary} overshot by ${overshoot} frames at the first recovery check: ${contextFrame} + ${GAP_GUARD_FRAMES} > gap upper ${gapUpper} at ${rate} Hz`;
}
