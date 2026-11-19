import {
  COMMENT_CIPHERTEXT_LIMIT_CHARS,
  CommentTooLargeError,
  decryptComment,
  encryptComment,
  parseRelicId,
  type CommentPlaintext,
} from '@relic/format';
import type { SuggestCommit } from './suggest-draft.ts';

export interface SuggestCipher {
  seal(plaintext: CommentPlaintext): Promise<string>;
  open(ciphertext: string): Promise<CommentPlaintext>;
}

/** Uses the same authenticated comment envelope as the rest of the viewer. */
export function suggestCipher(key: CryptoKey): SuggestCipher {
  return {
    seal: (plaintext) => encryptComment(key, plaintext),
    open: (ciphertext) => decryptComment(key, ciphertext),
  };
}

export interface SuggestTransportOptions {
  readonly serviceOrigin: string;
  readonly relicId: string;
  readonly version: number;
  readonly reader: string;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly seal: SuggestCipher['seal'];
  readonly open: SuggestCipher['open'];
}

export type TransportFailure =
  | 'network'
  | 'server'
  | 'malformed-thread'
  | 'ciphertext-too-large'
  | 'seal'
  | 'sending';
export type TransportResult =
  | { readonly kind: 'ready' | 'superseded' | 'skipped' }
  | { readonly kind: 'posted'; readonly commentId: string | null }
  | { readonly kind: 'not-posted'; readonly reason: TransportFailure };

export interface SuggestTransportState {
  readonly status:
    | 'idle'
    | 'sealing'
    | 'ready'
    | 'sending'
    | 'not-posted'
    | 'posted';
  readonly draftOpen: boolean;
  readonly reason?: TransportFailure;
}

export interface RemoteComment {
  readonly comment_id: string;
  readonly author: string;
  readonly ciphertext: string;
  readonly version: number | null;
}

type SaveCommit = Extract<SuggestCommit, { kind: 'save' }>;
type DeleteCommit = Extract<SuggestCommit, { kind: 'delete' }>;
type WriteCommit = SaveCommit | DeleteCommit;

interface ActiveWrite {
  readonly change: WriteCommit;
  phase: 'sealing' | 'ready' | 'sending' | 'not-posted';
  /** The serialized request body is frozen before pagehide. */
  body: string | null;
  preparing?: Promise<TransportResult>;
  wantKeepalive?: boolean;
  reason?: TransportFailure;
}

export type ThreadResult =
  | { readonly kind: 'ready'; readonly comments: readonly RemoteComment[] }
  | { readonly kind: 'not-posted'; readonly reason: TransportFailure };

function sameSuggestion(a: CommentPlaintext, b: CommentPlaintext): boolean {
  const left = a.anchor;
  const right = b.anchor;
  const as = a.suggestion;
  const bs = b.suggestion;
  return (
    left?.kind === 'source' &&
    right?.kind === 'source' &&
    left.exact === right.exact &&
    (left.prefix ?? '') === (right.prefix ?? '') &&
    (left.suffix ?? '') === (right.suffix ?? '') &&
    as != null &&
    bs != null &&
    as.v === bs.v &&
    as.mode === bs.mode &&
    as.replacement === bs.replacement
  );
}

/** A session-local coordinator. It never stores plaintext on the service. */
export class SuggestTransport {
  private active: ActiveWrite | null = null;
  private draftOpen = false;
  private postedId: string | null = null;
  private inFlight: Promise<TransportResult> | null = null;
  private refreshInFlight: Promise<ThreadResult> | null = null;
  private lastRefresh: number | null = null;
  private readonly collectionUrl: string;

  constructor(private readonly options: SuggestTransportOptions) {
    let id = options.relicId;
    try {
      id = parseRelicId(id);
    } catch {
      /* The server reports an invalid id. */
    }
    this.collectionUrl = `${options.serviceOrigin}/api/relics/${encodeURIComponent(id)}/comments`;
  }

  get state(): SuggestTransportState {
    if (this.active)
      return {
        status: this.active.phase,
        draftOpen: this.draftOpen,
        ...(this.active.reason === undefined
          ? {}
          : { reason: this.active.reason }),
      };
    return {
      status: this.postedId === null ? 'idle' : 'posted',
      draftOpen: this.draftOpen,
    };
  }

  get shouldWarnBeforeUnload(): boolean {
    return this.draftOpen || this.active !== null;
  }

  /** Earliest time another activity refresh can start. */
  get nextActivityRefreshAt(): number | null {
    return this.lastRefresh === null ? null : this.lastRefresh + 10_000;
  }

  get activityRefreshInFlight(): Promise<ThreadResult> | null {
    return this.refreshInFlight;
  }

  /** Set this as soon as editing begins, even before a valid anchor can be sealed. */
  setDraftOpen(open: boolean): void {
    this.draftOpen = open;
  }

  /**
   * Re-seal after each edit. An older, slower seal can never replace the latest
   * body. While a seal is pending, pagehide does not send the previous draft.
   */
  prepare(change: WriteCommit): Promise<TransportResult> {
    if (
      this.inFlight ||
      (this.active?.phase === 'not-posted' &&
        this.active.reason !== 'seal' &&
        this.active.reason !== 'ciphertext-too-large')
    ) {
      return Promise.resolve({ kind: 'not-posted', reason: 'sending' });
    }
    const active: ActiveWrite = {
      change,
      phase: change.kind === 'delete' ? 'ready' : 'sealing',
      body: null,
    };
    this.active = active;
    this.draftOpen = true;
    this.postedId = null;
    if (change.kind === 'delete') return Promise.resolve({ kind: 'ready' });
    const preparing = this.seal(active, change);
    active.preparing = preparing;
    return preparing;
  }

  private async seal(
    active: ActiveWrite,
    change: SaveCommit
  ): Promise<TransportResult> {
    try {
      const ciphertext = await this.options.seal(change.plaintext);
      if (this.active !== active) return { kind: 'superseded' };
      if (ciphertext.length > COMMENT_CIPHERTEXT_LIMIT_CHARS)
        throw new CommentTooLargeError(
          'ciphertext',
          ciphertext.length,
          COMMENT_CIPHERTEXT_LIMIT_CHARS
        );
      active.body = JSON.stringify(
        change.existingId === null
          ? { ciphertext, version: this.options.version }
          : { ciphertext }
      );
      active.phase = 'ready';
      return { kind: 'ready' };
    } catch (error) {
      if (this.active !== active) return { kind: 'superseded' };
      const reason =
        error instanceof CommentTooLargeError && error.field === 'ciphertext'
          ? 'ciphertext-too-large'
          : 'seal';
      active.phase = 'not-posted';
      active.reason = reason;
      return { kind: 'not-posted', reason };
    }
  }

  private fail(active: ActiveWrite, reason: TransportFailure): TransportResult {
    if (this.active === active) {
      active.phase = 'not-posted';
      active.reason = reason;
    }
    return { kind: 'not-posted', reason };
  }

  private posted(
    active: ActiveWrite,
    commentId: string | null
  ): TransportResult {
    if (this.active === active) {
      this.active = null;
      this.draftOpen = false;
      this.postedId = commentId;
    }
    return { kind: 'posted', commentId };
  }

  /** Called without an await so the keepalive fetch starts in the lifecycle event. */
  private performSend(
    active: ActiveWrite,
    keepalive: boolean
  ): Promise<TransportResult> {
    const { change } = active;
    const id = change.existingId;
    const url =
      id === null
        ? this.collectionUrl
        : `${this.collectionUrl}/${encodeURIComponent(id)}`;
    const method =
      change.kind === 'delete' ? 'DELETE' : id === null ? 'POST' : 'PATCH';
    const init: RequestInit = {
      method,
      ...(change.kind === 'save'
        ? { headers: { 'content-type': 'application/json' }, body: active.body }
        : {}),
      ...(keepalive ? { keepalive: true } : {}),
    };
    active.phase = 'sending';
    delete active.reason;
    let request: Promise<Response>;
    try {
      request = this.options.fetch(url, init);
    } catch {
      return Promise.resolve(this.fail(active, 'network'));
    }
    return request
      .then(async (response): Promise<TransportResult> => {
        if (change.kind === 'delete') {
          return response.status === 204
            ? this.posted(active, change.existingId)
            : this.fail(active, 'server');
        }
        if (!response.ok) return this.fail(active, 'server');
        if (change.existingId !== null)
          return this.posted(active, change.existingId);
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return this.fail(active, 'malformed-thread');
        }
        if (
          typeof body !== 'object' ||
          body === null ||
          !('comment_id' in body) ||
          typeof body.comment_id !== 'string' ||
          body.comment_id.length === 0
        ) {
          return this.fail(active, 'malformed-thread');
        }
        return this.posted(active, body.comment_id);
      })
      .catch(() => this.fail(active, 'network'));
  }

  private track(promise: Promise<TransportResult>): Promise<TransportResult> {
    this.inFlight = promise;
    void promise.then(() => {
      if (this.inFlight === promise) this.inFlight = null;
    });
    return promise;
  }

  /** Commit the latest pre-sealed change. */
  commit(): Promise<TransportResult> {
    if (this.inFlight) return this.inFlight;
    const active = this.active;
    if (!active) return Promise.resolve({ kind: 'skipped' });
    if (active.phase === 'sealing' && active.preparing) {
      this.draftOpen = false;
      return active.preparing.then((result) =>
        result.kind === 'ready' && this.active === active
          ? active.wantKeepalive
            ? this.flushOnPageHide()
            : this.commit()
          : result
      );
    }
    if (active.phase === 'not-posted')
      return Promise.resolve({
        kind: 'not-posted',
        reason: active.reason ?? 'network',
      });
    if (active.phase !== 'ready') return Promise.resolve({ kind: 'skipped' });
    this.draftOpen = false;
    return this.track(this.performSend(active, false));
  }

  /** pagehide and hidden share a single in-flight request and never re-seal. */
  flushOnPageHide(): Promise<TransportResult> {
    if (this.inFlight) return this.inFlight;
    const active = this.active;
    if (active?.phase === 'sealing' && active.preparing) {
      this.draftOpen = false;
      active.wantKeepalive = true;
      return active.preparing.then((result) =>
        result.kind === 'ready' && this.active === active
          ? this.flushOnPageHide()
          : result
      );
    }
    if (!active || active.phase !== 'ready')
      return Promise.resolve({ kind: 'skipped' });
    this.draftOpen = false;
    return this.track(this.performSend(active, true));
  }

  private async loadThread(): Promise<ThreadResult> {
    let response: Response;
    try {
      response = await this.options.fetch(this.collectionUrl);
    } catch {
      return { kind: 'not-posted', reason: 'network' };
    }
    if (!response.ok) return { kind: 'not-posted', reason: 'server' };
    let rows: unknown;
    try {
      rows = await response.json();
    } catch {
      return { kind: 'not-posted', reason: 'malformed-thread' };
    }
    if (!Array.isArray(rows))
      return { kind: 'not-posted', reason: 'malformed-thread' };
    const comments: RemoteComment[] = [];
    for (const row of rows) {
      if (
        typeof row !== 'object' ||
        row === null ||
        !('comment_id' in row) ||
        typeof row.comment_id !== 'string' ||
        !('author' in row) ||
        typeof row.author !== 'string' ||
        !('ciphertext' in row) ||
        typeof row.ciphertext !== 'string' ||
        ('version' in row &&
          row.version !== null &&
          typeof row.version !== 'number')
      ) {
        return { kind: 'not-posted', reason: 'malformed-thread' };
      }
      comments.push({
        comment_id: row.comment_id,
        author: row.author,
        ciphertext: row.ciphertext,
        version:
          'version' in row && typeof row.version === 'number'
            ? row.version
            : null,
      });
    }
    return { kind: 'ready', comments };
  }

  /** Retry only after checking the server, because a lost response may be a successful write. */
  retry(): Promise<TransportResult> {
    if (this.inFlight) return this.inFlight;
    if (this.draftOpen) return Promise.resolve({ kind: 'skipped' });
    const active = this.active;
    if (!active || active.phase !== 'not-posted')
      return Promise.resolve({ kind: 'skipped' });
    if (active.change.kind === 'save' && active.body === null)
      return Promise.resolve({
        kind: 'not-posted',
        reason: active.reason ?? 'seal',
      });
    const attempt = (async (): Promise<TransportResult> => {
      const thread = await this.loadThread();
      if (thread.kind !== 'ready') return this.fail(active, thread.reason);
      if (active.change.kind === 'delete') {
        if (
          !thread.comments.some(
            (row) => row.comment_id === active.change.existingId
          )
        ) {
          return this.posted(active, active.change.existingId);
        }
      } else {
        const change = active.change;
        for (const row of thread.comments) {
          if (
            row.author.toLowerCase() !== this.options.reader.toLowerCase() ||
            row.version !== this.options.version ||
            (change.existingId !== null && row.comment_id !== change.existingId)
          )
            continue;
          let plaintext: CommentPlaintext;
          try {
            plaintext = await this.options.open(row.ciphertext);
          } catch {
            return this.fail(active, 'malformed-thread');
          }
          if (sameSuggestion(plaintext, change.plaintext))
            return this.posted(active, row.comment_id);
        }
      }
      return this.performSend(active, false);
    })();
    return this.track(attempt);
  }

  /** The UI passes the refreshed rows to its normal thread renderer. */
  refreshOnActivity(): Promise<ThreadResult | { readonly kind: 'skipped' }> {
    if (this.draftOpen) return Promise.resolve({ kind: 'skipped' });
    if (this.refreshInFlight) return this.refreshInFlight;
    const now = this.options.now();
    if (this.lastRefresh !== null && now - this.lastRefresh < 10_000)
      return Promise.resolve({ kind: 'skipped' });
    this.lastRefresh = now;
    const refresh = this.loadThread();
    this.refreshInFlight = refresh;
    void refresh.then(() => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    });
    return refresh;
  }

  /** Discard never attempts to undo a request already in flight. */
  discard(): boolean {
    if (this.inFlight) return false;
    this.active = null;
    this.draftOpen = false;
    this.postedId = null;
    return true;
  }
}
