import { describe, expect, test } from 'bun:test';
import { localName, parseXml, scanForbiddenDtd } from '../src/xml.ts';

describe('bounded XML parser', () => {
  test('parses element structure, namespaces and safe entities', () => {
    const result = parseXml(
      '<r:root a="one &amp; two"><child>&lt;&#65;&#x1F600;</child></r:root>'
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(localName(result.root.name)).toBe('root');
      expect(result.root.attrs.get('a')).toBe('one & two');
      const child = result.root.children[0];
      expect(typeof child).toBe('object');
      if (typeof child === 'object') expect(child.children).toEqual(['<A😀']);
    }
  });
  test('refuses unknown entities unless explicitly lenient', () => {
    expect(parseXml('<x>&nbsp;</x>')).toEqual({ ok: false, reason: 'entity' });
    const result = parseXml('<x>&nbsp;</x>', { lenient: true });
    expect(result.ok && result.root.children).toEqual(['&nbsp;']);
    expect(parseXml('<x>&#0;</x>').ok).toBe(false);
  });
  test('enforces depth and attribute bounds', () => {
    const nested = (n: number) => '<a>'.repeat(n) + '</a>'.repeat(n);
    expect(parseXml(nested(256)).ok).toBe(true);
    expect(parseXml(nested(257))).toEqual({ ok: false, reason: 'depth' });
    const attrs = (n: number) =>
      `<x ${Array.from({ length: n }, (_, i) => `a${i}="v"`).join(' ')}/>`;
    expect(parseXml(attrs(256)).ok).toBe(true);
    expect(parseXml(attrs(257))).toEqual({ ok: false, reason: 'attributes' });
  });
  test('refuses malformed and mismatched elements', () => {
    for (const xml of [
      '<a><b></a>',
      '<a x="1" x="2"/>',
      '<a/>tail',
      '<a>bare & text</a>',
    ]) {
      expect(parseXml(xml).ok).toBe(false);
    }
  });
  test('rejects dangerous DTDs while permitting a plain ebook doctype', () => {
    expect(scanForbiddenDtd('<!DOCTYPE html><html/>', 'docx')).toBe(true);
    expect(scanForbiddenDtd('<!DOCTYPE html><html/>', 'epub')).toBe(false);
    const hostile = '<!DOCTYPE html SYSTEM "a>b" [<!ENTITY x "bad">]><html/>';
    expect(scanForbiddenDtd(hostile, 'epub')).toBe(true);
    expect(parseXml(hostile).ok).toBe(false);
    const utf16 = new Uint8Array(hostile.length * 2 + 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    for (let i = 0; i < hostile.length; i++)
      utf16[2 + i * 2] = hostile.charCodeAt(i);
    expect(scanForbiddenDtd(utf16, 'epub')).toBe(true);
    expect(parseXml('<!DOCTYPE html><html/>').ok).toBe(true);
  });
});
