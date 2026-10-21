# OTIO decoder-boundary investigation

This branch preserves investigation evidence. It is not a product change and must not be merged into the product branch. Its base is bf48a315b140ebbc6d268510e847c5bba28ba79b.

## Reproduce

From the repository root, with the repository's mise toolchain and workspace dependencies installed:

```sh
mise exec -- bun probe/strict-negative.ts
mise exec -- bun probe/drift-search.ts
probe/gen-media.sh
mise exec -- bun probe/browser-run.ts
```

The media generator requires ffmpeg and ffprobe. The browser driver requires an executable headless-capable Chrome found by the repository's existing Chrome discovery. It launches its own browser over a debug pipe and a new loopback-only server. It does not use a logged-in browser session or a live service.

The driver bundles packages/relic-viewer/probe-boundary/browser-entry.ts in memory. It does not build the product. It writes probe/results.json, probe/raw-results.json, and probe/viewer-results.json. The checked-in frame-coded media are generated test data, not downloaded private media. Each video has a white presence marker plus seven frame-index bits, so frame zero differs from black/withheld output.

## Scope of the evidence

Chrome reported Chrome/156.0.8078.47. No claim is made for Safari or Firefox. Actual viewer probes invoke readOtioDocument, createOtioPlayback, its evaluateOtioAt calls, and canvas drawImage. Expected frame indices in the raw CFR comparison use independent BigInt rational arithmetic.

Known-CFR zero-origin native-grid midpoint targets passed all twelve raw groups. That experiment used independently supplied ffprobe FPS. It does not validate a production metadata reader, arbitrary edit lists, VFR frame selection, or unknown timing.

Actual viewer errors at the pinned base: 24-rate/24fps control 0/48; 24-rate/60fps 48/48; rate-1/24fps 46/48; 30000/1001-rate/24fps 24/59. Timeline zero in the rate-1 case showed frame 12 instead of frame zero, with no diagnostic.

The evaluator-only probe also reproduces negative representational zero for both Audio and Video, with no missing-handles diagnostic. The browser viewer probe shows the resulting blank frame. A sequential-placement case is 12@(24000/1001) plus 55@(30000/1001), whose next start is 56.00000000000001@(24000/1001).

No product source was edited for these probes. Repository verification, tests, lint, and formatters were not run as part of this investigation. Permanent minimal regressions belong in the product worker's separate change.

## Additional package research

Any subsequent dependency probe is isolated from product dependencies. Published-package source, dependencies, archives, generated bundles, and native artifacts must not be committed here. Record the exact package version, public artifact URL and integrity, API used, input fixtures, and measured results instead.
