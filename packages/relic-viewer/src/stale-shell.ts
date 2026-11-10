/**
 * Heals a stale shell.
 *
 * After a deploy, a page still running the previous `viewer.js` names a
 * compiler chunk the new service no longer has. Its import fails, and the
 * reader sees the could-not-be-opened card. Retry fails the same way every
 * time, because the page itself is the stale part. One reload loads the
 * current shell and reopens the relic from the vault.
 *
 * A reload is only worth taking when it can succeed, and it must not lose
 * work or loop, so it is gated on all of these:
 *
 * - the reader is still in the state that asked for the heal. Checked before
 *   the probe and again after it, with no await between the second check and
 *   the reload, because the probe takes time and the reader may have moved on;
 * - no unsent work is open on the page (see `hasUnsentWork`). The check fails
 *   closed: if the page cannot be read, the heal does nothing;
 * - no reload has happened in this tab since the compiler last loaded (a
 *   sessionStorage mark, which must be readable and writable);
 * - the vault holds this relic's key, so the reloaded page can reopen it;
 * - the service answers, so a network failure keeps its own error card.
 *
 * The server check is a HEAD of the icon: no key, no credentials, no cache,
 * and a path the service worker never answers. The mark is cleared only when
 * the compiler loads, so a deploy that is still broken costs one reload per
 * tab at most.
 */

export const STALE_SHELL_MARK = 'relic:stale-shell-reloaded';
export const SERVER_CHECK_TIMEOUT_MS = 5_000;

/**
 * A screen's lifecycle. Taking a token marks the state the reader is in.
 * Every exit and every selection calls `advance`, which invalidates every
 * token taken before it, so a late result can tell that the reader has moved
 * on and must not act.
 */
export interface Lifecycle {
  /** The token for the state the reader is in now. */
  readonly token: () => number;
  /** Starts a new state. Every earlier token becomes stale. */
  readonly advance: () => void;
  /** True while no `advance` has happened since `token` was taken. */
  readonly isCurrent: (token: number) => boolean;
}

export function createLifecycle(): Lifecycle {
  let generation = 0;
  return {
    token: () => generation,
    advance: () => {
      generation += 1;
    },
    isCurrent: (token) => token === generation,
  };
}

/**
 * Remembers which fields the reader has typed into, by element identity only.
 * Values are never stored: a field counts as edited if an input event reached
 * it, and whether it holds anything is read from the field when it is probed.
 * A prefilled or script-set value never fires an input event, so it does not
 * count as the reader's work.
 */
export interface EditTracker {
  /** Records an input event's target. Call from a capturing `input` listener. */
  readonly onInput: (target: unknown) => void;
  /** True if the reader has typed into this element. */
  readonly isEdited: (target: unknown) => boolean;
}

export function createEditTracker(): EditTracker {
  const edited = new WeakSet<object>();
  return {
    onInput: (target) => {
      if (typeof target === 'object' && target !== null) edited.add(target);
    },
    isEdited: (target) =>
      typeof target === 'object' && target !== null && edited.has(target),
  };
}

/** What the page holds that a reload would discard. */
export interface UnsentWorkProbe {
  /** Every text field on the page, with its value, type and edit record. */
  readonly fields: () => Iterable<{
    readonly value: string;
    readonly type: string;
    readonly edited: boolean;
  }>;
  /**
   * True while the reader is part way through something a reload would
   * discard: a decision or passkey ceremony, an awaited email code, or a
   * comment target placed but not yet posted.
   */
  readonly waiting: () => boolean;
  /**
   * True while focus is inside a sandboxed frame. The frame's document cannot
   * be read from here, so whatever the reader may be typing there is unknown,
   * and the heal fails closed.
   */
  readonly frameFocused: () => boolean;
}

/**
 * Input types whose value is not text the reader typed. A prefilled range,
 * color, number or date is a setting the page owns, not a draft.
 */
const NON_TEXT_TYPES: Readonly<Record<string, true>> = {
  button: true,
  checkbox: true,
  color: true,
  date: true,
  'datetime-local': true,
  file: true,
  hidden: true,
  image: true,
  month: true,
  number: true,
  radio: true,
  range: true,
  reset: true,
  submit: true,
  time: true,
  week: true,
};

/**
 * True when a reload would discard something the reader is part way through.
 * Fails closed: a page that cannot be read counts as holding work.
 */
export function hasUnsentWork(probe: UnsentWorkProbe): boolean {
  try {
    if (probe.frameFocused()) return true;
    if (probe.waiting()) return true;
    for (const field of probe.fields()) {
      if (NON_TEXT_TYPES[field.type] === true) continue;
      if (field.edited && field.value.trim().length > 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

export interface StaleShellOptions {
  readonly serviceOrigin: string;
  /** The vault's key for this relic, or undefined when none is stored. */
  readonly recallKey: () => string | undefined;
  /**
   * False once the reader has moved on, or while unsent work is open. Called
   * before the probe and again after it, immediately before the reload.
   */
  readonly isCurrent: () => boolean;
  readonly fetch: typeof globalThis.fetch;
  /** Defaults to the page's sessionStorage. Overridden in tests. */
  readonly session?: () => Storage;
  /** Defaults to reloading the current page. Overridden in tests. */
  readonly reload?: () => void;
  readonly timeoutMs?: number;
}

/**
 * Reloads the page once when that can heal it. Resolves true when a reload
 * was started, so the caller leaves the page alone. Never rejects.
 */
export async function healStaleShell(
  options: StaleShellOptions
): Promise<boolean> {
  if (!options.isCurrent()) return false;
  if (!markIsFree(options)) return false;
  if (options.recallKey() === undefined) return false;
  if (!(await serverAnswers(options))) return false;
  // Checked after the probe, with no await between this check and the
  // reload: the reader may have left, or started a draft, while it was held.
  if (!options.isCurrent()) return false;
  if (!setMark(options)) return false;
  (options.reload ?? defaultReload)();
  return true;
}

/**
 * Called once the compiler has loaded in this page. The shell is current,
 * so the guard re-arms for the next deploy. A blocked storage has nothing to
 * clear.
 */
export function markJsxCompilerLoaded(): void {
  try {
    globalThis.sessionStorage.removeItem(STALE_SHELL_MARK);
  } catch {
    // Storage is blocked or absent, so there is no mark to clear.
  }
}

function markIsFree(options: StaleShellOptions): boolean {
  try {
    return storageOf(options).getItem(STALE_SHELL_MARK) === null;
  } catch {
    return false;
  }
}

function setMark(options: StaleShellOptions): boolean {
  try {
    storageOf(options).setItem(STALE_SHELL_MARK, '1');
    return true;
  } catch {
    return false;
  }
}

function storageOf(options: StaleShellOptions): Storage {
  return options.session !== undefined
    ? options.session()
    : globalThis.sessionStorage;
}

async function serverAnswers(options: StaleShellOptions): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? SERVER_CHECK_TIMEOUT_MS
  );
  try {
    const response = await options.fetch(
      `${options.serviceOrigin}/assets/icon.svg`,
      {
        method: 'HEAD',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      }
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function defaultReload(): void {
  globalThis.location.reload();
}
