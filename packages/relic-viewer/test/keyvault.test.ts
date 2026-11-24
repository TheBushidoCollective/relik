import { describe, expect, test } from 'bun:test';
import { localStorageKeyVault } from '../src/main.ts';

/** Enough of the Storage interface for the vault, with no browser involved. */
export function keyvaultMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
  } as Storage;
}

/** The same helper under the name this file's older tests were written to. */
const memoryStorage = keyvaultMemoryStorage;

/** Storage that refuses every write, as a full quota or blocked site data does. */
function refusingStorage(): Storage {
  const base = memoryStorage();
  return {
    ...base,
    get length() {
      return base.length;
    },
    key: (i: number) => base.key(i),
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('SecurityError');
    },
  } as Storage;
}

const HOUR = 3_600_000;

describe('localStorageKeyVault', () => {
  test('a remembered key comes back, which is the whole point', () => {
    const now = () => 1000;
    const vault = localStorageKeyVault(memoryStorage(), now);

    vault.remember('relic1', '#r1abc', 1000 + HOUR);
    expect(vault.recall('relic1')).toBe('#r1abc');
  });

  test('an unknown relik recalls nothing', () => {
    const vault = localStorageKeyVault(memoryStorage(), () => 1000);
    expect(vault.recall('never-seen')).toBeUndefined();
  });

  test('keys are scoped per relik', () => {
    const vault = localStorageKeyVault(memoryStorage(), () => 1000);
    vault.remember('relic1', '#r1aaa', 1000 + HOUR);
    vault.remember('relic2', '#r1bbb', 1000 + HOUR);

    expect(vault.recall('relic1')).toBe('#r1aaa');
    expect(vault.recall('relic2')).toBe('#r1bbb');
  });

  test('forget removes it', () => {
    const vault = localStorageKeyVault(memoryStorage(), () => 1000);
    vault.remember('relic1', '#r1abc', 1000 + HOUR);
    vault.forget('relic1');

    expect(vault.recall('relic1')).toBeUndefined();
  });

  // A key outliving its relic is a secret kept for nothing.
  test('an entry past the relik expiry is not returned', () => {
    const storage = memoryStorage();
    let clock = 1000;
    const vault = localStorageKeyVault(storage, () => clock);

    vault.remember('relic1', '#r1abc', 1000 + HOUR);
    clock = 1000 + HOUR + 1;

    expect(vault.recall('relic1')).toBeUndefined();
  });

  test('an already expired key is never written down at all', () => {
    const storage = memoryStorage();
    const vault = localStorageKeyVault(storage, () => 5000);

    vault.remember('relic1', '#r1abc', 4000);
    expect(storage.length).toBe(0);
  });

  test('a non-finite expiry is refused rather than stored forever', () => {
    const storage = memoryStorage();
    const vault = localStorageKeyVault(storage, () => 1000);

    vault.remember('relic1', '#r1abc', Number.NaN);
    expect(storage.length).toBe(0);
  });

  test('Infinity means never expires and survives any clock', () => {
    // The regression, found in the field: a relic with no lifetime mints
    // relic_expires_at null, the viewer maps that to Infinity, and the vault
    // has to keep the key rather than refusing it like NaN.
    const storage = keyvaultMemoryStorage();
    let clock = 1000;
    const vault = localStorageKeyVault(storage, () => clock);

    vault.remember('forever', '#r1abc', Number.POSITIVE_INFINITY);
    clock = 1000 + 10 * 365 * 24 * 60 * 60 * 1000;
    expect(vault.recall('forever')).toBe('#r1abc');
  });

  test('a never-expires entry round-trips through persisted storage', () => {
    // JSON has no Infinity, so it persists as null. A fresh vault over the
    // same storage, which is what a page reload is, must read null as
    // never-expires rather than as already gone.
    const storage = keyvaultMemoryStorage();
    localStorageKeyVault(storage, () => 1000).remember(
      'forever',
      '#r1abc',
      Number.POSITIVE_INFINITY
    );

    const reloaded = localStorageKeyVault(storage, () => 9_000_000_000_000);
    expect(reloaded.recall('forever')).toBe('#r1abc');
  });

  test('the sweep keeps never-expires entries and still drops expired ones', () => {
    const storage = keyvaultMemoryStorage();
    let clock = 1000;
    const vault = localStorageKeyVault(storage, () => clock);

    vault.remember('expired', '#r1aaa', 1000 + HOUR);
    vault.remember('forever', '#r1bbb', Number.POSITIVE_INFINITY);

    clock = 1000 + 2 * HOUR;
    vault.recall('anything');

    expect(vault.recall('forever')).toBe('#r1bbb');
    expect(vault.recall('expired')).toBeUndefined();
  });

  // Otherwise storage fills with keys to relics that stopped existing.
  test('reading sweeps every expired entry, not just the one asked for', () => {
    const storage = memoryStorage();
    let clock = 1000;
    const vault = localStorageKeyVault(storage, () => clock);

    vault.remember('old1', '#r1aaa', 1000 + HOUR);
    vault.remember('old2', '#r1bbb', 1000 + HOUR);
    vault.remember('fresh', '#r1ccc', 1000 + 10 * HOUR);
    expect(storage.length).toBe(3);

    clock = 1000 + 2 * HOUR;
    vault.recall('fresh');

    expect(storage.length).toBe(1);
    expect(vault.recall('fresh')).toBe('#r1ccc');
  });

  test('a corrupt entry is swept rather than thrown over', () => {
    const storage = memoryStorage();
    storage.setItem('relic:key:relic1', 'not json');
    const vault = localStorageKeyVault(storage, () => 1000);

    expect(vault.recall('relic1')).toBeUndefined();
    expect(storage.length).toBe(0);
  });

  test('the sweep leaves other applications keys alone', () => {
    const storage = memoryStorage();
    storage.setItem('unrelated', 'keep me');
    const vault = localStorageKeyVault(storage, () => 1000);

    vault.remember('relic1', '#r1abc', 1000 + HOUR);
    vault.recall('relic1');

    expect(storage.getItem('unrelated')).toBe('keep me');
  });

  // Private browsing, a full quota, or blocked site data. None of these should
  // cost somebody the relic they are looking at right now.
  test('storage that throws on every call degrades to doing nothing', () => {
    const vault = localStorageKeyVault(refusingStorage(), () => 1000);

    expect(() => vault.remember('relic1', '#r1abc', 1000 + HOUR)).not.toThrow();
    expect(vault.recall('relic1')).toBeUndefined();
    expect(() => vault.forget('relic1')).not.toThrow();
  });

  test('absent storage degrades to doing nothing', () => {
    const vault = localStorageKeyVault(undefined, () => 1000);

    expect(() => vault.remember('relic1', '#r1abc', 1000 + HOUR)).not.toThrow();
    expect(vault.recall('relic1')).toBeUndefined();
    expect(() => vault.forget('relic1')).not.toThrow();
  });
});
