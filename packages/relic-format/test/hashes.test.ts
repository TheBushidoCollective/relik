import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Crc32c } from '../src/crc32c.ts';
import { Crc32, crc32 } from '../src/otio-zip.ts';
import { Sha256, sha256Hex } from '../src/sha256.ts';

function fixture(length: number): Uint8Array {
  const result = new Uint8Array(length + 7);
  let state = 0x13579bdf;
  for (let i = 0; i < result.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    result[i] = state >>> 24;
  }
  return result.subarray(3, length + 3);
}

function referenceCrc32c(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
    }
  }
  const value = (crc ^ 0xffffffff) >>> 0;
  return Buffer.from([
    value >>> 24,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ]).toString('base64');
}

describe('incremental hashes', () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 65_557, 3 * 1024 * 1024]) {
    test(`match independent digests at ${length} bytes under irregular splits`, () => {
      const input = fixture(length);
      const expected = createHash('sha256').update(input).digest('hex');
      const sha = new Sha256();
      const castagnoli = new Crc32c();
      const crc = new Crc32();
      let cursor = 0;
      let seed = 7;
      while (cursor < input.length) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        const end = Math.min(input.length, cursor + 1 + (seed % 8191));
        const part = input.subarray(cursor, end);
        sha.update(part);
        castagnoli.update(part);
        crc.update(part);
        cursor = end;
      }
      expect(sha.hex()).toBe(expected);
      expect(sha.hex()).toBe(expected);
      expect(() => sha.update(new Uint8Array())).toThrow();
      expect(sha256Hex(input.subarray(0, 1), input.subarray(1))).toBe(expected);
      expect(castagnoli.base64()).toBe(referenceCrc32c(input));
      expect(crc.value()).toBe(crc32(input));
    });
  }

  test('CRC standard check vectors', () => {
    const input = new TextEncoder().encode('123456789');
    expect(new Crc32().update(input).value()).toBe(0xcbf43926);
    expect(new Crc32c().update(input).base64()).toBe('4waSgw==');
  });
});
