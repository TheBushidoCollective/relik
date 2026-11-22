import { describe, expect, test } from 'bun:test';
import type { CellCommentAnchor } from '@relic/format';
import { resolutionLine } from '../src/server.ts';
import { resolveWorkbookCell } from '../src/resolve-workbook.ts';
import type { CellResolution } from '../src/resolve-structured.ts';
import { jsonLine } from '../src/untrusted-text.ts';
import { type FixtureEntry, zipFixture } from './zip-fixture.ts';

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS =
  'http://schemas.openxmlformats.org/package/2006/relationships';

interface SheetSpec {
  readonly name: string;
  readonly rows?: string;
  readonly chart?: boolean;
}

const row = (index: number, cells: string): string =>
  `<row r="${index}">${cells}</row>`;
const text = (ref: string, value: string): string =>
  `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
const number = (ref: string, value: number): string =>
  `<c r="${ref}"><v>${value}</v></c>`;
const worksheet = (rows: string): string =>
  `<worksheet xmlns="${SHEET_NS}"><sheetData>${rows}</sheetData></worksheet>`;

/** A workbook whose sheet parts are deflated, as Excel writes them. */
function workbook(
  sheets: readonly SheetSpec[],
  extra: readonly FixtureEntry[] = []
): Uint8Array {
  const entries: FixtureEntry[] = [
    { name: '[Content_Types].xml', text: '<Types/>' },
    {
      name: 'xl/workbook.xml',
      text: `<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>${sheets
        .map(
          (sheet, index) =>
            `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
        )
        .join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text: `<Relationships xmlns="${PACKAGE_REL_NS}">${sheets
        .map(
          (sheet, index) =>
            `<Relationship Id="rId${index + 1}" Type="${REL_NS}/${sheet.chart === true ? 'chartsheet' : 'worksheet'}" Target="${sheet.chart === true ? 'chartsheets' : 'worksheets'}/sheet${index + 1}.xml"/>`
        )
        .join('')}</Relationships>`,
    },
  ];
  sheets.forEach((sheet, index) => {
    entries.push(
      sheet.chart === true
        ? {
            name: `xl/chartsheets/sheet${index + 1}.xml`,
            text: '<chartsheet/>',
          }
        : {
            name: `xl/worksheets/sheet${index + 1}.xml`,
            text: worksheet(sheet.rows ?? ''),
            deflate: true,
          }
    );
  });
  return zipFixture([...entries, ...extra]);
}

const budgetRows =
  row(1, text('A1', 'Item') + text('C1', 'Q3')) +
  row(14, text('A14', 'Travel') + number('C14', 1200) + text('D14', 'over')) +
  row(15, number('C15', 80));
const budget = [{ name: 'Q3 budget', rows: budgetRows }];

function cell(
  row: number,
  col: number,
  extra: Partial<CellCommentAnchor> = {},
  sheet: string | undefined = 'Q3 budget'
): CellCommentAnchor {
  return {
    kind: 'cell',
    row,
    col,
    ...(sheet === undefined ? {} : { sheet }),
    ...extra,
  } as CellCommentAnchor;
}

describe('cell anchors on spreadsheets', () => {
  test('a cell reports its sheet, its A1 address, its value and the first row above it', async () => {
    const resolved = await resolveWorkbookCell(workbook(budget), cell(14, 3));
    expect(resolved).toEqual({
      kind: 'cell',
      status: 'resolved',
      sheet: 'Q3 budget',
      address: 'C14',
      text: '1200',
      text_truncated: false,
      header: 'Q3',
      header_truncated: false,
    });
  });

  test('a range reports its top-left value and the inclusive extent', async () => {
    const resolved = await resolveWorkbookCell(
      workbook(budget),
      cell(14, 3, { row_end: 15, col_end: 4 })
    );
    expect(resolved).toMatchObject({
      status: 'resolved',
      address: 'C14',
      text: '1200',
      range: { row_end: 15, col_end: 4 },
    });
  });

  test('a cell on a later sheet is read from that sheet, by its name', async () => {
    const book = workbook([
      { name: 'First', rows: row(2, text('B2', 'alpha')) },
      { name: 'Second', rows: row(2, text('B2', 'beta')) },
    ]);
    expect(
      await resolveWorkbookCell(book, cell(2, 2, {}, 'Second'))
    ).toMatchObject({ sheet: 'Second', address: 'B2', text: 'beta' });
    expect(
      await resolveWorkbookCell(book, cell(2, 2, {}, 'First'))
    ).toMatchObject({ sheet: 'First', text: 'alpha' });
  });

  test('a formula reports the value the file caches, and a formula with no cached value reports nothing', async () => {
    const book = workbook([
      {
        name: 'Calc',
        rows: row(
          2,
          `<c r="C2"><f>1+1</f><v>7</v></c><c r="D2"><f>SUM(A1:A2)</f></c>`
        ),
      },
    ]);
    expect(
      await resolveWorkbookCell(book, cell(2, 3, {}, 'Calc'))
    ).toMatchObject({ status: 'resolved', text: '7' });
    expect(
      await resolveWorkbookCell(book, cell(2, 4, {}, 'Calc'))
    ).toMatchObject({ status: 'resolved', text: '' });
  });

  test('an external relationship is never followed, and the cell still resolves from the workbook', async () => {
    const book = workbook(budget, [
      {
        name: 'xl/externalLinks/_rels/externalLink1.xml.rels',
        text: `<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId9" Type="${REL_NS}/externalLinkPath" Target="https://example.invalid/budget.xlsx" TargetMode="External"/></Relationships>`,
      },
    ]);
    expect(await resolveWorkbookCell(book, cell(14, 3))).toMatchObject({
      status: 'resolved',
      text: '1200',
    });
  });

  test('a comment that names no sheet is not found on a spreadsheet', async () => {
    expect(
      await resolveWorkbookCell(workbook(budget), {
        kind: 'cell',
        row: 14,
        col: 3,
      })
    ).toEqual({
      kind: 'cell',
      status: 'unresolvable',
      explanation:
        'The cell is not found in this version: a cell on a spreadsheet names its sheet, and this one does not.',
    });
  });

  test('a sheet the workbook does not hold is not found, and its name prints JSON-encoded', async () => {
    const resolved = await resolveWorkbookCell(
      workbook(budget),
      cell(14, 3, {}, 'Q3\nbudget')
    );
    expect(resolved).toMatchObject({
      status: 'unresolvable',
      explanation: `The cell is not found in this version: this workbook has no sheet named ${jsonLine('Q3\nbudget')}.`,
    });
  });

  test('a row or column past the used range is not found', async () => {
    const past = await resolveWorkbookCell(workbook(budget), cell(99, 1));
    expect(past).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining(
        'row 99 is past the last row of sheet "Q3 budget", which has 15 row(s)'
      ),
    });
    const wide = await resolveWorkbookCell(workbook(budget), cell(1, 9));
    expect(wide).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining('column 9 is past the last column'),
    });
  });

  test('a range that runs past the sheet, or ends before it starts, is not found', async () => {
    const past = await resolveWorkbookCell(
      workbook(budget),
      cell(14, 3, { row_end: 40, col_end: 3 })
    );
    expect(past).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining('the range runs to row 40'),
    });
    const backwards = await resolveWorkbookCell(
      workbook(budget),
      cell(14, 3, { row_end: 13, col_end: 3 })
    );
    expect(backwards).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining('ends before it starts'),
    });
  });

  test('a chart sheet has no cells to resolve', async () => {
    const book = workbook([{ name: 'Chart', chart: true }]);
    expect(
      await resolveWorkbookCell(book, cell(1, 1, {}, 'Chart'))
    ).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining(
        'is a chart sheet, which has no cells'
      ),
    });
  });

  test('a sheet with more rows than the viewer reads is refused rather than partly read', async () => {
    const book = workbook([
      { name: 'Long', rows: row(600_001, text('A600001', 'late')) },
    ]);
    expect(
      await resolveWorkbookCell(book, cell(1, 1, {}, 'Long'))
    ).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining(
        'has more than 600000 rows, so its cells are not read'
      ),
    });
  });

  test('a file that is not a readable workbook is refused with the reason', async () => {
    const broken = zipFixture([
      { name: '[Content_Types].xml', text: '<Types/>' },
      { name: 'xl/workbook.xml', text: '<workbook>' },
    ]);
    expect(await resolveWorkbookCell(broken, cell(1, 1))).toEqual({
      kind: 'cell',
      status: 'unresolvable',
      explanation:
        'The cell is not found in this version: the spreadsheet cannot be read.',
    });
  });

  test('a resolved workbook cell prints its sheet, address and value on one transcript line', () => {
    const line = resolutionLine({
      kind: 'cell',
      status: 'resolved',
      sheet: 'Q3 budget',
      address: 'C14',
      text: '1200',
      text_truncated: false,
      header: 'Q3',
      header_truncated: false,
      range: { row_end: 15, col_end: 4 },
    } as CellResolution);
    expect(line).toBe(
      '[Resolution: cell text "1200"; column header "Q3"; sheet "Q3 budget", cell C14; range to D15]\n'
    );
  });
});
