import {
  addRationalTimes,
  COMMENT_ANCHOR_OTIO_LIMIT_BYTES,
  compareRationalTimes,
  indexOtioZip,
  isRawOtio,
  markersForOtioTimeline,
  type OtioAnchorResolution,
  type OtioAnchorV1,
  type OtioDocumentV1,
  type OtioNode,
  type OtioRationalTime,
  type OtioSourceSpan,
  type OtioTimelineMarker,
  type OtioTimeRange,
  type OtioZipIndex,
  otioBundleMediaIndex,
  rangeEndTime,
  readOtioDocument,
  rescaleTime,
  resolveOtioAnchor,
  sourceSpansForOtioRange,
  stringifyOtioJson,
  timeToSeconds,
} from '@relic/format';
import { otioTargetLabel } from './annotate-otio.ts';
import {
  attachOtioController,
  type OtioAimDetail,
  type OtioUiController,
} from './otio-bridge.ts';
import { createOtioMediaResolver } from './otio-media.ts';
import {
  createOtioPlayback,
  type OtioPlaybackController,
  type OtioPlaybackState,
} from './otio-playback.ts';
import {
  otioCompositionTime,
  otioDomainFrames,
  type OtioDomainFrameBounds,
  otioLocalTime,
  otioPointerTime,
  otioRangeGeometry,
  type OtioTimelineDomain,
  otioZoomAt,
  otioZoomLimits,
} from './otio-timeline-viewport.ts';

const encoder = new TextEncoder();
let nextMonitorId = 0;
const projectionsKey = (anchor: OtioAnchorV1): string => JSON.stringify(anchor);
const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (
  label: string,
  className: string,
  run: () => void
): HTMLButtonElement => {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', run);
  return node;
};
const schemaIs = (node: OtioNode, kind: string): boolean =>
  node.schema.split('.')[0] === kind;

/** Display conversion only. Placement and source sampling remain in the core. */
export function formatOtioTime(
  time: OtioRationalTime,
  global?: OtioRationalTime
): string {
  const value = global ? addRationalTimes(global, time) : time;
  const seconds = timeToSeconds(value);
  const negative = seconds < 0;
  const magnitude = Math.abs(seconds);
  const rate = value.rate;
  const whole = Math.floor(magnitude);
  const frame = Math.floor((magnitude - whole) * rate + 1e-5);
  return (
    (negative ? '-' : '') +
    [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60, frame]
      .map((n) => String(n).padStart(2, '0'))
      .join(':')
  );
}

function boundedLabel(text: string): string {
  let result = '';
  for (const character of text) {
    if (encoder.encode(result + character).length > 128) break;
    result += character;
  }
  return result;
}

export interface OtioProjectionTarget {
  readonly ranges: readonly OtioTimeRange[];
  readonly track: string | null;
  readonly item?: string;
}

export function otioProjectionTarget(
  anchor: OtioAnchorV1,
  revision: number,
  document: OtioDocumentV1,
  timelineId: string | undefined,
  resolution?: OtioAnchorResolution
): OtioProjectionTarget | undefined {
  const projection =
    resolution ??
    (anchor.relic_version === revision
      ? resolveOtioAnchor(anchor, document, document)
      : undefined);
  if (
    !timelineId ||
    !projection ||
    !['same', 'mapped', 'partial'].includes(projection.status) ||
    projection.mapped_timeline_id !== timelineId ||
    projection.mapped_track_id === undefined
  )
    return undefined;
  const ranges =
    projection.mapped_ranges ??
    (projection.mapped_range ? [projection.mapped_range] : []);
  if (ranges.length === 0) return undefined;
  return {
    ranges,
    track: projection.mapped_track_id,
    ...(projection.mapped_item_id ? { item: projection.mapped_item_id } : {}),
  };
}

/** A UI selection retains the track ID and exact rational range inside AEAD. */
export function createOtioSelection(
  document: OtioDocumentV1,
  timelineId: string,
  trackId: string | null,
  revision: number,
  range: OtioTimeRange,
  itemId?: string | null
): OtioAnchorV1 {
  const timeline = document.nodes[timelineId];
  if (!timeline) throw new Error('Selected OTIO timeline is missing.');
  const spans =
    itemId === undefined
      ? sourceSpansForOtioRange(document, timelineId, trackId, range)
      : [];
  const item =
    itemId === undefined
      ? spans.length === 1
        ? document.nodes[spans[0]?.node_id ?? '']
        : undefined
      : itemId === null
        ? undefined
        : document.nodes[itemId];
  if (typeof itemId === 'string' && !item)
    throw new Error('Selection unavailable.');
  const track = trackId ? document.nodes[trackId] : undefined;
  const anchor: OtioAnchorV1 = {
    kind: 'otio',
    v: 1,
    relic_version: revision,
    document_sha256: document.document_sha256,
    timeline_id: timelineId,
    track_id: trackId,
    ...(item ? { item_id: item.id } : {}),
    range,
    snapshot: {
      timeline: boundedLabel(timeline.name),
      track: track ? boundedLabel(track.name) : null,
      item: item ? boundedLabel(item.name) : null,
    },
  };
  const validation = resolveOtioAnchor(anchor, document);
  if (validation.status !== 'same') {
    throw new Error('Selection unavailable.');
  }
  if (
    encoder.encode(JSON.stringify(anchor)).length >
    COMMENT_ANCHOR_OTIO_LIMIT_BYTES
  ) {
    throw new Error('This selection exceeds the encrypted anchor limit.');
  }
  return anchor;
}

interface ParsedOtioContent {
  readonly document: OtioDocumentV1;
  readonly zip?: OtioZipIndex;
}

async function parseContent(
  content: Uint8Array,
  digests: boolean
): Promise<ParsedOtioContent> {
  if (isRawOtio(content)) return { document: readOtioDocument(content) };
  const zip = await indexOtioZip(content);
  const media = await otioBundleMediaIndex(zip, { digests });
  return {
    document: readOtioDocument(zip.contentOtioBytes, { mediaIndex: media }),
    zip,
  };
}

export async function readOtioForProjection(
  content: Uint8Array
): Promise<OtioDocumentV1> {
  return (await parseContent(content, true)).document;
}

interface Lane {
  readonly node: OtioNode;
  readonly depth: number;
  readonly code: string;
  readonly path: readonly string[];
  readonly ancestors: readonly string[];
}

/** Hierarchy only. All editorial ranges come from the normalized document. */
export function otioLanes(
  document: OtioDocumentV1,
  timelineId: string
): readonly Lane[] {
  const lanes: Lane[] = [];
  let video = 0;
  let audio = 0;
  const visit = (
    id: string,
    path: readonly string[],
    ancestors: readonly string[],
    depth: number
  ): void => {
    const node = document.nodes[id];
    if (!node) return;
    const isTrack = schemaIs(node, 'Track');
    const nextPath = node.name ? [...path, node.name] : path;
    const nextAncestors = [...ancestors, id];
    if (isTrack)
      lanes.push({
        node,
        depth,
        path: nextPath,
        ancestors,
        code: node.track_kind === 'Audio' ? `A${++audio}` : `V${++video}`,
      });
    for (const child of node.children_ids)
      visit(child, nextPath, nextAncestors, depth + (isTrack ? 1 : 0));
  };
  visit(timelineId, [], [], 0);
  return lanes;
}

/** Whole-track selection uses exposed core coordinates, including nested trims. */
export function otioScopeRange(
  document: OtioDocumentV1,
  timelineId: string,
  trackId: string | null
): OtioTimeRange | undefined {
  if (!document.timeline_ids.includes(timelineId)) return undefined;
  const node =
    trackId === null
      ? document.nodes[timelineId]
      : otioLanes(document, timelineId).find((lane) => lane.node.id === trackId)
          ?.node;
  return node?.timeline_range ?? undefined;
}

export interface MountOtioViewOptions {
  readonly content: Uint8Array;
  readonly revision: number;
}

/** Called only by the shell's dynamic import after the OTIO route is chosen. */
export async function mountOtioView(
  root: HTMLElement,
  options: MountOtioViewOptions
): Promise<void> {
  if (root.dataset['disposed'] === 'true') return;
  root.classList.add('otio-view');
  root.dataset['ready'] = 'false';
  root.dataset['version'] = String(options.revision);
  const loading = element('p', 'otio-loading', 'Loading OTIO');
  root.replaceChildren(loading);
  let parsed: ParsedOtioContent;
  try {
    parsed = await parseContent(options.content, false);
  } catch (error) {
    if (root.dataset['disposed'] === 'true') return;
    root.dataset['ready'] = 'error';
    root.replaceChildren(
      element(
        'p',
        'otio-diagnostic',
        error instanceof Error ? error.message : 'OTIO could not be read.'
      )
    );
    return;
  }
  if (root.dataset['disposed'] === 'true') return;
  const doc = parsed.document;
  const resolver = parsed.zip ? createOtioMediaResolver(parsed.zip) : undefined;
  let playback: OtioPlaybackController | undefined;
  let unsubscribe: (() => void) | undefined;
  let timelineId =
    doc.timeline_ids.length === 1 ? doc.timeline_ids[0] : undefined;
  let timeline: OtioNode | undefined;
  let lanes: readonly Lane[] = [];
  let duration: OtioRationalTime = { value: 0, rate: 24 };
  let rate = 24;
  let selected: OtioAnchorV1 | null = null;
  let projectedSelection: {
    readonly anchor: OtioAnchorV1;
    readonly target: OtioProjectionTarget;
  } | null = null;
  let selectedTrack: string | null = null;
  let mode: 'point' | 'range' | 'track' = 'range';
  let inspected: OtioNode | undefined;
  let focusedNode: OtioNode | undefined;
  let focusedRange: OtioTimeRange | undefined;
  let focusUnavailable: string | null = null;
  let focusNotice: string | null = null;
  let scopeGeneration = 0;
  let cancelRailGesture: (() => void) | undefined;
  let domain: OtioTimelineDomain = {
    origin: { value: 0, rate: 24 },
    range: {
      start_time: { value: 0, rate: 24 },
      duration: { value: 0, rate: 24 },
    },
    rate: 24,
  };
  let pixelsPerFrame = 1;
  let zoomMode: 'fit' | 'manual' = 'fit';
  let railViewportWidth = 0;
  let railLabelWidth = 0;
  let rulerPaint:
    | {
        ticks: HTMLElement;
        domain: OtioTimelineDomain;
        step: number;
        first: number;
        last: number;
      }
    | undefined;
  let paintedTracks: OtioPlaybackState['tracks'] | undefined;
  let paintedDiagnostics: OtioPlaybackState['diagnostics'] | undefined;
  let paintedStatus: OtioPlaybackState | undefined;
  let paintedStatusScope: OtioNode | undefined;
  let paintedStatusUnavailable: string | null = null;
  let paintedStatusNotice: string | null = null;
  let paintedStatusSettled = false;
  let viewportKey = '';
  let pendingTimelineScroll: { key: string; top: number } | undefined;
  let pendingCommentReveal: { key: string; id: string } | undefined;
  let markBatchGeneration = 0;
  let markBatchComplete = true;
  const viewports = new Map<
    string,
    { scale: number; left: number; top: number; mode: 'fit' | 'manual' }
  >();
  let currentTab: 'inspector' | 'markers' | 'media' = 'inspector';
  let disposed = false;
  let timelineSettled = false;
  const collapsed = new Set<string>();
  const rails = new Map<string | null, HTMLElement>();
  const commentBands = new Map<string | null, HTMLElement>();
  let repackQueued = false;
  const rows = new Map<string, HTMLElement>();
  const projections = new Map<string, OtioAnchorResolution>();
  const originals = new Map<string, Promise<OtioDocumentV1>>();
  let currentProjectionDocument: Promise<OtioDocumentV1> | undefined;
  const marks = new Map<string, readonly HTMLElement[]>();
  const cleanup: (() => void)[] = [];

  const monitor = element('div', 'otio-monitor-row');
  monitor.id = `otio-monitor-${++nextMonitorId}`;
  const preview = element('div', 'otio-preview');
  const canvas = element('canvas', 'otio-canvas');
  canvas.width = 960;
  canvas.height = 540;
  canvas.setAttribute('aria-label', 'OTIO composition preview');
  const previewStatus = element('div', 'otio-preview-status');
  previewStatus.setAttribute('role', 'status');
  const sdr = element('span', 'otio-preview-scope');
  const scopeText = element('span', '', 'Composition · browser-managed SDR');
  const blockBase = button(
    'Block affected playback',
    'otio-preview-block',
    () => playback?.setBaseMediaPreviewAllowed(false)
  );
  blockBase.hidden = true;
  sdr.append(scopeText, blockBase);
  preview.append(canvas, sdr, previewStatus);
  const inspector = element('aside', 'otio-inspector');
  inspector.setAttribute('aria-label', 'OTIO source context');
  const tabs = element('div', 'otio-inspector-tabs');
  tabs.setAttribute('role', 'tablist');
  const context = element('div', 'otio-context');
  context.setAttribute('role', 'tabpanel');
  for (const value of ['inspector', 'markers', 'media'] as const) {
    const tab = button(
      value.charAt(0).toUpperCase() + value.slice(1),
      'otio-inspector-tab',
      () => {
        currentTab = value;
        paintInspector();
      }
    );
    tab.dataset['tab'] = value;
    tab.setAttribute('role', 'tab');
    tabs.append(tab);
  }
  const inspectClose = button('Close inspector', 'otio-inspector-close', () =>
    setInspectorOpen(false, true)
  );
  inspector.append(tabs, context, inspectClose);
  inspector.addEventListener('keydown', (event) => {
    if (
      event.key === 'Escape' &&
      window.matchMedia('(max-width: 44rem)').matches
    ) {
      event.preventDefault();
      setInspectorOpen(false, true);
    }
  });
  monitor.append(preview, inspector);

  const transport = element('div', 'otio-transport');
  transport.setAttribute('aria-label', 'OTIO playback');
  const focusContext = element('div', 'otio-focus-context');
  focusContext.hidden = true;
  const focusTitle = element('span', 'otio-focus-title');
  const back = button('Back to composition', 'otio-back-composition', () => {
    const previousId = focusedNode?.id;
    setPlaybackFocus();
    selectedTrack = null;
    clearSelection();
    inspected = timeline;
    paintInspector();
    Array.from(
      trackRows.querySelectorAll<HTMLButtonElement>('[data-focus-node-id]')
    )
      .find((control) => control.dataset['focusNodeId'] === previousId)
      ?.focus({ preventScroll: true });
  });
  focusContext.append(focusTitle, back);
  const previous = button('Previous frame', 'otio-previous-frame', () =>
    seekFrame(currentFrame() - 1)
  );
  const play = button('Play', 'otio-play', () => {
    if (playback?.getState().playing) playback.pause();
    else void playback?.play().catch(reportPlaybackError);
  });
  const next = button('Next frame', 'otio-next-frame', () =>
    seekFrame(currentFrame() + 1)
  );
  for (const [control, pathData] of [
    [previous, 'M4 3v10M12 4l-6 4 6 4'],
    [next, 'M12 3v10M4 4l6 4-6 4'],
  ] as const) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'otio-frame-icon');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(icon.namespaceURI, 'path');
    path.setAttribute('d', pathData);
    icon.append(path);
    control.append(icon);
  }
  const clock = element('output', 'otio-time');
  const seek = element('input', 'otio-seek');
  seek.type = 'range';
  seek.min = '0';
  seek.step = 'any';
  seek.value = '0';
  seek.setAttribute('aria-label', 'Timeline frame');
  seek.addEventListener('input', () => seekFrame(Number(seek.value)));
  const inspectToggle = button('Inspector', 'otio-inspector-toggle', () =>
    setInspectorOpen(monitor.dataset['inspectorOpen'] !== 'true')
  );
  function setInspectorOpen(open: boolean, restoreFocus = false): void {
    monitor.dataset['inspectorOpen'] = String(open);
    inspectToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      tabs
        .querySelector<HTMLElement>(
          `.otio-inspector-tab[data-tab="${currentTab}"]`
        )
        ?.focus({ preventScroll: true });
    } else if (restoreFocus) inspectToggle.focus({ preventScroll: true });
  }
  inspectToggle.setAttribute('aria-expanded', 'false');
  transport.append(
    focusContext,
    previous,
    play,
    next,
    clock,
    seek,
    inspectToggle
  );

  const heading = element('div', 'otio-timeline-heading');
  const name = element('h2', 'otio-timeline-name');
  const timelineSelect = element('select', 'otio-timeline-select');
  timelineSelect.setAttribute('aria-label', 'Timeline');
  if (doc.timeline_ids.length !== 1)
    timelineSelect.append(element('option', '', 'Select timeline'));
  for (const id of doc.timeline_ids) {
    const option = element('option', '', doc.nodes[id]?.name || id);
    option.value = id;
    timelineSelect.append(option);
  }
  timelineSelect.hidden = doc.timeline_ids.length < 2;
  timelineSelect.addEventListener('change', () => {
    if (doc.timeline_ids.includes(timelineSelect.value)) {
      timelineId = timelineSelect.value;
      initializeTimeline();
    }
  });
  const tools = element('div', 'otio-selection-tools');
  const trackSelect = element('select', 'otio-track-select');
  trackSelect.setAttribute('aria-label', 'Comment track');
  trackSelect.addEventListener('change', () => {
    // Repainting the old aim during scope changes updates this select too.
    // Capture the user's choice before changing the displayed domain.
    const trackId = trackSelect.value || null;
    const start =
      selected?.range.start_time ?? otioCompositionTime(domain, currentFrame());
    const end = selected
      ? rangeEndTime(selected.range)
      : otioCompositionTime(
          domain,
          currentFrame() + (mode === 'point' ? 0 : 1)
        );
    setPlaybackFocus();
    selectedTrack = trackId;
    trackSelect.value = trackId ?? '';
    selectFrames(
      selectedTrack,
      otioLocalTime(domain, start).value,
      otioLocalTime(domain, end).value,
      false
    );
  });
  for (const value of ['point', 'range', 'track'] as const) {
    const control = button(
      value === 'track'
        ? 'Whole track'
        : value.charAt(0).toUpperCase() + value.slice(1),
      'otio-mode',
      () => {
        mode = value;
        if (value === 'track' && focusedNode)
          setPlaybackFocus(
            selectedTrack ? doc.nodes[selectedTrack] : undefined
          );
        const start = selected
          ? otioLocalTime(domain, selected.range.start_time).value
          : currentFrame();
        const end = selected
          ? otioLocalTime(domain, rangeEndTime(selected.range)).value
          : start + 1;
        selectFrames(
          selectedTrack,
          value === 'track' ? playbackFrames().start : start,
          value === 'point'
            ? start
            : value === 'track'
              ? playbackFrames().end
              : Math.max(start + 1, end),
          false
        );
        paintModes();
        if (focusedNode) emitAim(false);
      }
    );
    control.dataset['otioMode'] = value;
    tools.append(control);
  }
  tools.append(trackSelect);
  heading.append(name, timelineSelect, tools);
  const zoomTools = element('div', 'otio-zoom-tools');
  zoomTools.setAttribute('aria-label', 'Timeline zoom');
  const zoomOut = button('-', 'otio-zoom-out', () => zoomTimeline(1 / 1.5));
  zoomOut.setAttribute('aria-label', 'Zoom out');
  const zoomIn = button('+', 'otio-zoom-in', () => zoomTimeline(1.5));
  zoomIn.setAttribute('aria-label', 'Zoom in');
  const zoomFit = button('Fit', 'otio-zoom-fit', () => fitTimeline());
  const zoomReadout = element('output', 'otio-zoom-readout');
  zoomReadout.setAttribute('aria-label', 'Timeline scale');
  zoomTools.append(zoomOut, zoomIn, zoomFit, zoomReadout);
  heading.append(zoomTools);
  const scroll = element('div', 'otio-timeline-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('aria-label', 'Timeline tracks');
  const resizeHandle = element('div', 'otio-resize-handle');
  resizeHandle.tabIndex = 0;
  resizeHandle.setAttribute('role', 'separator');
  resizeHandle.setAttribute('aria-orientation', 'horizontal');
  resizeHandle.setAttribute('aria-label', 'Resize media preview and timeline');
  resizeHandle.setAttribute('aria-controls', monitor.id);
  resizeHandle.setAttribute(
    'aria-description',
    'Drag or use Arrow up and Arrow down to resize. Home shows more timeline; End shows more media preview.'
  );
  resizeHandle.title =
    'Resize media preview and timeline (drag or use Arrow up and Arrow down)';
  const grid = element('div', 'otio-track-grid');
  const ruler = element('div', 'otio-ruler');
  const trackRows = element('div', 'otio-track-rows');
  const playhead = element('div', 'otio-playhead');
  playhead.setAttribute('aria-hidden', 'true');
  grid.append(ruler, trackRows, playhead);
  scroll.append(grid);
  const selectionBar = element('div', 'otio-selection-readout');
  const selectionLabel = element('span', 'otio-selection-label', 'Composition');
  const inputIn = element('input', 'otio-selection-in');
  inputIn.type = 'number';
  inputIn.min = '0';
  inputIn.step = 'any';
  inputIn.setAttribute('aria-label', 'Selection in frame');
  const inputOut = element('input', 'otio-selection-out');
  inputOut.type = 'number';
  inputOut.min = '0';
  inputOut.step = 'any';
  inputOut.setAttribute('aria-label', 'Selection out frame');
  const inLabel = element('label', '', 'In ');
  inLabel.append(inputIn);
  const outLabel = element('label', '', 'Out ');
  outLabel.append(inputOut);
  const applyInputs = (): void => {
    const bounds = playbackFrames();
    const parsedStart = Number(inputIn.value);
    const parsedEnd = Number(inputOut.value);
    const requestedStart = Number.isFinite(parsedStart)
      ? parsedStart
      : bounds.start;
    const start = Math.max(
      bounds.start,
      requestedStart < bounds.end ? requestedStart : bounds.last
    );
    const end =
      mode === 'point'
        ? start
        : Math.min(
            bounds.end,
            Number.isFinite(parsedEnd) && parsedEnd > start
              ? parsedEnd
              : start + 1
          );
    selectFrames(selectedTrack, start, end, false);
    if (focusedNode) emitAim(false);
  };
  inputIn.addEventListener('change', applyInputs);
  inputOut.addEventListener('change', applyInputs);
  const comment = button('Comment', 'otio-comment-selection', () => {
    if (!selected)
      selectFrames(
        selectedTrack,
        currentFrame(),
        mode === 'point' ? currentFrame() : currentFrame() + 1,
        false
      );
    emitAim(true);
  });
  const clear = button('Clear', 'otio-clear-selection', () => clearSelection());
  selectionBar.append(selectionLabel, inLabel, outLabel, comment, clear);
  const diagnostics = element('div', 'otio-diagnostics');
  diagnostics.setAttribute('role', 'status');
  root.replaceChildren(
    monitor,
    resizeHandle,
    transport,
    heading,
    scroll,
    selectionBar,
    diagnostics
  );

  let timelineFraction: number | undefined;
  let cancelResizeGesture: (() => void) | undefined;
  const fixedRows = [transport, heading, selectionBar, diagnostics];
  const splitBounds = () => {
    const available = Math.max(
      0,
      root.clientHeight -
        resizeHandle.getBoundingClientRect().height -
        fixedRows.reduce(
          (height, row) => height + row.getBoundingClientRect().height,
          0
        )
    );
    // Keep a preview and at least a ruler/track visible. On short viewports the
    // floors scale down instead of forcing the controls outside the stage.
    return {
      available,
      minimum: Math.min(
        96,
        available * 0.25,
        grid.getBoundingClientRect().height
      ),
      maximum: available - Math.min(160, available * 0.4),
    };
  };
  function refreshSplit(): void {
    if (disposed) return;
    const { available, minimum, maximum } = splitBounds();
    monitor.style.minHeight = `${available - maximum}px`;
    if (timelineFraction !== undefined) {
      const height = `${Math.max(minimum, Math.min(maximum, available * timelineFraction))}px`;
      if (scroll.style.height !== height) {
        scroll.style.height = height;
        // The existing popover follows inner scroll events. A new pane height
        // moves its target even when the scroll offsets themselves stay put.
        scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
    }
    const timelineHeight =
      timelineFraction === undefined
        ? scroll.getBoundingClientRect().height
        : Math.max(minimum, Math.min(maximum, available * timelineFraction));
    const mediaPercent = available
      ? Math.round((1 - Math.min(available, timelineHeight) / available) * 100)
      : 0;
    const minimumPercent = available
      ? Math.round((1 - maximum / available) * 100)
      : 0;
    const maximumPercent = available
      ? Math.round((1 - minimum / available) * 100)
      : 0;
    // Report the actual content-sized default before the first adjustment.
    resizeHandle.setAttribute(
      'aria-valuemin',
      String(Math.min(minimumPercent, mediaPercent))
    );
    resizeHandle.setAttribute(
      'aria-valuemax',
      String(Math.max(maximumPercent, mediaPercent))
    );
    resizeHandle.setAttribute('aria-valuenow', String(mediaPercent));
    resizeHandle.setAttribute(
      'aria-valuetext',
      `Media preview ${mediaPercent}%; timeline ${available ? 100 - mediaPercent : 0}%`
    );
    resizeHandle.setAttribute('aria-disabled', String(available <= 0));
  }
  function setTimelineHeight(height: number): void {
    const { available, minimum, maximum } = splitBounds();
    if (available <= 0) return;
    timelineFraction = Math.max(minimum, Math.min(maximum, height)) / available;
    root.classList.add('is-resized');
    refreshSplit();
  }
  const startResize = (event: PointerEvent): void => {
    if (
      disposed ||
      cancelResizeGesture ||
      cancelRailGesture ||
      event.button !== 0 ||
      event.isPrimary === false ||
      splitBounds().available <= 0
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const previousFraction = timelineFraction;
    const startHeight = scroll.getBoundingClientRect().height;
    const startY = event.clientY;
    let dragging = false;
    resizeHandle.setPointerCapture(pointerId);
    root.classList.add('is-resizing');
    const move = (moved: PointerEvent): void => {
      if (moved.pointerId !== pointerId) return;
      moved.preventDefault();
      moved.stopPropagation();
      if (!dragging && Math.abs(moved.clientY - startY) < 2) return;
      dragging = true;
      setTimelineHeight(startHeight - (moved.clientY - startY));
    };
    const release = (): void => {
      resizeHandle.removeEventListener('pointermove', move);
      resizeHandle.removeEventListener('pointerup', done);
      resizeHandle.removeEventListener('pointercancel', cancel);
      resizeHandle.removeEventListener('lostpointercapture', cancel);
      window.removeEventListener('blur', cancel);
      root.classList.remove('is-resizing');
      cancelResizeGesture = undefined;
      if (resizeHandle.hasPointerCapture(pointerId))
        resizeHandle.releasePointerCapture(pointerId);
    };
    const done = (released: PointerEvent): void => {
      if (released.pointerId !== pointerId) return;
      move(released);
      release();
    };
    const cancel = (cancelled?: Event): void => {
      if (
        cancelled &&
        'pointerId' in cancelled &&
        cancelled.pointerId !== pointerId
      )
        return;
      cancelled?.stopPropagation();
      release();
      timelineFraction = previousFraction;
      root.classList.toggle('is-resized', timelineFraction !== undefined);
      if (timelineFraction === undefined) scroll.style.height = '';
      refreshSplit();
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
    };
    cancelResizeGesture = cancel;
    resizeHandle.addEventListener('pointermove', move);
    resizeHandle.addEventListener('pointerup', done);
    resizeHandle.addEventListener('pointercancel', cancel);
    resizeHandle.addEventListener('lostpointercapture', cancel);
    window.addEventListener('blur', cancel);
  };
  const resizeWithKeyboard = (event: KeyboardEvent): void => {
    if (
      disposed ||
      !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const { minimum, maximum } = splitBounds();
    const step = event.shiftKey ? 64 : 16;
    setTimelineHeight(
      event.key === 'Home'
        ? maximum
        : event.key === 'End'
          ? minimum
          : scroll.getBoundingClientRect().height +
            (event.key === 'ArrowUp' ? step : -step)
    );
  };
  const stopResizeClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  resizeHandle.addEventListener('pointerdown', startResize);
  resizeHandle.addEventListener('keydown', resizeWithKeyboard);
  resizeHandle.addEventListener('click', stopResizeClick);
  window.addEventListener('resize', refreshSplit);
  cleanup.push(() => {
    cancelResizeGesture?.();
    resizeHandle.removeEventListener('pointerdown', startResize);
    resizeHandle.removeEventListener('keydown', resizeWithKeyboard);
    resizeHandle.removeEventListener('click', stopResizeClick);
    window.removeEventListener('resize', refreshSplit);
  });

  function scopeIncludesTrack(lane: Lane): boolean {
    if (!focusedNode || lane.node.id === ownerTrackId(focusedNode.id))
      return true;
    if (focusedNode.children_ids.length)
      return (
        lane.node.id === focusedNode.id ||
        lane.ancestors.includes(focusedNode.id)
      );
    return lane.node.id === ownerTrackId(focusedNode.id);
  }

  function scopeIncludesItem(id: string | undefined): boolean {
    if (!focusedNode || !id || id === focusedNode.id) return true;
    if (!focusedNode.children_ids.length) return false;
    let node = doc.nodes[id];
    while (node?.parent_id) {
      if (node.parent_id === focusedNode.id) return true;
      node = doc.nodes[node.parent_id];
    }
    return false;
  }

  function viewportDimensions(): { label: number; width: number } {
    const label =
      ruler
        .querySelector<HTMLElement>('.otio-ruler-label')
        ?.getBoundingClientRect().width ?? 0;
    return { label, width: Math.max(1, scroll.clientWidth - label) };
  }

  function rememberTimelineViewport(): void {
    if (!viewportKey) return;
    viewports.set(viewportKey, {
      scale: pixelsPerFrame,
      left: scroll.scrollLeft,
      top:
        pendingTimelineScroll?.key === viewportKey
          ? pendingTimelineScroll.top
          : scroll.scrollTop,
      mode: zoomMode,
    });
  }

  function cancelPendingTimelineNavigation(): void {
    pendingTimelineScroll = undefined;
    pendingCommentReveal = undefined;
  }

  function revealPendingComment(): boolean {
    const pending = pendingCommentReveal;
    if (!pending || disposed || pending.key !== viewportKey) return false;
    const mark = marks
      .get(pending.id)
      ?.find(
        (piece) =>
          piece.isConnected &&
          !piece.hidden &&
          !piece.closest<HTMLElement>('.otio-track-row')?.hidden
      );
    if (!mark) {
      if (markBatchComplete) pendingCommentReveal = undefined;
      return false;
    }
    revealTimelineTarget(mark, true);
    // Keep following a partially painted batch until its final packed layout.
    if (!markBatchComplete) pendingCommentReveal = pending;
    return true;
  }

  function applyPendingTimelineScroll(afterRepack = false): void {
    const pending = pendingTimelineScroll;
    if (!pending || pending.key !== viewportKey || disposed) return;
    scroll.scrollTop = pending.top;
    // The shell explicitly completes projection-backed mark batches. Before
    // completion a clamp may be temporary; after it, an unreachable top settles.
    if (
      afterRepack &&
      (scroll.scrollTop === pending.top || markBatchComplete)
    ) {
      pendingTimelineScroll = undefined;
      rememberTimelineViewport();
    }
  }

  function paintRuler(): void {
    const ticks = ruler.querySelector<HTMLElement>('.otio-ruler-ticks');
    if (!ticks) return;
    const frames = playbackFrames();
    if (frames.duration <= 0) {
      if (ticks.children.length) ticks.replaceChildren();
      rulerPaint = undefined;
      return;
    }
    // Only visible ticks exist, including at very large inspection scales.
    const desired = Math.max(1, 86 / pixelsPerFrame);
    const magnitude = 10 ** Math.floor(Math.log10(desired));
    const step =
      [1, 2, 5, 10]
        .map((factor) => magnitude * factor)
        .find((candidate) => candidate >= desired) ?? magnitude * 10;
    const firstVisible = frames.start + scroll.scrollLeft / pixelsPerFrame;
    const lastVisible = Math.min(
      frames.end,
      firstVisible + railViewportWidth / pixelsPerFrame
    );
    const first = Math.ceil(firstVisible / step) * step;
    const last = Math.floor(lastVisible / step) * step;
    if (
      rulerPaint?.ticks === ticks &&
      rulerPaint.domain === domain &&
      rulerPaint.step === step &&
      rulerPaint.first === first &&
      rulerPaint.last === last
    )
      return;
    rulerPaint = { ticks, domain, step, first, last };
    ticks.replaceChildren();
    for (let frame = first; frame <= last; frame += step) {
      const tick = element('span', '', formatOtioTime({ value: frame, rate }));
      tick.style.left = `${((frame - frames.start) / frames.duration) * 100}%`;
      ticks.append(tick);
    }
  }

  function paintTimelineGeometry(
    reposition = true,
    dimensions = viewportDimensions()
  ): void {
    const { label, width } = dimensions;
    railLabelWidth = label;
    railViewportWidth = width;
    const frames = playbackFrames();
    grid.style.width = `${label + (frames.duration > 0 ? frames.duration * pixelsPerFrame : width)}px`;
    scroll.dataset['pixelsPerFrame'] = String(pixelsPerFrame);
    scroll.dataset['zoomMode'] = zoomMode;
    zoomReadout.textContent =
      zoomMode === 'fit'
        ? 'Fit'
        : `${Number(pixelsPerFrame.toFixed(2))} px/frame`;
    zoomReadout.title = `${pixelsPerFrame} CSS pixels per frame`;
    zoomFit.setAttribute('aria-pressed', String(zoomMode === 'fit'));
    const limits = otioZoomLimits(domain, width);
    zoomOut.disabled = pixelsPerFrame <= limits.fit || frames.duration <= 0;
    zoomIn.disabled = pixelsPerFrame >= limits.maximum || frames.duration <= 0;
    zoomFit.disabled = frames.duration <= 0;
    // Positions are percentages of the canonical domain. Zoom and resize
    // scale them through the grid width without rewriting every lane/anchor.
    if (reposition) {
      for (const mark of trackRows.querySelectorAll<HTMLElement>(
        '[data-start]'
      )) {
        const range = {
          start_time: {
            value: Number(mark.dataset['start']),
            rate: Number(mark.dataset['rate']),
          },
          duration: {
            value: Number(mark.dataset['duration']),
            rate: Number(mark.dataset['durationRate']),
          },
        };
        positionMark(mark, range);
        if (
          !scopeIncludesItem(mark.dataset['itemId'] ?? mark.dataset['ownerId'])
        )
          mark.hidden = true;
      }
      for (const item of trackRows.querySelectorAll<HTMLElement>(
        '.otio-item'
      )) {
        const node = doc.nodes[item.dataset['itemId'] ?? ''];
        if (!node) continue;
        const range =
          node.timeline_range ??
          (focusedNode?.id === node.id ? focusedRange : undefined);
        if (range) {
          positionMark(item, range);
          item.classList.remove('is-trimmed-out');
          item.textContent = node.name || node.schema;
        } else {
          item.hidden = !scopeIncludesItem(node.id);
          if (!item.classList.contains('is-unplaced')) {
            item.classList.add('is-trimmed-out');
            item.textContent = `Trimmed out · ${node.name || node.schema}`;
          }
          item.style.left = '';
          item.style.width = '';
        }
        if (!scopeIncludesItem(node.id)) item.hidden = true;
      }
      applyDisclosure();
    }
    queueCommentRepack();
  }

  function restoreTimelineViewport(rebuildTracks = false): void {
    viewportKey = `${timelineId ?? ''}:${focusedNode?.id ?? ''}:${domain.range.start_time.value}@${domain.range.start_time.rate}:${domain.range.duration.value}@${domain.range.duration.rate}`;
    ruler.replaceChildren(
      element('div', 'otio-ruler-label', `${rate} fps`),
      element('div', 'otio-ruler-ticks')
    );
    const saved = viewports.get(viewportKey);
    pendingTimelineScroll =
      saved && saved.top > 0 ? { key: viewportKey, top: saved.top } : undefined;
    const { width } = viewportDimensions();
    zoomMode = saved?.mode ?? 'fit';
    const limits = otioZoomLimits(domain, width);
    pixelsPerFrame =
      zoomMode === 'fit'
        ? limits.fit
        : Math.max(
            limits.fit,
            Math.min(limits.maximum, saved?.scale ?? limits.fit)
          );
    const frames = playbackFrames();
    inputIn.min = inputOut.min = String(frames.start);
    inputIn.max = String(frames.end);
    inputOut.max = String(frames.end);
    root.dataset['domainOrigin'] = String(
      rescaleTime(domain.origin, rate).value
    );
    root.dataset['domainStart'] = String(
      rescaleTime(domain.range.start_time, rate).value
    );
    root.dataset['domainDuration'] = String(frames.duration);
    root.dataset['domainRate'] = String(rate);
    // Scroll offsets clamp against the destination's actual rows. Rebuild
    // before applying the saved viewport, without saving an intermediate clamp.
    if (rebuildTracks) paintTracks();
    paintTimelineGeometry();
    scroll.scrollLeft = saved?.left ?? 0;
    if (pendingTimelineScroll) applyPendingTimelineScroll();
    else scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
  }

  function updateTimelineDomain(): void {
    pendingCommentReveal = undefined;
    rememberTimelineViewport();
    const composition = timeline?.timeline_range ?? {
      start_time: { value: 0, rate },
      duration,
    };
    const range = focusedRange ?? composition;
    domain = {
      origin: focusedNode?.timeline_range?.start_time ?? range.start_time,
      range,
      rate,
    };
    root.dataset['handleContext'] = String(
      !!focusedNode &&
        (!focusedNode.timeline_range || range !== focusedNode.timeline_range)
    );
    if (root.dataset['handleContext'] === 'true')
      focusTitle.textContent = `${focusedNode?.name || focusedNode?.schema} · Transition handles`;
    restoreTimelineViewport();
    paintSelection();
  }

  function zoomTimeline(factor: number, pointerX?: number): void {
    if (disposed || cancelRailGesture || cancelResizeGesture) return;
    cancelPendingTimelineNavigation();
    const dimensions = viewportDimensions();
    const { width } = dimensions;
    const next = otioZoomAt(
      { domain, pixelsPerFrame, scrollLeft: scroll.scrollLeft },
      width,
      pointerX ?? width / 2,
      pixelsPerFrame * factor
    );
    if (
      zoomMode === 'manual' &&
      next.pixelsPerFrame === pixelsPerFrame &&
      next.scrollLeft === scroll.scrollLeft
    )
      return;
    zoomMode = 'manual';
    pixelsPerFrame = next.pixelsPerFrame;
    paintTimelineGeometry(false, dimensions);
    scroll.scrollLeft = next.scrollLeft;
    rememberTimelineViewport();
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
  }

  function fitTimeline(): void {
    if (disposed || cancelRailGesture || cancelResizeGesture) return;
    cancelPendingTimelineNavigation();
    zoomMode = 'fit';
    const dimensions = viewportDimensions();
    pixelsPerFrame = otioZoomLimits(domain, dimensions.width).fit;
    paintTimelineGeometry(false, dimensions);
    scroll.scrollLeft = 0;
    rememberTimelineViewport();
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
  }

  function refreshTimelineViewport(): void {
    if (disposed) return;
    const dimensions = viewportDimensions();
    const { width } = dimensions;
    if (width === railViewportWidth) return;
    // Preserve the visible centre in manual mode. Fit alone follows the width.
    const pivot = (scroll.scrollLeft + railViewportWidth / 2) / pixelsPerFrame;
    if (zoomMode === 'fit') pixelsPerFrame = otioZoomLimits(domain, width).fit;
    paintTimelineGeometry(false, dimensions);
    if (zoomMode === 'manual')
      scroll.scrollLeft = Math.max(0, pivot * pixelsPerFrame - width / 2);
    rememberTimelineViewport();
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
  }

  scroll.addEventListener('pointerdown', () => {
    cancelPendingTimelineNavigation();
  });
  scroll.addEventListener('scroll', () => {
    rememberTimelineViewport();
    paintRuler();
  });
  scroll.addEventListener(
    'wheel',
    (event) => {
      if (event.ctrlKey || event.metaKey || !(event.target instanceof Element))
        return;
      cancelPendingTimelineNavigation();
      if (
        !event.target.closest(
          '.otio-ruler-ticks, .otio-track-rail, .otio-comment-band'
        )
      )
        return;
      event.preventDefault();
      if (cancelRailGesture || cancelResizeGesture) return;
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? scroll.clientHeight
            : 1;
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        scroll.scrollLeft +=
          (Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY) * unit;
      } else {
        zoomTimeline(
          Math.exp(
            -Math.max(-240, Math.min(240, event.deltaY * unit)) * 0.0025
          ),
          event.clientX -
            scroll.getBoundingClientRect().left -
            scroll.clientLeft -
            railLabelWidth
        );
      }
    },
    { passive: false }
  );
  scroll.addEventListener('keydown', (event) => {
    if (
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.target instanceof Element &&
      !event.target.closest('input, textarea, select, [contenteditable]') &&
      [
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'PageUp',
        'PageDown',
        'Home',
        'End',
        ' ',
        '-',
        '+',
        '=',
        '0',
      ].includes(event.key)
    )
      cancelPendingTimelineNavigation();
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !(event.target instanceof Element) ||
      event.target.closest('input, textarea, select, [contenteditable]') ||
      !['-', '+', '=', '0'].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === '0') fitTimeline();
    else zoomTimeline(event.key === '-' ? 1 / 1.5 : 1.5);
  });
  function currentFrame(): number {
    const time = playback?.getState().time;
    return time ? otioLocalTime(domain, time).value : playbackFrames().start;
  }
  function frameCount(): number {
    return Math.max(0, Math.ceil(rescaleTime(duration, rate).value));
  }
  function reportPlaybackError(error: unknown): void {
    if (disposed) return;
    paintedStatus = undefined;
    root.dataset['ready'] = 'diagnostic';
    root.dataset['previewState'] = 'diagnostic';
    previewStatus.hidden = false;
    previewStatus.replaceChildren(
      element(
        'p',
        'otio-diagnostic',
        error instanceof Error ? error.message : 'Playback unavailable.'
      )
    );
  }
  function seekFrame(frame: number): void {
    const current = playback;
    if (!current || focusUnavailable) return;
    const bounds = playbackFrames();
    const time = otioCompositionTime(
      domain,
      Math.max(bounds.start, frame < bounds.end ? frame : bounds.last)
    );
    current.pause();
    const generation = ++scopeGeneration;
    void current.seek(time).catch((error) => {
      if (playback === current && generation === scopeGeneration)
        reportPlaybackError(error);
    });
  }
  function playbackFrames(): OtioDomainFrameBounds {
    return otioDomainFrames(domain);
  }
  function paintFocus(): void {
    root.dataset['scopeNodeId'] = focusedNode?.id ?? '';
    root.dataset['scopeAvailable'] = String(!focusUnavailable);
    root.classList.toggle('is-element-focused', focusedNode !== undefined);
    focusContext.hidden = !focusedNode;
    focusTitle.textContent = focusedNode
      ? focusedNode.name || focusedNode.schema
      : '';
    canvas.setAttribute(
      'aria-label',
      focusedNode
        ? `${focusedNode.name || focusedNode.schema} · OTIO preview`
        : 'OTIO composition preview'
    );
    for (const control of trackRows.querySelectorAll<HTMLButtonElement>(
      '[data-focus-node-id]'
    ))
      control.setAttribute(
        'aria-pressed',
        String(control.dataset['focusNodeId'] === focusedNode?.id)
      );
  }
  function setPlaybackFocus(
    node?: OtioNode,
    time?: OtioRationalTime,
    targetRange?: OtioTimeRange
  ): void {
    const generation = ++scopeGeneration;
    focusedNode = node;
    const body = node?.timeline_range ?? undefined;
    const exposed = node?.visible_timeline_range ?? body;
    focusedRange = body;
    if (
      time &&
      exposed &&
      (!body ||
        body.duration.value <= 0 ||
        compareRationalTimes(time, body.start_time) < 0 ||
        compareRationalTimes(time, rangeEndTime(body)) >= 0 ||
        (targetRange &&
          compareRationalTimes(rangeEndTime(targetRange), rangeEndTime(body)) >
            0))
    )
      focusedRange = exposed;
    focusUnavailable =
      node && (!focusedRange || focusedRange.duration.value <= 0)
        ? 'Playback unavailable. Selection unavailable.'
        : null;
    focusNotice =
      node && schemaIs(node, 'Gap')
        ? `${node.name || node.schema} · No media · black/silence`
        : null;
    let ancestor = node;
    while (ancestor) {
      if (!ancestor.enabled) {
        focusNotice = `${node?.name || node?.schema} · Disabled · black/silence`;
        break;
      }
      ancestor = ancestor.parent_id ? doc.nodes[ancestor.parent_id] : undefined;
    }
    paintFocus();
    updateTimelineDomain();
    const current = playback;
    if (!current) return;
    void current
      .setScope(
        node && focusedRange && !focusUnavailable
          ? { nodeId: node.id, range: focusedRange }
          : null
      )
      .then(async () => {
        if (disposed || playback !== current || generation !== scopeGeneration)
          return;
        if (time && !focusUnavailable) await current.seek(time);
      })
      .catch((error) => {
        if (!disposed && playback === current && generation === scopeGeneration)
          reportPlaybackError(error);
      });
    paintState(current.getState());
  }
  function activateNode(node: OtioNode): void {
    if (disposed) return;
    const trackId = ownerTrackId(node.id);
    setPlaybackFocus(schemaIs(node, 'Timeline') ? undefined : node);
    mode = 'range';
    currentTab = 'inspector';
    paintModes();
    if (node.timeline_range && node.timeline_range.duration.value > 0) {
      selectRange(
        trackId,
        node.timeline_range,
        false,
        schemaIs(node, 'Track') || schemaIs(node, 'Timeline') ? null : node.id,
        false
      );
    } else {
      selectedTrack = trackId;
      clearSelection();
    }
    inspected = node;
    paintInspector();
    emitAim(false);
  }
  function paintModes(): void {
    for (const control of tools.querySelectorAll<HTMLButtonElement>(
      '[data-otio-mode]'
    ))
      control.setAttribute(
        'aria-pressed',
        String(control.dataset['otioMode'] === mode)
      );
  }

  function clearSelection(): void {
    selected = null;
    projectedSelection = null;
    paintSelection();
    paintInspector();
    root.dispatchEvent(
      new CustomEvent('relic:otio-selection-cleared', { bubbles: true })
    );
  }

  function selectionUnavailable(trackId: string | null, message: string): void {
    selectedTrack = trackId;
    inspected = trackId ? doc.nodes[trackId] : timeline;
    clearSelection();
    paintedDiagnostics = undefined;
    diagnostics.replaceChildren(element('p', 'otio-diagnostic', message));
  }

  function projectionOf(
    anchor: OtioAnchorV1
  ): OtioProjectionTarget | undefined {
    const key = projectionsKey(anchor);
    let resolution = projections.get(key);
    if (!resolution && anchor.relic_version === options.revision) {
      resolution = resolveOtioAnchor(anchor, doc, doc);
      projections.set(key, resolution);
    }
    return otioProjectionTarget(
      anchor,
      options.revision,
      doc,
      timelineId,
      resolution
    );
  }
  function selectFrames(
    trackId: string | null,
    start: number,
    end: number,
    focus: boolean
  ): void {
    if (!timelineId || frameCount() === 0 || focusUnavailable) return;
    const item =
      focusedNode && ownerTrackId(focusedNode.id) === trackId
        ? focusedNode
        : undefined;
    const bounds = playbackFrames();
    const requestedStart = Math.min(start, end);
    const a = Math.max(
      bounds.start,
      requestedStart < bounds.end ? requestedStart : bounds.last
    );
    const b = Math.max(a, Math.min(bounds.end, Math.max(start, end)));
    const range =
      mode === 'track'
        ? otioScopeRange(doc, timelineId, trackId)
        : {
            start_time: otioCompositionTime(domain, a),
            duration: {
              value:
                mode === 'point'
                  ? 0
                  : Math.min(bounds.end - a, b > a ? b - a : 1),
              rate,
            },
          };
    if (range)
      selectRange(
        trackId,
        range,
        focus,
        mode === 'track'
          ? null
          : item
            ? schemaIs(item, 'Track')
              ? null
              : item.id
            : undefined
      );
    else
      selectionUnavailable(trackId, 'unplaced-item · Selection unavailable.');
  }
  function selectRange(
    trackId: string | null,
    range: OtioTimeRange,
    focus: boolean,
    itemId?: string | null,
    seek = true
  ): void {
    if (
      !timelineId ||
      !timeline ||
      (trackId !== null && !lanes.some((lane) => lane.node.id === trackId))
    ) {
      selectionUnavailable(trackId, 'unplaced-item · Selection unavailable.');
      return;
    }
    try {
      selected = createOtioSelection(
        doc,
        timelineId,
        trackId,
        options.revision,
        range,
        itemId
      );
    } catch (error) {
      selectionUnavailable(
        trackId,
        error instanceof Error ? error.message : 'Selection unavailable.'
      );
      return;
    }
    projectedSelection = null;
    selectedTrack = trackId;
    inspected = selected.item_id
      ? doc.nodes[selected.item_id]
      : trackId
        ? doc.nodes[trackId]
        : timeline;
    paintSelection();
    paintInspector();
    if (seek) seekFrame(otioLocalTime(domain, range.start_time).value);
    if (focus) emitAim(true);
  }
  function timelineViewport(target: HTMLElement): DOMRect {
    const scrollRect = scroll.getBoundingClientRect();
    const stage = root.closest<HTMLElement>('.stage-wrap');
    const stageRect = stage?.getBoundingClientRect();
    const label = target
      .closest('.otio-track-row')
      ?.querySelector<HTMLElement>('.otio-track-label');
    const labelRect = label?.getBoundingClientRect();
    const left = Math.max(
      0,
      scrollRect.left + scroll.clientLeft,
      labelRect?.right ?? scrollRect.left,
      stage && stageRect ? stageRect.left + stage.clientLeft : 0
    );
    const top = Math.max(
      0,
      scrollRect.top + scroll.clientTop,
      stage && stageRect ? stageRect.top + stage.clientTop : 0
    );
    const right = Math.max(
      left,
      Math.min(
        window.innerWidth,
        scrollRect.left + scroll.clientLeft + scroll.clientWidth,
        stage && stageRect
          ? stageRect.left + stage.clientLeft + stage.clientWidth
          : window.innerWidth
      )
    );
    const bottom = Math.max(
      top,
      Math.min(
        window.innerHeight,
        scrollRect.top + scroll.clientTop + scroll.clientHeight,
        stage && stageRect
          ? stageRect.top + stage.clientTop + stage.clientHeight
          : window.innerHeight
      )
    );
    return new DOMRect(left, top, right - left, bottom - top);
  }

  function measure(commentId?: string): DOMRect | undefined {
    let target: HTMLElement | null | undefined;
    if (commentId !== undefined) {
      const pieces = marks.get(commentId);
      target = pieces
        ? pieces.find(
            (piece) =>
              !piece.hidden &&
              !piece.closest<HTMLElement>('.otio-track-row')?.hidden
          )
        : root.querySelector<HTMLElement>(
            `.otio-comment-mark[data-comment-id="${commentId}"]`
          );
    } else {
      const anchor = projectedSelection?.anchor ?? selected;
      if (!anchor) return undefined;
      const trackId = projectedSelection?.target
        ? projectedSelection.target.track
        : anchor.track_id;
      const rail =
        (trackId ? rails.get(trackId) : null) ??
        root.querySelector<HTMLElement>('.otio-track-rail');
      target = rail?.querySelector<HTMLElement>('.otio-selection');
    }
    if (
      !target ||
      target.hidden ||
      target.closest<HTMLElement>('.otio-track-row')?.hidden
    )
      return undefined;

    const box = target.getBoundingClientRect();
    const viewport = timelineViewport(target);
    const left = Math.min(viewport.right, Math.max(viewport.left, box.left));
    const top = Math.min(viewport.bottom, Math.max(viewport.top, box.top));
    return new DOMRect(
      left,
      top,
      Math.max(0, Math.min(viewport.right, box.right) - left),
      Math.max(0, Math.min(viewport.bottom, box.bottom) - top)
    );
  }

  function revealTimelineTarget(target: HTMLElement, center = false): void {
    cancelPendingTimelineNavigation();
    const box = target.getBoundingClientRect();
    const viewport = timelineViewport(target);
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const inset = Math.min(16, viewport.width / 4);
    let horizontal = 0;
    if (center) {
      horizontal = (box.left + box.right - viewport.left - viewport.right) / 2;
    } else if (
      box.width > viewport.width - inset * 2 ||
      box.left < viewport.left + inset
    ) {
      horizontal = box.left - viewport.left - inset;
    } else if (box.right > viewport.right - inset) {
      horizontal = box.right - viewport.right + inset;
    }
    const vertical =
      box.height > viewport.height || box.top < viewport.top
        ? box.top - viewport.top
        : box.bottom > viewport.bottom
          ? box.bottom - viewport.bottom
          : 0;
    scroll.scrollLeft = Math.max(0, scroll.scrollLeft + horizontal);
    scroll.scrollTop = Math.max(0, scroll.scrollTop + vertical);
  }

  function alignSelection(focus: boolean): void {
    // Only an explicit reveal may move the reader's timeline position.
    if (!focus) return;
    const trackId = selected?.track_id;
    if (trackId) expandTrack(trackId);
    const rail =
      (trackId ? rails.get(trackId) : null) ??
      root.querySelector<HTMLElement>('.otio-track-rail');
    const target = rail?.querySelector<HTMLElement>('.otio-selection');
    if (target) revealTimelineTarget(target);
  }

  function emitAim(focus: boolean): void {
    if (!selected) return;
    if (window.matchMedia('(max-width: 44rem)').matches)
      setInspectorOpen(false);
    alignSelection(focus);
    const detail: OtioAimDetail = {
      anchor: selected,
      focus,
      measure: () => measure(),
    };
    root.dispatchEvent(
      new CustomEvent('relic:otio-aim', { detail, bubbles: true })
    );
  }
  function paintSelection(): void {
    const anchor = projectedSelection?.anchor ?? selected;
    const target = projectedSelection?.target;
    const trackId = target ? target.track : (anchor?.track_id ?? null);
    for (const [id, rail] of rails) {
      for (const node of rail.querySelectorAll('.otio-selection'))
        node.remove();
      rail.dataset['selected'] = String(anchor !== null && trackId === id);
    }
    inputIn.disabled = selected === null || mode === 'track';
    inputOut.disabled = selected === null || mode === 'track';
    comment.disabled =
      projectedSelection !== null ||
      focusUnavailable !== null ||
      frameCount() === 0 ||
      (mode === 'track' && selected === null);
    clear.disabled = anchor === null;
    if (!anchor) {
      selectionLabel.textContent = focusedNode
        ? `${focusedNode.name || focusedNode.schema}${focusUnavailable ? ` · ${focusUnavailable}` : ''}`
        : selectedTrack
          ? doc.nodes[selectedTrack]?.name || selectedTrack
          : 'Composition';
      inputIn.value = '';
      inputOut.value = '';
      return;
    }
    const ranges = target?.ranges ?? [anchor.range];
    selectionLabel.textContent =
      otioTargetLabel(anchor) +
      (target
        ? ` · v${options.revision} · ${ranges.map(rangeLabel).join(' | ')}`
        : '');
    inputIn.value = selected
      ? String(otioLocalTime(domain, selected.range.start_time).value)
      : '';
    inputOut.value = selected
      ? String(otioLocalTime(domain, rangeEndTime(selected.range)).value)
      : '';
    outLabel.hidden = selected?.range.duration.value === 0;
    trackSelect.value = trackId ?? '';
    const rail = rails.get(trackId);
    if (!rail) return;
    for (const [index, range] of ranges.entries()) {
      const mark = element(
        'div',
        `otio-selection${range.duration.value === 0 ? ' is-point' : ''}`
      );
      mark.dataset['start'] = String(range.start_time.value);
      mark.dataset['duration'] = String(range.duration.value);
      mark.dataset['rate'] = String(range.start_time.rate);
      mark.dataset['durationRate'] = String(range.duration.rate);
      mark.dataset['trackId'] = trackId ?? '';
      mark.dataset['rangeIndex'] = String(index);
      if (target)
        mark.dataset['projection'] =
          projections.get(projectionsKey(anchor))?.status ?? 'same';
      positionMark(mark, range);
      rail.append(mark);
    }
  }
  function positionMark(mark: HTMLElement, range: OtioTimeRange): void {
    mark.dataset['start'] = String(range.start_time.value);
    mark.dataset['duration'] = String(range.duration.value);
    mark.dataset['rate'] = String(range.start_time.rate);
    mark.dataset['durationRate'] = String(range.duration.rate);
    const geometry = otioRangeGeometry(domain, range);
    mark.hidden = !geometry;
    if (!geometry) return;
    mark.style.left = `${geometry.left * 100}%`;
    mark.style.width =
      range.duration.value > 0 ? `${geometry.width * 100}%` : '';
  }
  function repackCommentBands(): void {
    let geometryChanged = false;
    const measured: {
      band: HTMLElement;
      width: number;
      entries: {
        mark: HTMLElement;
        left: number;
        right: number;
        id: string;
        index: number;
      }[];
    }[] = [];
    // Capture horizontal geometry before changing any lane or track height.
    for (const band of commentBands.values()) {
      const width = band.getBoundingClientRect().width;
      const entries: (typeof measured)[number]['entries'] = [];
      if (width > 0) {
        for (const child of band.children) {
          if (!child.classList.contains('otio-comment-mark')) continue;
          const mark = child as HTMLElement;
          if (mark.hidden) continue;
          const box = mark.getBoundingClientRect();
          entries.push({
            mark,
            left: box.left,
            right: box.right,
            id: mark.dataset['commentId'] ?? '',
            index: Number(mark.dataset['rangeIndex'] ?? 0),
          });
        }
      }
      measured.push({ band, width, entries });
    }
    for (const { band, width, entries } of measured) {
      if (width <= 0) {
        if (band.style.height !== '0px') {
          band.style.height = '0px';
          geometryChanged = true;
        }
        continue;
      }
      entries.sort(
        (a, b) =>
          a.left - b.left ||
          b.right - a.right ||
          a.id.localeCompare(b.id) ||
          a.index - b.index
      );
      const laneEnds: number[] = [];
      for (const { mark, left, right } of entries) {
        let lane = 0;
        while (lane < laneEnds.length && left < laneEnds[lane]! + 8) lane++;
        laneEnds[lane] = right;
        mark.style.setProperty('--otio-comment-lane', String(lane));
      }
      const height = `${laneEnds.length * 22}px`;
      if (band.style.height !== height) {
        band.style.height = height;
        geometryChanged = true;
      }
    }
    const previousTop = scroll.scrollTop;
    applyPendingTimelineScroll(true);
    const revealed = revealPendingComment();
    if (geometryChanged || previousTop !== scroll.scrollTop || revealed)
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
  }

  function flushCommentRepack(): void {
    if (!repackQueued || disposed) return;
    repackQueued = false;
    repackCommentBands();
  }

  function queueCommentRepack(): void {
    if (repackQueued || disposed) return;
    repackQueued = true;
    queueMicrotask(flushCommentRepack);
  }

  function expandTrack(trackId: string | null): void {
    const lane = lanes.find((value) => value.node.id === trackId);
    if (!lane) return;
    for (const ancestor of lane.ancestors) collapsed.delete(ancestor);
    applyDisclosure();
  }
  function applyDisclosure(): void {
    for (const lane of lanes) {
      const row = rows.get(lane.node.id);
      const focusIndex = focusedNode
        ? lane.ancestors.indexOf(focusedNode.id)
        : -1;
      if (row)
        row.hidden =
          !scopeIncludesTrack(lane) ||
          lane.ancestors.some(
            (id, index) =>
              collapsed.has(id) &&
              (!focusedNode || (focusIndex >= 0 && index > focusIndex))
          );
    }
    const compositionRow = trackRows.querySelector<HTMLElement>(
      '.otio-composition-row'
    );
    if (compositionRow) compositionRow.hidden = focusedNode !== undefined;
    for (const control of trackRows.querySelectorAll<HTMLButtonElement>(
      '[data-disclose]'
    ))
      control.setAttribute(
        'aria-expanded',
        String(!collapsed.has(control.dataset['disclose'] ?? ''))
      );
    queueCommentRepack();
  }
  function paintTracks(): void {
    paintedTracks = undefined;
    rails.clear();
    commentBands.clear();
    rows.clear();
    marks.clear();
    trackRows.replaceChildren();
    trackSelect.replaceChildren();
    const compositionOption = element('option', '', 'Composition');
    compositionOption.value = '';
    trackSelect.append(compositionOption);
    const addLane = (lane?: Lane): void => {
      const node = lane?.node;
      const id = node?.id ?? null;
      const row = element(
        'div',
        `otio-track-row${!lane ? ' otio-composition-row' : ''}`
      );
      row.dataset['trackId'] = id ?? '';
      row.dataset['depth'] = String(lane?.depth ?? 0);
      row.dataset['enabled'] = String(node?.enabled ?? true);
      const label = element('div', 'otio-track-label');
      label.style.setProperty('--otio-depth', String(lane?.depth ?? 0));
      if (lane) label.append(element('span', 'otio-track-code', lane.code));
      const text = element('div', 'otio-track-name');
      const trackTitle = button(
        node?.name || (node ? node.schema : 'Composition'),
        'otio-track-activate',
        () => {
          const target = node ?? timeline;
          if (target) activateNode(target);
        }
      );
      trackTitle.dataset['focusNodeId'] = node?.id ?? '';
      trackTitle.setAttribute('aria-pressed', 'false');
      text.append(trackTitle);
      if (node) text.append(element('small', '', node.json_pointer));
      label.append(text);
      if (
        lane &&
        lanes.some((child) => child.ancestors.includes(lane.node.id))
      ) {
        const disclosure = button('', 'otio-disclosure', () => {
          if (collapsed.has(lane.node.id)) collapsed.delete(lane.node.id);
          else collapsed.add(lane.node.id);
          applyDisclosure();
        });
        const chevron = document.createElementNS(
          'http://www.w3.org/2000/svg',
          'svg'
        );
        chevron.setAttribute('viewBox', '0 0 16 16');
        chevron.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(chevron.namespaceURI, 'path');
        path.setAttribute('d', 'M3 5l5 5 5-5');
        chevron.append(path);
        disclosure.append(chevron);
        disclosure.dataset['disclose'] = node?.id;
        disclosure.setAttribute('aria-label', `Nested tracks in ${node?.name}`);
        disclosure.setAttribute(
          'aria-expanded',
          String(!collapsed.has(lane.node.id))
        );
        label.append(disclosure);
      }
      if (node) {
        const kind = node.track_kind === 'Audio' ? 'Mute' : 'Hide';
        const toggle = button(kind, 'otio-track-toggle', () => {
          const state = playback?.getState().tracks[node.id];
          if (!state) return;
          if (node.track_kind === 'Audio')
            playback?.setTrackMute(node.id, !state.muted);
          else playback?.setTrackVisibility(node.id, !state.visible);
        });
        toggle.setAttribute('aria-label', `${kind} ${lane?.code} ${node.name}`);
        toggle.dataset['trackToggle'] = node.id;
        label.append(toggle);
        if (node.track_kind === 'Audio') {
          const solo = button(
            'Solo',
            'otio-track-toggle otio-track-solo',
            () => {
              const state = playback?.getState().tracks[node.id];
              if (state) playback?.setTrackSolo(node.id, !state.solo);
            }
          );
          solo.dataset['trackSolo'] = node.id;
          solo.setAttribute('aria-label', `Solo ${lane?.code} ${node.name}`);
          label.append(solo);
        }
        const option = element(
          'option',
          '',
          `${lane?.code} · ${node.name} · ${node.json_pointer}`
        );
        option.value = node.id;
        trackSelect.append(option);
      }
      const rail = element('div', 'otio-track-rail');
      rail.dataset['trackId'] = id ?? '';
      let suppressPointerClick = false;
      rail.tabIndex = 0;
      rail.setAttribute(
        'aria-label',
        lane
          ? `${lane.code} · ${node?.name} · ${node?.json_pointer}`
          : 'Composition'
      );
      const body = element('div', 'otio-track-body');
      const band = element('div', 'otio-comment-band');
      commentBands.set(id, band);
      rails.set(id, rail);
      if (node) {
        for (const childId of node.children_ids) {
          const child = doc.nodes[childId];
          if (!child) continue;
          const clip = element(
            'button',
            'otio-item',
            child.name || child.schema
          );
          clip.type = 'button';
          clip.addEventListener('click', (event) => {
            if (disposed || (event.detail > 0 && suppressPointerClick)) return;
            activateNode(child);
          });
          clip.dataset['focusNodeId'] = child.id;
          clip.setAttribute('aria-pressed', 'false');
          clip.setAttribute(
            'aria-label',
            `${child.name || child.schema} · ${child.schema}`
          );
          clip.dataset['itemId'] = child.id;
          clip.dataset['schema'] = child.schema;
          clip.dataset['enabled'] = String(child.enabled);
          clip.title = `${child.name} · ${child.schema}`;
          if (schemaIs(child, 'Gap')) clip.classList.add('is-gap');
          if (schemaIs(child, 'Transition'))
            clip.classList.add('is-transition');
          if (child.children_ids.length) clip.classList.add('is-compound');
          if (child.diagnostics?.length) clip.classList.add('has-diagnostic');
          if (child.timeline_range) positionMark(clip, child.timeline_range);
          else {
            const unplaced = [
              ...(child.diagnostics ?? []),
              ...doc.diagnostics.filter(
                (issue) => issue.target?.node_id === child.id
              ),
            ].some(
              (issue) =>
                issue.code === 'unplaced-item' ||
                issue.code === 'invalid-timing'
            );
            clip.classList.add(unplaced ? 'is-unplaced' : 'is-trimmed-out');
            clip.textContent = `${unplaced ? 'Unplaced' : 'Trimmed out'} · ${child.name || child.schema}`;
          }
          rail.append(clip);
        }
      }
      rail.addEventListener('pointerdown', (event) => {
        if (
          frameCount() === 0 ||
          focusUnavailable !== null ||
          cancelResizeGesture !== undefined ||
          event.isPrimary === false ||
          event.button !== 0 ||
          (event.target instanceof Element &&
            event.target.closest('[data-comment-id], .otio-timeline-marker'))
        )
          return;
        cancelRailGesture?.();
        suppressPointerClick = false;
        const itemButton =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>('.otio-item')
            : null;
        const item = itemButton
          ? doc.nodes[itemButton.dataset['itemId'] ?? '']
          : undefined;
        const pointerId = event.pointerId;
        const previousSelection = selected;
        const previousProjection = projectedSelection;
        const previousFocus = focusedNode;
        const previousFocusRange = focusedRange;
        const previousTime = playback?.getState().time;
        let dragging = false;
        let verticalTouch = false;
        const at = (clientX: number): number => {
          const bounds = playbackFrames();
          const local = otioLocalTime(
            domain,
            otioPointerTime(domain, clientX, rail.getBoundingClientRect())
          ).value;
          if (local <= bounds.start) return bounds.start;
          if (local >= bounds.end) return bounds.end;
          return Math.max(
            bounds.start,
            Math.min(bounds.end, Math.round(local))
          );
        };
        const from = Math.min(playbackFrames().last, at(event.clientX));
        rail.setPointerCapture(event.pointerId);
        const update = (moved: PointerEvent, final = false): void => {
          const current = at(moved.clientX);
          let start = Math.min(from, current);
          let end = Math.max(from, current);
          if (mode === 'point') {
            start = Math.min(playbackFrames().last, current);
            end = start;
          }
          if (mode === 'range' && end === start)
            end = Math.min(playbackFrames().end, start + 1);
          if (mode === 'track') {
            start = playbackFrames().start;
            end = playbackFrames().end;
          }
          selectFrames(id, start, end, false);
          if (final) emitAim(false);
        };
        const move = (moved: PointerEvent): void => {
          if (moved.pointerId !== pointerId) return;
          const dx = Math.abs(moved.clientX - event.clientX);
          const dy = Math.abs(moved.clientY - event.clientY);
          if (!dragging && event.pointerType === 'touch' && dy > dx && dy >= 5)
            verticalTouch = true;
          if (verticalTouch || (!dragging && dx < 5)) return;
          dragging = true;
          moved.preventDefault();
          update(moved);
        };
        const release = (): void => {
          rail.removeEventListener('pointermove', move);
          rail.removeEventListener('pointerup', done);
          rail.removeEventListener('pointercancel', cancel);
          rail.removeEventListener('lostpointercapture', cancel);
          window.removeEventListener('blur', cancel);
          if (rail.hasPointerCapture(pointerId))
            rail.releasePointerCapture(pointerId);
          if (cancelRailGesture === cancel) cancelRailGesture = undefined;
        };
        const done = (moved: PointerEvent): void => {
          if (moved.pointerId !== pointerId) return;
          release();
          suppressPointerClick = true;
          if (verticalTouch) return;
          if (
            item &&
            focusedNode?.id !== item.id &&
            !dragging &&
            Math.abs(moved.clientX - event.clientX) < 5
          )
            activateNode(item);
          else update(moved, true);
        };
        const cancel = (cancelled?: Event): void => {
          if (
            cancelled &&
            'pointerId' in cancelled &&
            cancelled.pointerId !== pointerId
          )
            return;
          release();
          suppressPointerClick = true;
          if (!dragging || disposed) return;
          selected = previousSelection;
          projectedSelection = previousProjection;
          selectedTrack =
            previousProjection?.target.track ??
            previousSelection?.track_id ??
            null;
          if (focusedNode !== previousFocus)
            setPlaybackFocus(previousFocus, previousTime, previousFocusRange);
          else if (previousTime)
            seekFrame(otioLocalTime(domain, previousTime).value);
          paintSelection();
          paintInspector();
        };
        cancelRailGesture = cancel;
        rail.addEventListener('pointermove', move);
        rail.addEventListener('pointerup', done);
        rail.addEventListener('pointercancel', cancel);
        rail.addEventListener('lostpointercapture', cancel);
        window.addEventListener('blur', cancel);
      });
      rail.addEventListener('keydown', (event) => {
        if (
          event.target !== rail ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(
            event.key
          )
        )
          return;
        event.preventDefault();
        if (event.key === 'Enter') {
          if (!selected || selected.track_id !== id)
            selectFrames(
              id,
              currentFrame(),
              mode === 'point' ? currentFrame() : currentFrame() + 1,
              false
            );
          emitAim(true);
          return;
        }
        const start =
          selected?.track_id === id
            ? otioLocalTime(domain, selected.range.start_time).value
            : currentFrame();
        const end =
          selected?.track_id === id
            ? otioLocalTime(domain, rangeEndTime(selected.range)).value
            : start;
        const delta = event.key === 'ArrowLeft' ? -1 : 1;
        const next =
          event.key === 'Home'
            ? playbackFrames().start
            : event.key === 'End'
              ? playbackFrames().last
              : start + delta;
        if (event.shiftKey) {
          mode = 'range';
          selectFrames(
            id,
            start,
            event.key === 'Home'
              ? playbackFrames().start
              : event.key === 'End'
                ? playbackFrames().end
                : end + delta,
            false
          );
        } else
          selectFrames(id, next, mode === 'point' ? next : next + 1, false);
        paintModes();
        emitAim(false);
      });
      body.append(rail, band);
      row.append(label, body);
      trackRows.append(row);
      if (id) rows.set(id, row);
    };
    addLane();
    for (const lane of lanes) addLane(lane);
    applyDisclosure();
    paintSelection();
    paintFocus();
  }
  function ownerTrackId(nodeId: string): string | null {
    let node = doc.nodes[nodeId];
    while (node) {
      if (schemaIs(node, 'Track')) return node.id;
      if (node.parent_id === null) break;
      node = doc.nodes[node.parent_id];
    }
    return null;
  }
  function selectMarker(mapped: OtioTimelineMarker): void {
    const owner = doc.nodes[mapped.owner_node_id];
    if (!owner || disposed) return;
    mode = mapped.timeline_range.duration.value === 0 ? 'point' : 'range';
    paintModes();
    const trackId = ownerTrackId(owner.id);
    expandTrack(trackId);
    setPlaybackFocus(
      owner,
      mapped.timeline_range.start_time,
      mapped.timeline_range
    );
    selectRange(trackId, mapped.timeline_range, false, owner.id, false);
    inspected = owner;
    currentTab = 'inspector';
    paintInspector();
    emitAim(false);
  }
  function paintMarkers(): void {
    if (!timelineId) return;
    const colors: Readonly<Record<string, true>> = {
      red: true,
      orange: true,
      yellow: true,
      green: true,
      cyan: true,
      blue: true,
      purple: true,
      magenta: true,
      pink: true,
      white: true,
      black: true,
    };
    for (const [index, mapped] of markersForOtioTimeline(
      doc,
      timelineId
    ).entries()) {
      const owner = doc.nodes[mapped.owner_node_id];
      if (!owner) continue;
      const mark = button(
        '',
        'otio-timeline-marker' +
          (mapped.timeline_range.duration.value === 0 ? ' is-point' : ''),
        () => selectMarker(mapped)
      );
      mark.dataset['ownerId'] = owner.id;
      mark.dataset['markerIndex'] = String(index);
      const label = `${mapped.marker.name || mapped.marker.schema} · ${owner.name || owner.schema} · ${owner.id} · Timeline ${rangeLabel(mapped.timeline_range)}`;
      mark.title = label;
      mark.setAttribute('aria-label', label);
      const color = mapped.marker.color?.toLowerCase();
      if (color && Object.hasOwn(colors, color))
        mark.style.setProperty('--otio-marker-color', color);
      positionMark(mark, mapped.timeline_range);
      rails.get(ownerTrackId(owner.id))?.append(mark);
    }
  }
  function detail(name: string, value: string, list: HTMLDListElement): void {
    list.append(element('dt', '', name), element('dd', '', value));
  }
  function rangeLabel(range: OtioTimeRange): string {
    return `${range.start_time.value} @ ${range.start_time.rate}, duration ${range.duration.value} @ ${range.duration.rate}`;
  }
  function rawDetails(label: string, value: unknown): HTMLDetailsElement {
    const details = element('details', 'otio-raw');
    details.append(
      element('summary', '', label),
      element('pre', 'otio-metadata', stringifyOtioJson(value))
    );
    return details;
  }
  function selectedTimelineNodes(): readonly OtioNode[] {
    const pending = timelineId ? [timelineId] : Object.keys(doc.nodes);
    const visited = new Set<string>();
    const nodes: OtioNode[] = [];
    while (pending.length) {
      const id = pending.pop();
      if (id === undefined || visited.has(id)) continue;
      visited.add(id);
      const node = doc.nodes[id];
      if (!node) continue;
      nodes.push(node);
      for (let index = node.children_ids.length - 1; index >= 0; index--) {
        const child = node.children_ids[index];
        if (child !== undefined) pending.push(child);
      }
    }
    return nodes;
  }
  function sourceDetails(span: OtioSourceSpan, list: HTMLDListElement): void {
    detail('Item', `${span.name} · ${span.node_id}`, list);
    detail('Track', `${span.track_id} · ${span.track_path.join(' > ')}`, list);
    detail('Timeline', rangeLabel(span.intersected_timeline_range), list);
    if (span.source_range)
      detail('Source', rangeLabel(span.source_range), list);
    if (span.file_relative_source_range)
      detail('File source', rangeLabel(span.file_relative_source_range), list);
    if (span.source_mapping) {
      const mapping = span.source_mapping;
      detail(
        'Source mapping',
        `Timeline ${mapping.timeline_origin.value} @ ${mapping.timeline_origin.rate} → file ${mapping.source_origin.value} @ ${mapping.source_origin.rate} · scalar ${mapping.scalar}`,
        list
      );
    }
    for (const issue of span.diagnostics)
      detail(issue.code, issue.message, list);
  }
  function paintInspector(): void {
    context.replaceChildren();
    for (const tab of tabs.querySelectorAll<HTMLButtonElement>('[data-tab]'))
      tab.setAttribute(
        'aria-selected',
        String(tab.dataset['tab'] === currentTab)
      );
    if (currentTab === 'media') {
      for (const node of selectedTimelineNodes())
        for (const [key, reference] of Object.entries(
          node.media_references ?? {}
        )) {
          const entry = element('div', 'otio-media-reference');
          entry.dataset['ownerId'] = node.id;
          entry.dataset['referenceKey'] = key;
          entry.append(
            element(
              'strong',
              '',
              reference.target_url ||
                reference.target_url_base ||
                reference.schema
            ),
            element(
              'span',
              '',
              `${node.name} · ${node.id} · ${node.json_pointer}`
            ),
            element(
              'span',
              '',
              `${key} · ${key === node.active_media_reference_key ? 'active' : 'inactive'} · ${reference.schema}`
            )
          );
          if (reference.available_range)
            entry.append(
              element(
                'span',
                '',
                `Available ${rangeLabel(reference.available_range)}`
              )
            );
          if (reference.raw)
            entry.append(rawDetails('Raw OTIO', reference.raw));
          context.append(entry);
        }
      return;
    }
    if (currentTab === 'markers') {
      const markers = timelineId ? markersForOtioTimeline(doc, timelineId) : [];
      for (const node of selectedTimelineNodes())
        for (const marker of node.markers ?? []) {
          const entry = element('div', 'otio-inspector-marker');
          entry.dataset['ownerId'] = node.id;
          entry.append(
            element('strong', '', marker.name || marker.schema),
            element(
              'span',
              '',
              `${node.name || node.schema} · ${node.id} · ${node.json_pointer}`
            ),
            element(
              'span',
              '',
              `${marker.color || ''} · Source ${marker.marked_range ? rangeLabel(marker.marked_range) : 'invalid-timing'}`
            )
          );
          if (marker.comment) entry.append(element('p', '', marker.comment));
          const mapped = markers.find(
            (value) =>
              value.owner_node_id === node.id && value.marker === marker
          );
          if (mapped) {
            entry.append(
              button(
                formatOtioTime(
                  mapped.timeline_range.start_time,
                  timelineId ? doc.global_start_times?.[timelineId] : undefined
                ),
                '',
                () => selectMarker(mapped)
              ),
              element(
                'span',
                '',
                `Timeline ${rangeLabel(mapped.timeline_range)}`
              )
            );
          } else
            entry.append(
              element(
                'span',
                '',
                !timelineId
                  ? 'Select timeline'
                  : marker.marked_range
                    ? 'Trimmed out'
                    : 'invalid-timing'
              )
            );
          if (marker.raw) entry.append(rawDetails('Raw OTIO', marker.raw));
          context.append(entry);
        }
      return;
    }
    const node = inspected ?? timeline ?? Object.values(doc.nodes)[0];
    if (!node) return;
    context.append(
      element('h3', '', node.name || node.schema),
      element('p', 'otio-schema', node.schema)
    );
    const list = element('dl', '');
    detail('Identity', node.id, list);
    detail('Origin', node.identity_origin, list);
    if (node.fingerprint) detail('Fingerprint', node.fingerprint, list);
    detail('JSON pointer', node.json_pointer, list);
    detail('Enabled', String(node.enabled), list);
    const ancestry: string[] = [];
    const seen = new Set<string>();
    let parent: OtioNode | undefined = node;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      ancestry.unshift(parent.name || parent.schema);
      parent =
        parent.parent_id === null ? undefined : doc.nodes[parent.parent_id];
    }
    detail('Path', ancestry.join(' > '), list);
    const reference = node.active_media_reference_key
      ? node.media_references?.[node.active_media_reference_key]
      : undefined;
    for (const [label, range] of [
      ['Timeline', node.timeline_range],
      ['Visible timeline', node.visible_timeline_range],
      ['Parent', node.parent_range],
      ['Source', node.source_range],
      ['Available', node.available_range ?? reference?.available_range],
    ] as const)
      if (range) detail(label, rangeLabel(range), list);
    if (node.active_media_reference_key)
      detail('Active reference', node.active_media_reference_key, list);
    if (reference?.target_url)
      detail('Bundle media', reference.target_url, list);
    if (reference?.missing_frame_policy)
      detail('Missing frame policy', reference.missing_frame_policy, list);
    context.append(list);
    const currentRanges =
      projectedSelection?.target.ranges ?? (selected ? [selected.range] : []);
    if (timelineId && currentRanges.length) {
      const current = element('dl', '');
      const track = projectedSelection
        ? projectedSelection.target.track
        : (selected?.track_id ?? null);
      for (const range of currentRanges)
        for (const span of sourceSpansForOtioRange(
          doc,
          timelineId,
          track,
          range
        ))
          sourceDetails(span, current);
      context.append(
        element('h4', '', `v${options.revision} · Source context`),
        current
      );
    }
    if (projectedSelection) {
      const original = element('dl', 'otio-original-context');
      detail(
        'Original range',
        rangeLabel(projectedSelection.anchor.range),
        original
      );
      for (const span of projections.get(
        projectionsKey(projectedSelection.anchor)
      )?.source_spans ?? [])
        sourceDetails(span, original);
      context.append(
        element(
          'h4',
          '',
          `Earlier feedback · v${projectedSelection.anchor.relic_version}`
        ),
        original
      );
    }
    if (node.effects?.length) {
      context.append(element('h4', '', 'Effects'));
      for (const effect of node.effects) {
        context.append(
          element(
            'p',
            'otio-effect',
            `${effect.name || effect.effect_name || effect.schema} · ${effect.enabled ? 'enabled' : 'disabled'}${effect.time_scalar !== undefined ? ` · time_scalar ${effect.time_scalar}` : ''}`
          )
        );
        if (effect.raw) context.append(rawDetails('Raw OTIO', effect.raw));
      }
    }
    if (node.transition_type) {
      const offsets = [
        node.in_offset
          ? `in ${node.in_offset.value} @ ${node.in_offset.rate}`
          : 'invalid-timing',
        node.out_offset
          ? `out ${node.out_offset.value} @ ${node.out_offset.rate}`
          : 'invalid-timing',
      ];
      context.append(
        element(
          'p',
          'otio-effect',
          `${node.transition_type} · ${offsets.join(' · ')}`
        )
      );
    }
    if (node.metadata && Object.keys(node.metadata).length)
      context.append(rawDetails('Metadata', node.metadata));
    if (node.raw) context.append(rawDetails('Raw OTIO', node.raw));
    for (const diagnostic of node.diagnostics ?? [])
      context.append(
        element(
          'p',
          'otio-diagnostic',
          `${diagnostic.code} · ${diagnostic.message}`
        )
      );
  }
  function paintState(state: OtioPlaybackState): void {
    if (disposed) return;
    const playingValue = String(state.playing);
    const bufferingValue = String(state.buffering);
    if (root.dataset['playing'] !== playingValue)
      root.dataset['playing'] = playingValue;
    if (root.dataset['buffering'] !== bufferingValue)
      root.dataset['buffering'] = bufferingValue;
    const bounds = playbackFrames();
    const unavailable = focusUnavailable !== null || bounds.end <= bounds.start;
    const localFrame = otioLocalTime(domain, state.time).value;
    const minimum = String(bounds.start);
    const maximum = String(bounds.last);
    if (seek.min !== minimum) seek.min = minimum;
    if (seek.max !== maximum) seek.max = maximum;
    if (seek.disabled !== unavailable) seek.disabled = unavailable;
    const previousDisabled = unavailable || localFrame <= bounds.start;
    const nextDisabled = unavailable || localFrame >= bounds.last;
    if (previous.disabled !== previousDisabled)
      previous.disabled = previousDisabled;
    if (next.disabled !== nextDisabled) next.disabled = nextDisabled;
    const compositionFrame = String(rescaleTime(state.time, rate).value);
    if (root.dataset['frame'] !== compositionFrame)
      root.dataset['frame'] = compositionFrame;
    const blocked = String(state.previewBlocked);
    if (root.dataset['previewBlocked'] !== blocked)
      root.dataset['previewBlocked'] = blocked;
    if (
      root.classList.contains('is-base-preview') !==
      state.baseMediaPreviewAllowed
    )
      root.classList.toggle('is-base-preview', state.baseMediaPreviewAllowed);
    const playLabel = state.playing ? 'Pause' : 'Play';
    if (play.textContent !== playLabel) play.textContent = playLabel;
    const playDisabled =
      unavailable || state.previewBlocked || frameCount() === 0;
    if (play.disabled !== playDisabled) play.disabled = playDisabled;
    const clockLabel = formatOtioTime(
      focusedNode ? otioLocalTime(domain, state.time) : state.time,
      !focusedNode && timelineId
        ? doc.global_start_times?.[timelineId]
        : undefined
    );
    if (clock.textContent !== clockLabel) clock.textContent = clockLabel;
    const clockValue = String(state.time.value);
    const clockRate = String(state.time.rate);
    if (clock.dataset['value'] !== clockValue)
      clock.dataset['value'] = clockValue;
    if (clock.dataset['rate'] !== clockRate) clock.dataset['rate'] = clockRate;
    const seekValue = String(localFrame);
    if (seek.value !== seekValue) seek.value = seekValue;
    const fraction =
      domain.range.duration.value > 0
        ? otioRangeGeometry(domain, {
            start_time: state.time,
            duration: { value: 0, rate },
          })?.left
        : undefined;
    if (playhead.hidden !== (fraction === undefined))
      playhead.hidden = fraction === undefined;
    if (fraction !== undefined) {
      const position = `calc(var(--otio-label-width) + (100% - var(--otio-label-width)) * ${fraction})`;
      if (playhead.style.left !== position) playhead.style.left = position;
    }
    const tracksChanged =
      !paintedTracks ||
      lanes.some(
        (lane) => paintedTracks?.[lane.node.id] !== state.tracks[lane.node.id]
      );
    if (tracksChanged) {
      for (const toggle of trackRows.querySelectorAll<HTMLButtonElement>(
        '[data-track-toggle]'
      )) {
        const track = state.tracks[toggle.dataset['trackToggle'] ?? ''];
        toggle.disabled = !track;
        if (track)
          toggle.setAttribute(
            'aria-pressed',
            String(track.kind === 'Audio' ? track.muted : !track.visible)
          );
      }
      for (const toggle of trackRows.querySelectorAll<HTMLButtonElement>(
        '[data-track-solo]'
      )) {
        const track = state.tracks[toggle.dataset['trackSolo'] ?? ''];
        toggle.disabled = !track;
        if (track) toggle.setAttribute('aria-pressed', String(track.solo));
      }
      paintedTracks = state.tracks;
    }
    const previousDiagnostics = paintedDiagnostics;
    const diagnosticsChanged =
      !previousDiagnostics ||
      previousDiagnostics.length !== state.diagnostics.length ||
      state.diagnostics.some((issue, index) => {
        const before = previousDiagnostics[index]!;
        return (
          before.code !== issue.code ||
          before.severity !== issue.severity ||
          before.message !== issue.message ||
          (before.target !== undefined) !== (issue.target !== undefined) ||
          before.target?.node_id !== issue.target?.node_id
        );
      });
    if (diagnosticsChanged) {
      const issues = [...doc.diagnostics, ...state.diagnostics];
      const unique = new Map(
        issues.map((issue) => [
          `${issue.code}:${issue.target?.node_id}:${issue.message}`,
          issue,
        ])
      );
      diagnostics.replaceChildren(
        ...[...unique.values()].map((issue) =>
          element('p', 'otio-diagnostic', `${issue.code} · ${issue.message}`)
        )
      );
      paintedDiagnostics = state.diagnostics;
    }
    // Native transport emits multiple snapshots for the same presented frame.
    // Keep genuine buffering/diagnostic changes immediate, but retain unchanged
    // status nodes and controls instead of rebuilding them on every snapshot.
    if (
      paintedStatus &&
      paintedStatusScope === focusedNode &&
      paintedStatusUnavailable === focusUnavailable &&
      paintedStatusNotice === focusNotice &&
      paintedStatusSettled === timelineSettled &&
      paintedStatus.buffering === state.buffering &&
      paintedStatus.previewBlocked === state.previewBlocked &&
      paintedStatus.baseMediaPreviewAllowed === state.baseMediaPreviewAllowed &&
      paintedStatus.graphicsFailed === state.graphicsFailed &&
      !diagnosticsChanged
    )
      return;
    const incomplete = state.diagnostics.filter(
      (issue) =>
        issue.code !== 'supported' &&
        (issue.severity === 'error' ||
          [
            'unsupported-effect',
            'unsupported-codec',
            'missing-media',
            'missing-handles',
            'unsupported-browser',
            'invalid-timing',
          ].includes(issue.code))
    );
    const blocking = incomplete.filter(
      (issue) =>
        (state.graphicsFailed &&
          issue.code === 'unsupported-browser' &&
          !issue.target) ||
        !state.baseMediaPreviewAllowed ||
        !['unsupported-effect', 'unsupported-browser'].includes(issue.code)
    );
    root.dataset['previewState'] = state.buffering
      ? 'buffering'
      : state.previewBlocked
        ? 'blocked'
        : !timelineSettled
          ? 'loading'
          : state.baseMediaPreviewAllowed
            ? 'incomplete'
            : incomplete.length
              ? 'diagnostic'
              : 'decoded';
    if (timelineSettled)
      root.dataset['ready'] = state.buffering
        ? 'false'
        : incomplete.length ||
            state.previewBlocked ||
            state.baseMediaPreviewAllowed
          ? 'diagnostic'
          : 'true';
    scopeText.textContent = state.baseMediaPreviewAllowed
      ? 'Incomplete preview · base media without unsupported effects · browser-managed SDR'
      : state.previewBlocked
        ? 'Incomplete preview · affected playback blocked · browser-managed SDR'
        : `${focusedNode ? focusedNode.name || focusedNode.schema : 'Composition'} · browser-managed SDR`;
    blockBase.hidden = !state.baseMediaPreviewAllowed;
    previewStatus.replaceChildren();
    previewStatus.hidden =
      !state.buffering && !state.previewBlocked && blocking.length === 0;
    if (state.buffering)
      previewStatus.append(element('p', 'otio-buffering', 'Buffering'));
    previewStatus.append(
      ...blocking.map((issue) =>
        element('p', 'otio-diagnostic', `${issue.code} · ${issue.message}`)
      )
    );
    if (state.previewBlocked)
      previewStatus.append(
        button(
          'Preview base media without unsupported effects',
          'otio-preview-base',
          () => playback?.setBaseMediaPreviewAllowed(true)
        )
      );
    if (focusedNode && (focusUnavailable || focusNotice)) {
      previewStatus.hidden = false;
      previewStatus.append(
        element('p', 'otio-focus-status', focusUnavailable || focusNotice || '')
      );
      if (focusUnavailable) {
        root.dataset['ready'] = 'diagnostic';
        root.dataset['previewState'] = 'unavailable';
      }
    }
    paintedStatus = state;
    paintedStatusScope = focusedNode;
    paintedStatusUnavailable = focusUnavailable;
    paintedStatusNotice = focusNotice;
    paintedStatusSettled = timelineSettled;
  }
  function initializeTimeline(): void {
    const initialMarkBatch = ++markBatchGeneration;
    markBatchComplete = false;
    pendingCommentReveal = undefined;
    paintedStatus = undefined;
    paintedTracks = undefined;
    rememberTimelineViewport();
    cancelRailGesture?.();
    ++scopeGeneration;
    focusedNode = undefined;
    paintedDiagnostics = undefined;
    focusedRange = undefined;
    focusUnavailable = null;
    focusNotice = null;
    paintFocus();
    unsubscribe?.();
    playback?.dispose();
    playback = undefined;
    timelineSettled = false;
    selected = null;
    projectedSelection = null;
    selectedTrack = null;
    marks.clear();
    collapsed.clear();
    rails.clear();
    rows.clear();
    lanes = [];
    root.dataset['ready'] = 'false';
    root.dataset['previewState'] = 'loading';
    root.dataset['previewBlocked'] = 'false';
    root.classList.remove('is-base-preview');
    scopeText.textContent = 'Composition · browser-managed SDR';
    blockBase.hidden = true;
    previewStatus.replaceChildren();
    previewStatus.hidden = true;
    timeline = timelineId ? doc.nodes[timelineId] : undefined;
    inspected = timeline;
    name.textContent = timeline?.name || 'OTIO';
    root.dataset['timelineId'] = timelineId ?? '';
    if (!timeline || !timelineId) {
      name.textContent = doc.timeline_ids.length
        ? 'Select timeline'
        : 'OTIO structural inspector';
      transport.hidden = true;
      resizeHandle.hidden = true;
      tools.hidden = true;
      zoomTools.hidden = true;
      selectionBar.hidden = true;
      grid.hidden = true;
      trackRows.replaceChildren();
      paintInspector();
      root.dataset['ready'] = 'structural';
      root.dataset['previewState'] = 'structural';
      root.dispatchEvent(
        new CustomEvent('relic:otio-ready', { bubbles: true })
      );
      return;
    }
    transport.hidden = false;
    resizeHandle.hidden = false;
    tools.hidden = false;
    zoomTools.hidden = false;
    selectionBar.hidden = false;
    grid.hidden = false;
    lanes = otioLanes(doc, timelineId);
    const current = createOtioPlayback({
      document: doc,
      timelineId,
      canvas,
      resolveMedia: resolver ?? (() => null),
    });
    playback = current;
    const initial = current.getState();
    duration = timeline.timeline_range?.duration ?? {
      value: 0,
      rate: initial.rate,
    };
    rate = duration.rate;
    domain = {
      origin: timeline.timeline_range?.start_time ?? { value: 0, rate },
      range: timeline.timeline_range ?? {
        start_time: { value: 0, rate },
        duration,
      },
      rate,
    };
    restoreTimelineViewport(true);
    paintMarkers();
    paintInspector();
    paintModes();
    unsubscribe = current.subscribe((state) => {
      if (playback === current) paintState(state);
    });
    void current
      .seek({ value: 0, rate })
      .then(() => {
        if (disposed || playback !== current) return;
        timelineSettled = true;
        paintState(current.getState());
        root.dispatchEvent(
          new CustomEvent('relic:otio-ready', { bubbles: true })
        );
        if (markBatchGeneration === initialMarkBatch) {
          markBatchComplete = true;
          queueCommentRepack();
        }
      })
      .catch((error) => {
        if (disposed || playback !== current) return;
        timelineSettled = true;
        reportPlaybackError(error);
        root.dispatchEvent(
          new CustomEvent('relic:otio-ready', { bubbles: true })
        );
        if (markBatchGeneration === initialMarkBatch) {
          markBatchComplete = true;
          queueCommentRepack();
        }
      });
  }
  const controller: OtioUiController = {
    document: doc,
    revision: options.revision,
    get disposed() {
      return disposed;
    },
    beginMarkBatch() {
      if (!disposed) {
        markBatchComplete = false;
        ++markBatchGeneration;
      }
      return markBatchGeneration;
    },
    completeMarkBatch(batch) {
      if (disposed || batch !== markBatchGeneration) return;
      markBatchComplete = true;
      queueCommentRepack();
      flushCommentRepack();
    },
    paint(anchor, id) {
      if (disposed) return false;
      const target = projectionOf(anchor);
      if (!target || !rails.has(target.track)) return false;
      for (const mark of marks.get(id) ?? []) mark.remove();
      const painted: HTMLElement[] = [];
      for (const [index, range] of target.ranges.entries()) {
        const mark = element(
          'button',
          `otio-comment-mark${range.duration.value === 0 ? ' is-point' : ''}`
        );
        mark.type = 'button';
        mark.dataset['commentId'] = id;
        mark.dataset['rangeIndex'] = String(index);
        mark.dataset['trackId'] = target.track ?? '';
        if (target.item) mark.dataset['itemId'] = target.item;
        mark.dataset['start'] = String(range.start_time.value);
        mark.dataset['duration'] = String(range.duration.value);
        mark.dataset['rate'] = String(range.start_time.rate);
        mark.dataset['durationRate'] = String(range.duration.rate);
        const label = `${otioTargetLabel(anchor)} · v${options.revision} · ${rangeLabel(range)}`;
        mark.setAttribute('aria-label', label);
        mark.title = label;
        positionMark(mark, range);
        if (!scopeIncludesItem(target.item)) mark.hidden = true;
        const projection = projections.get(projectionsKey(anchor));
        if (projection) mark.dataset['projection'] = projection.status;
        commentBands.get(target.track)?.append(mark);
        queueCommentRepack();
        painted.push(mark);
      }
      marks.set(id, painted);
      return painted.length > 0;
    },
    reveal(anchor, commentId) {
      if (disposed) return;
      let target = projectionOf(anchor);
      const mappedTimeline = projections.get(
        projectionsKey(anchor)
      )?.mapped_timeline_id;
      if (
        !target &&
        mappedTimeline &&
        doc.timeline_ids.includes(mappedTimeline) &&
        mappedTimeline !== timelineId
      ) {
        timelineId = mappedTimeline;
        timelineSelect.value = mappedTimeline;
        initializeTimeline();
        target = projectionOf(anchor);
      }
      const first = target?.ranges[0];
      if (!target || !first) return;
      expandTrack(target.track);
      if (
        anchor.relic_version === options.revision &&
        anchor.document_sha256 === doc.document_sha256
      ) {
        selected = anchor;
        projectedSelection = null;
      } else {
        selected = null;
        projectedSelection = { anchor, target };
      }
      mode = first.duration.value === 0 ? 'point' : 'range';
      paintModes();
      selectedTrack = target.track;
      inspected = target.item
        ? doc.nodes[target.item]
        : target.track
          ? doc.nodes[target.track]
          : timeline;
      currentTab = 'inspector';
      setPlaybackFocus(
        target.item
          ? doc.nodes[target.item]
          : target.track
            ? doc.nodes[target.track]
            : undefined,
        first.start_time,
        first
      );
      cancelPendingTimelineNavigation();
      if (commentId !== undefined)
        pendingCommentReveal = { key: viewportKey, id: commentId };
      paintSelection();
      paintInspector();
      flushCommentRepack();
      if (commentId !== undefined) revealPendingComment();
      else {
        const selection = rails
          .get(target.track)
          ?.querySelector<HTMLElement>('.otio-selection');
        if (selection) revealTimelineTarget(selection, true);
      }
    },
    clearMarks() {
      if (disposed) return;
      for (const pieces of marks.values())
        for (const mark of pieces) mark.remove();
      marks.clear();
      for (const band of commentBands.values()) band.style.height = '0px';
      queueCommentRepack();
    },
    measure(commentId?: string) {
      return measure(commentId);
    },
    async project(anchor, content) {
      const projectionKey = projectionsKey(anchor);
      const cached = projections.get(projectionKey);
      if (
        cached?.status === 'changed' &&
        cached.diagnostics.some(
          (diagnostic) => diagnostic.code === 'invalid-timing'
        )
      ) {
        return cached;
      }
      const key = `${anchor.relic_version}:${anchor.document_sha256}`;
      let original = originals.get(key);
      if (!original) {
        original = readOtioForProjection(content);
        originals.set(key, original);
      }
      const originalDocument = await original;
      if (originalDocument.document_sha256 !== anchor.document_sha256) {
        throw new Error(
          'Original OTIO document digest differs from the encrypted anchor.'
        );
      }
      const originalResolution = resolveOtioAnchor(anchor, originalDocument);
      if (originalResolution.status !== 'same') {
        projections.set(projectionKey, originalResolution);
        return originalResolution;
      }
      let current = currentProjectionDocument;
      if (!current) {
        current = readOtioForProjection(options.content);
        currentProjectionDocument = current;
      }
      const currentDocument = await current;
      const result = resolveOtioAnchor(
        anchor,
        originalDocument,
        currentDocument
      );
      projections.set(projectionKey, result);
      return result;
    },
    projection: (anchor) => projections.get(projectionsKey(anchor)),
    dispose() {
      if (disposed) return;
      disposed = true;
      ++markBatchGeneration;
      cancelPendingTimelineNavigation();
      ++scopeGeneration;
      cancelRailGesture?.();
      root.dataset['disposed'] = 'true';
      unsubscribe?.();
      playback?.dispose();
      resolver?.dispose();
      for (const dispose of cleanup) dispose();
    },
  };
  attachOtioController(root, controller);
  const pagehide = (): void => controller.dispose();
  window.addEventListener('pagehide', pagehide);
  cleanup.push(() => window.removeEventListener('pagehide', pagehide));
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      refreshSplit();
      refreshTimelineViewport();
      queueCommentRepack();
    });
    observer.observe(grid);
    observer.observe(root);
    observer.observe(monitor);
    observer.observe(scroll);
    observer.observe(resizeHandle);
    for (const row of fixedRows) observer.observe(row);
    cleanup.push(() => observer.disconnect());
  }
  if (typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(() => {
      if (!root.isConnected) controller.dispose();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    cleanup.push(() => observer.disconnect());
  }
  initializeTimeline();
  refreshSplit();
}
