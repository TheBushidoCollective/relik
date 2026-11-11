# Deployment smoke safety

After `bun run build`, run `bun scripts/deploy-smoke-path.ts`. It executes both deployment smoke scripts against a loopback application with in-memory state and checks the exact read-only request sequence. Success ends with `DEPLOY_SMOKE_PATH_OK`, after concurrent runs preserve planted symlinks and clean up their private temporary directories, both restored POST probes are rejected, and a missing asset fails the smoke check. No production requests are made.

# Email code sign-in

A reader who asks to sign in on a relic gets one email with a six-digit code and a link, types the code into the same page, and is signed in without leaving it: the key stays in the tab, the comment they post carries their address, and the link in that email stops working.

## Acceptance command

The implementation provides this loopback proof:

```sh
mise exec -- bun run verify
mise exec -- bun run --cwd packages/relic-mcp build
RELIC_CHROME_PATH="$(command -v google-chrome)" mise exec -- bun packages/relic-mcp/test/email-code-sign-in-path.ts
```

Success requires these lines in order, then `EMAIL_CODE_SIGN_IN_PATH_OK`:
`EMAIL_CODE_STEP_1_PUBLISH_OK relic_id=<id>`,
`EMAIL_CODE_STEP_2_CODE_MAILED subject_has_code=true link_present=true`,
`EMAIL_CODE_STEP_3_SIGNED_IN_IN_PLACE navigations=0 offer=shown`,
`EMAIL_CODE_STEP_4_COMMENT_OK author=<address>`,
`EMAIL_CODE_STEP_5_LINK_SPENT callback=401`,
`EMAIL_CODE_NEG_OK wrong=401 no_cookie=401 unknown_request=401 replay=401 link_first=401 locked=401 link_after_lock=303 shape_equal=true wrong_content_type=400`.
All proof writes target local in-memory services.

For production verification against a live service:

```sh
RELIC_EMAIL_CODE_PROBE_MAILBOX=user@example.com RELIC_CHROME_PATH="$(command -v google-chrome)" mise exec -- bun packages/relic-mcp/test/email-code-sign-in-live-probe.ts
```

The probe prints `PROBE_AWAIT_SIGN_IN_CODE email=<addr>` and blocks on stdin for the code, then `PROBE_AWAIT_SIGN_IN_LINK email=<addr>` and blocks for that email's link. Success requires `EMAIL_CODE_SIGN_IN_LIVE_OK relic=<id> navigations=0 link=401`.

# Passkey sign-in for returning readers

A reader who verified their email once and added a passkey can open a relic later, tap 'Sign in with passkey' (or pick the passkey from the email field's autofill), and post a comment without receiving any email.

## Acceptance command

The implementation provides this loopback proof:

```sh
mise exec -- bun run verify
mise exec -- bun run --cwd packages/relic-mcp build
RELIC_CHROME_PATH="$(command -v google-chrome)" mise exec -- bun packages/relic-mcp/test/passkey-sign-in-path.ts
```

Success requires `PASSKEY_SIGN_IN_PATH_OK`, verified usernameless and email-first sign-in options with decoy padding, TOFU passkey enrollment after magic-link verification, passkey-added notice email delivery, fresh sign-in link requirement negative control and recovery, session resumption without email, comment author attribution, and passing negative controls (replayed sign-in refusal, content-type enforcement, oracle prevention, and assertion requirement on decisions). All proof writes target local in-memory services.
For production verification against a live service:

```sh
RELIC_PASSKEY_PROBE_MAILBOX=user@example.com mise exec -- bun packages/relic-mcp/test/passkey-sign-in-live-probe.ts
```

The probe prints `PROBE_AWAIT_MAGIC_LINK email=<addr>` and blocks on stdin for the callback link, then prints `PROBE_AWAIT_PASSKEY_NOTICE email=<addr>` and blocks on stdin for the notice's first line. Success requires `PASSKEY_SIGN_IN_LIVE_OK relic=<id> client=relic-mcp@<version>`.
# OTIO review path

A publisher supplies an `.otiod` directory, Relik packages and encrypts a standard `.otioz`, a reviewer plays its tracks and leaves track-specific point or range feedback, and a fresh publisher agent reads the original revision and source-media coordinates before publishing a revision.

## Acceptance command

The implementation must provide this loopback-only proof:

```sh
mise exec -- bun run verify
mise exec -- bun run --cwd packages/relic-mcp build
mise exec -- bun packages/relic-mcp/test/otio-path.ts
```

The additional clock-specific modes use the same loopback fixture and owned headless browser. They do not replace the full path:

```sh
RELIC_OTIO_CLOCK_PROOF=focused mise exec -- bun packages/relic-mcp/test/otio-path.ts
RELIC_OTIO_CLOCK_PROOF=long mise exec -- bun packages/relic-mcp/test/otio-path.ts
```

The focused mode reports `OTIO_CLOCK_FOCUSED_OK` only after its scheduled playback and injected clock controls pass. The long mode reports `OTIO_CLOCK_LONG_OK` only after one retained context crosses frame `2 ** 24` during source-correct playback. Neither marker is a substitute for `OTIO_PATH_OK`.

The full and focused paths qualify the scheduled source at both 48 kHz and 44.1 kHz. The latter is a loopback-only PCM16 fixture converted from the checked 48 kHz source, independently decoded and hashed before comparison; the browser's actual context rate is checked against the fixture. The long path is a separate frame-boundary check.

Success requires `OTIO_PATH_OK`, decoded playback observations, encrypted comment persistence, agent readback after a revision, and viewport geometry receipts and screenshots for the bottom-anchored timeline in light and dark. The proof also covers short viewports, mobile inspector states, blocked previews, exact marker reveal and the attached composer. Set `RELIC_OTIO_SHOTS_DIR` to retain the artifacts. Unsupported codecs, effects, schemas, and ambiguous revision mappings must be explicit. All proof writes target local in-memory services.

The playback gate collects browser-local canvas samples, decoded CDP screencast frames, and PCM from a proof-only AudioWorklet connected downstream of the controller's master gain. It checks each moving-window repetition against independently decoded source frames, and retains freeze, stall, wrong-source, stale-frame, skipped-still, and master-gain mute controls. The boundary composition exercises repeated cuts, stills, gaps, dissolves, and continuous audio. The focused-comment proof reads the encrypted anchor through a fresh MCP process and checks composition and source coordinates after a nonzero-origin selection. A failed calibration or unavailable worklet blocks `OTIO_PATH_OK`; it is not a performance pass.

The cold initial presentation limit is 350 ms from the play request through the first observed change, charged conservatively for the left-censored initial frame. Thereafter, cold and warm presentation retain the 50 ms p95 and 100 ms maximum interval limits. The separate source-aware audio dropout limit remains 20 ms, and the source-prefix and audio epoch controls remain required.

Scheduled PCM qualification must observe the selected backend and compare the post-gain output against independently decoded source samples at the reported context-frame epoch, without fitting an offset. It must cover stereo, cuts and dissolves, a run longer than the 500 ms queue horizon, cancellation and starvation, and native compatibility for unsupported scopes. A diagnostic event alone is not playback proof.

The scheduled path must distinguish recoverable withholding of future media from loss of pixels already committed to output. A recoverable stop requires a render-thread gate closure and a new epoch at the exact committed sample; a lost committed frame or invalid output clock must report an interruption without inventing a resume position. Scope replacement remains paused. Record the actual gate boundary, error stage, captured stereo PCM and independently derived pixel evidence, including failing or missing observations. The future-video withholding proof must produce a recovery receipt; the existence of a fault hook alone proves nothing.

The two-frame A/V check compares browser-estimated output timing with observed presentation. Its mapping allowance reflects the sampled bridge spread, read duration and render quantum; it is not a bound on physical speaker or display timing. The timestamp-bias negative control demonstrates that a common-mode error can remain invisible to that check. Physical synchronization requires a separate instrumented measurement.

The native-clock replacement is not qualified by a passing standalone clock experiment. Release evidence must include the actual player, a separately scheduled source-position witness, captured stereo, the frozen-origin anchor certificate and at least two bank promotions. It must retain raw callback labels and demonstrate an actual repeated cached label while the independently observed source continues without an omitted or repeated sample. Missing evidence fails qualification. Injected held, late, corrupt and missing clock evidence and corrupted capture must reach the real admission path and be rejected.

The browser cannot establish physical speaker or display timing from its output timestamps. A render-frame clock also cannot detect a wall-clock interruption before the browser reports the interruption or resume. Pre-notification suppression of old-generation audio therefore requires a native render-side epoch or latch; this loopback proof does not claim it.

The complete source path passed locally at `5a4bd6d` with Node 24.15.0, Bun 1.4.3, and the owned Chromium headless shell 1228. It exercised the original archive/playback/encrypted-feedback/revision stages, both exact-identity sidebar reveals after 40 coincident UI comments, and the zero-mail assertion, ending `OTIO_PATH_OK`. The matched old renderer failed the exact marker-center reveal assertion after the same 40 UI posts. Release qualification, CI, deployment, and the published npm client remain separate gates.

# Anchored comment popovers on every class

A verified reader who selects, points at or marks a target on any relic class writes the comment in a panel attached to it, and after Post the same place shows the posted comment's card while the sidebar stays as it was.

## Acceptance command

The implementation provides this loopback-only proof across all 9 classes:

```sh
mise exec -- bun packages/relic-mcp/test/comment-popover-path.ts
```

Success requires `COMMENT_POPOVER_PATH_OK classes=9`, attached composers and posted comment cards on every class, verified §5.8 assertions (adjacency, horizontal alignment, no overlap, anchor exposure, usability, preference, capped scrolling, follow tracking), and negative control verification against origin/main 76269ed5.

Saved comment cards and timeline cluster cards expose **Dismiss** (`.popover-dismiss`, accessible name `Dismiss comment overlay`). Exercise pointer and keyboard dismissal after Post and on an existing mark, then reopen from the mark and thread. Closing the overlay must preserve the stored comment, counts, sidebar, playback and fullscreen without a mutation request. New/edit composers have no Dismiss, and replying hides it to protect the draft. Keyboard focus restoration must not immediately reopen the card; asynchronous work from a dismissed card must not reopen it or replace a newer panel. The clickable interaction reference is `docs/plans/anchored-popover/mockup.html`.

# Comments on images inside HTML

A reader activates **Comment on image**, posts in the attached composer, dismisses the saved overlay and reopens the same comment from its image badge or thread after reload. Ordinary linked-image activation remains navigation, not commenting.

## Acceptance command

```sh
mise exec -- bun packages/relic-mcp/test/html-image-comments-path.ts
```

Success requires `HTML_IMAGE_COMMENTS_PATH_OK`.

The proof uses loopback services only. It must exercise encrypted persistence and agent readback, reload, multiple comments on one image, linked-image navigation, pointer and keyboard dismissal, narrow-layout geometry, responsive source declarations, stale placement replies, and unavailable targets without a coordinate fallback. The clickable reference includes HTML states F6 through F9 in `docs/plans/anchored-popover/mockup.html`.

Image comment markers and the hover-revealed add control share 28px circular
buttons and inline Font Awesome Pro 7.3.1 `comment` / `comment-plus` glyphs.
Each image has one row with 10px gaps; excess comments scroll horizontally
instead of wrapping or shrinking. The row stays within the frame viewport
even when its image is tiny or clipped. Keyboard focus reveals a button inside
the row, pending markers are disabled and dashed, active markers are outlined,
and resolved markers are gray. The opaque sandbox and its network policy stay
unchanged; Font Awesome's commercial attribution is retained in the inline SVG.

The image path proof must measure pending and posted circles, gaps and viewport
bounds, then exercise 12 additional markers on an 18x10 image and a clipped image
at 1440px and 320px widths. It must check horizontal overflow, visible keyboard
focus, and active/resolved state updates. `RELIC_IMAGE_SHOTS_DIR` retains the
`markers-<width>-<scenario>.png` screenshots and `rectangles.json` measurements
alongside the existing light/dark receipts.

# Large relic upload and preview

Build the viewer and MCP bundle, then run the loopback proof from the repository root:

```sh
bun run --cwd packages/relic-viewer build
bun run --cwd packages/relic-mcp build
RELIC_PROOF_CHROME_PATH=/absolute/path/to/headless-chromium bun packages/relic-mcp/test/large-relic-path.ts
```

The command publishes a 500 MiB file through MCP stdio to a loopback service, checks the cap boundary, exercises the confirmation and preview, and hashes the downloaded file against the source. It also checks large OTIO, PDF, text, image and model paths. Success ends with `LARGE_RELIC_PATH_OK`; failures exit nonzero. The browser has a private profile and must attest headless mode.
The large OTIO archive is focus-only; the proof focuses and plays a clip.

Node, Bun, ffmpeg with `libvpx-vp9`, an explicit headless Chromium executable, and sufficient temporary disk space are required. The proof supports Linux and macOS. The MCP peak RSS receipt uses sampled Linux process high-water marks or sampled macOS RSS.

Before the browser memory gates, a calibration must detect a touched 512 MiB allocation and a retained 96 MiB allocation, then show less than 64 MiB growth after those allocations are released and churned. The gates compare post-pressure per-process snapshots using `phys_footprint` on macOS or `RssAnon + VmSwap` on Linux. They retain the 64 MiB media pre-playback, 128 MiB media after-release, and 128 MiB OTIO and PDF limits. Receipts also report RSS growth and added or exited process IDs. The PDF gate includes utility processes; the others cover renderers.

During either page pixel check, the PDF step fails if a worker range overlaps the whitespace between the first and final MiB. A range assertion also requires at least one recorded worker request. The `LARGE_STEP_6_PDF_PAGES` receipt includes `worker_ranges`.

These are post-pressure growth gates, not bounds on transient renderer peaks or browser-process storage. The proof creates and removes local scratch data and makes no production writes. Cross-engine, real-device and version-cache measurements are separate proofs.

