/**
 * Heals a stale shell, on the two surfaces where a reload loses nothing.
 *
 * After a deploy, a page still running the previous `viewer.js` names a
 * compiler chunk the new service no longer has. Its import fails, and the
 * reader sees the could-not-be-opened card. Retry fails the same way every
 * time, because the page itself is the stale part. One reload loads the
 * current shell and reopens the relic from the vault.
 *
 * Automatic reload is offered only where the page holds no established view
 * and no unsent work: the initial open (and Retry from its failure card), and
 * a submitted key entry from that same card. Anywhere else (a historical
 * version, a comparison, a version switch) the page may hold drafts this
 * module cannot see, so a compiler failure is shown with a manual reload
 * instruction instead, and the reader's key stays in the vault.
 *
 * An automatic reload is gated on all of these:
 *
 * - the reader is still in the state that asked for the heal. Checked before
 *   the probe and again after it, with no await between the second check and
 *   the reload, because the probe takes time and the reader may have moved on;
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

export interface StaleShellOptions {
  readonly serviceOrigin: string;
  /** The vault's key for this relic, or undefined when none is stored. */
  readonly recallKey: () => string | undefined;
  /**
   * False once the reader has moved on. Called before the probe and again
   * after it, immediately before the reload.
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
  // reload: the reader may have left while the probe was held.
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
