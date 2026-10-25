# B-R: rendered review of load progress at 9bfed0d8

**Verdict: not clear. Six defects.** Five are in the viewer and one is in P's proof, which cannot see the other five. Each viewer defect has a fix of a line or two, proven below by rendering it. The render pill, the plate, the comparison line, the failure toast, the could-not-open card and overflow at every width all match the mock.

## What was reviewed

The proof directory is named `9bfed0d8`, but P ran a build of 9bfed0d8 plus uncommitted work:

- `reviewed-working-tree.diff` (sha256 `c3a9ee77…`): the V2/V3 fixes in `app.ts`, `main.ts`, `viewer.ts` and `load-plate.test.ts`.
- `packages/relic-mcp/test/load-progress-path.ts` (sha256 `0699ad0c…`), which is still in no commit even though verify.yml runs it.

To render the review frames, I built that exact state in my own worktree. The viewer build is byte-identical to the one P used: `viewer.js` `8ddbdb5d…` and `styles.css` `43562b52…`.

## Method

1. I compared P's 46 shots with the mock's shots at the same size and theme, by eye and by pixel diff.
2. P's run shoots cards only at 1440 light and never captures a pill. To cover the rest, I rendered 250 more frames with P's server, chunked storage, fixtures and owned headless shell, at 1440x900, 390x844 and 320x568 in light and dark (`capture-r2.ts.txt`). The harness-only additions were:
   - a chunk delay and first-byte delay per object;
   - an optional extra mint delay;
   - `insecure.test` mapped to loopback, for the insecure card;
   - one relic removed with the operator DELETE, for the report-only card.
3. Every frame carries a DOM measurement in `measurements.json`: pill placement and overlaps, the custody line, card children and action widths, computed contrast, and overflow.
4. I applied the proposed fixes in my worktree, rebuilt, and rendered the affected states again (`frames-with-fixes/`, side by side in `compare/X-fixed-*`).

## Defects

1. **The version pill renders as clipped body text (V3).**
   - Shots: `C-version-opening-*` and `C-version-fetching-*`, all six sizes and schemes. Panel: `compare/R1-*`.
   - Cause: in `showVersion` (main.ts:7911-7920) the `span.render-status-label` is created but never appended. The edit that moved the pill after the band dropped `versionPill.appendChild(label)`. `label.textContent` and `replaceChildren` then fall back to writing into the strip itself.
   - Measured: the text is the 16px system face in ink on a transparent background, with no patina tag. Its ink box runs from y 50.3 to 68.3 against a band that ends at 62.5, so the lower third is cut off.
   - "Version 1: Fetching" loses its space, because each span becomes a flex item, so it reads "Version 1:Fetching".
   - At 320 the line runs to x 388.8 and "KB" is clipped.
   - It reads as a caption under Download and Report, the treatment the mock rejected.
   - Fix: append the label before inserting the pill. Proven: a 10.56px mono patina tag inside the band's bottom 15.2px, the space kept, and "Version 1: " hidden at 320 (`compare/X-fixed-version-pill-320-light-band.png`).

2. **Dead-card and noscript actions lose their words at 390 and 320 (merge of #119, styles.css:720).**
   - Shots: `F-damaged-320-light`, `F-cut-short-*-390-*`, `F-service-unreachable-390-dark`, `F-noscript-390-dark`, `F-noscript-320-light`. Panels: `compare/R2-*`.
   - Measured: Try again and Report this relic are 48px icon-only buttons, and the noscript link spans have 1x1px boxes. The mock keeps the words at every width ("Card actions are bordered buttons that keep their words at every width").
   - Cause: main's narrow collapse rule now hides `.action span` with the visually-hidden technique, at specificity (0,3,3). It exempts only the share, decision and copy panels and `.band-more-list`. B's `.card-actions .action span { display: inline }` was written against main's old `display: none` rule, so it no longer restores anything.
   - Fix: add `.card-actions` to that rule's `:is()` exemption list. Proven: the words are back and stack as in the mock at 390 and 320. The band is unchanged across 42 ready pages (same action widths, same band height, no overflow).

3. **The damaged card and the cut-short-after-record-0 card drop the filename from the band (V2).**
   - Shots: P's `04-cut-short-card`, `05-damaged-flipped-byte-card` and `06-damaged-truncated-card`, plus `F-damaged-*` and `F-cut-short-after-record0-*`. Panel: `compare/R3-*`.
   - Cause: fix 4 clears the custody line on every dead card (main.ts:8440-8445).
   - The mock's decision is to keep the filename when record 0 gave one, and cut short after record 0 is exactly that case. In all 12 of those runs the band read `report.md` or `tone.wav` while loading, and then went blank when the card appeared.
   - Fix: clear the custody line only while it still reads `LOAD_OPENING`. Proven: the filename stays on damaged and post-record-0 cut-short cards, and is cleared on could-not-open, cut short before record 0, service unreachable, insecure and removed.

4. **The insecure card still merges its advice into the detail (V2, viewer.ts:287).**
   - Shots: `F-insecure-*`. Panel: `compare/R4-*`.
   - Cause: `renderDead` now splits on a blank line, but viewer.ts still joins `INSECURE_DETAIL` and `INSECURE_ADVICE` with a single space, so fix 6 has no effect.
   - Fix: join the two with `\n\n`. Proven: two paragraphs, as in the mock.
   - Test gap: test 8 in `load-plate.test.ts` builds its own DeadView without the advice, so it cannot catch this. It should render the DeadView that `load()` returns.

5. **Report-only cards lost their only action (V2, a regression in the uncommitted diff).**
   - Shots: `F-removed-*`. Panel: `compare/R5-*`.
   - Cause: the working-tree diff removed `hasActions = true` from the report branch of `renderDead`. Cards whose action is `report` alone (`relic_removed`, `removed_after_mint`) build the link and never attach it.
   - "This relic was removed … you can contact us." now offers nothing. Main gave it a Contact us button.
   - The band's Report link is still there, so the reader is not stuck, but the card contradicts itself.
   - Fix: restore the line. Proven: `X-fixed-removed-390-dark.png`.

6. **P's proof cannot see defects 1 to 5 (P).**
   - P checks the version pill by `textContent`, shoots cards only at 1440 light, has no insecure or removed run, and never asserts the custody line on a dead card.
   - The viewer suite passes 959/959 both on the reviewed build and with the fixes, so no existing test covers any of these defects either.
   - Add:
     - version-pill frames, asserting the text sits in `.render-status-label` inside the band's box;
     - dead-card frames at 390 and 320, asserting every `.card-actions` label span is wider than 1px;
     - on the damaged run, the custody line equals the filename;
     - an insecure run (the `insecure.test` host-resolver mapping in `capture-r2.ts.txt` works);
     - a removed relic, asserting `[data-dead-action=report]`.

`proposed-fixes.diff` holds the five viewer fixes against the reviewed state (5 lines in 3 files). Before the next P run, commit them together with the uncommitted V2/V3 work and `load-progress-path.ts`, and name the proof directory after that commit.

## Deviation to keep, with a mock update

- The noscript band hides "Opening…" (`[data-load-custody]` was added to the noscript style). The mock's state 2 still shows it, but by the mock's own custody decision a band reading "Opening…" over a card saying the page cannot open is false. Update the mock to match the build.

## Minor, no action needed for this review

- The plate meter no longer carries `aria-valuemin`. C4 lists `aria-valuemin=0`, which is also the ARIA default.
- The custody line sets no `title` when it shows the filename. The mock and the ready band both set one, so a truncated name cannot be read in full while loading.
- Pre-record-0 dead cards rise 2.1px as the custody line empties (plate card top 134.1, dead card top 132). The mock does the same, against its own decision that a failed open moves nothing. Reserving the custody line's height would fix both.
- The decrypting phase was never sampled. It lasts one record's decrypt at the end of the stream, which was too short to catch even at 1ms polling with a 70ms chunk delay. That is not a defect.

## Passes, measured

- **Render pill.** 36 frames across pdf, otio, html, svg, jsx and mp4 at every size and scheme:
  - the previous sibling is `header.bar`;
  - the strip sits inside the band's bottom 15.2px (y 38.9 to 54.1, band ends at 54.1), with the tag at the far end;
  - it overlaps no iframe, canvas, img, video or OTIO view;
  - `data-render-state` is on `main.stage` and `aria-busy` is on `.stage-wrap`, both clearing on ready;
  - the stage position and band height are identical with and without the pill in 42 pairs, so there is no layout shift;
  - under reduced motion the tag stays still.
- **Plate.**
  - "TRANSFER 2.1 MB" shows over an empty meter once the mint returns, at all six sizes and schemes (fix 7).
  - While opening, the meter has no `aria-valuenow` or `aria-valuemax` and is labelled by `#load-phase` (fix 9).
  - `aria-valuemax` is set when the mint returns.
  - "Opening…" holds in the band until record 0, then the filename and "CONTENTS" arrive together.
  - The reduced-motion static plate is hatched and still.
- **Could-not-open card with key entry.** Identical to the mock at all six except the accession. The key-entry progress line sits under the form (fix 10).
- **Comparison line and version failure toast.** Both match the mock's format and position at all six.
- **P's 46 shots against the mock at 1440 light.** The static plate, the first-progress shot and the could-not-open card differ only in the accession and the live numbers. The JSX relic renders under the `blob:` sandbox CSP, and PDF lines sit on separate baselines.
- **Copy.** Word for word against C2, the existing dead-card copy and C's key-entry strings.
- **Contrast** (computed and composited). Text is at least 6.06:1 in light and 6.34:1 in dark; the pill tag is 6.06 / 6.89; the meter fill against its track is 5.59 / 7.40.
- **Overflow.** `scrollWidth` never exceeds `innerWidth` in any frame of either build.
