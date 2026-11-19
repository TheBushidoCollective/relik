# Structured formats: security review fixes, worker B

Branch `sf-fix-b`, base `d9a97984` (PR #176 head). Scope: `packages/relic-viewer`
only. Timings are from the isolated headless shell (chrome-headless-shell 1228),
run through a scratch page; the pre-fix numbers ran the base-commit view files.

Status key: **reproduced** means the defect was measured or failed a test on the
pre-fix code. **fixed** means the post-fix code passes that test or measurement.

## SF-MD-REDOS (markdown linear time): fixed

- Reproduced at base (`markdown.ts`, `inline()` link rule, Bun, 200,000 `[`):
  40,970 ms (`markdown-pathological.test.ts`, run against the base file).
  Scaling at base: 5,000 → 12 ms, 10,000 → 44 ms, 20,000 → 178 ms (quadratic).
  `'>'.repeat(20000)` threw `RangeError` at base.
- After: `'['.repeat(200000)` 1 ms; `'a|\n' + ' '.repeat(500000) + 'x'` 3 ms;
  `'>'.repeat(100000)` 3 ms (capped at depth 32); `'!['` and `'[a]('` runs at
  200,000 each 2 ms.
- Commit `7599c044`. Test: `test/markdown-pathological.test.ts` (7 cases).
  Existing markdown tests (`markdown*.test.ts`, 71 cases) pass unchanged.

## SF-UNCAPPED-REDRAW (table and tree redraw, caps): fixed

- Before (base, Chrome headless, 40 records x 256 columns x 3 KB cells; 30 keys
  of 1 MB in a tree), median ms per scroll event, 30 events each:
  - table, 1 px nudge: 342.7; row steps (window moves): 521.4; no-change event: 345.7
  - tree, 1 px nudge: 1,617.7; row steps: 2,013.0; no-change event: 856.4
- After: table 1 px nudge 16.7; row steps 191.2; no-change 16.7.
  tree 1 px nudge 16.8; row steps 16.6; no-change 16.8.
- The pixel nudge now draws nothing (`bodyKey` / `windowKey` match the drawn
  window), so the scroll path skips the rebuild.
- Caps: cells, the inspector value and column name, the Row line and key labels
  show 512 source characters before the escape; Copy takes the full text.
- Commits `ce8aabe3` (Main's pushed WIP of this change), `278aa73b`.
- Test: `test/structured-fixes-browser.test.ts` ("a 1 px scroll keeps the drawn
  table rows..." and the tree twin, "a long cell is cut ..."), and
  `test/structured-fixes.test.ts` (1 MB key). The browser case fails at base on
  the redraw check ("a 1 px scroll rebuilt the drawn rows").

## SF-BIDI-LABELS (labels escape bidi and are capped): fixed

- The table Row line, the grid aria-label filename (`labelText`), the tree
  `.jt-pointer` (`visibleLabel`), `annotate-path.ts` and `annotate-cell.ts`
  (`visibleLabel`) all escape and cap. A stored pointer `/\u202Efdp.exe` renders
  `Commenting on /\u202efdp.exe`.
- Test: `structured-fixes-browser.test.ts` ("a long cell is cut ...",
  "a decoded U+202E key shows escaped in the pointer") and
  `structured-fixes.test.ts` (path and sheet labels). The unit file does not load
  at base (it imports `clipboardText`), so this guard is proven by the browser
  cases and the code path, not by a base run of the unit file.

## SF-CLIPBOARD-RAW (copy writes escapes): fixed

- Table Copy writes `clipboardText(...)`: every control except tab and LF, and
  the bidi set, as `\u{...}`. Tree Copy path writes the `\uXXXX`-escaped pointer
  (RFC 6901 tilde already `~0`). Tree Copy value writes the escaped JSON source,
  which is still valid JSON for the same string.
- Test: `structured-fixes-browser.test.ts` ("copying a cell with ESC and LF ...",
  "Copy path writes the escaped pointer ..."), `structured-fixes.test.ts`
  (clipboard escapes).
- Not changed by design: tab and LF inside a cell still copy as raw separators,
  because the format needs them. ESC is escaped, which is what ends a bracketed
  paste early.

## SF-POINTER-UNWRITABLE (viewer part): fixed

- `postComment` and `editComment` catch `MalformedCommentError` from the cipher and
  return `unwritable_comment` (a visible refusal). Other errors still throw.
- A refused post restores the composer's target (`marks.restore`) unless the
  reader chose another. This applies to every refusal, not only this one.
- The tree offers Comment only where the writer accepts the pointer
  (`pointerWritable`: no NUL, no CR). The reason is in the control's title.
- Reproduced at base: `comment-post-refusal.test.ts`, "postComment returns a
  refusal and sends nothing" and "editComment returns the same refusal" fail
  (the seal error escapes as a rejection). Commit `bb65b281`.
- Tests: `comment-post-refusal.test.ts` (3), `structured-fixes-browser.test.ts`
  ("a key holding a CR keeps Comment off, with the reason"),
  `structured-fixes.test.ts` ("a key holding a CR has no selection anchor").
- SfFixA's `pointer()` change is not merged here; the local guard covers the
  viewer until it lands.

## SF-MARK-SUPERLINEAR (mark painting): fixed

- Before (base, headless shell, `page-marks.js`):
  - cues, 500 comments of 50 cues each on a 20,000-cue file: 1,705.2 ms (25,250
    marks in the DOM)
  - cues, 20 whole-file spans: 1,234.7 ms (400,000 marks)
  - table, 300 single-cell comments: 352.2 ms
- After: 100.5 ms (25,250 marks, unchanged); 13.7 ms (10,000 marks, capped at 500
  per comment); 0.5 ms.
- Table: a mark indexes its cell by row and repaints only the cells it covers.
  Cue: each comment keeps its mark nodes; a whole-file span marks 500 cues and the
  title says "spans N cues; the first 500 are marked". Notebook: a paint refreshes
  only the element it marked.
- Commit `72efa2c6`. Test: `structured-fixes-browser.test.ts` ("a comment spanning
  every cue ...": 2000 != 500 at base, verified by revert). The table repaint case
  is a regression guard and passes at base too.

## Other

- Lint: biome rejected control-character regex classes; replaced by character
  loops (commit `5903dc45`). `bunx biome check . --diagnostic-level=error` is
  clean.
- Known flake, unchanged: `large-relic-path` (#178).
