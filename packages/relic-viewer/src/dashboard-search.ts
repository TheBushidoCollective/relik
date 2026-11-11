/**
 * Search for the dashboard, over titles and over contents.
 *
 * Titles are in the page already, so they match as you type. Contents are
 * ciphertext on the service, so they can only be searched here: each relic this
 * browser holds a key for is fetched, decrypted and read as text, once, on the
 * first query, and the text stays in this page's memory until it closes. Nothing
 * is sent anywhere and nothing is written to storage.
 *
 * Only relics that render as text are read (markdown, code, HTML, JSX), and only
 * up to `CONTENT_SEARCH_MAX_BYTES` each, so a search never turns into a bulk
 * download of somebody's media. A relic that is skipped for that reason, has no
 * key in this browser, or fails to open is searched by title alone, and the
 * panel says how many.
 */

import {
  load,
  type RenderRoute,
  type ViewerDeps,
  type ViewerState,
} from './viewer.ts';
import type { KeyVault } from './relic-rows.ts';

/** Largest relic whose contents are read for search. */
export const CONTENT_SEARCH_MAX_BYTES = 4 * 1024 * 1024;

/** Relics opened at once while indexing. */
export const CONTENT_SEARCH_CONCURRENCY = 3;

const TEXT_ROUTES: Partial<Record<RenderRoute, true>> = {
  markdown: true,
  code: true,
  'sandboxed-html': true,
  'sandboxed-jsx': true,
};

export interface SearchRow {
  readonly relicId: string;
  readonly title: string;
  readonly fragment?: string | undefined;
}

export type IndexState = 'pending' | 'indexed' | 'skipped' | 'failed';

export interface RowMatch {
  readonly where: 'title' | 'content';
  /** A short stretch of the contents around the first hit, for `content`. */
  readonly snippet?: string | undefined;
}

export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/** Whitespace-separated terms, all of which must match. */
export function queryTerms(query: string): readonly string[] {
  return normalize(query)
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

const SNIPPET_RADIUS = 48;

/**
 * The text of an opened relic, twice: `lower` is what queries run against and
 * `display` is what a snippet quotes. Lowercasing can change a string's length
 * for a few scripts, so a snippet falls back to `lower` when the two disagree.
 */
export interface SearchText {
  readonly lower: string;
  readonly display: string;
}

function snippetAround(text: SearchText, terms: readonly string[]): string {
  let at = -1;
  let length = 0;
  for (const term of terms) {
    const index = text.lower.indexOf(term);
    if (index !== -1 && (at === -1 || index < at)) {
      at = index;
      length = term.length;
    }
  }
  if (at === -1) return '';
  const source =
    text.display.length === text.lower.length ? text.display : text.lower;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(source.length, at + length + SNIPPET_RADIUS);
  const piece = source.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${piece}${end < source.length ? '…' : ''}`;
}

/**
 * Whether a row answers the query, and where.
 *
 * Every term has to appear, in the title or in the contents. A row whose title
 * holds all of them is a title match even if the contents repeat them.
 */
export function matchRow(
  row: SearchRow,
  terms: readonly string[],
  contents: SearchText | undefined
): RowMatch | undefined {
  if (terms.length === 0) return { where: 'title' };
  const title = normalize(row.title);
  if (terms.every((term) => title.includes(term))) return { where: 'title' };
  if (contents === undefined) return undefined;
  const { lower } = contents;
  if (terms.every((term) => title.includes(term) || lower.includes(term))) {
    return { where: 'content', snippet: snippetAround(contents, terms) };
  }
  return undefined;
}

/** HTML is searched as the words a reader sees, not as its markup. */
function htmlText(source: string): string {
  return source
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/** The searchable text of an opened relic, or `undefined` when it has none. */
export function extractText(state: ViewerState): SearchText | undefined {
  if (state.kind !== 'ready') return undefined;
  const { route, document: doc } = state.view;
  if (TEXT_ROUTES[route] === undefined || doc === undefined || doc.truncated) {
    return undefined;
  }
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(doc.bytes);
  const display = (route === 'sandboxed-html' ? htmlText(raw) : raw).normalize(
    'NFKC'
  );
  return { lower: display.toLowerCase(), display };
}

/**
 * A vault that remembers nothing new. `load` stamps `lastOpenedAt` on every
 * relic it opens, and indexing the whole catalogue must not reshuffle a list
 * that is ordered by when somebody last opened each one.
 */
function readOnlyVault(vault: KeyVault): ViewerDeps['keyVault'] {
  return {
    remember: () => {},
    forget: () => {},
    recall: (relicId) => vault.recall?.(relicId),
    list: () => vault.list?.() ?? [],
    exportEntries: () => JSON.stringify({ version: 1, entries: [] }),
    importEntries: () => ({ added: 0, skipped: 0 }),
  };
}

export interface ContentIndex {
  /** The text of a relic, once indexed and when it has any. */
  text(relicId: string): SearchText | undefined;
  state(relicId: string): IndexState | undefined;
  /**
   * Reads every row not yet read. Resolves when the queue has drained;
   * `onChange` fires after each relic settles. Calling again while a drain
   * is running joins it.
   */
  ensure(rows: readonly SearchRow[], onChange: () => void): Promise<void>;
}

export function createContentIndex(deps: ViewerDeps): ContentIndex {
  const texts = new Map<string, SearchText>();
  const states = new Map<string, IndexState>();
  const inflight = new Map<string, Promise<void>>();

  const indexDeps: ViewerDeps = {
    ...deps,
    keyVault: readOnlyVault(deps.keyVault),
    stripFragment: () => {},
    onLargeOpen: async () => false,
  };

  const read = async (row: SearchRow): Promise<void> => {
    if (row.fragment === undefined) {
      states.set(row.relicId, 'skipped');
      return;
    }
    let state: ViewerState;
    try {
      state = await load(row.relicId, indexDeps, undefined, {
        fragment: row.fragment,
        maxBytes: CONTENT_SEARCH_MAX_BYTES,
      });
    } catch {
      states.set(row.relicId, 'failed');
      return;
    }
    if (state.kind !== 'ready') {
      const code = state.dead.code;
      states.set(
        row.relicId,
        code === 'version_too_large' || code === 'large_open_cancelled'
          ? 'skipped'
          : 'failed'
      );
      return;
    }
    const text = extractText(state);
    if (text === undefined) {
      states.set(row.relicId, 'skipped');
      return;
    }
    texts.set(row.relicId, text);
    states.set(row.relicId, 'indexed');
  };

  return {
    text: (relicId) => texts.get(relicId),
    state: (relicId) => states.get(relicId),
    async ensure(rows, onChange) {
      const queue = rows.filter(
        (row) => !states.has(row.relicId) && !inflight.has(row.relicId)
      );
      for (const row of queue) states.set(row.relicId, 'pending');
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < queue.length) {
          const row = queue[next++]!;
          const task = read(row).finally(() => inflight.delete(row.relicId));
          inflight.set(row.relicId, task);
          await task;
          onChange();
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(CONTENT_SEARCH_CONCURRENCY, queue.length) },
          worker
        )
      );
      await Promise.all(
        rows.flatMap((row) => {
          const running = inflight.get(row.relicId);
          return running === undefined ? [] : [running];
        })
      );
    },
  };
}

/** How many of these rows are, or will be, searched by title alone. */
export function titleOnlyCount(
  rows: readonly SearchRow[],
  index: ContentIndex
): number {
  let count = 0;
  for (const row of rows) {
    const state = index.state(row.relicId);
    if (state === 'skipped' || state === 'failed') count += 1;
  }
  return count;
}

export function pendingCount(
  rows: readonly SearchRow[],
  index: ContentIndex
): number {
  let count = 0;
  for (const row of rows) {
    if (index.state(row.relicId) === 'pending') count += 1;
  }
  return count;
}

export interface DashboardSearchHooks {
  /** Every row on the page, local first, as they are now. */
  readonly rows: () => readonly SearchRow[];
  /** Redraw the lists; they ask `match` about each row. */
  readonly repaint: () => void;
  readonly status: (text: string) => void;
}

export interface DashboardSearch {
  /** Sets the query. A blank one shows everything and reads nothing. */
  setQuery(query: string): void;
  /** Answers a row, or `undefined` when it does not match the query. */
  match(row: SearchRow): RowMatch | undefined;
  /** Picks up rows that arrived after the query was typed. */
  refresh(): void;
}

/**
 * The dashboard's search, kept out of the eager shell: `main.ts` loads this
 * module on the first keystroke, so a reader who never searches pays nothing.
 */
export function createDashboardSearch(
  deps: ViewerDeps,
  hooks: DashboardSearchHooks
): DashboardSearch {
  const index = createContentIndex(deps);
  let terms: readonly string[] = [];

  const updateStatus = (): void => {
    if (terms.length === 0) {
      hooks.status('');
      return;
    }
    const rows = hooks.rows();
    const pending = pendingCount(rows, index);
    const titleOnly = titleOnlyCount(rows, index);
    if (pending > 0) {
      hooks.status(`Reading contents, ${pending} left.`);
    } else if (titleOnly > 0) {
      hooks.status(
        `${titleOnly} of ${rows.length} relics were searched by title only: ` +
          'no key in this browser, too large, or not text.'
      );
    } else {
      hooks.status('');
    }
  };

  const startIndexing = (): void => {
    void index.ensure(hooks.rows(), () => {
      hooks.repaint();
      updateStatus();
    });
    updateStatus();
  };

  return {
    setQuery(query) {
      terms = queryTerms(query);
      hooks.repaint();
      if (terms.length > 0) startIndexing();
      updateStatus();
    },
    match: (row) => matchRow(row, terms, index.text(row.relicId)),
    refresh() {
      if (terms.length > 0) startIndexing();
    },
  };
}
