# Relic: the service surface

What the app server returns, when it returns it, what a relic's life looks like from the server's side, how a takedown works, and what Relic publishes about itself before anybody publishes anything.

`docs/frame.md` and `docs/preconditions.md` are locked inputs. `docs/spec/format.md` is a sibling and its decisions are inputs here, cited where they bind. Nothing in this document reopens any of them. Items belonging to `shape` are routed in section 7 with what `shape` must pick.

## 1. The status taxonomy

One taxonomy, one set of codes, for every caller. The publishing client and a browser can reach the same endpoint, and a taxonomy that varies by caller is a bug generator.

This section owns failures the **app server originates**. A purely local file error, a failure on the client-to-GCS upload leg, and a storage-side refusal have no app-server status, because the server is structurally not in those legs (`docs/preconditions.md` section 4). Those are `spec-publish-contract`'s codes. Their absence here is deliberate. The twelve cases in 1.1 are this unit's completeness bar; 1.6 adds the grant-time refusals `format.md` obliges the server to make, which the twelve don't reach and which belong here for the same reason the twelve do. 1.7 adds the republish refusals on the same grounds. 1.8 adds the mint version selector's validation refusal.

### 1.1 The twelve cases

| # | Case | Status | `code` |
|---|---|---|---|
| 1 | ID was never issued | `404` | `relic_not_found` |
| 2 | Expired past a publisher-set lifetime | `410` | `relic_expired` |
| 3 | Deleted for abuse | `410` | `relic_removed` |
| 4 | Deleted under legal process | `410` | `relic_removed` |
| 5 | Blocklist hash match | `410` | `relic_removed` |
| 6 | Grant expired with no object | `410` | `relic_never_published` |
| 7 | Declared size over cap at grant time | `413` | `size_over_cap` |
| 8 | Publish rate limited | `429` | `publish_rate_limited` |
| 9 | Mint rate limited | `429` | `mint_rate_limited` |
| 10 | Per-object download cap exhausted | `410` | `download_cap_exhausted` |
| 11 | Egress kill switch engaged | `503` | `service_paused` |
| 12 | Malformed renderer class, client name, `ttl_days`, or `title` | `400` | `invalid_publish_metadata` |
| 13 | Malformed or invalid cover payload | `400` | `invalid_cover` |

Case 6 is a relic whose publisher took a grant and never uploaded. It gets `410` rather than `404` because the ID is spent against new grants: the server never overwrites and refuses a grant for an ID that already exists (`format.md` 1.4), so no stranger can ever take the id and a fresh publish can never fill it. Exactly one holder can revive it, the publish token's, because a republish needs only the row and a valid token and lands its v2 object at the versioned path (`format.md` 3.12); `relic_never_published` remains the mint answer only while the current version has no bytes. Its own code tells a publishing client that lost its confirmation that the upload never landed, which is a different instruction from "you mistyped."

Case 7 uses `413`, and the honest comparison is against `422`. `413` is defined in terms of the request: it means the server refuses to process "because the request content is larger than the server is willing or able to process" ([RFC 9110 §15.5.14](https://www.rfc-editor.org/rfc/rfc9110.html)). The grant request's content is small; what's oversized is the object it declares, so `413` is a stretch on the letter. `422` is the status that fits the letter, and nothing here bans it: it covers the case where the server "understands the content type of the request content" and "the syntax of the request content is correct, but it was unable to process the contained instructions" ([RFC 9110 §15.5.21](https://www.rfc-editor.org/rfc/rfc9110.html)). A grant declaring an over-cap object is syntactically perfect and semantically unprocessable, which is that sentence exactly.

**`413` still wins, and not because client libraries route it.** They don't: 1.5 fixes publishing clients on `code`, so the status is never what a client branches on. The status is what everything *without* the problem document reads. A load balancer access log, a proxy, an uptime check, and an operator glancing at a dashboard all see a bare number, and `413` says "too big" to every one of them where `422` says only "something was wrong." Being wrong on the letter costs a spec objection; `422` costs legibility in every status-only surface, and 1.2 already names those as the place a distinction is hardest to keep. `422` would also be the natural status for case 12's malformed metadata, and handing one status to two structurally unrelated refusals reintroduces the exact conflation 1.2 pays a real price to accept once.

**The app server never emits `401` or `403` on any public endpoint, with recorded exceptions: `403 invalid_publish_token` on republish (1.7), cover upload (1.10), and publisher share (1.11); the reader share endpoint's `401 sign_in_required` and `403 invalid_share_proof` (1.11); the comment-write endpoints' `401 invalid_session` and `403 comment_forbidden` (1.9); the decision endpoints' `401 sign_in_required`, `403 decision_requires_reader`, and `403 invalid_share_proof` (1.14); the passkey enrollment endpoints' `401 sign_in_required`, `401 passkey_fresh_link_required`, and `403 passkey_verification_failed` (1.15); the passkey sign-in endpoint's `401 passkey_sign_in_failed` (1.15); and the typed sign-in code endpoint's `401 sign_in_code_failed` (1.16).** Claude Code "marks a remote server as needing authentication when the server responds with `401 Unauthorized` or `403 Forbidden`" ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)), which would push publishers at an authorization server that doesn't exist. `docs/preconditions.md` locks this for rate limiting; this document widens it to the whole public surface, because a rule scoped to one condition gets violated by the next author who adds a different one. The exceptions are safe because the app server is not an MCP transport and never becomes one: the publishing client is a local stdio binary, and what it relays to the model is the problem document, never a bare status, so the Claude Code behavior never sees these statuses on a connection it reads. A wrong bearer credential is also the textbook meaning of `403`, and dressing it up to protect a rule about a different surface would misreport the one failure a republishing publisher, an authorized reader, or a commenter can genuinely hit. The exceptions stop at those endpoints and are not a license for the next endpoint to return `403` for load shedding. The operator delete and admin surface (section 4) sits under the already-reserved `api` prefix (`format.md` 1.5), so it needs no append to that table and no comparison against issued IDs. It's never reached by any client in the product, and it returns `401` and `403` normally.
**1.10 The cover upload and serving endpoints.**
Cover upload: `POST /api/relics/{id}/cover`. Authorized by the bearer `publish_token` in the request body. Request body is JSON: `{ publish_token, version, kind, type, data }`. Refusals: `503 service_paused` if the kill switch is engaged; `429 publish_rate_limited` if rate limited; `400 invalid_relic_id` if the relic id fails validation; `410 relic_removed` if tombstoned; `404 relic_not_found` if no row exists; `400 invalid_cover` if the body exceeds 720,000 bytes, JSON parsing fails, base64 decoding fails, or `validateCoverRaster` fails (dimensions not 1200x630, size over 524,288 bytes, invalid format, non-standard chunks, or trailing data); `403 invalid_publish_token` if the token hash fails constant-time comparison; `409 stale_version` if the version does not equal `row.version`. Stores the raster at `m/cover/{id}/{sha256}`.
Cover serving: `GET|HEAD /{id}/cover/{sha256}.{png|jpg}`. Content-addressed by the SHA-256 of the validated raster bytes. If the relic is tombstoned, expired, unknown, `row.cover` is missing, `cover.version` does not match `row.version`, the hash or extension does not match, or store reading fails, returns `404` with `cache-control: no-store`. On success, returns `200` with headers: `content-type: <cover.type>`, `content-length: <n>`, `cache-control: public, max-age=86400`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer`, `x-robots-tag: noindex`. The cover route never mints download URLs, increments no open counters, and does not consume the download cap.

### 1.2 Cap exhaustion, and the cost accepted

A relic whose per-object download cap is spent is a genuine collision: it isn't a rate limit, because waiting never helps, and the object still exists.

**It returns `410` with code `download_cap_exhausted`.** The test `410` actually states is permanence, not absence. It "indicates that access to the target resource is no longer available at the origin server and that this condition is likely to be permanent", and it hands the uncertain case straight to `404`: "if the origin server does not know, or has no facility to determine, whether or not the condition is permanent, the status code 404 (Not Found) ought to be used instead" ([RFC 9110 §15.5.11](https://www.rfc-editor.org/rfc/rfc9110.html)). Relic knows. The cap has no reset window, so the server reads permanence off its own counter rather than guessing, and access is over for good even though the object is still sitting there. That's the distinction `410` draws and the reason `404` is wrong here. The section's second half holds too: the server owners "desire that remote links to that resource be removed", because the link is spent and holders should stop passing it around. `403` is the semantically closest alternative and 1.1 bans it from every public endpoint. `429` with a long retry-after is a lie the client acts on. A `200` with an error body breaks caching, monitoring, and uptime checks.

**The cost accepted:** cap exhaustion, expiry, and all three flavors of deletion share one status, so no view that groups by HTTP status distinguishes them, ever, and no later query undoes that. Relic pays it with one rule: **the mint log records the `code`, not only the status**, and every operator dashboard, alert, and abuse metric keys on `code`. The same applies at the edge, where a load balancer's own access log is often status-only. If the edge cannot log the code, the app's mint log is the only place the distinction survives, and it becomes a retention-window dependency rather than a convenience.

**So the mint log gets a specified record shape, the same as the tombstone does.** One record per mint attempt, granted or refused, carrying: the normalized relic ID (normalized before keying, per section 6, or every counter fragments across spellings); the requesting IP; the app server's own timestamp (section 3); the endpoint; the outcome as `granted` or `refused`; the `code` on every refusal; whether the attempt counted as an open and, when it didn't, which rule dropped it (publishing-IP match, post-publish window, or dedup); whether it consumed the per-object cap; and the cap remaining afterward. The renderer class, publishing client name, optional plaintext title, and cover image metadata (uploaded by default and declined with `cover: false`) stay on the relic row and join by ID, because a second copy in the log could only disagree with the first. This one log answers both the frame's success metric and the operational health checks, and keys on ID rather than IP so the join works.

### 1.3 Expired, never published, and never issued

**They're distinguished.** `format.md` 1.2 fixes the ID at full bearer-token entropy, floored at 122 bits, and states the consequence directly: "Because the ID is unguessable, an expired relic and a relic that never existed **may be distinguished**." Only somebody already holding a valid ID can ask the question, and holding it means they were handed the link.

**The split is three way, not two.** `404 relic_not_found` is an ID the server never issued. `410 relic_expired` is one that lived and ran out, which only a relic whose publisher set a lifetime can ever be; one published without a lifetime never expires and never returns it. Case 6's `410 relic_never_published` sits between them: issued, granted, never filled. That middle state isn't a choice made here. It exists because `format.md` 1.4 refuses to overwrite, which is what makes a spent-but-empty ID permanent rather than pending, and a pending one would not deserve a terminal status at all (1.6).

Against a short ID this would be an enumeration oracle, letting a stranger walk the space and harvest a map of live IDs plus the operator-conceded metadata. That design was rejected in `format.md` and this document doesn't reopen it. What distinguishing buys is the support stream the frame named when it ruled out burn-after-reading: "the link is dead" becomes an answerable question instead of a mystery. The honest limit is that the server never sees the fragment, so it can't tell a real recipient from a scanner, and the informative `410` is served to both. That costs nothing, because the scanner already had the URL.

### 1.4 Takedown disclosure

**The fact of removal is disclosed. The reason is not.** Abuse takedown, legal-process takedown, and blocklist-hash match all return `410` with `relic_removed`, and the tombstone (section 4) records which one privately.

Disclosing the fact is non-optional: a publisher removed in error has no reason to appeal a relic they believe simply expired, so concealing removal deletes the appeal path. Telling an abuser their campaign was caught costs nothing, because they learn it by clicking their own link within seconds.

Withholding the reason is the sharper half. A system that normally names the reason cannot go quiet on one takedown without the silence itself being the disclosure, which is exactly the position a legal order can put the operator in. A uniform code is the only shape that stays safe under an order forbidding confirmation. It also keeps the operator from narrating process to the world. The publisher who wants the reason gets it from a human at `/abuse`, where the operator can answer or decline case by case.

### 1.5 The machine-readable shape

Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html) problem details, served as `application/problem+json`. Without a stable machine-readable code a client string-matches human prose and breaks on the first copy edit, and RFC 9457 says so about its own `detail` member: "Consumers SHOULD NOT parse the 'detail' member for information."

Standard members: `type` (URI reference, the normative identifier), `title` (short, and it "SHOULD NOT change from occurrence to occurrence of the problem"), `status` (mirrors the HTTP status), `detail` (human prose, never parsed), `instance` (an opaque per-occurrence identifier, never the request path).

**`instance` carries an occurrence id, which is the entire point of the member.** RFC 9457 asks for "a URI reference that identifies the specific occurrence of the problem", and says that where it isn't dereferenceable "it serves as a unique identifier for the problem occurrence that may be of significance to the server but is opaque to the client." The request path fails that on its face: every failure on one relic has the identical path, so spending `instance` on it throws away the one member designed to join a support report to a log line. Relic emits `https://<relic-domain>/problems/occurrences/<occurrence-id>`, generated per response, not dereferenceable, and written to the mint log record from 1.2. A reporter pasting it into `/abuse` points the operator at exactly one line.

Extension members, which are the fields a client extracts:

- **`code`** the bare token from this section's refusal tables. `type` is `https://<relic-domain>/problems/` concatenated with `code`, generated from one table so the two can never disagree. `code` exists alongside `type` because a bare token survives a domain change and a URI tail invites clients to parse it. The `problems/` prefix these two members share needs no append to `format.md` 1.5's reserved table: an ID is exactly one path segment at the root, every one of these URIs carries a second segment, and nothing is ever served at `/problems` as a bare segment.
- **`id_validation_failure`** on `invalid_relic_id`, one of `alphabet`, `length`, or `reserved`, naming which of `format.md` 1.3's three checks the submitted ID failed.
- **`retry_after_seconds`** integer, on `429`, on `503`, and on `relic_not_yet_published` (1.6). It mirrors the `Retry-After` header, which stays authoritative. The `429` definition only says a response "MAY include a Retry-After header indicating how long to wait before making a new request" ([RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585.html)); Relic always sends both. Comment writes, auth sign-in requests, and sign-in code submissions reuse it on `comment_rate_limited` and `auth_rate_limited` (1.9, 1.16).
- **`size_limit_bytes`**, **`declared_size_bytes`**, **`size_basis`** on `size_over_cap`. `size_basis` is `plaintext` or `ciphertext`. `format.md` 3.11 requires the published number be a plaintext number a user can check with `ls`, and `shape` picks the enforced side, so without this field a client can't tell a user which number to compare.
- **`relic_id`** the normalized ID, echoed on every relic-scoped error.
- **`download_cap`** on `download_cap_exhausted`. The cap value is published policy, so echoing it leaks nothing.
- **`report_url`** on `relic_removed`. This is the field that makes the appeal path in 1.4 real.
- **`comment_id`** on `comment_not_found` and `comment_forbidden` (1.9). Echoed so a client can tell a missing comment from a missing relic without parsing `detail`.

Clients ignore members they don't recognize, per RFC 9457. `spec-publish-contract` defines its own codes, in this same shape, for the legs the app server is not in, and those codes never collide with the ones fixed in this section.

**The status must be correct at the deployed edge, not only in the application.** Anything in front that sheds load carries its own default status and body, and that's what the client sees. Where the edge can't produce a problem document, the contract degrades rather than breaking: a bare `429` is read as `mint_rate_limited` or `publish_rate_limited` by endpoint, and a bare `503` as `service_paused`. Driving the deployed limiter and asserting the status and media type is a launch check, not a unit test.

### 1.6 The grant-time refusals `format.md` obliges

`format.md` obliges the server to make four refusals the twelve cases don't reach: three ID validations at mint, against the alphabet, the fixed length, and the reserved table (`format.md` 1.3), and the collision refusal (`format.md` 1.4). A fifth grant-time state has the same gap and no owner at all, a mint on an ID whose object hasn't landed. A sixth comes from `spec-publish-contract`, whose grant request carries a server-issued challenge nonce that can be dead by the time the grant arrives. Every one of them is app-server-originated, so they're this document's rather than `spec-publish-contract`'s, and case 12 already establishes that grant-time validation is in scope. A publishing client cannot act on a refusal that has no code.

| Case | Status | `code` |
|---|---|---|
| Client-supplied ID fails the alphabet, the fixed length, or the reserved table (`format.md` 1.3) | `400` | `invalid_relic_id` |
| Grant requested for an ID that already exists (`format.md` 1.4) | `409` | `relic_id_collision` |
| Mint requested on an ID whose grant is live and whose object hasn't landed | `409` | `relic_not_yet_published` |
| Grant presenting a challenge nonce that expired or that the server never issued (`spec-publish-contract`) | `409` | `invalid_challenge_nonce` |

One code covers `format.md` 1.3's three checks, because the client's correct response to all three is identical and it's a client defect rather than something to retry. `id_validation_failure` (1.5) names which check failed, for the log line and the bug report.

**`relic_id_collision` is the code a client keys redraw-and-retry on.** `format.md` 1.4 states the obligation directly, "The client draws a new ID and retries", and that retry has to hang off something matchable. It hangs off this code. `409` because RFC 9110 defines it as "a conflict with the current state of the target resource" used in "situations where the user might be able to resolve the conflict and resubmit the request" ([RFC 9110 §15.5.10](https://www.rfc-editor.org/rfc/rfc9110.html)), which describes drawing a fresh ID exactly. It isn't `400`, because the submitted ID was well formed and the client did nothing wrong. Repeated collisions from one source are what a fixed seed looks like from outside, so the mint log's `code` field is also the detector `format.md` 1.4 asks for.

**`relic_not_yet_published` closes the race case 6 leaves open.** A publisher who shares the link before the upload finishes sends a recipient to an ID whose grant is live and whose object isn't there yet. Case 6 covers only the terminal version of that, where the grant expired and nothing ever landed. This one is temporary, the caller should simply wait, and it carries `retry_after_seconds` like every other retryable refusal. The viewer says the relic is still uploading, never anything that reads as a dead link, for the same reason the delete-mint race in 3.2 must not read as a bad key.

**`invalid_challenge_nonce` is the code a client keys a fresh challenge on.** `spec-publish-contract`'s grant request carries a nonce this server issued and dated, so a grant can arrive holding one that expired or one the server has no record of issuing, and neither can be granted. One code covers both, on the same reasoning that gives `format.md` 1.3's three checks one code: the client's correct response is identical either way, which is to discard the dead nonce, take a fresh challenge, and resubmit the grant. `409` because RFC 9110's definition turns on what the caller does next, naming the situations where the user "might be able to resolve the conflict and resubmit the request" ([RFC 9110 §15.5.10](https://www.rfc-editor.org/rfc/rfc9110.html)), which is that resubmission exactly. **The cost is the definition's first sentence**, which reads the conflict as "a conflict with the current state of the target resource", and this conflict is with the server's live-challenge state rather than with the relic being minted. It's paid rather than hidden, because both alternatives are worse where it counts. `400` fits the letter and misroutes the outcome: this document's other two `400`s name a client defect, and a publisher whose challenge expired mid-publish did nothing wrong and has a working next step. `422` is the other candidate and 1.1 already priced it, since it says only "something was wrong" in every status-only surface, where `409` says a conflict the caller can resubmit past. `401` and `403` are barred by 1.1 outright. **It carries no `retry_after_seconds`**, because there's nothing to wait out: the nonce is dead now, and the challenge endpoint answers under its own limiter, so a number here would be the lie 1.2 refuses to send.

### 1.7 The republish refusals

Republish-to-same-URL exists, authorized by a bearer publish token, and the endpoint has exactly two refusals of its own plus every refusal the id and the request body can already produce (`size_over_cap`, `publish_rate_limited`, `service_paused`, `invalid_publish_metadata`). The endpoint is `POST /api/relics/{id}/republish`. `spec-publish-contract` owns the client half, including what the body carries.

| Case | Status | `code` |
|---|---|---|
| Missing or wrong `publish_token` | `403` | `invalid_publish_token` |
| Tombstoned id, whatever token is presented | `410` | `relic_removed` |
| Non-boolean `notify` or malformed `share_verifier` | `400` | `invalid_publish_metadata` |

**The `notify` and `share_verifier` request body members.** `POST /api/relics/{id}/republish` accepts optional `notify` (boolean) and optional `share_verifier` (a 64-character lowercase hex string). If `notify` is present and not a boolean, the server refuses with `400 invalid_publish_metadata` with `{ relic_id }`. When omitted, `notify` defaults to true; when true, change notices are scheduled for announcement once the new version is verified in storage (section 8). When `notify: false`, notices are suppressed for this version. If `share_verifier` is present and not exactly 64 lowercase hex characters (`/^[0-9a-f]{64}$/`), the server refuses with `400 invalid_publish_metadata` with `{ relic_id }`. Republish overwrites `shareVerifier` on the relic row when present and leaves it unchanged when absent. The initial publish endpoint `POST /api/relics` likewise accepts optional `share_verifier` matching `/^[0-9a-f]{64}$/`, else `400 invalid_publish_metadata`, stored on `RelicRow` as `shareVerifier?: string | undefined`. `share_verifier` is never returned by any endpoint.

**`relic_removed` outranks a valid token.** The tombstone check runs before the token check, so a taken-down relic answers `410 relic_removed` forever, whatever credential is presented. This is the rule that keeps delete-by-ID an abuse control rather than a speed bump: if a takedown could be out-lived by the next version, an abuser would simply republish through every deletion, the operator's SLA would measure a treadmill, and section 4's whole posture would be theater. Takedown is terminal across all versions, and this endpoint is where that terminality is enforced rather than merely stated.

**A valid token on a live relic produces the next version.** The row's version increments, the object lands at the versioned path (`format.md` 3.12) under that path's own existence refusal, the renderer class is redeclared with the new ciphertext, and the response mirrors the grant: a signed upload target and its constraints, with `version` returning the new version number (`next.version`). The version's digest is not known yet, because the ciphertext has not been uploaded; upload completion (2.1) returns it. The per-IP publish quota and the kill switch apply to republish exactly as to publish, because a version costs the same storage and the same abuse surface a first publish does, and an endpoint outside the quota would be a quota bypass wearing a different verb.

### 1.8 The mint version refusal

`POST /api/relics/{id}/mint` accepts an optional JSON body with `version`. When present, `version` must be an integer from 1 through the relic's current version, inclusive. Zero, a negative number, a number above the current version, a fractional number, and a value of any other type return `400 invalid_relic_version`. The refusal carries `relic_id`, does not consume the download cap, and is recorded as a refused mint. It is not clamped, because silently serving different bytes from the ones requested would make a version comparison untrustworthy.

### 1.9 The comment refusals

Comments exist. The endpoints are `GET`, `POST`, and `PATCH /api/relics/{id}/comments/{comment_id}`, plus `DELETE /api/relics/{id}/comments/{comment_id}`. Sign-in lives at `POST /api/auth/request`, `POST /api/auth/code`, and `GET /api/auth/callback`. Section 8 owns the surface; this subsection owns the codes.

| Case | Status | `code` |
|---|---|---|
| Comment body is missing, empty, not base64url, or over the transport cap | `400` | `invalid_comment` |
| No such comment on this relic | `404` | `comment_not_found` |
| Comment write rate limited | `429` | `comment_rate_limited` |
| Presenting a session that is missing, spent, or expired, or a publish token that does not match | `401` | `invalid_session` |
| Deleting a comment you did not author | `403` | `comment_forbidden` |
| Editing or resolving a comment that is not yours, or resolving one you may not settle | `403` | `comment_forbidden` |
| A patch request with neither `ciphertext` nor `resolved` present | `400` | `nothing_to_change` |
| Sign-in request rate limited | `429` | `auth_rate_limited` |

**The server cannot read a comment, so `invalid_comment` is a transport check, not a content check.** `format.md` 3.13 puts the comment key behind the fragment and caps the plaintext at 4096 bytes of body and 64 bytes of display name, enforced in `@relic/format` before encryption. Ciphertext is opaque here. The one property this server can test is that the body is unpadded base64url and under a character cap that exists only to stop an unbounded write from reaching the store. A well-formed ciphertext of a body that already failed the plaintext cap is accepted, because rejecting it would require decrypting it.

**Comment writes have an existing optional `version` contract.** Omitted `version` stamps the relic's current revision. An explicit `version` must be a safe integer from 1 through the current revision, inclusive; any other value returns `400 invalid_relic_version`. The server cannot inspect the encrypted anchor, so it cannot derive or validate an anchor revision itself.

**The list is unauthenticated.** Anybody holding the link can already fetch and decrypt the relic, and every comment body is ciphertext derived from the same fragment key, so an authenticated read would narrow who can fetch bytes the server cannot read either way. A tombstoned relic still answers `410 relic_removed` on the list, because serving a discussion of content the operator was obliged to remove is the same disclosure by a longer route.

**A write is attributed, not authorized.** Two paths, because an agent has no mailbox and the feature is worth little if the publishing side cannot answer back. A valid `publish_token` stores the author as the literal `publisher`. A valid session cookie stores the verified email address. Either missing or wrong is `401 invalid_session` rather than `403`, except on delete of somebody else's comment, which is `403 comment_forbidden`: the caller is identified and is forbidden, which is the textbook split. Anybody holding the link plus any real mailbox can comment. A verified address is not an access control, and `frame.md`'s identity entry states that outright so nobody reads it as one.

**The patch carries two fields with different owners.** `ciphertext` replaces the sealed body and is authorized the same way delete is: the comment's author, by the strict split already stated (a verified session whose address equals the stored author, or the relic's publish token when the author is the literal `publisher`). `resolved` sets or clears the resolution and is authorized for the comment's author or the publish token, because a publisher settling feedback on their own relic is the point the state exists for. A mismatched body ciphertext is refused as `invalid_comment`, a mismatched author as `403`, and a body with neither field present as `400 nothing_to_change` rather than a silent no-op.

**`POST /api/auth/request` always answers `202`.** A different answer for a known and an unknown address would turn the endpoint into an address oracle. Mail is sent only when the address looks like one; garbage is swallowed. The endpoint always sets an HttpOnly, Secure, SameSite=Strict cookie binding a typed code to this browser (`relic_sign_in_request`, Path=/api/auth/code), for valid addresses, garbage, a missing email, no mailer, and a provider refusal alike (a 429 sets no cookie). The plaintext address reaches the mailer, which is not avoidable: mail cannot be sent to a hash. `frame.md` names this as one of identity's prices.

**There is no per-comment operator surface.** The operator's route to removing a comment is deleting the relic, which takes the whole thread with it (section 4). A per-comment moderation endpoint would be a permissions capability, which is still a locked non-goal.

### 1.11 The share refusals

`POST /api/relics/{id}/share` registers email addresses to receive change notices when the relic is republished. The service accepts two authorities, and exactly one authority must be present:
- Publisher authority: `{ publish_token: string, emails: string[] }`
- Reader authority: `{ share_proof: string, emails: string[] }` where `share_proof` is unpadded base64url of the 32 proof bytes (`format.md` 3.14), accompanied by a valid `relic_session` cookie (reusing the session lookup from the comment endpoints).

Both or neither authority present returns `400 invalid_share`.

Checks run in this exact order:
1. Kill switch: `503 service_paused` with `retry_after_seconds: 300` when the egress kill switch is engaged.
2. IP rate limit: `limiter.check('share ' + ip, config.shareRateLimit, now)` with `shareRateLimit: {limit: 30, windowSeconds: 3600}`: `429 share_rate_limited` with `retry_after_seconds`.
3. Relic ID validation: `parseRelicId` failure returns `400 invalid_relic_id`.
4. Tombstone check: tombstoned relic returns `410 relic_removed` with `relic_id` and `report_url`.
5. Existence check: no row in the store returns `404 relic_not_found` with `relic_id`.
6. Authority validation:
   - If both or neither authority is present, return `400 invalid_share` with `relic_id` and `share_max_per_call`.
   - Publisher path: `publish_token` missing, or `timingSafeEqual(sha256Hex(token), row.publishTokenHash)` fails: `403 invalid_publish_token` with `relic_id`.
   - Reader path:
     - Missing or invalid session cookie: `401 sign_in_required` with `relic_id`.
     - `row.shareVerifier` absent: `409 share_unavailable` with `relic_id` and detail "This relic was published before sharing existed. Its publisher can republish it to turn sharing on."
     - `share_proof` not unpadded base64url of exactly 32 bytes: `400 invalid_share` with `relic_id` and `share_max_per_call`.
     - `timingSafeEqual(sha256Hex(proof), row.shareVerifier)` fails: `403 invalid_share_proof` with `relic_id`.
     - Per-sharer rate limit: `limiter.check('share-reader ' + relicId + ' ' + sessionEmail, config.readerShareRateLimit, now)` with `readerShareRateLimit: {limit: 10, windowSeconds: 3600}`: `429 share_rate_limited` with `retry_after_seconds`.
7. Expiry and cap checks: expired past a publisher-set lifetime returns `410 relic_expired` with `relic_id`. Download cap spent (`mintsUsed >= config.downloadCap`): `410 download_cap_exhausted` with `relic_id` and `download_cap`.
8. Email validation: `emails` is not an array, is empty, exceeds `config.shareMaxPerCall` (20), holds a non-string, or holds an entry that fails `looksLikeEmail(entry.trim())`: `400 invalid_share` with `relic_id` and `share_max_per_call`. The detail names the first bad index.
9. Quota check: capacity is reserved atomically via compare-and-swap on the relic row (`sharesCount`), counting only actual new inserts against `config.shareMaxPerRelic` (50). If the reservation exceeds the cap: `409 share_limit_reached` with `relic_id`, `share_limit` (50), and `shared_count`. If a write fails or an address was already present, unneeded reserved capacity is released.

Only after every check passes and capacity is reserved, call `putShare` for each new address. If a concurrent delete tombstones the relic while a share write is in flight, the shares are swept and `410 relic_removed` is returned. Nothing is written on a refusal.
Success response: status `200` with JSON:
```json
{"relic_id":"<id>","emails":["<normalized, deduped, request order>"],"added":2,"shared_count":7,"share_limit":50,"title":"<row.title or null>"}
```

Problem details extension fields: `share_limit`, `shared_count`, and `share_max_per_call`.

Storage: `ShareRow` records `{ relicId, address, addedAt, sharedBy }` where `sharedBy` is `'publisher' | 'reader'`. The sharer's address is not stored on the row; attribution of who shared is not kept beyond the in-memory rate limiter. A re-share of an existing address keeps the first row. No endpoint ever returns the share list or the opt-out list.

### 1.12 The unsubscribe link

`GET|HEAD|POST /api/relics/{id}/unsubscribe?addr={64 hex}&token={base64url}` allows a recipient to stop all emails (comment notifications, reply notifications, owner alerts, and change notices) for a relic.

- **No kill-switch check.** Stopping mail always works, even when the egress kill switch is engaged. Cookies and request body are ignored.
- **Rate limit.** `limiter.check('unsubscribe ' + ip, config.unsubscribeRateLimit, now)` with `unsubscribeRateLimit: {limit: 60, windowSeconds: 3600}`: refusal is a `429` HTML page with a `retry-after` header.
- **Link validation.** Bad id, `addr` not matching `/^[0-9a-f]{64}$/`, missing token, or an HMAC that fails `timingSafeEqual`: `400` HTML page reading "This link does not work". Nothing is written.
- **Tombstoned or missing relic.** Valid link but the relic is tombstoned or has no row: `200` HTML page reading "Nothing to stop". Nothing is written.
- **Confirmation page.** Valid GET or HEAD: `200` confirmation page whose form posts to the same URL (escaping `&` as `&amp;` in the `action`). Nothing is written.
- **Execution.** Valid POST: `putOptOut({relicId, addressHash: addr, at: now})`, then `200` HTML page reading "Stopped" ("This address will get no more emails about {title}."). Never a 3xx redirect. If a delete tombstones the relic while an opt-out write is in flight, the opt-out record is swept so no late write survives deletion.
- **Per-send opt-out check.** Notice fan-out checks each recipient's opt-out state immediately before each batch chunk or individual send via a single-key store read (`isOptedOut`). Once a stop POST answers 200, no later send to that address on that relic may begin.
  - `content-type: text/html; charset=utf-8`
  - `cache-control: no-store`
  - `referrer-policy: no-referrer`
  - `x-robots-tag: noindex`
  - `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`

**The token construction.** The token is:
`base64url(HMAC-SHA256(key = await store.unsubscribeKey(), utf8("relic-unsubscribe:v1:" + canonicalRelicId + ":" + addressHash)))`.
The link is:
`${config.serviceOrigin}/api/relics/${relicId}/unsubscribe?addr=${addressHash}&token=${token}`.
The unsubscribe key must never be deleted; it is generated once and stored permanently in the key vault/store so historical links remain verifiable.

### 1.13 Client IP derivation and trusted proxy hops

Every IP-keyed rate limit (publish, mint, comment writes, auth sign-in requests, auth sign-in code submissions, cover uploads, shares, and stop links) relies on an authenticated client IP rather than caller-supplied headers.

In production on relik.link, traffic arrives through a Google Cloud Global External Application Load Balancer in front of Cloud Run. The load balancer terminates public TLS and appends two IP addresses to the `X-Forwarded-For` header in order: the connecting client IP, followed by the load balancer forwarding rule IP (`<existing-value>, <client-ip>, <lb-ip>`).

To prevent rate limit bypass via caller-controlled headers, the server derives the client IP by counting hops from the right of `X-Forwarded-For`, configured by `trustedProxyHops`:
- **External Application Load Balancer (`trustedProxyHops = 2`, default):** the client IP is two hops from the right (index `-2`), ignoring any caller-supplied leading entries.
- **Direct Cloud Run (`trustedProxyHops = 1`):** the client IP is one hop from the right (index `-1`).
- **Local or dev without proxy (`trustedProxyHops = 0`):** `X-Forwarded-For` is ignored as untrusted; the server falls back to `X-Real-IP` or `127.0.0.1`.

Entries to the left of the trusted hop are caller-controlled and never trusted. If `X-Forwarded-For` contains fewer entries than `trustedProxyHops`, the request did not transit the expected proxy chain; the server falls back to `X-Real-IP` or `127.0.0.1` rather than trusting caller-supplied values.

### 1.14 The decision refusals

Decisions exist. The endpoints are `POST /api/relics/{id}/decisions/options`, `POST /api/relics/{id}/decisions`, and `POST /api/relics/{id}/decisions/list`. Section 9 owns the surface; this subsection owns the codes.

| Case | Status | `code` |
|---|---|---|
| Request presents a publish token (`publish_token` key present in body) | `403` | `decision_requires_reader` |
| Request body is malformed, not an object, invalid verdict, or malformed proof | `400` | `invalid_decision` |
| Relic was published before sharing and decisions were supported (`shareVerifier` absent) | `409` | `decision_unavailable` |
| Provided version digest does not match the server's digest on record | `409` | `decision_digest_mismatch` |
| Decision record or list requests rate limited | `429` | `decision_rate_limited` |
| No passkey registered for this verified address | `409` | `passkey_required` |
| Missing or invalid reader session cookie | `401` | `sign_in_required` |
| Share proof hash does not match stored verifier | `403` | `invalid_share_proof` |
| Requested version is not a safe integer in 1 through `row.version` | `400` | `invalid_relic_version` |
| Storage object for the version is not yet found in storage | `409` | `relic_not_yet_published` |
| Relic id does not exist | `404` | `relic_not_found` |
| Relic has been taken down by operator | `410` | `relic_removed` |
| Relic has expired past publisher-set lifetime | `410` | `relic_expired` |
| Egress kill switch engaged | `503` | `service_paused` |
| Relic id fails canonical format validation | `400` | `invalid_relic_id` |

**A decision requires a reader, never the publish token.** If the request body carries `publish_token`, the server refuses with `403 decision_requires_reader`. Decisions cannot be recorded by publisher authority or MCP tools; only a human reader in the viewer with a verified session and a passkey can record one.

**Key proof and reader authorization.** Both recording routes and the list route require proof of holding the decryption key. The caller presents `share_proof` (the unpadded base64url encoding of the 32-byte proof derived via HKDF-SHA256 with info `relic/share-proof/v1`). If `row.shareVerifier` is absent, the server returns `409 decision_unavailable`. If `share_proof` is malformed, it returns `400 invalid_decision`. If `timingSafeEqual(sha256Hex(proof), row.shareVerifier)` fails, it returns `403 invalid_share_proof`.

**Version digest verification.** Recording a decision presents `version_digest` matching `/^[0-9a-f]{64}$/`. If this does not match the server's digest on record for that version, the server refuses with `409 decision_digest_mismatch` carrying extension fields `relic_id`, `version`, and `version_digest`.

**Rate limits.** `limiter.check('decision ' + ip, config.decisionRateLimit, now)` with `{limit: 30, windowSeconds: 3600}`: `429 decision_rate_limited`. For the list endpoint: `limiter.check('decision-read ' + ip, config.decisionReadRateLimit, now)` with `{limit: 600, windowSeconds: 3600}`: `429 decision_rate_limited`.

**The list endpoint.** `POST /api/relics/{id}/decisions/list` takes `{ share_proof, version?: number | "*" }`. It is unauthenticated (no session cookie required), not gated by the kill switch, allowed on expired relics, and never touches `mintsUsed`.

### 1.15 The passkey refusals

Passkey registration, authentication, and sign-in exist for decision confirmation and returning-reader sign-in without email. The endpoints are `POST /api/auth/passkeys/options`, `POST /api/auth/passkeys`, `POST /api/auth/passkeys/sign-in/options`, and `POST /api/auth/passkeys/sign-in`. Section 9 owns the surface; this subsection owns the codes.

| Case | Status | `code` |
|---|---|---|
| Operation requires an enrolled passkey, but none is registered | `409` | `passkey_required` |
| Adding a passkey when one is already enrolled requires an assertion | `409` | `passkey_assertion_required` |
| Adding a first passkey from a session that a sign-in email (link or code) did not start within `passkeyFreshLinkSeconds` (default 900) | `401` | `passkey_fresh_link_required` |
| Passkey registration or assertion payload is malformed | `400` | `invalid_passkey` |
| Passkey signature, challenge, counter, or user verification failed | `403` | `passkey_verification_failed` |
| Passkey sign-in failed (unknown handle, bad signature, counter replay, or invalid challenge) | `401` | `passkey_sign_in_failed` |
| Passkey request rate limited | `429` | `passkey_rate_limited` |
| Missing or invalid reader session cookie | `401` | `sign_in_required` |

**Diagnostic checks via `passkey_check`.** Refusals carry a machine-readable `passkey_check` problem extension indicating which check failed:
- For `400 invalid_passkey`: `encoding`, `cbor`, `auth_data`, `algorithm`, `key`, or `shape`.
- For `403 passkey_verification_failed`: `challenge`, `type`, `origin`, `cross_origin`, `rp_id`, `user_present`, `user_verified`, `signature`, `counter`, `credential`, or `user_handle`.


> **`401 passkey_fresh_link_required`.** Only `POST /api/auth/passkeys/options` returns it, and only for an address with no passkey, after the session, rate-limit and body checks and before any challenge is written. The session must have been started by a sign-in email (following its link or typing its code) no more than `passkeyFreshLinkSeconds` ago. A session a passkey started never qualifies, and a session row without `via` predates passkey sign-in and counts as a link. The body has no extension and is the same for an old email-started session and a passkey session. An address with a passkey gets `mode: "assert"` whatever the session's age, so the refusal tells a session holder nothing about their own address that `mode` did not.
On `POST /api/auth/passkeys/sign-in`, any failure after the challenge is consumed yields `401 passkey_sign_in_failed` with no `passkey_check` extension, revealing nothing about whether the address or credential exists. Both sign-in endpoints require `content-type: application/json` and reject other content types with `400 invalid_passkey` (`passkey_check: 'shape'`).

**Rate limits.** `limiter.check(rateLimitKey('passkey', ip), config.passkeyRateLimit, now)` with `{limit: 20, windowSeconds: 3600}`: `429 passkey_rate_limited`. For passkey sign-in options: `limiter.check(rateLimitKey('passkey-sign-in-options', ip), config.passkeySignInOptionsRateLimit, now)` with `{limit: 240, windowSeconds: 3600}`: `429 passkey_rate_limited`, and `addressLimiter.check('passkey-sign-in-options-email ' + emailHash, config.passkeySignInOptionsAddressRateLimit, now)` with `{limit: 60, windowSeconds: 3600}`: `429 passkey_rate_limited`. For passkey sign-in: `limiter.check(rateLimitKey('passkey-sign-in', ip), config.passkeySignInRateLimit, now)` with `{limit: 30, windowSeconds: 3600}`: `429 passkey_rate_limited`, `addressLimiter.check('passkey-sign-in-email ' + addressHash, config.passkeySignInAddressRateLimit, now)` with `{limit: 30, windowSeconds: 3600}`: `429 passkey_rate_limited` for email-first sign-in, and `addressLimiter.check('passkey-sign-in-handle ' + handleHash, config.passkeySignInHandleRateLimit, now)` with `{limit: 30, windowSeconds: 3600}`: `401 passkey_sign_in_failed` for usernameless sign-in.

### 1.16 The typed sign-in code refusals

A sign-in email carries a six-digit code alongside the single-use link. A reader can type the code on the page that requested it to sign in without navigating away, preserving the decryption key in tab memory. The endpoint is `POST /api/auth/code`. Section 8 owns the sign-in flow; this subsection owns the codes and refusal rules.

| Case | Status | `code` |
|---|---|---|
| Request body is malformed, not JSON, missing code, or not six ASCII digits | `400` | `invalid_sign_in_code` |
| Sign-in code check rate limited by client IP | `429` | `auth_rate_limited` |
| Missing or invalid request cookie, unknown nonce, expired code, exhausted attempt budget, wrong code, spent link, or superseded code | `401` | `sign_in_code_failed` |

**One uniform failure code for all authentication failures.** Every failure on `POST /api/auth/code` after basic syntax and IP rate limiting returns `401 sign_in_code_failed` with no problem extensions. This covers a missing or malformed `relic_sign_in_request` cookie, an unknown or expired request nonce, an exhausted per-address code attempt budget, a non-matching code, a consumed or expired magic link, and a code superseded by a newer request. Because every failure returns the exact same 401 response, the endpoint provides no oracle: an observer cannot learn whether an address has a pending code, whether a code exists, whether it expired, or how many attempts remain.

**Endpoint processing order and rules.** `POST /api/auth/code` executes these steps in strict sequence:
1. IP rate limiting: `limiter.check(rateLimitKey('auth-code', ip), config.signInCodeRateLimit, now)` with `{limit: 30, windowSeconds: 3600}`: `429 auth_rate_limited` with `retry_after_seconds`.
2. Content type: `content-type` must start with `application/json` (case-insensitive); otherwise returns `400 invalid_sign_in_code`.
3. Body parsing: payload must be a non-array JSON object whose `code` property is a string. ASCII spaces and hyphens are stripped. The normalized code must match `/^[0-9]{6}$/`; otherwise returns `400 invalid_sign_in_code`.
4. Request cookie validation: reads the HttpOnly, Secure, SameSite=Strict `relic_sign_in_request` cookie. If absent or not matching `/^[A-Za-z0-9_-]{43}$/`, returns `401 sign_in_code_failed`.
5. Store lookup: fetches the code row by `signInRequestHash(nonce)`. If missing or `row.expiresAt <= now`, returns `401 sign_in_code_failed`.
6. Charge-before-compare budget check: charges one attempt to the address in the store using compare-and-swap via `reserveSignInCodeAttempt(row.addressHash, now, limit, windowSeconds * 1000)`. If the address has exhausted its budget (default 10 attempts per 86,400 seconds), returns `401 sign_in_code_failed`. The attempt is charged whether the code is right or wrong, and CAS failures throw rather than allow uncharged attempts.
7. Constant-time MAC comparison: compares `signInCodeMac(nonce, code)` against `row.codeMac` using constant-time comparison. If mismatched, returns `401 sign_in_code_failed`.
8. Conditional link consumption: atomically consumes the linked magic link via `consumeAuthLink(row.linkTokenHash)` and deletes the code row. If the link was already consumed or expired, returns `401 sign_in_code_failed`.
9. Success: returns `200` with `{"email": link.email}`, sets the reader session cookie (`via: 'code'`), sets the passkey offer marker cookie (`relic_passkey_offer=1`), and clears the `relic_sign_in_request` cookie.

## 2. Mint placement, the mint response, and counting

**The mint is never a side effect of serving `/{id}`.** That path returns a static shell with no mint, no counter increment, and no cap consumption. The mint is a distinct request the shell makes.

This single rule keeps non-executing fetchers off both the open counter and the download cap, and it costs nothing. Slack's fetcher is `Slackbot-LinkExpanding 1.0` and Slack states plainly, "We do not currently honor robots.txt files" ([Slack](https://api.slack.com/robots)). On Safe Links the evidence is weaker and gets labeled as such. A practitioner debugging broken magic links reported "a preceding HTTP HEAD request with a User-Agent of `Go-http-client/1.1`, which we believe to be the safelinks service" ([FusionAuth #629](https://github.com/FusionAuth/fusionauth-issues/issues/629)), which [Authelia #2994](https://github.com/authelia/authelia/issues/2994) later relays when the same breakage turned up there. That's a belief stated as a belief, about behavior the Safe Links documentation cited in 2.3 never describes, so the rule above rests on Slack alone and takes the Safe Links report as corroboration rather than a load. None of those fetchers runs the shell's script. The honest limit: a scanner that detonates with a real browser does run it, and the rule doesn't stop that one.

**`robots.txt` stops indexing by compliant crawlers, and it doesn't stop fetching.** Google says the "instructions in robots.txt files cannot enforce crawler behavior to your site; it's up to the crawler to obey them" ([Google](https://developers.google.com/search/docs/crawling-indexing/robots/intro)). No control rests on it. One interaction worth naming: because "a page is disallowed from crawling through the robots.txt file, then any information about indexing or serving rules will not be found and will therefore be ignored" ([Google](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)), the `X-Robots-Tag: noindex` header the preconditions require does its work on fetchers that ignore the disallow, not on Googlebot. Both controls still ship exactly as locked.

### 2.1 The mint response

`spec-viewer` consumes this. Eight fields:

- **`url`** the signed download URL.
- **`url_expires_at`** RFC 3339, UTC. Lets the viewer reuse a still-valid URL instead of minting again.
- **`relic_expires_at`** RFC 3339, UTC, or `null` when the relic has no publisher-set lifetime. Distinct from the above, because either can outlive the other.
- **`object_length`** the ciphertext object's byte length, so the viewer can refuse before allocating and can detect a truncated transfer. `format.md` 3.3 derives plaintext size from this and `rs`.
- **`object_crc32c`** base64, read from the object's non-editable metadata ([GCS](https://docs.cloud.google.com/storage/docs/metadata)), where CRC32C "is the recommended validation method for performing integrity checks" ([GCS](https://docs.cloud.google.com/storage/docs/data-validation)). Its only job here is separating transport corruption from everything else, which matters because `format.md` 3.5 establishes that a tag failure is indistinguishable from a wrong key. It removes one branch and it cannot remove the others.
- **`mints_remaining`** so the viewer can warn before the cap kills the link rather than after.
- **`version`** the relic version this response's URL, length, and CRC32C describe.
- **`current_version`** the relic's latest version, so a client can discover the available version range without a second endpoint.

**Excluded, deliberately:** filename, declared mimetype, renderer class, and the container format version. The exclusion of filename is partially reversed on the server-side relic row for Open Graph cards and viewer `<title>`, where a publisher-declared plaintext title (defaulting to the source filename) is now stored, and joined on 2026-10-13 by a per-relic cover image raster stored at `m/cover/{id}/{sha256}` (rendered by default and declined with `cover: false`); but the envelope filename itself and the declared mimetype remain encrypted inside container record 0 and are never sent to the server (`format.md` 3.2). Neither the envelope filename nor the publisher-declared title belongs in the mint response: the viewer already has the title in the HTML shell or reads the filename after decrypting the envelope header. The container format version lives in the fragment (`format.md` 2.2) and a second copy here could only disagree with it. And while the renderer class now appears in `/{id}`'s `<head>` as link unfurl metadata (`format.md` 3.6), it never belongs in the mint response: routing is the viewer's job based on the decrypted envelope header and magic bytes, and putting the class in the mint response would invite routing on an operator-controlled value.

**The mint serves the current version when the request has no `version` field.** This is the existing request shape and keeps the existing behavior. A caller may instead send `{"version": n}` to select an earlier version under 1.8's bounds. The response's `url`, `object_length`, `object_crc32c`, and `version` all describe the selected object, while `current_version` still reports the row's latest version. The signed object path follows `format.md` 3.12 exactly: version 1 is the bare id path, and versions 2 and up use `{id}/v{n}`. The selector changes neither the relic URL nor its fragment key.

### 2.2 Counting

**A refused mint is never an open and never consumes the cap.** Refusals inflate the metric's first clause, which already carries a permanent confound, and a cap-exhausted mint consuming cap would be circular.

**The cap counts per relic id across all versions.** A republish does not reset the counter and does not add a second one; every version's opens draw on the same pool, which is what keeps the worst-case egress arithmetic in the preconditions true per id under republishing. A publisher whose relic exhausts its cap republishes into the same exhausted pool, and that is the deliberate shape: the cap prices the link, not the version, and the link is what the recipient was sent.

**Rate limiting counts each mint request, whatever version it selects.** Comparing two versions costs two mints, and both successful mints consume the relic's shared download cap.

**A repeated successful mint from the same IP on the same relic inside a dedup interval isn't a distinct open. It does consume the cap.** The two counters answer different questions. The open counter is the metric, and what dedup actually catches is a *recipient* reloading the page, because the publisher's own reload is already gone: `docs/frame.md`'s baseline filter drops opens whose requesting IP matches the relic's publishing IP. The cap is the cost control, and the worst-case egress arithmetic in `docs/preconditions.md` collapses if a mint returns a usable URL without consuming it. The dedup itself is bounded by the per-IP download rate limit, which still fires and still returns `429`.

**The cost, stated where the mechanism is.** Dedup keys on IP, so distinct recipients sharing one egress address collapse into a single open. `docs/preconditions.md` says the condition outright, that "corporate NAT collapses many humans into one address", and 2.3's own scenario is a 40-person list inside a Defender tenant, which is the population most likely to share egress. So the dedup undercounts the metric's first clause in precisely the distribution pattern the cap arithmetic below is built on. It fails in the safe direction, making you believe you lost when you won, and it is never a number to present as clean.

**A deduped mint returns the URL already issued for that relic and IP, never a fresh one.** Reusing the live URL is what `url_expires_at` exists for (2.1). Minting a fresh URL on every reload would leave several concurrently valid URLs alive against one unit of cap, which adds a term to the preconditions' worst-case egress arithmetic at zero cap cost, and the cap is the thing that arithmetic is supposed to bound. The one exception is a stored URL whose remaining validity has fallen below the minimum viable validity in section 3; then the server issues a fresh one, clamped as usual.

**The 120-second post-publish window is anchored to publish time and it is not a scanner filter.** Scanner fetches anchor to delivery, and the gap between publish and delivery is unbounded. Tuning the value can't fix that, because the defect is in the anchor. Changing the anchor changes the frame's own metric definition, so it's drift routing back to `frame`. Named here, not proposed.

### 2.3 The cap arithmetic

Safe Links wrapping "is done per message recipient (both internal and external recipients)" and "URLs are scanned prior to message delivery, regardless of whether the URLs are rewritten or not" ([Microsoft](https://learn.microsoft.com/en-us/defender-office-365/safe-links-about)). One relic mailed to a 40-person list inside a Defender tenant therefore draws up to 40 pre-delivery scans, and 40 time-of-click fetches if everyone clicks. Section 2's shell rule removes the non-executing scans, leaving a floor of 40 legitimate mints and a ceiling near 80 where scanners detonate with a browser.

So a cap in single digits, low enough to bound an abuser meaningfully, breaks ordinary email distribution on legitimate traffic alone. The value is `shape`'s and this is its binding constraint.

## 3. Expiry and time

**Expiry is the publisher's to set, and by default there is none.** A relic is kept until deleted. A publisher may set a lifetime in the grant request (`ttl_days`, an integer 1 to 3650); anything else refuses with `invalid_publish_metadata` (1.1 case 12). A relic with no lifetime never expires: the mint path performs no expiry refusal, and `relic_expires_at` is `null` everywhere. This reverses the original rule that a TTL was mandatory and operator-set, and the cost is counted in the preconditions: no storage-side reaping exists, an expired relic's bytes outlive its refusal until explicitly deleted, and the ceiling rests on the download cap and the kill switch rather than on expiry.

**A download that begins before expiry completes after it.** The app server isn't in the data path and structurally cannot stop an in-flight transfer. This and the two rules below apply only on a relic with a publisher-set lifetime.

**Signed URL validity clamps to `min(url_validity, relic_expiry)` at mint, on a relic that has a lifetime.** Accepting the overhang adds a term to the worst-case egress arithmetic. The cost of clamping is that a mint moments before expiry yields a URL that dies mid-transfer, so the server refuses to mint below a minimum viable validity and returns `relic_expired` instead. On a relic with no lifetime there is nothing to clamp against and the signed URL runs at its configured validity. GCS caps signed URL lifetime independently: "The longest expiration value is 604800 seconds (7 days)" ([GCS](https://docs.cloud.google.com/storage/docs/access-control/signed-urls)).

**The publishing client's clock is never trusted.** Every timestamp feeding a publisher-set lifetime, the telemetry window, and the retention window is the app server's own, NTP-disciplined. The honest limit is that a skewed server mis-enforces a lifetime silently, and the app can't raise an alarm about its own clock.

### 3.1 No lifecycle rule, and therefore no gap

The bucket's storage-side Delete rule is gone. A bucket lifecycle rule acts by age across everything it matches, so it cannot express a per-relic lifetime, and keeping it would have deleted ciphertext for relics the publisher asked to keep. Expiry is enforced only by the application, at mint, exact to the second, and there is no longer a window where the application refuses while storage is still deciding.

Three consequences, stated so nobody "fixes" them by restoring a rule or by serving from an expired object's continued existence:

1. An expired relic's bytes stay in the bucket as live, billable storage until something explicitly deletes them. The refusal stops serving; it reclaims nothing. Soft-deleted objects then "incur storage charges until the soft-deleted objects are permanently deleted after the retention duration is over" ([GCS](https://docs.cloud.google.com/storage/docs/soft-delete)).
2. **The ciphertext-hash scan covers expired-but-undeleted objects.** They are indistinguishable from live objects in a bucket listing, and an expired relic is exactly the one an abuse report arrives about after the fact, so expiry is never a reason to skip one.
3. Any published byte-lifetime number counts the lifetime, the indefinite stay until deletion, and the soft-delete window after it. For a relic with no lifetime there is no number to publish, only "kept until deleted."

### 3.2 Deleted doesn't mean erased

"Soft delete is enabled by default on all buckets and has a retention duration of seven days unless you or your organization have chosen a different policy" and "soft-deleted objects cannot be read or modified" ([GCS](https://docs.cloud.google.com/storage/docs/soft-delete)). Deletion stops serving immediately, which is the half that answers an abuse notice.

**Relic never promises erasure.** The policy is editable at any time, on creation or update, and it remains a decision to make before the first deploy for a narrower reason: a change reaches only objects deleted after it takes effect, so setting it late leaves a tail nobody can retroactively clear.

**The delete-mint race.** A fetch that fails not-found after a successful mint renders as "this relic is no longer available", never as a decrypt failure. Get this backwards and a takedown reads to the recipient as a bad key, and they blame the sender.

## 4. Delete-by-ID and the abuse surface

**The delete endpoint carries an operator credential, and that needs saying out loud.** It lives under the reserved `api` prefix (`format.md` 1.5), with the bulk form and every other operator-facing route, so the whole authenticated surface sits on a path that can never collide with an issued ID. It's the only authenticated surface in a product whose identity non-goal admits exactly one exception, a verified address for a commenter, and grants an operator nothing. The non-goal bounds the product surface, not the operator's tooling. Read the other way it produces a shared token in an environment variable and no audit trail, built under exactly the time pressure the preconditions describe: Google requires you "promptly review and address any alerts, and remove content where appropriate" ([Google](https://docs.cloud.google.com/docs/security/respond-to-abuse-misuse)), and "if you do not respond to the warning in a timely manner your project may be suspended" ([Google Cloud](https://support.google.com/cloud/answer/7002354)). The credential is per-operator, never shared, and every call writes an audit record naming the operator, the relic ID, the reason class, the timestamp, and the report reference.

**Delete means delete every version's object and tombstone the row. The row is never removed.** The preconditions require the object to stop serving *and* upload IP plus timestamp to survive for law enforcement, and deleting both destroys the record the abuse process depends on. With versions, "the object" is each stored byte range the id names, v1 through current (`format.md` 3.12): a delete that left an old version live would leave the abuser's payload servable, and a delete that only tombstoned without removing the bytes would leave them mintable the moment anyone relented. The tombstone is also what makes any `410` possible: without it, every removed relic degrades to `404` and section 1 collapses. And it is what makes the takedown terminal rather than declarative: a tombstoned id refuses every future version with `relic_removed`, whatever publish token is presented (1.7), which is the load-bearing half of delete-by-ID now that republish exists. It retains the normalized relic ID, upload IP, publish timestamp, publishing client name, renderer class, ciphertext hash, delete timestamp, operator identity, private reason class, and report reference, and it lives for the published retention window. The ciphertext hash is a single field filled with the newest version that has bytes; every version's object is hashed and blocklisted during the delete itself, on the rule the next paragraph states, because a republished relic can carry a different payload per version and the tombstone's single field would otherwise lose the ones already caught.

**Delete takes the thread, shared addresses, stop records, decisions, and the commenter index with the relic.** Comments discuss content the operator was just obliged to remove, and a readable discussion of a removed payload is the same disclosure by a longer route. Deleting a relic removes comments, shared addresses, opt-out stop records, decisions (`deleteDecisionsForRelic`), the per-relic commenter index and backfill completion marker, and the `author_relic` index entry, so that a deleted relic's record of who commented, decided, or was shared with does not outlive it. The response names `comments_deleted`, `shares_deleted`, `opt_outs_deleted`, and `decisions_deleted` so a silent cascade is not the kind of deletion nobody can audit later. There is no per-comment operator delete; section 1.9 records why.

**Hash before delete.** A delete that captures no hash permanently loses the ability to blocklist that payload, and it's by then the payload you most want blocklisted. If the scanner already stored a hash, the delete path reads it. If the report beat the scan, the delete path reads the object once, computes the hash, then deletes. **A delete with no hash is refused.** The CRC32C Cloud Storage records is 32 bits and unfit for this, per the preconditions, so this is a real hash over the bytes, and reading them is the operator handling inert ciphertext through the control plane rather than entering the serving data path.

**Delete blocklists in the same call**, because a second call gets forgotten at 3am. It's conditioned on the required reason: automatic for `abuse` and `blocklist_match`, off for `legal` and `operator_error`, with an explicit override either way. The single exception is reporter category `csam`, whose insertion is unconditional and not overridable, for the reason 4.1 gives. Blocklist insertion is idempotent, so a scanner-triggered delete doesn't re-add its own hash.

**Delete is idempotent.** A second delete on a tombstoned ID succeeds and returns the existing tombstone. It never returns `404`. On the delete endpoint, `404` means one thing only: no such relic ID was ever issued. Under a project-level suspension clock, "already handled" and "wrong ID" have to be distinguishable at a glance. Deleting an already-tombstoned ID idempotently resumes every sweep (ciphertext, covers, comments, author index, shares, opt-outs, decisions) to completion and returns the counts of removed items.
**Bulk delete by publishing IP and time window** ships with the single-ID form. Real notices are about campaigns, and without it the operator hand-loops an endpoint never designed for it. The operator credential is exempt from the public per-IP limiters, since those would otherwise throttle the operator's own takedown tooling, and that exemption is precisely why the credential is per-operator and audited.

### 4.1 The abuse form

**The form strips the fragment client-side and server-side.** A reporter will paste the whole URL. Storing it puts the key in the operator's hands and converts "we structurally cannot read it" into "we chose not to", which undermines the posture the preconditions list as lawyer-bound. Pasting into the address bar is harmless; the textarea is the exposure. The server-side strip is the one that counts, because it's the only one a no-JavaScript submission reaches. The published policy asks for the relic ID alone.
**The email alias cannot be defended this way and is a stated residual.** A reporter mailing a full URL to the alias has already delivered the key, and there's no intercept point. It ships anyway, because the alias is a go/no-go obligation.

Required fields: the relic ID (accepting a full URL and stripping the origin and everything from `#`), a category of `malware`, `phishing`, `csam`, `copyright`, `legal_process`, or `other`, a free-text description, and reporter contact, optional except on `copyright` and `legal_process`, which also require the issuing authority and a reference. The categories track the published prohibited-content policy, which in turn tracks the GCP Acceptable Use Policy's prohibition on distributing "viruses, worms, Trojan horses, corrupted files, hoaxes or other items of a destructive or deceptive nature" ([GCP AUP](https://cloud.google.com/terms/aup)). **The category-to-reason-class mapping is fixed here**, because leaving it to the operator's judgment at 3am is how a payload escapes the blocklist. `malware`, `phishing`, `csam`, and `other` set reason class `abuse`. `copyright` and `legal_process` set `legal`. The remaining two classes are operator-originated and no reporter category ever produces them: `blocklist_match` comes from the scanner, `operator_error` from the operator's own mistake. The class decides whether the delete blocklists per section 4, and it never changes the public code, which stays `relic_removed` per 1.4.

**`csam` blocklists regardless of how the report arrived, and the override doesn't reach it.** CSAM frequently arrives as legal process, a court order or a referral rather than a webform report, and `legal` is the class that by section 4's rule skips the blocklist. That's the payload you most want blocklisted, so the category tracks what the report describes rather than the channel it came down: content described as CSAM takes category `csam`, class `abuse`, and an unconditional blocklist insertion. The explicit override available either way on every other class is not available on this one. **The form works without JavaScript**, as a plain form POST.

**The published SLA in hours is `shape`'s.** It must account for the named human's timezone and their named backup, the gap between a report arriving and being seen, and the fact that Google publishes no suspension timeline beyond "timely", so the number has to be same-day-safe. The clock starts at arrival, not at triage.

**The coverage limit, plainly:** the SLA measures responsiveness on reports **received**. It is never coverage. The operator cannot inspect content, so unreported abuse is invisible by construction and there's no denominator. A month of zero reports is either a clean service or a dead intake, and from the inside those are identical.

## 5. The published disclosure statement

`docs/frame.md` conditions its telemetry trade on this document existing and being readable first: "Publishers must be able to see all of it in a published privacy statement before they publish." No other unit specifies it.

It lives at a stable URL, is linked from every relic page beside `/abuse`, and its URL is surfaced by the publish tool before a first publish (`spec-publish-contract` owns how). Required contents:

1. **The telemetry trade.** The coarse renderer class, named as its ten values (`markdown`, `code`, `html`, `jsx`, `image`, `pdf`, `media`, `archive`, `binary`, `otio`); the publishing client name; IP-correlated open activity; the optional publisher-declared plaintext title (defaulting to the source filename) stored on the relic row and served in link unfurls and the viewer document `<title>`. The class was already in the telemetry enumerations collected for the operator. What changed is its audience: it is now public metadata, served on link unfurl cards (`og:description`, `twitter:description`, and the fallback `<title>`) to anyone who fetches the link, rather than known to the operator alone. Stated as what it moves the operator and the recipient from and to: from knowing nothing to knowing what kind of thing was published, its public title when declared, and roughly how often it was fetched. Metadata, never content. The statement must note that removal (tombstone) and expiry stop serving both the title and the class, reverting the unfurl card to the constant fallback card (`A relic` with description `An encrypted file. It opens in your browser, and only someone holding the whole link, including the part after the #, can open it.`). It must also note that declining a title does not hide the class: the title is declinable, but the class is derived from the bytes and is not declinable.
2. **The transcript disclosure.** The publish tool must return the full URL including the fragment, because relaying a usable link is the product, so **the key enters the model's context and the session transcript on every publish**. Zero-knowledge holds against the Relic operator. It does not hold against the model provider or the transcript store, and this is structurally unfixable rather than a defect to schedule.
3. **The served-JavaScript caveat**, as the frame already locks it: the decrypting code is served by the party the claim is made against, so it's a statement about operator intent rather than a property a recipient can verify.
4. **The correct form of the fragment claim.** "The key never reaches a server" is wrong unqualified. The honest form is **"your browser never sends the key to Relic's servers."**
5. **Retention, per sink, with its own window each.** Application records, edge and load balancer logs, GCS access logs where enabled, the intake mailbox or ticket queue, and soft-deleted object bytes. Listed separately rather than as one number, because a single figure is the claim that goes false first. It states that deleted does not mean erased, per 3.2, and that a relic's ciphertext is kept until deleted, because nothing reaps it by age.
6. **The network capability of rendered content, and its removal.** Content that renders on the usercontent origin, HTML and JSX, still executes in the recipient's browser, but the frame is served a policy permitting no remote source of any kind, so it cannot fetch, cannot load an external image or font, cannot open a WebSocket or an EventSource, and cannot beacon. The disclosure states this as an enforced property with its cost attached, because the cost is what a publisher actually meets: a page expecting a CDN stylesheet, a CDN script, a remote font, or a remote image renders without them, and a publisher who needs those must inline them. It also states the limit of the claim, since the isolation is about network and cross-origin reach and not about safety: the code still runs locally, can consume CPU, and can render whatever its author wrote. Popups are removed by the sandbox attribute rather than by the policy, because a popup opens a top-level context the frame's policy does not govern. The origin boundary continues to keep such content away from the decryption key, which never leaves the link and the recipient's browser. The viewer page carries a compact marker linked to this statement (`spec-viewer`), rather than reproducing the statement before the content renders.
7. **Version history. Anyone holding a relic's link can fetch every version it has ever held, so republishing does not withdraw earlier content.** The same fragment key decrypts every version in the recipient's browser. Republishing is not a redaction mechanism.
8. **Comments, sharing, and notifications. Anyone holding a relic's link can list the thread. Every comment body is ciphertext derived from the fragment key (`format.md` 3.13), so the operator cannot read it.** A comment is attributed to a verified email address or to the publisher. Asking for a sign-in email delivers the plaintext address to the mailer, which is not avoidable and is one of identity's prices. A verified address is not an access control: anybody with the link plus any real mailbox can comment. When someone comments or a new version is published, Relic emails everyone following the relic: every verified commenter, every shared address, and the owner address, minus the author of the comment and anyone with a stop record. A publisher comment emails everyone except the owner address. Comment notification emails name the commenter (their verified address or 'The publisher'), disclosing the commenter's address to everyone on the list, including third-party shared addresses that never interacted with the service. Outbound notifications name the relic's plaintext title and who commented, but never quote the ciphertext comment body, never include the fragment key, and link to the keyless relic URL. Outbound notifications and change notices share rate limits: at most one email per recipient per relic per 10 minutes, and all-relics outbound volume is capped by a global fuse (`config.changeNoticeRateLimit`). Every notification email carries an unauthenticated stop link and RFC 8058 one-click unsubscribe headers stopping all emails about that relic for that address. Shared addresses are stored in the clear, opt-outs are stored as SHA-256 hashes, and the unsubscribe key is stored permanently. Failure logs record address hashes and redact recipient addresses. `/policy` renders this item.
9. **The per-relic cover image trade.** At publish time, the client renders a 1200x630 image of the first screen on the publisher's machine and uploads it via `POST /api/relics/{id}/cover`. This image is stored server-side in the clear and served to anyone fetching the link without the key, including chat platforms, link unfurl crawlers, and their caches. `cover: false` declines. Republishing with `cover: false` clears the stored cover. Takedown deletes it. When no cover is uploaded, or when the relic is expired or tombstoned, the fallback card `/assets/card.v1.png` is served. For OpenTimelineIO timeline relics (`otio`), unencrypted first-screen media rendering is skipped by default, and link unfurls use a generic card carrying the publisher-declared title and format label to prevent referenced media frames and track metadata from leaking into unencrypted preview cards.
10. **The failed-open signal.** The viewer checks the key against the first record before downloading the rest and cancels the download when it fails (`viewer.md` §6.4), so the storage provider and anyone watching the connection can see an open that stopped after its first block, which usually means a wrong key. The statement says so in one sentence. The key is never sent and cannot be derived from the stop. For classes that render, the operator could already infer a failed open, because the comment-thread request follows only a successful decrypt. For archive and binary relics the signal is new.


10. **Decisions, passkeys, and version digests.**
> **Decisions.** When a signed-in reader approves or rejects a version in the viewer, the service stores that decision in the clear: the verdict, the reader's verified email address, the version number, the SHA-256 of that version's ciphertext, the id of the passkey that confirmed it, and the time. Anyone holding the relic's link can read its decisions. Decisions are never edited or deleted, except that removing a relic removes its decisions with it.
> **Passkeys.** A passkey is registered to a reader's verified address. It confirms decisions, and it can sign that reader in instead of a link. The service keeps one record per address, filed under a hash of the address: the address itself, the random user handle its passkeys carry, and for each passkey its public key, credential id, signature counter, and when it was created and last used. A second entry, filed under a hash of the user handle, points to that record, so a passkey can sign you in without your typing the address. The first passkey registered for an address is trusted on first use, and only a session that a sign-in email started in the previous 15 minutes, by its link or its code, can begin adding it; adding another requires confirming with an existing one. Whenever a passkey is added, the service emails that address to say so, with the time and how many passkeys the address has. That email has no stop link, because it is about the address rather than a relic. Signing in with a passkey sends no email, updates that passkey's counter and last-used time, and starts the same session a link does, except that the session records a passkey started it. If you type your address to use a passkey, the service answers the same way whether or not that address has one. The service never receives a private key.
> **Version digests.** To bind a decision to exact content, the service reads each version's ciphertext once and stores its SHA-256. It reads ciphertext only and holds no key.
One more, assigned by `format.md` 3.8: **the length leak.** Ciphertext length reveals plaintext length to within a record, so alongside the class, title, and cover image the operator learns something like "an image of roughly 2.4 MB". Whether the container pads to buckets is `shape`'s, and the disclosure appears under either branch.

## 6. When the key reaches a third party without Relic doing anything wrong

`spec-viewer` owns redirects the viewer issues. This section owns the cases where the key leaves via somebody else, which the fragment guarantee never covered, because it's a statement about what a browser puts in a request and not about what a human pastes.

**The redirect rule, assigned here by `format.md` 5. The test is the destination's trust boundary, not its origin tuple:** the service origin and its host and scheme variants are all Relic, the usercontent origin is not, and that's the line the fragment must not cross. **Leaving the service, an explicit, possibly empty, fragment in `Location` is mandatory**, which is how [RFC 9110 §17.11](https://www.rfc-editor.org/rfc/rfc9110.html) scopes its own remedy, to ensuring that "redirects to other sites include a (possibly empty) fragment component in order to block that inheritance". That half covers the service origin redirecting to the usercontent origin, plus any CDN or load-balancer redirect the application doesn't author that lands off the service domain. **Staying anywhere inside the service, including its host and scheme variants, the fragment is deliberately omitted so inheritance carries the key through**, which covers legacy or renamed paths, trailing-slash normalization, apex to `www`, and HTTP to HTTPS. An empty fragment on any of those is a deleted key and a recipient on the "link is missing its key" screen holding a link that was never broken. `format.md` 5 and `viewer.md` 1.7 develop both halves; this document states the rule because section 6's third-party cases run on the same inheritance mechanism.

There's no canonicalizing redirect for ID case (`format.md` 1.1), so a relic is served on every accepted spelling of its ID. **Cache keys, per-object download-cap accounting, and log correlation all normalize before keying**, or they fragment across spellings and the cap stops being a cap.

**Link shorteners.** Pasting the full URL into a shortener's form transmits the key in a request body and stores it on that service. Nothing technical prevents it. The shortened link usually still works, because the click-time redirect inherits the fragment, which is the same mechanism above working in the user's favor.

**Enterprise link rewriters.** Safe Links wraps scanned URLs "using the Microsoft standard URL prefix: `https://<DataCenterLocation>.safelinks.protection.outlook.com`" ([Microsoft](https://learn.microsoft.com/en-us/defender-office-365/safe-links-about)). Proofpoint rewrites messages to point at its "URL Defense Redirector service" and documents only that "rewritten URLs are specially encoded to survive forwarding and other manipulations" ([Proofpoint](https://help.proofpoint.com/Threat_Insight_Dashboard/Concepts/How_do_I_decode_a_rewritten_URL%3F)). **Neither of those pages says a word about fragments.** Three outcomes are structurally possible:

1. The `#` is percent-encoded into the wrapper, so the key is transmitted to and logged by that vendor.
2. It's left unencoded and stays on the wrapper, surviving to the relic through redirect inheritance.
3. It's dropped, and the relic is un-openable in a way that looks exactly like a wrong key.

**A pre-launch empirical test is mandatory.** Publish a real relic, mail it through a Defender for Office 365 tenant, and record what arrives. One message settles an outcome no documentation states. **Until it runs, the disclosure statement's wording must be correct under all three**, which means it says the key may reach an enterprise mail security vendor and does not assert which.

The Proofpoint fragment question joins the unresolved list in `docs/preconditions.md` section 5, beside the Proofpoint host-to-parent blocklist question already open there.

## 7. Routed to `shape`

Seven items, and only these seven.

1. **Edge fidelity for the statuses section 1 fixes.** No status, code, or distinction in section 1 is `shape`'s; all of them are settled there. What is `shape`'s: which of those statuses the deployed edge can actually produce under load shedding, and the edge's substitute behavior where it can't emit a problem document (1.5). Read this item as edge behavior only. Nothing in it reopens the table.
2. **The per-object download cap value.** Priced against 2.3's arithmetic: a floor of 40 legitimate mints for a 40-person distribution list, near 80 where scanners detonate, against GCS internet egress at $0.12/GB for the first TB ([pricing](https://leanopstech.com/blog/google-cloud-storage-pricing-2026/)).
3. **The publisher lifetime ceiling.** Settled by reversal: relics do not expire unless the publisher sets a lifetime, and the accepted ceiling for one is 3650 days (`decisions.md` 3). No lifecycle regime is involved, because no storage-side rule exists; enforcement is only at the application layer (3.1).
4. **The signed-URL validity window**, including the minimum viable validity below which a clamped mint is refused (section 3), bounded above by 604800 seconds.
5. **The retention window.** A retention window shorter than the age of relics still being opened silently stops the metric's publishing-IP filter firing on older relics, and with relics that never expire no TTL bounds that age. It also bounds how long the tombstone and the mint log's `code` survive, which the cap-exhaustion cost in 1.2 depends on.
6. **The published SLA in hours**, against the inputs in 4.1.
7. **The mint dedup interval.** Whether a refused mint counts as an open, and whether a repeated one does, are rules and they're fixed in 2.2: refused never counts and never consumes cap; a repeat inside the interval isn't a distinct open and does consume cap. The interval's value is `shape`'s, and it interacts with the frame's 120-second window.

## 8. Comments and the one identity

**A comment is ciphertext the server stores and cannot open.** The envelope, the key derivation, and the plaintext caps live in `format.md` 3.13. This document owns the HTTP surface, the attribution, and the one identity the product has.

**Read: `GET /api/relics/{id}/comments`.** Unauthenticated, oldest first, a JSON array of rows, never an object wrapping them. Each row carries `comment_id`, `author`, `created_at`, `ciphertext`, and the version of the relic it was made on. The ciphertext is the exact string `@relic/format` produced; the server never rewrites it. A missing relic is `404 relic_not_found`. A tombstoned relic is `410 relic_removed`. A client that receives a non-array treats the thread as unusable rather than empty, because wrapping the rows would otherwise read as a quiet day.

**Write: `POST /api/relics/{id}/comments`.** The body is JSON with `ciphertext` and, for the publisher path, `publish_token`. The session path carries the `relic_session` cookie instead. The response is `201` with `comment_id`, `author`, and `created_at`. Kill switch, per-IP comment limiter, tombstone, and relic existence all refuse before the body is stored. The stored author is the literal `publisher` or the verified email, never a display name: display names live inside the ciphertext (`format.md` 3.13) and this server cannot read them.

**Delete own: `DELETE /api/relics/{id}/comments/{comment_id}`.** Same attribution as write. The author of the existing row must match. Success is `204`. A mismatch is `403 comment_forbidden`.

**Patch: `PATCH /api/relics/{id}/comments/{comment_id}`.** The body is JSON with optional `ciphertext` and optional `resolved`. The two fields are settable by different people and the request is authorized per field rather than per caller: `ciphertext` for the comment's author only, by the same rule delete already uses (a verified session whose address equals `author`, or the relic's publish token when `author` is the literal `publisher`), stamping `edited_at`; `resolved` for the comment's author or the holder of the relic's publish token, stamping `resolved_at` and `resolved_by`. Setting `resolved: false` clears the resolution. Read: `GET /api/relics/{id}/comments` rows carry `edited_at`, `resolved_at`, and `resolved_by`, each an ISO string or `null`, exactly as they are stored. Success is `200` with `{comment_id, author, created_at, edited_at, resolved_at, resolved_by}`. Refusals reuse the codes above: `comment_not_found` (404), `comment_forbidden` (403), `invalid_comment` (400), and `nothing_to_change` (400).
**Sign-in: link or passkey.**
**Sign-in: link, code, or passkey.**

1. *Link sign-in: `POST /api/auth/request` then `GET /api/auth/callback`.* The request always answers `202`. A well-formed address mints a single-use link, hashed at rest, valid for a short TTL. The body is `{email, relic_id}` or `{email, return_to}`; `relic_id` becomes `/{id}` when `return_to` is absent. `return_to` must be a same-origin path (starts with `/`, not `//`); an absolute URL is dropped and the callback lands on `/`, because a sign-in link that leaves the service would take the session cookie with it. Following the link spends it, sets the HttpOnly Secure SameSite=Lax `relic_session` cookie, and sets a non-HttpOnly `relic_passkey_offer=1` marker cookie (Path=/, Secure, SameSite=Lax, Max-Age 600 s) so the viewer can offer passkey enrollment to returning browsers that have not dismissed it, then redirects to that path. The fragment is the caller's to keep: the server never sees it and never needs to. The session row records `via: 'link'` and its `createdAt`, which is what lets it begin adding the address's first passkey for the next 15 minutes (1.15). A spent or missing token is `401 invalid_session`.

2. *Passkey sign-in: `POST /api/auth/passkeys/sign-in/options` then `POST /api/auth/passkeys/sign-in`.* A returning reader who registered a passkey can sign in without email. The options endpoint issues a challenge (usernameless or email-first padded with HMAC decoys). The sign-in endpoint verifies the WebAuthn assertion, sets the same `relic_session` cookie as a magic link, and sets no offer marker cookie. Its session row records `via: 'passkey'`, so it can never add an address's first passkey (1.15).

3. *Code sign-in: `POST /api/auth/request` then `POST /api/auth/code`.* The sign-in email carries a six-digit code alongside the link. The reader types the code into the page that asked, without navigating away, so the decryption key stays in tab memory. The browser submits `{"code": "123456"}` with the HttpOnly `relic_sign_in_request` cookie that was set on the 202 request. The server verifies the cookie, charges one attempt against the address's daily budget in the store before comparing, checks the code against a nonce-keyed HMAC, spends the mailed link, clears the request cookie, and answers `200` with `{"email": "<address>"}`. It sets the same `relic_session` cookie and the same `relic_passkey_offer=1` marker cookie as the link callback. The session row records `via: 'code'` and its `createdAt`, allowing it to add the address's first passkey within `passkeyFreshLinkSeconds` (1.15). Verifying the code spends the link, following the link spends the code, and every failure gives `401 sign_in_code_failed` (1.16).
**First paint: `GET /api/auth/session`.** `200` with `{email}` when the cookie is live, `{email: null}` when it is not. Never `401`. Every anonymous load would otherwise hit a status the public surface is not allowed to emit except on a write, and a missing session is the ordinary state of a reader, not a failure.

**The cookie is the session.** It is never the comment key. The key stays in the fragment. A session that outlives the cookie's Max-Age is dead even if the row is still in the store, because expiry is checked at the point of use.

**Identity is reachability, not permission.** A commenter is somebody whose mailbox accepted a link or code. That is the whole of what "verified" means here, and it is also the whole of what it buys: a thread other link-holders can read, attributed to an address an agent can act on. It does not buy an account, a profile, a permission, or a way to un-publish.

**What an edit and a resolution disclose.** A comment now carries an `edited_at` stamp, so the operator learns that a comment's body was replaced and when, though still never a word of what it says or said. There is no edit history: the service holds one ciphertext per comment, so an edit overwrites, and what is on offer is the fact that it happened, not the earlier text. The resolution is deliberately not encrypted, because it decides whether a republish is blocked, which is an answer the service gives before any key exists on its side, so there is nothing on its side to seal it with. The operator therefore learns that a comment was settled and by which address, and still cannot read a word of it.

**Comment notifications to all participants.** When a comment is posted on a relic, the service emails everyone involved in it: every verified commenter (`listCommenters`), every shared address (`listShares`), and the relic's registered owner address (`row.ownerEmail`), minus the comment author (case-insensitive), minus anyone with a stop record for that relic (`isOptedOut`). A comment from the publisher (author `publisher`, using the publish token) emails everyone except the owner address. The notification email names the commenter (their verified email address, or 'The publisher'). It never quotes the comment body, never contains the decryption key, and links to the keyless relic URL `${config.serviceOrigin}/${relicId}`. Everyone on the list, including third-party shared addresses, sees the commenter's address. The relic's owner receives owner wording ('commented on your relic' or 'left a comment on <title>', with 'Open the link you hold for this relic to read and answer the comment.'). An answered commenter (whose comment id was targeted by `addresses` on the new comment) receives reply wording ('answered your comment on <title>', with 'Open the link you hold for this relic to read the reply.'). All other recipients receive 'commented on <title>' with a reason line ('you commented on this relic', 'the person who published this relic shared it with you', 'someone with this relic's link shared it with you', or 'you are its owner'). Comment notices and change notices share the same per-recipient burst limiter: at most one email per recipient per relic per 10 minutes on `notify ${relicId} ${address}` (`config.notificationRateLimit`), dropping later comments in the window. Outbound notifications across all relics count against the global fuse `config.changeNoticeRateLimit` (key `change-notice`), checked before performing recipient preparation. Every notification email carries an unauthenticated stop link and RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers. Comment edits and comment resolutions send nothing. Tombstoned, expired, or download-cap-exhausted relics send nothing. When batch sending is supported, emails go out in chunks of up to 100 via Resend's batch endpoint with per-email headers, re-checking the current relic row, tombstones, and opt-outs immediately before each batch chunk or send. Limiter and fuse credits are charged only for recipients actually dispatched. Batch failure logs record only controlled fields (status code, error code name, and recipient hash) and never provider error text.

**Change notices.** When a relic is republished, the service sends change notices announcing the new version. Notices fire on first sight of the new version's object in storage: either upon upload completion (`POST /api/relics/{id}/complete`) or during lazy discovery at the first mint (`POST /api/relics/{id}/mint`). They are claimed by a compare-and-swap on `noticePending` in the store (`claimVersionNotice`), running at most once per version. Notices never fire for version 1, never when republish specified `notify: false`, and never for expired, removed, or download-cap-exhausted relics. Version notices and comment notifications share the same unified recipient collection and fan-out helper (`fanOutNotifications`): normalizing every candidate address with `trim().toLowerCase()`, skipping the comment author or version publisher, and skipping any address whose SHA-256 hash is in the relic's opt-out list. Each recipient is evaluated during dispatch with `limiter.check('notify ' + relicId + ' ' + address, config.notificationRateLimit, now)`, sharing the burst limiter across comment notices and version notices. Outbound notifications count against the global fuse `limiter.check('change-notice', config.changeNoticeRateLimit, now)`, charged at dispatch for active recipients. The outgoing message subject is `title ? 'New version of "' + title + '"' : 'New version of a relic'`. The body provides the unfragmented relic URL `${config.serviceOrigin}/${relicId}`, notes that Relic never holds the decryption key, states the reason for receipt, and provides the unauthenticated stop URL. Outbound mail headers include RFC 8058 one-click unsubscribe.

**Sharing and reader authority.** `POST /api/relics/{id}/share` allows registering email addresses that were never verified with the service. The service never sends a share email: the email is composed on the sharer's machine (in the client or the web viewer) and sent from the sharer's own mailbox so the decryption key never touches the service. The share endpoint accepts two authorities, and exactly one must be present: publisher authority (`{ publish_token, emails }`) authenticated against `publishTokenHash` (refusing with `403 invalid_publish_token` on failure), or reader authority (`{ share_proof, emails }` plus a valid `relic_session` cookie). For reader sharing, a missing or invalid session cookie returns `401 sign_in_required`; an older relic lacking `row.shareVerifier` returns `409 share_unavailable` with detail "This relic was published before sharing existed. Its publisher can republish it to turn sharing on."; a proof that is not unpadded base64url of 32 bytes returns `400 invalid_share`; a proof whose SHA-256 hash fails `timingSafeEqual` with `row.shareVerifier` returns `403 invalid_share_proof`; and per-sharer rate limiting via ``limiter.check(`share-reader ${relicId} ${sessionEmail}`, config.readerShareRateLimit, now)`` with `readerShareRateLimit: {limit: 10, windowSeconds: 3600}` returns `429 share_rate_limited` with `retry_after_seconds`. Shares are capped by `config.shareMaxPerCall` (20), `config.shareMaxPerRelic` (50), `shareRateLimit: {limit: 30, windowSeconds: 3600}` (`429 share_rate_limited`), and download cap exhaustion (`410 download_cap_exhausted`).

**What is stored.** Shared addresses are stored in the clear (`ShareRow: { relicId, address, addedAt, sharedBy }`), recording whether the share was registered by `'publisher'` or `'reader'`. The sharer's address is deliberately not stored on the row: attribution of who shared is not kept beyond the in-memory rate limiter. Opt-out stop records are stored as SHA-256 hashes (`OptOutRow: { relicId, addressHash, at }`). An HMAC unsubscribe key (`store.unsubscribeKey()`) is generated once and stored permanently in the store so stop links remain verifiable forever. All share records and opt-out records are retained until the relic is deleted: relic expiry halts outbound notices but leaves stored records intact. Commenters are indexed per relic (`listCommenters`), written create-only by `putComment` for verified email authors and backfilled lazily once per relic from existing comments, swept by operator delete, and removed when an author deletes their only comments on the relic. At publish and republish, `share_verifier` (a 64-character lowercase hex string) may be registered; republish overwrites it when present and leaves it unchanged when absent, and it is never returned by any endpoint.

## 9. Decisions and passkeys

**Decisions are first-class approval and rejection records.** They bind to exact version content, verified reader identity, and a passkey confirmation. Comments mean no approval; approval requires a deliberate decision action in the viewer confirmed with a passkey.

### 9.1 The decision record and lifecycle

- **The record:** `{ id, relicId, version, verdict: 'approve' | 'reject', author, createdAt, versionDigest, credentialId }`.
- **Author:** the normalized verified email address (`normalizeEmail(v)`: trimmed, lowercase).
- **Version:** exact version number (1 through `row.version`).
- **Version digest:** lowercase hex SHA-256 of the stored ciphertext container object for that version.
- **Append-only:** decisions are never edited or deleted. Each author's latest decision on a version is their current one.
- **Per-version:** decisions do not carry over across republishes. A new version starts with zero decisions; prior versions retain their decisions.
- **Deletion:** operator relic delete sweeps decisions (`deleteDecisionsForRelic`), returning `decisions_deleted`.

### 9.2 The HTTP routes

Routing is declared in `apiRoute` (`app.ts`):

1. **`POST /api/relics/{id}/decisions/options`** (session cookie required):
   - Request: `{ "version": 3, "verdict": "approve", "share_proof": "<43>" }`
   - Validates session, proof, verdict, version.
   - Checks passkey exists on file (otherwise `409 passkey_required`).
   - Computes digest on record (`row.versionDigests[v] ?? storage.digest(...)`).
   - Issues challenge `{ purpose: 'decide', email, relicId, version, verdict }` with TTL 300 seconds.
   - Returns `200` with `{ version, version_digest, public_key: { challenge, rpId, timeout: 300000, userVerification: "required", allowCredentials: [...] } }`.

2. **`POST /api/relics/{id}/decisions`** (session cookie required):
   - Request: `{ "version": 3, "verdict": "approve", "share_proof": "<43>", "version_digest": "<64 hex>", "credential": AuthenticationResponseJSON }`
   - Validates session, proof, version_digest format, credential object.
   - Verifies WebAuthn assertion: challenge matching purpose `'decide'`, email, relicId, version, verdict, unexpired; UP and UV required; counter CAS.
   - Verifies `body.version_digest == recorded_digest` (otherwise `409 decision_digest_mismatch`).
   - Appends decision row (`appendDecision`).
   - Returns `201` with `{ relic_id, id, version, verdict, author, created_at, version_digest }`.

3. **`POST /api/relics/{id}/decisions/list`**:
   - Request: `{ "share_proof": "<43>", "version": 3 | "*" }`
   - Unauthenticated (no session cookie needed), allowed on expired relics, not gated by the kill switch, never touches `mintsUsed`.
   - Validates share proof.
   - Returns `200` with `{ relic_id, current_version, decisions: [...] }`.

4. **`POST /api/auth/passkeys/options`** (session cookie required):
   - Request: `{}` or `{ "credential": AuthenticationResponseJSON }` (for enroll assertion).
   - If no credential: if no passkey exists, the session must have been started by a sign-in email (following its link or typing its code) within `passkeyFreshLinkSeconds` (default 900), or the answer is `401 passkey_fresh_link_required` and no challenge is written; otherwise returns `{ mode: "create", public_key: CreationOptions }` with challenge purpose `'register'`. If passkeys exist, returns `{ mode: "assert", public_key: RequestOptions }` with challenge purpose `'enroll'`, whatever the session's age. Freshness is checked when the `'register'` challenge is issued, not when it is consumed, so a ceremony that starts inside the window can finish within the challenge's 300 seconds.
   - If credential present: verifies enroll assertion, runs counter CAS, returns `{ mode: "create", public_key: CreationOptions }` with `excludeCredentials` and challenge `{ purpose: 'register', assertedBy: credId }`.

5. **`POST /api/auth/passkeys`** (session cookie required):
   - Request: `{ "credential": RegistrationResponseJSON }`
   - Consumes challenge (purpose `'register'`, email match).
   - Verifies registration: UP, UV, AT, COSE key (ES256 or RS256).
   - If `assertedBy` absent: `createPasskeys` (TOFU; if record already exists, `409 passkey_assertion_required`).
   - If `assertedBy` present: CAS-appends passkey with `registeredWith: assertedBy`.
   - After either write, emails the session's address a passkey-added notice with no stop link. A mail failure is logged and changes nothing: the passkey stays stored and the response is still `201`.
   - Returns `201` with `{ email, credential_id, created_at, passkeys }`.

6. **`POST /api/auth/passkeys/sign-in/options`** (no session cookie required):
   - Request headers: must include `content-type: application/json`.
   - Request: `{}` (usernameless) or `{"email": "<address>"}` (email-first).
   - Issues challenge with purpose `'sign_in'` (and normalized email if email-first), TTL 300 seconds.
   - Returns `200` with `{ public_key: { challenge, rpId, timeout: 300000, userVerification: "required", allowCredentials: [...] } }`.
   - For usernameless, `allowCredentials` is `[]`.
   - For email-first, `allowCredentials` has exactly `config.passkeySignInAllowListSize` (default 4) descriptors (or more if real credentials exceed it): real credentials padded with deterministic HMAC-SHA256 decoys, sorted by `id`, transports omitted, so an observer cannot tell whether an address has credentials.

7. **`POST /api/auth/passkeys/sign-in`** (no session cookie required):
   - Request headers: must include `content-type: application/json`.
   - Request: `{ "credential": AuthenticationResponseJSON }`.
   - Consumes WebAuthn challenge (must have purpose `'sign_in'`, unexpired).
   - Locates passkey record: by challenge `email` if email-first, or by `credential.response.userHandle` via the user-handle index.
   - Verifies WebAuthn assertion: UP, UV, counter CAS, valid signature over authData and clientDataJSON.
   - Any failure after challenge consumption returns `401 passkey_sign_in_failed` with no problem extension.
   - On success: mints a reader session for `record.address ?? record.email`, sets `relic_session` cookie (HttpOnly, Secure, SameSite=Lax), and returns `200` with `{"email": "<session address>"}`.

### 9.3 WebAuthn verification

- **RP ID:** `new URL(config.serviceOrigin).hostname`. Origin: `new URL(config.serviceOrigin).origin`.
- **Minimal verifier:** hand-rolled in `webauthn.ts` with zero third-party dependencies.
- **clientDataJSON:** parsed as JSON, checks `type`, `challenge`, `origin`, and `crossOrigin !== true`.
- **authData:** minimum 37 bytes, validates `rpIdHash == sha256(rpId)`. Flags: UP (0x01) and UV (0x04) mandatory.
- **Resident key required:** new passkey registrations require resident keys (`residentKey: 'required'` and `requireResidentKey: true`), allowing them to be discovered in usernameless sign-in flows.
- **COSE algorithms:** ES256 (-7) and RS256 (-257) only.
- **RS256 key bounds:** Leading zeros are stripped from the modulus `n`. The stripped modulus must satisfy 256 <= |n| <= 512 bytes (2048 to 4096 bits). The exponent `e` must equal 65537 (0x010001). Any violation is rejected as `invalid_passkey` with `passkey_check: 'key'`.
- **Signatures and counters:** verified over `authData || sha256(clientDataJSON)` using WebCrypto. Authenticator signature counters are checked strictly on assertion and in store compare-and-swap callbacks: if either the stored or incoming counter is non-zero, an incoming counter less than or equal to the stored counter is rejected with `passkey_verification_failed` and `passkey_check: 'counter'`.
### 9.4 Storage and GCS layout

- Prefix `m`:
  - Decisions: `m/decision/{relicId}/{id}.json`, write-once with generation `'0'`.
  - Passkeys: `m/passkey/{sha256Hex(normalizedEmail)}.json`. Created with generation `'0'`; updated via generation CAS. Records include `address` (exact address from the registering session), `email` (normalized), `userHandle`, and credential list.
  - Passkey user handle index: `m/passkey-handle/{sha256Hex(userHandle)}.json` mapping user handle to `{ emailHash, createdAt }`, written best-effort on create and update.
  - Passkey decoy secret: `m/secret/passkey-decoy-key.json` holds a 32-byte secret generated once for HMAC padding in email-first sign-in options.
  - WebAuthn challenges: `m/challenge/webauthn/{sha256Hex(challenge)}.json`, consumed atomically via get-then-delete with `ifGenerationMatch`. Cleaned up by 1-day bucket lifecycle rule. Purpose includes `'register' | 'enroll' | 'decide' | 'sign_in'`.
- Streaming object digest in GCS pins the signed GET to the stat generation with `x-goog-if-generation-match`. The server counts bytes hashed and records the SHA-256 only when the hashed byte count matches the stat length and response content-length. Digest computation is single-flighted per (id, version) within the process.
- GCS decision listing caps fan-out object fetch concurrency at 16 while preserving deterministic ordering (createdAt ascending, then id).
### 9.5 Upload completion response

When ciphertext upload finishes, the client calls `POST /api/relics/{id}/complete`. The endpoint is rate limited per IP using `config.publishRateLimit` (refusing with `429 publish_rate_limited` and `retry_after_seconds`).
Response status `200` with JSON:
```json
{
  "relic_id": "<id>",
  "object_length": 12345,
  "object_crc32c": "<crc>",
  "relic_expires_at": null,
  "version": 3,
  "version_digest": "<64 hex>"
}
```
`version` returns `row.version`, and `version_digest` returns the lowercase hex SHA-256 of the stored ciphertext object (`null` only if hashing failed, which is logged). The digest is computed only when this call just set `publishedAt` or no digest is recorded yet. Repeated calls reuse the recorded digest.

Decision and passkey routes read JSON request bodies via a streaming reader capped at 65,536 bytes, decoded with fatal UTF-8 decoding. Exceeding 65,536 bytes or providing invalid UTF-8 aborts the stream and returns the route's malformed code (`invalid_decision` or `invalid_passkey`). Decision recording re-checks the tombstone immediately before and after writing a decision; if a tombstone appears, the just-written row is deleted and `410 relic_removed` is returned.
