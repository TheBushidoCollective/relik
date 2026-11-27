import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { armFileDrop, droppedFrom } from '../src/drop-anywhere.ts';
import { isFileDrag } from '../src/file-drag.ts';
import {
  announceUnclaimedFileDrags,
  type DragSignalWindow,
} from '../src/frame-file-drag.ts';

describe('which drags the page takes', () => {
  test('takes a drag that carries files, whatever else it carries', () => {
    expect(isFileDrag(['Files'])).toBe(true);
    expect(isFileDrag(['text/plain', 'Files'])).toBe(true);
  });

  test('leaves a text selection, a link and a page element alone', () => {
    // These are the drags the comment composer, the divider and the timeline
    // already use. Taking one would break them.
    expect(isFileDrag(['text/plain'])).toBe(false);
    expect(isFileDrag(['text/uri-list', 'text/html'])).toBe(false);
    expect(isFileDrag([])).toBe(false);
  });

  test('a drag with no data transfer is not a file drag', () => {
    expect(isFileDrag(null)).toBe(false);
    expect(isFileDrag(undefined)).toBe(false);
  });
});

describe('what a drop carried', () => {
  const file = (name: string) => new File(['x'], name);

  test('reports a folder from its entry, since a folder arrives as an unreadable file', () => {
    const transfer = {
      files: [file('reports')],
      items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }],
    } as unknown as DataTransfer;

    expect(droppedFrom(transfer).isFolder).toBe(true);
  });

  test('reports an ordinary file as not a folder, and keeps every file that was dropped', () => {
    const transfer = {
      files: [file('a.md'), file('b.md')],
      items: [{ webkitGetAsEntry: () => ({ isDirectory: false }) }],
    } as unknown as DataTransfer;

    const dropped = droppedFrom(transfer);
    expect(dropped.isFolder).toBe(false);
    expect(dropped.files.map((f) => f.name)).toEqual(['a.md', 'b.md']);
  });

  test('captures every entry synchronously, including a folder after a file', () => {
    const entries = [{ isDirectory: false }, { isDirectory: true }];
    const transfer = {
      files: [file('a.md'), file('reports')],
      items: entries.map((entry) => ({ webkitGetAsEntry: () => entry })),
    } as unknown as DataTransfer;
    const dropped = droppedFrom(transfer);
    expect(dropped.isFolder).toBe(true);
    expect(dropped.entries.map((entry) => entry.isDirectory)).toEqual([
      false,
      true,
    ]);
  });

  test('copes with a browser that has no entry API', () => {
    const transfer = { files: [file('a.md')] } as unknown as DataTransfer;

    expect(droppedFrom(transfer)).toEqual({
      files: [transfer.files[0] as File],
      isFolder: false,
      entries: [],
    });
  });
});

describe('file drags across the host and content frame', () => {
  class ElementStub {
    readonly style = {};
    readonly dataset: Record<string, string> = {};
    readonly attributes = new Map<string, string>();
    textContent = '';
    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    }
    hasAttribute(name: string): boolean {
      return this.attributes.has(name);
    }
    append(): void {}
    remove(): void {
      curtain = undefined;
    }
  }

  class FrameStub extends ElementStub {
    readonly contentWindow = {};
    readonly classList: { contains(name: string): boolean };

    constructor(content: boolean) {
      super();
      this.classList = {
        contains: (name) => content && name === 'usercontent-frame',
      };
    }
  }

  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLIFrameElement: globalThis.HTMLIFrameElement,
  };
  let curtain: ElementStub | undefined;
  let frame: FrameStub;
  let listeners: Map<string, (event: Event) => void>;
  let opened: string[];
  const fire = (type: string, event: unknown): void =>
    listeners.get(type)?.(event as Event);
  const file = new File(['contents'], 'dropped.txt');
  const transfer = { types: ['Files'], files: [file], items: [] };

  beforeEach(() => {
    curtain = undefined;
    frame = new FrameStub(true);
    listeners = new Map();
    opened = [];
    Object.assign(globalThis, {
      HTMLIFrameElement: FrameStub,
      document: {
        createElement: () => new ElementStub(),
        body: {
          appendChild: (element: ElementStub) => {
            curtain = element;
          },
        },
        querySelector: () => null,
        querySelectorAll: () => [frame],
      },
      window: {
        addEventListener: (type: string, listener: (event: Event) => void) =>
          listeners.set(type, listener),
        setTimeout: () => 1,
        clearTimeout: () => {},
      },
    });
    armFileDrop((dropped) => opened.push(...dropped.files.map((f) => f.name)));
  });

  afterEach(() => {
    Object.assign(globalThis, saved);
  });

  test('an iframe drag raises the curtain until the frame shim is ready', () => {
    fire('dragenter', { target: frame, dataTransfer: transfer });
    expect(curtain).toBeDefined();
    fire('dragleave', { relatedTarget: null });
    expect(curtain).toBeUndefined();

    frame.setAttribute('data-file-drag-ready', '');
    fire('dragenter', { target: frame, dataTransfer: transfer });
    expect(curtain).toBeUndefined();
  });

  test('other host elements, including other iframes, still raise the curtain', () => {
    fire('dragenter', { target: new ElementStub(), dataTransfer: transfer });
    expect(curtain).toBeDefined();
    fire('dragleave', { relatedTarget: null });
    expect(curtain).toBeUndefined();
    fire('dragenter', {
      target: new FrameStub(false),
      dataTransfer: transfer,
    });
    expect(curtain).toBeDefined();
  });

  test('the frame shim reports an unclaimed file drag and the host takes the drop', async () => {
    const frameListeners = new Map<string, (event: DragEvent) => void>();
    const { promise, resolve } = Promise.withResolvers<void>();
    const shim: DragSignalWindow = {
      addEventListener: (type, listener) => frameListeners.set(type, listener),
      parent: {
        postMessage: (data) => {
          fire('message', { source: frame.contentWindow, data });
          resolve();
        },
      },
    };
    announceUnclaimedFileDrags(shim);
    frame.setAttribute('data-file-drag-ready', '');
    fire('dragenter', { target: frame, dataTransfer: transfer });
    expect(curtain).toBeUndefined();
    frameListeners.get('dragover')?.({
      isTrusted: true,
      dataTransfer: transfer,
      defaultPrevented: false,
    } as unknown as DragEvent);
    await promise;
    expect(curtain).toBeDefined();

    fire('drop', { dataTransfer: transfer, preventDefault: () => {} });
    expect(curtain).toBeUndefined();
    expect(opened).toEqual(['dropped.txt']);
  });
});
