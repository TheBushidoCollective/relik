/**
 * The DOM layer.
 *
 * Everything that decides anything lives in `viewer.ts`, which has no DOM in
 * it and is tested directly. This file only draws what that decided, so the
 * rules cannot quietly diverge from their tests.
 *
 * Two things here are security, not presentation:
 *
 * 1. **Content reaches the DOM through `textContent` or through the escaping
 *    renderer, never through `innerHTML` on raw bytes.**
 * 2. **HTML content is never rendered on this origin.** It goes to the
 *    usercontent origin through an iframe that gets the markup and never the
 *    key.
 */

import {
  type CommentAnchor,
  deriveCommentKey,
  parseFragment,
  shareMailtoUrl,
} from '@relic/format';
import { registerBuiltInAnchorAdapters } from './anchor-adapters.ts';
import {
  type AnchorSurface,
  adapterFor,
  anchorLabel,
  boxFromUnit,
  MARK_UNPLACEABLE_NOTE,
  MIN_REGION_PX,
  rectFromCorners,
  UNSUPPORTED_ANCHOR_LABEL,
  unitFromPointer,
  unitMinimumForPixels,
} from './anchoring.ts';
import { captureSelectionQuote } from './annotate-quote.ts';
import { isImageElement } from './annotate-region.ts';
import { formatTimecode, formatTimecodeTenths } from './annotate-time.ts';
import { isFrameScrollMessage } from './frame-scroll.ts';
import { createMediaPlayer, type TimeAimDetail } from './media-player.ts';
import { disposeOtioViews, otioControllerFor, type OtioAimDetail } from './otio-bridge.ts';
import {
  landmarkScrollDelta,
  nearestScrollLandmark,
  type ScrollPosition,
} from './scroll-landmark.ts';
import { syncFrameScrollers, syncScrollers } from './scroll-sync.ts';
import { localStorageKeyVault } from './vault.ts';

// The adapter table is installed once, from the one module that knows the
// complete built-in set. See `anchor-adapters.ts` for why registration is not
// done by each adapter module at its own top level.
registerBuiltInAnchorAdapters();

import {
  type FrameMarkClickMessage,
  type FrameMarkHoverMessage,
  type FrameOpenLinkMessage,
  type FramePointMessage,
  type FrameRect,
  type FrameRegionMessage,
  type FrameSelectionMessage,
  isFrameMarkClickMessage,
  isFrameMarkHoverMessage,
  isFrameOpenLinkMessage,
  isFramePointMessage,
  isFrameRegionMessage,
  isFrameSelectionClearedMessage,
  isFrameSelectionMessage,
} from './annotate-frame.ts';
import {
  type AddressedBy,
  addressedBadgeLabel,
  type CommentCipher,
  type CommentEntry,
  type CommentNode,
  canEditComment,
  canResolveComment,
  collectDisplayedEntries,
  commentCipher,
  commentTime,
  DELIVERY_DISCLOSURE,
  DISPLAY_NAME_NOTE,
  EDITED_LABEL,
  editComment,
  IDENTITY_DISCLOSURE,
  KEY_AT_RISK_NOTE,
  keySurvivesNavigation,
  loadThread,
  MAX_BODY_BYTES,
  MAX_DISPLAY_NAME_BYTES,
  PUBLISHER_AUTHOR,
  plainLabel,
  postComment,
  quotedTargetLabel,
  type Refusal,
  readSession,
  requestMagicLink,
  resolveAddressedMap,
  resolvedLabel,
  type SessionState,
  setCommentResolved,
  threadCountLabel,
  threadEntries,
  unwrapTextQuotes,
  utf8Bytes,
  wrapTextQuote,
} from './comments.ts';
import {
  type AnchorBox,
  anchorFromClientRect,
  COPY_FAILED_NOTE,
  copyText,
  inlineComposer,
  type PopoverAction,
  type PopoverLayer,
  placePopover,
  popoverCard,
  popoverLayer,
  selectionOffer,
} from './popover.ts';

export { quotedTargetLabel } from './comments.ts';

import {
  bytesEqual,
  comparisonAvailability,
  createImageDiff,
  createTextDiff,
  diffModeForRoute,
  diffModeForRoutes,
  type TextDiffPart,
  versionHistoryAvailability,
} from './diff.ts';
import {
  type ChangeJump,
  diffTrees,
  type RenderedChange,
  type TreeDiff,
} from './domdiff.ts';
import { transpileJsx } from './jsx.ts';
import { renderMarkdown } from './markdown.ts';
import {
  buildCommentedDashboardRows,
  buildLocalDashboardRows,
  type DashboardRelicRow,
} from './relic-rows.ts';
import {
  type Anchor,
  applyAnchors,
  applyMarks,
  captureTree,
  isTreeMessage,
  type Mark,
  type TreeNode,
} from './rendered-tree.ts';
import {
  addressCount,
  addressProblem,
  type ParsedAddresses,
  parseAddresses,
  readerShareEmail,
  refusalEndsSharing,
  requestShare,
  SHARE_CHECKING_NOTE,
  SHARE_COPIED_NOTE,
  SHARE_FACT_SENDING,
  SHARE_FACT_STORING,
  SHARE_KEY_WARNING,
  SHARE_MAX_PER_CALL,
  SHARE_PROVING_NOTE,
  SHARE_SIGN_IN_REASON,
  type Shared,
  sharedSummary,
  shareRefusal,
} from './share.ts';
import { buildCodeTable, buildProse } from './text-views.ts';
import {
  type DeadView,
  formatBytes,
  type HistoricalVersionState,
  isAudioMedia,
  isKeyEntryRecoverable,
  load,
  loadCommentedRelics,
  loadHistoricalVersion,
  type MintResponse,
  openRelicWithKey,
  type ReadyView,
  type RenderRoute,
  type ViewerDeps,
} from './viewer.ts';

const SERVICE_ORIGIN =
  typeof window === 'undefined' ? '' : window.location.origin;

/**
 * The wordmark in the accession band.
 *
 * The recipient is deciding whether to trust an unfamiliar domain, so the
 * wordmark is the domain itself rather than a product name they have no way to
 * connect to the address bar. It is a brand fact and belongs in code: deriving
 * it from the serving origin would print whatever host the deployment happens
 * to answer on.
 */
const WORDMARK = 'relik.link';

/**
 * What the marker beside the actions says, per route.
 *
 * It is the visible label, the accessible name, and the stem of the tooltip,
 * and it was three separate strings until two of them disagreed. It was then
 * one string for every relic, which is how a five-second mp4 came to tell its
 * recipient it runs the author's code. Nothing an author wrote executes for a
 * video, an image, a markdown file or a PDF: the browser decodes it, and
 * `sandbox.html` is never reached.
 *
 * The route is the key rather than the renderer class, because the route is
 * what executes. `spec/format.md` 3.6 lets a declared class and a sniffed
 * class disagree, and the viewer has already resolved that to the least
 * privileged of the two by the time this is read, so this states the decision
 * rather than the claim the envelope made.
 *
 * Each line names the mechanism, then what the reader is owed about author
 * code, so the sentences stay parallel and the one route that really does run
 * code reads as the exception it is.
 */
const MARKER_LABELS: Record<RenderRoute, string> = {
  markdown: 'Rendered as text, no author code',
  code: 'Rendered as text, no author code',
  image: 'Shown as an image, no author code',
  media: 'Plays in your browser, no author code',
  otio: 'Plays its timeline in your browser, no author code',
  pdf: 'Rendered as a document, no author code',
  'sandboxed-html': 'Runs author code, isolated',
  'sandboxed-jsx': 'Runs author code, isolated',
  download: 'Downloads to your device, no author code',
};

export function markerLabelFor(route: RenderRoute): string {
  return MARKER_LABELS[route];
}

const ICONS = {
  copy: 'M5 2h7a1 1 0 0 1 1 1v8h-1V3H5V2zM3 4h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm0 1v8h7V5H3z',
  compare:
    'M2 4h9L9 2l.7-.7L13 4.5 9.7 8 9 7.3l2-2H2V4zm12 8H5l2 2-.7.7L3 11.5 6.3 8l.7.7-2 2h9V12z',
  download:
    'M7.5 1h1v7.3l2.6-2.6.7.7L8 10.2 4.2 6.4l.7-.7 2.6 2.6V1zM2 12h12v1H2v-1z',
  source:
    'M5.7 3.3 2 7l3.7 3.7.7-.7L3.4 7l3-3-.7-.7zm4.6 0-.7.7 3 3-3 3 .7.7L14 7l-3.7-3.7z',
  rendered: 'M2 3h12v1H2V3zm0 3h12v1H2V6zm0 3h8v1H2V9zm0 3h10v1H2v-1z',
  flag: 'M3 1h1v14H3V1zm2 1h8l-2 3 2 3H5V2z',
  chevron: 'M3.4 5.7 8 10.3l4.6-4.6-.7-.7L8 8.9 4.1 5l-.7.7z',
  swipe: 'M7.5 1h1v14h-1V1zM2 7.5h3.5v1H2v-1zm8.5 0H14v1h-3.5v-1z',
  columns: 'M2 2h5v12H2V2zm1 1v10h3V3H3zm6-1h5v12H9V2zm1 1v10h3V3h-3z',
  // A speech rectangle with a tail, drawn on the same 16-unit grid and with
  // the same single-path construction as the rest of the set.
  comment: 'M2 2h12v9H7.5L4 14v-3H2V2zm1 1v7h2v2.1L7.1 10H13V3H3z',
  // Four 3x3 tiles on a 16-unit grid representing a collection/catalogue of relics.
  grid: 'M2 2h4.5v4.5H2V2zm7.5 0H14v4.5H9.5V2zM2 9.5h4.5V14H2V9.5zm7.5 0H14V14H9.5V9.5z',
  // An envelope, outline drawn with two holes like `copy`, because sharing
  // here ends in an email the reader sends.
  share: 'M1.5 3h13v10h-13zm1.3 1L8 7.6 13.2 4zM2.5 5.2V12h11V5.2L8 9z',
  close:
    'M4.2 3.5 8 7.3l3.8-3.8.7.7L8.7 8l3.8 3.8-.7.7L8 8.7l-3.8 3.8-.7-.7L7.3 8 3.5 4.2z',
} as const;

function icon(path: string): SVGSVGElement {
  // Inline SVG rather than an emoji or a webfont: the CSP blocks external
  // anything, and an emoji is not an icon system.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.setAttribute('d', path);
  svg.appendChild(node);
  return svg;
}

function button(
  label: string,
  iconPath: string,
  onClick: () => void
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'action';
  element.appendChild(icon(iconPath));
  const text = document.createElement('span');
  text.textContent = label;
  element.appendChild(text);
  element.addEventListener('click', onClick);
  return element;
}

/**
 * The filename is untrusted and is used here as a lookup key, which is the
 * same defect class as archive entry names. Path separators and leading dots
 * are stripped rather than trusted.
 */
export function safeDownloadName(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/^\.+/, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'relic';
}

/**
 * The mimetype handed to a Blob is derived from magic bytes, never from the
 * declared type. A declared `image/svg+xml` would otherwise be a route into
 * script execution, which is why SVG is classified as a web page instead.
 */
export function sniffImageType(content: Uint8Array): string {
  const starts = (...bytes: number[]): boolean =>
    bytes.every((byte, index) => content[index] === byte);

  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x42, 0x4d)) return 'image/bmp';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    content[8] === 0x57 &&
    content[9] === 0x45
  ) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

function decodeText(content: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(content);
}

function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const element = document.createElement('div');
  element.className = 'toast';
  element.setAttribute('role', 'status');
  element.textContent = message;
  document.body.appendChild(element);
  window.setTimeout(() => element.remove(), 4000);
}

/**
 * A one-off statement above the content.
 *
 * The pre-render statement that used to greet every sandboxed relic is gone,
 * demoted to a marker in the bar, because the risk it described was removed.
 * This remains for the cases that are genuinely about this file: a downgrade,
 * or a component that would not compile. Those are conditions of the content
 * in front of the reader, not a standing warning.
 */
function notice(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'notice';
  element.appendChild(icon(ICONS.flag));
  const span = document.createElement('span');
  span.textContent = text;
  element.appendChild(span);
  return element;
}

function downloadContent(view: ReadyView): void {
  const blob = new Blob([view.content as unknown as BlobPart], {
    type: 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeDownloadName(view.filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export interface BarOptions {
  readonly onCompare?: () => void;
  readonly comparisonOpen?: boolean;
  /**
   * Which version the reader is looking at, when that is not the current
   * one. Set while a comparison is open so the taskbar names the version
   * being compared rather than the one behind it.
   */
  readonly selectedVersion?: number;
  /**
   * Takes the reader to the thread. Present on every renderable relic, and
   * absent while a comparison is open, where the thread is not on the page.
   */
  readonly onComments?: () => void;
  /**
   * How many comments the thread is showing, once it knows. `undefined` is
   * the loading state rather than zero: a badge reading `0` before the fetch
   * lands is a claim, and it is wrong about a third of the time.
   */
  readonly commentCount?: number;
  /** Offered only when there is more than one historical version to pick. */
  readonly onSelectVersion?: (version: number) => void;
  /**
   * Opens the share panel, handed the control that opened it so focus can go
   * back there when the panel closes. Offered on every view that holds the
   * key, including a download-only relic and an open comparison: sharing
   * needs the key, never a rendered page.
   */
  readonly onShare?: (opener: HTMLElement) => void;
}

/**
 * The version, as the taskbar shows it.
 *
 * Two strings rather than one, because the row has already overflowed once at
 * narrow width and the long form does not fit at 320 CSS pixels. The
 * stylesheet swaps them, so neither form is built by measuring anything.
 */
function versionLabels(
  shown: number,
  current: number
): { readonly long: string; readonly short: string } {
  return {
    long: `Version ${shown} of ${current}`,
    short: `v${shown}/${current}`,
  };
}

/**
 * The version control on the taskbar.
 *
 * Offers a dropdown of all versions when onSelectVersion is provided. Selecting
 * an earlier version displays that version on its own at full height with its
 * comment thread. Compare mode is entered deliberately through the compare button.
 */
function buildVersionControl(
  view: ReadyView,
  options: BarOptions
): HTMLElement | undefined {
  if (!Number.isInteger(view.currentVersion) || view.currentVersion <= 1) {
    return undefined;
  }

  const shown = options.selectedVersion ?? view.version;
  const labels = versionLabels(shown, view.currentVersion);
  const wrap = document.createElement('div');
  wrap.className = 'version';

  const text = (parent: HTMLElement): void => {
    const long = document.createElement('span');
    long.className = 'version-long';
    long.textContent = labels.long;
    const short = document.createElement('span');
    short.className = 'version-short';
    short.setAttribute('aria-hidden', 'true');
    short.textContent = labels.short;
    parent.append(long, short);
  };

  const onSelect = options.onSelectVersion;
  if (onSelect === undefined) {
    const label = document.createElement('div');
    label.className = 'version-label';
    text(label);
    wrap.appendChild(label);
    return wrap;
  }

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'version-label version-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute(
    'aria-label',
    `${labels.long}. Choose a version to view`
  );
  text(trigger);
  trigger.appendChild(icon(ICONS.chevron));

  const list = document.createElement('div');
  list.className = 'version-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Version to view');
  list.hidden = true;

  const optionElements: HTMLElement[] = [];
  for (let version = view.currentVersion; version >= 1; version--) {
    const option = document.createElement('div');
    option.className = 'version-option';
    option.dataset['version'] = String(version);
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', version === shown ? 'true' : 'false');
    option.tabIndex = -1;
    option.textContent =
      version === view.currentVersion
        ? `Version ${version}, current`
        : `Version ${version}`;
    option.addEventListener('click', () => {
      close();
      onSelect(version);
    });
    list.appendChild(option);
    optionElements.push(option);
  }

  let open = false;
  function close(focusTrigger = false): void {
    if (!open) return;
    open = false;
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) trigger.focus();
  }

  const move = (from: number, delta: number): void => {
    const last = optionElements.length - 1;
    const next = Math.min(last, Math.max(0, from + delta));
    optionElements[next]?.focus();
  };

  function show(index: number): void {
    open = true;
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    optionElements[index]?.focus();
  }

  trigger.addEventListener('click', () => {
    if (open) close();
    else {
      const currentIndex = optionElements.findIndex(
        (el) => Number(el.dataset['version']) === shown
      );
      show(currentIndex >= 0 ? currentIndex : 0);
    }
  });

  trigger.addEventListener('keydown', (event: KeyboardEvent) => {
    if (
      event.key === 'ArrowDown' ||
      event.key === 'Enter' ||
      event.key === ' '
    ) {
      const currentIndex = optionElements.findIndex(
        (el) => Number(el.dataset['version']) === shown
      );
      show(currentIndex >= 0 ? currentIndex : 0);
    } else if (event.key === 'ArrowUp') {
      show(optionElements.length - 1);
    } else {
      return;
    }
    event.preventDefault();
  });

  list.addEventListener('keydown', (event: KeyboardEvent) => {
    const index = optionElements.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    if (event.key === 'ArrowDown') move(index, 1);
    else if (event.key === 'ArrowUp') move(index, -1);
    else if (event.key === 'Home') move(index, -optionElements.length);
    else if (event.key === 'End') move(index, optionElements.length);
    else if (event.key === 'Escape' || event.key === 'Tab') close(true);
    else if (event.key === 'Enter' || event.key === ' ') {
      optionElements[index]?.click();
    } else {
      return;
    }
    event.preventDefault();
  });

  document.addEventListener('click', (event: Event) => {
    if (!wrap.contains(event.target as Node)) close();
  });

  wrap.append(trigger, list);
  return wrap;
}

/**
 * The taskbar, built as an accession label rather than app chrome.
 *
 * The relic ID is a catalog number and reads as one: monospace, letterspaced,
 * selectable. The filename is untrusted display text and goes in through
 * `textContent`.
 */
export function buildBar(
  view: ReadyView,
  relicId: string,
  options: BarOptions = {}
): HTMLElement {
  const bar = document.createElement('header');
  bar.className = 'bar';

  const mark = document.createElement('div');
  mark.className = 'mark';
  mark.textContent = WORDMARK;
  bar.appendChild(mark);

  const identity = document.createElement('div');
  identity.className = 'identity';

  const name = document.createElement('div');
  name.className = 'filename';
  name.textContent = view.filename.length > 0 ? view.filename : 'Untitled';
  name.title = view.filename;

  // The relic id and the version sit on one metadata line, because a version
  // number is artifact metadata of exactly the same kind as a catalog number.
  // They share the identity zone rather than joining the actions, and that is
  // load bearing: identity is the only flexible column on the row, so the
  // pressure a new element adds lands on an ellipsis that already exists
  // instead of pushing a control off the end.
  const meta = document.createElement('div');
  meta.className = 'identity-meta';

  const accession = document.createElement('div');
  accession.className = 'accession';
  accession.textContent = relicId;
  meta.appendChild(accession);

  const version = buildVersionControl(view, options);
  if (version !== undefined) meta.appendChild(version);

  identity.append(name, meta);
  bar.appendChild(identity);

  const actions = document.createElement('div');
  actions.className = 'actions';

  // A statement of fact, sitting with the actions rather than above the
  // content. It used to be a banner, and the risk it warned about, content
  // reaching the network, no longer exists.
  //
  // It collapses to its icon at narrow widths exactly like the buttons beside
  // it. Keeping this label while hiding theirs put a fact ahead of the
  // actions and pushed Report off the row, so the accessible name carries the
  // meaning once the text is gone.
  const marker = document.createElement('a');
  marker.className = 'action marker';
  marker.href = `${SERVICE_ORIGIN}/policy`;
  marker.rel = 'noopener noreferrer';
  // One string for the label and the accessible name, because WCAG 2.5.3
  // wants the name to contain the visible text and these had drifted: the
  // label read "Runs author code" while the name read "the author's code",
  // which is exactly the mismatch that breaks speech control.
  // Keyed on the route the viewer resolved, so the sentence describes what
  // this relic does rather than what the riskiest relic would.
  const markerLabel = markerLabelFor(view.route);
  marker.setAttribute('aria-label', markerLabel);
  marker.title = `${markerLabel}. What Relic knows.`;
  marker.appendChild(icon(ICONS.source));
  const markerText = document.createElement('span');
  markerText.textContent = markerLabel;
  marker.appendChild(markerText);
  actions.appendChild(marker);

  // Relics dashboard affordance in the taskbar. Opens in a new tab with noopener
  // because navigating the current tab risks landing back on a page with no key
  // in the URL (the viewer strips the fragment from the address bar upon load).
  const relicsLink = document.createElement('a');
  relicsLink.className = 'action action-relics';
  relicsLink.href = `${SERVICE_ORIGIN}/dashboard`;
  relicsLink.target = '_blank';
  relicsLink.rel = 'noopener';
  relicsLink.setAttribute('aria-label', 'Relics list');
  relicsLink.title =
    'Relics list. Open your saved and commented relics in a new tab.';
  relicsLink.appendChild(icon(ICONS.grid));
  const relicsText = document.createElement('span');
  relicsText.textContent = 'Relics';
  relicsLink.appendChild(relicsText);
  actions.appendChild(relicsLink);

  // Comments is the eleventh element on the row and the sixth action, and it
  // is the first addition whose absence costs nothing, which is why it is the
  // one that leaves at the floor. The thread overlays the relic, and a handle
  // on the stage remains after the button leaves, so a reader who loses the
  // control still reaches the same thread. `viewer.md` 6.5 carries the arithmetic.
  //
  // A button rather than a link to a document fragment. A `#thread` href
  // would write a fragment into the address bar of the one page in this
  // product whose entire security model is about what lives there, and the
  // key had already been stripped out of it.
  if (options.onComments !== undefined) {
    const comments = button('Comments', ICONS.comment, options.onComments);
    // Named so the stylesheet can drop this one control at the 320px floor
    // without reaching for a positional selector that the next addition to
    // the row would silently repoint.
    comments.classList.add('action-comments');
    if (options.commentCount !== undefined) {
      const count = document.createElement('span');
      // Survives the narrow collapse that hides the label beside it, because
      // the number is the part a reader cannot get anywhere else on the row.
      count.className = 'action-count';
      count.textContent = String(options.commentCount);
      comments.appendChild(count);
      comments.title = threadCountLabel(options.commentCount);
    } else {
      comments.title = 'Comments on this relic';
    }
    actions.appendChild(comments);
  }

  // Gated on there being history, not on the history being comparable. Those
  // were the same condition, which is why a download-only or oversize relic
  // offered no way into its own earlier versions while a notice on the page
  // said earlier versions existed.
  const history = versionHistoryAvailability(view);
  const canCompare = comparisonAvailability(view).kind === 'available';
  if (history.kind === 'available' && options.onCompare !== undefined) {
    // The label says what the control does on this relic. "Compare versions"
    // on something that cannot be compared is the kind of promise that reads
    // to a reader as their own failure when it does not happen.
    const closed = canCompare ? 'Compare versions' : 'Earlier versions';
    const exitLabel =
      view.version === view.currentVersion
        ? 'View current'
        : `View version ${view.version}`;
    const label = options.comparisonOpen === true ? exitLabel : closed;
    const compare = button(label, ICONS.compare, options.onCompare);
    compare.setAttribute(
      'aria-pressed',
      options.comparisonOpen === true ? 'true' : 'false'
    );
    compare.setAttribute(
      'aria-label',
      options.comparisonOpen === true
        ? `Return to viewing version ${view.version}`
        : canCompare
          ? `Compare version ${view.version} with its history`
          : 'Open an earlier version of this relic'
    );
    compare.title =
      options.comparisonOpen === true
        ? `Return to viewing version ${view.version}`
        : canCompare
          ? `Compare version ${view.version} with its history`
          : 'Open an earlier version of this relic';
    actions.appendChild(compare);
  }

  // The fragment was stripped from the address bar, so re-sharing has to come
  // from somewhere. This is that affordance, backed by the in-memory key.
  actions.appendChild(
    button('Copy link', ICONS.copy, () => {
      void navigator.clipboard.writeText(view.shareUrl).then(
        () => toast('Link copied. It contains the decryption key.'),
        () => toast('Could not copy. Copy the link from where you opened it.')
      );
    })
  );

  // Beside Copy link because it is the same errand done for somebody else:
  // the link still goes out in the reader's own mail, and Relic only learns
  // the addresses it should tell when a new version lands.
  const onShare = options.onShare;
  if (onShare !== undefined) {
    const share = button('Share', ICONS.share, () => onShare(share));
    share.classList.add('action-share');
    share.setAttribute('aria-haspopup', 'dialog');
    share.title = 'Share this relic with people by email';
    actions.appendChild(share);
  }

  actions.appendChild(
    button('Download', ICONS.download, () => downloadContent(view))
  );

  const report = document.createElement('a');
  report.className = 'action';
  report.href = `${SERVICE_ORIGIN}/abuse`;
  report.rel = 'noopener noreferrer';
  report.appendChild(icon(ICONS.flag));
  const reportText = document.createElement('span');
  reportText.textContent = 'Report';
  report.appendChild(reportText);
  actions.appendChild(report);

  bar.appendChild(actions);
  return bar;
}

function renderMarkdownView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc';

  const source = decodeText(view.content);

  const prose = buildProse(source);

  const raw = document.createElement('pre');
  raw.className = 'raw';
  raw.hidden = true;
  raw.textContent = source;

  let showingSource = false;
  const toggle = button('View source', ICONS.source, () => {
    showingSource = !showingSource;
    prose.hidden = showingSource;
    raw.hidden = !showingSource;
    toggle.replaceChildren();
    toggle.appendChild(icon(showingSource ? ICONS.rendered : ICONS.source));
    const label = document.createElement('span');
    label.textContent = showingSource ? 'View rendered' : 'View source';
    toggle.appendChild(label);
  });

  const toggleRow = document.createElement('div');
  toggleRow.className = 'toggle-row';
  toggleRow.appendChild(toggle);

  wrapper.append(toggleRow, prose, raw);
  return wrapper;
}

function renderCodeView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc';

  const source = decodeText(view.content);
  const table = buildCodeTable(source);
  wrapper.appendChild(table);
  return wrapper;
}

function renderImageView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-image';

  const blob = new Blob([view.content as unknown as BlobPart], {
    type: sniffImageType(view.content),
  });
  const url = URL.createObjectURL(blob);

  const image = document.createElement('img');
  image.className = 'relic-image';
  image.src = url;
  image.alt = view.filename;
  image.addEventListener('load', () => URL.revokeObjectURL(url));
  image.addEventListener('error', () => {
    URL.revokeObjectURL(url);
    wrapper.replaceChildren(
      notice('This image could not be decoded by the browser.')
    );
  });

  wrapper.appendChild(image);
  return wrapper;
}

/**
 * What a render frame is told to render. HTML crosses as markup, a component
 * crosses as JavaScript this origin transpiled without running.
 */
type RenderPayload =
  | { readonly type: 'relic:render'; readonly html: string }
  | { readonly type: 'relic:render-jsx'; readonly code: string };
type OpenWindow = (
  url: string,
  target: string,
  features: string
) => WindowProxy | null;

/** Open one frame-requested destination without an opener or referrer. */
export function openFrameExternalLink(
  message: FrameOpenLinkMessage,
  open: OpenWindow = (url, target, features) =>
    window.open(url, target, features)
): boolean {
  if (!isFrameOpenLinkMessage(message)) return false;
  open(message.href, '_blank', 'noopener,noreferrer');
  return true;
}

interface FrameHandle {
  readonly frame: HTMLIFrameElement;
  /**
   * Mark this frame's own rendered nodes, once the parent holds a diff.
   *
   * The marks carry a child-index path and a kind, and nothing else. That is
   * what makes a second message safe where a second render would not be: this
   * channel is structurally incapable of changing what the document says.
   */
  annotate(marks: readonly Mark[], anchors?: readonly Anchor[]): void;
  setScroll(position: ScrollPosition): void;
  revealChange(changeId: string, top: number): void;
}

/**
 * One render frame on the usercontent origin.
 *
 * The iframe carries `sandbox` without `allow-same-origin`, so the document
 * lands in an opaque origin: it cannot reach this origin, it cannot reach the
 * usercontent origin's storage, and it cannot read `parent.location`. The
 * payload is posted in; the key never is.
 *
 * Scripts and nothing else. Popups are removed by dropping the flag, not by
 * CSP: a popup opens a new top-level context this frame's policy does not
 * govern.
 * Reader-activated external links are the deliberate exception: the frame
 * sends a validated destination to the parent, which opens it without an
 * opener or referrer while leaving the sandbox unchanged.
 *
 * A comparison needs two renders of untrusted content, and it gets them from
 * two of these rather than by relaxing the frame's one-render guard. The
 * guard exists so nothing that can post here can swap the content after the
 * recipient has decided to trust what they are looking at, and a second
 * render is exactly that swap.
 */
function sandboxFrame(
  view: ReadyView,
  usercontentOrigin: string,
  payload: RenderPayload,
  onTree?: (tree: TreeNode) => void
): FrameHandle {
  const frame = document.createElement('iframe');
  frame.className = 'usercontent-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.src = `${usercontentOrigin}/sandbox.html`;
  frame.title = view.filename;

  // An opaque-origin frame has no origin to target, so '*' is the only option
  // the platform offers. It is safe here because the payload is the content
  // that frame is about to display anyway. The key is never in it.
  const post = (message: object): void => {
    frame.contentWindow?.postMessage(message, '*');
  };

  // Both paths, because the race runs in either direction: `load` can fire
  // before the frame's own script attaches its listener, and the frame's
  // ready message can arrive before `load`. The frame renders at most once,
  // so posting twice is harmless and losing the message is not.
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow) return;
    const type = (event.data as { type?: unknown } | null)?.type;
    if (type === 'relic:sandbox-ready') {
      post(payload);
      // Announced on this origin too, because marks are posted into the
      // frame and a post that arrives before the frame is listening is
      // simply lost. The thread paints once when the conversation loads,
      // and on a slow frame that paint landed nowhere: the relic showed no
      // marks at all until some later repaint happened to save it.
      frame.dispatchEvent(
        new CustomEvent('relic:frame-ready', { bubbles: true })
      );
      return;
    }
    // The captured tree is tag names, a fixed attribute allowlist, and text.
    // No markup crosses back to this origin, so nothing here has to be
    // sanitized before it is read: there is nothing to sanitize.
    if (onTree !== undefined && isTreeMessage(event.data)) {
      onTree(event.data.tree);
      return;
    }
    if (isFrameSelectionMessage(event.data)) {
      frame.dispatchEvent(
        new CustomEvent('relic:frame-selection', {
          detail: event.data,
          bubbles: true,
        })
      );
      return;
    }
    if (isFrameSelectionClearedMessage(event.data)) {
      frame.dispatchEvent(
        new CustomEvent('relic:frame-selection-cleared', { bubbles: true })
      );
      return;
    }
    if (isFrameMarkHoverMessage(event.data)) {
      frame.dispatchEvent(
        new CustomEvent('relic:frame-mark-hover', {
          detail: event.data,
          bubbles: true,
        })
      );
      return;
    }
    if (isFramePointMessage(event.data)) {
      frame.dispatchEvent(
        new CustomEvent('relic:frame-point', {
          detail: event.data,
          bubbles: true,
        })
      );
      return;
    }
    if (isFrameRegionMessage(event.data)) {
      frame.dispatchEvent(
        new CustomEvent('relic:frame-region', {
          detail: event.data,
          bubbles: true,
        })
      );
      return;
    }
    if (isFrameMarkClickMessage(event.data)) {
      frame.dispatchEvent(
        new CustomEvent('relic:frame-mark-click', {
          detail: event.data,
          bubbles: true,
        })
      );
      return;
    }
    if (isFrameOpenLinkMessage(event.data)) {
      openFrameExternalLink(event.data);
      return;
    }
    if (isFrameScrollMessage(event.data)) {
      frame.dispatchEvent(
        new CustomEvent('relic:frame-scroll', {
          detail: event.data,
          bubbles: true,
        })
      );
      return;
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('message', onMessage);
  }
  frame.addEventListener('load', () => post(payload));

  return {
    frame,
    annotate: (marks, anchors) =>
      post({ type: 'relic:annotate', marks, anchors }),
    setScroll: (position: ScrollPosition) =>
      post({ type: 'relic:set-scroll', ...position }),
    revealChange: (changeId: string, top: number) =>
      post({ type: 'relic:reveal-change', changeId, top }),
  };
}

/**
 * A component's payload, or nothing when it will not compile.
 *
 * The service origin must never execute relic content, and the transform
 * never does: it is a text-to-text rewrite whose output is posted as a
 * string. The frame turns that string back into running code by importing it
 * as a module. React is bundled into the inlined frame script because the
 * opaque origin cannot fetch same-origin assets or any remote dependency.
 */
function jsxPayload(view: ReadyView): RenderPayload | undefined {
  try {
    return {
      type: 'relic:render-jsx',
      code: transpileJsx(decodeText(view.content), view.filename),
    };
  } catch {
    return undefined;
  }
}

function payloadFor(view: ReadyView): RenderPayload | undefined {
  return view.route === 'sandboxed-jsx'
    ? jsxPayload(view)
    : { type: 'relic:render', html: decodeText(view.content) };
}

/** HTML renders on the usercontent origin and nowhere else. */
export function renderSandboxedHtml(
  view: ReadyView,
  usercontentOrigin: string
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-html';
  wrapper.appendChild(
    sandboxFrame(view, usercontentOrigin, {
      type: 'relic:render',
      html: decodeText(view.content),
    }).frame
  );
  return wrapper;
}

/**
 * A component renders on the usercontent origin and nowhere else, exactly
 * like HTML, but what crosses the frame boundary is different: the source is
 * transpiled here, on the service origin, into plain JavaScript first.
 */
export function renderSandboxedJsx(
  view: ReadyView,
  usercontentOrigin: string
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-jsx';

  const payload = jsxPayload(view);
  if (payload === undefined) {
    // Routing already established the bytes parse, so landing here means a
    // path the route decision could not see. Source view is the honest
    // fallback: it shows exactly what was published without running it.
    wrapper.appendChild(
      notice(
        'This file is named like a React component, but its contents do not ' +
          'compile as one. It is shown as source.'
      )
    );
    wrapper.appendChild(renderCodeView(view));
    return wrapper;
  }

  wrapper.appendChild(sandboxFrame(view, usercontentOrigin, payload).frame);
  return wrapper;
}

function renderDownloadView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-download';

  const card = document.createElement('div');
  card.className = 'card';

  const name = document.createElement('div');
  name.className = 'card-title';
  name.textContent = view.filename.length > 0 ? view.filename : 'Untitled';

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = `${view.declaredMimetype} · ${formatBytes(view.content.length)}`;

  const action = button('Download', ICONS.download, () =>
    downloadContent(view)
  );
  action.classList.add('primary');

  const note = document.createElement('p');
  note.className = 'card-note';
  note.textContent =
    'This kind of file is not displayed in the browser. It has already been ' +
    'decrypted here, so downloading it does not contact the service again.';

  card.append(name, meta, action, note);
  wrapper.appendChild(card);
  return wrapper;
}

export function renderPdfView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-pdf';

  const loading = document.createElement('div');
  loading.className = 'pdf-status-card';
  const headline = document.createElement('p');
  headline.className = 'pdf-status-title';
  headline.textContent = 'Loading PDF document';
  const detail = document.createElement('p');
  detail.className = 'thread-note';
  detail.textContent =
    'Loading the PDF renderer. It is loaded on demand so other documents do not pay for it.';
  loading.append(headline, detail);
  wrapper.appendChild(loading);

  void import('./pdf.ts')
    .then(({ mountPdf }) => {
      void mountPdf(wrapper, view.content, view.filename);
    })
    .catch(() => {
      loading.replaceChildren();
      const errTitle = document.createElement('p');
      errTitle.className = 'pdf-status-title';
      errTitle.textContent = 'Could not load PDF renderer';
      const errDetail = document.createElement('p');
      errDetail.className = 'thread-note';
      errDetail.textContent =
        'The viewer could not load the PDF rendering component. Check your connection and try again.';
      loading.append(errTitle, errDetail);
    });

  return wrapper;
}

export function renderMediaView(view: ReadyView): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'doc doc-media';

  const blob = new Blob([view.content as unknown as BlobPart], {
    type: view.declaredMimetype,
  });
  const blobUrl = URL.createObjectURL(blob);

  let revoked = false;
  const revoke = (): void => {
    if (!revoked) {
      revoked = true;
      URL.revokeObjectURL(blobUrl);
    }
  };

  wrapper.addEventListener('cleanup', revoke);

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('unload', revoke, { once: true });
  }

  if (
    typeof MutationObserver !== 'undefined' &&
    typeof document !== 'undefined' &&
    document.body
  ) {
    const observer = new MutationObserver(() => {
      if (document.contains && !document.contains(wrapper)) {
        observer.disconnect();
        revoke();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  const isAudio = isAudioMedia(view.declaredMimetype, view.filename);

  let player: HTMLVideoElement | HTMLAudioElement;
  if (isAudio) {
    const audio = document.createElement('audio');
    audio.className = 'media-player media-audio relic-media';
    audio.preload = 'metadata';
    audio.setAttribute('preload', 'metadata');
    audio.src = blobUrl;
    player = audio;
  } else {
    const video = document.createElement('video');
    video.className = 'media-player media-video relic-media';
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'metadata';
    video.setAttribute('preload', 'metadata');
    video.src = blobUrl;
    player = video;
  }

  const customPlayer = createMediaPlayer(player, {
    isAudio,
    filename: view.filename,
  });

  if (customPlayer.audioCard) {
    wrapper.appendChild(customPlayer.audioCard);
  }
  wrapper.appendChild(customPlayer.stage);
  wrapper.addEventListener('cleanup', () => customPlayer.destroy());
  const strip = document.createElement('div');
  strip.className = 'media-meta-strip';

  const info = document.createElement('div');
  info.className = 'media-meta-info';

  const name = document.createElement('span');
  name.className = 'media-meta-name';
  name.textContent = view.filename.length > 0 ? view.filename : 'Untitled';

  const details = document.createElement('span');
  details.className = 'media-meta-details';
  details.textContent = `${view.declaredMimetype} · ${formatBytes(view.content.length)}`;

  info.append(name, details);

  const downloadBtn = button('Download', ICONS.download, () =>
    downloadContent(view)
  );

  strip.append(info, downloadBtn);
  wrapper.appendChild(strip);

  return wrapper;
}

export function buildCurrentStage(
  view: ReadyView,
  usercontentOrigin: string
): HTMLElement {
  const main = document.createElement('main');
  main.className = `stage stage-${view.route}`;

  const availability = comparisonAvailability(view);
  if (availability.kind === 'unavailable') {
    main.appendChild(notice(availability.detail));
  }

  if (view.downgradeNotice !== undefined) {
    main.appendChild(notice(view.downgradeNotice));
  }

  switch (view.route) {
    case 'markdown':
      main.appendChild(renderMarkdownView(view));
      break;
    case 'code':
      main.appendChild(renderCodeView(view));
      break;
    case 'image':
      main.appendChild(renderImageView(view));
      break;
    case 'media':
      main.appendChild(renderMediaView(view));
      break;
    case 'otio': {
      const root = document.createElement('section');
      root.className = 'otio-view';
      root.textContent = 'Loading OTIO';
      main.appendChild(root);
      void import('./otio-view.ts')
        .then(({ mountOtioView }) =>
          mountOtioView(root, { content: view.content, revision: view.version })
        )
        .catch(() => {
          if (root.dataset['disposed'] === 'true') return;
          root.textContent = 'OTIO could not be loaded.';
          root.dataset['ready'] = 'error';
        });
      break;
    }
    case 'sandboxed-html':
      main.appendChild(renderSandboxedHtml(view, usercontentOrigin));
      break;
    case 'sandboxed-jsx':
      main.appendChild(renderSandboxedJsx(view, usercontentOrigin));
      break;
    case 'pdf':
      main.appendChild(renderPdfView(view));
      break;
    default:
      main.appendChild(renderDownloadView(view));
      break;
  }

  return main;
}

function lineNumbers(
  start: number | undefined,
  count: number,
  displayedLines: number
): string {
  let value = '';
  for (let index = 0; index < displayedLines; index++) {
    if (index > 0) value += '\n';
    if (start !== undefined && index < count) value += String(start + index);
  }
  return value;
}

function appendDiffText(body: HTMLElement, part: TextDiffPart): void {
  if (part.segments === undefined) {
    body.textContent = part.value;
    return;
  }

  for (const segment of part.segments) {
    const span = document.createElement('span');
    span.className =
      segment.kind === 'unchanged' ? '' : `diff-inline-${segment.kind}`;
    span.textContent = segment.text;
    body.appendChild(span);
  }
}

function noChanges(summary: string): HTMLElement {
  const empty = document.createElement('div');
  empty.className = 'diff-empty';
  empty.setAttribute('role', 'status');
  const headline = document.createElement('strong');
  headline.textContent = 'No changes';
  const detail = document.createElement('span');
  detail.textContent = summary;
  empty.append(headline, detail);
  return empty;
}

/**
 * The line comparison, now scoped to code.
 *
 * Markdown, HTML and JSX all used to arrive here and be compared as source
 * text. That is a text diff of markup, which is not a visual diff of anything
 * a reader looks at, so each of them now compares as it renders. Code stays,
 * because for code the source is what a reader sees.
 */
export function renderCodeComparison(
  current: ReadyView,
  historical: ReadyView
): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.className = 'diff-view diff-view-code';

  const result = createTextDiff(
    decodeText(historical.content),
    decodeText(current.content)
  );
  const summary = document.createElement('div');
  summary.className = 'diff-summary';
  const label = document.createElement('strong');
  label.textContent = 'Code comparison';
  const counts = document.createElement('span');
  counts.textContent = result.summary;
  summary.append(label, counts);
  wrapper.appendChild(summary);

  if (!result.changed) {
    wrapper.appendChild(noChanges(result.summary));
    return wrapper;
  }

  const changes = document.createElement('div');
  changes.className = 'diff-changes';
  changes.setAttribute(
    'aria-label',
    `Changes from version ${historical.version} to version ${current.version}`
  );

  for (const part of result.parts) {
    const row = document.createElement('div');
    row.className = `diff-part diff-part-${part.kind}`;
    row.setAttribute(
      'aria-label',
      part.kind === 'unchanged'
        ? 'Unchanged lines'
        : `${part.kind === 'added' ? 'Added' : 'Removed'} lines`
    );

    const displayedLines = Math.max(part.beforeLines, part.currentLines);
    const beforeNumbers = document.createElement('pre');
    beforeNumbers.className = 'diff-gutter diff-gutter-before';
    beforeNumbers.setAttribute('aria-hidden', 'true');
    beforeNumbers.textContent = lineNumbers(
      part.beforeStart,
      part.beforeLines,
      displayedLines
    );

    const currentNumbers = document.createElement('pre');
    currentNumbers.className = 'diff-gutter diff-gutter-current';
    currentNumbers.setAttribute('aria-hidden', 'true');
    currentNumbers.textContent = lineNumbers(
      part.currentStart,
      part.currentLines,
      displayedLines
    );

    const body = document.createElement('pre');
    body.className = 'diff-body';
    appendDiffText(body, part);

    row.append(beforeNumbers, currentNumbers, body);
    changes.appendChild(row);
  }

  wrapper.appendChild(changes);
  return wrapper;
}

/** What a reader sees changed, in rendered terms rather than source terms. */
function renderChangeList(
  changes: readonly RenderedChange[],
  onJump?: (index: number) => void
): HTMLElement {
  const list = document.createElement('ul');
  list.className = 'diff-change-list';

  for (const change of changes) {
    const item = document.createElement('li');
    item.className = `diff-change diff-change-${change.kind}`;
    // A row that names a change and cannot take you to it is a description
    // of a search the reader still has to run.
    if (onJump !== undefined && change.jumpIndex !== undefined) {
      const index = change.jumpIndex;
      item.classList.add('is-linked');
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.addEventListener('click', () => onJump(index));
      item.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onJump(index);
      });
    }

    const kind = document.createElement('span');
    kind.className = 'diff-change-kind';
    kind.textContent = change.kind;

    const what = document.createElement('span');
    what.className = 'diff-change-what';
    what.textContent = change.label;

    // Rendered text from the compared versions, and it reaches the DOM as a
    // text node. Nothing parses it, so content that is secretly markup shows
    // as its own source and does nothing, which is the correct outcome on the
    // origin that holds the key.
    const detail = document.createElement('span');
    detail.className = 'diff-change-detail';
    if (change.kind === 'changed') {
      const before = document.createElement('del');
      before.textContent = change.before;
      const after = document.createElement('ins');
      after.textContent = change.after;
      detail.append(before, after);
    } else {
      detail.textContent =
        change.kind === 'added' ? change.after : change.before;
    }

    item.append(kind, what, detail);
    list.appendChild(item);
  }

  return list;
}

/** Where a jumped-to change is placed in the pane, in CSS pixels. */
export const CHANGE_JUMP_TOP = 120;

/**
 * Which pane holds a change.
 *
 * Its own function because getting it wrong is silent: a removal exists only
 * in the older version, and asking the newer pane for it finds nothing,
 * changes nothing, and reports success. A named seam is testable; a ternary
 * inside a callback was not.
 */
export function paneForJump<T>(jump: ChangeJump, before: T, after: T): T {
  return jump.side === 'before' ? before : after;
}

export interface ChangeNav {
  readonly element: HTMLElement;
  /** Handed the diff's stops once the trees arrive. */
  setJumps(jumps: readonly ChangeJump[]): void;
  /** Move by one stop, wrapping at each end. Returns the new position. */
  step(delta: 1 | -1): number | undefined;
  /** Go to one stop by index, for a press on a row in the change list. */
  goTo(index: number): void;
}

/**
 * Previous, next, and where you are.
 *
 * The position is stated rather than implied, because "next" with no count
 * leaves a reader unable to tell a document with two changes from one with
 * forty, and unable to tell when they have seen them all. Wrapping is
 * deliberate for the same reason the count is: the reader can keep pressing
 * and will not be silently stuck at an end.
 */
export function buildChangeNav(deps: {
  reveal: (jump: ChangeJump, top: number) => boolean;
}): ChangeNav {
  const element = document.createElement('div');
  element.className = 'compare-nav';
  let jumps: readonly ChangeJump[] = [];
  let at = -1;
  /**
   * Whether the comparison has been computed yet.
   *
   * Separate from an empty list, because "there are no changes" and "nobody
   * has looked yet" are different claims and the second one was being made
   * as the first: a comparison said No changes for the seconds before its
   * own diff landed, and for the whole of a comparison whose frames never
   * reported at all.
   */
  let counted = false;

  const position = document.createElement('span');
  position.className = 'compare-nav-position';
  // Polite: a reader moving through changes with the keyboard is told where
  // they landed, and never interrupted mid sentence to hear it.
  position.setAttribute('aria-live', 'polite');

  const show = (): void => {
    position.textContent = !counted
      ? 'Comparing'
      : jumps.length === 0
        ? 'No changes'
        : at < 0
          ? `${jumps.length} ${jumps.length === 1 ? 'change' : 'changes'}`
          : `Change ${at + 1} of ${jumps.length}`;
    for (const control of [previous, next]) {
      control.disabled = jumps.length === 0;
    }
  };

  const goTo = (index: number): void => {
    if (jumps.length === 0) return;
    const wrapped = ((index % jumps.length) + jumps.length) % jumps.length;
    const target = jumps[wrapped];
    if (target === undefined) return;
    at = wrapped;
    deps.reveal(target, CHANGE_JUMP_TOP);
    show();
  };

  const step = (delta: 1 | -1): number | undefined => {
    if (jumps.length === 0) return undefined;
    // From nothing, forward means the first and backward means the last,
    // which is what a reader who has not started yet means by either.
    goTo(at < 0 ? (delta === 1 ? 0 : jumps.length - 1) : at + delta);
    return at;
  };

  const previous = button('Previous change', ICONS.chevron, () => step(-1));
  previous.classList.add('compare-nav-previous');
  const next = button('Next change', ICONS.chevron, () => step(1));
  next.classList.add('compare-nav-next');
  element.append(previous, position, next);
  show();

  return {
    element,
    setJumps: (value) => {
      jumps = value;
      at = -1;
      counted = true;
      show();
    },
    step,
    goTo,
  };
}

/** One side of a rendered comparison, and how to mark it once a diff exists. */
interface ComparisonPane {
  readonly element: HTMLElement;
  /** Resolves with the pane's captured tree, or never when it cannot render. */
  readonly tree: Promise<TreeNode>;
  annotate(marks: readonly Mark[], anchors: readonly Anchor[]): void;
  readonly setScroll?: (position: ScrollPosition) => void;
  /**
   * Put one change at `top` inside this pane, and say whether it landed.
   *
   * The pane does it rather than the caller, because for a framed version
   * the node is in another origin and only the frame can measure or move
   * it. The other pane is not moved here: the two are already synced, and
   * moving both would fight that.
   */
  readonly revealChange?: (changeId: string, top: number) => boolean;
}

/** Paired changed node nearest the top of one same-origin pane. */
function paneScrollLandmark(pane: HTMLElement) {
  if (typeof pane.getBoundingClientRect !== 'function') return undefined;
  return nearestScrollLandmark(pane, pane.getBoundingClientRect().top);
}

/** Align one same-origin pane on the exact paired node, when it has it. */
function applyPaneScrollLandmark(
  pane: HTMLElement,
  landmark: NonNullable<ReturnType<typeof paneScrollLandmark>>
): boolean {
  if (typeof pane.getBoundingClientRect !== 'function') return false;
  const delta = landmarkScrollDelta(
    pane,
    landmark,
    pane.getBoundingClientRect().top
  );
  if (delta === null) return false;
  const travel = pane.scrollHeight - pane.clientHeight;
  if (!(travel > 0)) return true;
  const exactTarget = pane.scrollTop + delta;
  // Near either end the requested viewport top can be physically impossible.
  // Returning false chooses the proportional fallback, which preserves the
  // invariant that both documents still meet at their start and end.
  if (exactTarget < 0 || exactTarget > travel) return false;
  const target = Math.round(exactTarget);
  if (Math.abs(pane.scrollTop - target) > 1) pane.scrollTop = target;
  return true;
}

/** How long to wait for a frame that renders nothing at all. */
const TREE_TIMEOUT_MS = 6000;

/**
 * A markdown pane, rendered here rather than in a frame.
 *
 * Markdown renders on the service origin because `renderMarkdown` escapes
 * before it emits markup and its element and attribute set is fixed by the
 * viewer, so nothing in the source can become an element. That means both
 * versions are ordinary DOM on this origin, and the comparison needs no frame
 * and no protocol.
 */
function markdownPane(view: ReadyView): ComparisonPane {
  const prose = document.createElement('article');
  prose.className = 'prose';
  prose.innerHTML = renderMarkdown(decodeText(view.content));
  return {
    element: prose,
    tree: Promise.resolve(captureTree(prose)),
    annotate: (marks, anchors) => {
      applyMarks(prose, marks);
      // Second, because the first call clears authored ids before painting
      // its own and would take these with it.
      applyAnchors(prose, anchors);
    },
    revealChange: (changeId, top) => revealChangeIn(prose, changeId, top),
  };
}

/**
 * The nearest box that actually scrolls this node.
 *
 * Asked of the layout rather than assumed, because the element a pane hands
 * over is its content and not the box around it: a markdown pane is an
 * article inside the scrolling column. Writing `scrollTop` on the article
 * lit the right paragraph and moved nothing, which is the shape of defect
 * only a browser shows.
 */
function scrollerFor(node: HTMLElement): HTMLElement | undefined {
  let walk: HTMLElement | null = node.parentElement ?? null;
  while (walk !== null) {
    if (walk.scrollHeight - walk.clientHeight > 1) return walk;
    walk = walk.parentElement ?? null;
  }
  return undefined;
}

/**
 * Scroll a same-origin pane so one change sits at `top`.
 *
 * Never the window: the comparison stage clips and each side scrolls
 * independently, which is the whole reason the two are synced rather than
 * sharing one scrollbar.
 */
export function revealChangeIn(
  pane: HTMLElement,
  changeId: string,
  top: number
): boolean {
  // Cleared before the lookup, and on every pane the stop is offered to,
  // because a light left standing in the other pane means two nodes both
  // claim to be the one the reader was sent to.
  for (const lit of pane.querySelectorAll('.is-current-change')) {
    lit.classList.remove('is-current-change');
  }
  const node = pane.querySelector<HTMLElement>(
    `[data-relic-change-id="${changeId}"]`
  );
  if (node === null) return false;
  // The element a pane hands over is its content, not the box that scrolls
  // it: a markdown pane is an article inside a scrolling column. Writing
  // `scrollTop` on the article lit the right paragraph and moved nothing,
  // which is the shape of defect only a browser shows.
  const scroller = scrollerFor(node) ?? pane;
  if (
    typeof node.getBoundingClientRect !== 'function' ||
    typeof scroller.getBoundingClientRect !== 'function'
  ) {
    return false;
  }
  const offset =
    node.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const travel = scroller.scrollHeight - scroller.clientHeight;
  const target = Math.max(
    0,
    Math.min(scroller.scrollTop + offset - top, travel)
  );
  scroller.scrollTop = Math.round(target);
  // Lit as well as scrolled to. A reader taken to the eighth change in a
  // document with forty marked nodes cannot tell which one they were sent
  // to from position alone.
  node.classList.add('is-current-change');
  return true;
}

/**
 * A pane whose content is a page or a component, so it renders in its own
 * network-denied frame.
 *
 * Two frames rather than two renders in one: each keeps the single-render
 * guarantee it already had. The parent cannot read a frame's DOM, because the
 * render frame is an opaque origin, so the frame reports its own rendered
 * structure and the parent posts back marks that carry no content.
 */
function framePane(view: ReadyView, usercontentOrigin: string): ComparisonPane {
  const payload = payloadFor(view);
  if (payload === undefined) {
    return {
      element: notice(
        `Version ${view.version} is named like a React component and does ` +
          'not compile as one, so it cannot be rendered for comparison.'
      ),
      tree: new Promise<TreeNode>(() => {}),
      annotate: () => {},
    };
  }

  let settle: ((tree: TreeNode) => void) | undefined;
  const tree = new Promise<TreeNode>((resolve) => {
    settle = resolve;
  });
  const handle = sandboxFrame(view, usercontentOrigin, payload, (reported) =>
    settle?.(reported)
  );
  return {
    element: handle.frame,
    tree,
    annotate: handle.annotate,
    setScroll: handle.setScroll,
    revealChange: (changeId, top) => {
      handle.revealChange(changeId, top);
      // Posted rather than answered: the frame is the only side that knows
      // whether it has the node, and a message cannot return. The caller
      // treats a framed pane as able to try, which is true.
      return true;
    },
  };
}

/**
 * The visual comparison for every class that has a rendered form.
 *
 * Two panes, each showing one version as it actually renders, stacked under a
 * swipe control so the reader can wipe between them, or laid side by side.
 * On top of that, each pane's own changed nodes are outlined where they sit,
 * so a change is visible without hunting for it. Markdown defaults to side by
 * side because prose is read, and a page or a component defaults to the swipe
 * because what matters there is whether the pixels moved.
 */
export function renderRenderedComparison(
  current: ReadyView,
  historical: ReadyView,
  mode: 'markdown' | 'rendered',
  usercontentOrigin: string,
  onChanges?: (
    changes: readonly RenderedChange[],
    summary: string,
    /**
     * How to take the reader to one of those changes.
     *
     * Handed out because the list is rendered by whoever owns the sidebar,
     * and a row that names a change without going to it leaves the reader
     * running the search themselves.
     */
    onJump?: (index: number) => void
  ) => void
): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.className = `diff-view diff-view-${mode}`;

  const summary = document.createElement('div');
  summary.className = 'diff-summary';
  const label = document.createElement('strong');
  label.textContent = 'Rendered comparison';
  const counts = document.createElement('span');
  counts.textContent = 'Rendering both versions.';
  summary.append(label, counts);
  wrapper.appendChild(summary);

  const before =
    mode === 'markdown'
      ? markdownPane(historical)
      : framePane(historical, usercontentOrigin);
  const after =
    mode === 'markdown'
      ? markdownPane(current)
      : framePane(current, usercontentOrigin);

  const stage = document.createElement('div');
  stage.className = 'compare-stage';
  // Side by side, whatever the class. These are documents people read, and
  // reading two of them at once is what the pane pair is for; the swipe
  // answers "did the pixels move", which is a narrower question and one
  // press away. A remembered choice beats this default.
  stage.dataset['layout'] = readCompareLayout() ?? 'split';
  stage.style.setProperty('--split', '50%');

  const beforePane = document.createElement('div');
  beforePane.className = 'compare-pane compare-pane-before';
  beforePane.appendChild(before.element);

  const afterPane = document.createElement('div');
  afterPane.className = 'compare-pane compare-pane-current';
  afterPane.appendChild(after.element);

  const beforeLabel = document.createElement('span');
  beforeLabel.className = 'compare-label compare-label-before';
  beforeLabel.textContent =
    historical.version === historical.currentVersion
      ? `Version ${historical.version}, current`
      : `Version ${historical.version}`;
  const afterLabel = document.createElement('span');
  afterLabel.className = 'compare-label compare-label-current';
  afterLabel.textContent =
    current.version === current.currentVersion
      ? `Version ${current.version}, current`
      : `Version ${current.version}`;
  const divider = document.createElement('span');
  divider.className = 'compare-divider';
  divider.setAttribute('aria-hidden', 'true');

  stage.append(beforePane, afterPane, beforeLabel, afterLabel, divider);

  // The listeners live on the panes, so they go when the stage does.
  if (mode === 'markdown') {
    syncScrollers([beforePane, afterPane], undefined, {
      read: paneScrollLandmark,
      apply: applyPaneScrollLandmark,
    });
  } else if (before.setScroll !== undefined && after.setScroll !== undefined) {
    syncFrameScrollers([
      {
        setScrollPosition: before.setScroll,
        addEventListener: (type, listener) =>
          before.element.addEventListener(type, listener),
        removeEventListener: (type, listener) =>
          before.element.removeEventListener(type, listener),
      },
      {
        setScrollPosition: after.setScroll,
        addEventListener: (type, listener) =>
          after.element.addEventListener(type, listener),
        removeEventListener: (type, listener) =>
          after.element.removeEventListener(type, listener),
      },
    ]);
  }

  const controls = document.createElement('div');
  controls.className = 'compare-controls';

  const swipeControl = document.createElement('label');
  swipeControl.className = 'compare-swipe';
  const swipeText = document.createElement('span');
  const swipeLabel = `Reveal version ${current.version} over version ${historical.version}`;
  swipeText.textContent = swipeLabel;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.value = '50';
  slider.setAttribute('aria-label', swipeLabel);
  slider.addEventListener('input', () => {
    stage.style.setProperty('--split', `${slider.value}%`);
  });
  swipeControl.append(swipeText, slider);

  const layout = document.createElement('div');
  layout.className = 'compare-layout';
  const buttons: HTMLButtonElement[] = [];
  const setLayout = (next: 'swipe' | 'split'): void => {
    stage.dataset['layout'] = next;
    for (const candidate of buttons) {
      const active = candidate.dataset['layout'] === next;
      candidate.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    swipeControl.hidden = next !== 'swipe';
  };
  for (const [value, text, path] of [
    ['swipe', 'Swipe', ICONS.swipe],
    ['split', 'Side by side', ICONS.columns],
  ] as const) {
    const control = button(text, path, () => {
      setLayout(value);
      // Written only for a press, never for the initial paint, so opening a
      // comparison cannot quietly overwrite what the reader last chose.
      writeCompareLayout(value);
    });
    control.dataset['layout'] = value;
    buttons.push(control);
    layout.appendChild(control);
  }
  setLayout(stage.dataset['layout'] === 'split' ? 'split' : 'swipe');

  // Moving through the changes, rather than hunting for the outlines.
  // A comparison with forty marked nodes is a search problem without this,
  // and the reader is the one who has to solve it.
  const nav = buildChangeNav({
    reveal: (jumpTarget, top) => {
      // Offered to both. The pane that does not hold this stop clears its
      // own light and does nothing else, which is how the two stop
      // disagreeing about where the reader is.
      paneForJump(jumpTarget, after, before).revealChange?.(
        jumpTarget.changeId,
        top
      );
      const pane = paneForJump(jumpTarget, before, after);
      return pane.revealChange?.(jumpTarget.changeId, top) ?? false;
    },
  });

  controls.append(layout, nav.element, swipeControl);

  const result = document.createElement('div');
  result.className = 'diff-rendered-result';

  wrapper.append(controls, stage, result);

  // The structural comparison is the annotation, and the two live renders are
  // the evidence. So a frame that never reports a tree costs the outlines and
  // the change list, and leaves the reader everything a swipe can show.
  const timeout = new Promise<undefined>((resolve) => {
    setTimeout(() => resolve(undefined), TREE_TIMEOUT_MS);
  });
  void Promise.race([Promise.all([before.tree, after.tree]), timeout]).then(
    (trees) => {
      if (typeof document === 'undefined') return;
      if (trees === undefined) {
        counts.textContent =
          'Both versions are shown. Relik could not read their rendered ' +
          'structure, so changes are not outlined.';
        return;
      }
      const [beforeTree, afterTree] = trees;
      const diff: TreeDiff = diffTrees(beforeTree, afterTree);
      counts.textContent = diff.summary;
      before.annotate(diff.removedMarks, diff.beforeAnchors);
      after.annotate(diff.addedMarks, diff.afterAnchors);
      nav.setJumps(diff.jumps);
      if (onChanges !== undefined) {
        onChanges(diff.changes, diff.summary, nav.goTo);
      }
      if (!diff.changed) {
        if (onChanges === undefined) {
          result.replaceChildren(noChanges(diff.summary));
        }
        return;
      }
      if (diff.changes.length > 0 && onChanges === undefined) {
        result.replaceChildren(renderChangeList(diff.changes, nav.goTo));
      }
    }
  );

  return wrapper;
}

async function loadImage(
  image: HTMLImageElement,
  url: string
): Promise<HTMLImageElement> {
  image.src = url;
  try {
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function renderImageComparison(
  current: ReadyView,
  historical: ReadyView
): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.className = 'diff-view diff-view-image';

  const heading = document.createElement('div');
  heading.className = 'diff-summary';
  const label = document.createElement('strong');
  label.textContent = 'Image comparison';
  const status = document.createElement('span');
  status.textContent = 'Loading image dimensions.';
  heading.append(label, status);
  wrapper.appendChild(heading);

  if (bytesEqual(historical.content, current.content)) {
    status.textContent = 'No changed pixels or metadata bytes.';
    wrapper.appendChild(
      noChanges('No changes. These versions have identical content.')
    );
    return wrapper;
  }

  const canvas = document.createElement('div');
  canvas.className = 'image-diff-canvas';
  canvas.style.setProperty('--split', '50%');

  const before = document.createElement('img');
  before.className = 'image-diff-before';
  before.alt = `Version ${historical.version}`;

  const after = document.createElement('img');
  after.className = 'image-diff-current';
  after.alt = `Version ${current.version}`;

  const historicalUrl = URL.createObjectURL(
    new Blob([historical.content as unknown as BlobPart], {
      type: sniffImageType(historical.content),
    })
  );
  const currentUrl = URL.createObjectURL(
    new Blob([current.content as unknown as BlobPart], {
      type: sniffImageType(current.content),
    })
  );

  const beforeLabel = document.createElement('span');
  beforeLabel.className = 'image-diff-label image-diff-label-before';
  beforeLabel.textContent =
    historical.version === historical.currentVersion
      ? `Version ${historical.version}, current`
      : `Version ${historical.version}`;
  const currentLabel = document.createElement('span');
  currentLabel.className = 'image-diff-label image-diff-label-current';
  currentLabel.textContent =
    current.version === current.currentVersion
      ? `Version ${current.version}, current`
      : `Version ${current.version}`;
  const divider = document.createElement('span');
  divider.className = 'image-diff-divider';
  divider.setAttribute('aria-hidden', 'true');
  canvas.append(before, after, beforeLabel, currentLabel, divider);

  const control = document.createElement('label');
  control.className = 'image-diff-control';
  const controlText = document.createElement('span');
  controlText.textContent = `Reveal version ${current.version} over version ${historical.version}`;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.value = '50';
  slider.setAttribute(
    'aria-label',
    `Reveal version ${current.version} over version ${historical.version}`
  );
  slider.addEventListener('input', () => {
    canvas.style.setProperty('--split', `${slider.value}%`);
  });
  control.append(controlText, slider);

  wrapper.append(canvas, control);

  void Promise.all([
    loadImage(before, historicalUrl),
    loadImage(after, currentUrl),
  ]).then(
    ([loadedBefore, loadedCurrent]) => {
      const result = createImageDiff(
        historical.content,
        current.content,
        {
          width: loadedBefore.naturalWidth,
          height: loadedBefore.naturalHeight,
        },
        {
          width: loadedCurrent.naturalWidth,
          height: loadedCurrent.naturalHeight,
        }
      );
      status.textContent = result.summary;
    },
    () => {
      wrapper.replaceChildren(
        notice(
          'One of these image versions could not be decoded by the browser.'
        )
      );
    }
  );

  return wrapper;
}

export function comparisonCopy(
  leftVersion: number,
  rightVersion: number,
  currentVersion: number,
  comparable = true
): { readonly headline: string; readonly detail: string } {
  const headline = comparable
    ? `Comparing version ${leftVersion} with version ${rightVersion}`
    : `Version ${leftVersion} of ${rightVersion}`;

  let detail: string;
  if (leftVersion === rightVersion) {
    detail = 'Choose two different versions to see what changed between them.';
  } else if (rightVersion === currentVersion) {
    detail =
      `Version ${rightVersion} is current. Version ${leftVersion} is retained history ` +
      'and may contain content removed from the current artifact.';
  } else if (leftVersion === currentVersion) {
    detail =
      `Version ${leftVersion} is current. Version ${rightVersion} is retained history ` +
      'and may contain content removed from the current artifact.';
  } else {
    detail =
      `Version ${currentVersion} is current. Versions ${leftVersion} and ${rightVersion} ` +
      'are retained history and may contain content removed from the current artifact.';
  }

  return { headline, detail };
}

export interface SidePickerHandle {
  readonly wrap: HTMLElement;
  readonly trigger: HTMLButtonElement;
  readonly list: HTMLElement;
  readonly options: HTMLElement[];
  setVersion(version: number): void;
}

export function buildSidePicker(
  side: 'left' | 'right',
  labelText: string,
  initialVersion: number,
  currentVersion: number,
  onSelect: (version: number) => void
): SidePickerHandle {
  let selected = initialVersion;

  const wrap = document.createElement('div');
  wrap.className = `compare-picker-side compare-picker-${side}`;
  wrap.dataset['side'] = side;

  const caption = document.createElement('span');
  caption.className = 'compare-picker-caption';
  caption.textContent = labelText;
  wrap.appendChild(caption);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'version-label version-trigger compare-picker-trigger';
  trigger.dataset['side'] = side;
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');

  const triggerValue = document.createElement('span');
  triggerValue.className = 'compare-picker-value';

  const updateTriggerLabel = (): void => {
    const isCurrent = selected === currentVersion;
    const text = isCurrent
      ? `Version ${selected}, current`
      : `Version ${selected}`;
    triggerValue.textContent = text;
    trigger.setAttribute('aria-label', `${labelText} version: ${text}`);
  };
  updateTriggerLabel();

  trigger.append(triggerValue, icon(ICONS.chevron));
  wrap.appendChild(trigger);

  const list = document.createElement('div');
  list.className = 'version-list compare-picker-list';
  list.dataset['side'] = side;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', `${labelText} version to compare`);
  list.hidden = true;

  const optionElements: HTMLElement[] = [];
  for (let v = currentVersion; v >= 1; v--) {
    const option = document.createElement('div');
    option.className = 'version-option compare-picker-option';
    option.dataset['version'] = String(v);
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', v === selected ? 'true' : 'false');
    option.tabIndex = -1;
    option.textContent =
      v === currentVersion ? `Version ${v}, current` : `Version ${v}`;

    option.addEventListener('click', () => {
      close();
      if (v !== selected) {
        selected = v;
        updateTriggerLabel();
        updateOptionsSelected();
        onSelect(v);
      }
    });

    list.appendChild(option);
    optionElements.push(option);
  }

  const updateOptionsSelected = (): void => {
    for (const opt of optionElements) {
      const v = Number(opt.dataset['version']);
      opt.setAttribute('aria-selected', v === selected ? 'true' : 'false');
    }
  };

  let open = false;
  function close(focusTrigger = false): void {
    if (!open) return;
    open = false;
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) trigger.focus();
  }

  function showList(index: number): void {
    open = true;
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    optionElements[index]?.focus();
  }

  const move = (from: number, delta: number): void => {
    const last = optionElements.length - 1;
    const next = Math.min(last, Math.max(0, from + delta));
    optionElements[next]?.focus();
  };

  trigger.addEventListener('click', () => {
    if (open) {
      close();
    } else {
      const currentIndex = optionElements.findIndex(
        (el) => Number(el.dataset['version']) === selected
      );
      showList(currentIndex >= 0 ? currentIndex : 0);
    }
  });

  trigger.addEventListener('keydown', (event: KeyboardEvent) => {
    if (
      event.key === 'ArrowDown' ||
      event.key === 'Enter' ||
      event.key === ' '
    ) {
      const currentIndex = optionElements.findIndex(
        (el) => Number(el.dataset['version']) === selected
      );
      showList(currentIndex >= 0 ? currentIndex : 0);
    } else if (event.key === 'ArrowUp') {
      showList(optionElements.length - 1);
    } else {
      return;
    }
    event.preventDefault();
  });

  list.addEventListener('keydown', (event: KeyboardEvent) => {
    const index = optionElements.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    if (event.key === 'ArrowDown') move(index, 1);
    else if (event.key === 'ArrowUp') move(index, -1);
    else if (event.key === 'Home') move(index, -optionElements.length);
    else if (event.key === 'End') move(index, optionElements.length);
    else if (event.key === 'Escape' || event.key === 'Tab') close(true);
    else if (event.key === 'Enter' || event.key === ' ') {
      optionElements[index]?.click();
    } else {
      return;
    }
    event.preventDefault();
  });

  document.addEventListener('click', (event: Event) => {
    if (!wrap.contains(event.target as Node)) close();
  });

  wrap.appendChild(list);

  return {
    wrap,
    trigger,
    list,
    options: optionElements,
    setVersion(version: number): void {
      selected = version;
      updateTriggerLabel();
      updateOptionsSelected();
    },
  };
}

export interface ComparePickerOptions {
  readonly leftVersion: number;
  readonly rightVersion: number;
  readonly currentVersion: number;
  readonly onSelectLeft: (version: number) => void;
  readonly onSelectRight: (version: number) => void;
}

export interface ComparePickerHandle {
  readonly element: HTMLElement;
  readonly left: SidePickerHandle;
  readonly right: SidePickerHandle;
  setVersions(left: number, right: number): void;
}

export function buildComparePicker(
  options: ComparePickerOptions
): ComparePickerHandle {
  const container = document.createElement('div');
  container.className = 'compare-picker';
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', 'Compare versions');

  const left = buildSidePicker(
    'left',
    'Left',
    options.leftVersion,
    options.currentVersion,
    options.onSelectLeft
  );

  const separator = document.createElement('span');
  separator.className = 'compare-picker-separator';
  separator.setAttribute('aria-hidden', 'true');
  separator.textContent = 'to';

  const right = buildSidePicker(
    'right',
    'Right',
    options.rightVersion,
    options.currentVersion,
    options.onSelectRight
  );

  container.append(left.wrap, separator, right.wrap);

  return {
    element: container,
    left,
    right,
    setVersions(newLeft: number, newRight: number): void {
      left.setVersion(newLeft);
      right.setVersion(newRight);
    },
  };
}

export interface ComparisonScaffold {
  readonly main: HTMLElement;
  readonly result: HTMLElement;
  readonly headline: HTMLElement;
  readonly historyNote: HTMLElement;
  readonly picker: ComparePickerHandle;
}

/**
 * The comparison shell, carrying the version pickers in the toolbar.
 */
export function buildComparisonScaffold(
  currentVersion: number,
  initialLeft: number,
  initialRight: number,
  onPick: (left: number, right: number) => void
): ComparisonScaffold {
  const main = document.createElement('main');
  main.className = 'stage stage-diff';

  const shell = document.createElement('div');
  shell.className = 'diff-shell';

  const toolbar = document.createElement('header');
  toolbar.className = 'diff-toolbar';

  const copy = document.createElement('div');
  copy.className = 'diff-heading';
  const eyebrow = document.createElement('div');
  eyebrow.className = 'diff-eyebrow';
  eyebrow.textContent = 'Version history';
  const headline = document.createElement('h1');
  headline.tabIndex = -1;
  const historyNote = document.createElement('p');
  historyNote.className = 'diff-history-note';
  copy.append(eyebrow, headline, historyNote);

  let left = initialLeft;
  let right = initialRight;

  const picker = buildComparePicker({
    leftVersion: left,
    rightVersion: right,
    currentVersion,
    onSelectLeft: (selectedLeft) => {
      left = selectedLeft;
      onPick(left, right);
    },
    onSelectRight: (selectedRight) => {
      right = selectedRight;
      onPick(left, right);
    },
  });

  toolbar.append(copy, picker.element);

  const result = document.createElement('div');
  result.className = 'diff-result';
  result.setAttribute('aria-live', 'polite');

  shell.append(toolbar, result);
  main.appendChild(shell);

  return { main, result, headline, historyNote, picker };
}

/**
 * Why these two versions cannot be shown side by side, in a reader's terms.
 *
 * One sentence per cause, and each names the version it is about. "Relik
 * cannot compare them" alone leaves a reader guessing whether they did
 * something wrong, whether the relic is broken, and whether the version they
 * asked for arrived.
 */
export function uncomparableReason(
  current: ReadyView,
  historical: ReadyView,
  selectedVersion: number
): string {
  if (diffModeForRoute(historical.route) === undefined) {
    return (
      `Version ${selectedVersion} is download-only, so it cannot be shown ` +
      `beside version ${current.version}. It is open here on its own.`
    );
  }
  if (diffModeForRoute(current.route) === undefined) {
    return (
      `Version ${current.version} is download-only, so it cannot be shown ` +
      `beside version ${selectedVersion}. Version ${selectedVersion} is ` +
      'open here on its own.'
    );
  }
  return (
    `Version ${selectedVersion} and version ${current.version} display ` +
    `differently, so they cannot be shown side by side. Version ` +
    `${selectedVersion} is open here on its own.`
  );
}

/**
 * One version, rendered on its own, with a note saying why it is alone.
 *
 * Reuses `buildCurrentStage`, which already renders any `ReadyView` through
 * the same routing the current version gets. That matters more than saving
 * code: a historical version shown through a second, simpler path would
 * sanitize differently from the current one, and the sandbox boundary is not
 * somewhere to keep two implementations.
 */
export function renderSingleVersion(
  view: ReadyView,
  usercontentOrigin: string,
  reason?: string
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'diff-single';
  if (reason !== undefined && reason.length > 0) {
    wrap.appendChild(notice(reason));
  }

  const label = document.createElement('p');
  label.className = 'diff-single-label';
  label.textContent = `Version ${view.version}: ${view.filename}`;
  wrap.appendChild(label);

  wrap.appendChild(buildCurrentStage(view, usercontentOrigin));
  return wrap;
}

/**
 * How a historical version that loaded is presented.
 *
 * Side by side when the two versions can be diffed, the version on its own
 * when they cannot. Never neither.
 */
export function renderLoadedVersion(
  current: ReadyView,
  historical: ReadyView,
  selectedVersion: number,
  usercontentOrigin: string,
  onChanges?: (
    changes: readonly RenderedChange[],
    summary: string,
    onJump?: (index: number) => void
  ) => void
): HTMLElement {
  const mode = diffModeForRoutes(current.route, historical.route);
  if (mode === undefined) {
    return renderSingleVersion(
      historical,
      usercontentOrigin,
      uncomparableReason(current, historical, selectedVersion)
    );
  }
  if (mode === 'image') return renderImageComparison(current, historical);
  if (mode === 'code') return renderCodeComparison(current, historical);
  return renderRenderedComparison(
    current,
    historical,
    mode,
    usercontentOrigin,
    onChanges
  );
}

export interface ChangesSidebarHandle {
  readonly sidebar: HTMLElement;
  readonly resizer: HTMLElement;
  readonly tab: HTMLElement;
  setChanges(count: number, content: HTMLElement | undefined): void;
}

export function buildChangesSidebar(): ChangesSidebarHandle {
  const sidebar = document.createElement('aside');
  sidebar.className = 'thread diff-changes-sidebar is-open';
  sidebar.id = 'diff-changes-sidebar';
  sidebar.setAttribute('aria-labelledby', 'changes-title');

  const title = document.createElement('h2');
  title.className = 'thread-title';
  title.id = 'changes-title';

  const toggle = document.createElement('button');
  toggle.className = 'thread-toggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-controls', sidebar.id);
  toggle.setAttribute('aria-expanded', 'true');

  const toggleLabel = document.createElement('span');
  toggleLabel.textContent = 'Changes';
  const toggleCount = document.createElement('span');
  toggleCount.className = 'action-count';
  toggleCount.textContent = '0';
  toggle.append(toggleLabel, toggleCount);
  title.appendChild(toggle);

  const resizer = document.createElement('div');
  resizer.className = 'thread-resizer diff-resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.setAttribute('aria-label', 'Resize the changes');
  resizer.tabIndex = 0;

  const tab = document.createElement('button');
  tab.className = 'thread-tab diff-tab';
  tab.type = 'button';
  tab.setAttribute('aria-controls', sidebar.id);
  tab.setAttribute('aria-expanded', 'true');
  const tabLabel = document.createElement('span');
  tabLabel.textContent = 'Changes';
  const tabCount = document.createElement('span');
  tabCount.className = 'action-count';
  tabCount.textContent = '0';
  tab.append(tabLabel, tabCount);

  const body = document.createElement('div');
  body.className = 'diff-changes-body';

  sidebar.append(title, body);

  const setOpen = (open: boolean): void => {
    sidebar.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    tab.setAttribute('aria-expanded', String(open));
    if (open) toggle.focus({ preventScroll: true });
  };

  const toggleOpen = (): void => {
    setOpen(!sidebar.classList.contains('is-open'));
  };

  toggle.addEventListener('click', toggleOpen);
  tab.addEventListener('click', toggleOpen);

  resizer.addEventListener('pointerdown', (event) => {
    const row = resizer.parentElement;
    if (row === null) return;
    event.preventDefault();
    const right = row.getBoundingClientRect().right;
    resizer.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent): void => {
      const minStage = 448;
      const width = Math.max(
        280,
        Math.min(window.innerWidth - minStage, right - moved.clientX)
      );
      document.documentElement.style.setProperty(
        '--thread-width',
        `${Math.round(width)}px`
      );
    };
    const done = (): void => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', done);
      resizer.removeEventListener('pointercancel', done);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', done);
    resizer.addEventListener('pointercancel', done);
  });

  return {
    sidebar,
    resizer,
    tab,
    setChanges(count: number, content: HTMLElement | undefined): void {
      toggleCount.textContent = String(count);
      tabCount.textContent = String(count);
      if (content !== undefined) {
        body.replaceChildren(content);
      } else {
        body.replaceChildren(noChanges('No changes between these versions.'));
      }
      setOpen(count > 0);
    },
  };
}

function renderCodeChangeList(parts: readonly TextDiffPart[]): HTMLElement {
  const list = document.createElement('ul');
  list.className = 'diff-change-list';
  for (const part of parts) {
    if (part.kind === 'unchanged') continue;
    const item = document.createElement('li');
    item.className = `diff-change diff-change-${part.kind}`;
    const kind = document.createElement('span');
    kind.className = 'diff-change-kind';
    kind.textContent = part.kind;
    const what = document.createElement('span');
    what.className = 'diff-change-what';
    what.textContent =
      part.kind === 'added'
        ? `Line ${part.currentStart ?? 1}`
        : `Line ${part.beforeStart ?? 1}`;
    const detail = document.createElement('span');
    detail.className = 'diff-change-detail';
    detail.textContent = part.value.trim();
    item.append(kind, what, detail);
    list.appendChild(item);
  }
  return list;
}

function renderImageChangeNotice(): HTMLElement {
  const list = document.createElement('ul');
  list.className = 'diff-change-list';
  const item = document.createElement('li');
  item.className = 'diff-change diff-change-changed';
  const kind = document.createElement('span');
  kind.className = 'diff-change-kind';
  kind.textContent = 'changed';
  const what = document.createElement('span');
  what.className = 'diff-change-what';
  what.textContent = 'Image';
  const detail = document.createElement('span');
  detail.className = 'diff-change-detail';
  detail.textContent = 'Dimensions or pixel content changed.';
  item.append(kind, what, detail);
  list.appendChild(item);
  return list;
}

/**
 * Seeds the initial pair of versions to compare.
 *
 * Never seeds the same version on both sides. When viewing an earlier version
 * with a predecessor, it pairs backward (predecessor on the left, viewed version
 * on the right). When viewing version 1, which has no predecessor, it pairs
 * forward (version 1 on the left, version 2 on the right).
 */
export function seedComparisonPair(
  viewedVersion: number,
  currentVersion: number
): { readonly left: number; readonly right: number } {
  if (currentVersion <= 1) {
    return { left: 1, right: 1 };
  }
  if (viewedVersion <= 1) {
    return { left: 1, right: 2 };
  }
  return { left: viewedVersion - 1, right: viewedVersion };
}

export function renderComparison(
  current: ReadyView,
  relicId: string,
  usercontentOrigin: string,
  deps: ViewerDeps,
  onClose: () => void,
  initialLeft?: number,
  initialRight?: number
): void {
  const defaultPair = seedComparisonPair(
    current.version,
    current.currentVersion
  );
  let leftVersion = initialLeft ?? defaultPair.left;
  let rightVersion = initialRight ?? defaultPair.right;

  const versionCache = new Map<number, HistoricalVersionState>();
  if (current.version !== undefined) {
    versionCache.set(current.version, { kind: 'ready', view: current });
  }

  let request = 0;

  const scaffold = buildComparisonScaffold(
    current.currentVersion,
    leftVersion,
    rightVersion,
    (newLeft, newRight) => {
      leftVersion = newLeft;
      rightVersion = newRight;
      void updateSelected();
    }
  );

  const changesSidebar = buildChangesSidebar();

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const minStage = 448;
    const maxSidebar = Math.max(280, window.innerWidth - minStage);
    const stored = readThreadWidth();
    if (stored !== undefined && stored > maxSidebar) {
      document.documentElement.style.setProperty(
        '--thread-width',
        `${Math.round(maxSidebar)}px`
      );
    }
  }

  const getVersion = async (
    version: number
  ): Promise<HistoricalVersionState> => {
    if (version === current.version) {
      return { kind: 'ready', view: current };
    }
    const cached = versionCache.get(version);
    if (cached !== undefined) return cached;
    const loaded = await loadHistoricalVersion(relicId, version, current, deps);
    versionCache.set(version, loaded);
    return loaded;
  };

  const updateSelected = async (): Promise<void> => {
    const thisRequest = ++request;

    // Refuse comparison if both sides are identical
    if (leftVersion === rightVersion) {
      scaffold.headline.textContent = `Version ${leftVersion}`;
      scaffold.historyNote.textContent =
        'Choose two different versions to see what changed between them.';
      scaffold.result.setAttribute('aria-busy', 'false');
      scaffold.result.replaceChildren(
        notice(
          'Comparing a version to itself produces no diff. Choose two different versions to compare.'
        )
      );
      changesSidebar.setChanges(0, undefined);
      return;
    }

    const copy = comparisonCopy(
      leftVersion,
      rightVersion,
      current.currentVersion
    );
    scaffold.headline.textContent = copy.headline;
    scaffold.historyNote.textContent = copy.detail;
    scaffold.result.setAttribute('aria-busy', 'true');

    const loading = document.createElement('p');
    loading.className = 'diff-loading';
    loading.setAttribute('role', 'status');
    loading.textContent = `Loading comparison: version ${leftVersion} and version ${rightVersion}.`;
    scaffold.result.replaceChildren(loading);

    const [leftRes, rightRes] = await Promise.all([
      getVersion(leftVersion),
      getVersion(rightVersion),
    ]);
    if (thisRequest !== request) return;
    if (typeof document === 'undefined') return;
    scaffold.result.setAttribute('aria-busy', 'false');

    if (leftRes.kind === 'unavailable') {
      scaffold.result.replaceChildren(notice(leftRes.detail));
      changesSidebar.setChanges(0, undefined);
      return;
    }
    if (rightRes.kind === 'unavailable') {
      scaffold.result.replaceChildren(notice(rightRes.detail));
      changesSidebar.setChanges(0, undefined);
      return;
    }

    const mode = diffModeForRoutes(leftRes.view.route, rightRes.view.route);
    const comparable = mode !== undefined;
    scaffold.headline.textContent = comparisonCopy(
      leftVersion,
      rightVersion,
      current.currentVersion,
      comparable
    ).headline;

    if (mode === 'code') {
      const textDiff = createTextDiff(
        decodeText(leftRes.view.content),
        decodeText(rightRes.view.content)
      );
      const changedParts = textDiff.parts.filter((p) => p.kind !== 'unchanged');
      changesSidebar.setChanges(
        changedParts.length,
        changedParts.length > 0
          ? renderCodeChangeList(textDiff.parts)
          : undefined
      );
    } else if (mode === 'image') {
      const isChanged = !bytesEqual(
        leftRes.view.content,
        rightRes.view.content
      );
      changesSidebar.setChanges(
        isChanged ? 1 : 0,
        isChanged ? renderImageChangeNotice() : undefined
      );
    }

    scaffold.result.replaceChildren(
      renderLoadedVersion(
        rightRes.view,
        leftRes.view,
        leftVersion,
        usercontentOrigin,
        (changes, _summary, onJump) => {
          if (thisRequest !== request) return;
          changesSidebar.setChanges(
            changes.length,
            changes.length > 0 ? renderChangeList(changes, onJump) : undefined
          );
        }
      )
    );
  };

  const diffRow = document.createElement('div');
  diffRow.className = 'relic-row diff-row';
  diffRow.append(
    scaffold.main,
    changesSidebar.sidebar,
    changesSidebar.resizer,
    changesSidebar.tab
  );

  document.body.replaceChildren(
    buildBar(current, relicId, {
      onCompare: onClose,
      comparisonOpen: true,
      selectedVersion: rightVersion,
      onShare: (opener) => {
        openSharePanel(current, relicId, deps, opener);
      },
    }),
    diffRow
  );
  scaffold.headline.focus();
  void updateSelected();
}

/* ---------- the comment thread ---------- */

/**
 * A paragraph, because the thread builds a dozen of them and they have to
 * agree on getting their text through `textContent`.
 */
function line(className: string, text: string): HTMLElement {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = text;
  return element;
}

/** A labelled control, since the composer builds three. */
function field(
  labelText: string,
  control: HTMLInputElement | HTMLTextAreaElement
): HTMLElement {
  const label = document.createElement('label');
  label.className = 'compose-field';
  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(text, control);
  return label;
}

/** Said when the session could not be read, so the address is asked for. */
const UNKNOWN_SESSION_NOTE =
  'Relic could not tell whether this browser is already verified, so it is ' +
  'asking. Entering an address you have used before costs nothing but the ' +
  'email.';

/** The policy page, linked beside each disclosure that summarises it. */
function policyLink(): HTMLElement {
  const link = document.createElement('a');
  link.className = 'thread-policy';
  link.href = `${SERVICE_ORIGIN}/policy`;
  link.rel = 'noopener noreferrer';
  link.textContent = 'What Relic knows';
  return link;
}

/**
 * The address step, for a reader this browser has not verified.
 *
 * One flow for the comment composer and the share panel, because both want
 * the same session, and two copies of the magic-link round trip would drift
 * on exactly the parts that matter: the fragment never goes in the request,
 * and the reader is warned when following the link here would lose the key.
 * `lead` is what each caller says above the field.
 */
function signInForm(
  lead: readonly HTMLElement[],
  options: {
    readonly relicId: string;
    readonly fragment: string;
    readonly deps: ViewerDeps;
    readonly outcome: HTMLElement;
    readonly label: string;
  }
): { readonly form: HTMLFormElement; readonly email: HTMLInputElement } {
  const { relicId, fragment, deps, outcome } = options;
  const form = document.createElement('form');
  form.append(...lead);

  const email = document.createElement('input');
  email.type = 'email';
  email.required = true;
  email.autocomplete = 'email';
  email.className = 'compose-input';
  email.placeholder = 'you@example.com';
  form.appendChild(field(options.label, email));

  form.appendChild(line('compose-fine', DELIVERY_DISCLOSURE));

  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'action primary';
  send.textContent = 'Send me a link';
  form.appendChild(send);

  form.addEventListener('submit', (event) => {
    // The control. `form-action 'none'` in the shell's CSP is the backstop,
    // and both are wanted: a submission that got past this would put the
    // address in a query string on the one page whose URL must stay clean.
    event.preventDefault();
    const address = email.value.trim();
    if (address.length === 0) return;
    send.disabled = true;
    outcome.replaceChildren(line('thread-note', 'Sending.'));
    void requestMagicLink(relicId, address, deps).then((result) => {
      send.disabled = false;
      if (result.kind === 'refused') {
        outcome.replaceChildren(threadRefusal(result.refusal, () => {}));
        return;
      }
      // Deliberately does not confirm the address exists. The endpoint
      // answers 202 either way so it cannot be used to find out who has
      // commented before, and copy reading "we sent it" would hand back
      // exactly what that 202 withholds.
      const said = [
        line(
          'thread-note',
          `If ${plainLabel(address)} can receive mail, a link is on its ` +
            'way. Following it verifies the address and brings you back ' +
            'here.'
        ),
      ];
      if (!keySurvivesNavigation(relicId, fragment, deps)) {
        said.push(line('compose-warning', KEY_AT_RISK_NOTE));
      }
      outcome.replaceChildren(...said);
    });
  });

  return { form, email };
}

/**
 * One comment.
 *
 * The address is the identity, so it is always present and never replaced. A
 * display name sits in front of it as an alias, which is what `frame.md`
 * settled when it reversed the no-accounts non-goal: names are decoration and
 * the address is the record.
 *
 * Both are untrusted display text on the origin that holds the fragment. The
 * name is chosen by any link holder, and the address only proves a mailbox
 * answered, so both go in through `textContent` with the bidirectional
 * controls stripped.
 */
export function commentRow(
  entry: CommentEntry,
  /**
   * Whether this comment's mark exists and could not be placed on the page.
   *
   * Read as a parameter rather than derived here, because whether a mark
   * lands depends on what is currently rendered and only the paint pass
   * knows that.
   */
  unplaceable = false,
  addressed?: AddressedBy | null,
  replies: HTMLElement[] = [],
  isReply = false
): HTMLElement {
  const row = document.createElement('li');
  row.className =
    entry.kind === 'open' ? 'comment' : 'comment comment-undecryptable';
  if (isReply) {
    row.classList.add('comment-reply');
  }
  if (entry.id !== null) row.dataset.commentId = entry.id;

  const head = document.createElement('div');
  head.className = 'comment-head';

  if (entry.kind === 'open' && entry.displayName !== null) {
    const name = document.createElement('span');
    name.className = 'comment-name';
    name.textContent = plainLabel(entry.displayName);
    head.appendChild(name);
  }

  // A row this page could not read at all may carry no author, so the slot is
  // left empty rather than filled with a stand in. Inventing a sender for a
  // row that named none would be the only fabrication on the page.
  if (entry.author !== null) {
    const author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = plainLabel(entry.author);
    head.appendChild(author);
  }

  if (entry.author === PUBLISHER_AUTHOR) {
    // True by construction rather than by claim: this comment was authorized
    // by the publish token, and only the machine that published the relic
    // holds one.
    const badge = document.createElement('span');
    badge.className = 'comment-badge';
    badge.textContent = 'Published this relic';
    head.appendChild(badge);
  }
  if (entry.version === null || entry.version === undefined) {
    const unversioned = document.createElement('span');
    unversioned.className = 'comment-badge comment-badge-unversioned';
    unversioned.textContent = 'Version unknown';
    // setAttribute rather than the title property, because the badge is read
    // back through getAttribute in tests and the two were being set twice.
    unversioned.setAttribute('title', 'Predates versioning');
    head.appendChild(unversioned);
  }

  if (entry.editedAt !== null && entry.editedAt !== undefined) {
    // Said rather than shown, because the earlier text does not exist to
    // show: one ciphertext per comment means an edit overwrote it. What a
    // reader is owed is that the words on screen are not the words posted.
    const edited = document.createElement('span');
    edited.className = 'comment-badge comment-badge-edited';
    edited.textContent = EDITED_LABEL;
    edited.setAttribute('title', `Replaced ${commentTime(entry.editedAt)}`);
    head.appendChild(edited);
  }

  const resolution = entry.resolution ?? null;
  if (resolution !== null) {
    // The row goes quiet rather than disappearing. A settled remark is still
    // part of what was said, and a thread that hides them reads as a shorter
    // conversation than it was.
    row.classList.add('is-resolved');
    const settled = document.createElement('span');
    settled.className = 'comment-badge comment-badge-resolved';
    settled.textContent = 'Resolved';
    settled.setAttribute('title', resolvedLabel(resolution));
    head.appendChild(settled);
  }

  const resolvedAddressed =
    addressed ?? (entry.kind === 'open' ? entry.addressed : null);
  if (resolvedAddressed !== null && resolvedAddressed !== undefined) {
    const addressedBadge = document.createElement('span');
    addressedBadge.className = 'comment-badge comment-badge-addressed';
    addressedBadge.textContent = addressedBadgeLabel(resolvedAddressed);
    addressedBadge.dataset.addressedKind = resolvedAddressed.kind;
    if (
      resolvedAddressed.version !== null &&
      resolvedAddressed.version !== undefined
    ) {
      addressedBadge.dataset.addressedVersion = String(
        resolvedAddressed.version
      );
    }
    head.appendChild(addressedBadge);
  }

  if (entry.createdAt !== null) {
    const time = document.createElement('time');
    time.className = 'comment-time';
    time.setAttribute('datetime', entry.createdAt);
    time.textContent = commentTime(entry.createdAt);
    head.appendChild(time);
  }

  row.appendChild(head);

  if (entry.kind === 'open') {
    const body = document.createElement('div');
    body.className = 'comment-body';
    body.innerHTML = renderMarkdown(entry.body);
    row.appendChild(body);
  } else if (entry.kind === 'sealed') {
    row.appendChild(
      line(
        'comment-body comment-sealed',
        'This comment did not decrypt. It was either written under a ' +
          'different key for this relic or altered in storage, and there is ' +
          'no way to tell which from here. It is shown rather than dropped, ' +
          'because a thread that quietly hides what it cannot read is one ' +
          'you cannot trust the length of.'
      )
    );
  } else {
    row.appendChild(
      line(
        'comment-body comment-sealed',
        'This comment did not arrive in a form this page can read, so there ' +
          'may never have been a body to open. It is counted here rather ' +
          'than hidden, because a thread that is shorter than it looks is ' +
          'one you cannot trust the length of.'
      )
    );
  }
  // Said on the row rather than left to be inferred from a missing mark. A
  // comment that points at something and shows nothing reads as a comment
  // about the whole relic, which is the wrong thing to conclude from it.
  if (unplaceable) {
    row.appendChild(line('comment-unplaceable', MARK_UNPLACEABLE_NOTE));
  }

  if (replies.length > 0) {
    const repliesList = document.createElement('ol');
    repliesList.className = 'comment-replies';
    repliesList.append(...replies);
    row.appendChild(repliesList);
  }
  return row;
}

/** A refusal, with its cause named and a retry only where one could work. */
export function threadRefusal(
  refusal: Refusal,
  onRetry: () => void
): HTMLElement {
  const card = document.createElement('div');
  card.className = 'thread-refusal';
  const headline = document.createElement('p');
  headline.className = 'thread-refusal-title';
  headline.textContent = refusal.headline;
  card.append(headline, line('thread-note', refusal.detail));
  if (refusal.retryable) {
    const again = button('Try again', ICONS.rendered, onRetry);
    again.classList.add('primary');
    card.appendChild(again);
  }
  const code = document.createElement('div');
  code.className = 'accession';
  code.textContent = refusal.code;
  card.appendChild(code);
  return card;
}

/** Copy for a thread with nothing in it yet, which is not an error. */
export const THREAD_EMPTY_NOTE =
  'No comments yet. Anyone holding this link can leave one, and the text is ' +
  'encrypted the same way the file is, so Relic stores it without being ' +
  'able to read it.';

/**
 * Copy for the wait, with its reason attached.
 *
 * A bare spinner here would be hiding the interesting part: the bodies arrive
 * as ciphertext and are opened in this browser, so the list can exist before
 * the words in it do.
 */
export const THREAD_LOADING_NOTE =
  'Reading the thread. Comment text arrives encrypted and is decrypted here ' +
  'with the key from your link.';

interface ThreadHandle {
  readonly element: HTMLElement;
  /** The edge tab that opens the sidebar, for a row that has room for it. */
  readonly tab: HTMLElement;
  /** The divider between the relic and the sidebar. */
  readonly resizer: HTMLElement;
  /** Opens or closes the sidebar beside the relic. */
  readonly toggle: () => void;
  /**
   * Settles when the first load has finished painting.
   *
   * A caller that discards the page while this is pending leaves a fetch
   * whose continuation has nowhere to paint. Tests await it; the browser
   * path ignores it, because there the page outlives the fetch.
   */
  readonly ready: Promise<void>;
  /** The stage the marks are painted on. */
  readonly attach: (host: HTMLElement) => void;
}

/** Compares two session states without comparing objects. */
function sessionSignature(state: SessionState): string {
  return state.kind === 'verified' ? `verified:${state.email}` : state.kind;
}
/** Updates the sidebar header without replacing the interactive control. */
export function updateThreadToggle(toggle: HTMLElement, count: number): void {
  toggle.textContent = threadCountLabel(count);
}

/** The narrowest sidebar a comment is worth reading in, in CSS pixels. */
const THREAD_MIN_WIDTH = 272;

/** What a reader gets before they have ever dragged the divider. */
const THREAD_DEFAULT_WIDTH = 352;

/** The widest sidebar, so a wide window still spends most of itself on the relic. */
const THREAD_MAX_WIDTH = 640;

const THREAD_WIDTH_KEY = 'relic:comment-width';

/**
 * Deliberately not keyed by relic.
 *
 * A display name belongs to the reader, not to the file they are looking at,
 * and retyping it per relic is the same annoyance as signing in per relic. It
 * is untrusted text the reader chose and it is not a credential, which is why
 * it can live here at all: the session proving who they are stays in an
 * HttpOnly cookie that no script on this origin can read.
 */
const DISPLAY_NAME_KEY = 'relic:display-name';

/**
 * Clamps a dragged width to what the viewport can actually spare.
 *
 * The ceiling is a share of the viewport rather than a constant, so dragging
 * the divider in a narrow window cannot push the relic out of the row.
 */
export function clampThreadWidth(width: number, viewport: number): number {
  const max = Math.max(
    THREAD_MIN_WIDTH,
    Math.min(THREAD_MAX_WIDTH, viewport * 0.6)
  );
  return Math.min(Math.max(width, THREAD_MIN_WIDTH), max);
}

/**
 * Storage for reader preferences, or nothing.
 *
 * Touching `localStorage` throws outright in some embedded contexts rather
 * than being absent, so the guard has to be a try and not a null check.
 * Preferences only: relic keys go through the vault and the session is a
 * cookie, neither of which belongs here.
 */
function preferenceStore(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** The display name this reader last posted under, on any relic. */
export function readDisplayName(): string {
  try {
    return preferenceStore()?.getItem(DISPLAY_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Remembers it, so the next comment and the next relic start filled in. */
export function writeDisplayName(name: string): void {
  try {
    const store = preferenceStore();
    if (store === undefined) return;
    const trimmed = name.trim();
    // Clearing it is a choice worth keeping, so an empty name removes the
    // entry rather than leaving the previous one to reappear.
    if (trimmed.length === 0) store.removeItem(DISPLAY_NAME_KEY);
    else store.setItem(DISPLAY_NAME_KEY, trimmed);
  } catch {
    // Quota, or storage disabled mid-session. A remembered name is a
    // convenience, and failing to keep one is not worth an error page.
  }
}

/**
 * The display name field, already filled in.
 *
 * A function rather than four lines inline so the prefill is assertable: the
 * whole point of the change is that this field arrives carrying the name the
 * reader typed on some other relic, and an untested assignment is exactly the
 * kind of one-liner that silently stops happening.
 */
export function displayNameInput(): HTMLInputElement {
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'compose-input';
  // A coarse guard only: `maxLength` counts UTF-16 units and the cap is on
  // UTF-8 bytes, so the byte check before encryption is the authority.
  name.maxLength = MAX_DISPLAY_NAME_BYTES;
  name.placeholder = 'Optional, shown beside your address';
  name.value = readDisplayName();
  return name;
}

/** Where the remembered comparison layout lives. */
const COMPARE_LAYOUT_KEY = 'relic:compare-layout';

/**
 * The layout this reader last chose, across relics and across versions.
 *
 * Remembered because switching versions rebuilds the comparison, and a
 * rebuild that reset the layout put a reader who had chosen side by side
 * back into the swipe every time they moved a version. The default only
 * applies until they express a preference; after that it is theirs.
 */
export function readCompareLayout(): 'swipe' | 'split' | undefined {
  try {
    const raw = preferenceStore()?.getItem(COMPARE_LAYOUT_KEY);
    return raw === 'swipe' || raw === 'split' ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function writeCompareLayout(layout: 'swipe' | 'split'): void {
  try {
    preferenceStore()?.setItem(COMPARE_LAYOUT_KEY, layout);
  } catch {
    // A reader with storage denied still gets the layout they pressed for
    // as long as the page lives. Losing it on reload is worth less than
    // throwing here would cost.
  }
}

/** The width this reader last dragged the divider to, if it was kept. */
function readThreadWidth(): number | undefined {
  try {
    const raw = preferenceStore()?.getItem(THREAD_WIDTH_KEY);
    if (raw === null || raw === undefined) return undefined;
    const width = Number.parseInt(raw, 10);
    return Number.isFinite(width) ? width : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps a dragged width, so the next relic opens the way this one was left. */
function writeThreadWidth(width: number): void {
  try {
    preferenceStore()?.setItem(THREAD_WIDTH_KEY, String(Math.round(width)));
  } catch {
    // Quota, or storage disabled mid-session. A remembered width is a
    // convenience, and failing to keep one is not worth an error page.
  }
}

/** The scrolled stage, as the numbers a mark needs from it. */
export interface StageBox {
  readonly left: number;
  readonly top: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
}

/**
 * Where a click landed, as a fraction of the whole rendered relic.
 *
 * Of the whole relic, not of the visible box. A mark belongs to the line it
 * was put on, and the reader scrolls. Measuring against the visible box pins a
 * comment to a screen position instead, which is how a mark ends up beside
 * unrelated text one scroll later, and how a mark placed halfway down a long
 * relic lands near the top of it.
 */
export function pinFraction(
  box: StageBox,
  clientX: number,
  clientY: number
): { readonly x: number; readonly y: number } | undefined {
  if (box.scrollWidth <= 0 || box.scrollHeight <= 0) return undefined;
  const x = (clientX - box.left + box.scrollLeft) / box.scrollWidth;
  const y = (clientY - box.top + box.scrollTop) / box.scrollHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
  return { x, y };
}

/**
 * Where a stored fraction sits, in the scrolled content's own pixels.
 *
 * Pixels rather than percentages: a percentage inside a scroll container
 * resolves against the visible box, so a pin two screens down would paint
 * itself onto the first screen.
 */
export function pinOffsets(
  anchor: { readonly x: number; readonly y: number },
  content: { readonly scrollWidth: number; readonly scrollHeight: number }
): { readonly left: number; readonly top: number } {
  return {
    left: anchor.x * content.scrollWidth,
    top: anchor.y * content.scrollHeight,
  };
}

/** What an armed pin tool tells the reader to do next. */
export const MARK_PIN_HINT = 'Click the document to place a point';

/** What an armed region tool tells the reader to do next. */
export const MARK_REGION_HINT =
  'Click to place a point, or drag to select a region (use arrows and Enter for keyboard)';

/**
 * How long a pointer rests on a mark before its comment opens.
 *
 * Short enough to read as a response to pointing, long enough that crossing
 * a paragraph of marked text does not flash a card per word.
 */
export const MARK_HOVER_OPEN_MS = 140;

/**
 * Grace before a card closes after the pointer leaves.
 *
 * The gap between a mark and the card above it is real, and a card that
 * closed while the pointer crossed it could never be reached at all.
 */
export const MARK_HOVER_CLOSE_MS = 220;

/**
 * What `stickyId` holds while a new comment is being written.
 *
 * A colon cannot occur in a service-minted id, which is the same reason the
 * provisional mark key below is shaped this way, so this can never collide
 * with a real comment.
 */
const COMPOSING = 'composing:new';

/**
 * The key a provisional mark is painted under.
 *
 * A colon cannot occur in a server-minted comment id, which is base64url, so
 * this can never collide with a real one. That matters because the pairing
 * handler and the unwrap pass both address marks by this key, and a collision
 * would light the wrong comment or strand a mark on the page.
 */
export const PENDING_MARK_ID = 'pending:target';

/**
 * Paints the target the reader has aimed but not yet posted.
 *
 * Runs inside the same pass as the posted marks rather than beside it. Two
 * passes would mean two places that decide what the document shows, and the
 * provisional mark would survive a refresh that removed everything else.
 */
export function paintPendingMark(
  host: HTMLElement,
  pins: HTMLElement,
  anchor: CommentAnchor | null
): void {
  if (anchor === null) {
    host
      .querySelector<HTMLIFrameElement>('iframe.usercontent-frame')
      ?.contentWindow?.postMessage(
        { type: 'relic:clear-mark', id: PENDING_MARK_ID },
        '*'
      );
    return;
  }
  if (anchor.kind === 'text') {
    wrapTextQuote(host, anchor.quote, PENDING_MARK_ID);
    const painted = host.querySelector(
      `mark[data-comment-id="${PENDING_MARK_ID}"]`
    );
    painted?.classList.add('is-pending');
    return;
  }
  if (anchor.kind === 'pin') {
    // A framed relic scrolls inside its frame, so a pin over it is drawn
    // there by its adapter, which marks the provisional one itself.
    const surface = anchorSurfaceFor(host);
    const framed =
      surface === undefined ? undefined : adapterFor(anchor, surface);
    if (surface !== undefined && framed !== undefined) {
      framed.paint(surface, pins, anchor, PENDING_MARK_ID);
      return;
    }
    const pin = document.createElement('div');
    // Not a button: there is no comment to scroll to yet, and a control that
    // answers a press by doing nothing is the defect this whole change removed.
    pin.className = 'comment-pin is-pending';
    pin.dataset.commentId = PENDING_MARK_ID;
    const offsets = pinOffsets(anchor, host);
    pin.style.left = `${offsets.left}px`;
    pin.style.top = `${offsets.top}px`;
    pins.appendChild(pin);
    return;
  }
  // A precise kind paints its provisional mark through the same adapter that
  // paints the posted one, so the reader sees the thing they aimed at rather
  // than a preview that differs from the result.
  const surface = anchorSurfaceFor(host);
  if (surface === undefined) return;
  const adapter = adapterFor(anchor, surface);
  if (adapter === undefined) return;
  adapter.paint(surface, pins, anchor, PENDING_MARK_ID);
  for (const root of [pins, host]) {
    for (const painted of root.querySelectorAll(
      `[data-comment-id="${PENDING_MARK_ID}"]`
    )) {
      painted.classList.add('is-pending');
    }
  }
}

/**
 * The element geometry is measured against, given the stage marks live on.
 *
 * The artifact, when there is exactly one: the `img`, the `video`, the frame,
 * the page canvas. Otherwise the stage stands in as its own content box,
 * which is right for flowing text where there is no single framed object and
 * the host *is* the content.
 *
 * `undefined` never happens today and is kept in the signature because a
 * future class could render more than one candidate, and silently picking
 * the first would put marks on whichever one happened to be first in the DOM.
 */
export function anchorSurfaceFor(host: HTMLElement): AnchorSurface | undefined {
  const candidates = host.querySelectorAll(
    '.otio-view, img.relic-image, video.relic-media, audio.relic-media, iframe.usercontent-frame, canvas.relic-page'
  );
  if (candidates.length > 1) return undefined;
  const only = candidates.item?.(0) ?? candidates[0];
  return {
    host,
    content:
      only instanceof HTMLElement || (only && typeof only === 'object')
        ? (only as HTMLElement)
        : host,
  };
}

/**
 * What the composer says the next comment is about.
 *
 * Having no target is a state with wording rather than a blank, because the
 * blank is what shipped: nothing on the page said marks existed, and a reader
 * who had selected something by accident had no way to find out that the next
 * comment they wrote was about to land on it.
 */
export function markTargetLabel(anchor: CommentAnchor | null): string {
  if (anchor === null) return 'Commenting on the whole document';
  if (anchor.kind === 'pin') return 'Commenting on a point';
  if (anchor.kind === 'text') return quotedTargetLabel(anchor.quote);
  return anchorLabel(anchor) ?? UNSUPPORTED_ANCHOR_LABEL;
}

/** The aiming controls, and the one target they hold between them. */
export interface MarkControls {
  /**
   * The chip the composer carries in every state, including holding no target
   * at all. That state is the one worth announcing: it answers "can I comment
   * on a line", and before this there was nothing on the page that did.
   */
  readonly chip: HTMLElement;
  /** The row offering the pin tool, or saying why this relic cannot have one. */
  readonly tools: HTMLElement;
  /** Binds a rendered stage, and decides there whether marks can work at all. */
  attach(host: HTMLElement): void;
  /** Read once, when a comment is posted. */
  target(): CommentAnchor | null;
  /** Back to the whole document, with the pin tool disarmed. */
  clear(): void;
}

export interface MarkDeps {
  /** Aiming a mark is the start of writing one, so the thread comes open. */
  readonly open: () => void;
  /** Where the reader types, once a target is locked. */
  readonly focusBody: () => void;
  /**
   * Repaints the document's marks, because the target changed.
   *
   * A chip that names a quote while the page shows nothing tells the reader
   * where their comment is going and gives them no way to check it. The
   * target is painted on the document from the same pass that paints posted
   * comments, so a provisional mark and a real one cannot drift apart.
   */
  readonly repaint: () => void;
  /**
   * Writes the comment where the reader is looking, rather than in a sidebar
   * they are not looking at.
   *
   * Returns false when the page cannot compose here: composing needs an
   * identity, verifying one needs the magic-link flow, and that flow lives
   * in the sidebar. A panel that offered a field nobody could post from
   * would be worse than the hand-off.
   */
  readonly compose?: (
    anchor: CommentAnchor,
    box: AnchorBox,
    options?: ComposeOptions
  ) => boolean;
}

/** What a composer opened over the page is told beyond where it goes. */
export interface ComposeOptions {
  /**
   * Whether the field takes focus. False while the reader is still adjusting
   * what the comment is about, because focus belongs to the control they
   * are adjusting it with.
   */
  readonly focus?: boolean;
  /**
   * Measures the target again, in the host's content coordinates, for a page
   * that moved under the panel: a stage going into fullscreen or coming out.
   */
  readonly reanchor?: () => AnchorBox | undefined;
}

/**
 * Tells the media player what a comment is aimed at, or that it no longer is.
 *
 * Dispatched on the player's own controls, because that is where it listens
 * and an event dispatched on the stage around it bubbles away from the
 * player rather than down into it. It still bubbles out to the stage, so
 * anything listening there hears it too.
 */
function tellPlayer(
  host: HTMLElement,
  type: 'relic:time-selection' | 'relic:time-selection-cleared',
  anchor?: CommentAnchor
): void {
  if (typeof CustomEvent !== 'function') return;
  const player =
    host.querySelector<HTMLElement>('.custom-media-player') ?? host;
  if (typeof player.dispatchEvent !== 'function') return;
  player.dispatchEvent(
    new CustomEvent(type, {
      bubbles: true,
      ...(anchor !== undefined ? { detail: { anchor } } : {}),
    })
  );
}

/**
 * Leaves fullscreen when something inside this stage holds it, then runs
 * `next`.
 *
 * The sidebar sits outside the fullscreen element and cannot be seen from
 * inside it, so anything that has to put the reader in the sidebar has to
 * bring the page back first.
 */
function leaveStageFullscreen(host: HTMLElement, next: () => void): void {
  const shown = document.fullscreenElement;
  if (
    shown === null ||
    shown === undefined ||
    !host.contains(shown) ||
    typeof document.exitFullscreen !== 'function'
  ) {
    next();
    return;
  }
  Promise.resolve(document.exitFullscreen()).then(next, next);
}

/**
 * A box reported by the frame, in the host's content coordinates.
 *
 * Two conversions, and both are easy to forget. The frame measures against
 * its own viewport, so the iframe's position has to be added, and the host
 * scrolls its children, so its scroll has to be added after that. Doing it
 * here means the popover code never sees a frame coordinate.
 */
export function frameAnchorBox(
  frame: HTMLElement,
  rect: FrameRect,
  host: HTMLElement
): AnchorBox {
  const framed = frame.getBoundingClientRect();
  return anchorFromClientRect(
    {
      left: framed.left + rect.left,
      top: framed.top + rect.top,
      width: rect.width,
      height: rect.height,
    },
    host.getBoundingClientRect(),
    host
  );
}

/**
 * Writes a placement onto a panel already inserted in the host.
 *
 * Inserted first because the panel's own height decides whether it fits
 * above the thing it points at, and an element outside the document has no
 * height to read.
 */
function positionPanel(
  panel: HTMLElement,
  anchor: AnchorBox,
  host: HTMLElement
): void {
  const placed = placePopover(
    anchor,
    { width: panel.offsetWidth, height: panel.offsetHeight },
    host
  );
  panel.style.left = `${placed.left}px`;
  panel.style.top = `${placed.top}px`;
  panel.dataset['side'] = placed.side;
}

/**
 * Reads the selection the browser has finished settling.
 *
 * `mouseup` fires before the selection it produced is readable, so a handler
 * that reads immediately reads the previous one. Ten milliseconds is what
 * haiku's review app settled on for the same reason.
 */
function afterSelection(run: () => void): void {
  window.setTimeout(run, 10);
}

/**
 * The controls that let a reader aim a comment, and see what it is aimed at.
 *
 * Before this the target was set by any selection and rendered nowhere, so a
 * stray selection silently anchored the next comment to an unrelated line and
 * nothing on the page said so. Three changes fix that and they are one unit: a
 * selection now only offers a target, the composer always names the target it
 * holds, and a point is placed by an armed tool rather than by whichever click
 * happened to miss the text.
 */
export function buildMarkControls(deps: MarkDeps): MarkControls {
  let anchor: CommentAnchor | null = null;
  let host: HTMLElement | undefined;
  let bubble: HTMLElement | undefined;
  let mode: HTMLElement | undefined;
  let hint: HTMLElement | undefined;
  let teardownStage: (() => void) | undefined;
  let dragOrigin:
    | { clientX: number; clientY: number; unit: { x: number; y: number } }
    | undefined;
  let isDragging = false;
  let suppressClick = false;
  let drawingBox: HTMLElement | undefined;
  /**
   * Watches for an artifact that mounts after the stage does.
   *
   * The PDF renderer is a lazily imported chunk, so the page canvas appears
   * well after `attach` runs. Without this the tools row describes a stage
   * that has not finished rendering.
   */
  let lateArtifact: MutationObserver | undefined;
  let timeMode: HTMLElement | undefined;
  let timeHint: HTMLElement | undefined;
  let spanStart: number | null = null;
  let quoteAction: HTMLElement | undefined;
  let keyboardBox: HTMLElement | undefined;
  let keyboardRect: { x: number; y: number; w: number; h: number } | undefined;
  const chip = document.createElement('div');
  chip.className = 'compose-target';
  // Polite: a target arriving is worth announcing to a reader who cannot see
  // the chip change, and never worth interrupting one mid sentence.
  chip.setAttribute('aria-live', 'polite');

  const tools = document.createElement('div');
  tools.className = 'thread-tools';

  // One element rather than one per repaint, because there is one clear
  // control and its listener is attached once.
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'compose-target-clear';
  reset.textContent = 'Clear';
  reset.setAttribute('aria-label', 'Comment on the whole document instead');

  const dismiss = (): void => {
    bubble?.remove();
    bubble = undefined;
    quoteAction?.remove();
    quoteAction = undefined;
  };

  /** The button's own pressed state is the armed state, so there is one. */
  const armed = (): boolean => mode?.getAttribute('aria-pressed') === 'true';

  const removeKeyboardBox = (): void => {
    keyboardBox?.remove();
    keyboardBox = undefined;
    keyboardRect = undefined;
  };

  const disarmSpan = (): void => {
    spanStart = null;
    if (timeMode !== undefined) {
      timeMode.setAttribute('aria-pressed', 'false');
      const isAudio = host?.querySelector('audio') !== null;
      timeMode.textContent = isAudio
        ? 'Comment on this moment'
        : 'Comment on this frame';
    }
    timeHint?.remove();
    timeHint = undefined;
  };

  const disarm = (): void => {
    mode?.setAttribute('aria-pressed', 'false');
    host?.classList.remove('is-pinning');
    hint?.remove();
    hint = undefined;
    removeKeyboardBox();
    host
      ?.querySelector<HTMLIFrameElement>('iframe.usercontent-frame')
      ?.contentWindow?.postMessage(
        { type: 'relic:arm-pointing', armed: false },
        '*'
      );
  };

  const cancelAiming = (): void => {
    dismiss();
    disarm();
    disarmSpan();
    removeKeyboardBox();
    if (host !== undefined) tellPlayer(host, 'relic:time-selection-cleared');
  };

  const paintChip = (): void => {
    const label = document.createElement('span');
    label.className = 'compose-target-label';
    label.textContent = markTargetLabel(anchor);
    if (anchor === null) {
      chip.replaceChildren(label);
      return;
    }
    chip.replaceChildren(label, reset);
  };

  const clear = (): void => {
    anchor = null;
    dragOrigin = undefined;
    isDragging = false;
    suppressClick = false;
    drawingBox?.remove();
    drawingBox = undefined;
    cancelAiming();
    paintChip();
    deps.repaint();
    deps.focusBody();
  };
  reset.addEventListener('click', clear);

  const aim = (
    next: CommentAnchor,
    keepSpanArmed = false,
    focusBody = true
  ): void => {
    anchor = next;
    dismiss();
    disarm();
    if (!keepSpanArmed) disarmSpan();
    removeKeyboardBox();
    paintChip();
    deps.repaint();
    deps.open();
    if (focusBody) {
      deps.focusBody();
    }
    if (next.kind === 'time' && host !== undefined) {
      tellPlayer(host, 'relic:time-selection', next);
    }
  };
  const arm = (): void => {
    const surface = host;
    if (mode === undefined || surface === undefined) return;
    mode.setAttribute('aria-pressed', 'true');
    surface.classList.add('is-pinning');
    const said = document.createElement('p');
    said.className = 'mark-hint';
    said.setAttribute('aria-live', 'polite');
    const isImg = surface.querySelector('img.relic-image') !== null;
    said.textContent = isImg ? MARK_REGION_HINT : MARK_PIN_HINT;
    // looking at the document, the sidebar is not on the row at all at narrow
    // width, and a hint that took layout space would shift the line under the
    // cursor between arming and the click that places the point.
    surface.appendChild(said);
    hint = said;

    const s = anchorSurfaceFor(surface);
    if (isImg && s) {
      removeKeyboardBox();
      keyboardRect = { x: 0.35, y: 0.35, w: 0.3, h: 0.3 };
      const kbox = document.createElement('div');
      kbox.className = 'comment-region is-drawing is-pending is-keyboard';
      surface.appendChild(kbox);
      keyboardBox = kbox;

      const box = boxFromUnit(s, keyboardRect);
      if (box) {
        kbox.style.left = `${box.left}px`;
        kbox.style.top = `${box.top}px`;
        kbox.style.width = `${box.width}px`;
        kbox.style.height = `${box.height}px`;
      }
      if (surface.tabIndex < 0) surface.tabIndex = 0;
      surface.focus?.();
    } else {
      if (surface.tabIndex < 0) surface.tabIndex = 0;
      surface.focus?.();
    }

    surface
      .querySelector<HTMLIFrameElement>('iframe.usercontent-frame')
      ?.contentWindow?.postMessage(
        { type: 'relic:arm-pointing', armed: true },
        '*'
      );
  };

  /**
   * Two verbs over the words, and a way out.
   *
   * The intermediate step exists because selecting text is not a declaration
   * of intent: most selections are made to read or to copy, and a panel that
   * goes straight to a composer treats every one of them as the start of a
   * comment. One builder rather than two, so a selection inside a sandboxed
   * frame is offered exactly what a selection on this origin is.
   */
  const showOffer = (offered: {
    readonly target: CommentAnchor;
    readonly anchorBox: AnchorBox;
    readonly text: string;
    readonly canCopy: boolean;
    readonly deselect: () => void;
  }): void => {
    const surface = host;
    if (surface === undefined) return;
    const panel: HTMLElement = selectionOffer({
      text: offered.text,
      canCopy: offered.canCopy,
      onCopy: () => {
        void (async () => {
          if (await copyText(offered.text)) {
            dismiss();
            return;
          }
          // The clipboard is refused often enough to matter, and claiming a
          // copy that did not happen leaves the reader pasting whatever they
          // copied an hour ago. The selection is still live, so the keyboard
          // route still works and the panel says so.
          const note = document.createElement('p');
          note.className = 'popover-note';
          note.textContent = COPY_FAILED_NOTE;
          panel.appendChild(note);
          positionPanel(panel, offered.anchorBox, surface);
        })();
      },
      onComment: () => {
        // Captured when the panel appeared rather than re-read on click, so
        // what gets anchored is what the reader was offered.
        if (deps.compose?.(offered.target, offered.anchorBox) === true) {
          dismiss();
          return;
        }
        aim(offered.target);
      },
      onCancel: () => {
        dismiss();
        offered.deselect();
      },
    });
    surface.appendChild(panel);
    positionPanel(panel, offered.anchorBox, surface);
    bubble = panel;
  };

  /** Offers a target for a settled selection, and offers nothing otherwise. */
  const offer = (): void => {
    const surface = host;
    if (surface === undefined) return;
    const selection = window.getSelection();
    if (
      selection === null ||
      selection.isCollapsed ||
      selection.rangeCount === 0
    ) {
      dismiss();
      return;
    }
    const range = selection.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer)) {
      dismiss();
      return;
    }
    const quote = selection.toString().trim();
    if (quote.length === 0) {
      dismiss();
      return;
    }
    // Captured before the bubble is built, and the bubble is only offered if
    // it succeeded. A button that anchors to a position the reader did not
    // select is worse than no button: the chip names their words either way,
    // so the only place the difference shows is the mark, after posting.
    const target = captureSelectionQuote(surface, range, selection);
    if (target === null) {
      dismiss();
      return;
    }

    dismiss();
    const rect = range.getBoundingClientRect();
    const box = surface.getBoundingClientRect();
    // Content coordinates, not viewport ones: the stage scrolls its own
    // children, so an offset measured against the visible box would leave the
    // panel behind the moment the reader scrolls.
    showOffer({
      target,
      anchorBox: anchorFromClientRect(rect, box, surface),
      text: quote,
      canCopy: true,
      deselect: () => {
        window.getSelection()?.removeAllRanges();
      },
    });

    // Keyboard and sidebar affordance
    const qa = document.createElement('button');
    qa.type = 'button';
    qa.className = 'mark-quote-action';
    qa.textContent = 'Quote selection';
    const shortQuote =
      quote.length > 24 ? `${quote.slice(0, 24).trimEnd()}…` : quote;
    qa.setAttribute('aria-label', `Quote "${shortQuote}"`);
    qa.addEventListener('click', () => {
      aim(target);
    });
    tools.appendChild(qa);
    quoteAction = qa;
  };

  /** Places a point, but only for a click the reader armed the tool for. */
  const place = (event: MouseEvent): void => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const surface = host;
    if (surface === undefined || !armed()) return;
    if (!(event.target instanceof Element)) return;
    // An existing mark, the bubble and the conversation are controls. Only the
    // document itself takes a point.
    if (
      event.target.closest(
        '.comment-pin, .comment-region, .mark-bubble, .thread'
      )
    ) {
      return;
    }
    const rect = surface.getBoundingClientRect();
    const fraction = pinFraction(
      {
        left: rect.left,
        top: rect.top,
        scrollLeft: surface.scrollLeft,
        scrollTop: surface.scrollTop,
        scrollWidth: surface.scrollWidth,
        scrollHeight: surface.scrollHeight,
      },
      event.clientX,
      event.clientY
    );
    // A click the stage cannot place leaves the tool armed, because nothing
    // was placed and disarming would read as though something had been.
    if (fraction === undefined) return;
    aim({ kind: 'pin', ...fraction });
  };

  const onMouseDown = (event: MouseEvent): void => {
    if (!armed()) return;
    if (!(event.target instanceof Element)) return;
    if (
      event.target.closest(
        '.comment-pin, .comment-region, .mark-bubble, .thread'
      )
    ) {
      return;
    }
    if (host === undefined) return;
    const surface = anchorSurfaceFor(host);
    if (surface === undefined || !isImageElement(surface.content)) return;

    const start = unitFromPointer(surface, event.clientX, event.clientY);
    if (start === undefined) {
      // Pressed outside the image content box (in the letterbox). Do not start
      // a drag so that clicks in the letterbox never clamp to the picture.
      return;
    }

    dragOrigin = {
      clientX: event.clientX,
      clientY: event.clientY,
      unit: start,
    };
    isDragging = false;
    suppressClick = false;
    // Prevent default browser image dragging so mousemove tracks smoothly:
    event.preventDefault();
  };

  const onMouseMove = (event: MouseEvent): void => {
    if (dragOrigin === undefined || host === undefined) return;
    const surface = anchorSurfaceFor(host);
    if (surface === undefined) return;

    const dx = event.clientX - dragOrigin.clientX;
    const dy = event.clientY - dragOrigin.clientY;
    if (!isDragging && Math.hypot(dx, dy) >= 4) {
      isDragging = true;
      suppressClick = true;
    }
    if (!isDragging) return;

    if (drawingBox === undefined) {
      drawingBox = document.createElement('div');
      drawingBox.className = 'comment-region is-drawing is-pending';
      host.appendChild(drawingBox);
    }

    const current = unitFromPointer(surface, event.clientX, event.clientY);
    if (current === undefined) {
      drawingBox.style.display = 'none';
      return;
    }

    const rect = rectFromCorners(
      dragOrigin.unit,
      current,
      unitMinimumForPixels(surface, MIN_REGION_PX) ?? 0.005
    );
    if (rect === undefined) {
      drawingBox.style.display = 'none';
      return;
    }

    const box = boxFromUnit(surface, rect);
    if (box === undefined) {
      drawingBox.style.display = 'none';
      return;
    }

    drawingBox.style.display = 'block';
    drawingBox.style.left = `${box.left}px`;
    drawingBox.style.top = `${box.top}px`;
    drawingBox.style.width = `${box.width}px`;
    drawingBox.style.height = `${box.height}px`;
  };

  const onMouseUp = (event: MouseEvent): void => {
    if (dragOrigin === undefined || host === undefined) return;
    const wasDragging = isDragging;
    const start = dragOrigin.unit;
    dragOrigin = undefined;
    isDragging = false;
    drawingBox?.remove();
    drawingBox = undefined;

    if (wasDragging) {
      suppressClick = true;
      const surface = anchorSurfaceFor(host);
      if (surface === undefined) return;
      const current = unitFromPointer(surface, event.clientX, event.clientY);
      // A drag ending in the letterbox outside the image must not silently
      // clamp onto the picture; it produces no anchor and leaves the tool armed.
      if (current === undefined) return;
      const rect = rectFromCorners(
        start,
        current,
        unitMinimumForPixels(surface, MIN_REGION_PX) ?? 0.005
      );
      if (rect === undefined) return;
      aim({ kind: 'region', rect });
    }
  };
  const onTouchStart = (event: TouchEvent): void => {
    if (!armed()) return;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (!touch || !(event.target instanceof Element)) return;
    if (
      event.target.closest(
        '.comment-pin, .comment-region, .mark-bubble, .thread'
      )
    ) {
      return;
    }
    if (host === undefined) return;
    const surface = anchorSurfaceFor(host);
    if (surface === undefined || !isImageElement(surface.content)) return;

    const start = unitFromPointer(surface, touch.clientX, touch.clientY);
    if (start === undefined) return;

    dragOrigin = {
      clientX: touch.clientX,
      clientY: touch.clientY,
      unit: start,
    };
    isDragging = false;
    suppressClick = false;
  };

  const onTouchMove = (event: TouchEvent): void => {
    if (dragOrigin === undefined || host === undefined) return;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (!touch) return;
    const surface = anchorSurfaceFor(host);
    if (surface === undefined) return;

    const dx = touch.clientX - dragOrigin.clientX;
    const dy = touch.clientY - dragOrigin.clientY;
    if (!isDragging && Math.hypot(dx, dy) >= 6) {
      isDragging = true;
      suppressClick = true;
    }
    if (!isDragging) return;

    // Prevent touch scrolling while actively dragging a region on the image:
    event.preventDefault();

    if (drawingBox === undefined) {
      drawingBox = document.createElement('div');
      drawingBox.className = 'comment-region is-drawing is-pending';
      host.appendChild(drawingBox);
    }

    const current = unitFromPointer(surface, touch.clientX, touch.clientY);
    if (current === undefined) {
      drawingBox.style.display = 'none';
      return;
    }

    const rect = rectFromCorners(
      dragOrigin.unit,
      current,
      unitMinimumForPixels(surface, MIN_REGION_PX) ?? 0.005
    );
    if (rect === undefined) {
      drawingBox.style.display = 'none';
      return;
    }

    const box = boxFromUnit(surface, rect);
    if (box === undefined) {
      drawingBox.style.display = 'none';
      return;
    }

    drawingBox.style.display = 'block';
    drawingBox.style.left = `${box.left}px`;
    drawingBox.style.top = `${box.top}px`;
    drawingBox.style.width = `${box.width}px`;
    drawingBox.style.height = `${box.height}px`;
  };

  const onTouchEnd = (event: TouchEvent): void => {
    if (dragOrigin === undefined || host === undefined) return;
    const wasDragging = isDragging;
    const start = dragOrigin.unit;
    dragOrigin = undefined;
    isDragging = false;
    drawingBox?.remove();
    drawingBox = undefined;

    if (wasDragging) {
      suppressClick = true;
      const touch = event.changedTouches[0];
      if (!touch) return;
      const surface = anchorSurfaceFor(host);
      if (surface === undefined) return;
      const current = unitFromPointer(surface, touch.clientX, touch.clientY);
      if (current === undefined) return;
      const rect = rectFromCorners(
        start,
        current,
        unitMinimumForPixels(surface, MIN_REGION_PX) ?? 0.005
      );
      if (rect === undefined) return;
      aim({ kind: 'region', rect });
    }
  };

  // Bound to the document once, here rather than in `attach`, because a
  // comparison closing rebuilds the stage and attaches again: listeners added
  // there would accumulate one copy per visit.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      if (spanStart !== null) {
        disarmSpan();
        return;
      }
      if (
        armed() ||
        keyboardBox !== undefined ||
        bubble !== undefined ||
        isDragging
      ) {
        cancelAiming();
        return;
      }
      if (anchor !== null) {
        clear();
      }
      return;
    }

    if (!armed()) return;

    const surface = host;
    if (surface === undefined) return;
    const s = anchorSurfaceFor(surface);
    const content = s?.content ?? surface;
    const isImg =
      content.tagName === 'IMG' || surface.querySelector('img') !== null;

    if (isImg && keyboardRect !== undefined) {
      let handled = false;
      const step = 0.05;
      if (event.shiftKey) {
        if (event.key === 'ArrowRight') {
          keyboardRect.w = Math.min(1 - keyboardRect.x, keyboardRect.w + step);
          handled = true;
        } else if (event.key === 'ArrowLeft') {
          keyboardRect.w = Math.max(0.05, keyboardRect.w - step);
          handled = true;
        } else if (event.key === 'ArrowDown') {
          keyboardRect.h = Math.min(1 - keyboardRect.y, keyboardRect.h + step);
          handled = true;
        } else if (event.key === 'ArrowUp') {
          keyboardRect.h = Math.max(0.05, keyboardRect.h - step);
          handled = true;
        }
      } else {
        if (event.key === 'ArrowRight') {
          keyboardRect.x = Math.min(1 - keyboardRect.w, keyboardRect.x + step);
          handled = true;
        } else if (event.key === 'ArrowLeft') {
          keyboardRect.x = Math.max(0, keyboardRect.x - step);
          handled = true;
        } else if (event.key === 'ArrowDown') {
          keyboardRect.y = Math.min(1 - keyboardRect.h, keyboardRect.y + step);
          handled = true;
        } else if (event.key === 'ArrowUp') {
          keyboardRect.y = Math.max(0, keyboardRect.y - step);
          handled = true;
        }
      }

      if (handled) {
        event.preventDefault();
        if (keyboardBox && s) {
          const box = boxFromUnit(s, keyboardRect);
          if (box) {
            keyboardBox.style.left = `${box.left}px`;
            keyboardBox.style.top = `${box.top}px`;
            keyboardBox.style.width = `${box.width}px`;
            keyboardBox.style.height = `${box.height}px`;
          }
        }
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        aim({ kind: 'region', rect: { ...keyboardRect } });
        return;
      }
    } else if (!isImg) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        aim({ kind: 'pin', x: 0.5, y: 0.5 });
        return;
      }
    }
  };

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('selectionchange', () => {
    const live = window.getSelection();
    if (live === null || live.isCollapsed) dismiss();
  });

  paintChip();

  return {
    chip,
    tools,
    target: () => anchor,
    clear,
    attach: (next) => {
      const stageChanged = host !== next;
      if (stageChanged) {
        dismiss();
        disarm();
        teardownStage?.();
        teardownStage = undefined;
        disarmSpan();
        host = next;
      }

      if (
        next.querySelector('.doc-download') !== null ||
        next.classList?.contains?.('stage-download') ||
        (next.querySelector('.notice') !== null &&
          next.querySelector('.doc, img, video, audio, canvas, iframe') ===
            null)
      ) {
        mode = undefined;
        timeMode = undefined;
        tools.replaceChildren();
        return;
      }

      // Hoisted because the listener binding below needs it too, and unlike
      // the page canvas a frame is present the moment the stage is built:
      // `sandboxFrame` creates the iframe synchronously, so there is no late
      // arrival to wait for here.
      const isFramed = next.querySelector('iframe.usercontent-frame') !== null;

      /**
       * Build the row from the artifact that is on the page right now.
       *
       * Wrapped in a function rather than run once, because one of these
       * artifacts mounts after `attach` does. The PDF renderer is a lazily
       * imported chunk, deliberately, so that readers of every other class
       * do not download it; the consequence is that at attach time there is
       * no page canvas and a row decided here would describe a stage that
       * has not finished rendering. That is not a race to tolerate, it is
       * the normal case for that class.
       */
      const describeTools = (): void => {
        const isImg = next.querySelector('img.relic-image') !== null;
        const isPdf = next.querySelector('canvas.relic-page') !== null;
        const media = next.querySelector(
          'video.relic-media, audio.relic-media, video, audio'
        ) as HTMLMediaElement | null;

        if (next.querySelector('.otio-view') !== null) {
          mode = undefined;
          timeMode = undefined;
          const hint = document.createElement('span');
          hint.className = 'thread-hint';
          hint.textContent = 'Point or range on a named track';
          tools.replaceChildren(hint);
        } else if (isFramed) {
          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'mark-mode';
          toggle.textContent = 'Point at something';
          toggle.setAttribute('aria-pressed', 'false');
          toggle.addEventListener('click', () => {
            if (armed()) disarm();
            else arm();
          });
          mode = toggle;

          const framedHint = document.createElement('span');
          framedHint.className = 'thread-hint';
          framedHint.textContent = 'Select text inside document to quote';
          tools.replaceChildren(toggle, framedHint);
        } else if (media !== null) {
          const isAudio = media.tagName === 'AUDIO';
          const timeToggle = document.createElement('button');
          timeToggle.type = 'button';
          timeToggle.className = 'mark-mode mark-time';
          timeToggle.textContent = isAudio
            ? 'Comment on this moment'
            : 'Comment on this frame';
          timeToggle.setAttribute('aria-pressed', 'false');
          timeToggle.addEventListener('click', () => {
            disarm();
            const t = media.currentTime;
            if (typeof media.pause === 'function') {
              media.pause();
            }
            if (spanStart === null) {
              spanStart = t;
              timeToggle.setAttribute('aria-pressed', 'true');
              timeToggle.textContent = 'Mark end of span';
              aim({ kind: 'time', t }, true);
              const said = document.createElement('p');
              said.className = 'mark-hint mark-time-hint';
              said.setAttribute('aria-live', 'polite');
              said.textContent = isAudio
                ? 'Play, seek, or scrub to mark the end of the span, or press Escape to keep this moment.'
                : 'Play, seek, or scrub to mark the end of the span, or press Escape to keep this frame.';
              next.appendChild(said);
              timeHint = said;
            } else {
              const tEnd = t;
              if (tEnd !== spanStart) {
                const start = Math.min(spanStart, tEnd);
                const end = Math.max(spanStart, tEnd);
                aim({ kind: 'time', t: start, t_end: end });
              } else {
                aim({ kind: 'time', t: spanStart });
              }
              disarmSpan();
            }
          });
          timeMode = timeToggle;
          mode = undefined;
          // Audio gets only time mode; video gets time mode. No text hints or broken point controls.
          tools.replaceChildren(timeToggle);
        } else if (isImg) {
          timeMode = undefined;
          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'mark-mode mark-region';
          toggle.textContent = 'Mark a region or point';
          toggle.setAttribute('aria-pressed', 'false');
          toggle.addEventListener('click', () => {
            if (armed()) disarm();
            else arm();
          });
          mode = toggle;
          // Images carry no text to select, so only the region/point control is offered.
          tools.replaceChildren(toggle);
        } else if (isPdf) {
          timeMode = undefined;
          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'mark-mode mark-page';
          toggle.textContent = 'Mark on page';
          toggle.setAttribute('aria-pressed', 'false');
          toggle.addEventListener('click', () => {
            if (armed()) disarm();
            else arm();
          });
          mode = toggle;
          const pdfHint = document.createElement('span');
          pdfHint.className = 'thread-hint';
          pdfHint.textContent = 'Drag a box on the page to mark an area';
          tools.replaceChildren(toggle, pdfHint);
        } else {
          timeMode = undefined;
          const toggle = document.createElement('button');
          toggle.type = 'button';
          toggle.className = 'mark-mode mark-pin';
          toggle.textContent = 'Point at something';
          toggle.setAttribute('aria-pressed', 'false');
          toggle.addEventListener('click', () => {
            if (armed()) disarm();
            else arm();
          });
          mode = toggle;

          const textHint = document.createElement('span');
          textHint.className = 'thread-hint';
          textHint.textContent = 'Select text in document to quote';
          tools.replaceChildren(toggle, textHint);
        }
      };

      /**
       * Which artifacts are on the stage, as a comparable string.
       *
       * The row is rebuilt only when this changes, and that condition is not
       * an optimisation. Arming appends a hint and a keyboard box into the
       * stage, so an observer that reacted to any subtree mutation rebuilt
       * the row in response to its own controls: the fresh toggle came back
       * with `aria-pressed="false"`, `armed()` then read false, and every
       * arrow key was dropped by the handler's own guard. Arming looked
       * correct on screen, with the crosshair and the keyboard box both
       * visible, and did nothing.
       */
      const artifacts = (): string =>
        [
          'iframe.usercontent-frame',
          'img.relic-image',
          'canvas.relic-page',
          'video.relic-media',
          'audio.relic-media',
          '.otio-view',
        ]
          .filter((selector) => next.querySelector(selector) !== null)
          .join(',');

      // `attach` runs again on every repaint, and a repaint happens while a
      // reader is aiming: the resize observer fires as the keyboard box is
      // sized. Rebuilding the row then replaces the toggle that `arm` had
      // just marked pressed, so `mode` ends up on an orphaned button and
      // `armed()` reads false while the stage still shows the crosshair, the
      // hint, and the keyboard box. Arming looked correct and every arrow key
      // was dropped by the handler's own guard.
      //
      // So the row is rebuilt only when the artifacts it describes change.
      // The signature is stored on the element rather than in a closure,
      // because each `attach` call makes a fresh closure and a fresh closure
      // remembers nothing.
      const signature = artifacts();
      if (next.dataset.markTools !== signature) {
        next.dataset.markTools = signature;
        describeTools();
      }
      // Watches for an artifact that mounts after the stage does, which for a
      // pdf relic is the normal case rather than a race. Disconnected with
      // the stage: an observer outliving the subtree it watches leaks on
      // every navigation.
      if (typeof MutationObserver !== 'undefined') {
        lateArtifact?.disconnect();
        lateArtifact = new MutationObserver(() => {
          const now = artifacts();
          if (next.dataset.markTools === now) return;
          next.dataset.markTools = now;
          describeTools();
        });
        lateArtifact.observe(next, { childList: true, subtree: true });
      }

      // Repaint on resize and on image load so unit-coordinate regions update
      // whenever the content box dimensions change.
      const updateKeyboardBox = (): void => {
        if (keyboardBox !== undefined && keyboardRect !== undefined) {
          const s = anchorSurfaceFor(host ?? next);
          if (s) {
            const box = boxFromUnit(s, keyboardRect);
            if (box) {
              keyboardBox.style.left = `${box.left}px`;
              keyboardBox.style.top = `${box.top}px`;
              keyboardBox.style.width = `${box.width}px`;
              keyboardBox.style.height = `${box.height}px`;
            }
          }
        }
      };

      // Repaint on resize and on image load so unit-coordinate regions update
      // whenever the content box dimensions change.
      const onResize = (): void => {
        updateKeyboardBox();
        deps.repaint();
      };
      window.addEventListener('resize', onResize);

      let ro: ResizeObserver | undefined;
      if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => {
          updateKeyboardBox();
          deps.repaint();
        });
        ro.observe(next);
        const surface = anchorSurfaceFor(next);
        if (surface !== undefined && surface.content !== next) {
          ro.observe(surface.content);
        }
      }

      const img = next.querySelector('img.relic-image');
      let onImgLoad: (() => void) | undefined;
      if (isImageElement(img) && 'complete' in img && !img.complete) {
        onImgLoad = (): void => {
          updateKeyboardBox();
          deps.repaint();
        };
        img.addEventListener('load', onImgLoad);
      }

      // Teardown verified: every listener attached to window, ResizeObserver,
      // or image is tracked here and cleaned up when the stage is replaced or
      // controls are cleared, preventing memory leaks across relic navigation.
      teardownStage = (): void => {
        window.removeEventListener('resize', onResize);
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
        next.removeEventListener?.(
          'touchstart',
          onTouchStart as unknown as EventListener
        );
        next.removeEventListener?.(
          'touchmove',
          onTouchMove as unknown as EventListener
        );
        next.removeEventListener?.(
          'touchend',
          onTouchEnd as unknown as EventListener
        );
        ro?.disconnect();
        lateArtifact?.disconnect();
        lateArtifact = undefined;
        if (onImgLoad && img && typeof img.removeEventListener === 'function') {
          img.removeEventListener('load', onImgLoad);
        }
        drawingBox?.remove();
        drawingBox = undefined;
        dragOrigin = undefined;
        isDragging = false;
        suppressClick = false;
      };

      if (next.dataset.markBind !== '1') {
        next.dataset.markBind = '1';
        // Three ways a selection settles, because a selection made with the
        // keyboard or a finger is the same act as one made with a mouse and a
        // pointer-only offer silently excludes both. These are additive to the
        // drag handlers below: `afterSelection` offers nothing when the
        // selection is collapsed, which is the state a drag leaves behind.
        // Pointer gestures on the stage only. Inside a framed document
        // they never reach this origin, and binding them anyway would let a
        // drag in the margin around the frame produce a region anchor
        // measured against the wrong box.
        if (!isFramed) {
          next.addEventListener('mouseup', () => {
            afterSelection(offer);
          });
        }
        next.addEventListener('keyup', () => {
          afterSelection(offer);
        });
        next.addEventListener('touchend', () => {
          afterSelection(offer);
        });
        next.addEventListener('click', place);
        next.addEventListener('mousedown', onMouseDown);
        next.addEventListener('mousemove', onMouseMove);
        next.addEventListener('mouseup', onMouseUp);
        next.addEventListener(
          'touchstart',
          onTouchStart as unknown as EventListener,
          {
            passive: true,
          }
        );
        next.addEventListener(
          'touchmove',
          onTouchMove as unknown as EventListener,
          {
            passive: false,
          }
        );
        next.addEventListener(
          'touchend',
          onTouchEnd as unknown as EventListener
        );
      }
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);

      // The four the shim sends outward. They can only originate in the
      // frame, so they need no framed guard of their own.
      next.addEventListener('relic:frame-selection', ((
        event: CustomEvent<FrameSelectionMessage>
      ) => {
        const msg = event.detail;
        if (!msg?.exact || msg.exact.trim().length === 0) return;
        const target: CommentAnchor = {
          kind: 'quote',
          exact: msg.exact.trim(),
          ...(msg.prefix ? { prefix: msg.prefix } : {}),
          ...(msg.suffix ? { suffix: msg.suffix } : {}),
        };
        const frame = event.target;
        dismiss();
        if (msg.rect === undefined || !(frame instanceof HTMLElement)) {
          // No geometry to draw over, which is what every framed selection
          // looked like before the frame reported boxes. The sidebar takes
          // it, exactly as it did then.
          aim(target);
          return;
        }
        showOffer({
          target,
          anchorBox: frameAnchorBox(frame, msg.rect, next),
          // The mark's quote is capped at 512 bytes, so copying it would
          // hand back less than was selected without saying so. The frame
          // sends the whole selection separately, and when it could not,
          // Copy is not offered rather than offered as a prefix.
          text: msg.text ?? msg.exact,
          canCopy: msg.text !== undefined && msg.truncated !== true,
          // The selection lives in the other origin and there is no message
          // for reaching in to clear it. Taking the panel down is the whole
          // of what this side can do.
          deselect: () => {},
        });
      }) as EventListener);
      next.addEventListener('relic:frame-selection-cleared', () => {
        dismiss();
      });
      next.addEventListener('relic:frame-point', ((
        event: CustomEvent<FramePointMessage>
      ) => {
        if (!armed()) return;
        const msg = event.detail;
        if (!msg) return;
        // A point, exactly as a click places one on any other stage. It used
        // to be a box three hundredths of the document on each side, which on
        // a long document is a strip hundreds of pixels tall.
        aim({ kind: 'pin', x: msg.x, y: msg.y });
      }) as EventListener);
      next.addEventListener('relic:frame-region', ((
        event: CustomEvent<FrameRegionMessage>
      ) => {
        if (!armed()) return;
        if (event.detail?.rect) {
          aim({ kind: 'region', rect: event.detail.rect });
        }
      }) as EventListener);
      next.addEventListener('relic:frame-mark-click', ((
        event: CustomEvent<FrameMarkClickMessage>
      ) => {
        if (!event.detail?.id) return;
        const row = document.querySelector(
          `[data-comment-id="${event.detail.id}"]`
        );
        if (row instanceof HTMLElement) {
          deps.open();
          row.scrollIntoView({ block: 'nearest' });
        }
      }) as EventListener);
      // A moment or a span on the scrubber. Written in a panel over the
      // scrubber, exactly as a selection is written over the words, and
      // handed to the sidebar only when the page cannot compose here.
      const aimTemporal = ((
        event: CustomEvent<TimeAimDetail | OtioAimDetail>
      ) => {
        const detail = event.detail;
        if (!detail?.anchor) return;
        const focus = detail.focus ?? true;
        const reanchor = (): AnchorBox | undefined => {
          const measured = detail.measure?.();
          if (measured === undefined) return undefined;
          return anchorFromClientRect(
            measured,
            next.getBoundingClientRect(),
            next
          );
        };
        const box = reanchor();
        if (
          box !== undefined &&
          deps.compose?.(detail.anchor, box, { focus, reanchor }) === true
        ) {
          dismiss();
          return;
        }
        // The sidebar is where an address is verified, and it cannot be
        // seen from inside fullscreen, so a reader sent there is brought
        // back out first. An adjustment of a span already drawn only moves
        // the target and leaves the reader where they are.
        if (focus) {
          leaveStageFullscreen(next, () => {
            aim(detail.anchor, false, true);
          });
          return;
        }
        aim(detail.anchor, false, false);
      }) as EventListener;
      next.addEventListener('relic:time-aim', aimTemporal);
      next.addEventListener('relic:otio-aim', aimTemporal);

      // A box on a rendered page. Self-guarding on a `canvas.relic-page`
      // target, so it costs nothing on the classes that have no pages.
      let dragStart: { readonly x: number; readonly y: number } | null = null;
      let dragPage = 1;
      let isDragging = false;

      next.addEventListener('pointerdown', (event: PointerEvent) => {
        if (armed()) return;
        const target = event.target;
        if (
          !(target instanceof HTMLCanvasElement) ||
          !target.classList.contains('relic-page')
        ) {
          return;
        }
        const surface = anchorSurfaceFor(next);
        if (surface === undefined) return;
        const point = unitFromPointer(surface, event.clientX, event.clientY);
        if (point === undefined) return;
        dragStart = point;
        const pageAttr = target.dataset['pageNumber'];
        dragPage = pageAttr !== undefined ? Number.parseInt(pageAttr, 10) : 1;
        isDragging = false;
      });

      next.addEventListener('pointermove', (event: PointerEvent) => {
        if (dragStart === null) return;
        const surface = anchorSurfaceFor(next);
        if (surface === undefined) return;
        const current = unitFromPointer(surface, event.clientX, event.clientY);
        if (current === undefined) return;
        const rect = rectFromCorners(
          dragStart,
          current,
          unitMinimumForPixels(surface, MIN_REGION_PX) ?? 0.005
        );
        if (rect !== undefined) {
          isDragging = true;
          anchor = { kind: 'page', page: dragPage, rect };
          paintChip();
          deps.repaint();
        }
      });

      const finishDrag = (event: PointerEvent): void => {
        if (dragStart === null) return;
        const wasDragging = isDragging;
        const start = dragStart;
        dragStart = null;
        isDragging = false;
        if (!wasDragging) return;
        const surface = anchorSurfaceFor(next);
        if (surface === undefined) return;
        const current = unitFromPointer(surface, event.clientX, event.clientY);
        const rect =
          current !== undefined
            ? rectFromCorners(
                start,
                current,
                unitMinimumForPixels(surface, MIN_REGION_PX) ?? 0.005
              )
            : undefined;
        if (rect !== undefined) {
          aim({ kind: 'page', page: dragPage, rect });
        }
      };

      next.addEventListener('pointerup', finishDrag);
      next.addEventListener('pointercancel', () => {
        dragStart = null;
        isDragging = false;
      });
    },
  };
}

function stampedCommentVersion(entry: CommentEntry): number | null {
  const version = entry.version;
  return typeof version === 'number' &&
    Number.isSafeInteger(version) &&
    version > 0
    ? version
    : null;
}

/**
 * OTIO coordinates are sealed inside the body, while the service stamps the
 * row's revision. They must agree before either one can place or fetch media.
 */
function sealedOtioAnchorMatchesEntryVersion(entry: CommentEntry): boolean {
  if (entry.kind !== 'open' || entry.anchor?.kind !== 'otio') return false;
  const version = stampedCommentVersion(entry);
  return version !== null && entry.anchor.relic_version === version;
}

function visibleOtioEntryAtVersion(
  entry: CommentEntry,
  viewedVersion: number
): boolean {
  const version = stampedCommentVersion(entry);
  if (version === null) return viewedVersion === 1;
  return sealedOtioAnchorMatchesEntryVersion(entry)
    ? version <= viewedVersion
    : version === viewedVersion;
}

/**
 * The thread, in the service-origin chrome.
 *
 * It cannot live in the render frame and this is not a preference: the frame
 * is network denied, `default-src 'none'` with sandbox exactly
 * `allow-scripts`, so it could not fetch a comment if it tried. The chrome
 * around it can, and it is also the only side of the boundary that holds the
 * key the bodies are sealed under.
 */
export function buildThread(
  view: ReadyView,
  relicId: string,
  deps: ViewerDeps,
  onCount: (count: number) => void,
  onViewOriginal?: (version: number) => void
): ThreadHandle {
  const section = document.createElement('aside');
  section.className = 'thread';
  section.id = 'comment-thread';
  section.setAttribute('aria-labelledby', 'thread-title');

  const title = document.createElement('h2');
  title.className = 'thread-title';
  title.id = 'thread-title';
  const toggle = document.createElement('button');
  toggle.className = 'thread-toggle';
  toggle.type = 'button';
  toggle.textContent = 'Comments';
  toggle.setAttribute('aria-controls', section.id);
  toggle.setAttribute('aria-expanded', 'false');
  title.appendChild(toggle);

  // The divider lives in the row rather than in the sidebar, because the
  // sidebar scrolls and a divider that scrolled away with the conversation
  // would be a control that disappears while it is being used.
  const resizer = document.createElement('div');
  resizer.className = 'thread-resizer';
  resizer.setAttribute('role', 'separator');
  resizer.setAttribute('aria-orientation', 'vertical');
  resizer.setAttribute('aria-label', 'Resize the comments');
  resizer.tabIndex = 0;

  // The one entry that survives every width. The taskbar control leaves the
  // row at the 320px floor, and a reader on a phone still has to get in.
  const tab = document.createElement('button');
  tab.className = 'thread-tab';
  tab.type = 'button';
  tab.textContent = 'Comments';
  tab.setAttribute('aria-controls', section.id);
  tab.setAttribute('aria-expanded', 'false');

  const status = document.createElement('div');
  status.className = 'thread-status';
  // Polite: a comment arriving is worth announcing and never worth
  // interrupting what is being read.
  status.setAttribute('aria-live', 'polite');

  const list = document.createElement('ol');
  list.className = 'thread-list';

  const composer = document.createElement('div');
  composer.className = 'compose-slot';

  // Outcomes live outside the composer, so repainting the composer after a
  // lapsed session does not throw away the sentence explaining why.
  const outcome = document.createElement('div');
  outcome.className = 'thread-outcome';
  outcome.setAttribute('aria-live', 'polite');

  // The aiming controls, built here because two places carry a piece of them:
  // what a comment is about belongs in the composer, and arming the pin tool
  // belongs in the sidebar beside the conversation it will join.
  const marks = buildMarkControls({
    open: () => {
      setOpen(true);
    },
    focusBody: () => {
      // Absent for a reader who has not verified an address yet, and that is
      // the state the chip exists for: the target is announced even when
      // there is nothing yet to type it into.
      const box = composer.querySelector('.compose-textarea');
      if (box instanceof HTMLElement) box.focus();
    },
    repaint: () => {
      // The entries it already has, because the target changed and the
      // conversation did not. Refetching the thread to redraw one provisional
      // mark would put a network round trip behind a text selection.
      paintMarks(lastEntries);
    },
    compose: (anchor, box, options) => {
      // Refused rather than half-offered when there is no identity yet:
      // verifying one is the sidebar's flow, and the caller falls back to it.
      if (host === undefined || popover === undefined) return false;
      if (session.kind !== 'verified' || cipher === undefined) return false;
      openComposer(anchor, box, options);
      return true;
    },
  });

  section.append(title, marks.tools, status, list, composer, outcome);

  // The one place the in-memory fragment is already carried on a ready view.
  // Reading it back from here rather than adding a second copy to `ReadyView`
  // keeps the number of places holding key material at one.
  const fragment = new URL(view.shareUrl).hash;

  let cipher: CommentCipher | undefined;
  let session: SessionState = { kind: 'unknown' };
  let host: HTMLElement | undefined;
  let lastEntries: readonly CommentEntry[] = [];
  const originalViews = new Map<number, Promise<ReadyView | undefined>>();
  const projectionAttempts = new Set<string>();
  const projectionFailures = new Set<string>();

  const addOtioFeedbackContext = (
    row: HTMLElement,
    entry: CommentEntry
  ): void => {
    if (entry.kind !== 'open' || entry.anchor?.kind !== 'otio') return;
    const anchor = entry.anchor;
    const context = document.createElement('div');
    context.className = 'otio-feedback-projection';
    const label = document.createElement('span');
    if (!sealedOtioAnchorMatchesEntryVersion(entry)) {
      context.dataset['projectionStatus'] = 'unresolvable';
      label.textContent =
        'This OTIO target is unresolvable because its sealed revision is not ' +
        'bound to the version recorded with the comment.';
      context.append(label);
      row.appendChild(context);
      return;
    }
    const target = document.createElement('p');
    target.className = 'otio-feedback-target';
    target.textContent = markTargetLabel(anchor);
    if (anchor.track_id !== null) {
      const track = document.createElement('span');
      track.textContent = anchor.track_id;
      target.appendChild(track);
    }
    row.querySelector('.comment-body')?.before(target);
    if (anchor.relic_version === view.version) return;
    const projection =
      host === undefined
        ? undefined
        : otioControllerFor(host)?.projection(anchor);
    context.dataset['projectionStatus'] =
      projection?.status ??
      (projectionFailures.has(entry.id) ? 'unavailable' : 'loading');
    label.textContent = `Earlier feedback · v${anchor.relic_version} → v${view.version} · ${
      projection?.status ??
      (projectionFailures.has(entry.id)
        ? 'Original context unavailable'
        : 'Loading original version')
    }`;
    const original = document.createElement('button');
    original.type = 'button';
    original.className = 'otio-view-original';
    original.textContent = 'View original';
    original.addEventListener('click', (event) => {
      event.stopPropagation();
      onViewOriginal?.(anchor.relic_version);
    });
    context.append(label, original);
    row.appendChild(context);
  };

  const projectEarlierOtioFeedback = async (entries: readonly CommentEntry[]): Promise<void> => {
    if (host === undefined) return;
    const controller = otioControllerFor(host);
    if (controller === undefined) return;
    let changed = false;
    await Promise.all(entries.map(async (entry) => {
      if (
        entry.kind !== 'open' ||
        entry.anchor?.kind !== 'otio' ||
        !sealedOtioAnchorMatchesEntryVersion(entry) ||
        entry.anchor.relic_version === view.version ||
        projectionAttempts.has(entry.id)
      ) {
        return;
      }
      projectionAttempts.add(entry.id);
      const anchor = entry.anchor;
      try {
        let original = originalViews.get(anchor.relic_version);
        if (original === undefined) {
          original = loadHistoricalVersion(relicId, anchor.relic_version, view, deps)
            .then((result) => result.kind === 'ready' ? result.view : undefined);
          originalViews.set(anchor.relic_version, original);
        }
        const originalView = await original;
        if (originalView === undefined) throw new Error('Original context unavailable');
        await controller.project(anchor, originalView.content);
      } catch {
        projectionFailures.add(entry.id);
      }
      changed = true;
    }));
    if (changed && host !== undefined && otioControllerFor(host) === controller) {
      paintMarks(lastEntries);
      rerenderRows?.();
    }
  };
  /**
   * Comment ids whose mark is real but has nowhere to land on this page.
   *
   * Two causes, one reader-visible consequence: a kind this build has no
   * adapter for, and a quote the current version of the relic no longer
   * contains. The thread says so on the row, because a comment that appears
   * to point at nothing is worse than one that says where it pointed.
   */
  const unplaceable = new Set<string>();
  /** Puts the width where the sidebar and the divider both read it. */
  const applyWidth = (width: number): number => {
    const clamped = Math.round(clampThreadWidth(width, window.innerWidth));
    document.documentElement.style.setProperty(
      '--thread-width',
      `${clamped}px`
    );
    return clamped;
  };
  applyWidth(readThreadWidth() ?? THREAD_DEFAULT_WIDTH);

  const setOpen = (open: boolean): void => {
    section.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    tab.setAttribute('aria-expanded', String(open));
    if (open) toggle.focus({ preventScroll: true });
  };
  const toggleOpen = (): void => {
    setOpen(!section.classList.contains('is-open'));
  };
  toggle.addEventListener('click', toggleOpen);
  tab.addEventListener('click', toggleOpen);

  // Pointer capture, so a drag that outruns the divider keeps arriving here
  // instead of being swallowed by whatever it crossed.
  resizer.addEventListener('pointerdown', (event) => {
    const row = resizer.parentElement;
    if (row === null) return;
    event.preventDefault();
    const right = row.getBoundingClientRect().right;
    resizer.setPointerCapture(event.pointerId);
    let width = section.getBoundingClientRect().width;
    const move = (moved: PointerEvent): void => {
      width = applyWidth(right - moved.clientX);
    };
    const done = (): void => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', done);
      resizer.removeEventListener('pointercancel', done);
      writeThreadWidth(width);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', done);
    resizer.addEventListener('pointercancel', done);
  });

  // A divider that only answers a pointer is a divider a keyboard cannot
  // reach, and this one is in the tab order.
  resizer.addEventListener('keydown', (event) => {
    const step =
      event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0;
    if (step === 0) return;
    event.preventDefault();
    writeThreadWidth(applyWidth(section.getBoundingClientRect().width + step));
  });

  const paintMarks = (entries: readonly CommentEntry[]): void => {
    lastEntries = entries;
    if (host === undefined) return;
    unwrapTextQuotes(host);
    host.querySelector('.comment-pins')?.remove();
    otioControllerFor(host)?.clearMarks();
    host
      .querySelector<HTMLIFrameElement>('iframe.usercontent-frame')
      ?.contentWindow?.postMessage({ type: 'relic:clear-marks' }, '*');
    const pins = document.createElement('div');
    pins.className = 'comment-pins';
    let number = 0;
    // Ids whose mark could not be placed on this page, so the thread can say
    // so on the row instead of showing a comment that appears to point at
    // nothing. Rebuilt every pass, because whether a mark lands depends on
    // the content currently rendered.
    unplaceable.clear();
    for (const entry of entries) {
      if (entry.kind !== 'open' || entry.anchor === null) continue;
      if (
        entry.anchor.kind === 'otio' &&
        !sealedOtioAnchorMatchesEntryVersion(entry)
      ) {
        continue;
      }
      number += 1;
      if (entry.anchor.kind === 'text') {
        wrapTextQuote(host, entry.anchor.quote, entry.id);
        continue;
      }
      if (entry.anchor.kind === 'pin') {
        // A framed relic draws its own pins, inside the frame that scrolls.
        const surface = anchorSurfaceFor(host);
        const framed =
          surface === undefined ? undefined : adapterFor(entry.anchor, surface);
        if (surface !== undefined && framed !== undefined) {
          if (!framed.paint(surface, pins, entry.anchor, entry.id)) {
            unplaceable.add(entry.id);
          }
          continue;
        }
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'comment-pin';
        pin.textContent = String(number);
        // Addressable, so hovering the pin can light its comment. Posted pins
        // and marks now carry the same key, which is what lets one pairing
        // handler serve both shapes.
        pin.dataset.commentId = entry.id;
        const offsets = pinOffsets(entry.anchor, host);
        pin.style.left = `${offsets.left}px`;
        pin.style.top = `${offsets.top}px`;
        pin.title = entry.body;
        pin.addEventListener('click', (event) => {
          event.preventDefault();
          setOpen(true);
          const row = list.querySelector(`[data-comment-id="${entry.id}"]`);
          if (row instanceof HTMLElement) {
            row.scrollIntoView({ block: 'nearest' });
          }
        });
        pins.appendChild(pin);
        continue;
      }
      // Every precise kind, through its adapter. A kind with no adapter
      // registered, or one whose mark has nowhere to land because the relic
      // was republished, leaves the comment in the thread and marks the row
      // as unplaceable rather than dropping either.
      const surface = anchorSurfaceFor(host);
      const adapter =
        surface === undefined ? undefined : adapterFor(entry.anchor, surface);
      const placed =
        adapter !== undefined &&
        surface !== undefined &&
        adapter.paint(surface, pins, entry.anchor, entry.id);
      if (!placed) unplaceable.add(entry.id);
    }
    paintPendingMark(host, pins, marks.target());
    host.appendChild(pins);

    // After every mark is painted rather than during, because a text mark is
    // wrapped into the document and a region is appended to the overlay, and
    // only one pass sees both. A settled remark stays visible and goes
    // quiet: hiding it would make the page claim a conversation that did
    // not happen.
    const settled: string[] = [];
    for (const entry of entries) {
      if (entry.id === null) continue;
      if ((entry.resolution ?? null) === null) continue;
      settled.push(entry.id);
      for (const node of host.querySelectorAll(
        `[data-comment-id="${entry.id}"]`
      )) {
        node.classList.add('is-resolved');
      }
    }
    // The frame owns the marks inside it, so the fact that a comment is
    // settled has to cross the boundary. The whole list every time, because
    // a resolution can be undone.
    host
      .querySelector<HTMLIFrameElement>('iframe.usercontent-frame')
      ?.contentWindow?.postMessage(
        { type: 'relic:quiet-marks', ids: settled },
        '*'
      );
    void projectEarlierOtioFeedback(entries);
  };

  /**
   * Lights a comment and the thing it points at, together.
   *
   * A thread and a document are two views of one set of remarks, and without
   * this the reader has to hold the pairing in their head: the sidebar says
   * what was said and the page says where, and nothing joins them.
   */
  const pair = (id: string | undefined, on: boolean): void => {
    if (host === undefined) return;
    const selector = id === undefined ? null : `[data-comment-id="${id}"]`;
    if (selector === null) return;
    for (const root of [host, list]) {
      for (const found of root.querySelectorAll(selector)) {
        found.classList.toggle('is-active', on);
      }
    }
  };

  // Delegated rather than bound per row and per mark, because both are
  // replaced wholesale on every repaint and a listener attached to the old
  // element would light nothing at all.
  const bindPairing = (root: HTMLElement): void => {
    const enter = (event: Event): void => {
      if (!(event.target instanceof Element)) return;
      pair(
        event.target.closest<HTMLElement>('[data-comment-id]')?.dataset
          .commentId,
        true
      );
    };
    const leave = (event: Event): void => {
      if (!(event.target instanceof Element)) return;
      pair(
        event.target.closest<HTMLElement>('[data-comment-id]')?.dataset
          .commentId,
        false
      );
    };
    root.addEventListener('mouseover', enter);
    root.addEventListener('mouseout', leave);
    // A pin is a button, so it is in the tab order. Pairing on focus keeps a
    // keyboard reader from being the only one who cannot see the join.
    root.addEventListener('focusin', enter);
    root.addEventListener('focusout', leave);
  };

  // --- the conversation, opened on the thing it is about ----------------

  let popover: PopoverLayer | undefined;
  /** The comment whose card is pinned open, as opposed to merely hovered. */
  let stickyId: string | undefined;
  let activeId: string | undefined;
  // The global timers rather than the ones hanging off `window`: a browser
  // gives you the same function either way, and the test's window stub is
  // deliberately partial, so reaching through it makes a real behaviour
  // depend on how completely the harness imitates a browser.
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The new comment being written in the open panel, while there is one.
   *
   * Held apart from the panel because its target can move under it: a
   * reader who drags the end of a span, or draws a new one, while the
   * composer holds a sentence gets the target moved and the sentence kept.
   */
  let composing:
    | {
        anchor: CommentAnchor;
        readonly panel: HTMLElement;
        readonly target: HTMLElement;
        readonly field: HTMLTextAreaElement;
      }
    | undefined;
  /** Measures the open panel's target again, after the page moves under it. */
  let reanchor: (() => AnchorBox | undefined) | undefined;
  /**
   * Draws the thread's rows again from the last load, without fetching.
   *
   * A time mark cannot be placed until the media knows its duration, so the
   * first paint, which runs before the metadata arrives, counts every time
   * comment as unplaceable. The adapter paints them itself once the metadata
   * lands and says so with `relic-repaint`; the rows have to hear it too, or
   * each one goes on saying its mark cannot be shown while the mark sits on
   * the scrubber.
   */
  let rerenderRows: (() => void) | undefined;

  const frameWindow = (): Window | null =>
    host?.querySelector<HTMLIFrameElement>('iframe.usercontent-frame')
      ?.contentWindow ?? null;

  /**
   * Lights one mark and its row, and puts out the last one.
   *
   * The frame is told separately because it owns the marks inside it and
   * this origin cannot reach into them. Without that message, clicking a
   * comment about text in a sandboxed relic scrolls to a mark that looks
   * like every other mark.
   */
  const setActiveMark = (id: string | undefined): void => {
    // Idempotent, and that is load bearing rather than tidy. The frame
    // answers an active mark with its geometry so a row press can open the
    // card over it, and re-announcing the same mark on the way would put
    // the two origins in a loop.
    if (activeId === id) return;
    if (activeId !== undefined) pair(activeId, false);
    activeId = id;
    if (id !== undefined) pair(id, true);
    frameWindow()?.postMessage(
      { type: 'relic:active-mark', id: id ?? null },
      '*'
    );
  };

  /**
   * The composer is gone, so whatever it was aimed at is no longer a target.
   *
   * A moment or a span is painted on the scrubber by the player rather than
   * by `paintMarks`, so the player is told. Leaving it painted would show a
   * target that nothing on the page is going to post to.
   */
  const dropComposing = (): void => {
    const held = composing;
    if (held === undefined) return;
    composing = undefined;
    if (held.anchor.kind === 'time' && host !== undefined) {
      tellPlayer(host, 'relic:time-selection-cleared');
    }
  };

  const closeCard = (): void => {
    clearTimeout(hoverTimer);
    clearTimeout(leaveTimer);
    popover?.hide();
    stickyId = undefined;
    reanchor = undefined;
    dropComposing();
    setActiveMark(undefined);
  };

  /**
   * Where a painted mark sits, in the stage's content coordinates.
   *
   * The first match that is laid out rather than the first match. A comment
   * inside a cluster on the timeline is carried by a hidden element, for
   * pairing, and painted by the cluster around it; the open card carries the
   * id as well and is never the thing it points at.
   */
  const anchorBoxFor = (id: string): AnchorBox | undefined => {
    if (host === undefined) return undefined;
    let fallback: HTMLElement | undefined;
    for (const node of host.querySelectorAll<HTMLElement>(
      `[data-comment-id="${id}"]`
    )) {
      if (node.closest('.popover') !== null) continue;
      const painted =
        node.closest<HTMLElement>('[data-cluster-members]') ?? node;
      fallback ??= painted;
      const rect = painted.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        return anchorFromClientRect(rect, host.getBoundingClientRect(), host);
      }
    }
    if (fallback === undefined) return undefined;
    return anchorFromClientRect(
      fallback.getBoundingClientRect(),
      host.getBoundingClientRect(),
      host
    );
  };

  const entryById = (id: string): CommentEntry | undefined =>
    lastEntries.find((entry) => entry.id === id);

  /**
   * The card, built from the same renderer the sidebar uses.
   *
   * Two renderings of one comment drift until the same remark reads
   * differently depending on where it was seen, so the row is built by
   * `commentRow` here exactly as it is there and only the surroundings
   * differ.
   */
  const openCard = (
    entry: CommentEntry,
    box: AnchorBox,
    sticky: boolean
  ): void => {
    if (host === undefined || entry.id === null) return;
    const layer = popover;
    if (layer === undefined) return;
    clearTimeout(leaveTimer);
    // The card takes the panel, so a composer that held it is over.
    dropComposing();

    const nodes = threadEntries(lastEntries);
    const node = nodes.find((candidate) => candidate.entry.id === entry.id);
    const replies = (node?.replies ?? []).map((reply) =>
      commentRow(reply.entry, false, undefined, [], true)
    );
    const rows = document.createElement('ol');
    rows.className = 'popover-thread';
    const row = commentRow(entry, unplaceable.has(entry.id), undefined, replies, false);
    addOtioFeedbackContext(row, entry);
    rows.appendChild(row);

    const id = entry.id;
    const actions: PopoverAction[] = [];
    const reopen = (): void => {
      const fresh = entryById(id);
      const at = anchorBoxFor(id) ?? box;
      if (fresh !== undefined) openCard(fresh, at, true);
      else closeCard();
    };

    actions.push({
      label: 'Reply',
      className: 'popover-reply',
      onSelect: () => {
        stickyId = id;
        if (session.kind !== 'verified' || cipher === undefined) {
          // Replying needs an identity, verifying one needs the magic-link
          // flow, and that flow lives in the sidebar. Saying so beats a
          // field nobody could post from.
          setOpen(true);
          const note = document.createElement('p');
          note.className = 'popover-note';
          note.textContent =
            'Verify an address in the comments panel, then reply here.';
          layer.current()?.appendChild(note);
          layer.reposition();
          return;
        }
        const composer = inlineComposer({
          placeholder: `Reply to ${plainLabel(entry.author ?? 'this comment')}`,
          submitLabel: 'Post reply',
          onCancel: reopen,
          onSubmit: (body) => {
            const opener = cipher;
            if (opener === undefined) return;
            composer.setBusy(true);
            void (async () => {
              const result = await postComment(
                relicId,
                {
                  body,
                  display_name: readDisplayName() || null,
                  // A reply answers a comment that already carries a mark,
                  // so it does not get one of its own. The thread nests it
                  // under what it answers.
                  anchor: null,
                  addresses: id,
                },
                deps,
                opener,
                view.version
              );
              if (result.kind === 'refused') {
                composer.setBusy(false);
                composer.setNote(result.refusal.headline);
                return;
              }
              await refresh();
              reopen();
            })();
          },
        });
        layer.current()?.appendChild(composer.element);
        layer.reposition();
        composer.field.focus();
      },
    });

    if (canEditComment(entry, session) && entry.kind === 'open') {
      actions.push({
        label: 'Edit',
        className: 'popover-edit',
        onSelect: () => {
          stickyId = id;
          const target = document.createElement('p');
          target.className = 'popover-target';
          target.textContent = markTargetLabel(entry.anchor);
          const panel = popoverCard({
            content: target,
            actions: [],
            commentId: id,
          });
          const composer = inlineComposer({
            placeholder: 'What it should say instead',
            submitLabel: 'Save',
            value: entry.body,
            disclosure: 'Editing replaces the text. No earlier copy is kept.',
            onCancel: reopen,
            onSubmit: (body) => {
              const opener = cipher;
              if (opener === undefined) return;
              composer.setBusy(true);
              void (async () => {
                const result = await editComment(
                  relicId,
                  id,
                  {
                    body,
                    display_name: entry.displayName,
                    // Carried forward rather than rebuilt. An edit changes
                    // what a remark says and never where it points, and
                    // moving the mark would leave every reply answering
                    // something the reader can no longer see.
                    anchor: entry.anchor,
                    addresses: entry.addresses ?? null,
                  },
                  deps,
                  opener
                );
                if (result.kind === 'refused') {
                  composer.setBusy(false);
                  composer.setNote(result.refusal.headline);
                  return;
                }
                await refresh();
                reopen();
              })();
            },
          });
          panel.appendChild(composer.element);
          layer.show(panel, box);
          composer.field.focus();
        },
      });
    }

    if (canResolveComment(entry, session)) {
      const settled = (entry.resolution ?? null) !== null;
      actions.push({
        label: settled ? 'Reopen' : 'Resolve',
        className: 'popover-resolve',
        onSelect: () => {
          stickyId = id;
          void (async () => {
            const result = await setCommentResolved(
              relicId,
              id,
              !settled,
              deps
            );
            if (result.kind === 'refused') {
              const note = document.createElement('p');
              note.className = 'popover-note';
              note.textContent = result.refusal.headline;
              layer.current()?.appendChild(note);
              layer.reposition();
              return;
            }
            await refresh();
            reopen();
          })();
        },
      });
    }

    actions.push({
      label: 'Open in thread',
      className: 'popover-open-thread',
      kind: 'quiet',
      onSelect: () => {
        closeCard();
        const surface = host;
        const show = (): void => {
          setOpen(true);
          const row = list.querySelector(`[data-comment-id="${id}"]`);
          if (row instanceof HTMLElement)
            row.scrollIntoView({ block: 'nearest' });
          setActiveMark(id);
        };
        // The thread is in the sidebar, which a fullscreen stage hides, so
        // asking for it from a card in fullscreen brings the page back.
        if (surface === undefined) show();
        else leaveStageFullscreen(surface, show);
      },
    });

    const card = popoverCard({ content: rows, actions, commentId: id });
    holdOnHover(card);
    layer.show(card, box);
    reanchor = () => anchorBoxFor(id);
    if (sticky) stickyId = id;
    setActiveMark(id);
  };

  /**
   * Crossing the gap from a mark into its own card must not close it, and
   * the pointer leaving both must. Bound on the card rather than tracked
   * globally, because the card is replaced on every state change.
   */
  const holdOnHover = (card: HTMLElement): void => {
    card.addEventListener('mouseenter', () => {
      clearTimeout(leaveTimer);
    });
    card.addEventListener('mouseleave', () => {
      if (stickyId !== undefined) return;
      leaveTimer = setTimeout(closeCard, MARK_HOVER_CLOSE_MS);
    });
  };

  /**
   * Several comments that sit too close on the timeline to tell apart.
   *
   * A list that leads to each one's own card, rather than every thread
   * stacked in one panel, because each card already carries its own reply,
   * edit and resolve. A stack would need those per thread or lose them, and
   * a list keeps every comment one press away.
   */
  const openClusterCard = (
    ids: readonly string[],
    box: AnchorBox,
    sticky: boolean
  ): void => {
    const layer = popover;
    if (host === undefined || layer === undefined) return;
    const members = ids
      .map((id) => entryById(id))
      .filter((entry): entry is CommentEntry => entry !== undefined);
    const first = members[0];
    const firstId = first?.id;
    if (first === undefined || firstId === null || firstId === undefined) {
      return;
    }
    clearTimeout(leaveTimer);
    dropComposing();

    const firstAnchor = first.kind === 'open' ? first.anchor : null;
    const label =
      firstAnchor?.kind === 'time'
        ? `${members.length} comments around ${formatTimecode(firstAnchor.t)}`
        : `${members.length} comments here`;
    const heading = document.createElement('p');
    heading.className = 'popover-target';
    heading.textContent = label;

    const list = document.createElement('ol');
    list.className = 'popover-members';
    for (const member of members) {
      const memberId = member.id;
      if (memberId === null) continue;
      const anchor = member.kind === 'open' ? member.anchor : null;
      // Tenths, because these sit close enough to have clustered, and in
      // whole seconds most of them read as the same time.
      const when =
        anchor?.kind !== 'time'
          ? ''
          : anchor.t_end === undefined
            ? formatTimecodeTenths(anchor.t)
            : `${formatTimecodeTenths(anchor.t)} to ${formatTimecodeTenths(anchor.t_end)}`;
      const who =
        member.kind === 'open' && member.displayName !== null
          ? member.displayName
          : (member.author ?? '');
      const said =
        member.kind === 'open'
          ? member.body.replace(/\s+/g, ' ').trim()
          : 'This comment did not decrypt.';

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'popover-member';
      pick.dataset['memberId'] = memberId;
      const time = document.createElement('span');
      time.className = 'popover-member-time';
      time.textContent = when;
      const author = document.createElement('span');
      author.className = 'popover-member-author';
      author.textContent = plainLabel(who);
      const body = document.createElement('span');
      body.className = 'popover-member-body';
      body.textContent = plainLabel(said);
      pick.append(time, author, body);
      pick.addEventListener('click', (event) => {
        event.preventDefault();
        // The cluster's own press went to its first member's moment. This
        // one is a choice of member, so it goes to that member's.
        const surface = host === undefined ? undefined : anchorSurfaceFor(host);
        if (surface !== undefined && anchor !== null) {
          adapterFor(anchor, surface)?.reveal?.(surface, anchor);
        }
        openCard(member, anchorBoxFor(memberId) ?? box, true);
      });
      const item = document.createElement('li');
      item.appendChild(pick);
      list.appendChild(item);
    }

    const wrapper = document.createElement('div');
    wrapper.append(heading, list);
    const card = popoverCard({ content: wrapper, actions: [] });
    card.setAttribute('aria-label', label);
    holdOnHover(card);
    layer.show(card, box);
    reanchor = () => anchorBoxFor(firstId);
    if (sticky) stickyId = firstId;
    setActiveMark(firstId);
  };

  /**
   * Writing a new comment on the thing it is about.
   *
   * The sidebar composer stays: it is where a remark about the whole
   * document is written and where an address is verified. This one exists
   * because a reader who has just selected a sentence, or pressed a moment
   * on the timeline, is looking at it, and asking them to cross the page to
   * say something about it is how a mark ends up on the wrong line.
   *
   * A time composer that is already open is re-aimed rather than rebuilt:
   * dragging the end of the span, or drawing a new one, moves the target and
   * the panel and never touches the sentence being typed.
   */
  const openComposer = (
    anchor: CommentAnchor,
    box: AnchorBox,
    options: ComposeOptions = {}
  ): void => {
    const layer = popover;
    const opener = cipher;
    if (layer === undefined || opener === undefined) return;
    const focus = options.focus ?? true;

    const held = composing;
    if (
      held !== undefined &&
      layer.current() === held.panel &&
      ((held.anchor.kind === 'time' && anchor.kind === 'time') ||
       (held.anchor.kind === 'otio' && anchor.kind === 'otio'))
    ) {
      held.anchor = anchor;
      held.target.textContent = markTargetLabel(anchor);
      layer.show(held.panel, box);
      reanchor = options.reanchor;
      if (focus) held.field.focus();
      return;
    }

    closeCard();

    const target = document.createElement('p');
    target.className = 'popover-target';
    target.textContent = markTargetLabel(anchor);
    const panel = popoverCard({ content: target, actions: [] });

    const composer = inlineComposer({
      placeholder: 'What is wrong with this, or what should change.',
      submitLabel: 'Post',
      disclosure: IDENTITY_DISCLOSURE,
      onCancel: () => {
        closeCard();
        window.getSelection()?.removeAllRanges();
      },
      onSubmit: (body) => {
        composer.setBusy(true);
        // Read at the press rather than captured at the open, because the
        // target of a time composer can have moved since.
        const aimed = state.anchor;
        void (async () => {
          const result = await postComment(
            relicId,
            {
              body,
              display_name: readDisplayName() || null,
              anchor: aimed,
            },
            deps,
            opener,
            view.version
          );
          if (result.kind === 'refused') {
            composer.setBusy(false);
            composer.setNote(result.refusal.headline);
            return;
          }
          // The chip goes back to the whole document, because the target it
          // was holding has been spent. Leaving it aimed would put the next
          // comment on the last thing selected. A moment or a span never
          // went through the chip, and clearing it would also put focus in
          // the sidebar, which a fullscreen stage cannot even show.
          if (aimed.kind !== 'time' && aimed.kind !== 'otio') marks.clear();
          window.getSelection()?.removeAllRanges();
          closeCard();
          await refresh();
        })();
      },
    });
    panel.appendChild(composer.element);
    const state = { anchor, panel, target, field: composer.field };
    layer.show(panel, box);
    composing = state;
    reanchor = options.reanchor;
    // Held open against hover, because a composer that vanished when the
    // pointer wandered would take the sentence being typed with it.
    stickyId = COMPOSING;
    if (focus) composer.field.focus();
  };

  /** Opens the card for a mark the reader is pointing at, by id. */
  const cardForId = (
    id: string,
    box: AnchorBox | undefined,
    sticky: boolean
  ): void => {
    // A press on a mark is not a reason to throw away what somebody is
    // typing in the open panel, and nothing here could give it back.
    if (holdsUnsavedText()) return;
    const entry = entryById(id);
    if (entry === undefined) return;
    const at = box ?? anchorBoxFor(id);
    if (at === undefined) return;
    openCard(entry, at, sticky);
  };

  /**
   * The card for whatever mark the pointer or the focus landed on: one
   * comment's, or the list for a cluster of them on the timeline.
   */
  const cardForMark = (mark: HTMLElement, sticky: boolean): void => {
    const members = (mark.dataset['clusterMembers'] ?? '')
      .split(' ')
      .filter((member) => member.length > 0);
    const first = members[0];
    if (members.length > 1 && first !== undefined) {
      if (holdsUnsavedText()) return;
      const at = anchorBoxFor(first);
      if (at !== undefined) openClusterCard(members, at, sticky);
      return;
    }
    const id = mark.dataset['commentId'];
    if (id !== undefined) cardForId(id, undefined, sticky);
  };

  const bindMarkPointing = (root: HTMLElement): void => {
    root.addEventListener('mouseover', (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const mark = event.target.closest<HTMLElement>('[data-comment-id]');
      if (mark === null || stickyId !== undefined) return;
      clearTimeout(leaveTimer);
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        // Asked again when the delay runs out, not only when it starts. A
        // drag across the timeline passes over markers on its way to the
        // release that opens a composer, and a hover that began before the
        // composer must not replace it after.
        if (stickyId !== undefined) return;
        cardForMark(mark, false);
      }, MARK_HOVER_OPEN_MS);
    });
    root.addEventListener('mouseout', (event: Event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('[data-comment-id]') === null) return;
      if (stickyId !== undefined) return;
      clearTimeout(hoverTimer);
      leaveTimer = setTimeout(closeCard, MARK_HOVER_CLOSE_MS);
    });
    // A pin and a timeline marker are buttons, so they are in the tab order.
    // A keyboard reader gets the card the same way a pointer does.
    root.addEventListener('focusin', (event: Event) => {
      if (!(event.target instanceof Element)) return;
      // Focus moving inside an open card is the reader using it: the field
      // a Reply just put up, or the next button along. The card carries its
      // comment's id, so without this the focus rebuilt the card around it
      // and threw away the reply before a word of it was typed.
      if (event.target.closest('.popover') !== null) return;
      const mark = event.target.closest<HTMLElement>('[data-comment-id]');
      if (mark === null) return;
      cardForMark(mark, true);
    });
    root.addEventListener('click', (event: Event) => {
      if (!(event.target instanceof Element)) return;
      // Asked of the element rather than of the open panel, because a
      // control inside a panel routinely replaces that panel: pressing
      // Comment takes the offer down and puts a composer up in the same
      // handler. A browser computes the propagation path before dispatch,
      // so this listener still receives that press, by which time the
      // element it came from is detached and no open panel contains it.
      // Asking `popover.contains` alone therefore closed the composer the
      // press had just opened.
      if (event.target.closest('.popover') !== null) return;
      if (popover?.contains(event.target) === true) return;
      const mark = event.target.closest<HTMLElement>('[data-comment-id]');
      // Closing is not handled here. A press lands on the sidebar, the
      // taskbar or the page around them as often as on the stage, and only
      // one of those reaches this listener, so the rule lives at the
      // document, where every press does.
      if (mark === null) return;
      event.preventDefault();
      cardForMark(mark, true);
    });
    root.addEventListener('relic:frame-mark-hover', ((
      event: CustomEvent<FrameMarkHoverMessage>
    ) => {
      const msg = event.detail;
      if (stickyId !== undefined) return;
      clearTimeout(hoverTimer);
      clearTimeout(leaveTimer);
      if (msg?.id === null || msg?.id === undefined) {
        leaveTimer = setTimeout(closeCard, MARK_HOVER_CLOSE_MS);
        return;
      }
      const frame = event.target;
      const id = msg.id;
      const box =
        msg.rect !== undefined &&
        frame instanceof HTMLElement &&
        host !== undefined
          ? frameAnchorBox(frame, msg.rect, host)
          : undefined;
      hoverTimer = setTimeout(() => {
        if (stickyId !== undefined) return;
        cardForId(id, box, false);
      }, MARK_HOVER_OPEN_MS);
    }) as EventListener);
    root.addEventListener('relic:frame-mark-click', ((
      event: CustomEvent<FrameMarkClickMessage>
    ) => {
      const msg = event.detail;
      if (!msg?.id) return;
      const frame = event.target;
      const box =
        msg.rect !== undefined &&
        frame instanceof HTMLElement &&
        host !== undefined
          ? frameAnchorBox(frame, msg.rect, host)
          : undefined;
      cardForId(msg.id, box, true);
    }) as EventListener);
  };

  // Escape closes the conversation the same way it closes the offer, because
  // a reader who has learned one has learned the other.
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape' && popover?.current() !== undefined) closeCard();
  });

  // A stage going into fullscreen or coming out of it moves whatever the
  // open panel points at, and changes where a panel can be seen at all. The
  // panel follows instead of closing, because it can be holding a sentence;
  // `show` on the open panel moves it, into the stage or back out of it,
  // with its text and its focus.
  document.addEventListener('fullscreenchange', () => {
    const layer = popover;
    const open = layer?.current();
    if (layer === undefined || open === undefined) return;
    const at = reanchor?.();
    if (at !== undefined) layer.show(open, at);
  });

  /** Text a reader typed and has not posted, anywhere in the open panel. */
  const holdsUnsavedText = (): boolean => {
    // Read by shape rather than by constructor: this is our own field, and
    // an `instanceof` here would answer false in any environment that does
    // not define the constructor, quietly turning the exception off.
    const field = popover?.current()?.querySelector('.popover-field') as
      | { value?: unknown }
      | null
      | undefined;
    const value = field?.value;
    return typeof value === 'string' && value.trim().length > 0;
  };

  /**
   * Pressing away from the conversation puts it down.
   *
   * On the document rather than on the stage, because a press lands
   * wherever the reader is looking: the sidebar, the taskbar, the margin.
   * A rule bound to the stage answered for one of those and left the card
   * open for every other.
   *
   * `pointerdown` rather than `click`, so the card goes before whatever the
   * press was for rather than after it.
   *
   * The one exception is a composer holding text. A reader who typed two
   * sentences and pressed the margin meant to press the margin, not to
   * throw the sentences away, and nothing here could give them back.
   */
  document.addEventListener('pointerdown', (event: Event) => {
    if (popover?.current() === undefined) return;
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('.popover') !== null) return;
    // A press on another mark is that mark's business: it opens its own
    // card, and closing here first would make the two fight.
    if (event.target.closest('[data-comment-id]') !== null) return;
    if (holdsUnsavedText()) return;
    closeCard();
  });

  bindPairing(list);
  list.addEventListener('click', (event: Event) => {
    if (!(event.target instanceof Element)) return;
    const row = event.target.closest<HTMLElement>('[data-comment-id]');
    if (row === null) return;
    const commentId = row.dataset['commentId'];
    if (commentId === undefined || host === undefined) return;
    const entry = lastEntries.find((e) => e.id === commentId);
    if (entry === undefined || entry.kind !== 'open' || entry.anchor === null) {
      return;
    }
    if (
      entry.anchor.kind === 'otio' &&
      !sealedOtioAnchorMatchesEntryVersion(entry)
    ) {
      return;
    }
    const surface = anchorSurfaceFor(host);
    if (surface === undefined) return;
    const adapter = adapterFor(entry.anchor, surface);
    adapter?.reveal?.(surface, entry.anchor);
    // Revealing answers "where", and lighting answers "which one". A reader
    // who clicked a row about one sentence in a paragraph of marked
    // sentences needs the second answer more than the first.
    setActiveMark(commentId);
    const box = anchorBoxFor(commentId);
    if (box !== undefined) openCard(entry, box, true);
  });

  const refresh = async (): Promise<void> => {
    if (typeof document === 'undefined') return;
    const opener = cipher;
    if (opener === undefined) return;
    status.replaceChildren(line('thread-note', THREAD_LOADING_NOTE));
    const state = await loadThread(relicId, deps, opener);
    // The fetch above can outlive the page that asked for it. In a browser
    // this is a navigation; under test it is teardown. Either way there is
    // nothing left to paint into, and painting is what throws.
    if (typeof document === 'undefined') return;
    if (state.kind === 'refused') {
      list.replaceChildren();
      status.replaceChildren(
        threadRefusal(state.refusal, () => {
          void refresh();
        })
      );
      return;
    }
    // Paint first, then build the rows. Which marks landed is only known
    // after the paint pass, and a row that has to say its mark could not be
    // placed cannot be built before that is decided.
    const viewedVersion = view.version;
    const isCurrentVersion = view.version === view.currentVersion;
    const hasHistory = view.currentVersion > 1;
    const filteredEntries = state.entries.filter((entry) => {
      // OTIO placement is eligible only when its sealed target is bound to the
      // service-stamped revision. A mismatch remains on that service revision
      // as unresolvable body text, never as a claimed historical coordinate.
      if (entry.kind === 'open' && entry.anchor?.kind === 'otio') {
        return visibleOtioEntryAtVersion(entry, viewedVersion);
      }
      // 1. When a relic has no version history (currentVersion <= 1), there is
      // no version dimension for a reader to navigate. Every comment shows
      // regardless of stored version so single-version relics never lose rows.
      if (!hasHistory) {
        return true;
      }

      // 2. Comments explicitly stamped with a version belong to that version
      // and show only when viewing it.
      if (entry.version !== null && entry.version !== undefined) {
        return entry.version === viewedVersion;
      }

      // 3. Comments carrying no version predate versioning. Their true version
      // is unknowable, so they cannot be claimed for any specific later version,
      // and the current or latest version must remain clean per Jason's rule.
      // Version 1 (the oldest version) is where they land so they remain
      // reachable without polluting newer revisions.
      return viewedVersion === 1;
    });

    const addressedMap = resolveAddressedMap(state.entries);
    const tree = threadEntries(filteredEntries);
    const displayedEntries = collectDisplayedEntries(tree);

    paintMarks(displayedEntries);

    const renderNode = (node: CommentNode, isReply = false): HTMLElement => {
      const replies = node.replies.map((child) => renderNode(child, true));
      const isUnplaceable =
        node.entry.id !== null && unplaceable.has(node.entry.id);
      const addressed =
        node.entry.id !== null ? addressedMap.get(node.entry.id) : null;
      const row = commentRow(node.entry, isUnplaceable, addressed, replies, isReply);
      addOtioFeedbackContext(row, node.entry);
      return row;
    };

    const renderRows = (): void => {
      list.replaceChildren(...tree.map((node) => renderNode(node)));
    };
    renderRows();
    rerenderRows = renderRows;
    updateThreadToggle(toggle, displayedEntries.length);
    status.replaceChildren(
      ...(displayedEntries.length === 0
        ? [
            line(
              'thread-note',
              isCurrentVersion
                ? THREAD_EMPTY_NOTE
                : `No comments on version ${viewedVersion}.`
            ),
          ]
        : [])
    );
    onCount(displayedEntries.length);
  };

  /** The address form, for a reader this browser has not verified. */
  const composeIdentity = (): HTMLElement => {
    const heading = document.createElement('h3');
    heading.className = 'compose-title';
    heading.textContent = 'Leave a comment';
    const { form } = signInForm(
      [
        heading,
        marks.chip,
        ...(session.kind === 'unknown'
          ? [line('thread-note', UNKNOWN_SESSION_NOTE)]
          : []),
        line('compose-note', IDENTITY_DISCLOSURE),
        policyLink(),
      ],
      { relicId, fragment, deps, outcome, label: 'Email address' }
    );
    form.className = 'compose';
    return form;
  };

  /** The comment form, for a verified reader. */
  const composeComment = (email: string): HTMLElement => {
    const form = document.createElement('form');
    form.className = 'compose';

    const heading = document.createElement('h3');
    heading.className = 'compose-title';
    heading.textContent = 'Leave a comment';

    const identity = document.createElement('p');
    identity.className = 'compose-identity';
    const address = document.createElement('strong');
    address.textContent = plainLabel(email);
    identity.append(document.createTextNode('Commenting as '), address);

    form.append(
      heading,
      identity,
      marks.chip,
      line('compose-note', IDENTITY_DISCLOSURE),
      policyLink()
    );

    const name = displayNameInput();
    form.appendChild(field('Display name', name));
    // The aside that used to inflate the identity disclosure into a
    // paragraph, said where it is actually a question.
    form.appendChild(line('compose-fine', DISPLAY_NAME_NOTE));

    const body = document.createElement('textarea');
    body.className = 'compose-textarea';
    body.rows = 4;
    body.required = true;
    form.appendChild(field('Comment', body));

    const foot = document.createElement('div');
    foot.className = 'compose-foot';

    const count = document.createElement('span');
    count.className = 'compose-count';
    const paintCount = (): void => {
      const used = utf8Bytes(body.value);
      // Bytes rather than characters, because the cap is on bytes and an
      // emoji costing four of them would otherwise be a surprise at submit.
      count.textContent = `${used} of ${MAX_BODY_BYTES} bytes`;
      count.classList.toggle('over', used > MAX_BODY_BYTES);
    };
    paintCount();
    body.addEventListener('input', paintCount);

    const post = document.createElement('button');
    post.type = 'submit';
    post.className = 'action primary';
    post.textContent = 'Post comment';

    foot.append(count, post);
    form.appendChild(foot);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const sealer = cipher;
      if (sealer === undefined) return;
      const draft = {
        body: body.value,
        display_name: name.value.trim().length > 0 ? name.value.trim() : null,
        anchor: marks.target(),
      };
      // The target is spent. Leaving it set would aim the reader's next
      // comment at the last thing they marked, which is the bug this whole
      // change exists to remove, one comment later.
      marks.clear();
      post.disabled = true;
      outcome.replaceChildren(line('thread-note', 'Encrypting and posting.'));
      void postComment(relicId, draft, deps, sealer, view.version).then(
        async (result) => {
          post.disabled = false;
          if (result.kind === 'refused') {
            outcome.replaceChildren(threadRefusal(result.refusal, () => {}));
            if (result.refusal.code === 'invalid_session') {
              session = { kind: 'anonymous' };
              composer.replaceChildren(composeIdentity());
            }
            return;
          }
          body.value = '';
          // The body is this comment's and goes. The name is the reader's and
          // stays, here and on the next relic they open.
          writeDisplayName(name.value);
          paintCount();
          outcome.replaceChildren(
            line(
              'thread-note',
              `Posted as ${plainLabel(result.author)}, which is what everybody ` +
                'holding this link now sees.'
            )
          );
          await refresh();
        }
      );
    });

    return form;
  };

  const paintComposer = (): void => {
    composer.replaceChildren(
      session.kind === 'verified'
        ? composeComment(session.email)
        : composeIdentity()
    );
  };

  /**
   * A magic link opened in another tab verifies this browser, not this tab.
   *
   * That is the common case rather than the edge: a mail client opens links
   * in its own tab, so the relic page that asked for the link is still
   * sitting there with its key in memory and no idea anything happened. Both
   * signals below are cheap and neither carries an address or a key.
   */
  const recheck = async (): Promise<void> => {
    if (cipher === undefined) return;
    const discovered = await readSession(deps);
    if (sessionSignature(discovered) === sessionSignature(session)) return;
    session = discovered;
    paintComposer();
  };

  const initialise = async (): Promise<void> => {
    status.replaceChildren(line('thread-note', THREAD_LOADING_NOTE));
    let key: Uint8Array;
    try {
      key = parseFragment(fragment).key;
    } catch {
      // Unreachable from a ready view, which exists only because the fragment
      // parsed. Caught rather than thrown because an error escaping here
      // would be an error object holding the fragment, and section 1.8 rules
      // that out.
      status.replaceChildren(
        threadRefusal(
          {
            code: 'no_comment_key',
            headline: 'Comments need the key from your link',
            detail:
              'Comment text is sealed under a key derived from the one in ' +
              'this link, and this page does not have it.',
            retryable: false,
          },
          () => {}
        )
      );
      return;
    }
    cipher = commentCipher(await deriveCommentKey(key));
    const [, discovered] = await Promise.all([refresh(), readSession(deps)]);
    if (typeof document === 'undefined') return;
    session = discovered;
    paintComposer();
    if (
      discovered.kind === 'verified' &&
      typeof BroadcastChannel === 'function'
    ) {
      // Tells whichever tab asked for the link that it can stop waiting. The
      // message is a bare marker: no address, and certainly no key.
      const channel = new BroadcastChannel('relic:auth');
      channel.postMessage('verified');
      channel.close();
    }
  };

  if (typeof BroadcastChannel === 'function') {
    new BroadcastChannel('relic:auth').addEventListener('message', () => {
      void recheck();
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void recheck();
  });

  // Exposed rather than fired and forgotten. A caller that tears its page
  // down while this is in flight gets the continuation painting into a
  // document that no longer exists, which is exactly what happened in CI:
  // two unhandled `document is not defined` errors between test files, from
  // a thread whose fetch outlived the test that started it.
  const ready = initialise();
  void ready;

  return {
    element: section,
    tab,
    resizer,
    ready,
    toggle: toggleOpen,
    attach: (next) => {
      host = next;
      popover = popoverLayer(next);
      // Once per stage. A second binding would toggle the class twice on one
      // pointer crossing, which reads as the pairing not working at all.
      if (next.dataset.pairBind !== '1') {
        next.dataset.pairBind = '1';
        bindPairing(next);
        bindMarkPointing(next);
        next.addEventListener('relic:page-changed', () => {
          paintMarks(lastEntries);
        });
        next.addEventListener('relic:frame-ready', () => {
          paintMarks(lastEntries);
        });
        next.addEventListener('relic:otio-ready', () => {
          paintMarks(lastEntries);
          rerenderRows?.();
        });
        // Time marks wait for the media's duration. When it arrives they
        // land, and the rows that said they could not are drawn again.
        next.addEventListener('relic-repaint', () => {
          paintMarks(lastEntries);
          rerenderRows?.();
        });
        // A bare press on the scrubber seeks, and the player drops its
        // pending selection when it does. While a composer is still aimed at
        // a moment, that moment stays painted, so the scrubber and the
        // panel never disagree about what the comment is about.
        next.addEventListener('relic:time-selection-cleared', () => {
          const held = composing;
          if (held === undefined || held.anchor.kind !== 'time') return;
          if (popover?.current() !== held.panel) return;
          tellPlayer(next, 'relic:time-selection', held.anchor);
        });
      }
      paintMarks(lastEntries);
      marks.attach(next);
    },
  };
}

/** The rendered relic, which is also the surface the marks are painted on. */
export function buildStageWrap(
  view: ReadyView,
  usercontentOrigin: string
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'stage-wrap';
  wrap.appendChild(buildCurrentStage(view, usercontentOrigin));
  return wrap;
}

/**
 * The relic beside its conversation.
 *
 * Reading and commenting happen together, so the sidebar takes width from the
 * row rather than covering the relic or sitting under it. The relic reflows
 * narrower, which is the whole point: a comment is written next to the line it
 * is about, while that line is still on the screen.
 *
 * Order matters. The divider and the edge tab follow the sidebar so the
 * stylesheet can hide each of them from the sidebar's own state with a
 * sibling selector, rather than asking the row to carry a second copy of it.
 */
export function buildRelicRow(
  stage: HTMLElement,
  sidebar?: HTMLElement,
  resizer?: HTMLElement,
  tab?: HTMLElement
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'relic-row';
  row.appendChild(stage);
  if (sidebar !== undefined) row.appendChild(sidebar);
  if (resizer !== undefined) row.appendChild(resizer);
  if (tab !== undefined) row.appendChild(tab);
  return row;
}

/* ---------- the share panel ---------- */

export interface SharePanelHandle {
  readonly element: HTMLElement;
  /** Settles when the session has been read and the first state painted. */
  readonly ready: Promise<void>;
  /**
   * Settles when the share request in flight, if any, has painted its answer.
   * Exposed for the same reason `ThreadHandle.ready` is: a caller that tears
   * the page down mid-request leaves a continuation with nowhere to paint.
   */
  readonly idle: () => Promise<void>;
  readonly close: () => void;
}

/**
 * The Share action's sheet, for any reader holding the link and its key.
 *
 * It walks one errand: the comment sign-in when there is no session, the
 * addresses, a request carrying a proof derived from the key (never the key),
 * and then the email, composed here and sent from the reader's own mail. The
 * two facts a sharer is owed, that Relic never sends that email and that it
 * keeps the addresses in the clear to tell them about new versions, are said
 * before anything is typed rather than after.
 */
export function openSharePanel(
  view: ReadyView,
  relicId: string,
  deps: ViewerDeps,
  opener?: HTMLElement
): SharePanelHandle {
  // The one place the in-memory fragment is already carried, as the thread
  // reads it, so there is still exactly one copy of the key on the view.
  const fragment = new URL(view.shareUrl).hash;

  const dialog = document.createElement('dialog');
  dialog.className = 'share-panel';
  dialog.setAttribute('aria-labelledby', 'share-title');

  const head = document.createElement('div');
  head.className = 'share-head';
  const title = document.createElement('h2');
  title.className = 'share-title';
  title.id = 'share-title';
  title.tabIndex = -1;
  title.textContent = 'Share this relic';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'share-close';
  dismiss.setAttribute('aria-label', 'Close');
  dismiss.appendChild(icon(ICONS.close));
  head.append(title, dismiss);

  const body = document.createElement('div');
  body.className = 'share-body';
  dialog.append(head, body);

  let session: SessionState = { kind: 'unknown' };
  let checking = true;
  let draft = '';
  let shared: Shared | undefined;
  /** A refusal about the relic itself, after which the form is not offered. */
  let ended: Refusal | undefined;
  /** Why the sign-in step is back, when a session lapsed mid-errand. */
  let lapsed: Refusal | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let open = true;
  let channel: BroadcastChannel | undefined;

  const facts = (): HTMLElement[] => {
    const box = document.createElement('div');
    box.className = 'compose-note share-facts';
    box.append(line('', SHARE_FACT_SENDING), line('', SHARE_FACT_STORING));
    return [box, policyLink()];
  };

  const outcomeSlot = (): HTMLElement => {
    const outcome = document.createElement('div');
    outcome.className = 'share-outcome';
    outcome.setAttribute('aria-live', 'polite');
    return outcome;
  };

  /** The sign-in step, as the composer has it, with sharing's reason. */
  const paintSignIn = (): HTMLElement => {
    const outcome = outcomeSlot();
    if (lapsed !== undefined) body.appendChild(threadRefusal(lapsed, () => {}));
    body.appendChild(line('thread-note', SHARE_SIGN_IN_REASON));
    if (session.kind === 'unknown') {
      body.appendChild(line('thread-note', UNKNOWN_SESSION_NOTE));
    }
    body.append(...facts());
    const { form, email } = signInForm([], {
      relicId,
      fragment,
      deps,
      outcome,
      label: 'Your email address',
    });
    form.className = 'share-form';
    body.append(form, outcome);
    return email;
  };

  /** The addresses, for a reader this browser has verified. */
  const paintAddresses = (email: string): HTMLElement => {
    const identity = document.createElement('p');
    identity.className = 'compose-identity';
    const address = document.createElement('strong');
    address.textContent = plainLabel(email);
    identity.append(document.createTextNode('Sharing as '), address);
    body.append(identity, ...facts());

    const form = document.createElement('form');
    form.className = 'share-form';
    form.noValidate = true;

    const box = document.createElement('textarea');
    box.className = 'compose-input share-addresses';
    box.id = 'share-addresses';
    box.rows = 3;
    box.autocomplete = 'off';
    box.spellcheck = false;
    box.placeholder = 'lin@example.com, sam@example.com';
    box.value = draft;
    box.setAttribute(
      'aria-describedby',
      'share-hint share-count share-problem'
    );
    form.appendChild(field('Their email addresses', box));

    const hint = line(
      'compose-fine',
      `Separate them with commas or new lines. Up to ${SHARE_MAX_PER_CALL} ` +
        'at a time.'
    );
    hint.id = 'share-hint';
    form.appendChild(hint);

    const problem = document.createElement('div');
    problem.className = 'share-problem';
    problem.id = 'share-problem';
    problem.setAttribute('aria-live', 'polite');
    form.appendChild(problem);

    const foot = document.createElement('div');
    foot.className = 'compose-foot';
    const count = document.createElement('span');
    count.className = 'compose-count';
    count.id = 'share-count';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'action primary';
    submit.textContent = 'Add and write the email';
    foot.append(count, submit);
    form.appendChild(foot);

    const outcome = outcomeSlot();

    const paintCount = (): ParsedAddresses => {
      const parsed = parseAddresses(box.value);
      const n = addressCount(parsed);
      count.textContent = `${n} of ${SHARE_MAX_PER_CALL} addresses`;
      count.classList.toggle('over', n > SHARE_MAX_PER_CALL);
      return parsed;
    };
    /** Says what is wrong with the list, and whether anything is. */
    const judge = (final: boolean): string[] | undefined => {
      const parsed = paintCount();
      const said = addressProblem(parsed, final);
      box.setAttribute('aria-invalid', said === undefined ? 'false' : 'true');
      problem.replaceChildren(
        ...(said === undefined ? [] : [line('compose-warning', said)])
      );
      return said === undefined ? [...parsed.addresses] : undefined;
    };
    paintCount();
    if (draft.trim().length > 0) judge(false);

    box.addEventListener('input', () => {
      draft = box.value;
      // Only clears a complaint already made, so a half-typed address is
      // not called wrong while it is still being typed.
      if (box.getAttribute('aria-invalid') === 'true') judge(false);
      else paintCount();
    });
    box.addEventListener('blur', () => {
      if (box.value.trim().length > 0) judge(false);
    });

    const attempt = (): void => {
      const addresses = judge(true);
      if (addresses === undefined) {
        box.focus();
        return;
      }
      let key: Uint8Array;
      try {
        key = parseFragment(fragment).key;
      } catch {
        // Unreachable from a ready view, which exists only because the
        // fragment parsed. Caught so no error object holding it escapes.
        ended = shareRefusal('no_share_key');
        paint('title');
        return;
      }
      submit.disabled = true;
      box.readOnly = true;
      outcome.replaceChildren(line('thread-note', SHARE_PROVING_NOTE));
      inFlight = requestShare(relicId, key, addresses, deps).then((result) => {
        if (!open) return;
        submit.disabled = false;
        box.readOnly = false;
        if (result.kind === 'shared') {
          shared = result;
          draft = '';
          paint('summary');
          return;
        }
        const refusal = result.refusal;
        if (refusal.code === 'invalid_session') {
          session = { kind: 'anonymous' };
          lapsed = refusal;
          paint();
          return;
        }
        if (refusalEndsSharing(refusal.code)) {
          ended = refusal;
          paint('title');
          return;
        }
        outcome.replaceChildren(threadRefusal(refusal, attempt));
      });
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      attempt();
    });

    body.append(form, outcome);
    return box;
  };

  /** The email, ready to leave from the reader's own mail. */
  const paintShared = (result: Shared): HTMLElement => {
    const summary = line('share-done', sharedSummary(result));
    summary.tabIndex = -1;

    const heading = document.createElement('h3');
    heading.className = 'compose-title';
    heading.textContent = 'Now send it from your own mail';

    const email = readerShareEmail(view.shareUrl, result);
    const card = document.createElement('figure');
    card.className = 'share-email';
    card.setAttribute('aria-label', 'The email to send');
    const meta = document.createElement('dl');
    meta.className = 'share-email-head';
    const term = (text: string): HTMLElement => {
      const dt = document.createElement('dt');
      dt.textContent = text;
      return dt;
    };
    const value = (text: string): HTMLElement => {
      const dd = document.createElement('dd');
      dd.textContent = text;
      return dd;
    };
    meta.append(
      term('To'),
      value(email.to.join(', ')),
      term('Subject'),
      value(email.subject)
    );
    const text = document.createElement('pre');
    text.className = 'share-email-body';
    text.textContent = email.text;
    card.append(meta, text);

    const outcome = outcomeSlot();
    const send = document.createElement('div');
    send.className = 'share-send';
    const mail = document.createElement('a');
    mail.className = 'action primary share-mailto';
    mail.href = shareMailtoUrl(email);
    mail.appendChild(icon(ICONS.share));
    const mailText = document.createElement('span');
    mailText.textContent = 'Open in your mail app';
    mail.appendChild(mailText);
    const copy = button('Copy message', ICONS.copy, () => {
      void copyText(email.text).then((copied) => {
        if (copied) {
          // Said in the panel rather than as a toast: a modal dialog sits in
          // the top layer, and a toast on the page would land under its
          // backdrop.
          outcome.replaceChildren(line('thread-note', SHARE_COPIED_NOTE));
          return;
        }
        // Selected so the keyboard copy the note promises actually works.
        const selection = window.getSelection?.();
        if (selection && typeof document.createRange === 'function') {
          const range = document.createRange();
          range.selectNodeContents(text);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        outcome.replaceChildren(line('compose-warning', COPY_FAILED_NOTE));
      });
    });
    send.append(mail, copy);

    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'share-again';
    again.textContent = 'Share with someone else';
    again.addEventListener('click', () => {
      shared = undefined;
      paint();
    });

    body.append(
      summary,
      heading,
      card,
      line('compose-warning', SHARE_KEY_WARNING),
      send,
      outcome,
      again
    );
    return summary;
  };

  const paint = (focus: 'field' | 'title' | 'summary' = 'field'): void => {
    body.replaceChildren();
    let target: HTMLElement = title;
    if (checking) {
      body.appendChild(line('thread-note', SHARE_CHECKING_NOTE));
    } else if (ended !== undefined) {
      body.append(
        threadRefusal(ended, () => {}),
        button('Close', ICONS.close, close)
      );
    } else if (shared !== undefined) {
      target = paintShared(shared);
    } else if (session.kind === 'verified') {
      target = paintAddresses(session.email);
    } else {
      target = paintSignIn();
    }
    if (focus === 'title') title.focus();
    else target.focus();
  };

  /**
   * A link followed in another tab verifies this browser, not this panel, so
   * the panel listens for the same bare marker the thread does.
   */
  const recheck = async (): Promise<void> => {
    if (!open || checking) return;
    const discovered = await readSession(deps);
    if (!open || sessionSignature(discovered) === sessionSignature(session)) {
      return;
    }
    session = discovered;
    if (discovered.kind === 'verified') lapsed = undefined;
    if (shared === undefined && ended === undefined) paint();
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void recheck();
  };

  const cleanUp = (): void => {
    if (!open) return;
    open = false;
    channel?.close();
    document.removeEventListener('visibilitychange', onVisible);
    dialog.remove();
    opener?.focus();
  };
  function close(): void {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else cleanUp();
  }

  dismiss.addEventListener('click', close);
  // Escape and the close button both arrive here, through the dialog's own
  // `close` event, so there is one teardown however the panel was left.
  dialog.addEventListener('close', cleanUp);
  dialog.addEventListener('click', (event: Event) => {
    // A press on the backdrop lands on the dialog itself.
    if (event.target === dialog) close();
  });

  if (typeof BroadcastChannel === 'function') {
    channel = new BroadcastChannel('relic:auth');
    channel.addEventListener('message', () => {
      void recheck();
    });
  }
  document.addEventListener('visibilitychange', onVisible);

  document.body.appendChild(dialog);
  // Under the band as it is actually drawn: a two-line identity makes it
  // taller than `--bar-height`, and the sheet must not cover its rule.
  const bar = document.querySelector('.bar');
  if (bar !== null && typeof bar.getBoundingClientRect === 'function') {
    dialog.style.setProperty(
      '--share-top',
      `${Math.round(bar.getBoundingClientRect().bottom)}px`
    );
  }
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  paint('title');

  const ready = readSession(deps).then((discovered) => {
    if (!open) return;
    session = discovered;
    checking = false;
    paint();
  });

  return {
    element: dialog,
    ready,
    idle: () => inFlight,
    close,
  };
}

export function renderReady(
  view: ReadyView,
  relicId: string,
  usercontentOrigin: string,
  deps: ViewerDeps
): void {
  /** The attached taskbar, so a count arriving can replace just that row. */
  let bar: HTMLElement | undefined;
  let commentCount: number | undefined;
  let thread: ThreadHandle | undefined;

  let activeView = view;
  const loadedViews = new Map<number, ReadyView>();
  loadedViews.set(view.version, view);

  function barFor(comparisonOpen = false): HTMLElement {
    return buildBar(activeView, relicId, {
      comparisonOpen,
      selectedVersion: activeView.version,
      onSelectVersion: (version: number) => {
        void showVersion(version);
      },
      onCompare: () => {
        if (comparisonOpen) {
          showSingle(activeView);
        } else {
          const pair = seedComparisonPair(
            activeView.version,
            activeView.currentVersion
          );
          showComparison(pair.left, pair.right);
        }
      },
      onShare: (opener) => {
        openSharePanel(activeView, relicId, deps, opener);
      },
      ...(thread === undefined
        ? {}
        : {
            onComments: thread.toggle,
            ...(commentCount === undefined ? {} : { commentCount }),
          }),
    });
  }
  const showSingle = (viewToShow: ReadyView): void => {
    activeView = viewToShow;
    bar = barFor(false);
    if (viewToShow.route !== 'download') {
      thread = buildThread(viewToShow, relicId, deps, (count) => {
        commentCount = count;
        if (bar === undefined) return;
        const replacement = barFor(false);
        bar.replaceWith(replacement);
        bar = replacement;
      }, (version) => { void showVersion(version); });
    } else {
      thread = undefined;
    }
    const stage = buildStageWrap(viewToShow, usercontentOrigin);
    disposeOtioViews(document.body);
    document.body.replaceChildren(
      bar,
      buildRelicRow(stage, thread?.element, thread?.resizer, thread?.tab)
    );
    thread?.attach(stage);
  };

  const showVersion = async (v: number): Promise<void> => {
    if (v === activeView.version) {
      showSingle(activeView);
      return;
    }
    const cached = loadedViews.get(v);
    if (cached !== undefined) {
      showSingle(cached);
      return;
    }
    const res = await loadHistoricalVersion(relicId, v, view, deps);
    if (res.kind === 'ready') {
      loadedViews.set(v, res.view);
      showSingle(res.view);
    }
  };

  const showComparison = (left?: number, right?: number): void => {
    renderComparison(
      activeView,
      relicId,
      usercontentOrigin,
      deps,
      () => showSingle(activeView),
      left,
      right
    );
  };

  // A download-only relic gets no thread, for the same reason section 6.1
  // item 13 gives it no comparison control: nothing rendered, so there is
  // nothing on the page to comment about.
  if (view.route !== 'download') {
    thread = buildThread(view, relicId, deps, (count) => {
      commentCount = count;
      if (bar === undefined) return;
      const replacement = barFor(false);
      bar.replaceWith(replacement);
      bar = replacement;
    }, (version) => { void showVersion(version); });
  }

  showSingle(activeView);
}

export function renderDead(
  dead: DeadView,
  relicId?: string,
  usercontentOrigin?: string,
  deps?: ViewerDeps,
  cachedCiphertext?: { bytes: Uint8Array; mint: MintResponse }
): void {
  const bar = document.createElement('header');
  bar.className = 'bar';
  const mark = document.createElement('div');
  mark.className = 'mark';
  mark.textContent = WORDMARK;
  bar.appendChild(mark);
  document.body.replaceChildren(bar);

  const main = document.createElement('main');
  main.className = 'stage stage-dead';

  const card = document.createElement('div');
  card.className = 'card';

  const headline = document.createElement('h1');
  headline.className = 'card-title';
  headline.textContent = dead.headline;

  const detail = document.createElement('p');
  detail.className = 'card-note';
  detail.textContent = dead.detail;

  card.append(headline, detail);

  if (dead.action === 'retry') {
    const retry = button('Try again', ICONS.rendered, () =>
      window.location.reload()
    );
    retry.classList.add('primary');
    card.appendChild(retry);
  }
  if (dead.action === 'report') {
    const link = document.createElement('a');
    link.className = 'action primary';
    link.href = `${SERVICE_ORIGIN}/abuse`;
    link.textContent = 'Contact us';
    card.appendChild(link);
  }

  if (isKeyEntryRecoverable(dead.code) && relicId && deps) {
    const keySection = document.createElement('div');
    keySection.className = 'key-entry';

    const prompt = document.createElement('p');
    prompt.className = 'key-entry-prompt';
    prompt.textContent =
      'If you have the decryption key or recovery phrase for this relic, enter it below.';

    const form = document.createElement('form');
    form.className = 'key-entry-form';

    const label = document.createElement('label');
    label.className = 'key-entry-label';
    label.htmlFor = 'relic-key-input';
    label.textContent = 'Key, share link, or recovery phrase';

    const inputRow = document.createElement('div');
    inputRow.className = 'key-entry-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'relic-key-input';
    input.name = 'key';
    input.className = 'compose-input key-entry-input';
    input.placeholder = 'Paste link, #r1..., or recovery words';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.required = true;

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'action primary key-entry-submit';
    submit.textContent = 'Open relic';

    inputRow.append(input, submit);

    const feedback = document.createElement('div');
    feedback.className = 'key-entry-feedback';
    feedback.setAttribute('role', 'alert');

    form.append(label, inputRow, feedback);

    const cached = cachedCiphertext;

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const enteredValue = input.value;
      if (enteredValue.trim().length === 0) return;

      submit.disabled = true;
      feedback.replaceChildren();

      void openRelicWithKey(relicId, enteredValue, deps, cached).then(
        (result) => {
          submit.disabled = false;
          if (result.kind === 'ready') {
            renderReady(result.view, relicId, usercontentOrigin ?? '', deps);
            return;
          }
          if (result.kind === 'invalid') {
            feedback.textContent = result.message;
          } else if (result.kind === 'wrong_key') {
            feedback.textContent = result.message;
          } else if (result.kind === 'dead') {
            feedback.textContent = result.dead.detail;
          }
        },
        () => {
          submit.disabled = false;
          feedback.textContent = 'Decryption could not be completed.';
        }
      );
    });

    keySection.append(prompt, form);
    card.appendChild(keySection);
  }

  const code = document.createElement('div');
  code.className = 'accession';
  code.textContent = dead.code;
  card.appendChild(code);

  main.appendChild(card);
  document.body.appendChild(main);
}

/** A small cover for a dashboard row, built only from local/plain metadata. */
function dashboardThumbnail(row: DashboardRelicRow): HTMLElement {
  const thumb = document.createElement('span');
  thumb.className = `relic-thumbnail relic-thumbnail-${row.previewKind}`;
  thumb.setAttribute('role', 'img');
  thumb.setAttribute('aria-label', `${row.previewLabel} relic`);

  const rule = document.createElement('span');
  rule.className = 'relic-thumbnail-rule';
  rule.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'relic-thumbnail-label';
  label.textContent = row.previewLabel;

  thumb.append(rule, label);
  return thumb;
}

export async function renderDashboard(deps: ViewerDeps): Promise<void> {
  const bar = document.createElement('header');
  bar.className = 'bar';
  const mark = document.createElement('div');
  mark.className = 'mark';
  mark.textContent = WORDMARK;
  bar.appendChild(mark);

  const identity = document.createElement('div');
  identity.className = 'identity';
  const title = document.createElement('div');
  title.className = 'filename';
  title.textContent = 'Dashboard';
  const meta = document.createElement('div');
  meta.className = 'identity-meta';
  const accession = document.createElement('div');
  accession.className = 'accession';
  accession.textContent = 'CATALOGUE';
  meta.appendChild(accession);
  identity.append(title, meta);
  bar.appendChild(identity);

  document.body.replaceChildren(bar);

  const main = document.createElement('main');
  main.className = 'stage stage-dashboard';

  const container = document.createElement('div');
  container.className = 'dashboard-container';

  const h1 = document.createElement('h1');
  h1.className = 'dashboard-title';
  h1.textContent = 'Relic Dashboard';
  container.appendChild(h1);

  // Section 1: Relics this browser can open
  const localSection = document.createElement('section');
  localSection.className = 'dashboard-section local-relics-section';

  const localHeading = document.createElement('h2');
  localHeading.className = 'dashboard-section-title';
  localHeading.textContent = 'Relics this browser can open';

  const localNote = document.createElement('p');
  localNote.className = 'dashboard-section-note';
  localNote.textContent =
    'These keys are saved in this browser. You can open these relics without signing in.';

  localSection.append(localHeading, localNote);

  const localListContainer = document.createElement('div');
  localListContainer.className = 'local-relics-list-container';

  const paintLocalList = (): void => {
    localListContainer.replaceChildren();
    const rows = buildLocalDashboardRows(deps.keyVault);
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'relic-list-empty';
      empty.textContent = 'No relics currently saved in this browser.';
      localListContainer.appendChild(empty);
      return;
    }

    const ul = document.createElement('ul');
    ul.className = 'dashboard-relic-list';

    for (const row of rows) {
      const li = document.createElement('li');
      li.className = 'dashboard-relic-item';

      const info = document.createElement('div');
      info.className = 'dashboard-relic-info';

      const link = document.createElement('a');
      link.className = 'relic-link';
      link.href = `/${encodeURIComponent(row.relicId)}#${row.fragment ?? ''}`;
      link.textContent = row.title;
      info.appendChild(link);

      const actions = document.createElement('div');
      actions.className = 'dashboard-relic-actions';

      const forgetBtn = document.createElement('button');
      forgetBtn.type = 'button';
      forgetBtn.className = 'action action-forget';
      forgetBtn.textContent = 'Forget';
      forgetBtn.addEventListener('click', () => {
        deps.keyVault.forget(row.relicId);
        paintLocalList();
      });
      actions.appendChild(forgetBtn);

      li.append(dashboardThumbnail(row), info, actions);
      ul.appendChild(li);
    }
    localListContainer.appendChild(ul);
  };

  paintLocalList();
  localSection.appendChild(localListContainer);

  // Vault export & import tools
  const vaultTools = document.createElement('div');
  vaultTools.className = 'vault-tools';

  const toolsTitle = document.createElement('h3');
  toolsTitle.className = 'vault-tools-title';
  toolsTitle.textContent = 'Key backup and transfer';

  const toolsNote = document.createElement('p');
  toolsNote.className = 'vault-tools-note';
  toolsNote.textContent =
    'Exporting creates a backup file containing the decryption keys for every relic listed above. Anyone holding this backup can open your relics. Keep it safe and treat it as a credential.';

  const toolsRow = document.createElement('div');
  toolsRow.className = 'vault-tools-actions';

  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'action vault-export-btn';
  exportBtn.textContent = 'Export keys';
  exportBtn.addEventListener('click', () => {
    const data = deps.keyVault.exportEntries
      ? deps.keyVault.exportEntries()
      : JSON.stringify({ version: 1, entries: [] });
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'relic-keys-backup.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Key backup exported. Treat this file as a credential.');
  });

  const importToggleBtn = document.createElement('button');
  importToggleBtn.type = 'button';
  importToggleBtn.className = 'action vault-import-toggle-btn';
  importToggleBtn.textContent = 'Import keys';

  const importPanel = document.createElement('div');
  importPanel.className = 'vault-import-panel';
  importPanel.hidden = true;

  const importLabel = document.createElement('label');
  importLabel.className = 'compose-field';
  importLabel.textContent = 'Key backup JSON:';

  const importInput = document.createElement('textarea');
  importInput.className = 'compose-textarea vault-import-input';
  importInput.placeholder = 'Paste exported JSON here...';
  importInput.rows = 4;

  const importSubmitBtn = document.createElement('button');
  importSubmitBtn.type = 'button';
  importSubmitBtn.className = 'action primary vault-import-submit-btn';
  importSubmitBtn.textContent = 'Apply import';

  const importFeedback = document.createElement('div');
  importFeedback.className = 'vault-import-feedback';

  importToggleBtn.addEventListener('click', () => {
    importPanel.hidden = !importPanel.hidden;
  });

  importSubmitBtn.addEventListener('click', () => {
    const raw = importInput.value.trim();
    if (raw.length === 0) return;
    const result = deps.keyVault.importEntries
      ? deps.keyVault.importEntries(raw)
      : { added: 0, skipped: 0 };
    importInput.value = '';
    importPanel.hidden = true;
    paintLocalList();
    toast(`Imported ${result.added} keys (${result.skipped} skipped).`);
  });

  importPanel.append(importLabel, importInput, importSubmitBtn, importFeedback);
  toolsRow.append(exportBtn, importToggleBtn);
  vaultTools.append(toolsTitle, toolsNote, toolsRow, importPanel);
  localSection.appendChild(vaultTools);

  container.appendChild(localSection);

  // Section 2: Relics you have commented on / Auth section
  const session = await readSession(deps);

  if (session.kind === 'verified') {
    const commentedSection = document.createElement('section');
    commentedSection.className = 'dashboard-section commented-relics-section';

    const commentedHeading = document.createElement('h2');
    commentedHeading.className = 'dashboard-section-title';
    commentedHeading.textContent = 'Relics you have commented on';

    const sessionInfo = document.createElement('p');
    sessionInfo.className = 'dashboard-session-info';
    sessionInfo.textContent = `Signed in as ${session.email}.`;

    commentedSection.append(commentedHeading, sessionInfo);

    const commentedList = document.createElement('div');
    commentedList.className = 'commented-relics-list-container';
    commentedList.textContent = 'Loading commented relics...';
    commentedSection.appendChild(commentedList);

    container.appendChild(commentedSection);

    void loadCommentedRelics(deps).then((commented) => {
      commentedList.replaceChildren();
      if (commented === null || commented.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'relic-list-empty';
        empty.textContent =
          commented === null
            ? 'Could not load commented relics.'
            : 'You have not commented on any relics yet.';
        commentedList.appendChild(empty);
        return;
      }

      const rows = buildCommentedDashboardRows(commented, deps.keyVault);
      const ul = document.createElement('ul');
      ul.className = 'dashboard-relic-list';

      for (const row of rows) {
        const li = document.createElement('li');
        li.className = `dashboard-relic-item ${row.hasKey ? 'relic-openable' : 'relic-unopenable'}`;

        const info = document.createElement('div');
        info.className = 'dashboard-relic-info';

        if (row.hasKey && row.fragment) {
          const link = document.createElement('a');
          link.className = 'relic-link';
          link.href = `/${encodeURIComponent(row.relicId)}#${row.fragment}`;
          link.textContent = row.title;
          info.appendChild(link);
        } else {
          const titleSpan = document.createElement('span');
          titleSpan.className = 'relic-title-unopenable';
          titleSpan.textContent = row.title;

          const unopenableNote = document.createElement('p');
          unopenableNote.className = 'relic-unopenable-note';
          unopenableNote.textContent =
            'This browser does not hold the key for this relic. The original link is the only way in.';

          info.append(titleSpan, unopenableNote);
        }

        li.append(dashboardThumbnail(row), info);
        ul.appendChild(li);
      }
      commentedList.appendChild(ul);
    });
  } else {
    // Signed-out state: show local section plus magic-link sign-in affordance
    const authSection = document.createElement('section');
    authSection.className = 'dashboard-section dashboard-auth-section';

    const authHeading = document.createElement('h2');
    authHeading.className = 'dashboard-section-title';
    authHeading.textContent = 'Relics you have commented on';

    const authPrompt = document.createElement('p');
    authPrompt.className = 'dashboard-section-note';
    authPrompt.textContent =
      'Sign in with your email address to view relics you have commented on.';

    const form = document.createElement('form');
    form.className = 'compose compose-identity-dashboard';

    const emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.required = true;
    emailInput.autocomplete = 'email';
    emailInput.className = 'compose-input';
    emailInput.placeholder = 'you@example.com';

    const label = document.createElement('label');
    label.className = 'compose-field';
    label.textContent = 'Email address:';
    label.appendChild(emailInput);

    const fine = document.createElement('p');
    fine.className = 'compose-fine';
    fine.textContent = DELIVERY_DISCLOSURE;

    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'action primary';
    sendBtn.textContent = 'Send me a link';

    const outcome = document.createElement('div');
    outcome.className = 'dashboard-auth-outcome';

    form.append(label, fine, sendBtn, outcome);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const address = emailInput.value.trim();
      if (address.length === 0) return;

      sendBtn.disabled = true;
      outcome.textContent = 'Sending...';

      void (async () => {
        try {
          const res = await deps.fetch(
            `${deps.serviceOrigin}/api/auth/request`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ email: address, return_to: '/dashboard' }),
            }
          );
          sendBtn.disabled = false;
          if (res.status === 202) {
            outcome.textContent =
              `If ${plainLabel(address)} can receive mail, a link is on its way. ` +
              'Following it verifies the address and brings you back to this dashboard.';
          } else {
            outcome.textContent = 'Request refused. Please try again.';
          }
        } catch {
          sendBtn.disabled = false;
          outcome.textContent = 'Network error. Please try again.';
        }
      })();
    });

    authSection.append(authHeading, authPrompt, form);
    container.appendChild(authSection);
  }

  main.appendChild(container);
  document.body.appendChild(main);
}

export { localStorageKeyVault };

export function makeBrowserDeps(): ViewerDeps {
  return {
    serviceOrigin: SERVICE_ORIGIN,
    fetch: globalThis.fetch.bind(globalThis),
    keyVault: localStorageKeyVault(),
    takeFragment: () => window.location.hash,
    stripFragment: () => {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search
      );
    },
    locationHref: window.location.href,
  };
}

export async function boot(
  root: HTMLElement | null = typeof document !== 'undefined'
    ? document.getElementById('relic-root')
    : null,
  deps: ViewerDeps = makeBrowserDeps()
): Promise<void> {
  const viewMarker = root?.dataset['view'];
  const relicId = root?.dataset['relicId'] ?? '';
  const usercontentOrigin = root?.dataset['usercontentOrigin'] ?? '';

  if (viewMarker === 'dashboard') {
    await renderDashboard(deps);
    return;
  }

  const state = await load(relicId, deps);

  if (state.kind === 'ready') {
    renderReady(state.view, relicId, usercontentOrigin, deps);
  } else if (state.kind === 'dead') {
    renderDead(
      state.dead,
      relicId,
      usercontentOrigin,
      deps,
      state.cachedCiphertext
    );
  }
}

if (typeof document !== 'undefined') {
  void boot();
}
