import {
  addRationalTimes,
  COMMENT_ANCHOR_OTIO_LIMIT_BYTES,
  evaluateOtioAt,
  indexOtioZip,
  isRawOtio,
  rangeEndTime,
  readOtioDocument,
  rescaleTime,
  resolveOtioAnchor,
  sourceSpansForOtioRange,
  stringifyOtioJson,
  timeToSeconds,
  type OtioAnchorResolution,
  type OtioAnchorV1,
  type OtioDocumentV1,
  type OtioMediaEntry,
  type OtioNode,
  type OtioRationalTime,
  type OtioTimeRange,
  type OtioZipIndex,
} from '@relic/format';
import { otioTargetLabel } from './annotate-otio.ts';
import { attachOtioController, type OtioAimDetail, type OtioUiController } from './otio-bridge.ts';
import { createOtioMediaResolver } from './otio-media.ts';
import { createOtioPlayback, type OtioPlaybackController, type OtioPlaybackState } from './otio-playback.ts';

const encoder = new TextEncoder();
const projectionsKey = (anchor: OtioAnchorV1): string => JSON.stringify(anchor);
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (label: string, className: string, run: () => void): HTMLButtonElement => {
  const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', run); return node;
};
const bound = (value: number, max: number): number => Math.max(0, Math.min(max, value));
const schemaIs = (node: OtioNode, kind: string): boolean => node.schema.split('.')[0] === kind;

/** Display conversion only. Placement and source sampling remain in the core. */
export function formatOtioTime(time: OtioRationalTime, global?: OtioRationalTime): string {
  const value = global ? addRationalTimes(global, time) : time;
  const seconds = timeToSeconds(value);
  const rate = value.rate;
  const whole = Math.floor(Math.max(0, seconds));
  const frame = Math.floor((seconds - whole) * rate + 1e-5);
  return [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60, frame]
    .map(n => String(n).padStart(2, '0')).join(':');
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
  readonly range: OtioTimeRange;
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
  if (anchor.relic_version === revision &&
      anchor.document_sha256 === document.document_sha256 &&
      anchor.timeline_id === timelineId) {
    return { range: anchor.range, track: anchor.track_id, ...(anchor.item_id ? { item: anchor.item_id } : {}) };
  }
  if (!resolution || !['same', 'mapped', 'partial'].includes(resolution.status) ||
      !resolution.mapped_range || resolution.mapped_track_id === undefined ||
      (resolution.mapped_track_id === null && anchor.timeline_id !== timelineId)) return undefined;
  return {
    range: resolution.mapped_range,
    track: resolution.mapped_track_id,
    ...(resolution.mapped_item_id ? { item: resolution.mapped_item_id } : {}),
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
  const item = spans.length === 1 ? document.nodes[spans[0]?.node_id ?? ''] : undefined;
  const track = trackId ? document.nodes[trackId] : undefined;
  const anchor: OtioAnchorV1 = {
    kind: 'otio', v: 1, relic_version: revision, document_sha256: document.document_sha256,
    timeline_id: timelineId, track_id: trackId, ...(item ? { item_id: item.id } : {}), range,
    snapshot: { timeline: boundedLabel(timeline.name), track: track ? boundedLabel(track.name) : null, item: item ? boundedLabel(item.name) : null },
  };
  if (encoder.encode(JSON.stringify(anchor)).length > COMMENT_ANCHOR_OTIO_LIMIT_BYTES) {
    throw new Error('This selection exceeds the encrypted anchor limit.');
  }
  return anchor;
}

interface ParsedOtioContent {
  readonly document: OtioDocumentV1;
  readonly zip?: OtioZipIndex;
}

async function parseContent(content: Uint8Array): Promise<ParsedOtioContent> {
  if (isRawOtio(content)) return { document: readOtioDocument(content) };
  const zip = await indexOtioZip(content);
  const media: Record<string, OtioMediaEntry> = Object.create(null);
  for (const [name, entry] of zip.entries) {
    if (name.startsWith('media/') && !entry.isDirectory) media[name] = { key: name, bundle_path: name, size: entry.uncompressedSize };
  }
  return { document: readOtioDocument(zip.contentOtioBytes, { mediaIndex: media }), zip };
}

interface Lane {
  readonly node: OtioNode;
  readonly depth: number;
  readonly code: string;
  readonly path: readonly string[];
  readonly ancestors: readonly string[];
}

/** Hierarchy only. All editorial ranges come from the normalized document. */
export function otioLanes(document: OtioDocumentV1, timelineId: string): readonly Lane[] {
  const lanes: Lane[] = [];
  let video = 0; let audio = 0;
  const visit = (id: string, path: readonly string[], ancestors: readonly string[], depth: number): void => {
    const node = document.nodes[id]; if (!node) return;
    const isTrack = schemaIs(node, 'Track');
    const nextPath = node.name ? [...path, node.name] : path;
    const nextAncestors = [...ancestors, id];
    if (isTrack) lanes.push({ node, depth, path: nextPath, ancestors, code: node.track_kind === 'Audio' ? `A${++audio}` : `V${++video}` });
    for (const child of node.children_ids) visit(child, nextPath, nextAncestors, depth + (isTrack ? 1 : 0));
  };
  visit(timelineId, [], [], 0);
  return lanes;
}

export interface MountOtioViewOptions {
  readonly content: Uint8Array;
  readonly revision: number;
}

/** Called only by the shell's dynamic import after the OTIO route is chosen. */
export async function mountOtioView(root: HTMLElement, options: MountOtioViewOptions): Promise<void> {
  root.classList.add('otio-view'); root.dataset['ready'] = 'false'; root.dataset['version'] = String(options.revision);
  const loading = element('p', 'otio-loading', 'Loading OTIO'); root.replaceChildren(loading);
  let parsed: ParsedOtioContent;
  try { parsed = await parseContent(options.content); }
  catch (error) {
    if (root.dataset['disposed'] === 'true') return;
    root.dataset['ready'] = 'error'; root.replaceChildren(element('p', 'otio-diagnostic', error instanceof Error ? error.message : 'OTIO could not be read.')); return;
  }
  if (root.dataset['disposed'] === 'true') return;
  const doc = parsed.document;
  let resolver = parsed.zip ? createOtioMediaResolver(parsed.zip) : undefined;
  let playback: OtioPlaybackController | undefined;
  let unsubscribe: (() => void) | undefined;
  let timelineId = doc.timeline_ids.length === 1 ? doc.timeline_ids[0] : undefined;
  let timeline: OtioNode | undefined;
  let lanes: readonly Lane[] = [];
  let duration: OtioRationalTime = { value: 0, rate: 24 };
  let rate = 24;
  let selected: OtioAnchorV1 | null = null;
  let selectedTrack: string | null = null;
  let mode: 'point' | 'range' | 'track' = 'range';
  let inspected: OtioNode | undefined;
  let currentTab: 'inspector' | 'markers' | 'media' = 'inspector';
  let disposed = false;
  let allowBaseMedia = false;
  const collapsed = new Set<string>();
  const rails = new Map<string | null, HTMLElement>();
  const rows = new Map<string, HTMLElement>();
  const projections = new Map<string, OtioAnchorResolution>();
  const originals = new Map<string, Promise<OtioDocumentV1>>();
  const marks = new Map<string, { anchor: OtioAnchorV1; element: HTMLElement }>();
  const cleanup: (() => void)[] = [];

  const monitor = element('div', 'otio-monitor-row');
  const preview = element('div', 'otio-preview');
  const canvas = element('canvas', 'otio-canvas'); canvas.width = 960; canvas.height = 540; canvas.setAttribute('aria-label', 'OTIO composition preview');
  const previewStatus = element('div', 'otio-preview-status'); previewStatus.setAttribute('role', 'status');
  const sdr = element('span', 'otio-preview-scope', 'Composition · browser-managed SDR');
  preview.append(canvas, sdr, previewStatus);
  const inspector = element('aside', 'otio-inspector'); inspector.setAttribute('aria-label', 'OTIO source context');
  const tabs = element('div', 'otio-inspector-tabs'); tabs.setAttribute('role', 'tablist');
  const context = element('div', 'otio-context'); context.setAttribute('role', 'tabpanel');
  for (const value of ['inspector', 'markers', 'media'] as const) {
    const tab = button(value[0].toUpperCase() + value.slice(1), 'otio-inspector-tab', () => { currentTab = value; paintInspector(); });
    tab.dataset['tab'] = value; tab.setAttribute('role', 'tab'); tabs.append(tab);
  }
  inspector.append(tabs, context); monitor.append(preview, inspector);

  const transport = element('div', 'otio-transport'); transport.setAttribute('aria-label', 'OTIO playback');
  const previous = button('Previous frame', 'otio-previous-frame', () => seekFrame(currentFrame() - 1));
  const play = button('Play', 'otio-play', () => { if (playback?.getState().playing) playback.pause(); else void playback?.play().catch(reportPlaybackError); });
  const next = button('Next frame', 'otio-next-frame', () => seekFrame(currentFrame() + 1));
  const clock = element('output', 'otio-time');
  const seek = element('input', 'otio-seek'); seek.type = 'range'; seek.min = '0'; seek.step = '1'; seek.value = '0'; seek.setAttribute('aria-label', 'Timeline frame');
  seek.addEventListener('input', () => seekFrame(Number(seek.value)));
  const inspectToggle = button('Inspector', 'otio-inspector-toggle', () => { const open = monitor.dataset['inspectorOpen'] !== 'true'; monitor.dataset['inspectorOpen'] = String(open); inspectToggle.setAttribute('aria-expanded', String(open)); });
  inspectToggle.setAttribute('aria-expanded', 'false');
  transport.append(previous, play, next, clock, seek, inspectToggle);

  const heading = element('div', 'otio-timeline-heading');
  const name = element('h2', 'otio-timeline-name');
  const timelineSelect = element('select', 'otio-timeline-select'); timelineSelect.setAttribute('aria-label', 'Timeline');
  if (doc.timeline_ids.length !== 1) timelineSelect.append(element('option', '', 'Select timeline'));
  for (const id of doc.timeline_ids) { const option = element('option', '', doc.nodes[id]?.name || id); option.value = id; timelineSelect.append(option); }
  timelineSelect.hidden = doc.timeline_ids.length < 2;
  timelineSelect.addEventListener('change', () => { if (doc.timeline_ids.includes(timelineSelect.value)) { timelineId = timelineSelect.value; initializeTimeline(); } });
  const tools = element('div', 'otio-selection-tools');
  const trackSelect = element('select', 'otio-track-select'); trackSelect.setAttribute('aria-label', 'Comment track');
  trackSelect.addEventListener('change', () => {
    selectedTrack = trackSelect.value || null;
    const start = selected ? rescaleTime(selected.range.start_time, rate).value : currentFrame();
    const end = selected ? rescaleTime(rangeEndTime(selected.range), rate).value : start + (mode === 'point' ? 0 : 1);
    selectFrames(selectedTrack, start, end, false);
  });
  for (const value of ['point', 'range', 'track'] as const) {
    const control = button(value[0].toUpperCase() + value.slice(1), 'otio-mode', () => {
      mode = value; const start = selected ? rescaleTime(selected.range.start_time, rate).value : currentFrame();
      const end = selected ? rescaleTime(rangeEndTime(selected.range), rate).value : start + 1;
      selectFrames(selectedTrack, value === 'track' ? 0 : start, value === 'point' ? start : value === 'track' ? frameCount() : Math.max(start + 1, end), false);
      paintModes();
    });
    control.dataset['otioMode'] = value; tools.append(control);
  }
  tools.append(trackSelect); heading.append(name, timelineSelect, tools);
  const scroll = element('div', 'otio-timeline-scroll'); scroll.tabIndex = 0; scroll.setAttribute('aria-label', 'Timeline tracks');
  const grid = element('div', 'otio-track-grid');
  const ruler = element('div', 'otio-ruler');
  const trackRows = element('div', 'otio-track-rows');
  const playhead = element('div', 'otio-playhead'); playhead.setAttribute('aria-hidden', 'true');
  grid.append(ruler, trackRows, playhead); scroll.append(grid);
  const selectionBar = element('div', 'otio-selection-readout');
  const selectionLabel = element('span', 'otio-selection-label', 'Composition');
  const inputIn = element('input', 'otio-selection-in'); inputIn.type = 'number'; inputIn.min = '0'; inputIn.step = '1'; inputIn.setAttribute('aria-label', 'Selection in frame');
  const inputOut = element('input', 'otio-selection-out'); inputOut.type = 'number'; inputOut.min = '0'; inputOut.step = '1'; inputOut.setAttribute('aria-label', 'Selection out frame');
  const inLabel = element('label', '', 'In '); inLabel.append(inputIn);
  const outLabel = element('label', '', 'Out '); outLabel.append(inputOut);
  const applyInputs = (): void => { const start = bound(Number(inputIn.value) || 0, Math.max(0, frameCount() - 1)); const end = mode === 'point' ? start : Math.max(start + 1, Math.min(frameCount(), Number(inputOut.value) || start + 1)); selectFrames(selectedTrack, start, end, false); };
  inputIn.addEventListener('change', applyInputs); inputOut.addEventListener('change', applyInputs);
  const comment = button('Comment', 'otio-comment-selection', () => {
    if (!selected) selectFrames(selectedTrack, currentFrame(), mode === 'point' ? currentFrame() : currentFrame() + 1, false);
    emitAim(true);
  });
  const clear = button('Clear', 'otio-clear-selection', () => { selected = null; paintSelection(); root.dispatchEvent(new CustomEvent('relic:otio-selection-cleared', { bubbles: true })); });
  selectionBar.append(selectionLabel, inLabel, outLabel, comment, clear);
  const diagnostics = element('div', 'otio-diagnostics'); diagnostics.setAttribute('role', 'status');
  root.replaceChildren(monitor, transport, heading, scroll, selectionBar, diagnostics);

  function currentFrame(): number { const time = playback?.getState().time; return time ? Math.round(rescaleTime(time, rate).value) : 0; }
  function frameCount(): number { return Math.max(0, Math.ceil(rescaleTime(duration, rate).value)); }
  function reportPlaybackError(error: unknown): void { previewStatus.hidden = false; previewStatus.replaceChildren(element('p', 'otio-diagnostic', error instanceof Error ? error.message : 'Playback unavailable.')); }
  function seekFrame(frame: number): void {
    const time = { value: bound(frame, Math.max(0, frameCount() - 1)), rate };
    playback?.pause(); void playback?.seek(time).catch(reportPlaybackError);
  }
  function paintModes(): void { for (const control of tools.querySelectorAll<HTMLButtonElement>('[data-otio-mode]')) control.setAttribute('aria-pressed', String(control.dataset['otioMode'] === mode)); }
  function projectionOf(anchor: OtioAnchorV1): OtioProjectionTarget | undefined {
    return otioProjectionTarget(anchor, options.revision, doc, timelineId, projections.get(projectionsKey(anchor)));
  }
  function selectFrames(trackId: string | null, start: number, end: number, focus: boolean): void {
    if (!timelineId || !timeline || frameCount() === 0) return;
    const a = bound(Math.min(start, end), Math.max(0, frameCount() - 1));
    const b = bound(Math.max(start, end), frameCount());
    const range: OtioTimeRange = { start_time: { value: a, rate }, duration: { value: Math.max(0, b - a), rate } };
    try {
      selected = createOtioSelection(doc, timelineId, trackId, options.revision, range);
    } catch (error) {
      diagnostics.replaceChildren(element('p', 'otio-diagnostic', error instanceof Error ? error.message : 'Selection unavailable.'));
      return;
    }
    selectedTrack = trackId;
    inspected = selected.item_id ? doc.nodes[selected.item_id] : trackId ? doc.nodes[trackId] : timeline;
    paintSelection(); paintInspector(); seekFrame(a); if (focus) emitAim(true);
  }
  function emitAim(focus: boolean): void {
    if (!selected) return;
    const detail: OtioAimDetail = { anchor: selected, focus, measure: () => root.querySelector<HTMLElement>('.otio-selection')?.getBoundingClientRect() ?? comment.getBoundingClientRect() };
    root.dispatchEvent(new CustomEvent('relic:otio-aim', { detail, bubbles: true }));
  }
  function paintSelection(): void {
    for (const rail of rails.values()) { rail.querySelectorAll('.otio-selection').forEach(node => node.remove()); rail.dataset['selected'] = String(selected?.track_id === (rail.dataset['trackId'] || null)); }
    if (!selected) { selectionLabel.textContent = 'Composition'; inputIn.disabled = true; inputOut.disabled = true; clear.disabled = true; return; }
    inputIn.disabled = false; inputOut.disabled = false; clear.disabled = false;
    selectionLabel.textContent = otioTargetLabel(selected);
    inputIn.value = String(rescaleTime(selected.range.start_time, rate).value); inputOut.value = String(rescaleTime(rangeEndTime(selected.range), rate).value);
    outLabel.hidden = selected.range.duration.value === 0; trackSelect.value = selected.track_id || '';
    const rail = rails.get(selected.track_id); if (!rail) return;
    const mark = element('div', 'otio-selection' + (selected.range.duration.value === 0 ? ' is-point' : ''));
    mark.dataset['start'] = String(selected.range.start_time.value); mark.dataset['duration'] = String(selected.range.duration.value); mark.dataset['rate'] = String(selected.range.start_time.rate); mark.dataset['trackId'] = selected.track_id ?? '';
    positionMark(mark, selected.range); rail.append(mark);
  }
  function positionMark(mark: HTMLElement, range: OtioTimeRange): void {
    const total = timeToSeconds(duration); if (total <= 0) return;
    mark.style.left = `${timeToSeconds(range.start_time) / total * 100}%`;
    if (range.duration.value > 0) mark.style.width = `${timeToSeconds(range.duration) / total * 100}%`;
  }
  function expandTrack(trackId: string | null): void {
    const lane = lanes.find(value => value.node.id === trackId); if (!lane) return;
    for (const ancestor of lane.ancestors) collapsed.delete(ancestor);
    applyDisclosure();
  }
  function applyDisclosure(): void {
    for (const lane of lanes) { const row = rows.get(lane.node.id); if (row) row.hidden = lane.ancestors.some(id => collapsed.has(id)); }
    for (const control of trackRows.querySelectorAll<HTMLButtonElement>('[data-disclose]')) control.setAttribute('aria-expanded', String(!collapsed.has(control.dataset['disclose'] ?? '')));
  }
  function paintTracks(): void {
    rails.clear(); rows.clear(); marks.clear(); trackRows.replaceChildren(); trackSelect.replaceChildren();
    const compositionOption = element('option', '', 'Composition'); compositionOption.value = ''; trackSelect.append(compositionOption);
    const addLane = (lane?: Lane): void => {
      const node = lane?.node; const id = node?.id ?? null;
      const row = element('div', 'otio-track-row' + (!lane ? ' otio-composition-row' : '')); row.dataset['trackId'] = id ?? ''; row.dataset['depth'] = String(lane?.depth ?? 0); row.dataset['enabled'] = String(node?.enabled ?? true);
      const label = element('div', 'otio-track-label');
      if (lane) label.append(element('span', 'otio-track-code', lane.code));
      const text = element('div', 'otio-track-name'); text.append(element('strong', '', node?.name || (node ? node.schema : 'Composition')));
      if (node) text.append(element('small', '', node.json_pointer)); label.append(text);
      if (lane && lanes.some(child => child.ancestors.includes(lane.node.id))) {
        const disclosure = button('▾', 'otio-disclosure', () => { if (collapsed.has(lane.node.id)) collapsed.delete(lane.node.id); else collapsed.add(lane.node.id); applyDisclosure(); });
        disclosure.dataset['disclose'] = node?.id; disclosure.setAttribute('aria-label', `Nested tracks in ${node?.name}`); disclosure.setAttribute('aria-expanded', String(!collapsed.has(lane.node.id))); label.append(disclosure);
      }
      if (node) {
        const kind = node.track_kind === 'Audio' ? 'Mute' : 'Hide';
        const toggle = button(kind, 'otio-track-toggle', () => {
          const state = playback?.getState().tracks[node.id]; if (!state) return;
          if (node.track_kind === 'Audio') playback?.setTrackMute(node.id, !state.muted); else playback?.setTrackVisibility(node.id, !state.visible);
        });
        toggle.setAttribute('aria-label', `${kind} ${lane?.code} ${node.name}`); toggle.dataset['trackToggle'] = node.id; label.append(toggle);
        const option = element('option', '', `${lane?.code} · ${node.name} · ${node.json_pointer}`); option.value = node.id; trackSelect.append(option);
      }
      const rail = element('div', 'otio-track-rail'); rail.dataset['trackId'] = id ?? ''; rail.tabIndex = 0; rail.setAttribute('aria-label', lane ? `${lane.code} · ${node?.name} · ${node?.json_pointer}` : 'Composition');
      rails.set(id, rail);
      if (node) {
        for (const childId of node.children_ids) {
          const child = doc.nodes[childId]; if (!child) continue;
          const clip = button(child.name || child.schema, 'otio-item', () => { inspected = child; paintInspector(); });
          clip.dataset['itemId'] = child.id; clip.dataset['schema'] = child.schema; clip.dataset['enabled'] = String(child.enabled); clip.title = `${child.name} · ${child.schema}`;
          if (schemaIs(child, 'Gap')) clip.classList.add('is-gap');
          if (schemaIs(child, 'Transition')) clip.classList.add('is-transition');
          if (child.children_ids.length) clip.classList.add('is-compound');
          if (child.diagnostics?.length) clip.classList.add('has-diagnostic');
          if (child.timeline_range) positionMark(clip, child.timeline_range);
          else { clip.classList.add('is-unplaced'); clip.textContent = `Unplaced · ${child.name || child.schema}`; }
          rail.append(clip);
        }
      }
      rail.addEventListener('pointerdown', event => {
        if (event.button !== 0 || (event.target instanceof Element && event.target.closest('[data-comment-id]'))) return;
        const rect = rail.getBoundingClientRect(); const at = (clientX: number): number => bound(Math.round((clientX - rect.left) / rect.width * frameCount()), frameCount());
        const from = Math.min(frameCount() - 1, at(event.clientX));
        rail.setPointerCapture(event.pointerId);
        const update = (moved: PointerEvent, final = false): void => {
          const current = at(moved.clientX); let start = Math.min(from, current); let end = Math.max(from, current);
          if (mode === 'point') { start = Math.min(frameCount() - 1, current); end = start; }
          if (mode === 'range' && end === start) end = Math.min(frameCount(), start + 1);
          if (mode === 'track') { start = 0; end = frameCount(); }
          selectFrames(id, start, end, false); if (final) emitAim(false);
        };
        update(event);
        const move = (moved: PointerEvent): void => update(moved);
        const done = (moved: PointerEvent): void => { rail.removeEventListener('pointermove', move); rail.removeEventListener('pointerup', done); rail.removeEventListener('pointercancel', cancel); update(moved, true); };
        const cancel = (): void => { rail.removeEventListener('pointermove', move); rail.removeEventListener('pointerup', done); rail.removeEventListener('pointercancel', cancel); };
        rail.addEventListener('pointermove', move); rail.addEventListener('pointerup', done); rail.addEventListener('pointercancel', cancel);
      });
      rail.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
        event.preventDefault();
        if (event.key === 'Enter') { if (!selected || selected.track_id !== id) selectFrames(id, currentFrame(), mode === 'point' ? currentFrame() : currentFrame() + 1, false); emitAim(true); return; }
        const start = selected?.track_id === id ? rescaleTime(selected.range.start_time, rate).value : currentFrame();
        const end = selected?.track_id === id ? rescaleTime(rangeEndTime(selected.range), rate).value : start;
        const delta = event.key === 'ArrowLeft' ? -1 : 1;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? frameCount() - 1 : start + delta;
        if (event.shiftKey) { mode = 'range'; selectFrames(id, start, Math.max(start + 1, end + delta), false); }
        else selectFrames(id, next, mode === 'point' ? next : next + 1, false);
        paintModes(); emitAim(false);
      });
      row.append(label, rail); trackRows.append(row); if (id) rows.set(id, row);
    };
    addLane(); for (const lane of lanes) addLane(lane);
    applyDisclosure(); paintSelection();
  }
  function detail(name: string, value: string, list: HTMLDListElement): void { list.append(element('dt', '', name), element('dd', '', value)); }
  function rangeLabel(range: OtioTimeRange): string { return `${range.start_time.value} @ ${range.start_time.rate}, duration ${range.duration.value} @ ${range.duration.rate}`; }
  function paintInspector(): void {
    context.replaceChildren();
    for (const tab of tabs.querySelectorAll<HTMLButtonElement>('[data-tab]')) tab.setAttribute('aria-selected', String(tab.dataset['tab'] === currentTab));
    if (currentTab === 'media') {
      for (const node of Object.values(doc.nodes)) for (const [key, reference] of Object.entries(node.media_references ?? {})) {
        const entry = element('div', 'otio-media-reference'); entry.append(element('strong', '', reference.target_url || reference.target_url_base || reference.schema), element('span', '', `${key} · ${key === node.active_media_reference_key ? 'active' : 'inactive'} · ${reference.schema}`)); context.append(entry);
      }
      return;
    }
    if (currentTab === 'markers') {
      const current = playback?.getState();
      const active = current && timelineId ? evaluateOtioAt(doc, timelineId, current.time).active_markers : [];
      for (const node of Object.values(doc.nodes)) for (const marker of node.markers ?? []) {
        const entry = element('div', 'otio-inspector-marker'); entry.append(element('strong', '', marker.name || marker.schema), element('span', '', `${node.name} · ${marker.color || ''} · source ${rangeLabel(marker.marked_range)}`));
        if (marker.comment) entry.append(element('p', '', marker.comment));
        const mapped = active.find(m => m.owner_node_id === node.id && m.marker === marker);
        if (mapped) entry.append(button(formatOtioTime(mapped.timeline_range.start_time, timelineId ? doc.global_start_times?.[timelineId] : undefined), '', () => selectFrames(null, rescaleTime(mapped.timeline_range.start_time, rate).value, rescaleTime(rangeEndTime(mapped.timeline_range), rate).value, false)));
        context.append(entry);
      }
      return;
    }
    const node = inspected ?? timeline ?? Object.values(doc.nodes)[0]; if (!node) return;
    context.append(element('h3', '', node.name || node.schema), element('p', 'otio-schema', node.schema));
    const list = element('dl', ''); detail('Identity', node.id, list); detail('Origin', node.identity_origin, list); detail('JSON pointer', node.json_pointer, list); detail('Enabled', String(node.enabled), list);
    for (const [label, range] of [['Timeline', node.timeline_range], ['Source', node.source_range], ['Available', node.available_range]] as const) if (range) detail(label, rangeLabel(range), list);
    if (node.active_media_reference_key) detail('Active reference', node.active_media_reference_key, list);
    context.append(list);
    if (node.effects?.length) { context.append(element('h4', '', 'Effects')); for (const effect of node.effects) context.append(element('p', 'otio-effect', `${effect.name || effect.effect_name || effect.schema} · ${effect.enabled ? 'enabled' : 'disabled'}${effect.time_scalar !== undefined ? ` · time_scalar ${effect.time_scalar}` : ''}`)); }
    if (node.transition_type) context.append(element('p', 'otio-effect', `${node.transition_type} · in ${node.in_offset?.value ?? 0} @ ${node.in_offset?.rate ?? rate} · out ${node.out_offset?.value ?? 0} @ ${node.out_offset?.rate ?? rate}`));
    if (node.metadata && Object.keys(node.metadata).length) { const raw = element('pre', 'otio-metadata', stringifyOtioJson(node.metadata)); context.append(element('h4', '', 'Metadata'), raw); }
    for (const diagnostic of node.diagnostics ?? []) context.append(element('p', 'otio-diagnostic', `${diagnostic.code} · ${diagnostic.message}`));
  }
  function paintState(state: OtioPlaybackState): void {
    if (disposed) return;
    root.dataset['playing'] = String(state.playing); root.dataset['buffering'] = String(state.buffering); root.dataset['frame'] = String(rescaleTime(state.time, rate).value);
    play.textContent = state.playing ? 'Pause' : 'Play'; clock.textContent = formatOtioTime(state.time, timelineId ? doc.global_start_times?.[timelineId] : undefined); clock.dataset['value'] = String(state.time.value); clock.dataset['rate'] = String(state.time.rate); seek.value = String(rescaleTime(state.time, rate).value);
    const fraction = timeToSeconds(duration) > 0 ? timeToSeconds(state.time) / timeToSeconds(duration) : 0;
    playhead.style.left = `calc(var(--otio-label-width) + (100% - var(--otio-label-width)) * ${fraction})`;
    for (const toggle of trackRows.querySelectorAll<HTMLButtonElement>('[data-track-toggle]')) {
      const track = state.tracks[toggle.dataset['trackToggle'] ?? '']; if (track) toggle.setAttribute('aria-pressed', String(track.kind === 'Audio' ? track.muted : !track.visible));
    }
    const issues = [...doc.diagnostics, ...state.diagnostics];
    const unique = new Map(issues.map(issue => [`${issue.code}:${issue.target?.node_id}:${issue.message}`, issue]));
    diagnostics.replaceChildren(...[...unique.values()].map(issue => element('p', 'otio-diagnostic', `${issue.code} · ${issue.message}`)));
    const blocking = state.diagnostics.filter(issue => issue.code !== 'supported' && (issue.severity === 'error' || ['unsupported-effect', 'unsupported-codec', 'missing-media', 'missing-handles', 'unsupported-browser'].includes(issue.code)));
    previewStatus.replaceChildren(); previewStatus.hidden = !state.buffering && blocking.length === 0;
    if (state.buffering) previewStatus.append(element('p', 'otio-buffering', 'Buffering'));
    if (blocking.length) {
      previewStatus.append(...blocking.map(issue => element('p', 'otio-diagnostic', `${issue.code} · ${issue.message}`)));
      if (blocking.some(issue => issue.code === 'unsupported-effect') && !allowBaseMedia) previewStatus.append(button('Preview base media without unsupported effects', 'otio-preview-base', () => { allowBaseMedia = true; previewStatus.hidden = true; root.classList.add('is-base-preview'); }));
      if (allowBaseMedia && blocking.every(issue => issue.code === 'unsupported-effect')) { previewStatus.hidden = true; sdr.textContent = 'unsupported-effect · base media preview · browser-managed SDR'; }
    }
  }
  function initializeTimeline(): void {
    unsubscribe?.(); playback?.dispose(); selected = null; marks.clear(); projections.clear(); collapsed.clear();
    timeline = timelineId ? doc.nodes[timelineId] : undefined; inspected = timeline;
    name.textContent = timeline?.name || 'OTIO'; root.dataset['timelineId'] = timelineId ?? '';
    if (!timeline || !timelineId) {
      name.textContent = doc.timeline_ids.length ? 'Select timeline' : 'OTIO structural inspector';
      transport.hidden = true; tools.hidden = true; selectionBar.hidden = true;
      trackRows.replaceChildren(); paintInspector(); root.dataset['ready'] = 'true'; return;
    }
    transport.hidden = false; tools.hidden = false; selectionBar.hidden = false;
    lanes = otioLanes(doc, timelineId);
    if (!resolver && parsed.zip) resolver = createOtioMediaResolver(parsed.zip);
    playback = createOtioPlayback({ document: doc, timelineId, canvas, resolveMedia: resolver ?? (() => null) });
    const initial = playback.getState(); duration = initial.duration; rate = initial.rate;
    seek.max = String(Math.max(0, frameCount() - 1)); inputIn.max = seek.max; inputOut.max = String(frameCount());
    ruler.replaceChildren(element('div', 'otio-ruler-label', `${rate} fps`));
    const ticks = element('div', 'otio-ruler-ticks');
    for (let i = 0; i <= 10; i++) { const label = element('span', '', formatOtioTime({ value: duration.value * i / 10, rate: duration.rate })); label.style.left = `${i * 10}%`; ticks.append(label); }
    ruler.append(ticks); paintTracks(); paintInspector(); paintModes();
    unsubscribe = playback.subscribe(paintState); paintState(initial);
    void playback.seek({ value: 0, rate }).then(() => { if (!disposed) { root.dataset['ready'] = 'true'; root.dispatchEvent(new CustomEvent('relic:otio-ready', { bubbles: true })); } }).catch(error => { reportPlaybackError(error); root.dataset['ready'] = 'true'; root.dispatchEvent(new CustomEvent('relic:otio-ready', { bubbles: true })); });
  }
  const controller: OtioUiController = {
    document: doc, revision: options.revision,
    paint(anchor, id) {
      const target = projectionOf(anchor); if (!target || !rails.has(target.track)) return false;
      const existing = marks.get(id); existing?.element.remove();
      const mark = element('button', 'otio-comment-mark' + (target.range.duration.value === 0 ? ' is-point' : ''));
      mark.type = 'button';
      mark.dataset['commentId'] = id; mark.setAttribute('aria-label', otioTargetLabel(anchor)); mark.title = otioTargetLabel(anchor); positionMark(mark, target.range);
      const projection = projections.get(projectionsKey(anchor)); if (projection) mark.dataset['projection'] = projection.status;
      rails.get(target.track)?.append(mark); marks.set(id, { anchor, element: mark }); return true;
    },
    reveal(anchor) {
      const target = projectionOf(anchor); if (!target) return;
      expandTrack(target.track); const rail = rails.get(target.track);
      rail?.scrollIntoView({ block: 'nearest', inline: 'center' });
      if (timelineId) selected = createOtioSelection(doc, timelineId, target.track, options.revision, target.range);
      selectedTrack = target.track; paintSelection();
      inspected = target.item ? doc.nodes[target.item] : target.track ? doc.nodes[target.track] : timeline; paintInspector();
      seekFrame(rescaleTime(target.range.start_time, rate).value);
    },
    clearMarks() { for (const mark of marks.values()) mark.element.remove(); marks.clear(); },
    async project(anchor, content) {
      const key = `${anchor.relic_version}:${anchor.document_sha256}`;
      let original = originals.get(key);
      if (!original) { original = parseContent(content).then(result => result.document); originals.set(key, original); }
      const document = await original;
      if (document.document_sha256 !== anchor.document_sha256) throw new Error('Original OTIO document digest differs from the encrypted anchor.');
      const result = resolveOtioAnchor(anchor, document, doc); projections.set(projectionsKey(anchor), result); return result;
    },
    projection: anchor => projections.get(projectionsKey(anchor)),
    dispose() { if (disposed) return; disposed = true; root.dataset['disposed'] = 'true'; unsubscribe?.(); playback?.dispose(); resolver?.dispose(); for (const dispose of cleanup) dispose(); },
  };
  attachOtioController(root, controller);
  const pagehide = (): void => controller.dispose(); window.addEventListener('pagehide', pagehide); cleanup.push(() => window.removeEventListener('pagehide', pagehide));
  initializeTimeline();
}
