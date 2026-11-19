import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { escapeHtml, renderMarkdown } from '../src/markdown.ts';
import {
  codeSegments,
  renderMarkdownWithSource,
  type MarkdownWithSource,
} from '../src/markdown-source.ts';

const segmentPattern = /<span data-seg="(\d+)">([^<]*)<\/span>/g;

function withoutSegments(html: string): string {
  return html.replace(segmentPattern, '$2');
}

function check(source: string, label: string): MarkdownWithSource {
  const result = renderMarkdownWithSource(source);
  const actual = withoutSegments(result.html);
  const expected = renderMarkdown(source);
  if (actual !== expected) {
    let at = 0;
    while (at < actual.length && actual[at] === expected[at]) at++;
    throw new Error(
      `${label}: renderer mismatch at ${at}; source=${JSON.stringify(source.slice(0, 400))}; expected=${JSON.stringify(expected.slice(Math.max(0, at - 80), at + 120))}; actual=${JSON.stringify(actual.slice(Math.max(0, at - 80), at + 120))}`
    );
  }

  const spans = [...result.html.matchAll(segmentPattern)];
  if (spans.length !== result.segments.length) {
    throw new Error(
      `${label}: ${spans.length} spans for ${result.segments.length} segments`
    );
  }
  let previous = 0;
  for (let i = 0; i < result.segments.length; i++) {
    const segment = result.segments[i]!;
    const span = spans[i]!;
    const slice = source.slice(segment.start, segment.end);
    if (span[1] !== String(i) || span[2] !== escapeHtml(segment.text)) {
      throw new Error(
        `${label}: span ${i} does not encode its segment: ${JSON.stringify({ segment, span: span[0] })}`
      );
    }
    if (
      segment.start < previous ||
      segment.end < segment.start ||
      segment.end > source.length ||
      !Number.isInteger(segment.block)
    ) {
      throw new Error(
        `${label}: invalid or out-of-order range ${JSON.stringify(segment)}`
      );
    }
    if (segment.kind === 'join') {
      if (segment.text !== ' ' || !/^\s+$/.test(slice)) {
        throw new Error(
          `${label}: invalid joined whitespace ${JSON.stringify({ segment, slice })}`
        );
      }
    } else if (
      segment.kind === 'text'
        ? slice !== segment.text
        : slice.replace(/\r\n?/g, '\n') !== segment.text
    ) {
      throw new Error(
        `${label}: segment does not match source ${JSON.stringify({ segment, slice })}`
      );
    }
    previous = segment.end;
  }
  return result;
}

const attacks = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg/onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<body onload=alert(1)>',
  '"><script>alert(1)</script>',
  "'><script>alert(1)</script>",
  '<a href="javascript:alert(1)">click</a>',
  '<style>@import "evil.css"</style>',
  '<math><mtext><script>alert(1)</script></mtext></math>',
  '<!--<script>alert(1)</script>-->',
  '<object data="javascript:alert(1)">',
  '<embed src="javascript:alert(1)">',
  '<form action="javascript:alert(1)"><input>',
  '<details open ontoggle=alert(1)>',
];

describe('source-mapped markdown', () => {
  test('maps styled text, links, images, escaped characters and delimiter pairs', () => {
    const source =
      '# **bold** *italic* ~~strike~~ `code` [link](https://x) ![alt](https://y) & < > " \' 😀';
    const result = check(source, 'inline');
    expect(result.segments.map((segment) => segment.text).join('')).toBe(
      'bold italic strike code link alt & < > " \' 😀'
    );
    expect(
      result.segments.find((segment) => segment.text === 'code')?.kind
    ).toBe('code');
    expect(result.delimiters.map((delimiter) => delimiter.kind)).toEqual([
      'bold',
      'italic',
      'strike',
      'code',
      'link',
      'image',
    ]);
    expect(
      result.delimiters.map((delimiter) => [
        source.slice(delimiter.open.start, delimiter.open.end),
        source.slice(delimiter.close.start, delimiter.close.end),
      ])
    ).toEqual([
      ['**', '**'],
      ['*', '*'],
      ['~~', '~~'],
      ['`', '`'],
      ['[', ']'],
      ['![', ']'],
    ]);
    expect(new Set(result.segments.map((segment) => segment.block)).size).toBe(
      1
    );
  });

  test('maps joins, nested quotes, wrapped list items, table cells and fenced code to separate blocks', () => {
    const source =
      '  alpha  \n  beta\n\n- first\n    second\n- third\n\n> quote\n>   continued\n\n| left | right |\n| --- | --- |\n| one | two |\n\n```ts\nconst x = 1;\nnext\n```';
    const result = check(source, 'blocks');
    const joins = result.segments.filter((segment) => segment.kind === 'join');
    expect(
      joins.map((segment) => source.slice(segment.start, segment.end))
    ).toEqual(['  \n  ', '\n    ', '\n']);
    const get = (text: string) =>
      result.segments.find((segment) => segment.text === text)!;
    expect(get('alpha').block).toBe(get('beta').block);
    expect(get('first').block).toBe(get('second').block);
    expect(get('first').block).not.toBe(get('third').block);
    expect(get('left').block).not.toBe(get('right').block);
    expect(get('one').block).not.toBe(get('two').block);
    expect(get('const x = 1;\nnext').kind).toBe('code');
  });

  test('maps source offsets in UTF-16 and preserves whitespace joins inside code spans', () => {
    const source = '😀 `a\n b` then 😀';
    const result = check(source, 'UTF-16');
    expect(
      result.segments.map((segment) => [
        segment.text,
        segment.kind,
        segment.start,
        segment.end,
      ])
    ).toEqual([
      ['😀 ', 'text', 0, 3],
      ['a', 'code', 4, 5],
      [' ', 'join', 5, 7],
      ['b', 'code', 7, 8],
      [' then 😀', 'text', 9, 17],
    ]);
  });

  test('does not record syntax for links and images rejected by the existing scheme check', () => {
    const source = '[bad](javascript:alert) ![bad](data:text/html)';
    expect(check(source, 'unsafe links').delimiters).toEqual([]);
  });

  test('handles CR, NUL, repeated words and empty list items without forging offsets', () => {
    for (const source of [
      'same\r\nsame\ragain',
      'a\u0000b `c\u0000d`',
      '- \n  continuation\n- same\n- same',
      '> - one\n>   two',
      '```\r\none\r\ntwo\r\n```',
      '| a | a |\n| -- | -- |\n| a | a |',
    ])
      check(source, 'edge input');
  });

  test('does not turn the existing attack payloads into elements', () => {
    for (const attack of attacks) {
      const result = check(attack, 'attack');
      expect(result.html).not.toContain(attack);
      expect(result.html).not.toContain('<script>');
    }
    for (const source of attacks.flatMap((attack) => [
      `\`\`\`\n${attack}\n\`\`\``,
      `| ${attack} | x |\n| --- | --- |`,
      `# ${attack}`,
      `> ${attack}`,
    ]))
      check(source, 'attack in block');
  });

  test('is identical to the existing renderer for every docs Markdown file', async () => {
    const docs = resolve(import.meta.dir, '../../../docs');
    let count = 0;
    for await (const path of new Bun.Glob('**/*.md').scan({
      cwd: docs,
      absolute: true,
      onlyFiles: true,
    })) {
      check(await Bun.file(path).text(), path);
      count++;
    }
    expect(count).toBeGreaterThan(0);
  }, 120_000);

  test('is identical on 10,000 fixed-seed delimiter-heavy inputs', () => {
    let state = 0x651a703d;
    const random = (): number => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
    const tokens = [
      ...'*_~`[]()<>&\\#-',
      '\n',
      ' ',
      'alpha',
      'word',
      'https://x',
      'mailto:a',
    ];
    for (let i = 0; i < 10_000; i++) {
      const size = 1 + (random() % 48);
      let source = '';
      for (let j = 0; j < size; j++) source += tokens[random() % tokens.length];
      check(source, `seed 0x651a703d case ${i}`);
    }
  }, 120_000);

  test('the parity check catches a mirror with the strike pass removed', async () => {
    const sourcePath = resolve(import.meta.dir, '../src/markdown-source.ts');
    const original = await Bun.file(sourcePath).text();
    expect(original).toContain('out = applyStrike(out, context);');
    const broken = original
      .replace('out = applyStrike(out, context);', '')
      .replace(
        "from './markdown.ts'",
        `from '${pathToFileURL(resolve(import.meta.dir, '../src/markdown.ts')).href}'`
      );
    expect(broken).not.toContain('out = applyStrike(out, context);');
    const javascript = new Bun.Transpiler({
      loader: 'ts',
      target: 'bun',
    }).transformSync(broken);
    const moduleUrl = `data:application/javascript;base64,${Buffer.from(javascript).toString('base64')}`;
    // The module exists only after the test mutates and transpiles the mirror.
    const mutated = (await import(moduleUrl)) as {
      renderMarkdownWithSource: typeof renderMarkdownWithSource;
    };
    const input = 'a ~~deleted~~ word';
    expect(
      withoutSegments(mutated.renderMarkdownWithSource(input).html)
    ).not.toBe(renderMarkdown(input));
    expect(withoutSegments(renderMarkdownWithSource(input).html)).toBe(
      renderMarkdown(input)
    );
  });

  test('renders a long wrapped list item in linear time and still matches renderMarkdown', () => {
    const small = `- a\n${' b\n'.repeat(50)}- c\n`;
    expect(withoutSegments(renderMarkdownWithSource(small).html)).toBe(
      renderMarkdown(small)
    );
    // Joining after every continuation line copied the whole item each time:
    // 32,000 lines took about ten seconds. Linear takes a fraction of a second.
    const large = `- a\n${' b\n'.repeat(32_000)}`;
    const started = performance.now();
    renderMarkdownWithSource(large);
    expect(performance.now() - started).toBeLessThan(3000);
  }, 30_000);
});

describe('code source segment', () => {
  test('covers the whole code body in one block, including empty and multi-line files', () => {
    for (const source of ['', 'const x = 1;\nnext\n', '😀\tword']) {
      expect(codeSegments(source)).toEqual([
        { text: source, start: 0, end: source.length, block: 0, kind: 'code' },
      ]);
    }
    const source = 'one\r\ntwo\u0000three';
    expect(codeSegments(source)).toEqual([
      {
        text: 'one\ntwothree',
        start: 0,
        end: source.length,
        block: 0,
        kind: 'code',
      },
    ]);
  });
});
