import { expect, test } from 'bun:test';
import { planStoredZip } from '../src/zip-write.ts';
import { StrictParseError } from '../src/errors.ts';

test('plans headers and directory offsets for stored entries', () => {
  const layout = planStoredZip([
    { name: 'a.txt', size: 3, crc32: 0x12345678 },
    { name: 'b', size: 0, crc32: 0 },
  ]);
  const local = new DataView(layout.localHeaders[0]!.buffer);
  expect(local.getUint32(0, true)).toBe(0x04034b50);
  expect(local.getUint16(6, true)).toBe(0x800);
  expect(local.getUint32(14, true)).toBe(0x12345678);
  const central = new DataView(layout.centralDirectory.buffer);
  expect(central.getUint32(0, true)).toBe(0x02014b50);
  expect(central.getUint32(46 + 5 + 42, true)).toBe(38);
  const end = new DataView(layout.end.buffer);
  expect(end.getUint32(16, true)).toBe(69);
  expect(layout.totalBytes).toBe(69 + layout.centralDirectory.length + 22);
});
test('refuses ZIP32 overflows and invalid sizes', () => {
  expect(() => planStoredZip([{ name: 'x', size: -1, crc32: 0 }])).toThrow(
    StrictParseError
  );
  expect(() => planStoredZip([{ name: 'x', size: 2 ** 32, crc32: 0 }])).toThrow(
    StrictParseError
  );
  expect(() =>
    planStoredZip(
      Array.from({ length: 65536 }, () => ({ name: 'x', size: 0, crc32: 0 }))
    )
  ).toThrow(StrictParseError);
});
