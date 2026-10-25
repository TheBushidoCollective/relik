/**
 * A comment on the timeline is written in a popover over the scrubber.
 *
 * The player's half (what `relic:time-aim` carries, and that it never leaves
 * fullscreen) is proven in `media-player.test.ts`. This file proves the
 * page's half against the real thread and the real mark controls: what the
 * page does with an aim, a re-aim, a post, a marker press and a cluster.
 * Where the panel lands on a screen is proven in a browser, which this
 * harness is not.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CommentAnchor } from '@relic/format';
import {
  clearDom,
  documentNode,
  installDom,
  type Mounted,
  mount,
  Node,
  only,
  textOf,
  withClass,
} from './annotate.test.ts';

type TimeAnchor = Extract<CommentAnchor, { kind: 'time' }>;

/** The scrubber's moment, in viewport pixels, as the player reports it. */
const AT = { left: 300, top: 500, width: 0, height: 24 };

function aimAt(
  mounted: Mounted,
  anchor: TimeAnchor,
  focus = true,
  box = AT
): void {
  mounted.content.dispatch('relic:time-aim', {
    detail: { anchor, focus, measure: () => box },
  });
}
function aimOtio(
  mounted: Mounted,
  anchor: Extract<CommentAnchor, { kind: 'otio' }>,
  focus: boolean,
  band: { left: number; top: number; width: number; height: number }
): void {
  mounted.content.dispatch('relic:otio-aim', {
    detail: {
      anchor,
      focus,
      measure: () => AT,
      measureBounds: () => band,
    },
  });
}

const expanded = (mounted: Mounted): string | null =>
  only(mounted.thread, 'thread-toggle').getAttribute('aria-expanded');

describe('a time comment in the thread', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('stops saying its mark cannot be shown once the media can place it', async () => {
    const mounted = await mount({}, 'verified', [
      { id: 't1', body: 'Bars jump.', anchor: { kind: 'time', t: 3.5 } },
    ]);
    // The player is on the stage before its media knows how long it is,
    // which is how every media relic opens.
    const video = new Node('video');
    video.className = 'media-player media-video relic-media';
    const media = video as unknown as { duration: number };
    media.duration = Number.NaN;
    mounted.stage.appendChild(video);
    // A load of the thread with the stage attached, as the page's first one
    // is. A time mark cannot be placed without a duration, so its row says
    // the mark cannot be shown, which is true for a moment and no longer.
    await mounted.post('About the whole thing.');
    expect(withClass(mounted.thread, 'comment-unplaceable')).toHaveLength(1);

    // The metadata lands, the time adapter paints the mark itself, and says
    // so the way it does in a browser.
    media.duration = 20;
    mounted.stage.dispatch('relic-repaint');

    expect(withClass(mounted.thread, 'comment-unplaceable')).toHaveLength(0);
    expect(withClass(mounted.stage, 'time-marker')).toHaveLength(1);
  });
});

describe('writing on the timeline', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('an aim opens the composer over the moment, not the sidebar', async () => {
    const mounted = await mount();
    aimAt(mounted, { kind: 'time', t: 6 });

    const panel = only(mounted.stage, 'popover-card');
    expect(textOf(only(panel, 'popover-target'))).toBe('Commenting at 0:06');
    expect(only(panel, 'popover-field').focused).toBe(true);
    // Centred on the moment the player measured, which is the whole reason
    // the aim carries geometry at all.
    expect(panel.style.left).toBe(`${AT.left - panel.offsetWidth / 2}px`);
    expect(expanded(mounted)).toBe('false');
    expect(mounted.chip()).toContain('Commenting on the whole document');
  });

  test('a reader with no verified address is sent to the sidebar', async () => {
    const mounted = await mount({}, 'anonymous');
    aimAt(mounted, { kind: 'time', t: 6 });

    expect(withClass(mounted.stage, 'popover')).toHaveLength(0);
    expect(expanded(mounted)).toBe('true');
    expect(mounted.chip()).toContain('Commenting at 0:06');
  });

  test('a span re-aimed with words typed keeps the words and moves the target', async () => {
    const mounted = await mount();
    aimAt(mounted, { kind: 'time', t: 4, t_end: 6 });
    const field = only(mounted.stage, 'popover-field');
    field.value = 'Holds too long.';

    // The end handle moving sends an aim that does not take focus.
    field.focused = false;
    aimAt(mounted, { kind: 'time', t: 4, t_end: 7.5 }, false, {
      ...AT,
      width: 90,
    });

    expect(only(mounted.stage, 'popover-field')).toBe(field);
    expect(field.value).toBe('Holds too long.');
    expect(field.focused).toBe(false);
    expect(textOf(only(mounted.stage, 'popover-target'))).toBe(
      'Commenting at 0:04 to 0:07'
    );
  });

  test('posting from the panel sends the target it holds at the press', async () => {
    const mounted = await mount();
    aimAt(mounted, { kind: 'time', t: 4, t_end: 6 });
    aimAt(mounted, { kind: 'time', t: 4, t_end: 7.5 }, false);

    const posted = await mounted.postInPanel('Holds too long.');

    expect(posted.anchor).toEqual({ kind: 'time', t: 4, t_end: 7.5 });
    expect(withClass(mounted.stage, 'popover')).toHaveLength(0);
  });

  test('escape puts the composer down', async () => {
    const mounted = await mount();
    aimAt(mounted, { kind: 'time', t: 6 });
    expect(withClass(mounted.stage, 'popover-field')).toHaveLength(1);
    documentNode.dispatch('keydown', { key: 'Escape' });
    expect(withClass(mounted.stage, 'popover')).toHaveLength(0);
  });

  test('in stage fullscreen the composer opens inside the stage, and fullscreen is kept', async () => {
    const mounted = await mount();
    const film = new Node('div');
    film.className = 'media-stage';
    mounted.stage.appendChild(film);
    let exits = 0;
    const doc = (globalThis as unknown as { document: Record<string, unknown> })
      .document;
    doc['fullscreenElement'] = film;
    doc['exitFullscreen'] = async () => {
      exits += 1;
    };

    aimAt(mounted, { kind: 'time', t: 6 });
    const panel = only(mounted.stage, 'popover-card');
    expect(panel.parent).toBe(film);
    expect(exits).toBe(0);
  });

  test('a reader with no address in fullscreen is brought out to the sidebar', async () => {
    const mounted = await mount({}, 'anonymous');
    const film = new Node('div');
    mounted.stage.appendChild(film);
    const doc = (globalThis as unknown as { document: Record<string, unknown> })
      .document;
    doc['fullscreenElement'] = film;
    const left = Promise.withResolvers<void>();
    doc['exitFullscreen'] = async () => {
      doc['fullscreenElement'] = null;
      left.resolve();
    };

    aimAt(mounted, { kind: 'time', t: 6 });
    // Nothing is aimed until fullscreen has gone, because the sidebar the aim
    // opens cannot be seen until it has.
    expect(expanded(mounted)).toBe('false');
    await left.promise;
    // The aim runs in the continuation of the exit's own promise.
    for (let turn = 0; turn < 4; turn++) await Promise.resolve();

    expect(expanded(mounted)).toBe('true');
    expect(mounted.chip()).toContain('Commenting at 0:06');
  });
});

describe('a bounded OTIO composer', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  test('re-aim retains its panel, field, draft, focus policy and most recent target', async () => {
    const mounted = await mount();
    const base: Extract<CommentAnchor, { kind: 'otio' }> = {
      kind: 'otio',
      v: 1,
      relic_version: 1,
      document_sha256: 'a'.repeat(64),
      timeline_id: 'timeline',
      track_id: 'track-a',
      range: {
        start_time: { value: 4, rate: 24 },
        duration: { value: 0, rate: 24 },
      },
      snapshot: { timeline: 'A', track: 'A', item: null },
    };
    const oldBand = { left: 20, top: 30, width: 400, height: 220 };
    aimOtio(mounted, base, true, oldBand);
    const panel = only(mounted.stage, 'popover-card');
    const field = only(panel, 'popover-field');
    field.value = 'The target moves.';
    field.focused = false;
    const latest = {
      ...base,
      track_id: 'track-b',
      range: {
        start_time: { value: 6, rate: 24 },
        duration: { value: 2, rate: 24 },
      },
      snapshot: { ...base.snapshot, track: 'B' },
    };
    aimOtio(mounted, latest, false, { ...oldBand, top: 48 });
    expect(only(mounted.stage, 'popover-card')).toBe(panel);
    expect(only(panel, 'popover-field')).toBe(field);
    expect(field.value).toBe('The target moves.');
    expect(field.focused).toBe(false);
    const posted = await mounted.postInPanel(field.value);
    expect(posted.anchor).toEqual(latest);
  });
  test('fullscreen re-show retains the live bounds policy and a new panel clears it', async () => {
    const doc = Reflect.get(globalThis, 'document') as unknown as {
      addEventListener(type: string, listener: (event: Event) => void): void;
      fullscreenElement?: Node | null;
    };
    const originalAddListener = doc.addEventListener;
    let fullscreenListener: ((event: Event) => void) | undefined;
    doc.addEventListener = (type, listener) => {
      originalAddListener(type, listener);
      if (type === 'fullscreenchange') fullscreenListener = listener;
    };
    const mounted = await mount();
    const base: Extract<CommentAnchor, { kind: 'otio' }> = {
      kind: 'otio',
      v: 1,
      relic_version: 1,
      document_sha256: 'a'.repeat(64),
      timeline_id: 'timeline',
      track_id: 'track-a',
      range: {
        start_time: { value: 4, rate: 24 },
        duration: { value: 0, rate: 24 },
      },
      snapshot: { timeline: 'A', track: 'A', item: null },
    };
    aimOtio(mounted, base, true, { left: 20, top: 30, width: 400, height: 220 });
    const panel = only(mounted.stage, 'popover-card');
    const field = only(panel, 'popover-field');
    field.value = 'The fullscreen draft remains.';
    expect(panel.style.top).toBe('532px');
    const preview = new Node('div');
    mounted.stage.appendChild(preview);
    expect(fullscreenListener).toBeDefined();
    doc.fullscreenElement = preview;
    fullscreenListener?.(new Event('fullscreenchange'));
    expect(panel.parent).toBe(preview);
    expect(only(preview, 'popover-field')).toBe(field);
    expect(field.value).toBe('The fullscreen draft remains.');
    expect(panel.style.top).toBe('532px');
    aimOtio(mounted, { ...base, track_id: 'track-b' }, false, {
      left: 20,
      top: 48,
      width: 400,
      height: 220,
    });
    expect(only(preview, 'popover-field')).toBe(field);
    expect(field.value).toBe('The fullscreen draft remains.');
    expect(panel.style.top).toBe('532px');
    documentNode.dispatch('keydown', { key: 'Escape' });
    doc.fullscreenElement = null;
    aimAt(mounted, { kind: 'time', t: 6 });
    expect(only(mounted.stage, 'popover-card').style.top).toBe('532px');
  });
});

describe('a marker on the timeline', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  const SEEDS = [
    { id: 'c1', body: 'Counter digits blur.', anchor: { kind: 'time', t: 15 } },
    {
      id: 'c2',
      body: 'The tone drops out.',
      anchor: { kind: 'time', t: 15.2 },
    },
    { id: 'c3', body: 'Fade starts early.', anchor: { kind: 'time', t: 15.4 } },
  ] as const;

  /** A marker the way `annotate-time.ts` paints one onto the scrubber. */
  function marker(mounted: Mounted, id: string, members?: string[]): Node {
    const button = new Node('button');
    button.className = members
      ? 'time-marker time-marker-cluster'
      : 'time-marker';
    button.dataset['commentId'] = id;
    if (members) {
      button.dataset['clusterMembers'] = members.join(' ');
      for (const member of members) {
        const child = new Node('span');
        child.dataset['commentId'] = member;
        button.appendChild(child);
      }
    }
    mounted.stage.appendChild(button);
    return button;
  }

  test('pressing a marker opens its card, with its reply', async () => {
    const mounted = await mount({}, 'verified', [...SEEDS]);
    marker(mounted, 'c1').dispatch('click');

    const card = only(mounted.stage, 'popover-card');
    expect(card.dataset['commentId']).toBe('c1');
    expect(withClass(card, 'popover-reply')).toHaveLength(1);
  });

  test('a focus moving into the card does not rebuild it around the reply', async () => {
    const mounted = await mount({}, 'verified', [...SEEDS]);
    marker(mounted, 'c1').dispatch('click');
    only(mounted.stage, 'popover-reply').dispatch('click');
    const field = only(mounted.stage, 'popover-field');

    field.dispatch('focusin');

    expect(only(mounted.stage, 'popover-field')).toBe(field);
  });

  test('a cluster lists every member, and each one opens its own card', async () => {
    const mounted = await mount({}, 'verified', [...SEEDS]);
    marker(mounted, 'c1', ['c1', 'c2', 'c3']).dispatch('click');

    const picks = withClass(mounted.stage, 'popover-member');
    expect(picks.map((pick) => pick.dataset['memberId'])).toEqual([
      'c1',
      'c2',
      'c3',
    ]);
    expect(textOf(only(mounted.stage, 'popover-target'))).toBe(
      '3 comments around 0:15'
    );

    picks[1]?.dispatch('click');
    expect(only(mounted.stage, 'popover-card').dataset['commentId']).toBe('c2');
  });

  test('a marker pressed while the composer holds words leaves the words alone', async () => {
    const mounted = await mount({}, 'verified', [...SEEDS]);
    aimAt(mounted, { kind: 'time', t: 6 });
    const field = only(mounted.stage, 'popover-field');
    field.value = 'Half a sentence';

    marker(mounted, 'c1').dispatch('click');

    expect(only(mounted.stage, 'popover-field')).toBe(field);
    expect(field.value).toBe('Half a sentence');
  });
});
