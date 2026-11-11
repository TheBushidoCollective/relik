import assert from 'node:assert/strict';
import { contentFromBytes } from '../src/content.ts';
import { renderPdfView } from '../src/main.ts';
import type { ReadyView } from '../src/viewer.ts';

class FixtureCustomEvent<T = unknown> extends Event {
  readonly detail: T | null;

  constructor(type: string, init?: CustomEventInit<T>) {
    super(type, init);
    this.detail = init?.detail ?? null;
  }
}

class FixtureElement extends EventTarget {
  className = '';
  textContent = '';
  isConnected = true;
  readonly children: FixtureElement[] = [];

  constructor(readonly ownerDocument: FixtureDocument) {
    super();
  }

  append(...children: FixtureElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: FixtureElement): FixtureElement {
    this.append(child);
    return child;
  }

  replaceChildren(...children: FixtureElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }
}

class FixtureDocument {
  readonly defaultView = { CustomEvent: FixtureCustomEvent };

  createElement(): FixtureElement {
    return new FixtureElement(this);
  }
}

let matrixAttempts = 0;
Object.defineProperty(globalThis, 'DOMMatrix', {
  configurable: true,
  writable: true,
  value: class FailingDOMMatrix {
    constructor() {
      matrixAttempts++;
      throw new Error('intentional PDF renderer import failure');
    }
  },
});
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  writable: true,
  value: new FixtureDocument(),
});

const view: ReadyView = {
  filename: 'doc.pdf',
  declaredMimetype: 'application/pdf',
  content: contentFromBytes(new Uint8Array([1, 2, 3])),
  document: undefined,
  route: 'pdf',
  downgradeNotice: undefined,
  shareUrl: 'https://relic.example/r1#key',
  version: 1,
  currentVersion: 1,
  versionDigest: '0'.repeat(64),
};
const rendered = renderPdfView(view);
// The fixture document creates only FixtureElements.
const wrapper = rendered as unknown as FixtureElement;
const status = wrapper.children[0];
assert.ok(status);
assert.equal(status.children[0]?.textContent, 'Loading PDF document');
const { promise, resolve, reject } = Promise.withResolvers<Event>();
const timeout = setTimeout(
  () => reject(new Error('PDF renderer did not report its import failure')),
  10_000
);
rendered.addEventListener(
  'relic:render-state',
  (received) => {
    clearTimeout(timeout);
    resolve(received);
  },
  { once: true }
);
const event = await promise;

assert.equal(matrixAttempts, 1, 'the real PDF.js import must hit the failure');
assert.ok('detail' in event);
assert.equal(event.detail, 'error');
assert.equal(event.bubbles, true);
assert.equal(status.className, 'pdf-status-card');
assert.equal(status.children[0]?.className, 'pdf-status-title');
assert.equal(status.children[0]?.textContent, 'Could not load PDF renderer');
assert.equal(status.children[1]?.className, 'thread-note');
assert.equal(
  status.children[1]?.textContent,
  'The viewer could not load the PDF rendering component. Check your connection and try again.'
);
assert.equal(status.children.length, 2);
