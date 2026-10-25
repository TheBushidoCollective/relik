import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  COMMENT_NONCE_BYTES,
  CommentDecryptFailedError,
  deriveCommentKey,
  encodeKey,
  parseFragment,
} from '@relic/format';
import {
  authRequestBody,
  type CommentEntry,
  type CommentRecord,
  collectDisplayedEntries,
  commentCipher,
  commentRefusal,
  editComment,
  keySurvivesNavigation,
  loadThread,
  MAX_BODY_BYTES,
  openEntry,
  PUBLISHER_AUTHOR,
  plainLabel,
  postComment,
  requestMagicLink,
  THREAD_CYCLE_RECOVERY,
  THREAD_ORPHAN_RECOVERY,
  threadCountLabel,
  threadEntries,
} from '../src/comments.ts';
import {
  buildBar,
  buildRelicRow,
  buildStageWrap,
  buildThread,
  clampThreadWidth,
  commentRow,
  displayNameInput,
  localStorageKeyVault,
  pinFraction,
  pinOffsets,
  readDisplayName,
  THREAD_EMPTY_NOTE,
  threadRefusal,
  updateThreadToggle,
  writeDisplayName,
} from '../src/main.ts';
import type { ReadyView, ViewerDeps } from '../src/viewer.ts';

/**
 * Bun tests run without a DOM, exactly as `version-diff-ui.test.ts` found, so
 * the stubs carry only what the thread touches while it builds. Structure is
 * assertable here; what the thread looks like is proven in a browser, which is
 * the only place it can be.
 */
class ElementStub {
  readonly tagName: string;
  className = '';
  textContent = '';
  private _innerHTML = '';
  get innerHTML(): string {
    return this._innerHTML;
  }
  set innerHTML(html: string) {
    this._innerHTML = html;
    this.textContent = html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }
  id = '';
  hidden = false;
  tabIndex = 0;
  type = '';
  title = '';
  value = '';
  rows = 0;
  required = false;
  disabled = false;
  maxLength = 0;
  placeholder = '';
  autocomplete = '';
  href = '';
  rel = '';
  readonly children: ElementStub[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style = { setProperty: (): void => {} };
  readonly classList = {
    add: (name: string): void => {
      this.className = `${this.className} ${name}`.trim();
    },
    toggle: (): void => {},
  };

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  appendChild(child: ElementStub): ElementStub {
    this.children.push(child);
    return child;
  }

  append(...children: ElementStub[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: ElementStub[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  focus(): void {}
  addEventListener(): void {}
  scrollIntoView(): void {}
  replaceWith(): void {}
}

function installDom(): void {
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new ElementStub(tag),
    createElementNS: (_namespace: string, tag: string) => new ElementStub(tag),
    createTextNode: (text: string) => {
      const node = new ElementStub('#text');
      node.textContent = text;
      return node;
    },
    addEventListener: () => {},
    visibilityState: 'visible',
    documentElement: {
      style: {
        setProperty: () => {},
        getPropertyValue: () => '',
      },
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

const RELIC_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';

/** A real 16-byte key, so the derivation and the envelope are the real ones. */
const KEY_BYTES = new Uint8Array([
  9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 15, 14, 13, 12, 11, 10,
]);
const FRAGMENT = `#r1${encodeKey(KEY_BYTES)}`;

function view(overrides: Partial<ReadyView> = {}): ReadyView {
  return {
    filename: 'notes.md',
    declaredMimetype: 'text/markdown',
    content: new TextEncoder().encode('# notes\n'),
    route: 'markdown',
    downgradeNotice: undefined,
    shareUrl: `https://relik.example/${RELIC_ID}${FRAGMENT}`,
    version: 1,
    currentVersion: 1,
    versionDigest: '0'.repeat(64),
    ...overrides,
  };
}

/** An in-memory `Storage`, so the vault under test is the shipped one. */
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

describe('the display name, remembered across relics', () => {
  // Reported as signing in per relic. The session was already global; this
  // was the part that genuinely was not, and it was worse than per relic: the
  // composer cleared the name after every single comment.
  const original = globalThis.localStorage;

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    } else {
      (globalThis as { localStorage?: unknown }).localStorage = original;
    }
  });

  function install(): Storage {
    const store = memoryStorage();
    (globalThis as { localStorage?: unknown }).localStorage = store;
    return store;
  }

  test('nothing remembered reads as empty, not as undefined', () => {
    install();
    expect(readDisplayName()).toBe('');
  });

  test('a name survives to the next read, under a key with no relic in it', () => {
    const store = install();
    writeDisplayName('Ada');
    expect(readDisplayName()).toBe('Ada');
    // The key is the load-bearing part: anything relic-scoped would reproduce
    // the reported bug exactly.
    expect(store.getItem('relic:display-name')).toBe('Ada');
    expect(RELIC_ID.length).toBeGreaterThan(0);
    expect(store.getItem('relic:display-name')).not.toContain(RELIC_ID);
  });

  test('it is trimmed on the way in', () => {
    install();
    writeDisplayName('  Ada  ');
    expect(readDisplayName()).toBe('Ada');
  });

  test('clearing it is respected rather than reverted', () => {
    const store = install();
    writeDisplayName('Ada');
    writeDisplayName('   ');
    expect(readDisplayName()).toBe('');
    expect(store.getItem('relic:display-name')).toBeNull();
  });

  test('storage that refuses is not an error path', () => {
    // Safari private mode throws on touch rather than being absent.
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(readDisplayName()).toBe('');
    expect(() => writeDisplayName('Ada')).not.toThrow();
  });

  test('the field arrives carrying the remembered name', () => {
    // The wiring, not just the storage. This assignment is the whole feature
    // and it is one line, which is the kind that silently stops happening.
    install();
    writeDisplayName('Ada');
    installDom();
    try {
      const input = displayNameInput() as unknown as ElementStub;
      expect(input.value).toBe('Ada');
      expect(input.className).toBe('compose-input');
      expect(input.type).toBe('text');
    } finally {
      clearDom();
    }
  });

  test('with nothing remembered the field is empty', () => {
    install();
    installDom();
    try {
      expect((displayNameInput() as unknown as ElementStub).value).toBe('');
    } finally {
      clearDom();
    }
  });
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

function stubDeps(
  handler: (call: Call) => Response,
  calls: Call[] = [],
  storage: Storage = memoryStorage()
): ViewerDeps {
  return {
    serviceOrigin: 'https://relik.example',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      return handler(call);
    }) as typeof globalThis.fetch,
    takeFragment: () => FRAGMENT,
    stripFragment: () => {},
    locationHref: `https://relik.example/${RELIC_ID}`,
    keyVault: localStorageKeyVault(storage, () => 1_000),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problem(code: string, status: number): Response {
  return new Response(JSON.stringify({ code, title: code }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

async function sealed(
  body: string,
  displayName: string | null = null,
  key: Uint8Array = KEY_BYTES,
  addresses: string | null = null
): Promise<string> {
  const cipher = commentCipher(await deriveCommentKey(key));
  return cipher.seal({ body, display_name: displayName, addresses });
}

async function sealedWithAddresses(
  body: string,
  addresses: string | null = null,
  displayName: string | null = null,
  key: Uint8Array = KEY_BYTES
): Promise<string> {
  const cipher = commentCipher(await deriveCommentKey(key));
  return cipher.seal({ body, display_name: displayName, addresses });
}

async function record(
  overrides: Partial<CommentRecord> & { readonly ciphertext: string }
): Promise<CommentRecord> {
  return {
    comment_id: 'c1',
    author: 'ada@example.com',
    created_at: '2026-08-20T09:15:00.000Z',
    ...overrides,
  };
}

describe('the comment key', () => {
  test('cannot be read back out by a script on this origin', async () => {
    // Independence from the container key is proven where it is derived, in
    // relic-format's own tests. What matters on this side of the boundary is
    // that the viewer holds a key object and not key bytes: a sanitizer
    // bypass or a stray same-origin script finds nothing to export.
    const commentKey = await deriveCommentKey(KEY_BYTES);
    expect(commentKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', commentKey)).rejects.toThrow();
  });

  test('is deterministic for one fragment and differs across fragments', async () => {
    const one = commentCipher(await deriveCommentKey(KEY_BYTES));
    const again = commentCipher(await deriveCommentKey(KEY_BYTES));
    const other = commentCipher(
      await deriveCommentKey(new Uint8Array(16).fill(7))
    );

    const ciphertext = await one.seal({ body: 'hi', display_name: null });
    expect((await again.open(ciphertext)).body).toBe('hi');
    await expect(other.open(ciphertext)).rejects.toThrow(
      CommentDecryptFailedError
    );
  });

  test('comes out of the fragment the viewer already parsed', async () => {
    // The thread derives from `parseFragment(view.shareUrl hash)`, so this is
    // the path the DOM layer actually takes.
    const parsed = parseFragment(new URL(view().shareUrl).hash);
    const cipher = commentCipher(await deriveCommentKey(parsed.key));
    const ciphertext = await sealed('from the share url');
    expect((await cipher.open(ciphertext)).body).toBe('from the share url');
  });
});

describe('the thread', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('renders two comments oldest first, with author and time', async () => {
    const rows = [
      await record({
        comment_id: 'c1',
        author: 'ada@example.com',
        created_at: '2026-08-20T09:15:00.000Z',
        ciphertext: await sealed('First, and it decrypts.'),
      }),
      await record({
        comment_id: 'c2',
        author: 'grace@example.com',
        created_at: '2026-08-20T10:30:00.000Z',
        ciphertext: await sealed('Second, with a name.', 'Grace H'),
      }),
    ];
    const deps = stubDeps(() => json(rows));
    const cipher = commentCipher(await deriveCommentKey(KEY_BYTES));

    const state = await loadThread(RELIC_ID, deps, cipher);
    if (state.kind !== 'ready') throw new Error(`refused: ${state.kind}`);
    expect(state.entries).toHaveLength(2);

    const list = state.entries.map(
      (entry) => commentRow(entry) as unknown as ElementStub
    );
    const first = list[0];
    const second = list[1];
    if (first === undefined || second === undefined) {
      throw new Error('the thread built no rows');
    }

    expect(textOf(first)).toContain('First, and it decrypts.');
    expect(textOf(first)).toContain('ada@example.com');
    // Absolute rather than relative: a relic outlives "3 hours ago".
    expect(textOf(first)).not.toContain('ago');

    // A display name aliases the address, it never replaces it.
    expect(withClass(second, 'comment-name')[0]?.textContent).toBe('Grace H');
    expect(withClass(second, 'comment-author')[0]?.textContent).toBe(
      'grace@example.com'
    );
  });

  test('a comment that will not decrypt is shown, not dropped', async () => {
    const wrongKey = await sealed(
      'written under another key',
      null,
      new Uint8Array(16).fill(3)
    );
    const rows = [
      await record({ comment_id: 'good', ciphertext: await sealed('fine') }),
      await record({ comment_id: 'bad', ciphertext: wrongKey }),
    ];
    const deps = stubDeps(() => json(rows));
    const cipher = commentCipher(await deriveCommentKey(KEY_BYTES));

    const state = await loadThread(RELIC_ID, deps, cipher);
    if (state.kind !== 'ready') throw new Error('the thread was refused');

    // Two entries, not one. A thread that silently drops a row it cannot read
    // is one whose length nobody can trust.
    expect(state.entries).toHaveLength(2);
    expect(state.entries[1]?.kind).toBe('sealed');

    const row = commentRow(state.entries[1] as never) as unknown as ElementStub;
    expect(row.className).toContain('comment-undecryptable');
    expect(textOf(row)).toContain('did not decrypt');
    // Still attributed and still timed: what is missing is the body.
    expect(textOf(row)).toContain('ada@example.com');
    // And it does not claim to know which cause it was.
    expect(textOf(row)).toContain('no way to tell which');
  });

  test('an empty thread says so, and it is not an error', async () => {
    const deps = stubDeps(() => json([]));
    const cipher = commentCipher(await deriveCommentKey(KEY_BYTES));
    const state = await loadThread(RELIC_ID, deps, cipher);

    expect(state).toEqual({ kind: 'ready', entries: [] });
    expect(threadCountLabel(0)).toBe('No comments');
    expect(THREAD_EMPTY_NOTE).toContain('No comments yet');
    // The empty state explains what a comment is for rather than sitting
    // blank, and it does not overclaim about who can read one.
    expect(THREAD_EMPTY_NOTE).toContain('without being able to read it');
  });
  test('a row missing its ciphertext is reported, not dropped and not sealed', async () => {
    const deps = stubDeps(() =>
      json([
        {
          comment_id: 'x',
          author: 'a@b.c',
          created_at: '2026-08-20T09:00:00Z',
        },
        { nothing: true },
      ])
    );
    const cipher = commentCipher(await deriveCommentKey(KEY_BYTES));
    const state = await loadThread(RELIC_ID, deps, cipher);
    if (state.kind !== 'ready') throw new Error('the thread was refused');

    // Two entries, because a thread shorter than it is cannot be noticed.
    expect(state.entries).toHaveLength(2);
    expect(state.entries.map((entry) => entry.kind)).toEqual([
      'unreadable',
      'unreadable',
    ]);
    // Sealed would be a guess: there may never have been a body.
    const first = state.entries[0];
    if (first?.kind !== 'unreadable') throw new Error('wrong state');
    expect(first.author).toBe('a@b.c');
    const second = state.entries[1];
    if (second?.kind !== 'unreadable') throw new Error('wrong state');
    expect(second.author).toBeNull();

    // A row that named no sender gets no sender invented for it.
    const row = commentRow(second) as unknown as ElementStub;
    expect(withClass(row, 'comment-author')).toHaveLength(0);
    expect(textOf(row)).toContain(
      'did not arrive in a form this page can read'
    );
    expect(threadCountLabel(state.entries.length)).toBe('2 comments');
  });

  test('reading the thread needs no session and sends no credential', async () => {
    const calls: Call[] = [];
    const deps = stubDeps(() => json([]), calls);
    await loadThread(
      RELIC_ID,
      deps,
      commentCipher(await deriveCommentKey(KEY_BYTES))
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(
      `https://relik.example/api/relics/${RELIC_ID}/comments`
    );
  });

  test('strips bidirectional controls out of a chosen display name', () => {
    // A display name is chosen by any link holder and rendered on the origin
    // holding the fragment, so it gets the filename's treatment.
    expect(plainLabel('ada\u202egnitirw')).toBe('adagnitirw');
    const row = commentRow({
      kind: 'open',
      id: 'c1',
      author: 'ada@example.com',
      createdAt: '2026-08-20T09:15:00.000Z',
      body: 'hello',
      displayName: 'A\u202Eda',
      anchor: null,
    }) as unknown as ElementStub;
    expect(withClass(row, 'comment-name')[0]?.textContent).toBe('Ada');
  });

  test('a publish-token comment is marked as the publisher', () => {
    const row = commentRow({
      kind: 'open',
      id: 'c1',
      author: 'publisher',
      createdAt: '2026-08-20T09:15:00.000Z',
      body: 'republished with the fix',
      displayName: null,
      anchor: null,
    }) as unknown as ElementStub;
    expect(textOf(row)).toContain('Published this relic');
  });
});

describe('refusal states', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('a rate limit names itself and offers a retry', async () => {
    const deps = stubDeps(() => problem('comment_rate_limited', 429));
    const state = await loadThread(
      RELIC_ID,
      deps,
      commentCipher(await deriveCommentKey(KEY_BYTES))
    );
    if (state.kind !== 'refused') throw new Error('expected a refusal');

    expect(state.refusal.code).toBe('comment_rate_limited');
    expect(state.refusal.retryable).toBe(true);
    const card = threadRefusal(
      state.refusal,
      () => {}
    ) as unknown as ElementStub;
    expect(textOf(card)).toContain('Too many comments');
    // The reader is told nothing was lost, which is the actionable part.
    expect(textOf(card)).toContain('Nothing was lost');
    expect(textOf(card)).toContain('comment_rate_limited');
    const buttons = descendants(card).filter(
      (element) => element.tagName === 'BUTTON'
    );
    expect(buttons.map(textOf).join(' ')).toContain('Try again');
  });

  test('a refusal that a retry cannot fix does not offer one', () => {
    const card = threadRefusal(
      commentRefusal('body_too_large'),
      () => {}
    ) as unknown as ElementStub;
    const buttons = descendants(card).filter(
      (element) => element.tagName === 'BUTTON'
    );
    expect(buttons).toHaveLength(0);
    expect(textOf(card)).toContain('nothing was sent');
  });

  test('an unknown code is stated rather than flattened', () => {
    const refusal = commentRefusal('comment_storage_unavailable');
    expect(refusal.detail).toContain('comment_storage_unavailable');
    expect(refusal.detail).not.toContain('something went wrong');
  });

  test('a network failure is not reported as a problem with the relic', async () => {
    const deps: ViewerDeps = {
      ...stubDeps(() => json([])),
      // A rejecting fetch is not shaped like `fetch`, and it does not need to
      // be: the thread only ever calls it.
      fetch: (() =>
        Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    };
    const state = await loadThread(
      RELIC_ID,
      deps,
      commentCipher(await deriveCommentKey(KEY_BYTES))
    );
    if (state.kind !== 'refused') throw new Error('expected a refusal');
    expect(state.refusal.code).toBe('network');
    expect(state.refusal.detail).toContain('network problem');
  });

  test('a lapsed session is distinguished from never having had one', () => {
    expect(commentRefusal('invalid_session').headline).toContain(
      'not verified any more'
    );
    expect(commentRefusal('invalid_session').retryable).toBe(false);
  });

  test('an oversize body is refused before it is encrypted or sent', async () => {
    const calls: Call[] = [];
    const deps = stubDeps(() => json({ author: 'a@b.c' }), calls);
    const result = await postComment(
      RELIC_ID,
      { body: 'x'.repeat(MAX_BODY_BYTES + 1), display_name: null },
      deps,
      commentCipher(await deriveCommentKey(KEY_BYTES))
    );
    expect(result.kind).toBe('refused');
    expect(calls).toHaveLength(0);
  });
});

describe('posting a comment', () => {
  test('sends ciphertext and nothing that reads as a body', async () => {
    const calls: Call[] = [];
    const deps = stubDeps(
      () => json({ comment_id: 'c9', author: 'ada@example.com' }),
      calls
    );
    const result = await postComment(
      RELIC_ID,
      { body: 'the operator must not read this', display_name: 'Ada' },
      deps,
      commentCipher(await deriveCommentKey(KEY_BYTES))
    );

    expect(result).toEqual({
      kind: 'posted',
      author: 'ada@example.com',
      commentId: 'c9',
    });
    const sentBody = calls[0]?.body ?? '';
    expect(sentBody).not.toContain('the operator must not read this');
    // The display name lives inside the envelope too, so it is not on the wire
    // in the clear either.
    expect(sentBody).not.toContain('Ada');
    // Named rather than cast inline: this is the request this test built, so
    // its shape is known here in a way a wire response never is.
    const parsed: unknown = JSON.parse(sentBody);
    expect(
      typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : []
    ).toEqual(['ciphertext']);
  });

  test('what the server stores decrypts back to what was typed', async () => {
    const calls: Call[] = [];
    const deps = stubDeps(
      () => json({ comment_id: 'c9', author: 'ada@example.com' }),
      calls
    );
    const cipher = commentCipher(await deriveCommentKey(KEY_BYTES));
    await postComment(
      RELIC_ID,
      { body: 'round trips', display_name: 'Ada' },
      deps,
      cipher
    );
    const parsed: unknown = JSON.parse(calls[0]?.body ?? '{}');
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('ciphertext' in parsed) ||
      typeof parsed.ciphertext !== 'string'
    ) {
      throw new Error('the post sent no ciphertext');
    }
    const stored = { ciphertext: parsed.ciphertext };
    expect(await cipher.open(stored.ciphertext)).toEqual({
      body: 'round trips',
      display_name: 'Ada',
      anchor: null,
      // The read shape carries the reply pointer now, null when a comment
      // answers nothing, so a caller never has to tell that from a missing
      // field.
      addresses: null,
    });
  });

  test('postComment sends the version being viewed', async () => {
    const calls: Call[] = [];
    const deps = stubDeps(
      () => json({ comment_id: 'c9', author: 'ada@example.com' }),
      calls
    );
    const cipher = commentCipher(await deriveCommentKey(KEY_BYTES));
    await postComment(
      RELIC_ID,
      { body: 'on version 2', display_name: null },
      deps,
      cipher,
      2
    );
    const parsed: unknown = JSON.parse(calls[0]?.body ?? '{}');
    expect(parsed).toEqual(
      expect.objectContaining({
        version: 2,
      })
    );
  });

  test('loadThread extracts the version from each comment record', async () => {
    const cipher = commentCipher(await deriveCommentKey(KEY_BYTES));
    const ct1 = await cipher.seal({ body: 'v1 comment', display_name: null });
    const ct2 = await cipher.seal({
      body: 'unversioned comment',
      display_name: null,
    });
    const calls: Call[] = [];
    const deps = stubDeps(
      () =>
        json([
          {
            comment_id: 'c1',
            author: 'a@b.c',
            created_at: new Date().toISOString(),
            ciphertext: ct1,
            version: 1,
          },
          {
            comment_id: 'c2',
            author: 'a@b.c',
            created_at: new Date().toISOString(),
            ciphertext: ct2,
            version: null,
          },
        ]),
      calls
    );
    const state = await loadThread(RELIC_ID, deps, cipher);
    if (state.kind !== 'ready') throw new Error('thread not ready');
    expect(state.entries[0]?.version).toBe(1);
    expect(state.entries[1]?.version).toBeNull();
  });
});

describe('the magic-link round trip', () => {
  test('the request carries an address and a relic id, and no key', () => {
    const body = authRequestBody('ada@example.com', RELIC_ID);
    expect(body).toEqual({
      email: 'ada@example.com',
      relic_id: RELIC_ID,
    });
    // The one rule in the flow whose failure costs the reader the whole
    // relic: the fragment never goes to a server.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('#');
    expect(serialized).not.toContain(encodeKey(KEY_BYTES));
    expect(Object.keys(body).sort()).toEqual(['email', 'relic_id']);
  });

  test('nothing on the wire to the auth endpoint holds the fragment', async () => {
    const calls: Call[] = [];
    const deps = stubDeps(() => new Response(null, { status: 202 }), calls);
    const result = await requestMagicLink(RELIC_ID, 'ada@example.com', deps);

    expect(result).toEqual({ kind: 'sent' });
    for (const call of calls) {
      expect(call.url).not.toContain('#');
      expect(call.url).not.toContain(encodeKey(KEY_BYTES));
      expect(call.body ?? '').not.toContain(encodeKey(KEY_BYTES));
    }
  });

  test('the fragment survives the navigation, and comments still open', async () => {
    // The whole round trip: the reader is on the relic with a fragment, asks
    // for a link, the tab navigates away to the callback and comes back to
    // `/{id}` with no fragment at all. What has to still be true afterwards
    // is that the comment key derives to the same thing.
    const storage = memoryStorage();
    const before = stubDeps(() => json([]), [], storage);

    // What `load` does after a successful mint, which is what the reader's
    // first visit already did.
    before.keyVault.remember(RELIC_ID, FRAGMENT, Number.POSITIVE_INFINITY);

    const ciphertext = await sealed('written before the round trip');

    // The return leg. The address bar carries no fragment, because reading it
    // stripped it and the callback's redirect could not put it back: the
    // server never had it.
    const recalled = before.keyVault.recall(RELIC_ID);
    expect(recalled).toBe(FRAGMENT);

    const key = parseFragment(recalled ?? '').key;
    const cipher = commentCipher(await deriveCommentKey(key));
    expect((await cipher.open(ciphertext)).body).toBe(
      'written before the round trip'
    );
  });

  test('warns before leaving when this browser is not keeping the key', () => {
    const kept = stubDeps(() => json([]));
    kept.keyVault.remember(RELIC_ID, FRAGMENT, Number.POSITIVE_INFINITY);
    expect(keySurvivesNavigation(RELIC_ID, FRAGMENT, kept)).toBe(true);

    // Private browsing, a quota, a webview: the vault degrades to doing
    // nothing, and following the link in this tab would lose the key for good.
    const refusing: Storage = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error('storage disabled');
      },
    } as Storage;
    const lost = stubDeps(() => json([]), [], refusing);
    lost.keyVault.remember(RELIC_ID, FRAGMENT, Number.POSITIVE_INFINITY);
    expect(keySurvivesNavigation(RELIC_ID, FRAGMENT, lost)).toBe(false);
  });
});

describe('the disclosure, at the point of commenting', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('the taskbar carries the thread, with its count', () => {
    const bar = buildBar(view(), RELIC_ID, {
      onComments: () => {},
      commentCount: 2,
    }) as unknown as ElementStub;

    const comments = withClass(bar, 'action-comments')[0];
    if (comments === undefined) throw new Error('no comment control');
    expect(textOf(comments)).toContain('Comments');
    expect(withClass(comments, 'action-count')[0]?.textContent).toBe('2');
    // A button, never a link to a document fragment: a `#thread` href would
    // write a fragment into the address bar of the one page whose security
    // model is about what lives there.
    expect(comments.tagName).toBe('BUTTON');
  });

  test('a count of zero is not shown before the fetch lands', () => {
    const bar = buildBar(view(), RELIC_ID, {
      onComments: () => {},
    }) as unknown as ElementStub;
    expect(withClass(bar, 'action-count')).toHaveLength(0);
    expect(withClass(bar, 'action-comments')).toHaveLength(1);
  });

  test('a relic with no thread has no control for one', () => {
    const bar = buildBar(view(), RELIC_ID, {}) as unknown as ElementStub;
    expect(withClass(bar, 'action-comments')).toHaveLength(0);
  });

  test('the relic and the conversation are siblings in one row', () => {
    // The regression this defends: a thread that is a child of the stage, or
    // a body sibling after it, is a thread that covers the relic or sits
    // under it. Beside it is the whole point.
    const sidebar = document.createElement('aside') as unknown as ElementStub;
    sidebar.className = 'thread';
    const resizer = document.createElement('div') as unknown as ElementStub;
    resizer.className = 'thread-resizer';
    const tab = document.createElement('button') as unknown as ElementStub;
    tab.className = 'thread-tab';

    const stage = buildStageWrap(
      view(),
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;
    const row = buildRelicRow(
      stage as unknown as HTMLElement,
      sidebar as unknown as HTMLElement,
      resizer as unknown as HTMLElement,
      tab as unknown as HTMLElement
    ) as unknown as ElementStub;

    expect(stage.className).toBe('stage-wrap');
    expect(withClass(stage, 'thread')).toHaveLength(0);
    expect(row.className).toBe('relic-row');
    expect(row.children).toEqual([stage, sidebar, resizer, tab]);
  });

  test('a row without a thread is the relic alone', () => {
    const stage = buildStageWrap(
      view(),
      'https://relik-usercontent.example'
    ) as unknown as ElementStub;
    const row = buildRelicRow(
      stage as unknown as HTMLElement
    ) as unknown as ElementStub;
    expect(row.children).toEqual([stage]);
  });

  test('a dragged width cannot spend the row on the conversation', () => {
    // The divider is the reader's, and the relic is not theirs to lose.
    expect(clampThreadWidth(352, 1440)).toBe(352);
    expect(clampThreadWidth(10, 1440)).toBe(272);
    expect(clampThreadWidth(4000, 1440)).toBe(640);
    // 60% of an 800px window, so the relic keeps the larger share.
    expect(clampThreadWidth(4000, 800)).toBe(480);
    // Narrower than the floor: the floor wins, and the media query takes the
    // row over at this width anyway.
    expect(clampThreadWidth(4000, 320)).toBe(272);
  });

  test('a mark lands on the content, not on the screen', () => {
    // The regression this defends, in both directions it has shipped in: a
    // fraction measured against the visible box moves with the scroll, so the
    // same word gives a different anchor depending on how far the reader had
    // scrolled when they clicked.
    const content = { scrollWidth: 1000, scrollHeight: 3000 };
    const unscrolled = pinFraction(
      { left: 0, top: 0, scrollLeft: 0, scrollTop: 0, ...content },
      300,
      1500
    );
    // The same point on the page, reached after scrolling 1200px down: the
    // click now lands 1200px higher in the viewport.
    const scrolled = pinFraction(
      { left: 0, top: 0, scrollLeft: 0, scrollTop: 1200, ...content },
      300,
      300
    );

    expect(unscrolled).toEqual({ x: 0.3, y: 0.5 });
    expect(scrolled).toEqual(unscrolled);
    // And it paints back onto the same content pixel it was taken from.
    expect(pinOffsets(unscrolled as { x: number; y: number }, content)).toEqual(
      { left: 300, top: 1500 }
    );
  });

  test('a mark outside the relic is not a mark', () => {
    const box = {
      left: 40,
      top: 60,
      scrollLeft: 0,
      scrollTop: 0,
      scrollWidth: 800,
      scrollHeight: 600,
    };
    // Above and left of the stage, which is the taskbar and the gutter.
    expect(pinFraction(box, 10, 10)).toBeUndefined();
    // Past the far edge.
    expect(pinFraction(box, 4000, 100)).toBeUndefined();
    // A stage that has not laid out yet divides by nothing.
    expect(
      pinFraction({ ...box, scrollWidth: 0, scrollHeight: 0 }, 100, 100)
    ).toBeUndefined();
  });

  /**
   * Whether the stylesheet still lays the conversation out beside the relic.
   *
   * The rendered result belongs in a browser and is checked there. What is
   * checkable here is the mechanism, and the mechanism is what regressed
   * twice: a thread taken out of flow covers the relic, and a thread pinned to
   * the bottom sits under it. Both are the same defect wearing different
   * properties, and both are visible in the rule that sizes the sidebar.
   */
  function sidebarLayoutFaults(css: string): readonly string[] {
    const faults: string[] = [];
    const row = /\.relic-row\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const sidebar = /(?<!-)\.thread\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const open = /\.thread\.is-open\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

    if (!/display:\s*flex/.test(row)) faults.push('the row is not a flex row');
    if (/position:\s*(absolute|fixed)/.test(sidebar)) {
      faults.push('the sidebar is out of flow, so it covers the relic');
    }
    if (/\bbottom:/.test(sidebar)) {
      faults.push('the sidebar is pinned to the bottom of the relic');
    }
    if (!/width:\s*var\(--thread-width/.test(sidebar)) {
      faults.push('the sidebar takes no width from the row');
    }
    if (!/display:\s*block/.test(open)) {
      faults.push('the open sidebar never enters the row');
    }
    return faults;
  }

  test('the stylesheet puts the conversation beside the relic', async () => {
    const css = await Bun.file(
      new URL('../src/styles.css', import.meta.url)
    ).text();
    expect(sidebarLayoutFaults(css)).toEqual([]);
  });

  test('that check fails on the layout it exists to catch', () => {
    // The bottom tray that shipped, and was rejected, in the shape it shipped
    // in. A check that cannot name this is not a check.
    const tray = `
      .relic-row { display: block; }
      .thread { position: absolute; right: 0; bottom: 0; left: 0; }
      .thread.is-open { visibility: visible; }
    `;
    expect(sidebarLayoutFaults(tray)).toEqual([
      'the row is not a flex row',
      'the sidebar is out of flow, so it covers the relic',
      'the sidebar is pinned to the bottom of the relic',
      'the sidebar takes no width from the row',
      'the open sidebar never enters the row',
    ]);
  });

  test('a count refresh preserves the sidebar toggle', () => {
    const title = document.createElement('h2') as unknown as ElementStub;
    const toggle = document.createElement('button') as unknown as ElementStub;
    toggle.className = 'thread-toggle';
    title.appendChild(toggle);

    updateThreadToggle(toggle as unknown as HTMLElement, 0);

    expect(title.children[0]).toBe(toggle);
    expect(toggle.className).toBe('thread-toggle');
    expect(toggle.textContent).toBe('No comments');
  });

  test('the version control keeps its slot beside the new one', () => {
    // The accounting is the control, so the addition must not have displaced
    // anything on the floor's must-survive list.
    const bar = buildBar(view({ version: 4, currentVersion: 4 }), RELIC_ID, {
      onComments: () => {},
      commentCount: 1,
      onCompare: () => {},
    }) as unknown as ElementStub;
    const row = textOf(bar);
    expect(row).toContain('Version 4 of 4');
    expect(row).toContain('Copy link');
    expect(row).toContain('Download');
    expect(row).toContain('Report');
    expect(row).toContain('notes.md');
  });
});
describe('comment markdown rendering', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('markdown comment body renders to structure rather than a raw string', () => {
    const entry: CommentEntry = {
      kind: 'open',
      id: 'c1',
      author: 'ada@example.com',
      createdAt: '2026-08-20T09:15:00.000Z',
      body: '# Main Header\n\nA paragraph with **bold** and `code` and [link](https://example.com).',
      displayName: null,
      anchor: null,
    };
    const row = commentRow(entry) as unknown as ElementStub;
    const body = withClass(row, 'comment-body')[0];
    if (!body) throw new Error('no comment body');
    expect(body.innerHTML).toContain('<h1>Main Header</h1>');
    expect(body.innerHTML).toContain('<p>');
    expect(body.innerHTML).toContain('<strong>bold</strong>');
    expect(body.innerHTML).toContain('<code>code</code>');
    expect(body.innerHTML).toContain('<a href="https://example.com"');
    expect(body.innerHTML).not.toContain('# Main Header');
    expect(body.innerHTML).not.toContain('**bold**');
  });
});

describe('hostile input in comment body is neutralized', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('raw HTML tags in comment body are escaped, not rendered as elements', () => {
    const entry: CommentEntry = {
      kind: 'open',
      id: 'c1',
      author: 'evil@example.com',
      createdAt: '2026-08-20T09:15:00.000Z',
      body: '<script>alert("pwned")</script><iframe src="https://evil.example"></iframe>',
      displayName: null,
      anchor: null,
    };
    const row = commentRow(entry) as unknown as ElementStub;
    const body = withClass(row, 'comment-body')[0];
    if (!body) throw new Error('no comment body');
    expect(body.innerHTML).toContain(
      '&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;'
    );
    expect(body.innerHTML).toContain('&lt;iframe');
    expect(body.innerHTML).not.toContain('<script>');
    expect(body.innerHTML).not.toContain('<iframe');
  });

  test('javascript: URLs in markdown links are refused and not rendered as links', () => {
    const entry: CommentEntry = {
      kind: 'open',
      id: 'c1',
      author: 'evil@example.com',
      createdAt: '2026-08-20T09:15:00.000Z',
      body: '[click here](javascript:alert(location.hash))',
      displayName: null,
      anchor: null,
    };
    const row = commentRow(entry) as unknown as ElementStub;
    const body = withClass(row, 'comment-body')[0];
    if (!body) throw new Error('no comment body');
    expect(body.innerHTML).not.toContain('<a href=');
    expect(body.innerHTML).not.toContain('href="javascript:');
    expect(textOf(body)).toContain('click here');
  });

  test('data: URLs in markdown links are refused and not rendered as links', () => {
    const entry: CommentEntry = {
      kind: 'open',
      id: 'c1',
      author: 'evil@example.com',
      createdAt: '2026-08-20T09:15:00.000Z',
      body: '[data link](data:text/html,<script>alert(1)</script>)',
      displayName: null,
      anchor: null,
    };
    const row = commentRow(entry) as unknown as ElementStub;
    const body = withClass(row, 'comment-body')[0];
    if (!body) throw new Error('no comment body');
    expect(body.innerHTML).not.toContain('<a href=');
    expect(body.innerHTML).not.toContain('href="data:');
  });

  test('onerror-style attributes in raw markup are neutralized by escaping', () => {
    const entry: CommentEntry = {
      kind: 'open',
      id: 'c1',
      author: 'evil@example.com',
      createdAt: '2026-08-20T09:15:00.000Z',
      body: '<img src="x" onerror="alert(document.domain)">\n\n<svg/onload=alert(1)>',
      displayName: null,
      anchor: null,
    };
    const row = commentRow(entry) as unknown as ElementStub;
    const body = withClass(row, 'comment-body')[0];
    if (!body) throw new Error('no comment body');
    expect(body.innerHTML).not.toContain('<img');
    expect(body.innerHTML).not.toContain('<svg');
    expect(body.innerHTML).toContain('&lt;img');
    expect(body.innerHTML).toContain('&lt;svg');
  });

  test('markdown images do not emit img tags and do not execute javascript URLs', () => {
    const entry: CommentEntry = {
      kind: 'open',
      id: 'c1',
      author: 'evil@example.com',
      createdAt: '2026-08-20T09:15:00.000Z',
      body: '![alt text](javascript:alert(1))\n\n![safe photo](https://example.com/pic.png)',
      displayName: null,
      anchor: null,
    };
    const row = commentRow(entry) as unknown as ElementStub;
    const body = withClass(row, 'comment-body')[0];
    if (!body) throw new Error('no comment body');
    expect(body.innerHTML).not.toContain('<img');
    expect(body.innerHTML).toContain('safe photo');
    expect(body.innerHTML).not.toContain('href="javascript:');
  });
});

describe('reply threading under target', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('a reply renders under its target comment inside comment-replies', async () => {
    const targetCiphertext = await sealedWithAddresses('Target comment', null);
    const replyCiphertext = await sealedWithAddresses('Reply comment', 'c1');

    const records: CommentRecord[] = [
      {
        comment_id: 'c1',
        author: 'alice@example.com',
        created_at: '2026-08-20T09:15:00.000Z',
        ciphertext: targetCiphertext,
        version: 1,
      },
      {
        comment_id: 'c2',
        author: 'bob@example.com',
        created_at: '2026-08-20T09:20:00.000Z',
        ciphertext: replyCiphertext,
        version: 1,
      },
    ];

    const deps = stubDeps(() => json(records));
    const readyView = view({ version: 1, currentVersion: 1 });
    const thread = buildThread(readyView, RELIC_ID, deps, () => {});
    await thread.ready;

    const threadElement = thread.element as unknown as ElementStub;
    const list = withClass(threadElement, 'thread-list')[0];
    if (!list) throw new Error('no thread list');

    // Only target is a direct child of the top-level list
    const topLevelComments = list.children.filter(
      (c) => c.dataset.commentId === 'c1'
    );
    expect(topLevelComments).toHaveLength(1);
    const orphanDirectComments = list.children.filter(
      (c) => c.dataset.commentId === 'c2'
    );
    expect(orphanDirectComments).toHaveLength(0);

    // Target comment contains the replies list with the reply
    const targetRow = topLevelComments[0];
    if (!targetRow) throw new Error('no target row');
    const repliesLists = withClass(targetRow, 'comment-replies');
    expect(repliesLists).toHaveLength(1);
    const firstRepliesList = repliesLists[0];
    if (!firstRepliesList) throw new Error('no replies list');
    const replyRow = withClass(firstRepliesList, 'comment-reply')[0];
    if (!replyRow) throw new Error('no reply row');
    expect(replyRow.dataset.commentId).toBe('c2');
    expect(textOf(replyRow)).toContain('Reply comment');
  });
});

describe('addressed badges and authority', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('the addressed badge names whether the answer was a reply or an update and which version carried it', async () => {
    // Comment 1 is answered by an update in version 2
    const c1Ciphertext = await sealedWithAddresses('Need this fixed in v2');
    const c2Ciphertext = await sealedWithAddresses(
      'Fixed in this update',
      'c1'
    );

    // Comment 3 is answered by a reply in version 1
    const c3Ciphertext = await sealedWithAddresses('Can you clarify this?');
    const c4Ciphertext = await sealedWithAddresses(
      'Here is clarification',
      'c3'
    );

    const records: CommentRecord[] = [
      {
        comment_id: 'c1',
        author: 'alice@example.com',
        created_at: '2026-08-20T09:00:00.000Z',
        ciphertext: c1Ciphertext,
        version: 1,
      },
      {
        comment_id: 'c2',
        author: PUBLISHER_AUTHOR,
        created_at: '2026-08-20T10:00:00.000Z',
        ciphertext: c2Ciphertext,
        version: 2,
      },
      {
        comment_id: 'c3',
        author: 'charlie@example.com',
        created_at: '2026-08-20T09:10:00.000Z',
        ciphertext: c3Ciphertext,
        version: 1,
      },
      {
        comment_id: 'c4',
        author: 'bob@example.com',
        created_at: '2026-08-20T09:15:00.000Z',
        ciphertext: c4Ciphertext,
        version: 1,
      },
    ];

    const deps = stubDeps(() => json(records));
    // View version 1 on multi-version relic
    const readyView = view({ version: 1, currentVersion: 2 });
    const thread = buildThread(readyView, RELIC_ID, deps, () => {});
    await thread.ready;

    const threadElement = thread.element as unknown as ElementStub;

    // Comment c1 should have an update badge naming version 2
    const c1Row = descendants(threadElement).find(
      (el) => el.dataset.commentId === 'c1'
    );
    if (!c1Row) throw new Error('c1 row not found');
    const c1Badges = withClass(c1Row, 'comment-badge-addressed');
    expect(c1Badges).toHaveLength(1);
    const c1Badge = c1Badges[0];
    if (!c1Badge) throw new Error('no c1 badge');
    expect(textOf(c1Badge)).toBe('Addressed by update in version 2');
    expect(c1Badge.dataset.addressedKind).toBe('update');
    expect(c1Badge.dataset.addressedVersion).toBe('2');
    // Comment c3 should have a reply badge naming version 1
    const c3Row = descendants(threadElement).find(
      (el) => el.dataset.commentId === 'c3'
    );
    if (!c3Row) throw new Error('c3 row not found');
    const c3Badges = withClass(c3Row, 'comment-badge-addressed');
    expect(c3Badges).toHaveLength(1);
    const c3Badge = c3Badges[0];
    if (!c3Badge) throw new Error('no c3 badge');
    expect(textOf(c3Badge)).toBe('Addressed by reply in version 1');
    expect(c3Badge.dataset.addressedKind).toBe('reply');
    expect(c3Badge.dataset.addressedVersion).toBe('1');
  });

  test('an unanswered comment carries no addressed badge', async () => {
    const c1Ciphertext = await sealedWithAddresses('Unanswered comment', null);
    const records: CommentRecord[] = [
      {
        comment_id: 'c1',
        author: 'alice@example.com',
        created_at: '2026-08-20T09:00:00.000Z',
        ciphertext: c1Ciphertext,
        version: 1,
      },
    ];

    const deps = stubDeps(() => json(records));
    const readyView = view({ version: 1, currentVersion: 1 });
    const thread = buildThread(readyView, RELIC_ID, deps, () => {});
    await thread.ready;

    const threadElement = thread.element as unknown as ElementStub;
    const c1Row = descendants(threadElement).find(
      (el) => el.dataset.commentId === 'c1'
    );
    if (!c1Row) throw new Error('c1 row not found');
    expect(withClass(c1Row, 'comment-badge-addressed')).toHaveLength(0);
    expect(textOf(c1Row)).not.toContain('Addressed');
  });

  test('the sealed pointer is authoritative: a clear hint claiming an answer when sealed copy does not is shown unanswered', async () => {
    // Comment A: target
    const cACiphertext = await sealedWithAddresses('Target comment', null);
    // Comment B: sealed copy answers nothing (addresses: null)!
    const cBCiphertext = await sealedWithAddresses('Forged clear hint', null);

    const records: CommentRecord[] = [
      {
        comment_id: 'cA',
        author: 'alice@example.com',
        created_at: '2026-08-20T09:00:00.000Z',
        ciphertext: cACiphertext,
        version: 1,
      },
      {
        comment_id: 'cB',
        author: 'forger@example.com',
        created_at: '2026-08-20T09:05:00.000Z',
        ciphertext: cBCiphertext,
        version: 1,
        // The server claims in the clear that cB addresses cA:
        addresses: 'cA',
      },
    ];

    const deps = stubDeps(() => json(records));
    const readyView = view({ version: 1, currentVersion: 1 });
    const thread = buildThread(readyView, RELIC_ID, deps, () => {});
    await thread.ready;

    const threadElement = thread.element as unknown as ElementStub;

    // cA must remain visibly unanswered
    const cARow = descendants(threadElement).find(
      (el) => el.dataset.commentId === 'cA'
    );
    if (!cARow) throw new Error('cA row not found');
    expect(withClass(cARow, 'comment-badge-addressed')).toHaveLength(0);
    expect(textOf(cARow)).not.toContain('Addressed');

    // And cB must not be threaded under cA because its sealed copy did not address cA
    expect(withClass(cARow, 'comment-replies')).toHaveLength(0);
  });
});

function remark(
  id: string,
  addresses: string | null,
  body = id,
  clearAddresses: string | null = 'forged-clear'
): CommentEntry {
  return {
    kind: 'open',
    id,
    author: 'ada@example.com',
    createdAt: '2026-08-20T09:00:00.000Z',
    body,
    displayName: null,
    anchor: null,
    addresses,
    clearAddresses,
  };
}

function shown(entries: readonly CommentEntry[]): string[] {
  return collectDisplayedEntries(threadEntries(entries)).flatMap((entry) =>
    entry.id === null ? [] : [entry.id]
  );
}

describe('OTIO comment safety', () => {
  async function sealRaw(key: CryptoKey, json: string): Promise<string> {
    const nonce = crypto.getRandomValues(new Uint8Array(COMMENT_NONCE_BYTES));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce.slice().buffer as ArrayBuffer },
        key,
        new TextEncoder().encode(json).slice().buffer as ArrayBuffer
      )
    );
    const framed = new Uint8Array(nonce.length + sealed.length);
    framed.set(nonce, 0);
    framed.set(sealed, nonce.length);
    return Buffer.from(framed).toString('base64url');
  }

  test('one malformed encrypted anchor does not hide the rest of the thread', async () => {
    const key = await deriveCommentKey(KEY_BYTES);
    const cipher = commentCipher(key);
    const hostile = { toString: null, valueOf: null };
    const bad = await sealRaw(
      key,
      JSON.stringify({
        body: 'should not hide the thread',
        display_name: null,
        anchor: {
          kind: 'otio',
          v: hostile,
          relic_version: 1,
          document_sha256: 'ab'.repeat(32),
          timeline_id: 'timeline-1',
          track_id: null,
          range: {
            start_time: { value: 0, rate: 24 },
            duration: { value: 1, rate: 24 },
          },
          snapshot: { timeline: 'Main', track: null, item: null },
        },
      })
    );
    const later = await sealRaw(
      key,
      JSON.stringify({
        body: 'a future mark',
        display_name: null,
        anchor: { kind: 'otio', v: 4 },
      })
    );
    const good = await cipher.seal({
      body: 'still here',
      display_name: null,
    });
    const deps = stubDeps(() =>
      json([
        {
          comment_id: 'bad',
          author: 'attacker@example.com',
          created_at: '2026-08-20T09:00:00.000Z',
          ciphertext: bad,
          addresses: 'good',
        },
        {
          comment_id: 'later',
          author: 'writer@example.com',
          created_at: '2026-08-20T09:01:00.000Z',
          ciphertext: later,
        },
        {
          comment_id: 'good',
          author: 'ada@example.com',
          created_at: '2026-08-20T09:02:00.000Z',
          ciphertext: good,
        },
      ])
    );
    const state = await loadThread(RELIC_ID, deps, cipher);
    if (state.kind !== 'ready') throw new Error('the thread was refused');
    expect(state.entries.map((entry) => entry.id)).toEqual([
      'bad',
      'later',
      'good',
    ]);
    expect(state.entries[0]?.kind).toBe('sealed');
    expect(state.entries[1]?.kind).toBe('open');
    if (state.entries[1]?.kind !== 'open') throw new Error('future row sealed');
    expect(state.entries[1].body).toBe('a future mark');
    expect(state.entries[1].anchor).toEqual({
      kind: 'unsupported',
      declared: 'otio-v4',
    });
    expect(state.entries[2]?.kind).toBe('open');
    if (state.entries[2]?.kind !== 'open') throw new Error('good row lost');
    expect(state.entries[2].body).toBe('still here');
  });

  test('a throw while opening one row does not refuse the thread', async () => {
    const cipher = commentCipher(await deriveCommentKey(KEY_BYTES));
    const good = await cipher.seal({ body: 'kept', display_name: null });
    const throwing = {
      seal: cipher.seal,
      open: async (ciphertext: string) => {
        if (ciphertext === 'boom') throw new TypeError('String');
        return cipher.open(ciphertext);
      },
    };
    const state = await loadThread(
      RELIC_ID,
      stubDeps(() =>
        json([
          {
            comment_id: 'boom',
            author: 'a@b.c',
            created_at: '2026-08-20T09:00:00.000Z',
            ciphertext: 'boom',
          },
          {
            comment_id: 'good',
            author: 'ada@example.com',
            created_at: '2026-08-20T09:01:00.000Z',
            ciphertext: good,
          },
        ])
      ),
      throwing
    );
    if (state.kind !== 'ready') throw new Error('the thread was refused');
    expect(state.entries.map((entry) => [entry.id, entry.kind])).toEqual([
      ['boom', 'sealed'],
      ['good', 'open'],
    ]);
    const opened = await openEntry(
      {
        comment_id: 'good',
        author: 'ada@example.com',
        created_at: '2026-08-20T09:01:00.000Z',
        ciphertext: good,
      },
      cipher
    );
    expect(opened.kind).toBe('open');
  });

  test('a sealed reply loop is shown once, including after an edit', () => {
    const before = threadEntries([
      remark('A', null, 'The root'),
      remark('B', 'A', 'The reply'),
    ]);
    expect(before.map((node) => node.entry.id)).toEqual(['A']);
    expect(before[0]?.replies.map((node) => node.entry.id)).toEqual(['B']);
    expect(before[0]?.recovery).toBeUndefined();

    const edited = threadEntries([
      remark('A', 'B', 'The root, edited'),
      remark('B', 'A', 'The reply'),
    ]);
    expect(
      collectDisplayedEntries(edited)
        .map((entry) => entry.id)
        .sort()
    ).toEqual(['A', 'B']);
    expect(edited).toHaveLength(2);
    for (const node of edited) {
      expect(node.recovery?.kind).toBe('cycle');
      expect(node.recovery?.detail).toBe(THREAD_CYCLE_RECOVERY);
      expect(node.replies).toHaveLength(0);
    }
    expect(
      edited.find((node) => node.entry.id === 'A')?.recovery?.addresses
    ).toBe('B');
    expect(
      edited.find((node) => node.entry.id === 'B')?.recovery?.addresses
    ).toBe('A');
    expect(collectDisplayedEntries(edited)).toHaveLength(2);
  });

  test('a self-cycle and a three-cycle do not recurse or drop a row', () => {
    const self = threadEntries([remark('A', 'A', 'loop')]);
    expect(collectDisplayedEntries(self).map((entry) => entry.id)).toEqual([
      'A',
    ]);
    expect(self[0]?.recovery?.kind).toBe('cycle');
    expect(self[0]?.replies).toHaveLength(0);

    const triple = threadEntries([
      remark('A', 'B', 'one'),
      remark('B', 'C', 'two'),
      remark('C', 'A', 'three'),
    ]);
    expect(
      collectDisplayedEntries(triple)
        .map((entry) => entry.id)
        .sort()
    ).toEqual(['A', 'B', 'C']);
    expect(triple.every((node) => node.recovery?.kind === 'cycle')).toBe(true);
    expect(triple.every((node) => node.replies.length === 0)).toBe(true);
  });

  test('a reply to a hidden row is shown once, and a missing target stays omitted', () => {
    const tree = threadEntries([
      remark('A', null, 'kept'),
      remark('B', 'missing', 'hidden reply'),
      remark('C', 'B', 'grandchild'),
    ]);
    expect(
      collectDisplayedEntries(tree)
        .map((entry) => entry.id)
        .sort()
    ).toEqual(['A', 'C']);
    const orphan = tree.find((node) => node.entry.id === 'C');
    expect(orphan?.recovery).toEqual({
      kind: 'orphan',
      detail: THREAD_ORPHAN_RECOVERY,
      addresses: 'B',
    });
    expect(tree.some((node) => node.entry.id === 'B')).toBe(false);
    expect(tree.find((node) => node.entry.id === 'A')?.replies).toEqual([]);
  });

  test('a clear address hint cannot thread a remark or invent a loop', () => {
    const tree = threadEntries([
      remark('A', null, 'root', 'B'),
      remark('B', null, 'other', 'A'),
    ]);
    expect(tree.map((node) => node.entry.id)).toEqual(['A', 'B']);
    expect(tree.every((node) => node.replies.length === 0)).toBe(true);
    expect(tree.every((node) => node.recovery === undefined)).toBe(true);
  });

  test('an ordinary branch still nests each reply once', () => {
    const tree = threadEntries([
      remark('A', null, 'root'),
      remark('B', 'A', 'left'),
      remark('C', 'A', 'right'),
      remark('D', 'B', 'nested'),
    ]);
    expect(tree.map((node) => node.entry.id)).toEqual(['A']);
    expect(tree[0]?.recovery).toBeUndefined();
    expect(tree[0]?.replies.map((node) => node.entry.id)).toEqual(['B', 'C']);
    expect(tree[0]?.replies[0]?.replies.map((node) => node.entry.id)).toEqual([
      'D',
    ]);
    expect(collectDisplayedEntries(tree).map((entry) => entry.id)).toEqual([
      'A',
      'B',
      'D',
      'C',
    ]);
  });

  test('editing a root to address its reply leaves both visible', async () => {
    const cipher = commentCipher(await deriveCommentKey(KEY_BYTES));
    let rootCiphertext = await cipher.seal({
      body: 'The root',
      display_name: null,
      addresses: null,
    });
    const replyCiphertext = await cipher.seal({
      body: 'The reply',
      display_name: null,
      addresses: 'A',
    });
    const deps = stubDeps((call) => {
      if (call.method === 'PATCH') return json({ ok: true });
      return json([
        {
          comment_id: 'A',
          author: 'attacker@example.com',
          created_at: '2026-08-20T09:00:00.000Z',
          ciphertext: rootCiphertext,
          addresses: 'not-the-sealed-pointer',
        },
        {
          comment_id: 'B',
          author: 'victim@example.com',
          created_at: '2026-08-20T09:05:00.000Z',
          ciphertext: replyCiphertext,
          addresses: 'A',
        },
      ]);
    });
    const first = await loadThread(RELIC_ID, deps, cipher);
    if (first.kind !== 'ready') throw new Error('thread refused');
    expect(shown(first.entries)).toEqual(['A', 'B']);

    const edited = await editComment(
      RELIC_ID,
      'A',
      {
        body: 'The root, edited',
        display_name: null,
        addresses: 'B',
      },
      deps,
      cipher
    );
    expect(edited.kind).toBe('edited');
    rootCiphertext = await cipher.seal({
      body: 'The root, edited',
      display_name: null,
      addresses: 'B',
    });
    const second = await loadThread(RELIC_ID, deps, cipher);
    if (second.kind !== 'ready') throw new Error('reload refused');
    const tree = threadEntries(second.entries);
    expect(shown(second.entries).sort()).toEqual(['A', 'B']);
    expect(tree.every((node) => node.recovery?.kind === 'cycle')).toBe(true);
    expect(
      tree.find((node) => node.entry.id === 'A')?.recovery?.addresses
    ).toBe('B');
    const openedA = second.entries.find((entry) => entry.id === 'A');
    if (openedA?.kind !== 'open') throw new Error('edited root did not open');
    expect(openedA.addresses).toBe('B');
    expect(openedA.clearAddresses).toBe('not-the-sealed-pointer');
  });
});
