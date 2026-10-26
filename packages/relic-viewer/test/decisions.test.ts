import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type CreationOptionsJSON,
  type DecisionRecord,
  deriveShareProof,
  encodeKey,
  type RequestOptionsJSON,
} from '@relic/format';
import type { SessionState } from '../src/comments.ts';
import {
  DECISION_CANCELLED,
  DECISION_TOFU,
  DECISION_UNAVAILABLE,
  type DecisionPanelHandle,
  mismatchCopy,
  openDecisionPanel,
  staleCopy,
} from '../src/decision-panel.ts';
import {
  authenticationResponseToJSON,
  base64urlDecode,
  base64urlEncode,
  ceremonySignal,
  type CredentialsLike,
  creationOptionsFromJSON,
  registrationResponseToJSON,
  requestOptionsFromJSON,
} from '../src/passkey-common.ts';
import {
  type DecisionTally,
  decisionAccess,
  listDecisions,
  tallyOf,
} from '../src/decisions.ts';
import { buildBar } from '../src/main.ts';
import type { ReadyView, ViewerDeps } from '../src/viewer.ts';

/**
 * Bun tests run without a DOM, so these stubs carry what the band control and
 * the decisions sheet touch: structure, text, attributes, and the events a
 * reader causes. What the sheet looks like is proven in a browser.
 */
class ElementStub {
  readonly tagName: string;
  className = '';
  textContent = '';
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
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
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

  show(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.fire('close');
  }

  /** Enough of a matcher for `[attr]`, `.class`, `:not([disabled])`, lists. */
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
    getElementById: () => null,
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
    candidate.classList.contains(name)
  );
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

const RELIC_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const ORIGIN = 'https://relik.example';
const KEY_BYTES = new Uint8Array([
  9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10,
]);
const PAGE_DIGEST = 'ab'.repeat(32);
const OTHER_DIGEST = 'cd'.repeat(32);
const READER = 'lin@example.com';

function view(overrides: Partial<ReadyView> = {}): ReadyView {
  return {
    filename: 'cut.md',
    declaredMimetype: 'text/markdown',
    content: new TextEncoder().encode('# cut\n'),
    route: 'markdown',
    downgradeNotice: undefined,
    shareUrl: `${ORIGIN}/${RELIC_ID}#r1${encodeKey(KEY_BYTES)}`,
    version: 3,
    currentVersion: 3,
    versionDigest: PAGE_DIGEST,
    ...overrides,
  };
}

function record(
  id: string,
  author: string,
  verdict: 'approve' | 'reject',
  createdAt: string,
  version = 3
): DecisionRecord {
  return {
    id,
    version,
    verdict,
    author,
    created_at: createdAt,
    version_digest: PAGE_DIGEST,
  };
}

const RECORDS: DecisionRecord[] = [
  record('r2', 'sam@example.com', 'reject', '2026-10-24T09:12:00.000Z'),
  record('r3', 'ada@example.com', 'reject', '2026-10-24T11:30:00.000Z'),
  record('r4', 'sam@example.com', 'approve', '2026-10-24T14:05:00.000Z'),
];

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

const REQUEST_OPTIONS: RequestOptionsJSON = {
  challenge: 'Y2hhbGxlbmdlLWNoYWxsZW5nZS1jaGFsbGVuZ2UtMzI',
  rpId: 'relik.example',
  timeout: 300000,
  userVerification: 'required',
  allowCredentials: [
    { type: 'public-key', id: 'Y3JlZC1vbmU', transports: ['internal'] },
  ],
};

const CREATION_OPTIONS: CreationOptionsJSON = {
  challenge: 'cmVnaXN0ZXItY2hhbGxlbmdl',
  rp: { id: 'relik.example', name: 'Relic' },
  user: { id: 'dXNlci1oYW5kbGU', name: READER, displayName: READER },
  pubKeyCredParams: [
    { type: 'public-key', alg: -7 },
    { type: 'public-key', alg: -257 },
  ],
  timeout: 300000,
  attestation: 'none',
  authenticatorSelection: {
    residentKey: 'preferred',
    userVerification: 'required',
  },
  excludeCredentials: [{ type: 'public-key', id: 'Y3JlZC1vbmU' }],
};

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

type Route = (call: Call) => Response;

/** A service keyed by path; unknown paths are a test failure, not a 404. */
function service(routes: Record<string, Route | Route[]>): {
  deps: ViewerDeps;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queues = new Map<string, Route[]>();
  for (const [path, route] of Object.entries(routes)) {
    queues.set(path, Array.isArray(route) ? [...route] : [route]);
  }
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(`/api/relics/${RELIC_ID}`, '');
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    const call = { method: init?.method ?? 'GET', path, body };
    calls.push(call);
    const queue = queues.get(path);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`unexpected request to ${path}`);
    }
    // The last route answers every later call too.
    const route = (queue.length > 1 ? queue.shift() : queue[0]) as Route;
    return route(call);
  }) as typeof globalThis.fetch;
  return {
    deps: {
      serviceOrigin: ORIGIN,
      fetch,
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: `${ORIGIN}/${RELIC_ID}`,
      keyVault: {
        remember: () => {},
        recall: () => undefined,
        forget: () => {},
      },
    },
    calls,
  };
}

function listReply(records: readonly DecisionRecord[], current = 3): Route {
  return () =>
    json({ relic_id: RELIC_ID, current_version: current, decisions: records });
}

function buffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/** What `navigator.credentials` resolves with, shaped as the browser's. */
function assertion(): Credential {
  return {
    id: 'Y3JlZC1vbmU',
    rawId: base64urlDecode('Y3JlZC1vbmU'),
    type: 'public-key',
    response: {
      clientDataJSON: buffer('{"type":"webauthn.get"}'),
      authenticatorData: buffer('auth-data'),
      signature: buffer('signature'),
      userHandle: null,
    },
  } as unknown as Credential;
}

function attestation(): Credential {
  return {
    id: 'Y3JlZC10d28',
    rawId: base64urlDecode('Y3JlZC10d28'),
    type: 'public-key',
    response: {
      clientDataJSON: buffer('{"type":"webauthn.create"}'),
      attestationObject: buffer('attestation'),
      getTransports: () => ['internal'],
    },
  } as unknown as Credential;
}

interface Ceremony {
  readonly kind: 'create' | 'get';
  readonly duringClick: boolean;
  readonly requestsBefore: number;
  readonly options: CredentialCreationOptions | CredentialRequestOptions;
}

/**
 * A credentials container that records whether each ceremony started inside
 * the press that asked for it, and how many requests had finished by then.
 */
function authenticator(
  calls: Call[],
  answers: {
    get?: () => Promise<Credential | null>;
    create?: () => Promise<Credential | null>;
  } = {}
): { credentials: CredentialsLike; ceremonies: Ceremony[] } {
  const ceremonies: Ceremony[] = [];
  return {
    ceremonies,
    credentials: {
      get: (options) => {
        ceremonies.push({
          kind: 'get',
          duringClick: clicking,
          requestsBefore: calls.length,
          options,
        });
        return answers.get?.() ?? Promise.resolve(assertion());
      },
      create: (options) => {
        ceremonies.push({
          kind: 'create',
          duringClick: clicking,
          requestsBefore: calls.length,
          options,
        });
        return answers.create?.() ?? Promise.resolve(attestation());
      },
    },
  };
}

let clicking = false;
function press(element: ElementStub): void {
  clicking = true;
  try {
    element.fire('click');
  } finally {
    clicking = false;
  }
}

interface Opened {
  readonly panel: ElementStub;
  readonly handle: DecisionPanelHandle;
  readonly tallies: (DecisionTally | null | undefined)[];
  readonly signInHosts: ElementStub[];
  readonly opened: number[];
}

const handles: DecisionPanelHandle[] = [];

/** Waits for the request chain the sheet exposes, however many steps it takes. */
async function settle(handle: DecisionPanelHandle): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    await handle.idle();
    const { promise, resolve } = Promise.withResolvers<void>();
    queueMicrotask(resolve);
    await promise;
  }
}

async function openPanel(
  deps: ViewerDeps,
  options: {
    readonly view?: ReadyView;
    readonly session?: SessionState;
    readonly credentials?: CredentialsLike;
  } = {}
): Promise<Opened> {
  const shown = options.view ?? view();
  const tallies: (DecisionTally | null | undefined)[] = [];
  const signInHosts: ElementStub[] = [];
  const opened: number[] = [];
  const handle = openDecisionPanel({
    view: shown,
    relicId: RELIC_ID,
    deps,
    opener: new ElementStub('button') as unknown as HTMLElement,
    ...decisionAccess(shown, RELIC_ID, deps),
    readSession: async () =>
      options.session ?? { kind: 'verified', email: READER },
    signIn: (host) => {
      signInHosts.push(host as unknown as ElementStub);
      host.appendChild(document.createElement('form'));
    },
    onTally: (tally) => tallies.push(tally),
    onOpenVersion: (version) => opened.push(version),
    onClose: () => {},
    credentials: options.credentials,
  });
  handles.push(handle);
  await handle.ready;
  return {
    panel: handle.element as unknown as ElementStub,
    handle,
    tallies,
    signInHosts,
    opened,
  };
}

function verdict(panel: ElementStub, which: 'approve' | 'reject'): ElementStub {
  const found = descendants(panel).find(
    (node) => node.getAttribute('data-decision-verdict') === which
  );
  if (found === undefined) throw new Error(`no ${which} verdict button`);
  return found;
}

function outcome(panel: ElementStub): ElementStub {
  return one(panel, 'data-decision-outcome');
}

beforeEach(installDom);
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  clearDom();
});

describe('the band control', () => {
  test('carries the tally as attributes and a chip, and opens the sheet', () => {
    const opened: unknown[] = [];
    const bar = buildBar(view(), RELIC_ID, {
      onDecide: (opener) => opened.push(opener),
      decisionTally: { approve: 1, reject: 0 },
    }) as unknown as ElementStub;
    const control = one(bar, 'data-decision-open');
    expect(control.tagName).toBe('BUTTON');
    expect(control.classList.contains('action-decisions')).toBe(true);
    expect(control.getAttribute('data-decision-approvals')).toBe('1');
    expect(control.getAttribute('data-decision-rejections')).toBe('0');
    expect(control.getAttribute('aria-haspopup')).toBe('dialog');
    expect(control.getAttribute('aria-label')).toBe(
      'Decisions on version 3: 1 approved, 0 rejected'
    );
    const chip = withClass(control, 'decision-tally');
    expect(chip).toHaveLength(1);
    const [approve, reject] = (chip[0] as ElementStub).children;
    expect(approve?.className).toBe('tally-approve');
    expect(approve?.getAttribute('data-zero')).toBe('false');
    expect(reject?.getAttribute('data-zero')).toBe('true');
    expect(textOf(control)).toContain('Decisions');
    control.fire('click');
    expect(opened).toEqual([control]);
  });

  test('sits beside Comments, ahead of Copy link and Share', () => {
    const bar = buildBar(view(), RELIC_ID, {
      onComments: () => {},
      onDecide: () => {},
      onShare: () => {},
    }) as unknown as ElementStub;
    const actions = withClass(bar, 'actions')[0] as ElementStub;
    const order = actions.children.map((child) => {
      if (child.classList.contains('action-comments')) return 'comments';
      if (child.classList.contains('action-decisions')) return 'decisions';
      if (child.classList.contains('action-share')) return 'share';
      return textOf(child).trim();
    });
    expect(order.indexOf('decisions')).toBe(order.indexOf('comments') + 1);
    expect(order.indexOf('decisions')).toBeLessThan(order.indexOf('share'));
  });

  test('shows no numbers while loading or when decisions are closed', () => {
    for (const tally of [undefined, null] as const) {
      const bar = buildBar(view(), RELIC_ID, {
        onDecide: () => {},
        ...(tally === undefined ? {} : { decisionTally: tally }),
      }) as unknown as ElementStub;
      const control = one(bar, 'data-decision-open');
      expect(control.hasAttribute('data-decision-approvals')).toBe(false);
      expect(control.hasAttribute('data-decision-rejections')).toBe(false);
      expect(withClass(control, 'decision-tally')).toHaveLength(0);
    }
    const closed = buildBar(view(), RELIC_ID, {
      onDecide: () => {},
      decisionTally: null,
    }) as unknown as ElementStub;
    expect(one(closed, 'data-decision-open').getAttribute('aria-label')).toBe(
      'Decisions, not open on this relic yet'
    );
  });

  test('is absent without a handler', () => {
    const bar = buildBar(view(), RELIC_ID) as unknown as ElementStub;
    expect(withAttr(bar, 'data-decision-open')).toHaveLength(0);
  });
});

describe('listing and counting', () => {
  test('lists with a proof derived from the key, never the key', async () => {
    const { deps, calls } = service({ '/decisions/list': listReply(RECORDS) });
    const listed = await listDecisions(RELIC_ID, KEY_BYTES, 3, deps);
    expect(listed.kind).toBe('listed');
    if (listed.kind !== 'listed') return;
    expect(listed.records).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      share_proof: encodeKey(await deriveShareProof(KEY_BYTES)),
      version: 3,
    });
    expect(JSON.stringify(calls[0]?.body)).not.toContain(encodeKey(KEY_BYTES));
  });

  test('a refusal carries its code, and a malformed list is refused', async () => {
    const closed = service({
      '/decisions/list': () => problem('decision_unavailable', 409),
    });
    expect(await listDecisions(RELIC_ID, KEY_BYTES, 3, closed.deps)).toEqual({
      kind: 'refused',
      code: 'decision_unavailable',
    });
    const broken = service({
      '/decisions/list': () =>
        json({ current_version: 3, decisions: [{ id: 'x' }] }),
    });
    expect(await listDecisions(RELIC_ID, KEY_BYTES, 3, broken.deps)).toEqual({
      kind: 'refused',
      code: 'malformed_decisions',
    });
  });

  test('each address counts once, by its latest decision', () => {
    expect(tallyOf(RECORDS, 3)).toEqual({ approve: 1, reject: 1 });
    expect(tallyOf(RECORDS, 2)).toEqual({ approve: 0, reject: 0 });
  });
});

describe('WebAuthn JSON and binary', () => {
  test('base64url round trips every length and matches the format codec', () => {
    for (let length = 0; length < 70; length += 1) {
      const bytes = new Uint8Array(length).map(
        (_, i) => (i * 37 + length) % 256
      );
      const text = base64urlEncode(bytes);
      expect(text).toBe(encodeKey(bytes));
      expect(new Uint8Array(base64urlDecode(text))).toEqual(bytes);
    }
    expect(() => base64urlDecode('abc=')).toThrow();
    expect(() => base64urlDecode('a+b/')).toThrow();
  });

  test('request options become buffers that encode back to the JSON', () => {
    const options = requestOptionsFromJSON(REQUEST_OPTIONS);
    expect(base64urlEncode(options.challenge as ArrayBuffer)).toBe(
      REQUEST_OPTIONS.challenge
    );
    expect(options.rpId).toBe('relik.example');
    expect(options.userVerification).toBe('required');
    expect(options.timeout).toBe(300000);
    const allowed = options.allowCredentials?.[0];
    expect(base64urlEncode(allowed?.id as ArrayBuffer)).toBe('Y3JlZC1vbmU');
    expect(allowed?.transports).toEqual(['internal']);
  });

  test('creation options become buffers that encode back to the JSON', () => {
    const options = creationOptionsFromJSON(CREATION_OPTIONS);
    expect(base64urlEncode(options.challenge as ArrayBuffer)).toBe(
      CREATION_OPTIONS.challenge
    );
    expect(base64urlEncode(options.user.id as ArrayBuffer)).toBe(
      CREATION_OPTIONS.user.id
    );
    expect(options.user.name).toBe(READER);
    expect(options.rp).toEqual({ id: 'relik.example', name: 'Relic' });
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257]);
    expect(options.attestation).toBe('none');
    expect(options.authenticatorSelection).toEqual({
      residentKey: 'preferred',
      userVerification: 'required',
    });
    expect(
      base64urlEncode(options.excludeCredentials?.[0]?.id as ArrayBuffer)
    ).toBe('Y3JlZC1vbmU');
  });

  test('credentials serialize to the W3C JSON shapes', () => {
    expect(authenticationResponseToJSON(assertion())).toEqual({
      id: 'Y3JlZC1vbmU',
      rawId: 'Y3JlZC1vbmU',
      type: 'public-key',
      response: {
        clientDataJSON: base64urlEncode(buffer('{"type":"webauthn.get"}')),
        authenticatorData: base64urlEncode(buffer('auth-data')),
        signature: base64urlEncode(buffer('signature')),
        userHandle: null,
      },
    });
    const registered = registrationResponseToJSON(attestation());
    expect(registered.rawId).toBe('Y3JlZC10d28');
    expect(registered.response.attestationObject).toBe(
      base64urlEncode(buffer('attestation'))
    );
    expect(registered.response.transports).toEqual(['internal']);
    expect(() =>
      authenticationResponseToJSON({ id: 'x' } as unknown as Credential)
    ).toThrow();
  });
});

describe('the decisions sheet', () => {
  test('lists the current decision per address, with history and the reader marked', async () => {
    const mine = record('r5', READER, 'approve', '2026-10-24T15:00:00.000Z');
    const { deps } = service({
      '/decisions/list': listReply([...RECORDS, mine]),
    });
    const { panel, tallies } = await openPanel(deps);
    expect(panel.tagName).toBe('DIALOG');
    expect(panel.classList.contains('decision-panel')).toBe(true);
    expect(panel.getAttribute('data-decision-version')).toBe('3');
    expect(panel.open).toBe(true);
    const rows = withAttr(panel, 'data-decision-row');
    expect(
      rows.map((row) => [
        row.getAttribute('data-decision-author'),
        row.getAttribute('data-verdict'),
      ])
    ).toEqual([
      ['ada@example.com', 'reject'],
      ['sam@example.com', 'approve'],
      [READER, 'approve'],
    ]);
    expect(textOf(rows[1] as ElementStub)).toContain('1 earlier decision');
    expect(withClass(rows[2] as ElementStub, 'decision-you')).toHaveLength(1);
    expect(textOf(panel)).toContain('separate from comments');
    expect(tallies.at(-1)).toEqual({ approve: 2, reject: 1 });
    expect(withAttr(panel, 'data-decision-verdict')).toHaveLength(2);
    expect(withAttr(panel, 'data-decision-stale')).toHaveLength(0);
  });

  test('an anonymous reader is handed the comment sign-in, not a verdict', async () => {
    const { deps } = service({ '/decisions/list': listReply(RECORDS) });
    const { panel, signInHosts } = await openPanel(deps, {
      session: { kind: 'anonymous' },
    });
    const host = one(panel, 'data-decision-signin');
    expect(signInHosts).toEqual([host]);
    expect(textOf(host)).toContain('Sign in to decide');
    expect(withAttr(panel, 'data-decision-verdict')).toHaveLength(0);
  });

  test('an older version says which version a decision lands on', async () => {
    const { deps } = service({ '/decisions/list': listReply([], 3) });
    const { panel, opened } = await openPanel(deps, {
      view: view({ version: 2, currentVersion: 3 }),
    });
    const stale = one(panel, 'data-decision-stale');
    expect(textOf(stale)).toContain(staleCopy(2, 3));
    expect(textOf(panel)).toContain('No decisions on version 2 yet.');
    const go = descendants(stale).find((n) => n.tagName === 'BUTTON');
    go?.fire('click');
    expect(opened).toEqual([3]);
  });

  test('a relic without decisions says so and closes the band count', async () => {
    const { deps } = service({
      '/decisions/list': () => problem('decision_unavailable', 409),
    });
    const { panel, tallies } = await openPanel(deps);
    const box = outcome(panel);
    expect(box.getAttribute('data-state')).toBe('error');
    expect(box.getAttribute('data-code')).toBe('decision_unavailable');
    expect(textOf(box)).toContain(DECISION_UNAVAILABLE);
    expect(tallies).toEqual([null]);
    expect(withAttr(panel, 'data-decision-verdict')).toHaveLength(0);
  });

  test('the ceremony starts only inside the confirm press, with options already fetched', async () => {
    const { deps, calls } = service({
      '/decisions/list': [
        listReply(RECORDS),
        listReply([
          ...RECORDS,
          record('r9', READER, 'approve', '2026-10-24T16:00:00.000Z'),
        ]),
      ],
      '/decisions/options': () =>
        json({
          version: 3,
          version_digest: PAGE_DIGEST,
          public_key: REQUEST_OPTIONS,
        }),
      '/decisions': () =>
        json(
          {
            relic_id: RELIC_ID,
            id: 'r9',
            version: 3,
            verdict: 'approve',
            author: READER,
            created_at: '2026-10-24T16:00:00.000Z',
            version_digest: PAGE_DIGEST,
          },
          201
        ),
    });
    const auth = authenticator(calls);
    const { panel, handle, tallies } = await openPanel(deps, {
      credentials: auth.credentials,
    });

    press(verdict(panel, 'approve'));
    // Choosing fetches; it does not prompt, and offers nothing to confirm yet.
    expect(auth.ceremonies).toHaveLength(0);
    expect(withAttr(panel, 'data-decision-confirm')).toHaveLength(0);
    await settle(handle);
    expect(auth.ceremonies).toHaveLength(0);
    const optionsCall = calls.find((c) => c.path === '/decisions/options');
    expect(optionsCall?.body).toMatchObject({ version: 3, verdict: 'approve' });

    const confirm = one(panel, 'data-decision-confirm');
    expect(textOf(confirm)).toContain('Approve version 3 with your passkey');
    const requestsBeforePress = calls.length;
    press(confirm);
    expect(auth.ceremonies).toEqual([
      expect.objectContaining({
        kind: 'get',
        duringClick: true,
        requestsBefore: requestsBeforePress,
      }),
    ]);
    // The prompt is up: the button waits rather than inviting a second press.
    expect(one(panel, 'data-decision-confirm').disabled).toBe(true);

    await settle(handle);
    const posted = calls.find(
      (c) => c.path === '/decisions' && c.method === 'POST'
    );
    expect(posted?.body).toMatchObject({
      version: 3,
      verdict: 'approve',
      version_digest: PAGE_DIGEST,
      credential: authenticationResponseToJSON(assertion()),
    });
    const box = outcome(panel);
    expect(box.getAttribute('data-state')).toBe('recorded');
    expect(box.getAttribute('data-code')).toBe('recorded');
    expect(withClass(box, 'decision-stamp')).toHaveLength(1);
    expect(textOf(box)).toContain('Approved');
    expect(textOf(box)).toContain(`sha256 ${PAGE_DIGEST.slice(0, 12)}`);
    expect(
      withAttr(panel, 'data-decision-row').some(
        (row) => row.getAttribute('data-decision-author') === READER
      )
    ).toBe(true);
    expect(tallies.at(-1)).toEqual({ approve: 2, reject: 1 });
    expect(calls.filter((c) => c.path === '/decisions/list')).toHaveLength(2);
  });

  test('a stored file that differs from the page blocks the ceremony', async () => {
    const { deps, calls } = service({
      '/decisions/list': listReply(RECORDS),
      '/decisions/options': () =>
        json({
          version: 3,
          version_digest: OTHER_DIGEST,
          public_key: REQUEST_OPTIONS,
        }),
    });
    const auth = authenticator(calls);
    const { panel, handle } = await openPanel(deps, {
      credentials: auth.credentials,
    });
    press(verdict(panel, 'reject'));
    await settle(handle);
    const box = outcome(panel);
    expect(box.getAttribute('data-state')).toBe('error');
    expect(box.getAttribute('data-code')).toBe('decision_digest_mismatch');
    expect(textOf(box)).toContain(mismatchCopy(3));
    expect(textOf(box)).toContain(OTHER_DIGEST.slice(0, 12));
    expect(withAttr(panel, 'data-decision-confirm')).toHaveLength(0);
    expect(auth.ceremonies).toHaveLength(0);
    expect(calls.some((c) => c.path === '/decisions')).toBe(false);
  });

  test('a closed prompt is cancelled, and nothing is posted', async () => {
    const { deps, calls } = service({
      '/decisions/list': listReply(RECORDS),
      '/decisions/options': () =>
        json({
          version: 3,
          version_digest: PAGE_DIGEST,
          public_key: REQUEST_OPTIONS,
        }),
    });
    const auth = authenticator(calls, {
      get: () => Promise.reject(new DOMException('closed', 'NotAllowedError')),
    });
    const { panel, handle } = await openPanel(deps, {
      credentials: auth.credentials,
    });
    press(verdict(panel, 'approve'));
    await settle(handle);
    press(one(panel, 'data-decision-confirm'));
    await settle(handle);
    const box = outcome(panel);
    expect(box.getAttribute('data-state')).toBe('cancelled');
    expect(box.getAttribute('data-code')).toBe('not_allowed');
    expect(textOf(box)).toContain(DECISION_CANCELLED);
    expect(calls.some((c) => c.path === '/decisions')).toBe(false);
  });

  test('no passkey yet: setup creates one inside its press, then the decision proceeds', async () => {
    const { deps, calls } = service({
      '/decisions/list': listReply(RECORDS),
      '/decisions/options': [
        () => problem('passkey_required', 409),
        () =>
          json({
            version: 3,
            version_digest: PAGE_DIGEST,
            public_key: REQUEST_OPTIONS,
          }),
      ],
      '/api/auth/passkeys/options': () =>
        json({ mode: 'create', public_key: CREATION_OPTIONS }),
      '/api/auth/passkeys': () =>
        json(
          {
            email: READER,
            credential_id: 'Y3JlZC10d28',
            created_at: '2026-10-24T16:00:00.000Z',
            passkeys: 1,
          },
          201
        ),
    });
    const auth = authenticator(calls);
    const { panel, handle } = await openPanel(deps, {
      credentials: auth.credentials,
    });
    press(verdict(panel, 'approve'));
    await settle(handle);
    expect(textOf(panel)).toContain(DECISION_TOFU);
    const create = one(panel, 'data-passkey-create');
    const before = calls.length;
    press(create);
    expect(auth.ceremonies).toEqual([
      expect.objectContaining({
        kind: 'create',
        duringClick: true,
        requestsBefore: before,
      }),
    ]);
    await settle(handle);
    const registered = calls.find((c) => c.path === '/api/auth/passkeys');
    expect(registered?.body).toEqual({
      credential: registrationResponseToJSON(attestation()),
    });
    expect(calls.filter((c) => c.path === '/decisions/options')).toHaveLength(
      2
    );
    expect(withAttr(panel, 'data-decision-confirm')).toHaveLength(1);
  });

  test('a passkey on another device: adding one asserts the old one first', async () => {
    const { deps, calls } = service({
      '/decisions/list': listReply(RECORDS),
      '/decisions/options': [
        () => problem('passkey_required', 409),
        () =>
          json({
            version: 3,
            version_digest: PAGE_DIGEST,
            public_key: REQUEST_OPTIONS,
          }),
      ],
      '/api/auth/passkeys/options': [
        () => json({ mode: 'assert', public_key: REQUEST_OPTIONS }),
        () => json({ mode: 'create', public_key: CREATION_OPTIONS }),
      ],
      '/api/auth/passkeys': () =>
        json({ email: READER, credential_id: 'x', passkeys: 2 }, 201),
    });
    const auth = authenticator(calls);
    const { panel, handle } = await openPanel(deps, {
      credentials: auth.credentials,
    });
    press(verdict(panel, 'approve'));
    await settle(handle);
    press(one(panel, 'data-passkey-add'));
    await settle(handle);
    const enrol = calls.filter((c) => c.path === '/api/auth/passkeys/options');
    expect(enrol[1]?.body).toEqual({
      credential: authenticationResponseToJSON(assertion()),
    });
    press(one(panel, 'data-passkey-create'));
    await settle(handle);
    expect(auth.ceremonies.map((c) => [c.kind, c.duringClick])).toEqual([
      ['get', true],
      ['create', true],
    ]);
    expect(withAttr(panel, 'data-decision-confirm')).toHaveLength(1);
  });

  for (const code of ['sign_in_required', 'invalid_session']) {
    test(`${code} on record puts the sign-in step back`, async () => {
      const { deps, calls } = service({
        '/decisions/list': listReply(RECORDS),
        '/decisions/options': () =>
          json({
            version: 3,
            version_digest: PAGE_DIGEST,
            public_key: REQUEST_OPTIONS,
          }),
        '/decisions': () => problem(code, 401),
      });
      const auth = authenticator(calls);
      const { panel, handle, signInHosts } = await openPanel(deps, {
        credentials: auth.credentials,
      });
      press(verdict(panel, 'approve'));
      await settle(handle);
      press(one(panel, 'data-decision-confirm'));
      await settle(handle);
      const host = one(panel, 'data-decision-signin');
      expect(signInHosts.at(-1)).toBe(host);
      expect(textOf(host)).toContain('not verified any more');
    });
  }

  test('a passkey that does not verify is said in words, with its code', async () => {
    const { deps, calls } = service({
      '/decisions/list': listReply(RECORDS),
      '/decisions/options': () =>
        json({
          version: 3,
          version_digest: PAGE_DIGEST,
          public_key: REQUEST_OPTIONS,
        }),
      '/decisions': () =>
        problem('passkey_verification_failed', 403, {
          passkey_check: 'signature',
        }),
    });
    const auth = authenticator(calls);
    const { panel, handle } = await openPanel(deps, {
      credentials: auth.credentials,
    });
    press(verdict(panel, 'approve'));
    await settle(handle);
    press(one(panel, 'data-decision-confirm'));
    await settle(handle);
    const box = outcome(panel);
    expect(box.getAttribute('data-state')).toBe('error');
    expect(box.getAttribute('data-code')).toBe('passkey_verification_failed');
    expect(textOf(box)).toContain('Your passkey did not verify');
  });

  test('closing takes the sheet away and gives focus back to the control', async () => {
    const { deps } = service({ '/decisions/list': listReply(RECORDS) });
    const { handle } = await openPanel(deps);
    expect(dom.body.children).toContain(
      handle.element as unknown as ElementStub
    );
    handle.close();
    expect(dom.body.children).toHaveLength(0);
    expect(dom.active?.tagName).toBe('BUTTON');
  });

  test('decision ceremonies abort an earlier ceremonySignal()', async () => {
    const { deps, calls } = service({
      '/decisions/list': listReply(RECORDS),
      '/decisions/options': () =>
        json({
          version: 3,
          version_digest: PAGE_DIGEST,
          public_key: REQUEST_OPTIONS,
        }),
    });
    const auth = authenticator(calls);
    const { panel, handle } = await openPanel(deps, {
      credentials: auth.credentials,
    });
    const priorSignal = ceremonySignal();
    expect(priorSignal.aborted).toBe(false);

    press(verdict(panel, 'approve'));
    await settle(handle);
    press(one(panel, 'data-decision-confirm'));
    await settle(handle);

    expect(priorSignal.aborted).toBe(true);
    expect((priorSignal.reason as DOMException).name).toBe('AbortError');
    expect((priorSignal.reason as DOMException).message).toBe(
      'A newer passkey request replaced this one'
    );
  });
});
