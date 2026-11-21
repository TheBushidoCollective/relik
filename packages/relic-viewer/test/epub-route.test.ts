import { expect, test } from 'bun:test';
import { crc32, planStoredZip } from '@relic/format';
import { readEpubPackage } from '@relic/format/epub-package';
import { contentFromBytes } from '../src/content.ts';
import {
  mountDocumentRoute,
  type CreateDocumentFrame,
  type DocumentFrame,
} from '../src/document-route.ts';
import type {
  DocumentStateMessage,
  RenderDocumentMessage,
} from '../src/frame-document-protocol.ts';

function zip(entries: Record<string, string>): Uint8Array {
  const data = Object.entries(entries).map(([name, text]) => ({
    name,
    bytes: new TextEncoder().encode(text),
  }));
  const plan = planStoredZip(
    data.map(({ name, bytes }) => ({
      name,
      size: bytes.length,
      crc32: crc32(bytes),
    }))
  );
  const result = new Uint8Array(plan.totalBytes);
  let offset = 0;
  for (let i = 0; i < data.length; i++) {
    const header = plan.localHeaders[i]!;
    result.set(header, offset);
    offset += header.length;
    result.set(data[i]!.bytes, offset);
    offset += data[i]!.bytes.length;
  }
  result.set(plan.centralDirectory, offset);
  offset += plan.centralDirectory.length;
  result.set(plan.end, offset);
  return result;
}
class ElementStub extends EventTarget {
  className = '';
  type = '';
  textContent = '';
  isConnected = true;
  children: ElementStub[] = [];
  append(...nodes: ElementStub[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: ElementStub[]) {
    this.children = nodes;
  }
  remove() {}
}
const entries = {
  'META-INF/container.xml':
    '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
  'book.opf':
    '<package><metadata><title>Test</title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/><item id="f" href="font.otf" media-type="font/otf"/></manifest><spine><itemref idref="c"/></spine></package>',
  'c.xhtml': '<html><body>Readable</body></html>',
  'font.otf': 'opaque font',
};
const encryption =
  '<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><CipherData><CipherReference URI="font.otf"/></CipherData></EncryptedData></encryption>';

test('DRM shows its download card without making a frame, while obfuscated fonts are omitted', async () => {
  const frameFile = Bun.file(
    new URL('../dist-frame/frame-epub.frame.js', import.meta.url)
  );
  if (!(await frameFile.exists()))
    throw new Error(
      "EPUB route test requires a fresh viewer build: bun run --filter '@relic/viewer' build"
    );
  const frameModule = await frameFile.text();
  expect(frameModule).toContain('EPUB element limit exceeded');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => new ElementStub() },
  });
  try {
    const root = new ElementStub();
    let payload: RenderDocumentMessage | undefined;
    let settle: ((state: DocumentStateMessage) => void) | undefined;
    let frames = 0;
    const create: CreateDocumentFrame = (message, _transfer, onState) => {
      frames++;
      payload = message;
      settle = onState;
      return {
        frame: new ElementStub(),
        linkConfirm: new ElementStub(),
        linkRemembered: new ElementStub(),
        dispose() {},
      } as unknown as DocumentFrame;
    };
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      contentFromBytes(zip({ ...entries, 'META-INF/rights.xml': '<rights/>' })),
      'epub',
      readEpubPackage,
      create,
      () => {}
    );
    expect(frames).toBe(0);
    expect(root.children[0]?.children[0]?.textContent).toContain(
      'protected by DRM'
    );
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      contentFromBytes(
        zip({ ...entries, 'META-INF/encryption.xml': encryption })
      ),
      'epub',
      readEpubPackage,
      create,
      () => {}
    );
    expect(frames).toBe(1);
    expect(payload?.module).toBe(frameModule);
    expect(payload?.book?.title).toBe('Test');
    expect(payload?.book?.resources).toEqual([
      { path: 'c.xhtml', mediaType: 'application/xhtml+xml' },
    ]);
    expect(payload?.entries.map(([name]) => name)).toEqual(['c.xhtml']);
    settle?.({ type: 'relic:document-state', state: 'ready' });
    const extensionless = {
      ...entries,
      'book.opf': entries['book.opf'].replace(
        'href="c.xhtml"',
        'href="chapter"'
      ),
      chapter: `${' '.repeat(300)}<html><body>Readable</body></html>`,
    };
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      contentFromBytes(zip(extensionless)),
      'epub',
      readEpubPackage,
      create,
      () => {}
    );
    expect(frames).toBe(2);
    settle?.({ type: 'relic:document-state', state: 'ready' });
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      contentFromBytes(
        zip({
          ...extensionless,
          chapter: `${' '.repeat(300)}<!DOCTYPE html [<!ENTITY x "bad">]><html>&x;</html>`,
        })
      ),
      'epub',
      readEpubPackage,
      create,
      () => {}
    );
    expect(frames).toBe(2);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
