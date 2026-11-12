# Relic private shares: build plan

Authorised by Jason Waldrip on 2026-11-11: build private shares (passkey-wrapped keys) per the draft, with his settled decisions: refuse private mode without WebAuthn PRF; the publisher types the fingerprint the requester reads aloud; the regulated profile is the default for every private relic; P-256 ECDH; wrap the content key, never re-encrypt for a grant; a fresh content key per version for private relics; revocation is a republish under a fresh key. This plan corrects the draft where the repo or a measurement contradicts it, and does not shrink it.

## 1. Goal

When this ships, all of these are observably true:

1. An owner publishes a private relic from relic-mcp with no passkey tap. The returned link is `https://relik.link/{id}` with no fragment, and no tool output, error, state echo or log line carries a content key or key phrase.
2. The owner opens that link in a browser, taps their passkey once, and reads it.
3. A second person signs in, sets up a private-share key (which needs a passkey whose provider supports WebAuthn PRF), requests access, and sees a 32-character fingerprint. The owner types that fingerprint into the request page; a wrong fingerprint blocks the grant in the browser and at the API. After the grant, the requester opens and reads it, and comments on it.
4. Revoking that person stops the service serving them at once, deletes their wrapped keys, and republishes the current content as a new version under a fresh key that only the remaining readers (owner, devices, other grantees, recovery recipient) can open.
5. A person whose passkey cannot produce PRF output is refused private mode with a clear message, and nothing is registered for them.
6. Private relics carry no title or cover, always expire, send only generic notification emails, and keep an access log of requests, grants, revocations, key fetches and deletions for the owner's chosen retention.
7. The owner can hard-delete chosen versions or the whole relic.
8. Public relics, their URLs and fragments behave exactly as before.

## 2. Corrections to the draft (evidence first)

Each item says what the draft claims, what is actually true, and what this plan does instead.

1. **There is no version marker to refuse.** The draft says private relics get a new version marker that old viewers refuse (format 3.7). A private URL has no fragment, so no marker is read. An old viewer with no fragment calls `keyVault.recall` and lands on the `fragment_missing` dead page (`viewer.ts:420-438`), which neither mints nor fetches. The container is unchanged (RFC 8188 plus envelope version byte 1, `envelope.ts:139-160`), so bumping it buys nothing. **Instead:** no fragment marker and no envelope version change. The access mode is declared by the server (`data-relic-access="private"` on the shell root, `access` on `/api/relics/{id}/access`), key delivery is versioned by its own labels (`relic/wrap/v1`, `relic-statement/v1`, bundle `v: 1`), and the server refuses ungated mints for private relics, so even a client holding a key cannot fetch without access.

2. **Existing passkeys cannot be assumed to produce PRF output.** No creation options in the repo request the `prf` extension (`postPasskeyOptions`, `app.ts:4157-4378`), and the viewer's option builders drop unknown fields (`passkey-common.ts:71-132`). Measured in Chrome 157 and HeadlessChrome 149 (`chromium_headless_shell-1228`) with a CDP virtual authenticator (`hasPrf: true`): a credential created without `prf` returns no PRF result at assertion; one created with `prf` returns a deterministic 32-byte result that differs by salt. **Instead:** every new passkey requests `prf` at creation; identity setup first tries PRF on existing credentials; if none answers, it offers an in-place replacement passkey (same user handle, empty exclude list, `prf` requested); if that still yields no PRF, private mode is refused. Real-provider behavior is the top open risk (section 8).

3. **The operative PRF test is a result at assertion.** The draft refuses unless creation returns `prf.enabled` *and* an assertion returns a result. `enabled` is absent for credentials created before this change and is advisory. **Instead:** the requirement is a PRF result from an assertion with `userVerification: 'required'`. A creation-time `enabled: false` is an early refusal only.

4. **Deterministic `DeriveKeyPair(ikm = prf)` is not portable WebCrypto.** Deriving a P-256 public key from a scalar needs a point multiplication WebCrypto does not expose. Measured: JWK import with only `d` is refused in Chrome 149 and 157 ("The required JWK member x was missing"); PKCS#8 without the public key imports in Chrome but is unmeasured in WebKit and Gecko. **Instead:** an identity is a pair of random P-256 keypairs (ECDH for HPKE, ECDSA for statements) generated with `generateKey`, encrypted under a key-encryption key derived from the PRF output, one encrypted copy per bound passkey. This needs only JWK import with `d`, `x`, `y`, which Bun 1.4.4, Node 18.20.8, Node 24.15.0 and Chrome all pass (measured). It also gives one identity, and one fingerprint, per address across all of a person's passkeys, so the draft's "grant to your own other keys" step disappears.

5. **The publishing client must authenticate the recipient list.** The draft never says how relic-mcp learns whom to wrap to. If it trusts the service's list, a compromised service adds its own key to every republish, defeating threat rows 3 and 6. **Instead:** an identity also has an ECDSA signing key. Grants, device certificates and the recovery designation are signed by the owner's identity key, and relic-mcp verifies every recipient against the owner identity it pinned at device enrollment.

6. **Device enrollment needs a typed comparison in both directions.** Without one, the service can have the owner certify the service's device key, or tell relic-mcp a false owner. **Instead:** the owner types relic-mcp's device fingerprint into the approval page before tapping, and types the owner fingerprint shown after approval into `relic_confirm_device`. Both are the full 160-bit fingerprint; a truncated code is open to a second-preimage search by a service that chooses its own keys.

7. **Devices are recipients.** The draft's threat table already assumes it ("where the device held wraps"). relic-mcp needs version keys for versions it did not create (a browser rekey) and for comments. **Instead:** a device has an ECDH key too, certified with its signing key, and every sealed version is wrapped to the owner's active devices.

8. **Grant ordering.** The draft taps first, then types the fingerprint. The assertion has to commit to the grant record, so the tap comes last. **Instead:** type fingerprint, pick versions, then one tap that both unlocks the owner identity (PRF) and attests the grant.

9. **Challenge construction.** `SHA-256(derivedPublicKey || email || serverNonce)` has no domain separation or length framing, and the repo issues random single-use server challenges (decision options, `app.ts:3754-3814`). Decision assertions today do not bind the decision tuple into signed bytes. **Instead:** the server issues a 32-byte nonce row; the challenge is `attestationChallenge(nonce, statements)` over canonical, domain-separated statements (section 4.3), so a stored grant is verifiable offline from its own bytes.

10. **Comments assume one key per relic.** The thread is fetched once and every row decrypted with the fragment key (`comments.ts:663-707`, `main.ts:7864-7893`), and `GET /api/relics/{id}/comments` is unauthenticated and returns author addresses in the clear (`app.ts:509-516`, `2684`). **Instead:** private comments are decrypted per version with that version's comment key; private comment reads require access and are filtered to versions the caller can read; private comment writes must name a version the caller can read.

11. **Every reader route authorizes by key possession.** Mint is unauthenticated (`app.ts:1388-1650`); share and decisions use `share_proof` derived from the fragment key (`app.ts:2046-2065`). **Instead:** for private relics, reads and writes are authorized by the session's identity holding a wrap for that version, or by the publish token for relic-mcp.

12. **Revocation and who performs it.** The draft lets a revoked reader keep fetching earlier versions and does the republish wherever. Revoking must work from any device with the owner's passkey, and browsers never hold the publish token. **Instead:** one owner ceremony in the browser records a signed revocation, the service immediately stops serving that identity and deletes its wraps for every version, and the browser republishes the current content under a fresh key (decrypt, encrypt, upload, seal), authorized by the owner's identity rather than the publish token. The warning before it says they keep whatever they already opened. Serving-stops-immediately is a change from the draft and is in the batched ask (section 10).

13. **The regulated title opt-out contradicts the draft.** Section 9's "unless the account explicitly opts out" contradicts section 1's "no separate regulated switch" and Jason's "forced empty title", and Relic has no accounts to hold a setting. **Instead:** no opt-out; a non-empty title on a private relic is refused.

14. **"Default TTL shorter than public relics" has no referent.** Public relics have no default lifetime (`frame.md:156`, `app.ts:760-776`). **Instead:** explicit config values, recommended default 30 days and maximum 365, confirmed in the batched ask.

15. **"Retention configurable per account" has no account and no scheduler.** Expiry today is read-time only and expired bytes persist (bucket tf `resource.google_storage_bucket.relics.tf:11-17`). **Instead:** retention is a per-identity setting; each access-log object is written with a GCS `customTime` and a lifecycle rule deletes it (section 4.11). No scheduler is added.

16. **Hard delete differs from operator delete.** Operator delete leaves `m/relic/{id}.json` in place and writes a tombstone carrying the publish IP and ciphertext hash (`app.ts:2484-2611`). **Instead:** owner hard delete removes the row and every private document and writes an id-only tombstone (`kind: 'owner'`). The access log survives deletion for its retention.

17. **The recovery key needs a holder and a tool.** Nothing in the repo manages an offline key. **Instead:** the recovery recipient is an ordinary Relic identity (the compliance owner's passkey, for example a hardware security key kept in a safe), designated by the owner typing its fingerprint. It is visible to every reader. Existing versions are backfilled from the owner's browser.

18. **Keychain is not better than the 0600 file; the Secure Enclave is.** `/usr/bin/security add-generic-password` takes the secret on argv (`-w`, `-X`) or prompts on a TTY (`man security`), and items it creates trust `/usr/bin/security`, so any same-user process can read them back. Measured on this Mac: an ad-hoc signed, entitlement-free binary creates CryptoKit Secure Enclave P-256 signing and key-agreement keys, persists them as 284-byte blobs, and a separately built binary (different CDHash) in a later process signs (64-byte raw signature) and agrees (ECDH matches). **Instead:** Secure Enclave where `SecureEnclave.isAvailable`, else a 0600 file. Keychain is not used.

19. **PRF output must never reach the server.** Measured: Chrome 157's `PublicKeyCredential.toJSON()` includes `clientExtensionResults.prf.results.first`; HeadlessChrome 149 omits it. The repo's serializers omit extension results (`passkey-common.ts:162-209`) and nothing calls `toJSON` on a credential (grep). **Instead:** that becomes a tested invariant.

20. **Where PRF and decryption may run.** Content renders in `sandbox="allow-scripts"` frames on the usercontent origin (`main.ts:1320-1340`), an opaque origin where WebAuthn cannot run, and decryption happens in the parent. But `assertConfig` only checks that the hosts differ (`config.ts:301-308`), although the field comment demands a distinct registrable domain (`config.ts:15-19`). A usercontent origin on a subdomain of the RP ID could request PRF output for the user's passkeys, which is now a decryption capability. **Instead:** `assertConfig` refuses a usercontent hostname equal to the RP ID or ending in `.` plus the RP ID. Any per-relic subdomain topology (viewer.md 2, unbuilt) must live under the usercontent domain.

21. **Today's notification mails name titles and commenters** (`mail.ts:108-338`). **Instead:** private relics use generic templates; the request mail names neither the relic nor the requester.

22. **Two threats are missing from the draft's table.** A service-injected recipient (blocked: relic-mcp wraps only to owner-signed grants, certified devices and the signed recovery designation). Forged content served under a private relic id (blocked after first open: the viewer verifies the seal and pins the owner identity per relic; at first open the reader trusts the service's report of the owner unless they compare the owner fingerprint out of band). The draft's HIPAA integrity row is amended to say this.

23. **No path for an address that loses every passkey.** **Instead:** an identity may be replaced under the same freshness rule as a first passkey (session started by a link or code inside `passkeyFreshLinkSeconds`), the address is emailed, and grants to the old identity stop working until owners grant again. Losing every passkey forfeits owner actions on that identity's private relics; the recovery recipient can still read them.

24. **relic-mcp leaks keys in output today.** Publish and republish return `key_phrase` (`publish.ts:621`, `republish.ts:559`), and a failed state write returns the key-bearing URL in `structuredContent` (`publish.ts:561-567`). **Instead:** private paths never emit key material, and tests scan every tool output for every key in state.

25. **Browser upload needs CORS.** The rekey upload runs from the browser; the bucket allows only GET and HEAD from the service origin (bucket tf `:56-61`). **Instead:** add `PUT`.

## 3. Decisions taken here

1. **Crypto and wire definitions live in `@relic/format/private`**, a subpath export not re-exported from the package index, so the viewer loads it only in lazy chunks. Rejected: exporting from the index, which risks the eager shell.
2. **One identity per normalized address**, with per-passkey encrypted copies. Rejected: one identity per passkey (several fingerprints per person, self-grants).
3. **Every owner action stores its full WebAuthn assertion plus an identity signature** (`StoredAttestation`), not only grants. Uniform audit, one verifier.
4. **The viewer verifies every private version before rendering**: wrap opens, seal signature chains to the owner identity, recipient list contains the reader, ciphertext SHA-256 equals the sealed digest, and the owner identity matches the one pinned for this relic in `localStorage['relic:private-owner:<id>']` at first open. A mismatch is a hard refusal with no "accept new owner" button, because a relic's owner never changes.
5. **Readers always open an explicit sealed version**, the highest one they can read, so an allocated-but-unsealed version never blocks them.
6. **Recipient completeness is enforced at seal time** with a per-relic `accessEpoch` and a per-owner `recipientsEpoch` (section 4.12).
7. **Access log retention uses GCS `customTime`** with a lifecycle rule, per object. Rejected: lazy pruning (no real deletion) and a new scheduler (new infra).
8. **Device keys:** Secure Enclave via a CryptoKit helper executable shipped as a darwin prebuild, else a 0600 file. Rejected: Keychain (correction 18).
9. **Browser rekey** uploads directly to the signed URL. Rejected: deferring the rekey to relic-mcp, which may not be at hand.
10. **No new reserved route segment.** Device approval is `/dashboard?approve-device=<enrollmentId>`; request review is `/{id}?access=requests`.

## 4. Shared contracts (verbatim)

### 4.1 Crypto parameters

| Use | Primitive | Parameters |
|---|---|---|
| Content | RFC 8188 `aes128gcm`, unchanged | 16-byte key: per relic (public), per version (private) |
| Comment key | HKDF-SHA256, unchanged | ikm = that version's key, salt empty, info `relic/comments/v1`, 16 bytes |
| Wrap | HPKE RFC 9180 base mode | KEM 0x0010 DHKEM(P-256, HKDF-SHA256), KDF 0x0001 HKDF-SHA256, AEAD 0x0001 AES-128-GCM; info = UTF8(`relic/wrap/v1`) ‖ 0x00 ‖ UTF8(relicId, 26 bytes) ‖ u32be(version); aad = recipient kemKeyId (32 raw bytes); pt = 16-byte version key; `enc` 65 bytes; `ct` 32 bytes |
| PRF salt | WebAuthn PRF `eval.first` | UTF8(`relic/identity-prf/v1`) (the browser hashes it with the `WebAuthn PRF` prefix) |
| Identity KEK | HKDF-SHA256 | ikm = PRF output (32 bytes), salt = raw credential id bytes, info = UTF8(`relic/identity-kek/v1`), 32 bytes, used as an AES-256-GCM key |
| Identity bundle | AES-256-GCM | 12-byte random nonce; aad = UTF8(`relic/identity-bundle/v1`) ‖ 0x00 ‖ identityId (32 raw bytes) ‖ raw credential id; pt = UTF8(canonicalJson(`{"kem":{"d","x","y"},"sig":{"d","x","y"},"v":1}`)); stored as base64url(nonce ‖ ciphertext) |
| Statement signature | ECDSA P-256, SHA-256 | IEEE P1363 `r ‖ s`, 64 bytes, base64url; over `statementBytes` (4.3) |
| Attestation challenge | SHA-256 | UTF8(`relic-attest/v1`) ‖ 0x00 ‖ nonce (32 bytes) ‖ SHA-256(statementBytes₁) ‖ … ‖ SHA-256(statementBytesₙ), n ≥ 1, in request order; base64url is the WebAuthn challenge |

HPKE implementation notes, normative:
- `LabeledExtract(salt, label, ikm) = HMAC-SHA256(salt, "HPKE-v1" ‖ suite_id ‖ label ‖ ikm)`. WebCrypto refuses a zero-length HMAC key, so an empty salt is passed as 32 zero bytes (identical result: HMAC zero-pads short keys).
- `LabeledExpand(prk, label, info, L) = first L bytes of HMAC-SHA256(prk, I2OSP(L,2) ‖ "HPKE-v1" ‖ suite_id ‖ label ‖ info ‖ 0x01)` for L ≤ 32.
- KEM `suite_id = "KEM" ‖ 0x0010`; HPKE `suite_id = "HPKE" ‖ 0x0010 ‖ 0x0001 ‖ 0x0001`.
- `DH` is WebCrypto ECDH `deriveBits(256)` (the x-coordinate). `enc` and public keys are SEC1 uncompressed (`exportKey('raw')`, 65 bytes, prefix 0x04). Importing a peer key with `importKey('raw')` validates the point.
- Only single-shot `Seal`/`Open` at sequence 0 is needed. `Export` is not implemented.
- Open takes the recipient as `{ publicKey: Uint8Array; dh(peer: Uint8Array): Promise<Uint8Array> }` so a WebCrypto key or a Secure Enclave helper can supply DH.

Test vectors: RFC 9180 Appendix A.3.1 (DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base mode) and A.3.1.1 sequence 0. The test imports `skEm` with `pkEm` as a fixed ephemeral through a test seam and must reproduce `enc`, `shared_secret`, `key`, `base_nonce`, `exporter_secret` (via the key schedule internals) and the sequence-0 `ct`, then `Open` with `skRm`. Repo-specific values (4.2, 4.3) are frozen as known-answer fixtures in S1.

### 4.2 Identifiers and fingerprints

- `kemKeyId = SHA-256(kemPub65)`, 32 bytes; `recipient_key_id` on the wire is lowercase hex.
- `identityId = hex(SHA-256(UTF8("relic/identity/v1") ‖ 0x00 ‖ kemPub65 ‖ sigPub65))`.
- `deviceId = hex(SHA-256(UTF8("relic/device/v1") ‖ 0x00 ‖ kemPub65 ‖ sigPub65))`.
- `normalizeEmail` moves verbatim from `relic-server/src/store.ts:18-20` to `relic-format/src/email.ts` (trim, ASCII A-Z lowercased only).
- Identity fingerprint: first 20 bytes of `SHA-256(UTF8("relic/fp/v1") ‖ 0x00 ‖ identityId (32 raw bytes) ‖ UTF8(normalizeEmail(email)))`.
- Device fingerprint: first 20 bytes of `SHA-256(UTF8("relic/device-fp/v1") ‖ 0x00 ‖ deviceId (32 raw bytes))`.
- Encoding: Crockford base32 with the relic id alphabet `0123456789abcdefghjkmnpqrstvwxyz`, most significant bit first, 160 bits = exactly 32 characters, stored and compared lowercase.
- Display: uppercase, 8 groups of 4 separated by single spaces, for example `7K2M 9QXA H3TB 0P4D VW8C R1NE ZF6G Y5SJ`.
- Typed input: remove all whitespace and `-`, lowercase, fold `i` and `l` to `1` and `o` to `0`, require 32 alphabet characters, compare to the locally computed value in constant time.
- Every fingerprint shown in a browser or relic-mcp is computed locally from public keys. No API returns a fingerprint field.

### 4.3 Canonical statements

`canonicalJson(value)`: values are strings, booleans, null, safe integers (`Number.isSafeInteger`; `-0` written `0`), arrays and plain objects; object keys sorted by default JS string order; no whitespace; strings and numbers serialized with `JSON.stringify`. Anything else throws.

`statementBytes(kind, statement) = UTF8("relic-statement/v1\n" + kind + "\n" + canonicalJson(statement))`.

Every statement has every listed field (null where allowed). `at` is epoch milliseconds. Hex is lowercase 64 characters. Public keys are base64url of 65 bytes. Labels are 1 to 64 UTF-8 bytes without control characters.

| Kind | Fields | Signed by | WebAuthn |
|---|---|---|---|
| `identity_register` | `at, email, identity_id, kem_public_key, replaces (hex or null), sig_public_key` | identity | yes |
| `identity_bind` | `at, credential_id, identity_id` | identity | yes (the new credential) |
| `identity_settings` | `access_log_retention_days, at, identity_id` | identity | yes |
| `access_request` | `at, relic_id, requester_identity_id` | identity (requester) | yes |
| `grant` | `at, fingerprint_typed, grantee_email, grantee_identity_id, owner_identity_id, relic_id, versions (ascending unique ints)` | identity (owner) | yes |
| `revocation` | `at, grantee_identity_id, owner_identity_id, relic_id` | identity (owner) | yes, shared with `republish` |
| `republish` | `at, owner_identity_id, previous_version, reason ("rekey"), relic_id` | identity (owner) | yes, shared with `revocation` |
| `delete` | `at, owner_identity_id, relic_id, versions ("all" or ascending unique ints)` | identity (owner) | yes |
| `device_cert` | `at, device_fingerprint_typed, device_id, kem_public_key, label, not_after, owner_identity_id, sig_public_key` | identity (owner) | yes |
| `device_revocation` | `at, device_id, owner_identity_id` | identity (owner) | yes |
| `recovery_designation` | `at, fingerprint_typed (or null), owner_identity_id, recovery_email (or null), recovery_identity_id (or null)` | identity (owner) | yes; all three null removes the designation |
| `seal` | `access_epoch, at, ciphertext_sha256, owner_epoch, recipient_key_ids (sorted hex), relic_id, signer_id, version` | device (relic-mcp) or identity (browser rekey) | no |
| `device_enroll` | `at, device_id, label` | device | no |
| `device_request` | `at, body_sha256, device_id, method, nonce, path` | device | no |
| `owner_bind` | `at, device_id, nonce, owner_identity_id, relic_id` | device | no |
| `private_publish` | `at, challenge_nonce, device_id, relic_id, ttl_days (or null)` | device | no |

The server refuses any statement whose `at` is more than `passkeyChallengeTtlSeconds` (300) from its clock. `device_request.body_sha256` is `hex(SHA-256(UTF8(canonicalJson(body without device_auth))))`; `path` is the URL pathname; `method` is uppercase.

### 4.4 Identity bundle and ceremonies

- Generate: ECDH P-256 and ECDSA P-256 keypairs, extractable, via `generateKey`. Export private JWK (`d`, `x`, `y`) into the bundle; export public keys raw.
- Register (one tap): `POST /api/attest/nonce {purpose:'identity_register'}` → build `identity_register` → challenge → `navigator.credentials.get({ challenge, rpId, allowCredentials, userVerification:'required', extensions:{ prf:{ eval:{ first: SALT } } } })` → no `prf.results.first`: raise `PrfUnavailableError`, send nothing → else KEK from PRF and the asserting credential's raw id → encrypt bundle → sign statement → `POST /api/identity`.
- Bind another passkey (two taps): unlock with a bound credential (local random challenge) → `POST /api/attest/nonce {purpose:'identity_bind', credential_id}` → assertion with the new credential and PRF → encrypt bundle under the new KEK → `POST /api/identity/credentials`.
- Unlock (one tap, no server verification): local random 32-byte challenge, `allowCredentials` = bound credentials, PRF eval → decrypt that credential's bundle → import JWKs non-extractable → verify the imported public keys hash to the expected `identityId`.
- Replacement offer: when an existing credential gives no PRF, `POST /api/auth/passkeys/options` with the existing assertion and `for_private_shares: true` returns create options with `excludeCredentials: []`, the record's user handle and `extensions: { prf: {} }`. On success the identity ceremony retries once; a second miss is a hard refusal.
- Serializers (`passkey-common.ts`) never include `clientExtensionResults`; nothing calls `PublicKeyCredential.prototype.toJSON`.

### 4.5 `@relic/format/private` exports

```ts
// packages/relic-format/src/private.ts (re-exports hpke.ts types it needs)
export const PRF_SALT: Uint8Array; // UTF8('relic/identity-prf/v1')
export type StatementKind = 'identity_register' | 'identity_bind' | 'identity_settings' | 'access_request' | 'grant' | 'revocation' | 'republish' | 'delete' | 'device_cert' | 'device_revocation' | 'recovery_designation' | 'seal' | 'device_enroll' | 'device_request' | 'owner_bind' | 'private_publish';
export interface StatementMap { /* one interface per kind, fields exactly as 4.3, snake_case */ }
export function canonicalJson(value: unknown): string;
export function statementBytes<K extends StatementKind>(kind: K, statement: StatementMap[K]): Uint8Array;
export function parseStatement<K extends StatementKind>(kind: K, value: unknown): StatementMap[K]; // strict: exact key set, types, formats; throws InvalidStatementError(check)
export function attestationChallenge(nonce: Uint8Array, statements: readonly Uint8Array[]): Promise<Uint8Array>;
export function signStatement(sign: (bytes: Uint8Array) => Promise<Uint8Array>, bytes: Uint8Array): Promise<string>;
export function verifyStatement(sigPublicKey: Uint8Array, bytes: Uint8Array, signatureB64: string): Promise<boolean>;
export function identityIdOf(kemPub: Uint8Array, sigPub: Uint8Array): Promise<string>;
export function deviceIdOf(kemPub: Uint8Array, sigPub: Uint8Array): Promise<string>;
export function kemKeyIdOf(kemPub: Uint8Array): Promise<Uint8Array>;
export function identityFingerprint(identityId: string, email: string): Promise<string>; // 32 lowercase
export function deviceFingerprint(deviceId: string): Promise<string>;
export function formatFingerprint(fp: string): string; // display
export function parseTypedFingerprint(typed: string): string | undefined; // normalized or undefined
export function fingerprintsEqual(a: string, b: string): boolean; // constant time
export interface HpkeRecipient { readonly publicKey: Uint8Array; dh(peer: Uint8Array): Promise<Uint8Array> }
export function wrapVersionKey(p: { recipientPublicKey: Uint8Array; relicId: string; version: number; key: Uint8Array }): Promise<{ recipientKeyId: string; enc: string; ct: string }>;
export function unwrapVersionKey(p: { recipient: HpkeRecipient; relicId: string; version: number; enc: string; ct: string }): Promise<Uint8Array>; // 16 bytes or throws WrapOpenError
export interface IdentityKeys { readonly kem: CryptoKeyPair; readonly sig: CryptoKeyPair; readonly kemPublicKey: Uint8Array; readonly sigPublicKey: Uint8Array; readonly identityId: string }
export function generateIdentityKeys(): Promise<IdentityKeys>; // also used for device file keys
export function deriveKek(prf: Uint8Array, rawCredentialId: Uint8Array): Promise<CryptoKey>;
export function encryptIdentityBundle(kek: CryptoKey, keys: IdentityKeys, rawCredentialId: Uint8Array): Promise<string>;
export function decryptIdentityBundle(kek: CryptoKey, bundle: string, identityId: string, rawCredentialId: Uint8Array): Promise<IdentityKeys>; // verifies hash of public keys == identityId
export function encodeBase64url(bytes: Uint8Array): string;
export function decodeBase64url(text: string): Uint8Array; // throws on non-alphabet
export * from './private-wire.ts'; // section 4.6 types
```

```ts
// packages/relic-format/src/hpke.ts
export function hpkeSeal(p: { recipientPublicKey: Uint8Array; info: Uint8Array; aad: Uint8Array; plaintext: Uint8Array; ephemeral?: CryptoKeyPair /* test seam */ }): Promise<{ enc: Uint8Array; ct: Uint8Array }>;
export function hpkeOpen(p: { recipient: HpkeRecipient; enc: Uint8Array; info: Uint8Array; aad: Uint8Array; ct: Uint8Array }): Promise<Uint8Array>;
export function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): Promise<{ key: Uint8Array; baseNonce: Uint8Array; exporterSecret: Uint8Array }>; // exported for the vector test
```

`package.json` exports gain `"./private": "./src/private.ts"`. `index.ts` gains `export * from './email.ts'` and nothing from private.

### 4.6 Wire types (`private-wire.ts`, snake_case JSON)

```ts
export type AttestPurpose = 'identity_register' | 'identity_bind' | 'identity_settings' | 'access_request' | 'grant' | 'revoke' | 'delete' | 'device_approve' | 'device_revoke' | 'recovery_designate';
export interface SignedStatementJSON { readonly kind: StatementKind; readonly statement: Record<string, unknown>; readonly identity_signature: string }
export interface AttestationBundleJSON { readonly nonce: string; readonly statements: readonly SignedStatementJSON[]; readonly credential: AuthenticationResponseJSON }
export interface DeviceAuthJSON { readonly device_id: string; readonly nonce: string; readonly at: number; readonly signature: string }
export interface IdentityPublicJSON { readonly identity_id: string; readonly email: string; readonly kem_public_key: string; readonly sig_public_key: string; readonly created_at: string; readonly retired_at: string | null }
export interface PartyJSON { readonly email: string; readonly identity: IdentityPublicJSON }
export interface IdentityStateJSON {
  readonly identity: (IdentityPublicJSON & {
    readonly credentials: readonly { readonly credential_id: string; readonly encrypted_bundle: string; readonly bound_at: string }[];
    readonly recovery: RecoveryJSON | null;
    readonly access_log_retention_days: number;
    readonly recipients_epoch: number;
  }) | null;
  readonly passkeys: readonly { readonly credential_id: string; readonly bound: boolean }[];
}
export interface RecoveryJSON extends PartyJSON { readonly designated_at: string; readonly designation: { readonly statement: Record<string, unknown>; readonly identity_signature: string } }
export interface DevicePublicJSON { readonly device_id: string; readonly owner_identity_id: string; readonly kem_public_key: string; readonly sig_public_key: string; readonly label: string; readonly backend: 'secure-enclave' | 'file'; readonly not_after: number; readonly certified_at: string; readonly revoked_at: string | null; readonly cert: { readonly statement: Record<string, unknown>; readonly identity_signature: string } }
export interface WrapJSON { readonly recipient_key_id: string; readonly version: number; readonly enc: string; readonly ct: string }
export interface BackfillWrapJSON extends WrapJSON { readonly relic_id: string }
export interface SealJSON { readonly statement: Record<string, unknown>; readonly signature: string; readonly signer_kind: 'device' | 'identity' }
export interface GrantJSON { readonly statement: Record<string, unknown>; readonly identity_signature: string; readonly granted_at: string; readonly revoked_at: string | null; readonly grantee: PartyJSON }
export interface KeyJSON { readonly relic_id: string; readonly version: number; readonly wrap: WrapJSON; readonly seal: SealJSON; readonly signer: { readonly kind: 'identity' } | { readonly kind: 'device'; readonly device: DevicePublicJSON }; readonly owner: PartyJSON }
export type AccessRole = 'owner' | 'grantee' | 'recovery' | 'revoked' | 'requested' | 'declined' | 'none';
export interface PrivateAccessJSON { readonly access: 'private'; readonly relic_id: string; readonly current_version: number; readonly sealed_version: number | null; readonly expires_at: string; readonly owner: PartyJSON | null /* null for none, requested, declined */; readonly recovery: PartyJSON | null; readonly me: { readonly role: AccessRole; readonly identity: IdentityPublicJSON | null; readonly readable_versions: readonly number[]; readonly deleted_versions: readonly number[] } }
export interface PublicAccessJSON { readonly access: 'public'; readonly relic_id: string; readonly owned_by_me: boolean }
export interface AccessEventJSON { readonly event_id: string; readonly at: string; readonly kind: 'request' | 'grant' | 'revoke' | 'wrap_fetch' | 'delete'; readonly relic_id: string; readonly version: number | null; readonly actor: { readonly email: string | null; readonly identity_id: string | null; readonly device_id: string | null }; readonly subject_identity_id: string | null }
```

`CreationOptionsJSON` and `RequestOptionsJSON` in `passkey.ts` gain `readonly extensions?: { readonly prf?: { readonly eval?: { readonly first: string } } }`, and `passkey-common.ts` passes it through (base64url-decoding `first`).

### 4.7 HTTP routes

Every new POST that relies on the session cookie requires `content-type: application/json` (400 with the route's malformed code otherwise), like passkey sign-in. "Owner session" means a session whose current identity is the relic's `ownerIdentityId`.

New routes:

| Method and path | Auth | Body | Success | Refusals |
|---|---|---|---|---|
| `POST /api/attest/nonce` | session | `{purpose, relic_id?, credential_id?}` | 200 `{nonce, expires_at, public_key:{rpId, timeout, userVerification:'required', allowCredentials}}` | 401 `sign_in_required`, 409 `passkey_required`, 409 `identity_required`, 403 `owner_required`, 400 `invalid_statement`, 429 `private_rate_limited` |
| `GET /api/identity` | session | | 200 `IdentityStateJSON` | 401 |
| `POST /api/identity` | session | `{attestation, encrypted_bundle, replace?: boolean}` | 201 `{identity: IdentityPublicJSON}` | 401, 401 `passkey_fresh_link_required` (replace), 409 `identity_exists`, 400 `invalid_identity`, 400 `invalid_statement`, 400 `invalid_passkey`, 403 `passkey_verification_failed`, 429 |
| `POST /api/identity/credentials` | session | `{attestation, encrypted_bundle}` | 201 `{credential_id}` | as above plus 409 `identity_required` |
| `POST /api/identity/settings` | session | `{attestation}` | 200 `{access_log_retention_days}` | 400 `invalid_statement` (out of bounds) |
| `POST /api/identity/recovery/lookup` | session | `{email}` | 200 `{party: PartyJSON \| null}` | 429 |
| `POST /api/identity/recovery` | session | `{attestation}` | 200 `{recovery: RecoveryJSON \| null}` | 409 `fingerprint_mismatch`, 400 `invalid_statement` |
| `POST /api/identity/backfill` | session (owner identity) | `{wraps: BackfillWrapJSON[]}` (at most `privateBackfillMaxWraps`) | 200 `{stored, skipped}` | 400 `invalid_wrap` |
| `GET /api/identity/relics` | session | `?coverage=1` optional | 200 `{owned:[{relic_id, access, current_version, sealed_version, expires_at, pending_requests, coverage_gaps?: number[]}], shared_with_me:[{relic_id, readable_versions, expires_at, owner: PartyJSON}]}` (`coverage_gaps` is the list of unsealed-or-missing-recipient versions) | 401 |
| `GET /api/identity/access-log` | session | `?relic_id=` optional | 200 `{events: AccessEventJSON[]}` (oldest first) | 401, 409 `identity_required` |
| `POST /api/devices/enrollments` | none, IP limited | `{kem_public_key, sig_public_key, label, backend, proof:{statement, signature}}` (`device_enroll`) | 201 `{enrollment_id, approve_url, expires_at, device_id}` | 400 `invalid_device`, 429 |
| `GET /api/devices/enrollments/{enrollmentId}` | id is the capability | | 200 `{status:'pending'\|'approved', device_id, label, kem_public_key, sig_public_key, expires_at, device?: DevicePublicJSON, owner?: PartyJSON}` (the two keys are returned while pending, so the owner's approval page can show the device fingerprint) | 404 `device_not_found`, 410 `device_enrollment_expired` |
| `POST /api/relics/{id}/versions/{v}/upload-grant` | owner session | | 200 a new signed upload grant for version `v`, the current unsealed version only (`uploadFor`) | 409 `version_conflict` (not the current unsealed version), 403 `owner_required`, 401 `sign_in_required` |
| `POST /api/devices/enrollments/{enrollmentId}/approve` | session | `{attestation}` (`device_cert`) | 200 `{device}` | 409 `fingerprint_mismatch`, 409 `identity_required`, 410 |
| `GET /api/devices` | session | | 200 `{devices: DevicePublicJSON[]}` | 401 |
| `POST /api/devices/{deviceId}/revoke` | session | `{attestation}` | 200 `{device}` | 403 `owner_required`, 404 |
| `POST /api/devices/{deviceId}/context` | `device_auth` | `{device_auth}` | 200 `{device, owner: PartyJSON, devices: DevicePublicJSON[], recovery: RecoveryJSON \| null, recovery_statement: {statement, identity_signature} \| null, owner_epoch}` (`recovery_statement` is the owner's latest signed designation, a removal included, so a removal is a signed fact and not a null) | 403 `device_revoked`, 404, 400 `invalid_device` |
| `GET /api/relics/{id}/access` | session for private; none for public | | 200 `PrivateAccessJSON` or `PublicAccessJSON` | 401 (private), 404, 410 |
| `POST /api/relics/{id}/requests` | session | `{attestation}` (`access_request`) | 201 `{status:'pending', requested_at}`; 200 if already pending or granted | 409 `identity_required`, 409 `request_limit_reached`, 429 |
| `GET /api/relics/{id}/requests` | owner session | | 200 `{requests:[{requester: PartyJSON, requested_at, status, statement, identity_signature}]}` | 403 `owner_required` |
| `POST /api/relics/{id}/requests/{identityId}/decline` | owner session | `{}` | 200 | 403, 404 `request_not_found` |
| `POST /api/relics/{id}/grants` | owner session | `{attestation, wraps: WrapJSON[]}` | 201 `{grant: GrantJSON}` | 409 `fingerprint_mismatch`, 409 `grant_stale_version` (+`current_version`), 400 `invalid_wrap`, 403 |
| `GET /api/relics/{id}/grants` | owner session | | 200 `{grants: GrantJSON[]}` | 403 |
| `POST /api/relics/{id}/revocations` | owner session | `{attestation, renderer_class, declared_size_bytes, declared_ciphertext_bytes}` | 200 `{revoked_identity_id, republish:{version, upload_url, upload_method, upload_headers, upload_expires_at}, access_epoch, owner_epoch}` | 409 `version_conflict`, 404 grant, 403 |
| `POST /api/relics/{id}/recipients` | `{publish_token}` or owner session | | 200 `{access_epoch, owner_epoch, current_version, sealed_version, owner: PartyJSON, devices, grants: GrantWireJSON[] (revoked grants included, each with `revoked_at` and `revocation: {statement, identity_signature} \| null`), recovery, recovery_statement: {statement, identity_signature} \| null}` | 403 `invalid_publish_token` |
| `POST /api/relics/{id}/versions/{v}/key` | session, or `{publish_token, recipient_key_id}` | | 200 `KeyJSON` (logs `wrap_fetch`) | 401, 403 `private_access_denied`, 409 `relic_not_yet_published` (unsealed), 410 `relic_expired` / `relic_removed` / `version_deleted` |
| `POST /api/relics/{id}/delete` | owner session | `{attestation}` | 200 `{deleted_versions, relic_deleted}` | 409 `cannot_delete_current_version`, 403 |
| `POST /api/relics/{id}/owner` | `{publish_token, device_auth}` with an `owner_bind` statement | | 200 `{owner: PartyJSON}` | 409 `owner_exists`, 403 `invalid_publish_token`, 403 `device_revoked` |
| `POST /api/relics/{id}/comments/list` | `{publish_token}` | | 200, same body as `GET .../comments` | 403 |

Changed existing routes:
- `POST /api/challenge`: response adds `private_shares: {default_ttl_days, max_ttl_days}` (capability signal for relic-mcp).
- `POST /api/grant`: accepts `access: 'private'` with `device_auth` signing a `private_publish` statement whose `challenge_nonce` equals the body's; refuses `title`, `owner_email`, `share_verifier` (`private_policy_violation`); applies `privateDefaultTtlDays` when `ttl_days` is absent and refuses above `privateMaxTtlDays`; sets `ownerEmail` from the owner identity; writes the owned-relic index. Response adds `access: 'private', access_epoch: 0, owner_epoch`.
- `POST /api/relics/{id}/republish`: private relics require the publish token and refuse a non-empty title or a share verifier; response adds `access`, `access_epoch`, `owner_epoch`.
- `POST /api/relics/{id}/complete`: private relics require `{seal: SealJSON, wraps: WrapJSON[], publish_token?}` and seal per 4.12 (`private_seal_required`, `invalid_seal`, `seal_digest_mismatch`, `recipients_changed`, `version_conflict`).
- `POST /api/relics/{id}/mint`: private relics require a session whose identity holds a wrap for the version, or the publish token; the version must be sealed and not deleted.
- `POST /api/relics/{id}/cover`: private relics refuse (`private_policy_violation`, `cover`).
- `GET /api/relics/{id}/comments`: private relics require a session with access and return only comments on readable versions. `POST` requires `version` and a wrap for it (or the publish token). `PATCH`/`DELETE` add the same access check.
- Decisions (`options`, record, `list`): private relics replace `share_proof` with the access check; `list` also accepts the publish token.
- `POST /api/relics/{id}/share`: private relics accept the reader path with a session that has access, without `share_proof`.
- `GET /{id}`: private rows get `data-relic-access="private"` on the root (also when expired), the generic private card, no title, no cover, no renderer-class copy.
- `POST /api/auth/passkeys/options`: every creation response includes `extensions: {prf: {}}`; with an existing-credential assertion and `for_private_shares: true`, the create response has `excludeCredentials: []`.
- `DELETE /api/relics/{id}` (operator): also removes wraps, seals, grants, requests and index entries; reads the tombstone union.
- `GET /policy`: `disclosureStatement()` gains the paragraph in 4.14.

### 4.8 Problem codes (`problems.ts`)

| Code | Status | Title |
|---|---|---|
| `private_access_denied` | 403 | You do not have access to this relic |
| `private_policy_violation` | 400 | Private relics do not allow that |
| `identity_required` | 409 | Set up a private-share key first |
| `identity_exists` | 409 | This address already has a private-share key |
| `invalid_identity` | 400 | Invalid private-share key payload |
| `invalid_statement` | 400 | Invalid signed statement |
| `private_rate_limited` | 429 | Too many private-share requests |
| `owner_required` | 403 | Only the relic's owner can do that |
| `owner_exists` | 409 | This relic already has an owner |
| `fingerprint_mismatch` | 409 | The fingerprint does not match |
| `grant_stale_version` | 409 | A newer version exists |
| `recipients_changed` | 409 | Who can read this relic changed |
| `version_conflict` | 409 | The relic changed while this was in progress |
| `private_seal_required` | 409 | This version needs its seal |
| `invalid_seal` | 400 | Invalid seal |
| `seal_digest_mismatch` | 409 | The seal does not match the stored version |
| `invalid_wrap` | 400 | Invalid wrapped key |
| `device_not_found` | 404 | No such device |
| `device_revoked` | 403 | This device was revoked |
| `invalid_device` | 400 | Invalid device payload |
| `device_enrollment_expired` | 410 | Device enrollment expired |
| `version_deleted` | 410 | This version was deleted |
| `cannot_delete_current_version` | 409 | Delete the whole relic to remove its current version |
| `request_not_found` | 404 | No such access request |
| `request_limit_reached` | 409 | This relic has too many pending requests |
| `kem_key` (as `invalid_statement`, `statement_check: kem_key`) | 400 | KEM key already held by another identity or device; a request for a new identity with it is refused |
| `kem_key` (as `invalid_device`, `device_check: kem_key`) | 400 | KEM key already held by another identity or device |
| `replay` (as `invalid_device`, `device_check: replay`) | 400 | A device request or owner-bind nonce was already spent |
| `exists` (as `invalid_device`, `device_check: exists`) | 400 | A device with this id is already certified |

The rows marked `kem_key` and `replay` reuse `invalid_statement` and `invalid_device`. They are not new codes, and the `*_check` extension says which check failed. Request status is `pending`, `granted` or `declined`.

`ProblemExtensions` gains `policy_check` (`'title' | 'cover' | 'ttl' | 'owner_email' | 'share_verifier' | 'share_proof' | 'version'`), `identity_check`, `statement_check`, `seal_check`, `device_check`, `access_epoch`, `owner_epoch`.

### 4.9 Config (`config.ts`)

```ts
privateDefaultTtlDays: 30,           // confirm with Jason (section 10)
privateMaxTtlDays: 365,              // confirm with Jason
accessLogRetentionDefaultDays: 2190, // 6 years; confirm with Jason
accessLogRetentionMinDays: 30,
accessLogRetentionMaxDays: 3650,
deviceCertMaxDays: 365,
deviceEnrollmentTtlSeconds: 900,
privatePendingRequestsMax: 50,
privateBackfillMaxWraps: 2000,
privateRateLimit: { limit: 60, windowSeconds: 3600 },          // per IP
deviceEnrollmentRateLimit: { limit: 10, windowSeconds: 3600 }, // per IP
identityLookupRateLimit: { limit: 30, windowSeconds: 3600 },   // per session address
```

`assertConfig` adds: `privateDefaultTtlDays <= privateMaxTtlDays <= maxTtlDays`; `accessLogRetentionMinDays <= accessLogRetentionDefaultDays <= accessLogRetentionMaxDays`; and the usercontent hostname must not equal the service hostname (the RP ID) or end with `.` plus it.

### 4.10 Store interface (both `MemoryStore` and `gcsStore`)

Records (`store.ts`):

```ts
export interface StoredAttestation {
  readonly statements: readonly { readonly kind: StatementKind; readonly statement: Record<string, unknown>; readonly identitySignature: string }[];
  readonly nonce: string;
  readonly credential: AuthenticationResponseJSON;
  readonly credentialId: string;
  readonly credentialPublicKeyJwk: JsonWebKey;
  readonly credentialAlg: -7 | -257;
  readonly rpId: string;
  readonly origin: string;
  readonly verifiedAt: number;
}
export interface IdentityCredentialBinding { readonly credentialId: string; readonly encryptedBundle: string; readonly boundAt: number; readonly attestation: StoredAttestation }
export interface RecoveryDesignation { readonly recoveryIdentityId: string; readonly recoveryEmail: string; readonly designatedAt: number; readonly attestation: StoredAttestation }
export interface IdentityRecord {
  readonly identityId: string; readonly email: string; readonly address: string;
  readonly kemPublicKey: string; readonly sigPublicKey: string; readonly kemKeyId: string;
  readonly createdAt: number; readonly retiredAt?: number; readonly replacedBy?: string;
  readonly registration: StoredAttestation;
  readonly credentials: readonly IdentityCredentialBinding[];
  readonly recovery?: RecoveryDesignation;
  readonly accessLogRetentionDays: number;
  readonly recipientsEpoch: number;
}
export interface DeviceEnrollmentRow { readonly enrollmentId: string; readonly deviceId: string; readonly kemPublicKey: string; readonly sigPublicKey: string; readonly label: string; readonly backend: 'secure-enclave' | 'file'; readonly createdAt: number; readonly expiresAt: number; readonly status: 'pending' | 'approved' }
export interface DeviceRecord { readonly deviceId: string; readonly ownerIdentityId: string; readonly kemPublicKey: string; readonly sigPublicKey: string; readonly kemKeyId: string; readonly label: string; readonly backend: 'secure-enclave' | 'file'; readonly notAfter: number; readonly certifiedAt: number; readonly cert: StoredAttestation; readonly revokedAt?: number; readonly revocation?: StoredAttestation }
export interface WrapRow { readonly relicId: string; readonly version: number; readonly recipientKeyId: string; readonly enc: string; readonly ct: string; readonly createdAt: number; readonly source: 'seal' | 'grant' | 'backfill' }
export interface SealRow { readonly relicId: string; readonly version: number; readonly statement: Record<string, unknown>; readonly signature: string; readonly signerKind: 'device' | 'identity'; readonly signerId: string; readonly sealedAt: number }
export interface GrantRow { readonly relicId: string; readonly granteeIdentityId: string; readonly ownerIdentityId: string; readonly versions: readonly number[]; readonly grantedAt: number; readonly attestation: StoredAttestation; readonly revokedAt?: number; readonly revocation?: StoredAttestation }
export interface AccessRequestRow { readonly relicId: string; readonly requesterIdentityId: string; readonly requestedAt: number; readonly status: 'pending' | 'granted' | 'declined'; readonly decidedAt?: number; readonly attestation: StoredAttestation }
export interface OwnedRelicRow { readonly relicId: string; readonly ownerIdentityId: string; readonly access: 'public' | 'private'; readonly at: number }
export interface AccessEvent { readonly eventId: string; readonly ownerIdentityId: string; readonly relicId: string; readonly at: number; readonly kind: 'request' | 'grant' | 'revoke' | 'wrap_fetch' | 'delete'; readonly version?: number; readonly actorIdentityId?: string; readonly actorDeviceId?: string; readonly actorEmail?: string; readonly subjectIdentityId?: string; readonly retainUntil: number }
export type Tombstone = OperatorTombstone | OwnerTombstone; // OperatorTombstone is today's shape plus `kind?: 'operator'` (absent on stored rows)
export interface OwnerTombstone { readonly kind: 'owner'; readonly id: string; readonly deletedAt: number }
```

`RelicRow` gains `access?: 'private'`, `ownerIdentityId?: string`, `accessEpoch?: number`, `sealedVersion?: number`, `deletedVersions?: readonly number[]`. `WebauthnChallengeRow.purpose` gains `'attest'` with `attestPurpose?: AttestPurpose`, `relicId?`, `credentialId?`, `enrollmentId?`.

Methods added to `RelicStore`:

```ts
updateRelic(id: string, change: (row: RelicRow) => RelicRow): Promise<RelicRow | undefined>; // CAS; change may throw ProblemError to abort
deleteRelicRow(id: string): Promise<void>;
getIdentity(identityId: string): Promise<IdentityRecord | undefined>;
getIdentityForAddress(email: string): Promise<IdentityRecord | undefined>; // current, non-retired
createIdentity(record: IdentityRecord): Promise<'created' | 'address_taken' | 'kem_taken'>; // kem_taken: another identity or device holds the KEM key; a refused create claims nothing
replaceIdentity(record: IdentityRecord, retiringIdentityId: string, at: number): Promise<'replaced' | 'conflict' | 'kem_taken'>; // kem_taken: the KEM key is held by anything other than the retiring identity; its claim moves to record
updateIdentity(identityId: string, change: (r: IdentityRecord) => IdentityRecord): Promise<IdentityRecord | undefined>;
putDeviceEnrollment(row: DeviceEnrollmentRow): Promise<boolean>; // create-only
getDeviceEnrollment(enrollmentId: string): Promise<DeviceEnrollmentRow | undefined>;
updateDeviceEnrollment(enrollmentId: string, change: (r: DeviceEnrollmentRow) => DeviceEnrollmentRow): Promise<DeviceEnrollmentRow | undefined>;
putDevice(record: DeviceRecord): Promise<'created' | 'exists' | 'kem_taken'>; // create-only, also writes the owner index; exists when the device id is taken
putDeviceNonce(nonceHash: string, expiresAt: number): Promise<boolean>; // create-only; a device_request or owner_bind nonce is spent once; false means already used
getDevice(deviceId: string): Promise<DeviceRecord | undefined>;
updateDevice(deviceId: string, change: (r: DeviceRecord) => DeviceRecord): Promise<DeviceRecord | undefined>;
listDevicesForOwner(ownerIdentityId: string): Promise<readonly DeviceRecord[]>;
putWrap(row: WrapRow): Promise<boolean>; // create-only
getWrap(relicId: string, version: number, recipientKeyId: string): Promise<WrapRow | undefined>;
listWraps(relicId: string, version?: number): Promise<readonly WrapRow[]>;
deleteWraps(relicId: string, filter: { readonly version?: number; readonly recipientKeyId?: string }): Promise<number>;
putSeal(row: SealRow): Promise<boolean>; // create-only
getSeal(relicId: string, version: number): Promise<SealRow | undefined>;
deleteSeals(relicId: string, version?: number): Promise<number>;
putGrant(row: GrantRow): Promise<boolean>; // create-only, also writes the grantee index
getGrant(relicId: string, granteeIdentityId: string): Promise<GrantRow | undefined>;
listGrants(relicId: string): Promise<readonly GrantRow[]>;
updateGrant(relicId: string, granteeIdentityId: string, change: (r: GrantRow) => GrantRow): Promise<GrantRow | undefined>;
deleteGrant(relicId: string, granteeIdentityId: string): Promise<void>; // and its index entry
deleteGrantsForRelic(relicId: string): Promise<number>;
listGrantsForGrantee(granteeIdentityId: string): Promise<readonly GrantRow[]>;
putAccessRequest(row: AccessRequestRow): Promise<boolean>; // create-only
getAccessRequest(relicId: string, requesterIdentityId: string): Promise<AccessRequestRow | undefined>;
listAccessRequests(relicId: string): Promise<readonly AccessRequestRow[]>;
updateAccessRequest(relicId: string, requesterIdentityId: string, change: (r: AccessRequestRow) => AccessRequestRow): Promise<AccessRequestRow | undefined>;
deleteAccessRequestsForRelic(relicId: string): Promise<number>;
putOwnedRelic(row: OwnedRelicRow): Promise<void>;
listOwnedRelics(ownerIdentityId: string): Promise<readonly OwnedRelicRow[]>;
deleteOwnedRelic(ownerIdentityId: string, relicId: string): Promise<void>;
appendAccessEvent(event: AccessEvent): Promise<void>;
listAccessEvents(ownerIdentityId: string, now: number, relicId?: string): Promise<readonly AccessEvent[]>; // excludes retainUntil <= now
```

Index writes (owner, grantee, device owner) are part of the operation and throw on failure; they are never best-effort, because revocation sweeps depend on them. `getIdentityForAddress` reads the address pointer, then the record, and returns undefined unless `record.email` equals the normalized address and the record is not retired.

### 4.11 GCS layout and Terraform

Store prefix is `m/` (`local.store_prefix`), ciphertext prefix `r/`, both unchanged.

| Object | Content |
|---|---|
| `m/identity/{identityId}.json` | `IdentityRecord` |
| `m/identity-address/{sha256Hex(normalizedEmail)}.json` | `{identityId, email, updatedAt}`; create-only, CAS on replace |
| `m/device/{deviceId}.json` | `DeviceRecord` |
| `m/device-owner/{ownerIdentityId}/{deviceId}.json` | `{deviceId, at}` |
| `m/challenge/device-enrollment/{enrollmentId}.json` | `DeviceEnrollmentRow` (existing transient prefix, 1-day lifecycle; app refuses after `expiresAt`) |
| `m/wrap/{relicId}/{version}/{recipientKeyId}.json` | `WrapRow` |
| `m/seal/{relicId}/{version}.json` | `SealRow` |
| `m/grant/{relicId}/{granteeIdentityId}.json` | `GrantRow` |
| `m/grant-by-grantee/{granteeIdentityId}/{relicId}.json` | `{relicId, at}` |
| `m/access-request/{relicId}/{requesterIdentityId}.json` | `AccessRequestRow` |
| `m/owner-relic/{ownerIdentityId}/{relicId}.json` | `OwnedRelicRow` |
| `m/access/{ownerIdentityId}/{at, 16-digit zero-padded}-{8 hex}.json` | `AccessEvent`, written with `uploadType=multipart` metadata `customTime = ISO(retainUntil - 86_400_000)` |

`enrollmentId` is 26 Crockford characters from 16 random bytes. Terraform (`resource.google_storage_bucket.relics.tf`): add a lifecycle rule `Delete` when `days_since_custom_time = 1` and `matches_prefix = ["${local.store_prefix}/access/"]`; add `"PUT"` to the CORS methods. The fake GCS in `gcsstore.test.ts` learns multipart uploads and records `customTime`.

### 4.12 Seal, grant and revocation rules

Required recipient set R for a relic at seal time: the owner identity's `kemKeyId`; every owner device with no `revokedAt` and `notAfter > now`; the recovery identity's key when designated and not retired; every grant without `revokedAt` whose grantee identity is not retired.

`complete` for a private relic, in order:
1. Parse the seal statement; `relic_id` matches; `version === row.version`; `version > (row.sealedVersion ?? 0)`.
2. Signer: `identity` must be the owner identity; `device` must be an owner device, not revoked, `notAfter >= at`. Verify the signature.
3. `ciphertext_sha256` equals the server's digest of the stored object, else `seal_digest_mismatch`.
4. The wraps' recipient set equals R and equals `recipient_key_ids`, and `owner_epoch` equals the owner identity's `recipientsEpoch`; else `recipients_changed` with both epochs.
5. Delete any wraps already stored for this unsealed version, write the new wraps and the seal (create-only).
6. `updateRelic`: require `accessEpoch === statement.access_epoch`, `version === row.version`; set `sealedVersion`. On failure delete what step 5 wrote and refuse `recipients_changed` or `version_conflict`.
7. Then today's `markPublished`, digest record and change notice.

Grant: verify attestation and owner; grantee identity current; `fingerprint_typed` equals the grantee's fingerprint (else `fingerprint_mismatch`); every version sealed and not deleted; wraps exactly cover `versions` × grantee key. Write wraps, write or replace the grant, then `updateRelic` requiring `row.sealedVersion` to be in `versions` and incrementing `accessEpoch`; on failure delete what was written and refuse `grant_stale_version` with `current_version`. Mark the request granted, mail the grantee, log `grant`.

Revocation: verify one attestation carrying `revocation` and `republish`; `previous_version === row.sealedVersion === row.version`, else `version_conflict`. Record the revocation on the grant, `deleteWraps(relicId, {recipientKeyId})`, and in one `updateRelic` increment `accessEpoch` and open the next version exactly as `beginVersion` does (notice pending). Sign the upload, log `revoke`, return the upload grant and epochs. The browser then uploads and completes with an identity-signed seal.

Device approve and revoke, and recovery changes, increment the owner's `recipientsEpoch`. Device revoke and recovery replacement delete that key's wraps across `listOwnedRelics`. A version sealed in the window between a designation and its backfill can miss the new recipient; `GET /api/identity/relics?coverage=1` reports such gaps and the dashboard repairs them through `/api/identity/backfill`.

### 4.13 Regulated profile enforcement points

- Server: private `grant` and `republish` refuse a non-empty title, `owner_email`, `share_verifier`; `ttl_days` defaults and is capped; covers refused; `share_proof` on a private route refused; private comment writes need a version.
- Shell: generic card (title "Relic", description "A private relic. Sign in to open it."), no cover, no title, no renderer-class copy.
- Mail: section 4.14 templates for every private notification.
- relic-mcp: refuses `title` and `cover` for private before any network call, never launches the cover renderer, never prints keys.
- Viewer: never writes private relics to the key vault, never offers a key phrase or a key-bearing link.

### 4.14 Mail and disclosure (verbatim)

`accessRequestedMail({requestUrl})`: subject `Someone asked for access to a relic`; text:
```
Someone asked for access to a relic you own on Relic.

Review the request: {requestUrl}

Before you grant access, ask them to read you their fingerprint on a phone or video call. Don't accept it by email or chat.
```
`accessGrantedMail({relicUrl})`: subject `You have access to a relic`; text:
```
You can now open a relic on Relic.

Open it: {relicUrl}

You'll confirm with your passkey.
```
`privateActivityMail({relicUrl, stopUrl})`: subject `Activity on a relic`; text:
```
There's new activity on a relic you follow on Relic.

{relicUrl}

Stop these emails: {stopUrl}
```
with the same List-Unsubscribe headers as today's notices; used for comment, reply and change notices on private relics.
`identityReplacedMail({address, at})`: subject `Your Relic private-share key was replaced`; text:
```
A new private-share key was set up for {address} on Relic at {UTC time}.

Relics shared with your old key can't be opened with the new one until each owner shares them again.

If this wasn't you, someone can read mail sent to this address. Secure your mailbox.
```
HTML bodies mirror the text with the existing escaping helpers. `requestUrl` is `{serviceOrigin}/{id}?access=requests`; `relicUrl` is `{serviceOrigin}/{id}`.

Disclosure paragraph, identical in `disclosureStatement()` and `service.md` section 5:
> **Private relics.** A private relic's link carries no key. Each reader who is let in has their own copy of each version's key, encrypted to a key only their passkey can unlock; the service stores those encrypted copies and never the keys. To let someone in, the service records who asked and who granted, the email addresses involved, the public keys, and a signed record of each grant and revocation. It keeps an access log of requests, grants, revocations, key fetches and deletions for the owner, for the retention the owner sets. It also stores each person's private-share key encrypted under a secret held by their passkey. Private relics carry no title or cover, always expire, and their notification emails say only that there is activity on a relic. The JavaScript that decrypts them comes from this service, the same as for every relic.

### 4.15 Viewer modules, DOM hooks and load-bearing copy

Shared modules (S4 owns, S5 imports):

```ts
// packages/relic-viewer/src/private/keys.ts
export class PrfUnavailableError extends Error {}
export interface UnlockedIdentity { readonly identityId: string; readonly email: string; readonly kemPublicKey: Uint8Array; readonly sigPublicKey: Uint8Array; readonly kemKeyId: Uint8Array; readonly credentialId: string; dh(peer: Uint8Array): Promise<Uint8Array>; sign(bytes: Uint8Array): Promise<Uint8Array> }
export function loadIdentityState(deps: ViewerDeps): Promise<IdentityStateJSON>;
export function unlock(deps: ViewerDeps, state: IdentityStateJSON, signal?: AbortSignal): Promise<UnlockedIdentity>;
export function attest(deps: ViewerDeps, request: { purpose: AttestPurpose; relicId?: string; credentialId?: string; build(identityId: string): readonly { kind: StatementKind; statement: Record<string, unknown> }[] }, signal?: AbortSignal): Promise<{ identity: UnlockedIdentity; bundle: AttestationBundleJSON }>;
// packages/relic-viewer/src/private/open.ts
export function fetchVersionKey(deps: ViewerDeps, relicId: string, version: number, identity: UnlockedIdentity): Promise<{ key: Uint8Array; keyJson: KeyJSON }>; // verifies wrap, seal chain, recipients, owner pin
export function fetchAndDecryptVersion(deps: ViewerDeps, relicId: string, version: number, identity: UnlockedIdentity): Promise<{ envelope: Envelope; content: Uint8Array; digest: string }>; // verifies digest against the seal
// packages/relic-viewer/src/private/owner-panel.ts (S5 owns)
export function openAccessPanel(host: HTMLElement, ctx: { relicId: string; access: PrivateAccessJSON; deps: ViewerDeps; onChanged(): void }): void;
// packages/relic-viewer/src/private/dashboard-private.ts (S5 owns)
export function renderPrivateDashboard(host: HTMLElement, ctx: { deps: ViewerDeps; approveDeviceEnrollmentId?: string }): void;
```

`ReadyView` gains `access?: 'private'` and `keyFor?(version: number): Promise<Uint8Array>`. For private views `shareUrl` is the keyless URL and every key use (history, comments, decisions, share) goes through `keyFor`.

DOM hooks (the mock and the proof use exactly these):
- Host `#relic-private[data-private-state]` with states `signin`, `setup`, `setup-refused`, `replace-offer`, `request`, `requested`, `declined`, `unlock`, `ready`, `revoked`, `denied`, `owner-changed`, `seal-mismatch`.
- Actions: `[data-action="private-setup"]`, `[data-action="private-replace-passkey"]`, `[data-action="private-request"]`, `[data-action="private-unlock"]`, `[data-action="open-access-panel"]`.
- `[data-fingerprint="mine"]`, `[data-fingerprint="owner"]`, `[data-fingerprint="identity"]`, `[data-fingerprint="owner-for-device"]` hold display-format text.
- Owner panel: `[data-request-identity="<identityId>"]`, `input[data-fingerprint-input]`, `[data-fingerprint-state="empty|mismatch|match"]`, `input[data-grant-version="<n>"]`, `[data-action="grant"]` (disabled unless `match`), `[data-action="decline"]`, `[data-grantee="<identityId>"]`, `[data-action="revoke"]`, `[data-action="confirm-revoke"]`, `[data-rekey-state="decrypting|encrypting|uploading|sealing|done|failed"]`, `[data-action="delete-relic"]`, `input[data-delete-version="<n>"]`, `[data-action="confirm-delete"]`.
- Dashboard: `[data-private-dashboard]`, `[data-device-approval="<enrollmentId>"]`, `input[data-device-fingerprint-input]`, `[data-action="approve-device"]`, `[data-device="<deviceId>"]`, `[data-action="revoke-device"]`, `input[data-recovery-email]`, `[data-action="recovery-lookup"]`, `input[data-recovery-fingerprint-input]`, `[data-action="designate-recovery"]`, `[data-access-log] [data-access-event="<kind>"]`, `input[data-retention-days]`, `[data-action="save-retention"]`, `[data-action="repair-coverage"]`.

Load-bearing copy (verbatim; the rest comes from the mock):
- Fingerprint instruction: "Read this fingerprint to the person who shared the link, on a phone or video call. Don't send it by email or chat: it only protects you if it travels a different way than this site."
- No PRF, replacement offer: "This passkey was made before private shares existed and can't hold your key. Make a replacement passkey on this device?"
- No PRF, refusal: "Your passkey provider can't hold a private-share key. Private relics need a provider or security key that supports the WebAuthn PRF extension."
- Revoke warning: "Revoke {email}? Relic stops serving them this relic now and deletes their keys for it. Anything they already opened may still be on their device. The current content is republished as version {n} under a new key that only the remaining readers can open."
- Owner changed: "The owner's key for this relic isn't the one you saw when you first opened it. Relic won't open it. Contact the person who shared it."
- Seal mismatch: "This version doesn't match the owner's signature. Relic won't show it."

### 4.16 relic-mcp state, device keys and tools

- `publish-state.json` gains a top-level `private_relics: Record<relicId, PrivatePublishState>`; the existing writer preserves unknown top-level keys (`state.ts:559-565`), so older clients on the same machine neither see nor drop private entries.

```ts
export interface PrivatePublishState {
  readonly access: 'private';
  readonly service_origin: string;
  readonly publish_token: string;
  readonly version: number;
  readonly version_keys: Readonly<Record<string, string>>; // version -> base64url 16-byte key
  readonly owner_identity_id: string;
  readonly device_id: string;
  readonly source?: SourceIdentity; readonly filename?: string; readonly published_at?: string; readonly updated_at?: string; readonly content_sha256?: string; readonly expires_at?: string | null;
}
```
The private entry is written after the grant response and before the upload, then updated after the seal.

- `device-keys.json` beside the state file (override `RELIC_DEVICE_KEYS`), 0600 in a 0700 directory, atomic rename, its own write chain:

```json
{ "devices": { "<service origin>": {
  "device_id": "hex", "backend": "secure-enclave | file", "label": "string", "created_at": "ISO",
  "kem_public_key": "b64url", "sig_public_key": "b64url",
  "kem_private": { "jwk": {"kty":"EC","crv":"P-256","d":"...","x":"...","y":"..."} } , "sig_private": { "se_blob": "base64" },
  "enrollment": { "enrollment_id": "...", "approve_url": "...", "expires_at": "ISO" },
  "cert": { "statement": {}, "identity_signature": "..." },
  "owner": { "identity_id": "hex", "email": "...", "kem_public_key": "b64url", "sig_public_key": "b64url", "pinned_at": "ISO" } } } }
```
(`kem_private` and `sig_private` each hold either `jwk` or `se_blob`.)

- Tools (publish.md tool count rises from twelve to fifteen):
  - `relic_enroll_device {label?}` → `{status:'pending', enrollment_id, approve_url, device_id, device_fingerprint, backend, expires_at}`.
  - `relic_confirm_device {owner_fingerprint}` → `{status:'confirmed', device_id, owner:{email, fingerprint}}`; errors `device_enrollment_pending`, `device_owner_fingerprint_mismatch`, `device_enrollment_expired`. Pins only on a match.
  - `relic_bind_owner {relic_id}` → `{relic_id, owner:{email, fingerprint}}` for a public relic in local state.
  - `relic_publish` gains `private?: boolean`. Private output: `{access:'private', url (no fragment), relic_id, version, version_digest, relic_expires_at, renderer_class, filename, resolved_path, report_url, disclosure_url, owner:{email, fingerprint}, recipients:[{kind, email?, label?, fingerprint?}]}`. Never `key_phrase`, never a cover.
  - `relic_republish`, `relic_show`, `relic_list`, `relic_share`, the four comment tools and `relic_read_decisions` handle private entries (per-version keys, publish-token reads, invitation email with the keyless link via `composeShareEmail({..., access:'private'})`).
- Private publish sequence: capability check (`private_shares` in the challenge response) → `context` (device auth) → verify owner equals pin, device certs, recovery designation → new id and key → encrypt → grant (`access:'private'`, device auth) → refuse unless the response echoes `access:'private'` → write state → wraps → PUT → seal (device) → `complete` with seal and wraps → on `recipients_changed`, refetch, rewrap and retry `complete` up to 3 times with the same ciphertext and key.
- Private republish adds `POST /recipients` with the publish token and verifies every grant's identity signature against the pinned owner, every grantee's public keys against `grantee_identity_id`, every device cert, and the recovery designation, before wrapping.

### 4.17 Secure Enclave helper

`packages/relic-mcp/native/secure-enclave/relic-se.swift`, built per darwin target to `prebuilds/<target>/relic-se`, ad-hoc signed by the linker. One JSON request on stdin, one JSON response on stdout, exit 0; errors are `{"error": "<code>"}` with exit 1.

| `op` | Request | Response |
|---|---|---|
| `available` | `{}` | `{"available": bool}` (`SecureEnclave.isAvailable`) |
| `create` | `{}` | `{"kem":{"blob","public_key"},"sig":{"blob","public_key"}}` (base64 blob, base64url 65-byte x963 key) |
| `sign` | `{"blob","message"}` | `{"signature"}` (base64url 64-byte raw `r ‖ s`) |
| `ecdh` | `{"blob","peer_public_key"}` | `{"shared_secret"}` (base64url 32 bytes) |

```ts
// packages/relic-mcp/src/secure-enclave.ts (S7 owns, S6 imports)
export interface SecureEnclaveHelper { available(): Promise<boolean>; create(): Promise<{ kem: { blob: string; publicKey: Uint8Array }; sig: { blob: string; publicKey: Uint8Array } }>; sign(blob: string, message: Uint8Array): Promise<Uint8Array>; ecdh(blob: string, peerPublicKey: Uint8Array): Promise<Uint8Array> }
export function secureEnclaveHelper(): SecureEnclaveHelper | undefined; // undefined when no prebuild exists for this platform
```

### 4.18 File ownership (one writer per file)

| Slice | Files |
|---|---|
| S0 | `docs/plans/private-shares/README.md`, `docs/plans/private-shares/mockup.html` |
| S1 | `packages/relic-format/src/{hpke,private,private-wire,email}.ts` (new), `id.ts`, `index.ts`, `share.ts`, `passkey.ts`, `package.json`, `packages/relic-format/test/{hpke,private,email}.test.ts` (new), `share.test.ts` |
| S2 | `packages/relic-server/src/{store,gcsstore}.ts`, `packages/relic-server/test/{gcsstore,store-private}.test.ts`, `packages/relic-server/test/sign-in-code.test.ts` (import), `deploy/terraform/modules/relic/resource.google_storage_bucket.relics.tf` |
| S3 | `packages/relic-server/src/{app,config,problems,mail,card}.ts`, `packages/relic-server/src/private/*.ts` (new), `packages/relic-server/test/fake-authenticator.ts`, `packages/relic-server/test/private-*.test.ts` (new), `{app,mail,webauthn,decisions}.test.ts` |
| S4 | `packages/relic-viewer/src/{viewer,main,comments,share,copy-link,decisions,decision-panel,vault,passkey-common,passkey-sign-in}.ts`, `packages/relic-viewer/src/private/{keys,open,identity,request}.ts` (new), `packages/relic-viewer/test/private-reader.test.ts` (new), `shell-budget.test.ts`, `passkey-sign-in.test.ts` |
| S5 | `packages/relic-viewer/src/private/{owner-panel,rekey,delete,devices,recovery,access-log,fingerprint-input,dashboard-private}.ts` (new), `relic-rows.ts`, `packages/relic-viewer/src/styles.css` (all private CSS), `packages/relic-viewer/test/private-owner.test.ts` (new) |
| S6 | `packages/relic-mcp/src/{publish,republish,state,share,comments,decisions,inventory,server}.ts`, `packages/relic-mcp/src/{device,private}.ts` (new), `packages/relic-mcp/test/private-*.test.ts` (new), `packages/relic-mcp/skills/relic/SKILL.md` and the `INSTRUCTIONS` text in `server.ts` |
| S7 | `packages/relic-mcp/native/secure-enclave/relic-se.swift` (new), `native/build.mjs`, `scripts/prove-packed-native.mjs`, `packages/relic-mcp/src/secure-enclave.ts` (new), `packages/relic-mcp/package.json` (`files`), `.github/workflows/publish-mcp.yml`, `packages/relic-mcp/test/secure-enclave-path.ts` (new) |
| S8 | `packages/relic-mcp/test/{private-shares-path,private-shares-steps,private-shares-live-probe,private-shares-manual}.ts` (new), `decision-proof-steps.ts` (`launchProofBrowser` gains `authenticator?: { hasPrf?: boolean }`, default unchanged), `.github/workflows/verify.yml`, `PATH.md` |
| S9 | `docs/spec/{format,service,viewer,publish}.md`, `docs/spec/*.sources.txt`, `docs/frame.md`, `docs/decisions.md`, `docs/design/{storage,container,topology}.md`, `docs/knowledge/webauthn-prf-and-device-keys-measured.md` (new), `README.md` |

`normalizeEmail` importers move to `@relic/format`: `store.ts`, `gcsstore.ts`, `sign-in-code.test.ts` (S2); `app.ts`, `decisions.test.ts` (S3).

## 5. Slices

Wave 1: S0 and S1 in parallel. Wave 2 branches from the merge of S0 and S1 and runs S2 to S9 in parallel; nobody builds or tests mid-flight. Each slice works on `feat/private-shares--<slice>` in its own worktree and is merged into `feat/private-shares` with `git pull origin feat/private-shares--<slice>` (merge commits, never squash). Recommended dispatch: `designer` for S0, `effort: "hi"` for S1 to S8.

**S0, plan and mock.** Commit this plan as `README.md` and build `mockup.html`: self-contained (inline CSS, JS, SVG), clickable, light and dark, real copy, every state and hook in 4.15 (reader R: signin, setup, replace offer, refusal, request, requested with fingerprint, unlock, ready with Private badge and owner fingerprint, revoked, owner-changed, seal-mismatch; owner: access panel, typed fingerprint empty/mismatch/match, version picker with the current version locked on, grant, decline, revoke dialog and rekey progress, delete dialog; dashboard: identity card, bind passkey, devices, device approval with typed fingerprint then the owner fingerprint to give the agent, recovery designation, owned and shared relics with coverage repair, access log, retention). Non-goal: production CSS. Acceptance: the mock opens in an isolated headless shell, each state is reachable by clicking, and every hook in 4.15 exists in it.

**S1, format crypto.** Implement 4.1 to 4.6. Non-goals: server, viewer and client wiring. Acceptance: `bun test packages/relic-format` reproduces RFC 9180 A.3.1 and A.3.1.1 byte for byte; frozen known-answer fixtures for `canonicalJson`, `statementBytes` of every kind, `attestationChallenge`, identity, device and kem ids, both fingerprints (and display/parse with aliases, spaces, hyphens, wrong lengths); wraps refuse a wrong relic id, version, aad or recipient; bundles refuse another credential id or identity id; `parseStatement` refuses an extra key, a missing key, a float, a wrong type for every kind; the package typechecks under Node 18 and 24. Review risk: HPKE label bytes and the empty-salt rule; evidence is the vector test.

**S2, store.** Implement 4.10 and 4.11 in both stores, the tombstone union, multipart `customTime`, Terraform. Non-goals: routes. Acceptance: one contract suite runs against `MemoryStore` and `gcsStore` on the fake GCS and passes on both: create-only collisions return false; `updateRelic` retries under contention and aborts on a thrown `ProblemError`; index entries exist after put and vanish after delete; `deleteWraps` by recipient across versions; access events carry `customTime = retainUntil - 1 day` and are excluded after `retainUntil`; legacy tombstones without `kind` still read as operator tombstones; `terraform fmt -check` and `validate` pass. Review risk: GCS multipart body format and CAS rollbacks.

**S3, server HTTP.** Implement 4.7 to 4.9, 4.12 to 4.14 in `app.ts` plus `src/private/` (attestation verification, access decisions, seal, routes), config, problems, mail, card, disclosure, assertConfig rule, PRF in creation options and the replacement flag, operator-delete cleanup. Non-goals: viewer UI. Acceptance (route tests on `MemoryStore` with an extended fake authenticator): every route's success and each listed refusal; regulated refusals; mint, comments, decisions, share and key fetch gated for private relics and unchanged for public ones; a stored grant re-verifies offline from the store snapshot alone (assertion, challenge, identity signature); a grant racing a seal ends with either the grantee wrapped in the new version or a `grant_stale_version`/`recipients_changed` refusal, never neither; revocation deletes the grantee's wraps and opens the next version; owner delete leaves no row, wraps, seals, grants, requests, comments, decisions or objects and an id-only tombstone, while access events remain; private mails contain no title and no addresses other than the recipient's; an assertion with the ED flag and an `hmac-secret` extension map verifies; `assertConfig` refuses `usercontentOrigin` under the RP ID. Review risks: authorization on every new route, the epoch CAS, and that no route returns a fingerprint or accepts PRF output.

**S4, viewer reader path.** Boot branch on `data-relic-access`, sign-in, identity setup with PRF (replacement offer, refusal), request with locally computed fingerprint, unlock, explicit sealed-version open with full verification and owner pin, per-version comment ciphers, private copy-link (keyless only), invitation share, private decisions, vault exclusion, PRF pass-through in passkey options, no extension results in serializers. Non-goals: owner panel and dashboard. Acceptance: DOM-stub tests drive every reader state; a test captures every request body in the private flows and finds no `prf`, no `clientExtensionResults` and no 16-byte key encodings; tampered seal, wrong digest, changed owner pin and missing recipient each refuse; `shell-budget.test.ts` shows `viewer.js` holds none of the private markers ("Read this fingerprint", "private-share key") and exactly one chunk does; the existing shell ceiling is unchanged. Review risk: key material reaching any URL, storage or request.

**S5, viewer owner and dashboard.** Access panel, typed fingerprint component, grant, decline, revoke with browser rekey (decrypt via `fetchAndDecryptVersion`, `encryptRelic` with a fresh key and the original filename and mimetype, PUT to the signed URL, identity-signed seal, `complete`), delete, device approval, recovery designation with backfill, coverage repair, access log, retention, owned and shared lists, all private CSS. Non-goals: reader path. Acceptance: DOM-stub tests show Grant disabled until the typed fingerprint matches the locally computed one and enabled after; the revoke dialog shows the 4.15 warning before anything is sent; a rekey run against a fake fetch produces a republish request, an upload of `encryptedSize` bytes, wraps for exactly the remaining recipients and a seal whose digest matches the uploaded bytes; the device approval page refuses a mismatched device fingerprint. Review risk: the rekey must never upload under the old key or wrap to the revoked identity.

**S6, relic-mcp.** Implement 4.16 with the S7 helper interface. Non-goals: native build. Acceptance against an in-process app: a private publish returns a keyless URL and, across every tool output and error, no string that equals or encodes any key in state (base64url, hex, mnemonic); a forged grant (not signed by the pinned owner), a grant whose keys don't hash to its identity id, an uncertified device and an unsigned recovery designation are each refused before wrapping; `relic_confirm_device` refuses a wrong owner fingerprint and pins nothing; a legacy-shaped writer preserves `private_relics`; `device-keys.json` is 0600 in 0700 and partitioned by origin; private publish against a server without `private_shares` refuses before any upload. Review risk: key material in outputs and recipient injection.

**S7, Secure Enclave helper.** Swift helper per 4.17, build and audit for `darwin-arm64` and `darwin-x64` (minimum macOS 15.0, links only system frameworks), stage and hash it in `publish-mcp.yml`, probe `available` in packed-native cells, and `secure-enclave-path.ts` that creates, signs, verifies and agrees through the helper. Non-goals: Linux and Windows (file backend). Acceptance: the native build produces both helpers with build-info; on a GitHub macOS runner the probe reports `available` as a boolean and exits 0; on a non-VM Apple silicon Mac `secure-enclave-path.ts` prints `SECURE_ENCLAVE_PATH_OK`; the publish-mcp dry run passes. Review risk: the helper must never print a private key and must refuse malformed input.

**S8, proofs.** `private-shares-path.ts` (loopback, three isolated browsers with PRF virtual authenticators plus one without, real relic-mcp over stdio, captured mail), the live probe (operator-run, `+tag` mailboxes, ends with a hard delete), `private-shares-manual.ts` (boots a loopback service that prints mail to the terminal, for real authenticators), the CI step, and the PATH.md section. Non-goals: product code. Acceptance at integration: the path prints in order
`PRIVATE_STEP_1_OWNER_IDENTITY fingerprint=<32>`,
`PRIVATE_STEP_2_DEVICE_PINNED wrong_owner_fingerprint=refused`,
`PRIVATE_STEP_3_TAP_FREE_PUBLISH fragment=false key_in_output=false owner_sign_count_delta=0 owner_open=ok`,
`PRIVATE_STEP_4_REQUESTED mail_names_relic=false mail_names_requester=false`,
`PRIVATE_STEP_5_WRONG_FINGERPRINT ui=blocked api=409 requester_wraps=0`,
`PRIVATE_STEP_6_SUBSTITUTED_KEY ui=blocked`,
`PRIVATE_STEP_7_GRANTED reader_open=ok comment=ok agent_read=ok`,
`PRIVATE_STEP_8_REVOKED version=<n> revoked_wraps=0 revoked_key_fetch=403 revoked_mint=403 owner_open=ok agent_read=ok`,
`PRIVATE_STEP_9_NO_PRF provider=refused credential_without_prf=replace_offered identity_posts=0`,
`PRIVATE_STEP_10_REGULATED title=400 cover=400 ttl_over_max=400 shell_title=absent notices_generic=true`,
`PRIVATE_STEP_11_DELETED objects=0 wraps=0 seals=0 grants=0 comments=0 row=absent tombstone=owner log_events=<n>`,
then `PRIVATE_SHARES_PATH_OK`. `owner_sign_count_delta` comes from `WebAuthn.getCredentials` on the owner's authenticator before and after the MCP publish. Step 6 swaps the stored request's requester for a third identity and has the owner type the requester's true fingerprint read from the requester's page. Step 9 uses one authenticator with `hasPrf: false` and one credential created without `prf` on a PRF authenticator.

**S9, docs.** Every amendment in section 11, the decisions entry, the knowledge doc with the measurements in the appendix, the disclosure paragraph verbatim. Non-goals: code. Acceptance: each listed section is amended and no remaining sentence in the repo says the key is always in the URL, that one key decrypts every version without saying "public relics", or that identity never authorizes access.

## 6. Proof inventory

Permanent (run by `bun run test` in CI): `relic-format/test/{hpke,private,email}.test.ts`; `relic-server/test/{store-private,private-routes,private-mail,private-attestation}.test.ts` plus additions to `gcsstore`, `app`, `webauthn`, `decisions` tests; `relic-viewer/test/{private-reader,private-owner}.test.ts`, `shell-budget` and `passkey-sign-in` additions; `relic-mcp/test/{private-publish,private-recipients,device-keys}.test.ts`.

Permanent, run by a CI step: `private-shares-path.ts` (verify.yml, Linux Chrome stable). Permanent, operator-run: `private-shares-live-probe.ts`, `private-shares-manual.ts`, `secure-enclave-path.ts` (needs a non-VM Mac). Throwaway: none committed. The measurements in the appendix were scratch probes outside the repo.

Existing proof this relies on and its blind spots: `decision-proof-steps.ts:159-257` already launches an attested headless Chrome over a CDP pipe with a virtual authenticator; `hasPrf` is the only new option (measured working in Chrome 157 and HeadlessChrome 149). Virtual authenticators prove the protocol, not real providers. CI's macOS runners are VMs without a Secure Enclave. `passkey-sign-in-live-probe.ts` shows the live-probe pattern writes to production.

## 7. Delivery

1. One workstream, one PR from `feat/private-shares` (already at `origin/main` 51a8bf55). Push after wave 1 and open the PR ready for review immediately; it merges only when everything below is green.
2. Commit order: S0 and S1, then S2 to S9 merged in any order, then integration fixes.
3. Integration gate (main agent): `bun install --frozen-lockfile`; `mise exec node@18.20.8 -- mise run verify` and `mise exec node@24.15.0 -- mise run verify` (lint, typecheck, build plus `bun test`); `bun run --cwd packages/relic-mcp typecheck`; `bun run --cwd packages/relic-mcp build`; the CI path scripts (cover, notify, comment, comment-popover, decision, passkey-sign-in, email-code-sign-in, copy-link, otio, load-progress) still print their OK lines; `private-shares-path.ts` prints `PRIVATE_SHARES_PATH_OK` with `RELIC_CHROME_PATH` set to the owned headless shell 1228; `secure-enclave-path.ts` on this Mac; isolated headless screenshots of every 4.15 state compared with the mock; a `security-reviewer` subagent on the diff; `gh workflow run publish-mcp.yml --ref feat/private-shares -f version=<next> -f dry_run=true` green.
4. Pre-merge human check (no production writes): Jason runs `private-shares-manual.ts` and uses his real passkeys in Chrome and Safari on his Mac (iCloud Keychain, plus a security key if he has one) through identity setup, MCP enrollment, private publish, request, grant, revoke and delete against loopback. Record per provider: PRF on existing credential, replacement result, unlock.
5. Merge with `gh pr merge --merge` after the `verify` workflow (jobs `verify`, `otio-headless-smoke-macos`, `image`) is green.
6. Deploy rail: `deploy.yml` on push to main runs verify, builds the image, `terraform apply` (CORS `PUT`, the access-log lifecycle rule), deploys Cloud Run by digest, then the read-only `deploy-smoke.sh` and `origin-smoke.sh`.
7. Prove the server is live: byte-compare every `https://relik.link/assets/<name>` with a clean build of the merge commit; grep a served chunk for "Read this fingerprint"; read-only checks that `POST /api/attest/nonce` without a session is 401 and `POST /api/challenge` includes `private_shares`; read the bucket's lifecycle and CORS config (read-only describe).
8. Client release: `publish-mcp.yml` with `dry_run=false` on main (CI only), then verify the registry tarball (4 targets plus both `relic-se` helpers) and rerun `private-shares-path.ts` with the published client.
9. Post-production gate, declared now:
   - Unproven before production: real providers on iPhone, Android and Windows (they cannot reach loopback); production GCS multipart `customTime` and the lifecycle rule; production CORS `PUT` from relik.link; production mail.
   - Production observation: the virtual-authenticator live probe against relik.link (only with Jason's yes in section 10), then Jason's own first real private share across his devices, ending in a hard delete; `gcloud storage objects describe` (read-only) on one `m/access/` object shows `customTime`.
   - Until both pass, the change is reported as deployed and awaiting the post-production gate. A failure means revert first, then investigate.
10. Irreversible boundaries and rollback:
    - Once any production private relic is sealed, 4.1 to 4.3 are frozen: changing a label, field or encoding needs a new versioned label and dual support. The known-answer fixtures guard them.
    - Storage is additive: new prefixes, optional row fields, a backward-readable tombstone union.
    - Rollback is reverting the merge on main (the deploy rail redeploys the prior image and reverts CORS and the lifecycle rule). Private relics made in between then degrade: the old server mints their ciphertext and lists their comment authors to anyone with the URL, with no key exposure. Prefer rolling forward; if rolling back after private relics exist, tell Jason.
    - A published relic-mcp against an older server refuses private publishing before upload (capability check), so a client release ahead of the server is safe.

## 8. Risks and unknowns, ranked

1. **Real providers' PRF behavior.** Unknown whether iCloud Keychain, Google Password Manager, Windows Hello and security keys return PRF for credentials created without `prf`, accept the replacement creation, and return PRF over hybrid transport. Resolved by: step 7.4 on the Mac before merge, then step 7.9 on phones and Windows.
2. **WebKit and Gecko WebCrypto.** The design needs ECDH and ECDSA P-256 generate, JWK import with `d,x,y`, HKDF, HMAC and AES-GCM, all standard, but only Chrome, Bun and Node were measured. Resolved by: Safari in step 7.4; Firefox in step 7.9.
3. **Seal and grant concurrency.** The epoch CAS is the correctness core. Resolved by: S2 and S3 interleaving tests on the generation-checked fake GCS.
4. **Browser rekey memory.** `encryptRelic` holds plaintext and ciphertext together; a 500 MiB private relic may fail on phones. Resolved by: rekeying a 200 MiB private relic in step 7.4 and recording the limit in the dashboard copy and docs.
5. **GCS `customTime` and lifecycle semantics** (future values on insert, matching with `matches_prefix`). Resolved by: the read-only describe after the first production event; deletion itself is unobservable until the minimum retention passes and is documented as such.
6. **Secure Enclave helper distribution** (Gatekeeper, packing, Intel Macs). Resolved by: the publish dry run, then `npx relic-mcp@<v>` on this Mac reporting `backend: secure-enclave`.
7. **First-open trust in the owner.** Accepted and disclosed; the owner fingerprint is shown for out-of-band comparison.
8. **Served viewer JavaScript.** Accepted risk from the draft and frame.md's honesty constraint.
9. **Fingerprint typing errors.** 32 characters is long. Resolved by: step 7.4 usability; the alias folding and grouping already absorb common slips.
10. **Rollback degrading gating** (section 7.10).

## 9. What would prove this plan wrong

- CI's Chrome stable rejects `hasPrf` in `WebAuthn.addVirtualAuthenticator`.
- Safari or Firefox refuses JWK import of a P-256 private key with `d`, `x`, `y`, or returns no PRF for iCloud or security-key passkeys created with `prf`.
- iCloud Keychain refuses the replacement creation even with an empty exclude list, leaving existing users no way in.
- GCS rejects `customTime` on a multipart insert, or the lifecycle rule never matches.
- A grant and a seal can both succeed with the grantee missing from the new version under the S2 interleaving tests; then the access state must move into one per-relic document.

## 10. Decisions for Jason (settled 2026-11-11: all seven recommendations accepted)

Settled by Jason in the batched ask. Decision 7 is IN scope: S2 adds the lifecycle rule and `customTime` on private ciphertext and metadata at the relic's expiry, and S3 sets `customTime` when it opens a private relic version. Decision 5 and 6 are authorised, and both happen after merge and deploy.

1. Private TTL: default 30 days, maximum 365. Alternative: 7 and 90.
2. Access log retention: default 6 years (HIPAA documentation retention), owner-settable between 30 days and 10 years.
3. Revocation: stop serving the revoked person immediately and delete their keys (recommended), instead of the draft's "they can still read earlier versions".
4. Identity replacement after losing every passkey, under the first-passkey freshness rule, with an email and old grants stopping (recommended yes).
5. Run the virtual-authenticator live probe against relik.link after deploy (writes a private relic and identities for `+tag` addresses on his own production, ends with a hard delete). Recommended yes.
6. Publish relic-mcp to npm through CI after merge. Recommended yes.
7. Erase expired private relics from storage at their TTL (ciphertext and metadata get `customTime` and a lifecycle rule; today expiry only stops serving). Not in this plan; recommended as one more S2 and S3 change if he says yes.

## 11. Docs amendment checklist (S9)

- `docs/frame.md`: line 7 product description (private links carry no key); 15 and 47 honesty constraint applies to private relics too; 134 to 144 accounts bullets (identity now carries authorization for private relics; record the reversal of 139 "attribution, not authorization"); 143 and 155 "no team features, no permissions" (per-relic grants, recorded reversal); 156 "no mandatory TTL" (private relics expire, recorded reversal).
- `docs/spec/format.md`: 2.1 and 2.2 (fragment only for public relics; format version unchanged; private key delivery versioned by labels); 2.5 (nothing to strip for private); 3.7 (refusal is server-declared access plus mint gating); 3.10 (fresh key per relic for public, per version for private); 3.12 (seals and wraps per private version); 3.13 (comment key per version for private); 3.14 (share proof unused for private); 3.16 (the seal signs the version digest); new 3.17 private key delivery and 3.18 parameter table (sections 4.1 to 4.3 here); 5 inheritance notes (publish contract: private republish uses a fresh key).
- `docs/spec/service.md`: 1 refusal tables (every new code); 2 mint (private gating); 3 expiry (private default and maximum; read-time expiry unchanged); 4 delete (owner hard delete, id-only tombstone, operator cleanup of private documents); 5 disclosure (paragraph verbatim); 7 shape; 8 mail (private templates); 9.3 and 9.4 (PRF requested at creation, replacement flag, identity bundles, stored attestations); new 10 private relics (routes, epochs, access log and retention); RP-ID rule for the usercontent origin.
- `docs/spec/viewer.md`: 2 (usercontent may never sit under the RP ID); 4 (no PRF or key material in the frame); 6.1 (private relics are not "missing key"); 6.4 comments per version; 6.8 share invitation; 6.9 decisions authorization; 6.10 passkeys (PRF requested, results never sent); new 6.12 private screens and dashboard; vault exclusion.
- `docs/spec/publish.md`: 1 tool list and count (fifteen); 1.7 to 1.9 private behavior; 3 grant hop (device auth, `access` echo check); 3.9 republish (fresh key, recipients verification, seal); 4.5 and 4.8 (private state written before upload; `device-keys.json`); 5 disclosure (no keys in private output; device key storage; an agent that read the content still exposed it to its provider).
- `docs/design/storage.md` (new prefixes and lifecycle rule), `container.md` 2.1 (per-version keys for private), `topology.md` (RP-ID constraint on any sandbox topology).
- `docs/decisions.md`: `## 2026-11-11: Private shares` with the authorised line, sections 2 and 3 here in brief, and residuals (first-open owner trust, served JS, lost-every-passkey forfeits owner actions, coverage window, rollback degradation).
- `docs/spec/*.sources.txt`: RFC 9180; W3C WebAuthn Level 3 `prf` extension; CTAP 2.1 `hmac-secret`; Apple CryptoKit `SecureEnclave`; GCS object `customTime` and lifecycle `daysSinceCustomTime`; 45 CFR 164.312.
- `PATH.md`: the private shares section with the S8 receipts; `README.md`: one paragraph on private relics.

## Appendix: measurements behind the corrections (scratch probes, 2026-11-11, this Mac)

- Chrome 157.0.8103.39 and HeadlessChrome 149.0.7827.55, CDP virtual authenticator `{protocol:'ctap2', ctap2Version:'ctap2_1', transport:'internal', hasResidentKey, hasUserVerification, isUserVerified, automaticPresenceSimulation, hasPrf:true}` on `http://localhost`: credential created without `prf` gives no PRF result; created with `prf` gives `enabled: true`, a 32-byte result at create (with `eval`) and at get, identical across gets with one salt and different across salts; assertion flags `0x05`, authenticator data 37 bytes with or without PRF.
- `PublicKeyCredential.toJSON().clientExtensionResults`: Chrome 157 `{"prf":{"results":{"first":"..."}}}`; HeadlessChrome 149 `{"prf":{}}`.
- WebCrypto in Chrome 149 and 157: PKCS#8 P-256 without the public key imports and exports `x`, `y`; JWK with only `d` is refused.
- Bun 1.4.4, Node 18.20.8 (with the repo's `webcrypto` global shim) and Node 24.15.0: P-256 ECDH raw export 65 bytes (0x04), ECDH agreement, JWK re-import with `d,x,y`, ECDSA 64-byte signatures, HMAC-SHA256, AES-GCM all work.
- macOS 27, Apple silicon, Swift 6.4.2: an ad-hoc, linker-signed CLI without entitlements reports `SecureEnclave.isAvailable = true`, creates signing and key-agreement keys, persists 284-byte blobs, and a second binary with a different CDHash reuses them in a new process (64-byte raw signature verifies, ECDH matches).
- `man security`: `add-generic-password` takes the secret through `-w`/`-X` on argv or a TTY prompt.
- RFC 9180 A.3 heading fetched: "DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM", base setup A.3.1 with `info 4f6465206f6e2061204772656369616e2055726e`.
