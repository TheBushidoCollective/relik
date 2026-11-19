import { takeHeadUtf8 } from './annotate-quote.ts';
import {
  PresenceClient,
  PresenceView,
  type PresenceAccess,
  type PresenceEnvironment,
  type PresencePeer,
  type PresenceStatus,
} from './presence.ts';
import type { SuggestController } from './suggest-controller.ts';

type PresenceSuggestion = Pick<
  SuggestController,
  'presenceDocument' | 'presenceState' | 'refreshOnPresence'
>;

export interface PresenceControllerOptions {
  readonly serviceOrigin: string;
  readonly relicId: string;
  readonly keyBytes: Uint8Array;
  readonly version: number;
  readonly name: string | null;
  readonly color: number;
  readonly stage: HTMLElement;
  readonly chip: HTMLElement;
  readonly suggestion: () => PresenceSuggestion | undefined;
  readonly ensureSuggestion: () => Promise<PresenceSuggestion | undefined>;
  readonly refresh: () => Promise<unknown>;
  readonly access: () => PresenceAccess;
  readonly environment?: PresenceEnvironment;
}

export interface PresenceController {
  readonly ready: Promise<void>;
  sync(): void;
  announcePosted(commentId: string): Promise<void>;
  dispose(): void;
}

/** One controller belongs to the stage and raw key of one displayed version. */
export function mountPresenceController(
  options: PresenceControllerOptions
): PresenceController {
  const { stage, chip } = options;
  const win = stage.ownerDocument.defaultView;
  if (!win) throw new Error('Presence requires a document window.');
  const mapped = options.suggestion()?.presenceDocument() ?? {
    root: stage,
    segments: [],
  };
  let root = mapped.root;
  let segments = mapped.segments;
  let peers: readonly PresencePeer[] = [];
  let status: PresenceStatus = 'idle';
  let frame: number | undefined;
  let disposed = false;
  let mappingRequested = false;
  let view: PresenceView | undefined;
  const paint = (): void => {
    if (!view && peers.length === 0 && status !== 'unavailable') return;
    if (!view) {
      stage.classList.add('presence-stage');
      view = new PresenceView({ stage, root, chip, segments });
    }
    const access = options.access();
    view.render(peers, status, access.signedIn && access.currentVersion);
  };
  const client = new PresenceClient({
    serviceOrigin: options.serviceOrigin,
    relicId: options.relicId,
    keyBytes: options.keyBytes,
    version: options.version,
    name: options.name === null ? null : takeHeadUtf8(options.name, 64),
    color: options.color,
    access: options.access(),
    ...(options.environment ? { environment: options.environment } : {}),
    onChange: (nextPeers, nextStatus) => {
      if (disposed) return;
      peers = nextPeers;
      status = nextStatus;
      paint();
      if (
        !mappingRequested &&
        !options.suggestion() &&
        peers.some(
          ({ state }) => state.caret !== undefined || state.typing !== undefined
        )
      ) {
        mappingRequested = true;
        void options
          .ensureSuggestion()
          .then(() => {
            if (!disposed) sync();
          })
          .catch(() => {});
      }
    },
    onPosted: () => {
      if (disposed) return;
      const suggestion = options.suggestion();
      if (suggestion) suggestion.refreshOnPresence();
      else void options.refresh().catch(() => {});
    },
  });
  const schedule = (): void => {
    if (disposed || frame !== undefined) return;
    frame = win.requestAnimationFrame(() => {
      frame = undefined;
      if (!disposed) view?.refresh();
    });
  };
  win.addEventListener('scroll', schedule, { capture: true, passive: true });
  win.addEventListener('resize', schedule);
  const observer =
    typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  observer?.observe(stage);
  if (root !== stage) observer?.observe(root);
  const sync = (): void => {
    if (disposed) return;
    client.setAccess(options.access());
    const suggestion = options.suggestion();
    client.setLocalState(suggestion?.presenceState() ?? { suggesting: false });
    const next = suggestion?.presenceDocument();
    if (next && (next.root !== root || next.segments !== segments)) {
      if (root !== stage) observer?.unobserve(root);
      root = next.root;
      segments = next.segments;
      if (root !== stage) observer?.observe(root);
      view?.setDocument(root, segments);
    }
    paint();
    schedule();
  };
  sync();
  const ready = client.start();
  return {
    ready,
    sync,
    announcePosted(commentId) {
      if (disposed) return Promise.resolve();
      client.setLocalState(
        options.suggestion()?.presenceState() ?? { suggesting: false }
      );
      return client.announcePosted(commentId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== undefined) win.cancelAnimationFrame(frame);
      observer?.disconnect();
      win.removeEventListener('scroll', schedule, true);
      win.removeEventListener('resize', schedule);
      client.dispose();
      view?.dispose();
      stage.classList.remove('presence-stage');
    },
  };
}
