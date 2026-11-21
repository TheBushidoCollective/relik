import { afterEach, expect, jest, test } from 'bun:test';
import { crc32, planStoredZip } from '@relic/format';
import { contentFromBytes } from '../src/content.ts';
import {
  type CreateDocumentFrame,
  type DocumentFrame,
  documentWatchdog,
  mountDocumentRoute,
} from '../src/document-route.ts';
import type { DocumentStateMessage } from '../src/frame-document-protocol.ts';

afterEach(() => jest.useRealTimers());

test('watchdog fails once at its deadline and ignores late states', () => {
  jest.useFakeTimers();
  const states: DocumentStateMessage[] = [];
  const finish = documentWatchdog((state) => states.push(state));
  jest.advanceTimersByTime(29999);
  expect(states).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(states).toEqual([
    { type: 'relic:document-state', state: 'failed', reason: 'corrupt' },
  ]);
  finish({ type: 'relic:document-state', state: 'ready' });
  expect(states).toHaveLength(1);
});

test('a first state cancels the watchdog and later states', () => {
  jest.useFakeTimers();
  const states: DocumentStateMessage[] = [];
  const finish = documentWatchdog((state) => states.push(state));
  const ready = { type: 'relic:document-state', state: 'ready' } as const;
  finish(ready);
  finish({ type: 'relic:document-state', state: 'failed', reason: 'corrupt' });
  jest.advanceTimersByTime(30000);
  expect(states).toEqual([ready]);
});

function zip(entries: readonly (readonly [string, string])[]): Uint8Array {
  const encoder = new TextEncoder();
  const data = entries.map(([name, text]) => ({
    name,
    bytes: encoder.encode(text),
  }));
  const layout = planStoredZip(
    data.map(({ name, bytes }) => ({
      name,
      size: bytes.length,
      crc32: crc32(bytes),
    }))
  );
  const result = new Uint8Array(layout.totalBytes);
  let offset = 0;
  for (let i = 0; i < data.length; i++) {
    const header = layout.localHeaders[i]!;
    result.set(header, offset);
    offset += header.length;
    result.set(data[i]!.bytes, offset);
    offset += data[i]!.bytes.length;
  }
  result.set(layout.centralDirectory, offset);
  offset += layout.centralDirectory.length;
  result.set(layout.end, offset);
  return result;
}

class ElementStub extends EventTarget {
  className = '';
  type = '';
  textContent = '';
  isConnected = true;
  removed = false;
  children: ElementStub[] = [];
  append(...nodes: ElementStub[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: ElementStub[]) {
    this.children = nodes;
  }
  remove() {
    this.removed = true;
  }
}

test('archive checks precede frame creation and timeout removes the frame', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => new ElementStub() },
  });
  try {
    const root = new ElementStub();
    let frameCount = 0;
    let frame = new ElementStub();
    const createFrame: CreateDocumentFrame = (payload, transfers) => {
      frameCount++;
      expect(payload.entries.map(([name]) => name)).toEqual([
        'word/document.xml',
      ]);
      expect(transfers).toEqual(
        payload.entries.map(([, bytes]) => bytes.buffer)
      );
      frame = new ElementStub();
      return {
        frame,
        linkConfirm: new ElementStub(),
        linkRemembered: new ElementStub(),
      } as unknown as DocumentFrame;
    };
    const malformed = contentFromBytes(
      zip([['word/document.xml', '<!DOCTYPE root [<!ENTITY x \"z\">]><root/>']])
    );
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      malformed,
      'docx',
      createFrame,
      () => {}
    );
    expect(frameCount).toBe(0);
    expect(root.children[0]?.children[0]?.textContent).toBe(
      'This document could not be shown.'
    );
    const extensionless = contentFromBytes(
      zip([['chapter', '<!DOCTYPE html [<!ENTITY x \"z\">]><html/>']])
    );
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      extensionless,
      'epub',
      createFrame,
      () => {}
    );
    expect(frameCount).toBe(0);
    jest.useFakeTimers();
    const valid = contentFromBytes(zip([['word/document.xml', '<root/>']]));
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      valid,
      'docx',
      createFrame,
      () => {}
    );
    expect(frameCount).toBe(1);
    expect(frame.removed).toBe(false);
    jest.advanceTimersByTime(30000);
    expect(frame.removed).toBe(true);
    expect(root.children[0]?.children[0]?.textContent).toBe(
      'This document could not be shown.'
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
