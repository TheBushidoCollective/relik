# C-R: copy link panel at 25ffcbb6 (shots at 12290655)

**Verdict: not clear. One defect is left: the key still splits, now at a hyphen inside it.** The `<wbr>` fix I prescribed last round was incomplete. Everything else holds, including the query-string fix.

## Holding

These were measured in the real viewer built from 25ffcbb6. The worktree was clean and the build is newer than the commit.

- **Query string:** the shown link equals what both buttons copy, and test 13 guards it.
- **More rows:** 40 to 41px on phones.
- **Comment count chip:** 17.6, 23.1 and 29.6px for one, two and three digits.
- **Toast:** the toast shot is solid at rest, and the 320 assertion is in.
- **Panel:** it matches the mock at all four proof sizes.
- **Band:** it sits at the mock's stage at 1920, 1440, 1280, 1024, 390 and 320.
- **Test 8:** its fixed key is a legitimate deflake. The keyless toast contains the BIP-39 word "key", so a random phrase made it fail about 0.6% of the time.

## The defect

1. **The key splits at a hyphen. C-I.**
   - *Shots.* All five 25ffcbb6 shots with the panel open show it:
     - `panel-1440-light.png`, `panel-1440-dark.png` and `panel-390-dark.png` read `#r1KzM-V-aV2or-` / `c20T3ecLXA`.
     - `panel-320-light.png` and `toast-320-light.png` read `#r1KzM-` / `V-aV2or-c20T3ecLXA`.
   - *Cause.* Base64url keys contain `-`, and a hyphen is a line-break opportunity. When the relic ID and the start of the key fit on one line, the browser breaks at the last hyphen that fits rather than at the `<wbr>`. My earlier checks used keys whose hyphens came too late to fit, which is why the `<wbr>` looked sufficient. It isn't.
   - *How often, with the production link and 2,000 random keys.* The committed build splits the key for 155 keys (7.8%) at 320 and 419 (21%) at 390. At 1440 it splits none, because the path fills the first line. With the proof's longer local origin it splits at 1440 too (`committed-1440-light.png`).
   - *Fix.* Add one rule to the copy-link panel section:

     ```css
     .copy-link-key { display: inline-block; line-height: normal; }
     ```

     An inline-block is atomic for line breaking: the line breaks before it, never inside it. The one exception is a key wider than the whole line, which then wraps inside its own tint. `line-height: normal` keeps the tint the height of the text.
   - *Measured in the real page with that rule.*
     - 0 of 2,000 keys split at 1440, 390 or 320.
     - This relic's key (`#r15c-...`) sits whole on its own line at each proof size (`with-rule-*.png`).
     - Where the key never split, the panel is pixel-identical, with the same 192x17 tint.
     - With a 1.6rem link font at 320, the key wraps inside its tint and nothing overflows.
     - The selected text is still exactly the link.
   - *Guard (C-P).* A unit test can't see layout, so the proof has to: at each panel size, set the key span to a key with an early hyphen, such as `#r1-AbCdEfGhIjKlMnOpQrStU`, and assert that `.copy-link-key` has exactly one client rect.

## Clear when

The commit carries that rule and that guard, and the rerun shots show the key in one piece at 1440, 390 and 320. Those are the only things I will check.
