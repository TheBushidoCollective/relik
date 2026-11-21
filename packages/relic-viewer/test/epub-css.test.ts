import { expect, test } from 'bun:test';
import { epubCss, epubDataUrl, scopeEpubCss } from '../src/epub-css.ts';
const enc = new TextEncoder();
function resources(entries: Map<string, Uint8Array>) {
  return {
    entries,
    mediaTypes: new Map([
      ['OPS/img.png', 'image/png'],
      ['OPS/a.css', 'text/css'],
      ['OPS/b.css', 'text/css'],
      ['OPS/c.css', 'text/css'],
      ['OPS/d.css', 'text/css'],
      ['OPS/e.css', 'text/css'],
    ]),
    dataUrls: new Map<string, string>(),
    mediaUrls: new Map<string, string>(),
    imagePixels: new Map<string, number>(),
    decodedImagePixels: 0,
    omittedImages: false,
    omittedImagePaths: new Set<string>(),
    encodedBytes: 0,
    referencedBytes: 0,
    cssRewriteBytes: 0,
    cssBytes: 0,
  };
}
test('rewrites local images and strips remote URL forms', () => {
  const entries = new Map([['OPS/img.png', new Uint8Array([1, 2, 3])]]);
  const css = epubCss(
    resources(entries),
    'OPS/main.css',
    'p{background:url(img.png)} q{background:URL("https://evil.invalid/x")} r{background:u\\72l(//evil.invalid/x)}'
  );
  expect(css).toContain('data:image/png;base64,AQID');
  expect(css).not.toContain('evil.invalid');
});
test('follows local imports and rejects loops and excess depth', () => {
  const entries = new Map([
    ['OPS/a.css', enc.encode('@import "b.css"; p{color:red}')],
    ['OPS/b.css', enc.encode('p{font-weight:bold}')],
  ]);
  expect(
    epubCss(resources(entries), 'OPS/root.css', '@import "a.css";')
  ).toContain('font-weight:bold');
  expect(
    epubCss(resources(entries), 'OPS/root.css', '@import "b.css" screen;')
  ).toContain('@media screen{');
  entries.set('OPS/b.css', enc.encode('@import "a.css";'));
  expect(() =>
    epubCss(resources(entries), 'OPS/root.css', '@import "a.css";')
  ).toThrow();
  entries.set('OPS/b.css', enc.encode('@import "c.css";'));
  entries.set('OPS/c.css', enc.encode('@import "d.css";'));
  entries.set('OPS/d.css', enc.encode('@import "e.css";'));
  entries.set('OPS/e.css', enc.encode('p{color:red}'));
  expect(() =>
    epubCss(resources(entries), 'OPS/root.css', '@import "a.css";')
  ).toThrow();
});

test('preserves layer, supports, and media conditions on local imports', () => {
  const entries = new Map([['OPS/b.css', enc.encode('p{font-weight:bold}')]]);
  const cases = [
    [
      '@import "b.css" layer(book.theme) supports(display: grid) screen and (min-width: 300px);',
      '@layer book.theme{@supports (display: grid){@media screen and (min-width: 300px){p{font-weight:bold}}}}',
    ],
    ['@import "b.css" layer;', '@layer{p{font-weight:bold}}'],
    [
      '@import url("b.css") supports(selector(:has(.featured))) print;',
      '@supports (selector(:has(.featured))){@media print{p{font-weight:bold}}}',
    ],
    [
      '@import /* before URL */ "b.css" l\\61 yer(theme) supports((display: grid) and (color: red));',
      '@layer theme{@supports ((display: grid) and (color: red)){p{font-weight:bold}}}',
    ],
    ['@import "b.css" supports;', '@media supports{p{font-weight:bold}}'],
  ];
  for (const [source, expected] of cases) {
    expect(epubCss(resources(entries), 'OPS/root.css', source!)).toBe(
      expected!
    );
  }
});

test('refuses malformed import conditions rather than dropping them', () => {
  const entries = new Map([['OPS/b.css', enc.encode('p{font-weight:bold}')]]);
  for (const source of [
    '@import "b.css" layer();',
    '@import "b.css" layer(book..theme);',
    '@import "b.css" supports(display: grid;',
    '@import "b.css" screen and (min-width: 300px;',
  ]) {
    expect(() => epubCss(resources(entries), 'OPS/root.css', source)).toThrow();
  }
});

test('uses manifest MIME for extensionless images and rejects mismatched assets', () => {
  const context = resources(
    new Map([
      ['OPS/picture', new Uint8Array([1, 2, 3])],
      ['OPS/misnamed.png', new Uint8Array([1, 2, 3])],
    ])
  );
  context.mediaTypes.set('OPS/picture', 'image/png');
  context.mediaTypes.set('OPS/misnamed.png', 'application/octet-stream');
  expect(epubDataUrl(context, 'OPS/book.xhtml', 'picture', 'image')).toBe(
    'data:image/png;base64,AQID'
  );
  expect(
    epubDataUrl(context, 'OPS/book.xhtml', 'misnamed.png', 'image')
  ).toBeUndefined();
  expect(context.dataUrls.size).toBe(1);
});

test('bounds measured raster area without rejecting an unmeasurable image', () => {
  const png = (width: number, height: number): Uint8Array => {
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    bytes.set([73, 72, 68, 82], 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
  };
  const entries = new Map([
    ['OPS/ordinary', png(64, 64)],
    ['OPS/large', png(10000, 10000)],
    ['OPS/mislabeled-large', png(10000, 10000)],
    ['OPS/mislabeled-small', png(32, 32)],
    ['OPS/unknown', new Uint8Array([1, 2, 3])],
  ]);
  const context = resources(entries);
  for (const path of entries.keys()) context.mediaTypes.set(path, 'image/png');
  context.mediaTypes.set('OPS/mislabeled-large', 'image/jpeg');
  context.mediaTypes.set('OPS/mislabeled-small', 'image/gif');
  expect(
    epubDataUrl(context, 'OPS/book.xhtml', 'ordinary', 'image')
  ).toBeDefined();
  expect(
    epubDataUrl(context, 'OPS/book.xhtml', 'ordinary', 'image')
  ).toBeDefined();
  expect(context.decodedImagePixels).toBe(64 * 64);
  expect(
    epubDataUrl(context, 'OPS/book.xhtml', 'large', 'image')
  ).toBeUndefined();
  expect(context.omittedImages).toBe(true);
  expect(context.omittedImagePaths.has('OPS/large')).toBe(true);
  expect(context.omittedImagePaths.has('OPS/ordinary')).toBe(false);
  expect(
    epubDataUrl(context, 'OPS/book.xhtml', 'mislabeled-large', 'image')
  ).toBeUndefined();
  expect(context.omittedImagePaths.has('OPS/mislabeled-large')).toBe(true);
  expect(
    epubDataUrl(context, 'OPS/book.xhtml', 'mislabeled-small', 'image')
  ).toBeDefined();
  expect(
    epubDataUrl(context, 'OPS/book.xhtml', 'unknown', 'image')
  ).toBeDefined();
  const many = new Map(
    Array.from(
      { length: 9 },
      (_, i) => [`OPS/image${i}`, png(4096, 4096)] as const
    )
  );
  const total = resources(many);
  for (const path of many.keys()) total.mediaTypes.set(path, 'image/png');
  for (let i = 0; i < 8; i++)
    expect(
      epubDataUrl(total, 'OPS/book.xhtml', `image${i}`, 'image')
    ).toBeDefined();
  expect(
    epubDataUrl(total, 'OPS/book.xhtml', 'image8', 'image')
  ).toBeUndefined();
  expect(total.omittedImages).toBe(true);
});

test('recognizes GIF, JPEG and WebP raster dimensions before admission', () => {
  const gif = new Uint8Array(10);
  gif.set([71, 73, 70, 56, 57, 97]);
  new DataView(gif.buffer).setUint16(6, 10000, true);
  new DataView(gif.buffer).setUint16(8, 10000, true);
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0x27, 0x10, 0x27, 0x10, 1,
  ]);
  const webp = new Uint8Array(30);
  webp.set([82, 73, 70, 70], 0);
  webp.set([87, 69, 66, 80], 8);
  webp.set([86, 80, 56, 88], 12);
  webp.set([0x0f, 0x27, 0, 0x0f, 0x27, 0], 24);
  for (const [name, mime, bytes] of [
    ['picture.gif', 'image/gif', gif],
    ['picture.jpg', 'image/jpeg', jpeg],
    ['picture.webp', 'image/webp', webp],
  ] as const) {
    const context = resources(new Map([[`OPS/${name}`, bytes]]));
    context.mediaTypes.set(`OPS/${name}`, mime);
    expect(
      epubDataUrl(context, 'OPS/book.xhtml', name, 'image')
    ).toBeUndefined();
    expect(context.omittedImages).toBe(true);
  }
});

test('bounds stylesheet expansion and rejects incomplete CSS scopes', () => {
  expect(() => scopeEpubCss('p{color:red', 0)).toThrow();
  const context = resources(
    new Map([['OPS/img.png', new Uint8Array(1024 * 1024)]])
  );
  expect(() =>
    epubCss(
      context,
      'OPS/main.css',
      `p{background:${'url(img.png) '.repeat(4)}}`
    )
  ).toThrow();
  const exhausted = resources(new Map());
  exhausted.cssRewriteBytes = 256 * 1024 * 1024 - 1;
  expect(() => epubCss(exhausted, 'OPS/main.css', 'p{}', 0, true)).toThrow(
    'CSS limit exceeded'
  );
  const references = resources(
    new Map([['OPS/img.png', new Uint8Array([1, 2, 3])]])
  );
  references.referencedBytes = 64 * 1024 * 1024 - 1;
  expect(() =>
    epubDataUrl(references, 'OPS/book.xhtml', 'img.png', 'image')
  ).toThrow('EPUB resource limit exceeded');
});
