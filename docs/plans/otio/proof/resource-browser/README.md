# Targeted OTIO Resource and Pixel Proof Browser Harness

This diagnostic harness provides automated browser proof for two OpenTimelineIO resource repairs:
- Repair A (commit `aaddcc54`): Bounded held-sequence indexing across timeline mounts
- Repair B (commit `80becfbf`): Depth-reused composition surfaces and explicit disposal

Tests run against pinned baseline `6a83c011fe9ef4b40204a1ca0ed46744103fba49` through the real encrypted viewer entry path without executing the long `otio-path.ts` SOURCE pipeline.

## Scope Limits

- Diagnostic-only proof code, isolated to branch `diag/otio-resource-browser`.
- Not a video decoder or image lifecycle benchmark.
- Not a timing or latency qualification suite.
- Does not replace the full workspace test suite or existing OTIO qualification passes.
- Confinement: strictly loopback only (`MemoryStore`, `MemoryStorage`, local ephemeral ports). No production services, credentials, mail egress, or external network requests.
- Browser confinement: strictly the owned headless shell specified in configuration. No browser discovery, fallback heuristics, or relay usage.

## Configuration Format

Configuration files are JSON documents specifying exact absolute paths and immutable cryptographic hashes:

```json
{
  "label": "baseline",
  "productSha": "6a83c011fe9ef4b40204a1ca0ed46744103fba49",
  "productRoot": "/absolute/path/to/relic/worktree",
  "viewerDist": "/absolute/path/to/relic-viewer/dist",
  "nodePath": "/absolute/path/to/bin/node",
  "mcpBundle": "/absolute/path/to/relic-mcp/dist/index.js",
  "chromePath": "/absolute/path/to/chrome-headless-shell",
  "chromeSha256": "3779e394348633391d3eb2ea9f88ff8856fe73e65ee7a30488aeaf7092923297"
}
```

### Validation Rules

1. All paths must be absolute and point to existing files or directories.
2. `productRoot` Git HEAD must match `productSha`.
3. `chromePath` executable is hashed with SHA-256 before launch. Any mismatch against `chromeSha256` aborts immediately as a setup failure.
4. An asset manifest of `viewerDist` is recorded as sorted relative path to SHA-256 pairs.
5. Hashes of `otio-timing.ts`, `otio-playback.ts`, `mcpBundle`, `nodePath`, and all generated fixture files are written to `manifest.json`.

## Invocations

### 1. Record Baseline

```bash
mise exec -- bun packages/relic-mcp/test/otio-resource-browser.ts \
  record --config /absolute/baseline-config.json \
  --out /absolute/resource-baseline
```

### 2. Record Candidate

```bash
mise exec -- bun packages/relic-mcp/test/otio-resource-browser.ts \
  record --config /absolute/candidate-config.json \
  --out /absolute/resource-candidate
```

### 3. Compare Baseline and Candidate

Compares semantic observations between baseline and candidate directories, ignoring non-semantic fields (timestamps, durations, observer-only state) while strictly asserting fixture byte equality, R1-R5 properties, and R6 evaluator output.

```bash
mise exec -- bun packages/relic-mcp/test/otio-resource-browser.ts \
  compare --baseline /absolute/resource-baseline \
  --candidate /absolute/resource-candidate \
  [--require-no-context-events]
```

When `--require-no-context-events` is passed, comparison fails if either packet's R1 recorded any `contextlost` events (rejecting natural-loss packets as valid comparison evidence). For legacy packets predating event recording (such as `h71555e3`), it prints a notice and asserts that R1 settled and seek2 canvases are both `OPAQUE_EXACT`.

### 4. Comparison Substitution Falsifier

The compare command verifies that replacing candidate observations with baseline observations causes immediate failure.

Run the built-in substitution self-test flag:

```bash
mise exec -- bun packages/relic-mcp/test/otio-resource-browser.ts \
  compare --baseline /absolute/resource-baseline \
  --candidate /absolute/resource-candidate \
  --self-test-substitution
```

Alternatively, invoke compare pointing both arguments at the baseline directory:

```bash
mise exec -- bun packages/relic-mcp/test/otio-resource-browser.ts \
  compare --baseline /absolute/resource-baseline \
  --candidate /absolute/resource-baseline
```

This command must exit non-zero because the baseline data fails R1 canvas counts and R5 budget boundaries.

### 5. Official Repeat (E1a: Frequency under Official Observer)

Spawns the unmodified official `record` subcommand from a pinned checkout (e.g. detached `71555e3e`) in balanced ABBA blocks (`baseline`, `candidate`, `candidate`, `baseline`) to measure natural R1 context loss rates without changing the official execution path.

```bash
mise exec -- bun packages/relic-mcp/test/otio-resource-browser.ts \
  official-repeat \
  --checkout /Users/jwaldrip/.omp/wt/otio-resource-browser \
  --baseline-config /Users/jwaldrip/.omp/otio-evidence/resource-browser-configs/baseline.json \
  --candidate-config /Users/jwaldrip/.omp/otio-evidence/resource-browser-configs/candidate.json \
  --out /Users/jwaldrip/.omp/otio-evidence/e1a \
  --blocks 15 \
  --runs 60
```

#### Telemetry and Snapshots
- **System Snapshots**: Pre-run and post-run captures of Apple Silicon AGX `PerformanceStatistics` via `ioreg`, macOS `memory_pressure` (free memory percentage), `os.loadavg`, and foreign `chrome-headless-shell` process counts.
- **R1 Readback Classification**:
  - `OPAQUE_EXACT`: SHA-256 `7b1fcc441fd6c2518b2a0f818b1982eba6287d23712be4a8c7c51e4b281f719b`
  - `TRANSPARENT`: SHA-256 `11283ef755895422e6f28b93f3d78cad7539891cf2893c9fdccefb923c5bf70b`
  - `OTHER`: Any differing SHA-256 digest
- **Browser Log Classification**:
  - R1 window: Counts `Creation of MappableSharedImage failed` lines and `Canvas2D: Multiple readback operations` warning lines before R1 browser close.
  - Later windows: Counts `Creation of MappableSharedImage failed` lines across cases R2–R6.
  - `signature-only`: Assigned when R1 reads `TRANSPARENT` with at least 1 `MappableSharedImage` line and 0 readback warnings.

#### Stop Rules (E1a)
- Any R1 readback `OTHER`: Stop immediately (verdict: `other`).
- Infrastructure failure (non-zero child exit or missing outputs): Stop immediately (verdict: `infrastructure_failure`).
- Baseline >= 1 and Candidate >= 1 `TRANSPARENT`: Stop immediately (verdict: `arm-independent`).
- Candidate >= 5 and Baseline == 0: Stop immediately (verdict: `candidate-associated`, exact one-sided Fisher p <= 0.029).
- Cap reached (60 runs):
  - Candidate 1–4, Baseline 0: `inconclusive`
  - Baseline only >= 1: `arm-independent`
  - Zero transparent total: `none`

Output summary with exact Clopper-Pearson 95% binomial confidence intervals and exact one-sided Fisher p-value is written to `<outDir>/summary.json`.

### 6. R1 Repeat (E1b: Natural Failures with Direct Signals)

Runs R1 across 4 rotated arms `{baseline, candidate} x {official, passive}` with direct context loss telemetry, late recovery windows, and optional background GPU noise.

```bash
mise exec -- bun packages/relic-mcp/test/otio-resource-browser.ts \
  r1-repeat \
  --baseline-config /Users/jwaldrip/.omp/otio-evidence/resource-browser-configs/baseline.json \
  --candidate-config /Users/jwaldrip/.omp/otio-evidence/resource-browser-configs/candidate.json \
  --out /Users/jwaldrip/.omp/otio-evidence/e1b \
  --rounds 30 \
  [--noise] \
  [--e1a-verdict <verdict>]
```

#### Passive Observers and Late Window
- `getContextEvents()`: Captures native `contextlost` and `contextrestored` events on `canvas.otio-canvas`.
- `readVisibleWithState()`: Evaluates `isContextLost()` then `getImageData()` in a single atomic task.
- **Late Window**: When either settled or seek2 readback is non-`OPAQUE_EXACT`, harness waits 3000 ms, logs state and events, reads canvas, seeks to frame 0, and reads again to verify if context recovers.
- **Optional Noise**: An independent headless shell repainting a 960x540 2D canvas every frame and requesting screenshots every 30 ms, active during noise rounds.

#### Classification and Stop Rules (E1b)
- `M1`: TRANSPARENT, and canvas recorded `contextlost` event before readback or reported `isContextLost()` true at it.
- `M2`: TRANSPARENT with neither event nor flag (passive arms only).
- Stop on `OTHER` -> `other`
- Stop on `M2` -> `m2_observed`
- Stop on infrastructure failure -> `infrastructure_failure`
- Stop when at least 1 passive `M1` appears in both baseline and candidate -> `passive_m1_both_products`
- Stop when 1 passive `M1` appears overall if E1a was already `arm-independent` -> `arm-independent`
- Cap reached (30 rounds):
  - Failures in noise rounds only -> `noise_only` (proves concurrent headless GPU use is trigger)
  - Zero failures -> `none`
  - Otherwise -> `inconclusive`

### 7. R1 Provocation (E2: Mechanism by Provocation)

Deterministically exercises the context loss mechanism through CDP browser-level fault injection across baseline and candidate arms (3 trials per mode).

```bash
mise exec -- bun packages/relic-mcp/test/otio-resource-browser.ts \
  r1-provoke \
  --baseline-config /Users/jwaldrip/.omp/otio-evidence/resource-browser-configs/baseline.json \
  --candidate-config /Users/jwaldrip/.omp/otio-evidence/resource-browser-configs/candidate.json \
  --out /Users/jwaldrip/.omp/otio-evidence/e2 \
  --mode all \
  --trials 3
```

#### Provocation Modes
1. `gpu-crash-after-settle`:
   - Settle R1 viewer -> capture initial readback.
   - Issue `Browser.crashGpuProcess` and poll until GPU PID exits.
   - Readback while lost: must record `contextlost` and return `TRANSPARENT`.
   - Wait up to 3000 ms for `contextrestored`.
   - Readback after restore: must remain `TRANSPARENT` while `ready='true'` and `buffering='false'`.
   - Seek to frame 0: must recover and read back `OPAQUE_EXACT`.
   - Success in >= 2 of 3 trials demonstrates the **product defect**.
2. `gpu-crash-first-paint` (Fault Barrier):
   - Harness sets `window.__otioFaultArm = 'visible-paint-end-1'` and enables `Debugger`.
   - In prelude, matching native visible `drawImage` triggers `debugger;`.
   - On `Debugger.paused`, harness crashes GPU process, polls PID gone up to 2000 ms, then sends `Debugger.resume`.
   - Settle and seek2: both read back `TRANSPARENT`, 0 readback warnings, and `MappableSharedImage` logged.
   - Success in >= 2 of 3 trials demonstrates the **natural signature**.
3. `memory-pressure-after-settle`:
   - Sends `Memory.simulatePressureNotification` (`critical`). Record only.

### 8. R1 Stress (E1-amp: Stress Amplification)

Executes 200 rapid seeks on R1 without intervening canvas readbacks to measure context loss resilience under churn across a list of configuration files.

```bash
mise exec -- bun packages/relic-mcp/test/otio-resource-browser.ts \
  r1-stress \
  --config /Users/jwaldrip/.omp/otio-evidence/resource-browser-configs/baseline.json \
  --config /Users/jwaldrip/.omp/otio-evidence/resource-browser-configs/candidate.json \
  --out /Users/jwaldrip/.omp/otio-evidence/e1-amp \
  --trials 10 \
  --seeks 200
```

#### Metrics Recorded
- `contextlost` event count on visible canvas.
- `Creation of MappableSharedImage failed` lines in `browser.stderr`.
- High-resolution paint start/end timestamps and duration distributions (min, max, mean, median, p95).
- Evaluation rule: Candidate >= 5 of 10 trials with `contextlost` while Baseline is 0 flags candidate churn trigger.

### 9. R1 Rendered States for Designer Review (r1-states)

Exercises and captures rendered loss, restored, and failed-restore states for designer review with 1440x900 full-page screenshots and `.otio-view` element crops.

```bash
mise exec -- bun packages/relic-mcp/test/otio-resource-browser.ts \
  r1-states \
  --config /Users/jwaldrip/.omp/otio-evidence/resource-browser-configs/candidate.json \
  --out /Users/jwaldrip/.omp/otio-evidence/r1-states
```

#### States Captured
1. `lost`: Real GPU crash (`Browser.crashGpuProcess`); captured IMMEDIATELY after `contextlost` is observed (< 16 ms polling) and before `contextrestored`. Records time gap in ms.
2. `restored`: Same trial; captured after `contextrestored` once `data-ready` settles without user seek.
3. `failedRestore100ms`: Synthetic `contextlost` event dispatched on canvas; captured at +100 ms.
4. `failedRestore3500ms`: Captured after 3000 ms restore deadline passes. Expects `unsupported-browser` diagnostic ("Preview graphics context was lost and the browser did not restore it") and buffering cleared.
5. `failedRestoreAfterRepaint`: Synthetic `contextrestored` event dispatched; captured after repaint.

Output manifest with all state metadata, diagnostics, readback classes, and screenshot file paths is written to `<outDir>/states.json`.

## Fixture Matrix and Expected Numbers

| Fixture | Description | Baseline (6a83) | Candidate | Deciding Observable |
|---|---|---|---|---|
| **R1** | 50 wide black tracks | 101 offscreen canvases<br>52,358,400 pixels<br>50 leaf fills | 3 offscreen canvases<br>1,555,200 pixels<br>50 leaf fills | Offscreen canvas count, peak pixels, dispose zeroing |
| **R2** | Maximum-depth witness | 62 canvases (chain depth 62)<br>32,140,800 pixels | 62 canvases<br>32,140,800 pixels<br>Dispose zeroes 62 canvases | 61 Stacks/depth 62 accepted; 62 Stacks rejected (>64 JSON depth) |
| **R3** | Layered composition | 0 differing pixels<br>3 authored tracks | 0 differing pixels<br>3 authored tracks | Identical pixels, analytic color check (approx 50, 100, 50, 255) |
| **R4** | SMPTE dissolve | 0 differing pixels at frames 18, 24, 30 | 0 differing pixels at frames 18, 24, 30 | Dual branch draws at frame 24 midpoint, pixel equality |
| **R5** | Hostile held sequences | Terminated on budget violation (>65,532 calls) | Settled (`diagnostic`), exactly 65,532 calls | Streamed count > 65,532 triggers termination; candidate settles with 9 budget refusals |
| **R6** | Raw empty-index control | Settles (`diagnostic`), missing-media | Settles (`diagnostic`), missing-media | Browser missing-media without budget exhaustion; evaluator outputs match |

### Per-Case Criteria

#### R1: Fifty Wide Black Tracks
- Timeline with 50 authored Video Tracks, each holding one timed clip with zero-image black policy (`missing_frame_policy: 'black'`).
- Initial settled frame:
  - Baseline creates 101 offscreen canvases (52,358,400 pixels).
  - Candidate creates exactly 3 offscreen canvases (1,555,200 pixels).
  - 50 black leaf fills observed per completed paint on both.
  - 50 authored track rows present in DOM.
  - Canvas pixels are opaque black with 0 differing bytes.
- Second seek to frame 0:
  - Candidate creates 0 additional canvases.
  - 50 leaf fills still execute.
  - Pixels remain identical.
- Pagehide disposal:
  - Candidate offscreen composition canvases have dimensions reset to 0x0 and accounted offscreen pixels become 0.
  - Baseline retains its nonzero surface dimensions in the diagnostic ledger.

#### R2: Actual Maximum-Depth Witness
- 61 Stacks nested through single-object `tracks` edges, with the bottom Clip at JSON object depth 62.
- Parsed and accepted by both baseline and candidate without diagnostic.
- Viewer renders opaque black.
- Candidate uses exactly 62 composition canvases (62 * 960 * 540 = 32,140,800 pixels).
- Candidate disposal zeroes all 62 composition surfaces.
- One additional Stack (62 Stacks, bottom Clip at depth 63) triggers a syntax error from `parseOtioJson` exceeding the `MAX_JSON_DEPTH` limit of 64.

#### R3: Layered and Nested Composition
- Lossless locally generated PNG media: base opaque blue (`0, 0, 200, 255`), middle translucent red (`200, 0, 0, 128`), top translucent green (`0, 200, 0, 128`).
- 0 differing bytes between baseline and candidate RGBA canvas exports.
- Analytic color check verifies center pixel (480, 270) matches expected theoretical composite within browser rounding tolerance (+/- 4 per channel) and opaque alpha.
- All 3 authored tracks present with 0 diagnostics.

#### R4: Legitimate SMPTE Dissolve
- Two distinct color clips (outgoing red, incoming cyan) in a transition track with a 6-frame in/out SMPTE dissolve, over an opaque dark grey background track.
- Frames probed: 18 (dissolve entry), 24 (dissolve midpoint), 30 (dissolve exit).
- 0 differing bytes between baseline and candidate for all three frames.
- Frame 18 displays outgoing red; frame 30 displays incoming cyan.
- Frame 24 midpoint visibly blends both branches, and canvas accounting confirms both transition branch draws (`draws >= 2`).
- 0 diagnostics.

#### R5: Hostile Held Sequences
- 10 distinct hold sequences with 65,532 images each, available range starting at frame 24 at rate 24, and clip source starting at 0. Prefixes `holdp000_` through `holdp009_`.
- Archive contains one unrelated PNG and none of the sequence entries.
- Baseline: exceeds 65,532 matching `decodeURIComponent` calls. Counter streamed via CDP binding terminates the browser once work exceeds 65,532, recording outcome `terminated-after-observed-budget-violation`.
- Candidate: initial render settles as `diagnostic`. Exactly 65,532 matching calls recorded across mount. All 10 track rows remain. First sequence has missing-media warning; remaining 9 sequences have budget-refusal warnings ("held sequences exceed 65532 images"). Two same-frame seeks add 0 matching calls.

#### R6: Raw Empty-Index Semantic Control
- Browser check: raw `.otio` published without a media index settles as `diagnostic` with missing-media warning, and neither baseline nor candidate reports budget exhaustion.
- Evaluator check: dynamic import of `readOtioDocument` and `evaluateOtioAt` from `packages/relic-format/src/index.ts` in `productRoot`. Both return identical structure, sample kind, and diagnostics.

## Artifacts Layout

```text
<output-directory>/
  manifest.json              # Run status, configuration, commit SHA, file hashes
  asset-manifest.json        # Sorted relative paths and SHA-256 hashes of viewerDist
  browser-attestation.json   # Headless launch arguments and version attestation
  observations.jsonl         # Incremental per-case observations
  binding-events.jsonl       # Streamed CDP binding events
  fixtures/                  # Deterministic generated .otioz and .otio files
    R1.otioz
    R2.otioz
    R2_reject.otio
    R3.otioz
    R4.otioz
    R5.otioz
    R6.otio
  pixels/                    # Full 960x540 RGBA canvas byte dumps (.rgba)
  screenshots/               # Viewport capture PNGs (.png)
  stderr/                    # Capped browser and MCP process stderr (.stderr)
  result.json                # Summary of all test case outcomes
```
