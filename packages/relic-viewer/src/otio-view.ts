import {
  addRationalTimes,
  COMMENT_ANCHOR_OTIO_LIMIT_BYTES,
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

const encoder = new TextEncoder();
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
const bound = (value: number, max: number): number =>
  Math.max(0, Math.min(max, value));
const schemaIs = (node: OtioNode, kind: string): boolean =>
  node.schema.split('.')[0] === kind;

/** Display conversion only. Placement and source sampling remain in the core. */
export function formatOtioTime(
  time: OtioRationalTime,
  global?: OtioRationalTime
): string {
  const value = global ? addRationalTimes(global, time) : time;
  const seconds = timeToSeconds(value);
  const rate = value.rate;
  const whole = Math.floor(Math.max(0, seconds));
  const frame = Math.floor((seconds - whole) * rate + 1e-5);
  return [
    Math.floor(whole / 3600),
    Math.floor(whole / 60) % 60,
    whole % 60,
    frame,
  ]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
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
  range: OtioTimeRange
): OtioAnchorV1 {
  const timeline = document.nodes[timelineId];
  if (!timeline) throw new Error('Selected OTIO timeline is missing.');
  const spans = sourceSpansForOtioRange(document, timelineId, trackId, range);
  const item =
    spans.length === 1 ? document.nodes[spans[0]?.node_id ?? ''] : undefined;
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
  inspector.append(tabs, context);
  monitor.append(preview, inspector);

  const transport = element('div', 'otio-transport');
  transport.setAttribute('aria-label', 'OTIO playback');
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
  const clock = element('output', 'otio-time');
  const seek = element('input', 'otio-seek');
  seek.type = 'range';
  seek.min = '0';
  seek.step = '1';
  seek.value = '0';
  seek.setAttribute('aria-label', 'Timeline frame');
  seek.addEventListener('input', () => seekFrame(Number(seek.value)));
  const inspectToggle = button('Inspector', 'otio-inspector-toggle', () => {
    const open = monitor.dataset['inspectorOpen'] !== 'true';
    monitor.dataset['inspectorOpen'] = String(open);
    inspectToggle.setAttribute('aria-expanded', String(open));
  });
  inspectToggle.setAttribute('aria-expanded', 'false');
  transport.append(previous, play, next, clock, seek, inspectToggle);

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
    selectedTrack = trackSelect.value || null;
    const start = selected
      ? rescaleTime(selected.range.start_time, rate).value
      : currentFrame();
    const end = selected
      ? rescaleTime(rangeEndTime(selected.range), rate).value
      : start + (mode === 'point' ? 0 : 1);
    selectFrames(selectedTrack, start, end, false);
  });
  for (const value of ['point', 'range', 'track'] as const) {
    const control = button(
      value.charAt(0).toUpperCase() + value.slice(1),
      'otio-mode',
      () => {
        mode = value;
        const start = selected
          ? rescaleTime(selected.range.start_time, rate).value
          : currentFrame();
        const end = selected
          ? rescaleTime(rangeEndTime(selected.range), rate).value
          : start + 1;
        selectFrames(
          selectedTrack,
          value === 'track' ? 0 : start,
          value === 'point'
            ? start
            : value === 'track'
              ? frameCount()
              : Math.max(start + 1, end),
          false
        );
        paintModes();
      }
    );
    control.dataset['otioMode'] = value;
    tools.append(control);
  }
  tools.append(trackSelect);
  heading.append(name, timelineSelect, tools);
  const scroll = element('div', 'otio-timeline-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('aria-label', 'Timeline tracks');
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
  inputIn.step = '1';
  inputIn.setAttribute('aria-label', 'Selection in frame');
  const inputOut = element('input', 'otio-selection-out');
  inputOut.type = 'number';
  inputOut.min = '0';
  inputOut.step = '1';
  inputOut.setAttribute('aria-label', 'Selection out frame');
  const inLabel = element('label', '', 'In ');
  inLabel.append(inputIn);
  const outLabel = element('label', '', 'Out ');
  outLabel.append(inputOut);
  const applyInputs = (): void => {
    const start = bound(
      Number(inputIn.value) || 0,
      Math.max(0, frameCount() - 1)
    );
    const end =
      mode === 'point'
        ? start
        : Math.max(
            start + 1,
            Math.min(frameCount(), Number(inputOut.value) || start + 1)
          );
    selectFrames(selectedTrack, start, end, false);
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
    transport,
    heading,
    scroll,
    selectionBar,
    diagnostics
  );

  function currentFrame(): number {
    const time = playback?.getState().time;
    return time ? Math.round(rescaleTime(time, rate).value) : 0;
  }
  function frameCount(): number {
    return Math.max(0, Math.ceil(rescaleTime(duration, rate).value));
  }
  function reportPlaybackError(error: unknown): void {
    if (disposed) return;
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
    if (!current) return;
    const time = { value: bound(frame, Math.max(0, frameCount() - 1)), rate };
    current.pause();
    void current.seek(time).catch((error) => {
      if (playback === current) reportPlaybackError(error);
    });
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
    if (!timelineId || frameCount() === 0) return;
    const a = bound(
      Math.round(Math.min(start, end)),
      Math.max(0, frameCount() - 1)
    );
    const b = bound(Math.round(Math.max(start, end)), frameCount());
    const range =
      mode === 'track'
        ? otioScopeRange(doc, timelineId, trackId)
        : {
            start_time: { value: a, rate },
            duration: {
              value: mode === 'point' ? 0 : Math.max(1, b - a),
              rate,
            },
          };
    if (range) selectRange(trackId, range, focus);
    else
      selectionUnavailable(trackId, 'unplaced-item · Selection unavailable.');
  }
  function selectRange(
    trackId: string | null,
    range: OtioTimeRange,
    focus: boolean
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
        range
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
    seekFrame(rescaleTime(range.start_time, rate).value);
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
      target = root.querySelector<HTMLElement>(
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
    if (!target) return undefined;

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
      frameCount() === 0 ||
      (mode === 'track' && selected === null);
    clear.disabled = anchor === null;
    if (!anchor) {
      selectionLabel.textContent = selectedTrack
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
      ? String(rescaleTime(selected.range.start_time, rate).value)
      : '';
    inputOut.value = selected
      ? String(rescaleTime(rangeEndTime(selected.range), rate).value)
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
    const total = timeToSeconds(duration);
    if (total <= 0) return;
    mark.style.left = `${(timeToSeconds(range.start_time) / total) * 100}%`;
    if (range.duration.value > 0)
      mark.style.width = `${(timeToSeconds(range.duration) / total) * 100}%`;
  }
  function repackCommentBands(): void {
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
        band.style.height = '0px';
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
      band.style.height = `${laneEnds.length * 22}px`;
    }
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
      if (row) row.hidden = lane.ancestors.some((id) => collapsed.has(id));
    }
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
      text.append(
        element(
          'strong',
          '',
          node?.name || (node ? node.schema : 'Composition')
        )
      );
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
          const clip = button(child.name || child.schema, 'otio-item', () => {
            inspected = child;
            paintInspector();
          });
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
          event.button !== 0 ||
          (event.target instanceof Element &&
            event.target.closest('[data-comment-id], .otio-timeline-marker'))
        )
          return;
        const rect = rail.getBoundingClientRect();
        const at = (clientX: number): number =>
          bound(
            Math.round(((clientX - rect.left) / rect.width) * frameCount()),
            frameCount()
          );
        const from = Math.min(frameCount() - 1, at(event.clientX));
        rail.setPointerCapture(event.pointerId);
        const update = (moved: PointerEvent, final = false): void => {
          const current = at(moved.clientX);
          let start = Math.min(from, current);
          let end = Math.max(from, current);
          if (mode === 'point') {
            start = Math.min(frameCount() - 1, current);
            end = start;
          }
          if (mode === 'range' && end === start)
            end = Math.min(frameCount(), start + 1);
          if (mode === 'track') {
            start = 0;
            end = frameCount();
          }
          selectFrames(id, start, end, false);
          if (final) emitAim(false);
        };
        update(event);
        const move = (moved: PointerEvent): void => update(moved);
        const done = (moved: PointerEvent): void => {
          rail.removeEventListener('pointermove', move);
          rail.removeEventListener('pointerup', done);
          rail.removeEventListener('pointercancel', cancel);
          update(moved, true);
        };
        const cancel = (): void => {
          rail.removeEventListener('pointermove', move);
          rail.removeEventListener('pointerup', done);
          rail.removeEventListener('pointercancel', cancel);
        };
        rail.addEventListener('pointermove', move);
        rail.addEventListener('pointerup', done);
        rail.addEventListener('pointercancel', cancel);
      });
      rail.addEventListener('keydown', (event) => {
        if (
          event.target !== rail ||
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
            ? rescaleTime(selected.range.start_time, rate).value
            : currentFrame();
        const end =
          selected?.track_id === id
            ? rescaleTime(rangeEndTime(selected.range), rate).value
            : start;
        const delta = event.key === 'ArrowLeft' ? -1 : 1;
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? frameCount() - 1
              : start + delta;
        if (event.shiftKey) {
          mode = 'range';
          selectFrames(id, start, Math.max(start + 1, end + delta), false);
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
    mode = mapped.timeline_range.duration.value === 0 ? 'point' : 'range';
    paintModes();
    const trackId = ownerTrackId(mapped.owner_node_id);
    expandTrack(trackId);
    selectRange(trackId, mapped.timeline_range, false);
    inspected = doc.nodes[mapped.owner_node_id];
    paintInspector();
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
    root.dataset['playing'] = String(state.playing);
    root.dataset['buffering'] = String(state.buffering);
    root.dataset['frame'] = String(rescaleTime(state.time, rate).value);
    root.dataset['previewBlocked'] = String(state.previewBlocked);
    root.classList.toggle('is-base-preview', state.baseMediaPreviewAllowed);
    play.textContent = state.playing ? 'Pause' : 'Play';
    play.disabled = state.previewBlocked || frameCount() === 0;
    clock.textContent = formatOtioTime(
      state.time,
      timelineId ? doc.global_start_times?.[timelineId] : undefined
    );
    clock.dataset['value'] = String(state.time.value);
    clock.dataset['rate'] = String(state.time.rate);
    seek.value = String(rescaleTime(state.time, rate).value);
    const fraction =
      timeToSeconds(duration) > 0
        ? timeToSeconds(state.time) / timeToSeconds(duration)
        : 0;
    playhead.style.left = `calc(var(--otio-label-width) + (100% - var(--otio-label-width)) * ${fraction})`;
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
        : 'Composition · browser-managed SDR';
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
  }
  function initializeTimeline(): void {
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
      tools.hidden = true;
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
    tools.hidden = false;
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
    seek.max = String(Math.max(0, frameCount() - 1));
    inputIn.max = seek.max;
    inputOut.max = String(frameCount());
    seek.disabled = frameCount() === 0;
    previous.disabled = seek.disabled;
    next.disabled = seek.disabled;
    comment.disabled = seek.disabled;
    ruler.replaceChildren(element('div', 'otio-ruler-label', `${rate} fps`));
    const ticks = element('div', 'otio-ruler-ticks');
    for (let i = 0; i <= 10; i++) {
      const label = element(
        'span',
        '',
        formatOtioTime({
          value: (duration.value * i) / 10,
          rate: duration.rate,
        })
      );
      label.style.left = `${i * 10}%`;
      ticks.append(label);
    }
    ruler.append(ticks);
    paintTracks();
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
      })
      .catch((error) => {
        if (disposed || playback !== current) return;
        timelineSettled = true;
        reportPlaybackError(error);
        root.dispatchEvent(
          new CustomEvent('relic:otio-ready', { bubbles: true })
        );
      });
  }
  const controller: OtioUiController = {
    document: doc,
    revision: options.revision,
    paint(anchor, id) {
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
        mark.dataset['start'] = String(range.start_time.value);
        mark.dataset['duration'] = String(range.duration.value);
        mark.dataset['rate'] = String(range.start_time.rate);
        mark.dataset['durationRate'] = String(range.duration.rate);
        const label = `${otioTargetLabel(anchor)} · v${options.revision} · ${rangeLabel(range)}`;
        mark.setAttribute('aria-label', label);
        mark.title = label;
        positionMark(mark, range);
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
      paintSelection();
      inspected = target.item
        ? doc.nodes[target.item]
        : target.track
          ? doc.nodes[target.track]
          : timeline;
      paintInspector();
      seekFrame(rescaleTime(first.start_time, rate).value);
      flushCommentRepack();
      const mark =
        commentId === undefined
          ? rails
              .get(target.track)
              ?.querySelector<HTMLElement>('.otio-selection')
          : marks.get(commentId)?.find((piece) => piece.isConnected);
      if (mark) revealTimelineTarget(mark, true);
    },
    clearMarks() {
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
    let gridWidth = grid.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const width = grid.getBoundingClientRect().width;
      if (width === gridWidth) return;
      gridWidth = width;
      queueCommentRepack();
    });
    observer.observe(grid);
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
}
