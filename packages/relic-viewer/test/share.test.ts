import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { deriveShareProof, encodeKey } from '@relic/format';
import {
  buildBar,
  openSharePanel,
  type SharePanelHandle,
} from '../src/main.ts';
import {
  addressProblem,
  looksLikeEmail,
  parseAddresses,
  requestShare,
  SHARE_FACT_SENDING,
  SHARE_FACT_STORING,
} from '../src/share.ts';
import { localStorageKeyVault } from '../src/vault.ts';
import type { ReadyView, ViewerDeps } from '../src/viewer.ts';

/**
 * Bun tests run without a DOM, so these stubs carry what the share panel
 * touches while it builds and answers: structure, text, attributes, and the
 * events a reader causes. What the panel looks like is proven in a browser.
 */
class ElementStub {
  readonly tagName: string;
  className = '';
  textContent = '';
  id = '';
  type = '';
  title = '';
  value = '';
  rows = 0;
  placeholder = '';
  autocomplete = '';
  spellcheck = true;
  required = false;
  disabled = false;
  readOnly = false;
  noValidate = false;
  tabIndex = 0;
  href = '';
  rel = '';
  open = false;
  parent: ElementStub | undefined;
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty: (): void => {} };
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
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: ElementStub): ElementStub {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...children: ElementStub[]): void {
    for (const child of children) this.appendChild(child);
  }

  replaceChildren(...children: ElementStub[]): void {
    this.children.splice(0, this.children.length);
    this.append(...children);
  }

  remove(): void {
    const siblings = this.parent?.children;
    if (siblings === undefined) return;
    siblings.splice(siblings.indexOf(this), 1);
    this.parent = undefined;
  }

  focus(): void {
    dom.active = this;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  fire(type: string): void {
    const event = { target: this, preventDefault: (): void => {} };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.fire('close');
  }
}

const dom: { body: ElementStub; active: ElementStub | undefined } = {
  body: new ElementStub('body'),
  active: undefined,
};

function installDom(): void {
  dom.body = new ElementStub('body');
  dom.active = undefined;
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new ElementStub(tag),
    createElementNS: (_namespace: string, tag: string) => new ElementStub(tag),
    createTextNode: (text: string) => {
      const node = new ElementStub('#text');
      node.textContent = text;
      return node;
    },
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
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

function descendants(element: ElementStub): ElementStub[] {
  return [element, ...element.children.flatMap(descendants)];
}

function textOf(element: ElementStub): string {
  return [element.textContent, ...element.children.map(textOf)].join(' ');
}

function withClass(element: ElementStub, name: string): ElementStub[] {
  return descendants(element).filter((candidate) =>
    candidate.className.split(' ').includes(name)
  );
}

function only(element: ElementStub, name: string): ElementStub {
  const found = withClass(element, name);
  if (found.length !== 1) {
    throw new Error(`expected one .${name}, found ${found.length}`);
  }
  return found[0] as ElementStub;
}

const RELIC_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const ORIGIN = 'https://relik.example';

/** Real 16-byte keys, so the derivation under test is the real one. */
const KEY_BYTES = new Uint8Array([
  9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10,
]);
const OTHER_KEY = new Uint8Array([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
]);

function shareUrlFor(key: Uint8Array): string {
  return `${ORIGIN}/${RELIC_ID}#r1${encodeKey(key)}`;
}

function view(key: Uint8Array = KEY_BYTES): ReadyView {
  return {
    filename: 'notes.md',
    declaredMimetype: 'text/markdown',
    content: new TextEncoder().encode('# notes\n'),
    route: 'markdown',
    downgradeNotice: undefined,
    shareUrl: shareUrlFor(key),
    version: 1,
    currentVersion: 1,
    versionDigest: '0'.repeat(64),
  };
}

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (name: string) => entries.get(name) ?? null,
    setItem: (name: string, value: string) => {
      entries.set(name, value);
    },
    removeItem: (name: string) => {
      entries.delete(name);
    },
    clear: () => {
      entries.clear();
    },
  } as Storage;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problem(
  code: string,
  status: number,
  extensions: Record<string, unknown> = {}
): Response {
  return new Response(JSON.stringify({ code, title: code, ...extensions }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

const SHARED_REPLY = {
  relic_id: RELIC_ID,
  emails: ['lin@example.com', 'sam@example.com'],
  added: 2,
  shared_count: 7,
  share_limit: 50,
  title: 'Quarterly field notes',
};

/**
 * A service that answers the session read with `sessionEmail` and the share
 * with `share`, recording every call so the wire can be asserted.
 */
function stubDeps(
  share: (call: Call) => Response,
  calls: Call[],
  sessionEmail: string | null = 'ada@example.com'
): ViewerDeps {
  return {
    serviceOrigin: ORIGIN,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = { url: String(input), init };
      calls.push(call);
      if (call.url.endsWith('/api/auth/session')) {
        return json({ email: sessionEmail });
      }
      if (call.url.endsWith('/api/auth/request')) {
        return new Response(null, { status: 202 });
      }
      if (call.url.endsWith('/share')) return share(call);
      return new Response(null, { status: 404 });
    }) as typeof globalThis.fetch,
    takeFragment: () => '',
    stripFragment: () => {},
    locationHref: `${ORIGIN}/${RELIC_ID}`,
    keyVault: localStorageKeyVault(memoryStorage(), () => 1_000),
  };
}

function shareCalls(calls: readonly Call[]): Call[] {
  return calls.filter((call) => call.url.endsWith('/share'));
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  if (call === undefined) throw new Error('no call');
  if (typeof call.init?.body !== 'string') throw new Error('no JSON body');
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

describe('the share request', () => {
  test('carries a proof derived from the key, the addresses, and nothing else', async () => {
    const calls: Call[] = [];
    const deps = stubDeps(() => json(SHARED_REPLY), calls);

    const result = await requestShare(
      RELIC_ID,
      KEY_BYTES,
      ['lin@example.com'],
      deps
    );
    expect(result.kind).toBe('shared');

    const [call] = shareCalls(calls);
    expect(call?.url).toBe(`${ORIGIN}/api/relics/${RELIC_ID}/share`);
    expect(call?.init?.method).toBe('POST');
    // The reader's half of the authority is the session cookie, so it has to
    // travel with the request.
    expect(call?.init?.credentials).toBe('same-origin');

    const body = bodyOf(call);
    expect(Object.keys(body).sort()).toEqual(['emails', 'share_proof']);
    expect(body['emails']).toEqual(['lin@example.com']);
    expect(body['share_proof']).toBe(
      encodeKey(await deriveShareProof(KEY_BYTES))
    );
    // 32 bytes of unpadded base64url, which is what the service accepts.
    expect(body['share_proof']).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const wire = call?.init?.body as string;
    expect(wire).not.toContain(encodeKey(KEY_BYTES));
    expect(wire).not.toContain('#');
  });

  test('a refusal is told with the numbers the service sent', async () => {
    const full = await requestShare(
      RELIC_ID,
      KEY_BYTES,
      ['lin@example.com'],
      stubDeps(
        () =>
          problem('share_limit_reached', 409, {
            share_limit: 50,
            shared_count: 48,
          }),
        []
      )
    );
    if (full.kind !== 'refused') throw new Error('expected a refusal');
    expect(full.refusal.code).toBe('share_limit_reached');
    expect(full.refusal.detail).toContain('48 of the 50');
    expect(full.refusal.detail).toContain('Nothing was added');

    const limited = await requestShare(
      RELIC_ID,
      KEY_BYTES,
      ['lin@example.com'],
      stubDeps(
        () => problem('share_rate_limited', 429, { retry_after_seconds: 2280 }),
        []
      )
    );
    if (limited.kind !== 'refused') throw new Error('expected a refusal');
    expect(limited.refusal.detail).toContain('about 38 minutes');
    // The wait is the remedy, so no immediate retry is offered.
    expect(limited.refusal.retryable).toBe(false);
  });

  test('an answer that is not the documented shape is not called success', async () => {
    const result = await requestShare(
      RELIC_ID,
      KEY_BYTES,
      ['lin@example.com'],
      stubDeps(() => json({ ...SHARED_REPLY, added: 'two' }), [])
    );
    if (result.kind !== 'refused') throw new Error('expected a refusal');
    expect(result.refusal.code).toBe('malformed_share');
    expect(result.refusal.detail).toContain('may have been added');
  });

  test('a service without the endpoint is named as that, not as a refusal', async () => {
    const result = await requestShare(
      RELIC_ID,
      KEY_BYTES,
      ['lin@example.com'],
      stubDeps(() => new Response('Not found', { status: 404 }), [])
    );
    if (result.kind !== 'refused') throw new Error('expected a refusal');
    expect(result.refusal.code).toBe('http_404');
    expect(result.refusal.headline).toContain('cannot take shares yet');
  });

  test('a network failure says trying again is safe', async () => {
    const deps: ViewerDeps = {
      ...stubDeps(() => json(SHARED_REPLY), []),
      fetch: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof globalThis.fetch,
    };
    const result = await requestShare(RELIC_ID, KEY_BYTES, ['a@b.co'], deps);
    if (result.kind !== 'refused') throw new Error('expected a refusal');
    expect(result.refusal.code).toBe('network');
    expect(result.refusal.retryable).toBe(true);
    expect(result.refusal.detail).toContain('not added twice');
  });
});

describe('reading what a reader typed', () => {
  test('commas, semicolons, new lines and spaces separate, and a name gives up its address', () => {
    const parsed = parseAddresses(
      'lin@example.com, Sam Okafor <sam@example.com>;\npat@example.com kim@example.com'
    );
    expect(parsed.addresses).toEqual([
      'lin@example.com',
      'sam@example.com',
      'pat@example.com',
      'kim@example.com',
    ]);
    expect(parsed.invalid).toEqual([]);
  });

  test('a repeat in another case counts once, so the count matches the service', () => {
    const parsed = parseAddresses('Lin@Example.com, lin@example.com');
    expect(parsed.addresses).toEqual(['Lin@Example.com']);
  });

  test('the check is the service check', () => {
    expect(looksLikeEmail('a@b.co')).toBe(true);
    expect(looksLikeEmail('a@mail.example.com')).toBe(true);
    expect(looksLikeEmail('a@b')).toBe(false);
    expect(looksLikeEmail('a@.b.co')).toBe(false);
    expect(looksLikeEmail('sam@')).toBe(false);
    // 320 characters is the service's ceiling, and one more is refused.
    expect(looksLikeEmail(`${'a'.repeat(315)}@b.co`)).toBe(true);
    expect(looksLikeEmail(`${'a'.repeat(316)}@b.co`)).toBe(false);
  });

  test('what is wrong is said before anything is sent', () => {
    expect(addressProblem(parseAddresses('lin@example.com, sam@'), false)).toBe(
      'This is not an email address: sam@. Fix or remove it; nothing has been sent.'
    );
    const many = Array.from({ length: 21 }, (_, i) => `p${i}@example.com`);
    expect(addressProblem(parseAddresses(many.join(',')), false)).toContain(
      'That is 21 addresses'
    );
    // Empty is only wrong once the button is pressed.
    expect(addressProblem(parseAddresses(''), false)).toBeUndefined();
    expect(addressProblem(parseAddresses(''), true)).toBe(
      'Add at least one address.'
    );
  });
});

describe('the share panel', () => {
  const opened: SharePanelHandle[] = [];

  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.close();
    clearDom();
  });

  async function open(
    deps: ViewerDeps,
    readyView: ReadyView = view()
  ): Promise<{ panel: ElementStub; handle: SharePanelHandle }> {
    const opener = new ElementStub('button');
    const handle = openSharePanel(
      readyView,
      RELIC_ID,
      deps,
      opener as unknown as HTMLElement
    );
    opened.push(handle);
    await handle.ready;
    return { panel: handle.element as unknown as ElementStub, handle };
  }

  async function share(
    panel: ElementStub,
    handle: SharePanelHandle,
    typed: string
  ): Promise<void> {
    const box = only(panel, 'share-addresses');
    box.value = typed;
    box.fire('input');
    const form = descendants(panel).find(
      (node) => node.tagName === 'FORM' && node.className === 'share-form'
    );
    if (form === undefined) throw new Error('no address form');
    form.fire('submit');
    await handle.idle();
  }

  test('the two facts are said before any address is typed', async () => {
    const { panel } = await open(stubDeps(() => json(SHARED_REPLY), []));
    const text = textOf(panel);
    expect(text).toContain(SHARE_FACT_SENDING);
    expect(text).toContain(SHARE_FACT_STORING);
  });

  test('a reader with no session gets the comment sign-in, and no share is attempted', async () => {
    const calls: Call[] = [];
    const { panel } = await open(
      stubDeps(() => json(SHARED_REPLY), calls, null)
    );
    expect(textOf(panel)).toContain('Email me a code');
    expect(withClass(panel, 'share-addresses')).toHaveLength(0);
    // The facts are owed to a reader before they sign in to share, too.
    expect(textOf(panel)).toContain(SHARE_FACT_STORING);
    expect(shareCalls(calls)).toHaveLength(0);
  });

  test('the proof is derived from the key in this relic\u2019s own link', async () => {
    for (const key of [KEY_BYTES, OTHER_KEY]) {
      const calls: Call[] = [];
      const { panel, handle } = await open(
        stubDeps(() => json(SHARED_REPLY), calls),
        view(key)
      );
      await share(panel, handle, 'lin@example.com, Sam <sam@example.com>');
      const [call] = shareCalls(calls);
      const body = bodyOf(call);
      expect(body['share_proof']).toBe(encodeKey(await deriveShareProof(key)));
      expect(body['emails']).toEqual(['lin@example.com', 'sam@example.com']);
      expect(call?.init?.credentials).toBe('same-origin');
      handle.close();
    }
  });

  test('success shows the email the reader sends, with the whole link in the draft', async () => {
    const { panel, handle } = await open(
      stubDeps(() => json(SHARED_REPLY), [])
    );
    await share(panel, handle, 'LIN@example.com, sam@example.com');

    const text = textOf(panel);
    expect(text).toContain(
      'Added to this relic\u2019s emails about new comments and versions: 2 new, 0 already there. ' +
        'Its list holds 7 of 50. Relic has emailed nobody.'
    );
    // Addressed as the service normalized them, titled as it has the relic.
    const head = only(panel, 'share-email-head');
    expect(textOf(head)).toContain('lin@example.com, sam@example.com');
    expect(textOf(head)).toContain('Shared with you: Quarterly field notes');
    const letter = only(panel, 'share-email-body').textContent;
    expect(letter).toContain(view().shareUrl);
    expect(letter).toContain(
      'When someone comments or a new version is published'
    );

    const mailto = only(panel, 'share-mailto');
    expect(
      mailto.href.startsWith('mailto:lin@example.com,sam@example.com?')
    ).toBe(true);
    const draft = new URLSearchParams(mailto.href.split('?')[1]);
    expect(draft.get('subject')).toBe('Shared with you: Quarterly field notes');
    // The fragment is the key: a draft without it opens nothing.
    expect(draft.get('body')).toContain(view().shareUrl);
    expect(textOf(panel)).toContain('Copy message');
  });

  test('addresses that are not addresses never leave the page', async () => {
    const calls: Call[] = [];
    const { panel, handle } = await open(
      stubDeps(() => json(SHARED_REPLY), calls)
    );
    await share(panel, handle, 'lin@example.com, sam@');
    expect(shareCalls(calls)).toHaveLength(0);
    expect(textOf(panel)).toContain('This is not an email address: sam@');
    expect(only(panel, 'share-addresses').getAttribute('aria-invalid')).toBe(
      'true'
    );

    const many = Array.from({ length: 21 }, (_, i) => `p${i}@example.com`);
    await share(panel, handle, many.join('\n'));
    expect(shareCalls(calls)).toHaveLength(0);
    expect(textOf(panel)).toContain('That is 21 addresses');
  });

  const refusals: readonly {
    readonly code: string;
    readonly status: number;
    readonly extensions?: Record<string, unknown>;
    readonly says: string;
    readonly formStays: boolean;
  }[] = [
    {
      code: 'share_unavailable',
      status: 409,
      says: 'published before sharing existed',
      formStays: false,
    },
    {
      code: 'invalid_share_proof',
      status: 403,
      says: 'does not match the one this relic\u2019s publisher registered',
      formStays: false,
    },
    {
      code: 'share_rate_limited',
      status: 429,
      extensions: { retry_after_seconds: 120 },
      says: 'Try again in about 2 minutes',
      formStays: true,
    },
    {
      code: 'share_limit_reached',
      status: 409,
      extensions: { share_limit: 50, shared_count: 49 },
      says: 'It holds 49 of the 50 shared addresses',
      formStays: true,
    },
    {
      code: 'invalid_share',
      status: 400,
      extensions: { share_max_per_call: 20 },
      says: 'one share takes at most 20',
      formStays: true,
    },
  ];

  for (const refusal of refusals) {
    test(`${refusal.code} is said in words, with its code`, async () => {
      const { panel, handle } = await open(
        stubDeps(
          () => problem(refusal.code, refusal.status, refusal.extensions),
          []
        )
      );
      await share(panel, handle, 'lin@example.com');

      const card = only(panel, 'thread-refusal');
      expect(textOf(card)).toContain(refusal.says);
      expect(only(card, 'accession').textContent).toBe(refusal.code);
      // A refusal about the relic stops offering a form that cannot work;
      // one about the attempt keeps what the reader typed.
      expect(withClass(panel, 'share-addresses')).toHaveLength(
        refusal.formStays ? 1 : 0
      );
      expect(withClass(panel, 'share-email')).toHaveLength(0);
    });
  }

  test('a lapsed session puts the sign-in step back, and says why', async () => {
    const { panel, handle } = await open(
      stubDeps(() => problem('invalid_session', 401), [])
    );
    await share(panel, handle, 'lin@example.com');
    expect(textOf(panel)).toContain('This browser is not verified any more');
    expect(textOf(panel)).toContain('Email me a code');
    expect(withClass(panel, 'share-addresses')).toHaveLength(0);
  });

  test('closing takes the panel away and gives focus back to Share', async () => {
    const opener = new ElementStub('button');
    const handle = openSharePanel(
      view(),
      RELIC_ID,
      stubDeps(() => json(SHARED_REPLY), []),
      opener as unknown as HTMLElement
    );
    await handle.ready;
    expect(dom.body.children).toContain(
      handle.element as unknown as ElementStub
    );
    handle.close();
    expect(dom.body.children).toHaveLength(0);
    expect(dom.active).toBe(opener);
  });

  test('Share is offered on a relic that only downloads, too', () => {
    const shared: unknown[] = [];
    const bar = buildBar({ ...view(), route: 'download' }, RELIC_ID, {
      onShare: (opener) => shared.push(opener),
    }) as unknown as ElementStub;
    const control = only(bar, 'action-share');
    expect(textOf(control)).toContain('Share');
    expect(control.getAttribute('aria-haspopup')).toBe('dialog');
    control.fire('click');
    expect(shared).toEqual([control]);
  });
});
