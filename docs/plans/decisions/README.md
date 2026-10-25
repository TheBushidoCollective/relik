# Relic Decisions: First-Class Approval Decisions

From Jason Waldrip, verbatim: "I think we need to add decisions to the relik system ... Comments mean no approval, and a stamp/button of approval means an approval."

Authorised by Jason Waldrip on 2026-10-24 (decisions as deliberate approval stamps in the viewer). The passkey binding was requested by backlot and accepted 2026-10-24.

## 1. Goal

**Path sentence:** "Jason opens a review relic in the viewer, presses Approve (passkey-confirmed), and backlot's `relic_read_decisions` call returns his email, verdict, and a version_digest equal to the one `relic_republish` returned for that version."

**What has to be true when this is done:** one run of the live probe against `https://relik.link`, using `npx relic-mcp@<released>`, prints a pass line for each of the five backlot checks:
- (a) approve on v3, read back with a matching digest
- (b) the publish token alone is refused with the distinct code
- (c) v4 starts empty and v3's decision stays
- (d) a reject after an approve leaves both records
- (e) a "GREENLIGHT" comment creates nothing

## 2. Corrections to the brief

1. **The server never sees ciphertext on upload.**
   - The client PUTs straight to GCS (`storage.ts:4-8`, `gcs.ts:386-408`).
   - Only `content-length` is signed, and upload URLs live for 900 s (`config.ts:143`). Anyone holding the URL can overwrite that version's object for 15 minutes.
   - So "computed at upload time" means: computed at `POST /api/relics/{id}/complete`, which already stats the object (`app.ts:975-1012`), by streaming the stored object once. Versions published before this change, or whose `complete` never arrived, get their digest computed lazily at first need.
   - Making objects write-once (signing `x-goog-if-generation-match: 0`) is not viable: `putContainer` (`publish.ts:860-881`) sends `content-length` only and never `upload_headers`, so every released client would fail its signature.
   - Instead, the viewer hashes the ciphertext it actually decrypted, and the server refuses a decision whose digest differs from the digest on record. "Applies to the version the viewer rendered" becomes literally true, and it fails closed if the bytes change.
2. **The service never tells the client its version.** `republish.ts:438-440` says: "The service does not return one, so this file is the only ledger." Decisions are keyed by the server's version, so a drifted local count breaks check (a). The fix: the server returns `version` from republish and from complete, and the client reports the server's number.
3. **The relic-mcp version in the repo is not the released one.** `packages/relic-mcp/package.json` says 0.3.0; the workflow stamps the real number at release (`publish-mcp.yml:329-335`). Release as 0.14.0 unless the registry has moved.
4. **The repo was renamed.** It is `TheBushidoCollective/relik` (numeric id 1316636189, per skill `ship-relic-change`).
5. **The live server has no version readback.** `/health` returns `{"status":"ok"}` only (`app.ts:180-182`). Proving a deploy: build the viewer from the merge commit and compare every `/assets/*` file byte-for-byte, then grep the served chunks for a decisions-only string. Add the new routes answering, and optionally a read-only `gcloud run services describe`.
6. **The magic-link token format:** base64url of 32 bytes, 43 characters (`app.ts:4166-4170`), not 64 hex. Extraction regex: `https://relik\.link/api/auth/callback\?token=[A-Za-z0-9_-]{43}`.
7. **WebAuthn refuses IP-address RP IDs.** Every existing loopback path serves on `http://127.0.0.1` (`otio-path.ts:225`). The decision path must serve the service origin as `http://localhost:<port>`.
8. **`sign_in_required` exists but was unused.** It is defined in `problems.ts:64,97` and named by specs, but `app.ts` emitted `invalid_session` on reader routes (`app.ts:1984-1988, 2595`). New routes emit `sign_in_required`; the viewer treats both codes as "sign in".
9. **`relic_read_comments` spends a download open when `version` is omitted.** It calls `mintRelic` (`comments.ts:350-353`). The decisions read returns `current_version` itself, so the new tool never mints.
10. **The viewer bundle is close to its cap.** `deploy.yml:251-252` requires `viewer.js` under 460,800 bytes; live is 420,706. The decision panel must ship as a lazy chunk.
11. **Comment ordering matters in the proof.** A republish is refused while a reader comment is unanswered (`unaddressed_comments`), so the GREENLIGHT check runs after the v4 republish.
12. **This change is security-relevant.** `ship-relic-change` requires a security review of the diff before merge.

## 3. Decisions taken here

- **Key proof: reuse the share proof and `row.shareVerifier`; no new label.**
  - Rejected: a separate `relic/decision-proof/v1` label.
  - Why: every key holder can derive both values, so a second label proves nothing extra. Decision authority rests on the session, the proof and the passkey together.
  - The verifier is already registered by every relic-mcp since 0.11.0 on publish and republish (`publish.ts:439`, `republish.ts:408`). A new label would add a field to grant/republish, both stores and both clients, and would leave every existing relic undecidable until republished.
  - What would reverse this: any future flow that hands the share proof to someone who does not hold the key.
- **WebAuthn verifier: hand-rolled, minimal, in `relic-server/src/webauthn.ts`.**
  - Scope: ES256 (-7) and RS256 (-257) only. `attestation: "none"`; the attestation statement is parsed past and never trusted, because trust is TOFU plus a session, not attestation. UV is required.
  - Rejected: `@simplewebauthn/server`. `relic-server` has zero third-party runtime dependencies (its `package.json` lists only `@relic/format`), and that library brings in an ASN.1/X.509 stack used only for attestation formats we do not verify.
  - Mitigation: one negative test per check, each proven to fail on its own.
- **Digest storage: a map on the relic row, `RelicRow.versionDigests[String(version)]`.**
  - First writer wins, via the existing CAS. Every row writer already spreads `...row`, so it survives `beginVersion`. The decision route reads the row anyway.
  - Each decision record also carries its own digest.
  - Computing it is a streaming control-plane read, like the delete path's hash. The server still reads only ciphertext.
- **Read authorization: `share_proof` in a POST body.**
  - Credentials ride in JSON bodies throughout this API and never in URLs, which would end up in request logs. Decisions are plaintext, so unlike the comment list the read is gated.
  - The viewer and the publishing machine both hold the key.
- **Which versions can be decided:** any version from 1 to `row.version` whose object is stored. The viewer must send the digest of the bytes it decrypted, and a mismatch is refused. Backlot binds on version plus digest, so a decision on a superseded version is an honest record, not an approval of a newer one.
- **Deletion:** an operator relic delete removes the relic's decisions, the same way it removes comments. No user-facing edit or delete exists.
- **Author:** the normalized verified address, `session.email.trim().toLowerCase()`. Passkeys are namespaced by the same normalized address.

## 4. Shared contracts

### 4.1 Identity and digest

- `normalizeEmail(v) = v.trim().toLowerCase()`, exported from `relic-server/src/store.ts`.
- **Version digest** = lowercase hex SHA-256 of the exact bytes of the version's ciphertext object, `objectKey(id, v)` (`app.ts:3361-3363`).
  - The server computes it by streaming.
  - The viewer computes it over the bytes it downloaded, at `viewer.ts:294 / 528 / 981`.
  - The MCP computes it over `container`.
- RP ID is `new URL(config.serviceOrigin).hostname`; the expected origin is `new URL(config.serviceOrigin).origin`. In production that is `relik.link` and `https://relik.link`. There is no new env var.

### 4.2 HTTP routes (all JSON; problems per `problems.ts`)

Routing goes in `apiRoute` (`app.ts:371-487`):
- `relics/{id}/decisions`: `POST` record; `POST .../options`; `POST .../list`; any other method or path returns 405.
- `auth/passkeys`: `POST` register; `POST .../options`; otherwise 405.
- Bodies over 65,536 bytes (by `content-length`) are refused with the route's malformed code.

**Shared checks.** Both decision routes run this prefix:
1. `killSwitchEngaged` -> 503 `service_paused`
2. limiter `decision ${ip}` -> 429 `decision_rate_limited`
3. `parseRelicId` -> 400 `invalid_relic_id`
4. tombstone -> 410 `relic_removed` (+`report_url`)
5. row missing -> 404 `relic_not_found`
6. expired -> 410 `relic_expired`
7. body not an object -> 400 `invalid_decision`
8. **body has the key `publish_token` (any value) -> 403 `decision_requires_reader`**
9. no valid `relic_session` -> 401 `sign_in_required`
10. `verdict` not `approve`/`reject` -> 400 `invalid_decision`; `version` not a safe integer in 1..`row.version` -> 400 `invalid_relic_version`
11. `row.shareVerifier` empty -> 409 `decision_unavailable`
12. `share_proof` must match `/^[A-Za-z0-9_-]{43}$/` and decode to 32 bytes, else 400 `invalid_decision`; its sha256 hex != `shareVerifier` -> 403 `invalid_share_proof`

Extract `checkShareProof(row, raw)` and use it in `share()` too, with the same codes as today.

**Digest on record for `(id, v)`** is computed as:
1. if `row.versionDigests?.[v]` exists, use it;
2. else `storage.stat` the object, and if it is absent -> 409 `relic_not_yet_published` (+`retry_after_seconds: 5`);
3. else `store.recordVersionDigest(id, v, await storage.digest(objectKey(id, v)))`.

**1. `POST /api/relics/{id}/decisions/options`** (session cookie required)
- Request: `{ "version": 3, "verdict": "approve", "share_proof": "<43>" }`
- Steps:
  1. Run the shared prefix.
  2. `getPasskeys(email)` is absent -> 409 `passkey_required`.
  3. Compute the digest on record.
  4. Issue a challenge `{purpose:'decide', email, relicId, version, verdict}` with TTL `passkeyChallengeTtlSeconds`.
- 200 response:
```json
{ "version": 3, "version_digest": "<64 hex>",
  "public_key": { "challenge": "<b64url 32B>", "rpId": "relik.link", "timeout": 300000,
                  "userVerification": "required",
                  "allowCredentials": [ { "type": "public-key", "id": "<b64url>", "transports": ["internal"] } ] } }
```

**2. `POST /api/relics/{id}/decisions`** (session cookie required)
- Request: `{ "version": 3, "verdict": "approve", "share_proof": "<43>", "version_digest": "<64 hex>", "credential": AuthenticationResponseJSON }`
- Steps:
  1. Run the shared prefix.
  2. `version_digest` not `/^[0-9a-f]{64}$/` -> 400 `invalid_decision`; `credential` not an object -> 400 `invalid_passkey`.
  3. No passkeys on file -> 409 `passkey_required`.
  4. Verify the assertion (section 4.5). The challenge row must have `purpose 'decide'` and match email, relicId, version and verdict, and be unexpired; otherwise 403 `passkey_verification_failed` with `passkey_check:"challenge"`.
  5. Counter CAS (section 4.4).
  6. Compute the digest on record; `body.version_digest` != it -> 409 `decision_digest_mismatch` with `{relic_id, version, version_digest:<record>}`.
  7. `appendDecision`.
- 201 response:
```json
{ "relic_id": "...", "id": "<b64url 16B>", "version": 3, "verdict": "approve",
  "author": "x@y.z", "created_at": "2026-10-24T20:00:00.000Z", "version_digest": "<64 hex>" }
```

**3. `POST /api/relics/{id}/decisions/list`** (no session; not gated by the kill switch; allowed on expired relics, like the comment list)
- Request: `{ "share_proof": "<43>", "version": 3 | "*" }`, where `version` is optional and omitted means `row.version`.
- Order: limiter `decision-read ${ip}` -> 429 `decision_rate_limited`; id, tombstone and row checks; body -> 400 `invalid_decision`; `decision_unavailable`; proof (400/403); version -> 400 `invalid_relic_version`.
- 200 response: `{ "relic_id", "current_version": row.version, "decisions": [ {id, version, verdict, author, created_at, version_digest} ] }`. Records are all of them on the selected version(s), ordered by version, then `created_at`, then `id`. It never touches `mintsUsed`.

**4. `POST /api/auth/passkeys/options`** (session required, else 401 `sign_in_required`; limiter `passkey ${ip}` -> 429 `passkey_rate_limited`)
- **No `credential` in the body:**
  - No passkey record -> `{ "mode": "create", "public_key": CreationOptions }`. The challenge row is `{purpose:'register', userHandle:<new b64url 32B>}`.
  - A record exists -> `{ "mode": "assert", "public_key": RequestOptions }`. The challenge row is `{purpose:'enroll'}`.
- **`credential` present:**
  - No record -> 409 `passkey_required`.
  - Otherwise verify it as an `enroll` assertion and run the counter CAS, then return `{ mode:"create" }` with `excludeCredentials` set to the existing credentials. The challenge row is `{purpose:'register', assertedBy:<credId>, userHandle:record.userHandle}`.
- CreationOptions:
```json
{ "challenge": "<b64url>", "rp": { "id": "relik.link", "name": "Relic" },
  "user": { "id": "<userHandle b64url>", "name": "<email>", "displayName": "<email>" },
  "pubKeyCredParams": [ { "type": "public-key", "alg": -7 }, { "type": "public-key", "alg": -257 } ],
  "timeout": 300000, "attestation": "none",
  "authenticatorSelection": { "residentKey": "preferred", "userVerification": "required" },
  "excludeCredentials": [] }
```

**5. `POST /api/auth/passkeys`** (session and limiter as above)
- Request: `{ "credential": RegistrationResponseJSON }`.
- Steps:
  1. Consume the challenge. It must be `purpose 'register'`, with an email equal to the session's normalized address, and unexpired; otherwise 403 `passkey_verification_failed` with `challenge`.
  2. `verifyRegistration`.
  3. If `assertedBy` is absent: `createPasskeys({email, userHandle, credentials:[c]})`. If that returns false -> 409 `passkey_assertion_required` (TOFU: first writer wins).
  4. If `assertedBy` is present: CAS-append, which requires that `assertedBy` is still present and the new id is not a duplicate (otherwise 403 with `credential`), and records `registeredWith: assertedBy`. If the record is gone -> 409 `passkey_required`.
- 201 response: `{ "email", "credential_id", "created_at", "passkeys": <count> }`.

**6. Changes to existing routes**
- `republish` 200 adds `"version": next.version` (`app.ts:950-958`).
- `complete` 200 adds `"version": row.version` and `"version_digest": "<64 hex>" | null`. It is `null` only if hashing failed, which is logged. Repeated calls reuse the recorded digest.
- `operatorDelete` adds `decisions_deleted` (from `deleteDecisionsForRelic`) to both responses (`app.ts:2391-2427`).
- `disclosureStatement()` gains the text in section 4.10.

**WebAuthn JSON wire types** follow the W3C `toJSON()` shapes:
- `RegistrationResponseJSON = { id, rawId, type:"public-key", response:{ clientDataJSON, attestationObject, transports? } }`
- `AuthenticationResponseJSON = { id, rawId, type:"public-key", response:{ clientDataJSON, authenticatorData, signature, userHandle: string|null } }`
- All binary fields are unpadded base64url. Unknown extra fields such as `authenticatorAttachment` and `clientExtensionResults` are ignored.

### 4.3 Problem codes (add to `ProblemCode`, `STATUS`, `TITLE`)

| code | status | title |
|---|---|---|
| `decision_requires_reader` | 403 | A decision needs a signed-in reader, never the publish token |
| `invalid_decision` | 400 | Invalid decision request |
| `decision_unavailable` | 409 | Decisions unavailable until the publisher republishes |
| `decision_digest_mismatch` | 409 | The stored version is not the version this page shows |
| `decision_rate_limited` | 429 | Too many decision requests |
| `passkey_required` | 409 | No passkey is registered for this address |
| `passkey_assertion_required` | 409 | Adding a passkey needs one you already have |
| `invalid_passkey` | 400 | Invalid passkey payload |
| `passkey_verification_failed` | 403 | Passkey did not verify |
| `passkey_rate_limited` | 429 | Too many passkey requests |

- Reused codes: `sign_in_required`, `invalid_share_proof`, `invalid_relic_version`, `relic_not_yet_published`, `relic_not_found`, `relic_removed`, `relic_expired`, `service_paused`, `invalid_relic_id`.
- `ProblemExtensions` gains `version?: number`, `version_digest?: string` and `passkey_check?: string`.
- Values of `passkey_check`:
  - for 403: `challenge`, `type`, `origin`, `cross_origin`, `rp_id`, `user_present`, `user_verified`, `signature`, `counter`, `credential`, `user_handle`
  - for 400 `invalid_passkey`: `encoding`, `cbor`, `auth_data`, `algorithm`, `key`, `shape`

### 4.4 Store and storage (in `store.ts` interfaces; both `MemoryStore` and `gcsStore`)

```ts
export type DecisionVerdict = 'approve' | 'reject';
export interface DecisionRow {
  readonly id: string;
  readonly relicId: string;
  readonly version: number;
  readonly verdict: DecisionVerdict;
  readonly author: string;
  readonly createdAt: number;
  readonly versionDigest: string;
  readonly credentialId: string;
}
export interface PasskeyCredential {
  readonly credentialId: string;
  readonly publicKeyJwk: JsonWebKey;
  readonly alg: -7 | -257;
  readonly signCount: number;
  readonly transports?: readonly string[];
  readonly createdAt: number;
  readonly lastUsedAt?: number;
  readonly registeredWith?: string;
}
export interface PasskeyRecord {
  readonly email: string;
  readonly userHandle: string;
  readonly credentials: readonly PasskeyCredential[];
}
export interface WebauthnChallengeRow {
  readonly challengeHash: string;
  readonly email: string;
  readonly purpose: 'register' | 'enroll' | 'decide';
  readonly expiresAt: number;
  readonly userHandle?: string;
  readonly assertedBy?: string;
  readonly relicId?: string;
  readonly version?: number;
  readonly verdict?: DecisionVerdict;
}
// RelicRow += readonly versionDigests?: Readonly<Record<string, string>> | undefined;
// RelicStore +=
// appendDecision(row: DecisionRow): Promise<void>;
// listDecisions(relicId: string): Promise<readonly DecisionRow[]>;
// deleteDecisionsForRelic(relicId: string): Promise<number>;
// recordVersionDigest(id: string, version: number, sha256: string): Promise<string | undefined>;
// getPasskeys(email: string): Promise<PasskeyRecord | undefined>;
// createPasskeys(record: PasskeyRecord): Promise<boolean>;
// updatePasskeys(email: string, change: (r: PasskeyRecord) => PasskeyRecord): Promise<PasskeyRecord | undefined>;
// putWebauthnChallenge(row: WebauthnChallengeRow): Promise<void>;
// consumeWebauthnChallenge(challengeHash: string): Promise<WebauthnChallengeRow | undefined>;
// ObjectStorage +=
// digest(relicId: string): Promise<string | undefined>;
```

**GCS layout** (prefix `m`):
- Decisions: `m/decision/{relicId}/{id}.json`, written with `put(name,row,'0')`.
- Passkeys: `m/passkey/{sha256Hex(normalizedEmail)}.json`. Created with `'0'`; updated by generation CAS.
- Challenges: `m/challenge/webauthn/{sha256Hex(challenge)}.json`.
  - Consume by `get`, then `DELETE ?ifGenerationMatch=<gen>`. Only the caller whose delete succeeds gets the row; 412 or 404 means it was already spent.
  - The existing 1-day lifecycle rule on `m/challenge/` cleans these up (`locals.tf:36-39`, `resource.google_storage_bucket.relics.tf:22-30`).
- **Counter CAS:** inside `updatePasskeys`, if either the stored or the new count is above 0, require new > stored; otherwise throw, which maps to 403 `counter`. Set `lastUsedAt`.
- **`gcs.ts digest`:** a signed GET with 60 s validity, streaming `response.body` into `node:crypto` `createHash('sha256')`. Never use `arrayBuffer()`: objects reach about 100 MiB and the service has 512Mi.
- **`MemoryStorage.digest`:** hash the stored bytes.

### 4.5 `relic-server/src/webauthn.ts` interface

```ts
export class WebauthnError extends Error {
  constructor(readonly kind: 'malformed' | 'verification', readonly check: string) {
    super(`webauthn ${kind}: ${check}`);
  }
}
export function challengeOf(credential: unknown): string;
export function credentialIdOf(credential: unknown): string;
export function verifyRegistration(
  credential: unknown,
  e: { challenge: string; origin: string; rpId: string }
): Promise<{ credentialId: string; publicKeyJwk: JsonWebKey; alg: -7 | -257; signCount: number; transports: readonly string[] }>;
export function verifyAssertion(
  credential: unknown,
  e: {
    challenge: string;
    origin: string;
    rpId: string;
    stored: { credentialId: string; publicKeyJwk: JsonWebKey; alg: -7 | -257 };
    userHandle: string;
  }
): Promise<{ credentialId: string; signCount: number }>;
```

**clientDataJSON**
- Parse as JSON; never compare against a template, because Chrome inserts random extra keys.
- `type` must be `webauthn.create` or `webauthn.get` as appropriate; `challenge` and `origin` must equal the expected values exactly; `crossOrigin !== true`.

**authData**
- At least 37 bytes. `rpIdHash` must equal sha256(rpId). UP (0x01) and UV (0x04) are required.
- Registration: AT (0x40) is required. Parse the AAGUID, a big-endian u16 length, the credential id (at most 1023 bytes) and one CBOR COSE key. If ED (0x80) is set, one CBOR map follows. No trailing bytes are allowed.
- Assertion: AT must be clear.

**attestationObject:** a CBOR map, of which only `authData` is used.

**CBOR:** definite lengths only, major types 0-5 plus 7 simple values. Indefinite lengths, floats and depth over 16 are malformed.

**COSE keys**
- -7 requires kty 2, crv 1, and 32-byte x and y; it becomes JWK `{kty:'EC',crv:'P-256',x,y}`.
- -257 requires kty 3 and n of at least 256 bytes; it becomes `{kty:'RSA',n,e}`.
- Anything else is malformed `algorithm`. Import the key to validate it.

**Signature:** computed over `authData || sha256(clientDataJSON)`.
- ES256 signatures are converted from DER to 64-byte raw before WebCrypto ECDSA P-256/SHA-256.
- RS256 uses RSASSA-PKCS1-v1_5/SHA-256.
- A non-null `userHandle` must equal the stored one.

**Test helper** at `relic-server/test/fake-authenticator.ts`.

### 4.6 `@relic/format` additions

- `src/decision.ts`:
  - `DecisionVerdict`, `isDecisionVerdict`
  - `DecisionRecord {id, version, verdict, author, created_at, version_digest}`
  - `DecisionList {relic_id, current_version, decisions}`
  - `versionDigest(bytes): Promise<string>` (WebCrypto, lowercase hex)
  - `isVersionDigest(v)` (`/^[0-9a-f]{64}$/`)
  - `currentDecisions(records, version)`: the latest record per author, ordered by `created_at` then `id`
- `src/passkey.ts`: `PasskeyDescriptorJSON`, `CreationOptionsJSON`, `RequestOptionsJSON`, `RegistrationResponseJSON` and `AuthenticationResponseJSON`, with exactly the shapes in section 4.2.
- Both are exported from `index.ts`.

### 4.7 MCP tool `relic_read_decisions`

- **Input:** `{ relic_id: string (required), version?: integer >= 1 | "*" }` with `additionalProperties:false`. A bad `version` is JSON-RPC -32602, following `server.ts:2549-2552`.
- **Implementation:**
  1. `localState(relic_id)`: export the existing one from `comments.ts:905`; do not copy it. Refusals use `no_local_publish_state`.
  2. `share_proof = encodeKey(await deriveShareProof(decodeKey(state.key)))`.
  3. `postJson(.../decisions/list, {share_proof, version?})`.
  4. Shape-check the response and return it unchanged as `structuredContent`.
  5. Never call mint.
- **outputSchema:** exactly `{relic_id: string, current_version: integer, decisions: [{id, version, verdict: enum, author, created_at, version_digest: pattern}]}`, with every field required and `additionalProperties:false`.
- **`REFUSAL_GUIDANCE`** gets `decision_unavailable` ("republish once with relic_republish; the link does not change"), `invalid_share_proof` and `decision_rate_limited`.
- **`relic_publish` and `relic_republish`** each add a required `version_digest: string` to the output schema and result. They compute it locally with `versionDigest(container)`. `reportComplete` returns the parsed body: if it carries `version_digest` and that differs from the local value, throw `PublishError('version_digest_mismatch', ..., {relic_id, version, local, server})`; if it carries none, use the local value. The reported republish version is `complete.version ?? grant.version ?? state.version + 1`.
- **`INSTRUCTIONS`** adds: decisions are made by a person in the viewer with a passkey; no tool records them; comment text never creates one; a person's latest record on a version is their current decision.

### 4.8 Viewer contract

- **`ReadyView.versionDigest: string`** (required), computed at all three construction sites in `viewer.ts`, right after the length check.
- **`src/decisions.ts`** (eager, small): `listDecisions(relicId, key, version, deps)` and tally helpers.
- **`src/decision-panel.ts`** (a lazy chunk loaded through `import()`): the panel, the ceremony, and WebAuthn JSON-to-binary conversion, hand-rolled for browsers without `parse*FromJSON`.
- **`main.ts` changes:**
  - `BarOptions` gains `onDecide?: (opener) => void` and `decisionTally?: { approve: number; reject: number } | null`.
  - `buildBar` mounts the control next to Comments/Share and puts it on the narrow-width must-survive list.
  - `ICONS` gains a single-path `stamp` mark.
  - `renderReady` lists decisions for `activeView.version` and wires the panel.
  - The panel receives `signIn(host)` from `main.ts`, which mounts the existing `signInForm` (`main.ts:2998`), so there is no circular import.
- **Ceremony rule:** call `navigator.credentials.create`/`get` synchronously inside a click handler whose options were already fetched (Safari's user-activation rule). So the flow is two steps: choose a verdict, then "Approve version N with your passkey".
- **Flow:**
  1. Open the panel and list decisions.
  2. Pick a verdict, which fetches `/decisions/options`.
  3. If the response is 409 `passkey_required`, show the passkey-setup step, then `/auth/passkeys/options` -> `create()` -> `POST /auth/passkeys`, then fetch options again.
  4. If `options.version_digest != view.versionDigest`, show mismatch copy and run no ceremony.
  5. Confirm -> `get()` -> `POST /decisions`.
  6. Show the recorded stamp, refresh the list and update the bar tally.
- **DOM hooks** (S6 and tests rely on them):
  - Bar: `button.action-decisions[data-decision-open]`, plus `data-decision-approvals` and `data-decision-rejections`.
  - Panel: `dialog.decision-panel[data-decision-version]`.
  - Verdict buttons: `[data-decision-verdict="approve|reject"]`; confirm: `[data-decision-confirm]`.
  - Passkey: `[data-passkey-create]`, `[data-passkey-add]`.
  - Sign-in host: `[data-decision-signin]`.
  - Rows: `[data-decision-row][data-decision-author][data-verdict]`.
  - Outcome: `[data-decision-outcome][data-state="recorded|cancelled|error"][data-code]`.
  - Older version notice: `[data-decision-stale]`.
- **Required copy semantics:** the mock may reword, but must keep the meaning and use no em-dashes:
  - A decision is separate from comments.
  - Stale view: "You are viewing version N. Version M is the newest. A decision here applies to version N only."
  - TOFU: "The first passkey set up for an address becomes the only way to record decisions as that address. Adding another later needs this one."
  - Cancel: "Cancelled. Nothing was recorded."
  - Mismatch: "The file stored for version N is not the file this page shows. Nothing was recorded."
  - Unavailable: "Decisions open on this relic once its publisher republishes it."

### 4.9 Config (`config.ts`)

- `passkeyChallengeTtlSeconds: 300`
- `decisionRateLimit {30, 3600}`
- `decisionReadRateLimit {600, 3600}`
- `passkeyRateLimit {20, 3600}`

### 4.10 Disclosure text (verbatim in `service.md` §5 and in `disclosureStatement()`)

> **Decisions.** When a signed-in reader approves or rejects a version in the viewer, the service stores that decision in the clear: the verdict, the reader's verified email address, the version number, the SHA-256 of that version's ciphertext, the id of the passkey that confirmed it, and the time. Anyone holding the relic's link can read its decisions. Decisions are never edited or deleted, except that removing a relic removes its decisions with it.
> **Passkeys.** A decision must be confirmed with a passkey registered to the reader's verified address. The service stores the passkey's public key, its credential id, a signature counter, and when it was created and last used, under a hash of the address. The first passkey registered for an address is trusted on first use; adding another requires confirming with an existing one. The service never receives a private key.
> **Version digests.** To bind a decision to exact content, the service reads each version's ciphertext once and stores its SHA-256. It reads ciphertext only and holds no key.

### 4.11 File ownership (one writer per file)

| Slice | Files |
|---|---|
| S0 | `relic-format/src/{decision,passkey,index}.ts` |
| S1 | `relic-server/src/webauthn.ts`, `relic-server/test/{webauthn.test,fake-authenticator}.ts` |
| S2 | every other file under `relic-server/` |
| S3 | `relic-mcp/src/**`, `relic-mcp/{README.md,skills/**}`, MCP unit tests |
| S4 | `relic-viewer/**` |
| S5 | `docs/plans/decisions/mockup.html` |
| S6 | `relic-mcp/test/decision-*.ts`, `relic-mcp/PATH.md`, `.github/workflows/verify.yml` |
| S7 | `docs/**` (except the mock), root `README.md` |

## 5. Slices

All slices branch from `feat/decisions` after S0 is committed, and each runs `bun install --frozen-lockfile` first. No slice runs builds or tests mid-flight; the main agent verifies after integration.

- **S0: format contracts.** Files: as in the ownership table, plus `relic-format/test/decision.test.ts`.
- **S1: WebAuthn verifier.** Files: `webauthn.ts`, `fake-authenticator.ts`, `webauthn.test.ts`.
- **S2: server.** Files: `store.ts`, `gcsstore.ts`, `storage.ts`, `gcs.ts`, `problems.ts`, `config.ts`, `app.ts`, and tests.
- **S3: MCP.** Files: `publish.ts`, `republish.ts`, `server.ts`, `src/decisions.ts`, `comments.ts`, `README.md` tools table, `skills/relic/SKILL.md`, and unit tests.
- **S5: mock.** File: `docs/plans/decisions/mockup.html`.
- **S4: viewer.** Files: `viewer.ts`, `decisions.ts`, `decision-panel.ts`, `main.ts`, `styles.css`, tests.
- **S6: proofs.** Files: `relic-mcp/test/decision-path.ts`, `decision-live-probe.ts`, shared `decision-proof-steps.ts`, `relic-mcp/PATH.md`, `.github/workflows/verify.yml`.
- **S7: docs.** Files: `docs/spec/service.md`, `docs/spec/viewer.md`, `docs/spec/publish.md`, `docs/spec/format.md`, `docs/decisions.md`, `docs/frame.md`, `docs/plans/decisions/README.md`, root `README.md`.

## 6. Ship mechanics

1. Verify:
   - `mise exec node@18.20.8 -- mise run verify` and `mise exec node@24.15.0 -- mise run verify`
   - `packages/relic-viewer` build output under 460,800 bytes
   - local loopback decision proof passes
2. Merge and release:
   - PR to `TheBushidoCollective/relik` `main`
   - Merge on green
   - CI deploys Cloud Run and publishes `relic-mcp@0.14.0`
   - Prove deployed service against live probe

## 7. Proof outline

**Shared steps** (`decision-proof-steps.ts`):
- Drive relic-mcp over stdio.
- Publish v1, republish v2, republish v3. Record the v3 `version_digest`.
- Drive browser to review relic, sign in via magic link, register passkey (with UV), approve v3.
- Call `relic_read_decisions`: verify (a) returns approve, author, and v3 digest.
- Verify (b) publish token alone refused with `decision_requires_reader`.
- Republish v4. Verify (c) v4 has no decisions, v3 decision remains.
- Reject v4 via passkey. Verify (d) reject is recorded.
- Comment "GREENLIGHT". Verify (e) comment exists, no decision created.

## 8. Item 3 answer for backlot

Relic binds every decision to a passkey with user verification required. A magic link alone cannot record a decision, and no MCP tool can.

These gaps remain:
- **First use is trusted.** The first passkey registered for an address owns that address's decisions. An agent that can read Jason's mail and drive a browser could register first if Jason hasn't. Jason should register his passkey in the viewer once, before backlot depends on decisions. After that, adding a passkey requires an assertion from the existing one.
- **User verification is client-attested.** Authenticators with UV capability sign UV=1. An attacker with root on the approving machine can patch the browser or client to sign with a compromised software authenticator. Hardware keys mitigate this.

## 9. What would prove this spec wrong

- The headless browser lacks the CDP `WebAuthn` domain (fall back to headless Chrome with isolated profile).
- Safari refuses WebAuthn options fetched before user gesture (flow is structured to call credentials synchronously inside the confirm click handler).
- Backlot needs decisions on relics published before relic-mcp 0.11.0 (those relics get `decision_unavailable` until republished).
