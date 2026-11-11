/**
 * Tests for the page anchor adapter.
 *
 * Asserting that a mark for page 3 never paints onto page 1's canvas, that a
 * rect lands on the identical fraction of the page regardless of canvas scale,
 * and that activation reveals the correct page.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AnchorRect, CommentAnchor } from '@relic/format';
import { type AnchorSurface, boxFromUnit } from '../src/anchoring.ts';
import { pageAnchorAdapter } from '../src/annotate-page.ts';
import { preserveGlobalDescriptors } from './global-descriptors.ts';

class ElementStub {
  readonly tagName: string;
  className = '';
  textContent = '';
  scrollLeft = 0;
  scrollTop = 0;
  readonly children: ElementStub[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  private bounds: DOMRect = {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };

  readonly classList = {
    add: (name: string): void => {
      const parts = new Set(this.className.split(/\s+/).filter(Boolean));
      parts.add(name);
      this.className = [...parts].join(' ');
    },
    contains: (name: string): boolean => {
      const parts = this.className.split(/\s+/).filter(Boolean);
      return parts.includes(name);
    },
    toggle: (name: string, force?: boolean): boolean => {
      const parts = new Set(this.className.split(/\s+/).filter(Boolean));
      const shouldHave = force ?? !parts.has(name);
      if (shouldHave) parts.add(name);
      else parts.delete(name);
      this.className = [...parts].join(' ');
      return shouldHave;
    },
  };

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  setBounds(rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  }): void {
    this.bounds = {
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    };
  }

  getBoundingClientRect(): DOMRect {
    return this.bounds;
  }

  appendChild(child: ElementStub): ElementStub {
    this.children.push(child);
    return child;
  }

  scrollTo(_options: unknown): void {}

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatchEvent(event: unknown): boolean {
    const type = (event as { type: string }).type;
    const list = this.listeners.get(type) ?? [];
    for (const handler of list) handler(event);
    return true;
  }
}

let restoreGlobals: () => void;

function installDom(): void {
  restoreGlobals = preserveGlobalDescriptors('document', 'CustomEvent');
  (globalThis as { document?: unknown }).document = {
    createElement: (tag: string) => new ElementStub(tag),
    createElementNS: (_namespace: string, tag: string) => new ElementStub(tag),
  };
  Object.defineProperty(globalThis, 'CustomEvent', {
    configurable: true,
    writable: true,
    value: class CustomEvent extends Event {
      readonly detail: unknown;
      constructor(type: string, init?: CustomEventInit) {
        super(type, init);
        this.detail = init?.detail ?? null;
      }
    },
  });
}

function clearDom(): void {
  restoreGlobals();
}

function createMockSurface(
  canvasBox: { left: number; top: number; width: number; height: number },
  hostBox: { left: number; top: number; width: number; height: number } = {
    left: 0,
    top: 0,
    width: 1000,
    height: 1000,
  },
  pageNumber = 1
): AnchorSurface {
  const canvas = new ElementStub('canvas');
  canvas.classList.add('relic-page');
  canvas.dataset['pageNumber'] = String(pageNumber);
  canvas.setBounds(canvasBox);

  const host = new ElementStub('div');
  host.classList.add('stage-wrap');
  host.setBounds(hostBox);

  return {
    host: host as unknown as HTMLElement,
    content: canvas as unknown as HTMLElement,
  };
}

describe('pageAnchorAdapter', () => {
  beforeEach(installDom);
  afterEach(clearDom);

  describe('supports', () => {
    test('supports canvas.relic-page', () => {
      const surface = createMockSurface({
        left: 0,
        top: 0,
        width: 600,
        height: 800,
      });
      expect(pageAnchorAdapter.supports(surface)).toBe(true);
    });

    test('refuses canvas without relic-page class', () => {
      const canvas = new ElementStub('canvas');
      const host = new ElementStub('div');
      expect(
        pageAnchorAdapter.supports({
          host: host as unknown as HTMLElement,
          content: canvas as unknown as HTMLElement,
        })
      ).toBe(false);
    });

    test('refuses non-canvas elements', () => {
      const img = new ElementStub('img');
      img.classList.add('relic-image');
      const host = new ElementStub('div');
      expect(
        pageAnchorAdapter.supports({
          host: host as unknown as HTMLElement,
          content: img as unknown as HTMLElement,
        })
      ).toBe(false);
    });
  });

  describe('label', () => {
    test('formats bare page label', () => {
      const anchor: CommentAnchor = { kind: 'page', page: 4 };
      expect(pageAnchorAdapter.label(anchor)).toBe('Commenting on page 4');
    });

    test('formats page label with quote', () => {
      const anchor: CommentAnchor = {
        kind: 'page',
        page: 4,
        exact: 'Important findings',
      };
      expect(pageAnchorAdapter.label(anchor)).toBe(
        'Commenting on page 4: "Important findings"'
      );
    });
  });

  describe('page visibility gating', () => {
    test('a page anchor whose page is not visible does not paint a box on the wrong page', () => {
      // Current visible page is page 1
      const surface = createMockSurface(
        { left: 100, top: 50, width: 600, height: 800 },
        { left: 0, top: 0, width: 800, height: 1000 },
        1
      );
      const overlay = new ElementStub('div');

      // Anchor points to page 3 with a rect
      const anchorPage3: CommentAnchor = {
        kind: 'page',
        page: 3,
        rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
      };

      const placed = pageAnchorAdapter.paint(
        surface,
        overlay as unknown as HTMLElement,
        anchorPage3,
        'comment:c3'
      );
      expect(placed).toBe(false);
      expect(overlay.children).toHaveLength(0);
    });

    test('a page anchor whose page is visible paints the box on that page', () => {
      // Current visible page is page 3
      const surface = createMockSurface(
        { left: 100, top: 50, width: 600, height: 800 },
        { left: 0, top: 0, width: 800, height: 1000 },
        3
      );
      const overlay = new ElementStub('div');

      const anchorPage3: CommentAnchor = {
        kind: 'page',
        page: 3,
        rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
      };

      const placed = pageAnchorAdapter.paint(
        surface,
        overlay as unknown as HTMLElement,
        anchorPage3,
        'comment:c3'
      );
      expect(placed).toBe(true);
      expect(overlay.children).toHaveLength(1);

      const mark = overlay.children[0] as ElementStub;
      expect(mark.dataset['commentId']).toBe('comment:c3');
      expect(mark.classList.contains('mark-page')).toBe(true);
      expect(mark.classList.contains('mark-region')).toBe(true);

      // Coordinate verification
      // canvas at (100, 50), width 600, height 800.
      // rect x: 0.1 (60px), y: 0.2 (160px), w: 0.5 (300px), h: 0.3 (240px).
      // left: 100 + 60 = 160px, top: 50 + 160 = 210px.
      expect(mark.style['left']).toBe('160px');
      expect(mark.style['top']).toBe('210px');
      expect(mark.style['width']).toBe('300px');
      expect(mark.style['height']).toBe('240px');
    });
  });

  describe('resolution independence', () => {
    test('the same rect lands on the same fraction of the page at two canvas sizes', () => {
      const rect: AnchorRect = { x: 0.2, y: 0.25, w: 0.4, h: 0.5 };

      // Canvas size 1: 500x700
      const surface1 = createMockSurface(
        { left: 50, top: 20, width: 500, height: 700 },
        { left: 0, top: 0, width: 800, height: 1000 },
        1
      );
      const box1 = boxFromUnit(surface1, rect);
      expect(box1).toBeDefined();

      // Canvas size 2: 1000x1400 (e.g. 2x retina or larger viewport)
      const surface2 = createMockSurface(
        { left: 50, top: 20, width: 1000, height: 1400 },
        { left: 0, top: 0, width: 1200, height: 1600 },
        1
      );
      const box2 = boxFromUnit(surface2, rect);
      expect(box2).toBeDefined();
      if (box1 === undefined || box2 === undefined) {
        throw new Error('boxes must be defined');
      }

      // Both boxes must occupy the exact same fraction of the canvas content box
      const fractionW1 = box1.width / 500;
      const fractionW2 = box2.width / 1000;
      expect(fractionW1).toBeCloseTo(0.4, 5);
      expect(fractionW2).toBeCloseTo(0.4, 5);

      const fractionH1 = box1.height / 700;
      const fractionH2 = box2.height / 1400;
      expect(fractionH1).toBeCloseTo(0.5, 5);
      expect(fractionH2).toBeCloseTo(0.5, 5);

      // Relative offsets on the content box
      const relLeft1 = (box1.left - 50) / 500;
      const relLeft2 = (box2.left - 50) / 1000;
      expect(relLeft1).toBeCloseTo(0.2, 5);
      expect(relLeft2).toBeCloseTo(0.2, 5);

      const relTop1 = (box1.top - 20) / 700;
      const relTop2 = (box2.top - 20) / 1400;
      expect(relTop1).toBeCloseTo(0.25, 5);
      expect(relTop2).toBeCloseTo(0.25, 5);
    });
  });

  describe('reveal', () => {
    test('dispatches relic:turn-page when anchor page differs from visible page', () => {
      const surface = createMockSurface(
        { left: 0, top: 0, width: 600, height: 800 },
        { left: 0, top: 0, width: 1000, height: 1000 },
        1
      );

      let turnedToPage: number | undefined;
      surface.content.addEventListener('relic:turn-page', (event: unknown) => {
        const customEvent = event as { detail: { page: number } };
        turnedToPage = customEvent.detail.page;
      });

      const anchorPage5: CommentAnchor = { kind: 'page', page: 5 };
      pageAnchorAdapter.reveal?.(surface, anchorPage5);

      expect(turnedToPage).toBe(5);
    });

    test('does not dispatch relic:turn-page when already on that page', () => {
      const surface = createMockSurface(
        { left: 0, top: 0, width: 600, height: 800 },
        { left: 0, top: 0, width: 1000, height: 1000 },
        5
      );

      let turned = false;
      surface.content.addEventListener('relic:turn-page', () => {
        turned = true;
      });

      const anchorPage5: CommentAnchor = { kind: 'page', page: 5 };
      pageAnchorAdapter.reveal?.(surface, anchorPage5);

      expect(turned).toBe(false);
    });
  });
});
