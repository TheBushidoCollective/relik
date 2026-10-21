# Playback timing-reader test seam

## Decision

B adds a per-controller optional dependency to the existing private viewer constructor, following its existing audioContext/resolveMedia injection pattern:

```ts
import {
  readOtioVideoTiming,
  type OtioVideoTiming,
} from './otio-video-timing.ts';

export interface CreateOtioPlaybackOptions {
  // Existing fields remain unchanged.
  readonly readVideoTiming?: typeof readOtioVideoTiming;
}

export function createOtioPlayback(options: CreateOtioPlaybackOptions) {
  const readVideoTiming = options.readVideoTiming ?? readOtioVideoTiming;
  // The existing path-keyed timing cache calls this captured function.
}
```

This changes only the private viewer boundary. There is no format, OTIO, MCP, wire, publisher, or browser-UI option. Production callers omit the field. The imported default is A's lightweight bridge, never the demuxer/scanner/worker module.

A's bridge must be safe to import in Bun without a global browser Worker. It must not create a Worker or import Mediabunny at module evaluation. Worker availability is checked only when the default reader is invoked. An unavailable default reader resolves the settled worker-unavailable result. Injecting B's reader therefore bypasses worker execution without requiring any module/global mocks.

## Fake URL issue

Reader DI alone does not make fake blob:clip URLs readable. Current playback tests use fake URL strings (otio-playback.test.ts:866-877) and delayed string-returning resolvers (:802-819). Do not fetch those fake URLs or change production code to substitute fake bytes.

B should use the existing OtioMediaResolver object form for these controller tests:

- resolveUrl retains each test's original URL strings and deferred URL behavior.
- resolveBlob returns a real inert Blob created by the test, with stable identity per canonical path.
- readVideoTiming is an injected async function mapping that Blob identity to an explicitly declared certified timing fixture.
- hasEntry/getDecompressedBytes/dispose keep the existing resolver interface. Playback must still leave an injected resolver alive, as its current disposal test requires.

This preserves source URL assertions such as blob:media/primary_a.mp4 and preserves the later-seek/deferred-resolver behavior. The returned bytes are intentionally not decoded by fake media elements; real container parsing belongs in A and real decoding belongs in C.

Use local helpers in otio-playback.test.ts, not a production test-adapter abstraction. Construct a fresh fake reader/resolver per controller/test and retain local call records. Never use mock.module(), replace a shared module export, change global Worker, or put the override into an OTIO document.

## Timing fixtures

Declare media timing independently from source-range units. For example:

```ts
const mediaBlob = new Blob(['unit-test video marker'], { type: 'video/mp4' });
const certified: OtioVideoTiming = {
  kind: 'windows',
  starts: new Float64Array([0, 1 / 60, 2 / 60, 3 / 60]),
  ends: new Float64Array([1 / 60, 2 / 60, 3 / 60, 4 / 60]),
};
const calls: Array<{ blob: Blob; mime: string; signal: AbortSignal | undefined }> = [];
const readVideoTiming: typeof readOtioVideoTiming = async (blob, mime, signal) => {
  calls.push({ blob, mime, signal });
  if (blob !== mediaBlob) throw new Error('Missing explicit timing fixture for Blob');
  return certified;
};
```

A 24-rate source over this 60fps fixture must select the containing 60fps window. A rate-1 source gets an explicitly declared 24fps fixture. Do not generate fake windows by reading doc.source_time.rate or available_range.rate, which would reintroduce the rejected assumption into the test oracle. Unknown/gapped timing tests inject that exact result and verify the diagnostic/exact-time branch.

## Ownership

A owns:

- Released-library scanner, real-byte container/window and edit-gate unit tests.
- Source/cache/read/packet/index/queue resource limits.
- Worker scheduling, warning isolation, timeout, cancellation, termination, and cleanup tests.
- Lazy worker assets, shell separation, and actual MPL notice/license distribution tests.

Any worker-factory seam used for those scheduler tests stays inside A's private scheduler/test harness. It is not an additional playback option and does not change the shared readOtioVideoTiming signature.

B owns:

- CreateOtioPlaybackOptions.readVideoTiming and the captured default/injected binding.
- Fake-media resolver/reader helpers in otio-playback.test.ts.
- Forwarding the same Blob, MIME and AbortSignal to the reader.
- Per-path read-once caching, independent occurrence decoders, stale render suppression, and disposal abort forwarding.
- Negative/near-zero decisions, actual-window target selection, exact audio, and unknown/uncovered diagnostic fallback.

B tests cancellation only at its boundary: disposing flips the forwarded signal and late injected results do not paint. B does not retest A's Worker termination, timer, queue, byte or packet machinery.

C owns:

- Real browser, native decoder pixels/audio, lazy-worker loading under the real viewer CSP, and existing wire/comment/MCP controls through the full PATH.
- Independent ffprobe-derived encoded-frame/window oracles and real-byte negative controls.
- No injected readVideoTiming option in any end-to-end proof. The production default reader must run.

C does not duplicate A's artificial budget-exhaustion or scheduler race matrix. C does prove the integration's visible unknown/unsupported edit behavior and the known ordinary cases, which scanner unit tests cannot substitute for.

## Acceptance

The Bun fake-media controller suite runs without constructing a browser Worker or globally mocking modules, because every test requiring certified media supplies its own reader and Blob resolver. One lightweight A test verifies the bridge module imports without Worker and its default call returns worker-unavailable; C verifies that the same default executes the real browser worker. Existing controller assertions remain meaningful and unchanged unless the corrected actual-window contract requires a specific new expectation.

This is a dispatch specification, not a claim that the future seam or tests have been implemented or executed.
