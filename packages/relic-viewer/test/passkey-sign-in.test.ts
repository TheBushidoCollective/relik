import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CreationOptionsJSON, RequestOptionsJSON } from '@relic/format';
import { takePasskeyOfferMarker } from '../src/comments.ts';
import type { CredentialsLike } from '../src/passkey-common.ts';
import {
  mountPasskeyOffer,
  mountPasskeySignIn,
  resetPasskeySignInForTesting,
} from '../src/passkey-sign-in.ts';
import { signInForm } from '../src/main.ts';
import type { ViewerDeps } from '../src/viewer.ts';

/**
 * Bun tests run without a DOM, so these stubs carry what the controls
 * and panels touch: structure, text, attributes, and events.
 */
class ElementStub {
  readonly tagName: string;
  className = '';
  private _textContent = '';
  get textContent(): string {
    if (this.children.length === 0) return this._textContent;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(val: string) {
    this._textContent = val;
    this.children.length = 0;
  }
  id = '';
  type = '';
  title = '';
  value = '';
  placeholder = '';
  autocomplete = '';
  required = false;
  disabled = false;
  tabIndex = 0;
  href = '';
  rel = '';
  open = false;
  hidden = false;
  parent: ElementStub | undefined;
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, unknown> & {
    setProperty: (name: string, value: string) => void;
  } = {
    setProperty: (name: string, value: string): void => {
      this.style[name] = value;
    },
  };
  readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  readonly classList = {
    add: (name: string): void => {
      this.className = `${this.className} ${name}`.trim();
    },
    contains: (name: string): boolean =>
      this.className.split(' ').includes(name),
    toggle: (name: string, force?: boolean): boolean => {
      const names = this.className.split(' ').filter((n) => n !== name);
      const on = force ?? !this.className.split(' ').includes(name);
      this.className = (on ? [...names, name] : names).join(' ').trim();
      return on;
    },
  };

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'hidden') this.hidden = true;
    if (name.startsWith('data-')) {
      const camel = name
        .slice(5)
        .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      this.dataset[camel] = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === 'hidden') this.hidden = false;
    if (name.startsWith('data-')) {
      const camel = name
        .slice(5)
        .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      delete this.dataset[camel];
    }
  }

  appendChild(child: ElementStub): ElementStub {
    child.parent?.children.splice(child.parent.children.indexOf(child), 1);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...children: ElementStub[]): void {
    for (const child of children) this.appendChild(child);
  }

  prepend(...children: ElementStub[]): void {
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i] as ElementStub;
      child.parent?.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this;
      this.children.unshift(child);
    }
  }

  replaceChildren(...children: ElementStub[]): void {
    for (const child of this.children) child.parent = undefined;
    this.children.splice(0, this.children.length);
    this.append(...children);
  }

  remove(): void {
    const siblings = this.parent?.children;
    if (siblings === undefined) return;
    siblings.splice(siblings.indexOf(this), 1);
    this.parent = undefined;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  fire(type: string): void {
    const event = { target: this, preventDefault: (): void => {} };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  querySelector(selector: string): ElementStub | null {
    return descendants(this).find((node) => matches(node, selector)) ?? null;
  }
}

function matchesOne(node: ElementStub, selector: string): boolean {
  let rest = selector.trim();
  const notDisabled = rest.endsWith(':not([disabled])');
  if (notDisabled) rest = rest.slice(0, -':not([disabled])'.length);
  if (notDisabled && node.disabled) return false;
  for (const part of rest.match(/\.[\w-]+|\[[\w-]+\]/g) ?? []) {
    if (part.startsWith('.')) {
      if (!node.classList.contains(part.slice(1))) return false;
    } else if (!node.hasAttribute(part.slice(1, -1))) {
      return false;
    }
  }
  return true;
}

function matches(node: ElementStub, selector: string): boolean {
  return selector.split(',').some((one) => matchesOne(node, one));
}

function descendants(element: ElementStub): ElementStub[] {
  return [element, ...element.children.flatMap(descendants)];
}

function textOf(element: ElementStub): string {
  return [element.textContent, ...element.children.map(textOf)].join(' ');
}

function withAttr(element: ElementStub, name: string): ElementStub[] {
  return descendants(element).filter((candidate) =>
    candidate.hasAttribute(name)
  );
}

function one(element: ElementStub, attr: string): ElementStub {
  const found = withAttr(element, attr);
  if (found.length !== 1) {
    throw new Error(`expected one [${attr}], found ${found.length}`);
  }
  return found[0] as ElementStub;
}

const dom: {
  body: ElementStub;
  visibilityListeners: Array<() => void>;
  visibilityState: string;
} = {
  body: new ElementStub('body'),
  visibilityListeners: [],
  visibilityState: 'visible',
};

function setVisibilityState(state: string): void {
  dom.visibilityState = state;
  for (const listener of dom.visibilityListeners) listener();
}

function installDom(): void {
  dom.body = new ElementStub('body');
  dom.visibilityListeners = [];
  dom.visibilityState = 'visible';
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new ElementStub(tag),
    createElementNS: (_namespace: string, tag: string) => new ElementStub(tag),
    createTextNode: (text: string) => {
      const node = new ElementStub('#text');
      node.textContent = text;
      return node;
    },
    querySelector: () => null,
    getElementById: () => null,
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'visibilitychange') dom.visibilityListeners.push(listener);
    },
    removeEventListener: () => {},
    get visibilityState() {
      return dom.visibilityState;
    },
    set visibilityState(val: string) {
      dom.visibilityState = val;
      for (const listener of dom.visibilityListeners) listener();
    },
    get body() {
      return dom.body;
    },
  };
  (globalThis as { window?: unknown }).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

function clearDom(): void {
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
}

async function tick(ms = 0): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

interface HttpCall {
  readonly method: string;
  readonly url: string;
  readonly bodyText: string;
  readonly headers: Record<string, string>;
}

function makeMockFetch(routes: Record<string, (call: HttpCall) => Response>): {
  fetch: typeof globalThis.fetch;
  calls: HttpCall[];
} {
  const calls: HttpCall[] = [];
  const fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: HttpCall = { method, url, bodyText, headers };
    calls.push(call);

    const path = new URL(url).pathname;
    const handler = routes[path];
    if (!handler) {
      throw new Error(`unhandled mock fetch route: ${path}`);
    }
    return handler(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function mockAssertionCredential(userHandleStr: string): Credential {
  const userHandle = new TextEncoder().encode(userHandleStr).buffer;
  return {
    id: 'cred-123',
    type: 'public-key',
    rawId: new Uint8Array([1, 2, 3]).buffer,
    response: {
      clientDataJSON: new TextEncoder().encode('client-data').buffer,
      authenticatorData: new Uint8Array([10, 20, 30]).buffer,
      signature: new Uint8Array([40, 50, 60]).buffer,
      userHandle,
    },
  } as unknown as Credential;
}

function mockRegistrationCredential(): Credential {
  return {
    id: 'new-cred-456',
    type: 'public-key',
    rawId: new Uint8Array([4, 5, 6]).buffer,
    response: {
      clientDataJSON: new TextEncoder().encode('client-data').buffer,
      attestationObject: new Uint8Array([70, 80, 90]).buffer,
    },
  } as unknown as Credential;
}

const SAMPLE_REQUEST_OPTIONS: RequestOptionsJSON = {
  challenge: 'Y2hhbGxlbmdlLTMyLWJ5dGVzLWJhc2U2NHVybA',
  rpId: 'relik.example',
  timeout: 300000,
  userVerification: 'required',
  allowCredentials: [],
};

const SAMPLE_CREATION_OPTIONS: CreationOptionsJSON = {
  challenge: 'Y2hhbGxlbmdlLTMyLWJ5dGVzLWJhc2U2NHVybA',
  rp: { id: 'relik.example', name: 'Relic' },
  user: {
    id: 'dXNlci1oYW5kbGU',
    name: 'reader@example.com',
    displayName: 'reader@example.com',
  },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  timeout: 300000,
  attestation: 'none',
  authenticatorSelection: {
    residentKey: 'required',
    requireResidentKey: true,
    userVerification: 'required',
  },
  excludeCredentials: [],
};

beforeEach(() => {
  installDom();
  resetPasskeySignInForTesting();
});
afterEach(clearDom);

describe('passkey sign-in (spec §5 S2 requirements)', () => {
  // 1. The autofill attribute.
  test('1. The autofill attribute is set to username webauthn on sign-in forms', async () => {
    const outcome = new ElementStub('div');
    const { email } = signInForm([], {
      relicId: 'abc',
      fragment: 'r1AAAAAAAAAAAAAAAAAAAA',
      deps: {
        serviceOrigin: 'https://relik.example',
        fetch: async () => new Response(),
      } as unknown as ViewerDeps,
      outcome: outcome as unknown as HTMLElement,
      label: 'Email',
    });
    expect(email.autocomplete).toBe('username webauthn');
  });

  // 2. One conditional request against {} options, with no fragment and no address on the wire.
  test('2. One conditional request against {} options, with no fragment and no address on the wire', async () => {
    const getCalls: CredentialRequestOptions[] = [];
    const creds: CredentialsLike = {
      create: async () => null,
      get: async (opts) => {
        getCalls.push(opts);
        const { promise } = Promise.withResolvers<Credential | null>();
        return promise;
      },
    };

    const { fetch, calls } = makeMockFetch({
      '/api/auth/passkeys/sign-in/options': () => {
        return new Response(
          JSON.stringify({ public_key: SAMPLE_REQUEST_OPTIONS }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    const host = new ElementStub('div');
    const email = new ElementStub('input') as unknown as HTMLInputElement;
    const outcome = new ElementStub('div');

    mountPasskeySignIn({
      host: host as unknown as HTMLElement,
      email,
      outcome: outcome as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      credentials: creds,
      conditionalAvailable: async () => true,
      onSignedIn: () => {},
    });

    await tick(10);

    expect(calls.length).toBe(1);
    const call = calls[0] as HttpCall;
    expect(call.method).toBe('POST');
    expect(call.bodyText).toBe('{}');
    expect(call.url).toBe(
      'https://relik.example/api/auth/passkeys/sign-in/options'
    );
    expect(call.url).not.toContain('#');
    expect(call.bodyText).not.toContain('email');
    expect(call.bodyText).not.toContain('address');

    expect(getCalls.length).toBe(1);
    expect(getCalls[0]?.mediation).toBe('conditional');
    expect(getCalls[0]?.publicKey).toBeDefined();
  });

  // 3. A press aborts the conditional request, then a modal get starts during the click with no fetch in between.
  test('3. A press aborts the conditional request, then a modal get starts during the click with no fetch in between', async () => {
    let conditionalSignal: AbortSignal | undefined;
    let modalCalled = false;
    let fetchCountBeforeModal = 0;

    const { fetch, calls } = makeMockFetch({
      '/api/auth/passkeys/sign-in/options': () => {
        return new Response(
          JSON.stringify({ public_key: SAMPLE_REQUEST_OPTIONS }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    const creds: CredentialsLike = {
      create: async () => null,
      get: async (opts) => {
        if (opts.mediation === 'conditional') {
          conditionalSignal = opts.signal;
          const { promise } = Promise.withResolvers<Credential | null>();
          return promise;
        }
        modalCalled = true;
        fetchCountBeforeModal = calls.length;
        const { promise } = Promise.withResolvers<Credential | null>();
        return promise;
      },
    };

    const host = new ElementStub('div');
    const email = new ElementStub('input') as unknown as HTMLInputElement;
    const outcome = new ElementStub('div');

    mountPasskeySignIn({
      host: host as unknown as HTMLElement,
      email,
      outcome: outcome as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      credentials: creds,
      conditionalAvailable: async () => true,
      onSignedIn: () => {},
    });

    await tick(10);
    expect(conditionalSignal).toBeDefined();
    expect(conditionalSignal?.aborted).toBe(false);

    const btn = one(host, 'data-passkey-sign-in');
    btn.fire('click');

    expect(conditionalSignal?.aborted).toBe(true);
    expect(modalCalled).toBe(true);
    expect(fetchCountBeforeModal).toBe(1); // No new fetch between click and modal get
  });

  // 4. The POST body has exactly one key, credential, and onSignedIn gets the email.
  test('4. The POST body has exactly one key, credential, and onSignedIn gets the email', async () => {
    let signedInEmail: string | undefined;

    const { fetch, calls } = makeMockFetch({
      '/api/auth/passkeys/sign-in/options': () => {
        return new Response(
          JSON.stringify({ public_key: SAMPLE_REQUEST_OPTIONS }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
      '/api/auth/passkeys/sign-in': () => {
        return new Response(
          JSON.stringify({ ok: true, email: 'verified@example.com' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    const creds: CredentialsLike = {
      create: async () => null,
      get: async (opts) => {
        if (opts.mediation === 'conditional') {
          const { promise } = Promise.withResolvers<Credential | null>();
          return promise;
        }
        return mockAssertionCredential('verified@example.com');
      },
    };

    const host = new ElementStub('div');
    const email = new ElementStub('input') as unknown as HTMLInputElement;
    const outcome = new ElementStub('div');

    mountPasskeySignIn({
      host: host as unknown as HTMLElement,
      email,
      outcome: outcome as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      credentials: creds,
      conditionalAvailable: async () => true,
      onSignedIn: (em) => {
        signedInEmail = em;
      },
    });

    await tick(10);
    const btn = one(host, 'data-passkey-sign-in');
    btn.fire('click');

    await tick(20);

    expect(signedInEmail).toBe('verified@example.com');
    const signInCall = calls.find((c) =>
      c.url.endsWith('/api/auth/passkeys/sign-in')
    );
    expect(signInCall).toBeDefined();
    const parsedBody = JSON.parse(signInCall!.bodyText);
    expect(Object.keys(parsedBody)).toEqual(['credential']);
  });

  // 5. A 401 shows FAILED, reveals the fallback, and re-arms.
  test('5. A 401 shows FAILED, reveals the fallback, and re-arms', async () => {
    let optionsFetchCount = 0;

    const { fetch } = makeMockFetch({
      '/api/auth/passkeys/sign-in/options': () => {
        optionsFetchCount++;
        return new Response(
          JSON.stringify({ public_key: SAMPLE_REQUEST_OPTIONS }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
      '/api/auth/passkeys/sign-in': () => {
        return new Response(
          JSON.stringify({
            code: 'passkey_sign_in_failed',
            title: 'Passkey sign-in did not work',
          }),
          {
            status: 401,
            headers: { 'content-type': 'application/problem+json' },
          }
        );
      },
    });

    const creds: CredentialsLike = {
      create: async () => null,
      get: async (opts) => {
        if (opts.mediation === 'conditional') {
          const { promise } = Promise.withResolvers<Credential | null>();
          return promise;
        }
        return mockAssertionCredential('unknown@example.com');
      },
    };

    const host = new ElementStub('div');
    const email = new ElementStub('input') as unknown as HTMLInputElement;
    const outcome = new ElementStub('div');

    mountPasskeySignIn({
      host: host as unknown as HTMLElement,
      email,
      outcome: outcome as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      credentials: creds,
      conditionalAvailable: async () => true,
      onSignedIn: () => {},
    });

    await tick(10);
    expect(optionsFetchCount).toBe(1);

    const btn = one(host, 'data-passkey-sign-in');
    btn.fire('click');

    await tick(20);

    expect(host.getAttribute('data-state')).toBe('failed');
    expect(outcome.textContent).toBe(
      'That passkey did not sign you in. Try again, or send yourself a link.'
    );

    const fallback = one(host, 'data-passkey-fallback');
    expect(fallback.hidden).toBe(false);

    // Re-arms
    await tick(20);
    expect(optionsFetchCount).toBeGreaterThanOrEqual(2);
  });

  // 6. The fallback: empty-field copy; {email} options; get inside the confirm press with the response's allow list.
  test("6. The fallback: empty-field copy; {email} options; get inside the confirm press with the response's allow list", async () => {
    let requestedAllowCredentials: PublicKeyCredentialDescriptor[] | undefined;

    const emailOptions: RequestOptionsJSON = {
      challenge: 'ZW1haWwtY2hhbGxlbmdl',
      rpId: 'relik.example',
      timeout: 300000,
      userVerification: 'required',
      allowCredentials: [
        {
          type: 'public-key',
          id: 'ZGVjb3ktY3JlZC0x',
          transports: ['internal'],
        },
      ],
    };

    const { fetch, calls } = makeMockFetch({
      '/api/auth/passkeys/sign-in/options': (call) => {
        const body = JSON.parse(call.bodyText || '{}');
        if (body.email) {
          return new Response(JSON.stringify({ public_key: emailOptions }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ public_key: SAMPLE_REQUEST_OPTIONS }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
      '/api/auth/passkeys/sign-in': () => {
        return new Response(
          JSON.stringify({ ok: true, email: 'reader@example.com' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    const creds: CredentialsLike = {
      create: async () => null,
      get: async (opts) => {
        if (opts.mediation === 'conditional') {
          const { promise } = Promise.withResolvers<Credential | null>();
          return promise;
        }
        requestedAllowCredentials = opts.publicKey?.allowCredentials;
        return mockAssertionCredential('reader@example.com');
      },
    };

    const host = new ElementStub('div');
    const email = new ElementStub('input') as unknown as HTMLInputElement;
    const outcome = new ElementStub('div');

    mountPasskeySignIn({
      host: host as unknown as HTMLElement,
      email,
      outcome: outcome as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      credentials: creds,
      conditionalAvailable: async () => false,
      onSignedIn: () => {},
    });

    await tick(10);

    const fallbackBtn = one(host, 'data-passkey-email-first');

    // 1. Empty field
    email.value = '   ';
    fallbackBtn.fire('click');
    expect(outcome.textContent).toBe(
      'Type your address above, then press this again.'
    );

    // 2. Filled address
    email.value = 'reader@example.com';
    fallbackBtn.fire('click');
    await tick(10);

    expect(host.getAttribute('data-state')).toBe('email-first');
    const emailCall = calls.find((c) =>
      c.bodyText.includes('reader@example.com')
    );
    expect(emailCall).toBeDefined();

    // Confirm button shown
    const confirmBtn = one(host, 'data-passkey-email-first-confirm');
    expect(confirmBtn.hidden).toBe(false);

    // 3. Confirm press runs get synchronously with response's allow list
    confirmBtn.fire('click');
    expect(requestedAllowCredentials).toBeDefined();
    expect(requestedAllowCredentials?.[0]?.type).toBe('public-key');
  });

  // 7. Options refresh before the timeout, and only while visible.
  test('7. Options refresh before the timeout, and only while visible', async () => {
    let optionsFetches = 0;

    const shortTimeoutOptions: RequestOptionsJSON = {
      ...SAMPLE_REQUEST_OPTIONS,
      timeout: 31000, // 31s -> refreshAt = fetchedAt + 1000ms
    };

    const { fetch } = makeMockFetch({
      '/api/auth/passkeys/sign-in/options': () => {
        optionsFetches++;
        return new Response(
          JSON.stringify({ public_key: shortTimeoutOptions }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    const host = new ElementStub('div');
    const email = new ElementStub('input') as unknown as HTMLInputElement;
    const outcome = new ElementStub('div');

    mountPasskeySignIn({
      host: host as unknown as HTMLElement,
      email,
      outcome: outcome as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      credentials: {
        create: async () => null,
        get: async () => {
          const { promise } = Promise.withResolvers<Credential | null>();
          return promise;
        },
      },
      conditionalAvailable: async () => false,
      onSignedIn: () => {},
    });

    await tick(10);
    expect(optionsFetches).toBe(1);

    // Make page hidden
    setVisibilityState('hidden');
    await tick(1100);
    // While hidden, should not fetch
    expect(optionsFetches).toBe(1);

    // When becoming visible, triggers refresh
    setVisibilityState('visible');
    await tick(20);
    expect(optionsFetches).toBeGreaterThanOrEqual(2);
  });

  // 8. A relic:auth message aborts and stops fetching.
  test('8. A relic:auth message aborts and stops fetching', async () => {
    let signal: AbortSignal | undefined;
    const creds: CredentialsLike = {
      create: async () => null,
      get: async (opts) => {
        signal = opts.signal;
        const { promise } = Promise.withResolvers<Credential | null>();
        return promise;
      },
    };

    const { fetch } = makeMockFetch({
      '/api/auth/passkeys/sign-in/options': () => {
        return new Response(
          JSON.stringify({ public_key: SAMPLE_REQUEST_OPTIONS }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    const host = new ElementStub('div');
    const email = new ElementStub('input') as unknown as HTMLInputElement;
    const outcome = new ElementStub('div');

    mountPasskeySignIn({
      host: host as unknown as HTMLElement,
      email,
      outcome: outcome as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      credentials: creds,
      conditionalAvailable: async () => true,
      onSignedIn: () => {},
    });

    await tick(10);
    expect(signal?.aborted).toBe(false);

    // Post relic:auth verified message
    if (typeof BroadcastChannel === 'function') {
      const ch = new BroadcastChannel('relic:auth');
      ch.postMessage('verified');
      ch.close();
    }

    await tick(10);
    expect(signal?.aborted).toBe(true);
  });

  // 9. An aborted conditional request is silent.
  test('9. An aborted conditional request is silent', async () => {
    const creds: CredentialsLike = {
      create: async () => null,
      get: async (opts) => {
        if (opts.mediation === 'conditional') {
          return Promise.reject(
            new DOMException(
              'A newer passkey request replaced this one',
              'AbortError'
            )
          );
        }
        return null;
      },
    };

    const { fetch } = makeMockFetch({
      '/api/auth/passkeys/sign-in/options': () => {
        return new Response(
          JSON.stringify({ public_key: SAMPLE_REQUEST_OPTIONS }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    const host = new ElementStub('div');
    const email = new ElementStub('input') as unknown as HTMLInputElement;
    const outcome = new ElementStub('div');

    mountPasskeySignIn({
      host: host as unknown as HTMLElement,
      email,
      outcome: outcome as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      credentials: creds,
      conditionalAvailable: async () => true,
      onSignedIn: () => {},
    });

    await tick(20);
    expect(outcome.textContent).toBe('');
  });

  // 10. The offer marker is deleted on first read, and every build in the
  // same document sees it: the viewer rebuilds the thread on one page load.
  test('10. The offer marker is consumed once per document and stays visible to rebuilds', () => {
    const docStub = {
      cookie: 'relic_session=abc; relic_passkey_offer=1; other=123',
    };

    expect(takePasskeyOfferMarker(docStub)).toBe(true);
    expect(docStub.cookie).not.toContain('relic_passkey_offer=1');
    expect(takePasskeyOfferMarker(docStub)).toBe(true);

    const reloaded = { cookie: docStub.cookie };
    expect(takePasskeyOfferMarker(reloaded)).toBe(false);
  });

  // 11. "Not now" stores dismissed.
  test('11. "Not now" stores dismissed', async () => {
    let done = false;
    const storage = new Map<string, string>();
    const mockStore = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
    };

    const { fetch } = makeMockFetch({
      '/api/auth/passkeys/options': () => {
        return new Response(
          JSON.stringify({
            mode: 'create',
            public_key: SAMPLE_CREATION_OPTIONS,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    const host = new ElementStub('div');
    mountPasskeyOffer({
      host: host as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      store: mockStore,
      onDone: () => {
        done = true;
      },
    });

    await tick(10);

    const dismissBtn = one(host, 'data-passkey-offer-dismiss');
    expect(dismissBtn.textContent).toBe('Not now');
    dismissBtn.fire('click');

    expect(storage.get('relic:passkey-offer')).toBe('dismissed');
    expect(done).toBe(true);
  });

  // 12. Create happens inside the press and stores created.
  test('12. Create happens inside the press and stores created', async () => {
    let createCalledSynchronously = false;
    const storage = new Map<string, string>();
    const mockStore = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
    };

    const { fetch } = makeMockFetch({
      '/api/auth/passkeys/options': () => {
        return new Response(
          JSON.stringify({
            mode: 'create',
            public_key: SAMPLE_CREATION_OPTIONS,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
      '/api/auth/passkeys': () => {
        return new Response(
          JSON.stringify({ email: 'reader@example.com', passkeys: 1 }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    const creds: CredentialsLike = {
      create: async () => {
        createCalledSynchronously = true;
        return mockRegistrationCredential();
      },
      get: async () => null,
    };

    const host = new ElementStub('div');
    mountPasskeyOffer({
      host: host as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      credentials: creds,
      store: mockStore,
      onDone: () => {},
    });

    await tick(10);

    const createBtn = one(host, 'data-passkey-offer-create');
    expect(createBtn.textContent).toBe('Add a passkey');
    createBtn.fire('click');

    expect(createCalledSynchronously).toBe(true);

    await tick(20);

    expect(storage.get('relic:passkey-offer')).toBe('created');
    const offer = one(host, 'data-passkey-offer');
    expect(offer.getAttribute('data-state')).toBe('created');
    expect(textOf(offer)).toContain(
      'Passkey added. Next time, choose Sign in with passkey.'
    );
  });

  // 13. The assert-then-add path.
  test('13. The assert-then-add path', async () => {
    let assertCalled = false;
    let createCalled = false;

    const storage = new Map<string, string>();
    const mockStore = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
    };

    const { fetch } = makeMockFetch({
      '/api/auth/passkeys/options': (call) => {
        const body = JSON.parse(call.bodyText || '{}');
        if (body.credential) {
          // Response to assert: return create options for device 2
          return new Response(
            JSON.stringify({
              mode: 'create',
              public_key: SAMPLE_CREATION_OPTIONS,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        // First call: mode assert
        return new Response(
          JSON.stringify({
            mode: 'assert',
            public_key: SAMPLE_REQUEST_OPTIONS,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
      '/api/auth/passkeys': () => {
        return new Response(
          JSON.stringify({ email: 'reader@example.com', passkeys: 2 }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    const creds: CredentialsLike = {
      create: async () => {
        createCalled = true;
        return mockRegistrationCredential();
      },
      get: async () => {
        assertCalled = true;
        return mockAssertionCredential('reader@example.com');
      },
    };

    const host = new ElementStub('div');
    mountPasskeyOffer({
      host: host as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      credentials: creds,
      store: mockStore,
      onDone: () => {},
    });

    await tick(10);

    const offer = one(host, 'data-passkey-offer');
    expect(offer.getAttribute('data-state')).toBe('assert');
    expect(textOf(offer)).toContain(
      'You already have a passkey on another device. Confirm with it, then add one here.'
    );

    const confirmBtn = one(host, 'data-passkey-offer-create');
    expect(confirmBtn.textContent).toBe('Confirm with your passkey');

    // Press 1: Assert
    confirmBtn.fire('click');
    expect(assertCalled).toBe(true);

    await tick(20);

    // Now state is ready for second step
    expect(offer.getAttribute('data-state')).toBe('ready');
    expect(textOf(offer)).toContain('Add a passkey on this device');
    expect(confirmBtn.textContent).toBe('Add a passkey');

    // Press 2: Create
    confirmBtn.fire('click');
    expect(createCalled).toBe(true);

    await tick(20);

    expect(offer.getAttribute('data-state')).toBe('created');
    expect(storage.get('relic:passkey-offer')).toBe('created');
  });

  // 14. InvalidStateError gives exists.
  test('14. InvalidStateError gives exists', async () => {
    const storage = new Map<string, string>();
    const mockStore = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
    };

    const { fetch } = makeMockFetch({
      '/api/auth/passkeys/options': () => {
        return new Response(
          JSON.stringify({
            mode: 'create',
            public_key: SAMPLE_CREATION_OPTIONS,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    const creds: CredentialsLike = {
      create: async () => {
        throw new DOMException(
          'Credential already exists',
          'InvalidStateError'
        );
      },
      get: async () => null,
    };

    const host = new ElementStub('div');
    mountPasskeyOffer({
      host: host as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      credentials: creds,
      store: mockStore,
      onDone: () => {},
    });

    await tick(10);

    const createBtn = one(host, 'data-passkey-offer-create');
    createBtn.fire('click');

    await tick(20);

    const offer = one(host, 'data-passkey-offer');
    expect(offer.getAttribute('data-state')).toBe('exists');
    expect(textOf(offer)).toContain(
      'This device already has your passkey. Next time, choose Sign in with passkey.'
    );
    expect(storage.get('relic:passkey-offer')).toBe('created');

    const dismissBtn = one(host, 'data-passkey-offer-dismiss');
    expect(dismissBtn.textContent).toBe('Close');
  });

  test('15. L6: Offer card body displays the session address as text and escapes HTML', async () => {
    const { fetch } = makeMockFetch({
      '/api/auth/passkeys/options': () => {
        return new Response(
          JSON.stringify({
            mode: 'create',
            public_key: SAMPLE_CREATION_OPTIONS,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    // Part A: with email
    const host1 = new ElementStub('div');
    mountPasskeyOffer({
      host: host1 as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      email: 'reader@example.com',
      store: { getItem: () => null, setItem: () => {} },
      onDone: () => {},
    });
    await tick(10);

    const bodyEl1 = host1.children[0]?.children.find(
      (c) => c.className === 'passkey-offer-body'
    );
    expect(bodyEl1?.textContent).toBe(
      'Add a passkey for reader@example.com and this device signs you in without a link.'
    );

    // Part B: with malicious HTML in email -> rendered as text, never tags
    const host2 = new ElementStub('div');
    const malicious = '<script>alert(1)</script>@example.com';
    mountPasskeyOffer({
      host: host2 as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      email: malicious,
      store: { getItem: () => null, setItem: () => {} },
      onDone: () => {},
    });
    await tick(10);

    const bodyEl2 = host2.children[0]?.children.find(
      (c) => c.className === 'passkey-offer-body'
    );
    expect(bodyEl2?.textContent).toBe(
      `Add a passkey for ${malicious} and this device signs you in without a link.`
    );
    expect(descendants(host2).some((n) => n.tagName === 'SCRIPT')).toBe(false);

    // Part C: without email -> fallback
    const host3 = new ElementStub('div');
    mountPasskeyOffer({
      host: host3 as unknown as HTMLElement,
      deps: { serviceOrigin: 'https://relik.example', fetch },
      store: { getItem: () => null, setItem: () => {} },
      onDone: () => {},
    });
    await tick(10);

    const bodyEl3 = host3.children[0]?.children.find(
      (c) => c.className === 'passkey-offer-body'
    );
    expect(bodyEl3?.textContent).toBe(
      'Add a passkey and this device signs you in without a link.'
    );
  });
});
