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

Success requires `OTIO_PATH_OK`, decoded playback observations, encrypted comment persistence, agent readback after a revision, and viewport geometry receipts and screenshots for the bottom-anchored timeline in light and dark. The proof also covers short viewports, mobile inspector states, blocked previews, exact marker reveal and the attached composer. Set `RELIC_OTIO_SHOTS_DIR` to retain the artifacts. Unsupported codecs, effects, schemas, and ambiguous revision mappings must be explicit. All proof writes target local in-memory services.

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

# GCS stored-byte digest proof

**Blocked: do not dispatch the proof or run its provisioning script.** GCS does not offer an atomic bucket deletion precondition tied to an immutable bucket generation. A bucket can be replaced between an identity check and a name-based delete. Cleanup therefore refuses to mutate an extant bucket, and provisioning must fail before creating a bucket while safe cleanup cannot be proven. The real-GCS path and automatic cleanup are unproven.

Once that blocker is resolved and the trusted workflow is available on `main`, dispatch it from the candidate branch checkout with its pull request open:

```sh
gh workflow run gcs-proof.yml --ref main \
  -f candidate_sha="$(gh pr view --json headRefOid --jq .headRefOid)" \
  -f pr_number="$(gh pr view --json number --jq .number)"
```

Find the dispatch with `gh run list --workflow gcs-proof.yml --branch main`, set `RUN_ID` to its run ID, and run:

```sh
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --log
```

The default includes the 500 MiB upload. A run with `large_object=false` does not prove that path. Once the blocker is resolved, acceptance of a default run requires all of these markers for the same run attempt:

- `GCS_PROOF_PROVISIONED bucket=... account=... account_uid=... expires=...`
- `GCS_PROOF_POLICY_VERIFIED bucket=... account=...` and `GCS_PROOF_SCOPE_VERIFIED account=...`
- `GCS_PROOF_EXERCISE_NO_OIDC` and `GCS_PROOF_HANDOFF_OPENED`
- `GCS_PROOF_REVOKED account=...`, `GCS_PROOF_BUCKET_GONE ...`, `GCS_PROOF_ACCOUNT_GONE ...`, and `GCS_PROOF_RESOURCES_GONE bucket=... account_uid=...`
- `GCS_PROOF_VERIFIED candidate=... gcs_blob=... bucket=... account_uid=...`

Match the candidate SHA to the PR head and the bucket, account and account UID across the markers. The final marker must require the digest checks, revocation and verified cleanup. A failed or cancelled run is not a successful proof, even if cleanup succeeds.

The design calls for a unique bucket and service account per attempt. Candidate code must run in a job without GitHub OIDC request credentials or deployer credentials; a separate job seals its account token to an exercise-runner key before artifact transfer. The account can use or disclose its token and can sign as itself during its conditional grant. The account's grants have a two-hour lease; token expiry alone is not the boundary. See `docs/design/operations.md` for the cleanup blocker and the intended scope checks.

After a change to the workflow, live GCP authorization, the cross-job handoff, revocation and cleanup require a run from the merged `main` revision. A local fake or an earlier run does not prove those paths. The workflow needs two runners available at once for mint and exercise.
