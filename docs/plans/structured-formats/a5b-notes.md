# A5b notes: viewer integration

Branch `sf-a5b-viewer`. Commits: `8c3f17dd` (WIP, pushed by Main after a rate limit),
`76678dfd` (the wiring, tests and the fixes below). `feat/structured-formats` (`f0f2b45b`,
A5a MCP resolution) is merged in. `packages/relic-mcp` is untouched by this slice.

## What the slice closes (A0 to A4 open items)

1. **The composer opens for the structured views' comment actions.** The tree, notebook and
   table dispatch `relic:structured-comment` with `detail.anchor`. A listener on the stage
   (`buildMarkControls` attach, behind a `structuredBind` once-only guard) opens the composer
   on that anchor through `aimOnStage`, as a selection does.
   - **Table selection.** `offer()` asks the drawn view for `selectionAnchor()` before refusing
     empty text. Cell text is not selectable (the grid is `user-select: none`), so a cell
     selection has no words, and it was refused before this change. The offer names the
     selection through the anchor label, and offers Copy only when there are words.
   - **Column header.** The header's Comment button selects row 1 of its column and dispatches
     `relic:structured-comment` with that `cell` anchor. The capture listener still stops the
     click reaching the sort.
   - **Cue (`time`).** The cue view's existing selection path reaches `offer()`, so a cue
     needs no new code.
2. **Legacy quote marks stay out of structured rows.** `quoteAdapter.supports` returns false
   when `drawnTextView(host)` is set (tree, notebook or table). `structuredQuoteAdapter` is
   registered after it and places the mark through the view's `paintMark`. `paintMarks` routes
   a `text` anchor the same way. A table cannot place a quote, so it declines it, and the
   comment reads as unplaceable (not wrapped into the grid).
3. **View source toggle, both ways.** The bridge's `showSource` was one-way. `StructuredViewHandle`
   now has `showStructured()`, `showingSource` and `structuredAvailable`. The page redraws the
   view on return (a redraw starts with no marks), and `relic:structured-state` tells the
   stage to repaint marks. The toggle sits in `.toggle-row` (`renderStructuredView` in
   `main.ts`): "View source" becomes "View table", "View tree", "View subtitles" or
   "View notebook". The row is hidden when the file was refused and nothing is drawn.
   `relic:structured-state` carries `'structured'` when a view drew the file, `'source'` otherwise.
4. **Precache and smoke list.** `build.ts` puts the four view stylesheets in `shellAssetFiles`
   (so they enter the build hash and the service worker's `addAll`). `sw-cache.ts` `SHELL_ASSETS`
   carries them as the fallback, and `scripts/deploy-smoke.sh` line 28 checks each one. The
   lazily loaded view modules are already precached: `shellAssetFiles` includes every chunk.
   `shell-budget.test.ts` asserts the precache list and the emitted files.
5. **`familyOf` treats a `time` anchor on a drawn cue list as `document`.** This was already
   in `main.ts`, so no change was needed. The cue case in the browser test covers the chip.
6. **Table quote outlines: left, not built.** Outlining a quote on a cell needs a text-to-cell
   resolver the table does not have (A1 notes, item 6). Recorded here for A6 or later.

## Defects found and fixed while testing

- **The chip and the card read the media wording for a subtitle.** `openComposer` and the thread
  card called `markTargetLabel(anchor)` without the stage's surface, so the media `time` adapter
  answered ("Commenting at 0:01 to 0:04"). Both now pass `anchorSurfaceFor(host)`, as `paintChip`
  does (A3 notes, item "A0 note, fixed", named this call site as the one to pass the surface).
- **A table selection was never offered** (see item 1 above).

## Test and verification

- `packages/relic-viewer/test/structured-comments.test.ts`: one browser test, seven cases, in
  the owned headless shell. The page runs the real stage, selection offer, composer, thread and
  mark painting from `main.ts`. Only the transport is a stub, and it keeps what it is sent.
  Each case reads the anchor from the sealed body it was posted with.
  1. A CSV cell (record 1, column 1) posts `{kind:'cell', row:2, col:2}`.
  2. A column header comment posts `{kind:'cell', row:1, col:2}`.
  3. A JSON node posts `{kind:'path', pointer:'/name'}`.
  4. A cue posts `{kind:'time', t:1.2, t_end:4.8}`, and the chip reads the subtitle wording.
  5. A notebook cell posts `{kind:'path', pointer:'/cells/1'}`.
  6. A legacy `quote` on a drawn tree paints no `mark.relic-text-mark`, and the generic quote
     adapter declines it.
  7. A cell comment paints; View source replaces the table with the source; View table brings
     the table back with its mark.
- `structured-view-bridge.test.ts`: the refused-file event sequence is updated to
  `relic:structured-state` `'source'`, then `relic:render-state` `'ready'`.
- `shell-budget.test.ts`: the structured-view stylesheets are precached and emitted.
- `bun test packages/relic-viewer` with `RELIC_CHROME_PATH` set to the owned headless shell:
  **2174 pass, 0 fail, 122 files, 217,953 expect() calls.**
- `bunx tsc --noEmit` clean in `relic-viewer`.
- `bun run --filter '*' typecheck` from the repo root: `@relic/format`, `@relic/server`,
  `@relic/viewer` and `relic-mcp` all exit 0.
- `bunx biome check` clean on the ten touched files.

## Not proven (say so in any report)

- **The transport is a stub.** The page posts to a fake that keeps what it is sent. No
  relic was published and read back through the real service in this slice.
- **Deploy smoke is not run.** `scripts/deploy-smoke.sh` needs a deployed `SERVICE`. The asset
  line is edited and the four files are emitted by the build test, not fetched from a server.
- **Mobile layout** at 390 px is CSS only, not measured in this slice.
- **Other browsers.** Chrome headless only.
- **The table's quote outline** (item 6) is not built, so such a comment reads as unplaceable.
- **Suggesting** (C-slices) is not touched here.
- **MCP resolution** of these anchors is A5a's, merged in and not re-tested here.
