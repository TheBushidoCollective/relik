/**
 * The host's side of a render frame's handshake, as a small state machine.
 *
 * The payload is the decrypted relic, so it is posted once per frame instance,
 * and only in reply to the frame's own ready message. The frame is opaque, so
 * no targetOrigin can name it, and '*' is the only value that reaches it. What
 * limits the reach of that '*' is this rule: after the frame has rendered, no
 * further payload is posted, and once its document has changed (a load after
 * the first), nothing more is posted to it at all.
 */
export class FrameHandshake {
  #loads = 0;
  #rendered = false;

  /**
   * A ready message from the frame. Returns true only for the first one, when
   * the payload should be posted. A ready after a navigation is never delivered.
   */
  onReady(): boolean {
    if (this.#rendered || this.navigated) return false;
    this.#rendered = true;
    return true;
  }

  /**
   * A load of the frame. The first load is the shim's own document. A later
   * one means the frame's document changed, so the frame is treated as navigated.
   */
  onLoad(): void {
    this.#loads += 1;
  }

  /** Whether the payload has been posted to this frame. */
  get rendered(): boolean {
    return this.#rendered;
  }

  /** Whether the frame's document changed after its first load. */
  get navigated(): boolean {
    return this.#loads > 1;
  }

  /** Whether anything may still be posted to the frame's current document. */
  canPost(): boolean {
    return !this.navigated;
  }
}
