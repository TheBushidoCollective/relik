import { describe, expect, test } from 'bun:test';
import { tokenizeSpreadsheetXml } from './xlsx-xml.ts';

describe('spreadsheet XML tokenizer', () => {
  function tokens(xml: string): string[] {
    const out: string[] = [];
    tokenizeSpreadsheetXml(xml, {
      start: (name, attrs) => out.push(`+${name}:${attrs.get('a') ?? ''}`),
      end: (name) => out.push(`-${name}`),
      text: (text) => out.push(text),
    });
    return out;
  }
  test('emits nested elements, attributes, CDATA, and decoded entities', () => {
    expect(
      tokens(
        '<?xml version="1.0"?><root a="&amp;&#x41;"><x/>one<![CDATA[<two>]]></root>'
      )
    ).toEqual(['+root:&A', '+x:', '-x', 'one', '<two>', '-root']);
  });
  test.each([
    '<!DOCTYPE x><x/>',
    '<!ENTITY x "y"><x/>',
    '<x>&foreign;</x>',
    '<x><y></x>',
    '<x a="1" a="2"/>',
    '<x/>trailing',
    '<x>\0</x>',
  ])('refuses hostile or malformed XML: %s', (xml) => {
    expect(() => tokens(xml)).toThrow();
  });
  test('namespace scopes use shared state and restore shadowed bindings', () => {
    const maps: ReadonlyMap<string, string>[] = [];
    const values: Array<string | undefined> = [];
    tokenizeSpreadsheetXml(
      '<root xmlns:p="one"><child xmlns:p="two"><leaf/></child><sibling/></root>',
      {
        start(_name, _attrs, namespaces) {
          maps.push(namespaces);
          values.push(namespaces.get('p'));
        },
        end() {},
        text() {},
      }
    );
    expect(values).toEqual(['one', 'two', 'two', 'one']);
    expect(maps.every((map) => map === maps[0])).toBe(true);
  });
});
