import { describe, expect, test } from 'bun:test';
import { localStorageKeyVault } from '../src/vault.ts';

function memoryStorage(): Storage {
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

function throwingStorage(): Storage {
  const base = memoryStorage();
  return {
    ...base,
    get length(): number {
      throw new Error('SecurityError');
    },
    key: () => {
      throw new Error('SecurityError');
    },
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('SecurityError');
    },
    removeItem: () => {
      throw new Error('SecurityError');
    },
  } as Storage;
}

function quotaFailingStorage(): Storage {
  const base = memoryStorage();
  return {
    ...base,
    get length() {
      return base.length;
    },
    key: (i: number) => base.key(i),
    getItem: (k: string) => base.getItem(k),
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: (k: string) => base.removeItem(k),
  } as Storage;
}

const HOUR = 3_600_000;

describe('browser key vault', () => {
  test('old-shape entries with only fragment and expiresAt survive', () => {
    const storage = memoryStorage();
    const clock = 2000;
    storage.setItem(
      'relic:key:relic-old',
      JSON.stringify({ fragment: '#r1oldkey', expiresAt: 2000 + HOUR })
    );
    storage.setItem(
      'relic:key:relic-forever',
      JSON.stringify({ fragment: '#r1foreverkey', expiresAt: null })
    );

    const vault = localStorageKeyVault(storage, () => clock);

    expect(vault.recall('relic-old')).toBe('#r1oldkey');
    expect(vault.recall('relic-forever')).toBe('#r1foreverkey');

    const entries = vault.list();
    expect(entries.length).toBe(2);

    const oldEntry = entries.find((e) => e.relicId === 'relic-old');
    expect(oldEntry).toBeDefined();
    expect(oldEntry?.fragment).toBe('#r1oldkey');
    expect(oldEntry?.expiresAt).toBe(2000 + HOUR);
    expect(oldEntry?.title).toBeUndefined();
    expect(oldEntry?.lastOpenedAt).toBeUndefined();

    const foreverEntry = entries.find((e) => e.relicId === 'relic-forever');
    expect(foreverEntry).toBeDefined();
    expect(foreverEntry?.fragment).toBe('#r1foreverkey');
    expect(foreverEntry?.expiresAt).toBeNull();
    expect(foreverEntry?.title).toBeUndefined();
    expect(foreverEntry?.lastOpenedAt).toBeUndefined();
  });

  test('list sweeps expired entries and corrupt entries', () => {
    const storage = memoryStorage();
    const clock = 5000;

    // Valid entry
    storage.setItem(
      'relic:key:valid',
      JSON.stringify({
        fragment: '#r1valid',
        expiresAt: 5000 + HOUR,
        lastOpenedAt: 4000,
      })
    );
    // Expired entry
    storage.setItem(
      'relic:key:expired',
      JSON.stringify({
        fragment: '#r1expired',
        expiresAt: 4999,
        lastOpenedAt: 4000,
      })
    );
    // Corrupt JSON string
    storage.setItem('relic:key:bad-json', '{not valid json');
    // Corrupt primitive JSON
    storage.setItem('relic:key:bad-primitive', '12345');
    // Corrupt null JSON
    storage.setItem('relic:key:bad-null', 'null');
    // Missing fragment
    storage.setItem(
      'relic:key:no-fragment',
      JSON.stringify({ expiresAt: 5000 + HOUR })
    );
    // Non-string fragment
    storage.setItem(
      'relic:key:bad-fragment',
      JSON.stringify({ fragment: 12345, expiresAt: 5000 + HOUR })
    );
    // Bad expiresAt format
    storage.setItem(
      'relic:key:bad-expiry',
      JSON.stringify({ fragment: '#r1bad', expiresAt: 'never' })
    );

    const vault = localStorageKeyVault(storage, () => clock);
    const listed = vault.list();

    expect(listed.length).toBe(1);
    expect(listed[0]?.relicId).toBe('valid');
    expect(listed[0]?.fragment).toBe('#r1valid');

    // Sweeping cleaned corrupt and expired keys from the underlying store.
    expect(storage.getItem('relic:key:expired')).toBeNull();
    expect(storage.getItem('relic:key:bad-json')).toBeNull();
    expect(storage.getItem('relic:key:bad-primitive')).toBeNull();
    expect(storage.getItem('relic:key:bad-null')).toBeNull();
    expect(storage.getItem('relic:key:no-fragment')).toBeNull();
    expect(storage.getItem('relic:key:bad-fragment')).toBeNull();
    expect(storage.getItem('relic:key:bad-expiry')).toBeNull();
  });

  test('list returns newest lastOpenedAt first and entries lacking it last', () => {
    const storage = memoryStorage();
    let clock = 10000;
    const vault = localStorageKeyVault(storage, () => clock);

    // Old-style entry without lastOpenedAt
    storage.setItem(
      'relic:key:no-time-b',
      JSON.stringify({ fragment: '#r1notimeb', expiresAt: null })
    );
    storage.setItem(
      'relic:key:no-time-a',
      JSON.stringify({ fragment: '#r1notimea', expiresAt: null })
    );

    clock = 2000;
    vault.remember('opened-early', '#r1early', 50000);

    clock = 4000;
    vault.remember('opened-latest', '#r1latest', 50000);

    clock = 3000;
    vault.remember('opened-middle', '#r1middle', 50000);

    const listed = vault.list();
    const ids = listed.map((e) => e.relicId);

    expect(ids[0]).toBe('opened-latest');
    expect(ids[1]).toBe('opened-middle');
    expect(ids[2]).toBe('opened-early');
    // Entries lacking lastOpenedAt sort after all entries that have it.
    expect(ids.slice(3)).toEqual(['no-time-a', 'no-time-b']);
  });

  test('forget removes exactly one entry even with prefix-sensitive characters', () => {
    const storage = memoryStorage();
    const vault = localStorageKeyVault(storage, () => 1000);

    vault.remember('doc', '#r1base', 5000);
    vault.remember('doc-part2', '#r1part2', 5000);
    vault.remember('doc:nested:id', '#r1nested', 5000);
    vault.remember('other', '#r1other', 5000);

    vault.forget('doc');

    expect(vault.recall('doc')).toBeUndefined();
    expect(vault.recall('doc-part2')).toBe('#r1part2');
    expect(vault.recall('doc:nested:id')).toBe('#r1nested');
    expect(vault.recall('other')).toBe('#r1other');

    vault.forget('doc:nested:id');
    expect(vault.recall('doc:nested:id')).toBeUndefined();
    expect(vault.recall('doc-part2')).toBe('#r1part2');
  });

  test('exportEntries and importEntries round trip reproduces the exact entry set', () => {
    const storage1 = memoryStorage();
    let clock = 1000;
    const vault1 = localStorageKeyVault(storage1, () => clock);

    vault1.remember('r1', '#r1aaa', 10000, { title: 'First Relik' });
    clock = 2000;
    vault1.remember('r2', '#r1bbb', 20000, { title: 'Second Relik' });
    clock = 3000;
    vault1.remember('r3', '#r1ccc', Number.POSITIVE_INFINITY);

    const exportedJson = vault1.exportEntries();
    expect(typeof exportedJson).toBe('string');
    expect(exportedJson).toContain('#r1aaa');
    expect(exportedJson).toContain('#r1bbb');
    expect(exportedJson).toContain('#r1ccc');

    const storage2 = memoryStorage();
    const vault2 = localStorageKeyVault(storage2, () => clock);

    const importResult = vault2.importEntries(exportedJson);
    expect(importResult.added).toBe(3);
    expect(importResult.skipped).toBe(0);

    const list1 = vault1.list();
    const list2 = vault2.list();

    expect(list2).toEqual(list1);
  });

  test('importEntries refuses malformed, missing and expired entries and reports counts', () => {
    const storage = memoryStorage();
    const clock = 5000;
    const vault = localStorageKeyVault(storage, () => clock);

    // Initial local entry with lastOpenedAt 4000
    vault.remember('local-recent', '#r1local', 50000);

    const malformedBatch = [
      null,
      'a string instead of object',
      // Missing relicId
      { fragment: '#r1a', expiresAt: 60000 },
      // Empty relicId
      { relicId: '', fragment: '#r1b', expiresAt: 60000 },
      // Non-string relicId
      { relicId: 123, fragment: '#r1c', expiresAt: 60000 },
      // Missing fragment
      { relicId: 'bad-1', expiresAt: 60000 },
      // Empty fragment
      { relicId: 'bad-2', fragment: '', expiresAt: 60000 },
      // Malformed expiresAt
      { relicId: 'bad-3', fragment: '#r1d', expiresAt: 'invalid' },
      // Expired expiresAt
      { relicId: 'expired-1', fragment: '#r1e', expiresAt: 4999 },
      // Invalid title type
      { relicId: 'bad-4', fragment: '#r1f', expiresAt: 60000, title: 12345 },
      // Invalid lastOpenedAt type
      {
        relicId: 'bad-5',
        fragment: '#r1g',
        expiresAt: 60000,
        lastOpenedAt: -10,
      },
      // Valid new entry
      {
        relicId: 'good-1',
        fragment: '#r1h',
        expiresAt: 60000,
        title: 'Valid Title',
        lastOpenedAt: 4500,
      },
      // Valid entry without title or lastOpenedAt
      { relicId: 'good-2', fragment: '#r1i', expiresAt: null },
    ];

    const result = vault.importEntries(JSON.stringify(malformedBatch));
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(11);

    expect(vault.recall('good-1')).toBe('#r1h');
    expect(vault.recall('good-2')).toBe('#r1i');
    expect(vault.recall('bad-1')).toBeUndefined();
    expect(vault.recall('expired-1')).toBeUndefined();
  });

  test('importEntries overwrite policy preserves newer local entries and updates older ones', () => {
    const storage = memoryStorage();
    const clock = 10000;
    const vault = localStorageKeyVault(storage, () => clock);

    // Setup local entry with lastOpenedAt 8000
    storage.setItem(
      'relic:key:existing-newer',
      JSON.stringify({
        fragment: '#r1localversion',
        expiresAt: 50000,
        lastOpenedAt: 8000,
        title: 'Local Title',
      })
    );

    // Setup local entry with lastOpenedAt 3000
    storage.setItem(
      'relic:key:existing-older',
      JSON.stringify({
        fragment: '#r1localold',
        expiresAt: 50000,
        lastOpenedAt: 3000,
      })
    );

    // Setup local entry lacking lastOpenedAt
    storage.setItem(
      'relic:key:existing-notime',
      JSON.stringify({
        fragment: '#r1localnotime',
        expiresAt: 50000,
      })
    );

    const incoming = [
      // Older than local existing-newer (3000 < 8000) -> skipped
      {
        relicId: 'existing-newer',
        fragment: '#r1incoming',
        expiresAt: 50000,
        lastOpenedAt: 3000,
      },
      // Same timestamp as local existing-newer (8000 == 8000) -> skipped
      {
        relicId: 'existing-newer',
        fragment: '#r1incoming-same',
        expiresAt: 50000,
        lastOpenedAt: 8000,
      },
      // Strictly newer than local existing-older (7000 > 3000) -> added/updated
      {
        relicId: 'existing-older',
        fragment: '#r1incoming-newer',
        expiresAt: 50000,
        lastOpenedAt: 7000,
        title: 'Updated Title',
      },
      // Provides lastOpenedAt for local entry lacking one -> added/updated
      {
        relicId: 'existing-notime',
        fragment: '#r1incoming-addedtime',
        expiresAt: 50000,
        lastOpenedAt: 2500,
      },
    ];

    const result = vault.importEntries(JSON.stringify(incoming));
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(2);

    // existing-newer remained untouched
    expect(vault.recall('existing-newer')).toBe('#r1localversion');

    // existing-older was updated
    expect(vault.recall('existing-older')).toBe('#r1incoming-newer');
    const olderEntry = vault.list().find((e) => e.relicId === 'existing-older');
    expect(olderEntry?.lastOpenedAt).toBe(7000);
    expect(olderEntry?.title).toBe('Updated Title');

    // existing-notime gained lastOpenedAt
    const notimeEntry = vault
      .list()
      .find((e) => e.relicId === 'existing-notime');
    expect(notimeEntry?.lastOpenedAt).toBe(2500);
  });

  test('all operations survive when storage is absent (undefined)', () => {
    const vault = localStorageKeyVault(undefined, () => 1000);

    expect(() => vault.remember('relic1', '#r1abc', 5000)).not.toThrow();
    expect(vault.recall('relic1')).toBeUndefined();
    expect(vault.list()).toEqual([]);
    expect(() => vault.forget('relic1')).not.toThrow();
    expect(vault.exportEntries()).toBe(
      JSON.stringify({ version: 1, entries: [] })
    );
    expect(
      vault.importEntries(
        JSON.stringify([{ relicId: 'r1', fragment: '#r1x', expiresAt: null }])
      )
    ).toEqual({ added: 0, skipped: 0 });
  });

  test('all operations survive when storage throws on touch', () => {
    const vault = localStorageKeyVault(throwingStorage(), () => 1000);

    expect(() => vault.remember('relic1', '#r1abc', 5000)).not.toThrow();
    expect(vault.recall('relic1')).toBeUndefined();
    expect(vault.list()).toEqual([]);
    expect(() => vault.forget('relic1')).not.toThrow();
    expect(vault.exportEntries()).toBe(
      JSON.stringify({ version: 1, entries: [] })
    );
    expect(
      vault.importEntries(
        JSON.stringify([{ relicId: 'r1', fragment: '#r1x', expiresAt: null }])
      )
    ).toEqual({ added: 0, skipped: 1 });
  });

  test('all operations survive when storage rejects writes due to quota', () => {
    const storage = quotaFailingStorage();
    const vault = localStorageKeyVault(storage, () => 1000);

    expect(() => vault.remember('relic1', '#r1abc', 5000)).not.toThrow();
    expect(vault.recall('relic1')).toBeUndefined();
    expect(vault.list()).toEqual([]);
    expect(() => vault.forget('relic1')).not.toThrow();

    const importResult = vault.importEntries(
      JSON.stringify([{ relicId: 'r1', fragment: '#r1x', expiresAt: null }])
    );
    expect(importResult.added).toBe(0);
    expect(importResult.skipped).toBe(1);
  });

  test('remember preserves existing title when meta title is omitted', () => {
    const storage = memoryStorage();
    let clock = 1000;
    const vault = localStorageKeyVault(storage, () => clock);

    vault.remember('r1', '#r1first', 10000, {
      title: 'Original Title',
      renderer: 'markdown',
    });
    let entry = vault.list().find((e) => e.relicId === 'r1');
    expect(entry?.title).toBe('Original Title');
    expect(entry?.renderer).toBe('markdown');
    expect(entry?.lastOpenedAt).toBe(1000);

    // Calling remember again on reload without meta title preserves the title and updates lastOpenedAt
    clock = 2500;
    vault.remember('r1', '#r1first', 10000);
    entry = vault.list().find((e) => e.relicId === 'r1');
    expect(entry?.title).toBe('Original Title');
    expect(entry?.renderer).toBe('markdown');
    expect(entry?.lastOpenedAt).toBe(2500);

    // Calling remember with a new title replaces it
    clock = 3500;
    vault.remember('r1', '#r1first', 10000, {
      title: 'Updated Title',
      renderer: 'code',
    });
    entry = vault.list().find((e) => e.relicId === 'r1');
    expect(entry?.title).toBe('Updated Title');
    expect(entry?.renderer).toBe('code');
    expect(entry?.lastOpenedAt).toBe(3500);
  });

  test('forget evicts a remembered fragment that fails downstream parsing', () => {
    const storage = memoryStorage();
    const vault = localStorageKeyVault(storage, () => 1000);

    vault.remember('relic-corrupt', 'not-a-valid-fragment', 10000);
    expect(vault.recall('relic-corrupt')).toBe('not-a-valid-fragment');

    // Downstream caller detects unparsable fragment and calls forget
    vault.forget('relic-corrupt');

    // Subsequent attempts recall nothing and clean slate is restored
    expect(vault.recall('relic-corrupt')).toBeUndefined();
    expect(
      vault.list().find((e) => e.relicId === 'relic-corrupt')
    ).toBeUndefined();
  });
});
