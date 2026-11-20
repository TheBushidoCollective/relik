import { describe, expect, test } from 'bun:test';
import { renderMarkdown } from '../src/markdown.ts';
import { renderMarkdownWithSource } from '../src/markdown-source.ts';

/**
 * Notebook markdown cells and text/markdown outputs are drawn synchronously
 * on mount, up to 1 MiB each. These fixtures are the inputs that made the
 * renderer superlinear or overflowed the stack (SF-MD-REDOS). The budget is
 * generous so the check does not flake on a slow runner, yet far below the
 * seconds-to-minutes the unfixed renderer took.
 */
const BUDGET_MS = 1000;

function timed(run: () => string): { ms: number; html: string } {
  const start = performance.now();
  const html = run();
  return { ms: performance.now() - start, html };
}

describe('markdown renders pathological input in linear time', () => {
  test('a run of "[" with no closing bracket', () => {
    const { ms, html } = timed(() => renderMarkdown('['.repeat(200_000)));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(html).toBe(`<p>${'['.repeat(200_000)}</p>`);
  });

  test('a run of "![" images with no closing bracket', () => {
    const { ms, html } = timed(() => renderMarkdown('!['.repeat(200_000)));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(html).not.toContain('md-image');
  });

  test('a run of "[a](" links that never close', () => {
    const { ms, html } = timed(() => renderMarkdown('[a]('.repeat(200_000)));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(html).not.toContain('<a ');
  });

  test('a table separator candidate followed by a long run of spaces', () => {
    const source = `a|\n${' '.repeat(500_000)}x`;
    const { ms, html } = timed(() => renderMarkdown(source));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(html).toBe('<p>a| x</p>');
  });

  test('a line of 100,000 ">" does not overflow the stack', () => {
    const { ms, html } = timed(() => renderMarkdown('>'.repeat(100_000)));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(html).toContain('<blockquote>');
    expect(html).toContain('&gt;');
  });

  test('blockquotes nest to the cap and deeper ">" is text', () => {
    const depth = 40;
    const html = renderMarkdown(`${'>'.repeat(depth)} deep`);
    const opens = html.split('<blockquote>').length - 1;
    expect(opens).toBe(32);
    expect(html).toContain('&gt;');
    expect(html).toContain('deep');
  });

  test('the source-mapped renderer keeps the same cap and stays linear', () => {
    const source = '>'.repeat(100_000);
    const start = performance.now();
    const mapped = renderMarkdownWithSource(source);
    expect(performance.now() - start).toBeLessThan(BUDGET_MS);
    expect(mapped.html.split('<blockquote>').length - 1).toBe(32);
  });
});
