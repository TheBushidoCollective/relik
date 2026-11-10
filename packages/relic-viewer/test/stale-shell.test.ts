import { describe, expect, test } from 'bun:test';
import {
  createLifecycle,
  healStaleShell,
  markJsxCompilerLoaded,
  SERVER_CHECK_TIMEOUT_MS,
  STALE_SHELL_MARK,
  type StaleShellOptions,
} from '../src/stale-shell.ts';

const SERVICE = 'https://relic.example';

/** A session store the test can make unreadable or unwritable. */
function sessionShim(
  options: {
    readBlocked?: boolean;
    writeBlocked?: boolean;
    initial?: Record<string, string>;
  } = {}
) {
  const map = new Map(Object.entries(options.initial ?? {}));
  const storage = {
    getItem: (key: string) => {
      if (options.readBlocked) throw new Error('storage blocked');
      return map.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (options.writeBlocked) throw new Error('storage blocked');
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  } as unknown as Storage;
  return { storage, map };
}

/** A fetch that answers every request with one status and records it. */
function answering(status: number) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(null, { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function options(
  storage: Storage,
  fetch: typeof globalThis.fetch,
  reload: () => void,
  extra: Partial<StaleShellOptions> = {}
): StaleShellOptions {
  return {
    serviceOrigin: SERVICE,
    recallKey: () => 'key-fragment',
    isCurrent: () => true,
    fetch,
    session: () => storage,
    reload,
    ...extra,
  };
}

describe('the stale-shell heal decision', () => {
  test('reloads once when the mark is clear, the key is stored and the service answers', async () => {
    const { storage, map } = sessionShim();
    const { fetch } = answering(200);
    let reloads = 0;

    const reloaded = await healStaleShell(
      options(storage, fetch, () => {
        reloads += 1;
      })
    );

    expect(reloaded).toBe(true);
    expect(reloads).toBe(1);
    expect(map.get(STALE_SHELL_MARK)).toBe('1');
  });

  test('the server check is a no-store, credential-free HEAD of the icon', async () => {
    const { storage } = sessionShim();
    const { fetch, calls } = answering(200);

    await healStaleShell(options(storage, fetch, () => {}));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${SERVICE}/assets/icon.svg`);
    expect(calls[0]?.init?.method).toBe('HEAD');
    expect(calls[0]?.init?.cache).toBe('no-store');
    expect(calls[0]?.init?.credentials).toBe('omit');
    expect(calls[0]?.init?.signal).toBeDefined();
  });

  test('the server check gives up after five seconds by default', () => {
    expect(SERVER_CHECK_TIMEOUT_MS).toBe(5_000);
  });

  test('a second heal in the same tab does not reload', async () => {
    const { storage } = sessionShim({
      initial: { [STALE_SHELL_MARK]: '1' },
    });
    const { fetch, calls } = answering(200);
    let reloads = 0;

    const reloaded = await healStaleShell(
      options(storage, fetch, () => {
        reloads += 1;
      })
    );

    expect(reloaded).toBe(false);
    expect(reloads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('a session store that cannot be read never reloads', async () => {
    const { storage } = sessionShim({ readBlocked: true });
    const { fetch } = answering(200);
    let reloads = 0;

    const reloaded = await healStaleShell(
      options(storage, fetch, () => {
        reloads += 1;
      })
    );

    expect(reloaded).toBe(false);
    expect(reloads).toBe(0);
  });

  test('a session store that cannot be written never reloads', async () => {
    const { storage, map } = sessionShim({ writeBlocked: true });
    const { fetch } = answering(200);
    let reloads = 0;

    const reloaded = await healStaleShell(
      options(storage, fetch, () => {
        reloads += 1;
      })
    );

    expect(reloaded).toBe(false);
    expect(reloads).toBe(0);
    expect(map.has(STALE_SHELL_MARK)).toBe(false);
  });

  test('no stored key means no server check and no reload', async () => {
    const { storage } = sessionShim();
    const { fetch, calls } = answering(200);
    let reloads = 0;

    const reloaded = await healStaleShell(
      options(
        storage,
        fetch,
        () => {
          reloads += 1;
        },
        { recallKey: () => undefined }
      )
    );

    expect(reloaded).toBe(false);
    expect(reloads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('a service that answers with an error is not a deploy, so no reload', async () => {
    const { storage, map } = sessionShim();
    const { fetch } = answering(503);
    let reloads = 0;

    const reloaded = await healStaleShell(
      options(storage, fetch, () => {
        reloads += 1;
      })
    );

    expect(reloaded).toBe(false);
    expect(reloads).toBe(0);
    expect(map.has(STALE_SHELL_MARK)).toBe(false);
  });

  test('a network failure keeps the error card, so no reload', async () => {
    const { storage, map } = sessionShim();
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    let reloads = 0;

    const reloaded = await healStaleShell(
      options(storage, offline, () => {
        reloads += 1;
      })
    );

    expect(reloaded).toBe(false);
    expect(reloads).toBe(0);
    expect(map.has(STALE_SHELL_MARK)).toBe(false);
  });

  test('a server that never answers is abandoned at the timeout, so no reload', async () => {
    const { storage } = sessionShim();
    const hangs = ((_input: RequestInfo | URL, init?: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init?.signal?.addEventListener('abort', () =>
        reject(new Error('aborted'))
      );
      return promise;
    }) as unknown as typeof globalThis.fetch;
    let reloads = 0;

    const reloaded = await healStaleShell(
      options(
        storage,
        hangs,
        () => {
          reloads += 1;
        },
        { timeoutMs: 10 }
      )
    );

    expect(reloaded).toBe(false);
    expect(reloads).toBe(0);
  });

  test('a reader who has moved on does not reload', async () => {
    const { storage, map } = sessionShim();
    const { fetch } = answering(200);
    let reloads = 0;

    const reloaded = await healStaleShell(
      options(
        storage,
        fetch,
        () => {
          reloads += 1;
        },
        { isCurrent: () => false }
      )
    );

    expect(reloaded).toBe(false);
    expect(reloads).toBe(0);
    expect(map.has(STALE_SHELL_MARK)).toBe(false);
  });

  test('the mark clears once the compiler loads, so the next deploy can heal', () => {
    const { storage, map } = sessionShim({
      initial: { [STALE_SHELL_MARK]: '1' },
    });
    const global = globalThis as { sessionStorage?: Storage };
    global.sessionStorage = storage;
    try {
      markJsxCompilerLoaded();
      expect(map.has(STALE_SHELL_MARK)).toBe(false);
    } finally {
      delete global.sessionStorage;
    }
  });

  test('clearing the mark tolerates a page with no session store', () => {
    const global = globalThis as { sessionStorage?: Storage };
    delete global.sessionStorage;
    expect(() => markJsxCompilerLoaded()).not.toThrow();
  });
});

describe('late heals after the reader has moved on', () => {
  test('an exit taken before the probe means no probe and no reload', async () => {
    // Compare exit and version selection both advance the lifecycle before any
    // await, so a late compiler failure from the old state finds it stale.
    const life = createLifecycle();
    const token = life.token();
    life.advance();
    const { storage, map } = sessionShim();
    const { fetch, calls } = answering(200);
    let reloads = 0;

    const reloaded = await healStaleShell({
      ...options(storage, fetch, () => {
        reloads += 1;
      }),
      isCurrent: () => life.isCurrent(token),
    });

    expect(reloaded).toBe(false);
    expect(calls).toHaveLength(0);
    expect(reloads).toBe(0);
    expect(map.has(STALE_SHELL_MARK)).toBe(false);
  });

  test('an exit while the probe is held means no reload when it answers', async () => {
    const life = createLifecycle();
    const token = life.token();
    const { storage, map } = sessionShim();
    const held = Promise.withResolvers<Response>();
    const fetch = (async () =>
      held.promise) as unknown as typeof globalThis.fetch;
    let reloads = 0;

    const pending = healStaleShell({
      ...options(storage, fetch, () => {
        reloads += 1;
      }),
      isCurrent: () => life.isCurrent(token),
    });
    life.advance();
    held.resolve(new Response(null, { status: 200 }));

    expect(await pending).toBe(false);
    expect(reloads).toBe(0);
    expect(map.has(STALE_SHELL_MARK)).toBe(false);
  });

  test('a selection made while the probe is held cancels its reload', async () => {
    const life = createLifecycle();
    const selection = life.token();
    const { storage } = sessionShim();
    const held = Promise.withResolvers<Response>();
    const fetch = (async () =>
      held.promise) as unknown as typeof globalThis.fetch;
    let reloads = 0;

    const pending = healStaleShell({
      ...options(storage, fetch, () => {
        reloads += 1;
      }),
      isCurrent: () => life.isCurrent(selection),
    });
    life.advance();
    held.resolve(new Response(null, { status: 200 }));

    expect(await pending).toBe(false);
    expect(reloads).toBe(0);
  });

  test('a reader who stays on the same state still heals', async () => {
    const life = createLifecycle();
    const token = life.token();
    const { storage } = sessionShim();
    const { fetch } = answering(200);
    let reloads = 0;

    const reloaded = await healStaleShell({
      ...options(storage, fetch, () => {
        reloads += 1;
      }),
      isCurrent: () => life.isCurrent(token),
    });

    expect(reloaded).toBe(true);
    expect(reloads).toBe(1);
  });
});
