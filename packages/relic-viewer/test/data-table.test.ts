import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseTable } from '@relic/format/csv';
import {
  anchorForRect,
  columnWidths,
  findCells,
  isNumericColumn,
  markFits,
  rectText,
  visibleText,
  sortOrder,
} from '../src/data-table.ts';
import { recordAt, rowWindow, type TableModel } from '../src/table-model.ts';
import { csvTableSource } from '../src/table-source.ts';

const csv = [
  'item,qty,site,note',
  ...Array.from(
    { length: 20 },
    (_, i) =>
      `item-${i + 1},${((i + 1) * 7) % 11},site-${(i + 1) % 3},note ${i + 1}`
  ),
].join('\n');

// A cell that would run script if it were ever parsed as markup. The page
// receives it escaped, so the script tag inside it never ends the page's own.
const hostile =
  'name,note\n<img src=x onerror="window.__csvPwned=1">,<script>window.__csvPwned=2</script>\n';

function parsed() {
  const result = parseTable(csv);
  if (!result.ok) throw new Error(`fixture refused: ${result.reason}`);
  return csvTableSource(result.table);
}

describe('sortOrder: numeric and text columns, header kept', () => {
  test('a numeric column sorts by number, not by text', () => {
    const table = parsed();
    const order = sortOrder(table, true, { column: 1, direction: 'asc' });
    expect(order[0]).toBe(0);
    const values = Array.from(order.slice(1), (record) =>
      Number(table.text(record, 1))
    );
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    }
  });

  test('descending reverses the value order', () => {
    const table = parsed();
    const asc = sortOrder(table, true, { column: 1, direction: 'asc' });
    const desc = sortOrder(table, true, { column: 1, direction: 'desc' });
    expect(desc[0]).toBe(0);
    const ascValues = Array.from(asc.slice(1)).map((r) => (r * 7) % 11);
    const descValues = Array.from(desc.slice(1)).map((r) => (r * 7) % 11);
    expect(descValues).toEqual([...ascValues].reverse());
  });

  test('empty values sort last in both directions', () => {
    const withBlanks = parseTable('n\n3\n\n1\n\n2\n');
    if (!withBlanks.ok) throw new Error('fixture refused');
    const t = csvTableSource(withBlanks.table);
    for (const direction of ['asc', 'desc'] as const) {
      const order = sortOrder(t, true, { column: 0, direction });
      const tail = Array.from(order.slice(order.length - 2));
      expect(tail.sort()).toEqual([2, 4]);
    }
  });

  test('a column with any non-numeric value sorts as text', () => {
    const table = parsed();
    expect(isNumericColumn(table, 1, true)).toBe(true);
    expect(isNumericColumn(table, 0, true)).toBe(false);
  });
});

describe('anchors and marks', () => {
  test('a single cell has no end; a range carries both ends, in A1', () => {
    expect(anchorForRect({ r0: 13, r1: 13, c0: 2, c1: 2 })).toEqual({
      kind: 'cell',
      row: 14,
      col: 3,
    });
    expect(anchorForRect({ r0: 3, r1: 8, c0: 1, c1: 3 })).toEqual({
      kind: 'cell',
      row: 4,
      col: 2,
      row_end: 9,
      col_end: 4,
    });
  });

  test('a mark must lie inside the table and carry no sheet', () => {
    expect(markFits({ kind: 'cell', row: 14, col: 3 }, 21, 4)).toBe(true);
    expect(markFits({ kind: 'cell', row: 22, col: 1 }, 21, 4)).toBe(false);
    expect(markFits({ kind: 'cell', row: 1, col: 5 }, 21, 4)).toBe(false);
    expect(markFits({ kind: 'cell', row: 1, col: 1, sheet: 'Q3' }, 21, 4)).toBe(
      false
    );
    expect(
      markFits({ kind: 'cell', row: 9, col: 1, row_end: 4, col_end: 1 }, 21, 4)
    ).toBe(false);
  });

  test('a selection copies as tab and newline separated text', () => {
    expect(rectText(parsed(), { r0: 1, r1: 2, c0: 0, c1: 1 })).toBe(
      'item-1\t7\nitem-2\t3'
    );
  });
});

describe('visible escapes', () => {
  test('bidi overrides and control characters show as escapes, not raw', () => {
    expect(visibleText('a\u202Eb')).toBe('a\\u{202E}b');
    expect(visibleText('x\u0007y')).toBe('x\\u{7}y');
    expect(visibleText('plain é')).toBe('plain é');
  });
});

describe('model helpers', () => {
  test('find matches case-insensitively in display order, drawn columns only', () => {
    const table = parsed();
    const model: TableModel = {
      records: table.records,
      columns: table.columns,
      headerRow: true,
      order: sortOrder(table, true, { column: 1, direction: 'asc' }),
    };
    const hits = findCells(table, model, table.columns, 'NOTE 1');
    // note 1, and note 10 through note 19
    expect(hits.length).toBe(11);
    expect(hits[0]!.record).toBe(recordAt(model, 1));
  });

  test('column widths stay within the screen-column bounds', () => {
    const widths = columnWidths(parsed(), 4);
    expect(widths).toHaveLength(4);
    for (const width of widths) {
      expect(width).toBeGreaterThanOrEqual(88);
      expect(width).toBeLessThanOrEqual(320);
    }
  });

  test('the row window is the viewport plus overscan, clamped to the table', () => {
    expect(rowWindow(20, 0, 280, 28, 2)).toEqual({ first: 0, end: 12 });
    expect(rowWindow(20, 10_000, 280, 28, 2)).toEqual({ first: 18, end: 20 });
    expect(rowWindow(0, 0, 280, 28, 2)).toEqual({ first: 0, end: 0 });
  });
});

// ---- in the browser -----------------------------------------------------------

function findHeadlessShell(): string | undefined {
  const configured = process.env['RELIC_CHROME_PATH'];
  if (configured && existsSync(configured)) return configured;
  const base = join(process.env['HOME'] ?? '', 'Library/Caches/ms-playwright');
  if (existsSync(base)) {
    const versions = readdirSync(base)
      .filter((name) => name.startsWith('chromium_headless_shell-'))
      .sort()
      .reverse();
    for (const version of versions) {
      const path = join(
        base,
        version,
        'chrome-headless-shell-mac-arm64/chrome-headless-shell'
      );
      if (existsSync(path)) return path;
    }
  }
  return [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].find(existsSync);
}

// Runs in the page. Self-contained: it reads only its arguments and the DOM.
// It must not contain the text of a closing script tag; the hostile fixture is
// passed in as an argument for that reason.
async function browserCases(
  api: {
    mountDataTable: (
      root: HTMLElement,
      table: unknown,
      options: { filename: string }
    ) => {
      paintMark(anchor: unknown, id: string): boolean;
      clearMarks(): void;
      selectionAnchor(): unknown;
      reveal(anchor: unknown, id?: string): void;
      dispose(): void;
    };
    csvTableSource: (table: unknown) => Record<string, unknown>;
    parseTable: (text: string) => {
      ok: boolean;
      table?: unknown;
      reason?: string;
    };
  },
  source: string,
  hostileSource: string,
  progress: (name: string) => Promise<unknown>
): Promise<string[]> {
  const passed: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label}: ${a} != ${b}`);
  };
  const truth = (value: unknown, label: string): void => {
    if (!value) throw new Error(label);
  };
  const cell = (
    root: HTMLElement,
    record: number,
    column: number
  ): HTMLElement | null =>
    root.querySelector<HTMLElement>(
      `.dt-cell[data-r="${record}"][data-c="${column}"]`
    ) ??
    root.querySelector<HTMLElement>(
      `.dt-hcell[data-r="${record}"][data-c="${column}"]`
    );
  const mouse = (el: Element | null, type: string): void => {
    if (!el) throw new Error(`no element for ${type}`);
    el.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
    );
  };
  const mount = (text: string, sheet?: string) => {
    const root = document.createElement('section');
    document.body.append(root);
    const result = api.parseTable(text);
    if (!result.ok || result.table === undefined) {
      throw new Error(`refused: ${result.reason}`);
    }
    const part = api.mountDataTable(
      root,
      { ...api.csvTableSource(result.table), sheet },
      {
        filename: 'fixture.csv',
      }
    );
    const done = (): void => {
      part.dispose();
      root.remove();
      document.getSelection()?.removeAllRanges();
    };
    return { root, part, done };
  };
  const check = async (
    name: string,
    run: () => void | Promise<void>
  ): Promise<void> => {
    await progress(name);
    document.getSelection()?.removeAllRanges();
    await run();
    passed.push(name);
  };

  const waitForFindCount = (
    root: HTMLElement,
    expected: string
  ): Promise<void> => {
    const count = root.querySelector('.dt-find-count');
    if (!count) throw new Error('find count is missing');
    if (count.textContent === expected) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const observer = new MutationObserver(() => {
      if (count.textContent !== expected) return;
      observer.disconnect();
      window.clearTimeout(timeout);
      resolve();
    });
    observer.observe(count, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    const timeout = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Find count did not reach ${expected}`));
    }, 5000);
    return promise;
  };

  await check(
    'large range copy shows a refusal instead of allocating it',
    () => {
      const root = document.createElement('section');
      document.body.append(root);
      const part = api.mountDataTable(
        root,
        {
          records: 100001,
          columns: 1,
          summary: 'Spreadsheet',
          sheet: 'Sheet',
          text: () => '',
          numeric: () => undefined,
        },
        { filename: 'book.xlsx' }
      );
      try {
        part.reveal({
          kind: 'cell',
          row: 1,
          col: 1,
          row_end: 100001,
          col_end: 1,
          sheet: 'Sheet',
        });
        const copy = root.querySelector<HTMLButtonElement>('.dt-copy');
        truth(copy, 'copy control');
        copy?.click();
        truth(
          copy?.textContent?.includes('too large to copy'),
          'copy refusal is visible'
        );
      } finally {
        part.dispose();
        root.remove();
      }
    }
  );

  await check('wide spreadsheet points to download rather than source', () => {
    const root = document.createElement('section');
    document.body.append(root);
    const part = api.mountDataTable(
      root,
      {
        records: 1,
        columns: 257,
        summary: 'Spreadsheet',
        sheet: 'Sheet',
        text: () => '',
        numeric: () => undefined,
      },
      { filename: 'book.xlsx' }
    );
    try {
      truth(
        root
          .querySelector('.dt-notice')
          ?.textContent?.includes('Download the spreadsheet'),
        'download notice'
      );
      truth(
        !root.querySelector('.dt-notice')?.textContent?.includes('source view'),
        'no source claim'
      );
    } finally {
      part.dispose();
      root.remove();
    }
  });

  // This exercises cancellation between real browser event-loop batches.
  await check('spreadsheet find cancels an older batched query', async () => {
    const root = document.createElement('section');
    document.body.append(root);
    let oldCalls = 0;
    let nextCalls = 0;
    let find: HTMLInputElement;
    const part = api.mountDataTable(
      root,
      {
        records: 1000,
        columns: 1,
        sheet: 'Sheet',
        summary: 'Spreadsheet',
        text: (row: number) => (row === 0 ? 'target' : ''),
        numeric: () => undefined,
        numericColumn: () => false,
        matchingColumns: (row: number, needle: string) => {
          if (needle === 'old') {
            oldCalls++;
            if (oldCalls === 1)
              window.setTimeout(() => {
                find.value = 'target';
                find.dispatchEvent(new Event('input', { bubbles: true }));
              }, 0);
            return [];
          }
          nextCalls++;
          return row === 0 ? [0] : [];
        },
      },
      { filename: 'book.xlsx' }
    );
    try {
      find = root.querySelector<HTMLInputElement>('.dt-find')!;
      find.value = 'old';
      find.dispatchEvent(new Event('input', { bubbles: true }));
      await waitForFindCount(root, '1 of 1');
      truth(
        oldCalls > 0 && oldCalls < 1000,
        'old query stopped before scanning all rows'
      );
      eq(nextCalls, 1000, 'new query scanned all rows');
      eq(
        root.querySelector('.dt-find-count')?.textContent,
        '1 of 1',
        'new query completed'
      );
    } finally {
      part.dispose();
      root.remove();
    }
  });

  await check(
    'a comment reveal keeps its position when an older find finishes',
    async () => {
      const root = document.createElement('section');
      document.body.append(root);
      let calls = 0;
      let part: { reveal(anchor: unknown): void; dispose(): void };
      part = api.mountDataTable(
        root,
        {
          records: 1000,
          columns: 1,
          sheet: 'Sheet',
          summary: 'Spreadsheet',
          text: (row: number) => (row === 0 ? 'target' : `row ${row + 1}`),
          numeric: () => undefined,
          numericColumn: () => false,
          matchingColumns: (row: number) => {
            calls++;
            if (calls === 1)
              window.setTimeout(
                () =>
                  part.reveal({
                    kind: 'cell',
                    sheet: 'Sheet',
                    row: 10,
                    col: 1,
                  }),
                0
              );
            return row === 0 ? [0] : [];
          },
        },
        { filename: 'book.xlsx' }
      );
      try {
        const find = root.querySelector<HTMLInputElement>('.dt-find')!;
        find.value = 'target';
        find.dispatchEvent(new Event('input', { bubbles: true }));
        await waitForFindCount(root, '1 match');
        eq(
          root.querySelector('.dt-find-count')?.textContent,
          '1 match',
          'search results retained'
        );
        eq(
          root.querySelector('.dt-addr')?.textContent,
          'A10',
          'comment remains selected'
        );
        find.value = 'next';
        find.dispatchEvent(new Event('input', { bubbles: true }));
        part.reveal({ kind: 'cell', sheet: 'Sheet', row: 20, col: 1 });
        await waitForFindCount(root, '1 match');
        eq(
          root.querySelector('.dt-find-count')?.textContent,
          '1 match',
          'debounced search results retained'
        );
        eq(
          root.querySelector('.dt-addr')?.textContent,
          'A20',
          'reveal during debounce remains selected'
        );
      } finally {
        part.dispose();
        root.remove();
      }
    }
  );

  await check(
    'inspector shows spreadsheet cell type and formula without HTML',
    () => {
      const root = document.createElement('section');
      document.body.append(root);
      const result = api.parseTable('header\n42');
      const formula = '<img src=x onerror=evil()>';
      if (!result.ok || result.table === undefined)
        throw new Error('fixture refused');
      const part = api.mountDataTable(
        root,
        {
          ...api.csvTableSource(result.table),
          sheet: 'Sheet 2',
          detail: () => ({
            type: 'number',
            formula,
            sharedFrom: 'A1',
          }),
        },
        { filename: 'book.xlsx' }
      );
      try {
        part.reveal({ kind: 'cell', row: 2, col: 1, sheet: 'Sheet 2' });
        truth(
          root.querySelector('.dt-sub')?.textContent?.includes('number'),
          'cell type'
        );
        truth(
          root
            .querySelector('.dt-value')
            ?.textContent?.includes(`Shared master formula: ${formula}`),
          'formula text'
        );
        truth(
          root
            .querySelector('.dt-value')
            ?.textContent?.includes('Shared from: A1'),
          'shared formula master'
        );
        truth(
          !root.querySelector('.dt-cellbar img'),
          'formula rendered as text'
        );
      } finally {
        part.dispose();
        root.remove();
      }
    }
  );

  await check('C14 is drawn on its cell and the mark is outlined', () => {
    const f = mount(source);
    try {
      eq(
        f.part.paintMark({ kind: 'cell', row: 14, col: 3 }, 'c1'),
        true,
        'paint'
      );
      truth(
        cell(f.root, 13, 2)?.classList.contains('is-marked'),
        'C14 is marked'
      );
      truth(
        !cell(f.root, 13, 1)?.classList.contains('is-marked'),
        'B14 is not'
      );
    } finally {
      f.done();
    }
  });

  await check('range B4:D9 is drawn on 18 cells with edges', () => {
    const f = mount(source);
    try {
      f.part.paintMark(
        { kind: 'cell', row: 4, col: 2, row_end: 9, col_end: 4 },
        'r1'
      );
      let marked = 0;
      for (let r = 3; r <= 8; r++) {
        for (let c = 1; c <= 3; c++) {
          if (cell(f.root, r, c)?.classList.contains('is-range')) marked++;
        }
      }
      eq(marked, 18, 'range cells');
      truth(cell(f.root, 3, 1)?.classList.contains('mk-t'), 'top edge');
      truth(cell(f.root, 8, 3)?.classList.contains('mk-r'), 'right edge');
      truth(
        !cell(f.root, 2, 0)?.classList.contains('is-range'),
        'outside the range'
      );
    } finally {
      f.done();
    }
  });

  await check('marks stay on their cells after a numeric sort', () => {
    const f = mount(source);
    try {
      f.part.paintMark({ kind: 'cell', row: 14, col: 3 }, 'c1');
      f.part.paintMark(
        { kind: 'cell', row: 4, col: 2, row_end: 9, col_end: 4 },
        'r1'
      );
      const before = cell(f.root, 13, 2)!.parentElement!.style.top;
      mouse(f.root.querySelector('.dt-hcell[data-c="1"]'), 'click');
      const after = cell(f.root, 13, 2)!;
      truth(after.classList.contains('is-marked'), 'C14 mark survives sort');
      truth(after.parentElement!.style.top !== before, 'C14 row moved');
      // qty ascends down the drawn rows
      const rows = [...f.root.querySelectorAll<HTMLElement>('.dt-row')].sort(
        (a, b) => parseFloat(a.style.top) - parseFloat(b.style.top)
      );
      const qty = rows.map((row) =>
        Number(row.querySelectorAll('.dt-cell')[1]!.textContent)
      );
      for (let i = 1; i < qty.length; i++) {
        truth(qty[i]! >= qty[i - 1]!, 'qty ascends');
      }
      truth(
        cell(f.root, 3, 1)?.classList.contains('is-range'),
        'range member survives sort'
      );
    } finally {
      f.done();
    }
  });

  await check('a drag selection yields the exact range anchor', () => {
    const f = mount(source);
    try {
      mouse(cell(f.root, 4, 1), 'mousedown');
      mouse(cell(f.root, 7, 3), 'mousemove');
      mouse(cell(f.root, 7, 3), 'mouseup');
      eq(
        f.part.selectionAnchor(),
        { kind: 'cell', row: 5, col: 2, row_end: 8, col_end: 4 },
        'anchor'
      );
    } finally {
      f.done();
    }
  });

  await check('sheet selection and mark isolation', () => {
    const f = mount(source, 'Q3');
    try {
      mouse(cell(f.root, 4, 1), 'mousedown');
      mouse(cell(f.root, 4, 1), 'mouseup');
      eq(
        f.part.selectionAnchor(),
        { kind: 'cell', sheet: 'Q3', row: 5, col: 2 },
        'sheet selection'
      );
      eq(
        f.part.paintMark({ kind: 'cell', row: 5, col: 2, sheet: 'Q3' }, 'same'),
        true,
        'same sheet'
      );
      eq(
        f.part.paintMark(
          { kind: 'cell', row: 5, col: 2, sheet: 'Q4' },
          'other'
        ),
        false,
        'other sheet'
      );
      eq(
        f.part.paintMark({ kind: 'cell', row: 5, col: 2 }, 'absent'),
        false,
        'missing sheet'
      );
    } finally {
      f.done();
    }
  });

  await check(
    'a single-cell selection after sorting names the record it sits on',
    () => {
      const f = mount(source);
      try {
        mouse(f.root.querySelector('.dt-hcell[data-c="1"]'), 'click');
        mouse(cell(f.root, 2, 0), 'mousedown');
        mouse(cell(f.root, 2, 0), 'mouseup');
        eq(
          f.part.selectionAnchor(),
          { kind: 'cell', row: 3, col: 1 },
          'sorted anchor'
        );
      } finally {
        f.done();
      }
    }
  );

  await check('HTML in cells creates no elements and runs nothing', () => {
    const f = mount(hostileSource);
    try {
      truth(
        f.root.querySelector('img, script') === null,
        'no img or script element'
      );
      eq(Reflect.get(window, '__csvPwned'), undefined, 'nothing ran');
      eq(
        cell(f.root, 1, 0)?.textContent,
        '<img src=x onerror="window.__csvPwned=1">',
        'literal text'
      );
    } finally {
      f.done();
    }
  });

  await check(
    'paintMark refuses anchors that do not fit, and clearMarks removes marks',
    () => {
      const f = mount(source);
      try {
        eq(
          f.part.paintMark({ kind: 'cell', row: 99, col: 1 }, 'x'),
          false,
          'row past table'
        );
        eq(
          f.part.paintMark({ kind: 'cell', row: 1, col: 1, sheet: 'Q3' }, 'x'),
          false,
          'sheet'
        );
        eq(
          f.part.paintMark({ kind: 'path', pointer: '' }, 'x'),
          false,
          'path kind'
        );
        eq(
          f.part.paintMark({ kind: 'cell', row: 1, col: 9 }, 'x'),
          false,
          'column past table'
        );
        f.part.paintMark({ kind: 'cell', row: 14, col: 3 }, 'c1');
        f.part.clearMarks();
        truth(!cell(f.root, 13, 2)?.classList.contains('is-marked'), 'cleared');
      } finally {
        f.done();
      }
    }
  );

  await check(
    'reveal selects the anchored cell, which the anchor then names',
    () => {
      const f = mount(source);
      try {
        f.part.reveal({ kind: 'cell', row: 14, col: 3 }, 'c1');
        eq(
          f.part.selectionAnchor(),
          { kind: 'cell', row: 14, col: 3 },
          'revealed anchor'
        );
      } finally {
        f.done();
      }
    }
  );

  await check('no selection gives no anchor', () => {
    const f = mount(source);
    try {
      eq(f.part.selectionAnchor(), undefined, 'empty');
    } finally {
      f.done();
    }
  });

  return passed;
}

const shell = findHeadlessShell();

/**
 * Runs `cases` in a headless page that imports the bundled table entry as
 * `api`, then `args`, then a progress reporter, and resolves with the names the
 * page passed. A page error, a closed browser or a hang fails with the
 * evidence: the requests seen, the cases started, and stderr. With
 * `stylesheet`, the page links the real data-table stylesheet before its module
 * runs, so the grid lays out and scrolls as it does in the viewer.
 */
async function runInHeadlessPage(
  browserPath: string,
  cases: (...args: never[]) => Promise<string[]>,
  args: readonly unknown[],
  stylesheet: boolean
): Promise<string[] | undefined> {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, 'data-table-browser-entry.ts')],
    target: 'browser',
    format: 'esm',
    splitting: false,
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  const script = await build.outputs[0]!.text();
  const { promise, resolve: report } = Promise.withResolvers<{
    passed?: string[];
    error?: string;
  }>();
  const seen: string[] = [];
  const started: string[] = [];
  const stderr = { tail: '' };
  // JSON with `</` escaped, so no string in the page can close its script.
  const embed = (value: unknown): string =>
    JSON.stringify(value).replace(/<\//g, '<\\/');
  const page = `<!doctype html><meta charset="utf-8">${stylesheet ? '<link rel="stylesheet" href="/assets/data-table.css" data-dt-css>' : ''}<script type="module">
        import * as api from '/data-table.js';
        const args = ${embed(args)};
        try {
          const passed = await (${cases.toString()})(api, ...args, (name) => fetch('/progress', {method: 'POST', body: name}).catch(() => {}));
          await fetch('/result', {method: 'POST', body: JSON.stringify({passed})});
        } catch (error) {
          await fetch('/result', {method: 'POST', body: JSON.stringify({error: (error && (error.stack || error.message)) || String(error)})});
        }
      </script>`;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push(`${request.method} ${url.pathname}`);
      if (url.pathname === '/progress') {
        started.push(await request.text());
        return new Response('ok');
      }
      if (url.pathname === '/result') {
        report((await request.json()) as { passed?: string[]; error?: string });
        return new Response('ok');
      }
      if (stylesheet && url.pathname === '/assets/data-table.css') {
        return new Response(
          Bun.file(resolve(import.meta.dir, '../src/data-table.css')),
          { headers: { 'content-type': 'text/css' } }
        );
      }
      if (url.pathname === '/data-table.js') {
        return new Response(script, {
          headers: { 'content-type': 'text/javascript' },
        });
      }
      return new Response(page, {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  const profile = join(tmpdir(), `relic-data-table-${crypto.randomUUID()}`);
  // The startup flags the other browser proofs use (see suggest-editor.test.ts).
  const browser = spawn(
    browserPath,
    [
      basename(browserPath).includes('headless-shell')
        ? '--headless'
        : '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-breakpad',
      '--mute-audio',
      `http://127.0.0.1:${server.port}/`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  browser.stderr?.on('data', (chunk: Buffer) => {
    stderr.tail = (stderr.tail + chunk.toString('utf8')).slice(-4096);
  });
  try {
    const exited = Promise.withResolvers<never>();
    browser.once('error', exited.reject);
    browser.once('exit', (code) =>
      exited.reject(
        new Error(`headless browser exited before reporting: ${code}`)
      )
    );
    // A real timer on purpose: this drives a real browser, and a hang has to
    // fail with evidence (the requests seen, the cases started) rather than
    // hide behind the test runner's own limit. Deterministic time control
    // cannot stand in for a browser's event loop.
    const stalled = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      stalled.reject(
        new Error(
          `the page did not report within 60 s. requests: ${JSON.stringify(seen)}; ` +
            `cases started: ${JSON.stringify(started)}; stderr: ${JSON.stringify(stderr.tail)}`
        )
      );
    }, 60_000);
    let result: { passed?: string[]; error?: string };
    try {
      result = await Promise.race([promise, exited.promise, stalled.promise]);
    } finally {
      clearTimeout(timer);
    }
    if (result.error) throw new Error(result.error);
    return result.passed;
  } finally {
    browser.kill('SIGKILL');
    if (browser.exitCode === null && browser.signalCode === null) {
      await once(browser, 'exit');
    }
    server.stop(true);
    await rm(profile, { recursive: true, force: true });
  }
}

describe('table view in the browser', () => {
  test.skipIf(!shell)(
    'marks, sorting, selection and hostile cells behave in a real DOM',
    async () => {
      const passed = await runInHeadlessPage(
        shell!,
        browserCases,
        [csv, hostile],
        false
      );
      expect(passed).toHaveLength(15);
    },
    90000
  );
});

/** The compare grid's entry points, as the page reaches them through the bundle. */
interface CompareApi {
  mountCompareTable(
    root: HTMLElement,
    table: unknown,
    options: {
      filename: string;
      label: string;
      widths: readonly number[];
      state(record: number, column: number): string | undefined;
      onSelect?(record: number, column: number): void;
    }
  ): {
    readonly scroller: HTMLElement;
    select(record: number, column: number): void;
    reveal(record: number, column: number, top: number): void;
    dispose(): void;
  };
  mirrorScrollers(panes: readonly HTMLElement[]): () => void;
}

// Runs in the page, so it is self-contained like browserCases: it reads its
// arguments and the DOM only.
async function compareCases(
  api: CompareApi,
  progress: (name: string) => Promise<unknown>
): Promise<string[]> {
  const passed: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label}: ${a} != ${b}`);
  };
  const truth = (value: unknown, label: string): void => {
    if (!value) throw new Error(label);
  };
  const cellAt = (
    root: HTMLElement,
    record: number,
    column: number
  ): HTMLElement | null =>
    root.querySelector<HTMLElement>(
      `.dt-cell[data-r="${record}"][data-c="${column}"]`
    );
  const dispatch = (el: Element | null, event: Event): void => {
    if (!el) throw new Error(`no element for ${event.type}`);
    el.dispatchEvent(event);
  };
  const press = (el: Element | null, type: string): void =>
    dispatch(
      el,
      new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
    );
  const mount = (
    rows: readonly (readonly string[])[],
    options: {
      widths: readonly number[];
      label?: string;
      state?: (record: number, column: number) => string | undefined;
      onSelect?: (record: number, column: number) => void;
    }
  ) => {
    const root = document.createElement('section');
    document.body.append(root);
    // Every value is text, and a value that parses as a number is numeric.
    const table = {
      records: rows.length,
      columns: Math.max(0, ...rows.map((row) => row.length)),
      text: (record: number, column: number): string =>
        rows[record]?.[column] ?? '',
      numeric: (record: number, column: number): number | undefined => {
        const value = rows[record]?.[column] ?? '';
        return value !== '' && Number.isFinite(Number(value))
          ? Number(value)
          : undefined;
      },
      summary: 'fixture',
    };
    const part = api.mountCompareTable(root, table, {
      filename: 'v2.xlsx',
      label: options.label ?? 'Version 2 of v2.xlsx, sheet Q3',
      widths: options.widths,
      state: options.state ?? (() => undefined),
      ...(options.onSelect === undefined ? {} : { onSelect: options.onSelect }),
    });
    const done = (): void => {
      part.dispose();
      root.remove();
      document.getSelection()?.removeAllRanges();
    };
    return { root, part, done };
  };
  const check = async (
    name: string,
    run: () => void | Promise<void>
  ): Promise<void> => {
    await progress(name);
    document.getSelection()?.removeAllRanges();
    await run();
    passed.push(name);
  };
  // One display frame. The scroll events a write causes arrive in the frame after it.
  const nextFrame = (): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => resolve());
    return promise;
  };
  const frames = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i++) await nextFrame();
  };
  // Polls once per frame until the condition holds, and fails at a deadline
  // rather than hanging. The clock is read only to report that failure.
  const until = async (test: () => boolean, label: string): Promise<void> => {
    const deadline = performance.now() + 3000;
    while (!test()) {
      if (performance.now() > deadline) throw new Error(`timed out: ${label}`);
      await nextFrame();
    }
  };
  const small = [
    ['Region', 'Target', 'Note'],
    ['West', '120', 'steady'],
    ['East', '90', ''],
    ['North', '75', 'new'],
  ];
  const widths = [120, 90, 100];

  await check(
    'compare cells carry their state as a class and hidden text',
    () => {
      const states: Record<string, string> = {
        '0,0': 'added',
        '1,1': 'removed',
        '2,2': 'changed',
        '3,1': 'formula',
      };
      const { root, done } = mount(small, {
        widths,
        state: (record, column) => states[`${record},${column}`],
      });
      try {
        for (const [record, column, name] of [
          [0, 0, 'added'],
          [1, 1, 'removed'],
          [2, 2, 'changed'],
          [3, 1, 'formula'],
        ] as const) {
          const cell = cellAt(root, record, column);
          truth(
            cell?.classList.contains(`dt-diff-${name}`),
            `${name} at ${record},${column} has its class`
          );
          eq(
            cell?.querySelector('.dt-sr')?.textContent,
            name === 'formula' ? ' (formula changed)' : ` (${name})`,
            `${name} hidden text`
          );
        }
        const plain = cellAt(root, 1, 0);
        truth(
          !plain?.querySelector('.dt-sr'),
          'an unchanged cell has no hidden state'
        );
        truth(
          !plain?.className
            .split(' ')
            .some((name) => name.startsWith('dt-diff-')),
          'an unchanged cell has no state class'
        );
      } finally {
        done();
      }
    }
  );

  await check(
    'a header press does not sort, and no find, toggle or comment control is drawn',
    () => {
      const { root, done } = mount(small, { widths });
      try {
        const header = root.querySelector('.dt-hcell');
        press(header, 'mousedown');
        press(header, 'click');
        truth(
          !root.querySelector('.dt-sort'),
          'a header press drew a sort marker'
        );
        eq(
          cellAt(root, 0, 0)?.textContent,
          'Region',
          'the rows keep their order'
        );
        truth(
          root.querySelector(
            'input, .dt-find, .dt-toggle, .dt-hc-comment, .dt-suggest, .dt-suggestion-indicator, .dt-suggest-editor, [data-comment-id]'
          ) === null,
          'a control from the table view is drawn'
        );
        eq(
          root.querySelectorAll('button').length,
          0,
          'no button before a choice'
        );
      } finally {
        done();
      }
    }
  );

  await check('rows number from 1 under column letters, past Z too', () => {
    const wide = [
      Array.from({ length: 28 }, (_, c) => `c${c}`),
      Array.from({ length: 28 }, (_, c) => String(c)),
    ];
    const { root, done } = mount(wide, {
      widths: Array.from({ length: 28 }, () => 60),
    });
    try {
      eq(
        Array.from(
          root.querySelectorAll('.dt-letter'),
          (el) => el.textContent
        ).slice(-3),
        ['Z', 'AA', 'AB'],
        'column letters'
      );
      eq(
        Array.from(root.querySelectorAll('.dt-rn'), (el) => el.textContent),
        ['1', '2'],
        'row numbers'
      );
      eq(
        root.querySelector('.dt-row')?.getAttribute('aria-rowindex'),
        '2',
        'the letter row counts as row 1'
      );
    } finally {
      done();
    }
  });

  await check(
    'shared widths set the same tracks on the grid and its header',
    () => {
      const { root, done } = mount(small, { widths });
      try {
        const grid = root.querySelector<HTMLElement>('.dt-grid');
        eq(
          grid?.style.getPropertyValue('--dt-tracks'),
          '56px 120px 90px 100px',
          'tracks'
        );
        eq(grid?.dataset['file'], 'v2.xlsx', 'the grid names its file');
        eq(
          root.querySelector<HTMLElement>('.dt-head')?.style.width,
          '366px',
          'header width'
        );
        eq(
          root.querySelector<HTMLElement>('.dt-body')?.style.width,
          '366px',
          'body width'
        );
      } finally {
        done();
      }
    }
  );

  await check(
    'select reports each new cell through onSelect and draws the cellbar',
    () => {
      const calls: number[][] = [];
      const { root, part, done } = mount(small, {
        widths,
        onSelect: (record, column) => {
          calls.push([record, column]);
        },
      });
      try {
        part.select(2, 1);
        part.select(2, 1);
        eq(calls, [[2, 1]], 'a repeat choice is silent');
        truth(
          cellAt(root, 2, 1)?.classList.contains('is-active'),
          'the chosen cell is active'
        );
        eq(
          cellAt(root, 2, 1)?.getAttribute('aria-selected'),
          'true',
          'aria-selected'
        );
        eq(
          root.querySelector('.dt-addr')?.textContent,
          'B3',
          'the cellbar names the cell'
        );
        press(cellAt(root, 0, 2), 'mousedown');
        eq(
          calls,
          [
            [2, 1],
            [0, 2],
          ],
          'a reader choice reports through onSelect'
        );
        eq(
          root.querySelector('.dt-addr')?.textContent,
          'C1',
          'the cellbar follows the reader'
        );
        dispatch(
          cellAt(root, 0, 2),
          new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
          })
        );
        eq(
          calls[calls.length - 1],
          [1, 2],
          'an arrow key moves the choice and reports it'
        );
        eq(
          Array.from(root.querySelectorAll('button'), (b) => b.className),
          ['dt-copy'],
          'Copy is the only button'
        );
      } finally {
        done();
      }
    }
  );

  await check(
    'reveal puts the cell top at the requested offset, without selecting it',
    () => {
      const tall = Array.from({ length: 200 }, (_, r) => [
        `r${r}`,
        `v${r}`,
        'x',
      ]);
      const { root, part, done } = mount(tall, { widths });
      try {
        part.reveal(120, 1, 100);
        const grid = part.scroller;
        eq(grid.scrollTop, 36 + 120 * 28 - 100, 'scrollTop');
        const cell = cellAt(root, 120, 1);
        truth(cell, 'the revealed cell is drawn');
        const offset = Math.round(
          cell!.getBoundingClientRect().top -
            grid.getBoundingClientRect().top -
            grid.clientTop
        );
        eq(offset, 100, 'the cell top offset in the grid');
        truth(!cell?.classList.contains('is-active'), 'reveal does not select');
      } finally {
        done();
      }
    }
  );

  await check(
    'mirrored grids follow each other on both axes, and stop when torn down',
    async () => {
      const wide = Array.from({ length: 200 }, (_, r) =>
        Array.from({ length: 12 }, (_, c) => `${r}:${c}`)
      );
      const twelve = Array.from({ length: 12 }, () => 200);
      const left = mount(wide, { widths: twelve });
      const right = mount(wide, { widths: twelve });
      const a = left.part.scroller;
      const b = right.part.scroller;
      const unbind = api.mirrorScrollers([a, b]);
      try {
        a.scrollTop = 500;
        a.scrollLeft = 40;
        await until(
          () => b.scrollTop === 500 && b.scrollLeft === 40,
          'the second grid follows the first'
        );
        await frames(4);
        eq(
          [a.scrollTop, a.scrollLeft, b.scrollTop, b.scrollLeft],
          [500, 40, 500, 40],
          'both grids hold one position'
        );
        b.scrollTop = 900;
        await until(
          () => a.scrollTop === 900,
          'the first grid follows the second'
        );
        await frames(4);
        eq(
          [a.scrollTop, a.scrollLeft, b.scrollTop, b.scrollLeft],
          [900, 40, 900, 40],
          'the reverse holds'
        );
        unbind();
        a.scrollTop = 1200;
        await frames(4);
        eq(b.scrollTop, 900, 'a torn-down mirror stops');
      } finally {
        unbind();
        left.done();
        right.done();
      }
    }
  );

  await check(
    'a value with markup stays text, and a bidi sheet name shows as an escape',
    () => {
      const markup = [
        ['<img src=x onerror="window.__cmpPwned=1">', '<b>bold</b>'],
      ];
      const { root, done } = mount(markup, {
        widths: [200, 200],
        label: 'Version 2, sheet Q\u202E3',
      });
      try {
        truth(
          root.querySelector('img, b') === null,
          'markup became an element'
        );
        eq(
          cellAt(root, 0, 0)?.textContent,
          '<img src=x onerror="window.__cmpPwned=1">',
          'the value shows as text'
        );
        eq(Reflect.get(window, '__cmpPwned'), undefined, 'nothing ran');
        const label =
          root.querySelector('.dt-grid')?.getAttribute('aria-label') ?? '';
        truth(
          label.includes('\\u{202E}') && !label.includes('\u202E'),
          'the bidi control shows as an escape in the label'
        );
      } finally {
        done();
      }
    }
  );

  return passed;
}

describe('compare grid in the browser', () => {
  test.skipIf(!shell)(
    'compare cells, selection, reveal and mirrored scrolling behave in a real DOM',
    async () => {
      const passed = await runInHeadlessPage(shell!, compareCases, [], true);
      expect(passed).toHaveLength(8);
    },
    90000
  );
});
