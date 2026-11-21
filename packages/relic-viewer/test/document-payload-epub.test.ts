import { expect, test } from 'bun:test';
import type { ZipEntryInfo, ZipIndex } from '@relic/format/zip-index';
import { epubPayload } from '../src/document-payload-epub.ts';

function fixture(
  encryption?: string,
  rights = false,
  overrides: Record<string, string> = {}
): ZipIndex {
  const source: Record<string, string> = {
    'META-INF/container.xml':
      '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
    'book.opf':
      '<package><metadata><title>Test</title></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="f" href="font.otf" media-type="font/otf"/></manifest><spine><itemref idref="c"/></spine></package>',
    'chapter.xhtml': '<html><body>Readable</body></html>',
    'font.otf': 'opaque font',
    ...overrides,
  };
  if (encryption) source['META-INF/encryption.xml'] = encryption;
  if (rights) source['META-INF/rights.xml'] = '<rights/>';
  const data = new Map(
    Object.entries(source).map(([name, text]) => [
      name,
      new TextEncoder().encode(text),
    ])
  );
  const entries = new Map<string, ZipEntryInfo>();
  for (const [name, bytes] of data)
    entries.set(name, {
      name,
      kind: 'file',
      method: 0,
      size: bytes.length,
      compressedSize: bytes.length,
      encrypted: false,
    });
  return {
    entries,
    async read(name) {
      const bytes = data.get(name);
      return bytes
        ? { ok: true, bytes }
        : { ok: false, reason: 'corrupt', message: 'missing' };
    },
  };
}

test('rejects DRM before creating the EPUB payload', async () => {
  expect(await epubPayload(fixture(undefined, true))).toEqual({
    ok: false,
    reason: 'protected',
  });
});
test('omits obfuscated fonts while passing the book to the frame', async () => {
  const encryption =
    '<encryption><EncryptedData><EncryptionMethod Algorithm="http://ns.adobe.com/pdf/enc#RC"/><CipherData><CipherReference URI="font.otf"/></CipherData></EncryptedData></encryption>';
  const result = await epubPayload(fixture(encryption));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.book.title).toBe('Test');
  expect(result.entries.map(([name]) => name)).toEqual(['chapter.xhtml']);
});
test('rejects declarations in chapters before frame creation', async () => {
  const index = fixture();
  const bad = new TextEncoder().encode(
    '<!DOCTYPE html [<!ENTITY a "boom">]><html>&a;</html>'
  );
  const entries = new Map(index.entries);
  entries.set('chapter.xhtml', {
    ...entries.get('chapter.xhtml')!,
    size: bad.length,
  });
  const result = await epubPayload({
    entries,
    read: async (name) =>
      name === 'chapter.xhtml' ? { ok: true, bytes: bad } : index.read(name),
  });
  expect(result).toEqual({ ok: false, reason: 'corrupt' });
});

test('scans manifest-selected extensionless XHTML even beyond the prefix window', async () => {
  const opf =
    '<package><metadata><title>Test</title></metadata><manifest><item id="c" href="chapter" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>';
  const good = `${' '.repeat(300)}<html><body>Readable</body></html>`;
  const accepted = await epubPayload(
    fixture(undefined, false, { 'book.opf': opf, chapter: good })
  );
  expect(accepted.ok).toBe(true);
  const bad = `${' '.repeat(300)}<!DOCTYPE html [<!ENTITY a "boom">]><html>&a;</html>`;
  expect(
    await epubPayload(
      fixture(undefined, false, { 'book.opf': opf, chapter: bad })
    )
  ).toEqual({ ok: false, reason: 'corrupt' });
});
