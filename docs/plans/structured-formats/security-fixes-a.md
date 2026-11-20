# Structured formats: security review fixes (set A)

Scope: the findings in the read-only review of PR #176 (`feat/structured-formats`, head d9a97984) that fall to the format and MCP packages, plus the one-line import swaps in the viewer that the shared helpers need. Fix commit: `3f780d0029` on branch `sf-fix-a`.

Every finding was reproduced first, with a fixture or a timing recorded on the code at d9a97984 (the old code was exported from git into a scratch directory so both versions run on the same input). Each guard was then checked by reverting the fix on purpose and watching the guard fail, and restoring the file byte for byte.

## Findings

### SF-QUOTE-QUADRATIC: fixed

- Reproduced: yes. Fixture `[` + `'0,'.repeat(1e6)` + `0]` with exact `'0,'.repeat(256)` and prefix `x`: the viewer copy took 201 ms and the notebook copy 459 ms.
- Fixed: one search in `packages/relic-format/src/structured-text.ts` (`findQuote`, Knuth-Morris-Pratt over prefix + exact + suffix). It returns the same offset as the restart-per-occurrence loop. After the fix: viewer 4 ms, notebook 2 ms, same result.
- Guards: `structured-text.test.ts`. A differential test checks 4,000 random inputs against the old loop. A periodic source of 4 million pairs must search in under 300 ms. Reverted (R1): 754 ms, guard fails.
- The notebook and viewer copies are now one function. The viewer's `json-tree-rows.ts` imports it and re-exports it, so `json-tree-rows.test.ts` still imports it from there.

### SF-JSON-DUPFLAG: fixed

- Reproduced: yes. A unique key was reported as a duplicate (its badge said "DUPLICATE KEY · THIS ONE COUNTS").
- Fixed in `json-tree.ts` `#registerKey`: the flag is set only on a node that has an earlier twin, and on that twin.
- Guards: `json-tree-flags.test.ts`. Reverted (R2): both unique-key assertions fail.
- For the viewer worker: the DOM test (`json-tree-dom.test.ts`) should also assert that a unique key shows no badge. That file is not mine.

### SF-POINTER-UNWRITABLE: fixed (format part)

- Reproduced: yes. `{"a\rb":1}` gave a pointer that the anchor writer refuses.
- Fixed: `JsonTree.pointer()` returns `undefined` for a NUL or CR in any key, using the writer's rule (`pointerHasForbiddenCharacter`, exported from `comments.ts` and shared with `parsePointerTokens`). It also stops walking once the escaped UTF-8 length passes 512 bytes, so a deep path of long keys costs no more than the cap. The cap counts escaped bytes (a slash costs two).
- Guards: `json-tree-flags.test.ts`. Reverted (R3): the CR test fails.
- Remaining, viewer side: `postComment` should turn a `MalformedCommentError` from `cipher.seal` into a refusal, and the Comment control should not open on a node with no pointer. Not done here (viewer file).

### SF-ALLOC-BEFORE-CAP: fixed

- Reproduced, on the old code:
  - 32 MB markdown cell of raw U+0080: 1.4 to 8.6 s, RSS about 2.1 GB (the time varied between runs; the RSS did not).
  - 32 MB markdown cell of raw DEL: 3.3 s, RSS 4.7 GB.
  - 16 MiB of line feeds as SRT: 0.4 to 1.8 s, RSS 170 to 220 MB.
  - Error name of 100,000 characters: shown in full. nbformat number of 100,000 digits: shown in full.
- Fixed:
  - `notebook.ts` `display()` cuts the raw text before escaping and again after. DEL: 0.16 s, RSS 300 MB.
  - Error name and value, the withheld MIME label and the nbformat "found" text go through `shortLabel`, capped at 256 characters before and after escaping.
  - `subtitles.ts` reads lines with a cursor and no longer splits the file. The 16 MiB newline file takes 79 to 88 ms and 61 MB. A differential run over 6,000 random mixed-break inputs against the old parser found no mismatch.
  - `resolve-structured.ts` refuses content over 32 MiB (the JSON tree cap, the largest parser cap) before decoding. Each parser answers with its own too-large result, so the messages stay the same.
- Guards: `notebook-bounds.test.ts` (32 MB DEL cell under 1 s, reverted R4: 3,093 ms), `subtitles-lines.test.ts` (parsing costs under half a whole-file split of the same text, measured in the same process; HEAD parser 340 ms against a 160 ms bound), and the label tests.
- Not measured: the decode time of the refused 32 MiB content. The refusal is by size, before the decoder runs, and no timing was taken for it.

### SF-INVISIBLE-SETS: fixed

- Reproduced: yes. Five copies of the predicate covered different sets. The sheet validator missed C1, U+061C, LRM and RLM. `jsonLine` missed DEL and U+061C.
- Fixed: `structured-text.ts` holds the one set (C0 except tab and LF, DEL, C1, U+061C, U+200E, U+200F, U+202A to U+202E, U+2028, U+2029, U+2066 to U+2069). Used by `notebook.ts`, `untrusted-text.ts` (`jsonLine`), the sheet validator in `comments.ts`, and the viewers' cue, table and tree views.
- Reader tightened: the sheet validator is shared by reader and writer, so a sheet name with a newly listed character is now refused when a comment is read as well as written. This is safe because no published comment carries a sheet name. The only producer is the xlsx format (PR B), and this PR has none. Ordinary names still parse (`sheet-names.test.ts` checks this). The reader change is noted here so it is not missed on a later review.
- Viewer effects, for the viewer worker to confirm: the table view now escapes CR (`\u{D}`), which it used to show raw (tab and LF stay raw); the cue view now escapes C1, U+061C, U+2028 and U+2029.
- Guards: `structured-text.test.ts` (the set, both ways) and `sheet-names.test.ts` (old refusals still hold, newly refused set refused, the characters outside it still accepted). Reverted (R5): the newly refused set is accepted again and the test fails.

### SF-MCP-ANCHOR-RAW: fixed

- Reproduced: yes by reading, and by revert. A path pointer with a newline printed `[Resolution: ...]` as its own line in the transcript.
- Fixed: `describeAnchor` writes the pointer, the sheet, the quote exact, prefix, suffix and text, and the declared kind of an unsupported anchor through `jsonLine`. Plain text prints exactly as before.
- Guards: `anchor-transcript.test.ts`, through the real `commentTranscript`. Reverted (R6): the forged line is printed and the test fails.
- Remaining: the OTIO snapshot fields (timeline and track names) are still printed raw in `describeAnchor`. They were not in the finding's list. They are a candidate for the next pass.

### SF-MCP-TIME-VERSION: fixed

- Reproduced: by reading (`comment.version ?? (anchor.kind === 'source' ? 1 : undefined)` resolves a subtitle time comment against the current file). Revert R7 proves the guard.
- Fixed: `resolveSubtitleTime` in `resolve-structured-comment.ts` refuses a comment with no recorded version, with the same rule and wording as cell and path. `resolve-anchor.ts` calls it.
- Guards: `anchor-transcript.test.ts`.

### SF-NB-IMAGE-DIMENSIONS: fixed

- Reproduced: yes. A PNG whose header declares 60000 by 60000 pixels, in 33 bytes, was accepted as an image.
- Fixed: `notebook.ts` reads the size from the header (PNG IHDR, GIF logical screen, JPEG SOF, WebP VP8, VP8L and VP8X). A single image over 50 million pixels, or images over 200 million in total, is refused as `size`. A malformed header is refused as `signature`.
- Guards: `notebook-bounds.test.ts` (exact edges at 7071 by 7071 accepted and 7072 by 7072 refused, the 200 million total, every format). Reverted (R8): six tests fail.
- Limits: GIF is sized from the logical screen, as the finding says; frame descriptors are not walked. The browser's own decoder limits were not checked. The relic-server image route has the same exposure and is out of this package.

## Other changes

- `relic-format/package.json`: `./structured-text` subpath export.
- `relic-viewer/src/cue-view.ts`, `data-table.ts`, `json-tree-rows.ts`: the local predicates are replaced by the shared one (one-line swaps as asked). `json-tree-rows.ts` also re-exports `findQuote`.

## Tests and checks

- `bun run test` (the build, then all tests): 5,020 pass, 0 fail, across 247 files.
- Before the build, `bun test packages/relic-format packages/relic-mcp` showed 26 failures in `native readInto` and `OTIO bundling`. They come from the missing native secure-open prebuild (`darwin-arm64`), which `bun run build` generates. HEAD tracks no prebuild, so they fail on HEAD without the build too. They are not caused by this change, and they pass after the build.
- `bun run test` includes the viewer suite: `bun test packages/relic-viewer` (run alone) gives 2,175 pass, 0 fail, so the swapped predicates and re-export hold there.
- `bun scripts/deploy-smoke-path.ts`: `DEPLOY_SMOKE_PATH_OK`.
- Structured formats path, `RELIC_CHROME_PATH` set to the owned `chrome-headless-shell`, after `bun run --cwd packages/relic-mcp build:bundle`: `STRUCTURED_FORMATS_PATH_OK`.
- `bun run --filter '*' typecheck`: all four packages pass.
- `bunx biome check . --diagnostic-level=error`: passes.
- Subtitle differential (6,000 random inputs against the HEAD parser): no mismatch.
