import type { SuggestionOutcome, SuggestionPayload } from './comments.ts';

import { SUGGESTION_SOURCE_LIMIT_BYTES } from './line-endings.ts';
export {
  SUGGESTION_SOURCE_LIMIT_BYTES,
  suggestionSourceFor,
  normalizeCrLf,
  restoreCrLf,
} from './line-endings.ts';
export const SUGGESTION_RESOLVE_LIMIT = 200;

export function suggestionSource(
  bytes: Uint8Array
):
  | { ok: true; source: string; bom: boolean }
  | { ok: false; reason: 'too_large' | 'not_utf8' | 'has_cr' | 'has_nul' } {
  if (bytes.byteLength > SUGGESTION_SOURCE_LIMIT_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: 'not_utf8' };
  }
  if (source.includes('\r')) return { ok: false, reason: 'has_cr' };
  if (source.includes('\0')) return { ok: false, reason: 'has_nul' };
  return { ok: true, source, bom };
}

export function locate(
  source: string,
  exact: string,
  prefix = '',
  suffix = ''
):
  | { status: 'resolved'; start: number; end: number }
  | { status: 'ambiguous' | 'lost' } {
  const target = prefix + exact + suffix;
  const found = source.indexOf(target);
  if (found === -1) return { status: 'lost' };
  // indexOf clamps its position to the source length, including for ''.
  if (target === '' && source === '') {
    return { status: 'resolved', start: 0, end: 0 };
  }
  if (source.indexOf(target, found + 1) !== -1) {
    return { status: 'ambiguous' };
  }
  const start = found + prefix.length;
  return { status: 'resolved', start, end: start + exact.length };
}

export interface SuggestionInput {
  readonly id: string;
  readonly created_at: string;
  readonly exact: string;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly suggestion: SuggestionPayload;
}

export type ResolvedSuggestion =
  | {
      readonly status: 'resolved';
      readonly id: string;
      readonly start: number;
      readonly end: number;
      readonly group: string | null;
      readonly also: readonly string[];
    }
  | { readonly status: 'ambiguous' | 'lost'; readonly id: string };

type Candidate = {
  input: SuggestionInput;
  start: number;
  end: number;
  also: string[];
};

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    a.start - b.start ||
    a.end - b.end ||
    compareStrings(a.input.created_at, b.input.created_at) ||
    compareStrings(a.input.id, b.input.id)
  );
}

function conflicts(
  a: Candidate,
  b: Candidate,
  exclusiveInsertions?: ReadonlySet<number>
): boolean {
  const aInsertion = a.start === a.end;
  const bInsertion = b.start === b.end;
  if (aInsertion && bInsertion)
    return a.start === b.start && exclusiveInsertions?.has(a.start) === true;
  if (aInsertion) return b.start < a.start && a.start < b.end;
  if (bInsertion) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

export function resolveSuggestions(
  source: string,
  inputs: readonly SuggestionInput[],
  exclusiveInsertions?: ReadonlySet<number>
): readonly ResolvedSuggestion[] {
  const candidates: Candidate[] = [];
  const unresolved: ResolvedSuggestion[] = [];
  for (const input of inputs) {
    const found = locate(source, input.exact, input.prefix, input.suffix);
    if (found.status !== 'resolved') {
      unresolved.push({ status: found.status, id: input.id });
      continue;
    }
    const start = input.suggestion.mode === 'after' ? found.end : found.start;
    const end = input.suggestion.mode === 'replace' ? found.end : start;
    candidates.push({ input, start, end, also: [] });
  }
  candidates.sort(compareCandidates);
  unresolved.sort((a, b) => compareStrings(a.id, b.id));

  // Collapse duplicates before building the conflict graph. The first by the
  // sort key owns the entry, and aliases remain available to an explicit pick.
  const unique: Candidate[] = [];
  for (const candidate of candidates) {
    const duplicate = unique.find(
      (other) =>
        other.start === candidate.start &&
        other.end === candidate.end &&
        other.input.suggestion.mode === candidate.input.suggestion.mode &&
        other.input.suggestion.replacement ===
          candidate.input.suggestion.replacement
    );
    if (duplicate) duplicate.also.push(candidate.input.id);
    else unique.push(candidate);
  }

  const parents = unique.map((_, index) => index);
  const root = (index: number): number => {
    while (parents[index] !== index) {
      const parent = parents[index];
      if (parent === undefined) throw new Error('invalid suggestion graph');
      index = parent;
    }
    return index;
  };
  for (let i = 0; i < unique.length; i++) {
    const first = unique[i];
    if (!first) continue;
    for (let j = i + 1; j < unique.length; j++) {
      const second = unique[j];
      if (!second || !conflicts(first, second, exclusiveInsertions)) continue;
      const a = root(i);
      const b = root(j);
      if (a !== b) parents[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const sizes = new Map<number, number>();
  for (let i = 0; i < unique.length; i++) {
    const groupRoot = root(i);
    sizes.set(groupRoot, (sizes.get(groupRoot) ?? 0) + 1);
  }
  const resolved: ResolvedSuggestion[] = unique.map((candidate, index) => {
    const groupRoot = root(index);
    return {
      status: 'resolved',
      id: candidate.input.id,
      start: candidate.start,
      end: candidate.end,
      group:
        (sizes.get(groupRoot) ?? 0) > 1
          ? (unique[groupRoot]?.input.id ?? null)
          : null,
      also: candidate.also,
    };
  });
  return [...resolved, ...unresolved];
}

type AppliedSuggestion = { id: string; start: number; end: number };
type SkippedSuggestion = {
  id: string;
  reason: 'conflict' | 'ambiguous' | 'lost' | 'not_picked';
};

export function mergeSuggestions(
  source: string,
  resolved: readonly ResolvedSuggestion[],
  inputs: readonly SuggestionInput[],
  pick: 'defaults' | ReadonlySet<string>
): {
  text: string;
  applied: readonly AppliedSuggestion[];
  skipped: readonly SkippedSuggestion[];
} {
  const inputsById = new Map(inputs.map((input) => [input.id, input]));
  const entries: Candidate[] = [];
  const byId = new Map<string, ResolvedSuggestion>();
  for (const result of resolved) {
    byId.set(result.id, result);
    if (result.status !== 'resolved') continue;
    for (const id of result.also) byId.set(id, result);
    const input = inputsById.get(result.id);
    if (!input) throw new Error(`missing suggestion input: ${result.id}`);
    entries.push({
      input,
      start: result.start,
      end: result.end,
      also: [...result.also],
    });
  }
  entries.sort(compareCandidates);

  const selectedGroups = new Map<string, string>();
  const selectedEntries = new Map<string, readonly string[]>();
  if (pick === 'defaults') {
    for (const entry of entries) {
      const result = byId.get(entry.input.id);
      if (!result || result.status !== 'resolved') continue;
      if (result.group !== null) {
        if (selectedGroups.has(result.group)) continue;
        selectedGroups.set(result.group, result.id);
      }
      selectedEntries.set(result.id, [result.id, ...result.also]);
    }
  } else {
    for (const id of pick) {
      const result = byId.get(id);
      if (!result || result.status !== 'resolved' || !inputsById.has(id)) {
        throw new Error(`suggestion did not resolve: ${id}`);
      }
      if (result.group !== null) {
        const selected = selectedGroups.get(result.group);
        if (selected !== undefined && selected !== result.id) {
          throw new Error(`conflicting suggestions in group: ${result.group}`);
        }
        selectedGroups.set(result.group, result.id);
      }
      const ids = selectedEntries.get(result.id) ?? [];
      selectedEntries.set(result.id, [...ids, id]);
    }
  }

  let cursor = source.length;
  const chunks: string[] = [];
  const applied: AppliedSuggestion[] = [];
  const skipped: SkippedSuggestion[] = [];
  for (const result of resolved) {
    if (result.status !== 'resolved') {
      skipped.push({ id: result.id, reason: result.status });
    }
  }
  for (const entry of entries) {
    const result = byId.get(entry.input.id);
    if (!result || result.status !== 'resolved') continue;
    const selected = selectedEntries.get(result.id) ?? [];
    for (const id of [result.id, ...result.also]) {
      if (selected.includes(id)) {
        applied.push({ id, start: result.start, end: result.end });
      } else {
        const other =
          result.group === null ? undefined : selectedGroups.get(result.group);
        skipped.push({
          id,
          reason:
            other !== undefined && other !== result.id
              ? 'conflict'
              : 'not_picked',
        });
      }
    }
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || !selectedEntries.has(entry.input.id)) continue;
    chunks.push(
      source.slice(entry.end, cursor),
      entry.input.suggestion.replacement
    );
    cursor = entry.start;
  }
  chunks.push(source.slice(0, cursor));
  return { text: chunks.reverse().join(''), applied, skipped };
}

export interface ThreadFact {
  readonly id: string;
  readonly author: string;
  readonly version: number;
  readonly created_at: string;
  /** Decrypted from the sealed comment, never the clear routing hint. */
  readonly addresses: string | null;
  readonly suggestion_outcome: SuggestionOutcome | null;
  readonly resolution: { readonly at: string; readonly by: string } | null;
  readonly has_suggestion: boolean;
}

export interface SuggestionStateInfo {
  readonly state:
    | SuggestionOutcome
    | 'withdrawn'
    | 'closed'
    | 'replied'
    | 'pending'
    | 'unanswered';
  readonly text: string;
  readonly answer: {
    readonly comment_id: string;
    readonly version: number;
    readonly outcome: SuggestionOutcome | null;
  } | null;
}

function laterFact(a: ThreadFact, b: ThreadFact): boolean {
  return (
    a.version > b.version ||
    (a.version === b.version &&
      (compareStrings(a.created_at, b.created_at) > 0 ||
        (a.created_at === b.created_at && compareStrings(a.id, b.id) > 0)))
  );
}

export function suggestionStates(
  facts: readonly ThreadFact[],
  currentVersion: number
): ReadonlyMap<string, SuggestionStateInfo> {
  const outcomes = new Map<string, ThreadFact>();
  const replies = new Map<string, ThreadFact>();
  for (const fact of facts) {
    if (fact.author !== 'publisher' || fact.addresses === null) continue;
    const target = fact.suggestion_outcome === null ? replies : outcomes;
    const previous = target.get(fact.addresses);
    if (!previous || laterFact(fact, previous))
      target.set(fact.addresses, fact);
  }
  const states = new Map<string, SuggestionStateInfo>();
  for (const fact of facts) {
    if (!fact.has_suggestion) continue;
    const outcome = outcomes.get(fact.id);
    if (outcome && outcome.suggestion_outcome !== null) {
      const state = outcome.suggestion_outcome;
      const text =
        state === 'accepted'
          ? `Accepted in v${outcome.version}`
          : state === 'superseded'
            ? 'Superseded'
            : state === 'declined'
              ? 'Not taken'
              : 'Seen by the publisher, not applied yet';
      states.set(fact.id, {
        state,
        text,
        answer: {
          comment_id: outcome.id,
          version: outcome.version,
          outcome: state,
        },
      });
    } else if (fact.resolution?.by === fact.author) {
      states.set(fact.id, {
        state: 'withdrawn',
        text: 'Withdrawn',
        answer: null,
      });
    } else if (fact.resolution?.by === 'publisher') {
      states.set(fact.id, {
        state: 'closed',
        text: 'Closed by the publisher',
        answer: null,
      });
    } else {
      const reply = replies.get(fact.id);
      if (reply) {
        states.set(fact.id, {
          state: 'replied',
          text: 'The publisher replied',
          answer: {
            comment_id: reply.id,
            version: reply.version,
            outcome: null,
          },
        });
      } else if (fact.version < currentVersion) {
        states.set(fact.id, {
          state: 'unanswered',
          text: 'No answer from the publisher is visible to you',
          answer: null,
        });
      } else {
        states.set(fact.id, {
          state: 'pending',
          text: 'Suggested',
          answer: null,
        });
      }
    }
  }
  return states;
}

function fallbackExcerpt(value: string): string {
  const text = value.replace(/[\n\t]/g, ' ');
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= 96) return text;
  let excerpt = '';
  let bytes = 0;
  // Reserve three bytes for the ellipsis and never split a code point.
  for (const char of text) {
    const length = encoder.encode(char).byteLength;
    if (bytes + length > 93) break;
    excerpt += char;
    bytes += length;
  }
  return `${excerpt}…`;
}

export function suggestionFallbackBody(
  exact: string,
  s: SuggestionPayload
): string {
  const quoted = `"${fallbackExcerpt(exact)}"`;
  const replacement = `"${fallbackExcerpt(s.replacement)}"`;
  const edit =
    s.mode === 'replace'
      ? s.replacement === ''
        ? `delete ${quoted}`
        : `replace ${quoted} with ${replacement}`
      : `insert ${replacement} ${s.mode} ${quoted}`;
  return `Suggested edit: ${edit}. A current Relik viewer shows it in place.`;
}
