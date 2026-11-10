import {
  loadHistoricalVersion,
  type HistoricalVersionState,
  type LoadProgress,
  type ReadyView,
  type ViewerDeps,
} from './viewer.ts';

export const RETAINED_UNPINNED_VERSION_BYTES = 64 * 1024 * 1024;
export const AUTO_PROJECTION_MAX_BYTES = 100 * 1024 * 1024;

export interface VersionGetOptions {
  readonly onProgress?: ((progress: LoadProgress) => void) | undefined;
  readonly maxBytes?: number | undefined;
}

export interface VersionStore {
  get(
    version: number,
    options?: VersionGetOptions
  ): Promise<HistoricalVersionState>;
  pin(version: number): void;
  unpin(version: number): void;
}

interface PendingVersion {
  readonly promise: Promise<HistoricalVersionState>;
  readonly listeners: Set<(progress: LoadProgress) => void>;
}

/** Each store belongs to one page. The boot view is pinned for its lifetime. */
export function createVersionStore(
  relicId: string,
  boot: ReadyView,
  deps: ViewerDeps
): VersionStore {
  const cache = new Map<number, HistoricalVersionState>([
    [boot.version, { kind: 'ready', view: boot }],
  ]);
  const pins = new Map<number, number>();
  const sizes = new Map<number, number>([[boot.version, boot.content.size]]);
  const pending = new Map<number, PendingVersion>();

  function pinned(version: number): boolean {
    return version === boot.version || (pins.get(version) ?? 0) > 0;
  }

  function weight(state: HistoricalVersionState): number {
    return state.kind === 'ready'
      ? state.view.content.size + (state.view.document?.bytes.length ?? 0)
      : 0;
  }

  function evict(): void {
    let total = 0;
    for (const [version, state] of cache)
      if (!pinned(version)) total += weight(state);
    for (const [version, state] of cache) {
      if (total <= RETAINED_UNPINNED_VERSION_BYTES) break;
      if (!pinned(version)) {
        total -= weight(state);
        cache.delete(version);
      }
    }
  }

  function tooLarge(version: number): HistoricalVersionState {
    return {
      kind: 'unavailable',
      code: 'version_too_large',
      detail: `Version ${version} is too large for this operation. Version ${boot.version} remains open.`,
    };
  }

  async function get(
    version: number,
    options: VersionGetOptions = {}
  ): Promise<HistoricalVersionState> {
    const limit = options.maxBytes;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new RangeError('Invalid version size limit');
    }
    const cached = cache.get(version);
    if (cached) {
      if (
        cached.kind === 'ready' &&
        limit !== undefined &&
        cached.view.content.size > limit
      )
        return tooLarge(version);
      cache.delete(version);
      cache.set(version, cached);
      return cached;
    }
    const knownSize = sizes.get(version);
    if (limit !== undefined && knownSize !== undefined && knownSize > limit)
      return tooLarge(version);

    let active = pending.get(version);
    if (!active) {
      const listeners = new Set<(progress: LoadProgress) => void>();
      if (options.onProgress) listeners.add(options.onProgress);
      const promise = loadHistoricalVersion(
        relicId,
        version,
        boot,
        deps,
        (progress) => {
          for (const listener of listeners) listener(progress);
        },
        {
          ...(limit === undefined ? {} : { maxBytes: limit }),
          onSize: (size) => {
            sizes.set(version, size);
          },
        }
      )
        .then((result) => {
          if (
            result.kind === 'ready' ||
            (result.code !== 'version_too_large' &&
              result.code !== 'large_open_cancelled' &&
              result.code !== 'content_changed')
          ) {
            cache.set(version, result);
            evict();
          }
          return result;
        })
        .finally(() => {
          pending.delete(version);
        });
      active = { promise, listeners };
      pending.set(version, active);
    }
    if (options.onProgress) active.listeners.add(options.onProgress);
    let result: HistoricalVersionState;
    try {
      result = await active.promise;
    } finally {
      if (options.onProgress) active.listeners.delete(options.onProgress);
    }
    if (
      result.kind === 'ready' &&
      limit !== undefined &&
      result.view.content.size > limit
    )
      return tooLarge(version);
    if (result.kind === 'unavailable' && result.code === 'version_too_large') {
      const size = sizes.get(version);
      if (limit === undefined || (size !== undefined && size <= limit))
        return get(version, options);
    }
    return result;
  }

  return {
    get,
    pin(version) {
      if (version !== boot.version)
        pins.set(version, (pins.get(version) ?? 0) + 1);
    },
    unpin(version) {
      if (version === boot.version) return;
      const count = pins.get(version) ?? 0;
      if (count <= 1) pins.delete(version);
      else pins.set(version, count - 1);
      evict();
    },
  };
}
