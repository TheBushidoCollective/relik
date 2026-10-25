import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  encodeFragment,
  encryptRelic,
  FORMAT_VERSION,
  generateKey,
} from '@relic/format';
import { keyToMnemonic } from '@relic/format/mnemonic';
import { boot, buildBar, renderDashboard, renderDead } from '../src/main.ts';
import {
  buildCommentedDashboardRows,
  buildLocalDashboardRows,
  type CommentedRelic,
} from '../src/relic-rows.ts';
import type { KeyVault, VaultEntry } from '../src/vault.ts';
import {
  type DeadView,
  isKeyEntryRecoverable,
  openRelicWithKey,
  type ReadyView,
  resolveEnteredKey,
  type ViewerDeps,
} from '../src/viewer.ts';

// ---------------------------------------------------------------------------
// Lightweight DOM stub for Bun test environment
// ---------------------------------------------------------------------------

function matchesSelector(node: ElementStub, selector: string): boolean {
  if (selector === '*' || selector.length === 0) return true;
  if (selector.startsWith('.')) {
    const cls = selector.slice(1);
    return node.className.split(/\s+/).includes(cls);
  }
  if (selector.startsWith('#')) {
    return node.id === selector.slice(1);
  }
  if (selector.includes('[') && selector.endsWith(']')) {
    const bracketIndex = selector.indexOf('[');
    const tagPart = selector.slice(0, bracketIndex);
    if (
      tagPart.length > 0 &&
      node.tagName.toLowerCase() !== tagPart.toLowerCase()
    ) {
      return false;
    }
    const inner = selector.slice(bracketIndex + 1, -1);
    if (inner.includes('=')) {
      const [rawAttr, rawVal] = inner.split('=');
      const attr = rawAttr ? rawAttr.trim() : '';
      const val = rawVal ? rawVal.trim().replace(/^["']|["']$/g, '') : '';
      return node.getAttribute(attr) === val;
    }
    return node.attributes.has(inner);
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

class ElementStub {
  readonly tagName: string;
  className = '';
  textContent = '';
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
  rows = 0;
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
    contains: (name: string): boolean =>
      this.className.split(/\s+/).includes(name),
  };
  private readonly eventListeners = new Map<
    string,
    Array<(e: { type: string; preventDefault: () => void }) => void>
  >();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
    if (name === 'href') this.href = value;
    if (name === 'target') this.target = value;
    if (name === 'rel') this.rel = value;
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
    if (name === 'href')
      return this.href || this.attributes.get('href') || null;
    if (name === 'type')
      return this.type || this.attributes.get('type') || null;
    if (name === 'id') return this.id || this.attributes.get('id') || null;
    if (name === 'target')
      return this.target || this.attributes.get('target') || null;
    if (name === 'rel') return this.rel || this.attributes.get('rel') || null;
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: ElementStub): ElementStub {
    this.children.push(child);
    return child;
  }

  append(...kids: Array<ElementStub | string>): void {
    for (const k of kids) {
      if (typeof k === 'string') {
        const textNode = new ElementStub('#text');
        textNode.textContent = k;
        this.children.push(textNode);
      } else {
        this.children.push(k);
      }
    }
  }

  replaceChildren(...kids: Array<ElementStub | string>): void {
    this.children.length = 0;
    this.textContent = '';
    this.append(...kids);
  }

  addEventListener(
    event: string,
    listener: (e: { type: string; preventDefault: () => void }) => void
  ): void {
    const list = this.eventListeners.get(event) ?? [];
    list.push(listener);
    this.eventListeners.set(event, list);
  }

  dispatchEvent(event: { type: string; preventDefault: () => void }): boolean {
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

function makeMockVault(initial: VaultEntry[] = []): KeyVault {
  const map = new Map<string, VaultEntry>();
  for (const entry of initial) {
    map.set(entry.relicId, entry);
  }

  return {
    remember(relicId, fragment, expiresAt, meta) {
      const existing = map.get(relicId);
      map.set(relicId, {
        relicId,
        fragment,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
        title: meta?.title ?? existing?.title,
        lastOpenedAt: Date.now(),
      });
    },
    recall(relicId) {
      return map.get(relicId)?.fragment;
    },
    forget(relicId) {
      map.delete(relicId);
    },
    list() {
      return [...map.values()];
    },
    exportEntries() {
      return JSON.stringify({ version: 1, entries: [...map.values()] });
    },
    importEntries(json: string) {
      try {
        const parsed = JSON.parse(json) as { entries?: VaultEntry[] };
        let added = 0;
        const entries = Array.isArray(parsed) ? parsed : parsed.entries;
        if (Array.isArray(entries)) {
          for (const e of entries) {
            if (
              e &&
              typeof e.relicId === 'string' &&
              typeof e.fragment === 'string'
            ) {
              map.set(e.relicId, e);
              added++;
            }
          }
        }
        return { added, skipped: 0 };
      } catch {
        return { added: 0, skipped: 0 };
      }
    },
  };
}

describe('isKeyEntryRecoverable', () => {
  test('returns true for the three recoverable states', () => {
    expect(isKeyEntryRecoverable('fragment_missing')).toBe(true);
    expect(isKeyEntryRecoverable('fragment_malformed')).toBe(true);
    expect(isKeyEntryRecoverable('decrypt_failed')).toBe(true);
  });

  test('returns false for states where a new key cannot help', () => {
    expect(isKeyEntryRecoverable('unknown_version')).toBe(false);
    expect(isKeyEntryRecoverable('too_large')).toBe(false);
    expect(isKeyEntryRecoverable('removed_after_mint')).toBe(false);
    expect(isKeyEntryRecoverable('truncated_transfer')).toBe(false);
    expect(isKeyEntryRecoverable('empty_envelope')).toBe(false);
    expect(isKeyEntryRecoverable('keyid_present')).toBe(false);
    expect(isKeyEntryRecoverable('version_mismatch')).toBe(false);
    expect(isKeyEntryRecoverable('malformed_container')).toBe(false);
  });
});

describe('buildLocalDashboardRows and buildCommentedDashboardRows', () => {
  test('builds local rows from vault entries, defaulting title to relicId', () => {
    const vault = makeMockVault([
      // Shipped vault entries carry the leading hash. New entries do not.
      // A dashboard link must have exactly one either way: prepending one to
      // this value produced `##r1...`, which browsers interpret as the wrong
      // decryption key.
      {
        relicId: 'r1',
        fragment: '#f1',
        title: 'Named',
        expiresAt: null,
        renderer: 'markdown',
      },
      { relicId: 'r2', fragment: 'f2', expiresAt: null, renderer: 'code' },
    ]);
    const rows = buildLocalDashboardRows(vault);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      relicId: 'r1',
      title: 'Named',
      hasKey: true,
      fragment: 'f1',
      previewKind: 'document',
      previewLabel: 'Document',
    });
    expect(rows[1]).toEqual({
      relicId: 'r2',
      title: 'r2',
      hasKey: true,
      fragment: 'f2',
      previewKind: 'code',
      previewLabel: 'Code',
    });
  });

  test('builds commented rows, distinguishing openable from unopenable', () => {
    const vault = makeMockVault([
      {
        relicId: 'held',
        fragment: '#fheld',
        title: 'Held',
        expiresAt: null,
        renderer: 'markdown',
      },
    ]);
    const commented: CommentedRelic[] = [
      {
        relic_id: 'held',
        title: 'Held in Vault',
        renderer_class: 'markdown',
        version: 1,
        published_at: '2026-09-01T00:00:00Z',
        expires_at: null,
        last_comment_at: '2026-09-02T00:00:00Z',
      },
      {
        relic_id: 'missing',
        title: 'Missing Key',
        renderer_class: 'markdown',
        version: 1,
        published_at: '2026-09-01T00:00:00Z',
        expires_at: null,
        last_comment_at: '2026-09-02T00:00:00Z',
      },
    ];

    const rows = buildCommentedDashboardRows(commented, vault);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.hasKey).toBe(true);
    expect(rows[0]?.fragment).toBe('fheld');
    expect(rows[0]?.previewKind).toBe('document');
    expect(rows[0]?.previewLabel).toBe('Document');
    expect(rows[1]?.hasKey).toBe(false);
    expect(rows[1]?.fragment).toBeUndefined();
  });
});

describe('resolveEnteredKey', () => {
  test('resolves a bare fragment without leading #', async () => {
    const key = generateKey();
    const fragment = encodeFragment(key);
    const result = await resolveEnteredKey(fragment);
    expect(result.kind).toBe('key');
    if (result.kind === 'key') {
      expect(result.resolved.key).toEqual(key);
      expect(result.resolved.version).toBe(FORMAT_VERSION);
      expect(result.resolved.fragment).toBe(fragment);
    }
  });

  test('resolves a bare fragment with leading #', async () => {
    const key = generateKey();
    const fragment = encodeFragment(key);
    const result = await resolveEnteredKey(`#${fragment}`);
    expect(result.kind).toBe('key');
    if (result.kind === 'key') {
      expect(result.resolved.key).toEqual(key);
      expect(result.resolved.fragment).toBe(fragment);
    }
  });

  test('resolves a full share URL containing a fragment', async () => {
    const key = generateKey();
    const fragment = encodeFragment(key);
    const url = `https://relik.link/r/abc123xyz#${fragment}`;
    const result = await resolveEnteredKey(url);
    expect(result.kind).toBe('key');
    if (result.kind === 'key') {
      expect(result.resolved.key).toEqual(key);
      expect(result.resolved.fragment).toBe(fragment);
    }
  });

  test('resolves a valid mnemonic phrase', async () => {
    const key = generateKey();
    const words = keyToMnemonic(key);
    const phrase = words.join(' ');
    const result = await resolveEnteredKey(phrase);
    expect(result.kind).toBe('key');
    if (result.kind === 'key') {
      expect(result.resolved.key).toEqual(key);
      expect(result.resolved.fragment).toBe(encodeFragment(key));
    }
  });

  test('resolves a mnemonic phrase with dictation artifacts (mixed case, extra spaces)', async () => {
    const key = generateKey();
    const words = keyToMnemonic(key);
    const messyPhrase = `  ${words[0]?.toUpperCase()}   ${words.slice(1).join('  \n ')}  `;
    const result = await resolveEnteredKey(messyPhrase);
    expect(result.kind).toBe('key');
    if (result.kind === 'key') {
      expect(result.resolved.key).toEqual(key);
    }
  });

  test('rejects a malformed fragment as invalid', async () => {
    const result = await resolveEnteredKey('r1tooshort');
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.message).toBe('That is not a key.');
    }
  });

  test('rejects a share URL with a malformed fragment', async () => {
    const result = await resolveEnteredKey(
      'https://relik.link/r/abc#r1tooshort'
    );
    expect(result.kind).toBe('invalid');
  });

  test('rejects random strings as invalid', async () => {
    const result = await resolveEnteredKey('not-a-valid-key-at-all');
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid') {
      expect(result.message).toBe('That is not a key.');
    }
  });

  test('rejects a mnemonic phrase with unknown words', async () => {
    const key = generateKey();
    const words = keyToMnemonic(key);
    const badWords = [...words];
    badWords[0] = 'xyzqwerty';
    const result = await resolveEnteredKey(badWords.join(' '));
    expect(result.kind).toBe('invalid');
  });
});

describe('renderDead and Key Entry Form (DOM)', () => {
  let rootBody: ElementStub;

  beforeEach(() => {
    rootBody = new ElementStub('body');
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
      location: { reload: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  test('renders key entry form on fragment_missing', () => {
    const dead: DeadView = {
      headline: 'This link is missing its key',
      detail: 'Open the original link again.',
      action: 'reopen-original-link',
      code: 'fragment_missing',
    };
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: globalThis.fetch,
      keyVault: makeMockVault(),
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relic.example/r1',
    };

    renderDead(dead, 'relic123', 'https://usercontent.example', deps);
    const form = rootBody.querySelector('.key-entry-form');
    expect(form).not.toBeNull();
    const input = rootBody.querySelector('.key-entry-input');
    expect(input).not.toBeNull();
  });

  test('renders key entry form on fragment_malformed', () => {
    const dead: DeadView = {
      headline: 'This link looks truncated',
      detail: 'Ask the sender to send it again.',
      action: 'reopen-original-link',
      code: 'fragment_malformed',
    };
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: globalThis.fetch,
      keyVault: makeMockVault(),
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relic.example/r1',
    };

    renderDead(dead, 'relic123', 'https://usercontent.example', deps);
    const form = rootBody.querySelector('.key-entry-form');
    expect(form).not.toBeNull();
  });

  test('renders key entry form on decrypt_failed', () => {
    const dead: DeadView = {
      headline: 'This relic could not be opened',
      detail: 'The file did not decrypt.',
      action: 'reopen-original-link',
      code: 'decrypt_failed',
    };
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: globalThis.fetch,
      keyVault: makeMockVault(),
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relic.example/r1',
    };

    renderDead(dead, 'relic123', 'https://usercontent.example', deps);
    const form = rootBody.querySelector('.key-entry-form');
    expect(form).not.toBeNull();
  });

  test('does NOT render key entry form on unknown_version or other unrecoverable states', () => {
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: globalThis.fetch,
      keyVault: makeMockVault(),
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relic.example/r1',
    };

    renderDead(
      {
        headline: 'Newer format',
        detail: 'Cannot read.',
        action: 'none',
        code: 'unknown_version',
      },
      'relic123',
      'https://usercontent.example',
      deps
    );
    expect(rootBody.querySelector('.key-entry-form')).toBeNull();

    renderDead(
      {
        headline: 'Too large',
        detail: 'Oversize.',
        action: 'none',
        code: 'too_large',
      },
      'relic123',
      'https://usercontent.example',
      deps
    );
    expect(rootBody.querySelector('.key-entry-form')).toBeNull();

    renderDead(
      {
        headline: 'Removed',
        detail: 'Taken down.',
        action: 'report',
        code: 'removed_after_mint',
      },
      'relic123',
      'https://usercontent.example',
      deps
    );
    expect(rootBody.querySelector('.key-entry-form')).toBeNull();
  });

  test('submitting a malformed key shows "That is not a key." and preserves input value', async () => {
    const dead: DeadView = {
      headline: 'This link is missing its key',
      detail: 'Open the original link again.',
      action: 'reopen-original-link',
      code: 'fragment_missing',
    };
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: globalThis.fetch,
      keyVault: makeMockVault(),
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relic.example/r1',
    };

    renderDead(dead, 'relic123', 'https://usercontent.example', deps);
    const input = rootBody.querySelector('.key-entry-input') as ElementStub;
    const form = rootBody.querySelector('.key-entry-form') as ElementStub;
    const feedback = rootBody.querySelector(
      '.key-entry-feedback'
    ) as ElementStub;

    input.value = 'r1badshort';
    form.submit();

    await waitUntil(() => feedback.textContent !== '');

    expect(feedback.textContent).toBe('That is not a key.');
    expect(input.value).toBe('r1badshort');
  });

  test('submitting a well-formed but wrong key shows "That key does not open this relic."', async () => {
    const dead: DeadView = {
      headline: 'This relic could not be opened',
      detail: 'The file did not decrypt.',
      action: 'reopen-original-link',
      code: 'decrypt_failed',
    };

    const correctKey = generateKey();
    const wrongKey = generateKey();
    const wrongFragment = encodeFragment(wrongKey);

    const content = new TextEncoder().encode('# Secret relic content');
    const ciphertext = await encryptRelic({
      content,
      filename: 'note.md',
      mimetype: 'text/markdown',
      key: correctKey,
    });

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: globalThis.fetch,
      keyVault: makeMockVault(),
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relic.example/r1',
    };

    const cachedCiphertext = {
      bytes: ciphertext,
      mint: {
        url: 'https://storage.example/blob',
        url_expires_at: '2026-09-16T00:00:00Z',
        relic_expires_at: null,
        object_length: ciphertext.length,
        object_crc32c: '0',
        mints_remaining: 5,
        version: 1,
        current_version: 1,
      },
    };

    renderDead(
      dead,
      'relic123',
      'https://usercontent.example',
      deps,
      cachedCiphertext
    );

    const input = rootBody.querySelector('.key-entry-input') as ElementStub;
    const form = rootBody.querySelector('.key-entry-form') as ElementStub;
    const feedback = rootBody.querySelector(
      '.key-entry-feedback'
    ) as ElementStub;

    input.value = wrongFragment;
    form.submit();

    await waitUntil(() => feedback.textContent !== '');

    expect(feedback.textContent).toBe('That key does not open this relic.');
    expect(input.value).toBe(wrongFragment);
  });

  test('submitting a correct fragment opens the relic in place and saves to vault', async () => {
    const dead: DeadView = {
      headline: 'This link is missing its key',
      detail: 'Open the original link again.',
      action: 'reopen-original-link',
      code: 'fragment_missing',
    };

    const correctKey = generateKey();
    const correctFragment = encodeFragment(correctKey);

    const content = new TextEncoder().encode('# Hello world');
    const ciphertext = await encryptRelic({
      content,
      filename: 'hello.md',
      mimetype: 'text/markdown',
      key: correctKey,
    });

    const vault = makeMockVault();
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: globalThis.fetch,
      keyVault: vault,
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relic.example/r1',
    };

    const cachedCiphertext = {
      bytes: ciphertext,
      mint: {
        url: 'https://storage.example/blob',
        url_expires_at: '2026-09-16T00:00:00Z',
        relic_expires_at: null,
        object_length: ciphertext.length,
        object_crc32c: '0',
        mints_remaining: 5,
        version: 1,
        current_version: 1,
      },
    };

    renderDead(
      dead,
      'relic123',
      'https://usercontent.example',
      deps,
      cachedCiphertext
    );

    const input = rootBody.querySelector('.key-entry-input') as ElementStub;
    const form = rootBody.querySelector('.key-entry-form') as ElementStub;

    input.value = correctFragment;
    form.submit();

    await waitUntil(() => rootBody.querySelector('.stage-dead') === null);

    // Decryption succeeded in place: dead card is gone and document is rendered
    expect(rootBody.querySelector('.stage-dead')).toBeNull();
    expect(rootBody.querySelector('.doc')).not.toBeNull();
    expect(vault.recall('relic123')).toBe(correctFragment);
  });

  test('submitting a correct mnemonic opens the relic in place and saves to vault', async () => {
    const dead: DeadView = {
      headline: 'This relic could not be opened',
      detail: 'The file did not decrypt.',
      action: 'reopen-original-link',
      code: 'decrypt_failed',
    };

    const correctKey = generateKey();
    const mnemonicWords = keyToMnemonic(correctKey);
    const phrase = mnemonicWords.join(' ');

    const content = new TextEncoder().encode('# Spoken words unlock this');
    const ciphertext = await encryptRelic({
      content,
      filename: 'spoken.md',
      mimetype: 'text/markdown',
      key: correctKey,
    });

    const vault = makeMockVault();
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: globalThis.fetch,
      keyVault: vault,
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relic.example/r1',
    };

    const cachedCiphertext = {
      bytes: ciphertext,
      mint: {
        url: 'https://storage.example/blob',
        url_expires_at: '2026-09-16T00:00:00Z',
        relic_expires_at: null,
        object_length: ciphertext.length,
        object_crc32c: '0',
        mints_remaining: 5,
        version: 1,
        current_version: 1,
      },
    };

    renderDead(
      dead,
      'relic123',
      'https://usercontent.example',
      deps,
      cachedCiphertext
    );

    const input = rootBody.querySelector('.key-entry-input') as ElementStub;
    const form = rootBody.querySelector('.key-entry-form') as ElementStub;

    input.value = phrase;
    form.submit();

    await waitUntil(() => rootBody.querySelector('.stage-dead') === null);

    expect(rootBody.querySelector('.stage-dead')).toBeNull();
    expect(rootBody.querySelector('.doc')).not.toBeNull();
    expect(vault.recall('relic123')).toBe(encodeFragment(correctKey));
  });
});

describe('Network security: no key material sent in any request', () => {
  test('asserts against fetch stub that no request carries fragment or mnemonic', async () => {
    // Established BIP-39 vector avoids accidental matches with fixed routing words.
    const correctKey = new Uint8Array(16);
    const fragment = encodeFragment(correctKey);
    const mnemonicWords = keyToMnemonic(correctKey);
    const expectedMnemonicWords = [
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'about',
    ];

    expect(mnemonicWords).toEqual(expectedMnemonicWords);

    const content = new TextEncoder().encode('# Document');
    const ciphertext = await encryptRelic({
      content,
      filename: 'doc.md',
      mimetype: 'text/markdown',
      key: correctKey,
    });

    const recordedCalls: Array<{ url: string; method: string; body?: string }> =
      [];

    const fetchStub = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : undefined;
      recordedCalls.push({
        url,
        method,
        ...(body !== undefined ? { body } : {}),
      });
      if (url.endsWith('/mint')) {
        return new Response(
          JSON.stringify({
            url: 'https://storage.example/blob',
            url_expires_at: '2026-09-16T00:00:00Z',
            relic_expires_at: null,
            object_length: ciphertext.length,
            object_crc32c: '0',
            mints_remaining: 5,
            version: 1,
            current_version: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url === 'https://storage.example/blob') {
        return new Response(ciphertext as unknown as BodyInit, { status: 200 });
      }

      return new Response(null, { status: 404 });
    };

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: fetchStub as unknown as typeof globalThis.fetch,
      keyVault: makeMockVault(),
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relic.example/r1',
    };

    const resultFragment = await openRelicWithKey(
      'relic_test_1',
      fragment,
      deps
    );
    expect(resultFragment.kind).toBe('ready');

    const resultMnemonic = await openRelicWithKey(
      'relic_test_2',
      mnemonicWords.join(' '),
      deps
    );
    expect(resultMnemonic.kind).toBe('ready');

    expect(recordedCalls.length).toBeGreaterThan(0);
    for (const call of recordedCalls) {
      expect(call.url).not.toContain(fragment);
      expect(call.body ?? '').not.toContain(fragment);

      // Single words are matched as URL tokens, not substrings: the fixed
      // route text ('relics', 'example', 'mint') can contain a short word by
      // chance and fail a correct client. A leaked phrase is still caught,
      // whole or with its separators dropped or encoded.
      const urlTokens = call.url.split(/[/.:?&=#_-]+/);
      const decodedUrl = decodeURIComponent(call.url.replace(/\+/g, ' '));
      for (const joined of [' ', '', '-', '_'].map((sep) =>
        mnemonicWords.join(sep)
      )) {
        expect(decodedUrl).not.toContain(joined);
      }
      for (const word of mnemonicWords) {
        expect(urlTokens).not.toContain(word);
        expect(call.body ?? '').not.toContain(word);
      }
    }
  });
});

describe('Dashboard rendering (DOM)', () => {
  let rootBody: ElementStub;

  beforeEach(() => {
    rootBody = new ElementStub('body');
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
      location: { reload: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { document?: unknown }).document;
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  test('renders vault rows signed out with title, link with fragment in href, and forget button', async () => {
    const key1 = generateKey();
    const frag1 = encodeFragment(key1);
    const key2 = generateKey();
    const frag2 = encodeFragment(key2);

    const vault = makeMockVault([
      {
        relicId: 'rel1',
        fragment: frag1,
        title: 'Project Roadmap',
        expiresAt: null,
        renderer: 'markdown',
      },
      {
        relicId: 'rel2',
        fragment: frag2,
        expiresAt: null,
        renderer: 'code',
      },
    ]);

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/auth/session')) {
          return new Response(JSON.stringify({ email: null }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      }) as unknown as typeof globalThis.fetch,
      keyVault: vault,
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relic.example/dashboard',
    };

    await renderDashboard(deps);

    const localSection = rootBody.querySelector('.local-relics-section');
    expect(localSection).not.toBeNull();

    const items = rootBody.querySelectorAll('.dashboard-relic-item');
    expect(items.length).toBe(2);

    const firstLink = items[0]?.querySelector('.relic-link') as ElementStub;
    expect(firstLink.textContent).toBe('Project Roadmap');
    expect(firstLink.href).toBe(`/rel1#${frag1}`);

    const secondLink = items[1]?.querySelector('.relic-link') as ElementStub;
    expect(secondLink.textContent).toBe('rel2');
    expect(secondLink.href).toBe(`/rel2#${frag2}`);

    const firstThumbnail = items[0]?.querySelector('.relic-thumbnail');
    expect(firstThumbnail?.getAttribute('aria-label')).toBe('Document relic');
    expect(firstThumbnail?.className).toContain('relic-thumbnail-document');
    const secondThumbnail = items[1]?.querySelector('.relic-thumbnail');
    expect(secondThumbnail?.getAttribute('aria-label')).toBe('Code relic');
    expect(secondThumbnail?.className).toContain('relic-thumbnail-code');

    for (const item of items) {
      const allText = item.children.map((c) => c.textContent).join(' ');
      expect(allText).not.toContain(frag1);
      expect(allText).not.toContain(frag2);
    }

    const authSection = rootBody.querySelector('.dashboard-auth-section');
    expect(authSection).not.toBeNull();
    const emailInput = authSection?.querySelector('input[type="email"]');
    expect(emailInput).not.toBeNull();

    const forgetBtn = items[0]?.querySelector('.action-forget') as ElementStub;
    expect(forgetBtn).not.toBeNull();
    forgetBtn.click();
    expect(vault.recall('rel1')).toBeUndefined();
  });

  test('renders commented-on rows signed in, marking row unopenable when vault lacks key', async () => {
    const keyKnown = generateKey();
    const fragKnown = encodeFragment(keyKnown);

    const vault = makeMockVault([
      {
        relicId: 'known_relic',
        fragment: fragKnown,
        title: 'Known Relic',
        expiresAt: null,
      },
    ]);

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/auth/session')) {
          return new Response(
            JSON.stringify({ email: 'collaborator@example.com' }),
            {
              status: 200,
            }
          );
        }
        if (url.endsWith('/api/auth/relics')) {
          return new Response(
            JSON.stringify({
              relics: [
                {
                  relic_id: 'known_relic',
                  title: 'Known Relic',
                  renderer_class: 'markdown',
                  version: 1,
                  published_at: '2026-09-01T00:00:00Z',
                  expires_at: null,
                  last_comment_at: '2026-09-02T00:00:00Z',
                },
                {
                  relic_id: 'unknown_key_relic',
                  title: 'A Relic I Commented On Elsewhere',
                  renderer_class: 'markdown',
                  version: 1,
                  published_at: '2026-09-01T00:00:00Z',
                  expires_at: null,
                  last_comment_at: '2026-09-03T00:00:00Z',
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(null, { status: 404 });
      }) as unknown as typeof globalThis.fetch,
      keyVault: vault,
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relic.example/dashboard',
    };

    await renderDashboard(deps);

    await waitUntil(() => rootBody.querySelector('.relic-openable') !== null);

    const commentedSection = rootBody.querySelector(
      '.commented-relics-section'
    );
    expect(commentedSection).not.toBeNull();

    const openableItem = rootBody.querySelector(
      '.relic-openable'
    ) as ElementStub;
    expect(openableItem).not.toBeNull();
    const openableLink = openableItem.querySelector('.relic-link');
    expect(openableLink?.getAttribute('href')).toBe(
      `/known_relic#${fragKnown}`
    );

    const unopenableItem = rootBody.querySelector(
      '.relic-unopenable'
    ) as ElementStub;
    expect(unopenableItem).not.toBeNull();

    expect(unopenableItem.querySelector('.relic-link')).toBeNull();

    const note = unopenableItem.querySelector('.relic-unopenable-note');
    expect(note?.textContent).toContain(
      'This browser does not hold the key for this relic. The original link is the only way in.'
    );
  });

  test('boot branches to renderDashboard when data-view is "dashboard"', async () => {
    const root = new ElementStub('div');
    root.id = 'relic-root';
    root.setAttribute('data-view', 'dashboard');
    rootBody.appendChild(root);

    const vault = makeMockVault();
    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () =>
        new Response(JSON.stringify({ email: null }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch,
      keyVault: vault,
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relic.example/dashboard',
    };

    await boot(root as unknown as HTMLElement, deps);
    expect(rootBody.querySelector('.stage-dashboard')).not.toBeNull();
  });

  test('dashboard renders all key management controls (export, import, forget)', async () => {
    const key1 = generateKey();
    const frag1 = encodeFragment(key1);
    const vault = makeMockVault([
      {
        relicId: 'r_export',
        fragment: frag1,
        title: 'Export Test Relic',
        expiresAt: null,
      },
    ]);

    const deps: ViewerDeps = {
      serviceOrigin: 'https://relic.example',
      fetch: (async () =>
        new Response(JSON.stringify({ email: null }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch,
      keyVault: vault,
      takeFragment: () => '',
      stripFragment: () => {},
      locationHref: 'https://relic.example/dashboard',
    };

    await renderDashboard(deps);

    // Export keys button
    const exportBtn = rootBody.querySelector(
      '.vault-export-btn'
    ) as ElementStub;
    expect(exportBtn).not.toBeNull();
    expect(exportBtn.textContent).toBe('Export keys');

    // Import keys button and toggle panel
    const importToggleBtn = rootBody.querySelector(
      '.vault-import-toggle-btn'
    ) as ElementStub;
    expect(importToggleBtn).not.toBeNull();
    expect(importToggleBtn.textContent).toBe('Import keys');

    const importPanel = rootBody.querySelector(
      '.vault-import-panel'
    ) as ElementStub;
    expect(importPanel).not.toBeNull();
    expect(importPanel.hidden).toBe(true);

    importToggleBtn.click();
    expect(importPanel.hidden).toBe(false);

    const importSubmitBtn = rootBody.querySelector(
      '.vault-import-submit-btn'
    ) as ElementStub;
    expect(importSubmitBtn).not.toBeNull();

    // Forget button on relic row
    const forgetBtn = rootBody.querySelector('.action-forget') as ElementStub;
    expect(forgetBtn).not.toBeNull();
    expect(forgetBtn.textContent).toBe('Forget');

    // Header bar on dashboard uses consistent accession styling
    const bar = rootBody.querySelector('.bar') as ElementStub;
    expect(bar).not.toBeNull();
    const filename = bar.querySelector('.filename') as ElementStub;
    expect(filename?.textContent).toBe('Dashboard');
    const accession = bar.querySelector('.accession') as ElementStub;
    expect(accession?.textContent).toBe('CATALOGUE');
  });

  test('the bar carries the relics link targeting a new tab with rel="noopener"', () => {
    const dummyView: ReadyView = {
      filename: 'test.md',
      declaredMimetype: 'text/markdown',
      content: new TextEncoder().encode('# Test'),
      route: 'markdown',
      downgradeNotice: undefined,
      shareUrl: 'https://relic.example/r1#key',
      version: 1,
      currentVersion: 1,
      versionDigest: '0'.repeat(64),
    };
    const bar = buildBar(dummyView, 'relic123') as unknown as ElementStub;
    const relicsLink = bar.querySelector('.action-relics');
    expect(relicsLink).not.toBeNull();
    expect(relicsLink?.tagName).toBe('A');
    expect(relicsLink?.href).toBe('/dashboard');
    expect(relicsLink?.getAttribute('target')).toBe('_blank');
    expect(relicsLink?.getAttribute('rel')).toBe('noopener');

    const ariaLabel = relicsLink?.getAttribute('aria-label') ?? '';
    const visible = (relicsLink?.children ?? [])
      .map((c) => c.textContent)
      .join('')
      .trim();
    expect(visible).toBe('Relics');
    expect(ariaLabel).toContain(visible ?? '');
  });
});
