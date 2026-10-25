/**
 * Custom accessible media player for video and audio relics, with a comment-bearing timeline.
 *
 * Replaces native browser media controls with custom controls following the accession
 * label aesthetic: hairline rules, zero border radii, no glow effects, and patina teal
 * as the primary saturated colour.
 *
 * The timeline scrubber is layered in order back-to-front:
 * 1. Track rail
 * 2. Buffered ranges
 * 3. Played progress
 * 4. Comment markers (moments, spans, clusters)
 * 5. Pending selection (with draggable, keyboard-steppable span end handle)
 * 6. Hover indicator (vertical rule, timecode tag, comment action button)
 *
 * The picture and its controls sit together in a stage, and the stage is what
 * goes fullscreen. There the picture fills the screen on black, the controls
 * lie over the bottom of the frame, and after a spell of idle playback they
 * fade out with the cursor so the frame is all that is left. A comment is
 * written in a panel over the scrubber inside the stage, so commenting never
 * has to leave fullscreen to find somewhere to type.
 */

import type { CommentAnchor } from '@relic/format';
import { formatTimecode } from './annotate-time.ts';
import {
  COARSE_STEP_SECONDS,
  fractionToTime,
  pointerFraction,
  STEP_SECONDS,
  spanFromDrag,
  stepSpanEnd,
  type TimeSpan,
  timeToFraction,
} from './media-timeline.ts';

interface WebKitFullscreenVideoElement extends HTMLMediaElement {
  readonly webkitSupportsFullscreen?: boolean;
  readonly webkitDisplayingFullscreen?: boolean;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
}

const ICONS = {
  play: 'M4 3l9 5-9 5V3z',
  pause: 'M4 3h3v10H4V3zm5 0h3v10H9V3z',
  volume:
    'M2 5v6h3l4 4V1L5 5H2zm8.5 3c0-1.8-1-3.3-2.5-4v8c1.5-.7 2.5-2.2 2.5-4z',
  mute: 'M2 5v6h3l4 4V1L5 5H2zm10.5 3l2-2-.7-.7-2 2-2-2-.7.7 2 2-2 2 .7.7 2-2 2 2 .7-.7-2-2z',
  fullscreen:
    'M2 2h4v1.5H3.5V6H2V2zm12 0h-4v1.5h2.5V6H14V2zM2 14h4v-1.5H3.5V10H2v4zm12 0h-4v-1.5h2.5V10H14v4z',
  fullscreenExit:
    'M5.5 2H4v2.5H1.5V6H5.5V2zm5 0H12v2.5h2.5V6H10.5V2zm-5 12H4v-2.5H1.5V10H5.5v4zm5 0H12v-2.5h2.5V10H10.5v4z',
  plus: 'M7.25 2h1.5v5.25H14v1.5H8.75V14h-1.5V8.75H2v-1.5h5.25V2z',
  audio: 'M3 2h10v12H3V2zm1 1v10h8V3H4zm2 2h4v1H6V5zm0 2h4v1H6V7zm0 2h2v1H6V9z',
} as const;

function createSvgIcon(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('media-icon');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  svg.appendChild(node);
  return svg;
}

export interface MediaPlayerOptions {
  readonly isAudio: boolean;
  readonly filename?: string;
}

/**
 * How long fullscreen playback runs with no pointer or key activity before the
 * controls fade and the cursor hides, leaving the bare frame.
 */
export const FULLSCREEN_IDLE_MS = 2500;

export interface MediaPlayerHandle {
  /**
   * The media element and its controls, and nothing else. This is what goes
   * fullscreen, so the filename strip and the page card stay on the page.
   */
  readonly stage: HTMLElement;
  readonly chrome: HTMLElement;
  readonly audioCard?: HTMLElement | undefined;
  readonly track: HTMLElement;
  readonly destroy: () => void;
  readonly setPendingAnchor: (span: TimeSpan | null) => void;
}

/** A box in viewport pixels, as `getBoundingClientRect` reports one. */
export interface ClientBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What `relic:time-aim` carries to the page.
 *
 * A measuring function rather than a box measured once, because where a
 * moment sits on the scrubber moves whenever the page around it does, and the
 * composer that opens on it has to follow: into fullscreen, out of it, or
 * across a resize.
 */
export interface TimeAimDetail {
  readonly anchor: Extract<CommentAnchor, { kind: 'time' }>;
  /**
   * Whether the composer takes focus. Every gesture that starts a comment
   * asks for it. Adjusting the end of a span already drawn does not, because
   * focus belongs to the handle the reader is adjusting it with.
   */
  readonly focus: boolean;
  /** The moment or span on the scrubber, in viewport pixels. */
  readonly measure: () => ClientBox;
}

function getTrackGeometry(element: HTMLElement): ClientBox {
  if (typeof element.getBoundingClientRect === 'function') {
    const rect = element.getBoundingClientRect();
    if (rect && rect.width > 0) {
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    }
  }
  return { left: 0, top: 0, width: 640, height: 0 };
}
function createCustomEvent<T>(type: string, detail: T): Event {
  if (typeof CustomEvent === 'function') {
    return new CustomEvent(type, { detail, bubbles: true, composed: true });
  }
  return {
    type,
    detail,
    bubbles: true,
    composed: true,
  } as unknown as Event;
}

/**
 * Creates and mounts a custom media player around a video or audio element.
 */
export function createMediaPlayer(
  media: HTMLMediaElement,
  options: MediaPlayerOptions
): MediaPlayerHandle {
  const { isAudio, filename } = options;
  // Native controls are explicitly removed
  media.controls = false;
  if (typeof media.removeAttribute === 'function') {
    media.removeAttribute('controls');
  }

  let audioCard: HTMLElement | undefined;
  if (isAudio) {
    audioCard = document.createElement('div');
    audioCard.className = 'media-audio-card';

    const emblem = document.createElement('div');
    emblem.className = 'media-audio-emblem';
    emblem.appendChild(createSvgIcon(ICONS.audio));

    const info = document.createElement('div');
    info.className = 'media-audio-info';

    const title = document.createElement('span');
    title.className = 'media-audio-title';
    title.textContent =
      filename && filename.length > 0 ? filename : 'Audio recording';

    const state = document.createElement('span');
    state.className = 'media-audio-state';
    state.textContent = 'Audio track';

    info.append(title, state);
    audioCard.append(emblem, info);
  }

  // Chrome container (scrubber + controls)
  const chrome = document.createElement('div');
  chrome.className = `custom-media-player media-chrome ${
    isAudio ? 'media-is-audio' : 'media-is-video'
  }`;

  // --- Scrubber Wrapper & Interactive Slider ---
  const scrubberWrap = document.createElement('div');
  scrubberWrap.className = 'media-scrubber-wrap';

  const scrubber = document.createElement('div');
  scrubber.className = 'media-scrubber';
  scrubber.setAttribute('role', 'slider');
  scrubber.setAttribute('tabindex', '0');
  scrubber.setAttribute(
    'aria-label',
    isAudio ? 'Audio timeline' : 'Video timeline'
  );
  scrubber.setAttribute('aria-valuemin', '0');
  scrubber.setAttribute('aria-valuemax', '0');
  scrubber.setAttribute('aria-valuenow', '0');
  scrubber.setAttribute('aria-valuetext', '0:00 of 0:00');

  const rail = document.createElement('div');
  rail.className = 'media-track-rail';

  // Buffered ranges
  const bufferedBar = document.createElement('div');
  bufferedBar.className = 'media-buffered-bar';

  // Played progress
  const playedBar = document.createElement('div');
  playedBar.className = 'media-played-bar';

  // Markers track (where comment markers land)
  const track = document.createElement('div');
  track.className = 'time-track';
  track.dataset.mediaTimeline = 'true';

  // Pending selection (moment or dragged span)
  const pendingSelection = document.createElement('div');
  pendingSelection.className = 'media-pending-selection is-hidden';

  const pendingStartTag = document.createElement('span');
  pendingStartTag.className = 'pending-time-tag pending-start-tag';

  const spanHandle = document.createElement('button');
  spanHandle.type = 'button';
  spanHandle.className = 'timeline-span-handle';
  spanHandle.setAttribute('role', 'slider');
  spanHandle.setAttribute('tabindex', '0');
  spanHandle.setAttribute('aria-label', 'Adjust comment span end');
  spanHandle.setAttribute('aria-valuemin', '0');
  spanHandle.setAttribute('aria-valuemax', '0');
  spanHandle.setAttribute('aria-valuenow', '0');
  spanHandle.title = 'Drag or use left/right arrow keys to extend span';

  const pendingEndTag = document.createElement('span');
  pendingEndTag.className = 'pending-time-tag pending-end-tag';

  pendingSelection.append(pendingStartTag, spanHandle, pendingEndTag);

  // Hover indicator
  const hoverIndicator = document.createElement('div');
  hoverIndicator.className = 'media-hover-indicator is-hidden';

  const hoverRule = document.createElement('div');
  hoverRule.className = 'hover-rule';

  const hoverTimecode = document.createElement('div');
  hoverTimecode.className = 'hover-timecode';
  hoverTimecode.textContent = '0:00';

  const hoverCommentBtn = document.createElement('button');
  hoverCommentBtn.type = 'button';
  hoverCommentBtn.className = 'timeline-hover-comment-btn';
  hoverCommentBtn.setAttribute('aria-label', 'Comment at this time');
  hoverCommentBtn.title = isAudio
    ? 'Comment on this moment'
    : 'Comment on this frame';
  hoverCommentBtn.appendChild(createSvgIcon(ICONS.plus));

  hoverIndicator.append(hoverRule, hoverTimecode, hoverCommentBtn);

  rail.append(bufferedBar, playedBar, track, pendingSelection, hoverIndicator);
  scrubber.appendChild(rail);
  scrubberWrap.appendChild(scrubber);
  chrome.appendChild(scrubberWrap);

  // --- Controls Bar ---
  const controlsBar = document.createElement('div');
  controlsBar.className = 'media-controls-bar';

  // Left side: Play/Pause and Timecode
  const leftControls = document.createElement('div');
  leftControls.className = 'media-controls-left';

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'media-btn media-play-btn';
  playBtn.setAttribute('aria-label', 'Play');
  playBtn.title = 'Play (Space / K)';
  playBtn.appendChild(createSvgIcon(ICONS.play));

  const timecode = document.createElement('div');
  timecode.className = 'media-timecode';

  const currentSpan = document.createElement('span');
  currentSpan.className = 'time-current';
  currentSpan.textContent = '0:00';

  const sepSpan = document.createElement('span');
  sepSpan.className = 'time-sep';
  sepSpan.textContent = ' / ';

  const durationSpan = document.createElement('span');
  durationSpan.className = 'time-duration';
  durationSpan.textContent = '0:00';

  timecode.append(currentSpan, sepSpan, durationSpan);
  leftControls.append(playBtn, timecode);

  // Right side: Mute and Fullscreen (video only)
  const rightControls = document.createElement('div');
  rightControls.className = 'media-controls-right';

  const muteBtn = document.createElement('button');
  muteBtn.type = 'button';
  muteBtn.className = 'media-btn media-mute-btn';
  muteBtn.setAttribute('aria-label', 'Mute');
  muteBtn.title = 'Mute (M)';
  muteBtn.appendChild(createSvgIcon(ICONS.volume));
  rightControls.appendChild(muteBtn);

  let fullscreenBtn: HTMLButtonElement | undefined;
  if (!isAudio) {
    fullscreenBtn = document.createElement('button');
    fullscreenBtn.type = 'button';
    fullscreenBtn.className = 'media-btn media-fullscreen-btn';
    fullscreenBtn.setAttribute('aria-label', 'Fullscreen');
    fullscreenBtn.title = 'Fullscreen (F)';
    fullscreenBtn.appendChild(createSvgIcon(ICONS.fullscreen));
    rightControls.appendChild(fullscreenBtn);
  }

  controlsBar.append(leftControls, rightControls);
  chrome.appendChild(controlsBar);

  // The stage is the picture and its controls, and it is what fullscreen
  // takes. Fullscreening anything wider brings the page card with it: the
  // reading width, the filename strip, and controls stacked under a picture
  // capped at the inline height instead of laid over a frame that fills the
  // screen.
  const stage = document.createElement('div');
  stage.className = 'media-stage';
  stage.append(media, chrome);
  const doc = chrome.ownerDocument ?? document;

  // --------------------------------------------------------------------------
  // State and Helpers
  // --------------------------------------------------------------------------
  let pendingSpan: TimeSpan | null = null;
  let dragState: {
    pointerId: number;
    startSeconds: number;
    currentSeconds: number;
    hasMoved: boolean;
  } | null = null;
  let handleDragging = false;
  let pointerOverChrome = false;
  let cancelIdle: (() => void) | undefined;

  const videoMedia = media as WebKitFullscreenVideoElement;

  const canStageFullscreen = (): boolean =>
    typeof stage.requestFullscreen === 'function';

  const canNativeFullscreen = (): boolean =>
    typeof videoMedia.webkitEnterFullscreen === 'function' &&
    videoMedia.webkitSupportsFullscreen === true;

  const hasFullscreenSupport = (): boolean =>
    canStageFullscreen() || canNativeFullscreen();

  const updateFullscreenSupport = (): void => {
    if (!fullscreenBtn) return;
    const supported = hasFullscreenSupport();
    fullscreenBtn.hidden = !supported;
    if (supported) {
      fullscreenBtn.removeAttribute('hidden');
    } else {
      fullscreenBtn.setAttribute('hidden', '');
    }
  };

  const getDuration = (): number => {
    const d = media.duration;
    return Number.isFinite(d) && d > 0 ? d : 0;
  };

  const isStageFullscreen = (): boolean => doc.fullscreenElement === stage;

  const isNativeFullscreen = (): boolean =>
    videoMedia.webkitDisplayingFullscreen === true;

  const isFullscreen = (): boolean =>
    isStageFullscreen() || isNativeFullscreen();

  const leaveFullscreen = (): Promise<void> => {
    if (isNativeFullscreen()) {
      if (typeof videoMedia.webkitExitFullscreen === 'function') {
        try {
          videoMedia.webkitExitFullscreen();
        } catch {}
      }
      return Promise.resolve();
    }
    if (typeof doc.exitFullscreen !== 'function') return Promise.resolve();
    return Promise.resolve(doc.exitFullscreen()).then(() => undefined);
  };

  updateFullscreenSupport();

  /**
   * Where a moment or a span sits on the scrubber, in viewport pixels.
   *
   * Across, the rail, because that is where the times are laid out. Down, the
   * whole scrubber rather than the 4px rail, so a panel placed above it
   * clears the markers and the pending selection instead of sitting on them.
   */
  const measureOnScrubber = (span: TimeSpan): ClientBox => {
    const duration = getDuration();
    const across = getTrackGeometry(rail);
    const down = getTrackGeometry(scrubber);
    const start = timeToFraction(span.t, duration) ?? 0;
    const end =
      span.t_end === undefined
        ? start
        : (timeToFraction(span.t_end, duration) ?? start);
    return {
      left: across.left + start * across.width,
      top: down.top,
      width: Math.max(0, end - start) * across.width,
      height: down.height,
    };
  };

  /**
   * Tells the page a comment is being aimed at a moment or a span.
   *
   * This used to leave fullscreen before an aim that focuses, because the
   * composer lived in the sidebar outside the fullscreen element. The page
   * now opens the composer over the scrubber inside the stage, so nothing
   * here leaves. The one reader who still has to go to the sidebar is one
   * who has not verified an address, and only the page knows that, so the
   * page is what leaves fullscreen for them.
   */
  const dispatchTimeAim = (
    anchor: Extract<CommentAnchor, { kind: 'time' }>,
    focus = true
  ): void => {
    const roundedAnchor: Extract<CommentAnchor, { kind: 'time' }> = {
      kind: 'time',
      t: Math.round(anchor.t * 1000) / 1000,
      ...(anchor.t_end !== undefined
        ? { t_end: Math.round(anchor.t_end * 1000) / 1000 }
        : {}),
      ...(anchor.rect !== undefined ? { rect: anchor.rect } : {}),
    };
    if (typeof chrome.dispatchEvent !== 'function') return;
    const detail: TimeAimDetail = {
      anchor: roundedAnchor,
      focus,
      measure: () => measureOnScrubber(roundedAnchor),
    };
    chrome.dispatchEvent(createCustomEvent('relic:time-aim', detail));
  };

  const updateTimeDisplay = (): void => {
    const duration = getDuration();
    const current = media.currentTime;
    currentSpan.textContent = formatTimecode(current);
    durationSpan.textContent = formatTimecode(duration);

    scrubber.setAttribute('aria-valuemax', String(Math.floor(duration)));
    scrubber.setAttribute('aria-valuenow', String(Math.floor(current)));
    scrubber.setAttribute(
      'aria-valuetext',
      `${formatTimecode(current)} of ${formatTimecode(duration)}`
    );

    const fraction = timeToFraction(current, duration) ?? 0;
    playedBar.style.width = `${fraction * 100}%`;
  };

  const updateBufferedDisplay = (): void => {
    const duration = getDuration();
    if (duration <= 0 || !media.buffered || media.buffered.length === 0) {
      bufferedBar.style.width = '0%';
      return;
    }
    const end = media.buffered.end(media.buffered.length - 1);
    const fraction = timeToFraction(end, duration) ?? 0;
    bufferedBar.style.width = `${fraction * 100}%`;
  };

  const updatePlayState = (): void => {
    const isPaused = media.paused;
    playBtn.replaceChildren(createSvgIcon(isPaused ? ICONS.play : ICONS.pause));
    playBtn.setAttribute('aria-label', isPaused ? 'Play' : 'Pause');
  };

  const updateMuteState = (): void => {
    const isMuted = media.muted || media.volume === 0;
    muteBtn.replaceChildren(createSvgIcon(isMuted ? ICONS.mute : ICONS.volume));
    muteBtn.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
  };

  const updatePendingVisuals = (): void => {
    const duration = getDuration();
    if (pendingSpan === null || duration <= 0) {
      pendingSelection.classList.add('is-hidden');
      return;
    }

    pendingSelection.classList.remove('is-hidden');
    const startFrac = timeToFraction(pendingSpan.t, duration) ?? 0;
    const endSeconds = pendingSpan.t_end ?? pendingSpan.t;
    const endFrac = timeToFraction(endSeconds, duration) ?? startFrac;

    const leftPct = Number((startFrac * 100).toFixed(4));
    const widthPct = Number(
      (Math.max(0, endFrac - startFrac) * 100).toFixed(4)
    );

    pendingSelection.style.left = `${leftPct}%`;
    pendingSelection.style.width = `${widthPct}%`;

    pendingStartTag.textContent = formatTimecode(pendingSpan.t);
    pendingEndTag.textContent = formatTimecode(endSeconds);
    pendingEndTag.hidden = pendingSpan.t_end === undefined;

    spanHandle.setAttribute('aria-valuenow', String(endSeconds));
    spanHandle.setAttribute('aria-valuemin', String(pendingSpan.t));
    spanHandle.setAttribute('aria-valuemax', String(duration));
  };

  const setPendingAnchor = (span: TimeSpan | null): void => {
    pendingSpan = span;
    updatePendingVisuals();
  };

  const togglePlay = (): void => {
    if (media.paused) {
      if (
        media.ended ||
        (Number.isFinite(media.duration) &&
          media.duration > 0 &&
          media.currentTime >= media.duration - STEP_SECONDS / 2)
      ) {
        media.currentTime = 0;
        updateTimeDisplay();
      }
      const playPromise = media.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {});
      }
    } else {
      if (typeof media.pause === 'function') {
        media.pause();
      }
    }
  };

  const toggleMute = (): void => {
    media.muted = !media.muted;
  };

  // --------------------------------------------------------------------------
  // Fullscreen and the idle frame
  // --------------------------------------------------------------------------
  const toggleFullscreen = (): void => {
    if (isFullscreen()) {
      leaveFullscreen().catch(() => {});
      return;
    }
    if (canStageFullscreen()) {
      Promise.resolve(stage.requestFullscreen({ navigationUI: 'hide' })).catch(
        () => {}
      );
    } else if (canNativeFullscreen()) {
      try {
        videoMedia.webkitEnterFullscreen?.();
      } catch {}
    }
  };

  // Keyboard focus, not any focus. A press on the picture focuses the
  // scrubber, and Chrome focuses a button it clicks, so plain focus would pin
  // the controls on screen after the first click. A reader stepping through
  // the controls by keyboard matches `:focus-visible` and keeps them.
  const keyboardFocusInChrome = (): boolean => {
    const active = doc.activeElement;
    if (!active || !chrome.contains(active)) return false;
    try {
      return active.matches(':focus-visible');
    } catch {
      return false;
    }
  };

  const clearIdleTimer = (): void => {
    cancelIdle?.();
    cancelIdle = undefined;
  };

  const goIdle = (): void => {
    cancelIdle = undefined;
    if (
      !isStageFullscreen() ||
      media.paused ||
      pointerOverChrome ||
      dragState !== null ||
      handleDragging ||
      keyboardFocusInChrome() ||
      // A comment being written or read over the scrubber. Fading the
      // controls out from under it would leave a panel pointing at a
      // scrubber nobody can see, and hide the cursor over what is being
      // typed.
      stage.querySelector('.popover') !== null
    ) {
      return;
    }
    stage.classList.add('is-idle');
  };

  // Any activity brings the controls back and restarts the wait. The wait only
  // runs while the stage is fullscreen and playing, so pausing or leaving
  // fullscreen shows the controls and keeps them. A wait that ends while one
  // of the guards in `goIdle` holds simply lapses: every way out of a guard
  // (pointer leaving the controls, focus leaving them, a drag releasing,
  // playback resuming) is itself activity and starts a fresh one.
  const wake = (): void => {
    clearIdleTimer();
    stage.classList.remove('is-idle');
    if (!isStageFullscreen() || media.paused) return;
    const timer = setTimeout(goIdle, FULLSCREEN_IDLE_MS);
    cancelIdle = () => clearTimeout(timer);
  };

  const onFullscreenChange = (event?: Event): void => {
    const isFs =
      event?.type === 'webkitbeginfullscreen'
        ? true
        : event?.type === 'webkitendfullscreen'
          ? false
          : isFullscreen();
    fullscreenBtn?.replaceChildren(
      createSvgIcon(isFs ? ICONS.fullscreenExit : ICONS.fullscreen)
    );
    fullscreenBtn?.setAttribute(
      'aria-label',
      isFs ? 'Exit fullscreen' : 'Fullscreen'
    );
    wake();
  };

  const onPointerEnterChrome = (): void => {
    pointerOverChrome = true;
    wake();
  };

  const onPointerLeaveChrome = (): void => {
    pointerOverChrome = false;
    wake();
  };

  const seekRelative = (
    seconds: number,
    duration: number,
    coarse = false
  ): void => {
    const magnitude = Math.abs(seconds);
    const step = coarse
      ? Math.sign(seconds) * Math.max(magnitude, COARSE_STEP_SECONDS)
      : seconds;
    const next = Math.max(
      0,
      Math.min(Math.max(duration, 0), media.currentTime + step)
    );
    media.currentTime = next;
    updateTimeDisplay();
  };

  // --------------------------------------------------------------------------
  // Media Listeners
  // --------------------------------------------------------------------------
  media.addEventListener('play', updatePlayState);
  media.addEventListener('pause', updatePlayState);
  media.addEventListener('timeupdate', updateTimeDisplay);
  media.addEventListener('durationchange', () => {
    updateFullscreenSupport();
    updateTimeDisplay();
    updateBufferedDisplay();
    updatePendingVisuals();
  });
  media.addEventListener('loadedmetadata', () => {
    updateFullscreenSupport();
    updateTimeDisplay();
    updateBufferedDisplay();
    updatePendingVisuals();
  });
  media.addEventListener('canplay', () => {
    updateFullscreenSupport();
  });
  media.addEventListener('progress', updateBufferedDisplay);
  media.addEventListener('volumechange', updateMuteState);
  media.addEventListener('seeking', updateTimeDisplay);
  media.addEventListener('seeked', updateTimeDisplay);
  playBtn.addEventListener('click', togglePlay);
  muteBtn.addEventListener('click', toggleMute);
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', toggleFullscreen);
    doc.addEventListener('fullscreenchange', onFullscreenChange);
    media.addEventListener('webkitbeginfullscreen', onFullscreenChange);
    media.addEventListener('webkitendfullscreen', onFullscreenChange);
    stage.addEventListener('pointermove', wake);
    stage.addEventListener('pointerdown', wake);
    stage.addEventListener('pointerup', wake);
    stage.addEventListener('keydown', wake);
    chrome.addEventListener('pointerenter', onPointerEnterChrome);
    chrome.addEventListener('pointerleave', onPointerLeaveChrome);
    chrome.addEventListener('focusin', wake);
    chrome.addEventListener('focusout', wake);
    media.addEventListener('play', wake);
    media.addEventListener('pause', wake);
  }

  // Click on media picture focuses the player and toggles play/pause
  media.addEventListener('click', (event: MouseEvent) => {
    if (typeof event.preventDefault === 'function') event.preventDefault();
    scrubber.focus();
    togglePlay();
  });

  // --------------------------------------------------------------------------
  // Scrubber Pointer Gestures (Seek, Drag-to-span, Hover indicator)
  // --------------------------------------------------------------------------
  scrubber.addEventListener('pointerdown', (event: PointerEvent) => {
    // If the click is directly on the span handle or a marker button, let them handle it
    const target = event.target as HTMLElement | null;
    if (
      target?.closest('.timeline-span-handle') ||
      target?.closest('.time-marker') ||
      target?.closest('.timeline-hover-comment-btn')
    ) {
      return;
    }

    const duration = getDuration();
    if (duration <= 0) return;
    if (typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    scrubber.focus();
    const geom = getTrackGeometry(rail);
    const frac = pointerFraction(event.clientX, geom.left, geom.width);
    const t = fractionToTime(frac, duration);

    media.currentTime = t;
    if (typeof media.pause === 'function') {
      media.pause();
    }

    dragState = {
      pointerId: event.pointerId,
      startSeconds: t,
      currentSeconds: t,
      hasMoved: false,
    };

    hoverIndicator.classList.add('is-hidden');

    const onWindowMove = (e: PointerEvent): void => {
      if (dragState === null) return;
      // The rail rect is read live, which is only safe because nothing in
      // this gesture can move it. The aiming event can open the thread
      // sidebar, for a reader who has no verified address yet, and so shift
      // this rail 176px sideways, which is why it is held until pointerup: a
      // track that slides under a reader's finger maps the same physical
      // position to a later time, and the span they drew ends somewhere they
      // never chose.
      const g = getTrackGeometry(rail);
      const f = pointerFraction(e.clientX, g.left, g.width);
      const currentSeconds = fractionToTime(f, duration);
      dragState.currentSeconds = currentSeconds;
      if (Math.abs(currentSeconds - dragState.startSeconds) >= 0.2) {
        dragState.hasMoved = true;
      }
      media.currentTime = currentSeconds;
      if (dragState.hasMoved) {
        // Painted locally, so the reader still watches the selection and its
        // two timecodes grow under the pointer. None of that needs the page,
        // which is the only reason this is safe to defer.
        setPendingAnchor(spanFromDrag(dragState.startSeconds, currentSeconds));
      }
    };

    const onWindowUp = (): void => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointermove', onWindowMove);
        window.removeEventListener('pointerup', onWindowUp);
        window.removeEventListener('pointercancel', onWindowUp);
      }
      if (dragState === null) return;

      if (
        dragState.hasMoved &&
        Math.abs(dragState.currentSeconds - dragState.startSeconds) >= 0.2
      ) {
        // The end is the last position the pointer reached against the
        // geometry the whole gesture saw. Aiming below is what can open the
        // sidebar, so nothing has shifted between that read and this one.
        // Letting go is where the comment starts, so the composer that opens
        // over the span takes focus and the reader can type straight away.
        const span = spanFromDrag(
          dragState.startSeconds,
          dragState.currentSeconds
        );
        setPendingAnchor(span);
        dispatchTimeAim({
          kind: 'time',
          t: span.t,
          ...(span.t_end !== undefined ? { t_end: span.t_end } : {}),
        });
      } else {
        // Bare click seeking: seeks to time without opening composer
        setPendingAnchor(null);
        chrome.dispatchEvent(
          createCustomEvent('relic:time-selection-cleared', {})
        );
      }
      dragState = null;
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('pointermove', onWindowMove);
      window.addEventListener('pointerup', onWindowUp);
      window.addEventListener('pointercancel', onWindowUp);
    }
  });

  scrubber.addEventListener('pointermove', (event: PointerEvent) => {
    const duration = getDuration();
    // Either drag owns the pointer. Offering a new comment under the end of
    // a span the reader is still stretching is a second, competing target.
    if (duration <= 0 || dragState !== null || handleDragging) return;

    const geom = getTrackGeometry(rail);
    const frac = pointerFraction(event.clientX, geom.left, geom.width);
    const currentSeconds = fractionToTime(frac, duration);

    // Hover affordance: update without seeking
    hoverIndicator.classList.remove('is-hidden');
    hoverIndicator.style.left = `${frac * 100}%`;
    hoverTimecode.textContent = formatTimecode(currentSeconds);
    hoverCommentBtn.setAttribute(
      'aria-label',
      `Comment at ${formatTimecode(currentSeconds)}`
    );
    hoverCommentBtn.dataset.time = String(currentSeconds);
  });

  scrubber.addEventListener('pointerleave', () => {
    if (dragState === null) {
      hoverIndicator.classList.add('is-hidden');
    }
  });

  // Hover comment button click
  hoverCommentBtn.addEventListener('click', (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const duration = getDuration();
    const t = Number(hoverCommentBtn.dataset.time ?? media.currentTime);
    const boundedTime = Math.max(0, Math.min(duration, t));

    media.currentTime = boundedTime;
    if (typeof media.pause === 'function') {
      media.pause();
    }

    const anchor: Extract<CommentAnchor, { kind: 'time' }> = {
      kind: 'time',
      t: boundedTime,
    };
    setPendingAnchor({ t: boundedTime });
    dispatchTimeAim(anchor);
  });

  // --------------------------------------------------------------------------
  // Span End Handle (Dragging & Keyboard Stepping)
  // --------------------------------------------------------------------------
  spanHandle.addEventListener('pointerdown', (event: PointerEvent) => {
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    if (typeof event.preventDefault === 'function') event.preventDefault();
    spanHandle.focus();
    handleDragging = true;
    hoverIndicator.classList.add('is-hidden');

    const onHandleMove = (e: PointerEvent): void => {
      if (!handleDragging || pendingSpan === null) return;
      const duration = getDuration();
      if (duration <= 0) return;

      const geom = getTrackGeometry(rail);
      const frac = pointerFraction(e.clientX, geom.left, geom.width);
      const newTime = fractionToTime(frac, duration);

      if (newTime - pendingSpan.t < STEP_SECONDS / 2) {
        pendingSpan = { t: pendingSpan.t };
      } else {
        pendingSpan = { t: pendingSpan.t, t_end: newTime };
      }

      media.currentTime = newTime;
      updatePendingVisuals();
      dispatchTimeAim(
        {
          kind: 'time',
          t: pendingSpan.t,
          ...(pendingSpan.t_end !== undefined
            ? { t_end: pendingSpan.t_end }
            : {}),
        },
        false
      );
    };

    const onHandleUp = (): void => {
      handleDragging = false;
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointermove', onHandleMove);
        window.removeEventListener('pointerup', onHandleUp);
        window.removeEventListener('pointercancel', onHandleUp);
      }
      spanHandle.focus();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('pointermove', onHandleMove);
      window.addEventListener('pointerup', onHandleUp);
      window.addEventListener('pointercancel', onHandleUp);
    }
  });

  spanHandle.addEventListener('keydown', (event: KeyboardEvent) => {
    if (pendingSpan === null) return;
    const duration = getDuration();
    const isCoarse = Boolean(
      event.shiftKey ||
        (typeof event.getModifierState === 'function' &&
          event.getModifierState('Shift')) ||
        event.key === 'PageUp' ||
        event.key === 'PageDown'
    );

    if (event.key === 'ArrowRight' || event.key === 'PageUp') {
      event.preventDefault();
      event.stopPropagation();
      const updated = stepSpanEnd(pendingSpan, 1, duration, isCoarse);
      pendingSpan = updated;
      media.currentTime = updated.t_end ?? updated.t;
      updatePendingVisuals();
      dispatchTimeAim(
        {
          kind: 'time',
          t: updated.t,
          ...(updated.t_end !== undefined ? { t_end: updated.t_end } : {}),
        },
        false
      );
      spanHandle.focus();
    } else if (event.key === 'ArrowLeft' || event.key === 'PageDown') {
      event.preventDefault();
      event.stopPropagation();
      const updated = stepSpanEnd(pendingSpan, -1, duration, isCoarse);
      pendingSpan = updated;
      media.currentTime = updated.t_end ?? updated.t;
      updatePendingVisuals();
      dispatchTimeAim(
        {
          kind: 'time',
          t: updated.t,
          ...(updated.t_end !== undefined ? { t_end: updated.t_end } : {}),
        },
        false
      );
      spanHandle.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      pendingSpan = { t: pendingSpan.t };
      media.currentTime = pendingSpan.t;
      updatePendingVisuals();
      dispatchTimeAim({ kind: 'time', t: pendingSpan.t }, false);
      spanHandle.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      pendingSpan = { t: pendingSpan.t, t_end: duration };
      media.currentTime = duration;
      updatePendingVisuals();
      dispatchTimeAim(
        { kind: 'time', t: pendingSpan.t, t_end: duration },
        false
      );
      spanHandle.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      pendingSpan = { t: pendingSpan.t };
      media.currentTime = pendingSpan.t;
      updatePendingVisuals();
      dispatchTimeAim({ kind: 'time', t: pendingSpan.t }, false);
      spanHandle.focus();
    }
  });

  // --------------------------------------------------------------------------
  // Keyboard Controls on Scrubber Slider
  // --------------------------------------------------------------------------
  scrubber.addEventListener('keydown', (event: KeyboardEvent) => {
    const duration = getDuration();
    const isCoarse = event.shiftKey;

    switch (event.key) {
      case 'ArrowLeft': {
        event.preventDefault();
        seekRelative(-STEP_SECONDS, duration, isCoarse);
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        seekRelative(STEP_SECONDS, duration, isCoarse);
        break;
      }
      case 'PageUp': {
        event.preventDefault();
        seekRelative(5, duration, true);
        break;
      }
      case 'PageDown': {
        event.preventDefault();
        seekRelative(-5, duration, true);
        break;
      }
      case 'Home': {
        event.preventDefault();
        media.currentTime = 0;
        updateTimeDisplay();
        break;
      }
      case 'End': {
        event.preventDefault();
        media.currentTime = duration;
        updateTimeDisplay();
        break;
      }
      case ' ':
      case 'k':
      case 'K': {
        event.preventDefault();
        togglePlay();
        break;
      }
      case 'm':
      case 'M': {
        event.preventDefault();
        toggleMute();
        break;
      }
      case 'f':
      case 'F': {
        if (!isAudio && hasFullscreenSupport()) {
          event.preventDefault();
          toggleFullscreen();
        }
        break;
      }
      case 'c':
      case 'C':
      case 'Enter': {
        event.preventDefault();
        const t = media.currentTime;
        if (typeof media.pause === 'function') {
          media.pause();
        }
        const anchor: Extract<CommentAnchor, { kind: 'time' }> = {
          kind: 'time',
          t,
        };
        setPendingAnchor({ t });
        dispatchTimeAim(anchor);
        break;
      }
    }
  });

  // --------------------------------------------------------------------------
  // Incoming Selection Events from Stage/Composer
  // --------------------------------------------------------------------------
  const onTimeSelection = (event: Event): void => {
    const detail = (event as CustomEvent).detail;
    if (detail?.anchor && detail.anchor.kind === 'time') {
      const a = detail.anchor as Extract<CommentAnchor, { kind: 'time' }>;
      setPendingAnchor({
        t: a.t,
        ...(a.t_end !== undefined ? { t_end: a.t_end } : {}),
      });
    }
  };

  const onTimeCleared = (): void => {
    setPendingAnchor(null);
  };

  chrome.addEventListener('relic:time-selection', onTimeSelection);
  chrome.addEventListener('relic:time-selection-cleared', onTimeCleared);

  // Initial display setup
  updateTimeDisplay();
  updatePlayState();
  updateMuteState();

  return {
    stage,
    chrome,
    audioCard,
    track,
    destroy: () => {
      clearIdleTimer();
      if (typeof media.removeEventListener === 'function') {
        media.removeEventListener('play', updatePlayState);
        media.removeEventListener('pause', updatePlayState);
        media.removeEventListener('play', wake);
        media.removeEventListener('pause', wake);
        media.removeEventListener('timeupdate', updateTimeDisplay);
        media.removeEventListener('webkitbeginfullscreen', onFullscreenChange);
        media.removeEventListener('webkitendfullscreen', onFullscreenChange);
        media.removeEventListener('progress', updateBufferedDisplay);
        media.removeEventListener('volumechange', updateMuteState);
      }
      if (typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('fullscreenchange', onFullscreenChange);
      }
      if (typeof chrome.removeEventListener === 'function') {
        chrome.removeEventListener('relic:time-selection', onTimeSelection);
        chrome.removeEventListener(
          'relic:time-selection-cleared',
          onTimeCleared
        );
      }
    },
    setPendingAnchor,
  };
}
