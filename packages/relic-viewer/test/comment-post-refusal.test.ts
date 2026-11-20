import { describe, expect, test } from 'bun:test';
import { MalformedCommentError } from '@relic/format';
import {
  editComment,
  type CommentCipher,
  postComment,
} from '../src/comments.ts';
import type { ViewerDeps } from '../src/viewer.ts';
import { localStorageKeyVault } from '../src/main.ts';

/**
 * A pointer the writer refuses (a NUL or CR) reaches the seal, which throws
 * MalformedCommentError. That must come back as a refusal the composer shows,
 * never as an unhandled rejection, and no request may be sent (SF-POINTER-
 * UNWRITABLE, viewer part).
 */

const RELIC_ID = 'abcdefghijklmnopqrstuvwxyz';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as Storage;
}

function depsCounting(sent: string[]): ViewerDeps {
  return {
    serviceOrigin: 'https://relik.example',
    fetch: (async (input: RequestInfo | URL) => {
      sent.push(String(input));
      return new Response('{}', { status: 201 });
    }) as typeof globalThis.fetch,
    takeFragment: () => '',
    stripFragment: () => {},
    locationHref: `https://relik.example/${RELIC_ID}`,
    keyVault: localStorageKeyVault(memoryStorage(), () => 1_000),
  };
}

const refusingCipher: CommentCipher = {
  seal: async () => {
    throw new MalformedCommentError('path anchor pointer contains a NUL or CR');
  },
} as unknown as CommentCipher;

const draft = {
  body: 'Check this key.',
  display_name: null,
  anchor: { kind: 'path', pointer: '/a\rb' },
} as never;

describe('a comment the writer cannot seal is refused, not thrown', () => {
  test('postComment returns a refusal and sends nothing', async () => {
    const sent: string[] = [];
    const result = await postComment(
      RELIC_ID,
      draft,
      depsCounting(sent),
      refusingCipher
    );
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') throw new Error('expected a refusal');
    expect(result.refusal.code).toBe('unwritable_comment');
    expect(result.refusal.retryable).toBe(false);
    expect(sent).toEqual([]);
  });

  test('editComment returns the same refusal', async () => {
    const sent: string[] = [];
    const result = await editComment(
      RELIC_ID,
      'c1',
      draft,
      depsCounting(sent),
      refusingCipher
    );
    expect(result.kind).toBe('refused');
    expect(sent).toEqual([]);
  });

  test('an error that is not a malformed comment is still thrown', async () => {
    const sent: string[] = [];
    const broken = {
      seal: async () => {
        throw new TypeError('the key vanished');
      },
    } as unknown as CommentCipher;
    await expect(
      postComment(RELIC_ID, draft, depsCounting(sent), broken)
    ).rejects.toThrow('the key vanished');
  });
});
