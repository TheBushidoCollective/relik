/**
 * Moving through a comparison.
 *
 * What the control says and which pane it sends the request to are asserted
 * here. Whether the pane actually scrolls is a browser question and is
 * proven in one.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ChangeJump } from '../src/domdiff.ts';
import { diffTrees } from '../src/domdiff.ts';
import {
  buildChangeNav,
  CHANGE_JUMP_TOP,
  paneForJump,
  revealChangeIn,
} from '../src/main.ts';
import type { TreeNode } from '../src/rendered-tree.ts';
import { clearDom, installDom, Node } from './annotate.test.ts';

function element(tag: string, ...children: TreeNode[]): TreeNode {
  return { tag, text: '', attrs: [], children };
}

function text(value: string): TreeNode {
  return { tag: '#text', text: value, attrs: [], children: [] };
}

const JUMPS: readonly ChangeJump[] = [
  { side: 'after', changeId: 'c0', kind: 'added' },
  { side: 'before', changeId: 'c1', kind: 'removed' },
  { side: 'after', changeId: 'c2', kind: 'changed' },
];

function nav(jumps: readonly ChangeJump[] = JUMPS) {
  const asked: { id: string; side: string; top: number }[] = [];
  const handle = buildChangeNav({
    reveal: (jump, top) => {
      asked.push({ id: jump.changeId, side: jump.side, top });
      return true;
    },
  });
  handle.setJumps(jumps);
  return { handle, asked };
}

function positionText(element: { children: Node[] }): string {
  const found = element.children.find((child) =>
    child.classes().includes('compare-nav-position')
  );
  return found?.textContent ?? '';
}

describe('moving through the changes', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('before the diff lands it does not claim there is nothing', () => {
    // Two different facts: nobody has compared yet, and there is nothing to
    // find. Saying the second while the first is true is the page telling a
    // reader their versions are identical before it has looked.
    const handle = buildChangeNav({ reveal: () => true });
    expect(
      positionText(handle.element as unknown as { children: Node[] })
    ).toBe('Comparing');
    handle.setJumps([]);
    expect(
      positionText(handle.element as unknown as { children: Node[] })
    ).toBe('No changes');
  });

  test('it says where you are, because next alone answers nothing', () => {
    const { handle } = nav();
    expect(
      positionText(handle.element as unknown as { children: Node[] })
    ).toBe('3 changes');
    handle.step(1);
    expect(
      positionText(handle.element as unknown as { children: Node[] })
    ).toBe('Change 1 of 3');
  });

  test('forward from nothing is the first, backward from nothing is the last', () => {
    const forward = nav();
    forward.handle.step(1);
    expect(forward.asked[0]?.id).toBe('c0');

    const backward = nav();
    backward.handle.step(-1);
    expect(backward.asked[0]?.id).toBe('c2');
  });

  test('it asks the pane that holds the change, not always the newer one', () => {
    const { handle, asked } = nav();
    handle.step(1);
    handle.step(1);
    // A removal exists only in the older version. Asking the newer pane for
    // it would send the reader nowhere and report success.
    expect(asked[1]).toEqual({
      id: 'c1',
      side: 'before',
      top: CHANGE_JUMP_TOP,
    });
  });

  test('it wraps, so pressing on is never silently the end', () => {
    const { handle, asked } = nav();
    handle.step(1);
    handle.step(1);
    handle.step(1);
    handle.step(1);
    expect(asked.map((a) => a.id)).toEqual(['c0', 'c1', 'c2', 'c0']);
  });

  test('a comparison with no changes offers nothing to press', () => {
    const { handle, asked } = nav([]);
    expect(
      positionText(handle.element as unknown as { children: Node[] })
    ).toBe('No changes');
    handle.step(1);
    expect(asked).toHaveLength(0);
  });

  test('a row in the list goes to its own change', () => {
    const { handle, asked } = nav();
    handle.goTo(2);
    expect(asked[0]?.id).toBe('c2');
    expect(
      positionText(handle.element as unknown as { children: Node[] })
    ).toBe('Change 3 of 3');
  });

  test('it takes an array-like list of stops, as a comparison hands them over', () => {
    // The diff's stops arrive as they are, which need not be a plain array.
    const jumps: ArrayLike<ChangeJump> = {
      length: 2,
      0: { side: 'after', changeId: 'c0', kind: 'added' },
      1: { side: 'before', changeId: 'c1', kind: 'removed' },
    };
    const { handle, asked } = nav([]);
    handle.setJumps(jumps);
    expect(
      positionText(handle.element as unknown as { children: Node[] })
    ).toBe('2 changes');
    handle.step(1);
    handle.step(1);
    handle.step(1);
    expect(asked.map((ask) => ask.id)).toEqual(['c0', 'c1', 'c0']);
  });
});

describe('which pane a stop belongs to', () => {
  test('a removal is asked of the older pane, which is the only one with it', () => {
    expect(
      paneForJump(
        { side: 'before', changeId: 'c1', kind: 'removed' },
        'older',
        'newer'
      )
    ).toBe('older');
  });

  test('an addition and a change are asked of the newer pane', () => {
    expect(
      paneForJump(
        { side: 'after', changeId: 'c0', kind: 'added' },
        'older',
        'newer'
      )
    ).toBe('newer');
    expect(
      paneForJump(
        { side: 'after', changeId: 'c2', kind: 'changed' },
        'older',
        'newer'
      )
    ).toBe('newer');
  });
});

describe('what a change row points at', () => {
  test('every listed change carries the stop it belongs to', () => {
    const before = element('body', element('p', text('one')));
    const after = element(
      'body',
      element('p', text('one')),
      element('p', text('two'))
    );
    const diff = diffTrees(before, after);
    const listed = diff.changes[0];
    expect(listed?.jumpIndex).toBe(0);
    expect(diff.jumps[listed?.jumpIndex ?? -1]?.side).toBe('after');
  });

  test('a removal is a stop on the older side', () => {
    const before = element(
      'body',
      element('p', text('one')),
      element('p', text('gone'))
    );
    const after = element('body', element('p', text('one')));
    const diff = diffTrees(before, after);
    expect(diff.jumps.map((jump) => jump.side)).toEqual(['before']);
    expect(diff.jumps[0]?.kind).toBe('removed');
  });
});

describe('putting a change where the reader is looking', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('the pane scrolls by the difference, not to the element top', () => {
    const pane = new Node('div');
    pane.rect = {
      left: 0,
      top: 100,
      right: 800,
      bottom: 700,
      width: 800,
      height: 600,
    };
    pane.scrollTop = 400;
    pane.scrollHeight = 4000;
    pane.clientHeight = 600;
    const marked = new Node('p');
    marked.dataset['relicChangeId'] = 'c7';
    marked.className = '';
    marked.setAttribute('data-relic-change-id', 'c7');
    marked.rect = {
      left: 0,
      top: 900,
      right: 800,
      bottom: 940,
      width: 800,
      height: 40,
    };
    pane.appendChild(marked);

    const moved = revealChangeIn(
      pane as unknown as HTMLElement,
      'c7',
      CHANGE_JUMP_TOP
    );
    expect(moved).toBe(true);
    // 800 below the pane's own top, asked for 120: scroll 680 further than
    // the 400 it was already at.
    expect(pane.scrollTop).toBe(1080);
    expect(marked.classes()).toContain('is-current-change');
  });

  test('a change this pane does not hold is reported as not landed', () => {
    const pane = new Node('div');
    expect(
      revealChangeIn(pane as unknown as HTMLElement, 'c9', CHANGE_JUMP_TOP)
    ).toBe(false);
  });
});
