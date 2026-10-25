import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  currentDecisions,
  isDecisionVerdict,
  isVersionDigest,
  versionDigest,
  type DecisionRecord,
} from '../src/decision.ts';

describe('versionDigest', () => {
  it('equals node:crypto sha256 over random buffers', async () => {
    for (const size of [0, 1, 16, 64, 1024, 65536]) {
      const bytes = new Uint8Array(size);
      crypto.getRandomValues(bytes);

      const expected = createHash('sha256').update(bytes).digest('hex');
      const actual = await versionDigest(bytes);

      expect(actual).toBe(expected);
      expect(isVersionDigest(actual)).toBe(true);
    }
  });
});

describe('isVersionDigest', () => {
  it('accepts valid 64-char lowercase hex strings', () => {
    const valid =
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(isVersionDigest(valid)).toBe(true);
  });

  it('rejects uppercase hex strings', () => {
    const uppercase =
      'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90';
    expect(isVersionDigest(uppercase)).toBe(false);

    const mixed =
      'a1b2c3d4e5f60718293a4b5c6d7e8f90A1b2c3d4e5f60718293a4b5c6d7e8f90';
    expect(isVersionDigest(mixed)).toBe(false);
  });

  it('rejects wrong lengths', () => {
    expect(isVersionDigest('')).toBe(false);
    expect(isVersionDigest('a'.repeat(63))).toBe(false);
    expect(isVersionDigest('a'.repeat(65))).toBe(false);
    expect(isVersionDigest('a'.repeat(32))).toBe(false);
  });

  it('rejects non-hex characters and non-strings', () => {
    expect(isVersionDigest('z'.repeat(64))).toBe(false);
    expect(isVersionDigest('g'.repeat(64))).toBe(false);
    expect(isVersionDigest(null)).toBe(false);
    expect(isVersionDigest(undefined)).toBe(false);
    expect(isVersionDigest(12345)).toBe(false);
    expect(isVersionDigest({})).toBe(false);
  });
});

describe('isDecisionVerdict', () => {
  it('accepts approve and reject', () => {
    expect(isDecisionVerdict('approve')).toBe(true);
    expect(isDecisionVerdict('reject')).toBe(true);
  });

  it('rejects other strings or types', () => {
    expect(isDecisionVerdict('approved')).toBe(false);
    expect(isDecisionVerdict('rejected')).toBe(false);
    expect(isDecisionVerdict('APPROVE')).toBe(false);
    expect(isDecisionVerdict('')).toBe(false);
    expect(isDecisionVerdict(null)).toBe(false);
    expect(isDecisionVerdict(undefined)).toBe(false);
    expect(isDecisionVerdict(1)).toBe(false);
  });
});

describe('currentDecisions', () => {
  const digest1 =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const digest2 =
    'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

  it('picks latest per author on the target version', () => {
    const records: DecisionRecord[] = [
      {
        id: 'dec-1',
        version: 1,
        verdict: 'approve',
        author: 'alice@example.com',
        created_at: '2026-10-24T10:00:00.000Z',
        version_digest: digest1,
      },
      {
        id: 'dec-2',
        version: 1,
        verdict: 'reject',
        author: 'alice@example.com',
        created_at: '2026-10-24T12:00:00.000Z',
        version_digest: digest1,
      },
      {
        id: 'dec-3',
        version: 1,
        verdict: 'approve',
        author: 'bob@example.com',
        created_at: '2026-10-24T11:00:00.000Z',
        version_digest: digest1,
      },
      // Record on different version (v2)
      {
        id: 'dec-4',
        version: 2,
        verdict: 'approve',
        author: 'alice@example.com',
        created_at: '2026-10-24T13:00:00.000Z',
        version_digest: digest2,
      },
    ];

    const currentV1 = currentDecisions(records, 1);
    expect(currentV1).toHaveLength(2);
    // Ordered by created_at then id: bob at 11:00, then alice at 12:00
    const first = currentV1[0];
    const second = currentV1[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first && second) {
      expect(first.author).toBe('bob@example.com');
      expect(first.verdict).toBe('approve');
      expect(first.id).toBe('dec-3');

      expect(second.author).toBe('alice@example.com');
      expect(second.verdict).toBe('reject');
      expect(second.id).toBe('dec-2');
    }

    // On version 2
    const currentV2 = currentDecisions(records, 2);
    expect(currentV2).toHaveLength(1);
    const v2First = currentV2[0];
    expect(v2First).toBeDefined();
    if (v2First) {
      expect(v2First.id).toBe('dec-4');
    }

    // On version 3 (none)
    expect(currentDecisions(records, 3)).toEqual([]);
  });

  it('orders by created_at then id when timestamps differ or collide', () => {
    const records: DecisionRecord[] = [
      {
        id: 'b-id',
        version: 1,
        verdict: 'approve',
        author: 'charlie@example.com',
        created_at: '2026-10-24T10:00:00.000Z',
        version_digest: digest1,
      },
      {
        id: 'a-id',
        version: 1,
        verdict: 'reject',
        author: 'david@example.com',
        created_at: '2026-10-24T10:00:00.000Z',
        version_digest: digest1,
      },
      {
        id: 'c-id',
        version: 1,
        verdict: 'approve',
        author: 'edward@example.com',
        created_at: '2026-10-24T09:00:00.000Z',
        version_digest: digest1,
      },
    ];

    const current = currentDecisions(records, 1);
    expect(current.map((r) => r.id)).toEqual(['c-id', 'a-id', 'b-id']);
  });

  it('breaks timestamp ties for the same author by id to pick latest', () => {
    const records: DecisionRecord[] = [
      {
        id: 'dec-1',
        version: 1,
        verdict: 'approve',
        author: 'alice@example.com',
        created_at: '2026-10-24T10:00:00.000Z',
        version_digest: digest1,
      },
      {
        id: 'dec-2',
        version: 1,
        verdict: 'reject',
        author: 'alice@example.com',
        created_at: '2026-10-24T10:00:00.000Z',
        version_digest: digest1,
      },
    ];

    const current = currentDecisions(records, 1);
    expect(current).toHaveLength(1);
    const item = current[0];
    expect(item).toBeDefined();
    if (item) {
      expect(item.id).toBe('dec-2');
      expect(item.verdict).toBe('reject');
    }
  });
});
