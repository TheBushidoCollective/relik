import { suggestionSourceFor } from '@relic/format/suggestions';
import type { CommentPlaintext } from '@relic/format';
import { escapeInvisible } from '@relic/format/structured-text';
import type { CommentCipher, CommentEntry, SessionState } from './comments.ts';
import type { ReadyView, ViewerDeps } from './viewer.ts';
import type { SuggestCommit, SuggestDraft } from './suggest-draft.ts';
import {
  mountSuggestEditor,
  type SuggestEditor,
  type SuggestReceipt,
} from './suggest-editor.ts';
import { suggestionReceipt } from './suggest-receipt.ts';
import { SuggestTransport, type TransportResult } from './suggest-transport.ts';
import {
  buildSuggestionViews,
  clearSuggestionPaint,
  codeSegments,
  paintSuggestions,
  renderAppliedView,
  renderMarkdownWithSource,
  renderSuggestionCard,
  type SuggestionThreadRow,
  type SuggestionViews,
} from './suggestions.ts';
import type {
  MarkdownDelimiterPair,
  SourceSegment,
} from './markdown-source.ts';
import type { LocalPresence } from './presence.ts';
import { suggestionSurfaceFor } from './suggestion-surface.ts';

export interface SuggestControllerOptions {
  readonly view: ReadyView;
  readonly relicId: string;
  readonly deps: ViewerDeps;
  readonly host: HTMLElement;
  readonly bar: HTMLElement;
  readonly initialSelection?: Range;
  readonly session: () => SessionState;
  readonly cipher: () => CommentCipher | undefined;
  readonly entries: () => readonly CommentEntry[];
  readonly displayName: () => string | null;
  readonly refresh: () => Promise<unknown>;
  readonly readCurrentVersion: () => Promise<number | null>;
  readonly repaint: () => void;
  readonly signIn: () => void;
  readonly open: (id: string, target?: HTMLElement) => void;
  readonly onPresenceChange?: () => void;
  readonly onPosted?: (commentId: string) => void | Promise<void>;
  readonly onSurfaceReleased?: () => void;
}

export interface SuggestController {
  readonly suggesting: boolean;
  readonly draftOpen: boolean;
  hasPendingDraft(): boolean;
  readonly postInFlight: boolean;
  readonly applied: boolean;
  readonly currentVersion: boolean;
  presenceDocument():
    | { root: HTMLElement; segments: readonly SourceSegment[] }
    | undefined;
  presenceState(): LocalPresence;
  refreshOnPresence(): void;
  sync(): void;
  repaint(ordinary: () => void): void;
  card(entry: CommentEntry): HTMLElement | null;
  setSuggesting(on: boolean, selection?: Range): void;
  setApplied(on: boolean): void;
  selectedSuggestion(range: Range): string | null;
  restoreSelection(): void;
  retire(): void;
  destroy(): boolean;
}

type WritableCommit = Extract<SuggestCommit, { kind: 'save' | 'delete' }>;

function plaintext(
  entry: Extract<CommentEntry, { kind: 'open' }>
): CommentPlaintext {
  return {
    body: entry.body,
    display_name: entry.displayName,
    anchor: entry.anchor,
    ...(entry.addresses ? { addresses: entry.addresses } : {}),
    ...(entry.suggestion ? { suggestion: entry.suggestion } : {}),
    ...(entry.suggestion_outcome
      ? { suggestion_outcome: entry.suggestion_outcome }
      : {}),
  };
}

function selectionOffsets(
  root: HTMLElement,
  range?: Range
): [number, number] | null {
  if (
    !range ||
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return null;
  try {
    const prefix = root.ownerDocument.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    prefix.setEnd(range.endContainer, range.endOffset);
    return [start, prefix.toString().length];
  } catch {
    return null;
  }
}

function restoreOffsets(
  root: HTMLElement,
  offsets: [number, number] | null
): void {
  if (!offsets) return;
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT
  );
  let node: Node | null = walker.nextNode();
  let count = 0;
  let start: [Node, number] | undefined;
  let end: [Node, number] | undefined;
  for (; node; node = walker.nextNode()) {
    const element = node.parentElement;
    if (element?.closest('ins[data-sg], [data-sg-decoration]')) continue;
    const length = node.textContent?.length ?? 0;
    if (!start && offsets[0] <= count + length)
      start = [node, offsets[0] - count];
    if (!end && offsets[1] <= count + length) end = [node, offsets[1] - count];
    count += length;
  }
  if (!start || !end) return;
  const range = root.ownerDocument.createRange();
  range.setStart(...start);
  range.setEnd(...end);
  const selection = root.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
function presencePoint(
  root: HTMLElement,
  segments: readonly SourceSegment[],
  pending: readonly { readonly id: string; readonly end: number }[],
  draft: SuggestDraft | null,
  node: Node,
  offset: number,
  side: 'start' | 'end'
): number | undefined {
  if (!root.contains(node)) return undefined;
  const parent = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const insertion = parent?.closest<HTMLElement>('ins[data-sg]');
  if (insertion && root.contains(insertion)) {
    if (insertion.hasAttribute('data-sg-draft')) return draft?.end;
    return pending.find((item) => item.id === insertion.getAttribute('data-sg'))
      ?.end;
  }
  const all = Array.from(root.querySelectorAll<HTMLElement>('[data-seg]'));
  if (root.hasAttribute('data-seg')) all.unshift(root);
  let element = parent?.closest<HTMLElement>('[data-seg]') ?? null;
  let local: number | undefined;
  try {
    if (!element || !root.contains(element)) {
      let before: HTMLElement | undefined;
      let after: HTMLElement | undefined;
      for (const candidate of all) {
        const probe = root.ownerDocument.createRange();
        probe.selectNodeContents(candidate);
        const comparison = probe.comparePoint(node, offset);
        if (comparison < 0) {
          after = candidate;
          break;
        }
        if (comparison > 0) before = candidate;
        else {
          element = candidate;
          break;
        }
      }
      if (!element) {
        element =
          (side === 'start' ? (after ?? before) : (before ?? after)) ?? null;
        if (element) {
          const segment = segments[all.indexOf(element)];
          if (segment) local = element === after ? 0 : segment.text.length;
        }
      }
    }
    if (!element) return undefined;
    const segment = segments[all.indexOf(element)];
    if (!segment) return undefined;
    if (local === undefined) {
      const range = root.ownerDocument.createRange();
      range.setStart(element, 0);
      range.setEnd(node, offset);
      const fragment = range.cloneContents();
      for (const excluded of fragment.querySelectorAll(
        'ins[data-sg], [data-sg-decoration]'
      ))
        excluded.remove();
      local = fragment.textContent?.length ?? 0;
    }
    if (local < 0 || local > segment.text.length) return undefined;
    if (
      segment.kind === 'escape' &&
      local !== 0 &&
      local !== segment.text.length
    )
      return undefined;
    return segment.kind === 'join' || segment.kind === 'escape'
      ? local === 0
        ? segment.start
        : segment.end
      : segment.start + local;
  } catch {
    return undefined;
  }
}

/** This module is the only lazy entry point for the suggestion feature. */
export function mountSuggestionController(
  input: SuggestControllerOptions
): SuggestController {
  const { initialSelection, ...options } = input;
  const { view, host, bar } = options;
  const kind =
    view.route === 'code' || view.route === 'notebook' ? 'code' : 'markdown';
  const doc = host.ownerDocument;
  let surface = suggestionSurfaceFor(host);
  let root =
    surface?.root ??
    host.querySelector<HTMLElement>(
      kind === 'code' ? 'pre.code-body' : 'article.prose'
    );
  let original = surface
    ? root
    : kind === 'code'
      ? root?.closest<HTMLElement>('.code')
      : root;
  const selection = root ? selectionOffsets(root, initialSelection) : null;
  const sourceResult =
    view.document && !view.document.truncated
      ? suggestionSourceFor(
          view.document.bytes,
          view.filename ?? '',
          view.declaredMimetype ?? ''
        )
      : { ok: false as const, reason: 'too_large' as const };
  const source = sourceResult.ok ? sourceResult.source : '';
  let segments: readonly SourceSegment[] = [];
  let delimiters: readonly MarkdownDelimiterPair[] = [];
  let editor: SuggestEditor | undefined;
  let editorReader: string | undefined;
  let transport: SuggestTransport | undefined;
  let views: SuggestionViews | undefined;
  let currentVersion = view.currentVersion;
  let appliedRoot: HTMLElement | undefined;
  let applied = false;
  let failed = false;
  let destroyed = false;
  let releaseDetached = false;
  let retired = false;
  let lastDraft: SuggestDraft | null = null;
  let draftSequence = 0;
  let activeCommit: WritableCommit | undefined;
  let previous: CommentPlaintext | undefined;
  let committingOnPageHide = false;
  // A mode-off with a post in flight holds presence on "suggesting" until that
  // post's announcement has left the socket, or can never leave.
  let modeOffHold: object | undefined;
  // The hold that the commit now in flight answers, if Suggesting was turned
  // off to make it.
  let commitHold: object | undefined;
  let pendingPresenceRefresh = false;
  let presenceRefreshTimer: number | undefined;
  let awaitingPresenceRefresh: Promise<unknown> | undefined;
  const presenceChange = (): void => options.onPresenceChange?.();
  const releaseHold = (hold: object | undefined): void => {
    if (hold === undefined || hold !== modeOffHold) return;
    modeOffHold = undefined;
    presenceChange();
  };
  const setEditorSuggesting = (on: boolean): boolean => {
    if (!editor) return false;
    if (on) releaseHold(modeOffHold);
    else if (editor.suggesting && editor.draft && options.onPosted)
      modeOffHold = {};
    const changed = editor.setSuggesting(on);
    if (!changed || (!on && modeOffHold !== undefined && !activeCommit))
      releaseHold(modeOffHold);
    presenceChange();
    return changed;
  };
  const editorChrome = doc.createElement('div');
  editorChrome.className = 'sg-editor-chrome';
  host.appendChild(editorChrome);
  const failureHost = doc.createElement('div');
  host.appendChild(failureHost);
  const readingButton =
    bar.querySelector<HTMLButtonElement>('[data-sg-reading]');
  const suggestingButton = bar.querySelector<HTMLButtonElement>(
    '[data-sg-suggesting]'
  );
  const appliedButton =
    bar.querySelector<HTMLButtonElement>('[data-sg-applied]');
  const count = bar.querySelector<HTMLElement>('[data-sg-count]');
  const notice = bar.querySelector<HTMLElement>('[data-sg-notice]');

  if (sourceResult.ok && root) {
    if (surface) {
      segments = surface.segments(source);
    } else if (kind === 'markdown') {
      const mapped = renderMarkdownWithSource(source);
      segments = mapped.segments;
      delimiters = mapped.delimiters;
      const parsed = new DOMParser().parseFromString(mapped.html, 'text/html');
      root.replaceChildren(...Array.from(parsed.body.childNodes));
    } else {
      segments = codeSegments(source);
    }
  }

  const guard = (): string | null => {
    if (view.version !== currentVersion)
      return 'Suggestions can only be made on the current version.';
    if (!sourceResult.ok) {
      if (sourceResult.reason === 'too_large')
        return 'Suggesting is off: suggestions work on files up to 1 MiB.';
      if (sourceResult.reason === 'not_utf8')
        return 'Suggesting is off: this file is not valid UTF-8.';
      if (sourceResult.reason === 'mixed_line_endings')
        return 'Suggesting is off: this file mixes CRLF and LF line endings.';
      return 'Suggesting is off: this file contains carriage returns (CR) or NUL characters, which a suggestion can’t point at.';
    }
    if (sourceResult.crlf && !surface)
      return 'Suggesting is off in Source for files with CRLF line endings.';
    if (!root || !original || failed || editor?.unavailable)
      return (
        editor?.unavailable ??
        "This document's layout could not be matched to its source."
      );
    const session = options.session();
    if (session.kind !== 'verified') return 'Sign in to suggest edits.';
    if (editor && editorReader !== session.email)
      return 'Post or discard the previous suggestion before changing identities.';
    return null;
  };

  const updateControls = (): void => {
    const reason = guard();
    if (readingButton)
      readingButton.setAttribute('aria-pressed', String(!editor?.suggesting));
    if (suggestingButton) {
      suggestingButton.setAttribute(
        'aria-pressed',
        String(!!editor?.suggesting)
      );
      suggestingButton.disabled = reason !== null || applied;
      suggestingButton.title = reason ?? '';
    }
    if (appliedButton) {
      appliedButton.hidden = !!editor?.suggesting;
      appliedButton.disabled = !sourceResult.ok || !root;
      appliedButton.setAttribute('aria-checked', String(applied));
    }
    if (notice)
      notice.textContent =
        reason ??
        views?.overflowNote ??
        (editor?.suggesting ? 'Type to suggest changes.' : '');
    if (count) {
      const number = views?.views.length ?? 0;
      count.textContent =
        number === 1 ? '1 suggestion' : `${number} suggestions`;
      count.title =
        views?.overflowNote ?? 'Hover over a change to see its thread.';
    }
  };

  const rows = (): SuggestionThreadRow[] =>
    options.entries().flatMap((entry) => {
      if (entry.kind !== 'open' || typeof entry.version !== 'number') return [];
      return [
        {
          id: entry.id,
          author: entry.author,
          version: entry.version,
          created_at: entry.createdAt,
          plaintext: plaintext(entry),
          resolution: entry.resolution ?? null,
        },
      ];
    });

  const showFailure = (reason: string): void => {
    if (retired && !failureHost.isConnected) host.append(failureHost);
    failureHost.replaceChildren();
    const panel = doc.createElement('section');
    panel.className = 'sg-dock sg-receipt is-failed';
    panel.setAttribute('role', 'alert');
    const title = doc.createElement('strong');
    title.textContent = 'Not posted';
    const note = doc.createElement('p');
    note.textContent =
      reason === 'ciphertext-too-large'
        ? 'This suggestion is too large to post. Shorten it.'
        : 'Your suggestion has not been posted. Leaving this page will ask first.';
    const retry = doc.createElement('button');
    retry.type = 'button';
    retry.className = 'popover-action';
    retry.textContent = 'Retry';
    const discard = doc.createElement('button');
    discard.type = 'button';
    discard.className = 'popover-action';
    discard.textContent = 'Discard';
    retry.addEventListener('click', () => {
      if (!transport) return;
      retry.disabled = true;
      const attempt =
        reason === 'seal' && activeCommit
          ? transport
              .prepare(activeCommit)
              .then((result) =>
                result.kind === 'ready' ? transport!.commit() : result
              )
          : transport.retry();
      void attempt.then((result) => finish(result, lastDraft));
    });
    discard.addEventListener('click', () => {
      if (transport?.discard()) {
        failureHost.replaceChildren();
        activeCommit = undefined;
        if (retired) window.removeEventListener('beforeunload', beforeunload);
        resumePresenceRefresh();
        if (!root) options.onSurfaceReleased?.();
      }
    });
    panel.append(title);
    if (lastDraft) {
      const diff = doc.createElement('div');
      diff.className = 'rc-body';
      const struck = doc.createElement('del');
      struck.className = 'sg-del';
      struck.textContent = lastDraft.struck;
      const inserted = doc.createElement('ins');
      inserted.className = 'sg-ins';
      inserted.textContent = lastDraft.inserted;
      diff.append(struck, inserted);
      panel.append(diff);
    }
    panel.append(note, retry, discard);
    failureHost.appendChild(panel);
  };

  const finish = (
    result: TransportResult,
    draft: SuggestDraft | null
  ): void => {
    if (destroyed) return;
    if (releaseDetached) queueMicrotask(releaseSurface);
    else if (!root) queueMicrotask(() => options.onSurfaceReleased?.());
    const hold = commitHold;
    commitHold = undefined;
    if (result.kind === 'not-posted') {
      releaseHold(hold);
      showFailure(result.reason);
      return;
    }
    if (result.kind !== 'posted') {
      releaseHold(hold);
      return;
    }
    if (!activeCommit) return;
    // Presence stays "suggesting" until the announcement has left the socket or
    // can never leave, so the other readers hear about the post before it ends.
    const announced =
      result.commentId === null
        ? undefined
        : options.onPosted?.(result.commentId);
    if (hold !== undefined)
      void Promise.resolve(announced).then(
        () => releaseHold(hold),
        () => releaseHold(hold)
      );
    failureHost.replaceChildren();
    const sent = activeCommit;
    const old = previous;
    activeCommit = undefined;
    if (retired) window.removeEventListener('beforeunload', beforeunload);
    resumePresenceRefresh();
    void options.refresh();
    if (!draft || !editor || !sent) return;
    const showReceipt = releaseDetached
      ? (value: SuggestReceipt) => host.append(suggestionReceipt(doc, value))
      : editor.showReceipt;
    showReceipt({
      struck: draft.struck,
      inserted: draft.inserted,
      undo: () => {
        if (!transport) return;
        let undo: WritableCommit | undefined;
        if (
          sent.kind === 'save' &&
          sent.existingId === null &&
          result.commentId
        )
          undo = { kind: 'delete', existingId: result.commentId };
        else if (old)
          undo = {
            kind: 'save',
            plaintext: old,
            existingId: sent.kind === 'delete' ? null : sent.existingId,
          };
        if (!undo) return;
        if (retired) window.addEventListener('beforeunload', beforeunload);
        activeCommit = undo;
        previous = undefined;
        void transport
          .prepare(undo)
          .then(() => transport?.commit())
          .then((answer) => {
            if (answer) finish(answer, null);
          });
      },
    });
  };
  const updateGutter = (): void => {
    if (kind !== 'code' || !root) return;
    const gutter = root.parentElement?.querySelector<HTMLElement>('pre.gutter');
    if (!gutter) return;
    const lines = ['1'];
    let line = 1;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (element?.closest('[hidden], [data-sg-decoration]')) continue;
      const inserted = !!element?.closest('ins[data-sg]');
      const breaks = (node.textContent?.match(/\n/g) ?? []).length;
      for (let i = 0; i < breaks; i++)
        lines.push(inserted ? '+' : String(++line));
    }
    gutter.textContent = lines.join('\n');
  };

  const ensureEditor = (): void => {
    const session = options.session();
    const cipher = options.cipher();
    if (!root || !sourceResult.ok || session.kind !== 'verified' || !cipher)
      return;
    if (editor && editorReader === session.email) return;
    if (editor && transport?.shouldWarnBeforeUnload) return;
    editor?.destroy();
    editorReader = session.email;
    transport = new SuggestTransport({
      serviceOrigin: options.deps.serviceOrigin,
      relicId: options.relicId,
      version: view.version,
      ...(view.folder
        ? { entry: view.folder.manifest.entries[view.folder.index]!.path }
        : {}),
      reader: session.email,
      fetch: options.deps.fetch,
      now: options.deps.now ?? Date.now,
      seal: cipher.seal,
      open: cipher.open,
    });
    editor = mountSuggestEditor({
      root,
      source,
      segments,
      delimiters,
      version: view.version,
      reader: session.email,
      crlf: sourceResult.crlf,
      surface,
      displayName: options.displayName(),
      pending: views?.pending ?? [],
      chrome: editorChrome,
      receiptHost: host,
      unavailable: view.version !== currentVersion ? 'older' : null,
      onRefusal: (message) => {
        if (
          message.includes('layout could not') ||
          message.includes('page changed unexpectedly')
        )
          failed = true;
        updateControls();
      },
      onDraftChange: (draft) => {
        updateGutter();
        const sequence = ++draftSequence;
        if (draft) {
          lastDraft = draft;
          const prepared = editor?.prepare();
          if (
            prepared &&
            (prepared.kind === 'save' || prepared.kind === 'delete')
          ) {
            void transport?.prepare(prepared);
          } else {
            transport?.discard();
            transport?.setDraftOpen(true);
          }
        } else {
          transport?.setDraftOpen(false);
          queueMicrotask(() => {
            if (sequence === draftSequence) {
              transport?.discard();
              resumePresenceRefresh();
            }
          });
        }
        presenceChange();
      },
      onCommit: (commit) => {
        ++draftSequence;
        if (!transport || (commit.kind !== 'save' && commit.kind !== 'delete'))
          return;
        const saved = lastDraft;
        const priorEntry =
          commit.existingId === null
            ? undefined
            : options
                .entries()
                .find(
                  (entry) =>
                    entry.kind === 'open' && entry.id === commit.existingId
                );
        previous =
          priorEntry?.kind === 'open' ? plaintext(priorEntry) : undefined;
        activeCommit = commit;
        commitHold = modeOffHold;
        if (committingOnPageHide) {
          // The live draft was already prepared on its last edit. Reuse it so
          // a ready keepalive request starts inside the lifecycle event.
          void transport
            .flushOnPageHide()
            .then((result) => finish(result, saved));
          return;
        }
        void transport
          .prepare(commit)
          .then((result) =>
            result.kind === 'ready' ? transport!.commit() : result
          )
          .then((result) => finish(result, saved));
      },
    });
    editor.controls.style.display = 'none';
  };

  const sync = (): void => {
    const session = options.session();
    if (session.kind !== 'verified') {
      pendingPresenceRefresh = false;
      window.clearTimeout(presenceRefreshTimer);
      presenceRefreshTimer = undefined;
    }
    if (session.kind !== 'verified' && editor?.suggesting)
      setEditorSuggesting(false);
    const cipher = options.cipher();
    if (!transport && cipher) {
      transport = new SuggestTransport({
        serviceOrigin: options.deps.serviceOrigin,
        relicId: options.relicId,
        version: view.version,
        ...(view.folder
          ? { entry: view.folder.manifest.entries[view.folder.index]!.path }
          : {}),
        reader: session.kind === 'verified' ? session.email : '',
        fetch: options.deps.fetch,
        now: options.deps.now ?? Date.now,
        seal: cipher.seal,
        open: cipher.open,
      });
    }
    views = buildSuggestionViews(
      source,
      rows(),
      view.version,
      currentVersion,
      session.kind === 'verified' ? session.email : null
    );
    host
      .querySelector('.structured-table')
      ?.dispatchEvent(
        new CustomEvent('relic:table-suggestion-views', { detail: views })
      );
    ensureEditor();
    updateControls();
    resumePresenceRefresh();
    presenceChange();
  };

  const repaint = (ordinary: () => void): void => {
    if (destroyed || editor?.draft) return;
    if (!views || !root || !sourceResult.ok) {
      ordinary();
      return;
    }
    if (applied) {
      appliedRoot?.remove();
      appliedRoot = renderAppliedView(views, kind, doc);
      original?.after(appliedRoot);
      return;
    }
    const draw = (): void => {
      const target = root;
      if (!target) return;
      clearSuggestionPaint(target);
      surface?.repaint();
      ordinary();
      const first = segments[0];
      const last = segments[segments.length - 1];
      const visibleViews =
        surface?.clipPaint && first && last
          ? {
              ...views!,
              paint: views!.paint.filter(
                (view) =>
                  view.location.status === 'resolved' &&
                  view.location.start >= first.start &&
                  view.location.end <= last.end
              ),
            }
          : views!;
      const result = paintSuggestions(
        target,
        segments,
        visibleViews,
        surface ? 'markdown' : kind,
        surface?.decode?.bind(surface)
      );
      if (!result.ok) {
        failed = true;
        if (notice) notice.textContent = result.reason;
        return;
      }
      for (const item of target.querySelectorAll<HTMLElement>('[data-sg-id]')) {
        const id = item.getAttribute('data-sg-id');
        if (id) item.dataset['commentId'] = id;
      }
      updateGutter();
    };
    if (editor) editor.updatePending(views.pending, draw);
    else draw();
    if (failed && editor?.suggesting) setEditorSuggesting(false);
    updateControls();
    presenceChange();
  };

  const stopInputDuringSend = (event: Event): void => {
    if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Tab')
      return;
    if (
      activeCommit ||
      (transport?.state.status === 'not-posted' && !editor?.draft)
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const releaseSurface = (): void => {
    if (!releaseDetached) return;
    releaseDetached = false;
    editor?.destroy();
    editor = undefined;
    for (const type of ['beforeinput', 'paste', 'drop', 'keydown'])
      root?.removeEventListener(type, stopInputDuringSend, true);
    root = null;
    original = undefined;
    surface = undefined;
    options.onSurfaceReleased?.();
  };
  const adoptCurrentSurface = (): boolean => {
    const next = suggestionSurfaceFor(host);
    if (!next || next === surface) return true;
    if (editor?.draft || transport?.shouldWarnBeforeUnload) return false;
    editor?.destroy();
    editor = undefined;
    editorReader = undefined;
    for (const type of ['beforeinput', 'paste', 'drop', 'keydown'])
      root?.removeEventListener(type, stopInputDuringSend, true);
    surface = next;
    root = next.root;
    original = next.root;
    segments = sourceResult.ok ? next.segments(source) : [];
    delimiters = [];
    failed = false;
    for (const type of ['beforeinput', 'paste', 'drop', 'keydown'])
      root.addEventListener(type, stopInputDuringSend, true);
    return true;
  };
  root?.addEventListener('beforeinput', stopInputDuringSend, true);
  root?.addEventListener('paste', stopInputDuringSend, true);
  root?.addEventListener('drop', stopInputDuringSend, true);
  root?.addEventListener('keydown', stopInputDuringSend, true);
  const activity = (): void => {
    if (!host.isConnected || doc.visibilityState !== 'visible' || !transport)
      return;
    void transport.refreshOnActivity().then(async (result) => {
      if (result.kind !== 'ready' || editor?.draft) return;
      const latest = await options.readCurrentVersion();
      if (!host.isConnected || editor?.draft) return;
      if (latest !== null && latest > currentVersion) {
        currentVersion = latest;
        if (editor?.suggesting) setEditorSuggesting(false);
        presenceChange();
      }
      await options.refresh();
    });
  };
  function resumePresenceRefresh(): void {
    if (
      destroyed ||
      !pendingPresenceRefresh ||
      !transport ||
      !host.isConnected ||
      doc.visibilityState !== 'visible' ||
      editor?.draft ||
      activeCommit
    )
      return;
    const inFlight = transport.activityRefreshInFlight;
    if (inFlight) {
      if (awaitingPresenceRefresh !== inFlight) {
        awaitingPresenceRefresh = inFlight;
        void inFlight.then(() => {
          if (awaitingPresenceRefresh === inFlight)
            awaitingPresenceRefresh = undefined;
          resumePresenceRefresh();
        });
      }
      return;
    }
    const next = transport.nextActivityRefreshAt;
    const delay =
      next === null ? 0 : Math.max(0, next - (options.deps.now ?? Date.now)());
    if (delay > 0) {
      if (presenceRefreshTimer === undefined) {
        presenceRefreshTimer = window.setTimeout(() => {
          presenceRefreshTimer = undefined;
          resumePresenceRefresh();
        }, delay);
      }
      return;
    }
    window.clearTimeout(presenceRefreshTimer);
    presenceRefreshTimer = undefined;
    pendingPresenceRefresh = false;
    activity();
  }
  const refreshVisible = (): void => {
    if (pendingPresenceRefresh) resumePresenceRefresh();
    else activity();
  };
  const flush = (): void => {
    if (!host.isConnected) return;
    if (editor?.draft) {
      committingOnPageHide = true;
      try {
        editor.commit();
      } finally {
        committingOnPageHide = false;
      }
      return;
    }
    void transport
      ?.flushOnPageHide()
      .then((result) => finish(result, lastDraft));
  };
  const hidden = (): void => {
    if (doc.visibilityState === 'hidden') flush();
    else refreshVisible();
  };
  const pagehide = (): void => flush();
  const beforeunload = (event: BeforeUnloadEvent): void => {
    if (
      host.isConnected &&
      (editor?.draft || transport?.shouldWarnBeforeUnload)
    ) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  const selectionChanged = (): void => presenceChange();
  doc.addEventListener('selectionchange', selectionChanged);
  doc.addEventListener('visibilitychange', hidden);
  window.addEventListener('focus', refreshVisible);
  window.addEventListener('pagehide', pagehide);
  window.addEventListener('beforeunload', beforeunload);

  sync();
  return {
    get suggesting() {
      return !!editor?.suggesting;
    },
    get draftOpen() {
      return !!editor?.draft;
    },
    hasPendingDraft() {
      return !!editor?.draft || !!transport?.shouldWarnBeforeUnload;
    },
    get postInFlight() {
      return !!activeCommit && transport?.state.status !== 'not-posted';
    },
    get applied() {
      return applied;
    },
    get currentVersion() {
      return view.version === currentVersion;
    },
    presenceDocument() {
      return root ? { root, segments } : undefined;
    },
    presenceState() {
      const suggesting = !!editor?.suggesting || modeOffHold !== undefined;
      const draft = editor?.draft ?? null;
      const selection = suggesting ? doc.getSelection() : null;
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const pending = views?.pending ?? [];
      const start =
        root && range
          ? presencePoint(
              root,
              segments,
              pending,
              draft,
              range.startContainer,
              range.startOffset,
              'start'
            )
          : undefined;
      const end =
        root && range
          ? presencePoint(
              root,
              segments,
              pending,
              draft,
              range.endContainer,
              range.endOffset,
              'end'
            )
          : undefined;
      return {
        suggesting,
        ...(start === undefined || end === undefined
          ? {}
          : { caret: { s: start, e: end } }),
        ...(draft === null ? {} : { typing: { s: draft.start, e: draft.end } }),
      };
    },
    refreshOnPresence() {
      pendingPresenceRefresh = true;
      resumePresenceRefresh();
    },
    sync,
    repaint,
    card(entry) {
      if (entry.kind !== 'open' || !entry.suggestion || !views) return null;
      const found = views.byId.get(entry.id);
      if (!found) return null;
      const card = renderSuggestionCard(found, views, doc, kind);
      if (host.querySelector('.structured-table')) {
        for (const part of card.querySelectorAll<HTMLElement>(
          '.sg-del, .sg-ins'
        )) {
          part.textContent = escapeInvisible(part.textContent ?? '');
        }
      }
      card.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;
        const target = event.target.closest<HTMLElement>('[data-sg-open]');
        const id = target?.getAttribute('data-sg-open');
        if (!id || !target) return;
        event.preventDefault();
        event.stopPropagation();
        options.open(id, target);
      });
      return card;
    },
    setSuggesting(on, range) {
      if (on && options.session().kind !== 'verified') {
        options.signIn();
        return;
      }
      if (on && !adoptCurrentSurface()) return;
      ensureEditor();
      if (on && surface?.clipPaint && !editor?.draft) repaint(() => {});
      if (on && guard()) {
        updateControls();
        return;
      }
      if (on && applied) this.setApplied(false);
      const saved = root ? selectionOffsets(root, range) : null;
      if (setEditorSuggesting(on) && on && root) {
        root.focus({ preventScroll: true });
        restoreOffsets(root, saved);
      }
      updateControls();
    },
    setApplied(on) {
      if (on && (!sourceResult.ok || !root || !original)) return;
      if (editor?.suggesting && !setEditorSuggesting(false)) return;
      applied = on;
      if (original) original.hidden = on;
      if (!on) {
        appliedRoot?.remove();
        appliedRoot = undefined;
      }
      options.repaint();
      updateControls();
    },
    selectedSuggestion(range) {
      if (!appliedRoot) return null;
      for (const item of appliedRoot.querySelectorAll<HTMLElement>(
        '[data-sg]'
      )) {
        try {
          if (range.intersectsNode(item)) return item.getAttribute('data-sg');
        } catch {
          /* detached selection */
        }
      }
      return null;
    },
    restoreSelection() {
      if (root) restoreOffsets(root, selection);
    },
    retire() {
      if (root || editor?.draft || transport?.shouldWarnBeforeUnload) return;
      retired = true;
      window.clearTimeout(presenceRefreshTimer);
      doc.removeEventListener('selectionchange', selectionChanged);
      doc.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('focus', refreshVisible);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('beforeunload', beforeunload);
      editorChrome.remove();
      failureHost.remove();
    },
    destroy() {
      if (destroyed) return true;
      if (editor?.draft && !editor.commit()) return false;
      if (transport?.shouldWarnBeforeUnload) {
        if (
          root &&
          !host.contains(root) &&
          activeCommit &&
          transport.state.status !== 'not-posted'
        )
          releaseDetached = true;
        if (notice)
          notice.textContent =
            'Post or discard the suggestion before leaving this version.';
        return false;
      }
      destroyed = true;
      modeOffHold = undefined;
      window.clearTimeout(presenceRefreshTimer);
      editor?.destroy();
      root?.removeEventListener('beforeinput', stopInputDuringSend, true);
      root?.removeEventListener('paste', stopInputDuringSend, true);
      root?.removeEventListener('drop', stopInputDuringSend, true);
      root?.removeEventListener('keydown', stopInputDuringSend, true);
      root = null;
      original = undefined;
      surface = undefined;
      editor = undefined;
      doc.removeEventListener('selectionchange', selectionChanged);
      doc.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('focus', refreshVisible);
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('beforeunload', beforeunload);
      editorChrome.remove();
      failureHost.remove();
      return true;
    },
  };
}
