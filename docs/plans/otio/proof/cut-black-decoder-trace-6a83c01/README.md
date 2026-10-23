# OTIO Cut Black Frame Decoder Trace (Commit 6a83c01)

Diagnostic instrumentation for discriminating failure modes of the first-frame black witness in the OTIO review path under commit `6a83c011fe9ef4b40204a1ca0ed46744103fba49`.

This is test-only diagnostic instrumentation added to `packages/relic-mcp/test/otio-path.ts`. It is strictly outside production code and must never be cherry-picked into product files or viewer bundles.

## Activation Flag

- Opt-in via environment variable:
  ```sh
  RELIC_OTIO_CAPTURE_DECODER_TRACE=1
  ```
- When unset or not `'1'`, tracing is completely inactive (`captureDecoderTrace = false`).
- When tracing is inactive, the browser evaluation strings in `seekTo` and `sampleCanvas` are byte-identical to base commit `6a83c01`.

## Instrumented Sessions and Labels

Instrumentation is wired into exactly two existing browser sessions:
1. `near-zero-control`: control session loading `nearZeroUrl` (representational zero first frame).
2. `available-origin-cut-witness`: witness session loading `availableOriginCutUrl` (first-frame cut witness).

## Output and Artifact Location

- Output file: `shots/decoder-trace.json` (inside the test run's scratch shot directory).
- Format identifier: `relic-otio-decoder-trace/v1`.
- Persisted before assertions: observations are flushed and written to disk before `sampleCanvas` asserts canvas data and before `assertPacketCanvas` evaluates pixel correctness.
- Teardown snapshot: browser `close()` flushes a final `'teardown'` observation containing the remaining browser trace snapshot and any CDP flush errors without aborting teardown.

## Output Schema

Top-level document:
```json
{
  "format": "relic-otio-decoder-trace/v1",
  "observations": [
    {
      "label": "near-zero-control | available-origin-cut-witness",
      "phase": "sample | teardown",
      "recorded_at": "2026-10-23T20:00:00.000Z",
      ...
    }
  ]
}
```

### Observation Fields by Phase

#### `phase: "sample"`
- `label`: `string | null` (`'near-zero-control'` or `'available-origin-cut-witness'`).
- `phase`: `'sample'`.
- `recorded_at`: ISO 8601 UTC timestamp.
- `rgb`: Array of RGB channel values (`number[] | null`), matching sampleCanvas coordinates.
- `alpha`: Alpha channel statistics over the sampled pixels:
  - `sample_count`: Total sampled pixels (`width * height`).
  - `min`: Minimum alpha value observed (0–255).
  - `max`: Maximum alpha value observed (0–255).
  - `mean`: Arithmetic mean of alpha values.
  - `zero_count`: Count of pixels with `alpha === 0`.
  - `opaque_count`: Count of pixels with `alpha === 255`.
- `root`: Root `.otio-view` dataset attributes at sample time:
  - `frame`: `data-frame` string or `null`.
  - `buffering`: `data-buffering` string or `null`.
  - `ready`: `data-ready` string or `null`.
  - `preview_state`: `data-preview-state` string or `null`.
  - `preview_blocked`: `data-preview-blocked` string or `null`.
- `diagnostics`: Array of text content from `.otio-diagnostics` elements.
- `selected_canvas_id`: Stable identifier for the sampled canvas element (`"canvas-1"`, etc.).
- `native_videos`: Array of video element snapshots for `.otio-video-decoders video` elements:
  - `media_id`: Stable identifier (`"media-1"`, etc.).
  - `current_time`: Video `currentTime` or `null`.
  - `seeking`: Video `seeking` boolean or `null`.
  - `ready_state`: Video `readyState` numeric code or `null`.
  - `network_state`: Video `networkState` numeric code or `null`.
  - `video_width`: Video intrinsic width or `null`.
  - `video_height`: Video intrinsic height or `null`.
  - `error`: Video error object `{ code, message }` or `null`.
- `trace`: Trace state snapshot at sample time.

#### `phase: "teardown"`
- `label`: `string | null`.
- `phase`: `'teardown'`.
- `recorded_at`: ISO 8601 UTC timestamp.
- `trace`: Trace state snapshot at teardown time, or `null` if retrieval failed.
- `flush_error`: Error message string if raw CDP evaluation failed, otherwise `null`.

### Trace State Snapshot Object
- `version`: `1`.
- `capacity`: `512` (maximum events per seek window).
- `next_sequence`: Monotonically increasing sequence integer across all windows.
- `events`: Array of recorded event objects in chronological order.
- `overflow`: `{ dropped: number, firstDroppedSequence: number | null }`.
- `installation_errors`: Array of strings reporting failed hook installations.
- `runtime_errors`: Array of strings reporting safe wrapper failures.

## Event Names and Structure

All events carry:
- `sequence`: Monotonic integer sequence number.
- `browser_time_ms`: Monotonic `performance.now()` timestamp.
- `event`: Event name string.

Recorded event types:
1. `instrumentation_ready`: Emitted when the in-document prelude completes initial installation. Fields: `{ capacity }`.
2. `instrumentation_install_error`: Emitted if a hook installation throws. Fields: `{ name, error }`.
3. `seek_before_input_dispatch`: Emitted inside `seekTo` immediately before dispatching the slider `input` event. Fields: `{ frame, discarded_events, prior_overflow }`.
4. `seek_after_input_dispatch`: Emitted inside `seekTo` immediately after dispatching the slider `input` event. Fields: `{ frame }`.
5. `seek_terminal_predicate_true`: Emitted inside `seekTo` immediately before resolving true on settled frame. Fields: `{ frame, root_frame, buffering }`.
6. `native_video_current_time`: Emitted on `HTMLMediaElement.prototype.currentTime` setter calls on video elements. Fields: `{ input, input_type, before, after, outcome: "returned" | "thrown", error? }`.
7. `native_video_event`: Emitted on capture-phase video events (`loadeddata`, `seeking`, `seeked`, `error`). Fields: `{ event_type, video }`.
8. `canvas_fillRect`, `canvas_clearRect`: Emitted on 2D canvas clearing/filling. Fields: `{ destination, rect: { x, y, width, height }, outcome: "returned" | "thrown", error? }`.
9. `canvas_drawImage`: Emitted on 2D canvas drawImage calls. Fields: `{ source, destination, arguments, native_video, outcome: "returned" | "thrown", error? }`.

## Window Capacity and Overflow Semantics

- Event buffer capacity is bounded at 512 events per seek window (`capacity = 512`).
- Global sequence numbers (`nextSequence`) increment monotonically across windows and are never reset.
- `beginSeek(frame)` starts a new window:
  - Captures `discarded_events = state.events.length` and `prior_overflow = { ...state.overflow }`.
  - Resets `state.events` and `state.overflow`.
  - Records both captured values in the `seek_before_input_dispatch` event.
- If events in a single seek window reach capacity (512), subsequent events in that window are dropped. `overflow.dropped` increments and `overflow.firstDroppedSequence` retains the sequence number of the first dropped event.

## Inconclusive Criteria

A diagnostic run is **INCONCLUSIVE** if any of the following occur:
1. Missing trace output: `shots/decoder-trace.json` does not exist or observations are missing.
2. Installation errors: `trace.installation_errors.length > 0`.
3. Runtime errors: `trace.runtime_errors.length > 0`.
4. Event overflow: `trace.overflow.dropped > 0`.
5. Discarded events: `discarded_events > 0` on `seek_before_input_dispatch` that were not captured by a preceding persisted observation.

An inconclusive run indicates trace fidelity was compromised. An inconclusive run can **never** be interpreted as a positive qualification result or proof of correctness.

## Non-Goals

- No product code changes in `packages/relic-viewer`.
- No modification of existing pixel assertions, oracles, deadlines, or source coordinates.
- No asynchronous waits, `requestAnimationFrame`, or `requestVideoFrameCallback` polling added to the test harness.
