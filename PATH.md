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

Success requires `OTIO_PATH_OK`, decoded playback observations, encrypted comment persistence, and agent readback after a revision. Unsupported codecs, effects, schemas, and ambiguous revision mappings must be explicit. All proof writes target local in-memory services.

The complete source path passed locally at `5a4bd6d` with Node 24.15.0, Bun 1.4.3, and the owned Chromium headless shell 1228. It exercised the original archive/playback/encrypted-feedback/revision stages, both exact-identity sidebar reveals after 40 coincident UI comments, and the zero-mail assertion, ending `OTIO_PATH_OK`. The matched old renderer failed the exact marker-center reveal assertion after the same 40 UI posts. Release qualification, CI, deployment, and the published npm client remain separate gates.

# Anchored comment popovers on every class

A verified reader who selects, points at or marks a target on any relic class writes the comment in a panel attached to it, and after Post the same place shows the posted comment's card while the sidebar stays as it was.

## Acceptance command

The implementation provides this loopback-only proof across all 9 classes:

```sh
mise exec -- bun packages/relic-mcp/test/comment-popover-path.ts
```

Success requires `COMMENT_POPOVER_PATH_OK classes=9`, attached composers and posted comment cards on every class, verified §5.8 assertions (adjacency, horizontal alignment, no overlap, anchor exposure, usability, preference, capped scrolling, follow tracking), and negative control verification against origin/main 76269ed5.
