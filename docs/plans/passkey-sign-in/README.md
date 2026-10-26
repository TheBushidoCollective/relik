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
| Body | "Add a passkey for <address> and this device signs you in without a link." |
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
| 5 | Report conditional mediation unavailable (the CDP virtual authenticator answers an autofill request by itself), `Network.deleteCookies({name:'relic_session', url})`, reopen the URL with its fragment via `about:blank`; `/api/auth/session` gives `email:null`; no conditional request armed | `PASSKEY_STEP_5_SIGNED_OUT_OK` |
| 6 | Click `[data-passkey-sign-in]`; "Commenting as <addr>" shows; a sign-in POST was made; mail count unchanged | `PASSKEY_STEP_6_SIGN_IN_OK mails_sent=0` |
| 6b | Conditional mediation available again; sign out and reopen; the autofill request alone signs the reader in; mail count unchanged | `PASSKEY_STEP_6B_AUTOFILL_OK mails_sent=0` |
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
- **Decoys leak in a few cases.** Records holding more than 4 credentials, ids of unusual lengths, or structured authenticator ids (such as UUIDv4 ids with fixed version and variant bits) are distinguishable from decoys. Polling the email-first allow list over time reveals when a passkey is registered because a real id replaces a decoy. The decoy key stored at `m/secret/passkey-decoy-key.json` must never rotate, as rotation would change all decoys at once while real ids remain unchanged, exposing every real id. A sub-millisecond timing gap exists, bounded per IP per instance plus the per-address limit (30 sign-in requests per hour).
- **Some old records stay as they are.** Mixed-case records created before this change mint with the normalized address, and existing passkeys need one email-first sign-in or decision before usernameless sign-in works.
- **Proof gaps.** The CDP virtual authenticator answers an autofill request by itself, so the proof drives both paths (the button with conditional mediation reported unavailable, then autofill with it available) but never sees the browser's own autofill picker. A U2F-only key can no longer register.
- **The decision panel's create step can still orphan a credential.** Its prefetched options can expire if the reader waits past the timeout, and the device keeps a credential the server never stored. This predates the change and isn't fixed here.

## 8. What would prove this spec wrong

- Bun duplicates `passkey-common.ts` into both chunks, or hoists it into `viewer.js`. The new `shell-budget` assertions catch either.
- Safari rejects a modal `get` issued immediately after `abort()`. That needs a real-device check outside CI.
- The CDP virtual authenticator doesn't return a resident credential for an empty allow list, so step 6 fails.
- `decision-path` or `comment-popover-path` regresses on the new sidebar card, or on the extra anonymous fetches.
- Production holds passkey records without `userHandle`, or with handles that aren't 43-character base64url.
## 9. Addendum (2026-10-25): a first passkey needs a fresh link, and every added passkey is announced

### 9.1 Goal

All of these must be observably true when this is done:

- A first passkey can only be started by a session that a sign-in link minted no more than `passkeyFreshLinkSeconds` (900) ago.
- A session minted by a passkey never qualifies.
- Every passkey that gets stored, whether first or added later, sends exactly one email to the address.
- A mail failure leaves the passkey stored and the `201` unchanged.
- When the server refuses, the offer card and the decision panel both say why, keep the session, and offer one button that emails a new link.
- No device ever holds a credential that the server refused.

### 9.2 Facts the brief rests on, checked, and two it missed

1. **Only two places mint a session.**
   - The link callback: `app.ts:3181`.
   - Passkey sign-in: `app.ts:4638`.
   - Both go through `mintReaderSession` (`3149-3170`). It writes `createdAt: now` (`3157`), which is the mint time.
2. **Both stores keep the session row whole.**
   - Memory: `store.ts:971-978`.
   - GCS: `gcsstore.ts:798-814`, which writes the row as JSON to `m/session/<hash>.json`.
   - So a new optional field needs no store code.
3. **The first-passkey challenge has exactly one source.** It is the options branch at `app.ts:4088-4127`, which writes `purpose:'register'` without `assertedBy` at `4099-4105`. The register route consumes it at `4224-4235` and creates the record at `4264-4302`. The enroll path is `3990-4086`, then the add at `4304-4355`.
4. **Missed: the offer card closes itself on any 401.** In `fetchOptions` at `passkey-sign-in.ts:743-746`, `res.status === 401` calls `onDone()`, and the card disappears. The new code has to be checked before that test.
5. **Missed: a signed-in reader has no way to send a link from either surface.**
   - `PasskeyOfferMount` (`passkey-sign-in.ts:658-665`) has `email?` but no relic id or return path.
   - The decision panel only mounts the shell's form when the session lapses (`decision-panel.ts:558-582`).
   - The link copy lives in the shell (`main.ts:3327-3341`), and so does the key-at-risk check (`comments.ts:543-555`).
   - So the shell has to supply a callback.
6. **The notice must use `sendMail` only.**
   - `send` is the sign-in link channel: `resendMailer` wraps its argument in `signInMail` (`mail.ts:538-541`).
   - The two passkey test mailers implement only `send` (`passkey-sign-in.test.ts:54-58`, `decisions.test.ts:55-59`).
   - `fanOutNotifications` falls back to `send(address, mail.text)` (`app.ts:1926-1971`). The notice must not copy that.
7. **The repo offers a reader no remedy.**
   - No route removes a passkey or ends a session (grep for `DELETE`, sign-out and revoke found none; `decisions.md:936`).
   - There is no support address and no reply-to (`mail.ts:458-466`).
   - `/abuse` is "Report a relic". It requires a relic id (`app.ts:5469-5496`, `2572-2617`).
8. **The existing proofs stay valid.**
   - Both follow a link and register within the same second (`passkey-sign-in-steps.ts:256-352`, `decision-proof-steps.ts:536-580`).
   - Mail is only counted as a delta per step (`passkey-sign-in-steps.ts:417-437`, `446-470`).
   - `resolveMagicLink` returns the first mail to an address (`passkey-sign-in-path.ts:118-121`, `decision-path.ts:118-121`), so any new negative uses a fresh address.
9. **A doc comment is attached to the wrong function.** The comment at `app.ts:3141-3148`, "Follow the link: spend the token…", sits on `mintReaderSession` but describes `authCallback`.

### 9.3 Decisions

1. **Provenance.**
   - `SessionRow` gains `via?: 'link' | 'passkey'`, and `mintReaderSession` always writes it.
   - An absent value counts as `'link'`, because every row written before passkey sign-in came from a link.
   - Any other value counts as not a link, so a damaged row fails closed.
   - This must ship in the same merge as passkey sign-in (PR #130). Otherwise passkey sessions without `via` would read as links.
2. **The window is `passkeyFreshLinkSeconds: 900`.** Three numbers line up on 900:
   - It equals `authLinkTtlSeconds` (`config.ts:188`), so a mailbox proof is good for 15 minutes before and after the link is followed.
   - It equals the offer marker (600, `config.ts:200`) plus one challenge (300, `config.ts:190`). The card only mounts while the marker is alive, and its first prefetched challenge stays valid for its full 300 s, so a card mounted from a live marker is never refused at mount.
   - For the decision panel: a reader who signs in and decides within 15 minutes never sees the refusal. Others see it once per address, ever, because it applies only to the first passkey.
   - Rejected: 3600 and 86400. They remove that one-time cost by widening the window in which a stolen cookie works.
   - `assertConfig` requires a whole number of minutes, because the disclosure renders minutes. It also requires the value to be at least `passkeyOfferMarkerSeconds`.
3. **The refusal is `401 passkey_fresh_link_required`, titled "Adding a first passkey needs a fresh sign-in link", with no extension members.**
   - 401 because the remedy is signing in again. That matches `sign_in_required` and the step-up convention.
   - Rejected: 409 (nothing about the address conflicts) and 403.
   - **Address-oracle invariant:**
     - It is emitted only on the session-authenticated options route.
     - It comes after the rate limiter and the body parse.
     - It comes only in the no-passkey branch, after the same `getPasskeys` read that already picks `mode`. So it tells the holder of that address's own session nothing that `mode: create`/`assert` didn't.
     - The body is the same bytes, apart from `instance`, for a stale link session and a passkey session.
     - It never names the address, the session's age, or the provenance.
   - The sign-in routes, `/api/auth/request` (always 202) and `/api/auth/session` are untouched.
4. **Where the check sits.** It goes in one place: the first statement inside `if (passkeyRecord === undefined || passkeyRecord.credentials.length === 0)` at `app.ts:4089`, before any user handle or challenge exists.
   - Both callers reach it: the offer card (sign-in convenience) and the decision panel (decisions).
   - `POST /api/auth/passkeys` does not check again:
     - Its only first-passkey input is that branch's challenge, which is single use, bound to the address and valid for 300 s.
     - Checking again would refuse readers whose window closed mid-ceremony, after their authenticator had already stored a discoverable credential. That creates an orphan.
     - So the effective bound is W + `passkeyChallengeTtlSeconds`, and the disclosure says "begin adding".
   - **Enroll is exempt.** The assertion from an existing passkey happens inside the same ceremony and is stronger than any link. Requiring a link there would break adding a local passkey on a laptop signed in through a phone passkey.
5. **The notice.**
   - **When:** it is sent after `createPasskeys` succeeds (`app.ts:4287-4290`) and after `updatePasskeys` returns a record (`4337-4339`), before each `201`.
   - **To:** `session.email`.
   - **How:** it is awaited inside try/catch, the same pattern as comment notifications (`app.ts:2776-2788`), because Cloud Run starves work after the response is sent.
   - **No stop link and no `List-Unsubscribe`**, following `signInMail` (`mail.ts:63-84`):
     - stop records are per relic (`isOptedOut(relicId, addressHash)`);
     - a security notice that can be switched off fails exactly when someone else holds the session;
     - it only fires when the address gains a sign-in credential.
   - **Failure:** logged with a hash of the address and `sanitizeMailError`. It never changes the response and never undoes the write.
   - **Remedy:** the email says what to check and says plainly that Relic can't remove a passkey. Rejected: pointing readers at `/abuse`, which is for relics, needs a relic id, and gives the operator no removal tool.
6. **Viewer.** Both surfaces get a `link-*` state family. A required shell callback sends the link and returns the shell's own non-confirming copy, so that copy stays defined in one place and the 202 non-oracle wording (`comments.ts:575-583`) is kept.

### 9.4 Shared contracts (verbatim)

**Config** (`config.ts`):
- Interface field after `134`:
  ```ts
  /**
   * How long after a sign-in link starts a session that session may begin
   * adding the address's first passkey. A session a passkey started never may.
   * Whole minutes, because the disclosure states it in minutes, and at least
   * `passkeyOfferMarkerSeconds`, so no offer card is refused at mount.
   */
  readonly passkeyFreshLinkSeconds: number;
  ```
- Default after `200`: `passkeyFreshLinkSeconds: 900,`.
- Assertion after `266-271`:
  ```ts
  if (!Number.isInteger(config.passkeyFreshLinkSeconds) || config.passkeyFreshLinkSeconds % 60 !== 0 || config.passkeyFreshLinkSeconds < config.passkeyOfferMarkerSeconds) {
    throw new Error('passkeyFreshLinkSeconds must be a whole number of minutes, at least passkeyOfferMarkerSeconds');
  }
  ```

**Problems** (`problems.ts`): add these in the union (`75`), in `STATUS` (`119`) and in `TITLE` (`167`):
```ts
| 'passkey_fresh_link_required'
passkey_fresh_link_required: 401,
passkey_fresh_link_required: 'Adding a first passkey needs a fresh sign-in link',
```

**Store** (`store.ts:316-328`):
- `SessionRow` gains:
  ```ts
  /** What started the session. Absent on rows from before passkey sign-in, all of which a link started. */
  readonly via?: 'link' | 'passkey';
  ```
- The doc comment becomes "A verified email session, minted by following a magic link or by a passkey sign-in."
- No change to the Memory store or the GCS store.

**Server** (`app.ts`):
- `mintReaderSession(email: string, now: number, via: 'link' | 'passkey')` writes `via`.
  - Callers: `3181` passes `'link'` and `4638` passes `'passkey'`.
  - Give it its own one-line doc comment, and move the comment at `3141-3148` onto `authCallback` (`3172`).
- The predicate, beside it:
  ```ts
  function mayAddFirstPasskey(session: SessionRow, now: number): boolean {
    return (session.via ?? 'link') === 'link' && now - session.createdAt <= config.passkeyFreshLinkSeconds * 1000;
  }
  ```
  The boundary is inclusive.
- The check, at `4089` (first line inside the branch):
  ```ts
  if (!mayAddFirstPasskey(session, now)) return refuse('passkey_fresh_link_required');
  ```
- The notice helper:
  ```ts
  async function sendPasskeyNotice(address: string, now: number, added: { readonly first: boolean; readonly passkeys: number }): Promise<void> {
    if (mailer === undefined || typeof mailer.sendMail !== 'function') return;
    try { await mailer.sendMail(address, passkeyAddedMail({ address, at: now, ...added })); }
    catch (error) { console.error(`relic: passkey notice failed for recipient ${await sha256Hex(normalizeEmail(address))}: ${sanitizeMailError(error, address)}`); }
  }
  ```
- Calls:
  - `await sendPasskeyNotice(session.email, now, { first: true, passkeys: 1 })` after `4290`.
  - `await sendPasskeyNotice(session.email, now, { first: false, passkeys: updated.credentials.length })` after `4339`.
- Import `passkeyAddedMail` at `48-55`.

**Mail** (`mail.ts`, after `changeNoticeMail`):
- `export function passkeyAddedMail(p: { readonly address: string; readonly at: number; readonly first: boolean; readonly passkeys: number }): OutboundMail`.
- The time is formatted from UTC getters only, no locale: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${hh}:${mm} UTC`, with `MONTHS` running `Jan` to `Dec`.
- `headers` is `undefined`. The HTML wraps each paragraph in `<p>` and runs `escapeHtml` over the whole paragraph. The text joins paragraphs with blank lines.
- Subject: `A passkey was added for your address on Relic`
- Text when `first: true`:
  ```
  A passkey was added for {address} on {when}.

  It signs in to Relic as this address without a link, and it confirms decisions. This address has 1 passkey.

  If you added it, you can ignore this message.

  If you did not, whoever added it can read this mailbox, or used a browser that had just signed in with a link sent here. Relic has no way to remove a passkey.
  ```
- Text when `first: false`:
  ```
  A passkey was added for {address} on {when}.

  It signs in to Relic as this address without a link, and it confirms decisions. A passkey this address already had confirmed it. This address has {n} passkeys.

  If you added it, you can ignore this message.

  If you did not, whoever added it could use a passkey this address already had. Relic has no way to remove a passkey.
  ```
  Use the singular "passkey" when n is 1.

**Viewer types and copy:** `passkey-common.ts`, imported only by the lazy chunks. `main.ts` may import the type and nothing else.
```ts
export const COPY_LINK_REQUIRED_LEAD = 'A first passkey can only be added right after you sign in with a link.';
export const COPY_LINK_FINE = 'This stops anyone holding an older sign-in from adding a passkey as you.';
export const COPY_LINK_SEND = 'Send me a new link';
export const COPY_LINK_FAILED = 'Relic could not send a link just now. Try again later.';
/** The shell's answer after emailing a new link on a surface's behalf. Resolves, never rejects. */
export type LinkRequestOutcome =
  | { readonly kind: 'sent'; readonly message: string; readonly warning?: string }
  | { readonly kind: 'failed' };
```

- Offer body in `link-required`:
  - with an address: `` `${COPY_LINK_REQUIRED_LEAD} Send a new one to ${email}, open it, then add your passkey.` ``
  - without one: `` `${COPY_LINK_REQUIRED_LEAD} Send yourself a new one, open it, then add your passkey.` ``
- Decision copy: `` export const DECISION_LINK_REQUIRED = `${COPY_LINK_REQUIRED_LEAD} Send a new one, open it, then choose again. Nothing was recorded.`; `` placed beside `DECISION_TOFU` (`decision-panel.ts:54-56`).
- The `sent` message is the shell's existing sentence:
  - relic page: "If {address} can receive mail, a link is on its way. Following it verifies the address and brings you back here." (`main.ts:3331-3335`)
  - dashboard: "…brings you back to this dashboard." (`main.ts:9411-9414`)
- `warning` is `KEY_AT_RISK_NOTE` (`comments.ts:552-555`) when `!keySurvivesNavigation(...)`.

**Viewer DOM: offer card.**
- Children become `title, body, p.compose-warning[data-passkey-offer-warning][hidden], fine, [data-passkey-offer-create], button.action.primary[data-passkey-offer-link][type=button][hidden], [data-passkey-offer-dismiss]`. This replaces the line at `passkey-sign-in.ts:711`.
- The `data-state` values below are set on both the card and the host:

| `data-state` | body | fine | warning | create | link | dismiss |
|---|---|---|---|---|---|---|
| `link-required` | the link-required body | `COPY_LINK_FINE` | hidden | hidden | shown, enabled | "Not now" (stores `dismissed`) |
| `link-sending` | unchanged | unchanged | hidden | hidden | shown, disabled | "Not now" |
| `link-sent` | `outcome.message` | hidden | `outcome.warning` or hidden | hidden | hidden | "Close" (removes the card, stores nothing) |
| `link-failed` | `COPY_LINK_FAILED` | `COPY_LINK_FINE` | hidden | hidden | shown, enabled | "Not now" |

**Viewer DOM: decision panel.** The section is `section.decision-passkey[data-passkey-link][data-state="required|sending|sent|failed"]`. It contains, in order:
1. `h3` "Set up a passkey to decide".
2. `identity('For ')`.
3. For required and sending: `p.compose-warning` `DECISION_LINK_REQUIRED`. For failed: `COPY_LINK_FAILED`.
4. `button.action.primary[data-passkey-link-send][type=button]` with `COPY_LINK_SEND` (no key glyph), disabled while sending.
5. `p.decision-fine` with `COPY_LINK_FINE`.
6. The `Not now` button.

In `sent` the section shows `p.decision-note` with `outcome.message`, then `p.compose-warning` with `outcome.warning` if there is one, then `Not now`.

**Mount contracts.**
- `PasskeyOfferMount` gains `readonly requestLink: () => Promise<LinkRequestOutcome>;`. It is required.
- `DecisionPanelOptions` (`decision-panel.ts:89-109`) gains `readonly requestLink: (email: string) => Promise<LinkRequestOutcome>;`. It is required.

**Disclosure.** This paragraph replaces `service.md:409` and `app.ts:5667`. In `app.ts`, "15" is rendered as `${config.passkeyFreshLinkSeconds / 60}`. The two must be byte-identical under `DEFAULT_CONFIG`.

> **Passkeys.** A passkey is registered to a reader's verified address. It confirms decisions, and it can sign that reader in instead of a link. The service keeps one record per address, filed under a hash of the address: the address itself, the random user handle its passkeys carry, and for each passkey its public key, credential id, signature counter, and when it was created and last used. A second entry, filed under a hash of the user handle, points to that record, so a passkey can sign you in without your typing the address. The first passkey registered for an address is trusted on first use, and only a session that a sign-in link started in the previous 15 minutes can begin adding it; adding another requires confirming with an existing one. Whenever a passkey is added, the service emails that address to say so, with the time and how many passkeys the address has. That email has no stop link, because it is about the address rather than a relic. Signing in with a passkey sends no email, updates that passkey's counter and last-used time, and starts the same session a link does, except that the session records a passkey started it. If you type your address to use a passkey, the service answers the same way whether or not that address has one. The service never receives a private key.

**Sentinels** (new lines only; no existing sentinel changes):
- `PASSKEY_STEP_4B_NOTICE_OK to=<addr>`
- `PASSKEY_STEP_8_FRESH_LINK_OK refused=passkey_fresh_link_required orphans=0 recovered=created notice=1`, or `PASSKEY_STEP_8_FRESH_LINK_SKIPPED live`
- `DECISION_FRESH_LINK_OK state=required orphans=0 link_sent=1`, or `DECISION_FRESH_LINK_SKIPPED live`
- `PROBE_AWAIT_PASSKEY_NOTICE email=<addr>`

### 9.5 Docs (verbatim where text must match)

**`service.md:37`.** The passkey enrollment clause becomes: "the passkey enrollment endpoints' `401 sign_in_required`, `401 passkey_fresh_link_required`, and `403 passkey_verification_failed` (1.15)". The rest of the line is unchanged.

**`service.md` §1.15.** Insert a table row after `271`:

`| Adding a first passkey from a session that a sign-in link did not start within `passkeyFreshLinkSeconds` (default 900) | `401` | `passkey_fresh_link_required` |`

Add a paragraph after `282`:

> **`401 passkey_fresh_link_required`.** Only `POST /api/auth/passkeys/options` returns it, and only for an address with no passkey, after the session, rate-limit and body checks and before any challenge is written. The session must have been started by following a sign-in link no more than `passkeyFreshLinkSeconds` ago. A session a passkey started never qualifies, and a session row without `via` predates passkey sign-in and counts as a link. The body has no extension and is the same for an old link session and a passkey session. An address with a passkey gets `mode: "assert"` whatever the session's age, so the refusal tells a session holder nothing about their own address that `mode` did not.

**`service.md:520`** is replaced with:

> - If no credential: if no passkey exists, the session must have been started by a sign-in link within `passkeyFreshLinkSeconds` (default 900), or the answer is `401 passkey_fresh_link_required` and no challenge is written; otherwise returns `{ mode: "create", public_key: CreationOptions }` with challenge purpose `'register'`. If passkeys exist, returns `{ mode: "assert", public_key: RequestOptions }` with challenge purpose `'enroll'`, whatever the session's age. Freshness is checked when the `'register'` challenge is issued, not when it is consumed, so a ceremony that starts inside the window can finish within the challenge's 300 seconds.

**`service.md` route 5.** Insert before `529`:

> - After either write, emails the session's address a passkey-added notice with no stop link. A mail failure is logged and changes nothing: the passkey stays stored and the response is still `201`.

**`service.md:458`.** Insert before "A spent or missing token…":

> The session row records `via: 'link'` and its `createdAt`, which is what lets it begin adding the address's first passkey for the next 15 minutes (1.15).

**`service.md:460`.** Append:

> Its session row records `via: 'passkey'`, so it can never add an address's first passkey (1.15).

**`service.md:402`.** Change "Every email carries" to "Every notification email carries". This matches the wording at `:470`.

**`frame.md:143`.** Replace "first use is trusted, and adding further passkeys requires confirming with an existing one." with:

> first use is trusted only from a session that a sign-in link started minutes earlier, adding further passkeys requires confirming with an existing one, and the address is emailed whenever a passkey is added.

**`viewer.md:548`.** Append:

> If `POST /api/auth/passkeys/options` answers `401 passkey_fresh_link_required`, the step becomes `section.decision-passkey[data-passkey-link][data-state="required"]`: it keeps the session, says a first passkey can only be added right after signing in with a link, and its `[data-passkey-link-send]` button asks the shell to email a new link to the session's address (`data-state` `sending`, then `sent` or `failed`).

**`viewer.md` §6.9 refusals.** Add after `559`:

> - `401 passkey_fresh_link_required`: Shows the new-link step (`[data-passkey-link]`) and keeps the session. Nothing was recorded.

**`viewer.md:578`.** Append:

> If the options call answers `401 passkey_fresh_link_required`, the card moves to `data-state="link-required"` instead of closing: it hides `[data-passkey-offer-create]` and shows `[data-passkey-offer-link]` ("Send me a new link"), which asks the shell to email a new link to the same address (`link-sending`, then `link-sent` or `link-failed`). A `401` with any other code still closes the card.

**`decisions.md`.** Append after `940`:

```markdown
## 2026-10-25: A first passkey needs a fresh link, and every added passkey is announced

Authorised by Jason Waldrip on 2026-10-25: email the address whenever a passkey is added, and refuse a first passkey unless a sign-in link started the session within a short window.

**The problem.** Passkey sign-in made a first passkey into lasting access. Anyone holding a `relic_session` cookie, which lives 30 days, could register the first passkey for an address that had none, from a shared machine or with a stolen cookie, and sign in as that address from then on. Nothing told the mailbox owner. The security review recorded this as L5.

**Sessions record what started them.** `SessionRow` gains `via: 'link' | 'passkey'`, and every mint writes it. Rows without it predate passkey sign-in, so a link started every one of them, and they count as links. `createdAt` is the mint time the window measures from.

**The window is 15 minutes (`passkeyFreshLinkSeconds`, 900).** It matches the life of the link itself (`authLinkTtlSeconds`), and it equals the offer marker's 600 seconds plus one 300-second challenge, so an offer card shown from a live marker can always finish the ceremony its first challenge starts. A reader who signs in to decide and takes longer is asked for a new link once, for the address's first passkey only. An hour or a day would remove that one-time cost by widening what a stolen cookie can do, and was rejected. `assertConfig` requires whole minutes, because the disclosure states the window in minutes, and at least the marker's life, so no card is offered that the service would refuse at once.

**The check sits where the challenge is issued.** `POST /api/auth/passkeys/options` answers `401 passkey_fresh_link_required` instead of issuing a first-passkey challenge. `POST /api/auth/passkeys` does not check again: that branch is the only source of a first-passkey challenge, which is single use, bound to the address, and lasts 300 seconds, and checking again would refuse a reader whose window closed mid-ceremony after their device had already stored a credential the service would never keep. The status is 401 because the remedy is signing in again; a 409 like `passkey_assertion_required` was rejected because nothing about the address is in conflict. The refusal has no extension, reads the same for an old link session and a passkey session, and comes only after the record lookup that already decides `mode`.

**Adding a passkey to an address that has one needs no fresh link.** The assertion from an existing passkey happens inside the same ceremony and proves more than a link can.

**Every added passkey is announced.** After a first passkey is created or another is added, the service emails the session's address with the time, how many passkeys the address now has, and how the passkey was allowed. It has no stop link: it concerns the address rather than a relic, stop records are kept per relic, and a notice someone could switch off would fail exactly when it matters. A failed send is logged with a hash of the address; the passkey stays stored and the response is still `201`. The email tells a reader who did not add it what to check and says plainly that Relic cannot remove a passkey. Pointing it at `/abuse` was rejected: that form reports relics, asks for a relic id, and its operator has no tool to remove a passkey.

**Residuals:**
- Nothing removes a passkey or ends another browser's session. A reader who learns of a passkey they did not add can do nothing about it in Relic.
- A session a link started can still add the first passkey inside the window, on a shared machine left signed in or with a cookie stolen and used within minutes. The email is what catches that.
- The window is checked when the challenge is issued, so a first passkey can be stored up to 300 seconds after the window closes.
- The email depends on delivery. A refused send, or one Resend accepts and pauses at a spent quota (`quotaWarning`), leaves only a log line.
- A login CSRF lands inside the window by construction. The offer naming the address (L6) stays the control, and in that case the email goes to the attacker's own mailbox.
```

**No change needed** to `README.md:174`, the relic-mcp README, SKILL or INSTRUCTIONS (each checked: none makes a claim that becomes false), or the policy comments paragraph at `app.ts:5627-5630`.

### 9.6 Tests and proofs

**Server: `relic-server/test/passkey-sign-in.test.ts`.**

First, change `signInViaLink` to use `sentMails.findLast` (`:136`), so that a second link to the same address resolves to the new one.

Extend test 2:
- the passkey session row has `via` equal to `'passkey'`;
- the callback row has `via` equal to `'link'`.

New tests use `build({ mailer: { send…, sendMail(email, mail) { notices.push({ email, mail }) } } })`:

18. **Window boundary.** The window covers the full 900 s exactly.
    - At `mint + 900_000`, options returns 200 with create mode.
    - At `+900_001`, the response is exactly `401` with `code` `passkey_fresh_link_required` and that title.
    - The body keys are exactly `type`, `title`, `status`, `detail`, `instance` and `code`.
    - A spy on `store.putWebauthnChallenge` records no call.
    - `notices` is empty.
19. **Passkey session refused.** A seeded row with `via: 'passkey'`, `createdAt: now`, for an address with no record, gets a body that equals the stale-link body apart from `instance`.
20. **Legacy rows count as links.** A seeded row without `via` and with `createdAt: now` gets create mode. The same row at `now - 900_001` gets 401.
21. **Challenge honoured after the window.** Options at `mint + 899_000`, then `now += 60_000`, then register gives `201`, plus one notice.
22. **Enroll is exempt.**
    - TOFU at `mint` gives one notice with the first-passkey text, exact to the byte.
    - Then `now += 7_200_000`: options returns assert, the assertion gives create, and register gives `201`.
    - The second notice matches the add text with "This address has 2 passkeys." exactly.
23. **Failed notice.** When `sendMail` throws an `Error` whose message contains the address:
    - the response is still `201`;
    - `getPasskeys` holds the credential;
    - a `console.error` spy gets exactly one line matching `/^relic: passkey notice failed for recipient [0-9a-f]{64}: /`, with no address in it.
24. **`send` never carries the notice.** With the default `send`-only mailer, `sentMails` has length 1 after registration (the link only).
25. **No notice on refusals.** Covers the stale-session refusal and the race that answers `409 passkey_assertion_required`.
26. **`assertConfig`.** It throws for 599, 930 and 1.5, and accepts 900.
27. **`/policy`.** It contains:
    - "only a session that a sign-in link started in the previous 15 minutes can begin adding it"
    - "That email has no stop link, because it is about the address rather than a relic."

**Server: `mail.test.ts`.** New `describe('the passkey-added mail')`:
- exact subject, text and HTML for both variants, at `Date.parse('2026-10-25T14:03:07Z')`;
- singular and plural;
- an address containing `<` is escaped;
- `headers` is `undefined`;
- no U+2014 or U+2013 (copy the pattern at `:447`).

**Server: `gcsstore.test.ts`.** Next to `:618-630`: `via` survives a round trip, and a legacy row reads back with `via` undefined.

**Viewer: `passkey-sign-in.test.ts`.** Add `requestLink: async () => ({ kind: 'failed' })` to the seven existing mounts (`:887`, `944`, `1025`, `1098`, `1139`, `1158`, `1177`). Then:

16. A prefetch refusal (`401` with the new code) leads to `link-required`, and `onDone` is not called. The create button is hidden, the link button is visible, and the body names the address.
17. Pressing the link button calls `requestLink` once. The card goes `link-sending`, then `link-sent` with the message. The warning shows when it is provided. "Close" removes the card and stores nothing.
18. A `failed` result leads to `link-failed`, and the button can be pressed again.
19. "Not now" in `link-required` stores `dismissed`.
20. A refresh timer that meets the refusal moves the card from `ready` to `link-required`.
21. A `401` with code `sign_in_required` still calls `onDone`. This guards `:743-746`.

**Viewer: `decisions.test.ts`.** The opener at `:507` gains a recording `requestLink`. Then:
- A refusal at `auth/passkeys/options` leads to `[data-passkey-link][data-state="required"]`. The copy is right, focus lands on `[data-passkey-link-send]`, and `signIn` is not called (no lapse).
- A press leads to `sent`, showing the message and the warning.
- A failure leads to `failed`, with the button enabled again.

**Proofs (relic-mcp).**

New step options, in both step modules:
- `awaitPasskeyNotice: (email) => Promise<string>`. It returns the first line of the notice.
  - Loopback: poll `mails` for that address with text starting `A passkey was added for `.
  - Live: print `PROBE_AWAIT_PASSKEY_NOTICE email=<addr>`, then read one line from stdin.
- `seedStaleSession?: (email) => Promise<string>`. Loopback only. It calls `store.putSession({ tokenHash, email, createdAt: Date.now() - (DEFAULT_CONFIG.passkeyFreshLinkSeconds + 60) * 1000, expiresAt: Date.now() + 3_600_000, via: 'link' })` and returns the token.

`passkey-sign-in-steps.ts`:
- **Step 4B**, after `:352`. Assert that the line starts with `a passkey was added for <addr> on ` (case-insensitive) and ends with ` UTC.`.
- **Step 8**, after `PASSKEY_NEG_OK`, using a fresh address B:
  1. Seed a stale session for B.
  2. `Network.setCookie` for `relic_session` and for `relic_passkey_offer=1`.
  3. Run `localStorage.removeItem('relic:passkey-offer')`, because step 4 left `created` there.
  4. Reopen the relic.
  5. Wait for `[data-passkey-offer][data-state="link-required"]`.
  6. Check that `WebAuthn.getCredentials` shows no new credential (`orphans=0`).
  7. Click `[data-passkey-offer-link]`.
  8. Follow `resolveMagicLink(B)` the way step 3 follows a link.
  9. Wait for `ready`, then create, then `created`.
  10. Call `awaitPasskeyNotice(B)`.
- If `seedStaleSession` is absent, print the SKIPPED line instead of running step 8.

`decision-proof-steps.ts`, after `DECISION_NEG_OK`, using a fresh address C:
1. Seed a stale session for C and set the cookie.
2. Reopen the relic and open the panel.
3. Choose approve.
4. Wait for `[data-passkey-link][data-state="required"]`.
5. Check that the authenticator count is unchanged.
6. Click `[data-passkey-link-send]`, then wait for `[data-state="sent"]`.
7. Check that `resolveMagicLink(C)` returns a callback URL.

The `...-path.ts` files supply the options. The live probe supplies only `awaitPasskeyNotice`.

**Docs for the proofs.**
- `relic-mcp/PATH.md`:
  - `:524-533`: add 4B and step 8.
  - `:452-460` and `:485-494`: add `DECISION_FRESH_LINK_*`.
  - `:554` and `:560+`: add the second paste.
- Root `PATH.md`:
  - `:15`: add the notice and the fresh-link negative to the success criteria.
  - `:23`: add the notice paste.

### 9.7 Slices

All slices branch from the commit that adds §9, in isolated worktrees. Nobody builds or tests mid-flight; F3 may look at its own mock. F1 to F5 run in parallel; none depends on another while being written.

| Slice | Agent | Owns | Change | Non-goals | Acceptance (checked at integration) |
|---|---|---|---|---|---|
| F0 | main agent, inline | `docs/plans/passkey-sign-in/README.md` | Append §9 | – | Every worker's context carries §9.4 verbatim |
| F1 server | task, hi | `relic-server/src/{config,problems,store,app,mail}.ts`; `relic-server/test/{passkey-sign-in,mail,gcsstore}.test.ts` | §9.4 server, mail and disclosure; §9.6 server tests | Sign-in routes, `/api/auth/request` and `/session` untouched; no re-check at POST; no extension; no stop link; `fanOut` untouched | A stale or passkey session gets the exact 401 and no challenge is written; each stored passkey produces exactly one `sendMail` with the §9.4 text; `/policy` contains the paragraph |
| F2 viewer | task, hi | `relic-viewer/src/{passkey-common,passkey-sign-in,decision-panel,main}.ts`; `relic-viewer/test/{passkey-sign-in,decisions}.test.ts` | See the F2 notes below | No `styles.css`; no handling of the new code at `POST /api/auth/passkeys` (the server never sends it there); no runtime import of `passkey-common.ts` in `main.ts` | Both surfaces reach every `link-*` state from a stubbed 401, and a plain 401 still closes the card |
| F3 mock | designer | `docs/plans/passkey-sign-in/mockup.html`; `relic-viewer/src/styles.css` (one new block, only if needed) | See the F3 notes below | Copy and DOM exactly as in §9.4 | Opens offline; every new state is reachable by clicking; isolated headless screenshots at 1440x900 and 390x844, light and dark, show no overflow |
| F4 docs | task, med | `docs/spec/service.md`, `docs/spec/viewer.md`, `docs/frame.md`, `docs/decisions.md` | §9.5 verbatim | README and relic-mcp docs | Disclosure byte-identical to the `app.ts` text rendered with defaults; no em-dashes |
| F5 proofs | task, hi | `relic-mcp/test/{passkey-sign-in-steps,passkey-sign-in-path,passkey-sign-in-live-probe,decision-proof-steps,decision-path}.ts`, `relic-mcp/PATH.md`, `PATH.md` | §9.6 proofs | Existing sentinel strings stay; no CI steps; live probes never seed | When the integration owner runs the paths, they print the new sentinels |

**F2 notes.**
- `main.ts` gains:
  - `linkSentCopy(address, relicId, fragment, deps)`, extracted from `3327-3341` and used by `signInForm`;
  - `requestFreshLink(relicId, fragment, deps)`, a closure over `requestMagicLink`;
  - `dashboardLinkSent(address)`, used by the dashboard form at `9411-9414` and by the dashboard offer.
- Wiring:
  - `7213` passes `requestLink: () => requestFreshLink(relicId, fragment, deps)(discovered.email)`.
  - `8184` passes `requestLink: requestFreshLink(relicId, fragment, deps)`.
  - `9260` posts `{email, return_to:'/dashboard'}` and maps 202 to `sent`.
- Offer card (`passkey-sign-in.ts`):
  - Read the problem `code` before the 401 test at `743`.
  - Add `link-sent` to the terminal states at `1062-1078`.
- Decision panel:
  - Add phase `'link'` to `PasskeyStep` (`128-134`).
  - Render it in `passkeySection` (`584-695`).
  - Branch in `enterPasskey` at `1213-1216`.
  - Add `[data-passkey-link-send]:not([disabled])` to the focus selector at `1080`.

**F3 notes.**
- Offer rail gets: `offer-link-required`, `offer-link-sending`, `offer-link-sent`, `offer-link-sent-key`, `offer-link-failed`.
- A new "Decision" group gets `decision-create`, `decision-link-required`, `decision-link-sending`, `decision-link-sent`, `decision-link-failed`. Build the sheet from `decision-panel.ts:584-695` and `styles.css:5636-5685`.
- An "Email" group renders both notice variants at "25 Oct 2026 at 14:03 UTC".
- Clicking through goes required, then sending, then sent with the follow-link aside, then ready or create.
- Copy comes from §9.4, plus `KEY_AT_RISK_NOTE`.

### 9.8 Integration check (main agent)

1. Merge F1 to F5, then run `bun install --frozen-lockfile`.
2. Run `mise exec node@18.20.8 -- mise run verify` and `mise exec node@24.15.0 -- mise run verify`.
3. Run `bun run --cwd packages/relic-mcp build`. Then run `RELIC_CHROME_PATH="$(command -v google-chrome)" bun packages/relic-mcp/test/passkey-sign-in-path.ts`, expecting 4B and step 8 before `PASSKEY_SIGN_IN_PATH_OK`. Then run `decision-path.ts`, expecting `DECISION_FRESH_LINK_OK` before `DECISION_PATH_OK`. Then run the remaining CI paths from `verify.yml:92-168`.
4. Take isolated headless screenshots of the real `link-*` states and compare them with the mock.
5. Get a security review of the diff.
6. Push to PR #130, wait for green, then `gh pr merge --merge`.
7. Watch `deploy`. Then:
   - grep the deployed chunk for "Send me a new link";
   - run `passkey-sign-in-live-probe.ts`, pasting the link and then the notice's first line, until it prints both `PASSKEY_STEP_4B_NOTICE_OK` and `PASSKEY_SIGN_IN_LIVE_OK`.

### 9.9 What would prove this spec wrong

- Passkey sessions without `via` reach production because sign-in shipped without this change. They would be read as links.
- An offer card shown straight after a link gets the refusal at mount. That points to the marker outliving the window, or to clock skew.
- Step 8 or the decision negative reports `orphans>0`, or times out waiting for `link-required`. Either means the check is not at options.
- The live notice line doesn't match the copy in §9.4 because `mail.ts` has drifted from it.
- `shell-budget` fails because `main.ts` imported `passkey-common.ts` at runtime.