# Live per-relik settings and passkey signing: dispatch spec

This spec is grounded at `9ac52d9a`, which is the checkout's branch `feat/focused-grant-card`, not `main`. Every worker rebases on `origin/main` first and finds its anchors again by symbol, because the line numbers below come from that tree. Leave the untracked `packages/relic-server/src/**/.nfs.*` files alone. User-facing copy spells the product "relik". Identifiers, paths and protocol labels keep `relic` (decisions.md:1313-1320), and the guard is `packages/relic-viewer/test/brand-spelling.test.ts`.

## 0. Goal

When this is done, a person can see all of the following:

1. **Live settings.** The owner can change suggested edits, comments, decisions, signing, notification emails and the lifetime without publishing a new version. The MCP does it with the publish token; the signed-in owner does it in the viewer with one passkey tap. The next request on any server instance follows the change.
2. **Signing requests.** The owner asks named addresses to sign one exact version. PDFs get boxes on any page; every other kind gets a block after the document. Signers sign in parallel or in order. Each signer types or draws a mark, agrees to sign electronically, and taps a passkey. That tap covers this version's stored bytes and its content.
3. **Receipts on private reliks.** The owner sees two records per reader:
   - **Served**: the service's own record that it handed over the reader's key.
   - **Opened**: a statement the reader signed after their browser decrypted the version and checked it.

   The owner can require "opened" before a signer may sign.
4. **Completion.** When every signer has signed, the version is locked and every party is notified. The certificate verifies offline against the file with `verifySigningCertificate` and with `relic_verify_certificate`.

## 1. Corrections to the brief

1. **`ownerEmail` gives no authority, and no first-party client sets it.**
   - The grant and republish bodies may name `owner_email`. The only check is `hasVerifiedIdentity` (`app.ts:1536-1555`, `1880-1907`), so a publisher can name anyone's verified address.
   - Neither the browser (`relic-viewer/src/publish.ts:215-229`) nor relic-mcp sends it (no match in `relic-mcp/src`).
   - `owned_by_me` is display only (`app.ts:1063-1075`). No session has any power over a public relik today.

   The only real owner link is `ownerIdentityId`. It is written by `bindOwner`, which needs the publish token plus an owner device's `owner_bind` (`private/relic.ts:736-776`, `service.md:772`). The spec already defines "owner session" as "a session whose current identity is the relik's `ownerIdentityId`" (`service.md:741`). **This spec uses that rule for public and private reliks alike.**

   A browser-published public relik has no owner (`publish-view.ts:187-195`: it "cannot be updated"), so S3 and S5 add an opt-in owner bind at browser publish. A public relik with no owner has no web Settings control; the MCP can still change its settings with the publish token.

2. **A decision's passkey does not commit to what was approved.**
   - The decision challenge is 32 random bytes. The relik, version and verdict live only in the server's challenge row (`app.ts:4900-4913`, matched at `5084-5093`), and the digest is compared separately (`5109-5116`). A stored decision cannot be re-verified offline.
   - The private attestation machinery does commit. Its challenge is `attestationChallenge(nonce, statementBytes…)` (`relic-format/src/private.ts:360-377`), and a stored attestation verifies again from its own bytes (`private/attest.ts:377-424`).
   - Decisions also change: each author's latest record wins (`decision.ts:63-105`, `service.md:618-622`). A signature is final.

   So signing builds on the attestation machinery and does not reuse `DecisionRow` (see D1).

3. **The ciphertext SHA-256 alone does not fix what a public signer saw.**
   - Public containers have no key commitment; only private seals do (decisions.md:1203). AES-GCM does not commit to a key, so one ciphertext can open to two different documents under two different links.
   - A plain SHA-256 of the plaintext would close that gap, but it would let the operator test whether a given file is on the service. format.md:239 forbids that.
   - The fix is a content MAC keyed from the content key (3.1).

4. **"Locked" has to mean different things for public and private reliks.**
   - A public relik serves only its current version (format.md:258: "there is no way to request an older one"). So locking a public relik means no republish while a request is open, and none after completion.
   - Earlier versions of a private relik stay openable. So locking a private relik means the signed version cannot be deleted.

5. **The served record cannot come from the access log.** The private mint and `deliverKey` both log the same kind, `wrap_fetch` (`app.ts:1336-1342`, `private/relic.ts:843-848`). Retention is the owner's setting, and the log is keyed by owner. Receipts need their own rows.

6. **A private lifetime change has to move storage erasure too.**
   - Private erasure runs off GCS `customTime` (`gcsstore.ts:117-128`).
   - Almost every object scoped to a private relik carries it (`privateCustomTime` call sites at `gcsstore.ts:756,832,876,1058,1137,1229,1759,1817,1852,1895,1946,1981,2000`), and so does the ciphertext (`gcs.ts:616-636`).
   - Extending a private lifetime therefore needs a sweep over all of those objects.
   - INFERRED from GCS documentation, not from this repo: `customTime` cannot be moved earlier by PATCH. Shortening a private lifetime ends access at the new time, but erasure keeps the original schedule.

## 2. Decisions this spec makes

Each is cheap to change.

| # | Decision | Rejected alternative, and why |
|---|---|---|
| D1 | Signing reuses the attestation machinery: `statementBytes`, `attestationChallenge`, `StoredAttestation`, `verifyAttestation`, `issueAttestNonce`. From decisions it reuses the share-proof gate, `digestOnRecord`, the passkey store with its counter compare-and-swap (`env.assertPasskey`, app.ts:719-720), the viewer's digest check and passkey bootstrap, the rule that no tool records a decision, and the per-relik switch pattern. | Reusing `DecisionRow` or the `decide` challenge: they are not content-committed, and the latest record wins. Moving decisions onto attestation is possible later, but it changes the decision wire and is a non-goal here. |
| D2 | One owner concept, `ownerIdentityId`, for both kinds. Owner actions in the browser are identity-signed, WebAuthn-attested statements (one tap). The MCP changes settings with the publish token. It creates and cancels signing requests with the publish token plus an owner-device signature, the same way a `seal` is signed. | Authority from `ownerEmail` (anyone can name a verified address). |
| D3 | Every signing request, public or private, needs an owner identity, so every certificate names a signed request. `relic_request_signatures` binds the device's owner first when the relik has none, and its description says so. | Unsigned public requests authorized by the token alone. |
| D4 | The content MAC and an encrypted layout and mark use keys derived from the content key, the same way comments are encrypted (format.md:268). | A plain plaintext hash (format.md:239); layout and marks in the clear. |
| D5 | Public lock means freeze: no republish while a request is open or after completion. Private lock means the signed version cannot be deleted, while republish and revocation stay allowed. Deleting a whole relik (private owner or operator) and expiry still remove everything. A locked relik's lifetime can be extended but not shortened. | Letting old public versions be minted again, which contradicts format.md:258. |
| D6 | Every private open records a served receipt (written by `deliverKey`) and an opened receipt (signed by the reader), for every reader, not just signers. | Receipts for signers only. |
| D7 | `row.settings` holds `{suggestions, comments, signing, notifications}`. Decisions stay in `decisionsOpen` and lifetime stays in `expiresAt`. A missing value means on, except decisions, which keep their default of off. | A separate settings document. |
| D8 | Closing comments does not apply to the publish token or the owner identity. | Closing comments for everyone, which breaks republish `addresses` acknowledgements. |
| D9 | Turning notifications off stops change notices and comment and activity mail. Signing mail, access requests and grant mail still go, and signing mail honours each recipient's stop link. | |
| D10 | Non-goals: deadlines, reminders, declining, flattening marks into the PDF, signing earlier versions, changing decisions. | |

## 3. Data model and wire contracts

### 3.1 relic-format

These contracts land first, in slice S1.

**Statement kinds.** Five new kinds are added to `StatementKind`, `StatementMap` and `SPECS` (`private.ts:42-60, 200-219, 1038-1158`). The bytes are unchanged: `UTF8("relic-statement/v1\n" + kind + "\n" + canonicalJson(s))` (`private.ts:318-326`). Signatures stay IEEE P1363 ECDSA P-256.

New field rules:
- `BOOL`.
- `REQUEST_ID`: base64url of exactly 16 bytes.
- `SIGNER_LIST`: 1 to 20 entries of `{email: EMAIL, identity_id: HEX_ID|null}`, distinct after `normalizeEmail`.

```ts
signing_request: { at, ciphertext_sha256, consent: 'relic/sign-consent/v1', content_mac, layout_sha256,
  order: 'parallel'|'sequential', owner_identity_id, relic_id, request_id, require_opened: BOOL,
  signer_id /* owner identity id or owner device id */, signers: SIGNER_LIST, version: int>=1 }
signing_cancel:  { at, owner_identity_id, relic_id, request_id, signer_id }
signature:       { at, ciphertext_sha256, consent: 'relic/sign-consent/v1', content_mac, mark_sha256,
  opened_receipt_sha256: HEX|null, relic_id, request_id, request_sha256, signer_email,
  signer_identity_id: HEX|null, signer_index: int>=0, version }
open_receipt:    { at, ciphertext_sha256, key_commitment, reader_identity_id, relic_id, version }
relic_settings:  { at, comments: BOOL, decisions: BOOL, lifetime: 'keep'|'never'|int>=1 (days),
  notifications: BOOL, owner_identity_id, relic_id, signing: BOOL, suggestions: BOOL }
```

Field definitions:
- `request_sha256 = hex(SHA-256(statementBytes('signing_request', request)))`.
- `opened_receipt_sha256 = hex(SHA-256(statementBytes('open_receipt', r)))` when the request requires opened; otherwise `null`.

Cross-checks:
- In a `signing_request`, the signers' `identity_id` values are all null (public) or all non-null (private).
- `require_opened: true` requires them all non-null.

**Attestation purposes.** `AttestPurpose` (`private-wire.ts:13-24`) adds `relic_settings`, `signing_request`, `signing_cancel` and `sign`. `PURPOSE_KINDS` (`attest.ts:33-48`) maps each to its one kind; `sign` maps to `signature`. Who signs each kind amends the format.md 3.17 table (:425-433):

| Kind | Signed by | WebAuthn |
|---|---|---|
| `signing_request`, `signing_cancel` | Owner identity (browser) or owner device (MCP) | Yes for identity, no for device |
| `relic_settings` | Owner identity | Yes |
| `signature` | Private: the signer's identity. Public: nobody (`identity_signature: ''`) | Always |
| `open_receipt` | The reader's identity | No |

**Keys.** These live in a new `src/signing.ts`, exported as `@relic/format/signing`. All use HKDF-SHA256 with an empty salt, as format.md 3.13 and 3.14 do.
- `signingKey = HKDF(ikm = content key, info "relic/signing/v1", 32)`. The content key is the 16-byte fragment key for a public relik and the version key for a private one.
- `content_mac = hex(HMAC-SHA256(HKDF(signingKey, "relic/signing/content-mac/v1", 32), content))`, streamed through `Sha256` (`sha256.ts:20`).
  - **content** means the bytes the content records decrypt to after the envelope header in record 0. For envelope v1 that is the file; for v2 it is the whole stream including the manifest (format.md 3.1, 3.20).
  - That equals `ReadyView.content` (`viewer.ts:699-746`) and `OpenedVersion.content|folderContent` (`private/open.ts:96-106`).
- Appearance values (layout and mark) are sealed as `base64url(nonce12 ‖ AES-128-GCM(HKDF(signingKey,"relic/signing/appearance/v1",16), canonicalJson(value), aad = UTF8(kind) ‖ 0x00 ‖ UTF8(relic_id) ‖ u32be(version)))`, where `kind` is `layout` or `mark`.
- Sharing `signingKey` lets the holder confirm the file and read the layout and marks. It does not reveal the content key or the comment key.

**Plaintext shapes.** Parsing is strict; unknown fields are refused.
- `SigningLayout {v:1, boxes:[{signer:int, page:1..10000, rect: AnchorRect}]}`.
  - `rect` uses the AnchorRect rules (`comments.ts:76-87, 1190-1205`).
  - At most 20 boxes per signer. Boxes are allowed only when the class is `pdf`.
  - A signer with no box signs in the block after the document.
- `SignatureMark {v:1, name: 1..128 UTF-8 bytes with no Cc or bidi characters, strokes: null | number[][]}`. At most 64 strokes and 2048 points, with coordinates in [0,1] at 3 decimals.
- `SIGN_CONSENT_TEXT = 'I agree to sign this document electronically. My passkey approval is my signature on this exact version.'`

**Wire JSON**, exported from `signing.ts`, snake_case:
- `RelicSettingsJSON {suggestions, comments, decisions, signing, notifications: boolean, changed_at: string|null, changed_by: 'publisher'|'owner'|null}`
- `SigningSummaryJSON {open_version: number|null, locked_versions: number[]}`
- `WebAuthnProofJSON {nonce, credential: AuthenticationResponseJSON, credential_id, public_key_jwk, alg: -7|-257, passkey_registered_at: string|null}`
- `SignatureRecordJSON {statement, identity_signature: string|null, mark_ciphertext, webauthn, recorded_at, opened_receipt: {statement, identity_signature}|null}`
- `SigningRequestJSON {request_id, version, status:'open'|'complete'|'cancelled', created_at, completed_at, cancelled_at, request:{statement, signature, signer_kind:'identity'|'device', attestation: WebAuthnProofJSON|null, layout_ciphertext}, owner:{identity: IdentityPublicJSON, device: DevicePublicJSON|null}, signers:[{index, email, identity: IdentityPublicJSON|null, status:'waiting'|'ready'|'signed'|'needs_access', served_at, opened_at, signature: SignatureRecordJSON|null}], cancellation}`
- `SigningStateJSON {relic_id, current_version, locked_versions, me:{signer_index, served_at, opened_at}|null, requests: SigningRequestJSON[] (newest first)}`
- Existing types gain fields:
  - `PrivateAccessJSON` (`private-wire.ts:168-183`) adds `settings`, `signing`, both null unless the role is owner, grantee or recovery.
  - `PublicAccessJSON` adds `manage: boolean`.
  - `AccessEventJSON.kind` adds `'settings'`.

### 3.2 Server rows, store and layout

This is slice S2. `RelicRow` (`store.ts:43-116`) adds:
- `settings?: {suggestions, comments, signing, notifications}`
- `settingsChangedAt?` and `settingsChangedBy?: 'publisher'|'owner'`
- `signingOpen?: {requestId, version}`, allowing at most one open request per relik
- `lockedVersions?: number[]`, append-only while the relik lives

New objects, all under the `m/` prefix. On a private relik each is written with `privateCustomTime`.

| Row | Key | Write rule |
|---|---|---|
| `SigningRequestRow` {statement, signature, signerKind, signerId, attestation?, layoutCiphertext, status, createdAt, completedAt?, cancelledAt?, cancellation?, completionMailedAt?} | `signing/{id}/{requestId}/request.json` | Create-only; status fields change by generation compare-and-swap |
| `SignatureRow` {signerIndex, email, attestation (`identitySignature ''` on public), markCiphertext, recordedAt, openedReceipt?} | `signing/{id}/{requestId}/signature-{index}.json` | Create-only, one per signer |
| Certificate | `signing/{id}/{requestId}/certificate.json` | Create-only |
| `ReceiptRow` {version, identityId, kind:'served'\|'opened', at, statement?, identitySignature?} | `receipt/{id}/{version}/{identityId}/{kind}.json` | Create-only; the first write wins |
| `SettingsChangeRow` {at, by, settings, expiresAt, attestation?} | `settings/{id}/{at padded to 15}-{8 hex}.json` | Create-only |

New `RelicStore` methods, implemented in both stores:
- `putSigningRequest`, `getSigningRequest`, `listSigningRequests`
- `updateSigningRequest`, a compare-and-swap whose change function may throw `ProblemError`
- `putSignature`, `listSignatures`
- `putCertificate`, `getCertificate`
- `putReceipt`, `listReceipts`
- `appendSettingsChange`
- `deleteSigningForRelic`
- `extendPrivateLifetime(id, expiresAt)`. It PATCHes a later `customTime` onto every object `privateCustomTime` dated, and onto each version's ciphertext. It is idempotent, throws on any failure, and never moves a time earlier.

`beginVersion` (`store.ts:612-627`) refuses inside its own compare-and-swap for public rows:
- `signingOpen` is set: `signing_in_progress`.
- The current version is in `lockedVersions`: `version_locked`.

### 3.3 Routes

All routes are POST with JSON bodies, read through `readBoundedJson` (65,536 bytes, `app.ts:4661-4719`).

Every route below runs the same prefix of checks first:

1. Kill switch: `503 service_paused` (writes only).
2. Rate limit: `429 signing_rate_limited`. Reads use the read budget.
3. `400 invalid_relic_id`.
4. Tombstone: `410 relic_removed`.
5. Missing row: `404 relic_not_found`.
6. The body.
7. Authorization.
8. Expiry: `410 relic_expired`, for writes only. Reads are allowed on expired reliks, as the decision list is (`service.md:648-650`).

| Route | Auth | Body | Success | Refusals after the prefix, in check order |
|---|---|---|---|---|
| `…/settings` | `publish_token`, or an owner session plus an attestation | MCP: `{publish_token, settings?: {suggestions?, comments?, decisions?, signing?, notifications?, ttl_days?: int\|null}}`. Browser: `{attestation}` (`relic_settings`). | 200 `{relic_id, settings, relic_expires_at}`. An empty or missing `settings` reads without writing. | `403 invalid_publish_token`, `401 sign_in_required`, `409 identity_required`, `403 owner_required`, attestation errors (`400 invalid_statement`/`invalid_passkey`, `403 passkey_verification_failed`, `409 passkey_required`), `400 invalid_settings` (`settings_check`: shape, unknown_key, type, lifetime, private_lifetime), `409 version_locked` (shortening a locked relik) |
| `…/signing/requests` | Owner session plus attestation (`signing_request`), or `publish_token` plus a device signature | Browser: `{attestation, layout_ciphertext}`. MCP: `{publish_token, request:{statement, signature, signer_kind:'device', device_id}, layout_ciphertext}` | 201 `SigningRequestJSON` | Authorization errors; device errors (`404 device_not_found`, `403 device_revoked`, `400 invalid_device`); `403 owner_required` (no owner, the statement names another owner, or the device is not the owner's); `400 invalid_statement` (stale or wrong relik); `409 signing_closed`; `409 share_unavailable` (a public relik with no `shareVerifier`); `400 invalid_signing_request` (`signing_check`: signers, request_id, layout, version (must be current), published, require_opened); `409 signing_digest_mismatch` (`version_digest`); `409 version_locked`; `409 signing_in_progress`; `409 signer_without_access` (`signer_email`; private only: no current identity, the identity differs from the statement, or no wrap for the version) |
| `…/signing/read` | Public: `share_proof` or `publish_token`. Private: `publish_token`, a session with a readable role, or a listed signer's session. | `{share_proof?\|publish_token?}` | 200 `SigningStateJSON`. Receipts are shown only to the owner or publisher; a signer sees their own under `me`. | `403 invalid_share_proof`/`invalid_publish_token`, `401`, `403 private_access_denied` |
| `…/signing/options` | A session. Public reliks also need `share_proof`. A body that carries `publish_token` is refused with `403 signing_requires_reader`. | `{request_id, share_proof?}` | 200 `{nonce, expires_at, public_key:{rpId, timeout:300000, userVerification:'required', allowCredentials}, request_id, version, version_digest, content_mac, request_sha256, signer_index, signer_identity_id, opened_receipt_sha256, consent:{id,text}}` | `401`, `403 invalid_share_proof`, `404 signing_request_not_found`, `409 signing_request_closed`, `409 signing_closed`, `403 not_a_signer`, `409 already_signed`, `409 signing_not_your_turn`. Private adds `409 identity_required`, `409 signer_identity_changed`, `403 private_access_denied`, `409 signing_open_required`. Then `409 passkey_required`. |
| `…/signing/signatures` | Same as options | `{request_id, share_proof?, attestation:{nonce, statements:[{kind:'signature', statement, identity_signature}], credential}, mark_ciphertext}` | 201 `{request_id, signer_index, recorded_at, status}` | Everything options can refuse, plus `400 invalid_signature` (`signing_check`: mark, binding), `400 invalid_statement`, `400 invalid_passkey`, `403 passkey_verification_failed` (nonce, counter, or a credential not bound to the identity), `409 signing_digest_mismatch`, `409 signing_content_mismatch`, `409 already_signed` (lost the create-only race), and `410 relic_removed` on the tombstone recheck after the write (as at `app.ts:5133-5152`) |
| `…/signing/cancel` | Same as requests (`signing_cancel`) | Browser: `{attestation}`. MCP: `{publish_token, cancel:{statement, signature, signer_kind:'device', device_id}}` | 200 `SigningRequestJSON` | Same as requests, plus `404 signing_request_not_found` and `409 signing_request_closed` |
| `…/signing/certificate` | Same as read. Private parties keep access after a revocation. | `{request_id, share_proof?\|publish_token?}` | 200 `SigningCertificateJSON` | Same as read, plus `404` and `409 certificate_not_ready` |
| `…/receipts/opened` | Private reliks, with a session | `{statement, identity_signature}` (`open_receipt`) | 201 `{relic_id, version, served_at, opened_at}`, or 200 if already stored | `400 invalid_receipt` (`receipt_check`: public, identity, signature, seal), `400 invalid_statement` (stale), `409 identity_required`, `403 private_access_denied`, `410 version_deleted`, `409 receipt_not_served` |

**Changes to `/api/attest/nonce`** (`app.ts:811-887`):
- `relic_settings`, `signing_request` and `signing_cancel` are added to `OWNER_PURPOSES` (`app.ts:789-793`). They are checked against `row.ownerIdentityId` for both kinds of relik, not through `privateRow` (`app.ts:865-871`).
- Purpose `sign` is refused there with `400 invalid_statement`, `statement_check: 'purpose'`. Only `…/signing/options` issues signer nonces.
- `issueAttestNonce` honours `allowedCredentialIds` for any purpose (`attest.ts:125-131`). For private signers that list is the identity's credentials.
- `verifyAttestation` and `verifyStoredAttestation` gain `identityFree`, which is true only for `sign` on a public relik. In that mode each `identity_signature` must be `''`.

### 3.4 Changes to existing routes

- **Mint.** The public mint response (`app.ts:2559-2571`) adds `settings` and `signing: SigningSummaryJSON`.
- **Access.** Public `/access` adds `manage` (`app.ts:1063-1075`). Private `/access` adds `settings` and `signing` (`privateAccessView`, `private/relic.ts:148`).
- **Grant.** A public grant may now carry `owner_attestation` (`owner_publish`).
  - A new function, `checkPublicOwnerPublish`, does this. It lives in `private/publish.ts` beside `checkOwnerPublish` (`:173-255`) and skips the private-policy refusals.
  - It sets `ownerIdentityId` and calls `putOwnedRelic(access:'public')`. The grant still returns `publish_token`.
  - `app.ts:1516` stops refusing a public owner publish.
- **Public republish.** `beginVersion` refusals must come back as 409. The public path is not inside `guarded` (`app.ts:1762, 1982-1991`).
- **Comments.** After author resolution (`app.ts:3820-3824`), and in `patchComment` for ciphertext edits: if `settings.comments === false` and the author is neither `publisher` nor the owner identity's session, refuse with `409 comments_closed`. Deleting and resolving stay allowed.
- **Notifications.** `fanOutNotifications` returns early when `settings.notifications === false` (guards at `app.ts:2603-2608`). That one path covers private activity mail too.
- **Served receipts.** `deliverKey` (`private/relic.ts:838-848`) writes `putReceipt(served)` beside the `wrap_fetch` log when the caller is a session, with the same failure semantics.
- **Private deletion.** In `deleteRelic` (`:1136-1159`), deleting a version listed with an open request fails with `409 signing_in_progress`, and deleting a locked version fails with `409 version_locked`. Deleting `'all'` (`:1107-1134`) and operator delete (`app.ts:3528-3576`) also call `deleteSigningForRelic` and report `signing_deleted`.
- **Policy.** The `/policy` disclosure (`disclosureStatement`, `app.ts:7314`) adds what signing stores in the clear (signer addresses, statements, passkey public keys, receipts) and what it never stores (marks, layout, keys).

### 3.5 Problem codes and config

`problems.ts` adds these codes:

| Code | Status |
|---|---|
| `invalid_settings` | 400 |
| `comments_closed` | 409 |
| `signing_closed` | 409 |
| `signing_rate_limited` | 429 |
| `invalid_signing_request` | 400 |
| `signing_request_not_found` | 404 |
| `signing_request_closed` | 409 |
| `signing_in_progress` | 409 |
| `version_locked` | 409 |
| `signing_digest_mismatch` | 409 |
| `signing_content_mismatch` | 409 |
| `signing_requires_reader` | 403 |
| `not_a_signer` | 403 |
| `already_signed` | 409 |
| `signing_not_your_turn` | 409 |
| `signer_without_access` | 409 |
| `signer_identity_changed` | 409 |
| `signing_open_required` | 409 |
| `receipt_not_served` | 409 |
| `invalid_receipt` | 400 |
| `invalid_signature` | 400 |
| `certificate_not_ready` | 409 |

New extensions: `settings_check`, `signing_check`, `receipt_check`, `request_id`, `signer_email`, `signer_index`, `locked_version`. `version_digest` is reused.

`config.ts` adds:

| Key | Value |
|---|---|
| `signingMaxSigners` | 20 |
| `signingMaxBoxesPerSigner` | 20 |
| `signingLayoutMaxChars` | base64url length of 16 KiB plus 28 bytes |
| `signingMarkMaxChars` | base64url length of 32 KiB plus 28 bytes |
| `signingRateLimit` | 60 per 3,600 s, per IP, for writes and receipts |
| `signingReadRateLimit` | 600 per 3,600 s |
| `signingMailRateLimit` | 10 per 3,600 s, per relik and address |
| `settingsMinLifetimeSeconds` | 3,600 |

`assertConfig` must keep `settingsMinLifetimeSeconds` below `privateMaxTtlDays × 86,400`.

### 3.6 Mail

**Attachments.** `OutboundMail` (`mail.ts:45-50`) adds `attachments?: {filename, contentType:'application/json', content: Uint8Array}[]`. They are sent through `sendMail` only. INFERRED from Resend's documentation: the batch endpoint takes no attachments.

**Templates.** Public mail may name the title and the owner's address. Private mail is generic: no title and no other party's address.
- **Public.**
  - `signingTurnMail`: subject `It's your turn to sign "{title}"`. The body says to open the link the owner sent, because "Relik never holds the key, so this email can't include it."
  - `signingCompleteMail`: goes to every signer and to the owner identity's address. Subject `Everyone signed "{title}"`. It lists each signer with a UTC time, the version, the first 16 hex characters of the digest, and the expiry. It includes the sentence on what the certificate proves and does not prove (C4 in section 10). The certificate is attached as `relik-{id}-v{n}-signing.json`, without `signing_key`.
  - `signingCancelledMail`.
- **Private.** `privateSigningInviteMail`, `privateSigningTurnMail`, `privateSigningCompleteMail` ("Open it to download the signing certificate.") and `privateSigningCancelledMail`.

**When mail is sent.**
- **Invitations** go at request creation, for private reliks only: to every signer in parallel order, or to index 0 in sequential order.
- **Turn mail** goes after each signature in sequential order.
- **Completion mail** goes once, claimed through a compare-and-swap on `completionMailedAt`, the same pattern as `claimVersionNotice`. A crash drops a send rather than repeating it.
- **Guards before every send:**
  - `isOptedOut` is checked immediately before sending.
  - The limiter key is `signing ${relicId} ${address}`.
  - Each send also checks and uses the global `change-notice` fuse.
- **Never in any mail:** a fragment or any key material.

The comment at `mail.ts:460-467` changes from four private messages to eight.

## 4. Authority, replay, version binding, republish

| Act | Public relik | Private relik |
|---|---|---|
| Read settings | Anyone holding the id (mint response) | A readable role (`/access`) |
| Change settings | `publish_token`, or an owner session plus attested `relic_settings` | Same |
| Create or cancel a signing request | Owner session plus attestation, or `publish_token` plus an owner-device signature | Same, and every signer must hold access to the version |
| Read signing state or the certificate | `share_proof` or `publish_token` | `publish_token`, a readable role, or a listed signer, even after revocation |
| Sign | A listed address's session, plus `share_proof`, plus a passkey for that address (trusted on first use, as decisions are) | A listed address's session whose current identity is the pinned `identity_id` and has standing for the version, plus a passkey bound to that identity, plus an identity signature |
| Opened receipt | Not applicable | The reader's own identity (session plus signature) |
| Served receipt | Not applicable | Written by the service in `deliverKey` |

**No MCP tool ever creates a `signature` or an `open_receipt`.**

**Replay protection:**
- An attested statement needs a single-use nonce bound to its purpose, email and relik (`attest.ts:287-305`). Its `at` must be within ±300 s (`:273-276`), and the passkey counter is checked by compare-and-swap.
- A device-signed request or cancel needs `at` within ±300 s, the publish token, and a create-only `request_id` (a replayed request is a duplicate). A cancel only acts on its own open request.
- A signature is create-only per signer index, and its challenge commits to the statement bytes.
- Receipts are create-only.

**Version binding.** These must all agree, or the request or signature is refused:
- The signature's `ciphertext_sha256` and the request's equal `digestOnRecord(row, version)`.
- The signature's `content_mac` equals the request's.
- The signature's `request_sha256` equals the hash of the stored request.
- `mark_sha256` equals the hash of the stored mark ciphertext.
- `signer_email` matches the session and `signers[signer_index]`.
- On a private relik, `opened_receipt_sha256` equals the hash of the stored opened receipt, and the opened receipt's `ciphertext_sha256` and `key_commitment` equal the seal's.

**Completion and the lock.**
- Requests can only be opened on the current published version (private: the current sealed version).
- When the final signature lands, the request moves from `open` to `complete` by compare-and-swap; when two final signatures race, exactly one wins.
- One `updateRelic` then clears `signingOpen` and appends the version to `lockedVersions`. This happens in a single compare-and-swap, so there is never a moment with neither.
- Next comes the certificate, written create-only after a self-check (5.4), and then the mail.
- `finishCompletion` is idempotent and runs again on reads and writes, which repairs a crash between those steps.
- Republish:
  - **Public:** refused while a request is open or the current version is locked, checked inside `beginVersion`'s compare-and-swap.
  - **Private:** always allowed, including revocation republishes. The request stays bound to its version, which stays openable.
- A cancelled request can be followed by a new one.

**Append-only.** Requests (except their status fields), signatures, receipts, certificates, settings changes and `lockedVersions` are never edited or removed while the relik lives. Deleting the whole relik or expiry removes them, consistent with "no decision outlives its relik" (`service.md:625`).

## 5. Ceremonies, certificate, offline verification

### 5.1 Public relik

1. **The owner creates the request.** The browser builds the layout from box placement and seals it with `signingKey` from the fragment key. It computes `content_mac` from `view.content`, signs `signing_request` with the identity, attests it with one tap, and POSTs. The MCP does the equivalent in section 7.
2. **The owner sends invitations.** The owner's client composes each invitation with the full link, as sharing does: the key never reaches the service (decisions.md:751). The browser offers Copy and an email draft; the MCP returns drafts.
3. **The signer opens the link.** The viewer mints the version and decrypts it (`versionDigest`, existing). The mint's `signing.open_version` matches, so the viewer calls `signing/read` with `share_proof`. It then:
   - shows the owner's address and fingerprint, after verifying the request statement's signature chain (identity, or device plus `device_cert`);
   - opens the layout;
   - computes `content_mac` over `view.content` in chunks of `CONTENT_BATCH_BYTES`. If that differs from the request, it shows C7 (section 10) and no Sign button.
4. **The signer prepares to sign.** The signer signs in if needed, using the existing link, code or passkey sign-in. They click a box or the block, type a name and optionally draw a mark, then tick the consent box.
5. **The viewer prepares the ceremony before the click.** It calls `signing/options`, checks `version_digest` and `content_mac` against its own values, seals the mark, builds the `signature` statement with `signer_identity_id: null`, and computes `attestationChallenge(nonce, [bytes])`.
   - **Click timing:** the Sign click calls `navigator.credentials.get` synchronously, keeping the user activation, as `decision-panel.ts:1656-1679` does.
   - **Expiry:** if the preparation is more than 240 s old, the viewer prepares again.
6. **The viewer POSTs the signature.** The server runs `verifyAttestation('sign', identityFree)`, checks the bindings, and writes create-only. In sequential order it sends turn mail; on the last signer it completes.

### 5.2 Private relik

1. **The owner creates the request** in the private reader (role owner) or through the MCP. `signers[].identity_id` comes from the owner's grants (`GET …/grants`) or, for the MCP, from `POST …/recipients` (`service.md:767-769`). The service sends generic invitations.
2. **The signer opens the relik.** They sign in, the passkey unlocks the identity through PRF, and `openSealed` runs (`private/reader.ts:663-679`). If the request's version is not the latest sealed version, the signing panel opens it with `fetchAndDecryptVersion(…, request.version, …)`.
3. **The opened receipt is posted after verification.** `fetchAndDecryptVersion` returns only after the seal, the key commitment and the digest all check out (`private/open.ts:421-425, 485-529`). Then the reader signs `open_receipt` with the unlocked identity key, using `opened.digest` and `opened.keyCommitment`, and POSTs it. This happens for every reader, not only signers, and a failure does not block reading.
   - `OpenedVersion` gains `keyCommitment` and `signingKey`, derived inside `open.ts` so the raw version key never leaves it.
4. **The viewer checks the request.** It reads the signing state and checks that the request chains to the pinned owner (`PinnedOwner`). If not, it shows "This signing request isn't signed by this relik's owner" and no Sign button. It opens the layout and checks `content_mac`.
5. **The signer signs.** Options run as in 5.1. The statement carries `signer_identity_id`, and `opened_receipt_sha256` when the request requires it. The identity signs the statement bytes, and one tap attests them; PRF is not needed again.
6. **The server verifies.** It runs `verifyAttestation('sign')` with `identitySigner(signerIdentity)`, checks that the credential is bound to the identity (as `publish.ts:235-237` does), checks standing with `requireRead`, the receipt hash and the bindings, then appends the signature. Completion mail is generic.

### 5.3 Certificate (`SigningCertificateJSON`)

```ts
{ format: 'relic/signing-certificate/v1', service: { origin, rp_id }, relic_id, access: 'public'|'private',
  title: string|null /* public only, unsigned service record */, version, ciphertext_sha256, content_mac,
  request: { statement, signature, signer_kind, attestation: WebAuthnProofJSON|null, layout_ciphertext },
  owner: { identity: IdentityPublicJSON, device: DevicePublicJSON|null /* with its owner-signed cert */ },
  signatures: [{ signer_index, statement, identity_signature: string|null, signer_identity: IdentityPublicJSON|null,
    mark_ciphertext, webauthn: WebAuthnProofJSON, recorded_at /* service clock */,
    receipts: { served_at: string|null /* service record */, opened: {statement, identity_signature}|null } | null }],
  completed_at /* service clock */,
  signing_key?: string /* base64url; only in a copy built in the reader's own viewer or MCP */ }
```

The server builds the certificate at completion and runs the relic-format verifier on it with `expectedOrigin = config.serviceOrigin` before storing it. If that check fails, the certificate is not stored and the error is logged; the repair path tries again.

### 5.4 Offline verification and the verifier

These live in `@relic/format/signing`, use WebCrypto only, make no network calls, and also run in the browser:

```ts
verifySigningCertificate(cert: unknown, opts?: { signingKey?: Uint8Array; content?: Uint8Array | AsyncIterable<Uint8Array>; expectedOrigin?: string }): Promise<CertificateReport>
verifySignatureRecord(input: { request, owner, record, origin, rpId }): Promise<SignatureCheck[]>   // the panel uses it per signature
verifyWebauthnAssertion(credential, { challenge, origin, rpId, publicKeyJwk, alg, credentialId }): Promise<void>   // throws a named check
CertificateReport = { valid, checks: {id, ok, detail?}[], relic_id, version, access, completed_at,
  owner: {email, identity_id, fingerprint}, signers: [{index, email, signed_at, recorded_at, credential_id,
  identity_fingerprint|null, opened: boolean|null, name: string|null}], content: 'match'|'mismatch'|'not_checked' }
```

The procedure, with each check's id:

1. **`format`**: strict parse of the certificate, and `rp_id === new URL(origin).hostname`. If `expectedOrigin` is given, `origin` must equal it; otherwise the report states the origin it trusted.
2. **`request_statement`**: `parseStatement('signing_request')`. Its relik, version and digests must equal the top-level fields.
3. **`request_signer`**:
   - **Identity:** `identityIdOf(kem, sig) === owner_identity_id === signer_id`, and the signature verifies under `sig`. Then **`request_attestation`**: the WebAuthn proof verifies over `attestationChallenge(nonce, [request bytes])`.
   - **Device:** `deviceIdOf(kem, sig) === signer_id`. The `device_cert` statement is identity-signed by the owner, names the same keys, has `at ≤ request.at ≤ not_after`, and the device signature verifies.
4. **`signers_complete`**: exactly one signature per signer index.
5. **For each signature:**
   - **`signature_statement`** parses.
   - **`signature_binding`**: relik, version, `ciphertext_sha256`, `content_mac` and `request_id` match; `request_sha256` equals the recomputed request hash; `signer_email` and `signer_identity_id` equal `signers[i]`.
   - **`consent`** is a known id.
   - **`mark_hash`** matches.
   - **`signature_webauthn`**: `verifyWebauthnAssertion` with the challenge recomputed from the statement bytes. It checks:
     - `type webauthn.get`, the challenge, the origin, and that `crossOrigin` is not true;
     - `rpIdHash = SHA-256(rp_id)`;
     - UP and UV are set and AT is clear;
     - any extension data (ED) is exactly one CBOR map that fills the rest;
     - the signature over `authData ‖ SHA-256(clientDataJSON)`, ES256 with DER converted to P1363, or RS256.
   - **Private only:**
     - **`signature_identity`**: the identity id matches its keys and the statement signature verifies.
     - **`opened_receipt`**: when required, the receipt parses, verifies under the same identity, matches the version's digest and `key_commitment`, and its hash equals `opened_receipt_sha256`.
6. **`order`**: in sequential requests, `at` does not decrease as `signer_index` rises.
7. **`content`**: only when `signingKey` and `content` are both given; it compares the content MAC. With `signingKey` alone, the report also decrypts the marks to show names.

The service records (`recorded_at`, `completed_at`, `served_at`, `passkey_registered_at`, `title`) are reported and labelled as unsigned.

## 6. Settings: enforcement, guarantees, propagation

| Switch | Enforced at | Guarantees | Cannot guarantee |
|---|---|---|---|
| Suggestions | Viewer only. The Suggesting control is not drawn and the controller is not mounted (`main.ts:7119-7154, 7222-7269, 7287-7305`). | Readers who open the relik after the change get no suggestion controls. | A suggestion is an encrypted comment the server cannot tell apart (`store.ts:417-430`, comments.ts sealed `suggestion`). A page already open can still send one until it reloads. Existing suggestions still show, and the MCP can still apply them. |
| Comments | Server: the comment POST, and PATCH of ciphertext. Viewer hides the composer (`main.ts:7040-7077, 9321-9408`). | No new comment or edit from a reader. This covers suggestions too. | The publisher and owner can still comment, by design (D8). |
| Decisions | The existing `decisionsOpen` gates (`app.ts:4861-4868, 5237-5244`). | Existing behaviour. | Nothing new. |
| Signing | Server: request creation, options and record. | Nobody can sign while it is off. An open request is paused, not cancelled. | Nothing new. |
| Notifications | Server: `fanOutNotifications`. | No change notices and no comment or activity mail. | Signing, access-request and grant mail still go (D9). |
| Lifetime | Server: `expiresAt`. Private extension runs the `customTime` sweep first and updates the row last. | Access ends at the new time. Private reliks always keep a finite expiry, at most now plus 365 days per change. | Shortening a private lifetime does not move erasure earlier (correction 6). A locked relik cannot be shortened. |

**How the viewer learns settings.**
- **Public:** from the mint response, plus `GET /access` for `manage` when a session exists. The public viewer does not call `/access` today.
- **Private:** from `/access`.

**Propagation.**
- Every route reads the row from GCS on every request. There is no row cache (`gcsstore.ts:188-205, 457-459`).
- Mint is a POST with no cache headers (`app.ts:2559-2571`).
- So a write shows up on every instance at its next request.
- A page that is already open catches up when it reloads, and the server enforces the switch in the meantime.
- **Proof:** the end-to-end path runs two `createApp` instances over one store, flips a setting through A, and is refused through B.

## 7. MCP surface

None of these tools ever records a signature or a receipt. Every description says: "Signatures are made by a person in the viewer with their passkey. No tool signs or records a signature on anyone's behalf."

| Tool | Arguments | Behaviour and result |
|---|---|---|
| `relic_settings` | `relic_id`; optional `suggestions`, `comments`, `decisions`, `signing`, `notifications` (booleans); `ttl_days` (integer, or null for no expiry, public only; at most 365 for private) | POSTs `…/settings` with the token. Returns `{relic_id, settings, relic_expires_at}`. With no keys it only reads. The description states each switch's guarantee from section 6. |
| `relic_request_signatures` | `relic_id`; `signers:[{email, boxes?:[{page, x, y, w, h}]}]` (1-20); `order` (default `parallel`); `require_opened` (private only, default false) | Needs local publish state and an enrolled device whose owner owns the relik, and binds the owner if the relik has none. Mints and decrypts the stored version to compute `ciphertext_sha256` and `content_mac`. Seals the layout, device-signs `signing_request`, and POSTs. Boxes are refused unless the class is `pdf`; page numbers are not checked here, so the viewer refuses a box beyond the last page. Returns `{relic_id, request_id, version, status, order, signers}`. Public reliks also get `invitations:[{to, subject, text, mailto_url}]` carrying the full link; private reliks get "Relik emailed each signer". |
| `relic_read_signing` | `relic_id`; optional `request_id`; optional `save_certificate_to` (a path that must not exist; written 0600) | Reads with the token, decrypts the layout and marks locally, and returns each signer's status, receipts and typed name. Once complete, it can save the certificate with `signing_key` added. |
| `relic_cancel_signing` | `relic_id`, `request_id` | Device-signs `signing_cancel` and sends it with the token. |
| `relic_verify_certificate` | `certificate_path`; optional `file_path`; optional `origin` (defaults to the configured service origin) | Local only, no network: runs `verifySigningCertificate` and returns the report. |

Two existing tools change:
- `relic_show` adds `settings` and `signing` from the mint response.
- `relic_describe_client` describes signing.
- `docs/spec/publish.md` 1.6 updates the tool count (it currently says "Sixteen tools").

## 8. Slices

The verify command is `bun run verify` (root `package.json:14`). Workers do not run it mid-slice; the integrator runs it and the paths.

| Slice | Owns | Depends on |
|---|---|---|
| **S0 Mock** (designer) | `docs/plans/signing/{plan.md (this spec), mockup.html, mock-shots/}` | None |
| **S1 Format contract** | `relic-format/src/{private.ts, private-wire.ts, signing.ts (new), webauthn-verify.ts (new), signing.test.ts, webauthn-verify.test.ts}`, `package.json` (export `./signing`), `docs/spec/format.md` (new 3.21, 3.17 table) | None. **Lands first.** |
| **S2 Server foundation** | `store.ts`, `gcsstore.ts`, `problems.ts`, `config.ts`, `private/attest.ts`; in `app.ts`: `OWNER_PURPOSES` and attest nonce (789-887), republish mapping (1982-1991), operator delete (3528-3576); in `private/relic.ts`: `deleteRelic 'all'` (1107-1134); `test/webauthn-differential.test.ts` | S1 |
| **S3 Server settings and gates** | `settings.ts` (new); in `app.ts`: a settings dispatch block inserted before the Decisions block at 641, mint 2559-2571, `/access` 1063-1075, grant 1514-1518 and 1664-1720, postComment and patchComment, fanOut 2603-2608; `private/relic.ts privateAccessView`; `private/publish.ts checkPublicOwnerPublish`; `private/access.ts` (`logAccess 'settings'`) | S2 |
| **S4 Server signing** | `signing.ts` (new), `private/receipts.ts` (new), `mail.ts`; in `app.ts`: signing and receipts dispatch inserted after the Decisions block at 662, `disclosureStatement` 7314; in `private/relic.ts`: the `deliverKey` hook (838-848) and the version-delete lock (1136-1159) | S2 (runs in parallel with S3) |
| **S5 Viewer settings and gates** | `settings-panel.ts` (new), `settings.ts` (new), the `MintResponse` and `ReadyView` fields in `viewer.ts`; in `main.ts`: a Settings band control at the end of the actions row (after 1110-1141) and the gates at 7040-7305 and 9321-9408; `private/reader.ts` access parsing; `publish-view.ts` and `publish.ts` owner-bind option; a `/* settings */` block in `styles.css` | S1 |
| **S6 Viewer signing** | `signing/{api, panel, composer, boxes, mark-pad, certificate}.ts` (new); in `main.ts`: a Signing band control after Decisions (1094-1102), a post-document block at the stage (2139-2146), and a PDF overlay on the `canvas.relic-page` path (1951-2013, `pdf.ts:116-152`) reusing `anchoring.ts:81-169`; `private/open.ts` (`OpenedVersion` fields); `private/reader.ts` (receipt after 670-675, opening the request's version); a `/* signing */` block in `styles.css` | S1 |
| **S7 MCP** | `relic-mcp/src/server.ts` (5 tools), `settings.ts`, `signing.ts`, `verify-certificate.ts` (new), `relic_show` fields, `docs/spec/publish.md` | S1 |
| **S8 Proof** | `relic-mcp/test/signing-path.ts`, `signing-proof-steps.ts`, root `PATH.md` and `packages/relic-mcp/PATH.md` entries, `.github/workflows/verify.yml` step "Signing path" after line 164 | S3-S7 |
| **S9 Docs** | `docs/decisions.md` entry, `docs/frame.md` reversals, `docs/spec/service.md` (new §11 Settings, §12 Signing, refusal tables 1.18 and 1.19, 10.1, 10.2, 10.6), `docs/spec/viewer.md` | Drafted in parallel; final after S8 |

Rules for every slice: no em-dashes in copy, user-facing copy spells "relik", and nothing writes to live systems.

**Acceptance per slice.** Each is something a person can observe.
- **S1.** Frozen known-answer vectors pass: `statementBytes` for each new kind, `deriveSigningKey`, `content_mac`, and appearance seal and open. A golden certificate built from a recorded virtual-authenticator assertion verifies as valid. Each single mutation flips exactly its named check to fail: one flipped field per check id, UV cleared, `rpIdHash` wrong, origin wrong, a signature byte flipped, `device_cert not_after < at`, a missing signer, a wrong mark hash, a wrong order, and a content swap that gives `mismatch`.
- **S2.**
  - The store contract suite passes on `MemoryStore` and on `gcsStore` over the fake GCS: create-only collisions, compare-and-swap, and `extendPrivateLifetime` moving `customTime` on every relik-scoped object and every version's ciphertext without touching other reliks.
  - Public republish with `signingOpen` set returns 409 `signing_in_progress`, not 500.
  - Owner purposes on public reliks are issued only to the owner identity; `sign` is refused at `/attest/nonce`.
  - The differential test agrees between the server's `verifyAssertion` and the relic-format verifier on at least 6 fixtures.
- **S3.**
  - With comments set off by token: a reader gets 409, the publisher gets 201, and the owner session gets 201.
  - With notifications off, a republish sends 0 mails.
  - The mint shows the settings, and public `/access` shows `manage`.
  - The lifetime rules hold: a public `null` is accepted, a private `null` gets 400, over the maximum gets 400, shortening a locked relik gets 409, and a private extension moves `customTime`.
  - Two app instances over one store see a flip at once.
  - A public owner publish sets `ownerIdentityId`.
- **S4.**
  - Every refusal in 3.3 and both happy paths pass.
  - Two final signatures racing produce one certificate and one set of mails.
  - The stored certificate passes the S1 verifier.
  - No signing mail contains `#` or key material.
  - Private signing mail has no title and no other party's address.
  - An opted-out address gets nothing.
- **S5.**
  - With comments off, a reader has no composer and the owner does.
  - With suggestions off, there is no Suggesting control and no controller mount.
  - The Settings panel submits an attested snapshot, and the lifetime form respects the limits.
- **S6.**
  - Boxes paint on the right page, and the block appears after a non-PDF.
  - The click calls `credentials.get` synchronously.
  - A content mismatch hides Sign.
  - A private receipt is posted only after `fetchAndDecryptVersion` resolves.
  - The certificate download includes `signing_key` and passes the verifier in the browser.
- **S7.**
  - Exactly 5 new tools exist, and none records a signature.
  - Public invitations carry the fragment; private results carry none.
  - The verify tool reports valid on the golden certificate and invalid on a tampered one.
- **S8.** The path prints every receipt in section 11 and `SIGNING_PATH_OK`.
- **S9.** The docs match what shipped, and the brand-spelling test passes.

**Contract risks:**
1. **Byte agreement on new statements and the content MAC.** The viewer, server, MCP and verifier must produce identical `statementBytes` and an identical `content_mac` over identical content bytes. The weak spot is the folder (v2) stream and the MCP's decrypt. The path asserts that the MCP's `content_mac` equals the viewer's for a PDF, a markdown file and a folder.
2. **Two WebAuthn verifiers.** relic-format gains a portable verifier beside the server's `node:crypto` one (`webauthn.ts:666-844`). The differential test and the certificate self-check guard against drift.
3. **Lock atomicity.** The checks run inside the same compare-and-swap that changes the version (`beginVersion`). Completion is a single `updateRelic` that clears `signingOpen` and sets `lockedVersions`.
4. **The private lifetime sweep.** A partial sweep must leave the row unchanged so a retry finishes it. Production GCS behaviour is unproven locally (`service.md:888`).

## 9. Review risks

Independent review is required for S1, S2, S3 and S4, because each is a security boundary. Each is checked against a fixed list of risks. Findings outside that list are logged as separate work.

- **S1.**
  - HKDF labels are distinct from `relic/comments/v1` and `relic/share-proof/v1`.
  - The AAD binds the relik and version.
  - The verifier refuses any certificate whose origin was not checked when `expectedOrigin` is set.
  - The CBOR walker refuses trailing bytes.
  - **Evidence that passes:** a negative control per check.
- **S2.**
  - `extendPrivateLifetime` never calls delete and never moves a time earlier.
  - The `deleteSigningForRelic` counts appear in the sweep responses.
  - `identityFree` cannot be reached for any purpose other than public `sign`.
- **S3.**
  - The owner check uses the current identity (`currentIdentity`), not `ownerEmail`.
  - Public owner publish verifies `body_sha256` over the grant without `owner_attestation`.
  - Comments-closed exemptions cannot be spoofed by a body field.
- **S4.**
  - Every binding in section 4 is checked before the write.
  - The nonce is spent win or lose.
  - Receipts can only be written by the identity they name.
  - Mail contains no fragment.
  - A private signer's credential is bound to their identity.
  - Read authorization withholds receipts from non-owners.
- **S5 and S6.**
  - Untrusted marks and names render as text or canvas, never as HTML.
  - The signature block lives in the parent page, never inside the sandboxed frame.
- **S7.**
  - Keys never appear in tool output except the deliberate `signing_key` in a saved certificate.
  - Invitation drafts are the only output that contains a fragment.

## 10. Mock (S0)

Conventions follow `docs/plans/version-compare/plan.md:584-619`:
- One self-contained `mockup.html` with no `<script src` and no `<link href`.
- States register with `S(key, group, title, cfg)`, the initial state comes from the hash, and `data-ready` is set after two animation frames.
- Theme and width toggles.
- The viewer's real band and panel chrome.
- Fixtures: "Studio lease, Unit 4B", version 3, owner jason@waldrip.net, signers ana@harbor.studio and ben@harbor.studio, a 6-page PDF.

| Group | States |
|---|---|
| ST Settings | ST1 public owner, all switches on, lifetime "Never". ST2 private owner, lifetime required, "at most 365 days from today", and the note on shortening erasure. ST3 Save with the passkey prompt. ST4 Saved, "Changed just now". ST5 lifetime out of range. ST6 locked relik where lifetime can only be extended. ST7 at 390 px as a sheet. |
| RG Reader gates | RG1 comments closed, reader view. RG2 comments closed, owner view (C10). RG3 suggestions off, no Suggest control, an existing suggestion still listed. RG4 decisions off, no Decisions control. |
| RQ Composer | RQ1 PDF, signer list, colour per signer, a box dragged on page 2, order toggle. RQ2 page 4 with two boxes for signer 2, plus the keyboard "Add box on this page" control. RQ3 markdown with a block preview after the document. RQ4 private: a signer without access warning, "Grant access first", the "Require opened" toggle. RQ5 confirm with C3 and the passkey. RQ6 public invitations with Copy and Email draft, "The link carries the key. Relik never sees it." RQ7 private: "Relik emailed both signers". |
| SG Signer | SG1 banner "jason@waldrip.net asked you to sign version 3", boxes highlighted on the PDF, owner fingerprint. SG2 typed mark. SG3 drawn mark. SG4 consent with C1, C2, and Sign disabled until ticked. SG5 passkey in progress. SG6 signed, "You signed at 14:02 UTC. 1 of 2 signed." SG7 waiting for turn (C8). SG8 private with the "Opened and checked" chip. SG9 content mismatch (C7). SG10 signing paused (C9). SG11 a non-signer key holder, read-only status. SG12 block after a markdown document. SG13 at 390 px. SG14 no passkey yet, create one using the decision panel's passkey screen. SG15 a box beyond the last page, refused. |
| SS Status | SS1 public open request with per-signer status. SS2 private with Served, Opened and Signed columns and the C12 legend. SS3 complete: lock banner, Download certificate, "Verified in this browser" with its check list. SS4 cancel confirmation. SS5 cancelled. |
| LK Lock | LK1 public C5 banner on the band. LK2 private relik at v4 with "Version 3 is signed" and a link (C6). |
| CF Certificate | CF1 readable certificate with "What this proves" and "What this doesn't prove" (C4). CF2 a tampered certificate with the failing check named. |
| EM Email | EM1 public turn. EM2 public completion with the attachment chip. EM3 private invite. EM4 private completion. EM5 public cancelled. EM6 MCP invitation draft with the full link. |

**Shots:** 1440 light for every key; 1440 dark for ST1, SG1 and SS3; 390 light for ST7 and SG13.

**Copy, verbatim:**
- **C1:** "I agree to sign this document electronically."
- **C2:** "Your passkey approval is your signature on version {n} of this file. It shows that a device holding your passkey for {email}, signed in to that address, approved this exact file at the time shown. Relik doesn't check who you are, and it doesn't say whether an electronic signature is legally binding where you are."
- **C3:** "Each signer confirms with a passkey on their own device. Relik records which passkey approved which version, and when. It doesn't verify anyone's identity."
- **C4:** "Proves: each listed passkey approved this exact version after agreeing to sign electronically, and the request came from the owner shown. Doesn't prove: who held the passkey, that the person is who the address suggests, or that the signature is legally binding. On a public relik a passkey is trusted from its first use with that address. Times come from each signer's device, checked by Relik to within 5 minutes."
- **C5:** "Version {n} was signed by everyone on {date}. It's locked: this relik can't be republished."
- **C6:** "Version {n} was signed by everyone on {date}. It can't be deleted."
- **C7:** "This file doesn't match the one you were asked to sign. Don't sign it. Ask {owner} to send the request again."
- **C8:** "Waiting for {email} to sign first."
- **C9:** "Signing is paused by the owner."
- **C10:** Reader: "Comments are closed." Owner: "Comments are closed to readers. You can still comment."
- **C12:** "Served: Relik handed over their key (Relik's record). Opened: their browser opened and checked this version (signed by them)."

## 11. End-to-end proof (S8)

**Existing proof and its blind spots.**
- `decision-path.ts` and `private-shares-path.ts` run on the loopback with a virtual CTAP2 authenticator with UV and PRF (`decision-proof-steps.ts:154-262`). CI runs them at `verify.yml:157-158` and `:163-164`.
- Blind spots:
  - The virtual authenticator answers by itself (decisions.md:1019).
  - Real PRF providers are untested (decisions.md:1212).
  - Production GCS `customTime` behaviour is unproven (`service.md:888`).
  - Resend attachments and real delivery are unproven.

**The new path.** `RELIC_CHROME_PATH=<owned headless shell> bun packages/relic-mcp/test/signing-path.ts`, run after `bun run build` and the MCP bundle build. It uses two app instances over one `MemoryStore`/`MemoryStorage`, captured mail and an injected clock. Its receipts, in order:

1. `SIGNING_STEP_1_SETTINGS_MCP reader_comment=409 publisher_comment=201 owner_comment=201 notices_on_republish=0 suggest_control=absent instance_b_refused=true`
2. `…_2_SETTINGS_OWNER taps=1 reload_sees_change=true session_without_identity=409`
3. `…_3_PUBLIC_REQUEST signers=2 order=sequential invitations_have_fragment=true server_mail_fragment=false layout_plaintext_on_server=false mcp_mac=viewer_mac`
4. `…_4_OUT_OF_TURN options=409`
5. `…_5_SIGN_1 taps=1 turn_mail=ben`
6. `…_6_REPUBLISH_WHILE_OPEN 409 signing_in_progress`
7. `…_7_SIGN_2 complete=true locked=[3] completion_mails=3 attachment=true cert=valid content=match`
8. `…_8_LOCKED republish=409 shorten=409 extend=200`
9. `…_9_TAMPER field_flip=invalid content_swap=mismatch`
10. `…_10_PRIVATE_REQUEST signer_without_grant=409 invites_generic=true`
11. `…_11_RECEIPTS served=true opened=verified api_only_signer_options=409 signing_open_required`
12. `…_12_PRIVATE_COMPLETE cert=valid identity_signatures=2 opened_receipts=2 delete_locked_version=409 mails_name_title=false`
13. `…_13_LIFETIME private_extend_customtime_moved=true private_shorten_access_ends=410`
14. `…_14_MCP_NEVER_SIGNS record_tools=0 read_signing=ok verify_tool=valid`
15. `…_15_CONTENT_MISMATCH sign_button=absent record=409`

Then `SIGNING_PATH_OK`. On a product defect it prints `DEFECT <id>` and ends with `SIGNING_PATH_BLOCKED`. All writes go to the loopback service.

**What would prove this spec wrong:**
- The viewer and MCP content MACs differ for the same version, which would mean the content-byte definition is wrong.
- A real authenticator's `clientDataJSON` challenge differs from `attestationChallenge`.
- GCS refuses a later `customTime` PATCH on some private object, or does accept an earlier one (correction 6 then changes).
- Resend refuses JSON attachments.
- Jason refuses the reversals in section 12, or the requirement that public signing needs an owner identity (a PRF passkey, plus device enrollment for the MCP).

## 12. Contradictions with documented invariants

Each needs its own entry in `docs/decisions.md` (S9).

1. **frame.md:147**: passkeys "grant no authority over public relics to delete, un-publish, or administer them." The owner identity now administers a public relik's settings and signing.
2. **frame.md:147** ("The per-relic grant on a private relic is the one permission this product now has.") and **frame.md:159** ("Per-relic permissions exist only on private relics, through their grants."). Designating a signer and owning a public relik are now per-relik permissions on public reliks too. This is still not a team feature: there are no groups and no org accounts.
3. **frame.md:160**: "A publisher may set a lifetime at publish time". Lifetime can now change live.
4. **frame.md:158** (republish to the same URL) together with format.md:258. A signed public relik can no longer be republished.
5. **mail.ts:460-461** ("Private relics send these four messages and no others.") and **service.md:801**. Private reliks now send eight messages, all generic.
6. **service.md:848** (the access log's event list) and **frame.md:161**. The list adds `settings`, and every private open now creates served and opened receipts the owner can see. The reader disclosure must say so.
7. **publish.md 1.6**, the tool count, and **service.md 10.1/10.2**, which take the new routes.

**Residuals, stated as they are:**
- Public signers' passkeys are trusted on first use. A malicious service could register its own key under an address and produce a certificate that verifies internally. Private signatures add the identity key, pinned by fingerprint.
- Statement times come from the signer's clock, checked to within ±300 s. `recorded_at`, `completed_at` and `served_at` are the service's unsigned records.
- Turning suggestions off is enforced by the viewer only.
- On a public relik, any key holder can read signer addresses and statuses.
- A certificate copy that includes `signing_key` lets whoever holds it confirm the file and read the marks.
- Deleting a whole relik removes its signing records, so the certificate becomes the only record.
- Shortening a private lifetime does not move erasure earlier.
- Opening a relik with an identity now writes receipts, and the owner sees them.