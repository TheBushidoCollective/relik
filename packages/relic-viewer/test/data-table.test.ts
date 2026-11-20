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

describe('table view in the browser', () => {
  test.skipIf(!shell)(
    'marks, sorting, selection and hostile cells behave in a real DOM',
    async () => {
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
      const page = `<!doctype html><meta charset="utf-8"><script type="module">
        import * as api from '/data-table.js';
        const source = ${embed(csv)};
        const hostileSource = ${embed(hostile)};
        try {
          const passed = await (${browserCases.toString()})(api, source, hostileSource, (name) => fetch('/progress', {method: 'POST', body: name}).catch(() => {}));
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
            report(
              (await request.json()) as { passed?: string[]; error?: string }
            );
            return new Response('ok');
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
        shell!,
        [
          basename(shell!).includes('headless-shell')
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
          result = await Promise.race([
            promise,
            exited.promise,
            stalled.promise,
          ]);
        } finally {
          clearTimeout(timer);
        }
        if (result.error) throw new Error(result.error);
        expect(result.passed).toHaveLength(10);
      } finally {
        browser.kill('SIGKILL');
        if (browser.exitCode === null && browser.signalCode === null) {
          await once(browser, 'exit');
        }
        server.stop(true);
        await rm(profile, { recursive: true, force: true });
      }
    },
    90000
  );
});
