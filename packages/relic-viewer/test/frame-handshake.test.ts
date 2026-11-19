import { describe, expect, test } from 'bun:test';
import { FrameHandshake } from '../src/frame-handshake.ts';

describe('FrameHandshake', () => {
  test('the payload goes once, in reply to the first ready, whatever else arrives', () => {
    const handshake = new FrameHandshake();
    expect(handshake.onReady()).toBe(true);
    handshake.onLoad();
    expect(handshake.onReady()).toBe(false);
    expect(handshake.onReady()).toBe(false);
    expect(handshake.rendered).toBe(true);
    expect(handshake.canPost()).toBe(true);
  });

  test('a ready that arrives before the first load still delivers once', () => {
    const handshake = new FrameHandshake();
    expect(handshake.onReady()).toBe(true);
    handshake.onLoad();
    expect(handshake.canPost()).toBe(true);
  });

  test('a load after the first marks the frame navigated, so nothing more is posted', () => {
    const handshake = new FrameHandshake();
    handshake.onReady();
    handshake.onLoad();
    handshake.onLoad();
    expect(handshake.navigated).toBe(true);
    expect(handshake.canPost()).toBe(false);
    expect(handshake.onReady()).toBe(false);
  });

  test('regression: no later ready or load causes the payload to be posted again', () => {
    // Before this change every ready and every load posted the decrypted
    // payload, so a frame its author had navigated received the relic again.
    // Count the posts a page can cause: exactly one is allowed.
    const handshake = new FrameHandshake();
    let posts = 0;
    const deliver = (): void => {
      if (handshake.onReady()) posts += 1;
    };
    deliver();
    handshake.onLoad();
    deliver();
    handshake.onLoad();
    deliver();
    expect(posts).toBe(1);
  });
});
