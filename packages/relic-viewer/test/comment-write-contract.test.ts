/**
 * The contract the edit, resolve and popover work is built against.
 *
 * Its own file because four slices land on top of it at once: the service
 * grows the write, the client calls it, the frame reports the geometry a
 * popover needs, and the agent surface reports the state. Each of those owns
 * files of its own, and a shared test file is where parallel work collides,
 * so the shape they all agree on is asserted here and nowhere else.
 */

import { describe, expect, test } from 'bun:test';
import { deriveCommentKey, generateKey } from '@relic/format';
import {
  FRAME_RECT_LIMIT_PX,
  FRAME_SELECTION_TEXT_LIMIT_BYTES,
  isActiveMarkMessage,
  isFrameMarkClickMessage,
  isFrameMarkHoverMessage,
  isFrameMarkRectMessage,
  isFramePointMessage,
  isFrameRect,
  isFrameRegionMessage,
  isFrameSelectionClearedMessage,
  isFrameSelectionMessage,
  isTrackMarkMessage,
} from '../src/annotate-frame.ts';
import {
  type CommentEntry,
  type CommentRecord,
  canEditComment,
  canResolveComment,
  commentCipher,
  editComment,
  MAX_BODY_BYTES,
  openEntry,
  resolvedLabel,
  type SessionState,
  setCommentResolved,
} from '../src/comments.ts';
import { localStorageKeyVault } from '../src/main.ts';
import type { ViewerDeps } from '../src/viewer.ts';

const RELIC_ID = 'abcdefghijklmnopqrstuvwxyz';
const COMMENT_ID = 'c1';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

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

function stubDeps(
  handler: (call: Call) => Response,
  calls: Call[]
): ViewerDeps {
  return {
    serviceOrigin: 'https://relik.example',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      return handler(call);
    }) as typeof globalThis.fetch,
    takeFragment: () => '',
    stripFragment: () => {},
    locationHref: `https://relik.example/${RELIC_ID}`,
    keyVault: localStorageKeyVault(memoryStorage(), () => 1_000),
  };
}

function problem(code: string, status: number): Response {
  return new Response(JSON.stringify({ code, title: code }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

async function cipher() {
  return commentCipher(await deriveCommentKey(generateKey()));
}

describe('the geometry the frame reports', () => {
  test('a rect is four finite numbers, and negative origins are real', () => {
    expect(isFrameRect({ left: -40, top: -12, width: 100, height: 20 })).toBe(
      true
    );
  });

  test('a rect with negative extent is refused', () => {
    expect(isFrameRect({ left: 0, top: 0, width: -1, height: 20 })).toBe(false);
  });

  test('a rect past the transport bound is refused', () => {
    expect(
      isFrameRect({
        left: FRAME_RECT_LIMIT_PX + 1,
        top: 0,
        width: 10,
        height: 10,
      })
    ).toBe(false);
  });

  test('a rect carrying infinity is refused', () => {
    expect(
      isFrameRect({
        left: 0,
        top: 0,
        width: Number.POSITIVE_INFINITY,
        height: 1,
      })
    ).toBe(false);
  });

  test('a selection may carry its box and the full text for copying', () => {
    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 'the offer',
        rect: { left: 10, top: 20, width: 80, height: 18 },
        text: 'the offer, at length',
        truncated: false,
      })
    ).toBe(true);
  });

  test('a selection with no geometry is still a selection', () => {
    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 'the offer',
      })
    ).toBe(true);
  });

  test('a copy payload past the transport cap is refused', () => {
    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 'the offer',
        text: 'x'.repeat(FRAME_SELECTION_TEXT_LIMIT_BYTES + 1),
      })
    ).toBe(false);
  });

  test('a selection carrying a malformed box is refused whole', () => {
    expect(
      isFrameSelectionMessage({
        type: 'relic:frame-selection',
        exact: 'the offer',
        rect: { left: 0, top: 0, width: 10 },
      })
    ).toBe(false);
  });

  test('a cleared selection is its own message, not an empty one', () => {
    expect(
      isFrameSelectionClearedMessage({ type: 'relic:frame-selection-cleared' })
    ).toBe(true);
    expect(
      isFrameSelectionClearedMessage({ type: 'relic:frame-selection' })
    ).toBe(false);
  });

  test('hover carries an id on enter and null on leave', () => {
    expect(
      isFrameMarkHoverMessage({
        type: 'relic:frame-mark-hover',
        id: 'c1',
        rect: { left: 1, top: 2, width: 3, height: 4 },
      })
    ).toBe(true);
    expect(
      isFrameMarkHoverMessage({ type: 'relic:frame-mark-hover', id: null })
    ).toBe(true);
    expect(
      isFrameMarkHoverMessage({ type: 'relic:frame-mark-hover', id: '' })
    ).toBe(false);
  });

  test('a click may carry the box the comment should open on', () => {
    expect(
      isFrameMarkClickMessage({
        type: 'relic:frame-mark-click',
        id: 'c1',
        rect: { left: 1, top: 2, width: 3, height: 4 },
      })
    ).toBe(true);
    expect(
      isFrameMarkClickMessage({
        type: 'relic:frame-mark-click',
        id: 'c1',
        rect: { left: 'x', top: 2, width: 3, height: 4 },
      })
    ).toBe(false);
  });

  test('the active mark is one id or none', () => {
    expect(isActiveMarkMessage({ type: 'relic:active-mark', id: 'c1' })).toBe(
      true
    );
    expect(isActiveMarkMessage({ type: 'relic:active-mark', id: null })).toBe(
      true
    );
    expect(isActiveMarkMessage({ type: 'relic:active-mark' })).toBe(false);
  });

  test('frame point message accepts valid box and rejects malformed one', () => {
    expect(
      isFramePointMessage({
        type: 'relic:frame-point',
        x: 0.5,
        y: 0.5,
        box: { left: 10, top: 20, width: 20, height: 20 },
      })
    ).toBe(true);
    expect(
      isFramePointMessage({
        type: 'relic:frame-point',
        x: 0.5,
        y: 0.5,
        box: { left: 10, top: 20, width: -1, height: 20 },
      })
    ).toBe(false);
  });

  test('frame region message accepts valid box and rejects malformed one', () => {
    expect(
      isFrameRegionMessage({
        type: 'relic:frame-region',
        rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        box: { left: 10, top: 20, width: 30, height: 40 },
      })
    ).toBe(true);
    expect(
      isFrameRegionMessage({
        type: 'relic:frame-region',
        rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        box: { left: 10, top: 20, width: 30, height: 'bad' },
      })
    ).toBe(false);
  });

  test('track mark message accepts null, valid id, and rejects non-strings', () => {
    expect(isTrackMarkMessage({ type: 'relic:track-mark', id: null })).toBe(
      true
    );
    expect(isTrackMarkMessage({ type: 'relic:track-mark', id: 'm1' })).toBe(
      true
    );
    expect(isTrackMarkMessage({ type: 'relic:track-mark', id: '' })).toBe(
      false
    );
    expect(isTrackMarkMessage({ type: 'relic:track-mark', id: 42 })).toBe(
      false
    );
    expect(isTrackMarkMessage(null)).toBe(false);
  });

  test('frame mark rect message accepts rect and first, and rejects malformed boxes', () => {
    expect(
      isFrameMarkRectMessage({
        type: 'relic:frame-mark-rect',
        id: 'm1',
        rect: { left: 10, top: 20, width: 30, height: 40 },
        first: { left: 10, top: 20, width: 30, height: 20 },
      })
    ).toBe(true);
    expect(
      isFrameMarkRectMessage({
        type: 'relic:frame-mark-rect',
        id: 'm1',
        rect: { left: 'invalid', top: 20, width: 30, height: 40 },
      })
    ).toBe(false);
    expect(
      isFrameMarkRectMessage({
        type: 'relic:frame-mark-rect',
        id: 'm1',
        first: { left: 10, top: 20, width: -5, height: 20 },
      })
    ).toBe(false);
  });
});

describe('editing a comment', () => {
  test('sends the resealed envelope to the comment own url', async () => {
    const calls: Call[] = [];
    const deps = stubDeps(() => new Response(null, { status: 204 }), calls);
    const result = await editComment(
      RELIC_ID,
      COMMENT_ID,
      { body: 'second thoughts', display_name: null, anchor: null },
      deps,
      await cipher()
    );
    expect(result.kind).toBe('edited');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe(
      `https://relik.example/api/relics/${RELIC_ID}/comments/${COMMENT_ID}`
    );
    const body = JSON.parse(calls[0]?.body ?? '{}');
    expect(typeof body.ciphertext).toBe('string');
    expect(body.ciphertext.length).toBeGreaterThan(0);
    // The words are what changed. Resolution is a different write, and
    // bundling it here would settle a comment somebody only reworded.
    expect('resolved' in body).toBe(false);
  });

  test('an over-cap body is refused before anything is encrypted', async () => {
    const calls: Call[] = [];
    const deps = stubDeps(() => new Response(null, { status: 204 }), calls);
    const result = await editComment(
      RELIC_ID,
      COMMENT_ID,
      {
        body: 'x'.repeat(MAX_BODY_BYTES + 1),
        display_name: null,
        anchor: null,
      },
      deps,
      await cipher()
    );
    expect(result.kind).toBe('refused');
    expect(calls).toHaveLength(0);
  });

  test('a refusal keeps the cause the server named', async () => {
    const calls: Call[] = [];
    const deps = stubDeps(() => problem('comment_forbidden', 403), calls);
    const result = await editComment(
      RELIC_ID,
      COMMENT_ID,
      { body: 'not mine', display_name: null, anchor: null },
      deps,
      await cipher()
    );
    expect(result.kind === 'refused' && result.refusal.code).toBe(
      'comment_forbidden'
    );
  });
});

describe('resolving a comment', () => {
  test('sends the state and nothing else', async () => {
    const calls: Call[] = [];
    const deps = stubDeps(() => new Response(null, { status: 204 }), calls);
    const result = await setCommentResolved(RELIC_ID, COMMENT_ID, true, deps);
    expect(result.kind).toBe('changed');
    expect(calls[0]?.method).toBe('PATCH');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ resolved: true });
  });

  test('reopening is the same write with the state inverted', async () => {
    const calls: Call[] = [];
    const deps = stubDeps(() => new Response(null, { status: 204 }), calls);
    await setCommentResolved(RELIC_ID, COMMENT_ID, false, deps);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ resolved: false });
  });
});

describe('what a row says about its own state', () => {
  async function entryFor(
    extra: Partial<CommentRecord>
  ): Promise<CommentEntry> {
    const opener = await cipher();
    const record: CommentRecord = {
      comment_id: COMMENT_ID,
      author: 'reader@example.com',
      created_at: '2026-09-20T00:00:00.000Z',
      ciphertext: await opener.seal({
        body: 'a remark',
        display_name: null,
        anchor: null,
      }),
      ...extra,
    };
    return openEntry(record, opener);
  }

  test('an edit stamp and a resolution both reach the entry', async () => {
    const entry = await entryFor({
      edited_at: '2026-09-20T01:00:00.000Z',
      resolved_at: '2026-09-20T02:00:00.000Z',
      resolved_by: 'reader@example.com',
    });
    expect(entry.editedAt).toBe('2026-09-20T01:00:00.000Z');
    expect(entry.resolution).toEqual({
      at: '2026-09-20T02:00:00.000Z',
      by: 'reader@example.com',
    });
  });

  test('a half-written resolution is not shown as settled', async () => {
    const entry = await entryFor({ resolved_at: '2026-09-20T02:00:00.000Z' });
    expect(entry.resolution).toBeNull();
  });

  test('an untouched comment carries neither', async () => {
    const entry = await entryFor({});
    expect(entry.editedAt).toBeNull();
    expect(entry.resolution).toBeNull();
  });

  test('the resolution label names who settled it', () => {
    expect(
      resolvedLabel({ at: '2026-09-20T02:00:00.000Z', by: 'ada@example.com' })
    ).toBe('Resolved by ada@example.com');
  });
});

describe('which controls a reader is offered', () => {
  const mine: CommentEntry = {
    kind: 'open',
    id: COMMENT_ID,
    author: 'ada@example.com',
    createdAt: '2026-09-20T00:00:00.000Z',
    body: 'mine',
    displayName: null,
    anchor: null,
  };
  const theirs: CommentEntry = { ...mine, id: 'c2', author: 'bob@example.com' };
  const verified: SessionState = { kind: 'verified', email: 'ada@example.com' };

  test('an author may edit and resolve their own', () => {
    expect(canEditComment(mine, verified)).toBe(true);
    expect(canResolveComment(mine, verified)).toBe(true);
  });

  test('neither control is offered on somebody else comment', () => {
    expect(canEditComment(theirs, verified)).toBe(false);
    expect(canResolveComment(theirs, verified)).toBe(false);
  });

  test('an unverified reader is offered nothing', () => {
    expect(canEditComment(mine, { kind: 'anonymous' })).toBe(false);
    expect(canResolveComment(mine, { kind: 'anonymous' })).toBe(false);
    expect(canEditComment(mine, { kind: 'unknown' })).toBe(false);
  });

  test('a sealed comment can be settled but not rewritten', () => {
    const sealedEntry: CommentEntry = {
      kind: 'sealed',
      id: COMMENT_ID,
      author: 'ada@example.com',
      createdAt: '2026-09-20T00:00:00.000Z',
    };
    expect(canEditComment(sealedEntry, verified)).toBe(false);
    expect(canResolveComment(sealedEntry, verified)).toBe(true);
  });
});
