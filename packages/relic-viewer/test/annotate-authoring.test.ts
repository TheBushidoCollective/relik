/**
 * Authoring experience tests across all relic classes.
 *
 * Asserts the four core requirements:
 * 1. Discoverable: The affordance adapts to the artifact and is absent where
 *    nothing can be aimed at.
 * 2. Honest: Controls offered match the artifact's actual capabilities (no
 *    text hints on media or image, no pointing on audio, notes on sandboxed frames).
 * 3. Reachable by keyboard and touch: Keyboard paths for text quote and image
 *    region aiming with visible focus, explicit arming for touch.
 * 4. Re-aimable without losing draft: Moving targets or pressing Escape drops
 *    or changes the target while preserving typed composer text.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MARK_REGION_HINT } from '../src/main.ts';
import {
  clearDom,
  documentNode,
  installDom,
  mount,
  only,
  select,
  textOf,
  withClass,
} from './annotate.test.ts';

describe('authoring discoverability and honesty per artifact class', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('markdown relic offers text quote affordance and point tool', async () => {
    const mounted = await mount({
      filename: 'doc.md',
      declaredMimetype: 'text/markdown',
      route: 'markdown',
    });

    const hints = withClass(mounted.thread, 'thread-hint');
    expect(hints).toHaveLength(1);
    const firstHint = hints[0];
    expect(firstHint ? textOf(firstHint) : '').toBe(
      'Select text in document to quote'
    );

    const pinBtn = only(mounted.thread, 'mark-mode');
    expect(textOf(pinBtn)).toBe('Point at something');
    expect(withClass(mounted.thread, 'mark-time')).toHaveLength(0);
    expect(withClass(mounted.thread, 'mark-region')).toHaveLength(0);
  });

  test('image relic offers region tool and no text selection hint', async () => {
    const mounted = await mount({
      filename: 'photo.png',
      declaredMimetype: 'image/png',
      route: 'image',
    });

    const hints = withClass(mounted.thread, 'thread-hint');
    expect(hints).toHaveLength(0);

    const regionBtn = withClass(mounted.thread, 'mark-region');
    expect(regionBtn).toHaveLength(1);
    const modeBtn = only(mounted.thread, 'mark-mode');
    expect(textOf(modeBtn)).toBe('Mark a region or point');
  });

  test('audio relic offers moment comment and neither point nor text hint', async () => {
    const mounted = await mount({
      filename: 'recording.mp3',
      declaredMimetype: 'audio/mpeg',
      route: 'media',
    });

    const hints = withClass(mounted.thread, 'thread-hint');
    expect(hints).toHaveLength(0);

    // Audio must not offer pointing
    const pinBtns = withClass(mounted.thread, 'mark-pin');
    expect(pinBtns).toHaveLength(0);

    const timeBtn = only(mounted.thread, 'mark-time');
    expect(textOf(timeBtn)).toBe('Comment on this moment');
  });

  test('video relic offers frame comment and no text hint', async () => {
    const mounted = await mount({
      filename: 'movie.mp4',
      declaredMimetype: 'video/mp4',
      route: 'media',
    });

    const hints = withClass(mounted.thread, 'thread-hint');
    expect(hints).toHaveLength(0);

    const timeBtn = only(mounted.thread, 'mark-time');
    expect(textOf(timeBtn)).toBe('Comment on this frame');
  });

  test('sandboxed html frame offers point tool and inside document hint', async () => {
    const mounted = await mount({
      filename: 'index.html',
      declaredMimetype: 'text/html',
      route: 'sandboxed-html',
    });

    const toggle = only(mounted.thread, 'mark-mode');
    expect(textOf(toggle)).toBe('Point at something');

    const hints = withClass(mounted.thread, 'thread-hint');
    expect(hints).toHaveLength(1);
    const firstHint = hints[0];
    expect(firstHint ? textOf(firstHint) : '').toBe(
      'Select text inside document to quote'
    );

    expect(withClass(mounted.thread, 'mark-time')).toHaveLength(0);
  });

  test('download view carries no thread and no aiming controls', async () => {
    const mounted = await mount({
      filename: 'data.bin',
      declaredMimetype: 'application/octet-stream',
      route: 'download',
    });
    const tools = only(mounted.thread, 'thread-tools');
    expect(tools.children).toHaveLength(0);
    expect(withClass(mounted.thread, 'mark-mode')).toHaveLength(0);
    expect(withClass(mounted.thread, 'thread-hint')).toHaveLength(0);
  });
});

describe('keyboard reachability and mark activation', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('selecting text offers a keyboard-reachable quote action in the tools row', async () => {
    const mounted = await mount();

    // Before selection, quote action is absent
    expect(withClass(mounted.thread, 'mark-quote-action')).toHaveLength(0);

    // Make text selection
    select(mounted, 'the second paragraph');

    // Quote action appears in tools row
    const quoteBtn = only(mounted.thread, 'mark-quote-action');
    expect(textOf(quoteBtn)).toBe('Quote selection');

    // Activating quote button takes the target
    quoteBtn.dispatch('click');

    expect(mounted.chip()).toContain('Commenting on "the second paragraph"');
    // Button is dismissed once target is locked
    expect(withClass(mounted.thread, 'mark-quote-action')).toHaveLength(0);
  });

  test('keyboard path reaches image region aiming and locking via Enter', async () => {
    const mounted = await mount({
      filename: 'diagram.png',
      declaredMimetype: 'image/png',
      route: 'image',
    });

    const img = only(mounted.stage, 'relic-image');
    img.rect = {
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
    };

    // Arm region mode
    const modeBtn = only(mounted.thread, 'mark-mode');
    modeBtn.dispatch('click');

    expect(mounted.stage.classes()).toContain('is-pinning');
    const hint = only(mounted.stage, 'mark-hint');
    expect(textOf(hint)).toBe(MARK_REGION_HINT);

    // Keyboard box exists on stage
    expect(withClass(mounted.stage, 'is-keyboard')).toHaveLength(1);

    // Press ArrowRight to nudge keyboard box
    documentNode.dispatch('keydown', { key: 'ArrowRight' });
    // Press Enter to commit region target
    documentNode.dispatch('keydown', { key: 'Enter' });

    expect(mounted.stage.classes()).not.toContain('is-pinning');
    expect(withClass(mounted.stage, 'is-keyboard')).toHaveLength(0);
    expect(withClass(mounted.stage, 'popover-composer')).toHaveLength(1);
    expect(mounted.chip()).toContain('Commenting on the whole document');
  });

  test('keyboard region aiming survives a repaint between arming and the keypress', async () => {
    const mounted = await mount({
      filename: 'diagram.png',
      declaredMimetype: 'image/png',
      route: 'image',
    });

    const img = only(mounted.stage, 'relic-image');
    img.rect = {
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
    };

    // Arm region mode
    const modeBtn = only(mounted.thread, 'mark-mode');
    modeBtn.dispatch('click');

    expect(withClass(mounted.stage, 'is-keyboard')).toHaveLength(1);

    // Repaint happens between arming and the keypress
    mounted.repaint();
    // Keyboard box must survive and remain attached
    expect(withClass(mounted.stage, 'is-keyboard')).toHaveLength(1);

    // Press ArrowRight, ArrowDown, Shift+ArrowRight
    documentNode.dispatch('keydown', { key: 'ArrowRight' });
    documentNode.dispatch('keydown', { key: 'ArrowDown' });
    documentNode.dispatch('keydown', { key: 'ArrowRight', shiftKey: true });

    // Press Enter to commit region target
    documentNode.dispatch('keydown', { key: 'Enter' });

    expect(mounted.stage.classes()).not.toContain('is-pinning');
    expect(withClass(mounted.stage, 'is-keyboard')).toHaveLength(0);
    expect(withClass(mounted.stage, 'popover-composer')).toHaveLength(1);
    expect(mounted.chip()).toContain('Commenting on the whole document');
    expect(
      withClass(mounted.stage, 'is-pending').length
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('re-aiming preserves composer text', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('re-aiming from one target to another preserves composer draft', async () => {
    const mounted = await mount();

    // Set first target: a point
    only(mounted.thread, 'mark-mode').dispatch('click');
    mounted.content.dispatch('click', { clientX: 300, clientY: 200 });

    const field = only(mounted.stage, 'popover-field');
    field.value =
      'First draft sentence. Second draft sentence. Third draft sentence.';

    // Re-aim at another point (same document family)
    only(mounted.thread, 'mark-mode').dispatch('click');
    mounted.content.dispatch('click', { clientX: 500, clientY: 400 });

    // Draft text must be preserved after re-aiming in the stage composer
    expect(only(mounted.stage, 'popover-field')).toBe(field);
    expect(field.value).toBe(
      'First draft sentence. Second draft sentence. Third draft sentence.'
    );
  });

  test('dropping target via clear button preserves composer draft', async () => {
    const mounted = await mount();

    const textarea = only(mounted.thread, 'compose-textarea');
    textarea.value = 'Draft note to keep.';

    select(mounted, 'the second paragraph');
    only(mounted.thread, 'mark-quote-action').dispatch('click');

    expect(mounted.chip()).toContain('Commenting on "the second paragraph"');

    // Click Clear button on chip
    only(mounted.thread, 'compose-target-clear').dispatch('click');

    expect(mounted.chip()).toContain('Commenting on the whole document');
    expect(textarea.value).toBe('Draft note to keep.');
  });
});

describe('escape cancels target and aiming while keeping draft', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('escape cancels locked target and keeps composer draft', async () => {
    const mounted = await mount();

    const textarea = only(mounted.thread, 'compose-textarea');
    textarea.value = 'Preserved draft across escape.';

    select(mounted, 'the second paragraph');
    only(mounted.thread, 'mark-quote-action').dispatch('click');

    expect(mounted.chip()).toContain('Commenting on "the second paragraph"');

    // Press Escape
    documentNode.dispatch('keydown', { key: 'Escape' });

    expect(mounted.chip()).toContain('Commenting on the whole document');
    expect(textarea.value).toBe('Preserved draft across escape.');
  });

  test('escape while armed cancels aiming gesture and keeps composer draft', async () => {
    const mounted = await mount();

    const textarea = only(mounted.thread, 'compose-textarea');
    textarea.value = 'Draft during arming.';

    // Arm the tool
    const modeBtn = only(mounted.thread, 'mark-mode');
    modeBtn.dispatch('click');

    expect(mounted.stage.classes()).toContain('is-pinning');
    expect(modeBtn.getAttribute('aria-pressed')).toBe('true');

    // Press Escape to cancel aiming
    documentNode.dispatch('keydown', { key: 'Escape' });

    expect(mounted.stage.classes()).not.toContain('is-pinning');
    expect(modeBtn.getAttribute('aria-pressed')).toBe('false');
    expect(textarea.value).toBe('Draft during arming.');
  });
});
