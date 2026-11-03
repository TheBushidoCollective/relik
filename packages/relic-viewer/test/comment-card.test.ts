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
import {
  clearDom,
  documentNode,
  installDom,
  mount,
  Node,
  only,
  withClass,
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
