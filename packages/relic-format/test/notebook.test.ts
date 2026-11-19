import { describe, expect, test } from 'bun:test';
import {
  ansiSpans,
  decodeBase64,
  escapeInvisible,
  imageFormatOf,
  NOTEBOOK_MAX_CELLS,
  NOTEBOOK_MAX_OUTPUTS_PER_CELL,
  NOTEBOOK_TEXT_MAX_CHARS,
  type Notebook,
  type NotebookBody,
  notebookPointer,
  notebookTarget,
  parseNotebook,
} from '../src/notebook.ts';

// A 1x1 PNG, base64, as nbformat stores it.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG_BYTES_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2w==';

function nb(cells: unknown[], nbformat: unknown = 4): string {
  return JSON.stringify({ cells, metadata: {}, nbformat, nbformat_minor: 5 });
}

function ok(source: string): Notebook {
  const result = parseNotebook(source);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.refusal)}`);
  return result.notebook;
}

function bodyOf(source: string, cell = 0, output = 0): NotebookBody {
  const body = ok(source).cells[cell]?.outputs[output]?.body;
  if (body === undefined) throw new Error('no output');
  return body;
}

describe('refusals', () => {
  test('not JSON reports a syntax failure with a position', () => {
    const result = parseNotebook('{"cells": [');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.kind).toBe('json');
  });

  test('a JSON document that is not a notebook is refused', () => {
    for (const text of ['[]', '{"cells": []}', '{"nbformat": 4}', '"x"']) {
      const result = parseNotebook(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.kind).toBe('not-notebook');
    }
  });

  test('nbformat other than 4 is refused with the version found', () => {
    const result = parseNotebook(nb([], 3));
    expect(result).toEqual({
      ok: false,
      refusal: { kind: 'nbformat', found: '3' },
    });
  });

  test('a notebook past the cell cap is refused, and 10,000 cells is timed', () => {
    const cells = Array.from({ length: 10_000 }, () => ({
      cell_type: 'markdown',
      source: ['x'],
    }));
    const source = nb(cells);
    const started = performance.now();
    const result = parseNotebook(source);
    const ms = performance.now() - started;
    expect(result).toEqual({
      ok: false,
      refusal: {
        kind: 'too-many-cells',
        count: 10_000,
        limit: NOTEBOOK_MAX_CELLS,
      },
    });
    // Recorded for the notes; the bound is the refusal itself, not the time.
    console.log(`10,000-cell notebook refused in ${ms.toFixed(1)} ms`);
  });

  test('5,000 cells parse, and the time is recorded', () => {
    const cells = Array.from({ length: NOTEBOOK_MAX_CELLS }, (_, i) => ({
      cell_type: i % 2 === 0 ? 'markdown' : 'code',
      source: [`cell ${i}\n`],
      execution_count: i % 2 === 0 ? null : i,
      outputs: [],
      metadata: {},
    }));
    const started = performance.now();
    const notebook = ok(nb(cells));
    const ms = performance.now() - started;
    expect(notebook.cells).toHaveLength(NOTEBOOK_MAX_CELLS);
    expect(notebook.cells[1]?.executionCount).toBe(1);
    expect(notebook.cells[0]?.kind).toBe('markdown');
    console.log(`5,000-cell notebook parsed in ${ms.toFixed(1)} ms`);
  });
});

describe('cells', () => {
  test('markdown, code and raw cells read with source arrays and strings', () => {
    const notebook = ok(
      nb([
        { cell_type: 'markdown', source: ['# Title\n', 'Body'] },
        { cell_type: 'code', source: 'x = 1', execution_count: 3, outputs: [] },
        { cell_type: 'raw', source: ['plain'] },
        { cell_type: 'heading', source: 'unknown kinds are raw' },
      ])
    );
    expect(notebook.cells.map((cell) => cell.kind)).toEqual([
      'markdown',
      'code',
      'raw',
      'raw',
    ]);
    expect(notebook.cells[0]?.source.text).toBe('# Title\nBody');
    expect(notebook.cells[1]?.source.text).toBe('x = 1');
    expect(notebook.cells[1]?.executionCount).toBe(3);
    expect(notebook.cells[0]?.executionCount).toBeUndefined();
  });

  test('a null or negative execution count is not a count', () => {
    const notebook = ok(
      nb([
        { cell_type: 'code', source: '', execution_count: null, outputs: [] },
        { cell_type: 'code', source: '', execution_count: -2, outputs: [] },
        { cell_type: 'code', source: '', execution_count: 1.5, outputs: [] },
      ])
    );
    expect(notebook.cells.map((cell) => cell.executionCount)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test('metadata is never read, so nothing in it reaches a view', () => {
    const notebook = ok(
      nb([
        {
          cell_type: 'markdown',
          source: 'visible',
          metadata: { title: '<img src=x onerror=alert(1)>' },
        },
      ])
    );
    expect(JSON.stringify(notebook.cells)).not.toContain('onerror');
  });

  test('a cell outputs cap keeps 200, counts the rest', () => {
    const outputs = Array.from(
      { length: NOTEBOOK_MAX_OUTPUTS_PER_CELL + 7 },
      () => ({
        output_type: 'stream',
        name: 'stdout',
        text: 'x',
      })
    );
    const cell = ok(nb([{ cell_type: 'code', source: '', outputs }])).cells[0];
    expect(cell?.outputs).toHaveLength(NOTEBOOK_MAX_OUTPUTS_PER_CELL);
    expect(cell?.omittedOutputs).toBe(7);
  });
});

describe('outputs', () => {
  test('stdout, stderr and text/plain read as text', () => {
    const notebook = ok(
      nb([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            { output_type: 'stream', name: 'stdout', text: ['a\n', 'b'] },
            { output_type: 'stream', name: 'stderr', text: 'warn' },
            {
              output_type: 'execute_result',
              data: { 'text/plain': ['1', '2'] },
              execution_count: 1,
            },
          ],
        },
      ])
    );
    const [stdout, stderr, result] = notebook.cells[0]?.outputs ?? [];
    expect(stdout?.body).toMatchObject({ kind: 'stream', stream: 'stdout' });
    expect(stderr?.body).toMatchObject({ kind: 'stream', stream: 'stderr' });
    expect(result?.outputType).toBe('execute_result');
    expect(result?.body).toEqual({
      kind: 'text',
      text: { text: '12', truncated: false },
    });
  });

  test('markdown wins over plain text; JSON is shown as its source', () => {
    const md = bodyOf(
      nb([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            {
              output_type: 'display_data',
              data: { 'text/plain': 'plain', 'text/markdown': '**bold**' },
            },
          ],
        },
      ])
    );
    expect(md).toEqual({
      kind: 'markdown',
      text: { text: '**bold**', truncated: false },
    });
    const json = bodyOf(
      nb([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            {
              output_type: 'display_data',
              data: { 'application/json': { a: [1, 'two'] } },
            },
          ],
        },
      ])
    );
    expect(json).toEqual({
      kind: 'json',
      text: { text: '{"a":[1,"two"]}', truncated: false },
    });
  });

  test('an error keeps its name and traceback, and its ANSI styling', () => {
    const body = bodyOf(
      nb([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            {
              output_type: 'error',
              ename: 'AttributeError',
              evalue: "no 'conditon'",
              traceback: ['\u001b[0;31mAttributeError\u001b[0m: no', 'line 2'],
            },
          ],
        },
      ])
    );
    expect(body).toMatchObject({
      kind: 'error',
      name: 'AttributeError',
      value: "no 'conditon'",
      truncated: false,
    });
    if (body.kind !== 'error') throw new Error('not an error');
    expect(body.spans[0]).toMatchObject({ text: 'AttributeError', fg: 1 });
    expect(body.spans.map((span) => span.text).join('')).toBe(
      'AttributeError: no\nline 2'
    );
  });

  test('HTML, SVG, JavaScript, LaTeX and widgets are withheld, never drawn', () => {
    const cases: Array<[string, string]> = [
      ['text/html', 'html'],
      ['image/svg+xml', 'svg'],
      ['application/javascript', 'javascript'],
      ['text/latex', 'latex'],
      ['application/vnd.jupyter.widget-view+json', 'widget'],
    ];
    for (const [mime, kind] of cases) {
      const body = bodyOf(
        nb([
          {
            cell_type: 'code',
            source: '',
            outputs: [
              {
                output_type: 'display_data',
                data: {
                  [mime]: '<script>alert(1)</script>',
                  'text/plain': 'fallback',
                },
              },
            ],
          },
        ])
      );
      expect(body).toMatchObject({
        kind: 'withheld',
        withheld: kind,
        label: mime,
        plain: { text: 'fallback', truncated: false },
        source: { text: '<script>alert(1)</script>', truncated: false },
      });
    }
  });

  test('an SVG with a raster sibling still shows the raster', () => {
    const body = bodyOf(
      nb([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            {
              output_type: 'display_data',
              data: {
                'image/png': PNG_B64,
                'image/svg+xml': '<svg onload=x>',
              },
            },
          ],
        },
      ])
    );
    expect(body.kind).toBe('image');
  });

  test('a withheld output with no text fallback keeps its source', () => {
    const body = bodyOf(
      nb([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            { output_type: 'display_data', data: { 'text/html': '<b>x</b>' } },
          ],
        },
      ])
    );
    expect(body).toMatchObject({
      kind: 'withheld',
      plain: undefined,
      source: { text: '<b>x</b>' },
    });
  });
});

describe('images', () => {
  test('a PNG with a matching signature is decoded and typed by it', () => {
    const body = bodyOf(
      nb([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            { output_type: 'display_data', data: { 'image/png': PNG_B64 } },
          ],
        },
      ])
    );
    expect(body.kind).toBe('image');
    if (body.kind !== 'image') return;
    expect(body.format).toBe('png');
    expect(imageFormatOf(body.bytes)).toBe('png');
  });

  test('an image whose signature disagrees with its declared type is refused', () => {
    const body = bodyOf(
      nb([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            {
              output_type: 'display_data',
              data: { 'image/png': JPEG_BYTES_B64 },
            },
          ],
        },
      ])
    );
    expect(body).toEqual({
      kind: 'image-refused',
      reason: 'signature',
      declared: 'image/png',
    });
  });

  test('bytes that are not base64 are refused as encoding', () => {
    const body = bodyOf(
      nb([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            { output_type: 'display_data', data: { 'image/png': '<svg/>' } },
          ],
        },
      ])
    );
    expect(body).toMatchObject({ kind: 'image-refused', reason: 'encoding' });
  });

  test('base64 is split across lines as nbformat stores it', () => {
    const split = [`${PNG_B64.slice(0, 20)}\n`, PNG_B64.slice(20)];
    const body = bodyOf(
      nb([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            { output_type: 'display_data', data: { 'image/png': split } },
          ],
        },
      ])
    );
    expect(body.kind).toBe('image');
  });

  test('decodeBase64 and imageFormatOf refuse what they cannot read', () => {
    expect(decodeBase64('abc')).toBeUndefined();
    expect(decodeBase64('a*c=')).toBeUndefined();
    expect(decodeBase64('')).toEqual(new Uint8Array());
    expect(imageFormatOf(new Uint8Array([0x89, 0x50]))).toBeUndefined();
    expect(imageFormatOf(new Uint8Array())).toBeUndefined();
    expect(imageFormatOf(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe('jpeg');
    expect(
      imageFormatOf(
        new Uint8Array([...'RIFF\0\0\0\0WEBP'].map((c) => c.charCodeAt(0)))
      )
    ).toBe('webp');
  });
});

describe('hostile input', () => {
  test('script and HTML in markdown, source and outputs are text in the model', () => {
    const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const notebook = ok(
      nb([
        { cell_type: 'markdown', source: payload },
        {
          cell_type: 'code',
          source: payload,
          outputs: [{ output_type: 'stream', name: 'stdout', text: payload }],
        },
      ])
    );
    expect(notebook.cells[0]?.source.text).toBe(payload);
    expect(notebook.cells[1]?.source.text).toBe(payload);
    expect(notebook.cells[1]?.outputs[0]?.body).toMatchObject({
      kind: 'stream',
      spans: [{ text: payload }],
    });
  });

  test('bidi and control characters are written out, never left in the text', () => {
    const text = 'a\u202eb\u0007c\r\nd\te';
    expect(escapeInvisible(text)).toBe('a[U+202E]b[U+0007]c[U+000D]\nd\te');
    const notebook = ok(nb([{ cell_type: 'markdown', source: text }]));
    expect(notebook.cells[0]?.source.text).toBe('a[U+202E]b[U+0007]c\nd\te');
    expect(notebook.cells[0]?.source.text).not.toContain('\u202e');
  });

  test('a huge text is cut to the cap and marked', () => {
    const big = 'x'.repeat(NOTEBOOK_TEXT_MAX_CHARS + 50);
    const notebook = ok(
      nb([
        {
          cell_type: 'code',
          source: '',
          outputs: [{ output_type: 'stream', name: 'stdout', text: big }],
        },
      ])
    );
    const body = notebook.cells[0]?.outputs[0]?.body;
    expect(body).toMatchObject({ kind: 'stream', truncated: true });
    if (body?.kind !== 'stream') return;
    expect(body.spans[0]?.text.length).toBe(NOTEBOOK_TEXT_MAX_CHARS);
  });

  test('a cut that would split a surrogate pair drops the lone half', () => {
    const big = `${'x'.repeat(NOTEBOOK_TEXT_MAX_CHARS - 1)}😀`;
    const notebook = ok(nb([{ cell_type: 'markdown', source: big }]));
    const text = notebook.cells[0]?.source.text ?? '';
    expect(text.length).toBe(NOTEBOOK_TEXT_MAX_CHARS - 1);
    expect(text.charCodeAt(text.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
  });
});

describe('ANSI', () => {
  test('colours, emphasis and reset become spans; sequences are removed', () => {
    const spans = ansiSpans(
      '\u001b[1;31mred\u001b[0m plain \u001b[92mgreen\u001b[39m'
    );
    expect(spans).toEqual([
      {
        text: 'red',
        fg: 1,
        bg: undefined,
        bold: true,
        italic: false,
        underline: false,
      },
      {
        text: ' plain ',
        fg: undefined,
        bg: undefined,
        bold: false,
        italic: false,
        underline: false,
      },
      {
        text: 'green',
        fg: 10,
        bg: undefined,
        bold: false,
        italic: false,
        underline: false,
      },
    ]);
  });

  test('256-colour indices below 16 are kept; true colour is skipped', () => {
    const spans = ansiSpans(
      '\u001b[38;5;3mA\u001b[38;2;1;2;3mB\u001b[48;5;200mC'
    );
    expect(spans.map((s) => s.text).join('')).toBe('ABC');
    expect(spans[0]?.fg).toBe(3);
    expect(spans[2]?.bg).toBeUndefined();
  });

  test('malformed escapes never throw and never leave an escape in the text', () => {
    const cases = [
      '\u001b[31',
      '\u001b[',
      '\u001b',
      '\u001b[\u0001x',
      '\u001b]0;title',
      '\u001b]0;title\u0007after',
      '\u001b[999999999999999999999m',
      '\u001b[;m;;x',
      '\u001b[38;5m',
      '\u001b[38;5;99999mZ',
      '\u009b31mC1',
      '\u001bZ',
      '\u001b\u001b[1m',
      'tail\u001b',
    ];
    for (const text of cases) {
      const joined = ansiSpans(text)
        .map((span) => span.text)
        .join('');
      expect(joined.includes('\u001b')).toBe(false);
      expect(joined.includes('\u009b')).toBe(false);
    }
  });

  test('malformed escapes drop the sequence and keep the text that follows', () => {
    expect(
      ansiSpans('a\u001b[\u0001b')
        .map((s) => s.text)
        .join('')
    ).toBe('a[U+0001]b');
    expect(
      ansiSpans('x\u001b[31')
        .map((s) => s.text)
        .join('')
    ).toBe('x');
    expect(
      ansiSpans('\u001b]0;title\u0007after')
        .map((s) => s.text)
        .join('')
    ).toBe('after');
  });

  test('a traceback with unterminated escapes still parses the notebook', () => {
    const body = bodyOf(
      nb([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            {
              output_type: 'error',
              ename: 'E',
              evalue: 'v',
              traceback: ['\u001b[31'],
            },
          ],
        },
      ])
    );
    expect(body).toMatchObject({ kind: 'error', name: 'E' });
  });
});

describe('bounds', () => {
  test('a huge error traceback is cut and marked, bounded in time', () => {
    const big = `\u001b[31m${'e'.repeat(NOTEBOOK_TEXT_MAX_CHARS * 2)}`;
    const started = performance.now();
    const body = bodyOf(
      nb([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            { output_type: 'error', ename: 'E', evalue: 'v', traceback: [big] },
          ],
        },
      ])
    );
    const ms = performance.now() - started;
    expect(body).toMatchObject({ kind: 'error', truncated: true });
    console.log(`2 MiB traceback read in ${ms.toFixed(1)} ms`);
  });
});

describe('anchors', () => {
  const notebook = ok(
    nb([
      { cell_type: 'markdown', source: 'Intro text here' },
      {
        cell_type: 'code',
        source: 'print("hello")',
        outputs: [
          { output_type: 'stream', name: 'stdout', text: 'hello\n' },
          { output_type: 'stream', name: 'stdout', text: 'world' },
        ],
      },
    ])
  );

  test('a path names a cell or one of its outputs, and the pointer round-trips', () => {
    expect(
      notebookTarget(notebook, { kind: 'path', pointer: '/cells/1' })
    ).toEqual({ cell: 1 });
    const target = notebookTarget(notebook, {
      kind: 'path',
      pointer: '/cells/1/outputs/1',
    });
    expect(target).toEqual({ cell: 1, output: 1 });
    expect(notebookPointer({ cell: 1, output: 1 })).toBe('/cells/1/outputs/1');
    expect(notebookPointer({ cell: 1 })).toBe('/cells/1');
  });

  test('paths that do not name a held cell or output are refused', () => {
    for (const pointer of [
      '/cells/2',
      '/cells/01',
      '/cells/-1',
      '/cells/1/outputs/2',
      '/cells/1/source',
      '/cells/1/',
      '/metadata',
      'cells/1',
      '',
    ]) {
      expect(
        notebookTarget(notebook, { kind: 'path', pointer })
      ).toBeUndefined();
    }
  });

  test('a quote finds the cell or output that holds it', () => {
    expect(
      notebookTarget(notebook, { kind: 'quote', exact: 'Intro text' })
    ).toEqual({ cell: 0 });
    expect(notebookTarget(notebook, { kind: 'quote', exact: 'world' })).toEqual(
      { cell: 1, output: 1 }
    );
    expect(notebookTarget(notebook, { kind: 'text', quote: 'print' })).toEqual({
      cell: 1,
    });
  });

  test('a quote whose context does not match resolves to nothing', () => {
    expect(
      notebookTarget(notebook, {
        kind: 'quote',
        exact: 'Intro text',
        prefix: 'nope',
      })
    ).toBeUndefined();
    expect(
      notebookTarget(notebook, { kind: 'quote', exact: 'absent' })
    ).toBeUndefined();
  });

  test('a time anchor names nothing in a notebook', () => {
    expect(notebookTarget(notebook, { kind: 'time', t: 1 })).toBeUndefined();
  });
});
