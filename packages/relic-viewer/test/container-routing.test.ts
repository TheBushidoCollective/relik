import { describe, expect, test } from 'bun:test';
import { crc32, planStoredZip } from '@relic/format';
import { routeFor } from '../src/viewer.ts';

function makeZip(entries: readonly (readonly [string, string])[]): Uint8Array {
  const encoder = new TextEncoder();
  const data = entries.map(([name, value]) => ({
    name,
    bytes: encoder.encode(value),
  }));
  const layout = planStoredZip(
    data.map(({ name, bytes }) => ({
      name,
      size: bytes.length,
      crc32: crc32(bytes),
    }))
  );
  const out = new Uint8Array(layout.totalBytes);
  let at = 0;
  for (let i = 0; i < data.length; i++) {
    const header = layout.localHeaders[i]!;
    out.set(header, at);
    at += header.length;
    out.set(data[i]!.bytes, at);
    at += data[i]!.bytes.length;
  }
  out.set(layout.centralDirectory, at);
  at += layout.centralDirectory.length;
  out.set(layout.end, at);
  return out;
}

const formats = [
  {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    route: 'sandboxed-document',
    entries: [
      ['[Content_Types].xml', ''],
      ['word/document.xml', ''],
    ],
  },
  {
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    route: 'spreadsheet',
    entries: [
      ['[Content_Types].xml', ''],
      ['xl/workbook.xml', ''],
    ],
  },
  {
    ext: 'epub',
    mime: 'application/epub+zip',
    route: 'sandboxed-document',
    entries: [
      ['mimetype', 'application/epub+zip'],
      ['META-INF/container.xml', ''],
    ],
  },
] as const;

describe('document and spreadsheet routing', () => {
  for (const format of formats) {
    const bytes = makeZip(format.entries);
    test(`${format.ext} routes only when declarations agree`, async () => {
      expect(
        (await routeFor(`file.${format.ext}`, format.mime, bytes)).route
      ).toBe(format.route);
      expect(
        (
          await routeFor(
            `file.${format.ext}`,
            'application/octet-stream',
            bytes
          )
        ).route
      ).toBe(format.route);
      expect(
        (await routeFor('file', 'application/octet-stream', bytes)).route
      ).toBe(format.route);
      expect(
        (await routeFor('file.txt', 'application/octet-stream', bytes)).route
      ).toBe('download');
      expect(
        (await routeFor('file.html', 'application/octet-stream', bytes)).route
      ).toBe('download');
      expect((await routeFor('file.html', format.mime, bytes)).route).toBe(
        'download'
      );
      const wrong = format.ext === 'xlsx' ? 'docx' : 'xlsx';
      expect(
        (await routeFor(`file.${wrong}`, 'application/octet-stream', bytes))
          .route
      ).toBe('download');
    });
  }
  test('distinguishes ebook from Word within document class', async () => {
    const bytes = makeZip([
      ['[Content_Types].xml', ''],
      ['word/document.xml', ''],
    ]);
    const decision = await routeFor(
      'file.epub',
      'application/octet-stream',
      bytes
    );
    expect(decision.route).toBe('sandboxed-document');
    expect(decision.documentKind).toBe('docx');
    expect(decision.notice).toContain('Word document');
  });
  test('an ordinary archive named as a document downloads', async () => {
    const bytes = makeZip([['private.txt', 'hello']]);
    expect(
      (await routeFor('file.docx', 'application/octet-stream', bytes)).route
    ).toBe('download');
  });
});
