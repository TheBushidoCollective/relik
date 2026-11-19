import { describe, expect, test } from 'bun:test';
import {
  type ConfirmKind,
  CONFIRM_PREFS_CAP,
  CONFIRM_PREFS_KEY,
  type ConfirmPref,
  createConfirmPrefs,
  parseConfirmPrefs,
  readerConfirmed,
} from '../src/confirm-prefs.ts';

/** A storage that holds values and can be made to refuse every write. */
class MemoryStorage {
  readonly #items = new Map<string, string>();
  refuse = false;

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.refuse) throw new Error('storage refused the write');
    this.#items.set(key, value);
  }

  removeItem(key: string): void {
    if (this.refuse) throw new Error('storage refused the write');
    this.#items.delete(key);
  }

  seed(value: string): void {
    this.#items.set(CONFIRM_PREFS_KEY, value);
  }

  raw(): string | undefined {
    return this.#items.get(CONFIRM_PREFS_KEY);
  }
}

/**
 * A proof for a trusted event. Only the browser sets isTrusted, so a test's
 * stand-in object is the closest honest test of the rule that the flag gates it.
 */
function trustedProof() {
  const proof = readerConfirmed({ isTrusted: true } as Event);
  if (proof === undefined) throw new Error('a trusted event must confirm');
  return proof;
}

function asPref(value: unknown): ConfirmPref {
  return value as ConfirmPref;
}

describe('reader confirmations', () => {
  test('a script-made event cannot make a reader confirmation', () => {
    expect(readerConfirmed({ isTrusted: false } as Event)).toBeUndefined();
  });

  test('remember refuses a missing or forged proof', () => {
    const store = createConfirmPrefs(undefined);
    const pref = { kind: 'link', relicId: 'r1', version: 1 } as ConfirmPref;
    expect(store.remember(undefined, pref)).toBe(false);
    expect(store.remember({} as never, pref)).toBe(false);
    expect(store.has('link', 'r1', 1)).toBe(false);
  });

  test('a link choice is honoured for the same relic and version only', () => {
    const store = createConfirmPrefs(undefined);
    expect(
      store.remember(trustedProof(), {
        kind: 'link',
        relicId: 'r1',
        version: 3,
      })
    ).toBe(true);
    expect(store.has('link', 'r1', 3)).toBe(true);
    expect(store.has('link', 'r1', 4)).toBe(false);
    expect(store.has('link', 'r2', 3)).toBe(false);
  });

  test('a delete-comment choice spans versions', () => {
    const store = createConfirmPrefs(undefined);
    store.remember(trustedProof(), { kind: 'delete-comment', relicId: 'r1' });
    expect(store.has('delete-comment', 'r1')).toBe(true);
    expect(store.has('delete-comment', 'r1', 9)).toBe(true);
  });

  test('unknown kinds are refused, so private delete can never be skipped', () => {
    const store = createConfirmPrefs(undefined);
    const bad = asPref({ kind: 'private-delete', relicId: 'r1' });
    expect(store.remember(trustedProof(), bad)).toBe(false);
    expect(store.has('private-delete' as ConfirmKind, 'r1')).toBe(false);
  });

  test('a versioned kind without a version is refused', () => {
    const store = createConfirmPrefs(undefined);
    const bad = asPref({ kind: 'large-open', relicId: 'r1' });
    expect(store.remember(trustedProof(), bad)).toBe(false);
  });

  test('a choice survives a reload in the same browser', () => {
    const storage = new MemoryStorage();
    const first = createConfirmPrefs(storage as unknown as Storage);
    first.remember(trustedProof(), { kind: 'link', relicId: 'r1', version: 2 });
    const second = createConfirmPrefs(storage as unknown as Storage);
    expect(second.persistent).toBe(true);
    expect(second.has('link', 'r1', 2)).toBe(true);
    expect(storage.raw()).toContain('"relicId":"r1"');
  });

  test('storage that refuses writes keeps choices in memory only', () => {
    const storage = new MemoryStorage();
    storage.refuse = true;
    const store = createConfirmPrefs(storage as unknown as Storage);
    expect(store.persistent).toBe(false);
    expect(
      store.remember(trustedProof(), {
        kind: 'link',
        relicId: 'r1',
        version: 1,
      })
    ).toBe(true);
    expect(store.has('link', 'r1', 1)).toBe(true);
    expect(storage.raw()).toBeUndefined();
    const later = createConfirmPrefs(storage as unknown as Storage);
    expect(later.has('link', 'r1', 1)).toBe(false);
  });

  test('malformed stored input is ignored', () => {
    const storage = new MemoryStorage();
    storage.seed('{not json');
    expect(
      createConfirmPrefs(storage as unknown as Storage).list('r1')
    ).toEqual([]);
    storage.seed('{"kind":"link","relicId":"r1","version":1}');
    expect(
      createConfirmPrefs(storage as unknown as Storage).list('r1')
    ).toEqual([]);
    storage.seed(
      JSON.stringify([
        { kind: 'zap', relicId: 'r1' },
        { kind: 'link', relicId: 'r1' },
        { kind: 'delete-comment', relicId: 'r1', version: 1 },
        { kind: 'link', relicId: 'r1', version: 1, extra: true },
        { kind: 'link', relicId: 'r1', version: 1 },
      ])
    );
    const store = createConfirmPrefs(storage as unknown as Storage);
    expect(store.list('r1')).toEqual([
      { kind: 'link', relicId: 'r1', version: 1 },
    ]);
  });

  test('parsing keeps the newest entries when the cap is exceeded', () => {
    const many = Array.from({ length: CONFIRM_PREFS_CAP + 100 }, (_, i) => ({
      kind: 'delete-comment',
      relicId: `r${i}`,
    }));
    const kept = parseConfirmPrefs(JSON.stringify(many));
    expect(kept.length).toBe(CONFIRM_PREFS_CAP);
    expect(kept[0]?.relicId).toBe('r100');
    expect(kept[kept.length - 1]?.relicId).toBe(`r${CONFIRM_PREFS_CAP + 99}`);
  });

  test('remembering past the cap evicts the oldest choice', () => {
    const store = createConfirmPrefs(undefined);
    const proof = trustedProof();
    for (let i = 0; i <= CONFIRM_PREFS_CAP; i++) {
      store.remember(proof, { kind: 'delete-comment', relicId: `r${i}` });
    }
    expect(store.has('delete-comment', 'r0')).toBe(false);
    expect(store.has('delete-comment', `r${CONFIRM_PREFS_CAP}`)).toBe(true);
  });

  test('forget clears one choice and clearRelic clears a relic', () => {
    const store = createConfirmPrefs(undefined);
    const proof = trustedProof();
    store.remember(proof, { kind: 'link', relicId: 'r1', version: 1 });
    store.remember(proof, { kind: 'link', relicId: 'r1', version: 2 });
    store.remember(proof, { kind: 'delete-comment', relicId: 'r1' });
    store.forget({ kind: 'link', relicId: 'r1', version: 1 });
    expect(store.has('link', 'r1', 1)).toBe(false);
    expect(store.has('link', 'r1', 2)).toBe(true);
    expect(store.list('r1').length).toBe(2);
    store.clearRelic('r1');
    expect(store.list('r1')).toEqual([]);
  });
});
