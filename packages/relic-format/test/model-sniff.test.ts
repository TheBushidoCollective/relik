import { expect, test } from 'bun:test';
import { sniffModelFormat } from '../src/model.ts';

test('detects binary STL from a header prefix and total length', () => {
  const header = new Uint8Array(84);
  new DataView(header.buffer).setUint32(80, 2, true);
  expect(sniffModelFormat(header, 184)).toBe('stl');
  expect(sniffModelFormat(header, 185)).toBeUndefined();
  expect(sniffModelFormat(header)).toBeUndefined();
});

test('scans only the supplied prefix for ASCII models', () => {
  const prefix = new TextEncoder().encode('v 0 0 0\nv 1 0 0\nf 1 2 3\n');
  expect(sniffModelFormat(prefix, 200_000_000)).toBe('obj');
  expect(sniffModelFormat(prefix.subarray(0, 8), 200_000_000)).toBeUndefined();
});
