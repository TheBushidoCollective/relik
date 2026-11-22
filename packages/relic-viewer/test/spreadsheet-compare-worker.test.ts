import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import {
  type WorkbookComparison,
  XLSX_COMPARE_CELL_LIMIT,
  XLSX_COMPARE_MAX_BYTES,
  XLSX_LISTED_CELL_CHANGES,
  XLSX_LISTED_TEXT_CHARS,
} from '@relic/format/xlsx-diff';
import { MAX_DIFF_BYTES } from '../src/diff.ts';
import { answer } from '../src/spreadsheet-parse-worker.ts';

const SPREADSHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIPS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

type Reply =
  | {
      readonly ok: true;
      readonly before: {
        readonly sheets: readonly { readonly name: string }[];
      };
      readonly after: unknown;
      readonly comparison: WorkbookComparison;
    }
  | {
      readonly ok: false;
      readonly side: 'before' | 'after';
      readonly reason: string;
    };

/** One sheet named Sheet1, with rows of text or numbers, row 1 first. */
async function workbook(
  rows: readonly (readonly (string | number)[])[]
): Promise<ArrayBuffer> {
  const body = rows
    .map(
      (cells, r) =>
        `<row r="${r + 1}">${cells
          .map((cell, c) => {
            const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
            return typeof cell === 'number'
              ? `<c r="${ref}"><v>${cell}</v></c>`
              : `<c r="${ref}" t="inlineStr"><is><t>${cell}</t></is></c>`;
          })
          .join('')}</row>`
    )
    .join('');
  const zip = new JSZip();
  zip.file(
    'xl/workbook.xml',
    `<workbook xmlns="${SPREADSHEET}" xmlns:r="${RELATIONSHIPS}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<worksheet xmlns="${SPREADSHEET}"><sheetData>${body}</sheetData></worksheet>`
  );
  return zip.generateAsync({ type: 'arraybuffer' });
}

/** Posts one message to a real worker and returns its reply. */
async function ask(
  message: Record<string, unknown>,
  transfer: Transferable[] = []
): Promise<Reply> {
  const worker = new Worker(
    new URL('../src/spreadsheet-parse-worker.ts', import.meta.url),
    { type: 'module' }
  );
  const { promise, resolve, reject } = Promise.withResolvers<Reply>();
  worker.onmessage = (event: MessageEvent<Reply>) => resolve(event.data);
  worker.onerror = (event) => reject(new Error(event.message));
  try {
    worker.postMessage(message, transfer);
    return await promise;
  } finally {
    worker.terminate();
  }
}

describe('spreadsheet comparison limits', () => {
  test('share the viewer ceiling and the parser budget', () => {
    expect(XLSX_COMPARE_MAX_BYTES).toBe(MAX_DIFF_BYTES);
    expect(XLSX_COMPARE_CELL_LIMIT).toBe(2_000_000);
    expect(XLSX_LISTED_CELL_CHANGES).toBe(200);
    expect(XLSX_LISTED_TEXT_CHARS).toBe(160);
  });
});

describe('spreadsheet compare worker', () => {
  test('compares two versions and transfers the sheets and their positions', async () => {
    const before = await workbook([
      ['Name', 'Total'],
      ['Alpha', 10],
    ]);
    const after = await workbook([
      ['Name', 'Total'],
      ['Alpha', 12],
    ]);
    const reply = await ask({ type: 'compare', before, after }, [
      before,
      after,
    ]);
    if (!reply.ok) throw new Error(`refused: ${reply.reason}`);
    expect(reply.before.sheets.map((sheet) => sheet.name)).toEqual(['Sheet1']);
    expect(reply.comparison.cells).toEqual({
      added: 0,
      removed: 0,
      changed: 1,
    });
    const [sheet] = reply.comparison.sheets;
    expect(sheet!.status).toBe('changed');
    expect(Array.from(sheet!.positions)).toEqual([1, 1, 3]);
    expect(sheet!.listed).toEqual([
      { row: 1, col: 1, kind: 'changed', before: '10', after: '12' },
    ]);
  });

  test('refuses a version that is not an ArrayBuffer and names its side', async () => {
    const valid = await workbook([['x']]);
    expect(
      await ask({ type: 'compare', before: 'not bytes', after: valid }, [valid])
    ).toEqual({ ok: false, side: 'before', reason: 'corrupt' });
    const other = await workbook([['x']]);
    expect(
      await ask(
        {
          type: 'compare',
          before: other,
          after: new Uint8Array([1, 2, 3]),
        },
        [other]
      )
    ).toEqual({ ok: false, side: 'after', reason: 'corrupt' });
  });

  test('refuses a version one byte over the limit before reading either', async () => {
    const before = await workbook([['x']]);
    const after = new ArrayBuffer(XLSX_COMPARE_MAX_BYTES + 1);
    expect(
      await ask({ type: 'compare', before, after }, [before, after])
    ).toEqual({ ok: false, side: 'after', reason: 'too-large' });
  });

  test('does not refuse a version of exactly the limit for its size', async () => {
    const before = await workbook([['x']]);
    const after = new ArrayBuffer(XLSX_COMPARE_MAX_BYTES);
    expect(
      await ask({ type: 'compare', before, after }, [before, after])
    ).toEqual({ ok: false, side: 'after', reason: 'corrupt' });
  });

  test('reports the after side when only the after version is corrupt', async () => {
    const before = await workbook([['x']]);
    const after = new TextEncoder().encode('not a workbook').buffer;
    expect(
      await ask({ type: 'compare', before, after }, [before, after])
    ).toEqual({ ok: false, side: 'after', reason: 'corrupt' });
  });

  test('reports the before side when the before version is corrupt', async () => {
    const before = new TextEncoder().encode('not a workbook').buffer;
    const after = await workbook([['x']]);
    expect(
      await ask({ type: 'compare', before, after }, [before, after])
    ).toEqual({ ok: false, side: 'before', reason: 'corrupt' });
  });
});

describe('spreadsheet compare worker: a reply that cannot be posted', () => {
  test('answers corrupt, with no side, when the comparison cannot be posted', async () => {
    const before = await workbook([['x']]);
    const after = await workbook([['y']]);
    const posted: unknown[] = [];
    await answer({ type: 'compare', before, after }, (message) => {
      posted.push(message);
      if (posted.length === 1)
        throw new DOMException('not cloneable', 'DataCloneError');
    });
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual({ ok: false, reason: 'corrupt' });
  });

  test('answers corrupt when a parsed workbook cannot be posted', async () => {
    const bytes = await workbook([['x']]);
    const posted: unknown[] = [];
    await answer({ type: 'parse', bytes }, (message) => {
      posted.push(message);
      if (posted.length === 1)
        throw new DOMException('not cloneable', 'DataCloneError');
    });
    expect(posted).toHaveLength(2);
    expect(posted[1]).toEqual({ ok: false, reason: 'corrupt' });
  });

  test('answers a parse request that is not a workbook with the parser reason', async () => {
    const posted: unknown[] = [];
    await answer(
      {
        type: 'parse',
        bytes: new TextEncoder().encode('not a workbook').buffer,
      },
      (message) => {
        posted.push(message);
      }
    );
    expect(posted).toEqual([{ ok: false, reason: 'corrupt' }]);
  });
});
