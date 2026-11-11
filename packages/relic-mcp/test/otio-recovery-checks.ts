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
