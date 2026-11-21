import { describe, expect, test } from 'bun:test';
import { crc32 } from './zip-index.ts';
import { planStoredZip } from './zip-write.ts';
import { parseXlsx } from './xlsx.ts';
import { parseWorksheet } from './xlsx-sheet.ts';

function zip(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const entries = Object.entries(files).map(([name, text]) => ({
    name,
    data: encoder.encode(text),
  }));
  const plan = planStoredZip(
    entries.map((e) => ({
      name: e.name,
      size: e.data.length,
      crc32: crc32(e.data),
    }))
  );
  const result = new Uint8Array(plan.totalBytes);
  let at = 0;
  entries.forEach((e, i) => {
    const header = plan.localHeaders[i]!;
    result.set(header, at);
    at += header.length;
    result.set(e.data, at);
    at += e.data.length;
  });
  result.set(plan.centralDirectory, at);
  at += plan.centralDirectory.length;
  result.set(plan.end, at);
  return result;
}
function fixture(
  sheet: string,
  workbook = '<workbook><sheets><sheet name="Sales" r:id="r1"/></sheets></workbook>',
  extra: Record<string, string> = {}
): Uint8Array {
  return zip({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="r3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
    'xl/sharedStrings.xml':
      '<sst><si><r><t>Hello </t></r><r><t>world</t></r></si></sst>',
    'xl/styles.xml':
      '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="10"/><xf numFmtId="164"/></cellXfs></styleSheet>',
    ...extra,
  });
}

describe('XLSX workbook', () => {
  test('reads values, formatting, rich text, and formula metadata', async () => {
    const input = fixture(
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><r><t>in</t></r><r><t>line</t></r></is></c><c r="C1" t="b"><v>1</v></c><c r="D1" t="e"><v>#DIV/0!</v></c><c r="E1" s="1"><v>61</v></c><c r="F1" s="2"><v>0.25</v></c><c r="G1" s="3"><v>2</v></c><c r="H1"><f>SUM(A1:A2)</f><v>3</v></c></row></sheetData></worksheet>'
    );
    const result = await parseXlsx(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sheet = result.workbook.sheets[0]!;
    const values = Array.from(
      { length: 8 },
      (_, i) => sheet.texts[sheet.cells[i * 3 + 1]!]!
    );
    expect(values).toEqual([
      'Hello world',
      'inline',
      'TRUE',
      '#DIV/0!',
      '1900-03-01',
      '25%',
      '1900-01-02',
      '3',
    ]);
    expect(sheet.details[sheet.cells[23]! - 1]?.formula).toBe('SUM(A1:A2)');
    expect([...sheet.rowStart]).toEqual([0, 8]);
  });
  test('uses 1904 epoch and refuses DTDs', async () => {
    const workbook =
      '<workbook><workbookPr date1904="1"/><sheets><sheet name="Sales" r:id="r1"/></sheets></workbook>';
    const parsed = await parseXlsx(
      fixture(
        '<worksheet><sheetData><row><c s="1"><v>0</v></c></row></sheetData></worksheet>',
        workbook
      )
    );
    expect(parsed.ok && parsed.workbook.sheets[0]!.texts[0]).toBe('1904-01-01');
    expect(
      await parseXlsx(fixture('<!DOCTYPE worksheet><worksheet/>'))
    ).toEqual({ ok: false, reason: 'corrupt' });
  });
  test('refuses oversized sheet without refusing workbook', async () => {
    const parsed = await parseXlsx(
      fixture(
        '<worksheet><sheetData><row r="600001"><c r="A600001"><v>1</v></c></row></sheetData></worksheet>'
      )
    );
    expect(parsed.ok && parsed.workbook.sheets[0]!.refused).toBe('too-large');
  });
  test('rejects duplicate sheet names ignoring case', async () => {
    const workbook =
      '<workbook><sheets><sheet name="Sales" r:id="r1"/><sheet name="sales" r:id="r1"/></sheets></workbook>';
    expect(await parseXlsx(fixture('<worksheet/>', workbook))).toEqual({
      ok: false,
      reason: 'corrupt',
    });
  });
  test('resolves shared formulas and preserves array formulas', async () => {
    const result = await parseXlsx(
      fixture(
        '<worksheet><sheetData><row r="1"><c r="B1"><f t="shared" si="0">A1+$A$1+LOG10(A1)+&quot;A1&quot;</f><v>1</v></c><c r="C1"><f t="shared" si="0"/><v>2</v></c><c r="D1"><f t="array" ref="D1:D2">SUM(A1:A2)</f><v>3</v></c></row></sheetData></worksheet>'
      )
    );
    if (!result.ok) throw new Error(result.reason);
    const sheet = result.workbook.sheets[0]!;
    expect(sheet.details[sheet.cells[5]! - 1]).toEqual({
      type: 'number',
      formula: 'B1+$A$1+LOG10(B1)+"A1"',
      sharedFrom: 'B1',
    });
    expect(sheet.details[sheet.cells[8]! - 1]?.formula).toBe('SUM(A1:A2)');
  });
  test('refuses XML entities and workbooks with more than 256 sheets', async () => {
    expect(
      await parseXlsx(fixture('<!ENTITY injected "x"><worksheet/>'))
    ).toEqual({ ok: false, reason: 'corrupt' });
    const sheets = Array.from(
      { length: 257 },
      (_, i) => `<sheet name="S${i}" r:id="r1"/>`
    ).join('');
    expect(
      await parseXlsx(
        fixture(
          '<worksheet/>',
          `<workbook><sheets>${sheets}</sheets></workbook>`
        )
      )
    ).toEqual({ ok: false, reason: 'too-large' });
  });
  test('preserves hidden and chart sheet metadata and isolates an oversized sheet', async () => {
    const book =
      '<workbook><sheets><sheet name="Too big" r:id="r1"/><sheet name="Hidden" state="hidden" r:id="r4"/><sheet name="Chart" state="veryHidden" r:id="r5"/></sheets></workbook>';
    const rels =
      '<Relationships><Relationship Id="r1" Type="urn:office/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r4" Type="urn:office/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="r5" Type="urn:office/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>';
    const parsed = await parseXlsx(
      fixture(
        '<worksheet><sheetData><row r="600001"/></sheetData></worksheet>',
        book,
        {
          'xl/_rels/workbook.xml.rels': rels,
          'xl/worksheets/sheet2.xml':
            '<worksheet><sheetData><row r="1"><c r="A1"><v>9</v></c></row></sheetData></worksheet>',
        }
      )
    );
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(
      parsed.workbook.sheets.map((s) => [s.name, s.state, s.kind, s.refused])
    ).toEqual([
      ['Too big', 'visible', 'worksheet', 'too-large'],
      ['Hidden', 'hidden', 'worksheet', undefined],
      ['Chart', 'veryHidden', 'chartsheet', undefined],
    ]);
    expect(parsed.workbook.sheets[1]!.texts).toEqual(['9']);
  });
  test('rejects a ZIP entry claiming more than the expanded size limit', async () => {
    const bytes = fixture('<worksheet/>');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const directory = view.getUint32(bytes.length - 6, true);
    view.setUint16(directory + 10, 8, true);
    view.setUint32(directory + 24, 100 * 1024 * 1024 + 1, true);
    expect(await parseXlsx(bytes)).toEqual({ ok: false, reason: 'too-large' });
  });
  test('enforces the remaining global cell budget across sheets', () => {
    expect(() =>
      parseWorksheet(
        '<worksheet><sheetData><row><c><v>1</v></c><c><v>2</v></c></row></sheetData></worksheet>',
        {
          name: 'S',
          state: 'visible',
          sharedStrings: [],
          styles: [],
          date1904: false,
          remaining: 1,
        }
      )
    ).toThrow('too-large');
  });
  test('rejects archives beyond the file and entry-count caps', async () => {
    expect(await parseXlsx(new Uint8Array(100 * 1024 * 1024 + 1))).toEqual({
      ok: false,
      reason: 'too-large',
    });
    const files: Record<string, string> = {};
    for (let i = 0; i < 10001; i++) files[`part${i}`] = '';
    expect(await parseXlsx(zip(files))).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });
  test('rejects more than two million shared strings', async () => {
    const shared = `<sst>${'<si/>'.repeat(2_000_001)}</sst>`;
    expect(
      await parseXlsx(
        fixture('<worksheet/>', undefined, { 'xl/sharedStrings.xml': shared })
      )
    ).toEqual({ ok: false, reason: 'too-large' });
  }, 30000);
  test('accepts openpyxl-style permission bits without Unix file-type bits', async () => {
    const bytes = fixture(
      '<worksheet><sheetData><row><c><v>42</v></c></row></sheetData></worksheet>'
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = view.getUint32(bytes.length - 6, true);
    const count = view.getUint16(bytes.length - 12, true);
    for (let i = 0; i < count; i++) {
      view.setUint16(at + 4, (3 << 8) | 20, true);
      view.setUint32(at + 38, 0o600 << 16, true);
      at +=
        46 +
        view.getUint16(at + 28, true) +
        view.getUint16(at + 30, true) +
        view.getUint16(at + 32, true);
    }
    const parsed = await parseXlsx(bytes);
    expect(parsed.ok && parsed.workbook.sheets[0]!.texts).toEqual(['42']);
  });
});
