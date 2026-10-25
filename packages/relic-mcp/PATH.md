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

## OpenTimelineIO end-to-end path

Run the full source proof from the repository root with an explicit Chrome:

```bash
RELIC_OTIO_PATH_CLIENT=source \
RELIC_OTIO_CHROME_PATH="$(command -v google-chrome)" \
env -u DISPLAY -u WAYLAND_DISPLAY \
  bun packages/relic-mcp/test/otio-path.ts
```

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
DECISION_LIVE_OK relic=<id> client=relic-mcp@<version>
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
