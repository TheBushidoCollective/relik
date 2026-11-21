import { describe, expect, test } from 'bun:test';
import { crc32, planStoredZip } from '@relic/format';
import { contentFromBytes, type RelicContent } from '../src/content.ts';
import { entryView } from '../src/folder-relic.ts';
import type { ReadyView } from '../src/viewer.ts';
import { routeContent, routeFor } from '../src/viewer.ts';

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
      const fromContent = await routeContent(
        `file.${format.ext}`,
        'application/octet-stream',
        contentFromBytes(bytes)
      );
      expect(fromContent.route).toBe(format.route);
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
    test(`${format.ext} respects the route size ceiling`, async () => {
      const limit = (format.ext === 'xlsx' ? 100 : 64) * 1024 * 1024;
      const tail = bytes.slice(
        new DataView(bytes.buffer).getUint32(bytes.length - 6, true)
      );
      const directoryOffset = limit + 1 - tail.length;
      new DataView(tail.buffer).setUint32(
        tail.length - 6,
        directoryOffset,
        true
      );
      const content: RelicContent = {
        size: limit + 1,
        head: bytes.subarray(0, Math.min(bytes.length, 64)),
        tail,
        blob: () => new Blob([]),
        async read(start, end) {
          const out = new Uint8Array(end - start);
          const headEnd = Math.min(end, bytes.length - tail.length);
          if (start < headEnd) out.set(bytes.subarray(start, headEnd));
          const tailStart = Math.max(start, directoryOffset);
          if (tailStart < end)
            out.set(
              tail.subarray(tailStart - directoryOffset, end - directoryOffset),
              tailStart - start
            );
          return out;
        },
        async readWhole() {
          throw new Error('oversized document was read whole');
        },
      };
      const result = await routeContent(
        `file.${format.ext}`,
        format.mime,
        content
      );
      expect(result.route).toBe('download');
      expect(result.notice).toContain('too large');
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
  test('folder views carry the sniffed document kind and clear it on another entry', async () => {
    const word = makeZip(formats[0].entries);
    const ebook = makeZip(formats[2].entries);
    const text = new TextEncoder().encode('plain text');
    const all = new Uint8Array(word.length + ebook.length + text.length);
    all.set(word);
    all.set(ebook, word.length);
    all.set(text, word.length + ebook.length);
    const content = contentFromBytes(all);
    const entries = [
      {
        path: 'word.epub',
        mimetype: 'application/octet-stream',
        offset: 0,
        length: word.length,
      },
      {
        path: 'book.epub',
        mimetype: 'application/octet-stream',
        offset: word.length,
        length: ebook.length,
      },
      {
        path: 'note.txt',
        mimetype: 'text/plain',
        offset: word.length + ebook.length,
        length: text.length,
      },
    ];
    const base: ReadyView = {
      filename: 'folder',
      declaredMimetype: '',
      content,
      document: undefined,
      route: 'download',
      downgradeNotice: undefined,
      shareUrl: '',
      version: 1,
      currentVersion: 1,
      versionDigest: '',
      folder: {
        header: {
          version: 2,
          name: 'folder',
          entryCount: 3,
          manifestLength: 0,
          contentLength: all.length,
        },
        manifest: { defaultIndex: 0, entries },
        whole: content,
        index: 0,
      },
    };
    const first = await entryView(base, 0);
    expect(first.route).toBe('sandboxed-document');
    expect(first.documentKind).toBe('docx');
    const second = await entryView(first, 1);
    expect(second.route).toBe('sandboxed-document');
    expect(second.documentKind).toBe('epub');
    expect((await entryView(second, 2)).documentKind).toBeUndefined();
  });
  test('an ordinary archive named as a document downloads', async () => {
    const bytes = makeZip([['private.txt', 'hello']]);
    expect(
      (await routeFor('file.docx', 'application/octet-stream', bytes)).route
    ).toBe('download');
  });
  test('plain ZIP remains download-only across declarations', async () => {
    const bytes = makeZip([['private.txt', 'hello']]);
    for (const [name, mime] of [
      ['file.zip', 'application/zip'],
      ['file.zip', 'application/octet-stream'],
      ['file', 'application/octet-stream'],
      ['file.txt', 'application/octet-stream'],
      ['file.xlsx', 'application/octet-stream'],
      ['file.html', 'application/octet-stream'],
    ]) {
      expect((await routeFor(name!, mime!, bytes)).route).toBe('download');
    }
  });
  test('OTIO retains its existing route and rejects an Office name', async () => {
    const bytes = makeZip([
      ['version.txt', '1.0.0'],
      ['content.otio', '{}'],
    ]);
    expect(
      (await routeFor('file.otioz', 'application/x-otioz', bytes)).route
    ).toBe('otio');
    expect(
      (await routeFor('file.otioz', 'application/octet-stream', bytes)).route
    ).toBe('otio');
    expect(
      (await routeFor('file', 'application/octet-stream', bytes)).route
    ).toBe('otio');
    expect(
      (await routeFor('file.txt', 'application/octet-stream', bytes)).route
    ).toBe('otio');
    expect(
      (await routeFor('file.xlsx', 'application/octet-stream', bytes)).route
    ).toBe('download');
    expect(
      (await routeFor('file.html', 'application/octet-stream', bytes)).route
    ).toBe('otio');
  });
});
