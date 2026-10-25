/**
 * Unit tests for the custom accessible media player and comment-bearing timeline.
 *
 * Covers:
 * - Controls completeness and keyboard accessibility (play, pause, seek, mute, fullscreen).
 * - Scrubber slider semantics (role="slider", ARIA value attributes).
 * - Hover affordance updating without seeking, and hover comment action.
 * - Press-release aiming a moment anchor.
 * - Press-drag aiming a span anchor with spanFromDrag bounds.
 * - End handle keyboard stepping via stepSpanEnd and collapsing back to a moment.
 * - Markers painted on the scrubber for moments and spans.
 * - Marker clustering reporting its member count.
 * - Backward compatibility with old time anchor shapes including rect frame boxes.
 * - Fullscreen playback idling to the bare frame, and staying awake while
 *   paused, while the pointer rests on the controls, or while a comment
 *   panel is open on the stage.
 * - Comment actions staying in fullscreen, and aims saying where on the
 *   scrubber their moment or span sits.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import type { AnchorRect, CommentAnchor } from '@relic/format';
import type { AnchorSurface } from '../src/anchoring.ts';
import { paintTimeMark, revealTimeMark } from '../src/annotate-time.ts';
import { createMediaPlayer, FULLSCREEN_IDLE_MS } from '../src/media-player.ts';
import { spanFromDrag, stepSpanEnd } from '../src/media-timeline.ts';

class TestNode {
  readonly tagName: string;
  className = '';
  textContent = '';
  id = '';
  hidden = false;
  tabIndex = 0;
  type = '';
  title = '';
  value = '';
  parent: TestNode | undefined;
  rect = { left: 0, top: 0, right: 640, bottom: 24, width: 640, height: 24 };
  readonly children: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly listeners = new Map<
    string,
    Array<{ handler: (event: unknown) => void; once: boolean }>
  >();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  readonly classList = {
    add: (name: string): void => {
      if (this.classes().includes(name)) return;
      this.className = `${this.className} ${name}`.trim();
    },
    remove: (name: string): void => {
      this.className = this.classes()
        .filter((candidate) => candidate !== name)
        .join(' ');
    },
    contains: (name: string): boolean => this.classes().includes(name),
    toggle: (name: string, on?: boolean): void => {
      if (on ?? !this.classes().includes(name)) this.classList.add(name);
      else this.classList.remove(name);
    },
  };

  classes(): string[] {
    return this.className.split(' ').filter((name) => name.length > 0);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  appendChild(child: TestNode): TestNode {
    child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...children: TestNode[]): void {
    for (const child of children) this.appendChild(child);
  }

  replaceChildren(...children: TestNode[]): void {
    for (const child of [...this.children]) child.parent = undefined;
    this.children.length = 0;
    for (const child of children) this.appendChild(child);
  }

  remove(): void {
    const holder = this.parent;
    if (holder === undefined) return;
    const at = holder.children.indexOf(this);
    if (at >= 0) holder.children.splice(at, 1);
    this.parent = undefined;
  }

  contains(node: unknown): boolean {
    let walk = node instanceof TestNode ? node : undefined;
    while (walk !== undefined) {
      if (walk === this) return true;
      walk = walk.parent;
    }
    return false;
  }

  closest(selector: string): TestNode | null {
    let current: TestNode | undefined = this;
    while (current !== undefined) {
      if (matchSingleSelector(current, selector)) return current;
      current = current.parent;
    }
    return null;
  }

  querySelectorAll(selector: string): TestNode[] {
    return descendants(this)
      .slice(1)
      .filter((candidate) => matchSelector(candidate, selector));
  }

  querySelector(selector: string): TestNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  addEventListener(
    type: string,
    handler: (event: unknown) => void,
    options?: { once?: boolean }
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ handler, once: options?.once ?? false });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    const idx = list.findIndex((item) => item.handler === handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  dispatchEvent(event: unknown): boolean {
    const eventType =
      typeof event === 'string' ? event : (event as { type: string }).type;
    const eventObj =
      typeof event === 'string' ? { type: event, target: this } : event;
    if (
      typeof eventObj === 'object' &&
      eventObj !== null &&
      !('target' in eventObj)
    ) {
      (eventObj as { target: unknown }).target = this;
    }

    const list = this.listeners.get(eventType);
    if (list !== undefined) {
      for (const item of [...list]) {
        item.handler(eventObj);
        if (item.once) {
          const at = list.indexOf(item);
          if (at >= 0) list.splice(at, 1);
        }
      }
    }

    // Bubble if configured
    if (
      typeof eventObj === 'object' &&
      eventObj !== null &&
      (eventObj as { bubbles?: boolean }).bubbles &&
      this.parent
    ) {
      this.parent.dispatchEvent(eventObj);
    }

    return true;
  }

  click(): void {
    this.dispatchEvent({
      type: 'click',
      bubbles: true,
      preventDefault: () => {},
      stopPropagation: () => {},
    });
  }

  focus(): void {}

  setPointerCapture(_id: number): void {}
  releasePointerCapture(_id: number): void {}

  // The browser's element fullscreen, reduced to what the player reads back:
  // the document's fullscreen element and the change event announcing it.
  requestFullscreen(): Promise<void> {
    const doc = fullscreenDocument();
    doc.fullscreenElement = this;
    doc.dispatchEvent({ type: 'fullscreenchange' });
    return Promise.resolve();
  }

  getBoundingClientRect(): {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  } {
    return this.rect;
  }
}

class MediaTestNode extends TestNode {
  duration = 100;
  currentTime = 0;
  paused = true;
  muted = false;
  volume = 1;
  controls = false;
  webkitSupportsFullscreen?: boolean;
  webkitDisplayingFullscreen?: boolean;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  buffered = {
    length: 1,
    start: (_i: number) => 0,
    end: (_i: number) => 50,
  };

  play(): Promise<void> {
    this.paused = false;
    this.dispatchEvent({ type: 'play', bubbles: false });
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.dispatchEvent({ type: 'pause', bubbles: false });
  }
}

function descendants(node: TestNode): TestNode[] {
  return [node, ...node.children.flatMap(descendants)];
}

function matchSelector(node: TestNode, selector: string): boolean {
  for (const part of selector.split(',').map((p) => p.trim())) {
    if (matchSingleSelector(node, part)) return true;
  }
  return false;
}

function matchSingleSelector(node: TestNode, selector: string): boolean {
  const dataMatch = /^\[data-([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (dataMatch !== null) {
    const rawKey = dataMatch[1];
    if (rawKey === undefined) return false;
    const key = rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const val = node.dataset[key];
    if (val === undefined) return false;
    if (dataMatch[2] !== undefined) return val === dataMatch[2];
    return true;
  }

  if (selector.startsWith('.')) {
    return node.classes().includes(selector.slice(1));
  }

  const tagClassMatch = /^([A-Z0-9]+)\.([a-z0-9_-]+)$/i.exec(selector);
  if (tagClassMatch !== null) {
    const rawTag = tagClassMatch[1];
    const wantedClass = tagClassMatch[2];
    if (rawTag === undefined || wantedClass === undefined) return false;
    const wantedTag = rawTag.toUpperCase();
    return node.tagName === wantedTag && node.classes().includes(wantedClass);
  }

  return node.tagName === selector.toUpperCase();
}
function requireNode(node: TestNode | null, label: string): TestNode {
  if (node === null) throw new Error(`Missing node: ${label}`);
  return node;
}

interface FullscreenDocument {
  fullscreenElement: TestNode | null;
  fullscreenExits: number;
  dispatchEvent(event: unknown): boolean;
}

function fullscreenDocument(): FullscreenDocument {
  return document as unknown as FullscreenDocument;
}

/** A video player taken fullscreen through its own button. */
function fullscreenVideoPlayer(): {
  video: MediaTestNode;
  stage: TestNode;
  chrome: TestNode;
} {
  const video = new MediaTestNode('video');
  const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
    isAudio: false,
  });
  const stage = player.stage as unknown as TestNode;
  const chrome = player.chrome as unknown as TestNode;
  requireNode(chrome.querySelector('.media-fullscreen-btn'), 'fsBtn').click();
  expect(fullscreenDocument().fullscreenElement).toBe(stage);
  return { video, stage, chrome };
}

describe('custom media player and comment timeline', () => {
  let origDocument: unknown;
  let origWindow: unknown;

  beforeEach(() => {
    origDocument = (globalThis as { document?: unknown }).document;
    origWindow = (globalThis as { window?: unknown }).window;
    if (
      typeof (globalThis as { CustomEvent?: unknown }).CustomEvent !==
      'function'
    ) {
      (globalThis as { CustomEvent?: unknown }).CustomEvent = class CustomEvent<
        T,
      > {
        readonly type: string;
        readonly detail: T;
        readonly bubbles: boolean;
        constructor(type: string, init?: { detail?: T; bubbles?: boolean }) {
          this.type = type;
          this.detail = init?.detail as T;
          this.bubbles = init?.bubbles ?? false;
        }
      };
    }

    const docNode = new TestNode('#document');

    const fakeDocument = {
      createElement: (tag: string) => {
        if (tag.toLowerCase() === 'video' || tag.toLowerCase() === 'audio') {
          return new MediaTestNode(tag);
        }
        return new TestNode(tag);
      },
      createElementNS: (_ns: string, tag: string) => new TestNode(tag),
      addEventListener: (type: string, h: (e: unknown) => void) =>
        docNode.addEventListener(type, h),
      removeEventListener: (type: string, h: (e: unknown) => void) =>
        docNode.removeEventListener(type, h),
      dispatchEvent: (e: unknown) => docNode.dispatchEvent(e),
      body: new TestNode('body'),
      contains: (_node: unknown) => true,
      querySelector: (s: string) => docNode.querySelector(s),
      querySelectorAll: (s: string) => docNode.querySelectorAll(s),
      fullscreenElement: null as TestNode | null,
      fullscreenExits: 0,
      exitFullscreen: (): Promise<void> => {
        fakeDocument.fullscreenExits += 1;
        fakeDocument.fullscreenElement = null;
        docNode.dispatchEvent({ type: 'fullscreenchange' });
        return Promise.resolve();
      },
    };
    (globalThis as { document?: unknown }).document = fakeDocument;

    const winListeners = new Map<string, Array<(e: unknown) => void>>();
    (globalThis as { window?: unknown }).window = {
      addEventListener: (type: string, h: (e: unknown) => void) => {
        const list = winListeners.get(type) ?? [];
        list.push(h);
        winListeners.set(type, list);
      },
      removeEventListener: (type: string, h: (e: unknown) => void) => {
        const list = winListeners.get(type);
        if (list) {
          const idx = list.indexOf(h);
          if (idx >= 0) list.splice(idx, 1);
        }
      },
      dispatchEvent: (e: unknown) => {
        const type = typeof e === 'string' ? e : (e as { type: string }).type;
        for (const h of winListeners.get(type) ?? []) h(e);
        return true;
      },
      getSelection: () => null,
    };
  });

  afterEach(() => {
    (globalThis as { document?: unknown }).document = origDocument;
    (globalThis as { window?: unknown }).window = origWindow;
  });

  test('controls are keyboard complete and native controls are removed', () => {
    const video = new MediaTestNode('video');
    video.setAttribute('controls', '');
    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
      filename: 'clip.mp4',
    });

    expect(video.controls).toBe(false);
    expect(video.hasAttribute('controls')).toBe(false);

    const chrome = player.chrome as unknown as TestNode;
    expect(chrome).toBeDefined();

    // Play button
    const playBtn = chrome.querySelector('.media-play-btn');
    expect(playBtn).toBeDefined();
    expect(playBtn?.getAttribute('aria-label')).toBe('Play');

    // Timecode
    const timecode = chrome.querySelector('.media-timecode');
    expect(timecode).toBeDefined();

    // Scrubber slider with real ARIA semantics
    const scrubber = chrome.querySelector('.media-scrubber');
    expect(scrubber).toBeDefined();
    expect(scrubber?.getAttribute('role')).toBe('slider');
    expect(scrubber?.getAttribute('tabindex')).toBe('0');
    expect(scrubber?.getAttribute('aria-valuemin')).toBe('0');
    expect(scrubber?.getAttribute('aria-valuemax')).toBe('100');
    expect(scrubber?.getAttribute('aria-valuenow')).toBe('0');
    expect(scrubber?.getAttribute('aria-valuetext')).toBe('0:00 of 1:40');

    // Mute button
    const muteBtn = chrome.querySelector('.media-mute-btn');
    expect(muteBtn).toBeDefined();
    expect(muteBtn?.getAttribute('aria-label')).toBe('Mute');

    // Fullscreen button (video only)
    const fsBtn = chrome.querySelector('.media-fullscreen-btn');
    expect(fsBtn).toBeDefined();

    // Audio relic does NOT carry fullscreen button
    const audio = new MediaTestNode('audio');
    const audioPlayer = createMediaPlayer(
      audio as unknown as HTMLMediaElement,
      {
        isAudio: true,
        filename: 'voice.mp3',
      }
    );
    const audioChrome = audioPlayer.chrome as unknown as TestNode;
    expect(audioChrome.querySelector('.media-fullscreen-btn')).toBeNull();
    expect(audioPlayer.audioCard).toBeDefined();
  });

  test('play, pause, and seek operate by pointer and by keyboard', () => {
    const video = new MediaTestNode('video');
    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
    });
    const chrome = player.chrome as unknown as TestNode;
    const playBtn = requireNode(
      chrome.querySelector('.media-play-btn'),
      'playBtn'
    );
    const scrubber = requireNode(
      chrome.querySelector('.media-scrubber'),
      'scrubber'
    );
    const muteBtn = requireNode(
      chrome.querySelector('.media-mute-btn'),
      'muteBtn'
    );

    // Play via button click
    playBtn.click();
    expect(video.paused).toBe(false);
    expect(playBtn.getAttribute('aria-label')).toBe('Pause');

    // Pause via space key on scrubber
    scrubber.dispatchEvent({
      type: 'keydown',
      key: ' ',
      preventDefault: () => {},
    });
    expect(video.paused).toBe(true);
    expect(playBtn.getAttribute('aria-label')).toBe('Play');

    // Play via 'k' key
    scrubber.dispatchEvent({
      type: 'keydown',
      key: 'k',
      preventDefault: () => {},
    });
    expect(video.paused).toBe(false);

    // Fine seek (+0.1s) via plain ArrowRight key on scrubber
    video.currentTime = 10;
    scrubber.dispatchEvent({
      type: 'keydown',
      key: 'ArrowRight',
      shiftKey: false,
      altKey: false,
      preventDefault: () => {},
    });
    expect(video.currentTime).toBeCloseTo(10.1, 5);

    // Seek left via ArrowLeft key on scrubber (-0.1s)
    scrubber.dispatchEvent({
      type: 'keydown',
      key: 'ArrowLeft',
      shiftKey: false,
      altKey: false,
      preventDefault: () => {},
    });
    expect(video.currentTime).toBeCloseTo(10, 5);

    // Coarse seek (+1s) with shiftKey
    scrubber.dispatchEvent({
      type: 'keydown',
      key: 'ArrowRight',
      shiftKey: true,
      altKey: false,
      preventDefault: () => {},
    });
    expect(video.currentTime).toBeCloseTo(11, 5);

    // Large jump (+5s) with PageUp
    scrubber.dispatchEvent({
      type: 'keydown',
      key: 'PageUp',
      preventDefault: () => {},
    });
    expect(video.currentTime).toBe(16);

    // Large jump (-5s) with PageDown
    scrubber.dispatchEvent({
      type: 'keydown',
      key: 'PageDown',
      preventDefault: () => {},
    });
    expect(video.currentTime).toBeCloseTo(11, 5);

    // Jump to End and Home
    scrubber.dispatchEvent({
      type: 'keydown',
      key: 'End',
      preventDefault: () => {},
    });
    expect(video.currentTime).toBe(100);

    scrubber.dispatchEvent({
      type: 'keydown',
      key: 'Home',
      preventDefault: () => {},
    });
    expect(video.currentTime).toBe(0);

    // Mute toggle via button and 'm' key
    expect(video.muted).toBe(false);
    muteBtn.click();
    expect(video.muted).toBe(true);

    scrubber.dispatchEvent({
      type: 'keydown',
      key: 'm',
      preventDefault: () => {},
    });
    expect(video.muted).toBe(false);
  });

  test('hitting play when at the end restarts playback from 0', () => {
    const video = new MediaTestNode('video');
    video.duration = 100;
    video.currentTime = 100;
    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
    });
    const chrome = player.chrome as unknown as TestNode;
    const playBtn = requireNode(
      chrome.querySelector('.media-play-btn'),
      'playBtn'
    );
    const scrubber = requireNode(
      chrome.querySelector('.media-scrubber'),
      'scrubber'
    );

    // 1. Play button at end (after scrub / jump to duration)
    playBtn.click();
    expect(video.currentTime).toBe(0);
    expect(video.paused).toBe(false);

    // Pause and seek back to end
    video.paused = true;
    video.currentTime = 100;

    // 2. Space key on scrubber at end
    scrubber.dispatchEvent({
      type: 'keydown',
      key: ' ',
      preventDefault: () => {},
    });
    expect(video.currentTime).toBe(0);
    expect(video.paused).toBe(false);

    // Pause and seek back to end
    video.paused = true;
    video.currentTime = 100;

    // 3. 'k' key on scrubber at end
    scrubber.dispatchEvent({
      type: 'keydown',
      key: 'k',
      preventDefault: () => {},
    });
    expect(video.currentTime).toBe(0);
    expect(video.paused).toBe(false);
    // 4. Play button near end / within last frame tolerance (e.g. 99.98 on 100 duration)
    video.paused = true;
    video.currentTime = 99.98;
    playBtn.click();
    expect(video.currentTime).toBe(0);
    expect(video.paused).toBe(false);
  });
  test('hover affordance displays timecode without seeking the media', () => {
    const video = new MediaTestNode('video');
    video.currentTime = 10;
    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
    });
    const chrome = player.chrome as unknown as TestNode;
    const scrubber = requireNode(
      chrome.querySelector('.media-scrubber'),
      'scrubber'
    );
    const hoverIndicator = requireNode(
      chrome.querySelector('.media-hover-indicator'),
      'hoverIndicator'
    );
    const hoverTimecode = requireNode(
      chrome.querySelector('.hover-timecode'),
      'hoverTimecode'
    );
    const hoverBtn = requireNode(
      chrome.querySelector('.timeline-hover-comment-btn'),
      'hoverBtn'
    );

    expect(hoverIndicator.classes()).toContain('is-hidden');

    // Pointer moves to 50% (50 seconds on 100s clip)
    scrubber.dispatchEvent({
      type: 'pointermove',
      clientX: 320, // 320 / 640 = 0.5
      bubbles: true,
    });

    // Hover indicator is shown with right timecode
    expect(hoverIndicator.classes()).not.toContain('is-hidden');
    expect(hoverIndicator.style.left).toBe('50%');
    expect(hoverTimecode.textContent).toBe('0:50');
    expect(hoverBtn.getAttribute('aria-label')).toBe('Comment at 0:50');

    // CRITICAL: hover MUST NOT seek the media
    expect(video.currentTime).toBe(10);

    // Pointer leaves track
    scrubber.dispatchEvent({ type: 'pointerleave', bubbles: true });
    expect(hoverIndicator.classes()).toContain('is-hidden');
  });

  test('hover comment button aims a moment at the hovered time', () => {
    const video = new MediaTestNode('video');
    video.currentTime = 5;
    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
    });
    const chrome = player.chrome as unknown as TestNode;
    const scrubber = requireNode(
      chrome.querySelector('.media-scrubber'),
      'scrubber'
    );
    const hoverBtn = requireNode(
      chrome.querySelector('.timeline-hover-comment-btn'),
      'hoverBtn'
    );

    let aimedAnchor: CommentAnchor | null = null;
    chrome.addEventListener('relic:time-aim', (event: unknown) => {
      aimedAnchor = (event as { detail: { anchor: CommentAnchor } }).detail
        .anchor;
    });

    // Move pointer to 30% (30 seconds)
    scrubber.dispatchEvent({
      type: 'pointermove',
      clientX: 192, // 192 / 640 = 0.30
      bubbles: true,
    });

    // Click comment button
    hoverBtn.click();

    expect(video.currentTime).toBe(30);
    expect(video.paused).toBe(true);
    expect(aimedAnchor as CommentAnchor | null).toEqual({
      kind: 'time',
      t: 30,
    });
  });

  test('bare click on track seeks without opening comment composer', () => {
    const video = new MediaTestNode('video');
    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
    });
    const chrome = player.chrome as unknown as TestNode;
    const scrubber = requireNode(
      chrome.querySelector('.media-scrubber'),
      'scrubber'
    );

    let aimedAnchor: CommentAnchor | null = null;
    chrome.addEventListener('relic:time-aim', (event: unknown) => {
      aimedAnchor = (event as { detail: { anchor: CommentAnchor } }).detail
        .anchor;
    });

    // Press down at 25% (25s)
    scrubber.dispatchEvent({
      type: 'pointerdown',
      clientX: 160,
      bubbles: true,
      preventDefault: () => {},
    });

    // Release at same position without moving
    (
      window as unknown as { dispatchEvent: (e: unknown) => void }
    ).dispatchEvent({
      type: 'pointerup',
      clientX: 160,
      bubbles: true,
    });

    expect(video.currentTime).toBe(25);
    expect(aimedAnchor).toBeNull();

    const pending = chrome.querySelector('.media-pending-selection');
    expect(pending === null || pending.classes().includes('is-hidden')).toBe(
      true
    );
  });

  test('press-drag on track aims a span anchor matching spanFromDrag', () => {
    const video = new MediaTestNode('video');
    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
    });
    const chrome = player.chrome as unknown as TestNode;
    const scrubber = requireNode(
      chrome.querySelector('.media-scrubber'),
      'scrubber'
    );

    let aimedAnchor: CommentAnchor | null = null;
    chrome.addEventListener('relic:time-aim', (event: unknown) => {
      aimedAnchor = (event as { detail: { anchor: CommentAnchor } }).detail
        .anchor;
    });

    // Press down at 10% (10s)
    scrubber.dispatchEvent({
      type: 'pointerdown',
      clientX: 64,
      bubbles: true,
      preventDefault: () => {},
    });

    // Drag to 40% (40s)
    (
      window as unknown as { dispatchEvent: (e: unknown) => void }
    ).dispatchEvent({
      type: 'pointermove',
      clientX: 256,
      bubbles: true,
    });

    // Release pointer
    (
      window as unknown as { dispatchEvent: (e: unknown) => void }
    ).dispatchEvent({
      type: 'pointerup',
      clientX: 256,
      bubbles: true,
    });

    const expectedSpan = spanFromDrag(10, 40);
    const expectedAnchor: CommentAnchor = {
      kind: 'time',
      t: expectedSpan.t,
      ...(expectedSpan.t_end !== undefined
        ? { t_end: expectedSpan.t_end }
        : {}),
    };
    expect(aimedAnchor as CommentAnchor | null).toEqual(expectedAnchor);
    const pending = requireNode(
      chrome.querySelector('.media-pending-selection'),
      'pending'
    );
    expect(pending.classes()).not.toContain('is-hidden');
    expect(pending.style.left).toBe('10%');
    expect(pending.style.width).toBe('30%'); // 40% - 10% = 30%
  });

  test('a drag holds its aim until release, so the rail cannot slide under the pointer', () => {
    const video = new MediaTestNode('video');
    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
    });
    const chrome = player.chrome as unknown as TestNode;
    const scrubber = requireNode(
      chrome.querySelector('.media-scrubber'),
      'scrubber'
    );
    const rail = requireNode(chrome.querySelector('.media-track-rail'), 'rail');

    // Aiming opens the thread sidebar, which in the real layout shifts this
    // rail 176px left. Reproduced here: any aim moves the rail.
    const aims: CommentAnchor[] = [];
    chrome.addEventListener('relic:time-aim', (event: unknown) => {
      aims.push((event as { detail: { anchor: CommentAnchor } }).detail.anchor);
      rail.rect = { ...rail.rect, left: -176, right: 464 };
    });

    const fire = (type: string, clientX: number): void => {
      (
        window as unknown as { dispatchEvent: (e: unknown) => void }
      ).dispatchEvent({
        type,
        clientX,
        bubbles: true,
      });
    };

    // Press at 24% of a 640px rail at left 0, on a 100s clip.
    scrubber.dispatchEvent({
      type: 'pointerdown',
      clientX: 0.24 * 640,
      bubbles: true,
      preventDefault: () => {},
    });
    // Drag to 36% and hold the finger there for a second move.
    fire('pointermove', 0.36 * 640);
    expect(aims).toHaveLength(0);
    fire('pointermove', 0.36 * 640);
    fire('pointerup', 0.36 * 640);

    // One aim, on release, ending where the pointer actually was. If the aim
    // fired during the drag the rail would have shifted and this same
    // clientX would have read as 63.5s instead of 36s.
    expect(aims).toHaveLength(1);
    const expected = spanFromDrag(24, 36);
    expect(aims[0]).toEqual({
      kind: 'time',
      t: expected.t,
      ...(expected.t_end !== undefined ? { t_end: expected.t_end } : {}),
    });
  });

  test('clicking video focuses the scrubber and toggles play', () => {
    const video = new MediaTestNode('video');
    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
    });
    const chrome = player.chrome as unknown as TestNode;
    const scrubber = requireNode(
      chrome.querySelector('.media-scrubber'),
      'scrubber'
    );
    let focusedElement: unknown = null;
    scrubber.focus = () => {
      focusedElement = scrubber;
    };

    expect(video.paused).toBe(true);
    video.click();
    expect(focusedElement).toBe(scrubber);
    expect(video.paused).toBe(false);

    video.click();
    expect(video.paused).toBe(true);
  });

  test('end handle steps span via keyboard and collapses back to moment', () => {
    const video = new MediaTestNode('video');
    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
    });
    const chrome = player.chrome as unknown as TestNode;
    const handle = requireNode(
      chrome.querySelector('.timeline-span-handle'),
      'handle'
    );

    let lastAimed: CommentAnchor | null = null;
    chrome.addEventListener('relic:time-aim', (event: unknown) => {
      lastAimed = (event as { detail: { anchor: CommentAnchor } }).detail
        .anchor;
    });

    // Set initial moment at 20s
    player.setPendingAnchor({ t: 20 });

    // Step end forward by 1 step (0.1s)
    handle.dispatchEvent({
      type: 'keydown',
      key: 'ArrowRight',
      shiftKey: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    });

    const expectedStepped = stepSpanEnd({ t: 20 }, 1, 100, false);
    const expectedSteppedAnchor: CommentAnchor = {
      kind: 'time',
      t: 20,
      ...(expectedStepped.t_end !== undefined
        ? { t_end: expectedStepped.t_end }
        : {}),
    };
    expect(lastAimed as CommentAnchor | null).toEqual(expectedSteppedAnchor);

    // Step end with Shift (coarse step: 1.0s)
    handle.dispatchEvent({
      type: 'keydown',
      key: 'ArrowRight',
      shiftKey: true,
      preventDefault: () => {},
      stopPropagation: () => {},
    });

    // Step end backwards onto start -> collapses back to moment
    handle.dispatchEvent({
      type: 'keydown',
      key: 'ArrowLeft',
      shiftKey: true,
      preventDefault: () => {},
      stopPropagation: () => {},
    });
    handle.dispatchEvent({
      type: 'keydown',
      key: 'ArrowLeft',
      shiftKey: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    });

    expect(lastAimed as CommentAnchor | null).toEqual({ kind: 'time', t: 20 });

    // Escape collapses span to moment
    player.setPendingAnchor({ t: 20, t_end: 35 });
    handle.dispatchEvent({
      type: 'keydown',
      key: 'Escape',
      preventDefault: () => {},
      stopPropagation: () => {},
    });
    expect(lastAimed as CommentAnchor | null).toEqual({ kind: 'time', t: 20 });
  });

  test('markers paint for moments and spans on the scrubber track', () => {
    const host = new TestNode('div');
    const video = new MediaTestNode('video');
    video.duration = 100;

    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
    });
    host.appendChild(player.stage as unknown as TestNode);

    const surface: AnchorSurface = {
      host: host as unknown as HTMLElement,
      content: video as unknown as HTMLElement,
    };
    const overlay = new TestNode('div');

    // Paint a moment at 15s
    paintTimeMark(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'time', t: 15 },
      'm1'
    );

    // Paint a span from 40s to 70s
    paintTimeMark(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'time', t: 40, t_end: 70 },
      's1'
    );

    const track = player.track as unknown as TestNode;

    const momentMarker = track.querySelector('[data-comment-id="m1"]');
    expect(momentMarker).toBeDefined();
    expect(momentMarker?.classes()).toContain('time-marker');
    expect(momentMarker?.classes()).not.toContain('time-marker-span');
    expect(momentMarker?.style.left).toBe('15%');

    const spanMarker = track.querySelector('[data-comment-id="s1"]');
    expect(spanMarker).toBeDefined();
    expect(spanMarker?.classes()).toContain('time-marker-span');
    expect(spanMarker?.style.left).toBe('40%');
    expect(spanMarker?.style.width).toBe('30%'); // 70% - 40% = 30%

    // Clicking marker reveals mark (seeks and pauses)
    video.currentTime = 0;
    video.play();
    momentMarker?.click();
    expect(video.currentTime).toBe(15);
    expect(video.paused).toBe(true);
  });

  test('clusters report their member count', () => {
    const host = new TestNode('div');
    const video = new MediaTestNode('video');
    video.duration = 100;

    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
    });
    host.appendChild(player.stage as unknown as TestNode);

    const surface: AnchorSurface = {
      host: host as unknown as HTMLElement,
      content: video as unknown as HTMLElement,
    };
    const overlay = new TestNode('div');

    // Paint three markers very close to each other (10s, 10.2s, 10.5s)
    paintTimeMark(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'time', t: 10 },
      'c1'
    );
    paintTimeMark(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'time', t: 10.2 },
      'c2'
    );
    paintTimeMark(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'time', t: 10.5 },
      'c3'
    );

    const track = player.track as unknown as TestNode;
    const cluster = track.querySelector('.time-marker-cluster');
    expect(cluster).toBeDefined();
    expect(cluster?.textContent).toBe('3');
    expect(cluster?.dataset.clusterCount).toBe('3');
  });

  test('anchors in the old shape still paint on the new scrubber including rect boxes', () => {
    const host = new TestNode('div');
    const video = new MediaTestNode('video');
    video.duration = 60;

    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
    });
    host.appendChild(player.stage as unknown as TestNode);

    const surface: AnchorSurface = {
      host: host as unknown as HTMLElement,
      content: video as unknown as HTMLElement,
    };
    const overlay = new TestNode('div');

    const rect: AnchorRect = { x: 0.2, y: 0.3, w: 0.4, h: 0.5 };
    const placed = paintTimeMark(
      surface,
      overlay as unknown as HTMLElement,
      { kind: 'time', t: 12, t_end: 24, rect },
      'legacy-mark'
    );
    expect(placed).toBe(true);

    // The marker lands on the player's track
    const track = player.track as unknown as TestNode;
    const marker = track.querySelector('[data-comment-id="legacy-mark"]');
    expect(marker).toBeDefined();
    expect(marker?.classes()).toContain('time-marker-span');
    expect(marker?.style.left).toBe('20%'); // 12 / 60 = 20%
    expect(marker?.style.width).toBe('20%'); // (24 - 12) / 60 = 20%

    // The rect frame box remains over the video frame in overlay
    const frameBox = overlay.querySelector('.time-frame-box');
    expect(frameBox).toBeDefined();
    expect(frameBox?.dataset.commentId).toBe('legacy-mark');

    // revealTimeMark seeks and pauses
    revealTimeMark(surface, { kind: 'time', t: 12 });
    expect(video.currentTime).toBe(12);
    expect(video.paused).toBe(true);
  });

  test('fullscreen playback goes idle after the delay and wakes on pointer activity', () => {
    vi.useFakeTimers();
    try {
      const { video, stage, chrome } = fullscreenVideoPlayer();
      void video.play();

      vi.advanceTimersByTime(FULLSCREEN_IDLE_MS - 1);
      expect(stage.classes()).not.toContain('is-idle');
      vi.advanceTimersByTime(1);
      expect(stage.classes()).toContain('is-idle');

      // A pointer moving over the picture brings the controls back and starts
      // the wait again from the beginning.
      video.dispatchEvent({ type: 'pointermove', bubbles: true, clientX: 10 });
      expect(stage.classes()).not.toContain('is-idle');
      vi.advanceTimersByTime(FULLSCREEN_IDLE_MS - 1);
      expect(stage.classes()).not.toContain('is-idle');
      vi.advanceTimersByTime(1);
      expect(stage.classes()).toContain('is-idle');

      // Leaving fullscreen shows the controls and the wait does not come back.
      requireNode(
        chrome.querySelector('.media-fullscreen-btn'),
        'fsBtn'
      ).click();
      expect(fullscreenDocument().fullscreenElement).toBeNull();
      expect(stage.classes()).not.toContain('is-idle');
      vi.advanceTimersByTime(FULLSCREEN_IDLE_MS * 4);
      expect(stage.classes()).not.toContain('is-idle');
    } finally {
      vi.useRealTimers();
    }
  });

  test('paused fullscreen playback never goes idle', () => {
    vi.useFakeTimers();
    try {
      const { video, stage } = fullscreenVideoPlayer();

      // Paused from the start.
      vi.advanceTimersByTime(FULLSCREEN_IDLE_MS * 4);
      expect(stage.classes()).not.toContain('is-idle');

      // Paused partway through the wait.
      void video.play();
      vi.advanceTimersByTime(FULLSCREEN_IDLE_MS - 500);
      video.pause();
      vi.advanceTimersByTime(FULLSCREEN_IDLE_MS * 4);
      expect(stage.classes()).not.toContain('is-idle');

      // Activity while paused does not start a wait either.
      video.dispatchEvent({ type: 'pointermove', bubbles: true, clientX: 10 });
      vi.advanceTimersByTime(FULLSCREEN_IDLE_MS * 4);
      expect(stage.classes()).not.toContain('is-idle');
    } finally {
      vi.useRealTimers();
    }
  });

  test('fullscreen playback stays awake while the pointer rests on the controls', () => {
    vi.useFakeTimers();
    try {
      const { video, stage, chrome } = fullscreenVideoPlayer();
      void video.play();

      chrome.dispatchEvent({ type: 'pointerenter', bubbles: false });
      vi.advanceTimersByTime(FULLSCREEN_IDLE_MS * 4);
      expect(stage.classes()).not.toContain('is-idle');

      chrome.dispatchEvent({ type: 'pointerleave', bubbles: false });
      vi.advanceTimersByTime(FULLSCREEN_IDLE_MS);
      expect(stage.classes()).toContain('is-idle');
    } finally {
      vi.useRealTimers();
    }
  });

  test('fullscreen playback stays awake while a comment panel is open on the stage', () => {
    vi.useFakeTimers();
    try {
      const { video, stage } = fullscreenVideoPlayer();
      const panel = new TestNode('div');
      panel.className = 'popover popover-card';
      stage.appendChild(panel);
      void video.play();

      vi.advanceTimersByTime(FULLSCREEN_IDLE_MS * 4);
      expect(stage.classes()).not.toContain('is-idle');

      panel.remove();
      stage.dispatchEvent({ type: 'pointermove', bubbles: true, clientX: 10 });
      vi.advanceTimersByTime(FULLSCREEN_IDLE_MS);
      expect(stage.classes()).toContain('is-idle');
    } finally {
      vi.useRealTimers();
    }
  });

  // The reverse of what this test used to pin. It proved that a comment
  // action left fullscreen before the composer opened, because the composer
  // lived in the sidebar outside the fullscreen element. The composer now
  // opens over the scrubber inside the stage, so every gesture aims from
  // inside fullscreen and nothing here ever leaves it. Leaving for the one
  // reader who must reach the sidebar is the page's decision, proven in
  // `timeline-popover.test.ts`.
  test('a comment action in fullscreen stays in fullscreen, for a drag and for the comment button', () => {
    const { stage, chrome } = fullscreenVideoPlayer();
    const scrubber = requireNode(
      chrome.querySelector('.media-scrubber'),
      'scrubber'
    );
    const hoverBtn = requireNode(
      chrome.querySelector('.timeline-hover-comment-btn'),
      'hoverBtn'
    );

    const aims: Array<{ focus: boolean; inFullscreen: boolean }> = [];
    chrome.addEventListener('relic:time-aim', (event: unknown) => {
      const detail = (event as { detail: { focus: boolean } }).detail;
      aims.push({
        focus: detail.focus,
        inFullscreen: fullscreenDocument().fullscreenElement === stage,
      });
    });

    scrubber.dispatchEvent({
      type: 'pointerdown',
      clientX: 64,
      bubbles: true,
      preventDefault: () => {},
    });
    const win = window as unknown as {
      dispatchEvent: (e: unknown) => void;
    };
    win.dispatchEvent({ type: 'pointermove', clientX: 256, bubbles: true });
    win.dispatchEvent({ type: 'pointerup', clientX: 256, bubbles: true });

    scrubber.dispatchEvent({
      type: 'pointermove',
      clientX: 192,
      bubbles: true,
    });
    hoverBtn.click();

    // Both are the start of a comment, so both ask for the composer's focus,
    // and both went out while the stage was still fullscreen.
    expect(aims).toEqual([
      { focus: true, inFullscreen: true },
      { focus: true, inFullscreen: true },
    ]);
    expect(fullscreenDocument().fullscreenElement).toBe(stage);
    expect(fullscreenDocument().fullscreenExits).toBe(0);
  });

  test('an aim says where its moment and its span sit on the scrubber', () => {
    const video = new MediaTestNode('video');
    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
    });
    const chrome = player.chrome as unknown as TestNode;
    const scrubber = requireNode(
      chrome.querySelector('.media-scrubber'),
      'scrubber'
    );
    scrubber.rect = { ...scrubber.rect, top: 400, bottom: 424, height: 24 };
    const hoverBtn = requireNode(
      chrome.querySelector('.timeline-hover-comment-btn'),
      'hoverBtn'
    );
    const measured: Array<{ left: number; top: number; width: number }> = [];
    chrome.addEventListener('relic:time-aim', (event: unknown) => {
      const detail = (
        event as {
          detail: {
            measure: () => { left: number; top: number; width: number };
          };
        }
      ).detail;
      measured.push(detail.measure());
    });

    // A moment at 30% of a 640px rail on a 100s clip.
    scrubber.dispatchEvent({
      type: 'pointermove',
      clientX: 192,
      bubbles: true,
    });
    hoverBtn.click();
    // A span from 10% to 40%.
    scrubber.dispatchEvent({
      type: 'pointerdown',
      clientX: 64,
      bubbles: true,
      preventDefault: () => {},
    });
    const win = window as unknown as {
      dispatchEvent: (e: unknown) => void;
    };
    win.dispatchEvent({ type: 'pointermove', clientX: 256, bubbles: true });
    win.dispatchEvent({ type: 'pointerup', clientX: 256, bubbles: true });

    const span = spanFromDrag(10, 40);
    expect(measured[0]).toMatchObject({ left: 192, top: 400, width: 0 });
    expect(measured[1]?.left).toBeCloseTo(span.t * 6.4, 3);
    expect(measured[1]?.width).toBeCloseTo(
      ((span.t_end ?? span.t) - span.t) * 6.4,
      3
    );
  });

  test('stage path chosen when requestFullscreen exists', () => {
    const video = new MediaTestNode('video');
    const webkitEnter = vi.fn();
    video.webkitEnterFullscreen = webkitEnter;
    video.webkitSupportsFullscreen = true;

    const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
      isAudio: false,
      filename: 'clip.mp4',
    });
    const chrome = player.chrome as unknown as TestNode;
    const stage = player.stage as unknown as TestNode;
    const fsBtn = requireNode(
      chrome.querySelector('.media-fullscreen-btn'),
      'fsBtn'
    );
    expect(fsBtn.hidden).toBe(false);

    fsBtn.click();
    expect(fullscreenDocument().fullscreenElement).toBe(stage);
    expect(webkitEnter).not.toHaveBeenCalled();
  });

  test('native path calls webkitEnterFullscreen when only it exists', () => {
    const video = new MediaTestNode('video');
    const webkitEnter = vi.fn();
    video.webkitEnterFullscreen = webkitEnter;
    video.webkitSupportsFullscreen = true;

    const proto = TestNode.prototype as {
      requestFullscreen?: () => Promise<void>;
    };
    const origRequestFs = proto.requestFullscreen;
    delete proto.requestFullscreen;
    try {
      const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
        isAudio: false,
        filename: 'clip.mp4',
      });
      const chrome = player.chrome as unknown as TestNode;
      const fsBtn = requireNode(
        chrome.querySelector('.media-fullscreen-btn'),
        'fsBtn'
      );
      expect(fsBtn.hidden).toBe(false);

      fsBtn.click();
      expect(webkitEnter).toHaveBeenCalledTimes(1);
      expect(fullscreenDocument().fullscreenElement).toBeNull();
    } finally {
      if (origRequestFs !== undefined) {
        proto.requestFullscreen = origRequestFs;
      } else {
        delete proto.requestFullscreen;
      }
    }
  });

  test('button hidden when neither stage nor native fullscreen is supported', () => {
    const video = new MediaTestNode('video');
    const proto = TestNode.prototype as {
      requestFullscreen?: () => Promise<void>;
    };
    const origRequestFs = proto.requestFullscreen;
    delete proto.requestFullscreen;
    try {
      const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
        isAudio: false,
        filename: 'clip.mp4',
      });
      const chrome = player.chrome as unknown as TestNode;
      const fsBtn = requireNode(
        chrome.querySelector('.media-fullscreen-btn'),
        'fsBtn'
      );
      expect(fsBtn.hidden).toBe(true);
      expect(fsBtn.attributes.has('hidden')).toBe(true);
    } finally {
      if (origRequestFs !== undefined) {
        proto.requestFullscreen = origRequestFs;
      } else {
        delete proto.requestFullscreen;
      }
    }
  });

  test('fullscreen button state and idle logic follow native fullscreen events', () => {
    vi.useFakeTimers();
    const proto = TestNode.prototype as {
      requestFullscreen?: () => Promise<void>;
    };
    const origRequestFs = proto.requestFullscreen;
    delete proto.requestFullscreen;
    try {
      const video = new MediaTestNode('video');
      const webkitExit = vi.fn();
      video.webkitEnterFullscreen = vi.fn();
      video.webkitExitFullscreen = webkitExit;
      video.webkitSupportsFullscreen = true;

      const player = createMediaPlayer(video as unknown as HTMLMediaElement, {
        isAudio: false,
        filename: 'clip.mp4',
      });
      const chrome = player.chrome as unknown as TestNode;
      const stage = player.stage as unknown as TestNode;
      const fsBtn = requireNode(
        chrome.querySelector('.media-fullscreen-btn'),
        'fsBtn'
      );

      expect(fsBtn.getAttribute('aria-label')).toBe('Fullscreen');

      // Native fullscreen begins
      video.webkitDisplayingFullscreen = true;
      video.dispatchEvent({ type: 'webkitbeginfullscreen' });

      expect(fsBtn.getAttribute('aria-label')).toBe('Exit fullscreen');
      expect(stage.classes()).not.toContain('is-idle');

      // Advancing timer does not put stage into idle in native fullscreen
      void video.play();
      vi.advanceTimersByTime(FULLSCREEN_IDLE_MS * 4);
      expect(stage.classes()).not.toContain('is-idle');

      // Tapping button while in native fullscreen exits native fullscreen
      fsBtn.click();
      expect(webkitExit).toHaveBeenCalledTimes(1);

      // Native fullscreen ends
      video.webkitDisplayingFullscreen = false;
      video.dispatchEvent({ type: 'webkitendfullscreen' });

      expect(fsBtn.getAttribute('aria-label')).toBe('Fullscreen');
      expect(stage.classes()).not.toContain('is-idle');
    } finally {
      vi.useRealTimers();
      if (origRequestFs !== undefined) {
        proto.requestFullscreen = origRequestFs;
      } else {
        delete proto.requestFullscreen;
      }
    }
  });
});
