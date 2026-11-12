# Plan: suggested edits on relics

A reader who holds a relic link can propose a replacement for a span of text. Everyone else can see it, preview it applied, and stack their own. The publisher accepts through their agent, which applies the result to the source and republishes. The clickable mock is `mockup.html` beside this file. Every behaviour below is shown there.

Base: origin/main at bb8cf8b3. Citations were read in that tree.

## 1. Goal and PATH sentence

**PATH.** "A verified reader selects text on a markdown or code relic, proposes a replacement, and a second reader sees it as a mark, previews the stack of suggestions applied, and after the publisher's agent applies a batch and republishes, the same cards show what was accepted, superseded or outdated."

**Classes.** Markdown and code in the first slice. HTML text, JSX and OpenTimelineIO follow as separate specs (§9). Pdf, image, model, archive and binary stay comment only.

## 2. What the code already gives us

1. **A reader's key is read-only.** The link key decrypts content and seals comments. Only the machine holding the publish token republishes (`service.md` 1.7). A suggestion therefore cannot be a write to the relic. It is a comment.
2. **Unknown top level fields on a comment are reported, not refused.** `decryptComment` returns them in `unsupported_fields` (relic-format/src/comments.ts:412-453). A new field carries no version bump and cannot make an old reader say "altered in storage".
3. **Anchor kinds `text` and `pin` are frozen, and an unknown field inside a known kind is refused** (comments.ts:103-110, 467-502). So a suggestion must not widen the `quote` anchor. It rides beside it.
4. **Comment size.** Body 4096 bytes, quote 512, context 128 per side, sealed ciphertext 8192 base64url characters (comments.ts:62, 168-182).
5. **The republish gate.** Every open comment on any version must be addressed (an acknowledgement carrying `addresses`), replied to or resolved before `relic_republish` lands. The acknowledgement is stamped with the new version (relic-mcp/src/republish.ts, comments.ts). A suggestion is a comment, so the gate covers it with no new rule.
6. **The service never reads a comment.** It stores ciphertext plus clear routing fields (author, version, created_at, addresses). No server change is needed for suggestions.
7. **The relic content is the source.** The viewer renders markdown from the decrypted source with its own parser (`parseMarkdown`, `inlineRuns` in relic-viewer/src/markdown.ts), so source offsets are available at render time. The publishing client records a content digest per version (`content_sha256`, republish.ts), so "is my file the published bytes" is already answerable.

## 3. Decisions settled here

1. **A suggestion is a comment with a new sealed top level field `suggestion`, over an unchanged `quote` anchor.**
   - The anchor's `exact`, `prefix` and `suffix` hold a slice of the **source text**, not the rendered text. For markdown that can include `**` and link syntax.
   - Old readers show an ordinary comment on that quote, list `suggestion` in `unsupported_fields`, and show the comment's `body`, which the writer fills with a readable fallback sentence. The viewer adds the muted line "This page cannot show this suggestion as an edit."
   - No new anchor kind. No widening of a frozen kind.
2. **Payload.** `suggestion: { v: 1, mode: 'replace' | 'after' | 'before', replacement: string }`.
   - `replace`: the anchored text becomes `replacement`. An empty `replacement` deletes.
   - `after` and `before`: the anchored text stays, `replacement` is inserted next to it. `replacement` must be non-empty.
   - `replacement` is plain text, at most 2048 UTF-8 bytes, no control characters other than newline and tab. It is only ever written to the DOM with `textContent`.
   - Writers refuse a suggestion whose anchor is not `quote`, whose `exact` is empty, or whose sealed result would pass the 8192 character cap. Readers refuse unknown fields inside `suggestion` at `v: 1`, return an unknown `v` as unsupported, exactly as the OTIO anchor treats its version (comments.ts:630-650).
3. **Suggestions anchor to the published version's text, never to each other.** Inserted text exists only in preview, so it cannot be selected. Suggest-on-suggestion is out of scope. A reply in the thread covers it.
4. **One resolver, in `relic-format`.** The viewer previews with it and the publishing client applies with it, so they cannot disagree. It is the drift the comments module already exists to prevent (comments.ts:32-34).
5. **The browser never accepts.** It has no publish token. Acceptance is a publisher machine act. The viewer shows state only.
6. **Outcomes are sealed on the publisher's acknowledgement.** An acknowledgement that addresses a suggestion carries `suggestion_outcome: 'accepted' | 'superseded' | 'declined' | 'deferred'`. A reader honours it only on a row whose author is the literal `publisher` (the service stamps that from the publish token, service.md "Patch" paragraph). Anyone with the link can write a comment with `addresses`, so an outcome from any other author is displayed as an ordinary reply.
   - `accepted` shows "Accepted in vN", N being the acknowledgement's version.
   - `superseded` shows "Superseded by <name>'s suggestion", the name coming from the acknowledgement's note.
   - `declined` shows "Not taken" and the note.
   - `deferred` shows the card as pending with "Seen by the publisher, not applied yet".
   - "Outdated" is derived, never written: the resolver cannot find the quote in the current version and no outcome exists.
7. **Numbers.** Replacement 2048 bytes. Quote 512 bytes (existing). Suggestions are offered only on sources up to 1 MiB. The viewer resolves at most 200 pending suggestions per version and says "N more not shown" past that. A hostile link holder can therefore cost one resolver pass over 1 MiB per 200 comments, not more.
8. **Order is deterministic.** Sort key is `(start, end, created_at, comment_id)`. `created_at` is a service-supplied clear field, so a hostile operator could reorder suggestions that share a point or conflict. That changes preview order only. The publisher picks the winner of a conflict explicitly, so no outcome depends on it.
9. **Ambiguous or missing anchors never apply.** An occurrence is the quote plus its prefix and suffix. One occurrence resolves. None is `lost` and renders Outdated. More than one is `ambiguous` and renders "Apply manually". There is no first occurrence fallback, which is the one deliberate difference from the `text` anchor.

## 4. Stacking rules (the resolver's contract)

A replace or delete occupies the half open range `[s, e)`. An insertion occupies the point `p`, which is `s` for `before` and `e` for `after`.

| Pair | Result |
|---|---|
| Disjoint ranges | Both apply. |
| Ranges that touch (`e1 == s2`) | Both apply. |
| Insertion at a boundary of a range | Both apply. |
| Two insertions at the same point | Both apply, ordered by the sort key, flagged. |
| Insertion strictly inside a range (`s < p < e`) | Conflict. |
| Ranges that overlap by at least one character | Conflict. |
| One range inside another | Conflict. |
| Delete against replace on the same range | Conflict. |
| Same range, same mode, same replacement | Collapse into one entry, "also suggested by" the others. |

- A **conflict group** is a connected component of the conflict relation. Exactly one member can apply. The default member is the first by the sort key.
- `resolveSuggestions` returns, for each input, `status` (`resolved`, `ambiguous`, `lost`), its range, and its `group` (or none), plus the collapsed duplicates.
- `mergeSuggestions(source, resolved, choice)` applies one member per group plus every non-conflicting suggestion, from the end of the text backwards so offsets do not shift. It returns the text and, per input, `applied` or the reason it was skipped. `choice` maps a group id to a comment id. Giving two members of one group throws.
- **Property.** For any permutation of the inputs, the merged text is identical.

## 5. Contracts

```ts
// packages/relic-format/src/suggestions.ts (new, exported from index.ts)
export const SUGGESTION_REPLACEMENT_LIMIT_BYTES = 2048;
export const SUGGESTION_SOURCE_LIMIT_BYTES = 1_048_576;
export const SUGGESTION_RESOLVE_LIMIT = 200;

export type SuggestionMode = 'replace' | 'after' | 'before';
export interface SuggestionPayload {
  readonly v: 1;
  readonly mode: SuggestionMode;
  readonly replacement: string;
}
export type SuggestionOutcome = 'accepted' | 'superseded' | 'declined' | 'deferred';

export interface SuggestionInput {
  readonly id: string;
  readonly created_at: string;
  readonly author: string;
  readonly display_name: string | null;
  readonly exact: string;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly suggestion: SuggestionPayload;
}

export type ResolvedSuggestion =
  | { readonly status: 'resolved'; readonly id: string; readonly start: number;
      readonly end: number; readonly group: string | null;
      readonly also: readonly string[] }
  | { readonly status: 'ambiguous' | 'lost'; readonly id: string };

export function resolveSuggestions(source: string, inputs: readonly SuggestionInput[]): readonly ResolvedSuggestion[];
export function mergeSuggestions(source: string, resolved: readonly ResolvedSuggestion[],
  inputs: readonly SuggestionInput[], choice?: Readonly<Record<string, string>>):
  { readonly text: string; readonly skipped: readonly { id: string; reason: string }[] };
```

`comments.ts` gains `suggestion?: SuggestionPayload` and `suggestion_outcome?: SuggestionOutcome` on `CommentPlaintext`, adds both names to the known set so they stop appearing in `unsupported_fields`, validates them on write and on read, and refuses a `suggestion` on any anchor other than `quote`. Offsets are UTF-16 code unit indices into the source string, the unit the viewer's text nodes use.

**relic-mcp.**

- `relic_read_comments` returns, per comment, `suggestion`, and per suggestion the resolver's `status`, range and `group` against the current version's bytes.
- New tool `relic_apply_suggestions({ path, relic_id, accept: string[], write?: boolean })`.
  - It refuses with `source_changed_since_publish` unless the file's bytes match the digest the client recorded for the current version.
  - It refuses two ids from one conflict group.
  - By default it is a dry run that returns a unified diff and the list of applied ids. With `write: true` it writes the file. It never republishes.
  - Its description and output mark every replacement as third party text the agent must show the publisher in the diff, never obey.
- `relic_republish`'s `addresses` entries gain `outcome`. Where an addressed comment holds a suggestion and `outcome` is missing, the call refuses with `suggestion_outcome_required` before any network call, like the other acknowledgement refusals.
- The tool count moves from fifteen to sixteen in `publish.md` (the list at line 19 and the arithmetic paragraph at line 153). The `structuredContent` count in 1.3 is a different figure and does not change.

**Viewer.**

- `markdown.ts` emits `data-src-start` and `data-src-end` on every inline text run and every code line, so a DOM selection converts to a source slice by offset arithmetic. A markdown selection must sit inside one block in the first slice. A selection across blocks is refused with "Suggest within one paragraph." Code uses the existing text window line offsets and may span lines up to the 512 byte quote cap.
- New `relic-viewer/src/suggestions.ts` owns the mode, the preview, the chooser and the cards. It registers a `suggest` selection action beside Copy text and Comment and reuses the attached popover layer from `popover.ts`.
- Modes: **Reading** (default), **Suggesting**, and a Reading-only toggle **Show with suggestions applied**. The preview and the chooser state live in memory and vanish on reload.

## 6. UX (all in `mockup.html`)

- Marks are a quiet patina underline, never a highlighter. Clicking opens the card. Other people's suggestions are never applied unless the preview toggle is on.
- Suggesting mode shows others' suggestions as margin markers only, so a reader always writes against the real text.
- The composer shows the selection struck (Replace) or plain with a caret (Insert), the replacement field, a byte counter against 2048, an optional note, Cancel and Post. An empty Replace says it will delete.
- A selection over 512 bytes refuses with "Select a shorter passage. Suggestions replace up to 512 bytes of text." A selection in preview that lands on inserted text refuses with "That text is a proposed insertion. Reply in its thread to change it."
- A conflict group is one card, "3 suggestions on this sentence", with a radio choice. The reader's choice only drives their own preview.
- After the publisher republishes, cards show Accepted, Superseded, Outdated, Not taken or "Seen by the publisher, not applied yet". Pending suggestions whose quote survives stay pending.
- A comment-only sibling remains: Comment on the same selection still works.

## 7. Behaviour the republish gate imposes (said out loud)

Every open comment blocks a republish unless it is addressed or resolved, and a suggestion is a comment. After a partial accept the publisher's agent must also address the rest, with `deferred` for the ones to keep open. That is the existing discipline, applied to suggestions, and `relic_republish` already refuses with a list. It is not a new burden on the reader.

## 8. Slices and acceptance

One workstream, one PR, branch `feat/suggested-edits`. Slices are commits on that branch.

| Slice | Files | Acceptance |
|---|---|---|
| S1 Format | relic-format/src/suggestions.ts, comments.ts, index.ts, tests | Resolver tests: every row of §4 including both boundary cases; order independence over all permutations of a 6 suggestion set; `ambiguous` and `lost`; conflict groups with three members; duplicate collapse. Envelope tests: round trip; a reader built from main's `decryptComment` fixture reports `suggestion` in `unsupported_fields` and returns the body; refusal of a non `quote` anchor, an empty `exact`, a replacement over 2048 bytes, a control character, an unknown field inside `suggestion`. |
| S2 MCP | relic-mcp/src/{comments,republish,apply-suggestions,server}.ts, tests | Read returns resolver status. Apply refuses a changed source, refuses two members of one group, dry runs by default. Republish refuses `suggestion_outcome_required`. PATH.md gains the accept flow. |
| S3 Viewer | relic-viewer/src/{suggestions,markdown,main,comments}.ts, styles.css, tests | Unit tests for the DOM to source mapping across bold, link and code runs, and for refusals. Browser path `packages/relic-mcp/test/suggested-edits-path.ts`: publish a markdown and a code relic, post suggestions from two readers, reload, see marks, toggle preview, change a conflict choice and see the text change, republish with outcomes and see each card state. It must end `SUGGESTED_EDITS_PATH_OK`. |
| S4 Docs | docs/spec/{format,viewer,publish}.md, README | 3.13 amended for `suggestion` and `suggestion_outcome`; viewer 6.6 gains the modes; the sixteenth tool. |

**Negative control.** Run the browser path against a viewer built from origin/main. It must fail at the first Suggest edit assertion.

## 9. Not in this plan

- **HTML text.** The frame has no key and no comment bodies cross into it (§9 of the anchored popover plan). Suggestions need a frame protocol extension to report a text slice and to paint ins and del. Own spec.
- **JSX.** Only string literals are safe to edit. Follow code once HTML lands.
- **OpenTimelineIO.** Edits are structured operations anchored by clip identity (`otio-identity.ts`), so conflict means the same clip and the same operation. Own spec.
- Suggest-on-suggestion, bulk accept in the browser, per-suggestion email text.

## 10. What would prove this plan wrong

- Jason rejects the mock's Reading and Suggesting split, the preview toggle, or the conflict card. Stop and ask.
- Source offsets from `inlineRuns` cannot cover nested inline markup. Then markdown suggestions narrow to a single inline run and the mock's "Source:" sub-line goes.
- The 200 per version cap, the 1 MiB source cap or the 2048 byte replacement turn out to be wrong for real relics. They are constants in one file.
- A real relic's republish gate makes partial accepts miserable. Then `deferred` should be implicit when the agent omits an outcome for an open suggestion, and §7 changes.
