# A5a notes: MCP resolution of structured anchors

Branch `sf-a5a-mcp`. Input: plan section 5 (MCP side) and the A1 to A4 notes.
This slice touches `packages/relic-mcp` only. It does not touch `relic-viewer`.

## What shipped

- **`cell` anchors** on CSV and TSV resolve to `{text, header, line}`, plus `range`
  when the anchor is a range. Coordinates are A1 coordinates of the published file,
  and the parser is `@relic/format/csv` with the same delimiter rule the viewer uses.
- **`path` anchors** on JSON resolve to `{type, excerpt, line}`. On `.ipynb` they
  resolve through `@relic/format/notebook` to `/cells/N` (`type: cell`, `cell_type`)
  and `/cells/N/outputs/M` (`type: output`, `cell_type`, `output_type`).
- **`time` anchors** on SRT and VTT resolve to up to 20 matching cues, with the
  total count and a flag when the list was cut. The subtitle check runs before the
  audio and non-video refusals in `resolve-anchor.ts`.
- **Version scoping.** A comment resolves against the version it was written on
  (`comment.version`). A version the service cannot give back, or a comment with no
  version, is "not found in this version". It never falls back to the current file.
- **Transcript.** Resolved text is capped (cell 512 bytes, header 128, path excerpt
  512, cue text 512) and written as a JSON string literal. Bidi, C1 and line
  separators are escaped too (`untrusted-text.ts`).

## Files

- `src/resolve-structured.ts`: the readers (`StructuredReader`, `structuredReaderFor`),
  the caps, `subtitleClock`, `capBytes`. Pure. Nothing throws.
- `src/resolve-structured-comment.ts`: ties a `cell` or `path` comment to its version.
- `src/resolution-text.ts`: transcript lines for cell, path and cue resolutions.
- `src/untrusted-text.ts`: `jsonLine`, the JSON encoder for untrusted text.
- `src/resolve-anchor.ts`: three union members, the `cell`/`path` dispatch, and the
  subtitle check at the top of `case 'time'`. The old "not built yet" placeholder is gone.
- `src/comments.ts`: `cellName` is exported (used for the range text).
- `src/server.ts`: `resolutionLine` and `commentTranscript` are exported. Cases for
  `cell`, `path` and cue lists were added. The inner `jsonLine` was removed in favour
  of the shared one.
- Tests: `test/resolve-structured.test.ts` (53 cases, reader level, version wrapper,
  transcript lines) and `test/resolve-structured-relic.test.ts` (5 cases, real publish,
  real comment, real read through `readComments` and the public `handleMessage` tool).

## Decisions

- **Ragged rows and out-of-range coordinates** return `status: 'unresolvable'` with an
  explanation starting "The cell is not found in this version". They never throw.
- **Duplicate JSON keys** resolve to the last occurrence, via `JsonTree.resolve`.
- **Ranges** report the top-left cell's text and the inclusive extent. The header is
  the first record's text in the top-left column.
- **Cue matching.** A cue covers `[start, end)`. A point matches the cue whose span
  holds it. A span matches every cue it overlaps. Cues are returned in file order.
- **Refused files** (unclosed quote, NUL, over limit, bad JSON, not nbformat 4, no
  readable cue) are `unresolvable`, and the explanation names the reason.

## Verification run

- `bun test packages/relic-mcp/test/resolve-structured.test.ts
  packages/relic-mcp/test/resolve-structured-relic.test.ts`: 58 pass, 0 fail.
- `bun test` on `comments`, `comment-version-scope`, `republish-comments` and
  `otio-feedback`: 141 pass, 0 fail. These suites exercise `resolveAnchors` and the
  transcript on existing kinds, so they guard against regressions.
- `bunx tsc --noEmit` clean in `relic-mcp`.
- `bunx biome check` clean on every touched file.
- `bun run --filter '*' typecheck` from the repo root: `@relic/format`, `@relic/server`,
  `@relic/viewer` and `relic-mcp` all exit 0.
- **Mutation check.** Disabling the ragged-row guard (`resolve-structured.ts`,
  `column >= width`) fails exactly the ragged-row test. The guard was restored.

## Deviations from the brief (say so in any report)

1. **`describeAnchor` wording for cues is unchanged.** A `time` anchor still reads
   "at m:ss" (the media wording). The cue identity (cue number, line, span, speaker)
   comes from the resolution lines, which name the cue. Changing the chip or
   `describeAnchor` text for cue lists is viewer work or a follow-up.
2. **Version scoping is proven at two levels, not three.** The loader is tested with a
   fake (`resolveStructuredComment`), and a comment's version is passed through to it.
   The end-to-end test publishes a single version. A republish test that resolves
   version 1 after version 2 lands is not written here.
3. **`publish.ts` is not changed.** The brief allowed it if needed. Nothing in publish
   needed it.

## Not proven (say so in any report)

- **Republish-to-old-version through the real service.** Covered by the unit loader
  test, not by a published-then-republished relic.
- **Notebook `path` through `handleMessage`.** The notebook path is proven through
  `readComments` and the reader, not through the public tool transcript.
- **Hostile text on a subtitle cue or notebook cell through the transcript.** The
  transcript test covers cells and path excerpts with bidi and ANSI, and the cue
  transcript is checked at the line level, not through a published cue relic.
- **Live service and real encryption at scale.** The tests use the in-memory app and
  small fixtures. The 1 MB cell case is a reader-level and transcript-line check.
- **Browser behaviour.** Nothing in this slice runs in a browser. The viewer is
  untouched.
