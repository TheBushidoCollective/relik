/**
 * Where a panel lands, and what it offers when it gets there.
 *
 * The placement half is arithmetic and is asserted directly, because a panel
 * that sits over the sentence it is about, or off the clipped edge of the
 * stage, is the defect this module exists to prevent and a browser is a slow
 * way to find it. The look of the thing is proven in a browser, which is the
 * only place it can be.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  anchorFromClientRect,
  chooseTargetBox,
  OFFER_QUOTE_LIMIT,
  placeLeft,
  placePopover,
  POPOVER_GAP,
  POPOVER_MARGIN,
  popoverLayer,
  revealScrollTop,
  shortQuote,
} from '../src/popover.ts';
import { clearDom, installDom } from './annotate.test.ts';

const HOST = {
  scrollLeft: 0,
  scrollTop: 0,
  clientWidth: 800,
  clientHeight: 600,
};

const SIZE = { width: 320, height: 160 };

describe('placePopover test table (P1 to P7)', () => {
  test('P1: anchor {200,300,120,20}, prefer above', () => {
    const placed = placePopover(
      { left: 200, top: 300, width: 120, height: 20 },
      SIZE,
      HOST,
      8,
      8,
      'above'
    );
    expect(placed.side).toBe('above');
    expect(placed.top).toBe(132);
    expect(placed.left).toBe(100);
  });

  test('P2: P1 with prefer: below', () => {
    const placed = placePopover(
      { left: 200, top: 300, width: 120, height: 20 },
      SIZE,
      HOST,
      8,
      8,
      'below'
    );
    expect(placed.side).toBe('below');
    expect(placed.top).toBe(328);
    expect(placed.left).toBe(100);
  });

  test('P3: anchor {200,500,120,54}, prefer: below flips to above', () => {
    const placed = placePopover(
      { left: 200, top: 500, width: 120, height: 54 },
      SIZE,
      HOST,
      8,
      8,
      'below'
    );
    expect(placed.side).toBe('above');
    expect(placed.top).toBe(332);
  });

  test('P4: clientHeight 300, anchor {200,120,120,40} caps maxHeight 124, below, top 168', () => {
    const placed = placePopover(
      { left: 200, top: 120, width: 120, height: 40 },
      SIZE,
      { ...HOST, clientHeight: 300 },
      8,
      8,
      'above'
    );
    expect(placed.side).toBe('below');
    expect(placed.maxHeight).toBe(124);
    expect(placed.top).toBe(168);
  });

  test('P5: anchor {200,700,120,20} entirely below visible frame', () => {
    const placed = placePopover(
      { left: 200, top: 700, width: 120, height: 20 },
      SIZE,
      HOST,
      8,
      8,
      'above'
    );
    expect(placed.side).toBe('above');
    expect(placed.top).toBe(532);
  });

  test('P6: scrollTop 1000, anchor {200,900,120,20}, prefer: below', () => {
    const placed = placePopover(
      { left: 200, top: 900, width: 120, height: 20 },
      SIZE,
      { ...HOST, scrollTop: 1000 },
      8,
      8,
      'below'
    );
    expect(placed.side).toBe('below');
    expect(placed.top).toBe(928);
  });

  test('P7: panel {320,900}, anchor as P1 caps maxHeight 284, top 8', () => {
    const placed = placePopover(
      { left: 200, top: 300, width: 120, height: 20 },
      { width: 320, height: 900 },
      HOST,
      8,
      8,
      'above'
    );
    expect(placed.side).toBe('above');
    expect(placed.maxHeight).toBe(284);
    expect(placed.top).toBe(8);
  });
});

describe('revealScrollTop test table (R1 to R5)', () => {
  const host = {
    scrollLeft: 0,
    scrollTop: 0,
    clientWidth: 800,
    clientHeight: 600,
    scrollHeight: 2000,
  };
  const h = 160;

  test('R1: anchor top 300, height 20', () => {
    expect(
      revealScrollTop({ left: 200, top: 300, width: 120, height: 20 }, h, host)
    ).toBe(0);
  });

  test('R2: anchor top 900, height 54', () => {
    expect(
      revealScrollTop({ left: 200, top: 900, width: 120, height: 54 }, h, host)
    ).toBe(362);
  });

  test('R3: scrollTop 1000, anchor top 900, height 54', () => {
    expect(
      revealScrollTop({ left: 200, top: 900, width: 120, height: 54 }, h, {
        ...host,
        scrollTop: 1000,
      })
    ).toBe(892);
  });

  test('R4: clientHeight 200, anchor top 900, height 54', () => {
    expect(
      revealScrollTop({ left: 200, top: 900, width: 120, height: 54 }, h, {
        ...host,
        clientHeight: 200,
      })
    ).toBe(762);
  });

  test('R5: scrollHeight 1000, anchor top 980, height 20', () => {
    expect(
      revealScrollTop({ left: 200, top: 980, width: 120, height: 20 }, h, {
        ...host,
        scrollHeight: 1000,
      })
    ).toBe(400);
  });
});

describe('chooseTargetBox test table (T1 to T4)', () => {
  const viewHeight = 600;

  test('T1: full {0,100,200,40}', () => {
    const full = { left: 0, top: 100, width: 200, height: 40 };
    expect(chooseTargetBox(full, undefined, viewHeight)).toEqual(full);
  });

  test('T2: full {0,100,200,400}, first {20,100,180,20}', () => {
    const full = { left: 0, top: 100, width: 200, height: 400 };
    const first = { left: 20, top: 100, width: 180, height: 20 };
    expect(chooseTargetBox(full, first, viewHeight)).toEqual(first);
  });

  test('T3: full {0,100,200,400}, no first', () => {
    const full = { left: 0, top: 100, width: 200, height: 400 };
    expect(chooseTargetBox(full, undefined, viewHeight)).toEqual({
      left: 0,
      top: 100,
      width: 200,
      height: 0,
    });
  });

  test('T4: full {0,100,200,300}, first {20,100,180,20}', () => {
    const full = { left: 0, top: 100, width: 200, height: 300 };
    const first = { left: 20, top: 100, width: 180, height: 20 };
    expect(chooseTargetBox(full, first, viewHeight)).toEqual(full);
  });
});

describe('popoverLayer behavior', () => {
  beforeEach(installDom);
  afterEach(clearDom);
  test('in-place tracking: inner scroller moving horizontally triggers track() and updates left while top stays within 0.1px', () => {
    const host = document.createElement('div');
    Object.defineProperties(host, {
      scrollLeft: { value: 0, writable: true },
      scrollTop: { value: 0, writable: true },
      clientWidth: { value: 800 },
      clientHeight: { value: 600 },
      scrollHeight: { value: 2000 },
    });
    host.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;

    const layer = popoverLayer(host);
    const panel = document.createElement('div');
    Object.defineProperties(panel, {
      offsetWidth: { value: 320 },
      offsetHeight: { value: 160 },
    });

    let currentTarget = { left: 200, top: 300, width: 120, height: 20 };
    layer.show(panel, currentTarget, {
      follow: () => currentTarget,
      prefer: 'above',
    });

    const initialTop = parseFloat(panel.style.top);
    const initialLeft = parseFloat(panel.style.left);
    expect(initialLeft).toBe(100);
    expect(initialTop).toBe(132);

    // Move target horizontally by 50px
    currentTarget = { left: 250, top: 300, width: 120, height: 20 };
    layer.track();

    const updatedTop = parseFloat(panel.style.top);
    const updatedLeft = parseFloat(panel.style.left);
    expect(updatedLeft).toBe(150);
    expect(Math.abs(updatedTop - initialTop)).toBeLessThan(0.1);
    layer.hide();
  });

  test('height cap: a host with height 300, natural height 240 and anchor at {200,120,120,40} gets max-height: 124px and data-capped="true"', () => {
    const host = document.createElement('div');
    Object.defineProperties(host, {
      scrollLeft: { value: 0, writable: true },
      scrollTop: { value: 0, writable: true },
      clientWidth: { value: 800 },
      clientHeight: { value: 300 },
      scrollHeight: { value: 1000 },
    });
    host.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 300 }) as DOMRect;

    const layer = popoverLayer(host);
    const panel = document.createElement('div');
    Object.defineProperties(panel, {
      offsetWidth: { value: 320 },
      offsetHeight: { value: 240 },
    });

    layer.show(
      panel,
      { left: 200, top: 120, width: 120, height: 40 },
      { prefer: 'above' }
    );
    expect(panel.style.maxHeight).toBe('124px');
    expect(panel.dataset['capped']).toBe('true');
    layer.hide();
  });

  test('reveal: an anchor below the visible box scrolls the host so the panel top sits at vt', () => {
    const host = document.createElement('div');
    let st = 0;
    Object.defineProperties(host, {
      scrollLeft: { value: 0, writable: true },
      scrollTop: {
        get: () => st,
        set: (v) => {
          st = v;
        },
      },
      clientWidth: { value: 800 },
      clientHeight: { value: 600 },
      scrollHeight: { value: 2000 },
    });
    host.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;

    const layer = popoverLayer(host);
    const panel = document.createElement('div');
    Object.defineProperties(panel, {
      offsetWidth: { value: 320 },
      offsetHeight: { value: 160 },
    });

    layer.show(
      panel,
      { left: 200, top: 900, width: 120, height: 54 },
      { reveal: true, prefer: 'above' }
    );
    // revealScrollTop gives 362. At scrollTop = 362, vt is 370. Panel top is 900 - 8 - 160 = 732.
    expect(host.scrollTop).toBe(362);
    layer.hide();
  });

  test('disconnected target: track() when follow() returns undefined leaves left and top unchanged', () => {
    const host = document.createElement('div');
    Object.defineProperties(host, {
      scrollLeft: { value: 0, writable: true },
      scrollTop: { value: 0, writable: true },
      clientWidth: { value: 800 },
      clientHeight: { value: 600 },
      scrollHeight: { value: 2000 },
    });
    host.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;

    const layer = popoverLayer(host);
    const panel = document.createElement('div');
    Object.defineProperties(panel, {
      offsetWidth: { value: 320 },
      offsetHeight: { value: 160 },
    });

    let connected = true;
    layer.show(
      panel,
      { left: 200, top: 300, width: 120, height: 20 },
      {
        follow: () =>
          connected
            ? { left: 200, top: 300, width: 120, height: 20 }
            : undefined,
      }
    );

    const left = panel.style.left;
    const top = panel.style.top;

    connected = false;
    layer.track();

    expect(panel.style.left).toBe(left);
    expect(panel.style.top).toBe(top);
    layer.hide();
  });
});

describe('the conversion every call site would otherwise get wrong', () => {
  test('a viewport rect becomes content coordinates', () => {
    const anchor = anchorFromClientRect(
      { left: 300, top: 200, width: 80, height: 18 },
      { left: 100, top: 60 },
      { scrollLeft: 0, scrollTop: 420 }
    );
    expect(anchor).toEqual({ left: 200, top: 560, width: 80, height: 18 });
  });

  test('a host scrolled sideways is carried too', () => {
    const anchor = anchorFromClientRect(
      { left: 300, top: 200, width: 80, height: 18 },
      { left: 100, top: 60 },
      { scrollLeft: 50, scrollTop: 0 }
    );
    expect(anchor.left).toBe(250);
  });
});

describe('naming the selection back to the reader', () => {
  test('a short selection is quoted whole', () => {
    expect(shortQuote('the offer')).toBe('the offer');
  });

  test('a long one is cut and marked as cut', () => {
    const quoted = shortQuote('x'.repeat(OFFER_QUOTE_LIMIT + 20));
    expect(quoted.endsWith('\u2026')).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(OFFER_QUOTE_LIMIT + 1);
  });

  test('newlines inside a selection collapse, because a label is one line', () => {
    expect(shortQuote('two\n\nlines')).toBe('two lines');
  });
});
