# A2 Tree: notes for A5 and the parent

Branch `sf-a2-tree`. Commits: `8a2bddef` (reader), `1bb8811c` (view state), `952cc736` (DOM view).

## Stage `tree` for A5

The path script should prove, on a published `.json` relic, through the real entry path:

1. The file opens as `role="tree"` with the summary line, and the root shows `$`.
2. A file with a repeated key shows both badges: `DUPLICATE KEY · IGNORED` and `DUPLICATE KEY · THIS ONE COUNTS`.
3. Selecting a value and pressing Comment sends `relic:structured-comment` with a `path` anchor. Post the comment; the mark paints on that row.
4. Collapse all, then Expand all: the mark is still on the row. Reveal from the comment list opens the ancestors and selects the node.
5. Hostile keys and values (`<img src=x onerror=…>`) create no `img`, `script`, `svg` or `iframe` element.
6. A 100,000-deep file gets "This file is nested too deeply to show as a tree, so its text is shown.", and the page does not hang.
7. A file with a missing comma gets "Line L, column C: expected a comma or a closing brace." above its source, with no tree.
8. A 50,000-value array keeps fewer than 100 rows in the DOM.
9. The `/assets/json-tree-view.css` request returns 200 and the tree is styled.

## Exports for A4 (notebook reuses the reader)

From `@relic/format` (root) and `@relic/format/json-tree`:

- `parseJsonTree(source) → { ok, tree } | { ok: false, failure }`. Never throws.
- `JsonTree` with `size`, `maxDepth`, `duplicateCount`, `kind`, `isContainer`, `parent`, `depth`, `childCount`, `firstChild`, `nextSibling`, `index`, `valueStart`, `valueEnd`, `hasKey`, `isShadowed`, `isDuplicated`, `spanStart`, `keySource`, `key`, `valueSource`, `children`, `pointer`, `resolve`, `nodeAt`.
- `JsonTreeFailure`, `JsonTreeResult`, `JsonValueKind`.
- `JSON_TREE_MAX_BYTES` (32 MiB), `JSON_TREE_MAX_NODES` (2,000,000), `JSON_TREE_MAX_DEPTH` (1,000).
- `jsonStringValue(literal)`, `escapePointerToken`, `pointerFromTokens`, `parsePointerTokens`, `utf8Length`.

From `packages/relic-viewer/src/json-tree-rows.ts` (no DOM): `visibleText` (escapes bidi and control characters), `valuePreview` (512-character cut), `keyLabel`, `valueLabel`, `summaryText`, `noticeFor`, `breadcrumbFor`, `findQuote`, `nodeForAnchor`, `JsonTreeState`, and the `TREE_*` limits.

A notebook cell is a `path` such as `/cells/7`, so `resolve` gives the cell node and `pointer` gives the anchor back.

## Measured

- 100,000-deep nesting, closed and unclosed: refused in 0.31 ms (bun, `json-tree.test.ts`). The depth check fires at the 1,001st opener, so the parser never builds the stack.
- 2,000,000 values: parsed in 715 to 973 ms across runs (bun). The node arrays cost about 40 bytes per node, so about 80 MB at the cap.
- Differential: 400 generated documents (duplicates, escapes, numbers, whitespace) match `JSON.parse` exactly; 4,000 mutated documents agree with `JSON.parse` on validity in both directions.
- Headless (isolated shell, owned path): all ten DOM cases pass, including the 50,000-value window and the select, mark, collapse, expand, reveal sequence.

## Decisions made in this slice

- **Duplicates.** The earlier key is a node flagged as ignored. It has no pointer, so it cannot take a `path` comment, and its Comment control is disabled with the reason. A `quote` that lands on it still marks it, because the text is there.
- **Numbers** are kept as source text. The tree never converts them.
- **Pointers over 512 bytes** have no anchor. The breadcrumb says "No path addresses this value".
- **Quotes on the tree** (legacy `quote`, `text`, `source`) are found in the source and matched by prefix and suffix. An occurrence whose context does not match is not guessed; the anchor resolves to nothing.
- **Default expansion** matches mock J1: the root, its children, and an object inside an object open; an object inside an array starts closed. Expand all is refused above 10,000 values.
- **A file the tree cannot show** keeps its source, with the reason above it. `mountView` returns a part that draws the notice and is marked `structured`, with its `paintMark` returning false. This is the one place the view does not return `undefined`. If A0 wants the bridge to carry notices, the change is one field on the part, and this view is the only user.

## Open items for the parent (outside A2's files)

1. **Legacy quote marks do not reach the tree yet.** `annotate-quote.ts` `supports()` returns true whenever no iframe is present, so a `quote` on a drawn tree goes to the generic DOM adapter and wraps text inside the tree rows. Plan section 5 says the tree finds old quotes in the source. Fix in A0: `quoteAdapter.supports` returns false when `drawnStructuredView(host, 'tree')` is set, so `paintMark` handles it. The view already implements that path (`paintMark` accepts `quote`, `text` and `source`).
2. **Comment wiring.** The Comment control dispatches a bubbling `relic:structured-comment` event with `detail: { anchor }`. The A0 selection hook in `main.ts` must listen for it and open the composer for that anchor. Nothing listens yet, so the button does nothing until that lands.
3. **Source mode toggle.** The mock places "View source" in the tree toolbar. Plan section 7 puts the toggle in `main.ts`'s `.toggle-row`, which owns the route. The view does not draw a second toggle, because the bridge's `showSource` is one-way and the route owns the switch back. The toolbar in the view has no source button on purpose.
4. **Stylesheet delivery.** `build.ts` copies `json-tree-view.css` next to `model-view.css`, and the view injects `<link href="/assets/json-tree-view.css">`. The service worker's precache list is not updated here; check it when A5 adds the asset to `deploy-smoke.sh`.
5. **Test timer.** The browser test keeps one 60-second watchdog timer, with the reason in a comment on that line: it drives a real browser, and a hang fails with evidence instead of waiting out bun's limit. This is the same pattern as `suggest-editor.test.ts`.

## Files

- `packages/relic-format/src/json-tree.ts`, `test/json-tree.test.ts`; `index.ts` re-export; `package.json` subpath `./json-tree`.
- `packages/relic-viewer/src/json-tree-rows.ts`, `test/json-tree-rows.test.ts`.
- `packages/relic-viewer/src/json-tree-view.ts`, `json-tree-view.css`, `test/json-tree-dom.test.ts`.
- `packages/relic-viewer/build.ts`: one copy line.
- The stub `json-tree-view.ts` is replaced.
