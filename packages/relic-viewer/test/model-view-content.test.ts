import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { RelicContent } from '../src/content.ts';
import { MODEL_LIMITS } from '../src/model-parse.ts';
import { mountModelView } from '../src/model-view.ts';

class ElementStub extends EventTarget {
  readonly dataset: Record<string, string> = {};
  readonly children: ElementStub[] = [];
  readonly classList = { add: (..._names: string[]) => undefined };
  parentNode: ElementStub | null = null;
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  tabIndex = 0;
  id = '';
  type = '';
  title = '';
  rel = '';
  href = '';

  constructor(
    readonly ownerDocument: DocumentStub,
    readonly tagName: string
  ) {
    super();
  }

  setAttribute(_name: string, _value: string): void {}

  append(...nodes: ElementStub[]): void {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }

  appendChild(node: ElementStub): ElementStub {
    this.append(node);
    return node;
  }

  replaceChildren(...nodes: ElementStub[]): void {
    for (const node of this.children) node.parentNode = null;
    this.children.length = 0;
    this.append(...nodes);
  }

  remove(): void {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentNode = null;
  }

  querySelectorAll(selector: string): ElementStub[] {
    return this.children.flatMap((child) => [
      ...(child.tagName === selector ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

class WindowStub extends EventTarget {
  devicePixelRatio = 1;
  matchMedia() {
    return new EventTarget();
  }
  setTimeout(): number {
    return 1;
  }
  clearTimeout(): void {}
  cancelAnimationFrame(): void {}
}

class DocumentStub {
  readonly defaultView = new WindowStub();
  readonly head = new ElementStub(this, 'head');

  createElement(tag: string): ElementStub {
    return new ElementStub(this, tag);
  }

  createElementNS(_namespace: string, tag: string): ElementStub {
    return this.createElement(tag);
  }
}

class WorkerStub {
  static instances = 0;
  static readonly messages: Array<{ format: string; bytes: ArrayBuffer }> = [];
  static posted = Promise.withResolvers<void>();
  onmessage: unknown = null;
  onerror: unknown = null;
  onmessageerror: unknown = null;
  terminated = false;

  constructor() {
    WorkerStub.instances++;
  }

  postMessage(message: { format: string; bytes: ArrayBuffer }): void {
    WorkerStub.messages.push(message);
    WorkerStub.posted.resolve();
  }

  terminate(): void {
    this.terminated = true;
  }
}

const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');

beforeEach(() => {
  WorkerStub.instances = 0;
  WorkerStub.messages.length = 0;
  WorkerStub.posted = Promise.withResolvers<void>();
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: WorkerStub,
  });
});

afterEach(() => {
  if (workerDescriptor)
    Object.defineProperty(globalThis, 'Worker', workerDescriptor);
  else Reflect.deleteProperty(globalThis, 'Worker');
});

function container(): ElementStub {
  const doc = new DocumentStub();
  return doc.createElement('div');
}

function source(
  size: number,
  readWhole: RelicContent['readWhole']
): RelicContent {
  return {
    size,
    head: new Uint8Array(),
    tail: new Uint8Array(),
    blob: () => new Blob(),
    read: async () => new Uint8Array(),
    readWhole,
  };
}

describe('model content bounds', () => {
  test('keeps the established source and triangle limits', () => {
    expect(MODEL_LIMITS.maxBytes).toBe(16 * 1024 * 1024);
    expect(MODEL_LIMITS.maxTriangles).toBe(250_000);
  });

  test('refuses a source above 16 MiB before reading or starting a worker', () => {
    let reads = 0;
    const root = container();
    const dispose = mountModelView(
      root as unknown as HTMLElement,
      'obj',
      source(MODEL_LIMITS.maxBytes + 1, async () => {
        reads++;
        return new Uint8Array();
      })
    );
    expect(root.children[0]?.dataset['modelState']).toBe('limit-exceeded');
    expect(reads).toBe(0);
    expect(WorkerStub.instances).toBe(0);
    expect(WorkerStub.messages).toHaveLength(0);
    dispose();
  });

  test('reads a model at the limit and sends a transfer copy to the parser', async () => {
    const bytes = new Uint8Array(MODEL_LIMITS.maxBytes);
    bytes.set([3, 1, 4, 1, 5]);
    let limit = 0;
    const root = container();
    const dispose = mountModelView(
      root as unknown as HTMLElement,
      'stl',
      source(bytes.length, async (requested) => {
        limit = requested;
        return bytes;
      })
    );
    await WorkerStub.posted.promise;
    expect(limit).toBe(MODEL_LIMITS.maxBytes);
    expect(WorkerStub.instances).toBe(1);
    expect(WorkerStub.messages).toHaveLength(1);
    const message = WorkerStub.messages[0]!;
    expect(message.format).toBe('stl');
    expect(message.bytes.byteLength).toBe(MODEL_LIMITS.maxBytes);
    expect(Array.from(new Uint8Array(message.bytes, 0, 5))).toEqual([
      3, 1, 4, 1, 5,
    ]);
    expect(message.bytes).not.toBe(bytes.buffer);
    dispose();
  });

  test('does not start a worker if the view is disposed while the read is pending', async () => {
    const pending = Promise.withResolvers<Uint8Array | undefined>();
    const root = container();
    const dispose = mountModelView(
      root as unknown as HTMLElement,
      'obj',
      source(3, () => pending.promise)
    );
    dispose();
    pending.resolve(new Uint8Array([1, 2, 3]));
    await pending.promise;
    await Promise.resolve();
    expect(WorkerStub.instances).toBe(0);
    expect(WorkerStub.messages).toHaveLength(0);
  });

  test('shows the fixed parser error when the bounded read fails', async () => {
    const pending = Promise.withResolvers<Uint8Array | undefined>();
    const root = container();
    const dispose = mountModelView(
      root as unknown as HTMLElement,
      'obj',
      source(3, () => pending.promise)
    );
    pending.reject(new Error('private source bytes'));
    await pending.promise.catch(() => undefined);
    await Promise.resolve();
    expect(root.children[0]?.dataset['modelState']).toBe('internal-error');
    expect(WorkerStub.messages).toHaveLength(0);
    dispose();
  });
});
