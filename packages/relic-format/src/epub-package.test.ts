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
