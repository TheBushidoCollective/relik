# Passkey sign-in for returning readers

## 1. Goal

PATH sentence: "A reader who verified their email once and added a passkey can open a relic later, tap 'Sign in with passkey' (or pick the passkey from the email field's autofill), and post a comment without receiving any email."

When this is done, all of these hold:
- A passkey assertion mints exactly the `relic_session` a magic link mints.
- No mail is sent during a passkey sign-in.
- The comment reads back attributed to the reader's address.
- Decisions still need their own assertion.
- Email-first options and sign-in failures say nothing about whether an address or credential exists.

## 2. Corrections to the brief

1. **The session mint lives in `authCallback`, not `authSession`.** The mint is at `app.ts:3142-3164` (putSession, recordVerifiedIdentity, cookie string). `authSession` (`app.ts:3172-3180`) only reads.
2. **Passkey sessions would lock mixed-case readers out of their own comments.**
   - Link sessions carry the address exactly as typed: `authRequest` stores the raw `email` (`app.ts:3094`), and `resolveAuthor` returns `session.email` (`app.ts:3063`).
   - Edit and delete compare author strings exactly (`app.ts:2855`, `app.ts:2976`), and `author_relic` is keyed by a hash of the raw author (`gcsstore.ts:635-636`, `771`).
   - Passkey records keep only the normalized address (`app.ts:4155`, `4262-4266`).
   - Fix: `PasskeyRecord` gains `address` (the registering session's exact string), and passkey sessions mint with it.
3. **Sign-in must ship as a lazy chunk, and the WebAuthn helpers can't be borrowed.**
   - The decision sheet is a lazy chunk on purpose (`main.ts:8113-8115`) and imports types only (`decision-panel.ts:11-15`).
   - The shell has a hard cap (`deploy.yml:251-252` < 460,800 bytes; `shell-budget.test.ts:32`).
   - So sign-in must also be lazy, and the WebAuthn helpers move to a module only lazy chunks import. Importing them from `decision-panel.ts` would make every anonymous reader download the decision sheet. Importing them from the shell would break the budget.
4. **Only one WebAuthn ceremony can be pending per page, and none of the existing three passes a signal** (`decision-panel.ts:1602`, `1686`, `1780-1782`). An armed conditional request would make decision ceremonies fail with "request already pending". Every ceremony takes a page-wide abort signal.
5. **`frame.md:143` becomes false.** It ends "Passkeys serve this single deliberate act and do not create general accounts, logins, or permissions." It must be amended. It wasn't in the brief's doc list.
6. **The disclosure text is duplicated.** `service.md` §5 holds the passkey disclosure verbatim at `service.md:406`, next to `/policy` (`app.ts:5357`), and both must change. `service.md:37` lists the "recorded exceptions" to the no-401/403 rule but misses the decision and passkey codes. Add those and the new code.
7. **A plain email-first allow list is an address oracle.** Returning that address's credential ids reveals whether it has a passkey, so the list is padded with keyed decoys (§4.7).
8. **The offer signal can't be a query parameter.** Tests assert the callback `location` exactly (`app.test.ts:2779`, `2979`, `3014`), and `stripFragment` keeps `search` (`main.ts:9331-9336`). It's a one-shot cookie instead.
9. **No per-address preference record exists** (StorePasskeyMap scout found none). The only client store is `localStorage`, under `relic:*` keys (`main.ts:3563`, `3574`, `3652`; `vault.ts:30`).
10. **Existing proofs constrain the new UI.**
    - `decision-path` follows the magic link in the browser (`decision-proof-steps.ts:536-560`), so it will see the offer card.
    - The card must not reuse `[data-passkey-create]`, which that proof waits on (`decision-proof-steps.ts:566-570`).
    - It must not be a `form.compose`, which `comment-popover-path.ts:670` waits on.
    - The passkey button must be `type="button"`, because `typeAndSubmitSignIn` clicks `button[type="submit"]` (`decision-proof-steps.ts:362-364`).
11. **Per-open challenges don't pile up.** `m/challenge/` objects are deleted after 1 day (`deploy/terraform/modules/relic/locals.tf:36-39`, `resource.google_storage_bucket.relics.tf:22-30`). The per-IP limiter is the only constraint.
12. **Sign-in POSTs need a CSRF guard.** The app has no CORS and no Origin checks (grep: none). Existing cookie-authenticated POSTs rely on SameSite=Lax. A sign-in endpoint that *sets* a cookie needs its own guard against login CSRF (a text/plain form posting JSON-shaped bodies). Require `content-type: application/json`, which already has a precedent at `app.ts:1154-1157`.
13. **No relic-mcp release is needed.**
    - relic-mcp README, SKILL and INSTRUCTIONS stay true: links still verify an address, and decisions still need a passkey.
    - Server and viewer ship on merge (`deploy.yml:3-17`).
    - `ship-relic-change` requires a security review of the diff before merge.
14. **The live probe can't read mail.** It reads the magic link from stdin, pasted by an operator (`decision-live-probe.ts:99-113`); there is no Gmail or IMAP access.

## 3. Decisions taken here

1. **One page-wide ceremony controller** (`ceremonySignal()`): each new ceremony aborts the previous one. Rejected: aborting only on unmount, because stale requests leak across the three sign-in surfaces.
2. **User-handle index.**
   - GCS stores `m/passkey-handle/{sha256Hex(userHandle)}.json` → `{emailHash, createdAt}`. The store writes it inside `createPasskeys` and after every successful `updatePasskeys`, best effort (the pattern at `gcsstore.ts:615-629`).
   - Reads go through `getPasskeysByUserHandle`, which refuses a record whose `userHandle` differs from the index entry.
   - Records made before this change heal on their next decision, enroll or email-first sign-in.
   - Rejected: a backfill script. It would write to production outside CI, and the email-first fallback covers the gap for the handful of existing records.
   - Rejected: a scan on a missed lookup, which an attacker could turn into a GCS scan per request.
3. **New registrations use `residentKey: 'required'` plus `requireResidentKey: true`** (L1 browsers). Consequence: a U2F-only key can no longer register.
4. **One failure code.** Everything after the challenge is consumed is `401 passkey_sign_in_failed`, with no `passkey_check` extension. Only pre-store syntax errors stay `400 invalid_passkey`.
5. **Email-first decoys.**
   - Every email-first response has exactly `passkeySignInAllowListSize` descriptors: real ones first, padded with HMAC decoys, sorted by id, no transports. Repeat requests return the same list.
   - Rejected: an empty list for unknown addresses (that is the oracle).
   - Rejected: one fixed-shape decoy (real records differ in count and id length).
6. **The offer signal.**
   - `authCallback` adds `relic_passkey_offer=1` (not HttpOnly, 600 s). The landing page reads it and deletes it.
   - Dismissal is stored in `localStorage` under `relic:passkey-offer`.
   - Rejected: `authSession` fields. They add a store read to every first paint, and a one-shot flag needs a GET with side effects.
   - Rejected: server-side dismissal, which means a new endpoint and a new fact held about an address.
7. **"First magic-link sign-in" (decided by Jason, 2026-10-25): any magic-link sign-in until dismissed.**
   - `authCallback` sets the offer marker after every magic-link sign-in. The viewer shows the offer when the marker is present, the session is verified, and this browser has not dismissed it. For a new reader that is their first sign-in; readers verified before this ships see it once on their next sign-in.
   - When the reader already has a passkey elsewhere, the offer runs the existing enroll flow (assert, then add).
8. **The dashboard gets passkey sign-in too.** Its form is a separate copy (`main.ts:9253-9313`), and it's the remaining sign-in surface. After success it reloads.
9. **Session addresses.** A passkey session uses `record.address ?? record.email`. The response says `{email}` with that same string.

## 4. Shared contracts (verbatim)

### 4.1 Wire

**`POST /api/auth/passkeys/sign-in/options`**
- No session cookie is needed.
- The request must carry `content-type: application/json`.
- Body: `{}` (usernameless) or `{"email": "<string>"}` (email-first).
- 200 response:

```json
{"public_key":{"challenge":"<b64url 32B>","rpId":"<hostname of serviceOrigin>","timeout":300000,"userVerification":"required","allowCredentials":[]}}
```

- `timeout` is `config.passkeyChallengeTtlSeconds * 1000`.
- For email-first, `allowCredentials` is exactly `passkeySignInAllowListSize` entries of the form `{"type":"public-key","id":"<b64url>"}`, or more if the record holds more real credentials.

**`POST /api/auth/passkeys/sign-in`**
- Body: `{"credential": AuthenticationResponseJSON}`.
- 200 response: `{"email":"<session address>"}`, with `set-cookie: relic_session=<token>; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=<sessionTtlSeconds>`. The cookie string is the one `mintReaderSession` returns.

**Refusals on both routes**
- `429 passkey_rate_limited` with `retry_after_seconds`.
- `400 invalid_passkey` with `passkey_check: 'shape' | 'encoding'`, for syntax errors only.
- On the sign-in route, everything after the challenge is consumed is `401 passkey_sign_in_failed`.

**`GET /api/auth/callback` 303 (changed)**
- `location` is unchanged.
- Two `set-cookie` headers, in this order:
  1. The `relic_session` cookie as today.
  2. `relic_passkey_offer=1; Path=/; Secure; SameSite=Lax; Max-Age=<passkeyOfferMarkerSeconds>`.

**`/api/auth/session`** is unchanged.

### 4.2 Step 0: `packages/relic-format/src/passkey.ts`

The main agent commits this inline. Add `readonly requireResidentKey?: boolean;` to `CreationOptionsJSON.authenticatorSelection` (`passkey.ts:40-43`). Add a header line saying passkeys also sign readers in. Append:

```ts
/** `POST /api/auth/passkeys/sign-in/options` body. No address: usernameless. An address: email-first. */
export interface PasskeySignInOptionsRequestJSON { readonly email?: string; }
/** `POST /api/auth/passkeys/sign-in/options` 200 body. */
export interface PasskeySignInOptionsJSON { readonly public_key: RequestOptionsJSON; }
/** `POST /api/auth/passkeys/sign-in` body. */
export interface PasskeySignInRequestJSON { readonly credential: AuthenticationResponseJSON; }
/** `POST /api/auth/passkeys/sign-in` 200 body; the response also sets `relic_session`. */
export interface PasskeySignInResultJSON { readonly email: string; }
```

### 4.3 Problem code (`problems.ts:70-74`, `113-117`, `160-164`)

`'passkey_sign_in_failed'`: status `401`, title `'Passkey sign-in did not work'`.

### 4.4 Config (`config.ts:109-120` interface, `174-179` defaults, `190-228` assertConfig)

```ts
passkeySignInOptionsRateLimit: { limit: 240, windowSeconds: 3600 }, // same budget as mints: one per open plus refreshes
passkeySignInRateLimit: { limit: 30, windowSeconds: 3600 },
passkeySignInAllowListSize: 4,
passkeyDecoyIdLengths: [16, 20, 32, 64],
passkeyOfferMarkerSeconds: 600,
```

assertConfig checks:
- `passkeySignInAllowListSize` is an integer ≥ 1.
- `passkeyDecoyIdLengths` is non-empty, each an integer from 16 to 1023.
- `passkeyOfferMarkerSeconds` is an integer > 0.

Rate-limit keys: `` `passkey-sign-in-options ${ip}` `` and `` `passkey-sign-in ${ip}` ``. The `ip` is the one `handle()` derives (`app.ts:156`). Both keys are separate from the existing `` `passkey ${ip}` ``.

### 4.5 Store

**`store.ts:122-126`.** `PasskeyRecord` gains `readonly address?: string;` (the exact session address at TOFU creation; absent on older records). `postPasskey` sets `address: session.email` in the TOFU record (`app.ts:4262-4266`).

**`store.ts:128-138`.** `WebauthnChallengeRow`:
- `purpose` becomes `'register' | 'enroll' | 'decide' | 'sign_in'`.
- `email` becomes `readonly email?: string;`, documented as "the normalized address; absent only on a usernameless `sign_in` challenge".

**`RelicStore` additions (after `store.ts:489`):**

```ts
getPasskeysByUserHandle(userHandle: string): Promise<PasskeyRecord | undefined>;
passkeyDecoyKey(): Promise<Uint8Array>;
```

`createPasskeys` (on success) and `updatePasskeys` (after a successful write) maintain the handle index. Index failures are logged and swallowed.

**MemoryStore**
- New `passkeyHandles: Map<userHandle, normalizedEmail>`, set in `createPasskeys` (`store.ts:1043-1050`) and `updatePasskeys` (`1052-1077`).
- The read returns the record only if `record.userHandle === userHandle`.
- `passkeyDecoyKey` copies `unsubscribeKey` (`store.ts:662-669`).

**GCS**
- `key('passkey-handle', `${await sha256Hex(userHandle)}.json`)` holds `{ emailHash: sha256Hex(normalizeEmail(email)), createdAt }`, written with `put(...,'0')` after `gcsstore.ts:1046` succeeds and after the CAS put at `1076`.
- The read follows the index entry to `key('passkey', `${emailHash}.json`)` and checks `userHandle`.
- `passkeyDecoyKey` copies `unsubscribeKey` (`gcsstore.ts:943-971`) using `key('secret','passkey-decoy-key.json')`.

### 4.6 Server helpers (closures in `createApp`)

`mintReaderSession(email, now): Promise<string>`:
- Does exactly what `app.ts:3142-3149` does, and returns the cookie string from `app.ts:3156-3162`.
- `authCallback` uses it and appends the marker through `Headers.append`. Don't name the local `sessionCookie`, because `app.ts:5480` already uses that name.

`verifyStoredAssertion(record, credential, clientChallenge, now): Promise<{ok:true; credentialId:string} | {ok:false; code:'invalid_passkey'|'passkey_verification_failed'; check:string}>`:
- It is the existing block lifted verbatim: credId check, credential find, `verifyAssertion` with `userHandle: record.userHandle`, WebauthnError mapping, then the counter CAS that sets `lastUsedAt`.
- `postDecision` (`app.ts:3625-3691`, then `cred.credentialId` at `3714`) and enroll (`app.ts:3960-4023`, then `4034`) switch to it, with byte-identical refusals.

`postPasskeySignInOptions` checks, in order:
1. Limiter.
2. content-type.
3. `readBoundedJson(request,'invalid_passkey')`: an absent body means `{}`; a non-object, or an `email` that isn't a string, is 400 shape.
4. Create the challenge.
5. `putWebauthnChallenge({challengeHash, purpose:'sign_in', expiresAt, ...(email ? {email: normalizeEmail(email)} : {})})`.
6. Respond. Email-first computes `signInAllowList(norm)`.

`postPasskeySignIn` checks, in order:
1. Limiter.
2. content-type.
3. Body and credential object.
4. `extractClientDataChallenge` (`app.ts:3350-3393`).
5. `consumeWebauthnChallenge`; it must be `purpose === 'sign_in'` and not expired.
6. Find the record: by `row.email` with `getPasskeys`, or by `credential.response.userHandle` matching `/^[A-Za-z0-9_-]{1,86}$/` with `getPasskeysByUserHandle`.
7. `verifyStoredAssertion`.
8. `mintReaderSession(record.address ?? record.email, now)`.
9. 200 `{email}` with `set-cookie`.

Any failure in steps 5 to 7 is `401 passkey_sign_in_failed` and mints nothing. There's no kill-switch check, matching `authRequest`.

Router: in `app.ts:532-544`, add `third==='sign-in' && fourth===undefined` and `third==='sign-in' && fourth==='options' && rest[4]===undefined`, both POST. Anything else falls through to the existing 405.

`postPasskeyOptions`: change `residentKey: 'preferred'` to `residentKey: 'required', requireResidentKey: true` at `app.ts:4056` and `4103`.

### 4.7 Decoys

`signInAllowList(norm)`:
1. Load `getPasskeys(norm)` and `passkeyDecoyKey()` in parallel.
2. Always compute `size` decoys.
3. Take the real descriptors `{type,id}` with no transports, and pad them with decoys up to `size`.
4. Sort by `id`.

Decoy `i`:
- Its length is `passkeyDecoyIdLengths[hmacSha256(key,`relic-passkey-decoy:v1:length:${norm}:${i}`)[0] % n]`.
- Its bytes are the concatenation of `hmacSha256(key,`relic-passkey-decoy:v1:id:${norm}:${i}:${j}`)` for j = 0, 1, …, cut to that length, encoded base64url.

`hmacSha256` is at `app.ts:4621`.

### 4.8 Viewer modules

**New `packages/relic-viewer/src/passkey-common.ts`** (imported only by lazy chunks):
- Code moved verbatim from `decision-panel.ts`:
  - wire conversion: lines 35-225
  - `ICON_KEY`: 251-252
  - `CredentialsLike`: 267-271
  - `el`, `glyph`, `pressable`, `plain`: 376-418
  - `parseDescriptors`, `parseRequestOptions`, `parseCreationOptions`: 526-620 (`parseCreationOptions` now passes `requireResidentKey` through)
  - `ceremonyCode`: 645-655
- `creationOptionsFromJSON` passes `requireResidentKey` through.
- Plus:

```ts
const CEREMONY_ABORTED = 'A newer passkey request replaced this one';
let current: AbortController | undefined;
export function ceremonySignal(): AbortSignal {
  current?.abort(new DOMException(CEREMONY_ABORTED, 'AbortError'));
  current = new AbortController();
  return current.signal;
}
```

- `decision-panel.ts` imports from it, adds `signal: ceremonySignal()` to its three calls, and rewrites the header comment at 11-15.
- Tests import from `passkey-common.ts`. No re-exports.

**New `packages/relic-viewer/src/passkey-sign-in.ts`.** Runtime imports come only from `passkey-common.ts`; everything else is types.

```ts
export interface PasskeySignInMount {
  readonly host: HTMLElement; readonly email: HTMLInputElement; readonly outcome: HTMLElement;
  readonly deps: Pick<ViewerDeps, 'serviceOrigin' | 'fetch'>;
  readonly credentials?: CredentialsLike; readonly conditionalAvailable?: () => Promise<boolean>;
  readonly onSignedIn: (email: string) => void;
}
export function mountPasskeySignIn(mount: PasskeySignInMount): void;
export interface PasskeyOfferMount {
  readonly host: HTMLElement; readonly deps: Pick<ViewerDeps, 'serviceOrigin' | 'fetch'>;
  readonly credentials?: CredentialsLike; readonly store: Pick<Storage, 'getItem' | 'setItem'> | undefined;
  readonly onDone: () => void;
}
export function mountPasskeyOffer(mount: PasskeyOfferMount): void;
```

Controller (a module singleton):
- **Arm** while connected mounts exist and the page is visible: fetch usernameless options; if conditional mediation is available, start `get({mediation:'conditional', publicKey, signal: ceremonySignal()})`.
- **Refresh** at `fetchedAt + timeout − 30 s`, only while visible.
- **Press:** if the options are fresh, call `ceremonySignal()` and a modal `get` synchronously inside the click. If they're stale, show PREPARING and re-arm.
- **AbortError** when our own signal aborted: say nothing.
- **A `relic:auth` message:** abort and pause.
- **On 200:** `onSignedIn(email)`.
- **On 401:** show FAILED, reveal the fallback, re-arm.
- **Fallback:** an empty field shows EMAIL_FIRST_EMPTY. With an address, fetch `{email}` options and show the confirm button; the confirm press runs `get` synchronously.

Offer:
- On mount, prefetch `POST /api/auth/passkeys/options {}`. Refresh it before the timeout, so a late press can't orphan a credential.
- `mode:'create'`: the TOFU create inside the press, then `POST /api/auth/passkeys`.
- `mode:'assert'`: get inside the press, then `POST options {credential}`, which returns create mode for the second press.
- `passkey_assertion_required` or `passkey_required`: refetch.
- InvalidStateError: state `exists`.
- Session refusals: `onDone()`.
- On success, or `exists`, store `created`. "Not now" stores `dismissed`.

**Shell glue (`main.ts`, `comments.ts`)**

`signInForm` (`main.ts:3249-3314`):
- `email.autocomplete = 'username webauthn'`.
- Append `div.passkey-sign-in[data-passkey-sign-in-host]` after the send button.
- When `typeof PublicKeyCredential === 'function'` and the context is secure, run `void import('./passkey-sign-in.ts')` and mount, with `onSignedIn: () => { announceVerified(); options.onSignedIn?.(); }`.
- New optional `onSignedIn`: `composeIdentity` passes `recheck`; `paintSignIn` passes the share recheck.

`announceVerified()`: extracted from `main.ts:7158-7167` and used in both places.

`takePasskeyOfferMarker(doc = globalThis.document): boolean` in `comments.ts`: returns true at most once per document, and deletes the cookie.

`buildThread` initialise (`main.ts:7152-7157`):
- If the marker is present, the session is verified, and `preferenceStore()?.getItem('relic:passkey-offer') === null`, mount the offer into a host.
- `paintComposer` (`main.ts:7101-7107`) renders that host before `composeComment` until `onDone`.

Dashboard (`main.ts:9253-9313`): set autocomplete, add a host after `sendBtn` with `onSignedIn: () => location.reload()`, and mount the offer at the top of the signed-in section.

### 4.9 DOM hooks

The host is `div.passkey-sign-in[data-passkey-sign-in-host][data-state="preparing|ready|working|failed|email-first|rate-limited|unavailable"]`. It contains, in order:
1. `p.passkey-or` reading "or".
2. `button.action.passkey-button[data-passkey-sign-in][type=button]` (key glyph + label).
3. `div.passkey-fallback[data-passkey-fallback][hidden]`, holding `span.passkey-fallback-lead` and `button.passkey-link[data-passkey-email-first]`.
4. `button.action.passkey-button[data-passkey-email-first-confirm][hidden]`.

The offer is `section.passkey-offer[data-passkey-offer][data-state="loading|ready|assert|working|created|exists|cancelled|error"]`. It contains `h3.passkey-offer-title`, `p.passkey-offer-body`, `p.passkey-offer-fine`, a primary `button.action.primary[data-passkey-offer-create][type=button]`, and `button.passkey-link[data-passkey-offer-dismiss][type=button]`.

Messages go to the form's existing outcome region. Neither the host nor the card ever uses `[data-passkey-create]`, `form.compose`, or `.popover-*`.

### 4.10 Copy (verbatim)

**Sign-in**

| Key | Text |
|---|---|
| Button | "Sign in with passkey" |
| Working | "Waiting for your passkey" |
| PREPARING | "Getting your passkey ready. Press again in a moment." |
| FAILED | "That passkey did not sign you in. Try again, or send yourself a link." |
| Cancelled | "No passkey was used." |
| Fallback lead | "Passkey not offered?" |
| Fallback button | "Use a passkey for this address" |
| EMAIL_FIRST_EMPTY | "Type your address above, then press this again." |
| Confirm | "Confirm with your passkey" |
| Rate limited | "Too many passkey attempts from this network. Wait a few minutes, or send yourself a link." |
| Unreachable | "Relic could not be reached. Try again." |
| Success | "Signed in with your passkey. No email was sent." |

**Offer**

| Key | Text |
|---|---|
| Title | "Skip the email next time" |
| Body | "Add a passkey and this device signs you in without a link." |
| Fine | "Your first passkey also confirms decisions, and adding one on another device later asks for it." |
| Create | "Add a passkey" |
| Not now | "Not now" |
| Assert body | "You already have a passkey on another device. Confirm with it, then add one here." |
| Assert button | "Confirm with your passkey" |
| Second step | "Add a passkey on this device" |
| Working | "Waiting for your passkey" |
| Created | "Passkey added. Next time, choose Sign in with passkey." |
| Exists | "This device already has your passkey. Next time, choose Sign in with passkey." |
| Cancelled | "No passkey was added." |
| Error | "Relic could not set up a passkey just now. You can add one the next time you sign in with a link." |
| After created/exists | "Close" |

`DELIVERY_DISCLOSURE` (`comments.ts:194-196`) stays as is. It's about mail and is still true.

### 4.11 Client keys

- Cookie `relic_passkey_offer`, value `1`.
- `localStorage['relic:passkey-offer']` ∈ `'dismissed' | 'created'`. Any value suppresses the offer.

### 4.12 Disclosure (the same text in `disclosureStatement` and `service.md:406`)

> **Passkeys.** A passkey is registered to a reader's verified address. It confirms decisions, and it can sign that reader in instead of a link. The service keeps one record per address, filed under a hash of the address: the address itself, the random user handle its passkeys carry, and for each passkey its public key, credential id, signature counter, and when it was created and last used. A second entry, filed under a hash of the user handle, points to that record, so a passkey can sign you in without your typing the address. The first passkey registered for an address is trusted on first use; adding another requires confirming with an existing one. Signing in with a passkey sends no email, updates that passkey's counter and last-used time, and starts the same session a link does. If you type your address to use a passkey, the service answers the same way whether or not that address has one. The service never receives a private key.

Also append to the comments paragraph (`app.ts:5317-5320`, only there): "A reader who added a passkey can later sign in to the same address with it, and that sends no email."

### 4.13 File ownership (one writer per file)

| Slice | Files |
|---|---|
| S0 (main agent, inline) | `docs/plans/passkey-sign-in/README.md` (this spec), `relic-format/src/passkey.ts` |
| S1 | `relic-server/src/{config,problems,store,gcsstore,app}.ts`; `relic-server/test/{passkey-sign-in.test.ts (new), gcsstore.test.ts, app.test.ts}` |
| S2 | `relic-viewer/src/{passkey-common.ts, passkey-sign-in.ts (new), decision-panel.ts, main.ts, comments.ts}`; `relic-viewer/test/{passkey-sign-in.test.ts (new), decisions.test.ts, shell-budget.test.ts}` |
| S3 | `docs/plans/passkey-sign-in/mockup.html`, `relic-viewer/src/styles.css` (one new block) |
| S4 | `docs/spec/service.md`, `docs/spec/viewer.md`, `docs/frame.md`, `docs/decisions.md`, `README.md` |
| S5 | `relic-mcp/test/{passkey-sign-in-steps,passkey-sign-in-path,passkey-sign-in-live-probe}.ts`, `relic-mcp/PATH.md`, `PATH.md`, `.github/workflows/verify.yml` |

## 5. Slices

All slices branch from the S0 commit on `feat/passkey-commenting` in isolated worktrees, and run `bun install --frozen-lockfile`. No slice builds or tests mid-flight, except S3 looking at its own mock. S1 to S5 run in parallel.

**S1: server (mechanical, hi).**
- Change: everything in §4.1, §4.3 to §4.7, and §4.12 for `app.ts`.
- Non-goals: the comment, publish-token and MCP paths; the decision protocol (refusals byte-identical); `authSession`.
- Tests, all behavioral:
  1. A passkey added after a link sign-in signs the reader in with zero mail, and the cookie comments as them.
  2. The session row and cookie match the callback's, and the verified identity is recorded.
  3. Usernameless options carry no address. Email-first known and unknown responses match in status, keys, count, order and stability, with the real id present only for the known address.
  4. A table of failures all give an identical 401 with no extension and no cookie: replay, expiry, `decide`/`enroll`/`register` challenges, unknown handle, null handle, handle naming another record, credential not on record, bad signature, UV off, counter replay.
  5. A `sign_in` challenge can't decide or enroll.
  6. A passkey session deciding without a credential gets `400 invalid_passkey`.
  7. text/plain gets 400.
  8. The limits are independent; TOFU still works once the options budget is spent.
  9. Both create responses require a resident key.
  10. A reader signed in as `Ada@Example.com` signs in by passkey as `Ada@Example.com` and can PATCH and DELETE their earlier comment.
  11. A non-discoverable assertion (`userHandleOverride: null`) signs in by email-first.
  12. The callback sends the session cookie first and the marker second, the marker not HttpOnly; passkey sign-in sends no marker.
  13. `/policy` contains the new sentences.
  - GCS, in `gcsstore.test.ts`, using the `fakeGcs` helper at `gcsstore.test.ts:20-147`:
    14. Index written on create.
    15. A seeded legacy record heals on update.
    16. A stale index entry resolves to nothing.
    17. An index write that returns 500 doesn't fail the create.
    18. The decoy key is created once under contention.
- Acceptance: `bun test packages/relic-server` is green, with `decisions.test.ts` passing unmodified.

**S2: viewer (mechanical, hi).**
- Change: §4.8 and §4.9 structure (not CSS), and §4.10.
- Non-goals: `styles.css`; decision behavior; the homepage.
- Tests, using DOM stubs copied from `decisions.test.ts:40-152` with injected `credentials`, `fetch`, `conditionalAvailable` and a clock:
  1. The autofill attribute.
  2. One conditional request against `{}` options, with no fragment and no address on the wire.
  3. A press aborts the conditional request, then a modal get starts during the click with no fetch in between.
  4. The POST body has exactly one key, `credential`, and `onSignedIn` gets the email.
  5. A 401 shows FAILED, reveals the fallback, and re-arms.
  6. The fallback: empty-field copy; `{email}` options; get inside the confirm press with the response's allow list.
  7. Options refresh before the timeout, and only while visible.
  8. A `relic:auth` message aborts and stops fetching.
  9. An aborted conditional request is silent.
  10. The offer marker is consumed once.
  11. "Not now" stores `dismissed`.
  12. Create happens inside the press and stores `created`.
  13. The assert-then-add path.
  14. InvalidStateError gives `exists`.
  - Decisions test: decision ceremonies abort an earlier `ceremonySignal()`.
  - Shell budget: `viewer.js` has none of `isConditionalMediationAvailable`, `authenticatorData`, or the `CEREMONY_ABORTED` text. Exactly one chunk contains `CEREMONY_ABORTED`, and some chunk contains "Sign in with passkey".
- Acceptance: `bun test packages/relic-viewer` is green, and `shell-budget.test.ts` passes under its 450 KB ceiling.

**S3: mock and styles (designer agent).**
- Change: `docs/plans/passkey-sign-in/mockup.html`, self-contained (inline CSS, JS and SVG), clickable, light and dark.
  - Copy the tokens from `styles.css:14-56` and the patterns from `.compose` (`3289-3414`), `.action.primary` (`705-716`) and `.decision-signin` (`5659-5675`).
  - Use the key glyph from `decision-panel.ts:251-252`, the DOM from §4.9, and the copy from §4.10, all verbatim. Copy problems go in the result, not into a changed contract.
- States:
  1. Signed out, with the browser's passkey autofill drawn under the field and labeled as browser UI.
  2. Working.
  3. Failed with the fallback showing.
  4. Email-first confirm.
  5. Link sent.
  6. Offer: ready, assert, working, created, exists.
  7. Signed-in composer ("Commenting as …").
  8. A state rail for jumping straight to any state.
- Then add a single `/* passkey sign-in */` block to `styles.css` styling exactly the §4.9 classes, with the same CSS as the mock.
- Look at it in an isolated headless browser at 1440×900 and 390×844, in both color schemes.
- Non-goal: any other CSS.
- Acceptance: the mock opens offline, every state is reachable by clicking, and there's no external request or emoji.

**S4: docs (mechanical, med).**
- `service.md`:
  - :37 adds the recorded exceptions for §1.14/§1.15 and `401 passkey_sign_in_failed`.
  - §1.15 (264-281) gets the purpose line, the new table row, both limits and the content-type rule.
  - §5:406 gets the §4.12 text.
  - §8:454-458 adds passkey sign-in and the marker.
  - §9.2 (486-523) adds routes 6 and 7.
  - §9.3 (525-533) gets resident key required.
  - §9.4 (534-541) adds the handle index, the decoy secret and the `sign_in` purpose.
- `viewer.md`:
  - New §6.10 "Passkey sign-in and the offer after a link" covering the controller, abort rule, fallback and offer.
  - :546, :557 and :527 change "magic link" to "sign in (link or passkey)".
- `frame.md:143`: amend it to "stands behind two acts", dated 2026-10-25, keeping "no accounts beyond the verified address, no permissions" and "every decision still needs its own confirmation".
- `decisions.md`: add `## 2026-10-25: A passkey signs a returning reader in, without an email`, covering §3 and §8, in the `863-894` style.
- Root `README.md`: one sentence near 155-176.
- relic-mcp README and SKILL: no change (still true).
- Acceptance: every claim matches §4; no em-dashes.

**S5: proofs (mechanical, hi).** Reuse `callMcp`, `launchProofBrowser` and `discoverChrome` (`decision-proof-steps.ts:86-94`, `157-407`). Follow the `decision-path.ts:52-145` structure. New steps module `runPasskeySignInSequence(options)`.

| Step | Action | Prints |
|---|---|---|
| 1 | Publish (`title:''`, `cover:false`, `ttl_days:1`) | `PASSKEY_STEP_1_PUBLISH_OK relic_id=<id>` |
| 2 | Install a `Page.addScriptToEvaluateOnNewDocument` wrapper recording `credentials.get` calls `{mediation, aborted}`. Open the relic anonymously; assert autocomplete and `[data-passkey-sign-in]` | `PASSKEY_STEP_2_ANON_SURFACE_OK conditional=<armed\|unavailable>` |
| 3 | Type the address into `#comment-thread form.compose`, submit, resolve the link, navigate; assert `[data-passkey-offer]` and that the marker is gone | `PASSKEY_STEP_3_MAGIC_LINK_OK offer=shown` |
| 4 | Click `[data-passkey-offer-create]` and wait for `data-state="created"`. `WebAuthn.getCredentials` shows 1 resident credential; convert its base64 to base64url. On loopback, `store.getPasskeysByUserHandle` resolves it | `PASSKEY_STEP_4_ENROLL_OK resident=true` |
| 5 | `Network.deleteCookies({name:'relic_session', url})` on the owned browser, reopen the URL with its fragment; `/api/auth/session` gives `email:null` | `PASSKEY_STEP_5_SIGNED_OUT_OK` |
| 6 | Click `[data-passkey-sign-in]`; "Commenting as <addr>" shows; mail count unchanged; the conditional request was aborted if it was armed | `PASSKEY_STEP_6_SIGN_IN_OK mails_sent=0` |
| 7 | Post through `textarea.compose-textarea` and "Post comment"; `relic_read_comments {relic_id, version:'*'}` returns the author and body | `PASSKEY_STEP_7_COMMENT_OK author=<addr>` |
| Negatives | Replay the captured sign-in POST (via `Network.requestWillBeSent`, as at `decision-proof-steps.ts:259-285`) gives 401; text/plain gives 400; email-first for an unknown address and the reader's address have the same shape and count; a decision POST without a credential gives 400 | `PASSKEY_NEG_OK replay=401 wrong_content_type=400 email_first_shape=equal decision_without_assertion=400` |
| End | | `PASSKEY_SIGN_IN_PATH_OK` |

- Live probe: same steps, mirroring `decision-live-probe.ts:26-133`.
  - Mailbox from `RELIC_PASSKEY_PROBE_MAILBOX`, tagged `<local>+relic-passkey-<runId>@<domain>`; it refuses to run without the tag.
  - Client from `RELIC_PASSKEY_PROBE_CLIENT`, default `npx:0.14.0` (current `latest`).
  - Prints `PROBE_AWAIT_MAGIC_LINK` and reads the link from stdin.
  - No store-level checks.
  - Ends `PASSKEY_SIGN_IN_LIVE_OK relic=<id> client=relic-mcp@<v>`.
- `verify.yml`: add a step after `105`: `- name: Passkey sign-in path` / `run: RELIC_CHROME_PATH="$(command -v google-chrome)" bun packages/relic-mcp/test/passkey-sign-in-path.ts`.
- PATH.md: a root section with the PATH sentence and commands, and a `relic-mcp/PATH.md` section modeled on `425-494`.
- Acceptance: the scripts typecheck against the contract. Running them happens at integration.

## 6. Verify, merge, deploy (integration owner)

1. Merge S1 to S5 into `feat/passkey-commenting` and run `bun install --frozen-lockfile`.
2. Run `mise exec node@18.20.8 -- mise run verify` and `mise exec node@24.15.0 -- mise run verify`. The verify task is lint, typecheck, then test = build + `bun test` (`package.json:9-14`, `mise.toml:48-50`).
3. Run `bun run --cwd packages/relic-mcp build`, then the CI paths from `verify.yml:92-168`:
   - cover, notify, comment-popover, decision (must still print `DECISION_PATH_OK`), passkey-sign-in, copy-link, otio-path, load-progress.
4. Prove the UI: isolated headless screenshots of the real page in every §4.9 state, compared with the mock.
5. Have a `security-reviewer` subagent review the diff, as `ship-relic-change` requires.
6. Open one PR. Wait for the `verify` workflow (jobs `verify`, `otio-headless-smoke-macos`, `image`) to go green. Merge with `gh pr merge --merge`.
7. The `deploy` workflow runs on push to main (jobs `verify`, `deploy`; WIF, digest-pinned image, `terraform apply`, live smoke at `deploy.yml:200-331`). Watch it with `gh run list --workflow deploy --branch main`.
8. Prove it is live:
   - Build the viewer from the merge commit in a clean worktree and byte-compare every `https://relik.link/assets/<name>`.
   - Grep the shell for `relic_passkey_offer` and a chunk for "Sign in with passkey".
   - Check the routes: `curl -sX POST -H 'content-type: application/json' -d '{}' https://relik.link/api/auth/passkeys/sign-in/options` gives `allowCredentials: []`; `-d '{"email":"nobody+probe@example.invalid"}'` gives 4 descriptors; text/plain gives 400.
   - Run the live probe, pasting the link from the tagged mailbox, until it prints `PASSKEY_SIGN_IN_LIVE_OK`.
9. No `publish-mcp` dispatch is needed.

## 7. Residuals (go in decisions.md)

- **A passkey outlives loss of the mailbox, and nothing can remove one.** Whoever registered the first passkey for an address can sign in as it without the mailbox. There is no route to remove a passkey.
- **Decoys leak in a few cases.** Records holding more than 4 credentials, or ids of unusual lengths, are distinguishable. A sub-millisecond timing gap exists under a 30-per-hour limit.
- **Some old records stay as they are.** Mixed-case records created before this change mint with the normalized address, and existing passkeys need one email-first sign-in or decision before usernameless sign-in works.
- **Proof gaps.** Headless Chrome can't pick from autofill, so the proof exercises the button path and only observes the conditional lifecycle. A U2F-only key can no longer register.
- **The decision panel's create step can still orphan a credential.** Its prefetched options can expire if the reader waits past the timeout, and the device keeps a credential the server never stored. This predates the change and isn't fixed here.

## 8. What would prove this spec wrong

- Bun duplicates `passkey-common.ts` into both chunks, or hoists it into `viewer.js`. The new `shell-budget` assertions catch either.
- Safari rejects a modal `get` issued immediately after `abort()`. That needs a real-device check outside CI.
- The CDP virtual authenticator doesn't return a resident credential for an empty allow list, so step 6 fails.
- `decision-path` or `comment-popover-path` regresses on the new sidebar card, or on the extra anonymous fetches.
- Production holds passkey records without `userHandle`, or with handles that aren't 43-character base64url.