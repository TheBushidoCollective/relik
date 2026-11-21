import { describe, expect, test } from 'bun:test';
import { zipContainerKind, zipContainerKindSync } from '../src/containers.ts';
import { crc32 } from '../src/zip-index.ts';
import { planStoredZip } from '../src/zip-write.ts';

function zip(entries: readonly (readonly [string, string])[]): Uint8Array {
  const encoder = new TextEncoder();
  const data = entries.map(([name, text]) => ({
    name,
    bytes: encoder.encode(text),
  }));
  const layout = planStoredZip(
    data.map(({ name, bytes }) => ({
      name,
      size: bytes.length,
      crc32: crc32(bytes),
    }))
  );
  const output = new Uint8Array(layout.totalBytes);
  let offset = 0;
  for (let i = 0; i < data.length; i++) {
    const header = layout.localHeaders[i]!;
    output.set(header, offset);
    offset += header.length;
    output.set(data[i]!.bytes, offset);
    offset += data[i]!.bytes.length;
  }
  output.set(layout.centralDirectory, offset);
  offset += layout.centralDirectory.length;
  output.set(layout.end, offset);
  return output;
}

function source(bytes: Uint8Array) {
  return {
    size: bytes.length,
    async read(start: number, end: number) {
      return bytes.subarray(start, end);
    },
  };
}

describe('container recognition', () => {
  const cases = [
    [
      'docx',
      zip([
        ['[Content_Types].xml', ''],
        ['word/document.xml', ''],
      ]),
    ],
    [
      'xlsx',
      zip([
        ['[Content_Types].xml', ''],
        ['xl/workbook.xml', ''],
      ]),
    ],
    [
      'epub',
      zip([
        ['other', ''],
        ['mimetype', 'application/epub+zip'],
        ['META-INF/container.xml', ''],
      ]),
    ],
    [
      'otio',
      zip([
        ['content.otio', '{}'],
        ['version.txt', '1.0.0'],
      ]),
    ],
    ['archive', zip([['readme.txt', 'hello']])],
    [
      'archive',
      zip([
        ['[Content_Types].xml', ''],
        ['word/document.xml', ''],
        ['xl/workbook.xml', ''],
      ]),
    ],
    [
      'archive',
      zip([
        ['word/document.xml', ''],
        ['word/document.xml', ''],
      ]),
    ],
    ['archive', zip([['../bad', '']])],
  ] as const;
  for (const [expected, bytes] of cases) {
    test(`recognizes ${expected} consistently`, async () => {
      expect(zipContainerKindSync(bytes)).toBe(expected);
      expect(await zipContainerKind(source(bytes))).toBe(expected);
    });
  }
  test('cancels a held ZIP classification before scheduling another read', async () => {
    const bytes = zip([
      ['[Content_Types].xml', ''],
      ['word/document.xml', ''],
    ]);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    let reads = 0;
    const pending = zipContainerKind(
      {
        size: bytes.length,
        async read(start, end) {
          reads += 1;
          if (reads === 1) {
            started.resolve();
            await release.promise;
          }
          return bytes.subarray(start, end);
        },
      },
      controller.signal
    );
    await started.promise;
    controller.abort();
    release.resolve();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toBe(1);

    let completeReads = 0;
    expect(
      await zipContainerKind(
        {
          size: bytes.length,
          async read(start, end) {
            completeReads += 1;
            return bytes.subarray(start, end);
          },
        },
        new AbortController().signal
      )
    ).toBe('docx');
    expect(completeReads).toBeGreaterThan(1);
  });
  test('cancels a held EPUB mimetype read without further range reads', async () => {
    const bytes = zip([
      ['mimetype', 'application/epub+zip'],
      ['META-INF/container.xml', ''],
    ]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const mimeOffset = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    let reads = 0;
    const pending = zipContainerKind(
      {
        size: bytes.length,
        async read(start, end) {
          reads += 1;
          if (start === mimeOffset && end === mimeOffset + 20) {
            started.resolve();
            await release.promise;
          }
          return bytes.subarray(start, end);
        },
      },
      controller.signal
    );
    await started.promise;
    const heldAt = reads;
    controller.abort();
    release.resolve();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toBe(heldAt);
  });
  test('does not read a ZIP when classification is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    let reads = 0;
    await expect(
      zipContainerKind(
        {
          size: 22,
          async read() {
            reads += 1;
            return new Uint8Array();
          },
        },
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(reads).toBe(0);
  });
  test('refuses encrypted, truncated and ZIP64 directories', async () => {
    const original = zip([
      ['[Content_Types].xml', ''],
      ['word/document.xml', ''],
    ]);
    const encrypted = original.slice();
    const ev = new DataView(encrypted.buffer);
    const end = encrypted.length - 22;
    const directory = ev.getUint32(end + 16, true);
    ev.setUint16(directory + 8, ev.getUint16(directory + 8, true) | 1, true);
    const zip64 = original.slice();
    new DataView(zip64.buffer).setUint16(end + 10, 0xffff, true);
    for (const bytes of [
      encrypted,
      original.subarray(0, original.length - 1),
      zip64,
    ]) {
      expect(zipContainerKindSync(bytes)).toBe('archive');
      expect(await zipContainerKind(source(bytes))).toBe('archive');
    }
  });
});
