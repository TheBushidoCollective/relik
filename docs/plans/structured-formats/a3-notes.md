# A3 notes: cues (SRT and WebVTT)

Branch `sf-a3-cues`, commits 837c895d (parser), 05e3d934 (view, labels, build),
a63f22b2 (browser test). Input: plan section 4 (limits), section 5 (anchors),
section 7 (cue view), and the mock's states S1 to S4.

## What shipped

- `packages/relic-format/src/subtitles.ts`: the SRT and WebVTT parser. Exported as
  the `@relic/format/subtitles` subpath.
- `packages/relic-viewer/src/cue-view.ts` and `cue-view.css`: the cue list that
  replaces the A0 stub. `build.ts` copies the stylesheet next to `model-view.css`.
- `packages/relic-viewer/src/annotate-cue.ts`: the cue chip wording and the
  `subtitleClock` helper (`hh:mm:ss.mmm`).
- Tests: `relic-format/test/subtitles.test.ts` (31 tests, parser, fixtures, hostile
  input, limits) and `relic-viewer/test/cue-view.test.ts` (12 cases in a headless
  browser through the real bridge).

## Behaviour decisions (settled here, not in the plan)

- **Markup is a fixed set.** `b`, `i`, `u` (exact, no attributes), `v` (speaker
  label), and VTT `c`, `lang`, `ruby`, `rt` and timestamp tags, which are markup and
  drop out of the text. Every other `<...>` is text, shown as written. So
  `<img src=x onerror=…>` reads as those characters, and no element is ever made.
- **Entities decode once.** `&amp;lt;` is the text `&lt;`.
- **Bidi and control characters** show as `[U+202E]` style escapes.
- **Timestamps.** SubRip requires hours. WebVTT takes `mm:ss.mmm` as well as
  `hh:mm:ss.mmm`. Comma or dot is accepted as the decimal mark in both.
- **Refused whole, not partial:** over 16 MiB (UTF-8), over 20,000 cues, over 40,000
  cues plus blocks, or no readable cue at all. Refusal shows the source with a
  notice. Malformed blocks are skipped and counted, and the rest still shows.
- **Text cap.** A cue or block keeps 32,768 characters and is marked `truncated`.
  A surrogate pair at the cut is not split.
- **Anchors.** A cue click or Enter selects the cue text as a real DOM range. The
  route's existing selection offer then calls `selectionAnchor()`:
  - one whole cue gives `{kind:'time', t:start, t_end:end}`;
  - a range over several cues gives the first start to the last end;
  - part of one cue, selected by hand, returns `undefined`, so the quote adapter
    takes it.
  A drag that leaves a non-collapsed selection is not overwritten by the click.
- **Chip wording** for a `time` anchor over a cue list:
  "Commenting on the subtitle at 00:00:09.300" or
  "Commenting on subtitles from 00:00:05.100 to 00:00:17.400".

## A0 note, fixed

`anchorLabel` took no surface, so a `time` anchor always got the media adapter's
wording. It now takes an optional surface and uses the adapter that claims it.
`markTargetLabel` passes the surface the composer already holds (`anchorSurfaceFor(host)`).
Both edits are small: `anchoring.ts` (one function) and `main.ts` (two lines,
`markTargetLabel` and its call in `paintChip`). The A0 bridge test that pinned the
old cue wording was updated to the new wording (three assertions).

## Refusal shape: a point for review

A refused file still returns a part (inert, with no marks), so the bridge marks the
handle `structured === true`. Main's `leaveStructuredView`, `familyOf` and
`drawnStructuredView` therefore treat a refused cue file as drawn. Effects: a
`time` anchor on it gets the "points at part of the document that this page cannot
show" note, which is the right answer, and no offer is made because
`selectionAnchor()` returns `undefined`. An alternative is to return `undefined` and
lose the notice. The notice matters more, so this was kept. Review should confirm.

## Measured (bun, this machine, parser only)

| Case | Time | Result |
|---|---|---|
| One 10 MB cue | 51.6 ms | ok, cut to 32,768 chars, `truncated` |
| 20,000 cues | 70.3 ms | ok |
| 20,001 cues | 125.5 ms | refused `too-many` |
| 2,000,000 `<` characters | 13.2 ms | ok, text |
| 16 MiB + 1 byte | 46.3 ms | refused `too-large`, before parsing |
| 40,001 NOTE blocks | 20.5 ms | refused `too-many` |

## Verification run

- `bun test packages/relic-viewer/test/cue-view.test.ts packages/relic-format/test/subtitles.test.ts`:
  32 pass, 0 fail, with `RELIC_CHROME_PATH` set to the owned headless shell
  (`~/.omp/owned-shells/chromium_headless_shell-1228/...`). The browser case ran.
- `bun test` on `structured-view-bridge`, `anchoring`, `annotate-time` after the
  label change: 60 pass.
- `bunx tsc --noEmit` clean in `relic-format` and `relic-viewer`.
- `bunx biome check` clean on every touched file.

## Not proven (say so in any report)

- **Mobile layout** (`@media (max-width: 40rem)`) is CSS only. It has not been
  measured in a browser at 390 px.
- **The full comment flow** through `main.ts` (selection offer, composer, post,
  mark, thread pairing) is not run end to end. The browser test drives the view's
  part and the bridge, and that is the anchor and mark A5 must exercise on a relic.
- **Other browsers.** Chrome headless only.
- **Suggesting** (cue text edits, plan C2) is not built here. The cue view has no
  edit path.
- **Relic publishing and resolution.** `relic-mcp` resolution of `time` anchors on
  SRT or VTT (plan section 5, up to 20 matching cues) belongs to A5 and was not
  touched.

## For A5: stage `cues`

- Publish a fixture relic with an `.srt` and a `.vtt` (use S1 and S3 from the
  mock). Open it in the headless proof, check the cue rows, the S3 notice, and the
  NOTE and STYLE rows.
- Comment on a cue through the real offer (click the cue, then comment). Check the
  chip reads "Commenting on the subtitle at ...", the mark is painted on that cue,
  and the thread card reveals it.
- Check a `time` anchor on a non-cue page still reads the media wording (the
  `anchorLabel` fallback is unchanged without a surface).
- Check that a quote spanning a bidi escape does not resolve: the displayed
  `[U+202E]` is not in the source. Decide whether the resolver should match
  escaped text, or whether such quotes are refused (plan section 9 flagged the
  same class of issue for cells).
- `resolve-anchor.ts` must accept `time` on SRT and VTT with up to 20 matching cues
  (plan section 5). Read `time` against the cue span, not the media timeline.

## Shared files touched (for the parent to resolve)

- `packages/relic-format/package.json`: one `./subtitles` export.
- `packages/relic-viewer/build.ts`: one `cue-view.css` copy line.
- `packages/relic-viewer/src/anchoring.ts`: `anchorLabel` takes an optional surface.
- `packages/relic-viewer/src/main.ts`: `markTargetLabel` takes an optional surface,
  and `paintChip` passes it.
- `packages/relic-viewer/test/structured-view-bridge.test.ts`: three cue-label
  assertions updated to the new wording.

## Possible shared helper

`cue-view.ts` has `visibleText` (bidi and control characters as `[U+XXXX]`). The
table (A1), tree (A2) and notebook (A4) views will want the same escape. Move it to
one module, `structured-text.ts`, once the other views land, and delete the copies.
