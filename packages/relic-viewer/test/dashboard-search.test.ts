import { describe, expect, test } from 'bun:test';
import {
  encodeFragment,
  encryptRelic,
  generateKey,
  generateRelicId,
} from '@relic/format';
import {
  CONTENT_SEARCH_MAX_BYTES,
  createContentIndex,
  matchRow,
  queryTerms,
  type SearchRow,
  type SearchText,
} from '../src/dashboard-search.ts';
import type { ViewerDeps } from '../src/viewer.ts';
import type { VaultEntry } from '../src/vault.ts';

const enc = new TextEncoder();

interface Seed {
  readonly relicId: string;
  readonly fragment: string;
  readonly ciphertext: Uint8Array;
}

async function seed(
  filename: string,
  mimetype: string,
  content: Uint8Array
): Promise<Seed> {
  const key = generateKey();
  return {
    relicId: generateRelicId(),
    fragment: encodeFragment(key),
    ciphertext: await encryptRelic({ content, filename, mimetype, key }),
  };
}

function serviceFor(seeds: readonly Seed[]): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const entry of seeds) {
      if (url.endsWith(`/api/relics/${entry.relicId}/mint`)) {
        return Response.json({
          url: `https://storage.example/${entry.relicId}`,
          url_expires_at: new Date(Date.now() + 300_000).toISOString(),
          relic_expires_at: null,
          object_length: entry.ciphertext.length,
          object_crc32c: '0',
          mints_remaining: 5,
          version: 1,
          current_version: 1,
        });
      }
      if (url === `https://storage.example/${entry.relicId}`) {
        return new Response(entry.ciphertext as unknown as BodyInit);
      }
    }
    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
}

function depsFor(
  seeds: readonly Seed[],
  remembered: string[] = []
): ViewerDeps {
  const entries: VaultEntry[] = seeds.map((entry) => ({
    relicId: entry.relicId,
    fragment: entry.fragment,
    expiresAt: null,
  }));
  return {
    serviceOrigin: 'https://relic.example',
    fetch: serviceFor(seeds),
    keyVault: {
      remember: (relicId) => {
        remembered.push(relicId);
      },
      recall: (relicId) => entries.find((e) => e.relicId === relicId)?.fragment,
      list: () => entries,
      forget: () => {},
      exportEntries: () => '{}',
      importEntries: () => ({ added: 0, skipped: 0 }),
    },
    takeFragment: () => '',
    stripFragment: () => {},
    locationHref: 'https://relic.example/',
  };
}

const row = (title: string, text?: Partial<SearchRow>): SearchRow => ({
  relicId: 'r',
  title,
  ...text,
});

const body = (text: string): SearchText => ({
  lower: text.toLowerCase(),
  display: text,
});

describe('matchRow', () => {
  test('an empty query matches everything as a title match', () => {
    expect(matchRow(row('Anything'), queryTerms('   '), undefined)).toEqual({
      where: 'title',
    });
  });

  test('a title holding every term is a title match, ignoring case', () => {
    const match = matchRow(
      row('Q3 Launch Plan'),
      queryTerms('launch PLAN'),
      body('launch plan repeated in the body')
    );
    expect(match).toEqual({ where: 'title' });
  });

  test('terms may be split between title and contents', () => {
    const match = matchRow(
      row('Launch plan'),
      queryTerms('launch budget'),
      body('the budget is two hundred')
    );
    expect(match?.where).toBe('content');
  });

  test('a content hit carries a snippet in the original case, around the first term', () => {
    const text = body(
      `${'filler '.repeat(40)}The Migration Window opens Friday${' filler'.repeat(40)}`
    );
    const match = matchRow(row('Notes'), queryTerms('migration'), text);
    expect(match?.where).toBe('content');
    expect(match?.snippet).toContain('The Migration Window opens Friday');
    expect(match?.snippet?.startsWith('…')).toBe(true);
    expect(match?.snippet?.endsWith('…')).toBe(true);
  });

  test('a term found nowhere is no match, and unread contents match nothing', () => {
    expect(
      matchRow(row('Notes'), queryTerms('absent'), body('some body'))
    ).toBeUndefined();
    expect(
      matchRow(row('Notes'), queryTerms('body'), undefined)
    ).toBeUndefined();
  });
});

describe('createContentIndex', () => {
  test('reads decrypted text and finds words that appear only in contents', async () => {
    const md = await seed(
      'plan.md',
      'text/markdown',
      enc.encode('# Plan\n\nThe zanzibar rollout starts Monday.')
    );
    const index = createContentIndex(depsFor([md]));
    await index.ensure(
      [{ relicId: md.relicId, title: 'plan.md', fragment: md.fragment }],
      () => {}
    );
    expect(index.state(md.relicId)).toBe('indexed');
    expect(index.text(md.relicId)?.lower).toContain('zanzibar rollout');
    expect(index.text(md.relicId)?.display).toContain('The zanzibar rollout');
  });

  test('HTML is searched as visible words, not markup or scripts', async () => {
    const html = await seed(
      'page.html',
      'text/html',
      enc.encode(
        '<!doctype html><html><body><h1>Quarterly review</h1>' +
          '<script>const hiddenToken = 1;</script></body></html>'
      )
    );
    const index = createContentIndex(depsFor([html]));
    await index.ensure(
      [{ relicId: html.relicId, title: 'page.html', fragment: html.fragment }],
      () => {}
    );
    const text = index.text(html.relicId)?.lower;
    expect(text).toContain('quarterly review');
    expect(text).not.toContain('hiddentoken');
    expect(text).not.toContain('<h1>');
  });

  test('oversized, non-text and keyless relics are skipped, not failed', async () => {
    const big = await seed(
      'big.md',
      'text/markdown',
      enc.encode('x'.repeat(CONTENT_SEARCH_MAX_BYTES + 1024))
    );
    const bin = await seed(
      'blob.bin',
      'application/octet-stream',
      new Uint8Array([0, 1, 2, 3, 4, 5])
    );
    const index = createContentIndex(depsFor([big, bin]));
    await index.ensure(
      [
        { relicId: big.relicId, title: 'big.md', fragment: big.fragment },
        { relicId: bin.relicId, title: 'blob.bin', fragment: bin.fragment },
        { relicId: 'keyless', title: 'Someone else’s' },
      ],
      () => {}
    );
    expect(index.state(big.relicId)).toBe('skipped');
    expect(index.state(bin.relicId)).toBe('skipped');
    expect(index.state('keyless')).toBe('skipped');
    expect(index.text(big.relicId)).toBeUndefined();
  });

  test('a stale key marks the relic failed and leaves the others searchable', async () => {
    const good = await seed(
      'a.md',
      'text/markdown',
      enc.encode('findable words')
    );
    const stale = await seed(
      'b.md',
      'text/markdown',
      enc.encode('hidden words')
    );
    const index = createContentIndex(depsFor([good, stale]));
    await index.ensure(
      [
        { relicId: good.relicId, title: 'a.md', fragment: good.fragment },
        {
          relicId: stale.relicId,
          title: 'b.md',
          fragment: encodeFragment(generateKey()),
        },
      ],
      () => {}
    );
    expect(index.state(good.relicId)).toBe('indexed');
    expect(index.state(stale.relicId)).toBe('failed');
  });

  test('indexing never rewrites the vault, so recency order is untouched', async () => {
    const md = await seed('c.md', 'text/markdown', enc.encode('anything'));
    const remembered: string[] = [];
    const index = createContentIndex(depsFor([md], remembered));
    await index.ensure(
      [{ relicId: md.relicId, title: 'c.md', fragment: md.fragment }],
      () => {}
    );
    expect(index.state(md.relicId)).toBe('indexed');
    expect(remembered).toEqual([]);
  });

  test('a second ensure does not read a relic twice', async () => {
    const md = await seed('d.md', 'text/markdown', enc.encode('once only'));
    const calls: string[] = [];
    const deps = depsFor([md]);
    const counting: ViewerDeps = {
      ...deps,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(input));
        return deps.fetch(input, init);
      }) as typeof globalThis.fetch,
    };
    const index = createContentIndex(counting);
    const rows = [
      { relicId: md.relicId, title: 'd.md', fragment: md.fragment },
    ];
    await Promise.all([
      index.ensure(rows, () => {}),
      index.ensure(rows, () => {}),
    ]);
    await index.ensure(rows, () => {});
    expect(calls.filter((url) => url.endsWith('/mint'))).toHaveLength(1);
  });
});
