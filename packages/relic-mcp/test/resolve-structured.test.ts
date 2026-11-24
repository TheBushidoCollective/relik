import { describe, expect, test } from 'bun:test';
import type { CellCommentAnchor, PathCommentAnchor } from '@relic/format';
import type { CommentRecord } from '../src/comments.ts';
import { commentTranscript, resolutionLine } from '../src/server.ts';
import {
  CELL_HEADER_LIMIT_BYTES,
  CELL_TEXT_LIMIT_BYTES,
  PATH_EXCERPT_LIMIT_BYTES,
  type StructuredReader,
  TIME_CUE_LIMIT,
  capBytes,
  structuredKindOf,
  structuredReaderFor,
  subtitleClock,
} from '../src/resolve-structured.ts';
import {
  resolveStructuredComment,
  type VersionContent,
} from '../src/resolve-structured-comment.ts';
import { jsonLine } from '../src/untrusted-text.ts';

const encoder = new TextEncoder();

function reader(
  text: string,
  filename: string,
  mimetype = ''
): StructuredReader {
  return structuredReaderFor(encoder.encode(text), filename, mimetype);
}

function cell(
  row: number,
  col: number,
  end?: { row_end: number; col_end: number }
): CellCommentAnchor {
  return end === undefined
    ? { kind: 'cell', row, col }
    : { kind: 'cell', row, col, row_end: end.row_end, col_end: end.col_end };
}

function path(pointer: string): PathCommentAnchor {
  return { kind: 'path', pointer };
}

function utf8(text: string): number {
  return encoder.encode(text).length;
}

function commentOn(
  anchor: CommentRecord['anchor'],
  version: number | null
): CommentRecord {
  return {
    comment_id: 'c1',
    author: 'publisher',
    created_at: '2026-11-19T00:00:00Z',
    display_name: null,
    body: 'look here',
    anchor,
    addresses: null,
    suggestion: null,
    suggestion_outcome: null,
    suggestion_state: null,
    suggestion_answer: null,
    unsupported_fields: [],
    readable: true,
    unreadable_reason: null,
    addressed: false,
    addressed_by: null,
    version,
    edited_at: null,
    resolution: null,
  } as CommentRecord;
}

describe('structuredKindOf', () => {
  test('routes by extension first, then by declared type', () => {
    expect(structuredKindOf('a.csv', '')).toBe('table');
    expect(structuredKindOf('a.TSV', '')).toBe('table');
    expect(structuredKindOf('a.json', 'text/csv')).toBe('json');
    expect(structuredKindOf('a.ipynb', 'application/json')).toBe('notebook');
    expect(structuredKindOf('a.srt', '')).toBe('subtitles');
    expect(structuredKindOf('noext', 'text/vtt; charset=utf-8')).toBe(
      'subtitles'
    );
    expect(structuredKindOf('a.bin', 'application/octet-stream')).toBe('other');
  });
});

describe('capBytes', () => {
  test('cuts on a code point boundary within the byte budget', () => {
    const capped = capBytes('€'.repeat(400), 512);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toBe('€'.repeat(170));
    expect(utf8(capped.text)).toBeLessThanOrEqual(512);
  });

  test('leaves text within budget alone', () => {
    expect(capBytes('short', 512)).toEqual({ text: 'short', truncated: false });
  });
});

describe('cell anchors on CSV and TSV', () => {
  test('a single cell reports its text, its column header and its line', () => {
    const resolved = reader('name,qty\nwidget,3\n', 'parts.csv').cell(
      cell(2, 2)
    );
    expect(resolved).toEqual({
      kind: 'cell',
      status: 'resolved',
      text: '3',
      text_truncated: false,
      header: 'qty',
      header_truncated: false,
      line: 2,
    });
  });

  test('a header cell is row 1, and its header is its own text', () => {
    const resolved = reader('name,qty\nwidget,3\n', 'parts.csv').cell(
      cell(1, 1)
    );
    expect(resolved).toMatchObject({
      status: 'resolved',
      text: 'name',
      header: 'name',
      line: 1,
    });
  });

  test('a range reports the top-left text and the inclusive extent', () => {
    const resolved = reader('a,b\nc,d\ne,f\n', 'r.csv').cell(
      cell(2, 1, { row_end: 3, col_end: 2 })
    );
    expect(resolved).toMatchObject({
      status: 'resolved',
      text: 'c',
      line: 2,
      range: { row_end: 3, col_end: 2 },
    });
  });

  test('a quoted multi-line cell keeps its line break, and later lines count the physical lines', () => {
    const source = 'a,"x\ny",c\nd,e,f\n';
    const inside = reader(source, 'q.csv').cell(cell(1, 2));
    expect(inside).toMatchObject({ status: 'resolved', text: 'x\ny', line: 1 });
    const after = reader(source, 'q.csv').cell(cell(2, 1));
    expect(after).toMatchObject({ status: 'resolved', text: 'd', line: 3 });
  });

  test('a byte order mark does not shift the first cell', () => {
    const resolved = reader('\uFEFFname,qty\nw,3', 'bom.csv').cell(cell(1, 1));
    expect(resolved).toMatchObject({
      status: 'resolved',
      text: 'name',
      header: 'name',
    });
  });

  test.each([
    ['CSV', 'bom.csv', ','],
    ['TSV', 'bom.tsv', '\t'],
  ] as const)(
    'resolves %s cells after decoding only the first BOM',
    (_, filename, delimiter) => {
      const source =
        `\uFEFF\uFEFF"alpha${delimiter}beta"${delimiter}x\r\n` +
        `row${delimiter}value${delimiter}last\r\n`;
      const table = reader(source, filename);
      expect(table.cell(cell(1, 1))).toMatchObject({
        status: 'resolved',
        text: '\uFEFF"alpha',
        header: '\uFEFF"alpha',
        line: 1,
      });
      expect(table.cell(cell(1, 2))).toMatchObject({
        status: 'resolved',
        text: 'beta"',
        header: 'beta"',
        line: 1,
      });
      expect(table.cell(cell(1, 3))).toMatchObject({
        status: 'resolved',
        text: 'x',
        header: 'x',
        line: 1,
      });
      expect(table.cell(cell(2, 2))).toMatchObject({
        status: 'resolved',
        text: 'value',
        header: 'beta"',
        line: 2,
      });
    }
  );

  test('a TSV file splits on tabs, even when a cell holds a comma', () => {
    const resolved = reader('a\tb,c\n1\t2\n', 'data.tsv').cell(cell(1, 2));
    expect(resolved).toMatchObject({ status: 'resolved', text: 'b,c' });
  });

  test('a ragged row has no cell past its end, so the cell is not found in this version', () => {
    const resolved = reader('a,b,c\n1\n', 'r.csv').cell(cell(2, 2));
    expect(resolved).toEqual({
      kind: 'cell',
      status: 'unresolvable',
      explanation:
        'The cell is not found in this version: row 2 has 1 cell(s), so column 2 is past its end.',
    });
  });

  test('a row past the end of the file is not found', () => {
    const resolved = reader('a,b\nc,d\n', 'r.csv').cell(cell(9, 1));
    expect(resolved).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining(
        'row 9 is past the end of the file, which has 2 row(s)'
      ),
    });
  });

  test('a column past the widest row is not found', () => {
    const resolved = reader('a,b\nc,d\n', 'r.csv').cell(cell(1, 9));
    expect(resolved).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining('column 9 is past the widest row'),
    });
  });

  test('a range that runs past the file is not found, and one that ends before it starts too', () => {
    const past = reader('a,b\nc,d\n', 'r.csv').cell(
      cell(1, 1, { row_end: 5, col_end: 1 })
    );
    expect(past).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining('past the end of the file'),
    });
    const backwards = reader('a,b\nc,d\n', 'r.csv').cell(
      cell(2, 2, { row_end: 1, col_end: 2 })
    );
    expect(backwards).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining('ends before it starts'),
    });
  });

  test('a sheet name on a CSV is not found, because CSV has no sheets', () => {
    const anchor: CellCommentAnchor = {
      kind: 'cell',
      row: 1,
      col: 1,
      sheet: 'Q3',
    };
    expect(reader('a,b\n', 'r.csv').cell(anchor)).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining('a CSV or TSV file has no sheets'),
    });
  });

  test('an unclosed quote refuses the table with its line', () => {
    const resolved = reader('a,"b\nc,d\n', 'bad.csv').cell(cell(1, 1));
    expect(resolved).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining(
        'a quote opened on line 1 is never closed'
      ),
    });
  });

  test('a cell anchor on a non-table file is not found', () => {
    expect(reader('{"a":1}', 'x.json').cell(cell(1, 1))).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining(
        'resolves only against CSV and TSV files'
      ),
    });
  });

  test('a one-megabyte cell is capped to 512 bytes and marked', () => {
    const huge = 'x'.repeat(1_000_000);
    const resolved = reader(`a,"${huge}"\n`, 'big.csv').cell(cell(1, 2));
    if (resolved.status !== 'resolved')
      throw new Error('expected a resolved cell');
    expect(utf8(resolved.text)).toBe(CELL_TEXT_LIMIT_BYTES);
    expect(resolved.text_truncated).toBe(true);
  });

  test('a long header is capped to 128 bytes', () => {
    const resolved = reader(`${'h'.repeat(300)},b\n1,2\n`, 'h.csv').cell(
      cell(2, 1)
    );
    if (resolved.status !== 'resolved')
      throw new Error('expected a resolved cell');
    expect(utf8(resolved.header)).toBe(CELL_HEADER_LIMIT_BYTES);
    expect(resolved.header_truncated).toBe(true);
  });
});

describe('path anchors on JSON', () => {
  test('a nested value reports its kind, its source excerpt and its line', () => {
    const resolved = reader('{"a":{"b":[1,"two"]}}', 'd.json').path(
      path('/a/b')
    );
    expect(resolved).toEqual({
      kind: 'path',
      status: 'resolved',
      type: 'array',
      excerpt: '[1,"two"]',
      excerpt_truncated: false,
      line: 1,
    });
  });

  test('a string excerpt is its decoded value', () => {
    const resolved = reader('{"s":"x\\u0041"}', 'd.json').path(path('/s'));
    expect(resolved).toMatchObject({
      status: 'resolved',
      type: 'string',
      excerpt: 'xA',
    });
  });

  test('a duplicate key resolves to its last occurrence, as JSON.parse keeps it', () => {
    const resolved = reader('{"a":1,"a":2}', 'd.json').path(path('/a'));
    expect(resolved).toMatchObject({
      status: 'resolved',
      type: 'number',
      excerpt: '2',
    });
  });

  test('RFC 6901 escapes address keys that hold a slash or a tilde', () => {
    const source = '{"a/b":1,"m~n":2}';
    expect(reader(source, 'd.json').path(path('/a~1b'))).toMatchObject({
      status: 'resolved',
      excerpt: '1',
    });
    expect(reader(source, 'd.json').path(path('/m~0n'))).toMatchObject({
      status: 'resolved',
      excerpt: '2',
    });
  });

  test('the empty pointer is the whole document', () => {
    expect(reader('{\n"a":1\n}', 'd.json').path(path(''))).toMatchObject({
      status: 'resolved',
      type: 'object',
      line: 1,
    });
  });

  test('the line is where the addressed member starts', () => {
    expect(
      reader('{\n"a":1,\n"c":3}', 'd.json').path(path('/c'))
    ).toMatchObject({
      status: 'resolved',
      line: 3,
    });
  });

  test('a missing path is not found in this version', () => {
    expect(reader('{"a":1}', 'd.json').path(path('/nope'))).toEqual({
      kind: 'path',
      status: 'unresolvable',
      explanation:
        'The path is not found in this version: no value sits at that path in this version.',
    });
  });

  test('a pointer that is not a pointer is refused as not found', () => {
    for (const pointer of ['a', '/a~2', '/a~']) {
      expect(reader('{"a":1}', 'd.json').path(path(pointer))).toMatchObject({
        status: 'unresolvable',
        explanation: expect.stringContaining('not a valid JSON pointer'),
      });
    }
  });

  test('a file that is not JSON is refused with its syntax position', () => {
    expect(reader('{"a":1,}', 'bad.json').path(path('/a'))).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining(
        'cannot be read as JSON (line 1, column'
      ),
    });
  });

  test('a long value is cut to 512 bytes and marked', () => {
    const source = `{"s":"${'x'.repeat(2000)}"}`;
    const resolved = reader(source, 'd.json').path(path('/s'));
    if (resolved.status !== 'resolved')
      throw new Error('expected a resolved path');
    expect(utf8(resolved.excerpt)).toBe(PATH_EXCERPT_LIMIT_BYTES);
    expect(resolved.excerpt_truncated).toBe(true);
  });

  test('a path anchor on a CSV file is not found', () => {
    expect(reader('a,b\n', 'r.csv').path(path('/a'))).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining(
        'resolves only against JSON and notebook files'
      ),
    });
  });
});

const notebook = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Title\n', 'body'] },
    {
      cell_type: 'code',
      execution_count: 1,
      metadata: {},
      source: ['print(1)'],
      outputs: [
        { output_type: 'stream', name: 'stdout', text: ['1\n'] },
        {
          output_type: 'execute_result',
          execution_count: 1,
          metadata: {},
          data: { 'text/plain': '42' },
        },
      ],
    },
  ],
});

describe('path anchors on notebooks', () => {
  test('a markdown cell reports cell_type markdown and its line', () => {
    expect(reader(notebook, 'n.ipynb').path(path('/cells/0'))).toMatchObject({
      status: 'resolved',
      type: 'cell',
      cell_type: 'markdown',
      excerpt: expect.stringContaining('Title'),
      line: expect.any(Number),
    });
  });

  test('a code cell reports cell_type code', () => {
    expect(reader(notebook, 'n.ipynb').path(path('/cells/1'))).toMatchObject({
      status: 'resolved',
      type: 'cell',
      cell_type: 'code',
      excerpt: 'print(1)',
    });
  });

  test('a stream output reports its output type and its containing cell type', () => {
    expect(
      reader(notebook, 'n.ipynb').path(path('/cells/1/outputs/0'))
    ).toMatchObject({
      status: 'resolved',
      type: 'output',
      cell_type: 'code',
      output_type: 'stream',
      excerpt: '1\n',
    });
  });

  test('a plain-text execute result is its text/plain value', () => {
    expect(
      reader(notebook, 'n.ipynb').path(path('/cells/1/outputs/1'))
    ).toMatchObject({
      status: 'resolved',
      output_type: 'execute_result',
      excerpt: '42',
    });
  });

  test('a cell past the end, an output past the end, a non-canonical index and a non-cell path are not found', () => {
    const nb = reader(notebook, 'n.ipynb');
    for (const pointer of [
      '/cells/2',
      '/cells/1/outputs/9',
      '/cells/01',
      '/metadata',
    ]) {
      expect(nb.path(path(pointer))).toMatchObject({
        status: 'unresolvable',
        explanation: expect.stringContaining(
          'no cell or output sits at that path'
        ),
      });
    }
  });

  test('a notebook that is not nbformat 4 is refused', () => {
    const v3 = JSON.stringify({ nbformat: 3, nbformat_minor: 0, cells: [] });
    expect(reader(v3, 'old.ipynb').path(path('/cells/0'))).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining('it is not nbformat 4'),
    });
  });
});

const srt = [
  '1',
  '00:00:00,000 --> 00:00:02,000',
  'alpha',
  '',
  '2',
  '00:00:01,000 --> 00:00:03,000',
  'beta',
  '',
  '3',
  '00:00:05,000 --> 00:00:06,000',
  'gamma',
  '',
].join('\n');

describe('time anchors on SRT and VTT', () => {
  test('a point inside two overlapping cues matches both, in file order', () => {
    const resolved = reader(srt, 'a.srt').subtitleTime({
      kind: 'time',
      t: 1.5,
    });
    if (resolved.status !== 'resolved')
      throw new Error('expected a resolved time');
    expect(resolved.cue_count).toBe(2);
    expect(resolved.cues.map((cue) => cue.text)).toEqual(['alpha', 'beta']);
    expect(resolved.cues_truncated).toBe(false);
    expect(resolved.explanation).toBe('2 subtitle cue(s) cover 00:00:01.500.');
  });

  test('a cue ends before its end time: a point on that end belongs to the next cue only', () => {
    const resolved = reader(srt, 'a.srt').subtitleTime({ kind: 'time', t: 2 });
    if (resolved.status !== 'resolved')
      throw new Error('expected a resolved time');
    expect(resolved.cues.map((cue) => cue.text)).toEqual(['beta']);
  });

  test('a span matches every cue it overlaps', () => {
    const resolved = reader(srt, 'a.srt').subtitleTime({
      kind: 'time',
      t: 0.5,
      t_end: 5.5,
    });
    if (resolved.status !== 'resolved')
      throw new Error('expected a resolved time');
    expect(resolved.cues.map((cue) => cue.text)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
    expect(resolved.explanation).toBe(
      '3 subtitle cue(s) cover 00:00:00.500 to 00:00:05.500.'
    );
  });

  test('a time no cue covers is not found', () => {
    expect(reader(srt, 'a.srt').subtitleTime({ kind: 'time', t: 4 })).toEqual({
      kind: 'time',
      status: 'unresolvable',
      explanation:
        'The time is not found in this version: no subtitle cue covers 00:00:04.000.',
    });
  });

  test('a span that ends before it starts is not found', () => {
    expect(
      reader(srt, 'a.srt').subtitleTime({ kind: 'time', t: 3, t_end: 1 })
    ).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining('the span ends before it starts'),
    });
  });

  test('VTT takes its speaker from a voice tag and skips NOTE blocks in the cue count', () => {
    const vtt = [
      'WEBVTT',
      '',
      'NOTE this is a note',
      '',
      '00:00:00.000 --> 00:00:02.000',
      '<v Ann>hello</v>',
      '',
      '00:00:00.500 --> 00:00:01.500',
      'world',
      '',
    ].join('\n');
    const resolved = reader(vtt, 'v.vtt').subtitleTime({ kind: 'time', t: 1 });
    if (resolved.status !== 'resolved')
      throw new Error('expected a resolved time');
    expect(resolved.cues).toEqual([
      expect.objectContaining({
        index: 1,
        speaker: 'Ann',
        text: 'hello',
        text_truncated: false,
      }),
      expect.objectContaining({ index: 2, text: 'world' }),
    ]);
  });

  test('more than twenty matches keep the first twenty and count all of them', () => {
    const blocks: string[] = [];
    for (let n = 1; n <= 25; n++) {
      blocks.push(`${n}\n00:00:10,000 --> 00:00:11,000\ncue ${n}\n`);
    }
    const resolved = reader(blocks.join('\n'), 'many.srt').subtitleTime({
      kind: 'time',
      t: 10.5,
    });
    if (resolved.status !== 'resolved')
      throw new Error('expected a resolved time');
    expect(resolved.cue_count).toBe(25);
    expect(resolved.cues).toHaveLength(TIME_CUE_LIMIT);
    expect(resolved.cues_truncated).toBe(true);
    expect(resolved.cues[19]?.text).toBe('cue 20');
  });

  test('hostile cue text is kept as literal text, never an element', () => {
    const hostile =
      '1\n00:00:00,000 --> 00:00:02,000\n<img src=x onerror=alert(1)>\n';
    const resolved = reader(hostile, 'h.srt').subtitleTime({
      kind: 'time',
      t: 1,
    });
    if (resolved.status !== 'resolved')
      throw new Error('expected a resolved time');
    expect(resolved.cues[0]?.text).toBe('<img src=x onerror=alert(1)>');
  });

  test('a subtitle file with no readable cue is refused', () => {
    expect(
      reader('WEBVTT\n\nNOTE only\n', 'n.vtt').subtitleTime({
        kind: 'time',
        t: 1,
      })
    ).toMatchObject({
      status: 'unresolvable',
      explanation: expect.stringContaining('it has no readable cue'),
    });
  });

  test('a clock is hh:mm:ss.mmm', () => {
    expect(subtitleClock(3661.25)).toBe('01:01:01.250');
  });
});

describe('versions', () => {
  const csvVersion = (text: string): VersionContent => ({
    envelope: { entries: [{ filename: 'parts.csv', mimetype: 'text/csv' }] },
    content: encoder.encode(text),
  });

  test('a comment resolves against the version it was written on, and only that one', async () => {
    const asked: number[] = [];
    const load = async (version: number) => {
      asked.push(version);
      return version === 2
        ? ({ ok: true, opened: csvVersion('name,qty\nold,1\n') } as const)
        : ({ ok: true, opened: csvVersion('name,qty\nnew,9\n') } as const);
    };
    const resolved = await resolveStructuredComment(
      commentOn(cell(2, 1), 2),
      cell(2, 1),
      load
    );
    expect(asked).toEqual([2]);
    expect(resolved.resolved).toMatchObject({
      status: 'resolved',
      text: 'old',
    });
  });

  test('a version the service cannot give back is not found in this version', async () => {
    const load = async () =>
      ({
        ok: false,
        error: 'Relik was not found or has expired on the service.',
      }) as const;
    const resolved = await resolveStructuredComment(
      commentOn(cell(2, 1), 7),
      cell(2, 1),
      load
    );
    expect(resolved.resolved).toEqual({
      kind: 'cell',
      status: 'unresolvable',
      explanation:
        'The cell is not found in this version: Relik was not found or has expired on the service.',
    });
  });

  test('a comment that records no version is not found, rather than read against the current file', async () => {
    let fetches = 0;
    const load = async () => {
      fetches += 1;
      return { ok: true, opened: csvVersion('a\n') } as const;
    };
    const resolved = await resolveStructuredComment(
      commentOn(path('/a'), null),
      path('/a'),
      load
    );
    expect(fetches).toBe(0);
    expect(resolved.resolved).toMatchObject({
      kind: 'path',
      status: 'unresolvable',
      explanation: expect.stringContaining('the comment records no version'),
    });
  });
});

describe('hostile text in transcripts', () => {
  test('jsonLine escapes bidi, ANSI and C1 controls, and leaves plain text readable', () => {
    const line = jsonLine('a\u202eb\u001b[31m\u0085c');
    expect(line).toBe('"a\\u202eb\\u001b[31m\\u0085c"');
    expect(line).not.toContain('\u202e');
    expect(line).not.toContain('\u001b');
  });

  test('a cell carrying markup, ANSI and bidi prints JSON-encoded, with no raw control', () => {
    const payload = '<img src=x onerror=alert(1)>\u001b[31mred\u202e';
    const resolved = reader(`"${payload}"\n`, 'h.csv').cell(cell(1, 1));
    const out = resolutionLine(resolved);
    expect(out).toContain(jsonLine(payload));
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u202e');
    expect(out).toContain('\\u202e');
  });

  test('a one-megabyte cell prints at most 512 bytes of text, with a cut note', () => {
    const resolved = reader(`"${'x'.repeat(1_000_000)}"\n`, 'big.csv').cell(
      cell(1, 1)
    );
    const out = resolutionLine(resolved);
    expect(out.length).toBeLessThan(1200);
    expect(out).toContain('(cut to 512 bytes)');
  });

  test('a path excerpt and a cue list print JSON-encoded and capped', () => {
    const pathOut = resolutionLine(
      reader('{"s":"\\u202e\\u001b"}', 'd.json').path(path('/s'))
    );
    expect(pathOut).toContain('"\\u202e\\u001b"');
    expect(pathOut).not.toContain('\u202e');

    const blocks: string[] = [];
    for (let n = 1; n <= 22; n++) {
      blocks.push(`${n}\n00:00:10,000 --> 00:00:11,000\n<b>cue ${n}</b>\n`);
    }
    const cues = reader(blocks.join('\n'), 'many.srt').subtitleTime({
      kind: 'time',
      t: 10.5,
    });
    const cueOut = resolutionLine(cues);
    expect(cueOut).toContain('cue 1, line 1, 00:00:10.000 to 00:00:11.000');
    expect(cueOut).toContain('2 more matching cue(s) not shown.');
  });

  test('a comment transcript names a not-found cell in a resolution note', () => {
    const resolved = reader('a,b\n', 'r.csv').cell(cell(9, 9));
    const transcript = commentTranscript({
      relic_id: 'r1',
      count: 1,
      unreadable_count: 0,
      summary: { total: 1, addressed: 0, open: 1, resolved: 0, unreadable: 0 },
      comments: [{ ...commentOn(cell(9, 9), 1), resolved }],
      version_scope: 1,
      current_version: 1,
      hidden_by_scope: 0,
    });
    expect(transcript).toContain(
      '[Resolution note: The cell is not found in this version:'
    );
  });
});
