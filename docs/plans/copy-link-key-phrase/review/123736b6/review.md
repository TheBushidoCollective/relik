# C-R: copy link panel at 123736b6 (shots at 0d975daa)

**Verdict: CLEAR.**

The last open defect, the key splitting at a hyphen, is fixed. These are the checks I said I would make after 25ffcbb6:

1. **The rule is in the commit.** 123736b6 adds `display: inline-block; line-height: normal;` to `.copy-link-key`. That is the rule I measured at 0 splits in 2,000 random keys. The commit changes nothing else in the viewer.
2. **The guard is in the commit.** `assertKeyDoesNotSplit` in `copy-link-path.ts` sets the key to `#r1-AbCdEfGhIjKlMnOpQrStU`, asserts exactly one client rect, then restores the real key.
   - It runs with the panel open at 1440, before that shot, and at 390 and 320, before the 320 toast shot.
   - I showed in the 25ffcbb6 round that this key renders as two rects without the rule.
   - A failing guard throws and stops the script, so the 320 toast and recipient shots in `proof/123736b6/` mean all three guard calls passed in that run.
3. **The rerun shots show the key in one piece.** In all five shots with the panel open, `#r1mhTGLIK_VCLHDegHp9-Fdg` sits whole on its own line:
   - `panel-1440-light.png` and `panel-1440-dark.png`
   - `panel-390-dark.png` and `panel-320-light.png`
   - `toast-320-light.png`, where the key is whole under the toast

This run's key has its hyphen near the end, so the shots alone could not have shown the old split. The guard carries that case.

## Provenance

- The integration worktree is clean and even with origin at 0d975daa.
- The viewer build (01:23:15) is newer than 123736b6 (01:23:08) and older than the shots commit (01:23:31). Its `styles.css` carries the rule.
- 0d975daa adds only the six shots, and their folder is named for the commit that produced them.

## Carried from earlier rounds, all holding

The query-string fix, the More rows, the comment count padding and the settled toast all still hold. The panel matches the mock at every proof size and the band matches its stage at every width, as measured on 25ffcbb6, which differs from 123736b6 only in the key rule.

## Not blocking, for the record

- **The mock is off at 24rem and below.** Its band actions have 0.6rem padding there where the real viewer keeps main's 0.4rem. The real viewer is right.
- **The wordlist loads at boot.** The 2048-word list arrives in a shared chunk that `viewer.js` imports at startup, on main as well as this branch, and `shell-budget.test.ts` reads only `viewer.js`, so it misses it. This is separate work, for the main agent (see `review/5a2ebe34/review.md`).
