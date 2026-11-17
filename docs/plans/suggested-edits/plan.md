# Spec: inline suggested edits, tracked changes and live presence on relics

This replaces the plan merged in PR #164. It is based on origin/main efa3afee. None of the merged plan is implemented: the selection offer has only Copy text, Comment and dismiss (popover.ts:641-696), and the viewer contains no suggestion code.

## 1. PATH sentence

**PATH.** "A signed-in reader turns on Suggesting on a markdown, code, HTML or JSX relic and types straight into the text. A second reader on the same relic sees the first reader's cursor and an incoming-change marker on that passage, but never the typed text. When the first reader leaves the passage, switches away or closes the page, the change is sealed and posted, and it appears in the second reader's page as struck and inserted text. The second reader can reply from the tracked change or from the applied view. After the publisher's agent applies a batch and republishes, both readers see each change's outcome."

Markdown and code render in the viewer's own DOM (text-views.ts:6-37). HTML and JSX render in the sandboxed frame (main.ts:1394-1405). PDF, image, model, media, archive, binary and OTIO stay comment-only.

## 2. Settled decisions

### 2.1 Settled by Jason (fact)

1. **Typing.** Readers suggest by typing inline, as in Docs' Suggesting mode. There is no select-then-compose card.
2. **Display.** Other readers' suggestions render inline on the real document as tracked changes: old text struck, new text inserted. A toggle shows the clean "everything applied" result. This reverses the merged plan §6, which used margin markers and showed changes only in preview.
3. **Replying.** Hovering a tracked change on the real document opens its thread. Selecting edited text in the applied view also offers Reply.
4. **Commit.** A draft is live in the writer's own view while they type. It is sealed and posted when the writer leaves the element (blur) or closes the page (pagehide). Other readers see an incoming-change indicator and live cursors, never keystrokes. Esc cancels the draft.
5. **HTML and JSX are in scope**, through an extended frame protocol. The host keeps the key and the comments. The frame reports edits and paints the ins/del marks the host specifies. Only static text is editable. Text produced by JSX expressions, markup and attributes is read-only, with a clear refusal.
6. **Kept from the merged plan:**
   - A suggestion is a sealed comment with a `suggestion` field over a `quote` anchor on **source** text.
   - One resolver in relic-format serves both the viewer's preview and the publisher's apply.
   - The browser never accepts a suggestion. The publisher's agent applies and republishes with `suggestion_outcome`.
   - The service stays zero-knowledge.
   - The stacking rules (merged §4) and the occurrence rule (merged §3.9) do not change.

### 2.2 Decided here (these follow from 2.1 and the code)

- **a. Who can suggest, and where.** Suggesting needs a verified session, like Comment: the service stamps the author from the session or the publish token (app.ts:3727-3730, 4069-4087). Turning it on while signed out opens the existing sign-in. Suggesting works only on the current version; older versions show suggestions read-only.
- **b. The element is one block.**
  - Markdown: a paragraph, heading, list item, table cell or fenced code block.
  - Code relics: the whole file, where "leaving" means the caret leaves the draft's lines.
  - HTML and JSX: the nearest block-level ancestor.
  - A draft never crosses blocks.
- **c. A draft is one coalesced change** (a struck range plus inserted text). It posts as one `replace`, or as `after`/`before` for a pure insertion, with the smallest quote that resolves uniquely (3.4).
- **d. Your own pending suggestion is edited, not duplicated.** A draft that overlaps or touches your own pending suggestion on the same version, before the publisher has answered it, PATCHes that suggestion. The edit route is author-only (app.ts:3994-4026). Reverting the text to the original deletes the suggestion.
- **e. Every commit shows a receipt in Relic's own chrome**: the exact struck and inserted text, a Source line when markup is involved, and Undo. Undo is DELETE for a new suggestion, or a PATCH back to the previous text for an edit. The receipt never takes focus.
- **f. Remote updates never change the DOM inside the block holding your active draft.** Incoming changes that overlap your draft fold into a badge on it until you commit or cancel.
- **g. No note field.** Context goes in a reply. The body is a generated fallback sentence for older viewers.
- **h. Others learn of a post** from a presence ping (`posted`), on refocus or when the tab becomes visible again (throttled), or through the existing manual refresh. There is no polling.
- **i. Overlapping other readers' work.** Typing inside someone else's inserted text is refused with "That text is Priya's suggestion. Reply to it instead." Typing over text someone else struck is allowed and forms a conflict group under the stacking rules.
- **j. The applied view is read-only.** It offers Copy, and Reply on edited text. Comment and Suggest are off there, because their anchors must be on the published text.

### 2.3 Corrections to the brief and the merged plan

- **Rate limit.** The brief says comment writes are rate-limited by PR #152. In fact PR #152 *removed* the per-IP comment write limiter. POST and PATCH have no write limit (app.ts:3699-3819, 3942-4061), and the limiter that remains is process-local (ratelimit.ts:171-185).
  - docs/spec/service.md:150 is correct; line :565 is stale.
  - Only the notification limiter remains: one email per recipient per relic per 10 minutes, plus a global fuse (app.ts:7257-7260; config.ts:232-245).
- **Merged §2.7, "source offsets are available at render time," is false.**
  - `inline()` rewrites already-escaped text through a series of regex passes (markdown.ts:44-92).
  - `renderBlock` emits no positions (markdown.ts:319-357).
  - Paragraphs are trimmed lines joined with a space (markdown.ts:216, 311), and CRLF is normalized before parsing (markdown.ts:208).
  - No `data-src-*` attribute exists anywhere. A source-aware renderer is new work (S3).
- **Merged §3.1, "old readers show an ordinary comment on that quote," holds only when the quote contains no markup.** Viewers match quote anchors against rendered DOM text (annotate-quote.ts:118-159; comments.ts:1128-1264; frame: sandbox.ts:381-523). A source quote containing `**`, link syntax, tags or entities places no mark in an older viewer. It still appears in the thread with its fallback body.
- **Anchored-popover §9, "no comment body crosses into the frame," needs restating.**
  - Quote text already crosses into the frame for painting (annotate-frame.ts:595-620), and selected text already crosses back (annotate-frame.ts:282-302).
  - Inline tracked changes in a frame require replacement text to cross as well. The restated invariant is in §4.1.
- **Merged §2.6, "no server change," still holds for suggestions. Presence does need a new relay**, because:
  - Comment threads load once, by GET (main.ts:8335-8367; comments.ts:663-711).
  - There is no SSE, WebSocket or polling in app.ts or the viewer.
  - The service runs up to 4 instances (cloud-run-service variables.tf:66-76) with process-local state (ratelimit.ts:171-185).
- **Adjacent findings, separate work, not in this PR:**
  - viewer.md §3.1 says markdown renders on the usercontent origin, but the host renders it (text-views.ts:6-13).
  - viewer.md §4 describes a shim, a nonce and an exact targetOrigin that the code does not use; it posts with `'*'` (main.ts:1407-1412).
  - docs/design/topology.md assumes Cloud Armor, and the Terraform has none (resource.google_compute_lb.service.tf:32-47).

## 3. Contracts

### 3.1 Sealed payload and anchor coordinates

```ts
// packages/relic-format/src/suggestions.ts (new; exported from index.ts)
export const SUGGESTION_REPLACEMENT_LIMIT_BYTES = 2048;
export const SUGGESTION_SOURCE_LIMIT_BYTES = 1_048_576;
export const SUGGESTION_RESOLVE_LIMIT = 200;
export type SuggestionMode = 'replace' | 'after' | 'before';
export interface SuggestionPayload {
  readonly v: 1;
  readonly mode: SuggestionMode;
  /** Source text in the relic's own syntax: entity-escaped for html and jsx, literal for markdown and code. */
  readonly replacement: string;
  /** 22 base64url characters, minted per draft by the writer; makes retries idempotent. */
  readonly draft: string;
}
export type SuggestionOutcome = 'accepted' | 'superseded' | 'declined' | 'deferred';
```

`CommentPlaintext` (comments.ts:212-240) gains `suggestion?` and `suggestion_outcome?`. Both join the known-field set, so they never appear in `unsupported_fields` (comments.ts:411-453).

**Writers refuse:**
- an anchor that is not `quote`;
- an empty `exact`;
- a replacement over 2048 UTF-8 bytes;
- control characters other than LF and TAB;
- a `replace` whose replacement equals `exact`;
- an `after` or `before` with an empty replacement;
- a `draft` that does not match `^[A-Za-z0-9_-]{22}$`;
- unknown fields inside `suggestion`;
- a sealed result over 8192 characters (comments.ts:169).

**Readers** report an unknown `v` as unsupported. An unknown field inside v1 is malformed (refuseExtra, comments.ts:478-507).

**`body`** is a fallback for older viewers: `Suggested edit: "<exact, 80 chars>" → "<rendered replacement, 80 chars>"`.

**Anchor coordinates.** A `quote` anchor on a comment that carries `suggestion` is in **source** coordinates, for the version the comment is stamped with. Every other `quote` anchor stays in rendered coordinates. Prefix and suffix are each up to 128 bytes of source (comments.ts:182).

### 3.2 Resolver

```ts
export type SourceClass = 'markdown' | 'code' | 'html' | 'jsx';
export type RefuseReason = 'splits_markup' | 'replacement_markup' | 'replacement_invalid';
export type ResolvedSuggestion =
  | { readonly status: 'resolved'; readonly id: string; readonly start: number; readonly end: number;
      readonly group: string | null; readonly also: readonly string[] }
  | { readonly status: 'ambiguous' | 'lost'; readonly id: string }
  | { readonly status: 'refused'; readonly id: string; readonly reason: RefuseReason };
export function resolveSuggestions(cls: SourceClass, source: string,
  inputs: readonly SuggestionInput[]): readonly ResolvedSuggestion[];
export function mergeSuggestions(source: string, resolved: readonly ResolvedSuggestion[],
  inputs: readonly SuggestionInput[], choice?: Readonly<Record<string, string>>): {
  readonly text: string;
  /** Where each applied suggestion's inserted text sits in `text`; drives Reply in the applied view. */
  readonly applied: readonly { readonly id: string; readonly start: number; readonly end: number }[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
};
```

`SuggestionInput` is unchanged from the merged §5. `refused` comes from `checkReplace` (3.3). Property: every permutation of the inputs yields the same `text` and `applied`.

### 3.3 Source text model

```ts
// packages/relic-format/src/source-text.ts (new): code segments, checkReplace, encode/decode, HTML tag scanner.
// packages/relic-format/src/html-segments.ts (new): HTML segments; the only importer of the generated html-entities.ts.
// Markdown segments come from relic-viewer/src/markdown.ts and JSX segments from relic-viewer/src/jsx-text.ts, in the same shape.
export interface TextSegment {
  readonly text: string;            // exactly the data the DOM text node holds
  readonly start: number;           // UTF-16 source offsets
  readonly end: number;
  readonly map?: readonly number[]; // source offset for each index 0..text.length; omitted when text === source.slice(start, end)
  readonly block: number;           // markdown and code: block id; html and jsx: -1 (the frame decides blocks)
}
export interface SegmentPos { readonly seg: number; readonly at: number }
export function codeSegments(source: string): readonly TextSegment[];
export function htmlSegments(source: string): readonly TextSegment[];
export function toSourceRange(segs: readonly TextSegment[], from: SegmentPos, to: SegmentPos): { start: number; end: number };
export function checkReplace(cls: SourceClass, source: string, start: number, end: number, replacement: string): RefuseReason | null;
export function encodeTyped(cls: SourceClass, typed: string): string;
export function decodeReplacement(cls: SourceClass, replacement: string): string;
```

**Segment rules by class:**
- **code.** One segment for the whole body. `buildCodeTable` passes `highlightCode(source)` through innerHTML (text-views.ts:19-37), so the segment text applies the HTML parser's normalization: CRLF and CR become LF, and NUL is dropped. `map` exists only when CR or NUL occur. Each fenced block inside markdown is its own segment.
- **html.** Segments are the text outside tags, comments, doctype and CDATA, and outside the contents of script, style, template, noscript, textarea, title, xmp, iframe, noembed, noframes and plaintext.
  - Character references are decoded with the full WHATWG table (generated and committed; the viewer loads html-segments lazily).
  - A LF directly after a pre, listing or textarea start tag is dropped, and CR is normalized.
  - Whitespace-only segments and segments containing NUL are omitted.
- **jsx** (viewer only).
  - Segments are the JSXText tokens from Sucrase's parser, cleaned with the JSX whitespace rule and decoded.
  - A segment whose text equals any string or template literal in the module is omitted: it cannot be told apart from text produced by an expression.
  - [UNGROUNDED] Sucrase's parser token API is unverified because node_modules is not installed in this checkout. S4 verifies it first and pins sucrase to an exact version.
- **markdown** (viewer only).
  - A segment for every inline text run.
  - A segment for every synthetic join space, mapped to the newline and indent it replaced.
  - A segment for every fenced code body.
  - Delimiter pairs (`**`, `*`, `~~`, backticks, link brackets) are recorded so balance can be checked.

**`checkReplace` by class:**
- **markdown:** null. Balance is enforced in the viewer; markdown cannot inject markup because the renderer escapes first (markdown.ts:1-19).
- **code:** null.
- **html:**
  - `replacement_markup` if the replacement contains `<`, or contains any `&` that does not start `&amp; &lt; &gt; &quot; &#39; &nbsp; &#N; &#xH;`.
  - `splits_markup` if [start,end) cuts a tag, a comment or a raw-text element, or holds unbalanced tags (void elements exempt).
- **jsx:**
  - `replacement_markup` if the replacement contains `<>{}` or a bare `&`.
  - `splits_markup` if `exact` contains `<>{}`.

**`encodeTyped`:** for html, `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`; jsx additionally maps `{`→`&#123;` and `}`→`&#125;`; every other class is identity. `decodeReplacement` is the inverse.

**Fail closed.**
- In the host DOM, every `[data-seg]` element's text must equal `segs[i].text`. Any mismatch makes Suggesting unavailable for that relic, and the reason is shown.
- In the frame, a node maps to a segment only by exact text equality (3.6).

### 3.4 Editor engine and draft lifecycle

```ts
// packages/relic-viewer/src/suggest-editor.ts (new; dependency-free; bundled into the viewer and the frame,
// like rendered-tree.ts, rendered-tree.ts:1-14)
export type EditRefusal = 'not-source-text' | 'crosses-blocks' | 'crosses-formatting'
  | 'others-insertion' | 'too-long' | 'quote-too-long' | 'newline-needs-markup';
export interface DraftState {
  readonly draft: string;          // ^[A-Za-z0-9_-]{1,64}$
  readonly from: SegmentPos;       // struck range, rendered coordinates
  readonly to: SegmentPos;         // from === to for a pure insertion
  readonly inserted: string;       // rendered text typed
  readonly caret: SegmentPos;
}
export interface SuggestEditorHost {
  segmentAt(node: Text): number | undefined;
  editable(seg: number): boolean;
  blockOf(seg: number, node: Text): string;
  insertionOwner(node: Node): string | undefined;   // comment id when inside someone else's <ins>
  update(s: DraftState): void; commit(s: DraftState): void; cancel(draft: string): void;
  refuse(reason: EditRefusal, rect?: { left: number; top: number; width: number; height: number }): void;
}
export function mountSuggestEditor(root: HTMLElement | Document, host: SuggestEditorHost,
  opts: { readonly newline: 'paragraph' | 'line' | 'refuse'; readonly tab: boolean }):
  { setOn(on: boolean): void; commitNow(): void; cancel(): void; dispose(): void };
```

**Editing surface.**
- Editing is on only while Suggesting is on.
- In the host, `article.prose` or `pre.code-body` gets contenteditable. The frame uses `document.designMode = 'on'` so author attributes are never touched.
- Every cancelable `beforeinput` is intercepted. Text insertion, deletes, and paste or drop (as plain text) update the draft model. The engine draws the draft as `<del data-sg-owned>` over the struck text and `<ins data-sg-owned>` after it, then restores the caret.
- Formatting and history inputs are refused. Undo inside a draft is local to that draft.

**Keys and edits.**
- Typing over a selection strikes it.
- Backspace at the draft's left edge extends the strike to the left; Delete at the right edge extends it to the right.
- Enter: markdown inserts a paragraph break (`\n\n` in source), code inserts `\n`, and html and jsx refuse it (`newline-needs-markup`).
- Tab inserts a tab only inside a code draft.

**IME.** Composition runs natively only inside the draft's own `<ins>`, which is created at the caret on `keydown` or `compositionstart`. Composed text that lands anywhere else is reverted at `compositionend` from the engine's own copy.

**Commit and cancel.**
- A draft commits when:
  - the caret leaves its block (`selectionchange`);
  - focus leaves the root (`focusout`, which also covers switching tabs or windows);
  - Suggesting turns off;
  - the reader presses Cmd/Ctrl+Enter.
- The host also commits from its own copy on `pagehide` and on `visibilitychange` to hidden (3.5).
- Esc cancels the draft.

**Limits** are checked while the reader types: struck source ≤ 512 bytes (comments.ts:172) and inserted text ≤ 2048 bytes. Input past either limit is refused, with a counter shown.

**On commit, in the host:**
1. Prose classes expand the change to whole words (Intl.Segmenter).
2. Compute the source range with `toSourceRange` and run `checkReplace`.
3. Pick the anchor:
   - For a replace, `exact` is the struck source.
   - For an insertion, `exact` is the preceding grapheme in the same segment (`after`), or the following grapheme when the caret is at the start of a segment (`before`).
4. Take up to 128 bytes of prefix and suffix context.
5. Run `resolveSuggestions` on the current source. If the quote does not resolve to this range, widen it by graphemes on both sides until it does, up to 512 bytes. If it still fails, keep the draft in Unsent with "This passage repeats in the source."

**Exclusions.** Comment quote capture and comment mark painting skip `[data-sg-owned]` nodes. This matches how the raw view is skipped (comments.ts:1070-1082) and how frame-owned nodes are skipped inside the frame (sandbox.ts:558-575).

### 3.5 Transport, local drafts, page close

- **Routes.**
  - New suggestion: POST to the collection with `{ciphertext, version}` (existing route, app.ts:574-600).
  - Coalesced edit: `PATCH /comments/:id {ciphertext}`, author only (app.ts:3994-4026).
  - Undo, or reverting to the original text: DELETE.
- **Pre-sealing.** The host re-seals the active draft after every change and keeps the latest sealed body and method. Nothing is sealed inside an unload handler.
- **Page close.** On `pagehide`, and on `visibilitychange` to hidden, the host sends the latest sealed body with `fetch(url, { method, keepalive: true, headers: { 'content-type': 'application/json' }, body })`.
  - The request is same-origin, so there is no preflight and the session cookie goes with it.
  - The 64 KiB keepalive cap holds because ciphertext is at most 8192 characters (comments.ts:169).
- **Local drafts.**
  - Stored in localStorage under `relic:suggest-drafts:<relicId>` as `{ draft, version, method, comment_id?, ciphertext, state: 'editing' | 'sending' | 'unconfirmed', updated_at }[]`.
  - Records are sealed only; no plaintext is stored at rest.
  - At most 20 records and 64 KiB per relic. Records are removed when confirmed, or when the relic's remembered key is cleared.
- **Confirmation.**
  - A POST record is confirmed when the thread holds a comment by this session's verified address whose sealed `suggestion.draft` equals the record's draft. A PATCH record is confirmed when that comment's payload equals the record's.
  - On load, and on `pageshow` with `persisted`, each unconfirmed record is retried once. Failures appear in the Unsent tray with Retry and Discard.
- **Refetch.** The thread GET returns every row (comments.ts:663-711), so refetches are throttled:
  - on a presence `posted` ping: at most once per 5 s, with 0 to 2 s of jitter;
  - on becoming visible or regaining window focus: at most once per 10 s;
  - plus the existing manual refresh.

### 3.6 Frame protocol additions

Guards go in annotate-frame.ts. The handler goes after the first render in createSandboxHandler (sandbox.ts:2392-2489). Host wiring goes in `sandboxFrame` (main.ts:1394-1571).

```ts
// Host → frame
{ type: 'relic:suggest-table'; seq: number; segments: readonly { text: string }[] }   // ≤ 200,000 segments, ≤ 2,097,152 UTF-16 units total
{ type: 'relic:suggest-mode'; seq: number; on: boolean; editable: readonly number[] }
{ type: 'relic:suggest-paint'; seq: number; marks: readonly SuggestMark[] }            // whole set every time, ≤ 400
{ type: 'relic:presence-paint'; seq: number; peers: readonly PresencePeer[] }          // whole set every time, ≤ 64
{ type: 'relic:suggest-cancel'; draft: string }
type SuggestMark = {
  readonly id: string;                          // comment id (1..256 chars) or 'draft:<id>'
  readonly del: readonly { seg: number; from: number; to: number }[];
  readonly ins?: { readonly seg: number; readonly at: number; readonly text: string };  // rendered text, ≤ 2048 bytes
  readonly state: 'pending' | 'mine' | 'draft' | 'chosen' | 'alternative' | 'settled';
  readonly badge?: number;                      // other members of its conflict group, 1..199
};
type PresencePeer = { readonly id: string /* ^[A-Za-z0-9_-]{16}$ */; readonly color: number /* 0..7 */;
  readonly caret?: SegmentPos; readonly typing?: { readonly from: SegmentPos; readonly to: SegmentPos } };

// Frame → host
{ type: 'relic:suggest-ready'; seq: number; matched: number; unmatched: number; repeated: readonly number[] }
{ type: 'relic:suggest-draft'; op: 'update' | 'commit' | 'cancel'; draft: string;
  from: SegmentPos; to: SegmentPos; inserted: string; caret: SegmentPos; rect?: FrameRect }
{ type: 'relic:suggest-refused'; reason: EditRefusal; rect?: FrameRect }
{ type: 'relic:presence-rects'; peers: readonly { id: string; rect?: FrameRect }[] }
{ type: 'relic:suggest-select'; from: SegmentPos; to: SegmentPos; rect?: FrameRect }   // applied-view frame only
```

**Reused unchanged.** `relic:frame-mark-hover`, `-click`, `relic:track-mark` and `relic:frame-mark-rect` already carry ids (sandbox.ts:342-370). Painted `<del>`/`<ins>` elements get `data-comment-id`, so hover-to-reply works over the existing path. `relic:frame-selection` keeps serving Reading mode.

**Alignment (in the frame).**
- Walk the eligible text nodes in document order, skipping script, style, template, noscript, textarea, title and frame-owned nodes.
- A node maps to a segment when its data equals that segment's text.
- When several segments share a text, the k-th such node maps to the k-th such segment.
- Nodes beyond that count, and nodes that match nothing, stay read-only.
- `repeated` lists segments that more than one node maps to (a component rendered several times), so the receipt can warn that the change affects every instance.

**Validation in both directions.**
- Indexes must be in range of the receiver's *own* table, and offsets must not exceed the segment length.
- Ids are checked by pattern and strings by byte cap.
- Any malformed field rejects the whole message, as the existing guards do (annotate-frame.ts:304-346).
- Messages with a stale `seq` are ignored.

**One-render guard.** The guard (sandbox.ts:2401-2420) stays. None of these messages changes what the page says. The frame adds only viewer-owned `<del>`, `<ins>` and caret nodes, created with createElement and createTextNode, never innerHTML, as wrapFrameQuote does (sandbox.ts:374-381).

**Host gate on framed drafts.**
- The host accepts `relic:suggest-draft` only while Suggesting is on. The Suggesting toggle lives in Relic's chrome.
- The host posts a framed draft only if at least one of its `update` messages arrived while `navigator.userActivation.isActive` was true in the host. [INFERENCE] Keystrokes in the frame propagate activation to ancestors. That is confirmed for Chromium by its tracker (issue 500508224); WebKit and Gecko are verified in S4.

**Applied view for HTML and JSX** is a second `sandboxFrame` rendering the merged source, the same two-frame approach comparisons use (main.ts:1388-1392). JSX is re-transpiled on the host first (jsx.ts:26-43). If the merged JSX does not compile, the view says so and names the applied suggestions.

### 3.7 Presence

```ts
// packages/relic-format/src/presence.ts (new)
export async function derivePresenceKeys(keyBytes: Uint8Array, relicId: string):
  Promise<{ readonly seal: CryptoKey; readonly room: string }>;
//   HKDF-SHA256 with a zero-length salt, like the comment key (comments.ts:247-271):
//   seal = 128 bits, info 'relic/presence/v1/seal', AES-GCM
//   room = base64url of 128 bits, info 'relic/presence/v1/room:' + relicId (22 chars)
export const PRESENCE_PLAINTEXT_BYTES = 512;      // every frame padded to exactly this
export interface PresenceV1 {
  readonly v: 1; readonly t: number;              // sender clock, ms; receivers drop frames older than 30 s
  readonly name: string | null;                   // ≤ 64 bytes, self-asserted
  readonly color: number; readonly version: number;
  readonly caret?: { readonly s: number; readonly e: number };    // source offsets in that version
  readonly typing?: { readonly s: number; readonly e: number };   // live draft range, source offsets
  readonly posted?: string;                       // comment id just posted, edited or deleted
}
export async function sealPresence(key: CryptoKey, room: string, p: PresenceV1): Promise<string>; // nonce(12) || AES-GCM, AAD 'relic/presence/v1|' + room
export async function openPresence(key: CryptoKey, room: string, c: string): Promise<PresenceV1 | undefined>;
```

[UNGROUNDED] For private relics, the input keying material is whatever the reader already uses to derive the comment key. S1 locates that derivation and reuses it.

**Wire.** `GET /api/presence/{room}` upgrades to a WebSocket. `room` must match `^[A-Za-z0-9_-]{22}$`, and Origin must equal the service origin.
- Client to relay: `{"v":1,"c":"<base64url>"}`.
- Relay to client:
  - `{"v":1,"hello":{"self":"<id>","peers":<n>}}` on open;
  - `{"v":1,"f":"<id>","c":"…"}` for each forwarded frame;
  - `{"v":1,"f":"<id>","gone":true}` when a peer closes.
  - Ids are 16 random characters minted per socket.

**Cadence.** A reader in Suggesting mode with the tab visible sends exactly one fixed-size frame per second, so keystroke timing never shows below one second. Nobody else sends frames.

**Connect rules.**
- Connect only when signed in, with the tab visible, on a markdown, code, html or jsx relic, viewing the current version.
- Disconnect when the tab is hidden, or after 10 minutes with no pointer, key or scroll input while not suggesting.
- Reconnect with backoff 1, 2, 4… up to 30 s, with jitter.
- Receivers drop a peer 5 s after its last frame.

**Relay** (`packages/relic-server/src/presence.ts`, Bun WebSocket).
- Rooms live in memory only. The relay forwards each frame to the other sockets in the room, never parses `c`, and never writes to the store or to its own logs.
- Limits:
  - frames ≤ 1024 bytes (otherwise close 1009);
  - more than 3 frames/s averaged over 5 s are dropped, and persistent excess closes 1008;
  - ≤ 64 sockets per room (close 1013);
  - ≤ 16 sockets per client IP, using `clientIp()` (app.ts:228-233).
- Protocol ping every 30 s.
- A restart or deploy drops every room.

**Rendering.** Receivers map `caret` and `typing` through their segments. In the host DOM they draw a caret overlay. In a frame they use `relic:presence-paint`, and the host draws the name flags from `relic:presence-rects`, so names never enter the frame.

### 3.8 Service, infrastructure, CSP

- **`index.ts`** reads `RELIC_ROLE`:
  - `service` (default): no presence route.
  - `presence`: relay only.
  - `all`: both, for dev and the test harness.
  - `Bun.serve` (index.ts:151) gains a `websocket` handler for `presence` and `all`.
- **Terraform.**
  - The `cloud-run-service` module gains optional `timeout_seconds` and `max_request_concurrency`. Null keeps the main service as it is; today the resource sets neither (resource.google_cloud_run_v2_service.service.tf:13-69).
  - New `module "presence"`: same image, `RELIC_ROLE=presence`, max_instances 1, timeout 3600, concurrency 1000, cpu "1", memory "512Mi", ingress from the internal load balancer.
  - A new serverless NEG and backend service mirror resource.google_compute_lb.service.tf:15-47.
  - `google_compute_url_map.service` (94-98) gains a host rule and path matcher that send `/api/presence/*` to the relay.
  - WebSockets need no load-balancer configuration; the Cloud Run request timeout governs connection length (Cloud Run WebSockets doc, docs.cloud.google.com/run/docs/triggering/websockets).
- **Viewer CSP.** `connect-src` (app.ts:6399-6417) explicitly adds `wss://<service host>`.
- **`/policy`** gains the text in §4.4. "What rendered content can do" (app.ts:7292) gains the framed-typing sentence.
- **docs/spec/service.md** gains the presence endpoint, its limits and the disclosure requirement, and the stale line :565 is fixed.

### 3.9 MCP

This is the merged §5 relic-mcp contract, plus:
- **`relic_read_comments`** returns, per suggestion: `suggestion`; the resolver `status`, including `refused` with its reason; the range and group; and `changed_after_answer: true` when its `edited_at` is later than the publisher acknowledgement that addresses it.
- **`relic_apply_suggestions({ path, relic_id, accept, write? })`** takes the class from the relic.
  - It refuses with `source_changed_since_publish`, refuses two members of one group, and refuses any id that is not `resolved`.
  - It is a dry run by default.
  - Its output marks every replacement as third-party text.
- **`relic_republish`** address entries gain `outcome`. Without one, the call refuses with `suggestion_outcome_required` before any network call. A suggestion is settled only by a publisher outcome or a resolve (§8.4); a reader's reply does not settle it.
- **publish.md:** tool count goes from fifteen to sixteen. Confirm the current count first.

### 3.10 File ownership

| Files | Owner |
|---|---|
| relic-format/src/{suggestions,source-text,html-segments,html-entities,presence,comments,index}.ts, scripts/generate-html-entities.ts | S1 |
| relic-mcp/test/html-segments-diff.ts | S1 |
| relic-mcp/src/{comments,republish,apply-suggestions,server}.ts, relic-mcp/PATH.md | S2 |
| relic-viewer/src/{markdown,text-views,suggest-editor,suggestions,comments,annotate-quote,popover}.ts, styles.css | S3 |
| relic-mcp/test/suggested-edits-path.ts | S3 creates it; S4 and S5 append legs |
| .github/workflows/verify.yml | S3 |
| relic-viewer/src/{annotate-frame,sandbox,jsx-text}.ts, build.ts | S4 |
| relic-viewer/src/presence.ts | S5 |
| relic-server/src/*, deploy/terraform/*, scripts/deploy-smoke-path.ts | S5 |
| main.ts | S3, then S4, then S5, in that order |
| docs/spec/*, README, root PATH.md | S6 |

### 3.11 Proof inventory

- **CI already runs browser paths** in headless google-chrome: comment-path, comment-popover-path, decision-path and the passkey and email-code paths (verify.yml:102-120).
- **Harness pieces:** packages/relic-mcp/test/{harness-env.ts, browser-headless.ts, comment-popover-path.ts, html-image-comments-path.ts}.
- **Root PATH.md** pairs each path with a command and a success token (PATH.md:101-129).
- **Deploy** applies Terraform and then runs a smoke check (deploy.yml; scripts/deploy-smoke-path.ts).
- **Blind spots today:** no path covers WebSockets, two signed-in readers at once, IME, pagehide delivery, WebKit or Firefox, or the hop from load balancer to Cloud Run over WebSocket. That hop can only be reached after a deploy.

## 4. Security and privacy

### 4.1 Restated frame invariant

**Never cross into the frame:** the link key, comment key, presence key, comment bodies, replies, outcome notes, display names, author addresses.

**Do cross:** suggestion replacement text, segment text and positions, comment and peer ids, and color indexes. The frame displays all of these.

Why this is acceptable:
- The author's scripts can read what crosses. The author holds the link and can decrypt the same thread, so nothing new is disclosed.
- The frame has no network: `default-src 'none'` (app.ts:465-492), with WebRTC and workers contained (sandbox.ts:2551-2562). It can talk only to the parent.
- Replacement text enters the page only as text nodes, never as markup.

### 4.2 Integrity of drafts typed in HTML or JSX

**The exposure.** In HTML and JSX the reader types into the author's page.
- The page's scripts see every keystroke, including drafts later cancelled with Esc.
- They can alter what the frame reports.
- They can forge any frame message; the host checks only `event.source` (main.ts:1438-1439).
- They can also ask the host to open a visible new tab through `relic:open-link` (annotate-frame.ts:127-153; main.ts:1349-1357). That leaks loudly, not silently.

**Controls:**
- the Suggesting toggle lives in Relic's chrome, outside the page;
- the activation gate (3.6);
- the host bounds-checks every message against its own table;
- the receipt in Relic's chrome shows exactly what was posted, with Undo.

**Residual.** While the reader types, the page can substitute text. The reader sees the substituted text in the receipt and can undo it.

### 4.3 What the server and the load balancer still observe about presence

- **The relay process sees:**
  - the room id, which is derived from the key and does not name the relic;
  - each socket's IP address and user agent;
  - connect and disconnect times;
  - how many sockets share a room, and so which addresses view a relic together;
  - the per-socket cadence, which reveals "suggesting with the tab visible" versus not;
  - fixed frame sizes;
  - the session cookie, which the browser sends with every same-origin request. The relay does not read it.
- **The relay does not see:** cursor positions, typing ranges, display names, or typed text.
- **Cloud Run request logs** record one entry per WebSocket, with the room path, IP, user agent and connection length. Terraform sets no logging configuration, so the platform default retention applies (no log resources under deploy/terraform).
  - [UNGROUNDED] Whether load-balancer logging is enabled is not visible in Terraform (no `log_config` on the backend, resource.google_compute_lb.service.tf:32-47). The policy already claims 30-day edge and load-balancer retention (app.ts:7317).
- **The relic can be linked to a room by correlation.** The operator can usually match a room to its relic by IP address and timing against the reader's other requests.

### 4.4 /policy text (new section, after "Comments, email notices, and sharing")

> ## Live presence while suggesting
>
> When you are signed in and have a relic open, your browser keeps a connection to Relic's presence relay so you can see other readers' cursors and when they are typing. While you are in Suggesting mode with the page in front of you, your browser sends one update a second; otherwise it sends nothing.
>
> Each update is encrypted in your browser with a key derived from the link, padded to one fixed size, and passed to the other people in the same room. The relay never writes an update down and cannot read one: it does not see your cursor, what you type, or the name you entered.
>
> What we do see: that a browser at your IP address joined a room, when it connected and left, how many browsers share the room, and when yours is sending updates, which shows when you are suggesting. The room's name comes from the link and does not name the relic, but we can usually match it to the relic from your IP address and timing. Your browser sends your sign-in cookie with the connection, as with every request to Relic; the relay does not read it. Connection records are kept with our other request logs for ${retention} days.

The new sentence for "What rendered content can do":

> When you suggest an edit inside an HTML or JSX relic, you type into the publisher's page. Its scripts can see and change what you type there before it is posted. Relic shows the exact text it posted in its own panel, outside the page, with Undo.

### 4.5 Apply-time safety

- `checkReplace` lives in relic-format and runs in both the viewer and the MCP.
- For HTML and JSX it refuses replacements that carry markup, so a hand-written hostile suggestion cannot inject `<script>` through the publisher's agent.
- The publisher still reviews the dry-run diff.
- **JSX residual.** The apply tool cannot tell JSXText from code text. The viewer only ever offers JSXText, so a hand-written suggestion targeting code text is caught only by the diff review.

## 5. Slices

One workstream, one PR, branch `feat/suggested-edits`. Each slice is a commit.

**S0. Plan and mock** (`agent: designer`)
- **Files:** docs/plans/suggested-edits/{plan.md (this spec), mockup.html, mock-shots/}.
- **Acceptance:** Jason approves the §7 states.
- **Gates:** the UI in S3, S4 and S5.

**S1. Format**
- **Files:** relic-format (3.1-3.3, 3.7), the entity generator, tests, and `relic-mcp/test/html-segments-diff.ts`.
- **Non-goals:** markdown and JSX segmentation, UI, server.
- **Acceptance, observable:** `html-segments-diff.ts` runs in isolated headless Chrome. For the existing fixtures plus 200 generated script-free HTML documents, the sequence of `htmlSegments(source)` texts must equal the eligible text nodes Chromium's parser produces. It ends `HTML_SEGMENTS_DIFF_OK`. Unit tests cover:
  - every row of merged §4;
  - permutation invariance;
  - `refused` statuses;
  - CRLF and NUL offsets;
  - fixed-size presence frames.
- **Review risks:** entity decoding, offset maps, the inertness rule. Needs independent review (security-relevant).

**S2. MCP** (depends on S1)
- **Files:** per 3.9, plus relic-mcp/PATH.md.
- **Acceptance (loopback):**
  - publish markdown, HTML and JSX relics;
  - post sealed suggestions through the API;
  - `relic_read_comments` shows each status;
  - the apply dry run prints the expected unified diff;
  - apply refuses a changed source, two members of one group, and a hostile HTML `<script>` replacement (`refused: replacement_markup`);
  - republish without an outcome refuses `suggestion_outcome_required`;
  - republish with outcomes lands, and the acknowledgement rows carry `suggestion_outcome`;
  - ends `SUGGESTED_EDITS_MCP_OK`.
- **Review risks:** apply writes files. Needs independent review.

**S3. Viewer, host DOM (markdown and code)** (depends on S1 and S0)
- **Files:** per 3.10.
- **Changes:**
  - A source-aware markdown renderer that emits `data-seg` spans and delimiter pairs. A differential test compares it against today's `inline`/`renderMarkdown`, kept as a test oracle, over a fuzz corpus and the attack payloads in test/markdown.test.ts (text-views.ts:9-11). Output must be identical once the spans are stripped.
  - Code segments.
  - The editor engine.
  - The mode toggle and the "Suggest edit" offer.
  - Tracked-change painting, the conflict card and the applied view.
  - The receipt with Undo, coalescing, transport, local drafts, the Unsent tray and the refetch rules.
  - A verify.yml step for the path.
- **Non-goals:** frame, presence, editing in the raw source view.
- **Acceptance:** path legs 1-9 (§6), with two signed-in readers in isolated headless Chrome.
- **Review risks:** input handling, and keeping inserted text out of quote capture.

**S4. Frame (HTML and JSX)** (depends on S1 and S3)
- **Files:** per 3.10.
- **Step 1:** verify Sucrase's parser token API and pin the version.
- **build.ts:** the frame bundle includes suggest-editor, and a build test asserts that html-entities and the resolver are absent from it.
- **Acceptance:** path legs 10-15.
- **Review risks:** this is a security boundary. Needs independent review.

**S5. Presence** (depends on S1. The relay and Terraform can start after S1; the client needs S3.)
- **Files:** per 3.8 and 3.10, plus relic-server/test/presence.test.ts.
- **Acceptance:** legs 16-19 locally, plus the post-deploy gate below.
- **Review risks:** a new service, new privacy claims, a CSP change. Needs independent review.
- **Post-deploy gate:**
  - The deploy smoke opens two WebSockets through the load balancer to `wss://<service>/api/presence/<random room>` and asserts a frame from one reaches the other.
  - Then two isolated headless browsers on a throwaway test relic each see the other's caret.

**S6. Docs**
- **Files:** format.md 3.13; viewer.md §4 (the new messages) and §6.6 (modes); publish.md (the sixteenth tool); README; the root PATH.md entry.
- **Acceptance:** the PATH.md command passes in CI at the PR head.

## 6. Acceptance, negative controls, and what would prove this wrong

**End to end.** `mise exec -- bun packages/relic-mcp/test/suggested-edits-path.ts` runs on loopback with `RELIC_ROLE=all`. Readers A, B and C are signed in through the email code, each in an isolated browser context. It ends `SUGGESTED_EDITS_PATH_OK classes=4 presence=ok`.

**Markdown and code (legs 1-9):**
1. Publish a markdown relic and a code relic.
2. A turns on Suggesting, selects a word and types a canary string. A sees it struck and inserted. B's DOM never contains the canary.
3. A clicks into another paragraph. Exactly one POST is sent, and the receipt shows the exact text. After the ping or a refocus, B sees `<del>`/`<ins>` carrying A's id.
4. A types right next to that suggestion. This sends a PATCH, not a POST, and B sees the edited text.
5. B hovers the change, the card opens, and B replies. A sees the reply.
6. B types over the same words. The card shows two options. B's choice changes B's applied view and not A's.
7. The applied view equals the rendered `mergeSuggestions` output. Selecting edited text offers Reply.
8. Esc on a third draft sends no request.
9. Page close and offline recovery:
   - A types and closes the page. The keepalive POST arrives and B sees the change.
   - With requests blocked, the page reopens with an Unsent tray. Retry yields exactly one comment.

**HTML and JSX (legs 10-15):**

10. On the HTML relic, A types inside the frame. The receipt shows the exact text, and B's frame paints it. Hovering opens the card.

11. Text inserted by an inline script is refused with "not in the page source".
12. JSX: editing JSXText works; text from `{expression}` is refused; a repeated component shows "appears 3 times".
13. The applied views for HTML (second frame) and JSX (re-transpiled) are correct.
14. **Forged draft.** A fixture whose script posts `relic:suggest-draft` messages with no user input produces no POST or PATCH. **Mutation check:** with the activation check removed, this leg must fail.
15. A hostile API suggestion on HTML with a `<script>` replacement shows as refused and is never painted as markup.

**Presence (legs 16-19):**

16. While A types, B sees A's caret and the incoming indicator, and B's DOM still lacks the canary. After A commits, B's view updates with no manual refresh.
17. Every relay frame captured by the harness has the same length. Neither the canary nor A's display name appears in the relay's memory or log capture.
18. After a relay restart, both readers reconnect and their carets return.
19. C, who only reads, sends no frames and is invisible to A and B.

**Publisher leg.** Apply a batch (dry run, then write) and republish with outcomes. The cards then show Accepted in v2, Superseded, Not taken, Outdated, "Seen by the publisher, not applied yet", and "Changed after the publisher answered".

**Negative controls.**
- The path run against a viewer built from origin/main efa3afee must fail at leg 2.
- Leg 14's mutation check must fail as described.
- The markdown differential (S3) must fail when the old `inline` is swapped for a renderer with one regex pass removed.

**What would prove this wrong:**
- **WebKit or Gecko do not propagate frame activation to the host.** Then framed drafts need an explicit Post click in the receipt on those engines.
- **Sucrase's tokens are unreachable or unstable.** Then JSX ships read-only with the refusal, and HTML still ships.
- **The markdown differential cannot reach equality.** Then Suggesting is off on blocks that fail the mount check, and the merged plan's single-run narrowing applies.
- **Composition on Android or iOS keyboards cannot be confined to the `<ins>`.** Then Suggesting ships off on touch, with a notice.
- **Cloud Run regularly runs two relay instances.** Then rooms split, and the choice is Memorystore pub/sub or accepting it.
- **Jason rejects the mock.** Stop and ask.
- **The volume of blur commits overwhelms the republish gate for the agent.** Then reconsider §8.4 with Jason. Do not make a missing outcome an implicit `deferred` unprompted.

## 7. Mockup states

Each state is clickable, at 1440 in light mode, with dark variants of R1, S2, P1 and H1.

**Reading**
- **R1.** Tracked changes inline: a single replace, an identical pair ("also suggested by"), and a conflict group of three showing its default member with badge "3".
- **R2.** Hovering a change opens an attached card: the verified address and display name, struck and inserted text, a Source line when markup is involved, the status, the replies and a reply box.
- **R3.** Conflict card with radio choices. The choice affects only this reader's applied view.
- **R4.** The reader's own pending suggestion, styled as "mine".

**Applied**
- **A1.** "Show suggestions applied": clean text, with edited stretches faintly marked.
- **A2.** Selecting edited text offers Reply and Copy. Comment and Suggest are absent, with a one-line reason.

**Suggesting**
- **S1.** Suggesting on: the mode chip, a caret in the text, and two peer carets with name flags.
- **S2.** Typing inline: the struck/inserted draft, the hint "Esc cancels · Leave the paragraph to post", and the counter near the limits.
- **S3.** The Reading-mode selection offer with Suggest edit beside Copy text and Comment.
- **S4.** Receipt: "Suggestion posted", the exact text, Undo.
- **S5.** "Editing your suggestion" (coalescing).
- **S6.** Refusals: inside someone's inserted text, across formatting, over 512 bytes, across paragraphs.
- **S7.** A conflicting remote change lands mid-draft and folds into a badge on the draft.
- **S8.** Signed out: Suggest edits leads to sign-in.

**Presence and recovery**
- **P1.** A peer's view while someone types: "Priya is suggesting…" on the passage plus her caret, with no text.
- **P2.** The same view after the commit, with the change inline.
- **P3.** The "Live presence unavailable" chip.
- **U1.** The Unsent tray with Retry and Discard.
- **O1.** The six outcome states after a republish.

**Code, HTML, JSX**
- **C1.** A multi-line code draft using Enter and Tab.
- **C2.** The code applied view.
- **H1.** Typing in an HTML page: a receipt in Relic's chrome with the first-time notice that the page's scripts can see typing.
- **H2.** Refusal for script-generated text.
- **H3.** The HTML applied view (second frame).
- **J1.** Refusal for expression text: "This text comes from code, not the page's source text."
- **J2.** "This text appears 3 times; your suggestion changes all of them."

**Narrow and legacy**
- **N1.** 390×844, Suggesting with the receipt shown, leaving room for the keyboard.
- **N2.** 320×480, the conflict card.
- **N3.** 390×844, peer carets and the incoming indicator.
- **L1.** An older viewer: the suggestion appears as a plain comment with its fallback body.

## 8. Questions settled by Jason (2026-11-16)

These were open in the planner's draft. Jason chose the recommended answer on each. They are fact for every slice.

1. **Explicit Suggesting toggle.** The document is not always editable. Suggest edit on a selection turns the toggle on. Reason: in an editable page, Space and the arrow keys type instead of scrolling and every click places a caret.
2. **Only readers in Suggesting mode broadcast presence.** Signed-in readers with the tab visible receive without being seen. Anonymous readers do not connect.
3. **A separate single-instance Cloud Run WebSocket relay** for presence, best effort, scaling to zero. [INFERENCE from list pricing, not measured] About $60 a month in the worst case of a socket open around the clock, nothing while idle.
4. **Only a publisher-authored outcome, or a resolve, settles a suggestion for the republish gate.** A reader's reply does not. `relic_republish` must refuse while any suggestion lacks an outcome or a resolve, and the "any reply addresses it" rule (republish.ts:336-410; mcp/comments.ts:577-587) does not apply to comments that carry `suggestion`. A missing outcome is not an implicit `deferred`.
5. **Typing in HTML and JSX happens in the frame**, with the controls in 4.2: the toggle in Relic's chrome, the activation gate, the receipt with Undo, and a first-time notice that the page's scripts can see typing.

## 9. What cannot be done as described

- **Live cursors and the incoming indicator on today's service.**
  - **Why not:** there is no realtime channel, up to 4 stateless instances, and only process-local state (2.3).
  - **Cheapest honest alternative:** the single-instance relay (§8.3).
- **"The frame reports text edits as source offsets."**
  - **Why not:** the frame cannot be trusted with offsets, and for JSX it receives only compiled code (main.ts:1585-1595), so it has no source to measure against.
  - **Alternative:** the host builds the segment table, the frame reports segment positions, and the host converts them to source offsets. The behavior is the same, with the host as the authority.
- **Guaranteed delivery when the page closes.**
  - **Why not:** browsers do not guarantee keepalive delivery after a crash, a mobile kill, or when offline.
  - **Alternative:** sealed local persistence, a retry on the next open, and the Unsent tray. Other readers will not see the change until then.
- **Private keystrokes inside HTML and JSX pages.**
  - **Why not:** the author's scripts run in the page being typed into.
  - **Alternative:** none inside the page; §8.5 keeps typing in the frame with the controls in 4.2.
- **Fully trustworthy attribution for drafts typed in a frame.**
  - **Why not:** the page can alter text while the reader types.
  - **Alternative:** the activation gate plus the receipt with Undo is the strongest available guarantee.
- **Presence without metadata.**
  - **Why not:** connection metadata is unavoidable.
  - **Alternative:** disclose it in full (§4.3, §4.4).
- **Overlapping changes, all shown inline.**
  - **Why not:** several overlapping edits cannot be drawn legibly in the text.
  - **Alternative:** one member of each conflict group shows inline and the rest go to a badge and card. Others' changes over your own draft fold away until you commit.
- **Editing text from JSX expressions, props, loops or attributes, script-generated HTML text, or JSXText that also appears as a string literal.**
  - **Why not:** none of it maps back to static source text that can be told apart.
  - **Alternative:** it stays read-only with a refusal. HTML text that a script copies from a source segment may map to that segment; this residual is stated.
- **Exact deduplication across two tabs retrying together.**
  - **Why not:** the draft-id check cannot stop two tabs racing the same retry.
  - **Alternative:** a rare duplicate stays possible, and the reader can delete it.
- **Rooms surviving a relay restart or deploy.**
  - **Why not:** rooms live only in the relay's memory.
  - **Alternative:** they drop, and clients reconnect.
