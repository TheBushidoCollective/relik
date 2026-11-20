> Base: origin/main 1ba52d46. PR A and PR B both edit `classFromMimetype` and `viewer.md` section 1, so they land after the SVG PR (#174) merges, or rebase onto it and keep its SVG filename rule. Every `main.ts` and `viewer.md` line number below was read against 1ba52d46.

## 0. Decisions (Jason, 2026-11-19; fact for every slice)

1. **Cell commenting on table data is the headline of the table work.** It is not a cut candidate. Comments land on a cell, a range, a column header, a tree node, a cue and a notebook cell, and they survive sorting, finding and virtualisation. This covers xlsx cells too.
2. **A type mismatch renders the less privileged class with a notice** (the code's behaviour, now the spec's, section 1.3 of viewer.md). The plan's routing builds on that: a same-tier match renders the declared class.
3. **`notebook`, `spreadsheet` and `document` join the renderable classes.**
4. **EPUB gets a properly good reader, not the narrow single-document one.** The planner's cost warning stands (no library works inside the frame, so this is our own reader: spine, contents, CSS, fonts, images, link scrolling, DRM detection) and is accepted. Cutting EPUB is no longer the first cut; the cut order below starts at item 2.
5. **Notebook cell suggestions are built** (cell editing), accepting that suggestions refuse notebooks over 1 MiB. The 1 MiB rule is a stated limit, not a reason to defer.
6. **Order of work:** the mock first (it gates the view slices), then PR A, then PRs B and C as the plan orders them.

# Plan: tables, trees, subtitles, notebooks, office documents, and suggestions on them

## 1. Goal

When a reader opens a relic:

- **Tables, trees, subtitles:** `.csv` and `.tsv` show as a sortable table with a sticky header that handles large files. `.json` shows as an expandable tree with copyable paths. `.srt` and `.vtt` show as a list of cues with timecodes.
- **Notebooks:** `.ipynb` shows markdown, highlighted code, and text and image outputs.
- **Office and ebook files:** `.docx` shows as Word-like pages, `.epub` as a readable book, and `.xlsx` as the same table with sheet tabs.
- **Source toggle:** every text view gets the markdown player's "View source" toggle. A file that is malformed or too big falls back to today's code view, and the reader is told why.
- **Comments:** they land on a cell, a tree node, a notebook cell or a cue. On docx and epub they land on text, points, regions and images through the existing frame bridge. `relic_read_comments` resolves all of them for agents.
- **Suggestions:** readers can type into a table cell, a subtitle or a notebook cell. Each edit posts as today's sealed `source` anchor, and `relic_apply_suggestions` applies it without breaking the file's structure.
- **No regressions:** existing CSV, JSON, SRT, VTT and ipynb relics keep their comments and their code-view suggestions. A docx, xlsx or epub that can't render still downloads.

## 2. Corrections to the brief

1. **The trust model allows more than text nodes on the viewing origin.** `viewer.md:11` says that origin "may run a renderer whose element and attribute set is fixed regardless of input". Only content that picks elements, attributes or URLs has to go to the usercontent origin. The code already relies on this:
   - Markdown renders on the viewing origin through an escape-first renderer (`text-views.ts:6-14`, used by `renderMarkdownSource` at `main.ts:1260`).
   - The syntax highlighter builds markup there too (`text-views.ts:30-33`).
   - pdf.js parses PDFs there (`renderPdfView`, `main.ts:1678`).
   - So tables, trees, cue lists, notebooks and xlsx tables can render on the viewing origin. Only docx and epub need the frame.
   - `viewer.md` §3.1 ("Markdown renders on the usercontent origin", line 149) is out of date. Fixing that text is separate work.
2. **The mismatch rule does not always force a download.** The code routes to the renderer of `leastPrivileged(declared, sniffed)` (`viewer.ts:1393-1399`). When the two classes are at the same tier, it renders the declared class (`viewer.ts:1378-1391`). `viewer.md` §1.3 clause 1 (line 46) is out of date. Office files download today only because `archive` happens to be the least privileged class.
3. **Every docx, xlsx and epub published by relic-mcp shows a false warning today.**
   - `MIMETYPES` has no entries for these formats (`publish.ts:1119-1148`), so they fall back to `application/octet-stream` (`publish.ts:1150-1167`).
   - `classFromMimetype` then reads that as `code` (from a dummy byte, `viewer.ts:1453-1456`, which lands in `renderer-class.ts:448-455`).
   - `code` against the sniffed `archive` produces the warning. I ran `routeFor('report.docx','application/octet-stream',{sniffed:'archive'})` in this checkout and got `download | This file is named like a text or code file but its contents look like an archive.` The same happens for `.xlsx` and `.epub`.
4. **"CSV already takes suggestions" is only true for files with LF line endings, up to 1 MiB.** `suggestionSource` refuses any carriage return (`suggestions.ts:21`), and the viewer gate repeats that check (`main.ts:6170-6189`). RFC 4180 ends records in CRLF, and Python's csv writer defaults to `\r\n` (from the Python docs; I didn't check that here). Item 4 needs a line-ending rule for table and subtitle files.
5. **Moving these formats out of the code view would break today's comments and suggestions on them.** The suggestion controller only knows `pre.code-body` and `article.prose` (`suggest-controller.ts:212-216`), and the gate only allows the `markdown` and `code` routes (`main.ts:6170`). The plan keeps a Source mode that is exactly today's code view. Until PR C, turning on Suggesting switches the view to Source.

## 3. Item 1: taxonomy and routing (shared contracts)

**Decision.** CSV, TSV, JSON, SRT and VTT stay class `code`. The structured view is chosen inside that class from the declared extension or mimetype, which `viewer.md:64` (rule 3) explicitly allows. Three new classes are added, one per new way of rendering:

| Class | Where it renders | Tier |
|---|---|---|
| `notebook` | Viewing origin; decodes embedded raster images | 2 |
| `spreadsheet` | Viewing origin; decodes ZIP and XML into a table | 2 |
| `document` | Usercontent frame (docx and epub) | 3 |

**Rejected alternatives:**
- **One class per format** (csv, json, subtitle): no privilege difference, and every new value has to be added to `MARKER_LABELS` (`main.ts:320`), `diff.ts`, `relic-rows.ts`, `card.ts` and the cover planner. It also forces a server-then-client release order for nothing.
- **xlsx in the frame:** that needs a second table UI and loses cell comments.

**Consistency across publish and view:**

| Format | Class recorded at publish | Declared mimetype | Class `classFromMimetype` gives | Class from bytes | Route | View |
|---|---|---|---|---|---|---|
| csv | code | text/csv | code | code | code | table (auto delimiter) |
| tsv | code | text/tab-separated-values (new) | code | code | code | table (tab) |
| json | code | application/json | code | code | code | tree |
| srt | code | application/x-subrip (new) | code (new rule) | code | code | cues |
| vtt | code | text/vtt (new) | code | code | code | cues |
| ipynb | notebook | application/x-ipynb+json (new; older clients sent text/plain) | notebook | code, upgraded to notebook if it parses as nbformat 4 | notebook | – |
| docx | document | wordprocessingml (new) | document | document (from the ZIP directory) | sandboxed-document, kind docx | – |
| epub | document | application/epub+zip (new) | document | document (head signature plus container.xml) | sandboxed-document, kind epub | – |
| xlsx | spreadsheet | spreadsheetml (new) | spreadsheet | spreadsheet (from the ZIP directory) | spreadsheet | – |

**`renderer-class.ts` changes:**
- Add `'notebook'` (PR A) and `'spreadsheet'`, `'document'` (PR B) to the class union and to `RENDERER_CLASSES`, before `'archive'`.
- In `CLASS_BEHAVIOUR`, all three are `'renders'`.
- In `EXTENSIONS`, map `ipynb: 'notebook'`, `docx: 'document'`, `epub: 'document'`, `xlsx: 'spreadsheet'`. Do not add a content check at this step, unlike otio (`renderer-class.ts:440-443`). `classFromMimetype` works the declared class out from a dummy byte (`viewer.ts:1456`), so a content check would turn every octet-stream `.ipynb` or `.docx` declaration into `code`. The bytes still decide at routing.
- Export the existing `extensionOf` (lines 247-253) as `filenameExtension`.
- In the ZIP branch of both `sniffContentClass` (357-363) and `deriveRendererClass` (416-423), call `zipContainerKindSync(content)`. It returns `otio`, `document` (for docx or epub), `spreadsheet` (for xlsx), or leaves the result as archive.
- `privilegeTier` (389-404): `document` is 3, `notebook` and `spreadsheet` are 2.
- `leastPrivileged` ranking (476-488): `html, jsx, document, image, pdf, model, spreadsheet, notebook, markdown, code, media, otio, archive, binary`.
- `RENDERABLE_CLASSES` is a decision for you (section 10). Nothing in the repo uses it except `renderer-class.test.ts:17`.

**`viewer.ts` changes:**
- `RenderRoute` (162): add `'notebook'` (A), and `'spreadsheet'` and `'sandboxed-document'` (B).
- `RouteSample` (1176): add `notebook?: boolean` (A) and `containerKind?: 'docx'|'xlsx'|'epub'` (B).
- `RouteDecision` (1166): add `documentKind?: 'docx'|'epub'`.
- `ContentRouteDecision` (1184): add `notebook?: NotebookModel`, parsed once at routing the same way `componentModule` is.
- `routeForClass` (1402): `notebook` goes to `'notebook'`, `spreadsheet` to `'spreadsheet'`, `document` to `'sandboxed-document'`.
- `describe` (1465): "a Jupyter notebook", "a spreadsheet", "a document".
- `classFromMimetype` (1432) becomes the following. The SVG branch's lines are kept as they are.
  ```ts
  if (type === 'application/x-ipynb+json') return 'notebook';                 // A
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || type === 'application/epub+zip') return 'document';                   // B
  if (type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'spreadsheet'; // B
  // ...existing image/media/pdf/otio/archive lines...
  // Every relic-mcp before this change declared a notebook text/plain (CLASS_FALLBACK.code).
  if ((type === 'text/plain' || type === 'application/json') && filenameExtension(filename) === 'ipynb') return 'notebook'; // A
  if (type === 'application/x-subrip') return 'code';                          // A
  ```
- **New branch in `routeFor` for ZIP containers** (B). It goes right after the model branch (1316-1347) and uses the same download wording:
  ```ts
  if (isContainer(declared) || isContainer(sniffed)) {
    const nameSilent = (mime === '' || mime === 'application/octet-stream')
      && deriveRendererClass(new Uint8Array([0]), filename) === 'binary';   // the namedClass idiom, viewer.ts:1329
    if (isContainer(sniffed) && (declared === sniffed || nameSilent))
      return { route: routeForClass(sniffed), notice: kindNotice(...), documentKind };
    return { route: 'download', notice: 'The file name or type does not match its contents. Download it to inspect it.' };
  }
  ```
- **Notebook gate** (A), next to the JSX gate (1364-1373), following the same pattern: `if (declared === 'notebook' && sniffed === 'code')` and the file parses as nbformat 4 (loaded lazily, like `loadJsxCompiler`), set `sniffed = 'notebook'`.
- **In `routeContent`:**
  - Replace the otio-only ZIP check (1199-1220) with a single `zipContainerKind(source)` read.
  - A notebook over 50 MiB goes to `code` with "This notebook is too large to show as a notebook, so its text is shown." This mirrors the OTIO notice at 1258-1268.
  - A docx or epub over 64 MiB, or an xlsx over 100 MiB, downloads with "This document/spreadsheet is too large to show here."
  - Add `'notebook'` to the routes that read the whole document (1269-1278).

**`publish.ts` changes.** Add to `MIMETYPES` (1119):
```ts
tsv: 'text/tab-separated-values', srt: 'application/x-subrip', vtt: 'text/vtt',
ipynb: 'application/x-ipynb+json',
docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
epub: 'application/epub+zip',
```
Add to `CLASS_FALLBACK` (1150): `notebook: 'application/x-ipynb+json'`, `spreadsheet: <spreadsheetml>`, and `document: 'application/octet-stream'`. Whether a document is docx or epub is only known from the bytes, so the viewer's `nameSilent` rule covers files with no extension.

**How docx, xlsx and epub are recognized** (new `relic-format/src/containers.ts`, both an async version and a sync version over the full bytes). It uses entry names only and never decompresses anything:
1. The result is `archive` if any of these hold: the file doesn't start with `PK\x03\x04`; there's no end-of-directory record in the last 65,557 bytes (same as `otio-zip.ts:312-367`); it uses ZIP64 markers (refused today at 645-660); the directory is over 16 MiB (`otio-zip.ts:28`); there are more than 10,000 entries; or the directory count doesn't add up.
2. `content.otio` plus `version.txt` means `otio`, the current rule (`otio-zip.ts:359-363`).
3. Bytes 30 to 57 reading `mimetypeapplication/epub+zip` (the EPUB rule that `mimetype` is the first entry, stored uncompressed, with no extra field; W3C EPUB 3.3), plus `META-INF/container.xml`, means `epub`.
4. `[Content_Types].xml` with `word/document.xml` and without `xl/workbook.xml` means `docx`. The reverse means `xlsx`.
5. Anything else, or any entry in a docx, xlsx or epub candidate with the encryption flag set, is `archive`.

A file whose name and contents disagree downloads through the container branch above. Rendering then decompresses entries lazily through the existing capped inflater (`otio-zip.ts:473-569`):
- At most 100 MiB per entry (`otio-zip.ts:26`) and 200 MiB across all entries read.
- Only stored and deflate entries, safe names (`assertSafeZipPath`, line 408), and no duplicates.
- For docx and epub, the parent checks every entry's real decompressed size against its declared size before posting to the frame, because the frame-side JSZip decompresses with no limit.
- Nothing is ever written to disk.
- The generic directory reader is pulled out of `indexOtioZip` into a new `relic-format/src/zip-index.ts`. The OTIO checks stay in `indexOtioZip` (822, 1176-1191), and the existing OTIO test suite guards the refactor.

**Choosing the view inside `code`** (A, new `structured-view-bridge.ts`, modelled on `text-window-bridge.ts`). The extension decides first: csv to table, tsv to table with tabs, json to tree, srt or vtt to cues. If the extension doesn't map, the mimetype decides (text/csv, text/tab-separated-values, application/json, application/x-subrip, text/vtt). Anything else stays plain. This only applies on the `code` route when `view.document` is present.

**Release order.** The server checks the class on publish (`app.ts:1423-1430`, `1768-1771`; `private/relic.ts:559`). PR A and PR B must each deploy server and viewer together, confirm the deploy is live, and only then release relic-mcp (see the `ship-relic-change` skill). Older clients keep sending `code` or `archive`, which is harmless because the class never decides the route (`viewer.md:24-34`).

## 4. Item 2: where each renderer runs

| Format | Runs on | Library | Loading | DOM it may build | Limits (and what the reader sees past them) | Malformed input |
|---|---|---|---|---|---|---|
| csv / tsv | Viewing origin, text nodes | None. Hand-written RFC 4180 parser that keeps offsets (`relic-format/src/csv.ts`); detects `,` `;` tab `\|` | Lazy `csv-view` and `data-table` chunks | `role=grid`, rows and cells, all text via `textContent`, no links, bidi controls shown as visible escapes | 32 MiB, 5,000,000 cells, 16,384 columns, 256 columns drawn. Past that: code view plus "This table is too large to show as a table, so its text is shown." | Unclosed quote: code view plus "This file could not be read as a table, so its text is shown. A quote opened on line N is never closed." Ragged rows still render; stray quotes are shown literally and the cell is flagged. |
| json | Viewing origin | Hand-written step-by-step tokenizer (`json-tree.ts`): keeps duplicate keys, exact number text and offsets, no recursion | Lazy `json-tree-view` | `role=tree` rows; strings shown as their JSON source (escapes visible), cut at 512 characters, full value in the inspector | 32 MiB, 2,000,000 nodes, depth 1,000. Past that: code view plus "too large to show as a tree" | Code view plus "This file could not be read as JSON… Line L, column C: reason." |
| srt / vtt | Viewing origin | Hand-written (`subtitles.ts`) | Lazy `cue-view` | Cue rows. Tags map to a fixed set: `b`→strong, `i`→em, `u`→span.u, `v`→a speaker label; others become plain text. Entities become text. NOTE, STYLE and REGION blocks show as muted text and are never applied. | 16 MiB, 20,000 cues. Past that: code view plus a notice | Unreadable blocks are skipped and counted ("4 blocks could not be read as cues. View source to see them."). Zero cues: code view plus a notice. |
| ipynb | Viewing origin | `notebook.ts`, built on `json-tree.ts` | Notebook reader loaded lazily at routing; lazy `notebook-view` | Markdown cells through `buildProse`; code cells through `highlightCode` (`markdown.ts:464`); outputs per the policy below | 50 MiB, 5,000 cells, 200 outputs per cell. Past that: code route plus a notice | Not nbformat 4: code route plus the existing mismatch notice through `describe` |
| xlsx | Viewing origin | Own `xml.ts` tokenizer (refuses any DOCTYPE or ENTITY) plus `xlsx.ts`, on `zip-index.ts` | Parsed in a separate `spreadsheet-parse-worker`, served with the worker CSP (the model worker's precedent, `app.ts:420-428`); drawn by PR A's table | Same as the table, plus sheet tabs | 100 MiB file, 256 sheets, 5,000,000 cells, 2,000,000 shared strings, 200 MiB decompressed, Excel's 1,048,576 × 16,384 grid. Past that: download card | Download card with "This spreadsheet could not be read." |
| docx | Frame | docx-preview 0.4.1 (Apache-2.0, 75,527 bytes minified) plus jszip 3.10.2 (MIT or GPL-3, 97,781 bytes), both checked in this session; latest releases 2026-09-21 and 2026-09-08 | Separate module `frame-docx.js` (bundled like `model-view`, `build.ts:289-304`), posted into the frame | Whatever docx-preview builds, inside the opaque frame. Options: `useBase64URL:true`, `renderAltChunks:false`, `renderComments:false`, `renderChanges:false` | 64 MiB. Past that: download card | The frame reports failure; the reader sees "This document could not be shown." plus Download |
| epub | Frame | Own `frame-epub.ts`. epub.js can't work: it draws every section in an iframe (`rendition.js:51` `view: "iframe"`, `:199` `IframeView`), and the frame strips and blocks nested frames (`sanitizeFrameHtml`, `sandbox.ts:2543`, plus the runtime blocks) | Separate module posted into the frame | Chapters in spine order plus a contents panel | 64 MiB, 2,000 spine items, 16 MiB per chapter | Failure card. DRM: "This ebook is protected by DRM, so it can't be shown here. Download it to open it in your reading app." |

**Notebook output policy.** For each output, the first match wins:
1. **Images** (png, jpeg, gif, webp): decode the base64 (at most 16 MiB each, 64 MiB total, 500 images). Check the file signature against the declared type. Show it as `<img src=blob:>`, typed as the format that was actually detected, the same way the image route does. If the signature doesn't match, show "This image output could not be shown."
2. **Text:** `text/markdown` goes through `buildProse`. `text/plain` and stream output go in a `pre` (first 1 MiB, then "Output truncated").
3. **Errors:** show the error name, value and traceback with ANSI codes stripped (read the `render-ansi-output-safely` skill).
4. **Never rendered:** `text/html`, `image/svg+xml`, `application/javascript`, `text/latex` and widgets. Show their `text/plain` fallback if they have one. Otherwise show "This output is HTML (or a widget) and is not run here." with a "Show as text" button.
5. **Markdown cells:** attachments and remote images show as alt text, the renderer's existing rule (`markdown.ts:56-66`).

**docx and epub content policy.**
- External links go through the existing frame link path (`openFrameExternalLink`, `main.ts:1351`).
- Linked images, templates and OLE objects are never fetched; the frame CSP is `default-src 'none'`.
- EMF and WMF images show as broken.
- Word fields show their last saved text.
- In epub, the renderer strips scripts, `on*` attributes, `javascript:` URLs and iframe, object, embed and portal elements, then rewrites images, CSS and fonts to `data:` URLs from the archive.
- Obfuscated epub fonts are skipped.
- Internal epub links scroll with their own click handler, because the frame swallows normal `#hash` navigation.

**Frame protocol additions (PR B).**
- **Parent to frame:** `{type:'relic:render-document', format:'docx'|'epub', module:string, bytes:ArrayBuffer}`.
  - It shares the existing one-render guard (`sandbox.ts:2401-2418`).
  - The frame imports the module from a blob URL it creates itself. That's the JSX mechanism (`sandbox.ts:2491`), allowed by `script-src 'unsafe-inline' blob:`.
- **Frame to parent:** `{type:'relic:document-state', state:'ready'|'failed', reason?:'corrupt'|'unsupported'|'protected'|'too-large'}`. The parent only accepts these listed values.
- **Why post the renderer instead of inlining it:** the frame page (`sandbox.html`) loads on every HTML and JSX open (`app.ts:466-492`). Inlining the renderer would add about 175 KB to every one of those.
- `viewer.md:265` and `:269` ("What crosses") need these two messages added.

## 5. Item 3: comments

| View | What it writes | How it paints |
|---|---|---|
| Table (csv, tsv, xlsx) | `cell` | The table draws its own cell marks. Old `text` and `quote` comments are found in the source text and outlined on the matching cells, the way the text window does it (`main.ts:6799`, `6813`, `6837`). |
| Tree | `path` | Same as the table: old quotes are found in the source and mark the matching nodes |
| Cues | `time` (a cue's span) and `quote` | A new cue adapter for `time` (the media `timeAdapter` only accepts media elements, `annotate-time.ts:452-454`); the generic quote adapter for `quote` |
| Notebook | `path` (`/cells/N`, `/cells/N/outputs/M`) and `quote` | Path adapter; generic quote adapter |
| Source mode | `quote` | Unchanged |
| docx / epub | `quote`, `pin`, `region`, `image` | Existing frame adapters (`anchor-adapters.ts:53-58`) |

**New anchor kinds** (`relic-format/src/comments.ts`, format.md §3.13). There is no format version bump:
```json
{"kind":"cell","row":14,"col":3}
{"kind":"cell","row":4,"col":2,"row_end":9,"col_end":4,"sheet":"Q3 budget"}
{"kind":"path","pointer":"/cells/7/outputs/0"}
```
- **`cell`:**
  - `row` is an integer from 1 to 16,777,216 (a sanity cap, like `COMMENT_ANCHOR_MAX_PAGE` at line 198). `col` is from 1 to 16,384 (Excel's width).
  - `row_end` and `col_end` are optional, at least their start, and the range is inclusive.
  - `sheet` is 1 to 128 UTF-8 bytes with no control characters or bidi characters, and is absent for CSV.
  - Coordinates are A1 coordinates of the published file: CSV record 1 is row 1 even when it's shown as the header.
- **`path`:**
  - An RFC 6901 pointer: either empty or starting with `/`, with `~` only as `~0` or `~1`.
  - At most 512 bytes, matching the quote cap (line 180). No NUL or CR, the `source` anchor's rule (681-690).
  - If a key appears twice, the last one wins, as in `JSON.parse`. Writers never point at an earlier duplicate.
- **Both:** unknown fields are refused. Writers re-run the reader's parser (`assertWritableAnchor`, line 935). `text` and `pin` stay frozen. An unknown kind still parses as `unsupported` (line 916).
- **No snapshot of the cell text is stored.** A comment only shows on the version it was written on, and the MCP resolves it against that version too.

**MCP side:**
- `validateAndNormalizeAnchor` (`relic-mcp comments.ts:1681`, error list at 1930) and `describeAnchor` (1362) learn the new kinds.
- `resolveAnchors` uses the shared parsers to answer:
  - `cell`: `{text ≤512, header ≤128, line, sheet?}`.
  - `path`: `{type, excerpt ≤512, line, cell_type?}`.
  - `time` on SRT or VTT: up to 20 matching cues. This check goes before the "non-video" refusal at `resolve-anchor.ts:1767`.
- The comment transcript (`server.ts` around 3700-3750) prints resolved text JSON-encoded, like other untrusted text.

**What older readers show.** The viewer shows "Commenting on something this page cannot show" and "This comment points at part of the document that this page cannot show." (`anchoring.ts:342-352`); the comment body is still readable. Older relic-mcp reports "Unsupported anchor kind "cell"."

**Viewer wiring:**
- New `annotate-cell.ts`, `annotate-path.ts` and `annotate-cue.ts`, registered in `anchor-adapters.ts`. They hand the work to `structuredViewFor(host)`.
- `familyOf` (`main.ts:7006`) treats a `time` anchor on a cue list as `'document'`.
- The selection offer (`main.ts:4930-4961`) asks the view for an anchor before falling back to `captureSelectionQuote`: a cell in a table, a path in a tree.

## 6. Item 4: suggestions

**Which formats, and how.** Suggestions always post as `source` anchors, so the wire format doesn't change. The format requires a `source` anchor on every suggestion (`comments.ts:513-521`), and every relic-mcp from 0.8 on can already apply them. The suggested-edits plan's anticipated cell anchor (`plan.md:114`) would be unapplicable everywhere.

- **CSV/TSV:** edited per cell, inside the table.
- **SRT/VTT:** edited per cue, on the cue text.
- **ipynb:** edited per markdown, code or raw cell.
- **JSON:** Source mode only, using today's code-view suggestions. In the tree, "Suggest edit" switches to Source with that token selected.
- **Out of scope:**
  - docx, xlsx, epub: applying is a text merge over the local file, which requires markdown or code and UTF-8 text (`apply-suggestions.ts:265-279`).
  - Adding or removing table rows and columns, cue timing, and notebook outputs and metadata.
  - Files over 1 MiB (`suggestions.ts:3`, and the abuse bound at `plan.md:285`).

**Line-ending rule** (`suggestions.ts`). Add `suggestionSourceFor(bytes, filename) → {ok, source, bom, cr} | {ok:false, reason}`.
- Carriage returns are allowed only in csv, tsv, srt and vtt files.
- Anchors still never contain CR; writers cut the surrounding context at the nearest CR.
- Code-view suggestions still require a file with no CR, because `codeSegments` strips CRs (`markdown-source.ts:756-765`).
- In files that do use CR, inserting a line break is refused, since a replacement can't contain CR.
- The viewer gate (`main.ts:6171`), the suggestion controller (222), the MCP resolver (1492) and the apply tool (273) all call this one function.

**Mapping a CSV cell to the source.**
- **Cell boundaries:** parse the source (with the BOM stripped, as `suggestions.ts:14-17` does). An unquoted cell's content is `[fieldStart, fieldEnd)`. A quoted cell's content is `[fieldStart+1, fieldEnd-1)`.
- **Segments:** plain stretches are `text` segments. Each `""` is one new `escape` segment that displays as `"`; the painter treats it as one unit, like `join` (`suggestions.ts:84-92`). LF inside a quoted cell is plain text.
- **Cells that can't be edited:** irregular quotes, a CR inside the cell, or a bidi character.
- **Blocks:** one block per cell, of kind `csv-cell`.
- **What the writer posts:** `exact` is the raw source text being replaced. The context is up to 128 bytes, cut at CR, and must be unique (the existing "repeats" refusal).
- **Typed text:** in a quoted cell, `"` becomes `""`. In an unquoted cell, typing the delimiter, a quote or a line break is refused with "A comma would split this cell…". In TSV, Tab is refused (`suggest-draft.ts:392-395`).
- **Empty cells:** an insertion is anchored on the neighbouring delimiter, using the existing before and after modes.

**Mapping cues.** Tags are left out of the editable text. `b`, `i` and `u` act like markdown formatting, so an edit can't cross them (`crosses-formatting`). VTT entities are `escape` segments. Typed text is escaped as `&amp; &lt; &gt;` in VTT; in SRT, typing `<` is refused. A blank line ("A blank line would end this subtitle.") and `-->` are refused.

**Mapping notebook cells.**
- **Segments:** plain stretches, plus an `escape` segment for each JSON escape (a surrogate pair counts as one). Where a line ends, the `\n` together with the `",` and whitespace before the next line's string is one `escape` segment that displays as a newline. A cell that doesn't follow that pattern can't be edited.
- **Typed text:** JSON-escaped.
- **Outputs:** never editable.
- **Size:** the whole `.ipynb` must be at most 1 MiB. Otherwise: "Suggesting is off: suggestions work on files up to 1 MiB. Clear outputs before publishing to suggest on this notebook."

**Resolver and apply tool.** `locate`, `resolveSuggestions` and `mergeSuggestions` don't change (`suggestions.ts:26-278`). `relic_apply_suggestions`:
- Allows `notebook` at its class check (266).
- Before writing, re-parses the merged result. A CSV or TSV must keep the same number of records and fields. JSON must still parse. A notebook must still parse with the same cell count. Otherwise it refuses with `suggestion_breaks_structure`, because a hostile suggestion could post any replacement.
- Keeps the BOM and the file's line endings.

## 7. Item 5: UI

**Existing pieces each view reuses:**
- The markdown player's toggle button in `.toggle-row` (`main.ts:1260-1302`): "View source" switches with "View table", "View tree", "View subtitles" or "View notebook".
- The mode bar `.sg-strip` (around `main.ts:6190-6240`).
- `selectionOffer` (`popover.ts:667`), `openComposer` (`main.ts:8072`), `inlineComposer` (793), `popoverCard` (748) and `commentRow` (`main.ts:3849`). The comment label text comes from the adapters.
- `notice()`, the PDF loading card, and `renderDownloadView` (`main.ts:1647`).
- New `MARKER_LABELS` lines: "Rendered as a notebook, no author code", "Shown as a table, no author code", and "Rendered as a document, no author code" for the frame route.

**What each view needs:**
- **Table:**
  - Sticky header row and row-number column, column letters, header-row toggle.
  - Sort by clicking a header: ascending, descending, back to file order. Columns sort numerically when every value is a number.
  - Fixed-height rows; only the visible rows are in the DOM.
  - An inspector for the selected cell with Copy, Comment and Suggest edit.
  - A "Find in table" box, plus a summary line like "50,000 rows · 12 columns · comma-separated".
  - ARIA grid with row and column counts; arrow keys move between cells.
- **Tree:** disclosure triangles, child counts, coloured values by type, Expand all and Collapse all (turned off above 10,000 nodes), a breadcrumb with Copy path and Copy value, a badge on duplicate keys, and only visible rows in the DOM.
- **Cues:** index, start → end, duration, text, speaker label, muted NOTE and STYLE blocks. A density strip is optional.
- **Notebook:** `In [n]` gutter, a hover toolbar on each cell ("Comment on cell 7"), and outputs styled by type.
- **Spreadsheet:** the table plus sheet tabs, a hidden-sheets menu, the formula shown in the inspector, and one line saying "charts and images are not shown".
- **Document:** docx pages as docx-preview draws them; epub as continuous reading with a contents panel; the existing frame comment tools.

**Mock (Slice 0).** Dispatch this to the designer agent. Files: `docs/plans/structured-formats/mockup.html` and `mock-shots/`. Use real content, at 1440 px in light mode, with dark versions of T1 and N1. States to build:
- **Table:** T1 default table; T2 sorted with a numeric column; T3 inspector on a multi-line cell; T4 composer for a cell (C14) and a range (B4 to D9), marks visible after sorting; T5 50,000 rows plus the 256-column notice; T6 parse-failure notice with source view; T7 too-large notice; T8 xlsx with three sheets, one hidden, a date, a formula and a `#DIV/0!`; T9 at 390×844 with the inspector as a bottom sheet; T10 Suggesting in a cell, refusals, a tracked change and a conflict badge; T11 a semicolon-separated file.
- **Tree:** J1 default tree; J2 selected node with breadcrumb and copy controls; J3 a large array; J4 duplicate key; J5 parse error; J6 Source mode; J7 mobile.
- **Subtitles:** S1 cue list with italics and a speaker; S2 a cue comment; S3 skipped-blocks notice; S4 VTT NOTE and STYLE blocks; S5 Suggesting.
- **Notebook:** N1 markdown, code, stream, a plot, a DataFrame as plain text and an ANSI traceback; N2 the HTML-output placeholder; N3 cell comment and a quote; N4 Suggesting in a cell and the refusal on outputs; N5 too-large and not-a-notebook notices; N6 mobile.
- **Documents:** D1 docx pages; D2 a frame comment and an image region; D3 epub contents panel and the DRM card; D4 failure card; D5 loading; D6 mobile.
- **Old viewer:** L1 the unsupported-anchor comment.

## 8. Item 6: slices and ownership

**Three PRs:** A (items 1 and 2), B (item 3), C (item 4).
- **Why not one PR:** each needs a different independent security review. A is text parsers on the viewing origin. B is ZIP and XML parsing plus third-party code in the frame and a frame protocol change. C is an editor plus a tool that writes local files. A and B also each carry the server-then-client release order.
- **Why items 1 and 2 share a PR:** ipynb needs item 1's JSON tokenizer and the `path` kind, and SRT/VTT is the same kind of code view. Splitting them would create a PR whose only job is to wait.
- **Order:** A goes first. B starts at the same time on its own branch; B1's view part merges after A. C starts after A merges, alongside B.
- Each slice is one or more commits on its PR's branch.

| Slice | Owns | Depends on | Acceptance you can observe | Independent security review |
|---|---|---|---|---|
| A-0 Mock (designer) | `docs/plans/structured-formats/*` | – | Mock opens with every state listed in section 7 | – |
| A0 Contract (one owner) | `comments.ts` (cell, path), `renderer-class.ts` (notebook), `relic-format/package.json` subpaths, `viewer.ts` routing, new `structured-view-bridge.ts`, `table-model.ts`, `annotate-{cell,path,cue}.ts`, `anchor-adapters.ts`; all of A's `main.ts` edits (bridge call, notebook route, markers, readiness, selection hook, `paintMarks` hand-off, `familyOf`, Suggesting switches to Source); `diff.ts`, `relic-rows.ts`, `build.ts` CSS copies, `class-behaviour.test.ts`; server `card.ts`; MCP `publish.ts`, `comments.ts`, `server.ts` transcript, `cover/inputs.ts` (no cover for notebooks); format.md §3.13 and class counts, viewer.md §1 and the kinds table (536), `decisions.md`. View modules start out falling back to the code view. | – | `mise run verify`; tests covering every routeFor combination (old `.ipynb` declared text/plain becomes a notebook; a `.json` notebook stays code with no notice; a non-notebook `.ipynb` gets the mismatch notice; an oversized notebook gets the size notice); comment kind boundary tests; `comment-popover-path.ts` and `suggested-edits-path.ts` still pass | Yes |
| A1 Table | `csv.ts` plus tests, `data-table.ts`, `csv-view.ts`, `data-table.css` | A0 | `bun test packages/relic-format/test/csv.test.ts packages/relic-viewer/test/data-table.test.ts` (headless-browser DOM test, like `suggest-editor.test.ts:41`), then path stage `table` | Yes |
| A2 Tree | `json-tree.ts` plus tests, `json-tree-view.ts`, `.css` | A0 | Unit tests, including 100,000-deep nesting refused with no stack overflow; path stage `tree` | Yes |
| A3 Cues | `subtitles.ts`, `cue-view.ts`, `.css` | A0 | Unit tests; path stage `cues` | Yes |
| A4 Notebook | `notebook.ts`, `notebook-view.ts`, `.css` | A0, A2 | Unit tests; path stage `notebook` | Yes |
| A5 Resolution and proof | `resolve-anchor.ts` (cell, path, time on subtitles) plus tests; new `structured-formats-path.ts`; a `verify.yml` step; `shell-budget.test.ts` checks for lazy loading; PATH.md; README and SKILL; `deploy-smoke.sh` asset list (line 28) | A1-A4 | Build the viewer and MCP, run `RELIC_CHROME_PATH=… bun packages/relic-mcp/test/structured-formats-path.ts`, and it prints `STRUCTURED_FORMATS_PATH_OK` | Yes |
| B0 Contract | `renderer-class.ts` (document, spreadsheet), new `zip-index.ts` refactor and `containers.ts`; `viewer.ts` container branch and sniff; `sandbox.ts` message, `main.ts` payload, routes, markers, readiness; `diff.ts`, `relic-rows.ts`; `build.ts` entries and licence files; `card.ts`; server `app.ts` worker CSP; MCP `publish.ts` and `cover/inputs.ts`; spec §1, §3, §4, §5 | (A merged before B merges) | Every OTIO test plus `otio-path.ts` unchanged and passing; a routing test for each format under each declared type | Yes |
| B1 XLSX | `xml.ts`, `xlsx.ts`, `spreadsheet-parse-worker.ts`, `spreadsheet-view.ts` | B0; A1 for the view part | Unit tests; path stage `xlsx` | Yes |
| B2 DOCX | `frame-docx.ts`, `document-frame.ts`; dependencies pinned exactly | B0 | Path stage `docx`: frame text present, no frame network requests, a quote comment paints, a bomb is refused before posting, the negative control fails | Yes |
| B3 EPUB | `frame-epub.ts` plus fixtures | B0 | Path stage `epub`: real clicks on contents links scroll, scripts don't run, the DRM card shows | Yes |
| B4 Resolution and proof | `resolve-anchor.ts` (sheet cells), `documents-path.ts`, `verify.yml`, shell-budget checks (frame modules outside `viewer.js`; `sandbox.html` unchanged), PATH.md | B1-B3 | Prints `DOCUMENTS_PATH_OK` | Yes |
| C0 Contract | `suggestionSourceFor`; the `escape` segment kind; new block kinds and refusals in `suggest-draft.ts`; the `suggest-controller.ts` hook each view plugs into; `main.ts` gate (6170-6189); spec §6.6 | A merged | Unit tests | Yes (line-ending rule) |
| C1 Table | Cell editor and tracked-change drawing in `data-table.ts` and `csv-view.ts` | C0 | Path stage `csv-crlf` | – |
| C2 Cues and JSON hand-off | `cue-view.ts`, `json-tree-view.ts` | C0 | Path stages `srt` and `json-source` | – |
| C3 Notebook | `notebook-view.ts` | C0 | Path stage `notebook` (at most 1 MiB) | – |
| C4 Apply tool | `apply-suggestions.ts`, `resolve-anchor.ts` source case, tests, new stages in `suggested-edits-path.ts` | C1-C3 | `suggestion_breaks_structure` refusal; the applied CSV still parses with the same shape | Yes (writes files) |

**What each review must check:**
- **A1-A4 and B1:** no attacker text reaches `innerHTML` or attributes. Test with `<img onerror>` payloads in cells, cues and outputs and confirm no element is created. Bidi characters show as visible escapes. Limits hold on pathological fixtures, with the time recorded.
- **A4 specifically:** HTML, SVG and JS outputs are never rendered, and images are signature-checked.
- **B2 and B3:** the frame makes zero network requests; there are no nested frames; the parent's real-size check refuses a lying archive.
- **C4:** a structure-breaking suggestion is refused on write.
- **Separate work:** the spec drift in §1.3, §1.4 rule 1 (the code view doesn't neutralize bidi characters) and §3.1.

**What already proves things, and its gaps.** `mise run verify` (`mise.toml:48-50`) runs lint, typecheck and tests. CI runs the browser paths at `verify.yml:101-125` (main) and `otio-path` at 174. The building blocks exist: the in-process app, MemoryStore, the MCP bundle over stdio, `browser-headless.ts`, and the negative-control pattern. Gaps: Chrome only; the frame is same-site on loopback, so process isolation isn't tested; no IME or touch input; no clipboard.

**End-to-end proof.** All three path scripts pass in CI against the merge revision, and they upload screenshots. After deploy, a read-only `deploy-smoke.sh` confirms the new assets are served. No test relics get published to production.

**What would show this plan is wrong:**
- docx-preview won't render under the frame's CSP and DOM blocks.
- A blob-module import fails in the opaque frame outside Chrome.
- A 32 MiB CSV is too slow to parse on the main thread, which would mean moving it to a worker.
- Cutting anchor context at CR makes most anchors on repetitive CSVs ambiguous.
- Old `quote` comments on CSV relics can't be placed by matching against the source.

## 9. Item 7: risks and cuts

**Things I couldn't settle from the code:**
- How much each format is actually used: there's no per-extension telemetry.
- How notebook sizes compare with the 1 MiB suggestion cap. It's an inference that embedded plots push most real notebooks over it.
- How docx-preview handles tracked changes, fields and EMF images; it needs a real fixture.
- Safari and Firefox behaviour of the frame module.
- My recollection is that the Office packaging standard forbids DTDs. I didn't verify it, but refusing DOCTYPE is safe either way because Office never writes one.

**Cut order for the smallest design that still delivers all four items:**
1. EPUB, or narrow it.
2. Notebook-cell editing, falling back to Source-mode suggestions.
3. Table find, the cue density strip, and horizontal scrolling beyond 256 columns (keep the notice).
4. xlsx number formats other than dates and percentages, and merged-cell spanning.

Don't cut the line-ending rule. Without it, item 4 is empty for CSVs exported from Excel and written by Python.

**Ideas that are worse than they look, with evidence:**
- **EPUB.** No library works inside the frame (epub.js depends on iframes, see section 4). It means building and maintaining our own reader: spine, contents, CSS and fonts, link scrolling, DRM detection. That's a lot for probably the least-shared of these formats.
- **SheetJS.** npm `xlsx` is stuck at 0.18.5 (registry, checked in this session). It has CVE-2023-30533 (prototype pollution when reading crafted files, fixed in 0.19.3) and CVE-2024-22363 (ReDoS, fixed in 0.20.2), and the fixes are only on cdn.sheetjs.com ([GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9), [Snyk](https://security.snyk.io/vuln/SNYK-JS-XLSX-5457926)). That's why xlsx uses our own reader.
- **JSZip.** It has its own prototype-pollution history ([GHSA-jg8v-48h5-wgxg](https://github.com/advisories/GHSA-jg8v-48h5-wgxg)). That's why docx-preview and JSZip only ever run inside the frame.

## 10. Decisions for you

1. **`RENDERABLE_CLASSES`:** add `notebook`, `document` and `spreadsheet`? I recommend yes. Notebooks were already counted as `code`, and nothing in the repo reads this list.
2. **EPUB scope:** keep the narrow single-document reader, or defer EPUB?
3. **Notebook-cell suggestions:** build them knowing notebooks over 1 MiB are refused, or use Source-mode suggestions only?