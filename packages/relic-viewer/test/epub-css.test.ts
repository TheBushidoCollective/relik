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
    encodedBytes: 0,
    referencedBytes: 0,
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
});
