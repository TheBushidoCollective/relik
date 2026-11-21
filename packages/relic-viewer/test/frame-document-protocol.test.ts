import { describe, expect, test } from 'bun:test';
import {
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
});
