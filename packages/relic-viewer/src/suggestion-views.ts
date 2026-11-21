import type { CommentPlaintext } from '@relic/format';
import {
  SUGGESTION_RESOLVE_LIMIT,
  resolveSuggestions,
  suggestionStates,
  type ResolvedSuggestion,
  type SuggestionInput,
  type SuggestionStateInfo,
  type ThreadFact,
} from '@relic/format/suggestions';
import type { PendingSuggestion } from './suggest-draft.ts';

/** The plaintext and addresses must come from the decrypted comment, not its routing hint. */
export interface SuggestionThreadRow {
  readonly id: string;
  readonly author: string;
  readonly version: number;
  readonly created_at: string;
  readonly plaintext: CommentPlaintext;
  readonly resolution?: { readonly at: string; readonly by: string } | null;
}

export interface SuggestionConflict {
  readonly defaultId: string;
  /** Representative ids, in the resolver's default order. Duplicates live in `also`. */
  readonly members: readonly string[];
}

export type SuggestionLocation =
  | ResolvedSuggestion
  | { readonly status: 'unsupported' | 'capped'; readonly id: string };

export interface SuggestionView {
  readonly row: SuggestionThreadRow;
  readonly state: SuggestionStateInfo;
  readonly input: SuggestionInput | null;
  readonly location: SuggestionLocation;
  readonly representativeId: string;
  readonly conflict: SuggestionConflict | null;
  readonly also: readonly string[];
  readonly mine: boolean;
  /** Body of the publisher row that actually determined the state. */
  readonly answerNote: string | null;
}

export interface SuggestionViews {
  readonly source: string;
  readonly version: number;
  readonly currentVersion: number;
  readonly views: readonly SuggestionView[];
  readonly byId: ReadonlyMap<string, SuggestionView>;
  readonly inputs: readonly SuggestionInput[];
  readonly resolved: readonly ResolvedSuggestion[];
  /** Representatives to paint, including only the default of each conflict group. */
  readonly paint: readonly SuggestionView[];
  readonly pending: readonly PendingSuggestion[];
  readonly overflow: number;
  readonly overflowNote: string | null;
  readonly olderVersionReason: string | null;
}

/** Pick one placeable member per conflict group, without changing the group. */
export function placeableSuggestionPaint(
  views: SuggestionViews,
  accepts: (view: SuggestionView) => boolean
): SuggestionView[] {
  const seen = new Set<string>();
  const paint: SuggestionView[] = [];
  for (const result of views.resolved) {
    if (result.status !== 'resolved') continue;
    const group = result.group ?? result.id;
    if (seen.has(group)) continue;
    const view = views.byId.get(result.id);
    if (!view || !accepts(view)) continue;
    seen.add(group);
    paint.push(view);
  }
  return paint;
}

export const OLDER_VERSION_REASON =
  'Suggestions can only be made on the current version.';
export const SUGGESTION_NOT_FOUND =
  'This passage cannot be found in this version.';

function inputFor(row: SuggestionThreadRow): SuggestionInput | null {
  const anchor = row.plaintext.anchor;
  const suggestion = row.plaintext.suggestion;
  if (!suggestion || !anchor || anchor.kind !== 'source') return null;
  return {
    id: row.id,
    created_at: row.created_at,
    exact: anchor.exact,
    ...(anchor.prefix === undefined ? {} : { prefix: anchor.prefix }),
    ...(anchor.suffix === undefined ? {} : { suffix: anchor.suffix }),
    suggestion,
  };
}

function isOpen(state: SuggestionStateInfo['state']): boolean {
  return (
    state === 'pending' ||
    state === 'replied' ||
    state === 'deferred' ||
    state === 'unanswered'
  );
}

/** Build from all readable thread rows so newer publisher answers remain visible. */
export function buildSuggestionViews(
  source: string,
  rows: readonly SuggestionThreadRow[],
  version: number,
  currentVersion: number,
  reader: string | null = null,
  exclusiveInsertions?: ReadonlySet<number>
): SuggestionViews {
  const facts: ThreadFact[] = rows.map((row) => ({
    id: row.id,
    author: row.author,
    version: row.version,
    created_at: row.created_at,
    addresses: row.plaintext.addresses ?? null,
    suggestion_outcome: row.plaintext.suggestion_outcome ?? null,
    resolution: row.resolution ?? null,
    has_suggestion: row.plaintext.suggestion != null,
  }));
  const states = suggestionStates(facts, currentVersion);
  const answers = new Map(rows.map((row) => [row.id, row]));
  const candidates = rows
    .filter(
      (row) => row.version === version && row.plaintext.suggestion != null
    )
    .slice()
    .sort(
      (a, b) =>
        (a.created_at < b.created_at
          ? -1
          : a.created_at > b.created_at
            ? 1
            : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  // Pending suggestions take the bounded slots before settled history, so a
  // flood of old outcomes cannot hide a current reader's open suggestion.
  const eligible = candidates.filter((row) => inputFor(row) !== null);
  const open = eligible.filter((row) => {
    const state = states.get(row.id);
    return state !== undefined && isOpen(state.state);
  });
  const settled = eligible.filter((row) => {
    const state = states.get(row.id);
    return state === undefined || !isOpen(state.state);
  });
  const admitted = [...open, ...settled].slice(0, SUGGESTION_RESOLVE_LIMIT);
  const admittedIds = new Set(admitted.map((row) => row.id));
  const inputs = admitted.flatMap((row) => {
    const input = inputFor(row);
    return input === null ? [] : [input];
  });
  const resolved = resolveSuggestions(source, inputs, exclusiveInsertions);
  const locations = new Map<string, ResolvedSuggestion>();
  const groups = new Map<string, string[]>();
  for (const result of resolved) {
    locations.set(result.id, result);
    if (result.status !== 'resolved') continue;
    for (const id of result.also) locations.set(id, result);
    if (result.group !== null) {
      const members = groups.get(result.group) ?? [];
      members.push(result.id);
      groups.set(result.group, members);
    }
  }
  const byId = new Map<string, SuggestionView>();
  for (const row of candidates) {
    const state = states.get(row.id);
    if (!state) continue;
    const input = inputFor(row);
    const found = locations.get(row.id);
    const location: SuggestionLocation = found ?? {
      status: input === null ? 'unsupported' : 'capped',
      id: row.id,
    };
    const representativeId = found?.id ?? row.id;
    const group = found?.status === 'resolved' ? found.group : null;
    const members = group === null ? undefined : groups.get(group);
    const answer =
      state.answer === null ? undefined : answers.get(state.answer.comment_id);
    byId.set(row.id, {
      row,
      state,
      input,
      location,
      representativeId,
      conflict:
        group !== null && members ? { defaultId: group, members } : null,
      also:
        found?.status === 'resolved' && found.id === row.id ? found.also : [],
      mine:
        reader !== null && row.author.toLowerCase() === reader.toLowerCase(),
      answerNote: answer?.plaintext.body || null,
    });
  }
  const views = candidates.flatMap((row) => {
    const view = byId.get(row.id);
    return view ? [view] : [];
  });
  const paint: SuggestionView[] = [];
  for (const result of resolved) {
    if (result.status !== 'resolved') continue;
    if (result.group !== null && result.group !== result.id) continue;
    const view = byId.get(result.id);
    if (view) paint.push(view);
  }
  const pending: PendingSuggestion[] = [];
  for (const view of views) {
    if (
      !isOpen(view.state.state) ||
      view.location.status !== 'resolved' ||
      !view.input
    )
      continue;
    pending.push({
      id: view.row.id,
      author: view.row.author,
      displayName: view.row.plaintext.display_name ?? view.row.author,
      version: view.row.version,
      start: view.location.start,
      end: view.location.end,
      inserted: view.input.suggestion.replacement,
    });
  }
  const overflow = eligible.length - admittedIds.size;
  return {
    source,
    version,
    currentVersion,
    views,
    byId,
    inputs,
    resolved,
    paint,
    pending,
    overflow,
    overflowNote:
      overflow > 0
        ? `${overflow} more suggestions are in the comments panel.`
        : null,
    olderVersionReason: version < currentVersion ? OLDER_VERSION_REASON : null,
  };
}
