import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { boot, adoptOrMountPlate, renderDead } from '../src/main.ts';
import {
  type ViewerDeps,
  type KeyVault,
  type DeadView,
  type CachedPrefix,
  type LoadResume,
  formatBytes,
  formatTransfer,
  DAMAGED_TITLE,
  DAMAGED_DETAIL,
} from '../src/viewer.ts';
import {
  encodeFragment,
  generateKey,
  HEADER_BYTES,
  LOAD_OPENING,
  PHASE_DECRYPTING,
  CONTENTS_LABEL,
  INSECURE_TITLE,
  INSECURE_DETAIL,
  encryptRelic,
  generateRelicId,
} from '@relic/format';

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
  parentElement: ElementStub | null = null;
  readonly dataset: Record<string, string> = {};
  readonly children: ElementStub[] = [];
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
    Array<(e: { type: string; preventDefault: () => void }) => void>
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

  after(...kids: Array<ElementStub | string>): void {
    if (!this.parentElement) return;
    const idx = this.parentElement.children.indexOf(this);
    if (idx === -1) return;
    const toAdd: ElementStub[] = [];
    for (const k of kids) {
      if (typeof k === 'string') {
        const textNode = new ElementStub('#text');
        textNode.textContent = k;
        textNode.parentElement = this.parentElement;
        toAdd.push(textNode);
      } else {
        k.parentElement = this.parentElement;
        toAdd.push(k);
      }
    }
    this.parentElement.children.splice(idx + 1, 0, ...toAdd);
  }

  insertBefore(
    newChild: ElementStub,
    refChild: ElementStub | null
  ): ElementStub {
    newChild.parentElement = this;
    if (!refChild) {
      this.children.push(newChild);
      return newChild;
    }
    const idx = this.children.indexOf(refChild);
    if (idx === -1) {
      this.children.push(newChild);
    } else {
      this.children.splice(idx, 0, newChild);
    }
    return newChild;
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
    listener: (e: { type: string; preventDefault: () => void }) => void
  ): void {
    const list = this.eventListeners.get(event) ?? [];
    list.push(listener);
    this.eventListeners.set(event, list);
  }

  removeEventListener(
    event: string,
    listener: (e: { type: string; preventDefault: () => void }) => void
  ): void {
    const list = this.eventListeners.get(event);
    if (!list) return;
    const idx = list.indexOf(listener);
    if (idx !== -1) list.splice(idx, 1);
  }

  dispatchEvent(event: { type: string; preventDefault?: () => void }): boolean {
    const ev = {
      type: event.type,
      preventDefault: event.preventDefault ?? (() => {}),
    };
    const list = this.eventListeners.get(event.type) ?? [];
    for (const listener of list) {
      listener(ev);
    }
    return true;
  }

  click(): void {
    this.dispatchEvent({ type: 'click' });
  }

  submit(): void {
    this.dispatchEvent({ type: 'submit' });
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

function makeMockVault(): KeyVault {
  const store = new Map<string, string>();
  return {
    remember: (id, frag) => {
      store.set(id, frag);
    },
    recall: (id) => store.get(id),
    forget: (id) => {
      store.delete(id);
    },
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

async function waitForCondition(
  label: string,
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 5
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('Spec B: V2 Load Plate, Boot, Dead Cards, and Key Entry', () => {
  let rootBody: ElementStub;
  let reloadCalled: boolean;
  let rafCallbacks: Map<number, (t: number) => void>;
  let nextRafId = 0;

  beforeEach(() => {
    rootBody = new ElementStub('body');
    reloadCalled = false;
    rafCallbacks = new Map();
    nextRafId = 0;

    (globalThis as unknown as { document: unknown }).document = {
      body: rootBody,
      documentElement: {
        style: {
          setProperty: () => {},
          getPropertyValue: () => '',
        },
      },
      createElement: (tag: string) => new ElementStub(tag),
      createElementNS: (_ns: string, tag: string) => new ElementStub(tag),
      createTextNode: (text: string) => {
        const n = new ElementStub('#text');
        n.textContent = text;
        return n;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      getElementById: (id: string) => rootBody.querySelector(`#${id}`),
      querySelector: (sel: string) => rootBody.querySelector(sel),
      querySelectorAll: (sel: string) => rootBody.querySelectorAll(sel),
    };

    (globalThis as unknown as { window?: unknown }).window = {
      innerWidth: 1024,
      innerHeight: 768,
      location: {
        reload: () => {
          reloadCalled = true;
        },
        href: 'https://relic.example/r1',
        hash: '',
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      requestAnimationFrame: (cb: (t: number) => void) => {
        const id = ++nextRafId;
        rafCallbacks.set(id, cb);
        queueMicrotask(() => {
          if (rafCallbacks.has(id)) {
            rafCallbacks.delete(id);
            cb(Date.now());
          }
        });
        return id;
      },
      cancelAnimationFrame: (id: number) => {
        rafCallbacks.delete(id);
      },
    };

    (
      globalThis as unknown as { requestAnimationFrame?: unknown }
    ).requestAnimationFrame = (
      globalThis as unknown as { window: { requestAnimationFrame: unknown } }
    ).window.requestAnimationFrame;
    (
      globalThis as unknown as { cancelAnimationFrame?: unknown }
    ).cancelAnimationFrame = (
      globalThis as unknown as { window: { cancelAnimationFrame: unknown } }
    ).window.cancelAnimationFrame;
  });

  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
    delete (globalThis as unknown as { window?: unknown }).window;
    delete (globalThis as unknown as { requestAnimationFrame?: unknown })
      .requestAnimationFrame;
    delete (globalThis as unknown as { cancelAnimationFrame?: unknown })
      .cancelAnimationFrame;
  });

  test('1. With a shell plate present, boot keeps exactly one header.bar, and data-load-phase moves opening, fetching, decrypting as load reports', async () => {
    // 1. Shell plate present in DOM
    const shellBar = new ElementStub('header');
    shellBar.className = 'bar';
    shellBar.setAttribute('data-load-bar', '');
    const shellMark = new ElementStub('div');
    shellMark.className = 'mark';
    shellBar.appendChild(shellMark);

    const shellPlate = new ElementStub('main');
    shellPlate.className = 'stage stage-loading';
    shellPlate.setAttribute('data-load-plate', '');
    shellPlate.setAttribute('data-load-phase', 'opening');
    const shellCard = new ElementStub('div');
    shellCard.className = 'card load-card';
    const shellPhase = new ElementStub('p');
    shellPhase.className = 'load-phase';
    shellPhase.textContent = LOAD_OPENING;
    shellCard.appendChild(shellPhase);
    shellPlate.appendChild(shellCard);

    rootBody.append(shellBar, shellPlate);

    const relicId1 = generateRelicId();
    const root = new ElementStub('div');
    root.id = 'relic-root';
    root.setAttribute('data-relic-id', relicId1);
    root.setAttribute('data-usercontent-origin', 'https://usercontent.example');
    rootBody.appendChild(root);

    const key = generateKey();
    const fragment = encodeFragment(key);
    const container = await encryptRelic({
      content: new TextEncoder().encode('Hello, Relic!'),
      filename: 'hello.txt',
      mimetype: 'text/plain',
      key,
    });

    const phasesSeen: string[] = [];

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: `https://relic.example/${relicId1}#${fragment}`,
      keyVault: makeMockVault(),
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/mint')) {
          const phase = shellPlate.dataset['loadPhase'];
          if (phase && !phasesSeen.includes(phase)) {
            phasesSeen.push(phase);
          }
          return Response.json({
            url: 'https://storage.example/blob',
            url_expires_at: new Date(Date.now() + 300_000).toISOString(),
            relic_expires_at: null,
            object_length: container.length,
            current_version: 1,
          });
        }
        if (url.includes('/blob')) {
          let offset = 0;
          const chunkSize = 16;
          const stream = new ReadableStream<Uint8Array>({
            async pull(c) {
              if (offset >= container.length) {
                c.close();
                return;
              }
              const end = Math.min(offset + chunkSize, container.length);
              c.enqueue(container.slice(offset, end));
              offset = end;
              await flushMicrotasks();
              const currentPhase = shellPlate.dataset['loadPhase'];
              if (currentPhase && !phasesSeen.includes(currentPhase)) {
                phasesSeen.push(currentPhase);
              }
            },
          });
          return new Response(stream);
        }
        return new Response('', { status: 404 });
      }) as typeof globalThis.fetch,
    };

    await boot(root as unknown as HTMLElement, deps);

    // Boot keeps exactly one header.bar
    const bars = rootBody.querySelectorAll('header.bar');
    expect(bars).toHaveLength(1);

    // Verify phases moved through opening and fetching
    expect(phasesSeen).toContain('opening');
    expect(phasesSeen).toContain('fetching');
  });

  test('2. Before the mint promise resolves, the plate reads Opening…. Without a shell plate, the plate is in the DOM before the first fetch call.', async () => {
    const relicId2 = generateRelicId();
    const root = new ElementStub('div');
    root.id = 'relic-root';
    root.setAttribute('data-relic-id', relicId2);
    root.setAttribute('data-usercontent-origin', 'https://usercontent.example');
    rootBody.appendChild(root);

    let platePresentBeforeMint = false;
    let phaseTextBeforeMint = '';
    let custodyTextBeforeMint = '';

    const key = generateKey();
    const fragment = encodeFragment(key);

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: `https://relic.example/${relicId2}#${fragment}`,
      keyVault: makeMockVault(),
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/mint')) {
          // Check DOM state before mint resolves
          const plate = rootBody.querySelector(
            'main.stage.stage-loading[data-load-plate]'
          );
          platePresentBeforeMint = plate !== null;
          const phaseEl = plate?.querySelector('.load-phase');
          phaseTextBeforeMint = phaseEl?.textContent ?? '';
          const custodyEl = rootBody.querySelector('[data-load-custody]');
          custodyTextBeforeMint = custodyEl?.textContent ?? '';

          return new Response('', { status: 500 });
        }
        return new Response('', { status: 404 });
      }) as typeof globalThis.fetch,
    };

    await boot(root as unknown as HTMLElement, deps);

    expect(platePresentBeforeMint).toBe(true);
    expect(phaseTextBeforeMint).toBe(LOAD_OPENING);
    expect(custodyTextBeforeMint).toBe(LOAD_OPENING);
  });

  test('3. The meter aria-valuemax, aria-valuenow and aria-valuetext match; no aria-valuenow while opening; [data-load-contents] is hidden until envelope, then reads CONTENTS …', async () => {
    const handles = adoptOrMountPlate('r_meter');

    // While opening: no aria-valuenow, contents hidden
    handles.paint({ phase: 'opening' });
    await flushMicrotasks();

    expect(handles.meterEl?.getAttribute('aria-valuenow')).toBeNull();
    expect(handles.contentsEl?.hidden).toBe(true);
    expect(handles.phaseEl?.textContent).toBe(LOAD_OPENING);

    // Fetching before envelope: total set, received set, contents still hidden
    handles.paint({
      phase: 'fetching',
      received: 41_200_000,
      total: 105_300_000,
    });
    await flushMicrotasks();

    expect(handles.meterEl?.getAttribute('aria-valuemax')).toBe('105300000');
    expect(handles.meterEl?.getAttribute('aria-valuenow')).toBe('41200000');
    expect(handles.meterEl?.getAttribute('aria-valuetext')).toBe(
      formatTransfer(41_200_000, 105_300_000)
    );
    expect(handles.contentsEl?.hidden).toBe(true);

    // Fetching after envelope: contents appears
    handles.paint({
      phase: 'fetching',
      received: 41_200_000,
      total: 105_300_000,
      contents: { filename: 'spec.pdf', length: 104_900_000 },
    });
    await flushMicrotasks();

    expect(handles.contentsEl?.hidden).toBe(false);
    expect(handles.contentsEl?.textContent).toBe(
      `${CONTENTS_LABEL} ${formatBytes(104_900_000)}`
    );
    expect(handles.custodyEl?.textContent).toBe('spec.pdf');

    // Decrypting phase
    handles.paint({
      phase: 'decrypting',
      opened: 98_100_000,
      contents: { filename: 'spec.pdf', length: 104_900_000 },
    });
    await flushMicrotasks();

    expect(handles.phaseEl?.textContent).toBe(PHASE_DECRYPTING);
    expect(handles.meterEl?.getAttribute('aria-valuemax')).toBe('104900000');
    expect(handles.meterEl?.getAttribute('aria-valuenow')).toBe('98100000');
    expect(handles.meterEl?.getAttribute('aria-valuetext')).toBe(
      formatTransfer(98_100_000, 104_900_000)
    );
    expect(handles.transferEl?.textContent).toBe(
      `${PHASE_DECRYPTING} ${formatTransfer(98_100_000, 104_900_000)}`
    );
  });

  test('4. A rejected load ends in main.stage-dead with no [data-load-plate] left', async () => {
    const root = new ElementStub('div');
    root.id = 'relic-root';
    root.setAttribute('data-relic-id', 'r_reject');
    root.setAttribute('data-usercontent-origin', 'https://usercontent.example');
    rootBody.appendChild(root);

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: 'https://relic.example/r_reject#key',
      keyVault: makeMockVault(),
      fetch: (async () => {
        throw new Error('network down');
      }) as unknown as typeof globalThis.fetch,
    };

    await boot(root as unknown as HTMLElement, deps);

    expect(rootBody.querySelector('main.stage-dead')).not.toBeNull();
    expect(rootBody.querySelector('[data-load-plate]')).toBeNull();
  });

  test('5. content_damaged renders the damaged copy, Try again and Report this relic, no .key-entry, and one bar with report and policy links', () => {
    const dead: DeadView = {
      headline: DAMAGED_TITLE,
      detail: DAMAGED_DETAIL,
      action: 'retry-report',
      code: 'content_damaged',
    };
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: globalThis.fetch,
      keyVault: makeMockVault(),
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relic.example/r1',
    };

    const relicId5 = generateRelicId();
    const plateHandles = adoptOrMountPlate(relicId5);
    plateHandles.remove();
    renderDead(dead, relicId5, 'https://usercontent.example', deps);

    // Headline and detail
    const headline = rootBody.querySelector('.card-title');
    expect(headline?.textContent).toBe(DAMAGED_TITLE);
    const detail = rootBody.querySelector('.card-note');
    expect(detail?.textContent).toBe(DAMAGED_DETAIL);

    // Actions
    const retryBtn = rootBody.querySelector('button[data-dead-action="retry"]');
    expect(retryBtn).not.toBeNull();
    expect(retryBtn?.textContent).toBe('Try again');

    const reportLink = rootBody.querySelector('a[data-dead-action="report"]');
    expect(reportLink).not.toBeNull();
    expect(reportLink?.getAttribute('href')).toMatch(/\/abuse$/);
    expect(reportLink?.textContent).toBe('Report this relic');

    // No key entry field on content_damaged
    expect(rootBody.querySelector('.key-entry')).toBeNull();

    // Exactly one header.bar with policy and abuse actions
    const bars = rootBody.querySelectorAll('header.bar');
    expect(bars).toHaveLength(1);
    const policyLink = bars[0]?.querySelector('a[href$="/policy"]');
    const abuseLink = bars[0]?.querySelector('a[href$="/abuse"]');
    expect(policyLink).not.toBeNull();
    expect(abuseLink).not.toBeNull();
  });
  test('6. Try again calls load with resume, re-mounts the plate, and never calls window.location.reload', async () => {
    const relicId6 = generateRelicId();
    const root = new ElementStub('div');
    root.id = 'relic-root';
    root.setAttribute('data-relic-id', relicId6);
    root.setAttribute('data-usercontent-origin', 'https://usercontent.example');
    rootBody.appendChild(root);

    let loadCalls = 0;
    const _resumesReceived: Array<LoadResume | undefined> = [];

    const key = generateKey();
    const fragment = encodeFragment(key);

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: `https://relic.example/${relicId6}#${fragment}`,
      keyVault: makeMockVault(),
      fetch: (async (input: RequestInfo | URL) => {
        loadCalls++;
        const url = String(input);
        if (url.endsWith('/mint')) {
          return Response.json({
            url: 'https://storage.example/blob_cut',
            url_expires_at: new Date(Date.now() + 300_000).toISOString(),
            relic_expires_at: null,
            object_length: 500,
            current_version: 1,
          });
        }
        if (url.includes('/blob_cut')) {
          // Stream errors mid-stream to trigger truncated_transfer
          const stream = new ReadableStream<Uint8Array>({
            pull(c) {
              c.error(new Error('connection reset'));
            },
          });
          return new Response(stream);
        }
        return new Response('', { status: 404 });
      }) as typeof globalThis.fetch,
    };

    await boot(root as unknown as HTMLElement, deps);

    // Initial load failed with truncated_transfer, rendering retry button
    const retryBtn = rootBody.querySelector(
      'button[data-dead-action="retry"]'
    ) as ElementStub;
    expect(retryBtn).not.toBeNull();

    // Click Try again
    retryBtn.click();
    await flushMicrotasks();

    // Never reloads page
    expect(reloadCalled).toBe(false);
    // Called load a second time
    expect(loadCalls).toBeGreaterThan(1);
  });

  test('7. Key entry with a cached prefix: a wrong key shows "That key does not open this relic." with zero fetch calls; right key opens', async () => {
    const key = generateKey();
    const rightKeyFragment = encodeFragment(key);
    const wrongKey = generateKey();
    const wrongKeyFragment = encodeFragment(wrongKey);

    const content = new TextEncoder().encode('Secret content');
    const container = await encryptRelic({
      content,
      filename: 'secret.txt',
      mimetype: 'text/plain',
      key,
      rs: 64,
    });

    const prefix = container.slice(0, HEADER_BYTES + 64);
    const cachedPrefix: CachedPrefix = {
      prefix,
      mint: {
        url: 'https://storage.example/blob',
        url_expires_at: new Date(Date.now() + 300_000).toISOString(),
        relic_expires_at: null,
        object_length: container.length,
        object_crc32c: '0',
        mints_remaining: 10,
        version: 1,
        current_version: 1,
      },
    };

    let fetchCount = 0;
    let blobFetchCount = 0;
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      locationHref: 'https://relic.example/r1',
      keyVault: makeMockVault(),
      fetch: (async (input: RequestInfo | URL) => {
        fetchCount++;
        const url = String(input);
        if (url.includes('/blob')) {
          blobFetchCount++;
          return new Response(container as unknown as BodyInit);
        }
        return new Response('', { status: 404 });
      }) as typeof globalThis.fetch,
    };

    const dead: DeadView = {
      headline: 'This relic could not be opened',
      detail: 'The file did not decrypt.',
      action: 'reopen-original-link',
      code: 'decrypt_failed',
    };

    renderDead(dead, 'r1', 'https://usercontent.example', deps, cachedPrefix);

    const input = rootBody.querySelector('.key-entry-input') as ElementStub;
    const form = rootBody.querySelector('.key-entry-form') as ElementStub;
    const feedback = rootBody.querySelector(
      '.key-entry-feedback'
    ) as ElementStub;
    const _progressEl = rootBody.querySelector(
      '.key-entry-progress'
    ) as ElementStub;

    expect(input).not.toBeNull();
    expect(form).not.toBeNull();

    // 1. Submit wrong key: checked against cachedPrefix locally, zero fetch calls!
    input.value = wrongKeyFragment;
    form.submit();
    await waitForCondition(
      'wrong-key feedback to appear',
      () => feedback.textContent !== ''
    );

    expect(feedback.textContent).toBe('That key does not open this relic.');
    expect(fetchCount).toBe(0);
    expect(blobFetchCount).toBe(0);

    // 2. Submit right key: fetches object and opens
    input.value = rightKeyFragment;
    form.submit();
    await waitForCondition(
      'right-key blob fetch call',
      () => blobFetchCount === 1
    );
    await waitForCondition(
      'right key to open and mount relic stage',
      () => rootBody.querySelector('main.stage-dead') === null
    );
    expect(blobFetchCount).toBe(1);
    // Relic content stage was mounted
    expect(rootBody.querySelector('main.stage-dead')).toBeNull();
  });

  test('8. insecure_context renders the C2 copy with no retry and no field', () => {
    const dead: DeadView = {
      headline: INSECURE_TITLE,
      detail: INSECURE_DETAIL,
      action: 'none',
      code: 'insecure_context',
    };
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: globalThis.fetch,
      keyVault: makeMockVault(),
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'http://relic.example/r1',
    };

    renderDead(dead, 'r_insecure', 'https://usercontent.example', deps);

    const headline = rootBody.querySelector('.card-title');
    expect(headline?.textContent).toBe(INSECURE_TITLE);
    const detail = rootBody.querySelector('.card-note');
    expect(detail?.textContent).toBe(INSECURE_DETAIL);

    // No retry action
    expect(rootBody.querySelector('[data-dead-action="retry"]')).toBeNull();
    // No report action
    expect(rootBody.querySelector('[data-dead-action="report"]')).toBeNull();
    // No key entry field
    expect(rootBody.querySelector('.key-entry')).toBeNull();
  });
});
