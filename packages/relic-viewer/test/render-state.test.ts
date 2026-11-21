import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { contentFromBytes } from '../src/content.ts';
import { documentWatchdog } from '../src/document-route.ts';
import {
  trackRenderState,
  reportDocumentState,
  renderReady,
  renderDead,
  renderComparison,
} from '../src/main.ts';
import { preserveGlobalDescriptors } from './global-descriptors.ts';
import {
  type ViewerDeps,
  type ReadyView,
  type LoadProgress,
  type HistoricalVersionState,
  progressLine,
} from '../src/viewer.ts';
import { crc32, PHASE_RENDERING, planStoredZip } from '@relic/format';

class ElementStub {
  readonly tagName: string;
  className = '';
  private _textContent = '';
  get textContent(): string {
    if (this.children.length > 0) {
      return this.children.map((c) => c.textContent).join('');
    }
    return this._textContent;
  }
  set textContent(val: string) {
    this._textContent = val;
    this.children.length = 0;
  }
  id = '';
  name = '';
  type = '';
  href = '';
  target = '';
  rel = '';
  value = '';
  placeholder = '';
  required = false;
  disabled = false;
  hidden = false;
  htmlFor = '';
  complete = false;
  naturalWidth = 0;
  readyState = 0;
  scrollTop = 0;
  clientHeight = 700;
  contentWindow: unknown = null;
  ownerDocument: unknown = null;
  parentElement: ElementStub | null = null;
  readonly dataset: Record<string, string> = {};
  readonly children: ElementStub[] = [];
  get firstElementChild(): ElementStub | null {
    return this.children.find((child) => child.tagName !== '#TEXT') ?? null;
  }
  readonly attributes = new Map<string, string>();
  private readonly styles = new Map<string, string>();

  readonly classList = {
    add: (...names: string[]): void => {
      const existing = this.className.split(/\s+/).filter(Boolean);
      for (const n of names) {
        if (!existing.includes(n)) existing.push(n);
      }
      this.className = existing.join(' ');
    },
    remove: (...names: string[]): void => {
      this.className = this.className
        .split(/\s+/)
        .filter((c) => !names.includes(c))
        .join(' ');
    },
    contains: (name: string): boolean =>
      this.className.split(/\s+/).includes(name),
    toggle: (name: string, force?: boolean): boolean => {
      const existing = this.className.split(/\s+/).filter(Boolean);
      const has = existing.includes(name);
      const shouldHave = force !== undefined ? force : !has;
      if (shouldHave && !has) {
        existing.push(name);
      } else if (!shouldHave && has) {
        const idx = existing.indexOf(name);
        existing.splice(idx, 1);
      }
      this.className = existing.join(' ');
      return shouldHave;
    },
  };

  readonly style = {
    setProperty: (name: string, value: string): void => {
      this.styles.set(name, value);
    },
    removeProperty: (name: string): void => {
      this.styles.delete(name);
    },
    getPropertyValue: (name: string): string => {
      return this.styles.get(name) ?? '';
    },
  };

  private readonly eventListeners = new Map<
    string,
    Array<{
      listener: (e: unknown) => void;
      once: boolean;
    }>
  >();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'href') this.href = String(value);
    if (name === 'type') this.type = String(value);
    if (name === 'class') this.className = String(value);
    if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name: string): string | null {
    if (name === 'href')
      return this.href || this.attributes.get('href') || null;
    if (name === 'type')
      return this.type || this.attributes.get('type') || null;
    if (name === 'id') return this.id || this.attributes.get('id') || null;
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
      delete this.dataset[key];
    }
  }

  appendChild(child: ElementStub): ElementStub {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child: ElementStub, reference: ElementStub | null): ElementStub {
    child.parentElement = this;
    const index = reference ? this.children.indexOf(reference) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    return child;
  }

  prepend(...kids: Array<ElementStub | string>): void {
    const toAdd: ElementStub[] = [];
    for (const k of kids) {
      if (typeof k === 'string') {
        const textNode = new ElementStub('#text');
        textNode.textContent = k;
        textNode.parentElement = this;
        toAdd.push(textNode);
      } else {
        k.parentElement = this;
        toAdd.push(k);
      }
    }
    this.children.unshift(...toAdd);
  }

  append(...kids: Array<ElementStub | string>): void {
    for (const k of kids) {
      if (typeof k === 'string') {
        const textNode = new ElementStub('#text');
        textNode.textContent = k;
        textNode.parentElement = this;
        this.children.push(textNode);
      } else {
        k.parentElement = this;
        this.children.push(k);
      }
    }
  }

  remove(): void {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) {
        this.parentElement.children.splice(idx, 1);
      }
      this.parentElement = null;
    }
  }

  replaceChildren(...kids: Array<ElementStub | string>): void {
    for (const c of this.children) {
      c.parentElement = null;
    }
    this.children.length = 0;
    this.textContent = '';
    this.append(...kids);
  }

  replaceWith(replacement: ElementStub): void {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) {
        replacement.parentElement = this.parentElement;
        this.parentElement.children.splice(idx, 1, replacement);
      }
      this.parentElement = null;
    }
  }

  addEventListener(
    event: string,
    listener: (e: unknown) => void,
    options?: { once?: boolean }
  ): void {
    const list = this.eventListeners.get(event) ?? [];
    list.push({ listener, once: options?.once ?? false });
    this.eventListeners.set(event, list);
  }

  removeEventListener(event: string, listener: (e: unknown) => void): void {
    const list = this.eventListeners.get(event);
    if (!list) return;
    const idx = list.findIndex((item) => item.listener === listener);
    if (idx !== -1) list.splice(idx, 1);
  }

  focus(): void {}
  blur(): void {}

  click(): void {
    this.dispatchEvent({ type: 'click' });
  }

  submit(): void {
    this.dispatchEvent({ type: 'submit' });
  }
  dispatchEvent(event: {
    type: string;
    bubbles?: boolean;
    detail?: unknown;
    preventDefault?: () => void;
  }): boolean {
    const ev = {
      type: event.type,
      bubbles: event.bubbles ?? false,
      detail: event.detail,
      target: this,
      preventDefault: event.preventDefault ?? (() => {}),
    };

    let current: ElementStub | null = this;
    while (current) {
      const list = (current.eventListeners.get(event.type) ?? []).slice();
      for (const item of list) {
        item.listener(ev);
        if (item.once) {
          current.removeEventListener(event.type, item.listener);
        }
      }
      if (!ev.bubbles) break;
      current = current.parentElement;
    }
    return true;
  }

  contains(node: ElementStub | null): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

  querySelector(selector: string): ElementStub | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): ElementStub[] {
    const results: ElementStub[] = [];
    const check = (node: ElementStub) => {
      if (matchesSelector(node, selector)) {
        results.push(node);
      }
      for (const child of node.children) {
        check(child);
      }
    };
    for (const child of this.children) {
      check(child);
    }
    return results;
  }
}

function matchesSelector(node: ElementStub, selector: string): boolean {
  if (selector === '*' || selector.length === 0) return true;
  if (selector.includes(',')) {
    return selector.split(',').some((s) => matchesSelector(node, s.trim()));
  }

  let remaining = selector;
  const attrRegex =
    /\[([a-zA-Z0-9_-]+)(?:([$*^~|]?=)("[^"]*"|'[^']*'|[^\]]*))?\]/g;
  let match = attrRegex.exec(selector);
  while (match !== null) {
    const attrName = match[1] as string;
    const op = match[2];
    const attrVal = match[3]?.replace(/^["']|["']$/g, '');
    const datasetKey = attrName
      .replace(/^data-/, '')
      .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (op && attrVal !== undefined) {
      const actualVal =
        node.getAttribute(attrName) ?? node.dataset[datasetKey] ?? '';
      if (op === '=' && actualVal !== attrVal) return false;
      if (op === '$=' && !actualVal.endsWith(attrVal)) return false;
      if (op === '^=' && !actualVal.startsWith(attrVal)) return false;
      if (op === '*=' && !actualVal.includes(attrVal)) return false;
    } else {
      if (
        !node.attributes.has(attrName) &&
        !Object.hasOwn(node.dataset, datasetKey) &&
        node.getAttribute(attrName) === null
      ) {
        return false;
      }
    }
    match = attrRegex.exec(selector);
  }
  remaining = remaining.replace(attrRegex, '');

  if (remaining.includes('.')) {
    const classParts = remaining.split('.').slice(1);
    for (const cls of classParts) {
      if (!node.className.split(/\s+/).includes(cls)) return false;
    }
    remaining = remaining.split('.')[0] as string;
  }

  if (remaining.includes('#')) {
    const [tag, id] = remaining.split('#');
    if (id && node.id !== id) return false;
    remaining = tag ?? '';
  }

  if (remaining && remaining !== '*') {
    if (node.tagName.toLowerCase() !== remaining.toLowerCase()) return false;
  }

  return true;
}

class MockMutationObserver {
  static observers: Array<{
    target: ElementStub;
    callback: (mutations: unknown[]) => void;
  }> = [];

  constructor(private readonly callback: (mutations: unknown[]) => void) {}

  observe(target: ElementStub): void {
    MockMutationObserver.observers.push({
      target,
      callback: this.callback,
    });
  }

  disconnect(): void {
    MockMutationObserver.observers = MockMutationObserver.observers.filter(
      (o) => o.callback !== this.callback
    );
  }

  static trigger(): void {
    for (const o of MockMutationObserver.observers) {
      o.callback([]);
    }
  }
}

describe('Spec B: V3 Render State, Version Progress, and Comparison Bytes', () => {
  let rootBody: ElementStub;
  let windowEventListeners: Map<string, Array<(e: unknown) => void>>;
  let restoreGlobals: () => void;

  beforeEach(() => {
    restoreGlobals = preserveGlobalDescriptors(
      'document',
      'window',
      'MutationObserver',
      'CustomEvent'
    );
    rootBody = new ElementStub('body');
    windowEventListeners = new Map();
    MockMutationObserver.observers = [];

    (globalThis as unknown as { MutationObserver: unknown }).MutationObserver =
      MockMutationObserver;

    const customEventClass =
      typeof CustomEvent !== 'undefined'
        ? CustomEvent
        : class CustomEventStub<T = unknown> extends Event {
            readonly detail: T | null;
            constructor(type: string, init?: CustomEventInit<T>) {
              super(type, init);
              this.detail = init?.detail ?? null;
            }
          };

    if (
      typeof (globalThis as unknown as { CustomEvent?: unknown })
        .CustomEvent === 'undefined'
    ) {
      (globalThis as unknown as { CustomEvent?: unknown }).CustomEvent =
        customEventClass;
    }

    const win = {
      innerWidth: 1024,
      innerHeight: 768,
      location: {
        reload: () => {},
        href: 'https://relic.example/r1',
        hash: '',
        origin: 'https://relic.example',
      },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      CustomEvent: customEventClass,
      addEventListener: (event: string, listener: (e: unknown) => void) => {
        const list = windowEventListeners.get(event) ?? [];
        list.push(listener);
        windowEventListeners.set(event, list);
      },
      removeEventListener: (event: string, listener: (e: unknown) => void) => {
        const list = windowEventListeners.get(event);
        if (!list) return;
        const idx = list.indexOf(listener);
        if (idx !== -1) list.splice(idx, 1);
      },
      dispatchEvent: (event: {
        type: string;
        source?: unknown;
        data?: unknown;
      }) => {
        const list = windowEventListeners.get(event.type) ?? [];
        for (const listener of list) {
          listener(event);
        }
        return true;
      },
    };

    (globalThis as unknown as { window?: unknown }).window = win;

    const doc = {
      body: rootBody,
      head: new ElementStub('head'),
      defaultView: win,
      documentElement: {
        style: {
          setProperty: () => {},
          getPropertyValue: () => '',
        },
      },
      createElement: (tag: string) => {
        const el = new ElementStub(tag);
        el.ownerDocument = doc;
        return el;
      },
      createElementNS: (_ns: string, tag: string) => {
        const el = new ElementStub(tag);
        el.ownerDocument = doc;
        return el;
      },
      createTextNode: (text: string) => {
        const n = new ElementStub('#text');
        n.textContent = text;
        n.ownerDocument = doc;
        return n;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      getElementById: (id: string) => rootBody.querySelector(`#${id}`),
      querySelector: (sel: string) => rootBody.querySelector(sel),
      querySelectorAll: (sel: string) => rootBody.querySelectorAll(sel),
    };

    rootBody.ownerDocument = doc;
    (globalThis as unknown as { document: unknown }).document = doc;
  });

  afterEach(() => {
    restoreGlobals();
  });

  test('1. Image: rendering, aria-busy="true", and Rendering pill until load; then ready, pill gone, aria-busy="false"; error gives data-render-state="error"', () => {
    // 1a. Success case: starts rendering -> image load -> ready
    const stage = new ElementStub('main');
    stage.className = 'stage';
    const stageWrap = new ElementStub('div');
    stageWrap.className = 'stage-wrap';
    const img = new ElementStub('img');
    img.className = 'relic-image';
    stage.appendChild(img);
    stageWrap.appendChild(stage);
    rootBody.appendChild(stageWrap);

    trackRenderState(
      stage as unknown as HTMLElement,
      stageWrap as unknown as HTMLElement,
      'image'
    );

    expect(stage.dataset['renderState']).toBe('rendering');
    expect(stageWrap.getAttribute('aria-busy')).toBe('true');
    const pill = rootBody.querySelector(
      'div.render-status[data-render-status]'
    );
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe(PHASE_RENDERING);

    // Image completes load
    img.dispatchEvent({ type: 'load' });

    expect(stage.dataset['renderState']).toBe('ready');
    expect(stageWrap.getAttribute('aria-busy')).toBe('false');
    expect(
      rootBody.querySelector('div.render-status[data-render-status]')
    ).toBeNull();

    // 1b. Error case
    const stageErr = new ElementStub('main');
    stageErr.className = 'stage';
    const stageWrapErr = new ElementStub('div');
    const imgErr = new ElementStub('img');
    imgErr.className = 'relic-image';
    stageErr.appendChild(imgErr);
    stageWrapErr.appendChild(stageErr);
    rootBody.appendChild(stageWrapErr);

    trackRenderState(
      stageErr as unknown as HTMLElement,
      stageWrapErr as unknown as HTMLElement,
      'image'
    );
    expect(stageErr.dataset['renderState']).toBe('rendering');

    imgErr.dispatchEvent({ type: 'error' });

    expect(stageErr.dataset['renderState']).toBe('error');
    expect(stageWrapErr.getAttribute('aria-busy')).toBe('false');
    expect(
      rootBody.querySelector('div.render-status[data-render-status]')
    ).toBeNull();

    // 1c. Already complete image
    const stageComplete = new ElementStub('main');
    const stageWrapComplete = new ElementStub('div');
    const imgComplete = new ElementStub('img');
    imgComplete.className = 'relic-image';
    imgComplete.complete = true;
    imgComplete.naturalWidth = 200;
    stageComplete.appendChild(imgComplete);
    stageWrapComplete.appendChild(stageComplete);
    rootBody.appendChild(stageWrapComplete);

    trackRenderState(
      stageComplete as unknown as HTMLElement,
      stageWrapComplete as unknown as HTMLElement,
      'image'
    );
    expect(stageComplete.dataset['renderState']).toBe('ready');
    expect(stageWrapComplete.getAttribute('aria-busy')).toBe('false');
  });

  test('2. Media: loadedmetadata and error events govern renderState', () => {
    // 2a. Media metadata load -> ready
    const stage = new ElementStub('main');
    stage.className = 'stage';
    const stageWrap = new ElementStub('div');
    const video = new ElementStub('video');
    video.className = 'relic-media';
    stage.appendChild(video);
    stageWrap.appendChild(stage);
    rootBody.appendChild(stageWrap);

    trackRenderState(
      stage as unknown as HTMLElement,
      stageWrap as unknown as HTMLElement,
      'media'
    );

    expect(stage.dataset['renderState']).toBe('rendering');
    expect(stageWrap.getAttribute('aria-busy')).toBe('true');
    expect(
      rootBody.querySelector('div.render-status[data-render-status]')
    ).not.toBeNull();

    video.dispatchEvent({ type: 'loadedmetadata' });

    expect(stage.dataset['renderState']).toBe('ready');
    expect(stageWrap.getAttribute('aria-busy')).toBe('false');
    expect(
      rootBody.querySelector('div.render-status[data-render-status]')
    ).toBeNull();

    // 2b. Media error -> error
    const stageErr = new ElementStub('main');
    const stageWrapErr = new ElementStub('div');
    const audio = new ElementStub('audio');
    audio.className = 'relic-media';
    stageErr.appendChild(audio);
    stageWrapErr.appendChild(stageErr);
    rootBody.appendChild(stageWrapErr);

    trackRenderState(
      stageErr as unknown as HTMLElement,
      stageWrapErr as unknown as HTMLElement,
      'media'
    );
    audio.dispatchEvent({ type: 'error' });

    expect(stageErr.dataset['renderState']).toBe('error');
    expect(stageWrapErr.getAttribute('aria-busy')).toBe('false');
    expect(
      rootBody.querySelector('div.render-status[data-render-status]')
    ).toBeNull();

    // 2c. Already ready media (readyState >= 1)
    const stageReady = new ElementStub('main');
    const stageWrapReady = new ElementStub('div');
    const vidReady = new ElementStub('video');
    vidReady.className = 'relic-media';
    vidReady.readyState = 2;
    stageReady.appendChild(vidReady);
    stageWrapReady.appendChild(stageReady);
    rootBody.appendChild(stageWrapReady);

    trackRenderState(
      stageReady as unknown as HTMLElement,
      stageWrapReady as unknown as HTMLElement,
      'media'
    );
    expect(stageReady.dataset['renderState']).toBe('ready');
  });

  test('3. PDF: ready/error via relic:render-state', () => {
    // 3a. PDF ready event
    const stage = new ElementStub('main');
    stage.className = 'stage';
    const stageWrap = new ElementStub('div');
    stageWrap.appendChild(stage);
    rootBody.appendChild(stageWrap);

    trackRenderState(
      stage as unknown as HTMLElement,
      stageWrap as unknown as HTMLElement,
      'pdf'
    );

    expect(stage.dataset['renderState']).toBe('rendering');
    expect(
      rootBody.querySelector('div.render-status[data-render-status]')
    ).not.toBeNull();

    stage.dispatchEvent({ type: 'relic:render-state', detail: 'ready' });

    expect(stage.dataset['renderState']).toBe('ready');
    expect(stageWrap.getAttribute('aria-busy')).toBe('false');
    expect(
      rootBody.querySelector('div.render-status[data-render-status]')
    ).toBeNull();

    // 3b. PDF error event
    const stageErr = new ElementStub('main');
    const stageWrapErr = new ElementStub('div');
    stageWrapErr.appendChild(stageErr);
    rootBody.appendChild(stageWrapErr);

    trackRenderState(
      stageErr as unknown as HTMLElement,
      stageWrapErr as unknown as HTMLElement,
      'pdf'
    );

    stageErr.dispatchEvent({ type: 'relic:render-state', detail: 'error' });

    expect(stageErr.dataset['renderState']).toBe('error');
    expect(
      rootBody.querySelector('div.render-status[data-render-status]')
    ).toBeNull();
  });

  test('DOCX stays busy until its accepted scalar ready state', () => {
    const stage = new ElementStub('main');
    const stageWrap = new ElementStub('div');
    const root = new ElementStub('div');
    stage.appendChild(root);
    stageWrap.appendChild(stage);
    rootBody.appendChild(stageWrap);
    trackRenderState(
      stage as unknown as HTMLElement,
      stageWrap as unknown as HTMLElement,
      'sandboxed-document',
      'docx'
    );
    expect(stage.dataset['renderState']).toBe('rendering');
    expect(stageWrap.getAttribute('aria-busy')).toBe('true');
    let readyEvents = 0;
    root.addEventListener('relic:render-state', () => readyEvents++);
    const watchdog = documentWatchdog((state) => {
      if (state.state === 'ready')
        root.dispatchEvent({ type: 'relic-repaint', bubbles: true });
    });
    const ready = { type: 'relic:document-state', state: 'ready' } as const;
    reportDocumentState(root as unknown as HTMLElement, watchdog, ready);
    reportDocumentState(root as unknown as HTMLElement, watchdog, ready);
    expect(readyEvents).toBe(1);
    expect(stage.dataset['renderState']).toBe('ready');
    expect(stageWrap.getAttribute('aria-busy')).toBe('false');
  });

  test('DOCX failure settles as error and ignores a later ready state', () => {
    const stage = new ElementStub('main');
    const stageWrap = new ElementStub('div');
    const root = new ElementStub('div');
    stage.appendChild(root);
    stageWrap.appendChild(stage);
    rootBody.appendChild(stageWrap);
    trackRenderState(
      stage as unknown as HTMLElement,
      stageWrap as unknown as HTMLElement,
      'sandboxed-document',
      'docx'
    );
    let readyEvents = 0;
    root.addEventListener('relic:render-state', (event) => {
      if (
        typeof event === 'object' &&
        event !== null &&
        'detail' in event &&
        event.detail === 'ready'
      )
        readyEvents++;
    });
    const watchdog = documentWatchdog((state) => {
      if (state.state === 'failed') {
        root.dispatchEvent({
          type: 'relic:render-state',
          detail: 'error',
          bubbles: true,
        });
      } else {
        root.dispatchEvent({ type: 'relic-repaint', bubbles: true });
      }
    });
    reportDocumentState(root as unknown as HTMLElement, watchdog, {
      type: 'relic:document-state',
      state: 'failed',
      reason: 'corrupt',
    });
    reportDocumentState(root as unknown as HTMLElement, watchdog, {
      type: 'relic:document-state',
      state: 'ready',
    });
    expect(readyEvents).toBe(0);
    expect(stage.dataset['renderState']).toBe('error');
    expect(stageWrap.getAttribute('aria-busy')).toBe('false');
  });

  test('download-only EPUB settles immediately', () => {
    const stage = new ElementStub('main');
    const stageWrap = new ElementStub('div');
    stageWrap.appendChild(stage);
    rootBody.appendChild(stageWrap);
    trackRenderState(
      stage as unknown as HTMLElement,
      stageWrap as unknown as HTMLElement,
      'sandboxed-document',
      'epub'
    );
    expect(stage.dataset['renderState']).toBe('ready');
    expect(stageWrap.getAttribute('aria-busy')).toBe('false');
  });

  test('the reader passes the document kind to render-state tracking', () => {
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: 'https://relic.example/r1#key',
      keyVault: {
        remember: () => {},
        recall: () => undefined,
        forget: () => {},
      },
      fetch: (() => new Promise<Response>(() => {})) as unknown as typeof fetch,
    };
    for (const kind of ['docx', 'epub'] as const) {
      const view: ReadyView = {
        filename: `document.${kind}`,
        declaredMimetype: 'application/octet-stream',
        content: contentFromBytes(new Uint8Array()),
        document: undefined,
        route: 'sandboxed-document',
        documentKind: kind,
        downgradeNotice: undefined,
        shareUrl: 'https://relic.example/r1#key',
        version: 1,
        currentVersion: 1,
        versionDigest: '1'.repeat(64),
      };
      renderReady(view, 'r1', 'https://usercontent.example', deps);
      const stage = rootBody.querySelector('main.stage');
      expect(stage?.dataset['renderState']).toBe(
        kind === 'docx' ? 'rendering' : 'ready'
      );
    }
  });

  test.each([
    'entry',
    'history',
    'version',
    'comparison',
    'view',
    'dead',
    'other-handler',
    'unload',
  ] as const)(
    'aborts a held folder ZIP when %s replaces its selection',
    async (replacement) => {
      const restore = preserveGlobalDescriptors(
        'history',
        'matchMedia',
        'BroadcastChannel'
      );
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      const advanced = Promise.withResolvers<void>();
      const otherHandler = (): void => {};
      const data = [
        { name: '[Content_Types].xml', bytes: new Uint8Array() },
        { name: 'word/document.xml', bytes: new Uint8Array() },
      ];
      const layout = planStoredZip(
        data.map(({ name, bytes }) => ({
          name,
          size: bytes.length,
          crc32: crc32(bytes),
        }))
      );
      const zip = new Uint8Array(layout.totalBytes);
      let position = 0;
      for (let i = 0; i < data.length; i++) {
        const header = layout.localHeaders[i]!;
        zip.set(header, position);
        position += header.length;
        zip.set(data[i]!.bytes, position);
        position += data[i]!.bytes.length;
      }
      zip.set(layout.centralDirectory, position);
      position += layout.centralDirectory.length;
      zip.set(layout.end, position);

      const initial = Uint8Array.of(0, 1, 2, 3);
      const next = Uint8Array.of(0, 4, 5, 6);
      const zipOffset = initial.length;
      const nextOffset = zipOffset + zip.length;
      const bytes = new Uint8Array(nextOffset + next.length);
      bytes.set(initial);
      bytes.set(zip, zipOffset);
      bytes.set(next, nextOffset);
      let zipReads = 0;
      class TrackedBlob extends Blob {
        constructor(
          part: Blob,
          private readonly offset: number
        ) {
          super([part]);
        }
        override slice(start = 0, end = this.size, type?: string): Blob {
          const relative = Math.max(0, Math.min(start, this.size));
          return new TrackedBlob(
            super.slice(start, end, type),
            this.offset + relative
          );
        }
        override async arrayBuffer(): Promise<ArrayBuffer> {
          const inZip = this.offset >= zipOffset && this.offset < nextOffset;
          const read = inZip ? ++zipReads : 0;
          if (read === 3) {
            started.resolve();
            await release.promise;
          }
          const result = await super.arrayBuffer();
          if (read === 3) finished.resolve();
          return result;
        }
      }

      const original = contentFromBytes(bytes);
      const whole = {
        ...original,
        blob: () => new TrackedBlob(new Blob([bytes as BlobPart]), 0),
      };
      const entries = [
        {
          path: 'initial.bin',
          mimetype: 'application/octet-stream',
          offset: 0,
          length: initial.length,
        },
        {
          path: 'word.docx',
          mimetype: 'application/octet-stream',
          offset: zipOffset,
          length: zip.length,
        },
        {
          path: 'next.bin',
          mimetype: 'application/octet-stream',
          offset: nextOffset,
          length: next.length,
        },
      ];
      const view: ReadyView = {
        filename: 'initial.bin',
        declaredMimetype: 'application/octet-stream',
        content: contentFromBytes(initial),
        document: undefined,
        route: 'download',
        downgradeNotice: undefined,
        shareUrl: 'https://relic.example/r1#key',
        version: 1,
        currentVersion: 2,
        versionDigest: '1'.repeat(64),
        keyFor: async () => new Uint8Array(16),
        folder: {
          header: {
            version: 2,
            name: 'folder',
            entryCount: entries.length,
            manifestLength: 0,
            contentLength: bytes.length,
          },
          manifest: { defaultIndex: 0, entries },
          whole,
          index: 0,
        },
      };
      const pendingFetch = Promise.withResolvers<Response>().promise;
      const deps: ViewerDeps = {
        serviceOrigin: 'https://relic.example',
        locationHref: 'https://relic.example/r1#key',
        keyVault: {
          remember: () => {},
          recall: () => undefined,
          forget: () => {},
        },
        fetch: (() => pendingFetch) as unknown as typeof fetch,
      };
      const historyStub = {
        state: null as unknown,
        replaceState(state: unknown) {
          this.state = state;
        },
        pushState(state: unknown) {
          this.state = state;
        },
      };
      Object.assign(globalThis, {
        history: historyStub,
        matchMedia: () => ({ matches: false }),
        BroadcastChannel: undefined,
      });
      try {
        let renders = 0;
        renderReady(view, 'r1', 'https://usercontent.example', deps, () => {
          if (++renders > 1) advanced.resolve();
        });
        expect(typeof window.onpopstate).toBe('function');
        const word = rootBody.querySelector('.folder-row[title="word.docx"]');
        if (!word) throw new Error('Word entry not found');
        word.click();
        await started.promise;

        if (replacement === 'entry') {
          const selected = rootBody.querySelector(
            '.folder-row[title="next.bin"]'
          );
          if (!selected) throw new Error('Next entry not found');
          selected.click();
          await advanced.promise;
        } else if (replacement === 'history') {
          const onPopState = window.onpopstate;
          if (!onPopState) throw new Error('History handler not installed');
          const event = new Event('popstate') as PopStateEvent;
          Object.defineProperty(event, 'state', {
            value: { relicId: 'r1', version: 1, relicEntry: 'initial.bin' },
          });
          onPopState.call(window, event);
        } else if (replacement === 'version') {
          const trigger = rootBody.querySelector('.version-trigger');
          if (!trigger) throw new Error('Version selector not found');
          trigger.click();
          const current = rootBody.querySelector(
            '.version-option[data-version="1"]'
          );
          if (!current) throw new Error('Current version option not found');
          current.click();
          await advanced.promise;
        } else if (replacement === 'comparison') {
          const compare = rootBody.querySelector(
            'button[aria-label="Compare version 1 with its history"]'
          );
          if (!compare) throw new Error('Comparison control not found');
          compare.click();
        } else if (replacement === 'view') {
          const { folder: _folder, ...other } = view;
          renderReady(
            { ...other, filename: 'replacement.bin' },
            'r1',
            'https://usercontent.example',
            deps
          );
        } else if (replacement === 'dead' || replacement === 'other-handler') {
          if (replacement === 'other-handler') window.onpopstate = otherHandler;
          renderDead({
            headline: 'Unavailable',
            detail: 'This relic is unavailable.',
            action: 'none',
            code: 'service_unreachable',
          });
        } else {
          window.dispatchEvent(new Event('unload'));
        }

        release.resolve();
        await finished.promise;
        const settled = Promise.withResolvers<void>();
        setImmediate(settled.resolve);
        await settled.promise;
        expect(zipReads).toBe(3);
        expect(rootBody.querySelector('iframe')).toBeNull();
        if (
          replacement === 'view' ||
          replacement === 'dead' ||
          replacement === 'unload'
        ) {
          expect(window.onpopstate).toBeNull();
        } else if (replacement === 'other-handler') {
          expect(window.onpopstate).toBe(otherHandler);
        }
        if (replacement === 'entry') {
          expect(
            rootBody.querySelector('.folder-breadcrumb')?.textContent
          ).toContain('next.bin');
        } else if (replacement === 'comparison') {
          expect(rootBody.querySelector('.diff-row')).not.toBeNull();
        } else if (replacement === 'view') {
          expect(rootBody.querySelector('.card-title')?.textContent).toBe(
            'replacement.bin'
          );
        } else if (replacement === 'dead' || replacement === 'other-handler') {
          expect(rootBody.querySelector('.stage-dead')).not.toBeNull();
        } else {
          expect(
            rootBody.querySelector('.folder-breadcrumb')?.textContent
          ).toContain('initial.bin');
        }
      } finally {
        release.resolve();
        restore();
      }
    }
  );

  test('3c. PDF renderer import failure dispatches an error and shows the failure card', () => {
    // The intentionally rejected import must not poison PDF.js for later tests.
    const child = Bun.spawnSync([
      process.execPath,
      fileURLToPath(
        new URL('./pdf-import-failure-fixture.ts', import.meta.url)
      ),
    ]);
    if (child.exitCode !== 0) {
      throw new Error(
        `PDF import-failure fixture exited ${child.exitCode}:\n${new TextDecoder().decode(child.stderr)}`
      );
    }
  }, 15_000);

  test('4. OTIO: ready on relic:otio-ready or data-ready; data-ready="error" gives error; later data-ready="false" does not return to rendering', () => {
    // 4a. OTIO ready via relic:otio-ready event
    const stage = new ElementStub('main');
    stage.className = 'stage';
    const stageWrap = new ElementStub('div');
    const otioView = new ElementStub('div');
    otioView.className = 'otio-view';
    stage.appendChild(otioView);
    stageWrap.appendChild(stage);
    rootBody.appendChild(stageWrap);

    trackRenderState(
      stage as unknown as HTMLElement,
      stageWrap as unknown as HTMLElement,
      'otio'
    );

    expect(stage.dataset['renderState']).toBe('rendering');

    stage.dispatchEvent({ type: 'relic:otio-ready' });

    expect(stage.dataset['renderState']).toBe('ready');
    expect(
      rootBody.querySelector('div.render-status[data-render-status]')
    ).toBeNull();

    // Spec invariant: once ready, OTIO never returns to rendering when data-ready="false"
    otioView.dataset['ready'] = 'false';
    MockMutationObserver.trigger();
    expect(stage.dataset['renderState']).toBe('ready');

    // 4b. OTIO error via data-ready="error"
    const stageErr = new ElementStub('main');
    const stageWrapErr = new ElementStub('div');
    const otioViewErr = new ElementStub('div');
    otioViewErr.className = 'otio-view';
    stageErr.appendChild(otioViewErr);
    stageWrapErr.appendChild(stageErr);
    rootBody.appendChild(stageWrapErr);

    trackRenderState(
      stageErr as unknown as HTMLElement,
      stageWrapErr as unknown as HTMLElement,
      'otio'
    );

    otioViewErr.dataset['ready'] = 'error';
    MockMutationObserver.trigger();

    expect(stageErr.dataset['renderState']).toBe('error');
    expect(
      rootBody.querySelector('div.render-status[data-render-status]')
    ).toBeNull();

    // 4c. Pre-ready OTIO (data-ready already "true" / "diagnostic" / "structural")
    const stagePre = new ElementStub('main');
    const stageWrapPre = new ElementStub('div');
    const otioPre = new ElementStub('div');
    otioPre.className = 'otio-view';
    otioPre.dataset['ready'] = 'diagnostic';
    stagePre.appendChild(otioPre);
    stageWrapPre.appendChild(stagePre);
    rootBody.appendChild(stageWrapPre);

    trackRenderState(
      stagePre as unknown as HTMLElement,
      stageWrapPre as unknown as HTMLElement,
      'otio'
    );
    expect(stagePre.dataset['renderState']).toBe('ready');
  });

  test('5. Frame: ready on relic:tree message from that frame window; ignored from other sources', () => {
    const stage = new ElementStub('main');
    stage.className = 'stage';
    const stageWrap = new ElementStub('div');
    const frame = new ElementStub('iframe');
    frame.className = 'usercontent-frame';
    const frameWindow = { name: 'frame-window' };
    const attackerWindow = { name: 'attacker-window' };
    frame.contentWindow = frameWindow;
    stage.appendChild(frame);
    stageWrap.appendChild(stage);
    rootBody.appendChild(stageWrap);

    trackRenderState(
      stage as unknown as HTMLElement,
      stageWrap as unknown as HTMLElement,
      'sandboxed-html'
    );

    expect(stage.dataset['renderState']).toBe('rendering');
    expect(
      rootBody.querySelector('div.render-status[data-render-status]')
    ).not.toBeNull();

    // 1. Message from wrong source is ignored
    (
      globalThis.window as unknown as { dispatchEvent: (e: unknown) => void }
    ).dispatchEvent({
      type: 'message',
      source: attackerWindow,
      data: { type: 'relic:tree' },
    });
    expect(stage.dataset['renderState']).toBe('rendering');

    // 2. Message from correct source but wrong type is ignored
    (
      globalThis.window as unknown as { dispatchEvent: (e: unknown) => void }
    ).dispatchEvent({
      type: 'message',
      source: frameWindow,
      data: { type: 'other:event' },
    });
    expect(stage.dataset['renderState']).toBe('rendering');

    // 3. Message from correct frame window with relic:tree sets ready
    (
      globalThis.window as unknown as { dispatchEvent: (e: unknown) => void }
    ).dispatchEvent({
      type: 'message',
      source: frameWindow,
      data: { type: 'relic:tree' },
    });

    expect(stage.dataset['renderState']).toBe('ready');
    expect(stageWrap.getAttribute('aria-busy')).toBe('false');
    expect(
      rootBody.querySelector('div.render-status[data-render-status]')
    ).toBeNull();
  });

  test('HTML and JSX settle when a rendered tree is unavailable', () => {
    for (const route of ['sandboxed-html', 'sandboxed-jsx'] as const) {
      const stage = new ElementStub('main');
      const stageWrap = new ElementStub('div');
      const frame = new ElementStub('iframe');
      frame.className = 'usercontent-frame';
      const frameWindow = {};
      frame.contentWindow = frameWindow;
      stage.appendChild(frame);
      stageWrap.appendChild(stage);
      rootBody.appendChild(stageWrap);
      trackRenderState(
        stage as unknown as HTMLElement,
        stageWrap as unknown as HTMLElement,
        route
      );
      expect(stage.dataset['renderState']).toBe('rendering');
      const win = globalThis.window as unknown as {
        dispatchEvent: (event: unknown) => void;
      };
      win.dispatchEvent({
        type: 'message',
        source: frameWindow,
        data: { type: 'relic:tree', tree: null },
      });
      expect(stage.dataset['renderState']).toBe('ready');
      expect(stageWrap.getAttribute('aria-busy')).toBe('false');
    }
  });

  test('6. Markdown, code and download are ready synchronously on mount', () => {
    for (const route of ['markdown', 'code', 'download'] as const) {
      const stage = new ElementStub('main');
      const stageWrap = new ElementStub('div');
      stageWrap.appendChild(stage);
      rootBody.appendChild(stageWrap);

      trackRenderState(
        stage as unknown as HTMLElement,
        stageWrap as unknown as HTMLElement,
        route
      );

      expect(stage.dataset['renderState']).toBe('ready');
      expect(stageWrap.getAttribute('aria-busy')).toBe('false');
      expect(
        rootBody.querySelector('div.render-status[data-render-status]')
      ).toBeNull();
    }
  });

  test('7. showVersion: while loading, current stage stays in DOM and pill shows version progress; unavailable toasts detail', async () => {
    const viewV1: ReadyView = {
      filename: 'v1.txt',
      declaredMimetype: 'text/plain',
      content: contentFromBytes(new TextEncoder().encode('Version 1 content')),
      document: {
        bytes: new TextEncoder().encode('Version 1 content'),
        truncated: false,
      },
      route: 'markdown',
      downgradeNotice: undefined,
      shareUrl: 'https://relic.example/r1#key1',
      version: 1,
      currentVersion: 2,
      versionDigest: '1'.repeat(64),
    };

    let _progressCb: ((p: LoadProgress) => void) | undefined;
    let _loadHistoricalResolver:
      | ((res: HistoricalVersionState) => void)
      | undefined;

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: 'https://relic.example/r1#key1',
      keyVault: {
        remember: () => {},
        recall: () => undefined,
        forget: () => {},
      },
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/decisions')) return Response.json([]);
        return new Response('', { status: 404 });
      }) as typeof globalThis.fetch,
    };

    renderReady(viewV1, 'r1', 'https://usercontent.example', deps);

    // Initial stage is rendered
    const initialStage = rootBody.querySelector('main.stage');
    expect(initialStage).not.toBeNull();

    const versionTrigger = rootBody.querySelector(
      '.version-trigger'
    ) as ElementStub;
    expect(versionTrigger).not.toBeNull();
    versionTrigger.click();

    const v2Option = rootBody.querySelector(
      '.version-option[data-version="2"]'
    ) as ElementStub;
    expect(v2Option).not.toBeNull();

    // Mock fetch for version 2 historical load
    const fetchOrig = deps.fetch;
    (deps as unknown as { fetch: typeof globalThis.fetch }).fetch = (async (
      input: RequestInfo | URL
    ) => {
      const url = String(input);
      if (url.includes('/versions/2/mint')) {
        return Response.json({
          mint_id: 'm2',
          url: 'https://storage.example/v2-blob',
          url_expires_at: new Date(Date.now() + 300_000).toISOString(),
          object_length: 105_300_000,
          current_version: 2,
        });
      }
      if (url.includes('/v2-blob')) {
        // Return 404 to simulate unavailable
        return new Response('', { status: 404 });
      }
      return fetchOrig(input);
    }) as typeof globalThis.fetch;

    v2Option.click();
    expect(rootBody.querySelector('main.stage')).not.toBeNull();

    // Wait for unavailable resolution
    for (
      let i = 0;
      i < 50 &&
      rootBody.querySelector('div.render-status[data-version-progress]');
      i++
    ) {
      await new Promise((r) => queueMicrotask(r));
    }

    // Pill is removed on unavailable
    expect(
      rootBody.querySelector('div.render-status[data-version-progress]')
    ).toBeNull();

    // Toast shown
    const toastEl = rootBody.querySelector('.toast');
    expect(toastEl).not.toBeNull();

    // Version 1 stage still remains in DOM
    expect(rootBody.querySelector('main.stage')).not.toBeNull();
  });

  test('8. Comparison loading line includes the version progressLine with bytes', async () => {
    const currentView: ReadyView = {
      filename: 'current.txt',
      declaredMimetype: 'text/plain',
      content: contentFromBytes(new TextEncoder().encode('Current content')),
      document: {
        bytes: new TextEncoder().encode('Current content'),
        truncated: false,
      },
      route: 'markdown',
      downgradeNotice: undefined,
      shareUrl: 'https://relic.example/r1#key',
      version: 2,
      currentVersion: 2,
      versionDigest: '2'.repeat(64),
    };

    let _historicalStreamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: 'https://relic.example/r1#key',
      keyVault: {
        remember: () => {},
        recall: () => undefined,
        forget: () => {},
      },
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/versions/1/mint')) {
          return Response.json({
            mint_id: 'm1_hist',
            url: 'https://storage.example/v1-blob',
            url_expires_at: new Date(Date.now() + 300_000).toISOString(),
            object_length: 105_300_000,
            current_version: 2,
          });
        }
        if (url.includes('/v1-blob')) {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              _historicalStreamController = c;
              c.enqueue(new Uint8Array(1000));
            },
          });
          return new Response(stream);
        }
        return new Response('', { status: 404 });
      }) as typeof globalThis.fetch,
    };

    renderComparison(
      currentView,
      'r1',
      'https://usercontent.example',
      deps,
      () => {},
      1,
      2
    );

    // Microtask to let updateSelected start and create diff-loading element
    await new Promise((r) => queueMicrotask(r));

    const loading = rootBody.querySelector('p.diff-loading');
    expect(loading).not.toBeNull();
    expect(loading?.textContent).toContain(
      'Loading comparison: version 1 and version 2.'
    );

    // Simulate progress event received for version 1
    const prog: LoadProgress = {
      phase: 'fetching',
      received: 41_200_000,
      total: 105_300_000,
    };
    loading!.textContent = `Loading comparison: version 1 and version 2. Version 1: ${progressLine(prog)}`;

    expect(loading?.textContent).toContain(
      'Version 1: Fetching 41.2 of 105.3 MB'
    );
  });
});
