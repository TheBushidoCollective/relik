import { describe, expect, test } from 'bun:test';
import {
  createEditTracker,
  createLifecycle,
  healStaleShell,
  hasUnsentWork,
  markJsxCompilerLoaded,
  SERVER_CHECK_TIMEOUT_MS,
  STALE_SHELL_MARK,
  type StaleShellOptions,
  type UnsentWorkProbe,
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

/** A page with nothing open: no fields, no ceremony, no focused frame. */
const quietPage = {
  waiting: () => false,
  frameFocused: () => false,
};

/** A probe over fixed fields, each marked edited or prefilled explicitly. */
function pageOf(
  ...fields: Array<{ value: string; type: string; edited: boolean }>
): UnsentWorkProbe {
  return { ...quietPage, fields: () => fields };
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
    // The draft case: the reader leaves compare, types somewhere else, and only
    // then the held probe resolves with a healthy server.
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

  test('a version selection made while the probe is held cancels its reload', async () => {
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
    // The reader picks another version: a new selection, so a new state.
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

describe('what counts as unsent work', () => {
  test('an empty page holds no unsent work', () => {
    expect(
      hasUnsentWork(pageOf({ value: '', type: 'textarea', edited: true }))
    ).toBe(false);
  });

  test('whitespace the reader typed is not a draft', () => {
    expect(
      hasUnsentWork(pageOf({ value: '   ', type: 'text', edited: true }))
    ).toBe(false);
  });

  test('a comment the reader is typing is unsent work', () => {
    expect(
      hasUnsentWork(
        pageOf({ value: 'Looks right to me', type: 'textarea', edited: true })
      )
    ).toBe(true);
  });

  test('a signed-out share email the reader typed is unsent work', () => {
    expect(
      hasUnsentWork(
        pageOf({ value: 'reader@example.com', type: 'email', edited: true })
      )
    ).toBe(true);
  });

  test('a remembered display name prefilled by the page is not a draft', () => {
    expect(
      hasUnsentWork(pageOf({ value: 'Jason W.', type: 'text', edited: false }))
    ).toBe(false);
  });

  test('a typed value the reader then cleared is not a draft', () => {
    expect(
      hasUnsentWork(pageOf({ value: '', type: 'text', edited: true }))
    ).toBe(false);
  });

  test('range, color, number and date fields never count, even when edited', () => {
    expect(
      hasUnsentWork(
        pageOf(
          { value: '5', type: 'range', edited: true },
          { value: '#ff0000', type: 'color', edited: true },
          { value: '3', type: 'number', edited: true },
          { value: '2026-11-10', type: 'date', edited: true }
        )
      )
    ).toBe(false);
  });

  test('checkboxes, hidden fields and buttons do not count', () => {
    expect(
      hasUnsentWork(
        pageOf(
          { value: 'on', type: 'checkbox', edited: true },
          { value: 'token', type: 'hidden', edited: true },
          { value: 'Go', type: 'button', edited: true }
        )
      )
    ).toBe(false);
  });

  test('a decision or passkey ceremony waiting on the reader is unsent work', () => {
    expect(
      hasUnsentWork({ ...quietPage, fields: () => [], waiting: () => true })
    ).toBe(true);
  });

  test('a focused sandboxed frame is unsent work, because its contents are unreadable', () => {
    expect(
      hasUnsentWork({
        ...quietPage,
        fields: () => [],
        frameFocused: () => true,
      })
    ).toBe(true);
  });

  test('a page that cannot be read fails closed', () => {
    expect(
      hasUnsentWork({
        ...quietPage,
        fields: () => {
          throw new Error('no document');
        },
      })
    ).toBe(true);
  });

  test('a waiting check that cannot be read also fails closed', () => {
    expect(
      hasUnsentWork({
        fields: () => [],
        frameFocused: () => false,
        waiting: () => {
          throw new Error('no document');
        },
      })
    ).toBe(true);
  });
});

describe('the edit tracker records elements, never values', () => {
  test('an element the reader typed into is edited; an untouched one is not', () => {
    const tracker = createEditTracker();
    const typed = { value: 'hello' };
    const prefilled = { value: 'Jason W.' };

    tracker.onInput(typed);

    expect(tracker.isEdited(typed)).toBe(true);
    expect(tracker.isEdited(prefilled)).toBe(false);
  });

  test('non-element targets are ignored rather than recorded', () => {
    const tracker = createEditTracker();
    tracker.onInput(null);
    tracker.onInput('not an element');
    expect(tracker.isEdited(null)).toBe(false);
    expect(tracker.isEdited('not an element')).toBe(false);
  });
});

describe('unsent work during a late heal', () => {
  test('a draft already open means the heal does not even probe', async () => {
    const tracker = createEditTracker();
    const field = { value: 'half a comment', type: 'textarea' };
    tracker.onInput(field);
    const probe: UnsentWorkProbe = {
      ...quietPage,
      fields: () => [{ ...field, edited: tracker.isEdited(field) }],
    };
    const { storage, map } = sessionShim();
    const { fetch, calls } = answering(200);
    let reloads = 0;

    const reloaded = await healStaleShell({
      ...options(storage, fetch, () => {
        reloads += 1;
      }),
      isCurrent: () => !hasUnsentWork(probe),
    });

    expect(reloaded).toBe(false);
    expect(calls).toHaveLength(0);
    expect(reloads).toBe(0);
    expect(map.has(STALE_SHELL_MARK)).toBe(false);
  });

  test('a draft typed while the probe is held blocks the reload', async () => {
    // The reader types into a share or sign-in field while the probe is in
    // flight. The input event reaches the tracker, and the post-probe check
    // sees the field as edited and filled, so the page is not reloaded.
    const tracker = createEditTracker();
    const { storage, map } = sessionShim();
    const field = { value: '', type: 'email' };
    const probe: UnsentWorkProbe = {
      ...quietPage,
      fields: () => [
        {
          value: field.value,
          type: field.type,
          edited: tracker.isEdited(field),
        },
      ],
    };
    const fetch = (async () => {
      field.value = 'reader@example.com';
      tracker.onInput(field);
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    let reloads = 0;

    const reloaded = await healStaleShell({
      ...options(storage, fetch, () => {
        reloads += 1;
      }),
      isCurrent: () => !hasUnsentWork(probe),
    });

    expect(reloaded).toBe(false);
    expect(reloads).toBe(0);
    expect(map.has(STALE_SHELL_MARK)).toBe(false);
  });

  test('a value the page sets during the probe, with no input event, does not block', async () => {
    // A prefilled remembered name is set by script. No input event fires, so the
    // tracker does not record it and the heal still proceeds.
    const tracker = createEditTracker();
    const { storage } = sessionShim();
    const field = { value: '', type: 'text' };
    const probe: UnsentWorkProbe = {
      ...quietPage,
      fields: () => [
        {
          value: field.value,
          type: field.type,
          edited: tracker.isEdited(field),
        },
      ],
    };
    const fetch = (async () => {
      field.value = 'Jason W.';
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    let reloads = 0;

    const reloaded = await healStaleShell({
      ...options(storage, fetch, () => {
        reloads += 1;
      }),
      isCurrent: () => !hasUnsentWork(probe),
    });

    expect(reloaded).toBe(true);
    expect(reloads).toBe(1);
  });

  test('focus moving into a sandboxed frame during the probe blocks the reload', async () => {
    const { storage, map } = sessionShim();
    let frameFocused = false;
    const probe: UnsentWorkProbe = {
      ...quietPage,
      fields: () => [],
      frameFocused: () => frameFocused,
    };
    const fetch = (async () => {
      frameFocused = true;
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    let reloads = 0;

    const reloaded = await healStaleShell({
      ...options(storage, fetch, () => {
        reloads += 1;
      }),
      isCurrent: () => !hasUnsentWork(probe),
    });

    expect(reloaded).toBe(false);
    expect(reloads).toBe(0);
    expect(map.has(STALE_SHELL_MARK)).toBe(false);
  });

  test('with no draft at all the same probe lets the heal proceed', async () => {
    const { storage } = sessionShim();
    const { fetch } = answering(200);
    let reloads = 0;

    const reloaded = await healStaleShell({
      ...options(storage, fetch, () => {
        reloads += 1;
      }),
      isCurrent: () =>
        !hasUnsentWork(pageOf({ value: '', type: 'textarea', edited: false })),
    });

    expect(reloaded).toBe(true);
    expect(reloads).toBe(1);
  });
});
