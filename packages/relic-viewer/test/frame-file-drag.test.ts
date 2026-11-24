import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import {
  announceUnclaimedFileDrags,
  type DragSignalWindow,
  FRAME_FILE_DRAG_MESSAGE,
  isFrameFileDragMessage,
} from '../src/frame-file-drag.ts';

type Listener = (event: DragEvent) => void;

/** A window that records its listeners and what it posts to its parent. */
function fakeWindow() {
  const listeners = new Map<string, Listener[]>();
  const posted: unknown[] = [];
  const win: DragSignalWindow = {
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    parent: {
      postMessage(message) {
        posted.push(message);
      },
    },
  };
  const fire = (type: string, event: Partial<DragEvent>) => {
    for (const listener of listeners.get(type) ?? []) {
      listener(event as DragEvent);
    }
  };
  return { win, posted, fire };
}

const files = { types: ['Files'] } as unknown as DataTransfer;
const text = { types: ['text/plain'] } as unknown as DataTransfer;

/**
 * Lets the shim's deferred look at the event run. It is deferred so the
 * relic's own listeners, which run after the shim's, can cancel the dragover
 * first.
 */
const afterRelicListeners = () => jest.advanceTimersByTime(0);

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('a file dragged over a sandboxed frame', () => {
  test('is reported to the page when nothing in the frame claims it', () => {
    const { win, posted, fire } = fakeWindow();
    announceUnclaimedFileDrags(win);

    fire('dragover', {
      isTrusted: true,
      dataTransfer: files,
      defaultPrevented: false,
    });
    afterRelicListeners();

    expect(posted).toEqual([{ type: FRAME_FILE_DRAG_MESSAGE }]);
  });

  test('is left to a relik that cancels the dragover, because that relik takes file drops itself', () => {
    const { win, posted, fire } = fakeWindow();
    announceUnclaimedFileDrags(win);

    const event = {
      isTrusted: true,
      dataTransfer: files,
      defaultPrevented: false,
    };
    fire('dragover', event);
    // The relic's listener runs after the shim's, so the flag flips between
    // the event and the shim's deferred look at it.
    event.defaultPrevented = true;
    afterRelicListeners();

    expect(posted).toEqual([]);
  });

  test('is not reported by an event the frame made up, since only the browser can make one trusted', () => {
    const { win, posted, fire } = fakeWindow();
    announceUnclaimedFileDrags(win);

    fire('dragover', {
      isTrusted: false,
      dataTransfer: files,
      defaultPrevented: false,
    });
    afterRelicListeners();

    expect(posted).toEqual([]);
  });

  test('is not confused with a text drag', () => {
    const { win, posted, fire } = fakeWindow();
    announceUnclaimedFileDrags(win);

    fire('dragover', {
      isTrusted: true,
      dataTransfer: text,
      defaultPrevented: false,
    });
    afterRelicListeners();

    expect(posted).toEqual([]);
  });

  test('is reported once per drag, and again for the next drag', () => {
    const { win, posted, fire } = fakeWindow();
    announceUnclaimedFileDrags(win);
    const over = {
      isTrusted: true,
      dataTransfer: files,
      defaultPrevented: false,
    };

    fire('dragover', over);
    fire('dragover', over);
    fire('dragover', over);
    afterRelicListeners();
    expect(posted).toHaveLength(1);

    // Crossing between elements inside the frame is not the end of the drag.
    fire('dragleave', { relatedTarget: {} as EventTarget });
    fire('dragover', over);
    afterRelicListeners();
    expect(posted).toHaveLength(1);

    fire('dragleave', { relatedTarget: null });
    fire('dragover', over);
    afterRelicListeners();
    expect(posted).toHaveLength(2);
  });
});

describe('the page recognising the frame\u2019s report', () => {
  test('accepts the shim\u2019s message and nothing else', () => {
    expect(isFrameFileDragMessage({ type: FRAME_FILE_DRAG_MESSAGE })).toBe(
      true
    );
    expect(isFrameFileDragMessage({ type: 'relic:sandbox-ready' })).toBe(false);
    expect(isFrameFileDragMessage(FRAME_FILE_DRAG_MESSAGE)).toBe(false);
    expect(isFrameFileDragMessage(null)).toBe(false);
  });
});
