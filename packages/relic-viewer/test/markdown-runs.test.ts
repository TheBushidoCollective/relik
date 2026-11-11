import { describe, expect, test } from 'bun:test';
import { inlineRuns, parseMarkdown, renderMarkdown } from '../src/markdown.ts';

/**
 * `inlineRuns` is how the Word export learns what the page shows, so these
 * pin the two to each other: whatever `renderMarkdown` makes a link, a run
 * carries an `href` for, and nothing else.
 */
describe('inlineRuns', () => {
  test('plain text is one unstyled run', () => {
    expect(inlineRuns('just words')).toEqual([
      {
        text: 'just words',
        bold: false,
        italic: false,
        strike: false,
        code: false,
        image: false,
      },
    ]);
  });

  test('reads emphasis, strike, and code off the same engine as the page', () => {
    const runs = inlineRuns('a **b** *c* ~~d~~ `e`');
    const styled = runs.filter((run) => run.text.trim().length > 0);
    expect(styled.map((run) => run.text.trim())).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
    expect(styled.find((run) => run.text === 'b')?.bold).toBe(true);
    expect(styled.find((run) => run.text === 'c')?.italic).toBe(true);
    expect(styled.find((run) => run.text === 'd')?.strike).toBe(true);
    expect(styled.find((run) => run.text === 'e')?.code).toBe(true);
    expect(styled.find((run) => run.text.trim() === 'a')?.bold).toBe(false);
  });

  test('decodes entities back to the characters the author typed', () => {
    const [run] = inlineRuns(`a & b < c > d "e" 'f'`);
    expect(run?.text).toBe(`a & b < c > d "e" 'f'`);
  });

  test('does not decode twice', () => {
    expect(inlineRuns('&lt;')[0]?.text).toBe('&lt;');
    expect(inlineRuns('&amp;amp;')[0]?.text).toBe('&amp;amp;');
  });

  test('markup in the source stays text, with no tag becoming a style', () => {
    const runs = inlineRuns('<strong>x</strong> <a href="https://e.com">y</a>');
    expect(runs.map((run) => run.text).join('')).toBe(
      '<strong>x</strong> <a href="https://e.com">y</a>'
    );
    for (const run of runs) {
      expect(run.bold).toBe(false);
      expect(run.href).toBeUndefined();
    }
  });

  test('a link carries its target, and only a safe one', () => {
    const [safe] = inlineRuns('[a](https://example.com/?q=1&r=2)');
    expect(safe?.href).toBe('https://example.com/?q=1&r=2');
    expect(safe?.text).toBe('a');
    expect(inlineRuns('[a](mailto:x@example.com)')[0]?.href).toBe(
      'mailto:x@example.com'
    );
    for (const target of [
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///x',
    ]) {
      for (const run of inlineRuns(`[a](${target})`)) {
        expect(run.href).toBeUndefined();
      }
    }
  });

  test('styling inside a link text is kept', () => {
    const run = inlineRuns('[**bold link**](https://example.com)')[0];
    expect(run?.bold).toBe(true);
    expect(run?.href).toBe('https://example.com');
  });

  test('an image is its alt text, flagged', () => {
    const [run] = inlineRuns('![a photo](https://example.com/x.png)');
    expect(run?.text).toBe('a photo');
    expect(run?.image).toBe(true);
  });

  test('overlapping emphasis cannot leave a style stuck on', () => {
    // The page's passes can overlap into misnested tags. Flags must still
    // return to false rather than carry into the text after.
    const runs = inlineRuns('**a [b**](https://example.com) c');
    const last = runs[runs.length - 1];
    expect(last?.text).toBe(' c');
    expect(last?.bold).toBe(false);
    expect(last?.href).toBeUndefined();
  });

  test('a code span is literal', () => {
    const run = inlineRuns('`**not bold**`')[0];
    expect(run?.code).toBe(true);
    expect(run?.bold).toBe(false);
    expect(run?.text).toBe('**not bold**');
  });
});

describe('parseMarkdown', () => {
  test('keeps block structure and leaves inline text as source', () => {
    expect(
      parseMarkdown('# T\n\npara **x**\n\n- a\n- b\n\n---\n\n```ts\ncode\n```')
    ).toEqual([
      { kind: 'heading', level: 1, text: 'T' },
      { kind: 'paragraph', text: 'para **x**' },
      { kind: 'list', ordered: false, items: ['a', 'b'] },
      { kind: 'rule' },
      { kind: 'code', language: 'ts', text: 'code' },
    ]);
  });

  test('a quote nests its own blocks', () => {
    expect(parseMarkdown('> a\n>\n> - b')).toEqual([
      {
        kind: 'quote',
        blocks: [
          { kind: 'paragraph', text: 'a' },
          { kind: 'list', ordered: false, items: ['b'] },
        ],
      },
    ]);
  });

  test('a table keeps header and rows as cells', () => {
    expect(parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')).toEqual([
      { kind: 'table', header: ['a', 'b'], rows: [['1', '2']] },
    ]);
  });

  test('the page is rendered from exactly these blocks', () => {
    const source = '# T\n\n> q\n\n1. a\n2. b\n\n| a |\n| --- |\n| 1 |';
    const html = renderMarkdown(source);
    expect(html).toContain('<h1>T</h1>');
    expect(html).toContain('<blockquote><p>q</p></blockquote>');
    expect(html).toContain('<ol><li>a</li><li>b</li></ol>');
    expect(html).toContain('<td>1</td>');
  });
});
