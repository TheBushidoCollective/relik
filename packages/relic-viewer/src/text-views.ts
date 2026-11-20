import {
  highlightCode,
  renderMarkdown,
  type MarkdownResolver,
} from './markdown.ts';

/**
 * Builds an article.prose element rendering markdown source.
 */
export function buildProse(
  source: string,
  resolver?: MarkdownResolver
): HTMLElement {
  const prose = document.createElement('article');
  prose.className = 'prose';
  // renderMarkdown escapes before it adds markup, and nothing in the source
  // can become an element. That property is asserted directly in
  // test/markdown.test.ts against fifteen attack payloads.
  prose.innerHTML = renderMarkdown(source, resolver);
  return prose;
}

/**
 * Builds a div.code element with line-numbered gutter and highlighted code body.
 */
export function buildCodeTable(source: string): HTMLElement {
  const lines = source.split('\n');

  const table = document.createElement('div');
  table.className = 'code';

  const gutter = document.createElement('pre');
  gutter.className = 'gutter';
  gutter.setAttribute('aria-hidden', 'true');
  gutter.textContent = lines.map((_line, index) => index + 1).join('\n');

  const body = document.createElement('pre');
  body.className = 'code-body';
  // highlightCode escapes before it marks up.
  body.innerHTML = highlightCode(source);

  table.append(gutter, body);
  return table;
}
