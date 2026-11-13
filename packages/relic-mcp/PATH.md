# relic-mcp entry paths

## Source versioning

Run from the repository root:

```bash
bun packages/relic-mcp/test/source-versioning-path.ts
```

The command creates two worktrees of one temporary Git repository, publishes
from the first through `relic_publish`, then starts fresh MCP processes for
`relic_lookup_source` and the refused second `relic_publish` from the other
worktree. Success ends with:

```text
PUBLISHED relic_id=<id>
PUBLISH_DISCLOSURE Anyone holding a relic's link can fetch every version it has ever held, so republishing does not withdraw earlier content.
FRESH_LOOKUP relic_id=<same-id>
REFUSED code=source_already_published relic_id=<same-id>
SOURCE_VERSIONING_PATH_OK
```

## Comments an agent can read and write

Run from the repository root:

```bash
bun packages/relic-mcp/test/comment-path.ts
```

The command starts a loopback HTTP service standing in for Relic, publishes a
file, then starts fresh MCP processes for `relic_comment` and
`relic_read_comments`, so the read happens in a process holding nothing but the
state file on disk. It also asserts what the service stored is ciphertext, and
that a relic this machine never published and a share URL are both refused.
Success ends with:

```text
PUBLISHED relic_id=<id>
COMMENTED comment_id=c1 author=publisher
STORED_CIPHERTEXT <prefix>... (<n> chars, contains_plaintext=false)
READ_BACK count=1 author=publisher body="The second chart still uses last quarter numbers."
REFUSED_ELSEWHERE code=no_local_publish_state
REFUSED_URL_ARGUMENT code=no_local_publish_state
COMMENT_PATH_OK
```

## Built Node stdio EOF lifecycle

Build the MCP bundle, then run the focused loopback probe from the repository
root:

```bash
mise exec -- bun run --cwd packages/relic-mcp build
mise exec -- bun packages/relic-mcp/test/stdio-eof-path.ts
```

The probe seeds an encrypted comment in `MemoryStore` with `MemoryStorage` and
a captured mail sink, then launches a fresh Node process with
`node --import test/fixtures/stdio-eof-tap.mjs dist/relic-mcp.js`. It uses the
same immediate `stdin.write(requestLine); stdin.end();` sequence as the OTIO
path. The loopback comments GET remains unresolved until both physical stdin
EOF and the accepted GET have been observed. They may arrive in either order.

The request must be delivered byte-for-byte, the held GET must release, and a
matching JSON-RPC response must decrypt the known comment nonce before child
exit 0 counts as success. The scratch trace records only process IDs, event
ordering, byte lengths, and hashes. The service, state, storage, mail sink,
and child all belong to the probe's loopback scratch state.

Run the explicit loss falsifier with:

```bash
RELIC_STDIO_EOF_SUPPRESS_RESPONSE=1 mise exec -- bun packages/relic-mcp/test/stdio-eof-path.ts
```

That command must fail. It arms a scratch-only marker after the gated GET is
accepted. Once its held response is released, the preload suppresses the
otherwise matching stdout response. A zero child exit is not accepted without
that response.

The tap is an instrumented witness, not timing-neutral proof of an
uninstrumented empty-output report. Its synchronous trace and stdout callback
alter child scheduling. A passing control therefore does not identify or fix
the original cause.

## Finding and editing a relic whose source was never recorded

Run from the repository root:

```bash
bun packages/relic-mcp/test/inventory-path.ts
```

The command starts a loopback HTTP service standing in for Relic, publishes a
file, then strips the recorded entry back to the three fields a client older
than this one wrote and deletes the source file, which is the shape most of a
long-lived state file is in. Every step after that runs in a fresh MCP process
holding nothing but the state file: `relic_list` recovers the name by
decrypting the relic's first record, `relic_show` returns what the link
currently serves, `relic_republish` replaces it, and a second `relic_show`
proves the URL never changed. No URL is printed, because the fragment is the
key. Success ends with:

```text
SEEDED_LEGACY relic_id=<id> source_recorded=false
LISTED relic_id=<id> filename=quarterly-review.md basis=envelope findable_by_source=0
RECOVERED_BY_RANGE bytes=0-65556
READ_BACK versions=1 bytes=31
REPUBLISHED version=2
SAME_URL_NEW_CONTENT versions=2 url_unchanged=true
RELISTED opens_spent=0
NO_TOKEN_IN_OUTPUT true
INVENTORY_PATH_OK
```

## The unfurl card a pasted link produces

Run from the repository root, after `bun run --cwd packages/relic-viewer build`:

```bash
bun packages/relic-mcp/test/unfurl-card-path.ts
```

The command puts the real app server on a loopback socket serving the real
built viewer assets, publishes through `relic_publish` with no title argument
so the filename becomes the title, and reads the served head over HTTP. When
cover rendering is skipped (e.g. when no local browser is available) or
explicitly declined with `cover: false`, link previews fall back to the
constant card `card.v1.png`. The command exercises this fallback path.

It asserts the Open Graph and Twitter block lands after the character-set
declaration and before the first `link` or `script` tag, because an unfurler
range-fetches the head and metadata outside that range produces no card at
It also asserts that the card reveals the relic's coarse renderer class
across renderable, playable (`media`, `otio`), and download-only types,
catching description drift between browser, played, and download tails and
proving the class reaches the card even when the publisher declines a title.
It catches false download claims on audio, video, and timeline relics by
asserting that media and otio relics carry the played tail.
title and `cover: false`, proves the name reaches no field on the relic row,
fetches the card image and reads 1200x630 out of its PNG header, and confirms
neither shell fetch spent an open.
Success ends with:

```text
PUBLISHED relic_id=<id> title=quarterly-review.md
HEAD_ORDER charset=<n> og=<n> twitter=<n> title=<n> link=<n> script=<n>
CARD_TITLE og:title=quarterly-review.md title=… · Relic
CARD_DESCRIPTION class=markdown tail=browser
DECLINED relic_id=<id> row_title=absent card=A Markdown relic
ARCHIVE_CARD class=archive tail=download title=An archive relic
MEDIA_CARD class=media tail=plays title=A media relic
CARD_IMAGE bytes=<n> dimensions=1200x630 cache=immutable
NO_MINT opens_spent=0 mint_log=0
UNFURL_CARD_PATH_OK
```

## The cover a pasted link shows

Run from the repository root, after building viewer and MCP:

```bash
bun run --cwd packages/relic-viewer build
bun run --cwd packages/relic-mcp build
bun packages/relic-mcp/test/cover-path.ts
```

Set `RELIC_COVER_PATH_ARTIFACTS=<dir>` to write every retrieved cover raster to
a local folder for visual comparison against `mockup.html`.

The command puts the real app server on a loopback listener with `MemoryStore`
and `MemoryStorage`, serving real built viewer assets. Every publish and
republish runs through a fresh `node packages/relic-mcp/dist/relic-mcp.js` stdio
process, exercising the packaged bundle, cover asset resolution, and the Node
runtime. It generates scratch fixtures across every renderer class (Markdown,
code, HTML, SVG, JSX, PNG, PDF, video, audio waveforms, audio artwork, ZIP, and
TAR.GZ), plus unlisted archives and raw binaries.

For each renderable class, it verifies the cover is uploaded and validated at
1200x630, the served HTML shell points `og:image` and `twitter:image` at the
cover URL, and the cover route serves 200 with the exact required cache, CSP,
and security headers. For unlisted archives and raw binaries, it proves the
render is skipped with the exact documented reason and `og:image` falls back to
`card.v1.png`.

It also verifies:
- The `cover: false` publication leaves no cover object in the store and serves
  the fallback card.
- A republish with new content uploads a new cover and renders the old cover
  URL 404.
- An identical-content republish with `cover: false` removes the cover, clearing
  the store and reverting `og:image` to the fallback card.
- Operator takedown (`DELETE /api/relics/{id}`) deletes the cover objects and
  renders the cover URL 404.
- Expiration stops serving the cover when time advances past TTL.
- Zero mints are consumed by cover or shell requests.
- The loopback HTTP and UDP egress collector receives zero packets from the
  sandboxed renderer.

Success ends with:

```text
COVER kind=<kind> status=<status> bytes=<n>
...
COVER_EGRESS arrivals=0
COVER_PATH_OK classes=<n>
```

## Covers on the live service

Run from the repository root:

```bash
bun packages/relic-mcp/test/cover-live-probe.ts
```

The probe exercises cover uploads and lifecycle against a live deployment. It
respects `RELIC_SERVICE_ORIGIN` (defaulting to `https://relik.link`), optional
`RELIC_CHROME_PATH`, and `RELIC_COVER_PROBE_CLIENT` (`'source'` or
`'npx:<version>'`).

It publishes a small Markdown fixture with 1-day TTL, an empty title, and the
probe client name. It asserts that the cover uploads, the live `og:image` points
to the cover URL, and GET returns 200 with exact headers at 1200x630. It then
republishes changed content with `cover: false` and confirms that the old cover
URL returns 404 and `og:image` reverts to `card.v1.png`. The share URL is never
printed, because the fragment contains the encryption key.

Success ends with:

```text
COVER_LIVE_OK relic_id=<id>
```

## Change emails and sharing

Run from the repository root:

```bash
RELIC_CHROME_PATH=none bun packages/relic-mcp/test/notify-path.ts
```

The command puts the app server on loopback with `MemoryStore` and `MemoryStorage`,
capturing email sends. Every tool call runs as a fresh stdio process. It exercises
the full change notification and sharing lifecycle: publishing a relic with
its derived `share_verifier`, posting a comment, sharing to recipient email addresses,
republishing with change notices, exercising the one-click unsubscribe stop link,
verifying opted-out recipients are skipped on subsequent republishes, verifying
`notify: false` suppresses change notices, a second reader's comment emailing
everyone still following except its author, a publisher comment collapsed by the
10-minute limit for people just emailed, demonstrating unlanded republishes send
zero notices, and cleaning up via operator delete.

Success ends with:

```text
PUBLISHED relic_id=<id>
SHARE_VERIFIER stored=true
SHARED registered=2 link_has_fragment=true
CHANGE_NOTICES version=2 recipients=3 keyless=true list_unsubscribe=true reader_mails=1
STOPPED get=200 post=200 redirect=false
CHANGE_NOTICES version=3 recipients=2 opted_out_skipped=1
NOTIFY_FALSE version=4 recipients=0
COMMENT_NOTICES recipients=2 names_commenter=true keyless=true
PUBLISHER_COMMENT recipients=1 collapsed=2
UNLANDED recipients=0
DELETED shares_deleted=2 opt_outs_deleted=1
NOTIFY_PATH_OK
```

## Copy link and the key phrase

A reader on any relic presses Copy link, sees the link and its 12-word key phrase, and copies either one; a person sent the link without the key and told the phrase opens the relic.

Run from the repository root:

```bash
mise exec -- bun packages/relic-mcp/test/copy-link-path.ts
```

`RELIC_PROOF_CHROME_PATH` chooses the browser; on a workstation, point it at a `chrome-headless-shell` binary (e.g. `~/Library/Caches/ms-playwright/chromium_headless_shell-<n>/chrome-headless-shell-mac-arm64/chrome-headless-shell`); without it the script starts the first installed Chrome it finds; a run that has not finished after 120 seconds stops with `COPY_LINK_PATH_TIMEOUT`, the step it was on, and the CDP calls still waiting.

Output ends:

```text
COPY_LINK_PATH_OK
```
## Change emails on the live service

Run from the repository root:

```bash
RELIC_NOTIFY_PROBE_TO=a@example.com,b@example.com bun packages/relic-mcp/test/notify-live-probe.ts
```

The probe exercises change notices and sharing against a live service deployment.
It reads recipient addresses from `RELIC_NOTIFY_PROBE_TO` and respects
`RELIC_SERVICE_ORIGIN` (defaulting to `https://relik.link`),
`RELIC_NOTIFY_PROBE_CLIENT` (`'source'` or `'npx:<version>'`), and
`RELIC_NOTIFY_PROBE_PHASE` (`'send'`, `'after-stop'`, or `'quiet'`).

It publishes a fixture with a 1-day TTL, an empty title, and `cover: false`, shares
to the recipients, republishes, and verifies change notices.

Success for phase 1 ends with:

```text
PROBE relic_id=<id> version=2
```

## Loading phases and the first-record key check

Run the local headless proof across every class and network condition:

```bash
mise exec -- bun packages/relic-mcp/test/load-progress-path.ts
```

A reader opening any relic link on a slow connection sees the Relik bar and a named phase, with bytes against the total, from the first painted frame until the content appears. A link whose key does not open the relic stops downloading after the first block and says the relic could not be opened. A relic whose start decrypts but whose later blocks fail says the link is fine and the stored file is damaged.

At startup, the proof launches an isolated headless Chrome instance over `--remote-debugging-pipe`, with software WebGL enabled for model fixtures. It publishes fixtures through the client and serves storage through a throttled stream. It checks loading, early cancellation, damage handling, model rendering, and interactive model controls.

Success ends with:

```text
LOAD_PROGRESS_PATH_OK fixtures=<n> runs=<n>
```

## Loading on the live service

Run the live service loading probe against production or a designated origin:

```bash
RELIC_LOAD_PROBE_CONFIRM=publish-one-1-day-relic \
  mise exec -- bun packages/relic-mcp/test/load-live-probe.ts
```

To run against a local loopback server with `MemoryStore` and `MemoryStorage`:

```bash
RELIC_LOAD_PROBE_CONFIRM=publish-one-1-day-relic \
RELIC_SERVICE_ORIGIN=loopback \
  mise exec -- bun packages/relic-mcp/test/load-live-probe.ts
```

The probe verifies progress indications and early cancellation against a live deployment or local loopback service.
It requires `RELIC_LOAD_PROBE_CONFIRM=publish-one-1-day-relic` to prevent unprompted writes,
publishes exactly one 1-day, untitled relic with `cover: false`, and tests:
1. Throttled valid open (1440x900 light): asserts the no-blank rule, phases in order through ready, at least five distinct `aria-valuenow` values, storage data received events spanning at least 2 seconds, and complete transfer (`encodedDataLength >= object_length`).
2. Wrong key (one character changed): asserts the could-not-be-opened card appears within 30 seconds, storage request ends in `Network.loadingFailed` with `canceled: true`, `cancel_bytes` is at most 1,048,576 bytes and below `object_length / 4`, and no `dataReceived` arrives in the 5 seconds after the card appears.
3. Mobile viewport (390x844 dark): asserts the no-blank rule, no horizontal overflow (`scrollWidth <= innerWidth`), and renders ready.

Optionally set `RELIC_LOAD_PROOF_DIR=<dir>` to write `receipt.json` and captured screenshots (`01-progress.png`, `01-ready.png`, `02-wrong-key-card.png`, `03-mobile-dark-ready.png`).

It never prints the share URL or key. Every reported value in the output comes directly from measurements taken during execution. Success ends with:

```text
LOAD_LIVE_OK relic_id=<id> progress_steps=<n> cancel_bytes=<n> object_length=<n>
```

## OpenTimelineIO end-to-end path

Run the full source proof from the repository root with an explicit Chrome:

```bash
RELIC_OTIO_PATH_CLIENT=source \
RELIC_OTIO_CHROME_PATH="$(command -v google-chrome)" \
env -u DISPLAY -u WAYLAND_DISPLAY \
  bun packages/relic-mcp/test/otio-path.ts
```
The viewer and MCP bundles must be built first. Set `RELIC_OTIO_SHOTS_DIR` to
a writable directory to retain the viewport screenshots and
`otio-layout-*-measurements.json` receipts. The layout matrix measures
1440x900, 1440x600, 390x900, 390x568, 320x900, and 320x480 in both color
schemes, including open and closed mobile inspectors and the blocked preview.
The full path retains its playback, comment, exact-marker reveal, and revision
checks and ends with `OTIO_PATH_OK`.

To run only the initial layout matrix through the same published loopback
fixture, add `RELIC_OTIO_LAYOUT_ONLY=1`; success prints `OTIO_LAYOUT_OK`, not
`OTIO_PATH_OK`. To falsify the bottom-fill check, point `RELIC_VIEWER_DIST`
at a separately built unmodified baseline viewer bundle and run the same
layout-only command. It must fail with `bottom fill`; inspect the saved receipt
and screenshot rather than treating an arbitrary error as a successful
negative control. This mode still requires the normal fixture and oracle
prerequisites.


At startup, the locally owned browser reports its actual command line through
`Browser.getBrowserCommandLine`. The proof accepts only one observed approved
headless switch matching the launched switch, the fresh `--user-data-dir`,
`--remote-debugging-pipe`, and `--enable-automation`, with no remote-debugging
port. Product text and the executable pathname are diagnostic information, not
mode proof.

Use the focused positive control with the same source mode and browser:

```bash
RELIC_OTIO_PATH_CLIENT=source \
RELIC_OTIO_CHROME_PATH="$(command -v google-chrome)" \
env -u DISPLAY -u WAYLAND_DISPLAY \
  bun packages/relic-mcp/test/otio-browser-controls.ts --smoke
```

It ends with `OTIO_HEADLESS_SMOKE_OK`. On Linux, use the negative control under
Xvfb to require both the headed and profile-mismatch rejections before a review
target is created or navigated:

```bash
RELIC_OTIO_PATH_CLIENT=source \
RELIC_OTIO_CHROME_PATH="$(command -v google-chrome)" \
xvfb-run -a bun packages/relic-mcp/test/otio-browser-controls.ts --negative-source
```

It ends with `OTIO_HEADED_REJECTED` and `OTIO_PROFILE_MISMATCH_REJECTED`.

The full command starts a service on loopback with `MemoryStore` and
`MemoryStorage`, serving real built viewer assets. Every MCP operation runs
through a fresh Node stdio process.

It exercises:
1. Publishing a standard `.otiod` directory bundle through real MCP stdio, verifying automated packaging into a deterministic standard `.otioz` archive.
2. Inspecting stored ciphertext and decrypting locally.
3. Verifying archive layout against the official OpenTimelineIO specification (`content.otio` DEFLATE, `version.txt` 1.0.0 DEFLATE, and referenced media STORED).
4. Opening the returned link in a fresh headless browser.
5. Exercising transport, playback, and seeking, measuring decoded video frames and audio contributions.
6. Selecting track-specific points and ranges in the viewer UI and submitting encrypted feedback.
7. Confirming server storage rows contain only opaque ciphertext, with no track IDs, time ranges, or source paths in the clear.
8. Reading feedback via a fresh MCP process with `version: "*"` and `resolve_anchors: true`.
9. Asserting exact rational time coordinates and original source context mapping.
10. Republishing a revision and verifying safe current projection alongside immutable historical anchors.
11. Verifying ambiguous revisions produce explicit ambiguous diagnostics rather than false mappings.

Success ends with:

```text
OTIO_PATH_OK
```

### The two slices CI runs

`RELIC_OTIO_PATH_SCOPE` runs one slice of the path, and each slice accounts for exactly its own stages. Neither slice prints `OTIO_PATH_OK`.

```bash
RELIC_OTIO_PATH_SCOPE=without-scheduled-audio \
RELIC_OTIO_PATH_CLIENT=source \
RELIC_OTIO_CHROME_PATH="$(command -v google-chrome)" \
env -u DISPLAY -u WAYLAND_DISPLAY \
  bun packages/relic-mcp/test/otio-path.ts
```

ends with `OTIO_PATH_WITHOUT_SCHEDULED_AUDIO_OK`. It is every stage except the legacy scheduled-audio ones. `verify.yml` runs it, and `verify.yml` gates a merge and a deploy.

```bash
RELIC_OTIO_PATH_SCOPE=scheduled-audio \
RELIC_OTIO_PATH_CLIENT=source \
RELIC_OTIO_CHROME_PATH="$(command -v google-chrome)" \
env -u DISPLAY -u WAYLAND_DISPLAY \
  bun packages/relic-mcp/test/otio-path.ts
```

ends with `OTIO_SCHEDULED_AUDIO_OK`. It is the legacy scheduled-audio stages: native compatibility, scheduled PCM at 48 kHz and 44.1 kHz, the 60 fps cold start, the restart during start, and the boundary fixture's audio captures. `otio-scheduled-audio.yml` runs it on every pull request and on the pushes that deploy, as a separate run that uploads its receipts (`otio-scheduled-audio-linux`) and that nothing depends on.

Jason decided this split on 2026-11-13 (`docs/decisions.md`). Those stages hold a legacy archive's scheduled playback to millisecond budgets, and a shared runner interrupts that playback within a minute of almost every attempt: 8 of 8 parallel lanes failed, from different timing causes, in diagnostic run 43383354503. A red `otio-scheduled-audio` run says the stages did not pass on that runner. Read its receipts before rerunning it, and do not treat it as evidence of a regression until they show a failure that is not the runner interrupting playback.

Three rules apply inside that slice. A stage in which the viewer itself reports an interruption, with nothing injected by the proof, reruns in a fresh browser up to three times and keeps each trace; a stage interrupted on every attempt fails. The 50 ms p95 presentation budget is compared in display refreshes, so a frame held three refreshes (50.0 ms at 60 Hz) meets it and four refreshes (66.7 ms) exceed it; the 100 ms maximum is raw milliseconds. Scheduled 60 fps playback is not proven: the viewer falls back to native audio there, and the stage asserts that.

## Rendered OpenTimelineIO program

The publisher and viewer paths are implemented on PR 155. Release requires the checks below, including current-revision playback proof. The `OTIO_PATH_OK` run above covers legacy composition playback, not program rendering.

Publishing a timeline must produce an archive that `format.md` 3.19 requires. Each of the following must hold.

**Contents.** The archive contains `relic/program.json` and one MP4 per rendered timeline outside `content.otio`. The manifest is present on every archive published under this path.

**Identity.** `content.otio`, `document_sha256`, and `relic_version` are unchanged from the composition path.

**Size.** The plaintext archive fits within 500 MiB. Manifest and program bytes have a separate 100 MiB bound. The current renderer uses one 1280x720 output; the proposed resolution ladder is not implemented.

**Reasons.** Every timeline that cannot be rendered records a specific code and reason. No approximate render is stored.

The proof must check each of these before this section's status changes.

**Check 1, decoding.** Each MP4 is decoded independently. Frame count, timestamps, audio length, and start alignment match the timeline.

**Check 2, reference match.** Rendered frames and audio match independently prepared references made from the source media. The method and tolerance are fixed in the proof before it runs.

**Check 3, refusal.** The viewer refuses a program on any failed check (schema, document digest, file hash, size, timing, or browser support) and shows focus-only with the reason.

**Check 4, legacy and corrupt manifests.** Remove the manifest from one archive and confirm it plays as before. Flip one byte in the manifest and in one MP4 of another archive and confirm focus-only, never legacy playback.

**Check 5, focus-only reasons.** An unsupported effect or transition, an oversized archive, a missing local Chrome, and a browser without H.264/AAC encoding each produce an unavailable timeline with its matching reason: `unsupported-effect` or `unsupported-transition`, `size-cap-exceeded`, `unsupported-browser`, and `encoder-unavailable`. A Linux publisher without H.264/AAC is focus-only under Jason's rule. A focus-only archive never contains a whole-timeline composite.

**Check 6, budgets.** Cold and warm startup within 350 ms. Steady presentation p95 within 50 ms with a 100 ms maximum gap. Source-aware audio dropout within 20 ms. Failures are reported as failures.

**Check 7, comments.** A comment anchored on a program-bearing timeline still decrypts and resolves against `content.otio`.

**Check 8, isolation and disk.** The render page runs with networking disabled and a temporary profile. The probe records that run's network activity, and it fails if any rendered frame or audio byte is written to a file or to browser storage. This is an absolute constraint, shared with `publish.md` 4.8.

**Check 9, legacy readers (agent-run).** Build the viewer from the revision before the program change, and open two archives with it. A legacy archive must open exactly as it did before. A program-bearing archive from the new publisher must either open its `content.otio` as before or refuse with a clear error, and it must never render a partial program. The proof output records the result. A failure blocks release of program archives until it passes. No human decision is needed: the agent runs the check and fixes what it finds.

No command for this section exists yet. When one exists, add it here with its exact success line. Change this section's status only after that command has passed at the revision being shipped.

## Primer for the rendered program's first Play

Run from the repository root with an owned headless shell. The proof never falls back to an installed Chrome, so the variable is required:

```bash
RELIC_OTIO_CHROME_PATH=<path to chrome-headless-shell> \
  mise exec -- bun packages/relic-mcp/test/otio-program-path.ts
```

Success ends with `OTIO_PROGRAM_PATH_OK` and no `OTIO_PROGRAM_DEFERRED_FAILURES`. Each trial is a fresh browser. Before navigation, two OS readings 250 ms apart must both read the default output idle on the same device, or the trial fails with `external audio before navigation`. The trace starts on `about:blank` and writes its start mark before navigation, so preload is inside the trace. There is no fixed gap between trials. Every trial runs with Chrome's `--mute-audio`, so nothing reaches a speaker. The proof runs on this Mac only and is not in CI.

The primer groups measure what the browser and the OS report. Presented frames come from `requestVideoFrameCallback`, with the element clock and the frame's timing metadata beside each frame. Device starts (`OutputController::Play`) come from Chrome's trace and are the gated count. Stream creation (`AudioOutputDevice::Start`, `CreateStream`) and device callbacks (`AUHALStream::Render`) are telemetry: they show what Chrome's output thread did and never prove an audio gap. The default output's running flag comes from the OS, read by `otio-device-running.swift` through `otio-program-device-state.ts`, and is not an audio tap. A trusted pointerdown writes a `performance.mark`, which ties the page clock to the trace clock. No audio tap is attached to any video measurement.

The budgets are the user's acceptance and are not loosened:
- The first new frame within 350 ms of a trusted Play, including the first-click Play. The first new frame is the first presented frame one program frame past the frame shown at the Play, so a frame that only repeats the resting frame does not count.
- No gap between presented frames over 100 ms, and p95 within 50 ms, over the 4 s after Play. The gaps judged are those between presented frames inside the window, plus the two edge gaps. The leading edge is the gap from the window start to the first presented frame when a frame came earlier. The trailing edge is the gap from the last presented frame to the end of the 4 s window, so a stall that runs to the window end fails. The start before the first presented frame is the 350 ms startup budget, not a gap. A freeze inside the window shows as a gap, and media time moving backward fails.
- Audio is not judged from callbacks. The 20 ms audio budget is proven only by the sampled audio arms below.
  The samples come from the program renderer before the mixer and device; they do not prove speaker output.
- Zero device starts after a prepared or unmute Play, because the primer's output is reused. First-click has exactly one device start after its Play, shared by the primer and the program.

Control arms must fail the way the hypothesis predicts, or the pass means nothing. Only sequence L labels trials cold. After metadata the output must first run, within 3 s, then read idle on two consecutive polls, within 30 s of load. The trial then holds 600 ms of quiet and reads the OS again. A trial is cold only when that pattern was met, the trace shows no device activity in the 500 ms before its first trusted event, and the OS reads the default output idle at that event. Any other trial is warm, absent or unproven and does not count. The cold label rests on the device-start mechanism, which the proof asserts directly. Each cold trial of bare `none`, bare `sham` and the viewer `sham` build must start the output after its Play, and the sham must not start it between Prepare and Play. The real prepared arm must start no device after its Play. Each of those groups needs at least three cold trials, and fewer is inconclusive, which fails. Each cold trial of bare `none` and `sham` must miss at least one program frame slot, with the trailing gap to the window end included. A presented gap misses a slot when it rounds to two or more program frames, which at 30 fps is 50 ms or more. The observed 66.8 ms cold gap misses one slot. A cold control without one did not fail the way the hypothesis predicts, and the stage fails. The viewer `sham` frame gaps remain telemetry, and nothing here claims a stall for them.

The arms:
- **Bare controls:** `none`, `sham`, `av` (real primer), `av-blob` (the same program loaded through a Blob URL whose SHA-256 is checked first), `audio-only`, `context` and `video-only`. `audio-only` and `context` are reported in sequence L and wait for the output pattern like every audio arm. `video-only` is the absent-audio control. It is a lossless remux of the program's video track with audio stripped. The proof checks that its video packets are identical to the source's, that the source has an audio stream and the control has none (ffprobe), and it fails the stage otherwise. In sequence L it has no output to wait for: the OS is read for 3 s after metadata, and any running reading fails it. Its trace must show no device start at all. Each arm runs Prepare, waits 1500 ms, then Play. Every bare page also runs a per-frame loop, lighter than the viewer's `tick` (which emits only on a frame change and enforces bounds), from the program's `play` event until `pause` or `end`. Each animation frame records its page time and writes `video.currentTime` into a non-media `<output>`. The loop only reads the media element. Every late bare trial fails when its window has no presented frame, no display tick or a tick gap over 100 ms, and when presentation time is missing. Late bare `av` and `av-blob` also fail when the window has fewer than 90 intervals, a program frame is dropped between presented frames, a presented gap misses a program frame slot (50 ms or more at 30 fps, with the trailing gap from the last presented frame to the window end included), or the presented span differs from the media span by 16.7 ms (half a program frame) or more over the window. The user's 350 ms first-frame, 50 ms p95 and 100 ms gap limits still gate these arms through the window gate on the frame callbacks. The bare presentation p95 and the share of frames in one display tick class are reported only and never gate. Cold `none` and `sham` are judged per trial by missed slots, as the control arms above describe. The detector and the cold comparator are checked on every proof by deterministic negative controls. Injected 150 ms and 300 ms stalls and an observed 66.8 ms gap must be measured as stalls, a healthy measured 38.9 ms gap must not, and a stall that runs to the window end must be measured. Synthetic windows with a missing tick, a stalled tick, a dropped frame, a stalled presentation, a presentation that stops before the window end, a held frame then catch-up, a slow program clock, too few frames, missing presentation time or no presented frame must be rejected. Judder inside one slot, measured healthy extremes, and cold windows with a 66.8 ms or 150 ms gap or one that stops early must be accepted per trial. Pools in which every cold trial missed a slot must be accepted. Pools with one trial that missed no slot, a trial without presentation evidence or a trial that presented no frame must be rejected. Each failure fails its stage.
- **Viewer prepared:** a trusted click on the Markers inspector tab, the primer running within 3 s, then a trusted Play. Sequence L gates it as a cold trial. Sequence F gates it as a fresh visit.
- **Viewer sham:** the same script on the sham build, where the primer's `element.muted = false;` is `true`. The sham is trusted only if three checks pass. The source transform changes exactly one line of `otio-audio-output.ts`, that primer mute line, verified against the original. The bundle diff, with each hashed chunk name normalised, finds exactly one byte difference in the built output, and it is the `.muted=!1` to `.muted=!0` site. Negative controls must be rejected: production against itself, and a one-byte tamper of either side. Each arm is served from its own complete build directory, switched whole, and each trial records which build answered its JavaScript requests. A trial whose requests came from any other build fails. Production and VIEWER_DIST are never written to.
- **Viewer first-click:** a trusted Play only. In sequence L, Buffering must show before the first new frame, and exactly one device start after the Play must occur, shared by the primer and the program. In sequence F the user budgets are gated, and Buffering and the device-start count are reported.
- **Viewer unmute:** Mute (`button.otio-program-mute`, which toggles `aria-pressed`), primer running, Play, then Unmute after 1.5 s on the same control. `aria-pressed` must go true after the first click and false after the second. Presented gaps must stay within 100 ms from 500 ms before to 2000 ms after Unmute, over at least 40 intervals, including the gap from the last presented frame to the window end and the gap from the window start to the first frame inside it, so a stall that runs in from the start or out to the end fails. `muted` must be false within 1 s. Both sequences gate it.
- **Wrap checks:** the primer alone for 12 s, with and without `AudioRendererMixerImmediatePause`, in sequence L. Exactly one device start (`OutputController::Play`) must occur after Prepare, with a covered quiet window.
- **Sequence F, fresh visit (`fresh-viewer-*` and `fresh-reported`):** the viewer arms run once the viewer enables Play: the program's metadata has loaded, its playback session is ready, and the Play button is not disabled. The proof waits for that enabled state, not for metadata, before any trusted event, in sequence L as well. There is no separate wait for the output device. The user budgets are gated on prepared, first-click and unmute. Sham and the bare arms are reported only. A failed pre-navigation check in any F trial fails `fresh-reported`.

Every trial also checks that the primer is `idle` before the first trusted event, that the program stays paused and unmoved until Play, and that the trace shows no device activity in the quiet window. The sham arms also fail when the muted primer starts the output between Prepare and Play. Clicks are hit-tested: a trusted click on an element that has no area or is covered by another element fails with `trusted click target not hittable`.

Each trusted mark must come before every playback-rate change and device Play in the 5 ms before it, except a zero rate that Chrome re-applies as the program's pipeline finishes starting, seeking or resuming.

The hidden leg runs once, on the sequence F prepared arm in round 0. It minimizes this viewer's own proof-owned browser window over CDP (`Browser.setWindowBounds` with `windowState: minimized`, found by `Browser.getWindowForTarget`), which hides the page, and restores the window to normal afterward. The proof logs visibility changes and primer changes on the viewer's own clock. It passes only when the viewer reads `hidden` after the minimize step, a visibility change to hidden is logged after it, and the primer reads `idle` within 1.5 s of that change. Activating a second tab or window, `Page.bringToFront`, a second browser context and focus emulation were each probed in an isolated headless shell and none hid the page, so they are not used. If the browser does not hide the viewer, the leg fails with `hidden leg unproven: <reason>`. `document.hidden` is never faked.

Failure strings a trial can report: `external audio before navigation`, `trace does not cover 500 ms before the first trusted event`, `output device activity before the first trusted event: <names>`, `page reacted before <mark> by <n> µs (<event>)`, `default output <name> running at the first trusted event`, `default output not running within 3 s after metadata`, `default output not quiet within 30 s of load`, `default output never ran after metadata`, `cold trial started no device after Play`, `video-only control: default output <name> ran with no audio track`, `video-only control started the output device <n> time(s)`, `video-only control has no trace start mark`, `sham started the output device before Play; control invalid`, `media time moved backward after the first new frame`, `no new frame after the trusted Play`, `<n> device start(s) after Play, expected <n>`, and `hidden leg unproven: <reason>`.

Each video trial writes a `clockDeficit` summary to its receipt: the wall gap between presented frames minus how far the element clock advanced. A frozen element clock over a long wall gap is marked as an element-clock stall. This is diagnostic and never gates.

**Sampled audio arms (stages 19 and 20):** the production viewer runs under an isolated, muted browser. The program audio track is read with `MediaStreamTrackProcessor` and paired in delivery order with that trial's Chrome renderer and mixer-input trace. The track timestamp is a pairing key, not a playout time. A missing render, unexplained chunk, trace loss, incomplete capture, or pre-gesture audible render fails the proof. Samples in the Play-to-stop window are aligned to an independent analytic reference at the resting media position. The unchanged gates require onset and silent gaps within 20 ms, the composition SNR bound, and no 20 ms window fault. Negative controls drop, repeat, zero, and retime chunks and move the Play mark; each must be rejected. An extra early-start trial must also be rejected. Receipts retain the gated samples and trace inputs for replay.

Not measured here: slower outputs such as Bluetooth or HDMI. On such a device the first-click start may exceed 350 ms, and the proof then fails. That is a result to report, not a bound to relax.

## Passkey-confirmed decisions

Run the full loopback proof from the repository root:

```bash
RELIC_CHROME_PATH="$(command -v google-chrome)" bun packages/relic-mcp/test/decision-path.ts
```

The command starts a service on loopback with `MemoryStore` and `MemoryStorage`,
serving built viewer assets. It binds 127.0.0.1 but browses with
`serviceOrigin = http://localhost:<port>` so WebAuthn RP ID checks pass.
Every MCP operation runs through a fresh Node stdio process with `title: ""`,
`cover: false`, and `ttl_days: 1`.

It exercises:
1. Publishing v1, republishing v2, and republishing v3, recording the v3 `version_digest`.
2. Opening the relic in headless Chrome over a CDP pipe with an attached virtual CTAP2 authenticator.
3. Requesting a sign-in magic link from the decisions panel, extracting it from the captured mailer, and following it in the same browser context.
4. Opening the decision panel, choosing Approve, completing trust-on-first-use (TOFU) passkey registration, and confirming the decision with a user-verified assertion.
5. Verifying check (a): `relic_read_decisions` for v3 returns the reader address, `approve`, and matching `version_digest`.
6. Verifying check (b): direct POST with `publish_token` is refused with 403 `decision_requires_reader`.
7. Verifying check (d): recording Reject on v3; read returns two records with the latest being `reject`.
8. Verifying check (c): republishing v4; v4 starts empty and v3 retains both decision records.
9. Verifying check (e): posting a reader comment and publisher `relic_comment` both reading "GREENLIGHT"; wildcard decisions readback remains 2.
10. Negative controls: posting a v2 digest for v3 gives 409 `decision_digest_mismatch`, a second authenticator with `isUserVerified: false` gives 403 `user_verified`, and replaying the captured assertion gives 403 `challenge`.

Success ends with:

```text
DECISION_A_OK version=3 verdict=approve author=<email>
DECISION_B_OK code=decision_requires_reader status=403
DECISION_D_OK count=2 latest=reject
DECISION_C_OK v4_count=0 v3_count=2
DECISION_E_OK total_decisions=2
DECISION_NEG_OK digest_mismatch=409 user_verified=403 challenge_replay=403
DECISION_FRESH_LINK_OK state=required orphans=0 link_sent=1
DECISION_PATH_OK
```

## Decisions on the live service

Run against the live deployment from the repository root:

```bash
RELIC_DECISION_PROBE_MAILBOX=user@example.com bun packages/relic-mcp/test/decision-live-probe.ts
```

The probe exercises passkey-confirmed decisions against a live service deployment (defaulting to `https://relik.link`).
It reads the base recipient address from `RELIC_DECISION_PROBE_MAILBOX` and derives a fresh per-run plus-addressed email `<local>+relic-decision-<runId>@<domain>`.
The probe refuses to run without a plus-tag, ensuring test passkeys never claim TOFU for a real mailbox.

It respects:
- `RELIC_SERVICE_ORIGIN`: destination service, defaults to `https://relik.link`
- `RELIC_DECISION_PROBE_CLIENT`: `'source'` or `'npx:<version>'` (defaults to `npx:0.14.0`)
- `RELIC_PUBLISH_STATE`: optional fixed state path (defaults to scratch)
- `RELIC_CHROME_PATH`: optional browser executable path

The probe prints `PROBE_AWAIT_MAGIC_LINK email=<addr>` and blocks on stdin. The operator retrieves the magic link from the destination mailbox and pastes it into stdin.
The probe never prints the relic URL or key. It executes all five checks and negative controls against the live service.

Success ends with:

```text
DECISION_A_OK version=3 verdict=approve author=<email>
DECISION_B_OK code=decision_requires_reader status=403
DECISION_D_OK count=2 latest=reject
DECISION_C_OK v4_count=0 v3_count=2
DECISION_E_OK total_decisions=2
DECISION_NEG_OK digest_mismatch=409 user_verified=403 challenge_replay=403
DECISION_FRESH_LINK_SKIPPED live
DECISION_LIVE_OK relic=<id> client=relic-mcp@<version>
```

## Email code sign-in

Run the full loopback proof from the repository root:

```bash
RELIC_CHROME_PATH="$(command -v google-chrome)" bun packages/relic-mcp/test/email-code-sign-in-path.ts
```

The command starts a service on loopback with `MemoryStore` and `MemoryStorage`,
serving built viewer assets. It exercises:
1. Publishing an initial document with title: "", cover: false, ttl_days: 1.
2. Requesting a sign-in email from the comment composer, capturing the mailed code and link, and verifying the email subject contains the 6-digit code.
3. Typing the code into the focused in-place input via CDP `Input.insertText`, verifying that zero navigations occur (`window.__relicCodeProofMarker` survives, `performance.timeOrigin` is unchanged, and zero main-frame `Page.frameNavigated` events fire), and asserting `[data-passkey-offer]` is shown.
4. Posting a comment through `textarea.compose-textarea` and "Post comment", and reading it back via `relic_read_comments` to verify author attribution.
5. Following the mailed magic link and verifying it answers 401 now that the code was used.
6. Negative controls over HTTP with manual cookie jar: wrong code, missing cookie, unknown request nonce, replaying spent code, using link first then code, exhausting address attempt budget (lockout), following link after code lockout, uniform 401 error body shape, and non-JSON content-type.

Success ends with:

```text
EMAIL_CODE_STEP_1_PUBLISH_OK relic_id=<id>
EMAIL_CODE_STEP_2_CODE_MAILED subject_has_code=true link_present=true
EMAIL_CODE_STEP_3_SIGNED_IN_IN_PLACE navigations=0 offer=shown
EMAIL_CODE_STEP_4_COMMENT_OK author=<address>
EMAIL_CODE_STEP_5_LINK_SPENT callback=401
EMAIL_CODE_NEG_OK wrong=401 no_cookie=401 unknown_request=401 replay=401 link_first=401 locked=401 link_after_lock=303 shape_equal=true wrong_content_type=400
EMAIL_CODE_SIGN_IN_PATH_OK
```

## Email code sign-in on the live service

Run against the live deployment from the repository root:

```bash
RELIC_EMAIL_CODE_PROBE_MAILBOX=user@example.com RELIC_CHROME_PATH="$(command -v google-chrome)" bun packages/relic-mcp/test/email-code-sign-in-live-probe.ts
```

The probe exercises email code sign-in against a live service deployment (defaulting to `https://relik.link`).
It reads the base recipient address from `RELIC_EMAIL_CODE_PROBE_MAILBOX` and derives a fresh per-run plus-addressed email `<local>+relic-code-<runId>@<domain>`.
The probe refuses to run without a plus-tag, ensuring test sign-ins use an isolated test address.

The probe prints `PROBE_AWAIT_SIGN_IN_CODE email=<addr>` and blocks on stdin for the 6-digit code.
It then prints `PROBE_AWAIT_SIGN_IN_LINK email=<addr>` and blocks on stdin for that email's magic link.

Success ends with:

```text
EMAIL_CODE_STEP_1_PUBLISH_OK relic_id=<id>
EMAIL_CODE_STEP_3_SIGNED_IN_IN_PLACE navigations=0 offer=shown
EMAIL_CODE_STEP_4_COMMENT_OK author=<address>
EMAIL_CODE_STEP_5_LINK_SPENT callback=401
EMAIL_CODE_SIGN_IN_LIVE_OK relic=<id> navigations=0 link=401
```

## Passkey sign-in for returning readers

Run the full loopback proof from the repository root:

```bash
RELIC_CHROME_PATH="$(command -v google-chrome)" bun packages/relic-mcp/test/passkey-sign-in-path.ts
```

The command starts a service on loopback with `MemoryStore` and `MemoryStorage`,
serving built viewer assets. It binds 127.0.0.1 but browses with
`serviceOrigin = http://localhost:<port>` so WebAuthn RP ID checks pass.
Every MCP operation runs through a fresh Node stdio process with `title: ""`,
`cover: false`, and `ttl_days: 1`.

It exercises:
1. Publishing an initial document with title: "", cover: false, ttl_days: 1.
2. Installing a script wrapper recording `credentials.get` calls `{mediation, aborted}`, opening the relic anonymously, and asserting autocomplete and `[data-passkey-sign-in]`.
3. Requesting a sign-in magic link from the comment composer, following it, and asserting `[data-passkey-offer]` is shown and the offer marker cookie is deleted.
4. Clicking `[data-passkey-offer-create]`, waiting for `data-state="created"`, checking that WebAuthn holds 1 resident credential, and verifying `store.getPasskeysByUserHandle` resolves it.
5. Reporting conditional mediation unavailable (a virtual authenticator answers an autofill request by itself, so this keeps the button path deliberate), deleting the `relic_session` cookie via CDP, reopening the relic URL, and asserting `/api/auth/session` returns `email: null` with no conditional request armed.
6. Clicking `[data-passkey-sign-in]`, verifying "Commenting as <addr>" appears, a sign-in POST was made, and zero emails were sent.
6b. Making conditional mediation available again, signing out and reopening, and verifying the autofill request alone signs the reader in: "Commenting as <addr>", a conditional request armed, a sign-in POST, and zero emails.
7. Posting a comment through `textarea.compose-textarea` and "Post comment", and reading it back via `relic_read_comments` to verify author attribution.
8. Negative controls: replaying the captured sign-in POST gives 401, text/plain gives 400, email-first options for unknown and known addresses match in shape and count, and a decision POST carrying the passkey-minted session but no credential gives 400.

Success ends with:

```text
PASSKEY_STEP_1_PUBLISH_OK relic_id=<id>
PASSKEY_STEP_2_ANON_SURFACE_OK conditional=<armed|unavailable>
PASSKEY_STEP_3_MAGIC_LINK_OK offer=shown
PASSKEY_STEP_4_ENROLL_OK resident=true
PASSKEY_STEP_4B_NOTICE_OK to=<addr>
PASSKEY_STEP_5_SIGNED_OUT_OK
PASSKEY_STEP_6_SIGN_IN_OK mails_sent=0
PASSKEY_STEP_6B_AUTOFILL_OK mails_sent=0
PASSKEY_STEP_7_COMMENT_OK author=<addr>
PASSKEY_NEG_OK replay=401 wrong_content_type=400 email_first_shape=equal decision_without_assertion=400
PASSKEY_STEP_8_FRESH_LINK_OK refused=passkey_fresh_link_required orphans=0 recovered=created notice=1
PASSKEY_SIGN_IN_PATH_OK
```

## Passkey sign-in on the live service

Run against the live deployment from the repository root:

```bash
RELIC_PASSKEY_PROBE_MAILBOX=user@example.com bun packages/relic-mcp/test/passkey-sign-in-live-probe.ts
```

The probe exercises passkey sign-in against a live service deployment (defaulting to `https://relik.link`).
It reads the base recipient address from `RELIC_PASSKEY_PROBE_MAILBOX` and derives a fresh per-run plus-addressed email `<local>+relic-passkey-<runId>@<domain>`.
The probe refuses to run without a plus-tag, ensuring test passkeys never claim TOFU for a real mailbox.

It respects:
- `RELIC_SERVICE_ORIGIN`: destination service, defaults to `https://relik.link`
- `RELIC_PASSKEY_PROBE_CLIENT`: `'source'` or `'npx:<version>'` (defaults to `npx:0.14.0`)
- `RELIC_PUBLISH_STATE`: optional fixed state path (defaults to scratch)
- `RELIC_CHROME_PATH`: optional browser executable path

The probe prints `PROBE_AWAIT_MAGIC_LINK email=<addr>` and blocks on stdin. The operator retrieves the magic link from the destination mailbox and pastes it into stdin.
The probe then prints `PROBE_AWAIT_PASSKEY_NOTICE email=<addr>` and blocks on stdin for the first line of the passkey notice email, asserting it matches the expected notice text.

Success ends with:

```text
PASSKEY_STEP_1_PUBLISH_OK relic_id=<id>
PASSKEY_STEP_2_ANON_SURFACE_OK conditional=<armed|unavailable>
PASSKEY_STEP_3_MAGIC_LINK_OK offer=shown
PASSKEY_STEP_4_ENROLL_OK resident=true
PASSKEY_STEP_4B_NOTICE_OK to=<addr>
PASSKEY_STEP_5_SIGNED_OUT_OK
PASSKEY_STEP_6_SIGN_IN_OK mails_sent=0
PASSKEY_STEP_6B_AUTOFILL_OK mails_sent=0
PASSKEY_STEP_7_COMMENT_OK author=<addr>
PASSKEY_NEG_OK replay=401 wrong_content_type=400 email_first_shape=equal decision_without_assertion=400
PASSKEY_STEP_8_FRESH_LINK_SKIPPED live
PASSKEY_SIGN_IN_LIVE_OK relic=<id> client=relic-mcp@<version>
```

## Anchored comment popovers on every class

Run from the repository root:

```bash
bun packages/relic-mcp/test/comment-popover-path.ts
```

The harness exercises attached comment popovers and posted cards across all 9 classes (markdown, code, image, PDF, HTML, SVG, video, audio, and OTIO), verifying §5.8 assertions (adjacency, horizontal alignment, no overlap, anchor exposure, inside boundaries, usability, preference, capped scrolling, and follow tracking) on a loopback service without network calls.

Success ends with:

```text
COMMENT_POPOVER_PATH_OK classes=9
```

## 500 MiB upload and large previews

From the repository root:

```sh
bun run --cwd packages/relic-viewer build
bun run --cwd packages/relic-mcp build
RELIC_PROOF_CHROME_PATH=/absolute/path/to/headless-chromium bun packages/relic-mcp/test/large-relic-path.ts
```

Use `chrome-headless-shell` on macOS. The path is mandatory and the owned process must attest headless mode. The proof requires Node, Bun, ffmpeg with the `libvpx-vp9` encoder, and enough scratch space for the generated fixtures and downloads. The MCP peak RSS receipt uses sampled Linux process high-water marks or sampled macOS RSS.

The loopback service uses `MemoryStore` and `MemoryStorage`. Fresh MCP stdio processes publish the fixtures; no production endpoint receives a write. The exact 500 MiB video must publish with the expected ciphertext length, refuse a 500 MiB plus one byte declaration locally and at the server, prompt before a full fetch, play and seek, and download byte-identically. A 100 MiB video must open without the prompt. The proof seeds 199 consumed mints and checks that the 200th succeeds and the 201st is refused.

A large OTIO bundle contains a referenced 498 MiB video and must play, seek, expose timing windows, and retain a point comment after reopening. A 300 MiB PDF must render both distinct pages and download intact after rendering. A 120 MiB text file must expose first, middle and last source windows and download intact; the proof also checks a large image and both the 16 MiB model byte limit and 250,000-triangle limit. Corrupted ciphertext, a flipped download byte, and an authenticated over-cap envelope are negative controls.

Immediately after starting the browser, the memory calibration requires more than 400 MiB growth for a touched 512 MiB allocation, more than 64 MiB for a retained 96 MiB allocation, and less than 64 MiB after releasing that allocation and churning another 512 MiB. It emits `LARGE_MEMORY_NEG_OK` before any browser memory gate.

Post-pressure gates compare process snapshots using `phys_footprint` on macOS or `RssAnon + VmSwap` on Linux: media must grow by less than 64 MiB before playback and 128 MiB after release, while OTIO and PDF must each grow by less than 128 MiB. PDF includes utility processes; the other gates cover renderers. New processes contribute their full footprint, and exited processes cannot subtract from growth. Receipts include the measurement name, RSS growth, and added and exited process IDs.

These gates do not bound transient renderer peaks or browser-process storage. Success ends with `LARGE_RELIC_PATH_OK`. Output reports observed byte counts and memory samples, without share URLs or keys. Scratch files and the owned browser profile are removed. Firefox, WebKit, physical devices, version-cache eviction, and stress-rendering an exactly 100 MiB text document are outside this command.

## Private shares

Build the relic-mcp bundle first. The root `bun run build` does not produce `packages/relic-mcp/dist/relic-mcp.js`, which the path runs:

```bash
bun run --filter relic-mcp build:bundle
```

Then run the full loopback proof from the repository root with an explicit Chrome:

```bash
RELIC_CHROME_PATH="$(command -v google-chrome)" bun packages/relic-mcp/test/private-shares-path.ts
```

The command starts a service on loopback with `MemoryStore` and `MemoryStorage`, serving built viewer assets. It drives three PRF-capable headless browsers (owner, reader, and a third identity) and one authenticator without PRF, and it publishes tap-free through a fresh relic-mcp stdio process.

It prints the eleven `PRIVATE_STEP_N_...` lines in order. Success ends with exit code 0 and:

```text
PRIVATE_SHARES_PATH_OK
```

A failed assertion exits non-zero after printing `PRIVATE_SHARES_PATH_FAILED` and the step it stopped at. A recorded product defect prints `PRIVATE_SHARES_PATH_BLOCKED` with the defect codes and exits non-zero.
