import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { encodeFragment, generateKey, parseFragment } from '@relic/format';
import { mnemonicToKey } from '@relic/format/mnemonic';
import {
  COPY_KEYLESS_LABEL,
  COPY_LINK_LABEL,
  COPY_PANEL_TITLE,
  COPY_PHRASE_LABEL,
  KEY_ENTRY_LABEL,
  KEY_ENTRY_PLACEHOLDER,
  KEY_ENTRY_PROMPT,
  KEYLESS_COPIED_NOTE,
  LINK_COPIED_NOTE,
  LINK_LABEL,
  LINK_NOTE,
  PHRASE_COPIED_NOTE,
  PHRASE_FAILED_NOTE,
  PHRASE_LABEL,
  PHRASE_LOADING_NOTE,
  PHRASE_NOTE,
  SPLIT_NOTE,
  keylessLink,
  keyPhraseWords,
} from '../src/copy-link.ts';
import {
  COPY_LINK_PANEL_ID,
  buildBar,
  renderDead,
  toggleCopyLinkPanel,
} from '../src/main.ts';
import { COPY_FAILED_NOTE } from '../src/popover.ts';
import type { DeadView, ReadyView, ViewerDeps } from '../src/viewer.ts';

class ElementStub {
  readonly tagName: string;
  className = '';
  private _textContent = '';
  get textContent(): string {
    if (this.children.length === 0) return this._textContent ?? '';
    return this.children.map((c) => c.textContent ?? '').join('');
  }
  set textContent(val: string) {
    this._textContent = val ?? '';
    this.children.length = 0;
  }
  id = '';
  type = '';
  title = '';
  value = '';
  placeholder = '';
  autocomplete = '';
  spellcheck = true;
  required = false;
  disabled = false;
  htmlFor = '';
  name = '';
  parent: ElementStub | undefined;
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style = {
    setProperty: (_k: string, _v: string): void => {},
  };
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly classList = {
    add: (name: string): void => {
      this.className = `${this.className} ${name}`.trim();
    },
    remove: (name: string): void => {
      this.className = this.className
        .split(' ')
        .filter((c) => c !== name)
        .join(' ');
    },
    contains: (name: string): boolean =>
      this.className.split(' ').includes(name),
  };

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  appendChild(child: ElementStub): ElementStub {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...children: (ElementStub | string)[]): void {
    for (const child of children) {
      if (typeof child === 'string') {
        const text = new ElementStub('#text');
        text.textContent = child;
        this.appendChild(text);
      } else {
        this.appendChild(child);
      }
    }
  }

  insertBefore(
    newChild: ElementStub,
    refChild: ElementStub | null
  ): ElementStub {
    newChild.parent = this;
    if (!refChild) {
      this.children.push(newChild);
    } else {
      const idx = this.children.indexOf(refChild);
      if (idx === -1) {
        this.children.push(newChild);
      } else {
        this.children.splice(idx, 0, newChild);
      }
    }
    return newChild;
  }

  replaceChildren(...children: (ElementStub | string)[]): void {
    for (const child of this.children) {
      child.parent = undefined;
    }
    this.children.length = 0;
    this._textContent = '';
    this.append(...children);
  }

  remove(): void {
    const siblings = this.parent?.children;
    if (siblings === undefined) return;
    const idx = siblings.indexOf(this);
    if (idx !== -1) siblings.splice(idx, 1);
    this.parent = undefined;
  }

  focus(): void {
    dom.active = this;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type);
    if (list) {
      this.listeners.set(
        type,
        list.filter((l) => l !== listener)
      );
    }
  }

  fire(type: string, eventDetails: Record<string, unknown> = {}): void {
    const event = {
      target: this,
      preventDefault: (): void => {},
      stopPropagation: (): void => {},
      ...eventDetails,
    };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  contains(node: ElementStub | null): boolean {
    if (!node) return false;
    let cur: ElementStub | undefined = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parent;
    }
    return false;
  }

  querySelector(selector: string): ElementStub | null {
    return querySelectorStub(this, selector);
  }

  querySelectorAll(selector: string): ElementStub[] {
    return querySelectorAllStub(this, selector);
  }

  getBoundingClientRect(): {
    bottom: number;
    right: number;
    width: number;
    height: number;
  } {
    return { bottom: 50, right: 300, width: 100, height: 40 };
  }

  get nextSibling(): ElementStub | null {
    if (!this.parent) return null;
    const idx = this.parent.children.indexOf(this);
    if (idx === -1 || idx === this.parent.children.length - 1) return null;
    return this.parent.children[idx + 1] ?? null;
  }

  get parentNode(): ElementStub | null {
    return this.parent ?? null;
  }
}

function matchesSelector(el: ElementStub, selector: string): boolean {
  if (selector.startsWith('#')) {
    return el.id === selector.slice(1);
  }
  if (selector.startsWith('.')) {
    return el.classList.contains(selector.slice(1));
  }
  if (selector.startsWith('[')) {
    const attrMatch = selector.match(/\[([a-zA-Z0-9_-]+)(?:="?([^"\]]*)"?)?\]/);
    if (attrMatch) {
      const attrName = attrMatch[1];
      const attrVal = attrMatch[2];
      if (attrName) {
        if (attrName.startsWith('data-')) {
          const camel = attrName
            .slice(5)
            .replace(/-([a-z])/g, (_, g) => g.toUpperCase());
          const val = el.dataset[camel];
          if (attrVal === undefined) return val !== undefined;
          return val === attrVal;
        }
        const val = el.getAttribute(attrName);
        if (attrVal === undefined) return val !== null;
        return val === attrVal;
      }
    }
  }
  if (selector.includes(' ')) {
    const parts = selector.split(/\s+/);
    if (parts.length === 2 && parts[0] === '.bar' && parts[1]) {
      let p = el.parent;
      let insideBar = false;
      while (p) {
        if (p.classList.contains('bar')) insideBar = true;
        p = p.parent;
      }
      return insideBar && matchesSelector(el, parts[1]);
    }
  }
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

function querySelectorStub(
  root: ElementStub,
  selector: string
): ElementStub | null {
  for (const child of root.children) {
    if (matchesSelector(child, selector)) return child;
    const found = querySelectorStub(child, selector);
    if (found) return found;
  }
  return null;
}

function querySelectorAllStub(
  root: ElementStub,
  selector: string
): ElementStub[] {
  const result: ElementStub[] = [];
  for (const child of root.children) {
    if (matchesSelector(child, selector)) result.push(child);
    result.push(...querySelectorAllStub(child, selector));
  }
  return result;
}

const dom: {
  body: ElementStub;
  active: ElementStub | undefined;
  docListeners: Map<string, ((event: unknown) => void)[]>;
  winListeners: Map<string, ((event: unknown) => void)[]>;
} = {
  body: new ElementStub('body'),
  active: undefined,
  docListeners: new Map(),
  winListeners: new Map(),
};

let clipboardWrites: string[] = [];
let clipboardShouldReject = false;

function installDom(): void {
  dom.body = new ElementStub('body');
  dom.active = undefined;
  dom.docListeners.clear();
  dom.winListeners.clear();
  clipboardWrites = [];
  clipboardShouldReject = false;

  (globalThis as unknown as Record<string, unknown>).document = {
    body: dom.body,
    createElement: (tag: string) => new ElementStub(tag),
    createElementNS: (_ns: string, tag: string) => new ElementStub(tag),
    createRange: () => ({
      selectNodeContents: () => {},
    }),
    getElementById: (id: string) => dom.body.querySelector(`#${id}`),
    querySelector: (sel: string) => {
      if (matchesSelector(dom.body, sel)) return dom.body;
      return dom.body.querySelector(sel);
    },
    querySelectorAll: (sel: string) => dom.body.querySelectorAll(sel),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      dom.docListeners.set(type, [
        ...(dom.docListeners.get(type) ?? []),
        listener,
      ]);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      const list = dom.docListeners.get(type);
      if (list) {
        dom.docListeners.set(
          type,
          list.filter((l) => l !== listener)
        );
      }
    },
  };

  (globalThis as unknown as Record<string, unknown>).window = {
    innerWidth: 1024,
    setTimeout: (_fn: () => void) => {
      return 0;
    },
    clearTimeout: () => {},
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 0;
    },
    cancelAnimationFrame: () => {},
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      dom.winListeners.set(type, [
        ...(dom.winListeners.get(type) ?? []),
        listener,
      ]);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      const list = dom.winListeners.get(type);
      if (list) {
        dom.winListeners.set(
          type,
          list.filter((l) => l !== listener)
        );
      }
    },
    getSelection: () => ({
      removeAllRanges: () => {},
      addRange: () => {},
    }),
  };

  (globalThis as unknown as Record<string, unknown>).navigator = {
    clipboard: {
      writeText: async (text: string) => {
        if (clipboardShouldReject) throw new Error('refused');
        clipboardWrites.push(text);
      },
    },
  };
}

describe('Copy link panel (Spec C)', () => {
  const key = generateKey();
  const fragment = `#${encodeFragment(key)}`;
  const shareUrl = `https://relik.link/testrelic123${fragment}`;

  const view: ReadyView = {
    filename: 'doc.md',
    declaredMimetype: 'text/markdown',
    content: new Uint8Array([1, 2, 3]),
    route: 'markdown',
    downgradeNotice: undefined,
    shareUrl,
    version: 1,
    currentVersion: 1,
    versionDigest:
      '0000000000000000000000000000000000000000000000000000000000000000',
  };

  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    // clean up
  });

  test('1. keylessLink removes fragment and never contains #', () => {
    expect(keylessLink('https://relik.link/abc#r1X')).toBe(
      'https://relik.link/abc'
    );
    expect(keylessLink('https://relik.link/abc#')).toBe(
      'https://relik.link/abc'
    );
    expect(keylessLink('https://relik.link/abc')).toBe(
      'https://relik.link/abc'
    );
    expect(keylessLink(shareUrl).includes('#')).toBe(false);
  });

  test('2. keyPhraseWords returns 12 words that match key', async () => {
    const words = await keyPhraseWords(shareUrl);
    expect(words.length).toBe(12);
    const recoveredKey = mnemonicToKey(words.join(' '));
    const originalKey = parseFragment(new URL(shareUrl).hash).key;
    expect([...recoveredKey]).toEqual([...originalKey]);
  });

  test('3. Clicking Copy link opens #copy-link-panel with role dialog and title, writes nothing to clipboard', () => {
    const bar = buildBar(view, 'markdown', {}) as unknown as ElementStub;
    dom.body.appendChild(bar);

    const opener = bar.querySelector('[data-action="copy-link"]');
    expect(opener).not.toBeNull();
    if (!opener) throw new Error('no opener');

    opener.fire('click');

    const panel = dom.body.querySelector('#copy-link-panel');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('role')).toBe('dialog');
    const title = panel?.querySelector('#copy-link-title');
    expect(title?.textContent).toBe(COPY_PANEL_TITLE);
    expect(clipboardWrites).toEqual([]);
    expect(bar.nextSibling).toBe(panel);
  });

  test('4. Opener aria attributes and bar rebuild while open', () => {
    const bar = buildBar(view, 'markdown', {}) as unknown as ElementStub;
    dom.body.appendChild(bar);

    const opener = bar.querySelector('[data-action="copy-link"]');
    expect(opener?.dataset['action']).toBe('copy-link');
    expect(opener?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(opener?.getAttribute('aria-expanded')).toBe('false');
    expect(opener?.getAttribute('aria-controls')).toBeNull();

    opener?.fire('click');
    expect(opener?.getAttribute('aria-expanded')).toBe('true');
    expect(opener?.getAttribute('aria-controls')).toBe(COPY_LINK_PANEL_ID);

    // Rebuild bar while panel is open
    const rebuiltBar = buildBar(view, 'markdown', {}) as unknown as ElementStub;
    const rebuiltOpener = rebuiltBar.querySelector('[data-action="copy-link"]');
    expect(rebuiltOpener?.getAttribute('aria-expanded')).toBe('true');
    expect(rebuiltOpener?.getAttribute('aria-controls')).toBe(
      COPY_LINK_PANEL_ID
    );
  });

  test('5. After ready, link value equals shareUrl and list holds 12 words in order', async () => {
    const bar = buildBar(view, 'markdown', {}) as unknown as ElementStub;
    dom.body.appendChild(bar);
    const opener = bar.querySelector('[data-action="copy-link"]')!;

    const handle = toggleCopyLinkPanel(
      shareUrl,
      opener as unknown as HTMLElement
    );
    expect(handle).toBeDefined();
    await handle?.ready;

    const panel = handle!.element as unknown as ElementStub;
    const linkValue = panel.querySelector('[data-copy-value="link"]');
    expect(linkValue?.textContent).toBe(shareUrl);

    const phraseList = panel.querySelector('[data-copy-value="phrase"]');
    const lis = phraseList?.querySelectorAll('li') ?? [];
    expect(lis.length).toBe(12);
    const words = await keyPhraseWords(shareUrl);
    for (let i = 0; i < 12; i++) {
      expect(lis[i]?.textContent).toBe(words[i]!);
    }
  });

  test('6. Copy link, Copy without key, and Copy phrase write expected text and toast', async () => {
    const bar = buildBar(view, 'markdown', {}) as unknown as ElementStub;
    dom.body.appendChild(bar);
    const opener = bar.querySelector('[data-action="copy-link"]')!;

    const handle = toggleCopyLinkPanel(
      shareUrl,
      opener as unknown as HTMLElement
    )!;
    await handle.ready;
    const panel = handle.element as unknown as ElementStub;

    // 1. Copy link
    const copyLinkBtn = panel.querySelector('[data-copy="link"]')!;
    copyLinkBtn.fire('click');
    await Promise.resolve();
    await Promise.resolve();
    expect(clipboardWrites).toContain(shareUrl);
    const toast1 = dom.body.querySelectorAll('.toast').pop();
    expect(toast1?.textContent).toBe(LINK_COPIED_NOTE);

    // 2. Copy keyless
    const copyKeylessBtn = panel.querySelector('[data-copy="keyless"]')!;
    copyKeylessBtn.fire('click');
    await Promise.resolve();
    await Promise.resolve();
    expect(clipboardWrites).toContain(keylessLink(shareUrl));
    const toast2 = dom.body.querySelectorAll('.toast').pop();
    expect(toast2?.textContent).toBe(KEYLESS_COPIED_NOTE);

    // 3. Copy phrase
    const copyPhraseBtn = panel.querySelector('[data-copy="phrase"]')!;
    copyPhraseBtn.fire('click');
    await Promise.resolve();
    await Promise.resolve();
    const words = await keyPhraseWords(shareUrl);
    expect(clipboardWrites).toContain(words.join(' '));
    const toast3 = dom.body.querySelectorAll('.toast').pop();
    expect(toast3?.textContent).toBe(PHRASE_COPIED_NOTE);
  });

  test('7. Rejected clipboard write toasts COPY_FAILED_NOTE and no success note', async () => {
    clipboardShouldReject = true;
    const bar = buildBar(view, 'markdown', {}) as unknown as ElementStub;
    dom.body.appendChild(bar);
    const opener = bar.querySelector('[data-action="copy-link"]')!;

    const handle = toggleCopyLinkPanel(
      shareUrl,
      opener as unknown as HTMLElement
    )!;
    await handle.ready;
    const panel = handle.element as unknown as ElementStub;

    const copyLinkBtn = panel.querySelector('[data-copy="link"]')!;
    copyLinkBtn.fire('click');
    await Promise.resolve();
    await Promise.resolve();

    const toasts = dom.body.querySelectorAll('.toast');
    expect(toasts.length).toBeGreaterThan(0);
    const lastToast = toasts[toasts.length - 1];
    expect(lastToast?.textContent).toBe(COPY_FAILED_NOTE);
    for (const t of toasts) {
      expect(t.textContent).not.toBe(LINK_COPIED_NOTE);
    }
  });

  test('8. No toast text contains fragment or any phrase word', async () => {
    const fixedUrl =
      'https://relik.link/q7m2c9x4tz8hb3ka1w6pd5rn0e#r1CzBVep_E6Q4zWH2ix-wRNg';
    const bar = buildBar(
      { ...view, shareUrl: fixedUrl },
      'markdown',
      {}
    ) as unknown as ElementStub;
    dom.body.appendChild(bar);
    const opener = bar.querySelector('[data-action="copy-link"]')!;

    const handle = toggleCopyLinkPanel(
      fixedUrl,
      opener as unknown as HTMLElement
    )!;
    await handle.ready;
    const panel = handle.element as unknown as ElementStub;
    const words = await keyPhraseWords(fixedUrl);
    panel.querySelector('[data-copy="link"]')!.fire('click');
    await Promise.resolve();
    await Promise.resolve();
    const t1 = dom.body.querySelectorAll('.toast').pop();
    expect(t1?.textContent.includes('#r1')).toBe(false);
    for (const w of words)
      expect(t1?.textContent.split(/\s+/)).not.toContain(w);

    panel.querySelector('[data-copy="keyless"]')!.fire('click');
    await Promise.resolve();
    await Promise.resolve();
    const t2 = dom.body.querySelectorAll('.toast').pop();
    expect(t2?.textContent.includes('#r1')).toBe(false);
    for (const w of words)
      expect(t2?.textContent.split(/\s+/)).not.toContain(w);

    panel.querySelector('[data-copy="phrase"]')!.fire('click');
    await Promise.resolve();
    await Promise.resolve();
    const t3 = dom.body.querySelectorAll('.toast').pop();
    expect(t3?.textContent.includes('#r1')).toBe(false);
    for (const w of words)
      expect(t3?.textContent.split(/\s+/)).not.toContain(w);
  });

  test('9. Escape removes panel and sets aria-expanded=false; toggle opener closes and opens', () => {
    const bar = buildBar(view, 'markdown', {}) as unknown as ElementStub;
    dom.body.appendChild(bar);
    const opener = bar.querySelector('[data-action="copy-link"]')!;

    opener.fire('click');
    expect(dom.body.querySelector('#copy-link-panel')).not.toBeNull();
    expect(opener.getAttribute('aria-expanded')).toBe('true');

    // Escape inside panel
    const panel = dom.body.querySelector('#copy-link-panel')!;
    panel.fire('keydown', { key: 'Escape' });
    expect(dom.body.querySelector('#copy-link-panel')).toBeNull();
    expect(opener.getAttribute('aria-expanded')).toBe('false');

    // Second opener click opens
    opener.fire('click');
    expect(dom.body.querySelector('#copy-link-panel')).not.toBeNull();

    // Third opener click closes
    opener.fire('click');
    expect(dom.body.querySelector('#copy-link-panel')).toBeNull();
  });

  test('10. Phrase words only present inside open panel', async () => {
    const words = await keyPhraseWords(shareUrl);
    const bar = buildBar(view, 'markdown', {}) as unknown as ElementStub;
    dom.body.appendChild(bar);
    const opener = bar.querySelector('[data-action="copy-link"]')!;

    const countWordsOutside = () => {
      let count = 0;
      const walk = (el: ElementStub) => {
        if (el.id === COPY_LINK_PANEL_ID) return;
        if (el.children.length === 0) {
          for (const w of words) {
            if (
              typeof el.textContent === 'string' &&
              el.textContent.includes(w)
            )
              count++;
          }
        } else {
          for (const child of el.children) walk(child);
        }
      };
      walk(dom.body);
      return count;
    };
    const beforeCount = countWordsOutside();
    const handle = toggleCopyLinkPanel(
      shareUrl,
      opener as unknown as HTMLElement
    )!;
    await handle.ready;

    const duringCount = countWordsOutside();
    expect(duringCount).toBe(beforeCount);

    handle.close(false);
    const afterCount = countWordsOutside();
    expect(afterCount).toBe(beforeCount);
  });

  test('11. Opening, copying, and closing call no localStorage, sessionStorage, or fetch', async () => {
    let storageCalled = false;
    let fetchCalled = false;

    const origSetItem = (globalThis as Record<string, unknown>).localStorage;
    (globalThis as Record<string, unknown>).localStorage = {
      setItem: () => {
        storageCalled = true;
      },
    };
    (globalThis as Record<string, unknown>).sessionStorage = {
      setItem: () => {
        storageCalled = true;
      },
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response();
    }) as unknown as typeof fetch;

    try {
      const bar = buildBar(view, 'markdown', {}) as unknown as ElementStub;
      dom.body.appendChild(bar);
      const opener = bar.querySelector('[data-action="copy-link"]')!;

      const handle = toggleCopyLinkPanel(
        shareUrl,
        opener as unknown as HTMLElement
      )!;
      await handle.ready;
      const panel = handle.element as unknown as ElementStub;
      panel.querySelector('[data-copy="link"]')!.fire('click');
      panel.querySelector('[data-copy="keyless"]')!.fire('click');
      panel.querySelector('[data-copy="phrase"]')!.fire('click');
      handle.close(false);

      expect(storageCalled).toBe(false);
      expect(fetchCalled).toBe(false);
    } finally {
      (globalThis as Record<string, unknown>).localStorage = origSetItem;
      globalThis.fetch = origFetch;
    }
  });

  test('12. renderDead for fragment_missing shows renamed key entry strings', () => {
    const deadView: DeadView = {
      headline: 'This link is missing its key',
      detail: 'Explanation',
      action: 'retry',
      code: 'fragment_missing',
    };
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relik.example',
      fetch: globalThis.fetch,
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relik.example/relic123',
      keyVault: {
        remember: () => {},
        recall: () => undefined,
        forget: () => {},
        list: () => [],
      },
    };

    renderDead(deadView, 'relic123', 'https://usercontent.example', deps);

    const prompt = dom.body.querySelector('.key-entry-prompt');
    expect(prompt?.textContent).toBe(KEY_ENTRY_PROMPT);

    const label = dom.body.querySelector('.key-entry-label');
    expect(label?.textContent).toBe(KEY_ENTRY_LABEL);

    const input = dom.body.querySelector('.key-entry-input');
    expect(input?.placeholder).toBe(KEY_ENTRY_PLACEHOLDER);
  });

  test('13. URL with query string preserves query in link value and keyless copy', () => {
    const queryUrl = 'https://relik.link/testrelic123?utm_source=review#r1X';
    const bar = buildBar(
      { ...view, shareUrl: queryUrl },
      'markdown',
      {}
    ) as unknown as ElementStub;
    dom.body.appendChild(bar);
    const opener = bar.querySelector('[data-action="copy-link"]')!;

    const handle = toggleCopyLinkPanel(
      queryUrl,
      opener as unknown as HTMLElement
    )!;
    const panel = handle.element as unknown as ElementStub;
    const linkValue = panel.querySelector('[data-copy-value="link"]');
    expect(linkValue?.textContent).toBe(queryUrl);

    expect(keylessLink(queryUrl)).toBe(
      'https://relik.link/testrelic123?utm_source=review'
    );
  });
});
