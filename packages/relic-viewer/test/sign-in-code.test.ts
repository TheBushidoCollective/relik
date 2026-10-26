import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  SIGN_IN_CODE_CHECKING,
  SIGN_IN_CODE_FAILED,
  SIGN_IN_CODE_LABEL,
  SIGN_IN_CODE_REJECTED,
  SIGN_IN_CODE_REJECTED_AGAIN,
  SIGN_IN_CODE_SUBMIT,
  announceVerified,
  normalizeSignInCode,
  signInCodeEntry,
  signInCodeRateLimitedCopy,
  signedInCopy,
  submitSignInCode,
} from '../src/sign-in-code.ts';
import { signInForm } from '../src/main.ts';
import type { ViewerDeps } from '../src/viewer.ts';
import { generateKey, encodeFragment } from '@relic/format';

class ElementStub {
  readonly tagName: string;
  className = '';
  textContent = '';
  id = '';
  type = '';
  value = '';
  required = false;
  disabled = false;
  parentElement: ElementStub | null = null;
  readonly dataset: Record<string, string> = {};
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
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
    toggle: (name: string, force?: boolean): boolean => {
      const present = this.className.split(/\s+/).includes(name);
      const next = force ?? !present;
      if (next) {
        this.classList.add(name);
      } else {
        this.classList.remove(name);
      }
      return next;
    },
    contains: (name: string): boolean =>
      this.className.split(/\s+/).includes(name),
  };
  private readonly eventListeners = new Map<
    string,
    Array<
      (e: {
        type: string;
        preventDefault: () => void;
        defaultPrevented?: boolean;
      }) => void
    >
  >();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
    if (name === 'type') this.type = value;
    if (name === 'class') this.className = value;
    if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
      this.dataset[key] = value;
    }
  }

  getAttribute(name: string): string | null {
    if (name === 'type')
      return this.type || this.attributes.get('type') || null;
    if (name === 'id') return this.id || this.attributes.get('id') || null;
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  appendChild(child: ElementStub): ElementStub {
    child.parentElement = this;
    this.children.push(child);
    return child;
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

  replaceChildren(...kids: Array<ElementStub | string>): void {
    for (const child of this.children) {
      child.parentElement = null;
    }
    this.children.length = 0;
    this.textContent = '';
    this.append(...kids);
  }

  remove(): void {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) this.parentElement.children.splice(idx, 1);
      this.parentElement = null;
    }
  }

  addEventListener(
    event: string,
    listener: (e: {
      type: string;
      preventDefault: () => void;
      defaultPrevented?: boolean;
    }) => void
  ): void {
    const list = this.eventListeners.get(event) ?? [];
    list.push(listener);
    this.eventListeners.set(event, list);
  }

  dispatchEvent(event: {
    type: string;
    preventDefault: () => void;
    defaultPrevented?: boolean;
  }): boolean {
    const list = this.eventListeners.get(event.type) ?? [];
    for (const listener of list) {
      listener(event);
    }
    return true;
  }

  click(): void {
    this.dispatchEvent({ type: 'click', preventDefault: () => {} });
  }

  submit(): void {
    this.dispatchEvent({ type: 'submit', preventDefault: () => {} });
  }

  select(): void {}
  focus(): void {}

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
  const parts = selector.split(/(?=[.#[])/);
  for (const part of parts) {
    if (part.startsWith('.')) {
      const cls = part.slice(1);
      if (!node.className.split(/\s+/).includes(cls)) return false;
    } else if (part.startsWith('#')) {
      if (node.id !== part.slice(1)) return false;
    } else if (part.startsWith('[') && part.endsWith(']')) {
      const inner = part.slice(1, -1);
      if (inner.includes('=')) {
        const [rawAttr, rawVal] = inner.split('=');
        const attr = rawAttr ? rawAttr.trim() : '';
        const val = rawVal ? rawVal.trim().replace(/^["']|["']$/g, '') : '';
        if (node.getAttribute(attr) !== val) return false;
      } else {
        if (!node.hasAttribute(inner)) return false;
      }
    } else if (part.length > 0) {
      if (node.tagName.toLowerCase() !== part.toLowerCase()) return false;
    }
  }
  return true;
}

let rootBody: ElementStub;

function installDom(): void {
  rootBody = new ElementStub('body');
  (globalThis as { document?: unknown }).document = {
    body: rootBody,
    createElement: (tag: string) => new ElementStub(tag),
    createElementNS: (_ns: string, tag: string) => new ElementStub(tag),
    createTextNode: (text: string) => {
      const stub = new ElementStub('#text');
      stub.textContent = text;
      return stub;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { style: { setProperty: () => {} } },
  };
  (globalThis as { window?: unknown }).window = {
    location: {
      hash: '',
      pathname: '/r1',
      search: '',
      href: 'https://relic.example/r1',
      replaceState: () => {},
    },
    innerWidth: 1440,
  };
}

function clearDom(): void {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

describe('normalizeSignInCode', () => {
  test('strips non-digits and truncates to six digits', () => {
    expect(normalizeSignInCode('123 456')).toBe('123456');
    expect(normalizeSignInCode('123-456')).toBe('123456');
    expect(normalizeSignInCode('1234567')).toBe('123456');
    expect(normalizeSignInCode('abc 12 def 34 gh 56')).toBe('123456');
    expect(normalizeSignInCode('   ')).toBe('');
    expect(normalizeSignInCode('123')).toBe('123');
    expect(normalizeSignInCode('')).toBe('');
  });
});

describe('signInCodeRateLimitedCopy', () => {
  test('formats minutes and handles undefined', () => {
    expect(signInCodeRateLimitedCopy()).toBe(
      'Too many codes tried from here. Wait a few minutes, or open the link in the email.'
    );
    expect(signInCodeRateLimitedCopy(30)).toBe(
      'Too many codes tried from here. Wait about 1 minute, or open the link in the email.'
    );
    expect(signInCodeRateLimitedCopy(60)).toBe(
      'Too many codes tried from here. Wait about 1 minute, or open the link in the email.'
    );
    expect(signInCodeRateLimitedCopy(61)).toBe(
      'Too many codes tried from here. Wait about 2 minutes, or open the link in the email.'
    );
    expect(signInCodeRateLimitedCopy(180)).toBe(
      'Too many codes tried from here. Wait about 3 minutes, or open the link in the email.'
    );
  });
});

describe('signedInCopy', () => {
  test('formats verified address with plainLabel', () => {
    expect(signedInCopy('ada@example.com')).toBe(
      'Signed in as ada@example.com.'
    );
    // Bidi override characters stripped
    expect(signedInCopy('\u202euser@example.com\u202c')).toBe(
      'Signed in as user@example.com.'
    );
  });
});

describe('submitSignInCode', () => {
  test('sends exact JSON body with code, no address, no relic id, no fragment', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody = '';

    const deps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedMethod = init?.method ?? '';
        capturedHeaders = init?.headers;
        capturedBody = String(init?.body ?? '');
        return new Response(JSON.stringify({ email: 'ada@example.com' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof globalThis.fetch,
    };

    const result = await submitSignInCode('123456', deps);
    expect(result).toEqual({ kind: 'verified', email: 'ada@example.com' });
    expect(capturedUrl).toBe('https://relic.example/api/auth/code');
    expect(capturedMethod).toBe('POST');
    expect(capturedHeaders).toEqual({ 'content-type': 'application/json' });
    expect(capturedBody).toBe('{"code":"123456"}');
    expect(capturedBody).not.toContain('#');
    expect(capturedBody).not.toContain('email');
    expect(capturedBody).not.toContain('relic_id');
  });

  test('maps HTTP status codes to SignInCodeResult', async () => {
    // 200 verified
    const okDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () =>
        new Response(JSON.stringify({ email: 'test@example.com' }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch,
    };
    expect(await submitSignInCode('123456', okDeps)).toEqual({
      kind: 'verified',
      email: 'test@example.com',
    });

    // 200 with invalid or empty body -> failed
    const emptyOkDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () =>
        new Response(JSON.stringify({ email: '' }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch,
    };
    expect(await submitSignInCode('123456', emptyOkDeps)).toEqual({
      kind: 'failed',
    });

    const malformedOkDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () =>
        new Response('not json', {
          status: 200,
        })) as unknown as typeof globalThis.fetch,
    };
    expect(await submitSignInCode('123456', malformedOkDeps)).toEqual({
      kind: 'failed',
    });

    // 401 rejected
    const rejectedDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () =>
        new Response(null, {
          status: 401,
        })) as unknown as typeof globalThis.fetch,
    };
    expect(await submitSignInCode('123456', rejectedDeps)).toEqual({
      kind: 'rejected',
    });

    // 429 with retry_after_seconds in body
    const rateLimitedBodyDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () =>
        new Response(JSON.stringify({ retry_after_seconds: 45 }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof globalThis.fetch,
    };
    expect(await submitSignInCode('123456', rateLimitedBodyDeps)).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 45,
    });

    // 429 with Retry-After header
    const rateLimitedHeaderDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () =>
        new Response(null, {
          status: 429,
          headers: { 'retry-after': '90' },
        })) as unknown as typeof globalThis.fetch,
    };
    expect(await submitSignInCode('123456', rateLimitedHeaderDeps)).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 90,
    });

    // 429 with neither
    const rateLimitedPlainDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () =>
        new Response(null, {
          status: 429,
        })) as unknown as typeof globalThis.fetch,
    };
    expect(await submitSignInCode('123456', rateLimitedPlainDeps)).toEqual({
      kind: 'rate_limited',
    });

    // 500 or throw -> failed
    const errorDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () =>
        new Response(null, {
          status: 500,
        })) as unknown as typeof globalThis.fetch,
    };
    expect(await submitSignInCode('123456', errorDeps)).toEqual({
      kind: 'failed',
    });

    const throwDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () => {
        throw new Error('network down');
      }) as unknown as typeof globalThis.fetch,
    };
    expect(await submitSignInCode('123456', throwDeps)).toEqual({
      kind: 'failed',
    });
  });
});

describe('signInCodeEntry DOM and states', () => {
  let container: ElementStub;

  beforeEach(() => {
    installDom();
    container = document.createElement('div') as unknown as ElementStub;
    rootBody.appendChild(container);
  });

  afterEach(() => {
    clearDom();
  });

  test('renders initial idle DOM contract', () => {
    const entry = signInCodeEntry({
      deps: { serviceOrigin: 'https://relic.example', fetch: globalThis.fetch },
      onVerified: () => {},
    }) as unknown as ElementStub;
    container.appendChild(entry);

    expect(entry.className).toBe('sign-in-code');
    expect(entry.hasAttribute('data-sign-in-code')).toBe(true);
    expect(entry.getAttribute('data-state')).toBe('idle');

    const label = entry.querySelector('label.compose-field.sign-in-code-field');
    expect(label).not.toBeNull();
    const span = label?.querySelector('span');
    expect(span?.textContent).toBe(SIGN_IN_CODE_LABEL);

    const input = entry.querySelector(
      'input.compose-input.sign-in-code-input'
    ) as ElementStub;
    expect(input).not.toBeNull();
    expect(input.hasAttribute('data-sign-in-code-input')).toBe(true);
    expect(input.type).toBe('text');
    expect(input.getAttribute('inputmode')).toBe('numeric');
    expect(input.getAttribute('autocomplete')).toBe('one-time-code');
    expect(input.getAttribute('autocapitalize')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.getAttribute('enterkeyhint')).toBe('go');

    // No required, pattern, or maxlength
    expect(input.required).toBe(false);
    expect(input.hasAttribute('pattern')).toBe(false);
    expect(input.hasAttribute('maxlength')).toBe(false);

    const button = entry.querySelector(
      'button.action.primary.sign-in-code-submit'
    ) as ElementStub;
    expect(button).not.toBeNull();
    expect(button.type).toBe('button');
    expect(button.hasAttribute('data-sign-in-code-submit')).toBe(true);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe(SIGN_IN_CODE_SUBMIT);

    const statusEl = entry.querySelector('p.sign-in-code-status');
    expect(statusEl).not.toBeNull();
    expect(statusEl?.hasAttribute('data-sign-in-code-status')).toBe(true);
    expect(statusEl?.getAttribute('role')).toBe('status');
    expect(statusEl?.getAttribute('aria-live')).toBe('polite');
    expect(statusEl?.id).toMatch(/^sign-in-code-status-\d+$/);
    expect(input.getAttribute('aria-describedby')).toBe(statusEl?.id ?? '');
  });

  test('auto-submits at six digits and transitions to checking then verified', async () => {
    let verifiedEmail = '';
    const { promise: fetchPromise, resolve: resolver } =
      Promise.withResolvers<Response>();

    const deps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () => fetchPromise) as unknown as typeof globalThis.fetch,
    };

    const entry = signInCodeEntry({
      deps,
      onVerified: (email) => {
        verifiedEmail = email;
      },
    }) as unknown as ElementStub;
    container.appendChild(entry);

    const input = entry.querySelector(
      '[data-sign-in-code-input]'
    ) as ElementStub;
    const button = entry.querySelector(
      '[data-sign-in-code-submit]'
    ) as ElementStub;
    const statusEl = entry.querySelector(
      '[data-sign-in-code-status]'
    ) as ElementStub;

    // Type 5 digits: button stays disabled, does not submit
    input.value = '12345';
    input.dispatchEvent({ type: 'input', preventDefault: () => {} });
    expect(button.disabled).toBe(true);
    expect(entry.getAttribute('data-state')).toBe('idle');

    // Type 6 digits: auto-submits, button and input become disabled, state is checking
    input.value = '123 456';
    input.dispatchEvent({ type: 'input', preventDefault: () => {} });
    expect(input.value).toBe('123456');
    expect(entry.getAttribute('data-state')).toBe('checking');
    expect(statusEl.textContent).toBe(SIGN_IN_CODE_CHECKING);
    expect(input.disabled).toBe(true);
    expect(button.disabled).toBe(true);

    // Resolve fetch with 200 verified
    resolver(
      new Response(JSON.stringify({ email: 'reader@example.com' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    // Wait for resolution microtasks
    await flushMicrotasks();

    expect(entry.getAttribute('data-state')).toBe('verified');
    expect(statusEl.textContent).toBe('Signed in as reader@example.com.');
    expect(input.disabled).toBe(true);
    expect(button.disabled).toBe(true);
    expect(verifiedEmail).toBe('reader@example.com');
  });

  test('rejections escalate copy at third try and re-enable controls with select', async () => {
    const currentStatus = 401;
    const deps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () =>
        new Response(null, {
          status: currentStatus,
        })) as unknown as typeof globalThis.fetch,
    };

    const entry = signInCodeEntry({
      deps,
      onVerified: () => {},
    }) as unknown as ElementStub;
    container.appendChild(entry);

    const input = entry.querySelector(
      '[data-sign-in-code-input]'
    ) as ElementStub;
    const button = entry.querySelector(
      '[data-sign-in-code-submit]'
    ) as ElementStub;
    const statusEl = entry.querySelector(
      '[data-sign-in-code-status]'
    ) as ElementStub;

    let selected = false;
    input.select = () => {
      selected = true;
    };

    // First rejection
    input.value = '111111';
    input.dispatchEvent({ type: 'input', preventDefault: () => {} });
    await flushMicrotasks();

    expect(entry.getAttribute('data-state')).toBe('rejected');
    expect(statusEl.textContent).toBe(SIGN_IN_CODE_REJECTED);
    expect(input.disabled).toBe(false);
    expect(button.disabled).toBe(false);
    expect(selected).toBe(true);

    // Attempting input event with the exact same rejected value does not auto-submit
    selected = false;
    input.dispatchEvent({ type: 'input', preventDefault: () => {} });
    expect(entry.getAttribute('data-state')).toBe('rejected');
    expect(selected).toBe(false);

    // Second rejection with different code
    input.value = '222222';
    input.dispatchEvent({ type: 'input', preventDefault: () => {} });
    await flushMicrotasks();

    expect(entry.getAttribute('data-state')).toBe('rejected');
    expect(statusEl.textContent).toBe(SIGN_IN_CODE_REJECTED);

    // Third rejection with different code escalates copy
    input.value = '333333';
    input.dispatchEvent({ type: 'input', preventDefault: () => {} });
    await flushMicrotasks();

    expect(entry.getAttribute('data-state')).toBe('rejected');
    expect(statusEl.textContent).toBe(SIGN_IN_CODE_REJECTED_AGAIN);

    // Fourth rejection keeps escalated copy
    input.value = '444444';
    input.dispatchEvent({ type: 'input', preventDefault: () => {} });
    await flushMicrotasks();

    expect(entry.getAttribute('data-state')).toBe('rejected');
    expect(statusEl.textContent).toBe(SIGN_IN_CODE_REJECTED_AGAIN);
  });

  test('rate-limited response transitions to rate-limited state and re-enables controls', async () => {
    const deps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () =>
        new Response(JSON.stringify({ retry_after_seconds: 60 }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof globalThis.fetch,
    };

    const entry = signInCodeEntry({
      deps,
      onVerified: () => {},
    }) as unknown as ElementStub;
    container.appendChild(entry);

    const input = entry.querySelector(
      '[data-sign-in-code-input]'
    ) as ElementStub;
    const button = entry.querySelector(
      '[data-sign-in-code-submit]'
    ) as ElementStub;
    const statusEl = entry.querySelector(
      '[data-sign-in-code-status]'
    ) as ElementStub;

    input.value = '123456';
    input.dispatchEvent({ type: 'input', preventDefault: () => {} });
    await flushMicrotasks();

    expect(entry.getAttribute('data-state')).toBe('rate-limited');
    expect(statusEl.textContent).toBe(signInCodeRateLimitedCopy(60));
    expect(input.disabled).toBe(false);
    expect(button.disabled).toBe(false);
  });

  test('failed response clears lastSubmitted so same value can be retried', async () => {
    let callCount = 0;
    const deps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () => {
        callCount++;
        return new Response(null, { status: 500 });
      }) as unknown as typeof globalThis.fetch,
    };

    const entry = signInCodeEntry({
      deps,
      onVerified: () => {},
    }) as unknown as ElementStub;
    container.appendChild(entry);

    const input = entry.querySelector(
      '[data-sign-in-code-input]'
    ) as ElementStub;
    const button = entry.querySelector(
      '[data-sign-in-code-submit]'
    ) as ElementStub;
    const statusEl = entry.querySelector(
      '[data-sign-in-code-status]'
    ) as ElementStub;

    input.value = '123456';
    input.dispatchEvent({ type: 'input', preventDefault: () => {} });
    await flushMicrotasks();

    expect(callCount).toBe(1);
    expect(entry.getAttribute('data-state')).toBe('failed');
    expect(statusEl.textContent).toBe(SIGN_IN_CODE_FAILED);
    expect(input.disabled).toBe(false);
    expect(button.disabled).toBe(false);

    // Because failed clears lastSubmitted, submitting 123456 again by click or enter works
    button.click();
    await flushMicrotasks();

    expect(callCount).toBe(2);
  });

  test('Enter key calls preventDefault and does not submit outer form', async () => {
    let outerFormSubmitted = false;
    let codeSubmitted = false;

    const outerForm = document.createElement('form') as unknown as ElementStub;
    outerForm.addEventListener('submit', (e) => {
      e.preventDefault();
      outerFormSubmitted = true;
    });

    const deps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () => {
        codeSubmitted = true;
        return new Response(null, { status: 401 });
      }) as unknown as typeof globalThis.fetch,
    };

    const entry = signInCodeEntry({
      deps,
      onVerified: () => {},
    }) as unknown as ElementStub;
    outerForm.appendChild(entry);
    container.appendChild(outerForm);

    const input = entry.querySelector(
      '[data-sign-in-code-input]'
    ) as ElementStub;

    // Press Enter with 5 digits: preventDefault called, neither outer form nor code submitted
    input.value = '12345';
    let defaultPrevented1 = false;
    input.dispatchEvent({
      type: 'keydown',
      preventDefault: () => {
        defaultPrevented1 = true;
      },
      key: 'Enter',
    } as unknown as { type: string; preventDefault: () => void });
    expect(defaultPrevented1).toBe(true);
    expect(outerFormSubmitted).toBe(false);
    expect(codeSubmitted).toBe(false);

    // Press Enter with 6 digits: preventDefault called, outer form NOT submitted, code IS submitted
    input.value = '123456';
    let defaultPrevented2 = false;
    input.dispatchEvent({
      type: 'keydown',
      preventDefault: () => {
        defaultPrevented2 = true;
      },
      key: 'Enter',
    } as unknown as { type: string; preventDefault: () => void });
    expect(defaultPrevented2).toBe(true);
    expect(outerFormSubmitted).toBe(false);

    await flushMicrotasks();
    expect(codeSubmitted).toBe(true);
  });

  test('focus option focuses field in a microtask', async () => {
    let focused = false;
    const entry = signInCodeEntry({
      deps: {
        serviceOrigin: 'https://relic.example',
        fetch: globalThis.fetch,
      },
      onVerified: () => {},
      focus: true,
    }) as unknown as ElementStub;

    const input = entry.querySelector(
      '[data-sign-in-code-input]'
    ) as ElementStub;
    input.focus = () => {
      focused = true;
    };

    expect(focused).toBe(false);
    await Promise.resolve();
    expect(focused).toBe(true);
  });
});

describe('announceVerified', () => {
  test('posts verified to BroadcastChannel relic:auth', () => {
    let postedMessage = '';
    let closed = false;
    const originalBroadcastChannel = globalThis.BroadcastChannel;

    class MockBroadcastChannel {
      readonly name: string;
      constructor(name: string) {
        this.name = name;
      }
      postMessage(msg: string): void {
        postedMessage = msg;
      }
      close(): void {
        closed = true;
      }
    }

    (globalThis as unknown as { BroadcastChannel: unknown }).BroadcastChannel =
      MockBroadcastChannel;

    try {
      announceVerified();
      expect(postedMessage).toBe('verified');
      expect(closed).toBe(true);
    } finally {
      (
        globalThis as unknown as { BroadcastChannel: unknown }
      ).BroadcastChannel = originalBroadcastChannel;
    }
  });
});

describe('composer passkey offer mounting with code sign-in', () => {
  beforeEach(() => {
    installDom();
    (document as unknown as { cookie: string }).cookie = '';
  });

  afterEach(() => {
    clearDom();
  });

  test('signInForm passes offerPending true when marker is set and mounts passkey offer in composer', async () => {
    const key = generateKey();
    const fragment = encodeFragment(key);
    let signalReceived: { readonly offerPending: boolean } | undefined;

    const outcome = document.createElement('div') as unknown as ElementStub;
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/auth/request')) {
          return new Response(null, { status: 202 });
        }
        if (url.endsWith('/api/auth/code')) {
          // Server sets the passkey offer cookie
          (document as unknown as { cookie: string }).cookie =
            'relic_passkey_offer=1';
          return new Response(JSON.stringify({ email: 'ada@example.com' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: 404 });
      }) as unknown as typeof globalThis.fetch,
      keyVault: {
        recall: () => fragment,
        remember: () => {},
        forget: () => {},
        list: () => [],
        exportEntries: () => '[]',
        importEntries: () => ({ added: 0, skipped: 0 }),
      },
      takeFragment: () => fragment,
      stripFragment: () => {},
      locationHref: `https://relic.example/r1#${fragment}`,
    };

    const { form, email } = signInForm([], {
      relicId: 'r1',
      fragment,
      deps,
      outcome: outcome as unknown as HTMLElement,
      label: 'Email address',
      onSignedIn: (sig) => {
        signalReceived = sig;
      },
    });

    email.value = 'ada@example.com';
    (form as unknown as ElementStub).submit();

    await flushMicrotasks();

    const codeInput = outcome.querySelector(
      '[data-sign-in-code-input]'
    ) as ElementStub;
    expect(codeInput).not.toBeNull();

    // Type 6-digit code
    codeInput.value = '123456';
    codeInput.dispatchEvent({ type: 'input', preventDefault: () => {} });

    await flushMicrotasks();

    expect(signalReceived).toEqual({ offerPending: true });
    const note = outcome.querySelector('.thread-note');
    expect(note?.textContent).toBe('Signed in as ada@example.com.');
  });

  test('signInForm passes offerPending false when marker is absent', async () => {
    const key = generateKey();
    const fragment = encodeFragment(key);
    let signalReceived: { readonly offerPending: boolean } | undefined;

    const outcome = document.createElement('div') as unknown as ElementStub;
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/auth/request')) {
          return new Response(null, { status: 202 });
        }
        if (url.endsWith('/api/auth/code')) {
          // No passkey offer cookie set
          (document as unknown as { cookie: string }).cookie = '';
          return new Response(JSON.stringify({ email: 'ada@example.com' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: 404 });
      }) as unknown as typeof globalThis.fetch,
      keyVault: {
        recall: () => fragment,
        remember: () => {},
        forget: () => {},
        list: () => [],
        exportEntries: () => '[]',
        importEntries: () => ({ added: 0, skipped: 0 }),
      },
      takeFragment: () => fragment,
      stripFragment: () => {},
      locationHref: `https://relic.example/r1#${fragment}`,
    };

    const { form, email } = signInForm([], {
      relicId: 'r1',
      fragment,
      deps,
      outcome: outcome as unknown as HTMLElement,
      label: 'Email address',
      onSignedIn: (sig) => {
        signalReceived = sig;
      },
    });

    email.value = 'ada@example.com';
    (form as unknown as ElementStub).submit();

    await flushMicrotasks();

    const codeInput = outcome.querySelector(
      '[data-sign-in-code-input]'
    ) as ElementStub;
    expect(codeInput).not.toBeNull();

    codeInput.value = '123456';
    codeInput.dispatchEvent({ type: 'input', preventDefault: () => {} });

    await flushMicrotasks();

    expect(signalReceived).toEqual({ offerPending: false });
  });
});
