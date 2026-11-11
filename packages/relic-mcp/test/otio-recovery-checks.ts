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
  const valueOf = (field: unknown): unknown =>
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
    valueOf(gate['compositionStop']),
    valueOf(closure['compositionStop']),
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
    valueOf(frontier['compositionThrough']),
    decodedCap,
    'predecessor frontier did not reach its decode cap'
  );
  assert.equal(
    valueOf(closure['compositionStop']),
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
