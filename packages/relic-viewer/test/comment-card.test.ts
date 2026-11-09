/**
 * The conversation, opened on the thing it is about.
 *
 * What a reader can see and press is asserted here; where the panel lands in
 * pixels is asserted in `popover.test.ts`, against arithmetic, and what it
 * looks like is proven in a browser, which is the only place it can be.
 *
 * The harness comes from `annotate.test.ts` so both files mount the relic
 * the way `renderReady` does. A second harness would let this file pass
 * against wiring the page does not have.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { MARK_HOVER_OPEN_MS } from '../src/main.ts';
import { MAX_BODY_BYTES } from '../src/comments.ts';
import {
  clearDom,
  documentNode,
  installDom,
  mount,
  type Mounted,
  Node,
  only,
  withClass,
  textOf,
} from './annotate.test.ts';

/**
 * A point rather than a quote.
 *
 * Both carry the same `data-comment-id`, which is what the card is found
 * by, and a point is a real element in this harness where a wrapped quote
 * needs text nodes the stub does not model. The quote path is proven where
 * it can be: in a browser, and in `annotate-quote.test.ts`.
 */
const PINNED = { kind: 'pin' as const, x: 0.4, y: 0.375 };

describe('pointing at a mark', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('resting on it opens the comment that covers it', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'this line is wrong', anchor: PINNED },
    ]);
    const mark = only(mounted.stage, 'comment-pin');
    // The delay is real behaviour: without it, crossing a paragraph of
    // marked text flashes a card per word. The clock is driven rather than
    // waited on, so the test does not pay for it on every run.
    jest.useFakeTimers();
    mark.dispatch('mouseover');
    expect(withClass(mounted.stage, 'popover-card')).toHaveLength(0);
    jest.advanceTimersByTime(MARK_HOVER_OPEN_MS + 10);
    jest.useRealTimers();

    // Identity rather than body text: this harness does not model
    // `innerHTML`, so the rendered body is empty here whichever way it is
    // built. What it carries is proven in a browser.
    expect(only(mounted.stage, 'popover-card').dataset.commentId).toBe('c1');
  });

  test('the card names the comment it belongs to, so pairing can find it', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'this line is wrong', anchor: PINNED },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');

    expect(only(mounted.stage, 'popover-card').dataset.commentId).toBe('c1');
  });

  test('the mark and its row light together while the card is open', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'this line is wrong', anchor: PINNED },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');

    expect(only(mounted.stage, 'comment-pin').classes()).toContain('is-active');
    expect(withClass(mounted.thread, 'is-active').length).toBeGreaterThan(0);
  });

  test('escape puts it down', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'this line is wrong', anchor: PINNED },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');
    expect(withClass(mounted.stage, 'popover-card')).toHaveLength(1);

    documentNode.dispatch('keydown', { key: 'Escape' });
    expect(withClass(mounted.stage, 'popover-card')).toHaveLength(0);
  });
});

describe('a press inside a panel is not a press on the document', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('a control that replaced its own panel does not close what it opened', async () => {
    // Found in a browser. Pressing Comment removes the offer and opens a
    // composer in one handler, and the stage still receives that press
    // because a browser fixes the propagation path before dispatch. By the
    // time it arrives, the element it came from is detached from every open
    // panel, so asking the open panel whether it contains the target said
    // no and the stage closed what the press had just opened.
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');
    expect(withClass(mounted.stage, 'popover-card')).toHaveLength(1);

    const gone = new Node('div');
    gone.className = 'popover popover-offer';
    const pressed = new Node('button');
    pressed.className = 'popover-action popover-comment';
    gone.appendChild(pressed);
    mounted.stage.dispatch('click', { target: pressed });

    expect(withClass(mounted.stage, 'popover-card')).toHaveLength(1);
  });
});

describe('putting the conversation down', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('dismiss closes only the overlay and the mark reopens the same comment', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    const mark = only(mounted.stage, 'comment-pin');
    mark.dispatch('click');
    const dismiss = only(mounted.stage, 'popover-dismiss');
    expect(dismiss.tagName.toLowerCase()).toBe('button');
    expect(dismiss.textContent).toBe('Dismiss');
    expect(dismiss.getAttribute('aria-label')).toBe('Dismiss comment overlay');
    const requests = mounted.calls.length;

    dismiss.dispatch('click');
    expect(withClass(mounted.stage, 'popover-card')).toHaveLength(0);
    expect(mounted.calls).toHaveLength(requests);
    expect(withClass(mounted.stage, 'comment-pin')).toHaveLength(1);
    mark.dispatch('click');
    expect(only(mounted.stage, 'popover-card').dataset.commentId).toBe('c1');
  });

  test('dismiss is unavailable while a reply draft is open', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');
    only(mounted.stage, 'popover-reply').dispatch('click');
    const field = only(mounted.stage, 'popover-field');
    field.value = 'half a sentence';
    expect(only(mounted.stage, 'popover-dismiss').hidden).toBe(true);
    expect(only(mounted.stage, 'popover-field').value).toBe('half a sentence');
  });

  test('a cluster can be dismissed and reopened without losing members', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'first', anchor: { kind: 'time', t: 15 } },
      { id: 'c2', body: 'second', anchor: { kind: 'time', t: 15.2 } },
    ]);
    const marker = new Node('button');
    marker.className = 'time-marker time-marker-cluster';
    marker.dataset.commentId = 'c1';
    marker.dataset.clusterMembers = 'c1 c2';
    for (const id of ['c1', 'c2']) {
      const child = new Node('span');
      child.dataset.commentId = id;
      marker.appendChild(child);
    }
    mounted.stage.appendChild(marker);
    marker.dispatch('click');
    expect(withClass(mounted.stage, 'popover-member')).toHaveLength(2);
    const requests = mounted.calls.length;
    only(mounted.stage, 'popover-dismiss').dispatch('click');
    expect(withClass(mounted.stage, 'popover-card')).toHaveLength(0);
    expect(mounted.calls).toHaveLength(requests);
    marker.dispatch('click');
    expect(
      withClass(mounted.stage, 'popover-member').map(
        (member) => member.dataset.memberId
      )
    ).toEqual(['c1', 'c2']);
  });

  test('a press away from the card closes it', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');
    expect(withClass(mounted.stage, 'popover-card')).toHaveLength(1);

    const elsewhere = new Node('div');
    documentNode.dispatch('pointerdown', { target: elsewhere });
    expect(withClass(mounted.stage, 'popover-card')).toHaveLength(0);
  });

  test('a press inside the card leaves it alone', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');
    const card = only(mounted.stage, 'popover-card');

    documentNode.dispatch('pointerdown', { target: card });
    expect(withClass(mounted.stage, 'popover-card')).toHaveLength(1);
  });

  test('a press away does not throw away a reply being written', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');
    only(mounted.stage, 'popover-reply').dispatch('click');
    const field = only(mounted.stage, 'popover-field');
    field.value = 'half a sentence';

    const elsewhere = new Node('div');
    documentNode.dispatch('pointerdown', { target: elsewhere });
    // The press meant the margin, not the two sentences, and nothing here
    // could give them back.
    expect(withClass(mounted.stage, 'popover-card')).toHaveLength(1);
  });
});

describe('what the card offers, and to whom', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('your own comment can be edited and resolved', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');

    expect(withClass(mounted.stage, 'popover-edit')).toHaveLength(1);
    expect(withClass(mounted.stage, 'popover-resolve')).toHaveLength(1);
  });

  test('somebody else comment offers neither, because neither would land', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'theirs', anchor: PINNED, author: 'bob@example.com' },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');

    expect(withClass(mounted.stage, 'popover-edit')).toHaveLength(0);
    expect(withClass(mounted.stage, 'popover-resolve')).toHaveLength(0);
    // Replying is offered to anybody, which is the whole point of a thread.
    expect(withClass(mounted.stage, 'popover-reply')).toHaveLength(1);
  });

  test('an unverified reader is offered neither on anybody comment', async () => {
    const mounted = await mount({}, 'anonymous', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');

    expect(withClass(mounted.stage, 'popover-edit')).toHaveLength(0);
    expect(withClass(mounted.stage, 'popover-resolve')).toHaveLength(0);
  });

  test('a settled comment offers to reopen rather than to resolve again', async () => {
    const mounted = await mount({}, 'verified', [
      {
        id: 'c1',
        body: 'mine',
        anchor: PINNED,
        resolvedBy: 'ada@example.com',
      },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');

    expect(only(mounted.stage, 'popover-resolve').textContent).toBe('Reopen');
  });
});

describe('settling a comment', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('resolving sends the state and nothing else', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');
    only(mounted.stage, 'popover-resolve').dispatch('click');
    await mounted.settle();

    const patch = mounted.calls.find((call) => call.method === 'PATCH');
    expect(patch?.url).toContain('/api/relics/');
    expect(patch?.url).toContain('/comments/c1');
    expect(JSON.parse(patch?.body ?? '{}')).toEqual({ resolved: true });
  });

  test('a settled mark goes quiet and stays on the page', async () => {
    const mounted = await mount({}, 'verified', [
      {
        id: 'c1',
        body: 'mine',
        anchor: PINNED,
        resolvedBy: 'ada@example.com',
      },
    ]);
    const mark = only(mounted.stage, 'comment-pin');
    expect(mark.classes()).toContain('is-resolved');
  });

  test('the row says who settled it', async () => {
    const mounted = await mount({}, 'verified', [
      {
        id: 'c1',
        body: 'mine',
        anchor: PINNED,
        resolvedBy: 'ada@example.com',
      },
    ]);
    const badge = only(mounted.thread, 'comment-badge-resolved');
    expect(badge.getAttribute('title')).toBe('Resolved by ada@example.com');
  });
});

describe('editing a comment', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('the new text is sealed and the mark it points at is carried forward', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'first thoughts', anchor: PINNED },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');
    only(mounted.stage, 'popover-edit').dispatch('click');
    expect(withClass(mounted.stage, 'popover-dismiss')).toHaveLength(0);

    const field = only(mounted.stage, 'popover-field');
    expect(field.value).toBe('first thoughts');
    field.value = 'second thoughts';
    only(mounted.stage, 'is-primary').dispatch('click');
    await mounted.settle();

    const patch = mounted.calls.find((call) => call.method === 'PATCH');
    const body = JSON.parse(patch?.body ?? '{}');
    expect(typeof body.ciphertext).toBe('string');
    // An edit changes words, never where they point. Moving the mark would
    // leave every reply answering something the reader can no longer see.
    const opened = await mounted.openSealed(body.ciphertext);
    expect(opened.body).toBe('second thoughts');
    expect(opened.anchor).toEqual(PINNED);
  });

  test('an edited comment says so', async () => {
    const mounted = await mount({}, 'verified', [
      {
        id: 'c1',
        body: 'second thoughts',
        anchor: PINNED,
        editedAt: '2026-08-26T00:00:00Z',
      },
    ]);
    expect(withClass(mounted.thread, 'comment-badge-edited')).toHaveLength(1);
  });
});

describe('the thread and the document are two views of one remark', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('pressing a row opens the comment on the thing it covers', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'this line is wrong', anchor: PINNED },
    ]);
    const row = only(mounted.thread, 'comment');
    row.dispatch('click');

    const card = only(mounted.stage, 'popover-card');
    expect(card.dataset.commentId).toBe('c1');
    expect(only(mounted.stage, 'comment-pin').classes()).toContain('is-active');
  });
});

/** The row action exists at every depth, independently of a placed mark. */
function deleteControl(root: Node, id: string): Node {
  const control = root.querySelector(`[data-delete-comment-id="${id}"]`);
  expect(control).not.toBeNull();
  return control as Node;
}

function confirmRemoval(
  mounted: Mounted,
  id: string,
  root = mounted.thread
): void {
  deleteControl(root, id).dispatch('click');
  const dialog = only(documentNode, 'comment-delete-dialog');
  expect(dialog.tagName).toBe('DIALOG');
  expect(dialog.hasAttribute('open')).toBe(true);
  only(dialog, 'comment-delete-confirm').dispatch('click');
}

describe('deleting only the selected authored comment', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('freeform, sealed and unreadable own rows have Delete without a placed mark', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'free', body: 'whole document', anchor: null },
      { id: 'sealed', body: '', anchor: null, sealed: true },
      { id: 'unreadable', body: '', anchor: null, unreadable: true },
      { id: 'other', body: 'theirs', anchor: null, author: 'bob@example.com' },
      { id: 'publisher', body: 'published', anchor: null, author: 'publisher' },
      { id: 'unknown', body: '', anchor: null, author: '', unreadable: true },
    ]);
    expect(
      withClass(mounted.thread, 'comment-delete').map(
        (control) => control.dataset['deleteCommentId']
      )
    ).toEqual(['free', 'sealed', 'unreadable']);
    expect(withClass(mounted.stage, 'comment-pin')).toHaveLength(0);
    for (const id of ['sealed', 'unreadable']) {
      deleteControl(mounted.thread, id).dispatch('click');
      const dialog = only(documentNode, 'comment-delete-dialog');
      expect(textOf(dialog)).toContain('Comment text unavailable.');
      only(dialog, 'comment-delete-cancel').dispatch('click');
    }
    expect(
      mounted.calls.filter((call) => call.method === 'DELETE')
    ).toHaveLength(0);
  });

  test('Cancel is focused, author and excerpt are text, and Cancel or Escape sends nothing', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: '<img onerror=alert(1)> an excerpt', anchor: PINNED },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');
    const card = only(mounted.stage, 'popover-card');
    deleteControl(card, 'c1').dispatch('click');
    let dialog = only(documentNode, 'comment-delete-dialog');
    expect(only(dialog, 'comment-delete-cancel').focused).toBe(true);
    expect(textOf(dialog)).toContain('ada@example.com');
    expect(textOf(dialog)).toContain('<img onerror=alert(1)> an excerpt');
    expect(dialog.querySelector('img')).toBeNull();
    expect(textOf(dialog)).toContain(
      'This removes only your comment. Replies will stay. Relik has no undo.'
    );
    only(dialog, 'comment-delete-cancel').dispatch('click');
    expect(only(mounted.stage, 'popover-card')).toBe(card);
    deleteControl(card, 'c1').dispatch('click');
    dialog = only(documentNode, 'comment-delete-dialog');
    dialog.dispatch('cancel');
    expect(withClass(documentNode, 'comment-delete-dialog')).toHaveLength(0);
    expect(only(mounted.stage, 'popover-card')).toBe(card);
    expect(
      mounted.calls.filter((call) => call.method === 'DELETE')
    ).toHaveLength(0);
  });

  test('a parent is removed after 204 and its complete surviving subtree is recovered', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'parent', body: 'first', anchor: PINNED },
      {
        id: 'reply',
        body: 'answer',
        anchor: null,
        addresses: 'parent',
        author: 'bob@example.com',
      },
      { id: 'nested', body: 'more', anchor: null, addresses: 'reply' },
    ]);
    const draft = only(mounted.thread, 'compose-textarea');
    draft.value = 'An unrelated draft.';
    confirmRemoval(mounted, 'parent');
    await mounted.idle();

    expect(mounted.calls.filter((call) => call.method === 'DELETE')).toEqual([
      {
        url: 'https://relik.example/api/relics/aaaaaaaaaaaaaaaaaaaaaaaaaa/comments/parent',
        method: 'DELETE',
        body: undefined,
      },
    ]);
    expect(
      withClass(mounted.thread, 'comment').map((row) => row.dataset.commentId)
    ).toEqual(['reply', 'nested']);
    expect(textOf(only(mounted.thread, 'comment-recovery'))).toBe(
      'The parent comment is unavailable. This reply is shown separately.'
    );
    expect(withClass(mounted.thread, 'comment-reply')).toHaveLength(1);
    expect(mounted.counts.slice(-2)).toEqual([2, 2]);
    expect(only(mounted.thread, 'thread-toggle').textContent).toBe(
      '2 comments'
    );
    expect(withClass(mounted.stage, 'comment-pin')).toHaveLength(0);
    expect(only(mounted.thread, 'compose-textarea')).toBe(draft);
    expect(draft.value).toBe('An unrelated draft.');
    expect(
      (await mounted.commentResponse().json()).map(
        (row: { comment_id: string }) => row.comment_id
      )
    ).toEqual(['reply', 'nested']);
  });

  test('deleting an intermediate reply keeps its descendants once as a separate thread', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'a', body: 'first', anchor: PINNED },
      { id: 'b', body: 'answer', anchor: null, addresses: 'a' },
      {
        id: 'c',
        body: 'next',
        anchor: null,
        addresses: 'b',
        author: 'bob@example.com',
      },
      { id: 'd', body: 'last', anchor: null, addresses: 'c' },
    ]);
    confirmRemoval(mounted, 'b');
    await mounted.idle();
    expect(
      withClass(mounted.thread, 'comment').map((row) => row.dataset.commentId)
    ).toEqual(['a', 'c', 'd']);
    expect(withClass(mounted.thread, 'comment-recovery')).toHaveLength(1);
    expect(withClass(mounted.thread, 'comment-reply')).toHaveLength(1);
    expect(withClass(mounted.thread, 'comment-badge-addressed')).toHaveLength(
      1
    );
    expect(mounted.counts.at(-1)).toBe(3);
  });

  test('nested popover replies use the same own-only actions and keep their parent card', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'a', body: 'first', anchor: PINNED, author: 'bob@example.com' },
      { id: 'b', body: 'answer', anchor: null, addresses: 'a' },
      { id: 'c', body: 'next', anchor: null, addresses: 'b' },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');
    const card = only(mounted.stage, 'popover-card');
    expect(
      withClass(card, 'comment-delete').map(
        (control) => control.dataset.deleteCommentId
      )
    ).toEqual(['b', 'c']);
    only(card, 'popover-reply').dispatch('click');
    const draft = only(card, 'popover-field');
    draft.value = 'Still writing this reply.';
    confirmRemoval(mounted, 'c', card);
    await mounted.idle();
    expect(only(mounted.stage, 'popover-card')).toBe(card);
    expect(only(card, 'popover-field')).toBe(draft);
    expect(draft.value).toBe('Still writing this reply.');
    expect(
      withClass(card, 'comment').map((row) => row.dataset.commentId)
    ).toEqual(['a', 'b']);
    expect(mounted.counts.at(-1)).toBe(2);
  });

  test('one pending request disables the same ID in both row placements without optimistic removal', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    const response = Promise.withResolvers<Response>();
    mounted.setDeleteResponse(() => response.promise);
    only(mounted.stage, 'comment-pin').dispatch('click');
    confirmRemoval(mounted, 'c1', only(mounted.stage, 'popover-card'));
    expect(deleteControl(mounted.thread, 'c1').disabled).toBe(true);
    expect(deleteControl(mounted.stage, 'c1').disabled).toBe(true);
    expect(withClass(mounted.thread, 'comment')).toHaveLength(1);
    deleteControl(mounted.stage, 'c1').dispatch('click');
    expect(withClass(documentNode, 'comment-delete-dialog')).toHaveLength(0);
    expect(
      mounted.calls.filter((call) => call.method === 'DELETE')
    ).toHaveLength(1);
    response.resolve(new Response(null, { status: 204 }));
    await mounted.idle();
    expect(withClass(mounted.thread, 'comment')).toHaveLength(0);
    expect(withClass(mounted.stage, 'popover-card')).toHaveLength(0);
  });

  test('a network failure retains confirmed rows and requires a read before another deliberate attempt', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    mounted.setDeleteResponse(() => {
      throw new Error('connection lost');
    });
    confirmRemoval(mounted, 'c1');
    await mounted.idle();
    expect(withClass(mounted.thread, 'comment')).toHaveLength(1);
    expect(deleteControl(mounted.thread, 'c1').disabled).toBe(true);
    expect(textOf(only(mounted.thread, 'comment-delete-outcome'))).toContain(
      'Deletion could not be confirmed.'
    );
    expect(textOf(only(mounted.thread, 'comment-delete-outcome'))).toContain(
      'network'
    );
    expect(textOf(only(mounted.stage, 'comment-delete-notice'))).toContain(
      'Refresh comments'
    );
    const again = withClass(
      only(mounted.thread, 'comment-delete-outcome'),
      'action'
    ).find((control) => control.textContent === 'Refresh comments');
    expect(again).toBeDefined();
    again?.dispatch('click');
    await mounted.idle();
    expect(deleteControl(mounted.thread, 'c1').disabled).toBe(false);
    expect(
      mounted.calls.filter((call) => call.method === 'DELETE')
    ).toHaveLength(1);
  });

  for (const [status, code] of [
    [403, 'comment_forbidden'],
    [401, 'invalid_session'],
    [500, 'internal_error'],
    [200, 'unexpected_success'],
  ] as const) {
    test(`a ${status} response retains the last confirmed thread and names ${code}`, async () => {
      const mounted = await mount({}, 'verified', [
        { id: 'c1', body: 'mine', anchor: PINNED },
      ]);
      const draft = only(mounted.thread, 'compose-textarea');
      draft.value = 'Do not lose this draft.';
      mounted.setDeleteResponse(() => Response.json({ code }, { status }));
      confirmRemoval(mounted, 'c1');
      await mounted.idle();
      expect(withClass(mounted.thread, 'comment')).toHaveLength(1);
      expect(mounted.counts.at(-1)).toBe(1);
      expect(textOf(only(mounted.thread, 'comment-delete-outcome'))).toContain(
        code
      );
      if (status === 401) {
        expect(withClass(mounted.thread, 'comment-delete')).toHaveLength(0);
        await mounted.changeReader('anonymous');
        await mounted.changeReader('verified');
        expect(only(mounted.thread, 'compose-textarea').value).toBe(
          'Do not lose this draft.'
        );
      } else {
        expect(only(mounted.thread, 'compose-textarea')).toBe(draft);
      }
    });
  }

  test('204 followed by a failed read keeps its confirmed removal and every surviving reply', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'a', body: 'first', anchor: PINNED },
      { id: 'b', body: 'reply', anchor: null, addresses: 'a' },
    ]);
    mounted.setCommentRead(() =>
      Response.json({ code: 'service_paused' }, { status: 503 })
    );
    confirmRemoval(mounted, 'a');
    await mounted.idle();
    expect(
      withClass(mounted.thread, 'comment').map((row) => row.dataset.commentId)
    ).toEqual(['b']);
    expect(mounted.counts.at(-1)).toBe(1);
    expect(textOf(only(mounted.thread, 'comment-delete-outcome'))).toContain(
      'Comment deleted.'
    );
    expect(textOf(only(mounted.thread, 'comment-delete-outcome'))).toContain(
      'could not be refreshed'
    );
    expect(withClass(mounted.thread, 'comment-recovery')).toHaveLength(1);
  });

  test('404 reconciles an already absent row without claiming this request deleted it', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    mounted.forgetComment('c1');
    mounted.setDeleteResponse(() =>
      Response.json({ code: 'comment_not_found' }, { status: 404 })
    );
    confirmRemoval(mounted, 'c1');
    await mounted.idle();
    expect(withClass(mounted.thread, 'comment')).toHaveLength(0);
    expect(textOf(only(mounted.thread, 'comment-delete-outcome'))).toContain(
      'already absent'
    );
    expect(
      textOf(only(mounted.thread, 'comment-delete-outcome'))
    ).not.toContain('Comment deleted.');
  });

  test('session discovery and changes repaint permissions without replacing unrelated drafts', async () => {
    const mounted = await mount({}, 'anonymous', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');
    const card = only(mounted.stage, 'popover-card');
    expect(withClass(card, 'comment-delete')).toHaveLength(0);
    await mounted.changeReader('verified');
    expect(only(mounted.stage, 'popover-card')).toBe(card);
    expect(withClass(card, 'comment-delete')).toHaveLength(1);
    expect(withClass(card, 'popover-edit')).toHaveLength(1);
    only(card, 'popover-reply').dispatch('click');
    const reply = only(card, 'popover-field');
    reply.value = 'A reply draft.';
    only(mounted.thread, 'compose-textarea').value = 'A sidebar draft.';
    only(mounted.thread, 'compose-input').value = 'Ada';
    await mounted.changeReader('anonymous');
    expect(withClass(card, 'comment-delete')).toHaveLength(0);
    expect(withClass(card, 'popover-edit')).toHaveLength(0);
    expect(only(card, 'popover-field')).toBe(reply);
    await mounted.changeReader('verified');
    expect(reply.value).toBe('A reply draft.');
    expect(only(mounted.thread, 'compose-textarea').value).toBe(
      'A sidebar draft.'
    );
    expect(only(mounted.thread, 'compose-input').value).toBe('Ada');
  });

  test('a late deletion cannot replace a newer edit panel', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'first', anchor: PINNED },
      { id: 'c2', body: 'second', anchor: { ...PINNED, x: 0.7 } },
    ]);
    const response = Promise.withResolvers<Response>();
    mounted.setDeleteResponse(() => response.promise);
    confirmRemoval(mounted, 'c1');
    const mark = withClass(mounted.stage, 'comment-pin').find(
      (node) => node.dataset.commentId === 'c2'
    );
    mark?.dispatch('click');
    only(mounted.stage, 'popover-edit').dispatch('click');
    const panel = only(mounted.stage, 'popover-card');
    const field = only(panel, 'popover-field');
    field.value = 'A newer edit draft.';
    response.resolve(new Response(null, { status: 204 }));
    await mounted.idle();
    expect(only(mounted.stage, 'popover-card')).toBe(panel);
    expect(only(panel, 'popover-field')).toBe(field);
    expect(field.value).toBe('A newer edit draft.');
    expect(panel.dataset.commentId).toBe('c2');
  });

  test('a read started before acknowledgment cannot resurrect a deleted row', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'first', anchor: PINNED },
      { id: 'c2', body: 'second', anchor: { ...PINNED, x: 0.7 } },
    ]);
    const response = Promise.withResolvers<Response>();
    const olderRead = Promise.withResolvers<Response>();
    const oldSnapshot = mounted.commentResponse();
    let reads = 0;
    mounted.setDeleteResponse(() => response.promise);
    mounted.setCommentRead(() =>
      ++reads === 1 ? olderRead.promise : mounted.commentResponse()
    );
    confirmRemoval(mounted, 'c1');
    withClass(mounted.stage, 'comment-pin')
      .find((node) => node.dataset.commentId === 'c2')
      ?.dispatch('click');
    only(mounted.stage, 'popover-resolve').dispatch('click');
    await mounted.waitFor(() => reads === 1);
    response.resolve(new Response(null, { status: 204 }));
    await mounted.waitFor(() => mounted.counts.length >= 3);
    olderRead.resolve(oldSnapshot);
    await mounted.idle();
    expect(
      withClass(mounted.thread, 'comment').map((row) => row.dataset.commentId)
    ).toEqual(['c2']);
    expect(mounted.counts.at(-1)).toBe(1);
  });

  test('concurrent different-ID deletions can acknowledge in reverse order', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'first', anchor: PINNED },
      { id: 'c2', body: 'second', anchor: null },
    ]);
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    mounted.setDeleteResponse((id) =>
      id === 'c1' ? first.promise : second.promise
    );
    confirmRemoval(mounted, 'c1');
    confirmRemoval(mounted, 'c2');
    second.resolve(new Response(null, { status: 204 }));
    await mounted.waitFor(() => mounted.counts.length >= 3);
    first.resolve(new Response(null, { status: 204 }));
    await mounted.idle();
    expect(withClass(mounted.thread, 'comment')).toHaveLength(0);
    expect(mounted.counts.at(-1)).toBe(0);
    expect(
      mounted.calls.filter((call) => call.method === 'DELETE')
    ).toHaveLength(2);
  });

  test('losing the verified session cancels an open confirmation without deleting', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    only(mounted.thread, 'compose-textarea').value = 'Keep this draft.';
    deleteControl(mounted.thread, 'c1').dispatch('click');
    expect(withClass(documentNode, 'comment-delete-dialog')).toHaveLength(1);
    await mounted.changeReader('anonymous');
    expect(withClass(documentNode, 'comment-delete-dialog')).toHaveLength(0);
    expect(
      mounted.calls.filter((call) => call.method === 'DELETE')
    ).toHaveLength(0);
    await mounted.changeReader('verified');
    expect(only(mounted.thread, 'compose-textarea').value).toBe(
      'Keep this draft.'
    );
  });

  test('the real expired-cookie DELETE refusal rechecks identity and preserves both drafts', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'c1', body: 'mine', anchor: PINNED },
    ]);
    const sidebar = only(mounted.thread, 'compose-textarea');
    sidebar.value = 'Keep the sidebar draft.';
    only(mounted.stage, 'comment-pin').dispatch('click');
    const card = only(mounted.stage, 'popover-card');
    only(card, 'popover-reply').dispatch('click');
    const reply = only(card, 'popover-field');
    reply.value = 'Keep the reply draft.';
    // The server cookie expires without a visibility or auth-broadcast event.
    mounted.setReader('anonymous');
    mounted.setDeleteResponse(() =>
      Response.json({ code: 'comment_forbidden' }, { status: 403 })
    );
    confirmRemoval(mounted, 'c1');
    await mounted.idle();
    expect(mounted.thread.dataset['session']).toBe('anonymous');
    expect(withClass(mounted.thread, 'compose-textarea')).toHaveLength(0);
    expect(withClass(mounted.thread, 'comment-delete')).toHaveLength(0);
    expect(withClass(card, 'popover-edit')).toHaveLength(0);
    expect(only(card, 'popover-field')).toBe(reply);
    expect(reply.value).toBe('Keep the reply draft.');
    expect(
      mounted.calls.filter((call) => call.url.endsWith('/api/auth/session'))
    ).toHaveLength(2);
    expect(await mounted.commentResponse().json()).toHaveLength(1);
    await mounted.changeReader('verified');
    expect(only(mounted.thread, 'compose-textarea').value).toBe(
      'Keep the sidebar draft.'
    );
    expect(
      mounted.calls.filter((call) => call.method === 'DELETE')
    ).toHaveLength(1);
  });

  test('deletion readback refreshes Edit and Resolve against the displayed parent', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 'parent', body: 'old parent text', anchor: PINNED },
      { id: 'child', body: 'reply', anchor: null, addresses: 'parent' },
    ]);
    only(mounted.stage, 'comment-pin').dispatch('click');
    const card = only(mounted.stage, 'popover-card');
    mounted.setDeleteResponse(async () => {
      await mounted.editStoredComment('parent', 'parent text from another tab');
      mounted.setStoredResolved('parent', true);
      return new Response(null, { status: 204 });
    });
    confirmRemoval(mounted, 'child', card);
    await mounted.idle();
    expect(only(mounted.stage, 'popover-card')).toBe(card);
    expect(withClass(card, 'comment-badge-edited')).toHaveLength(1);
    expect(withClass(card, 'comment-badge-resolved')).toHaveLength(1);
    expect(only(card, 'popover-resolve').textContent).toBe('Reopen');
    only(card, 'popover-resolve').dispatch('click');
    await mounted.waitFor(() =>
      withClass(mounted.stage, 'popover-resolve').some(
        (control) => control.textContent === 'Resolve'
      )
    );
    await mounted.idle();
    const resolution = mounted.calls.find((call) => call.method === 'PATCH');
    expect(JSON.parse(resolution?.body ?? '{}')).toEqual({ resolved: false });
    only(mounted.stage, 'popover-edit').dispatch('click');
    expect(only(mounted.stage, 'popover-field').value).toBe(
      'parent text from another tab'
    );
  });

  for (const action of ['popover-edit', 'popover-reply']) {
    test(`a refreshed parent preserves an existing ${action} draft`, async () => {
      const mounted = await mount({}, 'verified', [
        { id: 'parent', body: 'old parent text', anchor: PINNED },
        { id: 'child', body: 'reply', anchor: null, addresses: 'parent' },
      ]);
      only(mounted.stage, 'comment-pin').dispatch('click');
      only(mounted.stage, action).dispatch('click');
      const panel = only(mounted.stage, 'popover-card');
      const field = only(panel, 'popover-field');
      field.value = 'Keep this unposted draft.';
      mounted.setDeleteResponse(async () => {
        await mounted.editStoredComment(
          'parent',
          'parent text from another tab'
        );
        mounted.setStoredResolved('parent', true);
        return new Response(null, { status: 204 });
      });
      confirmRemoval(mounted, 'child');
      await mounted.idle();
      expect(only(mounted.stage, 'popover-card')).toBe(panel);
      expect(only(panel, 'popover-field')).toBe(field);
      expect(field.value).toBe('Keep this unposted draft.');
      if (action === 'popover-reply') {
        expect(only(panel, 'popover-resolve').textContent).toBe('Reopen');
      }
    });
  }

  for (const newerDraft of [undefined, 'A different unposted comment.']) {
    test(`pending sidebar POST survives offer dismissal and ${newerDraft ? 'retains a newer draft' : 'clears only its acknowledged text'}`, async () => {
      const original = new Map<string, PropertyDescriptor | undefined>(
        ['localStorage', 'PublicKeyCredential', 'isSecureContext'].map(
          (key) =>
            [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
        )
      );
      const store = new Map<string, string>();
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => {
            store.set(key, value);
          },
        },
      });
      Object.defineProperty(globalThis, 'PublicKeyCredential', {
        configurable: true,
        value: class {},
      });
      Object.defineProperty(globalThis, 'isSecureContext', {
        configurable: true,
        value: true,
      });
      Reflect.set(
        Reflect.get(globalThis, 'document'),
        'cookie',
        'relic_passkey_offer=1'
      );
      const pending = Promise.withResolvers<Response>();
      let mounted: Mounted | undefined;
      try {
        mounted = await mount();
        const current = mounted;
        await current.waitFor(() =>
          withClass(current.thread, 'passkey-offer').some(
            (offer) => offer.getAttribute('data-state') === 'link-required'
          )
        );
        current.setPostResponse(() => pending.promise);
        const body = only(current.thread, 'compose-textarea');
        body.value = 'Submit this comment once.';
        body.dispatch('input');
        body.closest('.compose')?.dispatch('submit');
        await current.waitFor(() =>
          current.calls.some(
            (call) => call.method === 'POST' && call.url.endsWith('/comments')
          )
        );
        const dismiss = current.thread.querySelector(
          '[data-passkey-offer-dismiss]'
        );
        expect(dismiss).not.toBeNull();
        dismiss?.dispatch('click');
        const replacement = only(current.thread, 'compose-textarea');
        expect(replacement).not.toBe(body);
        const post = withClass(current.thread, 'action').find(
          (control) => control.textContent === 'Post comment'
        );
        expect(post?.disabled).toBe(true);
        replacement.closest('.compose')?.dispatch('submit');
        expect(
          current.calls.filter(
            (call) => call.method === 'POST' && call.url.endsWith('/comments')
          )
        ).toHaveLength(1);
        if (newerDraft !== undefined) {
          replacement.value = newerDraft;
          replacement.dispatch('input');
        }
        pending.resolve(
          Response.json({
            comment_id: 'posted',
            author: 'ada@example.com',
          })
        );
        await current.idle();
        expect(only(current.thread, 'compose-textarea')).toBe(replacement);
        expect(replacement.value).toBe(newerDraft ?? '');
        expect(post?.disabled).toBe(false);
        expect(
          current.calls.filter(
            (call) => call.method === 'POST' && call.url.endsWith('/comments')
          )
        ).toHaveLength(1);
        if (newerDraft === undefined) {
          expect(only(current.thread, 'compose-count').textContent).toBe(
            `0 of ${MAX_BODY_BYTES} bytes`
          );
        }
      } finally {
        pending.resolve(
          Response.json({
            comment_id: 'posted',
            author: 'ada@example.com',
          })
        );
        await mounted?.idle();
        for (const [key, descriptor] of original) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
      }
    });
  }
});
