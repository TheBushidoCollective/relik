import { describe, expect, test } from 'bun:test';
import { PLAINTEXT_CAP_BYTES } from '@relic/format';
import { PublishError, challengeSizeLimit } from '../src/publish.ts';
import {
  programArchiveBudget,
  programPolicyFrom,
} from '../src/program/policy.ts';

function refused(challenge: Record<string, unknown>): PublishError {
  try {
    challengeSizeLimit(challenge);
  } catch (error) {
    if (error instanceof PublishError) return error;
    throw error;
  }
  throw new Error('expected the challenge to be refused');
}

describe('the server challenge states a usable size limit', () => {
  test('a positive safe integer is accepted as the limit', () => {
    expect(challengeSizeLimit({ size_limit_bytes: PLAINTEXT_CAP_BYTES })).toBe(
      PLAINTEXT_CAP_BYTES
    );
  });

  test('every other value is refused as app_response_unusable on the challenge leg', () => {
    const bad: Record<string, unknown>[] = [
      { size_limit_bytes: '524288000' },
      { size_limit_bytes: Number.NaN },
      { size_limit_bytes: 0 },
      { size_limit_bytes: -1 },
      { size_limit_bytes: 1.5 },
      { size_limit_bytes: null },
      { size_limit_bytes: 2 ** 53 },
      {},
    ];
    for (const challenge of bad) {
      const error = refused(challenge);
      expect(error.code).toBe('app_response_unusable');
      expect(error.details['leg']).toBe('challenge');
    }
  });
});

describe('the program budget never exceeds the server cap', () => {
  test('a budget asked for above the cap is the cap', () => {
    expect(
      programArchiveBudget(PLAINTEXT_CAP_BYTES + 1, programPolicyFrom({}))
    ).toBe(PLAINTEXT_CAP_BYTES);
  });
});
