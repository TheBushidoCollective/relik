# B-R: rendered review of `feat/relik-load-progress` at 56c05169

**Verdict: not clear.** There are twelve defects: three for V3, five for V2 (two of them with a change in `viewer.ts`), one for S, one shared by S and V2, one for the integrator and one for P. The worst two are the render pill and the noscript card. The pill sits at the bottom of the window and covers the corner of the sandboxed html and svg frames at every width. The noscript card's links vanish at 390 and 320, emptied by the band's 34rem rule. The plate itself, the cut-short card, the comparison line, the version toast and every width's overflow match the mock.

## What was compared

- P's 45 shots in `proof/56c05169/` against the mock shots of the same state, size and scheme, and against `mockup.html`'s source wherever they disagree. P shot everything at 1440 light, except twelve ready shots at 390 dark and 320 light.
- The real viewer, for the states P never shot. Same build of 56c05169 and the same harness setup:
  - the loopback app, with MemoryStorage serving 16 KB chunks every 15 ms;
  - the twelve fixtures and the 6 MB bin, published through stdio relic-mcp;
  - an owned headless shell with a throwaway profile.

  That gave 134 frames at 1440, 390 and 320 in both schemes, plus a verification pass. CPU throttling at 6x held the render pill on screen.
- The evidence is here: 25 frames, `measurements.json` and `supplement-runs.ts.txt`. The JSON is keyed by capture name, and each frame's name is that key without its letter prefix.

## Matches the mock (measured)

- **Plate.** Checked at 1440, 390 and 320 in both schemes: `plate-contents-*` here, plus P's `01-*-first-progress` and `08-blocked-viewer-static-plate`.
  - The card sits where the mock's does (top 134 at 1440).
  - The phase name, meter, transfer and contents rows and explanation all match.
  - The custody line swaps from `Opening…` to the filename at the envelope.
  - Only the byte counts differ.
  - Opening sweeps when motion is allowed, and is hatched and still under reduced motion (`static-plate-reduced-motion-1440-light.png`, against mock 03 reduced motion).
- **Cut short after record 0.** P's `04-cut-short-card.png` is identical to mock 12, filename kept.
- **Damaged.** P's `05` and `06` match mock 11, apart from defect 5.
- **Could not be opened and service unreachable.** The title, detail, Try again and accession match mocks 09 and 13, apart from defects 4 and 11.
- **Key entry while fetching.** The submit rests and `Fetching 0.3 of 6.4 MB` shows under the field, as in mock 10, apart from defect 10.
- **Comparison.** `Loading comparison: version 1 and version 2. Version 1: Fetching 32.8 of 280.6 KB` has the same words and position as mock 16's line.
- **Version switch.**
  - The current stage stays while the pill reads `Opening version 1`, then `Version 1: Fetching 16.4 of 280.6 KB`.
  - A truncated version ends in the toast `Version 1 did not finish downloading. Version 2 remains open.` That is the existing viewer copy, as C3 requires. Once its entrance settles, the toast box is the mock's (`version-failed-settled-1440-light.png`).
- **Copy constants.** `load-copy.ts` matches C2 verbatim, ellipsis U+2026.
- **Band.** There is one band in every state, and a dead card replaces the plate in place.
- **Overflow.** `documentElement.scrollWidth` equals `innerWidth` in every P shot (P asserts it) and in all 134 frames here, at 1440, 390 and 320. The only boxes past the right edge are inside the OTIO timeline's own scroller.
- **Contrast.** Taken from the tokens the frames render:

  | Pair | Light | Dark |
  |---|---|---|
  | Phase and headline on the card | 17.1:1 | 14.2:1 |
  | Card notes | 6.1:1 | 6.3:1 |
  | Pill tag and primary buttons | 6.1:1 | 6.9:1 |
  | Meter fill against its track | 5.6:1 | 7.4:1 |

  The track's own edge is 1.9:1 and 1.7:1, the same as the mock.

## Defects

1. **The render pill and the version pill sit at the bottom of the window, over sandboxed frames. V3.**
   - *Shots.* None in P's run, which never captures a pill. Here: `pill-pdf-1440-light.png`, `pill-html-1440-light.png`, `pill-html-390-dark.png`, `pill-svg-320-light.png`, `version-opening-1440-dark.png`, `version-fetching-1440-light.png`.
   - *Element.* `div.render-status` is appended with `document.body.appendChild`:
     - in `trackRenderState` (main.ts:7747-7748);
     - in `showVersion` (main.ts:7409-7410).

     That puts it after `div.relic-row`, and its negative top margin lays it over the bottom 15px of the window.
   - *Measured.* All 32 pill frames show the same thing: six classes plus the version switch, at 1440 light and dark, 390 dark and 320 light.
     - The strip sits at `innerHeight - 15`, with the tag at the right edge.
     - For html and svg, the tag covers the frame's bottom-right corner, 46x15px, at every width.
     - The sweep runs along the bottom of the window, not along the band's rule.
   - *Mock.* A body child straight after the band (mockup.html:6300). The tag sits in the band's bottom strip, under the action labels (mocks 07, 15a, 15b).
   - *Fix.* Insert the pill after the band in both places, for example `document.querySelector('body > header.bar')?.after(pill)`.

2. **The version pill keeps "Version 1: " at 320. V3.**
   - *Shots.* `version-fetching-320-light.png`.
   - *Element.* main.ts:7425 writes the whole line into `.render-status-label` as one text node. The 24rem rule for `.render-status-version` therefore has nothing to hide, and the tag is 246px wide at 320.
   - *Mock.* `Version 2: ` sits in `span.render-status-version` (mockup.html:6290-6295). At 320 the tag reads `Fetching 41.2 of 105.3 MB` and stays clear of the version chip.
   - *Fix.* Build the label as a `span.render-status-version` holding `Version N: `, followed by the progress text.

3. **The render state lands one element too high. V3.**
   - *Shots.* None; nothing visible changes. Measured while OTIO renders (`G-render-state-attrs-*` in `measurements.json`).
   - *Element.* `showSingle` (main.ts:7374 and 7381) passes the `.stage-wrap` as `stage` and the `.relic-row` as `stageWrap`. The result:
     - `main.stage` has no `data-render-state`;
     - `.stage-wrap` carries `data-render-state="rendering"` and has no `aria-busy`;
     - `.relic-row` carries `aria-busy="true"`, which marks the comment thread busy too.
   - *Spec.* C4 puts `data-render-state` on `main.stage` and `aria-busy` on `.stage-wrap`.
   - *Fix.* Call `trackRenderState(wrap.firstElementChild, wrap, route)`, and rename the variable.

4. **The band reads "Opening…" over cards that never reached record 0. V2.**
   - *Shots.* P's `03-wrong-key-card.png`. Here: `could-not-open-390-dark.png`, `key-entry-fetching-1440-light.png`, `service-unreachable-1440-light.png`, `insecure-1440-light.png` and `cut-short-before-record0-320-light.png`, and the same at every size and scheme.
   - *Element.* `[data-load-custody]`. `renderDead` (main.ts:7888-8069) never touches it.
   - *Mock.* Decision 5 (mockup.html:52-54, 6024-6042) keeps the filename only when record 0 gave one: damaged, or cut short after record 0. Otherwise the line is hidden and the identity shows the accession alone (mocks 09, 10, 13 and 14).
   - *Fix.* In `renderDead`, when the custody line still reads `LOAD_OPENING`, set it `hidden` and clear its text.

5. **The damaged card's Report this relic has no flag. V2.**
   - *Shots.* P's `05-damaged-flipped-byte-card.png` and `06-damaged-truncated-card.png`. Here: `damaged-320-light.png` and `damaged-1440-dark.png`.
   - *Element.* `a[data-dead-action=report]` is built with `link.textContent = 'Report this relic'` (main.ts:7954-7959).
   - *Mock.* A flag icon plus a span (mockup.html:6036-6037, mock 11).
   - *Fix.* Append `icon(ICONS.flag)` and a span holding `REPORT_LINK_LABEL`.

6. **The insecure card runs its advice into the detail. V2, with viewer.ts.**
   - *Shots.* `insecure-1440-light.png`. P has none.
   - *Element.* viewer.ts:287 builds the detail as one string, `${INSECURE_DETAIL} ${INSECURE_ADVICE}`, so the card shows a single paragraph.
   - *Mock.* Mock 14 and surface.md 268 and 270 have two paragraphs, with the advice as its own `p.card-note` (mockup.html:6029).
   - *Fix.* Carry `advice` on the dead view and render it as a second `p.card-note`.

7. **The TRANSFER line never appears. V2, with viewer.ts.**
   - *Shots.* P's `01-otio-first-progress.png` reads `Fetching 0.0 of 2.1 MB`. Here: `plate-fetching-1440-light.png`.
   - *Element.* `p[data-load-transfer]`.
     - `TRANSFER_LABEL` is imported (main.ts:30) and used nowhere.
     - viewer.ts emits `fetching` only per chunk (viewer.ts:460-478).

     So the row stays empty until the first chunk, and from then on it is already a fraction.
   - *Spec and mock.* C4 and mock 04a show `TRANSFER 105.3 MB` once the mint returns.
   - *Fix.*
     - In viewer.ts, emit `{ phase: 'fetching', received: 0, total }` when the mint returns.
     - In the plate, paint `TRANSFER ${formatBytes(total)}` while `received` is 0 (mockup.html:5961).

8. **The noscript card is styled as a failure, and its links vanish on phones. S.**
   - *Shots.* P's `07-noscript-card.png`. Here: `noscript-1440-light.png`, `noscript-390-dark.png` and `noscript-320-light.png`.
   - *Element.* app.ts:4785-4796.
     - The card sits in `main.stage.stage-dead`, which gives it the oxide top rule that means "the open stopped". The mock's `main.stage.stage-noscript` keeps the card's neutral rule (mock 02).
     - The links sit in `div.actions`, with no icons. At 1440 they take the band's divider styling: plain text with left rules, flush under the paragraph.
     - At 34rem and below, the band's `.action span { display: none }` empties them. Their measured boxes are 20x0 and 19x0 at 390, and 14x0 and 13x0 at 320. Neither link can be seen or tapped.
   - *Fix.* Change the shell markup to match mockup.html:5985-5991:
     - use `main.stage.stage-noscript`;
     - wrap the two `a.action` links in a `div.card-actions`;
     - give each link its icon (source, flag) and a span, keeping its `aria-label`.

9. **The opening meter announces a made-up maximum and has no accessible name. S and V2.**
   - *Shots.* None visual. P's `08-blocked-viewer-static-plate.png` serves `<div class="load-meter" role="progressbar" aria-valuemin="0" aria-valuemax="105298736">`.
   - *Element.* app.ts:4779 and main.ts:7581 both hard-code 105298736, the mock's 105.3 MB sample, on every relic. With viewer.js blocked it never changes. Neither copy names the progressbar.
   - *Fix.*
     - Leave `aria-valuemax` off until the mint returns.
     - Give `p.load-phase` an `id="load-phase"` and the meter `aria-labelledby="load-phase"`, as in mockup.html:5927-5928.

10. **The key-entry fetching line sits above the feedback slot instead of after it. V2, minor.**
    - *Shots.* `key-entry-fetching-1440-light.png`, against mock 10.
    - *Element.* main.ts:8010 puts `progressEl` inside the form, before the 19px `.key-entry-feedback` slot.
      - The line sits 9px under the field.
      - The empty slot sits between the line and the rule.
      - Both cards measure 76 to 77px from the field to the rule, so only the order differs.
    - *Mock.* The slot sits inside the form and the line comes after the form (mockup.html:6015-6021).
    - *Fix.* Append the progress line after the form.

11. **This branch predates #119. Integrator.**
    C merged to main at 01:37, three minutes after this run. Merging origin/main touches two sets of frames.
    - *Key-entry copy.* `03-wrong-key-card.png` shows the old strings. Mocks 09 and 10 and origin/main show C's:
      - "If you have the key phrase or the full link for this relic, enter it here."
      - "Key phrase or link"
      - "The 12 words, or the whole link"
    - *Band.* On this base the version chip overflows the identity.
      - In `09-version-switch-v1-ready.png`, `01-md-ready.png` and `04-cut-short-retried-ready.png`, "Version 1 of 2" runs from x135 to x260. That crosses the identity's edge at x222 and lands on the marker icon.
      - At 390 and 320 the relic ID shrinks to 0 to 3px (`02-md-320-light.png`).
      - origin/main adds `.identity { min-width: 12rem }` and the staged collapse, written for this overlap. [INFERENCE: that clears these frames; main was not rendered here.]
    - *After the merge.* Rerun P. Defect 1's fix has to be checked against main's band, because main changes which labels show at each width.

12. **P's run cannot show what R checks. P.**
    - *(a) JSX.* `01-jsx-ready.png` shows "This component could not be rendered."
      - The harness serves sandbox.html with `script-src 'self' 'unsafe-inline' 'unsafe-eval'` (load-progress-path.ts:108-109).
      - The JSX mount imports a `blob:` module, and app.ts:378 allows `blob:`.
      - With `blob:` added, the component renders (`jsx-ready-blob-csp-1440-light.png`).
      - Serve sandbox.html through the app, or copy its CSP.
    - *(b) PDF fixture.* The fixture prints all 50 lines on one baseline, because no `TL` precedes the `'` operators (load-progress-path.ts:364-366). `01-pdf-ready.png` and `02-pdf-*` show a smear. Add `16 TL`.
    - *(c) Missing frames.* There is no frame of:
      - the render pill or the version pill;
      - a dark card at 1440;
      - a dead card or the plate at 390 or 320.

      The run asserts that the pill exists, not where it is. Add these frames; CPU throttling holds the pill. Then assert three things:
      - the pill's previous sibling is `header.bar`;
      - its box sits inside the band's box;
      - it intersects no iframe.

      `supplement-runs.ts.txt` is a working version of those runs.

## Not defects

- **Every first-progress shot is before record 0 (mock 04b).** 16 KB chunks every 15 ms beat the 25 ms poll. `plate-contents-*` covers the state after record 0.
- **Toast wording.** The version toast reads "did not finish downloading", where mock 15c reads "could not be downloaded". The simulated failure is a truncation, and that is the existing viewer copy for it.
- **Toast in its first frames.** Captured at insertion, the toast is still rising and translucent. Settled, it matches.

## Outside B, for the main agent

- `packages/relic-mcp/test/load-progress-path.ts` is untracked at 56c05169, while `verify.yml:157` runs it.
- The bin relics show "This file is named like a text or code file but its contents look like a binary file." That comes from the existing classifier, not B's code. Its cause was not traced here.
