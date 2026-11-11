import { expect, test } from 'bun:test';
import { assertDescriptorBudgetRefusal } from './otio-recovery-checks.ts';

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
