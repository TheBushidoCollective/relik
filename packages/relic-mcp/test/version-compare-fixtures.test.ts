import { describe, expect, test } from 'bun:test';
import { readEpubPackage } from '@relic/format/epub-package';
import {
  parseXlsx,
  worksheetRowIndex,
  type WorkbookSheet,
} from '@relic/format/xlsx';
import {
  decodeXmlBytes,
  localName,
  parseXml,
  type XmlElement,
} from '@relic/format/xml';
import type { ZipIndex } from '@relic/format/zip-index';
import { selectDocxParts } from '../../relic-viewer/src/document-payload-docx.ts';
import {
  COMPARE_LIMIT_BYTES,
  DOCX_V1_HEADER,
  DOCX_V1_TEXT,
  DOCX_V2_HEADER,
  DOCX_V2_TEXT,
  DOCX_FOOTER,
  EPUB_HOSTILE_TEXT,
  EPUB_TITLE,
  PADDING_BYTES,
  docxPadded,
  docxV1,
  docxV1CoreOnly,
  docxV2,
  epubV1,
  epubV2,
  epubV2Hostile,
  fixtureEntries,
  indexFixture,
  inflate,
  xlsxV1,
  xlsxV2,
  xlsxV2BidiSheet,
  zipFiles,
} from './version-compare-fixtures.ts';

async function xmlOf(index: ZipIndex, name: string): Promise<XmlElement> {
  const read = await index.read(name);
  if (!read.ok) throw new Error(`${name}: ${read.reason}`);
  const parsed = parseXml(decodeXmlBytes(read.bytes, { fatal: true }));
  if (!parsed.ok) throw new Error(`${name}: ${parsed.reason}`);
  return parsed.root;
}

/** All descendant elements (and the root) with the given local name, in document order. */
function elementsNamed(root: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (el: XmlElement) => {
    if (localName(el.name) === name) found.push(el);
    for (const child of el.children)
      if (typeof child !== 'string') visit(child);
  };
  visit(root);
  return found;
}

function textOf(el: XmlElement): string {
  return el.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('');
}

/** Non-empty `p` texts in document order. A paragraph is not split further. */
function paragraphs(root: XmlElement): string[] {
  return elementsNamed(root, 'p')
    .map((p) => textOf(p).trim())
    .filter((text) => text.length > 0);
}

function singleEntryNamed(index: ZipIndex, pattern: RegExp): string {
  const names = [...index.entries.keys()].filter((name) => pattern.test(name));
  if (names.length !== 1)
    throw new Error(`expected one ${pattern}, got ${names.length}`);
  return names[0]!;
}

interface CellView {
  readonly text: string;
  readonly formula?: string;
}

/** The cell at an A1 reference, or undefined when the cell is empty. */
function cellAt(sheet: WorkbookSheet, a1: string): CellView | undefined {
  const match = /^([A-Z]+)(\d+)$/.exec(a1);
  if (!match) throw new Error(`bad reference ${a1}`);
  let column = 0;
  for (const letter of match[1]!)
    column = column * 26 + letter.charCodeAt(0) - 64;
  const row = worksheetRowIndex(sheet, Number(match[2]) - 1);
  if (row < 0) return undefined;
  for (let i = sheet.rowStart[row]!; i < sheet.rowStart[row + 1]!; i++) {
    if (sheet.cells[i * 3] !== column - 1) continue;
    const detail = sheet.cells[i * 3 + 2]!;
    const formula =
      detail === 0 ? undefined : sheet.details[detail - 1]?.formula;
    return {
      text: sheet.texts[sheet.cells[i * 3 + 1]!]!,
      ...(formula === undefined ? {} : { formula }),
    };
  }
  return undefined;
}

async function workbookSheetIds(bytes: Uint8Array): Promise<string[]> {
  const index = await indexFixture(bytes);
  const root = await xmlOf(index, 'xl/workbook.xml');
  return elementsNamed(root, 'sheet').map(
    (sheet) => sheet.attrs.get('sheetId') ?? ''
  );
}

describe('DOCX fixtures', () => {
  test('v1 and v2 pass the viewer ZIP and part checks with the expected paragraphs', async () => {
    for (const [bytes, expected] of [
      [await docxV1(), DOCX_V1_TEXT],
      [await docxV2(), DOCX_V2_TEXT],
    ] as const) {
      const index = await indexFixture(bytes);
      const selection = await selectDocxParts(index);
      expect(selection.parts).toContain('word/document.xml');
      expect(selection.xmlParts.has('word/document.xml')).toBe(true);
      const root = await xmlOf(index, 'word/document.xml');
      expect(paragraphs(root)).toEqual([...expected]);
    }
  });

  test('header text changes between versions and the footer is shared', async () => {
    const v1 = await indexFixture(await docxV1());
    const v2 = await indexFixture(await docxV2());
    const headerOf = async (index: ZipIndex) =>
      paragraphs(
        await xmlOf(index, singleEntryNamed(index, /^word\/header\d*\.xml$/))
      );
    const footerOf = async (index: ZipIndex) =>
      paragraphs(
        await xmlOf(index, singleEntryNamed(index, /^word\/footer\d*\.xml$/))
      );
    expect(await headerOf(v1)).toEqual([DOCX_V1_HEADER]);
    expect(await headerOf(v2)).toEqual([DOCX_V2_HEADER]);
    expect(await footerOf(v1)).toEqual([DOCX_FOOTER]);
    expect(await footerOf(v2)).toEqual([DOCX_FOOTER]);
  });

  test('v1 prime differs from v1 only in docProps/core.xml', async () => {
    const v1 = await docxV1();
    const base = await fixtureEntries(v1);
    const variant = await fixtureEntries(await docxV1CoreOnly(v1));
    expect(variant.map((e) => e.name)).toEqual(base.map((e) => e.name));
    const changed = base
      .filter((entry, i) => {
        const other = variant[i]!;
        return (
          entry.bytes.length !== other.bytes.length ||
          entry.bytes.some((byte, j) => byte !== other.bytes[j])
        );
      })
      .map((entry) => entry.name);
    // A variant that changes nothing would make the "no text changes" negative vacuous.
    expect(changed).toEqual(['docProps/core.xml']);
    const core = await xmlOf(
      await indexFixture(await docxV1CoreOnly(v1)),
      'docProps/core.xml'
    );
    expect(elementsNamed(core, 'creator').map(textOf)).toEqual([
      'Fixture reviewer',
    ]);
  });

  test('padded DOCX is over the 16 MiB ceiling because of one stored 17 MiB entry', async () => {
    const bytes = await docxPadded();
    expect(bytes.byteLength).toBeGreaterThan(COMPARE_LIMIT_BYTES);
    expect(bytes.byteLength).toBeGreaterThanOrEqual(PADDING_BYTES);
    expect(bytes.byteLength).toBeLessThan(PADDING_BYTES + 1024 * 1024);
    const index = await indexFixture(bytes);
    const padding = index.entries.get('padding.bin');
    expect(padding?.size).toBe(PADDING_BYTES);
    expect(padding?.method).toBe(0);
    const selection = await selectDocxParts(index);
    expect(selection.parts).toEqual(
      (await selectDocxParts(await indexFixture(await docxV1()))).parts
    );
  });
});

describe('EPUB fixtures', () => {
  test('v1 and v2 spines, contents and title', async () => {
    const v1 = await indexFixture(epubV1());
    const parsed1 = await readEpubPackage(v1);
    expect(parsed1.ok).toBe(true);
    if (!parsed1.ok) return;
    expect(parsed1.book.title).toBe(EPUB_TITLE);
    expect(parsed1.book.spine.map((s) => s.path)).toEqual([
      'OPS/ch1.xhtml',
      'OPS/ch2.xhtml',
      'OPS/ch3.xhtml',
    ]);
    expect(parsed1.book.toc.map((t) => t.label)).toEqual([
      'Opening',
      'The crossing',
      'Interlude',
    ]);

    const parsed2 = await readEpubPackage(await indexFixture(epubV2()));
    expect(parsed2.ok).toBe(true);
    if (!parsed2.ok) return;
    expect(parsed2.book.title).toBe(EPUB_TITLE);
    expect(parsed2.book.spine.map((s) => s.path)).toEqual([
      'OPS/ch1.xhtml',
      'OPS/ch2.xhtml',
      'OPS/ch4.xhtml',
    ]);
    expect(parsed2.book.toc.map((t) => t.label)).toEqual([
      'Opening',
      'The crossing',
      'Afterword',
    ]);
  });

  test('Opening is byte-identical and The crossing changes one paragraph', async () => {
    const v1 = await indexFixture(epubV1());
    const v2 = await indexFixture(epubV2());
    const opening1 = await v1.read('OPS/ch1.xhtml');
    const opening2 = await v2.read('OPS/ch1.xhtml');
    if (!opening1.ok || !opening2.ok)
      throw new Error('missing Opening chapter');
    expect(decodeXmlBytes(opening1.bytes)).toBe(decodeXmlBytes(opening2.bytes));

    const crossing1 = await xmlOf(v1, 'OPS/ch2.xhtml');
    const crossing2 = await xmlOf(v2, 'OPS/ch2.xhtml');
    expect(paragraphs(crossing1)).toEqual([
      'We crossed at dawn.',
      'Three boats were tied to the post.',
    ]);
    expect(paragraphs(crossing2)).toEqual([
      'We crossed at noon.',
      'Three boats were tied to the post.',
    ]);
    expect(elementsNamed(crossing1, 'h1').map(textOf)).toEqual([
      'The crossing',
    ]);
    expect(elementsNamed(crossing2, 'h1').map(textOf)).toEqual([
      'The crossing',
    ]);
  });

  test('Interlude is removed and Afterword is added with its own heading and text', async () => {
    const interlude = await xmlOf(
      await indexFixture(epubV1()),
      'OPS/ch3.xhtml'
    );
    expect(elementsNamed(interlude, 'h1').map(textOf)).toEqual(['Interlude']);
    expect(paragraphs(interlude)).toEqual(['A short pause between crossings.']);
    const afterword = await xmlOf(
      await indexFixture(epubV2()),
      'OPS/ch4.xhtml'
    );
    expect(elementsNamed(afterword, 'h1').map(textOf)).toEqual(['Afterword']);
    expect(paragraphs(afterword)).toEqual(['The story ends here.']);
  });

  test('hostile markup is escaped text, never an element', async () => {
    const index = await indexFixture(epubV2Hostile());
    const crossing = await xmlOf(index, 'OPS/ch2.xhtml');
    expect(paragraphs(crossing)[0]).toBe(EPUB_HOSTILE_TEXT);
    expect(elementsNamed(crossing, 'img')).toEqual([]);
    const parsed = await readEpubPackage(index);
    expect(parsed.ok).toBe(true);
  });
});

describe('XLSX fixtures', () => {
  test('v1 sheets: names, states and sheetIds', async () => {
    const parsed = await parseXlsx(xlsxV1(), inflate);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const sheets = parsed.workbook.sheets;
    expect(sheets.map((s) => s.name)).toEqual(['Q3', 'Old data', 'Hidden']);
    expect(sheets.map((s) => s.state)).toEqual([
      'visible',
      'visible',
      'hidden',
    ]);
    expect(await workbookSheetIds(xlsxV1())).toEqual(['1', '2', '3']);
  });

  test('v2 sheets: the rename keeps sheetId 1, Summary is added with sheetId 4', async () => {
    const parsed = await parseXlsx(xlsxV2(), inflate);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const sheets = parsed.workbook.sheets;
    expect(sheets.map((s) => s.name)).toEqual([
      'Q3 budget',
      'Hidden',
      'Summary',
    ]);
    expect(sheets.map((s) => s.state)).toEqual([
      'visible',
      'hidden',
      'visible',
    ]);
    expect(await workbookSheetIds(xlsxV2())).toEqual(['1', '3', '4']);
  });

  test('cell facts for the paired and the changed sheets', async () => {
    const v1 = await parseXlsx(xlsxV1(), inflate);
    const v2 = await parseXlsx(xlsxV2(), inflate);
    if (!v1.ok || !v2.ok) throw new Error('fixture workbook did not parse');
    const q3 = v1.workbook.sheets[0]!;
    const budget = v2.workbook.sheets[0]!;
    expect(cellAt(q3, 'C3')).toEqual({ text: '1200' });
    expect(cellAt(budget, 'C3')).toEqual({ text: '1250' });
    expect(cellAt(q3, 'E2')).toEqual({ text: '2200' });
    expect(cellAt(budget, 'E2')).toEqual({
      text: '2250',
      formula: 'SUM(B2:C3)',
    });
    expect(cellAt(q3, 'E3')).toEqual({ text: '2000', formula: 'B2*2' });
    expect(cellAt(budget, 'E3')).toEqual({ text: '2000', formula: 'B2+B2' });
    expect(cellAt(q3, 'B7')).toEqual({ text: 'Draft note' });
    expect(cellAt(budget, 'B7')).toBeUndefined();
    expect(cellAt(q3, 'D5')).toBeUndefined();
    expect(cellAt(budget, 'D5')).toEqual({ text: 'Total' });
    expect(cellAt(v1.workbook.sheets[2]!, 'A1')).toEqual({ text: 'x' });
    expect(cellAt(v2.workbook.sheets[1]!, 'A1')).toEqual({ text: 'y' });
  });

  test('the bidi sheet name keeps its U+202E override', async () => {
    const parsed = await parseXlsx(xlsxV2BidiSheet(), inflate);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.workbook.sheets[2]!.name).toBe('Sum\u202emary');
  });

  test('a ZIP without a workbook is refused as corrupt', async () => {
    const bogus = zipFiles([
      {
        name: 'readme.txt',
        bytes: new TextEncoder().encode('no workbook'),
        method: 0,
      },
    ]);
    expect(await parseXlsx(bogus, inflate)).toEqual({
      ok: false,
      reason: 'corrupt',
    });
  });
});
