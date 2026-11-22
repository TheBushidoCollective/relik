import { describe, expect, test } from 'bun:test';
import { crc32 } from './zip-index.ts';
import { planStoredZip } from './zip-write.ts';
import { parseXlsx } from './xlsx.ts';
import {
  CELL_KIND,
  compareWorkbooks,
  XLSX_COMPARE_CELL_LIMIT,
  XLSX_COMPARE_MAX_BYTES,
  XLSX_LISTED_CELL_CHANGES,
  XLSX_LISTED_TEXT_CHARS,
  type WorkbookComparison,
} from './xlsx-diff.ts';

const SPREADSHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIPS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A cell: its text, a number, a formula with its cached value, or raw cell XML. */
type CellSpec =
  | string
  | number
  | { readonly f: string; readonly v: number }
  | { readonly xml: string };

interface SheetFixture {
  readonly name: string;
  /** The raw `sheetId` attribute, so a test can write an invalid value. */
  readonly sheetId?: string;
  readonly state?: 'visible' | 'hidden';
  readonly cells?: Readonly<Record<string, CellSpec>>;
  readonly chart?: boolean;
}

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

function xmlEscape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function columnIndex(letters: string): number {
  let n = 0;
  for (const letter of letters) n = n * 26 + letter.charCodeAt(0) - 64;
  return n - 1;
}

function cellXml(ref: string, spec: CellSpec): string {
  if (typeof spec === 'string')
    return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(spec)}</t></is></c>`;
  if (typeof spec === 'number') return `<c r="${ref}"><v>${spec}</v></c>`;
  if ('xml' in spec) return `<c r="${ref}">${spec.xml}</c>`;
  return `<c r="${ref}"><f>${xmlEscape(spec.f)}</f><v>${spec.v}</v></c>`;
}

function sheetXml(cells: Readonly<Record<string, CellSpec>>): string {
  const rows = new Map<number, [number, string, CellSpec][]>();
  for (const [ref, spec] of Object.entries(cells)) {
    const match = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!match) throw new Error(`bad reference ${ref}`);
    const row = Number(match[2]);
    rows.set(row, [
      ...(rows.get(row) ?? []),
      [columnIndex(match[1]!), ref, spec],
    ]);
  }
  const body = [...rows.keys()]
    .sort((a, b) => a - b)
    .map((row) => {
      const inRow = rows.get(row)!.sort((a, b) => a[0] - b[0]);
      return `<row r="${row}">${inRow
        .map(([, ref, spec]) => cellXml(ref, spec))
        .join('')}</row>`;
    })
    .join('');
  return `<worksheet xmlns="${SPREADSHEET}"><sheetData>${body}</sheetData></worksheet>`;
}

function workbookBytes(sheets: readonly SheetFixture[]): Uint8Array {
  const files: Record<string, string> = {};
  const entries: string[] = [];
  const relations: string[] = [];
  sheets.forEach((sheet, i) => {
    const n = i + 1;
    const id = `rId${n}`;
    const attributes = [
      `name="${xmlEscape(sheet.name)}"`,
      sheet.sheetId === undefined ? '' : `sheetId="${sheet.sheetId}"`,
      sheet.state === undefined ? '' : `state="${sheet.state}"`,
    ].filter((attribute) => attribute !== '');
    entries.push(`<sheet ${attributes.join(' ')} r:id="${id}"/>`);
    if (sheet.chart) {
      relations.push(
        `<Relationship Id="${id}" Type="${RELATIONSHIPS}/chartsheet" Target="chartsheets/sheet${n}.xml"/>`
      );
      files[`xl/chartsheets/sheet${n}.xml`] = '<chartsheet/>';
    } else {
      relations.push(
        `<Relationship Id="${id}" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet${n}.xml"/>`
      );
      files[`xl/worksheets/sheet${n}.xml`] = sheetXml(sheet.cells ?? {});
    }
  });
  files['xl/workbook.xml'] =
    `<workbook xmlns="${SPREADSHEET}" xmlns:r="${RELATIONSHIPS}"><sheets>${entries.join('')}</sheets></workbook>`;
  files['xl/_rels/workbook.xml.rels'] =
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relations.join('')}</Relationships>`;
  return zip(files);
}

async function compare(
  before: readonly SheetFixture[],
  after: readonly SheetFixture[],
  options?: { readonly onWalk?: () => void }
): Promise<WorkbookComparison> {
  const [parsedBefore, parsedAfter] = await Promise.all([
    parseXlsx(workbookBytes(before)),
    parseXlsx(workbookBytes(after)),
  ]);
  if (!parsedBefore.ok || !parsedAfter.ok) throw new Error('fixture refused');
  return compareWorkbooks(parsedBefore.workbook, parsedAfter.workbook, options);
}

/** Version 1 of the B5 spec fixture: Q3, Old data and Hidden. */
const QUARTER_V1: SheetFixture[] = [
  {
    name: 'Q3',
    sheetId: '1',
    cells: {
      A1: 'Region',
      B1: 'Plan',
      A2: 'West',
      B2: 1000,
      E2: { f: 'SUM(B2:C3)', v: 2200 },
      A3: 'East',
      C3: 1200,
      E3: { f: 'B2*2', v: 2000 },
      B7: 'Draft note',
    },
  },
  { name: 'Old data', sheetId: '2', cells: { A1: 'Legacy' } },
  { name: 'Hidden', sheetId: '3', state: 'hidden', cells: { A1: 'x' } },
];

/** Version 2 of the B5 spec fixture: Q3 renamed to Q3 budget, Summary added. */
const QUARTER_V2: SheetFixture[] = [
  {
    name: 'Q3 budget',
    sheetId: '1',
    cells: {
      A1: 'Region',
      B1: 'Plan',
      A2: 'West',
      B2: 1000,
      E2: { f: 'SUM(B2:C3)*1', v: 2250 },
      A3: 'East',
      C3: 1250,
      E3: { f: 'B2+B2', v: 2000 },
      D5: 'Total',
    },
  },
  { name: 'Hidden', sheetId: '3', state: 'hidden', cells: { A1: 'y' } },
  { name: 'Summary', sheetId: '4', cells: { A1: 'Totals' } },
];

function numbered(
  count: number,
  value: (row: number) => CellSpec
): Record<string, CellSpec> {
  const cells: Record<string, CellSpec> = {};
  for (let row = 1; row <= count; row++) cells[`A${row}`] = value(row);
  return cells;
}

describe('XLSX compare constants', () => {
  test('match the spec limits and the viewer ceiling', () => {
    expect(XLSX_COMPARE_CELL_LIMIT).toBe(2_000_000);
    expect(XLSX_COMPARE_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(XLSX_LISTED_CELL_CHANGES).toBe(200);
    expect(XLSX_LISTED_TEXT_CHARS).toBe(160);
    expect(CELL_KIND).toEqual({ added: 1, removed: 2, changed: 3, formula: 4 });
  });
});

describe('XLSX workbook comparison', () => {
  test('gives the exact counts and statuses of the B5 fixture', async () => {
    const comparison = await compare(QUARTER_V1, QUARTER_V2);
    expect(comparison.changed).toBe(true);
    expect(comparison.cells).toEqual({ added: 1, removed: 1, changed: 4 });
    expect([
      comparison.sheetsAdded,
      comparison.sheetsRemoved,
      comparison.sheetsRenamed,
      comparison.sheetsHidden,
      comparison.sheetsShown,
    ]).toEqual([1, 1, 1, 0, 0]);
    expect(
      comparison.sheets.map((sheet) => [
        sheet.status,
        sheet.before,
        sheet.after,
      ])
    ).toEqual([
      ['changed', 0, 0],
      ['changed', 2, 1],
      ['added', undefined, 2],
      ['removed', 1, undefined],
    ]);
  });

  test('describes the renamed sheet with row-major positions and listed changes', async () => {
    const q3 = (await compare(QUARTER_V1, QUARTER_V2)).sheets[0]!;
    expect(q3.renamedFrom).toBe('Q3');
    expect(q3.state).toEqual({ before: 'visible', after: 'visible' });
    expect([q3.added, q3.removed, q3.changed, q3.formula]).toEqual([
      1, 1, 2, 1,
    ]);
    expect(Array.from(q3.positions)).toEqual([
      1, 4, 3, 2, 2, 3, 2, 4, 4, 4, 3, 1, 6, 1, 2,
    ]);
    expect(q3.positions.length / 3).toBe(5);
    expect(q3.listed).toEqual([
      { row: 1, col: 4, kind: 'changed', before: '2200', after: '2250' },
      { row: 2, col: 2, kind: 'changed', before: '1200', after: '1250' },
      { row: 2, col: 4, kind: 'formula', before: '=B2*2', after: '=B2+B2' },
      { row: 4, col: 3, kind: 'added', before: '', after: 'Total' },
      { row: 6, col: 1, kind: 'removed', before: 'Draft note', after: '' },
    ]);
  });

  test('reports the hidden sheet that stayed hidden as changed, not as hidden or shown', async () => {
    const hidden = (await compare(QUARTER_V1, QUARTER_V2)).sheets[1]!;
    expect(hidden.state).toEqual({ before: 'hidden', after: 'hidden' });
    expect([hidden.changed, hidden.formula]).toEqual([1, 0]);
    expect(Array.from(hidden.positions)).toEqual([0, 0, 3]);
  });

  test('a sheet only in one version is added or removed with no cells', async () => {
    const comparison = await compare(QUARTER_V1, QUARTER_V2);
    const summary = comparison.sheets[2]!;
    const old = comparison.sheets[3]!;
    expect(summary).toMatchObject({ status: 'added', after: 2, added: 0 });
    expect(summary.state).toBeUndefined();
    expect(old).toMatchObject({ status: 'removed', before: 1 });
    expect(old.positions.length).toBe(0);
    expect(old.listed).toEqual([]);
  });

  test('identical versions report no change and no cells', async () => {
    const comparison = await compare(QUARTER_V1, QUARTER_V1);
    expect(comparison.changed).toBe(false);
    expect(comparison.cells).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(comparison.sheets.map((sheet) => sheet.status)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
    expect(
      comparison.sheets.every((sheet) => sheet.positions.length === 0)
    ).toBe(true);
  });

  test('a reused sheetId with under half of its cells unchanged is removed plus added', async () => {
    const before = [
      { name: 'Alpha', sheetId: '7', cells: numbered(10, (r) => `a${r}`) },
    ];
    const after = [
      {
        name: 'Beta',
        sheetId: '7',
        cells: numbered(10, (r) => (r <= 4 ? `a${r}` : `z${r}`)),
      },
    ];
    const comparison = await compare(before, after);
    expect(
      comparison.sheets.map((sheet) => [
        sheet.status,
        sheet.before,
        sheet.after,
      ])
    ).toEqual([
      ['added', undefined, 0],
      ['removed', 0, undefined],
    ]);
    expect([
      comparison.sheetsAdded,
      comparison.sheetsRemoved,
      comparison.sheetsRenamed,
    ]).toEqual([1, 1, 0]);
  });

  test('a reused sheetId with exactly half of its cells unchanged reads as a rename', async () => {
    const before = [
      { name: 'Alpha', sheetId: '7', cells: numbered(10, (r) => `a${r}`) },
    ];
    const after = [
      {
        name: 'Beta',
        sheetId: '7',
        cells: numbered(10, (r) => (r <= 5 ? `a${r}` : `z${r}`)),
      },
    ];
    const comparison = await compare(before, after);
    const beta = comparison.sheets[0]!;
    expect(beta).toMatchObject({
      status: 'changed',
      renamedFrom: 'Alpha',
      changed: 5,
    });
    expect(comparison.sheetsRenamed).toBe(1);
    expect(comparison.sheetsAdded).toBe(0);
  });

  test('a case-only name change reads as renamed with no cell changes', async () => {
    const cells = { A1: 'same', B1: 2 };
    const comparison = await compare(
      [{ name: 'Summary', cells }],
      [{ name: 'summary', cells }]
    );
    expect(comparison.sheets[0]).toMatchObject({
      status: 'changed',
      renamedFrom: 'Summary',
      before: 0,
      after: 0,
    });
    expect(comparison.cells).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(comparison.sheetsRenamed).toBe(1);
    expect(comparison.changed).toBe(true);
  });

  test('a sheet without a sheetId pairs only by name', async () => {
    const cells = numbered(4, (r) => `v${r}`);
    const comparison = await compare(
      [{ name: 'Alpha', cells }],
      [{ name: 'Beta', cells }]
    );
    expect(comparison.sheets.map((sheet) => sheet.status)).toEqual([
      'added',
      'removed',
    ]);
    expect(comparison.sheetsRenamed).toBe(0);
  });

  test('an invalid sheetId never pairs sheets', async () => {
    const cells = numbered(4, (r) => `v${r}`);
    const comparison = await compare(
      [{ name: 'Alpha', sheetId: '0', cells }],
      [{ name: 'Beta', sheetId: '0', cells }]
    );
    expect(comparison.sheetsRenamed).toBe(0);
    expect(comparison.sheetsAdded).toBe(1);
    expect(comparison.sheetsRemoved).toBe(1);
  });

  test('charts and sheets past 600,000 rows are not compared', async () => {
    const big = (value: number) => ({
      name: 'Big',
      cells: { A600001: value },
    });
    const same = await compare(
      [{ name: 'Chart', chart: true }, big(1)],
      [{ name: 'Chart', chart: true }, big(1)]
    );
    expect(same.changed).toBe(false);
    expect(same.sheets).toMatchObject([
      {
        status: 'not-compared',
        notCompared: 'chartsheet',
        before: 0,
        after: 0,
      },
      { status: 'not-compared', notCompared: 'too-large', before: 1, after: 1 },
    ]);
    const lone = await compare(
      [{ name: 'Main', cells: { A1: 'x' } }],
      [
        { name: 'Main', cells: { A1: 'x' } },
        { name: 'Chart2', chart: true },
      ]
    );
    expect(lone.sheets).toMatchObject([
      { status: 'unchanged', before: 0, after: 0 },
      { status: 'added', notCompared: 'chartsheet', after: 1 },
    ]);
    expect(lone.sheetsAdded).toBe(1);
    expect(lone.changed).toBe(true);
  });

  test('lists at most 200 changes in row-major order, all positioned', async () => {
    const before = [
      {
        name: 'Grid',
        sheetId: '1',
        cells: numbered(250, (r) => r),
      },
    ];
    const after = [
      {
        name: 'Grid',
        sheetId: '1',
        cells: numbered(250, (r) => r + 1),
      },
    ];
    const grid = (await compare(before, after)).sheets[0]!;
    expect(grid.changed).toBe(250);
    expect(grid.listed.length).toBe(XLSX_LISTED_CELL_CHANGES);
    expect(grid.listed[0]).toEqual({
      row: 0,
      col: 0,
      kind: 'changed',
      before: '1',
      after: '2',
    });
    expect(grid.listed[199]!.row).toBe(199);
    expect(grid.positions.length).toBe(250 * 3);
    const triples = Array.from({ length: 250 }, (_, k) => [
      grid.positions[k * 3],
      grid.positions[k * 3 + 1],
      grid.positions[k * 3 + 2],
    ]);
    expect(triples).toEqual(
      Array.from({ length: 250 }, (_, k) => [k, 0, CELL_KIND.changed])
    );
  });

  test('cuts listed text to 160 code points without splitting a surrogate pair', async () => {
    const emoji = '\u{1F600}';
    const comparison = await compare(
      [
        {
          name: 'Text',
          cells: {
            A1: 'a'.repeat(300),
            B1: 'x'.repeat(160),
            C1: emoji.repeat(200),
          },
        },
      ],
      [
        {
          name: 'Text',
          cells: { A1: 'b'.repeat(300), B1: 'x'.repeat(160), C1: 'z' },
        },
      ]
    );
    const [first, second] = comparison.sheets[0]!.listed;
    expect(comparison.sheets[0]!.listed.length).toBe(2);
    expect(first).toEqual({
      row: 0,
      col: 0,
      kind: 'changed',
      before: `${'a'.repeat(160)}…`,
      after: `${'b'.repeat(160)}…`,
    });
    expect(second).toEqual({
      row: 0,
      col: 2,
      kind: 'changed',
      before: `${emoji.repeat(160)}…`,
      after: 'z',
    });
  });

  test('lists a change past the 256 drawn columns but never positions it', async () => {
    const comparison = await compare(
      [{ name: 'Wide', cells: { IV1: 'a' } }],
      [{ name: 'Wide', cells: { IV1: 'b', IW1: 'c' } }]
    );
    const wide = comparison.sheets[0]!;
    expect([wide.added, wide.changed]).toEqual([1, 1]);
    expect(Array.from(wide.positions)).toEqual([0, 255, CELL_KIND.changed]);
    expect(wide.listed).toEqual([
      { row: 0, col: 255, kind: 'changed', before: 'a', after: 'b' },
      { row: 0, col: 256, kind: 'added', before: '', after: 'c' },
    ]);
  });

  test('compares formulas as text and reports a formula-only change', async () => {
    const comparison = await compare(
      [{ name: 'F', cells: { A1: { f: 'SUM(1,2)', v: 3 } } }],
      [{ name: 'F', cells: { A1: { f: 'SUM(2,1)', v: 3 } } }]
    );
    expect(comparison.cells).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(comparison.sheets[0]).toMatchObject({ changed: 0, formula: 1 });
    expect(comparison.sheets[0]!.listed).toEqual([
      {
        row: 0,
        col: 0,
        kind: 'formula',
        before: '=SUM(1,2)',
        after: '=SUM(2,1)',
      },
    ]);
  });

  test('a shared formula that names another master reads as a formula change', async () => {
    const comparison = await compare(
      [
        {
          name: 'Shared',
          cells: {
            A1: { xml: '<f t="shared" ref="A1:A2" si="0">B1*2</f><v>4</v>' },
            A2: { xml: '<f t="shared" si="0"/><v>4</v>' },
            B1: 2,
          },
        },
      ],
      [
        {
          name: 'Shared',
          cells: {
            A1: { xml: '<f>B1*2</f><v>4</v>' },
            A2: { xml: '<f t="shared" ref="A2:A2" si="0">B1*2</f><v>4</v>' },
            B1: 2,
          },
        },
      ]
    );
    expect(comparison.cells).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(comparison.sheets[0]!.listed).toEqual([
      {
        row: 1,
        col: 0,
        kind: 'formula',
        before: '=B1*2 (shared from A1)',
        after: '=B1*2',
      },
    ]);
  });
});

describe('XLSX sheet pairing and lone sheets', () => {
  test('a lone chartsheet or oversize sheet keeps its added or removed status', async () => {
    const comparison = await compare(
      [
        { name: 'Keep', cells: { A1: 'x' } },
        { name: 'Old chart', chart: true },
        { name: 'Long', cells: { A600001: 'end' } },
      ],
      [
        { name: 'Keep', cells: { A1: 'x' } },
        { name: 'New chart', chart: true },
      ]
    );
    expect(comparison.sheets.slice(1)).toMatchObject([
      { status: 'added', notCompared: 'chartsheet', after: 1, added: 0 },
      { status: 'removed', notCompared: 'chartsheet', before: 1 },
      { status: 'removed', notCompared: 'too-large', before: 2 },
    ]);
    expect(
      comparison.sheets.every((sheet) => sheet.positions.length === 0)
    ).toBe(true);
    expect([comparison.sheetsAdded, comparison.sheetsRemoved]).toEqual([1, 2]);
  });

  test('a sheetId that two sheets share pairs with neither, in either version', async () => {
    const cells = numbered(10, (r) => `v${r}`);
    const shared = await compare(
      [
        { name: 'Alpha', sheetId: '5', cells },
        { name: 'Beta', sheetId: '5', cells },
      ],
      [{ name: 'Gamma', sheetId: '5', cells }]
    );
    expect(shared.sheetsRenamed).toBe(0);
    expect(shared.sheets.map((sheet) => sheet.status)).toEqual([
      'added',
      'removed',
      'removed',
    ]);
    const duplicated = await compare(
      [{ name: 'Alpha', sheetId: '5', cells }],
      [
        { name: 'Gamma', sheetId: '5', cells },
        { name: 'Delta', sheetId: '5', cells },
      ]
    );
    expect(duplicated.sheetsRenamed).toBe(0);
    expect(duplicated.sheets.map((sheet) => sheet.status)).toEqual([
      'added',
      'added',
      'removed',
    ]);
  });

  test('many sheets that share one sheetId do no walks of cells', async () => {
    const before = Array.from({ length: 200 }, (_, n) => ({
      name: `Before ${n}`,
      sheetId: '1',
      cells: numbered(20, (r) => `b${n}-${r}`),
    }));
    const after = Array.from({ length: 200 }, (_, n) => ({
      name: `After ${n}`,
      sheetId: '1',
      cells: numbered(20, (r) => `a${n}-${r}`),
    }));
    let walks = 0;
    const comparison = await compare(before, after, {
      onWalk: () => {
        walks++;
      },
    });
    expect(walks).toBe(0);
    expect([
      comparison.sheetsAdded,
      comparison.sheetsRemoved,
      comparison.sheetsRenamed,
    ]).toEqual([200, 200, 0]);
  });

  test('a sheetId unique in both versions costs one trial walk and one full walk per sheet', async () => {
    const cells = numbered(12, (r) => `v${r}`);
    const count = 64;
    let walks = 0;
    const comparison = await compare(
      Array.from({ length: count }, (_, n) => ({
        name: `Old ${n}`,
        sheetId: String(n + 1),
        cells,
      })),
      Array.from({ length: count }, (_, n) => ({
        name: `New ${n}`,
        sheetId: String(n + 1),
        cells,
      })),
      {
        onWalk: () => {
          walks++;
        },
      }
    );
    expect(comparison.sheetsRenamed).toBe(count);
    expect(walks).toBe(2 * count);
  });

  test('a rename needs half of the larger sheet unchanged, rounded up', async () => {
    const before = [
      { name: 'Alpha', sheetId: '9', cells: numbered(9, (r) => `a${r}`) },
    ];
    const enough = await compare(before, [
      {
        name: 'Beta',
        sheetId: '9',
        cells: numbered(9, (r) => (r <= 5 ? `a${r}` : `z${r}`)),
      },
    ]);
    const short = await compare(before, [
      {
        name: 'Beta',
        sheetId: '9',
        cells: numbered(9, (r) => (r <= 4 ? `a${r}` : `z${r}`)),
      },
    ]);
    expect(enough.sheetsRenamed).toBe(1);
    expect(short.sheetsRenamed).toBe(0);
  });

  test('a rename whose unchanged cells come last still pairs', async () => {
    const comparison = await compare(
      [{ name: 'Alpha', sheetId: '3', cells: numbered(10, (r) => `a${r}`) }],
      [
        {
          name: 'Beta',
          sheetId: '3',
          cells: numbered(10, (r) => (r <= 5 ? `z${r}` : `a${r}`)),
        },
      ]
    );
    expect(comparison.sheets[0]).toMatchObject({
      status: 'changed',
      renamedFrom: 'Alpha',
      changed: 5,
    });
  });
});
