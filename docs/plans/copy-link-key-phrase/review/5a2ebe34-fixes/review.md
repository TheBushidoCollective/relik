# C-R rerun: the four fixes on top of 5a2ebe34

**Verdict: not clear yet.** All four defects are fixed, measured in the real viewer. The link fix introduced one new defect, which is a one-line change, and none of the fixes are committed yet.

## What was reviewed

- **Code:** `5a2ebe34` plus the uncommitted working tree in the integration worktree: `main.ts` blob b808eb03, `styles.css` blob e42a2a84, `copy-link-path.ts` blob d836e4cb.
- **Viewer:** the working tree's own build, `dist/viewer.js` from 01:06:56, rendered with the measurement code from `review/5a2ebe34`.
- **Shots:** the six in the untracked `proof/5a2ebe34/`.

## Fixed

1. **Link.** The relic ID and the key stay whole at 1440, 390 and 320, with the proof's local link and with the production link, and the shown text equals the share URL.
2. **More rows.** They are 40 to 41px tall with 9.6px vertical padding at 390 and 320 (`more-390-dark.png`, `more-320-light.png`).
3. **Count chip.** It measures 17.6, 23.1 and 29.6px for one, two and three digits, which are main's widths (`count-12-390-light.png`).
4. **Toast shot.** The new `toast-320-light.png` shows solid ink at the toast's rest position: sampled alpha 1.0, top edge at y480. The proof now also asserts `elementFromPoint` at 320.

There are no regressions elsewhere. Every panel part still matches the mock at 1440 light, 1440 dark, 390 dark and 320 light, and the band is at the mock's stage at 1920, 1440, 1280, 1024, 390 and 320.

## New defect

5. **The link drops the page's query string. C-I.**
   - *Shot.* `query-1440-light.png`.
   - *What happens.* Opened as `.../<id>?utm_source=review#...`, the panel shows `.../<id>#...`. Copy link, however, copies `.../<id>?utm_source=review#...`, and Copy without the key copies `.../<id>?utm_source=review`.
     - The share URL keeps the query because `shareUrlFor` only sets the hash on `location.href`.
     - At 5a2ebe34 the shown text matched, because the span held everything before the `#`.
   - *Element.* `main.ts` now builds the text after `origin + "/"` from `urlObj.pathname`, which has no query.
   - *Fix.* Take that text from the share URL itself: `const relicPath = originAndPath.slice(originSlash.length);`. My first review said "the relic path", which was ambiguous; the mock slices it this way.
   - *Measured in the real page with that change.* With and without a query, at 1440, 390 and 320:
     - the shown text equals the share URL
     - the keyless span equals what Copy without the key copies
     - the key stays whole and nothing overflows
   - *Guard.* A unit test with a query string would keep it from coming back.

## Before CLEAR

- Commit and push the fixes together with the change above. Today they exist only in the integration worktree's working tree.
- Rerun `copy-link-path.ts` after committing, so the shots land in `proof/<new sha>/`. The shots in `proof/5a2ebe34/` came from uncommitted code that 5a2ebe34 does not contain, so leave that folder out of the commit.

Then send me the commit, and I'll check the change, the new shots and the query case.
