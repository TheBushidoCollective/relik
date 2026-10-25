import { beforeEach, describe, expect, test } from 'bun:test';
import {
  encodeFragment,
  encryptRelic,
  generateKey,
  generateRelicId,
} from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { localStorageKeyVault } from '../src/main.ts';
import {
  deadFromProblem,
  load,
  routeFor,
  routeForClass,
  shareUrlFor,
  type ViewerDeps,
} from '../src/viewer.ts';

/** Enough of the Storage interface for the vault, defined locally so no test
 * imports another test file: doing that re-runs its describe blocks. */
function localStorageShim(): Storage {
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

const SERVICE = 'https://relic.example';
const utf8 = (text: string) => new TextEncoder().encode(text);

let now = Date.parse('2026-08-02T12:00:00.000Z');
let storage: MemoryStorage;
let app: ReturnType<typeof createApp>;
let stripped: boolean;
let fragmentReads: number;

function shimFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    if (url.origin === SERVICE) {
      const headers = new Headers(init?.headers);
      headers.set('x-forwarded-for', '203.0.113.5');
      return app.fetch(new Request(url.toString(), { ...init, headers }));
    }
    const relicId = url.pathname.split('/').filter(Boolean)[1] as string;
    const bytes = await storage.read(relicId);
    if (bytes === undefined) return new Response(null, { status: 404 });
    return new Response(bytes as unknown as BodyInit, { status: 200 });
  }) as typeof globalThis.fetch;
}

/** An in-memory stand-in for the browser's storage, shared across a test. */
export function fakeVault(seed: Record<string, string> = {}) {
  const entries = new Map(Object.entries(seed));
  /** What load() asked the vault to remember, keyed by relic id. */
  const rememberCalls = new Map<string, number>();
  return {
    entries,
    rememberCalls,
    vault: {
      // No expiry check. The app under test runs on its own clock, so
      // comparing its expiry to real wall time would reject everything.
      // Expiry belongs to the storage implementation and is tested there.
      remember(relicId: string, fragment: string, expiresAt: number) {
        rememberCalls.set(relicId, expiresAt);
        entries.set(relicId, fragment);
      },
      recall: (relicId: string) => entries.get(relicId),
      forget: (relicId: string) => {
        entries.delete(relicId);
      },
    },
  };
}

function deps(
  fragment: string,
  href = `${SERVICE}/x#${fragment}`,
  vault = fakeVault().vault
): ViewerDeps {
  return {
    serviceOrigin: SERVICE,
    fetch: shimFetch(),
    keyVault: vault,
    takeFragment: () => {
      fragmentReads += 1;
      return fragment;
    },
    stripFragment: () => {
      stripped = true;
    },
    locationHref: href,
  };
}

/** Put a real relic in place and return its id, key, and fragment. */
async function seed(
  content: Uint8Array,
  filename: string,
  mimetype: string
): Promise<{ id: string; fragment: string }> {
  const id = generateRelicId();
  const key = generateKey();

  await app.fetch(
    new Request(`${SERVICE}/api/challenge`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.10' },
    })
  );
  const challenge = (await app
    .fetch(
      new Request(`${SERVICE}/api/challenge`, {
        method: 'POST',
        headers: { 'x-forwarded-for': '198.51.100.10' },
      })
    )
    .then((r) => r.json())) as { challenge_nonce: string };

  await app.fetch(
    new Request(`${SERVICE}/api/grant`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.10' },
      body: JSON.stringify({
        challenge_nonce: challenge.challenge_nonce,
        relic_id: id,
        renderer_class: 'markdown',
        publishing_client: 'test',
        declared_size_bytes: content.length,
      }),
    })
  );

  storage.put(id, await encryptRelic({ content, filename, mimetype, key }));
  now += 10 * 60 * 1000;

  const { encodeFragment } = await import('@relic/format');
  return { id, fragment: encodeFragment(key) };
}

beforeEach(() => {
  now = Date.parse('2026-08-02T12:00:00.000Z');
  storage = new MemoryStorage();
  stripped = false;
  fragmentReads = 0;
  app = createApp({
    store: new MemoryStore(),
    storage,
    now: () => now,
    operatorTokens: new Map([['jason', 'operator-secret']]),
  });
});

describe('the fragment', () => {
  test('is read once and stripped from the address bar', async () => {
    const { id, fragment } = await seed(
      utf8('# hi'),
      'notes.md',
      'text/markdown'
    );
    await load(id, deps(fragment));

    expect(fragmentReads).toBe(1);
    expect(stripped).toBe(true);
  });

  test('is stripped even when the relic turns out to be dead', async () => {
    await load(generateRelicId(), deps('r1AAAAAAAAAAAAAAAAAAAA'));
    expect(stripped).toBe(true);
  });

  test('an absent fragment is a dead page pointing at the original link', async () => {
    const state = await load(generateRelicId(), deps(''));
    expect(state.kind).toBe('dead');
    if (state.kind !== 'dead') return;
    expect(state.dead.code).toBe('fragment_missing');
    expect(state.dead.action).toBe('reopen-original-link');
    // A reload is the common cause, and it must not read as a decrypt error.
    expect(state.dead.detail).toContain('reloaded');
  });

  test('an unknown version refuses before any fetch, so no mint is spent', async () => {
    const { id } = await seed(utf8('# hi'), 'notes.md', 'text/markdown');
    const before = (await app.store.readMintLog()).length;

    const state = await load(id, deps('r9AAAAAAAAAAAAAAAAAAAA'));

    expect(state.kind).toBe('dead');
    if (state.kind === 'dead') expect(state.dead.code).toBe('unknown_version');
    expect(await app.store.readMintLog()).toHaveLength(before);
    expect((await app.store.getRelic(id))?.mintsUsed).toBe(0);
  });

  test('a truncated fragment says the link looks truncated', async () => {
    const { id, fragment } = await seed(
      utf8('# hi'),
      'notes.md',
      'text/markdown'
    );
    const state = await load(id, deps(fragment.slice(0, -1)));

    expect(state.kind).toBe('dead');
    if (state.kind === 'dead') {
      expect(state.dead.code).toBe('fragment_malformed');
    }
  });

  test('the share url keeps the fragment, backing the copy-link affordance', async () => {
    const { id, fragment } = await seed(
      utf8('# hi'),
      'notes.md',
      'text/markdown'
    );
    const href = `${SERVICE}/${id}#${fragment}`;
    const state = await load(id, deps(fragment, href));

    expect(state.kind).toBe('ready');
    if (state.kind === 'ready') expect(state.view.shareUrl).toBe(href);
  });
});

/**
 * The reload path.
 *
 * Reading the fragment strips it, so a reload arrives with nothing in the URL.
 * Before this the page simply died and told the reader to find the original
 * link, which is a bad answer to a refresh.
 */
describe('remembering the key', () => {
  test('a reload with no fragment opens from the remembered key', async () => {
    const { id, fragment } = await seed(
      utf8('# Still here\n'),
      'report.md',
      'text/markdown'
    );
    const { vault } = fakeVault();

    const first = await load(
      id,
      deps(fragment, `${SERVICE}/x#${fragment}`, vault)
    );
    expect(first.kind).toBe('ready');

    // Same browser, same relic, no fragment: a refresh.
    const reloaded = await load(id, deps('', `${SERVICE}/x`, vault));
    expect(reloaded.kind).toBe('ready');
    if (reloaded.kind !== 'ready') return;
    expect(new TextDecoder().decode(reloaded.view.content)).toBe(
      '# Still here\n'
    );
  });

  test('a relic with no lifetime is remembered as never expiring', async () => {
    // Found in the field: the mint returns relic_expires_at null for a relic
    // with no lifetime, Date.parse(null) is NaN, and the vault refused to
    // store anything, so every reload lost the key. The mapping to Infinity
    // is the fix; this pins it against the real server response shape.
    const { id, fragment } = await seed(
      utf8('# Kept until deleted\n'),
      'report.md',
      'text/markdown'
    );
    const { vault, rememberCalls } = fakeVault();

    const state = await load(
      id,
      deps(fragment, `${SERVICE}/x#${fragment}`, vault)
    );
    expect(state.kind).toBe('ready');
    expect(rememberCalls.get(id)).toBe(Number.POSITIVE_INFINITY);
  });

  test('the real vault reloads a never-expiring relic', async () => {
    // The fake vault above ignores expiry, which is how the bug slipped
    // through it. This one runs the actual localStorage vault, on a local
    // Storage shim rather than an import from another test file, against
    // the same clock the app under test uses.
    const store = localStorageShim();
    const vault = localStorageKeyVault(store, () => now);
    const { id, fragment } = await seed(
      utf8('# Survives the refresh\n'),
      'report.md',
      'text/markdown'
    );

    const first = await load(
      id,
      deps(fragment, `${SERVICE}/x#${fragment}`, vault)
    );
    expect(first.kind).toBe('ready');

    // Much later, same browser: the entry must still recall.
    now += 365 * 24 * 60 * 60 * 1000;
    const reloaded = await load(id, deps('', `${SERVICE}/x`, vault));
    expect(reloaded.kind).toBe('ready');
  });

  test('nothing is remembered for a relic that does not exist', async () => {
    const { entries, vault } = fakeVault();
    const { fragment } = await seed(utf8('x'), 'a.md', 'text/markdown');

    // A well-formed key against an id that was never published.
    const state = await load(
      generateRelicId(),
      deps(fragment, undefined, vault)
    );

    expect(state.kind).toBe('dead');
    expect(entries.size).toBe(0);
  });

  test('a dead relic evicts whatever this browser remembered', async () => {
    const { id, fragment } = await seed(
      utf8('# Gone soon\n'),
      'report.md',
      'text/markdown'
    );
    const { entries, vault } = fakeVault();

    await load(id, deps(fragment, `${SERVICE}/x#${fragment}`, vault));
    expect(entries.size).toBe(1);

    await app.fetch(
      new Request(`${SERVICE}/api/relics/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );

    const after = await load(id, deps('', `${SERVICE}/x`, vault));
    expect(after.kind).toBe('dead');
    // Keeping a key to a relic that no longer exists is keeping a secret for
    // no reason at all.
    expect(entries.size).toBe(0);
  });

  test('a remembered key that is corrupt is dropped, not retried forever', async () => {
    const { id } = await seed(utf8('x'), 'a.md', 'text/markdown');
    const { entries, vault } = fakeVault({ [id]: '#r1notavalidkey' });

    const state = await load(id, deps('', `${SERVICE}/x`, vault));

    expect(state.kind).toBe('dead');
    expect(entries.size).toBe(0);
  });

  test('with nothing remembered, a reload still says what to do', async () => {
    const state = await load(generateRelicId(), deps('', `${SERVICE}/x`));

    expect(state.kind).toBe('dead');
    if (state.kind !== 'dead') return;
    expect(state.dead.code).toBe('fragment_missing');
  });

  /**
   * The share link after a reload.
   *
   * The address bar is the one place the key is guaranteed not to be, so a
   * share URL read back off it is keyless exactly when the reader fell back to
   * storage. It failed silently: the copy succeeded and claimed to contain the
   * key, and the recipient got a page that could not open.
   */
  test('copying after a reload still yields a link that carries the key', async () => {
    const { id, fragment } = await seed(
      utf8('# Share me\n'),
      'report.md',
      'text/markdown'
    );
    const { vault } = fakeVault();

    await load(id, deps(fragment, `${SERVICE}/${id}#${fragment}`, vault));

    // The reload: the URL has no fragment, the key comes from storage.
    const reloaded = await load(id, deps('', `${SERVICE}/${id}`, vault));

    expect(reloaded.kind).toBe('ready');
    if (reloaded.kind !== 'ready') return;
    expect(reloaded.view.shareUrl).toContain('#');
    expect(reloaded.view.shareUrl).toBe(`${SERVICE}/${id}#${fragment}`);
  });

  test('a share link is openable, not merely non-empty', async () => {
    const { id, fragment } = await seed(
      utf8('# Round trip\n'),
      'report.md',
      'text/markdown'
    );
    const { vault } = fakeVault();

    await load(id, deps(fragment, `${SERVICE}/${id}#${fragment}`, vault));
    const reloaded = await load(id, deps('', `${SERVICE}/${id}`, vault));
    if (reloaded.kind !== 'ready') throw new Error('expected ready');

    // Hand the copied link to a browser with no memory of this relic.
    const copied = new URL(reloaded.view.shareUrl);
    const fresh = await load(
      id,
      deps(copied.hash, reloaded.view.shareUrl, fakeVault().vault)
    );

    expect(fresh.kind).toBe('ready');
    if (fresh.kind !== 'ready') return;
    expect(new TextDecoder().decode(fresh.view.content)).toBe('# Round trip\n');
  });
});

describe('shareUrlFor', () => {
  test('attaches the key to the page the reader is on', () => {
    expect(shareUrlFor('https://relic.example/abc', 'r1KEY')).toBe(
      'https://relic.example/abc#r1KEY'
    );
  });

  test('accepts a fragment with or without its hash', () => {
    expect(shareUrlFor('https://relic.example/abc', '#r1KEY')).toBe(
      'https://relic.example/abc#r1KEY'
    );
  });

  test('replaces a stale fragment rather than appending to it', () => {
    expect(shareUrlFor('https://relic.example/abc#r1OLD', 'r1NEW')).toBe(
      'https://relic.example/abc#r1NEW'
    );
  });

  // A custom domain or a proxy in front of the service should produce a link
  // that works from where the reader got it.
  test('keeps the host the reader is actually on', () => {
    expect(shareUrlFor('https://relics.example.co/abc?x=1', 'r1KEY')).toBe(
      'https://relics.example.co/abc?x=1#r1KEY'
    );
  });
});

describe('rendering', () => {
  test('opens markdown and hands back the exact bytes', async () => {
    const body = '# Q3\n\nRevenue was up.\n';
    const { id, fragment } = await seed(
      utf8(body),
      'report.md',
      'text/markdown'
    );
    const state = await load(id, deps(fragment));

    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.view.route).toBe('markdown');
    expect(state.view.filename).toBe('report.md');
    expect(new TextDecoder().decode(state.view.content)).toBe(body);
  });

  test('routes code to the code view', async () => {
    const { id, fragment } = await seed(
      utf8('const x = 1;\n'),
      'main.ts',
      'text/plain'
    );
    const state = await load(id, deps(fragment));
    if (state.kind === 'ready') expect(state.view.route).toBe('code');
  });

  test('routes an image to the image view', async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const { id, fragment } = await seed(png, 'chart.png', 'image/png');
    const state = await load(id, deps(fragment));
    if (state.kind === 'ready') expect(state.view.route).toBe('image');
  });

  test('routes html to the usercontent origin, never inline', async () => {
    const { id, fragment } = await seed(
      utf8('<!doctype html><p>hi'),
      'page.html',
      'text/html'
    );
    const state = await load(id, deps(fragment));
    if (state.kind === 'ready') {
      expect(state.view.route).toBe('sandboxed-html');
    }
  });

  test('routes a jsx relic to the usercontent origin, never inline', async () => {
    // The service origin renders markdown, code, and images itself. A
    // component must never join them: it executes, so it belongs on the
    // frame side of the boundary with html.
    const { id, fragment } = await seed(
      utf8('export default function App() {\n  return <div>hi</div>;\n}\n'),
      'App.jsx',
      'text/jsx'
    );
    const state = await load(id, deps(fragment));

    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.view.route).toBe('sandboxed-jsx');
    expect(state.view.route).not.toBe('code');
    expect(state.view.downgradeNotice).toBeUndefined();
  });

  test('routes a tsx relic the same way', async () => {
    const { id, fragment } = await seed(
      utf8(
        'type P = { n: string };\nexport default ({ n }: P) => <h1>{n}</h1>;\n'
      ),
      'Widget.tsx',
      'text/tsx'
    );
    const state = await load(id, deps(fragment));
    if (state.kind === 'ready') expect(state.view.route).toBe('sandboxed-jsx');
  });

  test('an archive is download-only in the first release', async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const { id, fragment } = await seed(zip, 'bundle.zip', 'application/zip');
    const state = await load(id, deps(fragment));
    if (state.kind === 'ready') expect(state.view.route).toBe('download');
  });
});

describe('the declared versus sniffed rule', () => {
  test('HTML wearing an image name renders as an image, not as HTML', async () => {
    // The publisher is the threat. Declaring `.png` on an HTML payload would
    // otherwise win inline rendering on the origin holding the fragment
    // secret, which is fragment theft in one step.
    const { id, fragment } = await seed(
      utf8('<!doctype html><script>steal(location.hash)</script>'),
      'innocent.png',
      'image/png'
    );
    const state = await load(id, deps(fragment));

    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.view.route).not.toBe('sandboxed-html');
    expect(state.view.downgradeNotice).toBeDefined();
  });

  test('tells the recipient when it downgraded', async () => {
    const { id, fragment } = await seed(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
      'notes.md',
      'text/markdown'
    );
    const state = await load(id, deps(fragment));

    if (state.kind === 'ready') {
      expect(state.view.downgradeNotice).toContain('safer way');
      expect(state.view.route).toBe('download');
    }
  });

  test('agreement produces no notice', async () => {
    const { id, fragment } = await seed(
      utf8('# hi'),
      'notes.md',
      'text/markdown'
    );
    const state = await load(id, deps(fragment));
    if (state.kind === 'ready') {
      expect(state.view.downgradeNotice).toBeUndefined();
    }
  });

  test('prose wearing a jsx name renders as source, not as a component', async () => {
    // The declaration alone cannot buy frame rendering: the content-side
    // check must parse, and prose does not. This is the jsx analogue of
    // HTML wearing an image name.
    const { id, fragment } = await seed(
      utf8('just some prose here, not a component at all'),
      'App.jsx',
      'text/jsx'
    );
    const state = await load(id, deps(fragment));

    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.view.route).not.toBe('sandboxed-jsx');
    expect(state.view.route).toBe('code');
    expect(state.view.downgradeNotice).toBeDefined();
  });

  test('a PNG wearing a jsx name renders as an image', async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const { id, fragment } = await seed(png, 'App.jsx', 'text/jsx');
    const state = await load(id, deps(fragment));

    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.view.route).toBe('image');
    expect(state.view.route).not.toBe('sandboxed-jsx');
  });

  test("a jsx declaration cannot upgrade somebody else's plain code", () => {
    // The content-side check only runs when the declared class is jsx, so
    // ordinary code files keep their quiet code route with no spurious
    // downgrade notice.
    const plain = utf8('const a = 1;\nif (a < 2) console.log(a);\n');
    const decision = routeFor('script.js', 'text/plain', plain);
    expect(decision.route).toBe('code');
    expect(decision.notice).toBeUndefined();
  });

  test('routeFor never promotes to a more privileged path', () => {
    const html = utf8('<!doctype html><p>x');
    expect(routeFor('x.png', 'image/png', html).route).not.toBe(
      'sandboxed-html'
    );
    expect(routeFor('x.txt', 'text/plain', html).route).not.toBe(
      'sandboxed-html'
    );
  });

  test('an SVG is treated as a web page, because it carries script', () => {
    const svg = utf8('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(routeFor('x.svg', 'image/svg+xml', svg).route).toBe(
      'sandboxed-html'
    );
  });

  test("routeForClass('media') routes to in-browser media player", () => {
    expect(routeForClass('media')).toBe('media');
  });

  test('media files route to media playback instead of download', () => {
    const dummy = utf8('fake media content');
    expect(routeFor('video.mp4', 'video/mp4', dummy).route).toBe('media');
    expect(routeFor('audio.mp3', 'audio/mpeg', dummy).route).toBe('media');
    expect(routeFor('clip.webm', 'video/webm', dummy).route).toBe('media');
    expect(routeFor('track.wav', 'audio/wav', dummy).route).toBe('media');
  });
});

describe('failure states', () => {
  test('a wrong key does not claim the key is wrong', async () => {
    const { id } = await seed(utf8('# hi'), 'notes.md', 'text/markdown');
    const { encodeFragment } = await import('@relic/format');
    const state = await load(id, deps(encodeFragment(generateKey())));

    expect(state.kind).toBe('dead');
    if (state.kind !== 'dead') return;
    expect(state.dead.code).toBe('decrypt_failed');
    expect(state.dead.detail.toLowerCase()).not.toContain('wrong key');
    // It says outright that it cannot tell which cause applies.
    expect(state.dead.detail).toContain('no way to tell');
  });

  test('a well-formed wrong key is never remembered as openable', async () => {
    const { id } = await seed(utf8('# hi'), 'notes.md', 'text/markdown');
    const { encodeFragment } = await import('@relic/format');
    const { vault, entries, rememberCalls } = fakeVault();

    const state = await load(
      id,
      deps(encodeFragment(generateKey()), `${SERVICE}/${id}`, vault)
    );

    expect(state.kind).toBe('dead');
    expect(entries.has(id)).toBe(false);
    expect(rememberCalls.has(id)).toBe(false);
  });

  test('a removed relic reads as removed, never as a decrypt failure', async () => {
    const { id, fragment } = await seed(
      utf8('# hi'),
      'notes.md',
      'text/markdown'
    );
    await app.fetch(
      new Request(`${SERVICE}/api/relics/${id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );

    const state = await load(id, deps(fragment));
    expect(state.kind).toBe('dead');
    if (state.kind !== 'dead') return;
    expect(state.dead.code).toBe('relic_removed');
    expect(state.dead.action).toBe('report');
  });

  test('an expired relic reads as expired', async () => {
    const { id, fragment } = await seed(
      utf8('# hi'),
      'notes.md',
      'text/markdown'
    );
    now += 8 * 86_400 * 1000;

    const state = await load(id, deps(fragment));
    if (state.kind === 'dead') expect(state.dead.code).toBe('relic_expired');
  });

  test('viewer validates relicId with parseRelicId and never fetches a non-canonical path', async () => {
    const fetchedUrls: string[] = [];
    const validFragment = encodeFragment(generateKey());
    const customDeps: ViewerDeps = {
      ...deps(validFragment),
      fetch: (async (input: RequestInfo | URL) => {
        const urlStr = typeof input === 'string' ? input : input.toString();
        fetchedUrls.push(urlStr);
        return new Response(JSON.stringify({ code: 'relic_not_found' }), { status: 404 });
      }) as typeof globalThis.fetch,
    };

    const state = await load('../challenge?', customDeps);
    expect(state.kind).toBe('dead');
    if (state.kind === 'dead') {
      expect(state.dead.code).toBe('invalid_relic_id');
    }
    expect(fetchedUrls.length).toBe(0);
  });
});

describe('deadFromProblem', () => {
  test('still-uploading offers a retry and never reads as a dead link', () => {
    const view = deadFromProblem('relic_not_yet_published');
    expect(view.action).toBe('retry');
    expect(view.headline.toLowerCase()).toContain('uploading');
  });

  test('cap exhaustion says waiting will not help', () => {
    expect(deadFromProblem('download_cap_exhausted').detail).toContain(
      'Waiting will not help'
    );
    expect(deadFromProblem('download_cap_exhausted').action).toBe('none');
  });

  test('removal offers the appeal path', () => {
    expect(deadFromProblem('relic_removed').action).toBe('report');
  });

  test('expiry offers no retry, because retrying cannot work', () => {
    expect(deadFromProblem('relic_expired').action).toBe('none');
  });

  test('an unknown code degrades to a retry rather than a lie', () => {
    expect(deadFromProblem('something_new').action).toBe('retry');
  });
});
