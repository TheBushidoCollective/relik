import { expect, test } from 'bun:test';
import {
  normalizeUrl,
  parseDataUrl,
  scanCssUrls,
} from '../src/resource-urls.ts';

test('finds CSS URL tokens and image-set strings but ignores comments and labels', () => {
  const css = `
    /* url(data:image/png;base64,AAAA) */
    text::after { content: "url(data:image/png;base64,BBBB)"; }
    rect { fill: url('data:image/png;base64,AQID'); }
    path { fill: url(data:image/png;base64,BAUG); }
    image { background: image-set("data:image/png;base64,BwgJ" 1x); }
  `;
  const result = scanCssUrls(css);
  expect(result.opaque).toBe(false);
  expect(result.urls.map((entry) => entry.url)).toEqual([
    'data:image/png;base64,AQID',
    'data:image/png;base64,BAUG',
    'data:image/png;base64,BwgJ',
  ]);
  for (const entry of result.urls)
    expect(css.slice(entry.start, entry.end)).toBe(entry.url);
});

test('decodes ordinary escapes in quoted image URLs', () => {
  const result = scanCssUrls(
    String.raw`rect { fill: url("https://example.test/image\ 1.png"); }`
  );
  expect(result.opaque).toBe(false);
  expect(result.urls.map((entry) => entry.url)).toEqual([
    'https://example.test/image 1.png',
  ]);
});

test('decodes base64 and percent-encoded data URLs', () => {
  const base64 = parseDataUrl(' DATA:Image/PNG;base64,AQ%49D#fragment ');
  expect(base64).not.toBe('invalid');
  expect(base64).toBeDefined();
  if (!base64 || base64 === 'invalid')
    throw new Error('data URL was not decoded');
  expect(base64.essence).toBe('image/png');
  expect(Array.from(base64.bytes)).toEqual([1, 2, 3]);

  const raw = parseDataUrl('data:image/png,%89PNG%0d%0a');
  if (!raw || raw === 'invalid') throw new Error('data URL was not decoded');
  expect(raw.essence).toBe('image/png');
  expect(Array.from(raw.bytes)).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  expect(parseDataUrl('data:image/png;base64,%%%')).toBe('invalid');
  expect(parseDataUrl('#local')).toBeUndefined();
  expect(normalizeUrl('  data:image/png,ok\n')).toBe('data:image/png,ok');
});
