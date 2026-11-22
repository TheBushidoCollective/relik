import { afterEach, expect, jest, test } from 'bun:test';
import { crc32, planStoredZip } from '@relic/format';
import type { ZipIndex } from '@relic/format/zip-index';
import { contentFromBytes } from '../src/content.ts';
import {
  type CreateDocumentFrame,
  DOCUMENT_BLOCKS_WAIT_MS,
  type DocumentFrame,
  type DocumentSnapshotResult,
  documentWatchdog,
  mountDocumentRoute,
} from '../src/document-route.ts';
import type {
  DocumentBlock,
  DocumentStateMessage,
  EpubBook,
  RenderDocumentMessage,
} from '../src/frame-document-protocol.ts';

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
  const frameFile = Bun.file(
    new URL('../dist-frame/frame-docx.frame.js', import.meta.url)
  );
  if (!(await frameFile.exists()))
    throw new Error(
      "Document route test requires a fresh viewer build: bun run --filter '@relic/viewer' build"
    );
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    'MutationObserver'
  );
  const observerState: { onMutation?: () => void } = {};
  let disconnects = 0;
  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true,
    value: class {
      constructor(callback: () => void) {
        observerState.onMutation = callback;
      }
      observe() {}
      disconnect() {
        disconnects++;
      }
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => new ElementStub() },
  });
  try {
    const root = new ElementStub();
    let frameCount = 0;
    let frame = new ElementStub();
    let frameDisposals = 0;
    const frameState: { respond?: (state: DocumentStateMessage) => void } = {};
    const select = async (index: ZipIndex) => {
      const parts = [...index.entries.keys()];
      return { parts, xmlParts: new Set(parts) };
    };
    const createFrame: CreateDocumentFrame = (payload, transfers, onState) => {
      frameState.respond = onState;
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
        dispose: () => {
          frameDisposals++;
        },
      } as unknown as DocumentFrame;
    };
    const malformed = contentFromBytes(
      zip([['word/document.xml', '<!DOCTYPE root [<!ENTITY x \"z\">]><root/>']])
    );
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      malformed,
      'docx',
      select,
      createFrame,
      () => {}
    );
    expect(frameCount).toBe(0);
    expect(root.children[0]?.children[0]?.textContent).toBe(
      'This document could not be shown.'
    );
    const extensionless = contentFromBytes(
      zip([
        [
          'chapter',
          ' '.repeat(1024) + '<!DOCTYPE html [<!ENTITY x \"z\">]><html/>',
        ],
      ])
    );
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      extensionless,
      'epub',
      select,
      createFrame,
      () => {}
    );
    expect(frameCount).toBe(0);
    const failedSelectionSignal: { current: AbortSignal | undefined } = {
      current: undefined,
    };
    let protectedDownloads = 0;
    let protectedStates = 0;
    root.addEventListener('relic:render-state', () => protectedStates++);
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      extensionless,
      'epub',
      async (_index, signal) => {
        failedSelectionSignal.current = signal;
        return { ok: false, reason: 'protected' };
      },
      createFrame,
      () => protectedDownloads++
    );
    expect(failedSelectionSignal.current?.aborted).toBe(true);
    expect(protectedStates).toBe(1);
    expect(root.children[0]?.children[0]?.textContent).toBe(
      'This ebook is protected by DRM and cannot be shown.'
    );
    expect(root.children[0]?.children[1]?.textContent).toBe('Download');
    root.children[0]?.children[1]?.dispatchEvent(new Event('click'));
    expect(protectedDownloads).toBe(1);
    for (const reason of ['corrupt', 'too-large'] as const) {
      await mountDocumentRoute(
        root as unknown as HTMLElement,
        extensionless,
        'epub',
        async () => ({ ok: false, reason }),
        createFrame,
        () => {}
      );
      expect(root.children[0]?.children[0]?.textContent).toBe(
        'This document could not be shown.'
      );
    }
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      extensionless,
      'epub',
      async () => ({ parts: [], xmlParts: new Set(['chapter']) }),
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
      select,
      createFrame,
      () => {}
    );
    expect(frameCount).toBe(1);
    expect(frame.removed).toBe(false);
    jest.advanceTimersByTime(30000);
    expect(frame.removed).toBe(true);
    expect(frameDisposals).toBe(1);
    expect(root.children[0]?.children[0]?.textContent).toBe(
      'This document could not be shown.'
    );
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      valid,
      'docx',
      select,
      createFrame,
      () => {}
    );
    frameState.respond?.({ type: 'relic:document-state', state: 'ready' });
    root.isConnected = false;
    observerState.onMutation?.();
    expect(frameDisposals).toBe(2);
    expect(disconnects).toBeGreaterThanOrEqual(4);
    jest.advanceTimersByTime(30000);
    expect(frameDisposals).toBe(2);
    const failedRoot = new ElementStub();
    await mountDocumentRoute(
      failedRoot as unknown as HTMLElement,
      valid,
      'docx',
      select,
      createFrame,
      () => {}
    );
    frameState.respond?.({
      type: 'relic:document-state',
      state: 'failed',
      reason: 'unsupported',
    });
    expect(frame.removed).toBe(true);
    expect(frameDisposals).toBe(3);
    jest.advanceTimersByTime(30000);
    expect(frameDisposals).toBe(3);
    const unknownImageRoot = new ElementStub();
    let downloads = 0;
    await mountDocumentRoute(
      unknownImageRoot as unknown as HTMLElement,
      valid,
      'docx',
      select,
      createFrame,
      () => downloads++
    );
    frameState.respond?.({
      type: 'relic:document-state',
      state: 'failed',
      reason: 'image-dimensions-unknown',
    });
    expect(frame.removed).toBe(true);
    expect(frameDisposals).toBe(4);
    const fallback = unknownImageRoot.children[0]!;
    expect(fallback.children[0]?.textContent).toContain(
      'image whose dimensions could not be checked'
    );
    expect(fallback.children[1]?.textContent).toBe('Download');
    fallback.children[1]?.dispatchEvent(new Event('click'));
    expect(downloads).toBe(1);
    const pendingRoot = new ElementStub();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const selectionSignal: { current: AbortSignal | undefined } = {
      current: undefined,
    };
    let renderStates = 0;
    pendingRoot.addEventListener('relic:render-state', () => renderStates++);
    const pending = mountDocumentRoute(
      pendingRoot as unknown as HTMLElement,
      valid,
      'docx',
      async (index, signal) => {
        selectionSignal.current = signal;
        const metadata = await index.read('word/document.xml');
        if (!metadata.ok) throw new Error(metadata.reason);
        started.resolve();
        await release.promise;
        return select(index);
      },
      createFrame,
      () => {}
    );
    await started.promise;
    pendingRoot.isConnected = false;
    observerState.onMutation?.();
    expect(selectionSignal.current?.aborted).toBe(true);
    pendingRoot.isConnected = true;
    release.resolve();
    await pending;
    expect(frameCount).toBe(4);
    expect(pendingRoot.children).toEqual([]);
    expect(renderStates).toBe(0);

    const rejectedRoot = new ElementStub();
    const rejectedStarted = Promise.withResolvers<void>();
    const rejectRelease = Promise.withResolvers<void>();
    const rejectedSignal: { current: AbortSignal | undefined } = {
      current: undefined,
    };
    rejectedRoot.addEventListener('relic:render-state', () => renderStates++);
    const rejected = mountDocumentRoute(
      rejectedRoot as unknown as HTMLElement,
      valid,
      'docx',
      async (_index, signal) => {
        rejectedSignal.current = signal;
        rejectedStarted.resolve();
        await rejectRelease.promise;
        throw new Error('metadata selection cancelled');
      },
      createFrame,
      () => {}
    );
    await rejectedStarted.promise;
    rejectedRoot.isConnected = false;
    observerState.onMutation?.();
    expect(rejectedSignal.current?.aborted).toBe(true);
    rejectedRoot.isConnected = true;
    rejectRelease.resolve();
    await rejected;
    expect(frameCount).toBe(4);
    expect(rejectedRoot.children).toEqual([]);
    expect(renderStates).toBe(0);

    const pendingProtectedRoot = new ElementStub();
    const protectedStarted = Promise.withResolvers<void>();
    const protectedRelease = Promise.withResolvers<void>();
    const protectedSignal: { current: AbortSignal | undefined } = {
      current: undefined,
    };
    const pendingProtected = mountDocumentRoute(
      pendingProtectedRoot as unknown as HTMLElement,
      valid,
      'epub',
      async (_index, signal) => {
        protectedSignal.current = signal;
        protectedStarted.resolve();
        await protectedRelease.promise;
        return { ok: false, reason: 'protected' };
      },
      createFrame,
      () => {}
    );
    await protectedStarted.promise;
    pendingProtectedRoot.isConnected = false;
    observerState.onMutation?.();
    expect(protectedSignal.current?.aborted).toBe(true);
    pendingProtectedRoot.isConnected = true;
    protectedRelease.resolve();
    await pendingProtected;
    expect(pendingProtectedRoot.children).toEqual([]);
    expect(frameCount).toBe(4);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
    if (previousObserver)
      Object.defineProperty(globalThis, 'MutationObserver', previousObserver);
    else Reflect.deleteProperty(globalThis, 'MutationObserver');
  }
});

test('detaching during ZIP indexing stops reads and never mounts a frame', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    'MutationObserver'
  );
  const observerState: { onMutation?: () => void } = {};
  let disconnects = 0;
  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true,
    value: class {
      constructor(callback: () => void) {
        observerState.onMutation = callback;
      }
      observe() {}
      disconnect() {
        disconnects++;
      }
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => new ElementStub() },
  });
  try {
    const root = new ElementStub();
    const original = contentFromBytes(zip([['word/document.xml', '<root/>']]));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reads = 0;
    let selections = 0;
    let frames = 0;
    let renderStates = 0;
    root.addEventListener('relic:render-state', () => renderStates++);
    const content = {
      ...original,
      async read(start: number, end: number) {
        reads++;
        if (reads === 3) {
          started.resolve();
          await release.promise;
        }
        return original.read(start, end);
      },
    };
    const pending = mountDocumentRoute(
      root as unknown as HTMLElement,
      content,
      'docx',
      async () => {
        selections++;
        return { parts: [], xmlParts: new Set<string>() };
      },
      () => {
        frames++;
        throw new Error('A detached route must not create a frame');
      },
      () => {}
    );
    await started.promise;
    root.isConnected = false;
    observerState.onMutation?.();
    expect(disconnects).toBe(1);
    root.isConnected = true;
    release.resolve();
    await pending;
    expect(reads).toBe(3);
    expect(selections).toBe(0);
    expect(frames).toBe(0);
    expect(root.children).toEqual([]);
    expect(renderStates).toBe(0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
    if (previousObserver)
      Object.defineProperty(globalThis, 'MutationObserver', previousObserver);
    else Reflect.deleteProperty(globalThis, 'MutationObserver');
  }
});

/** Stands in for the viewer's DOM and mutation observer for one test. */
function installDom(): { mutate(): void; restore(): void } {
  const previousDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    'document'
  );
  const previousObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    'MutationObserver'
  );
  const observed: { onMutation?: () => void } = {};
  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true,
    value: class {
      constructor(callback: () => void) {
        observed.onMutation = callback;
      }
      observe() {}
      disconnect() {}
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => new ElementStub() },
  });
  return {
    mutate: () => observed.onMutation?.(),
    restore: () => {
      if (previousDocument)
        Object.defineProperty(globalThis, 'document', previousDocument);
      else Reflect.deleteProperty(globalThis, 'document');
      if (previousObserver)
        Object.defineProperty(globalThis, 'MutationObserver', previousObserver);
      else Reflect.deleteProperty(globalThis, 'MutationObserver');
    },
  };
}

interface FrameRecord {
  readonly payload: RenderDocumentMessage;
  readonly frame: ElementStub;
  disposals: number;
  state(state: DocumentStateMessage): void;
  blocks(blocks: readonly DocumentBlock[] | null | 'invalid'): void;
}

/** Records each frame a mount creates, with the callbacks it was given. */
function recordFrames(): {
  frames: FrameRecord[];
  createFrame: CreateDocumentFrame;
} {
  const frames: FrameRecord[] = [];
  const createFrame: CreateDocumentFrame = (
    payload,
    _transfer,
    onState,
    onBlocks
  ) => {
    const record: FrameRecord = {
      payload,
      frame: new ElementStub(),
      disposals: 0,
      state: onState,
      blocks: onBlocks,
    };
    frames.push(record);
    return {
      frame: record.frame,
      linkConfirm: new ElementStub(),
      linkRemembered: new ElementStub(),
      dispose: () => {
        record.disposals++;
      },
    } as unknown as DocumentFrame;
  };
  return { frames, createFrame };
}

async function selectAll(index: ZipIndex) {
  const parts = [...index.entries.keys()];
  return { parts, xmlParts: new Set(parts) };
}

const READY: DocumentStateMessage = {
  type: 'relic:document-state',
  state: 'ready',
};

const BOOK: EpubBook = {
  title: 'River journal',
  progression: 'default',
  layout: 'reflowable',
  resources: [],
  spine: [{ path: 'ch1.xhtml', linear: true }],
  toc: [],
  pageList: [],
};

const DOCX_CONTENT = () =>
  contentFromBytes(zip([['word/document.xml', '<root/>']]));

test('a comparison mount marks its frame and reports its blocks and book once', async () => {
  const dom = installDom();
  try {
    const root = new ElementStub();
    const { frames, createFrame } = recordFrames();
    const reports: DocumentSnapshotResult[] = [];
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      contentFromBytes(zip([['chapter', '<html/>']])),
      'epub',
      async (index) => ({ ...(await selectAll(index)), book: BOOK }),
      createFrame,
      () => {},
      { onSnapshot: (result) => reports.push(result) }
    );
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.payload.compare).toBe(true);
    frame.state(READY);
    const blocks: DocumentBlock[] = [
      { kind: 'paragraph', text: 'We crossed at dawn.', part: 0 },
    ];
    frame.blocks(blocks);
    frame.blocks([]);
    frame.blocks(null);
    expect(reports).toEqual([{ kind: 'blocks', blocks, book: BOOK }]);
    expect(frame.frame.removed).toBe(false);
  } finally {
    dom.restore();
  }
});

test('a plain mount carries no compare flag and reports nothing', async () => {
  const dom = installDom();
  try {
    const root = new ElementStub();
    const { frames, createFrame } = recordFrames();
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      DOCX_CONTENT(),
      'docx',
      selectAll,
      createFrame,
      () => {}
    );
    const frame = frames[0]!;
    expect('compare' in frame.payload).toBe(false);
    frame.state(READY);
    frame.blocks([]);
    expect(frame.frame.removed).toBe(false);
  } finally {
    dom.restore();
  }
});

test('a protected book is reported as protected and never framed', async () => {
  const dom = installDom();
  try {
    const root = new ElementStub();
    const { frames, createFrame } = recordFrames();
    const reports: DocumentSnapshotResult[] = [];
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      contentFromBytes(zip([['META-INF/rights.xml', '<rights/>']])),
      'epub',
      async () => ({ ok: false, reason: 'protected' }),
      createFrame,
      () => {},
      { onSnapshot: (result) => reports.push(result) }
    );
    expect(frames).toHaveLength(0);
    expect(reports).toEqual([{ kind: 'unavailable', reason: 'protected' }]);
    expect(root.children[0]?.children[0]?.textContent).toBe(
      'This ebook is protected by DRM and cannot be shown.'
    );
  } finally {
    dom.restore();
  }
});

test('a refused selection other than DRM is reported as failed', async () => {
  const dom = installDom();
  try {
    for (const reason of ['corrupt', 'too-large'] as const) {
      const root = new ElementStub();
      const { frames, createFrame } = recordFrames();
      const reports: DocumentSnapshotResult[] = [];
      await mountDocumentRoute(
        root as unknown as HTMLElement,
        DOCX_CONTENT(),
        'docx',
        async () => ({ ok: false, reason }),
        createFrame,
        () => {},
        { onSnapshot: (result) => reports.push(result) }
      );
      expect(frames).toHaveLength(0);
      expect(reports).toEqual([{ kind: 'unavailable', reason: 'failed' }]);
      expect(root.children[0]?.children[0]?.textContent).toBe(
        'This document could not be shown.'
      );
    }
  } finally {
    dom.restore();
  }
});

test('a render that fails is reported as failed, and its frame goes', async () => {
  const dom = installDom();
  try {
    const root = new ElementStub();
    const { frames, createFrame } = recordFrames();
    const reports: DocumentSnapshotResult[] = [];
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      DOCX_CONTENT(),
      'docx',
      selectAll,
      createFrame,
      () => {},
      { onSnapshot: (result) => reports.push(result) }
    );
    const frame = frames[0]!;
    frame.state({
      type: 'relic:document-state',
      state: 'failed',
      reason: 'corrupt',
    });
    frame.blocks([{ kind: 'paragraph', text: 'late', part: 0 }]);
    expect(reports).toEqual([{ kind: 'unavailable', reason: 'failed' }]);
    expect(frame.frame.removed).toBe(true);
    expect(frame.disposals).toBe(1);
    expect(root.children[0]?.children[0]?.textContent).toBe(
      'This document could not be shown.'
    );
  } finally {
    dom.restore();
  }
});

test('a frame that cannot send its blocks is too large, and its render stays', async () => {
  const dom = installDom();
  try {
    const root = new ElementStub();
    const { frames, createFrame } = recordFrames();
    const reports: DocumentSnapshotResult[] = [];
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      DOCX_CONTENT(),
      'docx',
      selectAll,
      createFrame,
      () => {},
      { onSnapshot: (result) => reports.push(result) }
    );
    const frame = frames[0]!;
    frame.state(READY);
    frame.blocks(null);
    expect(reports).toEqual([{ kind: 'unavailable', reason: 'too-large' }]);
    expect(frame.frame.removed).toBe(false);
    expect(frame.disposals).toBe(0);
  } finally {
    dom.restore();
  }
});

test('blocks the frame refuses are reported as invalid, and the render stays', async () => {
  const dom = installDom();
  try {
    const root = new ElementStub();
    const { frames, createFrame } = recordFrames();
    const reports: DocumentSnapshotResult[] = [];
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      DOCX_CONTENT(),
      'docx',
      selectAll,
      createFrame,
      () => {},
      { onSnapshot: (result) => reports.push(result) }
    );
    const frame = frames[0]!;
    frame.state(READY);
    frame.blocks('invalid');
    expect(reports).toEqual([{ kind: 'unavailable', reason: 'invalid' }]);
    expect(frame.frame.removed).toBe(false);
  } finally {
    dom.restore();
  }
});

test('a frame that never reports its blocks times out ten seconds after it is ready', async () => {
  const dom = installDom();
  jest.useFakeTimers();
  try {
    const root = new ElementStub();
    const { frames, createFrame } = recordFrames();
    const reports: DocumentSnapshotResult[] = [];
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      DOCX_CONTENT(),
      'docx',
      selectAll,
      createFrame,
      () => {},
      { onSnapshot: (result) => reports.push(result) }
    );
    const frame = frames[0]!;
    jest.advanceTimersByTime(20_000);
    frame.state(READY);
    jest.advanceTimersByTime(DOCUMENT_BLOCKS_WAIT_MS - 1);
    expect(reports).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(reports).toEqual([{ kind: 'unavailable', reason: 'timeout' }]);
    expect(frame.frame.removed).toBe(false);
    frame.blocks([{ kind: 'paragraph', text: 'late', part: 0 }]);
    expect(reports).toHaveLength(1);
  } finally {
    jest.useRealTimers();
    dom.restore();
  }
});

test('disconnecting a comparison disposes its frame and settles it once', async () => {
  const dom = installDom();
  jest.useFakeTimers();
  try {
    const root = new ElementStub();
    const { frames, createFrame } = recordFrames();
    const reports: DocumentSnapshotResult[] = [];
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      DOCX_CONTENT(),
      'docx',
      selectAll,
      createFrame,
      () => {},
      { onSnapshot: (result) => reports.push(result) }
    );
    const frame = frames[0]!;
    frame.state(READY);
    root.isConnected = false;
    dom.mutate();
    expect(frame.disposals).toBe(1);
    expect(reports).toEqual([{ kind: 'unavailable', reason: 'failed' }]);
    jest.advanceTimersByTime(DOCUMENT_BLOCKS_WAIT_MS);
    frame.blocks([]);
    expect(reports).toHaveLength(1);
    expect(frame.disposals).toBe(1);
  } finally {
    jest.useRealTimers();
    dom.restore();
  }
});

test('a comparison whose root is detached before it mounts never creates a frame', async () => {
  const dom = installDom();
  try {
    const root = new ElementStub();
    root.isConnected = false;
    const { frames, createFrame } = recordFrames();
    const reports: DocumentSnapshotResult[] = [];
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      DOCX_CONTENT(),
      'docx',
      selectAll,
      createFrame,
      () => {},
      { onSnapshot: (result) => reports.push(result) }
    );
    expect(frames).toHaveLength(0);
    expect(reports).toEqual([{ kind: 'unavailable', reason: 'failed' }]);
  } finally {
    dom.restore();
  }
});

test('a frame that cannot be created is reported as failed', async () => {
  const dom = installDom();
  try {
    const root = new ElementStub();
    const reports: DocumentSnapshotResult[] = [];
    await mountDocumentRoute(
      root as unknown as HTMLElement,
      DOCX_CONTENT(),
      'docx',
      selectAll,
      () => {
        throw new Error('no frame');
      },
      () => {},
      { onSnapshot: (result) => reports.push(result) }
    );
    expect(reports).toEqual([{ kind: 'unavailable', reason: 'failed' }]);
    expect(root.children[0]?.children[0]?.textContent).toBe(
      'This document could not be shown.'
    );
  } finally {
    dom.restore();
  }
});
