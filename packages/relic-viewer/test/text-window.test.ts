import { describe, expect, test } from 'bun:test';
import { contentFromBytes, type RelicContent } from '../src/content.ts';
import { findSourceQuote, TextWindowIndex } from '../src/text-window.ts';

function boundedContent(text: string) {
  const bytes = new TextEncoder().encode(text);
  const content = contentFromBytes(bytes);
  const reads: number[] = [];
  const bounded: RelicContent = {
    size: content.size,
    head: content.head,
    tail: content.tail,
    blob: (type) => content.blob(type),
    read: async (start, end) => {
      reads.push(end - start);
      if (end - start > 2 * 1024 * 1024)
        throw new Error('Unbounded source read');
      return content.read(start, end);
    },
    readWhole: async () => {
      throw new Error('Source must never read whole');
    },
  };
  return { content: bounded, bytes, reads };
}

describe('full windowed source', () => {
  test('empty source and final newline stay addressable', async () => {
    const empty = await TextWindowIndex.build(boundedContent('').content);
    expect(empty.rowCount).toBe(1);
    expect(await empty.rows(0, 80)).toEqual([
      { row: 0, line: 1, start: 0, end: 0 },
    ]);
    const ended = await TextWindowIndex.build(
      boundedContent('one\ntwo\n').content
    );
    expect(ended.lineCount).toBe(3);
    expect(await ended.rowAtLine(3)).toBe(2);
  });

  test('a sparse checkpoint reaches the exact late line and final byte', async () => {
    const source = `${'first\n'.repeat(12_345)}last line`;
    const { content, bytes, reads } = boundedContent(source);
    const index = await TextWindowIndex.build(content);
    expect(index.lineCount).toBe(12_346);
    const row = await index.rowAtLine(12_346);
    const [last] = await index.rows(row, 1);
    expect(last?.line).toBe(12_346);
    expect(last?.end).toBe(bytes.length);
    expect(
      new TextDecoder().decode(await content.read(last!.start, last!.end))
    ).toBe('last line');
    expect(await index.rowAtByte(bytes.length - 1)).toBe(row);
    expect(Math.max(...reads)).toBeLessThanOrEqual(1024 * 1024);
  });

  test('single huge lines split into bounded UTF-8-safe rows without losing source', async () => {
    const source = `${'x'.repeat(16_383)}😀${'界'.repeat(40_000)}\nend`;
    const { content, bytes } = boundedContent(source);
    const index = await TextWindowIndex.build(content);
    expect(index.lineCount).toBe(2);
    const rows = await index.rows(0, 80);
    const parts: string[] = [];
    for (const row of rows) {
      expect(row.end - row.start).toBeLessThanOrEqual(16_387);
      parts.push(
        new TextDecoder('utf-8', { fatal: true }).decode(
          await content.read(row.start, row.end)
        )
      );
    }
    expect(parts.join('')).toBe(source);
    expect(rows.at(-1)?.end).toBe(bytes.length);
    expect(rows.at(-1)?.line).toBe(2);
    expect(await index.rowAtLine(1)).toBe(0);
  });

  test('a UTF-8 code point crossing a read boundary stays intact', async () => {
    const source = `${'a'.repeat(1024 * 1024 - 1)}😀last`;
    const { content, bytes } = boundedContent(source);
    const index = await TextWindowIndex.build(content);
    const row = await index.rowAtByte(bytes.length - 1);
    const rows = await index.rows(Math.max(0, row - 1), 2);
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      await content.read(rows[0]!.start, rows.at(-1)!.end)
    );
    expect(decoded.endsWith('😀last')).toBe(true);
  });

  test('late quotes resolve by context across chunk boundaries', async () => {
    const prefix = `${'x'.repeat(1024 * 1024 - 4)}界`;
    const source = `${prefix}target suffix\nother target tail`;
    const { content } = boundedContent(source);
    const match = await findSourceQuote(content, {
      exact: 'target',
      prefix: '界',
      suffix: ' suffix',
    });
    const start = new TextEncoder().encode(prefix).length;
    expect(match).toEqual({ start, end: start + 6 });
    const index = await TextWindowIndex.build(content);
    expect(await index.rowAtByte(match!.start)).toBeGreaterThan(0);
    expect(
      await findSourceQuote(content, { exact: 'target', prefix: 'missing' })
    ).toBeUndefined();
  });

  test('BOM and multibyte text before a match preserve byte offsets', async () => {
    const prefix = '\uFEFF界😀before ';
    const { content } = boundedContent(`${prefix}target`);
    const start = new TextEncoder().encode(prefix).length;
    expect(await findSourceQuote(content, { exact: 'target' })).toEqual({
      start,
      end: start + 6,
    });
  });

  test('cancellation stops index construction and quote scans', async () => {
    const { content } = boundedContent('source\n');
    const controller = new AbortController();
    controller.abort();
    await expect(
      TextWindowIndex.build(content, controller.signal)
    ).rejects.toThrow('Aborted');
    expect(
      await findSourceQuote(content, { exact: 'source' }, controller.signal)
    ).toBeUndefined();
  });
});
