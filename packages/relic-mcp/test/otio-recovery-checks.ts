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
