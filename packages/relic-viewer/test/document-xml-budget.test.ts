import { describe, expect, test } from 'bun:test';
import { DocxLimitError, XmlReadBudget } from '../src/document-xml-budget.ts';
import EntryArchive, { ImageBudget } from '../src/frame-zip-entries.ts';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('DOCX XML read budget', () => {
  test('admits ordinary XML and accounts for every read', async () => {
    const xml = encode('<document><p>One</p></document>');
    const budget = new XmlReadBudget(xml.length, xml.length * 2, 6);
    const archive = await EntryArchive.loadAsync({
      entries: new Map([['body.part', xml]]),
      budget: new ImageBudget(),
      xmlBudget: budget,
    });
    const entry = archive.files['body.part']!;
    expect(await entry.async('string')).toBe('<document><p>One</p></document>');
    expect(await entry.async('string')).toBe('<document><p>One</p></document>');
    await expect(entry.async('string')).rejects.toBeInstanceOf(DocxLimitError);
  });

  test('rejects a truncated UTF-8 sequence in document text', () => {
    const bytes = new Uint8Array([
      ...encode('<document>caf'),
      0xc3,
      ...encode('</document>'),
    ]);
    expect(() => new XmlReadBudget().read(bytes)).toThrow();
  });

  test('bounds structural units before a native parser is called', () => {
    const xml = encode('<document><p>One</p></document>');
    expect(new XmlReadBudget(1024, 1024, 3).read(xml)).toContain('One');
    expect(() => new XmlReadBudget(1024, 1024, 2).read(xml)).toThrow(
      DocxLimitError
    );
  });

  test('recognizes omitted embedded content in a UTF-16 part', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-16"?><w:document xmlns:w="urn:word"><w:altChunk/></w:document>';
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(xml, 'utf16le'),
    ]);
    const budget = new XmlReadBudget();
    expect(budget.read(bytes)).toBe(xml);
    expect(budget.omittedEmbeddedContent).toBe(true);
  });

  test('handles comments, CDATA, instructions and quoted angle brackets', () => {
    const xml =
      '<?xml version="1.0"?><root value="a > b"><!-- note --><![CDATA[text <b>]]><item/></root>';
    expect(new XmlReadBudget().read(encode(xml))).toBe(xml);
  });
});
