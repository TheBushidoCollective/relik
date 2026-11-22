> Written 2026-11-22. Mock status: built and rendered; mockup.html and mock-shots/ sit beside this file (slice S0).

# B5 spec: side-by-side version comparison for DOCX, EPUB and XLSX

I read `origin/main` at `17db4880` in a throwaway ovnfs checkout, now removed. Line numbers refer to that revision. I edited nothing. Commit this text as `docs/plans/version-compare/plan.md` together with the S0 mock.

## 1. Goal

A reader opens `relik.link/<id>` for a DOCX, EPUB or XLSX relic. The link may be a public fragment-key link or a private link. The relic has at least two versions, and each is 16 MiB or smaller. Three things should be true:

- **The taskbar says Compare versions.** Today it says Earlier versions.
- **The comparison shows both versions.** They sit side by side by default, with a swipe one click away. It has change navigation, a Changes sidebar with an exact count, and synced scrolling.
  - **DOCX:** both versions render exactly as the viewer renders them today, each in its own opaque frame. Changed, added and removed paragraphs, list items, table cells and images are outlined in place. Sidebar rows show the changed words.
  - **EPUB:** the same as DOCX, plus a Chapters list showing changed, added, removed and unchanged chapters.
  - **XLSX:** two read-only grids with identical geometry, mirrored exactly. A sheet strip pairs the sheets and shows added, removed, renamed, hidden and shown sheets. Cells are compared by A1 position: added, removed, value changed, or formula changed only.
- **Every failure gets named copy.** Oversize, mismatched, unreadable and byte-identical pairs fall back with a sentence that says why. Plaintext and diff results never reach the service. There is no server change and no relic-mcp client release.

## 2. Corrections to the brief

1. **The refusal is silent.** Today's refusal is `comparison_not_supported` with an empty detail string. `diff.ts:388-409` sets detail only for otio, media, pdf and model. EPUB uses the noun "document" (`diff.ts:335-338`).
   - The only copy a reader sees comes from `uncomparableReason` (`main.ts:3545-3557`): "Relik cannot show version N of this document beside version M…".
   - The current page carries no notice, because `unpromptedComparisonNotice` only fires for not-renderable and too-large (`diff.ts:349-361`).
2. **There are no MCP version tools.** No `relic_versions` or `relic_diff` exists, and `relic_show` has no version input (`relic-mcp/src/inventory.ts:165-169`, `server.ts:1051-1090`).
   - `card.ts` has no version logic: it only holds class phrases (`relic-server/src/card.ts:40-115`).
   - `relic-rows.ts` has no comparison logic.
   - Mint does no class gating (`app.ts:2375-2395`).
   - So B5 is viewer code, docs and test scripts only.
3. **The existing rendered comparison cannot carry documents.**
   - Snapshots are capped at 5,000 nodes and 8 MiB, and an over-budget snapshot becomes null rather than partial (`rendered-tree.ts:114-119,386`).
   - docx-preview builds one element per run, puts base64 images in `src` (`frame-docx.ts:212`) and sets a page `zoom` style (`frame-docx.ts:290-301`). Both `src` and `style` are compared attributes (`rendered-tree.ts:128-141`).
   - Document frames never report a tree at all. `scheduleReport` runs only for HTML and JSX (`sandbox.ts:3381-3389`); documents post only `relic:document-state` (`sandbox.ts:2723-2734`).
4. **Comments never appear in compare panes.** The thread is off the page while a comparison is open (`main.ts:752-756`), and `renderComparison` replaces `document.body`. Panes carry only diff marks and scroll anchors, and `relic:annotate` is accepted once per frame (`sandbox.ts:2598-2602`). B5 keeps this.
5. **The parser drops `sheetId`.** It keeps only name, `r:id` and state (`xlsx.ts:206-231`), so detecting a renamed sheet needs a model addition.
6. **`SHELL_CEILING_BYTES` measures `dist/viewer.js`, not the frame.** The ceiling is 475 KiB (`shell-budget.test.ts:39`), mirrored by the `wc -c` check in `deploy.yml`. Frame code ships in `dist/sandbox.html` and `dist-frame/*.frame.js` (`sandbox-bundle.test.ts:60-92`).
   - [INFERENCE] `viewer.js` builds from 2026-11-20/21 in other worktrees measure 286,656 to 291,525 bytes, so size is not the constraint. New renderers stay lazily loaded anyway.
7. **`structured-formats/plan.md` has no B5 and no comparison acceptance** (`plan.md:305-323`). B4 owns `resolve-anchor.ts`, `documents-path.ts` and its own `verify.yml` step. B5 must not edit those.

## 3. Shared contracts

### 3.1 What each comparison means

| | Unit compared | How units are matched | Shown | Not compared (the copy says so) |
|---|---|---|---|---|
| **DOCX** | Leaf text block of the rendered DOM (§3.4). Search is limited to `section.docx` children other than `header` and `footer`. | Myers diff (`diffArrays`, `maxEditLength`) over interned `kind + normalised text` keys. A removed run immediately followed by an added run pairs positionally as "changed". Word-level diff only on listed pairs. | Outlines on block elements in each frame, change rows with `<del>`/`<ins>` word segments, change navigation, landmark scroll sync. | Page headers and footers; formatting and styles; layout and pagination; image pixels (images count by presence and position only); comments (not rendered). Tracked changes are compared as rendered, with insertions kept and deletions omitted (`renderChanges:false`; docx-preview `renderInserted`/`renderDeleted`, dist lines 3637-3646). List numbers are CSS counters, not text. |
| **EPUB** | The same blocks, but only inside `article[data-epub-chapter]`. `part` is the render-order chapter index. | As DOCX, except removed and added blocks pair only when their chapter paths match. A chapter replaced by another reads as removed plus added. | As DOCX, plus a Chapters preface and a title-change line. | Reader chrome (it lives in a shadow host), CSS, image pixels, and metadata other than the title. A moved chapter reads as removed plus added. |
| **XLSX** | One cell at an A1 coordinate, per paired sheet. A cell is filled when its display text is non-empty or it has a formula. Its value is the display text (the `texts` pool) plus the formula and shared-from text. | Sheets pair in this order: exact name; name ignoring case (a rename); equal `sheetId` where at least 50% of the larger sheet's filled cells are unchanged (a rename); otherwise added or removed. Cells merge-walk row by row, then column by column. | Two grids with one shared width plan and padded dimensions. Cell states are added, removed, changed, and formula (display equal, formula different). Sheet-level states are added, removed, renamed, hidden and shown. | Number-format codes except through the shown text; charts and chartsheets; images; merged cells; defined names; comments. **There is no row or column alignment**: a row inserted early shows every later cell as changed. Sheets over 600,000 rows are not compared. Cells past the 256 drawn columns are listed but cannot be jumped to. |

### 3.2 Ceilings and fallbacks

**All three formats:**
- 16 MiB per side, from the existing `MAX_DIFF_BYTES` (`diff.ts:16`), which is unchanged.
- Byte-identical versions show "No changes. These versions have identical content." with the left version on its own. This is checked before any frame or worker starts.

**Documents:**

| Constant | Value |
|---|---|
| `MAX_DOCUMENT_BLOCKS` | 50,000 per version |
| `MAX_DOCUMENT_BLOCK_BYTES` | 16 MiB of block text (UTF-8) per version. Over either budget the frame posts `null`, never a partial snapshot. |
| `MAX_BLOCK_EDITS` | 5,000 (deterministic `maxEditLength`, no time-based abort) |
| `MAX_DOCUMENT_ANCHORS` | 1,000 per side |
| Listed changes | 40 (the existing `MAX_LISTED_CHANGES`, plus a "more" row) |
| Render watchdog | 30 s per frame (existing) |
| `DOCUMENT_BLOCKS_WAIT_MS` | 10 s, starting after ready |
| Stage snapshot timeout | 45 s |

- Over the block or text budget, after a failure, or past the edit limit, both renders stay on screen without outlines.

**Spreadsheets:**

| Constant | Value |
|---|---|
| `XLSX_COMPARE_CELL_LIMIT` | 2,000,000 parsed cells per version, enforced during parse |
| Listed changes | 200 per sheet |
| Listed text | Cut at 160 characters |
| Worker timeout | 60 s |

- Over the cell limit, or when a version is unreadable or times out, the left version is shown on its own with a reason. Memory is the reason, so the two grids are never both shown.
- Rationale for the limit: two workbooks of 2,000,000 cells stay below the memory of one workbook at the existing 5,000,000-cell parse ceiling (`xlsx.ts:56`).

### 3.3 Rendering and isolation

**Documents use two frames, one per version.** Each goes through the unchanged `mountDocumentRoute` (`document-route.ts:80-235`), keeping its ZIP limits, DTD scan, part selector, watchdog and failure card, and through the existing `sandboxFrame` (`main.ts:1576`).
- Each frame receives only its own version's checked entries plus the first-party module text, and keeps its one-render guard (`sandbox.ts:2569-2592`).
- **New, parent to frame:** `compare: true` in the render payload.
- **New, frame to parent:** exactly one `relic:document-blocks` message, posted after ready. It carries text only, never markup.
- **Parent to frame:** one `relic:annotate` whose mark paths are `[blockIndex]`, so it carries no content.
- The diff runs only on the service origin, in a lazy chunk.
- Extraction and marking code lives in the frame modules. `sandbox.html` gains only message routing.

**Spreadsheets stay on the viewing origin, which matches B1.**
- Both versions parse in the existing `/assets/spreadsheet-parse-worker.js` through a new `compare` message. The server's worker CSP is assigned by asset name (`app.ts:446-452`), so this needs no server change.
- The parser is our own and uses no DOMParser.
- Grids render text with `textContent` (data-table `buildCell`, `:796-896`).

**Version loading is unchanged.**
- Public links mint the version, reuse the fragment key and run `load()`, which calls `routeContent` (`viewer.ts:1045-1094,1287-1436`). A historical DOCX, EPUB or XLSX therefore gets the same route and `documentKind` as the current one.
- Private links call `openVersion` with that version's own key (`viewer.ts:1029-1044`).
- The version store pins both compared versions. B5 only consumes `ReadyView`.

### 3.4 Types, messages and module surfaces (names are final)

```ts
// diff.ts (S1a; S6a turns on the three new mappings)
export type DiffMode = 'markdown'|'code'|'rendered'|'image'|'docx'|'epub'|'xlsx';
export interface ComparableView { readonly route: RenderRoute; readonly documentKind?: 'docx'|'epub'|undefined }
export function diffModeForView(view: ComparableView): DiffMode | undefined;
export function diffModeForViews(current: ComparableView, historical: ComparableView): DiffMode | undefined; // equal or undefined
// Clean cutover: remove diffModeForRoute/diffModeForRoutes. Callers: main.ts:3560,3566,3638,4112;
// diff.ts:293-296,411; diff.test.ts:8,116-124; scroll-sync.test.ts:12,1248-1278. No alias.
// After S6a: sandboxed-document+docx→'docx', +epub→'epub', otherwise undefined; spreadsheet→'xlsx';
// uncomparableClassNoun keeps only otio, media, pdf and model.

// frame-document-protocol.ts (S1a)
export type DocumentBlockKind = 'paragraph'|'heading'|'list-item'|'table-cell'|'quote'|'code'|'caption'|'image'|'media'|'text';
export interface DocumentBlock { readonly kind: DocumentBlockKind; readonly text: string; readonly part: number }
// text: /\s+/g→' ', trimmed; empty only for image/media. part: EPUB render index, DOCX 0.
export const MAX_DOCUMENT_BLOCKS = 50_000;
export const MAX_DOCUMENT_BLOCK_BYTES = 16 * 1024 * 1024;
export const MAX_DOCUMENT_PARTS = 2_000;              // = isBook spine cap (frame-document-protocol.ts:77)
export interface DocumentBlocksMessage { readonly type: 'relic:document-blocks'; readonly blocks: readonly DocumentBlock[] | null }
export function isDocumentBlocksMessage(value: unknown): value is DocumentBlocksMessage;
// Total validation: exact keys; dense array ≤ MAX_DOCUMENT_BLOCKS; each block exactly {kind,text,part};
// kind from the enum; 0 ≤ part < MAX_DOCUMENT_PARTS; UTF-8 sum ≤ budget, counted without copying
// (as rendered-tree.ts:296-319). One bad entry refuses the whole message.
// RenderDocumentMessage gains `readonly compare?: true`; isRenderDocumentMessage accepts only undefined or true.
export interface DocumentBlockSnapshot { readonly blocks: readonly DocumentBlock[]; readonly elements: readonly Element[] } // frame-only
export interface DocumentModule {               // what frame-docx.ts and frame-epub.ts export
  render(root: HTMLElement, input: DocumentInput, hooks?: DocumentRenderHooks): Promise<DocumentOutcome>;
  blocks(root: HTMLElement): DocumentBlockSnapshot | null;
  annotate(snapshot: DocumentBlockSnapshot, marks: readonly Mark[], anchors: readonly Anchor[]): number;
}

// packages/relic-format/src/epub-package.ts (S1a): the order frame-epub.ts:18-21 renders
export function epubRenderOrder(book: Pick<EpubBook,'spine'>): readonly { readonly path: string; readonly linear: boolean }[];

// domdiff.ts (S1a): RenderedChange gains
readonly segments?: { readonly before: readonly DiffSegment[]; readonly after: readonly DiffSegment[] };

// compare-ui.ts (S1a, new, types only, so lazy modules never import main.ts)
export interface ChangeReport { readonly changes: readonly RenderedChange[]; readonly total: number;
  readonly summary: string; readonly onJump?: (index: number) => void; readonly preface?: HTMLElement }
export interface ComparisonPane<S> { readonly element: HTMLElement; readonly snapshot: Promise<S | null>;
  failure?(): string | undefined; annotate(marks: readonly Mark[], anchors: readonly Anchor[]): void;
  readonly setScroll?: (p: ScrollPosition) => void; readonly revealChange?: (changeId: string, top: number) => boolean }
export type PairedResult = (TreeDiff & { readonly total: number; readonly preface?: HTMLElement }) | { readonly unavailable: string };
export interface PairedComparisonSpec<S> { readonly mode: 'markdown'|'rendered'|'docx'|'epub'; readonly label: string;
  readonly scope?: string; readonly snapshotTimeoutMs: number; readonly unavailable: string; readonly sync: 'landmark'|'frame';
  pane(view: ReadyView): ComparisonPane<S>; diff(before: S, after: S): PairedResult }
export interface ChangeNav { /* moved from main.ts:2566 */ readonly element: HTMLElement;
  setJumps(jumps: ArrayLike<ChangeJump>): void; goTo(index: number): void; step(delta: 1|-1): number | undefined }
export interface CompareStageOptions { readonly before: HTMLElement; readonly after: HTMLElement;
  readonly current: ReadyView; readonly historical: ReadyView; readonly nav: ChangeNav }
export interface CompareStage { readonly stage: HTMLElement; readonly controls: HTMLElement; readonly beforePane: HTMLElement; readonly afterPane: HTMLElement }
export interface DocumentFrameHandle { readonly frame: HTMLIFrameElement; readonly linkConfirm: HTMLElement; readonly linkRemembered: HTMLElement;
  dispose(): void; annotate(m: readonly Mark[], a?: readonly Anchor[]): void; setScroll(p: ScrollPosition): void; revealChange(id: string, top: number): void }
export interface CompareUi {
  buildCompareStage(o: CompareStageOptions): CompareStage;
  buildChangeNav(d: { readonly reveal: (jump: ChangeJump, top: number) => boolean }): ChangeNav;
  renderChangeList(changes: readonly RenderedChange[], onJump?: (i: number) => void, more?: number): HTMLElement;
  notice(text: string): HTMLElement; noChanges(summary: string): HTMLElement;
  renderSingleVersion(view: ReadyView, reason: string): HTMLElement;
  documentFrame(view: ReadyView, payload: RenderDocumentMessage, transfer: Transferable[],
    onState: (s: DocumentStateMessage) => void, onBlocks: (b: readonly DocumentBlock[] | null | 'invalid') => void): DocumentFrameHandle;
  download(view: ReadyView): void;
}

// main.ts (S1b)
export function renderPairedComparison<S>(spec: PairedComparisonSpec<S>, current: ReadyView, historical: ReadyView, onChanges?: (r: ChangeReport) => void): HTMLElement;
export function renderRenderedComparison(current, historical, mode: 'markdown'|'rendered', origin, onChanges?: (r: ChangeReport) => void): HTMLElement; // wrapper: markdownPane/framePane + diffTrees, total = jumps.length
export function buildCompareStage(o: CompareStageOptions): CompareStage;   // lifted from renderRenderedComparison
export function renderChangeList(changes, onJump?, more?): HTMLElement;     // more>0 adds a last, non-interactive row
export function sandboxFrame(view, origin, payload, onTree?, transfer = [], onDocumentState?, onDocumentBlocks?): FrameHandle;
export function compareUiFor(usercontentOrigin: string): CompareUi;
// renderLoadedVersion and renderComparison take ChangeReport; sidebar count = report.total.
// Every compare frame gets the title `Version ${n} of ${filename}`.

// document-blocks.ts (S2, new; dependency-free, NodeLike-based like rendered-tree.ts, bundled only into frame modules)
export const DOCUMENT_HIGHLIGHT_CSS: string;   // removed: dashed outline + line-through; changed: double; injected after HIGHLIGHT_CSS
export function collectBlocks(root: unknown, format: 'docx'|'epub'): DocumentBlockSnapshot | null;
export function annotateBlocks(s: DocumentBlockSnapshot, marks: readonly Mark[], anchors: readonly Anchor[]): number;

// document-route.ts (S3b)
export type CreateDocumentFrame = (payload, transfer, onState, onBlocks: (b: readonly DocumentBlock[] | null | 'invalid') => void) => DocumentFrame;
export type DocumentSnapshotResult = { readonly kind: 'blocks'; readonly blocks: readonly DocumentBlock[]; readonly book?: EpubBook }
  | { readonly kind: 'unavailable'; readonly reason: 'failed'|'protected'|'too-large'|'invalid'|'timeout' };
export const DOCUMENT_BLOCKS_WAIT_MS = 10_000;
export async function mountDocumentRoute(root, content, format, selectParts, createFrame, download,
  compare?: { readonly onSnapshot: (r: DocumentSnapshotResult) => void }): Promise<void>;

// blockdiff.ts (S3a, new, service-origin lazy chunk)
export const MAX_BLOCK_EDITS = 5_000; export const MAX_DOCUMENT_ANCHORS = 1_000;
export interface BlockDiff extends TreeDiff { readonly total: number; readonly jumpParts: readonly { readonly side: 'before'|'after'; readonly part: number }[] }
export function diffBlocks(before: readonly DocumentBlock[], after: readonly DocumentBlock[], options?: {
  partKey?: (side: 'before'|'after', part: number) => string; partLabel?: (side: 'before'|'after', part: number) => string | undefined
}): BlockDiff | 'too-many-changes';
export interface ChapterRow { readonly path: string; readonly label: string; readonly status: 'added'|'removed'|'changed'|'unchanged'; readonly changes: number; readonly firstJump?: number }
export function chapterRows(before: { blocks: readonly DocumentBlock[]; book: EpubBook }, after: { blocks: readonly DocumentBlock[]; book: EpubBook }, diff: BlockDiff): readonly ChapterRow[];

// document-compare.ts (S3b, new)
export interface DocumentSnapshot { readonly blocks: readonly DocumentBlock[]; readonly book?: EpubBook }
export function documentComparisonSpec(format: 'docx'|'epub', ui: CompareUi): PairedComparisonSpec<DocumentSnapshot>;

// relic-format/src/xlsx.ts (S4)
// WorkbookSheet gains `readonly sheetId?: number` (positive safe integer, otherwise absent; never makes parsing stricter)
export function parseXlsx(bytes: Uint8Array, inflater?: InflaterFn, options?: { readonly cellLimit?: number }): Promise<WorkbookResult>; // via the existing `remaining`, xlsx.ts:324

// relic-format/src/xlsx-diff.ts (S4, new; add "./xlsx-diff" to package.json exports)
export const XLSX_COMPARE_CELL_LIMIT = 2_000_000; export const XLSX_COMPARE_MAX_BYTES = 16 * 1024 * 1024; // test asserts === MAX_DIFF_BYTES
export const XLSX_LISTED_CELL_CHANGES = 200; export const XLSX_LISTED_TEXT_CHARS = 160;
export const CELL_KIND = { added: 1, removed: 2, changed: 3, formula: 4 } as const;
export interface CellChange { readonly row: number; readonly col: number; readonly kind: keyof typeof CELL_KIND; readonly before: string; readonly after: string } // zero-based
export interface SheetComparison { readonly status: 'unchanged'|'changed'|'added'|'removed'|'not-compared';
  readonly before?: number; readonly after?: number; readonly renamedFrom?: string;
  readonly state?: { readonly before: WorkbookSheet['state']; readonly after: WorkbookSheet['state'] };
  readonly notCompared?: 'chartsheet'|'too-large';
  readonly added: number; readonly removed: number; readonly changed: number; readonly formula: number;
  readonly positions: Uint32Array;  // [row, col, kindCode] triples, row-major; drives paint lookup and navigation
  readonly listed: readonly CellChange[] }
export interface WorkbookComparison { readonly sheets: readonly SheetComparison[]; readonly changed: boolean;
  readonly cells: { added: number; removed: number; changed: number }; // changed includes formula-only; paired sheets only
  readonly sheetsAdded: number; readonly sheetsRemoved: number; readonly sheetsRenamed: number; readonly sheetsHidden: number; readonly sheetsShown: number }
export function compareWorkbooks(before: Workbook, after: Workbook): WorkbookComparison;
// spreadsheet-parse-worker.ts, new message
// → { type: 'compare', before: ArrayBuffer, after: ArrayBuffer }   (each ≤ XLSX_COMPARE_MAX_BYTES)
// ← { ok: true, before: Workbook, after: Workbook, comparison: WorkbookComparison }   (transfers sheet arrays and positions)
// ← { ok: false, side: 'before'|'after', reason: 'corrupt'|'unsupported'|'too-large' }

// data-table.ts (S5a)
export type CompareCellState = 'added'|'removed'|'changed'|'formula';
export interface CompareTableOptions { readonly filename: string; readonly label: string; readonly widths: readonly number[];
  state(record: number, column: number): CompareCellState | undefined; onSelect?(record: number, column: number): void }
export interface CompareTablePart { readonly scroller: HTMLElement; select(r: number, c: number): void; reveal(r: number, c: number, top: number): void; dispose(): void }
export function mountCompareTable(root: HTMLElement, table: TableSource, options: CompareTableOptions): CompareTablePart;
// Compare grids: record r is A1 row r+1 (no header row); column letters shown; no sort, header toggle,
// find, comment or suggestion controls, or cell editor; Copy kept.
// Cells get class dt-diff-{state} plus a .dt-sr span " (added)" / " (removed)" / " (changed)" / " (formula changed)".
// scroll-sync.ts (S5a)
export function mirrorScrollers(panes: readonly HTMLElement[], schedule?: (run: () => void) => void): () => void; // exact top+left, driver guard

// spreadsheet-compare.ts (S5b, new)
export function renderSpreadsheetComparison(current: ReadyView, historical: ReadyView, ui: CompareUi, onChanges?: (r: ChangeReport) => void): HTMLElement;
```

**Block extraction rules (`collectBlocks`):**
- **Leaf blocks:** an element in `p, li, h1-h6, td, th, blockquote, pre, figcaption, caption, dt, dd, summary, address, div, section, article, aside, header, footer, main, figure, details` with no such descendant becomes a block. Its kind comes from its tag:
  - `p` inside `td`/`th` → table-cell; inside `li` → list-item; inside `blockquote` → quote.
  - `h1-h6` → heading; `pre` → code; `figcaption`/`caption` → caption.
  - `img`, `svg` and `picture` → image (empty text); `audio` and `video` → media.
- **Mixed containers:** a run of inline text directly inside a container that also has block children becomes a `text` block mapped to that container.
- **Dropped:** whitespace-only blocks.
- **DOCX scope:** walk `.docx-wrapper > section.docx` children except `header` and `footer`. The frame's image notice sits outside `root` (`frame-docx.ts:177`).
- **EPUB scope:** walk `article[data-epub-chapter]` only. This excludes the status warning (`frame-epub.ts:108-114`) and the shadow-root chrome. `part` is `Number(data-epub-chapter)`.

**Mark rules (`annotateBlocks`):**
- Clear any authored `data-relic-diff`, `data-relic-sync-id` and `data-relic-change-id` under the root first, as `applyMarks` does at `rendered-tree.ts:404-415`.
- Accept only paths of length 1 whose index is in range.
- Never overwrite an already-marked block with an anchor.

**Diff rules (`diffBlocks`):**
- Intern keys to integers, trim the common prefix and suffix, then call `diffArrays(…, { maxEditLength: MAX_BLOCK_EDITS })`.
- An `undefined` result returns `'too-many-changes'`.
- Ids use the existing namespaces: `d` for paired changes, `a` for anchors, `c` for jumps. They are validated by `isAnnotateMessage` (`rendered-tree.ts:558-604`) and the frame scroll regex `^[da][0-9]+$`.
- **Anchors:** the equal block on each side of every change run, plus a stride sample, capped at 1,000 per side.
- **Change quotes:**
  - Changed pairs use `diffWordsWithSpace(…, { maxEditLength: 1_000 })`. If that returns `undefined`, show plain quotes.
  - An unchanged segment longer than 80 characters keeps 40 characters of context on the side next to the change.
  - Each side is capped at 400 characters.
  - Added and removed blocks use the existing 160-character `quote`.

**Mounting gotcha:** `mountDocumentRoute` aborts if `root` is not connected (`document-route.ts:135-138`). `documentComparisonSpec().pane` runs before the stage is inserted, so it must start the mount in a `queueMicrotask` and not synchronously.

### 3.5 Copy for every state

| State | Copy |
|---|---|
| Taskbar, comparable | "Compare versions" (existing control and labels, `main.ts:1097-1130`) |
| Current page over 16 MiB | Existing notice: "This version is larger than the 16 MiB comparison limit, so Relik cannot show it beside another. Earlier versions can still be opened on their own." plus "Earlier versions" |
| Heading, history note, loading | Existing: "Comparing version {l} with version {r}" and "Loading comparison: version {l} and version {r}." |
| Byte-identical | Existing: "No changes. These versions have identical content." with "Version {l}: {file}" on its own |
| Mismatch (DOCX with EPUB, office with other class) | Existing fallback: "Version {l} and version {r} display differently, so they cannot be shown side by side. Version {l} is open here on its own." |
| Lazy module failed | "Relik could not load this comparison. Version {l} is open here on its own." |
| Document labels | "Document comparison" (DOCX), "Book comparison" (EPUB) |
| Rendering | Existing: "Rendering both versions." |
| DOCX scope line | "Compares the text of paragraphs, lists and tables. Page headers and footers, formatting, layout and image content are not compared." |
| EPUB scope line | "Compares the text of each chapter. Formatting, layout and image content are not compared." |
| Result | "{a} added, {r} removed, {c} changed." (zero terms omitted, same ordering as `domdiff.ts:577-594`) |
| No text change | "No text changes. Formatting, layout and image content are not compared." |
| Version failed | "Version {n} could not be shown, so changes are not outlined." (the pane shows the existing card: "This document could not be shown." and so on) |
| DRM | "Version {n} is protected by DRM, so changes are not outlined." |
| Over block budget | "Both versions are shown. They are too long for Relik to outline their changes." |
| Too many edits | "Both versions are shown. They differ in too many places for Relik to outline the changes." |
| Invalid snapshot or timeout | "Both versions are shown. Relik could not read their text, so changes are not outlined." |
| Change row kinds | paragraph, heading, list item, table cell, quote, code block, caption, image, media, text; EPUB appends " in {chapter}" |
| More row | "{n} more changes. Use Next change to reach them." |
| Chapters preface | Heading "Chapters". Rows "{label}" with "{n} changes", "1 change", "added" or "removed". Collapsed "{n} unchanged chapters" or "1 unchanged chapter". Missing label: "Section {n}". Title line: "The title changed from {old} to {new}." |
| Sheet label and loading | "Spreadsheet comparison"; "Reading both spreadsheets." |
| Sheet scope line | "Cells are compared by position, by the value shown and the formula. Formatting, charts and images are not compared. A row or column inserted early shifts every cell after it." |
| Sheet result | "{c} cells changed, {a} added, {r} removed." then " {n} sheets added, {n} removed, {n} renamed, {n} hidden, {n} shown." (zero terms omitted, singular forms) |
| No value change | "No changes to cell values or formulas. Formatting, charts and images are not compared." |
| Too large | "Version {n} is too large to compare. Relik compares spreadsheets of up to 2,000,000 cells. Version {l} is open here on its own." |
| Unreadable | "Version {n} could not be read as a spreadsheet, so it cannot be compared. Version {l} is open here on its own." |
| Worker timeout | "This comparison took too long to prepare. Version {l} is open here on its own." |
| Sheet badges | "{n} changes", "added", "removed", "renamed from {old}", "hidden", "shown", "not compared" |
| Sheet placeholders | "This sheet is not in version {l}." / "This sheet is not in version {r}." / "This sheet contains a chart, which is not compared." / "This sheet has more than 600,000 rows and cannot be compared." |
| Cell rows | what = "C14" or "C14 formula"; detail = before (`del`) and after (`ins`); past 256 columns: "{ref} is past the 256 columns drawn here." |
| Cell more row | "{n} more changed cells on this sheet. Use Next change to reach them." |

Sidebar count for spreadsheets is the workbook total: cell changes plus sheet-level changes. Navigation counts the active sheet's cells.

### 3.6 Accessibility and mobile

- **Frames:** titled "Version {n} of {filename}". This applies to HTML compare frames too.
- **Existing behaviour that carries over:** change rows are buttons that respond to Enter and Space, the nav position uses polite `aria-live`, and the heading takes focus when versions change.
- **Non-colour cues:**
  - Documents: added is a solid outline; removed is dashed with line-through; changed is double.
  - Grids: added is a solid stripe; removed is struck through; changed is dotted; formula changes carry an "fx" corner. Every state also has visually hidden text.
- **Sheet strip:** `role=tablist` with `aria-label` "Sheets in version {l} and version {r}". Tabs get `aria-selected` and `aria-controls`, a roving tabindex, and Left, Right, Home and End keys.
- **Grids:** labelled "Version {n} of {file}, sheet {name}". Selection mirrors across panes; Tab moves between panes.
- **Mobile at 44rem and below:** keep the existing stacking (`styles.css:2839-2867`), with the current label moving to the foot. The sidebar becomes the existing drawer. The sheet strip scrolls horizontally.
- **At 390×844:** no page-level horizontal overflow. There is no new animation.

### 3.7 Affected path and proof inventory

**Affected path:**
1. `relik.link/<id>` → taskbar (`main.ts:1097-1130`)
2. `renderComparison` (`:3835`) → `versionsFor` / `store.get` → `loadHistoricalVersion` (`viewer.ts:988`)
3. `renderLoadedVersion` (`:3617`) → dispatch by mode
4. New renderers → sidebar `setChanges`

**Proof already in place:**
- `mise run verify` runs lint, typecheck, and test (which builds first) (`mise.toml:48-50`; root `package.json` test is `bun run build && bun test`).
- The verify CI job runs browser stages with `google-chrome` (`verify.yml:101-162`).
- **Browser comparison today:** only `multi-file-stages/compare.ts`, covering a folder and markdown.
- **Patterns to reuse:**
  - OOPIF auto-attach: `epub-viewer-path.ts:239-294`, with the frame lookup at `:318-345`.
  - EPUB and XLSX builders: `epub-viewer-path.ts:65-131` and `spreadsheet-path.ts:68-145`.
  - DOCX builder: the `docx` npm package, as in `docx-frame-path.mjs`. That script is not run in CI.
- **Unit harnesses:**
  - DOM stubs: `version-diff-ui.test.ts:36-163`.
  - mountDocument with a data-URL module: `browser.test.ts:542-607`.
  - Headless-shell DOM test: `data-table.test.ts:159-172,769-862`.
- **Blind spots:** Chrome only; no Safari or Firefox; no touch or IME; no phone memory measurement; private relics are not compared in a browser (they share the loader, and §4 S6a adds a unit check).

## 4. Slices

All slices land on one integration branch, `b5-version-compare`, and ship as **one ready-for-review PR**: one workstream, one PR. Each slice works in its own ovnfs checkout created from the integration tip.

**Order:**
- **Wave 1:** S0, S1a, S4, S5a, and the S6b fixtures.
- **Wave 2:** S1b, S2, S3a.
- **Wave 3:** S3b, S5b.
- **Wave 4:** S6a, then the final S6b run.

| Slice | Owns | Depends on |
|---|---|---|
| **S0 Mock** (designer) | `docs/plans/version-compare/{mockup.html, mock-shots/, plan.md}` | none |
| **S1a Contract** | `diff.ts` (modes and cutover, no new mappings yet); `frame-document-protocol.ts`; new `compare-ui.ts`; `domdiff.ts` (type only); `relic-format/src/epub-package.ts` (`epubRenderOrder`); `main.ts` (only the 4 cutover call sites). Tests: `diff.test.ts`, `scroll-sync.test.ts` (cutover lines), `frame-document-protocol.test.ts`, `relic-format/src/epub-package.test.ts` | none |
| **S1b Compare shell** | `main.ts` compare section (`renderPairedComparison`, `buildCompareStage`, ChangeReport cutover, `renderChangeList` with `more` and segments, sidebar total, `ChangeNav` over `ArrayLike`, `sandboxFrame` `onDocumentBlocks`, frame titles, `compareUiFor`); `styles.css` (all new shell rules: `.diff-scope`, `.diff-change-more`, segment spans, `.diff-chapters`). Tests: `version-diff-ui.test.ts`, `compare-nav.test.ts`, `version-view.test.ts` | S1a; S0 for styles |
| **S2 Frame blocks** | new `document-blocks.ts`; `frame-docx.ts`, `frame-epub.ts` (export `blocks`/`annotate`; epub uses `epubRenderOrder`); `sandbox.ts` (compare flow, annotate routing, image controls off when comparing). Tests: new `document-blocks.test.ts`, `browser.test.ts`, `annotate-frame.test.ts` | S1a |
| **S3a Block diff** | new `blockdiff.ts`, new `blockdiff.test.ts` | S1a |
| **S3b Document comparison** | new `document-compare.ts`; `document-route.ts` (compare option). Tests: new `document-compare.test.ts`, `document-route.test.ts` | S1b, S3a, S0 |
| **S4 Workbook model** | `relic-format/src/xlsx.ts` (`sheetId`, `cellLimit`); new `xlsx-diff.ts`; `relic-format/package.json`; `spreadsheet-parse-worker.ts` (`compare`). Tests: `xlsx.test.ts`, new `xlsx-diff.test.ts`, new `relic-viewer/test/spreadsheet-compare-worker.test.ts` | none |
| **S5a Compare grid** | `data-table.ts` (`mountCompareTable`); `data-table.css` (diff states, sheet strip, placeholders); `scroll-sync.ts` (`mirrorScrollers`). Tests: `data-table.test.ts`, new `mirror-scroll.test.ts` | S0 for visuals |
| **S5b Spreadsheet comparison** | new `spreadsheet-compare.ts`, new `spreadsheet-compare.test.ts` | S1b, S4, S5a, S0 |
| **S6a Wiring and spec** | `diff.ts` (turn on docx, epub, xlsx; trim `uncomparableClassNoun`); `main.ts` (lazy dispatch in `renderLoadedVersion`, identical-bytes check in `renderComparison`); flipped tests in `diff.test.ts`, `version-view.test.ts`, `version-diff-ui.test.ts`; `sandbox-bundle.test.ts`; `docs/spec/viewer.md`; `docs/decisions.md` | S1b, S2, S3b, S5b |
| **S6b Proof** | new `relic-mcp/test/version-compare-path.ts` and `version-compare-fixtures.ts`; new `version-compare-live-probe.ts`; one `verify.yml` step plus a shots upload; root `PATH.md`; `packages/relic-mcp/PATH.md` | S6a for the final run |

Every slice runs `bun install --frozen-lockfile` first. In ovnfs checkouts, run tsc as `node ../../node_modules/typescript/bin/tsc --noEmit` from inside the package. After `bun run --cwd packages/relic-mcp build`, run `git checkout -- packages/relic-mcp/mcp-servers.json` and never commit that file. Owned shell: `$HOME/.omp/owned-shells/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell`.

**S1a: Contract**
- **Change:** the §3.4 contract, keeping today's mapping (the office modes still return `undefined`).
- **Non-goals:** no UI change.
- **Acceptance:**
  - Run `bun test packages/relic-viewer/test/diff.test.ts packages/relic-viewer/test/scroll-sync.test.ts packages/relic-viewer/test/frame-document-protocol.test.ts packages/relic-format/src/epub-package.test.ts` and tsc for relic-viewer and relic-format: both pass.
  - Searching `diffModeForRoutes?\b` across `packages/` returns nothing.
  - New cases:
    - `isDocumentBlocksMessage` accepts `null` and a valid set. It refuses extra keys, a sparse array, an unknown kind, `part` equal to 2000, 50,001 blocks, and 16 MiB + 1 byte of text.
    - `compare: false` or `"true"` is refused.
    - Render order puts linear items first.

**S1b: Compare shell**
- **Change:** move the layout, swipe and label construction out of `renderRenderedComparison` (`main.ts:2858-3077`) into `buildCompareStage`. Rebuild markdown and HTML on `renderPairedComparison`, unchanged except for frame titles, the exact count and the more row.
- **`sandboxFrame` accepts blocks** only from its own `contentWindow`, after `handshake.rendered` and a delivered ready state, and only once. An invalid message calls back with `'invalid'` once.
- **Non-goals:** no office mode wiring.
- **Acceptance:**
  - Run the five test files named in the table plus `domdiff.test.ts` and `folder-compare.test.ts`: all pass.
  - Run `bun run --cwd packages/relic-viewer build && bun test packages/relic-viewer/test/shell-budget.test.ts packages/relic-viewer/test/sandbox-bundle.test.ts`: passes.
  - Build the MCP, then `RELIC_REQUIRE_CHROME=1 RELIC_CHROME_PATH=<owned shell> bun packages/relic-mcp/test/multi-file-path.ts` prints `MULTI_FILE_STAGE compare OK` and `MULTI_FILE_PATH_OK`.
  - New stub cases:
    - 60 HTML changes: the sidebar shows "60", the list shows 40 rows plus "20 more changes. Use Next change to reach them.".
    - A frame title reads "Version 2 of page.html".
    - Block acceptance: ignored before ready, ignored from a foreign source, accepted once, a second message ignored.
    - A segment containing `<img onerror>` text creates no element.

**S2: Frame blocks**
- **Non-goals:** no change to rendering when not comparing; no parent code.
- **Acceptance:**
  - `bun test packages/relic-viewer/test/document-blocks.test.ts packages/relic-viewer/test/browser.test.ts packages/relic-viewer/test/annotate-frame.test.ts packages/relic-viewer/test/frame-document-protocol.test.ts` passes, then build plus `sandbox-bundle.test.ts` and `shell-budget.test.ts` pass.
  - New cases:
    - **DOCX stub page:** header "Draft" and footer excluded; table cells come out as table-cell; footnote `ol` items as list-item; an image inside a paragraph as an image block; a mixed container produces a `text` block.
    - **EPUB stub:** only articles are read, the status warning is excluded, and `part` equals `data-epub-chapter`.
    - Over either budget returns `null`.
    - `annotateBlocks` clears authored attributes, ignores out-of-range and multi-index paths, and anchors skip marked blocks.
    - **mountDocument harness:** a compare render posts ready and then exactly one blocks message. Without compare it posts none. A throwing `blocks()` posts `null`. A failed render posts no blocks.
    - Annotate after a compare render reaches `module.annotate` and never `applyMarks(document.body)`.
    - Image controls are off when comparing.

**S3a: Block diff**
- **Acceptance:** `bun test packages/relic-viewer/test/blockdiff.test.ts` passes, with these cases:
  - The §6 DOCX fixture keys give "1 added, 1 removed, 2 changed.", jumps in reading order, mark paths `[i]`, shared `d` ids on pairs, anchors capped at 1,000 that include each change's neighbours.
  - In the EPUB fixture a removed chapter does not pair with an added chapter, giving "2 added, 2 removed, 1 changed.", with the expected chapter rows, the "Section 3" fallback, and repeated spine paths aggregated.
  - 5,001 edits give `'too-many-changes'`; exactly 5,000 still diff.
  - Identical input returns the no-text-change summary.
  - A 3,000-character paragraph changed at character 2,500 shows the difference within the 400-character excerpt.
  - Timing on 50,000 blocks with 5,000 edits is logged as evidence, not used as a gate.

**S3b: Document comparison**
- **Acceptance:** `bun test packages/relic-viewer/test/document-compare.test.ts packages/relic-viewer/test/document-route.test.ts` passes, with these cases:
  - Compare sets `payload.compare`. `onSnapshot` fires once with blocks plus the parent-parsed book.
  - It reports `protected` for a DRM book, `failed` for a failed render, `too-large` when the frame sends `null`, `invalid`, and `timeout` (with fake timers).
  - Disconnecting disposes.
  - A pane created before insertion still mounts.
  - Failure copy names the version.
  - The EPUB preface rows jump, and the title line appears. DOCX has no preface.
  - Label and scope strings match §3.5 exactly.

**S4: Workbook model**
- **Acceptance:** `bun test packages/relic-format/src/xlsx.test.ts packages/relic-format/src/xlsx-diff.test.ts packages/relic-viewer/test/spreadsheet-compare-worker.test.ts` and relic-format tsc pass, and the viewer builds. Cases:
  - `sheetId` values `'0'`, `'-1'` and `'x'` are absent and never throw.
  - `cellLimit` 2,000,000 is refused during parse at 2,000,001 cells.
  - The §6 workbooks give exact counts and statuses.
  - A reused `sheetId` with less than 50% of cells unchanged reads as removed plus added; a case-only name change reads as renamed.
  - Chartsheet and over-600,000-row sheets are not-compared.
  - Positions are row-major; listed changes are at most 200 with text at most 160 characters plus "…".
  - The worker, run as a real Bun Worker, refuses a non-ArrayBuffer and 16 MiB + 1 byte, and reports `side: 'after'` for a corrupt after version.
  - `XLSX_COMPARE_MAX_BYTES === MAX_DIFF_BYTES`.

**S5a: Compare grid**
- **Acceptance:** `RELIC_CHROME_PATH=<owned shell> bun test packages/relic-viewer/test/data-table.test.ts packages/relic-viewer/test/mirror-scroll.test.ts` passes, with these cases:
  - Compare cells get the classes and hidden text.
  - Clicking a header does not sort; there is no find box, header toggle or comment buttons.
  - Rows are numbered from 1 with column letters.
  - Shared widths apply; `select` mirrors through `onSelect`; `reveal` scrolls the cell to `top`.
  - Existing CSV and XLSX cases still pass.
  - Mirroring covers both axes and suppresses its own echo.

**S5b: Spreadsheet comparison**
- **Acceptance:** `bun test packages/relic-viewer/test/spreadsheet-compare.test.ts` passes, using DOM stubs and an injected fake worker:
  - Strip order and badges; the default sheet is the first with changes.
  - Added and removed placeholders; tablist keyboard handling.
  - ChangeReport total and summary strings; list rows and the more row.
  - Over-limit, unreadable and timeout each show the left version on its own with exact copy.
  - The worker is terminated on result, dispose and stage replacement.

**S6a: Wiring and spec**
- **Acceptance:**
  - `mise exec node@18.20.8 -- mise run verify` and `mise exec node@24.15.0 -- mise run verify` both pass.
  - Flipped and new cases:
    - DOCX, EPUB and XLSX views are available at 16 MiB or less, and report `comparison_too_large` above it with the existing copy.
    - DOCX against EPUB gives `undefined` and the "display differently" copy.
    - `sandboxed-document` with no `documentKind` gives `comparison_not_renderable`.
    - A private DOCX view is available.
    - The taskbar reads "Compare versions" for DOCX and XLSX.
  - `sandbox-bundle.test.ts`:
    - The blockdiff marker "They differ in too many places" sits in one lazily reachable shell chunk and is absent from `sandbox.html`, `frame-docx.frame.js` and `frame-epub.frame.js`.
    - A `document-blocks.ts` marker is present in both frame modules and absent from `sandbox.html` and `viewer.js`.
    - `relic:document-blocks` is present in `sandbox.html`.
- **Docs, `viewer.md`:**
  - Add comparison paragraphs to §3.8 and §3.9.
  - Name the classes in §6.1 item 7.
  - Add the new no-change wording to item 12.
  - Append items 14 (documents and books) and 15 (spreadsheets). Do not renumber: item 13 is cited at `viewer.md:598`.
  - Update the ceiling paragraph (`:461`) and the trust-boundary paragraph (`:475`), which must now name three message types.
- **Docs, `decisions.md`:** add an entry dated 2026-11-22.

**S6b: Proof.** Build the viewer and MCP, then run `bun packages/relic-mcp/test/version-compare-path.ts` twice:
1. `RELIC_CHROME_PATH=<owned shell>`
2. `RELIC_CHROME_PATH="$HOME/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"` (full Chrome, `--headless=new`, own profile)

Both runs end with `VERSION_COMPARE_PATH_OK formats=docx,epub,xlsx widths=1440,390 negatives=5`, and `bun run --cwd packages/relic-mcp typecheck` passes. The `verify.yml` step goes after B4's, following the pattern `env -u DISPLAY -u WAYLAND_DISPLAY RELIC_CHROME_PATH="$(command -v google-chrome)" bun packages/relic-mcp/test/version-compare-path.ts`, with `RELIC_COMPARE_PATH_SHOTS` uploaded under `if: always()`.

**How the stage works:**
- Two loopback servers, as in `epub-viewer-path.ts:20-64`.
- Publish v1 with `relic_publish`, then v2 with `relic_republish`, through the built MCP over stdio.
- Open the returned share URL. That is the visitor entry path.
- Click "Compare versions" with a real `Input.dispatchMouseEvent`.
- Read each pane's frame through the OOPIF-or-in-process lookup.

**Fixtures:**
- **DOCX v1:** "Quarterly plan"; "Revenue grew in every region."; "Hiring stays flat."; a table (Region/Target, West/120); "This sentence is removed in version 2."; a 1×1 image; header "Draft"; footer "Internal".
- **DOCX v2:** the revenue paragraph ends "…except the north."; 120 becomes 135; the removed sentence is gone; "Launch in May." added after the image; header "Final".
- **EPUB:** ch1 Opening (unchanged); ch2 The crossing (one paragraph changed); ch3 Interlude (removed); ch4 Afterword (added at the end).
- **XLSX:**
  - "Q3", sheetId 1, renamed to "Q3 budget" in v2: C3 1200→1250; E2 `=SUM(B2:C3)` 2200→2250 with a new formula; E3 `=B2*2`→`=B2+B2` with the same cached 2000; D5 "Total" added; B7 "Draft note" removed.
  - "Old data" (sheetId 2) removed.
  - "Hidden" (sheetId 3, hidden) A1 x→y.
  - "Summary" (sheetId 4) added.

**Expected at 1440×900:**
- DOCX: "1 added, 1 removed, 2 changed.", matching `data-relic-diff` counts in each frame, and no "Draft" or "Final" in the change list.
- EPUB: "2 added, 2 removed, 1 changed." with rows "The crossing", "Interlude · removed", "Afterword · added", "1 unchanged chapter".
- XLSX: "4 cells changed, 1 added, 1 removed. 1 sheet added, 1 removed, 1 renamed."; C3 has `dt-diff-changed` in both panes, D5 only in the after pane, B7 only in the before pane, E3 has `dt-diff-formula`; navigation reads "Change 1 of 5" on Q3 budget.
- Navigation: Next change lights `.is-current-change` in the right frame.
- Sync: a layout round-trip works; scrolling the after frame moves the before frame within 2 s; grids mirror `scrollTop` and `scrollLeft` exactly.

**Expected at 390×844:** stacked panes (before.bottom ≤ after.top + 1), `scrollWidth <= innerWidth`, and the Changes tab visible.

**Negatives:**
1. DOCX v1 against a v1′ that differs only in `core.xml` gives "No text changes…" and zero marks. This proves the mark check can fail.
2. A DOCX relic republished as EPUB gives "display differently".
3. A DOCX with a 17 MiB stored padding entry gives the 16 MiB notice and "Earlier versions".
4. EPUB text `<img src=x onerror="window.__relicPwned=1">` changes: the row shows it as literal text, no `img` appears in the sidebar, `__relicPwned` stays undefined, and a U+202E sheet name shows as a visible escape.
5. Frames make zero network requests.

**Live probe (`version-compare-live-probe.ts`):**
- Requires `RELIC_COMPARE_PROBE_CONFIRM=publish-three-1-day-relics`. `RELIC_SERVICE_ORIGIN` defaults to `https://relik.link`.
- Publishes and republishes one untitled relic per format with a 1-day TTL and `cover: false`, following the existing live-probe precedent at `relic-mcp/PATH.md:331-361`.
- Checks the same summaries at both widths in the owned shell.
- Never prints a URL or key.
- Ends with `VERSION_COMPARE_LIVE_OK docx=<id> epub=<id> xlsx=<id>`.

## 5. Review risks and the two independent security reviews

Run both reviews on the PR diff before merge, per ship-relic-change.

**Review D, documents (S1a validator, S1b gating, S2, S3a, S3b, S6a bundle test and spec):**
1. Blocks validation is total and budgeted, accepted once, and only after ready from the frame's own window. A bad message is refused, never partly salvaged.
2. Frame text reaches the parent only through `textContent` or `createTextNode`: no `innerHTML`, `insertAdjacentHTML` or `outerHTML` in the new modules. Labels go through `visibleLabel`. S6b negative 4 passes.
3. The frame still renders once. Annotate carries only paths, kinds and ids, is accepted once, and authored ids are cleared first.
4. Each frame gets only its own entries and never the key. Zero requests, no nested frames.
5. Diff code is absent from `sandbox.html` and the frame modules.
6. The bounds hold, with times recorded on the largest fixtures.
7. Frame image controls are off when comparing.

**Review X, spreadsheets (S4, S5a, S5b):**
1. The worker validates the message and size. `cellLimit` bounds memory before the diff runs.
2. Formulas are never evaluated; formulas and values are shown as text; sheet names keep bidi characters visible.
3. Compare grids expose no comment, suggestion, sort or editor surface.
4. The worker is terminated on every exit path.
5. No new asset; the worker CSP is unchanged.

**Separate work, not B5:** row alignment for spreadsheets, image pixel comparison, an MCP comparison tool, and the existing spec drift listed in `structured-formats/plan.md:330`.

## 6. End-to-end proof and release

1. **Before merge:** `mise run verify` passes on Node 18 and 24, the S6b stage passes on both local browsers, the PR's CI verify is green (it runs the stage on full Chrome), and both reviews are done. Merge with a merge commit, not squash.
2. **Deploy:** `deploy.yml` ships the server container, which carries the viewer. Watch it to completion.
   - No server code changes. Nothing under `packages/relic-mcp/src` changes, so there is no npm release.
3. **Post-deploy gate:**
   - Build the viewer from the deployed commit in a clean checkout (`rm -rf packages/relic-viewer/dist` first). Compare `shasum -a 256` of each `dist/` file against `https://relik.link/assets/<name>`.
   - Search the served chunks for "Book comparison" and "Spreadsheet comparison".
   - Run the live probe through `relik.link/<id>` with two versions.
4. **Rollback:** revert the merge commit and let it redeploy. There is no data migration.

## 7. What would prove this spec wrong, and open unknowns

- **Extraction misses text.** Block extraction recovers less than 95% of the `w:t` text on real Word files with text boxes or content controls. Then the leaf-block rule or the DOCX scope is wrong.
- **The diff is too slow.** `diffBlocks` at 5,000 edits on 50,000 blocks takes over 1 s on the CI runner. Then lower the caps, or move the diff into a worker, which needs a server CSP entry.
- **Two renders time out.** Two 16 MiB documents rendering concurrently hit the 30 s watchdog in CI. Then stagger the second frame.
- **Renames misfire.** LibreOffice or Google Sheets exports reuse `sheetId` and produce false renames despite the 50% guard. Then drop `sheetId` pairing.
- **Positional comparison floods.** Real users see walls of changed cells after a row insert. Then add row alignment.
- **Large messages stall the parent.** A 16 MiB blocks message noticeably stalls the parent while it is cloned. Then lower the text budget.
- **B4 conflict.** If B4 lands a byte-for-byte `sandbox.html` assertion, S2 must update it.
- **Unknowns:**
  - Phone memory with two documents open.
  - Safari and Firefox behaviour of the frame modules.
  - How often real DOCX versions exceed 16 MiB.
  - Scroll-landmark cost: up to about 2,000 `[data-relic-sync-id]` rect reads per scroll report in each frame.
- **Product calls made here that are cheap to change if Jason disagrees:**
  - Spreadsheets compare by position.
  - Images compare by presence only.
  - DOCX page headers and footers are excluded.
  - The 2,000,000-cell, 50,000-block and 5,000-edit limits.
  - Compare panes keep no comment or suggestion surfaces, as for every other class today.

## 8. Mock brief (S0, designer agent)

**Files:**
- `docs/plans/version-compare/mockup.html`: one self-contained page with no `<script src>` and no `<link href>`.
- `docs/plans/version-compare/mock-shots/<KEY>-<width>-<light|dark>.png`.
- This spec as `plan.md`.

**Conventions** (copied from `docs/plans/structured-formats/mockup.html`):
- States register with `S(key, group, title, cfg)` (line 1844).
- The initial state comes from `location.hash`; a state change calls `history.replaceState(null,'','#'+key)`.
- Set `body[data-ready]` after two animation frames.
- Provide theme and width toggles.
- Reuse the viewer's real tokens and chrome: band, "Version history" eyebrow, heading, history note, Left/Right pickers with "to", Swipe/Side by side, slider, Previous change/Next change with position, Changes sidebar and its tab.
- Use the §6 fixture text, never lorem.
- **Interactive:** layout toggle, slider, navigation, row and chapter clicks, sheet-tab arrow keys, mirrored cell selection with both cellbars, drawer at 390.

**States** (§3.5 copy verbatim):

| Group | States |
|---|---|
| **Taskbar** | TB1 DOCX at v3 with "Compare versions"; TB2 a 20.4 MB DOCX with the 16 MiB notice and "Earlier versions" |
| **DOCX** | DC1 loading; DC2 split with four outlined changes, segmented rows and "Change 1 of 4"; DC3 swipe at 40%; DC4 no text changes; DC5 left version failed; DC6 too many changes; DC7 too long; DC8 60 changes (40 rows, more row, count 60); DC9 mismatch, single version; DC10 390 stacked, with drawer variant DC10b |
| **EPUB** | BC1 split with Chapters preface and "in The crossing" rows; BC2 DRM card in the left pane; BC3 title-change line; BC4 390 |
| **XLSX** | SC1 loading; SC2 split with strip "Q3 budget · renamed from Q3 · 5 changes", "Summary · added", "Old data · removed", "Hidden · hidden · 1 change", the cell states with non-colour cues, C3 selected in both panes with cellbars 1,200 and 1,250, summary and scope lines; SC3 added-sheet placeholder; SC4 removed-sheet placeholder; SC5 chartsheet not compared; SC6 swipe over aligned grids; SC7 no value changes; SC8 too large, single version; SC9 unreadable version; SC10 390 with a scrolling strip and drawer; SC11 keyboard focus on a tab and on the active cell |
| **Hostile text** | XS1 a row showing literal `<img src=x onerror=alert(1)>` and a U+202E sheet name drawn as a visible escape |

**Shots:**
- 1440 light for every key.
- 1440 dark for DC2, BC1 and SC2.
- 390 light for DC10, BC4 and SC10.

**Acceptance:**
- The page opens offline.
- Every key resolves through its hash.
- A search for `<script src` or `<link href` in the page finds nothing.
- Every listed shot exists.