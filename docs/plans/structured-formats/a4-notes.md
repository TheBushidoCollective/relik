# A4 notes: notebooks (`.ipynb`)

Branch `sf-a4-notebook`, on top of `feat/structured-formats` at `f7db5687` (A1 table,
A2 tree, A3 cues, A0 bridge). Input: plan section 4 (notebook row and output policy),
section 5 (`path` anchors), section 7 (notebook view), and the mock's states N1 to N6
(`docs/plans/structured-formats/mockup.html`, the `NB_CELLS` fixture and `notebookView`).

## Stage `notebook` for A5

The path script should prove, on a published `.ipynb` relic, through the real entry path:

1. The file opens as a notebook: the summary line reads `N cells · nbformat 4 · ... KB`, cells
   are `li.nb-cell`, the markdown heading is an `h1`, and `In [n]:` gutters show the execution counts.
2. A PNG output draws as an `img` whose `src` starts with `blob:`. A JPEG declared as `image/png`
   draws no `img` and shows "This image output could not be shown."
3. An HTML output shows "This output is HTML (or a widget) and is not run here." with "Show as text".
   No `script` element exists on the page. Show as text reveals the text/plain fallback.
4. A notebook whose markup is hostile (`<img onerror>` in markdown, source, stream, error and
   metadata) creates no `script`, `svg`, `iframe`, `object`, `embed` or `img` element and no `on*` attribute.
5. Select cell 3 and comment on it through the real offer. The mark paints on that cell
   (`.nb-mark` on `li.nb-cell[data-cell="3"] .nb-box`), and the thread card reveals it.
   The anchor is `{kind:'path', pointer:'/cells/3'}`.
6. Comment on an output (its Comment button). The anchor is `/cells/N/outputs/M`.
7. A quote comment written in Source mode (`quote`) paints on the cell or output that holds it.
8. A 10,000-cell notebook shows the too-large notice above its source.
9. `/assets/notebook-view.css` returns 200 and the cells are styled (gutter, boxes, marks).

Pointers are 0-based array indices, per RFC 6901: `/cells/0` is the first cell. The view's
labels are 1-based ("Comment on cell 1"). A5 should not assume the two match.

## What shipped

- `packages/relic-format/src/notebook.ts`: the model. `parseNotebook(source)` returns
  `{ok, notebook}` or `{ok:false, refusal}`. It never throws. It is built on the A2
  JSON reader (`parseJsonTree`), and it does not keep the tree after reading.
  Also exported: `notebookTarget(notebook, anchor)` (path, quote, source, text anchors to a cell
  or output), `notebookPointer`, `ansiSpans`, `escapeInvisible`, `decodeBase64`,
  `imageFormatOf`, and the `NOTEBOOK_*` limits.
- `packages/relic-format/test/notebook.test.ts`: 35 tests. Refusals, cells, outputs, the
  withheld policy, images, hostile text, ANSI with malformed escapes, bounds, anchors.
- `packages/relic-viewer/src/notebook-view.ts`: the view that replaces the A0 stub.
  `notebookNotice(refusal)` gives the notices.
- `packages/relic-viewer/src/notebook-view.css`: the view styles, plus the N6 narrow rules.
- `packages/relic-viewer/test/notebook-view.test.ts`: runs the 12 browser cases in the owned
  isolated headless shell. The cases are in `notebook-view-cases.ts`, a module the page
  imports, so no test function is serialised into a script tag (that broke the first runs).
- `packages/relic-format/package.json`: one `./notebook` subpath export.

## Exports for A5

From `@relic/format/notebook`:

- `parseNotebook`, `Notebook`, `NotebookCell`, `NotebookOutput`, `NotebookBody`,
  `NotebookRefusal`, `NotebookResult`, `NotebookTarget`, `NotebookText`, `CellKind`,
  `OutputType`, `ImageFormat`, `ImageRefusal`, `WithheldKind`, `AnsiSpan`.
- `notebookTarget(notebook, anchor)`: the cell or output an anchor names, or `undefined`.
- `notebookPointer(target)`: `/cells/N` or `/cells/N/outputs/M`.
- `ansiSpans`, `escapeInvisible`, `decodeBase64`, `imageFormatOf`.
- `NOTEBOOK_MAX_CELLS` (5,000), `NOTEBOOK_MAX_OUTPUTS_PER_CELL` (200), `NOTEBOOK_MAX_OUTPUTS`
  (20,000), `NOTEBOOK_TEXT_MAX_CHARS` (1,048,576), `NOTEBOOK_IMAGE_MAX_BYTES` (16 MiB),
  `NOTEBOOK_IMAGES_MAX_BYTES` (64 MiB), `NOTEBOOK_IMAGES_MAX_COUNT` (500).

From `packages/relic-viewer/src/notebook-view.ts`: `mountView`, `notebookNotice`.

For MCP `resolve-anchor.ts` (A5, `path` on `/cells/N` and `/cells/N/outputs/M`): `notebookTarget`
does the resolution. Its refusal of a non-canonical index (`/cells/01`, `/cells/-1`) and an
out-of-range index is the same check the view uses.

## Decisions made in this slice

- **Refusals go through `reportUnshown`.** The merged contract (A1) draws the reason above the
  source, and the view returns `undefined`. A2 and A3 returned an inert part with `structured`
  true. For a notebook this is the better answer: the handle reports `structured === false`,
  so `drawnStructuredView(host, 'notebook')` is never offered a mark on a file it does not draw.
  The inert-part pattern is still right for A2 and A3, which show their source as the view.
- **Markdown goes through `buildProse`**, the viewer's escape-first renderer (`text-views.ts`,
  asserted by `markdown.test.ts`). It is the path plan section 2 names. Its output is `innerHTML`,
  so this is not "createElement only". Every other text is `textContent`. Markdown text is
  escaped (`[U+XXXX]`) before the renderer sees it.
- **Code cells are plain monospace.** Plan section 4 names `highlightCode`. That function builds
  markup with `innerHTML`, and the A4 rule keeps attacker text out of `innerHTML`. Highlighting
  is a later decision, not a silent one.
- **Text outputs and HTML outputs.** The order is image, markdown, withheld (HTML, SVG,
  JavaScript, LaTeX, widgets), JSON, plain text. A withheld output shows the N2 placeholder
  even when it has a text/plain fallback, as the mock does. Plan section 4 says to show the
  fallback directly. "Show as text" reveals the fallback, or the HTML source when there is none.
- **Images.** The signature must match the declared type, and the blob type is the detected
  format. SVG is never a raster. Base64 is checked by length before anything is decoded.
- **Escapes.** Every invisible character (C0 except tab and line feed, DEL, C1, bidi marks,
  bidi isolates) shows as `[U+XXXX]`, the cue view's convention. CRLF becomes LF in display text.
- **ANSI.** Colour and emphasis (SGR) become classes, `ansi-fg-N`, `ansi-bg-N`, `ansi-bold`,
  `ansi-italic`, `ansi-underline`. No inline style comes from a file. All other sequences are
  dropped. A malformed one drops its introducer and what it read, then the text after it shows.
- **Quotes** are found in the raw source by `exact`, `prefix` and `suffix`, as the tree does. The
  match is the cell or output whose source span holds the offset. Display escapes differ from raw
  source, so a quote over an escaped character does not match (as in A3).
- **Selection.** `selectionAnchor()` returns the selected cell or output, unless the reader has a
  non-collapsed text selection inside the notebook. Then it returns `undefined`, so the quote
  adapter takes the text, as the tree and cue views do.
- **Comment events.** The Comment buttons dispatch `relic:structured-comment` with
  `detail.anchor`, as the tree view does. A0's `main.ts` selection hook (A2 notes, item 2) must
  listen for it.

## Deviations from the plan (say so in any report)

1. **Notebook size.** Plan section 4 says 50 MiB. The notebook reads with the JSON tree, and the
   tree refuses above 32 MiB (`JSON_TREE_MAX_BYTES`). A notebook between 32 and 50 MiB shows
   its source with the too-large notice. Raising the notebook limit needs a larger tree limit,
   which is A2's file, so it is not changed here.
2. **Outputs, total.** The plan caps outputs per cell (200). It does not cap the notebook. I added
   `NOTEBOOK_MAX_OUTPUTS` (20,000 read across the notebook), because 5,000 cells of 200 outputs
   each would put about a million blocks in the DOM. Past the cap the notebook is refused whole.
3. **Withheld output with a fallback** shows the placeholder first (mock N2). See above.
4. **Error names** are not highlighted inside the traceback (the mock does this). The name shows
   in the traceback's own text and in the fallback line when there is no traceback.
5. **Mobile tools.** Below 40rem the comment buttons are always shown, because touch screens have
   no hover. The mock's N6 does not show them.
6. **Markdown and bidi.** Markdown cells escape invisible characters before the renderer, so a
   bidi override shows as `[U+202E]`. The renderer's own handling of other characters is unchanged.
7. **Duplicated helpers.** `escapeInvisible` (relic-format `notebook.ts`) repeats the cue view's
   `visibleText` set, and `findQuote` repeats the tree's. A3 notes say to move the escape helper
   to one module once the table and notebook land. This slice does not do that move.

## Not built here (and why)

- **N4 (Suggesting in a cell, and the refusal on an output)** is C3, not A4. No Suggesting
  control exists here, so N4's notice is not built and not tested.
- **N5's "Suggesting is off: ..." strip note** is C3 as well. The two N5 notices that A4 owns (not a
  notebook, too large) are built and tested.
- **Cell editing and the 1 MiB suggestion limit** belong to C3.
- **Output comments on a source-mode view** are not in A4. A quote in Source mode is the only path.

## Build and shared-file edits

- `build.ts` copy line for `notebook-view.css`: **parent adds** (Main's instruction after the
  copy edit aborted). The line is `await copyFile(\`${pkgDir}src/notebook-view.css\`, \`${out}notebook-view.css\`);`,
  next to the `data-table.css` copy. Until it lands, `/assets/notebook-view.css` is 404 in the
  built viewer and the notebook is unstyled (the view still draws, and the DOM tests serve the
  stylesheet themselves).
- `packages/relic-format/package.json`: the `./notebook` subpath is in this branch. It was lost
  once during the merge and re-added after `git status` showed it missing.
- No `index.ts`, `main.ts`, `viewer.ts`, `comments.ts` or `renderer-class.ts` change. The
  route for `notebook` is the A0 contract and is the parent's to wire.

## Measured

| Case | Time | Result |
|---|---|---|
| 10,000-cell notebook, parse and refuse (bun) | 12.7 ms | refused, too-many-cells |
| 5,000-cell notebook, parse (bun) | 19.4 ms | 5,000 cells |
| 2 MiB traceback with ANSI, read (bun) | 14 to 23 ms | cut to 1,048,576 characters, marked |

The 10,000-cell time is the cost of reading the file, not of drawing it. Drawing 5,000 cells
is not timed here. The browser test records the time to mount the 10,000-cell refusal (see below).

## Verification run

- `bun test packages/relic-format/test/notebook.test.ts`: 35 pass, 0 fail.
- `bunx tsc --noEmit` clean in `relic-format` and `relic-viewer`.
- `bunx biome check` clean on every touched file.
- Browser: `bun test packages/relic-viewer/test/notebook-view.test.ts` with `RELIC_CHROME_PATH`
  set to the owned headless shell (`~/.omp/owned-shells/chromium_headless_shell-1228/...`),
  run with `env -u DISPLAY -u WAYLAND_DISPLAY`: 1 pass, 0 fail. All 12 cases ran.
  The 10,000-cell refusal shows its notice and source in 10.2 ms in the page.
- Not run in this slice: `mise run verify` and the full suite; the build (`build.ts` copy line is
  the parent's, see below), so `/assets/notebook-view.css` is not served from `build` yet.

## Not proven (say so in any report)

- **The full comment flow through `main.ts`** (selection offer, composer, post, mark, thread
  reveal) is not run. The browser test drives the view and the bridge, the anchor and the mark.
  That is the part A5 must exercise on a relic.
- **Real viewport mobile layout.** The N6 check measures a 390 px container in Chrome headless,
  not a 390 px device viewport. It is CSS, not a device.
- **Other browsers.** Chrome headless only.
- **Images in Safari.** `blob:` image URLs are not checked outside Chrome.
- **Markdown renderer safety on notebook input** is inherited from `markdown.test.ts` and not
  re-proved for notebook cells beyond the hostile cases in this slice.
- **MCP resolution** of `path` anchors on `.ipynb` relics (A5).
- **Suggesting** (C3).
