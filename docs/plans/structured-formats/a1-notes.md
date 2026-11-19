# A1 table: notes for the path stage (A5)

Slice A1 (plan section 8) builds the CSV and TSV table: the parser
(`packages/relic-format/src/csv.ts`), the table view (`data-table.ts`,
`csv-view.ts`, `data-table.css`), and cell comments on it.

## What the path stage `table` should drive

`structured-formats-path.ts` stage `table` opens a `.csv` and a `.tsv` relic
in an isolated headless browser and checks the following, in order.

1. **Draw.** The route is `code`, the view is `table`, and the root has class
   `structured-table`, `.dt`, and `role="grid"`. The summary line reads
   "N rows · M columns · comma-separated" (or semicolon, tab, pipe).
2. **Header and letters.** The sticky header shows column letters and the
   first record's names. The row-number column starts at 1.
3. **Refusals.** A file the parser refuses (unclosed quote, NUL byte, over
   the byte, cell, column or row limit, empty) shows the source view with a
   `.structured-notice` line above it. The notice text is the one in
   `csv-view.ts` (`unreadableTableNotice`).
4. **Comment on a cell.** Click a body cell, then the stage's comment chip.
   The chip reads "Commenting on cell C14". The comment writes a `cell`
   anchor with `row: 14, col: 3`. Its mark is painted on that cell, and
   `paintMark` returns true.
5. **Comment on a range.** Drag from B4 to D9 in file order. The chip reads
   "Commenting on cells B4 to D9". The anchor is `row: 4, col: 2, row_end: 9,
   col_end: 4`. Eighteen cells carry `is-range`.
6. **Sort keeps marks.** Click a numeric header. The rows reorder by value
   (qty ascends), and each mark stays on its record. Check the cell at
   `data-r` 13, `data-c` 2 still carries `is-marked` after the sort.
7. **Sorted selection.** After a sort, a drag does not form a range. A single
   cell's chip names the record it sits on.
8. **Reveal.** `reveal(anchor)` from a comment in the thread selects the
   cell, scrolls to it, and makes `selectionAnchor()` return that anchor.
9. **Hostile cells.** A cell holding `<img onerror>` or `<script>` creates no
   `img` or `script` element, and the text shows literally.
10. **Bidi.** A cell holding U+202E shows `\u{202E}`, not the raw character.

Selectors for the stage: `.dt-grid[role=grid]`, `.dt-row`, `.dt-cell[data-r][data-c]`,
`.dt-hcell[data-c]` for headers (sort on click), `.dt-hc-comment` for the
column comment button, `.dt-cellbar` for the inspector, `.dt-find` for find.

## Contract details a later slice relies on

- **Coordinates.** Record 1 is row 1, including when it is drawn as the header.
  A header cell is `row: 1`. A column-header comment is a `cell` anchor on
  row 1 of that column. The contract has no column-only kind.
- **Selection leaves through the document.** The view writes its selection
  into `document.getSelection()` as a range over its first and last cells.
  The stage's existing offer reads that on mouseup and keyup, and asks the
  view for `selectionAnchor()`. The view never writes a comment.
- **Empty cells.** An empty cell is drawn as the word "blank" in muted text,
  so it has selectable text and the offer can appear. The inspector shows
  "(blank)" and Copy copies an empty string.
- **Find** searches the drawn columns only, up to 10,000 hits, and moves the
  selection without placing the chip (the find box stops keyup from reaching
  the stage).

## Limits, and where they differ from the plan

- The plan's table limits are 32 MiB, 5,000,000 cells, 16,384 columns,
  and 256 drawn columns. All four are enforced in `csv.ts`, and the
  test for the 50,000 by 256 fixture refuses at the cell limit.
- **Rows: 600,000.** The plan names no row limit. Browsers cap an element's
  height (Firefox at about 17.9 million pixels), and the table's scroll
  height is rows times 28 pixels. A row limit of 600,000 keeps the height
  under that cap. Files past it show the source view with the too-large
  notice. This is a choice made here, not a plan figure; Jason should
  confirm it.
- **50,000 rows** appears in the brief and the mock as a sample size, not a
  limit. The plan's cell limit allows 50,000 rows of up to 100 columns.

## Deliberately not done in A1

- **Quote and text comments on table cells** are not yet found in the source
  and outlined on their cells (plan section 5). `paintMark` returns false for
  `quote` and `text` anchors, so such a comment reads as unplaceable.
  Behaviour for old comments needs the A0 route or A5.
- **Visual review** at 1440 px and 390 px has not been done against the mock.
  The stylesheet is written from the mock's classes, but nothing has looked
  at it in a browser with the viewer's own CSS.
- **Suggestions** (plan section 6, slice C1) are out of scope.
- **Horizontal virtualisation.** All drawn columns (up to 256) are in the DOM
  for each drawn row. Rows are virtualised.

## Changes outside the view

- `packages/relic-format/package.json`: one `./csv` subpath export.
- `packages/relic-viewer/src/structured-view-bridge.ts` (A0 file): a
  `reportUnshown(reason)` hook on `StructuredMount`. A view that cannot show a
  file calls it and returns `undefined`, and the bridge draws the reason above
  the source. Before this, a fallback drew the source with no reason.
- `packages/relic-viewer/src/table-model.ts` (A0 file): `order` is typed
  `Uint32Array | undefined`, so a sort can be cleared under
  `exactOptionalPropertyTypes`.
- `packages/relic-viewer/build.ts`: one copy line for `data-table.css`.
