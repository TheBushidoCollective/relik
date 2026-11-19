/**
 * Host-side decisions for a link a rendered frame asks to open.
 *
 * The frame cannot be trusted to know a reader's click. Its own check runs in
 * the same realm as author code, which can post the request directly. So the
 * host never opens a tab on a request. It shows the destination in its own
 * chrome, and the tab opens only from a trusted click on that bar, once the
 * reader has had time to read the address.
 *
 * This module holds the pure parts: which destinations may be shown, what the
 * reader sees, and when the bar may be opened, closed, or must drop a request.
 * The bar's DOM lives in link-confirm-bar.ts.
 */

import { normaliseFrameExternalLink } from './annotate-frame.ts';

/** The reader has this long to read the destination before Open link works. */
export const LINK_READ_DELAY_MS = 1000;

/** After the bar closes, the frame cannot raise another one for this long. */
export const LINK_COOLDOWN_MS = 2000;

/** A bar nobody answers closes by itself after this long. */
export const LINK_TIMEOUT_MS = 30_000;

/** A destination as the reader sees it, taken from the parsed URL. */
export interface LinkDestination {
  /** The normalised address the new tab opens. */
  readonly href: string;
  /** `https:`, `http:` or `mailto:`. */
  readonly scheme: string;
  /**
   * The host as the browser will open it: an internationalised name shows in
   * punycode, and a port is kept. For mailto, the address.
   */
  readonly host: string;
  /** Path, query and fragment. For mailto, the query, such as the subject. */
  readonly rest: string;
}

/**
 * The destination a frame may ask the reader to open, or undefined.
 *
 * Only the schemes the frame boundary allows pass, and a URL with credentials
 * is refused: a reader must never be shown one destination while the address
 * that opens is a different host.
 */
export function describeLinkRequest(
  href: unknown
): LinkDestination | undefined {
  const normalised = normaliseFrameExternalLink(href);
  if (normalised === undefined) return undefined;
  const url = new URL(normalised);
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.protocol === 'mailto:') {
    return {
      href: normalised,
      scheme: 'mailto:',
      host: url.pathname,
      rest: url.search,
    };
  }
  return {
    href: normalised,
    scheme: url.protocol,
    host: url.host,
    rest: `${url.pathname}${url.search}${url.hash}`,
  };
}

export type LinkRequestOutcome =
  | { readonly kind: 'shown'; readonly destination: LinkDestination }
  | { readonly kind: 'dropped'; readonly dropped: number };

/**
 * The host's gate on frame link requests: one bar at a time, a cooldown after
 * each close, a read delay before Open link works, and a timeout. A request the
 * gate refuses is dropped and counted, so the bar can say so. The clock is
 * injected so the timing can be tested without waiting.
 */
export class LinkConfirmGate {
  readonly #now: () => number;
  #pending: LinkDestination | undefined;
  #shownAt = 0;
  #openableAt = 0;
  #cooldownUntil = 0;
  #dropped = 0;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /** Offer a destination for confirmation, or drop it while the gate is busy. */
  request(destination: LinkDestination): LinkRequestOutcome {
    const now = this.#now();
    if (this.#pending !== undefined || now < this.#cooldownUntil) {
      this.#dropped += 1;
      return { kind: 'dropped', dropped: this.#dropped };
    }
    this.#pending = destination;
    this.#shownAt = now;
    this.#openableAt = now + LINK_READ_DELAY_MS;
    this.#dropped = 0;
    return { kind: 'shown', destination };
  }

  /** The destination awaiting confirmation, if the bar is open. */
  get pending(): LinkDestination | undefined {
    return this.#pending;
  }

  /** Requests dropped while the current bar is open. */
  get dropped(): number {
    return this.#dropped;
  }

  /** Whether Open link may act now: the bar is open and the read delay passed. */
  canOpen(): boolean {
    return this.#pending !== undefined && this.#now() >= this.#openableAt;
  }

  /** The destination to open, if the reader may open it now. Closes the bar. */
  confirm(): LinkDestination | undefined {
    if (!this.canOpen()) return undefined;
    const destination = this.#pending;
    this.dismiss();
    return destination;
  }

  /** Close the bar for any reason: Cancel, Escape, a timeout, or a re-render. */
  dismiss(): void {
    if (this.#pending === undefined) return;
    this.#pending = undefined;
    this.#dropped = 0;
    this.#cooldownUntil = this.#now() + LINK_COOLDOWN_MS;
  }

  /** Close the bar when its time is up. Returns whether it closed. */
  expire(): boolean {
    if (this.#pending === undefined) return false;
    if (this.#now() - this.#shownAt < LINK_TIMEOUT_MS) return false;
    this.dismiss();
    return true;
  }
}
