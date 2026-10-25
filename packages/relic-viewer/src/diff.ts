import { type Change, diffLines, diffWordsWithSpace } from 'diff';
import type { ReadyView, RenderRoute } from './viewer.ts';

/**
 * One comparison ceiling for every comparable class.
 *
 * The 1 MiB rendered split is reversed. Documents (markdown, html, jsx)
 * need to compare, and a 1 MiB refusal was blocking real ones while the
 * current version still opened under the 100 MiB one-version ceiling.
 * 16 MiB per version is large enough for an inlined HTML report and still
 * a named stop before two 100 MiB trees try to share a tab. A phone may
 * feel it. A document that cannot be compared is worse.
 */
export const MAX_DIFF_BYTES = 16 * 1024 * 1024;
export const DIFF_LIMIT_LABEL = '16 MiB';

/** Same ceiling. Kept so existing imports keep compiling. */
export const MAX_RENDERED_DIFF_BYTES = MAX_DIFF_BYTES;
export const RENDERED_DIFF_LIMIT_LABEL = DIFF_LIMIT_LABEL;

/**
 * How a pair of versions is compared. `code` is the one text mode left: a
 * line diff is the visual form of code, because code is text. Everything
 * else is compared as it renders.
 */
export type DiffMode = 'markdown' | 'code' | 'rendered' | 'image';

export interface DiffCeiling {
  readonly bytes: number;
  /** The same ceiling as the recipient is told it. */
  readonly label: string;
}

/**
 * The ceiling for a mode, carried as one value so the number and the copy
 * that names it cannot drift apart. Three call sites read it: the taskbar's
 * availability check, the historical load's refusal before fetching, and the
 * comparison's own copy.
 */
export function diffCeilingFor(_mode: DiffMode): DiffCeiling {
  return { bytes: MAX_DIFF_BYTES, label: DIFF_LIMIT_LABEL };
}

export interface DiffSegment {
  readonly kind: 'unchanged' | 'added' | 'removed';
  readonly text: string;
}

export interface TextDiffPart {
  readonly kind: 'unchanged' | 'added' | 'removed';
  readonly value: string;
  readonly beforeStart: number | undefined;
  readonly currentStart: number | undefined;
  readonly beforeLines: number;
  readonly currentLines: number;
  readonly segments: readonly DiffSegment[] | undefined;
}

export interface TextDiff {
  readonly changed: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly parts: readonly TextDiffPart[];
  readonly summary: string;
}

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

export interface ImageDiff {
  readonly mode: 'image';
  readonly changed: boolean;
  readonly summary: string;
}

export type ComparisonAvailability =
  | { readonly kind: 'none' }
  | { readonly kind: 'available'; readonly mode: DiffMode }
  | {
      readonly kind: 'unavailable';
      readonly code:
        | 'comparison_not_renderable'
        | 'comparison_not_supported'
        | 'comparison_too_large';
      readonly detail: string;
    };
export interface VersionHistoryCopy {
  readonly headline: string;
  readonly detail: string;
}

/**
 * The panel's heading and standing note.
 *
 * `comparable` decides the verb, and it has to: the heading is written before
 * the version is fetched, so it used to say "Comparing version 1 with version
 * 2" above a page that then explained no comparison was possible and showed
 * version 1 alone. The detail line is true either way, because retained
 * history is retained history whether or not it can be diffed.
 */
export function versionHistoryCopy(
  currentVersion: number,
  historicalVersion: number,
  comparable = true
): VersionHistoryCopy {
  return {
    headline: comparable
      ? `Comparing version ${historicalVersion} with version ${currentVersion}`
      : `Version ${historicalVersion} of ${currentVersion}`,
    detail:
      `Version ${currentVersion} is current. Version ${historicalVersion} is ` +
      'retained history and may contain content removed from the current artifact.',
  };
}

function kindOf(change: Change): DiffSegment['kind'] {
  if (change.added === true) return 'added';
  if (change.removed === true) return 'removed';
  return 'unchanged';
}

function wordSegments(
  before: string,
  current: string,
  side: 'removed' | 'added'
): readonly DiffSegment[] {
  return diffWordsWithSpace(before, current)
    .filter((change) =>
      side === 'removed' ? change.added !== true : change.removed !== true
    )
    .map((change) => ({ kind: kindOf(change), text: change.value }));
}

/**
 * Compare code line by line. Code is the one class where a line diff is the
 * visual form, because code is text: what a reader sees is the source. Every
 * other class is compared as it renders.
 */
export function createTextDiff(before: string, current: string): TextDiff {
  if (before === current) {
    return {
      changed: false,
      additions: 0,
      deletions: 0,
      parts: [],
      summary: 'No changes. These versions have identical content.',
    };
  }

  const changes = diffLines(before, current);
  const parts: TextDiffPart[] = [];
  let beforeLine = 1;
  let currentLine = 1;
  let additions = 0;
  let deletions = 0;

  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    if (change === undefined) continue;

    const kind = kindOf(change);
    const beforeLines = kind === 'added' ? 0 : change.count;
    const currentLines = kind === 'removed' ? 0 : change.count;
    let segments: readonly DiffSegment[] | undefined;

    const next = changes[index + 1];
    if (
      kind === 'removed' &&
      change.count === 1 &&
      next?.added === true &&
      next.count === 1
    ) {
      segments = wordSegments(change.value, next.value, 'removed');
    } else if (
      kind === 'added' &&
      change.count === 1 &&
      changes[index - 1]?.removed === true &&
      changes[index - 1]?.count === 1
    ) {
      const previous = changes[index - 1];
      if (previous !== undefined) {
        segments = wordSegments(previous.value, change.value, 'added');
      }
    }

    parts.push({
      kind,
      value: change.value,
      beforeStart: beforeLines === 0 ? undefined : beforeLine,
      currentStart: currentLines === 0 ? undefined : currentLine,
      beforeLines,
      currentLines,
      segments,
    });

    beforeLine += beforeLines;
    currentLine += currentLines;
    if (kind === 'added') additions += currentLines;
    if (kind === 'removed') deletions += beforeLines;
  }

  return {
    changed: true,
    additions,
    deletions,
    parts,
    summary: `${additions} added ${additions === 1 ? 'line' : 'lines'}, ${deletions} removed ${deletions === 1 ? 'line' : 'lines'}.`,
  };
}

export function bytesEqual(before: Uint8Array, current: Uint8Array): boolean {
  if (before.length !== current.length) return false;
  return before.every((byte, index) => current[index] === byte);
}

function signedPixels(value: number): string {
  if (value > 0) return `+${value} px`;
  return `${value} px`;
}

export function createImageDiff(
  before: Uint8Array,
  current: Uint8Array,
  beforeDimensions: ImageDimensions,
  currentDimensions: ImageDimensions
): ImageDiff {
  if (bytesEqual(before, current)) {
    return {
      mode: 'image',
      changed: false,
      summary: 'No changes. These versions have identical content.',
    };
  }

  const widthDelta = currentDimensions.width - beforeDimensions.width;
  const heightDelta = currentDimensions.height - beforeDimensions.height;
  return {
    mode: 'image',
    changed: true,
    summary:
      `Version dimensions: ${beforeDimensions.width} x ${beforeDimensions.height} px ` +
      `to ${currentDimensions.width} x ${currentDimensions.height} px. ` +
      `Width ${signedPixels(widthDelta)}, height ${signedPixels(heightDelta)}.`,
  };
}

/**
 * How one version would be compared. Exported because the historical load
 * refuses against a ceiling before it fetches anything, and that ceiling is
 * per mode.
 */
export function diffModeForRoute(route: RenderRoute): DiffMode | undefined {
  switch (route) {
    case 'markdown':
      return 'markdown';
    case 'code':
      return 'code';
    case 'sandboxed-html':
    case 'sandboxed-jsx':
      return 'rendered';
    case 'image':
      return 'image';
    default:
      return undefined;
  }
}

/**
 * Both versions have to reach the same mode, and the rule is equality rather
 * than a fallback to the current version's mode. Each mode compares a
 * different kind of thing: rendered prose the viewer builds, a page the
 * usercontent frame builds, an image the browser decodes, or lines of text.
 * Feeding one mode the other's bytes would produce a confident result with no
 * meaning, so a pair that disagrees is refused and the recipient is told why.
 */
export function diffModeForRoutes(
  currentRoute: RenderRoute,
  historicalRoute: RenderRoute
): DiffMode | undefined {
  const currentMode = diffModeForRoute(currentRoute);
  if (currentMode === undefined) return undefined;
  return currentMode === diffModeForRoute(historicalRoute)
    ? currentMode
    : undefined;
}

/**
 * Whether this relic has earlier versions a reader can open.
 *
 * Deliberately separate from `comparisonAvailability`, and the separation is
 * the fix rather than a tidy-up. The two were one predicate, so a relic whose
 * versions could not be diffed reported no history at all: the control was
 * never offered and the reader was told earlier versions exist in the same
 * breath as being given no way to look at them.
 *
 * Having history is a property of the relic. Being able to show two versions
 * side by side is a property of what they contain and how big they are. A
 * download-only relic has real earlier versions that can be opened and saved;
 * an oversize one has earlier versions that may be small enough to render.
 */
export function versionHistoryAvailability(
  view: ReadyView
): { readonly kind: 'none' } | { readonly kind: 'available' } {
  return Number.isInteger(view.currentVersion) && view.currentVersion > 1
    ? { kind: 'available' }
    : { kind: 'none' };
}

/**
 * Maps routes that play or render in the browser to their class noun.
 */
export function uncomparableClassNoun(route: RenderRoute): string | undefined {
  switch (route) {
    case 'otio':
      return 'timeline';
    case 'media':
      return 'recording';
    case 'pdf':
      return 'PDF';
    default:
      return undefined;
  }
}

/**
 * Returns the unprompted comparison notice for download-only and oversize relics.
 * For classes that play in the browser (otio, media, pdf) and comparable classes,
 * returns undefined.
 */
export function unpromptedComparisonNotice(
  view: ReadyView
): string | undefined {
  const availability = comparisonAvailability(view);
  if (
    availability.kind === 'unavailable' &&
    (availability.code === 'comparison_not_renderable' ||
      availability.code === 'comparison_too_large')
  ) {
    return availability.detail;
  }
  return undefined;
}

/**
 * Whether two versions of this relic can be shown side by side.
 *
 * Answers only that. A caller that wants to know whether earlier versions
 * can be reached at all asks `versionHistoryAvailability`, and the copy here
 * assumes the caller will still offer them: it says comparison is
 * unavailable, never that the versions are.
 */
export function comparisonAvailability(
  view: ReadyView
): ComparisonAvailability {
  if (!Number.isInteger(view.currentVersion) || view.currentVersion <= 1) {
    return { kind: 'none' };
  }

  const noun = uncomparableClassNoun(view.route);
  if (noun !== undefined) {
    let detail = '';
    if (view.route === 'otio') {
      detail =
        'Relik plays this timeline in your browser but cannot show two versions of it side by side. Each version can still be opened on its own.';
    } else if (view.route === 'media') {
      detail =
        'Relik plays this recording in your browser but cannot show two versions of it side by side. Each version can still be opened on its own.';
    } else if (view.route === 'pdf') {
      detail =
        'Relik shows this PDF in your browser but cannot show two versions of it side by side. Each version can still be opened on its own.';
    }
    return {
      kind: 'unavailable',
      code: 'comparison_not_supported',
      detail,
    };
  }

  const mode = diffModeForRoute(view.route);
  if (mode === undefined) {
    return {
      kind: 'unavailable',
      code: 'comparison_not_renderable',
      detail:
        'This file is download-only, so Relik cannot show two versions side ' +
        'by side in the browser. Each version can still be opened on its own.',
    };
  }

  const ceiling = diffCeilingFor(mode);
  if (view.content.length > ceiling.bytes) {
    return {
      kind: 'unavailable',
      code: 'comparison_too_large',
      detail:
        `This version is larger than the ${ceiling.label} comparison limit, ` +
        'so Relik cannot show it beside another. Earlier versions can still ' +
        'be opened on their own.',
    };
  }

  return { kind: 'available', mode };
}
