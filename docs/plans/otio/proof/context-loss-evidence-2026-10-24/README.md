# OTIO graphics context loss and resource bound evidence, 2026-10-24

Diagnostic evidence only. This branch is never merged.

`manifest.json` lists the two archive parts, their hashes, the joined archive hash, and the command that reassembles and extracts it. `packets.txt` lists the 83 packets in the archive.

## What the packets show

- `e2c-control-08a54b93d`, `e2c-provoked-08a54b93d`: on product 6a83c01, a GPU process crash at the frame-56 paint of the available-origin/cut witness reproduces the original Node 18 qualification failure field for field (`canvas_black: true`, `rmse_black: 0`, `rmse_correct: 89.44900782009826`, `rmse_wrong: 126.5`). This shows a lost graphics context is sufficient to produce that record. It does not prove the original cause; the original packet lacks alpha and Chrome stderr.
- `resource-baseline-6a83-h1d5ed49`, `resource-baseline-6a83-h1d5ed49-r2`, `e1b-f1-vs-f300d48`: natural context losses on builds without the fix. `contextlost` fired on every canvas about 10 ms after the viewer reported ready, with a `MappableSharedImage` burst in Chrome stderr, and the viewer kept reporting ready over a blank canvas.
- `e2-3c3adca5`: provoked loss shows that defect on 6a83c01 and f300d48. `e2-f1-24cd23c`, `witness-f1-*-218c106`, `r1-states-final-*`: the fix holds buffering while lost and repaints on restore without user action.
- `e1a-3c3adca5`, `e1b-3c3adca5`: 180 runs of the official and passive observers with no natural loss.
- `compare-f1-61b035f`, `resource-*`: resource bounds. Fifty black tracks use 3 composition canvases instead of 101 and release them on dispose; the hostile held-sequence fixture stops at 65,532 path builds instead of exceeding the budget; legitimate layered and dissolve fixtures are byte-identical to 6a83c01.
- `qualification-780dc62`, `qualification-f48bd87`: five Node 24 and five Node 18 qualification rounds, each a full verify, both builds and every SOURCE stage, with no lost context in the alpha census.
- `publish-mcp-40070454688-*`, `pack-capture-proof`: the release dry run failed at packing because `prepack` output polluted the captured tarball name. The old step fails and the fixed step passes on the real package with npm 12.2.1.
