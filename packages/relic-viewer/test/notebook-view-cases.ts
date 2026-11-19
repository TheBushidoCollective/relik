// The browser cases for the notebook view. They run in the page, as a module the
// test serves, so no function is serialised into a script tag. Every name the
// cases use is an argument, a fixture here, or a global.

import type * as BridgeModule from '../src/structured-view-bridge.ts';

// A 1x1 PNG, base64, as nbformat stores it.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// The first bytes of a JPEG, declared as a PNG: the signature refuses it.
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2w==';

// The mock's N1 notebook (docs/plans/structured-formats/mockup.html): markdown, a
// stream, a text result, a plot, a traceback with ANSI colour, and HTML output.
const N1 = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      cell_type: 'markdown',
      metadata: {},
      source: [
        '# Defect trends, Q3 2026\n',
        '\n',
        'Condition scores from the 1,284 field inspections in `inspections_2026-q3.csv`. Scores run 0 to 100; anything under 45 fails.',
      ],
    },
    {
      cell_type: 'code',
      execution_count: 1,
      metadata: {},
      source: ['import pandas as pd\n', 'print(f"Loaded {len(df):,} rows")'],
      outputs: [
        {
          output_type: 'stream',
          name: 'stdout',
          text: ['Loaded 1,284 rows from 8 sites\n'],
        },
      ],
    },
    {
      cell_type: 'code',
      execution_count: 2,
      metadata: {},
      source: 'df.groupby("site").describe()',
      outputs: [
        {
          output_type: 'execute_result',
          execution_count: 2,
          metadata: {},
          data: {
            'text/plain': 'count  mean  std\nBluebird Pass  158.0  66.4  17.9',
          },
        },
      ],
    },
    {
      cell_type: 'code',
      execution_count: 3,
      metadata: {},
      source: 'ax = weekly.plot()',
      outputs: [
        {
          output_type: 'display_data',
          metadata: {},
          data: { 'image/png': PNG_B64, 'text/plain': '<Figure>' },
        },
      ],
    },
    {
      cell_type: 'code',
      execution_count: 4,
      metadata: {},
      source: 'failing = df[df.conditon < 45]',
      outputs: [
        {
          output_type: 'error',
          ename: 'AttributeError',
          evalue: "'DataFrame' object has no attribute 'conditon'",
          traceback: [
            '\u001b[0;31m---------------------------------------------------------------------------\u001b[0m',
            '\u001b[0;31mAttributeError\u001b[0m: no attribute',
          ],
        },
      ],
    },
    {
      cell_type: 'code',
      execution_count: 5,
      metadata: {},
      source: 'failing.groupby("crew").size()',
      outputs: [
        {
          output_type: 'stream',
          name: 'stdout',
          text: 'crew\nHollis 3  61\nNorth Ridge 2  54\n',
        },
      ],
    },
    {
      cell_type: 'markdown',
      metadata: {},
      source: [
        '## What to send the crews\n',
        'Hollis 3 carries more than half the failures.',
      ],
    },
    {
      cell_type: 'code',
      execution_count: 6,
      metadata: {},
      source: 'failing.style.background_gradient()',
      outputs: [
        {
          output_type: 'execute_result',
          execution_count: 6,
          metadata: {},
          data: {
            'text/html':
              '<style>td{color:red}</style><script>alert(1)</script>',
            'text/plain': '<pandas.io.formats.style.Styler at 0x13f2a8d10>',
          },
        },
      ],
    },
  ],
};

// Markup in every place a notebook carries text: markdown, source, stream, error
// name and traceback, a withheld output, and metadata.
const HOSTILE = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { title: '<script>alert(9)</script>' },
  cells: [
    {
      cell_type: 'markdown',
      metadata: { note: '<img src=x onerror=alert(10)>' },
      source: [
        '<img src=x onerror="alert(1)"><script>alert(2)</script>\n',
        '<svg onload=alert(3)>',
      ],
    },
    {
      cell_type: 'code',
      execution_count: 1,
      metadata: {},
      source: '<img src=x onerror=alert(4)>',
      outputs: [
        {
          output_type: 'stream',
          name: 'stdout',
          text: '<iframe src="javascript:alert(5)"></iframe>',
        },
        {
          output_type: 'error',
          ename: '<b onmouseover=x>',
          evalue: '<script>alert(6)</script>',
          traceback: ['<img src=x onerror=alert(7)>', '\u001b[31mred\u001b[0m'],
        },
        {
          output_type: 'display_data',
          metadata: {},
          data: {
            'text/html':
              '<script>alert(8)</script><img src=x onerror=alert(8)>',
            'text/javascript': 'alert(11)',
          },
        },
      ],
    },
  ],
};

export const fixtures = {
  n1: JSON.stringify(N1),
  hostile: JSON.stringify(HOSTILE),
  badImage: JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        cell_type: 'code',
        execution_count: 1,
        metadata: {},
        source: '1',
        outputs: [
          {
            output_type: 'display_data',
            metadata: {},
            data: { 'image/png': JPEG_B64 },
          },
        ],
      },
    ],
  }),
  notANotebook: '{"cells": []}',
  huge: JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: Array.from({ length: 10_000 }, () => ({
      cell_type: 'markdown',
      metadata: {},
      source: ['x'],
    })),
  }),
  bidi: JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [{ cell_type: 'markdown', metadata: {}, source: 'a\u202eb' }],
  }),
};

// Runs in the page. Every name it uses is an argument or a global, because the
// function is serialised and sent to the browser as text.
export async function browserCases(
  bridge: typeof BridgeModule,
  fixtures: Record<string, string>,
  progress: (name: string) => Promise<unknown>
): Promise<string[]> {
  const passed: string[] = [];
  const eq = (actual: unknown, expected: unknown, label: string): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`
      );
  };
  const truth = (value: unknown, label: string): void => {
    if (!value) throw new Error(label);
  };
  const check = async (name: string, body: () => Promise<void> | void) => {
    await progress(name);
    await body();
    passed.push(name);
  };
  const mountNotebook = async (source: string, filename: string) => {
    const root = document.createElement('section');
    document.body.append(root);
    const handle = bridge.mountStructuredView(root, 'notebook', {
      filename,
      mimetype: 'application/x-ipynb+json',
      source,
      sourceView: () => {
        const pre = document.createElement('pre');
        pre.className = 'source';
        pre.textContent = source;
        return pre;
      },
    });
    await handle.ready;
    return { root, handle };
  };
  const cell = (root: HTMLElement, index: number): HTMLElement => {
    const item = root.querySelector<HTMLElement>(
      `li.nb-cell[data-cell="${index}"]`
    );
    if (item === null) throw new Error(`no cell ${index}`);
    return item;
  };
  const box = (root: HTMLElement, index: number): HTMLElement => {
    const found = cell(root, index).querySelector<HTMLElement>('.nb-box');
    if (found === null) throw new Error(`no box ${index}`);
    return found;
  };
  const outputOf = (
    root: HTMLElement,
    index: number,
    output: number
  ): HTMLElement => {
    const blocks = cell(root, index).querySelectorAll<HTMLElement>('.nb-out');
    const found = blocks[output];
    if (found === undefined) throw new Error(`no output ${index}/${output}`);
    return found;
  };
  const markCount = (element: Element): number =>
    element.querySelectorAll('.nb-mark, .nb-mark-n').length;

  await check(
    'N1: markdown, code, stream, image, text, traceback and HTML draw',
    async () => {
      const { root, handle } = await mountNotebook(
        fixtures['n1'] ?? '',
        'defect-trends.ipynb'
      );
      eq(handle.structured, true, 'the notebook view is drawn');
      eq(root.querySelectorAll('li.nb-cell').length, 8, 'eight cells');
      truth(
        root.querySelector('h1')?.textContent === 'Defect trends, Q3 2026',
        'markdown heading renders'
      );
      eq(
        cell(root, 1).querySelector('.nb-gutter')?.textContent,
        'In [1]:',
        'execution count gutter'
      );
      eq(
        outputOf(root, 1, 0).classList.contains('is-stream'),
        true,
        'stream output'
      );
      eq(
        outputOf(root, 2, 0).querySelector('.nb-out-kind')?.textContent,
        'text/plain',
        'text output label'
      );
      const img = outputOf(root, 3, 0).querySelector<HTMLImageElement>('img');
      truth(img?.src.startsWith('blob:') === true, 'the plot is a blob image');
      truth(
        outputOf(root, 4, 0).classList.contains('is-error'),
        'error output'
      );
      truth(
        outputOf(root, 4, 0).querySelector('.ansi-fg-1') !== null,
        'traceback colour becomes a class, not a style'
      );
      truth(
        !outputOf(root, 4, 0).textContent?.includes('\u001b'),
        'no escape reaches the DOM'
      );
      handle.dispose();
      root.remove();
    }
  );

  await check(
    'N2: HTML output is withheld, and Show as text reveals the fallback',
    async () => {
      const { root, handle } = await mountNotebook(
        fixtures['n1'] ?? '',
        'defect-trends.ipynb'
      );
      const placeholder = outputOf(root, 7, 0);
      truth(
        placeholder.classList.contains('is-placeholder'),
        'placeholder class'
      );
      truth(
        placeholder.textContent?.includes(
          'This output is HTML (or a widget) and is not run here.'
        ),
        'placeholder text'
      );
      truth(
        root.querySelector('script') === null,
        'the HTML script is not created'
      );
      placeholder.querySelector<HTMLButtonElement>('.nb-show-text')?.click();
      const shown = outputOf(root, 7, 0);
      truth(
        !shown.classList.contains('is-placeholder'),
        'after the click the placeholder is gone'
      );
      truth(
        shown.textContent?.includes(
          '<pandas.io.formats.style.Styler at 0x13f2a8d10>'
        ),
        'the text/plain fallback is shown as text'
      );
      handle.dispose();
      root.remove();
    }
  );

  await check(
    'hostile markup in markdown, source, outputs and metadata creates no element',
    async () => {
      const { root, handle } = await mountNotebook(
        fixtures['hostile'] ?? '',
        'hostile.ipynb'
      );
      eq(
        root.querySelectorAll('script, svg, iframe, object, embed, img').length,
        0,
        'no element of an active or image kind'
      );
      eq(
        root.querySelectorAll('[onerror], [onload], [onmouseover]').length,
        0,
        'no event attribute'
      );
      truth(
        root.textContent?.includes('<img src=x onerror="alert(1)">'),
        'markup shows as text'
      );
      truth(
        root.textContent?.includes(`<${'/'}script>alert(8)<${'/'}script>`) ===
          false,
        'withheld HTML is not even shown as source until asked'
      );
      handle.dispose();
      root.remove();
    }
  );

  await check(
    'an image whose bytes disagree with its type is refused and drawn nowhere',
    async () => {
      const { root, handle } = await mountNotebook(
        fixtures['badImage'] ?? '',
        'bad-image.ipynb'
      );
      truth(
        outputOf(root, 0, 0).classList.contains('is-image-refused'),
        'refused image block'
      );
      truth(
        outputOf(root, 0, 0).textContent?.includes(
          'This image output could not be shown.'
        ),
        'the refusal says so'
      );
      eq(root.querySelectorAll('img').length, 0, 'no image element');
      handle.dispose();
      root.remove();
    }
  );

  await check(
    'select cell 2 -> path anchor -> mark painted on the cell, cleared again',
    async () => {
      const { root, handle } = await mountNotebook(
        fixtures['n1'] ?? '',
        'defect-trends.ipynb'
      );
      box(root, 2).click();
      const anchor = handle.selectionAnchor();
      eq(
        anchor,
        { kind: 'path', pointer: '/cells/2' },
        'the selected cell anchors to its pointer'
      );
      eq(handle.paintMark(anchor as never, 'c1'), true, 'the mark lands');
      truth(
        box(root, 2).classList.contains('is-commented'),
        'the cell is marked'
      );
      eq(markCount(box(root, 2)), 1, 'one corner mark');
      handle.paintMark(anchor as never, 'c2');
      eq(
        box(root, 2).querySelector('.nb-mark-n')?.textContent,
        '2',
        'two remarks count in the corner'
      );
      handle.clearMarks();
      eq(markCount(box(root, 2)), 0, 'clearing removes the marks');
      handle.dispose();
      root.remove();
    }
  );

  await check(
    'a quote inside a cell marks the markdown cell or the output that holds it',
    async () => {
      const { root, handle } = await mountNotebook(
        fixtures['n1'] ?? '',
        'defect-trends.ipynb'
      );
      eq(
        handle.paintMark({ kind: 'quote', exact: 'Condition scores' }, 'q1'),
        true,
        'the quote lands on the markdown cell'
      );
      truth(
        box(root, 0).classList.contains('is-commented'),
        'cell 0 is marked'
      );
      eq(
        handle.paintMark({ kind: 'quote', exact: 'Loaded 1,284' }, 'q2'),
        true,
        'the quote lands on the stream output'
      );
      truth(
        outputOf(root, 1, 0).querySelector('.nb-mark') !== null,
        'the output carries the mark'
      );
      eq(
        handle.paintMark(
          { kind: 'quote', exact: 'not in this notebook' },
          'q3'
        ),
        false,
        'a quote that is not held paints nothing'
      );
      handle.dispose();
      root.remove();
    }
  );

  await check(
    'the Comment buttons send path anchors for a cell and for an output',
    async () => {
      const { root, handle } = await mountNotebook(
        fixtures['n1'] ?? '',
        'defect-trends.ipynb'
      );
      const seen: unknown[] = [];
      root.addEventListener('relic:structured-comment', (event) => {
        seen.push((event as CustomEvent).detail.anchor);
      });
      box(root, 3).querySelector<HTMLButtonElement>('.nb-comment')?.click();
      outputOf(root, 1, 0)
        .querySelector<HTMLButtonElement>('.nb-comment')
        ?.click();
      eq(
        seen,
        [
          { kind: 'path', pointer: '/cells/3' },
          { kind: 'path', pointer: '/cells/1/outputs/0' },
        ],
        'both buttons say where they are'
      );
      handle.dispose();
      root.remove();
    }
  );

  await check(
    'reveal scrolls to the anchored output and marks it active',
    async () => {
      const { root, handle } = await mountNotebook(
        fixtures['n1'] ?? '',
        'defect-trends.ipynb'
      );
      handle.paintMark({ kind: 'path', pointer: '/cells/5/outputs/0' }, 'r1');
      handle.reveal({ kind: 'path', pointer: '/cells/5/outputs/0' }, 'r1');
      truth(
        outputOf(root, 5, 0).classList.contains('is-active'),
        'the output is active'
      );
      truth(
        outputOf(root, 5, 0).classList.contains('is-selected'),
        'reveal selects it'
      );
      handle.dispose();
      root.remove();
    }
  );

  await check(
    'N5: a file that is not a notebook shows the reason above its source',
    async () => {
      const { root, handle } = await mountNotebook(
        fixtures['notANotebook'] ?? '',
        'crew-export.ipynb'
      );
      eq(handle.structured, false, 'the view is not drawn');
      eq(
        root.querySelector('.structured-notice')?.textContent,
        "This file is named like a notebook, but it isn't one, so its text is shown.",
        'the reason is the notice'
      );
      truth(root.querySelector('pre.source') !== null, 'the source is shown');
      handle.dispose();
      root.remove();
    }
  );

  await check(
    'N5: 10,000 cells show the too-large notice and the source, with the time recorded',
    async () => {
      const started = performance.now();
      const { root, handle } = await mountNotebook(
        fixtures['huge'] ?? '',
        'huge.ipynb'
      );
      const ms = performance.now() - started;
      eq(handle.structured, false, 'the view is not drawn');
      truth(
        root
          .querySelector('.structured-notice')
          ?.textContent?.includes('too large to show as a notebook'),
        'the too-large notice'
      );
      truth(root.querySelector('pre.source') !== null, 'the source is shown');
      await progress(
        `timing: 10,000-cell notebook refused and shown in ${ms.toFixed(1)} ms`
      );
      handle.dispose();
      root.remove();
    }
  );

  await check('N6: at 390 px the cells fit their container', async () => {
    const wrap = document.createElement('div');
    wrap.style.width = '390px';
    document.body.append(wrap);
    const { root, handle } = await mountNotebook(
      fixtures['n1'] ?? '',
      'defect-trends.ipynb'
    );
    wrap.append(root);
    const list = root.querySelector<HTMLElement>('ol.nb');
    truth(list !== null, 'the list is drawn');
    const width = list?.getBoundingClientRect().width ?? 0;
    truth(width <= 390, `the list is ${width} px wide`);
    truth(
      (list?.scrollWidth ?? 0) <= (list?.clientWidth ?? 0) + 1,
      `the list scrolls sideways (${list?.scrollWidth} > ${list?.clientWidth})`
    );
    handle.dispose();
    wrap.remove();
  });

  await check(
    'a bidi character in markdown draws as a visible escape',
    async () => {
      const { root, handle } = await mountNotebook(
        fixtures['bidi'] ?? '',
        'bidi.ipynb'
      );
      truth(root.textContent?.includes('a[U+202E]b'), 'the escape is visible');
      truth(
        !root.textContent?.includes('\u202e'),
        'the character is not drawn'
      );
      handle.dispose();
      root.remove();
    }
  );

  return passed;
}
