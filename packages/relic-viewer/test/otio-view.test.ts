import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  crc32,
  type OtioAnchorResolution,
  type OtioAnchorV1,
  readOtioDocument,
} from '@relic/format';
import { otioAdapter, otioTargetLabel } from '../src/annotate-otio.ts';
import { otioControllerFor } from '../src/otio-bridge.ts';
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

class ViewElement {
  className = '';
  textContent = '';
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
  readonly attributes = new Map<string, string>();
  readonly style = {
    setProperty: (): void => {},
    position: '',
    width: '',
    height: '',
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
    Object.defineProperty(event, 'target', { configurable: true, value: this });
    for (const listener of this.listeners.get(event.type) ?? [])
      listener(event);
    return true;
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

  setPointerCapture(): void {}

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
    'DOMRect',
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
    value: {
      innerWidth: 1440,
      innerHeight: 900,
      matchMedia: () => ({ matches: false }),
      addEventListener: (): void => {},
      removeEventListener: (): void => {},
    },
  });
  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true,
    writable: true,
    value: undefined,
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
        Object.defineProperty(window, 'innerHeight', {
          configurable: true,
          value: 610,
        });
        for (const id of [undefined, 'test-c1']) {
          expect(controller.measure(id)).toMatchObject({
            left: 190,
            top: 600,
            width: 260,
            height: 10,
          });
        }
        Object.defineProperty(window, 'innerHeight', {
          configurable: true,
          value: 900,
        });
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
