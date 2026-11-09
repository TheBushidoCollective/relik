import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  crc32,
  type OtioAnchorResolution,
  type OtioAnchorV1,
  readOtioDocument,
} from '@relic/format';
import { otioAdapter, otioTargetLabel } from '../src/annotate-otio.ts';
import {
  otioControllerFor,
  type OtioUiController,
} from '../src/otio-bridge.ts';
import {
  createOtioSelection,
  formatOtioTime,
  mountOtioView,
  otioLanes,
  otioProjectionTarget,
  otioScopeRange,
  readOtioForProjection,
} from '../src/otio-view.ts';

const range = (start: number, duration: number) => ({
  start_time: { value: start, rate: 24 },
  duration: { value: duration, rate: 24 },
});
const clip = (id: string, name: string) => ({
  OTIO_SCHEMA: 'Clip.1',
  name,
  metadata: { relic: { id } },
  source_range: range(48, 24),
  media_reference: {
    OTIO_SCHEMA: 'ExternalReference.1',
    target_url: `media/${id}.mp4`,
    available_range: range(24, 96),
  },
});
const document = readOtioDocument(
  JSON.stringify({
    OTIO_SCHEMA: 'Timeline.1',
    name: 'Relik Feature Editorial',
    metadata: { relic: { id: 'timeline' } },
    global_start_time: { value: 86400, rate: 24 },
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: [
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'Video 2',
          kind: 'Video',
          metadata: { relic: { id: 'video-first' } },
          children: [
            clip('primary', 'Primary Grade A'),
            clip('secondary', 'Secondary Grade B'),
            {
              OTIO_SCHEMA: 'Stack.1',
              name: 'VFX Submaster Stack',
              source_range: range(0, 24),
              children: [
                {
                  OTIO_SCHEMA: 'Track.1',
                  name: 'Plate Base',
                  kind: 'Video',
                  metadata: { relic: { id: 'plate-track' } },
                  children: [clip('plate', 'Background CG Plate')],
                },
              ],
            },
          ],
        },
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'Video 2',
          kind: 'Video',
          metadata: { relic: { id: 'video-second' } },
          enabled: false,
          children: [clip('overlay', 'Picture-in-Picture Alpha')],
        },
        {
          OTIO_SCHEMA: 'Track.1',
          name: 'Dialogue DX',
          kind: 'Audio',
          metadata: { relic: { id: 'dialogue' } },
          children: [clip('dialogue-clip', 'Interview Mic 1')],
        },
      ],
    },
  })
);

const anchor = createOtioSelection(
  document,
  'timeline',
  'video-second',
  1,
  range(12, 0)
);

function resolution(
  status: OtioAnchorResolution['status']
): OtioAnchorResolution {
  return {
    status,
    original_anchor: anchor,
    mapped_ranges: [range(24, 12)],
    mapped_range: range(24, 12),
    mapped_timeline_id: 'timeline',
    mapped_track_id: 'video-second',
    source_spans: [],
    diagnostics: [],
  };
}

interface StoredZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly crc?: number;
}

function createStoredZip(entries: readonly StoredZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const directories: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const checksum = entry.crc ?? crc32(entry.bytes);
    const local = new Uint8Array(30 + name.length + entry.bytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint32(14, checksum, true);
    view.setUint32(18, entry.bytes.length, true);
    view.setUint32(22, entry.bytes.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.bytes, 30 + name.length);
    offsets.push(offset);
    locals.push(local);
    offset += local.length;
  }

  const directoryOffset = offset;
  for (const [index, entry] of entries.entries()) {
    const name = new TextEncoder().encode(entry.name);
    const checksum = entry.crc ?? crc32(entry.bytes);
    const central = new Uint8Array(46 + name.length);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0, true);
    view.setUint16(14, 0, true);
    view.setUint32(16, checksum, true);
    view.setUint32(20, entry.bytes.length, true);
    view.setUint32(24, entry.bytes.length, true);
    view.setUint16(28, name.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, offsets[index] ?? 0, true);
    central.set(name, 46);
    directories.push(central);
    offset += central.length;
  }

  const footer = new Uint8Array(22);
  const footerView = new DataView(footer.buffer);
  footerView.setUint32(0, 0x06054b50, true);
  footerView.setUint16(4, 0, true);
  footerView.setUint16(6, 0, true);
  footerView.setUint16(8, entries.length, true);
  footerView.setUint16(10, entries.length, true);
  footerView.setUint32(12, offset - directoryOffset, true);
  footerView.setUint32(16, directoryOffset, true);
  footerView.setUint16(20, 0, true);

  const archive = new Uint8Array(offset + footer.length);
  let cursor = 0;
  for (const local of locals) {
    archive.set(local, cursor);
    cursor += local.length;
  }
  for (const directory of directories) {
    archive.set(directory, cursor);
    cursor += directory.length;
  }
  archive.set(footer, cursor);
  return archive;
}

function otioz(
  content: Uint8Array,
  media: readonly StoredZipEntry[]
): Uint8Array {
  return createStoredZip([
    { name: 'version.txt', bytes: new TextEncoder().encode('1.0.0\n') },
    { name: 'content.otio', bytes: content },
    ...media,
  ]);
}

function projectionContent(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      name: 'Projection source',
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            name: 'Dialogue',
            kind: 'Audio',
            metadata: { relic: { id: 'projection-track' } },
            children: [
              {
                OTIO_SCHEMA: 'Clip.1',
                name: 'Interview',
                metadata: { relic: { id: 'projection-clip' } },
                source_range: range(0, 24),
                media_reference: {
                  OTIO_SCHEMA: 'ExternalReference.1',
                  target_url: 'clip.mp4',
                  available_range: range(0, 24),
                },
              },
            ],
          },
        ],
      },
    })
  );
}

function nestedSelectionContent(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      source_range: range(0, 96),
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            kind: 'Video',
            metadata: { relic: { id: 'outer-track' } },
            children: [
              {
                OTIO_SCHEMA: 'Gap.1',
                metadata: { relic: { id: 'leading-gap' } },
                source_range: range(0, 48),
              },
              {
                OTIO_SCHEMA: 'Stack.1',
                source_range: range(0, 24),
                children: [
                  {
                    OTIO_SCHEMA: 'Track.1',
                    kind: 'Video',
                    metadata: { relic: { id: 'nested-track' } },
                    children: [clip('nested-clip', 'Nested clip')],
                  },
                ],
              },
              {
                OTIO_SCHEMA: 'Gap.1',
                metadata: { relic: { id: 'trailing-gap' } },
                source_range: range(0, 24),
              },
            ],
          },
        ],
      },
    })
  );
}

function structuralContent(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      name: 'Structural only',
      tracks: { OTIO_SCHEMA: 'Stack.1', children: [] },
    })
  );
}

function focusedSelectionContent(timelineRange = range(0, 96)): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      OTIO_SCHEMA: 'Timeline.1',
      name: 'Relik Feature Editorial',
      metadata: { relic: { id: 'focused-timeline' } },
      source_range: timelineRange,
      tracks: {
        OTIO_SCHEMA: 'Stack.1',
        children: [
          {
            OTIO_SCHEMA: 'Track.1',
            name: 'Video 1',
            kind: 'Video',
            metadata: { relic: { id: 'focused-video' } },
            source_range: range(0, 96),
            children: [
              {
                ...clip('focused-a', 'Primary Grade A'),
                markers: [
                  {
                    OTIO_SCHEMA: 'Marker.2',
                    name: 'Grade Correction Required',
                    marked_range: range(54, 0),
                  },
                  {
                    OTIO_SCHEMA: 'Marker.2',
                    name: 'SMPTE_Dissolve_1',
                    marked_range: range(74, 0),
                  },
                ],
              },
              {
                OTIO_SCHEMA: 'Transition.1',
                name: 'SMPTE_Dissolve_1',
                metadata: { relic: { id: 'focused-transition' } },
                transition_type: 'SMPTE_Dissolve',
                in_offset: { value: 6, rate: 24 },
                out_offset: { value: 6, rate: 24 },
              },
              clip('focused-b', 'Secondary Grade B'),
              {
                OTIO_SCHEMA: 'Gap.1',
                name: 'Slug V1',
                metadata: { relic: { id: 'focused-gap' } },
                source_range: range(0, 24),
              },
              {
                ...clip('focused-disabled', 'Disabled Duplicate Picture'),
                enabled: false,
              },
            ],
          },
          {
            OTIO_SCHEMA: 'Track.1',
            name: 'Dialogue DX',
            kind: 'Audio',
            metadata: { relic: { id: 'focused-audio' } },
            children: [clip('focused-dialogue', 'Interview Mic 1')],
          },
          {
            OTIO_SCHEMA: 'Track.1',
            name: 'Unplaced',
            kind: 'Video',
            metadata: { relic: { id: 'focused-unplaced-track' } },
            children: [
              {
                OTIO_SCHEMA: 'Clip.1',
                name: 'Unplaced',
                metadata: { relic: { id: 'focused-unplaced' } },
              },
            ],
          },
        ],
      },
    })
  );
}

class ViewElement {
  id = '';
  className = '';
  textContent = '';
  disabled = false;
  hidden = false;
  tabIndex = 0;
  type = '';
  title = '';
  min = '';
  max = '';
  value = '';
  src = '';
  preload = '';
  muted = false;
  playsInline = false;
  volume = 1;
  currentTime = 0;
  readyState = 4;
  error: MediaError | null = null;
  width = 0;
  height = 0;
  clientLeft = 0;
  clientTop = 0;
  clientWidth = 1;
  clientHeight = 1;
  scrollLeft = 0;
  scrollTop = 0;
  parentElement: ViewElement | null = null;
  readonly children: ViewElement[] = [];
  layout?: DOMRect;
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  private readonly capturedPointers = new Set<number>();
  readonly attributes = new Map<string, string>();
  readonly style = {
    setProperty: (): void => {},
    position: '',
    width: '',
    height: '',
    minHeight: '',
    overflow: '',
    clipPath: '',
    pointerEvents: '',
  };
  readonly classList = {
    contains: (name: string): boolean =>
      this.className.split(/\s+/).includes(name),
    add: (...names: string[]): void => {
      const current = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const name of names) current.add(name);
      this.className = [...current].join(' ');
    },
    remove: (...names: string[]): void => {
      const current = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const name of names) current.delete(name);
      this.className = [...current].join(' ');
    },
    toggle: (name: string, force?: boolean): boolean => {
      const current = new Set(this.className.split(/\s+/).filter(Boolean));
      const next = force ?? !current.has(name);
      if (next) current.add(name);
      else current.delete(name);
      this.className = [...current].join(' ');
      return next;
    },
  };

  constructor(readonly tagName: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...children: ViewElement[]): void {
    for (const child of children) this.appendChild(child);
  }

  appendChild(child: ViewElement): ViewElement {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: ViewElement[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children.length = 0;
    this.append(...children);
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    if (!event.target)
      Object.defineProperty(event, 'target', {
        configurable: true,
        value: this,
      });
    for (const listener of this.listeners.get(event.type) ?? [])
      listener(event);
    if (event.bubbles && !event.cancelBubble)
      this.parentElement?.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  querySelector(selector?: string): ViewElement | null {
    if (!selector) return null;
    return (
      findViewElement(this, (el) => {
        if (selector.startsWith('.')) {
          const cls = selector.slice(1).split('[')[0]!;
          if (!el.className.split(/\s+/).includes(cls)) return false;
        }
        if (selector.includes('[data-comment-id="')) {
          const m = selector.match(/\[data-comment-id="([^"]+)"\]/);
          if (m && el.dataset['commentId'] !== m[1]) return false;
        }
        if (selector.includes('[data-tab="')) {
          const m = selector.match(/\[data-tab="([^"]+)"\]/);
          if (m && el.dataset['tab'] !== m[1]) return false;
        }
        return true;
      }) ?? null
    );
  }

  querySelectorAll(selector: string): ViewElement[] {
    const found: ViewElement[] = [];
    const visit = (parent: ViewElement): void => {
      for (const child of parent.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  matches(selector: string): boolean {
    if (selector.includes(','))
      return selector.split(',').some((part) => this.matches(part.trim()));
    if (selector.startsWith('.'))
      return this.className.split(/\s+/).includes(selector.slice(1));
    const attribute = selector.match(/^\[data-([a-z-]+)\]$/);
    if (!attribute) return false;
    const key = attribute[1]!.replace(/-([a-z])/g, (_match, letter: string) =>
      letter.toUpperCase()
    );
    return Object.hasOwn(this.dataset, key);
  }

  closest(selector: string): ViewElement | null {
    let node: ViewElement | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  get isConnected(): boolean {
    return this.parentElement !== null;
  }

  getBoundingClientRect(): DOMRect {
    if (this.layout) return this.layout;
    return {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      top: 0,
      right: 1,
      bottom: 1,
      left: 0,
      toJSON: () => ({}),
    } as DOMRect;
  }

  scrollIntoView(): void {}

  focus(_options?: FocusOptions): void {
    Object.defineProperty(globalThis.document, 'activeElement', {
      configurable: true,
      value: this,
    });
  }

  setPointerCapture(pointerId: number): void {
    this.capturedPointers.add(pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.capturedPointers.has(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.capturedPointers.delete(pointerId);
  }

  pause(): void {}

  play(): Promise<void> {
    return Promise.resolve();
  }
}

function findViewElement(
  root: ViewElement,
  matches: (element: ViewElement) => boolean
): ViewElement | undefined {
  if (matches(root)) return root;
  for (const child of root.children) {
    const found = findViewElement(child, matches);
    if (found) return found;
  }
  return undefined;
}

function timelineGeometry(root: ViewElement) {
  const stage = new ViewElement('main');
  stage.className = 'stage-wrap';
  stage.layout = new DOMRect(20, 40, 430, 580);
  stage.clientWidth = 430;
  stage.clientHeight = 580;
  stage.append(root);
  const scroll = root.querySelector('.otio-timeline-scroll');
  const row = findViewElement(
    root,
    (node) =>
      node.matches('.otio-track-row') &&
      node.dataset['trackId'] === 'outer-track'
  );
  const rail = row?.querySelector('.otio-track-rail');
  const label = row?.querySelector('.otio-track-label');
  const band = row?.querySelector('.otio-comment-band');
  if (!scroll || !rail || !label || !band)
    throw new Error('expected timeline geometry targets');
  scroll.layout = new DOMRect(10, 400, 500, 240);
  scroll.clientLeft = 2;
  scroll.clientTop = 2;
  scroll.clientWidth = 480;
  scroll.clientHeight = 220;
  label.layout = new DOMRect(12, 402, 178, 54);
  return { stage, scroll, rail, band };
}

class ViewCanvas extends ViewElement {
  private readonly context = {
    fillStyle: '#000000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    clearRect: (): void => {},
    fillRect: (): void => {},
    drawImage: (): void => {},
  };

  constructor() {
    super('canvas');
  }

  getContext(kind: string): CanvasRenderingContext2D | null {
    return kind === '2d'
      ? (this.context as unknown as CanvasRenderingContext2D)
      : null;
  }
}

function installProjectionDom(): () => void {
  const globals = [
    'document',
    'window',
    'MutationObserver',
    'ResizeObserver',
    'DOMRect',
    'Element',
  ] as const;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of globals) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  const body = new ViewElement('body');
  const documentStub = {
    body,
    createElement: (tag: string): ViewElement =>
      tag === 'canvas' ? new ViewCanvas() : new ViewElement(tag),
    createElementNS: (_namespace: string, tag: string): ViewElement =>
      new ViewElement(tag),
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: documentStub,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: Object.assign(new EventTarget(), {
      innerWidth: 1440,
      innerHeight: 900,
      matchMedia: () => ({ matches: false }),
    }),
  });
  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true,
    writable: true,
    value: undefined,
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: undefined,
  });
  Object.defineProperty(globalThis, 'Element', {
    configurable: true,
    writable: true,
    value: ViewElement,
  });
  Object.defineProperty(globalThis, 'DOMRect', {
    configurable: true,
    writable: true,
    value: class {
      readonly left: number;
      readonly top: number;
      readonly right: number;
      readonly bottom: number;
      constructor(
        left: number,
        top: number,
        readonly width: number,
        readonly height: number
      ) {
        this.left = left;
        this.top = top;
        this.right = left + width;
        this.bottom = top + height;
      }
    },
  });

  const createObjectUrl = Object.getOwnPropertyDescriptor(
    URL,
    'createObjectURL'
  );
  const revokeObjectUrl = Object.getOwnPropertyDescriptor(
    URL,
    'revokeObjectURL'
  );
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (): string => 'blob:otio-view-test',
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (): void => {},
  });

  return () => {
    for (const name of globals) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    if (createObjectUrl)
      Object.defineProperty(URL, 'createObjectURL', createObjectUrl);
    else Reflect.deleteProperty(URL, 'createObjectURL');
    if (revokeObjectUrl)
      Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrl);
    else Reflect.deleteProperty(URL, 'revokeObjectURL');
  };
}
describe('OTIO archive projection reader', () => {
  test('keeps JSON identities while indexing every bundled media digest', async () => {
    const content = projectionContent();
    const projected = await readOtioForProjection(
      otioz(content, [
        {
          name: 'media/clip.mp4',
          bytes: new Uint8Array([1, 2, 3, 4]),
        },
      ])
    );
    const raw = readOtioDocument(content);

    expect(projected.timeline_ids).toEqual(raw.timeline_ids);
    expect(Object.keys(projected.nodes).sort()).toEqual(
      Object.keys(raw.nodes).sort()
    );
    expect(Object.keys(projected.media)).toEqual(['media/clip.mp4']);
    for (const entry of Object.values(projected.media)) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  describe('mounted projection', () => {
    let restoreDom: (() => void) | undefined;

    beforeEach(() => {
      restoreDom = installProjectionDom();
    });

    afterEach(() => {
      restoreDom?.();
      restoreDom = undefined;
    });

    test('reads hashed original and current revisions through the controller', async () => {
      const content = projectionContent();
      const current = otioz(content, [
        {
          name: 'media/clip.mp4',
          bytes: new Uint8Array([1, 2, 3, 4]),
        },
      ]);
      const original = otioz(content, [
        {
          name: 'media/clip.mp4',
          bytes: new Uint8Array([1, 2, 3, 4]),
        },
      ]);
      const changed = otioz(content, [
        {
          name: 'media/clip.mp4',
          bytes: new Uint8Array([1, 2, 3, 5]),
        },
      ]);
      const browserDocument = readOtioDocument(content);
      const timelineId = browserDocument.timeline_ids[0];
      if (!timelineId) throw new Error('expected projection timeline');
      const browserAnchor = createOtioSelection(
        browserDocument,
        timelineId,
        'projection-track',
        1,
        range(0, 12)
      );
      const root = new ViewElement('div');

      await mountOtioView(root as unknown as HTMLElement, {
        content: current,
        revision: 3,
      });
      const controller = otioControllerFor(root as unknown as HTMLElement);
      if (!controller) throw new Error('expected OTIO controller');

      try {
        expect(
          (
            await controller.project(
              { ...browserAnchor, relic_version: 1 },
              original
            )
          ).status
        ).toBe('same');
        expect(
          (
            await controller.project(
              { ...browserAnchor, relic_version: 2 },
              changed
            )
          ).status
        ).toBe('changed');
      } finally {
        controller.dispose();
      }
    });

    test('mounts without reading unreferenced bundle media', async () => {
      const unused = new Uint8Array([8, 6, 7, 5]);
      const root = new ViewElement('div');

      await mountOtioView(root as unknown as HTMLElement, {
        content: otioz(structuralContent(), [
          {
            name: 'media/unused.mp4',
            bytes: unused,
            crc: crc32(unused) ^ 1,
          },
        ]),
        revision: 1,
      });
      const controller = otioControllerFor(root as unknown as HTMLElement);
      expect(controller).toBeDefined();
      controller?.dispose();
    });
    test('with base-media preview allowed and the deadline fired, the overlay shows the graphics message', async () => {
      const root = new ViewElement('div');

      let timerCallback: (() => void) | null = null;
      const origSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: (...args: unknown[]) => void) => {
        timerCallback = fn as () => void;
        return 999 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;

      const effectDoc = new TextEncoder().encode(
        JSON.stringify({
          OTIO_SCHEMA: 'Timeline.1',
          name: 'Unsupported effect timeline',
          tracks: {
            OTIO_SCHEMA: 'Stack.1',
            children: [
              {
                OTIO_SCHEMA: 'Track.1',
                kind: 'Video',
                metadata: { relic: { id: 'track_1' } },
                children: [
                  {
                    OTIO_SCHEMA: 'Clip.1',
                    metadata: { relic: { id: 'clip_1' } },
                    source_range: range(0, 24),
                    effects: [
                      {
                        schema: 'CustomEffect.1',
                        name: 'Glow',
                        enabled: true,
                      },
                    ],
                    media_reference: {
                      OTIO_SCHEMA: 'ImageSequenceReference.1',
                      missing_frame_policy: 'black',
                      available_range: null,
                    },
                  },
                ],
              },
            ],
          },
        })
      );

      try {
        await mountOtioView(root as unknown as HTMLElement, {
          content: otioz(effectDoc, []),
          revision: 1,
        });

        const controller = otioControllerFor(root as unknown as HTMLElement);
        if (!controller) throw new Error('expected OTIO controller');

        // Allow base media preview via the button rendered when preview is blocked by effect
        const baseBtn = findViewElement(
          root,
          (el) => el.className === 'otio-preview-base'
        );
        expect(baseBtn).toBeDefined();
        baseBtn?.dispatchEvent(new Event('click'));

        const canvas = findViewElement(root, (el) => el.tagName === 'canvas');
        if (!canvas) throw new Error('expected canvas element');

        // Trigger visible context lost
        const listeners = canvas.listeners.get('contextlost');
        if (listeners) {
          for (const l of Array.from(listeners)) l(new Event('contextlost'));
        }

        // Fire deadline timer
        const executeTimer = timerCallback as (() => void) | null;
        if (!executeTimer) throw new Error('deadline timer not scheduled');
        executeTimer();

        // The status overlay element
        const previewStatus = findViewElement(
          root,
          (el) => el.className === 'otio-preview-status'
        );
        expect(previewStatus).toBeDefined();
        expect(previewStatus?.hidden).toBe(false);

        const text =
          previewStatus?.children.map((c) => c.textContent).join(' ') ?? '';
        expect(text).toContain(
          'Preview graphics context was lost and the browser did not restore it. Reload the page to try again.'
        );

        controller.dispose();
      } finally {
        globalThis.setTimeout = origSetTimeout;
      }
    });

    test('authored node with id graphics-context-lost carrying unsupported effect is not forced blocking when base-media preview is allowed and graphics are fine', async () => {
      const root = new ViewElement('div');

      const authoredDoc = new TextEncoder().encode(
        JSON.stringify({
          OTIO_SCHEMA: 'Timeline.1',
          name: 'Authored node timeline',
          tracks: {
            OTIO_SCHEMA: 'Stack.1',
            children: [
              {
                OTIO_SCHEMA: 'Track.1',
                kind: 'Video',
                metadata: { relic: { id: 'track_1' } },
                children: [
                  {
                    OTIO_SCHEMA: 'Clip.1',
                    metadata: { relic: { id: 'graphics-context-lost' } },
                    source_range: range(0, 24),
                    effects: [
                      {
                        schema: 'CustomEffect.1',
                        name: 'Glow',
                        enabled: true,
                      },
                    ],
                    media_reference: {
                      OTIO_SCHEMA: 'ImageSequenceReference.1',
                      missing_frame_policy: 'black',
                      available_range: null,
                    },
                  },
                ],
              },
            ],
          },
        })
      );

      const { promise: readyPromise, resolve: onReady } =
        Promise.withResolvers<void>();
      root.addEventListener('relic:otio-ready', () => onReady());

      await mountOtioView(root as unknown as HTMLElement, {
        content: otioz(authoredDoc, []),
        revision: 1,
      });
      await readyPromise;

      const controller = otioControllerFor(root as unknown as HTMLElement);
      if (!controller) throw new Error('expected OTIO controller');

      try {
        const previewStatus = findViewElement(
          root,
          (el) => el.className === 'otio-preview-status'
        );
        expect(previewStatus).toBeDefined();

        // Click to allow base media preview
        const baseBtn = findViewElement(
          root,
          (el) => el.className === 'otio-preview-base'
        );
        expect(baseBtn).toBeDefined();
        baseBtn?.dispatchEvent(new Event('click'));

        // Overlay is hidden because graphics are fine and base media is allowed
        expect(previewStatus?.hidden).toBe(true);

        // Authored clip row exists and does not carry graphics error
        const clipItem = findViewElement(
          root,
          (el) => el.dataset['itemId'] === 'graphics-context-lost'
        );
        expect(clipItem).toBeDefined();
        expect(clipItem?.title).not.toContain(
          'Preview graphics context was lost'
        );
      } finally {
        controller.dispose();
      }
    });
    test('checks the original digest before reading corrupt current archive media', async () => {
      const expectedContent = projectionContent();
      const wrongOriginal = otioz(structuralContent(), []);
      const unused = new Uint8Array([8, 6, 7, 5]);
      const current = otioz(expectedContent, [
        {
          name: 'media/unused.mp4',
          bytes: unused,
          crc: crc32(unused) ^ 1,
        },
      ]);
      const browserDocument = readOtioDocument(expectedContent);
      const timelineId = browserDocument.timeline_ids[0];
      if (!timelineId) throw new Error('expected projection timeline');
      const browserAnchor = createOtioSelection(
        browserDocument,
        timelineId,
        'projection-track',
        1,
        range(0, 12)
      );
      const root = new ViewElement('div');

      await mountOtioView(root as unknown as HTMLElement, {
        content: current,
        revision: 3,
      });
      const controller = otioControllerFor(root as unknown as HTMLElement);
      if (!controller) throw new Error('expected OTIO controller');

      try {
        await expect(
          controller.project(
            { ...browserAnchor, relic_version: 1 },
            wrongOriginal
          )
        ).rejects.toThrow(
          'Original OTIO document digest differs from the encrypted anchor.'
        );
      } finally {
        controller.dispose();
      }
    });

    test('validates original anchor semantics before corrupt current media', async () => {
      const content = projectionContent();
      const original = otioz(content, [
        {
          name: 'media/clip.mp4',
          bytes: new Uint8Array([1, 2, 3, 4]),
        },
      ]);
      const unused = new Uint8Array([8, 6, 7, 5]);
      const current = otioz(content, [
        {
          name: 'media/unused.mp4',
          bytes: unused,
          crc: crc32(unused) ^ 1,
        },
      ]);
      const originalDocument = readOtioDocument(content);
      const timelineId = originalDocument.timeline_ids[0];
      if (!timelineId) throw new Error('expected projection timeline');
      const validAnchor = createOtioSelection(
        originalDocument,
        timelineId,
        'projection-track',
        1,
        range(0, 12)
      );
      const invalidAnchor = {
        ...validAnchor,
        track_id: 'projection-clip',
      };
      const root = new ViewElement('div');

      await mountOtioView(root as unknown as HTMLElement, {
        content: current,
        revision: 3,
      });
      const controller = otioControllerFor(root as unknown as HTMLElement);
      if (!controller) throw new Error('expected OTIO controller');

      try {
        const invalid = await controller.project(invalidAnchor, original);
        expect(invalid.status).toBe('changed');
        expect(invalid.diagnostics[0]?.code).toBe('invalid-timing');
        expect(Object.hasOwn(invalid, 'mapped_range')).toBe(false);

        const cached = await controller.project(invalidAnchor, original);
        expect(cached).toBe(invalid);
      } finally {
        controller.dispose();
      }
    });

    test('clears a stale anchor when a nested track rejects the selection', async () => {
      const root = new ViewElement('div');
      await mountOtioView(root as unknown as HTMLElement, {
        content: nestedSelectionContent(),
        revision: 1,
      });
      const controller = otioControllerFor(root as unknown as HTMLElement);
      const trackSelect = findViewElement(
        root,
        (element) => element.getAttribute('aria-label') === 'Comment track'
      );
      const comment = findViewElement(root, (element) =>
        element.className.split(/\s+/).includes('otio-comment-selection')
      );
      if (!controller || !trackSelect || !comment)
        throw new Error('expected nested selection controls');

      const emitted: OtioAnchorV1[] = [];
      root.addEventListener('relic:otio-aim', (event) => {
        emitted.push(
          (event as CustomEvent<{ readonly anchor: OtioAnchorV1 }>).detail
            .anchor
        );
      });

      try {
        trackSelect.value = 'outer-track';
        trackSelect.dispatchEvent(new Event('change'));
        comment.dispatchEvent(new Event('click'));
        expect(emitted).toHaveLength(1);
        expect(emitted[0]?.track_id).toBe('outer-track');

        trackSelect.value = 'nested-track';
        trackSelect.dispatchEvent(new Event('change'));
        comment.dispatchEvent(new Event('click'));
        expect(emitted).toHaveLength(1);

        trackSelect.value = 'outer-track';
        trackSelect.dispatchEvent(new Event('change'));
        comment.dispatchEvent(new Event('click'));
        expect(emitted).toHaveLength(2);
        expect(emitted[1]?.track_id).toBe('outer-track');
      } finally {
        controller.dispose();
      }
    });
    test('aim carries live measure without measureBounds', async () => {
      const root = new ViewElement('div');
      await mountOtioView(root as unknown as HTMLElement, {
        content: nestedSelectionContent(),
        revision: 1,
      });
      const controller = otioControllerFor(root as unknown as HTMLElement);
      const select = findViewElement(
        root,
        (node) => node.getAttribute('aria-label') === 'Comment track'
      );
      const trackMode = findViewElement(
        root,
        (node) => node.dataset['otioMode'] === 'track'
      );
      const comment = findViewElement(root, (node) =>
        node.className.split(/\s+/).includes('otio-comment-selection')
      );
      if (!controller || !select || !trackMode || !comment)
        throw new Error('expected native track composer controls');

      const emitted: Array<{
        readonly anchor: OtioAnchorV1;
        readonly measure?: () => DOMRect | undefined;
        readonly measureBounds?: unknown;
      }> = [];
      root.addEventListener('relic:otio-aim', (event) => {
        emitted.push((event as CustomEvent<(typeof emitted)[number]>).detail);
      });
      try {
        select.value = 'outer-track';
        select.dispatchEvent(new Event('change'));
        trackMode.dispatchEvent(new Event('click'));
        comment.dispatchEvent(new Event('click'));
        expect(emitted).toHaveLength(1);
        expect(emitted[0]?.anchor.track_id).toBe('outer-track');
        expect(emitted[0]?.measureBounds).toBeUndefined();
        const measured = emitted[0]?.measure?.();
        expect(measured).toBeDefined();
      } finally {
        controller.dispose();
      }
    });

    test('mobile Inspector retains review state and closes before composing', async () => {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: () => ({ matches: true }),
      });
      const root = new ViewElement('div');
      await mountOtioView(root as unknown as HTMLElement, {
        content: nestedSelectionContent(),
        revision: 1,
      });
      const controller = otioControllerFor(root as unknown as HTMLElement);
      if (!controller) throw new Error('expected controller');
      try {
        const { scroll } = timelineGeometry(root);
        const select = root.querySelector('.otio-track-select')!;
        select.value = 'outer-track';
        select.dispatchEvent(new Event('change'));
        const toggle = root.querySelector('.otio-inspector-toggle')!;
        const close = root.querySelector('.otio-inspector-close')!;
        const inspector = root.querySelector('.otio-inspector')!;
        const monitor = root.querySelector('.otio-monitor-row')!;
        const context = root.querySelector('.otio-context')!;
        const media = root.querySelector(
          '.otio-inspector-tab[data-tab="media"]'
        )!;
        const focused = (): ViewElement | null =>
          globalThis.document.activeElement as unknown as ViewElement | null;
        expect(close.parentElement).toBe(inspector);
        expect(inspector.children.indexOf(close)).toBeGreaterThan(
          inspector.children.indexOf(context)
        );
        toggle.dispatchEvent(new Event('click'));
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(monitor.dataset['inspectorOpen']).toBe('true');
        expect(focused()).toBe(
          root.querySelector('.otio-inspector-tab[data-tab="inspector"]')
        );
        media.dispatchEvent(new Event('click'));
        context.scrollTop = 37;
        scroll.scrollTop = 79;
        scroll.scrollLeft = 43;
        const frame = root.querySelector('.otio-seek')!.value;
        close.dispatchEvent(new Event('click'));
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(focused()).toBe(toggle);
        toggle.dispatchEvent(new Event('click'));
        expect(focused()).toBe(media);
        expect(media.getAttribute('aria-selected')).toBe('true');
        expect(context.scrollTop).toBe(37);
        inspector.dispatchEvent(
          Object.assign(new Event('keydown'), { key: 'Escape' })
        );
        expect(monitor.dataset['inspectorOpen']).toBe('false');
        expect(focused()).toBe(toggle);
        expect(scroll.scrollTop).toBe(79);
        expect(scroll.scrollLeft).toBe(43);
        expect(root.querySelector('.otio-seek')!.value).toBe(frame);
        const emitted: OtioAnchorV1[] = [];
        root.addEventListener('relic:otio-aim', (event) => {
          expect(monitor.dataset['inspectorOpen']).toBe('false');
          emitted.push(
            (event as CustomEvent<{ anchor: OtioAnchorV1 }>).detail.anchor
          );
        });
        toggle.dispatchEvent(new Event('click'));
        root
          .querySelector('.otio-comment-selection')!
          .dispatchEvent(new Event('click'));
        expect(emitted[0]).toEqual(
          createOtioSelection(
            controller.document,
            controller.document.timeline_ids[0]!,
            'outer-track',
            1,
            range(0, 1)
          )
        );
      } finally {
        controller.dispose();
      }
    });

    test('clips live selections and posted marks to timeline, stage and viewport', async () => {
      const root = new ViewElement('div');
      await mountOtioView(root as unknown as HTMLElement, {
        content: nestedSelectionContent(),
        revision: 1,
      });
      const controller = otioControllerFor(root as unknown as HTMLElement);
      if (!controller) throw new Error('expected controller');
      try {
        const { stage, scroll, rail, band } = timelineGeometry(root);
        const select = root.querySelector('.otio-track-select')!;
        select.value = 'outer-track';
        select.dispatchEvent(new Event('change'));
        const selection = rail.querySelector('.otio-selection')!;
        selection.layout = new DOMRect(180, 600, 300, 54);
        const mark = new ViewElement('button');
        mark.className = 'otio-comment-mark';
        mark.dataset['commentId'] = 'test-c1';
        mark.layout = selection.layout;
        band.append(mark);
        window.innerHeight = 610;
        for (const id of [undefined, 'test-c1']) {
          expect(controller.measure(id)).toMatchObject({
            left: 190,
            top: 600,
            width: 260,
            height: 10,
          });
        }
        window.innerHeight = 900;
        expect(controller.measure()).toMatchObject({ height: 20 });
        stage.clientHeight = 800;
        expect(controller.measure()).toMatchObject({ height: 22 });
        selection.layout = new DOMRect(250, 900, 20, 54);
        expect(controller.measure()).toMatchObject({ top: 622, height: 0 });
        selection.layout = new DOMRect(80, 350, 20, 14);
        expect(controller.measure()).toMatchObject({
          left: 190,
          top: 402,
          width: 0,
          height: 0,
        });
        scroll.dispatchEvent(new Event('scroll'));
        expect(scroll.scrollTop).toBe(0);
        expect(controller.measure('absent-id')).toBeUndefined();
      } finally {
        controller.dispose();
      }
    });

    test('Comment reveals a lower selection on both axes without scrolling its stage', async () => {
      const root = new ViewElement('div');
      await mountOtioView(root as unknown as HTMLElement, {
        content: nestedSelectionContent(),
        revision: 1,
      });
      const controller = otioControllerFor(root as unknown as HTMLElement);
      if (!controller) throw new Error('expected controller');
      try {
        const { stage, scroll, rail } = timelineGeometry(root);
        stage.scrollTop = 13;
        stage.scrollLeft = 7;
        const select = root.querySelector('.otio-track-select')!;
        select.value = 'outer-track';
        select.dispatchEvent(new Event('change'));
        scroll.scrollLeft = 43;
        scroll.scrollTop = 79;
        rail.dispatchEvent(
          Object.assign(new Event('keydown'), {
            key: 'ArrowRight',
            shiftKey: false,
          })
        );
        expect(scroll.scrollLeft).toBe(43);
        expect(scroll.scrollTop).toBe(79);
        const selection = rail.querySelector('.otio-selection')!;
        selection.getBoundingClientRect = () =>
          new DOMRect(600 - scroll.scrollLeft, 900 - scroll.scrollTop, 20, 54);
        const emitted: OtioAnchorV1[] = [];
        root.addEventListener('relic:otio-aim', (event) => {
          emitted.push(
            (event as CustomEvent<{ anchor: OtioAnchorV1 }>).detail.anchor
          );
        });
        root
          .querySelector('.otio-comment-selection')!
          .dispatchEvent(new Event('click'));
        expect(scroll.scrollLeft).toBe(186);
        expect(scroll.scrollTop).toBe(334);
        expect(controller.measure()).toMatchObject({
          left: 414,
          top: 566,
          width: 20,
          height: 54,
        });
        expect(emitted[0]).toEqual(
          createOtioSelection(
            controller.document,
            controller.document.timeline_ids[0]!,
            'outer-track',
            1,
            range(1, 1)
          )
        );
        expect(stage.scrollLeft).toBe(7);
        expect(stage.scrollTop).toBe(13);
      } finally {
        controller.dispose();
      }
    });

    test('sidebar reveal scrolls the exact posted mark, not another comment or the document', async () => {
      const root = new ViewElement('div');
      await mountOtioView(root as unknown as HTMLElement, {
        content: nestedSelectionContent(),
        revision: 1,
      });
      const controller = otioControllerFor(root as unknown as HTMLElement);
      if (!controller) throw new Error('expected controller');
      try {
        const { stage, scroll } = timelineGeometry(root);
        const timelineId = controller.document.timeline_ids[0]!;
        const first = createOtioSelection(
          controller.document,
          timelineId,
          'outer-track',
          1,
          range(0, 0)
        );
        const second = createOtioSelection(
          controller.document,
          timelineId,
          'outer-track',
          1,
          range(12, 0)
        );
        expect(controller.paint(first, 'first')).toBe(true);
        expect(controller.paint(second, 'second')).toBe(true);
        const firstMark = root.querySelector(
          '.otio-comment-mark[data-comment-id="first"]'
        )!;
        const secondMark = root.querySelector(
          '.otio-comment-mark[data-comment-id="second"]'
        )!;
        firstMark.getBoundingClientRect = () =>
          new DOMRect(300 - scroll.scrollLeft, 450 - scroll.scrollTop, 5, 14);
        secondMark.getBoundingClientRect = () =>
          new DOMRect(600 - scroll.scrollLeft, 900 - scroll.scrollTop, 5, 14);
        expect(controller.measure('second')).toMatchObject({ height: 0 });
        expect(scroll.scrollTop).toBe(0);
        expect(scroll.scrollLeft).toBe(0);
        controller.reveal(second, 'second');
        expect(scroll.scrollTop).toBe(294);
        expect(controller.measure('second')).toMatchObject({
          top: 606,
          height: 14,
          width: 5,
        });
        expect(root.querySelector('.otio-selection')?.dataset['start']).toBe(
          '12'
        );
        controller.reveal(first, 'first');
        expect(scroll.scrollTop).toBe(48);
        expect(controller.measure('first')).toMatchObject({
          top: 402,
          height: 14,
          width: 5,
        });
        expect(root.querySelector('.otio-selection')?.dataset['start']).toBe(
          '0'
        );
        expect(stage.scrollTop).toBe(0);
        expect(stage.scrollLeft).toBe(0);
      } finally {
        controller.dispose();
      }
    });
  });
});

describe('OTIO track selection contract', () => {
  test('two identically named tracks retain independent IDs and paths', () => {
    const duplicates = otioLanes(document, 'timeline').filter(
      (lane) => lane.node.name === 'Video 2'
    );
    expect(duplicates.map((lane) => lane.node.id)).toEqual([
      'video-first',
      'video-second',
    ]);
    expect(new Set(duplicates.map((lane) => lane.node.json_pointer)).size).toBe(
      2
    );
    expect(new Set(duplicates.map((lane) => lane.code)).size).toBe(2);
    expect(duplicates[1]?.node.enabled).toBe(false);
    const nested = otioLanes(document, 'timeline').find(
      (lane) => lane.node.id === 'plate-track'
    );
    expect(nested?.depth).toBe(1);
    expect(nested?.path).toContain('VFX Submaster Stack');
  });

  test('a point has zero duration and binds the second duplicate track', () => {
    expect(anchor.kind).toBe('otio');
    expect(anchor.relic_version).toBe(1);
    expect(anchor.document_sha256).toBe(document.document_sha256);
    expect(anchor.track_id).toBe('video-second');
    expect(anchor.range).toEqual(range(12, 0));
    expect(anchor.snapshot.track).toBe('Video 2');
    expect(otioTargetLabel(anchor)).toContain('point 12 @ 24');
    expect(otioTargetLabel(anchor)).toContain('Picture-in-Picture Alpha');
    expect(
      otioTargetLabel({
        ...anchor,
        snapshot: { ...anchor.snapshot, item: null },
      })
    ).toContain('overlay');
  });

  test('a one-frame range stays one frame; mixed rational coordinates stay exact', () => {
    expect(
      createOtioSelection(document, 'timeline', 'video-second', 1, range(12, 1))
        .range
    ).toEqual(range(12, 1));
    const mixed = {
      start_time: { value: 1001, rate: 30000 },
      duration: { value: 1, rate: 30000 / 1001 },
    };
    expect(
      createOtioSelection(document, 'timeline', null, 1, mixed).range
    ).toEqual(mixed);
  });

  test('rejects an out-of-scope nested selection before valid recovery', () => {
    expect(() =>
      createOtioSelection(document, 'timeline', 'plate-track', 1, range(47, 1))
    ).toThrow('Selection unavailable.');
    expect(() =>
      createOtioSelection(document, 'timeline', 'plate-track', 1, range(72, 0))
    ).toThrow('Selection unavailable.');

    const recovered = createOtioSelection(
      document,
      'timeline',
      'plate-track',
      1,
      range(48, 24)
    );
    expect(recovered.track_id).toBe('plate-track');
    expect(recovered.range).toEqual(range(48, 24));
  });

  test('a range across clips retains the range without claiming one item', () => {
    const multi = createOtioSelection(
      document,
      'timeline',
      'video-first',
      1,
      range(12, 24)
    );
    expect(multi.range).toEqual(range(12, 24));
    expect(multi.item_id).toBeUndefined();
  });

  test('explicit identity retains transitions, gaps, compounds and exact source coordinates', () => {
    const doc = readOtioDocument(focusedSelectionContent());
    const transition = doc.nodes['focused-transition']!;
    const focused = createOtioSelection(
      doc,
      'focused-timeline',
      'focused-video',
      2,
      transition.timeline_range!,
      transition.id
    );
    expect(focused.item_id).toBe('focused-transition');
    expect(focused.snapshot.item).toBe('SMPTE_Dissolve_1');
    const gap = createOtioSelection(
      doc,
      'focused-timeline',
      'focused-video',
      2,
      doc.nodes['focused-gap']!.timeline_range!,
      'focused-gap'
    );
    expect(gap.item_id).toBe('focused-gap');
    const compound = Object.values(document.nodes).find(
      (node) => node.name === 'VFX Submaster Stack'
    )!;
    expect(
      createOtioSelection(
        document,
        'timeline',
        'video-first',
        1,
        compound.timeline_range!,
        compound.id
      ).item_id
    ).toBe(compound.id);
    const exact = {
      start_time: { value: 1001, rate: 30000 },
      duration: { value: 1, rate: 30000 / 1001 },
    };
    expect(
      createOtioSelection(
        document,
        'timeline',
        'video-first',
        1,
        exact,
        'primary'
      ).range
    ).toEqual(exact);
  });

  test('explicit null suppresses inference and invalid explicit targets are rejected', () => {
    const track = createOtioSelection(
      document,
      'timeline',
      'video-first',
      1,
      range(0, 12),
      null
    );
    expect(track.item_id).toBeUndefined();
    expect(track.snapshot.item).toBeNull();
    for (const id of ['missing', 'overlay', 'secondary'])
      expect(() =>
        createOtioSelection(
          document,
          'timeline',
          'video-first',
          1,
          range(0, 12),
          id
        )
      ).toThrow('Selection unavailable.');
  });

  test('whole-track selection uses exposed core windows rather than the composition duration', () => {
    expect(otioScopeRange(document, 'timeline', 'plate-track')).toEqual(
      range(48, 24)
    );
    expect(otioScopeRange(document, 'timeline', 'video-second')).toEqual(
      range(0, 24)
    );
    expect(otioScopeRange(document, 'timeline', null)).toEqual(range(0, 72));
    expect(
      otioScopeRange(document, 'timeline', 'missing-track')
    ).toBeUndefined();
    expect(
      otioScopeRange(document, 'another-timeline', 'plate-track')
    ).toBeUndefined();
  });

  test('global start affects the displayed timecode only', () => {
    expect(
      formatOtioTime({ value: 36, rate: 24 }, { value: 86400, rate: 24 })
    ).toBe('01:00:01:12');
    expect(anchor.range.start_time.value).toBe(12);
  });
});

describe('OTIO revision-bound mark placement', () => {
  test('same revision still requires its encrypted document digest and timeline', () => {
    expect(otioProjectionTarget(anchor, 1, document, 'timeline')?.track).toBe(
      'video-second'
    );
    expect(
      otioProjectionTarget(
        { ...anchor, document_sha256: '0'.repeat(64) },
        1,
        document,
        'timeline'
      )
    ).toBeUndefined();
    expect(
      otioProjectionTarget(anchor, 1, document, 'another-timeline')
    ).toBeUndefined();
  });

  test('earlier feedback gets no guessed coordinates without a projection', () => {
    expect(
      otioProjectionTarget(anchor, 2, document, 'timeline')
    ).toBeUndefined();
    for (const status of ['ambiguous', 'changed', 'missing'] as const) {
      expect(
        otioProjectionTarget(
          anchor,
          2,
          document,
          'timeline',
          resolution(status)
        )
      ).toBeUndefined();
    }
  });

  test('safe and partial mappings use separate current ranges and leave the original immutable', () => {
    for (const status of ['mapped', 'partial', 'same'] as const) {
      expect(
        otioProjectionTarget(
          anchor,
          2,
          document,
          'timeline',
          resolution(status)
        )?.ranges
      ).toEqual([range(24, 12)]);
    }
    expect(anchor.range).toEqual(range(12, 0));
    expect(anchor.relic_version).toBe(1);
  });

  test('disjoint current pieces are retained without filling their gap', () => {
    const pieces = [range(24, 12), range(60, 6)];
    const projected = { ...resolution('partial'), mapped_ranges: pieces };
    delete projected.mapped_range;
    const target = otioProjectionTarget(
      anchor,
      2,
      document,
      'timeline',
      projected
    );
    expect(target?.ranges).toBe(pieces);
    expect(target?.track).toBe('video-second');
    expect(anchor.range).toEqual(range(12, 0));
  });

  test('an explicitly empty projection never falls back to the old contiguous range', () => {
    const projected = { ...resolution('partial'), mapped_ranges: [] };
    expect(
      otioProjectionTarget(anchor, 2, document, 'timeline', projected)
    ).toBeUndefined();
  });

  test('legacy contiguous output is used only when mapped_ranges is omitted', () => {
    const projected = { ...resolution('mapped') };
    delete projected.mapped_ranges;
    expect(
      otioProjectionTarget(anchor, 2, document, 'timeline', projected)?.ranges
    ).toEqual([range(24, 12)]);
  });

  test('placement requires the core mapped timeline identity, including composition projections', () => {
    const missingTimeline = { ...resolution('mapped') };
    delete missingTimeline.mapped_timeline_id;
    expect(
      otioProjectionTarget(anchor, 2, document, 'timeline', missingTimeline)
    ).toBeUndefined();
    const wrongTimeline = {
      ...resolution('mapped'),
      mapped_timeline_id: 'another-timeline',
    };
    expect(
      otioProjectionTarget(anchor, 2, document, 'timeline', wrongTimeline)
    ).toBeUndefined();
    const composition = { ...resolution('mapped'), mapped_track_id: null };
    expect(
      otioProjectionTarget(anchor, 2, document, 'timeline', composition)?.track
    ).toBeNull();
  });
});

describe('OTIO eager-shell bridge', () => {
  test('an unrelated content surface does not require DOM query methods', () => {
    expect(
      otioControllerFor({ tagName: 'VIDEO' } as HTMLElement)
    ).toBeUndefined();
    expect(
      otioAdapter.supports({
        host: {} as HTMLElement,
        content: {} as HTMLElement,
      })
    ).toBe(false);
  });
});

describe('OTIO focused element activation', () => {
  let restoreDom: () => void;
  let root: ViewElement;
  let controller: OtioUiController;
  let aims: Array<{ readonly anchor: OtioAnchorV1; readonly focus: boolean }>;

  beforeEach(async () => {
    restoreDom = installProjectionDom();
    root = new ViewElement('div');
    await mountOtioView(root as unknown as HTMLElement, {
      content: focusedSelectionContent(),
      revision: 2,
    });
    controller = otioControllerFor(root as unknown as HTMLElement)!;
    aims = [];
    root.addEventListener('relic:otio-aim', (event) => {
      aims.push((event as CustomEvent<(typeof aims)[number]>).detail);
    });
  });
  afterEach(() => {
    controller.dispose();
    restoreDom();
  });

  function item(id: string): ViewElement {
    const control = findViewElement(
      root,
      (node) => node.matches('.otio-item') && node.dataset['itemId'] === id
    );
    if (!control) throw new Error(`Expected item ${id}`);
    return control;
  }
  function pointer(type: string, x: number): Event {
    return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      button: 0,
      clientX: x,
      clientY: 10,
      pointerId: 7,
    });
  }

  function settleFocusRendering(): Promise<void> {
    const completion = Promise.withResolvers<void>();
    setImmediate(completion.resolve);
    return completion.promise;
  }

  test('click and keyboard button activation use explicit editorial identity without composer focus', () => {
    const first = item('focused-a');
    first.focus();
    first.dispatchEvent(Object.assign(new Event('click'), { detail: 0 }));
    expect(aims).toHaveLength(1);
    expect(aims[0]?.focus).toBe(false);
    expect(aims[0]?.anchor.item_id).toBe('focused-a');
    expect(aims[0]?.anchor.range).toEqual(
      controller.document.nodes['focused-a']!.timeline_range!
    );
    expect(aims[0]?.anchor.range.duration.value).toBe(24);
    expect(first.getAttribute('aria-pressed')).toBe('true');
    expect(globalThis.document.activeElement as unknown).toBe(first);
    expect(root.dataset['scopeNodeId']).toBe('focused-a');
    expect(root.querySelector('.otio-focus-title')?.textContent).toContain(
      'Primary Grade A'
    );
    expect(
      findViewElement(root, (node) => node.tagName === 'h3')?.textContent
    ).toBe('Primary Grade A');
    root
      .querySelector('.otio-comment-selection')!
      .dispatchEvent(new Event('click'));
    expect(aims.at(-1)?.focus).toBe(true);
    const second = item('focused-b');
    second.dispatchEvent(Object.assign(new Event('click'), { detail: 0 }));
    expect(first.getAttribute('aria-pressed')).toBe('false');
    expect(second.getAttribute('aria-pressed')).toBe('true');
    expect(aims.at(-1)?.anchor.item_id).toBe('focused-b');
    expect(otioTargetLabel(aims.at(-1)!.anchor)).toContain('Secondary Grade B');
  });

  test('pointer click waits for release and a drag from the item keeps the rail range', () => {
    const first = item('focused-a');
    const rail = first.parentElement!;
    rail.layout = new DOMRect(100, 0, 480, 54);
    first.dispatchEvent(pointer('pointerdown', 160));
    expect(aims).toHaveLength(0);
    rail.dispatchEvent(pointer('pointerup', 160));
    expect(aims).toHaveLength(1);
    expect(aims[0]?.anchor.item_id).toBe('focused-a');
    first.dispatchEvent(pointer('pointerdown', 160));
    rail.dispatchEvent(pointer('pointermove', 280));
    rail.dispatchEvent(pointer('pointerup', 280));
    first.dispatchEvent(Object.assign(new Event('click'), { detail: 1 }));
    expect(aims).toHaveLength(2);
    expect(aims[1]?.anchor.range).toEqual(range(12, 24));
    expect(aims[1]?.anchor.item_id).toBeUndefined();
    expect(root.dataset['scopeNodeId']).toBe('');
    expect(rail.hasPointerCapture(7)).toBe(false);
  });

  test('cancelling a captured drag restores the prior target and prevents activation', () => {
    const first = item('focused-a');
    first.dispatchEvent(new Event('click'));
    const before = aims[0]!.anchor;
    const rail = first.parentElement!;
    rail.layout = new DOMRect(100, 0, 480, 54);
    first.dispatchEvent(pointer('pointerdown', 160));
    rail.dispatchEvent(pointer('pointermove', 280));
    rail.dispatchEvent(pointer('pointercancel', 280));
    first.dispatchEvent(Object.assign(new Event('click'), { detail: 1 }));
    expect(aims).toHaveLength(1);
    expect(root.dataset['scopeNodeId']).toBe('focused-a');
    expect(rail.listeners.get('pointermove')?.size).toBe(0);
    root
      .querySelector('.otio-comment-selection')!
      .dispatchEvent(new Event('click'));
    expect(aims.at(-1)?.anchor).toEqual(before);
  });

  test('point and range adjustments retain the focused item while back restores composition', () => {
    item('focused-b').dispatchEvent(new Event('click'));
    const point = findViewElement(
      root,
      (node) => node.dataset['otioMode'] === 'point'
    )!;
    point.dispatchEvent(new Event('click'));
    const input = root.querySelector('.otio-selection-in')!;
    input.value = '30';
    input.dispatchEvent(new Event('change'));
    expect(aims.at(-1)?.anchor.item_id).toBe('focused-b');
    expect(aims.at(-1)?.anchor.range).toEqual(range(30, 0));
    expect(root.querySelector('.otio-seek')?.min).toBe('24');
    expect(root.querySelector('.otio-seek')?.max).toBe('47');
    root
      .querySelector('.otio-back-composition')!
      .dispatchEvent(new Event('click'));
    expect(root.dataset['scopeNodeId']).toBe('');
    expect(root.querySelector('.otio-focus-context')?.hidden).toBe(true);
    expect(root.querySelector('.otio-selection')).toBeNull();
    expect(root.querySelector('.otio-selection-label')?.textContent).toBe(
      'Composition'
    );
  });

  test('markers use owner scope and retain zero duration', () => {
    const mark = findViewElement(
      root,
      (node) =>
        node.matches('.otio-timeline-marker') &&
        node.dataset['ownerId'] === 'focused-a'
    )!;
    mark.dispatchEvent(new Event('click'));
    expect(root.dataset['scopeNodeId']).toBe('focused-a');
    expect(aims.at(-1)?.anchor.item_id).toBe('focused-a');
    expect(aims.at(-1)?.anchor.range).toEqual(range(6, 0));
  });

  test('transitions, audio, disabled items and gaps keep their own identities', () => {
    for (const id of [
      'focused-transition',
      'focused-dialogue',
      'focused-disabled',
      'focused-gap',
    ]) {
      item(id).dispatchEvent(new Event('click'));
      expect(root.dataset['scopeNodeId']).toBe(id);
      expect(aims.at(-1)?.anchor.item_id).toBe(id);
      expect(aims.at(-1)?.anchor.track_id).toBe(
        id === 'focused-dialogue' ? 'focused-audio' : 'focused-video'
      );
    }
    expect(root.querySelector('.otio-focus-status')?.textContent).toContain(
      'No media'
    );
  });

  test('unplaced items remain inspectable and refuse anchoring and playback', () => {
    item('focused-unplaced').dispatchEvent(new Event('click'));
    expect(aims).toHaveLength(0);
    expect(root.dataset['scopeAvailable']).toBe('false');
    expect(root.querySelector('.otio-comment-selection')?.disabled).toBe(true);
    expect(root.querySelector('.otio-play')?.disabled).toBe(true);
    expect(root.querySelector('.otio-focus-status')?.textContent).toContain(
      'Selection unavailable'
    );
  });

  test('painting comments leaves playback alone; reveal restores item scope and prior revisions remain read-only', async () => {
    const doc = controller.document;
    const anchor = createOtioSelection(
      doc,
      'focused-timeline',
      'focused-video',
      2,
      range(6, 0),
      'focused-a'
    );
    item('focused-b').dispatchEvent(new Event('click'));
    expect(controller.paint(anchor, 'focused-comment')).toBe(true);
    expect(root.dataset['scopeNodeId']).toBe('focused-b');
    controller.reveal(anchor, 'focused-comment');
    expect(root.dataset['scopeNodeId']).toBe('focused-a');
    const earlier = { ...anchor, relic_version: 1 };
    await controller.project(earlier, focusedSelectionContent());
    controller.reveal(earlier);
    expect(root.dataset['scopeNodeId']).toBe('focused-a');
    expect(root.querySelector('.otio-comment-selection')?.disabled).toBe(true);
    expect(root.querySelector('.otio-selection-in')?.disabled).toBe(true);
  });

  test('review regression: a saved item anchor in transition handles reveals its exact frame', async () => {
    const anchor = createOtioSelection(
      controller.document,
      'focused-timeline',
      'focused-video',
      2,
      range(26, 0),
      'focused-a'
    );
    controller.reveal(anchor);
    await settleFocusRendering();
    expect(root.dataset['frame']).toBe('26');
    expect(root.querySelector('.otio-seek')?.max).toBe('29');
    expect(aims).toHaveLength(0);
    expect(root.querySelector('.otio-selection')?.dataset['start']).toBe('26');
    expect(anchor.range).toEqual(range(26, 0));
  });

  test('review regression: pre-handles and ranges extending into post-handles stay exposed', async () => {
    for (const [id, selectedRange, start, end] of [
      ['focused-b', range(20, 0), '18', '47'],
      ['focused-a', range(22, 6), '0', '29'],
    ] as const) {
      const anchor = createOtioSelection(
        controller.document,
        'focused-timeline',
        'focused-video',
        2,
        selectedRange,
        id
      );
      controller.reveal(anchor);
      await settleFocusRendering();
      expect(root.dataset['frame']).toBe(
        String(selectedRange.start_time.value)
      );
      expect(root.querySelector('.otio-seek')?.min).toBe(start);
      expect(root.querySelector('.otio-seek')?.max).toBe(end);
      expect(anchor.range).toEqual(selectedRange);
    }
  });

  test('review regression: a visible handle can be revealed after its editorial body is trimmed out', async () => {
    controller.dispose();
    root = new ViewElement('div');
    await mountOtioView(root as unknown as HTMLElement, {
      content: focusedSelectionContent(range(26, 4)),
      revision: 2,
    });
    controller = otioControllerFor(root as unknown as HTMLElement)!;
    expect(controller.document.nodes['focused-a']!.timeline_range).toBeNull();
    expect(
      controller.document.nodes['focused-a']!.visible_timeline_range
    ).toEqual(range(0, 4));
    item('focused-a').dispatchEvent(new Event('click'));
    expect(root.dataset['scopeAvailable']).toBe('false');
    const anchor = createOtioSelection(
      controller.document,
      'focused-timeline',
      'focused-video',
      2,
      range(0, 0),
      'focused-a'
    );
    controller.reveal(anchor);
    await settleFocusRendering();
    expect(root.dataset['scopeAvailable']).toBe('true');
    expect(root.querySelector('.otio-seek')?.max).toBe('3');
    expect(root.querySelector('.otio-comment-selection')?.disabled).toBe(false);
    expect(root.querySelector('.otio-selection-in')?.disabled).toBe(false);
  });

  test('review regression: a marker in transition handles keeps its exposed owner time', async () => {
    const mark = findViewElement(
      root,
      (node) =>
        node.matches('.otio-timeline-marker') &&
        node.title.startsWith('SMPTE_Dissolve_1')
    )!;
    mark.dispatchEvent(new Event('click'));
    await settleFocusRendering();
    expect(root.dataset['frame']).toBe('26');
    expect(aims.at(-1)?.anchor.range).toEqual(range(26, 0));
    expect(aims.at(-1)?.anchor.item_id).toBe('focused-a');
  });

  test('review regression: a newer manual seek wins over a pending focused reveal', async () => {
    const anchor = createOtioSelection(
      controller.document,
      'focused-timeline',
      'focused-video',
      2,
      range(6, 0),
      'focused-a'
    );
    controller.reveal(anchor);
    const seek = root.querySelector('.otio-seek')!;
    seek.value = '12';
    seek.dispatchEvent(new Event('input'));
    expect(root.dataset['frame']).toBe('12');
    await settleFocusRendering();
    expect(root.dataset['frame']).toBe('12');
    expect(seek.value).toBe('12');
    expect(root.dataset['scopeNodeId']).toBe('focused-a');
  });

  test('review regression: frame stepping invalidates a pending focused reveal seek', async () => {
    const anchor = createOtioSelection(
      controller.document,
      'focused-timeline',
      'focused-video',
      2,
      range(6, 0),
      'focused-a'
    );
    controller.reveal(anchor);
    root.querySelector('.otio-next-frame')!.dispatchEvent(new Event('click'));
    expect(root.dataset['frame']).toBe('1');
    await settleFocusRendering();
    expect(root.dataset['frame']).toBe('1');
  });

  test('disposing a captured gesture removes listeners and ignores stale activation', () => {
    const first = item('focused-a');
    const rail = first.parentElement!;
    first.dispatchEvent(pointer('pointerdown', 0));
    controller.dispose();
    expect(rail.listeners.get('pointerup')?.size).toBe(0);
    first.dispatchEvent(new Event('click'));
    expect(aims).toHaveLength(0);
  });
});

describe('OTIO media and timeline divider', () => {
  let restoreDom: () => void;
  let root: ViewElement;
  let controller: OtioUiController;
  let handle: ViewElement;
  let monitor: ViewElement;
  let scroll: ViewElement;
  let resizeObserver: {
    fire: () => void;
    disconnected: boolean;
    targets: Set<Element>;
  };
  let defaultTimelineHeight: number;

  beforeEach(async () => {
    restoreDom = installProjectionDom();
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class {
        disconnected = false;
        readonly targets = new Set<Element>();
        constructor(private readonly callback: () => void) {
          resizeObserver = this;
        }
        observe(target: Element): void {
          this.targets.add(target);
        }
        disconnect(): void {
          this.disconnected = true;
        }
        fire(): void {
          if (!this.disconnected) this.callback();
        }
      },
    });
    root = new ViewElement('div');
    defaultTimelineHeight = 180;
    await mountOtioView(root as unknown as HTMLElement, {
      content: focusedSelectionContent(),
      revision: 2,
    });
    controller = otioControllerFor(root as unknown as HTMLElement)!;
    handle = root.querySelector('.otio-resize-handle')!;
    monitor = root.querySelector('.otio-monitor-row')!;
    scroll = root.querySelector('.otio-timeline-scroll')!;
    root.querySelector('.otio-track-grid')!.layout = new DOMRect(
      0,
      0,
      1280,
      400
    );
    monitor.getBoundingClientRect = () =>
      new DOMRect(0, 0, root.clientWidth, availableHeight() - timelineHeight());
    scroll.getBoundingClientRect = () =>
      new DOMRect(
        0,
        root.clientHeight - timelineHeight() - 84,
        root.clientWidth,
        timelineHeight()
      );
    geometry(800);
  });
  afterEach(() => {
    controller.dispose();
    restoreDom();
  });

  function availableHeight(): number {
    return Math.max(
      0,
      root.clientHeight -
        handle.getBoundingClientRect().height -
        [
          '.otio-transport',
          '.otio-timeline-heading',
          '.otio-selection-readout',
          '.otio-diagnostics',
        ].reduce(
          (height, selector) =>
            height +
            root.querySelector(selector)!.getBoundingClientRect().height,
          0
        )
    );
  }
  function timelineHeight(): number {
    return scroll.style.height
      ? Number.parseFloat(scroll.style.height)
      : defaultTimelineHeight;
  }
  function geometry(height: number, width = 1280, short = false): void {
    root.clientHeight = height;
    root.clientWidth = width;
    root.layout = new DOMRect(0, 0, width, height);
    handle.layout = new DOMRect(0, 0, width, short ? 24 : 16);
    for (const [selector, rowHeight] of [
      ['.otio-transport', short ? 90 : 52],
      ['.otio-timeline-heading', short ? 72 : 48],
      ['.otio-selection-readout', short ? 66 : 68],
      ['.otio-diagnostics', 16],
    ] as const)
      root.querySelector(selector)!.layout = new DOMRect(
        0,
        0,
        width,
        rowHeight
      );
    resizeObserver.fire();
  }
  function pointer(
    type: string,
    y: number,
    options: {
      pointerId?: number;
      pointerType?: string;
      button?: number;
      isPrimary?: boolean;
    } = {}
  ): Event {
    return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      clientY: y,
      pointerId: 7,
      pointerType: 'mouse',
      button: 0,
      isPrimary: true,
      ...options,
    });
  }
  function key(name: string, shiftKey = false): Event {
    const event = Object.assign(
      new Event('keydown', { bubbles: true, cancelable: true }),
      { key: name, shiftKey }
    );
    handle.dispatchEvent(event);
    return event;
  }
  function drag(from: number, to: number): void {
    handle.dispatchEvent(pointer('pointerdown', from));
    handle.dispatchEvent(pointer('pointermove', to));
    handle.dispatchEvent(pointer('pointerup', to));
  }

  test('exposes the horizontal separator and keeps the content-sized default untouched', () => {
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
    expect(handle.getAttribute('aria-label')).toBe(
      'Resize media preview and timeline'
    );
    expect(handle.getAttribute('aria-controls')).toBe(monitor.id);
    expect(handle.getAttribute('aria-description')).toContain('Arrow up');
    expect(handle.getAttribute('aria-valuenow')).toBe('70');
    expect(handle.getAttribute('aria-valuetext')).toBe(
      'Media preview 70%; timeline 30%'
    );
    expect(handle.getAttribute('aria-disabled')).toBe('false');
    expect(root.children.slice(0, 3).map((node) => node.className)).toEqual([
      'otio-monitor-row',
      'otio-resize-handle',
      'otio-transport',
    ]);
    expect(scroll.style.height).toBe('');
    expect(root.classList.contains('is-resized')).toBe(false);
    geometry(1000);
    expect(scroll.style.height).toBe('');
    expect(handle.getAttribute('aria-valuenow')).toBe('78');
  });

  test('captures a drag, grows tracks upward and restores preview downward without scrolling or bubbling', () => {
    const escaped: string[] = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'click'])
      root.addEventListener(type, () => escaped.push(type));
    scroll.scrollTop = 47;
    scroll.scrollLeft = 112;
    const down = pointer('pointerdown', 400);
    handle.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(handle.hasPointerCapture(7)).toBe(true);
    expect(root.classList.contains('is-resizing')).toBe(true);
    handle.dispatchEvent(pointer('pointermove', 280));
    expect(timelineHeight()).toBe(300);
    expect(handle.getAttribute('aria-valuenow')).toBe('50');
    handle.dispatchEvent(pointer('pointerup', 280));
    handle.dispatchEvent(
      new Event('click', { bubbles: true, cancelable: true })
    );
    expect(handle.hasPointerCapture(7)).toBe(false);
    expect(root.classList.contains('is-resizing')).toBe(false);
    expect(root.classList.contains('is-resized')).toBe(true);
    expect(escaped).toEqual([]);
    expect(scroll.scrollTop).toBe(47);
    expect(scroll.scrollLeft).toBe(112);
    drag(400, 520);
    expect(timelineHeight()).toBe(180);
    expect(handle.getAttribute('aria-valuenow')).toBe('70');
  });

  test('clamps both panes and keeps the accessible value inside its stated limits', () => {
    drag(400, -1000);
    expect(timelineHeight()).toBeCloseTo(440, 10);
    expect(monitor.getBoundingClientRect().height).toBeCloseTo(160, 10);
    expect(handle.getAttribute('aria-valuenow')).toBe(
      handle.getAttribute('aria-valuemin')
    );
    drag(400, 2000);
    expect(timelineHeight()).toBe(96);
    expect(monitor.getBoundingClientRect().height).toBe(504);
    expect(handle.getAttribute('aria-valuenow')).toBe(
      handle.getAttribute('aria-valuemax')
    );
  });

  test('a content-sized timeline below the normal floor keeps arrow direction consistent', () => {
    defaultTimelineHeight = 52;
    root.querySelector('.otio-track-grid')!.layout = new DOMRect(
      0,
      0,
      1280,
      52
    );
    resizeObserver.fire();
    key('ArrowDown');
    expect(timelineHeight()).toBe(52);
    key('ArrowUp');
    expect(timelineHeight()).toBe(68);
    key('ArrowDown');
    expect(timelineHeight()).toBe(52);
    key('End');
    expect(timelineHeight()).toBe(52);
  });

  test('uses the same capture path for touch and ignores other buttons and fingers', () => {
    handle.dispatchEvent(pointer('pointerdown', 400, { button: 2 }));
    handle.dispatchEvent(
      pointer('pointerdown', 400, { pointerType: 'touch', isPrimary: false })
    );
    expect(handle.hasPointerCapture(7)).toBe(false);
    expect(scroll.style.height).toBe('');
    handle.dispatchEvent(
      pointer('pointerdown', 400, { pointerId: 11, pointerType: 'touch' })
    );
    handle.dispatchEvent(pointer('pointermove', 200, { pointerId: 12 }));
    handle.dispatchEvent(pointer('pointerup', 200, { pointerId: 12 }));
    expect(scroll.style.height).toBe('');
    expect(handle.hasPointerCapture(11)).toBe(true);
    handle.dispatchEvent(
      pointer('pointermove', 300, { pointerId: 11, pointerType: 'touch' })
    );
    handle.dispatchEvent(
      pointer('pointerup', 300, { pointerId: 11, pointerType: 'touch' })
    );
    expect(timelineHeight()).toBe(280);
    expect(handle.hasPointerCapture(11)).toBe(false);
  });

  test('a click leaves the default intact and a drag returning to its origin restores its size', () => {
    drag(400, 401);
    expect(scroll.style.height).toBe('');
    expect(root.classList.contains('is-resized')).toBe(false);
    handle.dispatchEvent(pointer('pointerdown', 400));
    handle.dispatchEvent(pointer('pointermove', 300));
    expect(timelineHeight()).toBe(280);
    handle.dispatchEvent(pointer('pointerup', 400));
    expect(timelineHeight()).toBe(180);
  });

  test('supports arrows, larger Shift steps and Home/End without moving keyboard focus or seeking', () => {
    const escaped: string[] = [];
    root.addEventListener('keydown', (event) =>
      escaped.push((event as KeyboardEvent).key)
    );
    handle.focus();
    const frame = root.dataset['frame'];
    expect(key('ArrowUp').defaultPrevented).toBe(true);
    expect(timelineHeight()).toBe(196);
    key('ArrowUp', true);
    expect(timelineHeight()).toBe(260);
    key('ArrowDown');
    expect(timelineHeight()).toBe(244);
    key('ArrowDown', true);
    expect(timelineHeight()).toBe(180);
    key('Home');
    expect(timelineHeight()).toBeCloseTo(440, 10);
    key('End');
    expect(timelineHeight()).toBe(96);
    expect(globalThis.document.activeElement as unknown).toBe(handle);
    expect(root.dataset['frame']).toBe(frame);
    expect(escaped).toEqual([]);
    expect(key('ArrowLeft').defaultPrevented).toBe(false);
    expect(escaped).toEqual(['ArrowLeft']);
    expect(timelineHeight()).toBe(96);
  });

  test('retains the chosen ratio across viewport and control-row changes while scaling short-screen limits', () => {
    drag(400, 280);
    geometry(1000);
    expect(availableHeight()).toBe(800);
    expect(timelineHeight()).toBe(400);
    expect(resizeObserver.targets.has(root as unknown as Element)).toBe(true);
    expect(resizeObserver.targets.has(monitor as unknown as Element)).toBe(
      true
    );
    expect(resizeObserver.targets.has(scroll as unknown as Element)).toBe(true);
    root.querySelector('.otio-transport')!.layout = new DOMRect(0, 0, 1280, 92);
    resizeObserver.fire();
    expect(availableHeight()).toBe(760);
    expect(timelineHeight()).toBe(380);
    geometry(420, 320, true);
    expect(availableHeight()).toBe(152);
    expect(timelineHeight()).toBe(76);
    key('Home');
    expect(timelineHeight()).toBeCloseTo(91.2);
    expect(monitor.getBoundingClientRect().height).toBeCloseTo(60.8);
    key('End');
    expect(timelineHeight()).toBe(38);
    expect(monitor.getBoundingClientRect().height).toBe(114);
  });

  test('temporary clamping on a short screen preserves the requested ratio when space returns', () => {
    key('Home');
    const fraction = timelineHeight() / availableHeight();
    geometry(420, 320, true);
    expect(timelineHeight()).toBeCloseTo(91.2);
    geometry(1000);
    expect(timelineHeight()).toBeCloseTo(800 * fraction);
    expect(timelineHeight()).toBeGreaterThan(440);
  });

  test('cancellation, capture loss and window blur restore the prior layout and remove gesture listeners', () => {
    handle.dispatchEvent(pointer('pointerdown', 400));
    handle.dispatchEvent(pointer('pointermove', 280));
    handle.dispatchEvent(pointer('pointercancel', 280, { pointerId: 8 }));
    expect(handle.hasPointerCapture(7)).toBe(true);
    handle.dispatchEvent(pointer('pointercancel', 280));
    expect(scroll.style.height).toBe('');
    expect(root.classList.contains('is-resized')).toBe(false);
    drag(400, 320);
    expect(timelineHeight()).toBe(260);
    for (const cancel of ['lostpointercapture', 'blur']) {
      handle.dispatchEvent(pointer('pointerdown', 400));
      handle.dispatchEvent(pointer('pointermove', 280));
      if (cancel === 'blur') window.dispatchEvent(new Event('blur'));
      else handle.dispatchEvent(pointer(cancel, 280));
      expect(timelineHeight()).toBe(260);
      expect(handle.hasPointerCapture(7)).toBe(false);
      for (const type of [
        'pointermove',
        'pointerup',
        'pointercancel',
        'lostpointercapture',
      ])
        expect(handle.listeners.get(type)?.size).toBe(0);
    }
  });

  test('keeps focused comment identity, selection, frame, draft and existing marks while notifying popover tracking', async () => {
    const anchor = createOtioSelection(
      controller.document,
      'focused-timeline',
      'focused-video',
      2,
      range(6, 0),
      'focused-a'
    );
    controller.paint(anchor, 'divider-comment');
    controller.reveal(anchor, 'divider-comment');
    const settled = Promise.withResolvers<void>();
    setImmediate(settled.resolve);
    await settled.promise;
    const mark = root.querySelector('.otio-comment-mark');
    const frame = root.dataset['frame'];
    const selection = root.querySelector('.otio-selection');
    const input = root.querySelector('.otio-selection-in')!.value;
    const draft = new ViewElement('textarea');
    draft.value = 'Keep this comment draft.';
    draft.focus();
    let aims = 0;
    let popoverTracks = 0;
    root.addEventListener('relic:otio-aim', () => aims++);
    root.addEventListener('scroll', () => popoverTracks++);
    drag(400, 280);
    expect(root.classList.contains('is-element-focused')).toBe(true);
    expect(root.dataset['scopeNodeId']).toBe('focused-a');
    expect(root.dataset['frame']).toBe(frame);
    expect(root.querySelector('.otio-selection')).toBe(selection);
    expect(root.querySelector('.otio-selection-in')!.value).toBe(input);
    expect(root.querySelector('.otio-comment-mark')).toBe(mark);
    expect(globalThis.document.activeElement as unknown).toBe(draft);
    expect(draft.value).toBe('Keep this comment draft.');
    expect(aims).toBe(0);
    expect(popoverTracks).toBeGreaterThan(0);
  });

  test('disables resizing when fixed controls consume the viewport and resumes when space returns', () => {
    geometry(180, 320, true);
    expect(availableHeight()).toBe(0);
    expect(handle.getAttribute('aria-disabled')).toBe('true');
    key('ArrowUp');
    drag(400, 300);
    expect(scroll.style.height).toBe('');
    expect(handle.hasPointerCapture(7)).toBe(false);
    geometry(800);
    expect(handle.getAttribute('aria-disabled')).toBe('false');
    key('ArrowUp');
    expect(timelineHeight()).toBe(196);
  });

  test('disposal releases active capture, disconnects observation and removes keyboard, pointer and window handlers', () => {
    handle.dispatchEvent(pointer('pointerdown', 400));
    handle.dispatchEvent(pointer('pointermove', 280));
    controller.dispose();
    expect(handle.hasPointerCapture(7)).toBe(false);
    expect(root.classList.contains('is-resizing')).toBe(false);
    expect(resizeObserver.disconnected).toBe(true);
    for (const type of [
      'pointerdown',
      'pointermove',
      'pointerup',
      'keydown',
      'click',
    ])
      expect(handle.listeners.get(type)?.size).toBe(0);
    const height = scroll.style.height;
    key('ArrowUp');
    drag(400, 200);
    root.clientHeight = 1000;
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('blur'));
    expect(scroll.style.height).toBe(height);
  });

  test('hides the divider when the OTIO is only a structural inspector', async () => {
    controller.dispose();
    root = new ViewElement('div');
    await mountOtioView(root as unknown as HTMLElement, {
      content: new TextEncoder().encode(
        JSON.stringify({
          OTIO_SCHEMA: 'SerializableCollection.1',
          name: 'Structural only',
          children: [],
        })
      ),
      revision: 2,
    });
    controller = otioControllerFor(root as unknown as HTMLElement)!;
    expect(controller.document.timeline_ids).toEqual([]);
    expect(root.dataset['ready']).toBe('structural');
    expect(root.querySelector('.otio-resize-handle')!.hidden).toBe(true);
  });

  test('keeps the divider for an empty timeline rather than treating it as a structural-only collection', async () => {
    controller.dispose();
    root = new ViewElement('div');
    await mountOtioView(root as unknown as HTMLElement, {
      content: structuralContent(),
      revision: 2,
    });
    controller = otioControllerFor(root as unknown as HTMLElement)!;
    expect(controller.document.timeline_ids).toHaveLength(1);
    expect(root.querySelector('.otio-resize-handle')!.hidden).toBe(false);
    expect(root.querySelector('.otio-transport')!.hidden).toBe(false);
  });
});
