export interface VaultEntry {
  readonly relicId: string;
  readonly fragment: string;
  readonly expiresAt: number | null;
  readonly title?: string | undefined;
  readonly lastOpenedAt?: number | undefined;
  readonly renderer?: string | undefined;
}

export interface KeyVault {
  remember(
    relicId: string,
    fragment: string,
    expiresAt: number,
    meta?: {
      readonly title?: string | undefined;
      readonly renderer?: string | undefined;
    }
  ): void;
  recall(relicId: string): string | undefined;
  list(): readonly VaultEntry[];
  forget(relicId: string): void;
  exportEntries(): string;
  importEntries(json: string): {
    readonly added: number;
    readonly skipped: number;
  };
}

const VAULT_PREFIX = 'relic:key:';

/**
 * Keys remembered in this browser's storage for the service origin.
 *
 * Storage can be absent or refuse to write: private browsing, a quota, an
 * embedded webview, or a user who has blocked site data. None of that should
 * cost somebody the relic they are currently looking at, so every operation
 * degrades to doing nothing. The worst case is the behaviour that existed
 * before this: a reload asks for the original link.
 *
 * Entries carry their relic's expiry and are swept on every read, so storage
 * does not accumulate keys to relics that stopped existing days ago.
 */
export function localStorageKeyVault(
  storage?: Storage,
  now: () => number = Date.now
): KeyVault {
  const read = (): Storage | undefined => {
    try {
      // Touching localStorage throws outright in some embedded contexts,
      // rather than being absent, so the guard has to be a try and not a null
      // check.
      return storage ?? globalThis.localStorage ?? undefined;
    } catch {
      return undefined;
    }
  };

  const sweep = (store: Storage): void => {
    const stale: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const name = store.key(i);
      if (name === null || !name.startsWith(VAULT_PREFIX)) continue;
      try {
        const raw = store.getItem(name);
        if (raw === null) {
          stale.push(name);
          continue;
        }
        const entry: unknown = JSON.parse(raw);
        if (entry === null || typeof entry !== 'object') {
          stale.push(name);
          continue;
        }
        if (!('fragment' in entry) || typeof entry.fragment !== 'string') {
          stale.push(name);
          continue;
        }
        if (!('expiresAt' in entry)) {
          stale.push(name);
          continue;
        }
        const expiresAt = entry.expiresAt;
        // null is how a never-expires entry is persisted; JSON has no
        // Infinity. Any other non-number is corruption, and swept.
        if (
          (expiresAt !== null && typeof expiresAt !== 'number') ||
          (typeof expiresAt === 'number' &&
            (Number.isNaN(expiresAt) || expiresAt <= now()))
        ) {
          stale.push(name);
        }
      } catch {
        // Unreadable entry. Not ours to interpret, and not worth keeping.
        stale.push(name);
      }
    }
    for (const name of stale) {
      try {
        store.removeItem(name);
      } catch {
        // Storage could throw on write or delete; degrade silently.
      }
    }
  };

  return {
    remember(relicId, fragment, expiresAt, meta) {
      const store = read();
      if (store === undefined) return;
      // NaN stays refused: an unparsable date is corruption, not forever.
      // Infinity passes, because a relic with no lifetime is worth keeping
      // the key for until it is deleted.
      if (Number.isNaN(expiresAt) || expiresAt <= now()) return;

      let title: string | undefined =
        typeof meta?.title === 'string' ? meta.title : undefined;
      let renderer: string | undefined =
        typeof meta?.renderer === 'string' ? meta.renderer : undefined;
      if (title === undefined || renderer === undefined) {
        try {
          const raw = store.getItem(`${VAULT_PREFIX}${relicId}`);
          if (raw !== null) {
            const existing: unknown = JSON.parse(raw);
            if (existing !== null && typeof existing === 'object') {
              if (
                title === undefined &&
                'title' in existing &&
                typeof existing.title === 'string'
              ) {
                title = existing.title;
              }
              if (
                renderer === undefined &&
                'renderer' in existing &&
                typeof existing.renderer === 'string'
              ) {
                renderer = existing.renderer;
              }
              if (
                renderer === undefined &&
                'renderer' in existing &&
                typeof existing.renderer === 'string'
              ) {
                renderer = existing.renderer;
              }
            }
          }
        } catch {
          // Failure reading existing metadata should not abort remembering.
        }
      }

      try {
        store.setItem(
          `${VAULT_PREFIX}${relicId}`,
          JSON.stringify({
            fragment,
            expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
            lastOpenedAt: now(),
            ...(title !== undefined ? { title } : {}),
            ...(renderer !== undefined ? { renderer } : {}),
          })
        );
      } catch {
        // Quota, or storage disabled mid-session. A remembered key is a
        // convenience; failing to store one is not worth an error page.
      }
    },

    recall(relicId) {
      const store = read();
      if (store === undefined) return undefined;
      try {
        sweep(store);
        const raw = store.getItem(`${VAULT_PREFIX}${relicId}`);
        if (raw === null) return undefined;
        const entry: unknown = JSON.parse(raw);
        if (entry === null || typeof entry !== 'object') return undefined;
        if (!('fragment' in entry) || typeof entry.fragment !== 'string') {
          return undefined;
        }
        if (!('expiresAt' in entry)) return undefined;
        const expiresAt = entry.expiresAt;
        if (typeof expiresAt === 'number' && expiresAt <= now()) {
          return undefined;
        }
        // null means never expires. Anything else that is not a number is
        // corruption, and recalls nothing.
        if (expiresAt !== null && typeof expiresAt !== 'number') {
          return undefined;
        }
        return entry.fragment;
      } catch {
        return undefined;
      }
    },

    list() {
      const store = read();
      if (store === undefined) return [];
      try {
        sweep(store);
        const entries: VaultEntry[] = [];
        for (let i = 0; i < store.length; i++) {
          const name = store.key(i);
          if (name === null || !name.startsWith(VAULT_PREFIX)) continue;
          const relicId = name.slice(VAULT_PREFIX.length);
          if (relicId.length === 0) continue;
          try {
            const raw = store.getItem(name);
            if (raw === null) continue;
            const parsed: unknown = JSON.parse(raw);
            if (parsed === null || typeof parsed !== 'object') {
              try {
                store.removeItem(name);
              } catch {
                // Storage removal failure is ignored.
              }
              continue;
            }
            if (
              !('fragment' in parsed) ||
              typeof parsed.fragment !== 'string'
            ) {
              try {
                store.removeItem(name);
              } catch {
                // Storage removal failure is ignored.
              }
              continue;
            }
            if (!('expiresAt' in parsed)) {
              try {
                store.removeItem(name);
              } catch {
                // Storage removal failure is ignored.
              }
              continue;
            }
            const expiresAt = parsed.expiresAt;
            if (
              (expiresAt !== null && typeof expiresAt !== 'number') ||
              (typeof expiresAt === 'number' &&
                (Number.isNaN(expiresAt) || expiresAt <= now()))
            ) {
              try {
                store.removeItem(name);
              } catch {
                // Storage removal failure is ignored.
              }
              continue;
            }
            const title =
              'title' in parsed && typeof parsed.title === 'string'
                ? parsed.title
                : undefined;
            const renderer =
              'renderer' in parsed && typeof parsed.renderer === 'string'
                ? parsed.renderer
                : undefined;
            const lastOpenedAt =
              'lastOpenedAt' in parsed &&
              typeof parsed.lastOpenedAt === 'number' &&
              Number.isFinite(parsed.lastOpenedAt)
                ? parsed.lastOpenedAt
                : undefined;
            entries.push({
              relicId,
              fragment: parsed.fragment,
              expiresAt: expiresAt as number | null,
              ...(title !== undefined ? { title } : {}),
              ...(lastOpenedAt !== undefined ? { lastOpenedAt } : {}),
              ...(renderer !== undefined ? { renderer } : {}),
            });
          } catch {
            try {
              store.removeItem(name);
            } catch {
              // Corrupt entry removal failure is ignored.
            }
          }
        }
        entries.sort((a, b) => {
          const aTime = a.lastOpenedAt;
          const bTime = b.lastOpenedAt;
          if (aTime !== undefined && bTime !== undefined) {
            return bTime - aTime;
          }
          if (aTime !== undefined) return -1;
          if (bTime !== undefined) return 1;
          return a.relicId.localeCompare(b.relicId);
        });
        return entries;
      } catch {
        return [];
      }
    },

    forget(relicId) {
      const store = read();
      if (store === undefined) return;
      try {
        store.removeItem(`${VAULT_PREFIX}${relicId}`);
      } catch {
        // Nothing to do, and nothing worth telling the reader about.
      }
    },

    /**
     * Export remembered keys as a JSON string for backup or transfer to another
     * browser.
     *
     * This payload carries raw decryption fragments: anyone holding this export
     * can read every relic listed in it. Treat this string as a credential.
     */
    exportEntries() {
      const store = read();
      if (store === undefined) {
        return JSON.stringify({ version: 1, entries: [] });
      }
      try {
        return JSON.stringify({
          version: 1,
          entries: this.list(),
        });
      } catch {
        return JSON.stringify({ version: 1, entries: [] });
      }
    },

    /**
     * Import entries from a JSON string into local storage.
     *
     * An imported entry will not overwrite a local entry that was opened at the
     * same time or more recently. Malformed and expired entries are rejected.
     */
    importEntries(json) {
      let added = 0;
      let skipped = 0;
      const store = read();
      if (store === undefined) {
        return { added: 0, skipped: 0 };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        return { added: 0, skipped: 0 };
      }

      let rawEntries: unknown[] | null = null;
      if (Array.isArray(parsed)) {
        rawEntries = parsed;
      } else if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'entries' in parsed &&
        Array.isArray(parsed.entries)
      ) {
        rawEntries = parsed.entries;
      }

      if (rawEntries === null) {
        return { added: 0, skipped: 0 };
      }

      const currentTime = now();
      for (const raw of rawEntries) {
        if (raw === null || typeof raw !== 'object') {
          skipped++;
          continue;
        }

        if (
          !('relicId' in raw) ||
          typeof raw.relicId !== 'string' ||
          raw.relicId.length === 0
        ) {
          skipped++;
          continue;
        }
        const relicId = raw.relicId;

        if (
          !('fragment' in raw) ||
          typeof raw.fragment !== 'string' ||
          raw.fragment.length === 0
        ) {
          skipped++;
          continue;
        }
        const fragment = raw.fragment;

        if (!('expiresAt' in raw)) {
          skipped++;
          continue;
        }
        const expiresAt = raw.expiresAt;
        if (expiresAt !== null && typeof expiresAt !== 'number') {
          skipped++;
          continue;
        }
        if (typeof expiresAt === 'number') {
          if (!Number.isFinite(expiresAt) || expiresAt <= currentTime) {
            skipped++;
            continue;
          }
        }

        let title: string | undefined;
        if ('title' in raw && raw.title !== undefined) {
          if (typeof raw.title !== 'string') {
            skipped++;
            continue;
          }
          title = raw.title;
        }

        let renderer: string | undefined;
        if ('renderer' in raw && raw.renderer !== undefined) {
          if (typeof raw.renderer !== 'string' || raw.renderer.length === 0) {
            skipped++;
            continue;
          }
          renderer = raw.renderer;
        }

        let lastOpenedAt: number | undefined;
        if ('lastOpenedAt' in raw && raw.lastOpenedAt !== undefined) {
          if (
            typeof raw.lastOpenedAt !== 'number' ||
            !Number.isFinite(raw.lastOpenedAt) ||
            raw.lastOpenedAt < 0
          ) {
            skipped++;
            continue;
          }
          lastOpenedAt = raw.lastOpenedAt;
        }

        try {
          const key = `${VAULT_PREFIX}${relicId}`;
          const existingRaw = store.getItem(key);
          if (existingRaw !== null) {
            let existing: unknown = null;
            try {
              existing = JSON.parse(existingRaw);
            } catch {
              // Corrupt local entry is treated as absent and overwritten.
            }

            if (
              existing !== null &&
              typeof existing === 'object' &&
              'fragment' in existing &&
              typeof existing.fragment === 'string'
            ) {
              const existingOpened =
                'lastOpenedAt' in existing &&
                typeof existing.lastOpenedAt === 'number' &&
                Number.isFinite(existing.lastOpenedAt)
                  ? existing.lastOpenedAt
                  : undefined;

              // An import will not overwrite a local entry that is newer or equal.
              const isImportStrictlyNewer =
                lastOpenedAt !== undefined &&
                (existingOpened === undefined || lastOpenedAt > existingOpened);

              if (!isImportStrictlyNewer) {
                skipped++;
                continue;
              }

              if (
                title === undefined &&
                'title' in existing &&
                typeof existing.title === 'string'
              ) {
                title = existing.title;
              }
            }
          }

          store.setItem(
            key,
            JSON.stringify({
              fragment,
              expiresAt,
              ...(title !== undefined ? { title } : {}),
              ...(lastOpenedAt !== undefined ? { lastOpenedAt } : {}),
              ...(renderer !== undefined ? { renderer } : {}),
            })
          );
          added++;
        } catch {
          skipped++;
        }
      }

      return { added, skipped };
    },
  };
}
