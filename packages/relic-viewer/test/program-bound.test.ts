import { describe, expect, test } from 'bun:test';
import { OTIO_PROGRAM_MAX_BYTES } from '@relic/format';
import { PROGRAM_MAX_BYTES } from '../src/program-render/protocol.ts';

describe('program byte bound parity', () => {
  test('the viewer page bound is the shared format bound', () => {
    expect(PROGRAM_MAX_BYTES).toBe(OTIO_PROGRAM_MAX_BYTES);
  });
});
