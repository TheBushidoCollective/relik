import { expect, test } from 'bun:test';
import { epubCss } from '../src/epub-css.ts';
const enc = new TextEncoder();
test('rewrites local images and strips remote URL forms', () => {
  const entries = new Map([['OPS/img.png', new Uint8Array([1, 2, 3])]]);
  const css = epubCss(
    entries,
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
  expect(epubCss(entries, 'OPS/root.css', '@import "a.css";')).toContain(
    'font-weight:bold'
  );
  entries.set('OPS/b.css', enc.encode('@import "a.css";'));
  expect(() => epubCss(entries, 'OPS/root.css', '@import "a.css";')).toThrow();
  entries.set('OPS/b.css', enc.encode('@import "c.css";'));
  entries.set('OPS/c.css', enc.encode('@import "d.css";'));
  entries.set('OPS/d.css', enc.encode('@import "e.css";'));
  entries.set('OPS/e.css', enc.encode('p{color:red}'));
  expect(() => epubCss(entries, 'OPS/root.css', '@import "a.css";')).toThrow();
});
