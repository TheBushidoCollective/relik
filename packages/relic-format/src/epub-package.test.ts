import { expect, test } from 'bun:test';
import { readEpubPackage } from './epub-package.ts';
import type { ZipEntryInfo, ZipIndex } from './zip-index.ts';

function book(extra: Record<string, string> = {}): ZipIndex {
  const source: Record<string, string> = {
    'META-INF/container.xml':
      '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    'OPS/book.opf':
      '<package xmlns:dc="dc"><metadata><dc:title>Test book</dc:title></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="font" href="font.otf" media-type="font/otf"/></manifest><spine><itemref idref="c"/></spine></package>',
    'OPS/chapter.xhtml': '<html><body>One</body></html>',
    'OPS/nav.xhtml':
      '<html xmlns:epub="epub"><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml#start">Chapter&nbsp;one</a></li></ol></nav></body></html>',
    'OPS/font.otf': 'font',
    ...extra,
  };
  const data = new Map(
    Object.entries(source).map(([name, value]) => [
      name,
      new TextEncoder().encode(value),
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

test('loads a navigation document containing unknown named entities', async () => {
  const result = await readEpubPackage(book());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.book.spine).toEqual([
    { path: 'OPS/chapter.xhtml', linear: true },
  ]);
  expect(result.book.toc).toEqual([
    {
      label: 'Chapter&nbsp;one',
      path: 'OPS/chapter.xhtml',
      fragment: 'start',
      depth: 0,
    },
  ]);
});

test('refuses LCP and Adobe rights before rendering', async () => {
  for (const name of ['META-INF/license.lcpl', 'META-INF/rights.xml']) {
    expect(await readEpubPackage(book({ [name]: '<rights/>' }))).toEqual({
      ok: false,
      reason: 'protected',
    });
  }
});

test('permits font obfuscation only for fonts and excludes the encrypted bytes', async () => {
  const encrypted = (uri: string, algorithm: string) =>
    `<encryption><EncryptedData><EncryptionMethod Algorithm="${algorithm}"/><CipherData><CipherReference URI="${uri}"/></CipherData></EncryptedData></encryption>`;
  const algorithm = 'http://www.idpf.org/2008/embedding';
  const result = await readEpubPackage(
    book({ 'META-INF/encryption.xml': encrypted('OPS/font.otf', algorithm) })
  );
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.parts).not.toContain('OPS/font.otf');
  expect(
    await readEpubPackage(
      book({
        'META-INF/encryption.xml': encrypted('OPS/chapter.xhtml', algorithm),
      })
    )
  ).toEqual({ ok: false, reason: 'protected' });
  expect(
    await readEpubPackage(
      book({ 'META-INF/encryption.xml': encrypted('OPS/font.otf', 'unknown') })
    )
  ).toEqual({ ok: false, reason: 'protected' });
});

test('rejects DTD entity declarations in package XML', async () => {
  const result = await readEpubPackage(
    book({
      'META-INF/container.xml':
        '<!DOCTYPE x [<!ENTITY x "danger">]><container>&x;</container>',
    })
  );
  expect(result).toEqual({ ok: false, reason: 'corrupt' });
});

test('refuses oversized chapters and a spine above the limit', async () => {
  const index = book();
  const entries = new Map(index.entries);
  const chapter = entries.get('OPS/chapter.xhtml')!;
  entries.set(chapter.name, { ...chapter, size: 16 * 1024 * 1024 + 1 });
  expect(await readEpubPackage({ ...index, entries })).toEqual({
    ok: false,
    reason: 'too-large',
  });
  const spine = '<itemref idref="c"/>'.repeat(2001);
  const opf = `<package><metadata/><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine>${spine}</spine></package>`;
  expect(await readEpubPackage(book({ 'OPS/book.opf': opf }))).toEqual({
    ok: false,
    reason: 'too-large',
  });
});

test('refuses external and escaping manifest links', async () => {
  for (const href of ['https://evil.invalid/x', '../../outside.xhtml']) {
    const opf = `<package><metadata/><manifest><item id="c" href="${href}" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>`;
    expect(await readEpubPackage(book({ 'OPS/book.opf': opf }))).toEqual({
      ok: false,
      reason: 'corrupt',
    });
  }
});

test('reads NCX contents, page labels and fixed-layout progression', async () => {
  const opf =
    '<package><metadata><title>Book</title><meta property="rendition:layout">pre-paginated</meta></metadata><manifest><item id="c" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="n" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="n" page-progression-direction="rtl"><itemref idref="c" linear="no"/></spine></package>';
  const ncx =
    '<ncx><navMap><navPoint><navLabel><text>Chapter</text></navLabel><content src="chapter.xhtml#one"/></navPoint></navMap><pageList><pageTarget><navLabel><text>12</text></navLabel><content src="chapter.xhtml#p12"/></pageTarget></pageList></ncx>';
  const result = await readEpubPackage(
    book({ 'OPS/book.opf': opf, 'OPS/toc.ncx': ncx })
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.book.layout).toBe('pre-paginated');
  expect(result.book.progression).toBe('rtl');
  expect(result.book.spine[0]?.linear).toBe(false);
  expect(result.book.toc).toEqual([
    { label: 'Chapter', path: 'OPS/chapter.xhtml', fragment: 'one', depth: 0 },
  ]);
  expect(result.book.pageList).toEqual([
    { label: '12', path: 'OPS/chapter.xhtml', fragment: 'p12' },
  ]);
});
