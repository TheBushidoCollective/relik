import { describe, expect, test } from 'bun:test';
import type { FolderRelic } from '../src/folder-relic.ts';
import { folderMarkdown, resolveFolderReference } from '../src/folder-links.ts';
import { renderMarkdown } from '../src/markdown.ts';

const folder = {
  index: 0,
  manifest: {
    entries: [
      { path: 'docs/readme.md', length: 0 },
      { path: 'docs/a.md', length: 0 },
      { path: 'img/p.png', length: 1 },
      { path: 'img/large.png', length: 24 * 1024 * 1024 },
      { path: 'img/v.svg', length: 1 },
    ],
  },
} as unknown as FolderRelic;

describe('folder Markdown references', () => {
  test('resolves from the current directory or the relik root, never the host', () => {
    expect(resolveFolderReference(folder, './a.md#section')).toEqual({
      index: 1,
      fragment: 'section',
    });
    expect(resolveFolderReference(folder, '/docs/a.md')).toEqual({
      index: 1,
      fragment: '',
    });
    expect(resolveFolderReference(folder, '/img/p.png')).toEqual({
      index: 2,
      fragment: '',
    });
    expect(resolveFolderReference(folder, '../img/p.png')).toEqual({
      index: 2,
      fragment: '',
    });
    for (const path of [
      '../../outside.md',
      '/missing.md',
      '//evil.example/x',
      '%2F%2Fevil.example/x',
      'a%5cmd',
      'javascript%3Afoo',
      'a%ZZ',
      'A.md',
      'https://example.com/x',
    ])
      expect(resolveFolderReference(folder, path)).toBeUndefined();
  });
  test('preserves inert targets and limits images to 64 MiB', () => {
    const { resolver } = folderMarkdown(folder);
    const html = renderMarkdown(
      '[bad](../../outside.md) [web](https://example.com/) ![v](/img/v.svg) ![one](/img/large.png) ![two](/img/large.png) ![three](/img/large.png)',
      resolver
    );
    expect(html).toContain('[bad](../../outside.md)');
    expect(html).toContain('target="_blank"');
    expect(html.match(/class="md-entry-image"/g)).toHaveLength(2);
    expect(html).toContain('<span class="md-image">v</span>');
    expect(html).toContain('<span class="md-image">three</span>');
  });
});
