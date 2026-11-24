import { describe, expect, test } from 'bun:test';
import { loadCovers } from '../src/dashboard-covers.ts';
import type { ViewerDeps } from '../src/viewer.ts';

const ORIGIN = 'https://relic.example';
const SHA = 'a'.repeat(64);
const A = 'a'.repeat(26);
const B = 'b'.repeat(26);

function depsAnswering(answer: (url: string) => Response | Promise<Response>): {
  deps: ViewerDeps;
  urls: string[];
} {
  const urls: string[] = [];
  const deps = {
    serviceOrigin: ORIGIN,
    fetch: async (url: string) => {
      urls.push(url);
      return answer(url);
    },
  } as unknown as ViewerDeps;
  return { deps, urls };
}

describe('dashboard covers', () => {
  test('names each relik the service has a cover for, as a URL on the service origin', async () => {
    const { deps, urls } = depsAnswering(() =>
      Response.json({ covers: { [A]: `/${A}/cover/${SHA}.png` } })
    );
    const found = await loadCovers(deps, [A, B]);
    expect([...found]).toEqual([[A, `${ORIGIN}/${A}/cover/${SHA}.png`]]);
    expect(urls).toEqual([`${ORIGIN}/api/covers?ids=${A},${B}`]);
  });

  test('refuses anything that is not a relik cover path on the service', async () => {
    const { deps } = depsAnswering(() =>
      Response.json({
        covers: {
          [A]: 'https://evil.example/x.png',
          [B]: `//evil.example/${B}/cover/${SHA}.png`,
          // An id nobody asked about is never believed.
          ['c'.repeat(26)]: `/${'c'.repeat(26)}/cover/${SHA}.png`,
        },
      })
    );
    expect((await loadCovers(deps, [A, B])).size).toBe(0);
  });

  test('a failed or malformed answer leaves the tiles as they are', async () => {
    for (const answer of [
      () => new Response('no', { status: 500 }),
      () => Response.json({ nope: true }),
      () => new Response('not json'),
      () => {
        throw new Error('offline');
      },
    ]) {
      const { deps } = depsAnswering(answer);
      expect((await loadCovers(deps, [A])).size).toBe(0);
    }
  });

  test('asks in batches the service will answer', async () => {
    const ids = Array.from({ length: 250 }, (_, i) =>
      i.toString(36).padStart(26, '0')
    );
    const { deps, urls } = depsAnswering(() => Response.json({ covers: {} }));
    await loadCovers(deps, ids);
    expect(urls).toHaveLength(3);
  });
});
