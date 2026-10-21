# Settled OTIO media-reader amendment

## Decision and correction

Use the exact released `mediabunny@1.62.0` to read packet presentation timestamps and durations from the same local bundled Blob. Index actual presentation windows. Remove the uniform-FPS/grid interface entirely.

Correction to the earlier probe interpretation: the native-CFR midpoint experiment used ideal-FPS expected frame ordinals. Its WebM success count does not establish encoded-window correctness. Actual 30fps WebM PTS are 0, .033, .067, ...; source time 2/30 seconds lies in [.033, .067), so encoded frame 1 is correct. Do not round the source time or reconstruct 30fps from DefaultDuration. New real-byte package/browser probes demonstrate this actual-PTS behavior.

Mediabunny alone needs a narrow ISO edit-safety gate. It warns but continues on multi-edit/rate!=1 lists, and silently ignores the duration of a single rate-1 edit. A preserved shortened-edit MP4 shows the consequence: the library chooses packet/frame 30 at t=1.25, while Chrome displays frame 23 because the edit stopped presentation at t=1.0. The gate classifies only a safe subset; it does not implement sample-table, ctts, stts, or EBML demuxing.

## Package/API receipts

- Published metadata: https://registry.npmjs.org/mediabunny/1.62.0
- Tarball: https://registry.npmjs.org/mediabunny/-/mediabunny-1.62.0.tgz
- SHA256 of downloaded tarball: 943c852c707e4bce6afe73d5dec43da894eb964dbf3713460c630368f7393d16
- Registry integrity: sha512-D8E8BDxjCyqyrGj074jLRQNgilDW5izJu8o9pg7THMYMIZBL1Fao5hOtdDPDfA+nSnk68tMa8IaCJmz8hSpJpw==
- License is MPL-2.0, not MIT. Public notice/source-availability obligations must ship with the actual distributed worker.
- Public API: https://unpkg.com/mediabunny@1.62.0/dist/modules/src/media-sink.d.ts
- Sources/cache options: https://unpkg.com/mediabunny@1.62.0/dist/modules/src/source.d.ts
- Packet fields: https://unpkg.com/mediabunny@1.62.0/dist/modules/src/packet.d.ts
- Logging subscription: https://unpkg.com/mediabunny@1.62.0/dist/modules/src/logging.d.ts
- Independent production adoption: https://www.remotion.dev/docs/mediabunny/index.md explicitly identifies use in @remotion/media, @remotion/media-utils, Studio, and its converter.

The shipped calls exercised in Chrome are:

```ts
const source = new CustomSource({
  getSize: () => blob.size,
  maxCacheSize: 2 * 1024 * 1024,
  prefetchProfile: 'none',
  read: async (start, end) => {
    // Check all app read budgets before materializing the Blob slice.
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  },
});
const input = new Input({ formats: [MP4, QTFF, WEBM], source });
const tracks = await input.getVideoTracks();
const sink = new EncodedPacketSink(tracks[0]);
let packet = await sink.getFirstPacket({ metadataOnly: true, skipLiveWait: true });
while (packet) {
  // Retain timestamp and duration only, under the packet/index limits.
  packet = await sink.getNextPacket(packet, { metadataOnly: true, skipLiveWait: true });
}
input.dispose();
```

`getNextPacket` is decode order, not presentation order. Sort the bounded scalar timing records by PTS. Avoid `packets()` because it preloads. Do not call computePacketStats, computeFrameRateMetrics, getDecoderConfig, canDecode, VideoSampleSink, or any encoder/decoder API. No UrlSource, PathedSource, HLS, ALL_FORMATS, codecs, or optional plugins.

## Exact shared contract for A and B

```ts
export type OtioVideoTimingReason =
  | 'file-too-large'
  | 'unsupported-container'
  | 'ambiguous-video-track'
  | 'unsupported-edit-list'
  | 'edit-window-mismatch'
  | 'demux-warning'
  | 'read-budget'
  | 'packet-budget'
  | 'index-budget'
  | 'invalid-packet-timing'
  | 'unknown-duration'
  | 'timeout'
  | 'cancelled'
  | 'worker-unavailable'
  | 'worker-budget';

export type OtioVideoTiming =
  | {
      readonly kind: 'windows';
      readonly starts: Float64Array;
      readonly ends: Float64Array;
    }
  | {
      readonly kind: 'unknown';
      readonly reason: OtioVideoTimingReason;
    };

export function readOtioVideoTiming(
  blob: Blob,
  mimeType: string,
  signal?: AbortSignal
): Promise<OtioVideoTiming>;
```

The two arrays have equal length and contain only certified nonempty half-open windows, in increasing presentation order, with no overlap. Values are seconds on the container/browser presentation timeline. Do not subtract the first PTS or normalize a positive/negative media origin to zero. Omit intervals that cannot be certified; querying an uncovered source sample uses B's exact-time diagnostic fallback. A scan interrupted by a resource cap returns `unknown`, never a partially scanned index.

B imports only this bridge/types, never Mediabunny. There is no media-reference, contribution, anchor, archive, or MCP schema change.

## Packet/window algorithm

1. Admit Blob size at most 100 MiB before constructing Input. Obtain one video track; zero or multiple tracks are unknown. No preference/guessing among video tracks.
2. Subscribe to public `Logging.on('warn', ...)` and `Logging.on('error', ...)` before the first Input read. Any warning/error makes this job unknown. Each job runs alone in its own worker realm, so the global logger cannot mix files. Always remove listeners and call input.dispose in finally; outer cancellation/timeout terminates the worker.
3. For MP4/MOV, run the narrow edit gate below. WebM needs no custom EBML reader.
4. Enumerate all metadata-only packets through getFirstPacket/getNextPacket, checking the packet/read budgets on every iteration. Retain only PTS and reported duration, not packet objects/data/sideData. Verify finite PTS and finite nonnegative duration. Duplicate PTS makes selection ambiguous and returns invalid-packet-timing.
5. Sort by PTS, not sequenceNumber/decode order.
6. For a non-final packet, use the next sorted PTS as the upper bound. If its positive reported duration ends earlier, keep the earlier end, leaving the uncovered gap uncertified. A zero reported duration can use the next PTS. For the final packet, use only a positive finite reported duration; zero means unknown tail, with no average/default FPS reconstruction. WebM source audit and a real no-DefaultDuration fixture confirm missing BlockDuration+DefaultDuration yields duration zero, not a positive guess. Positive terminal duration on the audited MP4/WebM paths comes from sample/container duration metadata; it is used once, never accumulated as an FPS cadence.
7. Clip certified windows to an accepted edit's presentation extent. Drop entirely negative-end/preroll windows. Keep a crossing window only for its nonnegative, edited portion. Do not fabricate a window at an unsupported edit, gap, duplicate PTS, or unknown tail. If no certified windows remain, return unknown-duration or invalid-packet-timing as appropriate.
8. Transfer the final starts/ends ArrayBuffers to the caller. Do not retain raw packet payloads or Input instances in the cache.

## Narrow ISO edit safety gate

This gate reads only bounded box structure, movie timescale, selected track ID, and `elst` shape/extent. All packet timing remains Mediabunny's responsibility.

- Traverse only root/moov, moov/mvhd, moov/trak/tkhd, and selected trak/edts/elst. Skip other payloads. Match the public selected track.id to tkhd track ID. Do not parse mdhd, stts, ctts, stsz, stco, sample data, or WebM elements.
- Bound traversal to 4096 box headers and depth 8. Support 32/64-bit box sizes with checked parent/file bounds, and reject unrepresentable integer times/sizes. All reads count against the same byte/read-call budget as demux reads.
- Accept absent elst. Otherwise accept version 0 or 1 with exactly one nonempty forward 1.0-rate edit, optionally preceded by one 1.0-rate empty edit. Reject loops, multiple effective edits, empty-only lists, dwell/rate changes, malformed lengths, unknown versions, and ambiguous track association.
- Read the accepted presentation interval from leading-empty and effective segment durations in mvhd movie timescale. Mediabunny already applies the affine offset; the gate must not reconstruct or replace packet PTS.
- Certify only edits covering the complete visible packet body: the last sorted packet start must precede the edit end. If an edit end cuts off one or more complete indexed presentation packets, return edit-window-mismatch. The shortened-edit real-byte fixture must fail here even though the library emitted no warning.
- Require the edit end not to exceed the final positive-duration packet end by more than one declared movie-timescale tick. This permits format-level duration quantization, not an invented epsilon. The emitted final window ends at the minimum of packet end and edit end. The first window is similarly clipped to the declared edited start. If endpoint certification is unavailable, leave that endpoint/sample unknown.

This safe subset includes the generated ordinary MP4/MOV/B-frame/VFR examples: normal MP4 elst end=2.0; B-frame MP4/MOV end=2.0 with media_time=1024; VFR MP4 end=1.958 with last packet start=1.9166667; trimmed/preroll MOV end=1.083 with last start=1.0416667. Short-edit MP4 declares end=1.0 but still exposes packet starts through 1.9583333 and must return unknown. Do not claim arbitrary ISO edit support.

## Resource caps and isolation

Enforce these fixed limits, not user-authored media configuration:

- Blob admission: 100 MiB (in addition to existing aggregate archive limit).
- Source cache: 2 MiB, prefetchProfile none.
- Each app source read: at most 8 MiB.
- Cumulative requested source bytes, including rereads and edit-gate reads: 100 MiB.
- Source read callbacks: 8192.
- Metadata packets: 200000 per file.
- Retained starts+ends arrays: 16 MiB total per playback controller, reserved before caching; one index is at most 3.2 MiB at the packet cap.
- Metadata worker concurrency: one active job; at most 16 queued jobs. Excess work returns worker-budget rather than an unbounded queue.
- Per active worker job deadline: 10000 ms. Terminate on timeout, abort, completion, and disposal. Dispose Input in normal/error finally paths.

These bound admitted input, app reads, enumeration, retained output, concurrency, and caller wait. They do not establish a hard JavaScript heap quota. In 1.62.0 CustomSource may allocate a requested Uint8Array before invoking our read callback, and Matroska can read a whole declared cluster before packet iteration. The worker protects UI responsiveness and is terminable; it cannot promise the renderer will survive every dependency OOM. Do not describe 2 MiB cache or 8 MiB callbacks as a total parser-memory ceiling.

## B: decoder integration, unchanged source semantics

Keep the previously settled strict-negative correction: use compareRationalTimes(source_time, zero at the same rate), withhold only truly negative/missing-handles, and normalize only a negative value comparing equal to zero in decoder-local state. Positive audio remains exact.

Replace videoDecoderTime's source-unit floor/midpoint with an upper-bound search on certified window starts. Compare PTS boundaries in the source rational's units using the existing comparison relation, without treating those units as FPS. Check the selected window's end as well. Seek to start+(end-start)/2 only when the source sample belongs to that certified window. An uncovered/unknown sample seeks exact normalized source seconds and emits visible invalid-timing; never source-grid midpoint fallback.

Cache one timing promise per canonical bundle path. Preserve occurrence-specific decoders. Reserve retained index bytes before storing arrays. Abort scans when playback disposes, and keep stale-result handling. Original source_time objects, source spans, anchors, and audio samples stay unchanged.

## A: exact ownership and distribution

A alone owns viewer/package.json and bun.lock. Pin mediabunny exactly to 1.62.0. New reader bridge, worker/scanner, narrow edit guard, reader/worker tests, viewer build.ts, shell-budget test, and a scoped public third-party notice/license asset are also A's files.

Use the actual existing manual-worker asset convention: build a separate self-contained browser worker entry with Bun splitting false, emitted as /assets/otio-video-timing-worker.js. Main viewer build keeps main.ts splitting true. Import Mediabunny only in that worker, not in the bridge or eager shell. Keep it out of the shell service-worker precache. Public viewer asset hosting and the full PATH use generic dist assets; no cover-asset allowlist expansion is needed because cover/kinds.ts has no OTIO/playback import.

License compliance: build.ts must copy the installed package's complete LICENSE to dist/mediabunny-license.txt. The worker build must add an explicit preserved banner carrying attribution, installed exact version, /assets/mediabunny-license.txt, and the exact unmodified source tarball URL. This banner and the license file must remain in the actually distributed dist assets after minification. A repository-only note is insufficient. Read the installed package version when generating the banner so it cannot silently drift from package.json/lock. Keep upstream source unmodified. No broad license refactor.

Strengthen the existing shell gate (450 KiB plus existing separation checks) to verify the demuxer lives in the worker asset and is absent from viewer.js/initial requests. Do not assume Bun auto-bundles new Worker(new URL(...)); the repo currently copies/builds worker assets explicitly. The custom research browser entry was 433901 bytes unminified, so eager inclusion is unacceptable; this number is not a production shell measurement.

## C: permanent proof additions

Keep all original PATH/no-mail cases and the original three-pixel MP4 expectations unchanged. Add minimal ordinary MP4, MOV, B-frame, WebM, VFR packet-window cases, mixed source units, and near-zero cases. Required negative controls:

- Single shortened rate-1 edit: reader unknown edit-window-mismatch, despite zero library warnings; no guessed frame target.
- Multi-edit and media-rate-2 files: warning captured and reader unknown.
- No-DefaultDuration/BlockDuration WebM: ordinary prior windows known; final duration zero means no certified final window.
- Cap, timeout, abort, duplicate-PTS, and unknown-container behavior.
- Decoder metadata scan does no external media requests or WebCodecs decoding.
- Known ordinary files must produce known windows; universal diagnostic fallback fails acceptance.

All new expected encoded-frame/window assertions must derive from independent ffprobe packet/frame timestamps, never from Mediabunny itself or ideal-FPS ordinals. The WebM quantization case is a required discriminating control. If an unchanged original assertion conflicts with that ground truth, report the exact conflict before changing its oracle. Do not re-pin snapshots or alter rational samples to hide it.

A/B/C remain independent against this contract. Workers skip tests/builds/lint/formatters mid-flight. Main runs the full verification and unchanged PATH after integration, including the original falsifications already established by Main.

## Evidence and recovery

Original probe receipt: 7c2e7fc4d6b032d68d961d6ca47a82b4bdc1a513 on remote branch probe/otio-decoder-boundary-evidence.

Published-package API, generated real-byte edit/VFR fixtures, browser results, and independent ffprobe packet capture were pushed in 5b1833c. The follow-up preservation commit includes this amendment, exact fetch/repro commands, and the no-duration case. No product files, downloaded dependency source, generated JS bundles, native artifacts, credentials, or private media belong in the proof branch.

The released API and counterexamples were exercised in headless Chrome/156.0.8078.47. The proposed production worker bridge and edit-safety gate have not been implemented or verified in this investigation; A's permanent tests and the integrated PATH must supply that proof.


## Reproduce the released-library characterization

From the evidence branch repository root:

```sh
probe/demux-fetch.sh
probe/gen-media.sh
probe/demux-gen-media.sh
python3 probe/demux-edit-fixtures.py
python3 probe/demux-ffprobe.py
mise exec -- bun probe/mediabunny-run.ts
```

The fetch step verifies the immutable tarball's SHA256 and extracts it under ignored probe/vendor-scratch. It runs no package lifecycle scripts. The custom browser entry is bundled in memory, then executes the published library in a fresh headless Chrome over a loopback-only page and local Blob sources. The library does no codec decoding; the separate native HTML video element is used only to observe which encoded frame a candidate seek displayed. All generated media are synthetic frame-index patterns.

Key observed results in probe/mediabunny-results.json: all returned packets have dataBytes=0 and metadataOnly=true; all Input sources report disposed=true; generated MP4/MOV require six app source reads, generated WebM sixteen. Known packet-window midpoint seeks display the indexed frames for ordinary MP4, MOV/B-frames, WebM and VFR probes. Unsupported multi/rate edits emit Logging warnings but continue. The shortened single edit emits no warning and silently disagrees with Chrome beyond its end. Removing WebM DefaultDuration yields a final reported duration of zero and no certified final interval in the probe.

The research entry's unminified bundle size is only a scoped measurement, not a product-build or shell-budget result. Repository build/test/lint/formatter verification remains Main's responsibility after integration.
