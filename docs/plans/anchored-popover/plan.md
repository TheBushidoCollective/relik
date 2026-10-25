# Spec: anchored comment popovers on every class, and a truthful version banner

This amends agent://OtioAnchoredPopoverSpec (called "the OTIO spec" below) and replaces it as the dispatch spec for workstream A. Everything in the OTIO spec still holds unless this document changes it. The parts workers need are restated here, so this file stands on its own. The OTIO spec's §9 question is answered: Jason set the scope to every class.

The base is origin/main at 76269ed5. Every citation was read in the clean checkout at `/Users/jwaldrip/.omp/wt/bootstrap-run-76269ed`.

## 1. Goal

**Comments.** Every class that takes comments gets an attached composer: OpenTimelineIO, video, audio, markdown, code, image, PDF, and html, jsx and svg in the sandboxed frame. When a verified reader sets a target on the stage, they write the comment in a popover attached to that target.

- The composer never covers its target, and it stays usable at 1440, 390 and 320 wide, in light and dark.
- Post replaces the composer in place with the posted comment's card (Reply, Edit, Resolve, Open in thread) on its new mark. Focus moves into the card, and the Comments sidebar stays exactly as it was.
- On desktop, hovering a mark opens the same attached card. Clicking, tapping or focusing one does too, and nothing else happens.
- A reader without a verified address is still sent to the sidebar, where the address is verified.

**Banner.** An OTIO, media or PDF relic at version 2 or later opens with no "download-only" banner. An earlier version opened on its own says why, in that class's words. Download-only relics keep their banner. This is unchanged from the OTIO spec.

**PATH sentence.** "A verified reader who selects, points at or marks a target on any relic class writes the comment in a panel attached to it, and after Post the same place shows the posted comment's card while the sidebar stays as it was." The check is in §7.

## 2. Corrections to the brief

### 1. Frame marks are not in a parent overlay

They are painted inside the frame's own document, and the frame scrolls internally.

- **Nothing is painted on the page side.**
  - The page's `.comment-pins` overlay gets nothing for framed stages: "A framed relic draws its own pins, inside the frame that scrolls" (main.ts:5397-5406).
  - The frame adapters post `relic:paint-mark` inward (annotate-frame.ts:648-848).
  - The frame draws regions and pins on its own `#relic-frame-overlay` and wraps quotes in its own `mark` elements (sandbox.ts:518-541, 337-479).
- **The iframe fills the stage** at `height: 100%` (styles.css:1473-1517), so all scrolling happens inside it.
- **The page learns geometry only when the frame sends it:**
  - on a mark's `mouseenter` and `click` (sandbox.ts:298-328);
  - in answer to `relic:active-mark` (sandbox.ts:1206-1224).

  `relic:frame-scroll` carries only a vertical fraction, and nothing in single view listens to it (frame-scroll.ts:25-32, main.ts:1016-1024).
- **Consequences today:**
  - `anchorBoxFor(id)` returns `undefined` for every frame entry, because it searches `.stage-wrap` only (main.ts:5624-5645).
  - A card over a frame mark stays where it opened when the frame scrolls.
  - A row press opens a card only through the active-mark echo.

### 2. Pins, regions, framed points and boxes, and PDF page boxes never reach a popover

They all call `aim()`, which opens the sidebar and focuses its composer (main.ts:3952-3971). The call sites:

- pin `place`: main.ts:4174
- image region, mouse: 4280
- image region, touch: 4388
- keyboard region: 4474
- keyboard pin: 4480
- `relic:frame-point`: 4897
- `relic:frame-region`: 4904
- PDF drag: 5041

Only two paths reach `openComposer` today: a selection offer's Comment (main.ts:4060) and the timeline events in `aimTemporal` (main.ts:4922-4976). So for these kinds the attached composer is new, not a placement change.

### 3. Mark presses do not consistently open the card

- A posted pin's own listener opens the sidebar (`setOpen(true)`, main.ts:5421-5428) before the press bubbles to the card handler.
- A posted region's listener calls `stopPropagation()` (annotate-region.ts:85-94), so a region press never opens a card.
- A frame mark press reaches two listeners on `.stage-wrap`. One opens the pinned card (main.ts:6227-6240). The other opens the sidebar (main.ts:4907-4918).
- **Hovering a frame mark probably pins its card and opens the sidebar.** This is inferred from the code and not yet seen in a browser.
  - `openCard` calls `setActiveMark` (main.ts:5864-5867, 5575-5588).
  - The frame answers with `relic:frame-mark-click` (sandbox.ts:1206-1224).
  - Both listeners above treat that answer as a reader's press.

  A6b's negative control has to show this on origin/main.

### 4. Post moves focus into the sidebar

- After Post the composer closes.
- For every kind except time and OTIO, `marks.clear()` runs (main.ts:6064).
- That calls `deps.focusBody()` (main.ts:3944-3948), which focuses the sidebar's `.compose-textarea` (main.ts:5160-5166) whether or not the sidebar is open.

### 5. No browser harness covers media or document comments

- `otio-path.ts` is the only harness that drives comments in Chrome.
- `comment-path.ts` is MCP over stdio, with no browser.
- `cover-path.ts` renders covers only.
- Media, image, PDF and frame comments are covered only by stub-DOM unit tests.

So "extending existing harnesses" means two things:

- `otio-path.ts` is extended for OTIO.
- One new harness covers everything else, built on the existing harness modules:
  - `test/browser-headless.ts`
  - `src/cover/cdp.ts`
  - `src/cover/chrome.ts`
  - the server bootstrap at `cover-path.ts:75-125`
  - the verified-reader session pattern at `otio-path.ts:105-165`

### 6. A tall target breaks the OTIO placement rule

Under the OTIO spec's `placePopover`, an anchor that runs past both edges of the visible box leaves negative room on both sides. The cap comes out as 0, and the panel is unusable. A paragraph selected at 320x480 is enough to trigger this. §4.3 adds a rule.

### 7. The PDF drag writes the sidebar chip while dragging

On pointermove it sets `anchor = {kind: 'page', ...}` and calls `paintChip()` (main.ts:5016-5018). A drag that ends in the stage composer would leave the chip naming a target that has already been used.

### 8. The docs already disagree with the code

- viewer.md:417 says selecting text or activating a pin opens the sidebar.
- viewer.md:423 describes a `.mark-bubble` "Comment" button that opens the thread.

The code raises `.popover-offer` with Copy text, Comment and a dismiss control, and Comment opens the stage composer (main.ts:4028-4074).

### 9. The OTIO spec's main.ts line numbers are approximate

`buildThread` spans main.ts:5093-6681, and its popover section spans 5524-6329. Workers should find code by symbol name.

## 3. What each class does today

| Class | Composer today | Its anchor | Marks | Mark press today | What scrolls a target |
|---|---|---|---|---|---|
| OTIO | Popover, clamped into the preview band | The painted selection | `button.otio-comment-mark` in lanes | Card | `.otio-timeline-scroll` (horizontal) |
| Video, audio | Popover, above preferred | `TimeAimDetail.measure()` on the scrubber (media-player.ts:417-432) | `button.time-marker`, clusters (annotate-time.ts:272-444) | Seek and pause, then card | Nothing |
| Markdown, code | Selection: offer, then a popover on a fixed box. Pin: sidebar | `range.getBoundingClientRect()` (main.ts:4110-4111) | `mark.relic-text-mark`, `button.comment-pin` | Text: card. Pin: card and sidebar | `.code`, `.prose pre`, `.md-scroll` (horizontal) |
| Image | Sidebar | None | `div.comment-region` with badge, pin | Region: nothing. Pin: card and sidebar | Nothing |
| PDF | Sidebar | None | `div.mark-page` on the visible page | Card | `.stage-pdf` (`overflow: auto`) |
| html, jsx, svg | Selection: offer, then a popover on a fixed box. Point and box: sidebar | The frame's rect, converted once (main.ts:3771-3787) | Inside the frame | Card and sidebar. Hover pins and opens the sidebar (inferred) | The frame's own document |

Shared behaviour today:

- One `popoverLayer` on `.stage-wrap` (main.ts:6643).
- Hover opens after 140 ms and closes after 220 ms (main.ts:3513, 3521).
- Escape closes (6245-6247).
- A press elsewhere closes unless the field holds text (6290-6299).
- `fullscreenchange` re-shows at `reanchor` (6254-6260).
- The layer tracks scroll only when `bounds` is set (popover.ts:168-188).

## 4. Decisions settled here

### 1. Where the target is set decides where the comment is written

- **Stage-set targets** open the stage composer for a verified reader:
  - Comment on a selection offer, in the page or for a frame selection;
  - a pin placed by an armed click or tap, or by Enter on the armed stage;
  - an image region drawn by drag or with the keyboard box;
  - a PDF page box;
  - a frame point or box while armed;
  - every media scrubber gesture;
  - every OTIO gesture.
- **Sidebar-set targets** keep the sidebar composer: `Quote selection`, and `Comment on this frame` / `Comment on this moment`. The reader is working in the sidebar there. At 44rem or less an open sidebar hides the stage, so a stage panel would open where nobody can see it.
- **Arming tools only arm.** `Point at something`, `Mark a region or point` and `Mark on page` don't open anything themselves. The gesture happens on the stage, so the comment opens there.
- **Unverified readers** go to the sidebar as today, including the hand-off out of fullscreen.

### 2. Placement preference by class

- **Documents prefer above:** markdown, code, image, PDF, html, jsx and svg. A panel below covers what the reader reads next (popover.ts:52-55), and the selection offer already sits above.
- **Timelines prefer below:** OTIO, video and audio. The picture under review sits above the timeline: that is the OTIO spec's reasoning, and media-player.ts:340-342 puts the video above `.media-chrome`. Audio uses the same chrome, so one rule covers every timeline.

Either side flips when it doesn't fit.

### 3. No panel covers its target

When neither side can hold the panel, the layer caps its height on the larger side, as in the OTIO spec.

A target taller than half the visible stage is attached by its first line if it is text, and by its top edge otherwise. That always leaves a capped panel room. The panel may then cover the rest of a tall target, and that is the only case where it covers anything of the target.

### 4. Tracking

The panel follows a live measure of its target.

- When an inner scroller moves, the panel is re-placed along its current side. The inner scrollers are a code block, a wide table, `.stage-pdf` and the OTIO timeline.
- When the frame reports new geometry for the tracked mark, the same re-placement happens.
- The host's own scroll needs nothing, because the panel sits in content coordinates.
- A resize or layout change re-places the panel fully.
- A target clipped out of view holds the panel still.
- Sticky opens reveal the panel by scrolling only `.stage-wrap`, and only as far as needed.

### 5. The stage composer paints its own target and never touches the sidebar chip

While the composer is open, the provisional mark is painted from the composer's target. The chip keeps whatever it held before the gesture.

### 6. After Post, on every class

- The composer stays busy until the refresh lands.
- Then it is replaced by the posted comment's card on the new mark, and the card takes focus.
- `setOpen` is never called, and the chip is not cleared.

This reverses the OTIO spec's decision 4 ("Text, pin, region, page and media-time composers keep today's close-then-refresh behaviour").

### 7. A mark press opens its card and nothing else

- The sidebar-opening and propagation-stopping listeners on pins, regions and frame marks are removed (correction 3).
- Only Open in thread opens the sidebar.
- A time marker press still seeks and pauses.

### 8. Re-aiming keeps the draft within a family

There are three families: time, OTIO, and document (quote, text, pin, region, page). A new stage-set target in the same family as the open composer moves the target and the panel, and keeps the text and the focus policy. Today only time and OTIO re-aim (main.ts:6007-6020).

### 9. Keyboard

- Every mark that is already a button opens its card on focus: pins, time markers and clusters, and OTIO marks. Enter or Space moves focus into the card.
- Text, region, page and frame marks stay reachable by pointer and through the row press, which opens the attached card on every class.
- Making those marks focusable is out of scope.

### 10. Banner, and no connector or caret

These follow the OTIO spec's decisions 5 and 6.

## 5. Shared contracts

These contracts go into the batch `context` verbatim.

### 5.1 Anchor geometry

Every anchor is a client rect converted to `.stage-wrap` content coordinates with `anchorFromClientRect`. Frame rects are converted with `frameAnchorBox`.

`anchorBoxFor(id)` in main.ts becomes the class-aware measure below. Called with `PENDING_MARK_ID` (`'pending:target'`), it is also the composer's `follow` function for document targets.

**OTIO.** As in the OTIO spec 5.1:

- The clip is the visible track area.
- Point, range and track targets are measured from `.otio-selection`.
- A comment is measured from the first laid-out piece of its `.otio-comment-mark`.
- When there is no `.otio-selection`, fall back to the Comment button's rect.
- New: `OtioUiController.measure(commentId?: string): DOMRect | undefined`. `OtioAimDetail` loses `measureBounds`.
- For OTIO entries, `anchorBoxFor` uses `controller.measure(id)`, with no DOM fallback.

**Media.**

- The composer uses `TimeAimDetail.measure()`, unchanged.
- A card uses the marker button. A cluster member uses its `[data-cluster-members]` button.
- There is no clip.

**In-page documents** (markdown, code, image, PDF, and jsx shown as source):

- The candidate nodes are `[data-comment-id="<id>"]` inside `.stage-wrap` and not inside `.popover`. A cluster member resolves to its `[data-cluster-members]` ancestor.
- For text marks (`mark[data-comment-id]`):
  - `full` is the union of every client rect of every laid-out text mark with that id.
  - `first` is the first client rect of the first such mark.
- For any other node:
  - `full` is the bounding rect of the first laid-out node.
  - `first` is undefined.
- **Clip.** Find the nearest ancestor between the node and `.stage-wrap` whose computed `overflow-x` or `overflow-y` is not `visible`. Today that is `.code`, `.prose pre`, `.md-scroll` or `.stage-pdf`.
  - Intersect with that ancestor's client box: its border box inset by `clientLeft` and `clientTop`, sized `clientWidth` by `clientHeight`.
  - If there is no such ancestor, don't clip.
  - If the intersection is empty, return `undefined`.
- Then apply `chooseTargetBox(full, first, host.clientHeight)`.
- Where the stub DOM lacks `getClientRects` or `getComputedStyle`, treat the node as a single rect with no clip. Guard these calls the way the existing code does.

**Framed documents** (html, rendered jsx, svg):

- Use the latest `{rect, first}` the page holds for that id (5.5).
- Clip both rects to `{0, 0, frame.clientWidth, frame.clientHeight}` in frame viewport coordinates.
- Apply `chooseTargetBox`, then convert with `frameAnchorBox`.
- If there is no entry, or the clip is empty, return `undefined`.

**Fallbacks.**

- The composer's first box is the measured target. Failing that, it is the caller's box: the selection rect, the frame gesture box or the timeline measure. If neither exists, `compose` returns false and the sidebar path runs.
- The posted card's box is the new mark's measure. Failing that, it is the composer's last placed anchor.

### 5.2 popover.ts API

This is the OTIO spec 5.2, plus `track()` and `chooseTargetBox`.

```ts
export interface Placement {
  readonly left: number;
  readonly top: number;
  readonly side: 'above' | 'below';
  /** Present only when the natural height fits on neither side. */
  readonly maxHeight?: number;
}
export function placePopover(anchor: AnchorBox, size: { width: number; height: number },
  host: HostBox, gap = POPOVER_GAP, margin = POPOVER_MARGIN,
  prefer: 'above' | 'below' = 'above'): Placement;
export function placeLeft(anchor: AnchorBox, width: number, host: HostBox,
  margin = POPOVER_MARGIN): number;   // today's horizontal rule, unchanged
export function revealScrollTop(anchor: AnchorBox, height: number,
  host: HostBox & { readonly scrollHeight: number }, gap = POPOVER_GAP,
  margin = POPOVER_MARGIN, prefer: 'above' | 'below' = 'above'): number;
export function chooseTargetBox(full: AnchorBox, first: AnchorBox | undefined,
  viewHeight: number): AnchorBox;
export interface PopoverPlacementOptions {
  readonly follow?: () => AnchorBox | undefined; // undefined: hold the last placement
  readonly reveal?: boolean;                      // sticky panels only
  readonly prefer?: 'above' | 'below';
}
export interface PopoverLayer {
  show(content: HTMLElement, anchor: AnchorBox, options?: PopoverPlacementOptions): HTMLElement;
  hide(): void;
  current(): HTMLElement | undefined;
  contains(node: Node | null): boolean;
  reposition(): void;
  /** Re-measures `follow` and applies the inner-scroll rule (5.3). */
  track(): void;
}
```

`bounds` is deleted from `PopoverPlacementOptions` and from `placePopover`.

**`placePopover` rule.**

1. Set up the frame:
   - `vt = scrollTop + margin` and `vb = scrollTop + clientHeight - margin`.
   - `a0` is the anchor's top and `a1` is its bottom.
   - `roomAbove = a0 - gap - vt` and `roomBelow = vb - (a1 + gap)`.
2. If the anchor is entirely outside `[vt, vb]`, use the preferred side at natural height. Top is `a0 - gap - h` above or `a1 + gap` below. Don't clamp, so the panel stays attached.
3. Otherwise:
   - Take the first side, in preference order, whose room is at least the panel height.
   - If neither side fits, take the side with more room (ties go to `prefer`) and set `h = maxHeight = max(0, room)`.
   - Top is `a0 - gap - h` above or `a1 + gap` below.
4. Left comes from `placeLeft`: centred on the anchor, clamped to `[scrollLeft + margin, scrollLeft + clientWidth - width - margin]`, and pinned to the left limit when the panel is too wide.

**`revealScrollTop` rule.**

1. If the anchor is fully inside `[vt, vb]` and either side fits the panel, return `scrollTop` unchanged.
2. Otherwise build two candidate spans: above `[a0 - gap - h, a1]` and below `[a0, a1 + gap + h]`. Keep only the spans no taller than `clientHeight - 2·margin`.
3. Pick the span that needs the smallest scroll to bring it into view (ties go to `prefer`). If no span qualifies, reveal `[a0, a1]` alone.
4. Clamp the result to `[0, scrollHeight - clientHeight]`.

**`chooseTargetBox` rule.**

- If `full.height <= viewHeight / 2`, return `full`.
- Otherwise, if `first` has a width or height above 0, return `first`.
- Otherwise return `{ left: full.left, top: full.top, width: full.width, height: 0 }`.

**Test tables.** For P1 to P7, the host is `{scrollLeft: 0, scrollTop: 0, clientWidth: 800, clientHeight: 600}`, the panel is `{320, 160}`, and gap and margin are both 8.

| Case | Input | Expected |
|---|---|---|
| P1 | anchor `{200,300,120,20}` | above, top 132, left 100 |
| P2 | P1 with `prefer: 'below'` | below, top 328 |
| P3 | anchor `{200,500,120,54}`, `prefer: 'below'` | above, top 332 |
| P4 | clientHeight 300, anchor `{200,120,120,40}` | below, maxHeight 124, top 168 (clear of the anchor) |
| P5 | anchor `{200,700,120,20}` | above, top 532 (was 432) |
| P6 | scrollTop 1000, anchor `{200,900,120,20}`, `prefer: 'below'` | below, top 928 |
| P7 | panel `{320,900}`, anchor as P1 | above, maxHeight 284, top 8 |

For R1 to R5, `scrollHeight` is 2000 and h is 160.

| Case | Input | Expected |
|---|---|---|
| R1 | anchor top 300, height 20 | 0 |
| R2 | anchor top 900, height 54 | 362 |
| R3 | scrollTop 1000, anchor top 900, height 54 | 892 |
| R4 | clientHeight 200, anchor top 900, height 54 | 762 |
| R5 | scrollHeight 1000, anchor top 980, height 20 | 400 (clamped) |

For T1 to T4, viewHeight is 600.

| Case | Input | Expected |
|---|---|---|
| T1 | full `{0,100,200,40}` | full |
| T2 | full `{0,100,200,400}`, first `{20,100,180,20}` | first |
| T3 | full `{0,100,200,400}`, no first | `{0,100,200,0}` |
| T4 | full `{0,100,200,300}`, first `{20,100,180,20}` | full (exactly half) |

### 5.3 Layer tracking

This is the OTIO spec 5.3 with two rules replaced. All of it applies only when `follow` is set.

**Inner scroll and `track()`.** This replaces the OTIO spec's "Inner scroll" rule.

- Trigger on `track()`, and on a capture-phase `scroll` from any target inside the host other than the host itself. Coalesce with requestAnimationFrame. Where it is absent, as in the stub DOM, run synchronously.
- Call `follow()`. If it returns `undefined`, change nothing.
- Otherwise write `left = placeLeft(...)` and `top = side === 'above' ? a0 - gap - h : a1 + gap`, where `h` is the panel's current `offsetHeight`.
- Leave `side`, `max-height` and `data-capped` unchanged.

A horizontal inner scroll therefore leaves `top` where it was, which is the OTIO spec's rule.

**First placement.** This refines the OTIO spec's "What a full place does".

- The layer stores the anchor it last placed against. It starts as the box passed to `show()`.
- A full place uses `follow()` when that returns a box, and stores the box.
- If `follow()` returns `undefined`, a panel that has never been placed uses the stored anchor. A panel already placed holds and writes nothing.

**Unchanged from the OTIO spec:**

- Window resize: a full place, plus reveal when `reveal` is set.
- A ResizeObserver on the host, the panel, and the host's other element children triggers a full place with no reveal.
- `reposition()`, and `show()` of new content: a full place, plus reveal when `reveal` is set.
- `show()` of the same content keeps the current policy unless options are passed.
- A full place clears the cap and measures, reveals only when the scroll would change by more than 0.5px, calls `placePopover` with `prefer`, and writes `max-height` and `data-capped="true"` only for a `maxHeight` result.
- `hide()` clears every listener, the pending frame and the cap.
- In fullscreen, translation is unchanged, and reveal runs only when the panel is mounted on the host.

### 5.4 Interaction, on every class

**Gesture routing in `buildMarkControls`.**

- **`aimOnStage(anchor, box?)`.** A new internal function. It calls `dismiss()`, `disarm()`, `disarmSpan()` and `removeKeyboardBox()`.
  - Then, if `deps.compose?.(anchor, box) === true`, it stops: no chip write, no `deps.open()`, no `deps.focusBody()`.
  - Otherwise it calls `aim(anchor)` exactly as today.
- **Callers of `aimOnStage`:**
  - `place` (4174)
  - the mouse and touch region drags (4280, 4388)
  - the keyboard region and pin (4474, 4480)
  - `relic:frame-point` and `relic:frame-region` (4897, 4904), which pass `frameAnchorBox(frame, msg.box, host)` when `box` is present
  - the end of the PDF drag (5041)
- **Paths that keep their current calls:**
  - The selection offer keeps `deps.compose(offered.target, offered.anchorBox)`.
  - The timelines keep `aimTemporal`, minus the bounds plumbing.
  - A frame selection with no `rect` still goes to the sidebar (4867).
- **The PDF drag preview** goes through a preview target that `target()` reports while the drag lasts. It never writes `anchor` and never calls `paintChip()`. The end of the drag clears the preview.
- **Delete these listeners:**
  - the `relic:frame-mark-click` listener in `attach` (main.ts:4907-4918);
  - the posted pin's click listener in `paintMarks` (main.ts:5421-5428).

  The posted region's listener goes too, in annotate-region.ts:85-94.

**Composer (`openComposer`).**

- **`preferFor(kind)`** returns `'below'` for `'time'` and `'otio'`, and `'above'` for every other kind.
- **Re-aim** happens when the open composer's anchor is in the same family as the new one (decision 8):
  - update the anchor and the target line;
  - repaint the provisional mark for documents, or tell the player as today for time;
  - re-show the same panel with the same options, keeping the field, the draft and the focus policy.
- **Otherwise, build a new composer:**
  1. Call `closeCard()`.
  2. Set `composing` before painting.
     - `paintMarks` paints `PENDING_MARK_ID` from `composing.anchor` when that anchor is a document kind and the composer is the open panel.
     - In every other case it paints from `marks.target()`, as today.
  3. Build the column layout.
     - The target line, the disclosure and the note go inside `.popover-bounded-body`. The field and `.popover-tools` are direct children.
     - Classes: `popover-card popover-composer`, plus `is-otio-composer` for OTIO.
     - `data-anchor-kind` carries the anchor kind.
  4. Show the panel.
     - `follow` is `options.reanchor` for time and OTIO, and `() => anchorBoxFor(PENDING_MARK_ID)` for documents.
     - Show with `{ follow, reveal: true, prefer: preferFor(kind) }` at `follow() ?? box`.
     - On a framed stage, post `relic:track-mark { id: PENDING_MARK_ID }`.
     - When `focus` is set, focus the field with `preventScroll: true`.
- Delete the safe-band code, as the OTIO spec says.

**Post, on every class.**

1. Keep the composer busy, and read the target at the moment of the press, as today. A refusal clears the busy state and shows the note, as today.
2. When the post succeeds, remove all ranges. Don't call `marks.clear()`. Then `await refresh()`.
3. If the composer is still the open panel and `result.commentId` names an entry:
   - Call `dropComposing()`. It now repaints marks for document targets, so the provisional mark goes away. For time targets it still tells the player.
   - Get the box.
     - On a framed stage, the box is `await awaitFrameRect(id)`. That posts `relic:track-mark {id}` and resolves on the first report for `id` that carries a rect, or `undefined` after 1000 ms.
     - Otherwise the box is `anchorBoxFor(id)`.
     - If neither gives a box, use the composer's last placed anchor.
   - Call `openCard(entry, box, true)`.
   - Set the card's `tabIndex = -1` and call `focus({ preventScroll: true })`.
   - Carry the composer's return-focus target over to the card.
4. Otherwise call `closeCard()`.

Never call `setOpen`.

**Cards, on every class.**

- **Show options.** `openCard`, the cluster card and Edit's panel show with `{ follow: () => anchorBoxFor(id), reveal: sticky, prefer: preferFor(entry.anchor.kind) }`. All three carry `data-anchor-kind`.
- **`reopen`** uses `anchorBoxFor(id) ?? box`.
- **Tracking on a framed stage.** Opening a card posts `relic:track-mark {id}`. `closeCard()` posts `relic:track-mark {id: null}` if it had asked for tracking.
- **A row press on a framed stage** reveals and calls `setActiveMark` as today. Then it opens the card once `awaitFrameRect(id)` gives a box.

**Frame geometry on the page side.**

- `sandboxFrame` dispatches `relic:frame-mark-rect` from a new branch right after the mark-click branch.
- The thread keeps the latest `{rect, first}` only for the id it is following or waiting on, and ignores every other id.
- A hover or click message seeds the entry for its own id, using its `rect` as both `rect` and `first`.
- A `relic:frame-mark-rect` for the followed id calls `popover.track()`.

**Keyboard on marks.** This applies to a focused `.otio-comment-mark`, `.comment-pin` or `.time-marker`.

- When Enter or Space activates the mark, which arrives as a click with `detail === 0`, open the pinned card. For a cluster, open the list card.
- Focus the card's first `.popover-action`, or the cluster's first member.
- Remember the mark as the return-focus target.

**Return focus.** This is the OTIO spec's rule, applied to every composer and every card opened from the keyboard.

- The target is `document.activeElement` at the moment of first open, provided it is inside `.stage-wrap` and not inside a popover.
- Escape and Cancel refocus that target if focus has fallen to `body` or `null` and the target is still connected.
- A press elsewhere never moves focus.

**OTIO `emitAim(focus)`**, as in the OTIO spec:

- When `focus` is true, first call `expandTrack(selected track)`.
- If `focus` is true, or the clipped selection is empty, adjust only `.otio-timeline-scroll.scrollLeft`, so the selection sits in the visible track area with 16px of padding. A selection wider than the area is aligned at `area.left + 16`.
- Never call `scrollIntoView`.
- The event detail is `{ anchor, focus, measure: () => measure() }`.

**Unchanged on purpose:**

- the hover timings;
- pinning on tap, click and focus;
- keeping a composer that holds text when the reader presses elsewhere;
- ignoring mark presses while a composer holds text;
- sending unverified readers to the sidebar, and the hand-off out of fullscreen;
- Escape and Cancel discarding the draft;
- the selection offer step;
- the sidebar-set targets;
- the sidebar composer and its chip;
- the time marker's seek and pause.

### 5.5 Frame protocol

```ts
// annotate-frame.ts
export interface FramePointMessage {
  readonly type: 'relic:frame-point'; readonly x: number; readonly y: number;
  /** The placed pin's box, in frame viewport coordinates. */
  readonly box?: FrameRect;
}
export interface FrameRegionMessage {
  readonly type: 'relic:frame-region'; readonly rect: AnchorRect;
  /** The drawn region at release, in frame viewport coordinates. */
  readonly box?: FrameRect;
}
/** Page to frame: report this mark's geometry now and after every scroll, resize or repaint, until told null. */
export interface TrackMarkMessage { readonly type: 'relic:track-mark'; readonly id: string | null }
/** Frame to page: one mark's geometry in frame viewport coordinates. No rect when it is not laid out. */
export interface FrameMarkRectMessage {
  readonly type: 'relic:frame-mark-rect'; readonly id: string;
  readonly rect?: FrameRect; readonly first?: FrameRect;
}
export function isTrackMarkMessage(data: unknown): data is TrackMarkMessage;
export function isFrameMarkRectMessage(data: unknown): data is FrameMarkRectMessage;
```

**Validation.**

- Ids follow the existing rule: a string of 1 to 256 characters, or `null` where allowed (annotate-frame.ts:342-360).
- Any `rect`, `first` or `box` that is present must pass `isFrameRect`. A malformed one rejects the whole message.

**What the frame sends with a gesture** (sandbox.ts):

- A point's `box` is `{ left: clientX - 10, top: clientY - 10, width: 20, height: 20 }`, which is the drawn pin's size (sandbox.ts:211-225).
- A region's `box` is the drawn band's `getBoundingClientRect()` at release.

**Tracking.**

- `relic:track-mark` stores the id and reports at once. An id of `null` stops tracking.
- While an id is tracked, the frame reports again on window `scroll` (passive) and `resize`, and after paint-mark, paint-marks, clear-mark and clear-marks. All of these are coalesced with requestAnimationFrame.

**A report.**

- The candidates are elements in `doc.body` whose `dataset.commentId` equals the id and whose client rect is not empty. Compare by dataset, as `onActiveMark` does.
- For `mark` elements, `rect` is the union of all their client rects, and `first` is the first client rect of the first one.
- For anything else, `rect` is the first element's bounding rect, and `first` is left out.
- With no match, post `{ type, id }` only.

**`onActiveMark(id)`** answers with a report for that id as `relic:frame-mark-rect`, never as `relic:frame-mark-click`. It doesn't change the tracked id.

### 5.6 Compose contracts

```ts
export interface ComposeOptions {
  readonly focus?: boolean;
  /** Live measure of a timeline target, in host content coordinates. */
  readonly reanchor?: () => AnchorBox | undefined;
}
// MarkDeps
readonly compose?: (anchor: CommentAnchor, box: AnchorBox | undefined,
  options?: ComposeOptions) => boolean;
```

`compose` returns false in three cases: the reader is unverified, the cipher is missing, or no box can be found (5.1).

`PostResult` gains `commentId: string | null`, read from a non-empty string `comment_id`. This comes from the OTIO spec. The server already returns the field (relic-server/src/app.ts:2660-2667).

### 5.7 Banner and copy

All copy is verbatim and contains no dashes.

**diff.ts.**

- The unavailable codes become `'comparison_not_renderable'` (download), `'comparison_not_supported'` (otio, media, pdf) and `'comparison_too_large'`.
- New `unpromptedComparisonNotice(view): string | undefined` returns the detail for `comparison_not_renderable` and `comparison_too_large`, and `undefined` otherwise.
- New `uncomparableClassNoun(route)` maps otio to `timeline`, media to `recording` and pdf to `PDF`.
- The `not_supported` details:
  - otio: "Relik plays this timeline in your browser but cannot show two versions of it side by side. Each version can still be opened on its own."
  - media: "Relik plays this recording in your browser but cannot show two versions of it side by side. Each version can still be opened on its own."
  - pdf: "Relik shows this PDF in your browser but cannot show two versions of it side by side. Each version can still be opened on its own."

**main.ts.**

- `buildCurrentStage(view, origin, options: { comparisonNotice?: boolean } = {})` appends the unprompted notice unless `comparisonNotice` is `false`.
- `renderSingleVersion` passes `{ comparisonNotice: false }`.
- `uncomparableReason` keeps the download sentences. For classes that play in the browser:
  - Historical version: `Relik cannot show version ${selectedVersion} of this ${noun} beside version ${current.version}. It is open here on its own.`
  - Current version: `Relik cannot show version ${current.version} of this ${noun} beside version ${selectedVersion}. Version ${selectedVersion} is open here on its own.`

### 5.8 Proof selectors and measurements

**Selectors.**

- **Composer:** `.popover-card.popover-composer[data-anchor-kind]`. It contains `textarea.popover-field`, `.popover-action.is-primary` (Post), a button whose text is Cancel, and `.popover-bounded-body`.
  - `data-side` is `above` or `below`.
  - `data-capped="true"` appears only when the panel is capped.
  - OTIO composers also carry `.is-otio-composer`.
- **Posted card or mark card:** `.popover-card[data-comment-id][data-anchor-kind]`. It contains `.popover-reply` and `.popover-open-thread`, plus `.popover-edit` and `.popover-resolve` for the author, and no `.popover-field`. Its mark is active; for framed classes that means inside the frame.
- **Provisional target** in the page: `[data-comment-id="pending:target"]`.
- **Sidebar untouched:** `.thread`'s `is-open` class and `.thread-toggle[aria-expanded]` both equal their values just before the gesture.

**Measurements.** Anchors are measured per 5.1.

- **Adjacency.** Below means `|card.top - anchor.bottom - 8| ≤ 1.5`. Above means `|anchor.top - card.bottom - 8| ≤ 1.5`.
- **Horizontal.** The anchor's centre x lies in `[card.left - 1, card.right + 1]`, unless the card sits against the host's left or right margin.
- **No overlap.** The intersection area of card and anchor is 0.
- **Anchor exposed.** `elementFromPoint(anchor centre)` is not inside `.popover`.
- **Inside.** The card is within the `.stage-wrap` client box and within the viewport.
- **Usable.** The textarea, Post and Cancel are visible, inside the card, and each owns its own hit point.
- **Preference.** If the card isn't capped and the preferred side fits, the card must be on the preferred side.
  - Documents fit above when `anchor.top - 8 - card.height ≥ stage.top + 8`.
  - Timelines fit below when `anchor.bottom + 8 + card.height ≤ stage.bottom - 8`.
- **Capped.** If the card isn't capped, the body doesn't overflow, and the target and disclosure lines sit inside the body. If it is capped, the body scrolls, and the field, Post and Cancel are fully visible.
- **Follow.** After an inner scroll or a frame scroll that leaves the anchor visible, adjacency and no-overlap hold again within two animation frames of the scroll, or of the frame's report. When the anchor is clipped out, the card's rect doesn't change.

### 5.9 Docs text

A5 writes these verbatim.

1. **viewer.md:283.** Replace item 13 with:

   > 13. **History present but comparison unavailable.** A class with no comparison mode does not get a broken control: the taskbar offers **Earlier versions**, which opens a chosen version on its own. Media, OpenTimelineIO and PDF relics play or render in the browser and nothing on their page offers a comparison, so the current page carries no comparison notice; opening an earlier version says why it is alone, in that class's words, for example **"Relik cannot show version 1 of this timeline beside version 2. It is open here on its own."** A download-only relic keeps its notice on the current page: **"This file is download-only, so Relik cannot show two versions side by side in the browser. Each version can still be opened on its own."** A current plaintext above the ceiling also keeps rendering normally, under **"This version is larger than the 16 MiB comparison limit, so Relik cannot show it beside another. Earlier versions can still be opened on their own."** for every comparable class. An earlier version shown on its own carries its own reason and never the current page's notice as well. A historical version above the ceiling is refused after its mint and before its ciphertext fetch, naming that version and confirming the current version remains open. Other historical fetch or decrypt failures stay inside the comparison panel.

2. **viewer.md:417.** Replace "Selecting text or activating a pin target opens it as well, because both acts are a comment about something being read right now." with:

   > Aiming a comment at the relic does not open it: a verified reader writes that comment in a panel attached to its target on the stage, and only a reader who still has to verify an address is taken to the sidebar, because the address is verified there.

3. **viewer.md:423.** Three edits.
   - Replace everything from "**A selection raises `.mark-bubble`**" through "it is dismissed when the selection collapses or Escape is pressed." with:

     > **A selection raises the selection offer** (`.popover-offer`), placed above the live selection inside the stage and offered only for a selection that is not collapsed, is inside the stage, and is non-empty after trimming. It offers **Copy text** and **Comment**, with a way to decline both. **Comment** opens the stage composer on the selection for a verified reader; for a reader without a verified address it locks the quote as the sidebar composer's target, opens the thread, and puts focus there. The offer is dismissed when the selection collapses or Escape is pressed.

   - Replace "**The composer always carries `.compose-target`**" with "**The sidebar composer always carries `.compose-target`**".
   - Append to the end of the paragraph:

     > The stage composer names its target in its own `.popover-target` line and leaves the sidebar chip as it was.

4. **viewer.md:435.** Replace "`FrameMarkClickMessage`, `FrameMarkHoverMessage`, and inward `ActiveMarkMessage`." with:

   > `FrameMarkClickMessage`, `FrameMarkHoverMessage`, `FrameMarkRectMessage` (`relic:frame-mark-rect`, one mark's geometry, sent in answer to `ActiveMarkMessage` and to the inward `TrackMarkMessage` (`relic:track-mark`), and sent again after every scroll, resize or repaint inside the frame until the page stops asking), and inward `ActiveMarkMessage` and `TrackMarkMessage`. A placed point and a drawn box also carry their own `box` in viewport coordinates on `relic:frame-point` and `relic:frame-region`, so the stage composer opens beside them before the frame has painted the provisional mark. The answer to `ActiveMarkMessage` is never a `relic:frame-mark-click`: geometry the page asked for is not a reader's press.

5. **viewer.md:437.** Replace "Activating a comment row sends `{ type: 'relic:reveal-mark' }` to scroll the frame directly to the target." with:

   > Activating a comment row sends `{ type: 'relic:reveal-mark' }` to scroll the frame directly to the target, and opens that comment's card over the mark once the frame reports where it landed.

6. **viewer.md:439.** Two edits.
   - Replace "Selecting text raises `.mark-bubble` over the selection and reveals a keyboard-reachable `Quote selection` button in `.thread-tools`." with:

     > Selecting text raises the selection offer over the selection and reveals a keyboard-reachable `Quote selection` button in `.thread-tools`, which aims the sidebar composer.

   - Append to the end of the paragraph:

     > The tools that arm a gesture only arm it: the point, the region or the page box is made on the stage, so its comment is written on the stage. `Quote selection`, `Comment on this frame` and `Comment on this moment` set the target from the sidebar, so they aim the sidebar composer.

7. **viewer.md:449.** Replace "and the panel is centred on it, above the scrubber when there is room." with:

   > and the panel is centred on it, below the scrubber by preference and above it when below does not fit, because the picture under review sits above the scrubber.

8. **viewer.md:451.** After "a press or keyboard focus pins it while the press still seeks to the moment and pauses." insert:

   > Enter on a focused marker moves focus into the card.

9. **viewer.md, new paragraph after line 451.** This replaces the OTIO-only paragraph in the OTIO spec 5.7.

   > **A comment is written in a panel attached to its target, on every class, and the posted comment stays there.** For a verified reader, every gesture that sets a target on the stage opens the shared stage composer (`openComposer`, `inlineComposer`) beside that target: **Comment** on a selection offer, in the page or inside a frame; a point placed or a box drawn while pointing is armed, by pointer, touch or keyboard; a box dragged on a PDF page; a moment or span on the media scrubber; and a point, range or track selection on an OpenTimelineIO rail. While the panel is open its target is painted, as the provisional mark, the scrubber's pending span or the painted `.otio-selection`, and the panel names it. On a document the panel goes above the target by preference, because a panel below covers what the reader reads next; on a timeline it goes below by preference, because the picture under review sits above the timeline. Either flips when its side does not fit, and the panel never covers its target: when neither side holds the whole panel, the layer caps its height on the larger side and the context scrolls while the field, **Post** and **Cancel** stay on the card. A target taller than half the visible stage is attached by its first line, or by its top edge when it has no lines. The panel follows its target, measured live, when something inside the stage scrolls or when the frame of an `html`, `jsx` or `svg` relic scrolls, and it holds still while the target is out of view. Posting replaces the composer with the posted comment's card on its new mark, with **Reply**, **Edit**, **Resolve** and **Open in thread**, and focus moves into the card. The Comments sidebar is left exactly as it was, because below 44rem an open sidebar takes the whole row and would hide the comment just written. A mark's card opens the same way: after `MARK_HOVER_OPEN_MS` on hover, and pinned by a click, a tap or keyboard focus, and Enter on a focused pin or timeline marker moves focus into the card. Pressing a mark opens its card and nothing else; only **Open in thread** opens the sidebar. Escape and **Cancel** discard a draft and return focus to where the composer was opened, and a press elsewhere keeps a composer that holds text. A reader with no verified address is still sent to the sidebar, where the address is verified.

10. **docs/decisions.md, new entry appended at the end:**

    > ## 2026-10-24: Comments open at their target on every class, and classes that play in the browser carry no comparison notice
    >
    > **The composer is attached to its target, everywhere.** Jason Waldrip asked that comments popover the interface when he leaves them, chose a composer anchored at the selection that stays as the posted comment with the Comments sidebar left closed, and set the scope to every class: OpenTimelineIO timelines, media timelines, and every document class, pins and regions included. Before this, only a text selection and a timeline gesture reached the stage composer; a pin, a region, a framed point or box and a PDF page box opened the sidebar composer, and a post from the stage composer closed it and, for a text target, moved focus to the sidebar's field. This reverses 2ed14a3a (2026-10-22), which clamped the OTIO composer into the largest clear band of the video preview and scrolled the stage up to show it, so a comment on a lower track was written over the preview, away from the track it was about. It also reverses the rule in `viewer.md` §6.6 that selecting text or activating a pin target opens the sidebar. Documents place the panel above its target and timelines below, each flipping when its side does not fit; the panel never covers its target, follows it through inner scrolling and frame scrolling, and posting replaces it with the comment's card on its new mark. `docs/spec/viewer.md` §6.6 records the behaviour.
    >
    > **Pressing a mark opens its card and nothing else.** A pin press also opened the sidebar, a region press stopped at the region and opened no card, and a framed mark answered the page's request for its geometry with `relic:frame-mark-click`, the message a reader's press sends, which the page answers by pinning the card and opening the sidebar. The geometry answer is now its own message, `relic:frame-mark-rect`, and the frame keeps reporting a tracked mark's geometry as it scrolls.
    >
    > **No unprompted comparison notice on classes that play or render in the browser.** Jason reported the version 2 banner on an OTIO relic as false. `comparisonAvailability` treated every route without a comparison mode as download-only, so OTIO, media and PDF relics at version 2 or later opened under "This file is download-only", and the earlier-version view repeated the claim. All three render in the browser. Nothing on their page offers a comparison, because the taskbar control already reads "Earlier versions" and opens one version on its own, so the current page now says nothing about comparison, and an earlier version opened on its own says why in that class's words. Download-only and over-ceiling relics keep their notice on the current page. An earlier version shown on its own no longer repeats the stage notice under its own reason. This revises `viewer.md` §6.1 item 13, which grouped media with archives and binaries.

### 5.10 File ownership across workstreams A, B and C

Each workstream ships one PR from its own branch off origin/main at 76269ed5.

| Area | A: popovers and banner | B: load progress and key check | C: key phrase |
|---|---|---|---|
| **main.ts import block** | Names in the `./popover.ts`, `./annotate-frame.ts`, `./comments.ts`, `./otio-bridge.ts` and `./diff.ts` statements | Names in the `@relic/format` and `./viewer.ts` statements, plus new statements | One new statement for `./copy-link.ts` |
| **main.ts code** | `sandboxFrame`: one new branch after the mark-click branch (≈1003-1011). `buildCurrentStage` signature and notice block (1275-1285). 2485-2581. 3453-6681 | `buildBar` identity zone (604-630). `renderImageView` (831-854). `sandboxFrame` ready and tree branches (940-960). `renderPdfView` and `renderMediaView` (1146-1273). The OTIO case in `buildCurrentStage` (1304-1319). `renderComparison` (2748-2951). `renderReady` (7152-7278). `renderDead` (7280-7412). `makeBrowserDeps` and `boot` (7776-7827) | The Copy link button in `buildBar` (749-756) |
| **Other viewer source** | popover.ts, annotate-frame.ts, sandbox.ts, annotate-region.ts, comments.ts, otio-view.ts, otio-bridge.ts, diff.ts | viewer.ts, pdf.ts | New copy-link.ts, which lazily imports `@relic/format/mnemonic` |
| **styles.css** | The popover block (241-444) and the OTIO composer block (4128-4162) | New rules after `.stage-dead .accession` (after 1566), the key-entry block (3672-3711), and a `.stage-wrap` busy rule beside 103-109 | New rules after the toast block (after 3452) |
| **Viewer tests** | popover, annotate, annotate-region, annotate-authoring, annotate-time, annotate-frame, comment-write-contract, comment-card, timeline-popover, comments, otio-view, diff, version-view, version-diff-ui | load-plate, load-progress, viewer, version-history, dashboard-and-key-entry, browser | copy-link |
| **relic-mcp tests** | otio-path.ts, new comment-popover-path.ts | New load-progress-path.ts | None |
| **CI and PATH** | verify.yml step after "Notify path". A section appended at the end of root PATH.md. A section appended at the end of packages/relic-mcp/PATH.md | verify.yml step after "Cover path". A root PATH.md section inserted after the opening paragraph | None |
| **Docs** | viewer.md §6.1 item 13 and §6.6. decisions.md entry | viewer.md §6.3 and §6.4. format.md. service.md and `disclosureStatement`. decisions.md entry | viewer.md §6.5 and §6.8 if needed. decisions.md entry |
| **Mock directory** | docs/plans/anchored-popover/ | docs/plans/load-progress/ | docs/plans/copy-link-key-phrase/ |

**Rules.**

- **Stay in your column.** Nobody edits outside their column. Nobody edits the unowned regions: `openSharePanel` (6746-7150), the dashboard (7415-7774), `commentRow` and the sign-in form.
- **B and the render state.** B sets `data-render-state` from its own regions (`renderReady` and the renderers), never by editing `buildCurrentStage` 1275-1285.
- **A3's frame tests** go in annotate-frame.test.ts, not browser.test.ts.
- **C's scope.** C changes neither share.ts nor the share message.
- **Rebase before merge.** Merge PRs in the order they are ready. Before merging, each PR rebases onto the current origin/main and reruns `bun run verify` and its own proofs.
- **Expected conflicts.** Only these are expected:
  - the main.ts import block: keep both sides' names and let Biome sort them;
  - the decisions.md tail: keep every entry, in merge order;
  - adjacent lines in PATH.md or verify.yml, if a later edit moved an anchor.

  A conflict anywhere else means a boundary was crossed. Send it back to the owner of the slice that crossed it.

## 6. Slices (workstream A)

**Integration.** Integration happens on `feat/anchored-comment-popover`, cut from origin/main at 76269ed5, and A ships as one PR. The empty `feat/otio-anchored-comment-popover` branch has no commits past 76269ed5. It is superseded and stays unused.

**Order.**

1. A0 runs first.
2. Once the mock is committed and the main agent has loaded it and shown it to Jason, dispatch A1, A2, A3, A4, A5, A6a and A6b in one batch. Each works in its own worktree, cut from the integration branch.
3. Merge into the integration branch in this order: A1, A3, A4, A5, then A2. A2 rebases onto the branch and must compile against A1, A3 and A4. Then A6a and A6b.
4. Run §7, then A7.

**Dispatch rules.** Don't set `model` on any slice. Designer slices use `agent: designer`. Workers don't run builds or tests mid-flight; the main agent runs §7.

### A0. Mock (`agent: designer`)

**Files.**

- New `docs/plans/anchored-popover/mockup.html`.
- New `docs/plans/anchored-popover/plan.md`, containing this spec verbatim from `local://AnchoredPopoverEverywhereSpec.md`.
- New `docs/plans/anchored-popover/mock-shots/`.
- One HTML comment in the header of `docs/plans/otio/mockup.html`, saying its composer placement is superseded by `docs/plans/anchored-popover/mockup.html`.

**Build.**

- Follow the conventions of `docs/plans/otio/mockup.html`:
  - a CSP meta tag with `connect-src 'none'`;
  - inline CSS and JS;
  - tokens from styles.css;
  - a `data-theme` toggle (system, light, dark);
  - localStorage only, and no network.
- Add a class switcher and a width frame at 1440, 390 and 320. Respect the viewer's breakpoints (44rem, 34rem, 24rem).
- Every state must be reachable by clicks.

**States.**

- **OTIO.** The ten states of the OTIO spec's S1:
  1. The version 2 page with the sidebar closed: "Version 2 of 2", "Earlier versions", no notice.
  2. A point on V5 Video 2 at 00:00:00, with the composer below. Target "v1 · Relik Feature Editorial · Video 2 · point 0 @ 24", the full IDENTITY_DISCLOSURE text, placeholder "What is wrong with this, or what should change.", Post and Cancel. Re-aiming with the arrow keys keeps typed text.
  3. A range drag on V1 with the composer below, and a lower row where it flips above.
  4. Track mode on V4.
  5. Post: the same place now shows the card (reader@example.test, Oct 24, 2026, 01:11 PM, target block, "Duplicate Video 2 point, not the other track.", Reply, Edit, Resolve, Open in thread). The new active mark appears, Comments goes up by 1, and the sidebar stays closed.
  6. At 1440: hover opens after 140ms, closes 220ms after the pointer leaves, and a click pins.
  7. At 390: tap to pin; the timeline scrolled horizontally with the panel following; the panel holding while its anchor is scrolled out.
  8. Escape, Cancel, and an outside press that keeps the composer when text is typed.
  9. A capped composer in a short viewport.
  10. The earlier-versions view: "Version 1 of 2", the retained-history note, the notice "Relik cannot show version 1 of this timeline beside version 2. It is open here on its own.", and the label "Version 1: standard-sample.otioz".
- **Video.**
  - V1: a span dragged on the scrubber, with the composer below. Target "Commenting at 0:04 to 0:07".
  - V2: Post, then the card on the new span marker. Comments goes up by 1 and the sidebar stays closed.
  - V3: at 1440, hover a marker; the card opens after 140ms. A cluster card.
  - V4: at 390, with the scrubber at the bottom of the visible stage, the composer flips above.
  - V5: fullscreen, with the composer above the scrubber inside the stage.
- **Audio.**
  - A1: the hover comment button, with the composer below.
  - A2: Post, then the card.
- **Markdown.**
  - D1: the selection offer (Copy text, Comment, decline) above a sentence.
  - D2: Comment, then the composer above, with the dashed provisional mark.
  - D3: Post, then the card on the new mark. The sidebar stays closed, and its chip still reads "Commenting on the whole document".
  - D4: at 320x480, a whole paragraph selected; the composer attaches to its first line. A capped variant shows the field, Post and Cancel while the context scrolls.
  - D5: an armed pin, with the composer above the provisional pin. Post, then the card on the numbered pin.
  - D6: a pin press opens only its card.
- **Code.**
  - C1: a selection in a long line, with the composer open.
  - C2: the code block scrolled horizontally, with the panel following.
  - C3: the target scrolled out, with the panel holding still.
- **Image.**
  - I1: at 1440, the sidebar open with "Mark a region or point" armed. A region drag, with the composer above the provisional region.
  - I2: Post, then the card on the region badge. The sidebar is still open and its chip unchanged.
  - I3: a region press opens its card.
  - I4: the keyboard box plus Enter opens the composer.
- **PDF.**
  - P1: a box dragged on the page, with the composer open.
  - P2: Post, then the card.
  - P3: a page mark press opens its card.
- **HTML frame.**
  - F1: a selection inside the frame, then the offer, then the composer.
  - F2: the frame scrolled with the panel following, then scrolled out with the panel holding.
  - F3: hover a frame mark; the card opens and the sidebar stays closed.
  - F4: click a frame mark; the card is pinned.
  - F5: an armed point inside the frame, with the composer at the pin.
- **Unverified.** U1: Comment opens the sidebar, with the chip naming the quote.
- **Dismissal.** One document state each for Escape, Cancel, and an outside press that keeps a composer holding text.

**Not in scope.** packages/, a new art direction, a connector or caret.

**Acceptance.**

- Loaded in isolated headless at 1440x900, 390x844 and 320x480, in light and dark, the mock makes zero network requests and has no horizontal overflow at 320. Every state is reachable with clicks only.
- Every panel sits 8px from its target and never covers it, measured with the 5.8 rules.
- A screenshot of every state at every width and scheme is committed under `mock-shots/`.

### A1. Popover layer (task worker)

**Files.**

- `packages/relic-viewer/src/popover.ts`
- `packages/relic-viewer/test/popover.test.ts`
- `packages/relic-viewer/src/styles.css`, only the popover block (241-444) and the OTIO composer block (4128-4162)

**Change.**

- Implement 5.2 and 5.3.
- Move the composer column layout from `.popover-card.is-otio-composer` to `.popover-card.popover-composer`.
  - Keep the flex properties:
    - card: `display: flex; flex-direction: column; overflow: hidden; min-width: 0`;
    - body: `flex: 1 1 auto; min-height: 1.35rem; overflow-y: auto; overscroll-behavior: contain`;
    - field: `flex: 0 1 4.5rem; height: 4.5rem`, its min-height and `resize: none`;
    - tools: `flex: none` on the surface background.
  - Drop the compact padding and margin overrides, so the composer matches the standard card.
  - `.is-otio-composer` keeps no rules of its own.
  - The inner `.popover-composer` rule for Reply and Edit keeps working.
- Add `.popover[data-capped='true']:not(.popover-composer) { overflow-y: auto; overscroll-behavior: contain; }`.
- Rewrite the comment above the composer block so it describes anchored placement and capping for every composer.

**Not in scope.** main.ts, otio-view.ts, sandbox.ts, CSS outside the two blocks, and a connector.

**Acceptance.** These tests fail before the change and pass after:

- P1 to P7, R1 to R5, and T1 to T4.
- Layer tests, using `installDom`, `clearDom` and `Node` from test/annotate.test.ts:
  - `reposition()` re-measures `follow`.
  - When `follow` returns `undefined`, a panel already placed holds.
  - The first `show()` places the panel from the passed anchor even while `follow` returns `undefined`.
  - Showing new content without options drops `follow`.
  - `data-capped` is set and cleared.
  - A vertical inner scroll moves `top` by the anchor's change and keeps the side.
  - A horizontal inner scroll changes `left` only.
  - `track()` applies the same rule.
  - `hide()` removes every listener.
- Delete popover.test.ts:119-164, the `bounds` tests.

### A2. Thread and gesture wiring for every class (task worker, effort hi)

**Files.**

- `main.ts`, limited to:
  - the import statements for `./popover.ts`, `./annotate-frame.ts`, `./comments.ts` and `./otio-bridge.ts`;
  - the new `sandboxFrame` branch right after the `isFrameMarkClickMessage` branch (≈1003-1011);
  - lines 3453-5052, from the pin geometry through `buildMarkControls`;
  - lines 5093-6681, `buildThread`.
- `comments.ts`, for `PostResult.commentId`.
- `annotate-region.ts`: delete the posted region's click listener (85-94) and nothing else.
- Tests:
  - annotate.test.ts. Add a `mount()` option: POST returns `comment_id`, and later thread GETs include the posted row. `installDom`, `clearDom` and `Node` keep their signatures.
  - annotate-region.test.ts, annotate-authoring.test.ts, annotate-time.test.ts, comment-card.test.ts, timeline-popover.test.ts and comments.test.ts.

**Change.**

- Implement 5.1, 5.4 and 5.6, and the page side of 5.5.
- Delete `ComposeOptions.bounds`, the bounds plumbing in `aimTemporal` and `openComposer`, and the safe-band scroll block.

**Not in scope.** popover.ts and styles.css (A1). annotate-frame.ts and sandbox.ts (A3). otio-view.ts and otio-bridge.ts (A4). main.ts 1275-1285 and 2485-2581 (A5). Every region owned by B or C (5.10). The server and the format package.

**Depends on.** A1, A3 and A4's exports. It integrates after them.

**Acceptance.** These tests fail before the change and pass after:

- **Text** (annotate.test.ts):
  - Post from the stage composer leaves exactly one `.popover-card` with `data-comment-id` "c1" and `data-anchor-kind` "quote". It has Reply and Open in thread and no field. `.thread-toggle` `aria-expanded` stays "false", and the sidebar's `.compose-textarea` is not focused.
  - While open, the composer paints `pending:target` on the words, and Cancel removes it.
  - A second Comment while the field holds text keeps the text and moves the target.
- **Pins** (annotate.test.ts):
  - On a verified mount, an armed click opens the stage composer. The chip stays "Commenting on the whole document" and the thread stays closed. Post puts the card on the new pin.
  - On an anonymous mount, today's sidebar behaviour holds: the chip reads "Commenting on a point" and the thread opens.
- **Mark presses** (comment-card.test.ts):
  - Pressing a posted pin opens its card, and the thread stays closed.
  - Pressing a posted region opens its card.
  - Enter on a focused pin opens the card and focuses its first action, and Escape returns focus to the pin.
- **Gesture routing** (annotate-region.test.ts and annotate-authoring.test.ts, with stub deps):
  - With `compose` returning true, each of these calls `compose` with the right anchor kind and never calls `open` or `focusBody`, and the tool disarms:
    - an armed image drag;
    - the keyboard box plus Enter;
    - a plain armed click;
    - a PDF canvas drag;
    - `relic:frame-point` and `relic:frame-region` with a `box`, which pass the converted box.
  - With `compose` absent or returning false, every existing test passes unchanged.
  - When `compose` succeeds, a PDF drag leaves the chip's label unchanged.
- **Media** (timeline-popover.test.ts):
  - New: the composer opens below `AT` when there is room, and above when there isn't.
  - Rewrite the assertion at line 147 so Post leaves exactly one card with `data-comment-id` "c1", Reply and Open in thread, no field, and `aria-expanded` "false".
  - The other tests in 95-200 pass unchanged.
- **OTIO** (timeline-popover.test.ts 203-297 rewritten, and comments.test.ts):
  - The composer opens below the selection when there is room, and above when there isn't.
  - Re-aim keeps the panel, the field, the draft and the focus policy, and posts the latest target.
  - Post leaves exactly one card with `data-comment-id` "c1", Reply and Open in thread, no field, and `aria-expanded` "false".
  - comments.test.ts:689 expects `commentId: 'c9'`, and a response without `comment_id` gives `null`.
- **Frames** (the framed section of annotate.test.ts):
  - A `relic:frame-mark-click` opens the pinned card, and the thread stays closed.
  - A hover card stays unpinned when a `relic:frame-mark-rect` for its id arrives, and it closes when the pointer leaves.
  - A `relic:frame-mark-rect` for the followed id moves the open panel.
  - After Post on a framed stage, the page posts `relic:track-mark` for the new id, and the card opens at the rect the frame reports.
  - A row press on a framed stage opens the card when the rect arrives.
  - `closeCard()` posts `relic:track-mark` with `null`.
- The stub DOM models neither focus return nor real scrolling; the browser proofs cover both.

### A3. Frame protocol (task worker)

**Files.** `annotate-frame.ts`, `sandbox.ts`, `test/annotate-frame.test.ts`, `test/comment-write-contract.test.ts`.

**Change.** Implement the frame side of 5.5 and the validators.

**Not in scope.** main.ts, where A2 owns the page side, and browser.test.ts, which belongs to B.

**Acceptance.** These tests fail before the change and pass after:

- **Validators:**
  - `relic:track-mark` is accepted with a string id or `null`.
  - `relic:frame-mark-rect` is accepted with an id and an optional `rect` or `first`.
  - A malformed `rect`, `first` or `box` rejects the whole message.
  - Point and region messages are accepted with and without a `box`.
- **Frame behaviour:**
  - `relic:track-mark` posts a report at once.
  - A scroll then posts one report per animation frame.
  - A paint-mark followed by a track-mark reports the new mark.
  - A quote mark split across two elements reports their union and its first line.
  - Untracking stops the reports.
  - `relic:active-mark` replies with `relic:frame-mark-rect`, never `relic:frame-mark-click`.
  - An armed click posts `relic:frame-point` with a 20 by 20 box centred on the click.
  - A drag posts `relic:frame-region` with the band's box.
- The existing frame tests still pass: selection, point, region, click, hover, quiet and active. Only the active-mark reply assertion is updated.

### A4. OTIO view (task worker)

**Files.** `otio-view.ts`, `otio-bridge.ts`, `test/otio-view.test.ts`.

**Change.**

- Implement the OTIO parts of 5.1: `measure(commentId?)`, the clip and the fallback.
- Implement `emitAim` as described in 5.4.
- Delete `previewSafeBand` and `measureBounds`.

**Not in scope.** main.ts.

**Acceptance.** These tests fail before the change and pass after:

- otio-view.test.ts:1017 is rewritten: the aim has no `measureBounds`, and `measure()` returns the clipped selection.
- `controller.measure(id)` returns the visible piece, and `undefined` when the mark is scrolled out.
- Comment expands a collapsed ancestor track and adjusts `scrollLeft` before it dispatches.

### A5. Banner and docs (task worker)

**Files.**

- `diff.ts`.
- `main.ts`, limited to the `./diff.ts` import, `buildCurrentStage`'s signature and notice block (1275-1285), and 2485-2581.
- Tests: diff.test.ts, version-view.test.ts, version-diff-ui.test.ts.
- `docs/spec/viewer.md`, only §6.1 item 13 and §6.6.
- `docs/decisions.md`.

**Change.** Implement 5.7 and write the 5.9 text.

**Not in scope.** The taskbar labels and aria (main.ts:714-744). The download and oversize copy. `renderComparison`. The OTIO case and the renderers in `buildCurrentStage`, which belong to B.

**Acceptance.** These tests fail before the change and pass after:

- otio, media and pdf give `comparison_not_supported`. The detail never says "download-only", and it names the class's noun.
- `unpromptedComparisonNotice` returns `undefined` for those three, and the detail for download and oversized relics.
- `uncomparableReason` gives the noun sentences.
- `renderLoadedVersion(code v3, download v2)` has exactly one `.notice`.
- A version 3 relic of a class that plays in the browser shows no `.notice` in `buildCurrentStage`. Test it on media, the stub-safe route.
- The tests at version-diff-ui.test.ts:803-863 still pass unchanged.

### A6a. OTIO proof (task worker, effort hi)

**File.** `packages/relic-mcp/test/otio-path.ts`.

**Change.** This is the OTIO spec's S5, restated. The composer selector is `.popover-card.popover-composer.is-otio-composer`.

- **Composer checks.** Replace the preview-band checks in `measureComposer`, `assertComposerProbe` and `assertComposerContextAllocation` (≈3325-3523 and 3525-3862) with the 5.8 checks. Delete the native-control intersection, hit and safe-region code.
- **Lower track** (≈7784-7829). Replace ≈7806-7809 with the 5.8 checks, and keep the check that the page did not scroll.
- **`postComposer`.** After the body appears, assert the posted card: attached to the new mark, no overlap, sidebar untouched, focus inside the card. Then press Escape and assert the card closed.
- **Pointer cases** (≈4401-4564) **and the coincident reveal** (≈5133-5478). Add adjacency and no-overlap checks between card and mark.
- **Matrix** (≈7381-7483). Reset `.stage-wrap` scrollTop and the timeline's scrollLeft after every dismissal.
- **New `runAnchoredPopoverScenario`:**
  - It runs on a `force_new` relic, using the rate-limit clock pattern at ≈5150-5226.
  - It covers 1440, 390 and 320 wide, light and dark, in point, range and track mode: composer, Post to posted card, then Escape.
  - At 1440, hover a mark. At 390 and 320, tap one, with touch emulation. Click a mark at every width.
  - At 1440 light, the keyboard path. Enter on a rail; Escape returns focus to the rail. Focus a mark and press Enter; focus is in the card; Escape returns focus to the mark.
  - At 390 light, the panel follows a horizontal scroll, and holds while its anchor is hidden.
  - At 320x480 light, scrolling the stage keeps the panel attached.
  - Press outside the composer with text in it (the composer stays) and without (it closes).
  - Screenshots are named `anchored-<w>-<scheme>-<state>.png`, and measurements go in `anchored-popover-measurements.json`.
- **Version insert** (≈8316-8382):
  - The current stage has no comparison notice.
  - Clicking `[aria-label="Open an earlier version of this relic"]` shows exactly one `.diff-single .notice`, whose text matches the timeline sentence with the computed versions.
  - Take screenshots of both.

**Not in scope.** Product code. Keep `OTIO_PATH_OK`, playback, encryption, readback and the zero-mail checks.

**Acceptance.**

- The integrated branch passes with the owned shell and ends with `OTIO_PATH_OK`.
- Run against origin/main's viewer, the harness fails at the first anchored check. Save that receipt under `docs/plans/anchored-popover/proof/`.

### A6b. Media and document proof (task worker, effort hi)

**Files.**

- New `packages/relic-mcp/test/comment-popover-path.ts`.
- `.github/workflows/verify.yml`: one step inserted right after the "Notify path" step. That job already has ffmpeg and google-chrome.
- `packages/relic-mcp/PATH.md`: a section appended at the end.
- Root `PATH.md`: a section appended at the end, after the OTIO section. It carries the PATH sentence from §1 and the command.

**Build on the existing harness modules:**

- `test/browser-headless.ts`: `createBrowserHeadlessLaunch`, `attestBrowserHeadless`, `cleanupOwnedBrowserStartup`;
- `src/cover/cdp.ts`: `connectPipe`;
- `src/cover/chrome.ts`: `discoverChrome` and `chromeArgs`;
- the server bootstrap at `cover-path.ts:75-125`: `Bun.serve` with `createApp`, `MemoryStore`, `MemoryStorage` and `diskAssets`;
- the verified-reader session pattern at `otio-path.ts:105-165`;
- the `callMcp` publish pattern;
- the fixture pattern at `cover-path.ts:326-437`: `writeFile` into a scratch directory, and ffmpeg lavfi for media.

**Configuration.**

- Chrome comes from `RELIC_POPOVER_CHROME_PATH`, falling back through `discoverChrome`.
- The viewer comes from `RELIC_POPOVER_VIEWER_DIST`, defaulting to `packages/relic-viewer/dist`.
- All writes go to the in-memory loopback services.

**Fixtures:**

- a long markdown file containing one paragraph at least 600px tall at 320 wide;
- a code file with a line of at least 300 characters;
- a PNG of 1600 by 1000;
- a one-page PDF;
- an HTML document that scrolls at least 2000px inside the frame;
- an SVG;
- a JSX component;
- a 12 s MP4 and a 12 s MP3.

**Matrix.**

- Run at 1440x900, 390x844 and 320x480, in light and dark.
- Use a fresh browser context for each class and run.
- Emulate touch at 390 and 320.

**Per class.** "Check" means the 5.8 checks for the composer or the posted card.

1. **Markdown.**
   - Select a sentence and press Comment; check the composer. Type and Post; check the posted card, that focus is inside it, and that the sidebar is untouched. Escape closes the card.
   - Open a mark's card three ways, with the sidebar untouched throughout:
     - at 1440, hover a mark; the card opens no sooner than 140ms after;
     - at 390 and 320, tap a mark;
     - at every width, click a mark.
   - At 320x480, select the tall paragraph. The composer is adjacent to the first line and doesn't overlap it, and a capped composer is usable.
   - An outside press keeps a composer with text and closes one without.
   - With an anonymous reader at 1440 light, Comment opens the sidebar, and the chip names the quote.
2. **Code.**
   - Select within the long line and open the composer.
   - Scroll `.code` 120px horizontally with the target still visible; the follow checks pass.
   - Scroll the target out; the card's rect doesn't change.
3. **Image.**
   - Arm `Mark a region or point`. At 1440 the sidebar is open to do this. At 390 and 320, open the sidebar, arm, then close it.
   - Drag a region and check the composer against the provisional region. Post, and check the card on the region with the sidebar state unchanged.
   - Clicking the region opens its card.
   - At 1440 light, take the keyboard path: arm, press the arrows, press Enter, and the composer opens. Escape returns focus to the stage.
4. **PDF.**
   - Drag a box on the page; check the composer.
   - Post; check the card.
   - Clicking the page mark opens its card.
5. **HTML.**
   - Select text inside the frame using CDP input at frame coordinates, then press Comment; check the composer.
   - Scroll the frame 200px with the wheel, with the target still visible. The follow checks pass after the frame's report. Scroll the target out, and the card's rect doesn't change.
   - Post, and the card appears at the new frame mark.
   - Hover a frame mark. The card opens and stays unpinned, so moving away closes it, and the sidebar is untouched.
   - Click a frame mark. The card is pinned and the sidebar is untouched.
6. **SVG.** Arm `Point at something` and click inside the frame. Check the composer against the pin's box, then Post.
7. **JSX.** Select text, press Comment, and Post.
8. **Video.**
   - Drag a span on the scrubber. The composer is below when below fits.
   - Post, and the card sits on the new marker.
   - At 390, with the scrubber at the bottom of the visible stage, the composer flips above.
9. **Audio.** Hover the scrubber, press the comment button, and the composer opens below. Post.

**Output.**

- Screenshots are named `popover-<class>-<w>-<scheme>-<state>.png`. They go with `comment-popover-measurements.json` in `comment-popover-path-shots/`.
- The last line printed is `COMMENT_POPOVER_PATH_OK classes=9`.
- The CI step runs with `RELIC_POPOVER_CHROME_PATH="$(command -v google-chrome)" env -u DISPLAY -u WAYLAND_DISPLAY` and uploads the shots directory as an artifact.

**Negative control.**

- Run the harness against a viewer dist built from origin/main at 76269ed5.
- It must fail at a behavioural check that uses selectors present on main: the posted card after a markdown Post, or the sidebar after a frame mark hover. A missing `data-anchor-kind` does not count.
- Save the receipt under `docs/plans/anchored-popover/proof/`. The receipt either shows the frame-hover sidebar defect from correction 3, or states that it did not reproduce.

**Not in scope.** Product code, cover-path.ts and otio-path.ts.

**Acceptance.**

- The integrated branch ends with `COMMENT_POPOVER_PATH_OK classes=9`, run with the owned shell.
- The negative-control receipt is committed.

### A7. Designer rendered review (`agent: designer`, after the A6a and A6b runs)

**Inputs.** The shots and measurement JSON from both harnesses, and the mock.

**Checks.**

- Every panel is visibly attached, and the thing it points at is not covered. That thing is the selection, the provisional mark, the active mark or the scrubber span.
- On every class the composer and card look like the document popover card: square, ruled, patina primary, Charter body, mono target. That includes over the frame and in video fullscreen.
- On video, a panel below the scrubber leaves the picture under review uncovered.
- At 320 nothing is clipped, and a capped panel still shows its field, Post and Cancel.
- Post contrast is at least 4.5 in both themes.
- Focus rings are visible.
- Dark mode matches light.
- The version banner states read correctly.

**Output.** Pass, or defects tied to shot names. No edits.

## 7. End-to-end check

Run this in the integration worktree:

```
mise exec -- bun run verify
mise exec -- bun run --cwd packages/relic-mcp build
RELIC_OTIO_CHROME_PATH=/Users/jwaldrip/.omp/owned-shells/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell mise exec -- bun packages/relic-mcp/test/otio-path.ts
RELIC_POPOVER_CHROME_PATH=/Users/jwaldrip/.omp/owned-shells/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell mise exec -- bun packages/relic-mcp/test/comment-popover-path.ts
```

The runs end with `OTIO_PATH_OK` and `COMMENT_POPOVER_PATH_OK classes=9`, with every new check passing. Then:

1. Archive both shot sets under `docs/plans/anchored-popover/proof/<sha>/`.
2. Update the "passed locally" lines in both PATH.md sections.
3. Run A7.
4. Open the PR and merge it.
5. After deploy, check read-only:
   - The deployed `viewer.js` served by relik.link contains `relic:track-mark` and `data-anchor-kind`.
   - A version 2 OTIO relic opened in isolated headless shows no banner.

   Do not sign in or post on production.

## 8. What would prove this spec wrong

- **Jason rejects the mock.** He might reject the per-class placement, the media controls bar being covered by a panel below, or the sidebar-set exception, or want above-first for timelines. Stop and ask.
- **320x480 runs out of room.** After reveal, the larger side next to a tall target or a 54px rail can't hold the field, Post and Cancel.
- **Frame tracking lags.** In Chrome the frame's report trails the frame's scroll by more than two frames. Or real geometry fails validation.
- **The posted card can't find its mark.** For in-page classes `anchorBoxFor(newId)` is `undefined` when `refresh()` resolves, or `awaitFrameRect` times out. Either way the card lands on the fallback box and the adjacency check fails.
- **Painting under a live selection breaks it.** Painting the provisional mark under a live selection breaks the selection or the offer in a real browser.
- **Something paints above a popover.** A hit check shows it. Likely culprits: `.otio-comment-mark.is-active` (z-index 8, the same as `.popover`), `.time-marker-cluster.is-active` (5), and the sticky OTIO labels.
- **The window scrolls.** Either reveal path changes `window.scrollY`.
- **No `comment_id` in production.** A deployed server build leaves it out of the POST response.
- **ResizeObserver loop errors.** They appear in either harness log.
- **A negative control passes.** The new checks pass on origin/main, so they don't measure attachment.
- **An existing proof breaks.** Removing the sidebar opening from mark presses breaks a proof that relied on a mark press to reach the sidebar. The OTIO sidebar reveals use rows, but check.
