import { describe, expect, test } from 'bun:test';
import {
  decodeXmlBytes,
  localName,
  parseXml,
  scanForbiddenDtd,
} from '../src/xml.ts';

describe('bounded XML parser', () => {
  test('decodes UTF-8 and UTF-16 XML byte signatures strictly', () => {
    const xml = '<root>Résumé 😀</root>';
    expect(decodeXmlBytes(new TextEncoder().encode(xml))).toBe(xml);
    for (const littleEndian of [true, false]) {
      for (const bom of [true, false]) {
        const offset = bom ? 2 : 0;
        const bytes = new Uint8Array(offset + xml.length * 2);
        if (bom) {
          bytes[0] = littleEndian ? 0xff : 0xfe;
          bytes[1] = littleEndian ? 0xfe : 0xff;
        }
        for (let i = 0; i < xml.length; i++) {
          const code = xml.charCodeAt(i);
          bytes[offset + i * 2 + (littleEndian ? 0 : 1)] = code & 0xff;
          bytes[offset + i * 2 + (littleEndian ? 1 : 0)] = code >>> 8;
        }
        expect(decodeXmlBytes(bytes)).toBe(xml);
      }
    }
    expect(() => decodeXmlBytes(new Uint8Array([0xc3, 0x28]))).toThrow();
    expect(() => decodeXmlBytes(new Uint8Array([0xff, 0xfe, 0x3c]))).toThrow();
  });

  test('asks for element admission with zero-based depth before allocation', () => {
    const admitted: [string, number][] = [];
    const result = parseXml('<root><leaf/><group><deep/></group></root>', {
      admitElement: (name, depth) => {
        admitted.push([name, depth]);
        return admitted.length <= 3;
      },
    });
    expect(result).toEqual({ ok: false, reason: 'elements' });
    expect(admitted).toEqual([
      ['root', 0],
      ['leaf', 1],
      ['group', 1],
      ['deep', 2],
    ]);
    const lenient = parseXml('<root>&nbsp;</root>', {
      lenient: true,
      admitElement: () => true,
    });
    expect(lenient.ok && lenient.root.children).toEqual(['&nbsp;']);
  });

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
  test('matches the previous EPUB scanner on ordinary and edge declarations', () => {
    const previous = (text: string): boolean => {
      if (text.includes('\0') || /<!ENTITY\b/i.test(text)) return true;
      for (const match of text.matchAll(/<!DOCTYPE\b/gi)) {
        let quote = '';
        for (let i = match.index! + match[0].length; i < text.length; i++) {
          const c = text[i]!;
          if (quote) {
            if (c === quote) quote = '';
          } else if (c === '"' || c === "'") {
            quote = c;
          } else if (c === '[') {
            return true;
          } else if (c === '>') {
            break;
          }
        }
      }
      return false;
    };
    const cases = [
      '',
      '<html/>',
      '<!DOCTYPE html><html/>',
      '<!doctype html>',
      '<!DOCTYPE html [ <!ELEMENT html ANY> ]>',
      '<!ENTITY x "bad">',
      '<!DOCTYPE html SYSTEM "a>b"><html/>',
      "<!DOCTYPE html SYSTEM 'a[b'><html/>",
      '<!DOCTYPE html',
      '<!DOCTYPE html "unterminated',
      '<!DOCTYPE html><!DOCTYPE x [ ]>',
      '<!DOCTYPE html><!DOCTYPE x>',
      '<!DOCTYPE html <!DOCTYPE x [',
      '<!DOCTYPE-html [',
      '\0',
    ];
    for (const text of cases) {
      expect(scanForbiddenDtd(text, 'epub')).toBe(previous(text));
    }
  });

  test('scans repeated unterminated declarations in linear time', () => {
    const input = '<!DOCTYPE '.repeat(200_000);
    const start = performance.now();
    expect(scanForbiddenDtd(input, 'epub')).toBe(false);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
