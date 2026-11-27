# Scrubbed error reports

The loopback proof exercises a server exception, a viewer error in the built viewer, and an opted-in release-stamped MCP crash. Each reaches the in-memory report recorder and an allowlisted issue body. It makes no GitHub or Google API calls.

```sh
bun run --cwd packages/relic-viewer build
RELIC_CHROME_PATH=/absolute/path/to/owned/headless/chrome bun run packages/relic-ops/bin/error-report-path.ts --leg all
```

Success prints `ERROR_REPORT_SERVER_PATH_OK`, `ERROR_REPORT_VIEWER_PATH_OK`, `ERROR_REPORT_MCP_PATH_OK`, and `ERROR_REPORT_PATH_OK`. Without a Chrome path the local viewer leg is explicitly skipped and the all-legs command prints `ERROR_REPORT_PATH_PARTIAL`, not a pass. CI requires Chrome. The individual legs can be selected with `--leg server`, `--leg viewer`, or `--leg mcp`.

## Production read check before live filing

1. Keep `ERROR_REPORTS_MODE=dry-run` and `AUTOFIX_MODE=off`. Confirm the logging sink, dedicated bucket, reader account and main-ref Workload Identity binding are deployed.
2. Run the `error reports` workflow on main in dry-run mode. Confirm the file job authenticates and reads the dedicated view, the step summary shows accepted and dropped counts, and no issue or label write occurs. A quiet bucket does not prove a report reached it.
3. When a legitimate report exists, confirm its log record is visible to this identity and that the dry-run plan contains only allowlisted report fields. Do not create a production error or test issue to manufacture a record.
4. After that read check, set `ERROR_REPORTS_LIVE_SINCE` to the intended RFC 3339 cutoff and explicitly set `ERROR_REPORTS_MODE=live`. Records before the cutoff are ignored. The first live run creates missing fixed labels as needed and is capped at five server and five client issues per rolling 24 hours.
5. Audit an issue with `GITHUB_TOKEN=<read-token> bun packages/relic-ops/bin/audit-issue.ts <issue-number>`. `ERROR_REPORT_ISSUE_AUDIT_OK` proves the filer-owned region matches the allowlist grammar, not that the logged error is reproducible.

The current workflow only files issues and emits a capped autofix candidate list. It does not run an autofix job.

# Deployment smoke safety

After `bun run build`, run `bun scripts/deploy-smoke-path.ts`. It executes both deployment smoke scripts against a loopback application with in-memory state and checks the exact read-only request sequence. Success ends with `DEPLOY_SMOKE_PATH_OK`, after concurrent runs preserve planted symlinks and clean up their private temporary directories, both restored POST probes are rejected, and a missing asset fails the smoke check. No production requests are made.

# Email code sign-in

A reader who asks to sign in on a relik gets one email with a six-digit code and a link, types the code into the same page, and is signed in without leaving it: the key stays in the tab, the comment they post carries their address, and the link in that email stops working.

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

A reader who verified their email once and added a passkey can open a relik later, tap 'Sign in with passkey' (or pick the passkey from the email field's autofill), and post a comment without receiving any email.

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

A verified reader who selects, points at or marks a target on any relik class writes the comment in a panel attached to it, and after Post the same place shows the posted comment's card while the sidebar stays as it was.

## Acceptance command

The implementation provides this loopback-only proof across all 9 classes:

```sh
mise exec -- bun packages/relic-mcp/test/comment-popover-path.ts
```

Success requires `COMMENT_POPOVER_PATH_OK classes=9`, attached composers and posted comment cards on every class, verified §5.8 assertions (adjacency, horizontal alignment, no overlap, anchor exposure, usability, preference, capped scrolling, follow tracking), and negative control verification against origin/main 76269ed5.
The same loopback path prints `CONFIRM_COMMENT_PATH_OK` for trusted comment deletion, Ask again and the 390px menu, and `CONFIRM_LARGE_PATH_OK` for an authenticated large-file envelope and remembered Open. The fixture emulates version 2 in the mint response and truncates the object after record zero. It proves the new version asks and the full fetch starts, but not actual republishing or a completed large-file open.

Saved comment cards and timeline cluster cards expose **Dismiss** (`.popover-dismiss`, accessible name `Dismiss comment overlay`). Exercise pointer and keyboard dismissal after Post and on an existing mark, then reopen from the mark and thread. Closing the overlay must preserve the stored comment, counts, sidebar, playback and fullscreen without a mutation request. New/edit composers have no Dismiss, and replying hides it to protect the draft. Keyboard focus restoration must not immediately reopen the card; asynchronous work from a dismissed card must not reopen it or replace a newer panel. The clickable interaction reference is `docs/plans/anchored-popover/mockup.html`.

# Production CSP proof for the render frame

The probe publishes each relik through the built MCP bundle and opens it in the production viewer and shim, in an isolated headless shell with a throwaway profile, in two process models. Each case has a plain-shim control on the same relik bytes, and a row counts as blocked only where that control shows the channel. It exits 1 on any production egress or any relik that does not run.

## Acceptance command

```sh
mise exec -- bun run --cwd packages/relic-viewer build
mise exec -- bun run --cwd packages/relic-mcp build:bundle
mise exec -- bun packages/relic-mcp/test/csp-prod-path.ts
```

A clean run prints `CSP_PROD_OK` and no `CSP_PROD_FAIL`. The unproven rows follow `CSP_PROD_UNPROVEN`. `RELIC_CSP_PROD_CHROME_PATH` selects the browser. The default is the owned isolated headless shell, and the probe does not fall back to another browser. `RELIC_CSP_PROD_ONLY=id,id` runs a subset for diagnosis. `verify.yml` does not run this probe. The measured routes and the unproven list are in `docs/spec/viewer.md`, section 4.

# Frame egress from the sandboxed render frame

The probe measures which channels a relik's own script reaches from the sandboxed frame, using the real MCP bundle, the real app and the production policy, in an isolated headless shell with a throwaway profile. Every channel has its own loopback listener and UDP socket. It proves the channels it observes blocked and states the rest as unproven. It does not prove that no other channel exists. The per-route proof with controls is the section above.

## Acceptance command

Build the viewer and the MCP bundle first, then run the probe:

```sh
mise exec -- bun run --cwd packages/relic-viewer build
mise exec -- bun run --cwd packages/relic-mcp build
mise exec -- bun packages/relic-mcp/test/frame-egress-path.ts
```

Last run on `fix/csp-build`, 2026-11-19: the four Review2 routes (cases 1, 1b, 2 and 4) print BLOCKED, and the probe prints `FRAME_EGRESS_PATH_OK_WITH_UNPROVEN` and exits 0. Its negative control is a shim that re-emits author scripts as blob scripts and installs no RTC guard, served behind the production policy with its own script hash. It must show WebRTC egress, and it does (`rtc:shim-realm`). So the policy and the blob path do not stop WebRTC, and the realm guard does. Cases 3a, 3b and 5 print CANNOT TEST, and the UNPROVEN rows are channels a loopback listener cannot observe in this build. `RELIC_FRAME_EGRESS_CHROME_PATH` selects the browser (default: the owned isolated headless shell).

# Link bar stages and top-frame navigation (manual, not CI)

The stress probe, `svg-top-nav-stress.ts`, runs the link bar stages with trusted CDP input: a gesture with no Open, a gesture with Open, a remembered choice on a later load, a republished version, and frame claims that try to set or clear all three confirmation kinds for the actual relik. It then runs the top-frame navigation attacks against the production viewer and a positive control. It is manual and is not a CI gate: `verify.yml` does not run it.

```sh
mise exec -- bun run --cwd packages/relic-viewer build
RELIC_CHROME_PATH=<isolated-headless-shell> RELIC_TOP_NAV_N=10 mise exec -- bun packages/relic-mcp/test/svg-top-nav-stress.ts
```

A clean run prints ten `F1 PASS` lines (five per mode) and no `F1 FAILED`. It exits 7 today by design: no viewer gesture row receives a trusted click on the link, so the gesture claim is unproven (`VIEWER-GESTURE-UNEXERCISED`). Exit 5 means the control is blind for an attack the viewer rows claim blocked, and exit 6 means an F1 stage failed. Unproven: the trusted click on the link does not reach the viewer frame in the stress rows, and the cause is not isolated. The F1 gesture stage shows the same link opens the bar.

# Reader suggestions

The MCP and browser paths publish fixtures to an in-process loopback service.
Both drive the built MCP bundle over stdio. The browser path uses separate
authenticated browser contexts for the two readers.

```sh
RELIC_REQUIRE_CHROME=1 RELIC_CHROME_PATH=<isolated-headless-shell> mise run verify
mise exec -- bun run --cwd packages/relic-viewer build
mise exec -- bun run --cwd packages/relic-mcp build
RELIC_SUGGEST_MAIN_MCP=<efa3afee-mcp-bundle> mise exec -- bun packages/relic-mcp/test/suggestions-mcp-path.ts
RELIC_CHROME_PATH=<isolated-headless-shell> RELIC_SUGGEST_MAIN_DIST=<efa3afee-viewer-dist> mise exec -- bun packages/relic-mcp/test/suggested-edits-path.ts
RELIC_CHROME_PATH=<isolated-headless-shell> mise exec -- bun packages/relic-mcp/test/structured-formats-path.ts
```

The expected markers are `SUGGESTIONS_MCP_PATH_OK legacy=ran` and
`SUGGESTED_EDITS_PATH_OK classes=2 negative=ran cue=applied csv=applied notebook=applied target=validated`.
CI omits the old bundles and may report `legacy=skipped` and `negative=skipped`
instead. The browser path requires the SRT, CSV and notebook application stages.
It previews and applies viewer-posted suggestions with the built MCP and checks
whole-file bytes. The cue stage also applies a deferred edit after a display-only
rename, and the CSV stage checks a deferred text edit against a newer CSV format.
It checks cross-cell conflict placement, refuses multiline cell deletion and
rejects a same-basename wrong path. The notebook stage rejects
competing empty-cell fills and attempts to edit outputs. Cue and output refusal
checks count attempted POSTs, including rejected requests. Source identity
identifies the path, not the version; matching preview and write hashes are
checked for these fixtures. Newly published versions record their formats
locally without a mint. A legacy version whose format is unknown requires one
mint to read its encrypted revision; the recovered format and keyed folder-entry
digests are stored in an encrypted local cache before preview succeeds. Separate
MCP processes can each mint the same uncached version concurrently, because the
recovery lock is process-local. Unavailable metadata, failed cache writes and
incompatible selected formats are refused. The browser path does not establish
operating-system IME, real clipboard or drag-and-drop behavior.

`local_state_stale` detects a newer live version only when a comment carries
that version. If republish completes but its local state update fails before a
new-version comment exists, suggestion preview and apply can validate against
the old version's format instead. The `local_state_write_failed` response names
the live version. Do not preview or apply suggestions for that relik until its
local publish record has been repaired; this path does not detect that stale
state on its own.

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

# Comments on images inside DOCX

Build the viewer and run the loopback reader proof with an isolated headless shell:

```sh
mise exec -- bun run --cwd packages/relic-viewer build
RELIC_CHROME_PATH=/absolute/path/to/chrome-headless-shell mise exec -- bun packages/relic-mcp/test/docx-frame-path.mjs
```

Success requires `DOCX_IMAGE_REOPEN_OK`, `DOCX_READER_PATH_OK` and `DOCX_FRAME_PATH_OK`. The image-comment stage posts encrypted comments on two image parts and a repeated image, then reopens the same version and checks their badges against the original images. It uses an in-memory loopback service.

# Large relik upload and preview

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


# Private shares

A reader is let into a private relik by its owner, who sees who asked and their fingerprint, then grants with one passkey tap. The link carries no key, the owner's device publishes without a tap, a provider that cannot hold a key is refused, a revocation republishes under a fresh key the revoked reader cannot use, and deletion removes everything the service held for the relik.

## Acceptance command

After `bun run build` and `bun run --cwd packages/relic-mcp build`, from the repository root with an owned headless Chrome or chrome-headless-shell:

```sh
RELIC_CHROME_PATH=<owned headless shell> bun packages/relic-mcp/test/private-shares-path.ts
```

Success requires these lines in order, then `PRIVATE_SHARES_PATH_OK`, and exit code 0:
`PRIVATE_STEP_1_OWNER_IDENTITY fingerprint=<32>`,
`PRIVATE_STEP_2_DEVICE_PINNED wrong_owner_fingerprint=refused`,
`PRIVATE_STEP_3_TAP_FREE_PUBLISH fragment=false key_in_output=false owner_sign_count_delta=0 owner_open=ok`,
`PRIVATE_STEP_4_REQUESTED mail_names_relic=false mail_names_requester=true mail_fingerprint=true mail_grant_link=true`,
`PRIVATE_STEP_5_WRONG_FINGERPRINT ui=shows_true_fingerprint api=409 requester_wraps=0`,
`PRIVATE_STEP_6_SUBSTITUTED_KEY ui=shows_substitute_fingerprint`,
`PRIVATE_STEP_7_GRANTED reader_open=ok comment=ok agent_read=ok`,
`PRIVATE_STEP_8_REVOKED version=<n> revoked_wraps=0 revoked_key_fetch=403 revoked_mint=403 owner_open=ok agent_read=ok`,
`PRIVATE_STEP_9_NO_PRF provider=refused credential_without_prf=replace_offered identity_posts=0`,
`PRIVATE_STEP_10_REGULATED title=400 cover=400 ttl_over_max=400 shell_title=absent notices_generic=true`,
`PRIVATE_STEP_11_DELETED objects=0 wraps=0 seals=0 grants=0 comments=0 row=absent tombstone=owner log_events=<n>`.

A run with any product defect prints `DEFECT <id>: <evidence>` on stderr for each one and ends with `PRIVATE_SHARES_PATH_BLOCKED defects=<ids>` and exit code 1. It never prints `PRIVATE_SHARES_PATH_OK` while a defect stands. The receipts print in both cases. All writes target the in-memory loopback service.

Current state: the run prints every receipt and ends `PRIVATE_SHARES_PATH_OK` with exit code 0. The four defects an earlier run of this path found (the dashboard and ready-view roots detached by a render, a grantee unable to open a version sealed before the grant, and the owner unable to open a republished version) are fixed, and each has a regression test at the layer where it lived.

The live probe, `private-shares-live-probe.ts`, is operator-run against production. It refuses unless `--i-am-the-operator`, `RELIC_ORIGIN`, `PROBE_OPERATOR_EMAIL` and `RELIC_CHROME_PATH` are given, and it refuses in CI. The manual rehearsal, `private-shares-manual.ts`, prints mail to the terminal for real Chrome and Safari passkeys and writes a receipt per provider. Neither is part of CI.

# Structured formats (tables, trees, subtitles, notebooks)

A reader opens a .csv or .tsv as a table, a .json as a tree, an .srt or .vtt as subtitles and an .ipynb as a notebook. A cell, a node, a cue or a notebook cell or output takes a comment, the mark stays on it after a reload, and the MCP resolves the comment against the file it was written on. A page that cannot draw a comment's anchor says so, and the comment's text stays readable.

## Acceptance command

The implementation provides this loopback-only proof:

```sh
mise exec -- bun run verify
mise exec -- bun run --cwd packages/relic-mcp build
RELIC_CHROME_PATH="$(command -v google-chrome)" mise exec -- bun packages/relic-mcp/test/structured-formats-path.ts
```

Success requires `STAGE_TABLE_OK`, `STAGE_TREE_OK`, `STAGE_CUES_OK`, `STAGE_NOTEBOOK_OK`, `STAGE_OLD_READER_OK` and `STAGE_REFUSALS_OK`, then `STRUCTURED_FORMATS_PATH_OK`. Each stage publishes its own file through the MCP, comments through the viewer with real mouse and text input, and reads the comment back through the MCP. The table stage also requires the C14 and B4:D9 anchors to be exact `cell` anchors, the marks to survive a reload, a sort to move the C14 mark with its record, and the MCP to resolve the cell text and header.

The refusals stage is the negative control for the MCP validators: six malformed anchors are refused before anything is posted. Negative control for the table route was run by hand and is documented at the top of the script: with the csv and tsv routes removed, the table stage fails at "the table draws". A run that does not reach every stage prints `STRUCTURED_FORMATS_PATH_PARTIAL` and never the OK marker.

All proof writes target the local in-memory service. The browser is an isolated headless Chrome. Not proven here: other browsers, a 390 px layout review, the OS clipboard and IME, xlsx and documents (their own paths), and suggesting inside cells.

# Publish from the browser

A visitor opens `/publish`, drops a file or folder, reviews it and its link-preview title, and gets a link whose key never reached the service. The public title defaults to the original source name and stays separate from the editable encrypted filename, including when ZIP expansion is toggled. A cleared title sends no title and no filename. Folder and ZIP enumeration can be cancelled. A file over the page's ceiling is refused before any grant. A file dropped on any relik page, including one that fills the window with a sandboxed frame, opens the same publisher in a dialog over it and makes a new relik, and a relik that takes file drops itself keeps them. The homepage takes a drop the same way, and every page's top bar ends in an Upload button that opens a file chooser and the same dialog.

## Acceptance command

```sh
bun run --cwd packages/relic-viewer build
RELIC_CHROME_PATH="$(command -v google-chrome)" bun packages/relic-mcp/test/browser-publish-path.ts
```

Success requires these lines in order, then `BROWSER_PUBLISH_PATH_OK`:
`PUBLISH_STEP_1_PAGE terms=shown`,
`PUBLISH_STEP_2_REVIEW title=filename api_requests=0`,
`PUBLISH_STEP_3_PUBLISHED relic_id=<id> key_in_requests=false plaintext_at_rest=false`,
`PUBLISH_STEP_4_OPENS content=decrypted`,
`PUBLISH_STEP_5_CLEARED_TITLE filename_sent=false title_stored=false`,
`PUBLISH_REVIEW_SAFETY title=original zip_cancel=ok directory_cancel=ok`,
`PUBLISH_STEP_6_REFUSALS oversize=refused folder=reviewed grants=0`,
`PUBLISH_STEP_7_DROP_ANYWHERE text_drag=ignored file_drag=curtain dialog=opened new_relic=<id> page_behind=kept`,
`PUBLISH_STEP_8_REAL_DRAG over_bar=caught over_sandboxed_frame=caught`,
`PUBLISH_STEP_9_RELIC_CLAIMS curtain=none relic_got_drop=true dialog=none`,
`PUBLISH_STEP_10_HOMEPAGE scripts=1 dialog=styled published=<id> key_in_requests=false`,
`PUBLISH_STEP_11_UPLOAD_BUTTON chooser=opened homepage=dialog relic_page=dialog`,
`PUBLISH_STEP_12_EVERY_BAR pages=relic,dashboard,policy,publish,unopenable last_action=Upload widths=1280,390,320 overflow=none`,
`PUBLISH_STEP_13_OPTIONS filename=encrypted ttl=7 decisions=open title=omitted`,
`PUBLISH_STEP_14_COVER approved=served_without_key`.
The browser is an owned isolated headless Chrome with a throwaway profile, and all writes target the local in-memory service.

Private browser publishing has a separate loopback proof:

```sh
RELIC_CHROME_PATH=<isolated-headless-shell> bun packages/relic-mcp/test/browser-private-publish-path.ts
```

`BROWSER_PRIVATE_PUBLISH_PATH_OK` requires in-place email-code sign-in, a virtual PRF passkey, a displayed owner, and a missing-identity refusal before nonce, grant, or upload. It then requires a fresh private review and click, a sealed version with no public title or cover, a fragmentless link, and an owner open. The path does not prove a second identity's access grant or the production storage preflight.

Steps 8 and 9 use the browser's own drag path (`Input.dispatchDragEvent` with a file on disk) over a relik whose frame is a real cross-origin document, so the drag is routed by the browser rather than dispatched by the script. The frame's origin is `127.0.0.1` against the service's `localhost`. With the shim's drag signal removed, step 8 fails at the curtain, which is the negative control that was run.

Step 10 asserts the homepage names exactly `/assets/landing.js`, and that the dialog it opens is styled although the homepage has none of the viewer's stylesheet (a button with no fill or padding fails). Step 11 uses a real trusted click and Chrome's file-chooser interception (`Page.setInterceptFileChooserDialog`, then `DOM.setFileInputFiles`), because a chooser only opens for a click the browser treats as the visitor's. Step 12 checks the last action of every bar and that its right edge and the page's scroll width fit at 1280, 390 and 320px. The negative control that was run removed the Upload button from the policy page's bar, and step 12 failed there. Steps 10 and 11 wait for the page's `load` event first: the Upload link is in the HTML before the script that arms it, and a drop or click in that gap goes nowhere. The proof raced there until it waited, and passes eight runs in eight with the wait.

Not proven here: the loopback upload is same-origin, so the browser's cross-origin preflight to the real bucket is not exercised. The bucket's CORS rule admits `PUT` from the service origin, and the private-share rekey already relies on it, but the first publish from the live page is the check. After a deploy, publish a small file from the live `/publish` in an owned headless Chrome and open the link; a CORS failure shows as "The upload was interrupted" with no `PUT` reaching storage. Not proven either: Safari and Firefox, a drag from the operating system's own file manager (the proof drives the browser's drag path, not the OS's), a real native file-chooser dialog (the proof intercepts it), and files near the 100 MB ceiling. The abuse form carries no script and takes no drop, by design.

# Multi-file codec

Run `mise exec -- bun packages/relic-mcp/test/multi-file-path.ts`. The `codec` stage opens the fixed encrypted folder vector, checks its entries and byte-identical re-encryption, and confirms that the unchanged v1 decoder refuses it. Success prints `MULTI_FILE_STAGE codec OK` and `MULTI_FILE_PATH_OK`.

The two `MULTI_FILE_TIMING` lines report manifest decode and set-validation time for 1,000 and 5,000 entries in Bun. They are observations, not pass/fail thresholds or browser measurements.

# Version comparison: DOCX, EPUB and XLSX side by side

A reader opens a relik that has two versions and chooses Compare versions. DOCX and EPUB show both versions in their own frames, with the changes outlined in place beside a Changes list. XLSX shows both workbooks as grids with each changed cell marked. The stage publishes version 1 with `relic_publish` and version 2 with `relic_republish`, both through the built MCP over stdio, opens the share URL as a visitor does, and clicks the control with real mouse input.

## Acceptance command

```sh
bun run build
bun run --cwd packages/relic-mcp build
RELIC_CHROME_PATH=<isolated-headless-shell> bun packages/relic-mcp/test/version-compare-path.ts
```

Success ends with `VERSION_COMPARE_PATH_OK formats=docx,epub,xlsx widths=1440,390 negatives=5`. The same command must also pass with `RELIC_CHROME_PATH` set to full Chromium, run with `--headless=new`, which CI runs on Linux as `google-chrome`. `RELIC_COMPARE_PATH_SHOTS=<dir>` keeps a screenshot of each state.

At 1440x900 the stage checks the result line, the Changes count, each frame's outlines and height, the DOCX change rows and EPUB chapter rows, Next change with the visible outline on the change it lights, the layout round trip, and the scroll sync. At 390x844 it checks that the panes stack, that the page does not scroll sideways, and that the Changes drawer opens from its tab. XLSX adds the sheet strip, the cell states by position, Next change through the changed cells, and grid mirroring.

The five negatives are: a version that differs only in core.xml shows no text changes and no marks; a DOCX republished as an EPUB displays differently and is shown alone; a version over 16 MiB gets the notice and Earlier versions; hostile markup in an EPUB and a U+202E sheet name show as text and as an escape, and create no element and run nothing; and a frame makes no request beyond its own sandbox document and the assets its origin serves.

Two inputs are simulated, and the run output says which one each frame used. Under Chrome for Testing in `--headless=new`, a wheel turn over a grid or over an out-of-process frame reaches the document rather than the element, so the stage sets that element's scroll position itself. The scroll event is the one a reader's wheel fires, and the sync listens for it. In-process frames take a real wheel turn.

Not proven here: Safari and Firefox, touch and IME input, phone memory, a reader's wheel over an out-of-process frame in headed Chrome, and the live service. `version-compare-live-probe.ts`, described in `packages/relic-mcp/PATH.md`, checks the live service after a deploy and is run by hand, not in CI.

# Live settings

The loopback path publishes through MCP and exercises settings against two app
instances sharing a prefixed fake GCS metadata store and captured mail.

```sh
bun run --cwd packages/relic-viewer build
bun run --cwd packages/relic-mcp build
RELIC_CHROME_PATH=<owned-headless-shell> bun packages/relic-mcp/test/settings-path.ts
```

Success prints `01_COMMENTS_CLOSED`, `02_COMMENTS_REOPENED`, `03_NOTIFICATIONS`,
`04_OWNER_SETTINGS`, `05_PRIVATE_LIFETIME`, `06_PAUSED_SETTINGS` and
`SETTINGS_PATH_OK`. The lifetime check models ciphertext metadata in fake GCS
while the ciphertext bytes reside in loopback memory storage. It does not prove
production GCS lifecycle behavior or real mail delivery.

Mutation controls in a scratch checkout rejected a disabled comments guard
(`201` instead of `409`), a removed viewer owner gate (reader saw Settings),
and a pause check moved after attestation (replay returned `403`, not `200`).

# Signing

```sh
bun run build
bun run --cwd packages/relic-mcp build
RELIC_CHROME_PATH=<owned-headless-shell> bun packages/relic-mcp/test/signing-path.ts
```

The loopback path uses two app instances, a shared store, captured mail, the
built viewer and virtual passkeys in isolated headless browsers. It exercises
public and private signatures, receipts, certificate verification, cancellation,
the signing pause, and version locks. It does not prove real passkeys, production
storage lifecycle behavior or mail delivery.

# Direct share and invitations

```sh
bun run build
bun run --cwd packages/relic-mcp build
RELIC_CHROME_PATH=<owned-headless-shell> bun packages/relic-mcp/test/direct-share-path.ts
```

The path uses two app instances over one store, a third app that answers only the budget probes, a fourth with the kill switch engaged, a harness clock injected through `createApp` `now`, captured mail, the built viewer, virtual passkeys in isolated headless browsers, and relic-mcp over stdio. Every write goes to loopback. CI runs it as the `Direct share path` step after `Signing path`.

The previously recorded loopback pass predates the grant and claim storage change. The updated path has not been rerun on this revision. The lines below are expected receipts, not evidence of a current pass (the PRIVATE_STEP lines come first and are shared with the private shares path):

```
DIRECT_STEP_1_LOOKUP_GATE signed_out=401 other_reader=403 public_relik=400 owner=200 fingerprint_field=absent unregistered=null standing_self=owner
DIRECT_STEP_2_BUDGET per_address=true shared_with_recovery=true ip_budget=429 non_owner_charged=false
DIRECT_STEP_3_PANEL fingerprints=local_match self=that_is_you reader=already prefill=fragment fragment_after_open=absent
DIRECT_STEP_4_ONE_TAP owner_sign_count_delta=1 grants=2 statements_verify=owner_key stored_grant=reverifies wraps=exact v1_wraps=0 log=share,share
DIRECT_STEP_5_NOTICE per_recipient=1 names_owner=true fingerprint=own title=absent file=absent fragment=absent other_recipient=absent
DIRECT_STEP_6_RECIPIENT_OPENS states=signin,unlock,ready request_state=never v2=opened v1_key=403 shared_with_you=listed
DIRECT_STEP_7_LATER_VERSION mcp_republish=sealed mcp_roster=accepts_batch_grants recipient_v3=opened
DIRECT_STEP_8_REPEAT_AND_REVOKED repeat_api=409_grant_exists wraps_unchanged=true revoked_regrant=201 revoked_reader_opens=current
DIRECT_STEP_9_REFUSALS self=400_grantee wrong_fingerprint=409 substituted_lookup=ui_rejects_unverified substituted_api=400_grantee substitute_wraps=0 retired_identity=400_grantee
DIRECT_STEP_10_REQUEST_PATH lookup_standing=requested grant_log=grant grant_mail=unchanged
INVITE_STEP_1_CREATE batch=grant:1,invite:2 owner_sign_count_delta=1 invite_rows=2 wraps_open_under_invite_key=true d_in_any_request=false notice_mails=2 notice_names_owner=true notice_link=absent notice_key=absent links_shown=2
INVITE_STEP_2_ADDRESS_BOUND signed_out=401 other_address=404 bogus_id=404 same_body=true key_other=403 mint_other=403
INVITE_STEP_3_OPEN_WITH_CODE sign_in=code state=invite-ready listed=opened unlisted_key=403 comments=absent signing=absent fragment_after_open=absent log=wrap_fetch:address receipts=0 key_in_body=absent
INVITE_STEP_4_CLAIM passkey_created=1 identity=registered extra_claim_taps=0 claim_wraps=listed claim_store=invite_row m_wrap=absent invite_wraps=0 role=invited reads_after_invite_expiry=ok log=claim owner_mail=1
INVITE_STEP_5_SINGLE_USE second_tab=201_same_claimant_repeat winner_wraps_intact=true reopen_same_identity=reader
INVITE_STEP_6_INVISIBLE recipients_equal_without_invites=true mcp_republish=sealed new_version_wrapped_to_claimant=false
INVITE_STEP_7_CONFIRM owner_sign_count_delta=1 grant=live claim=retained invitation=confirmed mcp_republish_after=wraps_claimant claimant_opens_new_version=ok
INVITE_STEP_8_EXPIRY open_status=expired key=403 mint=403 claim=410_invite_expired
INVITE_STEP_9_REVOKE cancel_open=wraps_0 link_state=invite-withdrawn remove_claimed=claim_wraps_0 key=403 role=revoked
INVITE_STEP_10_REKEY revoke_other=new_version open_invite_listed=ok open_invite_new_version=403
INVITE_STEP_11_REGISTERED invite_for_registered=409_identity_exists lookup_charged=true existing_identity=unlock_then_claim already_reader=consumed_no_extra_wraps_or_index
INVITE_STEP_12_DELETE version_delete=versions_stripped surviving_key=200 deleted_key=403
INVITE_STEP_13_MCP grant_url_unregistered=invite_offered service_calls=0 refusal=recipient_forged_grant grant_url_in_refusal=true
INVITE_STEP_12_RELIK_DELETE whole_relik=invites_0,claim_indexes_0 checked_claimants=3
DIRECT_STEP_11_SIGNING_ONE_TAP owner_sign_count_delta=1 grants=2 new_signer_versions=[8] owner_as_signer=accepted request=open signer_mails=1 signed=ok certificate=valid public_signer=no_lookup known_signer=no_new_grant invited_claimant=granted_on_send review_edit=reset_on_edit
DIRECT_STEP_12_SIGNING_REFUSALS unregistered_signer=refused_no_request send_offered=false grants_on_public_session=400 grants_on_public_publish_token=400 grantee_not_signer=400 versions_not_request=400 unregistered_mail=0 refused_grants_stored=0
DIRECT_STEP_13_MCP share_grant_url=fragment_addresses service_calls=0 key_in_output=false request_signatures=recipient_forged_grant grant_url_in_refusal=true
DIRECT_STEP_13_ENUMERATION non_owner_registered=403 non_owner_unregistered=403 identical=true
DIRECT_STEP_13_KILL_SWITCH grant=503_service_paused replay=201 nonce_consumed_by_refusal=false
DIRECT_SHARE_PATH_OK
```

`new_signer_versions` is the version sealed for the signing request, so it changes from run to run. Whole-relik deletion checks the three claimant indexes created by this path, not an unbounded listing. A failed assertion prints `DIRECT_SHARE_PATH_FAILED last_receipt_step=<n> <message>` and exits 1; a product defect prints `DEFECT <id>: ...` and `DIRECT_SHARE_PATH_BLOCKED` with exit 1.

What differs from the targets in `docs/plans/direct-share/plan.md` section 10, and why:

- `DIRECT_STEP_9` prints `substituted_lookup=ui_rejects_unverified`, not `ui_shows_substitute`. The viewer marks a looked-up party unverified when its identity address differs from the typed address (`direct-share.ts`, `lookupShares`). The server still refuses the grant with `400 grantee`. Open decision: keep the stricter viewer, or show the substitute's fingerprint.
- `INVITE_STEP_5` requires `second_tab=201_same_claimant_repeat`. A repeat by the same claimant returns the existing claim; a different claimant is refused.
- `INVITE_STEP_12` is two lines: the version delete, then the whole-relik delete at the end of the run.
- `INVITE_STEP_13` drops `mcp_invite_tool=absent`: the path does not list MCP tools. relic-mcp registers only `relic_share` for sharing (`server.ts`, `SHARE_TOOL_NAME`).
- `DIRECT_STEP_11` prints the request status the service reported. The composer says "Relik will grant X access when you send" (the plan's wording was "will be granted when you send"). Editing a signer after review resets the review at the edit (`review_edit=reset_on_edit`), so the next tap is "Review and send" again. An invited claimant who has not been confirmed is granted by the send, as plan section 6 says; it is not refused. The public signer goes through `relic_request_signatures` (the device path) and makes no `/grants/lookup` call.
- `DIRECT_STEP_12` prints `unregistered_signer=refused_no_request send_offered=false`: the composer refuses with a notice and offers no send, but does not disable its review button. The plan's `grants_on_device_path=400` is `grants_on_public_session=400 grants_on_public_publish_token=400`: a public relik has no owner identity, so the grants refusal now runs before the owner lookup (`signing.ts`) and answers 400. `grantee_not_signer` and `versions_not_request` rewrite the browser's real request in the harness handler and re-sign the grant with the owner key; the server has one combined grants check, so both answer `invalid_statement` with `statement_check=grants` and the receipt does not say which sub-condition fired.
- `DIRECT_STEP_13` adds the enumeration and kill-switch lines. The kill switch is exercised through the Share panel, so the refused body carries real wraps; it is replayed unchanged and returns 201, which shows the refusal did not consume the challenge.

Server reconciliations made for this path: the private grant route refuses under the kill switch before `grantAccess` (`app.ts`), and the signing route refuses `grants` on a non-private relic before the owner lookup (`signing.ts`), each with a test (the second in `signing-acceptance.test.ts`; the first through `DIRECT_STEP_13_KILL_SWITCH`).

Mutation controls recorded on the earlier claim implementation, each run in a scratch checkout (`ovnfs`) and removed afterwards. They have not been rerun against the updated path:

| Mutation | Expected failure | Result |
|---|---|---|
| Lookup owner check removed (`app.ts`, grants lookup route) | Direct 1 | Failed at `DIRECT_STEP_1`: `non-owner lookup is not 403` |
| Address check removed from invitation open (`relic.ts`, `heldInvitation`) | Invite 2 | Failed at `INVITE_STEP_2`: `another address can open the invitation` |
| Invitation claim compare-and-swap skipped (`relic.ts`, claim write) | Invite 5 | Not caught by the path (exit 0). Caught by `private-invites.test.ts`: `a different claimant wins the CAS without inheriting the losing claim` |
| Invitation key sent in the open request body (viewer `invite-wire.ts`, `openInvite`) | Invite 3 | Failed at `INVITE_STEP_3`: `an invitation key reached a request body` |

The compare-and-swap is not observable over the path because an invitation can only be claimed by the one identity of its address, so a concurrent repeat converges to the same state with or without the guard. Only a second claimant, which the server unit test builds directly, tells the two apart.

Not run in this slice: budget charged per call, `statements[0]` served for every grant, fingerprint check skipped, version filter dropped, signer membership skipped, claim not emptying the invitation's wraps, invitation lookup charge skipped, and invitation rows added to `extendPrivateLifetime` (the last belongs to the server fake-GCS test).

The post-deploy operator targets are `DIRECT_LIVE share=201 notice=received open=ok deleted=ok` and `INVITE_LIVE create=201 code_open=ok claim=201 confirm=201 deleted=ok`. Neither is claimed here as run. Loopback does not prove real passkeys, real mail delivery, production GCS lifecycle timing or cross-instance budget enforcement. Live test writes to a shared system of record are not permitted; use an appropriate test mode or leave that leg unproven.
