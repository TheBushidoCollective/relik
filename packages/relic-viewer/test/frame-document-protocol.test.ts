import { describe, expect, test } from 'bun:test';
import {
  isDocumentBlocksMessage,
  isDocumentStateMessage,
  isRenderDocumentMessage,
} from '../src/frame-document-protocol.ts';
import { createSandboxHandler } from '../src/sandbox.ts';

const doc = {
  type: 'relic:render-document',
  format: 'docx',
  module: 'export function render() {}',
  entries: [['word/document.xml', new Uint8Array([1])]],
};

const block = { kind: 'paragraph', text: 'Hiring stays flat.', part: 0 };
const message = (entries: readonly unknown[]) => ({
  type: 'relic:document-blocks',
  blocks: entries,
});

describe('document frame protocol', () => {
  test('refuses malformed and oversized render messages', () => {
    expect(isRenderDocumentMessage(doc)).toBe(true);
    for (const bad of [
      { ...doc, format: 'xlsx' },
      { ...doc, module: 'a'.repeat(2 * 1024 * 1024 + 1) },
      { ...doc, module: 'é'.repeat(1024 * 1024 + 1) },
      { ...doc, entries: [['x', 'text']] },
      {
        ...doc,
        entries: [
          ['x', new Uint8Array()],
          ['x', new Uint8Array()],
        ],
      },
      {
        ...doc,
        entries: Array.from({ length: 10001 }, (_, n) => [
          String(n),
          new Uint8Array(),
        ]),
      },
      { ...doc, book: { title: 'bad' } },
    ])
      expect(isRenderDocumentMessage(bad)).toBe(false);
    const mib = new Uint8Array(1024 * 1024);
    const entries = Array.from({ length: 201 }, (_, index) => [
      String(index),
      mib,
    ]);
    expect(
      isRenderDocumentMessage({ ...doc, entries: entries.slice(0, 200) })
    ).toBe(true);
    expect(isRenderDocumentMessage({ ...doc, entries })).toBe(false);
  });
  test('requires bounded manifest media metadata for EPUB books', () => {
    const book = {
      title: 'Book',
      progression: 'default',
      layout: 'reflowable',
      resources: [{ path: 'chapter', mediaType: 'application/xhtml+xml' }],
      spine: [{ path: 'chapter', linear: true }],
      toc: [],
      pageList: [],
    };
    expect(isRenderDocumentMessage({ ...doc, format: 'epub', book })).toBe(
      true
    );
    expect(
      isRenderDocumentMessage({
        ...doc,
        format: 'epub',
        book: { ...book, resources: undefined },
      })
    ).toBe(false);
    expect(
      isRenderDocumentMessage({
        ...doc,
        format: 'epub',
        book: { ...book, resources: [{ path: 'chapter' }] },
      })
    ).toBe(false);
    expect(
      isRenderDocumentMessage({
        ...doc,
        format: 'epub',
        book: {
          ...book,
          toc: Array.from({ length: 5001 }, () => ({
            label: 'x',
            path: 'chapter',
            depth: 0,
          })),
        },
      })
    ).toBe(false);
  });
  test('accepts only exact ready and failed responses', () => {
    expect(
      isDocumentStateMessage({ type: 'relic:document-state', state: 'ready' })
    ).toBe(true);
    expect(
      isDocumentStateMessage({
        type: 'relic:document-state',
        state: 'failed',
        reason: 'corrupt',
      })
    ).toBe(true);
    expect(
      isDocumentStateMessage({
        type: 'relic:document-state',
        state: 'failed',
        reason: 'image-dimensions-unknown',
      })
    ).toBe(true);
    for (const bad of [
      { type: 'relic:document-state', state: 'ready', reason: 'corrupt' },
      { type: 'relic:document-state', state: 'failed', reason: 'protected' },
      { type: 'relic:document-state', state: 'failed' },
      {
        type: 'relic:document-state',
        state: 'failed',
        reason: 'corrupt',
        extra: true,
      },
    ])
      expect(isDocumentStateMessage(bad)).toBe(false);
  });
  test('the first valid HTML, JSX or document render wins', () => {
    const messages = [
      doc,
      { type: 'relic:render', html: '<p>x</p>' },
      { type: 'relic:render-jsx', code: 'x' },
    ];
    for (const first of messages) {
      const rendered: string[] = [];
      const handle = createSandboxHandler(
        () => rendered.push('html'),
        () => rendered.push('jsx'),
        undefined,
        undefined,
        () => rendered.push('document')
      );
      expect(handle({ ...doc, entries: [['x', null]] })).toBe(false);
      expect(handle(first)).toBe(true);
      for (const second of messages) expect(handle(second)).toBe(false);
      expect(rendered).toHaveLength(1);
    }
  });
  test('accepts the compare flag only when it is true', () => {
    expect(isRenderDocumentMessage({ ...doc, compare: true })).toBe(true);
    expect(isRenderDocumentMessage({ ...doc, compare: undefined })).toBe(true);
    for (const bad of [
      { ...doc, compare: false },
      { ...doc, compare: 'true' },
      { ...doc, compare: 1 },
      { ...doc, compare: null },
    ])
      expect(isRenderDocumentMessage(bad)).toBe(false);
  });
  test('accepts a valid block set and an explicit null', () => {
    expect(
      isDocumentBlocksMessage({ type: 'relic:document-blocks', blocks: null })
    ).toBe(true);
    expect(isDocumentBlocksMessage(message([block]))).toBe(true);
    expect(
      isDocumentBlocksMessage(
        message([
          { kind: 'heading', text: 'Quarterly plan', part: 0 },
          { kind: 'image', text: '', part: 0 },
          { kind: 'text', text: 'Revenue grew.', part: 1999 },
        ])
      )
    ).toBe(true);
  });
  test('refuses extra or missing keys on the message and on a block', () => {
    for (const bad of [
      { type: 'relic:document-blocks', blocks: null, extra: true },
      { type: 'relic:document-blocks' },
      { type: 'relic:document-blocks', blocks: undefined },
      { type: 'relic:document-state', blocks: null },
      message([{ ...block, extra: true }]),
      message([{ kind: block.kind, text: block.text }]),
    ])
      expect(isDocumentBlocksMessage(bad)).toBe(false);
  });
  test('refuses a sparse array, a non-object block, or one bad entry', () => {
    const sparse: unknown[] = [block];
    sparse.length = 2;
    expect(isDocumentBlocksMessage(message(sparse))).toBe(false);
    for (const bad of [null, 'paragraph', [], [block]])
      expect(isDocumentBlocksMessage(message([bad]))).toBe(false);
    expect(
      isDocumentBlocksMessage(message([block, { ...block, kind: 'nope' }]))
    ).toBe(false);
  });
  test('refuses an unknown kind and a part outside the spine cap', () => {
    for (const kind of ['div', 'Paragraph', 'constructor', '__proto__', ''])
      expect(isDocumentBlocksMessage(message([{ ...block, kind }]))).toBe(
        false
      );
    for (const part of [2000, -1, 1.5, '0', NaN, Infinity])
      expect(isDocumentBlocksMessage(message([{ ...block, part }]))).toBe(
        false
      );
    expect(isDocumentBlocksMessage(message([{ ...block, part: 1999 }]))).toBe(
      true
    );
  });
  test('bounds the block count at 50,000', () => {
    const many = (count: number) =>
      message(Array.from({ length: count }, () => block));
    expect(isDocumentBlocksMessage(many(50_000))).toBe(true);
    expect(isDocumentBlocksMessage(many(50_001))).toBe(false);
  });
  test('bounds block text at 16 MiB of UTF-8 across the whole message', () => {
    const MiB = 1024 * 1024;
    const text = (value: string) => message([{ ...block, text: value }]);
    expect(isDocumentBlocksMessage(text('a'.repeat(16 * MiB)))).toBe(true);
    expect(isDocumentBlocksMessage(text('a'.repeat(16 * MiB + 1)))).toBe(false);
    expect(isDocumentBlocksMessage(text('é'.repeat(8 * MiB)))).toBe(true);
    expect(isDocumentBlocksMessage(text('é'.repeat(8 * MiB + 1)))).toBe(false);
    expect(isDocumentBlocksMessage(text('😀'.repeat(4 * MiB)))).toBe(true);
    expect(isDocumentBlocksMessage(text('😀'.repeat(4 * MiB + 1)))).toBe(false);
    expect(
      isDocumentBlocksMessage(
        message([
          { ...block, text: 'a'.repeat(9 * MiB) },
          { ...block, text: 'a'.repeat(9 * MiB) },
        ])
      )
    ).toBe(false);
  });
});
