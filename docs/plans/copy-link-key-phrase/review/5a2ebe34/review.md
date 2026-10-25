# C-R: rendered review of `feat/relik-copy-link-panel` at 5a2ebe34

**Verdict: not clear.** There are four defects, three for C-I and one for C-P. Everything else on the panel, the toast once settled, the recipient page and the band at every width matches the mock.

## What was compared

- The six C-P shots in `proof/d06abd26/` against the mock shots of the same size and scheme.
- The real viewer itself. It was rendered from the integration worktree's build of d06abd26 (5a2ebe34 adds only shots), with the proof's fixture (`notes.md`, version 2 of 2), in an isolated headless shell. The same measurements were run against the committed mock. The frames in this directory and `measurements.json` hold the evidence.

## Matches the mock (measured)

- **Panel.** At 1440 light, 1440 dark, 390 dark and 320 light, every part has the mock's size, inset, gap, font, colour, border and padding. Nothing differs by more than 0.6px apart from the link's line count.
  - At 1440 the panel's right edge is 0.3px from the opener's. It also hangs flush under the icon-only opener at 1280 and 1024.
  - Its top sits on the band's bottom edge.
  - At 390 and 320 it is a full-width sheet.
- **Contrast.** The computed colours are identical to the mock's, so the mock's ratios hold. The lowest is 4.78:1, the key part in dark.
- **Phrase.** The numbers come from the CSS counter, 1 to 12 in order. There are three columns at 1440 and 390 and two at 320, and every word stays on one line.
- **Loading and failed.** I held the wordlist chunk for loading and aborted it for failed. Both states are identical to mock 3a and 3b: the same note, colour, slip height and Copy phrase offset.
- **Focus.** Copy link takes focus on open.
  - Opened from the keyboard, it draws a 2px patina ring 2px outside the button in both schemes, as the mock does (`panel-keyboard-1440-*.png`).
  - Opened by pointer, it draws none, which is correct `:focus-visible` behaviour. That is why the proof's 1440 and 390 shots show no ring.
- **Toast, settled.** At 320 it has opacity 1 and sits at x16 y480, 288x64, which is exactly the mock's box. It has z-index 30, and `elementFromPoint` at its centre is the toast, with the panel underneath (`toast-320-light-settled.png`).
- **Recipient page.** It matches mock 9a at 1440 light, with all three key-entry strings verbatim.
- **Band.** It is at the mock's collapse stage at 1920, 1440, 1280, 1024, 390 and 320: the same controls show and the same ones keep their words.
  - The band never overflows, and the identity stays between 121 and 592px against floors of 88 and 192.
  - The version chip stays inside the identity and clear of the first control.
  - Every shown control is in the viewport and named, and every icon-only control has a title.
  - On phones, More opens four entries inside the viewport.

## Defects

1. **The link breaks inside the relic ID, and at 320 inside the key. C-I.**
   - *Shots.* `panel-320-light.png` and `toast-320-light.png` split the key: `#r1wFU4BMlYl5IHi8ki` / `xfHIrA`. `panel-1440-light.png`, `panel-1440-dark.png` and `panel-390-dark.png` split the relic ID: `...dfxgh` / `rrxr#...`.
   - *Element.* `p.copy-value[data-copy-value=link]` is two spans with no break opportunity between them, so `overflow-wrap: anywhere` breaks wherever the line fills. With the production origin, the key splits at 320 (`...E6Q4zWH2ix-` / `wRNg`) and the relic ID at 390.
   - *Fix.* Add two `<wbr>`, as mock decision 3 does:
     - Build the first span as `origin + "/"`, then `<wbr>`, then the relic path.
     - Put a `<wbr>` between that span and the key span.
   - *Measured in the real page with the production link.* The link reads origin, relic ID, key at 320 and 390, and path, key at 1440. The key is in one piece at each width, and `textContent` is unchanged, so neither Copy link nor the refusal selection carries anything extra.

2. **On phones the More rows collapse to 20px. C-I.**
   - *Shots.* None in the proof, which has no shot with More open. See `more-390-dark.png` and `more-320-light.png` here.
   - *Element.* `.band-more-list .action` sets `padding: 0.6rem 0.85rem`, but main's Decisions section comes later in `styles.css`. Its `.actions .action { padding: 0 0.6rem }` (34rem) and `{ padding: 0 0.4rem }` (24rem) have the same specificity, so they win.
   - *Result.* Rows render 20 to 21px tall against the mock's 40 to 41px, under the 24px minimum target size (WCAG 2.5.8). The mock missed this because its copy of the Decisions rules came before the band section.
   - *Fix.* Raise the rule to `.bar .band-more-list .action`. Measured in the real page, rows are then 40 to 41px with 9.6px vertical padding at 390 and 320.

3. **At 34rem and below, a comment count of 10 or more loses its padding. C-I.**
   - *Shots.* None: the proof relic has no comments.
   - *Element.* In the 34rem block, `.action span.action-count` now also sets `padding: 0`, which overrides `.action-count`'s `padding: 0 0.25rem`.
   - *Result.* A count of 12 renders 17.6px wide instead of 23.1px, with the digits about 1px from the border. A count of 128 renders 21.6px instead of 29.6px. This breaks C3.1's "the row must look identical at 320, 390 and 544".
   - *Fix.* Keep main's rule, `.action span.action-count { display: inline-block; }`, and drop the added resets. The scoped C3.1 selector already leaves the count alone. Measured with that change, the counts are 23.1px and 29.6px again.

4. **`toast-320-light.png` is taken during the toast's 180ms rise. C-P.**
   - *What happens.* The proof captures as soon as `.toast` exists (`copy-link-path.ts`, 1332 to 1341). In the shot the toast box is 16% ink over the slip and sits 8px low, so the phrase shows through it, and the shot cannot show the toast above the panel.
   - *Confirmed.* My frame at the same moment measures 15% (`toast-320-light-at-appearance.png`). Once settled, the toast is solid ink and sits exactly where it does in mock 4.
   - *Gap in the assertions.* The layering assertion (`elementFromPoint`, line 786) runs only at 1440, where the toast sits below the panel's bottom edge, so it never tests the toast over the panel.
   - *Fix.* At 320, after the toast appears, wait for `toast.getAnimations()` to finish, assert that `elementFromPoint` at its centre is the toast, and then capture.

## Not defects

- **The proof's band check uses the markdown relic, not OTIO.** It still carries all nine controls. The OTIO marker sentence only shows above 110rem, and "Earlier versions" is the same length as "Compare versions", so the five test widths are covered.
- **At 24rem and below, the mock's band actions have 0.6rem padding; the real viewer keeps main's 0.4rem.** The real viewer is right: the proposal says this stage is unchanged from main, and it was the mock's rule order that was off.

## Outside C, for the main agent

Spec C2.7 says the mnemonic stays out of the shell and that `shell-budget.test.ts` guards this. It does not.

- **Why it reaches the shell.** `relic-format/src/index.ts` has `export * from './mnemonic.ts'`, so the viewer's static imports from `@relic/format` pull the 2048-word list into a shared chunk. `viewer.js` imports that chunk at boot: `chunk-kncscd24.js` on this branch, 37,386 bytes on the wire.
- **C's code is not the cause.** `copy-link.ts` lazy-imports exactly as specified, but the "lazy" chunk it fetches is a one-line re-export.
- **Why the test misses it.** It reads only `viewer.js`.
- **Main ships it too.** The builds of 76269ed5 and 7cc36382 load the wordlist at boot the same way.

This is separate work.
